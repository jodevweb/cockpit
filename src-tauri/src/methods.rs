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
	#[serde(default)]
	pub installed_at: String,
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
	/// L'empreinte que tu as approuvée en l'installant d'ici, s'il y en a une.
	/// Différente de l'empreinte actuelle : ce qui s'exécute a changé depuis.
	pub approved: Option<String>,
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
				let target = hook
					.get("command")
					.and_then(|c| c.as_str())
					.map(str::to_string)
					.or_else(|| hook.get("url").and_then(|u| u.as_str()).map(|url| format!("HTTP {url}")));
				if let Some(command) = target {
					found.push(Hook { event: event.clone(), command });
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

/// Un chemin relatif qui reste dans son dossier : ni absolu, ni préfixe de
/// lecteur, ni `..`. Les chemins qu'une marketplace ou un manifeste donnent ne
/// sont pas de confiance : `../..` pointerait ailleurs, et l'on lirait un autre
/// plugin que celui qui s'installe.
pub fn safe_relative(path: &str) -> bool {
	// Les formes absolues de tous les systèmes, pas seulement celles du poste :
	// `C:/…` n'est un chemin relatif que pour macOS et Linux, et un manifeste
	// écrit ailleurs doit être refusé partout pareil.
	if path.contains(':') || path.starts_with('/') || path.starts_with('\\') {
		return false;
	}
	let path = Path::new(path.trim_start_matches("./"));
	!path.as_os_str().is_empty()
		&& path.components().all(|component| matches!(component, std::path::Component::Normal(_) | std::path::Component::CurDir))
}

/// Les déclarations d'un manifeste sous ses trois formes : l'objet lui-même,
/// un chemin vers un fichier JSON, ou une liste de chemins.
fn declared(root: &Path, value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
	let read = |path: &str| safe_relative(path).then(|| read_json(&root.join(path.trim_start_matches("./")))).flatten();
	match value {
		Some(object) if object.is_object() => vec![object.clone()],
		Some(serde_json::Value::String(path)) => read(path).into_iter().collect(),
		Some(serde_json::Value::Array(paths)) => paths.iter().filter_map(|p| p.as_str()).filter_map(read).collect(),
		_ => Vec::new(),
	}
}

/// Lit un plugin dans son dossier, sans rien exécuter.
pub fn read_plugin(root: &Path) -> Inventory {
	let manifest = read_json(&root.join(".claude-plugin").join("plugin.json")).unwrap_or_default();
	let text = |key: &str| manifest.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();

	let mut hooks = hooks_of(&read_json(&root.join("hooks").join("hooks.json")).unwrap_or_default());
	for declaration in declared(root, manifest.get("hooks")) {
		hooks.extend(hooks_of(&declaration));
	}
	let mut servers = servers_of(&read_json(&root.join(".mcp.json")).unwrap_or_default());
	for declaration in declared(root, manifest.get("mcpServers")) {
		servers.extend(servers_of(&declaration));
	}
	// Les serveurs de langage se lancent eux aussi sur le poste.
	let mut lsp = servers_of(&read_json(&root.join(".lsp.json")).unwrap_or_default());
	for declaration in declared(root, manifest.get("lspServers")) {
		lsp.extend(servers_of(&declaration));
	}
	servers.extend(lsp.into_iter().map(|server| Server { name: format!("LSP · {}", server.name), ..server }));

	let mut scripts: Vec<String> = hooks
		.iter()
		.map(|hook| hook.command.as_str())
		.chain(servers.iter().map(|server| server.target.as_str()))
		.flat_map(scripts_in)
		.filter(|path| safe_relative(path) && root.join(path).is_file())
		.collect();
	// `bin/` : des exécutables que le plugin met à disposition.
	if let Ok(entries) = std::fs::read_dir(root.join("bin")) {
		scripts.extend(
			entries.flatten().filter(|entry| entry.path().is_file()).map(|entry| format!("bin/{}", entry.file_name().to_string_lossy())),
		);
	}
	scripts.sort();
	scripts.dedup();

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
		fingerprint: fingerprint(root),
	}
}

/// Ce que le cache de Claude Code écrit dans le dossier d'un plugin installé
/// pour son propre suivi : ni la source, ni ce qui s'exécute.
const BOOKKEEPING: [&str; 3] = [".git", ".in_use", ".orphaned_at"];

/// L'empreinte du plugin entier : chaque fichier, son chemin et son contenu.
///
/// Pas seulement ce que déclarent les hooks et les serveurs : un script en
/// appelle un autre, un module s'importe, un hook peut se déclarer d'une façon
/// qu'on ne lit pas encore. Toute modification d'un fichier du plugin change
/// donc l'empreinte — c'est la seule façon d'être sûr qu'un accord porte sur
/// ce qui s'exécutera. Les fins de ligne sont ramenées à `\n` : la même source
/// extraite sous Windows et sous macOS donne la même empreinte.
fn fingerprint(root: &Path) -> String {
	use sha2::{Digest, Sha256};
	fn walk(root: &Path, dir: &Path, files: &mut Vec<String>) {
		let Ok(entries) = std::fs::read_dir(dir) else { return };
		for entry in entries.flatten() {
			let name = entry.file_name().to_string_lossy().to_string();
			if dir == root && BOOKKEEPING.contains(&name.as_str()) {
				continue;
			}
			let path = entry.path();
			// Pas de lien suivi : il mènerait hors du plugin.
			let Ok(kind) = entry.file_type() else { continue };
			if kind.is_dir() {
				walk(root, &path, files);
			} else if kind.is_file() {
				if let Ok(relative) = path.strip_prefix(root) {
					files.push(relative.to_string_lossy().replace('\\', "/"));
				}
			}
		}
	}
	let mut files = Vec::new();
	walk(root, root, &mut files);
	files.sort();
	let mut hasher = Sha256::new();
	for file in &files {
		let content: Vec<u8> = std::fs::read(root.join(file)).unwrap_or_default().into_iter().filter(|byte| *byte != b'\r').collect();
		// Longueurs en tête : « a » + « bc » et « ab » + « c » ne se confondent pas.
		hasher.update((file.len() as u64).to_le_bytes());
		hasher.update(file.as_bytes());
		hasher.update((content.len() as u64).to_le_bytes());
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
	let (ok, stdout, stderr) = claude_raw(cwd, args).await?;
	if !ok {
		return Err(CockpitError::msg(if stderr.trim().is_empty() { stdout.trim().to_string() } else { stderr.trim().to_string() }));
	}
	Ok(stdout)
}

/// Le même, sans juger le code de sortie : `install --json` rend sa réponse
/// sur la sortie standard même quand il refuse.
async fn claude_raw(cwd: &Path, args: &[&str]) -> Result<(bool, String, String)> {
	let binary = crate::agent::claude_binary().ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.claudeNotFound")))?;
	let output = crate::platform::quiet_async(&mut tokio::process::Command::new(&binary))
		.args(args)
		.current_dir(cwd)
		.output()
		.await
		.map_err(|e| CockpitError::msg(e.to_string()))?;
	Ok((
		output.status.success(),
		String::from_utf8_lossy(&output.stdout).to_string(),
		String::from_utf8_lossy(&output.stderr).to_string(),
	))
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
	if !source.path.is_empty() && !safe_relative(&source.path) {
		return Err(CockpitError::msg(crate::i18n::tf("methods.unsafePath", &[("path", &source.path)])));
	}
	// Un commit épinglé est une empreinte hexadécimale, rien d'autre : c'est elle
	// qui part en argument à git.
	let pinned = source.sha.len() >= 7 && source.sha.chars().all(|c| c.is_ascii_hexdigit());
	if !source.sha.is_empty() && !pinned {
		return Err(CockpitError::msg(crate::i18n::tf("methods.unsafePath", &[("path", &source.sha)])));
	}
	let dir = source_dir(plugin_id, &source.sha);
	let root = if source.path.is_empty() { dir.clone() } else { dir.join(source.path.trim_start_matches("./")) };
	// Le cache ne vaut que pour un commit épinglé : une source sans épingle peut
	// avoir bougé, et l'on relirait une copie périmée.
	if pinned && (root.join(".claude-plugin").exists() || root.join("skills").exists()) {
		return Ok(root);
	}
	let _ = std::fs::remove_dir_all(&dir);
	if let Some(parent) = dir.parent() {
		std::fs::create_dir_all(parent)?;
	}
	let parent = dir.parent().unwrap_or(&dir).to_path_buf();
	let target = dir.to_string_lossy().to_string();
	// `--` : l'adresse vient de la marketplace, elle ne doit jamais se lire
	// comme une option de git (`--upload-pack=…`).
	crate::git::run_git(&parent, &["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--", &url, &target]).await?;
	if !source.path.is_empty() {
		crate::git::run_git(&dir, &["sparse-checkout", "set", "--no-cone", "--", &source.path]).await?;
	}
	let at = if !source.sha.is_empty() {
		source.sha.as_str()
	} else if !source.reference.is_empty() {
		source.reference.as_str()
	} else {
		"HEAD"
	};
	if at.starts_with('-') {
		return Err(CockpitError::msg(crate::i18n::tf("methods.unsafePath", &[("path", &at)])));
	}
	crate::git::run_git(&dir, &["checkout", "--quiet", at]).await?;
	inside(&root, &dir)
}

/// Le dossier lu reste-t-il dans celui où il doit se trouver ? Vérifié sur les
/// chemins résolus : un lien ou un `..` n'en sortent pas.
fn inside(root: &Path, base: &Path) -> Result<PathBuf> {
	let resolved = std::fs::canonicalize(root)?;
	let base = std::fs::canonicalize(base)?;
	if !resolved.starts_with(&base) {
		return Err(CockpitError::msg(crate::i18n::tf("methods.unsafePath", &[("path", &root.display())])));
	}
	Ok(root.to_path_buf())
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
			if !safe_relative(&available.source.path) {
				return Err(CockpitError::msg(crate::i18n::tf("methods.unsafePath", &[("path", &available.source.path)])));
			}
			let location = PathBuf::from(&market.install_location);
			inside(&location.join(available.source.path.trim_start_matches("./")), &location)?
		} else {
			fetch(plugin_id, &available.source).await?
		};
		(root, available.source.clone())
	};
	let inventory = read_plugin(&root);
	let name = if inventory.name.is_empty() { plugin_id.split('@').next().unwrap_or(plugin_id).to_string() } else { inventory.name.clone() };
	let root_arg = root.to_string_lossy().to_string();
	// Le nom vient du manifeste du plugin : on ne le passe au CLI que s'il a la
	// forme d'un nom.
	let plain = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
	let always_on_tokens = if plain {
		claude(project, &["--plugin-dir", &root_arg, "plugin", "details", &name])
			.await
			.ok()
			.and_then(|details| parse_always_on(&details))
	} else {
		None
	};
	let approved = approval(project, plugin_id).map(|entry| entry.fingerprint);
	Ok(Inspection { inventory, always_on_tokens, source, approved })
}

// ── Installer ────────────────────────────────────────────────────────────────

/// Ce qu'on a approuvé en installant un plugin d'ici : son empreinte, sa
/// portée, la date. C'est la date qui sert de point de bascule à la mesure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
	pub fingerprint: String,
	pub scope: String,
	pub at: String,
}

fn approvals_path() -> PathBuf {
	crate::config::config_dir().join("methodes").join("approbations.json")
}

/// projet → plugin → approbation.
type Approvals = std::collections::BTreeMap<String, std::collections::BTreeMap<String, Approval>>;

fn load_approvals() -> Approvals {
	std::fs::read_to_string(approvals_path())
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

fn project_key(project: &Path) -> String {
	crate::platform::path_key(&project.to_string_lossy())
}

/// L'approbation d'un plugin pour ce projet, s'il a été installé d'ici.
pub fn approval(project: &Path, plugin_id: &str) -> Option<Approval> {
	load_approvals().get(&project_key(project))?.get(plugin_id).cloned()
}

fn set_approval(project: &Path, plugin_id: &str, approval: Option<Approval>) -> Result<()> {
	let mut all = load_approvals();
	let entries = all.entry(project_key(project)).or_default();
	match approval {
		Some(approval) => {
			entries.insert(plugin_id.to_string(), approval);
		}
		None => {
			entries.remove(plugin_id);
		}
	}
	let path = approvals_path();
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)?;
	}
	let raw = serde_json::to_string_pretty(&all).map_err(|e| CockpitError::msg(e.to_string()))?;
	std::fs::write(path, raw)?;
	Ok(())
}

/// Ce que rend une installation.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Installation {
	/// Installé ; le message du CLI.
	Installed { message: String },
	/// La marketplace déclare une commande à lancer pour installer : elle doit
	/// être montrée, et acceptée par son empreinte, avant de recommencer.
	NeedsCommand { command: String, sha256: String },
}

/// La réponse de `claude plugin install --json`.
fn parse_installation(raw: &str) -> Result<Installation> {
	let line = raw.lines().rev().find(|line| line.trim_start().starts_with('{')).unwrap_or_default();
	let value: serde_json::Value = serde_json::from_str(line).map_err(|_| CockpitError::msg(raw.trim().to_string()))?;
	let text = |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string();
	if text(&value, "outcome") == "ok" {
		return Ok(Installation::Installed { message: text(&value, "message") });
	}
	if let Some(shown) = value.get("shownCommand").filter(|shown| shown.is_object()) {
		let sha256 = text(shown, "sha256");
		if !sha256.is_empty() {
			let command = ["command", "text", "display"]
				.iter()
				.map(|key| text(shown, key))
				.find(|found| !found.is_empty())
				.unwrap_or_else(|| shown.to_string());
			return Ok(Installation::NeedsCommand { command, sha256 });
		}
	}
	let message = text(&value, "message");
	Err(CockpitError::msg(if message.is_empty() { raw.trim().to_string() } else { message }))
}

/// Installe un plugin pour le projet (`project`, commité et partagé) ou pour ce
/// poste seulement (`local`).
///
/// `approved` est l'empreinte de ce que tu as lu : le plugin est relu au moment
/// d'installer, et si ce qu'il exécute a changé entre-temps, on refuse — on
/// n'installe que ce qui a été lu. `accept` est l'empreinte d'une commande de
/// marketplace déjà montrée et acceptée (voir [`Installation::NeedsCommand`]).
pub async fn install(project: &Path, plugin_id: &str, scope: &str, approved: &str, accept: Option<&str>) -> Result<Installation> {
	if !matches!(scope, "project" | "local") {
		return Err(CockpitError::msg(crate::i18n::tf("methods.badScope", &[("scope", &scope)])));
	}
	let fresh = inspect(project, plugin_id).await?;
	if fresh.inventory.fingerprint != approved {
		return Err(CockpitError::msg(crate::i18n::t("methods.changedSinceReading")));
	}
	let mut args = vec!["plugin", "install", plugin_id, "--scope", scope, "--json"];
	if let Some(sha) = accept {
		args.extend(["--accept-command", sha]);
	}
	let (_, stdout, stderr) = claude_raw(project, &args).await?;
	let result = parse_installation(if stdout.trim().is_empty() { &stderr } else { &stdout })?;
	if matches!(result, Installation::Installed { .. }) {
		// Le CLI récupère le plugin de son côté, peut-être après avoir rafraîchi
		// la marketplace : on relit ce qu'il a réellement installé. Si ce n'est
		// pas ce qui a été lu, il repart aussitôt.
		let installed = catalog(project).await?.installed.into_iter().find(|p| p.id == plugin_id && p.scope == scope);
		let matches_reading = installed
			.as_ref()
			.is_some_and(|p| read_plugin(Path::new(&p.install_path)).fingerprint == approved);
		if !matches_reading {
			let _ = claude(project, &["plugin", "uninstall", plugin_id, "--scope", scope, "--json"]).await;
			return Err(CockpitError::msg(crate::i18n::t("methods.installedDiffers")));
		}
		set_approval(
			project,
			plugin_id,
			Some(Approval { fingerprint: approved.to_string(), scope: scope.to_string(), at: chrono::Utc::now().to_rfc3339() }),
		)?;
	}
	Ok(result)
}

/// Désinstalle un plugin de la portée où il est installé.
pub async fn uninstall(project: &Path, plugin_id: &str, scope: &str) -> Result<String> {
	let raw = claude(project, &["plugin", "uninstall", plugin_id, "--scope", scope, "--json"]).await?;
	// L'accord ne part qu'avec la portée qu'il couvrait.
	if approval(project, plugin_id).is_some_and(|approved| approved.scope == scope) {
		set_approval(project, plugin_id, None)?;
	}
	let value: serde_json::Value = serde_json::from_str(raw.trim()).unwrap_or_default();
	Ok(value.get("message").and_then(|m| m.as_str()).unwrap_or_default().to_string())
}

// ── Mesurer ──────────────────────────────────────────────────────────────────

/// Ce que les agents du projet ont donné sur une période.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Period {
	/// Exécutions terminées.
	pub executions: usize,
	/// Celles qui ont échoué ou ne sont jamais parties.
	pub failed: usize,
	pub median_turns: Option<f64>,
	pub median_cost_usd: Option<f64>,
}

/// Avant et après l'installation d'un plugin, à durée égale.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Measure {
	pub since: String,
	pub days: i64,
	pub before: Period,
	pub after: Period,
}

fn median(mut values: Vec<f64>) -> Option<f64> {
	if values.is_empty() {
		return None;
	}
	values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
	let middle = values.len() / 2;
	Some(if values.len() % 2 == 1 { values[middle] } else { (values[middle - 1] + values[middle]) / 2.0 })
}

fn period(executions: &[&crate::executions::Execution]) -> Period {
	use crate::executions::Outcome;
	let done: Vec<_> = executions.iter().filter(|e| !matches!(e.outcome, Outcome::Running)).collect();
	Period {
		executions: done.len(),
		failed: done.iter().filter(|e| matches!(e.outcome, Outcome::Failed | Outcome::LostAtLaunch)).count(),
		median_turns: median(done.iter().map(|e| e.tally.turns as f64).collect()),
		median_cost_usd: median(
			done.iter()
				.map(|e| e.tally.cost.reported_usd + e.tally.cost.estimated_usd)
				.filter(|cost| *cost > 0.0)
				.collect(),
		),
	}
}

/// Compare les exécutions du projet avant et après `since`, sur autant de jours
/// de part et d'autre — au plus trente. Les exécutions du projet sont celles
/// lancées pendant qu'il était actif (`Opening::project`).
pub fn measure_between(all: &[crate::executions::Execution], project_id: &str, since: chrono::DateTime<chrono::Utc>, now: chrono::DateTime<chrono::Utc>) -> Measure {
	let days = (now - since).num_days().clamp(1, 30);
	let window = chrono::Duration::days(days);
	let at = |e: &crate::executions::Execution| chrono::DateTime::parse_from_rfc3339(&e.started_at).ok().map(|d| d.with_timezone(&chrono::Utc));
	let mine: Vec<_> = all.iter().filter(|e| e.opening.project == project_id).collect();
	let before: Vec<_> = mine.iter().copied().filter(|e| at(e).is_some_and(|d| d < since && d >= since - window)).collect();
	let after: Vec<_> = mine.iter().copied().filter(|e| at(e).is_some_and(|d| d >= since && d < since + window)).collect();
	Measure { since: since.to_rfc3339(), days, before: period(&before), after: period(&after) }
}

/// L'avant/après d'un plugin installé : depuis ton accord, ou à défaut depuis
/// son installation selon le CLI.
pub async fn measure(project: &Path, project_id: &str, plugin_id: &str) -> Result<Measure> {
	let since = match approval(project, plugin_id) {
		Some(approved) => approved.at,
		None => catalog(project)
			.await?
			.installed
			.into_iter()
			.find(|p| p.id == plugin_id)
			.map(|p| p.installed_at)
			.unwrap_or_default(),
	};
	let since = chrono::DateTime::parse_from_rfc3339(&since)
		.map_err(|_| CockpitError::msg(crate::i18n::tf("methods.unknownPlugin", &[("id", &plugin_id)])))?
		.with_timezone(&chrono::Utc);
	Ok(measure_between(&crate::executions::fold(), project_id, since, chrono::Utc::now()))
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Bout en bout, avec le vrai CLI : installer pour un projet jetable un
	/// plugin qui n'exécute rien, retrouver l'accord et le réglage du projet,
	/// refuser une empreinte qui n'est pas celle lue, puis désinstaller.
	#[tokio::test]
	#[ignore]
	async fn un_plugin_s_installe_pour_le_projet_puis_se_desinstalle() {
		let project = std::env::temp_dir().join(format!("cockpit-methodes-projet-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&project);
		std::fs::create_dir_all(&project).unwrap();
		let id = "agent-sdk-dev@claude-plugins-official";
		let read = inspect(&project, id).await.unwrap();
		assert!(read.inventory.hooks.is_empty() && read.inventory.servers.is_empty());

		// Une empreinte qui n'est pas celle lue : refusé, rien n'est installé.
		assert!(install(&project, id, "project", "pas-la-bonne", None).await.is_err());

		let done = install(&project, id, "project", &read.inventory.fingerprint, None).await.unwrap();
		assert!(matches!(done, Installation::Installed { .. }), "{done:?}");
		let settings = std::fs::read_to_string(project.join(".claude").join("settings.json")).unwrap();
		assert!(settings.contains(id), "{settings}");
		assert_eq!(approval(&project, id).map(|a| a.scope), Some("project".into()));

		uninstall(&project, id, "project").await.unwrap();
		assert!(approval(&project, id).is_none());
		let settings = std::fs::read_to_string(project.join(".claude").join("settings.json")).unwrap();
		assert!(!settings.contains(&format!("\"{id}\": true")), "{settings}");
		let _ = std::fs::remove_dir_all(&project);
	}

	/// Les réponses de `install --json` : installé, commande à accepter, refus.
	#[test]
	fn la_reponse_d_installation_se_lit() {
		assert_eq!(
			parse_installation(r#"{"command":"install","outcome":"ok","message":"Successfully installed plugin: a@m (scope: project)"}"#).unwrap(),
			Installation::Installed { message: "Successfully installed plugin: a@m (scope: project)".into() }
		);
		assert_eq!(
			parse_installation(r#"{"outcome":"needs-confirmation","shownCommand":{"command":"npx a-installer","sha256":"ab12"}}"#).unwrap(),
			Installation::NeedsCommand { command: "npx a-installer".into(), sha256: "ab12".into() }
		);
		let refus = parse_installation(r#"{"outcome":"error","message":"Plugin not found"}"#).unwrap_err();
		assert!(refus.to_string().contains("Plugin not found"));
	}

	/// L'avant/après compare deux fenêtres de même durée, et seulement les
	/// exécutions du projet.
	#[test]
	fn l_avant_apres_compare_des_fenetres_egales() {
		use crate::executions::{Execution, Outcome};
		let since = chrono::DateTime::parse_from_rfc3339("2026-11-10T00:00:00Z").unwrap().with_timezone(&chrono::Utc);
		let now = since + chrono::Duration::days(5);
		let exec = |day: i64, project: &str, outcome: Outcome, turns: u32, usd: f64| {
			let mut tally = crate::executions::Tally { turns, ..Default::default() };
			tally.cost.reported_usd = usd;
			Execution {
				id: String::new(),
				started_at: (since + chrono::Duration::days(day)).to_rfc3339(),
				ended_at: String::new(),
				opening: crate::executions::Opening { project: project.into(), ..Default::default() },
				engine_session: String::new(),
				models: Vec::new(),
				verdict: String::new(),
				outcome,
				tally,
				note: String::new(),
				events_dropped: 0,
				steps: Vec::new(),
				observability: crate::executions::Observability {
					reports_cost: true,
					reports_token_split: true,
					reports_tool_results: true,
					reports_thinking: true,
					resumable: true,
				},
			}
		};
		let all = vec![
			exec(-3, "shop", Outcome::Answered, 10, 1.0),
			exec(-2, "shop", Outcome::Failed, 14, 2.0),
			exec(-20, "shop", Outcome::Answered, 50, 9.0), // hors fenêtre : 5 jours avant seulement
			exec(1, "shop", Outcome::Answered, 6, 0.6),
			exec(2, "shop", Outcome::Answered, 8, 0.8),
			exec(2, "blog", Outcome::Failed, 99, 9.9), // un autre projet
			exec(3, "shop", Outcome::Running, 1, 0.1), // pas terminée
		];
		let measure = measure_between(&all, "shop", since, now);
		assert_eq!(measure.days, 5);
		assert_eq!((measure.before.executions, measure.before.failed), (2, 1));
		assert_eq!(measure.before.median_turns, Some(12.0));
		assert_eq!((measure.after.executions, measure.after.failed), (2, 0));
		assert_eq!(measure.after.median_cost_usd, Some(0.7));
	}

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
		assert!(inventory.hooks.is_empty() && inventory.servers.is_empty() && inventory.scripts.is_empty());
		assert_eq!(inventory.fingerprint.len(), 64, "l'empreinte couvre aussi les instructions");
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

		// Un fichier qu'aucune déclaration ne nomme, mais que le script importe :
		// le modifier change l'empreinte aussi.
		write(&dir, "hooks/lib/impl.py", "OK = 1\n");
		let avec_import = read_plugin(&dir).fingerprint;
		write(&dir, "hooks/lib/impl.py", "OK = 2\n");
		assert_ne!(read_plugin(&dir).fingerprint, avec_import);
		// Les marqueurs du cache de Claude Code, eux, ne comptent pas.
		let avant_marqueurs = read_plugin(&dir).fingerprint;
		write(&dir, ".in_use/1234", "");
		write(&dir, ".orphaned_at", "2026");
		assert_eq!(read_plugin(&dir).fingerprint, avant_marqueurs);

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

	/// Ce qui s'exécute se lit sous toutes ses formes : hooks déclarés par un
	/// chemin, hooks HTTP, serveurs de langage, exécutables de `bin/`.
	#[test]
	fn ce_qui_s_execute_se_lit_sous_toutes_ses_formes() {
		let dir = plugin("formes");
		write(
			&dir,
			".claude-plugin/plugin.json",
			r#"{"name":"formes","hooks":"./config/hooks.json","lspServers":{"rust":{"command":"rust-analyzer"}}}"#,
		);
		write(
			&dir,
			"config/hooks.json",
			r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh run.sh"},{"type":"http","url":"https://hook.example.com"}]}]}}"#,
		);
		write(&dir, "bin/outil", "#!/bin/sh\n");
		let inventory = read_plugin(&dir);
		let hooks: Vec<_> = inventory.hooks.iter().map(|h| h.command.as_str()).collect();
		assert_eq!(hooks, vec!["sh run.sh", "HTTP https://hook.example.com"]);
		assert!(inventory.servers.iter().any(|s| s.name == "LSP · rust" && s.target == "rust-analyzer"));
		assert_eq!(inventory.scripts, vec!["bin/outil"]);
		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Un chemin venu d'une marketplace ou d'un manifeste ne sort pas de son
	/// dossier.
	#[test]
	fn les_chemins_hors_du_plugin_sont_refuses() {
		for bon in ["plugins/a", "./plugins/a", "a"] {
			assert!(safe_relative(bon), "{bon}");
		}
		for mauvais in ["../a", "plugins/../../a", "/etc/passwd", "C:/Users/x", ""] {
			assert!(!safe_relative(mauvais), "{mauvais}");
		}
		// Un manifeste qui désigne un fichier hors du plugin n'est pas suivi.
		let dir = plugin("hors");
		write(&dir, ".claude-plugin/plugin.json", r#"{"name":"hors","hooks":"../ailleurs.json"}"#);
		assert!(read_plugin(&dir).hooks.is_empty());
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
