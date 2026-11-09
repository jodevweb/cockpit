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
//!
//! Reste un cas : un rôle qui tourne sur le poste sans rien demander
//! (`bypassPermissions`, le réglage des rôles du catalogue). Le dépôt ne change pas
//! ses droits, mais il peut changer sa consigne, sa commande ou son périmètre, donc
//! orienter un agent qui agit sans accord. Tant que l'utilisateur n'a pas validé le
//! contenu exact du fichier (`trust`), un tel rôle demande l'accord comme un rôle
//! nouveau. Le fichier modifié, sur une autre branche ou par une pull request, doit
//! être validé de nouveau.

use crate::config::RoleConfig;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE: &str = ".cockpit/roles.toml";

/// Ce que prend un rôle apparu par le dépôt, qu'aucun poste n'a encore réglé. Chaque
/// commande demande l'accord de l'utilisateur tant qu'il n'a pas décidé autre chose
/// en déclarant ce rôle chez lui. C'est aussi ce que reprend un rôle à pleins droits
/// que le dépôt oriente sans que son fichier ait été validé.
const NEW_ROLE_PERMISSION: &str = "acceptEdits";

/// Le mode qui ne demande rien.
const FULL_RIGHTS: &str = "bypassPermissions";

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

impl RepoRole {
	/// Le dépôt dit-il à ce rôle quoi faire, ou où ? Le libellé, le modèle et la
	/// profondeur ne l'orientent pas ; `verifies` ne fait que retarder son départ.
	fn steers(&self) -> bool {
		self.prompt.is_some() || self.command.is_some() || self.scope.is_some()
	}
}

/// Le fichier du dépôt, lu, et l'empreinte de son contenu exact.
struct Declared {
	roles: Vec<RepoRole>,
	digest: String,
}

fn declared(repo: &str) -> Result<Declared, String> {
	let none = || Declared {
		roles: Vec::new(),
		digest: String::new(),
	};
	// Un chemin vide viserait le dossier courant de l'application.
	if repo.trim().is_empty() {
		return Ok(none());
	}
	let raw = match std::fs::read_to_string(Path::new(repo).join(FILE)) {
		Ok(raw) => raw,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(none()),
		Err(error) => return Err(error.to_string()),
	};
	Ok(Declared {
		roles: parse(&raw)?,
		digest: digest(&raw),
	})
}

/// Les fins de ligne n'y comptent pas : le même fichier sort en CRLF d'un clone
/// Windows et en LF ailleurs, et l'un ne doit pas défaire la validation de l'autre.
fn digest(raw: &str) -> String {
	let hash = Sha256::digest(raw.replace("\r\n", "\n").as_bytes());
	hash.iter().map(|byte| format!("{byte:02x}")).collect()
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

/// Les rôles du poste qui agissent sans accord et que le dépôt oriente.
fn restricted(local: &[RoleConfig], declared: &[RepoRole]) -> Vec<String> {
	declared
		.iter()
		.filter(|repo_role| repo_role.steers())
		.filter(|repo_role| {
			local
				.iter()
				.any(|role| role.id == repo_role.id && role.permission_mode == FULL_RIGHTS)
		})
		.map(|repo_role| repo_role.id.clone())
		.collect()
}

/// Pose les rôles du dépôt sur ceux du poste, sans en retirer aucun.
///
/// `trusted` : l'utilisateur a validé ce fichier-là. Sinon, un rôle à pleins droits
/// que le dépôt oriente redemande l'accord.
fn overlay(mut roles: Vec<RoleConfig>, declared: Vec<RepoRole>, trusted: bool) -> Vec<RoleConfig> {
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
		if !trusted && repo_role.steers() && role.permission_mode == FULL_RIGHTS {
			role.permission_mode = NEW_ROLE_PERMISSION.to_string();
		}
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

/// Les fichiers validés, par dépôt : l'empreinte du contenu accepté.
fn trust_file() -> PathBuf {
	crate::config::config_dir().join("trusted-roles.json")
}

fn trusted_digests(file: &Path) -> BTreeMap<String, String> {
	std::fs::read_to_string(file)
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

fn is_trusted_in(file: &Path, repo: &str, digest: &str) -> bool {
	!digest.is_empty()
		&& trusted_digests(file)
			.get(&crate::platform::path_key(repo))
			.map(String::as_str)
			== Some(digest)
}

fn trust_in(file: &Path, repo: &str) -> Result<(), String> {
	let found = declared(repo)?;
	if found.digest.is_empty() {
		return Err(format!("{FILE} not found"));
	}
	let mut digests = trusted_digests(file);
	digests.insert(crate::platform::path_key(repo), found.digest);
	if let Some(parent) = file.parent() {
		std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
	}
	let raw = serde_json::to_string_pretty(&digests).map_err(|error| error.to_string())?;
	std::fs::write(file, raw).map_err(|error| error.to_string())
}

/// Valide le fichier du dépôt tel qu'il est maintenant.
pub fn trust(repo: &str) -> Result<(), String> {
	trust_in(&trust_file(), repo)
}

/// Les rôles du poste, complétés par ceux du dépôt.
///
/// Un fichier illisible n'en retire rien : cet appel sert aussi aux missions en cours,
/// qu'une faute de frappe sur une branche ne doit pas arrêter. C'est `check`, au
/// lancement du maître, qui la signale.
pub fn with_repo(repo: &str, local: Vec<RoleConfig>) -> Vec<RoleConfig> {
	match declared(repo) {
		Ok(found) => {
			let trusted = is_trusted_in(&trust_file(), repo, &found.digest);
			overlay(local, found.roles, trusted)
		}
		Err(_) => local,
	}
}

/// Ce que les réglages disent du fichier : sans ça, un rôle y change de consigne sans
/// que rien, sur l'écran où on le règle, n'explique pourquoi.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRoles {
	pub file: String,
	/// Les rôles que le dépôt déclare ; vide sans fichier.
	pub ids: Vec<String>,
	pub error: Option<String>,
	/// Les rôles à pleins droits que le dépôt oriente : ceux qui redemandent l'accord
	/// tant que le fichier n'est pas validé.
	pub restricted: Vec<String>,
	/// L'utilisateur a validé le fichier tel qu'il est.
	pub trusted: bool,
}

pub fn summary(repo: &str, local: &[RoleConfig]) -> RepoRoles {
	summary_in(&trust_file(), repo, local)
}

fn summary_in(file: &Path, repo: &str, local: &[RoleConfig]) -> RepoRoles {
	let (ids, error, restricted, trusted) = match declared(repo) {
		Ok(found) => (
			found.roles.iter().map(|role| role.id.clone()).collect(),
			None,
			restricted(local, &found.roles),
			is_trusted_in(file, repo, &found.digest),
		),
		Err(error) => (Vec::new(), Some(error), Vec::new(), false),
	};
	RepoRoles {
		file: FILE.to_string(),
		ids,
		error,
		restricted,
		trusted,
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

	/// Un dépôt jetable et son propre fichier de confiance, hors du vrai poste.
	fn sandbox(name: &str) -> (PathBuf, String, PathBuf) {
		let dir = std::env::temp_dir().join(format!("cockpit-roles-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(dir.join(".cockpit")).unwrap();
		let repo = dir.to_string_lossy().to_string();
		let trust = dir.join("trusted.json");
		(dir, repo, trust)
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
		for trusted in [false, true] {
			let roles = overlay(
				Vec::new(),
				parse("[[roles]]\nid = \"data\"\nprompt = \"p\"\n").unwrap(),
				trusted,
			);
			assert_eq!(roles[0].id, "data");
			assert_eq!(roles[0].label, "data");
			assert_eq!(roles[0].permission_mode, "acceptEdits");
		}
	}

	#[test]
	fn un_role_connu_garde_ses_droits_et_son_moteur() {
		let raw = "[[roles]]\nid = \"qa\"\nprompt = \"Du dépôt\"\nverifies = true\nscope = [\"tests/**\"]\n";
		let roles = overlay(
			vec![local("qa", "acceptEdits"), local("autre", "default")],
			parse(raw).unwrap(),
			false,
		);
		assert_eq!(roles.len(), 2, "aucun rôle du poste ne disparaît");
		assert_eq!(roles[0].prompt, "Du dépôt");
		assert!(roles[0].verifies);
		assert_eq!(roles[0].scope, vec!["tests/**".to_string()]);
		assert_eq!(roles[0].permission_mode, "acceptEdits");
		assert_eq!(roles[0].engine, "codex");
		assert_eq!(roles[0].label, "Du poste", "un champ absent ne change rien");
		assert_eq!(roles[1].prompt, "Consigne du poste");
	}

	#[test]
	fn un_role_a_pleins_droits_oriente_par_le_depot_demande_l_accord_tant_que_rien_n_est_valide() {
		for champ in ["prompt = \"x\"", "command = \"/x\"", "scope = [\"**\"]"] {
			let raw = format!("[[roles]]\nid = \"backend\"\n{champ}\n");
			let roles = overlay(vec![local("backend", FULL_RIGHTS)], parse(&raw).unwrap(), false);
			assert_eq!(roles[0].permission_mode, "acceptEdits", "{champ}");
			let roles = overlay(vec![local("backend", FULL_RIGHTS)], parse(&raw).unwrap(), true);
			assert_eq!(roles[0].permission_mode, FULL_RIGHTS, "validé : {champ}");
		}
		// Ce qui n'oriente pas l'agent ne lui retire pas ses droits.
		let raw = "[[roles]]\nid = \"backend\"\nlabel = \"Back\"\nmodel = \"m\"\ndepth = \"deep\"\nverifies = false\n";
		let roles = overlay(vec![local("backend", FULL_RIGHTS)], parse(raw).unwrap(), false);
		assert_eq!(roles[0].permission_mode, FULL_RIGHTS);
	}

	#[test]
	fn la_validation_tient_au_contenu_exact_du_fichier() {
		let (dir, repo, trust) = sandbox("confiance");
		let poste = vec![local("backend", FULL_RIGHTS), local("qa", "default")];

		std::fs::write(
			dir.join(FILE),
			"[[roles]]\nid = \"backend\"\nprompt = \"a\"\n[[roles]]\nid = \"qa\"\nprompt = \"b\"\n",
		)
		.unwrap();
		let avant = summary_in(&trust, &repo, &poste);
		assert_eq!(
			avant.restricted,
			vec!["backend".to_string()],
			"qa demande déjà l'accord"
		);
		assert!(!avant.trusted);

		trust_in(&trust, &repo).unwrap();
		assert!(summary_in(&trust, &repo, &poste).trusted);

		// Les fins de ligne ne défont pas la validation.
		std::fs::write(
			dir.join(FILE),
			"[[roles]]\r\nid = \"backend\"\r\nprompt = \"a\"\r\n[[roles]]\r\nid = \"qa\"\r\nprompt = \"b\"\r\n",
		)
		.unwrap();
		assert!(summary_in(&trust, &repo, &poste).trusted);

		// Une consigne changée, si.
		std::fs::write(
			dir.join(FILE),
			"[[roles]]\nid = \"backend\"\nprompt = \"autre chose\"\n",
		)
		.unwrap();
		assert!(!summary_in(&trust, &repo, &poste).trusted);

		std::fs::remove_dir_all(dir).ok();
	}

	#[test]
	fn rien_a_valider_sans_fichier() {
		let (dir, repo, trust) = sandbox("sans-fichier");
		assert!(trust_in(&trust, &repo).is_err());
		assert!(!summary_in(&trust, &repo, &[]).trusted);
		std::fs::remove_dir_all(dir).ok();
	}

	#[test]
	fn un_fichier_faux_est_signale_sans_retirer_les_roles_du_poste() {
		let (dir, repo, _) = sandbox("faux");

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
	fn le_resume_nomme_les_roles_ou_l_erreur() {
		let (dir, repo, trust) = sandbox("resume");
		assert_eq!(summary_in(&trust, "", &[]).ids, Vec::<String>::new());
		assert_eq!(summary_in(&trust, "", &[]).error, None);

		std::fs::write(dir.join(FILE), "[[roles]]\nid = \"qa\"\n[[roles]]\nid = \"data\"\n").unwrap();
		assert_eq!(
			summary_in(&trust, &repo, &[]).ids,
			vec!["qa".to_string(), "data".to_string()]
		);

		std::fs::write(dir.join(FILE), "[[roles]]\nid = \"qa\"\nengine = \"x\"\n").unwrap();
		let faux = summary_in(&trust, &repo, &[]);
		assert!(faux.ids.is_empty());
		assert!(faux.error.unwrap().contains("engine"));

		std::fs::remove_dir_all(dir).ok();
	}

	#[test]
	fn deux_fois_le_meme_role_ou_un_id_vide_sont_refuses() {
		assert!(parse("[[roles]]\nid = \"qa\"\n[[roles]]\nid = \"qa\"\n").is_err());
		assert!(parse("[[roles]]\nid = \" \"\n").is_err());
	}

	#[test]
	fn sans_depot_on_ne_lit_pas_le_dossier_courant() {
		assert!(declared("").unwrap().roles.is_empty());
	}
}
