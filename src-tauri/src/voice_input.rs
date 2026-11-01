//! L'oreille de l'assistant : le micro tant que le raccourci est maintenu,
//! puis la transcription par ElevenLabs (Scribe).
//!
//! Le micro ne s'ouvre qu'à la demande — raccourci enfoncé — et se referme au
//! relâchement : rien n'écoute en permanence. Le son est pris en natif plutôt
//! que par la page : la page ne reçoit pas le micro quand le cockpit est en
//! arrière-plan, or c'est justement là qu'un raccourci global sert.

use std::io::Cursor;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::error::{CockpitError, Result};

/// Au-delà, on coupe : une commande vocale tient en quelques secondes, un
/// raccourci resté enfoncé ne doit pas enregistrer la réunion d'à côté.
const MAX_SECONDS: u64 = 45;

/// En deçà, c'est un effleurement du raccourci, pas une phrase.
const MIN_SECONDS: f32 = 0.5;

struct Recorder {
	stop: mpsc::Sender<()>,
	thread: JoinHandle<()>,
	samples: Arc<Mutex<Vec<f32>>>,
	rate: Arc<Mutex<u32>>,
	failure: Arc<Mutex<Option<String>>>,
}

static RECORDER: Mutex<Option<Recorder>> = Mutex::new(None);

/// Ramène un bloc à une seule voie, en moyennant les canaux.
fn to_mono(data: &[f32], channels: usize, into: &Mutex<Vec<f32>>) {
	let Ok(mut samples) = into.lock() else { return };
	if channels <= 1 {
		samples.extend_from_slice(data);
		return;
	}
	for frame in data.chunks(channels) {
		samples.push(frame.iter().sum::<f32>() / frame.len() as f32);
	}
}

/// Ouvre le micro. Sans effet si l'on enregistre déjà.
pub fn start() -> Result<()> {
	let mut slot = RECORDER.lock().map_err(|_| CockpitError::msg("Micro indisponible."))?;
	if slot.is_some() {
		return Ok(());
	}
	let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
	let rate = Arc::new(Mutex::new(16_000u32));
	let failure = Arc::new(Mutex::new(None::<String>));
	let (stop, stopped) = mpsc::channel::<()>();

	// Le flux de `cpal` ne se transmet pas d'un fil à l'autre sur macOS : il
	// naît, vit et meurt sur le sien.
	let thread = {
		let samples = samples.clone();
		let rate = rate.clone();
		let failure = failure.clone();
		std::thread::spawn(move || {
			let record = || -> std::result::Result<(), String> {
				let host = cpal::default_host();
				let device = host.default_input_device().ok_or_else(|| crate::i18n::t("voiceInput.noMic"))?;
				let config = device.default_input_config().map_err(|e| crate::i18n::tf("voiceInput.mic", &[("error", &e)]))?;
				let channels = config.channels() as usize;
				if let Ok(mut value) = rate.lock() {
					*value = config.sample_rate().0;
				}
				let on_error = |error| eprintln!("micro : {error}");
				let stream = match config.sample_format() {
					cpal::SampleFormat::F32 => {
						let samples = samples.clone();
						device.build_input_stream(
							&config.clone().into(),
							move |data: &[f32], _| to_mono(data, channels, &samples),
							on_error,
							None,
						)
					}
					cpal::SampleFormat::I16 => {
						let samples = samples.clone();
						device.build_input_stream(
							&config.clone().into(),
							move |data: &[i16], _| {
								let converted: Vec<f32> = data.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
								to_mono(&converted, channels, &samples);
							},
							on_error,
							None,
						)
					}
					other => return Err(crate::i18n::tf("voiceInput.unsupportedFormat", &[("format", &format!("{other:?}"))])),
				}
				.map_err(|e| crate::i18n::tf("voiceInput.micDenied", &[("error", &e)]))?;
				stream.play().map_err(|e| crate::i18n::tf("voiceInput.mic", &[("error", &e)]))?;
				let _ = stopped.recv_timeout(Duration::from_secs(MAX_SECONDS));
				drop(stream);
				Ok(())
			};
			if let Err(message) = record() {
				if let Ok(mut slot) = failure.lock() {
					*slot = Some(message);
				}
			}
		})
	};

	*slot = Some(Recorder { stop, thread, samples, rate, failure });
	Ok(())
}

/// Referme le micro et rend l'enregistrement en WAV, ou `None` s'il est trop
/// court pour contenir une phrase.
pub fn stop() -> Result<Option<Vec<u8>>> {
	let recorder = RECORDER
		.lock()
		.map_err(|_| CockpitError::msg("Micro indisponible."))?
		.take()
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("voiceInput.notOpen")))?;
	let _ = recorder.stop.send(());
	let _ = recorder.thread.join();
	if let Some(message) = recorder.failure.lock().ok().and_then(|mut slot| slot.take()) {
		return Err(CockpitError::msg(message));
	}
	let samples = std::mem::take(&mut *recorder.samples.lock().map_err(|_| CockpitError::msg("Micro."))?);
	let rate = *recorder.rate.lock().map_err(|_| CockpitError::msg("Micro."))?;
	if (samples.len() as f32) < rate as f32 * MIN_SECONDS {
		return Ok(None);
	}
	Ok(Some(wav(&samples, rate)?))
}

pub fn is_recording() -> bool {
	RECORDER.lock().map(|slot| slot.is_some()).unwrap_or(false)
}

fn wav(samples: &[f32], rate: u32) -> Result<Vec<u8>> {
	let spec = hound::WavSpec {
		channels: 1,
		sample_rate: rate,
		bits_per_sample: 16,
		sample_format: hound::SampleFormat::Int,
	};
	let mut buffer = Cursor::new(Vec::new());
	{
		let mut writer =
			hound::WavWriter::new(&mut buffer, spec).map_err(|e| CockpitError::msg(format!("WAV : {e}")))?;
		for sample in samples {
			let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
			writer
				.write_sample(value)
				.map_err(|e| CockpitError::msg(format!("WAV : {e}")))?;
		}
		writer.finalize().map_err(|e| CockpitError::msg(format!("WAV : {e}")))?;
	}
	Ok(buffer.into_inner())
}

/// Ce que dit l'enregistrement, en texte, par Scribe.
pub async fn transcribe(audio: Vec<u8>) -> Result<String> {
	let key = crate::speech::api_key()
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("voiceInput.noKey")))?;
	let started = Instant::now();
	let form = |with_language: bool| {
		let mut form = reqwest::multipart::Form::new().text("model_id", "scribe_v2").part(
			"file",
			reqwest::multipart::Part::bytes(audio.clone())
				.file_name("commande.wav")
				.mime_str("audio/wav")
				.expect("type audio valide"),
		);
		if with_language {
			// La langue de l'interface, en code ISO 639-1 (`pt-BR` → `pt`).
			let lang = crate::i18n::lang();
			let code = lang.split('-').next().unwrap_or("en").to_string();
			form = form.text("language_code", code);
		}
		form
	};
	let send = |with_language: bool| {
		reqwest::Client::new()
			.post("https://api.elevenlabs.io/v1/speech-to-text")
			.header("xi-api-key", key.clone())
			.timeout(Duration::from_secs(30))
			.multipart(form(with_language))
			.send()
	};
	let mut response = send(true)
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("voiceInput.unreachable", &[("error", &e)])))?;
	// Le code de langue attendu n'est pas documenté de façon certaine (« fr »
	// ou « fra ») : refusé, on laisse Scribe reconnaître la langue lui-même.
	if response.status().as_u16() == 422 || response.status().as_u16() == 400 {
		response = send(false)
			.await
			.map_err(|e| CockpitError::msg(crate::i18n::tf("voiceInput.unreachable", &[("error", &e)])))?;
	}
	if !response.status().is_success() {
		let status = response.status();
		let body = response.text().await.unwrap_or_default();
		return Err(CockpitError::msg(crate::i18n::tf(
			"voiceInput.refused",
			&[("status", &status), ("body", &body.chars().take(200).collect::<String>())],
		)));
	}
	let body: serde_json::Value = response
		.json()
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("voiceInput.unreadable", &[("error", &e)])))?;
	let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
	eprintln!("assistant : transcription en {} ms", started.elapsed().as_millis());
	Ok(text)
}

/* ── Le raccourci ───────────────────────────────────────────────────── */

/// Par défaut ⌥ Espace ; ChatGPT, Raycast ou Alfred le prennent volontiers.
pub const DEFAULT_SHORTCUT: &str = "alt+Space";

/// Où en est le raccourci : celui qu'on a voulu, et s'il est vraiment actif.
///
/// Un raccourci déjà pris par une autre application ne se voyait nulle part :
/// on maintenait ⌥ Espace, rien ne se passait, et rien ne disait pourquoi.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
	pub accelerator: String,
	pub registered: bool,
	pub error: Option<String>,
}

static SHORTCUT: Mutex<Option<ShortcutStatus>> = Mutex::new(None);

fn shortcut_file() -> std::path::PathBuf {
	crate::config::config_dir().join("assistant.json")
}

/// Le raccourci choisi, gardé d'un lancement à l'autre : il doit être connu
/// avant même que la page soit chargée.
pub fn saved_shortcut() -> String {
	std::fs::read_to_string(shortcut_file())
		.ok()
		.and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
		.and_then(|value| value.get("shortcut").and_then(|v| v.as_str()).map(str::to_string))
		.filter(|value| !value.trim().is_empty())
		.unwrap_or_else(|| DEFAULT_SHORTCUT.to_string())
}

pub fn save_shortcut(accelerator: &str) -> Result<()> {
	let path = shortcut_file();
	if let Some(dir) = path.parent() {
		let _ = std::fs::create_dir_all(dir);
	}
	std::fs::write(&path, serde_json::json!({ "shortcut": accelerator }).to_string())
		.map_err(|e| CockpitError::msg(crate::i18n::tf("voiceInput.saveShortcut", &[("error", &e)])))
}

pub fn set_shortcut_status(status: ShortcutStatus) {
	if let Ok(mut slot) = SHORTCUT.lock() {
		*slot = Some(status);
	}
}

pub fn shortcut_status() -> ShortcutStatus {
	SHORTCUT
		.lock()
		.ok()
		.and_then(|slot| slot.clone())
		.unwrap_or(ShortcutStatus { accelerator: saved_shortcut(), registered: false, error: None })
}

#[cfg(test)]
mod tests {
	use super::{to_mono, wav};
	use std::sync::Mutex;

	/// Les raccourcis tels que l'interface les écrit, depuis `KeyboardEvent.code`.
	#[test]
	fn les_raccourcis_de_l_interface_se_lisent() {
		use std::str::FromStr;
		use tauri_plugin_global_shortcut::Shortcut;
		for accelerator in [super::DEFAULT_SHORTCUT, "control+alt+Space", "shift+alt+Space", "super+shift+KeyJ", "alt+Digit1", "control+F5"] {
			assert!(Shortcut::from_str(accelerator).is_ok(), "{accelerator}");
		}
		assert!(Shortcut::from_str("alt+").is_err());
	}

	#[test]
	fn deux_voies_deviennent_une() {
		let into = Mutex::new(Vec::new());
		to_mono(&[1.0, 0.0, 0.5, 0.5], 2, &into);
		assert_eq!(*into.lock().unwrap(), vec![0.5, 0.5]);
	}

	#[test]
	fn l_enregistrement_devient_un_wav_lisible() {
		let bytes = wav(&vec![0.0; 16_000], 16_000).unwrap();
		let reader = hound::WavReader::new(std::io::Cursor::new(bytes)).unwrap();
		assert_eq!(reader.spec().sample_rate, 16_000);
		assert_eq!(reader.len(), 16_000);
	}
}

#[cfg(test)]
mod live {
	/// Contre le vrai CLI : `cargo test --lib live -- --ignored`.
	#[tokio::test]
	#[ignore]
	async fn claude_repond_vite_et_en_json() {
		let started = std::time::Instant::now();
		let text = crate::agent::ask_quick(
			"Tu es un routeur. Réponds uniquement par un objet JSON {\"action\": string}.",
			"Ouvre le workspace fix-cart-rounding-nw-3044",
			"haiku",
		)
		.await
		.unwrap();
		eprintln!("{} ms : {text}", started.elapsed().as_millis());
		assert!(text.contains("action"));
	}

	#[tokio::test]
	async fn une_branche_se_cree_sans_bouger_le_dossier() {
		let dir = std::env::temp_dir().join(format!("cockpit-branche-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let git = |args: &[&str]| {
			assert!(std::process::Command::new("git")
				.args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
				.args(args)
				.current_dir(&dir)
				.status()
				.unwrap()
				.success());
		};
		git(&["init", "-q", "-b", "main"]);
		std::fs::write(dir.join("a"), "a").unwrap();
		git(&["add", "-A"]);
		git(&["commit", "-q", "-m", "base"]);
		let message = crate::git::create_branch(&dir, "fix/cart-rounding", None).await.unwrap();
		assert!(message.contains("fix/cart-rounding"));
		assert!(crate::git::create_branch(&dir, "fix/cart-rounding", None).await.is_err());
		assert!(crate::git::create_branch(&dir, "nom avec espace", None).await.is_err());
		assert_eq!(crate::git::current_branch(&dir).await.unwrap(), "main");
		let _ = std::fs::remove_dir_all(&dir);
	}
}
