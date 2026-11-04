pub mod accounts;
pub mod agent;
pub mod automations;
pub mod brief;
pub mod browser;
pub mod chantier;
pub mod codex;
pub mod commands;
pub mod config;
pub mod docs;
pub mod error;
pub mod executions;
pub mod files;
pub mod gates;
pub mod gemini;
pub mod git;
pub mod i18n;
pub mod platform;
pub mod impact;
pub mod integrations;
pub mod journal;
pub mod libre;
pub mod mcp;
pub mod metrics;
pub mod mission;
pub mod monitor;
pub mod notebook;
pub mod orchestrator;
pub mod panel;
pub mod permanence;
pub mod runner;
pub mod permissions;
pub mod prompts;
pub mod proof;
pub mod protocol;
pub mod properties;
pub mod qa;
pub mod relay;
pub mod remote;
pub mod resources;
pub mod review;
pub mod sandbox;
pub mod sessions;
pub mod slash;
pub mod speech;
pub mod strays;
pub mod system;
pub mod tasks;
pub mod team;
pub mod tickets;
pub mod terminal;
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
fn trigger_env_save(
	name: String,
	token: Option<String>,
	project_ref: Option<String>,
) -> Result<ConfigView> {
	let name = name.trim().to_string();
	if name.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.trigger.envNameRequired")));
	}

	let mut config = Config::load();
	let token = token.unwrap_or_default().trim().to_string();
	let project_ref = project_ref.unwrap_or_default().trim().to_string();

	match config
		.trigger
		.environments
		.iter_mut()
		.find(|env| env.name == name)
	{
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
	tasks::add(
		&task_scope(),
		&text,
		&priority.unwrap_or_else(|| "normal".into()),
	)
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
	let raw = runner::capture("/", "gh auth status 2>&1")
		.await
		.unwrap_or_default();
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
		return Err(CockpitError::msg(i18n::tf("lib.project.pathMissing", &[("path", &path)])));
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
		runner::capture(
			"/",
			&format!("gh auth token --user {} 2>/dev/null", quote(account)),
		)
		.await
	}
	.map_err(|_| CockpitError::msg(i18n::t("lib.project.noGhSession")))?;
	let token = token.trim().to_string();
	if token.is_empty() {
		return Err(CockpitError::msg(i18n::tf("lib.project.noGhToken", &[("account", &account)])));
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
	let out = runner::capture_with_env(
		&folder.to_string_lossy(),
		&command,
		&[("GH_TOKEN", token.as_str())],
	)
	.await?;
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
		return Err(CockpitError::msg(i18n::tf("lib.project.notGitRepo", &[("path", &main_repo)])));
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

	match config.projects.iter_mut().find(|entry| entry.id == id) {
		Some(existing) => *existing = saved,
		None => config.projects.push(saved),
	}
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
					.map(|p| p.to_string_lossy().to_string())
					.unwrap_or_default()
			}
			Err(_) => String::new(),
		};
		if let Ok(mut cache) = CACHE.lock() {
			cache.get_or_insert_with(Default::default).insert(path.clone(), repo.clone());
		}
		resolus.insert(path, repo);
	}

	resolus
}

#[tauri::command]
async fn git_branches(
	base: Option<String>,
	include_remote: Option<bool>,
) -> Result<git::BranchOverview> {
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
			Ok(()) => voice_input::ShortcutStatus { accelerator: accelerator.to_string(), registered: true, error: None },
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
	let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
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
	Shortcut::from_str(&accelerator).map_err(|e| CockpitError::msg(i18n::tf("lib.shortcut.unreadable", &[("error", &e)])))?;
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
		return Err(CockpitError::msg(status.error.unwrap_or_else(|| i18n::t("lib.shortcut.refused"))));
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
		.with_handler(move |app, _shortcut, event| {
			match event.state() {
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
	let result = git::stash_push(
		std::path::Path::new(&path),
		&message.unwrap_or_default(),
	)
	.await;
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
async fn git_create_pr(
	path: String,
	title: String,
	body: Option<String>,
	draft: Option<bool>,
) -> Result<String> {
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
		return Err(CockpitError::msg(i18n::tf("lib.github.prFromBase", &[("branch", &branch)])));
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
		journal::record("github", &i18n::t("lib.github.prCreation"), &branch, false, &error);
		return Err(CockpitError::msg(error));
	}

	let url = serde_json::from_str::<Value>(&raw)
		.ok()
		.and_then(|v| v.get("html_url").and_then(|u| u.as_str()).map(String::from))
		.unwrap_or_default();
	journal::record("github", &i18n::t("lib.github.prCreation"), &branch, true, &url);
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
fn permanence_halt(
	agents: tauri::State<'_, agent::SharedAgents>,
	reason: Option<String>,
) -> permanence::Halt {
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
	let choice = if choice.trim().is_empty() { String::new() } else { i18n::normalize(&choice).to_string() };
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
	let pulls = integrations::github_pulls_by_branch(&config)
		.await
		.unwrap_or_default();

	Ok(trees
		.into_iter()
		.map(|tree| {
			let dirty = tree.status.modified + tree.status.staged + tree.status.untracked;
			let pr = tree
				.branch
				.as_ref()
				.and_then(|branch| pulls.get(branch).cloned());

			let (removable, reason) = if tree.is_main {
				(false, i18n::t("lib.hygiene.mainRepo"))
			} else if dirty > 0 {
				(false, i18n::tf("lib.hygiene.dirty", &[("count", &dirty)]))
			} else if tree.status.ahead > 0 {
				(false, i18n::tf("lib.hygiene.unpushed", &[("count", &tree.status.ahead)]))
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

// ─────────────────────────────── Team board ───────────────────────────────

#[tauri::command]
async fn team_board(cycle_only: Option<bool>) -> Result<team::TeamBoard> {
	team::build_board(&cfg(), cycle_only.unwrap_or(true)).await
}

// ─────────────────────────── Pull requests ───────────────────────────

/// PR ouvertes du dépôt, avec CI et décision de review.
#[tauri::command]
async fn pull_requests() -> Result<Vec<team::PullRequest>> {
	let config = cfg();
	let token = integrations::github_token(&config).await?;
	let (owner, name) = config
		.github
		.repo
		.split_once('/')
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.github.repoFormat")))?;
	team::fetch_open_prs(&token, owner, name, &config.linear.team_key).await
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
async fn properties_calibrate(
	project: String,
	property: String,
) -> Result<properties::Calibration> {
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

/// État de santé d'un projet, tel qu'on veut le lire d'un coup d'œil.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectHealth {
	id: String,
	name: String,
	color: String,
	main_repo: String,
	github_repo: String,
	worktrees: usize,
	/// Worktrees avec du travail non commité.
	dirty: usize,
	/// Worktrees en avance sur leur amont : du travail non publié.
	unpushed: usize,
	open_prs: usize,
	ci_failing: usize,
	ready_to_merge: usize,
	/// Renseigné quand une source n'a pas répondu : le projet reste affiché
	/// avec ce qu'on a pu lire, plutôt que de disparaître de la liste.
	error: Option<String>,
}

/// Santé de tous les projets déclarés, pas seulement de l'actif.
///
/// Chaque projet est résolu avec ses propres réglages — un projet perso
/// interroge donc son compte GitHub et non celui de l'entreprise. Le local
/// (worktrees) est toujours lu ; le distant échoue proprement, projet par
/// projet, sans faire tomber la vue entière.
#[tauri::command]
async fn projects_health() -> Result<Vec<ProjectHealth>> {
	let base = Config::load();
	let mut out = Vec::new();

	let cloisonne = base.projects.len() > 1;
	for project in &base.projects {
		let mut resolved = base.clone();
		project.merge_into(&mut resolved, cloisonne);

		let repo = PathBuf::from(&resolved.general.main_repo);
		let trees = if repo.join(".git").exists() {
			git::list_worktrees(&repo).await.unwrap_or_default()
		} else {
			Vec::new()
		};
		let dirty = trees
			.iter()
			.filter(|tree| {
				tree.status.modified + tree.status.staged + tree.status.untracked > 0
			})
			.count();
		let unpushed = trees.iter().filter(|tree| tree.status.ahead > 0).count();

		let mut open_prs = 0;
		let mut ci_failing = 0;
		let mut ready_to_merge = 0;
		let mut error = None;

		if !resolved.github.repo.trim().is_empty() {
			match integrations::github_token(&resolved).await {
				Ok(token) => match resolved.github.repo.split_once('/') {
					Some((owner, name)) => match team::fetch_open_prs(
						&token,
						owner,
						name,
						&resolved.linear.team_key,
					)
					.await
					{
						Ok(prs) => {
							open_prs = prs.len();
							ci_failing = prs.iter().filter(|pr| pr.ci_state == "failing").count();
							ready_to_merge = prs
								.iter()
								.filter(|pr| {
									!pr.is_draft
										&& pr.review_decision == "APPROVED"
										&& pr.ci_state == "success"
								})
								.count();
						}
						Err(e) => error = Some(e.to_string()),
					},
					None => error = Some(i18n::t("lib.github.repoOwnerFormat")),
				},
				Err(e) => error = Some(e.to_string()),
			}
		}

		out.push(ProjectHealth {
			id: project.id.clone(),
			name: project.display_name(),
			color: project.color.clone(),
			main_repo: resolved.general.main_repo.clone(),
			github_repo: resolved.github.repo.clone(),
			worktrees: trees.len(),
			dirty,
			unpushed,
			open_prs,
			ci_failing,
			ready_to_merge,
			error,
		});
	}

	Ok(out)
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
		journal::record("github", &i18n::t("lib.github.prMerge"), &format!("#{number}"), false, &error);
		return Err(CockpitError::msg(error));
	}
	// Irréversible et visible de toute l'équipe : c'est le premier geste qu'on
	// veut retrouver dans le carnet de bord.
	journal::record("github", &i18n::t("lib.github.prMerge"), &format!("#{number}"), true, "");
	Ok(())
}

// ─────────────────────────── Agents pilotés ───────────────────────────

/// Démarre un agent — consigné : il va écrire dans le dépôt.
#[tauri::command]
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
fn agent_interrupt(
	agents: State<'_, agent::SharedAgents>,
	session_id: String,
) -> Result<()> {
	agent::interrupt(&agents, &session_id)
}

/// Demande l'état réel des serveurs MCP de cette session.
///
/// La réponse ne revient pas ici : elle traverse le flux de l'agent comme un
/// message de plus, et l'écran la reconnaît. C'est le même chemin que tout ce
/// que le CLI raconte, et il évite d'ouvrir une attente que la mort de l'agent
/// laisserait pendante.
#[tauri::command]
fn agent_probe_mcp(
	agents: State<'_, agent::SharedAgents>,
	session_id: String,
) -> Result<()> {
	agent::probe_mcp(&agents, &session_id)
}

/// Demande la répartition du contexte de cette session.
///
/// Même chemin que l'état des MCP : la réponse traverse le flux de l'agent.
#[tauri::command]
fn agent_probe_context(
	agents: State<'_, agent::SharedAgents>,
	session_id: String,
) -> Result<()> {
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
fn agent_reconnect_mcp(
	agents: State<'_, agent::SharedAgents>,
	session_id: String,
	server: String,
) -> Result<()> {
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
fn brief_assemble(
	sections: Vec<brief::BriefSection>,
	prompt: String,
	cwd: Option<String>,
) -> String {
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
fn command_line(
	command: config::CommandConfig,
	positional: String,
	values: Vec<(String, String)>,
) -> String {
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
async fn notebook_collect(
    agents: State<'_, agent::SharedAgents>,
    cwd: String,
) -> Result<Option<notebook::Handback>> {
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
		.filter(|mission| !mission.paused && mission.state == mission::MissionState::Running)
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
		let total = bucket.totals.input
			+ bucket.totals.output
			+ bucket.totals.cache_read
			+ bucket.totals.cache_write;
		if total < budget {
			continue;
		}
		let raison = i18n::tf("lib.budget.reason", &[("total", &total), ("budget", &budget)]);
		if mission::set_paused(id, true).is_ok() {
			journal::record(
				"mission",
				&i18n::t("lib.budget.paused"),
				titre,
				false,
				&raison,
			);
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
fn agent_attach_clipboard(
	session_id: String,
	name: String,
	data: String,
) -> Result<files::Attachment> {
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
async fn job_run(
	app: AppHandle,
	jobs: State<'_, SharedJobs>,
	request: JobRequest,
) -> Result<JobStatus> {
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
	terminal::open(
		app,
		terminals.inner().clone(),
		cwd,
		command,
		label,
		cols,
		rows,
		account,
	)
}

#[tauri::command]
fn terminal_write(
	terminals: State<'_, terminal::SharedTerminals>,
	id: String,
	data: String,
) -> Result<()> {
	terminal::write(terminals.inner(), &id, &data)
}

#[tauri::command]
fn terminal_resize(
	terminals: State<'_, terminal::SharedTerminals>,
	id: String,
	cols: u16,
	rows: u16,
) -> Result<()> {
	terminal::resize(terminals.inner(), &id, cols, rows)
}

#[tauri::command]
fn terminal_close(terminals: State<'_, terminal::SharedTerminals>, id: String) -> Result<()> {
	terminal::close(terminals.inner(), &id)
}

/// Regarde le navigateur d'un workspace, en le lançant s'il ne tourne pas.
#[tauri::command]
async fn browser_watch(browsers: State<'_, browser::SharedBrowsers>, cwd: String) -> Result<()> {
	browser::watch(browsers.inner().clone(), cwd).await
}

/// L'image suivante de la page, en binaire : l'interface la demande quand elle
/// a dessiné la précédente.
#[tauri::command]
async fn browser_frame(
	browsers: State<'_, browser::SharedBrowsers>,
	cwd: String,
	after: u64,
) -> Result<tauri::ipc::Response> {
	Ok(tauri::ipc::Response::new(browser::frame(browsers.inner(), &cwd, after).await?))
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
fn browser_act(
	browsers: State<'_, browser::SharedBrowsers>,
	cwd: String,
	action: browser::Action,
) -> Result<()> {
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

// ───────────────────────────── Automatisations ─────────────────────────────

#[tauri::command]
fn automations_overview() -> Vec<automations::Overview> {
	automations::overview()
}

#[tauri::command]
fn automation_save(automation: automations::Automation) -> Result<automations::Automation> {
	automations::save(automation)
}

#[tauri::command]
fn automation_remove(id: String) -> Result<()> {
	automations::remove(&id)
}

/// « Lancer maintenant » : une exécution à la main, qui ne déplace pas le point
/// de départ de la suivante — voir `automations::Trigger::Manual`.
#[tauri::command]
fn automation_run_now(app: AppHandle, id: String) -> Result<String> {
	let automation = automations::list()
		.into_iter()
		.find(|entry| entry.id == id)
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.automationNotFound")))?;
	let occurrence = format!("manual-{}", chrono::Utc::now().timestamp_millis());
	automations::start(app, automation, occurrence, automations::Trigger::Manual)
}

#[tauri::command]
fn automation_drop_line(id: String, run: String, line: String, dropped: bool) {
	automations::drop_line(&id, &run, &line, dropped);
}

#[tauri::command]
fn automation_latest_daily() -> Option<automations::Run> {
	automations::latest_daily()
}

/// Un essai à blanc : rien n'est rangé, rien n'est envoyé.
#[tauri::command]
async fn automation_try(automation: automations::Automation) -> Result<automations::Run> {
	automations::try_once(automation).await
}

#[tauri::command]
fn automation_correct(id: String, text: String) -> Result<automations::Automation> {
	automations::add_correction(&id, &text)
}

/// Met le rendu en PDF et l'ouvre.
#[tauri::command]
async fn automation_export_pdf(id: String, run: String) -> Result<String> {
	let path = automations::export_pdf(&id, &run).await?;
	system::open_file(&path).await?;
	Ok(path)
}

#[tauri::command]
async fn automation_post_slack(id: String, run: String) -> Result<()> {
	automations::post_slack(&id, &run).await
}

/// Le dossier des PDF d'une automatisation, dans le Finder.
#[tauri::command]
async fn automation_reveal_exports(id: String) -> Result<()> {
	let dir = automations::exports_dir(&id);
	std::fs::create_dir_all(&dir)?;
	system::reveal_in_finder(&dir.display().to_string()).await
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
static ZOOM_MEMORY: std::sync::OnceLock<
	std::sync::Mutex<Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)>>,
> = std::sync::OnceLock::new();

/// Bascule entre le plein écran de travail et le cadre précédent.
///
/// Le double-clic sur la barre de titre passait par la maximisation de Tauri,
/// qui délègue au zoom d'AppKit : celui-ci s'arrête à quelques pixels des bords,
/// et comme macOS considère alors la fenêtre déjà zoomée, le double-clic suivant
/// la rétrécissait au lieu de finir le travail — impossible d'occuper l'écran.
/// On applique donc nous-mêmes la zone de travail du moniteur où la fenêtre se
/// trouve, barre de menus et Dock exclus.
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

/// Ce qu'un découpage de `taskCount` tâches coûtera, d'après les missions
/// closes de taille voisine. Sert au moment d'approuver un plan : c'est le seul
/// instant où l'on peut encore décider de ne pas le lancer.
#[tauri::command(async)]
fn mission_estimate(task_count: usize) -> mission::Estimate {
	mission::estimate(task_count)
}

/// Les tâches qui débordent de ce qu'une tâche coûte d'ordinaire.
///
/// Rien n'est coupé : une tâche longue peut être une tâche difficile, et le
/// cockpit n'a pas de quoi trancher. Il dit ce qu'il voit, et laisse la
/// décision — reprendre, redécouper, arrêter — à qui pilote.
#[tauri::command(async)]
fn mission_overruns() -> Vec<mission::Overrun> {
	mission::all_overruns()
}

/// Toutes les missions, tous projets confondus.
///
/// Pour la carte, qui montre chaque projet comme une île sans changer de projet
/// actif : c'est l'écran qui les range sous le dépôt de chacun (`Mission.cwd`).
#[tauri::command(async)]
fn missions_everywhere() -> Vec<mission::Mission> {
	mission::list()
}

#[tauri::command(async)]
fn missions_list() -> Vec<mission::Mission> {
	// Les missions du projet affiché, et elles seules : une mission ouverte sur
	// un dépôt n'a rien à faire dans l'écran d'un autre. Le lanceur, lui,
	// continue de les voir toutes — il fait avancer ce qui tourne, quel que soit
	// le projet qu'on regarde.
	let repo = cfg().general.main_repo;
	mission::list()
		.into_iter()
		.filter(|mission| mission.belongs_to(&repo))
		.collect()
}

#[tauri::command(async)]
fn mission_get(id: String) -> Result<mission::Mission> {
	mission::get(&id)
}

#[tauri::command]
fn mission_create(
	title: String,
	ticket: Option<String>,
	ticket_url: Option<String>,
	cwd: Option<String>,
	branch: Option<String>,
) -> Result<mission::Mission> {
	mission::create(
		&title,
		&ticket.unwrap_or_default(),
		&ticket_url.unwrap_or_default(),
		&cwd.unwrap_or_else(|| cfg().general.main_repo.clone()),
		&branch.unwrap_or_default(),
		!cfg().missions.autonomous,
	)
}

/// Le nécessaire pour ouvrir une mission depuis un ticket, et le ticket
/// lui-même — `mission_start_from_ticket` s'en sert pour donner au maître ce
/// qu'il sait déjà, sans lui faire redemander la même chose par MCP.
async fn create_mission_from_ticket(
	reference: &str,
) -> Result<(mission::Mission, tickets::TicketDetail)> {
	let config = cfg();
	let identifier = mission::ticket_reference(reference);
	if identifier.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.mission.ticketReferenceRequired")));
	}

	let ticket = tickets::provider(&config)?.get(&identifier).await?;
	let branch = if ticket.branch_name.trim().is_empty() {
		mission::branch_from(&ticket.identifier, &ticket.title)
	} else {
		ticket.branch_name.clone()
	};

	let mission = mission::create(
		&ticket.title,
		&ticket.identifier,
		&ticket.url,
		&config.general.main_repo,
		&branch,
		!config.missions.autonomous,
	)?;
	Ok((mission, ticket))
}

/// Ouvre une mission à partir d'un ticket : une URL collée suffit.
///
/// Le titre, l'identifiant et la branche viennent du suivi de tâches. Les
/// redemander à quelqu'un qui a déjà le ticket sous les yeux, c'est lui faire
/// recopier ce que la machine sait lire.
#[tauri::command]
async fn mission_from_ticket(reference: String) -> Result<mission::Mission> {
	create_mission_from_ticket(&reference)
		.await
		.map(|(mission, _)| mission)
}

/// Ce que le ticket dit déjà, mis en forme pour le premier prompt du maître.
///
/// Sans ça, le maître ne recevait que le titre et l'URL — le reste, il devait
/// aller le chercher lui-même par un outil MCP Linear/GitHub. Un agent isolé
/// n'en a pas forcément (identité séparée du poste, voir `sandbox.rs`) : il
/// restait bloqué sur « je n'ai pas accès à Linear » avant même de commencer,
/// alors que le cockpit avait déjà tout lu pour ouvrir la mission.
fn ticket_brief(ticket: &tickets::TicketDetail) -> String {
	let mut brief = String::new();
	if !ticket.description.trim().is_empty() {
		brief.push_str(&format!(
			"── The ticket, as read when the mission was opened ──\n{}",
			ticket.description.trim()
		));
	}
	if !ticket.comments.is_empty() {
		if !brief.is_empty() {
			brief.push_str("\n\n");
		}
		brief.push_str("── Comments, oldest to newest ──\n");
		for comment in ticket.comments.iter().rev().take(5).rev() {
			brief.push_str(&format!(
				"- {}: {}\n",
				comment.author,
				comment.body.trim()
			));
		}
	}
	brief
}

#[cfg(test)]
mod ticket_brief_tests {
	use super::*;

	fn ticket(description: &str, comments: Vec<(&str, &str)>) -> tickets::TicketDetail {
		tickets::TicketDetail {
			id: "1".into(),
			identifier: "NW-1".into(),
			title: "Titre".into(),
			description: description.into(),
			url: String::new(),
			priority: 0,
			estimate: None,
			branch_name: String::new(),
			updated_at: String::new(),
			state: None,
			assignee: None,
			labels: Vec::new(),
			comments: comments
				.into_iter()
				.map(|(author, body)| integrations::LinearComment {
					id: String::new(),
					body: body.into(),
					author: author.into(),
					created_at: String::new(),
				})
				.collect(),
		}
	}

	#[test]
	fn un_ticket_sans_rien_rend_un_brief_vide() {
		assert_eq!(ticket_brief(&ticket("", vec![])), "");
	}

	#[test]
	fn la_description_se_retrouve_dans_le_brief() {
		let brief = ticket_brief(&ticket("Le bouton ne répond plus au double clic.", vec![]));
		assert!(brief.contains("Le bouton ne répond plus au double clic."));
	}

	#[test]
	fn les_commentaires_recents_accompagnent_la_description() {
		let brief = ticket_brief(&ticket(
			"Description.",
			vec![("Frank", "Vu en prod hier soir."), ("Alice", "Confirmé, je regarde.")],
		));
		assert!(brief.contains("Frank"));
		assert!(brief.contains("Vu en prod hier soir."));
		assert!(brief.contains("Alice"));
	}
}

/// Ce que fabriquent le maître et les exécutants, en ce moment même.
///
/// Une mission qui affiche « maître actif » sans rien d'autre ne dit pas si
/// l'agent réfléchit, s'il attend une autorisation ou s'il a fini depuis dix
/// minutes. C'est cette information-là qu'on regarde, pas l'état stocké.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentActivity {
	session_id: String,
	/// Le processus tourne encore.
	running: bool,
	/// Il a écrit dans les dernières secondes.
	working: bool,
	/// Sa dernière phrase, ou le dernier outil appelé.
	last: String,
	/// Nombre de demandes d'autorisation en attente pour cet agent.
	waiting: usize,
}

#[tauri::command(async)]
fn mission_activity(app: AppHandle, id: String) -> Result<serde_json::Value> {
	use tauri::Manager;
	let mission = mission::get(&id)?;
	let agents = app
		.try_state::<agent::SharedAgents>()
		.map(|agents| agents.snapshot())
		.unwrap_or_default();
	let pending = permissions::pending();

	let activity = |session: Option<&str>| -> Option<AgentActivity> {
		let session = session?;
		let status = agents.iter().find(|entry| entry.session_id == session);
		let claude = status.and_then(|entry| entry.claude_session_id.clone());
		let file = claude.as_deref().and_then(remote::session_file);

		let (last, working) = match file.as_deref() {
			Some(path) => {
				let events = sessions::read_timeline(std::path::Path::new(path), 200)
					.unwrap_or_default();
				let last = events
					.iter()
					.rev()
					.find(|event| !event.text.trim().is_empty())
					.map(|event| event.text.chars().take(200).collect::<String>())
					.unwrap_or_default();
				(last, remote::recently_active(path))
			}
			// Aucune session Claude capturée : soit l'agent tourne encore sans
			// avoir répondu, soit il est mort avant d'y arriver — auquel cas ce
			// même instant a versé pourquoi au journal (voir `agent::spawn_reader`).
			// Sans ça, un maître qui meurt en silence n'affiche jamais que
			// « arrêté », sans un mot de plus à qui regarde après coup.
			None => {
				// Le titre traduit d'aujourd'hui, ou l'ancien libellé français
				// des entrées écrites avant la traduction.
				let died = i18n::t("agent.journal.diedBeforeFirstAnswer");
				let cause = journal::list(200)
					.into_iter()
					.find(|entry| {
						entry.kind == "agent"
							&& entry.target == session
							&& (entry.label == died
								|| entry.label == "Agent arrêté avant sa première réponse")
					})
					.map(|entry| entry.detail);
				(cause.unwrap_or_default(), false)
			}
		};

		Some(AgentActivity {
			session_id: session.to_string(),
			running: status.map(|entry| entry.running).unwrap_or(false),
			working,
			last,
			waiting: pending
				.iter()
				.filter(|request| request.session_id.as_deref() == Some(session))
				.count(),
		})
	};

	Ok(serde_json::json!({
		"master": activity(mission.master_session.as_deref()),
		"tasks": mission
			.tasks
			.iter()
			.filter_map(|task| {
				let entry = activity(task.session_id.as_deref())?;
				Some(serde_json::json!({ "taskId": task.id, "activity": entry }))
			})
			.collect::<Vec<_>>(),
	}))
}

/// Fil complet d'un agent, quel que soit qui l'a lancé.
///
/// L'interface tient l'historique des agents qu'elle a démarrés elle-même. Ceux
/// que le cockpit lance de son côté — le maître d'une mission, ses exécutants —
/// lui étaient inconnus : elle les affichait comme des onglets vides, quand
/// elle les affichait. Elle peut désormais adopter leur conversation.
#[tauri::command(async)]
fn agent_timeline(session_id: String, app: AppHandle) -> Result<Vec<sessions::SessionEvent>> {
	use tauri::Manager;
	let claude = app
		.try_state::<agent::SharedAgents>()
		.map(|agents| agents.snapshot())
		.unwrap_or_default()
		.into_iter()
		.find(|status| status.session_id == session_id)
		.and_then(|status| status.claude_session_id);

	timeline_of(&session_id, claude.as_deref())
}

/// Le choix de la source, isolé de l'état de l'application.
///
/// `claude_session` est la conversation Claude Code de cet agent, quand le
/// registre la connaît encore — il ne la connaît plus une fois le cockpit
/// redémarré, et c'est précisément le cas qui rend le relevé utile.
///
/// Détaché de la commande pour être éprouvé pour de vrai : une recette qui
/// réimplémenterait ce choix ne prouverait que sa propre copie.
pub fn timeline_of(
	session_id: &str,
	claude_session: Option<&str>,
) -> Result<Vec<sessions::SessionEvent>> {
	// Le journal de Claude Code d'abord, quand il existe : c'est la source la
	// plus riche, et la seule à porter les sous-agents.
	if let Some(file) = claude_session.and_then(remote::session_file) {
		return sessions::read_timeline(std::path::Path::new(&file), 400);
	}

	// Sinon le relevé du cockpit. C'est ce qui donne un historique aux moteurs
	// qui n'en laissent aucun sur le disque — Codex, dont le format de session
	// n'est pas documenté de façon vérifiable, et Gemini, qui n'en écrit pas.
	// Jusqu'ici cet écran leur répondait par une conversation vide dès que le
	// cockpit avait été fermé.
	//
	// La dernière exécution de cette session, et non leur somme : un agent par
	// tour en ouvre une seule, et deux exécutions sur une même session seraient
	// deux conversations distinctes qu'on n'a aucune raison de recoller.
	let Some(execution) = executions::for_session(session_id).pop() else {
		return Ok(Vec::new());
	};
	Ok(executions::timeline_as_events(&execution.id))
}

#[tauri::command]
fn mission_remove(id: String) -> Result<()> {
	mission::remove(&id)
}

/// Déclare la branche sur laquelle la pull request finale se greffera.
///
/// Une mission qui prolonge un travail encore en revue ne doit pas viser la
/// branche par défaut : sa PR y montrerait aussi ce que la précédente contient
/// déjà. Empilée sur la branche parente, elle ne montre que ce qu'elle ajoute —
/// et la forge affiche la dépendance entre les deux.
#[tauri::command]
fn mission_set_base(id: String, base: String) -> Result<mission::Mission> {
	mission::set_base(&id, &base)
}

/// Relance une tâche en lui faisant tout reprendre depuis le début.
///
/// Une vérification garde en mémoire ce qu'elle a déjà lu, et ne rejuge ensuite
/// que les changements — c'est ce qui rend les reprises rapides. Encore
/// faut-il pouvoir dire « recommence tout » : après un correctif qui touche à
/// l'architecture, un verdict rendu sur l'ancien code ne vaut plus rien.
#[tauri::command]
async fn mission_task_rerun(app: AppHandle, id: String, task_id: String) -> Result<String> {
	use tauri::Manager;
	let mission = mission::get(&id)?;
	let task = mission
		.tasks
		.iter()
		.find(|task| task.id == task_id)
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.mission.unknownTask")))?;

	// L'agent en place travaille sur l'ancienne consigne : on le coupe avant
	// d'en lancer un autre, sinon les deux écrivent au même endroit.
	if let (Some(agents), Some(session)) = (
		app.try_state::<agent::SharedAgents>(),
		task.session_id.as_ref(),
	) {
		let _ = agent::stop(agents.inner(), session);
	}

	mission::set_checkpoint(&id, &task_id, "")?;
	mission::set_task_state(
		&id,
		&task_id,
		mission::TaskState::Planned,
		&i18n::t("lib.mission.fullReviewRequested"),
	)?;
	launch_task_agent(app, &id, &task_id, journal::HUMAN).await
}

/// Efface la mission et tout ce qu'elle a créé. Sans retour possible.
#[tauri::command]
async fn mission_purge(app: AppHandle, id: String) -> Result<Vec<String>> {
	stop_mission_agents(&app, &id);
	mission::purge(&id).await
}

/// Coupe tous les agents d'une mission — le maître et ses exécutants.
///
/// Arrêter les processus ne suffit pas : une tâche laissée « en cours » ne
/// serait plus jamais reprise par le lanceur, qui ne regarde que ce qui reste à
/// faire. On la remet donc à faire, son worktree et son travail intacts.
fn stop_mission_agents(app: &AppHandle, id: &str) -> usize {
	use tauri::Manager;
	let Ok(mission) = mission::get(id) else {
		return 0;
	};
	let Some(agents) = app.try_state::<agent::SharedAgents>() else {
		return 0;
	};
	let agents = agents.inner().clone();

	let mut stopped = 0;
	if let Some(session) = &mission.master_session {
		let _ = agent::stop(&agents, session);
		stopped += 1;
	}
	for task in &mission.tasks {
		if let Some(session) = &task.session_id {
			let _ = agent::stop(&agents, session);
			stopped += 1;
		}
		if task.state == mission::TaskState::Running {
			let _ = mission::set_task_state(
				id,
				&task.id,
				mission::TaskState::Planned,
				&i18n::t("lib.mission.workerStopped"),
			);
		}
	}
	let _ = mission::update_master_session(id, None);
	stopped
}

/// Suspend une mission : plus rien ne part, les agents en cours sont coupés.
#[tauri::command]
fn mission_pause(app: AppHandle, id: String) -> Result<mission::Mission> {
	stop_mission_agents(&app, &id);
	mission::set_paused(&id, true)
}

/// Ce qu'un maître doit savoir en reprenant une mission déjà en route.
///
/// Sans ce rappel, le prompt de lancement le remet au premier jour : il lit le
/// ticket, propose un découpage — alors que son plan est approuvé et que ses
/// exécutants travaillent depuis une heure. On lui dit donc où en est la
/// mission, et surtout de constater avant d'agir.
fn resume_brief(mission: &mission::Mission) -> String {
	let taches = mission
		.tasks
		.iter()
		.map(|task| {
			format!(
				"- `{}` {} — {:?}{}",
				task.role,
				task.title,
				task.state,
				if task.note.trim().is_empty() {
					String::new()
				} else {
					format!(" ({})", task.note.trim())
				}
			)
		})
		.collect::<Vec<_>>()
		.join("\n");

	format!(
		"── Resuming ──\n\
		 This mission was already under way: Cockpit restarted, not the mission. Its \
		 state is `{:?}`{}.\n\n\
		 {}\n\n\
		 Start with `status` to see the mission as it is now, and carry on from there. \
		 Do not re-plan what is already broken down, and do not relaunch what is \
		 running: Cockpit restarts the pending tasks by itself.",
		mission.state,
		if mission.plan.trim().is_empty() {
			""
		} else {
			", its plan is set"
		},
		if taches.is_empty() {
			"No task has been created yet.".to_string()
		} else {
			format!("Its tasks, as last known:\n{taches}")
		},
	)
}

/// Reprend une mission suspendue, et relance d'un coup ce qui doit tourner.
#[tauri::command]
async fn mission_resume(app: AppHandle, id: String) -> Result<mission::Mission> {
	mission::set_paused(&id, false)?;
	// Un maître absent n'empêche pas les exécutants de repartir, mais c'est lui
	// qui recompose à la fin : on le remet debout tant qu'on y est.
	let mission = mission::get(&id)?;
	if mission.master_session.is_none() && mission.state != mission::MissionState::Done {
		let brief = resume_brief(&mission);
		let _ = launch_master(
			app.clone(),
			id.clone(),
			Some(brief),
			executions::Origin::human(),
		)
		.await;
	}
	launch_ready_tasks(app, &id).await;
	mission::get(&id)
}

/// Remet debout les maîtres des missions qu'un redémarrage a décapitées.
///
/// `recover_all` rend leurs tâches reprenables et le lanceur les fait repartir :
/// les exécutants revenaient donc seuls, sans personne pour lire leurs verdicts
/// ni recomposer à la fin. La mission avançait en apparence et s'arrêtait à
/// l'intégration, sans que rien ne dise ce qui manquait.
///
/// Une mission en pause reste en pause : c'est un geste explicite, et le
/// redémarrage n'a pas à le défaire.
async fn relaunch_mission_masters(app: &AppHandle) -> usize {
	let mut relancés = 0;
	for mission in mission::list() {
		if mission.paused || mission.master_session.is_some() {
			continue;
		}
		if matches!(
			mission.state,
			mission::MissionState::Done | mission::MissionState::Failed
		) {
			continue;
		}
		let brief = resume_brief(&mission);
		if launch_master(
			app.clone(),
			mission.id.clone(),
			Some(brief),
			executions::Origin::cockpit(config::MASTER_ROLE),
		)
			.await
			.is_ok()
		{
			relancés += 1;
		}
	}
	relancés
}

/// Coupe tout et abandonne la mission — le travail déjà produit reste en place.
#[tauri::command]
fn mission_stop(app: AppHandle, id: String) -> Result<mission::Mission> {
	stop_mission_agents(&app, &id);
	mission::set_paused(&id, true)?;
	mission::set_state(
		&id,
		mission::MissionState::Failed,
		&i18n::t("lib.mission.stopped"),
	)
}

/// Enregistre un plan et le met en attente d'approbation.
#[tauri::command]
fn mission_plan(id: String, plan: String, tasks: Vec<mission::Task>) -> Result<mission::Mission> {
	mission::submit_plan(&id, &plan, tasks)
}

#[tauri::command]
async fn mission_approve(app: AppHandle, id: String) -> Result<mission::Mission> {
	let mission = mission::approve(&id)?;
	// Le feu vert vaut lancement : on ne fait pas cliquer une seconde fois.
	launch_ready_tasks(app, &id).await;
	mission::get(&mission.id)
}

#[tauri::command]
fn mission_state(id: String, state: mission::MissionState, note: Option<String>) -> Result<mission::Mission> {
	mission::set_state(&id, state, &note.unwrap_or_default())
}

#[tauri::command]
fn mission_task_add(id: String, task: mission::Task) -> Result<mission::Mission> {
	mission::add_task(&id, task)
}

#[tauri::command]
fn mission_task_state(
	id: String,
	task_id: String,
	state: mission::TaskState,
	note: Option<String>,
) -> Result<mission::Mission> {
	mission::set_task_state(&id, &task_id, state, &note.unwrap_or_default())
}

/// Rattache un agent en cours à une tâche — ou au maître si `taskId` est vide.
#[tauri::command]
fn mission_attach(id: String, task_id: String, session_id: String) -> Result<mission::Mission> {
	if task_id.trim().is_empty() {
		mission::attach_master(&id, &session_id)
	} else {
		mission::attach_task(&id, &task_id, &session_id)
	}
}

/// Lance l'exécutant d'une tâche, avec la consigne de son rôle.
///
/// Le prompt se compose ici plutôt que dans l'interface : il porte le contrat
/// de la tâche — sa mission, sa branche d'intégration, son périmètre — et ce
/// contrat ne doit pas dépendre de ce qu'un écran a bien voulu recopier.
#[tauri::command]
async fn mission_task_launch(
	app: AppHandle,
	agents: State<'_, agent::SharedAgents>,
	id: String,
	task_id: String,
) -> Result<String> {
	let _ = agents;
	launch_task_agent(app, &id, &task_id, journal::HUMAN).await
}

/// Lancement d'un exécutant, appelé aussi bien par l'interface que par le
/// maître : un seul chemin, donc un seul prompt et une seule politique.
///
/// `actor` dit qui l'a demandé — [`executions::MASTER`] quand c'est le maître de
/// la mission, [`journal::HUMAN`] pour un geste dans l'interface,
/// [`executions::COCKPIT`] pour une boucle qui lance ce qui est devenu prêt. Le
/// rôle, la tâche et le numéro de tentative, eux, se lisent sur la tâche.
pub async fn launch_task_agent(
	app: AppHandle,
	id: &str,
	task_id: &str,
	actor: &str,
) -> Result<String> {
	use tauri::Manager;
	let agents = app
		.try_state::<agent::SharedAgents>()
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.mission.agentsUnavailable")))?
		.inner()
		.clone();
	let id = id.to_string();
	let task_id = task_id.to_string();
	let mission = mission::get(&id)?;
	let task = mission
		.tasks
		.iter()
		.find(|task| task.id == task_id)
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.mission.unknownTask")))?
		.clone();

	if !mission.can_launch() {
		return Err(CockpitError::msg(i18n::t("lib.mission.awaitingAgreement")));
	}

	// Le catalogue du projet de la mission, pas celui de l'écran affiché : les
	// missions tournent en fond, souvent devant l'onglet d'un autre produit, et
	// c'est ainsi qu'une recette partait sans la commande `/self-qa` de son
	// équipe.
	let role = role_config(&mission.cwd, &task.role)
		.ok_or_else(|| CockpitError::msg(i18n::tf("lib.mission.unknownRole", &[("role", &task.role)])))?;

	// Sans worktree, on ne lance pas. Le repli d'avant envoyait l'exécutant dans
	// `mission.cwd` — le dépôt principal, celui où l'utilisateur a sa propre
	// branche sortie — avec pour consigne de commiter son travail. Les commits
	// de la mission atterrissaient donc dans son `dev` local, mêlés aux siens,
	// et le worktree principal devenait un chantier. Mieux vaut préparer le
	// terrain, ou refuser en le disant.
	let cwd = if task.worktree.trim().is_empty() {
		match orchestrator::prepare_worktree(&mission, &task).await {
			Ok(worktree) => {
				mission::set_task_worktree(&mission.id, &task.id, &worktree)?;
				worktree
			}
			Err(error) => {
				let raison = i18n::tf("lib.mission.workerWorktreeFailed", &[("error", &error)]);
				let _ = mission::set_task_state(
					&mission.id,
					&task.id,
					mission::TaskState::Failed,
					&raison,
				);
				return Err(CockpitError::msg(raison));
			}
		}
	} else {
		task.worktree.clone()
	};

	// Une tâche qui vérifie ne voit sinon aucune de ses sœurs : rien d'autre
	// que l'intégration finale ne fusionne quoi que ce soit avant elle. Sans
	// ce pas, elle jugeait une branche vide de tout le reste, et ne
	// découvrait une incompatibilité qu'en la fusionnant elle-même, à la
	// main — voir `orchestrator::sync_verifier_worktree`.
	let mut cohabitation = String::new();
	if role.verifies {
		match orchestrator::sync_verifier_worktree(&mission, &task, &cwd).await {
			Ok(rapport) if !rapport.conflicts.is_empty() => {
				cohabitation = format!(
					"\n\n── Coexistence with the other batches ──\n\
					 {} merged cleanly. In conflict, not merged — report it, it is a fact to \
					 deal with, not an assumption for you to check yourself: {}.",
					rapport.merged.len(),
					rapport.conflicts.join(", "),
				);
			}
			Ok(_) => {}
			Err(error) => {
				journal::record(
					"mission",
					&i18n::t("lib.mission.coexistenceUnchecked"),
					&task.title,
					false,
					&error.to_string(),
				);
			}
		}
	}

	let scope = if task.scope.is_empty() {
		"No scope declared: still stay within your responsibility.".to_string()
	} else {
		format!(
			"You only modify these paths: {}. Any write elsewhere will be refused.",
			task.scope.join(", ")
		)
	};

	let prompt = format!(
		"{role_prompt}

		 ── Mission: {mission_title}{ticket}
		 ── Your task: {task_title}
		 ── Integration branch: {branch}
		 {scope}

		 {brief}

		 The shared contracts — types, routes, schemas — are set on the integration 		 branch: follow them, and report what you are missing rather than inventing it.

		 {directive}",
		directive = i18n::reply_directive(),
		role_prompt = role.prompt,
		mission_title = mission.title,
		ticket = if mission.ticket.is_empty() {
			String::new()
		} else {
			format!(" ({})", mission.ticket)
		},
		task_title = task.title,
		branch = if mission.branch.is_empty() {
			"not set".into()
		} else {
			mission.branch.clone()
		},
		scope = scope,
		brief = task.brief,
	);
	let prompt = format!("{prompt}{cohabitation}");

	// Une vérification produit des preuves — captures, relevés d'API, rapports —
	// et git les ignore : elles n'ont rien à faire dans la branche qui partira en
	// production. Elles servent à l'ouverture de la pull request, et le cockpit
	// les rassemble lui-même dans le worktree d'intégration. Encore faut-il
	// qu'elles soient déposées là où il sait les trouver.
	let prompt = if role.verifies {
		format!(
			"{prompt}\n\n\
			 Put your evidence — screenshots, outputs, readings — under `.claude/work/qa/` \
			 in your worktree. It stays out of the branch, git ignores it: Cockpit \
			 gathers it when opening the pull request. Other people's code, however, \
			 is not to be touched."
		)
	} else {
		prompt
	};

	// Une vérification qui repasse sait où elle s'était arrêtée : relire vingt
	// fichiers pour valider une correction d'une ligne est ce qui faisait durer
	// les missions des heures. Elle reste libre d'élargir si le correctif touche
	// à ce qu'elle avait déjà validé.
	let prompt = if task.checkpoint.trim().is_empty() {
		prompt
	} else {
		format!(
			"{prompt}\n\n── You have already checked this work ──\n\
			 On your last pass, the branches were here: {}\n\
			 Focus on what has changed since — `git diff <sha>..<branch>` gives it to \
			 you. No need to redo everything: your previous verdict holds for the rest, \
			 unless the fix calls it into question.",
			task.checkpoint
		)
	};

	// La commande du rôle porte la méthode de l'équipe — lire un ticket, suivre
	// des conventions. Elle passe en tête : le reste du message lui sert de
	// contexte.
	let command = fill_command(&role.command, &mission, Some(&task));
	let prompt = if command.is_empty() {
		prompt
	} else {
		format!("{command}\n\n{prompt}")
	};

	// Un exécutant travaille seul, longtemps, sans personne pour compléter sa
	// consigne : c'est celui à qui il manque le plus de savoir ce que le cockpit
	// sait déjà — les leçons du carnet surtout, qui disent ce qu'on a eu à
	// reprendre dans ce dépôt.
	//
	// Au premier passage seulement : une tâche renvoyée en correction reprend sa
	// conversation, où le contexte est déjà chargé. Le lui renvoyer reviendrait à
	// le payer une fois de plus à chaque aller-retour.
	let prompt = if task.engine_session.trim().is_empty() {
		brief::for_agent(&cwd, &prompt).await
	} else {
		prompt
	};

	let session = agent::start_with_mission(
		app,
		agents,
		cwd,
		prompt,
		Some(role.permission_mode.clone()).filter(|mode| !mode.trim().is_empty()),
		Some(role.model.clone()).filter(|model| !model.is_empty()),
		// Reprendre plutôt que refaire : une tâche renvoyée en correction repart
		// sur la conversation qu'elle avait, avec son contexte déjà chargé. Vide
		// au premier passage — il n'y a rien à reprendre.
		Some(task.engine_session.clone()).filter(|session| !session.trim().is_empty()),
		Some(mission.id.clone()),
		// Le moteur du rôle : une recette peut être jugée par un autre modèle que
		// celui qui a écrit le code.
		Some(role.engine.clone()).filter(|engine| !engine.trim().is_empty()),
		role.depth.clone(),
		// Le périmètre voyage jusqu'au pont d'autorisation, qui refuse les
		// écritures du dehors quel que soit le mode. Sans lui, la barrière
		// annoncée à l'exécutant — « toute écriture ailleurs sera refusée » —
		// n'existait pas : un exécutant en `bypassPermissions` ne dépose aucune
		// demande, et il n'y avait donc rien à relire pour la faire respecter.
		task.scope.clone(),
		executions::Origin {
			actor: actor.to_string(),
			..executions::Origin::master(&task.role, &task.id, task.attempts)
		},
	)
	.await?;

	mission::attach_task(&id, &task_id, &session)?;
	journal::record(
		"mission",
		&i18n::t("lib.mission.workerLaunched"),
		&task.title,
		true,
		&format!("{} · {}", mission.title, task.role),
	);
	Ok(session)
}

/// Ouvre une mission depuis un ticket et lance son maître, d'un seul geste.
///
/// Le chemin ordinaire demandait de copier l'adresse du ticket, d'aller dans
/// Missions, de la coller, puis de lancer le maître : trois gestes pour une
/// intention unique, et autant d'occasions de se tromper de ticket. Ici on part
/// de ce qu'on regarde.
///
/// Une mission déjà ouverte sur ce ticket est rendue telle quelle plutôt que
/// doublée. Deux missions sur un même ticket viseraient la même branche
/// d'intégration et les mêmes worktrees : la seconde échouerait, ou pire,
/// reprendrait le travail de la première à son compte.
#[tauri::command]
async fn mission_start_from_ticket(app: AppHandle, reference: String) -> Result<Value> {
	let identifier = mission::ticket_reference(&reference);
	if identifier.is_empty() {
		return Err(CockpitError::msg(i18n::t("lib.mission.ticketNoId")));
	}

	let ouverte = mission::list().into_iter().find(|mission| {
		mission.ticket.eq_ignore_ascii_case(&identifier)
			&& !matches!(
				mission.state,
				mission::MissionState::Done | mission::MissionState::Failed
			)
	});
	if let Some(mission) = ouverte {
		return Ok(serde_json::json!({
			"mission": mission,
			"started": false,
			"message": i18n::tf("lib.mission.alreadyOpen", &[("identifier", &identifier)]),
		}));
	}

	let (mission, ticket) = create_mission_from_ticket(&reference).await?;
	let guided = mission.guided;
	// Le maître lancé dans la foulée : une mission ouverte et laissée sans maître
	// n'a rien fait avancer, et il faudrait revenir la démarrer à la main.
	let brief = ticket_brief(&ticket);
	let session = launch_master(
		app,
		mission.id.clone(),
		Some(brief),
		executions::Origin::human(),
	)
	.await?;
	let message = if guided {
		i18n::tf("lib.mission.openedGuided", &[("identifier", &identifier)])
	} else {
		i18n::tf("lib.mission.opened", &[("identifier", &identifier)])
	};
	Ok(serde_json::json!({
		"mission": mission::get(&mission.id).unwrap_or(mission),
		"started": true,
		"session": session,
		"message": message,
	}))
}

/// Lance l'agent maître d'une mission, avec ses outils d'orchestration.
///
/// Le prompt lui dit ce qu'on attend de lui — un plan, puis une intégration —
/// et surtout ce qu'il ne décide pas : l'accord humain sur le découpage.
#[tauri::command]
async fn mission_master_launch(app: AppHandle, id: String, brief: Option<String>) -> Result<String> {
	// Le geste vient de l'interface : c'est donc bien un humain qui demande.
	// Les boucles de fond, elles, passent par `launch_master` avec leur propre
	// acteur — sans quoi une mission relancée à trois heures du matin se
	// signerait de la main de quelqu'un qui dormait.
	launch_master(app, id, brief, executions::Origin::human()).await
}

async fn launch_master(
	app: AppHandle,
	id: String,
	brief: Option<String>,
	origin: executions::Origin,
) -> Result<String> {
	use tauri::Manager;
	let mission = mission::get(&id)?;

	// Un maître lancé sans brief explicite (le bouton « Lancer le maître »
	// d'une mission déjà ouverte, par opposition au geste qui ouvre et lance
	// d'un coup) partait sans rien du ticket qui l'a pourtant fait naître —
	// vérifié en direct : « no existing context to work from ». Les deux
	// appels qui reprennent une mission en route passent toujours un brief
	// explicite ; celui-ci ne comble que le trou, jamais ne les court-circuite.
	let brief = match brief.filter(|b| !b.trim().is_empty()) {
		Some(brief) => Some(brief),
		None => fetch_ticket_brief(&mission).await,
	};

	// Sans Node, pas de pont MCP, donc pas d'outils de mission : le maître
	// démarrerait, discuterait, et ne pourrait ni soumettre son plan ni lancer un
	// exécutant. Mieux vaut ne pas le lancer et dire ce qui manque — c'est
	// exactement l'échec qu'on voyait passer pour un problème d'agent.
	if agent::node_binary().is_none() {
		return Err(CockpitError::msg(i18n::t(if cfg!(windows) { "windowsAgents.nodeMissing" } else { "lib.mission.nodeMissing" })));
	}

	let agents = app
		.try_state::<agent::SharedAgents>()
		.ok_or_else(|| CockpitError::msg(i18n::t("lib.mission.agentsUnavailable")))?
		.inner()
		.clone();

	// Les rôles qui jugent sont annoncés comme tels : le maître planifiait des
	// recettes en parallèle de l'implémentation, faute de savoir que le cockpit
	// les retiendrait de toute façon.
	let roles = roles_list()
		.into_iter()
		// Le maître ne se confie pas de tâche à lui-même : sa clé n'a rien à
		// faire dans la liste qu'il utilise pour découper.
		.filter(|role| role.id != config::MASTER_ROLE)
		.map(|role| {
			if role.verifies {
				format!(
					"- `{}`: {} — judges the others' work, only starts once the \
					 implementation is delivered",
					role.id, role.label
				)
			} else {
				format!("- `{}`: {}", role.id, role.label)
			}
		})
		.collect::<Vec<_>>()
		.join("\n");

	let prompt = format!(
		// Ce prompt dit ce que le maître opère et ce qu'il ne décide pas. Il
		// n'énumère plus les étapes : les outils les portent déjà, et les répéter
		// revenait à piloter à sa place quelqu'un dont on attend du jugement.
		// Ne restent que les contraintes qu'il ne peut pas deviner — l'accord
		// humain, et le fait que les périmètres sont réellement appliqués.
		"You are the master agent of the mission \"{title}\"{ticket}.\n\n\
		 You break the work down, hand it to workers, and recombine what they \
		 deliver on the integration branch `{branch}`. The mission tools are yours; \
		 each one says what it does.\n\n\
		 Two things you do not decide. Your plan waits for the user's agreement: \
		 nothing starts before that, whatever you think of it. And the path scopes \
		 you declare are enforced — a write outside them will be refused; it is not \
		 an instruction but a barrier.\n\n\
		 Available roles:\n{roles}\n\n\
		 A worker only sees its own instructions: what you do not write to it, it \
		 does not have. Two workers writing in the same place will get in each \
		 other's way whatever you tell them.\n\n\
		 {directive}\n\n{guided}{lessons}{brief}",
		directive = i18n::reply_directive(),
		guided = if mission.guided {
			format!("{}\n\n", guided_brief(&mission))
		} else {
			String::new()
		},
		title = mission.title,
		ticket = if mission.ticket.is_empty() {
			String::new()
		} else {
			format!(" (issue {})", mission.ticket)
		},
		branch = mission.branch,
		roles = roles,
		// Ce que les missions précédentes ont appris. Le maître repartait de zéro
		// à chaque fois et refaisait les mêmes découpages ratés — une recette sans
		// exécutant rattaché, deux rôles sur le même dossier — alors que le motif
		// de l'échec était écrit dans la mission d'avant.
		lessons = {
			let passe = mission::lessons(5);
			if passe.is_empty() {
				String::new()
			} else {
				format!("{passe}\n\n")
			}
		},
		brief = brief.unwrap_or_default(),
	);

	// Le maître travaille sur la branche d'intégration, dans son propre
	// worktree. Deux raisons : c'est là que vivent les contrats que suivront les
	// exécutants, et c'est ce qui rend son mode permissif acceptable — un dossier
	// dédié à la mission, jamais le dépôt principal.
	let cwd = match orchestrator::integration_worktree(&mission).await {
		Ok(path) => path,
		// Surtout pas de repli sur le dépôt principal. C'est là que vit la
		// branche de travail de l'utilisateur : un maître lâché dedans y écrit
		// ses contrats, y commite, et transforme un dépôt propre en chantier.
		// Mieux vaut refuser de démarrer et dire pourquoi.
		Err(error) => {
			return Err(CockpitError::msg(i18n::tf(
				"lib.mission.integrationWorktreeFailed",
				&[("branch", &mission.branch), ("error", &error)],
			)))
		}
	};

	// Le rôle `master` du catalogue règle ce qui lui est propre : sa commande de
	// démarrage, sa consigne permanente, son modèle. Le reste — les outils
	// d'orchestration, les étapes — vient du cockpit et ne se configure pas.
	let master = role_config(&mission.cwd, config::MASTER_ROLE);
	let command = master
		.as_ref()
		.map(|role| fill_command(&role.command, &mission, None))
		.filter(|command| !command.is_empty());
	let consigne = master
		.as_ref()
		.map(|role| role.prompt.trim())
		.filter(|prompt| !prompt.is_empty())
		.unwrap_or_default();

	// La commande d'abord : c'est elle qui porte la méthode de l'équipe, et le
	// CLI la résout où qu'elle soit dans le message.
	let prompt = match (&command, consigne.is_empty()) {
		(Some(command), false) => format!("{command}\n\n{consigne}\n\n{prompt}"),
		(Some(command), true) => format!("{command}\n\n{prompt}"),
		(None, false) => format!("{consigne}\n\n{prompt}"),
		(None, true) => prompt,
	};

	let session = agent::start_with_mission(
		app,
		agents,
		cwd,
		prompt,
		// Le maître enchaîne lecture, écriture de contrats et appels d'outils :
		// lui demander une autorisation à chaque geste revient à le piloter à la
		// main, ce qui est exactement ce qu'on cherche à éviter. Son terrain est
		// isolé, et ses exécutants, eux, gardent leurs garde-fous.
		Some(
			master
				.as_ref()
				.map(|role| role.permission_mode.clone())
				.filter(|mode| !mode.is_empty())
				.unwrap_or_else(|| "bypassPermissions".into()),
		),
		master
			.as_ref()
			.map(|role| role.model.clone())
			.filter(|model| !model.is_empty()),
		None,
		Some(mission.id.clone()),
		master
			.as_ref()
			.map(|role| role.engine.clone())
			.filter(|engine| !engine.trim().is_empty()),
		master
			.as_ref()
			.map(|role| role.depth.clone())
			.unwrap_or_default(),
		// Le maître écrit les contrats de la mission dans son propre worktree :
		// le borner reviendrait à l'empêcher de faire son travail.
		Vec::new(),
		executions::Origin {
			role: config::MASTER_ROLE.to_string(),
			..origin
		},
	)
	.await?;

	mission::attach_master(&id, &session)?;
	journal::record("mission", &i18n::t("lib.mission.masterLaunched"), &mission.title, true, "");
	Ok(session)
}

/// Ce que le maître d'une mission guidée doit savoir de son parcours, et
/// d'où il repart.
///
/// Relu à chaque lancement plutôt que figé à l'ouverture : un maître relancé
/// après un redémarrage du cockpit n'a plus sa conversation, et doit
/// retrouver ici ce qui a déjà été validé — sans quoi il relirait le ticket
/// et reproposerait une compréhension que l'utilisateur a déjà signée.
fn guided_brief(mission: &mission::Mission) -> String {
	use mission::MissionState as S;
	let mut text = String::from(
		"This mission is guided: the user reads the issue at the same time as you, and three \
		 agreements mark out your work. You only move on to the next step after theirs — the \
		 tools refuse otherwise.\n\n\
		 1. Understanding (`understand`). Read the issue, its comments, then the code it \
		 touches, without modifying anything. Return what you understood in 10 lines at most, \
		 for a developer discovering the issue: what is asked, why, what is out of scope. \
		 Simple words, one idea per line, no plan. What you could not settle goes into \
		 `questions`, never into the text: an ambiguity buried in a summary reads like a \
		 certainty.\n\
		 2. Approach (`approach`). How you intend to go about it: the steps, the places in the \
		 code, the order, the risks. 15 lines at most, readable by a human, without splitting \
		 between workers yet.\n\
		 3. Breakdown (`plan`). The tasks handed to the workers, faithful to the approved \
		 approach.\n\n\
		 After each submission, stop. The user's answer reaches you by message: an approval, \
		 or a correction you take into account before submitting a new version.",
	);

	let validated = |drafts: &[mission::Draft]| -> Option<String> {
		let last = drafts.last()?;
		let review = last.review.as_ref().filter(|review| review.approved)?;
		let mut block = last.text.clone();
		let answers = answered(&last.questions, &review.answers);
		if !answers.is_empty() {
			block.push_str(&format!("\n{answers}"));
		}
		if !review.feedback.is_empty() {
			block.push_str(&format!("\nUser's clarification: {}", review.feedback));
		}
		Some(block)
	};
	if let Some(block) = validated(&mission.understanding) {
		text.push_str(&format!("\n\n── Understanding approved ──\n{block}"));
	}
	if let Some(block) = validated(&mission.approach) {
		text.push_str(&format!("\n\n── Approach approved ──\n{block}"));
	}

	let now = match mission.state {
		S::Understanding => "start with the understanding.",
		S::Approaching => "your understanding is approved: the approach is yours.",
		S::Planning => "your approach is approved: the breakdown is yours.",
		S::AwaitingUnderstanding | S::AwaitingApproach | S::AwaitingApproval => {
			"your last proposal is waiting for the user's answer: call nothing, wait for \
			 their message."
		}
		_ => "the breakdown is approved; the workers are working.",
	};
	text.push_str(&format!("\n\nWhere the mission stands: {now}"));
	text
}

/// Les réponses de l'utilisateur, face aux questions qu'elles tranchent.
fn answered(questions: &[String], answers: &[String]) -> String {
	questions
		.iter()
		.zip(answers.iter())
		.filter(|(_, answer)| !answer.trim().is_empty())
		.map(|(question, answer)| format!("- {question} → {}", answer.trim()))
		.collect::<Vec<_>>()
		.join("\n")
}

/// Le message qui porte une décision humaine jusqu'au maître.
///
/// Pur : c'est le seul endroit où une validation devient une consigne, et
/// une consigne mal dite ici fait sauter une étape au maître.
fn review_message(mission: &mission::Mission, step: mission::Step, approved: bool) -> String {
	let drafts = match step {
		mission::Step::Understanding => &mission.understanding,
		mission::Step::Approach => &mission.approach,
		mission::Step::Split => &mission.split,
	};
	let review = drafts.last().and_then(|draft| draft.review.clone());
	let questions = drafts.last().map(|draft| draft.questions.clone()).unwrap_or_default();
	let mut details = String::new();
	if let Some(review) = &review {
		let answers = answered(&questions, &review.answers);
		if !answers.is_empty() {
			details.push_str(&format!("\n\nTheir answers to your questions:\n{answers}"));
		}
		if !review.feedback.is_empty() {
			details.push_str(&format!(
				"\n\n{}:\n{}",
				if approved { "What they add" } else { "What they correct" },
				review.feedback
			));
		}
	}

	let next = match (step, approved) {
		(mission::Step::Understanding, true) => {
			"Move on to the approach: how you intend to go about it, then `approach`. Do not break \
			 it down yet."
		}
		(mission::Step::Understanding, false) => {
			"Rework your understanding taking the above into account, then submit a new \
			 version with `understand`."
		}
		(mission::Step::Approach, true) => {
			"Move on to the breakdown: the workers' tasks, faithful to this approach, then `plan`."
		}
		(mission::Step::Approach, false) => {
			"Rework your approach taking the above into account, then submit a new version \
			 with `approach`."
		}
		(mission::Step::Split, _) => {
			"Rework your breakdown taking the above into account, then submit it again with \
			 `plan`."
		}
	};
	format!(
		"The user {} your {}.{details}\n\n{next}",
		if approved { "approves" } else { "corrects" },
		step.protocol_label()
	)
}

/// Valide ou corrige une étape d'une mission guidée, et le fait savoir au
/// maître.
///
/// Le découpage validé fait partir les exécutants, comme l'approbation d'un
/// plan autonome. Toute autre décision redescend au maître : dans sa
/// conversation s'il est encore là — il garde tout ce qu'il a lu —, sinon
/// par un maître neuf qui repart de ce qui a été validé.
#[tauri::command]
async fn mission_review(
	app: AppHandle,
	id: String,
	step: mission::Step,
	approved: bool,
	feedback: Option<String>,
	answers: Option<Vec<String>>,
) -> Result<mission::Mission> {
	let mission = mission::review(
		&id,
		step,
		approved,
		&feedback.unwrap_or_default(),
		answers.unwrap_or_default(),
	)?;

	if step == mission::Step::Split && approved {
		launch_ready_tasks(app, &id).await;
		return mission::get(&id);
	}

	let message = review_message(&mission, step, approved);
	guide_master(&app, &mission, &message).await?;
	mission::get(&id)
}

/// Transmet une consigne au maître d'une mission — dans sa conversation s'il
/// vit encore, sinon en en lançant un neuf.
async fn guide_master(app: &AppHandle, mission: &mission::Mission, message: &str) -> Result<()> {
	use tauri::Manager;
	if let (Some(session), Some(agents)) = (
		mission.master_session.as_deref(),
		app.try_state::<agent::SharedAgents>(),
	) {
		// Sa conversation d'abord : il y a lu le ticket et le code, et un maître
		// neuf paierait cette lecture une seconde fois.
		if agent::send(app, agents.inner(), session, message).await.is_ok() {
			return Ok(());
		}
		// Plus personne au bout : on range ce qui reste avant d'en lancer un
		// autre, sans quoi deux maîtres finiraient par tenir la même mission.
		let _ = agent::stop(agents.inner(), session);
	}
	let ticket = fetch_ticket_brief(mission).await.unwrap_or_default();
	let brief = if ticket.is_empty() {
		message.to_string()
	} else {
		format!("{ticket}\n\n{message}")
	};
	launch_master(
		app.clone(),
		mission.id.clone(),
		Some(brief),
		executions::Origin::human(),
	)
	.await
	.map(|_| ())
}

/// Le ticket d'une mission, relu chez le fournisseur et mis en forme.
async fn fetch_ticket_brief(mission: &mission::Mission) -> Option<String> {
	if mission.ticket.trim().is_empty() {
		return None;
	}
	let config = cfg();
	let provider = tickets::provider(&config).ok()?;
	let ticket = provider.get(&mission.ticket).await.ok()?;
	Some(ticket_brief(&ticket))
}

/// Ouvre la pull request d'une mission depuis son worktree d'intégration.
///
/// Passe par le même chemin que l'interface — pousser, puis demander à la forge
/// — pour qu'une PR ouverte par le maître soit indiscernable d'une PR ouverte à
/// la main.
/// Le rôle du catalogue d'un projet, ou celui par défaut quand il n'y est pas.
///
/// Le catalogue se lit depuis le dépôt de la mission, jamais depuis l'écran
/// affiché : c'est là que vivent les commandes d'équipe — `/self-qa`,
/// `/code-review-process` — et une mission qui les perd tourne avec les rôles
/// génériques sans que rien ne le dise.
fn role_config(repo: &str, id: &str) -> Option<config::RoleConfig> {
	let configured = config::Config::for_repo(repo)
		.roles
		.into_iter()
		.find(|role| role.id == id);
	configured.or_else(|| config::default_roles().into_iter().find(|role| role.id == id))
}

/// Remplace dans une commande ce qui vient de la mission et de la tâche.
///
/// Les commandes d'équipe attendent un argument — l'adresse du ticket, le plus
/// souvent. L'écrire à la main dans la configuration reviendrait à figer une
/// mission ; on substitue donc au lancement.
fn fill_command(
	template: &str,
	mission: &mission::Mission,
	task: Option<&mission::Task>,
) -> String {
	let mut filled = template.trim().to_string();
	for (motif, valeur) in [
		("{ticket}", mission.ticket.as_str()),
		("{ticketUrl}", mission.ticket_url.as_str()),
		("{branch}", mission.branch.as_str()),
		("{mission}", mission.title.as_str()),
		("{task}", task.map(|t| t.title.as_str()).unwrap_or_default()),
		("{brief}", task.map(|t| t.brief.as_str()).unwrap_or_default()),
	] {
		filled = filled.replace(motif, valeur);
	}
	filled
}

/// La commande d'équipe qui ouvre une pull request sur ce projet, s'il en a une.
///
/// Lue depuis le dépôt de la mission : `/pull-request-creation` existe chez l'un
/// et pas chez l'autre, et faire jouer au maître une commande introuvable lui
/// ferait perdre son tour.
pub fn mission_pr_command(mission: &mission::Mission) -> Option<String> {
	let template = config::Config::for_repo(&mission.cwd).workflow.pr_command;
	let filled = fill_command(&template, mission, None);
	(!filled.trim().is_empty()).then_some(filled)
}

/// Sur quoi la pull request d'une mission se greffe.
///
/// Ce que la mission déclare, sinon la branche par défaut du dépôt. Résolu au
/// moment d'ouvrir plutôt qu'à la création : une mission ouverte il y a trois
/// semaines ne doit pas viser une base qui a changé de nom entre-temps.
pub async fn mission_base(mission: &mission::Mission) -> String {
	if !mission.base.trim().is_empty() {
		return mission.base.trim().to_string();
	}
	match main_repo() {
		Ok(repo) => git::default_branch(&repo).await,
		Err(_) => "main".to_string(),
	}
}

pub async fn open_mission_pr(
	cwd: &str,
	branch: &str,
	base: &str,
	title: &str,
	body: &str,
) -> Result<String> {
	// La branche est nommée, jamais déduite de `HEAD` : le dossier d'où l'on
	// pousse n'a aucune raison d'être posé sur celle de la mission, et la PR
	// partait donc de ce qui traînait là.
	create_pr_on(cwd, branch, base, title, Some(body.to_string()), false).await
}

#[tauri::command]
async fn mission_pr(id: String, title: Option<String>, body: Option<String>) -> Result<mission::Mission> {
	let mission = mission::get(&id)?;

	// Ouvrir la pull request clôt la mission et range ses worktrees : ce qui
	// n'est pas dans la branche d'intégration à cet instant se retrouve sur une
	// branche que plus rien ne nomme. On refuse plutôt que de perdre le travail
	// en silence — une tâche dont on ne veut plus se marque échouée, et là c'est
	// une décision, pas un oubli.
	// Une vérification qui refuse est un refus, pas un avis. Elle avait nommé le
	// défaut, elle l'avait écrit, et la pull request s'ouvrait quand même :
	// personne d'autre que le maître ne lisait ce verdict, et un maître peut
	// passer à côté. Se lever demande de corriger puis de la relancer — elle
	// rejugera, et c'est ce nouveau jugement qui ouvrira la porte.
	let verifiers: Vec<String> = roles_for(&mission.cwd)
		.into_iter()
		.filter(|role| role.verifies)
		.map(|role| role.id)
		.collect();
	// Une vérification qui n'a pas conclu ne vaut pas accord. Ouvrir la pull
	// request sur son silence reviendrait à lire « je ne sais pas » comme « rien
	// à redire » — la confusion que l'oracle de la Permanence a nommée comme son
	// pire mode de défaillance. Le refus se lève sans rien perdre : la
	// vérification reformule, ou la tâche s'assume abandonnée.
	let indecises = mission::unclear_verdicts(&mission, &verifiers);
	if !indecises.is_empty() {
		let liste = indecises
			.iter()
			.map(|task| i18n::tf("lib.quoted", &[("text", &task.title)]))
			.collect::<Vec<_>>()
			.join(", ");
		return Err(CockpitError::msg(i18n::tf("lib.mission.unclearVerdict", &[("tasks", &liste)])));
	}

	let refus = mission::blocking_verdicts(&mission, &verifiers);
	if !refus.is_empty() {
		let liste = refus
			.iter()
			.map(|task| i18n::tf("lib.quoted", &[("text", &task.title)]))
			.collect::<Vec<_>>()
			.join(", ");
		return Err(CockpitError::msg(i18n::tf("lib.mission.blockingVerdict", &[("tasks", &liste)])));
	}

	let dehors = mission::unintegrated(&mission);
	if !dehors.is_empty() {
		let liste = dehors
			.iter()
			.map(|task| {
				format!("{} ({:?})", i18n::tf("lib.quoted", &[("text", &task.title)]), task.state)
			})
			.collect::<Vec<_>>()
			.join(", ");
		return Err(CockpitError::msg(i18n::tf(
			"lib.mission.unintegrated",
			&[("count", &dehors.len()), ("branch", &mission.branch), ("tasks", &liste)],
		)));
	}

	let url = open_mission_pr(
		&mission.cwd,
		&mission.branch,
		&mission_base(&mission).await,
		&title.unwrap_or_else(|| mission.title.clone()),
		&body.unwrap_or_default(),
	)
	.await?;
	let closed = mission::finish(&id, &url)?;
	let _ = mission::cleanup(&id).await;
	Ok(closed)
}

/// Range les worktrees des tâches intégrées, à la demande.
#[tauri::command]
async fn mission_cleanup(id: String) -> Result<Vec<String>> {
	mission::cleanup(&id).await
}

#[tauri::command(async)]
fn roles_list() -> Vec<config::RoleConfig> {
	roles_for(&cfg().general.main_repo)
}

/// Le catalogue de rôles d'un dépôt, jamais vide.
///
/// Ce que le lanceur consulte pour savoir qui juge le travail des autres : lu
/// depuis le projet de la mission, il ne dépend plus de l'écran ouvert.
fn roles_for(repo: &str) -> Vec<config::RoleConfig> {
	let roles = config::Config::for_repo(repo).roles;
	if roles.is_empty() {
		config::default_roles()
	} else {
		roles
	}
}

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
	let team_id = if config.team.linear_team_id.trim().is_empty() {
		team::default_linear_team_id()
	} else {
		config.team.linear_team_id.clone()
	};

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

	let (identifier, url) =
		integrations::linear_create_issue(&config, &team_id, &title, &description).await?;

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
async fn betterstack_kpi_values(
	dashboard_id: String,
	hours: Option<i64>,
) -> Result<Vec<integrations::KpiValue>> {
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
	tickets::provider(&config)?
		.list(only_mine.unwrap_or(false))
		.await
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

/// Surveille `~/.claude/projects` et notifie l'UI dès qu'un agent écrit.
/// Debounce volontaire : Claude Code écrit par rafales, on ne veut pas
/// re-scanner à chaque ligne de JSONL.
/// Au-delà, c'est qu'un plan a dérapé plutôt qu'il n'a découpé.
const MAX_RUNNING_TASKS: usize = 4;

/// Toutes missions confondues. Le plafond par mission ne protège de rien quand
/// c'est le lanceur lui-même qui s'emballe : celui-ci borne la machine.
const MAX_RUNNING_TASKS_TOTAL: usize = 8;

/// Délai laissé à un exécutant pour se rattacher à sa tâche, en secondes.
///
/// Large à dessein : créer un worktree sur un gros dépôt et démarrer un CLI peut
/// demander une minute. Ce qui compte est qu'il y ait une fin — une tâche
/// « en cours » que personne ne rejoindra ne doit pas le rester jusqu'au soir.
const LAUNCH_GRACE_SECONDS: i64 = 300;

/// Nombre d'exécutants en cours sur l'ensemble des missions.
fn running_tasks_everywhere() -> usize {
	mission::list()
		.iter()
		.flat_map(|mission| mission.tasks.iter())
		.filter(|task| task.state == mission::TaskState::Running)
		.count()
}

/// Lance les exécutants dont le terrain est prêt.
///
/// Approuver un plan, c'est donner le feu vert : demander un second clic par
/// tâche revient à faire deux fois la même décision. Une tâche part donc dès
/// que sa base existe — la branche d'intégration, ou celle d'une sœur qui a
/// déjà livré quand une dépendance a été déclarée.
async fn launch_ready_tasks(app: AppHandle, id: &str) {
	let Ok(mission) = mission::get(id) else { return };
	if mission.state != mission::MissionState::Running || mission.paused {
		return;
	}

	// La réserve avant le travail. On ne tue rien : les tâches en cours vont au
	// bout et le maître continue — on cesse seulement d'en ajouter. Se
	// retrouver à sec un mardi après-midi coûte plus cher qu'une mission qui
	// attend une heure.
	let config = cfg();
	if !config.missions.quota_allows(worst_quota()) {
		static DIT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
		// Une fois par heure, pas à chaque tour de boucle : la boucle passe
		// toutes les six secondes, et un journal qui répète six cents fois la
		// même ligne ne se lit plus.
		let mut dit = DIT.lock().unwrap_or_else(|guard| guard.into_inner());
		if dit.map(|at| at.elapsed().as_secs() > 3600).unwrap_or(true) {
			*dit = Some(std::time::Instant::now());
			journal::record(
				"mission",
				&i18n::t("lib.mission.launchSuspendedQuota"),
				&mission.title,
				false,
				&i18n::tf("lib.mission.quotaFloor", &[("floor", &config.missions.quota_floor())]),
			);
		}
		return;
	}

	let mut running = mission
		.tasks
		.iter()
		.filter(|task| task.state == mission::TaskState::Running)
		.count();

	// Les rôles qui jugent le travail des autres, d'après le catalogue du projet
	// de la mission.
	let verifiers: std::collections::HashSet<String> = roles_for(&mission.cwd)
		.into_iter()
		.filter(|role| role.verifies)
		.map(|role| role.id)
		.collect();

	let implementation_done = mission.implementation_done(|role| verifiers.contains(role));

	for task in &mission.tasks {
		if task.state != mission::TaskState::Planned || running >= MAX_RUNNING_TASKS {
			continue;
		}
		if running_tasks_everywhere() >= MAX_RUNNING_TASKS_TOTAL {
			journal::record(
				"mission",
				&i18n::t("lib.mission.launchSuspended"),
				&mission.title,
				false,
				&i18n::tf("lib.mission.tooManyWorkers", &[("count", &MAX_RUNNING_TASKS_TOTAL)]),
			);
			return;
		}
		// Une tâche sans identifiant est intraçable : on ne saurait ni lui
		// rattacher sa session ni la marquer lancée, et on repartirait dessus à
		// chaque tour. Mieux vaut l'échouer une fois que la relancer sans fin.
		if task.id.trim().is_empty() {
			let _ = mission::set_task_state(
				&mission.id,
				&task.id,
				mission::TaskState::Failed,
				&i18n::t("lib.mission.taskWithoutId"),
			);
			continue;
		}
		// Recette et relecture jugent ce que les autres produisent : parties en
		// même temps qu'eux, elles relisent une branche vide et rendent un
		// compte rendu sur rien. On les retient jusqu'à ce que l'implémentation
		// ait livré — le bouton « Forcer » reste là pour passer outre.
		if verifiers.contains(&task.role) && !implementation_done {
			continue;
		}
		// Une base qui n'est pas l'intégration désigne une sœur : tant qu'elle
		// n'a rien livré, sa branche n'existe pas et partir dessus créerait un
		// worktree vide. Mais toutes les attentes ne finissent pas : une sœur à
		// bout de reprises ne livrera jamais, et une base qui ne désigne aucune
		// tâche du plan n'a personne à attendre. La tâche restait alors « à
		// faire » indéfiniment dans une mission « en cours » que plus rien ne
		// faisait avancer, sans que rien ne le dise.
		if let Some(raison) = mission::blocking_reason(&mission, task) {
			let _ = mission::set_task_state(
				&mission.id,
				&task.id,
				mission::TaskState::Failed,
				&raison,
			);
			journal::record("mission", &i18n::t("lib.mission.taskBlocked"), &task.title, false, &raison);
			continue;
		}
		if !task.base.trim().is_empty() && task.base != mission.branch {
			let ready = mission.tasks.iter().any(|sister| {
				sister.branch == task.base
					&& matches!(
						sister.state,
						mission::TaskState::Delivered | mission::TaskState::Integrated
					)
			});
			if !ready {
				continue;
			}
		}

		// La réservation d'abord : ce qui suit attend, et rien ne doit repasser
		// sur cette tâche pendant ce temps.
		match mission::claim_task(&mission.id, &task.id) {
			Ok(true) => running += 1,
			_ => continue,
		}

		match orchestrator::prepare_worktree(&mission, task).await {
			Ok(worktree) => {
				let _ = mission::set_task_worktree(&mission.id, &task.id, &worktree);
			}
			Err(error) => {
				let _ = mission::set_task_state(
					&mission.id,
					&task.id,
					mission::TaskState::Failed,
					&i18n::tf("lib.mission.worktreeFailed", &[("error", &error)]),
				);
				running -= 1;
				continue;
			}
		}

		match launch_task_agent(app.clone(), &mission.id, &task.id, executions::COCKPIT).await {
			Ok(_) => {}
			Err(error) => {
				let _ = mission::set_task_state(
					&mission.id,
					&task.id,
					mission::TaskState::Failed,
					&error.to_string(),
				);
				running -= 1;
			}
		}
	}
}

/// Fait avancer les missions sans qu'on ait à cliquer.
///
/// Une tâche qui vient d'être livrée peut en débloquer une autre : c'est ici
/// qu'on s'en aperçoit, plutôt que d'attendre un geste de l'utilisateur ou une
/// initiative du maître.
/// Constate ce que les exécutants ont fini.
///
/// Un exécutant n'a aucun moyen de dire qu'il a terminé : il écrit « travail
/// terminé » dans sa conversation, ce qui ne vaut rien pour la machine, puis son
/// processus rend la main. C'est cette fin de processus qui fait foi — sans
/// quoi les tâches restaient « en cours » indéfiniment, la progression ne
/// bougeait plus, et la mission n'atteignait jamais son intégration.
///
/// Rend vrai si quelque chose a changé.
/// Où en est le travail à vérifier, branche par branche.
///
/// Une ligne lisible plutôt qu'une structure : elle finira dans la consigne d'un
/// agent, qui s'en servira pour demander un diff. `backend=a1b2c3 frontend=d4e5f6`
/// suffit à dire ce qui a bougé depuis la dernière relecture.
async fn implementation_state(
	mission: &mission::Mission,
	verifiers: &std::collections::HashSet<String>,
) -> Option<String> {
	let repo = std::path::Path::new(&mission.cwd);
	let mut reperes = Vec::new();
	for task in &mission.tasks {
		if verifiers.contains(&task.role) || task.branch.trim().is_empty() {
			continue;
		}
		if let Ok(sha) = git::run_git(repo, &["rev-parse", "--short", &task.branch]).await {
			let sha = sha.trim();
			if !sha.is_empty() {
				reperes.push(format!("{}={sha}", task.branch));
			}
		}
	}
	(!reperes.is_empty()).then(|| reperes.join(" "))
}

/// Ce qu'une vérification a conclu, lu dans son propre rapport.
///
/// Le cockpit ne demande pas au moteur de remplir un formulaire : il lui
/// demande une ligne, et va la chercher. C'est ce qui rend la lecture portable
/// — un moteur qui ne connaît ni nos outils ni notre JSON sait écrire une
/// phrase, et c'est tout ce dont on a besoin pour savoir si la mission peut
/// partir.
/// Le verdict d'une vérification, tel que le cockpit l'a relevé lui-même.
///
/// Le relevé d'abord, le fil du moteur en repli. L'ordre n'est pas
/// esthétique : pendant des semaines, ce verdict n'a jamais été posé sur une
/// seule tâche, parce qu'on allait le chercher dans le fichier d'un tiers —
/// écrit dans un worktree qu'on venait de supprimer, et, dès que l'isolation
/// est active, dans un `$HOME` que le poste ne balayait même pas. La lecture
/// échouait, et une lecture échouée ne se distinguait pas d'un rapport sans
/// refus. Ce que le cockpit a entendu passer vaut mieux que ce qu'il espère
/// relire.
///
/// `session` est l'agent du cockpit, `engine` sa conversation chez le moteur —
/// la seconde ne sert plus qu'aux exécutions antérieures à ce relevé.
fn verdict_of(session: &str, engine: Option<&str>) -> Option<mission::Verdict> {
	let releve = executions::for_session(session)
		.into_iter()
		.rev()
		.find_map(|exec| mission::Verdict::parse(&exec.verdict));
	releve.or_else(|| engine.and_then(verdict_from_session))
}

/// Le verdict est la conclusion : on lit la fin du fil, pas le début.
fn verdict_from_session(session: &str) -> Option<mission::Verdict> {
	let session = session.trim();
	if session.is_empty() {
		return None;
	}
	let file = remote::session_file(session)?;
	let events = sessions::read_timeline(std::path::Path::new(&file), 400).ok()?;
	events
		.iter()
		.rev()
		.filter(|event| event.kind == "assistant" && !event.is_sidechain)
		.find_map(|event| mission::read_verdict(&event.text))
}

async fn collect_finished_tasks(app: &AppHandle, id: &str) -> bool {
	use tauri::Manager;
	let Ok(mission) = mission::get(id) else {
		return false;
	};
	let Some(agents) = app.try_state::<agent::SharedAgents>() else {
		return false;
	};
	let agents = agents.inner().clone();
	let verifiers: std::collections::HashSet<String> = roles_for(&mission.cwd)
		.into_iter()
		.filter(|role| role.verifies)
		.map(|role| role.id)
		.collect();

	let mut changed = false;
	for task in &mission.tasks {
		if task.state != mission::TaskState::Running {
			continue;
		}
		// Une tâche réservée dont l'agent n'est pas encore rattaché n'est pas
		// finie : elle n'a simplement pas encore commencé. Mais l'attente a une
		// limite — créer un worktree et démarrer un CLI prend des secondes, pas
		// une heure. Passé ce délai, plus personne ne viendra s'y rattacher :
		// faute de ce filet, la tâche restait « en cours » indéfiniment, sans
		// conversation à ouvrir pour comprendre, et occupait une place au plafond
		// des exécutants.
		let Some(session) = &task.session_id else {
			if task.running_seconds().unwrap_or(0) > LAUNCH_GRACE_SECONDS {
				let _ = mission::set_task_state(
					id,
					&task.id,
					mission::TaskState::Failed,
					&i18n::t("lib.mission.noWorkerAttached"),
				);
				changed = true;
			}
			continue;
		};
		if agent::is_working(&agents, session) {
			continue;
		}

		// Mort sans avoir rien dit : le lancement a échoué, la tâche n'a pas
		// travaillé. La marquer livrée ferait croire la mission terminée.
		if !agent::has_answered(&agents, session) {
			let _ = mission::set_task_state(
				id,
				&task.id,
				mission::TaskState::Failed,
				&i18n::t("lib.mission.workerDiedSilent"),
			);
			let _ = agent::stop(&agents, session);
			changed = true;
			continue;
		}

		// Ce qu'elle laisse derrière elle, pour que le maître sache quoi relire.
		// Une relecture ne commite rien par nature : l'absence de commit n'est
		// pas un échec, seulement une information.
		let commits = git::run_git(
			std::path::Path::new(&mission.cwd),
			&["rev-list", "--count", &format!("{}..{}", mission.branch, task.branch)],
		)
		.await
		.ok()
		.and_then(|raw| raw.trim().parse::<u32>().ok())
		.unwrap_or(0);

		// Rien sur sa branche ne veut pas dire rien fait. Un exécutant peut
		// s'être créé une branche dans son worktree — par habitude de nommage,
		// ou parce qu'il a jugé le sujet différent — et son travail est alors
		// bien là, mais pas où l'intégration ira le chercher. Elle fusionnerait
		// une branche vide, la mission se refermerait, et le code resterait sur
		// une branche que plus rien ne nomme. On regarde donc où il est
		// vraiment avant de conclure.
		let mut derive = String::new();
		if commits == 0 && !task.worktree.trim().is_empty() {
			let dessus = git::current_branch(std::path::Path::new(&task.worktree))
				.await
				.unwrap_or_default();
			let dessus = dessus.trim().to_string();
			if !dessus.is_empty() && dessus != task.branch.trim() {
				let ailleurs = git::run_git(
					std::path::Path::new(&task.worktree),
					&["rev-list", "--count", &format!("{}..{dessus}", mission.branch)],
				)
				.await
				.ok()
				.and_then(|raw| raw.trim().parse::<u32>().ok())
				.unwrap_or(0);
				if ailleurs > 0 {
					let _ = mission::set_task_actual_branch(id, &task.id, &dessus);
					journal::record(
						"mission",
						&i18n::t("lib.mission.workerOtherBranch"),
						&task.title,
						false,
						&i18n::tf(
							"lib.mission.workerOtherBranchDetail",
							&[("count", &ailleurs), ("actual", &dessus), ("expected", &task.branch)],
						),
					);
					derive = format!(
						" {}",
						i18n::tf(
							"lib.mission.workerOtherBranchNote",
							&[("count", &ailleurs), ("actual", &dessus), ("expected", &task.branch)],
						)
					);
				}
			}
		}

		let _ = mission::set_task_state(
			id,
			&task.id,
			mission::TaskState::Delivered,
			&match commits {
				0 => format!("{}{derive}", i18n::t("lib.mission.workerDoneNoCommit")),
				1 => i18n::t("lib.mission.workerDoneOneCommit"),
				n => i18n::tf("lib.mission.workerDoneCommits", &[("count", &n)]),
			},
		);
		// Un rendu qui porte du code passe les portes du dépôt avant d'être
		// intégrable. Une vérification ne commite rien : rien à juger chez elle.
		if !verifiers.contains(&task.role) && (commits > 0 || !derive.is_empty()) {
			let _ = gates::start(id, &task.id);
		}
		// Capturé maintenant, tant que l'agent est encore vivant : une fois
		// `stop` appelé plus bas, plus rien ne sait retrouver son identifiant de
		// session (l'entrée disparaît du registre). C'est ce qui laissait
		// `engine_session` vide toute la mission — une reprise repartait à froid,
		// sans la conversation qui allait avec son checkpoint, et le verdict
		// ci-dessous ne trouvait jamais de fil à lire.
		let claude_session = agents.claude_session_of(session);
		if let Some(claude_session) = &claude_session {
			let _ = mission::set_task_engine_session(id, &task.id, claude_session);
		}

		// Une vérification qui rend son verdict note où en était le travail :
		// à sa reprise, elle saura ce qu'elle a déjà lu et n'aura pas à tout
		// reprendre pour valider une correction d'une ligne.
		if verifiers.contains(&task.role) {
			if let Some(repere) = implementation_state(&mission, &verifiers).await {
				let _ = mission::set_checkpoint(id, &task.id, &repere);
			}
			// Et son verdict devient un fait de la mission, pas une phrase que
			// le maître est libre de ne pas relire. Une vérification qui a rendu
			// sans conclure n'est pas une vérification sans reproche : faute de
			// conclusion lisible, elle est indécise, et le dira.
			let verdict = verdict_of(session, claude_session.as_deref())
				.unwrap_or(mission::Verdict::Undecided);
			{
				let _ = mission::set_task_verdict(id, &task.id, verdict);
				if verdict == mission::Verdict::Undecided {
					journal::record(
						"mission",
						&i18n::t("lib.mission.checkNoVerdict"),
						&task.title,
						false,
						&i18n::t("lib.mission.checkNoVerdictDetail"),
					);
				}
				if verdict == mission::Verdict::Blocking {
					journal::record(
						"mission",
						&i18n::t("lib.mission.checkBlocking"),
						&task.title,
						false,
						&i18n::t("lib.mission.checkBlockingDetail"),
					);
				}
			}
		}

		// Et on le libère. Un CLI qui a rendu sa copie continue d'occuper une
		// centaine de mégaoctets, son serveur MCP avec lui, sans plus rien avoir
		// à faire : une mission de cinq tâches reprise deux fois en laissait
		// vingt-trois derrière elle. Le travail, lui, est dans le worktree ; la
		// conversation reste lisible sur le disque.
		let _ = agent::stop(&agents, session);
		changed = true;
	}
	changed
}

/// Coupe les agents de mission que plus aucune tâche ne réclame.
///
/// Filet plutôt que règle : chaque chemin qui termine une tâche coupe déjà son
/// exécutant. Mais il suffit qu'un seul l'oublie pour qu'un CLI reste en vie
/// jusqu'à la fermeture de l'app, et l'addition se compte en gigaoctets. On
/// repasse donc derrière, sur les sessions que les missions désignent — jamais
/// sur un agent ouvert à la main, qui n'appartient à personne.
fn reap_stray_agents(app: &AppHandle) -> usize {
	use tauri::Manager;
	let Some(agents) = app.try_state::<agent::SharedAgents>() else {
		return 0;
	};
	let agents = agents.inner().clone();

	let mut reaped = 0;
	for mission in mission::list() {
		let close = mission.state == mission::MissionState::Done
			|| mission.state == mission::MissionState::Failed;

		if let Some(session) = &mission.master_session {
			if close && !agent::is_working(&agents, session) {
				let _ = agent::stop(&agents, session);
				let _ = mission::update_master_session(&mission.id, None);
				reaped += 1;
			} else if !close {
				if let Some(age) = agent::turn_age(&agents, session) {
					if age >= MASTER_TURN_TIMEOUT {
						let _ = agent::stop(&agents, session);
						journal::record(
							"mission",
							&i18n::t("lib.mission.masterTimedOut"),
							&mission.title,
							false,
							&i18n::tf(
								"lib.mission.masterTimedOutDetail",
								&[("minutes", &(age.as_secs() / 60))],
							),
						);
						reaped += 1;
					}
				}
			}
		}

		for task in &mission.tasks {
			let Some(session) = &task.session_id else { continue };
			if task.state == mission::TaskState::Running {
				continue;
			}
			if agent::is_working(&agents, session) {
				continue;
			}
			let _ = agent::stop(&agents, session);
			reaped += 1;
		}
	}
	reaped
}

/// Fait passer la mission à l'intégration quand tout est livré.
///
/// Le maître a rendu la main depuis longtemps : le CLI termine à la fin de
/// chaque tour. On le rappelle donc avec ce qu'il lui reste à faire, plutôt que
/// d'attendre une initiative de sa part qui ne viendra pas.
async fn move_to_integration(app: &AppHandle, id: &str) {
	use tauri::Manager;
	let Ok(mission) = mission::get(id) else { return };
	if mission.state != mission::MissionState::Running || mission.tasks.is_empty() {
		return;
	}
	// Aucun rôle n'est mis à part ici : c'est bien tout le monde qu'on attend,
	// recette et relecture comprises.
	if !mission.implementation_done(|_| false) {
		return;
	}

	let _ = mission::set_state(
		id,
		mission::MissionState::Integrating,
		&i18n::t("lib.mission.allDelivered"),
	);

	// Inutile d'en relancer un si le précédent travaille encore ; et s'il a
	// fini, on le coupe avant d'en lancer un autre — sans quoi chaque phase de
	// la mission empilait un maître de plus, tous vivants.
	if let Some(agents) = app.try_state::<agent::SharedAgents>() {
		if let Some(session) = &mission.master_session {
			if agent::is_working(agents.inner(), session) {
				return;
			}
			let _ = agent::stop(agents.inner(), session);
		}
	}

	// Ce qu'il ne peut pas savoir : que la recette et la relecture ont rendu un
	// verdict, et qu'un refus se traite en renvoyant la tâche plutôt qu'en
	// corrigeant soi-même. La suite — intégrer, rendre compte, ouvrir la PR —
	// est décrite par les outils.
	let brief = "All workers have delivered. QA and review ended their report with a \
	             verdict: read them before anything else.\n\n\
	             On a blocking verdict, do not fix it yourself — `rework` the faulty task, \
	             passing on the points to rework. It will restart on its own, the checks \
	             will judge again, and you will be called back. Three reworks at most per \
	             task; beyond that, explain what is blocking and stop there.\n\n\
	             When the repository declares checks, `integrate` only merges the tasks that \
	             pass them. A failed check comes back with its output: `rework` the task with \
	             it, the same way as a blocking verdict."
		.to_string();
	if let Err(error) = launch_master(
		app.clone(),
		id.to_string(),
		Some(brief),
		executions::Origin::cockpit(config::MASTER_ROLE),
	)
	.await
	{
		journal::record(
			"mission",
			&i18n::t("lib.mission.masterNotRelaunched"),
			&mission.title,
			false,
			&error.to_string(),
		);
	}
}

/// Au-delà, une intégration qui n'a pas bougé n'attend plus rien.
///
/// Assez long pour laisser un maître travailler sans être doublé — il peut
/// rester silencieux le temps d'un merge ou d'une lecture de branche — assez
/// court pour qu'une panne se voie dans la matinée plutôt qu'au retour de
/// déjeuner.
const INTEGRATION_STALL_SECONDS: i64 = 240;

/// Au-delà, un tour de maître qui n'a pas rendu la main n'attend plus une fin
/// de merge : il est bloqué.
///
/// Ni la mort du process ni un `result` de fin de tour ne garantissent qu'on
/// s'en aperçoive — un CLI figé ou un réseau qui ne répond plus laisse
/// `is_working` vrai indéfiniment, et `revive_integration`/
/// `move_to_integration` attendent alors pour rien : c'est exactement ce
/// qu'a montré une mission réelle, bloquée 90 minutes d'affilée sur son
/// intégration. Généreux — un vrai merge conflictuel ou une grosse relecture
/// peuvent prendre du temps — mais borné : voir `reap_stray_agents`.
const MASTER_TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Remet un maître debout sur une intégration qui s'est arrêtée toute seule.
///
/// On ne double jamais un maître qui travaille : c'est seulement quand plus
/// personne ne tient la mission, et qu'elle n'a rien écrit depuis un moment,
/// qu'on la reprend. Le compteur repart à chaque écriture, donc un maître
/// relancé qui avance n'est pas relancé de nouveau.
async fn revive_integration(app: &AppHandle, mission: &mission::Mission) {
	use tauri::Manager;
	if mission::idle_seconds(mission) < INTEGRATION_STALL_SECONDS {
		return;
	}
	if let Some(agents) = app.try_state::<agent::SharedAgents>() {
		if let Some(session) = &mission.master_session {
			if agent::is_working(agents.inner(), session) {
				return;
			}
		}
	}

	journal::record(
		"mission",
		&i18n::t("lib.mission.integrationResumed"),
		&mission.title,
		true,
		&i18n::t("lib.mission.integrationResumedDetail"),
	);
	let brief = format!(
		"You are taking over the mission \"{}\" at integration: it has not moved for \
		 a while and nobody was holding it.\n\n\
		 Start with `status` to see where the tasks stand, then `integrate` — merging \
		 an already merged branch costs nothing, and it is the only way to know what \
		 is still outside. Open the pull request once everything is recombined; if a \
		 conflict stops you, say so and stop there.",
		mission.title,
	);
	if let Err(error) = launch_master(
		app.clone(),
		mission.id.clone(),
		Some(brief),
		executions::Origin::cockpit(config::MASTER_ROLE),
	)
	.await
	{
		journal::record(
			"mission",
			&i18n::t("lib.mission.integrationNotResumed"),
			&mission.title,
			false,
			&error.to_string(),
		);
	}
}

fn watch_missions(app: AppHandle) {
	tauri::async_runtime::spawn(async move {
		let mut tours: u64 = 0;
		loop {
			tokio::time::sleep(std::time::Duration::from_secs(6)).await;
			reap_stray_agents(&app);
			// La dépense se relit toutes les minutes, pas toutes les six
			// secondes : elle demande de parcourir les journaux de toutes les
			// sessions, et une mission ne dérape pas en six secondes.
			tours += 1;
			if tours % 10 == 0 {
				pause_missions_hors_budget();
			}
			for mission in mission::list() {
				if mission.paused {
					continue;
				}
				// L'intégration se surveille comme le reste. Elle ne l'était pas :
				// une fois la mission passée en `Integrating`, cette boucle la
				// sautait, et si le maître mourait, terminait son tour sans ouvrir
				// la pull request, ou n'avait jamais démarré, la mission restait là
				// des heures sans que rien ne la reprenne ni ne le dise.
				if mission.state == mission::MissionState::Integrating {
					revive_integration(&app, &mission).await;
					continue;
				}
				if mission.state != mission::MissionState::Running {
					continue;
				}
				// Constater avant de lancer : une tâche qui vient de finir peut
				// libérer la recette, qui partira dans la foulée.
				collect_finished_tasks(&app, &mission.id).await;
				launch_ready_tasks(app.clone(), &mission.id).await;
				move_to_integration(&app, &mission.id).await;
			}
		}
	});
}

/// Traite les appels que le maître dépose par son pont MCP.
///
/// Une boucle plutôt qu'un serveur : le maître écrit un fichier, le cockpit
/// répond par un autre. Un agent tué en plein appel ne laisse qu'un fichier
/// orphelin, là où un socket coupé laisserait les deux côtés à s'attendre.
/// Le regard de la Permanence, à la cadence déclarée.
///
/// La boucle tourne toujours ; ce sont ses portes qui décident, et elles sont
/// dans `permanence::look`. C'est délibéré : une boucle qu'on n'aurait pas
/// lancée parce que le service était éteint au démarrage ne repartirait pas
/// quand on l'allume, et il faudrait redémarrer le cockpit pour s'en servir.
///
/// La cadence se relit à chaque tour plutôt qu'au lancement, pour la même
/// raison : un réglage qui n'a d'effet qu'au prochain démarrage n'est pas un
/// réglage, c'est une option de compilation.
fn watch_permanence(app: AppHandle) {
	tauri::async_runtime::spawn(async move {
		loop {
			let minutes = cfg().permanence.cadence();
			tokio::time::sleep(std::time::Duration::from_secs(minutes * 60)).await;
			if let Err(error) = permanence::look(None, Some(app.clone())).await {
				eprintln!("permanence : {error}");
			}
		}
	});
}

fn watch_orchestrator(app: AppHandle) {
	tauri::async_runtime::spawn(async move {
		loop {
			tokio::time::sleep(std::time::Duration::from_millis(300)).await;
			for call in orchestrator::pending() {
				orchestrator::handle(&app, call).await;
			}
		}
	});
}

/// Refuse les écritures qui sortent du périmètre d'une tâche.
///
/// Le pont d'autorisation dépose chaque demande sur le disque avant de
/// l'afficher : on l'examine ici, en amont. Une consigne de périmètre écrite
/// dans un prompt tient tant que le modèle y pense ; celle-ci ne dépend plus
/// de lui, et l'exécutant reçoit un refus motivé plutôt qu'un silence.
///
/// Seules les écritures de fichiers sont jugées : deviner ce qu'une ligne de
/// commande va toucher serait une promesse qu'on ne peut pas tenir, et un
/// refus faux vaut moins qu'une question posée à l'humain.
fn watch_scopes() {
	tauri::async_runtime::spawn(async move {
		loop {
			tokio::time::sleep(std::time::Duration::from_millis(400)).await;
			for request in permissions::pending() {
				let Some(session) = request.session_id.as_deref() else {
					continue;
				};
				// Un agent de revue lit, il n'écrit pas : tout ce qui n'est pas
				// une lecture autorisée d'office arrive ici, et repart refusé.
				// Une question à la personne, elle, passe.
				if review::is_readonly(session) && request.tool != "AskUserQuestion" {
					let reason = format!(
						"Read-only review: \"{}\" is not allowed. Review without modifying anything, \
						 with `git diff`, `git log`, `git show` or by reading the files.",
						request.tool
					);
					let _ = permissions::answer(&request.id, false, Some(reason));
					continue;
				}
				let Some((task, root, scope)) = mission::scope_of(session) else {
					continue;
				};
				let outside: Vec<String> = mission::written_paths(&request.tool, &request.input)
					.into_iter()
					.filter(|path| !mission::within_scope_at(&root, &scope, path))
					.collect();
				if outside.is_empty() {
					continue;
				}
				let reason = format!(
					"Outside the scope of \"{task}\": {}. Allowed paths: {}. \
					 If this file needs to change, report it instead of modifying it.",
					outside.join(", "),
					scope.join(", ")
				);
				let _ = permissions::answer(&request.id, false, Some(reason));
				journal::record("mission", &i18n::t("lib.mission.outOfScopeRefused"), &outside.join(", "), false, &task);
			}
		}
	});
}

fn watch_sessions(app: AppHandle) {
	use notify::{RecursiveMode, Watcher};

	std::thread::spawn(move || {
		let (tx, rx) = std::sync::mpsc::channel();
		let mut watcher = match notify::recommended_watcher(tx) {
			Ok(watcher) => watcher,
			Err(_) => return,
		};

		// Un compte par racine : surveiller la seule racine du compte actif
		// aurait figé l'écran des sessions dès qu'un agent travaille sous une
		// autre identité. Un dossier qui n'existe pas encore — un compte déclaré
		// mais jamais utilisé — n'empêche pas de surveiller les autres.
		let mut surveillées = 0;
		for root in sessions::projects_roots() {
			if watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
				surveillées += 1;
			}
		}
		if surveillées == 0 {
			return;
		}

		let mut pending = false;
		let mut last_emit = std::time::Instant::now();
		loop {
			match rx.recv_timeout(std::time::Duration::from_millis(700)) {
				Ok(Ok(_)) => pending = true,
				Ok(Err(_)) => {}
				Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
				Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
			}

			if pending && last_emit.elapsed() >= std::time::Duration::from_millis(1500) {
				pending = false;
				last_emit = std::time::Instant::now();
				let _ = app.emit("sessions://changed", ());
			}
		}
	});
}

/// Un mouvement dans `.git` qui change vraiment ce que l'UI affiche.
///
/// Lire l'état d'un dépôt le modifie : `git status` rafraîchit le cache de
/// `stat` dans `.git/index`, ce qui réveille le watcher, ce qui relance une
/// lecture — la boucle tient toute seule et fait vibrer l'écran en continu. On
/// ne retient donc que les refs, HEAD et les worktrees, c'est-à-dire ce qu'un
/// commit, un checkout ou un merge déplacent réellement.
fn is_meaningful_git_change(path: &Path) -> bool {
	let text = path.to_string_lossy();

	// Fichiers de travail internes : bruit pur.
	if text.ends_with(".lock") || text.contains("/objects/") || text.ends_with("FETCH_HEAD") {
		return false;
	}

	text.contains("/refs/")
		|| text.contains("/worktrees/")
		|| text.ends_with("/HEAD")
		|| text.ends_with("MERGE_HEAD")
		|| text.ends_with("packed-refs")
}

/// Surveille le `.git` du dépôt principal et notifie l'UI à chaque mouvement
/// (commit, checkout, création de worktree).
///
/// C'est volontairement le dossier `.git` et non l'arbre de travail : celui-ci
/// contient `node_modules` et les artefacts de build, dont les rafales
/// noieraient le signal. Les métadonnées des worktrees vivant sous
/// `.git/worktrees/`, une seule surveillance récursive les couvre tous.
fn watch_git(app: AppHandle) {
	use notify::{RecursiveMode, Watcher};

	std::thread::spawn(move || {
		let git_dir = PathBuf::from(&cfg().general.main_repo).join(".git");
		if !git_dir.exists() {
			return;
		}

		let (tx, rx) = std::sync::mpsc::channel();
		let mut watcher = match notify::recommended_watcher(tx) {
			Ok(watcher) => watcher,
			Err(_) => return,
		};
		if watcher.watch(&git_dir, RecursiveMode::Recursive).is_err() {
			return;
		}

		let mut pending = false;
		let mut last_emit = std::time::Instant::now();
		loop {
			match rx.recv_timeout(std::time::Duration::from_millis(700)) {
				Ok(Ok(event)) => {
					if event.paths.iter().any(|path| is_meaningful_git_change(path)) {
						pending = true;
					}
				}
				Ok(Err(_)) => {}
				Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
				Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
			}

			if pending && last_emit.elapsed() >= std::time::Duration::from_secs(2) {
				pending = false;
				last_emit = std::time::Instant::now();
				let _ = app.emit("git://changed", ());
			}
		}
	});
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Relève le plafond de fichiers ouverts du processus.
///
/// Lancé depuis le Finder, le cockpit hérite du plafond par défaut de
/// launchd — 256, vérifié via `launchctl limit maxfiles` sur ce poste —
/// largement insuffisant dès que plusieurs missions tournent en parallèle :
/// chaque conteneur isolé ouvre plusieurs volumes, pipes et processus
/// enfants, et un agent de plus finissait par refuser de démarrer sur
/// « Too many open files (os error 24) ». La limite dure (`unlimited` ici)
/// autorise bien plus haut ; il suffit de le demander au noyau.
#[cfg(unix)]
fn raise_file_descriptor_limit() {
	// Sûr : `rlimit` est un struct C simple (deux entiers), sans invariant
	// à préserver au-delà de ce que `getrlimit`/`setrlimit` documentent.
	unsafe {
		let mut limit = libc::rlimit {
			rlim_cur: 0,
			rlim_max: 0,
		};
		if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) != 0 {
			return;
		}
		let souhaite = (10_240u64).min(limit.rlim_max as u64);
		if souhaite > limit.rlim_cur as u64 {
			limit.rlim_cur = souhaite as libc::rlim_t;
			let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
		}
	}
}

#[cfg(not(unix))]
fn raise_file_descriptor_limit() {}

#[cfg(all(test, unix))]
mod file_descriptor_limit_tests {
	use super::raise_file_descriptor_limit;

	/// Sur le vrai noyau de la machine qui fait tourner ce test, pas une
	/// hypothèse sur `libc` : le plafond effectif doit vraiment monter.
	#[test]
	fn releve_vraiment_le_plafond_du_processus() {
		let lire = || unsafe {
			let mut limit = libc::rlimit {
				rlim_cur: 0,
				rlim_max: 0,
			};
			libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit);
			limit
		};

		// Redescendu d'abord : un run précédent, ou l'environnement de test
		// lui-même, peut déjà être large — sans ça, ce test ne prouverait
		// rien de plus qu'un plafond déjà confortable.
		let avant = lire();
		unsafe {
			let bas = libc::rlimit {
				rlim_cur: 64,
				rlim_max: avant.rlim_max,
			};
			libc::setrlimit(libc::RLIMIT_NOFILE, &bas);
		}
		assert_eq!(lire().rlim_cur, 64);

		raise_file_descriptor_limit();

		let apres = lire();
		assert!(
			apres.rlim_cur > 64,
			"le plafond n'a pas bougé : {}",
			apres.rlim_cur
		);
	}
}

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
			// Les rendez-vous : un premier tour tout de suite, qui rattrape ce que le
			// cockpit fermé a laissé passer. Voir `automations.rs`.
			automations::watch(app.handle().clone());
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
			team_board,
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
			projects_health,
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
			automations_overview,
			automation_save,
			automation_remove,
			automation_run_now,
			automation_drop_line,
			automation_latest_daily,
			automation_try,
			automation_correct,
			automation_export_pdf,
			automation_post_slack,
			automation_reveal_exports,
			window_zoom_toggle,
			missions_list,
			missions_everywhere,
			mission_estimate,
			mission_overruns,
			mission_get,
			mission_create,
			mission_from_ticket,
			mission_start_from_ticket,
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
			mission_cleanup,
			roles_list,
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
