//! Les rôles qu'un dépôt versionne avec son code, dans `.cockpit/roles.toml`.
//!
//! Sans ce fichier, un rôle vit dans la configuration d'un seul poste : un collègue
//! qui clone le dépôt n'a ni les consignes ni les périmètres de l'équipe, et une
//! consigne corrigée ne se relit pas en revue.
//!
//! Ce fichier vient de celui qui a écrit le dépôt, pas de celui qui lance la mission.
//! Il dit donc comment travailler, jamais avec quels droits : `permissionMode` et
//! `engine` restent sur le poste, et un fichier qui les porte est refusé plutôt que
//! lu à moitié. Sans ça, cloner un dépôt suffirait à lancer ses agents sans garde-fou.

use crate::config::RoleConfig;
use serde::Deserialize;
use std::path::Path;

pub const FILE: &str = ".cockpit/roles.toml";

/// Ce que prend un rôle apparu par le dépôt, qu'aucun poste n'a encore réglé. Chaque
/// commande demande l'accord de l'utilisateur tant qu'il n'a pas décidé autre chose
/// en déclarant ce rôle chez lui.
const NEW_ROLE_PERMISSION: &str = "acceptEdits";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoFile {
	#[serde(default)]
	roles: Vec<RepoRole>,
}

/// Un champ absent garde la valeur du poste : le dépôt peut ne fixer que la consigne.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoRole {
	id: String,
	label: Option<String>,
	prompt: Option<String>,
	model: Option<String>,
	depth: Option<String>,
	command: Option<String>,
	verifies: Option<bool>,
	scope: Option<Vec<String>>,
}

fn declared(repo: &str) -> Result<Vec<RepoRole>, String> {
	// Un chemin vide viserait le dossier courant de l'application.
	if repo.trim().is_empty() {
		return Ok(Vec::new());
	}
	let raw = match std::fs::read_to_string(Path::new(repo).join(FILE)) {
		Ok(raw) => raw,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
		Err(error) => return Err(error.to_string()),
	};
	parse(&raw)
}

fn parse(raw: &str) -> Result<Vec<RepoRole>, String> {
	let file: RepoFile = toml::from_str(raw).map_err(|error| error.to_string())?;
	let mut seen = std::collections::HashSet::new();
	for role in &file.roles {
		if role.id.trim().is_empty() {
			return Err("a role has an empty `id`".to_string());
		}
		if !seen.insert(role.id.as_str()) {
			return Err(format!("the role `{}` is declared twice", role.id));
		}
	}
	Ok(file.roles)
}

/// Pose les rôles du dépôt sur ceux du poste, sans en retirer aucun.
fn overlay(mut roles: Vec<RoleConfig>, declared: Vec<RepoRole>) -> Vec<RoleConfig> {
	for repo_role in declared {
		let index = roles
			.iter()
			.position(|role| role.id == repo_role.id)
			.unwrap_or_else(|| {
				roles.push(RoleConfig {
					label: repo_role.id.clone(),
					id: repo_role.id.clone(),
					permission_mode: NEW_ROLE_PERMISSION.to_string(),
					..Default::default()
				});
				roles.len() - 1
			});
		let role = &mut roles[index];
		if let Some(label) = repo_role.label {
			role.label = label;
		}
		if let Some(prompt) = repo_role.prompt {
			role.prompt = prompt;
		}
		if let Some(model) = repo_role.model {
			role.model = model;
		}
		if let Some(depth) = repo_role.depth {
			role.depth = depth;
		}
		if let Some(command) = repo_role.command {
			role.command = command;
		}
		if let Some(verifies) = repo_role.verifies {
			role.verifies = verifies;
		}
		if let Some(scope) = repo_role.scope {
			role.scope = scope;
		}
	}
	roles
}

/// Les rôles du poste, complétés par ceux du dépôt.
///
/// Un fichier illisible n'en retire rien : cet appel sert aussi aux missions en cours,
/// qu'une faute de frappe sur une branche ne doit pas arrêter. C'est `check`, au
/// lancement du maître, qui la signale.
pub fn with_repo(repo: &str, local: Vec<RoleConfig>) -> Vec<RoleConfig> {
	match declared(repo) {
		Ok(declared) => overlay(local, declared),
		Err(_) => local,
	}
}

/// Dit pourquoi le fichier du dépôt ne peut pas être lu. Une mission partie sur les
/// rôles génériques sans le dire, c'est une équipe qui croit suivre ses consignes.
pub fn check(repo: &str) -> Result<(), String> {
	declared(repo).map(|_| ())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn local(id: &str, mode: &str) -> RoleConfig {
		RoleConfig {
			id: id.into(),
			label: "Du poste".into(),
			prompt: "Consigne du poste".into(),
			engine: "codex".into(),
			permission_mode: mode.into(),
			..Default::default()
		}
	}

	#[test]
	fn le_depot_ne_peut_pas_s_accorder_de_droits() {
		for champ in ["permissionMode", "permission_mode", "engine"] {
			let raw = format!("[[roles]]\nid = \"qa\"\n{champ} = \"bypassPermissions\"\n");
			let refus = parse(&raw).unwrap_err();
			assert!(refus.contains(champ), "{refus}");
		}
	}

	#[test]
	fn un_role_nouveau_demande_l_accord_de_l_utilisateur() {
		let roles = overlay(Vec::new(), parse("[[roles]]\nid = \"data\"\nprompt = \"p\"\n").unwrap());
		assert_eq!(roles[0].id, "data");
		assert_eq!(roles[0].label, "data");
		assert_eq!(roles[0].permission_mode, "acceptEdits");
	}

	#[test]
	fn un_role_connu_garde_ses_droits_et_son_moteur() {
		let raw = "[[roles]]\nid = \"qa\"\nprompt = \"Du dépôt\"\nverifies = true\nscope = [\"tests/**\"]\n";
		let roles = overlay(
			vec![local("qa", "bypassPermissions"), local("autre", "default")],
			parse(raw).unwrap(),
		);
		assert_eq!(roles.len(), 2, "aucun rôle du poste ne disparaît");
		assert_eq!(roles[0].prompt, "Du dépôt");
		assert!(roles[0].verifies);
		assert_eq!(roles[0].scope, vec!["tests/**".to_string()]);
		assert_eq!(roles[0].permission_mode, "bypassPermissions");
		assert_eq!(roles[0].engine, "codex");
		assert_eq!(roles[0].label, "Du poste", "un champ absent ne change rien");
		assert_eq!(roles[1].prompt, "Consigne du poste");
	}

	#[test]
	fn un_fichier_faux_est_signale_sans_retirer_les_roles_du_poste() {
		let dir = std::env::temp_dir().join(format!("cockpit-roles-{}", std::process::id()));
		std::fs::create_dir_all(dir.join(".cockpit")).unwrap();
		let repo = dir.to_string_lossy().to_string();

		assert!(check(&repo).is_ok(), "pas de fichier, rien à redire");

		std::fs::write(dir.join(FILE), "[[roles]\n").unwrap();
		assert!(check(&repo).is_err());
		let roles = with_repo(&repo, vec![local("qa", "default")]);
		assert_eq!(roles[0].prompt, "Consigne du poste");

		std::fs::write(dir.join(FILE), "[[roles]]\nid = \"qa\"\nprompt = \"Du dépôt\"\n").unwrap();
		assert!(check(&repo).is_ok());
		assert_eq!(with_repo(&repo, vec![local("qa", "default")])[0].prompt, "Du dépôt");

		std::fs::remove_dir_all(dir).ok();
	}

	#[test]
	fn deux_fois_le_meme_role_ou_un_id_vide_sont_refuses() {
		assert!(parse("[[roles]]\nid = \"qa\"\n[[roles]]\nid = \"qa\"\n").is_err());
		assert!(parse("[[roles]]\nid = \" \"\n").is_err());
	}

	#[test]
	fn sans_depot_on_ne_lit_pas_le_dossier_courant() {
		assert!(declared("").unwrap().is_empty());
	}
}
