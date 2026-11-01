//! Ce qui bouge, tous dépôts confondus.
//!
//! Le cockpit savait déjà lister les pull requests d'un dépôt — celui du projet
//! affiché. Ça suffit pour travailler sur un produit ; ça ne dit rien de ce qui
//! se passe *sur l'ensemble*. Une équipe qui pilote trois dépôts n'a nulle part
//! où voir les trois, et un travail parti sur une branche sans pull request
//! n'apparaît chez personne : il n'existe pour la forge qu'au moment où
//! quelqu'un pense à l'ouvrir.
//!
//! Ce module ramène les trois à une même forme, le [`Change`] :
//!
//! - les pull requests GitHub, en une requête GraphQL par dépôt — c'est le seul
//!   moyen d'avoir la taille du diff, l'état du CI et la décision de revue sans
//!   un appel par élément ;
//! - les merge requests GitLab, en REST ;
//! - les branches locales en avance sur leur base et qu'aucune des deux ne
//!   couvre.
//!
//! Aucune source n'a le droit de faire tomber les autres : ce qui échoue se
//! range dans [`Scan::notes`] et se dit à l'écran, dépôt par dépôt.

use crate::config::{Config, ProjectConfig};
use crate::error::Result;
use crate::integrations::Tag;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Nombre de branches locales dont on calcule le diff.
///
/// Le calcul est local et rapide, mais un dépôt qui traîne deux cents branches
/// mortes paierait deux cents `git diff` pour n'en montrer que les plus
/// fraîches. On garde les plus récemment touchées.
const MAX_LOCAL_BRANCHES: usize = 25;

/// Un changement en vol, quelle que soit sa provenance.
///
/// Les champs sont ceux dont l'écran a besoin pour trier et décider — pas la
/// réponse de l'API, qui reste dans son coin. Ce qu'une forge ne sait pas dire
/// vaut `None` plutôt que zéro : « aucune ligne changée » et « cette forge ne
/// compte pas les lignes » ne se ressemblent qu'à l'écrit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
	/// Clé stable, et seul lien avec l'analyse : `github:acme/monorepo#412`,
	/// `gitlab:groupe/produit!17`, `local:<projet>@<branche>`.
	pub key: String,
	/// Projet déclaré d'où vient ce changement.
	pub project: String,
	pub project_name: String,
	pub project_color: String,
	/// `github` · `gitlab` · `local`.
	pub forge: String,
	/// Dépôt tel qu'on le nomme : `acme/monorepo`, `groupe/produit`, ou le
	/// dossier du dépôt local.
	pub repo: String,
	/// Ce qui le désigne à l'oral : `#412`, `!17`, ou le nom de la branche.
	pub reference: String,
	pub title: String,
	pub author: String,
	pub branch: String,
	pub base: String,
	pub url: String,
	pub draft: bool,
	/// Tête de la branche : c'est elle qui scelle une analyse.
	pub head_sha: String,
	pub additions: Option<usize>,
	pub deletions: Option<usize>,
	pub changed_files: Option<usize>,
	/// `success` · `failing` · `pending` · `none`.
	pub ci: String,
	/// `approved` · `changes_requested` · `review_required` · vide.
	pub review: String,
	/// Identifiants GitHub à qui la revue a été demandée — vide sur GitLab et
	/// en local, faute d'équivalent. C'est par là qu'une règle de la
	/// Permanence peut juger « la revue m'est attribuée » : sans cette liste,
	/// la condition n'a rien à vérifier, quel que soit ce que dit la forge.
	pub review_requested: Vec<String>,
	pub updated_at: String,
	/// Worktree où la branche est sortie, quand elle l'est.
	pub worktree: String,
	/// Dépôt local d'où l'analyse peut lire le code alentour. Vide quand le
	/// dépôt n'est pas cloné sur ce poste : l'analyse se fera sur le seul
	/// dossier.
	pub repo_path: String,
	pub labels: Vec<Tag>,
	/// Ce que la dernière lecture a conclu, si elle existe.
	pub analysis: Option<crate::impact::Summary>,
}

/// Ce qu'un écran peut réparer lui-même, quand la cause est une valeur mal
/// écrite et que le cockpit connaît la bonne.
///
/// Une note qui explique quoi taper vaut mieux qu'une note qui récite la règle ;
/// une note qui le fait vaut mieux encore, tant que le geste reste explicite.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFix {
	/// Ce que le bouton annonce, à la première personne du cockpit.
	pub label: String,
	/// Projet auquel appliquer le correctif.
	pub project: String,
	/// Patch de configuration, de la même forme que celui des réglages.
	pub patch: Value,
}

/// Une source qui n'a pas répondu, et pourquoi.
///
/// Un écran qui affiche douze changements au lieu de quinze sans le dire ment
/// plus qu'un écran vide : on le croit complet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanNote {
	pub source: String,
	pub message: String,
	/// La correction, quand le cockpit sait laquelle appliquer.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub fix: Option<ScanFix>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
	pub changes: Vec<Change>,
	pub notes: Vec<ScanNote>,
}

/// Recense ce qui bouge sur les projets déclarés.
///
/// `project` restreint à un projet précis ; vide = tous. Le filtre vit ici et
/// non dans l'interface : parcourir cinq dépôts pour en afficher un serait
/// payer cinq fois pour rien.
pub async fn scan(project: Option<&str>) -> Result<Scan> {
	let base = Config::load();
	let cloisonne = base.projects.len() > 1;

	let wanted: Vec<ProjectConfig> = base
		.projects
		.iter()
		.filter(|candidate| match project {
			Some(id) if !id.trim().is_empty() => candidate.id == id,
			_ => true,
		})
		.cloned()
		.collect();

	let scanned = futures::future::join_all(wanted.into_iter().map(|project| {
		let mut resolved = base.clone();
		project.merge_into(&mut resolved, cloisonne);
		async move { scan_project(&project, &resolved).await }
	}))
	.await;

	let mut out = Scan::default();
	for (changes, notes) in scanned {
		out.changes.extend(changes);
		out.notes.extend(notes);
	}

	// Le plus récemment touché en premier : c'est l'ordre dans lequel on se
	// demande « où ça en est ».
	out.changes
		.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
	Ok(out)
}

async fn scan_project(project: &ProjectConfig, config: &Config) -> (Vec<Change>, Vec<ScanNote>) {
	// `display_name` et non une règle réécrite ici : un projet sans nom se
	// désigne par le dossier de son dépôt — « produit » —, pas par son
	// identifiant interne — « principal » —, qui ne veut rien dire pour qui lit
	// une carte.
	let label = project.display_name();

	let (github, gitlab) = futures::future::join(
		github_changes(project, &label, config),
		gitlab_changes(project, &label, config),
	)
	.await;

	let mut changes = Vec::new();
	let mut notes = Vec::new();

	for (source, outcome) in [("GitHub", github), ("GitLab", gitlab)] {
		match outcome {
			Ok(found) => changes.extend(found),
			Err(erreur) => {
				if let Some(erreur) = erreur {
					notes.push(ScanNote {
						source: format!("{label} · {source}"),
						message: erreur.message,
						fix: erreur.fix,
					});
				}
			}
		}
	}

	// Les branches locales arrivent après : elles ont besoin de savoir lesquelles
	// portent déjà une pull request pour ne pas les compter deux fois.
	let covered: Vec<String> = changes.iter().map(|change| change.branch.clone()).collect();
	match local_changes(project, &label, config, &covered).await {
		Ok(found) => changes.extend(found),
		Err(erreur) => {
			if let Some(erreur) = erreur {
				notes.push(ScanNote {
					source: crate::i18n::tf("monitor.localRepoSource", &[("label", &label)]),
					message: erreur.message,
					fix: erreur.fix,
				});
			}
		}
	}

	(changes, notes)
}

/// Ce qu'une source a à dire quand elle échoue : le motif, et parfois de quoi
/// le réparer.
#[derive(Debug, Clone)]
pub struct SourceError {
	pub message: String,
	pub fix: Option<ScanFix>,
}

impl From<String> for SourceError {
	fn from(message: String) -> Self {
		Self { message, fix: None }
	}
}

/// `Err(None)` : cette source n'est pas configurée ici, il n'y a rien à dire.
/// `Err(Some)` : elle l'est et elle a échoué — ça, il faut le dire.
type SourceResult = std::result::Result<Vec<Change>, Option<SourceError>>;

// ── GitHub ──────────────────────────────────────────────────────────────────

/// Les pull requests ouvertes d'un dépôt, en une seule requête.
///
/// GraphQL et non REST : la liste REST ne porte ni le nombre de lignes changées,
/// ni l'état du CI, ni la décision de revue — il aurait fallu un appel par pull
/// request pour remplir une carte, soit quinze appels pour quinze cartes, à
/// chaque ouverture de l'écran.
async fn github_changes(project: &ProjectConfig, label: &str, config: &Config) -> SourceResult {
	let repo = config.github.repo.trim().to_string();
	if repo.is_empty() {
		return Err(None);
	}
	let Some((owner, name)) = repo.split_once('/') else {
		// Dire la règle ne suffit pas : ce qu'on veut savoir, c'est quoi taper.
		// Le dépôt local porte la réponse dans son remote — on la propose.
		let devine = crate::git::github_slug(Path::new(&local_repo(config))).await;
		let (suite, fix) = match &devine {
			Some(slug) => (
				format!(" {}", crate::i18n::tf("monitor.repoHere", &[("slug", &slug)])),
				Some(ScanFix {
					label: crate::i18n::tf("monitor.repoWrite", &[("slug", &slug)]),
					project: project.id.clone(),
					patch: json!({ "github": { "repo": slug } }),
				}),
			),
			None => (format!(" {}", crate::i18n::t("monitor.repoFixInSettings")), None),
		};
		return Err(Some(SourceError {
			message: format!(
				"{}{suite}",
				crate::i18n::tf("monitor.repoMissingOwner", &[("repo", &repo)])
			),
			fix,
		}));
	};

	let token = crate::integrations::github_token(config)
		.await
		.map_err(|error| Some(error.to_string().into()))?;

	let body = crate::team::github_graphql(
		&token,
		"query Changes($owner: String!, $name: String!) {
			repository(owner: $owner, name: $name) {
				pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
					nodes {
						number title url headRefName baseRefName headRefOid isDraft
						reviewDecision updatedAt additions deletions changedFiles
						author { login }
						labels(first: 10) { nodes { name color } }
						commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
						reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
					}
				}
			}
		}",
		json!({ "owner": owner, "name": name }),
	)
	.await
	.map_err(|error| Some(error.to_string().into()))?;

	let nodes = body
		.pointer("/data/repository/pullRequests/nodes")
		.and_then(|value| value.as_array())
		.cloned()
		.unwrap_or_default();

	let repo_path = local_repo(config);
	let worktrees = worktrees_of(&repo_path).await;

	Ok(nodes
		.iter()
		.map(|node| {
			let branch = string(node, "/headRefName");
			let number = node.pointer("/number").and_then(|v| v.as_i64()).unwrap_or(0);
			let key = format!("github:{repo}#{number}");
			Change {
				analysis: crate::impact::summary(&key),
				key,
				project: project.id.clone(),
				project_name: label.to_string(),
				project_color: project.color.clone(),
				forge: "github".into(),
				repo: repo.clone(),
				reference: format!("#{number}"),
				title: string(node, "/title"),
				author: string(node, "/author/login"),
				base: string(node, "/baseRefName"),
				url: string(node, "/url"),
				draft: node
					.pointer("/isDraft")
					.and_then(|v| v.as_bool())
					.unwrap_or(false),
				head_sha: string(node, "/headRefOid"),
				additions: usize_at(node, "/additions"),
				deletions: usize_at(node, "/deletions"),
				changed_files: usize_at(node, "/changedFiles"),
				ci: github_ci(node),
				review: match string(node, "/reviewDecision").as_str() {
					"APPROVED" => "approved".into(),
					"CHANGES_REQUESTED" => "changes_requested".into(),
					"REVIEW_REQUIRED" => "review_required".into(),
					_ => String::new(),
				},
				updated_at: string(node, "/updatedAt"),
				worktree: worktrees
					.iter()
					.find(|(name, _)| name == &branch)
					.map(|(_, path)| path.clone())
					.unwrap_or_default(),
				repo_path: repo_path.clone(),
				labels: github_labels(node),
				review_requested: github_review_requested(node),
				branch,
			}
		})
		.collect())
}

fn github_ci(node: &Value) -> String {
	match node
		.pointer("/commits/nodes/0/commit/statusCheckRollup/state")
		.and_then(|value| value.as_str())
	{
		Some("SUCCESS") => "success",
		Some("FAILURE") | Some("ERROR") => "failing",
		Some("PENDING") | Some("EXPECTED") => "pending",
		_ => "none",
	}
	.into()
}

fn github_labels(node: &Value) -> Vec<Tag> {
	node.pointer("/labels/nodes")
		.and_then(|value| value.as_array())
		.map(|nodes| {
			nodes
				.iter()
				.map(|label| Tag {
					label: string(label, "/name"),
					color: string(label, "/color"),
					tone: "neutral".into(),
				})
				.filter(|tag| !tag.label.is_empty())
				.collect()
		})
		.unwrap_or_default()
}

fn github_review_requested(node: &Value) -> Vec<String> {
	node.pointer("/reviewRequests/nodes")
		.and_then(|value| value.as_array())
		.map(|nodes| {
			nodes
				.iter()
				.filter_map(|entry| entry.pointer("/requestedReviewer/login").and_then(|v| v.as_str()))
				.map(String::from)
				.collect()
		})
		.unwrap_or_default()
}

// ── GitLab ──────────────────────────────────────────────────────────────────

/// Les merge requests ouvertes d'un projet GitLab.
///
/// La liste ne porte pas le compte des lignes — GitLab ne le calcule qu'en
/// servant le diff entier, ce qu'on ne va pas demander pour dessiner une carte.
/// Le nombre de fichiers suffit à l'écran ; les lignes seront comptées au moment
/// de constituer le dossier d'analyse, où l'on lit le diff de toute façon.
async fn gitlab_changes(project: &ProjectConfig, label: &str, config: &Config) -> SourceResult {
	let path = config.gitlab.project.trim().to_string();
	if path.is_empty() || config.gitlab.token.trim().is_empty() {
		return Err(None);
	}

	let value = crate::integrations::gitlab_merge_requests(config)
		.await
		.map_err(|error| Some(error.to_string().into()))?;

	let repo_path = local_repo(config);
	let worktrees = worktrees_of(&repo_path).await;

	Ok(value
		.iter()
		.map(|mr| {
			let branch = string(mr, "/source_branch");
			let iid = mr.pointer("/iid").and_then(|v| v.as_i64()).unwrap_or(0);
			let key = format!("gitlab:{path}!{iid}");
			Change {
				analysis: crate::impact::summary(&key),
				key,
				project: project.id.clone(),
				project_name: label.to_string(),
				project_color: project.color.clone(),
				forge: "gitlab".into(),
				repo: path.clone(),
				reference: format!("!{iid}"),
				title: string(mr, "/title"),
				author: string(mr, "/author/name"),
				base: string(mr, "/target_branch"),
				url: string(mr, "/web_url"),
				// `draft` est le champ moderne ; `work_in_progress` traîne encore
				// sur les instances qu'on n'a pas mises à jour.
				draft: mr
					.pointer("/draft")
					.or_else(|| mr.pointer("/work_in_progress"))
					.and_then(|v| v.as_bool())
					.unwrap_or(false),
				head_sha: string(mr, "/sha"),
				additions: None,
				deletions: None,
				// `changes_count` est une chaîne, et vaut « 12+ » au-delà d'un
				// seuil : on garde ce qui se lit comme un nombre.
				changed_files: mr
					.pointer("/changes_count")
					.and_then(|v| v.as_str())
					.and_then(|raw| raw.trim_end_matches('+').parse().ok()),
				ci: match string(mr, "/head_pipeline/status").as_str() {
					"success" => "success".into(),
					"failed" | "canceled" => "failing".into(),
					"running" | "pending" | "created" | "waiting_for_resource" => "pending".into(),
					_ => "none".into(),
				},
				review: if mr
					.pointer("/reviewers")
					.and_then(|v| v.as_array())
					.is_some_and(|list| !list.is_empty())
				{
					"review_required".into()
				} else {
					String::new()
				},
				updated_at: string(mr, "/updated_at"),
				worktree: worktrees
					.iter()
					.find(|(name, _)| name == &branch)
					.map(|(_, path)| path.clone())
					.unwrap_or_default(),
				repo_path: repo_path.clone(),
				labels: gitlab_labels(mr),
				review_requested: gitlab_reviewers(mr),
				branch,
			}
		})
		.collect())
}

fn gitlab_reviewers(mr: &Value) -> Vec<String> {
	mr.pointer("/reviewers")
		.and_then(|value| value.as_array())
		.map(|nodes| {
			nodes
				.iter()
				.filter_map(|entry| entry.pointer("/username").and_then(|v| v.as_str()))
				.map(String::from)
				.collect()
		})
		.unwrap_or_default()
}

fn gitlab_labels(mr: &Value) -> Vec<Tag> {
	if let Some(details) = mr.get("label_details").and_then(|value| value.as_array()) {
		return details
			.iter()
			.map(|entry| Tag {
				label: string(entry, "/name"),
				color: string(entry, "/color").trim_start_matches('#').to_string(),
				tone: "neutral".into(),
			})
			.filter(|tag| !tag.label.is_empty())
			.collect();
	}
	mr.get("labels")
		.and_then(|value| value.as_array())
		.map(|list| {
			list.iter()
				.filter_map(|label| label.as_str())
				.map(|name| Tag {
					label: name.to_string(),
					color: String::new(),
					tone: "neutral".into(),
				})
				.collect()
		})
		.unwrap_or_default()
}

// ── Branches locales ────────────────────────────────────────────────────────

/// Le travail parti sans pull request.
///
/// C'est le cas que ni GitHub ni GitLab ne peuvent voir : une branche poussée ou
/// non, en avance sur sa base, dont personne n'a encore ouvert la demande de
/// fusion. Elle contient pourtant du code, et souvent depuis plusieurs jours —
/// c'est précisément le changement qu'on aimerait comprendre avant qu'il ne
/// grossisse.
async fn local_changes(
	project: &ProjectConfig,
	label: &str,
	config: &Config,
	covered: &[String],
) -> SourceResult {
	if !config.impact.local_branches() {
		return Err(None);
	}
	let repo_path = local_repo(config);
	if repo_path.is_empty() {
		return Err(None);
	}
	let repo = PathBuf::from(&repo_path);
	if !repo.join(".git").exists() {
		return Err(None);
	}

	let base = crate::git::freshest(&repo, &crate::git::default_branch(&repo).await).await;
	let branches = crate::git::list_branches(&repo, &base, false)
		.await
		.map_err(|error| Some(error.to_string().into()))?;

	let candidates: Vec<crate::git::Branch> = branches
		.into_iter()
		.filter(|branch| {
			branch.commits_ahead > 0
				&& !branch.is_default
				&& branch.name != base
				&& !covered.contains(&branch.name)
		})
		.take(MAX_LOCAL_BRANCHES)
		.collect();

	let measured = futures::future::join_all(candidates.into_iter().map(|branch| {
		let repo = repo.clone();
		let base = base.clone();
		async move {
			let diff = crate::git::branch_diff(&repo, &branch.name, &base).await.ok();
			(branch, diff)
		}
	}))
	.await;

	Ok(measured
		.into_iter()
		.filter_map(|(branch, diff)| {
			// Une branche en avance dont le diff est vide n'a rien à montrer :
			// ses commits ne touchent aucun fichier, ou la comparaison a échoué.
			let diff = diff.filter(|diff| !diff.files.is_empty())?;
			let key = format!("local:{}@{}", project.id, branch.name);
			Some(Change {
				analysis: crate::impact::summary(&key),
				key,
				project: project.id.clone(),
				project_name: label.to_string(),
				project_color: project.color.clone(),
				forge: "local".into(),
				repo: repo
					.file_name()
					.map(|name| name.to_string_lossy().to_string())
					.unwrap_or_else(|| repo_path.clone()),
				reference: branch.name.clone(),
				title: branch
					.last_commit
					.as_ref()
					.map(|commit| commit.subject.clone())
					.unwrap_or_else(|| branch.name.clone()),
				author: branch
					.last_commit
					.as_ref()
					.map(|commit| commit.author.clone())
					.unwrap_or_default(),
				base: base.clone(),
				url: String::new(),
				draft: false,
				head_sha: branch
					.last_commit
					.as_ref()
					.map(|commit| commit.sha.clone())
					.unwrap_or_default(),
				additions: Some(diff.additions),
				deletions: Some(diff.deletions),
				changed_files: Some(diff.files.len()),
				ci: "none".into(),
				review: String::new(),
				updated_at: branch
					.last_commit
					.as_ref()
					.map(|commit| iso_of(commit.timestamp))
					.unwrap_or_default(),
				worktree: branch.worktree_path.clone().unwrap_or_default(),
				repo_path: repo_path.clone(),
				labels: Vec::new(),
				review_requested: Vec::new(),
				branch: branch.name,
			})
		})
		.collect())
}

// ── Outils communs ──────────────────────────────────────────────────────────

fn local_repo(config: &Config) -> String {
	let repo = config.general.main_repo.trim().trim_end_matches('/');
	// Sous Windows, le réglage peut finir par `\`.
	if cfg!(windows) {
		repo.trim_end_matches(['/', '\\']).to_string()
	} else {
		repo.to_string()
	}
}

/// Branches sorties en worktree, pour savoir où l'analyse pourra lire le code.
async fn worktrees_of(repo_path: &str) -> Vec<(String, String)> {
	if repo_path.is_empty() {
		return Vec::new();
	}
	let repo = Path::new(repo_path);
	if !repo.join(".git").exists() {
		return Vec::new();
	}
	crate::git::list_worktrees(repo)
		.await
		.unwrap_or_default()
		.into_iter()
		.filter_map(|tree| tree.branch.map(|branch| (branch, tree.path)))
		.collect()
}

fn string(value: &Value, pointer: &str) -> String {
	value
		.pointer(pointer)
		.and_then(|found| found.as_str())
		.unwrap_or_default()
		.to_string()
}

fn usize_at(value: &Value, pointer: &str) -> Option<usize> {
	value
		.pointer(pointer)
		.and_then(|found| found.as_u64())
		.map(|found| found as usize)
}

fn iso_of(timestamp: i64) -> String {
	chrono::DateTime::from_timestamp(timestamp, 0)
		.map(|moment| moment.to_rfc3339())
		.unwrap_or_default()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn gitlab_compte_les_fichiers_meme_tronque() {
		// GitLab répond « 12+ » au-delà d'un seuil : un `parse` naïf rendait
		// alors « inconnu » pour les plus grosses merge requests, celles qu'on
		// voulait justement repérer.
		let mr = json!({ "changes_count": "12+" });
		let count = mr
			.pointer("/changes_count")
			.and_then(|v| v.as_str())
			.and_then(|raw| raw.trim_end_matches('+').parse::<usize>().ok());
		assert_eq!(count, Some(12));
	}

	#[test]
	fn ci_inconnu_ne_ment_pas() {
		// Un dépôt sans intégration continue ne doit pas passer pour vert.
		assert_eq!(github_ci(&json!({})), "none");
		assert_eq!(
			github_ci(&json!({
				"commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE" } } }] }
			})),
			"failing"
		);
	}
}
