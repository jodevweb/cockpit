//! Les pull requests ouvertes d'un dépôt GitHub, et les tickets qu'elles citent.
//!
//! Une seule requête GraphQL rend, pour chaque PR, l'état de sa CI, la décision
//! de revue et les relecteurs attendus : la carte, le tableau des branches et
//! la Permanence lisent tous cette même liste.

use crate::error::{CockpitError, Result};
use serde::Serialize;
use serde_json::{json, Value};

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
			.unwrap_or_else(|| crate::i18n::t("pulls.errors.unknown"));
		return Err(CockpitError::msg(crate::i18n::tf(
			"pulls.errors.github",
			&[("message", &message)],
		)));
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
