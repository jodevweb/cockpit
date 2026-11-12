//! Le suivi de tâches, quel qu'il soit.
//!
//! Le cockpit est né sur Linear, et Linear s'est retrouvé partout : dans les
//! commandes, dans les types, jusque dans les noms d'écrans. Une équipe qui
//! travaille sur Jira ou sur les issues GitHub n'avait rien à en faire.
//!
//! Ce module pose ce que tous ont en commun — une tâche a un identifiant, un
//! titre, un état, un assigné, des étiquettes — et ce qu'ils n'ont pas :
//!
//! - **Linear** a des états riches (`In Review`), une priorité, une
//!   estimation.
//! - **GitHub Issues** n'a que `open` et `closed`, ni priorité ni estimation.
//! - **Jira** a des états configurables et une priorité, mais nommée autrement.
//!
//! D'où les capacités déclarées : plutôt que d'inventer une priorité là où il
//! n'y en a pas, chaque fournisseur dit ce qu'il sait faire, et l'interface
//! n'affiche que ce qui existe. Un champ vide ment moins qu'un champ inventé,
//! mais un champ absent ne ment pas du tout.

use crate::config::Config;
use crate::error::{CockpitError, Result};
use crate::integrations::{FeedItem, LinearComment, NamedRef};
use async_trait::async_trait;
use serde::Serialize;

/// Ce qu'un fournisseur sait faire, pour que l'interface ne propose pas ce qui
/// n'existe pas.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
	/// Une échelle de priorité propre au suivi (Linear, Jira).
	pub priority: bool,
	/// Des états au-delà de « ouvert » et « fermé ».
	pub rich_states: bool,
	/// Une estimation de charge.
	pub estimate: bool,
	/// Un nom de branche suggéré par le suivi.
	pub branch_name: bool,
}

/// Une tâche, telle que les écrans la manipulent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketDetail {
	pub id: String,
	/// Ce qu'on lit et qu'on cite : `PROJ-42`, ou `#317`.
	pub identifier: String,
	pub title: String,
	pub description: String,
	pub url: String,
	/// Échelle Linear : 0 = non définie, 1 = urgent … 4 = basse. Toujours 0
	/// chez un fournisseur qui n'en a pas.
	pub priority: i64,
	pub estimate: Option<f64>,
	pub branch_name: String,
	pub updated_at: String,
	pub state: Option<NamedRef>,
	pub assignee: Option<NamedRef>,
	pub labels: Vec<NamedRef>,
	pub comments: Vec<LinearComment>,
}

/// Les choix proposables sur une tâche.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Options {
	pub states: Vec<NamedRef>,
	pub members: Vec<NamedRef>,
	pub labels: Vec<NamedRef>,
}

/// Ce qu'un suivi de tâches doit savoir faire.
// `async_trait` met un `#[must_use]` sur ce qu'il génère, une `Future` qui en a déjà un.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait Provider: Send + Sync {
	/// Nom affiché — c'est lui qui titre l'onglet, à la place de « Linear ».
	fn label(&self) -> &'static str;

	fn capabilities(&self) -> Capabilities;

	/// Tâches en cours, éventuellement les siennes seulement.
	async fn list(&self, only_mine: bool) -> Result<Vec<FeedItem>>;

	async fn get(&self, identifier: &str) -> Result<TicketDetail>;

	async fn options(&self) -> Result<Options>;

	/// Applique un changement. Le patch porte les noms de champs du modèle
	/// commun ; à chaque fournisseur de les traduire.
	async fn update(&self, id: &str, patch: serde_json::Value) -> Result<()>;
}

/// Le fournisseur du projet actif.
///
/// Le choix se déduit de ce qui est configuré plutôt que de se déclarer : une
/// équipe qui a renseigné un jeton Linear veut Linear, et n'a pas à le redire
/// dans un second réglage qu'elle oubliera de changer.
pub fn provider(config: &Config) -> Result<Box<dyn Provider>> {
	if !config.linear.token.trim().is_empty() {
		return Ok(Box::new(Linear { config: config.clone() }));
	}
	// GitLab avant les issues GitHub : une équipe qui a renseigné un jeton et un
	// projet GitLab y tient ses tickets, là où des issues peuvent n'être que la
	// vitrine publique d'un dépôt.
	if !config.gitlab.token.trim().is_empty() && !config.gitlab.project.trim().is_empty() {
		return Ok(Box::new(Gitlab { config: config.clone() }));
	}
	if !config.github.repo.trim().is_empty() {
		return Ok(Box::new(GithubIssues { config: config.clone() }));
	}
	Err(CockpitError::msg(crate::i18n::t("tickets.noTracker")))
}

// ──────────────────────────────── Linear ────────────────────────────────

struct Linear {
	config: Config,
}

#[async_trait]
impl Provider for Linear {
	fn label(&self) -> &'static str {
		"Linear"
	}

	fn capabilities(&self) -> Capabilities {
		Capabilities {
			priority: true,
			rich_states: true,
			estimate: true,
			branch_name: true,
		}
	}

	async fn list(&self, only_mine: bool) -> Result<Vec<FeedItem>> {
		crate::integrations::linear_issues(&self.config, only_mine).await
	}

	async fn get(&self, identifier: &str) -> Result<TicketDetail> {
		let issue = crate::integrations::linear_issue_detail(&self.config, identifier).await?;
		Ok(TicketDetail {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			description: issue.description,
			url: issue.url,
			priority: issue.priority,
			estimate: issue.estimate,
			branch_name: issue.branch_name,
			updated_at: issue.updated_at,
			state: issue.state,
			assignee: issue.assignee,
			labels: issue.labels,
			comments: issue.comments,
		})
	}

	async fn options(&self) -> Result<Options> {
		let team = self.config.linear.team_id.trim();
		if team.is_empty() {
			return Err(CockpitError::msg(crate::i18n::t("tickets.linearTeamMissing")));
		}
		let options = crate::integrations::linear_options(&self.config, team).await?;
		Ok(Options {
			states: options.states,
			members: options.members,
			labels: options.labels,
		})
	}

	async fn update(&self, id: &str, patch: serde_json::Value) -> Result<()> {
		crate::integrations::linear_update_issue(&self.config, id, patch).await
	}
}

// ────────────────────────────── GitHub Issues ──────────────────────────────

struct GithubIssues {
	config: Config,
}

/// Numéro d'une issue, qu'on l'écrive `317` ou `#317`.
fn issue_number(identifier: &str) -> String {
	identifier.trim().trim_start_matches('#').to_string()
}

#[async_trait]
impl Provider for GithubIssues {
	fn label(&self) -> &'static str {
		"Issues"
	}

	/// Ni priorité, ni estimation, ni états intermédiaires : plutôt que de les
	/// simuler avec des étiquettes — convention que chaque équipe écrit
	/// différemment — on les déclare absents et l'interface les masque.
	fn capabilities(&self) -> Capabilities {
		Capabilities {
			priority: false,
			rich_states: false,
			estimate: false,
			branch_name: false,
		}
	}

	async fn list(&self, only_mine: bool) -> Result<Vec<FeedItem>> {
		crate::integrations::github_issues(&self.config, only_mine).await
	}

	async fn get(&self, identifier: &str) -> Result<TicketDetail> {
		crate::integrations::github_issue(&self.config, &issue_number(identifier)).await
	}

	async fn options(&self) -> Result<Options> {
		crate::integrations::github_issue_options(&self.config).await
	}

	async fn update(&self, id: &str, patch: serde_json::Value) -> Result<()> {
		crate::integrations::github_issue_update(&self.config, &issue_number(id), patch).await
	}
}

// ──────────────────────────────── GitLab ────────────────────────────────

struct Gitlab {
	config: Config,
}

#[async_trait]
impl Provider for Gitlab {
	fn label(&self) -> &'static str {
		"GitLab"
	}

	/// Ouvert ou fermé, et rien entre les deux : GitLab laisse chaque équipe se
	/// fabriquer ses colonnes avec des libellés, selon une convention qui lui est
	/// propre. Les deviner reviendrait à en imposer une.
	///
	/// Pas de priorité non plus, pour la même raison. Le `weight` existe bien,
	/// mais il n'est servi que par les éditions payantes : l'annoncer donnerait un
	/// champ vide à qui n'y a pas droit.
	fn capabilities(&self) -> Capabilities {
		Capabilities {
			priority: false,
			rich_states: false,
			estimate: false,
			branch_name: false,
		}
	}

	async fn list(&self, only_mine: bool) -> Result<Vec<FeedItem>> {
		crate::integrations::gitlab_issues(&self.config, only_mine).await
	}

	async fn get(&self, identifier: &str) -> Result<TicketDetail> {
		crate::integrations::gitlab_issue(&self.config, &issue_number(identifier)).await
	}

	async fn options(&self) -> Result<Options> {
		crate::integrations::gitlab_issue_options(&self.config).await
	}

	async fn update(&self, id: &str, patch: serde_json::Value) -> Result<()> {
		crate::integrations::gitlab_issue_update(&self.config, &issue_number(id), patch).await
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Le fournisseur se déduit de ce qui est configuré, sans réglage en double.
	#[test]
	fn le_fournisseur_suit_la_configuration() {
		let mut config = Config::default();
		assert!(provider(&config).is_err(), "rien de configuré, rien à proposer");

		config.github.repo = "acme/produit".into();
		assert_eq!(provider(&config).unwrap().label(), "Issues");

		// GitLab passe devant : un jeton et un projet déclarés désignent le suivi
		// où l'équipe travaille, pas la vitrine d'un dépôt.
		config.gitlab.token = "glpat-x".into();
		config.gitlab.project = "groupe/produit".into();
		assert_eq!(provider(&config).unwrap().label(), "GitLab");

		// Un jeton GitLab sans projet ne suffit pas : on ne saurait pas où
		// chercher, et l'écran s'ouvrirait vide.
		config.gitlab.project = String::new();
		assert_eq!(provider(&config).unwrap().label(), "Issues");
		config.gitlab.project = "groupe/produit".into();

		// Linear l'emporte : une équipe qui a les deux suit ses tickets dans le
		// premier, et ses issues n'en sont que le reflet public.
		config.linear.token = "lin_api_x".into();
		assert_eq!(provider(&config).unwrap().label(), "Linear");
	}

	/// Un numéro d'issue s'écrit avec ou sans dièse selon d'où on le copie.
	#[test]
	fn le_numero_se_lit_dans_les_deux_ecritures() {
		assert_eq!(issue_number("#317"), "317");
		assert_eq!(issue_number(" 317 "), "317");
	}

	/// Ce qui n'existe pas ne doit pas être annoncé comme disponible.
	#[test]
	fn les_capacites_disent_la_verite() {
		let github = GithubIssues {
			config: Config::default(),
		};
		assert!(!github.capabilities().priority);
		assert!(!github.capabilities().rich_states);

		let linear = Linear {
			config: Config::default(),
		};
		assert!(linear.capabilities().priority);
		assert!(linear.capabilities().rich_states);
	}
}
