//! Les comptes sous lesquels les agents travaillent.
//!
//! Un compte n'est pas un réglage du cockpit mais une installation de Claude
//! Code : ses jetons, ses conversations, ses préférences vivent dans un dossier
//! que le CLI lit dans `CLAUDE_CONFIG_DIR`. Le cockpit ne fait que désigner
//! lequel — il ne stocke aucun jeton, n'en lit aucun, et ne sait pas s'y
//! connecter à la place de son propriétaire.
//!
//! D'où la forme de cet écran : on ne saisit pas des identifiants, on déclare un
//! dossier et on ouvre un terminal pour que le CLI fasse sa propre connexion. Ce
//! qu'on affiche ensuite — un courriel, un abonnement — est ce que le CLI répond
//! quand on lui demande qui il est, jamais quelque chose que le cockpit aurait
//! retenu.

use crate::config::{self, AccountConfig, Config};
use crate::error::{CockpitError, Result};
use serde::Serialize;
use std::time::{Duration, Instant};

/// Ce qu'un compte répond quand on lui demande qui il est.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
	pub id: String,
	pub label: String,
	/// Dossier tel qu'il est écrit dans la configuration — vide pour le poste.
	pub dir: String,
	/// Dossier réellement lu, tilde résolu. C'est celui-là qu'on affiche : c'est
	/// aussi celui qu'on ira chercher au doigt dans un Finder.
	pub resolved_dir: String,
	pub logged_in: bool,
	pub email: String,
	/// `max`, `pro`, `team`… tel que le CLI le nomme.
	pub plan: String,
	pub organization: String,
	/// Les projets rattachés à ce compte, par leur nom.
	pub projects: Vec<String>,
	/// Ce qui a empêché de répondre, le cas échéant.
	pub error: String,
}

struct Cached {
	at: Instant,
	statuses: Vec<AccountStatus>,
}

fn cache() -> &'static std::sync::Mutex<Option<Cached>> {
	static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<Cached>>> =
		std::sync::OnceLock::new();
	CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// Interroger le CLI coûte un lancement de processus par compte : on garde la
/// réponse le temps qu'un écran s'ouvre et se referme, pas plus. Une connexion
/// faite dans le terminal d'à côté doit se voir sans avoir à redémarrer l'app.
const CACHE_TTL: Duration = Duration::from_secs(20);

/// Qui est qui, un compte déclaré par entrée.
///
/// Les comptes sont interrogés de front : ils ne se connaissent pas entre eux,
/// et attendre trois CLI l'un après l'autre rendrait l'écran lent pour rien.
pub async fn status_all(force: bool) -> Vec<AccountStatus> {
	if !force {
		if let Ok(store) = cache().lock() {
			if let Some(entry) = store.as_ref() {
				if entry.at.elapsed() < CACHE_TTL {
					return entry.statuses.clone();
				}
			}
		}
	}

	let config = Config::load();
	let déclarés = config::accounts(&config);

	// Quels projets travaillent sous quel compte : la question qu'on se pose en
	// ouvrant cet écran est « qui pilote quoi », pas « quels dossiers existent ».
	let rattachements = |id: &str| -> Vec<String> {
		config
			.projects
			.iter()
			.filter(|project| {
				let mut resolved = config.clone();
				project.merge_into(&mut resolved, config.projects.len() > 1);
				config::account_for(&resolved).id == id
			})
			.map(|project| project.display_name())
			.collect()
	};

	let statuses = déclarés.iter().map(|account| {
		let projects = rattachements(&account.id);
		async move { read_status(account, projects).await }
	});
	let statuses: Vec<AccountStatus> = futures::future::join_all(statuses).await;

	if let Ok(mut store) = cache().lock() {
		*store = Some(Cached {
			at: Instant::now(),
			statuses: statuses.clone(),
		});
	}
	statuses
}

/// Demande au CLI qui il est, sous ce dossier de configuration.
async fn read_status(account: &AccountConfig, projects: Vec<String>) -> AccountStatus {
	let dir = config::account_dir(account);
	let mut status = AccountStatus {
		id: account.id.clone(),
		label: account.label.clone(),
		dir: account.dir.clone(),
		resolved_dir: dir.to_string_lossy().to_string(),
		logged_in: false,
		email: String::new(),
		plan: String::new(),
		organization: String::new(),
		projects,
		error: String::new(),
	};

	let Some(binary) = crate::agent::claude_binary() else {
		status.error = "Le CLI `claude` est introuvable sur ce poste.".into();
		return status;
	};

	let mut command = tokio::process::Command::new(&binary);
	command.args(["auth", "status"]);
	// Le compte du poste se lit sans rien poser : lui répéter son propre défaut
	// n'apporte rien, et le jour où le CLI change d'emplacement, le cockpit n'a
	// pas à le savoir.
	if !account.dir.trim().is_empty() {
		command.env("CLAUDE_CONFIG_DIR", &dir);
	}

	// Un CLI qui ne répond pas ne doit pas retenir l'écran : mieux vaut une
	// ligne qui dit « pas de réponse » qu'une fenêtre qui semble figée.
	let sortie = match tokio::time::timeout(Duration::from_secs(20), command.output()).await {
		Ok(Ok(sortie)) => sortie,
		Ok(Err(error)) => {
			status.error = format!("Lancement du CLI : {error}");
			return status;
		}
		Err(_) => {
			status.error = "Le CLI n'a pas répondu.".into();
			return status;
		}
	};

	let texte = String::from_utf8_lossy(&sortie.stdout);
	let Some(json) = texte
		.find('{')
		.and_then(|start| serde_json::from_str::<serde_json::Value>(&texte[start..]).ok())
	else {
		status.error = String::from_utf8_lossy(&sortie.stderr)
			.lines()
			.next()
			.unwrap_or("Réponse du CLI illisible.")
			.to_string();
		return status;
	};

	let field = |key: &str| {
		json.get(key)
			.and_then(|value| value.as_str())
			.unwrap_or_default()
			.to_string()
	};
	status.logged_in = json
		.get("loggedIn")
		.and_then(|value| value.as_bool())
		.unwrap_or(false);
	status.email = field("email");
	status.plan = field("subscriptionType");
	status.organization = field("orgName");
	status
}

/// Enregistre la liste des comptes.
///
/// Commande dédiée plutôt qu'un patch de configuration : c'est ici qu'on crée le
/// dossier d'un compte qu'on vient de déclarer. Sans lui, le premier `claude
/// auth login` échouerait sur un chemin inexistant, et l'erreur rendue parlerait
/// d'un dossier que l'utilisateur n'a jamais tapé.
pub fn save(accounts: Vec<AccountConfig>) -> Result<()> {
	let mut config = Config::load();
	let mut propres = Vec::new();

	for account in accounts {
		let id = account.id.trim().to_string();
		if id.is_empty() || id == config::HOME_ACCOUNT {
			// Le compte du poste n'est pas déclaré : il existe toujours, et
			// l'écrire dans le fichier laisserait croire qu'on peut le supprimer.
			continue;
		}
		if propres.iter().any(|autre: &AccountConfig| autre.id == id) {
			return Err(CockpitError::msg(format!(
				"Deux comptes portent l'identifiant « {id} » : c'est lui qui les distingue.",
			)));
		}
		let dir = account.dir.trim().to_string();
		if dir.is_empty() {
			return Err(CockpitError::msg(format!(
				"Le compte « {id} » n'a pas de dossier : c'est ce qui le sépare des autres.",
			)));
		}

		let chemin = config::account_dir(&AccountConfig {
			id: id.clone(),
			label: account.label.clone(),
			dir: dir.clone(),
		});
		if chemin == config::home_account_dir() {
			return Err(CockpitError::msg(format!(
				"Le compte « {id} » pointe le dossier du poste : les deux ne feraient qu'un.",
			)));
		}
		std::fs::create_dir_all(&chemin).map_err(|error| {
			CockpitError::msg(format!(
				"Création de {} : {error}",
				chemin.to_string_lossy()
			))
		})?;

		propres.push(AccountConfig {
			label: if account.label.trim().is_empty() {
				id.clone()
			} else {
				account.label.trim().to_string()
			},
			id,
			dir,
		});
	}

	// Un projet rattaché à un compte qu'on vient de retirer retombe sur celui du
	// poste, plutôt que de désigner un compte fantôme. `account_for` le ferait de
	// toute façon à la lecture ; l'écrire évite qu'un écran affiche encore le nom
	// d'un compte disparu.
	let connus: Vec<String> = propres.iter().map(|account| account.id.clone()).collect();
	for project in &mut config.projects {
		if !project.account.trim().is_empty() && !connus.contains(&project.account) {
			project.account = String::new();
		}
	}
	if !config.account.trim().is_empty() && !connus.contains(&config.account) {
		config.account = String::new();
	}

	config.accounts = propres;
	config.save().map_err(|error| {
		CockpitError::msg(format!("Enregistrement de la configuration : {error}"))
	})?;
	if let Ok(mut store) = cache().lock() {
		*store = None;
	}
	Ok(())
}

/// Oublie ce que les comptes ont répondu la dernière fois.
///
/// Appelé quand une connexion vient d'être faite dans un terminal : le cockpit
/// n'a aucun moyen de savoir qu'elle a abouti, mais celui qui l'a faite, lui, le
/// sait — et c'est lui qui demande à rafraîchir.
pub fn forget_cache() {
	if let Ok(mut store) = cache().lock() {
		*store = None;
	}
}
