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
		candidates.push(
			PathBuf::from(dir)
				.join("Programs")
				.join("Git")
				.join("bin")
				.join("bash.exe"),
		);
	}
	candidates.into_iter().find(|path| path.is_file())
}

/// Le programme qui joue une ligne de commande.
pub fn shell_program() -> PathBuf {
	#[cfg(windows)]
	{
		git_bash().unwrap_or_else(|| PathBuf::from("bash.exe"))
	}
	// Le shell du système sous macOS. Sous Linux, `zsh` n'est pas toujours
	// installé, `bash` l'est partout.
	#[cfg(target_os = "macos")]
	{
		PathBuf::from("zsh")
	}
	#[cfg(all(unix, not(target_os = "macos")))]
	{
		PathBuf::from("bash")
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
	// Sans elle, le profil MSYS ramène le shell dans `$HOME` et ignore le
	// dossier de travail demandé.
	#[cfg(windows)]
	command.env("CHERE_INVOKING", "1");
	quiet_std(&mut command);
	command
}

/// La même, pour tokio.
pub fn shell_async(script: &str) -> tokio::process::Command {
	let mut command = tokio::process::Command::new(shell_program());
	command.arg("-lc").arg(script);
	#[cfg(windows)]
	command.env("CHERE_INVOKING", "1");
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
		use windows_sys::Win32::System::Threading::{
			GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
		};
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
	let run = |force: bool| {
		let mut command = std::process::Command::new("taskkill");
		command.args(["/PID", &pid.to_string(), "/T"]);
		if force {
			command.arg("/F");
		}
		quiet_std(&mut command)
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null())
			.status()
			.map(|status| status.success())
			.unwrap_or(false)
	};
	// Sans `/F`, `taskkill` envoie WM_CLOSE : un programme console sans fenêtre
	// (node, bash, claude) le refuse. L'arrêt « poli » qui échoue devient forcé,
	// sinon annuler un job ou fermer un terminal ne tuerait rien.
	if !force && run(false) {
		return;
	}
	run(true);
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
		let status =
			quiet_std(std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", target]))
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
		let status = std::process::Command::new("/usr/bin/open")
			.args(["-R", path])
			.status()?;
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
		let parent = std::path::Path::new(path)
			.parent()
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_default();
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
			.split(['"', '\n', ',', '(', ')'])
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

// ── processus et terminal ──
//
// Sous macOS, `ps`, `pgrep`, `vm_stat` et `sysctl` disent tout ce qu'il faut ;
// sous Windows, on demande directement au système. Rien ici ne sert sous
// macOS : chaque appelant garde sa voie macOS intacte.

/// Un processus de la machine, vu par Windows ou lu dans `/proc` sous Linux.
#[cfg(any(windows, target_os = "linux", test))]
#[derive(Debug, Clone)]
pub struct ProcessEntry {
	pub pid: u32,
	/// Le parent, ou 0 s'il n'existe plus. Windows garde le pid du parent mort
	/// tel quel, et ce pid peut avoir été redonné depuis à un processus sans
	/// rapport : on ne retient le lien que si le parent est plus ancien que
	/// l'enfant — ce qui fait de 0 l'équivalent du « rattaché à launchd ».
	pub ppid: u32,
	/// L'exécutable, sans son `.exe` : `cockpit`, `node`, `claude`.
	pub name: String,
	/// Mémoire résidente (« working set »), en kilo-octets ; 0 si illisible.
	pub rss_kb: u64,
	/// Temps processeur consommé depuis le lancement, en secondes.
	pub cpu_seconds: f64,
}

#[cfg(windows)]
fn filetime_ticks(time: &windows_sys::Win32::Foundation::FILETIME) -> u64 {
	((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
}

/// Tous les processus de la machine, d'un seul relevé.
///
/// La liste vient de l'instantané ToolHelp (pid, parent, exécutable) ; mémoire,
/// temps processeur et date de création s'y ajoutent pour les processus qu'on a
/// le droit d'ouvrir — les nôtres, ce qui est le périmètre voulu.
#[cfg(windows)]
pub fn processes() -> Vec<ProcessEntry> {
	use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
	use windows_sys::Win32::System::Diagnostics::ToolHelp::{
		CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
	};
	use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
	use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

	let mut raw: Vec<(ProcessEntry, Option<u64>)> = Vec::new();
	unsafe {
		let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
		if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
			return Vec::new();
		}
		let mut entry: PROCESSENTRY32W = std::mem::zeroed();
		entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
		let mut more = Process32FirstW(snapshot, &mut entry) != 0;
		while more {
			let length = entry
				.szExeFile
				.iter()
				.position(|c| *c == 0)
				.unwrap_or(entry.szExeFile.len());
			let exe = String::from_utf16_lossy(&entry.szExeFile[..length]);
			let name = match exe.len().checked_sub(4) {
				Some(cut) if exe[cut..].eq_ignore_ascii_case(".exe") => exe[..cut].to_string(),
				_ => exe,
			};
			let mut process = ProcessEntry {
				pid: entry.th32ProcessID,
				ppid: entry.th32ParentProcessID,
				name,
				rss_kb: 0,
				cpu_seconds: 0.0,
			};
			let mut created = None;
			let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process.pid);
			if !handle.is_null() {
				let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
				counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
				if GetProcessMemoryInfo(handle, &mut counters, counters.cb) != 0 {
					process.rss_kb = (counters.WorkingSetSize / 1024) as u64;
				}
				let zero = FILETIME {
					dwLowDateTime: 0,
					dwHighDateTime: 0,
				};
				let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
				if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 {
					// Des tranches de 100 ns.
					process.cpu_seconds = (filetime_ticks(&kernel) + filetime_ticks(&user)) as f64 / 10_000_000.0;
					created = Some(filetime_ticks(&creation));
				}
				CloseHandle(handle);
			}
			raw.push((process, created));
			more = Process32NextW(snapshot, &mut entry) != 0;
		}
		CloseHandle(snapshot);
	}

	let created: std::collections::HashMap<u32, Option<u64>> =
		raw.iter().map(|(process, created)| (process.pid, *created)).collect();
	raw.into_iter()
		.map(|(mut process, born)| {
			let parent_ok = match created.get(&process.ppid) {
				None => false,
				// Parent plus jeune que l'enfant : son pid a été redonné.
				Some(Some(parent_born)) => born.is_none_or(|born| *parent_born <= born),
				// Parent qu'on ne peut pas ouvrir (système, autre compte) : on
				// garde le lien, faute de mieux.
				Some(None) => true,
			};
			if !parent_ok || process.ppid == process.pid {
				process.ppid = 0;
			}
			process
		})
		.collect()
}

/// Les descendants d'un processus, à toute profondeur, les plus profonds
/// d'abord. Sous Windows, d'un seul instantané ; ailleurs, vide (les appelants
/// macOS ont leur propre voie).
pub fn descendants(pid: u32) -> Vec<u32> {
	#[cfg(any(windows, target_os = "linux"))]
	{
		let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
		for process in processes() {
			if process.ppid != 0 {
				children.entry(process.ppid).or_default().push(process.pid);
			}
		}
		let mut found = Vec::new();
		let mut to_visit = vec![pid];
		while let Some(current) = to_visit.pop() {
			for child in children.get(&current).into_iter().flatten() {
				if *child != pid && !found.contains(child) && found.len() < 4096 {
					found.push(*child);
					to_visit.push(*child);
				}
			}
		}
		found.reverse();
		found
	}
	#[cfg(not(any(windows, target_os = "linux")))]
	{
		let _ = pid;
		Vec::new()
	}
}

/// L'environnement d'un autre processus, tel qu'il l'a reçu à sa naissance.
///
/// Windows n'offre pas d'appel public pour ça : on le lit là où le système le
/// range, dans le bloc de paramètres du processus (`PEB` →
/// `RTL_USER_PROCESS_PARAMETERS` → `Environment`) — la méthode de Process
/// Explorer et de `psutil`. Il faut le droit de lire sa mémoire, donc que le
/// processus soit à nous ; sinon, `None`. Une variable posée après coup par le
/// processus lui-même peut ne pas y figurer — ce qu'on cherche (une marque
/// héritée à la naissance) y est toujours.
#[cfg(windows)]
pub fn process_environment(pid: u32) -> Option<Vec<String>> {
	use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
	use windows_sys::Win32::Foundation::CloseHandle;
	use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
	use windows_sys::Win32::System::Memory::{VirtualQueryEx, MEMORY_BASIC_INFORMATION};
	use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

	// `PROCESS_BASIC_INFORMATION`, recopiée pour ne pas tirer une feature de
	// plus pour une structure de six champs.
	#[repr(C)]
	struct BasicInformation {
		exit_status: i32,
		peb: usize,
		affinity: usize,
		base_priority: i32,
		pid: usize,
		parent: usize,
	}
	// Décalages documentés par l'usage (winternl.h, psutil) : stables depuis
	// Vista.
	#[cfg(target_pointer_width = "64")]
	const OFFSETS: (usize, usize, usize) = (0x20, 0x80, 0x3F0);
	#[cfg(target_pointer_width = "32")]
	const OFFSETS: (usize, usize, usize) = (0x10, 0x48, 0x290);
	let (parameters_at, environment_at, environment_size_at) = OFFSETS;

	unsafe fn read_at<T: Copy>(handle: windows_sys::Win32::Foundation::HANDLE, address: usize) -> Option<T> {
		let mut value = std::mem::MaybeUninit::<T>::uninit();
		let mut read = 0usize;
		unsafe {
			let ok = ReadProcessMemory(
				handle,
				address as *const _,
				value.as_mut_ptr() as *mut _,
				std::mem::size_of::<T>(),
				&mut read,
			) != 0;
			(ok && read == std::mem::size_of::<T>()).then(|| value.assume_init())
		}
	}

	if pid <= 4 {
		return None;
	}
	unsafe {
		let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
		if handle.is_null() {
			return None;
		}
		let result = (|| {
			let mut info: BasicInformation = std::mem::zeroed();
			let mut length = 0u32;
			let status = NtQueryInformationProcess(
				handle,
				ProcessBasicInformation,
				&mut info as *mut _ as *mut _,
				std::mem::size_of::<BasicInformation>() as u32,
				&mut length,
			);
			if status < 0 || info.peb == 0 {
				return None;
			}
			let parameters: usize = read_at(handle, info.peb + parameters_at)?;
			let environment: usize = read_at(handle, parameters + environment_at)?;
			if environment == 0 {
				return None;
			}
			// La taille annoncée peut être périmée si le processus a réécrit son
			// environnement : on la borne à la région mémoire réellement lisible.
			let declared: usize = read_at(handle, parameters + environment_size_at).unwrap_or(0);
			let mut region: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
			let readable = if VirtualQueryEx(
				handle,
				environment as *const _,
				&mut region,
				std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
			) != 0
			{
				(region.BaseAddress as usize + region.RegionSize).saturating_sub(environment)
			} else {
				declared
			};
			let size = if declared > 0 { declared.min(readable) } else { readable }.min(1 << 20);
			if size < 4 {
				return None;
			}
			let mut buffer = vec![0u16; size / 2];
			let mut read = 0usize;
			if ReadProcessMemory(
				handle,
				environment as *const _,
				buffer.as_mut_ptr() as *mut _,
				buffer.len() * 2,
				&mut read,
			) == 0
			{
				return None;
			}
			buffer.truncate(read / 2);
			let mut variables = Vec::new();
			for entry in buffer.split(|c| *c == 0) {
				if entry.is_empty() {
					// Deux zéros de suite : fin du bloc.
					break;
				}
				variables.push(String::from_utf16_lossy(entry));
			}
			Some(variables)
		})();
		CloseHandle(handle);
		result
	}
}

/// Mémoire physique de la machine : totale et utilisée, en mégaoctets.
/// « Utilisée » = tout sauf ce que Windows dit disponible, comme le
/// gestionnaire des tâches.
#[cfg(windows)]
pub fn machine_memory_mb() -> (f64, f64) {
	use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
	unsafe {
		let mut status: MEMORYSTATUSEX = std::mem::zeroed();
		status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
		if GlobalMemoryStatusEx(&mut status) == 0 {
			return (0.0, 0.0);
		}
		let total = status.ullTotalPhys as f64 / 1024.0 / 1024.0;
		let used = status.ullTotalPhys.saturating_sub(status.ullAvailPhys) as f64 / 1024.0 / 1024.0;
		(total, used)
	}
}

/// Tous les processus de la machine, lus dans `/proc`.
///
/// `stat` donne le parent, le nom, les temps processeur et la mémoire
/// résidente. Le nom est entre parenthèses et peut contenir des espaces ou des
/// parenthèses : on coupe sur la **dernière** parenthèse fermante.
#[cfg(target_os = "linux")]
pub fn processes() -> Vec<ProcessEntry> {
	let ticks = 100.0; // `getconf CLK_TCK` vaut 100 sur tous les noyaux courants.
	let page_kb = (unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(4096) / 1024) as u64;
	let Ok(entries) = std::fs::read_dir("/proc") else {
		return Vec::new();
	};
	entries
		.filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
		.filter_map(|pid| {
			let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
			parse_proc_stat(pid, &stat, ticks, page_kb)
		})
		.collect()
}

/// Une ligne de `/proc/<pid>/stat`, lue comme `proc(5)` la décrit.
#[cfg(any(test, target_os = "linux"))]
fn parse_proc_stat(pid: u32, stat: &str, ticks: f64, page_kb: u64) -> Option<ProcessEntry> {
	let open = stat.find('(')?;
	let close = stat.rfind(')')?;
	let name = stat.get(open + 1..close)?.to_string();
	// Après le nom : état (3), parent (4)… utime (14), stime (15)… rss (24).
	let rest: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
	let field = |n: usize| rest.get(n - 3).and_then(|value| value.parse::<u64>().ok());
	Some(ProcessEntry {
		pid,
		ppid: field(4)? as u32,
		name,
		rss_kb: field(24).unwrap_or(0) * page_kb,
		cpu_seconds: (field(14).unwrap_or(0) + field(15).unwrap_or(0)) as f64 / ticks,
	})
}

/// L'environnement d'un autre processus, tel qu'il l'a reçu à sa naissance :
/// `/proc/<pid>/environ`, lisible pour les processus de l'utilisateur.
#[cfg(target_os = "linux")]
pub fn process_environment(pid: u32) -> Option<Vec<String>> {
	let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
	Some(
		raw.split(|byte| *byte == 0)
			.filter(|entry| !entry.is_empty())
			.map(|entry| String::from_utf8_lossy(entry).to_string())
			.collect(),
	)
}

/// Mémoire physique de la machine : totale et utilisée, en mégaoctets.
/// « Utilisée » = tout sauf `MemAvailable`, comme `free`.
#[cfg(target_os = "linux")]
pub fn machine_memory_mb() -> (f64, f64) {
	let raw = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
	parse_meminfo(&raw)
}

#[cfg(any(test, target_os = "linux"))]
fn parse_meminfo(raw: &str) -> (f64, f64) {
	let read = |key: &str| {
		raw.lines()
			.find(|line| line.starts_with(key))
			.and_then(|line| line.split_whitespace().nth(1))
			.and_then(|value| value.parse::<f64>().ok())
			.unwrap_or(0.0)
	};
	let total = read("MemTotal:") / 1024.0;
	let available = read("MemAvailable:") / 1024.0;
	(total, (total - available).max(0.0))
}

// ── agents, outils, sessions ──

/// Un chemin natif tel qu'un script du shell doit l'écrire dans son `PATH`.
///
/// Le bash de Git for Windows tient un `PATH` à la mode POSIX — séparé par `:`,
/// `C:\Users\moi` écrit `/c/Users/moi` : y glisser un chemin Windows tel quel
/// le couperait en deux sur le `:` du lecteur. Ailleurs, rien à changer.
pub fn shell_path(path: &str) -> String {
	if cfg!(windows) {
		msys_path(path)
	} else {
		path.to_string()
	}
}

/// `C:\Users\moi` → `/c/Users/moi`. Un chemin sans lecteur garde sa forme,
/// séparateurs redressés.
fn msys_path(path: &str) -> String {
	let slashed = path.replace('\\', "/");
	let bytes = slashed.as_bytes();
	if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
		let drive = (bytes[0] as char).to_ascii_lowercase();
		let rest = slashed[2..].trim_start_matches('/');
		if rest.is_empty() {
			format!("/{drive}")
		} else {
			format!("/{drive}/{rest}")
		}
	} else {
		slashed
	}
}

/// Un chemin tel que le reste du cockpit l'écrit : sous Windows, séparateurs
/// `/` et sans le préfixe `\\?\` que pose `canonicalize`. La casse est gardée :
/// c'est un chemin qu'on affiche et qu'on renvoie, pas une clé de comparaison
/// (pour ça, `path_key`). Ailleurs, inchangé.
pub fn plain_path(path: &str) -> String {
	if cfg!(windows) {
		let slashed = path.replace('\\', "/");
		slashed.strip_prefix("//?/").unwrap_or(&slashed).to_string()
	} else {
		path.to_string()
	}
}

/// La forme sous laquelle comparer deux chemins de dossier : sans séparateur
/// final. Sous Windows en plus, séparateurs `/`, sans préfixe `\\?\` (ce que
/// rend `canonicalize`), et sans casse — le système n'en tient pas compte.
pub fn path_key(path: &str) -> String {
	let path = path.trim();
	if cfg!(windows) {
		let slashed = path.replace('\\', "/");
		let slashed = slashed.strip_prefix("//?/").unwrap_or(&slashed);
		slashed.trim_end_matches('/').to_lowercase()
	} else {
		path.trim_end_matches('/').to_string()
	}
}

/// Deux chemins désignent-ils le même dossier, à l'écriture près ? Ailleurs que
/// sous Windows, la comparaison reste exacte.
pub fn same_path(left: &str, right: &str) -> bool {
	if cfg!(windows) {
		path_key(left) == path_key(right)
	} else {
		left == right
	}
}

/// Chemin absolu d'un programme installé, tel que la personne le lancerait.
///
/// Lancé depuis le Finder ou le menu Démarrer, le cockpit n'hérite que d'un
/// `PATH` minimal : on demande au shell de connexion (`command -v`). Sous
/// Windows, `where` d'abord — il connaît le `PATH` du compte et les extensions
/// exécutables —, puis le bash de Git, dont la réponse est traduite en chemin
/// natif (`cygpath -w`). Seul un fichier lançable sans shell est retenu : npm
/// pose à côté de `claude.cmd` un script `claude` sans extension, que Windows
/// ne sait pas exécuter.
pub fn locate(name: &str) -> Option<String> {
	// Le nom est joué par le shell : rien d'autre qu'un nom de programme.
	if name.is_empty()
		|| !name
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
	{
		return None;
	}
	#[cfg(windows)]
	{
		if let Ok(output) = quiet_std(std::process::Command::new("where").arg(name)).output() {
			for line in String::from_utf8_lossy(&output.stdout).lines() {
				if let Some(found) = runnable(std::path::Path::new(line.trim())) {
					return Some(found);
				}
			}
		}
		if shell_available() {
			if let Ok(output) = shell(&format!("p=\"$(command -v {name})\" && cygpath -w \"$p\"")).output() {
				let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
				if !found.is_empty() {
					if let Some(found) = runnable(std::path::Path::new(&found)) {
						return Some(found);
					}
				}
			}
		}
		None
	}
	#[cfg(not(windows))]
	{
		let output = shell(&format!("command -v {name}")).output().ok()?;
		let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
		(!found.is_empty() && std::path::Path::new(&found).exists()).then_some(found)
	}
}

/// Le premier candidat qui existe — sous Windows, qui se lance sans shell
/// (`.exe`, `.cmd`, `.bat`, `.com`, au besoin en ajoutant l'extension).
pub fn first_runnable(candidates: &[PathBuf]) -> Option<String> {
	candidates.iter().find_map(|path| {
		#[cfg(windows)]
		{
			runnable(path)
		}
		#[cfg(not(windows))]
		{
			path.exists().then(|| path.to_string_lossy().to_string())
		}
	})
}

#[cfg(windows)]
fn runnable(path: &std::path::Path) -> Option<String> {
	const EXTENSIONS: [&str; 4] = ["exe", "cmd", "bat", "com"];
	if path.as_os_str().is_empty() {
		return None;
	}
	let known = path
		.extension()
		.map(|ext| EXTENSIONS.contains(&ext.to_string_lossy().to_lowercase().as_str()))
		.unwrap_or(false);
	if known {
		return path.is_file().then(|| path.to_string_lossy().to_string());
	}
	EXTENSIONS.iter().find_map(|ext| {
		let candidate = PathBuf::from(format!("{}.{ext}", path.to_string_lossy()));
		candidate.is_file().then(|| candidate.to_string_lossy().to_string())
	})
}

/// Un dossier désigné par une variable d'environnement (`APPDATA`,
/// `LOCALAPPDATA`, `ProgramFiles`…), quand elle est posée.
pub fn env_dir(name: &str) -> Option<PathBuf> {
	std::env::var_os(name)
		.filter(|value| !value.is_empty())
		.map(PathBuf::from)
}

/// L'adresse `file://` d'un fichier local, lisible par un navigateur sur
/// chaque système (`file:///C:/…` sous Windows).
pub fn file_url(path: &std::path::Path) -> String {
	let text = display_path(path);
	if text.starts_with('/') {
		format!("file://{text}")
	} else {
		format!("file:///{text}")
	}
}

#[cfg(test)]
mod agents_tests {
	#[test]
	fn proc_stat_se_lit_meme_quand_le_nom_porte_des_parentheses() {
		let stat = "4242 (node (dev) x) S 77 4242 4242 0 -1 4194560 2000 0 0 0 150 50 0 0 20 0 11 0 9000 123456 2560 18446744073709551615";
		let entry = parse_proc_stat(4242, stat, 100.0, 4).unwrap();
		assert_eq!(entry.name, "node (dev) x");
		assert_eq!(entry.ppid, 77);
		assert_eq!(entry.rss_kb, 2560 * 4);
		assert!((entry.cpu_seconds - 2.0).abs() < 1e-9);
	}

	#[test]
	fn meminfo_dit_le_total_et_ce_qui_est_pris() {
		let raw = "MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8192000 kB
";
		let (total, used) = parse_meminfo(raw);
		assert!((total - 16000.0).abs() < 1.0, "{total}");
		assert!((used - 8000.0).abs() < 1.0, "{used}");
	}

	use super::*;

	#[test]
	fn un_chemin_windows_devient_un_chemin_du_bash_de_git() {
		assert_eq!(msys_path(r"C:\Users\moi\.local\bin"), "/c/Users/moi/.local/bin");
		assert_eq!(msys_path("D:/outils"), "/d/outils");
		assert_eq!(msys_path(r"C:\"), "/c");
		assert_eq!(msys_path("/usr/bin"), "/usr/bin");
	}

	#[test]
	fn ailleurs_qu_a_windows_le_chemin_du_shell_est_le_chemin_natif() {
		if !cfg!(windows) {
			assert_eq!(shell_path("/Users/moi/.local/bin"), "/Users/moi/.local/bin");
			assert!(same_path("/a/b", "/a/b"));
			assert!(!same_path("/a/b", "/a/b/"));
		} else {
			assert!(same_path(r"C:\Users\Moi\proj", "c:/users/moi/proj/"));
			assert!(same_path(r"\\?\C:\Users\moi", "C:/Users/moi"));
			assert_eq!(plain_path(r"\\?\D:\jorda\Shop"), "D:/jorda/Shop");
			assert_eq!(plain_path("D:/jorda/Shop"), "D:/jorda/Shop");
		}
	}

	#[test]
	fn la_cle_d_un_chemin_perd_son_separateur_final() {
		assert_eq!(path_key("/tmp/projet/"), path_key("/tmp/projet"));
	}

	#[test]
	fn un_nom_qui_n_est_pas_un_programme_n_est_pas_joue() {
		assert_eq!(locate("x; rm -rf ~"), None);
		assert_eq!(locate(""), None);
	}

	#[test]
	fn une_adresse_de_fichier_a_trois_barres() {
		if cfg!(windows) {
			assert_eq!(file_url(std::path::Path::new(r"C:\a\b.html")), "file:///C:/a/b.html");
		} else {
			assert_eq!(file_url(std::path::Path::new("/a/b.html")), "file:///a/b.html");
		}
	}
}
