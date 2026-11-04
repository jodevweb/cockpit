//! Ce qu'il faut sur le poste avant que le cockpit puisse faire quelque chose.
//!
//! Un cockpit fraîchement installé s'ouvre sur une carte vide, et chacun de
//! ses prérequis manquants se découvrait au premier geste qui en avait besoin
//! — souvent par un message qui ne désignait pas la cause. Sans Node, le pont
//! d'autorisation ne démarre pas et l'agent échoue sur « MCP tool
//! mcp__cockpit__approve ». Sans Git for Windows, rien ne se lance. Sans
//! connexion, le CLI démarre puis refuse de travailler.
//!
//! Ce module pose la question une fois, à l'ouverture, et rend une ligne par
//! prérequis. Rien n'est installé ni réparé ici : on dit ce qui manque et
//! comment le régler, l'installation reste un geste de la personne.

use serde::Serialize;

/// Un prérequis du poste.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
	/// `shell`, `git`, `claude`, `claudeAuth`, `node`, `project`, `container`.
	/// L'interface en tire le libellé et la façon de le régler.
	pub id: String,
	/// Sans lui, le cockpit ne peut pas faire son travail principal : lancer
	/// et suivre des agents sur un dépôt.
	pub required: bool,
	pub ok: bool,
	/// Ce qui a été trouvé (un chemin, un courriel), vide sinon.
	pub detail: String,
}

/// L'état du poste, prêt ou non.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
	pub ready: bool,
	pub checks: Vec<Check>,
}

/// Ce qu'on a relevé sur le poste, avant d'en tirer les lignes.
#[derive(Debug, Clone, Default)]
pub struct Observed {
	/// Sous Windows, le bash de Git for Windows. Toujours vrai ailleurs.
	pub shell: bool,
	pub windows: bool,
	pub git: Option<String>,
	pub claude: Option<String>,
	/// Le courriel d'un compte connecté, s'il y en a un.
	pub logged_in: Option<String>,
	pub node: Option<String>,
	/// Le dépôt principal du projet actif, s'il est déclaré et que c'est un
	/// dépôt git.
	pub project: Option<String>,
	pub container: Option<String>,
}

/// Les lignes, dans l'ordre où l'on règle les choses.
///
/// À part de tout effet pour se vérifier en entier. La connexion n'est pas
/// demandée quand le CLI est absent : on ne dit pas deux fois la même chose.
pub fn assemble(seen: &Observed) -> Readiness {
	let check = |id: &str, required: bool, found: &Option<String>| Check {
		id: id.into(),
		required,
		ok: found.is_some(),
		detail: found.clone().unwrap_or_default(),
	};
	let mut checks = Vec::new();
	if seen.windows {
		checks.push(Check { id: "shell".into(), required: true, ok: seen.shell, detail: String::new() });
	}
	checks.push(check("git", true, &seen.git));
	checks.push(check("claude", true, &seen.claude));
	if seen.claude.is_some() {
		checks.push(check("claudeAuth", true, &seen.logged_in));
	}
	checks.push(check("node", true, &seen.node));
	checks.push(check("project", true, &seen.project));
	checks.push(check("container", false, &seen.container));
	let ready = checks.iter().all(|check| check.ok || !check.required);
	Readiness { ready, checks }
}

/// Relève le poste. Quelques lancements de processus : à appeler à
/// l'ouverture et sur demande, pas en boucle.
pub async fn observe() -> Readiness {
	let config = crate::config::Config::active();
	let repo = config.general.main_repo.trim().to_string();
	let project = (!repo.is_empty() && std::path::Path::new(&repo).join(".git").exists()).then(|| repo.clone());
	let claude = crate::agent::claude_binary();
	let logged_in = if claude.is_some() {
		crate::accounts::status_all(false)
			.await
			.into_iter()
			.find(|account| account.logged_in)
			.map(|account| if account.email.is_empty() { account.label } else { account.email })
	} else {
		None
	};
	let seen = Observed {
		shell: crate::platform::shell_available(),
		windows: cfg!(windows),
		git: crate::platform::locate("git"),
		claude,
		logged_in,
		node: crate::agent::node_binary(),
		project,
		container: crate::sandbox::resolve_runtime(&config.sandbox.runtime),
	};
	assemble(&seen)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn complet() -> Observed {
		Observed {
			shell: true,
			windows: false,
			git: Some("/usr/bin/git".into()),
			claude: Some("/usr/local/bin/claude".into()),
			logged_in: Some("a@b.c".into()),
			node: Some("/usr/local/bin/node".into()),
			project: Some("/code/app".into()),
			container: None,
		}
	}

	#[test]
	fn un_poste_complet_est_pret_sans_conteneur() {
		// L'isolation est facultative : son absence ne retient rien.
		let vue = assemble(&complet());
		assert!(vue.ready);
		let conteneur = vue.checks.iter().find(|check| check.id == "container").unwrap();
		assert!(!conteneur.ok && !conteneur.required);
	}

	#[test]
	fn chaque_prerequis_manquant_retient() {
		for manque in ["git", "claude", "node", "project"] {
			let mut seen = complet();
			match manque {
				"git" => seen.git = None,
				"claude" => seen.claude = None,
				"node" => seen.node = None,
				_ => seen.project = None,
			}
			let vue = assemble(&seen);
			assert!(!vue.ready, "{manque}");
			assert!(vue.checks.iter().any(|check| check.id == manque && !check.ok));
		}
	}

	#[test]
	fn sans_cli_on_ne_demande_pas_la_connexion() {
		let mut seen = complet();
		seen.claude = None;
		seen.logged_in = None;
		let vue = assemble(&seen);
		assert!(!vue.checks.iter().any(|check| check.id == "claudeAuth"));
	}

	#[test]
	fn un_cli_non_connecte_retient() {
		let mut seen = complet();
		seen.logged_in = None;
		assert!(!assemble(&seen).ready);
	}

	#[test]
	fn le_shell_ne_se_demande_que_sous_windows() {
		assert!(!assemble(&complet()).checks.iter().any(|check| check.id == "shell"));
		let mut seen = complet();
		seen.windows = true;
		seen.shell = false;
		let vue = assemble(&seen);
		assert!(!vue.ready);
		assert_eq!(vue.checks[0].id, "shell");
	}
}
