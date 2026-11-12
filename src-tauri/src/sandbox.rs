//! Isoler un agent dans un conteneur plutôt que le lancer en direct.
//!
//! Le coupe-circuit mémoire (`resources::over_ceiling`) mesure et refuse
//! après coup : il protège la machine, pas un agent isolé des autres. Un
//! agent qui lance lui-même un `pnpm dev` ou un build lourd via son propre
//! outil Bash reste invisible de cette mesure jusqu'à ce qu'il soit trop
//! tard. Un plafond imposé par le runtime de conteneurs, lui, tient même
//! dans ce cas — le noyau tue le processus qui dépasse, pas macOS au hasard.
//!
//! On lance donc, quand c'est activé, `<runtime> run` au lieu de `zsh`
//! directement : le protocole qui dialogue avec l'agent (stdin/stdout en
//! JSON, une ligne par message) ne change pas, seul ce qui l'entoure change.
//!
//! Un client `docker run`/`orb run` tué (`kill_on_drop`) n'arrête pas le
//! conteneur pour autant — vérifié empiriquement, pas supposé : le conteneur
//! continue tant que rien ne lui envoie l'ordre. Chaque conteneur porte donc
//! un nom déterministe (`cockpit-agent-<session>`), et `agent::stop`/
//! `agent::stop_all` l'utilisent pour le tuer explicitement en plus du client.

use crate::config::SandboxConfig;
use std::path::PathBuf;
use tokio::process::Command;

/// Image par défaut : node + `claude` + git, le strict nécessaire pour faire
/// tourner un agent et ses ponts MCP. Cockpit la construit lui-même au
/// premier lancement isolé (voir `ensure_image`) — quelqu'un qui coche
/// « isoler » n'a pas à savoir qu'une image Docker existe, encore moins à la
/// fabriquer à la main.
pub const DEFAULT_IMAGE: &str = "cockpit-agent:latest";

/// Dockerfile de l'image par défaut, embarqué dans le binaire à la
/// compilation — pas de fichier à distribuer ni de chemin à retrouver au
/// premier lancement.
const DEFAULT_DOCKERFILE: &str = include_str!("../../sandbox/Dockerfile");

/// Chemin absolu de `binary`, si le poste en a un.
///
/// Même piège que `agent::claude_binary` : lancé depuis le Finder, le
/// cockpit n'hérite que d'un PATH minimal qui omet `/usr/local/bin` et
/// `/opt/homebrew/bin` — là où Docker Desktop et OrbStack posent leur CLI.
/// Un `docker` bel et bien installé se voyait donc déclaré absent. On
/// redemande à un shell de login, qui lit le profil, avant de céder.
///
/// Sous Windows, Docker Desktop pose `docker.exe` dans
/// `C:\Program Files\Docker\Docker\resources\bin` ; OrbStack n'existe pas.
fn which(binary: &str) -> Option<String> {
	// Un chemin absolu déclaré en réglage vaut pour lui-même.
	if std::path::Path::new(binary).is_absolute() {
		return std::path::Path::new(binary).is_file().then(|| binary.to_string());
	}
	// Sinon un nom de programme, jamais un morceau de commande : il part dans
	// une ligne de shell juste en dessous.
	if binary.is_empty() || !binary.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
		return None;
	}
	let file = crate::platform::exe(binary);
	if std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(&file).is_file()))
	{
		return Some(binary.to_string());
	}

	#[cfg(windows)]
	{
		let mut command = std::process::Command::new("where");
		command.arg(&file);
		if let Ok(output) = crate::platform::quiet_std(&mut command).output() {
			if let Some(found) = String::from_utf8_lossy(&output.stdout)
				.lines()
				.map(str::trim)
				.find(|line| std::path::Path::new(line).is_file())
			{
				return Some(found.to_string());
			}
		}
		["ProgramFiles", "ProgramW6432"]
			.iter()
			.filter_map(|name| std::env::var(name).ok())
			.map(|base| {
				std::path::Path::new(&base)
					.join("Docker")
					.join("Docker")
					.join("resources")
					.join("bin")
					.join(&file)
			})
			.find(|path| path.is_file())
			.map(|path| path.to_string_lossy().to_string())
	}

	#[cfg(not(windows))]
	{
		if let Ok(output) = crate::platform::shell(&format!("command -v {binary}")).output() {
			let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
			if !found.is_empty() && std::path::Path::new(&found).exists() {
				return Some(found);
			}
		}

		let home = home()
			.map(|path| path.to_string_lossy().to_string())
			.unwrap_or_default();
		[
			format!("/opt/homebrew/bin/{binary}"),
			format!("/usr/local/bin/{binary}"),
			format!("{home}/.orbstack/bin/{binary}"),
		]
		.into_iter()
		.find(|path| std::path::Path::new(path).exists())
	}
}

/// Un `Command` du runtime, sans fenêtre console sous Windows.
fn runtime_command(runtime: &str) -> Command {
	let mut command = Command::new(runtime);
	crate::platform::quiet_async(&mut command);
	command
}

/// Le chemin d'un dossier de l'hôte **dans le conteneur**.
///
/// Sous macOS, le même : le worktree est monté au même chemin absolu (voir
/// `build`). Sous Windows, un conteneur Linux n'a pas de `C:` : `C:\Users\a`
/// y devient `/c/Users/a` — la forme que Git Bash donne au même dossier.
pub fn container_path(host: &str) -> String {
	if !cfg!(windows) {
		return host.to_string();
	}
	let forward = host.replace('\\', "/");
	let bytes = forward.as_bytes();
	if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
		let rest = forward[2..].trim_start_matches('/');
		return format!("/{}/{}", (bytes[0] as char).to_ascii_lowercase(), rest)
			.trim_end_matches('/')
			.to_string();
	}
	forward
}

/// Le chemin de l'hôte tel que `docker -v` l'attend : `C:/Users/a` sous
/// Windows (Docker Desktop reconnaît la lettre de lecteur), inchangé ailleurs.
fn volume_source(host: &str) -> String {
	if cfg!(windows) {
		host.replace('\\', "/")
	} else {
		host.to_string()
	}
}

/// `-v <hôte>:<conteneur>[:ro]`.
fn volume(host: &std::path::Path, read_only: bool) -> String {
	let host = host.to_string_lossy();
	format!(
		"{}:{}{}",
		volume_source(&host),
		container_path(&host),
		if read_only { ":ro" } else { "" }
	)
}

/// Le runtime effectivement disponible (chemin absolu) : celui déclaré en
/// config, ou le premier trouvé sur le poste. `None` quand aucun n'est
/// installé — c'est à l'appelant de décider si ça bloque ou si ça retombe en
/// direct.
pub fn resolve_runtime(declared: &str) -> Option<String> {
	let declared = declared.trim();
	if !declared.is_empty() {
		return which(declared);
	}
	["orb", "docker"].into_iter().find_map(which)
}

async fn image_exists(runtime: &str, image: &str) -> bool {
	runtime_command(runtime)
		.arg("image")
		.arg("inspect")
		.arg(image)
		.output()
		.await
		.is_ok_and(|output| output.status.success())
}

/// Construit `DEFAULT_IMAGE` à partir du Dockerfile embarqué. N'est jamais
/// appelée pour une image déclarée par l'utilisateur — celle-là, on ne sait
/// pas la reconstruire, ce n'est pas la nôtre.
/// Empreinte du Dockerfile embarqué, posée sur l'image qu'il produit.
///
/// Sans elle, une image construite une fois ne bouge plus jamais : le
/// Dockerfile pouvait gagner un outil — `gh`, sans lequel un agent isolé ne
/// peut ni lire ni ouvrir une pull request — et l'image installée continuait
/// de tourner sans, indéfiniment. Personne n'avait de raison de la
/// reconstruire, puisque rien ne disait qu'elle était périmée.
pub fn dockerfile_stamp() -> String {
	let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
	for byte in DEFAULT_DOCKERFILE.as_bytes() {
		hash ^= *byte as u64;
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	format!("{hash:x}")
}

/// L'empreinte que porte l'image installée, quand elle en porte une.
async fn image_stamp(runtime: &str, image: &str) -> Option<String> {
	let output = runtime_command(runtime)
		.arg("inspect")
		.arg("--format")
		.arg("{{ index .Config.Labels \"cockpit.dockerfile\" }}")
		.arg(image)
		.output()
		.await
		.ok()?;
	if !output.status.success() {
		return None;
	}
	let stamp = String::from_utf8_lossy(&output.stdout).trim().to_string();
	(!stamp.is_empty() && stamp != "<no value>").then_some(stamp)
}

async fn build_default_image(runtime: &str) -> Result<(), String> {
	let dir = std::env::temp_dir().join("cockpit-sandbox-build");
	tokio::fs::create_dir_all(&dir)
		.await
		.map_err(|error| crate::i18n::tf("sandbox.buildDir", &[("error", &error)]))?;
	tokio::fs::write(dir.join("Dockerfile"), DEFAULT_DOCKERFILE)
		.await
		.map_err(|error| crate::i18n::tf("sandbox.writeDockerfile", &[("error", &error)]))?;

	let output = runtime_command(runtime)
		.arg("build")
		.arg("-t")
		.arg(DEFAULT_IMAGE)
		// L'empreinte voyage avec l'image : c'est elle qu'on relira pour savoir
		// si celle qui est installée correspond encore à ce qu'on sait écrire.
		.arg("--label")
		.arg(format!("cockpit.dockerfile={}", dockerfile_stamp()))
		.arg(&dir)
		.output()
		.await
		.map_err(|error| error.to_string())?;

	if output.status.success() {
		Ok(())
	} else {
		Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
	}
}

/// S'assure que l'image à lancer est prête, en construisant la nôtre si elle
/// manque encore. Une image déclarée par l'utilisateur reste sous sa
/// responsabilité : on ne devine pas comment la produire, seulement dire
/// clairement qu'elle manque.
pub async fn ensure_image(runtime: &str, sandbox: &SandboxConfig) -> Result<(), String> {
	let declared = sandbox.image.trim();
	let image = if declared.is_empty() { DEFAULT_IMAGE } else { declared };

	if image_exists(runtime, image).await {
		// Une image déclarée par l'utilisateur ne nous appartient pas : on ne
		// la reconstruit jamais, et son contenu le regarde.
		if !declared.is_empty() {
			return Ok(());
		}
		// La nôtre, en revanche, doit correspondre au Dockerfile de cette
		// version. Une image d'il y a une semaine n'a pas les outils qu'on a
		// ajoutés depuis, et rien ne le disait.
		if image_stamp(runtime, image).await.as_deref() == Some(dockerfile_stamp().as_str()) {
			return Ok(());
		}
		return build_default_image(runtime).await;
	}

	if !declared.is_empty() {
		return Err(crate::i18n::tf("sandbox.imageMissing", &[("image", &image)]));
	}

	build_default_image(runtime).await
}

/// Nom déterministe du conteneur d'une session — c'est par lui qu'on le
/// retrouve pour le tuer, jamais par le PID du client.
pub fn container_name(session_id: &str) -> String {
	format!("cockpit-agent-{session_id}")
}

fn home() -> Option<PathBuf> {
	dirs::home_dir()
}

/// Le dépôt d'origine d'un worktree, lu dans son fichier `.git`.
///
/// `<worktree>/.git` est un fichier — pas un dossier — contenant
/// `gitdir: <dépôt>/.git/worktrees/<nom>` : deux crans au-dessus retrouvent
/// la racine du dépôt. `None` pour un dossier qui n'est pas un worktree
/// (le `.git` y est un dossier, `read_to_string` échoue proprement dessus).
fn worktree_origin(cwd: &str) -> Option<PathBuf> {
	let raw = std::fs::read_to_string(std::path::Path::new(cwd).join(".git")).ok()?;
	let gitdir = raw.strip_prefix("gitdir:")?.trim();
	let worktree_entry = std::path::Path::new(gitdir);
	let git_dir = worktree_entry.parent()?.parent()?;
	let repo_root = git_dir.parent()?;
	Some(repo_root.to_path_buf())
}

/// L'UID et le GID du poste — vérifiés empiriquement nécessaires : sans
/// `--user`, l'image tourne en `root` (voir le Dockerfile), et Claude Code
/// refuse `bypassPermissions` — le mode par défaut de tout exécutant — sous
/// root ou sudo, "for security reasons".
///
/// Ne règle pas, contrairement à ce qu'on avait d'abord cru ici, l'avertissement
/// de confiance sur `.claude/settings.json` — vérifié faux par la suite : ce
/// premier essai n'avait rien à avertir, faute d'un `.claude/settings.json` à
/// lire dans le dépôt de test. Voir `trust_worktree`.
///
/// Sous Windows, ni `id` ni uid : Docker Desktop présente les dossiers montés
/// depuis `C:` comme accessibles à tous, et l'image n'exige que de ne pas
/// tourner en `root`. 1000:1000, le premier compte ordinaire d'un Linux.
fn host_ids() -> Option<(String, String)> {
	#[cfg(windows)]
	{
		Some(("1000".to_string(), "1000".to_string()))
	}
	#[cfg(not(windows))]
	{
		host_ids_unix()
	}
}

#[cfg(not(windows))]
fn host_ids_unix() -> Option<(String, String)> {
	let uid = std::process::Command::new("id").arg("-u").output().ok()?;
	let gid = std::process::Command::new("id").arg("-g").output().ok()?;
	if !uid.status.success() || !gid.status.success() {
		return None;
	}
	Some((
		String::from_utf8_lossy(&uid.stdout).trim().to_string(),
		String::from_utf8_lossy(&gid.stdout).trim().to_string(),
	))
}

/// Où un agent isolé range ses identifiants Claude Code.
///
/// Jamais le compte de l'hôte : un abonnement connecté par `claude login`
/// range son jeton dans le trousseau macOS — vérifié empiriquement via
/// `security find-generic-password` — inaccessible à un conteneur Linux,
/// quel que soit ce qu'on y monte. Ce dossier attend un jeton posé par
/// `claude setup-token` (voir `login_command`), qui écrit dans un fichier
/// plutôt que dans le trousseau — c'est justement pour ça qu'il existe.
pub fn sandbox_account_dir() -> PathBuf {
	crate::config::config_dir().join("sandbox-account")
}

/// Approuve `cwd` dans le compte isolé avant même le premier lancement.
///
/// Chaque mission ouvre un worktree que ce compte, séparé de celui de l'hôte,
/// n'a jamais vu : sans ça, Claude Code ignore les règles `permissions.allow`
/// du dépôt et le répète à chaque tour, un avertissement qui n'a structurellement
/// aucune chance de s'éteindre tout seul — vérifié, aucune mission ne rouvre
/// deux fois le même worktree. Best-effort : un agent qui démarre quand même
/// vaut mieux qu'un agent bloqué sur un fichier de confiance illisible.
fn trust_worktree(account_dir: &std::path::Path, cwd: &str) {
	let path = account_dir.join(".claude.json");
	let mut value: serde_json::Value = std::fs::read_to_string(&path)
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_else(|| serde_json::json!({}));

	let Some(root) = value.as_object_mut() else {
		return;
	};
	let projects = root.entry("projects").or_insert_with(|| serde_json::json!({}));
	let Some(projects) = projects.as_object_mut() else {
		return;
	};
	let entry = projects.entry(cwd.to_string()).or_insert_with(|| serde_json::json!({}));
	let Some(entry) = entry.as_object_mut() else {
		return;
	};
	entry.insert("hasTrustDialogAccepted".into(), serde_json::json!(true));

	if let Ok(serialized) = serde_json::to_string_pretty(&value) {
		let _ = std::fs::create_dir_all(account_dir);
		let _ = std::fs::write(&path, serialized);
	}
}

/// Recopie les serveurs MCP déclarés dans le `.claude.json` de l'hôte vers
/// celui du compte isolé, ceux qu'il n'a pas déjà.
///
/// Une identité neuve n'a par construction aucun serveur enregistré : Linear,
/// Trigger, Stripe… déclarés une fois pour toutes côté hôte n'existaient nulle
/// part côté conteneur, et un maître qui en a besoin pour découper un ticket
/// restait bloqué avant même de commencer. N'écrase jamais une entrée déjà
/// présente : si le compte isolé a fini par autoriser lui-même un serveur
/// (jeton propre à cette identité), cette autorisation prime sur la copie.
fn sync_mcp_servers(host_claude_json: &std::path::Path, account_dir: &std::path::Path) {
	let Some(host_servers) = std::fs::read_to_string(host_claude_json)
		.ok()
		.and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
		.and_then(|value| value.get("mcpServers").cloned())
		.and_then(|servers| servers.as_object().cloned())
	else {
		return;
	};
	if host_servers.is_empty() {
		return;
	}

	let path = account_dir.join(".claude.json");
	let mut value: serde_json::Value = std::fs::read_to_string(&path)
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_else(|| serde_json::json!({}));

	let Some(root) = value.as_object_mut() else {
		return;
	};
	let servers = root.entry("mcpServers").or_insert_with(|| serde_json::json!({}));
	let Some(servers) = servers.as_object_mut() else {
		return;
	};
	for (name, config) in host_servers {
		servers.entry(name).or_insert(config);
	}

	if let Ok(serialized) = serde_json::to_string_pretty(&value) {
		let _ = std::fs::create_dir_all(account_dir);
		let _ = std::fs::write(&path, serialized);
	}
}

/// Authentifie par jeton les serveurs MCP hébergés dont Cockpit a déjà la
/// clé, plutôt que de dépendre d'OAuth.
///
/// Recopier la déclaration d'un serveur OAuth (`sync_mcp_servers`) ne suffit
/// jamais : son jeton vit dans le trousseau macOS, jamais dans un fichier —
/// vérifié en cherchant partout ailleurs. `claude mcp add --header` documente
/// une vraie alternative : un jeton statique, posé une fois pour toutes.
/// Vérifié bout en bout — un vrai jeton Linear, un vrai conteneur, les
/// équipes réelles renvoyées — avant d'écrire cette fonction, pas après.
fn provision_mcp_tokens(account_dir: &std::path::Path, tokens: &[(&str, &str, &str)]) {
	let usable: Vec<_> = tokens.iter().filter(|(_, _, token)| !token.trim().is_empty()).collect();
	if usable.is_empty() {
		return;
	}

	let path = account_dir.join(".claude.json");
	let mut value: serde_json::Value = std::fs::read_to_string(&path)
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_else(|| serde_json::json!({}));

	let Some(root) = value.as_object_mut() else {
		return;
	};
	let servers = root.entry("mcpServers").or_insert_with(|| serde_json::json!({}));
	let Some(servers) = servers.as_object_mut() else {
		return;
	};

	for (name, url, token) in usable {
		servers.insert(
			(*name).to_string(),
			serde_json::json!({
				"type": "http",
				"url": url,
				"headers": { "Authorization": format!("Bearer {}", token.trim()) },
			}),
		);
	}

	if let Ok(serialized) = serde_json::to_string_pretty(&value) {
		let _ = std::fs::create_dir_all(account_dir);
		let _ = std::fs::write(&path, serialized);
	}
}

/// Construit la commande qui lance `shell_command` dans un conteneur au lieu
/// d'un `zsh` en direct.
///
/// Le worktree est monté au même chemin absolu à l'intérieur qu'à
/// l'extérieur : `permissions.rs` juge un périmètre en comparant des
/// chemins, un remappage lui ferait refuser tout ce qu'un agent écrit
/// légitimement. Les identifiants (Claude, git, SSH) sont montés en lecture
/// seule — un agent s'en sert pour s'authentifier, jamais pour les changer.
#[allow(clippy::too_many_arguments)]
pub fn build(
	sandbox: &SandboxConfig,
	runtime: &str,
	session_id: &str,
	cwd: &str,
	env: &[(String, String)],
	shell_command: &str,
	// `github_token` : le jeton de la forge, quand le poste en a un. Vide,
	// l'agent travaille sans accès à GitHub — et le sait, plutôt que de
	// l'apprendre au moment de pousser.
	github_token: &str,
) -> Command {
	let image = if sandbox.image.trim().is_empty() {
		DEFAULT_IMAGE
	} else {
		sandbox.image.trim()
	};

	// Les chemins tels que l'agent les verra dans le conteneur.
	let inside = container_path(cwd);
	let mut cmd = runtime_command(runtime);
	cmd.arg("run")
		.arg("--rm")
		.arg("-i")
		.arg("--name")
		.arg(container_name(session_id))
		.arg("--memory")
		.arg(format!("{}m", sandbox.memory_limit_mb()))
		.arg("--workdir")
		.arg(&inside)
		.arg("--volume")
		.arg(volume(std::path::Path::new(cwd), false));

	// Un worktree n'est jamais autonome : son `.git` est un fichier — pas un
	// dossier — qui pointe vers `<dépôt>/.git/worktrees/<nom>`, vérifié sur un
	// vrai dépôt. Sans ce dépôt d'origine monté aussi, aucune commande git n'y
	// trouve quoi que ce soit : un agent isolé committait dans le vide,
	// worktree présent, dépôt introuvable — exactement le silence que
	// `notebook::seal` ne pouvait pas distinguer d'un agent qui n'a rien fait.
	if let Some(origin) = worktree_origin(cwd) {
		if origin.exists() {
			cmd.arg("--volume").arg(volume(&origin, false));
		}
	}

	// « detected dubious ownership » sinon — vérifié empiriquement : le worktree
	// vient d'être monté, git le voit appartenir à un utilisateur qu'il ne
	// reconnaît pas d'emblée dans ce système de fichiers et refuse d'y toucher.
	// Sans fichier à écrire, `GIT_CONFIG_*` plutôt qu'un `.gitconfig` généré.
	//
	// Le second réglage rend le jeton utilisable par `git` lui-même : le dépôt
	// est cloné en HTTPS, et l'authentification y passe d'ordinaire par le
	// gestionnaire d'identifiants de `gh` — absent du conteneur. Un assistant
	// d'identifiants d'une ligne suffit à rendre le jeton que l'environnement
	// porte déjà, sans jamais l'écrire dans un fichier.
	let pousse = !github_token.trim().is_empty();
	cmd.arg("-e")
		.arg(format!("GIT_CONFIG_COUNT={}", if pousse { 2 } else { 1 }))
		.arg("-e")
		.arg("GIT_CONFIG_KEY_0=safe.directory")
		.arg("-e")
		.arg("GIT_CONFIG_VALUE_0=*");
	if pousse {
		cmd.arg("-e")
			.arg("GIT_CONFIG_KEY_1=credential.https://github.com.helper")
			.arg("-e")
			.arg(
				"GIT_CONFIG_VALUE_1=!f() { echo username=x-access-token; \
				 echo password=$GH_TOKEN; }; f",
			);
	}

	if sandbox.cpus > 0.0 {
		cmd.arg("--cpus").arg(format!("{}", sandbox.cpus));
	}

	if let Some((uid, gid)) = host_ids() {
		cmd.arg("--user").arg(format!("{uid}:{gid}"));
	}

	if let Some(home) = home() {
		// Sans ça, `$HOME` valait `/root` dans l'image — vérifié empiriquement —
		// et rien de ce qui suit ne se voyait : `claude` cherchait ses
		// identifiants dans `/root/.claude`, jamais dans le volume monté
		// ci-dessous ; les ponts MCP (`permissions.rs`, `orchestrator.rs`), qui
		// dérivent leurs chemins de `homedir()` côté Node, écrivaient dans un
		// `/root/.config/cockpit` que personne côté hôte n'allait jamais lire.
		cmd.arg("-e")
			.arg(format!("HOME={}", container_path(&home.to_string_lossy())));

		// `.claude.json` : la configuration du CLI, un fichier au même niveau
		// que le dossier `.claude` — pas dedans. Manquant, `claude` s'arrête sur
		// « Claude configuration file not found », vérifié empiriquement.
		for rel in [".claude", ".claude.json", ".gitconfig", ".ssh"] {
			let path = home.join(rel);
			if path.exists() {
				cmd.arg("--volume").arg(volume(&path, true));
			}
		}

		// Les ponts MCP eux-mêmes : leur script généré et la configuration passée
		// via `--mcp-config` vivent à la racine de `config_dir()` — en lecture
		// seule, régénérés à chaque lancement, un agent n'a aucune raison d'y
		// écrire. Les fichiers d'appel/réponse qui font le transport (voir la
		// doc de `orchestrator.rs`), eux, ont besoin d'écrire : deux volumes
		// dédiés plutôt que la racine entière — `config.toml` et `journal.jsonl`
		// y vivent aussi, et n'ont pas à être exposés à ce qui tourne isolé.
		//
		// Fichier par fichier, et non plus la racine entière en lecture seule :
		// celle-ci exposait `config.toml` — tous les jetons d'intégration
		// (Linear, Stripe, Sentry…) — et ses copies de sauvegarde à l'agent
		// qu'on isolait justement. Un utilisateur du conteneur a le même uid
		// que l'hôte : le 600 du fichier ne le protégeait de rien.
		for file in bridge_files(&crate::config::config_dir(), cwd) {
			cmd.arg("--volume").arg(volume(&file, true));
		}
		for dir in [crate::permissions::permissions_dir(), crate::orchestrator::calls_dir()] {
			if dir.exists() {
				cmd.arg("--volume").arg(volume(&dir, false));
			}
		}
	}

	// Les valeurs par l'environnement du client `docker`, jamais sur sa ligne
	// de commande : `-e NOM` sans valeur lui fait reprendre la sienne. Une
	// ligne de commande se lit dans `ps` par tout processus du poste, et ces
	// variables portent des jetons (compte, moteur, forge).
	for (name, value) in env {
		cmd.arg("-e").arg(name).env(name, value);
	}

	// Après `env`, pas avant : `docker`/`orb` retient la dernière valeur d'une
	// variable répétée, et celle que `account_env` aurait posée pour un compte
	// de l'hôte ne vaudrait rien ici — voir `sandbox_account_dir`.
	let account_dir = sandbox_account_dir();
	let _ = std::fs::create_dir_all(&account_dir);
	trust_worktree(&account_dir, &inside);
	// La confiance se lit sur le dépôt d'origine, pas sur le worktree — vérifié
	// empiriquement : le message cite le chemin du dépôt, pas celui d'où
	// `claude` tourne. `.claude/settings.json` y est suivi par git, le worktree
	// ne fait que le refléter ; approuver les deux coûte rien et couvre le cas
	// où une version future changerait d'avis sur lequel des deux compte.
	if let Some(origin) = worktree_origin(cwd) {
		trust_worktree(&account_dir, &container_path(&origin.to_string_lossy()));
	}
	if let Some(host) = home() {
		sync_mcp_servers(&host.join(".claude.json"), &account_dir);
	}
	// Après `sync_mcp_servers`, pour remplacer ce qu'il aurait recopié de
	// cassé : une déclaration authentifiée par OAuth côté hôte, qui ne le
	// sera jamais côté conteneur. Better Stack vérifié bout en bout comme
	// Linear et Stripe ; un jeton vide (`provision_mcp_tokens` le filtre) ne
	// fait rien de plus que ne pas déclarer le serveur.
	//
	// Sentry en est volontairement absent : un jeton d'API REST s'est vu
	// opposer un 401 par `mcp.sentry.dev` — vérifié avec un vrai jeton, pas un
	// jeton vide. Ce serveur exige un type de jeton que Cockpit ne détient pas ;
	// un agent isolé s'en passe.
	let jetons = crate::config::Config::active();
	provision_mcp_tokens(
		&account_dir,
		&[
			("linear", "https://mcp.linear.app/mcp", &jetons.linear.token),
			("stripe", "https://mcp.stripe.com", &jetons.stripe.token),
			("betterstack", "https://mcp.betterstack.com", &jetons.betterstack.token),
		],
	);
	cmd.arg("--volume").arg(volume(&account_dir, false));
	cmd.arg("-e").arg(format!(
		"CLAUDE_CONFIG_DIR={}",
		container_path(&account_dir.to_string_lossy())
	));

	// `claude setup-token` n'écrit son jeton dans aucun fichier — vérifié
	// empiriquement, ce n'était pas ce qu'on supposait au premier essai : il
	// l'affiche une fois et laisse le poser en variable d'environnement à
	// qui l'a lancé. C'est donc par ici, jamais par `CLAUDE_CONFIG_DIR` seul,
	// qu'un agent isolé s'authentifie réellement.
	let token = sandbox.oauth_token.trim();
	if !token.is_empty() {
		cmd.arg("-e")
			.arg("CLAUDE_CODE_OAUTH_TOKEN")
			.env("CLAUDE_CODE_OAUTH_TOKEN", token);
	}

	// De quoi parler à GitHub. Sur le poste, un agent s'en sort parce que `gh`
	// y est installé et authentifié ; dans un conteneur il n'y a ni l'un ni
	// l'autre, et l'agent le dit lui-même : « no gh CLI, no GITHUB_TOKEN, and no
	// git credentials for origin — I can't push the branch or open the PR from
	// here ». Il préparait alors le travail pour qu'on le colle à sa place.
	//
	// Les deux noms : `gh` lit `GH_TOKEN` en premier, la plupart des outils et
	// des actions lisent `GITHUB_TOKEN`. En poser un seul laisse l'autre moitié
	// sans rien.
	if !github_token.trim().is_empty() {
		let token = github_token.trim();
		cmd.arg("-e").arg("GH_TOKEN").env("GH_TOKEN", token);
		cmd.arg("-e").arg("GITHUB_TOKEN").env("GITHUB_TOKEN", token);
	}

	cmd.arg(image).arg("zsh").arg("-lc").arg(shell_command);
	cmd
}

/// Ce que les ponts MCP d'un agent isolé lisent à la racine de `config_dir()` :
/// leurs scripts (`mcp-*.mjs`) et les configurations passées par
/// `--mcp-config` (`mcp-*.json`). Celle des outils du dépôt ne vaut que pour
/// son dossier ; celles du navigateur ne servent jamais en conteneur. Rien
/// d'autre — surtout pas `config.toml`.
fn bridge_files(root: &std::path::Path, cwd: &str) -> Vec<std::path::PathBuf> {
	let projet = format!("mcp-projet-{}.json", crate::mcp::key_of(cwd));
	let Ok(entries) = std::fs::read_dir(root) else {
		return Vec::new();
	};
	let mut files: Vec<std::path::PathBuf> = entries
		.filter_map(|entry| entry.ok())
		.filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
		.filter(|entry| {
			let name = entry.file_name().to_string_lossy().to_string();
			if !name.starts_with("mcp-") || name.starts_with("mcp-navigateur-") {
				return false;
			}
			if name.starts_with("mcp-projet-") {
				return name == projet;
			}
			name.ends_with(".json") || name.ends_with(".mjs")
		})
		.map(|entry| entry.path())
		.collect();
	files.sort();
	files
}

/// La commande à taper dans un vrai terminal pour connecter le compte des
/// agents isolés — une seule fois, le jeton (1 an) survit ensuite dans
/// `sandbox_account_dir`, monté à chaque lancement.
///
/// Tourne directement sur le poste, jamais dans un conteneur : le jeton n'a
/// besoin de rien de plus qu'un `claude` et un `CLAUDE_CONFIG_DIR` qui pointe
/// au bon endroit, et coller un code d'autorisation à travers un `docker run
/// -it` imbriqué dans le terminal du cockpit — un PTY dans un PTY — s'est
/// avéré peu fiable. Une seule couche de terminal, le même geste qu'un
/// `claude setup-token` tapé à la main.
pub fn login_command() -> Result<String, String> {
	let claude = crate::agent::claude_binary().ok_or_else(|| crate::i18n::t("sandbox.claudeNotFound"))?;
	let account_dir = sandbox_account_dir();
	std::fs::create_dir_all(&account_dir).map_err(|error| error.to_string())?;

	Ok(format!(
		"CLAUDE_CONFIG_DIR={dir} {claude} setup-token",
		dir = crate::agent::shell_quote(&account_dir.to_string_lossy()),
		claude = crate::agent::shell_quote(&claude),
	))
}

/// Tue le conteneur d'une session, s'il en avait un — appelé en plus du
/// client (`child.start_kill()`), jamais à sa place. Best-effort : un
/// conteneur déjà mort (agent qui s'est arrêté de lui-même) fait échouer la
/// commande sans que ce soit une erreur pour qui appelle.
///
/// Fire-and-forget : correct tant que le cockpit continue de tourner après
/// coup. À la fermeture de l'app, rien ne garantit que la tâche ait le temps
/// de s'exécuter avant que le process ne meure — voir `kill_blocking`.
pub fn kill(runtime: &str, session_id: &str) {
	let runtime = runtime.to_string();
	let name = container_name(session_id);
	tauri::async_runtime::spawn(async move {
		let _ = runtime_command(&runtime).arg("kill").arg(&name).output().await;
	});
}

/// Même geste, mais attendu avant de rendre la main — pour le seul moment où
/// « après coup » n'existe pas : `agent::stop_all` à la fermeture du cockpit.
/// Un conteneur oublié là survivrait indéfiniment, invisible, exactement le
/// genre de fuite que ce module existe pour éviter.
pub fn kill_blocking(runtime: &str, session_id: &str) {
	let name = container_name(session_id);
	let mut command = std::process::Command::new(runtime);
	command.arg("kill").arg(&name);
	let _ = crate::platform::quiet_std(&mut command).output();
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn provisionne_un_jeton_et_ignore_les_vides() {
		let dir = std::env::temp_dir().join(format!("cockpit-sandbox-mcp-tokens-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();

		provision_mcp_tokens(
			&dir,
			&[
				("linear", "https://mcp.linear.app/mcp", "lin_api_test"),
				("stripe", "https://mcp.stripe.com", ""),
			],
		);

		let saved: serde_json::Value =
			serde_json::from_str(&std::fs::read_to_string(dir.join(".claude.json")).unwrap()).unwrap();
		assert_eq!(
			saved["mcpServers"]["linear"]["headers"]["Authorization"],
			"Bearer lin_api_test"
		);
		assert_eq!(saved["mcpServers"]["linear"]["type"], "http");
		assert!(saved["mcpServers"].get("stripe").is_none());

		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Un vrai dépôt et un vrai `git worktree add`, pas une supposition sur la
	/// forme du fichier `.git` : c'est justement une supposition fausse sur ce
	/// fichier — jamais monté dans le conteneur — qui a fait perdre du temps
	/// avant ce test.
	#[test]
	fn retrouve_le_depot_d_origine_d_un_vrai_worktree() {
		let base = std::env::temp_dir().join(format!("cockpit-sandbox-origin-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&base);
		let depot = base.join("depot");
		std::fs::create_dir_all(&depot).unwrap();

		let git = |args: &[&str], cwd: &std::path::Path| {
			let status = std::process::Command::new("git")
				.args(args)
				.current_dir(cwd)
				.status()
				.unwrap();
			assert!(status.success(), "git {args:?} a échoué");
		};
		git(&["init", "-q"], &depot);
		git(&["config", "user.email", "test@test.com"], &depot);
		git(&["config", "user.name", "Test"], &depot);
		std::fs::write(depot.join("fichier.txt"), "contenu").unwrap();
		git(&["add", "-A"], &depot);
		git(&["commit", "-q", "-m", "initial"], &depot);

		let worktree = base.join("worktree");
		git(
			&["worktree", "add", "-q", "-b", "une-branche", worktree.to_str().unwrap()],
			&depot,
		);

		let retrouve = worktree_origin(worktree.to_str().unwrap()).unwrap();
		assert_eq!(retrouve.canonicalize().unwrap(), depot.canonicalize().unwrap());

		let _ = std::fs::remove_dir_all(&base);
	}

	/// Un dossier ordinaire — pas de fichier `.git`, ou un vrai dépôt et non
	/// un worktree — ne doit rien faire deviner : `None` plutôt qu'un chemin
	/// halluciné.
	#[test]
	fn un_depot_ordinaire_n_est_pas_un_worktree() {
		let dir = std::env::temp_dir().join(format!("cockpit-sandbox-non-worktree-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let status = std::process::Command::new("git")
			.args(["init", "-q"])
			.current_dir(&dir)
			.status()
			.unwrap();
		assert!(status.success());

		assert!(worktree_origin(dir.to_str().unwrap()).is_none());

		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Un vrai fichier temporaire, pas une supposition sur la forme du JSON :
	/// c'est justement une hypothèse fausse sur ce fichier qui a fait perdre
	/// du temps plus tôt dans ce module.
	#[test]
	fn approuver_un_worktree_survit_a_un_fichier_deja_peuple() {
		let dir = std::env::temp_dir().join(format!("cockpit-sandbox-trust-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		std::fs::write(
			dir.join(".claude.json"),
			r#"{"machineID":"abc","projects":{"/autre/chemin":{"hasTrustDialogAccepted":true}}}"#,
		)
		.unwrap();

		trust_worktree(&dir, "/repos/mission-1");

		let saved: serde_json::Value =
			serde_json::from_str(&std::fs::read_to_string(dir.join(".claude.json")).unwrap()).unwrap();
		assert_eq!(saved["machineID"], "abc");
		assert_eq!(saved["projects"]["/autre/chemin"]["hasTrustDialogAccepted"], true);
		assert_eq!(saved["projects"]["/repos/mission-1"]["hasTrustDialogAccepted"], true);

		let _ = std::fs::remove_dir_all(&dir);
	}

	/// Découpée par un vrai shell plutôt que supposée bien formée : la
	/// commande part directement dans un terminal, jamais relue par le
	/// cockpit — une virgule de travers s'y verrait au premier essai de
	/// l'utilisateur, pas avant.
	#[test]
	fn la_commande_de_connexion_est_un_shell_valide() {
		// Ce test suppose `claude` installé sur le poste qui l'exécute — c'est
		// le cas de ce dépôt, mais pas une garantie universelle : on passe
		// plutôt que d'échouer ailleurs.
		if crate::agent::claude_binary().is_none() {
			return;
		}
		let command = login_command().expect("claude doit être trouvé en test");

		let script = format!("set -- {command}; for a; do printf '%s\\n' \"$a\"; done");
		let output = crate::platform::shell(&script)
			.output()
			.expect("le shell doit pouvoir découper la commande");
		assert!(output.status.success());
		let args: Vec<String> = String::from_utf8_lossy(&output.stdout)
			.lines()
			.map(str::to_string)
			.collect();

		assert!(args[0].starts_with("CLAUDE_CONFIG_DIR="));
		assert!(args[0].contains("sandbox-account"));
		assert!(args.last().is_some_and(|a| a == "setup-token"));
	}

	/// Un agent isolé ne voit, de la configuration du cockpit, que ses ponts :
	/// jamais `config.toml`, ni ses sauvegardes, ni les outils d'un autre dépôt.
	#[test]
	fn seuls_les_ponts_sont_montes() {
		let root = std::env::temp_dir().join(format!("cockpit-sandbox-ponts-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		std::fs::create_dir_all(root.join("permissions")).unwrap();
		let ici = format!("mcp-projet-{}.json", crate::mcp::key_of("/repos/a"));
		for name in [
			"config.toml",
			"config.toml.avant-migration",
			"journal.jsonl",
			"mcp-permission.json",
			"mcp-permission.mjs",
			"mcp-navigateur-abc.json",
			"mcp-projet-autre.json",
			ici.as_str(),
		] {
			std::fs::write(root.join(name), "{}").unwrap();
		}
		let names: Vec<String> = bridge_files(&root, "/repos/a")
			.iter()
			.map(|path| path.file_name().unwrap().to_string_lossy().to_string())
			.collect();
		assert_eq!(names.len(), 3, "{names:?}");
		assert!(names.contains(&"mcp-permission.json".to_string()));
		assert!(names.contains(&"mcp-permission.mjs".to_string()));
		assert!(names.contains(&ici));
		let _ = std::fs::remove_dir_all(&root);
	}

	#[test]
	fn un_chemin_de_l_hote_se_retrouve_dans_le_conteneur() {
		if cfg!(windows) {
			assert_eq!(container_path("C:\\Users\\ana\\wt"), "/c/Users/ana/wt");
			assert_eq!(container_path("D:/repos/x/"), "/d/repos/x");
			assert_eq!(
				volume(std::path::Path::new("C:\\Users\\ana\\.ssh"), true),
				"C:/Users/ana/.ssh:/c/Users/ana/.ssh:ro"
			);
		} else {
			assert_eq!(container_path("/Users/ana/wt"), "/Users/ana/wt");
			assert_eq!(
				volume(std::path::Path::new("/Users/ana/.ssh"), true),
				"/Users/ana/.ssh:/Users/ana/.ssh:ro"
			);
		}
	}

	#[test]
	fn un_runtime_n_est_qu_un_nom_de_programme() {
		assert!(which("docker; rm -rf ~").is_none());
		assert!(which("$(curl x)").is_none());
		assert!(which("").is_none());
	}

	#[test]
	fn le_nom_de_conteneur_est_stable() {
		assert_eq!(container_name("agent-abc"), "cockpit-agent-agent-abc");
	}

	#[test]
	fn une_image_vide_retombe_sur_le_defaut() {
		let sandbox = SandboxConfig::default();
		let cmd = build(&sandbox, "docker", "s1", "/tmp/wt", &[], "echo hi", "");
		let program = format!("{:?}", cmd);
		assert!(program.contains(DEFAULT_IMAGE));
	}

	#[test]
	fn sans_jeton_de_forge_rien_n_est_pose() {
		// Un agent qui n'a pas de jeton ne doit pas hériter d'un assistant
		// d'identifiants qui rendrait une chaîne vide : il échouerait plus loin,
		// et plus obscurément, qu'en n'ayant rien du tout.
		let sandbox = SandboxConfig::default();
		let cmd = format!("{:?}", build(&sandbox, "docker", "s1", "/tmp/wt", &[], "echo hi", ""));
		assert!(!cmd.contains("GH_TOKEN"));
		assert!(!cmd.contains("credential.https://github.com.helper"));
		assert!(cmd.contains("GIT_CONFIG_COUNT=1"));
	}

	#[test]
	fn avec_un_jeton_l_agent_peut_lire_une_pr_et_pousser() {
		// Les deux noms de variable : `gh` lit `GH_TOKEN`, la plupart des outils
		// lisent `GITHUB_TOKEN`. Et l'assistant d'identifiants, sans lequel le
		// dépôt cloné en HTTPS refuse la poussée.
		let sandbox = SandboxConfig::default();
		let cmd = format!(
			"{:?}",
			build(&sandbox, "docker", "s1", "/tmp/wt", &[], "echo hi", "ghp_secret")
		);
		let built = build(&sandbox, "docker", "s1", "/tmp/wt", &[], "echo hi", "ghp_secret");
		let args: Vec<String> = built
			.as_std()
			.get_args()
			.map(|arg| arg.to_string_lossy().to_string())
			.collect();
		// Le jeton passe par l'environnement du client, jamais par ses
		// arguments : ceux-ci se lisent dans `ps`.
		assert!(args.iter().any(|arg| arg == "GH_TOKEN"));
		assert!(args.iter().any(|arg| arg == "GITHUB_TOKEN"));
		assert!(!args.iter().any(|arg| arg.contains("ghp_secret")));
		let envs: Vec<(String, String)> = built
			.as_std()
			.get_envs()
			.filter_map(|(name, value)| {
				Some((name.to_string_lossy().to_string(), value?.to_string_lossy().to_string()))
			})
			.collect();
		assert!(envs.contains(&("GH_TOKEN".into(), "ghp_secret".into())));
		assert!(envs.contains(&("GITHUB_TOKEN".into(), "ghp_secret".into())));
		assert!(cmd.contains("credential.https://github.com.helper"));
		assert!(cmd.contains("GIT_CONFIG_COUNT=2"));
		// Le jeton ne s'écrit jamais dans la valeur du réglage : l'assistant le
		// lit dans l'environnement au moment où git le lui demande.
		assert!(!cmd.contains("password=ghp_secret"));
	}

	#[test]
	fn l_empreinte_suit_le_dockerfile() {
		// Deux appels donnent la même : c'est ce qui permet de comparer une
		// image installée à ce que cette version sait écrire.
		assert_eq!(dockerfile_stamp(), dockerfile_stamp());
		assert!(!dockerfile_stamp().is_empty());
	}

	/// Reconstruction réelle, contre un vrai `docker` : simuler l'absence
	/// d'image reviendrait à tester notre hypothèse sur son comportement, pas
	/// le comportement. Passe si aucun runtime n'est installé — ce n'est pas
	/// ce test qui doit exiger Docker sur le poste qui l'exécute.
	///
	/// **Ne touche jamais à l'image de production.** La première version
	/// supprimait `cockpit-agent:latest` pour vérifier qu'elle se reconstruit :
	/// lancée sur un poste au travail, elle emportait l'image dont les agents
	/// se servent, et le lancement suivant attendait plusieurs minutes de
	/// reconstruction. Elle n'a survécu que parce que Docker refuse de
	/// supprimer une image qu'un conteneur utilise — un hasard, pas une
	/// garantie. On travaille donc sur un nom à nous.
	#[tokio::test]
	async fn une_image_absente_est_reconstruite() {
		let Some(runtime) = resolve_runtime("") else {
			return;
		};
		// L'image des agents est une image Linux : un moteur qui ne fait tourner
		// que des conteneurs Windows (Docker des machines Windows de GitHub, ou
		// Docker Desktop basculé en mode Windows) ne peut pas la construire.
		let os_type = runtime_command(&runtime)
			.args(["info", "--format", "{{.OSType}}"])
			.output()
			.await
			.map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
			.unwrap_or_default();
		if os_type != "linux" {
			return;
		}

		let jetable = format!("cockpit-agent-test-{}:latest", std::process::id());
		let _ = runtime_command(&runtime).arg("rmi").arg(&jetable).output().await;
		assert!(!image_exists(&runtime, &jetable).await);

		let sandbox = SandboxConfig {
			image: jetable.clone(),
			..SandboxConfig::default()
		};
		// Une image déclarée et absente n'est pas construite par le cockpit :
		// elle ne lui appartient pas, et il le dit plutôt que de la fabriquer.
		assert!(ensure_image(&runtime, &sandbox).await.is_err());

		// La nôtre, elle, se construit — sous son vrai nom, qui existe déjà
		// ici : c'est l'empreinte qui décide, et non plus sa seule présence.
		let sandbox = SandboxConfig::default();
		ensure_image(&runtime, &sandbox)
			.await
			.expect("la reconstruction doit réussir");

		assert!(image_exists(&runtime, DEFAULT_IMAGE).await);
	}
}
