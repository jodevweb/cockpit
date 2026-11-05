//! Le rejeu de l'historique : chaque pull request fusionnée devient un cas
//! d'essai pour juger une configuration d'agents.
//!
//! On change sans cesse ce que reçoivent les agents — un modèle, une consigne,
//! une leçon du carnet, un skill — sans jamais savoir si c'était mieux. Le dépôt
//! contient pourtant un banc d'essai gratuit : une PR fusionnée est un problème
//! résolu, avec une solution validée par un humain, et souvent des tests écrits
//! pour ce problème précis.
//!
//! Un essai repart du commit **d'avant** la PR, dans un worktree jetable ; un
//! agent reçoit ce qu'avait l'humain, jamais son diff ; puis on applique à son
//! résultat **les tests de la PR humaine**, qu'il n'a jamais vus, et l'on joue
//! les portes du dépôt. C'est le juge le plus fort qu'on ait : des tests écrits
//! pour ce problème, sur ce dépôt.
//!
//! Ce module ne lance aucun agent. Il trouve les cas, prépare et range leurs
//! worktrees, vérifie qu'un cas sait échouer, et juge un résultat donné — tout
//! ce qui se teste sur un vrai dépôt git, sans rien dépenser.
//!
//! Il n'écrit jamais dans le dépôt : worktrees détachés, aucune branche créée.

use crate::error::Result;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

/// Une PR fusionnée, vue comme un cas d'essai.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Case {
	/// Numéro de la PR, quand le message de fusion le donne.
	pub number: Option<u32>,
	pub title: String,
	/// Le commit d'avant : là où l'essai repart.
	pub base: String,
	/// Le commit d'après : la solution humaine, d'où viennent les tests.
	pub head: String,
	/// Les fichiers de test ajoutés ou modifiés par la PR — le juge.
	pub tests: Vec<String>,
	/// Les autres fichiers qu'elle a touchés — la solution, jamais montrée.
	pub sources: Vec<String>,
}

/// Ce qu'un essai a donné.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Verdict {
	/// Les tests de l'humain passent sur le résultat de l'agent.
	Resolved,
	/// Ils échouent : la commande, et la fin de sa sortie.
	Failed { command: String, output: String },
	/// On ne peut pas juger, et l'on dit pourquoi. Jamais compté comme un
	/// échec, ni comme une réussite.
	NotJudgeable { reason: String },
}

/// Le jugement d'un essai, avec de quoi comparer à la solution humaine.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Judgement {
	pub verdict: Verdict,
	/// Les fichiers que l'agent a touchés (tests de l'humain exclus).
	pub agent_files: Vec<String>,
	/// Ceux que l'humain et l'agent ont touchés tous les deux. Indicatif : deux
	/// bonnes solutions peuvent ne rien partager.
	pub shared_files: Vec<String>,
}

/// Un chemin qui ressemble à un fichier de test, quel que soit le langage.
///
/// Des conventions de nommage seulement — dossiers `test`, `tests`,
/// `__tests__`, `spec`, et suffixes `.test.`, `.spec.`, `_test.`, `test_` en
/// tête de nom. Les tests écrits dans le même fichier que le code (`mod tests`
/// en Rust) ne se séparent pas de la solution : ces PR-là ne font pas de cas.
pub fn is_test_file(path: &str) -> bool {
	let lower = path.replace('\\', "/").to_lowercase();
	let mut parts: Vec<&str> = lower.split('/').collect();
	let name = parts.pop().unwrap_or_default();
	if parts.iter().any(|dir| matches!(*dir, "test" | "tests" | "__tests__" | "spec" | "specs")) {
		return true;
	}
	name.contains(".test.")
		|| name.contains(".spec.")
		|| name.contains("_test.")
		|| name.contains("_spec.")
		|| name.starts_with("test_")
}

/// Le numéro et le titre d'une PR, lus dans son commit sur la branche.
///
/// Deux formes, celles de GitHub : la fusion (`Merge pull request #12 from …`,
/// le titre en corps de message) et le squash (`Titre (#12)`).
fn parse_pr(subject: &str, body: &str) -> Option<(Option<u32>, String)> {
	let subject = subject.trim();
	if let Some(rest) = subject.strip_prefix("Merge pull request #") {
		let number = rest.split_whitespace().next()?.parse().ok()?;
		let title = body.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or(subject);
		return Some((Some(number), title.to_string()));
	}
	let open = subject.rfind("(#")?;
	let number = subject[open + 2..].strip_suffix(')')?.parse().ok()?;
	Some((Some(number), subject[..open].trim().to_string()))
}

/// Les cas du dépôt : les PR fusionnées sur `branch` qui ajoutent ou modifient
/// des tests et touchent aussi du code, les plus récentes d'abord.
pub async fn cases(repo: &Path, branch: &str, limit: usize) -> Result<Vec<Case>> {
	let raw = crate::git::run_git(
		repo,
		&["log", "--first-parent", "-300", "--format=%H%x1f%P%x1f%s%x1f%b%x1e", branch],
	)
	.await?;
	let mut found = Vec::new();
	for record in raw.split('\u{1e}') {
		if found.len() >= limit {
			break;
		}
		let fields: Vec<&str> = record.trim_start_matches('\n').split('\u{1f}').collect();
		let [head, parents, subject, body] = fields[..] else { continue };
		let Some(base) = parents.split_whitespace().next() else { continue };
		let Some((number, title)) = parse_pr(subject, body) else { continue };
		let Ok(changed) =
			crate::git::run_git(repo, &["diff", "--name-status", "--no-renames", base, head]).await
		else {
			continue;
		};
		let mut tests = Vec::new();
		let mut sources = Vec::new();
		for line in changed.lines() {
			let mut columns = line.split('\t');
			let (Some(status), Some(path)) = (columns.next(), columns.next()) else { continue };
			if is_test_file(path) {
				// Un test supprimé ne juge rien : seuls ceux qui existent après.
				if status.starts_with('A') || status.starts_with('M') {
					tests.push(path.to_string());
				}
			} else {
				sources.push(path.to_string());
			}
		}
		if !tests.is_empty() && !sources.is_empty() {
			found.push(Case {
				number,
				title,
				base: base.to_string(),
				head: head.to_string(),
				tests,
				sources,
			});
		}
	}
	Ok(found)
}

/// Prépare le dossier d'un essai : un clone du dépôt arrêté au commit d'avant
/// la PR, **sans rien de ce qui suit**.
///
/// Un worktree partageait les références du dépôt : depuis le dossier d'essai,
/// `git log main` montrait le diff de la PR, tests compris, et un agent qui
/// regarde l'historique — ils le font souvent d'eux-mêmes — pouvait recopier la
/// solution. Ici, toutes les références sont effacées, le journal des
/// références vidé, et les objets devenus inaccessibles supprimés : il ne reste
/// que l'histoire jusqu'au commit d'avant.
pub async fn prepare(repo: &Path, case: &Case, dir: &Path) -> Result<()> {
	let path = dir.to_string_lossy().to_string();
	let source = repo.to_string_lossy().to_string();
	crate::git::run_git(repo, &["clone", "--quiet", "--no-checkout", "--", &source, &path]).await?;
	let isolated = async {
		crate::git::run_git(dir, &["checkout", "--quiet", "--detach", &case.base]).await?;
		let refs = crate::git::run_git(dir, &["for-each-ref", "--format=%(refname)"]).await?;
		for reference in refs.lines().map(str::trim).filter(|line| !line.is_empty()) {
			crate::git::run_git(dir, &["update-ref", "-d", reference]).await?;
		}
		let _ = crate::git::run_git(dir, &["remote", "remove", "origin"]).await;
		crate::git::run_git(dir, &["reflog", "expire", "--expire=now", "--all"]).await?;
		crate::git::run_git(dir, &["gc", "--quiet", "--prune=now"]).await?;
		crate::git::run_git(dir, &["config", "user.name", "cockpit"]).await?;
		crate::git::run_git(dir, &["config", "user.email", "cockpit@localhost"]).await?;
		Ok::<(), crate::error::CockpitError>(())
	}
	.await;
	if let Err(error) = isolated {
		discard(repo, dir).await;
		return Err(error);
	}
	// Un clone neuf n'a pas ses dépendances : sans elles, les tests d'un projet
	// JavaScript échouent tous, et le contrôle d'un cas conclurait qu'il « sait
	// échouer » sur une simple absence de `node_modules`.
	if let Some(command) = install_command(dir) {
		let outcome = crate::gates::run(&path, &[command.clone()], INSTALL_TIMEOUT).await;
		if !outcome.passed {
			discard(repo, dir).await;
			return Err(crate::error::CockpitError::msg(crate::i18n::tf(
				"replay.installFailed",
				&[("command", &command), ("output", &outcome.output)],
			)));
		}
	}
	// Ce que l'installation a écrit (un verrou créé, mis à jour) n'est pas le
	// travail de l'agent : on le fige dans un commit local, et c'est de lui que
	// part la comparaison.
	let status = crate::git::run_git(dir, &["status", "--porcelain"]).await.unwrap_or_default();
	if !status.trim().is_empty() {
		let _ = crate::git::run_git(dir, &["add", "--all"]).await;
		let _ = crate::git::run_git(dir, &["commit", "--quiet", "--no-verify", "-m", "dependances"]).await;
	}
	Ok(())
}

/// Le temps laissé à l'installation des dépendances d'un essai.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// La commande qui installe les dépendances d'un dossier d'essai, d'après son
/// fichier de verrouillage — la version figée, comme en CI.
///
/// `None` quand il n'y a rien à installer, ou rien qu'on sache installer : un
/// projet Rust ou Go se compile en jouant ses tests, sans étape à part.
pub fn install_command(dir: &Path) -> Option<String> {
	let has = |name: &str| dir.join(name).exists();
	if !has("package.json") {
		return None;
	}
	Some(
		if has("pnpm-lock.yaml") {
			"pnpm install --frozen-lockfile"
		} else if has("yarn.lock") {
			"yarn install --frozen-lockfile"
		} else if has("bun.lockb") || has("bun.lock") {
			"bun install --frozen-lockfile"
		} else if has("package-lock.json") {
			"npm ci"
		} else {
			"npm install"
		}
		.to_string(),
	)
}

/// Le contenu d'un fichier à un commit du dépôt, en octets : un test peut
/// s'accompagner d'une image ou d'un fichier binaire.
async fn blob(repo: &Path, commit: &str, path: &str) -> Option<Vec<u8>> {
	let output = crate::platform::quiet_async(&mut tokio::process::Command::new("git"))
		.args(["show", &format!("{commit}:{path}")])
		.current_dir(repo)
		.output()
		.await
		.ok()?;
	output.status.success().then_some(output.stdout)
}

/// Pose dans le dossier d'essai ces fichiers tels qu'ils sont à la tête de la
/// PR, lus dans le dépôt d'origine — le dossier d'essai, lui, n'a plus cette
/// histoire. Un fichier absent à la tête est retiré.
async fn apply_from_head(repo: &Path, dir: &Path, case: &Case, paths: &[String]) -> Result<()> {
	for path in paths {
		let target = dir.join(path);
		match blob(repo, &case.head, path).await {
			Some(content) => {
				if let Some(parent) = target.parent() {
					std::fs::create_dir_all(parent)?;
				}
				std::fs::write(&target, content)?;
			}
			None => {
				let _ = std::fs::remove_file(&target);
			}
		}
	}
	Ok(())
}

/// Les fichiers changés dans le dossier d'essai depuis son dernier commit,
/// fichiers non suivis compris : ce que l'agent a produit.
async fn changed_files(dir: &Path) -> Result<Vec<String>> {
	// `--intent-to-add` rend visibles les fichiers nouveaux sans rien indexer
	// de leur contenu.
	crate::git::run_git(dir, &["add", "--all", "--intent-to-add"]).await?;
	let raw = crate::git::run_git(dir, &["diff", "--name-only", "HEAD"]).await?;
	Ok(raw.lines().map(str::trim).filter(|line| !line.is_empty()).map(String::from).collect())
}

/// Ce que le contrôle d'un cas a conclu.
#[derive(Debug, Clone, PartialEq)]
pub enum Check {
	/// Ses tests échouent sur le code d'avant, et passent avec la solution
	/// humaine : il distingue une solution d'une absence de solution.
	Usable,
	/// Il ne prouverait rien, et l'on dit pourquoi.
	Unusable { reason: String },
}

/// Contrôle un cas dans les deux sens, avant d'y dépenser un essai.
///
/// - Ses tests, posés sur le code d'avant, doivent **échouer** : sinon ils ne
///   distinguent rien.
/// - Avec la solution humaine, les portes d'aujourd'hui doivent **passer** :
///   une porte qui n'existait pas à l'époque, des dépendances qui ne
///   s'installent plus, un fixture que le motif des tests n'a pas reconnu —
///   tout cela ferait échouer n'importe quel agent, et chaque essai compterait
///   pour un échec qui n'en est pas un.
pub async fn check(repo: &Path, case: &Case, dir: &Path, commands: &[String], timeout: Duration) -> Result<Check> {
	if commands.is_empty() {
		return Ok(Check::Unusable { reason: crate::i18n::t("replay.noGates") });
	}
	prepare(repo, case, dir).await?;
	let path = dir.to_string_lossy().to_string();
	let verdict = async {
		apply_from_head(repo, dir, case, &case.tests).await?;
		if crate::gates::run(&path, commands, timeout).await.passed {
			return Ok::<Check, crate::error::CockpitError>(Check::Unusable { reason: crate::i18n::t("replay.passesBefore") });
		}
		apply_from_head(repo, dir, case, &case.sources).await?;
		let human = crate::gates::run(&path, commands, timeout).await;
		if !human.passed {
			return Ok(Check::Unusable {
				reason: crate::i18n::tf("replay.humanFails", &[("command", &human.failed), ("output", &human.output)]),
			});
		}
		Ok(Check::Usable)
	}
	.await;
	discard(repo, dir).await;
	verdict
}

/// Juge ce que contient le dossier d'un essai.
///
/// Dans l'ordre : relever ce que l'agent a touché, poser les tests de
/// l'humain, jouer les portes. Des tests qui ne s'appliquent pas, ou l'absence
/// de portes, rendent l'essai non jugeable — et le disent.
pub async fn judge(repo: &Path, dir: &Path, case: &Case, commands: &[String], timeout: Duration) -> Judgement {
	let agent_files: Vec<String> = changed_files(dir)
		.await
		.unwrap_or_default()
		.into_iter()
		.filter(|path| !case.tests.contains(path))
		.collect();
	let shared_files = agent_files.iter().filter(|path| case.sources.contains(path)).cloned().collect();
	let verdict = if commands.is_empty() {
		Verdict::NotJudgeable { reason: crate::i18n::t("replay.noGates") }
	} else if let Err(error) = apply_from_head(repo, dir, case, &case.tests).await {
		Verdict::NotJudgeable { reason: crate::i18n::tf("replay.testsDontApply", &[("error", &error)]) }
	} else {
		let outcome = crate::gates::run(&dir.to_string_lossy(), commands, timeout).await;
		if outcome.passed {
			Verdict::Resolved
		} else {
			Verdict::Failed { command: outcome.failed, output: outcome.output }
		}
	};
	Judgement { verdict, agent_files, shared_files }
}

// ── Les essais ───────────────────────────────────────────────────────────────

/// La configuration qu'on juge : ce qui change d'un essai à l'autre.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Setup {
	/// Le nom qu'on lui donne dans le rapport (« Sonnet », « avec le skill X »).
	pub label: String,
	/// Moteur et modèle ; vides, ceux du poste.
	pub engine: String,
	pub model: String,
	pub depth: String,
	/// Une consigne ajoutée à la tâche — c'est elle qu'on veut souvent juger.
	pub instructions: String,
}

/// Ce qu'un essai a donné, tel qu'il s'enregistre.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trial {
	pub at: String,
	pub number: Option<u32>,
	pub title: String,
	pub setup: Setup,
	/// Le jugement ; absent quand l'agent n'a pas pu travailler.
	pub judgement: Option<Judgement>,
	/// Pourquoi l'agent n'a pas pu travailler (délai, CLI introuvable…).
	pub error: Option<String>,
	pub cost_usd: f64,
	pub duration_ms: u64,
}

/// Les outils qu'un essai ne doit jamais toucher : rien ne quitte le
/// worktree jetable, ni vers le dépôt distant, ni vers le réseau.
pub const FORBIDDEN: [&str; 4] = ["Bash(git push:*)", "Bash(gh:*)", "WebFetch", "WebSearch"];

/// La consigne d'un essai : ce qu'avait l'humain, rien de sa solution.
///
/// Le titre seul, jamais la description de la PR — elle raconte souvent la
/// solution — ni ses fichiers, ni ses tests. Les portes sont données : un
/// agent en vrai travail les connaît aussi.
pub fn trial_prompt(case: &Case, setup: &Setup, commands: &[String]) -> String {
	let mut prompt = format!(
		"You are working in this repository. Resolve the following issue, as a developer of \
		 this project would, then stop.\n\n## The issue\n\n{}\n",
		case.title.trim()
	);
	if !commands.is_empty() {
		prompt.push_str(&format!(
			"\nThe repository's checks are: {}. Make them pass.\n",
			commands.iter().map(|command| format!("`{command}`")).collect::<Vec<_>>().join(", ")
		));
	}
	prompt.push_str(
		"\nDo not commit, do not push, do not open a pull request: leave your changes in the \
		 working tree.\n",
	);
	if !setup.instructions.trim().is_empty() {
		prompt.push_str(&format!("\n## Instructions\n\n{}\n", setup.instructions.trim()));
	}
	prompt
}

/// Ce que rend un agent d'essai : son coût et sa durée, ou pourquoi il n'a pas
/// pu travailler.
pub struct Worked {
	pub cost_usd: f64,
	pub duration_ms: u64,
}

/// Joue un essai : prépare le worktree, laisse l'agent travailler, juge, range.
///
/// `work` est l'agent : en vrai `agent::run_once` (voir [`trial`]) ; dans les
/// tests, une fonction qui écrit une solution. Le worktree est rangé quoi qu'il
/// arrive.
pub async fn trial_with<F, Fut>(
	repo: &Path,
	case: &Case,
	setup: &Setup,
	commands: &[String],
	dir: &Path,
	timeout: Duration,
	work: F,
) -> Result<Trial>
where
	F: FnOnce(String, String) -> Fut,
	Fut: std::future::Future<Output = Result<Worked>>,
{
	prepare(repo, case, dir).await?;
	let worked = work(dir.to_string_lossy().to_string(), trial_prompt(case, setup, commands)).await;
	let (judgement, error, cost_usd, duration_ms) = match worked {
		Ok(worked) => {
			(Some(judge(repo, dir, case, commands, timeout).await), None, worked.cost_usd, worked.duration_ms)
		}
		Err(error) => (None, Some(error.to_string()), 0.0, 0),
	};
	discard(repo, dir).await;
	Ok(Trial {
		at: chrono::Utc::now().to_rfc3339(),
		number: case.number,
		title: case.title.clone(),
		setup: setup.clone(),
		judgement,
		error,
		cost_usd,
		duration_ms,
	})
}

/// Joue un essai avec un vrai agent, et l'enregistre.
pub async fn trial(repo: &Path, case: &Case, setup: &Setup, commands: &[String], timeout: Duration) -> Result<Trial> {
	let stamp = chrono::Utc::now().timestamp_millis();
	let dir = trials_dir(repo).join(format!("essai-{stamp}"));
	if let Some(parent) = dir.parent() {
		std::fs::create_dir_all(parent)?;
	}
	let engine = setup.engine.clone();
	let model = setup.model.clone();
	let depth = setup.depth.clone();
	let config = crate::config::Config::for_repo(&repo.to_string_lossy());
	let done = trial_with(repo, case, setup, commands, &dir, timeout, |cwd, prompt| async move {
		let shot = crate::agent::run_once_with_config(
			config,
			&cwd,
			&prompt,
			&engine,
			&model,
			&depth,
			&FORBIDDEN,
			"",
			crate::executions::Origin::cockpit("rejeu"),
		)
		.await?;
		Ok(Worked { cost_usd: shot.cost_usd, duration_ms: shot.duration_ms })
	})
	.await?;
	record(repo, &done)?;
	Ok(done)
}

/// Où vivent les essais d'un dépôt : sous la configuration, jamais dans le dépôt.
fn trials_dir(repo: &Path) -> std::path::PathBuf {
	crate::config::config_dir().join("rejeu").join(crate::mcp::key_of(&repo.to_string_lossy()))
}

/// Ajoute un essai au relevé du dépôt — en ajout seul, comme les exécutions.
pub fn record(repo: &Path, trial: &Trial) -> Result<()> {
	use std::io::Write;
	let dir = trials_dir(repo);
	std::fs::create_dir_all(&dir)?;
	let mut file = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("essais.jsonl"))?;
	let line = serde_json::to_string(trial).map_err(|e| crate::error::CockpitError::msg(e.to_string()))?;
	writeln!(file, "{line}")?;
	Ok(())
}

/// Les essais enregistrés pour ce dépôt, les plus récents d'abord.
pub fn trials(repo: &Path) -> Vec<Trial> {
	let raw = std::fs::read_to_string(trials_dir(repo).join("essais.jsonl")).unwrap_or_default();
	let mut all: Vec<Trial> = raw.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
	all.reverse();
	all
}

// ── Les campagnes ────────────────────────────────────────────────────────────

/// Au plus cinq essais par campagne (cas × configurations). Chaque essai est
/// une vraie tâche d'agent, prise sur l'abonnement : on commence petit.
pub const MAX_TRIALS: usize = 5;

/// Le temps laissé aux portes pour juger un essai.
const GATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Où en est la campagne en cours, s'il y en a une.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
	pub repo: String,
	pub done: usize,
	pub total: usize,
}

fn progress_slot() -> &'static std::sync::Mutex<Option<Progress>> {
	static SLOT: std::sync::OnceLock<std::sync::Mutex<Option<Progress>>> = std::sync::OnceLock::new();
	SLOT.get_or_init(Default::default)
}

/// La campagne en cours, s'il y en a une.
pub fn progress() -> Option<Progress> {
	progress_slot().lock().unwrap().clone()
}

/// Réserve la place d'une campagne : une seule à la fois, et jamais plus de
/// [`MAX_TRIALS`] essais.
pub fn reserve(repo: &Path, total: usize) -> Result<()> {
	if total == 0 {
		return Err(crate::error::CockpitError::msg(crate::i18n::t("replay.nothingToRun")));
	}
	if total > MAX_TRIALS {
		return Err(crate::error::CockpitError::msg(crate::i18n::tf(
			"replay.tooMany",
			&[("count", &total), ("max", &MAX_TRIALS)],
		)));
	}
	let mut slot = progress_slot().lock().unwrap();
	if slot.is_some() {
		return Err(crate::error::CockpitError::msg(crate::i18n::t("replay.alreadyRunning")));
	}
	*slot = Some(Progress { repo: repo.to_string_lossy().to_string(), done: 0, total });
	Ok(())
}

/// Joue une campagne réservée : chaque cas est d'abord vérifié — ses tests
/// doivent échouer sur le code d'avant — puis essayé avec chaque
/// configuration. Un cas qui ne sait pas échouer est écarté sans dépenser
/// d'essai, et le relevé dit pourquoi.
pub async fn run_campaign(repo: std::path::PathBuf, cases: Vec<Case>, setups: Vec<Setup>, commands: Vec<String>) {
	// La place se libère quoi qu'il arrive — fin normale, panique, tâche
	// abandonnée : sans quoi l'écran resterait « en cours » jusqu'au
	// redémarrage, et plus aucune campagne ne pourrait partir.
	struct Release;
	impl Drop for Release {
		fn drop(&mut self) {
			if let Ok(mut slot) = progress_slot().lock() {
				*slot = None;
			}
		}
	}
	let _release = Release;
	// Une seule campagne à la fois : ce qui traîne vient d'une précédente,
	// interrompue.
	sweep(&repo);
	let advance = |count: usize| {
		if let Some(progress) = progress_slot().lock().unwrap().as_mut() {
			progress.done += count;
		}
	};
	for case in &cases {
		let check = trials_dir(&repo).join(format!("controle-{}", chrono::Utc::now().timestamp_millis()));
		let _ = std::fs::create_dir_all(trials_dir(&repo));
		let refusal = match self::check(&repo, case, &check, &commands, GATE_TIMEOUT).await {
			Ok(Check::Usable) => None,
			Ok(Check::Unusable { reason }) => Some(reason),
			Err(error) => Some(error.to_string()),
		};
		if let Some(reason) = refusal {
			for setup in &setups {
				let _ = record(
					&repo,
					&Trial {
						at: chrono::Utc::now().to_rfc3339(),
						number: case.number,
						title: case.title.clone(),
						setup: setup.clone(),
						judgement: Some(Judgement {
							verdict: Verdict::NotJudgeable { reason: reason.clone() },
							agent_files: Vec::new(),
							shared_files: Vec::new(),
						}),
						error: None,
						cost_usd: 0.0,
						duration_ms: 0,
					},
				);
			}
			advance(setups.len());
			continue;
		}
		for setup in &setups {
			if let Err(error) = trial(&repo, case, setup, &commands, GATE_TIMEOUT).await {
				let _ = record(
					&repo,
					&Trial {
						at: chrono::Utc::now().to_rfc3339(),
						number: case.number,
						title: case.title.clone(),
						setup: setup.clone(),
						judgement: None,
						error: Some(error.to_string()),
						cost_usd: 0.0,
						duration_ms: 0,
					},
				);
			}
			advance(1);
		}
	}
}

/// Range le worktree d'un essai, quoi qu'il contienne.
pub async fn discard(_repo: &Path, dir: &Path) {
	remove_tree(dir);
}

/// Supprime un dossier d'essai, fichiers en lecture seule compris : git écrit
/// ses objets en lecture seule, et Windows refuse de les effacer tels quels.
fn remove_tree(dir: &Path) {
	if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
		return;
	}
	fn writable(path: &Path) {
		if let Ok(entries) = std::fs::read_dir(path) {
			for entry in entries.flatten() {
				let child = entry.path();
				if child.is_dir() {
					writable(&child);
				} else if let Ok(meta) = std::fs::metadata(&child) {
					let mut permissions = meta.permissions();
					#[allow(clippy::permissions_set_readonly_false)]
					permissions.set_readonly(false);
					let _ = std::fs::set_permissions(&child, permissions);
				}
			}
		}
	}
	writable(dir);
	let _ = std::fs::remove_dir_all(dir);
}

/// Range ce qu'une campagne interrompue a laissé : des dossiers d'essai et de
/// contrôle qu'aucun `discard` n'a refermés (app fermée en plein essai).
fn sweep(repo: &Path) {
	let Ok(entries) = std::fs::read_dir(trials_dir(repo)) else { return };
	for entry in entries.flatten() {
		let name = entry.file_name().to_string_lossy().to_string();
		if entry.path().is_dir() && (name.starts_with("essai-") || name.starts_with("controle-")) {
			remove_tree(&entry.path());
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::path::PathBuf;

	#[test]
	fn les_fichiers_de_test_se_reconnaissent() {
		for path in [
			"tests/cart.test.js",
			"src/__tests__/total.ts",
			"src/cart.test.ts",
			"pkg/total_test.go",
			"test_total.py",
			"spec/models/cart_spec.rb",
			"crates/core/tests/integration.rs",
		] {
			assert!(is_test_file(path), "{path}");
		}
		for path in ["src/cart.js", "src/latest.rs", "docs/testing.md", "contest/main.py"] {
			assert!(!is_test_file(path), "{path}");
		}
	}

	#[test]
	fn le_numero_et_le_titre_d_une_pr_se_lisent() {
		assert_eq!(
			parse_pr("Merge pull request #12 from me/fix-total", "\nCart total uses quantities\n"),
			Some((Some(12), "Cart total uses quantities".into()))
		);
		assert_eq!(
			parse_pr("Cart total uses quantities (#12)", ""),
			Some((Some(12), "Cart total uses quantities".into()))
		);
		assert_eq!(parse_pr("Version 0.86.4", ""), None);
		assert_eq!(parse_pr("Fix (#abc)", ""), None);
	}

	fn depot(nom: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!("cockpit-rejeu-{}-{nom}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(dir.join("src")).unwrap();
		dir
	}

	fn git(dir: &Path, args: &[&str]) {
		let sortie = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
		assert!(sortie.status.success(), "git {args:?} : {}", String::from_utf8_lossy(&sortie.stderr));
	}

	/// Un dépôt avec une PR fusionnée : elle corrige `src/cart.txt` et ajoute
	/// le test qui le vérifie.
	fn depot_avec_une_pr(nom: &str) -> PathBuf {
		let dir = depot(nom);
		git(&dir, &["init", "--quiet", "--initial-branch=main"]);
		git(&dir, &["config", "user.email", "test@example.invalid"]);
		git(&dir, &["config", "user.name", "Test"]);
		std::fs::write(dir.join("src/cart.txt"), "total = sum(price)\n").unwrap();
		git(&dir, &["add", "."]);
		git(&dir, &["commit", "--quiet", "-m", "Le panier"]);
		git(&dir, &["checkout", "--quiet", "-b", "fix-total"]);
		std::fs::write(dir.join("src/cart.txt"), "total = sum(price * quantity)\n").unwrap();
		std::fs::create_dir_all(dir.join("tests")).unwrap();
		std::fs::write(dir.join("tests/total.test.sh"), "grep -q quantity src/cart.txt\n").unwrap();
		git(&dir, &["add", "."]);
		git(&dir, &["commit", "--quiet", "-m", "Le total compte les quantités"]);
		git(&dir, &["checkout", "--quiet", "main"]);
		git(
			&dir,
			&[
				"merge",
				"--no-ff",
				"--quiet",
				"-m",
				"Merge pull request #7 from me/fix-total",
				"-m",
				"Cart total uses quantities",
				"fix-total",
			],
		);
		dir
	}

	#[tokio::test]
	async fn une_pr_fusionnee_devient_un_cas_qui_sait_echouer_et_se_juge() {
		let repo = depot_avec_une_pr("cas");
		let found = cases(&repo, "main", 10).await.unwrap();
		assert_eq!(found.len(), 1, "{found:?}");
		let case = &found[0];
		assert_eq!(case.number, Some(7));
		assert_eq!(case.title, "Cart total uses quantities");
		assert_eq!(case.tests, vec!["tests/total.test.sh".to_string()]);
		assert_eq!(case.sources, vec!["src/cart.txt".to_string()]);

		let commands = vec!["bash tests/total.test.sh".to_string()];
		let timeout = Duration::from_secs(60);

		// Le code d'avant échoue aux tests de l'humain, la solution humaine les
		// passe : le cas est utilisable.
		let essai = repo.with_file_name(format!("{}-essai", repo.file_name().unwrap().to_string_lossy()));
		assert_eq!(check(&repo, case, &essai, &commands, timeout).await.unwrap(), Check::Usable);
		assert!(!essai.exists(), "le dossier de contrôle est rangé");

		// Le dossier d'essai n'a aucune histoire après le commit d'avant : ni la
		// tête de la PR, ni la branche principale, ni ses tests.
		prepare(&repo, case, &essai).await.unwrap();
		let tete = std::process::Command::new("git")
			.args(["cat-file", "-e", &case.head])
			.current_dir(&essai)
			.status()
			.unwrap();
		assert!(!tete.success(), "la solution humaine est introuvable depuis l'essai");
		let refs = std::process::Command::new("git").args(["for-each-ref"]).current_dir(&essai).output().unwrap();
		assert!(String::from_utf8_lossy(&refs.stdout).trim().is_empty(), "aucune référence");
		assert!(!essai.join("tests/total.test.sh").exists());
		discard(&repo, &essai).await;
		assert!(!essai.exists(), "le dossier d'essai est rangé");

		// Un agent qui trouve une solution — autrement écrite que celle de l'humain.
		prepare(&repo, case, &essai).await.unwrap();
		std::fs::write(essai.join("src/cart.txt"), "total = sum(price * line.quantity)\n").unwrap();
		std::fs::write(essai.join("src/notes.txt"), "pourquoi\n").unwrap();
		let jugement = judge(&repo, &essai, case, &commands, timeout).await;
		assert_eq!(jugement.verdict, Verdict::Resolved);
		assert_eq!(jugement.shared_files, vec!["src/cart.txt".to_string()]);
		assert!(jugement.agent_files.contains(&"src/notes.txt".to_string()));
		discard(&repo, &essai).await;

		// Un agent qui ne trouve pas.
		prepare(&repo, case, &essai).await.unwrap();
		let jugement = judge(&repo, &essai, case, &commands, timeout).await;
		assert!(matches!(jugement.verdict, Verdict::Failed { .. }));
		assert!(jugement.agent_files.is_empty());
		discard(&repo, &essai).await;

		// Sans portes, on ne juge pas.
		prepare(&repo, case, &essai).await.unwrap();
		let jugement = judge(&repo, &essai, case, &[], timeout).await;
		assert!(matches!(jugement.verdict, Verdict::NotJudgeable { .. }));
		discard(&repo, &essai).await;

		let _ = std::fs::remove_dir_all(&repo);
	}

	/// Un cas dont la solution humaine échoue aux portes d'aujourd'hui (une
	/// porte qui n'existait pas à l'époque) ne fait pas compter d'échecs : il
	/// est écarté, avec sa raison. De même un cas dont les tests passent déjà.
	#[tokio::test]
	async fn un_cas_qui_ne_prouverait_rien_est_ecarte() {
		let repo = depot_avec_une_pr("ecarte");
		let case = cases(&repo, "main", 10).await.unwrap().remove(0);
		let timeout = Duration::from_secs(60);
		let essai = repo.with_file_name(format!("{}-c", repo.file_name().unwrap().to_string_lossy()));

		let porte_nouvelle = vec!["bash tests/total.test.sh".to_string(), "bash scripts/absent.sh".to_string()];
		let humain = check(&repo, &case, &essai, &porte_nouvelle, timeout).await.unwrap();
		assert!(matches!(humain, Check::Unusable { .. }), "{humain:?}");

		let toujours_vert = vec!["true".to_string()];
		let deja = check(&repo, &case, &essai, &toujours_vert, timeout).await.unwrap();
		assert!(matches!(deja, Check::Unusable { .. }), "{deja:?}");
		assert!(!essai.exists());
		let _ = std::fs::remove_dir_all(&repo);
	}

	/// Les dépendances s'installent d'après le fichier de verrouillage, et rien
	/// ne s'installe là où il n'y a pas de `package.json`.
	#[test]
	fn l_installation_suit_le_fichier_de_verrouillage() {
		let dir = depot("verrou");
		assert_eq!(install_command(&dir), None);
		std::fs::write(dir.join("package.json"), "{}").unwrap();
		assert_eq!(install_command(&dir).as_deref(), Some("npm install"));
		std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
		assert_eq!(install_command(&dir).as_deref(), Some("npm ci"));
		std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
		assert_eq!(install_command(&dir).as_deref(), Some("pnpm install --frozen-lockfile"));
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Un projet JavaScript : le worktree d'essai reçoit ses dépendances avant
	/// tout jugement. Sans réseau ni dépendance déclarée, `npm install` passe.
	#[tokio::test]
	async fn le_worktree_d_un_projet_js_recoit_ses_dependances() {
		let repo = depot_avec_une_pr("js");
		std::fs::write(repo.join("package.json"), r#"{"name":"essai","version":"1.0.0","private":true}"#).unwrap();
		git(&repo, &["add", "."]);
		git(&repo, &["commit", "--quiet", "-m", "Un package.json"]);
		let case = Case {
			number: Some(1),
			title: "essai".into(),
			base: "HEAD".into(),
			head: "HEAD".into(),
			tests: Vec::new(),
			sources: Vec::new(),
		};
		let dir = repo.with_file_name(format!("{}-w", repo.file_name().unwrap().to_string_lossy()));
		prepare(&repo, &case, &dir).await.unwrap();
		assert!(dir.join("package-lock.json").exists(), "npm install a tourné dans le worktree");
		discard(&repo, &dir).await;
		let _ = std::fs::remove_dir_all(&repo);
	}

	/// Une seule campagne à la fois, jamais plus de cinq essais, jamais zéro.
	#[test]
	fn une_campagne_se_reserve_dans_ses_bornes() {
		let repo = Path::new("/depot");
		assert!(reserve(repo, 0).is_err());
		assert!(reserve(repo, MAX_TRIALS + 1).is_err());
		assert!(progress().is_none());
		reserve(repo, 2).unwrap();
		assert_eq!(progress().map(|p| (p.done, p.total)), Some((0, 2)));
		assert!(reserve(repo, 1).is_err(), "une seule campagne à la fois");
		*progress_slot().lock().unwrap() = None;
	}

	/// La consigne ne dit rien de la solution : ni ses fichiers, ni ses tests.
	#[test]
	fn la_consigne_ne_livre_pas_la_solution() {
		let case = Case {
			number: Some(7),
			title: "Cart total uses quantities".into(),
			base: "a".into(),
			head: "b".into(),
			tests: vec!["tests/total.test.sh".into()],
			sources: vec!["src/cart.txt".into()],
		};
		let setup = Setup { instructions: "Write the test first.".into(), ..Default::default() };
		let prompt = trial_prompt(&case, &setup, &["npm test".to_string()]);
		assert!(prompt.contains("Cart total uses quantities"));
		assert!(prompt.contains("`npm test`"));
		assert!(prompt.contains("Write the test first."));
		for fuite in ["total.test.sh", "src/cart.txt", "quantity)"] {
			assert!(!prompt.contains(fuite), "{fuite}");
		}
	}

	/// Un essai complet, avec un agent simulé : il travaille dans le worktree
	/// préparé, le jugement suit, et le worktree est rangé — y compris quand
	/// l'agent échoue.
	#[tokio::test]
	async fn un_essai_se_joue_se_juge_et_se_range() {
		let repo = depot_avec_une_pr("essai");
		let case = cases(&repo, "main", 10).await.unwrap().remove(0);
		let commands = vec!["bash tests/total.test.sh".to_string()];
		let timeout = Duration::from_secs(60);
		let dir = repo.with_file_name(format!("{}-w", repo.file_name().unwrap().to_string_lossy()));
		let setup = Setup { label: "simulé".into(), ..Default::default() };

		let reussi = trial_with(&repo, &case, &setup, &commands, &dir, timeout, |cwd, prompt| async move {
			assert!(prompt.contains("Cart total uses quantities"));
			std::fs::write(Path::new(&cwd).join("src/cart.txt"), "total = sum(price * quantity)\n").unwrap();
			Ok(Worked { cost_usd: 0.12, duration_ms: 900 })
		})
		.await
		.unwrap();
		assert_eq!(reussi.judgement.as_ref().map(|j| &j.verdict), Some(&Verdict::Resolved));
		assert_eq!(reussi.cost_usd, 0.12);
		assert_eq!(reussi.setup.label, "simulé");
		assert!(!dir.exists(), "rangé après un essai");

		let rate = trial_with(&repo, &case, &setup, &commands, &dir, timeout, |_, _| async {
			Err(crate::error::CockpitError::msg("délai dépassé"))
		})
		.await
		.unwrap();
		assert!(rate.judgement.is_none());
		assert_eq!(rate.error.as_deref(), Some("délai dépassé"));
		assert!(!dir.exists(), "rangé même quand l'agent échoue");

		// Un essai enregistré se relit.
		let relu: Trial = serde_json::from_str(&serde_json::to_string(&reussi).unwrap()).unwrap();
		assert_eq!(relu, reussi);

		let _ = std::fs::remove_dir_all(&repo);
	}
}
