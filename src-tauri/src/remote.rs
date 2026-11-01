//! Accès mobile au cockpit, à travers Tailscale.
//!
//! Répondre à un agent depuis son téléphone veut dire ouvrir une porte sur la
//! machine qui exécute les agents : c'est la surface la plus sensible de toute
//! l'app. Cinq barrières indépendantes la gardent, et aucune ne suffit seule.
//!
//! 1. **Réseau** — le serveur n'écoute que sur `127.0.0.1`. Ce qui l'expose,
//!    c'est `tailscale serve`, qui termine le TLS avec un vrai certificat et ne
//!    laisse passer que les appareils du tailnet. Rien n'est joignable depuis
//!    Internet, et le serveur refuse de démarrer si Funnel est actif — c'est la
//!    seule commande Tailscale qui publierait le tout sur la place publique.
//! 2. **Appareil** — chaque requête porte un jeton propre à un appareil
//!    appairé, dont on ne garde ici que l'empreinte. Le jeton ne s'obtient qu'en
//!    scannant un code à usage unique, valable deux minutes, affiché dans les
//!    Réglages.
//! 3. **Origine** — l'en-tête `Host` doit être celui du tailnet ou la boucle
//!    locale : sans cette vérification, une page web ouverte sur le téléphone
//!    pourrait viser le serveur par réassociation DNS.
//! 4. **Geste** — toute action qui engage quelque chose exige une signature
//!    WebAuthn (Face ID) sur un défi lié à la demande précise, valable une
//!    minute. Ni rejeu, ni décision prise à l'insu de qui tient le téléphone.
//! 5. **Politique** — la liste des actions permises est écrite en dur, ici. Le
//!    mobile ne peut ni changer le mode de permission d'un agent, ni lancer un
//!    script, ni toucher à la configuration : ces gestes n'ont pas d'API.
//!
//! Tout ce qui est décidé à distance passe par le journal, avec l'appareil qui
//! l'a demandé.

use crate::error::{CockpitError, Result};
use crate::i18n::{t, tf};
use axum::{
	extract::{Path, State},
	http::{HeaderMap, StatusCode},
	response::{Html, IntoResponse, Response},
	routing::{get, post},
	Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use webauthn_rs::prelude::*;

/// Port de boucle locale. Fixe : `tailscale serve` le référence dans sa
/// configuration, et un port qui bouge obligerait à la refaire à chaque fois.
pub const PORT: u16 = 7420;

/// Durée de vie d'un code d'appairage. Assez pour scanner, trop court pour
/// qu'un code aperçu par-dessus l'épaule serve à quoi que ce soit.
const PAIRING_TTL: Duration = Duration::from_secs(120);

/// Durée de vie d'un défi Face ID, entre la demande et la signature.
const CHALLENGE_TTL: Duration = Duration::from_secs(60);

/// Le temps laissé, après l'appairage, pour poser la première clé d'accès.
/// Passé ce délai, un jeton d'appareil volé ne suffit plus à armer un
/// téléphone qui ne l'était pas : il faut révoquer et appairer de nouveau,
/// avec un code qui ne s'affiche que sur le poste.
const ENROLL_WINDOW: chrono::Duration = chrono::Duration::minutes(15);

/// L'appareil peut-il encore poser sa première clé ?
fn enroll_open(device: &Device) -> bool {
	device.passkey.is_none()
		&& chrono::DateTime::parse_from_rfc3339(&device.created_at)
			.map(|created| chrono::Utc::now().signed_duration_since(created) < ENROLL_WINDOW)
			.unwrap_or(false)
}

/// Requêtes autorisées par minute et par appareil.
const RATE_LIMIT: usize = 60;

// ───────────────────────────── État persistant ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
	pub id: String,
	pub name: String,
	/// Empreinte SHA-256 du jeton : le jeton lui-même ne vit que sur le
	/// téléphone. Une copie du fichier d'état ne donne accès à rien.
	token_hash: String,
	/// Identité Tailscale vue au moment de l'appairage, à titre de trace.
	#[serde(default)]
	pub node: String,
	/// Clé d'accès enregistrée. Sans elle, l'appareil ne peut que lire et
	/// refuser — jamais autoriser.
	#[serde(default)]
	passkey: Option<Passkey>,
	pub created_at: String,
	#[serde(default)]
	pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
	#[serde(default)]
	pub enabled: bool,
	/// Serveur ntfy local, qui relaie le réveil vers le téléphone.
	#[serde(default = "default_ntfy_server")]
	pub ntfy_server: String,
	#[serde(default)]
	pub ntfy_topic: String,
	/// Jeton de publication du serveur ntfy, qui n'accepte rien d'anonyme.
	#[serde(default)]
	pub ntfy_token: String,
	#[serde(default)]
	pub devices: Vec<Device>,
}

fn default_ntfy_server() -> String {
	"http://127.0.0.1:2586".into()
}

impl Default for RemoteConfig {
	fn default() -> Self {
		Self {
			enabled: false,
			ntfy_server: default_ntfy_server(),
			ntfy_topic: String::new(),
			ntfy_token: String::new(),
			devices: Vec::new(),
		}
	}
}

fn state_path() -> std::path::PathBuf {
	crate::config::config_dir().join("remote.json")
}

pub fn load() -> RemoteConfig {
	std::fs::read_to_string(state_path())
		.ok()
		.and_then(|raw| serde_json::from_str(&raw).ok())
		.unwrap_or_default()
}

/// Écrit l'état en 0600 : il contient les empreintes de jetons et les clés
/// publiques des appareils, rien qui doive être lisible par un autre compte.
fn save(config: &RemoteConfig) -> Result<()> {
	let path = state_path();
	if let Some(parent) = path.parent() {
		let _ = std::fs::create_dir_all(parent);
	}
	let raw = serde_json::to_string_pretty(config)
		.map_err(|e| CockpitError::msg(tf("mobile.errors.stateUnreadable", &[("error", &e)])))?;
	std::fs::write(&path, raw)
		.map_err(|e| CockpitError::msg(tf("mobile.errors.stateWrite", &[("error", &e)])))?;

	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
	}
	Ok(())
}

/// Active ou coupe l'accès mobile.
///
/// Couper révoque tout : les jetons d'appareil et les clés d'accès partent avec.
/// C'est le geste qu'on fait quand on soupçonne quelque chose, il doit valoir
/// pour tout ce qui était ouvert, pas seulement pour le port.
pub fn set_enabled(enabled: bool) -> Result<()> {
	let mut config = load();
	config.enabled = enabled;
	if !enabled {
		config.devices.clear();
	}
	if enabled && config.ntfy_topic.is_empty() {
		// Le nom du topic est un secret : qui le connaît peut faire sonner le
		// téléphone. Il n'est jamais transmis en clair au relais, qui n'en voit
		// que l'empreinte, mais autant qu'il ne soit pas devinable non plus.
		config.ntfy_topic = format!("cockpit-{}", hex(&random_bytes::<12>()));
	}
	save(&config)?;
	crate::journal::record(
		"remote",
		&t(if enabled {
			"mobile.journal.enabled"
		} else {
			"mobile.journal.disabled"
		}),
		"",
		true,
		"",
	);
	Ok(())
}

pub fn set_ntfy(server: &str, topic: &str, token: &str) -> Result<()> {
	let mut config = load();
	config.ntfy_server = server.trim().trim_end_matches('/').to_string();
	config.ntfy_topic = topic.trim().to_string();

	// Un jeton vide veut dire « garde celui d'avant ». Tout le reste doit
	// ressembler à un jeton ntfy : le champ ayant d'abord été en saisie masquée,
	// le trousseau du navigateur y proposait un mot de passe enregistré.
	// Accepté sans broncher, il remplaçait le vrai jeton, et le cockpit se
	// faisait refuser en silence — des heures sans la moindre notification.
	let token = token.trim();
	if !token.is_empty() {
		if !token.starts_with("tk_") {
			return Err(CockpitError::msg(t("mobile.errors.ntfyTokenFormat")));
		}
		config.ntfy_token = token.to_string();
	}
	save(&config)
}

/// Verdict de la dernière tentative de réveil.
///
/// Sans lui, un relais cassé ne se voit nulle part : le téléphone reste muet,
/// et rien sur le poste ne dit pourquoi.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStatus {
	pub ok: bool,
	pub detail: String,
	pub at: String,
}

fn wake_slot() -> &'static Mutex<Option<WakeStatus>> {
	static SLOT: OnceLock<Mutex<Option<WakeStatus>>> = OnceLock::new();
	SLOT.get_or_init(|| Mutex::new(None))
}

pub fn last_wake() -> Option<WakeStatus> {
	wake_slot().lock().ok().and_then(|slot| slot.clone())
}

fn record_wake(ok: bool, detail: impl Into<String>) {
	if let Ok(mut slot) = wake_slot().lock() {
		*slot = Some(WakeStatus {
			ok,
			detail: detail.into(),
			at: now(),
		});
	}
}

/// Envoie un message de test et rend ce que le relais en a dit.
pub async fn test_relay() -> Result<String> {
	let config = load();
	if !config.enabled {
		return Err(CockpitError::msg(t("mobile.errors.disabled")));
	}
	if config.ntfy_topic.is_empty() {
		return Err(CockpitError::msg(t("mobile.errors.noTopic")));
	}
	wake("Cockpit", &t("mobile.wake.testBody"), None).await;
	match last_wake() {
		Some(status) if status.ok => Ok(status.detail),
		Some(status) => Err(CockpitError::msg(status.detail)),
		None => Err(CockpitError::msg(t("mobile.errors.nothingSent"))),
	}
}

pub fn revoke(id: &str) -> Result<()> {
	let mut config = load();
	let before = config.devices.len();
	config.devices.retain(|device| device.id != id);
	if config.devices.len() != before {
		crate::journal::record("remote", &t("mobile.journal.deviceRevoked"), id, true, "");
	}
	save(&config)
}

/// QR de la page mobile, en SVG. Il ne porte que l'adresse : le code
/// d'appairage se tape, pour qu'une photo du QR ne suffise jamais.
pub fn qr_svg(url: &str) -> Result<String> {
	use qrcode::render::svg;
	let code = qrcode::QrCode::new(url.as_bytes())
		.map_err(|e| CockpitError::msg(tf("mobile.errors.qr", &[("error", &e)])))?;
	Ok(code
		.render::<svg::Color>()
		.min_dimensions(200, 200)
		.dark_color(svg::Color("#f4f5f9"))
		.light_color(svg::Color("#101117"))
		.build())
}

// ──────────────────────────────── Aléatoire ────────────────────────────────

fn random_bytes<const N: usize>() -> [u8; N] {
	use rand::RngCore;
	let mut bytes = [0u8; N];
	rand::rng().fill_bytes(&mut bytes);
	bytes
}

fn random_token() -> String {
	hex(&random_bytes::<32>())
}

fn hex(bytes: &[u8]) -> String {
	bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn fingerprint(token: &str) -> String {
	hex(&Sha256::digest(token.as_bytes()))
}

/// Comparaison en temps constant : comparer deux empreintes avec `==` laisse
/// fuir, par le temps de réponse, le nombre de caractères devinés.
fn same_secret(left: &str, right: &str) -> bool {
	if left.len() != right.len() {
		return false;
	}
	left.bytes()
		.zip(right.bytes())
		.fold(0u8, |difference, (a, b)| difference | (a ^ b))
		== 0
}

/// Code d'appairage lisible à voix haute, sans caractères qui se confondent.
fn pairing_code() -> String {
	const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	random_bytes::<8>()
		.iter()
		.map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char)
		.collect()
}

fn now() -> String {
	chrono::Utc::now().to_rfc3339()
}

// ──────────────────────────────── Tailscale ────────────────────────────────

fn tailscale_bin() -> Option<&'static str> {
	const CANDIDATES: [&str; 3] = [
		"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
		"/usr/local/bin/tailscale",
		"/opt/homebrew/bin/tailscale",
	];
	CANDIDATES
		.into_iter()
		.find(|path| std::path::Path::new(path).exists())
}

async fn tailscale(arguments: &str) -> Option<String> {
	let binary = tailscale_bin()?;
	crate::runner::capture("/", &format!("{binary} {arguments}"))
		.await
		.ok()
}

/// Nom DNS de la machine dans le tailnet : c'est l'origine de la PWA, donc le
/// domaine sur lequel les clés d'accès sont enregistrées.
pub async fn dns_name() -> Option<String> {
	let raw = tailscale("status --json").await?;
	let value: Value = serde_json::from_str(&raw).ok()?;
	let name = value.pointer("/Self/DNSName")?.as_str()?;
	Some(name.trim_end_matches('.').to_string())
}

/// Vrai quand Funnel publie quelque chose sur Internet.
///
/// On ne cherche pas à savoir si c'est *notre* port : n'importe quel Funnel
/// actif sur cette machine est une porte ouverte, et le cockpit refuse alors de
/// démarrer son serveur plutôt que de parier sur la configuration.
pub async fn funnel_active() -> bool {
	let Some(raw) = tailscale("funnel status --json").await else {
		return false;
	};
	serde_json::from_str::<Value>(&raw)
		.ok()
		.and_then(|value| {
			value
				.get("AllowFunnel")
				.and_then(|allow| allow.as_object().map(|map| !map.is_empty()))
		})
		.unwrap_or(false)
}

// ──────────────────────────────── Serveur ────────────────────────────────

/// Défi en attente de signature, lié à l'action qu'il autorise.
struct PendingAction {
	device: String,
	action: Action,
	state: PasskeyAuthentication,
	at: Instant,
}

/// La liste close de ce qu'un téléphone peut demander.
///
/// Ajouter une variante ici est une décision de sécurité : tout ce qui n'y
/// figure pas n'a simplement pas d'API. En particulier, rien ne permet de
/// changer le mode de permission d'un agent, d'en lancer un nouveau, d'exécuter
/// un script ou de modifier la configuration.
///
/// `rename_all` ne vaut que pour les noms de variantes : sans
/// `rename_all_fields`, le `sessionId` envoyé par la page mobile n'atteignait
/// pas le `session_id` attendu ici, et toute réponse à un agent repartait en
/// 422 sans que rien ne le dise.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Action {
	/// Autoriser un outil demandé par un agent.
	AllowTool { id: String },
	/// Écrire à un agent.
	Message { session_id: String, text: String },
	/// Approuver le plan d'une mission — c'est lui qui libère les exécutants.
	ApprovePlan { id: String },
	/// Suspendre une mission : les exécutants sont coupés, rien ne repart.
	///
	/// Le mobile freine, il ne démarre pas : suspendre et arrêter y ont leur
	/// place, reprendre non — relancer des agents depuis le téléphone
	/// élargirait le périmètre d'une surface exposée, et c'est une décision qui
	/// mérite d'être prise devant la machine.
	PauseMission { id: String },
	/// Arrêter une mission : tout est coupé, le travail produit reste en place.
	StopMission { id: String },
	/// Répondre à une question posée par un agent (`AskUserQuestion`).
	///
	/// L'outil n'est pas exécuté pour autant — la réponse voyage dans le motif du
	/// refus, comme sur le poste. Mais elle oriente la suite du travail : elle
	/// demande donc la même signature que le reste.
	AnswerQuestion {
		id: String,
		answers: Vec<QuestionAnswer>,
	},
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionAnswer {
	header: String,
	choice: String,
}

struct Inner {
	app: AppHandle,
	webauthn: Webauthn,
	registrations: Mutex<HashMap<String, (PasskeyRegistration, Instant)>>,
	challenges: Mutex<HashMap<String, PendingAction>>,
	/// Jetons à usage unique des boutons de notification, qui ne servent qu'à
	/// refuser — le refus ne casse rien, il fait attendre.
	deny_nonces: Mutex<HashMap<String, (String, Instant)>>,
	hits: Mutex<HashMap<String, (usize, Instant)>>,
	host: String,
	/// Adresse par laquelle le téléphone atteint cette page : c'est elle qui
	/// part dans les boutons des notifications.
	base_url: String,
}

type Shared = Arc<Inner>;

static RUNNING: OnceLock<()> = OnceLock::new();

/// Démarre le serveur, si l'accès mobile est activé et le terrain sûr.
pub async fn start(app: AppHandle) -> Result<()> {
	let config = load();
	if !config.enabled {
		return Ok(());
	}
	if RUNNING.set(()).is_err() {
		return Ok(());
	}

	if funnel_active().await {
		return Err(CockpitError::msg(t("mobile.errors.funnelActive")));
	}

	// Sans Tailscale, le serveur démarre quand même — mais sur la boucle locale
	// seule, qui est le seul cas où un navigateur accepte WebAuthn hors HTTPS.
	// C'est ce qui permet d'essayer la page depuis le Mac avant d'avoir branché
	// le tailnet ; aucun autre appareil ne peut l'atteindre.
	let (host, base_url) = match dns_name().await {
		Some(host) => {
			let base = format!("https://{host}");
			(host, base)
		}
		None => ("localhost".to_string(), format!("http://localhost:{PORT}")),
	};

	let origin = Url::parse(&base_url)
		.map_err(|e| CockpitError::msg(tf("mobile.errors.invalidOrigin", &[("error", &e)])))?;
	let webauthn = WebauthnBuilder::new(&host, &origin)
		.and_then(|builder| builder.rp_name("Cockpit").build())
		.map_err(|e| CockpitError::msg(tf("mobile.errors.webauthn", &[("error", &e)])))?;

	let inner: Shared = Arc::new(Inner {
		app,
		webauthn,
		registrations: Mutex::new(HashMap::new()),
		challenges: Mutex::new(HashMap::new()),
		deny_nonces: Mutex::new(HashMap::new()),
		hits: Mutex::new(HashMap::new()),
		host,
		base_url,
	});
	// Les fonctions appelées hors requête — le réveil du téléphone — ont besoin
	// de la même poignée.
	let _ = SERVER.set(inner.clone());

	let router = Router::new()
		.route("/", get(page))
		.route("/manifest.webmanifest", get(manifest))
		.route("/tokens.css", get(tokens))
		.route("/sw.js", get(service_worker))
		.route("/api/pair", post(pair))
		.route("/api/register/start", post(register_start))
		.route("/api/register/finish", post(register_finish))
		.route("/api/inbox", get(inbox))
		.route("/api/agents/{session}/transcript", get(transcript))
		.route("/api/agents/{session}/changes", get(changes))
		.route("/api/agents/{session}/media", get(media))
		.route("/api/agents/{session}/screen", get(screen))
		.route("/api/challenge", post(challenge))
		.route("/api/execute", post(execute))
		.route("/api/deny", post(deny))
		.route("/api/quick-deny/{nonce}", get(quick_deny))
		.layer(axum::middleware::from_fn(gatekeeper))
		.with_state(inner);

	let listener = tokio::net::TcpListener::bind(("127.0.0.1", PORT))
		.await
		.map_err(|e| CockpitError::msg(tf("mobile.errors.port", &[("port", &PORT), ("error", &e)])))?;

	tokio::spawn(async move {
		let _ = axum::serve(listener, router).await;
	});
	watch_permissions();
	watch_plans();
	Ok(())
}

/// Réveille le téléphone quand un plan attend un accord.
///
/// C'est l'attente la plus coûteuse de tout le cycle : trois exécutants restent
/// à l'arrêt tant que personne n'a relu le découpage. Autant que la question
/// suive celui qui doit y répondre, plutôt que de l'attendre devant l'écran.
fn watch_plans() {
	tokio::spawn(async move {
		let mut announced: std::collections::HashSet<String> = std::collections::HashSet::new();
		loop {
			tokio::time::sleep(Duration::from_secs(5)).await;
			// Une mission guidée attend trois fois : chaque étape sonne pour
			// elle-même, d'où une clé qui porte l'état autant que la mission.
			let waiting: Vec<_> = crate::mission::list()
				.into_iter()
				.filter(|mission| mission.state.awaits_human())
				.collect();
			let key = |mission: &crate::mission::Mission| format!("{}:{:?}", mission.id, mission.state);
			let live: std::collections::HashSet<String> = waiting.iter().map(key).collect();

			for mission in &waiting {
				if announced.contains(&key(mission)) {
					continue;
				}
				let (title, detail) = match mission.state {
					crate::mission::MissionState::AwaitingUnderstanding => (
						t("mobile.wake.understandingTitle"),
						tf("mobile.wake.understandingDetail", &[("title", &mission.title)]),
					),
					crate::mission::MissionState::AwaitingApproach => (
						t("mobile.wake.approachTitle"),
						tf("mobile.wake.approachDetail", &[("title", &mission.title)]),
					),
					_ => (
						t("mobile.wake.planTitle"),
						tf(
							"mobile.wake.planDetail",
							&[("title", &mission.title), ("count", &mission.tasks.len())],
						),
					),
				};
				let sent = wake(&title, &detail, None).await;
				if sent {
					announced.insert(key(mission));
				}
			}
			// Un plan approuvé puis re-soumis doit pouvoir sonner à nouveau.
			announced.retain(|id| live.contains(id));
		}
	});
}

/// Réveille le téléphone dès qu'un agent demande quelque chose.
///
/// Le guet vit ici, en Rust, et non dans l'interface : une demande qui tombe
/// pendant que le cockpit est réduit ou que la webview dort doit sonner quand
/// même — c'est précisément le moment où l'on n'est pas devant l'écran.
fn watch_permissions() {
	tokio::spawn(async move {
		// Une demande annoncée ne l'est qu'une fois — mais tant que le réveil n'a
		// pas pu partir, elle reste candidate. C'est ce qui rattrape le cas le plus
		// traître : la demande tombe pendant qu'on est devant l'écran, on quitte le
		// bureau sans y avoir répondu, et plus rien ne sonne jamais.
		let mut announced: std::collections::HashSet<String> = crate::permissions::pending()
			.into_iter()
			.map(|request| request.id)
			.collect();

		loop {
			tokio::time::sleep(Duration::from_secs(2)).await;
			let pending = crate::permissions::pending();
			let live: std::collections::HashSet<String> =
				pending.iter().map(|request| request.id.clone()).collect();

			for request in &pending {
				if announced.contains(&request.id) {
					continue;
				}
				// Rédigés avant l'attente : les arguments de `tf` ne traversent pas un `await`.
				let title = t("mobile.wake.agentWaiting");
				let body = tf("mobile.wake.request", &[("tool", &request.tool)]);
				let sent = wake(&title, &body, Some(&request.id))
				.await;
				if sent {
					announced.insert(request.id.clone());
				}
			}
			announced.retain(|id| live.contains(id));
		}
	});
}

// ──────────────────────────── Garde d'entrée ────────────────────────────

/// Refus dont le motif vient du catalogue (`mobile.errors.<code>`), dans la
/// langue du poste. Le code voyage avec : la page décide sur lui, jamais sur
/// le texte, qui change d'une langue à l'autre.
fn refuse(status: StatusCode, code: &str) -> Response {
	let message = t(&format!("mobile.errors.{code}"));
	(status, Json(json!({ "error": message, "code": code }))).into_response()
}

/// Refus dont le motif est déjà rédigé (une erreur remontée d'ailleurs).
fn fail(status: StatusCode, message: &str) -> Response {
	(status, Json(json!({ "error": message }))).into_response()
}

/// Politique de contenu de la page mobile.
///
/// Les scripts et styles sont en ligne dans `mobile.html`, d'où `unsafe-inline` ;
/// tout le reste est fermé : aucune ressource tierce, aucune requête ailleurs
/// qu'ici, aucun cadre. Une injection qui passerait malgré `esc` ne pourrait
/// ni charger un script distant ni exfiltrer le jeton par `fetch`.
const CONTENT_POLICY: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; \
	style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; \
	worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; \
	form-action 'none'; frame-ancestors 'none'";

/// Première barrière de toute requête, avant même les routes.
///
/// Funnel publie sur Internet ce que `tailscale serve` réservait au tailnet. Le
/// contrôle au démarrage ne voit pas un Funnel ouvert ensuite ; mais Tailscale
/// marque chaque requête qui en vient (`Tailscale-Funnel-Request`), et efface
/// ce marqueur quand un client tente de le poser lui-même. Une requête marquée
/// vient donc d'Internet : elle est refusée, quelle que soit la route.
///
/// Au retour, les en-têtes de sécurité : pas de cadre, pas de devinette de
/// type — une « image » produite par un agent ne doit jamais s'interpréter en
/// HTML —, pas de référent, et rien de l'API en cache.
async fn gatekeeper(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
	if request.headers().contains_key("tailscale-funnel-request") {
		return refuse(StatusCode::FORBIDDEN, "publicAccessDenied");
	}
	let api = request.uri().path().starts_with("/api/");
	let mut response = next.run(request).await;
	let headers = response.headers_mut();
	use axum::http::header::{self, HeaderValue};
	headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
	headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
	headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
	headers.insert(
		header::CONTENT_SECURITY_POLICY,
		HeaderValue::from_static(CONTENT_POLICY),
	);
	if api && !headers.contains_key(header::CACHE_CONTROL) {
		headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
	}
	response
}

/// Vérifie l'hôte, le jeton, le quota — dans cet ordre, du moins cher au plus
/// cher. Rend l'appareil reconnu.
fn guard(inner: &Shared, headers: &HeaderMap) -> std::result::Result<Device, Response> {
	let host = headers
		.get("host")
		.and_then(|value| value.to_str().ok())
		.unwrap_or_default();
	let expected_local = format!("127.0.0.1:{PORT}");
	let known_host = host == inner.host
		|| host == format!("{}:443", inner.host)
		|| host == expected_local
		|| host == format!("localhost:{PORT}");
	if !known_host {
		return Err(refuse(StatusCode::MISDIRECTED_REQUEST, "unexpectedHost"));
	}

	let token = headers
		.get("authorization")
		.and_then(|value| value.to_str().ok())
		.and_then(|value| value.strip_prefix("Bearer "))
		.unwrap_or_default();
	if token.is_empty() {
		return Err(refuse(StatusCode::UNAUTHORIZED, "notPaired"));
	}

	let print = fingerprint(token);
	let config = load();
	let device = config
		.devices
		.into_iter()
		.find(|device| same_secret(&device.token_hash, &print))
		.ok_or_else(|| refuse(StatusCode::UNAUTHORIZED, "unknownDevice"))?;

	let mut hits = inner.hits.lock().unwrap_or_else(|e| e.into_inner());
	let entry = hits.entry(device.id.clone()).or_insert((0, Instant::now()));
	if entry.1.elapsed() > Duration::from_secs(60) {
		*entry = (0, Instant::now());
	}
	entry.0 += 1;
	if entry.0 > RATE_LIMIT {
		return Err(refuse(StatusCode::TOO_MANY_REQUESTS, "tooManyRequests"));
	}

	Ok(device)
}

fn touch(device_id: &str) {
	let mut config = load();
	if let Some(device) = config.devices.iter_mut().find(|entry| entry.id == device_id) {
		device.last_seen = now();
		let _ = save(&config);
	}
}

// ───────────────────────────── Appairage ─────────────────────────────

/// Ouvre une fenêtre d'appairage et rend le code à afficher en QR.
pub fn open_pairing() -> String {
	let code = pairing_code();
	if let Some(inner) = pairing_slot().lock().ok().as_mut() {
		**inner = Some((code.clone(), Instant::now()));
	}
	code
}

/// Le code vit hors du serveur : les Réglages doivent pouvoir l'ouvrir avant
/// même que le premier appareil existe.
fn pairing_slot() -> &'static Mutex<Option<(String, Instant)>> {
	static SLOT: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
	SLOT.get_or_init(|| Mutex::new(None))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
	code: String,
	name: String,
}

async fn pair(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Json(body): Json<PairBody>,
) -> Response {
	let host = headers
		.get("host")
		.and_then(|value| value.to_str().ok())
		.unwrap_or_default();
	let from_tailnet = host == inner.host || host == format!("{}:443", inner.host);
	let from_loopback =
		inner.host == "localhost" && (host == format!("localhost:{PORT}") || host == format!("127.0.0.1:{PORT}"));
	if !from_tailnet && !from_loopback {
		return refuse(StatusCode::MISDIRECTED_REQUEST, "pairingTailnetOnly");
	}

	let mut slot = pairing_slot().lock().unwrap_or_else(|e| e.into_inner());
	let Some((expected, opened)) = slot.clone() else {
		return refuse(StatusCode::FORBIDDEN, "noPairing");
	};
	if opened.elapsed() > PAIRING_TTL {
		*slot = None;
		return refuse(StatusCode::FORBIDDEN, "codeExpired");
	}
	if !same_secret(&expected, body.code.trim()) {
		return refuse(StatusCode::FORBIDDEN, "codeInvalid");
	}
	// Un code ne sert qu'une fois, même si l'appairage échoue plus loin.
	*slot = None;
	drop(slot);

	// `tailscale serve` signe les requêtes du tailnet avec l'identité de leur
	// appareil. On la garde comme trace de qui a appairé quoi — elle complète le
	// jeton, elle ne le remplace pas : un en-tête ne prouve rien à lui seul.
	let node = headers
		.get("tailscale-user-login")
		.and_then(|value| value.to_str().ok())
		.unwrap_or_default()
		.to_string();

	let token = random_token();
	let device = Device {
		id: hex(&random_bytes::<8>()),
		name: body.name.chars().take(40).collect(),
		token_hash: fingerprint(&token),
		node,
		passkey: None,
		created_at: now(),
		last_seen: now(),
	};

	let mut config = load();
	config.devices.push(device.clone());
	if let Err(error) = save(&config) {
		return fail(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
	}
	crate::journal::record("remote", &t("mobile.journal.devicePaired"), &device.name, true, "");

	Json(json!({ "deviceId": device.id, "token": token, "name": device.name })).into_response()
}

// ───────────────────────────── Clé d'accès ─────────────────────────────

async fn register_start(State(inner): State<Shared>, headers: HeaderMap) -> Response {
	let device = match guard(&inner, &headers) {
		Ok(device) => device,
		Err(response) => return response,
	};
	// Une clé d'accès ne se remplace pas avec le seul jeton d'appareil : sinon
	// qui vole ce jeton enregistre sa propre clé, et la signature Face ID ne
	// garde plus rien. Changer de clé, c'est révoquer l'appareil sur le poste
	// et l'appairer à nouveau — avec un code qui ne s'affiche que là.
	if device.passkey.is_some() {
		return refuse(StatusCode::FORBIDDEN, "passkeyExists");
	}
	if !enroll_open(&device) {
		return refuse(StatusCode::FORBIDDEN, "enrollExpired");
	}

	let user = Uuid::from_bytes(random_bytes::<16>());
	match inner
		.webauthn
		.start_passkey_registration(user, &device.name, &device.name, None)
	{
		Ok((challenge, state)) => {
			let mut registrations = inner.registrations.lock().unwrap_or_else(|e| e.into_inner());
			registrations.insert(device.id.clone(), (state, Instant::now()));
			Json(challenge).into_response()
		}
		Err(error) => fail(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
	}
}

async fn register_finish(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Json(credential): Json<RegisterPublicKeyCredential>,
) -> Response {
	let device = match guard(&inner, &headers) {
		Ok(device) => device,
		Err(response) => return response,
	};

	let state = {
		let mut registrations = inner.registrations.lock().unwrap_or_else(|e| e.into_inner());
		registrations.remove(&device.id)
	};
	let Some((state, opened)) = state else {
		return refuse(StatusCode::FORBIDDEN, "noRegistration");
	};
	if opened.elapsed() > CHALLENGE_TTL {
		return refuse(StatusCode::FORBIDDEN, "challengeExpired");
	}

	match inner.webauthn.finish_passkey_registration(&credential, &state) {
		Ok(passkey) => {
			let mut config = load();
			let Some(entry) = config.devices.iter_mut().find(|entry| entry.id == device.id) else {
				return refuse(StatusCode::UNAUTHORIZED, "unknownDevice");
			};
			// Relu sur le disque : deux enregistrements menés en parallèle ne
			// doivent pas laisser le second écraser la clé du premier.
			if entry.passkey.is_some() {
				return refuse(StatusCode::FORBIDDEN, "passkeyAlreadySet");
			}
			entry.passkey = Some(passkey);
			if let Err(error) = save(&config) {
				return fail(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
			}
			crate::journal::record("remote", &t("mobile.journal.passkeyRegistered"), &device.name, true, "");
			Json(json!({ "ok": true })).into_response()
		}
		Err(error) => fail(StatusCode::FORBIDDEN, &error.to_string()),
	}
}

// ────────────────────────────── Ce qui attend ──────────────────────────────

/// Fichier de session Claude Code d'un agent, retenu une fois trouvé.
///
/// Le balayage des sessions lit des dizaines de fichiers : le refaire à chaque
/// rafraîchissement du fil — toutes les deux secondes, sur un téléphone —
/// mettrait la machine à genoux pour retrouver le même chemin.
pub fn session_file(claude_id: &str) -> Option<String> {
	static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
	let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

	if let Ok(map) = cache.lock() {
		if let Some(path) = map.get(claude_id) {
			if std::path::Path::new(path).exists() {
				return Some(path.clone());
			}
		}
	}

	let found = crate::sessions::scan_all(40)
		.unwrap_or_default()
		.into_iter()
		.flat_map(|project| project.sessions)
		.find(|summary| summary.id == claude_id)
		.map(|summary| summary.file)?;
	if let Ok(mut map) = cache.lock() {
		map.insert(claude_id.to_string(), found.clone());
	}
	Some(found)
}

/// Vrai quand l'agent a écrit dans les dernières secondes : c'est ce qui
/// distingue « il travaille » de « il attend ta réponse », et le téléphone n'a
/// aucun autre moyen de le savoir.
pub fn recently_active(file: &str) -> bool {
	std::fs::metadata(file)
		.and_then(|meta| meta.modified())
		.map(|at| at.elapsed().map(|age| age.as_secs() < 12).unwrap_or(false))
		.unwrap_or(false)
}

/// Ce qui tourne, groupé comme sur le poste : une entrée par agent, nommée par
/// la branche de son worktree.
///
/// L'app macOS titre ses groupes de travail avec la branche — « feat/auth » dit
/// plus que « monorepo-feat-auth ». Le téléphone reprend les mêmes noms : passer de
/// l'un à l'autre ne doit pas demander de retraduire.
async fn inbox(State(inner): State<Shared>, headers: HeaderMap) -> Response {
	let device = match guard(&inner, &headers) {
		Ok(device) => device,
		Err(response) => return response,
	};
	touch(&device.id);

	let agents = inner
		.app
		.try_state::<crate::agent::SharedAgents>()
		.map(|agents| agents.snapshot())
		.unwrap_or_default();
	let pending = crate::permissions::pending();

	let mut workspaces = Vec::new();
	for status in agents {
		let path = std::path::Path::new(&status.cwd);
		let folder = path
			.file_name()
			.map(|name| name.to_string_lossy().to_string())
			.unwrap_or_else(|| status.cwd.clone());
		let branch = crate::git::current_branch(path).await.ok();

		let file = status.claude_session_id.as_deref().and_then(session_file);
		let (last, working) = match file.as_deref() {
			Some(file) => {
				let events =
					crate::sessions::read_timeline(std::path::Path::new(file), 400)
						.unwrap_or_default();
				let last = events
					.iter()
					.rev()
					.find(|event| event.kind == "assistant" || event.kind == "user")
					.map(|event| event.text.chars().take(140).collect::<String>())
					.unwrap_or_default();
				(last, recently_active(file))
			}
			None => (String::new(), false),
		};

		let waiting = pending
			.iter()
			.filter(|request| request.session_id.as_deref() == Some(status.session_id.as_str()))
			.count();

		workspaces.push(json!({
			// Son navigateur tourne : le téléphone peut en demander l'image.
			"screen": crate::browser::running(&status.cwd).await,
			"project": crate::config::project_named(&status.cwd),
			"sessionId": status.session_id,
			"label": branch.clone().unwrap_or_else(|| folder.clone()),
			"folder": folder,
			"branch": branch,
			"cwd": status.cwd,
			"running": status.running,
			"working": working,
			"waiting": waiting,
			"last": last,
		}));
	}

	// Les repères d'abonnement voyagent avec l'inbox : c'est depuis le téléphone
	// qu'on configure l'app de notifications, et recopier un sujet à la main
	// depuis l'écran du Mac est le meilleur moyen de se tromper de sujet.
	let config = load();
	Json(json!({
		"permissions": pending,
		"workspaces": workspaces,
		"armed": device.passkey.is_some(),
		"enrollOpen": enroll_open(&device),
		"device": device.name,
		"missions": crate::mission::list()
			.iter()
			.filter(|mission| !matches!(mission.state, crate::mission::MissionState::Done))
			.map(|mission| json!({
				"id": mission.id,
				"title": mission.title,
				"ticket": mission.ticket,
				"state": mission.state,
				"plan": mission.plan,
				"summary": mission.summary,
				"branch": mission.branch,
				"paused": mission.paused,
				// Le téléphone ne bascule pas de projet : il montre tout ce qui
				// tourne, sur tous les dépôts. Encore faut-il savoir lequel — deux
				// missions de deux produits se ressemblent beaucoup de loin.
				"project": crate::config::project_named(&mission.cwd),
				"tasks": mission.tasks.iter().map(|task| json!({
					"role": task.role,
					"title": task.title,
					"state": task.state,
					"scope": task.scope,
					// De quoi ouvrir sa conversation : suivre un exécutant depuis
					// la mission évitait sinon de le chercher dans la liste des
					// workspaces, où rien ne dit à quelle tâche il répond.
					"sessionId": task.session_id,
					"note": task.note,
				})).collect::<Vec<_>>(),
			}))
			.collect::<Vec<_>>(),
		"notify": {
			"topic": config.ntfy_topic,
			"server": format!("https://{}:8443", inner.host),
		},
	}))
	.into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptQuery {
	/// Nombre d'événements déjà affichés : on ne renvoie que la suite.
	#[serde(default)]
	since: usize,
}

/// Le fil d'un agent, en incrémental.
///
/// Renvoyer la conversation entière toutes les deux secondes ferait chauffer le
/// téléphone pour rien : la page dit ce qu'elle a déjà, le serveur complète.
/// Un `since` plus grand que le fil — conversation repartie de zéro — renvoie
/// tout, plutôt qu'un silence qu'on prendrait pour une panne.
async fn transcript(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Path(session): Path<String>,
	axum::extract::Query(query): axum::extract::Query<TranscriptQuery>,
) -> Response {
	if let Err(response) = guard(&inner, &headers) {
		return response;
	}

	let status = inner
		.app
		.try_state::<crate::agent::SharedAgents>()
		.map(|agents| agents.snapshot())
		.unwrap_or_default()
		.into_iter()
		.find(|status| status.session_id == session);
	let Some(status) = status else {
		return refuse(StatusCode::NOT_FOUND, "agentGone");
	};

	let file = status.claude_session_id.as_deref().and_then(session_file);
	let Some(file) = file else {
		// L'agent démarre : son fichier de session n'existe pas encore.
		return Json(json!({ "events": [], "total": 0, "working": true })).into_response();
	};

	let events = crate::sessions::read_timeline(std::path::Path::new(&file), 2000)
		.unwrap_or_default();
	let total = events.len();
	let from = if query.since > total { 0 } else { query.since };

	Json(json!({
		"events": events.into_iter().skip(from).collect::<Vec<_>>(),
		"from": from,
		"total": total,
		"working": recently_active(&file),
		"running": status.running,
	}))
	.into_response()
}

// ───────────────────────── Ce que l'agent donne à voir ─────────────────────────
//
// Trois lectures, et rien d'autre : ce que le dépôt dit de son travail, les
// images qu'il a produites dans son dossier, et la page de son navigateur.
// Aucune n'engage quoi que ce soit ; toutes passent la même garde que le reste.

/// Le dossier de travail d'un agent actif — le seul que le téléphone peut lire.
fn agent_cwd(inner: &Shared, session: &str) -> Option<String> {
	inner
		.app
		.try_state::<crate::agent::SharedAgents>()
		.map(|agents| agents.snapshot())
		.unwrap_or_default()
		.into_iter()
		.find(|status| status.session_id == session)
		.map(|status| status.cwd)
}

/// Le constat : ce que `git diff` dit du travail de l'agent. Des noms de
/// fichiers et des volumes, jamais leur contenu.
async fn changes(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Path(session): Path<String>,
) -> Response {
	if let Err(response) = guard(&inner, &headers) {
		return response;
	}
	let Some(cwd) = agent_cwd(&inner, &session) else {
		return refuse(StatusCode::NOT_FOUND, "agentGone");
	};
	match crate::tour::changes(std::path::Path::new(&cwd), None).await {
		Ok(found) => Json(json!({
			"baseLabel": found.base_label,
			"files": found.files,
			"additions": found.additions,
			"deletions": found.deletions,
		}))
		.into_response(),
		// Pas un dépôt git : il n'y a simplement rien à constater.
		Err(_) => Json(json!({ "files": [] })).into_response(),
	}
}

#[derive(Deserialize)]
struct MediaQuery {
	path: String,
}

/// Une image que l'agent a produite. Deux verrous : c'est une image, et elle
/// vit dans son dossier de travail — une fois les liens symboliques et les
/// `..` résolus. Le téléphone ne lit aucun autre fichier du poste.
async fn media(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Path(session): Path<String>,
	axum::extract::Query(query): axum::extract::Query<MediaQuery>,
) -> Response {
	if let Err(response) = guard(&inner, &headers) {
		return response;
	}
	let Some(cwd) = agent_cwd(&inner, &session) else {
		return refuse(StatusCode::NOT_FOUND, "agentGone");
	};
	let kind = match std::path::Path::new(&query.path)
		.extension()
		.map(|extension| extension.to_string_lossy().to_lowercase())
		.as_deref()
	{
		Some("png") => "image/png",
		Some("jpg") | Some("jpeg") => "image/jpeg",
		Some("gif") => "image/gif",
		Some("webp") => "image/webp",
		_ => return refuse(StatusCode::FORBIDDEN, "imagesOnly"),
	};
	let root = std::path::Path::new(&cwd);
	let asked = std::path::Path::new(&query.path);
	let target = if asked.is_absolute() { asked.to_path_buf() } else { root.join(asked) };
	let (Ok(root), Ok(target)) = (root.canonicalize(), target.canonicalize()) else {
		return refuse(StatusCode::NOT_FOUND, "imageNotFound");
	};
	if !target.starts_with(&root) {
		return refuse(StatusCode::FORBIDDEN, "outsideFolder");
	}
	match std::fs::metadata(&target) {
		Ok(meta) if meta.len() <= 12 * 1_048_576 => {}
		_ => return refuse(StatusCode::NOT_FOUND, "imageTooLarge"),
	}
	match std::fs::read(&target) {
		Ok(bytes) => ([("content-type", kind), ("cache-control", "private, max-age=300")], bytes).into_response(),
		Err(_) => refuse(StatusCode::NOT_FOUND, "imageNotFound"),
	}
}

/// La page du navigateur de l'agent, à l'instant. Rien n'est lancé pour le
/// téléphone : sans navigateur déjà ouvert, il n'y a pas d'image.
async fn screen(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Path(session): Path<String>,
) -> Response {
	if let Err(response) = guard(&inner, &headers) {
		return response;
	}
	let Some(cwd) = agent_cwd(&inner, &session) else {
		return refuse(StatusCode::NOT_FOUND, "agentGone");
	};
	match crate::browser::snapshot(&cwd).await {
		Some((bytes, url)) => {
			// L'adresse voyage en en-tête, encodée : elle peut porter n'importe quoi.
			let url = urlencoding::encode(&url).into_owned();
			([("content-type", "image/jpeg".to_string()), ("x-page-url", url)], bytes).into_response()
		}
		None => refuse(StatusCode::NOT_FOUND, "browserNotRunning"),
	}
}

// ─────────────────────────────── Décisions ───────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DenyBody {
	id: String,
}

/// Refuser ne demande pas de signature : au pire, un agent attend. C'est
/// l'action qu'on veut la plus rapide possible, y compris depuis la
/// notification.
async fn deny(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Json(body): Json<DenyBody>,
) -> Response {
	let device = match guard(&inner, &headers) {
		Ok(device) => device,
		Err(response) => return response,
	};
	match crate::permissions::answer(&body.id, false, Some("Denied from mobile.".into())) {
		Ok(()) => {
			crate::journal::record("remote", &t("mobile.journal.toolDenied"), &body.id, true, &device.name);
			Json(json!({ "ok": true })).into_response()
		}
		Err(error) => fail(StatusCode::BAD_REQUEST, &error.to_string()),
	}
}

/// Bouton « Refuser » d'une notification : un jeton à usage unique, sans
/// jeton d'appareil, parce que l'app ntfy ne sait pas en porter un.
async fn quick_deny(State(inner): State<Shared>, Path(nonce): Path<String>) -> Response {
	let target = {
		let mut nonces = inner.deny_nonces.lock().unwrap_or_else(|e| e.into_inner());
		nonces.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(3600));
		nonces.remove(&nonce)
	};
	let Some((id, _)) = target else {
		return refuse(StatusCode::FORBIDDEN, "denyLinkExpired");
	};
	match crate::permissions::answer(&id, false, Some("Denied from the notification.".into())) {
		Ok(()) => {
			crate::journal::record("remote", &t("mobile.journal.toolDenied"), &id, true, "notification");
			Html(format!("<p>{}</p>", t("mobile.remote.quickDenied"))).into_response()
		}
		Err(error) => fail(StatusCode::BAD_REQUEST, &error.to_string()),
	}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeBody {
	#[serde(flatten)]
	action: Action,
}

/// Ouvre un défi Face ID pour une action précise.
async fn challenge(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Json(body): Json<ChallengeBody>,
) -> Response {
	let device = match guard(&inner, &headers) {
		Ok(device) => device,
		Err(response) => return response,
	};
	let Some(passkey) = device.passkey.clone() else {
		return refuse(StatusCode::FORBIDDEN, "noPasskey");
	};

	match inner.webauthn.start_passkey_authentication(&[passkey]) {
		Ok((request, state)) => {
			let id = hex(&random_bytes::<16>());
			let mut challenges = inner.challenges.lock().unwrap_or_else(|e| e.into_inner());
			challenges.retain(|_, pending| pending.at.elapsed() < CHALLENGE_TTL);
			challenges.insert(
				id.clone(),
				PendingAction {
					device: device.id.clone(),
					action: body.action,
					state,
					at: Instant::now(),
				},
			);
			Json(json!({ "actionId": id, "options": request })).into_response()
		}
		Err(error) => fail(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
	}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteBody {
	action_id: String,
	credential: PublicKeyCredential,
}

/// Vérifie la signature, puis exécute — et seulement ce que le défi disait.
async fn execute(
	State(inner): State<Shared>,
	headers: HeaderMap,
	Json(body): Json<ExecuteBody>,
) -> Response {
	let device = match guard(&inner, &headers) {
		Ok(device) => device,
		Err(response) => return response,
	};

	let pending = {
		let mut challenges = inner.challenges.lock().unwrap_or_else(|e| e.into_inner());
		challenges.remove(&body.action_id)
	};
	let Some(pending) = pending else {
		return refuse(StatusCode::FORBIDDEN, "challengeUnknown");
	};
	if pending.device != device.id {
		return refuse(StatusCode::FORBIDDEN, "challengeOtherDevice");
	}
	if pending.at.elapsed() > CHALLENGE_TTL {
		return refuse(StatusCode::FORBIDDEN, "challengeExpired");
	}
	if inner
		.webauthn
		.finish_passkey_authentication(&body.credential, &pending.state)
		.is_err()
	{
		crate::journal::record("remote", &t("mobile.journal.signatureRejected"), &device.name, false, "");
		return refuse(StatusCode::FORBIDDEN, "invalidSignature");
	}

	match pending.action {
		Action::AllowTool { id } => {
			match crate::permissions::answer(&id, true, Some("Allowed from mobile.".into())) {
				Ok(()) => {
					crate::journal::record("remote", &t("mobile.journal.toolAllowed"), &id, true, &device.name);
					Json(json!({ "ok": true })).into_response()
				}
				Err(error) => fail(StatusCode::BAD_REQUEST, &error.to_string()),
			}
		}
		// Approuver un plan libère les exécutants : c'est une décision, elle
		// passe donc par la même signature que les autres.
		Action::ApprovePlan { id } => match crate::mission::approve(&id) {
			Ok(mission) => {
				crate::journal::record(
					"mission",
					&t("mobile.journal.planApproved"),
					&mission.title,
					true,
					&device.name,
				);
				Json(json!({ "ok": true, "tasks": mission.tasks.len() })).into_response()
			}
			Err(error) => fail(StatusCode::BAD_REQUEST, &error.to_string()),
		},
		// Suspendre et arrêter coupent des agents : ce sont des décisions, elles
		// passent par la même signature que les autres.
		Action::PauseMission { id } => {
			let stopped = crate::stop_mission_agents(&inner.app, &id);
			match crate::mission::set_paused(&id, true) {
				Ok(mission) => {
					crate::journal::record(
						"mission",
						&t("mobile.journal.missionPaused"),
						&mission.title,
						true,
						&device.name,
					);
					Json(json!({ "ok": true, "stopped": stopped })).into_response()
				}
				Err(error) => fail(StatusCode::BAD_REQUEST, &error.to_string()),
			}
		}
		Action::StopMission { id } => {
			let stopped = crate::stop_mission_agents(&inner.app, &id);
			let _ = crate::mission::set_paused(&id, true);
			match crate::mission::set_state(
				&id,
				crate::mission::MissionState::Failed,
				&t("mobile.remote.missionStoppedNote"),
			) {
				Ok(mission) => {
					crate::journal::record(
						"mission",
						&t("mobile.journal.missionStopped"),
						&mission.title,
						true,
						&device.name,
					);
					Json(json!({ "ok": true, "stopped": stopped })).into_response()
				}
				Err(error) => fail(StatusCode::BAD_REQUEST, &error.to_string()),
			}
		}
		Action::AnswerQuestion { id, answers } => {
			let lines = answers
				.iter()
				.map(|answer| format!("- {}: {}", answer.header, answer.choice))
				.collect::<Vec<_>>()
				.join("\n");
			// Le motif part vers l'agent : c'est une consigne, donc en anglais,
			// avec la directive de langue pour la suite de la conversation.
			let reason = format!(
				"The user's answers, given from mobile:\n{lines}\n\
				 Continue with these answers, without calling AskUserQuestion again. {}",
				crate::i18n::reply_directive()
			);
			match crate::permissions::answer(&id, false, Some(reason)) {
				Ok(()) => {
					crate::journal::record("remote", &t("mobile.journal.questionAnswered"), &id, true, &device.name);
					Json(json!({ "ok": true })).into_response()
				}
				Err(error) => fail(StatusCode::BAD_REQUEST, &error.to_string()),
			}
		}
		Action::Message { session_id, text } => {
			let Some(agents) = inner.app.try_state::<crate::agent::SharedAgents>() else {
				return refuse(StatusCode::SERVICE_UNAVAILABLE, "noAgents");
			};
			match crate::agent::send(&inner.app, &agents, &session_id, &text).await {
				Ok(()) => {
					crate::journal::record(
						"remote",
						&t("mobile.journal.messageSent"),
						&session_id,
						true,
						&device.name,
					);
					Json(json!({ "ok": true })).into_response()
				}
				Err(error) => fail(StatusCode::BAD_REQUEST, &error.to_string()),
			}
		}
	}
}

// ──────────────────────────────── La page ────────────────────────────────

async fn page() -> Html<String> {
	Html(render_page(&crate::i18n::lang()))
}

/// La page, dans une langue : son attribut `lang` (qui règle aussi les
/// pluriels et les dates côté page) et son catalogue, fusionné sur l'anglais,
/// posé en tête avant tout autre script.
///
/// Le JSON vit dans une balise `<script>` : une traduction qui contiendrait
/// `</script>` la fermerait. D'où `<\/`, que JSON lit comme `</`.
fn render_page(lang: &str) -> String {
	let catalog = crate::i18n::namespace_for(lang, "mobile");
	let json = serde_json::to_string(&catalog)
		.unwrap_or_else(|_| "{}".into())
		.replace("</", "<\\/");
	include_str!("mobile.html")
		.replacen(r#"<html lang="en">"#, &format!(r#"<html lang="{lang}">"#), 1)
		.replacen(
			"<head>",
			&format!("<head>\n\t\t<script>window.I18N = {json};</script>"),
			1,
		)
}

/// La palette, telle que l'app du poste l'utilise.
///
/// Le fichier est celui du dépôt, embarqué à la compilation : les deux
/// interfaces ne peuvent donc pas diverger d'une version à l'autre.
async fn tokens() -> Response {
	(
		[("content-type", "text/css; charset=utf-8")],
		include_str!("../../src/tokens.css"),
	)
		.into_response()
}

async fn manifest() -> Response {
	(
		[("content-type", "application/manifest+json")],
		include_str!("mobile.webmanifest"),
	)
		.into_response()
}

/// Service worker minimal : iOS n'installe une page sur l'écran d'accueil que
/// si elle en déclare un, et l'installation est ce qui autorise les
/// notifications. Il ne met rien en cache — l'app doit toujours refléter
/// l'état réel de la machine.
async fn service_worker() -> Response {
	(
		[("content-type", "application/javascript")],
		"self.addEventListener('fetch', () => {});\n",
	)
		.into_response()
}

// ───────────────────────────────── Réveil ─────────────────────────────────

/// Prévient le téléphone qu'une décision l'attend.
///
/// Le message ne dit rien de ce qui se passe : le serveur ntfy local n'envoie à
/// son relais que l'identifiant du message et l'empreinte du topic, et c'est le
/// téléphone qui vient chercher le contenu ici, à travers le tailnet. Autant
/// que ce contenu reste maigre.
pub async fn wake(title: &str, body: &str, permission_id: Option<&str>) -> bool {
	let config = load();
	if !config.enabled || config.ntfy_topic.is_empty() {
		return false;
	}
	// Devant l'écran, on a déjà la notification du poste et la demande sous les
	// yeux : faire sonner le téléphone en plus n'apprend rien, et apprend surtout
	// à ignorer les notifications.
	if let Some(handle) = SERVER.get() {
		let focused = handle
			.app
			.get_webview_window("main")
			.and_then(|window| window.is_focused().ok())
			.unwrap_or(false);
		if focused {
			return false;
		}
	}

	let mut actions = Vec::new();
	if let Some(id) = permission_id {
		let nonce = hex(&random_bytes::<16>());
		if let Some(handle) = SERVER.get() {
			let mut nonces = handle.deny_nonces.lock().unwrap_or_else(|e| e.into_inner());
			nonces.insert(nonce.clone(), (id.to_string(), Instant::now()));
			actions.push(format!(
				"http, {}, {}/api/quick-deny/{nonce}, method=GET, clear=true",
				action_label("mobile.wake.deny"),
				handle.base_url
			));
			actions.push(format!(
				"view, {}, {}/, clear=true",
				action_label("mobile.wake.open"),
				handle.base_url
			));
		}
	}

	let client = reqwest::Client::new();
	let mut request = client
		.post(format!("{}/{}", config.ntfy_server, config.ntfy_topic))
		.header("Title", title)
		.header("Priority", "high")
		.body(body.to_string());
	if !config.ntfy_token.is_empty() {
		request = request.header("Authorization", format!("Bearer {}", config.ntfy_token));
	}
	if !actions.is_empty() {
		request = request.header("Actions", actions.join("; "));
	}
	// Le verdict est consigné : c'est ce qui manquait pour voir un relais cassé
	// autrement qu'en constatant, des heures plus tard, que le téléphone n'a
	// jamais sonné.
	match request.send().await {
		Ok(response) if response.status().is_success() => {
			record_wake(true, tf("mobile.wake.published", &[("status", &response.status())]));
			true
		}
		Ok(response) => {
			let status = response.status();
			record_wake(
				false,
				match status.as_u16() {
					401 | 403 => tf("mobile.wake.rejectedToken", &[("status", &status)]),
					429 => tf("mobile.wake.rejectedRate", &[("status", &status)]),
					_ => tf("mobile.wake.rejected", &[("status", &status)]),
				},
			);
			false
		}
		Err(error) => {
			record_wake(false, tf("mobile.wake.unreachable", &[("error", &error)]));
			false
		}
	}
}

/// Libellé d'un bouton de notification. L'en-tête `Actions` de ntfy sépare ses
/// champs par des virgules et ses actions par des points-virgules : une
/// traduction qui en contiendrait casserait le bouton.
fn action_label(key: &str) -> String {
	t(key).replace([',', ';'], " ")
}

/// Poignée du serveur en cours, pour les fonctions appelées hors requête.
static SERVER: OnceLock<Shared> = OnceLock::new();

#[cfg(test)]
mod tests {
	use super::*;

	/// Le contrat entre la page mobile et le serveur, verrouillé.
	///
	/// Ces trois corps sont exactement ce que `mobile.html` envoie. Une faute de
	/// nommage ici ne se voit pas à la compilation : elle se traduit par un 422
	/// muet au moment précis où l'on répond à un agent depuis son téléphone.
	#[test]
	fn actions_du_mobile() {
		let allow: Action = serde_json::from_str(r#"{"kind":"allowTool","id":"abc"}"#).unwrap();
		assert!(matches!(allow, Action::AllowTool { id } if id == "abc"));

		let message: Action =
			serde_json::from_str(r#"{"kind":"message","sessionId":"s1","text":"salut"}"#).unwrap();
		match message {
			Action::Message { session_id, text } => {
				assert_eq!(session_id, "s1");
				assert_eq!(text, "salut");
			}
			other => panic!("variante inattendue : {other:?}"),
		}

		let answer: Action = serde_json::from_str(
			r#"{"kind":"answerQuestion","id":"q1","answers":[{"header":"Base","choice":"dev"}]}"#,
		)
		.unwrap();
		match answer {
			Action::AnswerQuestion { id, answers } => {
				assert_eq!(id, "q1");
				assert_eq!(answers[0].choice, "dev");
			}
			other => panic!("variante inattendue : {other:?}"),
		}
	}

	/// La page part avec sa langue et son catalogue, posé avant tout script, et
	/// aucune traduction ne peut fermer la balise qui le porte.
	#[test]
	fn la_page_porte_sa_langue() {
		let page = render_page("fr");
		assert!(page.contains(r#"<html lang="fr">"#));
		let start = page.find("window.I18N = ").expect("catalogue absent");
		assert!(start < page.find("prefers-color-scheme").unwrap());
		let end = start + page[start..].find("</script>").unwrap();
		let json = &page[start + "window.I18N = ".len()..end].trim_end_matches(';');
		let catalog: Value = serde_json::from_str(json).expect("catalogue illisible");
		assert_eq!(catalog.pointer("/common/connecting").and_then(Value::as_str), Some("Connexion…"));
	}

	/// Chaque clé lue en dur par la page existe en anglais : une clé oubliée
	/// s'afficherait telle quelle sur le téléphone.
	#[test]
	fn les_cles_de_la_page_existent() {
		let page = include_str!("mobile.html");
		let catalog = crate::i18n::namespace_for("en", "mobile");
		let has = |key: &str| {
			let pointer = |k: &str| format!("/{}", k.replace('.', "/"));
			catalog.pointer(&pointer(key)).is_some()
				|| catalog.pointer(&pointer(&format!("{key}_other"))).is_some()
		};
		let mut checked = 0;
		for opener in ["t(\"", "th(\"", "data-i18n=\"", "data-i18n-placeholder=\"", "data-i18n-aria-label=\""] {
			for (index, _) in page.match_indices(opener) {
				// `t(` au milieu d'un mot (`set(`, `split(`…) n'est pas une traduction.
				if index > 0 && page.as_bytes()[index - 1].is_ascii_alphanumeric() {
					continue;
				}
				let rest = &page[index + opener.len()..];
				let key = &rest[..rest.find('"').unwrap()];
				assert!(has(key), "clé absente du catalogue anglais : {key}");
				checked += 1;
			}
		}
		assert!(checked > 50, "trop peu de clés trouvées : {checked}");
	}

	/// Deux empreintes de longueurs différentes ne doivent jamais se confondre,
	/// et deux identiques doivent se reconnaître.
	#[test]
	fn comparaison_de_secrets() {
		assert!(same_secret("abcd", "abcd"));
		assert!(!same_secret("abcd", "abce"));
		assert!(!same_secret("abcd", "abcde"));
	}
}

#[cfg(test)]
mod design_tests {
	/// Les deux interfaces doivent tirer leurs couleurs du même fichier.
	///
	/// Ce test ne vérifie pas une valeur, mais une propriété : la page mobile
	/// n'a pas le droit de redéfinir la palette dans son coin. C'est ainsi
	/// qu'elle avait divergé — une teinte changée sur le poste, l'autre écran
	/// restant en arrière sans que rien ne le signale.
	#[test]
	fn la_page_mobile_ne_redefinit_pas_la_palette() {
		let page = include_str!("mobile.html");
		assert!(
			page.contains(r#"href="/tokens.css""#),
			"la page doit charger les jetons partagés"
		);

		let tokens = include_str!("../../src/tokens.css");
		for name in ["--accent", "--critical", "--ink", "--surface"] {
			assert!(tokens.contains(&format!("{name}:")), "{name} manque aux jetons");
			assert!(
				!page.contains(&format!("{name}: #")),
				"{name} est redéfini en dur dans la page mobile"
			);
		}
	}
}
