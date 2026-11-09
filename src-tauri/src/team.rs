//! Team board du daily : qui travaille sur quoi, ce qui coince, ce qui a bougé.
//!
//! Port du board web `scripts/team-board` du monorepo. Trois sources croisées —
//! Linear pour le cycle en cours, GitHub pour les PR, Sentry pour la prod — et
//! une lecture unique : des questions à poser, pas des tableaux à déchiffrer.
//!
//! Toute la logique métier tient ici (seuils, flags, narration) pour que l'UI
//! n'ait qu'à afficher : c'est ce qui permet de la reprendre sans la réécrire.

use crate::config::{Config, TeamMemberConfig};
use crate::error::{CockpitError, Result};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc, Weekday};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

// ──────────────────────────────── Réglages ────────────────────────────────

/// Branches sur lesquelles une PR a le droit d'être basée. Toute autre base
/// signifie une PR empilée sur une PR non mergée.
/// Repli quand la configuration ne dit rien : les noms les plus répandus.
const BASE_BRANCHES: [&str; 4] = ["main", "master", "develop", "dev"];

/// Vrai quand cette branche est une base de merge et non une PR empilée.
fn is_base_branch(workflow: &crate::config::WorkflowConfig, branch: &str) -> bool {
	if workflow.base_branches.is_empty() {
		return BASE_BRANCHES.contains(&branch);
	}
	workflow.base_branches.iter().any(|entry| entry == branch)
}

/// Jours de daily (lundi, mercredi, vendredi) : sert à calculer la fenêtre
/// « depuis le dernier daily ».
/// Repli : tous les jours ouvrés, quand la configuration ne dit rien.
const DAILY_WEEKDAYS: [Weekday; 5] = [Weekday::Mon, Weekday::Tue, Weekday::Wed, Weekday::Thu, Weekday::Fri];

/// `1` = lundi, comme dans la configuration.
fn meets_on(workflow: &crate::config::WorkflowConfig, day: Weekday) -> bool {
	if workflow.daily_weekdays.is_empty() {
		return DAILY_WEEKDAYS.contains(&day);
	}
	let number = day.number_from_monday() as u8;
	workflow.daily_weekdays.contains(&number)
}

struct Thresholds {
	pr_review_stale_days: i64,
	pr_draft_stale_days: i64,
	in_progress_no_pr_stale_days: i64,
	review_stale_days: i64,
	idle_stale_days: i64,
	wip_overload: usize,
}

const T: Thresholds = Thresholds {
	pr_review_stale_days: 2,
	pr_draft_stale_days: 4,
	in_progress_no_pr_stale_days: 3,
	review_stale_days: 4,
	idle_stale_days: 3,
	wip_overload: 4,
};

/// Rang d'affichage des flags à sévérité égale : le plus actionnable d'abord.
fn flag_rank(category: &str) -> i32 {
	match category {
		"blocked" => 0,
		"pr-ci-failing" => 1,
		"pr-stacked" => 2,
		"pr-approved" => 3,
		"pr-changes-requested" => 4,
		"pr-review-stale" => 5,
		"pr-draft" => 6,
		"inprogress-nopr" => 7,
		"review-stale" => 8,
		"wip" => 9,
		"assignee-mismatch" => 10,
		"idle" => 11,
		_ => 99,
	}
}

/// Avancement associé à chaque état Linear, pour situer un ticket d'un coup d'œil.
/// Avancement d'un état, déduit de sa place dans le flux déclaré.
///
/// Les paliers étaient gravés pour les colonnes d'une seule équipe. Ils se
/// calculent maintenant : chaque phase occupe une tranche, et les états d'une
/// même phase s'y répartissent dans l'ordre où ils sont déclarés.
fn state_progress(workflow: &crate::config::WorkflowConfig, state: &str) -> u32 {
	let place = |list: &[String], from: u32, to: u32| -> Option<u32> {
		let index = list.iter().position(|entry| entry == state)?;
		let steps = list.len().max(1) as u32;
		Some(from + (to - from) * (index as u32 + 1) / steps)
	};
	place(&workflow.active_states, 20, 60)
		.or_else(|| place(&workflow.review_states, 60, 95))
		.or_else(|| place(&workflow.done_states, 95, 100))
		// Sans colonnes déclarées, la phase suffit à situer le ticket.
		.unwrap_or_else(|| match state_phase(workflow, state) {
			"active" => 40,
			"review" => 75,
			"done" => 100,
			_ => 0,
		})
}

/// Colonnes reconnues quand la configuration n'en déclare aucune : les noms les
/// plus répandus, pour qu'une installation neuve affiche déjà quelque chose.
const FALLBACK_ACTIVE: [&str; 3] = ["In Progress", "Doing", "En cours"];
const FALLBACK_REVIEW: [&str; 3] = ["In Review", "Review", "En review"];
const FALLBACK_DONE: [&str; 3] = ["Done", "Merged", "Terminé"];

/// Phase de travail d'un état : `active`, `review`, `done` ou `upcoming`.
fn state_phase(workflow: &crate::config::WorkflowConfig, state: &str) -> &'static str {
	if workflow.active_states.is_empty() && workflow.review_states.is_empty() && workflow.done_states.is_empty() {
		return if FALLBACK_ACTIVE.contains(&state) {
			"active"
		} else if FALLBACK_REVIEW.contains(&state) {
			"review"
		} else if FALLBACK_DONE.contains(&state) {
			"done"
		} else {
			"upcoming"
		};
	}
	let has = |list: &[String]| list.iter().any(|entry| entry == state);
	if has(&workflow.active_states) {
		"active"
	} else if has(&workflow.review_states) {
		"review"
	} else if has(&workflow.done_states) {
		"done"
	} else {
		"upcoming"
	}
}

fn priority_label(priority: i64) -> String {
	match priority {
		1 => crate::i18n::t("team.priority.urgent"),
		2 => crate::i18n::t("team.priority.high"),
		3 => crate::i18n::t("team.priority.medium"),
		4 => crate::i18n::t("team.priority.low"),
		_ => "—".into(),
	}
}

/// Un texte de l'écran Équipe, ses `{{nom}}` remplacés.
fn tr(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
	crate::i18n::tf(&format!("team.{key}"), args)
}

/// Un décompte de l'écran Équipe (`team.<clé>_one` / `_other`…).
fn count(key: &str, value: usize) -> String {
	crate::brief::counted(&format!("team.{key}"), value)
}

// ──────────────────────────────── Équipe ────────────────────────────────

/// Identifiant de l'équipe du suivi de tâches.
///
/// Aucune valeur par défaut : une équipe, ses membres et leurs adresses se
/// déclarent dans la configuration. Un exécutable distribué à d'autres ne doit
/// rien porter de celle qui l'a écrit — ni nom, ni adresse, ni identifiant.
/// Équipe du suivi de tâches, telle que la configuration la déclare.
pub fn default_linear_team_id() -> String {
	crate::config::Config::active().team.linear_team_id
}

fn members_of(config: &Config) -> Vec<TeamMemberConfig> {
	if config.team.members.is_empty() {
		// Plus personne à afficher : le tableau le dira, plutôt que de montrer
		// une équipe qui n'est pas la sienne.
		Vec::new()
	} else {
		config.team.members.clone()
	}
}

/// Ce ticket est-il celui de ce membre ?
///
/// Selon le suivi, le titulaire arrive sous une forme différente : un UUID chez
/// Linear, un login chez GitLab et GitHub. On accepte les deux plutôt que d'exiger
/// un champ de configuration par service — l'équipe déclare ce qu'elle sait, et le
/// rapprochement se fait ici.
fn owns(member: &TeamMemberConfig, assignee: &str) -> bool {
	let assignee = assignee.trim();
	if assignee.is_empty() {
		return false;
	}
	let tracker = member.linear_id.trim();
	(!tracker.is_empty() && tracker == assignee) || is_member_login(member, assignee)
}

/// Tous les logins GitHub d'un membre, en minuscules.
fn logins_of(member: &TeamMemberConfig) -> Vec<String> {
	let mut logins: Vec<String> = Vec::new();
	if !member.github.is_empty() {
		logins.push(member.github.to_lowercase());
	}
	logins.extend(member.github_aliases.iter().map(|a| a.to_lowercase()));
	logins
}

fn is_member_login(member: &TeamMemberConfig, login: &str) -> bool {
	!login.is_empty() && logins_of(member).iter().any(|l| l == &login.to_lowercase())
}

fn member_name_of<'a>(members: &'a [TeamMemberConfig], login: &str) -> Option<&'a str> {
	members
		.iter()
		.find(|m| is_member_login(m, login))
		.map(|m| m.name.as_str())
}

// ───────────────────────────────── Temps ─────────────────────────────────

/// Âge en jours ouvrés : une PR ouverte vendredi n'est pas « en retard » le lundi.
fn business_days_between(from_iso: &str, to: DateTime<Utc>) -> i64 {
	let Ok(from) = DateTime::parse_from_rfc3339(from_iso) else {
		return 0;
	};
	let mut cursor = from.with_timezone(&Utc).date_naive();
	let end = to.date_naive();
	let mut count = 0;
	while cursor < end {
		cursor += Duration::days(1);
		if !matches!(cursor.weekday(), Weekday::Sat | Weekday::Sun) {
			count += 1;
		}
	}
	count
}

/// Date du daily précédent : la borne de « ce qui a bougé depuis ».
fn last_daily_date(workflow: &crate::config::WorkflowConfig, now: DateTime<Utc>) -> NaiveDate {
	let mut cursor = now.date_naive();
	// Une semaine suffit à retrouver le jour de réunion le plus proche ; au-delà,
	// c'est que la configuration n'en déclare aucun de valide.
	for _ in 0..7 {
		cursor -= Duration::days(1);
		if meets_on(workflow, cursor.weekday()) {
			return cursor;
		}
	}
	now.date_naive() - Duration::days(1)
}

// ───────────────────────────────── Types ─────────────────────────────────

/// Le cycle et les tickets du daily viennent du suivi, quel qu'il soit : ces
/// types vivent donc avec le fournisseur, et non ici. Les alias gardent au
/// tableau son vocabulaire — il parle de cycles et de tickets, pas d'un service.
pub use crate::tickets::TrackerCycle as Cycle;
use crate::tickets::{TeamIssue as LinearIssue, TeamRef};

/// Label GitHub d'une pull request, avec sa couleur d'origine.
///
/// La couleur est ce qui rend le label lisible d'un coup d'œil : dans une liste
/// dense, `bug`, `hotfix` et `chore` ne se distinguent souvent qu'à elle.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
	pub name: String,
	/// Hexadécimal sans `#`, tel que GitHub le renvoie.
	pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
	pub number: i64,
	title: String,
	url: String,
	pub head_ref: String,
	/// Le commit de tête : c'est lui qui dit si la PR a bougé depuis une revue.
	pub head_sha: String,
	pub base_ref: String,
	pub author: String,
	pub is_draft: bool,
	pub review_decision: String,
	pub ci_state: String,
	pub created_at: String,
	/// Dernière activité — commit, commentaire, review. C'est elle qui dit si une
	/// PR est le sujet du moment ou un chantier laissé de côté.
	pub updated_at: String,
	pub linear_ids: Vec<String>,
	pub review_request_logins: Vec<String>,
	pub labels: Vec<PrLabel>,
}

#[derive(Debug, Clone)]
struct MergedPr {
	number: i64,
	title: String,
	url: String,
	author: String,
	linear_ids: Vec<String>,
	labels: Vec<PrLabel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagItem {
	pub label: String,
	pub url: String,
	pub meta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
	/// `red` = bloquant, `orange` = à challenger.
	pub severity: String,
	pub member: String,
	pub category: String,
	/// Formulée en question : c'est ce qu'on lit à voix haute au daily.
	pub question: String,
	pub ticket_id: Option<String>,
	pub ticket_url: Option<String>,
	pub pr_number: Option<i64>,
	pub pr_url: Option<String>,
	/// Détail des éléments agrégés, pour déplier sans retourner sur GitHub.
	pub items: Vec<FlagItem>,
	pub key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCard {
	pub identifier: String,
	pub title: String,
	pub description: String,
	pub url: String,
	pub state_name: String,
	pub phase: String,
	pub progress: u32,
	pub age_days: i64,
	/// Dernière activité, telle que le suivi la donne.
	pub updated_at: String,
	pub pr_numbers: Vec<i64>,
	/// Échelle Linear : 0 = non définie, 1 = urgent … 4 = basse.
	pub priority: i64,
	pub priority_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberPr {
	pub number: i64,
	pub url: String,
	pub title: String,
	/// Branche de la PR : c'est elle qui relie une PR à son worktree local.
	pub head_ref: String,
	pub base_ref: String,
	pub ci_state: String,
	pub review_decision: String,
	pub is_draft: bool,
	pub stacked: bool,
	pub age_days: i64,
	/// Jours ouvrés depuis la dernière activité — commit, review, commentaire.
	pub idle_days: i64,
	pub updated_at: String,
	pub ticket_id: Option<String>,
	pub labels: Vec<PrLabel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInboxItem {
	pub number: i64,
	pub url: String,
	pub title: String,
	pub author: String,
	pub age_days: i64,
	pub labels: Vec<PrLabel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaItem {
	/// `merged` ou `opened`, depuis le dernier daily.
	pub kind: String,
	pub label: String,
	pub url: String,
	pub ticket_id: Option<String>,
	pub labels: Vec<PrLabel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextTicket {
	pub identifier: String,
	pub title: String,
	pub url: String,
	pub priority_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCount {
	pub label: String,
	pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Narrative {
	pub text: String,
	pub current: Vec<ThemeCount>,
	pub shipped: Vec<ThemeCount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberMetrics {
	pub active_wip: usize,
	pub in_review: usize,
	pub open_prs: usize,
	pub prs_to_review: usize,
	pub oldest_review_days: i64,
	pub merged_since_daily: usize,
	pub review_pending: usize,
	pub upcoming: usize,
	pub cycle_done: usize,
	pub cycle_total: usize,
	pub cycle_progress: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberBoard {
	pub name: String,
	pub role: String,
	pub role_label: String,
	pub github: Option<String>,
	pub narrative: Narrative,
	pub active_tickets: Vec<TicketCard>,
	pub review_tickets: Vec<TicketCard>,
	pub next: Vec<NextTicket>,
	pub prs: Vec<MemberPr>,
	pub review_inbox: Vec<ReviewInboxItem>,
	pub delta: Vec<DeltaItem>,
	pub metrics: MemberMetrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFlowItem {
	pub number: i64,
	pub url: String,
	pub title: String,
	pub author: String,
	pub ticket_id: Option<String>,
	/// Renseigné pour les PR empilées : la PR qui doit être mergée d'abord.
	pub blocked_by: Option<i64>,
	pub base: String,
	pub labels: Vec<PrLabel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFlow {
	pub ready_to_merge: Vec<PrFlowItem>,
	pub ci_failing: Vec<PrFlowItem>,
	pub stacked: Vec<PrFlowItem>,
	pub ci_pending: usize,
	pub ci_success: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardTotals {
	pub active_wip: usize,
	pub in_review: usize,
	pub open_prs: usize,
	pub merged_since_daily: usize,
	pub blocked: usize,
	pub ready_to_merge: usize,
	pub ci_failing: usize,
	pub red_flags: usize,
	pub orange_flags: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamBoard {
	pub generated_at: String,
	pub cycle: Option<Cycle>,
	pub since_daily: String,
	pub cycle_only: bool,
	pub repo: String,
	pub flags: Vec<Flag>,
	pub members: Vec<MemberBoard>,
	pub pr_flow: PrFlow,
	pub totals: BoardTotals,
	/// Renseigné quand GitHub n'a pas répondu : la board reste lisible côté Linear.
	pub github_error: Option<String>,
}

// ──────────────────────────────── Linear ────────────────────────────────

async fn linear_query(token: &str, query: &str, variables: Value) -> Result<Value> {
	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(25))
		.user_agent("cockpit/0.1")
		.build()
		.map_err(CockpitError::from)?;

	let response = client
		.post("https://api.linear.app/graphql")
		.header("Authorization", token)
		.header("Content-Type", "application/json")
		.json(&json!({ "query": query, "variables": variables }))
		.send()
		.await?;

	let status = response.status();
	let body: Value = response.json().await?;
	if !status.is_success() {
		return Err(CockpitError::msg(format!("Linear {status}")));
	}
	if let Some(first) = body
		.get("errors")
		.and_then(|v| v.as_array())
		.and_then(|errors| errors.first())
	{
		let message = first
			.get("message")
			.and_then(|m| m.as_str())
			.map(str::to_string)
			.unwrap_or_else(|| crate::i18n::t("team.errors.unknown"));
		return Err(CockpitError::msg(tr("errors.linear", &[("message", &message)])));
	}
	Ok(body)
}

pub(crate) async fn fetch_current_cycle(token: &str, team_id: &str) -> Result<Option<Cycle>> {
	let body = linear_query(
		token,
		"query CurrentCycle($teamId: String!) {
			team(id: $teamId) { activeCycle { id number startsAt endsAt } }
		}",
		json!({ "teamId": team_id }),
	)
	.await?;

	let Some(cycle) = body.pointer("/data/team/activeCycle").filter(|v| !v.is_null()) else {
		return Ok(None);
	};
	Ok(Some(Cycle {
		id: cycle.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
		number: cycle.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
		starts_at: cycle
			.get("startsAt")
			.and_then(|v| v.as_str())
			.unwrap_or_default()
			.into(),
		ends_at: cycle.get("endsAt").and_then(|v| v.as_str()).unwrap_or_default().into(),
	}))
}

/// Tickets de l'équipe : ceux du cycle courant, plus tout ce qui est démarré ou
/// bloqué hors cycle — un ticket bloqué depuis deux sprints doit rester visible.
pub(crate) async fn fetch_team_issues(
	token: &str,
	cycle_id: &str,
	member_ids: &[String],
	blocked_state: &str,
) -> Result<Vec<LinearIssue>> {
	let mut issues = Vec::new();
	let mut after: Option<String> = None;

	// Le nom de la colonne « bloqué » vient des réglages : sur un Linear où elle
	// s'appelle « Bloqué » ou « On Hold », filtrer sur « Blocked » faisait
	// disparaître du tableau les tickets bloqués hors du cycle courant — soit
	// exactement ceux qu'on cherchait.
	let mut clauses = vec![
		json!({ "cycle": { "id": { "eq": cycle_id } } }),
		json!({ "state": { "type": { "in": ["started"] } } }),
	];
	if !blocked_state.trim().is_empty() {
		clauses.push(json!({ "state": { "name": { "eq": blocked_state } } }));
	}

	loop {
		let filter = json!({
			"assignee": { "id": { "in": member_ids } },
			"or": clauses,
		});

		let body = linear_query(
			token,
			"query BoardIssues($filter: IssueFilter, $after: String) {
				issues(filter: $filter, first: 100, after: $after) {
					pageInfo { hasNextPage endCursor }
					nodes {
						identifier title description url priority updatedAt
						state { name }
						assignee { id }
						cycle { id }
					}
				}
			}",
			json!({ "filter": filter, "after": after }),
		)
		.await?;

		let nodes = body
			.pointer("/data/issues/nodes")
			.and_then(|v| v.as_array())
			.cloned()
			.unwrap_or_default();

		for node in nodes {
			let text = |pointer: &str| {
				node.pointer(pointer)
					.and_then(|v| v.as_str())
					.unwrap_or_default()
					.to_string()
			};
			issues.push(LinearIssue {
				identifier: text("/identifier"),
				title: text("/title"),
				description: text("/description"),
				url: text("/url"),
				state_name: text("/state/name"),
				priority: node.pointer("/priority").and_then(|v| v.as_i64()).unwrap_or(0),
				updated_at: text("/updatedAt"),
				assignee_id: text("/assignee/id"),
				in_current_cycle: text("/cycle/id") == cycle_id,
			});
		}

		let has_next = body
			.pointer("/data/issues/pageInfo/hasNextPage")
			.and_then(|v| v.as_bool())
			.unwrap_or(false);
		if !has_next {
			break;
		}
		after = body
			.pointer("/data/issues/pageInfo/endCursor")
			.and_then(|v| v.as_str())
			.map(String::from);
		if after.is_none() {
			break;
		}
	}

	Ok(issues)
}

// ──────────────────────────────── GitHub ────────────────────────────────

/// Un identifiant de ticket commence là où une clé d'équipe est suivie d'un
/// tiret puis d'au moins un chiffre : `ABC-1234`.
fn scan_ids(upper: &str, prefix: &str, found: &mut Vec<String>) {
	let bytes = upper.as_bytes();
	let width = prefix.len();
	let mut index = 0;
	while let Some(position) = upper[index..].find(prefix) {
		let start = index + position;
		// La clé doit commencer un mot : sans cela, `SOUS-NW-12` ou un slug qui
		// contient la clé au milieu d'un autre mot passeraient pour un ticket.
		let boundary = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
		let mut end = start + width;
		while end < bytes.len() && bytes[end].is_ascii_digit() {
			end += 1;
		}
		if boundary && end > start + width {
			let id = upper[start..end].to_string();
			if !found.contains(&id) {
				found.push(id);
			}
		}
		index = end.max(start + width);
	}
}

/// Identifiants de tickets cités dans une branche ou un titre.
///
/// La clé d'équipe est un réglage, pas une constante : elle vaut `ABC` chez
/// l'un et `FOO` chez l'autre. Elle a longtemps été codée en dur, ce qui
/// revenait à ne relier aucune pull request à son ticket partout ailleurs que
/// sur le poste qui l'avait écrite.
///
/// Sans clé déclarée, on retombe sur la forme commune à Linear comme à Jira —
/// deux à six lettres, un tiret, des chiffres. C'est plus large, donc faillible
/// (`UTF-8` en est un), mais mieux vaut une détection approximative que pas de
/// détection du tout tant que le réglage n'est pas rempli.
pub(crate) fn extract_ticket_ids(texts: &[&str], team_key: &str) -> Vec<String> {
	let key = team_key.trim().to_uppercase();
	let mut found = Vec::new();
	for text in texts {
		let upper = text.to_uppercase();
		if !key.is_empty() {
			scan_ids(&upper, &format!("{key}-"), &mut found);
			continue;
		}
		// Repli : toute suite de 2 à 6 lettres collée à un tiret et des chiffres.
		let bytes = upper.as_bytes();
		let mut index = 0;
		while index < bytes.len() {
			if !bytes[index].is_ascii_alphabetic() {
				index += 1;
				continue;
			}
			let start = index;
			while index < bytes.len() && bytes[index].is_ascii_alphabetic() {
				index += 1;
			}
			let letters = index - start;
			if !(2..=6).contains(&letters) || index >= bytes.len() || bytes[index] != b'-' {
				continue;
			}
			let mut end = index + 1;
			while end < bytes.len() && bytes[end].is_ascii_digit() {
				end += 1;
			}
			if end > index + 1 {
				let id = upper[start..end].to_string();
				if !found.contains(&id) {
					found.push(id);
				}
				index = end;
			}
		}
	}
	found
}

fn ci_state_of(node: &Value) -> String {
	let state = node
		.pointer("/commits/nodes/0/commit/statusCheckRollup/state")
		.and_then(|v| v.as_str());
	match state {
		Some("SUCCESS") => "success",
		Some("FAILURE") | Some("ERROR") => "failing",
		Some("PENDING") | Some("EXPECTED") => "pending",
		_ => "none",
	}
	.to_string()
}

pub(crate) async fn github_graphql(token: &str, query: &str, variables: Value) -> Result<Value> {
	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(30))
		.user_agent("cockpit/0.1")
		.build()
		.map_err(CockpitError::from)?;

	let response = client
		.post("https://api.github.com/graphql")
		.header("Authorization", format!("Bearer {token}"))
		.json(&json!({ "query": query, "variables": variables }))
		.send()
		.await?;

	let status = response.status();
	let body: Value = response.json().await?;
	if !status.is_success() {
		return Err(CockpitError::msg(format!("GitHub {status}")));
	}
	if let Some(first) = body
		.get("errors")
		.and_then(|v| v.as_array())
		.and_then(|errors| errors.first())
	{
		let message = first
			.get("message")
			.and_then(|m| m.as_str())
			.map(str::to_string)
			.unwrap_or_else(|| crate::i18n::t("team.errors.unknown"));
		return Err(CockpitError::msg(tr("errors.github", &[("message", &message)])));
	}
	Ok(body)
}

/// Labels d'un nœud `PullRequest` GraphQL, dans l'ordre où GitHub les renvoie.
fn labels_of(node: &Value) -> Vec<PrLabel> {
	node.pointer("/labels/nodes")
		.and_then(|v| v.as_array())
		.map(|nodes| {
			nodes
				.iter()
				.map(|label| PrLabel {
					name: label
						.get("name")
						.and_then(|v| v.as_str())
						.unwrap_or_default()
						.to_string(),
					color: label
						.get("color")
						.and_then(|v| v.as_str())
						.unwrap_or_default()
						.to_string(),
				})
				.filter(|label| !label.name.is_empty())
				.collect()
		})
		.unwrap_or_default()
}

/// PR ouvertes avec, en une seule requête, l'état CI et les reviewers demandés —
/// ce que l'API REST ne sait pas faire sans un appel par PR.
pub async fn fetch_open_prs(token: &str, owner: &str, name: &str, team_key: &str) -> Result<Vec<PullRequest>> {
	let mut prs = Vec::new();
	let mut after: Option<String> = None;

	loop {
		let body = github_graphql(
			token,
			"query OpenPrs($owner: String!, $name: String!, $after: String) {
				repository(owner: $owner, name: $name) {
					pullRequests(states: OPEN, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
						pageInfo { hasNextPage endCursor }
						nodes {
							number title url headRefName headRefOid baseRefName isDraft reviewDecision createdAt updatedAt
							author { login }
							labels(first: 10) { nodes { name color } }
							commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
							reviewRequests(first: 20) {
								nodes { requestedReviewer { ... on User { login } } }
							}
						}
					}
				}
			}",
			json!({ "owner": owner, "name": name, "after": after }),
		)
		.await?;

		let nodes = body
			.pointer("/data/repository/pullRequests/nodes")
			.and_then(|v| v.as_array())
			.cloned()
			.unwrap_or_default();

		for node in nodes {
			let text = |pointer: &str| {
				node.pointer(pointer)
					.and_then(|v| v.as_str())
					.unwrap_or_default()
					.to_string()
			};
			let head_ref = text("/headRefName");
			let title = text("/title");
			prs.push(PullRequest {
				number: node.pointer("/number").and_then(|v| v.as_i64()).unwrap_or(0),
				url: text("/url"),
				head_sha: text("/headRefOid"),
				base_ref: text("/baseRefName"),
				author: text("/author/login"),
				is_draft: node.pointer("/isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
				review_decision: text("/reviewDecision"),
				ci_state: ci_state_of(&node),
				created_at: text("/createdAt"),
				updated_at: text("/updatedAt"),
				linear_ids: extract_ticket_ids(&[&head_ref, &title], team_key),
				review_request_logins: node
					.pointer("/reviewRequests/nodes")
					.and_then(|v| v.as_array())
					.map(|nodes| {
						nodes
							.iter()
							.filter_map(|n| n.pointer("/requestedReviewer/login").and_then(|v| v.as_str()))
							.map(String::from)
							.collect()
					})
					.unwrap_or_default(),
				labels: labels_of(&node),
				head_ref,
				title,
			});
		}

		let has_next = body
			.pointer("/data/repository/pullRequests/pageInfo/hasNextPage")
			.and_then(|v| v.as_bool())
			.unwrap_or(false);
		if !has_next {
			break;
		}
		after = body
			.pointer("/data/repository/pullRequests/pageInfo/endCursor")
			.and_then(|v| v.as_str())
			.map(String::from);
		if after.is_none() {
			break;
		}
	}

	Ok(prs)
}

async fn fetch_merged_prs(token: &str, repo: &str, since: NaiveDate, team_key: &str) -> Result<Vec<MergedPr>> {
	let body = github_graphql(
		token,
		"query MergedPrs($query: String!) {
			search(query: $query, type: ISSUE, first: 100) {
				nodes {
					... on PullRequest {
						number title url headRefName
						author { login }
						labels(first: 10) { nodes { name color } }
					}
				}
			}
		}",
		json!({ "query": format!("repo:{repo} is:pr is:merged merged:>={since}") }),
	)
	.await?;

	Ok(body
		.pointer("/data/search/nodes")
		.and_then(|v| v.as_array())
		.map(|nodes| {
			nodes
				.iter()
				.filter(|node| node.get("number").is_some())
				.map(|node| {
					let text = |pointer: &str| {
						node.pointer(pointer)
							.and_then(|v| v.as_str())
							.unwrap_or_default()
							.to_string()
					};
					let head_ref = text("/headRefName");
					let title = text("/title");
					MergedPr {
						number: node.pointer("/number").and_then(|v| v.as_i64()).unwrap_or(0),
						url: text("/url"),
						author: text("/author/login"),
						linear_ids: extract_ticket_ids(&[&head_ref, &title], team_key),
						labels: labels_of(node),
						title,
					}
				})
				.collect()
		})
		.unwrap_or_default())
}

// ───────────────────────────── Thèmes métier ─────────────────────────────

/// Minuscules sans accents, entourées d'espaces pour que les mots-clés courts
/// (` ci `, ` bo `) ne matchent pas au milieu d'un autre mot.
fn normalize(text: &str) -> String {
	let lowered = text.to_lowercase();
	let stripped: String = lowered
		.chars()
		.map(|c| match c {
			'à' | 'â' | 'ä' | 'á' | 'ã' => 'a',
			'é' | 'è' | 'ê' | 'ë' => 'e',
			'î' | 'ï' | 'í' => 'i',
			'ô' | 'ö' | 'ó' | 'õ' => 'o',
			'ù' | 'û' | 'ü' | 'ú' => 'u',
			'ç' => 'c',
			_ => c,
		})
		.collect();
	format!(" {stripped} ")
}

/// Thème d'un titre : le plus spécifique, et lui seul.
///
/// Un titre parle d'une chose. « Corriger l'affichage du panier »
/// touche deux tables de mots-clés — interface, panier — et
/// comptait autrefois pour les deux : le sujet dominant devenait un artefact
/// du vocabulaire plutôt qu'un fait. On départage donc au nombre de mots-clés
/// reconnus, puis à la longueur du plus précis (« retrait en magasin » l'emporte sur
/// « livraison »).
fn theme_of(themes: &[crate::config::ThemeConfig], title: &str) -> Option<usize> {
	let normalized = normalize(title);
	let mut best: Option<(usize, usize, usize)> = None;

	for (index, theme) in themes.iter().enumerate() {
		let matched: Vec<&String> = theme
			.keywords
			.iter()
			.filter(|keyword| normalized.contains(keyword.as_str()))
			.collect();
		if matched.is_empty() {
			continue;
		}
		let longest = matched.iter().map(|k| k.trim().len()).max().unwrap_or(0);
		// La spécificité prime sur le nombre : « retrait en magasin » désigne le sujet
		// mieux que « livraison », « colis » et « transporteur » réunis, qui ne sont
		// que le vocabulaire ordinaire du produit.
		let score = (longest, matched.len(), index);
		match best {
			// Index croissant en dernier recours : à égalité, l'ordre de
			// déclaration tranche, ce qui garde le résultat stable.
			Some((length, count, _)) if (score.0, score.1) <= (length, count) => {}
			_ => best = Some(score),
		}
	}

	best.map(|(_, _, index)| index)
}

fn count_themes(themes: &[crate::config::ThemeConfig], titles: &[String]) -> Vec<ThemeCount> {
	let mut counts: HashMap<usize, usize> = HashMap::new();
	for title in titles {
		if let Some(index) = theme_of(themes, title) {
			*counts.entry(index).or_insert(0) += 1;
		}
	}
	let mut result: Vec<(usize, usize)> = counts.into_iter().collect();
	// Comptes décroissants, puis ordre de déclaration pour rester stable d'un
	// rafraîchissement à l'autre.
	result.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
	result
		.into_iter()
		.map(|(index, count)| ThemeCount {
			label: themes[index].label.clone(),
			count,
		})
		.collect()
}

fn phrase_of(catalog: &[crate::config::ThemeConfig], label: &str) -> String {
	catalog
		.iter()
		.find(|theme| theme.label == label)
		.map(|theme| {
			if theme.phrase.trim().is_empty() {
				theme.label.clone()
			} else {
				theme.phrase.clone()
			}
		})
		.unwrap_or_else(|| crate::i18n::t("team.narrative.theirTopics"))
}

fn join_phrases(catalog: &[crate::config::ThemeConfig], themes: &[ThemeCount]) -> String {
	let phrases: Vec<String> = themes.iter().map(|t| phrase_of(catalog, &t.label)).collect();
	match phrases.len() {
		0 => String::new(),
		1 => phrases[0].to_string(),
		_ => tr(
			"narrative.and",
			&[
				("list", &phrases[..phrases.len() - 1].join(", ")),
				("last", &phrases[phrases.len() - 1]),
			],
		),
	}
}

struct NarrativeInput<'a> {
	name: &'a str,
	is_dev: bool,
	active_count: usize,
	review_count: usize,
	open_pr_count: usize,
	shipped_count: usize,
	opened_count: usize,
	review_pending: usize,
	red_flags: usize,
	orange_flags: usize,
}

/// Deux à trois phrases en français : sur quoi la personne est, ce qu'elle a
/// livré, ce qui coince.
fn build_narrative(
	catalog: &[crate::config::ThemeConfig],
	input: NarrativeInput,
	current: Vec<ThemeCount>,
	shipped: Vec<ThemeCount>,
) -> Narrative {
	let mut load = Vec::new();
	if input.active_count > 0 {
		load.push(count("narrative.activeTickets", input.active_count));
	}
	if input.review_count > 0 {
		load.push(count("narrative.reviewTickets", input.review_count));
	}
	if input.open_pr_count > 0 {
		load.push(count("narrative.openPrs", input.open_pr_count));
	}
	let load_text = if load.is_empty() {
		String::new()
	} else {
		format!(" ({})", load.join(", "))
	};

	let top: Vec<ThemeCount> = current.iter().take(3).cloned().collect();
	let current_sentence = if top.is_empty() {
		if input.active_count == 0 && input.open_pr_count == 0 {
			if input.is_dev {
				tr("narrative.nothingActiveDev", &[("name", &input.name)])
			} else {
				tr("narrative.nothingActive", &[("name", &input.name)])
			}
		} else {
			tr("narrative.variedTopics", &[("name", &input.name), ("load", &load_text)])
		}
	} else {
		let dominant = &top[0];
		let others = &top[1..];
		// « Est surtout sur X » est une affirmation forte : elle demande une
		// vraie majorité, pas une avance d'une voix. Sans ce seuil, deux
		// tickets sur sept suffisaient à décréter un focus qui n'existait pas.
		let classified: usize = current.iter().map(|theme| theme.count).sum();
		let focused = dominant.count >= 2
			&& (others.is_empty() || dominant.count > others[0].count)
			&& dominant.count * 2 >= classified;
		if focused {
			let tail = if others.is_empty() {
				String::new()
			} else {
				tr("narrative.alsoOn", &[("themes", &join_phrases(catalog, others))])
			};
			tr(
				"narrative.mostlyOn",
				&[
					("name", &input.name),
					("theme", &phrase_of(catalog, &dominant.label)),
					("tail", &tail),
					("load", &load_text),
				],
			)
		} else {
			tr(
				"narrative.workingOn",
				&[
					("name", &input.name),
					("themes", &join_phrases(catalog, &top)),
					("load", &load_text),
				],
			)
		}
	};

	let shipped_sentence = if input.shipped_count == 0 && input.opened_count == 0 {
		crate::i18n::t("team.narrative.nothingMerged")
	} else if input.shipped_count == 0 {
		tr(
			"narrative.openedNothingMerged",
			&[("opened", &count("narrative.openPrs", input.opened_count))],
		)
	} else {
		let themes = if shipped.is_empty() {
			String::new()
		} else {
			tr(
				"narrative.shippedOn",
				&[(
					"themes",
					&join_phrases(catalog, &shipped.iter().take(2).cloned().collect::<Vec<_>>()),
				)],
			)
		};
		let opened = if input.opened_count > 0 {
			tr(
				"narrative.andOpened",
				&[("opened", &count("narrative.newOpenPrs", input.opened_count))],
			)
		} else {
			String::new()
		};
		tr(
			"narrative.shipped",
			&[
				("prs", &count("narrative.prs", input.shipped_count)),
				("themes", &themes),
				("opened", &opened),
			],
		)
	};

	let mut friction = Vec::new();
	if input.red_flags > 0 {
		friction.push(count("narrative.blockingPoints", input.red_flags));
	}
	if input.orange_flags > 0 {
		friction.push(tr("narrative.toChallenge", &[("count", &input.orange_flags)]));
	}
	if input.review_pending > 0 {
		friction.push(tr(
			"narrative.toReview",
			&[("prs", &count("narrative.prs", input.review_pending))],
		));
	}
	let friction_sentence = if friction.is_empty() {
		crate::i18n::t("team.narrative.nothingStuck")
	} else {
		tr("narrative.toWatch", &[("items", &friction.join(", "))])
	};

	Narrative {
		text: format!("{current_sentence} {shipped_sentence} {friction_sentence}"),
		current: top,
		shipped: shipped.into_iter().take(2).collect(),
	}
}

// ───────────────────────────────── Flags ─────────────────────────────────

struct MemberContext {
	name: String,
	is_dev: bool,
	active: Vec<LinearIssue>,
	review: Vec<LinearIssue>,
	blocked: Vec<LinearIssue>,
	linked_issue_ids: HashSet<String>,
	authored_prs: Vec<PullRequest>,
	foreign_author_prs: Vec<(PullRequest, String)>,
}

fn truncate(text: &str, max: usize) -> String {
	if text.chars().count() <= max {
		return text.to_string();
	}
	let cut: String = text.chars().take(max).collect();
	format!("{}…", cut.trim_end())
}

fn sample(ids: &[String], max: usize) -> String {
	if ids.len() <= max {
		return ids.join(", ");
	}
	format!("{}, +{}", ids[..max].join(", "), ids.len() - max)
}

fn ticket_item(issue: &LinearIssue, now: DateTime<Utc>) -> FlagItem {
	FlagItem {
		label: format!("{} {}", issue.identifier, truncate(&issue.title, 56)),
		url: issue.url.clone(),
		meta: format!(
			"{} · {}",
			issue.state_name,
			tr("days", &[("count", &business_days_between(&issue.updated_at, now))])
		),
	}
}

fn pr_item(pr: &PullRequest, now: DateTime<Utc>) -> FlagItem {
	let ci = match pr.ci_state.as_str() {
		"failing" => " · CI✗",
		"pending" => " · CI…",
		_ => "",
	};
	FlagItem {
		label: format!("#{} {}", pr.number, truncate(&pr.title, 56)),
		url: pr.url.clone(),
		meta: format!(
			"{}{ci}",
			tr("days", &[("count", &business_days_between(&pr.created_at, now))])
		),
	}
}

struct FlagDraft {
	severity: &'static str,
	member: String,
	category: &'static str,
	question: String,
	ticket_id: Option<String>,
	ticket_url: Option<String>,
	pr_number: Option<i64>,
	pr_url: Option<String>,
	items: Vec<FlagItem>,
}

fn finish(draft: FlagDraft) -> Flag {
	let suffix = draft
		.ticket_id
		.clone()
		.or_else(|| draft.pr_number.map(|n| format!("pr{n}")))
		.unwrap_or_default();
	Flag {
		key: format!("{}|{}|{suffix}", draft.member, draft.category),
		severity: draft.severity.to_string(),
		member: draft.member,
		category: draft.category.to_string(),
		question: draft.question,
		ticket_id: draft.ticket_id,
		ticket_url: draft.ticket_url,
		pr_number: draft.pr_number,
		pr_url: draft.pr_url,
		items: draft.items,
	}
}

fn pr_flag(severity: &'static str, member: &str, category: &'static str, question: String, pr: &PullRequest) -> Flag {
	finish(FlagDraft {
		severity,
		member: member.to_string(),
		category,
		question,
		ticket_id: pr.linear_ids.first().cloned(),
		ticket_url: None,
		pr_number: Some(pr.number),
		pr_url: Some(pr.url.clone()),
		items: Vec::new(),
	})
}

fn compute_flags(
	workflow: &crate::config::WorkflowConfig,
	contexts: &[MemberContext],
	now: DateTime<Utc>,
) -> Vec<Flag> {
	let mut flags = Vec::new();

	for ctx in contexts {
		let name = ctx.name.as_str();

		if !ctx.blocked.is_empty() {
			let ids: Vec<String> = ctx.blocked.iter().map(|i| i.identifier.clone()).collect();
			flags.push(finish(FlagDraft {
				severity: "red",
				member: name.to_string(),
				category: "blocked",
				question: if ids.len() == 1 {
					tr("flags.blockedOne", &[("id", &ids[0])])
				} else {
					tr("flags.blockedMany", &[("count", &ids.len()), ("ids", &sample(&ids, 3))])
				},
				ticket_id: Some(ctx.blocked[0].identifier.clone()),
				ticket_url: Some(ctx.blocked[0].url.clone()),
				pr_number: None,
				pr_url: None,
				items: ctx.blocked.iter().map(|i| ticket_item(i, now)).collect(),
			}));
		}

		// Une PR ne lève qu'un seul flag : le plus grave. Empiler « CI rouge » et
		// « en attente de review » sur la même PR noierait la question à poser.
		let mut review_stale: Vec<(&PullRequest, i64)> = Vec::new();
		let mut draft_stale: Vec<(&PullRequest, i64)> = Vec::new();
		for pr in &ctx.authored_prs {
			let age = business_days_between(&pr.created_at, now);
			if !is_base_branch(workflow, &pr.base_ref) {
				flags.push(pr_flag(
					"red",
					name,
					"pr-stacked",
					tr("flags.stacked", &[("number", &pr.number), ("base", &pr.base_ref)]),
					pr,
				));
			} else if pr.ci_state == "failing" {
				flags.push(pr_flag(
					"red",
					name,
					"pr-ci-failing",
					tr("flags.ciFailing", &[("number", &pr.number)]),
					pr,
				));
			} else if pr.review_decision == "APPROVED" {
				flags.push(pr_flag(
					"red",
					name,
					"pr-approved",
					tr("flags.approved", &[("number", &pr.number)]),
					pr,
				));
			} else if pr.review_decision == "CHANGES_REQUESTED" {
				flags.push(pr_flag(
					"orange",
					name,
					"pr-changes-requested",
					tr("flags.changesRequested", &[("number", &pr.number)]),
					pr,
				));
			} else if pr.is_draft {
				if age >= T.pr_draft_stale_days {
					draft_stale.push((pr, age));
				}
			} else if age >= T.pr_review_stale_days {
				review_stale.push((pr, age));
			}
		}

		if !review_stale.is_empty() {
			review_stale.sort_by_key(|a| std::cmp::Reverse(a.1));
			let (oldest, oldest_age) = review_stale[0];
			let numbers: Vec<String> = review_stale.iter().map(|(pr, _)| format!("#{}", pr.number)).collect();
			flags.push(finish(FlagDraft {
				severity: "orange",
				member: name.to_string(),
				category: "pr-review-stale",
				question: if review_stale.len() == 1 {
					tr(
						"flags.reviewStaleOne",
						&[("number", &oldest.number), ("age", &oldest_age)],
					)
				} else {
					tr(
						"flags.reviewStaleMany",
						&[
							("count", &review_stale.len()),
							("days", &T.pr_review_stale_days),
							("numbers", &sample(&numbers, 3)),
							("age", &oldest_age),
						],
					)
				},
				ticket_id: None,
				ticket_url: None,
				pr_number: Some(oldest.number),
				pr_url: Some(oldest.url.clone()),
				items: review_stale.iter().map(|(pr, _)| pr_item(pr, now)).collect(),
			}));
		}

		if !draft_stale.is_empty() {
			draft_stale.sort_by_key(|a| std::cmp::Reverse(a.1));
			let numbers: Vec<String> = draft_stale.iter().map(|(pr, _)| format!("#{}", pr.number)).collect();
			flags.push(finish(FlagDraft {
				severity: "orange",
				member: name.to_string(),
				category: "pr-draft",
				question: tr(
					"flags.draftStale",
					&[
						("count", &draft_stale.len()),
						("days", &T.pr_draft_stale_days),
						("numbers", &sample(&numbers, 3)),
					],
				),
				ticket_id: None,
				ticket_url: None,
				pr_number: Some(draft_stale[0].0.number),
				pr_url: Some(draft_stale[0].0.url.clone()),
				items: draft_stale.iter().map(|(pr, _)| pr_item(pr, now)).collect(),
			}));
		}

		let stale_no_pr: Vec<&LinearIssue> = ctx
			.active
			.iter()
			.filter(|i| {
				!ctx.linked_issue_ids.contains(&i.identifier)
					&& business_days_between(&i.updated_at, now) >= T.in_progress_no_pr_stale_days
			})
			.collect();
		if !stale_no_pr.is_empty() {
			let ids: Vec<String> = stale_no_pr.iter().map(|i| i.identifier.clone()).collect();
			flags.push(finish(FlagDraft {
				severity: "orange",
				member: name.to_string(),
				category: "inprogress-nopr",
				question: if ids.len() == 1 {
					tr(
						"flags.inProgressNoPrOne",
						&[("id", &ids[0]), ("days", &T.in_progress_no_pr_stale_days)],
					)
				} else {
					tr(
						"flags.inProgressNoPrMany",
						&[
							("count", &ids.len()),
							("days", &T.in_progress_no_pr_stale_days),
							("ids", &sample(&ids, 3)),
						],
					)
				},
				ticket_id: Some(stale_no_pr[0].identifier.clone()),
				ticket_url: Some(stale_no_pr[0].url.clone()),
				pr_number: None,
				pr_url: None,
				items: stale_no_pr.iter().map(|i| ticket_item(i, now)).collect(),
			}));
		}

		let stale_review: Vec<&LinearIssue> = ctx
			.review
			.iter()
			.filter(|i| business_days_between(&i.updated_at, now) >= T.review_stale_days)
			.collect();
		if !stale_review.is_empty() {
			let ids: Vec<String> = stale_review.iter().map(|i| i.identifier.clone()).collect();
			flags.push(finish(FlagDraft {
				severity: "orange",
				member: name.to_string(),
				category: "review-stale",
				question: tr(
					"flags.reviewStale",
					&[
						("count", &ids.len()),
						("days", &T.review_stale_days),
						("ids", &sample(&ids, 3)),
					],
				),
				ticket_id: Some(stale_review[0].identifier.clone()),
				ticket_url: Some(stale_review[0].url.clone()),
				pr_number: None,
				pr_url: None,
				items: stale_review.iter().map(|i| ticket_item(i, now)).collect(),
			}));
		}

		if ctx.active.len() >= T.wip_overload {
			flags.push(finish(FlagDraft {
				severity: "orange",
				member: name.to_string(),
				category: "wip",
				question: tr("flags.wip", &[("count", &ctx.active.len())]),
				ticket_id: None,
				ticket_url: None,
				pr_number: None,
				pr_url: None,
				items: ctx.active.iter().map(|i| ticket_item(i, now)).collect(),
			}));
		}

		for (pr, issue_id) in &ctx.foreign_author_prs {
			flags.push(finish(FlagDraft {
				severity: "orange",
				member: name.to_string(),
				category: "assignee-mismatch",
				question: tr(
					"flags.assigneeMismatch",
					&[
						("issue", issue_id),
						("name", &name),
						("author", &pr.author),
						("number", &pr.number),
					],
				),
				ticket_id: Some(issue_id.clone()),
				ticket_url: None,
				pr_number: Some(pr.number),
				pr_url: Some(pr.url.clone()),
				items: Vec::new(),
			}));
		}

		if ctx.is_dev && ctx.authored_prs.is_empty() {
			let active_or_review = ctx.active.len() + ctx.review.len();
			let all_stale = active_or_review == 0
				|| ctx
					.active
					.iter()
					.chain(ctx.review.iter())
					.all(|i| business_days_between(&i.updated_at, now) >= T.idle_stale_days);
			if all_stale {
				flags.push(finish(FlagDraft {
					severity: "orange",
					member: name.to_string(),
					category: "idle",
					question: if active_or_review == 0 {
						crate::i18n::t("team.flags.idleNothing")
					} else {
						crate::i18n::t("team.flags.idleStale")
					},
					ticket_id: None,
					ticket_url: None,
					pr_number: None,
					pr_url: None,
					items: Vec::new(),
				}));
			}
		}
	}

	flags.sort_by(|a, b| {
		let rank = |severity: &str| if severity == "red" { 0 } else { 1 };
		rank(&a.severity)
			.cmp(&rank(&b.severity))
			.then(flag_rank(&a.category).cmp(&flag_rank(&b.category)))
	});
	flags
}

// ─────────────────────────────── Agrégation ───────────────────────────────

fn short_description(markdown: &str) -> String {
	let mut text = String::new();
	let mut in_code = false;
	for line in markdown.lines() {
		if line.trim_start().starts_with("```") {
			in_code = !in_code;
			continue;
		}
		if in_code {
			continue;
		}
		for c in line.chars() {
			if !matches!(c, '#' | '>' | '*' | '_' | '`' | '~' | '|' | '[' | ']') {
				text.push(c);
			}
		}
		text.push(' ');
	}
	let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
	truncate(&collapsed, 200)
}

fn pr_action_rank(pr: &MemberPr) -> u8 {
	if pr.ci_state == "failing" {
		return 0;
	}
	if pr.stacked {
		return 1;
	}
	match pr.review_decision.as_str() {
		"CHANGES_REQUESTED" => 2,
		"APPROVED" => 3,
		_ if pr.is_draft => 6,
		_ if pr.ci_state == "pending" => 5,
		_ => 4,
	}
}

fn build_pr_flow(
	workflow: &crate::config::WorkflowConfig,
	members: &[TeamMemberConfig],
	open_prs: &[PullRequest],
) -> PrFlow {
	let team_prs: Vec<&PullRequest> = open_prs
		.iter()
		.filter(|pr| member_name_of(members, &pr.author).is_some())
		.collect();

	// Une PR empilée est bloquée par celle dont la branche lui sert de base.
	let head_to_number: HashMap<&str, i64> = open_prs.iter().map(|pr| (pr.head_ref.as_str(), pr.number)).collect();

	let item = |pr: &PullRequest| PrFlowItem {
		number: pr.number,
		url: pr.url.clone(),
		title: pr.title.clone(),
		author: member_name_of(members, &pr.author).unwrap_or(&pr.author).to_string(),
		ticket_id: pr.linear_ids.first().cloned(),
		blocked_by: head_to_number.get(pr.base_ref.as_str()).copied(),
		base: pr.base_ref.clone(),
		labels: pr.labels.clone(),
	};

	PrFlow {
		ready_to_merge: team_prs
			.iter()
			.filter(|pr| {
				!pr.is_draft
					&& pr.review_decision == "APPROVED"
					&& pr.ci_state == "success"
					&& is_base_branch(workflow, &pr.base_ref)
			})
			.map(|pr| item(pr))
			.collect(),
		ci_failing: team_prs
			.iter()
			.filter(|pr| !pr.is_draft && pr.ci_state == "failing")
			.map(|pr| item(pr))
			.collect(),
		stacked: team_prs
			.iter()
			.filter(|pr| !is_base_branch(workflow, &pr.base_ref))
			.map(|pr| item(pr))
			.collect(),
		ci_pending: team_prs
			.iter()
			.filter(|pr| !pr.is_draft && pr.ci_state == "pending")
			.count(),
		ci_success: team_prs
			.iter()
			.filter(|pr| !pr.is_draft && pr.ci_state == "success")
			.count(),
	}
}

pub async fn build_board(config: &Config, cycle_only: bool) -> Result<TeamBoard> {
	if config.linear.token.is_empty() {
		return Err(CockpitError::missing("Linear"));
	}

	let now = Utc::now();
	let since_daily = last_daily_date(&config.workflow, now);
	let members = members_of(config);
	// Une équipe sans membre n'a pas de daily à raconter, et le dire vaut mieux
	// qu'un tableau vide dont on cherche la cause dans un fichier.
	if members.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("team.errors.noMembers")));
	}

	// Le daily passe par le fournisseur configuré, comme le reste du cockpit. Il
	// interrogeait Linear en direct : une équipe sur GitLab ou sur les issues de
	// son dépôt n'avait donc pas de daily, alors que ses tickets s'affichaient
	// partout ailleurs.
	let tracker = crate::tickets::provider(config)?;
	let cycle = tracker.cycle().await?;
	let cycle_id = cycle.as_ref().map(|entry| entry.id.clone()).unwrap_or_default();

	// Ce que l'équipe déclare, et à chaque suivi d'y reconnaître les siens : un
	// UUID chez Linear, un login ailleurs.
	let refs: Vec<TeamRef> = members
		.iter()
		.map(|member| TeamRef {
			tracker_id: member.linear_id.clone(),
			logins: logins_of(member),
		})
		.collect();
	let issues = tracker.team_issues(&refs, &cycle_id).await?;

	// GitHub est optionnel : sans lui la board reste utile côté tickets, elle le
	// signale plutôt que d'échouer entièrement.
	let (open_prs, merged_prs, github_error) = match crate::integrations::github_token(config).await {
		Ok(token) => {
			let (owner, name) = config
				.github
				.repo
				.split_once('/')
				.map(|(o, n)| (o.to_string(), n.to_string()))
				.unwrap_or_default();
			if owner.is_empty() {
				(
					Vec::new(),
					Vec::new(),
					Some(crate::i18n::t("team.errors.githubRepoMissing")),
				)
			} else {
				match fetch_open_prs(&token, &owner, &name, &config.linear.team_key).await {
					Ok(open) => {
						let merged =
							fetch_merged_prs(&token, &config.github.repo, since_daily, &config.linear.team_key)
								.await
								.unwrap_or_default();
						(open, merged, None)
					}
					Err(error) => (Vec::new(), Vec::new(), Some(error.to_string())),
				}
			}
		}
		Err(error) => (Vec::new(), Vec::new(), Some(error.to_string())),
	};

	let mut prs_by_issue: HashMap<&str, Vec<&PullRequest>> = HashMap::new();
	for pr in &open_prs {
		for id in &pr.linear_ids {
			prs_by_issue.entry(id.as_str()).or_default().push(pr);
		}
	}

	let scoped: Vec<&LinearIssue> = issues
		.iter()
		.filter(|issue| !cycle_only || issue.in_current_cycle)
		.collect();

	let mut contexts = Vec::new();
	let mut boards = Vec::new();

	for member in &members {
		let own: Vec<&LinearIssue> = scoped
			.iter()
			.copied()
			.filter(|issue| owns(member, &issue.assignee_id))
			.collect();

		let mut active = Vec::new();
		let mut review = Vec::new();
		let mut blocked = Vec::new();
		let mut upcoming = 0;
		let mut cycle_total = 0;
		let mut cycle_done = 0;

		for issue in &own {
			let phase = state_phase(&config.workflow, &issue.state_name);
			if issue.in_current_cycle {
				cycle_total += 1;
				if phase == "done" {
					cycle_done += 1;
				}
			}
			if issue.state_name == config.workflow.blocked_state {
				blocked.push((*issue).clone());
			} else if phase == "active" {
				active.push((*issue).clone());
			} else if phase == "review" {
				review.push((*issue).clone());
			} else if phase == "upcoming" {
				upcoming += 1;
			}
		}

		let to_card = |issue: &LinearIssue| TicketCard {
			identifier: issue.identifier.clone(),
			title: issue.title.clone(),
			description: short_description(&issue.description),
			url: issue.url.clone(),
			state_name: issue.state_name.clone(),
			phase: state_phase(&config.workflow, &issue.state_name).to_string(),
			progress: state_progress(&config.workflow, &issue.state_name),
			age_days: business_days_between(&issue.updated_at, now),
			updated_at: issue.updated_at.clone(),
			pr_numbers: prs_by_issue
				.get(issue.identifier.as_str())
				.map(|prs| prs.iter().map(|pr| pr.number).collect())
				.unwrap_or_default(),
			priority: issue.priority,
			priority_label: priority_label(issue.priority).to_string(),
		};

		// Le plus récemment touché d'abord.
		//
		// L'ordre inverse — le plus vieux en tête — a longtemps prévalu : au daily,
		// disait-on, c'est ce qui traîne qu'on veut voir. Mais quand quelqu'un
		// raconte ce qu'il fait, l'écran montrait alors ce qu'il n'a pas touché
		// depuis trois semaines, et ne suivait jamais son récit. Ce qui traîne a
		// déjà son signal, les alertes le disent ; cette liste-ci répond à « sur
		// quoi es-tu en ce moment ».
		let by_age = |a: &TicketCard, b: &TicketCard| a.age_days.cmp(&b.age_days);
		let mut active_tickets: Vec<TicketCard> = active.iter().chain(blocked.iter()).map(to_card).collect();
		active_tickets.sort_by(by_age);
		let mut review_tickets: Vec<TicketCard> = review.iter().map(to_card).collect();
		review_tickets.sort_by(by_age);

		let mut next: Vec<&LinearIssue> = own
			.iter()
			.copied()
			.filter(|i| state_phase(&config.workflow, &i.state_name) == "upcoming")
			.collect();
		next.sort_by(|a, b| {
			let rank = |p: i64| if p == 0 { 99 } else { p };
			rank(a.priority)
				.cmp(&rank(b.priority))
				.then(b.updated_at.cmp(&a.updated_at))
		});

		let authored: Vec<PullRequest> = if member.github.is_empty() {
			Vec::new()
		} else {
			open_prs
				.iter()
				.filter(|pr| is_member_login(member, &pr.author))
				.cloned()
				.collect()
		};

		let mut member_prs: Vec<MemberPr> = authored
			.iter()
			.map(|pr| MemberPr {
				number: pr.number,
				url: pr.url.clone(),
				title: pr.title.clone(),
				head_ref: pr.head_ref.clone(),
				base_ref: pr.base_ref.clone(),
				ci_state: pr.ci_state.clone(),
				review_decision: pr.review_decision.clone(),
				is_draft: pr.is_draft,
				stacked: !is_base_branch(&config.workflow, &pr.base_ref),
				age_days: business_days_between(&pr.created_at, now),
				// Deux âges, deux questions : depuis quand elle est ouverte — ce qui
				// dit si elle traîne — et depuis quand plus personne n'y touche, ce
				// qui dit si c'est le sujet du moment.
				idle_days: business_days_between(&pr.updated_at, now),
				updated_at: pr.updated_at.clone(),
				ticket_id: pr.linear_ids.first().cloned(),
				labels: pr.labels.clone(),
			})
			.collect();
		member_prs.sort_by(|a, b| {
			pr_action_rank(a)
				.cmp(&pr_action_rank(b))
				.then(b.age_days.cmp(&a.age_days))
		});

		let prs_to_review = authored
			.iter()
			.filter(|pr| !pr.is_draft && pr.review_decision != "APPROVED")
			.count();
		let oldest_review_days = authored
			.iter()
			.filter(|pr| !pr.is_draft && pr.review_decision != "APPROVED")
			.map(|pr| business_days_between(&pr.created_at, now))
			.max()
			.unwrap_or(0);

		// La seule vraie file d'attente « on attend quelque chose de toi » : les
		// PR des autres où la personne est reviewer demandé.
		let mut review_inbox: Vec<ReviewInboxItem> = if member.github.is_empty() {
			Vec::new()
		} else {
			open_prs
				.iter()
				.filter(|pr| {
					!pr.is_draft
						&& !is_member_login(member, &pr.author)
						&& pr
							.review_request_logins
							.iter()
							.any(|login| is_member_login(member, login))
				})
				.map(|pr| ReviewInboxItem {
					number: pr.number,
					url: pr.url.clone(),
					title: pr.title.clone(),
					author: member_name_of(&members, &pr.author).unwrap_or(&pr.author).to_string(),
					age_days: business_days_between(&pr.created_at, now),
					labels: pr.labels.clone(),
				})
				.collect()
		};
		review_inbox.sort_by_key(|a| std::cmp::Reverse(a.age_days));

		let mut delta = Vec::new();
		if !member.github.is_empty() {
			for pr in &merged_prs {
				if is_member_login(member, &pr.author) {
					delta.push(DeltaItem {
						kind: "merged".into(),
						label: format!("#{} {}", pr.number, pr.title),
						url: pr.url.clone(),
						ticket_id: pr.linear_ids.first().cloned(),
						labels: pr.labels.clone(),
					});
				}
			}
			for pr in &open_prs {
				let opened_after = DateTime::parse_from_rfc3339(&pr.created_at)
					.map(|date| date.with_timezone(&Utc).date_naive() >= since_daily)
					.unwrap_or(false);
				if is_member_login(member, &pr.author) && opened_after {
					delta.push(DeltaItem {
						kind: "opened".into(),
						label: format!("#{} {}", pr.number, pr.title),
						url: pr.url.clone(),
						ticket_id: pr.linear_ids.first().cloned(),
						labels: pr.labels.clone(),
					});
				}
			}
		}

		let mut linked_issue_ids = HashSet::new();
		let mut foreign_author_prs = Vec::new();
		for issue in active.iter().chain(review.iter()) {
			if let Some(prs) = prs_by_issue.get(issue.identifier.as_str()) {
				if !prs.is_empty() {
					linked_issue_ids.insert(issue.identifier.clone());
				}
				for pr in prs {
					if !member.github.is_empty() && !pr.author.is_empty() && !is_member_login(member, &pr.author) {
						foreign_author_prs.push(((*pr).clone(), issue.identifier.clone()));
					}
				}
			}
		}

		contexts.push(MemberContext {
			name: member.name.clone(),
			is_dev: member.role == "dev",
			active: active.clone(),
			review: review.clone(),
			blocked: blocked.clone(),
			linked_issue_ids,
			authored_prs: authored.clone(),
			foreign_author_prs,
		});

		boards.push(MemberBoard {
			name: member.name.clone(),
			role: member.role.clone(),
			role_label: member.role_label.clone(),
			github: Some(member.github.clone()).filter(|g| !g.is_empty()),
			narrative: Narrative {
				text: String::new(),
				current: Vec::new(),
				shipped: Vec::new(),
			},
			metrics: MemberMetrics {
				active_wip: active.len(),
				in_review: review.len(),
				open_prs: member_prs.len(),
				prs_to_review,
				oldest_review_days,
				merged_since_daily: delta.iter().filter(|d| d.kind == "merged").count(),
				review_pending: review_inbox.len(),
				upcoming,
				cycle_done,
				cycle_total,
				cycle_progress: if cycle_total > 0 {
					((cycle_done as f64 / cycle_total as f64) * 100.0).round() as u32
				} else {
					0
				},
			},
			active_tickets,
			review_tickets,
			next: next
				.into_iter()
				.take(2)
				.map(|i| NextTicket {
					identifier: i.identifier.clone(),
					title: i.title.clone(),
					url: i.url.clone(),
					priority_label: priority_label(i.priority).to_string(),
				})
				.collect(),
			prs: member_prs,
			review_inbox,
			delta,
		});
	}

	let flags = compute_flags(&config.workflow, &contexts, now);

	// La narration a besoin des flags : elle se calcule donc après eux.
	for (board, ctx) in boards.iter_mut().zip(contexts.iter()) {
		let own_flags: Vec<&Flag> = flags.iter().filter(|f| f.member == board.name).collect();
		// Ce sur quoi la personne est *maintenant* : ses tickets actifs et ses
		// PR ouvertes. Les tickets en review ou à l'arrêt décrivent ce qui est
		// derrière — les compter faisait parler de sujets qu'on a quittés.
		let active_ids: std::collections::HashSet<&str> =
			ctx.active.iter().map(|issue| issue.identifier.as_str()).collect();
		let active_titles: Vec<String> = ctx
			.active
			.iter()
			.map(|i| i.title.clone())
			// Une PR ouverte occupe autant qu'un ticket, mais ne doit pas compter
			// deux fois le même sujet quand elle porte déjà son identifiant.
			.chain(
				board
					.prs
					.iter()
					.filter(|pr| !pr.is_draft)
					.filter(|pr| pr.ticket_id.as_deref().is_none_or(|id| !active_ids.contains(id)))
					.map(|pr| pr.title.clone()),
			)
			.collect();
		// Les merges de `dev` dans une branche ne disent rien du sujet livré.
		let shipped_titles: Vec<String> = board
			.delta
			.iter()
			.filter(|d| d.kind == "merged")
			.map(|d| d.label.clone())
			.filter(|label| {
				let normalized = normalize(label);
				!["merge dev", "merge branch", "merge main", "merge stage", "revert"]
					.iter()
					.any(|noise| normalized.contains(noise))
			})
			.collect();

		board.narrative = build_narrative(
			&config.workflow.themes,
			NarrativeInput {
				name: &board.name,
				is_dev: board.role == "dev",
				active_count: ctx.active.len(),
				review_count: ctx.review.len(),
				open_pr_count: board.prs.len(),
				shipped_count: shipped_titles.len(),
				opened_count: board.delta.iter().filter(|d| d.kind == "opened").count(),
				review_pending: board.review_inbox.len(),
				red_flags: own_flags.iter().filter(|f| f.severity == "red").count(),
				orange_flags: own_flags.iter().filter(|f| f.severity == "orange").count(),
			},
			count_themes(&config.workflow.themes, &active_titles),
			count_themes(&config.workflow.themes, &shipped_titles),
		);
	}

	let pr_flow = build_pr_flow(&config.workflow, &members, &open_prs);
	let totals = BoardTotals {
		active_wip: boards.iter().map(|b| b.metrics.active_wip).sum(),
		in_review: boards.iter().map(|b| b.metrics.in_review).sum(),
		open_prs: boards.iter().map(|b| b.metrics.open_prs).sum(),
		merged_since_daily: boards.iter().map(|b| b.metrics.merged_since_daily).sum(),
		blocked: contexts.iter().map(|c| c.blocked.len()).sum(),
		ready_to_merge: pr_flow.ready_to_merge.len(),
		ci_failing: pr_flow.ci_failing.len(),
		red_flags: flags.iter().filter(|f| f.severity == "red").count(),
		orange_flags: flags.iter().filter(|f| f.severity == "orange").count(),
	};

	Ok(TeamBoard {
		generated_at: now.to_rfc3339(),
		cycle,
		since_daily: since_daily.to_string(),
		cycle_only,
		repo: config.github.repo.clone(),
		flags,
		members: boards,
		pr_flow,
		totals,
		github_error,
	})
}

#[cfg(test)]
mod narrative_tests {
	use super::*;

	fn titles(list: &[&str]) -> Vec<String> {
		list.iter().map(|s| s.to_string()).collect()
	}

	/// Un catalogue de test qui se lit sans rien connaître d'un projet réel.
	///
	/// Les thèmes vivant désormais dans la configuration, les tests déclarent le
	/// leur : ils décrivent un comportement — le mot-clé le plus précis gagne —
	/// et non le vocabulaire d'une équipe donnée.
	fn seeded() -> Vec<crate::config::ThemeConfig> {
		let theme = |label: &str, phrase: &str, keywords: &[&str]| crate::config::ThemeConfig {
			label: label.into(),
			phrase: phrase.into(),
			keywords: keywords.iter().map(|word| word.to_string()).collect(),
		};
		vec![
			theme(
				"Fidélité",
				"la fidélité",
				&["loyalty", "points", "reward", "recompense"],
			),
			theme(
				"Facturation",
				"la facturation",
				&["stripe", "billing", "facturation", "paiement", "abonnement"],
			),
			theme(
				"Panier & commandes",
				"le panier",
				&["panier", "cart", "commande", "checkout"],
			),
			theme(
				"Livraison",
				"la livraison",
				&["livraison", "shipping", "colis", "transporteur"],
			),
			theme(
				"Retrait en magasin",
				"le retrait en magasin",
				&["retrait en magasin", "click and collect", "magasin"],
			),
			theme(
				"UI front",
				"l'interface front",
				&["affichage", "responsive", "composant"],
			),
		]
	}

	/// Un titre qui touche plusieurs vocabulaires ne doit alimenter qu'un thème,
	/// sinon le sujet « dominant » reflète le choix des mots, pas le travail.
	#[test]
	fn un_titre_ne_compte_que_pour_un_theme() {
		let themes = count_themes(&seeded(), &titles(&["Corriger l'affichage du panier"]));
		let total: usize = themes.iter().map(|t| t.count).sum();
		assert_eq!(total, 1, "un seul titre ne peut peser que pour un");
	}

	/// Un vocabulaire partagé entre deux sujets ne doit pas les confondre :
	/// « points » et « reward » appartiennent à la fidélité, pas à la facturation.
	#[test]
	fn un_vocabulaire_partage_ne_confond_pas_les_sujets() {
		let themes = count_themes(
			&seeded(),
			&titles(&[
				"Plafond de points de fidélité par client",
				"Reward offert en points de fidélité",
			]),
		);
		assert_eq!(themes[0].label, "Fidélité");
		assert_eq!(themes[0].count, 2);
	}

	/// Le mot-clé le plus spécifique l'emporte sur le plus générique.
	#[test]
	fn le_theme_le_plus_precis_gagne() {
		let themes = count_themes(
			&seeded(),
			&titles(&["Retrait en magasin : livraison du colis par transporteur"]),
		);
		assert_eq!(themes[0].label, "Retrait en magasin");
	}

	/// Sans majorité franche, on énumère au lieu d'affirmer un focus.
	#[test]
	fn pas_de_focus_sans_majorite() {
		let current = vec![
			ThemeCount {
				label: "Facturation Stripe".into(),
				count: 2,
			},
			ThemeCount {
				label: "UI front".into(),
				count: 1,
			},
			ThemeCount {
				label: "Tests & QA".into(),
				count: 1,
			},
			ThemeCount {
				label: "CI & infra".into(),
				count: 1,
			},
		];
		let narrative = build_narrative(
			&seeded(),
			NarrativeInput {
				name: "Alice",
				is_dev: true,
				active_count: 5,
				review_count: 0,
				open_pr_count: 2,
				shipped_count: 0,
				opened_count: 0,
				review_pending: 0,
				red_flags: 0,
				orange_flags: 0,
			},
			current,
			Vec::new(),
		);
		assert!(
			narrative.text.contains("is working on"),
			"2 sur 5 ne fait pas un focus : {}",
			narrative.text
		);
		assert!(!narrative.text.contains("is mostly on"));
	}

	/// Avec une vraie majorité, l'affirmation est légitime.
	#[test]
	fn focus_quand_le_sujet_domine() {
		let current = vec![
			ThemeCount {
				label: "Facturation".into(),
				count: 4,
			},
			ThemeCount {
				label: "UI front".into(),
				count: 1,
			},
		];
		let narrative = build_narrative(
			&seeded(),
			NarrativeInput {
				name: "Alice",
				is_dev: true,
				active_count: 5,
				review_count: 0,
				open_pr_count: 0,
				shipped_count: 0,
				opened_count: 0,
				review_pending: 0,
				red_flags: 0,
				orange_flags: 0,
			},
			current,
			Vec::new(),
		);
		assert!(
			narrative.text.contains("is mostly on la facturation"),
			"{}",
			narrative.text
		);
	}
}

#[cfg(test)]
mod workflow_tests {
	use super::*;
	use crate::config::WorkflowConfig;

	/// Une équipe qui n'a rien configuré doit voir son tableau fonctionner :
	/// les colonnes les plus répandues sont reconnues d'office.
	#[test]
	fn installation_vierge_reste_utilisable() {
		let workflow = WorkflowConfig::default();
		assert_eq!(state_phase(&workflow, "In Progress"), "active");
		assert_eq!(state_phase(&workflow, "In Review"), "review");
		assert_eq!(state_phase(&workflow, "Done"), "done");
		assert_eq!(state_phase(&workflow, "Colonne inventée"), "upcoming");
		assert!(is_base_branch(&workflow, "main"));
		assert!(!is_base_branch(&workflow, "feat/x"));
	}

	/// Une équipe qui nomme ses colonnes autrement est servie sans toucher au code.
	#[test]
	fn colonnes_sur_mesure() {
		let workflow = WorkflowConfig {
			active_states: vec!["Doing".into()],
			review_states: vec!["Relecture".into()],
			done_states: vec!["Livré".into()],
			base_branches: vec!["trunk".into()],
			..WorkflowConfig::default()
		};
		assert_eq!(state_phase(&workflow, "Doing"), "active");
		assert_eq!(state_phase(&workflow, "In Progress"), "upcoming");
		assert!(is_base_branch(&workflow, "trunk"));
		assert!(!is_base_branch(&workflow, "main"));

		// L'avancement se déduit de la place dans le flux, sans paliers gravés.
		assert!(state_progress(&workflow, "Doing") < state_progress(&workflow, "Relecture"));
		assert_eq!(state_progress(&workflow, "Livré"), 100);
	}
}

#[cfg(test)]
mod tests_ticket_ids {
	use super::extract_ticket_ids;

	#[test]
	fn suit_la_cle_declaree() {
		let ids = extract_ticket_ids(&["topic-1-foo-3001", "feat: sujet FOO-42"], "foo");
		assert_eq!(ids, vec!["FOO-3001", "FOO-42"]);
	}

	#[test]
	fn ignore_une_autre_equipe() {
		// La clé codée en dur d'hier faisait passer ceci pour un ticket partout.
		assert!(extract_ticket_ids(&["topic-1-nw-3001"], "foo").is_empty());
	}

	#[test]
	fn refuse_une_cle_collee_a_un_autre_mot() {
		assert!(extract_ticket_ids(&["sousfoo-12"], "foo").is_empty());
	}

	#[test]
	fn sans_cle_reconnait_la_forme_commune() {
		let ids = extract_ticket_ids(&["topic-1-abc-3001"], "");
		assert!(ids.contains(&"ABC-3001".to_string()));
	}

	#[test]
	fn sans_cle_ignore_ce_qui_n_a_pas_de_chiffres() {
		assert!(extract_ticket_ids(&["feat/socle-refonte"], "").is_empty());
	}
}
