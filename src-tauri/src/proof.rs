//! La preuve filmée : ce qu'un agent a fait dans le navigateur de son
//! workspace, montée en courte vidéo à la fin de son tour.
//!
//! Les agents vérifient déjà leur travail à l'écran — environ 3 500 gestes de
//! navigateur en un mois sur le poste où l'idée est née — et tout cela se
//! perdait : il en restait au mieux une capture, souvent rien. Or le cockpit
//! reçoit déjà chaque image de la page (le flux que montre l'onglet Navigateur,
//! voir `browser.rs`). Il suffit d'en garder une partie pendant que l'agent
//! pilote, et d'en faire un film quand il rend la main.
//!
//! Trois règles :
//! - **Rien n'est lancé pour filmer.** On ne s'accroche qu'à un navigateur qui
//!   tourne déjà, parce que l'agent vient de s'en servir.
//! - **Le temps mort se comprime.** Une page immobile n'envoie pas d'image ; et
//!   entre deux images, on ne garde jamais plus de `MAX_HOLD` à l'écran. Vingt
//!   minutes de recette tiennent en quelques dizaines de secondes.
//! - **Sans ffmpeg, pas de vidéo, et on le dit** une fois au journal : les images
//!   restent sur le disque, le compte rendu n'en souffre pas.

use crate::config::config_dir;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Au plus cinq images par seconde : une recette se suit, elle ne se regarde
/// pas au ralenti, et un tour de vingt minutes ne doit pas peser un gigaoctet.
const MIN_GAP: Duration = Duration::from_millis(200);

/// Le plus long qu'une image reste à l'écran dans le film.
const MAX_HOLD: f64 = 1.6;

/// En dessous, il ne s'est rien passé qui vaille un film.
const MIN_FRAMES: usize = 4;

/// Au-delà, on arrête d'enregistrer : la fin d'un très long tour se perd, mais
/// le disque ne se remplit pas.
const MAX_FRAMES: usize = 2400;

struct Recording {
	dir: PathBuf,
	/// La session de l'agent qui a lancé l'enregistrement : c'est son tour qui
	/// le referme, pas celui d'un voisin du même workspace.
	session: String,
	started: Instant,
	last: Option<Instant>,
	/// Chaque image gardée, et l'instant où elle est arrivée.
	frames: Vec<(PathBuf, Duration)>,
	/// Les adresses traversées, pour chapitrer le film.
	urls: Vec<(Duration, String)>,
}

fn recordings() -> &'static Mutex<HashMap<String, Recording>> {
	static RECORDINGS: OnceLock<Mutex<HashMap<String, Recording>>> = OnceLock::new();
	RECORDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Où vivent les films : sous la configuration, donc sous `$HOME`, là où
/// l'interface sait lire un fichier par `asset://` sans détour.
pub fn root() -> PathBuf {
	config_dir().join("preuves")
}

/// Un outil de cet agent touche-t-il au navigateur du workspace ?
pub fn is_browser_tool(name: &str) -> bool {
	name.starts_with(&format!("mcp__{}__", crate::browser::SERVER))
}

/// L'agent vient de toucher au navigateur : on commence à garder ses images.
///
/// Rien ne se lance : un navigateur éteint ne se filme pas. Appelé à chaque
/// geste, sans coût une fois l'enregistrement ouvert.
pub async fn touch(browsers: crate::browser::SharedBrowsers, cwd: &str, session: &str) {
	if recordings().lock().unwrap().contains_key(cwd) {
		return;
	}
	// Le premier geste démarre le navigateur ; laissons-lui le temps de
	// répondre avant de conclure qu'il n'y en a pas.
	let mut alive = false;
	for _ in 0..20 {
		if crate::browser::running(cwd).await {
			alive = true;
			break;
		}
		tokio::time::sleep(Duration::from_millis(250)).await;
	}
	if !alive {
		return;
	}
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|elapsed| elapsed.as_millis())
		.unwrap_or(0);
	let dir = root().join(crate::mcp::key_of(cwd)).join(stamp.to_string());
	if std::fs::create_dir_all(&dir).is_err() {
		return;
	}
	{
		let mut map = recordings().lock().unwrap();
		if map.contains_key(cwd) {
			return;
		}
		map.insert(
			cwd.to_string(),
			Recording {
				dir,
				session: session.to_string(),
				started: Instant::now(),
				last: None,
				frames: Vec::new(),
				urls: Vec::new(),
			},
		);
	}
	// Le flux d'images ne tourne que si quelqu'un regarde : on s'y branche, sans
	// rien lancer puisque le navigateur répond déjà.
	let _ = crate::browser::watch(browsers, cwd.to_string()).await;
}

/// Une image de la page est arrivée (appelé par le flux de `browser.rs`).
pub fn frame(cwd: &str, jpeg: &[u8], url: &str) {
	let mut map = recordings().lock().unwrap();
	let Some(recording) = map.get_mut(cwd) else { return };
	let now = Instant::now();
	if recording.last.is_some_and(|last| now.duration_since(last) < MIN_GAP) {
		return;
	}
	if recording.frames.len() >= MAX_FRAMES {
		return;
	}
	let at = now.duration_since(recording.started);
	let path = recording.dir.join(format!("{:05}.jpg", recording.frames.len()));
	if std::fs::write(&path, jpeg).is_err() {
		return;
	}
	recording.last = Some(now);
	recording.frames.push((path, at));
	if recording.urls.last().map(|(_, last)| last.as_str()) != Some(url) {
		recording.urls.push((at, url.to_string()));
	}
}

/// Ce que rend un film monté.
pub struct Film {
	pub path: PathBuf,
	pub seconds: f64,
	pub frames: usize,
	/// Les adresses traversées, avec leur instant dans le film.
	pub chapters: Vec<(f64, String)>,
}

/// Le tour de cet agent est fini : on referme son enregistrement et on monte
/// le film. `None` quand il n'y avait rien, ou trop peu, ou pas d'ffmpeg.
pub async fn finish(cwd: &str, session: &str) -> Option<Film> {
	let recording = {
		let mut map = recordings().lock().unwrap();
		if map.get(cwd).map(|recording| recording.session.as_str()) != Some(session) {
			return None;
		}
		map.remove(cwd)?
	};
	if recording.frames.len() < MIN_FRAMES {
		let _ = std::fs::remove_dir_all(&recording.dir);
		return None;
	}
	tokio::task::spawn_blocking(move || assemble(recording)).await.ok().flatten()
}

/// Oublie un enregistrement sans le monter : l'agent est arrêté.
pub fn drop_for(session: &str) {
	let mut map = recordings().lock().unwrap();
	let gone: Vec<String> = map
		.iter()
		.filter(|(_, recording)| recording.session == session)
		.map(|(cwd, _)| cwd.clone())
		.collect();
	for cwd in gone {
		if let Some(recording) = map.remove(&cwd) {
			let _ = std::fs::remove_dir_all(recording.dir);
		}
	}
}

fn ffmpeg() -> Option<String> {
	static FOUND: OnceLock<Option<String>> = OnceLock::new();
	FOUND
		.get_or_init(|| {
			// Lancé depuis le Finder, le cockpit n'a qu'un PATH minimal : même
			// recherche que pour `claude` (voir `agent::claude_binary`).
			if let Ok(output) = std::process::Command::new("zsh").arg("-lc").arg("command -v ffmpeg").output() {
				let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
				if !found.is_empty() && Path::new(&found).exists() {
					return Some(found);
				}
			}
			["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
				.into_iter()
				.find(|path| Path::new(path).exists())
				.map(str::to_string)
		})
		.clone()
}

/// La liste que lit ffmpeg : chaque image et le temps qu'elle reste, comprimé.
fn concat_list(frames: &[(PathBuf, Duration)]) -> (String, f64) {
	let mut list = String::from("ffconcat version 1.0\n");
	let mut total = 0.0;
	for (index, (path, at)) in frames.iter().enumerate() {
		let next = frames.get(index + 1).map(|(_, next)| *next).unwrap_or(*at + Duration::from_millis(1200));
		let hold = (next.saturating_sub(*at)).as_secs_f64().clamp(0.08, MAX_HOLD);
		total += hold;
		list.push_str(&format!("file '{}'\nduration {hold:.3}\n", path.to_string_lossy().replace('\'', "'\\''")));
	}
	// ffmpeg ignore la durée de la dernière entrée : on la répète pour qu'elle
	// reste à l'écran.
	if let Some((last, _)) = frames.last() {
		list.push_str(&format!("file '{}'\n", last.to_string_lossy().replace('\'', "'\\''")));
	}
	(list, total)
}

/// Le temps du film qui correspond à un instant de l'enregistrement.
fn film_time(frames: &[(PathBuf, Duration)], at: Duration) -> f64 {
	let mut time = 0.0;
	for (index, (_, frame_at)) in frames.iter().enumerate() {
		if *frame_at >= at {
			break;
		}
		let next = frames.get(index + 1).map(|(_, next)| *next).unwrap_or(*frame_at);
		time += (next.saturating_sub(*frame_at)).as_secs_f64().clamp(0.08, MAX_HOLD);
	}
	time
}

fn assemble(recording: Recording) -> Option<Film> {
	let Some(binary) = ffmpeg() else {
		static ANNONCE: OnceLock<()> = OnceLock::new();
		ANNONCE.get_or_init(|| {
			crate::journal::record(
				"agent",
				"Preuve filmée indisponible",
				"ffmpeg introuvable",
				false,
				"Les images de la recette sont gardées, mais aucune vidéo n'en est montée. \
				 Installe ffmpeg (`brew install ffmpeg`) pour la retrouver sous les conclusions.",
			);
		});
		return None;
	};
	let (list, seconds) = concat_list(&recording.frames);
	let list_path = recording.dir.join("images.ffconcat");
	std::fs::write(&list_path, list).ok()?;
	let output = recording.dir.join("preuve.mp4");
	let status = std::process::Command::new(binary)
		.args(["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
		.arg(&list_path)
		// Dimensions paires et couleurs 4:2:0 : ce que le lecteur du webview
		// accepte, quel que soit le cadre de la page.
		.args([
			"-vf",
			"scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
			"-r",
			"10",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"28",
			"-movflags",
			"+faststart",
		])
		.arg(&output)
		.status()
		.ok()?;
	if !status.success() || !output.exists() {
		return None;
	}
	// Les images ont servi : on ne garde que le film et la première, pour la
	// vignette d'un lecteur qui ne sait pas chercher une image.
	for (index, (path, _)) in recording.frames.iter().enumerate() {
		if index > 0 {
			let _ = std::fs::remove_file(path);
		}
	}
	let _ = std::fs::remove_file(&list_path);
	let chapters = recording
		.urls
		.iter()
		.map(|(at, url)| (film_time(&recording.frames, *at), url.clone()))
		.collect();
	Some(Film {
		path: output,
		seconds,
		frames: recording.frames.len(),
		chapters,
	})
}

/// Ce que l'interface reçoit à la fin d'un tour filmé.
pub fn event(film: &Film) -> serde_json::Value {
	json!({
		"type": "cockpit",
		"subtype": "preuve",
		"path": film.path.to_string_lossy(),
		"seconds": (film.seconds * 10.0).round() / 10.0,
		"frames": film.frames,
		"chapters": film
			.chapters
			.iter()
			.map(|(at, url)| json!({ "at": (at * 10.0).round() / 10.0, "url": url }))
			.collect::<Vec<_>>(),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn frames(seconds: &[f64]) -> Vec<(PathBuf, Duration)> {
		seconds
			.iter()
			.enumerate()
			.map(|(index, at)| (PathBuf::from(format!("/tmp/{index}.jpg")), Duration::from_secs_f64(*at)))
			.collect()
	}

	#[test]
	fn le_temps_mort_se_comprime() {
		// Une image, puis rien pendant dix minutes, puis deux images rapprochées.
		let (list, total) = concat_list(&frames(&[0.0, 600.0, 600.5]));
		assert!(list.starts_with("ffconcat version 1.0"));
		// 1,6 s pour l'attente, 0,5 s, puis 1,2 s bornée à 1,6 pour la dernière.
		assert!((total - (1.6 + 0.5 + 1.2)).abs() < 1e-6, "{total}");
		// La dernière image est répétée sans durée, comme ffmpeg l'attend.
		assert_eq!(list.matches("file '/tmp/2.jpg'").count(), 2);
	}

	#[test]
	fn un_chapitre_tombe_au_bon_instant_du_film() {
		let all = frames(&[0.0, 1.0, 300.0, 301.0]);
		// Une adresse vue à la troisième image : 1 s, puis 1,6 s comprimée.
		assert!((film_time(&all, Duration::from_secs(300)) - 2.6).abs() < 1e-6);
	}

	/// Contre le vrai ffmpeg : cinq images de couleur, un film qui se lit.
	#[test]
	#[ignore]
	fn monte_un_vrai_film() {
		let dir = std::env::temp_dir().join(format!("cockpit-preuve-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let binary = ffmpeg().expect("ffmpeg requis pour cet essai");
		let mut frames = Vec::new();
		for (index, color) in ["red", "green", "blue", "white", "black"].iter().enumerate() {
			let path = dir.join(format!("{index:05}.jpg"));
			let ok = std::process::Command::new(&binary)
				.args(["-y", "-loglevel", "error", "-f", "lavfi", "-i"])
				.arg(format!("color=c={color}:s=641x401"))
				.args(["-frames:v", "1"])
				.arg(&path)
				.status()
				.unwrap()
				.success();
			assert!(ok);
			frames.push((path, Duration::from_millis(index as u64 * 700)));
		}
		let film = assemble(Recording {
			dir: dir.clone(),
			session: "s".into(),
			started: Instant::now(),
			last: None,
			frames,
			urls: vec![(Duration::ZERO, "http://localhost:3000/".into())],
		})
		.expect("le film doit se monter");
		assert!(film.path.exists());
		assert!(std::fs::metadata(&film.path).unwrap().len() > 1000);
		assert_eq!(film.frames, 5);
		let _ = std::fs::remove_dir_all(dir);
	}

	#[test]
	fn seuls_les_gestes_du_navigateur_du_workspace_comptent() {
		assert!(is_browser_tool("mcp__navigateur__browser_click"));
		assert!(!is_browser_tool("mcp__playwright__browser_click"));
		assert!(!is_browser_tool("Bash"));
	}
}
