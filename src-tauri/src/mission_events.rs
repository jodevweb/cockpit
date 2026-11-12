//! L'historique d'une mission, étape par étape.
//!
//! La fiche d'une mission dit où elle en est, pas comment elle y est arrivée.
//! Une porte qui échoue deux fois de suite n'y laisse que sa dernière sortie :
//! la correction efface la première, et personne ne peut plus dire, après
//! coup, que la boucle a tourné sur le typage puis sur le lint. Le journal du
//! cockpit (`journal.rs`) ne remplit pas ce rôle : il est commun à tout le
//! poste, tronqué à mille lignes, et ne garde que la première ligne d'un
//! détail.
//!
//! Ici, chaque écriture de la fiche laisse sa trace. Les événements ne sont pas
//! semés à la main dans le code qui fait avancer la mission : ils se déduisent
//! en comparant la fiche avant et après chaque mise à jour (`between`). Un
//! chemin ajouté demain qui change l'état d'une tâche apparaîtra donc dans
//! l'historique sans que personne ait à y penser — c'est l'oubli qu'on veut
//! rendre impossible.
//!
//! Un fichier JSONL par mission, en ajout seul, à côté de sa fiche. Il part
//! avec elle quand elle est supprimée.

use crate::mission::{Gate, Mission, MissionState, Step, TaskState};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Ce qu'on garde d'une note d'exécutant ou d'une sortie de porte.
///
/// La sortie d'une porte est déjà bornée à sa fin (`gates::OUTPUT_TAIL`) ; une
/// note de livraison, elle, peut faire des pages. L'historique sert à
/// comprendre ce qui s'est passé, pas à archiver les rapports, qui vivent
/// dans le registre des exécutions.
const TEXT_LIMIT: usize = 4_500;

/// Ce qui a changé dans une mission.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "MissionChange"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Change {
	/// La mission est ouverte.
	Opened { guided: bool },
	/// Elle passe d'un état à un autre. `note` porte la raison quand la fiche
	/// en donne une — un échec, un arrêt.
	State {
		from: MissionState,
		to: MissionState,
		#[serde(default)]
		note: String,
	},
	/// Le maître soumet une version d'une étape guidée.
	Draft { step: Step, version: u32, questions: u32 },
	/// Un humain tranche sur cette version.
	Review {
		step: Step,
		version: u32,
		approved: bool,
		#[serde(default)]
		feedback: String,
	},
	/// Un découpage est posé, pour une mission autonome. Une mission guidée le
	/// soumet comme une étape (`Draft` de `split`).
	Plan { tasks: u32 },
	/// Une tâche apparaît dans le plan.
	TaskAdded { task: String, title: String, role: String },
	/// Une tâche change d'état.
	Task {
		task: String,
		from: TaskState,
		to: TaskState,
		#[serde(default)]
		note: String,
	},
	/// Une tâche repart en correction, avec ce qu'on lui reproche.
	Rework { task: String, attempt: u32, reason: String },
	/// Les portes d'une tâche démarrent ou rendent leur verdict. `commit` est
	/// le code qu'elles ont jugé, quand il est connu.
	Gate {
		task: String,
		gate: Gate,
		#[serde(default)]
		output: String,
		#[serde(default)]
		commit: String,
	},
	/// L'automatisme est suspendu, ou relancé.
	Paused { paused: bool },
	/// La pull request d'intégration est ouverte.
	Pr { url: String },
}

/// Un changement, daté.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionEvent {
	pub at: String,
	pub change: Change,
}

/// La fin d'un texte trop long, coupée sur une frontière de caractère : le
/// début d'un rapport est sa partie la plus facile à retrouver ailleurs, sa
/// fin dit comment il conclut.
fn bounded(text: &str) -> String {
	let text = text.trim();
	if text.len() <= TEXT_LIMIT {
		return text.to_string();
	}
	let mut start = text.len() - TEXT_LIMIT;
	while !text.is_char_boundary(start) {
		start += 1;
	}
	format!("…{}", &text[start..])
}

fn drafts(mission: &Mission, step: Step) -> &[crate::mission::Draft] {
	match step {
		Step::Understanding => &mission.understanding,
		Step::Approach => &mission.approach,
		Step::Split => &mission.split,
	}
}

/// Ce qui sépare deux versions d'une même fiche. Pur.
///
/// L'ordre suit celui d'une lecture : la mission d'abord, ses étapes, puis
/// ses tâches une à une. Une porte remise à zéro (`Gate::None`) n'est pas un
/// événement : c'est l'effet d'une correction, déjà notée comme telle.
pub fn between(before: &Mission, after: &Mission) -> Vec<Change> {
	let mut changes = Vec::new();

	if before.state != after.state {
		changes.push(Change::State {
			from: before.state,
			to: after.state,
			note: if after.note != before.note {
				bounded(&after.note)
			} else {
				String::new()
			},
		});
	}

	for step in [Step::Understanding, Step::Approach, Step::Split] {
		let old = drafts(before, step);
		let new = drafts(after, step);
		for (index, draft) in new.iter().enumerate() {
			let version = index as u32 + 1;
			if index >= old.len() {
				changes.push(Change::Draft {
					step,
					version,
					questions: draft.questions.len() as u32,
				});
			}
			let decided_now = draft.review.is_some() && old.get(index).is_none_or(|old| old.review.is_none());
			if let (true, Some(review)) = (decided_now, &draft.review) {
				changes.push(Change::Review {
					step,
					version,
					approved: review.approved,
					feedback: bounded(&review.feedback),
				});
			}
		}
	}

	if !after.guided && after.plan != before.plan && !after.plan.trim().is_empty() {
		changes.push(Change::Plan {
			tasks: after.tasks.len() as u32,
		});
	}

	for task in &after.tasks {
		let Some(old) = before.tasks.iter().find(|old| old.id == task.id) else {
			changes.push(Change::TaskAdded {
				task: task.id.clone(),
				title: task.title.clone(),
				role: task.role.clone(),
			});
			continue;
		};
		if task.attempts > old.attempts {
			changes.push(Change::Rework {
				task: task.id.clone(),
				attempt: task.attempts,
				reason: bounded(task.reproaches.last().map(String::as_str).unwrap_or_default()),
			});
		}
		if task.state != old.state {
			changes.push(Change::Task {
				task: task.id.clone(),
				from: old.state,
				to: task.state,
				note: if task.note != old.note {
					bounded(&task.note)
				} else {
					String::new()
				},
			});
		}
		let gate_moved = task.gate != old.gate || (task.gate != Gate::None && task.gate_output != old.gate_output);
		if gate_moved && task.gate != Gate::None {
			changes.push(Change::Gate {
				task: task.id.clone(),
				gate: task.gate,
				output: bounded(&task.gate_output),
				commit: task.gate_commit.clone(),
			});
		}
	}

	if before.paused != after.paused {
		changes.push(Change::Paused { paused: after.paused });
	}
	if before.pr_url != after.pr_url && !after.pr_url.trim().is_empty() {
		changes.push(Change::Pr {
			url: after.pr_url.clone(),
		});
	}

	changes
}

fn path_in(dir: &Path, id: &str) -> PathBuf {
	dir.join(format!("{id}.events.jsonl"))
}

fn path_of(id: &str) -> PathBuf {
	path_in(&crate::mission::missions_dir(), id)
}

/// Ajoute des changements à l'historique d'une mission.
///
/// Silencieux en cas d'échec, comme le journal : une mission qui avance ne doit
/// jamais s'arrêter parce que son historique n'a pas pu s'écrire.
pub fn append(id: &str, at: &str, changes: Vec<Change>) {
	append_in(&crate::mission::missions_dir(), id, at, changes);
}

fn append_in(dir: &Path, id: &str, at: &str, changes: Vec<Change>) {
	if changes.is_empty() {
		return;
	}
	let mut lines = String::new();
	for change in changes {
		let event = MissionEvent {
			at: at.to_string(),
			change,
		};
		if let Ok(line) = serde_json::to_string(&event) {
			lines.push_str(&line);
			lines.push('\n');
		}
	}
	let _ = std::fs::create_dir_all(dir);
	// Une seule écriture pour tout le lot : deux mises à jour concurrentes ne
	// peuvent pas entrelacer leurs lignes au milieu d'un lot.
	if let Ok(mut file) = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(path_in(dir, id))
	{
		let _ = file.write_all(lines.as_bytes());
	}
}

/// L'historique d'une mission, dans l'ordre où il s'est écrit.
///
/// Vide pour une mission ouverte avant que l'historique existe : il ne se
/// reconstruit pas, il commence à sa première écriture. Une ligne illisible —
/// une écriture coupée par un arrêt brutal — est sautée, pas fatale.
pub fn list(id: &str) -> Vec<MissionEvent> {
	list_in(&crate::mission::missions_dir(), id)
}

fn list_in(dir: &Path, id: &str) -> Vec<MissionEvent> {
	let Ok(raw) = std::fs::read_to_string(path_in(dir, id)) else {
		return Vec::new();
	};
	raw.lines()
		.filter(|line| !line.trim().is_empty())
		.filter_map(|line| serde_json::from_str(line).ok())
		.collect()
}

/// Efface l'historique d'une mission supprimée.
pub fn forget(id: &str) {
	let _ = std::fs::remove_file(path_of(id));
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::mission::{Draft, Review, Task};

	fn mission() -> Mission {
		serde_json::from_value(serde_json::json!({
			"id": "m1",
			"title": "Export CSV",
			"state": "running",
			"tasks": [],
			"createdAt": "2026-11-12T10:00:00Z",
			"updatedAt": "2026-11-12T10:00:00Z",
		}))
		.unwrap()
	}

	fn task(id: &str) -> Task {
		serde_json::from_value(serde_json::json!({
			"id": id,
			"role": "dev",
			"title": format!("Tâche {id}"),
			"state": "planned",
		}))
		.unwrap()
	}

	fn draft() -> Draft {
		Draft {
			text: "compris".into(),
			questions: vec!["laquelle ?".into()],
			submitted_at: "2026-11-12T10:05:00Z".into(),
			review: None,
		}
	}

	#[test]
	fn une_fiche_inchangee_ne_laisse_rien() {
		let fiche = mission();
		assert!(between(&fiche, &fiche.clone()).is_empty());
	}

	#[test]
	fn un_changement_d_etat_porte_sa_raison() {
		let avant = mission();
		let mut apres = avant.clone();
		apres.state = MissionState::Failed;
		apres.note = "arrêtée".into();
		assert_eq!(
			between(&avant, &apres),
			vec![Change::State {
				from: MissionState::Running,
				to: MissionState::Failed,
				note: "arrêtée".into(),
			}]
		);
	}

	#[test]
	fn une_version_puis_sa_decision() {
		let mut avant = mission();
		avant.guided = true;
		let mut proposee = avant.clone();
		proposee.understanding.push(draft());
		assert_eq!(
			between(&avant, &proposee),
			vec![Change::Draft {
				step: Step::Understanding,
				version: 1,
				questions: 1,
			}]
		);

		let mut decidee = proposee.clone();
		decidee.understanding[0].review = Some(Review {
			approved: false,
			feedback: "relis le ticket".into(),
			answers: vec![],
			at: "2026-11-12T10:07:00Z".into(),
		});
		assert_eq!(
			between(&proposee, &decidee),
			vec![Change::Review {
				step: Step::Understanding,
				version: 1,
				approved: false,
				feedback: "relis le ticket".into(),
			}]
		);
	}

	#[test]
	fn une_mission_guidee_ne_double_pas_son_decoupage() {
		let mut avant = mission();
		avant.guided = true;
		let mut apres = avant.clone();
		apres.plan = "deux tâches".into();
		apres.split.push(draft());
		apres.tasks = vec![task("a")];
		let changes = between(&avant, &apres);
		assert!(!changes.iter().any(|c| matches!(c, Change::Plan { .. })));
		assert!(changes
			.iter()
			.any(|c| matches!(c, Change::Draft { step: Step::Split, .. })));
	}

	#[test]
	fn une_mission_autonome_note_son_plan_et_ses_taches() {
		let avant = mission();
		let mut apres = avant.clone();
		apres.plan = "deux tâches".into();
		apres.tasks = vec![task("a"), task("b")];
		assert_eq!(
			between(&avant, &apres),
			vec![
				Change::Plan { tasks: 2 },
				Change::TaskAdded {
					task: "a".into(),
					title: "Tâche a".into(),
					role: "dev".into(),
				},
				Change::TaskAdded {
					task: "b".into(),
					title: "Tâche b".into(),
					role: "dev".into(),
				},
			]
		);
	}

	#[test]
	fn deux_portes_rouges_de_suite_restent_deux_evenements() {
		// Le cas qui motive ce module : la correction efface la première sortie
		// sur la fiche, l'historique doit la garder.
		let mut avant = mission();
		avant.tasks = vec![task("a")];
		avant.tasks[0].state = TaskState::Delivered;

		let mut rouge = avant.clone();
		rouge.tasks[0].gate = Gate::Failed;
		rouge.tasks[0].gate_output = "$ tsc\nexit 2".into();
		rouge.tasks[0].gate_commit = "9c05e2a".into();

		let mut reprise = rouge.clone();
		reprise.tasks[0].attempts = 1;
		reprise.tasks[0].reproaches.push("le typage".into());
		reprise.tasks[0].state = TaskState::Planned;
		reprise.tasks[0].gate = Gate::None;
		reprise.tasks[0].gate_output.clear();

		let mut encore = reprise.clone();
		encore.tasks[0].state = TaskState::Delivered;
		encore.tasks[0].gate = Gate::Failed;
		encore.tasks[0].gate_output = "$ pnpm lint\nexit 1".into();

		let mut tout = between(&avant, &rouge);
		tout.extend(between(&rouge, &reprise));
		tout.extend(between(&reprise, &encore));
		let portes: Vec<&str> = tout
			.iter()
			.filter_map(|change| match change {
				Change::Gate { output, .. } => Some(output.as_str()),
				_ => None,
			})
			.collect();
		assert_eq!(portes, vec!["$ tsc\nexit 2", "$ pnpm lint\nexit 1"]);
		assert!(tout.contains(&Change::Rework {
			task: "a".into(),
			attempt: 1,
			reason: "le typage".into(),
		}));
		assert!(tout.iter().any(|change| matches!(
			change,
			Change::Gate { commit, .. } if commit == "9c05e2a"
		)));
	}

	#[test]
	fn une_porte_qui_tourne_puis_tranche() {
		let mut avant = mission();
		avant.tasks = vec![task("a")];
		let mut lancee = avant.clone();
		lancee.tasks[0].gate = Gate::Running;
		lancee.tasks[0].gate_output = "tsc · lint".into();
		let mut verte = lancee.clone();
		verte.tasks[0].gate = Gate::Passed;
		verte.tasks[0].gate_output.clear();
		assert!(matches!(
			between(&avant, &lancee).as_slice(),
			[Change::Gate {
				gate: Gate::Running,
				..
			}]
		));
		assert!(matches!(
			between(&lancee, &verte).as_slice(),
			[Change::Gate { gate: Gate::Passed, .. }]
		));
	}

	#[test]
	fn une_longue_note_garde_sa_fin() {
		let longue = format!("début{}fin", "é".repeat(TEXT_LIMIT));
		let gardee = bounded(&longue);
		assert!(gardee.starts_with('…'));
		assert!(gardee.ends_with("fin"));
		assert!(gardee.len() <= TEXT_LIMIT + '…'.len_utf8());
	}

	#[test]
	fn l_historique_se_relit_dans_l_ordre_et_saute_une_ligne_coupee() {
		let dir = std::env::temp_dir().join(format!("cockpit-events-{}", crate::mission::identifier()));
		append_in(
			&dir,
			"m1",
			"2026-11-12T10:00:00Z",
			vec![Change::Opened { guided: true }],
		);
		append_in(&dir, "m1", "2026-11-12T10:05:00Z", vec![]);
		// Une écriture interrompue au milieu d'une ligne.
		std::fs::OpenOptions::new()
			.append(true)
			.open(path_in(&dir, "m1"))
			.unwrap()
			.write_all(b"{\"at\":\"2026-11-12T10:06")
			.unwrap();
		std::fs::OpenOptions::new()
			.append(true)
			.open(path_in(&dir, "m1"))
			.unwrap()
			.write_all(b"\n")
			.unwrap();
		append_in(
			&dir,
			"m1",
			"2026-11-12T10:09:00Z",
			vec![Change::Paused { paused: true }],
		);

		let lu = list_in(&dir, "m1");
		assert_eq!(
			lu,
			vec![
				MissionEvent {
					at: "2026-11-12T10:00:00Z".into(),
					change: Change::Opened { guided: true },
				},
				MissionEvent {
					at: "2026-11-12T10:09:00Z".into(),
					change: Change::Paused { paused: true },
				},
			]
		);
		assert!(list_in(&dir, "inconnue").is_empty());
		let _ = std::fs::remove_dir_all(&dir);
	}
}
