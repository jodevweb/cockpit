//! Ce qui diffère d'un système à l'autre, en un seul endroit.
//!
//! Le cockpit joue beaucoup de lignes de commande (agents, scripts, git…) et
//! gère des groupes de processus qui doivent survivre à l'app ou mourir avec
//! elle. Sous macOS, c'est `zsh -lc` et les groupes POSIX ; sous Windows, le
//! bash de **Git for Windows** — que Claude Code exige déjà sur ce système — et
//! les arbres de processus de Windows.
//!
//! Règle pour tout le reste du code : ne jamais écrire `Command::new("zsh")`,
//! `libc::kill`, `open` ou `osascript` ailleurs qu'ici.

use std::path::PathBuf;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

// ─────────────────────────────── Shell ───────────────────────────────

/// Le bash de Git for Windows. `COCKPIT_BASH` prime ; sinon on le déduit de
/// `git`, puis des emplacements d'installation habituels.
#[cfg(windows)]
pub fn git_bash() -> Option<PathBuf> {
	if let Ok(path) = std::env::var("COCKPIT_BASH") {
		let path = PathBuf::from(path);
		if path.is_file() {
			return Some(path);
		}
	}
	let mut candidates: Vec<PathBuf> = Vec::new();
	if let Ok(output) = quiet_std(std::process::Command::new("where").arg("git")).output() {
		for line in String::from_utf8_lossy(&output.stdout).lines() {
			// …\Git\cmd\git.exe ou …\Git\bin\git.exe → …\Git\bin\bash.exe
			if let Some(root) = PathBuf::from(line.trim()).parent().and_then(|dir| dir.parent()) {
				candidates.push(root.join("bin").join("bash.exe"));
			}
		}
	}
	for base in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
		if let Ok(dir) = std::env::var(base) {
			candidates.push(PathBuf::from(dir).join("Git").join("bin").join("bash.exe"));
		}
	}
	if let Ok(dir) = std::env::var("LOCALAPPDATA") {
		candidates.push(PathBuf::from(dir).join("Programs").join("Git").join("bin").join("bash.exe"));
	}
	candidates.into_iter().find(|path| path.is_file())
}

/// Le programme qui joue une ligne de commande.
pub fn shell_program() -> PathBuf {
	#[cfg(windows)]
	{
		git_bash().unwrap_or_else(|| PathBuf::from("bash.exe"))
	}
	#[cfg(not(windows))]
	{
		PathBuf::from("zsh")
	}
}

/// Le shell est-il là ? Sous Windows, sans Git for Windows, rien ne peut tourner :
/// l'interface le dit plutôt que d'échouer commande après commande.
pub fn shell_available() -> bool {
	#[cfg(windows)]
	{
		git_bash().is_some()
	}
	#[cfg(not(windows))]
	{
		true
	}
}

/// Une ligne de commande jouée par le shell de connexion (`-lc`), sans fenêtre.
pub fn shell(script: &str) -> std::process::Command {
	let mut command = std::process::Command::new(shell_program());
	command.arg("-lc").arg(script);
	quiet_std(&mut command);
	command
}

/// La même, pour tokio.
pub fn shell_async(script: &str) -> tokio::process::Command {
	let mut command = tokio::process::Command::new(shell_program());
	command.arg("-lc").arg(script);
	quiet_async(&mut command);
	command
}

/// Aucune fenêtre console ne doit clignoter quand une app graphique lance un
/// programme sous Windows. Sans effet ailleurs. À appliquer à toute `Command`.
pub fn quiet_std(command: &mut std::process::Command) -> &mut std::process::Command {
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		command.creation_flags(CREATE_NO_WINDOW);
	}
	command
}

pub fn quiet_async(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
	#[cfg(windows)]
	{
		command.creation_flags(CREATE_NO_WINDOW);
	}
	command
}

// ─────────────────────────────── Processus ───────────────────────────────

/// Lance dans son propre groupe : on le tue en entier, il ne reçoit pas les
/// signaux de l'app, et il peut lui survivre.
pub fn detach_std(command: &mut std::process::Command) -> &mut std::process::Command {
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt;
		command.process_group(0);
	}
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
	}
	command
}

pub fn detach_async(command: &mut tokio::process::Command) -> &mut tokio::process::Command {
	#[cfg(unix)]
	{
		command.process_group(0);
	}
	#[cfg(windows)]
	{
		command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
	}
	command
}

/// Le groupe lancé par [`detach_std`] (identifié par le pid de son chef) a-t-il
/// encore un processus vivant ? Sous Windows, on regarde le chef lui-même.
pub fn group_alive(leader: i32) -> bool {
	// 1 n'est jamais un groupe à nous, et `kill(-1, …)` viserait tous les
	// processus du compte.
	if leader <= 1 {
		return false;
	}
	#[cfg(unix)]
	{
		unsafe { libc::kill(-leader, 0) == 0 }
	}
	#[cfg(windows)]
	{
		pid_alive(leader as u32)
	}
}

/// Un processus précis est-il vivant ?
pub fn pid_alive(pid: u32) -> bool {
	if pid <= 1 {
		return false;
	}
	#[cfg(unix)]
	{
		unsafe { libc::kill(pid as i32, 0) == 0 }
	}
	#[cfg(windows)]
	{
		use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
		use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
		unsafe {
			let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
			if handle.is_null() {
				return false;
			}
			let mut code: u32 = 0;
			let ok = GetExitCodeProcess(handle, &mut code) != 0;
			CloseHandle(handle);
			ok && code == STILL_ACTIVE as u32
		}
	}
}

/// Demande poliment au groupe de s'arrêter (`SIGTERM` ; sous Windows, arrêt de
/// l'arbre de processus, qui n'a pas d'équivalent « poli » pour un programme
/// sans fenêtre).
pub fn terminate_group(leader: i32) {
	if leader <= 1 {
		return;
	}
	#[cfg(unix)]
	unsafe {
		libc::kill(-leader, libc::SIGTERM);
	}
	#[cfg(windows)]
	taskkill(leader as u32, false);
}

/// Arrête le groupe sans discussion (`SIGKILL` ; sous Windows, `taskkill /T /F`).
pub fn kill_group(leader: i32) {
	if leader <= 1 {
		return;
	}
	#[cfg(unix)]
	unsafe {
		libc::kill(-leader, libc::SIGKILL);
	}
	#[cfg(windows)]
	taskkill(leader as u32, true);
}

/// `SIGTERM` à un seul processus (sous Windows, son arbre).
pub fn terminate_pid(pid: u32) {
	if pid <= 1 {
		return;
	}
	#[cfg(unix)]
	unsafe {
		libc::kill(pid as i32, libc::SIGTERM);
	}
	#[cfg(windows)]
	taskkill(pid, false);
}

/// `SIGKILL` à un seul processus (sous Windows, son arbre).
pub fn kill_pid(pid: u32) {
	if pid <= 1 {
		return;
	}
	#[cfg(unix)]
	unsafe {
		libc::kill(pid as i32, libc::SIGKILL);
	}
	#[cfg(windows)]
	taskkill(pid, true);
}

#[cfg(windows)]
fn taskkill(pid: u32, force: bool) {
	let mut command = std::process::Command::new("taskkill");
	command.args(["/PID", &pid.to_string(), "/T"]);
	if force {
		command.arg("/F");
	}
	let _ = quiet_std(&mut command)
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.status();
}

// ─────────────────────────────── Bureau ───────────────────────────────

/// Ouvre une URL ou un fichier avec l'application par défaut du système.
pub fn open(target: &str) -> std::io::Result<()> {
	#[cfg(target_os = "macos")]
	{
		let status = std::process::Command::new("/usr/bin/open").arg(target).status()?;
		ok(status)
	}
	#[cfg(windows)]
	{
		// `rundll32 url.dll,FileProtocolHandler` ouvre URL et fichiers sans
		// passer par `cmd`, donc sans interprétation de `&` ou `^`.
		let status = quiet_std(
			std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", target]),
		)
		.status()?;
		ok(status)
	}
	#[cfg(all(unix, not(target_os = "macos")))]
	{
		let status = std::process::Command::new("xdg-open").arg(target).status()?;
		ok(status)
	}
}

/// Montre un fichier dans le gestionnaire de fichiers, sélectionné.
pub fn reveal(path: &str) -> std::io::Result<()> {
	#[cfg(target_os = "macos")]
	{
		let status = std::process::Command::new("/usr/bin/open").args(["-R", path]).status()?;
		ok(status)
	}
	#[cfg(windows)]
	{
		// `explorer` rend un code non nul même quand il réussit : on ne le lit pas.
		let windows_path = path.replace('/', "\\");
		quiet_std(std::process::Command::new("explorer.exe").arg(format!("/select,{windows_path}"))).spawn()?;
		Ok(())
	}
	#[cfg(all(unix, not(target_os = "macos")))]
	{
		let parent = std::path::Path::new(path).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
		let status = std::process::Command::new("xdg-open").arg(parent).status()?;
		ok(status)
	}
}

fn ok(status: std::process::ExitStatus) -> std::io::Result<()> {
	if status.success() {
		Ok(())
	} else {
		Err(std::io::Error::other(format!("{status}")))
	}
}

// ─────────────────────────────── Système ───────────────────────────────

/// La langue préférée de l'utilisateur, telle que le système la donne
/// (`fr-FR`, `zh-Hans-CN`…). Vide si inconnue.
pub fn system_language() -> String {
	#[cfg(target_os = "macos")]
	{
		let listed = std::process::Command::new("defaults")
			.args(["read", "-g", "AppleLanguages"])
			.output()
			.ok()
			.map(|output| String::from_utf8_lossy(&output.stdout).to_string())
			.unwrap_or_default();
		if let Some(first) = listed
			.split(|c: char| c == '"' || c == '\n' || c == ',' || c == '(' || c == ')')
			.map(str::trim)
			.find(|item| !item.is_empty())
		{
			return first.to_string();
		}
	}
	#[cfg(windows)]
	{
		use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
		let mut buffer = [0u16; 85];
		let length = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
		if length > 1 {
			return String::from_utf16_lossy(&buffer[..(length as usize - 1)]);
		}
	}
	std::env::var("LANG").unwrap_or_default()
}

/// Le séparateur de `PATH` du système.
pub const PATH_SEPARATOR: &str = if cfg!(windows) { ";" } else { ":" };

/// Le nom d'un exécutable sur ce système (`claude` → `claude.exe` sous Windows).
pub fn exe(name: &str) -> String {
	if cfg!(windows) && !name.contains('.') {
		format!("{name}.exe")
	} else {
		name.to_string()
	}
}

/// Un chemin tel que l'interface l'attend : séparateurs `/` partout. Windows les
/// accepte, et l'interface découpe les chemins sur `/`.
pub fn display_path(path: &std::path::Path) -> String {
	let text = path.to_string_lossy().to_string();
	if cfg!(windows) {
		text.replace('\\', "/")
	} else {
		text
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn le_shell_joue_une_commande() {
		let output = shell("echo cockpit").output().expect("le shell doit se lancer");
		assert!(String::from_utf8_lossy(&output.stdout).contains("cockpit"));
	}

	#[test]
	fn un_pid_absurde_n_est_jamais_vivant() {
		assert!(!pid_alive(0));
		assert!(!pid_alive(1));
		assert!(!group_alive(-5));
	}

	#[test]
	fn ce_processus_est_vivant() {
		assert!(pid_alive(std::process::id()));
	}
}
