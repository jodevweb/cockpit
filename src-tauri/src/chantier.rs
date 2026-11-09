//! Ce que la carte du chantier a besoin de savoir, et que le fil ne dit pas.
//!
//! Trois questions, posées pour tous les agents d'un même worktree à la fois :
//!
//! - **De quoi est rempli le contexte d'un agent.** Le total de jetons, on
//!   l'avait ; la répartition, non. Le CLI la calcule lui-même — c'est ce qu'il
//!   affiche pour `/context` — et la rend à une requête de contrôle,
//!   `get_context_usage`, sans appel au modèle et sans toucher à la
//!   conversation. Vérifié sur Claude Code 2.1.285 : la réponse arrive en
//!   quelques millisecondes, y compris en plein tour.
//! - **Ce qui a changé sur le disque depuis qu'un agent l'a lu.** Seul le
//!   système de fichiers le sait vraiment : un autre agent, un terminal, un
//!   `git pull` ou une main humaine laissent tous la même trace, une date de
//!   modification.
//! - **Le territoire** : les fichiers du dépôt et leur poids, pour dessiner
//!   où chacun travaille.

use crate::error::Result;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::UNIX_EPOCH;

// ───────────────────────────── Contexte ─────────────────────────────

/// Allège la réponse de `get_context_usage` avant qu'elle parte à l'écran.
///
/// Le CLI y joint la liste de chaque outil MCP (plus de trois cents sur un
/// poste ordinaire), la grille qu'il dessine dans un terminal et les couleurs
/// de son thème. Émis toutes les quelques secondes pour chaque agent, ce serait
/// des centaines de kilo-octets pour rien : on garde ce que la carte montre, et
/// les outils MCP se résument par serveur.
///
/// Tout autre message passe tel quel.
pub fn slim(payload: Value) -> Value {
	let Some(usage) = payload.pointer("/response/response") else {
		return payload;
	};
	if payload.get("type").and_then(Value::as_str) != Some("control_response")
		|| !usage.get("categories").is_some_and(Value::is_array)
	{
		return payload;
	}

	let categories: Vec<Value> = usage["categories"]
		.as_array()
		.into_iter()
		.flatten()
		.map(|category| {
			json!({
				"name": category.get("name").cloned().unwrap_or(Value::Null),
				"tokens": category.get("tokens").cloned().unwrap_or(json!(0)),
				"kind": category.get("kind").cloned().unwrap_or(json!("used")),
			})
		})
		.collect();

	// Un serveur, ses outils chargés et ceux laissés en attente : c'est ce qui
	// dit si un MCP coûte vraiment de la place ou attend qu'on le cherche.
	let mut servers: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
	for tool in usage.get("mcpTools").and_then(Value::as_array).into_iter().flatten() {
		let name = tool
			.get("serverName")
			.and_then(Value::as_str)
			.unwrap_or("?")
			.to_string();
		let tokens = tool.get("tokens").and_then(Value::as_u64).unwrap_or(0);
		let loaded = tool.get("isLoaded").and_then(Value::as_bool).unwrap_or(false);
		let entry = servers.entry(name).or_default();
		if loaded {
			entry.0 += tokens;
			entry.1 += 1;
		} else {
			entry.2 += 1;
		}
	}
	let servers: Vec<Value> = servers
		.into_iter()
		.map(|(name, (tokens, loaded, deferred))| {
			json!({ "name": name, "tokens": tokens, "loaded": loaded, "deferred": deferred })
		})
		.collect();

	let messages = usage.get("messageBreakdown").map(|breakdown| {
		let mut kept = Map::new();
		for key in [
			"toolCallTokens",
			"toolResultTokens",
			"assistantMessageTokens",
			"userMessageTokens",
			"toolCallsByType",
		] {
			if let Some(value) = breakdown.get(key) {
				kept.insert(key.to_string(), value.clone());
			}
		}
		Value::Object(kept)
	});

	let mut slim = Map::new();
	slim.insert("cockpit".into(), json!("context"));
	for key in [
		"totalTokens",
		"maxTokens",
		"percentage",
		"model",
		"autoCompactThreshold",
		"isAutoCompactEnabled",
		"memoryFiles",
	] {
		if let Some(value) = usage.get(key) {
			slim.insert(key.into(), value.clone());
		}
	}
	slim.insert("categories".into(), Value::Array(categories));
	slim.insert("mcpServers".into(), Value::Array(servers));
	if let Some(skills) = usage.get("skills") {
		slim.insert(
			"skills".into(),
			json!({
				"total": skills.get("totalSkills").cloned().unwrap_or(json!(0)),
				"tokens": skills.get("tokens").cloned().unwrap_or(json!(0)),
			}),
		);
	}
	if let Some(messages) = messages {
		slim.insert("messages".into(), messages);
	}

	json!({
		"type": "control_response",
		"response": {
			"subtype": payload.pointer("/response/subtype").cloned().unwrap_or(json!("success")),
			"request_id": payload.pointer("/response/request_id").cloned().unwrap_or(Value::Null),
			"response": Value::Object(slim),
		},
	})
}

// ───────────────────────────── Fraîcheur ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
	pub path: String,
	/// Dernière modification, en millisecondes depuis l'époque ; `None` quand
	/// le fichier n'existe plus — ce qui est aussi une nouvelle.
	pub modified_ms: Option<i64>,
}

/// La date de modification de chaque fichier demandé.
///
/// Borné : la carte ne demande que ce que ses agents ont lu, mais une longue
/// session en lit des centaines, et l'appel revient toutes les quelques
/// secondes.
pub fn stamps(paths: Vec<String>) -> Vec<FileStamp> {
	paths
		.into_iter()
		.take(2000)
		.map(|path| {
			let modified_ms = std::fs::metadata(&path)
				.and_then(|meta| meta.modified())
				.ok()
				.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
				.map(|elapsed| elapsed.as_millis() as i64);
			FileStamp { path, modified_ms }
		})
		.collect()
}

// ───────────────────────────── Territoire ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerritoryFile {
	/// Relatif à la racine du worktree.
	pub path: String,
	pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Territory {
	pub root: String,
	pub files: Vec<TerritoryFile>,
	/// Vrai quand le dépôt dépasse ce qu'on accepte de dessiner.
	pub truncated: bool,
}

/// Au-delà, une carte n'apprend plus rien : les cases seraient des pixels.
const MAX_FILES: usize = 40_000;

/// Les fichiers du dépôt, suivis ou nouveaux, sans ce que `.gitignore` écarte.
///
/// `git ls-files` plutôt qu'un parcours du disque : un `node_modules` ou un
/// `target` pèsent des gigaoctets et ne disent rien de là où l'on travaille.
pub async fn territory(cwd: &str) -> Result<Territory> {
	let root = Path::new(cwd);
	let raw = crate::git::run_git(root, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).await?;
	let mut seen = std::collections::HashSet::new();
	let mut files = Vec::new();
	let mut truncated = false;
	for path in raw.split('\0').filter(|entry| !entry.is_empty()) {
		// Un fichier en conflit apparaît une fois par étape de fusion.
		if !seen.insert(path) {
			continue;
		}
		if files.len() >= MAX_FILES {
			truncated = true;
			break;
		}
		// Supprimé dans l'arbre mais encore suivi : il n'a plus de place à
		// occuper sur la carte.
		let Ok(meta) = std::fs::metadata(root.join(path)) else {
			continue;
		};
		if !meta.is_file() {
			continue;
		}
		files.push(TerritoryFile {
			path: path.to_string(),
			bytes: meta.len(),
		});
	}
	Ok(Territory {
		root: cwd.to_string(),
		files,
		truncated,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn slim_garde_la_repartition_et_resume_les_mcp() {
		let payload = json!({
			"type": "control_response",
			"response": {
				"subtype": "success",
				"request_id": "context-usage-1",
				"response": {
					"categories": [
						{ "name": "System prompt", "tokens": 2250, "color": "promptBorder", "kind": "used" },
						{ "name": "Free space", "tokens": 950645, "color": "promptBorder", "kind": "free" }
					],
					"totalTokens": 16355,
					"maxTokens": 1000000,
					"percentage": 2,
					"gridRows": [[{ "color": "x" }]],
					"memoryFiles": [{ "path": "/p/CLAUDE.md", "type": "Project", "tokens": 1122 }],
					"mcpTools": [
						{ "name": "a", "serverName": "linear", "tokens": 400, "isLoaded": true },
						{ "name": "b", "serverName": "linear", "tokens": 900, "isLoaded": false },
						{ "name": "c", "serverName": "sentry", "tokens": 300, "isLoaded": false }
					],
					"skills": { "totalSkills": 39, "includedSkills": 39, "tokens": 6636, "skillFrontmatter": [] },
					"messageBreakdown": {
						"toolCallTokens": 130,
						"toolResultTokens": 1119,
						"attachmentTokens": 47416,
						"toolCallsByType": [{ "name": "Read", "callTokens": 88, "resultTokens": 1073 }]
					}
				}
			}
		});
		let out = slim(payload);
		let usage = &out["response"]["response"];
		assert_eq!(usage["cockpit"], "context");
		assert_eq!(usage["totalTokens"], 16355);
		assert!(usage.get("gridRows").is_none());
		assert!(usage["categories"][0].get("color").is_none());
		assert_eq!(
			usage["mcpServers"][0],
			json!({ "name": "linear", "tokens": 400, "loaded": 1, "deferred": 1 })
		);
		assert_eq!(usage["mcpServers"][1]["deferred"], 1);
		assert_eq!(usage["skills"], json!({ "total": 39, "tokens": 6636 }));
		assert!(usage["messages"].get("attachmentTokens").is_none());
		assert_eq!(usage["messages"]["toolCallsByType"][0]["name"], "Read");
		assert_eq!(out["response"]["request_id"], "context-usage-1");
	}

	#[test]
	fn slim_laisse_passer_le_reste() {
		let mcp = json!({
			"type": "control_response",
			"response": { "response": { "mcpServers": [{ "name": "linear", "status": "connected" }] } }
		});
		assert_eq!(slim(mcp.clone()), mcp);
		let message = json!({ "type": "assistant", "message": { "content": [] } });
		assert_eq!(slim(message.clone()), message);
	}

	#[test]
	fn stamps_dit_quand_un_fichier_a_disparu() {
		let dir = std::env::temp_dir().join(format!("chantier-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let present = dir.join("a.txt");
		std::fs::write(&present, "x").unwrap();
		let out = stamps(vec![
			present.to_string_lossy().to_string(),
			dir.join("absent.txt").to_string_lossy().to_string(),
		]);
		assert!(out[0].modified_ms.is_some());
		assert!(out[1].modified_ms.is_none());
		std::fs::remove_dir_all(&dir).unwrap();
	}
}
