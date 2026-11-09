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
//!
//! Quand l'isolation par conteneurs est active, les portes tournent dans un
//! conteneur, comme l'exécutant dont elles jugent le travail : ce qu'elles
//! exécutent, c'est ce qu'il a pu écrire.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// La génération en cours des portes de chaque tâche, dans ce processus.
///
/// Une génération par lancement : une correction renvoyée pendant qu'une porte
/// tourne relance une porte neuve, et le verdict de l'ancienne — qui jugeait un
/// code qui n'est plus celui-là, sur un worktree qui changeait sous elle — est
/// écarté au lieu d'être pris pour celui du nouveau rendu.
fn running() -> &'static Mutex<HashMap<String, u64>> {
	static RUNNING: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
	RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_generation() -> u64 {
	static NEXT: AtomicU64 = AtomicU64::new(1);
	NEXT.fetch_add(1, Ordering::SeqCst)
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

/// Où une porte joue ses commandes.
///
/// Les portes exécutent ce que l'exécutant a pu écrire — un script de
/// `package.json`, un test. Quand l'isolation est active, il a travaillé dans
/// un conteneur : jouer ses scripts sur l'hôte rendrait au code livré les
/// droits qu'on lui avait retirés. La porte tourne donc là où il a tourné, avec
/// la même image et le même plafond de mémoire (`sandbox::build`).
#[derive(Debug, Clone)]
pub enum Runner {
	Host,
	Container {
		sandbox: crate::config::SandboxConfig,
		runtime: String,
		seed: String,
	},
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

/// Joue les commandes sur l'hôte. Voir [`run_with`].
pub async fn run(cwd: &str, commands: &[String], timeout: Duration) -> Outcome {
	run_with(&Runner::Host, cwd, commands, timeout).await
}

/// Joue les commandes dans l'ordre, dans `cwd`, et s'arrête à la première qui
/// échoue : la suivante jugerait un code dont on sait déjà qu'il ne va pas.
pub async fn run_with(runner: &Runner, cwd: &str, commands: &[String], timeout: Duration) -> Outcome {
	for (index, command) in commands.iter().enumerate() {
		let mut builder = match runner {
			Runner::Host => {
				let mut builder = crate::platform::shell_async(command);
				// Son propre groupe : `pnpm test` essaime des enfants, et ce qu'ils
				// laissent derrière eux doit partir avec la commande.
				crate::platform::detach_async(&mut builder);
				builder.current_dir(cwd).env("CI", "1");
				builder
			}
			Runner::Container { sandbox, runtime, seed } => crate::sandbox::build(
				sandbox,
				runtime,
				&format!("gate-{seed}-{index}"),
				cwd,
				&[("CI".to_string(), "1".to_string())],
				command,
				"",
			),
		};
		builder
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
		let waited = wait(child, timeout).await;
		// Ce que la commande a laissé derrière elle — un serveur lancé par un
		// test, un watcher — ne lui survit pas, qu'elle ait passé ou non.
		match runner {
			Runner::Host => crate::platform::kill_group(leader),
			Runner::Container { runtime, seed, .. } => crate::sandbox::kill(runtime, &format!("gate-{seed}-{index}")),
		}
		let waited = match waited {
			Some(result) => Some(result.await),
			None => None,
		};
		match waited {
			Some(Ok(output)) if output.status.success() => continue,
			Some(Ok(output)) => {
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
			Some(Err(error)) => {
				return Outcome {
					passed: false,
					failed: command.clone(),
					output: error.to_string(),
				};
			}
			None => {
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
	Outcome {
		passed: true,
		failed: String::new(),
		output: String::new(),
	}
}

/// Attend la fin de la commande, pas celle de sa sortie.
///
/// `wait_with_output` attendait que les tuyaux se ferment : un processus lancé
/// en arrière-plan par la commande et qui garde sa sortie ouverte faisait
/// attendre une porte réussie jusqu'au plafond, puis la notait en échec. On lit
/// donc la sortie à côté, on attend le code de sortie, et l'on ne récupère ce
/// qui a été lu qu'une fois la descendance arrêtée (voir l'appelant).
///
/// `None` : le plafond est passé avant la fin.
async fn wait(
	mut child: tokio::process::Child,
	timeout: Duration,
) -> Option<impl std::future::Future<Output = std::io::Result<std::process::Output>>> {
	use tokio::io::AsyncReadExt;
	let lire = |pipe: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
		tokio::spawn(async move {
			let mut buffer = Vec::new();
			if let Some(mut pipe) = pipe {
				// Au-delà, on jette le début : seule la fin sert (`OUTPUT_TAIL`).
				let mut chunk = [0u8; 8192];
				while let Ok(read) = pipe.read(&mut chunk).await {
					if read == 0 {
						break;
					}
					buffer.extend_from_slice(&chunk[..read]);
					if buffer.len() > 4 * OUTPUT_TAIL {
						buffer.drain(..buffer.len() - 2 * OUTPUT_TAIL);
					}
				}
			}
			buffer
		})
	};
	let stdout = lire(
		child
			.stdout
			.take()
			.map(|pipe| Box::new(pipe) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
	);
	let stderr = lire(
		child
			.stderr
			.take()
			.map(|pipe| Box::new(pipe) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
	);
	let status = match tokio::time::timeout(timeout, child.wait()).await {
		Ok(status) => status,
		Err(_) => {
			stdout.abort();
			stderr.abort();
			return None;
		}
	};
	Some(async move {
		let status = status?;
		// La descendance vient d'être arrêtée : les tuyaux se ferment. Le délai
		// borne le cas d'un processus qui aurait échappé au groupe.
		let grace = Duration::from_secs(5);
		let stdout = tokio::time::timeout(grace, stdout)
			.await
			.ok()
			.and_then(Result::ok)
			.unwrap_or_default();
		let stderr = tokio::time::timeout(grace, stderr)
			.await
			.ok()
			.and_then(Result::ok)
			.unwrap_or_default();
		Ok(std::process::Output { status, stdout, stderr })
	})
}

/// Où jouer les portes, d'après le réglage que le lanceur d'agents lit
/// lui-même. `Err` : l'isolation est active mais aucun runtime n'est là — on
/// refuse plutôt que de retomber sur l'hôte sans le dire, comme le lanceur.
fn runner_for(generation: u64) -> Result<Runner, String> {
	let config = crate::config::Config::active();
	if !config.sandbox.enabled {
		return Ok(Runner::Host);
	}
	match crate::sandbox::resolve_runtime(&config.sandbox.runtime) {
		Some(runtime) => Ok(Runner::Container {
			sandbox: config.sandbox.clone(),
			runtime,
			seed: generation.to_string(),
		}),
		None => Err(crate::i18n::t("mission.gate.noRuntime")),
	}
}

/// Lance les portes d'une tâche rendue, en tâche de fond, et rend l'état où
/// elle se trouve après l'appel.
///
/// - `Running` : lancées. Une porte qui tournait déjà pour cette tâche est
///   remplacée : son verdict sera écarté, il jugeait un rendu précédent ;
/// - `Failed` : impossibles à jouer — le worktree n'existe plus, ou
///   l'isolation est active sans runtime. On ne fusionne pas un code qu'on n'a
///   pas pu vérifier ;
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
	let refuse = |reason: String| {
		let _ = mission::set_task_gate(mission_id, task_id, Gate::Failed, &reason);
		Gate::Failed
	};
	if !std::path::Path::new(task.worktree.trim()).is_dir() {
		return refuse(crate::i18n::tf("mission.gate.noWorktree", &[("path", &task.worktree)]));
	}
	let generation = next_generation();
	let runner = match runner_for(generation) {
		Ok(runner) => runner,
		Err(reason) => return refuse(reason),
	};
	let marker = key(mission_id, task_id);
	running()
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner())
		.insert(marker.clone(), generation);
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
		let outcome = run_with(&runner, &worktree, &commands, TIMEOUT).await;
		if !is_current(&marker, generation) {
			return;
		}
		// Une correction partie entre-temps a remis la porte à zéro : ce
		// verdict parle d'un code qui n'est plus celui-là.
		let still_running = mission::get(&mission_id)
			.ok()
			.and_then(|mission| mission.tasks.into_iter().find(|task| task.id == task_id))
			.map(|task| task.gate == Gate::Running)
			.unwrap_or(false);
		if !still_running {
			return;
		}
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
	});
	Gate::Running
}

/// Vrai quand `generation` est encore le dernier lancement de cette tâche ;
/// il cesse alors d'être en cours. Faux quand un lancement plus récent l'a
/// remplacé : son verdict doit être écarté.
fn is_current(marker: &str, generation: u64) -> bool {
	let mut table = running().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
	let current = table.get(marker) == Some(&generation);
	if current {
		table.remove(marker);
	}
	current
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
			.contains_key(&key(&mission.id, &task.id));
		if orphan && start(&mission.id, &task.id) == Gate::None {
			// Plus rien à jouer (les commandes ont été retirées des réglages) :
			// la porte ne retient plus.
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
			&[
				"echo avant".into(),
				"echo raté >&2; exit 3".into(),
				"echo jamais".into(),
			],
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

	#[tokio::test]
	async fn un_processus_laisse_en_fond_ne_retient_pas_la_porte() {
		// `sleep` garde la sortie ouverte : attendre sa fermeture faisait
		// attendre la porte jusqu'au plafond.
		let debut = std::time::Instant::now();
		let outcome = run(&dossier(), &["sleep 30 & echo ok".into()], Duration::from_secs(20)).await;
		assert!(outcome.passed, "{outcome:?}");
		assert!(debut.elapsed() < Duration::from_secs(15), "{:?}", debut.elapsed());
	}

	#[test]
	fn un_verdict_remplace_est_ecarte() {
		let marqueur = "mission-test/tache-generation";
		running().lock().unwrap().insert(marqueur.into(), 1);
		// Un nouveau rendu relance la porte avant que la première ait fini.
		running().lock().unwrap().insert(marqueur.into(), 2);
		assert!(!is_current(marqueur, 1), "l'ancien verdict doit être écarté");
		assert!(is_current(marqueur, 2));
		// Consommé : un second verdict de la même génération ne passe plus.
		assert!(!is_current(marqueur, 2));
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
