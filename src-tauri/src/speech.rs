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
//!
//! Sous Windows, le moteur du système est SAPI (`System.Speech`, par
//! PowerShell), la clé dort dans le Gestionnaire d'identifiants, et l'audio
//! d'ElevenLabs est lu par le `MediaPlayer` de WPF — voir `windows`.

#[cfg(not(windows))]
use std::io::Write;
use std::process::Child;
#[cfg(not(windows))]
use std::process::{Command, Stdio};
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
#[cfg_attr(windows, allow(dead_code))]
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
	#[cfg(windows)]
	{
		windows::voices()
	}
	#[cfg(not(windows))]
	{
		system_voices()
	}
}

#[cfg(not(windows))]
fn system_voices() -> Result<Vec<Voice>> {
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
	#[cfg(windows)]
	let child = windows::say(text, voice, rate)?;
	#[cfg(not(windows))]
	let child = say_mac(text, voice, rate)?;
	play(child).await;
	Ok(())
}

#[cfg(not(windows))]
fn say_mac(text: &str, voice: Option<&str>, rate: Option<u32>) -> Result<Child> {
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
	Ok(child)
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
	#[cfg(windows)]
	{
		if key.is_empty() {
			windows::delete_key();
			return Ok(());
		}
		if !valid_key(key) {
			return Err(CockpitError::msg(crate::i18n::t("speech.invalidKey")));
		}
		windows::write_key(key)
	}
	#[cfg(not(windows))]
	{
		set_key_mac(key)
	}
}

#[cfg(not(windows))]
fn set_key_mac(key: &str) -> Result<()> {
	if key.is_empty() {
		let _ = Command::new("/usr/bin/security")
			.args([
				"delete-generic-password",
				"-a",
				KEYCHAIN_ACCOUNT,
				"-s",
				KEYCHAIN_SERVICE,
			])
			.output();
		return Ok(());
	}
	if !valid_key(key) {
		return Err(CockpitError::msg(crate::i18n::t("speech.invalidKey")));
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
		return Err(CockpitError::msg(crate::i18n::tf(
			"speech.keychainRefused",
			&[("error", &String::from_utf8_lossy(&output.stderr).trim())],
		)));
	}
	Ok(())
}

fn key() -> Option<String> {
	#[cfg(windows)]
	{
		windows::read_key()
	}
	#[cfg(not(windows))]
	{
		key_mac()
	}
}

#[cfg(not(windows))]
fn key_mac() -> Option<String> {
	let output = Command::new("/usr/bin/security")
		.args([
			"find-generic-password",
			"-a",
			KEYCHAIN_ACCOUNT,
			"-s",
			KEYCHAIN_SERVICE,
			"-w",
		])
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
		if female {
			crate::i18n::t("speech.female")
		} else if gender == "male" {
			crate::i18n::t("speech.male")
		} else {
			String::new()
		},
		if french {
			crate::i18n::t("speech.french")
		} else {
			String::new()
		},
		raw.get("category").and_then(|v| v.as_str()).unwrap_or("").to_string(),
	]
	.iter()
	.filter(|part| !part.is_empty())
	.cloned()
	.collect::<Vec<_>>()
	.join(" · ");
	Some(CloudVoice {
		id,
		name,
		description,
		female,
		french,
	})
}

pub async fn cloud_voices() -> Result<Vec<CloudVoice>> {
	let key = key().ok_or_else(|| CockpitError::msg(crate::i18n::t("speech.noKey")))?;
	let response = reqwest::Client::new()
		.get(format!("{API}/voices"))
		.header("xi-api-key", key)
		.timeout(Duration::from_secs(15))
		.send()
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("speech.unreachable", &[("error", &e)])))?;
	if !response.status().is_success() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"speech.keyRefused",
			&[("status", &response.status())],
		)));
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
	let api_key = key().ok_or_else(|| CockpitError::msg(crate::i18n::t("speech.noKey")))?;
	let voice = match voice.filter(|v| !v.trim().is_empty()) {
		Some(voice) => voice.to_string(),
		None => cloud_voices()
			.await?
			.into_iter()
			.next()
			.map(|voice| voice.id)
			.ok_or_else(|| CockpitError::msg(crate::i18n::t("speech.noVoice")))?,
	};
	// L'identifiant devient un segment d'URL : rien qui puisse en sortir.
	if !voice.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
		return Err(CockpitError::msg(crate::i18n::tf(
			"speech.invalidVoice",
			&[("voice", &voice)],
		)));
	}
	let response = reqwest::Client::new()
		.post(format!("{API}/text-to-speech/{voice}?output_format=mp3_44100_128"))
		.header("xi-api-key", api_key)
		.timeout(Duration::from_secs(20))
		.json(&serde_json::json!({
			"text": text,
			"model_id": model.filter(|m| !m.trim().is_empty()).unwrap_or("eleven_multilingual_v2"),
			// La langue de l'interface, en code ISO 639-1 (`pt-BR` → `pt`).
			"language_code": crate::i18n::lang().split('-').next().unwrap_or("en"),
			"voice_settings": {
				"stability": 0.5,
				"similarity_boost": 0.75,
				"speed": speed_of(rate),
			},
		}))
		.send()
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("speech.unreachable", &[("error", &e)])))?;
	if !response.status().is_success() {
		let status = response.status();
		let body = response.text().await.unwrap_or_default();
		return Err(CockpitError::msg(crate::i18n::tf(
			"speech.refused",
			&[
				("status", &status),
				("body", &body.chars().take(200).collect::<String>()),
			],
		)));
	}
	let audio = response
		.bytes()
		.await
		.map_err(|e| CockpitError::msg(format!("ElevenLabs : {e}")))?;

	let path = std::env::temp_dir().join(format!("cockpit-voix-{}.mp3", std::process::id()));
	std::fs::write(&path, &audio)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("speech.audioFile", &[("error", &e)])))?;
	#[cfg(windows)]
	let child = windows::play_mp3(&path)?;
	#[cfg(not(windows))]
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

/* ── Windows ────────────────────────────────────────────────────────── */

/// Une ligne de la liste des voix SAPI : `Microsoft Hortense Desktop\tfr-FR`.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_sapi_voice(line: &str) -> Option<Voice> {
	let (name, culture) = line.trim_end_matches('\r').split_once('\t')?;
	let name = name.trim();
	let culture = culture.trim().replace('-', "_");
	let valid = !name.is_empty() && culture.len() >= 5 && culture.as_bytes()[2] == b'_';
	valid.then(|| Voice {
		name: name.to_string(),
		locale: culture,
	})
}

/// Le débit du Mac (mots par minute, 185 par défaut) ramené à l'échelle de
/// SAPI : de −10 à 10, où 10 parle environ trois fois plus vite que 0.
#[cfg_attr(not(windows), allow(dead_code))]
fn sapi_rate(rate: Option<u32>) -> i32 {
	let words = rate.unwrap_or(185).clamp(90, 400) as f64;
	((words / 185.0).ln() / 3f64.ln() * 10.0).round().clamp(-10.0, 10.0) as i32
}

#[cfg(windows)]
mod windows {
	//! Rien de ce qui vient de l'extérieur n'est interpolé dans un script
	//! PowerShell : les scripts sont des constantes, passées encodées
	//! (`-EncodedCommand`) ; le texte arrive par l'entrée standard, la voix et
	//! le fichier audio par l'environnement.

	use super::{parse_sapi_voice, sapi_rate, Voice, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};
	use crate::error::{CockpitError, Result};
	use base64::Engine;
	use std::io::Write;
	use std::process::{Child, Command, Stdio};

	fn powershell(script: &str) -> Command {
		let utf16: Vec<u8> = script.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
		let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
		let mut command = Command::new("powershell.exe");
		command.args([
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			&encoded,
		]);
		crate::platform::quiet_std(&mut command);
		command
	}

	/// La liste sort en octets UTF-8, sans passer par la page de code de la
	/// console, qui abîmerait les noms accentués.
	const VOICES: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$lines = foreach ($v in $s.GetInstalledVoices()) {
	if ($v.Enabled) { $v.VoiceInfo.Name + "`t" + $v.VoiceInfo.Culture.Name }
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
"#;

	const SAY: &str = r#"
$ErrorActionPreference = 'Stop'
$in = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
$in.CopyTo($buffer)
$text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:COCKPIT_VOICE) { try { $s.SelectVoice($env:COCKPIT_VOICE) } catch {} }
if ($env:COCKPIT_RATE) { $s.Rate = [int]$env:COCKPIT_RATE }
$s.SetOutputToDefaultAudioDevice()
$s.Speak($text)
"#;

	/// `MediaPlayer` (PresentationCore, livré avec .NET Framework sur tout
	/// Windows 10/11) lit le mp3 sans rien installer. Il n'attend pas la fin de
	/// la lecture : on attend sa durée, ou une estimation par la taille du
	/// fichier (128 kbit/s) s'il ne la donne pas.
	const PLAY: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]::new($env:COCKPIT_AUDIO))
$p.Volume = 1
$p.Play()
$waited = 0
while (-not $p.NaturalDuration.HasTimeSpan -and $waited -lt 5000) { Start-Sleep -Milliseconds 50; $waited += 50 }
if ($p.NaturalDuration.HasTimeSpan) {
	Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 300)
} else {
	Start-Sleep -Seconds ([math]::Ceiling((Get-Item -LiteralPath $env:COCKPIT_AUDIO).Length / 16000) + 1)
}
$p.Close()
"#;

	pub fn voices() -> Result<Vec<Voice>> {
		let output = powershell(VOICES)
			.stdin(Stdio::null())
			.output()
			.map_err(|e| CockpitError::msg(format!("PowerShell : {e}")))?;
		let raw = String::from_utf8_lossy(&output.stdout);
		Ok(raw.lines().filter_map(parse_sapi_voice).collect())
	}

	pub fn say(text: &str, voice: Option<&str>, rate: Option<u32>) -> Result<Child> {
		let mut command = powershell(SAY);
		if let Some(voice) = voice.filter(|v| !v.trim().is_empty()) {
			command.env("COCKPIT_VOICE", voice.trim());
		}
		if rate.is_some() {
			command.env("COCKPIT_RATE", sapi_rate(rate).to_string());
		}
		let mut child = command
			.stdin(Stdio::piped())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.map_err(|e| CockpitError::msg(format!("PowerShell : {e}")))?;
		if let Some(mut stdin) = child.stdin.take() {
			let _ = stdin.write_all(text.as_bytes());
		}
		Ok(child)
	}

	pub fn play_mp3(path: &std::path::Path) -> Result<Child> {
		powershell(PLAY)
			.env("COCKPIT_AUDIO", path)
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.map_err(|e| CockpitError::msg(format!("PowerShell : {e}")))
	}

	/* ── Gestionnaire d'identifiants ── */

	use windows_sys::Win32::Foundation::GetLastError;
	use windows_sys::Win32::Security::Credentials::{
		CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
	};

	fn wide(text: &str) -> Vec<u16> {
		text.encode_utf16().chain(std::iter::once(0)).collect()
	}

	/// Le même nom que l'élément du trousseau macOS : `cockpit-elevenlabs`.
	fn target() -> Vec<u16> {
		wide(KEYCHAIN_SERVICE)
	}

	pub fn write_key(key: &str) -> Result<()> {
		let mut target = target();
		let mut user = wide(KEYCHAIN_ACCOUNT);
		let mut blob = key.as_bytes().to_vec();
		let credential = CREDENTIALW {
			Flags: 0,
			Type: CRED_TYPE_GENERIC,
			TargetName: target.as_mut_ptr(),
			Comment: std::ptr::null_mut(),
			LastWritten: unsafe { std::mem::zeroed() },
			CredentialBlobSize: blob.len() as u32,
			CredentialBlob: blob.as_mut_ptr(),
			Persist: CRED_PERSIST_LOCAL_MACHINE,
			AttributeCount: 0,
			Attributes: std::ptr::null_mut(),
			TargetAlias: std::ptr::null_mut(),
			UserName: user.as_mut_ptr(),
		};
		let ok = unsafe { CredWriteW(&credential, 0) } != 0;
		if !ok {
			let code = unsafe { GetLastError() };
			return Err(CockpitError::msg(crate::i18n::tf(
				"desktop.credentialsRefused",
				&[("error", &std::io::Error::from_raw_os_error(code as i32))],
			)));
		}
		Ok(())
	}

	pub fn read_key() -> Option<String> {
		let target = target();
		let mut found: *mut CREDENTIALW = std::ptr::null_mut();
		let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) } != 0;
		if !ok || found.is_null() {
			return None;
		}
		let key = unsafe {
			let credential = &*found;
			let bytes = if credential.CredentialBlob.is_null() {
				&[][..]
			} else {
				std::slice::from_raw_parts(credential.CredentialBlob, credential.CredentialBlobSize as usize)
			};
			let key = String::from_utf8_lossy(bytes).trim().to_string();
			CredFree(found as *const core::ffi::c_void);
			key
		};
		(!key.is_empty()).then_some(key)
	}

	pub fn delete_key() {
		let target = target();
		unsafe {
			CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0);
		}
	}
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
	fn lit_les_voix_de_windows() {
		let voice = super::parse_sapi_voice("Microsoft Hortense Desktop\tfr-FR\r").unwrap();
		assert_eq!(voice.name, "Microsoft Hortense Desktop");
		assert_eq!(voice.locale, "fr_FR");
		assert!(super::parse_sapi_voice("sans culture").is_none());
		assert!(super::parse_sapi_voice("\tfr-FR").is_none());
	}

	#[test]
	fn le_debit_du_mac_se_traduit_pour_sapi() {
		assert_eq!(super::sapi_rate(None), 0);
		assert_eq!(super::sapi_rate(Some(185)), 0);
		assert!(super::sapi_rate(Some(400)) > 0 && super::sapi_rate(Some(400)) <= 10);
		assert!(super::sapi_rate(Some(90)) < 0 && super::sapi_rate(Some(90)) >= -10);
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
		assert_eq!(voice.description, "female · French · premade");
		assert!(super::cloud_voice(&serde_json::json!({ "name": "sans id" })).is_none());
	}
}
