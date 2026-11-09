//! La visite des changements d'un agent : ce qu'il a réellement modifié,
//! fichier par fichier, et de quoi le raconter.
//!
//! La conversation dit ce que l'agent *pense* avoir fait ; git dit ce qui a
//! changé sur le disque, y compris ce qu'une commande a généré sans qu'il le
//! nomme. La visite part donc de git, et ne demande à la conversation que le
//! pourquoi.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::{CockpitError, Result};
use crate::git::{run_git, FileChange};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TourChanges {
	/// Racine du dépôt : les chemins des fichiers lui sont relatifs.
	pub root: String,
	/// Le commit de référence, tel que git l'écrit.
	pub base: String,
	/// Comment le dire : « depuis dev », « depuis 3f2a1bc ».
	pub base_label: String,
	pub files: Vec<FileChange>,
	pub additions: usize,
	pub deletions: usize,
}

/// Les branches d'intégration qu'on sait reconnaître, et leur version publiée.
const INTEGRATION: &[&str] = &["dev", "develop", "main", "master"];

/// La branche sur laquelle la PR de cette branche se greffe, quand GitHub la
/// connaît. Retenue dix minutes : la visite se recalcule à chaque tour d'agent,
/// et la base d'une PR ne change presque jamais.
async fn pr_base(branch: &str) -> Option<String> {
	use std::collections::HashMap;
	use std::sync::{Mutex, OnceLock};
	use std::time::{Duration, Instant};
	type Cached = (Instant, Option<String>);
	static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
	let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
	if let Some((at, base)) = cache.lock().ok()?.get(branch).cloned() {
		if at.elapsed() < Duration::from_secs(600) {
			return base;
		}
	}
	let config = crate::config::Config::active();
	let base = tokio::time::timeout(Duration::from_secs(4), crate::integrations::github_pull_for_branch(&config, branch))
		.await
		.ok()
		.and_then(Result::ok)
		.flatten()
		.map(|pr| pr.base)
		.filter(|base| !base.trim().is_empty());
	if let Ok(mut cache) = cache.lock() {
		cache.insert(branch.to_string(), (Instant::now(), base.clone()));
	}
	base
}

/// Parmi des références candidates, le point de divergence le plus proche de
/// `HEAD`, et la référence qui le donne.
///
/// Une référence qui contient déjà `HEAD` (son point de divergence est `HEAD`
/// lui-même) est écartée : elle a déjà intégré la branche, et la visite
/// n'aurait plus rien à montrer.
async fn closest_base(root: &Path, refs: &[String]) -> Option<(String, String)> {
	let head = run_git(root, &["rev-parse", "HEAD"]).await.ok()?.trim().to_string();
	let mut best: Option<(usize, String, String)> = None;
	for reference in refs {
		if run_git(root, &["rev-parse", "--verify", "--quiet", reference]).await.is_err() {
			continue;
		}
		let Ok(raw) = run_git(root, &["merge-base", reference, "HEAD"]).await else {
			continue;
		};
		let base = raw.trim().to_string();
		if base.is_empty() || base == head {
			continue;
		}
		let distance: usize = run_git(root, &["rev-list", "--count", &format!("{base}..HEAD")])
			.await
			.ok()
			.and_then(|count| count.trim().parse().ok())
			.unwrap_or(usize::MAX);
		if best.as_ref().is_none_or(|(known, _, _)| distance < *known) {
			best = Some((distance, base, reference.clone()));
		}
	}
	best.map(|(_, base, reference)| (base, reference))
}

/// Le point de départ de la visite.
///
/// Sur une branche de travail, c'est ce que montrera la PR : le point de
/// divergence avec la branche sur laquelle elle se greffe.
///
/// Il se calculait contre la branche d'intégration **locale** la plus fournie.
/// Or un `dev` local en retard sur `origin/dev` place ce point bien trop tôt : la
/// visite embarquait alors tout ce qui avait été fusionné dans `dev` entre-temps
/// — les changements des autres branches, présentés comme ceux de l'agent. Et
/// une PR empilée sur une autre branche se voyait comparée à `dev`.
///
/// On prend donc la base de la PR quand GitHub la connaît ; sinon, parmi les
/// branches d'intégration locales **et publiées**, le point de divergence le
/// plus proche de la branche.
///
/// Sur une branche d'intégration elle-même, ce point est `HEAD` et ne
/// montrerait que ce qui n'est pas commité : on remonte alors au parent du
/// premier commit de l'agent, quand la conversation en a gardé la trace.
async fn base_of(root: &Path, since: Option<&str>) -> (String, String) {
	let branch = crate::git::current_branch(root).await.ok().filter(|name| name != "HEAD");
	let on_integration = branch.as_deref().is_some_and(|name| INTEGRATION.contains(&name));
	if let Some(branch) = branch.as_deref().filter(|_| !on_integration) {
		if let Some(base) = pr_base(branch).await {
			let refs = [format!("origin/{base}"), base.clone()];
			if let Some((sha, reference)) = closest_base(root, &refs).await {
				return (sha, crate::i18n::tf("tour.since", &[("ref", &reference)]));
			}
		}
		let mut refs: Vec<String> = Vec::new();
		let published = crate::git::default_branch(root).await;
		for name in INTEGRATION.iter().map(|name| name.to_string()).chain(std::iter::once(published)) {
			for reference in [format!("origin/{name}"), name] {
				if !refs.contains(&reference) {
					refs.push(reference);
				}
			}
		}
		if let Some((sha, reference)) = closest_base(root, &refs).await {
			return (sha, crate::i18n::tf("tour.since", &[("ref", &reference)]));
		}
	}
	if let Some(since) = since.map(str::trim).filter(|sha| !sha.is_empty()) {
		let parent = format!("{since}^");
		let ancestor = run_git(root, &["merge-base", "--is-ancestor", since, "HEAD"]).await.is_ok();
		if ancestor {
			if let Ok(raw) = run_git(root, &["rev-parse", "--verify", &parent]).await {
				return (raw.trim().to_string(), crate::i18n::tf("tour.sinceBefore", &[("sha", &since)]));
			}
		}
	}
	("HEAD".into(), crate::i18n::t("tour.sinceLastCommit"))
}

async fn root_of(cwd: &Path) -> Result<PathBuf> {
	let raw = run_git(cwd, &["rev-parse", "--show-toplevel"])
		.await
		.map_err(|_| CockpitError::msg(crate::i18n::t("tour.notGit")))?;
	Ok(PathBuf::from(raw.trim()))
}

fn state_label(code: &str) -> &'static str {
	match code.chars().next() {
		Some('A') => "added",
		Some('D') => "deleted",
		_ => "modified",
	}
}

/// Un fichier neuf, pas encore suivi : ses lignes sont toutes des ajouts.
fn line_count(path: &Path) -> usize {
	match std::fs::metadata(path) {
		Ok(meta) if meta.len() < 2 * 1_048_576 => std::fs::read_to_string(path)
			.map(|text| text.lines().count())
			.unwrap_or(0),
		_ => 0,
	}
}

pub async fn changes(cwd: &Path, since: Option<String>) -> Result<TourChanges> {
	let root = root_of(cwd).await?;
	let (base, base_label) = base_of(&root, since.as_deref()).await;

	// Sans détection de renommage : un fichier déplacé se lit comme un retrait
	// et un ajout, ce qui reste juste et évite de réécrire les chemins de git.
	let mut states = std::collections::HashMap::new();
	for line in run_git(&root, &["diff", "--no-renames", "--name-status", &base])
		.await
		.unwrap_or_default()
		.lines()
	{
		let mut parts = line.split('\t');
		if let (Some(code), Some(path)) = (parts.next(), parts.next()) {
			states.insert(path.to_string(), state_label(code));
		}
	}

	let mut files = Vec::new();
	for line in run_git(&root, &["diff", "--no-renames", "--numstat", &base])
		.await
		.unwrap_or_default()
		.lines()
	{
		let mut parts = line.split('\t');
		let added = parts.next().unwrap_or("0").parse().unwrap_or(0);
		let removed = parts.next().unwrap_or("0").parse().unwrap_or(0);
		let Some(path) = parts.next() else { continue };
		files.push(FileChange {
			path: path.to_string(),
			added,
			removed,
			state: states.get(path).copied().unwrap_or("modified").to_string(),
		});
	}

	for path in run_git(&root, &["ls-files", "--others", "--exclude-standard"])
		.await
		.unwrap_or_default()
		.lines()
		.filter(|line| !line.trim().is_empty())
	{
		files.push(FileChange {
			path: path.to_string(),
			added: line_count(&root.join(path)),
			removed: 0,
			state: "untracked".into(),
		});
	}

	let additions = files.iter().map(|file| file.added).sum();
	let deletions = files.iter().map(|file| file.removed).sum();
	Ok(TourChanges {
		root: root.to_string_lossy().to_string(),
		base,
		base_label,
		files,
		additions,
		deletions,
	})
}

/// Le diff d'un fichier depuis la base de la visite.
///
/// Un fichier non suivi n'a pas de diff pour git : on le compare au vide, ce
/// que `--no-index` fait en sortant sur le code 1 dès qu'il y a une différence.
pub async fn file_diff(root: &Path, base: &str, file: &str, untracked: bool) -> Result<String> {
	if !untracked {
		return run_git(root, &["diff", "--no-renames", base, "--", file]).await;
	}
	// `/dev/null` : Git for Windows le reconnaît aussi.
	let output = crate::platform::quiet_async(&mut Command::new("git"))
		.args(["diff", "--no-index", "--", "/dev/null", file])
		.current_dir(root)
		.output()
		.await
		.map_err(|e| CockpitError::msg(format!("git diff --no-index : {e}")))?;
	match output.status.code() {
		Some(0) | Some(1) => Ok(String::from_utf8_lossy(&output.stdout).to_string()),
		_ => Err(CockpitError::msg(String::from_utf8_lossy(&output.stderr).trim().to_string())),
	}
}

/// Ce que l'agent a dit en touchant un fichier, transmis par l'interface.
#[derive(Debug, Clone, Deserialize)]
pub struct Note {
	pub path: String,
	pub said: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Story {
	/// Deux ou trois phrases : ce que fait ce changement, vu de haut.
	pub intro: String,
	/// Dans l'ordre où les lire.
	pub files: Vec<FileStory>,
	#[serde(default)]
	pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStory {
	pub path: String,
	pub story: String,
}

/// Au-delà, le diff est tronqué : le récit porte sur l'intention, pas sur
/// chaque ligne, et un diff géant coûterait sans rien apprendre de plus.
const MAX_DIFF: usize = 90_000;

fn story_prompt(changes: &TourChanges, diff: &str, notes: &[Note], conclusion: &str) -> String {
	let list = changes
		.files
		.iter()
		.map(|file| format!("- {} ({}, +{} −{})", file.path, file.state, file.added, file.removed))
		.collect::<Vec<_>>()
		.join("\n");
	let said = notes
		.iter()
		.map(|note| format!("- {}: {}", note.path, note.said.replace('\n', " ")))
		.collect::<Vec<_>>()
		.join("\n");
	format!(
		"You are preparing a guided tour of the changes a coding agent just made, \
for the person who will review them. They do not necessarily know this code.\n\n\
Changed files ({base}):\n{list}\n\n\
What the agent said while modifying them:\n{said}\n\n\
Its conclusion:\n{conclusion}\n\n\
The diff:\n```diff\n{diff}\n```\n\n\
Answer ONLY with a JSON object, with no text around it:\n\
{{\"intro\": \"…\", \"files\": [{{\"path\": \"…\", \"story\": \"…\"}}]}}\n\n\
- intro: two or three sentences, what this change does and why, from the product's point of view.\n\
- files: every file in the list, exactly once, with its exact path, in the order \
in which to read them to understand — from the heart of the change to what follows from it \
(tests, configuration, generated files last).\n\
- story: three to five sentences, addressing the reader informally and directly. What changes in this file, \
why, and what to look at closely while reviewing (a risk, an edge case, \
a debatable choice). No lists, no Markdown, no code.\n\n\
Keep the JSON keys (intro, files, path, story) exactly as written.\n\
{directive}",
		base = changes.base_label,
		directive = crate::i18n::reply_directive(),
	)
}

fn parse_story(text: &str) -> Option<Story> {
	let start = text.find('{')?;
	let end = text.rfind('}')?;
	serde_json::from_str(&text[start..=end]).ok()
}

pub async fn story(cwd: &Path, since: Option<String>, notes: Vec<Note>, conclusion: String) -> Result<Story> {
	let changes = changes(cwd, since).await?;
	if changes.files.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("tour.noChanges")));
	}
	let root = PathBuf::from(&changes.root);
	let mut diff = run_git(&root, &["diff", "--no-renames", &changes.base])
		.await
		.unwrap_or_default();
	for file in changes.files.iter().filter(|file| file.state == "untracked") {
		if diff.len() > MAX_DIFF {
			break;
		}
		if let Ok(added) = file_diff(&root, &changes.base, &file.path, true).await {
			diff.push_str(&added);
		}
	}
	if diff.len() > MAX_DIFF {
		let mut cut = MAX_DIFF;
		while !diff.is_char_boundary(cut) {
			cut -= 1;
		}
		diff.truncate(cut);
		diff.push_str("\n… (diff truncated)");
	}

	let config = crate::config::Config::for_repo(&changes.root);
	let rendu = crate::agent::run_once(
		&changes.root,
		&story_prompt(&changes, &diff, &notes, &conclusion),
		&config.impact.engine,
		&config.impact.model,
		"",
		&["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
		crate::executions::Origin::cockpit("visite"),
	)
	.await?;

	let mut story = parse_story(&rendu.text)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("tour.unreadableStory")))?;
	story.cost_usd = rendu.cost_usd;
	Ok(story)
}

#[cfg(test)]
mod tests {
	use super::parse_story;

	#[test]
	fn lit_le_recit_meme_entoure_de_texte() {
		let story = parse_story(
			"Voici :\n```json\n{\"intro\": \"On corrige.\", \"files\": [{\"path\": \"a.ts\", \"story\": \"Il change.\"}]}\n```",
		)
		.unwrap();
		assert_eq!(story.intro, "On corrige.");
		assert_eq!(story.files[0].path, "a.ts");
	}

	#[test]
	fn refuse_ce_qui_n_est_pas_du_json() {
		assert!(parse_story("Je n'ai pas pu.").is_none());
	}

	fn git(dir: &std::path::Path, args: &[&str]) {
		let status = std::process::Command::new("git")
			.args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
			.args(args)
			.current_dir(dir)
			.output()
			.unwrap();
		assert!(status.status.success(), "git {args:?} : {}", String::from_utf8_lossy(&status.stderr));
	}

	fn repo(name: &str) -> std::path::PathBuf {
		let dir = std::env::temp_dir().join(format!("cockpit-tour-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		git(&dir, &["init", "-q", "-b", "main"]);
		std::fs::write(dir.join("a.ts"), "un\ndeux\n").unwrap();
		std::fs::write(dir.join("gone.ts"), "x\n").unwrap();
		git(&dir, &["add", "-A"]);
		git(&dir, &["commit", "-q", "-m", "base"]);
		dir
	}

	/// Sur une branche de travail : tout ce qu'elle change depuis la
	/// divergence, commité ou non, fichiers neufs compris.
	#[tokio::test]
	async fn une_branche_se_visite_depuis_sa_divergence() {
		let dir = repo("branche");
		git(&dir, &["checkout", "-q", "-b", "feat/x"]);
		std::fs::write(dir.join("a.ts"), "un\ndeux\ntrois\n").unwrap();
		git(&dir, &["commit", "-q", "-am", "ajoute trois"]);
		std::fs::remove_file(dir.join("gone.ts")).unwrap();
		std::fs::write(dir.join("new.ts"), "a\nb\n").unwrap();

		let changes = super::changes(&dir, None).await.unwrap();
		assert_eq!(changes.base_label, "since main");
		let find = |path: &str| changes.files.iter().find(|file| file.path == path).cloned().unwrap();
		assert_eq!(find("a.ts").state, "modified");
		assert_eq!(find("a.ts").added, 1);
		assert_eq!(find("gone.ts").state, "deleted");
		assert_eq!(find("new.ts").state, "untracked");
		assert_eq!(find("new.ts").added, 2);

		let diff = super::file_diff(&dir, &changes.base, "new.ts", true).await.unwrap();
		assert!(diff.contains("+a"));
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Le cas du bug : un `dev` local resté en arrière, une branche partie du
	/// `dev` publié. La visite ne doit montrer que le travail de la branche,
	/// pas ce que d'autres ont fusionné dans `dev` entre-temps.
	#[tokio::test]
	async fn un_dev_local_en_retard_ne_fait_pas_entrer_les_autres_branches() {
		let dir = repo("retard");
		git(&dir, &["branch", "dev"]);
		// Le `dev` publié avance : deux branches d'autres personnes fusionnées.
		git(&dir, &["checkout", "-q", "-b", "dev-publie"]);
		std::fs::write(dir.join("autre1.ts"), "a\n").unwrap();
		git(&dir, &["add", "-A"]);
		git(&dir, &["commit", "-q", "-m", "branche d'un collègue"]);
		std::fs::write(dir.join("autre2.ts"), "b\n").unwrap();
		git(&dir, &["add", "-A"]);
		git(&dir, &["commit", "-q", "-m", "une autre"]);
		git(&dir, &["update-ref", "refs/remotes/origin/dev", "HEAD"]);
		// La branche de travail part du `dev` publié ; le `dev` local, lui, n'a
		// jamais été mis à jour.
		git(&dir, &["checkout", "-q", "-b", "redis-cache"]);
		std::fs::write(dir.join("cache.ts"), "redis\n").unwrap();
		git(&dir, &["add", "-A"]);
		git(&dir, &["commit", "-q", "-m", "le travail de la branche"]);

		let changes = super::changes(&dir, None).await.unwrap();
		let paths: Vec<&str> = changes.files.iter().map(|file| file.path.as_str()).collect();
		assert_eq!(paths, vec!["cache.ts"], "{}", changes.base_label);
		assert_eq!(changes.base_label, "since origin/dev");
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Sur la branche d'intégration, le premier commit de l'agent sert de
	/// repère : sans lui, la visite ne verrait que ce qui n'est pas commité.
	#[tokio::test]
	async fn sur_main_on_part_du_premier_commit_de_l_agent() {
		let dir = repo("main");
		std::fs::write(dir.join("a.ts"), "un\ndeux\ntrois\n").unwrap();
		git(&dir, &["commit", "-q", "-am", "travail de l'agent"]);
		let sha = String::from_utf8(
			std::process::Command::new("git").args(["rev-parse", "--short", "HEAD"]).current_dir(&dir).output().unwrap().stdout,
		)
		.unwrap()
		.trim()
		.to_string();

		let without = super::changes(&dir, None).await.unwrap();
		assert!(without.files.is_empty());
		let with = super::changes(&dir, Some(sha.clone())).await.unwrap();
		assert_eq!(with.base_label, format!("since before {sha}"));
		assert_eq!(with.files.len(), 1);
		let _ = std::fs::remove_dir_all(&dir);
	}
}

