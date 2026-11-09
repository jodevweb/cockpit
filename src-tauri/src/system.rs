//! Ponts avec le poste de travail : éditeur, terminal, Finder, ports, Docker.

use crate::error::{CockpitError, Result};
use crate::runner::capture;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// Ce qui ouvre un fichier ou une adresse avec l'application par défaut.
#[cfg(target_os = "macos")]
const OPENER: &str = "/usr/bin/open";
#[cfg(all(unix, not(target_os = "macos")))]
const OPENER: &str = "xdg-open";

#[cfg(target_os = "macos")]
fn escape_applescript(input: &str) -> String {
	input.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Ouvre un dossier dans l'éditeur configuré. On tente d'abord le binaire CLI
/// (`zed`, `cursor`, `code`) puis on retombe sur `open -a`, car le CLI n'est pas
/// toujours installé dans le PATH.
pub async fn open_in_editor(editor: &str, path: &str) -> Result<()> {
	let target = Path::new(path);
	if !target.exists() {
		return Err(CockpitError::msg(crate::i18n::tf("system.pathNotFound", &[("path", &path)])));
	}
	// Aucun éditeur supposé : en lancer un que la personne n'utilise pas — ou
	// n'a pas installé — échoue plus loin, avec un message qui parle d'un outil
	// qu'elle n'a jamais demandé.
	let editor = editor.trim();
	if editor.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("system.noEditor")));
	}

	#[cfg(windows)]
	{
		windows_editor::open(editor, path)
	}

	#[cfg(not(windows))]
	{
		let app_name = match editor {
			"cursor" => "Cursor",
			"code" => "Visual Studio Code",
			"zed" => "Zed",
			other => other,
		};

		let cli = crate::platform::shell(&format!("command -v {editor}")).output();
		let has_cli = cli.map(|o| o.status.success()).unwrap_or(false);

		// Le chemin entre apostrophes, jamais entre guillemets : il vient souvent
		// d'une sortie d'agent ou d'un dépôt cloné, et `"$(…)"` reste évalué par le
		// shell — un fichier nommé `$(curl …|sh).md` s'exécutait à l'ouverture.
		if has_cli {
			return capture("/", &format!("{editor} {}", shell_quote(path))).await.map(|_| ());
		}
		// Sans son outil en ligne de commande, l'éditeur s'ouvre par son nom
		// d'application sous macOS ; sous Linux, il n'y a pas d'équivalent à
		// `open -a` : l'application par défaut du fichier fera l'affaire.
		#[cfg(target_os = "macos")]
		{
			capture("/", &format!("open -a {} {}", shell_quote(app_name), shell_quote(path)))
				.await
				.map(|_| ())
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = app_name;
			let target = path.to_string();
			tokio::task::spawn_blocking(move || crate::platform::open(&target))
				.await
				.map_err(|e| CockpitError::msg(format!("xdg-open : {e}")))?
				.map_err(|e| CockpitError::msg(format!("xdg-open : {e}")))
		}
	}
}

/// L'éditeur sous Windows, sans shell : aucun `cmd /c` ne voit le chemin.
///
/// On cherche d'abord l'exécutable graphique (`Code.exe`, `Cursor.exe`,
/// `Zed.exe`) — lancé directement, avec le chemin en argument séparé —, puis le
/// lanceur en ligne de commande trouvé par `where`. Un `.cmd` n'est lancé
/// qu'en dernier recours : Rust l'échappe pour `cmd.exe` et refuse ce qu'il ne
/// sait pas échapper sans risque.
#[cfg(windows)]
mod windows_editor {
	use crate::error::{CockpitError, Result};
	use std::path::{Path, PathBuf};

	/// Les exécutables graphiques connus, aux emplacements d'installation usuels.
	fn known_locations(editor: &str) -> Vec<PathBuf> {
		let local = std::env::var("LOCALAPPDATA").map(PathBuf::from).ok();
		let program_files: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
			.iter()
			.filter_map(|name| std::env::var(name).ok().map(PathBuf::from))
			.collect();
		let mut found = Vec::new();
		let (folder, exe) = match editor {
			"code" => ("Microsoft VS Code", "Code.exe"),
			"cursor" => ("cursor", "Cursor.exe"),
			"zed" => ("Zed", "Zed.exe"),
			_ => return found,
		};
		if let Some(local) = &local {
			found.push(local.join("Programs").join(folder).join(exe));
		}
		for base in &program_files {
			found.push(base.join(folder).join(exe));
		}
		found
	}

	/// Ce que `where` trouve dans le PATH, exécutables d'abord.
	fn on_path(editor: &str) -> Vec<PathBuf> {
		let mut command = std::process::Command::new("where");
		command.arg(editor);
		let Ok(output) = crate::platform::quiet_std(&mut command).output() else {
			return Vec::new();
		};
		let mut found: Vec<PathBuf> = String::from_utf8_lossy(&output.stdout)
			.lines()
			.map(|line| PathBuf::from(line.trim()))
			.filter(|path| path.is_file())
			.filter(|path| {
				let ext = path
					.extension()
					.map(|e| e.to_string_lossy().to_lowercase())
					.unwrap_or_default();
				ext == "exe" || ext == "cmd" || ext == "bat"
			})
			.collect();
		found.sort_by_key(|path| {
			path.extension()
				.map(|e| e.to_string_lossy().to_lowercase() != "exe")
				.unwrap_or(true)
		});
		found
	}

	/// Le lanceur `bin\code.cmd` de VS Code ou Cursor a son exécutable
	/// graphique quelques dossiers plus haut : on le préfère au `.cmd`.
	fn gui_beside(launcher: &Path, editor: &str) -> Option<PathBuf> {
		let wanted = format!("{editor}.exe").to_lowercase();
		let mut dir = launcher.parent();
		for _ in 0..4 {
			let current = dir?;
			if let Ok(entries) = std::fs::read_dir(current) {
				for entry in entries.flatten() {
					if entry.file_name().to_string_lossy().to_lowercase() == wanted {
						return Some(entry.path());
					}
				}
			}
			dir = current.parent();
		}
		None
	}

	pub fn resolve(editor: &str) -> Option<PathBuf> {
		// Un nom d'éditeur, pas un chemin ni des options : `where` accepte des
		// motifs, et l'exécutable trouvé reçoit le chemin à ouvrir.
		if editor.starts_with('-') || editor.contains(['/', '\\', ':', '*', '?', '"']) {
			return None;
		}
		if let Some(found) = known_locations(editor).into_iter().find(|path| path.is_file()) {
			return Some(found);
		}
		let listed = on_path(editor);
		for path in &listed {
			let is_exe = path
				.extension()
				.is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("exe"));
			if is_exe {
				return Some(path.clone());
			}
			if let Some(gui) = gui_beside(path, editor) {
				return Some(gui);
			}
		}
		listed.into_iter().next()
	}

	pub fn open(editor: &str, path: &str) -> Result<()> {
		// Un `-` initial serait pris pour une option de l'éditeur.
		if path.trim_start().starts_with('-') {
			return Err(CockpitError::msg(crate::i18n::tf("system.pathNotOpenable", &[("path", &path)])));
		}
		let Some(program) = resolve(editor) else {
			return Err(CockpitError::msg(crate::i18n::tf("desktop.editorNotFound", &[("editor", &editor)])));
		};
		let mut command = std::process::Command::new(&program);
		command
			.arg(path)
			.stdin(std::process::Stdio::null())
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null());
		// Détaché : l'éditeur survit au cockpit, et on n'attend pas qu'il se ferme.
		crate::platform::detach_std(&mut command)
			.spawn()
			.map_err(|e| CockpitError::msg(format!("{} : {e}", program.display())))?;
		Ok(())
	}
}

/// Ouvre Terminal.app sur un dossier, en exécutant éventuellement une commande.
/// AppleScript plutôt que `open` : c'est le seul moyen de pré-remplir la ligne
/// de commande dans la nouvelle fenêtre.
///
/// Sous Windows : Windows Terminal s'il est là, sinon une console à part, avec
/// le bash de Git for Windows — voir `windows_terminal`.
pub async fn open_terminal(cwd: &str, command: Option<String>) -> Result<()> {
	let script_line = match command {
		Some(cmd) if !cmd.trim().is_empty() => format!("cd {} && {}", shell_quote(cwd), cmd),
		_ => format!("cd {}", shell_quote(cwd)),
	};

	#[cfg(windows)]
	{
		windows_terminal::open(&script_line)
	}

	#[cfg(all(unix, not(target_os = "macos")))]
	{
		linux_terminal::open(&script_line)
	}

	#[cfg(target_os = "macos")]
	{
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
			return Err(CockpitError::msg(crate::i18n::t("system.terminalFailed")));
		}
		Ok(())
	}
}

/// Un terminal sous Linux.
///
/// Il n'y a pas de terminal du système : on prend le premier installé, dans
/// l'ordre où un bureau le désigne d'ordinaire (`x-terminal-emulator` est le
/// choix de Debian et d'Ubuntu). Chacun reçoit la commande à sa façon — `--`
/// pour GNOME Terminal, `-e` pour la plupart, `-x` pour Xfce — et toujours en
/// arguments séparés, jamais en une chaîne que l'émulateur redécouperait. Le
/// shell reste ouvert une fois la commande finie, comme sous macOS.
#[cfg(all(unix, not(target_os = "macos")))]
mod linux_terminal {
	use crate::error::{CockpitError, Result};

	/// L'émulateur, et ce qui précède la commande à jouer.
	const TERMINALS: [(&str, &[&str]); 9] = [
		("x-terminal-emulator", &["-e"]),
		("gnome-terminal", &["--"]),
		("konsole", &["-e"]),
		("xfce4-terminal", &["-x"]),
		("kitty", &[]),
		("alacritty", &["-e"]),
		("wezterm", &["start", "--"]),
		("foot", &[]),
		("xterm", &["-e"]),
	];

	pub fn open(script_line: &str) -> Result<()> {
		let script = format!("{script_line}; exec bash -l");
		for (name, before) in TERMINALS {
			if crate::platform::locate(name).is_none() {
				continue;
			}
			let mut command = std::process::Command::new(name);
			command.args(before).args(["bash", "-lc", &script]);
			crate::platform::detach_std(&mut command);
			if command.spawn().is_ok() {
				return Ok(());
			}
		}
		Err(CockpitError::msg(crate::i18n::t("system.terminalFailed")))
	}
}

/// Un terminal sous Windows.
///
/// La ligne de commande ne passe **jamais** par les arguments de `wt.exe` ni
/// par `cmd /c` : `wt` découpe ses arguments sur `;` (un prompt qui en contient
/// un ouvrirait un onglet de plus, avec la commande de son choix), et `cmd`
/// interprète `&`, `|`, `^`, `%`. Elle est écrite dans un script temporaire,
/// que bash lit lui-même : seuls des chemins choisis par le cockpit passent en
/// argument.
#[cfg(windows)]
mod windows_terminal {
	use crate::error::{CockpitError, Result};
	use std::path::PathBuf;

	const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

	fn windows_terminal() -> Option<PathBuf> {
		if let Ok(local) = std::env::var("LOCALAPPDATA") {
			let alias = PathBuf::from(local).join("Microsoft").join("WindowsApps").join("wt.exe");
			if alias.exists() {
				return Some(alias);
			}
		}
		let mut command = std::process::Command::new("where");
		command.arg("wt");
		let output = crate::platform::quiet_std(&mut command).output().ok()?;
		String::from_utf8_lossy(&output.stdout)
			.lines()
			.map(|line| PathBuf::from(line.trim()))
			.find(|path| path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")))
	}

	/// Les scripts d'ouvertures précédentes : ils portent parfois un prompt, on
	/// ne les laisse pas traîner.
	fn sweep(dir: &std::path::Path) {
		let Ok(entries) = std::fs::read_dir(dir) else { return };
		let limit = std::time::Duration::from_secs(10 * 60);
		for entry in entries.flatten() {
			let name = entry.file_name().to_string_lossy().to_string();
			if !name.starts_with("cockpit-terminal-") || !name.ends_with(".sh") {
				continue;
			}
			let old = entry
				.metadata()
				.and_then(|meta| meta.modified())
				.ok()
				.and_then(|at| at.elapsed().ok())
				.is_some_and(|age| age > limit);
			if old {
				let _ = std::fs::remove_file(entry.path());
			}
		}
	}

	pub fn open(script_line: &str) -> Result<()> {
		let Some(bash) = crate::platform::git_bash() else {
			return Err(CockpitError::msg(crate::i18n::t("desktop.bashMissing")));
		};
		let dir = std::env::temp_dir();
		sweep(&dir);
		let stamp = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map(|d| d.as_nanos())
			.unwrap_or(0);
		let script = dir.join(format!("cockpit-terminal-{}-{stamp}.sh", std::process::id()));
		// La fenêtre reste ouverte une fois la commande finie, comme sous macOS :
		// un shell interactif prend la suite, dans le même dossier
		// (`CHERE_INVOKING` empêche le profil de Git Bash de repartir de `~`).
		let body = format!("export CHERE_INVOKING=1\n{script_line}\nexec \"$BASH\" --login -i\n");
		std::fs::write(&script, body)
			.map_err(|e| CockpitError::msg(format!("{} : {e}", script.display())))?;

		let bash_text = bash.to_string_lossy().to_string();
		let script_text = script.to_string_lossy().to_string();
		// Windows Terminal, si ses arguments ne contiennent rien qu'il découperait.
		if let Some(wt) = windows_terminal() {
			if !bash_text.contains(';') && !script_text.contains(';') {
				let mut command = std::process::Command::new(wt);
				command
					.arg("new-tab")
					.arg("--title")
					.arg("Cockpit")
					.arg(&bash)
					.arg("--login")
					.arg(&script);
				if crate::platform::quiet_std(&mut command).spawn().is_ok() {
					return Ok(());
				}
			}
		}

		// Sinon, une console à elle : l'équivalent de `start`, sans `cmd`.
		use std::os::windows::process::CommandExt;
		std::process::Command::new(&bash)
			.arg("--login")
			.arg(&script)
			.creation_flags(CREATE_NEW_CONSOLE)
			.spawn()
			.map_err(|_| CockpitError::msg(crate::i18n::t("desktop.terminalFailed")))?;
		Ok(())
	}
}

/// Lance un agent Claude Code sur un dossier avec un prompt pré-rempli.
///
/// Terminal.app plutôt qu'un job du cockpit : un agent est interactif (il pose
/// des questions, demande des validations), et le runner du cockpit exécute sans
/// TTY. Le prompt part en argument correctement échappé — il contient des
/// apostrophes et des barres obliques.
pub async fn launch_agent(cwd: &str, prompt: &str) -> Result<()> {
	if prompt.trim().is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("system.emptyPrompt")));
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
		return Err(CockpitError::msg(crate::i18n::tf("system.linkNotOpenable", &[("url", &url)])));
	}

	#[cfg(windows)]
	{
		// La couche plateforme confie l'URL au shell de Windows, sans `cmd` :
		// un `&` dans une URL n'y devient pas un second programme.
		let target = url.to_string();
		let opened = tokio::task::spawn_blocking(move || crate::platform::open(&target))
			.await
			.map_err(|e| CockpitError::msg(format!("open : {e}")))?;
		if opened.is_err() {
			return Err(CockpitError::msg(crate::i18n::tf("system.linkFailed", &[("url", &url)])));
		}
		Ok(())
	}

	#[cfg(not(windows))]
	{
		let status = tokio::process::Command::new(OPENER)
			.arg(url)
			.status()
			.await
			.map_err(|e| CockpitError::msg(format!("open : {e}")))?;

		if !status.success() {
			return Err(CockpitError::msg(crate::i18n::tf("system.linkFailed", &[("url", &url)])));
		}
		Ok(())
	}
}

/// Ouvre un fichier avec l'application que macOS lui associe.
///
/// Pour ce que la visionneuse ne sait pas montrer — un document Word, une
/// présentation Keynote, une vidéo dans un format que le webview ne lit pas.
/// Chemin absolu exigé : un `-` initial serait pris pour une option d'`open`.
pub async fn open_file(path: &str) -> Result<()> {
	if !is_absolute_path(path) {
		return Err(CockpitError::msg(crate::i18n::tf("system.pathNotOpenable", &[("path", &path)])));
	}
	if !std::path::Path::new(path).exists() {
		return Err(CockpitError::msg(crate::i18n::tf("system.fileNotFound", &[("path", &path)])));
	}
	#[cfg(windows)]
	{
		// Ouvrir un fichier, sous Windows, c'est l'exécuter quand c'est un
		// programme ou un script : un `.bat` sorti d'un agent partirait sans un
		// mot. La visionneuse montre des documents, pas des programmes.
		if runs_as_program(path) {
			return Err(CockpitError::msg(crate::i18n::tf("desktop.programRefused", &[("path", &path)])));
		}
		let target = path.to_string();
		let opened = tokio::task::spawn_blocking(move || crate::platform::open(&target))
			.await
			.map_err(|e| CockpitError::msg(format!("open : {e}")))?;
		if opened.is_err() {
			return Err(CockpitError::msg(crate::i18n::tf("system.noApp", &[("path", &path)])));
		}
		Ok(())
	}
	#[cfg(not(windows))]
	{
		let status = tokio::process::Command::new(OPENER)
			.arg(path)
			.status()
			.await
			.map_err(|e| CockpitError::msg(format!("open : {e}")))?;
		if !status.success() {
			return Err(CockpitError::msg(crate::i18n::tf("system.noApp", &[("path", &path)])));
	}
	Ok(())
	}
}

/// Un chemin absolu, au sens du système : `/…` sous macOS ; `C:\…`, `C:/…` ou
/// `\\serveur\…` sous Windows. Jamais un `-` initial, pris pour une option.
fn is_absolute_path(path: &str) -> bool {
	if cfg!(windows) {
		!path.starts_with('-') && Path::new(path).is_absolute()
	} else {
		path.starts_with('/')
	}
}

/// Ce que Windows exécuterait au lieu de l'ouvrir : les extensions de `PATHEXT`
/// et les autres porteurs de code que l'Explorateur lance d'un double-clic.
#[cfg_attr(not(windows), allow(dead_code))]
fn runs_as_program(path: &str) -> bool {
	let Some(ext) = Path::new(path).extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())) else {
		return false;
	};
	let declared = std::env::var("PATHEXT").unwrap_or_default().to_lowercase();
	let declared = declared.split(';').map(str::trim).filter(|e| !e.is_empty());
	const ALWAYS: [&str; 22] = [
		".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
		".msc", ".msi", ".msp", ".scr", ".pif", ".lnk", ".url", ".hta", ".cpl", ".reg",
	];
	ALWAYS.contains(&ext.as_str()) || declared.into_iter().any(|e| e == ext)
}

pub async fn reveal_in_finder(path: &str) -> Result<()> {
	// Un `-` initial serait pris pour une option d'`open` — le chemin vient
	// parfois d'une sortie d'agent.
	if path.trim_start().starts_with('-') {
		return Err(CockpitError::msg(crate::i18n::tf("system.pathNotRevealable", &[("path", &path)])));
	}
	#[cfg(windows)]
	{
		crate::platform::reveal(path).map_err(|e| CockpitError::msg(format!("explorer : {e}")))?;
	}
	#[cfg(not(windows))]
	{
		crate::platform::reveal(path).map_err(|e| CockpitError::msg(format!("reveal : {e}")))?;
	}
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
		.map_err(|_| CockpitError::msg(crate::i18n::t("system.packageJsonMissing")))?;
	let parsed: Value = serde_json::from_str(&raw)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("system.packageJsonUnreadable", &[("error", &e)])))?;

	let Some(scripts) = parsed.get("scripts").and_then(|v| v.as_object()) else {
		return Ok(Vec::new());
	};

	let mut list: Vec<PackageScript> = scripts
		.iter()
		.map(|(name, command)| {
			let group = name
				.split_once(':')
				.map(|(prefix, _)| prefix.to_string())
				.unwrap_or_else(|| crate::i18n::t("system.generalGroup"));
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
		#[cfg(windows)]
		{
			let mut command = std::process::Command::new("where");
			command.arg("docker");
			if let Ok(output) = crate::platform::quiet_std(&mut command).output() {
				if output.status.success()
					&& String::from_utf8_lossy(&output.stdout)
						.lines()
						.any(|line| std::path::Path::new(line.trim()).is_file())
				{
					return true;
				}
			}
			// Docker Desktop pose son CLI ici ; le PATH d'une app lancée avant
			// son installation ne le voit pas encore.
			["ProgramFiles", "ProgramW6432"]
				.iter()
				.filter_map(|name| std::env::var(name).ok())
				.any(|base| {
					std::path::Path::new(&base)
						.join("Docker")
						.join("Docker")
						.join("resources")
						.join("bin")
						.join("docker.exe")
						.is_file()
				})
		}
		#[cfg(not(windows))]
		{
			if let Ok(output) = crate::platform::shell("command -v docker").output() {
				let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
				if !path.is_empty() && std::path::Path::new(&path).exists() {
					return true;
				}
			}
			["/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker"]
				.iter()
				.any(|path| std::path::Path::new(path).exists())
		}
	})
}

pub async fn docker_containers() -> Result<Vec<Container>> {
	let raw = capture("/", "docker ps -a --format '{{json .}}'")
		.await
		.map_err(|_| CockpitError::msg(crate::i18n::t("system.dockerDown")))?;

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

/// Les ports en écoute tels que `ss -Hltnp` les rend.
///
/// Une ligne : `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4242,fd=23))`.
/// Le processus n'est nommé que s'il appartient à l'utilisateur : les autres
/// (un serveur système) sont écartés, comme `lsof` les écarte sans droits.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn parse_ss(raw: &str) -> Vec<ListeningPort> {
	let mut ports: Vec<ListeningPort> = Vec::new();
	for line in raw.lines() {
		let fields: Vec<&str> = line.split_whitespace().collect();
		let Some(local) = fields.get(3) else { continue };
		let Some(port) = local.rsplit(':').next().and_then(|port| port.parse::<u16>().ok()) else {
			continue;
		};
		let Some(users) = fields.iter().find(|field| field.starts_with("users:")) else { continue };
		let process = users.split('"').nth(1).unwrap_or_default().to_string();
		let Some(pid) = users
			.split("pid=")
			.nth(1)
			.and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
			.and_then(|pid| pid.parse::<u32>().ok())
		else {
			continue;
		};
		if ports.iter().any(|entry| entry.port == port && entry.pid == pid) {
			continue;
		}
		ports.push(ListeningPort { port, process, pid, cwd: String::new(), memory_mb: 0.0 });
	}
	ports.sort_by_key(|entry| entry.port);
	ports
}

/// Ports TCP en écoute, via `lsof`. Sert à repérer d'un coup d'œil quel
/// worktree a un serveur dev encore vivant.
pub async fn listening_ports() -> Result<Vec<ListeningPort>> {
	// Sous Windows, ni `lsof` ni un `ps` qui voie les processus natifs : on
	// demande directement au système (voir `windows_ports`).
	#[cfg(windows)]
	{
		tokio::task::spawn_blocking(windows_ports::listening)
			.await
			.map_err(|e| CockpitError::msg(e.to_string()))
	}
	// Sous Linux, `lsof` est rarement installé d'office ; `ss` l'est toujours,
	// et `/proc` dit le dossier de chaque processus sans rien lancer de plus.
	#[cfg(all(unix, not(target_os = "macos")))]
	{
		let raw = capture("/", "ss -Hltnp 2>/dev/null || true").await?;
		let mut ports = parse_ss(&raw);
		for entry in ports.iter_mut() {
			entry.cwd = std::fs::read_link(format!("/proc/{}/cwd", entry.pid))
				.map(|path| path.to_string_lossy().to_string())
				.unwrap_or_default();
		}
		return Ok(ports);
	}
	#[cfg(target_os = "macos")]
	{
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
}

/// Les ports en écoute sous Windows, par l'API du système plutôt que par
/// `netstat` : la sortie de ce dernier est traduite (« LISTENING » devient
/// « ABHÖREN » en allemand), et la lire reviendrait à parier sur la langue.
///
/// Le dossier de travail d'un processus n'est pas exposé par Windows sans lire
/// sa mémoire : `cwd` reste vide, comme quand `lsof` se tait sous macOS.
#[cfg(windows)]
mod windows_ports {
	use super::ListeningPort;
	use std::collections::{HashMap, HashSet};
	use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
	use windows_sys::Win32::NetworkManagement::IpHelper::{
		GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
	};
	use windows_sys::Win32::System::Diagnostics::ToolHelp::{
		CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
	};
	use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
	use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

	const AF_INET: u32 = 2;
	const AF_INET6: u32 = 23;

	/// La table brute d'une famille d'adresses : `(port, pid)` par ligne.
	fn table(family: u32) -> Vec<(u16, u32)> {
		let mut size: u32 = 0;
		unsafe {
			GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
		}
		if size == 0 {
			return Vec::new();
		}
		// Alignée sur 4 octets, comme les lignes qu'elle contient.
		let mut buffer = vec![0u32; (size as usize).div_ceil(4) + 1];
		let status = unsafe {
			GetExtendedTcpTable(
				buffer.as_mut_ptr().cast(),
				&mut size,
				0,
				family,
				TCP_TABLE_OWNER_PID_LISTENER,
				0,
			)
		};
		if status != 0 {
			return Vec::new();
		}
		let count = buffer[0] as usize;
		let rows = unsafe { buffer.as_ptr().add(1).cast::<u8>() };
		let mut found = Vec::with_capacity(count);
		for index in 0..count {
			let (port, pid) = if family == AF_INET {
				let row = unsafe { &*rows.cast::<MIB_TCPROW_OWNER_PID>().add(index) };
				(row.dwLocalPort, row.dwOwningPid)
			} else {
				let row = unsafe { &*rows.cast::<MIB_TCP6ROW_OWNER_PID>().add(index) };
				(row.dwLocalPort, row.dwOwningPid)
			};
			// Le port est rangé dans l'ordre du réseau, sur les 16 bits du bas.
			found.push((u16::from_be((port & 0xffff) as u16), pid));
		}
		found
	}

	/// Tous les processus vivants : nom et parent.
	fn processes() -> HashMap<u32, (String, u32)> {
		let mut map = HashMap::new();
		unsafe {
			let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
			if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
				return map;
			}
			let mut entry: PROCESSENTRY32W = std::mem::zeroed();
			entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
			let mut more = Process32FirstW(snapshot, &mut entry) != 0;
			while more {
				let length = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
				let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
				map.insert(entry.th32ProcessID, (name, entry.th32ParentProcessID));
				more = Process32NextW(snapshot, &mut entry) != 0;
			}
			CloseHandle(snapshot);
		}
		map
	}

	/// La mémoire de travail d'un processus, en octets ; zéro s'il refuse.
	fn working_set(pid: u32) -> u64 {
		unsafe {
			let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
			if handle.is_null() {
				return 0;
			}
			let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
			counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
			let ok = K32GetProcessMemoryInfo(handle, &mut counters, counters.cb) != 0;
			CloseHandle(handle);
			if ok {
				counters.WorkingSetSize as u64
			} else {
				0
			}
		}
	}

	/// `node.exe` → `node`, comme `lsof` le dit sous macOS.
	pub(super) fn short_name(name: &str) -> String {
		if name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(".exe") {
			name[..name.len() - 4].to_string()
		} else {
			name.to_string()
		}
	}

	pub fn listening() -> Vec<ListeningPort> {
		let processes = processes();
		let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
		for (pid, (_, parent)) in &processes {
			// Le processus inactif (0) se déclare son propre parent.
			if pid != parent {
				children.entry(*parent).or_default().push(*pid);
			}
		}

		let mut ports: Vec<ListeningPort> = Vec::new();
		for (port, pid) in table(AF_INET).into_iter().chain(table(AF_INET6)) {
			// Le système (pid 0 et 4) écoute pour d'autres : rien à arrêter.
			if pid <= 4 || ports.iter().any(|p| p.port == port && p.pid == pid) {
				continue;
			}
			let process = processes
				.get(&pid)
				.map(|(name, _)| short_name(name))
				.unwrap_or_default();
			ports.push(ListeningPort { port, process, pid, cwd: String::new(), memory_mb: 0.0 });
		}

		// Ce que chaque serveur pèse, sa descendance comprise.
		let mut weights: HashMap<u32, u64> = HashMap::new();
		for entry in ports.iter_mut() {
			let mut total = 0u64;
			let mut stack = vec![entry.pid];
			let mut seen = HashSet::new();
			while let Some(pid) = stack.pop() {
				if !seen.insert(pid) {
					continue;
				}
				total += *weights.entry(pid).or_insert_with(|| working_set(pid));
				if let Some(next) = children.get(&pid) {
					stack.extend(next.iter().copied());
				}
			}
			entry.memory_mb = total as f64 / (1024.0 * 1024.0);
		}

		ports.sort_by_key(|p| p.port);
		ports
	}
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
		return Err(CockpitError::msg(crate::i18n::t("system.unknownProcess")));
	}
	crate::platform::terminate_pid(pid);
	tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
	if crate::platform::pid_alive(pid) {
		crate::platform::kill_pid(pid);
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ss_dit_le_port_le_processus_et_son_pid() {
		let raw = "\
LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:((\"node\",pid=4242,fd=23))
LISTEN 0 4096 [::]:3000 [::]:* users:((\"next-server\",pid=77,fd=19),(\"next-server\",pid=77,fd=20))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:*
";
		let ports = parse_ss(raw);
		assert_eq!(ports.len(), 2, "{ports:?}");
		assert_eq!((ports[0].port, ports[0].pid, ports[0].process.as_str()), (3000, 77, "next-server"));
		assert_eq!((ports[1].port, ports[1].pid, ports[1].process.as_str()), (5173, 4242, "node"));
	}

	#[test]
	fn seul_un_chemin_absolu_s_ouvre() {
		assert!(!is_absolute_path("-n /etc/passwd"));
		assert!(!is_absolute_path("relatif/a.docx"));
		if cfg!(windows) {
			assert!(is_absolute_path("C:\\Users\\ana\\a.docx"));
			assert!(is_absolute_path("C:/Users/ana/a.docx"));
		} else {
			assert!(is_absolute_path("/Users/ana/a.docx"));
		}
	}

	#[test]
	fn un_programme_ne_passe_pas_pour_un_document() {
		assert!(runs_as_program("C:/x/installe.EXE"));
		assert!(runs_as_program("C:/x/script.bat"));
		assert!(runs_as_program("C:/x/raccourci.lnk"));
		assert!(!runs_as_program("C:/x/rapport.docx"));
		assert!(!runs_as_program("C:/x/sans-extension"));
	}
}
