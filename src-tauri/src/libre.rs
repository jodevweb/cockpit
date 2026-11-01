//! Les agents libres : un dossier, un agent, rien d'autre.
//!
//! Le parcours habituel passe par un projet, un workspace, souvent un worktree
//! monté par la commande de l'équipe. C'est le bon chemin pour le travail suivi,
//! et le mauvais pour « ouvre un agent dans ce dossier » — ce qu'on faisait
//! jusque-là au terminal, avec `cd` puis `claude`.
//!
//! Ce module ne fait que ce que ce geste-là ferait au terminal : regarder le
//! dossier, sortir une branche ou un worktree si on le demande, et les ranger à
//! la fin. Il ne connaît ni projet ni commande d'équipe : un `git worktree add`
//! nu, comme on l'aurait tapé. Le lancement lui-même reste celui de tous les
//! agents (`agent::start_profiled`).

use crate::error::{CockpitError, Result};
use crate::git::run_git;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Ce qu'on sait d'un dossier avant d'y lancer un agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
	/// Chemin absolu, tilde résolu.
	pub path: String,
	pub exists: bool,
	pub is_git: bool,
	/// Racine du dépôt, quand le dossier en est un (ou en fait partie).
	pub root: String,
	/// Branche sortie ; vide sur une HEAD détachée.
	pub branch: String,
	/// Fichiers modifiés ou non suivis.
	pub dirty: usize,
}

/// Où l'agent travaillera, une fois la branche ou le worktree prêts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
	pub cwd: String,
	pub branch: String,
	/// Dossier du worktree créé pour lui ; vide s'il travaille sur place.
	pub worktree: String,
}

fn absolute(raw: &str) -> PathBuf {
	PathBuf::from(crate::config::resolve_path(raw, ""))
}

pub async fn inspect(raw: &str) -> Inspection {
	let path = absolute(raw);
	let mut found = Inspection {
		path: path.to_string_lossy().to_string(),
		exists: path.is_dir(),
		is_git: false,
		root: String::new(),
		branch: String::new(),
		dirty: 0,
	};
	if !found.exists {
		return found;
	}
	if let Ok(root) = run_git(&path, &["rev-parse", "--show-toplevel"]).await {
		found.is_git = true;
		found.root = root.trim().to_string();
		found.branch = run_git(&path, &["branch", "--show-current"])
			.await
			.map(|out| out.trim().to_string())
			.unwrap_or_default();
		found.dirty = run_git(&path, &["status", "--porcelain"])
			.await
			.map(|out| out.lines().filter(|line| !line.trim().is_empty()).count())
			.unwrap_or(0);
	}
	found
}

/// Un nom de dossier tiré d'une branche : `agent/export-pdf` → `export-pdf`.
fn folder_for(branch: &str) -> String {
	let tail = branch.rsplit('/').next().unwrap_or(branch);
	let cleaned: String = tail
		.chars()
		.map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
		.collect();
	let cleaned = cleaned.trim_matches('-').to_string();
	if cleaned.is_empty() { "agent".into() } else { cleaned }
}

/// Le dossier du worktree : à côté du dépôt, `<dépôt>-<branche>`, comme on le
/// range d'habitude à la main. Un nom déjà pris reçoit un suffixe plutôt que
/// d'écraser quoi que ce soit.
fn worktree_path(root: &Path, branch: &str) -> PathBuf {
	let parent = root.parent().unwrap_or(root);
	let repo = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "depot".into());
	let base = format!("{repo}-{}", folder_for(branch));
	let mut candidate = parent.join(&base);
	let mut index = 2;
	while candidate.exists() {
		candidate = parent.join(format!("{base}-{index}"));
		index += 1;
	}
	candidate
}

/// Prépare l'endroit où l'agent travaillera.
///
/// `place` : `ici` (rien n'est créé), `branche` (`git switch -c` dans le
/// dossier même) ou `worktree` (une copie à part, sur une branche neuve partie
/// de la HEAD du dossier). Un dossier hors git ne connaît que `ici`.
pub async fn prepare(raw: &str, place: &str, branch: &str) -> Result<Prepared> {
	let found = inspect(raw).await;
	if !found.exists {
		return Err(CockpitError::msg(format!("Dossier introuvable : {}", found.path)));
	}
	let branch = branch.trim();
	if place == "ici" || !found.is_git {
		return Ok(Prepared { cwd: found.path, branch: found.branch, worktree: String::new() });
	}
	if branch.is_empty() {
		return Err(CockpitError::msg("Donne un nom à la branche de l'agent."));
	}
	let path = PathBuf::from(&found.path);
	match place {
		"branche" => {
			run_git(&path, &["switch", "-c", branch]).await?;
			Ok(Prepared { cwd: found.path, branch: branch.to_string(), worktree: String::new() })
		}
		"worktree" => {
			let root = PathBuf::from(&found.root);
			let target = worktree_path(&root, branch);
			let target_str = target.to_string_lossy().to_string();
			run_git(&root, &["worktree", "add", "-b", branch, &target_str, "HEAD"]).await?;
			// Lancé depuis un sous-dossier du dépôt : l'agent repart du même
			// sous-dossier, dans sa copie.
			let inside = Path::new(&found.path).strip_prefix(&root).map(Path::to_path_buf).unwrap_or_default();
			let cwd = target.join(inside);
			Ok(Prepared {
				cwd: cwd.to_string_lossy().to_string(),
				branch: branch.to_string(),
				worktree: target_str,
			})
		}
		other => Err(CockpitError::msg(format!("Emplacement inconnu : {other}"))),
	}
}

/// Range ce qu'un agent libre laisse derrière lui.
///
/// `keep` : le worktree s'en va, la branche reste (refusé si le worktree a des
/// modifications non commitées — elles ne sont nulle part ailleurs). `discard` :
/// worktree et branche supprimés, sans condition. Sans worktree, rien à faire.
pub async fn archive(worktree: &str, branch: &str, action: &str) -> Result<()> {
	let worktree = worktree.trim();
	if worktree.is_empty() || !Path::new(worktree).exists() {
		return Ok(());
	}
	let tree = PathBuf::from(worktree);
	// `git worktree remove` se joue depuis le dépôt principal : le dossier qu'on
	// supprime ne peut pas être celui d'où l'on parle.
	let common = run_git(&tree, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
	let main = PathBuf::from(common.trim()).parent().map(Path::to_path_buf).unwrap_or_else(|| tree.clone());
	match action {
		"keep" => {
			run_git(&main, &["worktree", "remove", worktree]).await.map_err(|error| {
				CockpitError::msg(format!(
					"Le worktree a des modifications non commitées : commite-les ou choisis « Tout jeter ». ({error})"
				))
			})?;
		}
		"discard" => {
			run_git(&main, &["worktree", "remove", "--force", worktree]).await?;
			if !branch.trim().is_empty() {
				run_git(&main, &["branch", "-D", branch.trim()]).await?;
			}
		}
		_ => {}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dossier_tire_de_la_branche() {
		assert_eq!(folder_for("agent/export-pdf"), "export-pdf");
		assert_eq!(folder_for("fix/é clair"), "clair");
		assert_eq!(folder_for("///"), "agent");
	}

	#[tokio::test]
	async fn worktree_sur_un_vrai_depot() {
		let base = std::env::temp_dir().join(format!("cockpit-libre-{}", std::process::id()));
		let repo = base.join("depot");
		std::fs::create_dir_all(&repo).unwrap();
		for args in [
			vec!["init", "-q", "-b", "main"],
			vec!["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
		] {
			run_git(&repo, &args).await.unwrap();
		}
		let repo_str = repo.to_string_lossy().to_string();

		let seen = inspect(&repo_str).await;
		assert!(seen.is_git);
		assert_eq!(seen.branch, "main");

		let ready = prepare(&repo_str, "worktree", "agent/essai").await.unwrap();
		assert!(ready.worktree.ends_with("depot-essai"));
		assert_eq!(inspect(&ready.cwd).await.branch, "agent/essai");

		archive(&ready.worktree, &ready.branch, "discard").await.unwrap();
		assert!(!Path::new(&ready.worktree).exists());
		assert!(run_git(&repo, &["rev-parse", "--verify", "refs/heads/agent/essai"]).await.is_err());

		let _ = std::fs::remove_dir_all(&base);
	}
}
