//! Des rendez-vous qui se préparent seuls.
//!
//! Le daily a lieu le lundi, le mercredi et le vendredi à 14 h, et chacun y
//! raconte ce qu'il a fait depuis le précédent. Ce récit se reconstituait à la
//! main, avant chaque daily, en demandant à un agent de fouiller GitHub, Linear
//! et le reste. Une automatisation le fait à l'heure dite : elle lit, fait
//! rédiger, range le rendu et prévient.
//!
//! Le périmètre est volontairement étroit, et c'est ce qui la distingue de la
//! Permanence :
//!
//! - **Lecture seule, sans réglage pour en sortir.** Les sources sont lues par
//!   le cockpit ; l'agent ne reçoit que ce qu'on a lu, sans aucun outil, et
//!   n'en sort qu'un texte. Il ne peut rien pousser, commenter ni déplacer.
//! - **Elle produit un document, jamais une action.** Sa réussite se constate :
//!   le rendu existe, avec ses parties.
//! - **Chaque ligne remonte à sa source.** L'agent cite les identifiants des
//!   éléments qu'on lui a donnés ; une référence inventée est écartée, et une
//!   ligne qui n'en garde aucune est marquée comme telle.
//!
//! La période couverte part de la fin de la dernière exécution réussie, pas
//! d'une durée fixe : le daily du lundi couvre le week-end, et une exécution
//! ratée ne fait rien perdre — la suivante reprend d'où la dernière bonne
//! s'était arrêtée.
//!
//! Les exécutions s'écrivent en ajout, un fichier par automatisation, et leur
//! état se déduit en relisant : rien n'est jamais réécrit, pas même une ligne
//! écartée, qui est un enregistrement de plus.
//!
//! Elle ne tourne que cockpit ouvert : poste, pas service. Mac en veille à
//! l'heure dite, elle se rattrape à l'ouverture tant que le rendez-vous n'est
//! pas passé, et se note manquée sinon — une absence dite vaut mieux qu'un
//! rendu arrivé après la réunion.

use crate::config::{config_dir, Config};
use crate::error::{CockpitError, Result};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

// ───────────────────────────── La définition ─────────────────────────────

/// D'où part la période couverte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Window {
	/// De la fin de la dernière exécution réussie à maintenant.
	#[default]
	Since,
	/// Les dernières vingt-quatre heures, quoi qu'il se soit passé avant.
	Day,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sources {
	pub github: bool,
	/// Le suivi de tâches déclaré : Linear quand un jeton est posé.
	pub tracker: bool,
	/// Ce que le cockpit a vu faire : tours d'agents, gestes du journal.
	pub cockpit: bool,
	/// Les erreurs qui me sont assignées et qui ont bougé sur la période.
	pub sentry: bool,
}

impl Default for Sources {
	fn default() -> Self {
		Sources { github: true, tracker: true, cockpit: true, sentry: false }
	}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Automation {
	pub id: String,
	pub name: String,
	/// Le modèle dont elle est partie (`daily`, `blank`). Le daily s'en sert pour
	/// retrouver « ma partie » : seul un rendu de daily y a sa place.
	pub template: String,
	/// `1` = lundi … `7` = dimanche, comme `workflow.daily_weekdays`.
	pub days: Vec<u8>,
	/// Heure du rendez-vous, `HH:MM`, heure locale.
	pub time: String,
	/// Combien de minutes avant le rendez-vous le rendu doit être prêt.
	pub lead_minutes: u32,
	pub window: Window,
	pub sources: Sources,
	pub prompt: String,
	/// Se lancer à l'ouverture du cockpit quand l'heure est passée, tant que le
	/// rendez-vous ne l'est pas.
	pub catch_up: bool,
	pub notify: bool,
	pub enabled: bool,
	pub created_at: String,
	/// Ce qui a été reproché aux rendus précédents, gardé à part de la consigne :
	/// on relit ce qu'on a écrit soi-même sans le noyer sous les reprises, et
	/// chaque correction garde sa date.
	pub corrections: Vec<Correction>,
	/// Mettre chaque rendu en PDF dès qu'il est prêt.
	pub pdf: bool,
	/// Webhook Slack entrant. Rien n'y part sans un clic : le rendu se relit
	/// avant d'être publié.
	pub slack_webhook: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Correction {
	pub at: String,
	pub text: String,
}

impl Default for Automation {
	fn default() -> Self {
		Automation {
			id: String::new(),
			name: String::new(),
			template: "blank".into(),
			days: vec![1, 3, 5],
			time: "14:00".into(),
			lead_minutes: 30,
			window: Window::Since,
			sources: Sources::default(),
			prompt: String::new(),
			catch_up: true,
			notify: true,
			enabled: true,
			created_at: String::new(),
			corrections: Vec::new(),
			pdf: false,
			slack_webhook: String::new(),
		}
	}
}

/// La consigne du modèle « Mon daily ».
pub const DAILY_PROMPT: &str = "Summarize what I did over the period, for the team daily. \
Four parts: Shipped, In progress, Blocked, Next. One line per topic; group a PR with the ticket \
it addresses. No code-internal jargon: the product team is listening too.";

fn definitions_path() -> PathBuf {
	config_dir().join("automations.json")
}

fn runs_path(id: &str) -> PathBuf {
	config_dir().join("automations").join(format!("{id}.jsonl"))
}

/// Les définitions, telles qu'enregistrées. Un fichier absent ou illisible
/// rend une liste vide : un réglage cassé ne doit pas empêcher l'app de démarrer.
pub fn list() -> Vec<Automation> {
	std::fs::read_to_string(definitions_path())
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

fn write_definitions(all: &[Automation]) -> Result<()> {
	let path = definitions_path();
	if let Some(dir) = path.parent() {
		std::fs::create_dir_all(dir)?;
	}
	let raw = serde_json::to_string_pretty(all)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("automations.errors.serialize", &[("error", &e)])))?;
	// Écrit à côté puis renommé : un cockpit coupé en pleine écriture ne doit
	// pas laisser un fichier à moitié, qui se relirait comme « aucune ».
	let temp = path.with_extension("json.tmp");
	std::fs::write(&temp, raw)?;
	std::fs::rename(&temp, &path)?;
	Ok(())
}

/// Ce que l'interface voit à la place d'un webhook enregistré. Comme les jetons
/// des réglages, une adresse qui permet de publier ne quitte pas le backend.
pub const SECRET_MASK: &str = "••••••••";

fn parse_time(value: &str) -> Option<NaiveTime> {
	NaiveTime::parse_from_str(value.trim(), "%H:%M").ok()
}

/// Enregistre une automatisation, nouvelle ou modifiée.
pub fn save(mut automation: Automation) -> Result<Automation> {
	automation.name = automation.name.trim().to_string();
	if automation.name.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("automations.errors.noName")));
	}
	if parse_time(&automation.time).is_none() {
		return Err(CockpitError::msg(crate::i18n::t("automations.errors.badTime")));
	}
	automation.days.retain(|day| (1..=7).contains(day));
	automation.days.sort_unstable();
	automation.days.dedup();
	let mut all = list();
	match all.iter_mut().find(|entry| entry.id == automation.id && !automation.id.is_empty()) {
		Some(existing) => {
			// Le webhook ne redescend jamais dans l'interface (voir `overview`) :
			// la marque qu'elle renvoie veut dire « garder celui qu'on a ».
			if automation.slack_webhook == SECRET_MASK {
				automation.slack_webhook = existing.slack_webhook.clone();
			}
			// La date de création ne se réécrit pas : c'est elle qui empêche de
			// compter comme manqués les rendez-vous d'avant sa naissance.
			automation.created_at = existing.created_at.clone();
			*existing = automation.clone();
		}
		None => {
			if automation.slack_webhook == SECRET_MASK {
				automation.slack_webhook.clear();
			}
			automation.id = format!("auto-{:x}", Utc::now().timestamp_millis());
			automation.created_at = Utc::now().to_rfc3339();
			all.push(automation.clone());
		}
	}
	write_definitions(&all)?;
	Ok(automation)
}

/// Retire la définition. L'historique reste sur le disque : il n'appartient
/// pas à la définition, et une exécution passée ne cesse pas d'avoir eu lieu.
pub fn remove(id: &str) -> Result<()> {
	let mut all = list();
	all.retain(|entry| entry.id != id);
	write_definitions(&all)
}

// ───────────────────────────── L'historique ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
	/// À l'heure prévue.
	Schedule,
	/// L'heure était passée à l'ouverture du cockpit, le rendez-vous non.
	CatchUp,
	/// Lancée à la main. Elle ne déplace pas le point de départ de la suivante :
	/// un essai à 11 h ne doit pas amputer le daily de 13 h 30 de sa matinée.
	Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceState {
	Read,
	/// Déclarée mais muette : jeton absent ou expiré, service injoignable. Sa
	/// partie manque, et le rendu le dit.
	Silent,
	/// Cochée, mais aucun compte n'est déclaré pour elle : ce n'est pas une
	/// panne, et le rendu n'en devient pas partiel.
	Unconfigured,
}

/// Un élément lu, tel qu'il sera cité.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
	/// `gh:dépôt#12`, `tk:NW-3514`, `ck:…` — ce que l'agent cite.
	pub id: String,
	/// `github` · `tracker` · `cockpit`.
	pub source: String,
	pub title: String,
	pub url: String,
	/// Ce qui lui est arrivé sur la période : `merged`, `opened`, `reviewed`,
	/// `updated`, `done`, `started`, `moved`, `agent`, `git`.
	pub event: String,
	pub detail: String,
	pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Line {
	pub id: String,
	pub title: String,
	pub detail: String,
	pub refs: Vec<String>,
	/// L'agent n'a cité aucun élément qu'on lui avait donné.
	#[serde(default)]
	pub unsourced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Part {
	pub title: String,
	pub lines: Vec<Line>,
}

/// Ce que vaut la rédaction, et d'où vient ce chiffre.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Valuation {
	/// `None` quand on ne sait pas — jamais un zéro qui voudrait dire « gratuit ».
	pub usd: Option<f64>,
	/// `cli` : la valorisation que rend le CLI, aux tarifs de l'API, sans que
	/// rien ne soit débité sur un abonnement. `none` : pas de rédaction.
	pub provenance: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Record {
	#[serde(rename_all = "camelCase")]
	Started {
		run: String,
		at: String,
		/// `2026-10-26T14:00` pour un rendez-vous, `manual-…` sinon : c'est ce
		/// qui empêche de traiter deux fois le même.
		occurrence: String,
		trigger: Trigger,
		from: String,
		to: String,
	},
	#[serde(rename_all = "camelCase")]
	Source {
		run: String,
		at: String,
		source: String,
		state: SourceState,
		count: usize,
		note: String,
	},
	#[serde(rename_all = "camelCase")]
	Finished {
		run: String,
		at: String,
		headline: String,
		items: Vec<Item>,
		parts: Vec<Part>,
		valuation: Valuation,
		duration_ms: u64,
		/// Le compte GitHub lu comme « moi » : le daily s'en sert pour savoir
		/// à quel tour de parole ce rendu appartient.
		viewer: String,
	},
	#[serde(rename_all = "camelCase")]
	Failed { run: String, at: String, reason: String },
	#[serde(rename_all = "camelCase")]
	Missed { run: String, at: String, occurrence: String, reason: String },
	/// Une ligne écartée de la présentation, ou remise. Un enregistrement de
	/// plus : le rendu d'origine reste lisible tel que l'agent l'a écrit.
	#[serde(rename_all = "camelCase")]
	Dropped { run: String, at: String, line: String, dropped: bool },
	/// Le rendu a été mis en PDF, à cet endroit.
	#[serde(rename_all = "camelCase")]
	Exported { run: String, at: String, path: String },
	/// Le rendu a été publié sur Slack.
	#[serde(rename_all = "camelCase")]
	Posted { run: String, at: String },
}

impl Record {
	fn run(&self) -> &str {
		match self {
			Record::Started { run, .. }
			| Record::Source { run, .. }
			| Record::Finished { run, .. }
			| Record::Failed { run, .. }
			| Record::Missed { run, .. }
			| Record::Dropped { run, .. }
			| Record::Exported { run, .. }
			| Record::Posted { run, .. } => run,
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
	Running,
	Ready,
	/// Prête, mais une source déclarée n'a pas répondu.
	Partial,
	Failed,
	Missed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
	pub source: String,
	pub state: SourceState,
	pub count: usize,
	pub note: String,
}

/// Une exécution, déduite de ses enregistrements.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
	pub id: String,
	pub automation: String,
	pub occurrence: String,
	pub trigger: Option<Trigger>,
	pub state: RunState,
	pub from: String,
	pub to: String,
	pub started_at: String,
	pub ended_at: String,
	pub sources: Vec<SourceReport>,
	pub headline: String,
	pub items: Vec<Item>,
	pub parts: Vec<Part>,
	pub dropped: Vec<String>,
	pub valuation: Option<Valuation>,
	pub duration_ms: u64,
	pub viewer: String,
	pub reason: String,
	/// Les PDF produits, du plus ancien au plus récent.
	pub exports: Vec<String>,
	/// Quand il a été publié sur Slack, s'il l'a été.
	pub posted_at: String,
}

fn read_records(id: &str) -> Vec<Record> {
	let Ok(raw) = std::fs::read_to_string(runs_path(id)) else {
		return Vec::new();
	};
	// Une ligne illisible — écriture coupée net — se saute : elle ne doit pas
	// emporter tout l'historique avec elle.
	raw.lines()
		.filter_map(|line| serde_json::from_str::<Record>(line).ok())
		.collect()
}

static WRITE: Mutex<()> = Mutex::new(());

fn append(id: &str, record: &Record) {
	let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
	let path = runs_path(id);
	if let Some(dir) = path.parent() {
		let _ = std::fs::create_dir_all(dir);
	}
	let Ok(line) = serde_json::to_string(record) else { return };
	if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
		let _ = writeln!(file, "{line}");
	}
}

/// Relit les enregistrements d'une automatisation en exécutions, la plus
/// récente d'abord.
pub fn fold(automation: &str, records: &[Record]) -> Vec<Run> {
	let mut order: Vec<String> = Vec::new();
	let mut runs: HashMap<String, Run> = HashMap::new();
	let mut dropped: HashMap<String, HashSet<String>> = HashMap::new();
	for record in records {
		let id = record.run().to_string();
		if !runs.contains_key(&id) {
			order.push(id.clone());
			runs.insert(
				id.clone(),
				Run {
					id: id.clone(),
					automation: automation.to_string(),
					occurrence: String::new(),
					trigger: None,
					state: RunState::Running,
					from: String::new(),
					to: String::new(),
					started_at: String::new(),
					ended_at: String::new(),
					sources: Vec::new(),
					headline: String::new(),
					items: Vec::new(),
					parts: Vec::new(),
					dropped: Vec::new(),
					valuation: None,
					duration_ms: 0,
					viewer: String::new(),
					reason: String::new(),
					exports: Vec::new(),
					posted_at: String::new(),
				},
			);
		}
		let run = runs.get_mut(&id).expect("inséré juste avant");
		match record {
			Record::Started { at, occurrence, trigger, from, to, .. } => {
				run.started_at = at.clone();
				run.occurrence = occurrence.clone();
				run.trigger = Some(*trigger);
				run.from = from.clone();
				run.to = to.clone();
			}
			Record::Source { source, state, count, note, .. } => {
				run.sources.retain(|entry| &entry.source != source);
				run.sources.push(SourceReport {
					source: source.clone(),
					state: *state,
					count: *count,
					note: note.clone(),
				});
			}
			Record::Finished { at, headline, items, parts, valuation, duration_ms, viewer, .. } => {
				run.ended_at = at.clone();
				run.headline = headline.clone();
				run.items = items.clone();
				run.parts = parts.clone();
				run.valuation = Some(valuation.clone());
				run.duration_ms = *duration_ms;
				run.viewer = viewer.clone();
				run.state = if run.sources.iter().any(|s| s.state == SourceState::Silent) {
					RunState::Partial
				} else {
					RunState::Ready
				};
			}
			Record::Failed { at, reason, .. } => {
				run.ended_at = at.clone();
				run.reason = reason.clone();
				run.state = RunState::Failed;
			}
			Record::Missed { at, occurrence, reason, .. } => {
				run.started_at = at.clone();
				run.ended_at = at.clone();
				run.occurrence = occurrence.clone();
				run.reason = reason.clone();
				run.state = RunState::Missed;
			}
			Record::Exported { path, .. } => run.exports.push(path.clone()),
			Record::Posted { at, .. } => run.posted_at = at.clone(),
			Record::Dropped { line, dropped: out, .. } => {
				let set = dropped.entry(id.clone()).or_default();
				if *out {
					set.insert(line.clone());
				} else {
					set.remove(line);
				}
			}
		}
	}
	let mut result: Vec<Run> = order
		.into_iter()
		.filter_map(|id| {
			let mut run = runs.remove(&id)?;
			if let Some(set) = dropped.get(&id) {
				let mut lines: Vec<String> = set.iter().cloned().collect();
				lines.sort();
				run.dropped = lines;
			}
			Some(run)
		})
		.collect();
	result.reverse();
	result
}

pub fn runs(id: &str) -> Vec<Run> {
	fold(id, &read_records(id))
}

pub fn drop_line(id: &str, run: &str, line: &str, dropped: bool) {
	append(
		id,
		&Record::Dropped {
			run: run.to_string(),
			at: Utc::now().to_rfc3339(),
			line: line.to_string(),
			dropped,
		},
	);
}

// ───────────────────────────── Le calendrier ─────────────────────────────

/// Ce qu'il y a à faire pour une automatisation, à cet instant.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
	Nothing,
	Run { occurrence: NaiveDateTime, trigger: Trigger },
	Miss { occurrence: NaiveDateTime, reason: String },
}

/// La marge pendant laquelle un lancement compte encore comme « à l'heure » :
/// la boucle passe toutes les trente secondes, et l'app peut avoir été occupée.
const GRACE_MINUTES: i64 = 5;

pub fn occurrence_key(occurrence: NaiveDateTime) -> String {
	occurrence.format("%Y-%m-%dT%H:%M").to_string()
}

/// Le dernier rendez-vous dont l'heure de préparation est passée.
pub fn last_due(automation: &Automation, now: NaiveDateTime) -> Option<NaiveDateTime> {
	let time = parse_time(&automation.time)?;
	let lead = Duration::minutes(automation.lead_minutes as i64);
	(0..9)
		.map(|back| now.date() - Duration::days(back))
		.filter(|date| automation.days.contains(&(date.weekday().number_from_monday() as u8)))
		.map(|date| date.and_time(time))
		.find(|occurrence| *occurrence - lead <= now)
}

/// Les prochains rendez-vous, pour les montrer avant qu'ils arrivent.
pub fn upcoming(automation: &Automation, now: NaiveDateTime, count: usize) -> Vec<NaiveDateTime> {
	let Some(time) = parse_time(&automation.time) else {
		return Vec::new();
	};
	let lead = Duration::minutes(automation.lead_minutes as i64);
	(0..60)
		.map(|ahead| now.date() + Duration::days(ahead))
		.filter(|date| automation.days.contains(&(date.weekday().number_from_monday() as u8)))
		.map(|date| date.and_time(time))
		.filter(|occurrence| *occurrence - lead > now)
		.take(count)
		.collect()
}

pub fn decide(
	automation: &Automation,
	now: NaiveDateTime,
	created: NaiveDateTime,
	handled: &HashSet<String>,
) -> Decision {
	if !automation.enabled {
		return Decision::Nothing;
	}
	let Some(occurrence) = last_due(automation, now) else {
		return Decision::Nothing;
	};
	let lead = Duration::minutes(automation.lead_minutes as i64);
	let ready = occurrence - lead;
	// Un rendez-vous d'avant sa création n'a jamais été promis.
	if ready < created || handled.contains(&occurrence_key(occurrence)) {
		return Decision::Nothing;
	}
	if now - ready <= Duration::minutes(GRACE_MINUTES) {
		return Decision::Run { occurrence, trigger: Trigger::Schedule };
	}
	if now < occurrence {
		if automation.catch_up {
			return Decision::Run { occurrence, trigger: Trigger::CatchUp };
		}
		return Decision::Miss {
			occurrence,
			reason: crate::i18n::t("automations.missed.closedNoCatchUp"),
		};
	}
	Decision::Miss {
		occurrence,
		reason: crate::i18n::t("automations.missed.closedUntilAfter"),
	}
}

/// D'où part la période d'une exécution qui commence à `now`.
///
/// La fin de la dernière exécution réussie, hors lancements à la main ; à
/// défaut, le rendez-vous précédent ; à défaut, vingt-quatre heures.
pub fn window_start(automation: &Automation, history: &[Run], now: DateTime<Utc>) -> DateTime<Utc> {
	let day_before = now - Duration::hours(24);
	if automation.window == Window::Day {
		return day_before;
	}
	let last_good = history
		.iter()
		.filter(|run| matches!(run.state, RunState::Ready | RunState::Partial))
		.filter(|run| run.trigger != Some(Trigger::Manual))
		.filter_map(|run| DateTime::parse_from_rfc3339(&run.to).ok())
		.map(|to| to.with_timezone(&Utc))
		.max();
	if let Some(to) = last_good {
		return to;
	}
	let local = now.with_timezone(&Local).naive_local();
	let lead = Duration::minutes(automation.lead_minutes as i64);
	last_due(automation, local - lead - Duration::minutes(GRACE_MINUTES + 1))
		.map(|occurrence| occurrence - lead)
		.and_then(|naive| Local.from_local_datetime(&naive).single())
		.map(|local| local.with_timezone(&Utc))
		.filter(|start| *start < now)
		.unwrap_or(day_before)
}

// ───────────────────────────── La collecte ─────────────────────────────

struct Collected {
	items: Vec<Item>,
	reports: Vec<SourceReport>,
	viewer: String,
}

fn text(value: &Value, pointer: &str) -> String {
	value.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn in_window(at: &str, from: DateTime<Utc>, to: DateTime<Utc>) -> bool {
	DateTime::parse_from_rfc3339(at)
		.map(|at| {
			let at = at.with_timezone(&Utc);
			at >= from && at <= to
		})
		.unwrap_or(false)
}

fn repo_of(url: &str) -> String {
	// `https://api.github.com/repos/acme/web` → `acme/web`
	url.split("/repos/").nth(1).unwrap_or(url).to_string()
}

async fn read_github(config: &Config, from: DateTime<Utc>, to: DateTime<Utc>) -> std::result::Result<(Vec<Item>, String), String> {
	let viewer = crate::integrations::github_viewer(config).await.map_err(|e| e.to_string())?;
	let since = from.format("%Y-%m-%dT%H:%M:%SZ").to_string();
	let mine = crate::integrations::github_search_prs(config, &format!("is:pr author:{viewer} updated:>={since}"))
		.await
		.map_err(|e| e.to_string())?;
	let reviewed = crate::integrations::github_search_prs(
		config,
		&format!("is:pr reviewed-by:{viewer} -author:{viewer} updated:>={since}"),
	)
	.await
	.unwrap_or_default();

	let mut items = Vec::new();
	for (pr, mine) in mine.iter().map(|pr| (pr, true)).chain(reviewed.iter().map(|pr| (pr, false))) {
		let repo = repo_of(&text(pr, "/repository_url"));
		let number = pr.get("number").and_then(Value::as_i64).unwrap_or(0);
		let merged_at = text(pr, "/pull_request/merged_at");
		let created_at = text(pr, "/created_at");
		let (event, at) = if !mine {
			("reviewed", text(pr, "/updated_at"))
		} else if !merged_at.is_empty() && in_window(&merged_at, from, to) {
			("merged", merged_at)
		} else if in_window(&created_at, from, to) {
			("opened", created_at)
		} else {
			("updated", text(pr, "/updated_at"))
		};
		let state = if pr.get("draft").and_then(Value::as_bool).unwrap_or(false) {
			crate::i18n::t("automations.items.draft")
		} else {
			text(pr, "/state")
		};
		items.push(Item {
			id: format!("gh:{repo}#{number}"),
			source: "github".into(),
			title: text(pr, "/title"),
			url: text(pr, "/html_url"),
			event: event.into(),
			detail: format!("{repo} · PR #{number} · {state}"),
			at,
		});
	}
	Ok((items, viewer))
}

async fn read_tracker(config: &Config, from: DateTime<Utc>) -> std::result::Result<Vec<Item>, String> {
	let issues = crate::integrations::linear_mine_since(config, &from.to_rfc3339())
		.await
		.map_err(|e| e.to_string())?;
	Ok(issues
		.iter()
		.map(|issue| {
			let event = match text(issue, "/state/type").as_str() {
				"completed" => "done",
				"started" => "started",
				"canceled" => "canceled",
				_ => "moved",
			};
			let identifier = text(issue, "/identifier");
			let project = text(issue, "/project/name");
			Item {
				id: format!("tk:{identifier}"),
				source: "tracker".into(),
				title: text(issue, "/title"),
				url: text(issue, "/url"),
				event: event.into(),
				detail: [identifier, text(issue, "/state/name"), project]
					.into_iter()
					.filter(|part| !part.is_empty())
					.collect::<Vec<_>>()
					.join(" · "),
				at: text(issue, "/updatedAt"),
			}
		})
		.collect())
}

fn folder_name(path: &str) -> String {
	std::path::Path::new(path)
		.file_name()
		.map(|name| name.to_string_lossy().to_string())
		.unwrap_or_else(|| path.to_string())
}

/// Ce que le cockpit a vu faire : les tours d'agents, rangés par dossier, et
/// les gestes du journal — pousser, fusionner, ouvrir une PR.
fn read_cockpit(from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<Item> {
	let mut by_folder: HashMap<String, (u32, i64, String)> = HashMap::new();
	for exec in crate::executions::since(from) {
		if exec.opening.origin.actor != crate::journal::HUMAN || exec.ended_at.is_empty() {
			continue;
		}
		if !in_window(&exec.ended_at, from, to) {
			continue;
		}
		let minutes = match (
			DateTime::parse_from_rfc3339(&exec.started_at),
			DateTime::parse_from_rfc3339(&exec.ended_at),
		) {
			(Ok(start), Ok(end)) => (end - start).num_minutes().max(0),
			_ => 0,
		};
		let entry = by_folder.entry(exec.opening.cwd.clone()).or_insert((0, 0, String::new()));
		entry.0 += exec.tally.turns.max(1);
		entry.1 += minutes;
		if exec.ended_at > entry.2 {
			entry.2 = exec.ended_at.clone();
		}
	}
	let mut items: Vec<Item> = by_folder
		.into_iter()
		.map(|(cwd, (turns, minutes, at))| {
			let name = folder_name(&cwd);
			Item {
				id: format!("ck:{name}"),
				source: "cockpit".into(),
				title: crate::i18n::tf("automations.items.agentsIn", &[("name", &name)]),
				url: String::new(),
				event: "agent".into(),
				detail: format!(
					"{} · {}",
					crate::brief::counted("automations.items.turns", turns as usize),
					crate::i18n::tf("automations.items.minutes", &[("count", &minutes)])
				),
				at,
			}
		})
		.collect();

	let from_secs = from.timestamp().max(0) as u64;
	let to_secs = to.timestamp().max(0) as u64;
	for (index, entry) in crate::journal::list(1000)
		.into_iter()
		.filter(|entry| entry.ok && entry.actor == crate::journal::HUMAN)
		.filter(|entry| entry.kind == "git" || entry.kind == "github")
		.filter(|entry| entry.at >= from_secs && entry.at <= to_secs)
		.enumerate()
	{
		items.push(Item {
			id: format!("ck:geste-{index}"),
			source: "cockpit".into(),
			title: entry.label.clone(),
			url: String::new(),
			event: "git".into(),
			detail: entry.target.clone(),
			at: Utc
				.timestamp_opt(entry.at as i64, 0)
				.single()
				.map(|at| at.to_rfc3339())
				.unwrap_or_default(),
		});
	}
	items.sort_by(|a, b| a.at.cmp(&b.at));
	items
}

/// Mes erreurs : celles qui me sont assignées et qui ont bougé sur la période.
async fn read_sentry(config: &Config, from: DateTime<Utc>, to: DateTime<Utc>) -> std::result::Result<Vec<Item>, String> {
	let issues = crate::integrations::sentry_issues(config, "assigned:me")
		.await
		.map_err(|e| e.to_string())?;
	Ok(issues
		.into_iter()
		.filter(|issue| issue.timestamp.as_deref().is_some_and(|at| in_window(at, from, to)))
		.map(|issue| {
			let short = text(&issue.payload, "/shortId");
			let short = if short.is_empty() { issue.id.clone() } else { short };
			Item {
				id: format!("se:{short}"),
				source: "sentry".into(),
				title: issue.title.clone(),
				url: issue.url.clone(),
				event: if issue.status == "resolved" { "resolved" } else { "assigned" }.into(),
				detail: [short, issue.subtitle.clone(), issue.status.clone()]
					.into_iter()
					.filter(|part| !part.is_empty())
					.collect::<Vec<_>>()
					.join(" · "),
				at: issue.timestamp.clone().unwrap_or_default(),
			}
		})
		.collect())
}

/// Ce qu'une source a donné : des éléments, un silence, ou rien à interroger.
enum Read {
	Found(Vec<Item>),
	Silent(String),
	Unconfigured(String),
}

async fn collect(automation: &Automation, config: &Config, from: DateTime<Utc>, to: DateTime<Utc>) -> Collected {
	let mut items = Vec::new();
	let mut reports = Vec::new();
	let mut viewer = String::new();

	let mut reads: Vec<(&str, Read)> = Vec::new();
	if automation.sources.github {
		reads.push((
			"github",
			match read_github(config, from, to).await {
				Ok((found, login)) => {
					viewer = login;
					Read::Found(found)
				}
				Err(error) => Read::Silent(error),
			},
		));
	}
	if automation.sources.tracker {
		reads.push((
			"tracker",
			if config.linear.token.trim().is_empty() {
				Read::Unconfigured(crate::i18n::t("automations.sources.noLinearToken"))
			} else {
				match read_tracker(config, from).await {
					Ok(found) => Read::Found(found),
					Err(error) => Read::Silent(error),
				}
			},
		));
	}
	if automation.sources.sentry {
		reads.push((
			"sentry",
			if config.sentry.token.trim().is_empty() {
				Read::Unconfigured(crate::i18n::t("automations.sources.noSentryToken"))
			} else {
				match read_sentry(config, from, to).await {
					Ok(found) => Read::Found(found),
					Err(error) => Read::Silent(error),
				}
			},
		));
	}
	if automation.sources.cockpit {
		reads.push(("cockpit", Read::Found(read_cockpit(from, to))));
	}

	for (source, read) in reads {
		reports.push(match read {
			Read::Found(found) => {
				let count = found.len();
				items.extend(found);
				SourceReport { source: source.into(), state: SourceState::Read, count, note: String::new() }
			}
			Read::Silent(note) => SourceReport { source: source.into(), state: SourceState::Silent, count: 0, note },
			Read::Unconfigured(note) => SourceReport { source: source.into(), state: SourceState::Unconfigured, count: 0, note },
		});
	}
	Collected { items, reports, viewer }
}

// ───────────────────────────── La rédaction ─────────────────────────────

/// La consigne système de la rédaction. Les clés du JSON sont un protocole :
/// elles restent en anglais quelle que soit la langue du texte.
fn system() -> String {
	format!(
		"You write a work summary from the items provided, and from nothing else. \
		 You have no tools. You answer only with a JSON object, with no text around it, of the form \
		 {{\"headline\": \"one sentence\", \"parts\": [{{\"title\": \"…\", \"lines\": [{{\"title\": \"…\", \"detail\": \"…\", \"refs\": [\"gh:…\"]}}]}}]}}. \
		 Keep the JSON keys exactly as shown. Each line cites in refs the exact identifiers of the items it \
		 is based on. Do not invent any item, any number, any link. A part without lines keeps its title \
		 with an empty list. {}",
		crate::i18n::reply_directive()
	)
}

fn prompt_for(automation: &Automation, items: &[Item], reports: &[SourceReport], from: DateTime<Utc>, to: DateTime<Utc>, previous: Option<&Run>) -> String {
	let local = |at: DateTime<Utc>| at.with_timezone(&Local).format("%A %d %B %H:%M").to_string();
	let mut prompt = String::new();
	prompt.push_str(&format!("Instructions:\n{}\n\n", automation.prompt.trim()));
	if !automation.corrections.is_empty() {
		prompt.push_str("Corrections requested after previous outputs, to be followed:\n");
		for correction in &automation.corrections {
			prompt.push_str(&format!("- {}\n", correction.text.trim()));
		}
		prompt.push('\n');
	}
	prompt.push_str(&format!("Period: from {} to {}.\n\n", local(from), local(to)));
	let silent: Vec<&str> = reports
		.iter()
		.filter(|report| report.state == SourceState::Silent)
		.map(|report| report.source.as_str())
		.collect();
	if !silent.is_empty() {
		prompt.push_str(&format!(
			"Sources silent this time, do not fill the gap: {}.\n\n",
			silent.join(", ")
		));
	}
	if let Some(previous) = previous {
		prompt.push_str("The previous summary, to say what has moved forward since:\n");
		for part in &previous.parts {
			for line in &part.lines {
				prompt.push_str(&format!("- [{}] {}\n", part.title, line.title));
			}
		}
		prompt.push('\n');
	}
	prompt.push_str("Items (one JSON object per line):\n");
	for item in items {
		prompt.push_str(
			&json!({
				"id": item.id,
				"source": item.source,
				"event": item.event,
				"title": item.title,
				"detail": item.detail,
				"at": item.at,
			})
			.to_string(),
		);
		prompt.push('\n');
	}
	prompt
}

/// Le premier objet JSON du texte, qu'il soit entouré de prose ou d'une clôture.
fn json_object(text: &str) -> Option<Value> {
	let start = text.find('{')?;
	let end = text.rfind('}')?;
	serde_json::from_str(&text[start..=end]).ok()
}

/// Lit la réponse de l'agent en ne gardant que ce qui remonte à un élément lu.
pub fn read_answer(text: &str, items: &[Item]) -> Option<(String, Vec<Part>)> {
	let value = json_object(text)?;
	let known: HashSet<&str> = items.iter().map(|item| item.id.as_str()).collect();
	let parts = value
		.get("parts")?
		.as_array()?
		.iter()
		.enumerate()
		.map(|(p, part)| Part {
			title: part.get("title").and_then(Value::as_str).unwrap_or("").trim().to_string(),
			lines: part
				.get("lines")
				.and_then(Value::as_array)
				.map(|lines| {
					lines
						.iter()
						.enumerate()
						.map(|(l, line)| {
							let refs: Vec<String> = line
								.get("refs")
								.and_then(Value::as_array)
								.map(|refs| {
									refs.iter()
										.filter_map(Value::as_str)
										.filter(|r| known.contains(r))
										.map(String::from)
										.collect()
								})
								.unwrap_or_default();
							Line {
								id: format!("p{p}l{l}"),
								title: line.get("title").and_then(Value::as_str).unwrap_or("").trim().to_string(),
								detail: line.get("detail").and_then(Value::as_str).unwrap_or("").trim().to_string(),
								unsourced: refs.is_empty(),
								refs,
							}
						})
						.filter(|line| !line.title.is_empty())
						.collect()
				})
				.unwrap_or_default(),
		})
		.filter(|part| !part.title.is_empty())
		.collect();
	let headline = value.get("headline").and_then(Value::as_str).unwrap_or("").trim().to_string();
	Some((headline, parts))
}

// ───────────────────────────── L'exécution ─────────────────────────────

/// Ce qui tourne, pour ne jamais lancer deux fois la même automatisation.
static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn claim(id: &str) -> bool {
	let mut guard = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
	guard.get_or_insert_with(HashSet::new).insert(id.to_string())
}

fn release(id: &str) {
	let mut guard = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
	if let Some(set) = guard.as_mut() {
		set.remove(id);
	}
}

/// Lance une exécution et rend son identifiant tout de suite ; le travail
/// continue en tâche de fond, et s'annonce par `automation://run`.
pub fn start(app: tauri::AppHandle, automation: Automation, occurrence: String, trigger: Trigger) -> Result<String> {
	if !claim(&automation.id) {
		return Err(CockpitError::msg(crate::i18n::t("automations.errors.alreadyRunning")));
	}
	let now = Utc::now();
	let history = runs(&automation.id);
	let from = window_start(&automation, &history, now);
	let run = format!("run-{:x}", now.timestamp_millis());
	append(
		&automation.id,
		&Record::Started {
			run: run.clone(),
			at: now.to_rfc3339(),
			occurrence,
			trigger,
			from: from.to_rfc3339(),
			to: now.to_rfc3339(),
		},
	);
	announce(&app, &automation.id, &run);
	let id = run.clone();
	tauri::async_runtime::spawn(async move {
		let previous = history.iter().find(|r| matches!(r.state, RunState::Ready | RunState::Partial)).cloned();
		execute(&app, &automation, &id, from, now, previous.as_ref()).await;
		release(&automation.id);
		announce(&app, &automation.id, &id);
	});
	Ok(run)
}

fn announce(app: &tauri::AppHandle, automation: &str, run: &str) {
	use tauri::Emitter;
	let _ = app.emit("automation://run", json!({ "automation": automation, "run": run }));
}

/// Ce que donne une rédaction, avant d'être rangé — ou montré à blanc.
struct Composed {
	collected: Collected,
	headline: String,
	parts: Vec<Part>,
	valuation: Valuation,
}

/// Lire puis faire rédiger. Commun à l'exécution et à l'essai à blanc : ce
/// qu'on essaie doit être exactement ce qui tournera.
async fn compose(automation: &Automation, from: DateTime<Utc>, to: DateTime<Utc>, previous: Option<&Run>) -> (Collected, std::result::Result<(String, Vec<Part>, Valuation), String>) {
	let config = Config::active();
	let collected = collect(automation, &config, from, to).await;
	if collected.items.is_empty() {
		// Rien à raconter ne demande pas d'agent : la réponse est connue.
		let answer = (
			crate::i18n::t("automations.nothingFound"),
			Vec::new(),
			Valuation { usd: None, provenance: "none".into() },
		);
		return (collected, Ok(answer));
	}
	let prompt = prompt_for(automation, &collected.items, &collected.reports, from, to, previous);
	let outcome = match crate::agent::ask_bare(&system(), &prompt, "sonnet", std::time::Duration::from_secs(300), true).await {
		Ok(answer) => match read_answer(&answer.text, &collected.items) {
			Some((headline, parts)) => Ok((
				headline,
				parts,
				Valuation { usd: (answer.cost_usd > 0.0).then_some(answer.cost_usd), provenance: "cli".into() },
			)),
			None => Err(crate::i18n::t("automations.errors.unreadableAnswer")),
		},
		Err(error) => Err(error.to_string()),
	};
	(collected, outcome)
}

async fn execute(app: &tauri::AppHandle, automation: &Automation, run: &str, from: DateTime<Utc>, to: DateTime<Utc>, previous: Option<&Run>) {
	let started = std::time::Instant::now();
	let (collected, outcome) = compose(automation, from, to, previous).await;
	for report in &collected.reports {
		append(
			&automation.id,
			&Record::Source {
				run: run.to_string(),
				at: Utc::now().to_rfc3339(),
				source: report.source.clone(),
				state: report.state,
				count: report.count,
				note: report.note.clone(),
			},
		);
	}
	let composed = match outcome {
		Ok((headline, parts, valuation)) => Composed { collected, headline, parts, valuation },
		Err(reason) => {
			fail(app, automation, run, &reason);
			return;
		}
	};

	append(
		&automation.id,
		&Record::Finished {
			run: run.to_string(),
			at: Utc::now().to_rfc3339(),
			headline: composed.headline.clone(),
			items: composed.collected.items.clone(),
			parts: composed.parts.clone(),
			valuation: composed.valuation.clone(),
			duration_ms: started.elapsed().as_millis() as u64,
			viewer: composed.collected.viewer.clone(),
		},
	);
	if automation.pdf {
		// Un PDF raté n'enlève rien au rendu : il se refait d'un clic.
		if let Err(error) = export_pdf(&automation.id, run).await {
			eprintln!("automatisation {} : PDF non produit : {error}", automation.id);
		}
	}
	if automation.notify {
		let lines: usize = composed.parts.iter().map(|part| part.lines.len()).sum();
		let silent: Vec<String> = composed
			.collected
			.reports
			.iter()
			.filter(|report| report.state == SourceState::Silent)
			.map(|report| source_label(&report.source))
			.collect();
		let mut body = crate::brief::counted("automations.notify.linesReady", lines);
		if !silent.is_empty() {
			body.push(' ');
			body.push_str(&crate::i18n::tf("automations.notify.silent", &[("sources", &silent.join(", "))]));
		}
		let title = crate::i18n::tf("automations.notify.ready", &[("name", &automation.name)]);
		notify(app, &title, &body).await;
	}
}

/// Un essai à blanc : le même travail qu'une exécution, sur la période qu'elle
/// couvrirait maintenant, sans rien ranger ni prévenir. Pour régler une
/// consigne en voyant ce qu'elle donne, avant de l'enregistrer.
pub async fn try_once(automation: Automation) -> Result<Run> {
	let now = Utc::now();
	let history = if automation.id.is_empty() { Vec::new() } else { runs(&automation.id) };
	let from = window_start(&automation, &history, now);
	let previous = history.iter().find(|r| matches!(r.state, RunState::Ready | RunState::Partial)).cloned();
	let started = std::time::Instant::now();
	let (collected, outcome) = compose(&automation, from, now, previous.as_ref()).await;
	let (headline, parts, valuation) = outcome.map_err(CockpitError::msg)?;
	let partial = collected.reports.iter().any(|report| report.state == SourceState::Silent);
	Ok(Run {
		id: "essai".into(),
		automation: automation.id.clone(),
		occurrence: "essai".into(),
		trigger: Some(Trigger::Manual),
		state: if partial { RunState::Partial } else { RunState::Ready },
		from: from.to_rfc3339(),
		to: now.to_rfc3339(),
		started_at: now.to_rfc3339(),
		ended_at: Utc::now().to_rfc3339(),
		sources: collected.reports,
		headline,
		items: collected.items,
		parts,
		dropped: Vec::new(),
		valuation: Some(valuation),
		duration_ms: started.elapsed().as_millis() as u64,
		viewer: collected.viewer,
		reason: String::new(),
		exports: Vec::new(),
		posted_at: String::new(),
	})
}

/// Ajoute une correction à la consigne, datée. Rend la définition à jour.
pub fn add_correction(id: &str, text: &str) -> Result<Automation> {
	let text = text.trim();
	if text.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("automations.errors.emptyCorrection")));
	}
	let mut automation = list()
		.into_iter()
		.find(|entry| entry.id == id)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("automations.errors.notFound")))?;
	automation.corrections.push(Correction { at: Utc::now().to_rfc3339(), text: text.to_string() });
	save(automation)
}

// ───────────────────────────── Les sorties ─────────────────────────────

fn find_run(id: &str, run: &str) -> Result<(Automation, Run)> {
	let automation = list()
		.into_iter()
		.find(|entry| entry.id == id)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("automations.errors.notFound")))?;
	let found = runs(id)
		.into_iter()
		.find(|entry| entry.id == run)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("automations.errors.runNotFound")))?;
	if !matches!(found.state, RunState::Ready | RunState::Partial) {
		return Err(CockpitError::msg(crate::i18n::t("automations.errors.noOutput")));
	}
	Ok((automation, found))
}

fn escape(text: &str) -> String {
	text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn local_stamp(at: &str) -> String {
	// L'ordre jour/mois et son séparateur suivent la langue du rendu.
	let pattern = match crate::i18n::lang().as_str() {
		"en" => "%b %-d, %H:%M",
		"de" => "%d.%m. %H:%M",
		"ru" => "%d.%m %H:%M",
		"ja" | "zh-CN" | "ko" => "%m/%d %H:%M",
		_ => "%d/%m %H:%M",
	};
	DateTime::parse_from_rfc3339(at)
		.map(|at| at.with_timezone(&Local).format(pattern).to_string())
		.unwrap_or_default()
}

/// Le rendu en page imprimable : ce qu'on présenterait, lignes écartées en moins.
pub fn render_html(automation: &Automation, run: &Run) -> String {
	let items: HashMap<&str, &Item> = run.items.iter().map(|item| (item.id.as_str(), item)).collect();
	let mut body = String::new();
	if !run.headline.is_empty() {
		body.push_str(&format!("<p class=\"headline\">{}</p>", escape(&run.headline)));
	}
	for part in &run.parts {
		body.push_str(&format!("<h2>{}</h2><ul>", escape(&part.title)));
		let kept: Vec<&Line> = part.lines.iter().filter(|line| !run.dropped.contains(&line.id)).collect();
		if kept.is_empty() {
			body.push_str("<li class=\"empty\">—</li>");
		}
		for line in kept {
			let refs: Vec<String> = line
				.refs
				.iter()
				.filter_map(|reference| items.get(reference.as_str()))
				.map(|item| {
					let label = escape(item.id.split_once(':').map(|(_, rest)| rest).unwrap_or(&item.id));
					if item.url.is_empty() {
						format!("<span class=\"ref\">{label}</span>")
					} else {
						format!("<a class=\"ref\" href=\"{}\">{label}</a>", escape(&item.url))
					}
				})
				.collect();
			body.push_str(&format!(
				"<li><strong>{}</strong>{}{}</li>",
				escape(&line.title),
				if line.detail.is_empty() { String::new() } else { format!("<span class=\"detail\">{}</span>", escape(&line.detail)) },
				if refs.is_empty() { String::new() } else { format!("<span class=\"refs\">{}</span>", refs.join(" ")) },
			));
		}
		body.push_str("</ul>");
	}
	let silent: Vec<String> = run
		.sources
		.iter()
		.filter(|source| source.state == SourceState::Silent)
		.map(|source| source_label(&source.source))
		.collect();
	if !silent.is_empty() {
		body.push_str(&format!(
			"<p class=\"note\">{}</p>",
			escape(&crate::i18n::tf("automations.render.silent", &[("sources", &silent.join(", "))]))
		));
	}
	format!(
		r#"<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><title>{title}</title><style>
@page {{ size: A4; margin: 18mm 16mm; }}
body {{ font: 11pt/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #141a20; }}
h1 {{ font-size: 20pt; margin: 0 0 2pt; }}
.period {{ color: #525b69; font-size: 9.5pt; margin: 0 0 14pt; }}
.headline {{ font-size: 12pt; margin: 0 0 12pt; }}
h2 {{ font-size: 13pt; margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #d9dee4; color: #0f766e; }}
ul {{ list-style: none; padding: 0; margin: 0; }}
li {{ padding: 5pt 0; break-inside: avoid; }}
li strong {{ display: block; }}
.detail {{ display: block; color: #3d4552; }}
.refs {{ display: block; margin-top: 2pt; }}
.ref {{ font: 8.5pt ui-monospace, Menlo, monospace; color: #2f6fdb; text-decoration: none; margin-right: 8pt; }}
.empty {{ color: #858d9b; }}
.note {{ margin-top: 16pt; color: #a96300; font-size: 9.5pt; }}
</style></head><body><h1>{title}</h1><p class="period">{period}</p>{body}</body></html>"#,
		lang = crate::i18n::lang(),
		title = escape(&automation.name),
		period = escape(&crate::i18n::tf(
			"automations.render.period",
			&[("from", &local_stamp(&run.from)), ("to", &local_stamp(&run.to))]
		)),
	)
}

/// Le premier navigateur Chromium du poste : c'est lui qui sait mettre une
/// page en PDF sans fenêtre, ce que macOS n'offre pas en ligne de commande.
fn chromium() -> Option<PathBuf> {
	[
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Arc.app/Contents/MacOS/Arc",
	]
	.iter()
	.map(PathBuf::from)
	.find(|path| path.exists())
}

/// Où se rangent les PDF : un dossier par automatisation, visible du Finder.
pub fn exports_dir(id: &str) -> PathBuf {
	config_dir().join("automations").join(id)
}

/// Met le rendu en PDF, le range, et le note dans l'historique.
pub async fn export_pdf(id: &str, run: &str) -> Result<String> {
	let (automation, found) = find_run(id, run)?;
	let browser = chromium().ok_or_else(|| {
		CockpitError::msg(crate::i18n::t("automations.errors.noChromium"))
	})?;
	let dir = exports_dir(id);
	std::fs::create_dir_all(&dir)?;
	let stamp = DateTime::parse_from_rfc3339(&found.to)
		.map(|at| at.with_timezone(&Local).format("%Y-%m-%d-%Hh%M").to_string())
		.unwrap_or_else(|_| found.id.clone());
	let html = dir.join(format!("{stamp}.html"));
	let pdf = dir.join(format!("{stamp}.pdf"));
	std::fs::write(&html, render_html(&automation, &found))?;
	// Un profil jetable : sans lui, Chrome ouvert sur le poste refuserait de
	// partager le sien avec une seconde instance.
	let profile = std::env::temp_dir().join("cockpit-pdf-profile");
	let output = tokio::process::Command::new(&browser)
		.arg("--headless=new")
		.arg("--disable-gpu")
		.arg("--no-pdf-header-footer")
		.arg(format!("--user-data-dir={}", profile.display()))
		.arg(format!("--print-to-pdf={}", pdf.display()))
		.arg(format!("file://{}", html.display()))
		.kill_on_drop(true)
		.output();
	let output = tokio::time::timeout(std::time::Duration::from_secs(60), output)
		.await
		.map_err(|_| CockpitError::msg(crate::i18n::t("automations.errors.pdfTimeout")))??;
	let _ = std::fs::remove_file(&html);
	if !pdf.exists() {
		let detail = String::from_utf8_lossy(&output.stderr).trim().chars().take(200).collect::<String>();
		return Err(CockpitError::msg(crate::i18n::tf("automations.errors.pdfNotProduced", &[("detail", &detail)])));
	}
	let path = pdf.display().to_string();
	append(id, &Record::Exported { run: run.to_string(), at: Utc::now().to_rfc3339(), path: path.clone() });
	Ok(path)
}

/// Le rendu en texte Slack : gras entre astérisques, liens `<url|libellé>`.
pub fn render_slack(automation: &Automation, run: &Run) -> String {
	let items: HashMap<&str, &Item> = run.items.iter().map(|item| (item.id.as_str(), item)).collect();
	let mut text = format!(
		"*{}* — {}\n",
		automation.name,
		crate::i18n::tf(
			"automations.render.slackPeriod",
			&[("from", &local_stamp(&run.from)), ("to", &local_stamp(&run.to))]
		)
	);
	if !run.headline.is_empty() {
		text.push_str(&format!("{}\n", run.headline));
	}
	for part in &run.parts {
		let kept: Vec<&Line> = part.lines.iter().filter(|line| !run.dropped.contains(&line.id)).collect();
		if kept.is_empty() {
			continue;
		}
		text.push_str(&format!("\n*{}*\n", part.title));
		for line in kept {
			let links: Vec<String> = line
				.refs
				.iter()
				.filter_map(|reference| items.get(reference.as_str()))
				.filter(|item| !item.url.is_empty())
				.map(|item| format!("<{}|{}>", item.url, item.id.split_once(':').map(|(_, rest)| rest).unwrap_or(&item.id)))
				.collect();
			text.push_str(&format!(
				"• {}{}{}\n",
				line.title,
				if line.detail.is_empty() { String::new() } else { format!(" — {}", line.detail) },
				if links.is_empty() { String::new() } else { format!(" ({})", links.join(", ")) },
			));
		}
	}
	text
}

/// Publie le rendu sur Slack. Seulement sur un clic : c'est une publication.
pub async fn post_slack(id: &str, run: &str) -> Result<()> {
	let (automation, found) = find_run(id, run)?;
	let webhook = automation.slack_webhook.trim();
	if !webhook.starts_with("https://hooks.slack.com/") {
		return Err(CockpitError::msg(crate::i18n::t("automations.errors.noSlackWebhook")));
	}
	let response = reqwest::Client::new()
		.post(webhook)
		.json(&json!({ "text": render_slack(&automation, &found) }))
		.send()
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("automations.errors.slack", &[("error", &e)])))?;
	if !response.status().is_success() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"automations.errors.slackRefused",
			&[("status", &response.status())],
		)));
	}
	append(id, &Record::Posted { run: run.to_string(), at: Utc::now().to_rfc3339() });
	Ok(())
}

fn source_label(source: &str) -> String {
	match source {
		"github" => "GitHub",
		"tracker" => return crate::i18n::t("automations.sources.tracker"),
		"cockpit" => "Cockpit",
		"sentry" => "Sentry",
		other => other,
	}
	.to_string()
}

fn fail(app: &tauri::AppHandle, automation: &Automation, run: &str, reason: &str) {
	append(
		&automation.id,
		&Record::Failed { run: run.to_string(), at: Utc::now().to_rfc3339(), reason: reason.to_string() },
	);
	if automation.notify {
		let app = app.clone();
		let title = crate::i18n::tf("automations.notify.failed", &[("name", &automation.name)]);
		let body = reason.chars().take(160).collect::<String>();
		tauri::async_runtime::spawn(async move { notify(&app, &title, &body).await });
	}
}

async fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
	use tauri_plugin_notification::NotificationExt;
	let _ = crate::remote::wake(title, body, None).await;
	let _ = app.notification().builder().title(title).body(body).show();
}

/// Un tour de la boucle : ce qui est dû part, ce qui est passé se note manqué.
pub fn tick(app: &tauri::AppHandle) {
	let now = Local::now().naive_local();
	for automation in list() {
		let created = DateTime::parse_from_rfc3339(&automation.created_at)
			.map(|at| at.with_timezone(&Local).naive_local())
			.unwrap_or(now);
		let handled: HashSet<String> = runs(&automation.id).into_iter().map(|run| run.occurrence).collect();
		match decide(&automation, now, created, &handled) {
			Decision::Nothing => {}
			Decision::Run { occurrence, trigger } => {
				let _ = start(app.clone(), automation.clone(), occurrence_key(occurrence), trigger);
			}
			Decision::Miss { occurrence, reason } => {
				let run = format!("run-{:x}", Utc::now().timestamp_millis());
				append(
					&automation.id,
					&Record::Missed { run: run.clone(), at: Utc::now().to_rfc3339(), occurrence: occurrence_key(occurrence), reason },
				);
				announce(app, &automation.id, &run);
			}
		}
	}
}

/// La boucle de fond. Un premier tour tout de suite : c'est lui qui rattrape
/// ce que le cockpit fermé a laissé passer.
pub fn watch(app: tauri::AppHandle) {
	tauri::async_runtime::spawn(async move {
		loop {
			tick(&app);
			tokio::time::sleep(std::time::Duration::from_secs(30)).await;
		}
	});
}

// ───────────────────────────── Pour l'écran ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upcoming {
	/// Heure du rendez-vous, locale, `YYYY-MM-DDTHH:MM`.
	pub occurrence: String,
	/// Heure à laquelle le rendu doit être prêt.
	pub ready: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
	pub automation: Automation,
	pub runs: Vec<Run>,
	pub upcoming: Vec<Upcoming>,
	pub running: bool,
}

pub fn overview() -> Vec<Overview> {
	let now = Local::now().naive_local();
	let running = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
	list()
		.into_iter()
		.map(|automation| {
			let lead = Duration::minutes(automation.lead_minutes as i64);
			let upcoming = if automation.enabled {
				upcoming(&automation, now, 6)
					.into_iter()
					.map(|occurrence| Upcoming {
						occurrence: occurrence_key(occurrence),
						ready: occurrence_key(occurrence - lead),
					})
					.collect()
			} else {
				Vec::new()
			};
			let mut all = runs(&automation.id);
			all.truncate(40);
			let mut automation = automation;
			if !automation.slack_webhook.is_empty() {
				automation.slack_webhook = SECRET_MASK.to_string();
			}
			Overview {
				running: running.contains(&automation.id),
				runs: all,
				upcoming,
				automation,
			}
		})
		.collect()
}

/// Le dernier rendu de daily prêt, pour le tour de parole de son auteur.
///
/// Seulement s'il est d'aujourd'hui : celui de vendredi raconté lundi
/// présenterait comme récent ce qui ne l'est plus.
pub fn latest_daily() -> Option<Run> {
	let today = Local::now().date_naive();
	list()
		.into_iter()
		.filter(|automation| automation.template == "daily")
		.flat_map(|automation| runs(&automation.id))
		.filter(|run| matches!(run.state, RunState::Ready | RunState::Partial))
		.filter(|run| {
			DateTime::parse_from_rfc3339(&run.ended_at)
				.map(|at| at.with_timezone(&Local).date_naive() == today)
				.unwrap_or(false)
		})
		.max_by(|a, b| a.ended_at.cmp(&b.ended_at))
}

#[cfg(test)]
mod tests {
	use super::*;
	use chrono::NaiveDate;

	fn at(day: u32, hour: u32, minute: u32) -> NaiveDateTime {
		// Octobre 2026 : le 26 est un lundi.
		NaiveDate::from_ymd_opt(2026, 10, day).unwrap().and_hms_opt(hour, minute, 0).unwrap()
	}

	fn daily() -> Automation {
		Automation { id: "a".into(), name: "Mon daily".into(), template: "daily".into(), ..Default::default() }
	}

	#[test]
	fn le_rendez_vous_part_a_l_heure_de_preparation() {
		// Créée lundi matin : le rendez-vous de vendredi ne lui a jamais été promis.
		let created = at(26, 8, 0);
		let none = HashSet::new();
		assert_eq!(decide(&daily(), at(26, 13, 29), created, &none), Decision::Nothing);
		assert_eq!(
			decide(&daily(), at(26, 13, 31), created, &none),
			Decision::Run { occurrence: at(26, 14, 0), trigger: Trigger::Schedule }
		);
	}

	#[test]
	fn un_cockpit_ouvert_en_retard_rattrape_avant_le_rendez_vous() {
		let created = at(1, 0, 0);
		assert_eq!(
			decide(&daily(), at(26, 13, 52), created, &HashSet::new()),
			Decision::Run { occurrence: at(26, 14, 0), trigger: Trigger::CatchUp }
		);
	}

	#[test]
	fn apres_le_rendez_vous_c_est_manque_et_dit_une_seule_fois() {
		let created = at(1, 0, 0);
		assert!(matches!(decide(&daily(), at(26, 15, 10), created, &HashSet::new()), Decision::Miss { .. }));
		let handled: HashSet<String> = ["2026-10-26T14:00".to_string()].into();
		assert_eq!(decide(&daily(), at(26, 15, 10), created, &handled), Decision::Nothing);
	}

	#[test]
	fn un_rendez_vous_d_avant_la_creation_n_est_pas_manque() {
		assert_eq!(decide(&daily(), at(26, 15, 10), at(26, 15, 0), &HashSet::new()), Decision::Nothing);
	}

	#[test]
	fn le_lundi_couvre_le_week_end() {
		// Lundi 26, 9 h : le dernier rendez-vous dû est vendredi 23 à 14 h.
		assert_eq!(last_due(&daily(), at(26, 9, 0)), Some(at(23, 14, 0)));
		assert_eq!(upcoming(&daily(), at(26, 9, 0), 2), vec![at(26, 14, 0), at(28, 14, 0)]);
	}

	#[test]
	fn la_periode_part_de_la_derniere_reussite_hors_essais_a_la_main() {
		let records = vec![
			Record::Started { run: "r1".into(), at: "2026-10-23T11:30:00Z".into(), occurrence: "2026-10-23T14:00".into(), trigger: Trigger::Schedule, from: "2026-10-21T11:30:00Z".into(), to: "2026-10-23T11:30:00Z".into() },
			Record::Finished { run: "r1".into(), at: "2026-10-23T11:31:00Z".into(), headline: String::new(), items: vec![], parts: vec![], valuation: Valuation { usd: None, provenance: "none".into() }, duration_ms: 1, viewer: String::new() },
			Record::Started { run: "r2".into(), at: "2026-10-26T09:00:00Z".into(), occurrence: "manual-1".into(), trigger: Trigger::Manual, from: "2026-10-23T11:30:00Z".into(), to: "2026-10-26T09:00:00Z".into() },
			Record::Finished { run: "r2".into(), at: "2026-10-26T09:01:00Z".into(), headline: String::new(), items: vec![], parts: vec![], valuation: Valuation { usd: None, provenance: "none".into() }, duration_ms: 1, viewer: String::new() },
		];
		let history = fold("a", &records);
		let now = DateTime::parse_from_rfc3339("2026-10-26T11:30:00Z").unwrap().with_timezone(&Utc);
		assert_eq!(window_start(&daily(), &history, now).to_rfc3339(), "2026-10-23T11:30:00+00:00");
	}

	#[test]
	fn une_ligne_ecartee_se_lit_puis_se_remet() {
		let records = vec![
			Record::Dropped { run: "r".into(), at: "1".into(), line: "p0l1".into(), dropped: true },
			Record::Dropped { run: "r".into(), at: "2".into(), line: "p0l2".into(), dropped: true },
			Record::Dropped { run: "r".into(), at: "3".into(), line: "p0l1".into(), dropped: false },
		];
		assert_eq!(fold("a", &records)[0].dropped, vec!["p0l2".to_string()]);
	}

	#[test]
	fn une_reference_inventee_est_ecartee() {
		let items = vec![Item { id: "gh:acme/web#12".into(), source: "github".into(), title: "t".into(), url: String::new(), event: "merged".into(), detail: String::new(), at: String::new() }];
		let answer = "Voici :\n```json\n{\"headline\":\"h\",\"parts\":[{\"title\":\"Livré\",\"lines\":[{\"title\":\"A\",\"detail\":\"\",\"refs\":[\"gh:acme/web#12\",\"gh:acme/web#999\"]},{\"title\":\"B\",\"detail\":\"\",\"refs\":[\"tk:FAUX-1\"]}]}]}\n```";
		let (_, parts) = read_answer(answer, &items).unwrap();
		assert_eq!(parts[0].lines[0].refs, vec!["gh:acme/web#12".to_string()]);
		assert!(!parts[0].lines[0].unsourced);
		assert!(parts[0].lines[1].unsourced);
	}

	fn rendered() -> (Automation, Run) {
		let items = vec![Item { id: "gh:acme/web#12".into(), source: "github".into(), title: "t".into(), url: "https://github.com/acme/web/pull/12".into(), event: "merged".into(), detail: String::new(), at: String::new() }];
		let records = vec![
			Record::Started { run: "r".into(), at: "2026-10-26T11:30:00Z".into(), occurrence: "2026-10-26T14:00".into(), trigger: Trigger::Schedule, from: "2026-10-23T11:30:00Z".into(), to: "2026-10-26T11:30:00Z".into() },
			Record::Source { run: "r".into(), at: String::new(), source: "sentry".into(), state: SourceState::Unconfigured, count: 0, note: String::new() },
			Record::Finished {
				run: "r".into(),
				at: "2026-10-26T11:31:00Z".into(),
				headline: "Semaine <calme> & courte".into(),
				items,
				parts: vec![Part {
					title: "Livré".into(),
					lines: vec![
						Line { id: "p0l0".into(), title: "Le catalogue".into(), detail: "Fusionné.".into(), refs: vec!["gh:acme/web#12".into()], unsourced: false },
						Line { id: "p0l1".into(), title: "Les dépendances".into(), detail: String::new(), refs: vec![], unsourced: true },
					],
				}],
				valuation: Valuation { usd: None, provenance: "none".into() },
				duration_ms: 1,
				viewer: String::new(),
			},
			Record::Dropped { run: "r".into(), at: String::new(), line: "p0l1".into(), dropped: true },
		];
		(daily(), fold("a", &records).remove(0))
	}

	#[test]
	fn une_source_non_branchee_ne_rend_pas_le_rendu_partiel() {
		assert_eq!(rendered().1.state, RunState::Ready);
	}

	#[test]
	fn le_pdf_echappe_le_texte_et_tait_les_lignes_ecartees() {
		let (automation, run) = rendered();
		let html = render_html(&automation, &run);
		assert!(html.contains("Semaine &lt;calme&gt; &amp; courte"));
		assert!(html.contains("Le catalogue"));
		assert!(!html.contains("Les dépendances"));
		assert!(html.contains("href=\"https://github.com/acme/web/pull/12\""));
	}

	#[test]
	fn le_texte_slack_lie_ses_sources() {
		let (automation, run) = rendered();
		let text = render_slack(&automation, &run);
		assert!(text.contains("*Livré*"));
		assert!(text.contains("• Le catalogue — Fusionné. (<https://github.com/acme/web/pull/12|acme/web#12>)"));
		assert!(!text.contains("dépendances"));
	}

}
