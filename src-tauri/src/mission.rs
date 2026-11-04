//! Missions : un ticket, un plan, des exécutants.
//!
//! Le cockpit sait lancer des agents ; il ne savait pas ce qui les relie. Une
//! mission donne ce lien : un ticket produit un plan, le plan produit des
//! tâches, chaque tâche a son rôle, son périmètre, sa branche et son agent.
//!
//! La forme suit celle qu'on veut piloter :
//!
//! ```text
//! Mission — ticket PROJ-42, branche d'intégration depuis dev
//!   ├── back   → branche depuis l'intégration, worktree isolé
//!   ├── front  → branche depuis l'intégration, worktree isolé
//!   └── qa     → branche depuis celle du back (dépendance déclarée)
//! ```
//!
//! Rien ici ne lance ni ne fusionne : ce module tient l'état et le rend
//! durable. Un cockpit redémarré au milieu d'une mission doit la retrouver
//! entière — c'est la première raison d'être de cet objet, avant même
//! l'automatisation.
//!
//! Le plan, lui, ne s'exécute jamais sans accord : une mission passe par
//! `AwaitingApproval` et n'en sort que sur une décision humaine. Trois agents
//! lancés sur un découpage bancal coûtent trois fois, et se rattrapent mal.

use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};

/// Où en est une mission dans son cycle de vie.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissionState {
	/// Parcours guidé : le maître lit le ticket et formule ce qu'il en comprend.
	Understanding,
	/// Sa compréhension attend d'être validée — ou corrigée.
	AwaitingUnderstanding,
	/// Parcours guidé : le maître prépare son approche, sans découper encore.
	Approaching,
	/// Son approche attend d'être validée — ou corrigée.
	AwaitingApproach,
	/// Le maître analyse le ticket et prépare son découpage.
	Planning,
	/// Un plan est posé : il attend un accord avant que rien ne parte.
	AwaitingApproval,
	/// Les exécutants travaillent.
	Running,
	/// Tout est livré ; le maître recompose dans la branche d'intégration.
	Integrating,
	/// Pull request ouverte, mission close.
	Done,
	/// Abandonnée ou en échec — la raison vit dans `note`.
	Failed,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
	Planned,
	Running,
	/// L'exécutant a fini ; ses commits attendent d'être intégrés.
	Delivered,
	Integrated,
	Failed,
}

/// Une tâche confiée à un exécutant.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "MissionTask"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
	pub id: String,
	/// Rôle du catalogue — décide du prompt, du modèle et du périmètre par défaut.
	pub role: String,
	/// Ce que fait cette tâche, en une ligne.
	pub title: String,
	/// La consigne complète transmise à l'exécutant.
	#[serde(default)]
	pub brief: String,
	/// Chemins où cette tâche a le droit d'écrire. Vide = tout le dépôt, ce qui
	/// ne devrait rester qu'une exception assumée.
	#[serde(default)]
	pub scope: Vec<String>,
	/// Branche de départ : celle d'intégration, ou celle d'une sœur quand deux
	/// travaux dépendent réellement l'un de l'autre.
	#[serde(default)]
	pub base: String,
	#[serde(default)]
	pub branch: String,
	#[serde(default)]
	pub worktree: String,
	/// Agent du cockpit qui porte cette tâche, une fois lancée.
	#[serde(default)]
	pub session_id: Option<String>,
	/// La branche sur laquelle l'exécutant a réellement travaillé, quand ce
	/// n'est pas la sienne.
	///
	/// Rien n'empêche un agent de se créer une branche dans son worktree — et
	/// certains le font, par habitude de nommage. Son travail existe alors, mais
	/// pas là où l'intégration va le chercher : elle fusionne une branche vide,
	/// la mission se referme, et le code reste sur une branche que plus rien ne
	/// nomme. Vide tant que l'exécutant est resté sur la sienne.
	#[serde(default)]
	pub actual_branch: String,
	/// Conversation du moteur, retenue pour la reprendre plutôt que la refaire.
	///
	/// Une reprise coupait l'exécutant et en relançait un neuf : le contexte
	/// repartait de zéro et se repayait au prix fort, trois fois par tâche au
	/// pire. En gardant l'identifiant de la conversation, la correction se
	/// greffe sur ce que l'exécutant sait déjà.
	#[serde(default)]
	pub engine_session: String,
	pub state: TaskState,
	/// Le verdict rendu, pour une tâche qui vérifie.
	///
	/// Vide tant qu'elle n'a rien conclu, ou quand son rôle ne juge pas. Voir
	/// [`read_verdict`] : c'est ce que le cockpit a compris de son rapport, pas
	/// ce que le maître a bien voulu en retenir.
	#[serde(default)]
	pub verdict: String,
	/// Ce que l'exécutant a rendu, ou pourquoi il a échoué.
	#[serde(default)]
	pub note: String,
	/// Combien de fois cette tâche a été renvoyée en correction.
	///
	/// Une recette qui refuse, un correctif, une recette qui refuse encore : le
	/// cycle est le bon, mais rien ne garantit qu'il converge. Ce compteur borne
	/// les reprises plutôt que de laisser deux agents se renvoyer la balle toute
	/// la nuit.
	#[serde(default)]
	pub attempts: u32,
	/// Ce qui lui a été reproché, une entrée par reprise, dans l'ordre.
	///
	/// En ajout seul : le motif d'une reprise ne se corrige pas, il s'ajoute.
	/// La consigne les accumulait déjà, noyés dans un brief qui fait des
	/// pages ; personne ne pouvait donc voir qu'une recette reprochait trois
	/// fois la même chose — et c'est le seul signe qui distingue une tâche qui
	/// converge d'une tâche qui piétine.
	#[serde(default)]
	pub reproaches: Vec<String>,
	/// Début du passage en cours. Remis à zéro à chaque reprise.
	#[serde(default)]
	pub started_at: Option<String>,
	/// Fin du dernier passage.
	#[serde(default)]
	pub finished_at: Option<String>,
	/// Où en était le travail à la fin du dernier passage de cette tâche.
	///
	/// N'a de sens que pour un rôle qui vérifie : à chaque reprise, recette et
	/// relecture repartaient de zéro et relisaient vingt fichiers pour valider
	/// une correction d'une ligne — c'est ce qui faisait durer les missions des
	/// heures. Ce repère leur dit d'où regarder. Vide = elles lisent tout, ce
	/// qui est le cas au premier passage et après une relecture forcée.
	#[serde(default)]
	pub checkpoint: String,
	/// Temps cumulé de tous les passages, en secondes.
	///
	/// Cumulé et non pas mesuré du début à la fin : une tâche reprise trois fois
	/// s'étale sur des heures dont l'essentiel se passe à attendre son tour. Ce
	/// qu'on veut savoir, c'est le temps qu'elle a réellement coûté.
	#[serde(default)]
	#[cfg_attr(test, ts(type = "number"))]
	pub worked_seconds: u64,
	/// Où en sont les portes du projet (`workflow.gate_commands`) sur le
	/// dernier rendu de cette tâche. Voir `gates.rs`.
	#[serde(default)]
	pub gate: Gate,
	/// La fin de la sortie de la porte qui a échoué, pour le maître et pour toi.
	#[serde(default)]
	pub gate_output: String,
}

/// L'état des portes de vérification d'une tâche.
///
/// `None` couvre deux cas qu'on ne distingue pas exprès : le projet ne déclare
/// aucune porte, ou la tâche n'a encore rien rendu. Dans les deux, rien ne
/// retient l'intégration — c'est le comportement d'avant les portes.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "TaskGate"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Gate {
	#[default]
	None,
	Running,
	Passed,
	Failed,
}

impl Gate {
	/// Vrai quand l'intégration de cette tâche doit attendre.
	pub fn holds(self) -> bool {
		matches!(self, Gate::Running | Gate::Failed)
	}
}

/// Ce que les exécutants d'une mission pourront faire sans rien demander.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "MissionExposure"))]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Exposure {
	/// Les agents partent dans un conteneur (`sandbox.enabled`).
	pub sandboxed: bool,
	/// Les rôles du plan qui partiront en `bypassPermissions`, sans doublon,
	/// dans l'ordre du plan. Vide quand l'isolation est active : le conteneur
	/// borne alors ce que le mode laisse faire.
	pub unguarded_roles: Vec<String>,
}

/// Les rôles d'un plan qui travailleront sans filet sur le poste.
///
/// `bypassPermissions` est un choix défendable pour un exécutant (voir
/// `RoleConfig::permission_mode`) : il travaille seul, dans un worktree à lui.
/// Mais hors conteneur, son outil Bash a les droits de la session — tout le
/// disque, le réseau, les identifiants. Le dire au moment d'approuver le plan
/// est le seul moment où ça peut encore changer quelque chose.
pub fn exposure(tasks: &[Task], roles: &[crate::config::RoleConfig], sandboxed: bool) -> Exposure {
	let mut unguarded: Vec<String> = Vec::new();
	if !sandboxed {
		for task in tasks {
			let bypass = roles
				.iter()
				.find(|role| role.id == task.role)
				.map(|role| role.permission_mode.trim() == "bypassPermissions")
				.unwrap_or(false);
			if bypass && !unguarded.contains(&task.role) {
				unguarded.push(task.role.clone());
			}
		}
	}
	Exposure { sandboxed, unguarded_roles: unguarded }
}

#[cfg(test)]
mod exposure_tests {
	use super::*;

	fn role(id: &str, mode: &str) -> crate::config::RoleConfig {
		crate::config::RoleConfig {
			id: id.into(),
			permission_mode: mode.into(),
			..Default::default()
		}
	}

	fn tache(role: &str) -> Task {
		serde_json::from_value(serde_json::json!({
			"id": format!("t-{role}"),
			"role": role,
			"title": role,
			"state": "planned",
		}))
		.unwrap()
	}

	#[test]
	fn nomme_les_roles_sans_filet_une_fois_chacun() {
		let roles = vec![role("backend", "bypassPermissions"), role("frontend", "acceptEdits")];
		let plan = vec![tache("backend"), tache("frontend"), tache("backend")];
		let vue = exposure(&plan, &roles, false);
		assert_eq!(vue.unguarded_roles, vec!["backend".to_string()]);
		assert!(!vue.sandboxed);
	}

	#[test]
	fn un_conteneur_borne_ce_que_le_mode_laisse_faire() {
		let roles = vec![role("backend", "bypassPermissions")];
		let vue = exposure(&[tache("backend")], &roles, true);
		assert!(vue.unguarded_roles.is_empty());
		assert!(vue.sandboxed);
	}

	#[test]
	fn les_roles_par_defaut_partent_sans_filet() {
		// Ce que le cockpit livre d'office : c'est précisément le cas à dire.
		let roles = crate::config::default_roles();
		let vue = exposure(&[tache("backend")], &roles, false);
		assert_eq!(vue.unguarded_roles, vec!["backend".to_string()]);
	}
}

/// Ce que l'intégration fait d'une tâche livrée, au regard des portes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
	/// Rien ne la retient : on la fusionne.
	Merge,
	/// Ses portes n'ont jamais tourné sur ce rendu : on les lance, et elle attend.
	Start,
	/// Ses portes tournent : elle attend.
	Pending,
	/// Une porte a échoué : elle ne part pas, le maître la renvoie en correction.
	Refuse,
}

/// La règle, à part de tout effet pour qu'elle se vérifie en entier.
///
/// `declared` : le dépôt déclare des portes. `verifies` : la tâche est une
/// vérification, qui ne commite rien et n'a donc rien à faire juger.
pub fn gate_decision(gate: Gate, declared: bool, verifies: bool) -> GateDecision {
	if !declared || verifies {
		// Une porte retirée des réglages ne retient plus rien, même notée en
		// échec : c'est le dépôt qui dit ce qui doit passer.
		return GateDecision::Merge;
	}
	match gate {
		Gate::Passed => GateDecision::Merge,
		Gate::None => GateDecision::Start,
		Gate::Running => GateDecision::Pending,
		Gate::Failed => GateDecision::Refuse,
	}
}

#[cfg(test)]
mod gate_tests {
	use super::*;

	#[test]
	fn sans_porte_declaree_tout_se_fusionne() {
		for gate in [Gate::None, Gate::Running, Gate::Passed, Gate::Failed] {
			assert_eq!(gate_decision(gate, false, false), GateDecision::Merge, "{gate:?}");
		}
	}

	#[test]
	fn une_verification_ne_passe_pas_les_portes() {
		assert_eq!(gate_decision(Gate::None, true, true), GateDecision::Merge);
	}

	#[test]
	fn seule_une_porte_passee_ouvre_l_integration() {
		assert_eq!(gate_decision(Gate::Passed, true, false), GateDecision::Merge);
		assert_eq!(gate_decision(Gate::None, true, false), GateDecision::Start);
		assert_eq!(gate_decision(Gate::Running, true, false), GateDecision::Pending);
		assert_eq!(gate_decision(Gate::Failed, true, false), GateDecision::Refuse);
	}

	#[test]
	fn une_porte_se_relit_telle_qu_elle_s_ecrit() {
		// L'interface lit ces valeurs ; un renommage côté Rust la ferait taire.
		for (gate, texte) in [
			(Gate::None, "\"none\""),
			(Gate::Running, "\"running\""),
			(Gate::Passed, "\"passed\""),
			(Gate::Failed, "\"failed\""),
		] {
			assert_eq!(serde_json::to_string(&gate).unwrap(), texte);
			assert_eq!(serde_json::from_str::<Gate>(texte).unwrap(), gate);
		}
	}

	#[test]
	fn une_fiche_d_avant_les_portes_se_relit() {
		// Les missions déjà sur le disque n'ont ni `gate` ni `gateOutput`.
		let ancienne = r#"{"id":"t","role":"backend","title":"x","state":"delivered"}"#;
		let task: Task = serde_json::from_str(ancienne).unwrap();
		assert_eq!(task.gate, Gate::None);
		assert!(task.gate_output.is_empty());
	}
}

/// Pose l'état des portes d'une tâche, et la sortie qui l'explique.
pub fn set_task_gate(id: &str, task_id: &str, gate: Gate, output: &str) -> Result<Mission> {
	update(id, |mission| {
		if let Some(task) = mission.tasks.iter_mut().find(|task| task.id == task_id) {
			task.gate = gate;
			task.gate_output = output.to_string();
		}
	})
}

/// Les trois accords d'une mission guidée, dans l'ordre où on les donne.
///
/// Le parcours autonome n'en connaissait qu'un — le découpage — et c'était le
/// mauvais endroit pour découvrir que le ticket avait été mal lu : trois
/// exécutants étaient déjà prêts à partir sur un malentendu. Chaque étape a
/// son état de travail (le maître rédige) et son état d'attente (l'humain
/// relit) ; on ne passe à la suivante que sur un accord.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "MissionStep"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
	Understanding,
	Approach,
	Split,
}

impl Step {
	/// L'état où le maître rédige cette étape.
	pub fn working(self) -> MissionState {
		match self {
			Step::Understanding => MissionState::Understanding,
			Step::Approach => MissionState::Approaching,
			Step::Split => MissionState::Planning,
		}
	}

	/// L'état où elle attend une décision humaine.
	pub fn awaiting(self) -> MissionState {
		match self {
			Step::Understanding => MissionState::AwaitingUnderstanding,
			Step::Approach => MissionState::AwaitingApproach,
			Step::Split => MissionState::AwaitingApproval,
		}
	}

	/// Où mène un accord.
	pub fn approved(self) -> MissionState {
		match self {
			Step::Understanding => MissionState::Approaching,
			Step::Approach => MissionState::Planning,
			Step::Split => MissionState::Running,
		}
	}

	/// Au-delà, la proposition est refusée avant même d'être montrée.
	///
	/// La consigne « dix lignes » tient tant que le modèle y pense ; une
	/// synthèse de quarante lignes n'est plus une synthèse, c'est le ticket
	/// réécrit, et personne ne la lit. Le découpage n'a pas de plafond : il
	/// se lit tâche par tâche, pas comme un texte.
	pub fn max_lines(self) -> Option<usize> {
		match self {
			Step::Understanding => Some(10),
			Step::Approach => Some(15),
			Step::Split => None,
		}
	}

	/// Le nom de l'étape, tel que l'utilisateur le lit.
	pub fn label(self) -> String {
		crate::i18n::t(match self {
			Step::Understanding => "mission.step.understanding",
			Step::Approach => "mission.step.approach",
			Step::Split => "mission.step.split",
		})
	}

	/// Le nom de l'étape dans les consignes et les réponses d'outil du
	/// maître, toujours en anglais comme le reste de ses prompts.
	pub fn protocol_label(self) -> &'static str {
		match self {
			Step::Understanding => "understanding",
			Step::Approach => "approach",
			Step::Split => "breakdown",
		}
	}
}

/// Une version de ce que le maître propose à une étape.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "MissionDraft"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
	pub text: String,
	/// Ce qu'il n'a pas su trancher seul. À part du texte : une ambiguïté
	/// noyée dans une synthèse se lit comme une certitude.
	#[serde(default)]
	pub questions: Vec<String>,
	pub submitted_at: String,
	/// La décision humaine sur cette version — posée une fois, jamais réécrite.
	#[serde(default)]
	pub review: Option<Review>,
}

/// Ce qu'un humain a décidé d'une version.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "MissionReview"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
	pub approved: bool,
	/// Ce qu'il faut corriger — ou ce qu'il ajoute en validant.
	#[serde(default)]
	pub feedback: String,
	/// Ses réponses, dans l'ordre des questions ; vide = sans réponse.
	#[serde(default)]
	pub answers: Vec<String>,
	pub at: String,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
	pub id: String,
	pub title: String,
	/// Ticket d'origine, quand la mission en vient.
	#[serde(default)]
	pub ticket: String,
	#[serde(default)]
	pub ticket_url: String,
	/// Branche d'intégration : les exécutants en partent, le maître y recompose.
	#[serde(default)]
	pub branch: String,
	/// Branche sur laquelle la pull request finale se greffe.
	///
	/// La branche par défaut du dépôt, sauf quand la mission prolonge un travail
	/// déjà en cours : la PR s'empile alors sur celle-là, et ne montre que ce que
	/// la mission ajoute. Vide = branche par défaut, résolue au moment d'ouvrir.
	#[serde(default)]
	pub base: String,
	/// Dépôt ou worktree où travaille le maître.
	#[serde(default)]
	pub cwd: String,
	/// Agent maître, une fois lancé.
	#[serde(default)]
	pub master_session: Option<String>,
	pub state: MissionState,
	/// Résumé du plan, tel que le maître l'a formulé.
	#[serde(default)]
	pub plan: String,
	/// Mission guidée : compréhension, approche et découpage passent chacun
	/// par un accord humain avant que rien ne parte.
	///
	/// Faux pour une mission autonome — réglage d'équipe, ou Permanence — et
	/// pour toutes celles ouvertes avant que le parcours existe : elles
	/// finissent leur vie sur le chemin qu'elles ont commencé.
	#[serde(default)]
	pub guided: bool,
	/// Ce que le maître a compris du ticket, version après version.
	///
	/// En ajout seul : une correction ne réécrit pas la version fautive, elle
	/// en appelle une autre. C'est ce qui permet de relire, après coup, ce que
	/// le maître avait mal compris — et ce qu'on lui a répondu.
	#[serde(default)]
	pub understanding: Vec<Draft>,
	/// Comment le maître compte s'y prendre, avant tout découpage.
	#[serde(default)]
	pub approach: Vec<Draft>,
	/// Les découpages proposés, dans l'ordre. Le dernier est celui que
	/// portent `plan` et `tasks`.
	#[serde(default)]
	pub split: Vec<Draft>,
	/// Pull request d'intégration, une fois ouverte.
	#[serde(default)]
	pub pr_url: String,
	/// Compte rendu écrit par le maître : ce qui a été fait, comment ça marche,
	/// où regarder. C'est ce qu'on relit trois semaines plus tard, et ce qu'on
	/// montre à qui demande « comment ça fonctionne ? ».
	#[serde(default)]
	pub summary: String,
	#[serde(default)]
	pub note: String,
	/// Mission suspendue : le lanceur ne fait plus partir personne.
	///
	/// Distinct de l'état : une mission en pause reste « en cours » — son plan,
	/// ses branches et le travail déjà fait sont intacts. Seul l'automatisme
	/// s'arrête, le temps de reprendre la main.
	#[serde(default)]
	pub paused: bool,
	/// Quand le plan a été approuvé — le vrai départ du travail.
	///
	/// Distinct de `created_at` : entre l'ouverture d'une mission et son
	/// approbation, il peut s'écouler une nuit, et compter ce temps-là dans sa
	/// durée ne dirait rien de ce qu'elle a coûté.
	#[serde(default)]
	pub started_at: Option<String>,
	/// Quand la pull request a été ouverte, ou la mission arrêtée.
	#[serde(default)]
	pub finished_at: Option<String>,
	pub tasks: Vec<Task>,
	pub created_at: String,
	pub updated_at: String,
}

impl Mission {
	/// Un exécutant peut-il partir maintenant ?
	///
	/// Une mission guidée n'en lance aucun avant le dernier accord — ni le
	/// maître, ni un geste à la main. Une mission autonome garde sa règle
	/// d'origine : tout, sauf pendant que le plan attend son accord.
	pub fn can_launch(&self) -> bool {
		if self.guided {
			self.state.executes()
		} else {
			self.state != MissionState::AwaitingApproval
		}
	}

	/// Cette mission appartient-elle à ce dépôt ?
	///
	/// Le rattachement se lit dans `cwd` plutôt que dans un champ à part : c'est
	/// le dépôt sur lequel la mission a été ouverte, il ne peut pas se
	/// désynchroniser, et les missions déjà enregistrées le portent déjà.
	pub fn belongs_to(&self, repo: &str) -> bool {
		let repo = repo.trim_end_matches('/');
		// Sans dépôt de référence, on ne cache rien : mieux vaut tout montrer
		// qu'un écran vide sans explication.
		repo.is_empty() || self.cwd.trim_end_matches('/') == repo
	}

	/// L'implémentation a-t-elle rendu sa copie ?
	///
	/// C'est ce qui autorise recette et relecture à partir : lancées plus tôt,
	/// elles jugeraient une branche vide. Une tâche en échec compte comme
	/// terminée — la retenir indéfiniment bloquerait la mission en silence,
	/// alors qu'une recette sur un travail partiel dit au moins ce qui manque.
	pub fn implementation_done(&self, verifies: impl Fn(&str) -> bool) -> bool {
		self.tasks
			.iter()
			.filter(|task| !verifies(&task.role))
			.all(|task| {
				matches!(
					task.state,
					TaskState::Delivered | TaskState::Integrated | TaskState::Failed
				)
			})
	}

	/// Avancement de la mission, du point de vue de ses tâches.
	///
	/// Une mission sans tâche n'est pas à zéro pour rien : elle est à l'étude,
	/// et son plan compte pour un premier pas.
	pub fn progress(&self) -> u32 {
		if self.tasks.is_empty() {
			return match self.state {
				MissionState::Understanding => 2,
				MissionState::AwaitingUnderstanding => 4,
				MissionState::Approaching => 6,
				MissionState::AwaitingApproach => 8,
				MissionState::Planning => 5,
				MissionState::AwaitingApproval => 15,
				MissionState::Done => 100,
				_ => 10,
			};
		}
		let done = self
			.tasks
			.iter()
			.filter(|task| matches!(task.state, TaskState::Delivered | TaskState::Integrated))
			.count();
		let integrated = self
			.tasks
			.iter()
			.filter(|task| task.state == TaskState::Integrated)
			.count();
		// Livrer vaut la moitié du chemin, intégrer l'autre : c'est la
		// recomposition qui coûte, pas le fait d'avoir fini chacun de son côté.
		let total = self.tasks.len() as u32;
		((done as u32 * 50 + integrated as u32 * 50) / total).min(100)
	}
}

// ─────────────────────────────── Persistance ───────────────────────────────

fn missions_dir() -> std::path::PathBuf {
	crate::config::config_dir().join("missions")
}

fn now() -> String {
	chrono::Utc::now().to_rfc3339()
}

/// Relit un horodatage écrit par `now()`.
fn parse_time(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
	chrono::DateTime::parse_from_rfc3339(raw)
		.ok()
		.map(|t| t.with_timezone(&chrono::Utc))
}

/// Depuis combien de temps cette mission n'a rien fait, en secondes.
///
/// `updated_at` bouge à chaque écriture — une tâche qui change d'état, un
/// maître qu'on rattache, un verdict qui rentre. Une mission qui ne bouge plus
/// est donc soit finie, soit en panne, et c'est la seconde qu'on veut voir.
pub fn idle_seconds(mission: &Mission) -> i64 {
	parse_time(&mission.updated_at)
		.map(|at| (chrono::Utc::now() - at).num_seconds().max(0))
		.unwrap_or(0)
}

fn path_of(id: &str) -> std::path::PathBuf {
	missions_dir().join(format!("{id}.json"))
}

/// Missions connues, la plus récemment touchée d'abord.
pub fn list() -> Vec<Mission> {
	let Ok(entries) = std::fs::read_dir(missions_dir()) else {
		return Vec::new();
	};
	let mut missions: Vec<Mission> = entries
		.flatten()
		.filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
		.filter_map(|entry| {
			let raw = std::fs::read_to_string(entry.path()).ok()?;
			serde_json::from_str(&raw).ok()
		})
		.collect();
	missions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
	missions
}

pub fn get(id: &str) -> Result<Mission> {
	let raw = std::fs::read_to_string(path_of(id))
		.map_err(|_| CockpitError::msg(crate::i18n::tf("mission.unknown", &[("id", &id)])))?;
	serde_json::from_str(&raw).map_err(|e| CockpitError::msg(crate::i18n::tf("mission.unreadable", &[("error", &e)])))
}

pub fn save(mission: &Mission) -> Result<()> {
	let dir = missions_dir();
	std::fs::create_dir_all(&dir)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("mission.folderError", &[("error", &e)])))?;
	let raw = serde_json::to_string_pretty(mission)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("mission.unreadable", &[("error", &e)])))?;
	std::fs::write(path_of(&mission.id), raw)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("mission.writeError", &[("error", &e)])))
}

pub(crate) fn identifier() -> String {
	use rand::RngCore;
	let mut bytes = [0u8; 6];
	rand::rng().fill_bytes(&mut bytes);
	bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Ouvre une mission. Rien n'est lancé : elle attend son plan.
/// `guided` : la mission passe par les trois accords — compréhension,
/// approche, découpage — au lieu de partir directement sur un découpage.
pub fn create(
	title: &str,
	ticket: &str,
	ticket_url: &str,
	cwd: &str,
	branch: &str,
	guided: bool,
) -> Result<Mission> {
	let title = title.trim();
	if title.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("mission.titleRequired")));
	}
	let mission = Mission {
		id: identifier(),
		title: title.to_string(),
		ticket: ticket.trim().to_string(),
		ticket_url: ticket_url.trim().to_string(),
		branch: branch.trim().to_string(),
		base: String::new(),
		cwd: cwd.trim().to_string(),
		master_session: None,
		state: if guided {
			MissionState::Understanding
		} else {
			MissionState::Planning
		},
		plan: String::new(),
		guided,
		understanding: Vec::new(),
		approach: Vec::new(),
		split: Vec::new(),
		pr_url: String::new(),
		summary: String::new(),
		note: String::new(),
		paused: false,
		started_at: None,
		finished_at: None,
		tasks: Vec::new(),
		created_at: now(),
		updated_at: now(),
	};
	save(&mission)?;
	crate::journal::record("mission", &crate::i18n::t("mission.journal.opened"), &mission.title, true, &mission.ticket);
	Ok(mission)
}

/// Retire la fiche. Silencieux si elle n'était déjà plus là.
///
/// Un échec d'écriture disque se dit, plutôt que de laisser croire à une
/// suppression : l'appelant annonçait « mission supprimée » à une fiche restée
/// en place, et le geste semblait sans effet.
pub fn remove(id: &str) -> Result<()> {
	// Sous le même verrou que les mises à jour : une écriture en vol ne doit pas
	// recréer la fiche juste après sa suppression.
	let _guard = write_lock();
	let path = path_of(id);
	match std::fs::remove_file(&path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
		Err(error) => Err(CockpitError::msg(crate::i18n::tf(
			"mission.deleteFailed",
			&[("path", &path.display()), ("error", &error)],
		))),
	}
}

/// Au-delà, c'est que le cycle ne converge pas : mieux vaut rendre la main.
pub const MAX_ATTEMPTS: u32 = 3;

/// Renvoie une tâche en correction, avec ce qu'on lui reproche.
///
/// La recette et la relecture ne servent à rien si leur verdict ne redescend
/// pas : c'est ce chemin-là qui referme la boucle. La tâche repart « à faire »
/// dans son worktree — son travail est intact, l'exécutant reprend dessus — et
/// les vérifications repassent en attente, puisqu'elles auront à rejuger.
///
/// Rend l'erreur plutôt que de reprendre indéfiniment quand le plafond est
/// atteint : trois allers-retours sans converger demandent un humain.
pub fn rework(id: &str, task_id: &str, reproche: &str, verifies: impl Fn(&str) -> bool) -> Result<Mission> {
	let task_id = task_id.trim().to_string();
	let reproche = reproche.trim().to_string();
	if reproche.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("mission.reworkNeedsReason")));
	}

	let mission = get(id)?;
	let task = mission
		.tasks
		.iter()
		.find(|task| task.id == task_id)
		.ok_or_else(|| CockpitError::msg(crate::i18n::tf("mission.unknownTask", &[("id", &task_id)])))?;
	if task.attempts >= MAX_ATTEMPTS {
		// Ce qui lui a déjà été reproché part avec le refus : au troisième
		// renvoi, la question n'est plus « que corriger » mais « est-ce qu'on
		// tourne en rond », et personne ne peut y répondre sans relire la
		// série. Elle vivait jusqu'ici au fond du brief de la tâche.
		let déjà = task
			.reproaches
			.iter()
			.enumerate()
			.map(|(rang, motif)| {
				format!("\n  {}. {}", rang + 1, motif.chars().take(200).collect::<String>())
			})
			.collect::<String>();
		return Err(CockpitError::msg(format!(
			"{}{déjà}",
			crate::i18n::tf(
				"mission.reworkLimit",
				&[("title", &task.title), ("count", &task.attempts)],
			)
		)));
	}

	let mission = update(id, |mission| {
		// Une reprise ramène la mission au travail : elle a pu passer à
		// l'intégration quand tout semblait rendu, et le lanceur n'agit que sur
		// une mission en cours.
		if mission.state == MissionState::Integrating {
			mission.state = MissionState::Running;
		}
		for entry in mission.tasks.iter_mut() {
			if entry.id == task_id {
				entry.attempts += 1;
				entry.state = TaskState::Planned;
				entry.session_id = None;
				// Ce qu'elle avait conclu ne vaut plus : elle va rejuger.
				entry.verdict.clear();
				// Une correction se rejuge : la porte d'avant parlait d'un autre code.
				entry.gate = Gate::None;
				entry.gate_output.clear();
				entry.note = crate::i18n::tf(
					"mission.note.rework",
					&[("count", &entry.attempts), ("reason", &reproche)],
				);
				entry.reproaches.push(reproche.clone());
				// La consigne s'accumule : l'exécutant reprend son propre travail,
				// il doit savoir ce qui lui est reproché sans perdre l'énoncé.
				entry.brief = format!(
					"{}\n\n── Rework requested ──\n{reproche}",
					entry.brief.trim()
				);
			} else if verifies(&entry.role)
				&& matches!(entry.state, TaskState::Delivered | TaskState::Integrated)
			{
				// Ce qui a été jugé va changer : les vérifications rejugent.
				entry.state = TaskState::Planned;
				entry.session_id = None;
				entry.note = crate::i18n::t("mission.note.redoAfterRework");
			}
		}
	})?;

	crate::journal::record(
		"mission",
		&crate::i18n::t("mission.journal.taskReworked"),
		&mission.title,
		true,
		reproche.chars().take(120).collect::<String>().as_str(),
	);
	Ok(mission)
}

/// Déclare la branche sur laquelle la pull request se greffera.
pub fn set_base(id: &str, base: &str) -> Result<Mission> {
	let base = base.trim().to_string();
	update(id, |mission| mission.base = base.clone())
}

/// Suspend ou relance l'automatisme d'une mission.
pub fn set_paused(id: &str, paused: bool) -> Result<Mission> {
	let mission = update(id, |mission| mission.paused = paused)?;
	crate::journal::record(
		"mission",
		&crate::i18n::t(if paused { "mission.journal.paused" } else { "mission.journal.resumed" }),
		&mission.title,
		true,
		"",
	);
	Ok(mission)
}

/// Remet d'aplomb ce qu'un arrêt du cockpit a laissé en l'air.
///
/// Le registre des agents ne survit pas à la fermeture : au démarrage, aucune
/// session n'est vivante, donc toute tâche encore « en cours » désigne un agent
/// qui n'existe plus. Sans ce ménage, le lanceur ne la reprendrait jamais — il
/// n'agit que sur les tâches à faire — et elle occuperait une place au plafond
/// jusqu'à la fin des temps. Le worktree, lui, reste : le travail déjà produit
/// attend son exécutant suivant.
pub async fn recover_all() -> usize {
	let mut recovered = 0;
	for mission in list() {
		let orphans: Vec<Task> = mission
			.tasks
			.iter()
			.filter(|task| task.state == TaskState::Running)
			.cloned()
			.collect();
		if orphans.is_empty() && mission.master_session.is_none() {
			continue;
		}

		// Un agent mort a pu finir son travail avant que le cockpit ne ferme :
		// ses commits sont là pour le dire. Tout remettre « à faire » relancerait
		// un exécutant sur un travail déjà rendu, qui le referait.
		let mut delivered = Vec::new();
		let mut to_redo = Vec::new();
		for task in &orphans {
			let commits = crate::git::run_git(
				std::path::Path::new(&mission.cwd),
				&["rev-list", "--count", &format!("{}..{}", mission.branch, task.branch)],
			)
			.await
			.ok()
			.and_then(|raw| raw.trim().parse::<u32>().ok())
			.unwrap_or(0);
			if commits > 0 {
				delivered.push(task.id.clone());
			} else {
				to_redo.push(task.id.clone());
			}
		}

		recovered += to_redo.len();
		let _ = update(&mission.id, |mission| {
			for task in mission.tasks.iter_mut() {
				if delivered.contains(&task.id) {
					task.state = TaskState::Delivered;
					task.note = crate::i18n::t("mission.note.workFoundAtStartup");
				} else if to_redo.contains(&task.id) {
					task.state = TaskState::Planned;
					task.session_id = None;
					task.note = crate::i18n::t("mission.note.resumedAfterRestart");
				}
			}
			mission.master_session = None;
		});

		if !orphans.is_empty() {
			crate::journal::record(
				"mission",
				&crate::i18n::t("mission.journal.tasksRecovered"),
				&mission.title,
				true,
				&crate::i18n::tf(
					"mission.journal.tasksRecoveredDetail",
					&[("relaunch", &to_redo.len()), ("delivered", &delivered.len())],
				),
			);
		}
	}
	recovered
}

/// Sérialise les écritures : relire, modifier, réécrire ne doit pas s'entrelacer.
///
/// Le lanceur part sur plusieurs tâches dans le même tour, et chacune rattache sa
/// session dès que son agent démarre. Sans ce verrou, deux d'entre elles
/// relisaient la fiche avant que l'autre ne l'ait écrite, et la seconde effaçait
/// le travail de la première : la tâche perdue restait « en cours » sans
/// conversation à ouvrir, indéfiniment. Le même entrelacement pouvait faire
/// réapparaître une mission qu'on venait de supprimer.
///
/// Un verrou de processus suffit : le cockpit est seul à écrire ces fichiers.
fn write_lock() -> std::sync::MutexGuard<'static, ()> {
	static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
	LOCK.get_or_init(|| std::sync::Mutex::new(()))
		.lock()
		// Un panic ailleurs ne doit pas condamner toutes les missions : l'état
		// protégé est un fichier, pas une structure à moitié modifiée.
		.unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Applique un changement et horodate la mission.
fn update(id: &str, change: impl FnOnce(&mut Mission)) -> Result<Mission> {
	let _guard = write_lock();
	let mut mission = get(id)?;
	change(&mut mission);
	mission.updated_at = now();
	save(&mission)?;
	Ok(mission)
}

/// Une tâche déjà connue n'est pas recréée par un nouveau plan : redéclarer le
/// plan en cours de mission (ajouter un lot oublié, par exemple) ne doit pas
/// remettre à zéro le travail déjà fait sur les tâches qui survivent au
/// replan — reprises, checkpoint, verdict, session à reprendre, branche
/// réelle. C'était le trou par lequel un plafond de trois reprises s'est vidé
/// en plein milieu d'une correction, sans qu'aucune alerte ne parte.
///
/// Seul ce que le maître a le droit de reformuler — rôle, titre, consigne,
/// périmètre, base — change ; le reste part de l'existant, jamais du nouveau
/// plan. Une tâche dont l'identifiant n'existait pas encore passe telle
/// quelle : c'est une tâche neuve.
fn preserve_progress(existing: &[Task], incoming: Vec<Task>) -> Vec<Task> {
	incoming
		.into_iter()
		.map(|task| match existing.iter().find(|present| present.id == task.id) {
			Some(existant) => Task {
				role: task.role,
				title: task.title,
				brief: task.brief,
				scope: task.scope,
				base: task.base,
				..existant.clone()
			},
			None => task,
		})
		.collect()
}

/// Enregistre le plan du maître et le soumet à approbation.
///
/// Le passage par `AwaitingApproval` n'est pas décoratif : c'est le seul moment
/// où l'on peut corriger un découpage avant qu'il ne coûte des agents.
pub fn submit_plan(id: &str, plan: &str, mut tasks: Vec<Task>) -> Result<Mission> {
	plan_allowed(&get(id)?)?;
	let plan = plan.trim().to_string();
	// Une tâche sans identifiant est introuvable : on ne peut ni la marquer
	// lancée, ni lui rattacher sa session. Le lanceur la reverrait « à faire » à
	// chaque tour et repartirait dessus indéfiniment. On les nomme donc ici,
	// quelle que soit la voie par laquelle le plan arrive.
	for task in &mut tasks {
		if task.id.trim().is_empty() {
			task.id = identifier();
		}
	}
	let mission = update(id, |mission| {
		if mission.guided {
			mission.split.push(Draft {
				text: plan.clone(),
				questions: Vec::new(),
				submitted_at: now(),
				review: None,
			});
		}
		mission.plan = plan;
		mission.tasks = preserve_progress(&mission.tasks, tasks);
		mission.state = MissionState::AwaitingApproval;
	})?;
	crate::journal::record(
		"mission",
		&crate::i18n::t("mission.journal.planSubmitted"),
		&mission.title,
		true,
		&crate::i18n::tf("mission.journal.planSubmittedDetail", &[("count", &mission.tasks.len())]),
	);
	Ok(mission)
}

pub fn approve(id: &str) -> Result<Mission> {
	let mission = update(id, |mission| {
		mission.state = MissionState::Running;
		// Le chronomètre part ici, pas à l'ouverture : entre les deux il peut
		// s'écouler une nuit, qui ne dit rien de ce que la mission a coûté.
		if mission.started_at.is_none() {
			mission.started_at = Some(now());
		}
	})?;
	crate::journal::record("mission", &crate::i18n::t("mission.journal.planApproved"), &mission.title, true, "");
	Ok(mission)
}

impl MissionState {
	/// Un humain doit décider avant que rien ne reparte.
	pub fn awaits_human(self) -> bool {
		matches!(
			self,
			MissionState::AwaitingUnderstanding
				| MissionState::AwaitingApproach
				| MissionState::AwaitingApproval
		)
	}

	/// Des exécutants peuvent tourner. Avant, rien ne part — quel que soit
	/// celui qui le demande, maître compris.
	pub fn executes(self) -> bool {
		matches!(self, MissionState::Running | MissionState::Integrating)
	}
}

/// Une mission guidée ne découpe qu'une fois son approche validée.
///
/// Le maître pressé saute volontiers d'une lecture à un découpage ; c'est
/// précisément le raccourci que le parcours guidé existe pour fermer. Une fois
/// le découpage en route, redéclarer un plan reste permis — ajouter un lot
/// oublié en cours d'exécution — et le fait repasser par un accord.
pub fn plan_allowed(mission: &Mission) -> Result<()> {
	if !mission.guided {
		return Ok(());
	}
	match mission.state {
		MissionState::Understanding | MissionState::AwaitingUnderstanding => Err(CockpitError::msg(
			"Your understanding of the ticket is not approved yet: call `understand`, then \
			 wait for the user's approval. The breakdown comes after the approach.",
		)),
		MissionState::Approaching | MissionState::AwaitingApproach => Err(CockpitError::msg(
			"Your approach is not approved yet: call `approach`, then wait for the user's \
			 approval before splitting the work.",
		)),
		_ => Ok(()),
	}
}

/// Refuse une proposition illisible avant qu'un humain ait à la lire.
///
/// Pur, pour se tester sans disque. Le plafond de lignes se double d'un
/// plafond de caractères : dix lignes de quatre cents signes ne sont plus dix
/// lignes, et c'est le premier contournement qu'un modèle trouve.
pub fn check_draft(step: Step, text: &str, questions: &[String]) -> Result<()> {
	let text = text.trim();
	if text.is_empty() {
		return Err(CockpitError::msg(format!(
			"An empty {} commits no one.",
			step.protocol_label()
		)));
	}
	if let Some(max) = step.max_lines() {
		let lines = text.lines().filter(|line| !line.trim().is_empty()).count();
		if lines > max {
			return Err(CockpitError::msg(format!(
				"{lines} lines: the {} fits in {max} at most. Tighten it to the essentials, \
				 written for a developer discovering the ticket — details will come later.",
				step.protocol_label()
			)));
		}
		let chars = text.chars().count();
		if chars > max * 160 {
			return Err(CockpitError::msg(format!(
				"{chars} characters: lines this long cannot be read at a glance. \
				 Short sentences, one idea per line."
			)));
		}
	}
	if questions.len() > 5 {
		return Err(CockpitError::msg(
			"More than five questions: ask the ones that really change the work, and settle \
			 the rest yourself, saying so.",
		));
	}
	Ok(())
}

/// Enregistre ce que le maître propose à une étape, et le soumet à l'humain.
///
/// Seulement quand c'est son tour : une compréhension déposée pendant que
/// l'humain relit la précédente remplacerait sous ses yeux ce qu'il est en
/// train de juger.
pub fn submit_draft(id: &str, step: Step, text: &str, questions: Vec<String>) -> Result<Mission> {
	let questions: Vec<String> = questions
		.into_iter()
		.map(|question| question.trim().to_string())
		.filter(|question| !question.is_empty())
		.collect();
	check_draft(step, text, &questions)?;

	let current = get(id)?;
	if !current.guided {
		return Err(CockpitError::msg(
			"This mission is autonomous: it has no steps to approve. Submit your breakdown \
			 directly with `plan`.",
		));
	}
	if current.state != step.working() {
		return Err(CockpitError::msg(format!(
			"This is not the time for the {}: the mission is at \"{:?}\".",
			step.protocol_label(),
			current.state
		)));
	}

	let text = text.trim().to_string();
	let mission = update(id, |mission| {
		let draft = Draft {
			text,
			questions,
			submitted_at: now(),
			review: None,
		};
		match step {
			Step::Understanding => mission.understanding.push(draft),
			Step::Approach => mission.approach.push(draft),
			Step::Split => mission.split.push(draft),
		}
		mission.state = step.awaiting();
	})?;
	crate::journal::record(
		"mission",
		&crate::i18n::tf("mission.journal.proposal", &[("step", &step.label())]),
		&mission.title,
		true,
		"",
	);
	Ok(mission)
}

/// Où mène une décision humaine sur une étape. Pur.
pub fn decide(state: MissionState, step: Step, approved: bool) -> Result<MissionState> {
	if state != step.awaiting() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"mission.nothingAwaitsDecision",
			&[("step", &step.label()), ("state", &format!("{state:?}"))],
		)));
	}
	Ok(if approved {
		step.approved()
	} else {
		step.working()
	})
}

/// Valide ou corrige la dernière proposition d'une étape.
///
/// Une correction sans motif est refusée : le maître n'aurait rien pour faire
/// mieux, et reproduirait la même version.
pub fn review(
	id: &str,
	step: Step,
	approved: bool,
	feedback: &str,
	answers: Vec<String>,
) -> Result<Mission> {
	let feedback = feedback.trim().to_string();
	let answers: Vec<String> = answers.into_iter().map(|a| a.trim().to_string()).collect();
	if !approved && feedback.is_empty() && answers.iter().all(|a| a.is_empty()) {
		return Err(CockpitError::msg(crate::i18n::t("mission.correctionNeedsReason")));
	}

	let current = get(id)?;
	let next = decide(current.state, step, approved)?;
	let mission = update(id, |mission| {
		let drafts = match step {
			Step::Understanding => &mut mission.understanding,
			Step::Approach => &mut mission.approach,
			Step::Split => &mut mission.split,
		};
		if let Some(last) = drafts.last_mut() {
			if last.review.is_none() {
				last.review = Some(Review {
					approved,
					feedback,
					answers,
					at: now(),
				});
			}
		}
		mission.state = next;
		if next == MissionState::Running && mission.started_at.is_none() {
			mission.started_at = Some(now());
		}
	})?;
	crate::journal::record(
		"mission",
		&crate::i18n::tf(
			if approved { "mission.journal.stepApproved" } else { "mission.journal.stepCorrected" },
			&[("step", &step.label())],
		),
		&mission.title,
		true,
		"",
	);
	Ok(mission)
}

pub fn set_state(id: &str, state: MissionState, note: &str) -> Result<Mission> {
	let note = note.to_string();
	update(id, |mission| {
		mission.state = state;
		if !note.is_empty() {
			mission.note = note;
		}
	})
}

/// Réserve une tâche avant de la lancer : `Planned` → `Running`, et rend faux
/// si elle ne l'était plus.
///
/// Le lanceur travaille sur une copie de la mission et enchaîne deux attentes —
/// le worktree, puis le démarrage de l'agent. Sans réservation prise d'avance,
/// un second passage pendant ces attentes la verrait encore « à faire » et
/// partirait dessus une deuxième fois.
pub fn claim_task(id: &str, task_id: &str) -> Result<bool> {
	let task_id = task_id.trim().to_string();
	if task_id.is_empty() {
		return Ok(false);
	}
	let mut claimed = false;
	update(id, |mission| {
		if let Some(task) = mission
			.tasks
			.iter_mut()
			.find(|task| task.id == task_id && task.state == TaskState::Planned)
		{
			task.state = TaskState::Running;
			task.started_at = Some(now());
			task.finished_at = None;
			claimed = true;
		}
	})?;
	Ok(claimed)
}

/// Rattache la session du maître à la mission.
pub fn attach_master(id: &str, session_id: &str) -> Result<Mission> {
	let session = session_id.to_string();
	update(id, |mission| mission.master_session = Some(session.clone()))
}

/// Pose ou retire la session du maître — `None` quand on vient de le couper.
pub fn update_master_session(id: &str, session: Option<String>) -> Result<Mission> {
	update(id, |mission| mission.master_session = session.clone())
}

/// Rattache un exécutant déjà lancé à sa tâche et la marque en cours.
///
/// L'identifiant vide est refusé plutôt que deviné : c'est lui qui avait fait
/// passer des exécutants pour le maître, laissant leurs tâches éternellement
/// « à faire » — et le lanceur en relancer quatre toutes les six secondes.
pub fn attach_task(id: &str, task_id: &str, session_id: &str) -> Result<Mission> {
	let task_id = task_id.trim().to_string();
	if task_id.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("mission.taskWithoutId")));
	}
	let session = session_id.to_string();
	let mut found = false;
	let mission = update(id, |mission| {
		if let Some(task) = mission.tasks.iter_mut().find(|task| task.id == task_id) {
			task.session_id = Some(session.clone());
			task.state = TaskState::Running;
			found = true;
		}
	})?;
	if !found {
		return Err(CockpitError::msg(crate::i18n::tf("mission.unknownTask", &[("id", &task_id)])));
	}
	Ok(mission)
}

/// Note la pull request d'intégration et clôt la mission.
pub fn finish(id: &str, pr_url: &str) -> Result<Mission> {
	let pr_url = pr_url.trim().to_string();
	let mission = update(id, |mission| {
		if !pr_url.is_empty() {
			mission.pr_url = pr_url.clone();
		}
		mission.state = MissionState::Done;
		mission.finished_at = Some(now());
	})?;
	crate::journal::record("mission", &crate::i18n::t("mission.journal.closed"), &mission.title, true, &mission.pr_url);
	Ok(mission)
}

/// Enregistre le compte rendu de mission.
pub fn set_summary(id: &str, summary: &str) -> Result<Mission> {
	let summary = summary.trim().to_string();
	update(id, |mission| mission.summary = summary.clone())
}

/// Range les worktrees des tâches intégrées.
///
/// Une mission laisse autant de dossiers qu'elle a eu d'exécutants. Les ranger
/// à la fin n'est pas de la coquetterie : au bout de quelques missions, le
/// sélecteur de worktrees devient illisible et le disque s'en ressent.
///
/// On ne touche qu'aux tâches intégrées : ce qui n'a pas été fusionné contient
/// peut-être du travail que personne n'a encore lu.
pub async fn cleanup(id: &str) -> Result<Vec<String>> {
	let mission = get(id)?;
	let repo = std::path::Path::new(&mission.cwd);
	let mut removed = Vec::new();
	let mut libéré = 0u64;

	for task in &mission.tasks {
		if task.state != TaskState::Integrated || task.worktree.trim().is_empty() {
			continue;
		}
		let dossier = std::path::Path::new(&task.worktree);
		if crate::git::run_git(repo, &["worktree", "remove", &task.worktree])
			.await
			.is_ok()
		{
			removed.push(task.worktree.clone());
			continue;
		}
		// Git refuse de retirer un worktree qui contient des fichiers non
		// suivis — et `node_modules` en est un. Ce refus était jeté en silence :
		// plus un worktree pesait, moins il avait de chances d'être rangé. On ne
		// force pas pour autant (un fichier non commité serait perdu), mais on
		// reprend au moins ce qui ne se perd pas.
		libéré += crate::git::purge_rebuildable(dossier, true).await.unwrap_or(0);
	}

	// Le worktree d'intégration, que personne ne rangeait. C'est là que le
	// maître travaille, donc là qu'un `install` et un `build` ont eu lieu : le
	// plus lourd des dossiers d'une mission, et le seul qu'aucun code ne
	// touchait. On ne le supprime pas — il porte la branche de la mission — on
	// le vide de ce qu'une commande refait.
	if let Ok(Some(intégration)) = crate::git::worktree_for_branch(repo, &mission.branch).await {
		libéré += crate::git::purge_rebuildable(&intégration, true)
			.await
			.unwrap_or(0);
	}

	if !removed.is_empty() || libéré > 0 {
		crate::journal::record(
			"mission",
			&crate::i18n::t("mission.journal.worktreesCleaned"),
			&mission.title,
			true,
			&crate::i18n::tf(
				"mission.journal.worktreesCleanedDetail",
				&[
					("count", &removed.len()),
					("size", &format!("{:.1}", libéré as f64 / 1024.0 / 1024.0 / 1024.0)),
				],
			),
		);
	}
	Ok(removed)
}

/// Efface une mission et tout ce qu'elle a fait naître.
///
/// La suppression ordinaire ne retire que la fiche : branches, worktrees et
/// conversations restaient, et il fallait les traquer à la main pour repartir
/// propre. Celle-ci va au bout — c'est pourquoi elle ne s'appelle qu'après une
/// confirmation explicite, et pourquoi elle rend le détail de ce qu'elle a
/// supprimé plutôt qu'un simple succès.
///
/// La branche d'intégration est comprise : garder la branche mère d'une mission
/// supprimée ne laisse qu'un nom orphelin dont plus personne ne sait l'origine.
pub async fn purge(id: &str) -> Result<Vec<String>> {
	let mission = get(id)?;
	let repo = std::path::Path::new(&mission.cwd);
	let mut done = Vec::new();

	// La fiche s'en va d'abord, tout le reste travaille sur la copie en mémoire.
	// Le ménage git prend plusieurs secondes — retirer des worktrees, élaguer,
	// supprimer des branches — et pendant ce temps le lanceur continue son tour
	// de veille : il relisait la mission, la réécrivait au passage, et elle
	// réapparaissait dans la liste juste après avoir été supprimée. Retirée
	// d'entrée, elle n'est plus visible de personne.
	remove(id)?;

	// Les worktrees d'abord : une branche extraite quelque part ne se supprime
	// pas, git la protège tant qu'un dossier la tient.
	let mut worktrees: Vec<String> = mission
		.tasks
		.iter()
		.map(|task| task.worktree.clone())
		.filter(|path| !path.trim().is_empty())
		.collect();
	// Le worktree d'intégration n'appartient à aucune tâche, et l'oublier
	// bloquait la suppression de cette branche-là — git la protège tant qu'un
	// dossier la tient. On le retrouve par la branche qu'il porte.
	if let Ok(Some(path)) = crate::git::worktree_for_branch(repo, &mission.branch).await {
		worktrees.push(path.to_string_lossy().to_string());
	}
	worktrees.sort();
	worktrees.dedup();
	for path in &worktrees {
		if crate::git::run_git(repo, &["worktree", "remove", "--force", path])
			.await
			.is_ok()
		{
			done.push(format!("worktree {path}"));
		}
	}
	let _ = crate::git::run_git(repo, &["worktree", "prune"]).await;

	// Puis les branches — celles des tâches, puis celle d'intégration.
	let mut branches: Vec<String> = mission
		.tasks
		.iter()
		.map(|task| task.branch.clone())
		.filter(|branch| !branch.trim().is_empty())
		.collect();
	if !mission.branch.trim().is_empty() {
		branches.push(mission.branch.clone());
	}
	branches.sort();
	branches.dedup();
	for branch in branches {
		if crate::git::run_git(repo, &["branch", "-D", &branch]).await.is_ok() {
			done.push(format!("branche {branch}"));
		}
	}

	// Enfin les conversations laissées sur le disque par les exécutants : sans
	// leur worktree elles ne désignent plus rien, et c'est ce qui encombrait
	// l'écran des workspaces bien après la fin de la mission.
	for path in &worktrees {
		if crate::sessions::forget_project(path) {
			done.push(format!("conversations {path}"));
		}
	}

	// Une seconde passe : si un tour de veille parti avant la suppression a
	// réécrit la fiche entre-temps, elle repartait avec lui.
	remove(id)?;
	crate::journal::record(
		"mission",
		&crate::i18n::t("mission.journal.deleted"),
		&mission.title,
		true,
		&crate::i18n::tf("mission.journal.deletedDetail", &[("count", &done.len())]),
	);
	Ok(done)
}

/// Note d'où la prochaine relecture devra repartir.
pub fn set_checkpoint(id: &str, task_id: &str, checkpoint: &str) -> Result<Mission> {
	let task_id = task_id.to_string();
	let checkpoint = checkpoint.to_string();
	update(id, |mission| {
		if let Some(task) = mission.tasks.iter_mut().find(|task| task.id == task_id) {
			task.checkpoint = checkpoint.clone();
		}
	})
}

/// Enregistre le terrain d'une tâche, une fois son worktree créé.
pub fn set_task_worktree(id: &str, task_id: &str, worktree: &str) -> Result<Mission> {
	let task_id = task_id.to_string();
	let worktree = worktree.to_string();
	update(id, |mission| {
		if let Some(task) = mission.tasks.iter_mut().find(|task| task.id == task_id) {
			task.worktree = worktree.clone();
		}
	})
}

impl Task {
	/// Depuis combien de secondes ce passage a-t-il commencé ?
	///
	/// Rien plutôt que zéro quand la tâche n'a pas de départ : une durée inconnue
	/// ne doit pas se confondre avec une durée nulle, sur laquelle un délai de
	/// grâce se déclencherait aussitôt.
	pub fn running_seconds(&self) -> Option<i64> {
		let depuis = self.started_at.as_deref().and_then(parse_time)?;
		Some((chrono::Utc::now() - depuis).num_seconds())
	}
}

pub fn set_task_state(id: &str, task_id: &str, state: TaskState, note: &str) -> Result<Mission> {
	let task_id = task_id.to_string();
	let note = note.to_string();
	update(id, |mission| {
		if let Some(task) = mission.tasks.iter_mut().find(|task| task.id == task_id) {
			// Sortie de « en cours » : on referme le chronomètre du passage et on
			// ajoute sa durée au cumul, plutôt que de mesurer du premier départ à
			// la dernière livraison — entre les deux, une tâche reprise passe
			// l'essentiel de son temps à attendre son tour.
			if task.state == TaskState::Running && state != TaskState::Running {
				task.finished_at = Some(now());
				if let Some(depuis) = task.started_at.as_deref().and_then(parse_time) {
					let ecoule = (chrono::Utc::now() - depuis).num_seconds();
					if ecoule > 0 {
						task.worked_seconds += ecoule as u64;
					}
				}
			}
			task.state = state;
			if !note.is_empty() {
				task.note = note.clone();
			}
		}
	})
}

/// Ajoute une tâche à une mission déjà ouverte.
pub fn add_task(id: &str, mut task: Task) -> Result<Mission> {
	if task.id.trim().is_empty() {
		task.id = identifier();
	}
	update(id, |mission| {
		if task.base.trim().is_empty() {
			task.base = mission.branch.clone();
		}
		mission.tasks.push(task);
	})
}

/// Identifiant d'un ticket, quelle que soit la façon dont on le désigne.
///
/// On colle une URL depuis son navigateur bien plus souvent qu'on ne retape un
/// identifiant : `linear.app/acme/issue/NW-42/titre` doit valoir `NW-42`, et
/// `github.com/acme/repo/issues/317` valoir `317`.
pub fn ticket_reference(input: &str) -> String {
	let input = input.trim().trim_end_matches('/');
	if let Some(rest) = input.split("/issue/").nth(1) {
		return rest.split('/').next().unwrap_or(rest).to_uppercase();
	}
	if let Some(rest) = input.split("/issues/").nth(1) {
		return rest.split('/').next().unwrap_or(rest).to_string();
	}
	input.rsplit('/').next().unwrap_or(input).to_string()
}

/// Nom de branche déduit d'un ticket, quand le suivi n'en propose pas.
///
/// Le résultat doit se lire dans un `git log` : minuscules, tirets, et assez
/// court pour tenir dans une colonne de terminal.
pub fn branch_from(identifier: &str, title: &str) -> String {
	let slug: String = title
		.to_lowercase()
		.chars()
		.map(|c| if c.is_alphanumeric() { c } else { '-' })
		.collect();
	let slug = slug
		.split('-')
		.filter(|part| !part.is_empty())
		.take(5)
		.collect::<Vec<_>>()
		.join("-");

	let prefix = identifier.trim().to_lowercase();
	match (prefix.is_empty(), slug.is_empty()) {
		(true, true) => "feat/mission".to_string(),
		(true, false) => format!("feat/{slug}"),
		(false, true) => format!("feat/{prefix}"),
		(false, false) => format!("feat/{prefix}-{slug}"),
	}
}

// ─────────────────────────── Périmètres appliqués ───────────────────────────

/// Chemins où une session a le droit d'écrire, si elle appartient à une tâche.
///
/// Une consigne de périmètre dans un prompt tient tant que le modèle y pense.
/// Ici, elle ne dépend plus de lui : la demande d'écriture est examinée avant
/// d'arriver sous tes yeux, et refusée si elle sort du terrain de la tâche.
pub fn scope_of(session_id: &str) -> Option<(String, String, Vec<String>)> {
	for mission in list() {
		for task in &mission.tasks {
			if task.session_id.as_deref() == Some(session_id) && !task.scope.is_empty() {
				return Some((task.title.clone(), task.worktree.clone(), task.scope.clone()));
			}
		}
	}
	None
}

/// Vrai quand `path` tombe dans l'un des chemins autorisés.
///
/// Comparaison volontairement littérale — préfixes et `*` de fin — plutôt
/// qu'une bibliothèque de motifs : un périmètre doit se lire d'un coup d'œil
/// dans l'interface, et se vérifier de tête.
pub fn within_scope(scope: &[String], path: &str) -> bool {
	if scope.is_empty() {
		return true;
	}
	let path = path.trim_start_matches("./");
	scope.iter().any(|allowed| {
		let allowed = allowed.trim().trim_start_matches("./");
		let prefix = allowed.trim_end_matches('*').trim_end_matches('/');
		if prefix.is_empty() {
			return true;
		}
		path == prefix || path.starts_with(&format!("{prefix}/"))
	})
}

/// Le chemin d'écriture d'un agent, ramené à sa racine de travail.
///
/// Le CLI passe à `Write` et `Edit` des chemins **absolus** (son outil l'exige),
/// alors qu'un périmètre se déclare en chemins relatifs au dépôt (`apps/api/**`).
/// Comparés tels quels, aucun chemin réel ne tombait jamais dans un périmètre :
/// toute écriture d'un exécutant borné était refusée. Et un relatif comme
/// `apps/api/../web/x.ts` passait le test de préfixe sans être chez lui.
///
/// On résout donc les `.` et `..` sans toucher au disque (le fichier n'existe
/// souvent pas encore), on retire la racine, et l'on rend `None` pour tout ce
/// qui en sort. Les séparateurs Windows et la casse des lecteurs sont ramenés à
/// une seule forme.
pub fn relative_to(root: &str, path: &str) -> Option<String> {
	fn parts(raw: &str) -> (bool, Vec<String>) {
		let forward = raw.trim().replace('\\', "/");
		let absolute = forward.starts_with('/')
			|| (forward.len() >= 2 && forward.as_bytes()[1] == b':');
		let mut out: Vec<String> = Vec::new();
		for (index, part) in forward.split('/').enumerate() {
			match part {
				"" | "." => {}
				".." => {
					if matches!(out.last(), Some(last) if last != "..") {
						out.pop();
					} else {
						out.push("..".into());
					}
				}
				// `C:` et `/c/` désignent le même lecteur : la seconde est la
				// forme du conteneur sous Windows (`sandbox::container_path`).
				part if index == 0 && part.len() == 2 && part.ends_with(':') => {
					out.push(part[..1].to_ascii_lowercase());
				}
				part if absolute && out.is_empty() && part.len() == 1 => {
					out.push(part.to_ascii_lowercase());
				}
				part => out.push(part.to_string()),
			}
		}
		(absolute, out)
	}
	let same = |a: &str, b: &str| {
		if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b }
	};

	let (absolute, mut target) = parts(path);
	if absolute {
		let (_, root) = parts(root);
		if root.is_empty()
			|| target.len() < root.len()
			|| !root.iter().zip(&target).all(|(a, b)| same(a, b))
		{
			return None;
		}
		target.drain(..root.len());
	}
	if target.iter().any(|part| part == "..") {
		return None;
	}
	Some(target.join("/"))
}

/// `within_scope`, pour un chemin tel que l'agent l'écrit, depuis `root`.
///
/// Un chemin qui sort de la racine est hors périmètre dès qu'il y en a un :
/// un exécutant borné n'écrit pas hors de son worktree.
pub fn within_scope_at(root: &str, scope: &[String], path: &str) -> bool {
	if scope.is_empty() {
		return true;
	}
	match relative_to(root, path) {
		Some(relative) => within_scope(scope, &relative),
		None => false,
	}
}

/// Chemins qu'un appel d'outil s'apprête à écrire.
///
/// On ne cherche pas à comprendre une ligne de commande : `Bash` reste hors
/// périmètre par nature, et c'est à l'humain de trancher. Ce garde-fou vise ce
/// qu'on peut lire sans ambiguïté — les écritures de fichiers.
pub fn written_paths(tool: &str, input: &serde_json::Value) -> Vec<String> {
	let field = |key: &str| {
		input
			.get(key)
			.and_then(|value| value.as_str())
			.map(|value| value.to_string())
	};
	match tool {
		"Write" | "Edit" | "NotebookEdit" => field("file_path").into_iter().collect(),
		_ => Vec::new(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn task(state: TaskState) -> Task {
		Task {
			id: "t".into(),
			role: "backend".into(),
			title: "Faire".into(),
			brief: String::new(),
			scope: Vec::new(),
			base: "integration".into(),
			branch: "b".into(),
			worktree: String::new(),
			session_id: None,
			engine_session: String::new(),
			verdict: String::new(),
			actual_branch: String::new(),
			state,
			note: String::new(),
			attempts: 0,
			reproaches: Vec::new(),
			started_at: None,
			finished_at: None,
			checkpoint: String::new(),
			worked_seconds: 0,
			gate: Gate::None,
			gate_output: String::new(),
		}
	}

	fn mission(tasks: Vec<Task>, state: MissionState) -> Mission {
		Mission {
			id: "m".into(),
			title: "Mission".into(),
			ticket: String::new(),
			ticket_url: String::new(),
			branch: "integration".into(),
			base: String::new(),
			cwd: String::new(),
			master_session: None,
			state,
			plan: String::new(),
			guided: false,
			understanding: Vec::new(),
			approach: Vec::new(),
			split: Vec::new(),
			pr_url: String::new(),
			summary: String::new(),
			note: String::new(),
			paused: false,
			started_at: None,
			finished_at: None,
			tasks,
			created_at: now(),
			updated_at: now(),
		}
	}

	/// Recette et relecture jugent le travail des autres : elles n'ont rien à
	/// lire tant que l'implémentation n'a pas livré. Lancées en même temps
	/// qu'elle, elles rendaient un compte rendu sur une branche vide.
	#[test]
	fn la_verification_attend_l_implementation() {
		let verifie = |role: &str| role == "qa";

		let qa = |state| Task { role: "qa".into(), ..task(state) };

		// Un backend qui travaille encore : la recette ne part pas.
		let en_cours = mission(
			vec![task(TaskState::Running), qa(TaskState::Planned)],
			MissionState::Running,
		);
		assert!(!en_cours.implementation_done(verifie));

		// Une fois livrée, elle peut juger.
		let livree = mission(
			vec![task(TaskState::Delivered), qa(TaskState::Planned)],
			MissionState::Running,
		);
		assert!(livree.implementation_done(verifie));

		// Un échec ne bloque pas indéfiniment : mieux vaut une recette qui dit
		// ce qui manque qu'une mission arrêtée sans le dire.
		let echouee = mission(
			vec![task(TaskState::Failed), qa(TaskState::Planned)],
			MissionState::Running,
		);
		assert!(echouee.implementation_done(verifie));

		// Une recette encore à faire ne s'attend pas elle-même.
		let seule = mission(vec![qa(TaskState::Planned)], MissionState::Running);
		assert!(seule.implementation_done(verifie));
	}

	/// Une reprise borne le nombre d'allers-retours : sans plafond, une recette
	/// qui refuse et un correctif qui ne convainc pas se renverraient la balle
	/// indéfiniment, chaque tour coûtant deux agents.
	#[test]
	fn la_reprise_finit_par_rendre_la_main() {
		let mut task = task(TaskState::Delivered);
		task.attempts = MAX_ATTEMPTS;
		let epuisee = mission(vec![task], MissionState::Running);

		let reste = epuisee
			.tasks
			.first()
			.map(|task| MAX_ATTEMPTS.saturating_sub(task.attempts));
		assert_eq!(reste, Some(0), "le plafond doit être atteint");
	}

	/// Livrer n'est pas intégrer : tant que rien n'est recomposé, la mission
	/// n'est qu'à mi-chemin, quel que soit le nombre d'exécutants qui ont fini.
	#[test]
	fn livrer_ne_vaut_que_la_moitie() {
		let all_delivered = mission(
			vec![task(TaskState::Delivered), task(TaskState::Delivered)],
			MissionState::Running,
		);
		assert_eq!(all_delivered.progress(), 50);

		let all_integrated = mission(
			vec![task(TaskState::Integrated), task(TaskState::Integrated)],
			MissionState::Integrating,
		);
		assert_eq!(all_integrated.progress(), 100);

		let mixed = mission(
			vec![task(TaskState::Integrated), task(TaskState::Planned)],
			MissionState::Running,
		);
		assert_eq!(mixed.progress(), 50);
	}

	/// Une URL collée depuis le navigateur vaut un identifiant tapé à la main.
	#[test]
	fn on_reconnait_un_ticket_a_son_adresse() {
		assert_eq!(
			ticket_reference("https://linear.app/acme/issue/NW-42/facturation-a-l-usage"),
			"NW-42"
		);
		assert_eq!(
			ticket_reference("https://github.com/acme/produit/issues/317"),
			"317"
		);
		assert_eq!(ticket_reference("  NW-42  "), "NW-42");
	}

	/// La branche déduite doit rester lisible dans un `git log`.
	#[test]
	fn la_branche_se_deduit_du_ticket() {
		assert!(branch_from("NW-42", "Facturation à l'usage").starts_with("feat/nw-42-"));
		// Sans titre exploitable, l'identifiant suffit.
		assert_eq!(branch_from("NW-42", "???"), "feat/nw-42");
	}

	/// Le périmètre est une frontière, pas une suggestion : ce qui est dehors
	/// est dehors, y compris ce qui y ressemble.
	#[test]
	fn le_perimetre_tient() {
		let scope = vec!["apps/api/**".to_string(), "packages/core".to_string()];
		assert!(within_scope(&scope, "apps/api/src/main.rs"));
		assert!(within_scope(&scope, "packages/core/index.ts"));
		assert!(!within_scope(&scope, "apps/web/page.tsx"));
		// Un dossier qui commence pareil n'est pas le même dossier.
		assert!(!within_scope(&scope, "apps/api-legacy/main.rs"));
		// Sans périmètre déclaré, rien n'est refusé — l'exception est assumée.
		assert!(within_scope(&[], "n/importe/quoi.rs"));
	}

	/// Le CLI écrit en chemins absolus : c'est la forme qui compte, pas celle
	/// des tests ci-dessus.
	#[test]
	fn le_perimetre_tient_sur_les_chemins_absolus_du_cli() {
		let scope = vec!["apps/api/**".to_string()];
		let root = "/Users/a/wt/feat-x";
		assert!(within_scope_at(root, &scope, "/Users/a/wt/feat-x/apps/api/src/main.rs"));
		assert!(within_scope_at(root, &scope, "apps/api/src/main.rs"));
		assert!(!within_scope_at(root, &scope, "/Users/a/wt/feat-x/apps/web/page.tsx"));
		// Un worktree voisin qui commence pareil n'est pas le même.
		assert!(!within_scope_at(root, &scope, "/Users/a/wt/feat-x-2/apps/api/main.rs"));
		// Hors du worktree, même dans un dossier qui porte le même nom.
		assert!(!within_scope_at(root, &scope, "/tmp/apps/api/main.rs"));
	}

	#[test]
	fn on_ne_sort_pas_du_perimetre_par_les_points() {
		let scope = vec!["apps/api".to_string()];
		let root = "/Users/a/wt/feat-x";
		assert!(!within_scope_at(root, &scope, "apps/api/../web/page.tsx"));
		assert!(!within_scope_at(root, &scope, "/Users/a/wt/feat-x/apps/api/../../../etc/x"));
		assert!(!within_scope_at(root, &scope, "../feat-y/apps/api/main.rs"));
		assert!(within_scope_at(root, &scope, "./apps/api/./src/../lib.rs"));
	}

	#[test]
	fn les_formes_windows_se_rejoignent() {
		let scope = vec!["apps/api".to_string()];
		let root = r"C:\Users\a\wt\feat-x";
		assert!(within_scope_at(root, &scope, r"C:\Users\a\wt\feat-x\apps\api\main.rs"));
		assert!(within_scope_at(root, &scope, "c:/Users/a/wt/feat-x/apps/api/main.rs"));
		// La forme vue depuis un conteneur (`sandbox::container_path`).
		assert!(within_scope_at(root, &scope, "/c/Users/a/wt/feat-x/apps/api/main.rs"));
		assert!(!within_scope_at(root, &scope, r"D:\Users\a\wt\feat-x\apps\api\main.rs"));
	}

	#[test]
	fn sans_perimetre_tout_reste_permis() {
		assert!(within_scope_at("/r", &[], "/ailleurs/x.rs"));
	}

	/// Seules les écritures de fichiers se vérifient sans ambiguïté.
	#[test]
	fn on_ne_devine_pas_ce_qu_une_commande_ecrit() {
		let input = serde_json::json!({ "file_path": "apps/api/main.rs" });
		assert_eq!(written_paths("Write", &input), vec!["apps/api/main.rs"]);
		assert!(written_paths("Bash", &serde_json::json!({ "command": "rm -rf /" })).is_empty());
		assert!(written_paths("Read", &input).is_empty());
	}

	/// Une mission à l'étude n'est pas immobile : son plan est un premier pas.
	#[test]
	fn une_mission_sans_tache_avance_quand_meme() {
		assert_eq!(mission(Vec::new(), MissionState::Planning).progress(), 5);
		assert_eq!(
			mission(Vec::new(), MissionState::AwaitingApproval).progress(),
			15
		);
	}
}

/// Ce qu'une mission coûte, d'après celles qui lui ressemblent.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "MissionEstimate"))]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
	/// Missions closes sur lesquelles l'estimation s'appuie.
	pub sample: usize,
	/// Temps de travail cumulé des exécutants, médiane des comparables.
	#[cfg_attr(test, ts(type = "number"))]
	pub median_seconds: u64,
	/// Le même temps rapporté à une tâche : ce qui permet d'extrapoler quand le
	/// découpage proposé n'a pas la taille des précédents.
	#[cfg_attr(test, ts(type = "number"))]
	pub median_seconds_per_task: u64,
	/// Estimation pour le découpage proposé.
	#[cfg_attr(test, ts(type = "number"))]
	pub expected_seconds: u64,
	/// Part des comparables qui se sont soldées par un échec.
	pub failure_rate: f32,
	/// Vrai quand l'échantillon est trop mince pour qu'on s'y fie.
	pub thin: bool,
}

/// Médiane d'une série déjà triée ; 0 si la série est vide.
fn median(values: &[u64]) -> u64 {
	if values.is_empty() {
		return 0;
	}
	let middle = values.len() / 2;
	if values.len() % 2 == 1 {
		values[middle]
	} else {
		(values[middle - 1] + values[middle]) / 2
	}
}

/// Ce que coûtera vraisemblablement une mission de `task_count` tâches.
///
/// On mesure le temps de travail cumulé des exécutants plutôt que les jetons :
/// c'est la seule grandeur que la mission garde elle-même, donc la seule qui
/// survive au rangement des worktrees et aux trente jours de l'historique de
/// consommation. Une mission close il y a six mois reste comparable.
///
/// La médiane, pas la moyenne : une mission qui a déraillé une nuit entière
/// tirerait une moyenne vers le haut au point de rendre l'estimation inutile,
/// alors qu'elle ne dit rien de la prochaine.
pub fn estimate(task_count: usize) -> Estimate {
	let closes: Vec<Mission> = list()
		.into_iter()
		.filter(|mission| matches!(mission.state, MissionState::Done | MissionState::Failed))
		.filter(|mission| !mission.tasks.is_empty())
		.collect();

	// Une mission ne se compare qu'aux découpages de taille voisine : trois
	// tâches et douze tâches ne racontent pas la même histoire.
	let proches: Vec<&Mission> = closes
		.iter()
		.filter(|mission| {
			task_count == 0 || mission.tasks.len().abs_diff(task_count) <= 2
		})
		.collect();
	let retenues: Vec<&Mission> = if proches.len() >= 3 {
		proches
	} else {
		closes.iter().collect()
	};

	let mut totaux: Vec<u64> = retenues
		.iter()
		.map(|mission| mission.tasks.iter().map(|task| task.worked_seconds).sum())
		.collect();
	totaux.sort_unstable();

	let mut par_tache: Vec<u64> = retenues
		.iter()
		.filter(|mission| !mission.tasks.is_empty())
		.map(|mission| {
			let total: u64 = mission.tasks.iter().map(|task| task.worked_seconds).sum();
			total / mission.tasks.len() as u64
		})
		.collect();
	par_tache.sort_unstable();

	let echecs = retenues
		.iter()
		.filter(|mission| matches!(mission.state, MissionState::Failed))
		.count();

	let median_total = median(&totaux);
	let median_tache = median(&par_tache);
	Estimate {
		sample: retenues.len(),
		median_seconds: median_total,
		median_seconds_per_task: median_tache,
		// Le découpage proposé prime sur la taille des missions passées : c'est
		// lui qu'on est en train de décider d'approuver.
		expected_seconds: if task_count > 0 {
			median_tache * task_count as u64
		} else {
			median_total
		},
		failure_rate: if retenues.is_empty() {
			0.0
		} else {
			echecs as f32 / retenues.len() as f32
		},
		thin: retenues.len() < 3,
	}
}

#[cfg(test)]
mod estimate_tests {
	use super::*;

	#[test]
	fn mediane_ignore_les_extremes() {
		assert_eq!(median(&[10, 20, 30]), 20);
		assert_eq!(median(&[10, 20, 30, 1_000_000]), 25);
		assert_eq!(median(&[]), 0);
	}

	#[test]
	fn sans_historique_l_estimation_se_declare_mince() {
		// Aucune mission close sur ce poste de test : on ne prétend rien.
		let estimation = estimate(3);
		assert!(estimation.thin || estimation.sample >= 3);
	}
}

/// Ce que les missions déjà closes ont appris, en quelques lignes.
///
/// Le maître repart de zéro à chaque fois : il redécoupe sans savoir que la
/// recette a échoué trois fois faute d'exécutant rattaché, ni que deux rôles
/// lancés sur le même dossier se sont gênés. Ces erreurs coûtent une mission
/// entière et se répètent, alors qu'elles sont écrites noir sur blanc dans les
/// notes des tâches échouées.
///
/// Court exprès : on ne lui donne pas un historique à lire, mais les quelques
/// faits qui changent un découpage. Vide quand rien n'a encore été mené à
/// terme — un maître sans passé vaut mieux qu'un passé inventé.
pub fn lessons(limit: usize) -> String {
	let closes: Vec<Mission> = list()
		.into_iter()
		.filter(|mission| matches!(mission.state, MissionState::Done | MissionState::Failed))
		.filter(|mission| !mission.tasks.is_empty())
		.take(limit)
		.collect();
	if closes.is_empty() {
		return String::new();
	}

	let mut lignes = Vec::new();
	for mission in &closes {
		let roles: Vec<&str> = mission
			.tasks
			.iter()
			.map(|task| task.role.as_str())
			.collect::<std::collections::BTreeSet<_>>()
			.into_iter()
			.collect();
		let reprises = mission.tasks.iter().filter(|task| task.attempts > 0).count();
		let issue = match mission.state {
			MissionState::Failed => "abandoned",
			_ => "delivered",
		};
		lignes.push(format!(
			"- \"{title}\" — {count} tasks ({roles}), {issue}{reprises}",
			title = mission.title,
			count = mission.tasks.len(),
			roles = roles.join(", "),
			issue = issue,
			reprises = if reprises > 0 {
				format!(", {reprises} rework(s)")
			} else {
				String::new()
			},
		));
	}

	// Les motifs d'échec, dédoublonnés : c'est là qu'est l'enseignement, pas
	// dans le décompte des missions.
	let mut motifs: Vec<String> = Vec::new();
	for mission in &closes {
		for task in &mission.tasks {
			if !matches!(task.state, TaskState::Failed) {
				continue;
			}
			let note = task.note.trim();
			if note.is_empty() {
				continue;
			}
			let motif = format!("- {} ({}) : {}", task.title, task.role, note);
			if !motifs.contains(&motif) {
				motifs.push(motif);
			}
		}
	}

	let mut texte = format!("Missions already carried out on this repository:\n{}", lignes.join("\n"));
	if !motifs.is_empty() {
		texte.push_str("\n\nWhat failed, and why:\n");
		texte.push_str(&motifs.join("\n"));
		texte.push_str(
			"\n\nThese are not instructions: they are facts. \
			 It is up to you to judge what they change in your breakdown.",
		);
	}
	texte
}

#[cfg(test)]
mod lessons_tests {
	use super::*;

	#[test]
	fn sans_mission_close_on_ne_dit_rien() {
		// Mieux vaut le silence qu'une section vide dans le prompt du maître.
		let texte = lessons(5);
		assert!(texte.is_empty() || texte.starts_with("Missions already carried out"));
	}
}

/// Note la branche réellement utilisée par un exécutant qui a dérivé.
pub fn set_task_actual_branch(id: &str, task_id: &str, branch: &str) -> Result<Mission> {
	let task_id = task_id.trim().to_string();
	let branch = branch.trim().to_string();
	update(id, |mission| {
		if let Some(task) = mission.tasks.iter_mut().find(|task| task.id == task_id) {
			task.actual_branch = branch.clone();
		}
	})
}

/// La branche qui porte le travail d'une tâche : la sienne, ou celle où elle a
/// dérivé.
pub fn working_branch(task: &Task) -> &str {
	if task.actual_branch.trim().is_empty() {
		task.branch.trim()
	} else {
		task.actual_branch.trim()
	}
}

/// Retient la conversation du moteur pour une tâche, avant qu'on la coupe.
pub fn set_task_verdict(id: &str, task_id: &str, verdict: Verdict) -> Result<Mission> {
	update(id, |mission| {
		if let Some(task) = mission.tasks.iter_mut().find(|task| task.id == task_id) {
			task.verdict = verdict.as_str().to_string();
		}
	})
}

pub fn set_task_engine_session(id: &str, task_id: &str, session: &str) -> Result<Mission> {
	let task_id = task_id.trim().to_string();
	let session = session.trim().to_string();
	update(id, |mission| {
		if let Some(task) = mission.tasks.iter_mut().find(|task| task.id == task_id) {
			task.engine_session = session.clone();
		}
	})
}

/// Pourquoi une tâche prête ne partira jamais, s'il y a une raison.
///
/// Le lanceur retient une tâche dont la base désigne une sœur tant que celle-ci
/// n'a pas livré. C'est juste tant que la sœur peut encore livrer ; ça devient
/// une attente sans fin quand elle a épuisé ses reprises, et un piège quand la
/// base ne désigne aucune tâche du plan — le maître a écrit un nom de branche
/// qui n'existe pas, et personne ne s'en aperçoit. Dans les deux cas la mission
/// restait « en cours » pour toujours, avec une tâche à faire que rien ne
/// faisait.
pub fn blocking_reason(mission: &Mission, task: &Task) -> Option<String> {
	let base = task.base.trim();
	if base.is_empty() || base == mission.branch.trim() {
		return None;
	}
	let soeurs: Vec<&Task> = mission
		.tasks
		.iter()
		.filter(|other| other.id != task.id && other.branch.trim() == base)
		.collect();

	if soeurs.is_empty() {
		return Some(crate::i18n::tf("mission.blocked.unknownBase", &[("base", &base)]));
	}
	if soeurs.iter().any(|soeur| {
		matches!(soeur.state, TaskState::Delivered | TaskState::Integrated)
	}) {
		return None;
	}
	if soeurs
		.iter()
		.all(|soeur| matches!(soeur.state, TaskState::Failed) && soeur.attempts >= MAX_ATTEMPTS)
	{
		return Some(crate::i18n::tf("mission.blocked.baseExhausted", &[("base", &base)]));
	}
	None
}

#[cfg(test)]
pub(crate) mod blocking_tests {
	use super::*;

	pub(crate) fn mission_test(tasks: Vec<Task>) -> Mission {
		Mission {
			id: "m".into(),
			title: "Test".into(),
			ticket: String::new(),
			ticket_url: String::new(),
			branch: "integration".into(),
			base: String::new(),
			cwd: String::new(),
			master_session: None,
			state: MissionState::Running,
			plan: String::new(),
			guided: false,
			understanding: Vec::new(),
			approach: Vec::new(),
			split: Vec::new(),
			pr_url: String::new(),
			summary: String::new(),
			note: String::new(),
			paused: false,
			started_at: None,
			finished_at: None,
			tasks,
			created_at: String::new(),
			updated_at: String::new(),
		}
	}

	pub(crate) fn tache(
		id: &str,
		branch: &str,
		base: &str,
		state: TaskState,
		attempts: u32,
	) -> Task {
		Task {
			id: id.into(),
			role: "backend".into(),
			title: id.into(),
			brief: String::new(),
			scope: Vec::new(),
			base: base.into(),
			branch: branch.into(),
			worktree: String::new(),
			session_id: None,
			engine_session: String::new(),
			verdict: String::new(),
			actual_branch: String::new(),
			state,
			note: String::new(),
			attempts,
			reproaches: Vec::new(),
			started_at: None,
			finished_at: None,
			checkpoint: String::new(),
			worked_seconds: 0,
			gate: Gate::None,
			gate_output: String::new(),
		}
	}

	#[test]
	fn un_replan_garde_la_progression_d_une_tache_connue() {
		let existant = vec![Task {
			attempts: 2,
			checkpoint: "sha=abc123".into(),
			verdict: "blocking".into(),
			engine_session: "claude-session-xyz".into(),
			branch: "fix/vraie-branche".into(),
			state: TaskState::Delivered,
			..tache("a", "fix/vraie-branche", "main", TaskState::Delivered, 2)
		}];
		let nouveau = vec![Task {
			role: "backend".into(),
			title: "Titre reformulé par le maître".into(),
			brief: "Nouvelle consigne".into(),
			// Le maître ne connaît pas la vraie branche à ce stade — champ
			// jamais rempli par lui, donc vide dans ce qu'il soumet.
			branch: String::new(),
			attempts: 0,
			checkpoint: String::new(),
			state: TaskState::Planned,
			..tache("a", "", "main", TaskState::Planned, 0)
		}];

		let resultat = preserve_progress(&existant, nouveau);

		assert_eq!(resultat.len(), 1);
		let tache = &resultat[0];
		// Reformulé par le maître : pris du nouveau plan.
		assert_eq!(tache.title, "Titre reformulé par le maître");
		assert_eq!(tache.brief, "Nouvelle consigne");
		// Progression réelle : jamais écrasée par le replan.
		assert_eq!(tache.attempts, 2);
		assert_eq!(tache.checkpoint, "sha=abc123");
		assert_eq!(tache.verdict, "blocking");
		assert_eq!(tache.engine_session, "claude-session-xyz");
		assert_eq!(tache.branch, "fix/vraie-branche");
		assert_eq!(tache.state, TaskState::Delivered);
	}

	#[test]
	fn un_replan_laisse_passer_une_tache_neuve_telle_quelle() {
		let existant = vec![tache("a", "fix/existant", "main", TaskState::Delivered, 1)];
		let neuve = tache("b", "", "main", TaskState::Planned, 0);

		let resultat = preserve_progress(&existant, vec![neuve.clone()]);

		assert_eq!(resultat.len(), 1);
		assert_eq!(resultat[0].id, "b");
		assert_eq!(resultat[0].state, TaskState::Planned);
		assert_eq!(resultat[0].attempts, 0);
	}

	#[test]
	fn une_soeur_qui_peut_encore_livrer_ne_bloque_pas() {
		let mission = mission_test(vec![
			tache("a", "feat-a", "", TaskState::Running, 0),
			tache("b", "feat-b", "feat-a", TaskState::Planned, 0),
		]);
		assert!(blocking_reason(&mission, &mission.tasks[1]).is_none());
	}

	#[test]
	fn une_soeur_a_bout_de_reprises_bloque_pour_de_bon() {
		let mission = mission_test(vec![
			tache("a", "feat-a", "", TaskState::Failed, MAX_ATTEMPTS),
			tache("b", "feat-b", "feat-a", TaskState::Planned, 0),
		]);
		let raison = blocking_reason(&mission, &mission.tasks[1]);
		assert!(raison.is_some_and(|texte| texte.contains("used up its reworks")));
	}

	#[test]
	fn une_base_qui_ne_designe_rien_bloque() {
		let mission = mission_test(vec![tache(
			"b",
			"feat-b",
			"branche-inventee",
			TaskState::Planned,
			0,
		)]);
		let raison = blocking_reason(&mission, &mission.tasks[0]);
		assert!(raison.is_some_and(|texte| texte.contains("any task")));
	}

	#[test]
	fn une_soeur_livree_libere_la_suite() {
		let mission = mission_test(vec![
			tache("a", "feat-a", "", TaskState::Delivered, 0),
			tache("b", "feat-b", "feat-a", TaskState::Planned, 0),
		]);
		assert!(blocking_reason(&mission, &mission.tasks[1]).is_none());
	}

	#[test]
	fn partir_de_l_integration_ne_bloque_jamais() {
		let mission = mission_test(vec![tache(
			"a",
			"feat-a",
			"integration",
			TaskState::Planned,
			0,
		)]);
		assert!(blocking_reason(&mission, &mission.tasks[0]).is_none());
	}
}

/// Ce qui n'est pas dans la branche d'intégration au moment d'ouvrir la PR.
///
/// Clore une mission, c'est déclarer que son travail est dans une pull request.
/// Or rien ne vérifiait que les branches y étaient : une tâche encore en cours,
/// ou livrée mais jamais fusionnée, laissait ses commits dehors — et la mission
/// passait `Done`, disparaissait des écrans, et ses worktrees étaient rangés.
/// Le travail existait toujours, sur une branche que plus rien ne nommait.
///
/// Les tâches abandonnées ne comptent pas : leur sort a été tranché.
pub fn unintegrated(mission: &Mission) -> Vec<&Task> {
	mission
		.tasks
		.iter()
		.filter(|task| {
			matches!(
				task.state,
				TaskState::Planned | TaskState::Running | TaskState::Delivered
			)
		})
		.collect()
}

#[cfg(test)]
mod unintegrated_tests {
	use super::{blocking_tests::*, *};

	#[test]
	fn tout_integre_laisse_passer() {
		let mission = mission_test(vec![
			tache("a", "feat-a", "", TaskState::Integrated, 0),
			tache("b", "feat-b", "", TaskState::Failed, 3),
		]);
		assert!(unintegrated(&mission).is_empty());
	}

	#[test]
	fn une_tache_livree_mais_non_fusionnee_retient() {
		// Le cas qui coûtait le plus cher : le travail est fait, la branche
		// existe, et la mission se refermait dessus.
		let mission = mission_test(vec![tache("a", "feat-a", "", TaskState::Delivered, 0)]);
		assert_eq!(unintegrated(&mission).len(), 1);
	}

	#[test]
	fn une_tache_encore_en_cours_retient() {
		let mission = mission_test(vec![tache("a", "feat-a", "", TaskState::Running, 0)]);
		assert_eq!(unintegrated(&mission).len(), 1);
	}
}

#[cfg(test)]
mod working_branch_tests {
	use super::{blocking_tests::*, *};

	#[test]
	fn sans_derive_c_est_la_branche_de_la_tache() {
		let task = tache("a", "feat-a", "", TaskState::Delivered, 0);
		assert_eq!(working_branch(&task), "feat-a");
	}

	#[test]
	fn avec_derive_c_est_celle_qui_porte_le_travail() {
		// Le cas qui coûtait le plus cher : l'intégration fusionnait `feat-a`,
		// vide, et refermait la mission sur du code resté sur `fix/autre`.
		let mut task = tache("a", "feat-a", "", TaskState::Delivered, 0);
		task.actual_branch = "fix/autre".into();
		assert_eq!(working_branch(&task), "fix/autre");
	}

	#[test]
	fn une_derive_en_blanc_ne_compte_pas() {
		let mut task = tache("a", "feat-a", "", TaskState::Delivered, 0);
		task.actual_branch = "   ".into();
		assert_eq!(working_branch(&task), "feat-a");
	}
}

/// Ce qu'une vérification a conclu.
///
/// Une recette termine son rapport par une ligne de verdict. Jusqu'ici ce mot
/// ne s'adressait qu'au maître : lui seul le lisait, et lui seul décidait d'en
/// tenir compte. Un maître distrait — ou coupé au mauvais moment — enterrait
/// donc un « bloquant » sans que rien ne s'y oppose, et la pull request
/// s'ouvrait sur un défaut que quelqu'un avait pourtant vu et nommé.
///
/// Le verdict est maintenant lu par le cockpit lui-même. Ce n'est plus une
/// parole entre deux agents, c'est un état de la mission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
	/// Cela ne doit pas partir en l'état.
	Blocking,
	/// Cela peut partir, mais quelque chose devra être repris.
	Reserves,
	/// Rien à redire.
	Ok,
	/// Elle a rendu sa copie, et l'on n'a pas su lire ce qu'elle en concluait.
	///
	/// Quatrième valeur, sur le modèle de `properties.rs` et de l'oracle de la
	/// Permanence : sans elle, une vérification qui n'a rien conclu se lit
	/// exactement comme une vérification qui n'a rien trouvé. C'est le pire des
	/// modes de défaillance — il transforme une panne en succès — et c'est
	/// précisément ce qui s'est produit ici pendant des semaines.
	///
	/// Jamais rendue par [`read_verdict`], qui lit ce qui est écrit : posée en
	/// aval, quand une vérification est livrée sans conclusion lisible.
	Undecided,
}

impl Verdict {
	pub fn as_str(self) -> &'static str {
		match self {
			Verdict::Blocking => "blocking",
			Verdict::Reserves => "reserves",
			Verdict::Ok => "ok",
			Verdict::Undecided => "undecided",
		}
	}

	pub fn parse(raw: &str) -> Option<Verdict> {
		match raw.trim() {
			"blocking" => Some(Verdict::Blocking),
			"reserves" => Some(Verdict::Reserves),
			"ok" => Some(Verdict::Ok),
			"undecided" => Some(Verdict::Undecided),
			_ => None,
		}
	}
}

/// Le verdict que porte un rapport, s'il en porte un.
///
/// On lit un texte écrit par un modèle, pas un champ de formulaire : la ligne
/// arrive grasse, encadrée de backticks, en majuscules, traduite, ou noyée au
/// milieu du rapport quand la consigne demandait la fin. Le cockpit doit
/// marcher avec le moteur du jour comme avec le suivant, et aucun d'eux ne
/// promet la ponctuation. On reconnaît donc l'intention plutôt que la forme.
///
/// Le dernier verdict énoncé l'emporte : un rapport qui rappelle la consigne
/// avant de conclure citerait les trois mots, et c'est sa conclusion qui compte.
pub fn read_verdict(rapport: &str) -> Option<Verdict> {
	let mut dernier = None;
	for ligne in rapport.lines() {
		// Tout ce qui décore : gras, titres, puces, citations, backticks.
		let nu: String = ligne
			.chars()
			.filter(|c| !matches!(c, '*' | '`' | '#' | '>' | '-' | '_' | '|'))
			.collect();
		let nu = nu.trim().to_lowercase();
		let Some(reste) = nu.strip_prefix("verdict") else {
			continue;
		};
		// Ce qui sépare le mot de sa valeur, quelle que soit la langue.
		let valeur = reste.trim_start_matches([':', '=', ' ', '\u{a0}']).trim();
		let mot = valeur.split_whitespace().next().unwrap_or("");
		// Le premier caractère suffit à trancher entre les trois, mais on reste
		// explicite : un jour il y aura un quatrième verdict.
		let lu = match mot {
			m if m.starts_with("bloqu") || m.starts_with("block") => Some(Verdict::Blocking),
			m if m.starts_with("réserve")
				|| m.starts_with("reserve")
				|| m.starts_with("concern") =>
			{
				Some(Verdict::Reserves)
			}
			m if m.starts_with("ok") || m.starts_with("pass") || m.starts_with("clean") => {
				Some(Verdict::Ok)
			}
			_ => None,
		};
		if lu.is_some() {
			dernier = lu;
		}
	}
	dernier
}

/// Les vérifications qui refusent, et que personne n'a levées.
///
/// Une recette bloquante se lève en corrigeant puis en la relançant : elle
/// rejuge et remplace son verdict. Tant qu'elle n'a pas rejugé, son refus
/// tient — c'est ce qui empêche la pull request de s'ouvrir sur un défaut
/// connu. Les tâches échouées ne comptent pas : leur abandon est déjà une
/// décision prise.
pub fn blocking_verdicts<'a>(mission: &'a Mission, verifiers: &[String]) -> Vec<&'a Task> {
	mission
		.tasks
		.iter()
		.filter(|task| verifiers.iter().any(|role| role == &task.role))
		.filter(|task| task.state != TaskState::Failed)
		.filter(|task| Verdict::parse(&task.verdict) == Some(Verdict::Blocking))
		.collect()
}

/// Les vérifications qui ont rendu sans qu'on sache ce qu'elles concluent.
///
/// Elles ne refusent pas — mais elles n'autorisent pas non plus, et c'est tout
/// l'intérêt de les compter à part. Une recette dont le rapport ne porte pas de
/// verdict lisible n'a pas validé le travail : elle a seulement fini de parler.
pub fn unclear_verdicts<'a>(mission: &'a Mission, verifiers: &[String]) -> Vec<&'a Task> {
	mission
		.tasks
		.iter()
		.filter(|task| verifiers.iter().any(|role| role == &task.role))
		.filter(|task| task.state != TaskState::Failed)
		.filter(|task| Verdict::parse(&task.verdict) == Some(Verdict::Undecided))
		.collect()
}

#[cfg(test)]
mod verdict_tests {
	use super::*;

	#[test]
	fn reconnait_la_forme_demandee() {
		assert_eq!(read_verdict("VERDICT: bloquant"), Some(Verdict::Blocking));
		assert_eq!(read_verdict("VERDICT: réserves"), Some(Verdict::Reserves));
		assert_eq!(read_verdict("VERDICT: ok"), Some(Verdict::Ok));
	}

	#[test]
	fn traverse_la_decoration() {
		// Ce qu'un moteur produit spontanément quand on lui demande une ligne.
		for ligne in [
			"**VERDICT: bloquant**",
			"`VERDICT: bloquant`",
			"## Verdict : bloquant",
			"> verdict = BLOQUANT",
			"- **Verdict** : Bloquant",
			"VERDICT:bloquant",
		] {
			assert_eq!(read_verdict(ligne), Some(Verdict::Blocking), "sur {ligne:?}");
		}
	}

	#[test]
	fn accepte_langlais() {
		// Le prompt est en français, le moteur ne l'est pas toujours.
		assert_eq!(read_verdict("VERDICT: blocking"), Some(Verdict::Blocking));
		assert_eq!(read_verdict("VERDICT: concerns"), Some(Verdict::Reserves));
		assert_eq!(read_verdict("VERDICT: pass"), Some(Verdict::Ok));
	}

	#[test]
	fn la_conclusion_lemporte_sur_le_rappel() {
		// Un rapport qui récite la consigne avant de conclure.
		let rapport = "Je dois répondre VERDICT: bloquant, VERDICT: réserves ou \
		               VERDICT: ok.\n\nAprès vérification :\n\nVERDICT: ok";
		assert_eq!(read_verdict(rapport), Some(Verdict::Ok));
	}

	#[test]
	fn se_tait_quand_rien_nest_dit() {
		assert_eq!(read_verdict("Tout me semble correct, bon travail."), None);
		assert_eq!(read_verdict(""), None);
		// Le mot sans valeur reconnaissable ne doit rien inventer.
		assert_eq!(read_verdict("VERDICT: à voir avec l'équipe"), None);
	}

	fn verifiee(role: &str, verdict: &str, state: TaskState) -> Task {
		let mut task = super::blocking_tests::tache("t", "b", "", state, 0);
		task.role = role.to_string();
		task.verdict = verdict.to_string();
		task
	}

	#[test]
	fn seules_les_vraies_vérifications_bloquent() {
		let roles = vec!["qa".to_string()];
		let mission = super::blocking_tests::mission_test(vec![
			verifiee("qa", "blocking", TaskState::Delivered),
			verifiee("qa", "ok", TaskState::Delivered),
			// Un exécutant qui bavarde n'est pas un juge.
			verifiee("backend", "blocking", TaskState::Delivered),
			// Une vérification abandonnée : la décision est déjà prise.
			verifiee("qa", "blocking", TaskState::Failed),
		]);
		assert_eq!(blocking_verdicts(&mission, &roles).len(), 1);
	}

	#[test]
	fn lindécidable_ne_bloque_pas_mais_ne_valide_pas() {
		let roles = vec!["qa".to_string()];
		let mission = super::blocking_tests::mission_test(vec![verifiee(
			"qa",
			"undecided",
			TaskState::Delivered,
		)]);
		// Ce n'est pas un refus…
		assert!(blocking_verdicts(&mission, &roles).is_empty());
		// …mais ce n'est surtout pas un accord.
		assert_eq!(unclear_verdicts(&mission, &roles).len(), 1);
	}

	#[test]
	fn une_vérification_qui_a_conclu_nest_jamais_indécise() {
		let roles = vec!["qa".to_string()];
		for conclusion in ["ok", "reserves", "blocking"] {
			let mission = super::blocking_tests::mission_test(vec![verifiee(
				"qa",
				conclusion,
				TaskState::Delivered,
			)]);
			assert!(
				unclear_verdicts(&mission, &roles).is_empty(),
				"« {conclusion} » est une conclusion"
			);
		}
	}

	#[test]
	fn lindécidable_survit_à_lécriture_et_à_la_relecture() {
		// Le verdict voyage en texte jusque dans la fiche de mission : une
		// valeur qui ne se relit pas se lirait comme une absence de verdict,
		// c'est-à-dire comme un accord.
		assert_eq!(
			Verdict::parse(Verdict::Undecided.as_str()),
			Some(Verdict::Undecided)
		);
	}

	#[test]
	fn lindécidable_ne_sinvente_pas_à_la_lecture_dun_rapport() {
		// `read_verdict` lit ce qui est écrit. L'indécidable est posé par qui
		// constate l'absence, jamais deviné dans un texte.
		assert_eq!(read_verdict("Tout est en ordre, rien à signaler."), None);
	}
}

/// Une tâche qui déborde nettement de ce qu'une tâche coûte d'ordinaire.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "MissionOverrun"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overrun {
	pub mission_id: String,
	pub mission_title: String,
	pub task_id: String,
	pub title: String,
	/// Temps de travail du passage en cours, en secondes.
	#[cfg_attr(test, ts(type = "number"))]
	pub seconds: u64,
	/// Ce qu'une tâche coûte d'ordinaire, sur les missions closes.
	#[cfg_attr(test, ts(type = "number"))]
	pub expected: u64,
}

/// Combien de fois le repère il faut dépasser avant qu'on le dise.
///
/// Une tâche prend le temps qu'elle prend, et l'estimation est une médiane, pas
/// une promesse : alerter au moindre écart ferait du bruit sur la moitié des
/// tâches, par construction. Trois fois le repère ne s'explique plus par la
/// variété des sujets.
const OVERRUN_FACTOR: u64 = 3;

/// En deçà, on ne dit rien.
///
/// Un historique de missions courtes donne un repère de quelques minutes, et le
/// triple d'un petit nombre reste un petit nombre : sans ce plancher, une tâche
/// signalait un dépassement avant d'avoir eu le temps de lire son énoncé.
const OVERRUN_FLOOR: u64 = 45 * 60;

/// Les tâches en cours qui débordent, et de combien.
///
/// On ne regarde que ce qui tourne encore : une tâche livrée a coûté ce qu'elle
/// a coûté, le dire n'ouvre aucune décision. Une tâche qui tourne, elle, peut
/// être reprise, redécoupée, ou coupée — et c'est à qui pilote d'en juger, pas
/// au cockpit de trancher en tuant l'agent.
pub fn overruns(mission: &Mission, expected: u64) -> Vec<Overrun> {
	let seuil = (expected * OVERRUN_FACTOR).max(OVERRUN_FLOOR);
	if expected == 0 {
		return Vec::new();
	}
	mission
		.tasks
		.iter()
		.filter(|task| task.state == TaskState::Running)
		.filter_map(|task| {
			let seconds = task.running_seconds().unwrap_or(0).max(0) as u64;
			(seconds > seuil).then(|| Overrun {
				mission_id: mission.id.clone(),
				mission_title: mission.title.clone(),
				task_id: task.id.clone(),
				title: task.title.clone(),
				seconds,
				expected,
			})
		})
		.collect()
}

#[cfg(test)]
mod overrun_tests {
	use super::*;

	fn en_cours(depuis_secondes: i64) -> Task {
		let mut task = super::blocking_tests::tache("t", "b", "", TaskState::Running, 0);
		task.started_at = Some(
			(chrono::Utc::now() - chrono::Duration::seconds(depuis_secondes)).to_rfc3339(),
		);
		task
	}

	#[test]
	fn se_tait_sans_reperes() {
		// Aucune mission close : on n'a rien à quoi comparer, et une alerte
		// inventée vaut moins que pas d'alerte du tout.
		let mission = super::blocking_tests::mission_test(vec![en_cours(10 * 3600)]);
		assert!(overruns(&mission, 0).is_empty());
	}

	#[test]
	fn le_plancher_protege_les_missions_courtes() {
		// Repère de 5 minutes : le triple ferait 15 minutes, ce qui ne veut rien
		// dire. Le plancher tient.
		let mission = super::blocking_tests::mission_test(vec![en_cours(20 * 60)]);
		assert!(overruns(&mission, 5 * 60).is_empty());
	}

	#[test]
	fn signale_ce_qui_deborde_vraiment() {
		let mission = super::blocking_tests::mission_test(vec![en_cours(7 * 3600)]);
		let debordent = overruns(&mission, 3600);
		assert_eq!(debordent.len(), 1);
		assert!(debordent[0].seconds >= 7 * 3600);
	}

	#[test]
	fn ne_juge_que_ce_qui_tourne_encore() {
		// Une tâche livrée a coûté ce qu'elle a coûté : le dire n'ouvre rien.
		let mut rendue = en_cours(9 * 3600);
		rendue.state = TaskState::Delivered;
		let mission = super::blocking_tests::mission_test(vec![rendue]);
		assert!(overruns(&mission, 3600).is_empty());
	}
}

/// Ce qui déborde, sur l'ensemble des missions en cours.
///
/// Le repère se calcule une fois, sur l'historique commun : demander son
/// estimation à chaque mission relirait tous les fichiers autant de fois, pour
/// un chiffre qui ne change pas d'une mission à l'autre.
pub fn all_overruns() -> Vec<Overrun> {
	let repere = estimate(0).median_seconds_per_task;
	if repere == 0 {
		return Vec::new();
	}
	list()
		.iter()
		.filter(|mission| mission.state == MissionState::Running && !mission.paused)
		.flat_map(|mission| overruns(mission, repere))
		.collect()
}

#[cfg(test)]
mod parcours_guide {
	use super::*;

	fn guided(state: MissionState) -> Mission {
		Mission {
			id: "m".into(),
			title: "Mission".into(),
			ticket: String::new(),
			ticket_url: String::new(),
			branch: "integration".into(),
			base: String::new(),
			cwd: String::new(),
			master_session: None,
			state,
			plan: String::new(),
			guided: true,
			understanding: Vec::new(),
			approach: Vec::new(),
			split: Vec::new(),
			pr_url: String::new(),
			summary: String::new(),
			note: String::new(),
			paused: false,
			started_at: None,
			finished_at: None,
			tasks: Vec::new(),
			created_at: now(),
			updated_at: now(),
		}
	}

	/// Onze lignes ne sont plus une synthèse : le cockpit la refuse avant
	/// qu'un humain ait à la lire, quoi que le modèle ait retenu de sa consigne.
	#[test]
	fn une_comprehension_tient_en_dix_lignes() {
		let dix = (1..=10).map(|n| format!("ligne {n}")).collect::<Vec<_>>().join("\n");
		assert!(check_draft(Step::Understanding, &dix, &[]).is_ok());

		let onze = format!("{dix}\nune de trop");
		assert!(check_draft(Step::Understanding, &onze, &[]).is_err());

		// Les lignes vides ne comptent pas : aérer n'est pas bavarder.
		let aere = dix.replace('\n', "\n\n");
		assert!(check_draft(Step::Understanding, &aere, &[]).is_ok());
	}

	/// Le contournement évident — trois lignes de mille signes — est fermé.
	#[test]
	fn des_lignes_fleuves_ne_passent_pas() {
		let fleuve = "x".repeat(2000);
		assert!(check_draft(Step::Understanding, &fleuve, &[]).is_err());
	}

	#[test]
	fn une_proposition_vide_ou_trop_de_questions_est_refusee() {
		assert!(check_draft(Step::Approach, "   ", &[]).is_err());
		let questions: Vec<String> = (0..6).map(|n| format!("q{n}")).collect();
		assert!(check_draft(Step::Understanding, "ok", &questions).is_err());
	}

	/// L'ordre des accords : compréhension, approche, découpage, exécution.
	/// Une correction ramène le maître à la même étape, jamais en avant.
	#[test]
	fn les_accords_s_enchainent_dans_l_ordre() {
		use MissionState::*;
		assert_eq!(
			decide(AwaitingUnderstanding, Step::Understanding, true).unwrap(),
			Approaching
		);
		assert_eq!(
			decide(AwaitingUnderstanding, Step::Understanding, false).unwrap(),
			Understanding
		);
		assert_eq!(decide(AwaitingApproach, Step::Approach, true).unwrap(), Planning);
		assert_eq!(decide(AwaitingApproval, Step::Split, true).unwrap(), Running);
		assert_eq!(decide(AwaitingApproval, Step::Split, false).unwrap(), Planning);
	}

	/// Valider une étape qui n'attend rien — double clic, écran en retard —
	/// ne doit rien faire avancer.
	#[test]
	fn on_ne_valide_que_ce_qui_attend() {
		use MissionState::*;
		assert!(decide(Understanding, Step::Understanding, true).is_err());
		assert!(decide(AwaitingUnderstanding, Step::Approach, true).is_err());
		assert!(decide(Running, Step::Split, true).is_err());
	}

	/// Le raccourci que le parcours existe pour fermer : lire puis découper.
	#[test]
	fn pas_de_decoupage_avant_l_approche() {
		use MissionState::*;
		for state in [Understanding, AwaitingUnderstanding, Approaching, AwaitingApproach] {
			assert!(plan_allowed(&guided(state)).is_err(), "{state:?}");
		}
		for state in [Planning, AwaitingApproval, Running] {
			assert!(plan_allowed(&guided(state)).is_ok(), "{state:?}");
		}
		// Une mission autonome découpe quand elle veut : c'est son contrat.
		let mut autonome = guided(Understanding);
		autonome.guided = false;
		assert!(plan_allowed(&autonome).is_ok());
	}

	/// Rien ne part avant le dernier accord.
	#[test]
	fn aucun_executant_avant_l_accord() {
		use MissionState::*;
		for state in [
			Understanding,
			AwaitingUnderstanding,
			Approaching,
			AwaitingApproach,
			Planning,
			AwaitingApproval,
		] {
			assert!(!state.executes(), "{state:?}");
		}
		assert!(Running.executes());
		assert!(Integrating.executes());
		assert!(!guided(Approaching).can_launch());
		assert!(guided(Running).can_launch());
	}
}
