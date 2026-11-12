//! Configuration du cockpit.
//!
//! Source unique : `~/.config/cockpit/config.toml`. Chaque secret peut
//! aussi être fourni par variable d'environnement (utile si tu veux garder les
//! clés dans 1Password / direnv plutôt que sur disque) ; la variable gagne
//! toujours sur le fichier.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Aucun emplacement par défaut : où quelqu'un range ses dépôts ne se devine
/// pas, et un chemin inventé mène à un dossier vide qu'on croit cassé. L'écran
/// de configuration le réclame, une fois.

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct GeneralConfig {
	/// Dossier qui contient le repo principal et tous les worktrees.
	#[serde(default)]
	pub projects_root: String,
	/// Repo principal (le monorepo de l'équipe).
	pub main_repo: String,
	/// Commande d'ouverture d'un dossier dans l'éditeur (`zed`, `cursor`, `code`).
	#[serde(default)]
	pub editor: String,
	/// Langue de l'interface et des agents (`en`, `fr`, `pt-BR`…). Vide = celle
	/// du système. Voir `i18n.rs`.
	#[serde(default)]
	pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct GithubConfig {
	/// `owner/repo`, ex. `acme/monorepo`.
	pub repo: String,
	/// Optionnel : si vide, le cockpit retombe sur `gh auth token`.
	pub token: String,
	/// Ton identifiant GitHub.
	///
	/// Sert à reconnaître ce qui vient de toi — « j'ai déjà commenté sur cette
	/// PR », « la PR est de moi ». Sans lui, ces conditions ne peuvent pas être
	/// vraies, et la Permanence n'écrit donc nulle part : c'est le bon repli.
	pub user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct LinearConfig {
	pub token: String,
	/// Clé d'équipe (ex. `NW`) pour filtrer le backlog.
	pub team_key: String,
	/// Identifiant (UUID) de l'équipe Linear : ses états, ses membres et ses
	/// labels proposés à l'édition d'un ticket.
	///
	/// Il vivait dans la section `[team]`, partie avec l'écran Équipe ; il est
	/// repris de là au chargement (voir `LegacyTeam`).
	pub team_id: String,
}

/// Un moteur d'agent : le programme qui fait tourner un agent, et ce qu'il sait.
///
/// Le cockpit ne parle pas à un modèle, il pilote un **agent** — quelque chose
/// qui lit des fichiers, en écrit, lance des commandes et demande l'autorisation
/// de le faire. Une clé d'API ne fait rien de tout cela : c'est le programme qui
/// l'exécute. Déclarer un moteur, c'est donc déclarer ce programme, pas un
/// fournisseur.
///
/// Ce qui rend la chose extensible sans recompiler : `command` désigne le
/// binaire, `env` porte ce qu'il faut lui mettre dans l'environnement — l'adresse
/// d'un service compatible, un jeton — et `models` les alias qu'il accepte. Une
/// passerelle qui expose un autre fournisseur derrière une API compatible se
/// déclare ainsi en trois champs, et ses modèles apparaissent dans les
/// sélecteurs comme les autres.
///
/// `protocol` dit comment on lui parle. Un seul est implémenté à ce jour —
/// celui de Claude Code, un flux JSON sur l'entrée et la sortie standard. Le
/// champ existe pour que le jour où l'on en câble un second, les moteurs déjà
/// déclarés n'aient pas à être devinés.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineConfig {
	/// Clé stable, référencée par les rôles et les agents lancés.
	pub id: String,
	pub label: String,
	/// Binaire à lancer. Vide = on cherche `claude` aux emplacements connus.
	pub command: String,
	/// Manière de dialoguer. Vide = `claude-stream-json`, le seul câblé.
	pub protocol: String,
	/// Alias de modèles proposés au lancement. Vide = ceux du poste.
	pub models: Vec<String>,
	/// Variables d'environnement passées au programme — adresse d'un service,
	/// jeton d'accès. C'est par là qu'un moteur pointe ailleurs que chez son
	/// éditeur d'origine.
	pub env: Vec<EngineEnv>,
	/// Arguments ajoutés à la ligne de commande, pour ce que le cockpit ne
	/// connaît pas.
	#[serde(alias = "extra_args")]
	pub extra_args: String,
	/// Comment ce moteur exprime une profondeur de réflexion.
	///
	/// Le cockpit ne connaît pas les drapeaux des moteurs et n'a pas à les
	/// deviner : il exprime une intention — vite, normalement, à fond — et
	/// chaque moteur dit ici ce qu'il faut ajouter à sa ligne de commande pour
	/// l'obtenir. Un champ vide veut dire « ce moteur ne sait pas faire », et le
	/// réglage se grise plutôt que de partir dans le vide.
	#[serde(default, alias = "depth_fast")]
	pub depth_fast: String,
	#[serde(default, alias = "depth_normal")]
	pub depth_normal: String,
	#[serde(default, alias = "depth_deep")]
	pub depth_deep: String,
}

impl EngineConfig {
	/// Les arguments de la profondeur demandée, ou rien quand ce moteur l'ignore.
	pub fn depth_args(&self, depth: &str) -> &str {
		match depth.trim() {
			"fast" => self.depth_fast.trim(),
			"deep" => self.depth_deep.trim(),
			"normal" => self.depth_normal.trim(),
			_ => "",
		}
	}

	/// Vrai quand au moins un niveau est déclaré : sans ça, le réglage n'a
	/// aucun effet et l'interface ne doit pas le proposer.
	pub fn knows_depth(&self) -> bool {
		!self.depth_fast.trim().is_empty() || !self.depth_normal.trim().is_empty() || !self.depth_deep.trim().is_empty()
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineEnv {
	pub name: String,
	pub value: String,
}

/// Le protocole de dialogue par défaut : un process qui reste ouvert d'un
/// tour à l'autre, `stdin` jamais refermé entre deux messages.
pub const DEFAULT_PROTOCOL: &str = "claude-stream-json";

/// `codex exec` (OpenAI Codex CLI) : à l'opposé, un process relancé à chaque
/// tour (`codex exec resume <fil>` pour les suivants), qui se termine de
/// lui-même une fois la réponse rendue. Voir `codex.rs`. Peut tenir une mission,
/// sauf dans un conteneur : voir `Protocol::runs_missions`.
pub const PROTOCOL_CODEX_EXEC: &str = "codex-exec";

/// `gemini --output-format stream-json` (Google Gemini CLI) : répond une
/// fois et se termine. Aucune source, contrairement à `codex-exec`, ne
/// documente de mécanisme de reprise pour ce mode : un agent Gemini ne
/// reçoit donc qu'un seul message, `agent::send` le refuse plutôt que
/// d'inventer une commande de reprise. Le schéma des événements vient d'une
/// pull request qui a livré la fonctionnalité, pas d'une documentation
/// stabilisée — deux pages officielles se contredisaient sur l'existence
/// même de ce format au moment où ceci a été écrit. Voir `gemini.rs`.
pub const PROTOCOL_GEMINI_STREAM: &str = "gemini-stream-json";

impl EngineConfig {
	/// Le protocole effectif : vide veut dire celui de Claude Code.
	pub fn protocol_or_default(&self) -> &str {
		if self.protocol.trim().is_empty() {
			DEFAULT_PROTOCOL
		} else {
			self.protocol.trim()
		}
	}
}

/// Le moteur retenu tant qu'aucun n'est déclaré.
///
/// Nommé plutôt que sous-entendu : sans lui, un cockpit neuf n'aurait aucun
/// moteur à proposer, et les sélecteurs s'ouvriraient vides sur une installation
/// qui marche très bien.
pub fn default_engines() -> Vec<EngineConfig> {
	vec![EngineConfig {
		id: "claude".into(),
		label: "Claude Code".into(),
		command: String::new(),
		protocol: DEFAULT_PROTOCOL.into(),
		// Les alias que ce moteur résout lui-même — `claude --help` les nomme.
		// Du plus capable au plus rapide : l'ordre du menu est celui-ci.
		models: vec!["fable".into(), "opus".into(), "sonnet".into(), "haiku".into()],
		env: Vec::new(),
		extra_args: String::new(),
		// Laissés vides : le cockpit ne suppose pas les drapeaux d'un moteur, y
		// compris celui qu'il installe par défaut. Chacun les déclare dans les
		// réglages, et le jour où ils changent, c'est une ligne de configuration
		// et non une version du cockpit.
		depth_fast: String::new(),
		depth_normal: String::new(),
		depth_deep: String::new(),
	}]
}

/// Le moteur portant cet identifiant, ou celui par défaut.
///
/// Jamais d'échec : un rôle qui référence un moteur supprimé doit continuer de
/// lancer ses agents. Mieux vaut le moteur d'origine qu'une mission bloquée par
/// une ligne de configuration effacée.
pub fn engine_for(config: &Config, id: &str) -> EngineConfig {
	let declared = if config.engines.is_empty() {
		default_engines()
	} else {
		config.engines.clone()
	};
	let id = id.trim();
	declared
		.iter()
		.find(|engine| !id.is_empty() && engine.id == id)
		.or_else(|| declared.first())
		.cloned()
		.unwrap_or_else(|| default_engines().remove(0))
}

/// Un compte sous lequel les agents travaillent.
///
/// Distinct du moteur, qui est le programme : deux projets peuvent faire tourner
/// le même binaire sous deux identités — un compte d'entreprise pour le produit
/// de l'employeur, un compte personnel pour ce qu'on écrit le soir. Le moteur ne
/// change pas, l'identité si.
///
/// Tout tient dans `dir` : Claude Code lit son dossier de configuration dans
/// `CLAUDE_CONFIG_DIR`, et y range aussi bien ses jetons que ses transcriptions.
/// Pointer deux dossiers, c'est donc séparer deux comptes de bout en bout, sans
/// que le cockpit n'ait jamais à toucher à un jeton.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AccountConfig {
	pub id: String,
	pub label: String,
	/// Dossier de configuration du compte. Vide = celui du poste.
	pub dir: String,
}

/// L'identifiant du compte que Claude Code utilise quand on ne lui dit rien.
///
/// Nommé plutôt que laissé vide : un sélecteur doit pouvoir proposer « le compte
/// du poste » comme une entrée parmi les autres, et un projet doit pouvoir y
/// revenir explicitement après avoir été rattaché ailleurs.
pub const HOME_ACCOUNT: &str = "poste";

/// Dossier de configuration de Claude Code quand aucun compte n'est déclaré.
pub fn home_account_dir() -> PathBuf {
	dirs::home_dir().unwrap_or_default().join(".claude")
}

/// Les comptes déclarés, celui du poste en tête.
///
/// Le poste figure toujours dans la liste, même quand personne n'a rien
/// déclaré : c'est sous lui que tourne une installation qui n'a jamais entendu
/// parler de comptes multiples, et il n'a pas à disparaître du jour où un second
/// est ajouté.
pub fn accounts(config: &Config) -> Vec<AccountConfig> {
	let mut list = vec![AccountConfig {
		id: HOME_ACCOUNT.into(),
		label: crate::i18n::t("config.homeAccount"),
		dir: String::new(),
	}];
	for account in &config.accounts {
		let id = account.id.trim();
		if id.is_empty() || id == HOME_ACCOUNT {
			continue;
		}
		list.push(AccountConfig {
			id: id.to_string(),
			label: if account.label.trim().is_empty() {
				id.to_string()
			} else {
				account.label.trim().to_string()
			},
			dir: account.dir.trim().to_string(),
		});
	}
	list
}

/// Le compte sous lequel cette configuration travaille.
///
/// Jamais d'échec, pour la même raison que `engine_for` : un projet qui désigne
/// un compte supprimé doit continuer de lancer ses agents, quitte à le faire
/// sous celui du poste. Un compte manquant se répare dans les réglages, pas au
/// milieu d'une mission.
pub fn account_for(config: &Config) -> AccountConfig {
	let declared = accounts(config);
	let wanted = config.account.trim();
	declared
		.iter()
		.find(|account| !wanted.is_empty() && account.id == wanted)
		.cloned()
		.unwrap_or_else(|| declared[0].clone())
}

/// Dossier de configuration du compte, tel que Claude Code l'attend.
pub fn account_dir(account: &AccountConfig) -> PathBuf {
	let dir = account.dir.trim();
	if dir.is_empty() {
		return home_account_dir();
	}
	PathBuf::from(resolve_path(dir, ""))
}

/// Ce qu'il faut poser dans l'environnement pour travailler sous ce compte.
///
/// Vide pour le compte du poste : ne rien poser laisse Claude Code chercher là
/// où il a toujours cherché, ce qui vaut mieux que de lui répéter son propre
/// défaut — le jour où il change d'emplacement, le cockpit n'a rien à savoir.
pub fn account_env(config: &Config) -> Vec<(String, String)> {
	let account = account_for(config);
	if account.dir.trim().is_empty() {
		return Vec::new();
	}
	vec![(
		"CLAUDE_CONFIG_DIR".to_string(),
		account_dir(&account).to_string_lossy().to_string(),
	)]
}

/// Tous les dossiers de configuration en usage sur ce poste, sans doublon.
///
/// Ce qui se lit — les conversations, les jetons consommés — ne concerne pas un
/// projet mais le poste entier : l'écran des sessions montre ce qui tourne
/// partout, et il n'a pas à devenir aveugle aux projets rattachés à un autre
/// compte.
pub fn account_dirs(config: &Config) -> Vec<PathBuf> {
	let mut dirs = Vec::new();
	for account in accounts(config) {
		let dir = account_dir(&account);
		if !dirs.contains(&dir) {
			dirs.push(dir);
		}
	}
	dirs
}

/// GitLab, qu'il soit hébergé chez eux ou sur une instance à soi.
///
/// L'hôte est un réglage à part entière : une équipe sur GitLab auto-hébergé
/// n'a rien à faire sur `gitlab.com`, et supposer le service public aurait rendu
/// le connecteur inutilisable pour la moitié de ceux qui l'utilisent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GitlabConfig {
	/// Jeton personnel, portée `api` — la lecture seule ne suffit pas pour
	/// changer l'état d'un ticket.
	pub token: String,
	/// Chemin du projet avec son groupe : `groupe/sous-groupe/projet`.
	///
	/// Le chemin plutôt que l'identifiant numérique : c'est ce qu'on lit dans
	/// l'URL, et un numéro recopié ne se vérifie pas d'un coup d'œil. L'API
	/// l'accepte encodé.
	pub project: String,
	/// Racine de l'instance, sans barre finale.
	pub host: String,
}

impl Default for GitlabConfig {
	fn default() -> Self {
		Self {
			token: String::new(),
			project: String::new(),
			host: "https://gitlab.com".into(),
		}
	}
}

/// Une secret key Trigger.dev vaut pour un seul environnement : suivre
/// Production et Staging demande donc autant de clés que d'environnements.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TriggerEnvironment {
	pub name: String,
	pub token: String,
	/// Projet auquel la clé appartient ; vide = `trigger.project_ref`.
	pub project_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TriggerConfig {
	/// Environnement par défaut, conservé pour les configurations à une seule clé.
	pub token: String,
	pub project_ref: String,
	#[serde(default)]
	pub api_url: String,
	pub environments: Vec<TriggerEnvironment>,
}

/// Nom d'environnement déduit d'une secret key `tr_<environnement>_<suite>`.
///
/// Trigger.dev nomme le préfixe d'après l'environnement, y compris pour ceux
/// qu'on crée soi-même (`tr_staging_…`) : on lit donc le segment plutôt que de
/// tenir une liste fermée qui vieillirait mal.
fn environment_name_of(token: &str) -> String {
	let segment = token
		.strip_prefix("tr_")
		.and_then(|rest| rest.split('_').next())
		.filter(|segment| !segment.is_empty());

	match segment {
		Some("prod") => "Production".into(),
		Some("dev") => "Development".into(),
		Some(name) => {
			// `staging` → `Staging`.
			let mut chars = name.chars();
			match chars.next() {
				Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
				None => crate::i18n::t("config.defaultEnvironment"),
			}
		}
		None => crate::i18n::t("config.defaultEnvironment"),
	}
}

impl TriggerConfig {
	/// Environnements interrogeables, clé par défaut incluse.
	pub fn resolved(&self) -> Vec<TriggerEnvironment> {
		let mut all: Vec<TriggerEnvironment> = Vec::new();
		if !self.token.trim().is_empty() {
			all.push(TriggerEnvironment {
				name: environment_name_of(&self.token),
				token: self.token.clone(),
				project_ref: self.project_ref.clone(),
			});
		}
		all.extend(
			self.environments
				.iter()
				.filter(|env| !env.token.trim().is_empty() && !env.name.trim().is_empty())
				.map(|env| TriggerEnvironment {
					name: env.name.clone(),
					token: env.token.clone(),
					project_ref: if env.project_ref.trim().is_empty() {
						self.project_ref.clone()
					} else {
						env.project_ref.clone()
					},
				}),
		);
		all
	}

	/// Les mêmes environnements, expurgés de leurs jetons, pour l'interface.
	pub fn views(&self) -> Vec<TriggerEnvironmentView> {
		let default_count = usize::from(!self.token.trim().is_empty());
		self.resolved()
			.into_iter()
			.enumerate()
			.map(|(index, env)| TriggerEnvironmentView {
				name: env.name,
				project_ref: env.project_ref,
				from_default_key: index < default_count,
			})
			.collect()
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RailwayConfig {
	pub token: String,
	pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BetterstackConfig {
	/// Jeton d'API Better Stack, que le cockpit pose pour le serveur MCP de
	/// Better Stack dans le conteneur d'un agent isolé (voir
	/// `sandbox::provision_mcp_tokens`).
	///
	/// L'écran Observabilité qui le lisait aussi est parti ; le jeton reste, parce
	/// que sans lui un agent isolé perd cet outil. Les anciens champs
	/// (`telemetry_token`, `clickhouse_*`) sont ignorés à la lecture.
	pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct StripeConfig {
	pub token: String,
}

/// L'ancienne section `[team]`, telle que les fichiers déjà écrits la portent.
///
/// L'écran Équipe et le daily sont partis, et avec eux les membres. Seul
/// l'identifiant d'équipe Linear servait encore — aux options d'édition d'un
/// ticket — : on le relit ici pour le reporter sous `[linear]`, et la section
/// disparaît du fichier à la sauvegarde suivante. Le reste (`members`…) est
/// ignoré, sans faire échouer la lecture.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct LegacyTeam {
	#[serde(alias = "linearTeamId")]
	linear_team_id: String,
}

impl LegacyTeam {
	/// Reporte l'identifiant sous `[linear]` quand celui-ci n'en déclare pas.
	fn adopt_into(&mut self, linear: &mut LinearConfig) {
		let legacy = std::mem::take(&mut self.linear_team_id);
		if linear.team_id.trim().is_empty() && !legacy.trim().is_empty() {
			linear.team_id = legacy.trim().to_string();
		}
	}
}

/// Ce qui décrit la façon de travailler d'une équipe, plutôt que ses outils.
///
/// Ces valeurs étaient gravées dans le code : des états de suivi précis, des
/// branches, des commandes de worktree. Le cockpit ne servait donc qu'à une
/// seule équipe. Elles descendent ici, avec des valeurs par défaut
/// génériques — une équipe qui nomme ses colonnes autrement n'a qu'à le dire.
// L'interface lit du camelCase, comme pour les rôles : ces champs sortaient en
// snake_case, si bien que l'écran des réglages les trouvait vides et
// réenregistrait des colonnes effacées. Les fichiers déjà écrits en snake_case
// restent lus grâce aux alias.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowConfig {
	/// Branches sur lesquelles une PR se merge normalement ; toute autre base
	/// signale une PR empilée.
	#[serde(alias = "base_branches")]
	pub base_branches: Vec<String>,
	/// États du suivi de tâches qui valent « terminé » : la carte et l'écran
	/// Aujourd'hui rangent ces tickets dans ce qui est livré.
	#[serde(alias = "done_states")]
	pub done_states: Vec<String>,
	/// Commande d'équipe qui ouvre une pull request — `/pull-request-creation`,
	/// typiquement.
	///
	/// Une équipe range dans une commande du dépôt tout ce que le cockpit ne peut
	/// pas deviner : le bon gabarit, ses labels, l'envoi des captures de recette.
	/// Renseignée, le maître la joue lui-même et rend l'adresse obtenue ; le
	/// cockpit se contente de clore la mission. Vide, il ouvre la pull request
	/// par la forge, comme avant — un projet sans commande maison n'a rien à
	/// apprendre d'une commande qui n'existe pas chez lui.
	///
	/// Mêmes substitutions que les commandes de rôle : `{ticket}`, `{ticketUrl}`,
	/// `{branch}`, `{mission}`.
	#[serde(default, alias = "pr_command")]
	pub pr_command: String,

	/// Comment cette équipe sort une branche en worktree.
	///
	/// Le cockpit jouait `pnpm worktree:create` d'un côté et `/create-worktree`
	/// de l'autre : deux commandes d'une seule équipe, écrites dans le binaire,
	/// que personne d'autre ne pouvait ni changer ni même voir. Un worktree se
	/// crée pourtant différemment partout — il y a souvent des dépendances à
	/// installer, une base à cloner, un espace à réserver.
	///
	/// Vide, le cockpit s'en tient à `git worktree add`, qui marche dans
	/// n'importe quel dépôt. Une commande commençant par `/` est une commande du
	/// dépôt : elle est jouée par un agent, comme `pr_command`. Toute autre est
	/// une ligne de shell, lancée comme un script.
	///
	/// Substitutions : `{branch}`, `{path}`, `{folder}`.
	#[serde(default, alias = "worktree_command")]
	pub worktree_command: String,

	/// Comment cette équipe démonte un worktree.
	///
	/// Vide : `git worktree remove --force`. Mêmes substitutions et mêmes règles
	/// que ci-dessus — une commande maison démonte souvent bien plus que le
	/// dossier, et c'est justement ce que le cockpit ne peut pas deviner.
	#[serde(default, alias = "worktree_remove_command")]
	pub worktree_remove_command: String,

	/// Ce qui lance le serveur de développement d'un worktree.
	///
	/// Vide : le geste n'est pas proposé, plutôt que de lancer un `pnpm dev` qui
	/// n'existe peut-être pas ici.
	#[serde(default, alias = "dev_command")]
	pub dev_command: String,

	/// Ce qui signale une commande de test, en plus de ce que le cockpit
	/// reconnaît d'office (`vitest`, `pytest`, `php artisan test`…).
	///
	/// La carte d'un agent range ses commandes en deux : les tests, qui disent
	/// si ça passe, et le reste. Une équipe dont les tests se lancent par
	/// `pnpm check:unit` ou un script maison les voyait noyés dans « commandes »,
	/// et la carte ne disait jamais « les tests passent ». Un mot ou un bout de
	/// commande par entrée, cherché tel quel.
	#[serde(default, alias = "test_commands")]
	pub test_commands: Vec<String>,

	/// Ce qui doit passer avant qu'une tâche de mission soit intégrée.
	///
	/// Une ligne de shell par entrée (`pnpm test`, `pnpm lint`…), jouée dans le
	/// worktree de la tâche dès que son exécutant rend la main avec des
	/// commits. La relecture du maître et le verdict de recette sont des
	/// jugements ; ceci est un fait, et un fait ne se laisse pas convaincre.
	/// Une tâche dont une porte échoue n'est pas fusionnée : le maître reçoit
	/// la sortie et la renvoie en correction (voir `gates.rs`).
	///
	/// Vide par défaut : aucune commande n'est devinée.
	#[serde(default, alias = "gate_commands")]
	pub gate_commands: Vec<String>,

	/// Les agents rendent compte en images quand elles valent mieux que du
	/// texte : une capture avant/après, un schéma (voir `prompts::visual`).
	///
	/// Vrai par défaut. La consigne elle-même se lit et se réécrit dans la
	/// bibliothèque de prompts, sous l'identifiant `rendu` ; cette case ne dit
	/// que si elle part ou non avec chaque agent.
	#[serde(default = "visual_reports_default", alias = "visual_reports")]
	pub visual_reports: bool,

	/// Chaque workspace a son navigateur : l'agent le pilote, et on le regarde
	/// faire depuis l'onglet « Navigateur » (voir `browser.rs`).
	///
	/// Vrai par défaut. Décoché, les agents ne reçoivent plus l'outil ;
	/// l'onglet reste, pour naviguer soi-même.
	#[serde(default = "visual_reports_default", alias = "agent_browser")]
	pub agent_browser: bool,
	/// Le navigateur à lancer — n'importe lequel qui parle le protocole de
	/// débogage de Chrome. Vide : le premier trouvé parmi Chrome, Chromium,
	/// Edge et Brave.
	#[serde(default, alias = "browser_command")]
	pub browser_command: String,
	/// Le serveur MCP qui donne à l'agent ses gestes de navigateur. Il reçoit
	/// `--cdp-endpoint <adresse>` à la suite. Vide : celui de Playwright, à la
	/// version que le cockpit a éprouvée.
	#[serde(default, alias = "browser_server")]
	pub browser_server: String,

	/// L'agent qui relit une PR travaille en lecture seule : ni édition, ni
	/// commande qui ne soit pas une lecture (voir `review.rs`).
	///
	/// Vrai par défaut — on relit, on ne corrige pas. Décoché, l'agent de revue
	/// a les mêmes droits qu'un autre : de quoi lancer les tests ou écrire un
	/// test qui prouve un point, si l'équipe le veut un jour.
	#[serde(default = "review_read_only_default", alias = "review_read_only")]
	pub review_read_only: bool,

	/// Le dossier de livraison part sur la pull request d'une mission quand
	/// elle s'ouvre : une section de la description et un statut de commit
	/// `cockpit/dossier` (voir `delivery.rs`). Vrai par défaut — c'est ce que le
	/// relecteur ne voyait pas. Décoché, le dossier reste dans l'écran de la
	/// mission. Les vidéos ne partent jamais.
	#[serde(default = "visual_reports_default", alias = "delivery_dossier")]
	pub delivery_dossier: bool,
}

fn review_read_only_default() -> bool {
	true
}

fn visual_reports_default() -> bool {
	true
}

impl WorkflowConfig {
	/// La commande à jouer, et si elle passe par un agent.
	///
	/// Rendre le repli ici plutôt que dans chaque écran : trois appelants qui
	/// décident chacun quoi faire d'un réglage vide, ce sont trois occasions de
	/// diverger — c'est exactement ce qui avait produit deux commandes de
	/// création différentes.
	pub fn worktree_creation(&self, branch: &str, path: &str) -> (String, bool) {
		Self::resolve(&self.worktree_command, &generic_creation(branch, path), branch, path)
	}

	pub fn worktree_removal(&self, branch: &str, path: &str) -> (String, bool) {
		Self::resolve(
			&self.worktree_remove_command,
			&format!("git worktree remove --force {}", shell_arg(path)),
			branch,
			path,
		)
	}

	/// `(commande, par_agent)` — vide rend le repli générique.
	fn resolve(declared: &str, fallback: &str, branch: &str, path: &str) -> (String, bool) {
		let declared = declared.trim();
		if declared.is_empty() {
			return (fallback.to_string(), false);
		}
		let folder = std::path::Path::new(path)
			.file_name()
			.map(|name| name.to_string_lossy().to_string())
			.unwrap_or_else(|| branch.replace('/', "-"));
		let by_agent = declared.starts_with('/');
		// Joué par un shell, le gabarit reçoit ses valeurs telles quelles : une
		// branche est un nom choisi par n'importe qui (un collègue, un agent de
		// la Permanence, un dépôt distant) et git y accepte `;`, `$`, `|` ou
		// `` ` ``. `x;curl …|sh` devenait une commande de plus. Les quoter ici
		// ne suffirait pas — un gabarit qui les entoure déjà d'apostrophes les
		// rouvrirait — : on refuse donc de jouer une valeur qui en porte.
		if !by_agent {
			if let Some(hostile) = [branch, path, folder.as_str()]
				.into_iter()
				.find(|value| !inert_in_shell(value))
			{
				let message = crate::i18n::tf("config.worktreeHostileValue", &[("value", &hostile)]);
				return (format!("echo {} >&2; exit 1", shell_arg(&message)), false);
			}
		}
		let rendered = declared
			.replace("{branch}", branch)
			.replace("{path}", path)
			.replace("{folder}", &folder);
		(rendered, by_agent)
	}
}

/// Une valeur qu'un shell lit comme du texte, quel que soit l'endroit du
/// gabarit où elle tombe : ni métacaractère, ni guillemet, ni option.
fn inert_in_shell(value: &str) -> bool {
	!value.starts_with('-')
		&& !value
			.chars()
			.any(|c| c.is_control() || "`$;&|<>()'\"\\*?[]{}".contains(c))
}

/// Un argument de shell qui survit aux espaces et aux apostrophes.
/// La création d'un worktree quand l'équipe n'a rien déclaré.
///
/// Deux cas qu'un `git worktree add <chemin> <branche>` nu ratait, et ce sont
/// ceux d'un premier lancement :
///
/// - **pas de chemin** : « Ouvrir une branche » n'en donne pas, c'est au
///   cockpit de le choisir. Vide, git refusait ; et un gabarit qui laissait
///   `{path}` vide faisait prendre la branche pour le chemin — un dossier dans
///   le dépôt lui-même, sur une branche au nom tronqué. Le worktree va à côté
///   du dépôt : `../<dépôt>-<branche>`, comme on le range à la main ;
/// - **branche neuve** : sans `-b`, git ne la crée pas. On sort celle qui
///   existe (locale, ou sur `origin`, que git suit d'office) et on crée les
///   autres depuis la branche en cours.
fn generic_creation(branch: &str, path: &str) -> String {
	let target = if path.is_empty() {
		format!("../\"$(basename \"$PWD\")\"-{}", shell_arg(&branch.replace('/', "-")))
	} else {
		shell_arg(path)
	};
	let name = shell_arg(branch);
	format!(
		"if git show-ref --verify --quiet refs/heads/{name} || git show-ref --verify --quiet refs/remotes/origin/{name}; then git worktree add {target} {name}; else git worktree add -b {name} {target}; fi"
	)
}

fn shell_arg(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// Comment le cockpit lit les changements en vol.
///
/// Le `brief` est le seul réglage qui change vraiment la qualité de ce qui sort.
/// Un agent qui ne sait pas ce que fait le produit ne peut parler que du code :
/// il rend une revue technique, exactement ce qu'on ne voulait pas. Deux lignes
/// disant ce qu'est le produit et qui s'en sert suffisent à ce que l'analyse
/// parle de conséquences. C'est aussi ce qui rend cet écran vrai ailleurs que
/// chez celui qui l'a écrit : rien ici ne suppose un métier.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ImpactConfig {
	/// Ce que fait le produit, et pour qui. Transmis tel quel à l'analyse.
	pub brief: String,
	/// Moteur qui lit les changements. Vide = le premier déclaré.
	pub engine: String,
	/// Modèle du moteur. Vide = le réglage du poste.
	pub model: String,
	/// Profondeur de réflexion : `fast`, `normal`, `deep`. Vide = sans consigne.
	///
	/// Comprendre les implications d'un changement demande plus qu'une lecture
	/// rapide — c'est le seul endroit du cockpit où la profondeur se justifie
	/// par défaut, et où l'attente est acceptée puisqu'on l'a demandée.
	pub depth: String,
	/// Suivre aussi les branches locales parties sans demande de fusion.
	#[serde(alias = "include_local_branches")]
	pub include_local_branches: Option<bool>,
}

impl ImpactConfig {
	/// Les branches locales comptent, sauf refus explicite.
	///
	/// `Option` et non `bool` : un fichier écrit avant cette option ne dit rien,
	/// et « rien » doit valoir « oui » — c'est le cas qui justifie l'écran.
	pub fn local_branches(&self) -> bool {
		self.include_local_branches.unwrap_or(true)
	}
}

/// Une option d'une commande maison, telle qu'elle s'affiche.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CommandOptionConfig {
	pub id: String,
	/// Drapeau transmis tel quel : `--force`, `--from`.
	pub flag: String,
	pub label: String,
	/// `boolean` · `text` · `number` · `select`.
	pub kind: String,
	pub hint: String,
	pub placeholder: String,
	/// Valeurs proposées pour un `select`.
	pub choices: Vec<String>,
	pub default_value: String,
}

/// L'argument libre d'une commande, quand elle en attend un.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PositionalConfig {
	pub label: String,
	pub placeholder: String,
	pub required: bool,
	pub hint: String,
}

/// Une commande maison de ce dépôt.
///
/// Ce sont celles qu'on ne retape pas de mémoire : à options, à drapeaux, ou
/// qui montent quelque chose. Les scripts bruts, eux, se lisent déjà dans le
/// dépôt — inutile de les déclarer pour les voir.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CommandConfig {
	pub id: String,
	pub group: String,
	pub label: String,
	pub description: String,
	/// La commande sans argument ni option.
	pub base: String,
	pub positional: Option<PositionalConfig>,
	pub options: Vec<CommandOptionConfig>,
	/// Vrai : elle tourne dans le worktree choisi ; faux : dans le dépôt principal.
	pub scoped: bool,
	/// Elle détruit ou remplace quelque chose : l'écran le dit avant le clic.
	pub danger: bool,
}

/// Une propriété que ce dépôt veut voir rester vraie.
///
/// Écrite en français, pas en règle de linter : ce qui se vérifie
/// mécaniquement est déjà couvert par les outils du dépôt. Ce qui reste — « une
/// migration doit savoir se défaire », « rien n'écrit dans le stockage global
/// depuis un composant » — n'a jamais eu d'endroit où être dit, et se
/// transmettait de bouche à oreille jusqu'à ce que quelqu'un l'oublie.
///
/// Rien ici n'est fourni par défaut, et c'est délibéré : une propriété
/// inventée par le cockpit décrirait le métier de celui qui l'a écrite.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PropertyConfig {
	/// Stable : c'est la clé des verdicts et des calibrations.
	pub id: String,
	/// L'énoncé, tel qu'un agent le jugera.
	pub text: String,
	/// Fichiers ou dossiers concernés ; vide = tout le dépôt.
	pub scope: Vec<String>,
}

/// Ce que le cockpit rassemble avant de laisser partir un agent.
///
/// Un agent qui démarre dans un worktree ne sait rien de ce que le cockpit,
/// lui, sait déjà : le ticket derrière la branche, les retours déposés sur la
/// demande de fusion, ce qui a déjà été tenté ici. Il le redécouvre — mal, et
/// en dépensant sa fenêtre de contexte pour ça.
///
/// Les sources sont celles que le poste a déclarées : sans suivi de tâches,
/// pas de section ticket, et personne n'a rien à désactiver. `off` sert à
/// écarter par défaut une section qui existe mais qu'on ne veut pas — le choix
/// reste modifiable conversation par conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BriefConfig {
	/// Faux : le champ de saisie redevient nu, rien n'est composé ni demandé.
	pub enabled: bool,
	/// Sections décochées à l'ouverture, par identifiant (`ticket`, `review`…).
	pub off: Vec<String>,
}

impl Default for BriefConfig {
	fn default() -> Self {
		Self {
			enabled: true,
			off: Vec::new(),
		}
	}
}

impl BriefConfig {
	/// Cette section part-elle cochée ?
	pub fn wants(&self, id: &str) -> bool {
		!self.off.iter().any(|entry| entry.trim() == id)
	}
}

/* ── La Permanence ──────────────────────────────────────────────────────────
Un opérateur qui tient l'écosystème pendant qu'on fait autre chose. Il ne
décide pas quoi construire : il répare, relance, met à jour, et prouve qu'il
a réussi — l'opération a des oracles que le produit n'a pas.

Tout est déclaré et rien n'est en dur, à une exception près qui est le sujet
même du dispositif : ce qu'elle ne fera jamais. Voir `NEVER`.
────────────────────────────────────────────────────────────────────────── */

/// D'où l'oracle d'un engagement tire sa preuve.
///
/// Un champ libre laisserait écrire « la CI est verte » sans que rien ne sache
/// le vérifier. Une source déclarée, elle, a quelqu'un pour répondre : une
/// commande sort en 0, une propriété rend un verdict avec sa preuve
/// `fichier:ligne`, une CI est `success`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct OracleConfig {
	/// `command` · `property` · `ci` · `comment` — vide = pas d'oracle, donc
	/// pas de départ.
	pub kind: String,
	/// La clé dans cette source : identifiant de commande ou de propriété.
	pub key: String,
}

impl OracleConfig {
	/// Un oracle énonçable, ou rien.
	///
	/// C'est la condition de démarrage d'un engagement : un agent global n'a pas
	/// de condition d'arrêt naturelle, et un agent qui boucle ressemble
	/// exactement à un agent qui travaille.
	pub fn stated(&self) -> bool {
		!self.kind.trim().is_empty() && !self.key.trim().is_empty()
	}
}

/// Ce qui réveille la Permanence, et ce qu'elle a le droit d'en faire.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PermanenceRule {
	/// Clé stable : c'est elle qui rattache un engagement à sa règle.
	pub id: String,
	pub label: String,
	/// Livrée éteinte, toujours. Une règle absente ne déclenche rien, et ce
	/// n'est pas une erreur.
	pub enabled: bool,
	/// Le signal observé : `ci_red`, `dependency_stale`, `flaky_test`…
	///
	/// Choisi parmi ce que la boucle sait observer — c'est du programme, pas du
	/// métier. Un déclencheur inconnu rend la règle inapplicable plutôt que de
	/// la faire disparaître.
	pub trigger: String,
	/// Ce qui doit être vrai en plus du signal, en français. Jugé au tri.
	pub condition: String,
	/// Pour `schedule` et `pr_stale` : le délai qui déclenche, en heures.
	///
	/// Un déclencheur d'horloge sans période tournerait à chaque regard. 0 = le
	/// défaut de son déclencheur — 24 h pour `schedule`, 72 h pour `pr_stale`.
	pub every_hours: u64,
	/// Ce qu'elle tente, en français. Ce n'est pas l'objectif : l'objectif est
	/// écrit par l'agent, engagement par engagement.
	pub reaction: String,
	pub oracle: OracleConfig,
	/// Cette règle redemande ton accord avant que le travail ne parte.
	///
	/// La Permanence approuve normalement elle-même le plan des missions
	/// qu'elle ouvre : le consentement a été donné une fois, à la règle. Ce
	/// drapeau le rend à la mission, règle par règle — pour celles dont on veut
	/// relire le plan sans remettre tout le dispositif en question.
	pub needs_approval: bool,
	/// Plafonds propres à cette règle, sur le modèle de `MAX_RUNNING_TASKS`.
	pub token_budget: u64,
	pub per_hour: u64,
}

/// Ce qui ouvre une pull request au commentaire.
///
/// Le consentement porte sur l'**objet**, pas sur le pouvoir : on n'autorise
/// pas « commenter », on autorise « commenter là ». Ces quatre valeurs sont les
/// portes d'entrée possibles, et aucune n'est ouverte par défaut.
pub const COMMENT_SCOPES: [&str; 4] = [
	// J'ai moi-même écrit au moins un commentaire sur cette PR.
	"i_commented",
	// J'ai autorisé cette PR nommément, depuis l'écran des PR.
	"i_allowed",
	// La PR a été ouverte par la Permanence : elle commente son propre travail.
	"hers",
	// La PR est de moi.
	"mine",
];

/// Signature apposée en fin de commentaire. **Non configurable.**
///
/// Sur une PR, c'est ton compte qui parle : `journal::actor` répond à « qui a
/// fait ça ? » après coup et en interne, il ne dit rien à l'instant où le
/// commentaire s'affiche sous tes collègues.
pub const COMMENT_SIGNATURE: &str = "— la Permanence";

/// Le seul pouvoir dont le geste s'adresse à un humain.
///
/// Il ne s'active pas, il se borne — et il n'est jamais un objectif : un
/// commentaire n'a pas d'oracle (« le commentaire est publié » est l'action,
/// pas la preuve). Il est toujours le compte rendu d'un engagement qui a déjà
/// le sien, écrit après l'exécution de celui-ci.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CommentConfig {
	pub enabled: bool,
	/// Conditions retenues parmi [`COMMENT_SCOPES`]. Vide = nulle part.
	pub scopes: Vec<String>,
	/// Au plus tant de commentaires par PR et par jour. 0 = la valeur par défaut.
	pub per_day: u64,
}

impl CommentConfig {
	/// Une condition cochée, ou elle n'écrit nulle part.
	///
	/// Une liste vide n'est pas une erreur : c'est un pouvoir inerte. L'écran le
	/// dit plutôt que de le laisser croire actif.
	pub fn opens(&self, scope: &str) -> bool {
		self.enabled && self.scopes.iter().any(|entry| entry.trim() == scope)
	}

	/// Défaut délibérément bas : au-delà d'un commentaire par jour et par PR,
	/// elle occupe un fil plutôt qu'elle n'y rend compte.
	pub fn per_day(&self) -> u64 {
		if self.per_day == 0 {
			1
		} else {
			self.per_day
		}
	}
}

/// Branches sur lesquelles la Permanence n'écrira jamais, quoi qu'on coche.
///
/// **Un plancher de sécurité, pas une liste de référence.** Les branches de
/// l'équipe se déclarent dans `workflow.base_branches`, et c'est celle-là qui
/// fait foi — celle-ci ne fait qu'y ajouter les noms universellement dangereux,
/// pour qu'une configuration vide n'ouvre pas la porte de production le jour où
/// quelqu'un active un pouvoir sans avoir rempli son workflow.
///
/// Elle n'a le droit de travailler que sur des branches à elle. Toucher à une
/// branche partagée n'est pas un geste d'opérateur : c'est un geste qui engage
/// tout le monde.
pub const PROTECTED_BRANCHES: [&str; 9] = [
	"main",
	"master",
	"dev",
	"develop",
	"development",
	"stage",
	"staging",
	"prod",
	"production",
];

/// Ce que la Permanence ne fera jamais, quoi qu'on coche.
///
/// En dur et sans outil correspondant, sur le modèle explicite de `remote.rs`.
/// Le critère n'est pas « ce qu'un humain lit » — un commentaire aussi se lit —
/// mais **ce qui engage une décision plutôt qu'un compte rendu**.
/// En anglais : la liste n'est lue que dans la consigne de la Permanence, et
/// les consignes s'écrivent en anglais (voir `i18n::reply_directive`).
pub const NEVER: [&str; 5] = ["approve or reject a review", "assign", "close", "merge", "deploy"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PermanenceConfig {
	/// **Désactivée par défaut.** Une installation neuve ne fait rien tant que
	/// personne ne l'a demandé, et l'entrée quitte le rail : un écran qui ne
	/// peut rien faire ne reste pas au menu.
	pub enabled: bool,
	/// Plage de service, `HH:MM-HH:MM`. Vide = toujours.
	pub hours: String,
	/// Intervalle entre deux regards, en minutes. 0 = la valeur par défaut.
	pub cadence_minutes: u64,
	/// Au réveil : rattraper ce qui s'est accumulé, ou déclarer forfait en
	/// disant ce qui a été sauté. Forfait par défaut — repartir en rafale sur
	/// une nuit de signaux est le plus sûr moyen de brûler un plafond.
	pub catch_up: bool,
	/// Plafonds journaliers. 0 = la valeur par défaut, jamais « sans limite ».
	pub daily_tokens: u64,
	pub daily_engagements: u64,
	/// Engagements menés de front. **Un seul par défaut**, et c'est le
	/// garde-fou le plus fort du dispositif.
	///
	/// Un opérateur humain de permanence ne traite pas huit incidents en
	/// parallèle : il en prend un, note les autres, et y revient. Le plafond
	/// journalier ne protège de rien contre une rafale — six engagements partis
	/// dans la même minute tiennent largement sous vingt.
	pub max_running: u64,
	/// Engagements joués **à blanc** avant qu'elle n'agisse pour de vrai.
	///
	/// Elle décide, elle écrit ce qu'elle aurait fait, elle ne le fait pas. Le
	/// compteur se réarme dès que la liste des pouvoirs change : élargir ce
	/// qu'elle a le droit de faire, c'est un autre dispositif, et il se juge
	/// avant de le lâcher. 0 = pas de rodage, à ses risques.
	pub rehearsal: u64,
	/// Heures pendant lesquelles un objet déjà traité est laissé tranquille.
	///
	/// Deux modes de défaillance d'un coup. **L'auto-déclenchement** : elle
	/// pousse un commit, la tête de branche bouge, le delta la réveille sur son
	/// propre travail. Et **l'acharnement** : sa correction n'a pas marché, la
	/// CI est toujours rouge, elle recommence indéfiniment.
	pub grace_hours: u64,
	/// Échecs consécutifs après lesquels elle se suspend d'elle-même.
	///
	/// Un dispositif qui échoue en boucle ne doit pas continuer d'essayer : au
	/// mieux il brûle le quota, au pire il fait le même dégât N fois.
	pub breaker: u64,
	/// Elle se met au repos sous ce pourcentage de quota d'abonnement restant.
	///
	/// Le plafond de jetons ci-dessus est celui qu'elle s'impose ; celui-ci est
	/// celui que tu partages avec elle. C'est le plus important des deux :
	/// elle travaille en fond, toi au premier plan, et une Permanence qui
	/// dépense les derniers pour cent de ta fenêtre pendant que tu codes est
	/// une régression nette. 0 = la valeur par défaut.
	pub quota_floor_percent: u64,
	/// Le succès est silencieux, l'échec parle.
	pub notify_failures: bool,
	/// Notifier chaque engagement rouvre une boîte de réception d'IA, et lire
	/// douze rapports ne vaut pas mieux que faire le travail.
	pub notify_all: bool,
	/// Rétention des engagements terminés, en jours. 0 = la valeur par défaut.
	pub retention_days: u64,
	/// Moteur commun aux deux rôles. Vide = le premier déclaré.
	pub engine: String,
	/// Le tri : 95 % des appels, des entrées minuscules, un petit modèle.
	pub triage: RoleConfig,
	/// Le travail : seulement quand un engagement démarre.
	pub work: RoleConfig,
	/// Consigne permanente, jointe au contexte de chaque engagement.
	pub prompt: String,
	pub rules: Vec<PermanenceRule>,
	/// Liste blanche des gestes autorisés. **Vide par défaut**, cochée un par un.
	pub powers: Vec<String>,
	pub comment: CommentConfig,
	/// Pull requests que tu as nommément ouvertes au commentaire.
	///
	/// Le consentement porte sur l'objet : cette liste est la trace de chaque
	/// « oui, ici ». Elle se vide d'un geste, PR par PR, depuis l'écran des
	/// changements.
	pub allowed_prs: Vec<u64>,
}

impl PermanenceConfig {
	/// Toutes les 2 minutes : assez pour que « répare la CI » arrive avant qu'on
	/// s'en aperçoive, assez peu pour que le tri reste une dépense négligeable.
	pub fn cadence(&self) -> u64 {
		if self.cadence_minutes == 0 {
			2
		} else {
			self.cadence_minutes
		}
	}

	pub fn retention(&self) -> u64 {
		if self.retention_days == 0 {
			14
		} else {
			self.retention_days
		}
	}

	pub fn daily_tokens(&self) -> u64 {
		if self.daily_tokens == 0 {
			200_000
		} else {
			self.daily_tokens
		}
	}

	pub fn daily_engagements(&self) -> u64 {
		if self.daily_engagements == 0 {
			20
		} else {
			self.daily_engagements
		}
	}

	/// Un seul engagement à la fois, sauf demande explicite.
	pub fn max_running(&self) -> u64 {
		if self.max_running == 0 {
			1
		} else {
			self.max_running
		}
	}

	/// Dix engagements à blanc avant d'agir : assez pour voir ce qu'elle
	/// retient, assez peu pour ne pas y passer la semaine.
	pub fn rehearsal(&self) -> u64 {
		if self.rehearsal == 0 {
			10
		} else {
			self.rehearsal
		}
	}

	pub fn grace_hours(&self) -> u64 {
		if self.grace_hours == 0 {
			6
		} else {
			self.grace_hours
		}
	}

	pub fn breaker(&self) -> u64 {
		if self.breaker == 0 {
			3
		} else {
			self.breaker
		}
	}

	/// L'empreinte de ce qu'elle a le droit de faire.
	///
	/// Sert à réarmer le rodage : deux listes de pouvoirs différentes sont deux
	/// dispositifs différents, même si tout le reste est identique. Triée, pour
	/// qu'un simple réordonnancement ne passe pas pour un élargissement.
	pub fn powers_print(&self) -> String {
		let mut all: Vec<String> = self
			.powers
			.iter()
			.map(|power| power.trim().to_string())
			.filter(|power| !power.is_empty())
			.collect();
		if self.comment.enabled {
			let mut scopes: Vec<&str> = self.comment.scopes.iter().map(|scope| scope.trim()).collect();
			scopes.sort_unstable();
			all.push(format!("comment:{}", scopes.join("+")));
		}
		all.sort();
		all.join(",")
	}

	/// Sous 15 % de quota restant, elle te laisse la place.
	pub fn quota_floor(&self) -> u64 {
		if self.quota_floor_percent == 0 {
			15
		} else {
			self.quota_floor_percent.min(100)
		}
	}

	/// A-t-elle encore le droit de démarrer, vu ce qui reste du quota partagé ?
	///
	/// `used` est le pourcentage **consommé** que rapporte `usage::limits`. Un
	/// quota illisible ne bloque pas : un dispositif qui s'éteint parce qu'il
	/// n'a pas su lire un chiffre est plus difficile à diagnostiquer qu'un
	/// dispositif qui continue et le dit.
	pub fn quota_allows(&self, used: Option<u32>) -> bool {
		match used {
			Some(used) => 100u64.saturating_sub(used as u64) > self.quota_floor(),
			None => true,
		}
	}

	/// Ce geste est-il dans la liste blanche ?
	pub fn allows(&self, power: &str) -> bool {
		self.powers.iter().any(|entry| entry.trim() == power)
	}

	/// Cette pull request a-t-elle été ouverte nommément ?
	pub fn allowed_pr(&self, number: u64) -> bool {
		self.allowed_prs.contains(&number)
	}

	/// Cette branche est-elle interdite d'écriture ?
	///
	/// `declared` sont les branches de base de l'équipe (`workflow.base_branches`)
	/// et, quand on la connaît, la branche par défaut du dépôt. Le plancher de
	/// [`PROTECTED_BRANCHES`] s'y ajoute toujours : une configuration incomplète
	/// ne doit pas se traduire par une porte ouverte.
	///
	/// La comparaison ignore la casse et un éventuel préfixe de serveur —
	/// `origin/main` est `main`, et personne ne doit pouvoir contourner la règle
	/// en écrivant le nom autrement.
	pub fn protected_branch(&self, branch: &str, declared: &[String]) -> bool {
		let bare = branch.trim().trim_start_matches("refs/heads/");
		// Seul un préfixe de serveur se retire : `feat/main` reste une branche de
		// travail, `origin/main` est bien `main`.
		let cleaned = match bare.split_once('/') {
			Some(("origin" | "upstream", tail)) => tail,
			_ => bare,
		}
		.to_lowercase();

		if cleaned.is_empty() {
			return true;
		}
		PROTECTED_BRANCHES.iter().any(|entry| *entry == cleaned)
			|| declared.iter().any(|entry| entry.trim().to_lowercase() == cleaned)
	}

	/// Sommes-nous dans la plage de service ?
	///
	/// `minutes` compte depuis minuit. Une plage qui passe minuit
	/// (`22:00-06:00`) se lit comme telle plutôt que de ne jamais s'ouvrir.
	pub fn open_at(&self, minutes: u32) -> bool {
		let Some((from, to)) = parse_hours(&self.hours) else {
			// Illisible ou vide : toujours. Un réglage qu'on n'arrive pas à lire
			// ne doit pas éteindre le service en silence.
			return true;
		};
		if from == to {
			return true;
		}
		if from < to {
			minutes >= from && minutes < to
		} else {
			minutes >= from || minutes < to
		}
	}

	/// Les règles qui peuvent réellement partir.
	///
	/// Une règle allumée mais sans oracle énonçable ne démarre pas : c'est la
	/// condition d'arrêt d'un agent qui n'en a aucune.
	pub fn live_rules(&self) -> Vec<&PermanenceRule> {
		self.rules
			.iter()
			.filter(|rule| rule.enabled && rule.oracle.stated())
			.collect()
	}
}

/// `HH:MM-HH:MM` en minutes depuis minuit.
fn parse_hours(raw: &str) -> Option<(u32, u32)> {
	let (from, to) = raw.trim().split_once('-')?;
	Some((parse_clock(from)?, parse_clock(to)?))
}

fn parse_clock(raw: &str) -> Option<u32> {
	let (hours, minutes) = raw.trim().split_once(':')?;
	let hours: u32 = hours.trim().parse().ok()?;
	let minutes: u32 = minutes.trim().parse().ok()?;
	if hours > 23 || minutes > 59 {
		return None;
	}
	Some(hours * 60 + minutes)
}

/// Ce qu'une mission a le droit de coûter.
///
/// Les missions sont, de loin, ce qui consomme le plus dans le cockpit : la
/// boucle lance les tâches prêtes toutes les six secondes, et rien ne bornait
/// le total. Le parallélisme l'était (`MAX_RUNNING_TASKS`), pas la dépense — et
/// quatre agents en série coûtent autant que quatre en parallèle.
///
/// Deux plafonds, parce qu'ils répondent à deux peurs différentes : l'un
/// protège du travail qui dérape, l'autre de la réserve qui s'épuise.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MissionsConfig {
	/// Au-delà, une mission se met en pause elle-même. 0 = la valeur par défaut.
	///
	/// **Elle se met en pause, elle ne s'annule pas** : ses branches, ses
	/// worktrees et son travail restent là — c'est exactement ce qu'on veut
	/// examiner après un dérapage. Un clic la reprend.
	///
	/// Volontairement large : un garde-fou qui se déclenche souvent finit par
	/// être désactivé, et celui-ci ne doit sonner que quand quelque chose ne va
	/// pas.
	pub token_budget: u64,
	/// Sous ce pourcentage de quota d'abonnement restant, aucune nouvelle tâche
	/// ne démarre. 0 = la valeur par défaut.
	///
	/// Les tâches en cours vont au bout et le maître continue : on ne tue rien,
	/// on cesse seulement d'en ajouter. C'est le même geste que celui de la
	/// Permanence, pour la même raison — se retrouver à sec un mardi
	/// après-midi coûte plus cher qu'une mission qui attend une heure.
	pub quota_floor_percent: u64,
	/// Au-delà de ce pourcentage de la mémoire de la machine utilisée, aucun
	/// nouvel agent ne démarre — mission, exécutant ou lancement manuel.
	/// 0 = la valeur par défaut. 100 = pas de plafond.
	///
	/// Le parallélisme des exécutants était borné (`MAX_RUNNING_TASKS`), pas ce
	/// qu'ils pèsent une fois lancés : chaque agent tient plusieurs process
	/// (`claude`, ses ponts MCP), et rien n'empêchait d'en cumuler assez pour
	/// saturer la machine. Refuser au démarrage plutôt que d'empiler et
	/// laisser macOS choisir quoi tuer.
	pub memory_ceiling_percent: u64,
	/// Missions autonomes : le maître lit le ticket et propose directement son
	/// découpage, sans faire valider sa compréhension ni son approche.
	///
	/// Faux par défaut — le parcours guidé est la règle. Le chemin autonome
	/// reste pour les équipes qui le préfèrent ; la Permanence, elle, l'emprunte
	/// toujours, puisque personne n'est là pour valider à trois heures du matin.
	pub autonomous: bool,
}

impl MissionsConfig {
	/// 500 000 jetons : bien au-delà d'une mission ordinaire, assez bas pour
	/// qu'une boucle se fasse prendre.
	pub fn token_budget(&self) -> u64 {
		if self.token_budget == 0 {
			500_000
		} else {
			self.token_budget
		}
	}

	pub fn quota_floor(&self) -> u64 {
		if self.quota_floor_percent == 0 {
			15
		} else {
			self.quota_floor_percent.min(100)
		}
	}

	/// 85 % : au-delà, la marge qui reste à macOS pour le reste (l'app elle-
	/// même, ce que l'utilisateur a ouvert à côté) devient trop mince.
	pub fn memory_ceiling(&self) -> u64 {
		if self.memory_ceiling_percent == 0 {
			85
		} else {
			self.memory_ceiling_percent.min(100)
		}
	}

	/// Reste-t-il assez de quota partagé pour lancer une tâche de plus ?
	///
	/// Un quota illisible ne bloque pas : un dispositif qui s'arrête parce
	/// qu'il n'a pas su lire un chiffre est plus difficile à diagnostiquer
	/// qu'un dispositif qui continue.
	pub fn quota_allows(&self, used: Option<u32>) -> bool {
		match used {
			Some(used) => 100u64.saturating_sub(used as u64) > self.quota_floor(),
			None => true,
		}
	}
}

/// Isoler un agent dans un conteneur, avec un plafond mémoire imposé par
/// l'OS plutôt que mesuré après coup.
///
/// Off par défaut : un runtime de conteneurs (Docker, OrbStack) n'est pas un
/// prérequis du cockpit, seulement une intégration de plus qui se rajoute
/// quand on la veut — même doctrine que le reste des intégrations
/// optionnelles. Le coupe-circuit mémoire (`MissionsConfig::memory_ceiling`)
/// reste actif même quand ceci est allumé : l'un borne la machine entière,
/// l'autre chaque agent — ils ne se recouvrent pas.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SandboxConfig {
	pub enabled: bool,
	/// `orb` ou `docker`. Vide = détecté sur le poste, `orb` d'abord — plus
	/// léger à vide que Docker Desktop.
	pub runtime: String,
	/// Image utilisée pour lancer un agent. Vide = l'image par défaut du
	/// cockpit (`sandbox::DEFAULT_IMAGE`).
	pub image: String,
	/// Mégaoctets alloués à chaque agent. 0 = la valeur par défaut.
	pub memory_mb: u64,
	/// Cœurs alloués à chaque agent. 0 = pas de limite.
	pub cpus: f64,
	/// Jeton `claude setup-token` des agents isolés — jamais celui de l'hôte,
	/// rangé dans le trousseau macOS et inaccessible à un conteneur Linux.
	/// `claude setup-token` ne l'écrit dans aucun fichier : il l'affiche une
	/// fois et laisse à qui l'a lancé le soin de le ranger — vérifié
	/// empiriquement, ce n'était pas ce qu'on supposait au premier essai.
	pub oauth_token: String,
}

impl SandboxConfig {
	/// 4096 Mo : large pour un agent seul, assez bas pour qu'une dizaine ne
	/// mette pas la machine à genoux même tous lancés à la fois.
	pub fn memory_limit_mb(&self) -> u64 {
		if self.memory_mb == 0 {
			4096
		} else {
			self.memory_mb
		}
	}
}

/// Tout vide par défaut : une liste absente se distingue ainsi d'une liste
/// choisie, et chaque usage applique son propre repli générique. Sans cette
/// distinction, impossible de savoir s'il faut semer les réglages d'une
/// installation qui les avait dans son binaire.
impl Default for WorkflowConfig {
	fn default() -> Self {
		Self {
			base_branches: Vec::new(),
			done_states: Vec::new(),
			pr_command: String::new(),
			worktree_command: String::new(),
			worktree_remove_command: String::new(),
			dev_command: String::new(),
			test_commands: Vec::new(),
			gate_commands: Vec::new(),
			visual_reports: true,
			agent_browser: true,
			browser_command: String::new(),
			browser_server: String::new(),
			review_read_only: true,
			delivery_dossier: true,
		}
	}
}

/// Ce qu'un service branché apporte au cockpit.
///
/// Le registre existe pour une raison simple : un écran qui interroge un
/// service non configuré ne peut rien afficher d'utile, mais il s'affiche quand
/// même — et laisse croire à une panne là où il n'y a qu'une clé manquante.
/// Déclarer les services permet à l'interface de ne montrer que ce qui a une
/// chance de répondre, et de dire pourquoi le reste manque.
///
/// Le `kind` compte plus que le nom : c'est lui qui dira demain qu'un dépôt est
/// servi par GitHub ou par GitLab, sans que les écrans aient à le savoir.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
	pub id: String,
	pub label: String,
	/// `repository` | `tickets` | `ci` | `deploy` | `payments`
	pub kind: String,
	/// Vrai quand ce service a de quoi répondre.
	pub configured: bool,
	/// Ce qui manque, dit en clair.
	pub missing: String,
}

/// Un rôle d'exécutant : ce qu'on confie à un sous-agent, et jusqu'où.
///
/// Le catalogue vit dans la configuration du cockpit et sert tous les projets.
/// Chaque tâche peut ensuite en dévier — un rôle donne le point de départ, pas
/// une contrainte : « développeur backend senior » ne veut pas dire la même
/// chose d'une stack à l'autre, et cela se règle au moment de lancer.
// L'interface lit du camelCase ; cette structure sortait `permission_mode` tel
// quel, seul champ en deux mots du lot. Le webview n'y trouvait donc rien, et
// réenregistrait le rôle avec un mode vide — que le CLI refusait ensuite. Les
// fichiers déjà écrits en snake_case restent lus grâce aux alias.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RoleConfig {
	/// Clé stable, référencée par les tâches.
	pub id: String,
	pub label: String,
	/// Consigne permanente donnée à l'exécutant.
	pub prompt: String,
	/// Alias de modèle ; vide = celui du poste.
	pub model: String,
	/// Moteur qui fait tourner ce rôle. Vide = le premier déclaré.
	///
	/// Par rôle, et non par mission : une recette gagne parfois à être jugée par
	/// un autre modèle que celui qui a écrit le code, et c'est le genre de choix
	/// qu'on pose une fois pour toutes plutôt qu'à chaque lancement.
	#[serde(default)]
	pub engine: String,
	/// Mode de permission au lancement.
	///
	/// Les exécutants tournent en `bypassPermissions` : ils travaillent seuls,
	/// dans un worktree qui leur est propre, sur une branche qui ne rejoint
	/// l'intégration qu'après relecture. Leur demander l'autorisation toutes les
	/// deux secondes ne protégeait rien — personne ne lit trente demandes — et
	/// bloquait la mission dès qu'on regardait ailleurs. Le filet est ailleurs :
	/// le périmètre d'écriture, l'isolation du worktree, et l'accord humain sur
	/// le plan. Un rôle peut malgré tout redemander `acceptEdits`.
	#[serde(alias = "permission_mode")]
	pub permission_mode: String,
	/// Profondeur de réflexion voulue pour ce rôle : `fast`, `normal`, `deep`.
	///
	/// Vide = le réglage du moteur s'applique. Une recette qui relit un diff
	/// n'a pas besoin de la même dépense qu'un maître qui découpe une mission,
	/// et c'est le levier de coût le plus direct qu'on ait.
	#[serde(default)]
	pub depth: String,
	/// Commande à lancer en tête de la consigne — une skill, typiquement.
	///
	/// Une équipe range sa méthode dans des commandes du dépôt : lire un ticket,
	/// respecter des conventions, produire un plan à sa façon. Les recopier dans
	/// un prompt les ferait diverger de la version qui vit dans le dépôt ; on
	/// appelle donc la commande, et c'est elle qui fait foi.
	///
	/// Ce qui suit est remplacé, à partir de la mission et de la tâche :
	/// `{ticket}`, `{ticketUrl}`, `{branch}`, `{mission}`, `{task}`, `{brief}`.
	#[serde(default)]
	pub command: String,
	/// Ce rôle vérifie le travail des autres au lieu d'en produire.
	///
	/// Recette et relecture n'ont de sens qu'une fois l'implémentation livrée :
	/// lancées en même temps, elles relisent une branche vide et rendent un
	/// compte rendu sur rien. Le lanceur les retient donc jusqu'à ce que les
	/// autres tâches aient livré — sans dépendre de ce que le maître a pensé à
	/// déclarer dans son plan.
	#[serde(default)]
	pub verifies: bool,
	/// Chemins où ce rôle a le droit d'écrire. Vide = tout le dépôt.
	pub scope: Vec<String>,
}

/// Clé du rôle qui pilote une mission. Réservée : aucune tâche ne la porte.
pub const MASTER_ROLE: &str = "master";

/// Rôles proposés tant que la configuration n'en déclare aucun.
///
/// Volontairement génériques : ils décrivent une responsabilité, pas une pile
/// technique. C'est à chaque équipe d'y mettre sa stack.
pub fn default_roles() -> Vec<RoleConfig> {
	default_roles_in(&crate::i18n::lang())
}

/// Les mêmes, libellés dans une langue donnée. `Config::load` passe par là :
/// la langue en cours se lit elle-même dans la config, et la demander pendant
/// le chargement tournerait en rond.
fn default_roles_in(lang: &str) -> Vec<RoleConfig> {
	let label = |key: &str| crate::i18n::t_in(lang, key);
	let role = |id: &str, label: String, prompt: &str, scope: &[&str]| RoleConfig {
		id: id.into(),
		label,
		prompt: prompt.into(),
		model: String::new(),
		depth: String::new(),
		engine: String::new(),
		permission_mode: "bypassPermissions".into(),
		command: String::new(),
		// Recette et relecture jugent ce que les autres ont écrit : elles
		// attendent leur tour.
		verifies: matches!(id, "qa" | "review"),
		scope: scope.iter().map(|entry| entry.to_string()).collect(),
	};
	vec![
		// Le maître est un rôle comme les autres : sa consigne, son modèle et
		// surtout sa commande de démarrage se règlent où se règlent les leurs.
		// Ce qui le distingue — les outils d'orchestration, les étapes de la
		// mission — reste posé par le cockpit et ne se configure pas.
		role(MASTER_ROLE, label("config.roles.master"), "", &[]),
		role(
			"backend",
			label("config.roles.backend"),
			"You implement the server side of the task you are given.\n\n\
			 The contracts set on the integration branch are authoritative: read them in \
			 the code rather than relying on what you are told about them, and report what \
			 you are missing instead of inventing it. Follow the repository's conventions as \
			 the neighbouring code shows them.\n\n\
			 Commit your work: what is not committed does not exist for the rest of the \
			 mission.",
			&[],
		),
		role(
			"frontend",
			label("config.roles.frontend"),
			"You implement the user interface of the task you are given.\n\n\
			 The contracts set on the integration branch are authoritative: read them in \
			 the code. You do not modify the server — if a contract is missing, you report \
			 it rather than inventing it. Follow the repository's conventions as the \
			 neighbouring components show them.\n\n\
			 Commit your work: what is not committed does not exist for the rest of the \
			 mission.",
			&[],
		),
		// Recette et relecture rendent un verdict, pas une dissertation : leur
		// rapport déclenche — ou non — une reprise, et c'est le maître qui devra
		// le lire. On décrit donc ce qu'on attend en sortie plutôt que la façon
		// de s'y prendre : le format est une interface, la méthode leur revient.
		role(
			"qa",
			label("config.roles.qa"),
			"You check that the feature behaves as the task requires. You do not fix \
			 other people's code.\n\n\
			 End with a verdict on a single line (keep these markers in English exactly):\n\
			 `VERDICT: blocking` — an expected behaviour is missing or wrong.\n\
			 `VERDICT: concerns` — it works, but something will need to be reworked.\n\
			 `VERDICT: ok` — nothing to report.\n\n\
			 Under the verdict, list what must be fixed, one item per line, naming the \
			 file and what is wrong. These lines will be passed as they are to whoever \
			 has to fix them, without the surrounding report: they must stand on their \
			 own.\n\n\
			 State what you could not check, rather than leaving it to be guessed.",
			&[],
		),
		role(
			"review",
			label("config.roles.review"),
			"You review the mission's changes and report what is wrong, fragile, or \
			 inconsistent between the contributions. You modify nothing.\n\n\
			 End with a verdict on a single line (keep these markers in English exactly):\n\
			 `VERDICT: blocking` — this must not be merged as it is.\n\
			 `VERDICT: concerns` — mergeable, but something will need to be reworked.\n\
			 `VERDICT: ok` — nothing to report.\n\n\
			 Under the verdict, list what must be fixed, one item per line, naming the \
			 file and what is wrong. These lines will be passed as they are to whoever \
			 has to fix them, without the surrounding report: they must stand on their \
			 own.\n\n\
			 Only block on what deserves it: a leaking secret, a regression, a missing \
			 migration. Everything else goes under concerns.",
			&[],
		),
	]
}

/// Un projet piloté par le cockpit.
///
/// Le cockpit est né autour d'un seul dépôt ; il en suit maintenant plusieurs,
/// sans qu'un projet perso ait à ressembler à celui de l'entreprise. Chaque
/// champ laissé vide hérite du réglage global : déclarer un projet ne demande
/// donc que ce qui lui est propre, et une intégration absente fait simplement
/// disparaître l'écran qui en dépend plutôt que d'afficher une erreur.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProjectConfig {
	/// Identifiant stable — sert de clé, ne s'affiche pas.
	pub id: String,
	pub name: String,
	/// Teinte du projet dans l'interface ; vide = couleur d'accent.
	pub color: String,

	// Réglages propres au projet. Mêmes noms que les sections globales, pour
	// qu'un même patch s'applique indifféremment à l'un ou à l'autre.
	pub main_repo: String,
	pub projects_root: String,
	pub editor: String,
	pub github: GithubConfig,
	pub linear: LinearConfig,
	pub gitlab: GitlabConfig,
	pub trigger: TriggerConfig,
	pub railway: RailwayConfig,
	pub betterstack: BetterstackConfig,
	pub stripe: StripeConfig,
	/// Lue pour reprendre l'identifiant d'équipe Linear, jamais réécrite.
	#[serde(skip_serializing)]
	pub team: LegacyTeam,
	pub workflow: WorkflowConfig,
	/// Rôles des agents de mission, propres à ce projet.
	///
	/// Un produit et un outil interne ne se découpent pas de la même façon : les
	/// rôles suivent le projet comme le reste. Vide = ceux du global, ou le
	/// catalogue intégré si le global n'en déclare pas non plus.
	pub roles: Vec<RoleConfig>,
	pub engines: Vec<EngineConfig>,
	/// Le compte sous lequel les agents de ce projet travaillent.
	///
	/// C'est ici, et pas sur le moteur, parce que l'identité suit le produit et
	/// non le programme : le même `claude` sert les deux, et c'est le dépôt sur
	/// lequel on travaille qui décide de qui on est en le faisant.
	pub account: String,
	/// Comment lire les changements de ce projet — son brief, surtout.
	///
	/// Propre au projet et non global : deux produits n'ont ni les mêmes
	/// utilisateurs ni les mêmes enjeux, et c'est justement ce que le brief sert
	/// à dire.
	pub impact: ImpactConfig,
	/// Ce qui doit rester vrai dans ce dépôt. Propre au projet : une propriété
	/// décrit ce que ce code-ci ne doit pas cesser d'être.
	pub properties: Vec<PropertyConfig>,
	/// Les commandes maison de ce dépôt.
	pub commands: Vec<CommandConfig>,
	/// Ce que la Permanence surveille et s'autorise ici.
	///
	/// Le service — heures, cadence, plafonds, rôles — reste du poste et
	/// s'hérite ; les règles et les pouvoirs suivent le projet, puisqu'ils
	/// parlent de ses branches, de ses commandes et de ses PR. Même
	/// cloisonnement que `properties` et `commands`.
	pub permanence: PermanenceConfig,
}

/// La valeur du projet si elle existe, celle du global sinon.
fn inherit(project: &str, global: &str) -> String {
	if project.trim().is_empty() {
		global.to_string()
	} else {
		project.trim().to_string()
	}
}

impl ProjectConfig {
	/// Applique les réglages du projet par-dessus les valeurs globales.
	///
	/// Chaque champ vide hérite : un projet interne partage ainsi le jeton
	/// GitHub de l'entreprise sans le redéclarer, tandis qu'un projet perso peut
	/// tout redéfinir — jetons compris — et vivre sur d'autres comptes.
	/// Applique les réglages du projet sur la configuration globale.
	///
	/// `cloisonne` dit s'il existe plus d'un projet : c'est ce qui décide si les
	/// cibles — dépôt, organisation, équipe — s'héritent encore du global.
	pub fn merge_into(&self, base: &mut Config, cloisonne: bool) {
		base.general.main_repo = inherit(&self.main_repo, &base.general.main_repo);
		base.general.projects_root = inherit(&self.projects_root, &base.general.projects_root);
		base.general.editor = inherit(&self.editor, &base.general.editor);

		// Les jetons s'héritent toujours : un même accès GitHub ou Linear sert
		// plusieurs produits.
		base.github.token = inherit(&self.github.token, &base.github.token);
		// Le compte suit le jeton : un projet dont le dépôt vit sous une autre
		// identité GitHub doit pouvoir le dire, sinon il est interrogé avec le
		// compte actif — qui n'y a pas accès, et l'erreur rendue désigne le nom
		// du dépôt au lieu de l'identité qui manque.
		base.github.user = inherit(&self.github.user, &base.github.user);
		base.linear.token = inherit(&self.linear.token, &base.linear.token);
		base.trigger.token = inherit(&self.trigger.token, &base.trigger.token);
		base.trigger.api_url = inherit(&self.trigger.api_url, &base.trigger.api_url);
		// GitLab suit la même règle que les autres accès : le jeton et l'instance
		// s'héritent — une entreprise n'a qu'un GitLab — là où le projet visé est
		// forcément propre au projet.
		base.gitlab.token = inherit(&self.gitlab.token, &base.gitlab.token);
		base.gitlab.host = inherit(&self.gitlab.host, &base.gitlab.host);

		// Les cibles, elles, ne s'héritent qu'en l'absence de second projet.
		//
		// Tant qu'il n'y en a qu'un, le global lui tient lieu de configuration :
		// c'est ainsi que le cockpit se réglait avant d'en connaître plusieurs, et
		// vider ces écrans casserait une installation qui marchait. Dès qu'un
		// deuxième existe, hériter devient trompeur — on lisait les pull requests
		// d'un produit sur l'écran d'un autre, sans que rien ne le signale. Un
		// projet qui ne déclare pas son dépôt n'emprunte alors plus celui du
		// voisin : il n'est simplement pas encore configuré, et le dit.
		if cloisonne {
			base.github.repo = self.github.repo.trim().to_string();
			base.linear.team_key = self.linear.team_key.trim().to_string();
			base.linear.team_id = self.linear.team_id.trim().to_string();
			base.trigger.project_ref = self.trigger.project_ref.trim().to_string();
			base.gitlab.project = self.gitlab.project.trim().to_string();
		} else {
			base.github.repo = inherit(&self.github.repo, &base.github.repo);
			base.linear.team_key = inherit(&self.linear.team_key, &base.linear.team_key);
			base.linear.team_id = inherit(&self.linear.team_id, &base.linear.team_id);
			base.trigger.project_ref = inherit(&self.trigger.project_ref, &base.trigger.project_ref);
			base.gitlab.project = inherit(&self.gitlab.project, &base.gitlab.project);
		}
		// Les environnements ne se fusionnent pas un à un : une liste propre au
		// projet remplace celle du global, sans quoi on interrogerait les
		// déploiements d'un autre produit.
		if !self.trigger.environments.is_empty() {
			base.trigger.environments = self.trigger.environments.clone();
		}

		// Le brief ne s'hérite jamais : décrire un produit avec les mots d'un
		// autre est pire que ne rien décrire du tout — l'analyse parlerait
		// d'utilisateurs qui n'existent pas. Le reste, qui ne dit que le moteur
		// et sa profondeur, s'hérite comme les autres réglages d'outillage.
		base.impact.brief = if cloisonne {
			self.impact.brief.trim().to_string()
		} else {
			inherit(&self.impact.brief, &base.impact.brief)
		};
		// Les propriétés ne s'héritent jamais entre projets : ce qui doit rester
		// vrai dans un dépôt n'a aucune raison de l'être dans un autre, et une
		// propriété empruntée serait jugée sur du code qu'elle ne décrit pas.
		base.properties = if cloisonne || !self.properties.is_empty() {
			self.properties.clone()
		} else {
			base.properties.clone()
		};
		// Les commandes d'un dépôt ne valent que pour lui : un projet cloisonné
		// qui n'en déclare pas n'a pas de commandes, plutôt que celles du voisin.
		base.commands = if cloisonne || !self.commands.is_empty() {
			self.commands.clone()
		} else {
			base.commands.clone()
		};
		base.impact.engine = inherit(&self.impact.engine, &base.impact.engine);
		base.impact.model = inherit(&self.impact.model, &base.impact.model);
		base.impact.depth = inherit(&self.impact.depth, &base.impact.depth);
		if self.impact.include_local_branches.is_some() {
			base.impact.include_local_branches = self.impact.include_local_branches;
		}

		// La Permanence se coupe en deux, et c'est délibéré : le service — heures,
		// cadence, plafonds, rôles — décrit le poste, il n'a pas de raison de
		// changer quand on bascule de projet. Les règles et les pouvoirs, eux,
		// parlent des branches, des commandes et des PR d'un dépôt précis :
		// hérités, ils feraient agir la Permanence sur un projet avec les
		// autorisations d'un autre. Cloisonnés comme `properties`.
		base.permanence.rules = if cloisonne || !self.permanence.rules.is_empty() {
			self.permanence.rules.clone()
		} else {
			base.permanence.rules.clone()
		};
		base.permanence.powers = if cloisonne || !self.permanence.powers.is_empty() {
			self.permanence.powers.clone()
		} else {
			base.permanence.powers.clone()
		};
		if cloisonne || self.permanence.comment.enabled {
			base.permanence.comment = self.permanence.comment.clone();
		}
		base.permanence.prompt = inherit(&self.permanence.prompt, &base.permanence.prompt);

		// Le workflow d'un projet remplace celui du global champ par champ : une
		// équipe peut nommer ses colonnes autrement sans redéclarer ses branches.
		// Cloisonné, il repart des valeurs génériques plutôt que d'emprunter les
		// états d'une autre équipe — un outil interne n'a pas les colonnes d'un
		// produit.
		if cloisonne {
			base.workflow = WorkflowConfig::default();
		}
		if !self.workflow.base_branches.is_empty() {
			base.workflow.base_branches = self.workflow.base_branches.clone();
		}
		if !self.workflow.done_states.is_empty() {
			base.workflow.done_states = self.workflow.done_states.clone();
		}
		// La commande d'ouverture de PR appartient au dépôt : celle d'un produit
		// n'existe pas chez le voisin, et l'y hériter ferait jouer au maître une
		// commande introuvable.
		if !self.workflow.pr_command.trim().is_empty() {
			base.workflow.pr_command = self.workflow.pr_command.clone();
		}
		if !self.workflow.worktree_command.trim().is_empty() {
			base.workflow.worktree_command = self.workflow.worktree_command.clone();
		}
		if !self.workflow.worktree_remove_command.trim().is_empty() {
			base.workflow.worktree_remove_command = self.workflow.worktree_remove_command.clone();
		}
		if !self.workflow.dev_command.trim().is_empty() {
			base.workflow.dev_command = self.workflow.dev_command.clone();
		}
		if !self.workflow.test_commands.is_empty() {
			base.workflow.test_commands = self.workflow.test_commands.clone();
		}
		// Les portes appartiennent au dépôt, comme ses tests.
		if !self.workflow.gate_commands.is_empty() {
			base.workflow.gate_commands = self.workflow.gate_commands.clone();
		}
		// Un booléen n'a pas de « vide » : le projet dit toujours le sien, vrai
		// tant qu'on ne l'a pas décoché.
		base.workflow.review_read_only = self.workflow.review_read_only;
		base.workflow.delivery_dossier = self.workflow.delivery_dossier;
		base.workflow.visual_reports = self.workflow.visual_reports;
		base.workflow.agent_browser = self.workflow.agent_browser;
		if !self.workflow.browser_command.trim().is_empty() {
			base.workflow.browser_command = self.workflow.browser_command.clone();
		}
		if !self.workflow.browser_server.trim().is_empty() {
			base.workflow.browser_server = self.workflow.browser_server.clone();
		}

		base.railway.token = inherit(&self.railway.token, &base.railway.token);
		base.railway.project_id = if cloisonne {
			self.railway.project_id.trim().to_string()
		} else {
			inherit(&self.railway.project_id, &base.railway.project_id)
		};

		base.betterstack.token = inherit(&self.betterstack.token, &base.betterstack.token);

		base.stripe.token = inherit(&self.stripe.token, &base.stripe.token);

		// Les rôles suivent le projet comme tout le reste : un outil interne ne
		// se découpe pas comme une application. Sans second projet, le global
		// continue de tenir lieu de configuration.
		if !self.roles.is_empty() || cloisonne {
			base.roles = self.roles.clone();
		}
		// Les moteurs, eux, s'héritent toujours : un poste n'a qu'un `claude`
		// installé et qu'une passerelle, quel que soit le projet ouvert. Un projet
		// peut malgré tout déclarer les siens.
		if !self.engines.is_empty() {
			base.engines = self.engines.clone();
		}
		// Le compte s'hérite toujours, cloisonnement ou non : un projet qui n'en
		// désigne pas travaille sous celui du poste, ce qui est très exactement ce
		// que faisait le cockpit avant d'en connaître plusieurs. Les cloisonner
		// aurait déconnecté d'un coup tous les projets d'une installation qui
		// marchait.
		base.account = inherit(&self.account, &base.account);
	}

	/// Clés que ce projet définit en propre — le reste est hérité.
	///
	/// Sert à l'écran Réglages : sans cette distinction, impossible de savoir si
	/// un champ vide veut dire « rien » ou « celui d'à côté ».
	pub fn overrides(&self) -> Vec<String> {
		let mut keys = Vec::new();
		let mut mark = |key: &str, value: &str| {
			if !value.trim().is_empty() {
				keys.push(key.to_string());
			}
		};
		mark("main_repo", &self.main_repo);
		mark("projects_root", &self.projects_root);
		mark("editor", &self.editor);
		mark("account", &self.account);
		mark("github_repo", &self.github.repo);
		mark("github", &self.github.token);
		mark("linear", &self.linear.token);
		mark("linear_team_key", &self.linear.team_key);
		mark("linear_team_id", &self.linear.team_id);
		mark("trigger", &self.trigger.token);
		mark("trigger_project_ref", &self.trigger.project_ref);
		mark("railway", &self.railway.token);
		mark("railway_project_id", &self.railway.project_id);
		mark("betterstack", &self.betterstack.token);
		mark("stripe", &self.stripe.token);
		mark("impact_brief", &self.impact.brief);
		if !self.trigger.environments.is_empty() {
			keys.push("trigger_environments".into());
		}
		keys
	}
}

impl ProjectConfig {
	/// Nom lisible, déduit du dossier quand il n'est pas donné.
	pub fn display_name(&self) -> String {
		if !self.name.trim().is_empty() {
			return self.name.trim().to_string();
		}
		PathBuf::from(&self.main_repo)
			.file_name()
			.map(|name| name.to_string_lossy().to_string())
			.unwrap_or_else(|| self.id.clone())
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Config {
	/// Projets pilotés. Jamais vide en mémoire : `load` en synthétise un à
	/// partir des réglages globaux quand le fichier n'en déclare aucun.
	pub projects: Vec<ProjectConfig>,
	/// Projet courant, dont les réglages priment sur les globaux.
	pub active_project: String,
	pub general: GeneralConfig,
	pub github: GithubConfig,
	pub linear: LinearConfig,
	pub gitlab: GitlabConfig,
	pub trigger: TriggerConfig,
	pub railway: RailwayConfig,
	pub betterstack: BetterstackConfig,
	pub stripe: StripeConfig,
	/// Lue pour reprendre l'identifiant d'équipe Linear, jamais réécrite.
	#[serde(skip_serializing)]
	pub team: LegacyTeam,
	pub workflow: WorkflowConfig,
	pub impact: ImpactConfig,
	/// Ce qui doit rester vrai — déclaré par projet, jamais fourni par défaut.
	pub properties: Vec<PropertyConfig>,
	/// Les commandes maison, déclarées ou détectées depuis le dépôt.
	pub commands: Vec<CommandConfig>,
	/// L'opérateur autonome : éteint tant que personne ne l'a demandé.
	pub permanence: PermanenceConfig,
	/// Ce qu'une mission a le droit de coûter.
	pub missions: MissionsConfig,
	/// Où un agent a le droit de tourner — en direct, ou isolé dans un
	/// conteneur. Éteint tant que personne ne l'a demandé.
	pub sandbox: SandboxConfig,
	/// Ce qui est joint à un agent au moment de le lancer.
	pub brief: BriefConfig,
	/// Catalogue des rôles d'exécutants ; vide = ceux par défaut.
	pub roles: Vec<RoleConfig>,
	pub engines: Vec<EngineConfig>,
	/// Les comptes connus du poste. Toujours global : un compte est une identité
	/// installée sur cette machine, que plusieurs projets peuvent se partager.
	pub accounts: Vec<AccountConfig>,
	/// Le compte sous lequel on travaille ici. Vide = celui du poste.
	pub account: String,
}

/// Donne au projet historique ce que le global déclarait pour lui.
///
/// Avant les projets, l'équipe Linear et les rôles se réglaient une fois pour toutes
/// au niveau global. Les cloisonner les aurait retirés du projet qui s'en
/// servait — celui qui travaille sur le dépôt du global — sans que personne
/// n'ait rien demandé. On les lui recopie donc, une fois, et le fichier garde
/// ensuite sa nouvelle forme.
///
/// Sans second projet, rien ne bouge : l'héritage suffit encore.
pub fn migrate_project_ownership() -> bool {
	let mut config = Config::load();
	if config.projects.len() < 2 {
		return false;
	}

	let repo = config.general.main_repo.trim_end_matches('/').to_string();
	let global_roles = config.roles.clone();
	let global_team_id = config.linear.team_id.clone();
	let global_workflow = config.workflow.clone();

	let Some(project) = config
		.projects
		.iter_mut()
		.find(|project| project.main_repo.trim_end_matches('/') == repo && !repo.is_empty())
	else {
		return false;
	};

	let mut change = false;
	if project.roles.is_empty() && !global_roles.is_empty() {
		project.roles = global_roles;
		change = true;
	}
	if project.linear.team_id.trim().is_empty() && !global_team_id.trim().is_empty() {
		project.linear.team_id = global_team_id;
		change = true;
	}
	if project.workflow.done_states.is_empty() && !global_workflow.done_states.is_empty() {
		project.workflow = global_workflow;
		change = true;
	}

	if change {
		let _ = config.save();
	}
	change
}

/// Le nom du projet qui travaille sur ce dépôt, s'il en existe un.
///
/// Sert aux surfaces qui montrent plusieurs projets à la fois — le téléphone,
/// notamment, où l'on veut suivre ce qui tourne partout sans avoir à basculer.
/// Rendre le nom plutôt que l'identifiant : c'est ce qu'on lit à l'écran.
pub fn project_named(repo: &str) -> String {
	let repo = repo.trim_end_matches('/');
	if repo.is_empty() {
		return String::new();
	}
	let config = Config::load();
	config
		.projects
		.iter()
		.find(|project| inherit(&project.main_repo, &config.general.main_repo).trim_end_matches('/') == repo)
		.map(|project| {
			if project.name.trim().is_empty() {
				project.id.clone()
			} else {
				project.name.clone()
			}
		})
		.unwrap_or_default()
}

/// Le chemin d'un dossier tel que l'utilisateur l'a écrit, rendu utilisable.
///
/// Trois formes se saisissent naturellement et aucune ne marchait :
///
/// - `~/Sites/produit` — le tilde est une convention du shell, pas du système
///   de fichiers. Passé tel quel, il désigne un dossier littéralement nommé
///   « ~ », qui n'existe jamais ;
/// - `produit` — un nom seul, qu'on veut voir résolu sous le dossier des
///   projets, puisque c'est exactement à ça qu'il sert ;
/// - `/Users/moi/Sites/produit ` — avec une espace de trop, collée par un
///   copier-coller depuis un terminal.
///
/// Le message rendu jusqu'ici — « n'est pas un dépôt git » — désignait le
/// dépôt alors que c'est le chemin qui n'avait pas été compris. On cherche
/// longtemps du mauvais côté.
pub fn resolve_path(raw: &str, projects_root: &str) -> String {
	// `is_separator` : `/` partout, `\` aussi sous Windows.
	let trimmed = raw.trim().trim_end_matches(std::path::is_separator);
	if trimmed.is_empty() {
		return String::new();
	}

	let expanded = match trimmed.strip_prefix("~") {
		Some(rest) => match dirs::home_dir() {
			// `join("")` ajoute une barre finale : « ~ » seul doit rendre le
			// dossier personnel, pas « /Users/moi/ ».
			Some(home) => {
				let rest = rest.trim_start_matches(std::path::is_separator);
				if rest.is_empty() {
					home
				} else {
					home.join(rest)
				}
			}
			// Sans dossier personnel, le tilde ne veut rien dire : mieux vaut
			// rendre le chemin tel quel et laisser l'appelant dire qu'il ne le
			// trouve pas.
			None => PathBuf::from(trimmed),
		},
		None => PathBuf::from(trimmed),
	};

	if expanded.is_absolute() {
		return expanded.to_string_lossy().to_string();
	}
	// Relatif : sous le dossier des projets quand il est déclaré. C'est la
	// seule racine que le cockpit ait le droit de supposer.
	let root = projects_root.trim();
	if root.is_empty() {
		return expanded.to_string_lossy().to_string();
	}
	PathBuf::from(root).join(expanded).to_string_lossy().to_string()
}

pub fn config_dir() -> PathBuf {
	dirs::home_dir().unwrap_or_default().join(".config").join("cockpit")
}

pub fn config_path() -> PathBuf {
	config_dir().join("config.toml")
}

fn env_override(current: &str, key: &str) -> String {
	std::env::var(key)
		.ok()
		.filter(|v| !v.trim().is_empty())
		.unwrap_or_else(|| current.to_string())
}

impl Config {
	/// Ce qui est branché, et ce qui ne l'est pas.
	///
	/// Un service se déclare configuré dès qu'il a de quoi répondre — souvent un
	/// jeton, parfois un dépôt ou un projet en plus. On ne teste pas la
	/// connexion ici : une clé révoquée se découvre à l'appel, et faire un appel
	/// réseau pour dessiner un menu rendrait l'app lente et bavarde.
	pub fn connectors(&self) -> Vec<Connector> {
		let entry = |id: &str, label: &str, kind: &str, ok: bool, missing: &str| Connector {
			id: id.into(),
			label: label.into(),
			kind: kind.into(),
			configured: ok,
			missing: if ok { String::new() } else { missing.into() },
		};

		vec![
			entry(
				"github",
				"GitHub",
				"repository",
				!self.github.repo.trim().is_empty(),
				&crate::i18n::t("config.connectorMissing.github"),
			),
			entry(
				"linear",
				"Linear",
				"tickets",
				!self.linear.token.trim().is_empty(),
				&crate::i18n::t("config.connectorMissing.linear"),
			),
			// Le projet compte autant que le jeton : un jeton seul ne dit pas où
			// chercher les tickets, et l'écran s'ouvrirait vide sans expliquer.
			entry(
				"gitlab",
				"GitLab",
				"tickets",
				!self.gitlab.token.trim().is_empty() && !self.gitlab.project.trim().is_empty(),
				&crate::i18n::t("config.connectorMissing.gitlab"),
			),
			entry(
				"trigger",
				"Trigger.dev",
				"ci",
				!self.trigger.token.trim().is_empty() || !self.trigger.environments.is_empty(),
				&crate::i18n::t("config.connectorMissing.trigger"),
			),
			entry(
				"railway",
				"Railway",
				"deploy",
				!self.railway.token.trim().is_empty(),
				&crate::i18n::t("config.connectorMissing.railway"),
			),
			entry(
				"stripe",
				"Stripe",
				"payments",
				!self.stripe.token.trim().is_empty(),
				&crate::i18n::t("config.connectorMissing.stripe"),
			),
		]
	}

	/// Complète les colonnes et branches d'une configuration muette.
	///
	/// Ni équipe, ni sujets, ni identifiants : ces valeurs se déclarent, elles ne
	/// se devinent pas. Seules restent ici des colonnes de suivi répandues, pour
	/// qu'un tableau affiche quelque chose avant qu'on ait tout renseigné.
	fn seed_workflow(&mut self, existing_install: bool) {
		// Les commandes de worktree vivaient dans le binaire, écrites pour une
		// seule équipe. Les rendre réglables ne doit pas les retirer à celle qui
		// s'en sert : sans cette graine, sa prochaine mise à jour remplacerait
		// une création qui monte l'infra du dépôt par un `git worktree add` nu,
		// et le worktree obtenu serait inutilisable sans que rien ne le dise.
		//
		// Uniquement sur une installation déjà présente : une nouvelle part des
		// valeurs génériques, comme elle le doit.
		if existing_install {
			if self.workflow.worktree_command.is_empty() {
				self.workflow.worktree_command = "/create-worktree {branch}".into();
			}
			if self.workflow.worktree_remove_command.is_empty() {
				self.workflow.worktree_remove_command = "pnpm worktree:remove {folder} --force".into();
			}
			if self.workflow.dev_command.is_empty() {
				self.workflow.dev_command = "pnpm dev".into();
			}
		}
		if self.workflow.base_branches.is_empty() {
			self.workflow.base_branches = ["main", "master", "develop", "dev"]
				.iter()
				.map(|entry| entry.to_string())
				.collect();
		}
	}

	/// Reprend l'identifiant d'équipe Linear des anciennes sections `[team]`,
	/// globale et par projet. Voir `LegacyTeam`.
	fn adopt_legacy_team(&mut self) {
		self.team.adopt_into(&mut self.linear);
		for project in &mut self.projects {
			project.team.adopt_into(&mut project.linear);
		}
	}

	pub fn load() -> Self {
		let raw = std::fs::read_to_string(config_path()).ok();
		// Un fichier déjà présent vient d'une version qui gardait ces réglages
		// dans son code : il faut les lui rendre, écrits cette fois.
		let existing_install = raw.is_some();
		let mut cfg: Config = raw.and_then(|raw| toml::from_str(&raw).ok()).unwrap_or_default();

		// Ni dossier de projets, ni éditeur imposés : ce sont des choix, et un
		// choix pris à la place de quelqu'un se découvre toujours au mauvais
		// moment — un dossier vide qu'on croit cassé, un éditeur qui n'est pas
		// installé. Les écrans qui en dépendent le réclament, une fois.
		// Le dépôt principal ne se devine pas : le nom du dossier qui traînait ici
		// était celui d'un seul projet. Sans réglage, l'écran de configuration le
		// réclame, ce qui est plus honnête qu'un chemin qui n'existe pas.

		// Reprise des réglages qu'une version antérieure gardait dans son code.
		// Sans cette graine, la mise à jour ferait disparaître les colonnes, les
		// branches et les sujets d'une équipe qui ne les avait jamais écrits
		// nulle part — ils étaient dans le binaire.
		cfg.seed_workflow(existing_install);
		cfg.adopt_legacy_team();
		if cfg.roles.is_empty() {
			// Pas `i18n::lang()` : elle relit la config qu'on est en train de charger.
			let lang = if cfg!(test) {
				"en"
			} else {
				crate::i18n::resolve(&cfg.general.language)
			};
			cfg.roles = default_roles_in(lang);
		}

		cfg.github.token = env_override(&cfg.github.token, "COCKPIT_GITHUB_TOKEN");
		cfg.linear.token = env_override(&cfg.linear.token, "COCKPIT_LINEAR_TOKEN");
		cfg.trigger.token = env_override(&cfg.trigger.token, "COCKPIT_TRIGGER_TOKEN");
		cfg.railway.token = env_override(&cfg.railway.token, "COCKPIT_RAILWAY_TOKEN");
		cfg.betterstack.token = env_override(&cfg.betterstack.token, "COCKPIT_BETTERSTACK_TOKEN");
		cfg.stripe.token = env_override(&cfg.stripe.token, "COCKPIT_STRIPE_TOKEN");

		if cfg.trigger.api_url.trim().is_empty() {
			cfg.trigger.api_url = "https://api.trigger.dev".into();
		}

		cfg.ensure_projects();
		cfg
	}

	/// Garantit au moins un projet, et un projet actif qui existe.
	///
	/// Les configurations d'avant le multi-projets n'en déclarent aucun : plutôt
	/// que d'imposer une migration, on reconstitue le projet historique à partir
	/// des réglages globaux. Il ne s'écrit sur disque qu'à la première
	/// sauvegarde, quand l'utilisateur touche vraiment à sa configuration.
	fn ensure_projects(&mut self) {
		if self.projects.is_empty() {
			// Le projet historique n'a rien en propre : tout est déjà dans les
			// sections globales, qu'il hérite intégralement.
			self.projects.push(ProjectConfig {
				id: "principal".into(),
				main_repo: self.general.main_repo.clone(),
				..Default::default()
			});
		}

		let known = self.projects.iter().any(|project| project.id == self.active_project);
		if !known {
			self.active_project = self.projects[0].id.clone();
		}
	}

	/// Ajoute un projet, ou remplace celui qui porte le même identifiant.
	///
	/// Un projet sans dépôt ne peut venir que d'`ensure_projects` : c'est la
	/// place réservée d'une installation neuve, que rien n'a encore remplie
	/// (`project_save` refuse un dépôt vide). Le premier vrai projet la prend
	/// au lieu de s'y ajouter — sans quoi une installation neuve montrait,
	/// à côté du projet qu'on venait de créer, un « principal » que personne
	/// n'avait demandé et qui ne menait nulle part.
	///
	/// Le projet historique d'une ancienne configuration a, lui, un dépôt :
	/// celui du global. Il reste.
	pub fn upsert_project(&mut self, saved: ProjectConfig) {
		if let Some(existing) = self.projects.iter_mut().find(|entry| entry.id == saved.id) {
			*existing = saved;
			return;
		}
		let placeholders: Vec<String> = self
			.projects
			.iter()
			.filter(|entry| entry.main_repo.trim().is_empty())
			.map(|entry| entry.id.clone())
			.collect();
		self.projects.retain(|entry| !entry.main_repo.trim().is_empty());
		if placeholders.contains(&self.active_project) || self.projects.is_empty() {
			self.active_project = saved.id.clone();
		}
		self.projects.push(saved);
	}

	/// Configuration telle que la voient les écrans : le projet actif l'emporte.
	///
	/// Distincte de `load` à dessein. Tout ce qui écrit la configuration doit
	/// partir de `load`, sinon les réglages du projet actif finiraient recopiés
	/// dans les champs globaux à la première sauvegarde.
	pub fn active() -> Self {
		let mut cfg = Self::load();
		let Some(project) = cfg.active_project().cloned() else {
			return cfg;
		};
		let cloisonne = cfg.projects.len() > 1;
		project.merge_into(&mut cfg, cloisonne);
		cfg
	}

	/// Configuration vue depuis un dépôt, et non depuis l'écran affiché.
	///
	/// Ce qui tourne en arrière-plan — les missions, leurs exécutants — appartient
	/// à un projet précis, celui de son dépôt. Le résoudre avec `active()` le
	/// faisait dépendre de l'onglet ouvert : une mission lancée pendant qu'on
	/// regardait un autre produit héritait des rôles du voisin, donc de ses
	/// commandes d'équipe — ou d'aucune, quand ce voisin n'en déclare pas.
	///
	/// Dépôt inconnu : on retombe sur le projet actif, faute de mieux.
	pub fn for_repo(repo: &str) -> Self {
		if repo.trim().is_empty() {
			return Self::active();
		}
		let mut cfg = Self::load();
		let Some(project) = cfg.project_of_repo(repo).cloned() else {
			return Self::active();
		};
		let cloisonne = cfg.projects.len() > 1;
		project.merge_into(&mut cfg, cloisonne);
		cfg
	}

	/// Le projet déclaré pour un dépôt, à l'écriture du chemin près : sous
	/// Windows, le même dossier arrive en `D:\x` ou `D:/x` selon sa source, et
	/// une comparaison exacte retombait en silence sur le projet affiché.
	fn project_of_repo(&self, repo: &str) -> Option<&ProjectConfig> {
		let repo = crate::platform::path_key(repo);
		self.projects
			.iter()
			.find(|project| crate::platform::path_key(&inherit(&project.main_repo, &self.general.main_repo)) == repo)
	}

	/// Projet actif, tel que déclaré.
	pub fn active_project(&self) -> Option<&ProjectConfig> {
		self.projects.iter().find(|project| project.id == self.active_project)
	}

	pub fn save(&self) -> anyhow::Result<()> {
		std::fs::create_dir_all(config_dir())?;
		let raw = toml::to_string_pretty(self)?;
		let path = config_path();
		// Le fichier contient des secrets : lisible par le seul propriétaire, et
		// dès sa création — écrire puis restreindre laissait, à la première
		// sauvegarde, une fenêtre où il était lisible de tous selon l'umask.
		#[cfg(unix)]
		{
			use std::io::Write;
			use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
			let mut file = std::fs::OpenOptions::new()
				.write(true)
				.create(true)
				.truncate(true)
				.mode(0o600)
				.open(&path)?;
			// `mode` ne s'applique qu'à la création : un fichier plus ancien,
			// posé à la main, est resserré ici.
			let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
			file.write_all(raw.as_bytes())?;
		}
		#[cfg(not(unix))]
		std::fs::write(&path, raw)?;
		Ok(())
	}
}

/// Vue expurgée envoyée au front : jamais de secret en clair dans le webview,
/// seulement l'information « cette intégration est configurée ou non ».
/// Camel case ici (contrat avec le webview) là où le TOML reste en snake_case
/// pour rester agréable à éditer à la main.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
	/// Projets déclarés et celui qui est actif : la sidebar s'en sert pour
	/// basculer, les écrans pour savoir ce qu'ils ont le droit d'afficher.
	pub projects: Vec<ProjectView>,
	pub active_project: String,
	/// Les réglages globaux tels qu'ils sont écrits, sans projet par-dessus.
	///
	/// L'écran de réglages n'avait que les valeurs résolues : impossible d'y
	/// distinguer ce qui vient du global de ce que le projet déclare, et
	/// enregistrer recopiait donc l'un dans l'autre.
	pub global: ProjectDeclared,
	pub projects_root: String,
	pub main_repo: String,
	pub editor: String,
	pub github_repo: String,
	pub linear_team_key: String,
	pub linear_team_id: String,
	pub trigger_project_ref: String,
	/// Environnements Trigger.dev configurés — un onglet chacun dans Delivery.
	pub trigger_environments: Vec<TriggerEnvironmentView>,
	pub railway_project_id: String,
	pub config_path: String,
	pub secrets: Vec<SecretStatus>,
	/// Colonnes, branches et sujets : ce qui décrit la façon de travailler.
	pub workflow: WorkflowConfig,
	/// Comment lire les changements en vol — le brief du produit, surtout.
	pub impact: ImpactConfig,
	/// Ce qu'un agent reçoit en plus de la consigne, au lancement.
	pub brief: BriefConfig,
	/// Ce que ce projet veut voir rester vrai.
	pub properties: Vec<PropertyConfig>,
	/// Ses commandes maison.
	pub commands: Vec<CommandConfig>,
	/// Ce que la Permanence surveille, et ce qu'elle s'autorise.
	pub permanence: PermanenceConfig,
	/// Ce qu'une mission a le droit de coûter.
	pub missions: MissionsConfig,
	/// Où un agent a le droit de tourner.
	pub sandbox: SandboxConfig,
	/// Catalogue des rôles confiés aux exécutants.
	pub roles: Vec<RoleConfig>,
	/// Moteurs d'agents déclarés : le programme qui fait tourner un agent.
	pub engines: Vec<EngineConfig>,
	/// Les comptes installés sur ce poste, celui du poste en tête.
	pub accounts: Vec<AccountConfig>,
	/// Celui sous lequel le projet actif travaille, héritage appliqué.
	pub account: String,
}

/// Un projet vu par l'interface.
///
/// Les booléens `has*` disent ce qui est réellement joignable : un écran sans
/// intégration derrière ne doit pas s'afficher vide, il doit s'effacer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
	pub id: String,
	pub name: String,
	pub color: String,
	pub main_repo: String,
	pub github_repo: String,
	pub linear_team_key: String,
	pub railway_project_id: String,
	pub trigger_project_ref: String,
	/// Le compte sous lequel il travaille, héritage appliqué. Deux projets côte
	/// à côte dans la liste doivent pouvoir se distinguer d'un coup d'œil quand
	/// ils ne sont pas la même personne.
	pub account: String,
	/// Clés que ce projet définit lui-même ; les autres sont héritées.
	pub overrides: Vec<String>,
	/// Ce que le projet déclare, sans rien de ce qu'il hérite.
	///
	/// L'écran de réglages se remplissait avec la configuration résolue : sur un
	/// second projet, il affichait donc les valeurs du premier, et les
	/// enregistrer les y recopiait en dur. Ce qu'on édite doit être ce que le
	/// projet dit de lui-même, pas ce qu'il emprunte.
	pub declared: ProjectDeclared,
	pub has_github: bool,
	pub has_linear: bool,
}

/// Les réglages qu'un projet déclare lui-même, tels qu'ils sont écrits.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeclared {
	pub projects_root: String,
	pub main_repo: String,
	pub editor: String,
	pub github_repo: String,
	pub linear_team_key: String,
	pub linear_team_id: String,
	pub trigger_project_ref: String,
	pub railway_project_id: String,
	/// Ce que fait ce produit, tel que ce projet le déclare.
	pub impact_brief: String,
	/// Chemin du projet GitLab, et l'instance qui le sert.
	pub gitlab_project: String,
	pub gitlab_host: String,
	/// Le compte sous lequel ce projet fait travailler ses agents.
	pub account: String,
}

/// Un environnement vu par l'interface : jamais son jeton, seulement le fait
/// qu'il en ait un.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerEnvironmentView {
	pub name: String,
	pub project_ref: String,
	/// Vrai quand l'entrée vient de `trigger.token` et non de la liste : elle
	/// se modifie par le champ « Trigger.dev » des jetons, pas par la liste.
	pub from_default_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
	pub key: String,
	pub label: String,
	pub configured: bool,
	pub hint: String,
}

impl Config {
	pub fn view(&self) -> ConfigView {
		let secret = |key: &str, label: &str, value: &str, hint: &str| SecretStatus {
			key: key.into(),
			label: label.into(),
			configured: !value.trim().is_empty(),
			hint: hint.into(),
		};

		ConfigView {
			// Le global se relit sur le disque : `self` porte déjà le projet actif
			// fusionné, et n'en distingue plus l'origine.
			global: {
				let brut = Self::load();
				ProjectDeclared {
					projects_root: brut.general.projects_root.clone(),
					main_repo: brut.general.main_repo.clone(),
					editor: brut.general.editor.clone(),
					github_repo: brut.github.repo.clone(),
					linear_team_key: brut.linear.team_key.clone(),
					linear_team_id: brut.linear.team_id.clone(),
					trigger_project_ref: brut.trigger.project_ref.clone(),
					railway_project_id: brut.railway.project_id.clone(),
					impact_brief: brut.impact.brief.clone(),
					gitlab_project: brut.gitlab.project.clone(),
					gitlab_host: brut.gitlab.host.clone(),
					account: brut.account.clone(),
				}
			},
			projects: self
				.projects
				.iter()
				.map(|project| {
					// Ce que vaut le projet une fois l'héritage appliqué : c'est
					// ce que l'utilisateur verra en basculant dessus.
					let mut resolved = self.clone();
					project.merge_into(&mut resolved, self.projects.len() > 1);
					ProjectView {
						id: project.id.clone(),
						name: project.display_name(),
						color: project.color.clone(),
						main_repo: resolved.general.main_repo.clone(),
						github_repo: resolved.github.repo.clone(),
						linear_team_key: resolved.linear.team_key.clone(),
						railway_project_id: resolved.railway.project_id.clone(),
						trigger_project_ref: resolved.trigger.project_ref.clone(),
						overrides: project.overrides(),
						declared: ProjectDeclared {
							projects_root: project.projects_root.clone(),
							main_repo: project.main_repo.clone(),
							editor: project.editor.clone(),
							github_repo: project.github.repo.clone(),
							linear_team_key: project.linear.team_key.clone(),
							linear_team_id: project.linear.team_id.clone(),
							trigger_project_ref: project.trigger.project_ref.clone(),
							railway_project_id: project.railway.project_id.clone(),
							impact_brief: project.impact.brief.clone(),
							gitlab_project: project.gitlab.project.clone(),
							gitlab_host: project.gitlab.host.clone(),
							account: project.account.clone(),
						},
						account: account_for(&resolved).id,
						// Un dépôt sans `owner/repo` n'a pas de PR à suivre : un
						// jeton ne suffit pas à rendre l'écran pertinent.
						has_github: !resolved.github.repo.trim().is_empty(),
						has_linear: !resolved.linear.token.trim().is_empty()
							&& !resolved.linear.team_key.trim().is_empty(),
					}
				})
				.collect(),
			active_project: self.active_project.clone(),
			projects_root: self.general.projects_root.clone(),
			main_repo: self.general.main_repo.clone(),
			editor: self.general.editor.clone(),
			github_repo: self.github.repo.clone(),
			linear_team_key: self.linear.team_key.clone(),
			linear_team_id: self.linear.team_id.clone(),
			trigger_project_ref: self.trigger.project_ref.clone(),
			trigger_environments: self.trigger.views(),
			railway_project_id: self.railway.project_id.clone(),
			config_path: config_path().to_string_lossy().to_string(),
			workflow: self.workflow.clone(),
			impact: self.impact.clone(),
			brief: self.brief.clone(),
			properties: self.properties.clone(),
			commands: self.commands.clone(),
			permanence: self.permanence.clone(),
			missions: self.missions.clone(),
			sandbox: self.sandbox.clone(),
			roles: if self.roles.is_empty() {
				default_roles()
			} else {
				self.roles.clone()
			},
			engines: if self.engines.is_empty() {
				default_engines()
			} else {
				self.engines.clone()
			},
			accounts: accounts(self),
			account: account_for(self).id,
			secrets: vec![
				secret(
					"github",
					"GitHub",
					&self.github.token,
					&crate::i18n::t("config.secretHint.github"),
				),
				secret(
					"linear",
					"Linear",
					&self.linear.token,
					&crate::i18n::t("config.secretHint.linear"),
				),
				secret(
					"gitlab",
					"GitLab",
					&self.gitlab.token,
					&crate::i18n::t("config.secretHint.gitlab"),
				),
				secret(
					"trigger",
					"Trigger.dev",
					&self.trigger.token,
					&crate::i18n::t("config.secretHint.trigger"),
				),
				secret(
					"railway",
					"Railway",
					&self.railway.token,
					&crate::i18n::t("config.secretHint.railway"),
				),
				secret(
					"betterstack",
					"Better Stack",
					&self.betterstack.token,
					&crate::i18n::t("config.secretHint.betterstack"),
				),
				secret(
					"stripe",
					"Stripe",
					&self.stripe.token,
					&crate::i18n::t("config.secretHint.stripe"),
				),
				secret(
					"sandbox_oauth_token",
					&crate::i18n::t("config.secretLabel.sandboxOauthToken"),
					&self.sandbox.oauth_token,
					&crate::i18n::t("config.secretHint.sandboxOauthToken"),
				),
			],
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn base() -> Config {
		let mut cfg = Config::default();
		cfg.general.main_repo = "/repos/monorepo".into();
		cfg.general.editor = "zed".into();
		cfg.github.repo = "acme/monorepo".into();
		cfg.github.token = "gh-entreprise".into();
		cfg.linear.token = "lin-entreprise".into();
		cfg.linear.team_key = "NW".into();
		cfg
	}

	#[test]
	fn le_projet_d_un_depot_ne_depend_pas_de_l_ecriture_du_chemin() {
		let mut cfg = base();
		let projet = |id: &str, main_repo: &str| ProjectConfig {
			id: id.into(),
			main_repo: main_repo.into(),
			..Default::default()
		};
		cfg.projects = vec![projet("herite", ""), projet("autre", "/repos/autre")];
		let id = |repo: &str| cfg.project_of_repo(repo).map(|project| project.id.as_str());

		assert_eq!(id("/repos/autre/"), Some("autre"));
		assert_eq!(id(" /repos/autre "), Some("autre"));
		// Sans dépôt à lui, un projet porte celui de la configuration globale.
		assert_eq!(id("/repos/monorepo"), Some("herite"));
		assert_eq!(id("/repos/inconnu"), None);
	}

	#[cfg(windows)]
	#[test]
	fn sous_windows_toutes_les_formes_d_un_chemin_designent_le_meme_projet() {
		let mut cfg = base();
		cfg.projects = vec![ProjectConfig {
			main_repo: "D:/repos/autre".into(),
			..Default::default()
		}];
		for repo in [r"D:\repos\autre", r"D:\repos\Autre\", r"\\?\D:\repos\autre"] {
			assert!(cfg.project_of_repo(repo).is_some(), "{repo}");
		}
	}

	/// `SandboxConfig` sérialise en camelCase, à la différence des autres
	/// structs de secrets (voir `SECRET_PATHS` côté frontend) : un patch qui
	/// enverrait `oauth_token` s'écrirait dans le vide sans que rien ne le
	/// signale — exactement ce qui s'est produit avant ce test.
	#[test]
	fn le_jeton_du_compte_isole_se_range_en_camelcase() {
		let value = serde_json::to_value(SandboxConfig::default()).unwrap();
		assert!(value.get("oauthToken").is_some());
		assert!(value.get("oauth_token").is_none());

		let patch = serde_json::json!({ "oauthToken": "sk-ant-oat01-test" });
		let sandbox: SandboxConfig = serde_json::from_value(patch).unwrap();
		assert_eq!(sandbox.oauth_token, "sk-ant-oat01-test");
	}

	/// Une configuration qui déclare des comptes se réécrit sur le disque.
	///
	/// Le format TOML veut ses valeurs avant ses tables : un champ simple glissé
	/// après une liste de tables fait échouer l'écriture — et comme la
	/// sauvegarde est le seul chemin vers le fichier, tout l'écran des réglages
	/// serait devenu incapable d'enregistrer quoi que ce soit.
	#[test]
	fn une_config_avec_comptes_se_reecrit() {
		let mut cfg = base();
		cfg.accounts = vec![AccountConfig {
			id: "travail".into(),
			label: "Compte entreprise".into(),
			dir: "~/.claude-travail".into(),
		}];
		cfg.account = "travail".into();
		cfg.projects = vec![ProjectConfig {
			id: "produit".into(),
			account: "travail".into(),
			..ProjectConfig::default()
		}];

		let raw = toml::to_string_pretty(&cfg).expect("la config doit se sérialiser");
		let relu: Config = toml::from_str(&raw).expect("et se relire");
		assert_eq!(relu.account, "travail");
		assert_eq!(relu.accounts.len(), 1);
		assert_eq!(relu.projects[0].account, "travail");
	}

	/// Le compte d'un projet l'emporte sur celui du poste, et le poste sert de
	/// repli — c'est ce qui laisse une installation d'avant les comptes intacte.
	#[test]
	fn le_compte_suit_le_projet() {
		let mut cfg = base();
		cfg.accounts = vec![AccountConfig {
			id: "travail".into(),
			label: "Compte entreprise".into(),
			dir: "~/.claude-travail".into(),
		}];
		let projet = ProjectConfig {
			id: "produit".into(),
			account: "travail".into(),
			..ProjectConfig::default()
		};

		let mut resolu = cfg.clone();
		projet.merge_into(&mut resolu, false);
		assert_eq!(account_for(&resolu).id, "travail");
		assert_eq!(
			account_env(&resolu).first().map(|(name, _)| name.as_str()),
			Some("CLAUDE_CONFIG_DIR"),
		);

		// Un projet muet retombe sur le poste, qui ne pose aucune variable.
		let mut resolu = cfg.clone();
		ProjectConfig::default().merge_into(&mut resolu, false);
		assert_eq!(account_for(&resolu).id, HOME_ACCOUNT);
		assert!(account_env(&resolu).is_empty());

		// Un compte retiré du fichier ne bloque pas le projet qui le désignait.
		let mut orphelin = base();
		orphelin.account = "disparu".into();
		assert_eq!(account_for(&orphelin).id, HOME_ACCOUNT);
	}

	/// Le flux de travail traverse l'IPC sous les noms que l'écran lit.
	///
	/// Sorti en `snake_case`, le webview n'y trouvait rien : les champs
	/// s'affichaient vides et enregistrer effaçait des colonnes qu'on croyait
	/// relire. Les anciens fichiers, eux, restent lisibles.
	#[test]
	fn le_flux_de_travail_sort_en_camel_case() {
		let raw = serde_json::to_value(WorkflowConfig::default()).unwrap();
		for key in ["doneStates", "baseBranches", "prCommand"] {
			assert!(raw.get(key).is_some(), "{key} manque dans la vue");
		}

		let ancien: WorkflowConfig = serde_json::from_str(r#"{"done_states":["Done"],"pr_command":"/pr"}"#).unwrap();
		assert_eq!(ancien.done_states, vec!["Done"]);
		assert_eq!(ancien.pr_command, "/pr");
	}

	/// Une config écrite avant le retrait des écrans d'équipe, d'observabilité
	/// et de livraison se lit encore, sections disparues comprises.
	///
	/// `load` retombe sur une configuration vide quand le fichier ne se lit
	/// pas : une section inconnue qui ferait échouer la lecture effacerait
	/// d'un coup tous les réglages d'une installation existante.
	#[test]
	fn une_config_aux_sections_retirees_se_lit_encore() {
		let raw = r#"
			[general]
			main_repo = "/repos/monorepo"

			[linear]
			token = "lin-entreprise"
			team_key = "NW"

			[team]
			linear_team_id = "eq-global"
			[[team.members]]
			name = "Alice"
			linear_id = "m-1"
			github = "alice"
			sentry_emails = ["alice@example.com"]

			[workflow]
			active_states = ["In Progress"]
			review_states = ["In Review"]
			done_states = ["Done"]
			blocked_state = "Blocked"
			daily_weekdays = [1, 3, 5]
			[[workflow.themes]]
			label = "Facturation"
			phrase = "la facturation"
			keywords = ["facture"]

			[sentry]
			token = "sntrys_x"
			org = "acme"
			projects = ["web"]

			[trigger]
			token = "tr_prod_x"
			project_ref = "proj_x"
			[[trigger.environments]]
			name = "Production"
			token = "tr_prod_x"
			project_ref = "proj_x"

			[railway]
			token = "rw"
			project_id = "p-1"

			[betterstack]
			token = "bs"
			telemetry_token = "bt"
			clickhouse_host = "eu.clickhouse"

			[stripe]
			token = "rk_live_x"

			[[projects]]
			id = "perso"
			main_repo = "/repos/perso"
			solo = true
			[projects.team]
			linear_team_id = "eq-perso"
			[projects.sentry]
			org = "moi"
			[projects.trigger]
			project_ref = "proj_perso"
			[projects.railway]
			project_id = "p-2"
			[projects.betterstack]
			token = "bs-perso"
			[projects.stripe]
			token = "rk_perso"
		"#;
		let mut config: Config = toml::from_str(raw).expect("une ancienne config se lit encore");
		config.adopt_legacy_team();

		assert_eq!(config.general.main_repo, "/repos/monorepo");
		assert_eq!(config.linear.team_key, "NW");
		assert_eq!(config.workflow.done_states, vec!["Done"]);
		// L'identifiant d'équipe Linear survit au départ de `[team]`.
		assert_eq!(config.linear.team_id, "eq-global");
		assert_eq!(config.projects.len(), 1);
		assert_eq!(config.projects[0].linear.team_id, "eq-perso");
		// Le jeton Better Stack sert encore au serveur MCP des agents isolés :
		// il survit, quand ses voisins Telemetry et ClickHouse sont ignorés.
		assert_eq!(config.betterstack.token, "bs");
		assert_eq!(config.projects[0].betterstack.token, "bs-perso");

		// Et la section ne se réécrit pas : elle disparaît à la sauvegarde.
		let rewritten = toml::to_string(&config).unwrap();
		assert!(!rewritten.contains("[team]"), "{rewritten}");
		assert!(!rewritten.contains("linear_team_id"), "{rewritten}");
		assert!(rewritten.contains("team_id = \"eq-global\""), "{rewritten}");
		assert!(!rewritten.contains("[sentry]"), "{rewritten}");
		assert!(!rewritten.contains("telemetry_token"), "{rewritten}");
	}

	/// Un identifiant déjà déclaré sous `[linear]` prime sur l'ancien.
	#[test]
	fn l_identifiant_linear_declare_prime_sur_l_ancien() {
		let mut config: Config = toml::from_str(
			r#"
			[linear]
			team_id = "eq-neuf"
			[team]
			linear_team_id = "eq-ancien"
			"#,
		)
		.unwrap();
		config.adopt_legacy_team();
		assert_eq!(config.linear.team_id, "eq-neuf");
	}

	/// Une config d'avant le multi-projets doit continuer de fonctionner telle
	/// quelle, sans migration ni perte de réglage.
	#[test]
	fn projet_synthetise_quand_aucun_declare() {
		let mut cfg = base();
		cfg.ensure_projects();
		assert_eq!(cfg.projects.len(), 1);
		assert_eq!(cfg.active_project, "principal");
		assert_eq!(cfg.projects[0].main_repo, "/repos/monorepo");
		// Le projet historique n'a rien en propre : tout reste hérité.
		assert!(cfg.projects[0].github.token.is_empty());
	}

	/// Installation neuve : le premier projet ajouté prend la place réservée
	/// au lieu de s'ajouter à côté d'un « principal » sans dépôt.
	#[test]
	fn le_premier_projet_remplace_la_place_reservee() {
		let mut cfg = Config::default();
		cfg.ensure_projects();
		assert_eq!(cfg.projects.len(), 1);
		assert!(cfg.projects[0].main_repo.is_empty());

		cfg.upsert_project(ProjectConfig {
			id: "demo-shop".into(),
			main_repo: "/repos/demo-shop".into(),
			..Default::default()
		});
		assert_eq!(cfg.projects.len(), 1);
		assert_eq!(cfg.projects[0].id, "demo-shop");
		assert_eq!(cfg.active_project, "demo-shop");

		// Le suivant s'ajoute, et ne change pas le projet actif.
		cfg.upsert_project(ProjectConfig {
			id: "blog".into(),
			main_repo: "/repos/blog".into(),
			..Default::default()
		});
		assert_eq!(cfg.projects.len(), 2);
		assert_eq!(cfg.active_project, "demo-shop");
	}

	/// Le projet historique d'une ancienne configuration a un dépôt : un nouveau
	/// projet s'ajoute à côté, sans le remplacer.
	#[test]
	fn le_projet_historique_reste_a_l_ajout_d_un_projet() {
		let mut cfg = base();
		cfg.ensure_projects();
		cfg.upsert_project(ProjectConfig {
			id: "blog".into(),
			main_repo: "/repos/blog".into(),
			..Default::default()
		});
		assert_eq!(cfg.projects.len(), 2);
		assert_eq!(cfg.projects[0].id, "principal");
		assert_eq!(cfg.active_project, "principal");
	}

	/// Un projet actif inconnu ne doit pas laisser le cockpit sans projet.
	#[test]
	fn projet_actif_inconnu_retombe_sur_le_premier() {
		let mut cfg = base();
		cfg.projects = vec![ProjectConfig {
			id: "monorepo".into(),
			main_repo: "/repos/monorepo".into(),
			..Default::default()
		}];
		cfg.active_project = "disparu".into();
		cfg.ensure_projects();
		assert_eq!(cfg.active_project, "monorepo");
	}

	/// Le cœur du multi-projets : ce que le projet déclare l'emporte, le reste
	/// est hérité — jetons compris, sans quoi un projet perso serait condamné
	/// aux comptes de l'entreprise.
	#[test]
	fn le_projet_surcharge_ce_quil_declare_et_herite_du_reste() {
		let mut cfg = base();
		let perso = ProjectConfig {
			id: "perso".into(),
			main_repo: "/repos/perso".into(),
			github: GithubConfig {
				repo: "moi/perso".into(),
				token: "gh-perso".into(),
				..Default::default()
			},
			..Default::default()
		};
		perso.merge_into(&mut cfg, false);

		assert_eq!(cfg.general.main_repo, "/repos/perso");
		assert_eq!(cfg.github.repo, "moi/perso");
		assert_eq!(cfg.github.token, "gh-perso");
		// Non déclarés par le projet : les valeurs globales tiennent.
		assert_eq!(cfg.linear.token, "lin-entreprise");
		assert_eq!(cfg.linear.team_key, "NW");
		assert_eq!(cfg.general.editor, "zed");
	}

	/// Les environnements Trigger d'un projet remplacent ceux du global : les
	/// mélanger interrogerait les déploiements d'un autre produit.
	#[test]
	fn environnements_trigger_remplacent_au_lieu_de_sadditionner() {
		let mut cfg = base();
		cfg.trigger.environments = vec![TriggerEnvironment {
			name: "Production".into(),
			token: "tr_prod_exemple".into(),
			project_ref: "proj_exemple".into(),
		}];
		let perso = ProjectConfig {
			id: "perso".into(),
			trigger: TriggerConfig {
				environments: vec![TriggerEnvironment {
					name: "Production".into(),
					token: "tr_prod_perso".into(),
					project_ref: "proj_perso".into(),
				}],
				..Default::default()
			},
			..Default::default()
		};
		perso.merge_into(&mut cfg, false);
		assert_eq!(cfg.trigger.environments.len(), 1);
		assert_eq!(cfg.trigger.environments[0].token, "tr_prod_perso");
	}

	/// L'écran Réglages doit pouvoir distinguer « propre au projet » de « hérité ».
	/// Le repli générique doit marcher dans n'importe quel dépôt : c'est lui qui
	/// tient la promesse « rien n'est réservé à une équipe ».
	#[test]
	fn sans_commande_declaree_on_retombe_sur_git() {
		let workflow = WorkflowConfig::default();
		let (commande, par_agent) = workflow.worktree_creation("fix/x", "/tmp/fix-x");
		assert!(commande.contains("git worktree add '/tmp/fix-x' 'fix/x'"), "{commande}");
		assert!(
			commande.contains("git worktree add -b 'fix/x' '/tmp/fix-x'"),
			"{commande}"
		);
		assert!(!par_agent, "git se lance dans un shell, pas dans un agent");

		let (commande, _) = workflow.worktree_removal("fix/x", "/tmp/fix-x");
		assert_eq!(commande, "git worktree remove --force '/tmp/fix-x'");
	}

	/// Le cas d'un premier lancement, joué pour de vrai : « Ouvrir une branche »
	/// ne donne pas de chemin, et la branche n'existe pas encore. Le worktree
	/// doit naître à côté du dépôt, sur la branche demandée — pas dans le dépôt
	/// sur une branche au nom tronqué.
	#[test]
	fn sans_chemin_ni_branche_le_repli_cree_les_deux_a_cote_du_depot() {
		let base = std::env::temp_dir().join(format!("cockpit-worktree-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&base);
		let root = base.as_path();
		let repo = root.join("shop");
		std::fs::create_dir_all(&repo).unwrap();
		let git = |args: &[&str]| {
			let status = std::process::Command::new("git")
				.args(args)
				.current_dir(&repo)
				.status()
				.expect("git");
			assert!(status.success(), "git {args:?}");
		};
		git(&["init", "-q", "-b", "main"]);
		git(&[
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"base",
		]);

		let workflow = WorkflowConfig::default();
		let (commande, _) = workflow.worktree_creation("feat/currency-selector", "");
		let out = crate::platform::shell(&commande)
			.current_dir(&repo)
			.output()
			.expect("shell");
		assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

		let tree = root.join("shop-feat-currency-selector");
		assert!(
			tree.join(".git").exists(),
			"worktree attendu à côté du dépôt : {}",
			tree.display()
		);
		assert!(!repo.join("feat").exists(), "rien ne doit naître dans le dépôt");
		let head = std::process::Command::new("git")
			.args(["rev-parse", "--abbrev-ref", "HEAD"])
			.current_dir(&tree)
			.output()
			.unwrap();
		assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feat/currency-selector");

		// Une branche qui existe déjà se sort telle quelle, sans `-b` qui échouerait.
		git(&["branch", "fix/existante"]);
		let (commande, _) = workflow.worktree_creation("fix/existante", "");
		let out = crate::platform::shell(&commande)
			.current_dir(&repo)
			.output()
			.expect("shell");
		assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
		assert!(root.join("shop-fix-existante").join(".git").exists());
		let _ = std::fs::remove_dir_all(&base);
	}

	#[test]
	fn une_commande_du_depot_passe_par_un_agent() {
		let workflow = WorkflowConfig {
			worktree_command: "/create-worktree {branch}".into(),
			..Default::default()
		};
		let (commande, par_agent) = workflow.worktree_creation("fix/x", "/tmp/fix-x");
		assert_eq!(commande, "/create-worktree fix/x");
		assert!(par_agent, "le `/` désigne une commande du dépôt");
	}

	#[test]
	fn les_substitutions_couvrent_branche_chemin_et_dossier() {
		let workflow = WorkflowConfig {
			worktree_remove_command: "outil rm {folder} --branch {branch} --at {path}".into(),
			..Default::default()
		};
		let (commande, par_agent) = workflow.worktree_removal("fix/x", "/Users/moi/Sites/produit-fix-x");
		assert_eq!(
			commande,
			"outil rm produit-fix-x --branch fix/x --at /Users/moi/Sites/produit-fix-x"
		);
		assert!(!par_agent);
	}

	/// Une branche est un nom que git accepte avec `;`, `$` ou `|` : jouée par
	/// un shell, elle ne doit jamais devenir une commande.
	#[test]
	fn une_branche_hostile_ne_devient_pas_une_commande() {
		let workflow = WorkflowConfig {
			worktree_command: "outil add {branch} {path}".into(),
			..Default::default()
		};
		for hostile in ["x;touch /tmp/pwn", "$(id)", "a`id`", "x|sh", "-o", "a'b"] {
			let (commande, par_agent) = workflow.worktree_creation(hostile, "/tmp/x");
			assert!(!par_agent);
			assert!(commande.starts_with("echo "), "{hostile} : {commande}");
			assert!(commande.ends_with("exit 1"));
		}
		// Un nom ordinaire passe inchangé.
		let (commande, _) = workflow.worktree_creation("feat/ma-branche_2", "/tmp/x");
		assert_eq!(commande, "outil add feat/ma-branche_2 /tmp/x");
	}

	/// Sans chemin connu — une branche jamais sortie — `{folder}` doit tout de
	/// même rendre quelque chose d'utilisable comme nom de dossier.
	#[test]
	fn sans_chemin_le_dossier_se_derive_de_la_branche() {
		let workflow = WorkflowConfig {
			worktree_command: "creer {folder}".into(),
			..Default::default()
		};
		let (commande, _) = workflow.worktree_creation("fix/ecran-invalide", "");
		assert_eq!(commande, "creer fix-ecran-invalide");
	}

	#[test]
	fn overrides_ne_liste_que_le_declare() {
		let perso = ProjectConfig {
			id: "perso".into(),
			main_repo: "/repos/perso".into(),
			github: GithubConfig {
				token: "gh-perso".into(),
				..Default::default()
			},
			..Default::default()
		};
		let keys = perso.overrides();
		assert!(keys.contains(&"main_repo".to_string()));
		assert!(keys.contains(&"github".to_string()));
		assert!(!keys.contains(&"linear".to_string()));
	}
}

#[cfg(test)]
mod workflow_tests {
	use super::*;

	/// Une configuration vierge doit rester utilisable par n'importe quelle
	/// équipe : rien de spécifique à un projet ne doit y réapparaître.
	#[test]
	fn defauts_vides() {
		let workflow = WorkflowConfig::default();
		assert!(workflow.base_branches.is_empty());
		assert!(workflow.done_states.is_empty());
	}

	/// Une installation neuve ne reçoit ni les colonnes ni les commandes d'une
	/// autre équipe.
	#[test]
	fn installation_neuve_reste_vierge() {
		let mut config = Config::default();
		config.seed_workflow(false);
		assert!(config.workflow.done_states.is_empty());
		assert!(config.workflow.worktree_command.is_empty());
	}

	/// L'exécutable ne porte rien de l'équipe qui l'a écrit.
	///
	/// C'est l'invariant de la marque blanche, et il se vérifie ici plutôt qu'à
	/// la relecture : aucune configuration, quelle qu'elle soit, ne doit voir
	/// apparaître des colonnes ou un identifiant d'équipe qu'elle n'a pas
	/// déclarés.
	#[test]
	fn rien_de_specifique_ne_survit_dans_le_binaire() {
		let mut config = Config::default();
		config.seed_workflow(true);

		assert!(config.linear.team_id.is_empty(), "aucune équipe par défaut");
		assert!(config.workflow.done_states.is_empty(), "aucune colonne imposée");

		// Seules les branches de base, universelles, sont complétées.
		assert!(config.workflow.base_branches.contains(&"main".to_string()));
	}

	/// Un réglage déjà écrit n'est jamais remplacé.
	#[test]
	fn la_configuration_existante_prime() {
		let mut custom = Config::default();
		custom.workflow.base_branches = vec!["trunk".into()];
		custom.seed_workflow(true);
		assert_eq!(custom.workflow.base_branches, vec!["trunk".to_string()]);
	}
}

#[cfg(test)]
mod role_serde_tests {
	use super::*;

	/// Ce que l'interface reçoit doit porter les noms qu'elle lit.
	///
	/// `permission_mode` est le seul champ du rôle en deux mots : sorti en
	/// snake_case, le webview n'y trouvait rien et réenregistrait le rôle avec un
	/// mode vide, que le CLI refusait ensuite de démarrer. Rien ne le signalait
	/// avant l'échec du lancement.
	#[test]
	fn le_role_sort_dans_la_langue_de_l_interface() {
		let role = RoleConfig {
			id: "backend".into(),
			permission_mode: "bypassPermissions".into(),
			..Default::default()
		};
		let json = serde_json::to_string(&role).expect("sérialisation");
		assert!(
			json.contains("\"permissionMode\":\"bypassPermissions\""),
			"le mode doit sortir en camelCase : {json}"
		);
	}

	/// Les fichiers déjà écrits restent lisibles : une correction de nom ne doit
	/// pas vider la configuration de ceux qui l'avaient déjà remplie.
	#[test]
	fn les_anciens_fichiers_restent_lus() {
		let ancien = r#"{ "id": "qa", "permission_mode": "acceptEdits" }"#;
		let role: RoleConfig = serde_json::from_str(ancien).expect("désérialisation");
		assert_eq!(role.permission_mode, "acceptEdits");
	}
}

#[cfg(test)]
mod cloisonnement_tests {
	use super::*;

	/// Deux projets ne partagent pas leurs cibles.
	///
	/// Un second projet qui ne déclare pas son équipe Linear n'emprunte pas
	/// celle du premier : on lisait les tickets d'un produit sur l'écran d'un
	/// autre, sans que rien ne le signale. Les jetons, eux, restent partagés —
	/// un même accès sert plusieurs dépôts.
	#[test]
	fn un_second_projet_n_herite_pas_des_cibles() {
		let mut global = Config::default();
		global.github.repo = "acme/monorepo".into();
		global.github.token = "jeton-partagé".into();
		global.linear.team_key = "DEMO".into();
		global.linear.token = "linear-partagé".into();

		let second = ProjectConfig {
			id: "outil".into(),
			main_repo: "/Users/moi/Code/outil".into(),
			..Default::default()
		};

		let mut resolu = global.clone();
		second.merge_into(&mut resolu, true);

		assert_eq!(resolu.general.main_repo, "/Users/moi/Code/outil");
		assert_eq!(resolu.github.repo, "", "le dépôt du voisin ne s'emprunte pas");
		assert_eq!(resolu.linear.team_key, "", "ni son équipe");
		assert_eq!(resolu.github.token, "jeton-partagé", "l'accès, lui, se partage");
		assert_eq!(resolu.linear.token, "linear-partagé");
	}

	/// Tant qu'il n'y a qu'un projet, le global lui tient lieu de configuration :
	/// c'est ainsi que le cockpit se réglait avant d'en connaître plusieurs, et
	/// vider ces écrans casserait une installation qui marchait.
	#[test]
	fn un_projet_seul_herite_encore() {
		let mut global = Config::default();
		global.github.repo = "acme/monorepo".into();
		global.linear.team_key = "DEMO".into();

		let seul = ProjectConfig {
			id: "principal".into(),
			..Default::default()
		};
		let mut resolu = global.clone();
		seul.merge_into(&mut resolu, false);

		assert_eq!(resolu.github.repo, "acme/monorepo");
		assert_eq!(resolu.linear.team_key, "DEMO");
	}
}

#[cfg(test)]
mod migration_tests {
	use super::*;

	/// Cloisonner ne doit rien retirer à qui n'a rien demandé.
	///
	/// L'équipe Linear et les rôles se réglaient au niveau global avant que les
	/// projets n'existent. Le projet qui travaille sur le dépôt du global s'en
	/// servait : les lui retirer viderait ses options de ticket et son
	/// catalogue de rôles.
	#[test]
	fn le_projet_historique_garde_son_equipe() {
		let mut global = Config::default();
		global.general.main_repo = "/repos/monorepo".into();
		global.linear.team_id = "eq-1".into();

		let historique = ProjectConfig {
			id: "principal".into(),
			main_repo: "/repos/monorepo".into(),
			..Default::default()
		};

		// Ce que la migration recopie, avant tout cloisonnement.
		let mut projet = historique.clone();
		if projet.linear.team_id.is_empty() && !global.linear.team_id.is_empty() {
			projet.linear.team_id = global.linear.team_id.clone();
		}

		let mut resolu = global.clone();
		projet.merge_into(&mut resolu, true);
		assert_eq!(resolu.linear.team_id, "eq-1", "l'équipe suit le projet");

		// Sans migration, le cloisonnement l'aurait bien vidée.
		let mut sans = global.clone();
		historique.merge_into(&mut sans, true);
		assert!(sans.linear.team_id.is_empty(), "d'où la nécessité de migrer");
	}
}

#[cfg(test)]
mod permanence_tests {
	use super::*;

	fn at(heures: u32, minutes: u32) -> u32 {
		heures * 60 + minutes
	}

	/// Une installation neuve ne fait rien tant que personne ne l'a demandé.
	#[test]
	fn tout_est_eteint_au_depart() {
		let config = PermanenceConfig::default();
		assert!(!config.enabled, "désactivée par défaut");
		assert!(config.rules.is_empty(), "aucune règle livrée");
		assert!(config.powers.is_empty(), "liste blanche vide");
		assert!(!config.comment.enabled);
		assert!(config.live_rules().is_empty());
	}

	#[test]
	fn une_plage_vide_vaut_toujours() {
		let config = PermanenceConfig::default();
		assert!(config.open_at(at(3, 0)));
		assert!(config.open_at(at(14, 0)));
	}

	#[test]
	fn une_plage_ordinaire_s_ouvre_et_se_ferme() {
		let config = PermanenceConfig {
			hours: "08:00-19:00".into(),
			..Default::default()
		};
		assert!(!config.open_at(at(7, 59)));
		assert!(config.open_at(at(8, 0)));
		assert!(config.open_at(at(18, 59)));
		assert!(!config.open_at(at(19, 0)), "la borne haute est exclue");
	}

	/// Une plage qui passe minuit se lit comme telle : sans ça, `22:00-06:00`
	/// ne s'ouvrirait jamais et le service se tairait sans rien dire.
	#[test]
	fn une_plage_qui_passe_minuit_reste_ouverte_la_nuit() {
		let config = PermanenceConfig {
			hours: "22:00-06:00".into(),
			..Default::default()
		};
		assert!(config.open_at(at(23, 30)));
		assert!(config.open_at(at(2, 0)));
		assert!(!config.open_at(at(12, 0)));
	}

	/// Un réglage illisible ne doit pas éteindre le service en silence : on
	/// préfère un dispositif qui tourne et qu'on corrige à un dispositif muet.
	#[test]
	fn une_plage_illisible_ne_ferme_pas() {
		let config = PermanenceConfig {
			hours: "de huit heures à sept heures".into(),
			..Default::default()
		};
		assert!(config.open_at(at(4, 0)));
	}

	/// Une règle allumée sans oracle énonçable ne part pas : c'est la seule
	/// condition d'arrêt d'un agent qui n'en a aucune.
	#[test]
	fn une_regle_sans_oracle_ne_part_pas() {
		let sans = PermanenceRule {
			id: "ci".into(),
			enabled: true,
			..Default::default()
		};
		let avec = PermanenceRule {
			id: "ci2".into(),
			enabled: true,
			oracle: OracleConfig {
				kind: "command".into(),
				key: "build".into(),
			},
			..Default::default()
		};
		let eteinte = PermanenceRule {
			id: "ci3".into(),
			enabled: false,
			oracle: avec.oracle.clone(),
			..Default::default()
		};

		let config = PermanenceConfig {
			rules: vec![sans, avec, eteinte],
			..Default::default()
		};
		let live = config.live_rules();
		assert_eq!(live.len(), 1);
		assert_eq!(live[0].id, "ci2");
	}

	/// Le pouvoir de commenter ne s'active pas, il se borne : allumé sans
	/// aucune condition cochée, il n'ouvre rien.
	#[test]
	fn commenter_sans_condition_n_ouvre_rien() {
		let config = CommentConfig {
			enabled: true,
			scopes: Vec::new(),
			per_day: 0,
		};
		for scope in COMMENT_SCOPES {
			assert!(!config.opens(scope), "{scope} ne devrait pas être ouvert");
		}
		assert_eq!(config.per_day(), 1);
	}

	#[test]
	fn commenter_n_ouvre_que_la_condition_cochee() {
		let config = CommentConfig {
			enabled: true,
			scopes: vec!["i_commented".into()],
			per_day: 3,
		};
		assert!(config.opens("i_commented"));
		assert!(!config.opens("mine"));
		assert_eq!(config.per_day(), 3);

		// Le pouvoir éteint ferme tout, quelles que soient les conditions.
		let eteint = CommentConfig {
			enabled: false,
			..config
		};
		assert!(!eteint.opens("i_commented"));
	}

	/// Elle s'efface devant toi quand la fenêtre partagée s'épuise — mais un
	/// quota illisible ne l'éteint pas, il la laisse continuer et se signaler.
	#[test]
	fn elle_te_laisse_la_place_sous_le_plancher() {
		let config = PermanenceConfig::default();
		assert_eq!(config.quota_floor(), 15);
		assert!(config.quota_allows(Some(50)), "la moitié reste : elle travaille");
		assert!(!config.quota_allows(Some(85)), "15 % restants : elle s'arrête");
		assert!(!config.quota_allows(Some(99)));
		assert!(config.quota_allows(None), "quota illisible : elle continue");
	}

	/// Un plafond volontairement large : un garde-fou qui se déclenche souvent
	/// finit par être désactivé, et celui-ci ne doit sonner que quand quelque
	/// chose ne va pas.
	#[test]
	fn une_mission_a_un_plafond_large_par_defaut() {
		let config = MissionsConfig::default();
		assert_eq!(config.token_budget(), 500_000);
		assert_eq!(config.quota_floor(), 15);

		// Une valeur déclarée l'emporte.
		let serre = MissionsConfig {
			token_budget: 120_000,
			quota_floor_percent: 40,
			..Default::default()
		};
		assert_eq!(serre.token_budget(), 120_000);
		assert_eq!(serre.quota_floor(), 40);
	}

	/// Les tâches cessent de partir quand la réserve est basse — et un quota
	/// illisible ne bloque pas : un dispositif qui s'arrête faute d'avoir su
	/// lire un chiffre est plus dur à diagnostiquer qu'un dispositif bavard.
	#[test]
	fn une_reserve_basse_arrete_les_departs() {
		let config = MissionsConfig::default();
		assert!(config.quota_allows(Some(50)), "la moitié reste : on lance");
		assert!(!config.quota_allows(Some(85)), "15 % restants : on s'arrête");
		assert!(!config.quota_allows(Some(99)));
		assert!(config.quota_allows(None), "quota illisible : on continue");
	}

	/// Le tilde est une convention du shell, pas du système de fichiers. Passé
	/// tel quel, il désigne un dossier littéralement nommé « ~ » — et le message
	/// rendu accusait alors le dépôt git au lieu du chemin mal compris.
	#[test]
	fn un_chemin_se_lit_comme_on_l_ecrit() {
		// Chemins construits comme le système les écrit : le test vaut aussi
		// sous Windows.
		let home_dir = dirs::home_dir().expect("dossier personnel");
		let home = home_dir.to_string_lossy().to_string();
		let root = home_dir.join("Sites").to_string_lossy().to_string();

		assert_eq!(
			resolve_path("~/Sites/produit", &root),
			home_dir.join("Sites/produit").to_string_lossy()
		);
		assert_eq!(resolve_path("~", &root), home);
		// Un nom seul se résout sous le dossier des projets : c'est exactement à
		// ça qu'il sert.
		assert_eq!(
			resolve_path("produit", &root),
			std::path::Path::new(&root).join("produit").to_string_lossy()
		);
		// Un chemin absolu ne bouge pas.
		let absolu = std::env::temp_dir().join("truc").to_string_lossy().to_string();
		assert_eq!(resolve_path(&absolu, &root), absolu);
		// Les espaces d'un copier-coller, et la barre finale d'une complétion.
		assert_eq!(
			resolve_path(&format!("  {absolu}{}  ", std::path::MAIN_SEPARATOR), &root),
			absolu
		);
		assert_eq!(resolve_path("   ", &root), "");
		// Sans dossier de projets déclaré, un nom relatif reste relatif : le
		// cockpit n'invente pas de racine.
		assert_eq!(resolve_path("produit", ""), "produit");
	}

	/// Elle ne travaille que sur des branches à elle. Toucher à une branche
	/// partagée n'est pas un geste d'opérateur : c'est un geste qui engage tout
	/// le monde.
	#[test]
	fn les_branches_partagees_sont_hors_d_atteinte() {
		let config = PermanenceConfig::default();
		let declared: Vec<String> = Vec::new();

		// Le plancher tient sans aucune configuration : c'est tout son intérêt.
		for branch in ["main", "master", "dev", "develop", "staging", "prod"] {
			assert!(
				config.protected_branch(branch, &declared),
				"« {branch} » doit être protégée même sans workflow déclaré"
			);
		}

		// Les branches de travail passent.
		for branch in ["fix/editeur", "feat/theme", "ci-412", "renovate/tauri"] {
			assert!(!config.protected_branch(branch, &declared), "{branch}");
		}
	}

	/// On ne contourne pas la règle en écrivant le nom autrement.
	#[test]
	fn le_nom_d_une_branche_partagee_ne_se_deguise_pas() {
		let config = PermanenceConfig::default();
		let declared: Vec<String> = Vec::new();
		for branch in ["MAIN", "  dev  ", "origin/main", "refs/heads/master", "Production"] {
			assert!(config.protected_branch(branch, &declared), "{branch}");
		}
		// Mais un préfixe de travail n'est pas un préfixe de serveur : une
		// branche qui s'appelle `feat/main` reste une branche de travail.
		assert!(!config.protected_branch("feat/main", &declared));
		// Un nom vide est traité comme protégé : ne rien savoir de la branche
		// n'autorise pas à écrire dessus.
		assert!(config.protected_branch("", &declared));
	}

	/// Ce que l'équipe déclare s'ajoute au plancher, il ne le remplace pas.
	#[test]
	fn les_bases_declarees_s_ajoutent_au_plancher() {
		let config = PermanenceConfig::default();
		let declared = vec!["integration".to_string(), "recette".to_string()];
		assert!(config.protected_branch("integration", &declared));
		assert!(config.protected_branch("recette", &declared));
		assert!(config.protected_branch("main", &declared), "le plancher tient");
		assert!(!config.protected_branch("fix/x", &declared));
	}

	/// Le service décrit le poste, les règles décrivent un dépôt : basculer de
	/// projet ne doit pas emporter les autorisations du précédent.
	#[test]
	fn les_regles_ne_traversent_pas_les_projets() {
		let mut global = Config::default();
		global.permanence.enabled = true;
		global.permanence.cadence_minutes = 5;
		global.permanence.powers = vec!["rerun_pipeline".into()];
		global.permanence.rules = vec![PermanenceRule {
			id: "globale".into(),
			..Default::default()
		}];

		let autre = ProjectConfig {
			id: "autre".into(),
			..Default::default()
		};

		let mut resolu = global.clone();
		autre.merge_into(&mut resolu, true);
		assert!(resolu.permanence.enabled, "le service reste celui du poste");
		assert_eq!(resolu.permanence.cadence_minutes, 5);
		assert!(
			resolu.permanence.rules.is_empty(),
			"un projet cloisonné n'hérite pas des règles du voisin"
		);
		assert!(resolu.permanence.powers.is_empty(), "ni de ses pouvoirs");
	}
}
