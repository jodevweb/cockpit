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
//!   estimation, des cycles.
//! - **GitHub Issues** n'a que `open` et `closed`, ni priorité ni estimation.
//! - **Jira** a des états configurables et une priorité, mais nommée autrement.
//!
//! D'où les capacités déclarées : plutôt que d'inventer une priorité là où il
//! n'y en a pas, chaque fournisseur dit ce qu'il sait faire, et l'interface
//! n'affiche que ce qui existe. Un champ vide ment moins qu'un champ inventé,
//! mais un champ absent ne ment pas du tout.
//!
//! Le daily en fait partie désormais, et la question qu'il posait — « qu'est-ce
//! qu'un cycle chez un fournisseur qui n'en a pas ? » — se répond par une
//! capacité de plus : il n'en a pas, on ne rapporte donc rien à un sprint, et le
//! tableau raconte ce qui est ouvert et assigné. Reste une convention : là où le
//! titulaire d'un ticket n'est pas un UUID mais un login, c'est celui déclaré
//! pour GitHub qui sert — un compte nommé autrement s'ajoute à ses alias.

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
    /// Des itérations — cycles, sprints — auxquelles rapporter l'avancement.
    ///
    /// Sans elles, le daily raconte ce qui est en cours sans le comparer à un
    /// engagement de sprint, et n'a pas d'identifiant d'équipe à réclamer.
    pub cycles: bool,
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

/// Une itération du suivi : un cycle Linear, un jalon ailleurs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerCycle {
    /// Identifiant interne, transmis tel quel au fournisseur pour filtrer.
    pub id: String,
    pub number: i64,
    pub starts_at: String,
    pub ends_at: String,
}

/// Un ticket tel que le daily le manipule.
///
/// Distinct de `TicketDetail`, qui sert la fiche d'un ticket qu'on ouvre : ici on
/// en lit cent d'un coup pour les répartir entre les membres, et le détail —
/// commentaires, libellés, options — coûterait autant d'appels que de tickets.
#[derive(Debug, Clone)]
pub struct TeamIssue {
    pub identifier: String,
    pub title: String,
    pub description: String,
    pub url: String,
    pub state_name: String,
    pub priority: i64,
    pub updated_at: String,
    /// Ce que le suivi rend comme titulaire : un UUID chez Linear, un login
    /// ailleurs. C'est au daily de le rapprocher d'un membre.
    pub assignee_id: String,
    pub in_current_cycle: bool,
}

/// De quoi reconnaître un membre dans un suivi, quel qu'il soit.
///
/// Chaque service a sa façon de nommer les gens : Linear par un UUID, GitLab et
/// GitHub par un login. Plutôt qu'un champ de configuration par service — autant
/// d'occasions d'en oublier un — on donne au fournisseur ce que l'équipe déclare,
/// et il retient ce qu'il sait utiliser.
#[derive(Debug, Clone)]
pub struct TeamRef {
    pub tracker_id: String,
    pub logins: Vec<String>,
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

    /// L'itération en cours, quand le suivi en a une.
    ///
    /// `None` n'est pas un échec : la plupart des suivis n'ont pas de cycle, et le
    /// daily raconte alors ce qui est en cours sans le rapporter à un sprint.
    async fn cycle(&self) -> Result<Option<TrackerCycle>> {
        Ok(None)
    }

    /// Les tickets de ces personnes : le cycle en cours, plus ce qui est démarré
    /// ou bloqué en dehors — un ticket bloqué depuis deux sprints doit rester
    /// visible.
    ///
    /// Sans implémentation, le daily n'a rien à montrer : c'est le fournisseur qui
    /// sait interroger son service, pas le tableau.
    async fn team_issues(&self, _members: &[TeamRef], _cycle_id: &str) -> Result<Vec<TeamIssue>> {
        Ok(Vec::new())
    }
}

/// Le fournisseur du projet actif.
///
/// Le choix se déduit de ce qui est configuré plutôt que de se déclarer : une
/// équipe qui a renseigné un jeton Linear veut Linear, et n'a pas à le redire
/// dans un second réglage qu'elle oubliera de changer.
pub fn provider(config: &Config) -> Result<Box<dyn Provider>> {
    if !config.linear.token.trim().is_empty() {
        return Ok(Box::new(Linear {
            config: config.clone(),
        }));
    }
    // GitLab avant les issues GitHub : une équipe qui a renseigné un jeton et un
    // projet GitLab y tient ses tickets, là où des issues peuvent n'être que la
    // vitrine publique d'un dépôt.
    if !config.gitlab.token.trim().is_empty() && !config.gitlab.project.trim().is_empty() {
        return Ok(Box::new(Gitlab {
            config: config.clone(),
        }));
    }
    if !config.github.repo.trim().is_empty() {
        return Ok(Box::new(GithubIssues {
            config: config.clone(),
        }));
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
            cycles: true,
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
        let options = crate::integrations::linear_options(&self.config, &crate::team::default_linear_team_id()).await?;
        Ok(Options {
            states: options.states,
            members: options.members,
            labels: options.labels,
        })
    }

    async fn update(&self, id: &str, patch: serde_json::Value) -> Result<()> {
        crate::integrations::linear_update_issue(&self.config, id, patch).await
    }

    async fn cycle(&self) -> Result<Option<TrackerCycle>> {
        let team = self.config.team.linear_team_id.trim();
        if team.is_empty() {
            return Err(CockpitError::msg(crate::i18n::t("tickets.linearTeamMissing")));
        }
        crate::team::fetch_current_cycle(&self.config.linear.token, team).await
    }

    /// Chez Linear, une personne est un UUID : ses logins n'y servent à rien, et
    /// un membre sans identifiant déclaré ne peut se voir attribuer aucun ticket.
    async fn team_issues(&self, members: &[TeamRef], cycle_id: &str) -> Result<Vec<TeamIssue>> {
        let ids: Vec<String> = members
            .iter()
            .map(|member| member.tracker_id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        crate::team::fetch_team_issues(
            &self.config.linear.token,
            cycle_id,
            &ids,
            &self.config.workflow.blocked_state,
        )
        .await
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
            cycles: false,
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

    /// Les issues ouvertes assignées à l'équipe, reconnues par leurs logins.
    async fn team_issues(&self, members: &[TeamRef], _cycle_id: &str) -> Result<Vec<TeamIssue>> {
        let logins: Vec<String> = members
            .iter()
            .flat_map(|member| member.logins.clone())
            .collect();
        if logins.is_empty() {
            return Ok(Vec::new());
        }
        crate::integrations::github_team_issues(&self.config, &logins).await
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
            cycles: false,
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

    /// Les tickets ouverts assignés à l'équipe.
    ///
    /// Pas de cycle chez GitLab — donc rien qui distingue « dans le sprint » de
    /// « en cours » : tout ce qui est ouvert et assigné compte comme actif. Les
    /// personnes se reconnaissent à leur login, celui déclaré pour GitHub et ses
    /// variantes ; un compte GitLab nommé autrement s'ajoute dans « autres
    /// logins » plutôt que dans un champ de plus à oublier de remplir.
    async fn team_issues(&self, members: &[TeamRef], _cycle_id: &str) -> Result<Vec<TeamIssue>> {
        let logins: Vec<String> = members
            .iter()
            .flat_map(|member| member.logins.clone())
            .collect();
        if logins.is_empty() {
            return Ok(Vec::new());
        }
        crate::integrations::gitlab_team_issues(&self.config, &logins).await
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

    /// Un ticket se rattache à son titulaire quelle que soit la forme que le
    /// suivi lui donne : un UUID chez Linear, un login ailleurs. Sans les deux
    /// voies, le daily d'une équipe sur GitLab restait vide sans rien dire.
    #[test]
    fn le_daily_reconnait_un_membre_par_son_identifiant_ou_son_login() {
        let mut config = Config::default();
        config.gitlab.token = "glpat-x".into();
        config.gitlab.project = "groupe/produit".into();
        // GitLab n'a pas de cycle : rien à rapporter à un sprint, et aucun
        // identifiant d'équipe à réclamer.
        assert!(!provider(&config).unwrap().capabilities().cycles);

        config.linear.token = "lin_api_x".into();
        assert!(provider(&config).unwrap().capabilities().cycles);
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
