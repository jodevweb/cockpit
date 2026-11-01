//! Terminaux intégrés, adossés à un vrai pseudo-terminal.
//!
//! Le runner de jobs (`runner.rs`) suffit pour une commande qu'on lance et
//! qu'on regarde finir, mais il ferme l'entrée standard et n'alloue pas de TTY :
//! impossible d'interrompre un serveur de dev par ⌃C, de répondre à une
//! question, ou de voir une interface plein écran s'afficher correctement.
//! Ici on ouvre un shell de login derrière un PTY : ce qu'on tape descend dans
//! le terminal, ce qu'il écrit remonte à l'octet près.
//!
//! Les octets ne remontent pas en texte : une lecture peut couper un caractère
//! multi-octets en deux, et une chaîne UTF-8 invalide ne franchit pas le pont
//! JSON. On encode donc chaque bloc en base64, l'émulateur côté interface se
//! charge du réassemblage.

use crate::error::{CockpitError, Result};
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static TERMINAL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Taille de départ, remplacée par la vraie dès que l'onglet est affiché.
/// Un shell lancé sur 80×24 ne gêne pas : rien n'est encore visible.
const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
	pub id: String,
	pub cwd: String,
	pub label: String,
	pub running: bool,
	pub started_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalChunk {
	pub id: String,
	/// Sortie brute encodée en base64 — voir l'en-tête du module.
	pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
	pub id: String,
	pub code: Option<i32>,
}

struct Running {
	info: TerminalInfo,
	/// Processus du shell, racine de tout ce qu'il fait tourner.
	pid: Option<u32>,
	writer: Box<dyn Write + Send>,
	master: Box<dyn MasterPty + Send>,
	killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalRegistry {
	sessions: Mutex<HashMap<String, Running>>,
}

pub type SharedTerminals = Arc<TerminalRegistry>;

impl TerminalRegistry {
	/// Processus racine de chaque shell vivant : identifiant, dossier, pid.
	pub fn roots(&self) -> Vec<(String, String, u32)> {
		let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
		sessions
			.values()
			.filter(|running| running.info.running)
			.filter_map(|running| {
				running
					.pid
					.map(|pid| (running.info.id.clone(), running.info.cwd.clone(), pid))
			})
			.collect()
	}

	pub fn snapshot(&self) -> Vec<TerminalInfo> {
		let sessions = self.sessions.lock().unwrap();
		let mut list: Vec<TerminalInfo> = sessions.values().map(|s| s.info.clone()).collect();
		list.sort_by_key(|info| info.started_at);
		list
	}
}

/// Shell de login de l'utilisateur, avec repli sur zsh.
///
/// `$SHELL` n'est pas transmis à une app lancée depuis le Finder : on lit donc
/// la base des utilisateurs, comme le fait Terminal.app. Réponse mise en cache,
/// parce que `dscl` coûte quelques dizaines de millisecondes et que la commande
/// d'ouverture, elle, s'exécute sur le fil principal.
fn login_shell() -> String {
	static RESOLVED: OnceLock<String> = OnceLock::new();
	RESOLVED
		.get_or_init(|| {
			if let Ok(shell) = std::env::var("SHELL") {
				if !shell.trim().is_empty() && std::path::Path::new(&shell).exists() {
					return shell;
				}
			}

			let user = std::env::var("USER").unwrap_or_default();
			if !user.is_empty() {
				if let Ok(output) = std::process::Command::new("dscl")
					.args([".", "-read", &format!("/Users/{user}"), "UserShell"])
					.output()
				{
					let text = String::from_utf8_lossy(&output.stdout);
					if let Some(shell) = text.split_whitespace().nth(1) {
						if std::path::Path::new(shell).exists() {
							return shell.to_string();
						}
					}
				}
			}

			"/bin/zsh".to_string()
		})
		.clone()
}

/// Ouvre un terminal dans `cwd` et renvoie sa fiche.
///
/// `command` est tapée dans le shell une fois celui-ci prêt, plutôt que lancée
/// à sa place : quand `pnpm dev` s'arrête, on garde un shell utilisable au lieu
/// d'un onglet mort.
///
/// `account` force le compte du shell — c'est ce dont a besoin l'écran des
/// réglages pour ouvrir une connexion sur un compte qu'aucun projet n'utilise
/// encore. Absent, on prend celui du projet ouvert, qui est ce qu'on attend
/// d'un terminal lancé depuis un écran de travail.
pub fn open(
	app: AppHandle,
	terminals: SharedTerminals,
	cwd: String,
	command: Option<String>,
	label: Option<String>,
	cols: Option<u16>,
	rows: Option<u16>,
	account: Option<String>,
) -> Result<TerminalInfo> {
	if !std::path::Path::new(&cwd).is_dir() {
		return Err(CockpitError::msg(format!("Dossier introuvable : {cwd}")));
	}

	let id = format!("term-{}", TERMINAL_SEQUENCE.fetch_add(1, Ordering::SeqCst));
	let size = PtySize {
		cols: cols.unwrap_or(DEFAULT_COLS),
		rows: rows.unwrap_or(DEFAULT_ROWS),
		pixel_width: 0,
		pixel_height: 0,
	};

	let pair = native_pty_system()
		.openpty(size)
		.map_err(|e| CockpitError::msg(format!("Ouverture du terminal : {e}")))?;

	let shell = login_shell();
	let mut builder = CommandBuilder::new(&shell);
	// Shell de login : c'est lui qui charge le PATH de l'utilisateur (Homebrew,
	// mise, nvm), sans quoi `pnpm` reste introuvable pour une app lancée depuis
	// le Finder.
	builder.arg("-l");
	builder.cwd(&cwd);
	builder.env("TERM", "xterm-256color");
	builder.env("COLORTERM", "truecolor");
	builder.env("COCKPIT_TERMINAL", "1");
	// Le compte du projet ouvert, pour que le `claude` qu'on tape ici soit la
	// même personne que celui que le cockpit lance. Sans ça, un terminal ouvert
	// sur le dépôt de l'employeur repartait sous le compte personnel — sans rien
	// dire, et avec les quotas de l'autre.
	let mut config = crate::config::Config::active();
	if let Some(account) = account.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
		config.account = account.to_string();
	}
	for (name, value) in crate::config::account_env(&config) {
		builder.env(name, value);
	}

	let child = pair
		.slave
		.spawn_command(builder)
		.map_err(|e| CockpitError::msg(format!("Lancement du shell {shell} : {e}")))?;
	// L'esclave n'a plus lieu d'être ouvert ici : le garder empêcherait la
	// lecture de voir la fin de flux quand le shell se termine.
	drop(pair.slave);

	let reader = pair
		.master
		.try_clone_reader()
		.map_err(|e| CockpitError::msg(format!("Lecture du terminal : {e}")))?;
	let writer = pair
		.master
		.take_writer()
		.map_err(|e| CockpitError::msg(format!("Écriture du terminal : {e}")))?;
	let killer = child.clone_killer();
	// Relevé maintenant : une fois le processus terminé, `portable-pty` ne le
	// donne plus, et c'est justement ce qui tourne encore qu'on veut mesurer.
	let pid = child.process_id();

	let info = TerminalInfo {
		id: id.clone(),
		cwd: cwd.clone(),
		label: label.unwrap_or_else(|| {
			std::path::Path::new(&cwd)
				.file_name()
				.map(|name| name.to_string_lossy().to_string())
				.unwrap_or_else(|| "terminal".into())
		}),
		running: true,
		started_at: chrono::Utc::now().timestamp(),
	};

	terminals.sessions.lock().unwrap().insert(
		id.clone(),
		Running {
			info: info.clone(),
			pid,
			writer,
			master: pair.master,
			killer,
		},
	);

	spawn_reader(app.clone(), id.clone(), reader);
	spawn_waiter(app, terminals.clone(), id.clone(), child);

	if let Some(command) = command.filter(|c| !c.trim().is_empty()) {
		write(&terminals, &id, &format!("{}\r", command.trim()))?;
	}

	Ok(info)
}

/// Remonte la sortie du terminal, bloc par bloc.
///
/// Un thread système et non une tâche async : la lecture d'un PTY est bloquante
/// et n'a pas d'équivalent non bloquant portable.
fn spawn_reader(app: AppHandle, id: String, mut reader: Box<dyn Read + Send>) {
	std::thread::spawn(move || {
		let mut buffer = [0u8; 8192];
		loop {
			match reader.read(&mut buffer) {
				Ok(0) | Err(_) => break,
				Ok(count) => {
					let data = base64::engine::general_purpose::STANDARD.encode(&buffer[..count]);
					let _ = app.emit("terminal://output", TerminalChunk { id: id.clone(), data });
				}
			}
		}
	});
}

/// Attend la fin du shell pour retirer le terminal du registre.
fn spawn_waiter(
	app: AppHandle,
	terminals: SharedTerminals,
	id: String,
	mut child: Box<dyn portable_pty::Child + Send + Sync>,
) {
	std::thread::spawn(move || {
		let code = child.wait().ok().map(|status| status.exit_code() as i32);
		terminals.sessions.lock().unwrap().remove(&id);
		let _ = app.emit("terminal://exit", TerminalExit { id, code });
	});
}

pub fn write(terminals: &SharedTerminals, id: &str, data: &str) -> Result<()> {
	let mut sessions = terminals.sessions.lock().unwrap();
	let running = sessions
		.get_mut(id)
		.ok_or_else(|| CockpitError::msg("Ce terminal n'est plus actif."))?;
	running
		.writer
		.write_all(data.as_bytes())
		.and_then(|_| running.writer.flush())
		.map_err(|e| CockpitError::msg(format!("Écriture dans le terminal : {e}")))
}

/// Aligne le PTY sur la taille réellement affichée.
///
/// Sans ça le shell continue de croire à un écran de 100 colonnes : les lignes
/// se replient au mauvais endroit et tout affichage plein écran est décalé.
pub fn resize(terminals: &SharedTerminals, id: &str, cols: u16, rows: u16) -> Result<()> {
	let sessions = terminals.sessions.lock().unwrap();
	let Some(running) = sessions.get(id) else {
		// Un redimensionnement qui arrive après la fin du shell n'est pas une
		// erreur à remonter : la fenêtre a simplement bougé trop tard.
		return Ok(());
	};
	running
		.master
		.resize(PtySize {
			cols: cols.max(2),
			rows: rows.max(2),
			pixel_width: 0,
			pixel_height: 0,
		})
		.map_err(|e| CockpitError::msg(format!("Redimensionnement : {e}")))
}

/// Coupe le shell, puis ce qu'il a lâché derrière lui.
///
/// Libérer le master envoie un SIGHUP à la session, et c'est ce sur quoi on
/// comptait pour emporter la descendance. Un serveur de développement ne s'y
/// laisse pas prendre : `next`, `vite` et consorts gèrent leurs signaux, et
/// plusieurs s'affranchissent de la session en s'en créant une. Ils survivaient
/// donc à la fermeture, réattachés à `init`, tenant leur port et leurs
/// gigaoctets — on en a compté huit sur un poste, pour vingt et un gigaoctets,
/// dans des workspaces refermés depuis longtemps.
///
/// On vise donc le groupe de processus, comme pour les jobs : `kill -TERM -pid`
/// touche tout ce que le shell a engendré, y compris ce qui ignore le SIGHUP.
fn reap(running: &mut Running) {
	if let Some(pid) = running.pid {
		// L'arbre se relève avant de frapper : un serveur qui s'est détaché en
		// se créant sa propre session n'est plus dans le groupe du shell, et le
		// `kill -pid` ne le touche pas. C'est précisément celui qui survivait.
		let descendants = descendants_of(pid);
		let _ = std::process::Command::new("kill")
			.args(["-TERM", &format!("-{pid}")])
			.status();
		for enfant in descendants {
			let _ = std::process::Command::new("kill")
				.args(["-TERM", &enfant.to_string()])
				.status();
		}
	}
	let _ = running.killer.kill();
}

/// Tous les processus qui descendent de celui-ci, à n'importe quelle profondeur.
///
/// `pgrep -P` ne donne que les enfants directs ; une chaîne
/// `pnpm → turbo → bun → node` en compte quatre, et seul le dernier tient les
/// gigaoctets. On descend donc jusqu'au bout, avec une borne : un cycle est
/// impossible sur des pid, mais une arborescence pathologique ne doit pas faire
/// tourner cette boucle indéfiniment.
fn descendants_of(pid: u32) -> Vec<u32> {
	let mut trouves = Vec::new();
	let mut a_visiter = vec![pid];
	for _ in 0..64 {
		let Some(courant) = a_visiter.pop() else { break };
		let Ok(sortie) = std::process::Command::new("pgrep")
			.args(["-P", &courant.to_string()])
			.output()
		else {
			continue;
		};
		for ligne in String::from_utf8_lossy(&sortie.stdout).lines() {
			if let Ok(enfant) = ligne.trim().parse::<u32>() {
				if !trouves.contains(&enfant) {
					trouves.push(enfant);
					a_visiter.push(enfant);
				}
			}
		}
	}
	// Les plus profonds d'abord : couper un parent avant ses enfants les rend
	// orphelins, et c'est exactement ce qu'on cherche à éviter.
	trouves.reverse();
	trouves
}

pub fn close(terminals: &SharedTerminals, id: &str) -> Result<()> {
	let mut sessions = terminals.sessions.lock().unwrap();
	if let Some(mut running) = sessions.remove(id) {
		reap(&mut running);
		drop(running.master);
	}
	Ok(())
}

/// Ferme tous les terminaux — appelé à la fermeture du cockpit.
///
/// Même raison que pour les agents : une fois l'interface fermée, plus personne
/// ne lit ni ne pilote ces shells. Les laisser vivre ne produirait que des
/// serveurs de dev fantômes tenant leurs ports.
pub fn close_all(terminals: &SharedTerminals) {
	let mut sessions = terminals.sessions.lock().unwrap();
	for (_, mut running) in sessions.drain() {
		reap(&mut running);
		drop(running.master);
	}
}
