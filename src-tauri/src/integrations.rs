//! Connecteurs vers les services de la chaîne de livraison.
//!
//! Tous les appels partent du process Rust, jamais du webview : les tokens ne
//! transitent pas par le front et on échappe aux restrictions CORS. Chaque
//! service est ramené à une forme commune (`FeedItem`) pour que l'UI ait un
//! rendu homogène, avec un `payload` brut disponible pour les vues détaillées.

use crate::config::Config;
use crate::error::{CockpitError, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

/// Un mot passé au shell sans qu'il puisse en sortir.
fn shell_word(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

fn client() -> Result<reqwest::Client> {
	reqwest::Client::builder()
		.timeout(Duration::from_secs(20))
		.user_agent("cockpit/0.1")
		.build()
		.map_err(CockpitError::from)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaField {
	pub label: String,
	pub value: String,
}

fn meta(label: &str, value: impl Into<String>) -> MetaField {
	MetaField {
		label: label.into(),
		value: value.into(),
	}
}

/// Étiquette montrée dès la liste, sans ouvrir l'élément.
///
/// Les champs `meta` ne se lisent que dans la fiche : suffisant pour le détail,
/// trop tard pour trier une liste de PR. Un tag est la même information promue
/// au rang de repère visuel — label de PR, priorité d'un ticket.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
	pub label: String,
	/// Couleur d'origine (hexadécimal sans `#`), quand la source en fournit une.
	pub color: String,
	/// Gravité normalisée, pour les tags sans couleur propre : `critical` |
	/// `warning` | `info` | `success` | `neutral`.
	pub tone: String,
}

fn tag(label: impl Into<String>, color: impl Into<String>, tone: &str) -> Tag {
	Tag {
		label: label.into(),
		color: color.into(),
		tone: tone.into(),
	}
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
	pub id: String,
	pub source: String,
	pub title: String,
	pub subtitle: String,
	/// Statut brut du service (`unresolved`, `open`, `SUCCESS`…).
	pub status: String,
	/// Gravité normalisée : `critical` | `warning` | `info` | `success`.
	pub severity: String,
	pub url: String,
	pub timestamp: Option<String>,
	pub meta: Vec<MetaField>,
	/// Repères lus dès la liste : labels de PR, priorité d'un ticket.
	pub tags: Vec<Tag>,
	pub payload: Value,
}

fn text(value: &Value, pointer: &str) -> String {
	value
		.pointer(pointer)
		.and_then(|v| v.as_str())
		.unwrap_or_default()
		.to_string()
}

/// Durée pendant laquelle une réponse GET est réutilisée telle quelle.
///
/// Les écrans se rafraîchissent toutes les deux minutes, mais on navigue entre
/// onglets bien plus souvent que ça : sans mémoire courte, chaque aller-retour
/// refrappait l'API pour un résultat identique. Soixante secondes suffisent à
/// absorber la navigation sans jamais donner l'impression de données figées.
const GET_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

fn get_cache() -> &'static std::sync::Mutex<HashMap<String, (std::time::Instant, Value)>> {
	static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, (std::time::Instant, Value)>>> =
		std::sync::OnceLock::new();
	CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Vide la mémoire courte : le bouton « rafraîchir » doit vraiment rafraîchir.
pub fn clear_get_cache() {
	if let Ok(mut store) = get_cache().lock() {
		store.clear();
	}
}

async fn json_get(url: &str, token: &str, scheme: &str) -> Result<Value> {
	if let Ok(store) = get_cache().lock() {
		if let Some((at, value)) = store.get(url) {
			if at.elapsed() < GET_CACHE_TTL {
				return Ok(value.clone());
			}
		}
	}

	let value = json_get_uncached(url, token, scheme).await?;
	if let Ok(mut store) = get_cache().lock() {
		// Purge opportuniste : sans elle, la table grossirait indéfiniment au fil
		// des URL paginées.
		store.retain(|_, (at, _)| at.elapsed() < GET_CACHE_TTL);
		store.insert(url.to_string(), (std::time::Instant::now(), value.clone()));
	}
	Ok(value)
}

async fn json_get_uncached(url: &str, token: &str, scheme: &str) -> Result<Value> {
	let auth = if scheme.is_empty() {
		token.to_string()
	} else {
		format!("{scheme} {token}")
	};
	let response = client()?
		.get(url)
		.header("Authorization", auth)
		.header("Accept", "application/json")
		.send()
		.await?;

	let status = response.status();
	let body = response.text().await?;
	if !status.is_success() {
		return Err(CockpitError::msg(format!(
			"{status} — {}",
			body.chars().take(400).collect::<String>()
		)));
	}
	serde_json::from_str(&body).map_err(|e| {
		CockpitError::msg(crate::i18n::tf(
			"integrations.unreadableResponseBody",
			&[("error", &e), ("body", &&body[..body.len().min(200)])],
		))
	})
}

/// Refuse un token dont le préfixe ne correspond pas à ce qu'attend l'API.
///
/// Sans ce garde-fou, une clé du mauvais type part sur le réseau et revient en
/// 401/403 brut : le message parle de scopes ou de secret key alors que le seul
/// geste utile est « colle l'autre clé ». On le dit donc avant l'appel.
fn expect_token_kind(token: &str, accepted: &[&str], explanation: &str) -> Result<()> {
	if accepted.iter().any(|prefix| token.starts_with(prefix)) {
		return Ok(());
	}
	Err(CockpitError::msg(explanation))
}

// ─────────────────────────────── Sentry ───────────────────────────────

/// Slug de l'organisation, déduit du token quand il n'est pas configuré.
///
/// Renseigner ce slug à la main est le premier piège de l'écran Réglages : le
/// token seul suffit à retrouver les organisations accessibles, autant les
/// demander à Sentry et ne solliciter l'utilisateur que si le choix est ambigu.
async fn sentry_org(config: &Config) -> Result<String> {
	let configured = config.sentry.org.trim();
	if !configured.is_empty() {
		return Ok(configured.to_string());
	}

	let value = json_get("https://sentry.io/api/0/organizations/", &config.sentry.token, "Bearer").await?;

	let slugs: Vec<String> = value
		.as_array()
		.map(|orgs| {
			orgs.iter()
				.map(|org| text(org, "/slug"))
				.filter(|slug| !slug.is_empty())
				.collect()
		})
		.unwrap_or_default();

	match slugs.as_slice() {
		[] => Err(CockpitError::msg(crate::i18n::t("integrations.sentryNoOrg"))),
		[only] => Ok(only.clone()),
		several => Err(CockpitError::msg(crate::i18n::tf(
			"integrations.sentrySeveralOrgs",
			&[("orgs", &several.join(", "))],
		))),
	}
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentryProject {
	pub slug: String,
	pub name: String,
}

/// Projets de l'organisation, pour que les Réglages proposent des cases à
/// cocher plutôt qu'une liste de slugs à taper de mémoire.
pub async fn sentry_projects(config: &Config) -> Result<Vec<SentryProject>> {
	if config.sentry.token.is_empty() {
		return Err(CockpitError::missing("Sentry"));
	}
	let org = sentry_org(config).await?;
	let value = json_get(
		&format!("https://sentry.io/api/0/organizations/{org}/projects/"),
		&config.sentry.token,
		"Bearer",
	)
	.await?;

	let mut projects: Vec<SentryProject> = value
		.as_array()
		.map(|list| {
			list.iter()
				.map(|project| SentryProject {
					slug: text(project, "/slug"),
					name: text(project, "/name"),
				})
				.filter(|project| !project.slug.is_empty())
				.collect()
		})
		.unwrap_or_default();
	projects.sort_by(|a, b| a.slug.cmp(&b.slug));
	Ok(projects)
}

pub async fn sentry_issues(config: &Config, query: &str) -> Result<Vec<FeedItem>> {
	if config.sentry.token.is_empty() {
		return Err(CockpitError::missing("Sentry"));
	}

	let org = sentry_org(config).await?;
	let mut url = format!(
		"https://sentry.io/api/0/organizations/{org}/issues/?statsPeriod=14d&limit=50&query={}",
		urlencoding::encode(query)
	);
	for project in &config.sentry.projects {
		url.push_str(&format!("&project={}", urlencoding::encode(project)));
	}

	let value = json_get(&url, &config.sentry.token, "Bearer").await?;
	let Some(issues) = value.as_array() else {
		return Ok(Vec::new());
	};

	Ok(issues
		.iter()
		.map(|issue| {
			let level = text(issue, "/level");
			FeedItem {
				id: text(issue, "/id"),
				source: "sentry".into(),
				title: text(issue, "/title"),
				subtitle: text(issue, "/culprit"),
				status: text(issue, "/status"),
				severity: match level.as_str() {
					"fatal" | "error" => "critical",
					"warning" => "warning",
					_ => "info",
				}
				.into(),
				url: text(issue, "/permalink"),
				timestamp: issue.get("lastSeen").and_then(|v| v.as_str()).map(String::from),
				meta: vec![
					meta("projet", text(issue, "/project/slug")),
					meta(
						"occurrences",
						issue
							.get("count")
							.map(|v| v.to_string().trim_matches('"').to_string())
							.unwrap_or_default(),
					),
					meta(
						"utilisateurs",
						issue.get("userCount").map(|v| v.to_string()).unwrap_or_default(),
					),
					meta("niveau", level),
				],
				tags: Vec::new(),
				payload: issue.clone(),
			}
		})
		.collect())
}

/// Crée un ticket Linear et renvoie `(identifiant, url)`.
pub async fn linear_create_issue(
	config: &Config,
	team_id: &str,
	title: &str,
	description: &str,
) -> Result<(String, String)> {
	if config.linear.token.is_empty() {
		return Err(CockpitError::missing("Linear"));
	}

	let response = client()?
		.post("https://api.linear.app/graphql")
		.header("Authorization", &config.linear.token)
		.json(&json!({
			"query": "mutation Create($input: IssueCreateInput!) {
				issueCreate(input: $input) { success issue { identifier url } }
			}",
			"variables": { "input": {
				"teamId": team_id,
				"title": title,
				"description": description,
			}},
		}))
		.send()
		.await?;

	let body: Value = response.json().await?;
	if let Some(first) = body
		.get("errors")
		.and_then(|v| v.as_array())
		.and_then(|errors| errors.first())
	{
		return Err(CockpitError::msg(format!("Linear : {}", text(first, "/message"))));
	}

	let identifier = text(&body, "/data/issueCreate/issue/identifier");
	let url = text(&body, "/data/issueCreate/issue/url");
	if identifier.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.linearNotCreated")));
	}
	Ok((identifier, url))
}

/// Un identifiant d'issue Sentry ne sort pas de son segment d'URL : sans ce
/// garde-fou, `../..` viserait un autre point de l'API avec le même jeton.
fn sentry_issue_segment(issue_id: &str) -> Result<&str> {
	let id = issue_id.trim();
	if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.sentryInvalidIssue",
			&[("id", &issue_id)],
		)));
	}
	Ok(id)
}

/// Ajoute une note sur une issue Sentry.
///
/// C'est ce qui empêche de recréer deux fois le même ticket : la trace reste
/// visible là où on triage, sans dépendre de l'intégration Linear officielle.
pub async fn sentry_add_comment(config: &Config, issue_id: &str, note: &str) -> Result<()> {
	let issue_id = sentry_issue_segment(issue_id)?;
	if config.sentry.token.is_empty() {
		return Err(CockpitError::missing("Sentry"));
	}
	let response = client()?
		.post(format!("https://sentry.io/api/0/issues/{issue_id}/comments/"))
		.header("Authorization", format!("Bearer {}", config.sentry.token))
		.json(&json!({ "text": note }))
		.send()
		.await?;

	if !response.status().is_success() {
		let code = response.status();
		let body = response.text().await.unwrap_or_default();
		return Err(CockpitError::msg(format!("Sentry {code} — {body}")));
	}
	Ok(())
}

/// `status` accepte `resolved`, `ignored` ou `unresolved`.
pub async fn sentry_update_issue(config: &Config, issue_id: &str, status: &str) -> Result<()> {
	let issue_id = sentry_issue_segment(issue_id)?;
	if config.sentry.token.is_empty() {
		return Err(CockpitError::missing("Sentry"));
	}
	let response = client()?
		.put(format!("https://sentry.io/api/0/issues/{issue_id}/"))
		.header("Authorization", format!("Bearer {}", config.sentry.token))
		.json(&json!({ "status": status }))
		.send()
		.await?;

	if !response.status().is_success() {
		let code = response.status();
		let body = response.text().await.unwrap_or_default();
		return Err(CockpitError::msg(format!("Sentry {code} — {body}")));
	}
	Ok(())
}

// ───────────────────────────── Better Stack ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiChart {
	pub id: String,
	pub name: String,
	/// `line_chart`, `number_chart`, `table_chart`…
	pub kind: String,
	pub section: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiDashboard {
	pub id: String,
	pub name: String,
	pub group: String,
	pub url: String,
	pub updated_at: String,
	pub charts: Vec<KpiChart>,
}

/// Dashboards Telemetry et leurs graphiques.
///
/// Deux appels par dashboard seraient inutiles : l'API renvoie déjà les
/// graphiques dans la ressource. Les valeurs, elles, demanderaient d'exécuter
/// le SQL de chaque graphique — d'où l'inventaire seul ici, avec le lien pour
/// ouvrir le dashboard.
pub async fn betterstack_dashboards(config: &Config) -> Result<Vec<KpiDashboard>> {
	if config.betterstack.telemetry_token.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.kpiTokenMissing")));
	}

	let value = json_get(
		"https://telemetry.betterstack.com/api/v2/dashboards",
		&config.betterstack.telemetry_token,
		"Bearer",
	)
	.await?;

	let Some(items) = value.get("data").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	// La liste ne porte que les métadonnées : les graphiques se demandent
	// dashboard par dashboard. Une dizaine d'appels, donc en parallèle.
	let token = config.betterstack.telemetry_token.clone();
	let tasks = items.iter().map(|item| {
		let id = text(item, "/id");
		let name = text(item, "/attributes/name");
		let updated_at = text(item, "/attributes/updated_at");
		// L'URL publique est cloisonnée par équipe : sans le segment
		// `/team/t<id>/`, Better Stack répond 404.
		let team = item
			.pointer("/attributes/team_id")
			.map(|v| v.to_string().trim_matches('"').to_string())
			.unwrap_or_default();
		let token = token.clone();
		async move {
			let charts = json_get(
				&format!("https://telemetry.betterstack.com/api/v2/dashboards/{id}/charts"),
				&token,
				"Bearer",
			)
			.await
			.ok()
			.and_then(|body| body.get("data").and_then(|v| v.as_array()).cloned())
			.map(|list| {
				list.iter()
					.map(|chart| KpiChart {
						id: text(chart, "/id"),
						name: text(chart, "/attributes/name"),
						kind: text(chart, "/attributes/chart_type"),
						// Les sections ne sont pas rendues par cet endpoint : on
						// regroupe par type de graphique, qui reste informatif.
						section: match text(chart, "/attributes/chart_type").as_str() {
							"number_chart" => "Indicateurs".to_string(),
							"table_chart" => "Tableaux".to_string(),
							_ => "Courbes".to_string(),
						},
					})
					.collect::<Vec<_>>()
			})
			.unwrap_or_default();

			KpiDashboard {
				url: if team.is_empty() {
					format!("https://telemetry.betterstack.com/dashboards/{id}")
				} else {
					format!("https://telemetry.betterstack.com/team/t{team}/dashboards/{id}")
				},
				id,
				name,
				group: String::new(),
				updated_at,
				charts,
			}
		}
	});

	Ok(futures::future::join_all(tasks).await)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiValue {
	pub chart_id: String,
	pub name: String,
	pub kind: String,
	/// En-têtes du résultat, dans l'ordre des colonnes.
	pub columns: Vec<String>,
	/// Lignes de valeurs, déjà mises en texte pour l'affichage.
	pub rows: Vec<Vec<String>>,
	/// Renseigné quand la requête a échoué : l'indicateur reste visible, avec
	/// sa raison, plutôt que de disparaître du tableau de bord.
	pub error: Option<String>,
}

/// Accès ClickHouse : ce qu'il faut pour exécuter une requête.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct ClickhouseAccess {
	pub host: String,
	pub username: String,
	pub password: String,
	/// Vide quand les identifiants sont saisis à la main : ils n'expirent pas.
	#[serde(default)]
	pub valid_until: String,
	/// Réponse brute de l'API, gardée pour diagnostiquer un nom de table refusé.
	#[serde(default)]
	pub data_sources: Value,
}

fn connection_cache_path() -> std::path::PathBuf {
	crate::config::config_dir().join("betterstack-connection.json")
}

/// Identifiants ClickHouse, obtenus tout seuls quand c'est possible.
///
/// Better Stack ne distribue pas les identifiants de ses dashboards, mais sait
/// en fabriquer : `POST /api/v1/connections` rend un accès en lecture, à durée
/// limitée. On le demande donc plutôt que de le faire recopier à la main — au
/// prix d'un cache sur disque, le mot de passe n'étant rendu qu'une fois.
///
/// Cet endpoint exige un token **global** ; un token d'équipe sait lister les
/// dashboards mais pas créer de connexion, d'où le message explicite.
async fn clickhouse_access(config: &Config) -> Result<ClickhouseAccess> {
	// Des identifiants saisis à la main l'emportent : ils permettent de viser
	// une connexion existante, ou de se passer d'un token global.
	if !config.betterstack.clickhouse_host.trim().is_empty() {
		return Ok(ClickhouseAccess {
			host: config.betterstack.clickhouse_host.trim().to_string(),
			username: config.betterstack.clickhouse_username.clone(),
			password: config.betterstack.clickhouse_password.clone(),
			valid_until: String::new(),
			data_sources: Value::Null,
		});
	}

	// Une connexion encore valable une heure évite un aller-retour par écran.
	if let Ok(raw) = std::fs::read_to_string(connection_cache_path()) {
		if let Ok(cached) = serde_json::from_str::<ClickhouseAccess>(&raw) {
			let alive = chrono::DateTime::parse_from_rfc3339(&cached.valid_until)
				.map(|until| until > chrono::Utc::now() + chrono::Duration::hours(1))
				.unwrap_or(false);
			if alive && !cached.host.is_empty() {
				return Ok(cached);
			}
		}
	}

	let token = config.betterstack.telemetry_token.trim();
	if token.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.telemetryTokenMissing")));
	}

	// Un mois : assez long pour ne pas y penser, assez court pour qu'un jeton
	// oublié dans un cache finisse par ne plus rien ouvrir.
	let valid_until = (chrono::Utc::now() + chrono::Duration::days(30))
		.format("%Y-%m-%dT%H:%M:%SZ")
		.to_string();
	let mut payload = json!({
		"client_type": "clickhouse",
		"valid_until": valid_until,
		"note": "cockpit",
	});
	if let Some(team) = betterstack_team_id(config).await {
		payload["team_ids"] = json!([team]);
	}

	let response = client()?
		.post("https://telemetry.betterstack.com/api/v1/connections")
		.header("Authorization", format!("Bearer {token}"))
		.header("Content-Type", "application/json")
		.json(&payload)
		.send()
		.await?;

	let status = response.status();
	let body = response.text().await?;
	if !status.is_success() {
		// Ces deux refus sont les cas courants, et le message brut de l'API
		// n'indique pas quoi faire.
		if body.contains("global API token") {
			return Err(CockpitError::msg(crate::i18n::t("integrations.telemetryTeamToken")));
		}
		if body.contains("read-only") {
			return Err(CockpitError::msg(crate::i18n::t("integrations.telemetryReadOnly")));
		}
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.betterstackConnection",
			&[
				("status", &status),
				("body", &body.chars().take(300).collect::<String>()),
			],
		)));
	}

	let value: Value = serde_json::from_str(&body)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("integrations.unreadableResponse", &[("error", &e)])))?;
	// L'API répond tantôt à plat, tantôt en JSON:API : on accepte les deux.
	let fields = value
		.pointer("/data/attributes")
		.or_else(|| value.get("data"))
		.unwrap_or(&value);

	let access = ClickhouseAccess {
		host: text(fields, "/host"),
		username: text(fields, "/username"),
		password: text(fields, "/password"),
		valid_until: text(fields, "/valid_until"),
		data_sources: fields.get("data_sources").cloned().unwrap_or(Value::Null),
	};
	if access.host.is_empty() || access.password.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t(
			"integrations.betterstackNoCredentials",
		)));
	}

	// Le mot de passe n'est rendu qu'à la création : sans ce cache, chaque
	// rafraîchissement fabriquerait une connexion de plus.
	if let Ok(serialized) = serde_json::to_string_pretty(&access) {
		let path = connection_cache_path();
		if write_private(&path, serialized.as_bytes()).is_ok() {
			restrict_to_owner(&path);
		}
	}

	Ok(access)
}

/// Écrit un fichier né en 0600 : avec `fs::write` puis `chmod`, le mot de passe
/// resterait un instant lisible par les autres comptes du Mac.
#[cfg(unix)]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
	use std::io::Write;
	use std::os::unix::fs::OpenOptionsExt;
	std::fs::OpenOptions::new()
		.write(true)
		.create(true)
		.truncate(true)
		.mode(0o600)
		.open(path)?
		.write_all(bytes)
}
#[cfg(not(unix))]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
	std::fs::write(path, bytes)
}

/// Le mot de passe vaut lecture sur toute la télémétrie : personne d'autre.
#[cfg(unix)]
fn restrict_to_owner(path: &std::path::Path) {
	use std::os::unix::fs::PermissionsExt;
	let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_to_owner(_path: &std::path::Path) {}

/// Équipe propriétaire des sources, telle que l'API la déclare.
async fn betterstack_team_id(config: &Config) -> Option<i64> {
	let sources = json_get(
		"https://telemetry.betterstack.com/api/v1/sources",
		&config.betterstack.telemetry_token,
		"Bearer",
	)
	.await
	.ok()?;
	sources.pointer("/data/0/attributes/team_id").and_then(|v| v.as_i64())
}

/// Exécute une requête sur ClickHouse via l'interface HTTP de Better Stack.
async fn clickhouse_query(access: &ClickhouseAccess, sql: &str) -> Result<Value> {
	let host = access.host.trim().trim_end_matches('/');
	let url = if host.starts_with("http") {
		host.to_string()
	} else {
		format!("https://{host}")
	};

	let response = client()?
		.post(&url)
		.basic_auth(&access.username, Some(&access.password))
		// `FORMAT JSON` donne les colonnes typées en plus des lignes.
		.body(format!("{sql}\nFORMAT JSON"))
		.send()
		.await?;

	let status = response.status();
	let body = response.text().await?;
	if !status.is_success() {
		return Err(CockpitError::msg(format!(
			"ClickHouse {status} — {}",
			body.chars().take(300).collect::<String>()
		)));
	}
	serde_json::from_str(&body)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("integrations.unreadableResponse", &[("error", &e)])))
}

/// Nom à substituer à `{{source}}` dans la requête d'un graphique.
///
/// Depuis l'extérieur, une source ne s'adresse pas comme une table ordinaire :
/// le point d'entrée SQL public passe par `remote(...)`. L'API de connexion
/// liste les noms réellement exposés — on s'y fie quand elle nomme la source,
/// et on retombe sur la convention documentée sinon.
fn remote_table(access: &ClickhouseAccess, team_id: &str, table: &str) -> String {
	if table.is_empty() {
		return String::new();
	}
	let suffix = format!("_{table}_logs");
	if let Some(found) = find_string(&access.data_sources, &|candidate: &str| candidate.ends_with(&suffix)) {
		return format!("remote({found})");
	}
	if team_id.is_empty() {
		format!("remote({table}_logs)")
	} else {
		format!("remote(t{team_id}_{table}_logs)")
	}
}

/// Première chaîne du document qui satisfait le prédicat, à n'importe quelle
/// profondeur : la forme exacte de `data_sources` n'est pas contractuelle.
fn find_string(value: &Value, matches: &dyn Fn(&str) -> bool) -> Option<String> {
	match value {
		Value::String(text) if matches(text) => Some(text.clone()),
		Value::Array(items) => items.iter().find_map(|item| find_string(item, matches)),
		Value::Object(fields) => fields.values().find_map(|item| find_string(item, matches)),
		_ => None,
	}
}

/// Remplace les variables de gabarit d'un graphique par des valeurs concrètes.
///
/// `{{source}}` devient la table de l'équipe, `{{start_time}}` et `{{end_time}}`
/// les bornes de la fenêtre demandée. Better Stack stocke `dt` en DateTime64,
/// d'où la conversion explicite plutôt qu'un entier brut.
fn fill_query(sql: &str, table: &str, hours: i64) -> String {
	let end = chrono::Utc::now();
	let start = end - chrono::Duration::hours(hours.max(1));
	sql.replace("{{source}}", table)
		.replace("{{start_time}}", &format!("toDateTime64({}, 3)", start.timestamp()))
		.replace("{{end_time}}", &format!("toDateTime64({}, 3)", end.timestamp()))
}

/// Valeurs courantes d'un dashboard : chaque graphique est calculé pour de vrai.
pub async fn betterstack_kpi_values(config: &Config, dashboard_id: &str, hours: i64) -> Result<Vec<KpiValue>> {
	if config.betterstack.telemetry_token.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.telemetryTokenMissing")));
	}

	// Les graphiques sont des requêtes SQL : il faut un accès aux données, que
	// le cockpit demande lui-même à Better Stack.
	let access = clickhouse_access(config).await?;
	let token = &config.betterstack.telemetry_token;

	// Table par défaut : la première source de l'équipe sert de repli quand le
	// gabarit ne nomme pas explicitement la sienne.
	let sources = json_get("https://telemetry.betterstack.com/api/v1/sources", token, "Bearer").await?;
	let mut team_id = String::new();
	let mut tables: Vec<String> = Vec::new();
	if let Some(list) = sources.get("data").and_then(|v| v.as_array()) {
		for source in list {
			if team_id.is_empty() {
				team_id = source
					.pointer("/attributes/team_id")
					.map(|v| v.to_string().trim_matches('"').to_string())
					.unwrap_or_default();
			}
			let table = text(source, "/attributes/table_name");
			if !table.is_empty() {
				tables.push(table);
			}
		}
	}

	let charts = json_get(
		&format!("https://telemetry.betterstack.com/api/v2/dashboards/{dashboard_id}/charts"),
		token,
		"Bearer",
	)
	.await?;

	let Some(list) = charts.get("data").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	let tasks = list.iter().map(|chart| {
		let chart_id = text(chart, "/id");
		let name = text(chart, "/attributes/name");
		let kind = text(chart, "/attributes/chart_type");
		let sql = chart
			.pointer("/attributes/queries/0/sql_query")
			.and_then(|v| v.as_str())
			.unwrap_or_default()
			.to_string();
		// Le gabarit peut nommer sa source ; sinon on prend la première table.
		let table = tables
			.iter()
			.find(|table| sql.contains(table.as_str()))
			.cloned()
			.or_else(|| tables.first().cloned())
			.unwrap_or_default();
		// Vu de l'extérieur, une source n'est pas une table mais une fonction :
		// `remote(t<équipe>_<source>_logs)` adresse le stockage chaud, seul
		// nommage accepté par le point d'entrée SQL public.
		let qualified = remote_table(&access, &team_id, &table);
		let access = access.clone();

		async move {
			if sql.trim().is_empty() {
				return KpiValue {
					chart_id,
					name,
					kind,
					columns: Vec::new(),
					rows: Vec::new(),
					error: Some(crate::i18n::t("integrations.chartNoQuery")),
				};
			}

			match clickhouse_query(&access, &fill_query(&sql, &qualified, hours)).await {
				Ok(body) => {
					let columns = body
						.get("meta")
						.and_then(|v| v.as_array())
						.map(|meta| meta.iter().map(|column| text(column, "/name")).collect())
						.unwrap_or_default();
					let rows = body
						.get("data")
						.and_then(|v| v.as_array())
						.map(|data| {
							data.iter()
								.take(50)
								.map(|row| {
									row.as_object()
										.map(|fields| {
											fields
												.values()
												.map(|value| match value {
													Value::String(text) => text.clone(),
													other => other.to_string(),
												})
												.collect()
										})
										.unwrap_or_default()
								})
								.collect()
						})
						.unwrap_or_default();
					KpiValue {
						chart_id,
						name,
						kind,
						columns,
						rows,
						error: None,
					}
				}
				Err(error) => KpiValue {
					chart_id,
					name,
					kind,
					columns: Vec::new(),
					rows: Vec::new(),
					error: Some(error.to_string()),
				},
			}
		}
	});

	Ok(futures::future::join_all(tasks).await)
}

pub async fn betterstack_monitors(config: &Config) -> Result<Vec<FeedItem>> {
	if config.betterstack.token.is_empty() {
		return Err(CockpitError::missing("Better Stack"));
	}

	let value = json_get(
		"https://uptime.betterstack.com/api/v2/monitors",
		&config.betterstack.token,
		"Bearer",
	)
	.await?;

	let Some(items) = value.get("data").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	Ok(items
		.iter()
		.map(|item| {
			let status = text(item, "/attributes/status");
			FeedItem {
				id: text(item, "/id"),
				source: "betterstack".into(),
				title: {
					let name = text(item, "/attributes/pronounceable_name");
					if name.is_empty() {
						text(item, "/attributes/url")
					} else {
						name
					}
				},
				subtitle: text(item, "/attributes/url"),
				status: status.clone(),
				severity: match status.as_str() {
					"down" => "critical",
					"paused" | "maintenance" => "info",
					"validating" | "pending" => "warning",
					_ => "success",
				}
				.into(),
				url: format!("https://uptime.betterstack.com/team/monitors/{}", text(item, "/id")),
				timestamp: item
					.pointer("/attributes/last_checked_at")
					.and_then(|v| v.as_str())
					.map(String::from),
				meta: vec![
					meta("type", text(item, "/attributes/monitor_type")),
					meta(
						"fréquence",
						item.pointer("/attributes/check_frequency")
							.map(|v| format!("{v}s"))
							.unwrap_or_default(),
					),
				],
				tags: Vec::new(),
				payload: item.clone(),
			}
		})
		.collect())
}

pub async fn betterstack_incidents(config: &Config) -> Result<Vec<FeedItem>> {
	if config.betterstack.token.is_empty() {
		return Err(CockpitError::missing("Better Stack"));
	}

	let value = json_get(
		"https://uptime.betterstack.com/api/v2/incidents?per_page=25",
		&config.betterstack.token,
		"Bearer",
	)
	.await?;

	let Some(items) = value.get("data").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	Ok(items
		.iter()
		.map(|item| {
			let resolved = item
				.pointer("/attributes/resolved_at")
				.map(|v| !v.is_null())
				.unwrap_or(false);
			let acknowledged = item
				.pointer("/attributes/acknowledged_at")
				.map(|v| !v.is_null())
				.unwrap_or(false);
			FeedItem {
				id: text(item, "/id"),
				source: "betterstack".into(),
				title: text(item, "/attributes/name"),
				subtitle: text(item, "/attributes/cause"),
				status: if resolved {
					"resolved".into()
				} else if acknowledged {
					"acknowledged".into()
				} else {
					"open".into()
				},
				severity: if resolved {
					"success".into()
				} else if acknowledged {
					"warning".into()
				} else {
					"critical".into()
				},
				url: format!("https://uptime.betterstack.com/team/incidents/{}", text(item, "/id")),
				timestamp: item
					.pointer("/attributes/started_at")
					.and_then(|v| v.as_str())
					.map(String::from),
				meta: vec![
					meta("url", text(item, "/attributes/url")),
					meta("origine", text(item, "/attributes/http_method")),
				],
				tags: Vec::new(),
				payload: item.clone(),
			}
		})
		.collect())
}

// ──────────────────────────────── Linear ────────────────────────────────

async fn linear_graphql(config: &Config, query: &str, variables: Value) -> Result<Value> {
	if config.linear.token.is_empty() {
		return Err(CockpitError::missing("Linear"));
	}

	let response = client()?
		.post("https://api.linear.app/graphql")
		// Les clés personnelles Linear s'envoient telles quelles, sans `Bearer`.
		.header("Authorization", &config.linear.token)
		.json(&json!({ "query": query, "variables": variables }))
		.send()
		.await?;

	let status = response.status();
	let body: Value = response.json().await?;
	if !status.is_success() {
		return Err(CockpitError::msg(format!("Linear {status}")));
	}
	if let Some(errors) = body.get("errors").and_then(|v| v.as_array()) {
		if let Some(first) = errors.first() {
			return Err(CockpitError::msg(format!("Linear : {}", text(first, "/message"))));
		}
	}
	Ok(body)
}

const LINEAR_ISSUES_QUERY: &str = r#"
query CockpitIssues($filter: IssueFilter) {
  issues(first: 50, filter: $filter, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      url
      priority
      updatedAt
      branchName
      state { name type }
      assignee { displayName }
      labels { nodes { name } }
      project { name }
    }
  }
}
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRef {
	pub id: String,
	pub name: String,
	pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearComment {
	pub id: String,
	pub body: String,
	pub author: String,
	pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueDetail {
	pub id: String,
	pub identifier: String,
	pub title: String,
	pub description: String,
	pub url: String,
	pub priority: i64,
	pub estimate: Option<f64>,
	pub branch_name: String,
	pub updated_at: String,
	pub state: Option<NamedRef>,
	pub assignee: Option<NamedRef>,
	pub labels: Vec<NamedRef>,
	pub comments: Vec<LinearComment>,
}

/// Choix possibles pour l'équipe : sans eux, aucune action n'est proposable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearOptions {
	pub states: Vec<NamedRef>,
	pub members: Vec<NamedRef>,
	pub labels: Vec<NamedRef>,
}

fn named(value: &Value) -> Option<NamedRef> {
	let id = text(value, "/id");
	if id.is_empty() {
		return None;
	}
	Some(NamedRef {
		id,
		name: text(value, "/name"),
		color: text(value, "/color"),
	})
}

fn named_list(value: &Value, pointer: &str) -> Vec<NamedRef> {
	value
		.pointer(pointer)
		.and_then(|v| v.as_array())
		.map(|list| list.iter().filter_map(named).collect())
		.unwrap_or_default()
}

pub async fn linear_issue_detail(config: &Config, id: &str) -> Result<LinearIssueDetail> {
	let body = linear_graphql(
		config,
		"query Issue($id: String!) {
			issue(id: $id) {
				id identifier title description url priority estimate branchName updatedAt
				state { id name color }
				assignee { id name }
				labels { nodes { id name color } }
				comments { nodes { id body createdAt user { name } } }
			}
		}",
		json!({ "id": id }),
	)
	.await?;

	let issue = body
		.pointer("/data/issue")
		.filter(|v| !v.is_null())
		.ok_or_else(|| CockpitError::msg(crate::i18n::tf("integrations.issueNotFound", &[("id", &id)])))?;

	Ok(LinearIssueDetail {
		id: text(issue, "/id"),
		identifier: text(issue, "/identifier"),
		title: text(issue, "/title"),
		description: text(issue, "/description"),
		url: text(issue, "/url"),
		priority: issue.pointer("/priority").and_then(|v| v.as_i64()).unwrap_or(0),
		estimate: issue.pointer("/estimate").and_then(|v| v.as_f64()),
		branch_name: text(issue, "/branchName"),
		updated_at: text(issue, "/updatedAt"),
		state: issue.pointer("/state").and_then(named),
		assignee: issue.pointer("/assignee").and_then(named),
		labels: named_list(issue, "/labels/nodes"),
		comments: issue
			.pointer("/comments/nodes")
			.and_then(|v| v.as_array())
			.map(|list| {
				list.iter()
					.map(|comment| LinearComment {
						id: text(comment, "/id"),
						body: text(comment, "/body"),
						author: text(comment, "/user/name"),
						created_at: text(comment, "/createdAt"),
					})
					.collect()
			})
			.unwrap_or_default(),
	})
}

pub async fn linear_options(config: &Config, team_id: &str) -> Result<LinearOptions> {
	let body = linear_graphql(
		config,
		"query Options($teamId: String!) {
			team(id: $teamId) {
				states { nodes { id name color position } }
				members { nodes { id name } }
				labels { nodes { id name color } }
			}
		}",
		json!({ "teamId": team_id }),
	)
	.await?;

	let team = body.pointer("/data/team").cloned().unwrap_or(Value::Null);
	Ok(LinearOptions {
		states: named_list(&team, "/states/nodes"),
		members: named_list(&team, "/members/nodes"),
		labels: named_list(&team, "/labels/nodes"),
	})
}

/// Applique un changement sur un ticket. `patch` est passé tel quel à
/// `IssueUpdateInput` : le front n'envoie que les champs qu'il modifie.
pub async fn linear_update_issue(config: &Config, id: &str, patch: Value) -> Result<()> {
	let body = linear_graphql(
		config,
		"mutation Update($id: String!, $input: IssueUpdateInput!) {
			issueUpdate(id: $id, input: $input) { success }
		}",
		json!({ "id": id, "input": patch }),
	)
	.await?;

	if body.pointer("/data/issueUpdate/success").and_then(|v| v.as_bool()) != Some(true) {
		return Err(CockpitError::msg(crate::i18n::t("integrations.linearUpdateRefused")));
	}
	Ok(())
}

pub async fn linear_issues(config: &Config, only_mine: bool) -> Result<Vec<FeedItem>> {
	let mut filter = json!({
		"state": { "type": { "nin": ["completed", "canceled"] } }
	});
	if !config.linear.team_key.is_empty() {
		filter["team"] = json!({ "key": { "eq": config.linear.team_key } });
	}
	if only_mine {
		filter["assignee"] = json!({ "isMe": { "eq": true } });
	}

	let body = linear_graphql(config, LINEAR_ISSUES_QUERY, json!({ "filter": filter })).await?;
	let Some(nodes) = body.pointer("/data/issues/nodes").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	Ok(nodes
		.iter()
		.map(|issue| {
			let state_type = text(issue, "/state/type");
			let priority = issue.get("priority").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
			// Échelle Linear : 0 = non définie, 1 = urgent … 4 = basse.
			let (priority_label, priority_tone) = match priority {
				1 => (crate::i18n::t("integrations.priority.urgent"), "critical"),
				2 => (crate::i18n::t("integrations.priority.high"), "warning"),
				3 => (crate::i18n::t("integrations.priority.medium"), "info"),
				4 => (crate::i18n::t("integrations.priority.low"), "neutral"),
				_ => (crate::i18n::t("integrations.priority.none"), "neutral"),
			};
			FeedItem {
				id: text(issue, "/identifier"),
				source: "linear".into(),
				title: text(issue, "/title"),
				subtitle: text(issue, "/project/name"),
				status: text(issue, "/state/name"),
				severity: match (state_type.as_str(), priority) {
					(_, 1) => "critical",
					("started", _) => "warning",
					_ => "info",
				}
				.into(),
				url: text(issue, "/url"),
				timestamp: issue.get("updatedAt").and_then(|v| v.as_str()).map(String::from),
				meta: vec![
					meta("assigné", text(issue, "/assignee/displayName")),
					meta("branche", text(issue, "/branchName")),
					meta("priorité", priority_label.to_lowercase()),
				],
				// La priorité décide de l'ordre dans lequel on prend les tickets :
				// elle doit se lire dans la liste, pas seulement dans la fiche.
				tags: vec![tag(&priority_label, "", priority_tone)],
				payload: issue.clone(),
			}
		})
		.collect())
}

// ──────────────────────────────── GitHub ────────────────────────────────

/// Le compte GitHub au nom duquel le cockpit lit — « moi », pour « les miens ».
pub async fn github_viewer(config: &Config) -> Result<String> {
	let token = github_token(config).await?;
	let value = json_get("https://api.github.com/user", &token, "Bearer").await?;
	let login = text(&value, "/login");
	if login.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubNoLogin")));
	}
	Ok(login)
}

pub async fn github_token(config: &Config) -> Result<String> {
	if !config.github.token.is_empty() {
		return Ok(config.github.token.clone());
	}
	// Repli sur la session `gh` déjà authentifiée sur le poste — et sur le
	// compte que ce projet déclare, quand il en déclare un.
	//
	// Sans ça, un projet dont le dépôt vit sous un autre compte GitHub est
	// interrogé avec le jeton du compte actif, qui n'y a pas accès. Le symptôme
	// — « Could not resolve to a Repository » — désigne le nom du dépôt alors
	// que c'est l'identité qui manque, et on cherche longtemps au mauvais
	// endroit. On emprunte le jeton du compte nommé, sans jamais basculer le
	// compte actif : `gh auth switch` laisserait le poste entier sous une autre
	// identité si quelque chose s'interrompait.
	let user = config.github.user.trim();
	let command = if user.is_empty() {
		"gh auth token 2>/dev/null".to_string()
	} else {
		format!("gh auth token --user {} 2>/dev/null", shell_word(user))
	};
	let token = crate::runner::capture("/", &command)
		.await
		.map_err(|_| CockpitError::missing("GitHub"))?;
	let token = token.trim().to_string();
	if token.is_empty() {
		return Err(CockpitError::missing("GitHub"));
	}
	Ok(token)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPr {
	pub number: i64,
	/// `open`, `merged` ou `closed`.
	pub state: String,
	pub title: String,
	pub url: String,
	pub merged_at: String,
	/// La branche sur laquelle la PR se greffe : c'est contre elle que GitHub
	/// montre les changements.
	#[serde(default)]
	pub base: String,
}

/// Dernière pull request de chaque branche, tous états confondus.
///
/// Une seule page de cent PR triées par fraîcheur suffit : les worktrees encore
/// sur le disque correspondent à des branches récentes. Aller chercher tout
/// l'historique coûterait des dizaines d'appels pour rien.
pub async fn github_pulls_by_branch(config: &Config) -> Result<std::collections::HashMap<String, BranchPr>> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoMissing")));
	}
	let token = github_token(config).await?;
	let mut index = std::collections::HashMap::new();

	for page in 1..=3 {
		let value = json_get(
			&format!(
				"https://api.github.com/repos/{}/pulls?state=all&sort=updated&direction=desc&per_page=100&page={page}",
				config.github.repo
			),
			&token,
			"Bearer",
		)
		.await?;

		let Some(pulls) = value.as_array().filter(|list| !list.is_empty()) else {
			break;
		};

		for pr in pulls {
			let branch = text(pr, "/head/ref");
			if branch.is_empty() || index.contains_key(&branch) {
				continue;
			}
			let merged_at = text(pr, "/merged_at");
			let state = if !merged_at.is_empty() {
				"merged"
			} else if text(pr, "/state") == "closed" {
				"closed"
			} else {
				"open"
			};
			index.insert(
				branch,
				BranchPr {
					number: pr.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
					state: state.into(),
					title: text(pr, "/title"),
					url: text(pr, "/html_url"),
					merged_at,
					base: text(pr, "/base/ref"),
				},
			);
		}
	}

	Ok(index)
}

/// Le diff d'une pull request, en texte unifié.
///
/// GitHub sert le diff derrière un `Accept` particulier, sur l'URL de la pull
/// request elle-même. Pas de mémoire courte ici : un diff de plusieurs milliers
/// de lignes n'a rien à faire dans un cache prévu pour des listes, et on ne le
/// demande qu'au moment d'analyser.
pub async fn github_pull_diff(config: &Config, number: &str) -> Result<String> {
	let token = github_token(config).await?;
	let response = client()?
		.get(format!(
			"https://api.github.com/repos/{}/pulls/{number}",
			config.github.repo
		))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github.diff")
		.send()
		.await?;

	let status = response.status();
	let body = response.text().await?;
	if !status.is_success() {
		return Err(CockpitError::msg(format!(
			"{status} — {}",
			body.chars().take(300).collect::<String>()
		)));
	}
	Ok(body)
}

/// Ce qui a été dit sur une pull request : description, revues, commentaires.
///
/// Une analyse qui ignore les échanges rate la moitié de l'histoire — c'est
/// souvent là qu'un choix se justifie, ou qu'un doute a déjà été soulevé.
pub async fn github_pull_conversation(config: &Config, number: &str) -> Result<Value> {
	let token = github_token(config).await?;
	let repo = &config.github.repo;

	let (detail, reviews, comments) = futures::future::join3(
		json_get(
			&format!("https://api.github.com/repos/{repo}/pulls/{number}"),
			&token,
			"Bearer",
		),
		json_get(
			&format!("https://api.github.com/repos/{repo}/pulls/{number}/reviews?per_page=50"),
			&token,
			"Bearer",
		),
		json_get(
			&format!("https://api.github.com/repos/{repo}/issues/{number}/comments?per_page=50"),
			&token,
			"Bearer",
		),
	)
	.await;

	// Les revues et les commentaires sont un bonus : leur absence ne doit pas
	// priver l'analyse de la description, qui est l'essentiel.
	Ok(json!({
		"detail": detail?,
		"reviews": reviews.unwrap_or_else(|_| json!([])),
		"comments": comments.unwrap_or_else(|_| json!([])),
	}))
}

/// La demande de fusion ouverte sur une branche précise, s'il y en a une.
///
/// Distincte de [`github_pulls_by_branch`], qui feuillette trois cents pull
/// requests pour en indexer autant de branches : quand on n'en cherche qu'une,
/// c'est trois appels réseau et quelques centaines de kilo-octets pour un seul
/// numéro. GitHub sait filtrer par branche de tête, à condition de la préfixer
/// du propriétaire du dépôt.
pub async fn github_pull_for_branch(config: &Config, branch: &str) -> Result<Option<BranchPr>> {
	let repo = config.github.repo.trim();
	if repo.is_empty() || branch.trim().is_empty() {
		return Ok(None);
	}
	let owner = repo.split('/').next().unwrap_or_default();
	let token = github_token(config).await?;
	let value = json_get(
		&format!(
			"https://api.github.com/repos/{repo}/pulls\
			 ?head={owner}:{}&state=all&sort=updated&direction=desc&per_page=5",
			urlencoding::encode(branch.trim())
		),
		&token,
		"Bearer",
	)
	.await?;

	// Le premier de la liste est le plus récemment mis à jour : c'est celui qui
	// porte le travail en cours, même si la branche a déjà servi une fois.
	let Some(pr) = value.as_array().and_then(|list| list.first()) else {
		return Ok(None);
	};
	let merged_at = text(pr, "/merged_at");
	let state = if !merged_at.is_empty() {
		"merged"
	} else if text(pr, "/state") == "closed" {
		"closed"
	} else {
		"open"
	};
	Ok(Some(BranchPr {
		number: pr.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
		state: state.into(),
		title: text(pr, "/title"),
		url: text(pr, "/html_url"),
		merged_at,
		base: text(pr, "/base/ref"),
	}))
}

pub async fn github_pulls(config: &Config) -> Result<Vec<FeedItem>> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoSet")));
	}
	let token = github_token(config).await?;

	let value = json_get(
		&format!(
			"https://api.github.com/repos/{}/pulls?state=open&sort=updated&direction=desc&per_page=50",
			config.github.repo
		),
		&token,
		"Bearer",
	)
	.await?;

	let Some(pulls) = value.as_array() else {
		return Ok(Vec::new());
	};

	Ok(pulls
		.iter()
		.map(|pr| {
			let draft = pr.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);
			// La couleur vient de GitHub : c'est elle qui rend un label
			// reconnaissable sans le lire, dans une liste dense de PR.
			let label_tags: Vec<Tag> = pr
				.get("labels")
				.and_then(|v| v.as_array())
				.map(|list| {
					list.iter()
						.map(|l| tag(text(l, "/name"), text(l, "/color"), "neutral"))
						.filter(|entry| !entry.label.is_empty())
						.collect()
				})
				.unwrap_or_default();
			let labels: Vec<String> = label_tags.iter().map(|entry| entry.label.clone()).collect();
			let logins = |pointer: &str| -> Vec<String> {
				pr.pointer(pointer)
					.and_then(|v| v.as_array())
					.map(|list| list.iter().map(|user| text(user, "/login")).collect())
					.unwrap_or_default()
			};
			let author = text(pr, "/user/login");
			// Les PR sont souvent auto-assignées : quand l'assigné se réduit à
			// l'auteur, l'afficher n'apporte rien, on ne garde que les autres.
			let assignees: Vec<String> = logins("/assignees")
				.into_iter()
				.filter(|login| login != &author)
				.collect();
			let reviewers = logins("/requested_reviewers");
			FeedItem {
				id: pr.get("number").map(|n| n.to_string()).unwrap_or_default(),
				source: "github".into(),
				title: text(pr, "/title"),
				subtitle: format!("@{author} · {} → {}", text(pr, "/head/ref"), text(pr, "/base/ref")),
				status: if draft { "draft".into() } else { "open".into() },
				severity: if draft { "info".into() } else { "warning".into() },
				url: text(pr, "/html_url"),
				timestamp: pr.get("updated_at").and_then(|v| v.as_str()).map(String::from),
				meta: vec![
					meta("auteur", author.clone()),
					meta("à reviewer par", reviewers.join(", ")),
					meta("assigné", assignees.join(", ")),
					meta("labels", labels.join(", ")),
					meta("branche", text(pr, "/head/ref")),
				],
				tags: label_tags,
				payload: pr.clone(),
			}
		})
		.collect())
}

/// Dernières exécutions de workflows Actions : l'état du CI en un coup d'œil.
pub async fn github_runs(config: &Config) -> Result<Vec<FeedItem>> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoMissing")));
	}
	let token = github_token(config).await?;

	let value = json_get(
		&format!(
			"https://api.github.com/repos/{}/actions/runs?per_page=25",
			config.github.repo
		),
		&token,
		"Bearer",
	)
	.await?;

	let Some(runs) = value.get("workflow_runs").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	Ok(runs
		.iter()
		.map(|run| {
			let conclusion = text(run, "/conclusion");
			let status = text(run, "/status");
			FeedItem {
				id: run.get("id").map(|v| v.to_string()).unwrap_or_default(),
				source: "github-actions".into(),
				title: text(run, "/name"),
				subtitle: text(run, "/head_branch"),
				status: if conclusion.is_empty() {
					status.clone()
				} else {
					conclusion.clone()
				},
				severity: match conclusion.as_str() {
					"success" => "success",
					"failure" | "timed_out" => "critical",
					"cancelled" => "info",
					_ if status == "in_progress" || status == "queued" => "warning",
					_ => "info",
				}
				.into(),
				url: text(run, "/html_url"),
				timestamp: run.get("updated_at").and_then(|v| v.as_str()).map(String::from),
				meta: vec![
					meta("événement", text(run, "/event")),
					meta("commit", text(run, "/head_sha").chars().take(7).collect::<String>()),
					meta("auteur", text(run, "/actor/login")),
				],
				tags: Vec::new(),
				payload: run.clone(),
			}
		})
		.collect())
}

// ───────────────────────────── Trigger.dev ─────────────────────────────

/// `environment` sélectionne une des clés déclarées ; `None` prend la première.
pub async fn trigger_runs(config: &Config, environment: Option<&str>) -> Result<Vec<FeedItem>> {
	let available = config.trigger.resolved();
	if available.is_empty() {
		return Err(CockpitError::missing("Trigger.dev"));
	}

	let chosen = match environment {
		Some(name) => available
			.iter()
			.find(|env| env.name == name)
			.ok_or_else(|| CockpitError::msg(crate::i18n::tf("integrations.triggerUnknownEnv", &[("name", &name)])))?,
		None => &available[0],
	};

	// `/api/v1/runs` s'authentifie par environnement, pas par utilisateur : un
	// Personal Access Token (`tr_pat_…`, celui du CLI) y répond 401 sans dire
	// lequel il attendait. On ne rejette que celui-là : le préfixe d'une secret
	// key suit le nom de l'environnement (`tr_dev_`, `tr_prod_`, `tr_staging_`…),
	// et cette liste n'est pas fermée.
	if chosen.token.starts_with("tr_pat_") {
		return Err(CockpitError::msg(crate::i18n::t("integrations.triggerPatToken")));
	}

	let value = json_get(
		&format!("{}/api/v1/runs?perPage=30", config.trigger.api_url),
		&chosen.token,
		"Bearer",
	)
	.await?;

	let Some(runs) = value.get("data").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	Ok(runs
		.iter()
		.map(|run| {
			let status = text(run, "/status");
			let run_id = text(run, "/id");
			// L'API ne renvoie pas toujours l'environnement ; le nom de la clé
			// utilisée, lui, est toujours connu — c'est la réponse à « ce run
			// vient d'où ? ».
			let environment = {
				let from_api = text(run, "/env/name");
				if from_api.is_empty() {
					chosen.name.clone()
				} else {
					from_api
				}
			};
			let version = text(run, "/version");
			FeedItem {
				id: run_id.clone(),
				source: "trigger".into(),
				title: text(run, "/taskIdentifier"),
				subtitle: if version.is_empty() {
					environment.clone()
				} else {
					format!("{environment} · {version}")
				},
				status: status.clone(),
				severity: match status.as_str() {
					"COMPLETED" => "success",
					"FAILED" | "CRASHED" | "SYSTEM_FAILURE" | "TIMED_OUT" => "critical",
					"EXECUTING" | "QUEUED" | "WAITING_FOR_DEPLOY" | "REATTEMPTING" => "warning",
					_ => "info",
				}
				.into(),
				// Le champ portait l'identifiant brut : rien à ouvrir. Le dashboard
				// v3 range les runs par projet, d'où le `project_ref`.
				url: if chosen.project_ref.is_empty() || run_id.is_empty() {
					String::new()
				} else {
					format!(
						"https://cloud.trigger.dev/projects/v3/{}/runs/{run_id}",
						chosen.project_ref
					)
				},
				timestamp: run
					.get("updatedAt")
					.or_else(|| run.get("createdAt"))
					.and_then(|v| v.as_str())
					.map(String::from),
				meta: vec![
					meta("environnement", environment),
					meta("projet", chosen.project_ref.clone()),
					meta("tâche", text(run, "/taskIdentifier")),
					meta("run", run_id),
					meta("version", version),
					meta(
						"essai",
						run.get("attemptCount").map(|v| v.to_string()).unwrap_or_default(),
					),
					meta(
						"coût",
						run.get("costInCents")
							.and_then(|v| v.as_f64())
							.map(|cents| format!("{:.3} $", cents / 100.0))
							.unwrap_or_default(),
					),
					meta(
						"durée",
						run.get("durationMs")
							.and_then(|v| v.as_f64())
							.map(|ms| format!("{:.1} s", ms / 1000.0))
							.unwrap_or_default(),
					),
				],
				tags: Vec::new(),
				payload: run.clone(),
			}
		})
		.collect())
}

// ─────────────────────────────── Railway ───────────────────────────────

const RAILWAY_QUERY: &str = r#"
query CockpitDeployments($projectId: String!) {
  deployments(input: { projectId: $projectId }, first: 25) {
    edges {
      node {
        id
        status
        createdAt
        staticUrl
        url
        environment { name }
        service { name }
      }
    }
  }
}
"#;

/// Appel GraphQL Railway. Les erreurs arrivent dans le corps avec un HTTP 200,
/// d'où la remontée explicite du premier message plutôt qu'un `?` sur le statut.
async fn railway_graphql(token: &str, query: &str, variables: Value) -> Result<Value> {
	let response = client()?
		.post("https://backboard.railway.app/graphql/v2")
		.header("Authorization", format!("Bearer {token}"))
		.json(&json!({ "query": query, "variables": variables }))
		.send()
		.await?;

	let body: Value = response.json().await?;
	if let Some(first) = body
		.get("errors")
		.and_then(|v| v.as_array())
		.and_then(|errors| errors.first())
	{
		return Err(CockpitError::msg(format!("Railway : {}", text(first, "/message"))));
	}
	Ok(body)
}

const RAILWAY_PROJECTS_QUERY: &str = r#"
query CockpitProjects {
  projects(first: 50) {
    edges { node { id name } }
  }
}
"#;

/// Identifiant du projet, déduit du token quand il n'est pas configuré.
///
/// Railway a trois portées de token (compte, workspace, projet) et seules les
/// deux premières savent énumérer les projets ; on ne peut donc pas toujours
/// deviner, mais quand c'est possible autant éviter un aller-retour par le
/// dashboard.
async fn railway_project_id(config: &Config) -> Result<String> {
	let configured = config.railway.project_id.trim();
	if !configured.is_empty() {
		return Ok(configured.to_string());
	}

	let body = railway_graphql(&config.railway.token, RAILWAY_PROJECTS_QUERY, json!({})).await?;

	let projects: Vec<(String, String)> = body
		.pointer("/data/projects/edges")
		.and_then(|v| v.as_array())
		.map(|edges| {
			edges
				.iter()
				.filter_map(|edge| edge.get("node"))
				.map(|node| (text(node, "/id"), text(node, "/name")))
				.filter(|(id, _)| !id.is_empty())
				.collect()
		})
		.unwrap_or_default();

	match projects.as_slice() {
		[] => Err(CockpitError::msg(crate::i18n::t("integrations.railwayNoProject"))),
		[(id, _)] => Ok(id.clone()),
		several => Err(CockpitError::msg(crate::i18n::tf(
			"integrations.railwaySeveralProjects",
			&[(
				"projects",
				&several
					.iter()
					.map(|(id, name)| format!("{name} = {id}"))
					.collect::<Vec<_>>()
					.join(", "),
			)],
		))),
	}
}

pub async fn railway_deployments(config: &Config) -> Result<Vec<FeedItem>> {
	if config.railway.token.is_empty() {
		return Err(CockpitError::missing("Railway"));
	}

	let project_id = railway_project_id(config).await?;
	let body = railway_graphql(&config.railway.token, RAILWAY_QUERY, json!({ "projectId": project_id })).await?;

	let Some(edges) = body.pointer("/data/deployments/edges").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	Ok(edges
		.iter()
		.filter_map(|edge| edge.get("node"))
		.map(|node| {
			let status = text(node, "/status");
			FeedItem {
				id: text(node, "/id"),
				source: "railway".into(),
				title: text(node, "/service/name"),
				subtitle: text(node, "/environment/name"),
				status: status.clone(),
				severity: match status.as_str() {
					"SUCCESS" => "success",
					"FAILED" | "CRASHED" => "critical",
					"BUILDING" | "DEPLOYING" | "INITIALIZING" | "QUEUED" => "warning",
					_ => "info",
				}
				.into(),
				url: {
					let static_url = text(node, "/staticUrl");
					if static_url.is_empty() {
						text(node, "/url")
					} else {
						format!("https://{static_url}")
					}
				},
				timestamp: node.get("createdAt").and_then(|v| v.as_str()).map(String::from),
				meta: vec![meta(
					"déploiement",
					text(node, "/id").chars().take(8).collect::<String>(),
				)],
				tags: Vec::new(),
				payload: node.clone(),
			}
		})
		.collect())
}

// ──────────────────────────────── Stripe ────────────────────────────────

pub async fn stripe_events(config: &Config) -> Result<Vec<FeedItem>> {
	if config.stripe.token.is_empty() {
		return Err(CockpitError::missing("Stripe"));
	}
	expect_token_kind(
		&config.stripe.token,
		&["rk_", "sk_"],
		&crate::i18n::t("integrations.stripePublishableKey"),
	)?;

	let value = json_get(
		"https://api.stripe.com/v1/events?limit=30",
		&config.stripe.token,
		"Bearer",
	)
	.await?;

	let Some(events) = value.get("data").and_then(|v| v.as_array()) else {
		return Ok(Vec::new());
	};

	Ok(events
		.iter()
		.map(|event| {
			let kind = text(event, "/type");
			let livemode = event.get("livemode").and_then(|v| v.as_bool()).unwrap_or(false);
			FeedItem {
				id: text(event, "/id"),
				source: "stripe".into(),
				title: kind.clone(),
				subtitle: text(event, "/data/object/id"),
				status: if livemode { "live".into() } else { "test".into() },
				severity: if kind.contains("failed") || kind.contains("dispute") {
					"critical".into()
				} else if kind.contains("deleted") || kind.contains("canceled") {
					"warning".into()
				} else {
					"info".into()
				},
				url: format!(
					"https://dashboard.stripe.com/{}events/{}",
					if livemode { "" } else { "test/" },
					text(event, "/id")
				),
				timestamp: event
					.get("created")
					.and_then(|v| v.as_i64())
					.and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
					.map(|dt| dt.to_rfc3339()),
				meta: vec![meta("objet", text(event, "/data/object/object"))],
				tags: Vec::new(),
				payload: event.clone(),
			}
		})
		.collect())
}

// ────────────────────────────── GitHub Issues ──────────────────────────────
//
// Le second suivi de tâches, et celui qui valide l'abstraction : une interface
// écrite pour un seul fournisseur est toujours fausse. Les issues GitHub n'ont
// ni priorité, ni estimation, ni états intermédiaires — ce sont précisément ces
// absences qui obligent à un modèle honnête.

/// Vrai quand l'entrée renvoyée par l'API est en réalité une pull request.
///
/// L'API des issues renvoie aussi les PR : sans ce tri, la liste des tâches se
/// remplirait du travail déjà commencé, qui a son propre écran.
fn is_pull_request(issue: &Value) -> bool {
	issue.get("pull_request").is_some()
}

/// L'adresse des issues ouvertes d'un dépôt, celles d'une personne si on la nomme.
fn github_issues_url(repo: &str, assignee: Option<&str>) -> String {
	let mut url = format!("https://api.github.com/repos/{repo}/issues?state=open&sort=updated&per_page=50");
	if let Some(login) = assignee.filter(|login| !login.is_empty()) {
		url.push_str("&assignee=");
		url.push_str(&urlencoding::encode(login));
	}
	url
}

pub async fn github_issues(config: &Config, only_mine: bool) -> Result<Vec<FeedItem>> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoMissing")));
	}
	let token = github_token(config).await?;
	// « Les miens » demande un identifiant : l'API des issues d'un dépôt refuse
	// `@me` (422), qui ne vaut que pour la recherche. Celui qui est déclaré, à
	// défaut le compte qui porte le jeton — celui-là même qui lit.
	let login = if only_mine {
		let declared = config.github.user.trim();
		Some(if declared.is_empty() {
			github_viewer(config).await?
		} else {
			declared.to_string()
		})
	} else {
		None
	};
	let value = json_get(
		&github_issues_url(&config.github.repo, login.as_deref()),
		&token,
		"Bearer",
	)
	.await?;

	let Some(issues) = value.as_array() else {
		return Ok(Vec::new());
	};

	Ok(issues
		.iter()
		.filter(|issue| !is_pull_request(issue))
		.map(|issue| {
			let number = issue.get("number").and_then(|v| v.as_i64()).unwrap_or(0);
			let labels: Vec<Tag> = issue
				.get("labels")
				.and_then(|v| v.as_array())
				.map(|list| {
					list.iter()
						.map(|label| tag(text(label, "/name"), text(label, "/color"), "neutral"))
						.filter(|entry| !entry.label.is_empty())
						.collect()
				})
				.unwrap_or_default();

			FeedItem {
				id: number.to_string(),
				source: "github-issues".into(),
				title: text(issue, "/title"),
				subtitle: text(issue, "/milestone/title"),
				status: text(issue, "/state"),
				// Sans priorité, l'ancienneté est le seul signal disponible : une
				// issue ouverte reste une question ouverte, sans plus.
				severity: "info".into(),
				url: text(issue, "/html_url"),
				timestamp: issue.get("updated_at").and_then(|v| v.as_str()).map(String::from),
				meta: vec![
					meta("assigné", text(issue, "/assignee/login")),
					meta("auteur", text(issue, "/user/login")),
					meta(
						"labels",
						labels
							.iter()
							.map(|entry| entry.label.clone())
							.collect::<Vec<_>>()
							.join(", "),
					),
				],
				tags: labels,
				payload: issue.clone(),
			}
		})
		.collect())
}

pub async fn github_issue(config: &Config, number: &str) -> Result<crate::tickets::TicketDetail> {
	let token = github_token(config).await?;
	let repo = &config.github.repo;
	let issue = json_get(
		&format!("https://api.github.com/repos/{repo}/issues/{number}"),
		&token,
		"Bearer",
	)
	.await?;

	let raw_comments = json_get(
		&format!("https://api.github.com/repos/{repo}/issues/{number}/comments?per_page=50"),
		&token,
		"Bearer",
	)
	.await
	.unwrap_or(Value::Array(Vec::new()));

	let comments = raw_comments
		.as_array()
		.map(|list| {
			list.iter()
				.map(|comment| LinearComment {
					id: text(comment, "/id"),
					author: text(comment, "/user/login"),
					body: text(comment, "/body"),
					created_at: text(comment, "/created_at"),
				})
				.collect()
		})
		.unwrap_or_default();

	let named_from = |value: &Value, id_key: &str, name_key: &str| -> Option<NamedRef> {
		let name = text(value, name_key);
		if name.is_empty() {
			return None;
		}
		Some(NamedRef {
			id: text(value, id_key),
			name,
			color: String::new(),
		})
	};

	Ok(crate::tickets::TicketDetail {
		id: number.to_string(),
		identifier: format!("#{number}"),
		title: text(&issue, "/title"),
		description: text(&issue, "/body"),
		url: text(&issue, "/html_url"),
		// Ni priorité ni estimation chez GitHub : on ne les invente pas.
		priority: 0,
		estimate: None,
		branch_name: String::new(),
		updated_at: text(&issue, "/updated_at"),
		state: Some(NamedRef {
			id: text(&issue, "/state"),
			name: if text(&issue, "/state") == "closed" {
				"Fermée".into()
			} else {
				"Ouverte".into()
			},
			color: String::new(),
		}),
		assignee: named_from(&issue, "/assignee/id", "/assignee/login"),
		labels: issue
			.get("labels")
			.and_then(|v| v.as_array())
			.map(|list| {
				list.iter()
					.filter_map(|label| {
						let name = text(label, "/name");
						if name.is_empty() {
							return None;
						}
						Some(NamedRef {
							id: name.clone(),
							name,
							color: format!("#{}", text(label, "/color")),
						})
					})
					.collect()
			})
			.unwrap_or_default(),
		comments,
	})
}

/// Les choix proposables sur une issue : deux états, les labels et les
/// personnes qui peuvent être assignées sur ce dépôt.
pub async fn github_issue_options(config: &Config) -> Result<crate::tickets::Options> {
	let token = github_token(config).await?;
	let repo = &config.github.repo;

	let labels = json_get(
		&format!("https://api.github.com/repos/{repo}/labels?per_page=100"),
		&token,
		"Bearer",
	)
	.await
	.unwrap_or(Value::Array(Vec::new()));
	let assignees = json_get(
		&format!("https://api.github.com/repos/{repo}/assignees?per_page=100"),
		&token,
		"Bearer",
	)
	.await
	.unwrap_or(Value::Array(Vec::new()));

	let list = |value: &Value, name_key: &str, color_key: &str| -> Vec<NamedRef> {
		value
			.as_array()
			.map(|entries| {
				entries
					.iter()
					.filter_map(|entry| {
						let name = text(entry, name_key);
						if name.is_empty() {
							return None;
						}
						let color = text(entry, color_key);
						Some(NamedRef {
							id: name.clone(),
							name,
							color: if color.is_empty() {
								String::new()
							} else {
								format!("#{color}")
							},
						})
					})
					.collect()
			})
			.unwrap_or_default()
	};

	Ok(crate::tickets::Options {
		states: vec![
			NamedRef {
				id: "open".into(),
				name: "Ouverte".into(),
				color: String::new(),
			},
			NamedRef {
				id: "closed".into(),
				name: "Fermée".into(),
				color: String::new(),
			},
		],
		members: list(&assignees, "/login", "/none"),
		labels: list(&labels, "/name", "/color"),
	})
}

/// Applique un changement, en traduisant les noms du modèle commun.
///
/// Un patch parle le vocabulaire du cockpit — `stateId`, `assigneeId`,
/// `labelIds` — que chaque fournisseur traduit chez lui. Ce qu'il ne sait pas
/// faire est ignoré en silence plutôt que refusé : l'interface ne propose de
/// toute façon que ce que ses capacités annoncent.
pub async fn github_issue_update(config: &Config, number: &str, patch: Value) -> Result<()> {
	let token = github_token(config).await?;
	let repo = &config.github.repo;

	let mut body = serde_json::Map::new();
	if let Some(state) = patch.get("stateId").and_then(|v| v.as_str()) {
		body.insert("state".into(), json!(state));
	}
	if let Some(assignee) = patch.get("assigneeId") {
		let assignees = match assignee.as_str() {
			Some(login) if !login.is_empty() => vec![login.to_string()],
			_ => Vec::new(),
		};
		body.insert("assignees".into(), json!(assignees));
	}
	if let Some(labels) = patch.get("labelIds").and_then(|v| v.as_array()) {
		body.insert(
			"labels".into(),
			json!(labels
				.iter()
				.filter_map(|label| label.as_str().map(String::from))
				.collect::<Vec<_>>()),
		);
	}
	if body.is_empty() {
		return Ok(());
	}

	let response = client()?
		.patch(format!("https://api.github.com/repos/{repo}/issues/{number}"))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.json(&Value::Object(body))
		.send()
		.await?;

	if !response.status().is_success() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.githubUpdateRefused",
			&[("status", &response.status())],
		)));
	}
	Ok(())
}

// ──────────────────────────────── GitLab ────────────────────────────────
//
// Les tickets d'une équipe qui vit sur GitLab, hébergé chez eux ou chez elle.
//
// Deux écarts avec GitHub méritent d'être dits, parce qu'ils se paient en
// silence sinon. Un projet se désigne par son chemin — `groupe/projet` — qu'il
// faut encoder dans l'URL : sans quoi l'API répond 404 sur un projet qui existe.
// Et les commentaires d'un ticket partagent leur liste avec les notes que GitLab
// écrit lui-même (« a fermé », « a assigné ») : les afficher noierait la
// conversation sous le journal.

/// Racine de l'API, instance comprise.
fn gitlab_api(config: &Config) -> String {
	let host = config.gitlab.host.trim().trim_end_matches('/');
	let host = if host.is_empty() { "https://gitlab.com" } else { host };
	format!("{host}/api/v4")
}

/// Le projet tel que l'URL l'attend : le chemin, encodé.
fn gitlab_project(config: &Config) -> Result<String> {
	let project = config.gitlab.project.trim();
	if project.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.gitlabProjectSet")));
	}
	Ok(urlencoding::encode(project).into_owned())
}

fn gitlab_token(config: &Config) -> Result<String> {
	let token = config.gitlab.token.trim();
	if token.is_empty() {
		return Err(CockpitError::missing("GitLab"));
	}
	Ok(token.to_string())
}

/// Les libellés d'un ticket, couleur comprise.
fn gitlab_labels(issue: &Value) -> Vec<Tag> {
	// `labels` rend des noms ; `label_details` y ajoute les couleurs, mais n'est
	// pas toujours présent selon l'endpoint. On prend le plus riche des deux.
	if let Some(details) = issue.get("label_details").and_then(|v| v.as_array()) {
		return details
			.iter()
			.map(|entry| tag(text(entry, "/name"), text(entry, "/color"), "neutral"))
			.filter(|entry| !entry.label.is_empty())
			.collect();
	}
	issue
		.get("labels")
		.and_then(|v| v.as_array())
		.map(|list| {
			list.iter()
				.filter_map(|label| label.as_str())
				.map(|name| tag(name.to_string(), String::new(), "neutral"))
				.collect()
		})
		.unwrap_or_default()
}

/// Les merge requests ouvertes, telles que GitLab les rend.
///
/// Rendues brutes et non en `FeedItem` : le moniteur en tire sa propre forme,
/// commune aux trois forges, et un passage par le format des flux lui ferait
/// perdre en route le pipeline, les relecteurs et le SHA de tête.
///
/// `with_labels_details` réclame les couleurs des libellés — sans lui, GitLab ne
/// rend que des noms, et une liste de libellés gris ne se lit pas plus vite
/// qu'une phrase.
pub async fn gitlab_merge_requests(config: &Config) -> Result<Vec<Value>> {
	let token = gitlab_token(config)?;
	let project = gitlab_project(config)?;

	let value = json_get(
		&format!(
			"{}/projects/{project}/merge_requests\
			 ?state=opened&order_by=updated_at&per_page=50&with_labels_details=true",
			gitlab_api(config)
		),
		&token,
		"Bearer",
	)
	.await?;

	Ok(value.as_array().cloned().unwrap_or_default())
}

/// La merge request portée par une branche, s'il en existe une.
///
/// `state=all` et non `opened` : une branche dont la demande vient d'être
/// fermée ou fusionnée a une histoire à raconter, et la taire ferait croire à
/// un travail neuf.
pub async fn gitlab_merge_request_for_branch(config: &Config, branch: &str) -> Result<Option<Value>> {
	if branch.trim().is_empty() {
		return Ok(None);
	}
	let token = gitlab_token(config)?;
	let project = gitlab_project(config)?;
	let value = json_get(
		&format!(
			"{}/projects/{project}/merge_requests\
			 ?source_branch={}&state=all&order_by=updated_at&per_page=5",
			gitlab_api(config),
			urlencoding::encode(branch.trim())
		),
		&token,
		"Bearer",
	)
	.await?;
	Ok(value.as_array().and_then(|list| list.first()).cloned())
}

/// Les échanges déposés sur une merge request.
///
/// GitLab ne distingue pas les revues des commentaires : tout est une note. Les
/// notes système — « a assigné », « a poussé » — sont écartées par l'appelant,
/// elles racontent la mécanique et non le fond.
pub async fn gitlab_merge_request_notes(config: &Config, iid: &str) -> Result<Vec<Value>> {
	let token = gitlab_token(config)?;
	let project = gitlab_project(config)?;
	let value = json_get(
		&format!(
			"{}/projects/{project}/merge_requests/{iid}/notes?per_page=50&sort=asc",
			gitlab_api(config)
		),
		&token,
		"Bearer",
	)
	.await?;
	Ok(value.as_array().cloned().unwrap_or_default())
}

/// Le diff d'une merge request, en texte unifié.
///
/// `access_raw_diffs` demande à GitLab d'aller chercher les diffs sur le disque
/// plutôt que dans sa base : c'est plus lent, mais c'est le seul moyen d'avoir
/// autre chose qu'un extrait tronqué sur une merge request un peu grosse — et
/// une analyse qui lit un diff tronqué conclut sur ce qu'elle n'a pas vu.
pub async fn gitlab_merge_request_diff(config: &Config, iid: &str) -> Result<String> {
	let token = gitlab_token(config)?;
	let project = gitlab_project(config)?;

	let value = json_get(
		&format!(
			"{}/projects/{project}/merge_requests/{iid}/changes?access_raw_diffs=true",
			gitlab_api(config)
		),
		&token,
		"Bearer",
	)
	.await?;

	let Some(changes) = value.get("changes").and_then(|v| v.as_array()) else {
		return Ok(String::new());
	};

	// GitLab rend un diff par fichier, sans son en-tête : on la reconstitue pour
	// que le résultat se lise comme n'importe quel diff unifié.
	Ok(changes
		.iter()
		.map(|change| {
			let old = text(change, "/old_path");
			let new = text(change, "/new_path");
			format!(
				"diff --git a/{old} b/{new}\n--- a/{old}\n+++ b/{new}\n{}",
				text(change, "/diff")
			)
		})
		.collect::<Vec<_>>()
		.join("\n"))
}

pub async fn gitlab_issues(config: &Config, only_mine: bool) -> Result<Vec<FeedItem>> {
	let token = gitlab_token(config)?;
	let project = gitlab_project(config)?;
	// `scope=assigned_to_me` plutôt qu'un identifiant d'utilisateur : le jeton
	// sait déjà qui il est, et un identifiant de plus à configurer serait un
	// réglage de plus à oublier.
	let scope = if only_mine { "&scope=assigned_to_me" } else { "" };
	let value = json_get(
		&format!(
			"{}/projects/{project}/issues?state=opened&order_by=updated_at&per_page=50{scope}",
			gitlab_api(config)
		),
		&token,
		"Bearer",
	)
	.await?;

	let Some(issues) = value.as_array() else {
		return Ok(Vec::new());
	};

	Ok(issues
		.iter()
		.map(|issue| {
			let iid = issue.get("iid").and_then(|v| v.as_i64()).unwrap_or(0);
			let labels = gitlab_labels(issue);
			FeedItem {
				id: iid.to_string(),
				source: "gitlab-issues".into(),
				title: text(issue, "/title"),
				subtitle: text(issue, "/milestone/title"),
				status: text(issue, "/state"),
				// Sans échelle de priorité, l'ancienneté reste le seul signal : un
				// ticket ouvert est un ticket ouvert.
				severity: "info".into(),
				url: text(issue, "/web_url"),
				timestamp: issue.get("updated_at").and_then(|v| v.as_str()).map(String::from),
				meta: vec![
					meta("assigné", text(issue, "/assignee/name")),
					meta("auteur", text(issue, "/author/name")),
					meta(
						"labels",
						labels
							.iter()
							.map(|entry| entry.label.clone())
							.collect::<Vec<_>>()
							.join(", "),
					),
				],
				tags: labels,
				payload: issue.clone(),
			}
		})
		.collect())
}

pub async fn gitlab_issue(config: &Config, iid: &str) -> Result<crate::tickets::TicketDetail> {
	let token = gitlab_token(config)?;
	let project = gitlab_project(config)?;
	let api = gitlab_api(config);
	let issue = json_get(&format!("{api}/projects/{project}/issues/{iid}"), &token, "Bearer").await?;

	let raw_notes = json_get(
		&format!("{api}/projects/{project}/issues/{iid}/notes?per_page=50&sort=asc"),
		&token,
		"Bearer",
	)
	.await
	.unwrap_or(Value::Array(Vec::new()));

	let comments = raw_notes
		.as_array()
		.map(|list| {
			list.iter()
				// Les notes système sont le journal du ticket, pas la conversation :
				// « a changé le libellé » ne se lit pas comme un commentaire.
				.filter(|note| !note.get("system").and_then(|v| v.as_bool()).unwrap_or(false))
				.map(|note| LinearComment {
					id: note
						.get("id")
						.map(|v| v.to_string())
						.unwrap_or_default()
						.trim_matches('"')
						.to_string(),
					author: text(note, "/author/name"),
					body: text(note, "/body"),
					created_at: text(note, "/created_at"),
				})
				.collect()
		})
		.unwrap_or_default();

	let state = text(&issue, "/state");
	let assignee = {
		let name = text(&issue, "/assignee/name");
		if name.is_empty() {
			None
		} else {
			Some(NamedRef {
				id: issue.pointer("/assignee/id").map(|v| v.to_string()).unwrap_or_default(),
				name,
				color: String::new(),
			})
		}
	};

	Ok(crate::tickets::TicketDetail {
		id: iid.to_string(),
		identifier: format!("#{iid}"),
		title: text(&issue, "/title"),
		description: text(&issue, "/description"),
		url: text(&issue, "/web_url"),
		// GitLab n'a pas d'échelle de priorité : les équipes s'en font une avec
		// des labels, et chacune la sienne. On ne la devine pas.
		priority: 0,
		estimate: None,
		branch_name: String::new(),
		updated_at: text(&issue, "/updated_at"),
		state: Some(NamedRef {
			id: state.clone(),
			name: if state == "closed" {
				"Fermé".into()
			} else {
				"Ouvert".into()
			},
			color: String::new(),
		}),
		assignee,
		labels: gitlab_labels(&issue)
			.into_iter()
			.map(|entry| NamedRef {
				id: entry.label.clone(),
				name: entry.label,
				color: entry.color,
			})
			.collect(),
		comments,
	})
}

/// Les choix proposables : deux états, les libellés du projet, ses membres.
pub async fn gitlab_issue_options(config: &Config) -> Result<crate::tickets::Options> {
	let token = gitlab_token(config)?;
	let project = gitlab_project(config)?;
	let api = gitlab_api(config);

	let labels = json_get(
		&format!("{api}/projects/{project}/labels?per_page=100"),
		&token,
		"Bearer",
	)
	.await
	.unwrap_or(Value::Array(Vec::new()));
	// `members/all` plutôt que `members` : les droits s'héritent du groupe, et sans
	// cela la liste ignore ceux qui ne sont pas invités sur le projet lui-même.
	let members = json_get(
		&format!("{api}/projects/{project}/members/all?per_page=100"),
		&token,
		"Bearer",
	)
	.await
	.unwrap_or(Value::Array(Vec::new()));

	let labels = labels
		.as_array()
		.map(|entries| {
			entries
				.iter()
				.filter_map(|entry| {
					let name = text(entry, "/name");
					if name.is_empty() {
						return None;
					}
					Some(NamedRef {
						id: name.clone(),
						name,
						color: text(entry, "/color"),
					})
				})
				.collect()
		})
		.unwrap_or_default();

	let members = members
		.as_array()
		.map(|entries| {
			entries
				.iter()
				.filter_map(|entry| {
					let name = text(entry, "/name");
					if name.is_empty() {
						return None;
					}
					Some(NamedRef {
						// L'assignation se fait par identifiant numérique : c'est lui
						// qu'on garde, pas le login.
						id: entry.get("id").map(|v| v.to_string()).unwrap_or_default(),
						name,
						color: String::new(),
					})
				})
				.collect()
		})
		.unwrap_or_default();

	Ok(crate::tickets::Options {
		states: vec![
			NamedRef {
				id: "opened".into(),
				name: "Ouvert".into(),
				color: String::new(),
			},
			NamedRef {
				id: "closed".into(),
				name: "Fermé".into(),
				color: String::new(),
			},
		],
		members,
		labels,
	})
}

/// Applique un changement, en traduisant le vocabulaire du cockpit.
pub async fn gitlab_issue_update(config: &Config, iid: &str, patch: Value) -> Result<()> {
	let token = gitlab_token(config)?;
	let project = gitlab_project(config)?;

	let mut body = serde_json::Map::new();
	// GitLab ne se règle pas sur un état mais sur un événement : `close` ou
	// `reopen`. Envoyer « opened » ne produirait rien, en silence.
	if let Some(state) = patch.get("stateId").and_then(|v| v.as_str()) {
		body.insert(
			"state_event".into(),
			json!(if state == "closed" { "close" } else { "reopen" }),
		);
	}
	if let Some(assignee) = patch.get("assigneeId") {
		let ids: Vec<i64> = assignee
			.as_str()
			.and_then(|raw| raw.trim().parse::<i64>().ok())
			.or_else(|| assignee.as_i64())
			.map(|id| vec![id])
			// Désassigner se dit par une liste vide, pas par l'absence du champ.
			.unwrap_or_default();
		body.insert("assignee_ids".into(), json!(ids));
	}
	if let Some(labels) = patch.get("labelIds").and_then(|v| v.as_array()) {
		body.insert(
			"labels".into(),
			json!(labels
				.iter()
				.filter_map(|label| label.as_str())
				.collect::<Vec<_>>()
				.join(",")),
		);
	}
	if body.is_empty() {
		return Ok(());
	}

	let response = client()?
		.put(format!("{}/projects/{project}/issues/{iid}", gitlab_api(config)))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/json")
		.json(&Value::Object(body))
		.send()
		.await?;

	if !response.status().is_success() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.gitlabUpdateRefused",
			&[("status", &response.status())],
		)));
	}
	Ok(())
}

/// Ton identifiant GitHub.
///
/// Déclaré s'il l'est, déduit de la session `gh` sinon — comme le jeton. Un
/// réglage de plus à remplir avant que la Permanence ne fonctionne serait un
/// réglage qu'on oublie, et les conditions « la PR est de moi » ou « j'ai déjà
/// commenté » deviendraient silencieusement fausses.
///
/// Vide en cas d'échec, et c'est le bon repli : ces conditions ne peuvent alors
/// pas être vraies, donc elle n'écrit nulle part.
pub async fn github_login(config: &Config) -> String {
	if !config.github.user.trim().is_empty() {
		return config.github.user.trim().to_string();
	}
	crate::runner::capture("/", "gh api user --jq .login 2>/dev/null")
		.await
		.map(|login| login.trim().to_string())
		.unwrap_or_default()
}

/* ── Gestes de la Permanence ────────────────────────────────────────────────
Les seuls appels d'écriture de ce module qui ne partent pas d'un clic.

Ils sont volontairement peu nombreux et tous **réversibles** : relancer une
CI ne casse rien, un label se retire. Un geste qui ne se défait pas n'a rien
à faire dans une liste blanche qu'on coche une fois pour toutes.
────────────────────────────────────────────────────────────────────────── */

/// Relance les jobs en échec du dernier run d'une branche.
///
/// Le dernier run et non un identifiant donné : la Permanence ne doit pas
/// pouvoir relancer un run arbitraire, seulement celui du changement qui l'a
/// réveillée. Rend l'identifiant du run relancé.
pub async fn github_rerun(config: &Config, branch: &str) -> Result<String> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoMissing")));
	}
	let token = github_token(config).await?;
	let runs = json_get_uncached(
		&format!(
			"https://api.github.com/repos/{}/actions/runs?branch={}&per_page=1",
			config.github.repo,
			urlencoding::encode(branch)
		),
		&token,
		"Bearer",
	)
	.await?;

	let run = runs
		.get("workflow_runs")
		.and_then(|value| value.as_array())
		.and_then(|runs| runs.first())
		.ok_or_else(|| CockpitError::msg(crate::i18n::tf("integrations.noCiRun", &[("branch", &branch)])))?;
	let id = run
		.get("id")
		.and_then(|value| value.as_u64())
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("integrations.runNoId")))?;

	let response = client()?
		.post(format!(
			"https://api.github.com/repos/{}/actions/runs/{id}/rerun-failed-jobs",
			config.github.repo
		))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.send()
		.await?;

	if !response.status().is_success() {
		let status = response.status();
		let body = response.text().await.unwrap_or_default();
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.githubRerunRefused",
			&[
				("status", &status),
				("body", &body.chars().take(200).collect::<String>()),
			],
		)));
	}
	Ok(id.to_string())
}

/// Pose un label sur une pull request. Se retire d'un clic.
pub async fn github_add_label(config: &Config, number: u64, label: &str) -> Result<()> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoMissing")));
	}
	let token = github_token(config).await?;
	let response = client()?
		.post(format!(
			"https://api.github.com/repos/{}/issues/{number}/labels",
			config.github.repo
		))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.json(&json!({ "labels": [label] }))
		.send()
		.await?;

	if !response.status().is_success() {
		let status = response.status();
		let body = response.text().await.unwrap_or_default();
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.githubLabelRefused",
			&[
				("status", &status),
				("body", &body.chars().take(200).collect::<String>()),
			],
		)));
	}
	Ok(())
}

/// Retire un label posé. Sert à défaire ce qu'un engagement a produit.
pub async fn github_remove_label(config: &Config, number: u64, label: &str) -> Result<()> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoMissing")));
	}
	let token = github_token(config).await?;
	let response = client()?
		.delete(format!(
			"https://api.github.com/repos/{}/issues/{number}/labels/{}",
			config.github.repo,
			urlencoding::encode(label)
		))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.send()
		.await?;

	// 404 : le label n'y est plus. C'est le résultat voulu, pas une erreur.
	if !response.status().is_success() && response.status().as_u16() != 404 {
		let status = response.status();
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.githubUnlabelRefused",
			&[("status", &status)],
		)));
	}
	Ok(())
}

/// Écrit un commentaire sur une pull request.
///
/// La signature est apposée ici et nulle part ailleurs : sur une PR, c'est le
/// compte de l'utilisateur que ses collègues lisent, et rien dans l'interface
/// de GitHub ne dira que ces mots viennent d'un agent. `journal::actor` répond
/// à « qui a fait ça ? » après coup et en interne — pas à l'instant où le
/// message s'affiche sous les yeux de quelqu'un.
pub async fn github_comment(config: &Config, number: u64, body: &str) -> Result<String> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoMissing")));
	}
	let token = github_token(config).await?;
	let signed = format!("{}\n\n_{}_", body.trim(), crate::config::COMMENT_SIGNATURE);

	let response = client()?
		.post(format!(
			"https://api.github.com/repos/{}/issues/{number}/comments",
			config.github.repo
		))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.json(&json!({ "body": signed }))
		.send()
		.await?;

	if !response.status().is_success() {
		let status = response.status();
		let body = response.text().await.unwrap_or_default();
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.githubCommentRefused",
			&[
				("status", &status),
				("body", &body.chars().take(200).collect::<String>()),
			],
		)));
	}
	let value: Value = response.json().await.unwrap_or(Value::Null);
	Ok(value
		.get("html_url")
		.and_then(|url| url.as_str())
		.unwrap_or_default()
		.to_string())
}

/// Les auteurs des commentaires déjà déposés sur une pull request.
///
/// Sert la condition « j'ai déjà commenté sur cette PR » : le consentement
/// porte sur l'objet, et il faut donc pouvoir le constater sur l'objet.
pub async fn github_commenters(config: &Config, number: u64) -> Result<Vec<String>> {
	if config.github.repo.is_empty() {
		return Ok(Vec::new());
	}
	let token = github_token(config).await?;
	let value = json_get(
		&format!(
			"https://api.github.com/repos/{}/issues/{number}/comments?per_page=100",
			config.github.repo
		),
		&token,
		"Bearer",
	)
	.await?;
	Ok(value
		.as_array()
		.map(|comments| {
			comments
				.iter()
				.filter_map(|comment| {
					comment
						.get("user")
						.and_then(|user| user.get("login"))
						.and_then(|login| login.as_str())
						.map(String::from)
				})
				.collect()
		})
		.unwrap_or_default())
}

/// Ouvre une pull request depuis une branche existante.
///
/// Jumelle de `create_pr_on` dans `lib.rs`, mais sans passer par un chemin de
/// worktree : la Permanence ne travaille pas dans un dossier ouvert, elle agit
/// sur des changements qu'elle a vus passer.
pub async fn create_pull_request(
	config: &Config,
	branch: &str,
	base: &str,
	title: &str,
	body: &str,
	draft: bool,
) -> Result<String> {
	let title = title.trim();
	if title.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.prTitleRequired")));
	}
	if branch == base {
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.prSameAsBase",
			&[("branch", &branch)],
		)));
	}
	let (owner, name) = config
		.github
		.repo
		.split_once('/')
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("integrations.githubRepoFormat")))?;
	let token = github_token(config).await?;

	let response = client()?
		.post(format!("https://api.github.com/repos/{owner}/{name}/pulls"))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.json(&json!({
			"title": title,
			"head": branch,
			"base": base,
			"body": body,
			"draft": draft,
		}))
		.send()
		.await?;

	let status = response.status();
	let raw = response.text().await.unwrap_or_default();
	if !status.is_success() {
		let message = serde_json::from_str::<Value>(&raw)
			.ok()
			.and_then(|value| value.get("message").and_then(|m| m.as_str()).map(String::from))
			.unwrap_or(raw);
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.prRefused",
			&[("status", &status), ("message", &message)],
		)));
	}
	Ok(serde_json::from_str::<Value>(&raw)
		.ok()
		.and_then(|value| value.get("html_url").and_then(|u| u.as_str()).map(String::from))
		.unwrap_or_default())
}

/// Ferme une pull request. Sert à défaire un brouillon ouvert par erreur.
pub async fn close_pull_request(config: &Config, number: u64) -> Result<()> {
	if config.github.repo.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("integrations.githubRepoMissing")));
	}
	let token = github_token(config).await?;
	let response = client()?
		.patch(format!(
			"https://api.github.com/repos/{}/pulls/{number}",
			config.github.repo
		))
		.header("Authorization", format!("Bearer {token}"))
		.header("Accept", "application/vnd.github+json")
		.json(&json!({ "state": "closed" }))
		.send()
		.await?;
	if !response.status().is_success() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"integrations.githubCloseRefused",
			&[("status", &response.status())],
		)));
	}
	Ok(())
}

#[cfg(test)]
mod github_issues_tests {
	use super::github_issues_url;

	#[test]
	fn les_miens_nomment_un_identifiant_jamais_arobase_me() {
		let url = github_issues_url("acme/shop", Some("jodevweb"));
		assert!(url.ends_with("&assignee=jodevweb"), "{url}");
		assert!(!url.contains("@me"));
	}

	#[test]
	fn sans_personne_toutes_les_issues_ouvertes() {
		let url = github_issues_url("acme/shop", None);
		assert!(!url.contains("assignee"), "{url}");
		assert_eq!(github_issues_url("acme/shop", Some("")), url);
	}
}
