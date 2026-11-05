//! L'explorateur de méthodes : les plugins Claude Code (skills, commandes,
//! sous-agents, hooks, serveurs MCP) qu'un projet peut adopter.
//!
//! Des équipes publient leurs méthodes de travail pour agents sous forme de
//! plugins, dans des *marketplaces*. Les adopter demandait de savoir qu'elles
//! existent, de taper les bonnes commandes, et surtout de leur faire confiance
//! sans les avoir lues : un plugin peut embarquer des hooks qui tournent à
//! chaque outil, des serveurs MCP, des scripts.
//!
//! Le cockpit n'est pas un gestionnaire de paquets : le CLI sait déjà lister,
//! installer et mesurer un plugin. Ce module passe par lui pour le catalogue, et
//! fait ce qu'il ne fait pas : **montrer ce qu'un plugin exécute avant de
//! l'installer**, lu dans sa source au commit épinglé par la marketplace, avec
//! une empreinte de ce contenu — c'est sur elle que portera l'approbation,
//! comme pour les `.mcp.json` (`mcp.rs`). Une mise à jour qui change ce qui
//! s'exécute change l'empreinte.
//!
//! Rien ici n'installe quoi que ce soit.

use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Un plugin installé, tel que le CLI le rend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
	pub id: String,
	#[serde(default)]
	pub version: String,
	/// `user`, `project` ou `local`.
	#[serde(default)]
	pub scope: String,
	#[serde(default)]
	pub enabled: bool,
	#[serde(default)]
	pub install_path: String,
}

/// D'où vient un plugin disponible : un dépôt, un chemin, un commit épinglé.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Source {
	pub source: String,
	pub url: String,
	pub repo: String,
	pub path: String,
	#[serde(rename = "ref")]
	pub reference: String,
	pub sha: String,
}

/// Une source sous ses deux formes : un objet (`git-subdir`, `github`, `url`…),
/// ou un simple chemin dans le dépôt de la marketplace (`"./plugins/x"`) — le
/// plugin est alors déjà sur le poste, dans la copie de la marketplace.
fn any_source<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Source, D::Error> {
	let value = serde_json::Value::deserialize(deserializer)?;
	if let Some(path) = value.as_str() {
		return Ok(Source {
			source: "relative".into(),
			path: path.trim_start_matches("./").to_string(),
			..Default::default()
		});
	}
	serde_json::from_value(value).map_err(serde::de::Error::custom)
}

/// Une marketplace connue du poste, et où sa copie vit.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marketplace {
	name: String,
	#[serde(default)]
	install_location: String,
}

/// Un plugin qu'une marketplace propose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Available {
	pub plugin_id: String,
	pub name: String,
	#[serde(default)]
	pub description: String,
	#[serde(default)]
	pub marketplace_name: String,
	#[serde(default, deserialize_with = "any_source")]
	pub source: Source,
	#[serde(default)]
	pub install_count: u64,
}

/// Le catalogue vu depuis un projet : ses plugins et ceux qu'il peut adopter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
	pub installed: Vec<Installed>,
	pub available: Vec<Available>,
}

/// Un hook : l'événement qui le déclenche, et la commande qu'il lance.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
	pub event: String,
	pub command: String,
}

/// Un serveur MCP : son nom, et ce qu'il lance ou l'adresse qu'il appelle.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
	pub name: String,
	pub target: String,
}

/// Ce qu'un plugin contient, lu dans sa source.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
	pub name: String,
	pub description: String,
	pub version: String,
	pub skills: Vec<String>,
	pub agents: Vec<String>,
	pub commands: Vec<String>,
	/// Ce qui s'exécute sur le poste : c'est ce qu'il faut lire avant
	/// d'installer.
	pub hooks: Vec<Hook>,
	pub servers: Vec<Server>,
	/// Les fichiers du plugin que ces hooks et serveurs lancent.
	pub scripts: Vec<String>,
	/// L'empreinte de tout ce qui s'exécute ; vide quand rien ne s'exécute.
	pub fingerprint: String,
}

/// L'inspection d'un plugin : son inventaire, et ce qu'il coûte en contexte.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
	pub inventory: Inventory,
	/// Jetons ajoutés à chaque session, tels que le CLI les projette.
	pub always_on_tokens: Option<u32>,
	/// Où la source a été lue, et à quel commit.
	pub source: Source,
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
	serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Les noms des entrées d'un dossier : sous-dossiers (`skills/`) ou fichiers
/// markdown (`agents/`, `commands/`).
fn names(dir: &Path, folders: bool) -> Vec<String> {
	let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
	let mut found: Vec<String> = entries
		.flatten()
		.filter_map(|entry| {
			let path = entry.path();
			if folders {
				(path.is_dir() && path.join("SKILL.md").exists())
					.then(|| entry.file_name().to_string_lossy().to_string())
			} else {
				(path.extension().is_some_and(|ext| ext == "md"))
					.then(|| path.file_stem().unwrap_or_default().to_string_lossy().to_string())
			}
		})
		.collect();
	found.sort();
	found
}

/// Les hooks d'une déclaration — `{ "hooks": { évènement: [ { "hooks": [ { "type",
/// "command" } ] } ] } }` ou la même chose sans l'enveloppe.
fn hooks_of(value: &serde_json::Value) -> Vec<Hook> {
	let events = value.get("hooks").filter(|inner| inner.is_object()).unwrap_or(value);
	let Some(events) = events.as_object() else { return Vec::new() };
	let mut found = Vec::new();
	for (event, groups) in events {
		for group in groups.as_array().into_iter().flatten() {
			for hook in group.get("hooks").and_then(|list| list.as_array()).into_iter().flatten() {
				if let Some(command) = hook.get("command").and_then(|c| c.as_str()) {
					found.push(Hook { event: event.clone(), command: command.to_string() });
				}
			}
		}
	}
	found
}

/// Les serveurs MCP d'une déclaration — `{ "mcpServers": { nom: … } }` ou la
/// carte seule.
fn servers_of(value: &serde_json::Value) -> Vec<Server> {
	let map = value.get("mcpServers").filter(|inner| inner.is_object()).unwrap_or(value);
	let Some(map) = map.as_object() else { return Vec::new() };
	map.iter()
		.filter(|(_, server)| server.is_object())
		.map(|(name, server)| {
			let target = if let Some(url) = server.get("url").and_then(|u| u.as_str()) {
				url.to_string()
			} else {
				let command = server.get("command").and_then(|c| c.as_str()).unwrap_or_default();
				let args: Vec<&str> = server
					.get("args")
					.and_then(|a| a.as_array())
					.map(|args| args.iter().filter_map(|arg| arg.as_str()).collect())
					.unwrap_or_default();
				std::iter::once(command).chain(args).collect::<Vec<_>>().join(" ")
			};
			Server { name: name.clone(), target }
		})
		.collect()
}

/// Les fichiers du plugin qu'une commande lance : ce qui suit
/// `${CLAUDE_PLUGIN_ROOT}/`, jusqu'à la fin du mot.
fn scripts_in(command: &str) -> Vec<String> {
	const ROOT: &str = "${CLAUDE_PLUGIN_ROOT}/";
	command
		.match_indices(ROOT)
		.map(|(at, _)| {
			command[at + ROOT.len()..]
				.chars()
				.take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
				.collect::<String>()
		})
		.filter(|path| !path.is_empty())
		.collect()
}

/// Lit un plugin dans son dossier, sans rien exécuter.
pub fn read_plugin(root: &Path) -> Inventory {
	let manifest = read_json(&root.join(".claude-plugin").join("plugin.json")).unwrap_or_default();
	let text = |key: &str| manifest.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();

	let mut hooks = hooks_of(&read_json(&root.join("hooks").join("hooks.json")).unwrap_or_default());
	if manifest.get("hooks").is_some_and(|h| h.is_object()) {
		hooks.extend(hooks_of(&manifest));
	}
	let mut servers = servers_of(&read_json(&root.join(".mcp.json")).unwrap_or_default());
	if let Some(inline) = manifest.get("mcpServers").filter(|m| m.is_object()) {
		servers.extend(servers_of(inline));
	}

	let mut scripts: Vec<String> = hooks
		.iter()
		.map(|hook| hook.command.as_str())
		.chain(servers.iter().map(|server| server.target.as_str()))
		.flat_map(scripts_in)
		.filter(|path| root.join(path).is_file())
		.collect();
	scripts.sort();
	scripts.dedup();

	let fingerprint = if hooks.is_empty() && servers.is_empty() {
		String::new()
	} else {
		fingerprint(root, &hooks, &servers, &scripts)
	};

	Inventory {
		name: text("name"),
		description: text("description"),
		version: text("version"),
		skills: names(&root.join("skills"), true),
		agents: names(&root.join("agents"), false),
		commands: names(&root.join("commands"), false),
		hooks,
		servers,
		scripts,
		fingerprint,
	}
}

/// L'empreinte de ce qui s'exécute : les commandes des hooks, les cibles des
/// serveurs, et le contenu des scripts qu'ils lancent. Un script modifié par
/// une mise à jour change l'empreinte, même si la déclaration ne bouge pas.
fn fingerprint(root: &Path, hooks: &[Hook], servers: &[Server], scripts: &[String]) -> String {
	use sha2::{Digest, Sha256};
	let mut lines: Vec<String> = hooks.iter().map(|hook| format!("hook {} {}", hook.event, hook.command)).collect();
	lines.extend(servers.iter().map(|server| format!("mcp {} {}", server.name, server.target)));
	lines.sort();
	let mut hasher = Sha256::new();
	for line in &lines {
		hasher.update(line.as_bytes());
		hasher.update(b"\n");
	}
	for script in scripts {
		hasher.update(script.as_bytes());
		// Fins de ligne ramenées à `\n` : la même source extraite sous Windows
		// et sous macOS doit donner la même empreinte.
		let content = std::fs::read(root.join(script)).unwrap_or_default();
		let content: Vec<u8> = content.into_iter().filter(|byte| *byte != b'\r').collect();
		hasher.update(&content);
	}
	hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Le coût permanent en contexte, lu dans la sortie de `claude plugin details`
/// (`Always-on:   ~105 tok`).
pub fn parse_always_on(details: &str) -> Option<u32> {
	let line = details.lines().find(|line| line.trim_start().starts_with("Always-on:"))?;
	let digits: String = line
		.split(':')
		.nth(1)?
		.chars()
		.skip_while(|c| !c.is_ascii_digit())
		.take_while(|c| c.is_ascii_digit() || *c == ',')
		.filter(|c| c.is_ascii_digit())
		.collect();
	digits.parse().ok()
}

/// Lance le CLI `claude` avec ces arguments, dans ce dossier.
async fn claude(cwd: &Path, args: &[&str]) -> Result<String> {
	let binary = crate::agent::claude_binary().ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.claudeNotFound")))?;
	let output = crate::platform::quiet_async(&mut tokio::process::Command::new(&binary))
		.args(args)
		.current_dir(cwd)
		.output()
		.await
		.map_err(|e| CockpitError::msg(e.to_string()))?;
	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
		let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
		return Err(CockpitError::msg(if stderr.is_empty() { stdout } else { stderr }));
	}
	Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Le catalogue vu depuis le projet : ses plugins (portées utilisateur, projet,
/// locale) et ceux des marketplaces déclarées, sur le poste comme par le dépôt.
pub async fn catalog(project: &Path) -> Result<Catalog> {
	let raw = claude(project, &["plugin", "list", "--json", "--available"]).await?;
	serde_json::from_str(&raw).map_err(|e| CockpitError::msg(e.to_string()))
}

/// Où l'on garde la source d'un plugin, par commit : relue telle quelle tant
/// que la marketplace ne change pas d'épingle.
fn source_dir(plugin_id: &str, sha: &str) -> PathBuf {
	let safe: String = plugin_id.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).collect();
	crate::config::config_dir().join("methodes").join(safe).join(if sha.is_empty() { "tete" } else { sha })
}

/// Récupère la source d'un plugin à son commit épinglé, sans rien installer :
/// un clone sans contenu, restreint au dossier du plugin, puis le commit.
async fn fetch(plugin_id: &str, source: &Source) -> Result<PathBuf> {
	let url = if !source.url.is_empty() {
		source.url.clone()
	} else if !source.repo.is_empty() {
		format!("https://github.com/{}.git", source.repo)
	} else {
		return Err(CockpitError::msg(crate::i18n::tf("methods.unsupportedSource", &[("kind", &source.source)])));
	};
	let dir = source_dir(plugin_id, &source.sha);
	let root = if source.path.is_empty() { dir.clone() } else { dir.join(&source.path) };
	if root.join(".claude-plugin").exists() || root.join("skills").exists() {
		return Ok(root);
	}
	let _ = std::fs::remove_dir_all(&dir);
	if let Some(parent) = dir.parent() {
		std::fs::create_dir_all(parent)?;
	}
	let parent = dir.parent().unwrap_or(&dir).to_path_buf();
	let target = dir.to_string_lossy().to_string();
	crate::git::run_git(&parent, &["clone", "--quiet", "--filter=blob:none", "--no-checkout", &url, &target]).await?;
	if !source.path.is_empty() {
		crate::git::run_git(&dir, &["sparse-checkout", "set", "--no-cone", &source.path]).await?;
	}
	let at = if !source.sha.is_empty() {
		source.sha.as_str()
	} else if !source.reference.is_empty() {
		source.reference.as_str()
	} else {
		"HEAD"
	};
	crate::git::run_git(&dir, &["checkout", "--quiet", at]).await?;
	Ok(root)
}

/// Inspecte un plugin : installé, dans son dossier d'installation ; sinon, dans
/// sa source récupérée au commit épinglé.
pub async fn inspect(project: &Path, plugin_id: &str) -> Result<Inspection> {
	let catalog = catalog(project).await?;
	let (root, source) = if let Some(installed) = catalog.installed.iter().find(|p| p.id == plugin_id) {
		(PathBuf::from(&installed.install_path), Source::default())
	} else {
		let available = catalog
			.available
			.iter()
			.find(|p| p.plugin_id == plugin_id)
			.ok_or_else(|| CockpitError::msg(crate::i18n::tf("methods.unknownPlugin", &[("id", &plugin_id)])))?;
		let root = if available.source.source == "relative" {
			// Déjà sur le poste : dans la copie de sa marketplace.
			let raw = claude(project, &["plugin", "marketplace", "list", "--json"]).await?;
			let markets: Vec<Marketplace> = serde_json::from_str(&raw).map_err(|e| CockpitError::msg(e.to_string()))?;
			let market = markets
				.iter()
				.find(|m| m.name == available.marketplace_name && !m.install_location.is_empty())
				.ok_or_else(|| CockpitError::msg(crate::i18n::tf("methods.unsupportedSource", &[("kind", &"relative")])))?;
			PathBuf::from(&market.install_location).join(&available.source.path)
		} else {
			fetch(plugin_id, &available.source).await?
		};
		(root, available.source.clone())
	};
	let inventory = read_plugin(&root);
	let name = if inventory.name.is_empty() { plugin_id.split('@').next().unwrap_or(plugin_id).to_string() } else { inventory.name.clone() };
	let root_arg = root.to_string_lossy().to_string();
	let always_on_tokens = claude(project, &["--plugin-dir", &root_arg, "plugin", "details", &name])
		.await
		.ok()
		.and_then(|details| parse_always_on(&details));
	Ok(Inspection { inventory, always_on_tokens, source })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn plugin(nom: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!("cockpit-methodes-{}-{nom}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(dir.join(".claude-plugin")).unwrap();
		dir
	}

	fn write(dir: &Path, path: &str, content: &str) {
		let file = dir.join(path);
		std::fs::create_dir_all(file.parent().unwrap()).unwrap();
		std::fs::write(file, content).unwrap();
	}

	/// Un plugin de skills seuls : rien ne s'exécute, pas d'empreinte.
	#[test]
	fn un_plugin_de_skills_n_execute_rien() {
		let dir = plugin("skills");
		write(&dir, ".claude-plugin/plugin.json", r#"{"name":"commit-tools","version":"1.0.1","description":"Git"}"#);
		write(&dir, "skills/commit/SKILL.md", "---\nname: commit\n---\n");
		write(&dir, "skills/brouillon/notes.txt", "pas un skill");
		write(&dir, "commands/push.md", "push");
		let inventory = read_plugin(&dir);
		assert_eq!(inventory.name, "commit-tools");
		assert_eq!(inventory.skills, vec!["commit"]);
		assert_eq!(inventory.commands, vec!["push"]);
		assert!(inventory.hooks.is_empty() && inventory.servers.is_empty());
		assert!(inventory.fingerprint.is_empty());
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Hooks et serveurs, déclarés dans leurs fichiers comme dans le manifeste,
	/// avec les scripts qu'ils lancent ; l'empreinte suit le contenu des scripts.
	#[test]
	fn ce_qui_s_execute_est_lu_et_empreint() {
		let dir = plugin("hooks");
		write(
			&dir,
			".claude-plugin/plugin.json",
			r#"{"name":"garde","mcpServers":{"docs":{"url":"https://mcp.example.com/mcp"}}}"#,
		);
		write(
			&dir,
			"hooks/hooks.json",
			r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"python3 \"${CLAUDE_PLUGIN_ROOT}/hooks/pre.py\"","timeout":10}]}]}}"#,
		);
		write(&dir, ".mcp.json", r#"{"mcpServers":{"local":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js","--port","0"]}}}"#);
		write(&dir, "hooks/pre.py", "print('ok')\n");
		write(&dir, "server.js", "console.log(1)\n");

		let inventory = read_plugin(&dir);
		assert_eq!(inventory.hooks, vec![Hook { event: "PreToolUse".into(), command: "python3 \"${CLAUDE_PLUGIN_ROOT}/hooks/pre.py\"".into() }]);
		let mut servers: Vec<_> = inventory.servers.iter().map(|s| (s.name.as_str(), s.target.as_str())).collect();
		servers.sort();
		assert_eq!(servers, vec![("docs", "https://mcp.example.com/mcp"), ("local", "node ${CLAUDE_PLUGIN_ROOT}/server.js --port 0")]);
		assert_eq!(inventory.scripts, vec!["hooks/pre.py", "server.js"]);
		assert_eq!(inventory.fingerprint.len(), 64);

		// Même déclaration, script modifié : l'empreinte change.
		let before = inventory.fingerprint.clone();
		write(&dir, "hooks/pre.py", "import os; os.system('curl …')\n");
		assert_ne!(read_plugin(&dir).fingerprint, before);
		// Fins de ligne seules : elle ne change pas.
		write(&dir, "hooks/pre.py", "import os; os.system('curl …')\r\n");
		let crlf = read_plugin(&dir).fingerprint;
		write(&dir, "hooks/pre.py", "import os; os.system('curl …')\n");
		assert_eq!(read_plugin(&dir).fingerprint, crlf);
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn le_cout_permanent_se_lit_dans_details() {
		let details = "commit-commands 1.0.1\n\nProjected token cost\n  Always-on:   ~105 tok   added to every session\n";
		assert_eq!(parse_always_on(details), Some(105));
		assert_eq!(parse_always_on("  Always-on:   ~1,240 tok"), Some(1240));
		assert_eq!(parse_always_on("rien"), None);
	}

	/// Bout en bout, avec le vrai CLI et le réseau : un plugin disponible mais
	/// pas installé est récupéré à son commit et lu. Ignoré par défaut.
	#[tokio::test]
	#[ignore]
	async fn un_plugin_disponible_se_lit_sans_l_installer() {
		let project = std::env::temp_dir();
		let catalog = catalog(&project).await.unwrap();
		let installed: Vec<&str> = catalog.installed.iter().map(|p| p.id.as_str()).collect();
		let candidate = catalog
			.available
			.iter()
			.filter(|p| !installed.contains(&p.plugin_id.as_str()) && p.source.source == "git-subdir")
			.min_by_key(|p| p.install_count)
			.expect("au moins un plugin disponible");
		let inspection = inspect(&project, &candidate.plugin_id).await.unwrap();
		eprintln!(
			"{} : {} skill(s), {} hook(s), {} serveur(s), {:?} jetons",
			candidate.plugin_id,
			inspection.inventory.skills.len(),
			inspection.inventory.hooks.len(),
			inspection.inventory.servers.len(),
			inspection.always_on_tokens
		);
		assert!(!inspection.source.sha.is_empty());
	}

	#[test]
	fn le_catalogue_du_cli_se_lit() {
		let raw = r#"{"installed":[{"id":"hookify@claude-plugins-official","version":"0.1.1","scope":"user","enabled":true,"installPath":"C:\\p","installedAt":"x","projectEnabled":false}],
		"available":[{"pluginId":"a@m","name":"a","description":"d","marketplaceName":"m","source":{"source":"git-subdir","url":"https://g/a.git","path":"plugins/a","ref":"v1","sha":"abc"},"installCount":12},
		{"pluginId":"b@m","name":"b","marketplaceName":"m","source":"./plugins/b"}]}"#;
		let catalog: Catalog = serde_json::from_str(raw).unwrap();
		assert_eq!(catalog.installed[0].scope, "user");
		assert_eq!(catalog.available[0].source.sha, "abc");
		assert_eq!(catalog.available[0].source.path, "plugins/a");
		assert_eq!(catalog.available[0].install_count, 12);
		// Un simple chemin : le plugin vit dans la copie de la marketplace.
		assert_eq!(catalog.available[1].source.source, "relative");
		assert_eq!(catalog.available[1].source.path, "plugins/b");
	}
}
