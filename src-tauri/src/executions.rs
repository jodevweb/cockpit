//! Ce que chaque agent a fait, relevé par le cockpit et non par son moteur.
//!
//! Le cockpit savait lancer et savait voir en direct ; il ne savait pas
//! raconter après coup. Les états d'une mission s'écrasent en place, le journal
//! est un carnet de mille lignes, et la seule vraie timeline — celle de l'écran
//! Agents — est relue dans les fichiers de Claude Code. Conséquence : un agent
//! Codex ou Gemini ne laissait **rien** derrière lui une fois le cockpit fermé,
//! et personne ne pouvait dire ce qu'une tâche avait coûté ni combien de fois
//! elle avait été reprise.
//!
//! ## Un journal, pas un objet qu'on met à jour
//!
//! Rien n'est jamais modifié sur place ici. Une exécution est une **suite
//! d'enregistrements** ([`Entry`]) écrits au fil de l'eau : l'ouverture, les
//! tours rendus, la conversation du moteur quand il l'annonce, les étapes de sa
//! vie. L'état courant ([`Execution`]) est **dérivé** de cette suite par
//! [`fold`], jamais stocké.
//!
//! C'est ce qui distingue ce module du reste de la persistance du cockpit, où
//! un JSON se réécrit en entier : une trace qu'on récrit est une trace qui peut
//! mentir, et c'est précisément le défaut qu'on vient corriger. Écrire en ajout
//! a trois conséquences qu'on assume : le même fait peut être noté deux fois
//! (le repli tranche), une exécution dont la fin n'a jamais été écrite reste
//! ouverte — ce qui est une information juste, refermée au démarrage suivant —
//! et l'ordre des lignes est celui du temps réel.
//!
//! ## Exécution et session sont deux choses
//!
//! [`Execution::id`] identifie **un lancement**. [`Execution::session_id`] est
//! la session du cockpit (`agent-<hex>`), qui sert à recoller avec
//! `Task::session_id`, `Mission::master_session` et les demandes
//! d'autorisation. Elles coïncident presque toujours aujourd'hui ; les
//! confondre interdirait pourtant de représenter ce qui vient — une session
//! reprise, rejouée, ou reprise sous un autre moteur.
//!
//! ## Les moteurs ne racontent pas la même chose
//!
//! Claude Code annonce ses jetons et une valorisation ; `codex-exec` ne dit
//! aucun coût ; `gemini-stream-json` ne dit qu'un total. Ces écarts sont des
//! écarts **d'instrumentation**, jamais d'activité : un tour dont le coût n'est
//! pas annoncé se compte dans [`CostTotal::unknown_turns`] et jamais comme un
//! coût nul, sans quoi le moteur le plus discret passerait un jour pour le plus
//! économe. Voir [`Observability`], qui existe pour que cette différence puisse
//! se dire au lieu de se déduire.
//!
//! ## Deux fichiers, deux raisons
//!
//! - `executions/index.jsonl` — tous les enregistrements de toutes les
//!   exécutions. Un index unique existe parce que les deux usages qui
//!   justifient ce module — la timeline d'une mission et la comparaison entre
//!   moteurs — veulent *toutes* les exécutions : les obtenir en ouvrant deux
//!   mille fichiers est exactement ce qu'on regretterait.
//! - `executions/<AAAA-MM-JJ>/<id>.jsonl` — le détail des événements d'une
//!   exécution. Ce fichier n'existe pas encore ; le dossier est déjà celui où
//!   il ira, et [`sweep`] sait déjà le ranger.

use crate::config::config_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Version du format. Les champs se rajoutent avec `#[serde(default)]` — le
/// précédent est le champ `actor` de `journal.rs`, et son test dédié.
pub const V: u32 = 1;

/// Au-delà, une exécution ne se relit plus.
const KEEP_DAYS: i64 = 30;
/// Et une seule journée de missions en produit des centaines.
const KEEP_MAX: usize = 2000;

/// Au-delà, un texte pèse plus qu'il n'apprend à qui relit.
const MAX_TEXT: usize = 8_000;
/// L'entrée d'un outil décrit un appel ; elle n'a pas à le rejouer.
const MAX_INPUT: usize = 2_000;
/// Une sortie d'outil se compte en mégaoctets — un `cat` sur un fichier de
/// données, un test verbeux. On en garde de quoi reconnaître, et on dit la
/// taille réelle plutôt que de faire croire qu'il n'y avait que ça.
const MAX_EXCERPT: usize = 2_000;
/// Ce qu'un agent emballé ne doit pas pouvoir dépasser entre deux ménages.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// Un maître de mission, quand c'est lui qui a lancé l'exécutant.
pub const MASTER: &str = "master";
/// Le cockpit lui-même, quand une de ses boucles relance ce que personne n'a
/// redemandé — une mission reprise au démarrage, une tâche devenue lançable,
/// une intégration ranimée.
///
/// Le distinguer d'un geste humain n'est pas un détail : sans lui, « qui a
/// relancé ce maître à trois heures du matin ? » n'a pas de réponse, et un
/// acteur choisi par défaut y répondrait faux.
pub const COCKPIT: &str = "cockpit";

// ───────────────────────────── Ce qui ne bouge pas ─────────────────────────────

/// Pourquoi cet agent a été lancé, et pour le compte de qui.
///
/// Groupé plutôt qu'égrené en paramètres : `start_with_mission` porte déjà douze
/// arguments et un `#[allow(clippy::too_many_arguments)]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Origin {
	/// [`crate::journal::HUMAN`], [`crate::journal::PERMANENCE`] ou [`MASTER`].
	///
	/// L'acteur se passe explicitement, jamais par un contexte ambiant : la
	/// Permanence agit pendant qu'on clique ailleurs, et un acteur global
	/// finirait par signer les gestes de quelqu'un d'autre. Même règle, et même
	/// raison, que `journal::record_as`.
	pub actor: String,
	/// L'engagement de la Permanence à l'origine du lancement, s'il y en a un.
	pub engagement: String,
	/// Rôle du catalogue (`master`, `backend`, `qa`…). Vide hors mission.
	pub role: String,
	/// Tâche de la mission. Vide pour un maître ou un lancement à la main.
	pub task: String,
	/// `Task::attempts` au moment du lancement : 0 au premier passage. C'est ce
	/// qui distingue trois reprises d'une même tâche, là où le compteur seul les
	/// confondait.
	pub attempt: u32,
}

impl Origin {
	pub fn human() -> Self {
		Origin {
			actor: crate::journal::HUMAN.to_string(),
			..Default::default()
		}
	}

	pub fn permanence(engagement: &str) -> Self {
		Origin {
			actor: crate::journal::PERMANENCE.to_string(),
			engagement: engagement.to_string(),
			..Default::default()
		}
	}

	/// Une boucle de fond du cockpit, avec le rôle qu'elle relance.
	pub fn cockpit(role: &str) -> Self {
		Origin {
			actor: COCKPIT.to_string(),
			role: role.to_string(),
			..Default::default()
		}
	}

	pub fn master(role: &str, task: &str, attempt: u32) -> Self {
		Origin {
			actor: MASTER.to_string(),
			role: role.to_string(),
			task: task.to_string(),
			attempt,
			..Default::default()
		}
	}
}

/// Ce qu'on sait d'une exécution au moment où elle part, et qui ne changera
/// plus. Écrit une fois, dans l'enregistrement d'ouverture.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Opening {
	/// Session du cockpit — voir la doc du module.
	pub session_id: String,
	pub protocol: String,
	pub engine: String,
	pub engine_label: String,
	/// Modèle demandé au lancement — souvent un alias, parfois vide quand on
	/// laisse le CLI appliquer le réglage du poste.
	pub model: String,
	pub mission: String,
	pub origin: Origin,
	pub cwd: String,
	/// Projet actif au lancement, relevé **une seule fois** : `Config::load()`
	/// relit et reparse le TOML à chaque appel, ce qui est correct à une action
	/// et ruineux à chaque enregistrement.
	pub project: String,
	pub sandboxed: bool,
}

// ───────────────────────────── Le cycle de vie ─────────────────────────────

/// Ce que le cockpit sait de source sûre, parce que c'est lui qui l'a fait.
///
/// Distinct des événements d'un moteur, qui eux se traduisent et se perdent
/// parfois : ces étapes-là ne dépendent d'aucun protocole et sont vraies pour
/// les trois. Volontairement peu nombreuses — une étape qu'on ne saurait pas
/// produire de façon fiable vaudrait moins que son absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
	/// Un process de plus a été lancé pour la même exécution — c'est le cas de
	/// `codex-exec`, qui relance à chaque tour au lieu de tenir son entrée
	/// ouverte. N'est pas une fin.
	Resumed,
	/// Au moins un tour rendu, puis fin normale du flux.
	Answered,
	/// Dernier tour marqué en erreur par le moteur lui-même.
	Failed,
	/// Le flux s'est fermé sans qu'aucun tour n'ait été annoncé fini — image
	/// absente, binaire introuvable dans un conteneur, dossier refusé. C'est le
	/// cas que `agent::spawn_reader` journalise déjà, faute de quoi la raison
	/// disparaissait avec le process.
	LostAtLaunch,
	/// Coupé d'un geste : arrêt manuel, fermeture du cockpit, arrêt d'urgence.
	Stopped,
	/// Retrouvée ouverte au démarrage suivant : le cockpit a été tué avant
	/// d'avoir pu clore, et ce process ne nous appartient plus.
	Orphaned,
	/// Le cockpit s'est fermé, l'agent a continué dans son relais (`relay.rs`).
	/// N'est pas une fin : c'est même tout le contraire.
	Detached,
	/// Un cockpit a retrouvé l'agent vivant et reprend sa lecture.
	Reattached,
}

impl Step {
	/// Une étape qui termine l'exécution. `Resumed` est la seule qui ne le fait
	/// pas — et c'est tout l'intérêt de la distinguer.
	pub fn is_final(&self) -> bool {
		!matches!(self, Step::Resumed | Step::Detached | Step::Reattached)
	}
}

/// L'état d'une exécution, dérivé de ses étapes.
///
/// La **première** étape finale l'emporte, jamais la dernière : un agent coupé
/// à la main dont le flux se ferme ensuite a été arrêté, il n'est pas « mort au
/// lancement ». Les deux enregistrements existent, la lecture tranche.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
	#[default]
	Running,
	Answered,
	Failed,
	LostAtLaunch,
	Stopped,
	Orphaned,
}


impl From<Step> for Outcome {
	fn from(step: Step) -> Self {
		match step {
			Step::Resumed | Step::Detached | Step::Reattached => Outcome::Running,
			Step::Answered => Outcome::Answered,
			Step::Failed => Outcome::Failed,
			Step::LostAtLaunch => Outcome::LostAtLaunch,
			Step::Stopped => Outcome::Stopped,
			Step::Orphaned => Outcome::Orphaned,
		}
	}
}

// ───────────────────────────── Le coût ─────────────────────────────

/// D'où vient un chiffre de coût — et s'il en existe un.
///
/// Un `f64` seul serait ambigu : zéro voudrait dire à la fois « gratuit » et
/// « le moteur n'a rien dit », et une estimation se lirait comme une dépense.
/// La variante porte donc la nature **et** la provenance, ce qui rend la
/// confusion impossible plutôt qu'improbable.
///
/// Aucune de ces valeurs n'est une facture : sur un abonnement rien n'est
/// débité, c'est le quota de la fenêtre qui se consomme. Même mise en garde que
/// `agent::OneShot::cost_usd`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "basis", rename_all = "camelCase")]
pub enum Cost {
	/// Le moteur a annoncé lui-même ce que ce tour vaut.
	Reported { usd: f64 },
	/// Calculé par le cockpit depuis une table de tarifs. Personne n'en produit
	/// encore : la variante existe pour que la table, quand elle arrivera, n'ait
	/// pas à se déguiser en chiffre annoncé.
	Estimated { usd: f64, table: String },
	/// Ni annoncé, ni estimable. Ce n'est pas zéro.
	Unknown,
}

/// Ce qu'une exécution a coûté, sans jamais mélanger les natures.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CostTotal {
	pub reported_usd: f64,
	pub estimated_usd: f64,
	/// Tours dont le coût n'est ni annoncé ni estimé. Les compter à part est ce
	/// qui empêche de prendre un moteur discret pour un moteur économe.
	pub unknown_turns: u32,
}

impl CostTotal {
	fn add(&mut self, cost: Cost) {
		match cost {
			Cost::Reported { usd } => self.reported_usd += usd,
			Cost::Estimated { usd, .. } => self.estimated_usd += usd,
			Cost::Unknown => self.unknown_turns += 1,
		}
	}
}

/// Ce qu'un tour a consommé, tel que le moteur l'annonce.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Turn {
	pub input_tokens: u64,
	pub output_tokens: u64,
	pub cache_tokens: u64,
	/// Absent quand le moteur ne dit rien — voir [`Cost`].
	pub cost: Option<Cost>,
}

/// Le cumul d'une exécution.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Tally {
	pub turns: u32,
	pub input_tokens: u64,
	pub output_tokens: u64,
	pub cache_tokens: u64,
	pub cost: CostTotal,
}

// ───────────────────── Ce que chaque moteur sait raconter ─────────────────────

/// Ce qu'un protocole est capable d'annoncer.
///
/// Existe pour une seule raison : qu'un silence puisse se lire comme un silence.
/// Sans cette table, un jour, quelqu'un comparera deux moteurs et conclura que
/// l'un travaille moins parce qu'il rapporte moins — alors qu'il rapporte
/// seulement autre chose. Rien ne la consomme encore ; elle est ici pour que la
/// distinction existe dans le modèle avant d'exister à l'écran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observability {
	/// Le moteur chiffre lui-même ce que vaut un tour.
	pub reports_cost: bool,
	/// Il découpe ses jetons entre entrée, sortie et cache.
	pub reports_token_split: bool,
	/// Il rend ce que ses outils ont répondu.
	pub reports_tool_results: bool,
	/// Il publie son raisonnement.
	pub reports_thinking: bool,
	/// Il sait reprendre une conversation.
	pub resumable: bool,
}


// ───────────────────────── Les enregistrements ─────────────────────────

/// Un fait, daté, rattaché à une exécution. Une ligne du journal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
	pub v: u32,
	pub execution_id: String,
	pub at: String,
	#[serde(flatten)]
	pub record: Record,
}

// Un enregistrement vit le temps d'écrire ou de relire une ligne du registre :
// la place perdue par les petites variantes ne s'accumule nulle part.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "record", rename_all = "camelCase")]
pub enum Record {
	/// Le lancement, avec tout ce qui ne changera plus.
	Opened { opening: Opening },
	/// Une étape du cycle de vie, connue du cockpit lui-même.
	Life { step: Step, note: String },
	/// Un tour rendu, et ce qu'il a consommé.
	Turn { turn: Turn },
	/// La conversation du moteur, dès qu'il l'annonce : la session chez Claude
	/// Code, le fil chez Codex, rien chez Gemini.
	EngineSession { marker: String },
	/// Un modèle vu à l'œuvre dans cette exécution.
	///
	/// Distinct de `Opening::model`, qui dit ce qu'on a **demandé** — souvent un
	/// alias, et vide dans la plupart des lancements, où l'on laisse le CLI
	/// appliquer le réglage du poste. Celui-ci dit qui a réellement travaillé,
	/// et il y en a parfois plusieurs : un sous-agent, une reprise, une
	/// compaction n'emploient pas forcément le modèle du fil principal.
	Model { model: String },
	/// Le verdict qu'une vérification vient d'énoncer, saisi au vol.
	///
	/// Relevé ici plutôt que relu après coup dans le fichier du moteur : ce
	/// fichier-là est écrit par un tiers, vit dans un worktree qu'on supprime, et
	/// n'existe pas du tout pour un agent isolé du point de vue de l'hôte. Le
	/// verdict, lui, est ce que le cockpit a entendu de ses propres oreilles.
	Verdict { verdict: String },
	/// Le détail de cette exécution a buté sur son plafond, et voici combien
	/// d'événements ne sont pas retenus.
	///
	/// Noté dans l'index et non dans le fichier tronqué : c'est justement
	/// l'endroit où l'on n'écrit plus. Une timeline amputée qui ne le dit pas
	/// est pire qu'une timeline absente.
	Trimmed { dropped: u64 },
}

/// L'état d'une exécution à un instant, reconstitué depuis ses enregistrements.
/// Jamais écrit tel quel sur le disque.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
	pub id: String,
	pub started_at: String,
	pub ended_at: String,
	#[serde(flatten)]
	pub opening: Opening,
	pub engine_session: String,
	/// Les modèles vus à l'œuvre, dans l'ordre où ils sont apparus.
	///
	/// Vide pour une exécution antérieure à ce relevé, ou pour un moteur qui
	/// n'annonce pas son modèle — ce qui n'est pas la même chose que « aucun
	/// modèle », et se lit dans `observability`.
	#[serde(default)]
	pub models: Vec<String>,
	/// Ce que cette exécution a conclu, quand elle conclut quelque chose.
	///
	/// Vide dans l'immense majorité des cas : seule une vérification énonce un
	/// verdict. Le dernier énoncé l'emporte — une recette reprise rejuge, et
	/// c'est son nouveau jugement qui compte.
	#[serde(default)]
	pub verdict: String,
	pub outcome: Outcome,
	pub tally: Tally,
	/// Ce qui a été dit de la fin, quand il y a quelque chose à en dire.
	pub note: String,
	/// Événements que le plafond du détail a fait tomber. Zéro dans le cas
	/// ordinaire.
	pub events_dropped: u64,
	/// La vie de cette exécution, dans l'ordre — c'est elle qu'on raconte.
	pub steps: Vec<Moment>,
	/// Ce que son moteur sait annoncer, pour que ses silences se lisent.
	pub observability: Observability,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
	pub at: String,
	pub step: Step,
	pub note: String,
}

// ─────────────────────── Le détail d'une exécution ───────────────────────

/// Ce qu'un agent a fait, dit dans les mots du cockpit et non dans ceux de son
/// moteur.
///
/// Ce n'est pas un modèle idéal, c'est un **relevé** : la liste de ce qu'au
/// moins un protocole annonce avec un champ vérifié. Le reste tombe, exactement
/// comme dans `codex::to_claude_shaped` et pour la même raison — mieux vaut un
/// trou honnête qu'une donnée fabriquée.
///
/// Deux origines s'y mélangent volontairement, et c'est ce qui rend la timeline
/// lisible : ce que le **moteur** a dit, et ce que le **cockpit** a fait
/// ([`ExecEvent::Lifecycle`]). Le second est vrai pour les trois protocoles,
/// puisqu'il ne dépend d'aucun d'eux.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ExecEvent {
	/// Ce qu'on a demandé.
	Prompt { text: String },
	/// Une phrase de l'agent.
	Say { text: String },
	/// Son raisonnement, quand il le publie. Claude Code seul.
	Think { text: String },
	/// Un outil appelé. `hint` est la ligne qu'on affiche, `input` le détail
	/// borné — même découpage que `SessionEvent { text, detail }`.
	Tool {
		id: String,
		name: String,
		hint: String,
		input: String,
	},
	/// Ce que l'outil a rendu. `bytes` porte la taille réelle et `excerpt` ce
	/// qu'on en garde : une sortie tronquée doit dire qu'elle l'est.
	ToolDone {
		id: String,
		ok: bool,
		bytes: u64,
		excerpt: String,
	},
	/// Fin d'un tour, avec ce que le moteur en dit.
	TurnEnd { ok: bool, text: String },
	/// Ce que le process a écrit sur son erreur standard.
	Stderr { text: String },
	/// Une étape que le cockpit connaît de source sûre, parce que c'est lui qui
	/// l'a faite.
	Lifecycle { step: Step, note: String },
}

/// Un événement, daté. L'enveloppe porte l'instant pour que chaque variante
/// n'ait pas à le répéter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
	pub at: String,
	#[serde(flatten)]
	pub event: ExecEvent,
}

/// Traduit la forme de Claude Code — celle que tous les protocoles atteignent
/// avant d'être émis (`codex::to_claude_shaped`, `gemini::to_claude_shaped`) —
/// vers le relevé du cockpit.
///
/// **Un seul traducteur, volontairement.** Écrire un `to_cockpit` par protocole
/// reviendrait à traduire deux fois la même chose : le flux est déjà ramené à
/// une forme commune pour l'écran, et journaliser autre chose que ce que l'écran
/// montre serait la meilleure façon de faire diverger les deux. Le jour où un
/// moteur annoncera, avec un champ vérifié, quelque chose que la forme de Claude
/// ne sait pas dire — un `file_change` de Codex, par exemple — c'est là qu'un
/// traducteur propre à lui deviendra justifié, et pas avant.
pub fn from_claude_shaped(payload: &serde_json::Value) -> Vec<ExecEvent> {
	crate::sessions::to_cockpit(payload)
}

// ───────────────────────────── Emplacements ─────────────────────────────

pub fn dir() -> PathBuf {
	config_dir().join("executions")
}

fn index_path() -> PathBuf {
	dir().join("index.jsonl")
}

/// Le dossier du jour où une exécution a commencé — `2026-08-28`.
///
/// Découpé sur la chaîne et non sur une date reparsée : un horodatage illisible
/// doit ranger son fichier quelque part plutôt que faire échouer l'écriture.
fn day_of(started_at: &str) -> String {
	let day: String = started_at.chars().take(10).collect();
	if day.len() == 10 {
		day
	} else {
		"inconnu".to_string()
	}
}

/// Où vivent les événements détaillés d'une exécution.
pub fn events_path(started_at: &str, id: &str) -> PathBuf {
	dir().join(day_of(started_at)).join(format!("{id}.jsonl"))
}

// ───────────────────────────── Écriture ─────────────────────────────

/// Le verrou de l'index, partagé par tous les agents qui écrivent dedans.
///
/// Une ligne bornée écrite en ajout tiendrait sans doute sans lui sur la
/// plupart des systèmes de fichiers ; on ne parie pas là-dessus pour un relevé
/// dont c'est la seule raison d'être. Même dispositif que `journal.rs`.
fn index_lock() -> &'static Mutex<()> {
	static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
	LOCK.get_or_init(|| Mutex::new(()))
}

fn now() -> String {
	chrono::Utc::now().to_rfc3339()
}

/// Identifiant d'exécution. Même fabrique que les sessions d'agents, préfixe
/// distinct : les deux se croisent dans les mêmes écrans, les confondre à l'œil
/// coûterait cher.
fn new_id() -> String {
	use std::time::{SystemTime, UNIX_EPOCH};
	let nanos = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);
	format!("exec-{nanos:x}")
}

/// Ajoute une ligne au journal. Silencieux en cas d'échec : ne jamais faire
/// échouer le lancement d'un agent parce que sa trace n'a pas pu s'écrire.
fn append(execution_id: &str, record: Record) {
	let entry = Entry {
		v: V,
		execution_id: execution_id.to_string(),
		at: now(),
		record,
	};
	let Ok(line) = serde_json::to_string(&entry) else {
		return;
	};
	let _ = std::fs::create_dir_all(dir());
	let _guard = index_lock().lock();
	let path = index_path();
	if let Ok(mut file) = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(&path)
	{
		let _ = writeln!(file, "{line}");
	}
	// Une trace nomme des dossiers de travail, des tâches et des branches :
	// lisible par le seul propriétaire, comme la configuration.
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
	}
}

/// Borne un texte d'agent. Un rendu qui déborde chasse ce qu'on cherchait.
pub fn clip_text(text: &str) -> String {
	clip(text, MAX_TEXT)
}

/// Borne l'entrée d'un outil : elle décrit un appel, elle ne le rejoue pas.
pub fn clip_input(text: &str) -> String {
	clip(text, MAX_INPUT)
}

/// Borne une sortie d'outil. La taille réelle voyage à côté, dans
/// [`ExecEvent::ToolDone::bytes`].
pub fn clip_excerpt(text: &str) -> String {
	clip(text, MAX_EXCERPT)
}

fn clip(text: &str, max: usize) -> String {
	let trimmed = text.trim();
	if trimmed.chars().count() <= max {
		return trimmed.to_string();
	}
	let cut: String = trimmed.chars().take(max).collect();
	format!("{cut}…")
}

/// Les fichiers de détail ouverts, un par exécution vivante.
///
/// Tenu ici et pas dans le lecteur de flux : un agent par tour (`codex-exec`)
/// rebranche un lecteur neuf à chaque tour sur la **même** exécution — un
/// fichier tenu par le lecteur serait rouvert et écraserait le précédent.
fn writers() -> &'static Mutex<HashMap<String, Detail>> {
	static WRITERS: OnceLock<Mutex<HashMap<String, Detail>>> = OnceLock::new();
	WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct Detail {
	file: std::io::BufWriter<std::fs::File>,
	written: u64,
	dropped: u64,
	/// Les modèles déjà relevés pour cette exécution.
	///
	/// Le modèle voyage dans **chaque** message du moteur : sans cette mémoire,
	/// on écrirait une ligne d'index par phrase prononcée. On n'écrit qu'au
	/// premier passage de chacun.
	models: Vec<String>,
}

/// Ouvre une exécution et rend son identifiant.
pub fn open(opening: Opening) -> String {
	let id = new_id();
	let at = now();
	append(&id, Record::Opened { opening });

	// Le fichier de détail s'ouvre avec l'exécution : c'est le seul moment où
	// l'on connaît sa date, donc son dossier.
	let path = events_path(&at, &id);
	if let Some(parent) = path.parent() {
		let _ = std::fs::create_dir_all(parent);
	}
	if let Ok(file) = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(&path)
	{
		// Une entrée d'outil porte des extraits de fichiers et des lignes de
		// commande, donc parfois un secret : lisible par son seul propriétaire.
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
		}
		writers().lock().unwrap().insert(
			id.clone(),
			Detail {
				file: std::io::BufWriter::new(file),
				written: 0,
				dropped: 0,
				models: Vec::new(),
			},
		);
	}
	id
}

/// Note ce que l'agent vient de faire.
///
/// Silencieux, borné, et sans verrou partagé entre exécutions : cette fonction
/// est appelée depuis la boucle de lecture de chaque agent, et les sérialiser
/// toutes derrière un même verrou reviendrait à faire attendre un agent parce
/// qu'un autre parle.
pub fn note_events(execution_id: &str, events: &[ExecEvent]) {
	if events.is_empty() {
		return;
	}
	let Ok(mut open) = writers().lock() else {
		return;
	};
	let Some(detail) = open.get_mut(execution_id) else {
		return;
	};
	for event in events {
		// Le plafond n'arrête pas l'agent, il arrête l'écriture : ce qui tombe
		// se compte et se dira à la clôture.
		if detail.written >= MAX_FILE_BYTES {
			detail.dropped += 1;
			continue;
		}
		let beat = Beat {
			at: now(),
			event: event.clone(),
		};
		let Ok(line) = serde_json::to_string(&beat) else {
			continue;
		};
		detail.written += line.len() as u64 + 1;
		let _ = writeln!(detail.file, "{line}");
	}
}

/// Vide le tampon sur le disque. Appelé à la fin d'un tour, pas à chaque ligne :
/// `spawn_reader` est une tâche tokio, et une écriture par événement y bloquerait
/// un fil du runtime pour un carnet.
fn flush_detail(execution_id: &str) {
	if let Ok(mut open) = writers().lock() {
		if let Some(detail) = open.get_mut(execution_id) {
			let _ = detail.file.flush();
		}
	}
}

/// Ferme le fichier de détail et dit ce qui n'a pas pu y entrer.
fn close_detail(execution_id: &str) {
	let Ok(mut open) = writers().lock() else {
		return;
	};
	let Some(mut detail) = open.remove(execution_id) else {
		return;
	};
	let _ = detail.file.flush();
	if detail.dropped > 0 {
		drop(open);
		append(
			execution_id,
			Record::Trimmed {
				dropped: detail.dropped,
			},
		);
	}
}

/// Note la conversation du moteur. Écrite telle quelle : c'est le repli qui
/// gardera la première, une conversation ne changeant pas d'identité en cours
/// de route.
pub fn mark_engine_session(execution_id: &str, marker: &str) {
	if marker.trim().is_empty() {
		return;
	}
	append(
		execution_id,
		Record::EngineSession {
			marker: marker.to_string(),
		},
	);
}

/// Note le verdict qu'un agent vient d'énoncer, s'il en énonce un.
///
/// Lu sur le message entier, **avant** la troncature du relevé : `clip_text`
/// borne chaque texte à huit mille signes pour que l'écran reste lisible, et un
/// rapport de recette dépasse souvent ce plafond. Or le verdict est sa dernière
/// ligne — précisément ce que la coupure emporte. Le relire plus tard dans le
/// détail reviendrait à chercher ce qu'on a soi-même jeté.
///
/// On relève ce qui a été dit, on ne décide de rien : qu'un verdict compte ou
/// non dépend du rôle de l'exécution, et cela se tranche en aval.
pub fn note_verdict(execution_id: &str, payload: &serde_json::Value) {
	let Some(verdict) = spoken_in_full(payload)
		.iter()
		.rev()
		// `read_verdict` découpe et minuscule chaque ligne : sur le chemin chaud
		// du flux, appelé pour tout ce que disent tous les agents, ce serait des
		// milliers d'allocations par rapport. Ce balayage-là n'en fait aucune, et
		// écarte l'immense majorité des messages, qui ne concluent rien.
		.filter(|text| mentions_verdict(text))
		.find_map(|text| crate::mission::read_verdict(text))
	else {
		return;
	};
	append(
		execution_id,
		Record::Verdict {
			verdict: verdict.as_str().to_string(),
		},
	);
}

/// Note le modèle qui vient de parler, la première fois qu'on l'entend.
///
/// `Opening::model` dit ce qu'on a demandé au lancement — un alias le plus
/// souvent, et rien du tout quand on laisse le CLI appliquer le réglage du
/// poste, ce qui est le cas ordinaire. Sans cette lecture, le relevé ne saurait
/// donc jamais **qui** a travaillé, et « quel modèle réussit quel genre de
/// travail » resterait une question qu'on ne peut pas poser.
pub fn note_model(execution_id: &str, payload: &serde_json::Value) {
	let Some(model) = payload
		.pointer("/message/model")
		.and_then(|v| v.as_str())
		.map(str::trim)
		.filter(|model| !model.is_empty())
	else {
		return;
	};
	// La mémoire du détail dit si ce modèle est nouveau ; on la relâche avant
	// d'écrire, l'index ayant son propre verrou.
	{
		let Ok(mut open) = writers().lock() else {
			return;
		};
		let Some(detail) = open.get_mut(execution_id) else {
			return;
		};
		if detail.models.iter().any(|seen| seen == model) {
			return;
		}
		detail.models.push(model.to_string());
	}
	append(
		execution_id,
		Record::Model {
			model: model.to_string(),
		},
	);
}

/// Le mot est-il quelque part dans ce texte, quelle qu'en soit la casse ?
///
/// Un simple `contains` ne suffirait pas : la consigne demande `VERDICT`, les
/// moteurs écrivent aussi bien `Verdict` que `verdict`.
fn mentions_verdict(text: &str) -> bool {
	text.as_bytes()
		.windows(b"verdict".len())
		.any(|mot| mot.eq_ignore_ascii_case(b"verdict"))
}

/// Ce qu'un agent vient de dire, en entier.
///
/// Les deux formes qui portent une conclusion : les blocs de texte d'un message
/// d'assistant, et le résumé de fin de tour. Le dialecte est celui de Claude —
/// Codex et Gemini y sont traduits avant d'arriver ici, donc cette lecture vaut
/// pour eux aussi.
fn spoken_in_full(payload: &serde_json::Value) -> Vec<String> {
	let mut said = Vec::new();
	match payload.get("type").and_then(|v| v.as_str()).unwrap_or("") {
		"assistant" => {
			let Some(items) = payload.pointer("/message/content").and_then(|v| v.as_array())
			else {
				return said;
			};
			for item in items {
				if item.get("type").and_then(|v| v.as_str()) == Some("text") {
					if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
						said.push(text.to_string());
					}
				}
			}
		}
		"result" => {
			if let Some(text) = payload.get("result").and_then(|v| v.as_str()) {
				said.push(text.to_string());
			}
		}
		_ => {}
	}
	said
}

/// Note un tour rendu, et ce que le moteur dit en avoir consommé.
pub fn note_turn(
	execution_id: &str,
	dialect: crate::protocol::Protocol,
	payload: &serde_json::Value,
) {
	append(
		execution_id,
		Record::Turn {
			turn: dialect.turn_usage(payload),
		},
	);
	flush_detail(execution_id);
}

/// Note une étape du cycle de vie.
///
/// Écrite deux fois, et c'est voulu : dans l'index, d'où l'état se dérive et où
/// les comptes se font ; dans le détail, pour qu'une timeline se lise seule sans
/// avoir à recoller deux fichiers.
pub fn note_step(execution_id: &str, step: Step, note: &str) {
	// La première ligne suffit : une erreur entière noierait le journal.
	let note: String = note.lines().next().unwrap_or_default().chars().take(300).collect();
	append(
		execution_id,
		Record::Life {
			step,
			note: note.clone(),
		},
	);
	note_events(
		execution_id,
		&[ExecEvent::Lifecycle {
			step,
			note,
		}],
	);
	if step.is_final() {
		close_detail(execution_id);
	} else {
		flush_detail(execution_id);
	}
}

// ───────────────────────────── Relecture ─────────────────────────────

/// Reconstitue l'état de chaque exécution depuis la suite de ses
/// enregistrements. C'est la seule façon de lire ce module.
pub fn fold() -> Vec<Execution> {
	let Ok(raw) = std::fs::read_to_string(index_path()) else {
		return Vec::new();
	};
	fold_raw(&raw)
}

/// Le repli lui-même, sans disque : c'est là que vivent toutes les décisions de
/// lecture, et c'est donc là qu'on peut les éprouver. Même patron que
/// `mission::blocking_reason`.
pub fn fold_raw(raw: &str) -> Vec<Execution> {
	let mut found: HashMap<String, Execution> = HashMap::new();
	// L'ordre du fichier est celui du temps : on ne trie pas avant de replier,
	// sinon une ouverture pourrait passer après ce qu'elle ouvre.
	for line in raw.lines().filter(|line| !line.trim().is_empty()) {
		let Ok(entry) = serde_json::from_str::<Entry>(line) else {
			continue;
		};
		match entry.record {
			Record::Opened { opening } => {
				// Un protocole que cette version ne connaît pas — un relevé
				// écrit par une plus récente — se lit avec les capacités du
				// protocole par défaut. Le supposer moins observable
				// produirait exactement le biais que cette table sert à
				// éviter : prendre un silence d'instrumentation pour une
				// activité moindre.
				let observability = crate::protocol::Protocol::parse(&opening.protocol)
					.unwrap_or(crate::protocol::Protocol::Claude)
					.observability();
				found.insert(
					entry.execution_id.clone(),
					Execution {
						id: entry.execution_id,
						started_at: entry.at,
						ended_at: String::new(),
						opening,
						engine_session: String::new(),
						models: Vec::new(),
						verdict: String::new(),
						outcome: Outcome::Running,
						tally: Tally::default(),
						note: String::new(),
						events_dropped: 0,
						steps: Vec::new(),
						observability,
					},
				);
			}
			// Un enregistrement sans ouverture n'a rien à quoi se rattacher :
			// c'est le signe d'un journal tronqué par le ménage, pas une erreur.
			Record::Life { step, note } => {
				if let Some(exec) = found.get_mut(&entry.execution_id) {
					if step.is_final() && exec.outcome == Outcome::Running {
						exec.outcome = step.into();
						exec.ended_at = entry.at.clone();
						exec.note = note.clone();
					}
					exec.steps.push(Moment {
						at: entry.at,
						step,
						note,
					});
				}
			}
			Record::Turn { turn } => {
				if let Some(exec) = found.get_mut(&entry.execution_id) {
					exec.tally.turns += 1;
					exec.tally.input_tokens += turn.input_tokens;
					exec.tally.output_tokens += turn.output_tokens;
					exec.tally.cache_tokens += turn.cache_tokens;
					exec.tally.cost.add(turn.cost.unwrap_or(Cost::Unknown));
				}
			}
			Record::EngineSession { marker } => {
				if let Some(exec) = found.get_mut(&entry.execution_id) {
					if exec.engine_session.is_empty() {
						exec.engine_session = marker;
					}
				}
			}
			Record::Model { model } => {
				if let Some(exec) = found.get_mut(&entry.execution_id) {
					if !exec.models.contains(&model) {
						exec.models.push(model);
					}
				}
			}
			Record::Verdict { verdict } => {
				if let Some(exec) = found.get_mut(&entry.execution_id) {
					exec.verdict = verdict;
				}
			}
			Record::Trimmed { dropped } => {
				if let Some(exec) = found.get_mut(&entry.execution_id) {
					exec.events_dropped = dropped;
				}
			}
		}
	}
	found.into_values().collect()
}

/// Toutes les exécutions connues, les plus récentes d'abord.
pub fn list(limit: usize) -> Vec<Execution> {
	let mut all = fold();
	all.sort_by(|a, b| b.started_at.cmp(&a.started_at));
	all.truncate(limit);
	all
}

/// Ce qui a tourné depuis `since`, ou tourne encore — les plus anciennes d'abord.
///
/// C'est la matière de la frise « la journée des agents » : on y veut aussi un
/// agent parti hier soir et toujours au travail, d'où les exécutions sans fin.
/// Les étapes ne voyagent pas : la frise n'en lit que le début, la fin et
/// l'issue, et une journée chargée en compterait des milliers.
pub fn since(since: chrono::DateTime<chrono::Utc>) -> Vec<Execution> {
	let mut found: Vec<Execution> = fold()
		.into_iter()
		.filter(|exec| {
			exec.ended_at.is_empty()
				|| chrono::DateTime::parse_from_rfc3339(&exec.ended_at)
					.map(|end| end.with_timezone(&chrono::Utc) >= since)
					.unwrap_or(false)
		})
		.map(|mut exec| {
			exec.steps.clear();
			exec
		})
		.collect();
	found.sort_by(|a, b| a.started_at.cmp(&b.started_at));
	found
}

/// Les exécutions d'une mission, les plus anciennes d'abord — c'est sa timeline.
pub fn for_mission(mission: &str) -> Vec<Execution> {
	let mut found: Vec<Execution> = fold()
		.into_iter()
		.filter(|exec| exec.opening.mission == mission)
		.collect();
	found.sort_by(|a, b| a.started_at.cmp(&b.started_at));
	found
}

/// Les exécutions d'un dossier de travail, les plus récentes d'abord.
///
/// C'est ce qu'un chantier a fait tourner chez lui, agents refermés compris —
/// fermer un onglet efface la conversation, pas ce qu'elle a coûté.
pub fn for_cwd(cwd: &str) -> Vec<Execution> {
	let mut found: Vec<Execution> = fold()
		.into_iter()
		.filter(|exec| crate::platform::same_path(&exec.opening.cwd, cwd))
		.collect();
	found.sort_by(|a, b| b.started_at.cmp(&a.started_at));
	found
}

/// Les exécutions d'une session du cockpit, les plus anciennes d'abord.
pub fn for_session(session_id: &str) -> Vec<Execution> {
	let mut found: Vec<Execution> = fold()
		.into_iter()
		.filter(|exec| exec.opening.session_id == session_id)
		.collect();
	found.sort_by(|a, b| a.started_at.cmp(&b.started_at));
	found
}

/// Le détail d'une exécution, dans l'ordre où il s'est produit.
pub fn timeline(execution_id: &str) -> Vec<Beat> {
	let Some(exec) = fold().into_iter().find(|exec| exec.id == execution_id) else {
		return Vec::new();
	};
	let Ok(raw) = std::fs::read_to_string(events_path(&exec.started_at, execution_id)) else {
		return Vec::new();
	};
	raw.lines()
		.filter(|line| !line.trim().is_empty())
		.filter_map(|line| serde_json::from_str::<Beat>(line).ok())
		.collect()
}

/// Le même détail, dans la forme que l'écran Agents sait déjà afficher.
///
/// C'est ce qui donne un historique à Codex et à Gemini sans écrire une ligne
/// d'interface : jusqu'ici la timeline ne venait que des fichiers de Claude
/// Code, et refermer le cockpit effaçait tout le reste.
///
/// Les correspondances sont celles de `sessions::read_timeline` — `user`,
/// `assistant`, `thinking`, `tool`, `tool-result`, `tool-error` — pour que les
/// deux sources se lisent pareil. Les étapes de cycle de vie passent en
/// `system`, puisqu'elles ne viennent d'aucun interlocuteur.
pub fn timeline_as_events(execution_id: &str) -> Vec<crate::sessions::SessionEvent> {
	timeline(execution_id)
		.into_iter()
		.enumerate()
		.map(|(index, beat)| project(index, beat))
		.collect()
}

/// La projection d'un seul événement. Détachée pour être éprouvée sans disque —
/// c'est là que vivent toutes les décisions de rendu.
fn project(index: usize, beat: Beat) -> crate::sessions::SessionEvent {
	{
		{
			let at = Some(beat.at);
			let mut event = crate::sessions::SessionEvent {
				index,
				kind: "system".into(),
				timestamp: at,
				text: String::new(),
				tool: None,
				detail: None,
				is_sidechain: false,
				model: None,
				tokens: None,
			};
			match beat.event {
				ExecEvent::Prompt { text } => {
					event.kind = "user".into();
					event.text = text;
				}
				ExecEvent::Say { text } => {
					event.kind = "assistant".into();
					event.text = text;
				}
				ExecEvent::Think { text } => {
					event.kind = "thinking".into();
					event.text = text;
				}
				ExecEvent::Tool {
					name, hint, input, ..
				} => {
					event.kind = "tool".into();
					event.text = hint;
					event.tool = Some(name);
					event.detail = Some(input);
				}
				ExecEvent::ToolDone {
					ok, bytes, excerpt, ..
				} => {
					event.kind = if ok { "tool-result" } else { "tool-error" }.into();
					event.text = excerpt;
					// La taille réelle plutôt que celle de l'extrait : une sortie
					// coupée doit dire de quoi elle a été coupée.
					event.detail = (bytes > MAX_EXCERPT as u64)
						.then(|| crate::i18n::tf("executions.outputTruncated", &[("bytes", &bytes)]));
				}
				ExecEvent::TurnEnd { ok, text } => {
					event.kind = if ok { "system" } else { "tool-error" }.into();
					event.text = if text.trim().is_empty() {
						crate::i18n::t("executions.turnEnded")
					} else {
						text
					};
				}
				ExecEvent::Stderr { text } => {
					event.kind = "tool-error".into();
					event.text = text;
				}
				ExecEvent::Lifecycle { step, note } => {
					event.text = match (step, note.is_empty()) {
						(Step::Resumed, _) => crate::i18n::t("executions.turnResumed"),
						(Step::Answered, true) => crate::i18n::t("executions.agentDone"),
						(_, true) => format!("{step:?}"),
						(_, false) => note,
					};
				}
			}
			event
		}
	}
}

// ───────────────────────────── Ménage ─────────────────────────────

/// Ce qu'il faut oublier, décidé sans toucher au disque.
///
/// Deux bornes, deux raisons : l'âge, parce qu'une exécution d'il y a six
/// semaines ne se relit plus ; le nombre, parce qu'une journée de missions en
/// produit des centaines et qu'un relevé qui ne fait que grossir finit par
/// n'être plus relu du tout.
///
/// `entries` va du plus ancien au plus récent. Un horodatage illisible n'est
/// jamais évincé par l'âge : on ne supprime pas ce dont on ignore la date.
pub fn to_evict(
	entries: &[(String, String)],
	now: chrono::DateTime<chrono::Utc>,
	keep_days: i64,
	keep_max: usize,
) -> Vec<String> {
	let limite = now - chrono::Duration::days(keep_days);
	let trop_vieux = |at: &str| {
		chrono::DateTime::parse_from_rfc3339(at)
			.map(|parsed| parsed.with_timezone(&chrono::Utc) < limite)
			.unwrap_or(false)
	};

	let surnombre = entries.len().saturating_sub(keep_max);
	entries
		.iter()
		.enumerate()
		.filter(|(rang, (_, at))| *rang < surnombre || trop_vieux(at))
		.map(|(_, (id, _))| id.clone())
		.collect()
}

/// Applique le verdict de [`to_evict`] : appelé une fois, au démarrage.
///
/// Pas de balayage en continu — la borne au nombre rend le pire cas
/// supportable, et un ménage qui tourne tout le temps est un ménage qu'on ne
/// sait plus expliquer.
pub fn sweep() {
	let mut all = fold();
	if all.is_empty() {
		return;
	}
	all.sort_by(|a, b| a.started_at.cmp(&b.started_at));

	let dates: Vec<(String, String)> = all
		.iter()
		.map(|exec| (exec.id.clone(), exec.started_at.clone()))
		.collect();
	let evicted = to_evict(&dates, chrono::Utc::now(), KEEP_DAYS, KEEP_MAX);
	if evicted.is_empty() {
		return;
	}

	for exec in all.iter().filter(|exec| evicted.contains(&exec.id)) {
		let _ = std::fs::remove_file(events_path(&exec.started_at, &exec.id));
	}

	// Réécriture par temporaire puis renommage : c'est le seul endroit du
	// module où l'atomicité compte, le journal n'étant partout ailleurs qu'en
	// ajout. Un `write` interrompu ici perdrait tout l'historique d'un coup.
	//
	// Les lignes gardées sont relues du fichier plutôt que reconstruites depuis
	// l'état déduit : le ménage retire des exécutions entières, il n'a pas à
	// réécrire ce que les autres ont dit.
	let Ok(raw) = std::fs::read_to_string(index_path()) else {
		return;
	};
	let kept: Vec<&str> = raw
		.lines()
		.filter(|line| !line.trim().is_empty())
		.filter(|line| {
			serde_json::from_str::<Entry>(line)
				.map(|entry| !evicted.contains(&entry.execution_id))
				.unwrap_or(false)
		})
		.collect();

	let temporaire = dir().join("index.jsonl.tmp");
	let _guard = index_lock().lock();
	if std::fs::write(&temporaire, format!("{}\n", kept.join("\n"))).is_ok() {
		let _ = std::fs::rename(&temporaire, index_path());
	}

	// Les dossiers-jour vidés de leurs fichiers n'ont plus rien à dire.
	if let Ok(entries) = std::fs::read_dir(dir()) {
		for entry in entries.flatten() {
			if entry.path().is_dir() {
				let _ = std::fs::remove_dir(entry.path());
			}
		}
	}
}

/// Referme ce qu'un cockpit tué n'a pas pu clore. Appelé au démarrage,
/// **avant** [`sweep`].
///
/// Le registre des agents ne survit pas à une fermeture : toute exécution encore
/// ouverte vient forcément d'une session précédente, et son process ne nous
/// appartient plus — à l'exception des agents détachés retrouvés vivants
/// (`alive`), que `agent::adopt_relays` vient de réinscrire. La laisser « en cours » ferait mentir tous les comptes qui
/// suivront.
pub fn close_orphans(alive: &std::collections::HashSet<String>) {
	for exec in fold() {
		// Sauf celles qu'un relais porte encore : leur agent a survécu au
		// cockpit précédent, et celui-ci vient de le reprendre.
		if exec.outcome == Outcome::Running && !alive.contains(&exec.id) {
			note_step(
				&exec.id,
				Step::Orphaned,
				&crate::i18n::t("executions.orphaned"),
			);
		}
	}
}


#[cfg(test)]
mod tests {
	use super::*;

	fn ligne(execution_id: &str, at: &str, record: Record) -> String {
		serde_json::to_string(&Entry {
			v: V,
			execution_id: execution_id.into(),
			at: at.into(),
			record,
		})
		.unwrap()
	}

	fn modèle(nom: &str) -> Record {
		Record::Model { model: nom.into() }
	}

	fn ouverture(protocol: &str) -> Record {
		Record::Opened {
			opening: Opening {
				session_id: "agent-1".into(),
				protocol: protocol.into(),
				engine: "claude".into(),
				mission: "m1".into(),
				cwd: "/tmp/travail".into(),
				..Default::default()
			},
		}
	}

	// ── Le verdict, saisi au vol ──

	#[test]
	fn le_verdict_se_lit_au_delà_de_la_troncature_du_relevé() {
		// Le cas réel : un rapport de recette plus long que ce que le relevé
		// retient, qui conclut à la toute fin. Relu dans le détail, ce verdict
		// aurait été cherché dans ce qu'on venait soi-même de couper.
		let rapport = format!("{}\n\nVERDICT: bloquant", "détail. ".repeat(MAX_TEXT));
		let payload = serde_json::json!({
			"type": "assistant",
			"message": { "content": [{ "type": "text", "text": rapport }] },
		});
		let dit = spoken_in_full(&payload);
		assert!(dit[0].chars().count() > MAX_TEXT);
		assert_eq!(
			dit.iter().rev().find_map(|t| crate::mission::read_verdict(t)),
			Some(crate::mission::Verdict::Blocking)
		);
	}

	#[test]
	fn le_balayage_bon_marché_laisse_passer_toutes_les_casses() {
		// C'est lui qui décide si l'on paie la lecture complète : s'il rate une
		// casse, le verdict correspondant n'est jamais relevé.
		for écrit in ["VERDICT: ok", "Verdict : ok", "verdict=ok", "**VeRdIcT** ok"] {
			assert!(mentions_verdict(écrit), "« {écrit} » doit être vu");
		}
		assert!(!mentions_verdict("Rapport de recette, rien à signaler."));
	}

	#[test]
	fn la_fin_de_tour_parle_aussi() {
		// Un moteur peut ne conclure que dans son résumé de fin de tour.
		let payload = serde_json::json!({ "type": "result", "result": "VERDICT: ok" });
		assert_eq!(spoken_in_full(&payload), vec!["VERDICT: ok".to_string()]);
	}

	#[test]
	fn ce_qui_nest_pas_une_parole_ne_dit_rien() {
		// Un appel d'outil dont l'argument citerait le mot ne conclut rien.
		let payload = serde_json::json!({
			"type": "assistant",
			"message": { "content": [{
				"type": "tool_use",
				"name": "Bash",
				"input": { "command": "echo 'VERDICT: ok'" },
			}] },
		});
		assert!(spoken_in_full(&payload).is_empty());
	}

	#[test]
	fn le_dernier_verdict_relevé_lemporte() {
		// Une recette reprise rejuge : c'est son nouveau jugement qui compte.
		let journal = [
			ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json")),
			ligne(
				"exec-1",
				"2026-08-28T10:05:00Z",
				Record::Verdict {
					verdict: "blocking".into(),
				},
			),
			ligne(
				"exec-1",
				"2026-08-28T10:30:00Z",
				Record::Verdict {
					verdict: "ok".into(),
				},
			),
		]
		.join("\n");
		assert_eq!(fold_raw(&journal)[0].verdict, "ok");
	}

	#[test]
	fn une_exécution_ordinaire_ne_conclut_rien() {
		let journal = ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json"));
		assert!(fold_raw(&journal)[0].verdict.is_empty());
	}

	// ── Le modèle réellement à l'œuvre ──

	#[test]
	fn le_modèle_se_replie_sans_doublon_et_dans_lordre() {
		// Un sous-agent, une compaction ou une reprise peuvent employer un autre
		// modèle que le fil principal : on les garde tous, une fois chacun.
		let journal = [
			ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json")),
			ligne("exec-1", "2026-08-28T10:01:00Z", modèle("claude-opus-5")),
			ligne("exec-1", "2026-08-28T10:02:00Z", modèle("claude-sonnet-5")),
			ligne("exec-1", "2026-08-28T10:03:00Z", modèle("claude-opus-5")),
		]
		.join("\n");
		assert_eq!(fold_raw(&journal)[0].models, ["claude-opus-5", "claude-sonnet-5"]);
	}

	#[test]
	fn un_message_sans_modèle_nen_invente_pas() {
		// Le relevé de Codex ou de Gemini peut ne rien annoncer : mieux vaut une
		// liste vide qu'un modèle deviné.
		let journal = ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json"));
		assert!(fold_raw(&journal)[0].models.is_empty());
	}

	// ── Le repli ──

	#[test]
	fn une_execution_ouverte_et_jamais_close_reste_en_cours() {
		let journal = ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json"));
		let found = fold_raw(&journal);
		assert_eq!(found.len(), 1);
		assert_eq!(found[0].outcome, Outcome::Running);
		assert!(found[0].ended_at.is_empty());
	}

	#[test]
	fn la_premiere_fin_gagne_jamais_la_derniere() {
		// Un agent coupé à la main dont le flux se ferme ensuite a été arrêté :
		// le noter « mort au lancement » inventerait une panne.
		let journal = [
			ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json")),
			ligne(
				"exec-1",
				"2026-08-28T10:05:00Z",
				Record::Life {
					step: Step::Stopped,
					note: "arrêté d'un geste".into(),
				},
			),
			ligne(
				"exec-1",
				"2026-08-28T10:05:01Z",
				Record::Life {
					step: Step::LostAtLaunch,
					note: "flux fermé".into(),
				},
			),
		]
		.join("\n");

		let found = fold_raw(&journal);
		assert_eq!(found[0].outcome, Outcome::Stopped);
		assert_eq!(found[0].ended_at, "2026-08-28T10:05:00Z");
		assert_eq!(found[0].note, "arrêté d'un geste");
		// Les deux étapes restent lisibles : c'est un journal, pas un verdict.
		assert_eq!(found[0].steps.len(), 2);
	}

	#[test]
	fn une_reprise_ne_termine_pas_l_execution() {
		let journal = [
			ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("codex-exec")),
			ligne(
				"exec-1",
				"2026-08-28T10:01:00Z",
				Record::Life {
					step: Step::Resumed,
					note: String::new(),
				},
			),
		]
		.join("\n");

		let found = fold_raw(&journal);
		assert_eq!(found[0].outcome, Outcome::Running);
		assert_eq!(found[0].steps.len(), 1);
	}

	#[test]
	fn un_enregistrement_sans_ouverture_est_ignore_sans_bruit() {
		// Le ménage retire des exécutions entières ; une ligne orpheline est
		// donc attendue, pas une anomalie.
		let journal = ligne(
			"exec-parti",
			"2026-08-28T10:00:00Z",
			Record::Turn {
				turn: Turn::default(),
			},
		);
		assert!(fold_raw(&journal).is_empty());
	}

	#[test]
	fn une_ligne_illisible_ne_fait_pas_tomber_le_reste() {
		let journal = [
			"{ceci n'est pas du json".to_string(),
			ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json")),
		]
		.join("\n");
		assert_eq!(fold_raw(&journal).len(), 1);
	}

	#[test]
	fn la_conversation_du_moteur_garde_la_premiere_annoncee() {
		let journal = [
			ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json")),
			ligne(
				"exec-1",
				"2026-08-28T10:00:01Z",
				Record::EngineSession {
					marker: "sess-a".into(),
				},
			),
			ligne(
				"exec-1",
				"2026-08-28T10:00:02Z",
				Record::EngineSession {
					marker: "sess-b".into(),
				},
			),
		]
		.join("\n");
		assert_eq!(fold_raw(&journal)[0].engine_session, "sess-a");
	}

	#[test]
	fn les_tours_se_cumulent_sans_melanger_les_natures_de_cout() {
		let journal = [
			ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json")),
			ligne(
				"exec-1",
				"2026-08-28T10:01:00Z",
				Record::Turn {
					turn: Turn {
						input_tokens: 100,
						output_tokens: 10,
						cache_tokens: 5,
						cost: Some(Cost::Reported { usd: 0.25 }),
					},
				},
			),
			ligne(
				"exec-1",
				"2026-08-28T10:02:00Z",
				Record::Turn {
					turn: Turn {
						input_tokens: 50,
						cost: Some(Cost::Estimated {
							usd: 0.10,
							table: "tarifs".into(),
						}),
						..Default::default()
					},
				},
			),
			ligne(
				"exec-1",
				"2026-08-28T10:03:00Z",
				Record::Turn {
					turn: Turn {
						input_tokens: 20,
						cost: None,
						..Default::default()
					},
				},
			),
		]
		.join("\n");

		let tally = fold_raw(&journal)[0].tally.clone();
		assert_eq!(tally.turns, 3);
		assert_eq!(tally.input_tokens, 170);
		assert_eq!(tally.output_tokens, 10);
		assert_eq!(tally.cache_tokens, 5);
		assert!((tally.cost.reported_usd - 0.25).abs() < f64::EPSILON);
		assert!((tally.cost.estimated_usd - 0.10).abs() < f64::EPSILON);
		// Le tour muet est compté à part, jamais comme un tour gratuit.
		assert_eq!(tally.cost.unknown_turns, 1);
	}

	// ── L'identité ──

	#[test]
	fn l_execution_et_la_session_ne_se_confondent_pas() {
		let journal = ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json"));
		let exec = fold_raw(&journal).remove(0);
		assert_eq!(exec.id, "exec-1");
		assert_eq!(exec.opening.session_id, "agent-1");
	}

	#[test]
	fn deux_identifiants_tires_de_suite_different() {
		assert_ne!(new_id(), new_id());
	}

	#[test]
	fn l_origine_dit_qui_a_lance_sans_acteur_ambiant() {
		assert_eq!(Origin::human().actor, crate::journal::HUMAN);
		let p = Origin::permanence("eng-4");
		assert_eq!(p.actor, crate::journal::PERMANENCE);
		assert_eq!(p.engagement, "eng-4");
		let m = Origin::master("backend", "t2", 1);
		assert_eq!(m.actor, MASTER);
		assert_eq!(m.role, "backend");
		assert_eq!(m.task, "t2");
		assert_eq!(m.attempt, 1);
	}

	// ── Compatibilité de format ──

	#[test]
	fn une_ouverture_sans_champs_recents_se_relit() {
		// Le précédent est le champ `actor` de `journal.rs` : un journal écrit
		// par une version d'avant doit continuer de se lire.
		let journal =
			r#"{"v":1,"executionId":"exec-1","at":"2026-08-28T10:00:00Z","record":"opened","opening":{}}"#;
		let found = fold_raw(journal);
		assert_eq!(found.len(), 1);
		assert_eq!(found[0].outcome, Outcome::Running);
		assert!(found[0].opening.session_id.is_empty());
	}

	// ── Le ménage ──

	fn instant(iso: &str) -> chrono::DateTime<chrono::Utc> {
		chrono::DateTime::parse_from_rfc3339(iso)
			.unwrap()
			.with_timezone(&chrono::Utc)
	}

	#[test]
	fn rien_a_evincer_sous_les_deux_bornes() {
		let entries = vec![
			("a".to_string(), "2026-08-27T10:00:00Z".to_string()),
			("b".to_string(), "2026-08-28T10:00:00Z".to_string()),
		];
		assert!(to_evict(&entries, instant("2026-08-28T12:00:00Z"), 30, 2000).is_empty());
	}

	#[test]
	fn l_age_seul_evince() {
		let entries = vec![
			("vieux".to_string(), "2026-06-01T10:00:00Z".to_string()),
			("frais".to_string(), "2026-08-28T10:00:00Z".to_string()),
		];
		let out = to_evict(&entries, instant("2026-08-28T12:00:00Z"), 30, 2000);
		assert_eq!(out, vec!["vieux".to_string()]);
	}

	#[test]
	fn le_nombre_seul_evince_les_plus_anciens() {
		let entries: Vec<(String, String)> = (0..5)
			.map(|i| (format!("e{i}"), format!("2026-08-2{i}T10:00:00Z")))
			.collect();
		let out = to_evict(&entries, instant("2026-08-28T12:00:00Z"), 3650, 2);
		assert_eq!(out, vec!["e0".to_string(), "e1".to_string(), "e2".to_string()]);
	}

	#[test]
	fn une_date_illisible_ne_s_evince_jamais_par_l_age() {
		// On ne supprime pas ce dont on ignore la date : mieux vaut garder une
		// ligne de trop qu'effacer une trace qu'on ne saurait pas justifier.
		let entries = vec![("bancal".to_string(), "pas une date".to_string())];
		assert!(to_evict(&entries, instant("2026-08-28T12:00:00Z"), 30, 2000).is_empty());
	}

	#[test]
	fn le_surnombre_evince_meme_une_date_illisible() {
		let entries = vec![
			("bancal".to_string(), "pas une date".to_string()),
			("frais".to_string(), "2026-08-28T10:00:00Z".to_string()),
		];
		let out = to_evict(&entries, instant("2026-08-28T12:00:00Z"), 30, 1);
		assert_eq!(out, vec!["bancal".to_string()]);
	}





	// ── Les bornes ──

	#[test]
	fn un_texte_qui_deborde_est_coupe_et_le_dit() {
		let long = "a".repeat(50_000);
		let coupe = clip_text(&long);
		assert_eq!(coupe.chars().count(), MAX_TEXT + 1, "le texte plus le signe de coupure");
		assert!(coupe.ends_with('…'));
	}

	#[test]
	fn un_texte_court_ressort_intact_et_sans_signe_de_coupure() {
		assert_eq!(clip_text("  deux mots  "), "deux mots");
	}

	#[test]
	fn l_entree_d_un_outil_est_plus_serree_que_le_reste() {
		// Elle décrit un appel, elle ne le rejoue pas.
		const { assert!(MAX_INPUT < MAX_TEXT) };
		let long = "b".repeat(10_000);
		assert_eq!(clip_input(&long).chars().count(), MAX_INPUT + 1);
		assert_eq!(clip_excerpt(&long).chars().count(), MAX_EXCERPT + 1);
	}

	#[test]
	fn couper_ne_casse_pas_un_caractere_accentue() {
		// Compté en caractères et non en octets : couper au milieu d'un « é »
		// produirait une chaîne que personne ne saurait relire.
		let long = "é".repeat(MAX_TEXT + 100);
		let coupe = clip_text(&long);
		assert!(coupe.starts_with('é'));
		assert_eq!(coupe.chars().count(), MAX_TEXT + 1);
	}

	// ── La projection vers l'écran existant ──

	fn projette(event: ExecEvent) -> crate::sessions::SessionEvent {
		// La même projection que `timeline_as_events`, sur un seul événement :
		// le disque n'apporterait rien à ce qu'on vérifie ici.
		let beats = vec![Beat {
			at: "2026-08-28T10:00:00Z".into(),
			event,
		}];
		beats
			.into_iter()
			.enumerate()
			.map(|(index, beat)| project(index, beat))
			.next()
			.unwrap()
	}

	#[test]
	fn chaque_evenement_prend_la_forme_que_l_ecran_sait_deja_lire() {
		assert_eq!(
			projette(ExecEvent::Prompt { text: "salut".into() }).kind,
			"user"
		);
		assert_eq!(projette(ExecEvent::Say { text: "ok".into() }).kind, "assistant");
		assert_eq!(projette(ExecEvent::Think { text: "hmm".into() }).kind, "thinking");
		assert_eq!(
			projette(ExecEvent::Tool {
				id: "t1".into(),
				name: "Bash".into(),
				hint: "ls".into(),
				input: "{}".into(),
			})
			.kind,
			"tool"
		);
		assert_eq!(
			projette(ExecEvent::ToolDone {
				id: "t1".into(),
				ok: true,
				bytes: 10,
				excerpt: "sortie".into(),
			})
			.kind,
			"tool-result"
		);
		assert_eq!(
			projette(ExecEvent::ToolDone {
				id: "t1".into(),
				ok: false,
				bytes: 10,
				excerpt: "boum".into(),
			})
			.kind,
			"tool-error"
		);
		assert_eq!(
			projette(ExecEvent::Stderr { text: "erreur".into() }).kind,
			"tool-error"
		);
	}

	#[test]
	fn une_sortie_coupee_dit_de_quoi_elle_a_ete_coupee() {
		let event = projette(ExecEvent::ToolDone {
			id: "t1".into(),
			ok: true,
			bytes: 5_242_880,
			excerpt: "début…".into(),
		});
		assert_eq!(event.detail.as_deref(), Some("5242880-byte output, excerpt above"));
	}

	#[test]
	fn une_sortie_entiere_n_annonce_aucune_coupure() {
		let event = projette(ExecEvent::ToolDone {
			id: "t1".into(),
			ok: true,
			bytes: 12,
			excerpt: "tout est là".into(),
		});
		assert_eq!(event.detail, None);
	}

	#[test]
	fn une_etape_du_cockpit_se_raconte_en_clair() {
		// Le nom de la variante ne doit jamais atteindre l'écran quand on a
		// mieux à dire.
		assert_eq!(
			projette(ExecEvent::Lifecycle {
				step: Step::Resumed,
				note: String::new(),
			})
			.text,
			"Next turn relaunched."
		);
		assert_eq!(
			projette(ExecEvent::Lifecycle {
				step: Step::Answered,
				note: String::new(),
			})
			.text,
			"Agent finished."
		);
		assert_eq!(
			projette(ExecEvent::Lifecycle {
				step: Step::LostAtLaunch,
				note: "binaire introuvable".into(),
			})
			.text,
			"binaire introuvable"
		);
	}

	#[test]
	fn un_detail_borne_se_dit_dans_l_index() {
		let journal = [
			ligne("exec-1", "2026-08-28T10:00:00Z", ouverture("claude-stream-json")),
			ligne(
				"exec-1",
				"2026-08-28T10:30:00Z",
				Record::Trimmed { dropped: 1_204 },
			),
		]
		.join("\n");
		assert_eq!(fold_raw(&journal)[0].events_dropped, 1_204);
	}


	#[test]
	fn un_releve_ecrit_par_une_version_plus_recente_se_lit_quand_meme() {
		// Un protocole inconnu ne doit ni faire tomber la lecture, ni se
		// déclarer moins observable : supposer qu'un moteur inconnu rapporte
		// peu produirait exactement le biais que cette table sert à éviter.
		let journal = ligne(
			"exec-1",
			"2026-08-28T10:00:00Z",
			ouverture("un-protocole-a-venir"),
		);
		let found = fold_raw(&journal);
		assert_eq!(found.len(), 1);
		assert_eq!(
			found[0].observability,
			crate::protocol::Protocol::Claude.observability()
		);
	}
}
