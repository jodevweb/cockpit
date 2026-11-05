//! Des agents qui survivent à la fenêtre du cockpit.
//!
//! Un agent était un processus enfant de l'app, branché sur elle par trois
//! tuyaux : fermer le cockpit — ou le mettre à jour, ce qui revient au même —
//! le tuait en plein travail. Sur un mois de relevé, 54 agents coupés ainsi, 64
//! reprises « le cockpit vient de redémarrer », dont 18 ratées sur une session
//! expirée : à chaque version publiée, tout le monde repartait de zéro.
//!
//! Un relais remplace les tuyaux par des fichiers. Le CLI lit son entrée dans
//! `in.jsonl`, que suit un `tail -f`, et écrit sa sortie dans `out.jsonl` ; le
//! cockpit ajoute des lignes à l'un et suit l'autre. Rien ne relie plus la vie
//! du processus à celle de l'app : macOS le rattache à launchd quand elle
//! meurt, et le cockpit suivant reprend la lecture là où elle en est.
//!
//! Pas de démon à installer, pas de binaire de plus : un shell, `tail` et deux
//! fichiers. C'est volontairement le minimum, parce qu'un mécanisme qui
//! tourne quand l'app est fermée est précisément celui qu'on ne voit pas
//! tomber en panne.
//!
//! Périmètre volontairement étroit, décidé avec l'utilisateur : seuls les
//! agents de workspace lancés à la main sont détachés. Missions, Permanence,
//! revue, autres moteurs et conteneurs gardent leurs tuyaux — eux ont déjà
//! leur propre reprise, et la doubler d'une seconde ferait tourner deux
//! maîtres sur la même mission.

use crate::config::config_dir;
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Le dossier où vit chaque relais, un sous-dossier par agent.
pub fn root() -> PathBuf {
	config_dir().join("relais")
}

/// Ce qu'on retient d'un relais pour le retrouver au démarrage suivant.
///
/// Écrit au lancement, réécrit quand la conversation du CLI est connue : c'est
/// par elle que l'écran relit l'historique d'un agent retrouvé, faute de quoi
/// il rouvrirait sur un fil vide.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Meta {
	pub session_id: String,
	pub cwd: String,
	/// L'exécution que cet agent alimente : c'est la même qui continue après un
	/// redémarrage, pas une nouvelle — un agent qui a survécu n'a pas été relancé.
	pub execution: String,
	pub claude_session_id: Option<String>,
	/// Le groupe de processus du relais : le shell, `tail`, le CLI et ce qu'il
	/// lance. On le tue en entier, jamais seulement le CLI — un `tail -f` laissé
	/// derrière ne finirait jamais.
	pub pgid: i32,
	pub at: String,
	/// Posé quand un cockpit s'est fermé en le laissant tourner.
	pub detached_at: Option<String>,
}

/// Un relais vivant, tel que le registre des agents le tient.
#[derive(Debug, Clone)]
pub struct Handle {
	pub dir: PathBuf,
	pub pgid: i32,
}

impl Handle {
	pub fn input(&self) -> PathBuf {
		self.dir.join("in.jsonl")
	}
}

fn meta_path(dir: &Path) -> PathBuf {
	dir.join("meta.json")
}

pub fn read_meta(dir: &Path) -> Option<Meta> {
	let raw = std::fs::read_to_string(meta_path(dir)).ok()?;
	serde_json::from_str(&raw).ok()
}

fn write_meta(dir: &Path, meta: &Meta) {
	if let Ok(raw) = serde_json::to_string_pretty(meta) {
		// Écrit à côté puis renommé : un cockpit tué en pleine écriture ne doit
		// pas laisser un relais vivant qu'on ne saurait plus relire.
		let tmp = dir.join("meta.json.tmp");
		if std::fs::write(&tmp, raw).is_ok() {
			let _ = std::fs::rename(tmp, meta_path(dir));
		}
	}
}

/// Retouche la fiche d'un relais, s'il existe encore.
pub fn update_meta(dir: &Path, change: impl FnOnce(&mut Meta)) {
	if let Some(mut meta) = read_meta(dir) {
		change(&mut meta);
		write_meta(dir, &meta);
	}
}

// ───────────────────────────── Le réglage ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Setting {
	/// Les agents de workspace continuent-ils quand le cockpit se ferme ?
	pub enabled: bool,
}

impl Default for Setting {
	fn default() -> Self {
		// Vrai par défaut : c'est le comportement qu'on attend d'un outil qui se
		// met à jour presque chaque jour. Le couper rend l'ancien, intact.
		Setting { enabled: true }
	}
}

fn setting_path() -> PathBuf {
	config_dir().join("relais.json")
}

/// Le réglage du poste — pas du projet : c'est la machine qui garde des
/// processus vivants, quel que soit le dépôt sur lequel ils travaillent.
pub fn setting() -> Setting {
	std::fs::read_to_string(setting_path())
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

pub fn save_setting(setting: &Setting) -> Result<()> {
	std::fs::create_dir_all(config_dir())?;
	let raw = serde_json::to_string_pretty(setting)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("relay.settingUnreadable", &[("error", &e)])))?;
	std::fs::write(setting_path(), raw)?;
	Ok(())
}

// ───────────────────────────── Le lancement ─────────────────────────────

fn quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// Le script qui porte un agent détaché.
///
/// La commande tourne dans un sous-shell : un `exit` écrit dedans — ou par
/// le moteur lui-même — ne doit pas emporter le shell avant qu'il ait noté le
/// code de sortie.
///
/// `tail -f` tient l'entrée du CLI ouverte pour toujours : un tuyau se
/// fermerait avec l'app, et le CLI s'arrêterait sur sa fin d'entrée. La
/// substitution de processus plutôt qu'un `|` : le shell n'attend pas un
/// `tail` qui, lui, ne finit jamais — on écrit le code de sortie dès que le CLI
/// rend la main, puis on emporte tout le groupe, `tail` compris.
///
/// Le script tient en bash comme en zsh : sous Windows, c'est le bash de Git
/// for Windows qui le joue (voir `platform::shell_program`). Les chemins y
/// passent avec des `/`, que MSYS lit sans conversion douteuse.
///
/// Sous Windows, `kill -TERM -$$` vise le groupe tel que MSYS l'émule : il
/// atteint `tail` (un programme MSYS), mais rien ne garantit qu'il atteigne un
/// programme Windows natif. On tue donc d'abord `tail` par son pid — en bash,
/// `$!` désigne la substitution de processus, que `exec` a remplacée par
/// `tail`. Le CLI, lui, a déjà rendu la main à ce stade.
fn script(dir: &Path, command: &str) -> String {
	let at = |name: &str| quote(&crate::platform::display_path(&dir.join(name)));
	let stop_tail = if cfg!(windows) { "kill -TERM $! 2>/dev/null\n" } else { "" };
	format!(
		"( {command}
) < <(exec tail -n +1 -f {input}) > {output} 2> {error}\n\
		 code=$?\n\
		 printf '%s\\n' \"$code\" > {exit_tmp} && mv {exit_tmp} {exit}\n\
		 {stop_tail}\
		 kill -TERM -$$ 2>/dev/null\n",
		input = at("in.jsonl"),
		output = at("out.jsonl"),
		error = at("err.log"),
		exit_tmp = at("exit.tmp"),
		exit = at("exit"),
	)
}

/// Lance `command` détaché, dans `cwd`, et rend son relais.
///
/// `command` est la même ligne que celle qu'un lancement à tuyaux passerait à
/// `zsh -lc` ; l'environnement aussi est le même. Seul change ce qui relie le
/// processus au cockpit.
pub fn spawn(
	session_id: &str,
	cwd: &str,
	command: &str,
	env_vars: &[(String, String)],
	env_removals: &[String],
	execution: &str,
) -> Result<Handle> {
	spawn_in(&root(), session_id, cwd, command, env_vars, env_removals, execution)
}

/// Même chose, sous un dossier donné — c'est ce qui rend le relais testable
/// sans toucher à celui du poste.
pub fn spawn_in(
	base: &Path,
	session_id: &str,
	cwd: &str,
	command: &str,
	env_vars: &[(String, String)],
	env_removals: &[String],
	execution: &str,
) -> Result<Handle> {
	let dir = base.join(session_id);
	std::fs::create_dir_all(&dir)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("relay.dir", &[("error", &e)])))?;
	// Créés d'avance : `tail -f` doit trouver son fichier, et le lecteur le sien,
	// avant même que le CLI ait écrit quoi que ce soit.
	for name in ["in.jsonl", "out.jsonl", "err.log"] {
		std::fs::OpenOptions::new()
			.create(true)
			.append(true)
			.open(dir.join(name))
			.map_err(|e| CockpitError::msg(crate::i18n::tf("relay.file", &[("error", &e)])))?;
	}

	let mut launcher = crate::platform::shell(&script(&dir, command));
	launcher
		.current_dir(cwd)
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null());
	// Son propre groupe : on le tue en entier, et il ne reçoit pas les
	// signaux destinés à l'app. Sous Windows, un groupe de processus à part,
	// sans console : rien ne le relie à la vie de l'app, qui peut se fermer
	// sans l'emporter.
	crate::platform::detach_std(&mut launcher);
	for (name, value) in env_vars {
		launcher.env(name, value);
	}
	for name in env_removals {
		launcher.env_remove(name);
	}

	let child = launcher
		.spawn()
		.map_err(|e| CockpitError::msg(crate::i18n::tf("relay.launch", &[("error", &e)])))?;
	let pgid = child.id() as i32;
	// On ne l'attend pas, et on ne garde pas son `Child` : c'est tout le
	// principe. Un fil récupère son code de sortie pour ne pas laisser de
	// processus zombie tant que l'app vit ; après elle, launchd s'en charge
	// (Windows n'a pas de zombies).
	std::thread::spawn(move || {
		let mut child = child;
		let _ = child.wait();
	});

	write_meta(
		&dir,
		&Meta {
			session_id: session_id.to_string(),
			cwd: cwd.to_string(),
			execution: execution.to_string(),
			claude_session_id: None,
			pgid,
			at: chrono::Utc::now().to_rfc3339(),
			detached_at: None,
		},
	);

	Ok(Handle { dir, pgid })
}

/// Le groupe a-t-il encore un processus vivant ?
pub fn alive(pgid: i32) -> bool {
	// 1 n'est jamais le groupe d'un relais (c'est launchd), et `kill(-1, …)`
	// viserait tous les processus du compte : une fiche abîmée ou retouchée ne
	// doit pas pouvoir y conduire.
	if pgid <= 1 {
		return false;
	}
	// Signal 0 : ne fait rien, dit seulement si quelqu'un l'aurait reçu. Sous
	// Windows, le chef du groupe — le shell — est-il encore là ?
	crate::platform::group_alive(pgid)
}

/// Écrit une ligne à l'agent.
///
/// En ajout seul : `tail -f` lit ce qui arrive en bout de fichier, et une
/// écriture courte en `O_APPEND` ne se mêle pas à une autre.
pub fn write(handle: &Handle, data: &str) -> std::io::Result<()> {
	let mut file = std::fs::OpenOptions::new()
		.append(true)
		.open(handle.input())?;
	file.write_all(data.as_bytes())?;
	file.flush()
}

/// Arrête un relais pour de bon : le groupe entier, puis son dossier.
///
/// `TERM` d'abord, pour laisser le CLI fermer proprement sa session, puis
/// `KILL` à qui traînerait. Le dossier part en dernier : effacé avant, le
/// lecteur conclurait trop tôt.
pub fn kill(handle: &Handle) {
	let pgid = handle.pgid;
	let dir = handle.dir.clone();
	if pgid > 1 {
		crate::platform::terminate_group(pgid);
	}
	std::thread::spawn(move || {
		for _ in 0..20 {
			if !alive(pgid) {
				break;
			}
			std::thread::sleep(Duration::from_millis(100));
		}
		if alive(pgid) {
			crate::platform::kill_group(pgid);
		}
		let _ = std::fs::remove_dir_all(dir);
	});
}

/// Le relais est-il fini — son CLI a-t-il rendu un code de sortie ?
pub fn exited(dir: &Path) -> bool {
	dir.join("exit").exists()
}

// ───────────────────────────── La lecture ─────────────────────────────

/// Suit un fichier qui grandit, ligne par ligne.
///
/// Par sondage, toutes les 60 ms : un événement disque serait plus réactif,
/// mais ajouterait une dépendance pour un gain qu'un œil ne voit pas — et un
/// agent qui écrit une ligne toutes les quelques secondes ne mérite pas plus.
pub struct Tail {
	path: PathBuf,
	dir: PathBuf,
	pos: u64,
	partial: Vec<u8>,
	ready: VecDeque<String>,
}

const POLL: Duration = Duration::from_millis(60);

impl Tail {
	/// Depuis le début : un agent qu'on vient de lancer.
	pub fn from_start(dir: &Path, name: &str) -> Self {
		Tail {
			path: dir.join(name),
			dir: dir.to_path_buf(),
			pos: 0,
			partial: Vec::new(),
			ready: VecDeque::new(),
		}
	}

	/// Depuis la fin actuelle : un agent retrouvé, dont l'historique se relit
	/// par sa session — rejouer le fichier afficherait tout en double.
	pub fn from_end(dir: &Path, name: &str) -> Self {
		let mut tail = Self::from_start(dir, name);
		tail.pos = std::fs::metadata(&tail.path).map(|meta| meta.len()).unwrap_or(0);
		tail
	}

	/// Ce qui est arrivé depuis la dernière lecture, découpé en lignes.
	fn pull(&mut self) -> bool {
		let Ok(mut file) = std::fs::File::open(&self.path) else {
			return false;
		};
		if file.seek(SeekFrom::Start(self.pos)).is_err() {
			return false;
		}
		let mut chunk = Vec::new();
		let Ok(read) = file.read_to_end(&mut chunk) else {
			return false;
		};
		if read == 0 {
			return false;
		}
		self.pos += read as u64;
		self.partial.extend_from_slice(&chunk);
		while let Some(end) = self.partial.iter().position(|&byte| byte == b'\n') {
			let line: Vec<u8> = self.partial.drain(..=end).collect();
			let text = String::from_utf8_lossy(&line[..line.len() - 1]).to_string();
			self.ready.push_back(text);
		}
		true
	}

	/// La ligne suivante, ou `None` quand le relais est fini et tout lu — ou
	/// qu'on l'a arrêté, ce qui efface son dossier.
	pub async fn next_line(&mut self) -> Option<String> {
		loop {
			if let Some(line) = self.ready.pop_front() {
				return Some(line);
			}
			if self.pull() {
				continue;
			}
			if !self.dir.exists() {
				return None;
			}
			if exited(&self.dir) {
				// Une dernière lecture : le CLI a pu écrire entre notre sondage
				// et l'apparition du code de sortie.
				if self.pull() {
					continue;
				}
				if !self.partial.is_empty() {
					let rest = std::mem::take(&mut self.partial);
					return Some(String::from_utf8_lossy(&rest).to_string());
				}
				return None;
			}
			tokio::time::sleep(POLL).await;
		}
	}
}

/// Le dernier tour était-il fini au moment où on le retrouve ?
///
/// Lu sur la sortie elle-même : un `result` quand le CLI a rendu la main. C'est
/// ce qui dit à l'écran si l'agent retrouvé travaille encore ou attend qu'on lui
/// parle — et à la reprise suivante s'il faut le remettre au travail.
///
/// Deux sortes de lignes ne disent rien du tour, et sont sautées : les réponses
/// de contrôle (le relevé de contexte que l'écran demande) et les lignes
/// `system` — l'ouverture de session, les hooks du poste, qui s'écrivent aussi
/// après un `result`. Les prendre pour le dernier mot faisait passer pour « en
/// plein travail » un agent qui avait fini.
///
/// Un CLI qui n'a encore rien dit d'autre n'a fini aucun tour : il travaille si
/// on lui a écrit, il attend sinon. C'est le cas d'un agent rouvert sans
/// consigne — `--resume` sur une conversation close — que la reprise suivante
/// relançait sinon, persuadée qu'on l'avait coupé en plein tour.
pub fn turn_done(dir: &Path) -> bool {
	let Ok(raw) = std::fs::read_to_string(dir.join("out.jsonl")) else {
		return true;
	};
	let kind = |value: &serde_json::Value| {
		value.get("type").and_then(|kind| kind.as_str()).map(str::to_string)
	};
	let last = raw
		.lines()
		.rev()
		.filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
		.filter_map(|value| kind(&value))
		.find(|kind| kind != "control_response" && kind != "system");
	match last.as_deref() {
		Some("result") => true,
		Some(_) => false,
		None => !std::fs::read_to_string(dir.join("in.jsonl"))
			.unwrap_or_default()
			.lines()
			.filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
			.any(|value| kind(&value).as_deref() == Some("user")),
	}
}

// ───────────────────────────── Le démarrage ─────────────────────────────

/// Un relais trouvé sur le disque au démarrage.
#[derive(Debug, Clone)]
pub struct Found {
	pub meta: Meta,
	pub dir: PathBuf,
}

/// Les relais encore vivants : groupe debout, pas de code de sortie.
///
/// Ceux qui sont morts pendant l'absence du cockpit sont rendus à part, pour
/// que leur exécution se referme proprement et que leur dossier parte : la
/// reprise classique (`--resume`, voir `hibernate.tsx`) prend alors le relais.
pub fn scan() -> (Vec<Found>, Vec<Found>) {
	scan_in(&root())
}

pub fn scan_in(base: &Path) -> (Vec<Found>, Vec<Found>) {
	let mut living = Vec::new();
	let mut dead = Vec::new();
	let Ok(entries) = std::fs::read_dir(base) else {
		return (living, dead);
	};
	for entry in entries.flatten() {
		let dir = entry.path();
		if !dir.is_dir() {
			continue;
		}
		let Some(meta) = read_meta(&dir) else {
			// Sans fiche, on ne saurait ni à qui il appartient ni comment le
			// tuer : un dossier sans fiche est un reste, on le range.
			let _ = std::fs::remove_dir_all(&dir);
			continue;
		};
		let found = Found { meta, dir };
		if !exited(&found.dir) && alive(found.meta.pgid) {
			living.push(found);
		} else {
			dead.push(found);
		}
	}
	(living, dead)
}

/// Les agents retrouvés vivants au démarrage de cette session du cockpit.
///
/// Retenus pour l'écran, qui l'annonce une fois : un agent qui a continué
/// sans toi doit se savoir, sinon on le prend pour un agent qu'on vient de
/// rouvrir.
static SURVIVORS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn note_survivor(session_id: &str) {
	if let Ok(mut survivors) = SURVIVORS.lock() {
		survivors.push(session_id.to_string());
	}
}

pub fn survivors() -> Vec<String> {
	SURVIVORS.lock().map(|survivors| survivors.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn base() -> PathBuf {
		// Un compteur en plus de l'heure : deux tests lancés en parallèle dans la
		// même microseconde partageaient sinon le même dossier, et l'un voyait
		// le relais de l'autre.
		static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
		let dir = std::env::temp_dir().join(format!(
			"cockpit-relais-test-{}-{}-{}",
			std::process::id(),
			N.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
			chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
		));
		std::fs::create_dir_all(&dir).unwrap();
		dir
	}

	/// Ce que l'écran lit d'un relais retrouvé au démarrage : fini ou en plein
	/// tour. Les hooks et les relevés de contexte qui suivent un `result` ne
	/// rouvrent pas le tour ; un agent rouvert sans consigne n'en a aucun.
	#[test]
	fn le_tour_se_lit_sans_les_lignes_systeme() {
		let dir = base();
		let ecrire = |nom: &str, lignes: &[&str]| {
			std::fs::write(dir.join(nom), lignes.join("\n") + "\n").unwrap()
		};
		let fini = r#"{"type":"result","subtype":"success"}"#;
		let hook = r#"{"type":"system","subtype":"hook_response"}"#;
		let controle = r#"{"type":"control_response","response":{"subtype":"success"}}"#;
		let parle = r#"{"type":"assistant","message":{}}"#;
		let message = r#"{"type":"user","message":{"role":"user","content":"go"}}"#;
		let releve = r#"{"type":"control_request","request":{"subtype":"get_context_usage"}}"#;

		// Fini, puis des hooks et des relevés : toujours fini.
		ecrire("out.jsonl", &[parle, fini, hook, controle, controle]);
		assert!(turn_done(&dir));

		// En pleine réponse.
		ecrire("out.jsonl", &[fini, parle, hook]);
		assert!(!turn_done(&dir));

		// Rouvert sans consigne : l'ouverture de session, des relevés, rien d'autre.
		ecrire("out.jsonl", &[hook, hook, controle]);
		ecrire("in.jsonl", &[releve, releve]);
		assert!(turn_done(&dir));

		// Même début, mais un message est parti : le premier tour commence.
		ecrire("in.jsonl", &[releve, message]);
		assert!(!turn_done(&dir));

		let _ = std::fs::remove_dir_all(dir);
	}

	/// Un faux CLI : il répond à chaque ligne reçue par un objet JSON, et rend
	/// un `result` — de quoi éprouver le relais sans le vrai `claude`.
	/// En `printf` plutôt qu'en `print` : il doit tourner sous bash (Windows) comme
	/// sous zsh.
	const ECHO: &str = r#"while IFS= read -r line; do printf '%s\n' "{\"type\":\"assistant\",\"echo\":$line}"; printf '%s\n' '{"type":"result"}'; done"#;

	#[tokio::test]
	async fn un_relais_parle_survit_et_s_arrete() {
		let base = base();
		let cwd = std::env::temp_dir();
		let handle = spawn_in(
			&base,
			"agent-test",
			&cwd.to_string_lossy(),
			ECHO,
			&[],
			&[],
			"exec-test",
		)
		.unwrap();

		write(&handle, "{\"n\":1}\n").unwrap();
		let mut out = Tail::from_start(&handle.dir, "out.jsonl");
		let first = tokio::time::timeout(Duration::from_secs(5), out.next_line())
			.await
			.expect("la réponse arrive")
			.unwrap();
		assert!(first.contains("\"echo\":{\"n\":1}"), "{first}");
		let second = tokio::time::timeout(Duration::from_secs(5), out.next_line())
			.await
			.unwrap()
			.unwrap();
		assert!(second.contains("result"));
		assert!(turn_done(&handle.dir));

		// Le lecteur part, comme l'app qui se ferme : le relais, lui, reste là
		// et répond encore à qui reprend la lecture depuis la fin.
		drop(out);
		assert!(alive(handle.pgid));
		let (living, _) = scan_in(&base);
		assert_eq!(living.len(), 1);
		assert_eq!(living[0].meta.execution, "exec-test");

		let mut resumed = Tail::from_end(&handle.dir, "out.jsonl");
		write(&handle, "{\"n\":2}\n").unwrap();
		let again = tokio::time::timeout(Duration::from_secs(5), resumed.next_line())
			.await
			.unwrap()
			.unwrap();
		assert!(again.contains("\"echo\":{\"n\":2}"), "{again}");

		// Arrêt : tout le groupe tombe, `tail -f` compris, et le dossier part.
		kill(&handle);
		for _ in 0..50 {
			if !alive(handle.pgid) && !handle.dir.exists() {
				break;
			}
			std::thread::sleep(Duration::from_millis(100));
		}
		assert!(!alive(handle.pgid), "le groupe est mort");
		assert!(!handle.dir.exists(), "le dossier est effacé");
		let _ = std::fs::remove_dir_all(base);
	}

	#[tokio::test]
	async fn un_relais_fini_le_dit_et_se_ferme() {
		let base = base();
		let cwd = std::env::temp_dir();
		let handle = spawn_in(
			&base,
			"agent-court",
			&cwd.to_string_lossy(),
			"printf '%s\\n' '{\"type\":\"result\"}'; exit 3",
			&[],
			&[],
			"exec-court",
		)
		.unwrap();
		let mut out = Tail::from_start(&handle.dir, "out.jsonl");
		let line = tokio::time::timeout(Duration::from_secs(5), out.next_line())
			.await
			.unwrap()
			.unwrap();
		assert!(line.contains("result"));
		// Fin de flux : le code de sortie est écrit, et `tail -f` n'a pas
		// retenu le shell.
		let end = tokio::time::timeout(Duration::from_secs(5), out.next_line())
			.await
			.expect("le flux se ferme");
		assert!(end.is_none());
		assert_eq!(
			std::fs::read_to_string(handle.dir.join("exit")).unwrap().trim(),
			"3"
		);
		for _ in 0..30 {
			if !alive(handle.pgid) {
				break;
			}
			std::thread::sleep(Duration::from_millis(100));
		}
		assert!(!alive(handle.pgid), "tail ne survit pas au CLI");
		let (living, dead) = scan_in(&base);
		assert!(living.is_empty());
		assert_eq!(dead.len(), 1);
		let _ = std::fs::remove_dir_all(base);
	}

	/// Lance un relais et sort sans l'arrêter : c'est au shell qui a lancé le
	/// test de vérifier qu'il vit encore une fois ce processus-ci disparu —
	/// exactement ce qui arrive quand l'app se ferme.
	/// `cargo test relais_orphelin -- --ignored --nocapture`.
	#[tokio::test]
	#[ignore]
	async fn relais_orphelin() {
		let base = base();
		let cwd = std::env::temp_dir();
		let handle = spawn_in(&base, "agent-orphelin", &cwd.to_string_lossy(), ECHO, &[], &[], "exec").unwrap();
		println!("RELAIS pgid={} dir={}", handle.pgid, handle.dir.display());
	}

	/// Le vrai CLI, un tour, dans un dossier jetable. Lent et payant (quota) :
	/// `cargo test relais_claude -- --ignored`.
	#[tokio::test]
	#[ignore]
	async fn relais_claude_un_tour() {
		let Some(binary) = crate::agent::claude_binary() else {
			return;
		};
		let base = base();
		let cwd = base.join("chantier");
		std::fs::create_dir_all(&cwd).unwrap();
		let command = format!(
			"{} -p --input-format stream-json --output-format stream-json --verbose --model haiku",
			quote(&binary)
		);
		let handle = spawn_in(&base, "agent-claude", &cwd.to_string_lossy(), &command, &[], &[], "exec").unwrap();
		write(
			&handle,
			"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Réponds juste: ok\"}]}}\n",
		)
		.unwrap();
		let mut out = Tail::from_start(&handle.dir, "out.jsonl");
		let mut saw_result = false;
		let deadline = std::time::Instant::now() + Duration::from_secs(120);
		while std::time::Instant::now() < deadline {
			match tokio::time::timeout(Duration::from_secs(120), out.next_line()).await {
				Ok(Some(line)) => {
					if line.contains("\"type\":\"result\"") {
						saw_result = true;
						break;
					}
				}
				_ => break,
			}
		}
		assert!(saw_result, "le CLI a rendu un tour par le relais");
		assert!(alive(handle.pgid), "le CLI attend le tour suivant");
		kill(&handle);
		std::thread::sleep(Duration::from_secs(3));
		assert!(!alive(handle.pgid));
		let _ = std::fs::remove_dir_all(base);
	}
}
