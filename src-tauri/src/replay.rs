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

/// Prépare le worktree d'un essai : détaché, au commit d'avant la PR.
pub async fn prepare(repo: &Path, case: &Case, dir: &Path) -> Result<()> {
	let dir = dir.to_string_lossy();
	crate::git::run_git(repo, &["worktree", "add", "--detach", "--quiet", &dir, &case.base]).await?;
	Ok(())
}

/// Pose dans le worktree les fichiers de test de la PR humaine.
async fn apply_tests(worktree: &Path, case: &Case) -> Result<()> {
	let mut args = vec!["checkout", case.head.as_str(), "--"];
	args.extend(case.tests.iter().map(String::as_str));
	crate::git::run_git(worktree, &args).await?;
	Ok(())
}

/// Les fichiers changés dans le worktree depuis le commit d'avant, fichiers
/// non suivis compris : ce que l'agent a produit.
async fn changed_files(worktree: &Path, base: &str) -> Result<Vec<String>> {
	// `--intent-to-add` rend visibles les fichiers nouveaux sans rien indexer
	// de leur contenu : le worktree est jetable, mais autant n'y rien figer.
	crate::git::run_git(worktree, &["add", "--all", "--intent-to-add"]).await?;
	let raw = crate::git::run_git(worktree, &["diff", "--name-only", base]).await?;
	Ok(raw.lines().map(str::trim).filter(|line| !line.is_empty()).map(String::from).collect())
}

/// Le cas sait-il échouer ? Ses tests, posés sur le code d'avant, doivent
/// échouer : sinon ils ne distinguent pas une bonne solution d'une absence de
/// solution, et le cas ne prouve rien.
///
/// Rend le jugement de ce code d'avant : `Failed` est ce qu'on attend d'un
/// bon cas.
pub async fn baseline(repo: &Path, case: &Case, dir: &Path, commands: &[String], timeout: Duration) -> Result<Verdict> {
	prepare(repo, case, dir).await?;
	let judged = judge(dir, case, commands, timeout).await.verdict;
	discard(repo, dir).await;
	Ok(judged)
}

/// Juge ce que contient le worktree d'un essai.
///
/// Dans l'ordre : relever ce que l'agent a touché, poser les tests de
/// l'humain, jouer les portes. Des tests qui ne s'appliquent pas, ou l'absence
/// de portes, rendent l'essai non jugeable — et le disent.
pub async fn judge(worktree: &Path, case: &Case, commands: &[String], timeout: Duration) -> Judgement {
	let agent_files: Vec<String> = changed_files(worktree, &case.base)
		.await
		.unwrap_or_default()
		.into_iter()
		.filter(|path| !case.tests.contains(path))
		.collect();
	let shared_files = agent_files.iter().filter(|path| case.sources.contains(path)).cloned().collect();
	let verdict = if commands.is_empty() {
		Verdict::NotJudgeable { reason: crate::i18n::t("replay.noGates") }
	} else if let Err(error) = apply_tests(worktree, case).await {
		Verdict::NotJudgeable { reason: crate::i18n::tf("replay.testsDontApply", &[("error", &error)]) }
	} else {
		let outcome = crate::gates::run(&worktree.to_string_lossy(), commands, timeout).await;
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
			(Some(judge(dir, case, commands, timeout).await), None, worked.cost_usd, worked.duration_ms)
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
	let done = trial_with(repo, case, setup, commands, &dir, timeout, |cwd, prompt| async move {
		let shot = crate::agent::run_once(
			&cwd,
			&prompt,
			&engine,
			&model,
			&depth,
			&FORBIDDEN,
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

/// Range le worktree d'un essai, quoi qu'il contienne.
pub async fn discard(repo: &Path, dir: &Path) {
	let path = dir.to_string_lossy();
	if crate::git::run_git(repo, &["worktree", "remove", "--force", &path]).await.is_err() {
		let _ = std::fs::remove_dir_all(dir);
		let _ = crate::git::run_git(repo, &["worktree", "prune"]).await;
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

		// Le code d'avant échoue aux tests de l'humain : le cas sait échouer.
		let essai = repo.with_file_name(format!("{}-essai", repo.file_name().unwrap().to_string_lossy()));
		let avant = baseline(&repo, case, &essai, &commands, timeout).await.unwrap();
		assert!(matches!(avant, Verdict::Failed { .. }), "{avant:?}");
		assert!(!essai.exists(), "le worktree d'essai est rangé");

		// Un agent qui trouve une solution — autrement écrite que celle de l'humain.
		prepare(&repo, case, &essai).await.unwrap();
		std::fs::write(essai.join("src/cart.txt"), "total = sum(price * line.quantity)\n").unwrap();
		std::fs::write(essai.join("src/notes.txt"), "pourquoi\n").unwrap();
		let jugement = judge(&essai, case, &commands, timeout).await;
		assert_eq!(jugement.verdict, Verdict::Resolved);
		assert_eq!(jugement.shared_files, vec!["src/cart.txt".to_string()]);
		assert!(jugement.agent_files.contains(&"src/notes.txt".to_string()));
		discard(&repo, &essai).await;

		// Un agent qui ne trouve pas.
		prepare(&repo, case, &essai).await.unwrap();
		let jugement = judge(&essai, case, &commands, timeout).await;
		assert!(matches!(jugement.verdict, Verdict::Failed { .. }));
		assert!(jugement.agent_files.is_empty());
		discard(&repo, &essai).await;

		// Sans portes, on ne juge pas.
		prepare(&repo, case, &essai).await.unwrap();
		let jugement = judge(&essai, case, &[], timeout).await;
		assert!(matches!(jugement.verdict, Verdict::NotJudgeable { .. }));
		discard(&repo, &essai).await;

		let _ = std::fs::remove_dir_all(&repo);
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
