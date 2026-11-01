//! Le carnet du projet : ce qu'on a déjà eu à reprendre derrière un agent.
//!
//! Un agent rend son travail, on le relit, on corrige deux ou trois choses à la
//! main, et c'est fini : la correction reste dans le dépôt, jamais dans ce que
//! l'agent suivant saura. La même reprise se refait la semaine d'après.
//!
//! **Ce diff-là est le meilleur signal qui existe.** Ce n'est pas un avis sur
//! un agent, c'est ce qu'un humain a jugé nécessaire de changer après lecture —
//! le seul retour qui ne soit ni une note ni une impression. Et le cockpit est
//! le seul endroit qui puisse le voir : il connaît le worktree, l'instant où
//! l'agent a rendu la main, et ce qui a bougé après.
//!
//! Le mécanisme tient en deux gestes :
//!
//! - **Sceller** — à la fin de chaque tour, on copie les fichiers que le
//!   worktree porte. C'est l'état livré.
//! - **Comparer** — avant le tour suivant, ou quand on vient regarder, on
//!   compare le worktree à ce sceau. Ce qui a bougé entre les deux n'a pu être
//!   fait que par un humain, puisqu'aucun agent ne tournait.
//!
//! Trois garde-fous, sans lesquels ce carnet ferait plus de mal que de bien :
//!
//! - **Rien n'entre sans qu'on l'ait validé.** Une leçon tirée automatiquement
//!   et rangée en silence deviendrait une consigne permanente que personne n'a
//!   écrite, et que personne ne saurait retrouver pour la corriger.
//! - **Une leçon a une portée.** Elle ne remonte que sur les fichiers qu'elle
//!   concerne : une mémoire qui parle tout le temps n'est plus lue.
//! - **Ce qui ne sert pas s'efface.** Chaque leçon compte ses emplois ; celles
//!   qui n'en ont aucun au bout d'un moment sont signalées. Une mémoire qui ne
//!   fait que grossir devient du bruit, et le bruit dégrade ce qu'on injecte.

use crate::config::config_dir;
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Au-delà, on ne scelle pas : un worktree qui porte deux cents fichiers
/// modifiés n'est pas un rendu d'agent, c'est un chantier, et le diff qu'on en
/// tirerait n'apprendrait rien.
const MAX_SEALED_FILES: usize = 60;

/// Au-delà, un fichier n'est pas scellé — données, image, fichier généré.
const MAX_SEALED_BYTES: u64 = 400_000;

/// Ce que la reprise transmise à l'agent qui en tire une leçon peut peser.
const MAX_PATCH_CHARS: usize = 30_000;

/// Sans emploi passé ce délai, une leçon est proposée à l'oubli.
const STALE_AFTER_DAYS: u64 = 60;

/// Une leçon retenue.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lesson {
	pub id: String,
	/// Ce qu'il faut faire, ou ne plus faire. Une à trois phrases.
	pub text: String,
	/// Fichiers ou dossiers concernés : c'est ce qui décide si elle remonte.
	pub scope: Vec<String>,
	/// `reprise` (tirée d'une correction) · `main` (écrite à la main).
	pub source: String,
	/// Dépôt principal auquel elle appartient — une leçon ne traverse pas les
	/// projets.
	pub project: String,
	pub at: u64,
	/// Combien de fois elle a été jointe à un agent.
	#[serde(default)]
	pub uses: usize,
	#[serde(default)]
	pub last_used: u64,
}

/// Une reprise en main détectée, en attente d'être lue.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Handback {
	pub id: String,
	pub cwd: String,
	pub project: String,
	pub branch: String,
	pub at: u64,
	/// Fichiers repris, relatifs au worktree.
	pub files: Vec<String>,
	/// Ce que l'humain a changé par-dessus le rendu, en diff unifié.
	pub patch: String,
}

// ── Où vit le carnet ────────────────────────────────────────────────────────

fn notebook_dir() -> PathBuf {
	config_dir().join("notebook")
}

fn lessons_path() -> PathBuf {
	notebook_dir().join("lessons.json")
}

fn handbacks_path() -> PathBuf {
	notebook_dir().join("handbacks.json")
}

/// Nom de dossier pour un chemin de travail.
fn key(cwd: &str) -> String {
	cwd.chars()
		.map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
		.collect()
}

fn seal_dir(cwd: &str) -> PathBuf {
	notebook_dir().join("seals").join(key(cwd))
}

fn now() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0)
}

fn id_like() -> String {
	format!("{:x}", now().wrapping_mul(2_654_435_761) ^ std::process::id() as u64)
}

fn read_list<T: for<'a> Deserialize<'a>>(path: &Path) -> Vec<T> {
	std::fs::read_to_string(path)
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

fn write_list<T: Serialize>(path: &Path, list: &[T]) -> Result<()> {
	std::fs::create_dir_all(notebook_dir())
		.map_err(|e| CockpitError::msg(crate::i18n::tf("notebook.dir", &[("error", &e)])))?;
	let raw = serde_json::to_string_pretty(list)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("notebook.unreadable", &[("error", &e)])))?;
	std::fs::write(path, raw).map_err(|e| CockpitError::msg(crate::i18n::tf("notebook.write", &[("error", &e)])))
}

// ── Les leçons ──────────────────────────────────────────────────────────────

/// Toutes les leçons d'un projet, de la plus récente à la plus ancienne.
pub fn lessons(project: &str) -> Vec<Lesson> {
	let mut all: Vec<Lesson> = read_list(&lessons_path());
	all.retain(|lesson| project.is_empty() || lesson.project == project);
	all.sort_by(|a, b| b.at.cmp(&a.at));
	all
}

pub fn save_lesson(mut lesson: Lesson) -> Result<Vec<Lesson>> {
	if lesson.text.trim().is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("notebook.emptyLesson")));
	}
	let mut all: Vec<Lesson> = read_list(&lessons_path());
	if lesson.id.trim().is_empty() {
		lesson.id = id_like();
		lesson.at = now();
	}
	lesson.text = lesson.text.trim().to_string();
	lesson.scope.retain(|entry| !entry.trim().is_empty());

	match all.iter_mut().find(|entry| entry.id == lesson.id) {
		Some(existing) => *existing = lesson,
		None => all.push(lesson),
	}
	write_list(&lessons_path(), &all)?;
	Ok(lessons(""))
}

pub fn forget_lesson(id: &str) -> Result<Vec<Lesson>> {
	let mut all: Vec<Lesson> = read_list(&lessons_path());
	all.retain(|lesson| lesson.id != id);
	write_list(&lessons_path(), &all)?;
	Ok(lessons(""))
}

/// Une leçon sans emploi depuis longtemps : à relire, sinon à retirer.
///
/// Ce n'est pas un ménage automatique. Effacer soi-même ce qu'on a fait
/// retenir serait la pire des deux options : on ne saurait ni ce qui a été
/// oublié, ni pourquoi.
pub fn stale(lesson: &Lesson) -> bool {
	let reference = if lesson.last_used > 0 {
		lesson.last_used
	} else {
		lesson.at
	};
	now().saturating_sub(reference) > STALE_AFTER_DAYS * 86_400
}

/// Les leçons qui concernent ces fichiers.
///
/// Une leçon sans portée vaut partout — c'est le cas d'une règle de projet. Une
/// leçon avec portée ne remonte que si l'un des fichiers touchés commence par
/// l'un de ses chemins : c'est ce qui l'empêche de parler tout le temps.
pub fn relevant(project: &str, files: &[String]) -> Vec<Lesson> {
	lessons(project)
		.into_iter()
		.filter(|lesson| {
			if lesson.scope.is_empty() {
				return true;
			}
			lesson.scope.iter().any(|scope| {
				let scope = scope.trim().trim_end_matches('/');
				!scope.is_empty() && files.iter().any(|file| file.starts_with(scope))
			})
		})
		.collect()
}

/// Note qu'une leçon a servi : c'est ce qui distingue une mémoire vivante d'un
/// dépôt de bonnes intentions.
pub fn mark_used(ids: &[String]) {
	if ids.is_empty() {
		return;
	}
	let mut all: Vec<Lesson> = read_list(&lessons_path());
	let stamp = now();
	for lesson in all.iter_mut() {
		if ids.contains(&lesson.id) {
			lesson.uses += 1;
			lesson.last_used = stamp;
		}
	}
	let _ = write_list(&lessons_path(), &all);
}

// ── Ce que la boucle a produit, en volume ───────────────────────────────────

/// Deux compteurs, et rien d'autre.
///
/// Sans eux, on saurait combien de reprises attendent d'être lues mais jamais
/// combien il y en a eu : une reprise écartée disparaît, et le taux qu'on
/// calculerait dessus s'améliorerait chaque fois qu'on en jette une. Le rapport
/// des deux est la seule mesure de fiabilité que le cockpit puisse produire
/// sans rien demander à personne.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
	/// Tours d'agent qui ont laissé quelque chose dans un worktree.
	pub delivered: u64,
	/// Ceux qui ont été repris à la main derrière.
	pub taken_back: u64,
	pub since: u64,
	/// Les mêmes, mais pour les agents qui avaient reçu un dossier de contexte.
	///
	/// Séparés pour pouvoir comparer. **Ce n'est pas une expérience** : on joint
	/// du contexte quand il y en a, donc les deux populations diffèrent avant
	/// même qu'un agent ne parte — une branche avec ticket et revue est un
	/// travail plus cadré qu'une branche nue. L'écart se lit comme un signal,
	/// jamais comme une preuve, et l'écran qui l'affiche doit le dire.
	#[serde(default)]
	pub delivered_briefed: u64,
	#[serde(default)]
	pub taken_back_briefed: u64,
}

fn tally_path() -> PathBuf {
	notebook_dir().join("tally.json")
}

pub fn tally() -> Tally {
	std::fs::read_to_string(tally_path())
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

fn bump(cwd: &str, delivered: u64, taken_back: u64) {
	let mut current = tally();
	if current.since == 0 {
		current.since = now();
	}
	current.delivered += delivered;
	current.taken_back += taken_back;
	if briefed(cwd) {
		current.delivered_briefed += delivered;
		current.taken_back_briefed += taken_back;
	}
	let _ = std::fs::create_dir_all(notebook_dir());
	let _ = std::fs::write(
		tally_path(),
		serde_json::to_string(&current).unwrap_or_default(),
	);
}

/// Marque qu'un dossier de contexte est parti avec un agent, dans ce dossier.
///
/// La marque vit à côté du sceau et disparaît avec lui : elle ne vaut que pour
/// le travail en cours, et un worktree réutilisé plus tard ne traîne pas la
/// mémoire d'un contexte qui ne le concernait pas.
pub fn mark_briefed(cwd: &str) {
	let dir = seal_dir(cwd);
	if std::fs::create_dir_all(&dir).is_ok() {
		let _ = std::fs::write(dir.join("briefed"), "1");
	}
}

fn briefed(cwd: &str) -> bool {
	seal_dir(cwd).join("briefed").is_file()
}

// ── Sceller ce qu'un agent a rendu ──────────────────────────────────────────

/// Les fichiers que le worktree porte en propre, modifiés ou neufs.
async fn touched(cwd: &Path) -> Vec<String> {
	let mut files = Vec::new();
	if let Ok(raw) = crate::git::run_git(cwd, &["diff", "HEAD", "--name-only"]).await {
		files.extend(raw.lines().map(|line| line.trim().to_string()));
	}
	if let Ok(raw) = crate::git::run_git(cwd, &["ls-files", "--others", "--exclude-standard"]).await
	{
		files.extend(raw.lines().map(|line| line.trim().to_string()));
	}
	files.retain(|file| !file.is_empty());
	files.sort();
	files.dedup();
	files
}

/// Copie l'état livré, pour pouvoir le comparer plus tard.
///
/// Appelé à la fin de chaque tour. Silencieux : sceller est un service rendu à
/// plus tard, jamais une raison de gêner ce qui marche.
pub async fn seal(cwd: &str) {
	let path = PathBuf::from(cwd);
	if !path.is_dir() {
		return;
	}
	let files = touched(&path).await;
	if files.is_empty() || files.len() > MAX_SEALED_FILES {
		// Rien à comparer, ou un chantier qui n'apprendrait rien : on efface le
		// sceau précédent plutôt que de laisser une comparaison fantaisiste.
		let _ = std::fs::remove_dir_all(seal_dir(cwd));
		return;
	}

	let dir = seal_dir(cwd);
	// La marque de contexte survit au resceau : elle décrit l'agent qui
	// travaille dans ce dossier, pas l'état du sceau qu'on remplace.
	let was_briefed = briefed(cwd);
	let _ = std::fs::remove_dir_all(&dir);
	if std::fs::create_dir_all(&dir).is_err() {
		return;
	}
	if was_briefed {
		let _ = std::fs::write(dir.join("briefed"), "1");
	}

	let mut kept = Vec::new();
	for file in &files {
		let source = path.join(file);
		let Ok(meta) = std::fs::metadata(&source) else {
			continue;
		};
		if !meta.is_file() || meta.len() > MAX_SEALED_BYTES {
			continue;
		}
		let target = dir.join(key(file));
		if std::fs::copy(&source, &target).is_ok() {
			kept.push(file.clone());
		}
	}
	let _ = std::fs::write(
		dir.join("manifest.json"),
		serde_json::to_string(&kept).unwrap_or_default(),
	);
	if !kept.is_empty() {
		bump(cwd, 1, 0);
	}
}

/// Défait le comptage d'une livraison — voir `collect`.
fn bump_delivered_back(cwd: &str) {
	let mut current = tally();
	current.delivered = current.delivered.saturating_sub(1);
	if briefed(cwd) {
		current.delivered_briefed = current.delivered_briefed.saturating_sub(1);
	}
	let _ = std::fs::write(
		tally_path(),
		serde_json::to_string(&current).unwrap_or_default(),
	);
}

fn sealed_files(cwd: &str) -> Vec<String> {
	std::fs::read_to_string(seal_dir(cwd).join("manifest.json"))
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

/// Compare le worktree au dernier rendu scellé.
///
/// Ce qui a bougé entre les deux n'a pu l'être que par un humain : aucun agent
/// ne tournait, sinon on ne serait pas en train de comparer. Rend `None` quand
/// rien n'a été repris — le cas le plus fréquent, et celui où il ne faut surtout
/// rien inventer.
pub async fn capture(cwd: &str) -> Option<Handback> {
	let files = sealed_files(cwd);
	if files.is_empty() {
		return None;
	}
	let root = PathBuf::from(cwd);
	if !root.is_dir() {
		return None;
	}

	let dir = seal_dir(cwd);
	let mut patch = String::new();
	let mut changed = Vec::new();
	for file in &files {
		let before = dir.join(key(file));
		let after = root.join(file);
		if !before.is_file() {
			continue;
		}
		// Comparer les octets avant d'appeler git : la plupart des fichiers
		// n'ont pas bougé, et lancer un processus pour chacun coûterait plus
		// cher que toute la détection.
		let (Ok(left), Ok(right)) = (std::fs::read(&before), std::fs::read(&after)) else {
			// Fichier disparu depuis : c'est une reprise en soi.
			changed.push(file.clone());
			patch.push_str(&format!("--- {file}\n+++ (deleted)\n"));
			continue;
		};
		if left == right {
			continue;
		}
		changed.push(file.clone());
		if let Ok(diff) = crate::git::run_git(
			&root,
			&[
				"diff",
				"--no-index",
				"--no-color",
				&before.to_string_lossy(),
				&after.to_string_lossy(),
			],
		)
		.await
		{
			patch.push_str(&format!("### {file}\n{diff}\n"));
		}
	}

	if changed.is_empty() {
		return None;
	}

	let branch = crate::git::current_branch(&root).await.unwrap_or_default();
	let project = crate::git::main_worktree(&root)
		.await
		.map(|path| path.to_string_lossy().to_string())
		.unwrap_or_else(|_| cwd.to_string());

	Some(Handback {
		id: id_like(),
		cwd: cwd.to_string(),
		project,
		branch,
		at: now(),
		files: changed,
		patch: patch.chars().take(MAX_PATCH_CHARS).collect(),
	})
}

/// Détecte une reprise, la range, et re-scelle l'état courant.
///
/// Re-sceller est indispensable : sans cela, la même correction serait
/// redétectée à chaque passage et le carnet proposerait dix fois la même leçon.
pub async fn collect(cwd: &str) -> Option<Handback> {
	let found = capture(cwd).await?;
	let mut all: Vec<Handback> = read_list(&handbacks_path());
	// Deux reprises sur le même dossier : la nouvelle remplace, elle contient
	// déjà l'état le plus récent du travail.
	all.retain(|entry| entry.cwd != found.cwd);
	all.push(found.clone());
	let _ = write_list(&handbacks_path(), &all);
	bump(cwd, 0, 1);
	// `seal` recompte une livraison, alors qu'on ne fait que remettre le sceau
	// à jour : on retire ce qu'il vient d'ajouter, sinon relever une reprise
	// gonflerait le dénominateur qu'elle sert à mesurer.
	seal(cwd).await;
	bump_delivered_back(cwd);
	Some(found)
}

pub fn handbacks(project: &str) -> Vec<Handback> {
	let mut all: Vec<Handback> = read_list(&handbacks_path());
	all.retain(|entry| project.is_empty() || entry.project == project);
	all.sort_by(|a, b| b.at.cmp(&a.at));
	all
}

pub fn dismiss(id: &str) -> Result<Vec<Handback>> {
	let mut all: Vec<Handback> = read_list(&handbacks_path());
	all.retain(|entry| entry.id != id);
	write_list(&handbacks_path(), &all)?;
	Ok(handbacks(""))
}

// ── En tirer une leçon ──────────────────────────────────────────────────────

/// Ce qu'on demande à l'agent qui lit une reprise.
///
/// La consigne insiste sur un point : la plupart des corrections n'ont rien à
/// apprendre. Un agent à qui l'on demande une leçon en trouvera toujours une —
/// c'est justement ce qu'il faut empêcher, sinon le carnet se remplit de
/// truismes qui noieront les deux règles qui comptaient.
fn draft_prompt(handback: &Handback) -> String {
	format!(
		"An agent delivered some work, and a human took it back by hand right after. Here is \
		 what they changed on top of it.\n\n\
		 Your question, the only one: is there a rule here that the agent should have known in advance?\n\n\
		 Most of the time, no. A rename, a matter of taste, a choice that could have gone \
		 either way, a fix specific to this exact case: none of that is reusable, and writing \
		 it down would clutter the project's memory for nothing. In that case, answer exactly \
		 \"NOTHING\" and stop there.\n\n\
		 If there is a real rule — a repository convention that was not followed, a pitfall \
		 specific to this code, a constraint you cannot guess by reading it — then return \
		 exactly this form:\n\n\
		 Lesson: <one to three sentences, in the imperative, addressed to an agent that has not \
		 started yet. What to do, not what happened.>\n\
		 Scope: <file or folder paths, comma-separated, where this rule applies. If it holds \
		 for the whole repository, write \"all\".>\n\n\
		 Keep the markers NOTHING, Lesson:, Scope: and all in English exactly as written.\n\
		 {}\n\n\
		 You are in the repository: go read the surrounding code if the diff is not enough to \
		 decide. You cannot modify anything.\n\n\
		 ## What the human took back\n\n\
		 Files: {}\n\n```diff\n{}\n```",
		crate::i18n::reply_directive(),
		handback.files.join(", "),
		handback.patch
	)
}

/// Fait lire une reprise, et propose une leçon — sans jamais l'enregistrer.
///
/// L'enregistrement reste un geste humain : ce texte deviendra une consigne
/// jointe à de futurs agents, et une consigne que personne n'a validée est une
/// dérive qu'on ne saura pas expliquer plus tard.
pub async fn draft(id: String) -> Result<Lesson> {
	let handback = handbacks("")
		.into_iter()
		.find(|entry| entry.id == id)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("notebook.handbackGone")))?;

	let config = crate::config::Config::for_repo(&handback.project);
	let cwd = if std::path::Path::new(&handback.cwd).is_dir() {
		handback.cwd.clone()
	} else {
		handback.project.clone()
	};

	let rendu = crate::agent::run_once(
		&cwd,
		&draft_prompt(&handback),
		&config.impact.engine,
		&config.impact.model,
		"",
		&["Write", "Edit", "MultiEdit", "NotebookEdit"],
		crate::executions::Origin::cockpit("carnet"),
	)
	.await?;

	let (text, scope) = parse_draft(&rendu.text);
	if text.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("notebook.nothingToLearn")));
	}

	Ok(Lesson {
		id: String::new(),
		text,
		scope: if scope.is_empty() {
			handback.files.clone()
		} else {
			scope
		},
		source: "reprise".into(),
		project: handback.project.clone(),
		at: now(),
		uses: 0,
		last_used: 0,
	})
}

/// Relit ce que l'agent a proposé.
///
/// Rend un texte vide quand il n'y avait rien à apprendre — c'est une réponse
/// attendue, pas un échec de lecture.
fn parse_draft(rendu: &str) -> (String, Vec<String>) {
	let trimmed = rendu.trim();
	// `NOTHING` aujourd'hui, `RIEN` dans les réponses d'avant la traduction.
	let upper = trimmed.to_uppercase();
	if trimmed.is_empty() || upper.starts_with("RIEN") || upper.starts_with("NOTHING") {
		return (String::new(), Vec::new());
	}

	let mut text = Vec::new();
	let mut scope = Vec::new();
	for line in trimmed.lines() {
		let line = line.trim();
		if let Some(rest) = line
			.strip_prefix("Lesson:")
			.or_else(|| line.strip_prefix("Leçon:"))
			.or_else(|| line.strip_prefix("Leçon :"))
			.or_else(|| line.strip_prefix("Lecon:"))
		{
			text.push(rest.trim().to_string());
			continue;
		}
		if let Some(rest) = line
			.strip_prefix("Scope:")
			.or_else(|| line.strip_prefix("Portée:"))
			.or_else(|| line.strip_prefix("Portée :"))
			.or_else(|| line.strip_prefix("Portee:"))
		{
			// « tout » n'est pas un chemin : c'est l'absence de portée, et une
			// liste vide est déjà ce qui veut dire « partout ».
			let rest_trim = rest.trim();
			if !rest_trim.eq_ignore_ascii_case("tout") && !rest_trim.eq_ignore_ascii_case("all") {
				scope = rest
					.split(',')
					.map(|part| part.trim().trim_matches('`').to_string())
					.filter(|part| !part.is_empty())
					.collect();
			}
			continue;
		}
		// Un modèle qui a ignoré la forme : on garde son texte plutôt que de
		// perdre la lecture.
		if text.is_empty() && !line.starts_with('#') {
			text.push(line.to_string());
		}
	}

	(text.join(" ").trim().to_string(), scope)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn lesson(scope: &[&str]) -> Lesson {
		Lesson {
			id: "x".into(),
			text: "Valide les entrées.".into(),
			scope: scope.iter().map(|s| s.to_string()).collect(),
			project: "/repo".into(),
			..Default::default()
		}
	}

	#[test]
	fn une_lecon_sans_portee_vaut_partout() {
		let entry = lesson(&[]);
		assert!(matches(&entry, &["src/app.ts".into()]));
	}

	#[test]
	fn une_lecon_ne_remonte_que_sur_sa_portee() {
		let entry = lesson(&["apps/api"]);
		assert!(matches(&entry, &["apps/api/routes.ts".into()]));
		assert!(!matches(&entry, &["apps/web/page.tsx".into()]));
	}

	/// Reproduit le filtre de `relevant` sans passer par le disque.
	fn matches(lesson: &Lesson, files: &[String]) -> bool {
		if lesson.scope.is_empty() {
			return true;
		}
		lesson.scope.iter().any(|scope| {
			let scope = scope.trim().trim_end_matches('/');
			!scope.is_empty() && files.iter().any(|file| file.starts_with(scope))
		})
	}

	/// Le cas le plus fréquent, et celui qu'il ne faut surtout pas rater : une
	/// correction de circonstance n'a rien à apprendre.
	#[test]
	fn rien_a_retenir_se_dit_et_ne_produit_pas_de_lecon() {
		assert_eq!(parse_draft("RIEN"), (String::new(), Vec::new()));
		assert_eq!(parse_draft("  rien de réutilisable  ").0, "");
		assert_eq!(parse_draft("").0, "");
	}

	#[test]
	fn une_lecon_bien_formee_se_relit() {
		let (text, scope) = parse_draft(
			"Leçon: Passe par le client partagé plutôt que d'appeler fetch directement.\n\
			 Portée: apps/web/src, packages/api",
		);
		assert!(text.starts_with("Passe par le client"));
		assert_eq!(scope, vec!["apps/web/src", "packages/api"]);
	}

	/// Les marqueurs anglais d'aujourd'hui et les français des réponses déjà
	/// enregistrées se relisent pareil.
	#[test]
	fn les_marqueurs_anglais_et_francais_se_relisent() {
		assert_eq!(parse_draft("NOTHING"), (String::new(), Vec::new()));
		let (text, scope) = parse_draft("Lesson: Use the shared client.\nScope: apps/web, packages/api");
		assert_eq!(text, "Use the shared client.");
		assert_eq!(scope, vec!["apps/web", "packages/api"]);
		let (_, scope) = parse_draft("Lesson: Write tests.\nScope: all");
		assert!(scope.is_empty());
		let (text, scope) = parse_draft("Leçon: Passe par le client.\nPortée: apps/web");
		assert_eq!(text, "Passe par le client.");
		assert_eq!(scope, vec!["apps/web"]);
	}

	/// « tout » veut dire « sans portée » : le traiter comme un chemin ferait
	/// une leçon qui ne remonte jamais.
	#[test]
	fn une_portee_universelle_devient_une_absence_de_portee() {
		let (_, scope) = parse_draft("Leçon: Écris les messages en français.\nPortée: tout");
		assert!(scope.is_empty());
	}

	#[test]
	fn une_lecon_hors_forme_garde_son_texte() {
		let (text, _) = parse_draft("N'appelle pas la base depuis un composant.");
		assert_eq!(text, "N'appelle pas la base depuis un composant.");
	}

	/// L'oubli se propose, il ne s'exécute pas : la règle qui décide doit être
	/// juste dans les deux sens.
	#[test]
	fn une_lecon_recente_n_est_pas_perimee() {
		let mut entry = lesson(&[]);
		entry.at = now();
		assert!(!stale(&entry));

		entry.at = now() - (STALE_AFTER_DAYS + 1) * 86_400;
		assert!(stale(&entry), "sans emploi depuis deux mois");

		// Un emploi récent la sauve, même si elle est ancienne.
		entry.last_used = now();
		assert!(!stale(&entry));
	}
}
