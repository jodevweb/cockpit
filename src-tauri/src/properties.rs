//! Ce qui doit rester vrai, et la preuve que le garde-fou sait échouer.
//!
//! Un développeur qui n'écrit plus le code ne peut pas tout relire. Il lui faut
//! des propriétés vérifiables qui tiennent quel que soit l'auteur du diff — huit
//! lignes à regarder au lieu de huit cents. C'est ce que ce module rend : un
//! verdict par propriété, avec la preuve, sur un changement donné.
//!
//! **Le piège est connu d'avance.** Un juge qui répond toujours « conforme » ne
//! vaut rien, et il répondra toujours conforme si personne ne le calibre. Pire :
//! il rassurera, ce qui est plus dangereux que de ne rien avoir.
//!
//! La parade est dans le dépôt lui-même. Tout dépôt corrige des bugs, et chaque
//! correction est un cas d'échec gratuit : le code d'avant était fautif, et on
//! sait exactement en quoi puisqu'on voit ce qui a été changé. Rejouer une
//! propriété sur ces corrections dit si elle attrape quelque chose. Celle qui
//! n'attrape jamais rien est **décorative**, et le cockpit doit le dire — un
//! garde-fou qui n'a jamais rien signalé n'est pas un bon signe, c'est un
//! soupçon.
//!
//! Rien n'est fourni par défaut : une propriété inventée ici décrirait le métier
//! de celui qui l'a écrite. Le dépôt les déclare, ou le cockpit lui en propose
//! d'après ses propres corrections.

use crate::config::{config_dir, Config, PropertyConfig};
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Au-delà, on ne vérifie pas : chaque propriété coûte un agent, et une liste
/// qui s'allonge sans fin finit par coûter plus que la relecture qu'elle
/// remplace.
const MAX_PROPERTIES: usize = 8;

/// Corrections rejouées lors d'une calibration.
///
/// Assez pour distinguer une propriété qui attrape de celle qui ne voit rien,
/// sans y passer l'après-midi : c'est un test du garde-fou, pas un audit du
/// passé.
const CALIBRATION_SAMPLES: usize = 6;

/// Ce que le diff d'une correction peut peser dans une calibration.
const MAX_FIX_CHARS: usize = 20_000;

/// Le verdict d'une propriété sur un changement.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Check {
	pub property_id: String,
	/// L'énoncé, recopié : un verdict doit rester lisible seul.
	pub text: String,
	/// `tenue` · `enfreinte` · `hors sujet` · `indécis`.
	pub verdict: String,
	/// Ce sur quoi l'agent s'appuie — `fichier:ligne`, autant que possible.
	pub evidence: Vec<String>,
	/// Une phrase : ce qui est en cause, ou pourquoi la propriété ne s'applique
	/// pas ici.
	pub note: String,
	pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
	pub key: String,
	pub head_sha: String,
	pub at: u64,
	pub checks: Vec<Check>,
	pub cost_usd: f64,
	pub duration_seconds: u64,
}

impl Audit {
	pub fn broken(&self) -> usize {
		self.checks
			.iter()
			.filter(|check| check.verdict == "enfreinte")
			.count()
	}
}

/// Une correction du dépôt rejouée contre une propriété.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
	pub sha: String,
	pub subject: String,
	/// La propriété aurait-elle signalé le problème avant cette correction ?
	pub caught: bool,
	pub note: String,
}

/// Ce qu'une propriété vaut, mesuré sur de vraies corrections.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
	pub property_id: String,
	pub at: u64,
	pub tried: usize,
	pub caught: usize,
	pub samples: Vec<Sample>,
	pub cost_usd: f64,
}

impl Calibration {
	/// Une propriété qui n'a rien attrapé sur un échantillon réel est
	/// décorative : elle rassure sans rien garantir, ce qui est pire que son
	/// absence.
	pub fn decorative(&self) -> bool {
		self.tried > 0 && self.caught == 0
	}
}

// ── Où vivent les verdicts ──────────────────────────────────────────────────

fn properties_dir() -> PathBuf {
	config_dir().join("properties")
}

fn slug(value: &str) -> String {
	value
		.chars()
		.map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
		.collect()
}

fn audit_path(key: &str) -> PathBuf {
	properties_dir().join(format!("{}.audit.json", slug(key)))
}

fn calibration_path(project: &str) -> PathBuf {
	properties_dir().join(format!("{}.calibration.json", slug(project)))
}

pub fn read_audit(key: &str) -> Option<Audit> {
	serde_json::from_str(&std::fs::read_to_string(audit_path(key)).ok()?).ok()
}

pub fn read_calibrations(project: &str) -> Vec<Calibration> {
	std::fs::read_to_string(calibration_path(project))
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
	std::fs::create_dir_all(properties_dir())
		.map_err(|e| CockpitError::msg(crate::i18n::tf("properties.errors.folder", &[("error", &e)])))?;
	let raw = serde_json::to_string_pretty(value)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("properties.errors.serialize", &[("error", &e)])))?;
	std::fs::write(path, raw)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("properties.errors.write", &[("error", &e)])))
}

fn now() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0)
}

// ── Vérifier un changement ──────────────────────────────────────────────────

/// Ce qu'on demande au juge d'une propriété.
///
/// Un agent par propriété, et non un agent pour toutes : à qui l'on donne huit
/// règles d'un coup, on obtient huit avis tièdes et mélangés. Une seule question
/// donne un verdict net, et une preuve qu'on peut aller vérifier.
///
/// « Hors sujet » est une réponse à part entière, et il faut le dire : sans
/// elle, une propriété sur les migrations conclut « tenue » sur un diff qui n'en
/// contient aucune, et ce faux vert compte comme une garantie.
fn judge_prompt(property: &PropertyConfig, dossier: &str) -> String {
	format!(
		"You are checking **a single** property on a code change. Not a review, not a general \
		 opinion: this property, and nothing else.\n\n\
		 ## The property\n\n{}\n\n\
		 ## What you return\n\n\
		 Exactly this form, nothing before, nothing after. Keep the markers `Verdict:`, \
		 `Evidence:`, `Note:` and the verdict words in English exactly:\n\n\
		 Verdict: held | broken | off-topic | undecided\n\
		 Evidence: <one or more `file:line`, separated by commas — leave empty if you have \
		 nothing to show>\n\
		 Note: <one sentence. If broken: what breaks it, concretely. If held: what you checked \
		 to claim it. If off-topic: why this change does not touch what the property \
		 describes.>\n\n\
		 \"off-topic\" is the right answer when the change is not about what the property talks \
		 about — it is common, and far more useful than a complacent \"held\" that would read as \
		 a guarantee.\n\n\
		 \"undecided\" is the right answer when you cannot decide without reading what you do \
		 not have. Say what is missing.\n\n\
		 Do not conclude from the diff alone: you are in the repository, go read the surrounding \
		 code. You cannot modify anything.\n\n\
		 {}\n\n\
		 ## The change\n\n{dossier}",
		property.text.trim(),
		crate::i18n::reply_directive()
	)
}

/// Les propriétés qui concernent les fichiers touchés.
fn applicable(properties: &[PropertyConfig], files: &[String]) -> Vec<PropertyConfig> {
	properties
		.iter()
		.filter(|property| !property.text.trim().is_empty())
		.filter(|property| {
			if property.scope.is_empty() || files.is_empty() {
				return true;
			}
			property.scope.iter().any(|scope| {
				let scope = scope.trim().trim_end_matches('/');
				!scope.is_empty() && files.iter().any(|file| file.starts_with(scope))
			})
		})
		.take(MAX_PROPERTIES)
		.cloned()
		.collect()
}

/// Juge un changement, propriété par propriété.
pub async fn audit(key: String) -> Result<Audit> {
	let started = now();
	let project_id = key
		.strip_prefix("local:")
		.and_then(|rest| rest.split('@').next())
		.map(|id| id.to_string());
	let scan = crate::monitor::scan(project_id.as_deref()).await?;
	let change = scan
		.changes
		.into_iter()
		.find(|change| change.key == key)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("properties.errors.changeGone")))?;

	let base = Config::load();
	let cloisonne = base.projects.len() > 1;
	let mut config = base.clone();
	if let Some(project) = base.projects.iter().find(|p| p.id == change.project) {
		project.merge_into(&mut config, cloisonne);
	}

	if config.properties.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("properties.errors.noneDeclared")));
	}

	// Les fichiers du changement décident de ce qui s'applique : juger une
	// propriété sur un diff qui ne la concerne pas coûte un agent pour un
	// « hors sujet » qu'on pouvait prévoir.
	let files = changed_files(&change).await;
	let retained = applicable(&config.properties, &files);
	if retained.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("properties.errors.noneApplicable")));
	}

	let dossier = crate::impact::dossier(&change, &config).await?;
	let cwd = [
		change.worktree.clone(),
		change.repo_path.clone(),
		std::env::temp_dir().to_string_lossy().to_string(),
	]
	.into_iter()
	.find(|candidate| !candidate.is_empty() && std::path::Path::new(candidate).is_dir())
	.ok_or_else(|| CockpitError::msg(crate::i18n::t("properties.errors.noWorkdir")))?;

	let settings = config.impact.clone();
	let verdicts = futures::future::join_all(retained.iter().map(|property| {
		let prompt = judge_prompt(property, &dossier);
		let cwd = cwd.clone();
		let settings = settings.clone();
		async move {
			let rendu = crate::agent::run_once(
				&cwd,
				&prompt,
				&settings.engine,
				&settings.model,
				"",
				&["Write", "Edit", "MultiEdit", "NotebookEdit"],
				crate::executions::Origin::cockpit("propriete-audit"),
			)
			.await;
			(property, rendu)
		}
	}))
	.await;

	let mut checks = Vec::new();
	let mut cost = 0.0;
	for (property, rendu) in verdicts {
		match rendu {
			Ok(rendu) => {
				cost += rendu.cost_usd;
				let mut check = parse_check(&rendu.text);
				check.property_id = property.id.clone();
				check.text = property.text.clone();
				check.cost_usd = rendu.cost_usd;
				checks.push(check);
			}
			// Un juge muet ne dit pas « conforme » : il dit qu'il n'a pas jugé.
			// Confondre les deux transformerait une panne en garantie.
			Err(error) => checks.push(Check {
				property_id: property.id.clone(),
				text: property.text.clone(),
				verdict: "indécis".into(),
				note: crate::i18n::tf("properties.judgeSilent", &[("error", &error)]),
				..Default::default()
			}),
		}
	}

	let audit = Audit {
		key: key.clone(),
		head_sha: change.head_sha.clone(),
		at: now(),
		cost_usd: cost,
		duration_seconds: now().saturating_sub(started),
		checks,
	};
	write_json(&audit_path(&key), &audit)?;
	crate::journal::record(
		"impact",
		&crate::i18n::t("properties.journal.label"),
		&format!("{} {}", change.repo, change.reference),
		true,
		&crate::i18n::tf("properties.journal.broken", &[("count", &audit.broken())]),
	);
	Ok(audit)
}

/// Les fichiers touchés par un changement, pour filtrer les propriétés.
async fn changed_files(change: &crate::monitor::Change) -> Vec<String> {
	if change.repo_path.is_empty() {
		return Vec::new();
	}
	let repo = PathBuf::from(&change.repo_path);
	crate::git::run_git(
		&repo,
		&[
			"diff",
			"--name-only",
			&format!("{}...{}", change.base, change.branch),
		],
	)
	.await
	.map(|raw| {
		raw.lines()
			.map(|line| line.trim().to_string())
			.filter(|line| !line.is_empty())
			.collect()
	})
	.unwrap_or_default()
}

// ── Calibrer sur les corrections du dépôt ───────────────────────────────────

/// Mots qui, dans un sujet de commit, annoncent une correction.
///
/// Les trois premiers viennent des commits conventionnels, qui sont un standard
/// et non l'habitude d'une équipe. Les suivants couvrent ce que les gens
/// écrivent quand ils ne les suivent pas — en français comme en anglais. Aucun
/// n'est propre à un projet : c'est ce qui rend la calibration possible dans
/// n'importe quel dépôt.
const FIX_MARKERS: [&str; 12] = [
	"fix:", "fix(", "hotfix", "revert", "bugfix", "correctif", "corrige", "répare", "repare",
	"regression", "régression", "patch:",
];

/// Sujet de commit qui ressemble à une correction.
pub fn looks_like_fix(subject: &str) -> bool {
	let lower = subject.to_lowercase();
	// Un mot-clé en tête ou dans le sujet, mais jamais « prefix » ou
	// « suffixe » : le marqueur doit commencer un mot.
	FIX_MARKERS.iter().any(|marker| {
		lower.match_indices(marker).any(|(at, _)| {
			at == 0
				|| lower[..at]
					.chars()
					.next_back()
					.is_some_and(|c| !c.is_alphanumeric())
		})
	})
}

/// Les corrections récentes du dépôt, les plus fraîches d'abord.
async fn recent_fixes(repo: &Path, limit: usize) -> Vec<(String, String)> {
	let Ok(raw) = crate::git::run_git(
		repo,
		&[
			"log",
			"-400",
			"--no-merges",
			"--format=%H%x1f%s",
		],
	)
	.await
	else {
		return Vec::new();
	};
	raw.lines()
		.filter_map(|line| {
			let mut parts = line.split('\u{1f}');
			let sha = parts.next()?.trim().to_string();
			let subject = parts.next()?.trim().to_string();
			looks_like_fix(&subject).then_some((sha, subject))
		})
		.take(limit)
		.collect()
}

/// Ce qu'on demande au juge d'une calibration.
///
/// La question est posée à l'envers d'une vérification : on ne demande pas si
/// le code est bon, mais si la propriété *aurait servi*. C'est la seule façon de
/// savoir qu'un garde-fou sait échouer sans attendre le prochain incident.
fn calibration_prompt(property: &PropertyConfig, subject: &str, diff: &str) -> String {
	format!(
		"Here is a fix actually made to this repository. The code before it was therefore \
		 faulty, and the diff shows how.\n\n\
		 Your question: would the property below, applied to the code **before** this fix, \
		 have flagged the problem?\n\n\
		 ## The property\n\n{}\n\n\
		 Be strict. A property that \"might have drawn attention\" would have caught nothing: \
		 answer no. Answer yes only if the earlier state clearly breaks what the property \
		 states.\n\n\
		 ## What you return\n\n\
		 Keep the markers `Caught:` and `Note:` and the words yes/no in English exactly.\n\n\
		 Caught: yes | no\n\
		 Note: one sentence saying why.\n\n\
		 {}\n\n\
		 ## The fix ({subject})\n\n```diff\n{diff}\n```",
		property.text.trim(),
		crate::i18n::reply_directive()
	)
}

/// Rejoue une propriété sur les corrections passées du dépôt.
pub async fn calibrate(project: String, property_id: String) -> Result<Calibration> {
	let config = Config::for_repo(&project);
	let property = config
		.properties
		.iter()
		.find(|entry| entry.id == property_id)
		.cloned()
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("properties.errors.propertyGone")))?;

	let repo = PathBuf::from(&project);
	if !repo.is_dir() {
		return Err(CockpitError::msg(crate::i18n::t("properties.errors.repoMissing")));
	}

	let fixes = recent_fixes(&repo, CALIBRATION_SAMPLES).await;
	if fixes.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("properties.errors.noFixesCalibration")));
	}

	let settings = config.impact.clone();
	let jugements = futures::future::join_all(fixes.iter().map(|(sha, subject)| {
		let property = property.clone();
		let repo = repo.clone();
		let settings = settings.clone();
		let sha = sha.clone();
		let subject = subject.clone();
		async move {
			let diff = crate::git::run_git(&repo, &["show", "--no-color", &sha])
				.await
				.unwrap_or_default();
			let diff: String = diff.chars().take(MAX_FIX_CHARS).collect();
			let rendu = crate::agent::run_once(
				&repo.to_string_lossy(),
				&calibration_prompt(&property, &subject, &diff),
				&settings.engine,
				&settings.model,
				"",
				&["Write", "Edit", "MultiEdit", "NotebookEdit"],
				crate::executions::Origin::cockpit("propriete-calibration"),
			)
			.await;
			(sha, subject, rendu)
		}
	}))
	.await;

	let mut samples = Vec::new();
	let mut cost = 0.0;
	for (sha, subject, rendu) in jugements {
		let Ok(rendu) = rendu else { continue };
		cost += rendu.cost_usd;
		let (caught, note) = parse_calibration(&rendu.text);
		samples.push(Sample {
			sha: sha.chars().take(8).collect(),
			subject,
			caught,
			note,
		});
	}

	let calibration = Calibration {
		property_id: property_id.clone(),
		at: now(),
		tried: samples.len(),
		caught: samples.iter().filter(|sample| sample.caught).count(),
		samples,
		cost_usd: cost,
	};

	let mut all = read_calibrations(&project);
	all.retain(|entry| entry.property_id != property_id);
	all.push(calibration.clone());
	write_json(&calibration_path(&project), &all)?;
	Ok(calibration)
}

// ── Proposer des propriétés ─────────────────────────────────────────────────

/// Ce qu'on demande à l'agent qui propose des propriétés.
///
/// Il part des corrections du dépôt, et non de bonnes pratiques générales :
/// « valide tes entrées » est vrai partout et n'apprend rien : ce qu'on cherche
/// est ce que *ce* dépôt a déjà cassé, parce que c'est ce qu'il cassera encore.
fn suggest_prompt(fixes: &str) -> String {
	format!(
		"Here are the subjects of this repository's recent fixes: what it actually had to \
		 repair.\n\n{fixes}\n\n\
		 You are in the repository. Read what you need to understand what keeps coming back.\n\n\
		 Propose three to five **properties**: things that must stay true in this code, phrased \
		 so that a reviewer can tell whether a diff breaks them or not.\n\n\
		 What makes a good property here:\n\
		 - it comes from a problem this repository has already had, not from a general best \
		 practice;\n\
		 - it can be checked on a diff, without running the code;\n\
		 - it is not already covered by the repository's tools — propose nothing that a linter, \
		 a compiler or an existing test already catches.\n\n\
		 Return one property per block, exactly in this form, nothing else. Keep the markers \
		 `Property:`, `Scope:`, `Why:` and the word `all` in English exactly:\n\n\
		 Property: <the statement, one sentence, in the indicative>\n\
		 Scope: <affected paths separated by commas, or `all`>\n\
		 Why: <the fix or the kind of incident that justifies it>\n\n\
		 {directive}\n\n\
		 You cannot modify anything.",
		directive = crate::i18n::reply_directive()
	)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
	pub text: String,
	pub scope: Vec<String>,
	/// Ce qui la justifie, tiré de l'historique — c'est ce qui permet de juger
	/// si elle mérite d'être retenue.
	pub why: String,
}

/// Propose des propriétés d'après ce que le dépôt a déjà eu à corriger.
pub async fn suggest(project: String) -> Result<Vec<Suggestion>> {
	let repo = PathBuf::from(&project);
	if !repo.is_dir() {
		return Err(CockpitError::msg(crate::i18n::t("properties.errors.repoMissing")));
	}
	let fixes = recent_fixes(&repo, 40).await;
	if fixes.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("properties.errors.noFixesSuggest")));
	}

	let listing = fixes
		.iter()
		.map(|(_, subject)| format!("- {subject}"))
		.collect::<Vec<_>>()
		.join("\n");

	let config = Config::for_repo(&project);
	let rendu = crate::agent::run_once(
		&project,
		&suggest_prompt(&listing),
		&config.impact.engine,
		&config.impact.model,
		&config.impact.depth,
		&["Write", "Edit", "MultiEdit", "NotebookEdit"],
		crate::executions::Origin::cockpit("propriete-suggestion"),
	)
	.await?;

	let found = parse_suggestions(&rendu.text);
	if found.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("properties.errors.nothingUsable")));
	}
	Ok(found)
}

// ── Relecture de ce que les agents ont écrit ────────────────────────────────

fn after(line: &str, prefixes: &[&str]) -> Option<String> {
	for prefix in prefixes {
		if let Some(rest) = line.strip_prefix(prefix) {
			return Some(rest.trim().trim_start_matches(':').trim().to_string());
		}
	}
	None
}

fn parse_check(text: &str) -> Check {
	let mut check = Check {
		verdict: "indécis".into(),
		..Default::default()
	};
	let mut notes = Vec::new();

	for line in text.lines() {
		let line = line.trim();
		if line.is_empty() {
			continue;
		}
		let lower = line.to_lowercase();
		if lower.starts_with("verdict") {
			// Les marqueurs anglais d'aujourd'hui, et les français des
			// réponses plus anciennes. Les valeurs gardées restent celles
			// d'origine : l'interface les compare.
			check.verdict = if lower.contains("enfreinte")
				|| lower.contains("enfreint")
				|| lower.contains("broken")
				|| lower.contains("violated")
			{
				"enfreinte".into()
			} else if lower.contains("hors sujet")
				|| lower.contains("hors-sujet")
				|| lower.contains("off-topic")
				|| lower.contains("off topic")
			{
				"hors sujet".into()
			} else if lower.contains("tenue") || lower.contains("held") || lower.contains("holds") {
				"tenue".into()
			} else {
				"indécis".into()
			};
			continue;
		}
		if let Some(rest) = after(line, &["Preuves", "Preuve", "Evidence"]) {
			check.evidence = rest
				.split(',')
				.map(|part| part.trim().trim_matches('`').to_string())
				.filter(|part| !part.is_empty())
				.collect();
			continue;
		}
		if let Some(rest) = after(line, &["Note"]) {
			notes.push(rest);
			continue;
		}
		if notes.is_empty() && !line.starts_with('#') {
			notes.push(line.to_string());
		}
	}

	check.note = notes.join(" ").chars().take(400).collect();
	check
}

fn parse_calibration(text: &str) -> (bool, String) {
	let mut caught = false;
	let mut notes = Vec::new();
	for line in text.lines() {
		let line = line.trim();
		let lower = line.to_lowercase();
		if lower.starts_with("attrapé") || lower.starts_with("attrape") || lower.starts_with("caught") {
			// « non » d'abord : « oui » se retrouve dans « non, oui aurait… »
			// bien plus souvent que l'inverse. Anglais aujourd'hui, français
			// dans les réponses plus anciennes.
			let words: Vec<&str> = lower
				.split(|c: char| !c.is_alphanumeric())
				.filter(|word| !word.is_empty())
				.collect();
			let no = words.iter().any(|word| *word == "non" || *word == "no");
			let yes = words.iter().any(|word| *word == "oui" || *word == "yes");
			caught = !no && yes;
			continue;
		}
		if let Some(rest) = after(line, &["Note"]) {
			notes.push(rest);
			continue;
		}
		if notes.is_empty() && !line.is_empty() && !line.starts_with('#') {
			notes.push(line.to_string());
		}
	}
	(caught, notes.join(" ").chars().take(300).collect())
}

fn parse_suggestions(text: &str) -> Vec<Suggestion> {
	let mut found: Vec<Suggestion> = Vec::new();
	for line in text.lines() {
		let line = line.trim().trim_start_matches(['-', '*', ' ']);
		if let Some(rest) = after(line, &["Propriété", "Propriete", "Property"]) {
			if !rest.is_empty() {
				found.push(Suggestion {
					text: rest,
					..Default::default()
				});
			}
			continue;
		}
		let Some(current) = found.last_mut() else {
			continue;
		};
		if let Some(rest) = after(line, &["Portée", "Portee", "Scope"]) {
			if !rest.eq_ignore_ascii_case("tout")
				&& !rest.trim_matches('`').eq_ignore_ascii_case("all")
			{
				current.scope = rest
					.split(',')
					.map(|part| part.trim().trim_matches('`').to_string())
					.filter(|part| !part.is_empty())
					.collect();
			}
			continue;
		}
		if let Some(rest) = after(line, &["Pourquoi", "Why"]) {
			current.why = rest;
		}
	}
	found.retain(|entry| entry.text.len() > 10);
	found
}

#[cfg(test)]
mod tests {
	use super::*;

	fn property(id: &str, scope: &[&str]) -> PropertyConfig {
		PropertyConfig {
			id: id.into(),
			text: "Les migrations savent se défaire.".into(),
			scope: scope.iter().map(|s| s.to_string()).collect(),
		}
	}

	#[test]
	fn une_propriete_ne_se_juge_que_dans_sa_portee() {
		let list = vec![property("a", &["db/"]), property("b", &[])];
		let files = vec!["apps/web/page.tsx".to_string()];
		let kept = applicable(&list, &files);
		assert_eq!(kept.len(), 1, "seule la propriété sans portée s'applique");
		assert_eq!(kept[0].id, "b");
	}

	#[test]
	fn sans_fichiers_connus_toutes_les_proprietes_valent() {
		let list = vec![property("a", &["db/"])];
		assert_eq!(applicable(&list, &[]).len(), 1);
	}

	/// La reconnaissance d'une correction doit marcher dans n'importe quel
	/// dépôt, et ne pas se déclencher sur un mot qui contient le marqueur.
	#[test]
	fn une_correction_se_reconnait_sans_convention_d_equipe() {
		assert!(looks_like_fix("fix: le total du panier ignorait les remises"));
		assert!(looks_like_fix("fix(api): 500 sur une session absente"));
		assert!(looks_like_fix("Revert \"ajoute le cache\""));
		assert!(looks_like_fix("Corrige la reprise après un paiement refusé"));
		assert!(looks_like_fix("hotfix production"));

		assert!(!looks_like_fix("feat: ajoute le multi-langue"));
		assert!(!looks_like_fix("Refactor du prefixe des routes"));
		assert!(!looks_like_fix("Documente l'API"));
	}

	#[test]
	fn un_verdict_bien_forme_se_relit() {
		let check = parse_check(
			"Verdict: enfreinte\n\
			 Preuve: apps/api/routes.ts:42, apps/api/routes.ts:57\n\
			 Note: la route accepte un corps non validé.",
		);
		assert_eq!(check.verdict, "enfreinte");
		assert_eq!(check.evidence.len(), 2);
		assert!(check.note.contains("non validé"));
	}

	/// Le faux vert est le danger de tout ce module : un juge muet ou illisible
	/// ne doit jamais ressortir « tenue ».
	#[test]
	fn un_verdict_illisible_reste_indecis() {
		assert_eq!(parse_check("").verdict, "indécis");
		assert_eq!(parse_check("je ne sais pas trop").verdict, "indécis");
	}

	#[test]
	fn le_hors_sujet_ne_se_confond_pas_avec_le_conforme() {
		let check = parse_check("Verdict: hors sujet\nNote: aucune migration ici.");
		assert_eq!(check.verdict, "hors sujet");
	}

	#[test]
	fn un_verdict_anglais_se_relit_comme_l_ancien_francais() {
		let check = parse_check(
			"Verdict: broken\n\
			 Evidence: apps/api/routes.ts:42\n\
			 Note: the route accepts an unvalidated body.",
		);
		assert_eq!(check.verdict, "enfreinte");
		assert_eq!(check.evidence, vec!["apps/api/routes.ts:42"]);
		assert!(check.note.contains("unvalidated"));
		assert_eq!(parse_check("Verdict: off-topic").verdict, "hors sujet");
		assert_eq!(parse_check("Verdict: held").verdict, "tenue");
		assert_eq!(parse_check("Verdict: undecided").verdict, "indécis");
		assert_eq!(parse_check("Verdict: tenue").verdict, "tenue");
	}

	#[test]
	fn une_calibration_anglaise_se_relit() {
		assert!(parse_calibration("Caught: yes\nNote: no validation on the route.").0);
		assert!(!parse_calibration("Caught: no\nNote: unrelated.").0);
		assert_eq!(parse_calibration("Caught: yes\nNote: unrelated.").1, "unrelated.");
	}

	#[test]
	fn les_propositions_anglaises_se_relisent() {
		let found = parse_suggestions(
			"Property: Every API route validates its body before touching the database.\n\
			 Scope: apps/api, apps/jobs\n\
			 Why: three 500 fixes on malformed bodies.\n\n\
			 Property: Migrations can be rolled back.\n\
			 Scope: all\n\
			 Why: an impossible rollback in March.",
		);
		assert_eq!(found.len(), 2);
		assert_eq!(found[0].scope, vec!["apps/api", "apps/jobs"]);
		assert!(found[1].scope.is_empty());
		assert!(found[0].why.contains("500"));
	}

	#[test]
	fn une_calibration_se_relit_dans_les_deux_sens() {
		assert_eq!(
			parse_calibration("Attrapé: oui\nNote: la route n'avait pas de validation.").0,
			true
		);
		assert_eq!(parse_calibration("Attrapé: non\nNote: sans rapport.").0, false);
	}

	/// Le verdict qui compte : une propriété qui n'attrape rien sur de vraies
	/// corrections rassure sans rien garantir.
	#[test]
	fn une_propriete_qui_n_attrape_rien_est_decorative() {
		let mut calibration = Calibration {
			tried: 6,
			caught: 0,
			..Default::default()
		};
		assert!(calibration.decorative());

		calibration.caught = 1;
		assert!(!calibration.decorative());

		// Jamais calibrée : on ne sait rien, et on ne l'accuse de rien.
		calibration.tried = 0;
		calibration.caught = 0;
		assert!(!calibration.decorative());
	}

	#[test]
	fn les_propositions_se_relisent_en_blocs() {
		let found = parse_suggestions(
			"Propriété: Toute route API valide son corps avant de toucher la base.\n\
			 Portée: apps/api\n\
			 Pourquoi: trois correctifs de 500 sur des corps mal formés.\n\n\
			 Propriété: Les migrations savent se défaire.\n\
			 Portée: tout\n\
			 Pourquoi: un retour arrière impossible en mars.",
		);
		assert_eq!(found.len(), 2);
		assert_eq!(found[0].scope, vec!["apps/api"]);
		assert!(found[1].scope.is_empty(), "« tout » vaut absence de portée");
		assert!(found[0].why.contains("500"));
	}
}
