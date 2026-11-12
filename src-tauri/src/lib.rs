pub mod accounts;
pub mod agent;
pub mod brief;
pub mod browser;
pub mod chantier;
pub mod codex;
pub mod commands;
pub mod config;
pub mod delivery;
pub mod docs;
pub mod error;
pub mod executions;
pub mod files;
pub mod gates;
pub mod gemini;
pub mod git;
pub mod guard;
pub mod i18n;
pub mod impact;
pub mod integrations;
pub mod journal;
pub mod libre;
pub mod mcp;
pub mod methods;
pub mod metrics;
pub mod mission;
mod mission_commands;
pub mod mission_events;
pub mod platform;
use mission_commands::*;
mod watchers;
use watchers::*;
pub mod monitor;
pub mod notebook;
pub mod orchestrator;
pub mod panel;
pub mod permanence;
pub mod permissions;
pub mod prompts;
pub mod proof;
pub mod properties;
pub mod protocol;
pub mod pulls;
pub mod qa;
pub mod readiness;
pub mod relay;
pub mod remote;
pub mod replay;
pub mod resources;
pub mod review;
mod roles;
pub mod runner;
pub mod sandbox;
pub mod sessions;
pub mod slash;
pub mod speech;
pub mod strays;
pub mod system;
pub mod tasks;
pub mod terminal;
pub mod tickets;
pub mod tour;
pub mod usage;
pub mod voice_input;

use config::{Config, ConfigView};
use error::{CockpitError, Result};
use runner::{JobRegistry, JobRequest, JobStatus, SharedJobs};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Config rechargée à chaque commande : le fichier peut être édité à la main
/// pendant que l'app tourne, et on veut que ça prenne effet sans redémarrage.
///
/// Résolue pour le projet actif — c'est ce que les écrans doivent voir. Tout ce
/// qui **écrit** la configuration passe par `Config::load()` : partir d'une
/// config résolue recopierait les réglages du projet actif dans les champs
/// globaux dès la première sauvegarde.
fn cfg() -> Config {
	Config::active()
}

// ───────────────────────────── Configuration ─────────────────────────────

/// Ce qui est branché sur ce projet, et ce qui manque.
#[tauri::command(async)]
fn connectors_list() -> Vec<config::Connector> {
	let mut list = cfg().connectors();

	// Les outils du poste comptent autant que les clés d'API : un écran qui
	// dépend de Docker ou du CLI `claude` est aussi vide sans eux qu'un écran
	// Sentry sans jeton. Les déclarer ici permet à l'interface de masquer ce qui
	// ne peut pas répondre, au lieu de laisser cliquer vers une erreur.
	//
	// C'est aussi ce qui manquait pour voir qu'un poste n'avait pas Node : le
	// symptôme n'apparaissait qu'au lancement d'un agent, sous la forme d'un outil
	// MCP introuvable.
	let local = |id: &str, label: &str, kind: &str, found: bool, missing: &str| config::Connector {
		id: id.into(),
		label: label.into(),
		kind: kind.into(),
		configured: found,
		missing: if found { String::new() } else { missing.into() },
	};

	list.push(local(
		"claude",
		"CLI Claude Code",
		"agents",
		agent::claude_binary().is_some(),
		&i18n::t("lib.connectorMissing.claude"),
	));
	list.push(local(
		"node",
		"Node",
		"orchestration",
		agent::node_binary().is_some(),
		&i18n::t("lib.connectorMissing.node"),
	));
	list.push(local(
		"docker",
		"Docker",
		"containers",
		system::has_docker(),
		&i18n::t("lib.connectorMissing.docker"),
	));
	list
}

#[tauri::command]
fn config_get() -> ConfigView {
	cfg().view()
}

/// Fusion récursive d'un patch JSON dans la config existante : le front n'envoie
/// que les champs modifiés, jamais l'objet complet (qui ne contient pas les
/// secrets, puisqu'ils ne descendent pas dans le webview).
fn merge(target: &mut Value, patch: &Value) {
	match (target, patch) {
		(Value::Object(target), Value::Object(patch)) => {
			for (key, value) in patch {
				merge(target.entry(key.clone()).or_insert(Value::Null), value);
			}
		}
		(target, patch) => *target = patch.clone(),
	}
}

#[tauri::command]
fn config_update(patch: Value) -> Result<ConfigView> {
	// Config brute : un patch appliqué sur la version résolue graverait les
	// réglages du projet actif dans les champs globaux.
	let current = Config::load();
	let mut as_json = serde_json::to_value(&current)
		.map_err(|e| CockpitError::msg(i18n::tf("lib.config.serialize", &[("error", &e)])))?;
	merge(&mut as_json, &patch);

	let updated: Config = serde_json::from_value(as_json)
		.map_err(|e| CockpitError::msg(i18n::tf("lib.config.invalid", &[("error", &e)])))?;
	updated.save()?;
	Ok(updated.view())
}

// ────────────────────────────── Comptes ──────────────────────────────

/// Qui est qui : un compte déclaré par entrée, tel que le CLI le décrit.
#[tauri::command]
async fn accounts_status(force: Option<bool>) -> Vec<accounts::AccountStatus> {
	accounts::status_all(force.unwrap_or(false)).await
}

/// Enregistre les comptes, dossiers créés au passage.
#[tauri::command]
fn accounts_save(entries: Vec<config::AccountConfig>) -> Result<ConfigView> {
	accounts::save(entries)?;
	Ok(cfg().view())
}

/// Oublie ce que les comptes ont répondu — après une connexion, typiquement.
#[tauri::command]
fn accounts_refresh() {
	accounts::forget_cache();
}

/// Ajoute ou met à jour un environnement Trigger.dev.
///
/// Commande dédiée plutôt qu'un patch de configuration : les jetons ne
/// redescendant jamais dans le webview, celui-ci ne peut pas renvoyer la liste
/// complète sans les effacer. Un `token` absent ou vide conserve donc l'existant.
#[tauri::command]
fn trigger_env_save(name: String, token: Option<String>, project_ref: Option<String>) -> Result<ConfigView> {
	let name = name.trim().to_string();
	if name.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.trigger.envNameRequired")));
	}

	let mut config = Config::load();
	let token = token.unwrap_or_default().trim().to_string();
	let project_ref = project_ref.unwrap_or_default().trim().to_string();

	match config.trigger.environments.iter_mut().find(|env| env.name == name) {
		Some(existing) => {
			if !token.is_empty() {
				existing.token = token;
			}
			existing.project_ref = project_ref;
		}
		None => {
			if token.is_empty() {
				return Err(CockpitError::msg(i18n::t("lib.trigger.envKeyRequired")));
			}
			config.trigger.environments.push(config::TriggerEnvironment {
				name,
				token,
				project_ref,
			});
		}
	}

	config.save()?;
	Ok(config.view())
}

#[tauri::command]
fn trigger_env_remove(name: String) -> Result<ConfigView> {
	let mut config = Config::load();
	config.trigger.environments.retain(|env| env.name != name);
	config.save()?;
	Ok(config.view())
}

// ────────────────────────────── Tâches personnelles ──────────────────────────────

/// Les tâches suivent le projet actif : deux contextes, deux listes.
fn task_scope() -> String {
	let config = Config::load();
	if config.active_project.trim().is_empty() {
		"principal".into()
	} else {
		config.active_project
	}
}

#[tauri::command(async)]
fn tasks_list() -> Vec<tasks::Task> {
	tasks::list(&task_scope())
}

#[tauri::command]
fn task_add(text: String, priority: Option<String>) -> Result<Vec<tasks::Task>> {
	tasks::add(&task_scope(), &text, &priority.unwrap_or_else(|| "normal".into()))
}

#[tauri::command]
fn task_toggle(id: String) -> Result<Vec<tasks::Task>> {
	tasks::toggle(&task_scope(), &id)
}

#[tauri::command]
fn task_remove(id: String) -> Result<Vec<tasks::Task>> {
	tasks::remove(&task_scope(), &id)
}

#[tauri::command]
fn tasks_clear_done() -> Result<Vec<tasks::Task>> {
	tasks::clear_done(&task_scope())
}

// ────────────────────────────── Projets ──────────────────────────────

/// Bascule le projet courant.
///
/// Les écrans se rechargent d'eux-mêmes : la mémoire courte des appels SaaS est
/// vidée au passage, sans quoi on lirait pendant une minute les PR du projet
/// qu'on vient de quitter.
#[tauri::command]
fn project_activate(id: String) -> Result<ConfigView> {
	let mut config = Config::load();
	if !config.projects.iter().any(|project| project.id == id) {
		return Err(CockpitError::msg(i18n::tf("lib.project.unknown", &[("id", &id)])));
	}
	config.active_project = id;
	config.save()?;
	integrations::clear_get_cache();
	Ok(Config::active().view())
}

/// Applique un patch aux réglages du projet actif.
///
/// Même forme de patch que `config_update` : les sections d'un projet portent
/// les mêmes noms que les sections globales, si bien que l'écran Réglages écrit
/// dans l'un ou dans l'autre sans rien changer à ce qu'il envoie. Un champ vidé
/// redevient hérité.
#[tauri::command]
fn project_update(patch: Value, project: Option<String>) -> Result<ConfigView> {
	let mut config = Config::load();
	// `project` vise un projet nommé ; sans lui, c'est l'actif qu'on modifie.
	// Une correction proposée depuis un écran porte sur le projet qu'elle
	// concerne, qui n'est pas forcément celui qu'on regarde.
	let cible = project
		.map(|id| id.trim().to_string())
		.filter(|id| !id.is_empty())
		.unwrap_or_else(|| config.active_project.clone());
	let index = config
		.projects
		.iter()
		.position(|project| project.id == cible)
		.ok_or_else(|| CockpitError::msg(i18n::tf("lib.project.notFound", &[("id", &cible)])))?;

	let mut as_json = serde_json::to_value(&config.projects[index])
		.map_err(|e| CockpitError::msg(i18n::tf("lib.project.serialize", &[("error", &e)])))?;
	merge(&mut as_json, &patch);
	config.projects[index] = serde_json::from_value(as_json)
		.map_err(|e| CockpitError::msg(i18n::tf("lib.project.invalid", &[("error", &e)])))?;

	config.save()?;
	integrations::clear_get_cache();
	Ok(Config::active().view())
}

/// Un mot passé au shell sans qu'il puisse en sortir.
fn quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// Ce que le cockpit trouve à un emplacement, avant d'en faire un projet.
///
/// Rendu à l'écran tel quel : ouvrir un projet demande un dossier, un dépôt
/// git et parfois une forge, et il vaut mieux dire lesquels manquent que de
/// refuser en bloc. Un « ce n'est pas un dépôt git » n'apprend pas quoi faire.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Ground {
	/// Le chemin tel que le cockpit l'a compris — tilde développé, nom seul
	/// résolu sous le dossier des projets.
	path: String,
	exists: bool,
	is_repo: bool,
	/// Vrai si le dossier existe et contient déjà quelque chose.
	occupied: bool,
	/// L'adresse du serveur `origin`, quand il y en a un.
	remote: String,
	/// `propriétaire/dépôt` déduit du serveur, prêt à être repris.
	slug: String,
	/// Les comptes GitHub dont une session `gh` existe sur ce poste.
	accounts: Vec<String>,
}

#[tauri::command]
async fn project_inspect(path: String) -> Ground {
	let config = Config::load();
	let path = config::resolve_path(&path, &config.general.projects_root);
	let folder = Path::new(&path);
	let exists = folder.is_dir();
	let is_repo = exists && folder.join(".git").exists();

	let remote = if is_repo {
		git::run_git(folder, &["remote", "get-url", "origin"])
			.await
			.unwrap_or_default()
			.trim()
			.to_string()
	} else {
		String::new()
	};

	Ground {
		occupied: exists
			&& std::fs::read_dir(folder)
				.map(|mut entries| entries.next().is_some())
				.unwrap_or(false),
		slug: git::slug_from_remote(&remote),
		exists,
		is_repo,
		remote,
		accounts: gh_accounts().await,
		path,
	}
}

/// Les comptes GitHub déjà authentifiés sur ce poste.
///
/// Demandés à `gh` plutôt que saisis : un dépôt hébergé sous un autre compte
/// est le cas normal dès qu'on mélange travail et projets personnels, et faire
/// retaper un identifiant qu'on connaît déjà est une occasion de se tromper.
async fn gh_accounts() -> Vec<String> {
	let raw = runner::capture("/", "gh auth status 2>&1").await.unwrap_or_default();
	let mut accounts = Vec::new();
	for line in raw.lines() {
		if let Some(rest) = line.split("account ").nth(1) {
			if let Some(name) = rest.split_whitespace().next() {
				let name = name.trim();
				if !name.is_empty() && !accounts.iter().any(|entry| entry == name) {
					accounts.push(name.to_string());
				}
			}
		}
	}
	accounts
}

/// Ce qu'on demande au cockpit de préparer avant d'ouvrir un projet.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Groundwork {
	path: String,
	/// Créer le dossier s'il n'existe pas.
	#[serde(default)]
	create_dir: bool,
	/// `git init` si le dossier n'est pas encore un dépôt.
	#[serde(default)]
	git_init: bool,
	/// Créer le dépôt sur GitHub et le poser en `origin`.
	#[serde(default)]
	create_remote: bool,
	/// Compte sous lequel le créer. Vide = le compte actif de `gh`.
	#[serde(default)]
	account: String,
	/// `propriétaire/dépôt`, ou juste le nom.
	#[serde(default)]
	repo: String,
	/// **Privé par défaut** : un dépôt public créé par inadvertance ne se
	/// dé-publie pas, et personne ne demande « rends ce code visible » sans le
	/// dire explicitement.
	#[serde(default)]
	public: bool,
}

/// Prépare le terrain : dossier, dépôt local, dépôt distant.
///
/// Chaque geste est demandé explicitement — le cockpit ne devine pas qu'il faut
/// créer un dépôt sur une forge parce qu'un dossier était vide. Il ne pousse
/// rien non plus : poser le serveur suffit, le premier `push` reste un geste.
#[tauri::command]
async fn project_prepare(request: Groundwork) -> Result<Ground> {
	let config = Config::load();
	let path = config::resolve_path(&request.path, &config.general.projects_root);
	if path.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.project.folderRequired")));
	}
	let folder = Path::new(&path);

	if request.create_dir && !folder.is_dir() {
		std::fs::create_dir_all(folder)
			.map_err(|error| CockpitError::msg(i18n::tf("lib.project.createDir", &[("error", &error)])))?;
		journal::record("projet", &i18n::t("lib.project.dirCreated"), &path, true, "");
	}
	if !folder.is_dir() {
		return Err(CockpitError::msg(i18n::tf(
			"lib.project.pathMissing",
			&[("path", &path)],
		)));
	}

	if request.git_init && !folder.join(".git").exists() {
		git::run_git(folder, &["init"]).await?;
		journal::record("projet", &i18n::t("lib.project.gitInitialized"), &path, true, "");
	}

	if request.create_remote {
		let repo = request.repo.trim();
		if repo.is_empty() {
			return Err(CockpitError::msg(i18n::t("lib.project.repoNameRequired")));
		}
		if !folder.join(".git").exists() {
			return Err(CockpitError::msg(i18n::t("lib.project.localRepoRequired")));
		}
		create_remote(folder, repo, &request.account, request.public).await?;
	}

	Ok(project_inspect(path).await)
}

/// Crée le dépôt sur GitHub et le pose en `origin`.
async fn create_remote(folder: &Path, repo: &str, account: &str, public: bool) -> Result<()> {
	// Le jeton du compte demandé, emprunté le temps de l'appel — jamais
	// `gh auth switch`, qui laisserait le poste entier sous une autre identité
	// si quelque chose s'interrompait.
	let account = account.trim();
	let token = if account.is_empty() {
		runner::capture("/", "gh auth token 2>/dev/null").await
	} else {
		runner::capture("/", &format!("gh auth token --user {} 2>/dev/null", quote(account))).await
	}
	.map_err(|_| CockpitError::msg(i18n::t("lib.project.noGhSession")))?;
	let token = token.trim().to_string();
	if token.is_empty() {
		return Err(CockpitError::msg(i18n::tf(
			"lib.project.noGhToken",
			&[("account", &account)],
		)));
	}

	let visibility = if public { "--public" } else { "--private" };
	let command = format!(
		"gh repo create {} {} --source=. --remote=origin",
		quote(repo),
		visibility
	);
	// Le jeton par l'environnement, jamais par la ligne de commande : celle-ci
	// est lisible dans `ps` par tout processus du poste, et se retrouve dans
	// l'historique du shell.
	let out = runner::capture_with_env(&folder.to_string_lossy(), &command, &[("GH_TOKEN", token.as_str())]).await?;
	journal::record(
		"projet",
		&if public {
			i18n::t("lib.project.publicRepoCreated")
		} else {
			i18n::t("lib.project.privateRepoCreated")
		},
		repo,
		true,
		out.lines().next().unwrap_or_default(),
	);
	Ok(())
}

/// Crée ou met à jour un projet. L'identifiant est dérivé du nom à la création.
#[tauri::command]
fn project_save(project: config::ProjectConfig) -> Result<ConfigView> {
	let mut config = Config::load();

	let name = project.name.trim().to_string();
	let main_repo = config::resolve_path(&project.main_repo, &config.general.projects_root);
	if main_repo.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.project.mainRepoRequired")));
	}
	if !Path::new(&main_repo).join(".git").exists() {
		return Err(CockpitError::msg(i18n::tf(
			"lib.project.notGitRepo",
			&[("path", &main_repo)],
		)));
	}

	let id = if project.id.trim().is_empty() {
		slug(if name.is_empty() { &main_repo } else { &name })
	} else {
		project.id.trim().to_string()
	};
	let saved = config::ProjectConfig {
		id: id.clone(),
		name,
		main_repo,
		..project
	};

	config.upsert_project(saved);
	config.save()?;
	Ok(Config::active().view())
}

#[tauri::command]
fn project_remove(id: String) -> Result<ConfigView> {
	let mut config = Config::load();
	if config.projects.len() <= 1 {
		return Err(CockpitError::msg(i18n::t("lib.project.keepOne")));
	}
	config.projects.retain(|project| project.id != id);
	if config.active_project == id {
		config.active_project = config.projects[0].id.clone();
	}
	config.save()?;
	integrations::clear_get_cache();
	Ok(Config::active().view())
}

/// Identifiant lisible tiré d'un nom libre : `Mon Projet !` → `mon-projet`.
fn slug(value: &str) -> String {
	let cleaned: String = value
		.trim()
		.to_lowercase()
		.chars()
		.map(|c| if c.is_alphanumeric() { c } else { '-' })
		.collect();
	let slug = cleaned
		.split('-')
		.filter(|part| !part.is_empty())
		.collect::<Vec<_>>()
		.join("-");
	if slug.is_empty() {
		"projet".into()
	} else {
		slug
	}
}

/// Vide la mémoire courte des appels SaaS : un clic sur « rafraîchir » doit
/// repartir des services, pas relire la réponse d'il y a trente secondes.
#[tauri::command]
fn feeds_invalidate() {
	integrations::clear_get_cache();
}

#[tauri::command]
fn config_file_path() -> String {
	config::config_path().to_string_lossy().to_string()
}

// ──────────────────────────────── Git ────────────────────────────────

/// Dépôt principal, validé une fois pour toutes les commandes git.
fn main_repo() -> Result<PathBuf> {
	let repo = PathBuf::from(&cfg().general.main_repo);
	if !repo.join(".git").exists() {
		return Err(CockpitError::msg(i18n::tf(
			"lib.git.mainRepoInvalid",
			&[("path", &repo.display())],
		)));
	}
	Ok(repo)
}

#[tauri::command]
async fn worktrees_list() -> Result<Vec<git::Worktree>> {
	git::list_worktrees(&main_repo()?).await
}

/// Le dépôt d'origine de chaque dossier, pour savoir à quel projet il appartient.
///
/// Un workspace n'est qu'un dossier avec des agents dedans : rien n'y dit de
/// quel projet il relève, et l'écran les montrait donc tous, quel que soit le
/// projet affiché. Un worktree, lui, sait d'où il vient — son `.git` pointe
/// vers le dépôt qui l'a créé. Rend une entrée vide pour ce qui n'est pas un
/// dépôt : on ne masque pas ce qu'on ne sait pas classer.
#[tauri::command]
async fn repos_of(paths: Vec<String>) -> std::collections::HashMap<String, String> {
	use std::sync::Mutex;
	// Un dossier ne change pas de dépôt : ce qu'on a résolu une fois vaut pour
	// toute la session, et l'écran interroge cette table à chaque rendu.
	static CACHE: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

	let mut resolus = std::collections::HashMap::new();
	let mut a_resoudre = Vec::new();
	{
		let cache = CACHE.lock().ok();
		let connu = cache.as_ref().and_then(|c| c.as_ref());
		for path in &paths {
			match connu.and_then(|c| c.get(path)) {
				Some(repo) => {
					resolus.insert(path.clone(), repo.clone());
				}
				None => a_resoudre.push(path.clone()),
			}
		}
	}

	for path in a_resoudre {
		let dossier = std::path::Path::new(&path);
		// `--git-common-dir` rend le `.git` partagé : celui du dépôt principal,
		// même appelé depuis un worktree qui n'a qu'un fichier `.git`.
		let repo = match git::run_git(dossier, &["rev-parse", "--git-common-dir"]).await {
			Ok(sortie) => {
				let brut = sortie.trim();
				let commun = if std::path::Path::new(brut).is_absolute() {
					std::path::PathBuf::from(brut)
				} else {
					dossier.join(brut)
				};
				commun
					.parent()
					.and_then(|p| p.canonicalize().ok())
					// Sous la forme de `config.mainRepo` : l'écran Workspaces compare
					// les deux tels quels, et `\\?\D:\…` contre `D:/…` y masquait,
					// sous Windows, tous les workspaces d'un projet déclaré.
					.map(|p| crate::platform::plain_path(&p.to_string_lossy()))
					.unwrap_or_default()
			}
			Err(_) => String::new(),
		};
		if let Ok(mut cache) = CACHE.lock() {
			cache
				.get_or_insert_with(Default::default)
				.insert(path.clone(), repo.clone());
		}
		resolus.insert(path, repo);
	}

	resolus
}

#[tauri::command]
async fn git_branches(base: Option<String>, include_remote: Option<bool>) -> Result<git::BranchOverview> {
	let repo = main_repo()?;
	let base = match base.filter(|b| !b.trim().is_empty()) {
		Some(base) => base,
		None => git::default_branch(&repo).await,
	};
	// Les avances et retards se mesurent contre la base à jour ; le nom rendu
	// reste celui qu'on affiche et qu'on réutilise.
	let compared = git::freshest(&repo, &base).await;
	Ok(git::BranchOverview {
		branches: git::list_branches(&repo, &compared, include_remote.unwrap_or(false)).await?,
		base,
	})
}

#[tauri::command]
async fn git_branch_diff(branch: String, base: String) -> Result<git::BranchDiff> {
	git::branch_diff(&main_repo()?, &branch, &base).await
}

#[tauri::command]
async fn git_branch_file_diff(branch: String, base: String, file: String) -> Result<String> {
	git::branch_file_diff(&main_repo()?, &branch, &base, &file).await
}

/// Opérations d'écriture sur un dépôt, toujours dans un dossier explicite :
/// on n'agit jamais sur « la branche courante » d'un dépôt qu'on n'a pas visé,
/// et jamais par un checkout implicite qui déplacerait le travail d'un agent.
#[tauri::command]
async fn git_fetch(path: String) -> Result<String> {
	git::fetch(std::path::Path::new(&path)).await
}

/// Consigne le résultat d'une écriture, puis le rend tel quel à l'appelant.
fn logged<T>(kind: &str, label: &str, target: &str, outcome: Result<T>) -> Result<T> {
	match &outcome {
		Ok(_) => journal::record(kind, label, target, true, ""),
		Err(error) => journal::record(kind, label, target, false, &error.to_string()),
	}
	outcome
}

#[tauri::command]
async fn git_pull(path: String) -> Result<String> {
	let result = git::pull(std::path::Path::new(&path)).await;
	logged("git", "Pull", &path, result)
}

/// Le raccourci de l'assistant vocal, et ce qu'il fait à l'appui et au relâché.
///
/// La page n'apprend que l'état (« j'écoute », « je transcris », ce qui a été
/// entendu) : le micro et Scribe vivent ici, pour marcher cockpit en
/// arrière-plan.
/// Enregistre le raccourci de l'assistant, et retient s'il a pris.
fn register_talk(app: &AppHandle, accelerator: &str) -> voice_input::ShortcutStatus {
	use std::str::FromStr;
	use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
	let status = match Shortcut::from_str(accelerator) {
		Err(error) => voice_input::ShortcutStatus {
			accelerator: accelerator.to_string(),
			registered: false,
			error: Some(i18n::tf("lib.shortcut.unreadable", &[("error", &error)])),
		},
		Ok(shortcut) => match app.global_shortcut().register(shortcut) {
			Ok(()) => voice_input::ShortcutStatus {
				accelerator: accelerator.to_string(),
				registered: true,
				error: None,
			},
			Err(error) => voice_input::ShortcutStatus {
				accelerator: accelerator.to_string(),
				registered: false,
				error: Some(i18n::tf("lib.shortcut.taken", &[("error", &error)])),
			},
		},
	};
	voice_input::set_shortcut_status(status.clone());
	status
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
	name: String,
	path: String,
}

/// Les dossiers du répertoire de projets, un seul niveau.
///
/// Pour lancer un agent « dans le dossier X » : l'assistant ne connaissait que
/// les worktrees, et un dépôt cloné à côté, un prototype, un dossier de notes
/// lui restaient invisibles. Un niveau suffit — descendre plus bas n'ajoute
/// que `src`, `apps` et `node_modules`. Sans répertoire réglé, le parent du
/// dépôt principal en tient lieu.
#[tauri::command(async)]
fn folders_list() -> Vec<Folder> {
	let config = cfg();
	let root = if config.general.projects_root.trim().is_empty() {
		std::path::Path::new(&config.general.main_repo)
			.parent()
			.map(|path| path.to_string_lossy().to_string())
			.unwrap_or_default()
	} else {
		config::resolve_path(&config.general.projects_root, "")
	};
	let Ok(entries) = std::fs::read_dir(&root) else {
		return Vec::new();
	};
	let mut folders: Vec<Folder> = entries
		.flatten()
		.filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
		.filter_map(|entry| {
			let name = entry.file_name().to_string_lossy().to_string();
			(!name.starts_with('.') && name != "node_modules").then(|| Folder {
				path: entry.path().to_string_lossy().to_string(),
				name,
			})
		})
		.collect();
	folders.sort_by(|a, b| a.name.cmp(&b.name));
	folders.truncate(300);
	folders
}

#[tauri::command]
fn assistant_shortcut() -> voice_input::ShortcutStatus {
	voice_input::shortcut_status()
}

/// Change le raccourci à chaud. S'il ne prend pas, l'ancien est remis : on
/// ne reste jamais sans raccourci pour avoir essayé un autre.
#[tauri::command]
fn assistant_set_shortcut(app: AppHandle, accelerator: String) -> Result<voice_input::ShortcutStatus> {
	use std::str::FromStr;
	use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
	let accelerator = accelerator.trim().to_string();
	Shortcut::from_str(&accelerator)
		.map_err(|e| CockpitError::msg(i18n::tf("lib.shortcut.unreadable", &[("error", &e)])))?;
	let previous = voice_input::shortcut_status();
	if previous.registered {
		if let Ok(old) = Shortcut::from_str(&previous.accelerator) {
			let _ = app.global_shortcut().unregister(old);
		}
	}
	let status = register_talk(&app, &accelerator);
	if !status.registered {
		if previous.registered {
			register_talk(&app, &previous.accelerator);
		}
		return Err(CockpitError::msg(
			status.error.unwrap_or_else(|| i18n::t("lib.shortcut.refused")),
		));
	}
	voice_input::save_shortcut(&accelerator)?;
	Ok(status)
}

fn voice_shortcut() -> tauri::plugin::TauriPlugin<tauri::Wry> {
	use tauri_plugin_global_shortcut::ShortcutState;
	let emit = |app: &AppHandle, state: &str, text: &str| {
		let _ = app.emit("assistant-voice", serde_json::json!({ "state": state, "text": text }));
	};
	tauri_plugin_global_shortcut::Builder::new()
		// Pas de `with_shortcut` : un raccourci déjà pris par une autre
		// application ferait échouer le greffon, et avec lui le démarrage du
		// cockpit. Il s'enregistre plus loin, dans `setup`, où l'échec se dit.
		// Le greffon ne porte qu'un raccourci, celui de l'assistant, qu'on peut
		// changer : tout événement est donc le sien.
		.with_handler(move |app, _shortcut, event| match event.state() {
			ShortcutState::Pressed => {
				if voice_input::is_recording() {
					return;
				}
				match voice_input::start() {
					Ok(()) => emit(app, "listening", ""),
					Err(error) => emit(app, "error", &error.to_string()),
				}
			}
			ShortcutState::Released => {
				let app = app.clone();
				tauri::async_runtime::spawn(async move {
					match voice_input::stop() {
						Ok(Some(audio)) => {
							emit(&app, "transcribing", "");
							match voice_input::transcribe(audio).await {
								Ok(text) if !text.is_empty() => emit(&app, "heard", &text),
								Ok(_) => emit(&app, "idle", ""),
								Err(error) => emit(&app, "error", &error.to_string()),
							}
						}
						Ok(None) => emit(&app, "idle", ""),
						Err(error) => emit(&app, "error", &error.to_string()),
					}
				});
			}
		})
		.build()
}

#[tauri::command]
async fn git_create_branch(repo: String, name: String, base: Option<String>) -> Result<String> {
	let result = git::create_branch(std::path::Path::new(&repo), &name, base.as_deref()).await;
	logged("git", &i18n::t("lib.git.branch"), &name, result)
}

#[tauri::command]
async fn git_push(path: String) -> Result<String> {
	let result = git::push(std::path::Path::new(&path)).await;
	logged("git", "Push", &path, result)
}

#[tauri::command]
async fn git_commit(path: String, message: String) -> Result<String> {
	let result = git::commit_all(std::path::Path::new(&path), &message).await;
	logged("git", &format!("Commit · {message}"), &path, result)
}

/// Remise le travail en cours d'un worktree.
#[tauri::command]
async fn git_stash(path: String, message: Option<String>) -> Result<String> {
	let result = git::stash_push(std::path::Path::new(&path), &message.unwrap_or_default()).await;
	logged("git", "Stash", &path, result)
}

#[tauri::command]
async fn git_stash_pop(path: String) -> Result<String> {
	let result = git::stash_pop(std::path::Path::new(&path)).await;
	logged("git", "Stash pop", &path, result)
}

#[tauri::command]
async fn git_stash_list(path: String) -> Result<Vec<String>> {
	git::stash_list(std::path::Path::new(&path)).await
}

/// Ouvre une pull request pour la branche sortie dans ce dossier.
///
/// La branche est poussée d'abord : GitHub refuse une PR dont la tête n'existe
/// pas chez lui, et l'erreur qu'il renvoie alors n'aide personne. On accepte
/// donc de publier avant de demander, ce qui est de toute façon ce qu'on
/// s'apprêtait à faire.
#[tauri::command]
async fn git_create_pr(path: String, title: String, body: Option<String>, draft: Option<bool>) -> Result<String> {
	// Ouvrir une PR à la main, c'est publier la branche qu'on a sous les yeux :
	// ici, `HEAD` est bien ce qu'on veut. Une mission, elle, nomme sa branche.
	let folder = std::path::Path::new(&path);
	let branch = git::current_branch(folder).await?;
	let base = git::default_branch(&main_repo()?).await;
	create_pr_on(&path, &branch, &base, &title, body, draft.unwrap_or(false)).await
}

/// Ouvre une pull request pour une branche nommée, sur la base indiquée.
///
/// `base` n'est pas toujours la branche par défaut : une mission partie d'une
/// autre fonctionnalité s'y empile, et sa PR ne doit alors montrer que ce
/// qu'elle ajoute — pas tout ce que la branche parente contient déjà.
async fn create_pr_on(
	path: &str,
	branch: &str,
	base: &str,
	title: &str,
	body: Option<String>,
	draft: bool,
) -> Result<String> {
	let title = title.trim().to_string();
	if title.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.github.prTitleRequired")));
	}

	let config = cfg();
	let (owner, name) = config
		.github
		.repo
		.split_once('/')
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.github.repoFormat")))?;
	let token = integrations::github_token(&config).await?;

	let folder = std::path::Path::new(path);
	if branch == base {
		return Err(CockpitError::msg(i18n::tf(
			"lib.github.prFromBase",
			&[("branch", &branch)],
		)));
	}

	git::push_branch(folder, branch).await?;

	let payload = serde_json::json!({
		"title": title,
		"head": branch,
		"base": base,
		"body": body.unwrap_or_default(),
		"draft": draft,
	});

	let response = reqwest::Client::builder()
		.user_agent("cockpit/0.1")
		.build()
		.map_err(CockpitError::from)?
		.post(format!("https://api.github.com/repos/{owner}/{name}/pulls"))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.json(&payload)
		.send()
		.await?;

	let status = response.status();
	let raw = response.text().await.unwrap_or_default();
	if !status.is_success() {
		let message = serde_json::from_str::<Value>(&raw)
			.ok()
			.and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
			.unwrap_or(raw);
		let error = i18n::tf("lib.github.prRefused", &[("status", &status), ("message", &message)]);
		journal::record("github", &i18n::t("lib.github.prCreation"), branch, false, &error);
		return Err(CockpitError::msg(error));
	}

	let url = serde_json::from_str::<Value>(&raw)
		.ok()
		.and_then(|v| v.get("html_url").and_then(|u| u.as_str()).map(String::from))
		.unwrap_or_default();
	journal::record("github", &i18n::t("lib.github.prCreation"), branch, true, &url);
	Ok(url)
}

/// Journal des actions faites par le cockpit.
// ────────────────────────────── La Permanence ──────────────────────────────

#[tauri::command]
fn permanence_state() -> permanence::State {
	permanence::state()
}

/// Suspendre ou reprendre — un geste, pas un réglage.
#[tauri::command]
fn permanence_suspend(suspended: bool) -> permanence::State {
	permanence::suspend(suspended)
}

/// Un regard tout de suite, sans attendre la cadence.
///
/// Sert à voir l'effet d'une règle qu'on vient d'écrire sans patienter deux
/// minutes devant un écran vide — et à vérifier, en développement, que la
/// boucle regarde bien ce qu'on croit.
#[tauri::command]
async fn permanence_look(app: tauri::AppHandle) -> Result<permanence::State> {
	permanence::look(None, Some(app)).await
}

/// Tout arrêter : plus rien ne part, et ce qui tourne est coupé.
///
/// Le geste qu'on cherche quand ça dérape. Il pose le coupe-circuit plutôt
/// qu'une suspension : après un arrêt d'urgence, on regarde avant que ça
/// reparte, et le réarmement se demande.
#[tauri::command]
fn permanence_halt(agents: tauri::State<'_, agent::SharedAgents>, reason: Option<String>) -> permanence::Halt {
	permanence::halt(&agents, &reason.unwrap_or_default())
}

/// Ouvre ou referme une pull request au commentaire de la Permanence.
///
/// Le pendant humain du pouvoir de commenter : le consentement porte sur
/// l'objet, et c'est ici qu'il se donne — sur la PR, pas dans un écran de
/// réglages où l'on coche une fois pour toutes. Il se retire aussi vite.
#[tauri::command]
fn permanence_allow_pr(number: u64, allowed: bool) -> Result<ConfigView> {
	let mut config = Config::load();
	config.permanence.allowed_prs.retain(|entry| *entry != number);
	if allowed {
		config.permanence.allowed_prs.push(number);
	}
	config.save()?;
	journal::record(
		"permanence",
		&if allowed {
			i18n::t("lib.permanence.commentAllowed")
		} else {
			i18n::t("lib.permanence.commentWithdrawn")
		},
		&format!("#{number}"),
		true,
		"",
	);
	Ok(config.view())
}

/// Défait ce qu'un engagement a produit.
#[tauri::command]
async fn permanence_undo(id: String) -> permanence::Halt {
	permanence::undo(&id).await
}

/// Réarme le coupe-circuit après l'avoir regardé.
///
/// Geste humain et jamais automatique : une reprise au bout de N minutes
/// referait ce que le coupe-circuit sert à empêcher — réessayer sans que
/// personne ait vu pourquoi ça échouait.
#[tauri::command]
fn permanence_rearm() -> permanence::State {
	permanence::rearm()
}

/// Met fin au rodage : elle passe du blanc au réel.
#[tauri::command]
fn permanence_go_live() -> permanence::State {
	permanence::go_live()
}

/// Relance le tri sur un signal écarté.
#[tauri::command]
fn permanence_retry_signal(key: String, at: u64) -> permanence::State {
	permanence::retry_signal(&key, at)
}

#[tauri::command(async)]
fn journal_list(limit: Option<usize>) -> Vec<journal::JournalEntry> {
	journal::list(limit.unwrap_or(200).clamp(1, 1000))
}

/// Les serveurs MCP que ce dossier déclare, et ce qu'un agent en verra.
///
/// `cwd` vide = le dépôt principal du projet actif. L'isolation est lue dans la
/// configuration : c'est elle qui décide si une adresse locale ou une
/// autorisation du trousseau tiendra encore.
#[tauri::command(async)]
fn mcp_servers(cwd: Option<String>) -> Result<Vec<mcp::Server>> {
	let config = cfg();
	let cwd = match cwd.filter(|c| !c.trim().is_empty()) {
		Some(cwd) => cwd,
		None => main_repo()?.to_string_lossy().to_string(),
	};
	Ok(mcp::inspect(&cwd, config.sandbox.enabled))
}

/// La langue réglée (vide = celle du système) et celle qui s'applique.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LanguageView {
	choice: String,
	resolved: String,
	supported: Vec<&'static str>,
}

#[tauri::command]
fn language_get() -> LanguageView {
	LanguageView {
		choice: config::Config::load().general.language,
		resolved: i18n::lang(),
		supported: i18n::SUPPORTED.to_vec(),
	}
}

/// Change la langue de l'interface et des agents. `""` = suivre le système.
#[tauri::command]
fn language_set(choice: String) -> Result<LanguageView> {
	let choice = if choice.trim().is_empty() {
		String::new()
	} else {
		i18n::normalize(&choice).to_string()
	};
	let mut config = config::Config::load();
	config.general.language = choice;
	config.save()?;
	i18n::invalidate();
	Ok(language_get())
}

fn mcp_cwd(cwd: Option<String>) -> Result<String> {
	Ok(match cwd.filter(|c| !c.trim().is_empty()) {
		Some(cwd) => cwd,
		None => main_repo()?.to_string_lossy().to_string(),
	})
}

/// Les serveurs du `.mcp.json` sont-ils approuvés pour ce dépôt ? Sans cela,
/// aucun agent ne les reçoit : ce sont des commandes que le dépôt fait lancer.
#[tauri::command(async)]
fn mcp_approval(cwd: Option<String>) -> Result<mcp::Approval> {
	Ok(mcp::approval(&mcp_cwd(cwd)?))
}

#[tauri::command(async)]
fn mcp_approve(cwd: Option<String>) -> Result<mcp::Approval> {
	mcp::approve(&mcp_cwd(cwd)?)
}

#[tauri::command(async)]
fn mcp_revoke(cwd: Option<String>) -> Result<mcp::Approval> {
	mcp::revoke(&mcp_cwd(cwd)?)
}

/// Les exécutions d'agents relevées par le cockpit, les plus récentes d'abord.
#[tauri::command]
fn executions_list(limit: Option<usize>) -> Vec<executions::Execution> {
	executions::list(limit.unwrap_or(200).clamp(1, 2000))
}

/// Ce qu'un chantier a fait tourner chez lui, le plus récent d'abord.
///
/// Y compris les agents refermés depuis : fermer un onglet efface la
/// conversation, jamais ce qu'elle a coûté.
#[tauri::command(async)]
fn workspace_executions(cwd: String) -> Vec<executions::Execution> {
	executions::for_cwd(&cwd)
}

/// La timeline d'une mission : ce qui a tourné pour elle, dans l'ordre.
///
/// Rendue par le relevé et non par la fiche de mission : celle-ci porte l'état
/// courant de chaque tâche, jamais la suite des tentatives qui y ont mené.
#[tauri::command(async)]
fn mission_executions(mission: String) -> Vec<executions::Execution> {
	executions::for_mission(&mission)
}

/// Ce que les agents ont fait ces dernières heures : la frise de la journée.
#[tauri::command(async)]
fn executions_recent(hours: Option<i64>) -> Vec<executions::Execution> {
	let hours = hours.unwrap_or(12).clamp(1, 72);
	executions::since(chrono::Utc::now() - chrono::Duration::hours(hours))
}

#[tauri::command]
async fn git_graph(refs: Vec<String>, limit: Option<usize>) -> Result<String> {
	git::branch_graph(&main_repo()?, &refs, limit.unwrap_or(40).clamp(5, 300)).await
}

/// Un worktree et le sort de sa branche côté GitHub.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeHygiene {
	path: String,
	folder_name: String,
	branch: Option<String>,
	dirty: usize,
	pr: Option<integrations::BranchPr>,
	/// Vrai quand le worktree n'a plus de raison d'exister : sa PR est mergée ou
	/// fermée, et rien n'y traîne qui ne soit pas commité.
	removable: bool,
	reason: String,
}

#[tauri::command]
async fn worktrees_hygiene() -> Result<Vec<WorktreeHygiene>> {
	let config = cfg();
	let trees = git::list_worktrees(&main_repo()?).await?;
	// GitHub peut manquer (hors ligne, token absent) : on dégrade en affichant
	// l'état local plutôt que d'échouer.
	let pulls = integrations::github_pulls_by_branch(&config).await.unwrap_or_default();

	Ok(trees
		.into_iter()
		.map(|tree| {
			let dirty = tree.status.modified + tree.status.staged + tree.status.untracked;
			let pr = tree.branch.as_ref().and_then(|branch| pulls.get(branch).cloned());

			let (removable, reason) = if tree.is_main {
				(false, i18n::t("lib.hygiene.mainRepo"))
			} else if dirty > 0 {
				(false, i18n::tf("lib.hygiene.dirty", &[("count", &dirty)]))
			} else if tree.status.ahead > 0 {
				(
					false,
					i18n::tf("lib.hygiene.unpushed", &[("count", &tree.status.ahead)]),
				)
			} else {
				match pr.as_ref().map(|pr| pr.state.as_str()) {
					Some("merged") => (true, i18n::t("lib.hygiene.prMerged")),
					Some("closed") => (true, i18n::t("lib.hygiene.prClosed")),
					Some("open") => (false, i18n::t("lib.hygiene.prOpen")),
					_ => (false, i18n::t("lib.hygiene.noPr")),
				}
			};

			WorktreeHygiene {
				path: tree.path,
				folder_name: tree.folder_name,
				branch: tree.branch,
				dirty,
				pr,
				removable,
				reason,
			}
		})
		.collect())
}

/// Ce que pèsent des worktrees, et ce qu'on récupérerait sans rien perdre.
///
/// À la demande et non dans `worktrees_list` : mesurer parcourt des centaines de
/// milliers d'inodes, et cette liste-là se rafraîchit toutes les quelques
/// secondes. Le résultat vaut dix minutes, `refresh` force la reprise.
#[tauri::command]
async fn worktrees_usage(paths: Vec<String>, refresh: bool) -> Result<Vec<git::DiskUsage>> {
	Ok(git::disk_usages(&paths, refresh).await)
}

/// Efface les sorties de build d'un worktree, et dit ce que ça a rendu.
///
/// Ne peut rien détruire d'irremplaçable : ni code, ni historique, ni fichier
/// suivi — seulement ce qu'une commande reconstruit.
#[tauri::command]
async fn worktree_purge_builds(path: String, dependencies: bool) -> Result<u64> {
	let libéré = git::purge_rebuildable(Path::new(&path), dependencies).await?;
	journal::record(
		"worktree",
		&i18n::t("lib.worktree.buildsPurged"),
		&path,
		true,
		&i18n::tf("lib.worktree.freed", &[("size", &human_bytes(libéré))]),
	);
	Ok(libéré)
}

/// Un poids en octets, tel qu'on le lit à l'écran.
fn human_bytes(bytes: u64) -> String {
	const KO: f64 = 1024.0;
	let n = bytes as f64;
	if n >= KO * KO * KO {
		i18n::tf("lib.units.gb", &[("n", &format!("{:.1}", n / (KO * KO * KO)))])
	} else if n >= KO * KO {
		i18n::tf("lib.units.mb", &[("n", &format!("{:.0}", n / (KO * KO)))])
	} else {
		i18n::tf("lib.units.kb", &[("n", &format!("{:.0}", n / KO))])
	}
}

#[tauri::command]
async fn worktree_changes(path: String) -> Result<Vec<git::FileChange>> {
	git::working_diff(Path::new(&path)).await
}

#[tauri::command]
async fn worktree_file_diff(path: String, file: String) -> Result<String> {
	git::file_diff(Path::new(&path), &file).await
}

/// Livrables de self-QA d'un worktree : captures, vidéos, comptes rendus.
#[tauri::command(async)]
fn worktree_qa(path: String) -> Vec<qa::QaFile> {
	qa::scan(Path::new(&path), 400)
}

/// Aperçu d'un fichier local en data URI — repli quand `asset://` échoue.
#[tauri::command(async)]
fn file_data_url(path: String) -> Result<String> {
	// 24 Mo : au-delà, l'encodage bloquerait la webview plus longtemps que
	// l'aperçu ne vaut.
	qa::data_url(Path::new(&path), 24 * 1_048_576).map_err(CockpitError::msg)
}

#[tauri::command]
async fn worktree_commits(path: String, limit: usize) -> Result<Vec<git::Commit>> {
	git::recent_commits(Path::new(&path), limit.clamp(1, 100)).await
}

// ─────────────────────────── Pull requests ───────────────────────────

/// PR ouvertes du dépôt, avec CI et décision de review.
#[tauri::command]
async fn pull_requests() -> Result<Vec<pulls::PullRequest>> {
	let config = cfg();
	let token = integrations::github_token(&config).await?;
	let (owner, name) = config
		.github
		.repo
		.split_once('/')
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.github.repoFormat")))?;
	pulls::fetch_open_prs(&token, owner, name, &config.linear.team_key).await
}

// ──────────────────────────── Impact ────────────────────────────

/// Tout ce qui bouge, tous dépôts déclarés confondus.
#[tauri::command]
async fn impact_scan(project: Option<String>) -> Result<monitor::Scan> {
	monitor::scan(project.as_deref()).await
}

/// Les clés dont l'analyse tourne en ce moment.
///
/// L'analyse dure des minutes et rien ne la porte à l'écran entre-temps : sans
/// cette liste, un rafraîchissement de la fenêtre perdrait le fait qu'un agent
/// travaille, et on relancerait par-dessus.
#[tauri::command]
fn impact_running() -> Vec<String> {
	impact::in_progress()
}

/// Lit un changement et garde ce qu'il en a compris.
#[tauri::command]
async fn impact_analyze(key: String) -> Result<impact::Analysis> {
	impact::analyze(key).await
}

/// L'analyse déjà faite pour cette clé.
#[tauri::command(async)]
fn impact_read(key: String) -> Option<impact::Analysis> {
	impact::read(&key)
}

/// Oublie une analyse — pour en refaire une propre, ou parce qu'elle a vieilli.
#[tauri::command]
fn impact_forget(key: String) -> Result<()> {
	impact::forget(&key)?;
	// La confrontation portait sur la même tête de branche : la garder seule
	// laisserait un désaccord sans la lecture qui l'a provoqué.
	panel::forget(&key)
}

/// Fait relire le même changement sous trois angles, et ne garde que le
/// désaccord.
#[tauri::command]
async fn panel_confront(key: String) -> Result<panel::Panel> {
	panel::confront(key).await
}

#[tauri::command(async)]
fn panel_read(key: String) -> Option<panel::Panel> {
	panel::read(&key)
}

#[tauri::command]
fn panel_running() -> Vec<String> {
	panel::in_progress()
}

// ─────────────────────── Ce qui doit rester vrai ───────────────────────

/// Juge un changement, une propriété à la fois.
#[tauri::command]
async fn properties_audit(key: String) -> Result<properties::Audit> {
	properties::audit(key).await
}

#[tauri::command(async)]
fn properties_read(key: String) -> Option<properties::Audit> {
	properties::read_audit(&key)
}

/// Ce que valent les propriétés de ce projet, mesuré sur ses corrections.
#[tauri::command]
fn properties_calibrations(project: String) -> Vec<properties::Calibration> {
	properties::read_calibrations(&project)
}

/// Rejoue une propriété sur les corrections passées du dépôt.
#[tauri::command]
async fn properties_calibrate(project: String, property: String) -> Result<properties::Calibration> {
	properties::calibrate(project, property).await
}

/// Propose des propriétés d'après ce que le dépôt a déjà eu à corriger.
#[tauri::command]
async fn properties_suggest(project: String) -> Result<Vec<properties::Suggestion>> {
	properties::suggest(project).await
}

/// Ce qu'il faut jouer pour créer ou démonter un worktree, et comment.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeCommand {
	command: String,
	/// Vrai quand c'est une commande du dépôt : elle passe par un agent, pas
	/// par un shell.
	by_agent: bool,
}

/// Résout la commande de worktree déclarée par l'équipe.
///
/// Côté Rust et non dans chaque écran : la substitution et le repli doivent
/// être les mêmes partout, sans quoi on retrouverait ce qu'on vient de retirer
/// — deux écrans qui créent un worktree de deux façons différentes.
#[tauri::command]
fn worktree_command(action: String, branch: String, path: Option<String>) -> WorktreeCommand {
	let config = Config::active();
	let path = path.unwrap_or_default();
	let (command, by_agent) = match action.as_str() {
		"remove" => config.workflow.worktree_removal(&branch, &path),
		_ => config.workflow.worktree_creation(&branch, &path),
	};
	WorktreeCommand { command, by_agent }
}

/// Fusionne une pull request.
///
/// Action irréversible et visible de toute l'équipe : le front demande
/// confirmation, et on refuse ici tout ce que GitHub refuserait de toute façon,
/// pour que l'erreur soit lisible plutôt qu'un 405 brut.
#[tauri::command]
async fn pull_request_merge(number: i64, method: Option<String>) -> Result<()> {
	let config = cfg();
	let token = integrations::github_token(&config).await?;
	let method = method.unwrap_or_else(|| "squash".into());

	let response = reqwest::Client::builder()
		.user_agent("cockpit/0.1")
		.build()
		.map_err(CockpitError::from)?
		.put(format!(
			"https://api.github.com/repos/{}/pulls/{number}/merge",
			config.github.repo
		))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.json(&serde_json::json!({ "merge_method": method }))
		.send()
		.await?;

	if !response.status().is_success() {
		let code = response.status();
		let body = response.text().await.unwrap_or_default();
		let message = serde_json::from_str::<Value>(&body)
			.ok()
			.and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
			.unwrap_or(body);
		let error = i18n::tf("lib.github.mergeRefused", &[("status", &code), ("message", &message)]);
		journal::record(
			"github",
			&i18n::t("lib.github.prMerge"),
			&format!("#{number}"),
			false,
			&error,
		);
		return Err(CockpitError::msg(error));
	}
	// Irréversible et visible de toute l'équipe : c'est le premier geste qu'on
	// veut retrouver dans le carnet de bord.
	journal::record(
		"github",
		&i18n::t("lib.github.prMerge"),
		&format!("#{number}"),
		true,
		"",
	);
	Ok(())
}

// ─────────────────────────── Agents pilotés ───────────────────────────

/// Démarre un agent — consigné : il va écrire dans le dépôt.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn agent_start(
	app: AppHandle,
	agents: State<'_, agent::SharedAgents>,
	cwd: String,
	prompt: String,
	permission_mode: Option<String>,
	model: Option<String>,
	resume: Option<String>,
	engine: Option<String>,
	profile: Option<String>,
	account: Option<String>,
	depth: Option<String>,
) -> Result<String> {
	agent::start_profiled(
		app,
		agents.inner().clone(),
		cwd,
		prompt,
		permission_mode,
		model,
		resume,
		engine,
		profile,
		account,
		depth.unwrap_or_default(),
		executions::Origin::human(),
	)
	.await
}

// ──────────────────────────── Agents libres ────────────────────────────

/// Ce qu'est un dossier avant d'y lancer un agent libre : dépôt, branche, état.
#[tauri::command]
async fn libre_inspect(path: String) -> libre::Inspection {
	libre::inspect(&path).await
}

/// Sort la branche ou le worktree d'un agent libre ; rend son dossier de travail.
#[tauri::command]
async fn libre_prepare(path: String, place: String, branch: String) -> Result<libre::Prepared> {
	let result = libre::prepare(&path, &place, &branch).await;
	if place != "ici" {
		logged("git", &i18n::t("lib.git.freeAgent"), &branch, result)
	} else {
		result
	}
}

/// Range le worktree d'un agent libre archivé : `keep` garde la branche, `discard` jette tout.
#[tauri::command]
async fn libre_archive(worktree: String, branch: String, action: String) -> Result<()> {
	let result = libre::archive(&worktree, &branch, &action).await;
	if worktree.trim().is_empty() {
		result
	} else {
		logged("git", &i18n::t("lib.git.freeAgentArchive"), &branch, result)
	}
}

// ──────────────────────────── Revue de code ────────────────────────────

/// Prépare un tour de revue : la PR, sa branche à jour, son worktree, la consigne.
#[tauri::command]
async fn review_prepare(number: i64, kind: String) -> Result<review::Prepared> {
	review::prepare(&cfg(), number, &kind).await
}

/// Range la revue qu'un agent vient de remettre.
#[tauri::command]
async fn review_record(cwd: String, input: serde_json::Value) -> Result<review::Review> {
	review::record(&cfg(), &cwd, &input).await
}

/// La revue d'une PR du projet actif, s'il y en a une.
#[tauri::command(async)]
fn review_get(number: i64) -> Option<review::Review> {
	review::load(cfg().github.repo.trim(), number)
}

/// Toutes les revues du projet actif.
#[tauri::command(async)]
fn reviews_list() -> Vec<review::Review> {
	review::list(cfg().github.repo.trim())
}

/// La PR d'une branche, tous états confondus — ouverte, fusionnée ou fermée.
#[tauri::command]
async fn branch_pr(branch: String) -> Result<Option<integrations::BranchPr>> {
	integrations::github_pull_for_branch(&cfg(), &branch).await
}

/// Coche (ou décoche) un point comme posté sur la PR.
#[tauri::command(async)]
fn review_posted(number: i64, finding: String, posted: bool) -> Result<review::Review> {
	review::set_posted(cfg().github.repo.trim(), number, &finding, posted)
}

#[tauri::command]
async fn agent_send(
	app: AppHandle,
	agents: State<'_, agent::SharedAgents>,
	session_id: String,
	text: String,
) -> Result<()> {
	agent::send(&app, agents.inner(), &session_id, &text).await
}

/// Arrête le tour en cours ; l'agent reste là, prêt pour la suite.
#[tauri::command]
fn agent_interrupt(agents: State<'_, agent::SharedAgents>, session_id: String) -> Result<()> {
	agent::interrupt(&agents, &session_id)
}

/// Demande l'état réel des serveurs MCP de cette session.
///
/// La réponse ne revient pas ici : elle traverse le flux de l'agent comme un
/// message de plus, et l'écran la reconnaît. C'est le même chemin que tout ce
/// que le CLI raconte, et il évite d'ouvrir une attente que la mort de l'agent
/// laisserait pendante.
#[tauri::command]
fn agent_probe_mcp(agents: State<'_, agent::SharedAgents>, session_id: String) -> Result<()> {
	agent::probe_mcp(&agents, &session_id)
}

/// Demande la répartition du contexte de cette session.
///
/// Même chemin que l'état des MCP : la réponse traverse le flux de l'agent.
#[tauri::command]
fn agent_probe_context(agents: State<'_, agent::SharedAgents>, session_id: String) -> Result<()> {
	agent::probe_context(&agents, &session_id)
}

/// La date de modification de fichiers lus par des agents.
#[tauri::command(async)]
fn files_stamps(paths: Vec<String>) -> Vec<chantier::FileStamp> {
	chantier::stamps(paths)
}

/// Les fichiers d'un worktree et leur poids, pour la carte du chantier.
#[tauri::command]
async fn chantier_territory(cwd: String) -> Result<chantier::Territory> {
	chantier::territory(&cwd).await
}

/// Relance un serveur MCP tombé, sans interrompre la conversation.
#[tauri::command]
fn agent_reconnect_mcp(agents: State<'_, agent::SharedAgents>, session_id: String, server: String) -> Result<()> {
	agent::reconnect_mcp(&agents, &session_id, &server)
}

#[tauri::command]
fn agent_stop(agents: State<'_, agent::SharedAgents>, session_id: String) -> Result<()> {
	agent::stop(agents.inner(), &session_id)
}

#[tauri::command(async)]
fn agents_list(agents: State<'_, agent::SharedAgents>) -> Vec<agent::AgentStatus> {
	agents.snapshot()
}

/// Les agents de workspace survivent-ils à la fermeture du cockpit ?
#[tauri::command(async)]
fn relay_setting() -> relay::Setting {
	relay::setting()
}

#[tauri::command(async)]
fn relay_setting_save(setting: relay::Setting) -> Result<()> {
	relay::save_setting(&setting)
}

/// Les agents retrouvés vivants au démarrage de cette session du cockpit.
#[tauri::command(async)]
fn relay_survivors() -> Vec<String> {
	relay::survivors()
}

/// Demandes d'autorisation en attente, relayées par le pont MCP.
#[tauri::command(async)]
fn permissions_pending() -> Vec<permissions::PermissionRequest> {
	permissions::pending()
}

#[tauri::command]
fn permission_answer(id: String, allow: bool, reason: Option<String>) -> Result<()> {
	permissions::answer(&id, allow, reason)
}

/// Abandonne les demandes d'un agent qu'on vient d'arrêter.
#[tauri::command]
fn permissions_discard(session_id: Option<String>) {
	permissions::discard(session_id.as_deref());
}

// ─────────────────────────── Dossier de brief ───────────────────────────

/// Ce que le cockpit sait déjà sur ce dossier de travail.
///
/// Jamais d'erreur : un contexte est un bonus, et l'échec d'un bonus n'a pas à
/// empêcher de lancer un agent. Ce qui manque est nommé dans `missing`.
#[tauri::command]
async fn brief_compose(cwd: String) -> brief::Brief {
	brief::compose(&cwd).await
}

/// Le texte final, contexte retenu puis consigne.
///
/// Assemblé côté Rust et non dans l'écran : c'est ce que l'agent recevra
/// vraiment, et trois surfaces qui le composeraient chacune à leur façon,
/// ce sont trois occasions de diverger.
#[tauri::command]
fn brief_assemble(sections: Vec<brief::BriefSection>, prompt: String, cwd: Option<String>) -> String {
	// Une leçon sert quand elle part, pas quand elle est rassemblée : c'est ici
	// qu'on le sait, et c'est ce comptage qui dira plus tard laquelle n'a jamais
	// servi.
	notebook::mark_used(&brief::employed(&sections));
	// Et le dossier retient qu'un contexte en est parti : c'est ce qui permet
	// de comparer plus tard ce que rendent les agents qui en ont reçu.
	if let Some(cwd) = cwd.filter(|cwd| !cwd.trim().is_empty()) {
		if sections.iter().any(|section| section.on) {
			notebook::mark_briefed(&cwd);
		}
	}
	brief::assemble(&sections, &prompt)
}

/// Les sources qu'on peut joindre, pour l'écran de réglages.
#[tauri::command(async)]
fn brief_sources() -> Vec<brief::BriefSource> {
	brief::sources()
}

// ─────────────────────────── Mesurer la boucle ───────────────────────────

/// Ce que la boucle d'orchestration a produit, et ce qui mérite un regard.
///
/// Aucun de ces chiffres n'est un objectif : les prendre pour tels produirait
/// exactement ce qu'on cherche à éviter — moins de reprises parce qu'on relit
/// moins, moins de désaccords parce qu'on confronte moins.
#[tauri::command(async)]
fn metrics_collect(project: Option<String>) -> metrics::Metrics {
	metrics::collect(project.as_deref().unwrap_or_default())
}

// ─────────────────────── Commandes maison du dépôt ───────────────────────

/// Ce que ce dépôt déclare comme scripts, proposé sous forme de commandes.
///
/// Rien n'est enregistré : l'écran montre ce qui a été trouvé et laisse choisir.
#[tauri::command(async)]
fn commands_detect(repo: String) -> Result<Vec<config::CommandConfig>> {
	commands::detect(std::path::Path::new(&repo))
}

/// La ligne finale d'une commande, assemblée côté Rust.
///
/// Deux surfaces l'assemblaient chacune à leur façon : c'est ce qui part dans un
/// terminal, un seul endroit doit le décider.
#[tauri::command]
fn command_line(command: config::CommandConfig, positional: String, values: Vec<(String, String)>) -> String {
	commands::build(&command, &positional, &values)
}

// ─────────────────────────── Carnet du projet ───────────────────────────

/// Ce qu'on a eu à reprendre derrière un agent, et ce qu'on en a retenu.
///
/// Le projet vise le dépôt principal : une leçon ne traverse pas les projets,
/// et une convention d'un dépôt appliquée à un autre serait une consigne fausse.
#[tauri::command(async)]
fn notebook_lessons(project: Option<String>) -> Vec<notebook::Lesson> {
	notebook::lessons(project.as_deref().unwrap_or_default())
}

#[tauri::command]
fn notebook_save(lesson: notebook::Lesson) -> Result<Vec<notebook::Lesson>> {
	notebook::save_lesson(lesson)
}

#[tauri::command]
fn notebook_forget(id: String) -> Result<Vec<notebook::Lesson>> {
	notebook::forget_lesson(&id)
}

/// Les reprises en main relevées, en attente d'être lues.
#[tauri::command(async)]
fn notebook_handbacks(project: Option<String>) -> Vec<notebook::Handback> {
	notebook::handbacks(project.as_deref().unwrap_or_default())
}

/// Relève ce qui a été repris depuis le dernier rendu d'un agent.
///
/// Refusé tant qu'un agent tourne dans ce dossier : ses propres écritures se
/// feraient compter comme une reprise humaine, et le carnet apprendrait à
/// l'agent à ne pas faire ce qu'il vient de faire.
#[tauri::command]
async fn notebook_collect(agents: State<'_, agent::SharedAgents>, cwd: String) -> Result<Option<notebook::Handback>> {
	let busy = agents
		.snapshot()
		.into_iter()
		.any(|status| status.cwd == cwd && status.running);
	if busy {
		return Ok(None);
	}
	Ok(notebook::collect(&cwd).await)
}

/// Fait lire une reprise et propose une leçon — sans l'enregistrer.
#[tauri::command]
async fn notebook_draft(id: String) -> Result<notebook::Lesson> {
	notebook::draft(id).await
}

#[tauri::command]
fn notebook_dismiss(id: String) -> Result<Vec<notebook::Handback>> {
	notebook::dismiss(&id)
}

// ────────────────────────── Bibliothèque de prompts ──────────────────────────

#[tauri::command(async)]
fn prompts_list() -> Vec<prompts::Prompt> {
	prompts::list()
}

#[tauri::command]
fn prompt_save(prompt: prompts::Prompt) -> Result<Vec<prompts::Prompt>> {
	prompts::save(prompt)
}

#[tauri::command]
fn prompt_remove(id: String) -> Result<Vec<prompts::Prompt>> {
	prompts::remove(&id)
}

#[tauri::command]
fn prompts_reset() -> Result<Vec<prompts::Prompt>> {
	prompts::reset()
}

/// Les commandes « / » utilisables depuis ce worktree.
#[tauri::command(async)]
fn slash_commands(cwd: String) -> Result<Vec<slash::SlashCommand>> {
	slash::list(cwd)
}

#[tauri::command]
async fn prompt_launch(cwd: String, text: String) -> Result<()> {
	system::launch_agent(&cwd, &text).await
}

// ────────────────────────────── Sessions IA ──────────────────────────────

#[tauri::command]
async fn sessions_scan(limit_per_project: Option<usize>) -> Result<Vec<sessions::ProjectSessions>> {
	let limit = limit_per_project.unwrap_or(40).clamp(1, 500);
	// Le parsing est purement bloquant (I/O disque + JSON) : hors du runtime async.
	tokio::task::spawn_blocking(move || sessions::scan_all(limit))
		.await
		.map_err(|e| CockpitError::msg(i18n::tf("lib.interrupted.scan", &[("error", &e)])))?
}

#[tauri::command]
async fn session_timeline(file: String, max_events: Option<usize>) -> Result<Vec<sessions::SessionEvent>> {
	let max = max_events.unwrap_or(400).clamp(20, 5000);
	tokio::task::spawn_blocking(move || sessions::read_timeline(Path::new(&file), max))
		.await
		.map_err(|e| CockpitError::msg(i18n::tf("lib.interrupted.read", &[("error", &e)])))?
}

/// Les plafonds de l'abonnement, tels que le CLI les rapporte.
///
/// Le résultat est gardé quelques minutes : chaque lecture coûte un lancement du
/// CLI, et ces chiffres ne bougent pas d'une seconde à l'autre.
/// Ce qu'on dépense, pour le témoin toujours visible du rail.
///
/// Ne lance rien : lit les journaux sur le disque et reprend le dernier relevé
/// de quota. C'est ce qui permet de le rafraîchir souvent sans rien coûter.
#[tauri::command]
async fn usage_spend() -> usage::Spend {
	let config = Config::load();
	let roots: Vec<String> = config
		.projects
		.iter()
		.map(|project| project.main_repo.clone())
		.filter(|repo| !repo.is_empty())
		.collect();
	let last = LAST_LIMITS.lock().ok().and_then(|guard| guard.clone());
	usage::spend(&roots, last.as_ref())
}

/// Met en pause les missions qui ont dépassé leur plafond de jetons.
///
/// **En pause, jamais annulées** : les branches, les worktrees et le travail
/// restent là — c'est exactement ce qu'on veut examiner après un dérapage, et
/// c'est aussi ce qui rend la reprise possible d'un clic si le dépassement
/// était légitime.
///
/// Une mission déjà en pause n'est pas retouchée : sinon la reprendre à la main
/// serait défait à la minute suivante.
fn pause_missions_hors_budget() {
	let config = cfg();
	let budget = config.missions.token_budget();

	let roots: Vec<String> = config
		.projects
		.iter()
		.map(|project| project.main_repo.clone())
		.filter(|repo| !repo.is_empty())
		.collect();
	let vivantes: Vec<(String, String)> = mission::list()
		.into_iter()
		// L'intégration aussi : c'est là qu'un maître relancé en boucle dépensait
		// sans que ce plafond ne le voie jamais.
		.filter(|mission| {
			!mission.paused
				&& matches!(
					mission.state,
					mission::MissionState::Running | mission::MissionState::Integrating
				)
		})
		.map(|mission| (mission.id.clone(), mission.title.clone()))
		.collect();
	if vivantes.is_empty() {
		return;
	}

	let Ok(report) = usage::report_for(&roots, &vivantes) else {
		return;
	};

	for (id, titre) in &vivantes {
		let Some(bucket) = report.by_mission.iter().find(|entry| &entry.key == id) else {
			continue;
		};
		let total = bucket.totals.input + bucket.totals.output + bucket.totals.cache_read + bucket.totals.cache_write;
		if total < budget {
			continue;
		}
		let raison = i18n::tf("lib.budget.reason", &[("total", &total), ("budget", &budget)]);
		if mission::set_paused(id, true).is_ok() {
			journal::record("mission", &i18n::t("lib.budget.paused"), titre, false, &raison);
		}
	}
}

/// Le pourcentage consommé du quota le plus serré, d'après le dernier relevé.
///
/// Ne relance jamais le CLI : lire les plafonds coûte un lancement complet, et
/// une boucle qui passe toutes les six secondes ne peut pas se le permettre.
/// Sans relevé, `None` — et l'absence d'information ne bloque rien.
fn worst_quota() -> Option<u32> {
	LAST_LIMITS
		.lock()
		.ok()?
		.as_ref()?
		.limits
		.iter()
		.map(|limit| limit.percent)
		.max()
}

/// Ce qu'a coûté une conversation depuis son premier message.
#[tauri::command]
async fn agent_spend(session_id: String) -> usage::SessionSpend {
	let config = Config::load();
	let roots: Vec<String> = config
		.projects
		.iter()
		.map(|project| project.main_repo.clone())
		.filter(|repo| !repo.is_empty())
		.collect();
	let last = LAST_LIMITS.lock().ok().and_then(|guard| guard.clone());
	usage::session_spend(&session_id, &roots, last.as_ref())
}

/// Le dernier relevé de quota, partagé avec le témoin.
///
/// Le lire coûte un lancement de CLI : le témoin se sert de ce que le panneau
/// ou l'écran de la Permanence ont déjà obtenu, plutôt que d'en redemander un.
static LAST_LIMITS: std::sync::Mutex<Option<usage::Limits>> = std::sync::Mutex::new(None);

#[tauri::command]
async fn usage_limits(refresh: Option<bool>) -> usage::Limits {
	use std::sync::Mutex;
	use std::time::{Duration, Instant};
	static CACHE: Mutex<Option<(Instant, usage::Limits)>> = Mutex::new(None);
	// Une demi-heure, et non cinq minutes : chaque lecture manquée lance un CLI
	// complet, qui laisse une conversation dans les journaux de l'utilisateur.
	// Un quota d'abonnement ne bouge pas assez vite pour justifier ça — et le
	// bouton de rafraîchissement reste là pour qui veut le chiffre à l'instant.
	const FRAIS: Duration = Duration::from_secs(30 * 60);

	if refresh != Some(true) {
		if let Ok(cache) = CACHE.lock() {
			if let Some((pose, limits)) = cache.as_ref() {
				if pose.elapsed() < FRAIS {
					return limits.clone();
				}
			}
		}
	}

	let limits = usage::limits().await;
	if let Ok(mut last) = LAST_LIMITS.lock() {
		*last = Some(limits.clone());
	}
	if let Ok(mut cache) = CACHE.lock() {
		*cache = Some((Instant::now(), limits.clone()));
	}
	limits
}

#[tauri::command]
async fn usage_report() -> Result<usage::UsageReport> {
	// Les racines de travail, pour que le relevé parle de chantiers et non de
	// sous-dossiers de monorepo : un agent descend dans `apps/api`, et c'est ce
	// dossier-là que son journal enregistre.
	let roots: Vec<String> = match main_repo() {
		Ok(repo) => git::list_worktrees(&repo)
			.await
			.map(|list| list.into_iter().map(|tree| tree.path).collect())
			.unwrap_or_default(),
		Err(_) => Vec::new(),
	};
	let missions: Vec<(String, String)> = mission::list()
		.into_iter()
		.flat_map(|mission| {
			let titre = mission.title.clone();
			let mut places = vec![(mission.cwd.clone(), titre.clone())];
			places.extend(
				mission
					.tasks
					.iter()
					.filter(|task| !task.worktree.trim().is_empty())
					.map(|task| (task.worktree.clone(), titre.clone())),
			);
			places
		})
		.collect();

	// Relecture de tous les journaux : purement bloquant, hors du runtime async.
	tokio::task::spawn_blocking(move || usage::report_for(&roots, &missions))
		.await
		.map_err(|e| CockpitError::msg(i18n::tf("lib.interrupted.compute", &[("error", &e)])))?
}

#[tauri::command]
async fn session_subagents(file: String) -> Result<Vec<sessions::SubagentRun>> {
	tokio::task::spawn_blocking(move || sessions::read_subagents(Path::new(&file)))
		.await
		.map_err(|e| CockpitError::msg(i18n::tf("lib.interrupted.read", &[("error", &e)])))?
}

// ──────────────────────────────── Docs ────────────────────────────────

#[tauri::command]
async fn docs_scan(roots: Vec<(String, String)>, limit: Option<usize>) -> Result<Vec<docs::DocEntry>> {
	let limit = limit.unwrap_or(300).clamp(10, 2000);
	let roots: Vec<(PathBuf, String)> = roots
		.into_iter()
		.map(|(path, label)| (PathBuf::from(path), label))
		.collect();
	tokio::task::spawn_blocking(move || docs::scan_many(roots, limit))
		.await
		.map_err(|e| CockpitError::msg(i18n::tf("lib.interrupted.scan", &[("error", &e)])))?
}

/// Les fichiers d'un worktree, pour en ouvrir un qu'aucun agent n'a nommé.
#[tauri::command(async)]
async fn files_list(root: String) -> Result<Vec<files::FileEntry>> {
	// Parcourir un dépôt prend du temps : sur le fil principal, la fenêtre se
	// figeait à chaque ouverture du menu « Fichiers ».
	tokio::task::spawn_blocking(move || files::list(root))
		.await
		.map_err(|e| CockpitError::msg(i18n::tf("lib.interrupted.walk", &[("error", &e)])))?
}

/// Enregistre un fichier modifié dans l'éditeur intégré.
#[tauri::command]
fn file_write(path: String, content: String) -> Result<()> {
	files::write(path, content)
}

/// Joint un fichier du disque à une conversation — glissé, ou choisi.
#[tauri::command]
fn agent_attach(session_id: String, path: String) -> Result<files::Attachment> {
	files::attach(session_id, path)
}

/// Joint un contenu collé, qui n'existe que dans le presse-papier.
#[tauri::command]
fn agent_attach_clipboard(session_id: String, name: String, data: String) -> Result<files::Attachment> {
	files::attach_bytes(session_id, name, data)
}

#[tauri::command(async)]
fn doc_read(path: String) -> Result<String> {
	docs::read_doc(Path::new(&path))
}

// ─────────────────────────── Scripts & commandes ───────────────────────────

#[tauri::command(async)]
fn scripts_list(path: String) -> Result<Vec<system::PackageScript>> {
	system::package_scripts(Path::new(&path))
}

#[tauri::command]
async fn job_run(app: AppHandle, jobs: State<'_, SharedJobs>, request: JobRequest) -> Result<JobStatus> {
	runner::spawn_job(app, jobs.inner().clone(), request).await
}

#[tauri::command]
fn job_kill(jobs: State<'_, SharedJobs>, job_id: String) -> Result<()> {
	runner::kill_job(jobs.inner(), &job_id)
}

// ─────────────────────────── Terminaux intégrés ───────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SandboxLogin {
	cwd: String,
	command: String,
}

/// Ce qu'il faut taper dans un terminal pour connecter le compte des agents
/// isolés — une fois, `claude setup-token` en main. Voir `sandbox::login_command`.
#[tauri::command]
fn sandbox_login() -> Result<SandboxLogin> {
	let command = sandbox::login_command().map_err(CockpitError::msg)?;
	Ok(SandboxLogin {
		cwd: config::config_dir().to_string_lossy().to_string(),
		command,
	})
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn terminal_open(
	app: AppHandle,
	terminals: State<'_, terminal::SharedTerminals>,
	cwd: String,
	command: Option<String>,
	label: Option<String>,
	cols: Option<u16>,
	rows: Option<u16>,
	account: Option<String>,
) -> Result<terminal::TerminalInfo> {
	terminal::open(app, terminals.inner().clone(), cwd, command, label, cols, rows, account)
}

#[tauri::command]
fn terminal_write(terminals: State<'_, terminal::SharedTerminals>, id: String, data: String) -> Result<()> {
	terminal::write(terminals.inner(), &id, &data)
}

#[tauri::command]
fn terminal_resize(terminals: State<'_, terminal::SharedTerminals>, id: String, cols: u16, rows: u16) -> Result<()> {
	terminal::resize(terminals.inner(), &id, cols, rows)
}

#[tauri::command]
fn terminal_close(terminals: State<'_, terminal::SharedTerminals>, id: String) -> Result<()> {
	terminal::close(terminals.inner(), &id)
}

/// Regarde le navigateur d'un workspace, en le lançant s'il ne tourne pas.
#[tauri::command]
async fn browser_watch(browsers: State<'_, browser::SharedBrowsers>, cwd: String) -> Result<()> {
	browser::watch_for_ui(browsers.inner().clone(), cwd).await
}

/// L'image suivante de la page, en binaire : l'interface la demande quand elle
/// a dessiné la précédente.
#[tauri::command]
async fn browser_frame(
	browsers: State<'_, browser::SharedBrowsers>,
	cwd: String,
	after: u64,
) -> Result<tauri::ipc::Response> {
	Ok(tauri::ipc::Response::new(
		browser::frame(browsers.inner(), &cwd, after).await?,
	))
}

/// Le navigateur de ce workspace tourne-t-il déjà — lancé par un agent, donc ?
#[tauri::command]
async fn browser_running(cwd: String) -> Result<bool> {
	Ok(browser::running(&cwd).await)
}

/// L'élément sous un point de la page, pour le désigner à un agent.
#[tauri::command]
async fn browser_inspect(cwd: String, x: f64, y: f64) -> Result<serde_json::Value> {
	browser::inspect(&cwd, x, y).await
}

/// Une image de la page, à l'instant, sans se brancher sur le flux : la tuile
/// de la carte d'un agent en demande une de loin en loin. Même enveloppe que
/// `browser_frame` — la longueur de l'en-tête, l'en-tête en JSON, le JPEG — et
/// vide quand aucun navigateur ne tourne : rien n'est lancé pour elle.
#[tauri::command]
async fn browser_snapshot(cwd: String) -> Result<tauri::ipc::Response> {
	let Some((image, url)) = browser::snapshot(&cwd).await else {
		return Ok(tauri::ipc::Response::new(Vec::new()));
	};
	let header = serde_json::json!({ "url": url }).to_string().into_bytes();
	let mut block = Vec::with_capacity(4 + header.len() + image.len());
	block.extend_from_slice(&(header.len() as u32).to_le_bytes());
	block.extend_from_slice(&header);
	block.extend_from_slice(&image);
	Ok(tauri::ipc::Response::new(block))
}

#[tauri::command]
fn browser_act(browsers: State<'_, browser::SharedBrowsers>, cwd: String, action: browser::Action) -> Result<()> {
	browser::act(browsers.inner(), &cwd, action)
}

#[tauri::command]
fn browser_unwatch(browsers: State<'_, browser::SharedBrowsers>, cwd: String) {
	browser::unwatch(browsers.inner(), &cwd)
}

#[tauri::command]
fn browser_stop(browsers: State<'_, browser::SharedBrowsers>, cwd: String) {
	browser::stop(browsers.inner(), &cwd)
}

// ──────────────────────────────── Méthodes ────────────────────────────────

/// Les plugins du projet, et ceux que ses marketplaces proposent.
#[tauri::command]
async fn methods_catalog(project: String) -> Result<methods::Catalog> {
	methods::catalog(Path::new(&project)).await
}

/// Ce qu'un plugin contient et exécute, lu sans l'installer.
#[tauri::command]
async fn methods_inspect(project: String, plugin_id: String) -> Result<methods::Inspection> {
	methods::inspect(Path::new(&project), &plugin_id).await
}

/// Installe un plugin pour le projet ou ce poste — seulement si ce qu'il
/// exécute est encore ce que tu as lu (`approved`).
#[tauri::command]
async fn methods_install(
	project: String,
	plugin_id: String,
	scope: String,
	approved: String,
	accept: Option<String>,
) -> Result<methods::Installation> {
	methods::install(Path::new(&project), &plugin_id, &scope, &approved, accept.as_deref()).await
}

#[tauri::command]
async fn methods_uninstall(project: String, plugin_id: String, scope: String) -> Result<String> {
	methods::uninstall(Path::new(&project), &plugin_id, &scope).await
}

/// Les agents du projet avant et après l'installation d'un plugin.
#[tauri::command]
async fn methods_measure(project: String, project_id: String, plugin_id: String) -> Result<methods::Measure> {
	methods::measure(Path::new(&project), &project_id, &plugin_id).await
}

// ──────────────────────────────── Rejeu ────────────────────────────────

/// Les PR fusionnées du dépôt qui peuvent servir de cas d'essai.
#[tauri::command]
async fn replay_cases(project: String) -> Result<Vec<replay::Case>> {
	let repo = PathBuf::from(&project);
	let branch = git::default_branch(&repo).await;
	replay::cases(&repo, &branch, 20).await
}

/// Les essais déjà joués sur ce dépôt, les plus récents d'abord.
#[tauri::command]
fn replay_trials(project: String) -> Vec<replay::Trial> {
	replay::trials(Path::new(&project))
}

/// La campagne en cours, s'il y en a une.
#[tauri::command]
fn replay_progress() -> Option<replay::Progress> {
	replay::progress()
}

/// Lance une campagne : les cas choisis, avec chaque configuration. Rend le
/// nombre d'essais engagés ; la campagne tourne ensuite en fond.
#[tauri::command]
async fn replay_run(project: String, numbers: Vec<u32>, setups: Vec<replay::Setup>) -> Result<usize> {
	let repo = PathBuf::from(&project);
	let commands = gates::commands_for(&project);
	if commands.is_empty() {
		return Err(CockpitError::msg(i18n::t("replay.noGates")));
	}
	let branch = git::default_branch(&repo).await;
	let cases: Vec<replay::Case> = replay::cases(&repo, &branch, 20)
		.await?
		.into_iter()
		.filter(|case| case.number.is_some_and(|number| numbers.contains(&number)))
		.collect();
	let setups = if setups.is_empty() {
		vec![replay::Setup::default()]
	} else {
		setups
	};
	let total = cases.len() * setups.len();
	replay::reserve(&repo, total)?;
	tauri::async_runtime::spawn(replay::run_campaign(repo, cases, setups, commands));
	Ok(total)
}

#[tauri::command]
fn terminals_list(terminals: State<'_, terminal::SharedTerminals>) -> Vec<terminal::TerminalInfo> {
	terminals.snapshot()
}

/// Ce que le cockpit et sa descendance pèsent en ce moment.
#[tauri::command(async)]
fn resource_report(
	agents: State<'_, agent::SharedAgents>,
	terminals: State<'_, terminal::SharedTerminals>,
) -> Result<resources::ResourceReport> {
	resources::report(agents.roots(), terminals.roots())
}

#[tauri::command]
fn jobs_list(jobs: State<'_, SharedJobs>) -> Vec<JobStatus> {
	jobs.snapshot()
}

// ──────────────────────────────── Système ────────────────────────────────

#[tauri::command]
async fn open_editor(path: String) -> Result<()> {
	system::open_in_editor(&cfg().general.editor, &path).await
}

#[tauri::command]
async fn open_terminal(cwd: String, command: Option<String>) -> Result<()> {
	system::open_terminal(&cwd, command).await
}

// ─────────────────────────── Visite et voix ───────────────────────────

/// Ce qu'un agent a changé dans son dossier, fichier par fichier.
#[tauri::command]
async fn tour_changes(cwd: String, since: Option<String>) -> Result<tour::TourChanges> {
	tour::changes(Path::new(&cwd), since).await
}

#[tauri::command]
async fn tour_file_diff(root: String, base: String, file: String, untracked: bool) -> Result<String> {
	tour::file_diff(Path::new(&root), &base, &file, untracked).await
}

/// Le récit de la visite, écrit par un modèle.
#[tauri::command]
async fn tour_story(
	cwd: String,
	since: Option<String>,
	notes: Vec<tour::Note>,
	conclusion: String,
) -> Result<tour::Story> {
	tour::story(Path::new(&cwd), since, notes, conclusion).await
}

#[tauri::command]
fn speech_voices() -> Result<Vec<speech::Voice>> {
	speech::voices()
}

/// Rend la raison du repli sur la voix du Mac, quand ElevenLabs a échoué.
#[tauri::command]
async fn speech_say(
	text: String,
	engine: Option<String>,
	voice: Option<String>,
	model: Option<String>,
	system_voice: Option<String>,
	rate: Option<u32>,
) -> Result<Option<String>> {
	speech::speak(text, engine, voice, model, system_voice, rate).await
}

#[tauri::command]
fn speech_set_key(key: String) -> Result<()> {
	speech::set_key(&key)
}

#[tauri::command]
fn speech_has_key() -> bool {
	speech::has_key()
}

#[tauri::command]
async fn speech_cloud_voices() -> Result<Vec<speech::CloudVoice>> {
	speech::cloud_voices().await
}

/// La cervelle de l'assistant vocal : Claude, allégé, sur l'abonnement.
#[tauri::command]
async fn assistant_ask(system: String, prompt: String, model: Option<String>) -> Result<String> {
	agent::ask_quick(&system, &prompt, model.as_deref().unwrap_or("haiku")).await
}

/// Le micro, depuis le bouton de l'interface — le raccourci passe par le
/// greffon, sans aller-retour avec la page.
#[tauri::command]
fn voice_start() -> Result<()> {
	voice_input::start()
}

/// Referme le micro et rend ce qui a été dit ; vide pour un simple effleurement.
#[tauri::command]
async fn voice_stop() -> Result<String> {
	match voice_input::stop()? {
		Some(audio) => voice_input::transcribe(audio).await,
		None => Ok(String::new()),
	}
}

#[tauri::command]
fn speech_stop() {
	speech::stop();
}

#[tauri::command]
async fn open_file(path: String) -> Result<()> {
	system::open_file(&path).await
}

#[tauri::command]
async fn reveal_in_finder(path: String) -> Result<()> {
	system::reveal_in_finder(&path).await
}

/// Notification du centre de notifications.
///
/// Passe par le plugin plutôt que par `osascript` : une notification émise par
/// `osascript` est attribuée à « Éditeur de script », si bien que cliquer
/// dessus ouvrait cette application au lieu du cockpit. Émise par l'app, elle
/// porte son identité et son icône.
/// Ce qui mérite une notification sur le poste mérite aussi de faire sonner le
/// téléphone : le relais est branché ici plutôt que dans chaque veille de
/// l'interface, pour qu'aucune alerte n'existe d'un côté sans l'autre. Il reste
/// sans effet tant que l'accès mobile est coupé.
#[tauri::command]
async fn notify_desktop(app: AppHandle, title: String, body: String) -> Result<()> {
	use tauri_plugin_notification::NotificationExt;

	let _ = remote::wake(&title, &body, None).await;
	app.notification()
		.builder()
		.title(title)
		.body(body)
		.show()
		.map_err(|e| CockpitError::msg(i18n::tf("lib.window.notification", &[("error", &e)])))
}

#[tauri::command]
async fn open_external(url: String) -> Result<()> {
	system::open_external(&url).await
}

/// Cadre à restaurer quand on sort du plein écran de travail.
static ZOOM_MEMORY: std::sync::OnceLock<std::sync::Mutex<Option<WindowFrame>>> = std::sync::OnceLock::new();

type WindowFrame = (tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>);

/// Bascule entre le plein écran de travail et le cadre précédent.
///
/// Le double-clic sur la barre de titre passait par la maximisation de Tauri,
/// qui délègue au zoom d'AppKit : celui-ci s'arrête à quelques pixels des bords,
/// et comme macOS considère alors la fenêtre déjà zoomée, le double-clic suivant
/// la rétrécissait au lieu de finir le travail — impossible d'occuper l'écran.
/// On applique donc nous-mêmes la zone de travail du moniteur où la fenêtre se
/// trouve, barre de menus et Dock exclus.
/// Le cadre à donner à une fenêtre qui ne tient pas dans la zone de travail de
/// son écran, ou `None` quand elle y tient déjà.
///
/// La taille par défaut (1480 × 940) dépasse un MacBook Air réglé par défaut
/// (1470 points de large), et une taille retenue sur un grand écran dépasse le
/// petit sur lequel on rouvre l'app. Centrer ne suffisait pas : la fenêtre
/// débordait des deux côtés, barre de titre et boutons hors de portée. Elle est
/// ramenée à 95 % de la zone, et recentrée.
fn fitted_frame(area: (i32, i32, u32, u32), window: (i32, i32, u32, u32)) -> Option<((i32, i32), (u32, u32))> {
	let (ax, ay, aw, ah) = area;
	let (wx, wy, ww, wh) = window;
	let inside = wx >= ax && wy >= ay && wx + ww as i32 <= ax + aw as i32 && wy + wh as i32 <= ay + ah as i32;
	if inside || aw == 0 || ah == 0 {
		return None;
	}
	let width = ww.min(aw * 95 / 100);
	let height = wh.min(ah * 95 / 100);
	let x = ax + ((aw - width) / 2) as i32;
	let y = ay + ((ah - height) / 2) as i32;
	Some(((x, y), (width, height)))
}

/// Ramène la fenêtre dans son écran au démarrage, si elle en dépasse.
fn fit_to_screen(window: &tauri::WebviewWindow) {
	let (Ok(Some(monitor)), Ok(size), Ok(position)) =
		(window.current_monitor(), window.outer_size(), window.outer_position())
	else {
		return;
	};
	let area = monitor.work_area();
	if let Some(((x, y), (width, height))) = fitted_frame(
		(area.position.x, area.position.y, area.size.width, area.size.height),
		(position.x, position.y, size.width, size.height),
	) {
		let _ = window.set_size(tauri::PhysicalSize::new(width, height));
		let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
	}
}

#[tauri::command]
fn window_zoom_toggle(window: tauri::WebviewWindow) -> Result<()> {
	let monitor = window
		.current_monitor()
		.map_err(|e| CockpitError::msg(i18n::tf("lib.window.monitor", &[("error", &e)])))?;
	let Some(monitor) = monitor else {
		return Ok(());
	};
	let area = monitor.work_area();
	let size = window
		.outer_size()
		.map_err(|e| CockpitError::msg(i18n::tf("lib.window.window", &[("error", &e)])))?;
	let position = window
		.outer_position()
		.map_err(|e| CockpitError::msg(i18n::tf("lib.window.window", &[("error", &e)])))?;

	let memory = ZOOM_MEMORY.get_or_init(|| std::sync::Mutex::new(None));
	// « Rempli » à quelques pixels près : l'ombre portée et les arrondis de macOS
	// laissent rarement un compte rond, et une comparaison stricte ferait
	// réagrandir une fenêtre déjà pleine.
	let filled = size.width + 8 >= area.size.width && size.height + 8 >= area.size.height;

	if filled {
		let previous = memory.lock().ok().and_then(|mut slot| slot.take());
		if let Some((previous_position, previous_size)) = previous {
			let _ = window.set_size(previous_size);
			let _ = window.set_position(previous_position);
		}
		return Ok(());
	}

	if let Ok(mut slot) = memory.lock() {
		*slot = Some((position, size));
	}
	// La taille d'abord : posée après le déplacement, elle peut être rognée par
	// le bord de l'écran d'où l'on vient.
	let _ = window.set_position(area.position);
	let _ = window.set_size(area.size);
	Ok(())
}

// ──────────────────────────────── Missions ────────────────────────────────

// Les commandes des missions vivent dans `mission_commands.rs`.

// ──────────────────────────── Accès mobile ────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteStatus {
	enabled: bool,
	/// Nom de la machine dans le tailnet, vide si Tailscale ne répond pas.
	host: String,
	/// Vrai quand un Funnel est actif : le serveur refuse alors de démarrer.
	funnel: bool,
	ntfy_server: String,
	ntfy_topic: String,
	/// Vrai quand un jeton de publication est enregistré — jamais sa valeur.
	ntfy_authenticated: bool,
	/// Ce que le relais a répondu la dernière fois qu'on a tenté de réveiller
	/// le téléphone : c'est là que se voit un montage cassé.
	last_wake: Option<remote::WakeStatus>,
	devices: Vec<remote::Device>,
	/// Commande à lancer une fois pour publier le cockpit sur le tailnet.
	serve_command: String,
}

#[tauri::command]
async fn remote_status() -> RemoteStatus {
	let config = remote::load();
	let host = remote::dns_name().await.unwrap_or_default();
	RemoteStatus {
		enabled: config.enabled,
		funnel: remote::funnel_active().await,
		ntfy_authenticated: !config.ntfy_token.is_empty(),
		last_wake: remote::last_wake(),
		ntfy_server: config.ntfy_server,
		ntfy_topic: config.ntfy_topic,
		devices: config.devices,
		serve_command: format!("tailscale serve --bg {}", remote::PORT),
		host,
	}
}

#[tauri::command]
async fn remote_enable(app: AppHandle, enabled: bool) -> Result<()> {
	remote::set_enabled(enabled)?;
	if enabled {
		remote::start(app).await?;
	}
	Ok(())
}

#[tauri::command]
async fn remote_ntfy(server: String, topic: String, token: Option<String>) -> Result<()> {
	remote::set_ntfy(&server, &topic, &token.unwrap_or_default())
}

/// Ouvre une fenêtre d'appairage de deux minutes et rend le QR de la page.
#[tauri::command]
async fn remote_pair() -> Result<Value> {
	let host = remote::dns_name()
		.await
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.tailscaleDown")))?;
	let code = remote::open_pairing();
	let url = format!("https://{host}/");
	Ok(serde_json::json!({ "code": code, "url": url, "qr": remote::qr_svg(&url)? }))
}

/// Publie un message de test et rend ce que le relais en dit.
#[tauri::command]
async fn remote_test() -> Result<String> {
	remote::test_relay().await
}

#[tauri::command]
fn remote_revoke(id: String) -> Result<()> {
	remote::revoke(&id)
}

/// Réveil déclenché par la veille de l'interface (agent en attente, CI rouge…).
#[tauri::command]
async fn remote_wake(title: String, body: String) {
	let _ = remote::wake(&title, &body, None).await;
}

#[tauri::command]
async fn docker_containers() -> Result<Vec<system::Container>> {
	system::docker_containers().await
}

#[tauri::command]
async fn listening_ports() -> Result<Vec<system::ListeningPort>> {
	system::listening_ports().await
}

/// Arrête ce qui occupe un port : un serveur de développement oublié, le plus
/// souvent, qu'on ne retrouvait qu'en cherchant son pid à la main.
#[tauri::command]
async fn stop_process(pid: u32) -> Result<()> {
	system::stop_process(pid).await
}

// ──────────────────────────── Intégrations SaaS ────────────────────────────

#[tauri::command]
async fn feed_sentry(query: Option<String>) -> Result<Vec<integrations::FeedItem>> {
	integrations::sentry_issues(&cfg(), &query.unwrap_or_else(|| "is:unresolved".into())).await
}

#[tauri::command]
async fn sentry_projects() -> Result<Vec<integrations::SentryProject>> {
	integrations::sentry_projects(&cfg()).await
}

/// Crée le ticket Linear correspondant à une issue Sentry, et laisse une note
/// sur l'issue pour ne pas le recréer au prochain triage.
#[tauri::command]
async fn sentry_to_linear(
	issue_id: String,
	title: String,
	permalink: String,
	project: String,
	culprit: String,
	users: String,
	events: String,
) -> Result<String> {
	let config = cfg();
	let team_id = config.linear.team_id.clone();

	let description = i18n::tf(
		"lib.sentryIssue.description",
		&[
			("project", &project),
			("culprit", &culprit),
			("events", &events),
			("users", &users),
			("permalink", &permalink),
		],
	);

	let (identifier, url) = integrations::linear_create_issue(&config, &team_id, &title, &description).await?;

	// La note est un confort, pas une condition : si elle échoue, le ticket
	// existe quand même et on ne veut pas faire croire à un échec.
	let note = i18n::tf("lib.sentryIssue.note", &[("identifier", &identifier), ("url", &url)]);
	let _ = integrations::sentry_add_comment(&config, &issue_id, &note).await;

	Ok(url)
}

#[tauri::command]
async fn sentry_set_status(issue_id: String, status: String) -> Result<()> {
	integrations::sentry_update_issue(&cfg(), &issue_id, &status).await
}

#[tauri::command]
async fn betterstack_dashboards() -> Result<Vec<integrations::KpiDashboard>> {
	integrations::betterstack_dashboards(&cfg()).await
}

#[tauri::command]
async fn betterstack_kpi_values(dashboard_id: String, hours: Option<i64>) -> Result<Vec<integrations::KpiValue>> {
	integrations::betterstack_kpi_values(&cfg(), &dashboard_id, hours.unwrap_or(24)).await
}

#[tauri::command]
async fn feed_betterstack_monitors() -> Result<Vec<integrations::FeedItem>> {
	integrations::betterstack_monitors(&cfg()).await
}

#[tauri::command]
async fn feed_betterstack_incidents() -> Result<Vec<integrations::FeedItem>> {
	integrations::betterstack_incidents(&cfg()).await
}

/// Ce que sait faire le suivi de tâches configuré, et comment il s'appelle.
///
/// L'interface s'y règle : sans priorité chez le fournisseur, le sélecteur de
/// priorité n'apparaît pas — plutôt que d'afficher un champ qui ne changera
/// rien.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketProviderInfo {
	label: String,
	capabilities: tickets::Capabilities,
}

#[tauri::command]
fn ticket_provider() -> Result<TicketProviderInfo> {
	let config = cfg();
	let provider = tickets::provider(&config)?;
	Ok(TicketProviderInfo {
		label: provider.label().to_string(),
		capabilities: provider.capabilities(),
	})
}

#[tauri::command]
async fn feed_linear(only_mine: Option<bool>) -> Result<Vec<integrations::FeedItem>> {
	let config = cfg();
	tickets::provider(&config)?.list(only_mine.unwrap_or(false)).await
}

#[tauri::command]
async fn linear_issue(id: String) -> Result<tickets::TicketDetail> {
	let config = cfg();
	tickets::provider(&config)?.get(&id).await
}

#[tauri::command]
async fn linear_options() -> Result<tickets::Options> {
	let config = cfg();
	tickets::provider(&config)?.options().await
}

#[tauri::command]
async fn linear_update(id: String, patch: Value) -> Result<()> {
	let config = cfg();
	tickets::provider(&config)?.update(&id, patch).await
}

#[tauri::command]
async fn feed_github_pulls() -> Result<Vec<integrations::FeedItem>> {
	integrations::github_pulls(&cfg()).await
}

#[tauri::command]
async fn feed_github_runs() -> Result<Vec<integrations::FeedItem>> {
	integrations::github_runs(&cfg()).await
}

#[tauri::command]
async fn feed_trigger(environment: Option<String>) -> Result<Vec<integrations::FeedItem>> {
	integrations::trigger_runs(&cfg(), environment.as_deref()).await
}

#[tauri::command]
async fn feed_railway() -> Result<Vec<integrations::FeedItem>> {
	integrations::railway_deployments(&cfg()).await
}

#[tauri::command]
async fn feed_stripe() -> Result<Vec<integrations::FeedItem>> {
	integrations::stripe_events(&cfg()).await
}

// ───────────────────────── Surveillance des sessions ─────────────────────────

// Les surveillances et les boucles de fond vivent dans `watchers.rs`.

pub fn run() {
	raise_file_descriptor_limit();
	let jobs: SharedJobs = Arc::new(JobRegistry::default());
	let agents: agent::SharedAgents = Arc::new(agent::AgentRegistry::default());
	let agents_at_exit = agents.clone();
	let terminals: terminal::SharedTerminals = Arc::new(terminal::TerminalRegistry::default());
	let terminals_at_exit = terminals.clone();
	let browsers = browser::SharedBrowsers::default();
	let browsers_at_exit = browsers.clone();

	let builder = tauri::Builder::default()
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_notification::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		// Redémarrer l'application, une fois la mise à jour posée : sans ce
		// plugin, l'installation aboutit mais l'ancienne version reste à l'écran
		// jusqu'à ce qu'on pense à quitter.
		.plugin(tauri_plugin_process::init())
		// Le sélecteur de dossier natif : un workspace peut vivre hors des
		// worktrees du projet actif, et il faut alors pouvoir le désigner.
		.plugin(tauri_plugin_dialog::init())
		// Parler à l'assistant : ⌥ Espace maintenu ouvre le micro, relâché le
		// referme et envoie la phrase — même quand le cockpit est derrière une
		// autre fenêtre, c'est tout l'intérêt d'un raccourci global.
		.plugin(voice_shortcut())
		// La fenêtre retrouve l'écran et la taille qu'on lui avait donnés. Sur
		// un poste à deux écrans, la recentrer à chaque lancement obligeait à la
		// redéplacer chaque matin.
		//
		// Trois drapeaux seulement, au lieu des six par défaut : `DECORATIONS`
		// et `VISIBLE` rejoueraient un état de fenêtre qui, ici, est décidé par
		// la configuration — barre de titre masquée, fond transparent — et que
		// le plugin n'a pas à réécrire au démarrage.
		.plugin(
			tauri_plugin_window_state::Builder::default()
				.with_state_flags(
					tauri_plugin_window_state::StateFlags::SIZE
						| tauri_plugin_window_state::StateFlags::POSITION
						| tauri_plugin_window_state::StateFlags::MAXIMIZED,
				)
				.build(),
		)
		.manage(jobs)
		.manage(agents)
		.manage(terminals)
		.manage(browsers);
	// Sous forte pression mémoire, macOS peut tuer le processus qui dessine la
	// page. WebKit n'en relance pas d'autre de lui-même : la fenêtre restait
	// vide jusqu'à ce qu'on quitte le cockpit — et avec lui, ses agents.
	// Recharger la page suffit, l'état vit côté Rust. Propre à WebKit : Tauri
	// ne l'offre pas sous Windows (WebView2).
	#[cfg(target_os = "macos")]
	let builder = builder.on_web_content_process_terminate(|webview| {
		let _ = webview.reload();
	});
	builder
		.setup(|app| {
			{
				use tauri::Manager;
				if let Some(window) = app.get_webview_window("main") {
					fit_to_screen(&window);
				}
			}
			// Pris par une autre application, le raccourci ne fait pas échouer
			// le démarrage : l'échec est retenu, et les Réglages le disent.
			register_talk(app.handle(), &voice_input::saved_shortcut());
			// Une exécution précédente a pu laisser des agents debout : leur
			// pont attend toujours une réponse que ce cockpit-ci ne saura plus
			// afficher. On la leur donne — un refus motivé, tout de suite —
			// plutôt que de les laisser expirer au bout d'une demi-heure.
			// Les agents détachés d'abord : ils ont survécu au cockpit précédent,
			// et ce qui suit referme tout ce qu'il croit orphelin — leur question
			// en attente comme leur exécution. Voir `agent::adopt_relays`.
			let adopted = {
				use tauri::Manager;
				let agents = app.state::<agent::SharedAgents>().inner().clone();
				agent::adopt_relays(app.handle(), &agents)
			};
			permissions::release_orphans(&adopted.sessions);
			// Après l'adoption, pour que les agents détachés soient comptés vivants :
			// ce qui reste marqué sans cockpit au-dessus est un serveur oublié.
			let strays = strays::sweep();
			if strays > 0 {
				eprintln!("cockpit: {strays} processus laissés par des agents arrêtés, coupés au démarrage");
			}
			// Une lecture de changement ne survit pas à la fermeture : on note
			// celles qui ont été coupées, plutôt que de les laisser disparaître
			// sans que rien ne l'ait dit.
			impact::report_interrupted();
			// Même chose pour les exécutions d'agents : le registre est en
			// mémoire, donc une exécution encore ouverte vient forcément d'un
			// cockpit qui a été tué. La refermer d'abord, ranger ensuite —
			// l'inverse évincerait une exécution avant de savoir la nommer.
			executions::close_orphans(&adopted.executions);
			executions::sweep();
			// Ce que le global déclarait pour un projet devenu autonome lui est
			// rendu, une fois : sans quoi cloisonner lui retirerait son équipe et
			// ses rôles sans que personne l'ait demandé.
			if config::migrate_project_ownership() {
				eprintln!("configuration : équipe et rôles rattachés au projet principal");
			}
			// Même raison pour les missions : les exécutants de la session
			// précédente sont morts avec elle, et leurs tâches resteraient
			// « en cours » sans jamais être reprises.
			// La surveillance ne démarre qu'après : elle conclurait sinon qu'une
			// tâche dont l'agent n'existe plus vient de livrer, sans distinguer
			// celle qui a réellement produit des commits de celle qu'un arrêt a
			// coupée en plein travail.
			let handle = app.handle().clone();
			tauri::async_runtime::spawn(async move {
				let recovered = mission::recover_all().await;
				if recovered > 0 {
					eprintln!("missions : {recovered} tâche(s) à relancer");
				}
				// Les maîtres avant la surveillance : c'est elle qui fera repartir
				// les tâches, et une tâche qui livre pendant que son maître manque
				// laisse son verdict sans lecteur.
				let relancés = relaunch_mission_masters(&handle).await;
				if relancés > 0 {
					eprintln!("missions : {relancés} maître(s) repris");
				}
				watch_missions(handle);
			});
			watch_scopes();
			// Un relevé de quota au démarrage, et un seul : sans lui le témoin du
			// rail resterait muet jusqu'à ce que quelqu'un ouvre le panneau
			// d'usage — c'est-à-dire jusqu'à ce qu'il s'inquiète, donc trop tard.
			// Il coûte un lancement de CLI, une fois par session.
			tauri::async_runtime::spawn(async {
				let limits = usage::limits().await;
				if let Ok(mut last) = LAST_LIMITS.lock() {
					*last = Some(limits);
				}
			});
			watch_permanence(app.handle().clone());
			watch_orchestrator(app.handle().clone());
			watch_sessions(app.handle().clone());
			watch_git(app.handle().clone());
			// L'accès mobile ne se rallume qu'à la demande : s'il a été activé,
			// on le remonte au démarrage, en silence si le terrain n'est pas sûr.
			let handle = app.handle().clone();
			tauri::async_runtime::spawn(async move {
				if let Err(error) = remote::start(handle).await {
					eprintln!("accès mobile : {error}");
				}
			});
			Ok(())
		})
		.invoke_handler(tauri::generate_handler![
			config_get,
			connectors_list,
			config_update,
			config_file_path,
			accounts_status,
			accounts_save,
			accounts_refresh,
			tasks_list,
			task_add,
			task_toggle,
			task_remove,
			tasks_clear_done,
			project_activate,
			project_update,
			project_save,
			project_inspect,
			project_prepare,
			project_remove,
			feeds_invalidate,
			trigger_env_save,
			trigger_env_remove,
			worktrees_list,
			repos_of,
			git_branches,
			git_branch_diff,
			git_branch_file_diff,
			git_fetch,
			git_pull,
			git_push,
			git_commit,
			journal_list,
			mcp_servers,
			mcp_approval,
			language_get,
			language_set,
			mcp_approve,
			mcp_revoke,
			executions_list,
			mission_executions,
			workspace_executions,
			permanence_state,
			permanence_suspend,
			permanence_look,
			permanence_halt,
			permanence_allow_pr,
			permanence_undo,
			permanence_rearm,
			permanence_go_live,
			permanence_retry_signal,
			git_stash,
			git_stash_pop,
			git_stash_list,
			git_create_pr,
			git_graph,
			worktrees_hygiene,
			worktrees_usage,
			worktree_purge_builds,
			worktree_changes,
			worktree_file_diff,
			worktree_commits,
			worktree_qa,
			file_data_url,
			pull_requests,
			worktree_command,
			impact_scan,
			impact_running,
			impact_analyze,
			impact_read,
			impact_forget,
			panel_confront,
			panel_read,
			panel_running,
			properties_audit,
			properties_read,
			properties_calibrations,
			properties_calibrate,
			properties_suggest,
			pull_request_merge,
			permissions_pending,
			permission_answer,
			permissions_discard,
			agent_start,
			libre_inspect,
			libre_prepare,
			libre_archive,
			agent_send,
			agent_stop,
			agent_interrupt,
			agent_probe_mcp,
			agent_probe_context,
			review_prepare,
			review_record,
			review_get,
			reviews_list,
			review_posted,
			branch_pr,
			files_stamps,
			chantier_territory,
			agent_reconnect_mcp,
			agents_list,
			relay_setting,
			relay_setting_save,
			relay_survivors,
			brief_compose,
			brief_assemble,
			brief_sources,
			commands_detect,
			command_line,
			metrics_collect,
			notebook_lessons,
			notebook_save,
			notebook_forget,
			notebook_handbacks,
			notebook_collect,
			notebook_draft,
			notebook_dismiss,
			prompts_list,
			prompt_save,
			prompt_remove,
			prompts_reset,
			slash_commands,
			prompt_launch,
			sessions_scan,
			session_timeline,
			session_subagents,
			usage_report,
			usage_limits,
			usage_spend,
			agent_spend,
			docs_scan,
			doc_read,
			files_list,
			file_write,
			agent_attach,
			agent_attach_clipboard,
			scripts_list,
			job_run,
			job_kill,
			jobs_list,
			resource_report,
			sandbox_login,
			terminal_open,
			terminal_write,
			browser_watch,
			browser_frame,
			browser_running,
			browser_inspect,
			browser_snapshot,
			browser_act,
			browser_unwatch,
			browser_stop,
			methods_catalog,
			methods_inspect,
			methods_install,
			methods_uninstall,
			methods_measure,
			replay_cases,
			replay_trials,
			replay_progress,
			replay_run,
			terminal_resize,
			terminal_close,
			terminals_list,
			open_editor,
			open_terminal,
			reveal_in_finder,
			open_file,
			tour_changes,
			tour_file_diff,
			tour_story,
			speech_voices,
			speech_say,
			speech_set_key,
			speech_has_key,
			speech_cloud_voices,
			speech_stop,
			assistant_ask,
			assistant_shortcut,
			folders_list,
			assistant_set_shortcut,
			voice_start,
			voice_stop,
			git_create_branch,
			open_external,
			notify_desktop,
			window_zoom_toggle,
			missions_list,
			missions_everywhere,
			mission_estimate,
			mission_overruns,
			mission_get,
			mission_events,
			mission_commit_diff,
			mission_commit_file_diff,
			mission_create,
			mission_from_ticket,
			mission_start_from_ticket,
			mission_start_from_brief,
			mission_activity,
			agent_timeline,
			mission_remove,
			mission_purge,
			mission_pause,
			mission_resume,
			mission_stop,
			mission_plan,
			mission_approve,
			mission_review,
			executions_recent,
			mission_state,
			mission_task_add,
			mission_task_state,
			mission_attach,
			mission_task_launch,
			mission_task_rerun,
			mission_set_base,
			mission_master_launch,
			mission_pr,
			mission_exposure,
			mission_dossier,
			mission_dossier_publish,
			readiness_check,
			mission_cleanup,
			roles_list,
			repo_roles,
			repo_roles_trust,
			remote_status,
			remote_enable,
			remote_ntfy,
			remote_pair,
			remote_test,
			remote_revoke,
			remote_wake,
			docker_containers,
			listening_ports,
			stop_process,
			feed_sentry,
			sentry_projects,
			sentry_set_status,
			sentry_to_linear,
			betterstack_dashboards,
			betterstack_kpi_values,
			feed_betterstack_monitors,
			feed_betterstack_incidents,
			feed_linear,
			ticket_provider,
			linear_issue,
			linear_options,
			linear_update,
			feed_github_pulls,
			feed_github_runs,
			feed_trigger,
			feed_railway,
			feed_stripe,
		])
		.build(tauri::generate_context!())
		.expect("Le cockpit n'a pas pu démarrer")
		.run(move |app, event| {
			// Seul `Reopen`, propre à macOS, se sert de l'app.
			#[cfg(not(target_os = "macos"))]
			let _ = &app;
			match event {
				tauri::RunEvent::Exit => {
					agent::stop_all(&agents_at_exit);
					terminal::close_all(&terminals_at_exit);
					browser::stop_all(&browsers_at_exit);
				}
				// Clic sur l'icône du Dock, fenêtre fermée : propre à macOS.
				#[cfg(target_os = "macos")]
				tauri::RunEvent::Reopen { .. } => {
					use tauri::Manager;
					if let Some(window) = app.get_webview_window("main") {
						let _ = window.show();
						let _ = window.unminimize();
						let _ = window.set_focus();
					}
				}
				_ => {}
			}
		});
}

#[cfg(test)]
mod window_tests {
	use super::fitted_frame;

	/// Le premier lancement sur l'écran du runner macOS : 1024 × 768, la
	/// fenêtre par défaut centrée débordait des deux côtés.
	#[test]
	fn une_fenetre_trop_grande_est_ramenee_dans_l_ecran() {
		let area = (0, 25, 1024, 743);
		let window = (-228, -61, 1480, 940);
		let ((x, y), (w, h)) = fitted_frame(area, window).expect("elle déborde");
		assert!(w <= 1024 && h <= 743);
		assert!(x >= 0 && y >= 25);
		assert!(x + w as i32 <= 1024 && y + h as i32 <= 25 + 743);
	}

	/// Une fenêtre qui tient déjà ne bouge pas : sa place est un choix.
	#[test]
	fn une_fenetre_qui_tient_ne_bouge_pas() {
		assert_eq!(fitted_frame((0, 0, 2560, 1400), (200, 100, 1480, 940)), None);
	}

	/// Second écran à gauche : des coordonnées négatives restent valides.
	#[test]
	fn un_ecran_a_gauche_garde_ses_coordonnees() {
		assert_eq!(fitted_frame((-1920, 0, 1920, 1040), (-1700, 50, 1480, 940)), None);
		let ((x, _), (w, _)) = fitted_frame((-1440, 0, 1440, 860), (-1500, 0, 1480, 940)).unwrap();
		assert!(x >= -1440 && x + w as i32 <= 0);
	}
}

#[cfg(test)]
mod review_message_tests {
	use super::*;

	fn mission_with(understanding: mission::Draft) -> mission::Mission {
		let mut mission: mission::Mission = serde_json::from_value(serde_json::json!({
			"id": "m", "title": "Export CSV", "state": "approaching", "tasks": [],
			"createdAt": "", "updatedAt": "", "guided": true,
		}))
		.unwrap();
		mission.understanding.push(understanding);
		mission
	}

	fn draft(approved: bool, feedback: &str, answers: Vec<&str>) -> mission::Draft {
		mission::Draft {
			text: "On demande un export.".into(),
			questions: vec!["Filtre par date ?".into(), "Quel séparateur ?".into()],
			submitted_at: String::new(),
			review: Some(mission::Review {
				approved,
				feedback: feedback.into(),
				answers: answers.into_iter().map(String::from).collect(),
				at: String::new(),
			}),
		}
	}

	/// Valider la compréhension mène à l'approche — jamais directement au
	/// découpage, qui est le raccourci que le parcours ferme.
	#[test]
	fn valider_la_comprehension_mene_a_l_approche() {
		let mission = mission_with(draft(true, "", vec!["oui, par mois", ""]));
		let text = review_message(&mission, mission::Step::Understanding, true);
		assert!(text.contains("`approach`"));
		assert!(!text.contains("`plan`"));
		// Une réponse donnée voyage avec sa question ; une question laissée
		// sans réponse ne se transforme pas en réponse vide.
		assert!(text.contains("Filtre par date ? → oui, par mois"));
		assert!(!text.contains("Quel séparateur ?"));
	}

	/// Une correction porte son motif jusqu'au maître, et le ramène à la même
	/// étape.
	#[test]
	fn corriger_renvoie_le_motif_et_la_meme_etape() {
		let mission = mission_with(draft(false, "Ce n'est pas l'admin, c'est le client.", vec![]));
		let text = review_message(&mission, mission::Step::Understanding, false);
		assert!(text.contains("Ce n'est pas l'admin, c'est le client."));
		assert!(text.contains("`understand`"));
	}

	/// Un maître relancé repart de ce qui a été signé, pas du ticket seul.
	#[test]
	fn un_maitre_relance_retrouve_ce_qui_est_valide() {
		let mission = mission_with(draft(true, "", vec!["oui, par mois"]));
		let brief = guided_brief(&mission);
		assert!(brief.contains("Understanding approved"));
		assert!(brief.contains("On demande un export."));
		assert!(brief.contains("the approach is yours"));
	}
}
