//! La revue de code : un geste du cockpit, et des tours qui se suivent.
//!
//! Relire une PR se faisait à la main : retrouver sa branche, ouvrir ou créer
//! le worktree, retaper la consigne, lire une réponse en texte libre. Au tour
//! suivant — l'auteur a corrigé — tout recommençait, et rien ne se souvenait de
//! ce qu'on avait relevé la première fois.
//!
//! Ici, une revue appartient à une PR et se compose de tours. Chaque tour garde
//! le commit relu, ce que la PR fait, ses points (fichier, lignes, problème,
//! correction, commentaire à poster) et, pour une vérification, ce que sont
//! devenus les points du tour d'avant. L'agent ne rend pas du texte à relire :
//! il remet sa revue par un outil (`remettre_revue`), et c'est l'appel lui-même
//! que l'écran enregistre.
//!
//! **L'agent de revue ne modifie rien.** Il tourne en lecture seule (voir
//! `agent::start_with_mission`, profil `review`) : ni édition, ni commande qui
//! ne soit pas une lecture. On relit, on ne corrige pas — et c'est la personne
//! qui poste ses commentaires sur la PR, jamais l'agent.

use crate::config::{config_dir, Config};
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Finding {
	/// Stable d'un tour à l'autre : c'est par lui qu'une vérification dit ce
	/// qu'est devenu un point.
	pub id: String,
	/// `bloquant`, `important` ou `suggestion`.
	pub severity: String,
	pub file: String,
	/// Telles que l'agent les écrit : `42` ou `42-57`.
	pub lines: String,
	pub problem: String,
	pub fix: String,
	/// Le commentaire à poster soi-même sur la PR, simple et humain.
	pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Check {
	/// Le point d'un tour précédent dont on dit ce qu'il est devenu.
	pub id: String,
	/// `corrige`, `partiel` ou `non_corrige`.
	pub status: String,
	pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Round {
	pub number: u32,
	/// `revue` (complète) ou `verification` (après corrections).
	pub kind: String,
	pub at: String,
	/// Le commit relu. C'est lui qui dit, au tour suivant, ce qui a bougé.
	pub head_sha: String,
	/// Ce que fait la PR, pour la comprendre avant d'en lire les points.
	pub summary: String,
	/// `merge`, `corrections` ou `bloquant`.
	pub verdict: String,
	pub findings: Vec<Finding>,
	pub checks: Vec<Check>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Review {
	pub repo: String,
	pub number: i64,
	pub title: String,
	pub author: String,
	pub branch: String,
	pub base: String,
	pub url: String,
	pub rounds: Vec<Round>,
	/// Les points déjà postés sur la PR, par identifiant. À part des tours :
	/// cocher un point ne réécrit pas ce que l'agent a remis.
	pub posted: Vec<String>,
}

impl Review {
	/// Les points encore ouverts : ceux du dernier tour, et ceux d'avant qu'une
	/// vérification n'a pas dits corrigés.
	pub fn open_findings(&self) -> Vec<Finding> {
		let mut open: Vec<Finding> = Vec::new();
		for round in &self.rounds {
			for check in &round.checks {
				if check.status == "corrige" {
					open.retain(|finding| finding.id != check.id);
				}
			}
			for finding in &round.findings {
				open.retain(|known| known.id != finding.id);
				open.push(finding.clone());
			}
		}
		open
	}
}

fn reviews_dir() -> PathBuf {
	config_dir().join("reviews")
}

fn path_for(repo: &str, number: i64) -> PathBuf {
	let slug: String = repo
		.chars()
		.map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
		.collect();
	reviews_dir().join(format!("{slug}-{number}.json"))
}

pub fn load(repo: &str, number: i64) -> Option<Review> {
	let raw = std::fs::read_to_string(path_for(repo, number)).ok()?;
	serde_json::from_str(&raw).ok()
}

fn save(review: &Review) -> Result<()> {
	std::fs::create_dir_all(reviews_dir())?;
	let raw = serde_json::to_string_pretty(review).map_err(|e| CockpitError::msg(e.to_string()))?;
	std::fs::write(path_for(&review.repo, review.number), raw)?;
	Ok(())
}

/// Toutes les revues du dépôt, la plus récente d'abord.
pub fn list(repo: &str) -> Vec<Review> {
	let Ok(entries) = std::fs::read_dir(reviews_dir()) else {
		return Vec::new();
	};
	let mut out: Vec<Review> = entries
		.filter_map(|entry| std::fs::read_to_string(entry.ok()?.path()).ok())
		.filter_map(|raw| serde_json::from_str::<Review>(&raw).ok())
		.filter(|review| review.repo == repo)
		.collect();
	out.sort_by(|a, b| {
		let last = |review: &Review| review.rounds.last().map(|round| round.at.clone()).unwrap_or_default();
		last(b).cmp(&last(a))
	});
	out
}

pub fn set_posted(repo: &str, number: i64, finding: &str, posted: bool) -> Result<Review> {
	let mut review = load(repo, number).ok_or_else(|| CockpitError::msg(crate::i18n::t("review.noReview")))?;
	review.posted.retain(|id| id != finding);
	if posted {
		review.posted.push(finding.to_string());
	}
	save(&review)?;
	Ok(review)
}

// ───────────────────────────── Lecture seule ─────────────────────────────

/// Les sessions d'agents lancées pour relire : le pont d'autorisation refuse
/// toute demande qui vient d'elles.
fn readonly() -> &'static Mutex<HashSet<String>> {
	static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
	SET.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn mark_readonly(session: &str) {
	if let Ok(mut set) = readonly().lock() {
		set.insert(session.to_string());
	}
}

pub fn is_readonly(session: &str) -> bool {
	readonly().lock().map(|set| set.contains(session)).unwrap_or(false)
}

/// Ce qu'un agent de revue peut faire sans rien demander : lire.
///
/// Tout le reste passe par le pont d'autorisation, qui le refuse (voir
/// `watch_scopes`). Pas de `gh api` : il sait aussi écrire, et un motif
/// d'autorisation ne distingue pas une lecture d'un `-X POST`. Ce que dit la
/// PR, ses revues et ses commentaires, le cockpit les lui donne lui-même.
pub const READ_TOOLS: &[&str] = &[
	"Read",
	"Grep",
	"Glob",
	"LS",
	"Task",
	"TodoWrite",
	"Bash(git diff:*)",
	"Bash(git log:*)",
	"Bash(git show:*)",
	"Bash(git status:*)",
	"Bash(git blame:*)",
	"Bash(git rev-parse:*)",
	"Bash(git merge-base:*)",
	"Bash(git ls-files:*)",
	"Bash(gh pr view:*)",
	"Bash(gh pr diff:*)",
	"Bash(gh pr checks:*)",
	// Pas de `cat`, `find`, `head`… : une redirection ou un `-delete` en font des
	// écritures. Les outils de lecture du CLI font le même travail sans risque.
	"Bash(ls:*)",
	"Bash(wc:*)",
	"mcp__revue__remettre_revue",
];

pub const WRITE_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write", "NotebookEdit"];

// ───────────────────────────── Le pont ─────────────────────────────

fn bridge_path() -> PathBuf {
	config_dir().join("mcp-revue.mjs")
}

/// Le serveur MCP de la revue : un seul outil, qui accuse réception.
///
/// Il ne transporte rien : l'appel et son contenu passent déjà dans le flux de
/// l'agent, où l'écran les lit et les enregistre. Le serveur n'existe que pour
/// que l'outil existe — et qu'une revue soit remise par un appel structuré
/// plutôt que par un texte qu'il faudrait relire.
const BRIDGE: &str = r#"#!/usr/bin/env node
// Outil de revue du cockpit — généré, ne pas éditer à la main.
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const FINDING = {
  type: "object",
  properties: {
    id: { type: "string", description: "Short, stable identifier, e.g. R1, R2… Keep the identifier of a point already raised in a previous round." },
    severity: { type: "string", enum: ["bloquant", "important", "suggestion"], description: "bloquant = blocking. Use these enum values exactly as written." },
    file: { type: "string", description: "File path, relative to the repository root." },
    lines: { type: "string", description: "Line(s) in the PR version: \"42\" or \"42-57\"." },
    problem: { type: "string", description: "The problem, in one or two sentences." },
    fix: { type: "string", description: "The fix you would make, concretely." },
    comment: { type: "string", description: "The comment, simple and human, that the person will post themselves on this line of the PR." },
  },
  required: ["id", "severity", "file", "lines", "problem", "fix", "comment"],
};
const TOOLS = [
  {
    name: "remettre_revue",
    description:
      "Hands your review over to Cockpit, which displays it point by point. Call it once, at the end. You post nothing yourself on the PR.",
    inputSchema: {
      type: "object",
      properties: {
        pr: { type: "number", description: "The number of the reviewed PR." },
        kind: { type: "string", enum: ["revue", "verification"], description: "revue = full review. Use these enum values exactly as written." },
        summary: { type: "string", description: "What the PR does and how, to understand it: 10 lines at most, no fluff." },
        verdict: { type: "string", enum: ["merge", "corrections", "bloquant"], description: "merge: all good, the person can merge. corrections: changes needed. bloquant: blocking. Use these enum values exactly as written." },
        findings: { type: "array", items: FINDING, description: "The points raised in this round: blocking, important, suggestions. Empty if none." },
        checks: {
          type: "array",
          description: "For a verification: what became of each point from the previous round (corrige = fixed, partiel = partly fixed, non_corrige = not fixed).",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: ["corrige", "partiel", "non_corrige"] },
              note: { type: "string" },
            },
            required: ["id", "status"],
          },
        },
      },
      required: ["pr", "kind", "summary", "verdict", "findings"],
    },
  },
];
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cockpit-revue", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    } else if (message.method === "tools/call") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Review handed over to Cockpit. Finish with one summary sentence, without repeating the points." }] } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
"#;

/// Écrit le pont et rend le chemin de sa configuration MCP ; `None` sans Node.
pub fn bridge_config(sandboxed: bool) -> Option<String> {
	let node = if sandboxed { "node".to_string() } else { crate::agent::node_binary()? };
	std::fs::write(bridge_path(), BRIDGE).ok()?;
	let config = config_dir().join("mcp-revue.json");
	// Isolé, le CLI lit ces chemins depuis le conteneur : sous Windows, ils y
	// ont la forme `/c/Users/…` (voir `sandbox::container_path`).
	let seen = |path: &std::path::Path| {
		let path = path.to_string_lossy().to_string();
		if sandboxed { crate::sandbox::container_path(&path) } else { path }
	};
	let payload = json!({
		"mcpServers": { "revue": { "command": node, "args": [seen(&bridge_path())] } }
	});
	std::fs::write(&config, serde_json::to_string_pretty(&payload).ok()?).ok()?;
	Some(seen(&config))
}

// ───────────────────────────── Préparer un tour ─────────────────────────────

/// Ta consigne de revue, telle qu'on la retaperait. Remplaçable dans la
/// bibliothèque de prompts (identifiant `revue`) ; `{pr}`, `{titre}`,
/// `{auteur}`, `{branche}` et `{base}` y sont remplacés.
pub const REVIEW_TEMPLATE: &str = "Give me a complete code review of PR #{pr} (\"{titre}\", by {auteur}, \
branch {branche} into {base}). Return a summary of only the blocking points, important points and \
suggestions, no fluff. For each point: the file, the affected line(s), the problem, the fix you would \
make, then a simple, human message I can write myself as a comment in the PR's \"Files changed\". You do \
not comment anything yourself: you give me the information, I do the rest. I also need to understand the \
PR and the code.";

/// La consigne d'un tour de vérification (identifiant `revue-suivi`).
pub const FOLLOWUP_TEMPLATE: &str = "{auteur} pushed fixes to PR #{pr} (\"{titre}\") since our last \
review. Check each of the points raised: fixed, partly, or not. Then do a new code review of what \
changed, with the same requirements: file, lines, problem, fix, and a simple, human message for me to \
post myself. Or tell me if everything is perfect and I can merge.";

fn template(id: &str, fallback: &str) -> String {
	crate::prompts::list()
		.into_iter()
		.find(|prompt| prompt.id == id)
		.map(|prompt| prompt.text)
		.unwrap_or_else(|| fallback.to_string())
}

fn clip(text: &str, max: usize) -> String {
	let flat = text.trim();
	if flat.chars().count() <= max {
		return flat.to_string();
	}
	format!("{}…", flat.chars().take(max).collect::<String>())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
	pub number: i64,
	pub title: String,
	pub author: String,
	pub branch: String,
	pub base: String,
	pub url: String,
	pub head_sha: String,
	/// Le worktree déjà sorti sur cette branche, s'il y en a un.
	pub worktree: Option<String>,
	pub prompt: String,
	/// Ce qui empêche un tour de vérification d'avoir un sens — aucun tour
	/// avant, ou rien de neuf depuis — dit plutôt que deviné.
	pub warning: Option<String>,
}

/// Tout ce qu'il faut pour lancer un tour : la PR, sa branche à jour, son
/// worktree s'il existe, et la consigne complète.
pub async fn prepare(config: &Config, number: i64, kind: &str) -> Result<Prepared> {
	let repo = config.github.repo.trim().to_string();
	if repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("review.noRepo")));
	}
	let conversation = crate::integrations::github_pull_conversation(config, &number.to_string()).await?;
	let detail = &conversation["detail"];
	let text = |pointer: &str| detail.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string();
	let title = text("/title");
	let author = text("/user/login");
	let branch = text("/head/ref");
	let base = text("/base/ref");
	let url = text("/html_url");
	let head_sha = text("/head/sha");
	let body = text("/body");
	if branch.is_empty() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"review.prNotFound",
			&[("number", &number), ("repo", &repo)],
		)));
	}

	// La branche telle qu'elle est sur le dépôt, pas telle qu'on l'a laissée :
	// au deuxième tour, c'est précisément ce qui a changé qu'on relit.
	let main = PathBuf::from(&config.general.main_repo);
	if main.is_dir() {
		let _ = crate::git::run_git(&main, &["fetch", "origin", &branch, &base]).await;
	}
	let worktree = if main.is_dir() {
		crate::git::worktree_for_branch(&main, &branch)
			.await
			.ok()
			.flatten()
			.map(|path| path.to_string_lossy().to_string())
	} else {
		None
	};

	let previous = load(&repo, number);
	let mut warning = None;
	let fill = |raw: &str| {
		raw.replace("{pr}", &number.to_string())
			.replace("{titre}", &title)
			.replace("{auteur}", &author)
			.replace("{branche}", &branch)
			.replace("{base}", &base)
	};
	let mut prompt = if kind == "verification" {
		fill(&template("revue-suivi", FOLLOWUP_TEMPLATE))
	} else {
		fill(&template("revue", REVIEW_TEMPLATE))
	};

	// Ce que le cockpit sait et que l'agent n'a pas à aller chercher — ni à
	// pouvoir chercher : il ne lit pas l'API GitHub.
	prompt.push_str("\n\n---\nWhat Cockpit gives you:\n");
	prompt.push_str(&format!(
		"- Comparison base: `origin/{base}` (up to date). The PR diff: `git diff origin/{base}...HEAD`.\n"
	));
	if !body.trim().is_empty() {
		prompt.push_str(&format!("- PR description:\n{}\n", clip(&body, 2500)));
	}
	let reviews: Vec<String> = conversation["reviews"]
		.as_array()
		.into_iter()
		.flatten()
		.filter_map(|review| {
			let body = review.get("body").and_then(Value::as_str).unwrap_or_default();
			let who = review.pointer("/user/login").and_then(Value::as_str).unwrap_or("?");
			let state = review.get("state").and_then(Value::as_str).unwrap_or_default();
			(!body.trim().is_empty()).then(|| format!("  · {who} ({state}): {}", clip(body, 400)))
		})
		.collect();
	if !reviews.is_empty() {
		prompt.push_str(&format!("- Reviews already published on the PR:\n{}\n", reviews.join("\n")));
	}

	if kind == "verification" {
		match previous.as_ref().and_then(|review| review.rounds.last().map(|round| (review, round))) {
			Some((review, last)) => {
				if !last.head_sha.is_empty() && last.head_sha == head_sha {
					warning = Some(crate::i18n::tf(
						"review.noNewCommit",
						&[("round", &last.number)],
					));
				}
				prompt.push_str(&format!(
					"- Last reviewed round: commit `{}`. What changed since: `git diff {}..HEAD`.\n",
					last.head_sha, last.head_sha
				));
				let open = review.open_findings();
				if open.is_empty() {
					prompt.push_str("- No point was left open.\n");
				} else {
					prompt.push_str("- The points to check (keep their identifiers in `checks`):\n");
					for finding in open {
						prompt.push_str(&format!(
							"  · {} [{}] {}:{} — {}\n",
							finding.id, finding.severity, finding.file, finding.lines, clip(&finding.problem, 300)
						));
					}
				}
			}
			None => {
				warning = Some(crate::i18n::t("review.noPreviousReview"));
			}
		}
	}

	prompt.push_str(if config.workflow.review_read_only {
		"\nYou work read-only: you modify no file, you commit nothing, you post nothing on the PR."
	} else {
		"\nYou review, you do not fix: you may run the tests to back up a point, but you do not modify the PR's \
		 code, you commit nothing and you post nothing on the PR."
	});
	prompt.push_str(&format!(
		" When you are done, call the `remettre_revue` tool once (pr = {number}, kind = \"{}\"), \
		 with your summary, your verdict and your points. Number new points after the ones already raised.",
		if kind == "verification" && previous.is_some() { "verification" } else { "revue" }
	));
	prompt.push_str("\n\n");
	prompt.push_str(&crate::i18n::reply_directive());

	Ok(Prepared {
		number,
		title,
		author,
		branch,
		base,
		url,
		head_sha,
		worktree,
		prompt,
		warning,
	})
}

// ───────────────────────────── Enregistrer un tour ─────────────────────────────

/// Range la revue remise par un agent : un tour de plus sur la PR.
///
/// Le commit relu est lu dans le worktree de l'agent au moment de la remise,
/// pas déclaré par lui : c'est ce que le tour suivant comparera.
pub async fn record(config: &Config, cwd: &str, input: &Value) -> Result<Review> {
	let repo = config.github.repo.trim().to_string();
	let number = input
		.get("pr")
		.and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim_start_matches('#').parse().ok())))
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("review.noPrNumber")))?;
	let head_sha = crate::git::run_git(Path::new(cwd), &["rev-parse", "HEAD"])
		.await
		.map(|sha| sha.trim().to_string())
		.unwrap_or_default();

	let mut review = match load(&repo, number) {
		Some(review) => review,
		None => {
			let mut fresh = Review { repo: repo.clone(), number, ..Default::default() };
			if let Ok(conversation) = crate::integrations::github_pull_conversation(config, &number.to_string()).await {
				let detail = &conversation["detail"];
				let text = |pointer: &str| detail.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string();
				fresh.title = text("/title");
				fresh.author = text("/user/login");
				fresh.branch = text("/head/ref");
				fresh.base = text("/base/ref");
				fresh.url = text("/html_url");
			}
			fresh
		}
	};

	let findings: Vec<Finding> = serde_json::from_value(input.get("findings").cloned().unwrap_or(json!([]))).unwrap_or_default();
	let checks: Vec<Check> = serde_json::from_value(input.get("checks").cloned().unwrap_or(json!([]))).unwrap_or_default();
	let string = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
	let round = Round {
		number: review.rounds.len() as u32 + 1,
		kind: if string("kind") == "verification" { "verification".into() } else { "revue".into() },
		at: chrono::Utc::now().to_rfc3339(),
		head_sha,
		summary: string("summary"),
		verdict: string("verdict"),
		findings,
		checks,
	};
	review.rounds.push(round);
	save(&review)?;
	Ok(review)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn finding(id: &str) -> Finding {
		Finding { id: id.into(), severity: "important".into(), ..Default::default() }
	}

	#[test]
	fn les_points_ouverts_suivent_les_verifications() {
		let review = Review {
			rounds: vec![
				Round { findings: vec![finding("R1"), finding("R2"), finding("R3")], ..Default::default() },
				Round {
					kind: "verification".into(),
					checks: vec![
						Check { id: "R1".into(), status: "corrige".into(), note: String::new() },
						Check { id: "R2".into(), status: "partiel".into(), note: String::new() },
					],
					findings: vec![finding("R4")],
					..Default::default()
				},
			],
			..Default::default()
		};
		let open: Vec<String> = review.open_findings().into_iter().map(|f| f.id).collect();
		assert_eq!(open, vec!["R2", "R3", "R4"]);
	}

	#[test]
	fn un_point_repris_a_un_tour_suivant_n_est_pas_double() {
		let review = Review {
			rounds: vec![
				Round { findings: vec![finding("R1")], ..Default::default() },
				Round { findings: vec![finding("R1")], ..Default::default() },
			],
			..Default::default()
		};
		assert_eq!(review.open_findings().len(), 1);
	}

	#[test]
	fn la_lecture_seule_se_retient_par_session() {
		mark_readonly("agent-test-revue");
		assert!(is_readonly("agent-test-revue"));
		assert!(!is_readonly("agent-autre"));
	}

	#[test]
	fn le_chemin_d_une_revue_ne_sort_pas_du_dossier() {
		let path = path_for("acme/../produit", 12);
		assert_eq!(path.parent().unwrap(), reviews_dir());
	}
}
