//! Les outils que le cockpit prête à l'agent maître.
//!
//! Le maître planifie, le cockpit exécute. Ce partage n'est pas un détail
//! d'architecture : découper un ticket demande du jugement, créer une branche
//! et lancer un processus demande de la rigueur. Confier l'un à l'autre donne
//! un orchestrateur qui hallucine des chemins, ou un moteur qui ne sait pas
//! quoi découper.
//!
//! Le maître reste donc un agent Claude Code ordinaire. Il reçoit simplement,
//! par MCP, des outils qui agissent sur sa mission :
//!
//! | Outil            | Ce qu'il fait                                        |
//! |------------------|------------------------------------------------------|
//! | `understand`     | soumet ce qu'il a compris du ticket (mission guidée)  |
//! | `approach`       | soumet son approche, avant tout découpage (guidée)    |
//! | `plan`           | soumet le découpage — la mission attend un accord     |
//! | `status`         | où en sont la mission et ses tâches                   |
//! | `spawn`          | branche, worktree, exécutant lancé                    |
//! | `collect`        | ce qu'une tâche livrée a produit                      |
//! | `rework`         | renvoie une tâche en correction, verdict à l'appui    |
//! | `integrate`      | fusionne les branches sœurs dans l'intégration        |
//! | `report`         | consigne ce qui a été fait, et comment ça marche       |
//! | `pr`             | ouvre la pull request, clôt la mission, range          |
//!
//! Trois garde-fous tiennent l'ensemble. Le maître n'agit que sur **sa** mission
//! — l'identifiant vient de son environnement, jamais de ce qu'il écrit.
//! `spawn` refuse tant que le plan n'a pas été approuvé par un humain. Et le
//! nombre d'exécutants simultanés est plafonné : un maître qui boucle coûterait
//! cher avant qu'on s'en aperçoive.
//!
//! Le transport passe par le disque, comme le pont d'autorisation : un fichier
//! d'appel, un fichier de réponse. C'est moins élégant qu'un socket, mais ça
//! survit à un agent tué et ça n'ouvre aucun port.

use crate::config::config_dir;
use crate::error::{CockpitError, Result};
use crate::mission::{self, Mission, MissionState, Task, TaskState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn calls_dir() -> std::path::PathBuf {
	config_dir().join("orchestrator")
}

fn bridge_path() -> std::path::PathBuf {
	config_dir().join("mcp-mission.mjs")
}

/// Le serveur MCP confié au maître — le strict nécessaire du protocole.
const BRIDGE: &str = include_str!("scripts/mission-bridge.mjs");

/// Écrit le pont et rend le chemin de sa configuration MCP.
///
/// `None` sans Node : le maître se passe alors de ses outils, et le cockpit
/// reste pilotable à la main — c'est dégradé, jamais bloqué.
///
/// Encore fallait-il le vérifier : annoncé sur un poste sans Node, ce pont
/// donnait au maître des outils dont le serveur ne démarrait jamais.
///
/// `sandboxed` : même piège que `permissions::bridge_arguments` — dans un
/// conteneur, `node_binary()` renvoie un chemin macOS introuvable côté
/// Linux. Le nom nu suffit, l'image pose son propre `node` sur son PATH.
pub fn bridge_config(sandboxed: bool) -> Option<String> {
	let node = if sandboxed {
		"node".to_string()
	} else {
		crate::agent::node_binary()?
	};

	std::fs::create_dir_all(calls_dir()).ok()?;
	std::fs::write(bridge_path(), BRIDGE).ok()?;

	let config = config_dir().join("mcp-mission.json");
	// Isolé, le CLI lit ces chemins depuis le conteneur : sous Windows, ils y
	// ont la forme `/c/Users/…` (voir `sandbox::container_path`).
	let seen = |path: &std::path::Path| {
		let path = path.to_string_lossy().to_string();
		if sandboxed {
			crate::sandbox::container_path(&path)
		} else {
			path
		}
	};
	let payload = json!({
		"mcpServers": {
			"mission": {
				"command": node,
				"args": [seen(&bridge_path())],
			}
		}
	});
	std::fs::write(&config, serde_json::to_string_pretty(&payload).ok()?).ok()?;
	Some(seen(&config))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Call {
	pub id: String,
	#[serde(default)]
	pub mission: String,
	pub tool: String,
	#[serde(default)]
	pub input: Value,
}

/// Appels déposés par un maître et pas encore traités.
pub fn pending() -> Vec<Call> {
	let Ok(entries) = std::fs::read_dir(calls_dir()) else {
		return Vec::new();
	};
	entries
		.flatten()
		.filter(|entry| entry.path().extension().is_some_and(|ext| ext == "call"))
		.filter_map(|entry| {
			let raw = std::fs::read_to_string(entry.path()).ok()?;
			let call: Call = serde_json::from_str(&raw).ok()?;
			let _ = std::fs::remove_file(entry.path());
			Some(call)
		})
		.collect()
}

fn reply(id: &str, answer: Value) {
	let path = calls_dir().join(format!("{id}.result"));
	if let Ok(raw) = serde_json::to_string(&answer) {
		let _ = std::fs::write(path, raw);
	}
}

fn ok(value: Value) -> Value {
	let mut payload = json!({ "ok": true });
	if let (Some(map), Some(extra)) = (payload.as_object_mut(), value.as_object()) {
		for (key, item) in extra {
			map.insert(key.clone(), item.clone());
		}
	}
	payload
}

fn failed(message: impl std::fmt::Display) -> Value {
	json!({ "ok": false, "error": message.to_string() })
}

// ──────────────────────────────── Traitement ────────────────────────────────

/// Exécute un appel et écrit sa réponse.
pub async fn handle(app: &tauri::AppHandle, call: Call) {
	let answer = match run(app, &call).await {
		Ok(value) => ok(value),
		Err(error) => failed(error),
	};
	reply(&call.id, answer);
}

async fn run(app: &tauri::AppHandle, call: &Call) -> Result<Value> {
	let mission = mission::get(&call.mission)?;
	let input = &call.input;

	match call.tool.as_str() {
		"understand" => submit_draft(&mission, mission::Step::Understanding, input),
		"approach" => submit_draft(&mission, mission::Step::Approach, input),
		"plan" => submit_plan(&mission, input),
		"status" => Ok(status(&mission)),
		"spawn" => spawn_task(app, &mission, input).await,
		"rework" => rework_task(app, &mission, input),
		"collect" => collect_task(&mission, input).await,
		"integrate" => integrate(&mission).await,
		"report" => report(&mission, input),
		"pr" => open_pr(&mission, input).await,
		other => Err(CockpitError::msg(format!("Unknown tool: {other}"))),
	}
}

/// Le texte d'un champ de l'appel, vide s'il manque.
fn input_text<'a>(input: &'a Value, key: &str) -> &'a str {
	input.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Le texte d'un champ de l'appel, débarrassé de ses blancs, s'il dit quelque chose.
fn input_filled(input: &Value, key: &str) -> Option<String> {
	Some(input_text(input, key).trim())
		.filter(|value| !value.is_empty())
		.map(str::to_string)
}

/// Les rôles qui jugent, ceux du projet de la mission : le ramassage des tâches rendues
/// (`collect_finished_tasks`), `rework` et `integrate` doivent s'accorder sur qui juge,
/// sans quoi une recette passerait les portes ici.
fn verifier_roles(mission: &Mission) -> std::collections::HashSet<String> {
	crate::roles_for(&mission.cwd)
		.into_iter()
		.filter(|role| role.verifies)
		.map(|role| role.id)
		.collect()
}

fn submit_draft(mission: &Mission, step: mission::Step, input: &Value) -> Result<Value> {
	let questions: Vec<String> = input
		.get("questions")
		.and_then(|value| value.as_array())
		.map(|items| {
			items
				.iter()
				.filter_map(|item| item.as_str().map(str::to_string))
				.collect()
		})
		.unwrap_or_default();
	mission::submit_draft(&mission.id, step, input_text(input, "summary"), questions)?;
	Ok(json!({
		"state": step.awaiting(),
		"message": format!(
			"Your {} has been submitted. The user is reviewing it: stop here, their answer \
			 will reach you as a message.",
			step.protocol_label()
		),
	}))
}

fn submit_plan(mission: &Mission, input: &Value) -> Result<Value> {
	let tasks = read_tasks(input, &mission.branch)?;
	if tasks.is_empty() {
		return Err(CockpitError::msg("A plan without tasks commits no one."));
	}
	let count = tasks.len();
	mission::submit_plan(&mission.id, input_text(input, "summary"), tasks)?;
	Ok(json!({
		"state": "awaitingApproval",
		"tasks": count,
		"message": "Plan recorded. It is waiting for the user's approval: \
					only call `spawn` once the mission has moved to `running`.",
	}))
}

fn status(mission: &Mission) -> Value {
	json!({
		"state": mission.state,
		"branch": mission.branch,
		"progress": mission.progress(),
		"tasks": mission.tasks.iter().map(|task| json!({
			"id": task.id,
			"role": task.role,
			"title": task.title,
			"state": task.state,
			"branch": task.branch,
			// Nommée à part quand elle diffère : c'est elle qui porte le
			// travail, et c'est elle que l'intégration fusionnera.
			"workingBranch": mission::working_branch(task),
			"worktree": task.worktree,
			"scope": task.scope,
			// Ce que le cockpit a lu du rapport de cette vérification.
			// Le maître le voit donc même s'il n'a pas relu le fil, et
			// un « blocking » ici ferme la pull request tant qu'il tient.
			"verdict": task.verdict,
			// Les portes du dépôt sur son dernier rendu.
			"gate": task.gate,
			"note": task.note,
		})).collect::<Vec<_>>(),
	})
}

async fn spawn_task(app: &tauri::AppHandle, mission: &Mission, input: &Value) -> Result<Value> {
	if !mission.can_launch() {
		return Err(CockpitError::msg(
			"The breakdown does not have the user's approval yet. Nothing can start before that.",
		));
	}
	let running = mission
		.tasks
		.iter()
		.filter(|task| task.state == TaskState::Running)
		.count();
	if running >= crate::watchers::MAX_RUNNING_TASKS {
		return Err(CockpitError::msg(format!(
			"{running} workers are already running: wait for one before launching another."
		)));
	}

	let task_id = input_text(input, "taskId");
	let task = mission
		.tasks
		.iter()
		.find(|task| task.id == task_id)
		.ok_or_else(|| CockpitError::msg("Unknown task."))?;
	if task.state != TaskState::Planned {
		return Err(CockpitError::msg(format!("This task is already {:?}.", task.state)));
	}

	// Branche et worktree d'abord : un exécutant sans terrain propre
	// écrirait dans celui du maître, et l'isolation ne serait qu'un mot.
	let worktree = prepare_worktree(mission, task).await?;
	mission::set_task_worktree(&mission.id, &task.id, &worktree)?;

	// Le maître, et lui seul : c'est `spawn` qui passe par ici.
	let session = crate::launch_task_agent(app.clone(), &mission.id, &task.id, crate::executions::MASTER).await?;
	Ok(json!({
		"sessionId": session,
		"worktree": worktree,
		"branch": task.branch,
		"message": "Worker launched. Its file edits outside its scope will be refused, and its branch will not be merged if it changes anything else.",
	}))
}

fn rework_task(app: &tauri::AppHandle, mission: &Mission, input: &Value) -> Result<Value> {
	let task_id = input_text(input, "taskId");
	let reason = input_text(input, "reason");
	// Les rôles qui jugent sont ceux du catalogue : ce sont eux qu'on
	// remet en attente, puisqu'ils auront à rejuger le travail corrigé.
	let verifiers = verifier_roles(mission);
	// Les agents des tâches qu'on relance n'ont plus rien à faire : leur
	// laisser la vie revenait à empiler un CLI par reprise, chacun avec
	// son serveur MCP, jusqu'à saturer la machine.
	let sessions: Vec<String> = mission
		.tasks
		.iter()
		.filter(|task| task.id == task_id || verifiers.contains(&task.role))
		.filter_map(|task| task.session_id.clone())
		.collect();
	let updated = mission::rework(&mission.id, task_id, reason, |role| verifiers.contains(role))?;
	if let Some(agents) = {
		use tauri::Manager;
		app.try_state::<crate::agent::SharedAgents>()
	} {
		// La conversation de chaque exécutant est déjà notée à ce stade —
		// `collect_finished_tasks` la capture dès la livraison, avant de
		// couper l'agent (voir `AgentRegistry::claude_session_of`). Ici,
		// l'agent est déjà mort : plus rien à en tirer, seulement à l'arrêter
		// pour de bon si quelque chose l'avait laissé vivant.
		for session in &sessions {
			let _ = crate::agent::stop(agents.inner(), session);
		}
	}
	let task = updated.tasks.iter().find(|task| task.id == task_id);
	Ok(json!({
		"state": "planned",
		"attempts": task.map(|task| task.attempts).unwrap_or(0),
		"remaining": mission::MAX_ATTEMPTS
			.saturating_sub(task.map(|task| task.attempts).unwrap_or(0)),
		"message": "Task sent back for rework. It restarts on its own, and the \
					checks will judge again once it has delivered.",
	}))
}

async fn collect_task(mission: &Mission, input: &Value) -> Result<Value> {
	let task_id = input_text(input, "taskId");
	let task = mission
		.tasks
		.iter()
		.find(|task| task.id == task_id)
		.ok_or_else(|| CockpitError::msg("Unknown task."))?;
	if task.worktree.trim().is_empty() {
		return Err(CockpitError::msg("This task has no worktree."));
	}
	let path = std::path::Path::new(&task.worktree);
	let base = if task.base.is_empty() {
		mission.branch.clone()
	} else {
		task.base.clone()
	};
	let commits = crate::git::run_git(path, &["log", "--oneline", &format!("{base}..HEAD")])
		.await
		.unwrap_or_default();
	let files = crate::git::run_git(path, &["diff", "--stat", &format!("{base}...HEAD")])
		.await
		.unwrap_or_default();
	// `HEAD` suit le worktree : un exécutant parti sur sa propre branche
	// donne ici son vrai travail, et la branche nommée dit où il est.
	Ok(json!({
		"commits": commits,
		"files": files,
		"branch": mission::working_branch(task),
		// Les portes du dépôt sur ce rendu : `none` quand il n'y en a pas.
		"gate": task.gate,
		"gateOutput": task.gate_output,
	}))
}

async fn integrate(mission: &Mission) -> Result<Value> {
	// Jamais dans `mission.cwd` : c'est le dépôt principal, où vit la
	// branche de travail de l'utilisateur. Un merge lancé là atterrit dans
	// ce qui s'y trouvait sorti — et c'est ainsi qu'une mission a fusionné
	// sa tâche dans le `dev` local de quelqu'un.
	let worktree = integration_worktree(mission).await?;
	let cwd = std::path::Path::new(&worktree);

	// Le dossier est peut-être le bon sans être sur la bonne branche :
	// quelqu'un y a basculé ailleurs, ou une résolution de conflit a laissé
	// une HEAD détachée. On ne fusionne pas à l'aveugle.
	let head = crate::git::current_branch(cwd).await.unwrap_or_default();
	if head.trim() != mission.branch.trim() {
		return Err(CockpitError::msg(format!(
			"`{worktree}` is not on `{}` but on `{}`. Put it back on the \
			 integration branch before merging.",
			mission.branch,
			if head.trim().is_empty() {
				"detached HEAD"
			} else {
				head.trim()
			},
		)));
	}

	let verifiers = verifier_roles(mission);
	let merges = merge_delivered_tasks(mission, cwd, &verifiers).await?;

	if merges.conflicts.is_empty() && !merges.merged.is_empty() {
		mission::set_state(&mission.id, MissionState::Integrating, "")?;
	}

	let abandoned = abandoned_with_work(mission, cwd).await;

	// Les preuves de recette suivent, elles que les branches ne portent pas.
	let evidence = gather_evidence(mission, &worktree);

	// Une recette sans trace n'est pas une recette. Le rôle qui vérifie
	// pouvait rendre « c'est bon » sans avoir rien exécuté ni rien
	// déposé : la mission se fermait sur une parole, et personne ne s'en
	// apercevait avant la production. On ne bloque pas — c'est au maître
	// de juger — mais on le dit, et on nomme la tâche concernée.
	let unproven: Vec<String> = mission
		.tasks
		.iter()
		.filter(|task| verifiers.contains(&task.role))
		.filter(|task| matches!(task.state, TaskState::Delivered | TaskState::Integrated))
		.filter(|_| evidence.is_empty())
		.map(|task| task.title.clone())
		.collect();

	let message = integrate_message(&worktree, &merges, &abandoned, &unproven);
	Ok(json!({
		"merged": merges.merged,
		"conflicts": merges.conflicts,
		"gatesFailed": merges.gates_failed,
		"gatesPending": merges.gates_pending,
		"scopeFailed": merges.scope_failed,
		"worktree": worktree,
		"evidence": evidence,
		"evidenceMissing": unproven,
		"abandonedWithWork": abandoned,
		"message": message,
	}))
}

/// Ce qu'un passage d'`integrate` a fait de chaque tâche rendue.
#[derive(Default)]
struct Merges {
	merged: Vec<String>,
	conflicts: Vec<Value>,
	gates_pending: Vec<Value>,
	gates_failed: Vec<Value>,
	scope_failed: Vec<Value>,
}

async fn merge_delivered_tasks(
	mission: &Mission,
	cwd: &std::path::Path,
	verifiers: &std::collections::HashSet<String>,
) -> Result<Merges> {
	let mut merges = Merges::default();

	// Les portes du dépôt (`gates.rs`) : une tâche n'est fusionnée que
	// sur un code de sortie, pas sur ce qu'elle dit d'elle-même. Celles
	// qu'un redémarrage a interrompues repartent ici.
	let gate_commands = crate::gates::commands_for(&mission.cwd);
	crate::gates::ensure(mission);

	for task in &mission.tasks {
		// La branche qui porte le travail, pas celle qu'on lui avait
		// assignée : un exécutant qui s'est créé sa propre branche a bien
		// livré, ailleurs. Fusionner la branche déclarée laissait son code
		// dehors et refermait la mission dessus.
		let branche = mission::working_branch(task).to_string();
		if task.state != TaskState::Delivered || branche.is_empty() {
			continue;
		}
		// Une tâche qui vérifie échappe aux portes seulement si elle n'apporte
		// rien : une recette qui ajoute ses propres tests commite du code comme
		// les autres. Ses deux commits partaient sinon dans l'intégration sans
		// que rien ne les ait joués (bac à sable, mission « total du panier »).
		let own = brings_own_commits(cwd, &branche).await;
		let judges_only = verifiers.contains(&task.role) && !own;
		let decision = mission::gate_decision(task.gate, !gate_commands.is_empty(), judges_only);
		// Rendue avant que les portes existent, ou retrouvée au démarrage :
		// elle passe les portes comme les autres.
		let decision = if decision == mission::GateDecision::Start {
			match crate::gates::start(&mission.id, &task.id) {
				mission::Gate::Running => mission::GateDecision::Pending,
				mission::Gate::Failed => mission::GateDecision::Refuse,
				// Les portes ont disparu des réglages entre-temps.
				_ => mission::GateDecision::Merge,
			}
		} else {
			decision
		};
		match decision {
			mission::GateDecision::Merge => {}
			mission::GateDecision::Pending | mission::GateDecision::Start => {
				merges
					.gates_pending
					.push(json!({ "taskId": task.id, "task": task.title }));
				continue;
			}
			mission::GateDecision::Refuse => {
				// Relue : `start` vient peut-être d'en poser la raison.
				let output = mission::get(&mission.id)
					.ok()
					.and_then(|fresh| fresh.tasks.into_iter().find(|t| t.id == task.id))
					.map(|fresh| fresh.gate_output)
					.unwrap_or_else(|| task.gate_output.clone());
				merges.gates_failed.push(json!({
					"taskId": task.id,
					"task": task.title,
					"output": output,
				}));
				continue;
			}
		}
		// Sans objet pour une tâche qui juge : sa branche porte aussi les
		// fusions de ses sœurs.
		if !task.scope.is_empty() && !verifiers.contains(&task.role) {
			if let Some(refus) = scope_refusal(mission, task, cwd, &branche).await {
				merges.scope_failed.push(refus);
				continue;
			}
		}
		// Une tâche qui vérifie sans rien commiter n'apporte que les
		// fusions de ses sœurs, reçues avant son lancement
		// (`sync_verifier_worktree`). La fusionner à son tour ramenait
		// ces fusions dans la PR : six commits de fusion pour deux
		// commits de travail. Elle est intégrée sans fusion.
		if !own {
			mission::set_task_state(&mission.id, &task.id, TaskState::Integrated, "")?;
			merges.merged.push(branche);
			continue;
		}
		match crate::git::run_git(cwd, &["merge", "--no-ff", "--no-edit", &branche]).await {
			Ok(_) => {
				mission::set_task_state(&mission.id, &task.id, TaskState::Integrated, "")?;
				merges.merged.push(branche);
			}
			Err(error) => {
				merges.conflicts.push(json!({
					"branch": branche,
					"task": task.title,
					"error": error.to_string(),
				}));
				// Un merge en conflit laisse le dossier en plein milieu d'une
				// fusion. Continuer la boucle faisait échouer toutes les
				// branches suivantes sur « you have unmerged files » — des
				// erreurs qui n'avaient rien à voir avec elles et qui
				// masquaient le seul conflit réel. On s'arrête au premier :
				// il se résout ici, et `integrate` se rappelle ensuite.
				break;
			}
		}
	}
	Ok(merges)
}

/// Le refus d'une branche qui sort de son périmètre.
///
/// Le pont d'autorisation ne voit que les outils d'édition : une écriture par `Bash`
/// lui échappe. Le diff, lui, dit ce que la branche change, quel que soit le moyen.
async fn scope_refusal(mission: &Mission, task: &Task, cwd: &std::path::Path, branche: &str) -> Option<Value> {
	let base = if task.base.trim().is_empty() {
		&mission.branch
	} else {
		&task.base
	};
	// Un diff illisible ne vaut pas un diff propre : on ne fusionne pas.
	let mut refus = match files_outside_scope(cwd, base, branche, &task.scope).await {
		Ok(files) if files.is_empty() => return None,
		Ok(files) => json!({ "files": files }),
		Err(error) => json!({ "error": error.to_string() }),
	};
	refus["taskId"] = json!(task.id);
	refus["task"] = json!(task.title);
	refus["scope"] = json!(task.scope);
	Some(refus)
}

/// Les tâches abandonnées dont la branche porte encore du code.
///
/// Une tâche abandonnée peut avoir produit du code avant de renoncer — trois reprises
/// épuisées ne veulent pas dire trois reprises vides. Son travail n'est intégré par
/// personne, et la mission se refermait dessus sans un mot : la branche restait là, sans
/// PR pour la porter et sans rien pour la nommer. On ne bloque pas — renoncer est une
/// décision — mais on ne laisse plus partir en silence.
async fn abandoned_with_work(mission: &Mission, cwd: &std::path::Path) -> Vec<Value> {
	let mut abandoned = Vec::new();
	for task in &mission.tasks {
		if !matches!(task.state, TaskState::Failed) {
			continue;
		}
		let branche = mission::working_branch(task);
		if branche.is_empty() {
			continue;
		}
		let restes = crate::git::run_git(cwd, &["rev-list", "--count", &format!("{}..{branche}", mission.branch)])
			.await
			.ok()
			.and_then(|raw| raw.trim().parse::<u32>().ok())
			.unwrap_or(0);
		if restes > 0 {
			abandoned.push(json!({
				"task": task.title,
				"branch": branche,
				"commits": restes,
			}));
		}
	}
	abandoned
}

fn integrate_message(worktree: &str, merges: &Merges, abandoned: &[Value], unproven: &[String]) -> String {
	if !merges.conflicts.is_empty() {
		return format!(
			"Conflicts remain: resolve them in `{worktree}`, then call \
			 `integrate` again."
		);
	}
	let portes = gates_message(merges);
	let perdu = if abandoned.is_empty() {
		String::new()
	} else {
		let liste = abandoned
			.iter()
			.filter_map(|entry| {
				Some(format!(
					"\"{}\" on `{}` ({} commit(s))",
					entry.get("task")?.as_str()?,
					entry.get("branch")?.as_str()?,
					entry.get("commits")?.as_u64()?,
				))
			})
			.collect::<Vec<_>>()
			.join(", ");
		format!(
			" Warning: {liste} — these tasks were abandoned but \
			 produced code that no integrated branch carries. Integrate it \
			 if it is worth anything, or say explicitly that it is dropped \
			 before opening the pull request."
		)
	};
	let alerte = if unproven.is_empty() {
		String::new()
	} else {
		format!(
			" Warning: {} gave its verdict without leaving any \
			 evidence of execution. Ask it for something to verify it with before \
			 opening the pull request.",
			unproven.join(", "),
		)
	};
	format!(
		"Branches merged into `{worktree}`. It is up to you to validate the whole \
		 before the pull request.{portes}{alerte}{perdu}"
	)
}

fn gates_message(merges: &Merges) -> String {
	let titres = |entries: &[Value]| {
		entries
			.iter()
			.filter_map(|entry| Some(format!("\"{}\"", entry.get("task")?.as_str()?)))
			.collect::<Vec<_>>()
			.join(", ")
	};
	let mut texte = String::new();
	if !merges.gates_failed.is_empty() {
		texte.push_str(&format!(
			" Not merged, the repository checks failed for {}: send them back \
			 with `rework`, quoting the output given in `gatesFailed`.",
			titres(&merges.gates_failed)
		));
	}
	if !merges.scope_failed.is_empty() {
		texte.push_str(&format!(
			" Not merged, the branch changes files outside its scope for {}: send \
			 them back with `rework`, quoting the files given in `scopeFailed`.",
			titres(&merges.scope_failed)
		));
	}
	if !merges.gates_pending.is_empty() {
		texte.push_str(&format!(
			" Not merged yet, the repository checks are still running for {}: \
			 call `integrate` again once `status` shows them finished.",
			titres(&merges.gates_pending)
		));
	}
	texte
}

fn report(mission: &Mission, input: &Value) -> Result<Value> {
	let summary = input_text(input, "summary");
	if summary.trim().is_empty() {
		return Err(CockpitError::msg("An empty report helps no one."));
	}
	mission::set_summary(&mission.id, summary)?;
	Ok(json!({ "message": "Report recorded." }))
}

async fn open_pr(mission: &Mission, input: &Value) -> Result<Value> {
	// Rien n'est fusionné : on ouvre la pull request du travail recomposé,
	// et c'est une relecture humaine qui décidera de la suite.
	let pending: Vec<&str> = mission
		.tasks
		.iter()
		.filter(|task| task.state == TaskState::Delivered)
		.map(|task| task.title.as_str())
		.collect();
	if !pending.is_empty() {
		return Err(CockpitError::msg(format!(
			"These tasks are delivered but not integrated: {}. Call `integrate` first.",
			pending.join(", ")
		)));
	}

	// La base peut être déclarée par le maître : une mission qui prolonge
	// un travail en cours s'empile dessus plutôt que de repartir de la
	// branche par défaut, où sa PR montrerait aussi le travail du voisin.
	if let Some(base) = input_filled(input, "base") {
		mission::set_base(&mission.id, &base)?;
	}
	let mission = mission::get(&mission.id)?;

	// L'équipe a peut-être sa propre façon d'ouvrir une pull request : le bon
	// gabarit, ses labels, l'envoi des captures de recette. Tout cela vit
	// dans une commande du dépôt, que le cockpit ne saurait pas refaire — et
	// qu'un autre projet n'a pas. Quand elle est déclarée, c'est le maître
	// qui la joue, dans son worktree, et qui rend l'adresse obtenue.
	let url = match (input_filled(input, "url"), crate::mission_pr_command(&mission)) {
		// L'adresse est là : la pull request existe déjà, le cockpit n'a plus
		// qu'à en tirer les conséquences.
		(Some(url), _) => {
			if !url.starts_with("http") {
				return Err(CockpitError::msg("`url` expects the URL of the opened pull request."));
			}
			url
		}
		// Commande d'équipe déclarée : on rend la main au maître plutôt que
		// d'ouvrir une pull request qui ignorerait sa méthode.
		(None, Some(command)) => return team_pr_handoff(&mission, &command).await,
		// Aucune méthode maison : le cockpit ouvre la pull request lui-même.
		// Le `git push` part du worktree d'intégration, comme le merge : aucune
		// commande de mission ne s'exécute dans le dépôt principal.
		(None, None) => {
			let title = match input_text(input, "title") {
				title if title.trim().is_empty() => mission.title.as_str(),
				title => title,
			};
			let body = match input_text(input, "body") {
				body if body.trim().is_empty() && !mission.summary.trim().is_empty() => mission.summary.as_str(),
				body => body,
			};
			let from = integration_worktree(&mission).await?;
			crate::open_mission_pr(
				&from,
				&mission.branch,
				&crate::mission_base(&mission).await,
				title,
				body,
			)
			.await?
		}
	};

	mission::finish(&mission.id, &url)?;
	crate::delivery::publish_on_close(&mission.id);
	let removed = mission::cleanup(&mission.id).await.unwrap_or_default();
	Ok(json!({
		"url": url,
		"cleaned": removed,
		"message": "Mission closed, worktrees of the integrated tasks cleaned up.",
	}))
}

async fn team_pr_handoff(mission: &Mission, command: &str) -> Result<Value> {
	let worktree = integration_worktree(mission).await?;
	// Les preuves de recette sont réunies avant de rendre la main : la
	// commande d'équipe les joint à la pull request, et elle les cherche
	// là où elle s'exécute.
	let evidence = gather_evidence(mission, &worktree);
	let count = evidence.len();
	Ok(json!({
		"command": command,
		"worktree": worktree,
		"evidence": evidence,
		"message": format!(
			"This team opens its pull requests with `{command}`. Run it in \
			 `{worktree}`, then call `pr` again with `url` — the URL it \
			 produced. The mission will close at that point. The workers' QA \
			 evidence has been gathered there ({count} file(s) under \
			 `.claude/work/`): git ignores it, it will not leave with the \
			 branch.",
		),
	}))
}

/// Lit les tâches d'un plan, en complétant ce que le maître a laissé implicite.
fn read_tasks(input: &Value, integration: &str) -> Result<Vec<Task>> {
	let entries = input
		.get("tasks")
		.and_then(|value| value.as_array())
		.ok_or_else(|| CockpitError::msg("The plan must carry a list of tasks."))?;

	Ok(entries
		.iter()
		.map(|entry| {
			let text = |key: &str| {
				entry
					.get(key)
					.and_then(|value| value.as_str())
					.unwrap_or_default()
					.to_string()
			};
			let title = text("title");
			let branch = {
				let declared = text("branch");
				if declared.is_empty() {
					// Un nom de branche lisible vaut mieux qu'un identifiant : c'est
					// lui qu'on lira dans `git log` dans six mois.
					format!("{}-{}", integration.trim_end_matches('/'), text("role"))
				} else {
					declared
				}
			};
			Task {
				id: crate::mission::identifier(),
				role: text("role"),
				title,
				brief: text("brief"),
				scope: entry
					.get("scope")
					.and_then(|value| value.as_array())
					.map(|list| list.iter().filter_map(|item| item.as_str().map(String::from)).collect())
					.unwrap_or_default(),
				base: {
					let base = text("base");
					if base.is_empty() {
						integration.to_string()
					} else {
						base
					}
				},
				branch,
				worktree: String::new(),
				session_id: None,
				engine_session: String::new(),
				verdict: String::new(),
				actual_branch: String::new(),
				state: TaskState::Planned,
				note: String::new(),
				attempts: 0,
				reproaches: Vec::new(),
				started_at: None,
				finished_at: None,
				checkpoint: String::new(),
				worked_seconds: 0,
				gate: crate::mission::Gate::None,
				gate_output: String::new(),
				gate_commit: String::new(),
			}
		})
		.collect())
}

/// Crée une branche et son worktree, depuis une base.
///
/// Sert aussi bien aux exécutants qu'au maître : celui-ci travaille sur la
/// branche d'intégration, et n'a pas plus de raison qu'eux d'écrire dans le
/// dépôt principal.
///
/// Le dossier prend le nom de la branche : c'est ce qu'on lit dans le sélecteur
/// de worktrees, et un identifiant opaque y serait illisible.
pub async fn prepare_worktree(mission: &mission::Mission, task: &Task) -> Result<String> {
	let repo = std::path::Path::new(&mission.cwd);
	if !repo.join(".git").exists() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"orchestrator.notAGitRepo",
			&[("path", &mission.cwd)],
		)));
	}

	// La branche est peut-être déjà extraite ailleurs : mission reprise, dossier
	// renommé à la main, worktree créé au clavier. Git refuse de la sortir deux
	// fois, donc on rend le dossier qui la porte — sauf si c'est la copie de
	// travail de l'utilisateur. Y renvoyer un agent, ou y fusionner, revient à
	// commiter dans le dépôt principal.
	if let Some(deja) = crate::git::worktree_for_branch(repo, &task.branch).await? {
		let deja = deja.to_string_lossy().to_string();
		let principal = crate::git::main_worktree(repo)
			.await
			.map(|path| path.to_string_lossy().to_string())
			.unwrap_or_default();
		if same_dir(&deja, &mission.cwd) || same_dir(&deja, &principal) {
			return Err(CockpitError::msg(crate::i18n::tf(
				"orchestrator.branchInMainRepo",
				&[("branch", &task.branch), ("path", &deja)],
			)));
		}
		return Ok(deja);
	}

	let root = crate::config::Config::active().general.projects_root;
	let path = worktree_target(&root, repo, &task.branch);
	if path.exists() {
		// Le dossier porte le nom de la branche ; rien ne garantit qu'il la
		// contienne. Un homonyme — dossier renommé, ancienne mission, clone posé
		// à la main — recevait l'exécutant les yeux fermés, qui commitait alors
		// sur la branche qui s'y trouvait sortie. C'est le même accident que le
		// repli sur le dépôt principal, à un dossier près.
		let chemin = path.to_string_lossy().to_string();
		let dessus = crate::git::current_branch(&path).await.unwrap_or_default();
		if dessus.trim() == task.branch.trim() {
			return Ok(chemin);
		}
		let actuelle = if dessus.trim().is_empty() {
			crate::i18n::t("orchestrator.noBranch")
		} else {
			dessus.trim().to_string()
		};
		return Err(CockpitError::msg(crate::i18n::tf(
			"orchestrator.folderOnOtherBranch",
			&[("path", &chemin), ("current", &actuelle), ("branch", &task.branch)],
		)));
	}

	let base = if task.base.trim().is_empty() {
		mission.branch.clone()
	} else {
		task.base.clone()
	};

	// Une branche qui existe déjà — mission relancée, travail repris — ne se
	// recrée pas : `-b` échouerait, et l'appelant retomberait sur le dépôt
	// principal. On l'extrait telle quelle.
	let existe = crate::git::run_git(repo, &["rev-parse", "--verify", &format!("refs/heads/{}", task.branch)])
		.await
		.is_ok();

	let chemin = path.to_string_lossy().to_string();
	if existe {
		crate::git::run_git(repo, &["worktree", "add", &chemin, &task.branch]).await?;
	} else {
		crate::git::run_git(repo, &["worktree", "add", "-b", &task.branch, &chemin, &base]).await?;
	}
	Ok(chemin)
}

/// Le dossier où créer le worktree d'une branche de mission.
///
/// Sans répertoire de projets réglé — le cas d'une installation neuve —, le
/// chemin restait relatif : git le créait *dans* le dépôt principal, et l'agent,
/// lancé ailleurs, ne trouvait pas son dossier. On se pose alors à côté du
/// dépôt, nommé comme le fait le repli générique des workspaces
/// (`<dépôt>-<branche>`), pour qu'un même worktree ne porte pas deux noms.
fn worktree_target(root: &str, repo: &std::path::Path, branch: &str) -> std::path::PathBuf {
	let folder = branch.replace('/', "-");
	if root.trim().is_empty() {
		// Au niveau du texte plutôt que par `parent().join()` : sous Windows,
		// `join` collait un `\` derrière un dépôt écrit avec des `/`, et l'écran
		// affichait `D:/jorda\dépôt-branche`. On garde le séparateur du dépôt.
		let repo = repo.to_string_lossy();
		let repo = repo.trim_end_matches(std::path::is_separator);
		return std::path::PathBuf::from(format!("{repo}-{folder}"));
	}
	std::path::PathBuf::from(crate::config::resolve_path(root, "")).join(&folder)
}

/// Ce qu'une synchronisation de la cohabitation a donné.
pub struct SyncReport {
	pub merged: Vec<String>,
	pub conflicts: Vec<String>,
}

/// Fusionne dans le worktree d'une tâche qui vérifie tout ce que ses sœurs
/// ont déjà livré.
///
/// Rien d'autre ne le fait avant l'intégration finale : une tâche qui
/// vérifie jugeait donc une branche qui ne contenait rien du travail des
/// autres, et ne découvrait l'incompatibilité qu'en la fusionnant elle-même,
/// à la main, un peu différemment à chaque tour — c'est ce que documentait
/// « vert isolément, ne cohabite pas ». Appelée à chaque lancement, y
/// compris une reprise : les sœurs ont pu livrer du nouveau depuis le tour
/// précédent.
///
/// Un conflit s'annule plutôt que de laisser le worktree au milieu d'une
/// fusion : la tâche qui vérifie ne sait pas le résoudre, seul le maître le
/// sait. Elle continue sur ce qu'elle a, et le conflit se dit dans sa
/// consigne — un fait connu d'avance, pas une découverte au hasard des tours.
pub async fn sync_verifier_worktree(mission: &mission::Mission, task: &Task, worktree: &str) -> Result<SyncReport> {
	let path = std::path::Path::new(worktree);
	let mut report = SyncReport {
		merged: Vec::new(),
		conflicts: Vec::new(),
	};

	for sibling in &mission.tasks {
		if sibling.id == task.id {
			continue;
		}
		if !matches!(sibling.state, TaskState::Delivered | TaskState::Integrated) {
			continue;
		}
		let branche = mission::working_branch(sibling).to_string();
		if branche.is_empty() || branche == task.branch {
			continue;
		}
		// Avance rapide permise, et demandée : sans elle, une vérification qui
		// n'a encore rien commité gagnait un commit de fusion vide à chaque
		// lancement. Ces commits remontaient ensuite dans la PR de la mission
		// — « Merge backend into qa », « into review », puis « into » la
		// branche d'intégration : trois fusions du même travail pour une
		// seule modification. `--ff` l'emporte sur un `merge.ff = false`
		// réglé sur le poste. La fusion de chaque tâche dans la branche
		// d'intégration, elle, garde son commit (`integrate`).
		match crate::git::run_git(path, &["merge", "--ff", "--no-edit", &branche]).await {
			Ok(_) => report.merged.push(branche),
			Err(error) => {
				let _ = crate::git::run_git(path, &["merge", "--abort"]).await;
				report.conflicts.push(format!("`{branche}` ({error})"));
			}
		}
	}

	Ok(report)
}

/// La branche apporte-t-elle un commit à elle, hors fusions, que la branche
/// courante n'a pas encore ?
///
/// Dans le doute — git qui échoue, une sortie illisible — on répond oui : la
/// fusion se fait alors comme avant, et le pire est un commit de fusion de trop.
async fn brings_own_commits(cwd: &std::path::Path, branch: &str) -> bool {
	crate::git::run_git(cwd, &["rev-list", "--count", "--no-merges", &format!("HEAD..{branch}")])
		.await
		.ok()
		.and_then(|raw| raw.trim().parse::<u32>().ok())
		.is_none_or(|count| count > 0)
}

/// Les fichiers qu'une branche change hors de son périmètre, depuis qu'elle a
/// quitté `base`.
///
/// Trois points : ce que l'intégration a reçu entre-temps ne compte pas pour elle.
/// `--no-renames` : un renommage sort aussi du dossier qu'il quitte. `-z` : git
/// citerait sinon les noms accentués, qui ne se compareraient plus au périmètre.
async fn files_outside_scope(cwd: &std::path::Path, base: &str, branch: &str, scope: &[String]) -> Result<Vec<String>> {
	let changed = crate::git::run_git(
		cwd,
		&[
			"diff",
			"--name-only",
			"--no-renames",
			"-z",
			&format!("{base}...{branch}"),
		],
	)
	.await?;
	Ok(changed
		.split('\0')
		.map(str::trim)
		.filter(|path| !path.is_empty() && !mission::within_scope(scope, path))
		.map(str::to_string)
		.collect())
}

/// Deux chemins qui désignent le même dossier.
///
/// Comparaison textuelle après résolution des liens : `~/Sites/app`,
/// `~/Sites/app/` et un chemin passé par `/private/tmp` désignent le même
/// endroit, et une garde qui ne le voit pas ne garde rien.
fn same_dir(left: &str, right: &str) -> bool {
	let clean = |value: &str| {
		let path = std::path::Path::new(value.trim());
		crate::platform::path_key(
			&std::fs::canonicalize(path)
				.unwrap_or_else(|_| path.to_path_buf())
				.to_string_lossy(),
		)
	};
	!left.trim().is_empty() && !right.trim().is_empty() && clean(left) == clean(right)
}

/// Rassemble les preuves de recette dans le worktree d'intégration.
///
/// Elles vivent dans le worktree de la tâche qui les a produites, hors des
/// branches puisque git les ignore. C'est pourtant depuis le worktree
/// d'intégration que la pull request s'ouvre, et c'est là qu'il faut les joindre.
/// On les y recopie donc, sans jamais les commiter : la branche qui partira en
/// production n'en porte pas la moindre trace.
fn gather_evidence(mission: &mission::Mission, into: &str) -> Vec<String> {
	let into = std::path::Path::new(into);
	let mut collected = Vec::new();
	for task in &mission.tasks {
		if task.worktree.trim().is_empty() {
			continue;
		}
		collected.extend(crate::qa::collect_into(std::path::Path::new(&task.worktree), into));
	}
	collected.sort();
	collected.dedup();
	collected
}

/// Le dossier où la mission recompose : le worktree de sa branche d'intégration.
///
/// Le maître y travaille et `integrate` y fusionne — le même dossier pour les
/// deux, sinon le maître validerait un état qui n'est pas celui qu'on a
/// fusionné. Il est créé s'il manque, et jamais remplacé par le dépôt principal.
pub async fn integration_worktree(mission: &mission::Mission) -> Result<String> {
	if mission.branch.trim().is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("orchestrator.noIntegrationBranch")));
	}
	let task = Task {
		id: String::new(),
		role: crate::config::MASTER_ROLE.into(),
		title: mission.title.clone(),
		brief: String::new(),
		scope: Vec::new(),
		base: crate::mission_base(mission).await,
		branch: mission.branch.clone(),
		worktree: String::new(),
		session_id: None,
		engine_session: String::new(),
		verdict: String::new(),
		actual_branch: String::new(),
		state: TaskState::Planned,
		note: String::new(),
		attempts: 0,
		reproaches: Vec::new(),
		started_at: None,
		finished_at: None,
		checkpoint: String::new(),
		worked_seconds: 0,
		gate: crate::mission::Gate::None,
		gate_output: String::new(),
		gate_commit: String::new(),
	};
	prepare_worktree(mission, &task).await
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Sans répertoire de projets, le worktree d'une mission se créait dans le
	/// dépôt principal, sous un chemin relatif que l'agent ne retrouvait pas.
	#[test]
	fn sans_racine_le_worktree_de_mission_se_pose_a_cote_du_depot() {
		let repo = std::env::temp_dir().join("demo-shop");
		let path = worktree_target("", &repo, "feat/#1-cart-total");
		assert!(path.is_absolute(), "{}", path.display());
		assert_eq!(path, std::env::temp_dir().join("demo-shop-feat-#1-cart-total"));
		assert!(!path.starts_with(&repo), "{}", path.display());

		// Un seul séparateur dans le chemin affiché : celui du dépôt.
		let path = worktree_target("", std::path::Path::new("D:/jorda/demo-shop/"), "feat/x");
		assert_eq!(path.to_string_lossy(), "D:/jorda/demo-shop-feat-x");

		let root = std::env::temp_dir().join("projets");
		let path = worktree_target(&root.to_string_lossy(), &repo, "feat/x");
		assert_eq!(path, root.join("feat-x"));
	}

	/// Un plan incomplet ne doit pas produire de tâches bancales : ce que le
	/// maître laisse implicite se complète, il ne se perd pas.
	#[test]
	fn le_plan_se_complete() {
		let input = json!({
			"tasks": [
				{ "role": "backend", "title": "API de facturation" },
				{ "role": "frontend", "title": "Écran de facturation", "branch": "feat/x-web" },
			]
		});
		let tasks = read_tasks(&input, "feat/x").unwrap();

		// Sans base déclarée, on part de l'intégration.
		assert_eq!(tasks[0].base, "feat/x");
		// Sans branche déclarée, elle se dérive du rôle, et reste lisible.
		assert_eq!(tasks[0].branch, "feat/x-backend");
		assert_eq!(tasks[1].branch, "feat/x-web");
		assert!(tasks.iter().all(|task| task.state == TaskState::Planned));
	}

	/// Une tâche sans identifiant est introuvable : elle ne peut être ni marquée
	/// lancée ni rattachée à sa session, et le lanceur repart dessus à chaque
	/// tour. C'est ce qui avait ouvert vingt-huit agents pour un plan de cinq
	/// tâches.
	#[test]
	fn chaque_tache_recoit_un_identifiant() {
		let input = json!({
			"tasks": [
				{ "role": "backend", "title": "API" },
				{ "role": "frontend", "title": "Écran" },
			]
		});
		let tasks = read_tasks(&input, "feat/x").unwrap();

		assert!(tasks.iter().all(|task| !task.id.trim().is_empty()));
		assert_ne!(tasks[0].id, tasks[1].id);
	}

	/// Un plan sans tâche n'est pas un plan.
	#[test]
	fn un_plan_vide_est_refuse() {
		assert!(read_tasks(&json!({}), "feat/x").is_err());
	}

	/// La garde qui protège le dépôt principal se compare sur des dossiers, pas
	/// sur des chaînes : un slash final la contournait, et le merge repartait
	/// dans la copie de travail de l'utilisateur.
	#[test]
	fn le_meme_dossier_se_reconnait_malgre_le_slash() {
		assert!(same_dir("/tmp/projet", "/tmp/projet/"));
		assert!(same_dir(" /tmp/projet ", "/tmp/projet"));
		assert!(!same_dir("/tmp/projet", "/tmp/projet-integration"));
		// Un chemin absent ne désigne rien : on ne bloque pas là-dessus.
		assert!(!same_dir("", "/tmp/projet"));
	}

	/// De vraies commandes git, comme ailleurs dans le projet : simuler git
	/// reviendrait à tester notre imitation, pas le comportement réel.
	fn depot_jetable(nom: &str) -> std::path::PathBuf {
		let dir = std::env::temp_dir().join(format!("cockpit-orch-{}-{nom}", std::process::id()));
		std::fs::remove_dir_all(&dir).ok();
		std::fs::create_dir_all(&dir).unwrap();
		let git = |args: &[&str], cwd: &std::path::Path| {
			let sortie = std::process::Command::new("git")
				.args(args)
				.current_dir(cwd)
				.output()
				.expect("git est installé sur ce poste");
			assert!(
				sortie.status.success(),
				"git {args:?} a échoué : {}",
				String::from_utf8_lossy(&sortie.stderr)
			);
		};
		git(&["init", "--quiet", "--initial-branch=main"], &dir);
		git(&["config", "user.email", "test@example.invalid"], &dir);
		git(&["config", "user.name", "Test"], &dir);
		std::fs::write(dir.join("lisez-moi.md"), "socle\n").unwrap();
		git(&["add", "."], &dir);
		git(&["commit", "--quiet", "-m", "Pose le socle"], &dir);
		git(&["checkout", "--quiet", "-b", "feat/x"], &dir);
		dir
	}

	fn worktree_de(depot: &std::path::Path, branche: &str, depuis: &str) -> std::path::PathBuf {
		let chemin = depot.parent().unwrap().join(format!(
			"{}-{}",
			depot.file_name().unwrap().to_string_lossy(),
			branche.replace('/', "-")
		));
		let sortie = std::process::Command::new("git")
			.args(["worktree", "add", "-b", branche, &chemin.to_string_lossy(), depuis])
			.current_dir(depot)
			.output()
			.expect("git est installé sur ce poste");
		assert!(sortie.status.success(), "{}", String::from_utf8_lossy(&sortie.stderr));
		chemin
	}

	fn commit_dans(worktree: &std::path::Path, fichier: &str, contenu: &str, message: &str) {
		std::fs::write(worktree.join(fichier), contenu).unwrap();
		let git = |args: &[&str]| {
			std::process::Command::new("git")
				.args(args)
				.current_dir(worktree)
				.output()
				.expect("git est installé sur ce poste")
		};
		git(&["add", "."]);
		git(&["commit", "--quiet", "-m", message]);
	}

	/// Ce que l'écriture par `Bash` laisse derrière elle : le diff la voit, là où
	/// le pont d'autorisation ne voit que les outils d'édition.
	#[tokio::test]
	async fn une_branche_qui_sort_de_son_perimetre_se_voit_au_diff() {
		let depot = depot_jetable("perimetre");
		let lot = worktree_de(&depot, "feat/x-lot", "feat/x");
		let perimetre = vec!["api.txt".to_string()];

		commit_dans(&lot, "api.txt", "a\n", "Dans le périmètre");
		let dehors = files_outside_scope(&depot, "feat/x", "feat/x-lot", &perimetre)
			.await
			.unwrap();
		assert!(dehors.is_empty(), "{dehors:?}");

		// Ce que l'intégration reçoit ensuite n'est pas le fait de cette branche.
		commit_dans(&depot, "sœur.txt", "s\n", "Une tâche sœur");
		let dehors = files_outside_scope(&depot, "feat/x", "feat/x-lot", &perimetre)
			.await
			.unwrap();
		assert!(dehors.is_empty(), "{dehors:?}");

		commit_dans(&lot, "écran.txt", "e\n", "Hors du périmètre");
		let dehors = files_outside_scope(&depot, "feat/x", "feat/x-lot", &perimetre)
			.await
			.unwrap();
		assert_eq!(dehors, vec!["écran.txt".to_string()]);

		assert!(files_outside_scope(&depot, "feat/x", "branche-absente", &perimetre)
			.await
			.is_err());

		std::fs::remove_dir_all(&depot).ok();
		std::fs::remove_dir_all(&lot).ok();
	}

	fn mission_avec(cwd: &str, branch: &str, tasks: Vec<Task>) -> mission::Mission {
		mission::Mission {
			id: "m1".into(),
			title: "Mission de test".into(),
			ticket: String::new(),
			ticket_url: String::new(),
			brief: String::new(),
			branch: branch.into(),
			base: String::new(),
			cwd: cwd.into(),
			master_session: None,
			state: MissionState::Running,
			plan: String::new(),
			guided: false,
			understanding: Vec::new(),
			approach: Vec::new(),
			split: Vec::new(),
			pr_url: String::new(),
			summary: String::new(),
			note: String::new(),
			paused: false,
			started_at: None,
			finished_at: None,
			tasks,
			created_at: String::new(),
			updated_at: String::new(),
		}
	}

	fn tache_de_test(id: &str, branch: &str, state: TaskState) -> Task {
		Task {
			id: id.into(),
			role: "backend".into(),
			title: id.into(),
			brief: String::new(),
			scope: Vec::new(),
			base: String::new(),
			branch: branch.into(),
			worktree: String::new(),
			session_id: None,
			engine_session: String::new(),
			verdict: String::new(),
			actual_branch: String::new(),
			state,
			note: String::new(),
			attempts: 0,
			reproaches: Vec::new(),
			started_at: None,
			finished_at: None,
			checkpoint: String::new(),
			worked_seconds: 0,
			gate: crate::mission::Gate::None,
			gate_output: String::new(),
			gate_commit: String::new(),
		}
	}

	/// Le cas réel qui a fait dériver une mission : un lot livré, jamais
	/// fusionné dans le worktree de la vérification tant que l'intégration
	/// finale n'est pas appelée. Après synchronisation, il y est.
	#[tokio::test]
	async fn la_verification_recoit_ce_que_ses_soeurs_ont_livre() {
		let depot = depot_jetable("cohabitation");
		let backend = worktree_de(&depot, "feat/x-backend", "feat/x");
		commit_dans(&backend, "backend.txt", "api\n", "Le lot backend");
		let qa = worktree_de(&depot, "feat/x-qa", "feat/x");

		let mission = mission_avec(
			&depot.to_string_lossy(),
			"feat/x",
			vec![
				tache_de_test("backend", "feat/x-backend", TaskState::Delivered),
				tache_de_test("qa", "feat/x-qa", TaskState::Running),
			],
		);
		let tache_qa = mission.tasks[1].clone();

		let rapport = sync_verifier_worktree(&mission, &tache_qa, &qa.to_string_lossy())
			.await
			.unwrap();

		assert_eq!(rapport.merged, vec!["feat/x-backend".to_string()]);
		assert!(rapport.conflicts.is_empty());
		assert!(
			qa.join("backend.txt").exists(),
			"le fichier du lot backend doit être là"
		);

		std::fs::remove_dir_all(&depot).ok();
		std::fs::remove_dir_all(&backend).ok();
		std::fs::remove_dir_all(&qa).ok();
	}

	/// Le cas réel de la PR à six fusions : deux lots livrés, une vérification
	/// qui les a reçus sans rien commiter. Une fois les deux lots intégrés, elle
	/// n'apporte plus rien, et n'est pas fusionnée ; une vérification qui a
	/// commité, si.
	#[tokio::test]
	async fn une_verification_sans_commit_n_est_pas_fusionnee() {
		let depot = depot_jetable("integration");
		let backend = worktree_de(&depot, "feat/w-backend", "feat/x");
		commit_dans(&backend, "backend.txt", "api\n", "Le lot backend");
		let frontend = worktree_de(&depot, "feat/w-frontend", "feat/x");
		commit_dans(&frontend, "frontend.txt", "page\n", "Le lot frontend");
		let qa = worktree_de(&depot, "feat/w-qa", "feat/x");
		let review = worktree_de(&depot, "feat/w-review", "feat/x");

		let mission = mission_avec(
			&depot.to_string_lossy(),
			"feat/x",
			vec![
				tache_de_test("backend", "feat/w-backend", TaskState::Delivered),
				tache_de_test("frontend", "feat/w-frontend", TaskState::Delivered),
				tache_de_test("qa", "feat/w-qa", TaskState::Running),
				tache_de_test("review", "feat/w-review", TaskState::Running),
			],
		);
		for (tache, dossier) in [(&mission.tasks[2], &qa), (&mission.tasks[3], &review)] {
			let rapport = sync_verifier_worktree(&mission, tache, &dossier.to_string_lossy())
				.await
				.unwrap();
			assert!(rapport.conflicts.is_empty());
		}
		commit_dans(&review, "relecture.md", "ok\n", "La relecture laisse une note");

		// Avant l'intégration des lots, la vérification les porte : elle apporte.
		assert!(brings_own_commits(&depot, "feat/w-qa").await);

		for lot in ["feat/w-backend", "feat/w-frontend"] {
			let sortie = std::process::Command::new("git")
				.args(["merge", "--no-ff", "--no-edit", "--quiet", lot])
				.current_dir(&depot)
				.output()
				.unwrap();
			assert!(sortie.status.success(), "{}", String::from_utf8_lossy(&sortie.stderr));
		}

		assert!(!brings_own_commits(&depot, "feat/w-backend").await, "lot déjà intégré");
		assert!(!brings_own_commits(&depot, "feat/w-qa").await, "qa n'a rien commité");
		assert!(
			brings_own_commits(&depot, "feat/w-review").await,
			"review a commité sa note"
		);

		std::fs::remove_dir_all(&depot).ok();
		for dossier in [&backend, &frontend, &qa, &review] {
			std::fs::remove_dir_all(dossier).ok();
		}
	}

	/// Une vérification qui n'a rien commité avance sur le lot de sa sœur au
	/// lieu de s'offrir un commit de fusion vide : c'est ce commit, répété par
	/// chaque vérification, qui faisait apparaître la même fusion trois fois
	/// dans la PR de la mission.
	#[tokio::test]
	async fn une_verification_sans_commit_avance_sans_fusion_vide() {
		let depot = depot_jetable("avance");
		let backend = worktree_de(&depot, "feat/z-backend", "feat/x");
		commit_dans(&backend, "backend.txt", "api\n", "Le lot backend");
		let qa = worktree_de(&depot, "feat/z-qa", "feat/x");

		let mission = mission_avec(
			&depot.to_string_lossy(),
			"feat/x",
			vec![
				tache_de_test("backend", "feat/z-backend", TaskState::Delivered),
				tache_de_test("qa", "feat/z-qa", TaskState::Running),
			],
		);
		let tache_qa = mission.tasks[1].clone();
		let rapport = sync_verifier_worktree(&mission, &tache_qa, &qa.to_string_lossy())
			.await
			.unwrap();
		assert_eq!(rapport.merged, vec!["feat/z-backend".to_string()]);

		let tete = |dossier: &std::path::Path, reference: &str| {
			let sortie = std::process::Command::new("git")
				.args(["rev-parse", reference])
				.current_dir(dossier)
				.output()
				.unwrap();
			String::from_utf8_lossy(&sortie.stdout).trim().to_string()
		};
		assert_eq!(
			tete(&qa, "HEAD"),
			tete(&qa, "feat/z-backend"),
			"la vérification doit pointer sur le lot backend, sans commit de fusion"
		);

		std::fs::remove_dir_all(&depot).ok();
		std::fs::remove_dir_all(&backend).ok();
		std::fs::remove_dir_all(&qa).ok();
	}

	/// Un conflit s'annule plutôt que de laisser la vérification au milieu
	/// d'une fusion qu'elle ne sait pas résoudre — et se dit, plutôt que de se
	/// découvrir par hasard trois tours plus tard.
	#[tokio::test]
	async fn un_conflit_de_cohabitation_s_annule_et_se_dit() {
		let depot = depot_jetable("conflit");
		let backend = worktree_de(&depot, "feat/y-backend", "feat/x");
		commit_dans(&backend, "lisez-moi.md", "version backend\n", "Le lot backend");
		let qa = worktree_de(&depot, "feat/y-qa", "feat/x");
		commit_dans(&qa, "lisez-moi.md", "version qa\n", "Modif locale de qa");

		let mission = mission_avec(
			&depot.to_string_lossy(),
			"feat/x",
			vec![
				tache_de_test("backend", "feat/y-backend", TaskState::Delivered),
				tache_de_test("qa", "feat/y-qa", TaskState::Running),
			],
		);
		let tache_qa = mission.tasks[1].clone();

		let rapport = sync_verifier_worktree(&mission, &tache_qa, &qa.to_string_lossy())
			.await
			.unwrap();

		assert!(rapport.merged.is_empty());
		assert_eq!(rapport.conflicts.len(), 1);
		assert!(rapport.conflicts[0].contains("feat/y-backend"));

		// Le worktree n'est pas resté au milieu d'une fusion.
		let sortie = std::process::Command::new("git")
			.args(["status", "--porcelain"])
			.current_dir(&qa)
			.output()
			.unwrap();
		assert!(
			!String::from_utf8_lossy(&sortie.stdout).contains("UU "),
			"aucun fichier ne doit rester en conflit après l'annulation"
		);

		std::fs::remove_dir_all(&depot).ok();
		std::fs::remove_dir_all(&backend).ok();
		std::fs::remove_dir_all(&qa).ok();
	}
}
