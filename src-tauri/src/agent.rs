//! Agents Claude Code pilotés par le cockpit.
//!
//! Le CLI sait dialoguer en flux JSON — `--input-format stream-json` en entrée,
//! `--output-format stream-json` en sortie — ce qui permet de tenir une
//! conversation sans terminal : on écrit sur son entrée standard, on lit ses
//! messages sur sa sortie, et l'interface affiche le tout.
//!
//! Deux limites assumées. D'abord on ne peut piloter que les agents démarrés
//! ici : on ne s'attache pas à l'entrée standard d'un processus déjà lancé
//! ailleurs. Ensuite les autorisations d'outils se règlent au démarrage, faute
//! de quoi l'agent se bloquerait sur une question que personne n'entend.

use crate::error::{CockpitError, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
	pub session_id: String,
	/// Objet brut émis par le CLI : l'UI en tire ce qu'elle sait afficher.
	pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
	pub session_id: String,
	pub cwd: String,
	pub running: bool,
	/// Identifiant de session Claude Code, connu après le premier message.
	pub claude_session_id: Option<String>,
	/// L'agent est en plein tour. Sert à l'écran qui adopte un agent qu'il n'a
	/// pas lancé lui-même — un agent retrouvé après un redémarrage peut très
	/// bien être en train de travailler.
	pub working: bool,
	/// L'agent tourne dans un relais (`relay.rs`) : il survit à la fermeture
	/// du cockpit.
	pub detached: bool,
}

/// Ce par quoi on écrit à un agent.
///
/// Un tuyau, pour les agents enfants du cockpit ; une ligne ajoutée à un
/// fichier, pour ceux qui tournent dans un relais. Le reste du code n'a pas à
/// savoir lequel : il écrit une ligne, et elle arrive.
enum Input {
	Pipe(ChildStdin),
	Relay(crate::relay::Handle),
}

impl Input {
	async fn write(&mut self, data: &str) -> std::io::Result<()> {
		match self {
			Input::Pipe(stdin) => {
				stdin.write_all(data.as_bytes()).await?;
				stdin.flush().await
			}
			Input::Relay(handle) => crate::relay::write(handle, data),
		}
	}

	/// Même écriture, depuis un appelant synchrone qui tient le registre.
	fn write_blocking(&mut self, data: &str) -> std::io::Result<()> {
		match self {
			Input::Pipe(stdin) => {
				// Une commande IPC synchrone tourne sur le fil principal, hors du
				// runtime. Sous Windows, tokio écrit dans un tuyau par son pool
				// bloquant, qui exige ce contexte : sans lui, « there is no reactor
				// running » faisait tomber l'app entière — constaté en sondant le
				// contexte d'un exécutant de mission (`agent_probe_context`). Sous
				// macOS l'écriture passait. Entrer dans le runtime de Tauri vaut
				// pour tous les appelants, et s'emboîte sans mal si l'on y est déjà.
				let runtime = tauri::async_runtime::handle();
				let _contexte = runtime.inner().enter();
				futures::executor::block_on(async {
					stdin.write_all(data.as_bytes()).await?;
					stdin.flush().await
				})
			}
			Input::Relay(handle) => crate::relay::write(handle, data),
		}
	}
}

/// Ce qu'on lit d'un agent, ligne à ligne : un tuyau, ou un fichier qu'on suit.
enum Lines {
	Out(tokio::io::Lines<BufReader<ChildStdout>>),
	Err(tokio::io::Lines<BufReader<ChildStderr>>),
	Tail(crate::relay::Tail),
}

impl Lines {
	/// La ligne suivante, ou `None` à la fin du flux — même contrat pour les
	/// trois sources, ce qui laisse la boucle de lecture telle qu'elle était.
	async fn next(&mut self) -> Option<String> {
		match self {
			Lines::Out(lines) => lines.next_line().await.ok().flatten(),
			Lines::Err(lines) => lines.next_line().await.ok().flatten(),
			Lines::Tail(tail) => tail.next_line().await,
		}
	}
}

struct Running {
	cwd: String,
	/// L'exécution que cet agent alimente — voir `executions.rs`.
	///
	/// Une session et une exécution ne sont pas la même chose : celle-ci
	/// identifie *un lancement*, et un agent par tour (`codex-exec`) en relance
	/// le process sans pour autant en ouvrir une seconde. C'est donc ici qu'elle
	/// se retient, plutôt que d'être redéduite à chaque tour.
	execution: String,
	/// Absent entre deux tours d'un agent dont le process ne reste pas
	/// ouvert (`codex-exec`) : il s'est terminé de lui-même, par conception —
	/// voir `per_turn`.
	stdin: Option<Input>,
	child: Option<Child>,
	/// Le relais qui porte cet agent, quand il est détaché : c'est par lui qu'on
	/// le mesure, qu'on l'arrête, et qu'on le laisse vivre à la fermeture.
	relay: Option<crate::relay::Handle>,
	/// Le protocole que parle ce process. Seul Claude Code comprend une requête
	/// de contrôle : en écrire une sur l'entrée d'un autre moteur, c'était lui
	/// envoyer une ligne qu'il ne sait pas lire.
	protocol: crate::protocol::Protocol,
	/// Runtime et identifiant de session, quand cet agent tourne isolé dans
	/// un conteneur — `child.start_kill()` seul ne l'arrête pas (vérifié
	/// empiriquement), voir `sandbox::kill`.
	container: Option<(String, String)>,
	claude_session_id: Option<String>,
	/// L'agent a rendu sa réponse et attend la suite.
	///
	/// Un CLI lancé en `stream-json` ne se termine pas quand il a fini : il
	/// reste ouvert sur son entrée, prêt pour le tour suivant. Guetter la mort du
	/// processus ne disait donc jamais qu'un exécutant avait terminé — il fallait
	/// le tuer pour s'en apercevoir. C'est l'événement `result`, émis à la fin de
	/// chaque tour, qui fait foi.
	///
	/// Un agent `codex-exec` meurt vraiment à chaque tour : `turn_done` y vaut
	/// alors la même chose que « le process est mort », mais reste distinct
	/// dans le nom pour ne pas laisser croire que sa mort est un accident.
	turn_done: bool,
	/// Depuis quand le tour en cours a commencé.
	///
	/// Un maître de mission qui reste bloqué en plein tour — au sens
	/// `turn_done == false` — n'avait aucune limite : ni mort de process ni
	/// `result` à attendre, juste un silence qui pouvait durer des heures sans
	/// que rien ne le remarque (voir `MASTER_TURN_TIMEOUT` dans `lib.rs`,
	/// `reap_stray_agents`). Posé au lancement, remis à zéro à chaque nouveau
	/// message (`send`) : c'est bien la durée du tour, pas celle de la
	/// session entière.
	turn_started_at: std::time::Instant,
	/// Ce qu'il faut pour rejouer un tour suivant quand le process ne reste
	/// pas ouvert d'un tour à l'autre — absent pour le protocole par défaut,
	/// dont le `stdin` encore ouvert suffit.
	per_turn: Option<PerTurn>,
}

#[derive(Clone)]
struct PerTurn {
	binary: String,
	/// Capturé sur le premier tour (`thread.started` chez Codex) ; permet au
	/// suivant de reprendre la même conversation plutôt que d'en ouvrir une
	/// autre. Absent tant que le premier tour n'a encore rien annoncé.
	thread_id: Option<String>,
	/// Les réglages du lancement : une reprise n'en hérite aucun, ni son mode, ni
	/// ses outils, ni son modèle.
	args: String,
	/// Son environnement : sans lui, le pont de mission d'un tour suivant ne sait
	/// plus sur quelle mission il agit, et l'agent change de compte.
	env: Vec<(String, String)>,
	env_removals: Vec<String>,
}

#[derive(Default)]
pub struct AgentRegistry {
	sessions: Mutex<HashMap<String, Running>>,
	/// Sessions qui ont rendu au moins une réponse avant de s'éteindre.
	///
	/// Un processus absent du registre ne dit pas pourquoi il l'est : un agent
	/// qui a fini son tour et un agent mort au démarrage se ressemblent d'ici.
	/// La différence compte pourtant — un lancement refusé par le CLI se voyait
	/// compter comme une livraison, et la mission proposait d'ouvrir une pull
	/// request sur du vide.
	completed: Mutex<std::collections::HashSet<String>>,
}

pub type SharedAgents = Arc<AgentRegistry>;

impl AgentRegistry {
	/// Processus racine de chaque agent vivant : identifiant, dossier, pid.
	///
	/// Le pid est celui du `zsh` qui porte le CLI, donc la racine du sous-arbre
	/// à mesurer — le CLI, ses serveurs MCP et ce qu'ils lancent à leur tour.
	pub fn roots(&self) -> Vec<(String, String, u32)> {
		let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
		sessions
			.iter()
			// `id()` rend `None` quand l'enfant est déjà parti — pareil pour un
			// agent par tour (`codex-exec`) entre deux tours, qui n'a alors
			// simplement rien à mesurer plutôt qu'un sous-arbre mort.
			.filter_map(|(id, running)| {
				// Un agent détaché n'a pas de `Child` : la racine de son
				// sous-arbre est le shell du relais, chef de son groupe.
				running
					.child
					.as_ref()
					.and_then(|child| child.id())
					.or_else(|| running.relay.as_ref().map(|relay| relay.pgid as u32))
					.map(|pid| (id.clone(), running.cwd.clone(), pid))
			})
			.collect()
	}

	pub fn snapshot(&self) -> Vec<AgentStatus> {
		let sessions = self.sessions.lock().unwrap();
		sessions
			.iter()
			.map(|(id, running)| AgentStatus {
				session_id: id.clone(),
				cwd: running.cwd.clone(),
				running: true,
				claude_session_id: running.claude_session_id.clone(),
				working: !running.turn_done,
				detached: running.relay.is_some(),
			})
			.collect()
	}

	/// L'identifiant de session du moteur (`claude_session_id`, ou le fil d'un
	/// agent par tour), pendant que l'agent est encore vivant. C'est par lui
	/// qu'une tâche renvoyée en correction reprend sa conversation.
	///
	/// À appeler avant `stop`, jamais après : une fois l'agent arrêté et retiré
	/// du registre, plus rien ne sait retrouver cet identifiant — c'est
	/// exactement ce qui laissait `task.engine_session` vide (voir
	/// `collect_finished_tasks`, qui l'appelle désormais avant de libérer
	/// l'agent, pas dans `rework` où il était déjà trop tard).
	pub fn engine_session_of(&self, session_id: &str) -> Option<String> {
		let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
		let running = sessions.get(session_id)?;
		running
			.claude_session_id
			.clone()
			.or_else(|| running.per_turn.as_ref()?.thread_id.clone())
	}
}

/// Chemin absolu du CLI `claude`.
///
/// Lancé depuis le Finder, le cockpit n'hérite que d'un PATH minimal, et un
/// shell de login ne lit pas `.zshrc` : une installation posée dans
/// `~/.local/bin` reste alors invisible, et l'agent mourait sur un
/// « command not found: claude » que rien n'expliquait. On demande donc au
/// shell, puis on va voir les emplacements connus.
/// Ce CLI sait-il raconter ses sous-agents ?
///
/// Le drapeau est récent. Le passer à un binaire qui l'ignore ne dégrade rien :
/// il refuse de démarrer, et l'agent ne part pas du tout. On demande donc au
/// binaire ce qu'il accepte, une fois pour la durée de la session — `--help`
/// coûte quelques centaines de millisecondes, et personne n'a envie de les
/// payer à chaque lancement d'agent.
pub(crate) fn forwards_subagents(binary: &str) -> bool {
	static SUPPORTE: OnceLock<bool> = OnceLock::new();
	// Le binaire est résolu une fois pour toutes en amont (`claude_binary`) :
	// la réponse ne dépend donc pas de l'argument d'un appel à l'autre.
	*SUPPORTE.get_or_init(|| {
		crate::platform::shell(&format!("{} --help", shell_quote(binary)))
			.output()
			.map(|out| {
				String::from_utf8_lossy(&out.stdout).contains("--forward-subagent-text")
			})
			.unwrap_or(false)
	})
}

pub(crate) fn claude_binary() -> Option<String> {
	static RESOLVED: OnceLock<Option<String>> = OnceLock::new();
	RESOLVED
		.get_or_init(|| {
			// Un shell de login couvre Homebrew, nvm et les PATH déclarés en profil
			// (sous Windows : `where`, puis le bash de Git).
			if let Some(found) = crate::platform::locate("claude") {
				return Some(found);
			}
			crate::platform::first_runnable(&claude_candidates())
		})
		.clone()
}

/// Chemin absolu de `node`, quand le poste en a un.
///
/// Les deux ponts MCP du cockpit — autorisations, outils de mission — sont des
/// scripts Node. Or Claude Code s'installe désormais en binaire natif : un poste
/// tout neuf fait donc tourner des agents sans avoir Node, et le serveur MCP
/// déclaré ne démarre jamais. Le CLI, à qui l'on a pourtant annoncé
/// `--permission-prompt-tool mcp__cockpit__approve`, échoue alors sur chaque
/// demande d'autorisation par un « MCP tool mcp__cockpit__approve » que rien
/// n'explique.
///
/// Même recherche que pour `claude`, et pour la même raison : lancé depuis le
/// Finder, le cockpit n'hérite que d'un PATH minimal.
pub(crate) fn node_binary() -> Option<String> {
	static RESOLVED: OnceLock<Option<String>> = OnceLock::new();
	RESOLVED
		.get_or_init(|| {
			if let Some(found) = crate::platform::locate("node") {
				return Some(found);
			}
			crate::platform::first_runnable(&node_candidates())
		})
		.clone()
}

/// Où l'on trouve `claude` quand le shell ne le connaît pas.
fn claude_candidates() -> Vec<std::path::PathBuf> {
	let home = dirs::home_dir().unwrap_or_default();
	#[cfg(windows)]
	{
		use crate::platform::env_dir;
		let mut found = vec![
			// L'installeur natif (`install.ps1`).
			home.join(".local").join("bin").join("claude.exe"),
			home.join(".claude").join("local").join("claude.exe"),
			home.join(".claude").join("local").join("claude.cmd"),
			home.join(".bun").join("bin").join("claude.exe"),
		];
		if let Some(appdata) = env_dir("APPDATA") {
			// `npm install -g` pose un `claude.cmd`.
			found.push(appdata.join("npm").join("claude.cmd"));
		}
		if let Some(local) = env_dir("LOCALAPPDATA") {
			found.push(local.join("Programs").join("claude").join("claude.exe"));
			found.push(local.join("Volta").join("bin").join("claude.exe"));
		}
		found
	}
	#[cfg(not(windows))]
	{
		vec![
			home.join(".local/bin/claude"),
			home.join(".claude/local/claude"),
			"/opt/homebrew/bin/claude".into(),
			"/usr/local/bin/claude".into(),
			home.join(".bun/bin/claude"),
			home.join(".volta/bin/claude"),
		]
	}
}

/// Où l'on trouve `node` quand le shell ne le connaît pas.
fn node_candidates() -> Vec<std::path::PathBuf> {
	let home = dirs::home_dir().unwrap_or_default();
	#[cfg(windows)]
	{
		use crate::platform::env_dir;
		let mut found = Vec::new();
		// nvm-windows tient le Node actif derrière un lien qu'il annonce ici.
		if let Some(link) = env_dir("NVM_SYMLINK") {
			found.push(link.join("node.exe"));
		}
		for base in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
			if let Some(dir) = env_dir(base) {
				found.push(dir.join("nodejs").join("node.exe"));
			}
		}
		if let Some(local) = env_dir("LOCALAPPDATA") {
			found.push(local.join("Volta").join("bin").join("node.exe"));
			found.push(local.join("Programs").join("nodejs").join("node.exe"));
		}
		found.push(home.join(".bun").join("bin").join("node.exe"));
		found.push(home.join("scoop").join("shims").join("node.exe"));
		found
	}
	#[cfg(not(windows))]
	{
		vec![
			"/opt/homebrew/bin/node".into(),
			"/usr/local/bin/node".into(),
			home.join(".volta/bin/node"),
			home.join(".bun/bin/node"),
			home.join(".local/bin/node"),
			"/usr/bin/node".into(),
		]
	}
}

/// Le `PATH` à donner à un CLI lancé sans shell : son propre dossier d'abord,
/// puis celui hérité, puis les dossiers habituels du système.
fn path_with(dir: &std::path::Path) -> String {
	let inherited = std::env::var("PATH").unwrap_or_default();
	#[cfg(windows)]
	{
		format!("{}{}{inherited}", dir.display(), crate::platform::PATH_SEPARATOR)
	}
	#[cfg(not(windows))]
	{
		format!("{}:{inherited}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", dir.display())
	}
}

/// `export PATH=<dossier>:$PATH; ` — pour un script joué par le shell, qui
/// tient son `PATH` à sa façon (voir `platform::shell_path`).
pub(crate) fn export_path(dir: &std::path::Path) -> String {
	format!(
		"export PATH={}:$PATH; ",
		shell_quote(&crate::platform::shell_path(&dir.to_string_lossy()))
	)
}

/// Ce qu'un agent lancé pour une seule question a rendu.
#[derive(Debug, Clone, Default)]
pub struct OneShot {
	/// Le texte final, celui qu'on voulait.
	pub text: String,
	pub duration_ms: u64,
	/// Ce que ce tour vaudrait aux tarifs de l'API, tel que le moteur le calcule.
	///
	/// Ce n'est pas une facture. Le CLI rend ce montant de la même façon qu'on
	/// paie à l'usage ou qu'on tourne sur un abonnement — dans le second cas
	/// rien n'est débité, c'est le quota de la fenêtre qui se consomme. Le
	/// chiffre reste la seule mesure comparable d'une lecture à l'autre, mais
	/// il se présente comme une valorisation, jamais comme une dépense.
	pub cost_usd: f64,
	/// Conversation du moteur, pour aller la relire au besoin.
	pub session_id: String,
}

/// Au-delà, on considère que l'agent ne rendra rien.
///
/// Sans borne, un CLI qui se bloque laisse une analyse « en cours » pour
/// toujours : personne ne peut la relancer, et rien ne dit pourquoi. Vingt
/// minutes laissent largement le temps de lire un gros diff.
const ONE_SHOT_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Une question qui attend une réponse en quelques secondes : celle de
/// l'assistant vocal, qu'on vient de lui poser à voix haute.
///
/// `run_once` sert des analyses de plusieurs minutes et embarque tout Claude
/// Code — ses outils, ses serveurs MCP, ses consignes (douze mille jetons), un
/// shell de connexion. Mesuré : 7,3 s pour répondre « ok ». Ici, ni outils, ni
/// MCP, ni skills, ni session gardée, des consignes à nous, et le binaire
/// lancé sans shell depuis un dossier neutre, sans réflexion : 2 s. Sur
/// l'abonnement de la personne, comme le reste du cockpit.
pub async fn ask_quick(system: &str, prompt: &str, model: &str) -> Result<String> {
	ask_bare(system, prompt, model, Duration::from_secs(60), false)
		.await
		.map(|answer| answer.text)
}

/// La même question nue — ni outils, ni MCP, ni consignes de projet —, pour
/// une rédaction qui prend plus d'une minute.
///
/// C'est ce qui fait tenir la lecture seule d'une automatisation : un agent
/// qui n'a aucun outil ne peut rien pousser, commenter ni déplacer, quoi qu'on
/// lui demande. Le lui interdire par consigne ne vaudrait rien face à un
/// serveur MCP de suivi de tâches resté branché sur le poste.
pub async fn ask_bare(
	system: &str,
	prompt: &str,
	model: &str,
	timeout: Duration,
	thinking: bool,
) -> Result<OneShot> {
	let started = std::time::Instant::now();
	let binary = claude_binary().ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.claudeNotFound")))?;
	let config = crate::config::Config::active();
	// Un dossier sans CLAUDE.md ni réglages de projet : la réponse ne doit
	// dépendre que de ce qu'on lui donne.
	let neutral = std::env::temp_dir().join("cockpit-assistant");
	let _ = std::fs::create_dir_all(&neutral);
	let mut path = std::env::var("PATH").unwrap_or_default();
	if let Some(dir) = std::path::Path::new(&binary).parent() {
		path = path_with(dir);
	}
	let mut command = Command::new(&binary);
	crate::platform::quiet_async(&mut command);
	command
		.args(["-p", "--output-format", "json", "--model", model])
		.args(["--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
		.args(["--system-prompt", system])
		.current_dir(&neutral)
		.env("PATH", path)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	// Router une commande ne demande pas de réfléchir : mesuré, la réflexion
	// faisait varier la réponse de 5 à 9 s ; sans elle, 2 s stables.
	if !thinking {
		command.env("MAX_THINKING_TOKENS", "0");
	}
	for (name, value) in crate::config::account_env(&config) {
		command.env(name, value);
	}
	let mut child = command
		.spawn()
		.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.claudeLaunchError", &[("error", &e)])))?;
	if let Some(mut stdin) = child.stdin.take() {
		let _ = stdin.write_all(prompt.as_bytes()).await;
		drop(stdin);
	}
	let output = tokio::time::timeout(timeout, child.wait_with_output())
		.await
		.map_err(|_| CockpitError::msg(crate::i18n::tf("agent.claudeTimeout", &[("seconds", &timeout.as_secs())])))?
		.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.claudeError", &[("error", &e)])))?;
	let stdout = String::from_utf8_lossy(&output.stdout).to_string();
	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
		let detail = if stderr.is_empty() { stdout } else { stderr };
		return Err(CockpitError::msg(crate::i18n::tf(
			"agent.claudeStopped",
			&[("detail", &detail.chars().take(300).collect::<String>())],
		)));
	}
	let value: Value = serde_json::from_str(stdout.trim())
		.map_err(|_| CockpitError::msg(crate::i18n::t("agent.claudeUnreadable")))?;
	Ok(OneShot {
		text: value.get("result").and_then(Value::as_str).unwrap_or("").to_string(),
		duration_ms: started.elapsed().as_millis() as u64,
		cost_usd: value.get("total_cost_usd").and_then(Value::as_f64).unwrap_or(0.0),
		session_id: value.get("session_id").and_then(Value::as_str).unwrap_or("").to_string(),
	})
}

/// Pose une question à un agent et attend sa réponse, sans conversation.
///
/// Rien à voir avec [`start`] : il n'y a ni tour de parole, ni session à tenir,
/// ni interface à alimenter. Le CLI est lancé en `--output-format json`, il rend
/// un seul objet, et on le lit. C'est le bon outil quand le cockpit a une
/// question précise à faire traiter et veut la réponse — pas quand quelqu'un
/// veut dialoguer.
///
/// `disallowed` liste les outils explicitement refusés. Un agent lancé pour
/// comprendre n'a rien à écrire, et le lui interdire vaut mieux que le lui
/// demander : personne n'est là pour répondre à la question qu'il poserait.
///
/// `origin` dit à quoi sert cette question — la lecture d'un changement, une
/// confrontation, un audit de propriété. Ces agents-là consomment sans que rien
/// ne les distingue : jusqu'ici, aucune trace ne disait ni combien ils
/// coûtaient, ni combien de fois ils étaient partis.
pub async fn run_once(
	cwd: &str,
	prompt: &str,
	engine_id: &str,
	model: &str,
	depth: &str,
	disallowed: &[&str],
	origin: crate::executions::Origin,
) -> Result<OneShot> {
	run_once_with_tools(cwd, prompt, engine_id, model, depth, disallowed, "", origin).await
}

/// Le même, avec des outils MCP en plus.
///
/// `mcp` est le chemin d'un fichier de configuration MCP ; vide, l'agent
/// travaille sans outil du cockpit. C'est ce qui permet à une réponse d'arriver
/// **par appel d'outil** plutôt que par du texte à relire : un verdict qu'on
/// extrait d'une phrase dépend de la façon dont le modèle a tourné sa phrase, et
/// finit toujours par se tromper le jour où il la tourne autrement.
#[allow(clippy::too_many_arguments)]
pub async fn run_once_with_tools(
	cwd: &str,
	prompt: &str,
	engine_id: &str,
	model: &str,
	depth: &str,
	disallowed: &[&str],
	mcp: &str,
	origin: crate::executions::Origin,
) -> Result<OneShot> {
	run_once_with_config(crate::config::Config::active(), cwd, prompt, engine_id, model, depth, disallowed, mcp, origin).await
}

/// Le même, sous une configuration donnée plutôt que celle du projet affiché.
///
/// Ce qui tourne en fond pour un dépôt précis — un essai de rejeu — doit
/// garder son moteur, son compte et son environnement même si l'on change de
/// projet à l'écran pendant qu'il travaille (`Config::for_repo`).
#[allow(clippy::too_many_arguments)]
pub async fn run_once_with_config(
	config: crate::config::Config,
	cwd: &str,
	prompt: &str,
	engine_id: &str,
	model: &str,
	depth: &str,
	disallowed: &[&str],
	mcp: &str,
	origin: crate::executions::Origin,
) -> Result<OneShot> {
	if !std::path::Path::new(cwd).is_dir() {
		return Err(CockpitError::msg(crate::i18n::tf("agent.folderNotFound", &[("path", &cwd)])));
	}

	let engine = crate::config::engine_for(&config, engine_id);
	// Une question ponctuelle se pose en `--output-format json`, que seul le
	// protocole par défaut sait rendre : ce n'est pas un dialogue, il n'y a rien
	// à traduire, et un autre moteur répondrait dans une forme qu'on ne relit
	// pas ici.
	if crate::protocol::Protocol::parse(engine.protocol_or_default())
		!= Some(crate::protocol::Protocol::Claude)
	{
		return Err(CockpitError::msg(crate::i18n::tf(
			"agent.oneShotProtocol",
			&[("engine", &engine.label), ("protocol", &engine.protocol_or_default())],
		)));
	}

	let binary = match engine.command.trim() {
		"" => claude_binary().ok_or_else(|| {
			CockpitError::msg(crate::i18n::t("agent.claudeNotFound"))
		})?,
		declared => declared.to_string(),
	};

	let mut command = String::new();
	if let Some(dir) = std::path::Path::new(&binary).parent() {
		command.push_str(&export_path(dir));
	}
	// `bypassPermissions` parce qu'il n'y a personne pour répondre : sans TTY ni
	// interface branchée sur cette exécution, la moindre demande resterait
	// suspendue jusqu'au délai d'attente. Ce sont les outils refusés, juste
	// après, qui tiennent la barrière — pas le mode.
	command.push_str(&format!(
		"{} -p --output-format json --permission-mode bypassPermissions",
		shell_quote(&binary)
	));
	if !disallowed.is_empty() {
		command.push_str(&format!(
			" --disallowedTools {}",
			shell_quote(&disallowed.join(" "))
		));
	}
	if !mcp.trim().is_empty() {
		command.push_str(&format!(" --mcp-config {}", shell_quote(mcp.trim())));
	}
	if !model.trim().is_empty() {
		command.push_str(&format!(" --model {}", shell_quote(model.trim())));
	}
	if !depth.trim().is_empty() {
		let args = engine.depth_args(depth);
		if !args.is_empty() {
			command.push(' ');
			command.push_str(args);
		}
	}
	if !engine.extra_args.trim().is_empty() {
		command.push(' ');
		command.push_str(engine.extra_args.trim());
	}

	let mut launcher = crate::platform::shell_async(&command);
	launcher
		.current_dir(cwd)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	// Sous quel compte cet agent travaille. Avant l'environnement du moteur, qui
	// garde le dernier mot : une passerelle qui porte sa propre identité n'a que
	// faire d'un dossier de compte Claude.
	for (name, value) in crate::config::account_env(&config) {
		launcher.env(name, value);
	}
	for entry in &engine.env {
		let name = entry.name.trim();
		if name.is_empty() {
			continue;
		}
		if entry.value.trim().is_empty() {
			launcher.env_remove(name);
		} else {
			launcher.env(name, entry.value.trim());
		}
	}

	let mut child = launcher
		.spawn()
		.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.launchError", &[("error", &e)])))?;

	// La consigne passe par l'entrée standard : une ligne de commande a une
	// longueur maximale, et un diff de plusieurs milliers de lignes la dépasse.
	if let Some(mut stdin) = child.stdin.take() {
		let _ = stdin.write_all(prompt.as_bytes()).await;
		let _ = stdin.flush().await;
		// Fermer l'entrée dit au CLI que la question est complète.
		drop(stdin);
	}

	let output = match tokio::time::timeout(ONE_SHOT_TIMEOUT, child.wait_with_output()).await {
		Ok(result) => result.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.agentError", &[("error", &e)])))?,
		Err(_) => {
			return Err(CockpitError::msg(crate::i18n::t("agent.oneShotTimeout")))
		}
	};

	let stdout = String::from_utf8_lossy(&output.stdout).to_string();
	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
		let detail = if stderr.is_empty() { stdout } else { stderr };
		return Err(CockpitError::msg(crate::i18n::tf(
			"agent.agentStopped",
			&[("detail", &detail.chars().take(400).collect::<String>())],
		)));
	}

	let value: Value = serde_json::from_str(stdout.trim()).map_err(|_| {
		CockpitError::msg(crate::i18n::tf(
			"agent.agentUnreadable",
			&[("output", &stdout.chars().take(200).collect::<String>())],
		))
	})?;

	// `is_error` est vrai quand le CLI a bien répondu mais que le tour a échoué —
	// budget épuisé, outil refusé. Le distinguer d'un plantage évite de faire
	// passer un message d'erreur du moteur pour une analyse.
	if value.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
		let motif = value
			.get("result")
			.and_then(|v| v.as_str())
			.map(str::to_string)
			.unwrap_or_else(|| crate::i18n::t("agent.noReason"))
			.chars()
			.take(300)
			.collect::<String>();
		return Err(CockpitError::msg(crate::i18n::tf(
			"agent.agentFailed",
			&[("reason", &motif)],
		)));
	}

	let text = value
		.get("result")
		.and_then(|v| v.as_str())
		.unwrap_or_default()
		.to_string();
	if text.trim().is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("agent.agentWroteNothing")));
	}

	let rendu = OneShot {
		text,
		duration_ms: value
			.get("duration_ms")
			.and_then(|v| v.as_u64())
			.unwrap_or(0),
		cost_usd: value
			.get("total_cost_usd")
			.and_then(|v| v.as_f64())
			.unwrap_or(0.0),
		session_id: value
			.get("session_id")
			.and_then(|v| v.as_str())
			.unwrap_or_default()
			.to_string(),
	};

	// Une question ponctuelle est une exécution comme une autre : elle part, elle
	// consomme, elle rend quelque chose. Elle n'a ni conversation à tenir ni
	// registre à alimenter — d'où deux lignes de relevé et pas davantage — mais
	// la laisser dehors reviendrait à ne compter qu'une partie de ce qu'on
	// dépense, et à ne jamais savoir ce que coûtent les lectures d'impact, les
	// confrontations ou les audits de propriétés.
	//
	// Écrit après coup, une fois seulement, et jamais en cas d'échec : le
	// chemin d'erreur rend avant d'arriver ici, et une exécution qui n'a rien
	// rendu se lirait comme une exécution réussie à zéro dollar.
	let execution = crate::executions::open(crate::executions::Opening {
		session_id: String::new(),
		protocol: crate::config::DEFAULT_PROTOCOL.to_string(),
		engine: engine.id.clone(),
		engine_label: engine.label.clone(),
		model: model.to_string(),
		origin,
		cwd: cwd.to_string(),
		project: config.active_project.clone(),
		sandboxed: false,
		..Default::default()
	});
	crate::executions::note_turn(&execution, crate::protocol::Protocol::Claude, &value);
	crate::executions::note_step(
		&execution,
		crate::executions::Step::Answered,
		&rendu.session_id,
	);

	Ok(rendu)
}

/// Message utilisateur au format attendu par `--input-format stream-json`.
fn user_message(text: &str) -> String {
	let value = json!({
		"type": "user",
		"message": { "role": "user", "content": [{ "type": "text", "text": text }] },
	});
	format!("{value}\n")
}

/// Démarre un agent et renvoie son identifiant local.
///
/// `permission_mode` décide de ce que l'agent peut faire sans demander. Sans
/// TTY, une demande d'autorisation resterait sans réponse : on choisit donc
/// explicitement à l'ouverture plutôt que de bloquer plus tard.
#[allow(clippy::too_many_arguments)]
pub async fn start(
	app: AppHandle,
	agents: SharedAgents,
	cwd: String,
	prompt: String,
	permission_mode: Option<String>,
	model: Option<String>,
	resume: Option<String>,
	engine_id: Option<String>,
	origin: crate::executions::Origin,
) -> Result<String> {
	start_with_mission(
		app,
		agents,
		cwd,
		prompt,
		permission_mode,
		model,
		resume,
		None,
		engine_id,
		String::new(),
		Vec::new(),
		origin,
	)
	.await
}

/// Même lancement, mais rattaché à une mission : l'agent devient alors maître et
/// reçoit les outils qui lui permettent de créer des branches, de lancer des
/// exécutants et de recomposer leur travail.
#[allow(clippy::too_many_arguments)]
pub async fn start_with_mission(
	app: AppHandle,
	agents: SharedAgents,
	cwd: String,
	prompt: String,
	permission_mode: Option<String>,
	model: Option<String>,
	resume: Option<String>,
	mission: Option<String>,
	engine_id: Option<String>,
	depth: String,
	scope: Vec<String>,
	origin: crate::executions::Origin,
) -> Result<String> {
	start_inner(
		app, agents, cwd, prompt, permission_mode, model, resume, mission, engine_id, depth, scope, origin, None,
		None,
	)
	.await
}

/// La place d'un agent dans une mission. Elle décide de ce qu'il reçoit au
/// lancement : les outils de mission d'un côté, le garde-fou git de l'autre.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MissionSeat {
	/// Hors mission.
	None,
	/// Lancé pour la mission elle-même : il découpe, lance et intègre.
	Master,
	/// Lancé pour une de ses tâches.
	Executor,
}

impl MissionSeat {
	fn of(mission: Option<&str>, task: &str) -> Self {
		match mission {
			None => MissionSeat::None,
			Some(_) if task.trim().is_empty() => MissionSeat::Master,
			Some(_) => MissionSeat::Executor,
		}
	}
}

/// La configuration sous laquelle lancer un agent.
///
/// Une mission tourne en fond pour le projet de son dépôt. La lire depuis le
/// projet à l'écran donnait à ses agents le compte et les moteurs du voisin dès
/// qu'on changeait d'onglet, alors que leur rôle venait bien du bon projet.
fn launch_config(mission: Option<&str>) -> crate::config::Config {
	mission
		.and_then(|id| crate::mission::get(id).ok())
		.map(|mission| crate::config::Config::for_repo(&mission.cwd))
		.unwrap_or_else(crate::config::Config::active)
}

/// Les consignes permanentes d'un agent : le rendu en images et la liste
/// d'étapes (dont l'outil vit dans le pont d'autorisation, d'où `steps`), et la
/// langue de réponse, pour tout agent : les prompts sont en anglais.
fn standing_instructions(reviewing: bool, steps: bool) -> String {
	let consignes: Vec<String> = [
		(!reviewing && steps).then(|| crate::prompts::STEPS_TEMPLATE.to_string()),
		if reviewing { None } else { crate::prompts::visual() },
		Some(crate::i18n::reply_directive()),
	]
	.into_iter()
	.flatten()
	.collect();
	consignes.join("\n\n")
}

/// Les outils et le garde-fou d'un agent Codex, les mêmes que ceux que Claude
/// Code reçoit plus bas. Hors conteneur seulement : voir `Protocol::runs_missions`.
fn codex_equipment(cwd: &str, reviewing: bool, seat: MissionSeat) -> String {
	let read = |path: String| -> String {
		std::fs::read_to_string(path)
			.ok()
			.and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
			.map(|config| crate::codex::mcp_args(&config))
			.unwrap_or_default()
	};
	let lossy = |path: std::path::PathBuf| path.to_string_lossy().to_string();

	let mut args = String::new();
	if let Some(declares) = crate::mcp::config_for(cwd, false) {
		args.push_str(&read(lossy(declares)));
	}
	if !reviewing {
		if let Some(browser) = crate::browser::mcp_config(cwd, false) {
			args.push_str(&read(lossy(browser)));
		}
	}
	let bridge = crate::permissions::bridge_arguments(false);
	let steps = bridge.is_some();
	if let Some((config, _tool)) = bridge {
		args.push_str(&read(config));
	}
	if reviewing {
		if let Some(config) = crate::review::bridge_config(false) {
			args.push_str(&read(config));
		}
	}
	if seat == MissionSeat::Master {
		if let Some(config) = crate::orchestrator::bridge_config(false) {
			args.push_str(&read(config));
		}
	}
	if seat == MissionSeat::Executor {
		if let Some(hook) = crate::guard::codex_hook_args() {
			args.push_str(&hook);
		}
	}
	args.push_str(&crate::codex::instructions_args(&standing_instructions(reviewing, steps)));
	args
}

/// Un agent lancé depuis l'écran, avec un profil : `review` le met en lecture
/// seule (voir `review.rs`).
#[allow(clippy::too_many_arguments)]
pub async fn start_profiled(
	app: AppHandle,
	agents: SharedAgents,
	cwd: String,
	prompt: String,
	permission_mode: Option<String>,
	model: Option<String>,
	resume: Option<String>,
	engine_id: Option<String>,
	profile: Option<String>,
	// Le compte choisi au lancement — celui d'un agent libre, qui n'appartient à
	// aucun projet. `None` : celui du projet, comme pour tout le reste.
	account: Option<String>,
	depth: String,
	origin: crate::executions::Origin,
) -> Result<String> {
	start_inner(
		app, agents, cwd, prompt, permission_mode, model, resume, None, engine_id, depth, Vec::new(), origin,
		profile, account,
	)
	.await
}

#[allow(clippy::too_many_arguments)]
async fn start_inner(
	app: AppHandle,
	agents: SharedAgents,
	cwd: String,
	prompt: String,
	permission_mode: Option<String>,
	model: Option<String>,
	resume: Option<String>,
	mission: Option<String>,
	engine_id: Option<String>,
	// `depth` : profondeur de réflexion voulue — `fast`, `normal`, `deep` ou
	// vide. Traduite par le moteur, ignorée par ceux qui ne savent pas la dire.
	depth: String,
	// `scope` : chemins où cet agent a le droit d'écrire ; vide = tout le dépôt.
	// Transmis au pont d'autorisation, qui refuse le reste avant même de
	// regarder le mode — c'est là que la barrière tient, puisqu'un agent en
	// `bypassPermissions` ne dépose aucune demande à relire.
	scope: Vec<String>,
	// `origin` : qui a demandé ce lancement, et pour quelle tâche. Passé
	// explicitement plutôt que déduit d'un acteur ambiant — la Permanence
	// travaille pendant qu'on clique ailleurs, et une attribution fausse coûte
	// plus cher qu'une attribution absente. Voir `executions::Origin`.
	origin: crate::executions::Origin,
	// `profile` : `review` = lecture seule, outil de remise de la revue.
	profile: Option<String>,
	// `account` : compte imposé au lancement, à la place de celui du projet.
	account: Option<String>,
) -> Result<String> {
	let reviewing = profile.as_deref() == Some("review");
	// Un exécutant de mission : lancé pour une tâche. Le maître, lui, n'en a
	// pas — il intègre, et pousse donc sur la branche d'intégration.
	let seat = MissionSeat::of(mission.as_deref(), &origin.task);
	let executor = seat == MissionSeat::Executor;
	// La lecture seule se règle par projet (Réglages → Flux de travail) : un
	// agent de revue sans elle garde son outil de remise, rien d'autre.
	let locked = reviewing && crate::config::Config::active().workflow.review_read_only;
	if !std::path::Path::new(&cwd).is_dir() {
		return Err(CockpitError::msg(crate::i18n::tf("agent.folderNotFound", &[("path", &cwd)])));
	}

	let session_id = format!("agent-{}", uuid_like());
	// Inscrite avant même le lancement : la première demande peut arriver
	// avant que quoi que ce soit d'autre soit prêt.
	if locked {
		crate::review::mark_readonly(&session_id);
	}
	// Un mode vide n'est pas « pas de mode » : le CLI refuse de démarrer sur
	// `--permission-mode ''`, avec une erreur qui ne dit rien de sa provenance.
	// On traite donc la chaîne vide comme une absence.
	let mode = permission_mode
		.map(|mode| mode.trim().to_string())
		.filter(|mode| !mode.is_empty())
		.unwrap_or_else(|| "acceptEdits".into());
	// Un agent de revue demande pour tout ce qui n'est pas une lecture, et le
	// pont le lui refuse : ni `acceptEdits` ni `bypassPermissions` ne doivent
	// lui ouvrir l'écriture, quel que soit le mode choisi par défaut.
	let mode = if locked { "default".to_string() } else { mode };

	// Le moteur dit quel programme fait tourner cet agent. Sans moteur nommé, ou
	// s'il en désigne un qui n'existe plus, on retombe sur celui d'origine :
	// une ligne de configuration effacée ne doit pas empêcher un agent de partir.
	let mut config = launch_config(mission.as_deref());
	if let Some(account) = account.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
		config.account = account.to_string();
	}

	// Chaque agent tient plusieurs process (le CLI, ses ponts MCP) : les
	// cumuler sans limite finit par saturer la machine avant qu'on s'en
	// aperçoive — mission, exécutant ou lancement manuel confondus, puisque
	// tous passent par ici. On refuse au démarrage plutôt que de laisser
	// macOS choisir tout seul quoi tuer.
	let ceiling = config.missions.memory_ceiling();
	if crate::resources::over_ceiling(ceiling) {
		return Err(CockpitError::msg(crate::i18n::tf(
			"agent.memoryCeiling",
			&[("ceiling", &ceiling)],
		)));
	}

	let engine = crate::config::engine_for(&config, engine_id.as_deref().unwrap_or_default());
	let protocol = engine.protocol_or_default().to_string();
	// Relevé avant que la construction de la commande ne consomme l'option :
	// c'est le modèle *demandé*, souvent un alias, parfois vide quand on laisse
	// le CLI appliquer le réglage du poste.
	let model_label = model.clone().unwrap_or_default();
	// Le seul endroit où la chaîne déclarée devient une valeur : tout ce qui
	// suit raisonne sur `Protocol`, dont les `match` sont exhaustifs. Un
	// quatrième protocole ajouté un jour ne pourra plus être lu, en silence,
	// comme s'il parlait la langue du premier.
	let Some(dialect) = crate::protocol::Protocol::parse(&protocol) else {
		return Err(CockpitError::msg(crate::i18n::tf(
			"agent.unknownProtocol",
			&[
				("engine", &engine.label),
				("protocol", &protocol),
				("known", &crate::protocol::Protocol::known().join(", ")),
			],
		)));
	};
	// Sans ses outils, un maître ne peut ni planifier ni lancer d'exécutant :
	// mieux vaut refuser au lancement que laisser partir un agent démuni.
	if mission.is_some() && !dialect.runs_missions(config.sandbox.enabled) {
		return Err(CockpitError::msg(crate::i18n::tf(
			"agent.protocolNoMission",
			&[("protocol", &protocol)],
		)));
	}

	// Un binaire déclaré est pris tel quel — c'est le seul moyen de pointer vers
	// un programme que le cockpit ne connaît pas. Sinon on cherche `claude` :
	// c'est le seul CLI que le cockpit sache trouver tout seul.
	let binary = match engine.command.trim() {
		"" if dialect == crate::protocol::Protocol::Claude => claude_binary().ok_or_else(|| {
			CockpitError::msg(crate::i18n::t(if cfg!(windows) { "windowsAgents.claudeNotFoundHint" } else { "agent.claudeNotFoundHint" }))
		})?,
		"" => {
			return Err(CockpitError::msg(crate::i18n::tf(
				"agent.noBinary",
				&[("engine", &engine.label)],
			)));
		}
		declared => declared.to_string(),
	};

	// Dans un conteneur, `claude` est celui de l'image — jamais le chemin
	// absolu résolu ci-dessus, qui vient du poste macOS et n'existe pas côté
	// Linux (vérifié empiriquement : `command -v claude` y répond
	// `/usr/local/bin/claude`, pas le chemin hôte). Le nom nu suffit, l'image
	// le pose déjà sur son PATH. Un binaire déclaré explicitement reste tel
	// quel, sous la responsabilité de qui l'a écrit — le cockpit ne sait pas
	// si son image sait aussi le trouver.
	let binary = if config.sandbox.enabled && engine.command.trim().is_empty() {
		"claude".to_string()
	} else {
		binary
	};

	// Ce qu'un tour de Codex doit redonner à chaque reprise : voir `PerTurn`.
	let mut codex_args = String::new();
	let command = if dialect == crate::protocol::Protocol::Codex {
		// Un message vide n'a rien à ouvrir — voir `codex.rs`.
		if prompt.trim().is_empty() {
			return Err(CockpitError::msg(crate::i18n::t("agent.codexNeedsMessage")));
		}
		// Une revue verrouillée ne gagne pas l'écriture par son mode `default`.
		codex_args.push_str(&crate::codex::permission_args(if locked { "plan" } else { &mode }));
		if let Some(model) = model.as_deref().filter(|m| !m.trim().is_empty()) {
			codex_args.push_str(&format!(" --model {}", shell_quote(model.trim())));
		}
		if !config.sandbox.enabled {
			codex_args.push_str(&codex_equipment(&cwd, reviewing, seat));
		}
		if !depth.trim().is_empty() {
			let args = engine.depth_args(&depth);
			if !args.is_empty() {
				codex_args.push(' ');
				codex_args.push_str(args);
			}
		}
		if !engine.extra_args.trim().is_empty() {
			codex_args.push(' ');
			codex_args.push_str(engine.extra_args.trim());
		}
		match resume.filter(|s| !s.trim().is_empty()) {
			Some(thread) => crate::codex::resume_turn(&binary, &thread, &codex_args),
			None => crate::codex::first_turn(&binary, &codex_args),
		}
	} else if dialect == crate::protocol::Protocol::Gemini {
		// Un seul tour possible, jamais de reprise : voir `gemini.rs`. Même
		// garde qu'en `codex-exec`, pour la même raison — rien à ouvrir sur un
		// silence.
		if prompt.trim().is_empty() {
			return Err(CockpitError::msg(crate::i18n::t("agent.geminiNeedsMessage")));
		}
		if resume.filter(|s| !s.trim().is_empty()).is_some() {
			return Err(CockpitError::msg(crate::i18n::t("agent.geminiNoResume")));
		}
		let mut built = crate::gemini::first_turn(&binary, prompt.trim());
		if !depth.trim().is_empty() {
			let args = engine.depth_args(&depth);
			if !args.is_empty() {
				built.push(' ');
				built.push_str(args);
			}
		}
		if !engine.extra_args.trim().is_empty() {
			built.push(' ');
			built.push_str(engine.extra_args.trim());
		}
		built
	} else {
		// Le chemin est résolu ici plutôt que laissé au shell : lancé depuis le
		// Finder, le cockpit n'hérite pas du PATH de l'utilisateur. On le complète
		// tout de même, pour les outils que `claude` appelle à son tour. Dans un
		// conteneur ce problème n'existe pas — l'image pose son propre PATH — et
		// `binary` n'a de toute façon plus de dossier à en tirer (voir plus haut).
		let mut command = String::new();
		if !config.sandbox.enabled {
			if let Some(dir) = std::path::Path::new(&binary).parent() {
				command.push_str(&export_path(dir));
			}
		}
		command.push_str(&format!(
			"{} -p --input-format stream-json --output-format stream-json --verbose",
			shell_quote(&binary)
		));
		command.push_str(&format!(" --permission-mode {}", shell_quote(&mode)));

		// Ce que font les sous-agents, ou rien du tout.
		//
		// Un agent à qui l'on demande de déléguer répond « d'accord » et lance ses
		// sous-agents ; le CLI, lui, n'en dit pas un mot avant que le dernier ait
		// rendu son résultat. On voyait donc un appel `Task` qui tournait, sans
		// savoir qui travaillait, sur quoi, ni où il en était — et rien n'y
		// paraissait quand il partait dans la mauvaise direction.
		//
		// Ce drapeau fait remonter leurs messages dans le flux, chacun étiqueté de
		// l'appel qui l'a créé (`parent_tool_use_id`), de son type et de sa
		// consigne. Vérifié sur une délégation réelle : la consigne reçue, chaque
		// outil lancé, ce que ces outils ont répondu, et la conclusion.
		if forwards_subagents(&binary) {
			command.push_str(" --forward-subagent-text");
		}

		// Le modèle se choisit au lancement, comme les autorisations : en changer
		// veut dire relancer le CLI sur la même session Claude. Sans consigne, on
		// laisse le CLI appliquer le réglage du poste.
		if let Some(model) = model.as_deref().filter(|m| !m.trim().is_empty()) {
			command.push_str(&format!(" --model {}", shell_quote(model.trim())));
		}

		// Le pont d'autorisation transforme chaque demande de l'agent en question
		// posée dans l'interface. Sans Node sur le poste il n'est pas installé, et
		// l'agent s'en tient alors au mode choisi ci-dessus.
		//
		// Il est passé quel que soit le mode, `bypassPermissions` compris : ce n'est
		// pas seulement le canal des autorisations, c'est le seul par lequel un agent
		// sans terminal peut nous adresser un `AskUserQuestion`. En bypass il ne sert
		// donc plus qu'à ça — et c'est justement ce qu'on ne veut pas perdre.
		// Les outils que le dépôt déclare pour lui-même (`.mcp.json`). Le CLI lit
		// bien ce fichier tout seul, mais n'active ses serveurs qu'après une
		// approbation qu'il demande **par répertoire**, et de façon interactive.
		// Un agent sans terminal ne peut pas y répondre : les serveurs restaient
		// donc inactifs, en silence. Et comme chaque worktree est un répertoire
		// neuf, aucun n'était jamais approuvé — un agent lancé sur un chantier
		// n'avait aucun des outils de son propre dépôt, là où le même dépôt
		// ouvert dans un terminal les avait tous.
		//
		// Les joindre explicitement les rend disponibles — une fois leur contenu
		// approuvé dans les Réglages (`mcp::approve`) : ce sont des commandes que
		// le dépôt fait lancer, et un dépôt cloné peut y écrire n'importe quoi.
		// Vérifié sur un worktree réel : « aucun serveur » avant, les treize
		// attendus après. `--mcp-config` ajoute, il ne remplace pas (ce serait
		// `--strict-mcp-config`) : les serveurs du compte restent là.
		if let Some(declares) = crate::mcp::config_for(&cwd, config.sandbox.enabled) {
			command.push_str(&format!(
				" --mcp-config {}",
				shell_quote(&seen_by_agent(&declares, config.sandbox.enabled))
			));
		}

		// Son navigateur : celui du workspace, qu'on regarde depuis l'onglet
		// « Navigateur ». Il ne démarre qu'à son premier geste. Un agent de
		// revue lit du code, il n'ouvre rien.
		if !reviewing {
			if let Some(browser) = crate::browser::mcp_config(&cwd, config.sandbox.enabled) {
				command.push_str(&format!(
					" --mcp-config {}",
					shell_quote(&seen_by_agent(&browser, config.sandbox.enabled))
				));
			}
		}

		let bridge = crate::permissions::bridge_arguments(config.sandbox.enabled);
		// Le pont porte aussi l'outil de liste d'étapes.
		let steps = bridge.is_some();
		match bridge {
			Some((config, tool)) => command.push_str(&format!(
				" --mcp-config {} --permission-prompt-tool {}",
				shell_quote(&config),
				shell_quote(&tool)
			)),
			// Dégradé, mais dit. Un agent qui ne peut plus poser de question s'arrête
			// en silence sur un travail qui attendait une réponse : autant savoir que
			// ce canal n'existe pas sur ce poste, et pourquoi.
			None => {
				static ANNONCE: OnceLock<()> = OnceLock::new();
				ANNONCE.get_or_init(|| {
					crate::journal::record(
						"agent",
						&crate::i18n::t("agent.bridgeUnavailable.title"),
						&crate::i18n::t("agent.bridgeUnavailable.subject"),
						false,
						&crate::i18n::t(if cfg!(windows) {
							"windowsAgents.bridgeUnavailableDetail"
						} else {
							"agent.bridgeUnavailable.detail"
						}),
					);
				});
			}
		}
		// La revue : son outil de remise, l'écriture retirée, la lecture permise
		// sans demander. Le reste passe par le pont, qui le refuse.
		if reviewing {
			if let Some(config) = crate::review::bridge_config(config.sandbox.enabled) {
				command.push_str(&format!(" --mcp-config {}", shell_quote(&config)));
			}
			if locked {
				command.push_str(" --disallowedTools");
				for tool in crate::review::WRITE_TOOLS {
					command.push_str(&format!(" {}", shell_quote(tool)));
				}
				command.push_str(" --allowedTools");
				for tool in crate::review::READ_TOOLS {
					command.push_str(&format!(" {}", shell_quote(tool)));
				}
			}
		}
		// Les outils de mission ne sont donnés qu'au maître : un exécutant qui
		// pourrait en lancer d'autres n'aurait plus de périmètre du tout.
		if seat == MissionSeat::Master {
			if let Some(config) = crate::orchestrator::bridge_config(config.sandbox.enabled) {
				command.push_str(&format!(" --mcp-config {}", shell_quote(&config)));
			}
		}
		// Un exécutant (une tâche de mission) reçoit le garde-fou git : pas de
		// push forcé, pas de push sur une branche protégée, pas de branche à
		// lui. Un hook du CLI, qui tient en `bypassPermissions` (voir `guard.rs`).
		if executor {
			if let Some(settings) = crate::guard::settings_argument(config.sandbox.enabled) {
				command.push_str(&format!(" --settings {}", shell_quote(&settings)));
			}
		}
		// Rendre compte en images, quand elles valent mieux que du texte. La
		// consigne s'ajoute à celles du CLI plutôt que de partir en message : elle
		// doit être là avant le premier geste — une capture « avant » ne se prend
		// plus une fois le code changé — et ne rien écrire dans la conversation.
		// Un agent de revue ne produit rien : il n'en reçoit pas.
		command.push_str(&format!(
			" --append-system-prompt {}",
			shell_quote(&standing_instructions(reviewing, steps))
		));
		if let Some(session) = resume.filter(|s| !s.trim().is_empty()) {
			command.push_str(&format!(" --resume {}", shell_quote(&session)));
		}
		// La profondeur demandée, traduite par le moteur lui-même. Le cockpit
		// exprime une intention et n'invente aucun drapeau : un moteur qui ne
		// déclare rien n'en reçoit rien, plutôt qu'une ligne de commande refusée.
		if !depth.trim().is_empty() {
			let args = engine.depth_args(&depth);
			if !args.is_empty() {
				command.push(' ');
				command.push_str(args);
			}
		}

		// Ce que le moteur ajoute de son côté, et que le cockpit ne connaît pas.
		if !engine.extra_args.trim().is_empty() {
			command.push(' ');
			command.push_str(engine.extra_args.trim());
		}
		command
	};

	// Rassemblées une fois, pour être posées soit directement (lancement en
	// direct), soit via `-e` (conteneur) — les deux ont besoin des mêmes
	// variables, pas du même moyen de les poser.
	//
	// Le pont d'autorisation, lancé par le CLI, hérite de cet environnement :
	// c'est ainsi qu'une demande sait à quelle conversation elle appartient, et
	// qu'un exécutant ne peut agir que sur la mission qui l'a lancé —
	// l'identifiant vient d'ici, jamais de ce que le maître écrit.
	let mut env_vars: Vec<(String, String)> = vec![
		("COCKPIT_AGENT_SESSION".to_string(), session_id.clone()),
		("COCKPIT_PERMISSION_MODE".to_string(), mode.clone()),
		(
			"COCKPIT_MISSION_ID".to_string(),
			mission.clone().unwrap_or_default(),
		),
		("COCKPIT_SCOPE".to_string(), scope.join("\n")),
		// Les branches qu'un exécutant ne pousse jamais : lues par le garde-fou.
		(
			"COCKPIT_PROTECTED_BRANCHES".to_string(),
			if executor {
				mission.as_deref().map(crate::guard::protected_branches).unwrap_or_default().join("\n")
			} else {
				String::new()
			},
		),
		// La racine contre laquelle le pont lit les chemins absolus du CLI.
		// Isolé, l'agent les écrit sous la forme que le conteneur connaît.
		(
			"COCKPIT_CWD".to_string(),
			if config.sandbox.enabled { crate::sandbox::container_path(&cwd) } else { cwd.clone() },
		),
	];
	// Sous quel compte cet agent travaille — le dossier de configuration décidé
	// par le projet. Posé avant l'environnement du moteur, pour la raison qui
	// suit.
	env_vars.extend(crate::config::account_env(&config));

	// L'environnement du moteur passe en dernier : c'est par là qu'il pointe vers
	// un autre service ou porte sa propre clé, et rien de ce que le cockpit ajoute
	// ne doit s'y substituer. Une valeur vide efface la variable plutôt que de
	// poser une chaîne vide, qu'un CLI lirait comme une adresse invalide — dans
	// un conteneur, où rien n'est hérité par défaut, l'effacer revient à ne
	// jamais la poser.
	let mut env_removals: Vec<String> = Vec::new();
	for entry in &engine.env {
		let name = entry.name.trim();
		if name.is_empty() {
			continue;
		}
		if entry.value.trim().is_empty() {
			env_removals.push(name.to_string());
		} else {
			env_vars.push((name.to_string(), entry.value.trim().to_string()));
		}
	}

	// L'isolation par conteneurs est une intégration de plus, éteinte tant que
	// personne ne l'a demandée : voir `sandbox.rs`. Activée sans runtime
	// installé, on refuse plutôt que de retomber en direct sans le dire — un
	// agent qu'on croit isolé et qui ne l'est pas est pire qu'un agent qui ne
	// démarre pas.
	// Le jeton de la forge, relevé une fois : dans un conteneur, c'est la seule
	// façon pour l'agent de lire une pull request, d'en ouvrir une, ou de
	// pousser sa branche. Sur le poste, `gh` s'en charge déjà tout seul — on ne
	// le pose donc que là où il manque, et jamais dans l'environnement d'un
	// agent qui n'en a pas besoin.
	let forge_token = if config.sandbox.enabled {
		crate::integrations::github_token(&config).await.unwrap_or_default()
	} else {
		String::new()
	};

	let sandbox_cfg = &config.sandbox;
	let runtime = if sandbox_cfg.enabled {
		let runtime = crate::sandbox::resolve_runtime(&sandbox_cfg.runtime).ok_or_else(|| {
			CockpitError::msg(crate::i18n::t("agent.sandboxNoRuntimeHint"))
		})?;
		// Manque à l'appel : Cockpit la construit lui-même plutôt que de refuser
		// en laissant deviner comment la fabriquer — voir `sandbox::ensure_image`.
		crate::sandbox::ensure_image(&runtime, sandbox_cfg)
			.await
			.map_err(|error| {
				CockpitError::msg(crate::i18n::tf("agent.sandboxImageFailed", &[("error", &error)]))
			})?;
		Some(runtime)
	} else {
		None
	};

	// Détaché ou non. Seuls les agents de workspace lancés à la main le sont :
	// une mission, la Permanence ou une revue ont leur propre reprise, et un
	// maître qui survivrait à côté de celui que `relaunch_mission_masters`
	// relance ferait deux maîtres sur la même mission. Les conteneurs et les
	// autres moteurs gardent aussi leurs tuyaux — ni l'un ni l'autre n'a été
	// éprouvé dans un relais.
	let detach = runtime.is_none()
		&& dialect == crate::protocol::Protocol::Claude
		&& mission.is_none()
		&& !reviewing
		&& origin.actor == crate::journal::HUMAN
		&& origin.role.is_empty()
		&& crate::relay::setting().enabled;

	let (child, mut stdin, stdout, stderr, relay) = if detach {
		let handle =
			crate::relay::spawn(&session_id, &cwd, &command, &env_vars, &env_removals, "")?;
		(
			None,
			Input::Relay(handle.clone()),
			Lines::Tail(crate::relay::Tail::from_start(&handle.dir, "out.jsonl")),
			Some(Lines::Tail(crate::relay::Tail::from_start(&handle.dir, "err.log"))),
			Some(handle),
		)
	} else {
		let mut launcher = match &runtime {
			Some(runtime) => {
				let sandboxed: Vec<(String, String)> = env_vars
					.iter()
					.filter(|(name, _)| !env_removals.contains(name))
					.cloned()
					.collect();
				crate::sandbox::build(
					sandbox_cfg,
					runtime,
					&session_id,
					&cwd,
					&sandboxed,
					&command,
					&forge_token,
				)
			}
			None => {
				let mut native = crate::platform::shell_async(&command);
				native.current_dir(&cwd);
				for (name, value) in &env_vars {
					native.env(name, value);
				}
				for name in &env_removals {
					native.env_remove(name);
				}
				native
			}
		};

		launcher
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.kill_on_drop(true);

		let mut child = launcher
			.spawn()
			.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.launchError", &[("error", &e)])))?;

		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.outputUnavailable")))?;
		let stderr = child.stderr.take();
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.inputUnavailable")))?;
		(
			Some(child),
			Input::Pipe(stdin),
			Lines::Out(BufReader::new(stdout).lines()),
			stderr.map(|stderr| Lines::Err(BufReader::new(stderr).lines())),
			None,
		)
	};

	// L'exécution s'ouvre ici, et pas avant : plus tôt, un lancement refusé
	// (dossier introuvable, mémoire saturée, protocole inconnu) laisserait une
	// trace pour un agent qui n'a jamais existé. Plus tard, un process déjà
	// parti travailler n'aurait rien qui le rattache à qui l'a demandé.
	let execution = crate::executions::open(crate::executions::Opening {
		session_id: session_id.clone(),
		protocol: protocol.clone(),
		engine: engine.id.clone(),
		engine_label: engine.label.clone(),
		model: model_label,
		mission: mission.clone().unwrap_or_default(),
		origin,
		cwd: cwd.clone(),
		project: config.active_project.clone(),
		sandboxed: config.sandbox.enabled,
	});
	// La fiche du relais apprend son exécution : c'est la même qui continuera
	// si le cockpit se ferme, pas une nouvelle au redémarrage.
	if let Some(relay) = &relay {
		crate::relay::update_meta(&relay.dir, |meta| meta.execution = execution.clone());
	}

	// Ce qu'on a demandé ne revient pas par la sortie du moteur : sans cette
	// ligne, une timeline s'ouvrirait sur une réponse dont on aurait perdu la
	// question.
	if !prompt.trim().is_empty() {
		crate::executions::note_events(
			&execution,
			&[crate::executions::ExecEvent::Prompt {
				text: crate::executions::clip_text(prompt.trim()),
			}],
		);
	}

	// Nom du conteneur, pour que `stop`/`stop_all` puisse le tuer explicitement :
	// `child.start_kill()` seul n'arrête que le client, jamais le conteneur lui-
	// même (vérifié empiriquement, voir la doc de `sandbox.rs`).
	let container = runtime
		.as_ref()
		.map(|runtime| (runtime.clone(), session_id.clone()));

	// Seul Claude Code lit la suite sur son entrée, qui reste donc ouverte. Pour
	// les deux autres, elle se referme ici : `codex exec` l'attendrait sans fin
	// (« Reading additional input from stdin… »), et Gemini y ajoute lui aussi ce
	// qu'il y lit à son message.
	let stdin = match dialect {
		crate::protocol::Protocol::Claude => {
			if !prompt.trim().is_empty() {
				stdin
					.write(&user_message(prompt.trim()))
					.await
					.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.firstMessageError", &[("error", &e)])))?;
			}
			Some(stdin)
		}
		crate::protocol::Protocol::Codex => {
			stdin
				.write(prompt.trim())
				.await
				.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.firstMessageError", &[("error", &e)])))?;
			None
		}
		crate::protocol::Protocol::Gemini => None,
	};

	let per_turn = (!dialect.keeps_process()).then(|| PerTurn {
		binary: binary.clone(),
		thread_id: None,
		args: codex_args.clone(),
		env: env_vars.clone(),
		env_removals: env_removals.clone(),
	});

	agents.sessions.lock().unwrap().insert(
		session_id.clone(),
		Running {
			cwd: cwd.clone(),
			execution: execution.clone(),
			stdin,
			child,
			relay,
			protocol: dialect,
			container,
			claude_session_id: None,
			turn_done: false,
			turn_started_at: std::time::Instant::now(),
			per_turn,
		},
	);

	// Lecture de la sortie : chaque ligne est un objet JSON complet — même
	// lecture pour ce lancement et pour un tour relancé par `send` chez un
	// agent par tour (`codex-exec`), voir `spawn_reader`.
	spawn_reader(
		app.clone(),
		agents.clone(),
		session_id.clone(),
		execution.clone(),
		dialect,
		stdout,
		stderr,
	);

	Ok(session_id)
}

/// La preuve filmée d'un tour (voir `proof.rs`) : le premier geste dans le
/// navigateur du workspace ouvre l'enregistrement, la fin du tour le monte et
/// l'annonce à l'interface comme un événement du fil.
///
/// Tout part en tâche détachée : la lecture du flux ne doit jamais attendre un
/// navigateur ni ffmpeg.
fn film_the_proof(app: &AppHandle, agents: &SharedAgents, session_id: &str, payload: &Value, turn_over: bool) {
	use tauri::Manager;
	let touches_browser = payload["type"] == "assistant"
		&& payload["message"]["content"].as_array().is_some_and(|blocks| {
			blocks.iter().any(|block| {
				block["type"] == "tool_use" && block["name"].as_str().is_some_and(crate::proof::is_browser_tool)
			})
		});
	if !touches_browser && !turn_over {
		return;
	}
	let Some(cwd) = agents.sessions.lock().unwrap().get(session_id).map(|running| running.cwd.clone()) else {
		return;
	};
	let session = session_id.to_string();
	if touches_browser {
		let browsers = app.state::<crate::browser::SharedBrowsers>().inner().clone();
		tauri::async_runtime::spawn(async move { crate::proof::touch(browsers, &cwd, &session).await });
		return;
	}
	let app = app.clone();
	tauri::async_runtime::spawn(async move {
		let film = crate::proof::finish(&cwd, &session).await;
		// L'enregistrement fermé, le flux qu'il gardait ouvert s'arrête — sauf si
		// l'onglet Navigateur le regarde.
		crate::browser::release(app.state::<crate::browser::SharedBrowsers>().inner(), &cwd);
		if let Some(film) = film {
			let _ = app.emit(
				"agent://event",
				AgentEvent {
					session_id: session,
					payload: crate::proof::event(&film),
				},
			);
		}
	});
}

/// Ce qu'on retient pour expliquer une mort anormale.
///
/// Le tampon porte tout ce que le process a dit et qui n'était pas un événement
/// du protocole : son canal d'erreur, et les lignes de sa sortie qui n'étaient
/// pas du JSON. C'est souvent la seule trace de ce qui n'allait pas, puisqu'un
/// agent mort avant sa première réponse n'a laissé ni session ni transcript.
///
/// Borné : une pile d'appels de plusieurs milliers de lignes noierait le journal
/// sans rien apprendre de plus que ses premières.
fn death_detail(lines: &[String]) -> String {
	let dit = lines.join("\n");
	if dit.trim().is_empty() {
		crate::i18n::t("agent.silentDeath")
	} else {
		dit.chars().take(2000).collect()
	}
}

/// Branche la lecture de la sortie d'un agent — process initial ou tour
/// relancé (`codex-exec`), le protocole dicte seulement comment lire deux
/// signaux communs aux deux : l'identifiant à retenir pour reprendre la
/// conversation, et la fin d'un tour. Ne rend rien : les tâches vivent tant
/// que le process vit, et se terminent avec lui.
fn spawn_reader(
	app: AppHandle,
	agents: SharedAgents,
	session_id: String,
	execution: String,
	dialect: crate::protocol::Protocol,
	stdout: Lines,
	stderr: Option<Lines>,
) {
	// Ce que l'agent a écrit sur son erreur standard, retenu le temps de sa
	// vie — pas seulement émis en direct. Un agent qui meurt avant la
	// première réponse (image absente, binaire introuvable dans un
	// conteneur…) n'a laissé ni session Claude ni transcript à relire ; sans
	// ce tampon, la seule trace de pourquoi disparaît avec l'écouteur qui
	// n'était pas branché à l'instant où elle est passée. Voir son usage
	// plus bas, au moment où la mort s'avère anormale.
	let stderr_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

	// Branché **avant** la lecture de la sortie, et joignable : les deux flux se
	// ferment ensemble à la mort du process, et rien ne garantissait que le
	// tampon d'erreur soit rempli quand l'autre tâche concluait. Elle annonçait
	// donc « rien sur son erreur standard » sur un canal qu'on n'avait pas fini
	// de lire — 61 fois dans le journal de la machine où ce défaut a été trouvé,
	// sans qu'aucune de ces morts ne puisse s'expliquer.
	let stderr_done = stderr.map(|stderr| {
		let session_id = session_id.clone();
		let execution = execution.clone();
		let app = app.clone();
		let buffer = stderr_buffer.clone();
		tokio::spawn(async move {
			let mut lines = stderr;
			while let Some(line) = lines.next().await {
				if line.trim().is_empty() {
					continue;
				}
				if let Ok(mut buffer) = buffer.lock() {
					buffer.push(line.clone());
				}
				crate::executions::note_events(
					&execution,
					&[crate::executions::ExecEvent::Stderr {
						text: crate::executions::clip_text(&line),
					}],
				);
				let _ = app.emit(
					"agent://event",
					AgentEvent {
						session_id: session_id.clone(),
						payload: json!({ "type": "cockpit", "subtype": "stderr", "text": line }),
					},
				);
			}
		})
	});

	{
		let app = app.clone();
		let agents = agents.clone();
		let session_id = session_id.clone();
		let execution = execution.clone();
		let stderr_buffer = stderr_buffer.clone();
		tokio::spawn(async move {
			let mut lines = stdout;
			// Un agent par tour (`codex-exec`) meurt de lui-même à la fin de
			// chaque tour rendu — ce n'est un accident que si rien n'a annoncé
			// la fin avant la fermeture du flux. Distingue les deux à l'EOF.
			let mut finished_cleanly = false;
			// Le verdict du dernier tour rendu : c'est lui qui décide si cette
			// exécution s'est terminée sur une réponse ou sur un échec.
			let mut last_turn_failed = false;
			while let Some(line) = lines.next().await {
				let Ok(payload) = serde_json::from_str::<Value>(&line) else {
					// Pas du JSON : c'est du texte que le CLI a écrit sur sa
					// sortie plutôt que sur son canal d'erreur — ce que font les
					// programmes qui meurent avant d'avoir installé leur mode
					// flux. On le jetait, et la seule trace de ce qui n'allait
					// pas partait avec. Il rejoint le tampon d'erreur, qui est
					// exactement ce qu'on relit quand la mort s'avère anormale.
					if !line.trim().is_empty() {
						if let Ok(mut buffer) = stderr_buffer.lock() {
							buffer.push(line.clone());
						}
						crate::executions::note_events(
							&execution,
							&[crate::executions::ExecEvent::Stderr {
								text: crate::executions::clip_text(&line),
							}],
						);
					}
					continue;
				};

				// L'identifiant à retenir pour reprendre la conversation — sauf
				// chez `gemini-stream-json`, qui n'a rien à reprendre (voir
				// `gemini.rs`) : capturer son `session_id` n'aurait aucun usage,
				// et le ranger dans `claude_session_id` serait faux, ce champ
				// nourrissant la résolution de fichiers propre à Claude Code
				// ailleurs dans le code (`remote.rs`, `orchestrator.rs`).
				let resume_marker = dialect.resume_marker(&payload);
				if let Some(marker) = resume_marker {
					// Noté à la **première** annonce seulement. Claude Code
					// répète sa session sur chacun de ses messages : la relever
					// à chaque fois écrivait cinq lignes identiques par tour
					// dans le relevé — vérifié en marchant — et une conversation
					// longue en aurait écrit des centaines. Le registre sait
					// déjà si on l'a vue passer ; on se sert de ce qu'il sait
					// plutôt que d'ajouter un état pour le redécouvrir.
					let mut premiere = false;
					if let Some(running) = agents.sessions.lock().unwrap().get_mut(&session_id) {
						if !dialect.keeps_process() {
							if let Some(per_turn) = running.per_turn.as_mut() {
								if per_turn.thread_id.is_none() {
									per_turn.thread_id = Some(marker.to_string());
									premiere = true;
								}
							}
						} else if running.claude_session_id.is_none() {
							running.claude_session_id = Some(marker.to_string());
							premiere = true;
							// Le relais la retient aussi : c'est par elle que
							// l'écran relira l'historique d'un agent retrouvé.
							if let Some(relay) = &running.relay {
								let marker = marker.to_string();
								crate::relay::update_meta(&relay.dir, |meta| {
									meta.claude_session_id = Some(marker)
								});
							}
						}
					}
					// C'est par elle qu'on retrouve la source d'une exécution
					// quand le moteur en garde une.
					if premiere {
						crate::executions::mark_engine_session(&execution, marker);
					}
				}

				// Fin de tour : l'agent a rendu sa réponse. Chez le protocole par
				// défaut, c'est le seul moment où l'on sait qu'un exécutant a
				// terminé, son processus lui survivant ; chez `codex-exec`, le
				// processus, lui, va mourir dans l'instant qui suit — mais c'est
				// ce même événement qui dit si c'est de la réussite ou de l'échec.
				// `gemini-stream-json` nomme son événement de fin `result`, comme
				// le protocole par défaut : la détection générique lui convient
				// déjà, sans branche à part.
				let turn_over = dialect.turn_over(&payload);
				film_the_proof(&app, &agents, &session_id, &payload, turn_over);
				// Un tour rendu n'est pas forcément un tour réussi. Codex nomme
				// sa fin ratée (`turn.failed`) ; Claude pose `is_error` sur son
				// `result`. Gemini n'a aucun champ d'échec vérifié : ses tours
				// se comptent donc comme rendus et jamais comme échoués — un
				// échec inventé vaudrait moins qu'un échec absent.
				if turn_over {
					last_turn_failed = dialect.turn_failed(&payload);
					crate::executions::note_turn(&execution, dialect, &payload);
					finished_cleanly = true;
					let cwd = {
						let mut sessions = agents.sessions.lock().unwrap();
						sessions.get_mut(&session_id).map(|running| {
							running.turn_done = true;
							running.cwd.clone()
						})
					};
					if let Ok(mut completed) = agents.completed.lock() {
						completed.insert(session_id.clone());
					}
					// Sceller l'état livré : c'est l'instant, et le seul, où l'on
					// sait que ce que porte le worktree vient de l'agent. Ce qui
					// bougera ensuite aura été repris à la main. Détaché, parce
					// qu'une copie de fichiers n'a pas à retenir le flux.
					if let Some(cwd) = cwd {
						tokio::spawn(async move { crate::notebook::seal(&cwd).await });
					}
				}

				// Le fil de discussion sait déjà lire la forme de Claude Code
				// (`readEvent`, côté écran) : un événement d'un autre protocole s'y
				// traduit avant d'être émis, plutôt que d'apprendre au front une
				// forme de plus par moteur. Seul ce qui a une traduction vérifiée
				// est émis — voir `codex::to_claude_shaped`/`gemini::to_claude_shaped`.
				let to_emit = dialect.to_claude_shaped(crate::chantier::slim(payload));
				if let Some(payload) = to_emit {
					// Le relevé se nourrit de ce qui vient d'être émis, et
					// **après** l'émission : le direct est le chemin vivant, le
					// relevé n'en est qu'une dérivation. Journaliser d'abord
					// ferait payer un écrivain disque à chaque ligne lue.
					crate::executions::note_events(
						&execution,
						&crate::executions::from_claude_shaped(&payload),
					);
					// Le verdict se lit sur le message entier, ici et pas plus
					// tard : ce qui part au relevé est déjà borné, et un rapport
					// de recette conclut au-delà de la borne.
					crate::executions::note_verdict(&execution, &payload);
					// Et le modèle qui parle, qu'on ne connaît pas autrement :
					// ce qu'on a demandé au lancement est presque toujours vide.
					crate::executions::note_model(&execution, &payload);
					let _ = app.emit(
						"agent://event",
						AgentEvent {
							session_id: session_id.clone(),
							payload,
						},
					);
				}
			}

			// Sortie fermée. Pour le protocole par défaut, c'est toujours la mort
			// de l'agent — son process ne devait jamais se terminer tout seul.
			// Pour `codex-exec`, ce n'est la mort que si rien n'a annoncé la fin
			// du tour avant : sinon, c'est le tour qui s'est fini comme prévu, et
			// l'agent reste enregistré — juste sans process vivant en ce moment,
			// prêt à en relancer un pour le tour suivant (`send`, `PerTurn`).
			// `gemini-stream-json` n'a pas cette distinction à faire : il n'y a
			// jamais de tour suivant (voir `gemini.rs`), la mort du process est
			// donc toujours la fin de l'agent, comme pour le protocole par
			// défaut — il suit la branche `else` ci-dessous sans cas particulier.
			if !dialect.keeps_process() && finished_cleanly {
				if let Some(running) = agents.sessions.lock().unwrap().get_mut(&session_id) {
					running.child = None;
					running.stdin = None;
				}
			} else {
				// Mort avant la première réponse (`finished_cleanly` ne s'est jamais
				// mis à vrai) : ni session Claude capturée, ni transcript écrit
				// nulle part — `mission_activity` n'aura plus rien à lire une fois
				// la session retirée du registre. C'est le seul instant où le
				// journal peut encore dire pourquoi.
				if !finished_cleanly {
					// Le canal d'erreur a pu ne pas être vidé : on l'attend
					// plutôt que de conclure sur un tampon à moitié rempli.
					// C'est tout l'intérêt de l'avoir rendu joignable.
					if let Some(handle) = stderr_done {
						let _ = handle.await;
					}
					let detail = death_detail(&stderr_buffer.lock().unwrap());
					crate::journal::record(
						"agent",
						&crate::i18n::t("agent.journal.diedBeforeFirstAnswer"),
						&session_id,
						false,
						&detail,
					);
					crate::executions::note_step(
						&execution,
						crate::executions::Step::LostAtLaunch,
						&detail,
					);
				} else if last_turn_failed {
					crate::executions::note_step(
						&execution,
						crate::executions::Step::Failed,
						&crate::i18n::t("agent.step.lastTurnFailed"),
					);
				} else {
					crate::executions::note_step(
						&execution,
						crate::executions::Step::Answered,
						"",
					);
				}
				let ended = agents.sessions.lock().unwrap().remove(&session_id);
				// Un relais fini n'a plus rien à porter : son dossier part avec
				// lui, sans quoi le démarrage suivant le prendrait pour un mort à
				// signaler.
				if let Some(relay) = ended.and_then(|running| running.relay) {
					let _ = std::fs::remove_dir_all(&relay.dir);
				}
				let _ = app.emit(
					"agent://event",
					AgentEvent {
						session_id: session_id.clone(),
						payload: json!({ "type": "cockpit", "subtype": "ended" }),
					},
				);
			}
		});
	}

}

pub async fn send(app: &AppHandle, agents: &SharedAgents, session_id: &str, text: &str) -> Result<()> {
	if text.trim().is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("agent.emptyMessage")));
	}

	// Avant de relancer l'agent : ce qui a bougé depuis son dernier rendu a été
	// repris à la main, puisque lui ne travaillait pas. C'est le moment de le
	// relever — après, ses propres écritures se confondraient avec la reprise.
	let (cwd, per_turn, execution) = {
		let sessions = agents.sessions.lock().unwrap();
		let running = sessions.get(session_id);
		(
			running.map(|running| running.cwd.clone()),
			running.and_then(|running| running.per_turn.clone()),
			running.map(|running| running.execution.clone()),
		)
	};
	if let Some(execution) = &execution {
		crate::executions::note_events(
			execution,
			&[crate::executions::ExecEvent::Prompt {
				text: crate::executions::clip_text(text.trim()),
			}],
		);
	}
	if let Some(cwd) = &cwd {
		crate::notebook::collect(cwd).await;
	}

	// Un agent par tour (`codex-exec`) n'a plus de process entre deux tours :
	// rien à écrire dessus, il faut en relancer un — voir `respawn_turn`.
	if let Some(per_turn) = per_turn {
		let cwd = cwd.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.notActive")))?;
		return respawn_turn(app, agents, session_id, &cwd, &per_turn, text.trim()).await;
	}

	// On sort le `stdin` du registre le temps d'écrire : le verrou ne doit pas
	// être tenu pendant une écriture asynchrone.
	let mut sessions = agents.sessions.lock().unwrap();
	let running = sessions
		.get_mut(session_id)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.notActive")))?;

	// Un nouveau message rouvre un tour : ce qui suit n'est plus « terminé ».
	running.turn_done = false;
	running.turn_started_at = std::time::Instant::now();

	let stdin = running
		.stdin
		.as_mut()
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.inputUnavailable")))?;
	stdin
		.write_blocking(&user_message(text.trim()))
		.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.sendError", &[("error", &e)])))?;

	Ok(())
}

/// Relance un tour pour un agent dont le process ne reste pas ouvert d'un
/// tour à l'autre (`codex-exec`) : `send` ne peut pas écrire sur une entrée
/// qui n'existe plus, il fait repartir un process — reprise par
/// l'identifiant capturé au tour précédent (`PerTurn::thread_id`), pas une
/// nouvelle conversation.
async fn respawn_turn(
	app: &AppHandle,
	agents: &SharedAgents,
	session_id: &str,
	cwd: &str,
	per_turn: &PerTurn,
	text: &str,
) -> Result<()> {
	let config = crate::config::Config::active();

	// Même garde-fou qu'au premier tour : voir `start_with_mission`.
	let ceiling = config.missions.memory_ceiling();
	if crate::resources::over_ceiling(ceiling) {
		return Err(CockpitError::msg(crate::i18n::tf(
			"agent.memoryCeilingTurn",
			&[("ceiling", &ceiling)],
		)));
	}

	let thread = per_turn.thread_id.as_deref().ok_or_else(|| {
		CockpitError::msg(crate::i18n::t("agent.noThreadYet"))
	})?;
	let command = crate::codex::resume_turn(&per_turn.binary, thread, &per_turn.args);

	let sandbox_cfg = &config.sandbox;
	let runtime = if sandbox_cfg.enabled {
		let runtime = crate::sandbox::resolve_runtime(&sandbox_cfg.runtime).ok_or_else(|| {
			CockpitError::msg(crate::i18n::t("agent.sandboxNoRuntime"))
		})?;
		crate::sandbox::ensure_image(&runtime, sandbox_cfg)
			.await
			.map_err(|error| {
				CockpitError::msg(crate::i18n::tf("agent.sandboxImageFailed", &[("error", &error)]))
			})?;
		Some(runtime)
	} else {
		None
	};

	let mut launcher = match &runtime {
		Some(runtime) => {
			let forge = crate::integrations::github_token(&config).await.unwrap_or_default();
			crate::sandbox::build(sandbox_cfg, runtime, session_id, cwd, &[], &command, &forge)
		}
		None => {
			let mut native = crate::platform::shell_async(&command);
			native.current_dir(cwd);
			for (name, value) in &per_turn.env {
				native.env(name, value);
			}
			for name in &per_turn.env_removals {
				native.env_remove(name);
			}
			native
		}
	};
	launcher
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);

	let mut child = launcher
		.spawn()
		.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.resumeTurnError", &[("error", &e)])))?;
	let container = runtime
		.as_ref()
		.map(|runtime| (runtime.clone(), session_id.to_string()));
	let stdout = child
		.stdout
		.take()
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.outputUnavailable")))?;
	let stderr = child.stderr.take();
	// Le message, puis l'entrée refermée : voir `start_inner`.
	let mut stdin = child
		.stdin
		.take()
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.inputUnavailable")))?;
	stdin
		.write_all(text.as_bytes())
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.sendError", &[("error", &e)])))?;
	drop(stdin);

	let execution;
	{
		let mut sessions = agents.sessions.lock().unwrap();
		let Some(running) = sessions.get_mut(session_id) else {
			// L'agent a été arrêté pendant qu'on préparait la reprise : le process
			// qu'on vient de lancer n'a plus personne à qui appartenir.
			drop(sessions);
			let _ = child.start_kill();
			return Err(CockpitError::msg(crate::i18n::t("agent.notActive")));
		};
		running.child = Some(child);
		running.stdin = None;
		running.container = container;
		running.turn_done = false;
		running.turn_started_at = std::time::Instant::now();
		execution = running.execution.clone();
	}

	// Un process de plus pour la même exécution, jamais une exécution de plus :
	// `codex exec resume` continue la conversation précédente, et compter chaque
	// tour comme un lancement distinct rendrait tous les coûts par exécution
	// illisibles.
	crate::executions::note_step(&execution, crate::executions::Step::Resumed, "");

	spawn_reader(
		app.clone(),
		agents.clone(),
		session_id.to_string(),
		execution,
		crate::protocol::Protocol::Codex,
		Lines::Out(BufReader::new(stdout).lines()),
		stderr.map(|stderr| Lines::Err(BufReader::new(stderr).lines())),
	);

	Ok(())
}

/// Cette session travaille-t-elle en ce moment ?
///
/// Vrai tant que l'agent n'a pas rendu sa réponse. Le processus, lui, survit à
/// son tour : lancé en `stream-json`, le CLI attend le message suivant plutôt
/// que de se terminer. Guetter sa mort revenait à ne jamais rien voir venir —
/// il fallait tuer l'agent pour que sa tâche soit reconnue finie. Le texte qu'il
/// écrit ne fait pas foi non plus : « travail terminé » n'est qu'une phrase.
/// Cette session a-t-elle rendu quelque chose avant de s'éteindre ?
///
/// Faux pour un agent mort au démarrage — binaire introuvable, argument refusé
/// par le CLI. Sa tâche n'a rien livré, et la compter comme faite ferait
/// proposer une pull request sur une branche vide.
/// Coupe le tour en cours sans tuer l'agent.
///
/// Le CLI accepte une requête de contrôle sur son entrée standard : il arrête
/// ce qu'il était en train de faire, répond `success`, et **reste en vie** pour
/// le message suivant. C'est toute la différence avec `stop`, qui emporte le
/// processus et avec lui la conversation : jusqu'ici, se tromper dans une
/// consigne obligeait à couper l'agent et à tout reprendre depuis le début,
/// contexte compris.
pub fn interrupt(agents: &SharedAgents, session_id: &str) -> Result<()> {
	let mut sessions = agents.sessions.lock().unwrap_or_else(|e| e.into_inner());
	let running = sessions
		.get_mut(session_id)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.notActive")))?;

	// Un agent par tour (`codex-exec`) n'a pas de canal de contrôle : le
	// message ci-dessous est un mécanisme du protocole par défaut, pas du
	// dialogue lui-même. Refuser plutôt que de tuer le process en silence —
	// ce serait `stop`, pas `interrupt`, et l'appelant croit encore pouvoir
	// continuer la même conversation juste après.
	let Some(stdin) = running.stdin.as_mut() else {
		return Err(CockpitError::msg(crate::i18n::t("agent.cannotInterrupt")));
	};

	// L'identifiant n'a pas à être unique au-delà de ce tour : personne ne
	// corrèle la réponse, on la lit dans le flux comme le reste.
	let payload = json!({
		"type": "control_request",
		"request_id": format!("interrupt-{}", uuid_like()),
		"request": { "subtype": "interrupt" },
	});

	stdin
		.write_blocking(&format!("{payload}\n"))
		.map_err(|e| CockpitError::msg(crate::i18n::tf("agent.interruptError", &[("error", &e)])))?;

	Ok(())
}

/// Une requête de contrôle posée à un agent vivant, dont la réponse revient par
/// le flux ordinaire.
///
/// Même canal que `interrupt`, même absence de corrélation : le CLI répond par
/// un `control_response` qui traverse la boucle de lecture comme tout le reste,
/// et c'est l'écran qui le reconnaît. Rien à attendre ici, donc rien à bloquer.
fn control(
	agents: &SharedAgents,
	session_id: &str,
	label: &str,
	request: Value,
) -> Result<()> {
	let mut sessions = agents.sessions.lock().unwrap_or_else(|e| e.into_inner());
	let running = sessions
		.get_mut(session_id)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("agent.notActive")))?;

	// Seul Claude Code a un canal de contrôle. Refuser clairement : l'écran
	// n'affichera pas d'état plutôt que d'en inventer un — et un autre moteur
	// ne reçoit pas sur son entrée une ligne qu'il ne sait pas lire.
	if running.protocol != crate::protocol::Protocol::Claude {
		return Err(CockpitError::msg(crate::i18n::t("agent.noControlChannel")));
	}
	let Some(stdin) = running.stdin.as_mut() else {
		return Err(CockpitError::msg(crate::i18n::t("agent.noControlChannel")));
	};

	let payload = json!({
		"type": "control_request",
		"request_id": format!("{label}-{}", uuid_like()),
		"request": request,
	});

	stdin
		.write_blocking(&format!("{payload}\n"))
		.map_err(|e| CockpitError::msg(format!("{label} : {e}")))?;

	Ok(())
}

/// Demande à l'agent où en sont ses serveurs MCP, maintenant.
///
/// L'état annoncé à l'ouverture ne vaut que pour l'instant où il est écrit :
/// mesuré sur seize serveurs, onze s'y déclarent `pending` et sont connectés
/// vingt-cinq secondes plus tard. S'y fier afficherait une avalanche de pannes
/// qui n'existent pas. Seule cette question, posée en cours de session, dit
/// l'état réel — et distingue le serveur qui met du temps de celui qui ne
/// viendra jamais.
pub fn probe_mcp(agents: &SharedAgents, session_id: &str) -> Result<()> {
	control(
		agents,
		session_id,
		"mcp-status",
		json!({ "subtype": "mcp_status" }),
	)
}

/// Demande au CLI de quoi est rempli le contexte de cet agent, maintenant.
///
/// La même mesure que `/context`, mais par le canal de contrôle : aucun
/// message dans la conversation, aucun appel au modèle, et une réponse même en
/// plein tour. Elle revient par le flux, allégée au passage (`chantier::slim`).
pub fn probe_context(agents: &SharedAgents, session_id: &str) -> Result<()> {
	control(
		agents,
		session_id,
		"context-usage",
		json!({ "subtype": "get_context_usage" }),
	)
}

/// Relance un serveur MCP tombé, sans toucher à la conversation.
pub fn reconnect_mcp(agents: &SharedAgents, session_id: &str, server: &str) -> Result<()> {
	control(
		agents,
		session_id,
		"mcp-reconnect",
		json!({ "subtype": "mcp_reconnect", "serverName": server }),
	)
}

pub fn has_answered(agents: &SharedAgents, session_id: &str) -> bool {
	agents
		.completed
		.lock()
		.map(|completed| completed.contains(session_id))
		.unwrap_or(false)
}

pub fn is_working(agents: &SharedAgents, session_id: &str) -> bool {
	agents
		.sessions
		.lock()
		.unwrap()
		.get(session_id)
		.is_some_and(|running| !running.turn_done)
}

/// Depuis combien de temps le tour en cours tourne — `None` si l'agent n'est
/// pas en train de travailler (tour fini, ou session inconnue).
pub fn turn_age(agents: &SharedAgents, session_id: &str) -> Option<std::time::Duration> {
	agents
		.sessions
		.lock()
		.unwrap()
		.get(session_id)
		.filter(|running| !running.turn_done)
		.map(|running| running.turn_started_at.elapsed())
}

pub fn stop(agents: &SharedAgents, session_id: &str) -> Result<()> {
	let mut sessions = agents.sessions.lock().unwrap();
	let Some(mut running) = sessions.remove(session_id) else {
		return Ok(());
	};
	let cwd = running.cwd.clone();
	// Un agent arrêté en pleine recette ne rend pas de tour : son film ne se
	// montera jamais, ses images n'ont plus de raison d'être.
	crate::proof::drop_for(session_id);
	crate::executions::note_step(
		&running.execution,
		crate::executions::Step::Stopped,
		&crate::i18n::t("agent.step.stoppedFromCockpit"),
	);
	// Absent entre deux tours d'un agent par tour (`codex-exec`) qui vient de
	// rendre sa réponse — rien à tuer, il n'y a simplement plus de process.
	if let Some(child) = running.child.as_mut() {
		let _ = child.start_kill();
	}
	// Détaché : le groupe entier, puis son dossier — voir `relay::kill`.
	if let Some(relay) = &running.relay {
		crate::relay::kill(relay);
	}
	// Le client ne suffit pas quand l'agent tourne isolé : voir `sandbox.rs`.
	if let Some((runtime, session)) = &running.container {
		crate::sandbox::kill(runtime, session);
	}
	// Le verrou ne doit pas survivre au relevé qui suit : celui-ci lit le disque
	// et n'a aucune raison de tenir le registre des agents pendant ce temps.
	drop(sessions);
	// Le CLI tué, ce qu'il a lancé en arrière-plan vit encore — voir `strays.rs`.
	crate::strays::kill_session(session_id);

	// Fermer une conversation est le second moment où une reprise se relève —
	// et souvent le seul. Beaucoup de corrections se font après le dernier
	// rendu, sans qu'on réécrive jamais à l'agent : les guetter au seul message
	// suivant en laissait passer la moitié.
	// `async_runtime` et non `tokio::spawn` : cette fonction est appelée depuis
	// une commande synchrone, où aucun runtime tokio n'est forcément installé
	// sur le thread courant — `tokio::spawn` y paniquerait.
	tauri::async_runtime::spawn(async move {
		crate::notebook::collect(&cwd).await;
	});
	Ok(())
}

/// Coupe tous les agents — appelé à la fermeture du cockpit.
///
/// Un agent minimisé continue de travailler tant que l'app est ouverte, c'est
/// le but. Mais une fois l'interface fermée, plus personne ne peut ni le lire
/// ni lui répondre : le laisser vivre ne produirait qu'un processus fantôme
/// éditant le dépôt sans témoin.
///
/// Sauf les agents détachés (`relay.rs`) : eux ne sont pas des fantômes, le
/// cockpit suivant les retrouve et reprend leur lecture (`adopt_relays`). Ce
/// qui tue un agent à chaque mise à jour n'était pas une sécurité mais une
/// limite des tuyaux.
pub fn stop_all(agents: &SharedAgents) {
	let mut sessions = agents.sessions.lock().unwrap();
	for (id, mut running) in sessions.drain() {
		// Un agent détaché continue : c'est tout l'objet du relais. On le dit
		// au relevé — l'exécution reste ouverte, elle n'est ni finie ni
		// orpheline — et sur sa fiche, pour que le cockpit suivant sache
		// depuis quand il travaille sans témoin.
		if let Some(relay) = &running.relay {
			crate::executions::note_step(
				&running.execution,
				crate::executions::Step::Detached,
				&crate::i18n::t("agent.step.detached"),
			);
			let at = chrono::Utc::now().to_rfc3339();
			crate::relay::update_meta(&relay.dir, |meta| meta.detached_at = Some(at));
			continue;
		}
		// Écrit avant de tuer, et de façon bloquante comme le reste de cette
		// fonction : l'app meurt dans l'instant, une trace différée n'aurait pas
		// le temps de partir — et une exécution sans fin serait alors comptée
		// pour orpheline au démarrage suivant, ce qu'elle n'est pas.
		crate::executions::note_step(
			&running.execution,
			crate::executions::Step::Stopped,
			&crate::i18n::t("agent.step.cockpitClosed"),
		);
		if let Some(child) = running.child.as_mut() {
			let _ = child.start_kill();
		}
		// Bloquant, pas `kill()` : l'app va mourir dans l'instant, un fire-and-
		// forget n'aurait pas le temps de s'exécuter.
		if let Some((runtime, session)) = &running.container {
			crate::sandbox::kill_blocking(runtime, session);
		}
		// Le `SIGTERM` part à coup sûr ; le `SIGKILL` qui suit, peut-être pas,
		// l'app mourant avant lui. Ce qui y résisterait, le ménage du démarrage
		// suivant le reprend (`strays::sweep`).
		crate::strays::kill_session(&id);
	}
}

/// Ce que le démarrage a retrouvé : les agents repris, et leurs exécutions.
#[derive(Debug, Default)]
pub struct Adopted {
	pub sessions: std::collections::HashSet<String>,
	pub executions: std::collections::HashSet<String>,
}

/// Reprend, au démarrage, les agents qui ont continué sans le cockpit.
///
/// Appelé **avant** que le démarrage ne referme ce qu'il croit orphelin —
/// exécutions, demandes d'autorisation : un agent détaché retrouvé vivant n'est
/// pas un orphelin, et lui refuser sa question en attente reviendrait à le
/// couper quand même. Il rejoint le registre sous son identifiant d'origine ;
/// l'écran l'adopte comme il adopte déjà les agents d'une mission, et relit
/// son historique par sa session Claude.
///
/// Ceux qui sont morts pendant l'absence — fini, planté, poste redémarré —
/// sont refermés proprement, et leur dossier rangé : la reprise classique de
/// `hibernate.tsx` (`--resume`) se charge alors de leur conversation.
pub fn adopt_relays(app: &AppHandle, agents: &SharedAgents) -> Adopted {
	let mut adopted = Adopted::default();
	let (living, dead) = crate::relay::scan();

	for found in dead {
		if !found.meta.execution.is_empty() {
			let code = std::fs::read_to_string(found.dir.join("exit"))
				.ok()
				.map(|raw| raw.trim().to_string());
			let (step, note) = match code.as_deref() {
				Some("0") => (
					crate::executions::Step::Answered,
					"agent.step.detachedFinished",
				),
				_ => (
					crate::executions::Step::Stopped,
					"agent.step.detachedStopped",
				),
			};
			crate::executions::note_step(&found.meta.execution, step, &crate::i18n::t(note));
		}
		let _ = std::fs::remove_dir_all(&found.dir);
	}

	for found in living {
		let meta = found.meta;
		let handle = crate::relay::Handle {
			dir: found.dir.clone(),
			pgid: meta.pgid,
		};
		let turn_done = crate::relay::turn_done(&found.dir);
		agents.sessions.lock().unwrap().insert(
			meta.session_id.clone(),
			Running {
				cwd: meta.cwd.clone(),
				execution: meta.execution.clone(),
				stdin: Some(Input::Relay(handle.clone())),
				child: None,
				relay: Some(handle),
				protocol: crate::protocol::Protocol::Claude,
				container: None,
				claude_session_id: meta.claude_session_id.clone(),
				turn_done,
				turn_started_at: std::time::Instant::now(),
				per_turn: None,
			},
		);
		if !meta.execution.is_empty() {
			crate::executions::note_step(
				&meta.execution,
				crate::executions::Step::Reattached,
				&crate::i18n::t("agent.step.reattached"),
			);
		}
		crate::relay::update_meta(&found.dir, |meta| meta.detached_at = None);
		crate::relay::note_survivor(&meta.session_id);
		adopted.sessions.insert(meta.session_id.clone());
		if !meta.execution.is_empty() {
			adopted.executions.insert(meta.execution.clone());
		}

		// Depuis la fin : ce qui précède se relit par la session Claude, et le
		// rejouer d'ici l'afficherait deux fois.
		let app = app.clone();
		let agents = agents.clone();
		let dir = found.dir;
		tauri::async_runtime::spawn(async move {
			spawn_reader(
				app,
				agents,
				meta.session_id,
				meta.execution,
				crate::protocol::Protocol::Claude,
				Lines::Tail(crate::relay::Tail::from_end(&dir, "out.jsonl")),
				Some(Lines::Tail(crate::relay::Tail::from_end(&dir, "err.log"))),
			);
		});
	}
	adopted
}

/// Un fichier de l'hôte tel que l'agent le lit : depuis le conteneur quand il
/// est isolé (sous Windows, `/c/Users/…` — voir `sandbox::container_path`).
fn seen_by_agent(path: &std::path::Path, sandboxed: bool) -> String {
	let path = path.to_string_lossy().to_string();
	if sandboxed {
		crate::sandbox::container_path(&path)
	} else {
		path
	}
}

pub(crate) fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// Identifiant local, suffisant pour distinguer deux agents de cette session.
fn uuid_like() -> String {
	use std::time::{SystemTime, UNIX_EPOCH};
	let nanos = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_nanos())
		.unwrap_or(0);
	format!("{nanos:x}")
}

#[cfg(test)]
mod write_tests {
	use super::Input;

	/// Une commande IPC synchrone écrit à l'agent depuis le fil principal, hors
	/// de tout runtime : sous Windows, cela faisait tomber l'app.
	#[test]
	fn on_ecrit_a_un_agent_depuis_un_fil_hors_runtime() {
		let mut child = tauri::async_runtime::block_on(async {
			crate::platform::shell_async("cat > /dev/null")
				.stdin(std::process::Stdio::piped())
				.spawn()
				.expect("shell introuvable")
		});
		let mut input = Input::Pipe(child.stdin.take().unwrap());
		let ecrit = std::thread::spawn(move || input.write_blocking("{\"type\":\"user\"}\n").is_ok())
			.join()
			.expect("l'écriture a paniqué hors du runtime");
		assert!(ecrit);
		let _ = tauri::async_runtime::block_on(async { child.kill().await });
	}
}

#[cfg(test)]
mod seat_tests {
	use super::MissionSeat;

	#[test]
	fn la_place_dans_la_mission_se_lit_sur_la_mission_et_la_tache() {
		assert_eq!(MissionSeat::of(None, ""), MissionSeat::None);
		// Une tâche sans mission n'existe pas : rien à recevoir de ce côté.
		assert_eq!(MissionSeat::of(None, "t1"), MissionSeat::None);
		assert_eq!(MissionSeat::of(Some("m1"), "  "), MissionSeat::Master);
		assert_eq!(MissionSeat::of(Some("m1"), "t1"), MissionSeat::Executor);
	}
}

#[cfg(test)]
mod death_tests {
	use super::death_detail;

	#[test]
	fn ce_que_le_process_a_dit_explique_sa_mort() {
		let dit = vec![
			"Error: MCP tool mcp__cockpit__approve not found".to_string(),
			"    at Object.<anonymous>".to_string(),
		];
		let detail = death_detail(&dit);
		assert!(detail.contains("mcp__cockpit__approve"));
		assert!(detail.contains("at Object"));
	}

	#[test]
	fn un_silence_complet_se_dit_comme_un_silence() {
		// Le repli ne doit rester que pour les morts réellement muettes : c'est
		// désormais une information rare, et non le cas ordinaire.
		for vide in [vec![], vec![String::new()], vec!["   ".to_string()]] {
			assert!(death_detail(&vide).contains("without leaving anything"));
		}
	}

	#[test]
	fn une_pile_d_appels_immense_est_bornee() {
		let enorme: Vec<String> = (0..5_000).map(|i| format!("ligne {i}")).collect();
		assert!(death_detail(&enorme).chars().count() <= 2_000);
		// Et ce qu'on garde, ce sont les premières lignes : la cause est en tête,
		// jamais au fond de la pile.
		assert!(death_detail(&enorme).starts_with("ligne 0"));
	}
}
