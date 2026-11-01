//! La voix qui raconte ce que fait un agent.
//!
//! Deux moteurs. Celui du Mac (`say`) : gratuit, hors ligne, sans latence, mais
//! synthétique — les voix Premium (Audrey, Thomas) s'en tirent correctement,
//! Amélie beaucoup moins. Et ElevenLabs : la voix française la plus humaine,
//! payée sur le forfait de la personne avec sa clé d'API — aucun abonnement
//! Claude ni ChatGPT ne fournit de voix à une application tierce. Si
//! ElevenLabs échoue (pas de clé, pas de réseau, forfait épuisé), la phrase
//! part quand même par le Mac : une narration qui se tait sans rien dire
//! serait pire qu'une voix moins belle.
//!
//! Une seule phrase à la fois : la suivante attend que la précédente soit dite,
//! et `stop` coupe net.

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use crate::error::{CockpitError, Result};

static CURRENT: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
	pub name: String,
	/// `fr_FR`, `fr_CA`, `en_US`…
	pub locale: String,
}

/// `Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.`
fn parse_voice(line: &str) -> Option<Voice> {
	let (head, _) = line.split_once('#')?;
	let head = head.trim_end();
	let (name, locale) = head.rsplit_once(char::is_whitespace)?;
	let locale = locale.trim();
	let valid = locale.len() >= 5 && locale.as_bytes()[2] == b'_';
	valid.then(|| Voice {
		name: name.trim().to_string(),
		locale: locale.to_string(),
	})
}

pub fn voices() -> Result<Vec<Voice>> {
	let output = Command::new("/usr/bin/say")
		.args(["-v", "?"])
		.output()
		.map_err(|e| CockpitError::msg(format!("say : {e}")))?;
	let raw = String::from_utf8_lossy(&output.stdout);
	Ok(raw.lines().filter_map(parse_voice).collect())
}

/// Coupe ce qui est en train d'être dit.
pub fn stop() {
	if let Some(mut child) = CURRENT.lock().ok().and_then(|mut slot| slot.take()) {
		let _ = child.kill();
		let _ = child.wait();
	}
}

/// Attend la fin d'un lecteur, sans tenir le verrou : `stop` doit pouvoir le
/// reprendre pendant qu'il parle.
async fn play(child: Child) {
	let pid = child.id();
	if let Ok(mut slot) = CURRENT.lock() {
		*slot = Some(child);
	}
	loop {
		tokio::time::sleep(Duration::from_millis(80)).await;
		let Ok(mut slot) = CURRENT.lock() else { return };
		match slot.as_mut() {
			Some(child) if child.id() == pid => {
				if let Ok(Some(_)) = child.try_wait() {
					slot.take();
					return;
				}
			}
			// Coupé, ou remplacé par une phrase plus récente.
			_ => return,
		}
	}
}

/// Le texte passe par l'entrée standard plutôt qu'en argument : une phrase
/// d'agent qui commence par un tiret serait prise pour une option.
async fn say_system(text: &str, voice: Option<&str>, rate: Option<u32>) -> Result<()> {
	let mut command = Command::new("/usr/bin/say");
	if let Some(voice) = voice.filter(|v| !v.trim().is_empty()) {
		command.args(["-v", voice.trim()]);
	}
	if let Some(rate) = rate {
		command.args(["-r", &rate.clamp(90, 400).to_string()]);
	}
	let mut child = command
		.args(["-f", "-"])
		.stdin(Stdio::piped())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.map_err(|e| CockpitError::msg(format!("say : {e}")))?;
	if let Some(mut stdin) = child.stdin.take() {
		let _ = stdin.write_all(text.as_bytes());
	}
	play(child).await;
	Ok(())
}

/* ── ElevenLabs ─────────────────────────────────────────────────────── */

const KEYCHAIN_SERVICE: &str = "cockpit-elevenlabs";
const KEYCHAIN_ACCOUNT: &str = "cockpit";
const API: &str = "https://api.elevenlabs.io/v1";

/// Une clé d'API n'a que ces caractères : tout le reste serait une tentative
/// d'injecter une commande dans le trousseau.
fn valid_key(key: &str) -> bool {
	!key.is_empty() && key.len() < 400 && key.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Range la clé dans le trousseau du Mac. Elle passe par l'entrée de
/// `security -i` : en argument, elle se lirait dans la liste des processus.
pub fn set_key(key: &str) -> Result<()> {
	let key = key.trim();
	if key.is_empty() {
		let _ = Command::new("/usr/bin/security")
			.args(["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE])
			.output();
		return Ok(());
	}
	if !valid_key(key) {
		return Err(CockpitError::msg("Cette clé n'a pas la forme d'une clé d'API ElevenLabs."));
	}
	let mut child = Command::new("/usr/bin/security")
		.arg("-i")
		.stdin(Stdio::piped())
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.spawn()
		.map_err(|e| CockpitError::msg(format!("security : {e}")))?;
	if let Some(mut stdin) = child.stdin.take() {
		let _ = writeln!(
			stdin,
			"add-generic-password -U -a {KEYCHAIN_ACCOUNT} -s {KEYCHAIN_SERVICE} -w {key}"
		);
	}
	let output = child
		.wait_with_output()
		.map_err(|e| CockpitError::msg(format!("security : {e}")))?;
	if !output.status.success() {
		return Err(CockpitError::msg(format!(
			"Le trousseau a refusé la clé : {}",
			String::from_utf8_lossy(&output.stderr).trim()
		)));
	}
	Ok(())
}

fn key() -> Option<String> {
	let output = Command::new("/usr/bin/security")
		.args(["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"])
		.output()
		.ok()?;
	let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
	(output.status.success() && !key.is_empty()).then_some(key)
}

pub fn has_key() -> bool {
	key().is_some()
}

/// La clé ElevenLabs, pour l'oreille de l'assistant (Scribe) : la même que
/// pour la voix, rangée une seule fois.
pub(crate) fn api_key() -> Option<String> {
	key()
}

/// Une voix du compte ElevenLabs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudVoice {
	pub id: String,
	pub name: String,
	/// « femme · français », ce que les étiquettes en disent.
	pub description: String,
	pub female: bool,
	pub french: bool,
}

fn cloud_voice(raw: &serde_json::Value) -> Option<CloudVoice> {
	let id = raw.get("voice_id")?.as_str()?.to_string();
	let name = raw.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
	let labels = raw.get("labels");
	let label = |key: &str| {
		labels
			.and_then(|l| l.get(key))
			.and_then(|v| v.as_str())
			.unwrap_or("")
			.to_lowercase()
	};
	let gender = label("gender");
	let language = format!("{} {}", label("language"), label("accent"));
	let female = gender == "female";
	let french = language.contains("fr");
	let description = [
		if female { "femme" } else if gender == "male" { "homme" } else { "" },
		if french { "français" } else { "" },
		raw.get("category").and_then(|v| v.as_str()).unwrap_or(""),
	]
	.iter()
	.filter(|part| !part.is_empty())
	.cloned()
	.collect::<Vec<_>>()
	.join(" · ");
	Some(CloudVoice { id, name, description, female, french })
}

pub async fn cloud_voices() -> Result<Vec<CloudVoice>> {
	let key = key().ok_or_else(|| CockpitError::msg("Aucune clé ElevenLabs dans le trousseau."))?;
	let response = reqwest::Client::new()
		.get(format!("{API}/voices"))
		.header("xi-api-key", key)
		.timeout(Duration::from_secs(15))
		.send()
		.await
		.map_err(|e| CockpitError::msg(format!("ElevenLabs injoignable : {e}")))?;
	if !response.status().is_success() {
		return Err(CockpitError::msg(format!("ElevenLabs a refusé la clé ({}).", response.status())));
	}
	let body: serde_json::Value = response
		.json()
		.await
		.map_err(|e| CockpitError::msg(format!("ElevenLabs : {e}")))?;
	let mut voices: Vec<CloudVoice> = body
		.get("voices")
		.and_then(|v| v.as_array())
		.map(|list| list.iter().filter_map(cloud_voice).collect())
		.unwrap_or_default();
	// Les voix françaises d'abord, puis les voix de femme : c'est ce qu'on
	// cherche pour raconter en français.
	voices.sort_by_key(|voice| (!voice.french, !voice.female, voice.name.clone()));
	Ok(voices)
}

/// Le débit du Mac en mots par minute, ramené à la vitesse d'ElevenLabs.
fn speed_of(rate: Option<u32>) -> f32 {
	(rate.unwrap_or(185) as f32 / 185.0).clamp(0.7, 1.2)
}

async fn say_cloud(text: &str, voice: Option<&str>, model: Option<&str>, rate: Option<u32>) -> Result<()> {
	let api_key = key().ok_or_else(|| CockpitError::msg("Aucune clé ElevenLabs dans le trousseau."))?;
	let voice = match voice.filter(|v| !v.trim().is_empty()) {
		Some(voice) => voice.to_string(),
		None => cloud_voices()
			.await?
			.into_iter()
			.next()
			.map(|voice| voice.id)
			.ok_or_else(|| CockpitError::msg("Aucune voix sur ce compte ElevenLabs."))?,
	};
	// L'identifiant devient un segment d'URL : rien qui puisse en sortir.
	if !voice.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
		return Err(CockpitError::msg(format!("Voix ElevenLabs invalide : {voice}")));
	}
	let response = reqwest::Client::new()
		.post(format!("{API}/text-to-speech/{voice}?output_format=mp3_44100_128"))
		.header("xi-api-key", api_key)
		.timeout(Duration::from_secs(20))
		.json(&serde_json::json!({
			"text": text,
			"model_id": model.filter(|m| !m.trim().is_empty()).unwrap_or("eleven_multilingual_v2"),
			"language_code": "fr",
			"voice_settings": {
				"stability": 0.5,
				"similarity_boost": 0.75,
				"speed": speed_of(rate),
			},
		}))
		.send()
		.await
		.map_err(|e| CockpitError::msg(format!("ElevenLabs injoignable : {e}")))?;
	if !response.status().is_success() {
		let status = response.status();
		let body = response.text().await.unwrap_or_default();
		return Err(CockpitError::msg(format!(
			"ElevenLabs a refusé ({status}) : {}",
			body.chars().take(200).collect::<String>()
		)));
	}
	let audio = response
		.bytes()
		.await
		.map_err(|e| CockpitError::msg(format!("ElevenLabs : {e}")))?;

	let path = std::env::temp_dir().join(format!("cockpit-voix-{}.mp3", std::process::id()));
	std::fs::write(&path, &audio).map_err(|e| CockpitError::msg(format!("Fichier audio : {e}")))?;
	let child = Command::new("/usr/bin/afplay")
		.arg(&path)
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.map_err(|e| CockpitError::msg(format!("afplay : {e}")))?;
	play(child).await;
	Ok(())
}

/// Dit une phrase, et rend la main quand elle est finie — ou coupée.
///
/// Rend `None` quand tout s'est passé comme demandé, et la raison du repli
/// quand ElevenLabs a échoué et que le Mac a pris le relais.
pub async fn speak(
	text: String,
	engine: Option<String>,
	voice: Option<String>,
	model: Option<String>,
	system_voice: Option<String>,
	rate: Option<u32>,
) -> Result<Option<String>> {
	stop();
	if engine.as_deref() == Some("elevenlabs") {
		match say_cloud(&text, voice.as_deref(), model.as_deref(), rate).await {
			Ok(()) => return Ok(None),
			Err(error) => {
				say_system(&text, system_voice.as_deref(), rate).await?;
				return Ok(Some(error.to_string()));
			}
		}
	}
	say_system(&text, system_voice.as_deref(), rate).await?;
	Ok(None)
}

#[cfg(test)]
mod tests {
	use super::{parse_voice, speed_of, valid_key};

	#[test]
	fn lit_les_noms_composes_et_leur_langue() {
		let voice = parse_voice("Flo (Français (France)) fr_FR    # Bonjour, je m’appelle Flo.").unwrap();
		assert_eq!(voice.name, "Flo (Français (France))");
		assert_eq!(voice.locale, "fr_FR");
		let voice = parse_voice("Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.").unwrap();
		assert_eq!(voice.name, "Amélie");
		assert_eq!(voice.locale, "fr_CA");
	}

	#[test]
	fn ignore_ce_qui_n_est_pas_une_voix() {
		assert!(parse_voice("").is_none());
		assert!(parse_voice("n'importe quoi").is_none());
	}

	#[test]
	fn une_cle_ne_peut_pas_porter_une_commande() {
		assert!(valid_key("sk-proj-AbC_123.x"));
		assert!(!valid_key("sk-abc\ndelete-keychain"));
		assert!(!valid_key("sk abc"));
		assert!(!valid_key(""));
	}

	#[test]
	fn le_debit_reste_dans_les_bornes_d_elevenlabs() {
		assert_eq!(speed_of(Some(185)), 1.0);
		assert!(speed_of(Some(90)) >= 0.7);
		assert!(speed_of(Some(400)) <= 1.2);
	}

	#[test]
	fn lit_les_etiquettes_d_une_voix() {
		let voice = super::cloud_voice(&serde_json::json!({
			"voice_id": "abc", "name": "Léa", "category": "premade",
			"labels": { "gender": "female", "language": "fr", "accent": "parisian" }
		}))
		.unwrap();
		assert!(voice.female && voice.french);
		assert_eq!(voice.description, "femme · français · premade");
		assert!(super::cloud_voice(&serde_json::json!({ "name": "sans id" })).is_none());
	}
}
