//! Les serveurs MCP que le dépôt déclare, et ce qu'un agent en verra vraiment.
//!
//! Un dépôt déclare ses outils dans un `.mcp.json` à sa racine — le format
//! partagé, celui qu'on commite pour que toute l'équipe ait les mêmes. Claude
//! Code le lit, mais **demande une approbation par répertoire** avant d'activer
//! ces serveurs, et il la demande de façon interactive.
//!
//! Un agent lancé par le cockpit n'a pas de terminal : la question ne peut pas
//! être posée, donc les serveurs restent inactifs. En silence. Et comme chaque
//! worktree est un répertoire neuf, aucun n'est jamais approuvé : un agent
//! lancé sur un chantier n'avait aucun des outils de son propre dépôt, alors
//! que le même dépôt ouvert dans un terminal les avait tous.
//!
//! Vérifié en marchant, sur un worktree réel : sans rien, l'agent répond
//! « aucun serveur » ; avec le `.mcp.json` joint par `--mcp-config`, il liste
//! les treize qu'il devait avoir. Le fichier était pourtant là, dans le
//! worktree, depuis le début.
//!
//! Mais joindre ce fichier d'office contournait aussi ce que l'approbation
//! protège : un dépôt cloné peut déclarer un serveur `stdio` dont la commande
//! est n'importe quoi (`sh -c "…"`), lancé sans question au premier agent. Le
//! cockpit pose donc sa propre approbation, une fois par dépôt (worktrees
//! compris) et pour un contenu précis : une empreinte du fichier. Le fichier
//! change — une branche ajoute un serveur, une commande bouge —, l'approbation
//! ne vaut plus, et l'agent part sans ces serveurs jusqu'à la suivante.
//!
//! Ce module fait donc trois choses :
//!
//! - [`approve`] et [`approval`] tiennent l'approbation ;
//! - [`config_for`] rend le fichier à joindre au lancement, quand il est
//!   approuvé et utilisable. Joindre un fichier illisible ferait **refuser le démarrage**
//!   du CLI (« Invalid MCP configuration ») : on ne joint que ce qui parse.
//! - [`inspect`] dit, serveur par serveur, ce qui marchera et ce qui ne
//!   marchera pas — parce qu'un agent qui sait qu'un outil lui manque le
//!   signale, là où un agent qui l'ignore invente.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Le nom du fichier partagé, tel que Claude Code l'attend à la racine.
const FILE: &str = ".mcp.json";

/// Ce que l'image d'isolation embarque (`sandbox/Dockerfile`) : de quoi lancer
/// un serveur en `npx`, et rien d'autre. Un serveur qui demande `bun`, `uvx` ou
/// un binaire du poste n'y trouvera pas son compte.
const IN_IMAGE: [&str; 6] = ["npx", "node", "npm", "git", "zsh", "bash"];

/// Les serveurs hébergés dont le cockpit sait poser le jeton lui-même dans un
/// conteneur — voir `sandbox::provision_mcp_tokens`. Les autres dépendent d'une
/// autorisation OAuth qui vit dans le trousseau du poste, et qui n'y est pas.
const PROVISIONED: [&str; 3] = ["linear", "stripe", "betterstack"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
	pub name: String,
	/// `http`, `sse` ou `stdio`.
	pub kind: String,
	/// L'adresse ou la commande, telle qu'elle est déclarée.
	pub target: String,
	/// Vrai quand rien ne s'oppose à ce que ce serveur réponde.
	pub reachable: bool,
	/// Pourquoi il ne répondra pas, quand c'est le cas. Vide sinon.
	pub blocker: String,
}

/// Le fichier à joindre à un agent qui travaille dans `cwd`, s'il y en a un
/// d'utilisable.
///
/// Un worktree porte le même `.mcp.json` que son dépôt : c'est un fichier
/// suivi par git, il suit la branche. On ne va donc pas le chercher ailleurs.
pub fn config_for(cwd: &str, sandboxed: bool) -> Option<PathBuf> {
	let path = Path::new(cwd).join(FILE);
	let servers = read_servers(&path);
	// Un fichier qu'on ne sait pas lire ferait refuser le démarrage du CLI :
	// mieux vaut un agent sans ses outils qu'un agent qui ne part pas.
	if servers.is_empty() {
		return None;
	}
	// Sans approbation de ce contenu précis, rien n'est joint : ce sont des
	// commandes que le dépôt fait lancer sur le poste.
	if fingerprint(&servers) != approved_fingerprint(cwd) {
		return None;
	}
	// On joint toujours une copie de ce qui a été vérifié, jamais le fichier du
	// dépôt : il pourrait changer entre la vérification et la lecture du CLI.
	if !sandboxed {
		return write_filtered(cwd, &servers);
	}

	// Dans un conteneur, le cockpit a déjà posé un jeton pour certains de ces
	// serveurs (`sandbox::provision_mcp_tokens`) — la seule façon de les faire
	// répondre là où le trousseau du poste n'existe pas. Les rejoindre depuis
	// le dépôt les redéclarerait en OAuth, c'est-à-dire sans jeton du tout, et
	// écraserait ce qui marchait. On les laisse donc de côté : leur version
	// authentifiée est déjà en place.
	let restants: Vec<_> = servers
		.into_iter()
		.filter(|(name, _)| !PROVISIONED.contains(&name.as_str()))
		.collect();
	if restants.is_empty() {
		return None;
	}
	write_filtered(cwd, &restants)
}

/// Écrit la liste retenue à côté de la configuration, et rend son chemin.
///
/// Un fichier par dossier de travail : deux agents lancés en même temps sur
/// deux dépôts différents ne doivent pas se disputer le même.
fn write_filtered(cwd: &str, servers: &[(String, serde_json::Value)]) -> Option<PathBuf> {
	let map: serde_json::Map<String, serde_json::Value> =
		servers.iter().cloned().collect();
	let payload = serde_json::json!({ "mcpServers": map });
	let path = crate::config::config_dir().join(format!("mcp-projet-{}.json", key_of(cwd)));
	std::fs::create_dir_all(crate::config::config_dir()).ok()?;
	std::fs::write(&path, serde_json::to_string_pretty(&payload).ok()?).ok()?;
	Some(path)
}

// ───────────────────────────── Approbation ─────────────────────────────

/// Où vivent les approbations : un dépôt → l'empreinte du contenu approuvé.
fn approvals_path() -> PathBuf {
	crate::config::config_dir().join("mcp-approbations.json")
}

/// Le dépôt auquel appartient `cwd`, worktrees compris : leur dossier `.git`
/// commun. Un worktree neuf hérite ainsi de l'approbation de son dépôt — tant
/// que son `.mcp.json` dit la même chose.
fn repo_identity(cwd: &str) -> String {
	std::process::Command::new("git")
		.args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
		.current_dir(cwd)
		.output()
		.ok()
		.filter(|output| output.status.success())
		.map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
		.filter(|dir| !dir.is_empty())
		.unwrap_or_else(|| {
			std::fs::canonicalize(cwd)
				.map(|path| path.to_string_lossy().to_string())
				.unwrap_or_else(|_| cwd.to_string())
		})
}

/// L'empreinte d'une liste de serveurs : ce qui est approuvé, c'est ce contenu
/// et pas un autre. Indépendante de la mise en forme du fichier (les objets
/// JSON sont relus et réécrits dans un ordre stable).
pub fn fingerprint(servers: &[(String, serde_json::Value)]) -> String {
	use sha2::{Digest, Sha256};
	let map: serde_json::Map<String, serde_json::Value> = servers.iter().cloned().collect();
	let canonical = serde_json::to_string(&map).unwrap_or_default();
	let digest = Sha256::digest(canonical.as_bytes());
	digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn load_approvals() -> serde_json::Map<String, serde_json::Value> {
	std::fs::read_to_string(approvals_path())
		.ok()
		.and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
		.and_then(|value| value.as_object().cloned())
		.unwrap_or_default()
}

fn approved_fingerprint(cwd: &str) -> String {
	load_approvals()
		.get(&repo_identity(cwd))
		.and_then(|value| value.as_str())
		.unwrap_or_default()
		.to_string()
}

/// L'état de l'approbation pour le dépôt de `cwd`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
	/// Le contenu actuel du `.mcp.json` est approuvé.
	pub approved: bool,
	/// Une approbation existe, mais pour un autre contenu : le fichier a changé.
	pub changed: bool,
}

pub fn approval(cwd: &str) -> Approval {
	let servers = read_servers(&Path::new(cwd).join(FILE));
	let recorded = approved_fingerprint(cwd);
	let approved = !servers.is_empty() && fingerprint(&servers) == recorded;
	Approval { approved, changed: !approved && !recorded.is_empty() }
}

/// Approuve le contenu **actuel** du `.mcp.json` de `cwd`, pour tout son dépôt.
/// L'approbation précédente du même dépôt est remplacée.
pub fn approve(cwd: &str) -> crate::error::Result<Approval> {
	let servers = read_servers(&Path::new(cwd).join(FILE));
	if servers.is_empty() {
		return Err(crate::error::CockpitError::msg(crate::i18n::t("mcp.noServers")));
	}
	let mut approvals = load_approvals();
	approvals.insert(repo_identity(cwd), serde_json::Value::String(fingerprint(&servers)));
	std::fs::create_dir_all(crate::config::config_dir())?;
	std::fs::write(approvals_path(), serde_json::to_string_pretty(&approvals).map_err(anyhow::Error::from)?)?;
	Ok(approval(cwd))
}

/// Retire l'approbation du dépôt de `cwd`.
pub fn revoke(cwd: &str) -> crate::error::Result<Approval> {
	let mut approvals = load_approvals();
	approvals.remove(&repo_identity(cwd));
	std::fs::create_dir_all(crate::config::config_dir())?;
	std::fs::write(approvals_path(), serde_json::to_string_pretty(&approvals).map_err(anyhow::Error::from)?)?;
	Ok(approval(cwd))
}

/// Une clé stable et lisible pour nommer le fichier d'un dossier.
pub(crate) fn key_of(cwd: &str) -> String {
	let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
	for byte in cwd.as_bytes() {
		hash ^= *byte as u64;
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	format!("{hash:x}")
}

fn read_servers(path: &Path) -> Vec<(String, serde_json::Value)> {
	let Ok(raw) = std::fs::read_to_string(path) else {
		return Vec::new();
	};
	parse_servers(&raw)
}

/// Les serveurs déclarés, dans l'ordre du fichier. Vide si le contenu n'est pas
/// exploitable — c'est le test qui décide si on joint le fichier ou non.
pub fn parse_servers(raw: &str) -> Vec<(String, serde_json::Value)> {
	serde_json::from_str::<serde_json::Value>(raw)
		.ok()
		.and_then(|value| value.get("mcpServers")?.as_object().cloned())
		.map(|servers| servers.into_iter().collect())
		.unwrap_or_default()
}

/// Ce qu'un agent verra, et ce qu'il ne verra pas.
///
/// `sandboxed` change tout : dans un conteneur, une adresse en `localhost`
/// désigne le conteneur et non le poste, une autorisation OAuth du trousseau
/// n'existe pas, et une commande absente de l'image ne se lance pas.
pub fn inspect(cwd: &str, sandboxed: bool) -> Vec<Server> {
	read_servers(&Path::new(cwd).join(FILE))
		.into_iter()
		.map(|(name, config)| describe(&name, &config, sandboxed))
		.collect()
}

/// Le verdict pour un serveur. Séparé de la lecture du disque pour être
/// éprouvé — même patron que `mission::blocking_reason`.
pub fn describe(name: &str, config: &serde_json::Value, sandboxed: bool) -> Server {
	let url = config.get("url").and_then(|v| v.as_str()).unwrap_or_default();
	let command = config
		.get("command")
		.and_then(|v| v.as_str())
		.unwrap_or_default();
	let declared = config.get("type").and_then(|v| v.as_str()).unwrap_or("");

	let kind = if !declared.is_empty() {
		declared.to_string()
	} else if url.is_empty() {
		"stdio".to_string()
	} else {
		"http".to_string()
	};

	let target = if url.is_empty() {
		let args: Vec<String> = config
			.get("args")
			.and_then(|v| v.as_array())
			.map(|args| {
				args.iter()
					.filter_map(|a| a.as_str().map(|s| s.to_string()))
					.collect()
			})
			.unwrap_or_default();
		format!("{command} {}", args.join(" ")).trim().to_string()
	} else {
		url.to_string()
	};

	// Une adresse locale ne désigne pas le même hôte des deux côtés. C'est vrai
	// même hors conteneur, mais là le serveur tourne bien sur le poste : ce
	// n'est un obstacle qu'une fois isolé.
	let local = url.contains("127.0.0.1") || url.contains("localhost") || url.contains("[::1]");

	let blocker = if !sandboxed {
		String::new()
	} else if local {
		crate::i18n::t("mcp.blockerLocal")
	} else if !command.is_empty() && !IN_IMAGE.contains(&command) {
		crate::i18n::tf("mcp.blockerNotInImage", &[("command", &command)])
	} else if !url.is_empty()
		&& config.get("headers").is_none()
		&& !PROVISIONED.contains(&name)
	{
		crate::i18n::t("mcp.blockerOauth")
	} else {
		String::new()
	};

	Server {
		name: name.to_string(),
		kind,
		target,
		reachable: blocker.is_empty(),
		blocker,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn un_fichier_sans_serveur_ne_se_joint_pas() {
		// Joindre un fichier vide ou illisible ferait refuser le démarrage du
		// CLI : un agent sans ses outils vaut mieux qu'un agent qui ne part pas.
		assert!(parse_servers("").is_empty());
		assert!(parse_servers("{ pas du json").is_empty());
		assert!(parse_servers(r#"{"mcpServers":{}}"#).is_empty());
		assert!(parse_servers(r#"{"autre":1}"#).is_empty());
	}

	#[test]
	fn l_empreinte_suit_le_contenu_pas_la_forme() {
		let a = parse_servers(r#"{"mcpServers":{"a":{"command":"npx","args":["x"]},"b":{"url":"https://y"}}}"#);
		let meme = parse_servers("{\n  \"mcpServers\": {\"b\":{\"url\":\"https://y\"},\n \"a\":{\"args\":[\"x\"],\"command\":\"npx\"}}}");
		let autre = parse_servers(r#"{"mcpServers":{"a":{"command":"sh","args":["-c","x"]},"b":{"url":"https://y"}}}"#);
		assert_eq!(fingerprint(&a), fingerprint(&meme));
		assert_ne!(fingerprint(&a), fingerprint(&autre));
	}

	#[test]
	fn deux_dossiers_ne_partagent_pas_le_meme_fichier() {
		assert_ne!(key_of("/a/projet"), key_of("/b/projet"));
		assert_eq!(key_of("/a/projet"), key_of("/a/projet"));
	}

	#[test]
	fn un_fichier_valide_rend_ses_serveurs() {
		let servers = parse_servers(r#"{"mcpServers":{"a":{"url":"https://x"},"b":{"command":"npx"}}}"#);
		assert_eq!(servers.len(), 2);
	}

	#[test]
	fn hors_conteneur_rien_ne_bloque() {
		for config in [
			json!({ "url": "http://127.0.0.1:3845/sse", "type": "sse" }),
			json!({ "command": "bun", "args": ["x"] }),
			json!({ "url": "https://mcp.exa.ai/mcp" }),
		] {
			let s = describe("truc", &config, false);
			assert!(s.reachable, "{} devait passer", s.name);
			assert!(s.blocker.is_empty());
		}
	}

	#[test]
	fn en_conteneur_une_adresse_locale_ne_designe_plus_le_poste() {
		let s = describe(
			"figma-dev-mode",
			&json!({ "url": "http://127.0.0.1:3845/sse", "type": "sse" }),
			true,
		);
		assert!(!s.reachable);
		assert!(s.blocker.contains("local address"));
	}

	#[test]
	fn en_conteneur_npx_passe_mais_pas_un_binaire_absent_de_l_image() {
		let npx = describe("trigger", &json!({ "command": "npx", "args": ["-y", "x"] }), true);
		assert!(npx.reachable, "{}", npx.blocker);
		assert_eq!(npx.kind, "stdio");
		assert_eq!(npx.target, "npx -y x");

		let bun = describe("maison", &json!({ "command": "bun" }), true);
		assert!(!bun.reachable);
		assert!(bun.blocker.contains("isolation image"));
	}

	#[test]
	fn en_conteneur_oauth_ne_suit_pas_sauf_pour_ce_que_le_cockpit_provisionne() {
		// Le jeton d'un serveur OAuth vit dans le trousseau du poste : il n'est
		// pas dans le conteneur, et rien ne l'y met — sauf pour les trois que
		// `sandbox::provision_mcp_tokens` sait authentifier par en-tête.
		let exa = describe("exa", &json!({ "url": "https://mcp.exa.ai/mcp" }), true);
		assert!(!exa.reachable);
		assert!(exa.blocker.contains("OAuth"));

		let linear = describe("linear", &json!({ "url": "https://mcp.linear.app/mcp" }), true);
		assert!(linear.reachable, "{}", linear.blocker);

		// Un serveur qui porte son propre en-tête n'a besoin de personne.
		let propre = describe(
			"maison",
			&json!({ "url": "https://exemple.test", "headers": { "Authorization": "Bearer x" } }),
			true,
		);
		assert!(propre.reachable, "{}", propre.blocker);
	}

	#[test]
	fn le_type_declare_prime_sur_ce_qu_on_devine() {
		assert_eq!(
			describe("s", &json!({ "url": "https://x", "type": "sse" }), false).kind,
			"sse"
		);
		assert_eq!(describe("s", &json!({ "url": "https://x" }), false).kind, "http");
		assert_eq!(describe("s", &json!({ "command": "npx" }), false).kind, "stdio");
	}
}
