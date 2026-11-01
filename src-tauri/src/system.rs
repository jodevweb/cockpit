//! Ponts avec le poste de travail : éditeur, terminal, Finder, ports, Docker.

use crate::error::{CockpitError, Result};
use crate::runner::capture;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

fn escape_applescript(input: &str) -> String {
	input.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Ouvre un dossier dans l'éditeur configuré. On tente d'abord le binaire CLI
/// (`zed`, `cursor`, `code`) puis on retombe sur `open -a`, car le CLI n'est pas
/// toujours installé dans le PATH.
pub async fn open_in_editor(editor: &str, path: &str) -> Result<()> {
	let target = Path::new(path);
	if !target.exists() {
		return Err(CockpitError::msg(format!("Chemin introuvable : {path}")));
	}
	// Aucun éditeur supposé : en lancer un que la personne n'utilise pas — ou
	// n'a pas installé — échoue plus loin, avec un message qui parle d'un outil
	// qu'elle n'a jamais demandé.
	let editor = editor.trim();
	if editor.is_empty() {
		return Err(CockpitError::msg(
			"Aucun éditeur configuré : renseigne-le dans Réglages → Poste de travail.",
		));
	}

	let app_name = match editor {
		"cursor" => "Cursor",
		"code" => "Visual Studio Code",
		"zed" => "Zed",
		other => other,
	};

	let cli = std::process::Command::new("zsh")
		.arg("-lc")
		.arg(format!("command -v {editor}"))
		.output();
	let has_cli = cli.map(|o| o.status.success()).unwrap_or(false);

	// Le chemin entre apostrophes, jamais entre guillemets : il vient souvent
	// d'une sortie d'agent ou d'un dépôt cloné, et `"$(…)"` reste évalué par le
	// shell — un fichier nommé `$(curl …|sh).md` s'exécutait à l'ouverture.
	let command = if has_cli {
		format!("{editor} {}", shell_quote(path))
	} else {
		format!("open -a {} {}", shell_quote(app_name), shell_quote(path))
	};

	capture("/", &command).await.map(|_| ())
}

/// Ouvre Terminal.app sur un dossier, en exécutant éventuellement une commande.
/// AppleScript plutôt que `open` : c'est le seul moyen de pré-remplir la ligne
/// de commande dans la nouvelle fenêtre.
pub async fn open_terminal(cwd: &str, command: Option<String>) -> Result<()> {
	let script_line = match command {
		Some(cmd) if !cmd.trim().is_empty() => format!("cd {} && {}", shell_quote(cwd), cmd),
		_ => format!("cd {}", shell_quote(cwd)),
	};
	let applescript = format!(
		r#"tell application "Terminal"
	activate
	do script "{}"
end tell"#,
		escape_applescript(&script_line)
	);

	let status = std::process::Command::new("osascript")
		.arg("-e")
		.arg(applescript)
		.status()
		.map_err(|e| CockpitError::msg(format!("osascript : {e}")))?;

	if !status.success() {
		return Err(CockpitError::msg("Terminal.app n'a pas pu être piloté."));
	}
	Ok(())
}

/// Lance un agent Claude Code sur un dossier avec un prompt pré-rempli.
///
/// Terminal.app plutôt qu'un job du cockpit : un agent est interactif (il pose
/// des questions, demande des validations), et le runner du cockpit exécute sans
/// TTY. Le prompt part en argument correctement échappé — il contient des
/// apostrophes et des barres obliques.
pub async fn launch_agent(cwd: &str, prompt: &str) -> Result<()> {
	if prompt.trim().is_empty() {
		return Err(CockpitError::msg("Ce prompt est vide."));
	}
	let command = format!("claude {}", shell_quote(prompt.trim()));
	open_terminal(cwd, Some(command)).await
}

fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// Ouvre une URL dans le navigateur par défaut.
///
/// On passe par `/usr/bin/open` plutôt que par le plugin `opener` : celui-ci
/// démarre le navigateur comme processus enfant du cockpit, dont il hérite le
/// contexte d'exécution — un Chrome lancé ainsi arrive dans un état inutilisable
/// (fenêtre absente, application impossible à quitter). `open` confie l'URL à
/// LaunchServices, qui en fait une application indépendante, exactement comme un
/// double-clic.
pub async fn open_external(url: &str) -> Result<()> {
	// Un `-` initial serait pris pour une option d'`open`.
	if !url.starts_with("http://") && !url.starts_with("https://") {
		return Err(CockpitError::msg(format!("Lien non ouvrable : {url}")));
	}

	let status = tokio::process::Command::new("/usr/bin/open")
		.arg(url)
		.status()
		.await
		.map_err(|e| CockpitError::msg(format!("open : {e}")))?;

	if !status.success() {
		return Err(CockpitError::msg(format!("Le lien n'a pas pu être ouvert : {url}")));
	}
	Ok(())
}

/// Ouvre un fichier avec l'application que macOS lui associe.
///
/// Pour ce que la visionneuse ne sait pas montrer — un document Word, une
/// présentation Keynote, une vidéo dans un format que le webview ne lit pas.
/// Chemin absolu exigé : un `-` initial serait pris pour une option d'`open`.
pub async fn open_file(path: &str) -> Result<()> {
	if !path.starts_with('/') {
		return Err(CockpitError::msg(format!("Chemin non ouvrable : {path}")));
	}
	if !std::path::Path::new(path).exists() {
		return Err(CockpitError::msg(format!("Fichier introuvable : {path}")));
	}
	let status = tokio::process::Command::new("/usr/bin/open")
		.arg(path)
		.status()
		.await
		.map_err(|e| CockpitError::msg(format!("open : {e}")))?;
	if !status.success() {
		return Err(CockpitError::msg(format!(
			"Aucune application ne sait ouvrir ce fichier : {path}"
		)));
	}
	Ok(())
}

pub async fn reveal_in_finder(path: &str) -> Result<()> {
	// Un `-` initial serait pris pour une option d'`open` — le chemin vient
	// parfois d'une sortie d'agent.
	if path.trim_start().starts_with('-') {
		return Err(CockpitError::msg(format!("Chemin non révélable : {path}")));
	}
	std::process::Command::new("open")
		.args(["-R", path])
		.status()
		.map_err(|e| CockpitError::msg(format!("open -R : {e}")))?;
	Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageScript {
	pub name: String,
	pub command: String,
	pub group: String,
	/// De quoi le lancer : `pnpm`, `npm run`, `bun run`…
	///
	/// Déduit du dépôt et non supposé : l'écran écrivait `pnpm <script>` en dur,
	/// ce qui ne marche que chez qui l'a installé.
	pub runner: String,
}

/// Scripts du `package.json`, regroupés par préfixe (`dev:`, `db:`, `test:`…)
/// pour que l'UI puisse les classer sans configuration.
pub fn package_scripts(repo: &Path) -> Result<Vec<PackageScript>> {
	let raw = std::fs::read_to_string(repo.join("package.json"))
		.map_err(|_| CockpitError::msg("package.json introuvable dans ce dépôt."))?;
	let parsed: Value = serde_json::from_str(&raw)
		.map_err(|e| CockpitError::msg(format!("package.json illisible : {e}")))?;

	let Some(scripts) = parsed.get("scripts").and_then(|v| v.as_object()) else {
		return Ok(Vec::new());
	};

	let mut list: Vec<PackageScript> = scripts
		.iter()
		.map(|(name, command)| {
			let group = name
				.split_once(':')
				.map(|(prefix, _)| prefix.to_string())
				.unwrap_or_else(|| "général".into());
			PackageScript {
				name: name.clone(),
				command: command.as_str().unwrap_or_default().to_string(),
				group,
				runner: crate::commands::script_runner(repo).to_string(),
			}
		})
		.collect();

	list.sort_by(|a, b| a.group.cmp(&b.group).then(a.name.cmp(&b.name)));
	Ok(list)
}

// Les slash-commands se lisent désormais dans `slash.rs` : elles ne vivent pas
// que dans le dépôt (le dossier personnel et les plugins en fournissent aussi),
// leurs sous-dossiers comptent dans leur nom, et leur en-tête déclare parfois
// les arguments attendus. La version qui vivait ici n'en voyait rien.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
	pub id: String,
	pub name: String,
	pub image: String,
	pub state: String,
	pub status: String,
	pub ports: String,
}

/// Docker est-il installé sur ce poste ?
///
/// La présence du binaire, pas l'état du daemon : le second se voit en une
/// seconde à l'écran — « Docker ne répond pas » — là où le premier décide si
/// l'écran a lieu d'être. Mémoïsé : on n'installe pas Docker en cours de session,
/// et cette question se pose à chaque rendu du menu.
pub fn has_docker() -> bool {
	static FOUND: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
	*FOUND.get_or_init(|| {
		if let Ok(output) = std::process::Command::new("zsh")
			.arg("-lc")
			.arg("command -v docker")
			.output()
		{
			let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
			if !path.is_empty() && std::path::Path::new(&path).exists() {
				return true;
			}
		}
		["/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker"]
			.iter()
			.any(|path| std::path::Path::new(path).exists())
	})
}

pub async fn docker_containers() -> Result<Vec<Container>> {
	let raw = capture("/", "docker ps -a --format '{{json .}}'")
		.await
		.map_err(|_| CockpitError::msg("Docker ne répond pas — le daemon est-il lancé ?"))?;

	let mut containers = Vec::new();
	for line in raw.lines().filter(|l| !l.trim().is_empty()) {
		let Ok(value) = serde_json::from_str::<Value>(line) else {
			continue;
		};
		let get = |key: &str| {
			value
				.get(key)
				.and_then(|v| v.as_str())
				.unwrap_or_default()
				.to_string()
		};
		containers.push(Container {
			id: get("ID"),
			name: get("Names"),
			image: get("Image"),
			state: get("State"),
			status: get("Status"),
			ports: get("Ports"),
		});
	}

	containers.sort_by(|a, b| a.name.cmp(&b.name));
	Ok(containers)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
	pub port: u16,
	pub process: String,
	pub pid: u32,
	/// Dossier de travail du processus, quand le système veut bien le dire.
	///
	/// C'est lui qui rattache un serveur au worktree qui l'a lancé : sans ce
	/// chemin, la liste des ports dit qu'il *y a* quelque chose sur 3000, mais
	/// pas de quel chantier il s'agit ni s'il est encore utile.
	pub cwd: String,
	/// Mémoire retenue par le processus et toute sa descendance, en Mo.
	///
	/// Un serveur de développement seul pèse peu ; c'est l'arbre qu'il traîne
	/// qui coûte — `pnpm` lance `turbo` qui lance des `next-server`, et ce sont
	/// eux qui tiennent les gigaoctets. Sans ce chiffre, huit serveurs oubliés
	/// dans des workspaces refermés passaient pour une fuite du cockpit.
	pub memory_mb: f64,
}

/// Ports TCP en écoute, via `lsof`. Sert à repérer d'un coup d'œil quel
/// worktree a un serveur dev encore vivant.
pub async fn listening_ports() -> Result<Vec<ListeningPort>> {
	let raw = capture("/", "lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null || true").await?;

	let mut ports: Vec<ListeningPort> = Vec::new();
	let mut pid: u32 = 0;
	let mut process = String::new();

	for line in raw.lines() {
		let (tag, value) = line.split_at(1);
		match tag {
			"p" => pid = value.parse().unwrap_or(0),
			"c" => process = value.to_string(),
			"n" => {
				let Some(port) = value.rsplit(':').next().and_then(|p| p.parse::<u16>().ok())
				else {
					continue;
				};
				if ports.iter().any(|p| p.port == port && p.pid == pid) {
					continue;
				}
				ports.push(ListeningPort {
					port,
					process: process.clone(),
					pid,
					cwd: String::new(),
					memory_mb: 0.0,
				});
			}
			_ => {}
		}
	}

	// Le dossier de chaque processus, en un seul appel : `lsof` accepte une
	// liste de pid, et en interroger cinquante un par un coûterait une seconde.
	if !ports.is_empty() {
		let pids = ports
			.iter()
			.map(|entry| entry.pid.to_string())
			.collect::<Vec<_>>()
			.join(",");
		if let Ok(raw) = capture(
			"/",
			&format!("lsof -a -d cwd -p {pids} -Fpn 2>/dev/null || true"),
		)
		.await
		{
			let mut pid: u32 = 0;
			for line in raw.lines() {
				let (tag, value) = line.split_at(1);
				match tag {
					"p" => pid = value.parse().unwrap_or(0),
					"n" => {
						for entry in ports.iter_mut().filter(|entry| entry.pid == pid) {
							entry.cwd = value.to_string();
						}
					}
					_ => {}
				}
			}
		}
	}

	// Ce que chaque serveur pèse, sa descendance comprise. Un seul relevé de
	// tous les processus vivants, puis on remonte les arbres : interroger le
	// système par processus coûterait une seconde sur un poste chargé.
	if !ports.is_empty() {
		if let Ok(raw) = capture("/", "ps -axo pid=,ppid=,rss= 2>/dev/null || true").await {
			let mut poids: std::collections::HashMap<u32, u64> = std::collections::HashMap::new();
			let mut enfants: std::collections::HashMap<u32, Vec<u32>> =
				std::collections::HashMap::new();
			for ligne in raw.lines() {
				let mut champs = ligne.split_whitespace();
				let (Some(pid), Some(ppid), Some(rss)) = (champs.next(), champs.next(), champs.next())
				else {
					continue;
				};
				let (Ok(pid), Ok(ppid), Ok(rss)) =
					(pid.parse::<u32>(), ppid.parse::<u32>(), rss.parse::<u64>())
				else {
					continue;
				};
				poids.insert(pid, rss);
				enfants.entry(ppid).or_default().push(pid);
			}
			for entry in ports.iter_mut() {
				let mut total = 0u64;
				let mut pile = vec![entry.pid];
				let mut vus = std::collections::HashSet::new();
				while let Some(pid) = pile.pop() {
					if !vus.insert(pid) {
						continue;
					}
					total += poids.get(&pid).copied().unwrap_or(0);
					if let Some(suite) = enfants.get(&pid) {
						pile.extend(suite.iter().copied());
					}
				}
				entry.memory_mb = total as f64 / 1024.0;
			}
		}
	}

	ports.sort_by_key(|p| p.port);
	Ok(ports)
}

/// Arrête un processus par son pid, poliment puis fermement.
///
/// `SIGTERM` laisse un serveur de développement fermer ses sockets et ses
/// processus enfants ; on ne passe à `SIGKILL` que s'il est toujours là une
/// seconde plus tard. L'inverse — tuer d'emblée — laisse des ports occupés par
/// des enfants orphelins, ce qui est précisément le problème qu'on essaie de
/// régler.
pub async fn stop_process(pid: u32) -> Result<()> {
	if pid == 0 {
		return Err(CockpitError::msg("Processus inconnu."));
	}
	capture("/", &format!("kill -TERM {pid} 2>/dev/null || true")).await?;
	tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
	let still = capture("/", &format!("ps -p {pid} -o pid= 2>/dev/null || true")).await?;
	if !still.trim().is_empty() {
		capture("/", &format!("kill -KILL {pid} 2>/dev/null || true")).await?;
	}
	Ok(())
}
