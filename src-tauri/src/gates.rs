//! Les portes de vérification : ce qui doit passer avant qu'une tâche soit
//! intégrée.
//!
//! Une mission avait deux juges, le maître qui relit et la recette qui rend un
//! verdict. Ce sont deux lectures, et une lecture se laisse convaincre : un
//! exécutant qui écrit « les tests passent » dans son rapport est cru tant que
//! personne ne les relance. Une porte est l'inverse d'un avis. Le dépôt déclare
//! ses commandes (`workflow.gate_commands` : `pnpm test`, `pnpm lint`…), le
//! cockpit les joue dans le worktree de la tâche dès qu'elle est rendue, et le
//! code de sortie tranche.
//!
//! Trois règles :
//!
//! - **Rien n'est deviné.** Sans commande déclarée, aucune porte : le
//!   comportement est celui d'avant, et une tâche s'intègre comme avant.
//! - **Une porte qui échoue retient, elle ne punit pas.** La tâche reste
//!   livrée, son travail reste là ; `integrate` la laisse de côté et rend la
//!   sortie au maître, qui la renvoie en correction. La correction efface la
//!   porte, qui se rejouera sur le nouveau rendu.
//! - **Une porte qui ne finit pas est une porte qui échoue.** Un test qui
//!   attend une base absente ou un serveur qui ne rend jamais la main ne doit
//!   pas immobiliser la mission : passé `TIMEOUT`, tout le groupe de processus
//!   est arrêté, et la porte est notée en échec, avec la raison.
//!
//! Les portes tournent en tâche de fond : une suite de tests prend des
//! minutes, et ni la boucle qui ramasse les tâches finies ni l'outil
//! `integrate` du maître ne doivent l'attendre. Une porte interrompue par un
//! redémarrage du cockpit reste notée « en cours » sur le disque ; `ensure` la
//! relance quand quelqu'un en a besoin.

use std::collections::HashSet;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::mission::{self, Gate};

/// Au-delà, une commande est arrêtée et la porte échoue.
///
/// Large exprès : une suite de tests d'un monorepo prend plusieurs minutes, et
/// une porte qui coupe un test lent pousserait à la vider. Ce plafond n'est là
/// que pour ce qui ne finira jamais.
const TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Ce qu'on garde de la sortie d'une porte qui échoue.
///
/// La fin, pas le début : un lanceur de tests imprime son résumé et ses
/// échecs en dernier. Assez pour que le maître sache quoi corriger, assez peu
/// pour ne pas noyer son contexte.
const OUTPUT_TAIL: usize = 4_000;

/// Les tâches dont les portes tournent dans ce processus.
fn running() -> &'static Mutex<HashSet<String>> {
	static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
	RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

fn key(mission_id: &str, task_id: &str) -> String {
	format!("{mission_id}/{task_id}")
}

/// Les commandes déclarées pour ce dépôt, lignes vides écartées.
pub fn commands_for(repo: &str) -> Vec<String> {
	crate::config::Config::for_repo(repo)
		.workflow
		.gate_commands
		.into_iter()
		.map(|command| command.trim().to_string())
		.filter(|command| !command.is_empty())
		.collect()
}

/// Ce qu'une suite de commandes a rendu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
	pub passed: bool,
	/// La commande qui a échoué, vide quand tout a passé.
	pub failed: String,
	/// Pourquoi, et la fin de sa sortie.
	pub output: String,
}

/// La fin d'un texte, coupée sur une frontière de caractère.
fn tail(text: &str, limit: usize) -> String {
	if text.len() <= limit {
		return text.to_string();
	}
	let mut start = text.len() - limit;
	while !text.is_char_boundary(start) {
		start += 1;
	}
	format!("…{}", &text[start..])
}

/// Joue les commandes dans l'ordre, dans `cwd`, et s'arrête à la première qui
/// échoue : la suivante jugerait un code dont on sait déjà qu'il ne va pas.
pub async fn run(cwd: &str, commands: &[String], timeout: Duration) -> Outcome {
	for command in commands {
		let mut builder = crate::platform::shell_async(command);
		// Son propre groupe : `pnpm test` essaime des enfants, et un
		// dépassement doit emporter toute la descendance.
		crate::platform::detach_async(&mut builder);
		builder
			.current_dir(cwd)
			.env("CI", "1")
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.kill_on_drop(true);
		let child = match builder.spawn() {
			Ok(child) => child,
			Err(error) => {
				return Outcome {
					passed: false,
					failed: command.clone(),
					output: crate::i18n::tf("mission.gate.launchFailed", &[("error", &error)]),
				};
			}
		};
		let leader = child.id().map(|pid| pid as i32).unwrap_or(0);
		match tokio::time::timeout(timeout, child.wait_with_output()).await {
			Ok(Ok(output)) if output.status.success() => continue,
			Ok(Ok(output)) => {
				let mut text = String::from_utf8_lossy(&output.stdout).to_string();
				let stderr = String::from_utf8_lossy(&output.stderr);
				if !stderr.trim().is_empty() {
					if !text.is_empty() && !text.ends_with('\n') {
						text.push('\n');
					}
					text.push_str(&stderr);
				}
				let code = output
					.status
					.code()
					.map(|code| code.to_string())
					.unwrap_or_else(|| "?".into());
				return Outcome {
					passed: false,
					failed: command.clone(),
					output: format!("exit {code}\n{}", tail(text.trim_end(), OUTPUT_TAIL)),
				};
			}
			Ok(Err(error)) => {
				return Outcome {
					passed: false,
					failed: command.clone(),
					output: error.to_string(),
				};
			}
			Err(_) => {
				// `kill_on_drop` n'atteint que le shell : ses enfants sont dans
				// le groupe, c'est lui qu'on arrête.
				crate::platform::kill_group(leader);
				return Outcome {
					passed: false,
					failed: command.clone(),
					output: crate::i18n::tf(
						"mission.gate.timedOut",
						&[("minutes", &(timeout.as_secs() / 60).max(1))],
					),
				};
			}
		}
	}
	Outcome { passed: true, failed: String::new(), output: String::new() }
}

/// Lance les portes d'une tâche rendue, en tâche de fond, et rend l'état où
/// elle se trouve après l'appel.
///
/// - `Running` : lancées, ou déjà en train de tourner ;
/// - `Failed` : impossibles à jouer, le worktree n'existe plus — on ne
///   fusionne pas un code qu'on n'a pas pu vérifier ;
/// - `None` : rien à jouer, le dépôt ne déclare aucune porte.
pub fn start(mission_id: &str, task_id: &str) -> Gate {
	let Ok(mission) = mission::get(mission_id) else {
		return Gate::None;
	};
	let Some(task) = mission.tasks.iter().find(|task| task.id == task_id) else {
		return Gate::None;
	};
	let commands = commands_for(&mission.cwd);
	if commands.is_empty() {
		return Gate::None;
	}
	if !std::path::Path::new(task.worktree.trim()).is_dir() {
		let _ = mission::set_task_gate(
			mission_id,
			task_id,
			Gate::Failed,
			&crate::i18n::tf("mission.gate.noWorktree", &[("path", &task.worktree)]),
		);
		return Gate::Failed;
	}
	let marker = key(mission_id, task_id);
	{
		let mut set = running().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		if !set.insert(marker.clone()) {
			return Gate::Running;
		}
	}
	let _ = mission::set_task_gate(
		mission_id,
		task_id,
		Gate::Running,
		&crate::i18n::tf("mission.gate.running", &[("commands", &commands.join(" · "))]),
	);

	let mission_id = mission_id.to_string();
	let task_id = task_id.to_string();
	let worktree = task.worktree.clone();
	let title = task.title.clone();
	tauri::async_runtime::spawn(async move {
		let outcome = run(&worktree, &commands, TIMEOUT).await;
		// Une correction partie pendant que la porte tournait a remis la tâche
		// en jeu : ce verdict parle d'un code qui n'est plus celui-là.
		let still_ours = mission::get(&mission_id)
			.ok()
			.and_then(|mission| mission.tasks.into_iter().find(|task| task.id == task_id))
			.map(|task| task.gate == Gate::Running)
			.unwrap_or(false);
		if still_ours {
			if outcome.passed {
				let _ = mission::set_task_gate(&mission_id, &task_id, Gate::Passed, "");
				crate::journal::record(
					"mission",
					&crate::i18n::t("mission.journal.gatePassed"),
					&title,
					true,
					&commands.join(" · "),
				);
			} else {
				let detail = format!("$ {}\n{}", outcome.failed, outcome.output);
				let _ = mission::set_task_gate(&mission_id, &task_id, Gate::Failed, &detail);
				crate::journal::record(
					"mission",
					&crate::i18n::t("mission.journal.gateFailed"),
					&title,
					false,
					&outcome.failed,
				);
			}
		}
		running()
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.remove(&key(&mission_id, &task_id));
	});
	Gate::Running
}

/// Relance les portes notées « en cours » qu'aucun processus ne joue plus.
///
/// C'est ce qui reste d'un cockpit fermé en pleine suite de tests : sans
/// relance, la tâche attendrait une porte que plus rien ne ferme.
pub fn ensure(mission: &mission::Mission) {
	for task in &mission.tasks {
		if task.gate != Gate::Running {
			continue;
		}
		let orphan = !running()
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.contains(&key(&mission.id, &task.id));
		if orphan && start(&mission.id, &task.id) == Gate::None {
			// Plus rien à jouer (les commandes ont été retirées des réglages,
			// le worktree a disparu) : la porte ne retient plus.
			let _ = mission::set_task_gate(&mission.id, &task.id, Gate::None, "");
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn dossier() -> String {
		std::env::temp_dir().to_string_lossy().to_string()
	}

	#[tokio::test]
	async fn tout_passe() {
		let outcome = run(&dossier(), &["true".into(), "exit 0".into()], TIMEOUT).await;
		assert!(outcome.passed, "{outcome:?}");
	}

	#[tokio::test]
	async fn la_premiere_qui_echoue_arrete_tout_et_dit_pourquoi() {
		let outcome = run(
			&dossier(),
			&["echo avant".into(), "echo raté >&2; exit 3".into(), "echo jamais".into()],
			TIMEOUT,
		)
		.await;
		assert!(!outcome.passed);
		assert_eq!(outcome.failed, "echo raté >&2; exit 3");
		assert!(outcome.output.starts_with("exit 3"), "{}", outcome.output);
		assert!(outcome.output.contains("raté"), "{}", outcome.output);
	}

	#[tokio::test]
	async fn ce_qui_ne_finit_pas_echoue() {
		let outcome = run(&dossier(), &["sleep 30".into()], Duration::from_millis(500)).await;
		assert!(!outcome.passed);
		assert_eq!(outcome.failed, "sleep 30");
	}

	#[tokio::test]
	async fn sans_commande_rien_ne_retient() {
		assert!(run(&dossier(), &[], TIMEOUT).await.passed);
	}

	#[test]
	fn la_sortie_garde_sa_fin() {
		let long = format!("{}FIN", "x".repeat(10_000));
		let coupe = tail(&long, 100);
		assert!(coupe.ends_with("FIN"));
		assert!(coupe.chars().count() <= 101);
		// Coupée au milieu d'un caractère, elle ne panique pas.
		assert!(tail("ééééé", 3).ends_with('é'));
	}

	#[test]
	fn seules_les_portes_ouvertes_ou_en_cours_retiennent() {
		assert!(Gate::Running.holds());
		assert!(Gate::Failed.holds());
		assert!(!Gate::Passed.holds());
		assert!(!Gate::None.holds());
	}
}
