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
use crate::mission::{self, MissionState, Task, TaskState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Au-delà, c'est qu'un plan a dérapé. Trois exécutants en parallèle sur un
/// même ticket est déjà beaucoup ; six est le signe qu'on n'a pas découpé, on a
/// éparpillé.
const MAX_RUNNING: usize = 4;

pub fn calls_dir() -> std::path::PathBuf {
	config_dir().join("orchestrator")
}

fn bridge_path() -> std::path::PathBuf {
	config_dir().join("mcp-mission.mjs")
}

/// Le serveur MCP confié au maître — le strict nécessaire du protocole.
const BRIDGE: &str = r#"#!/usr/bin/env node
// Outils de mission du cockpit — généré, ne pas éditer à la main.
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".config", "cockpit", "orchestrator");
mkdirSync(DIR, { recursive: true });

// La mission vient de l'environnement : un maître ne peut agir que sur la
// sienne, quoi qu'il écrive dans ses arguments.
const MISSION = process.env.COCKPIT_MISSION_ID ?? "";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function call(tool, input) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(
    join(DIR, `${id}.call`),
    JSON.stringify({ id, mission: MISSION, tool, input, at: new Date().toISOString() }),
  );

  const answerPath = join(DIR, `${id}.result`);
  // Créer un worktree et démarrer un agent prend quelques secondes ; deux
  // minutes laissent la place sans laisser le maître attendre indéfiniment.
  for (let waited = 0; waited < 120_000; waited += 200) {
    if (existsSync(answerPath)) {
      const answer = JSON.parse(readFileSync(answerPath, "utf8"));
      unlinkSync(answerPath);
      return answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, error: "Cockpit did not answer." };
}

const TOOLS = [
  {
    name: "understand",
    description:
      "Guided mission, first step: submit what you understood of the ticket. 10 lines at most, written for a developer discovering the ticket — what is asked, why, what is out of scope. No plan, no breakdown. Whatever you could not settle goes in `questions`. The user approves or corrects: wait for their answer.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The summary, one idea per line, 10 lines at most." },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "The ambiguities that really change the work, 5 at most. Empty if everything is clear.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "approach",
    description:
      "Guided mission, second step, once your understanding is approved: submit how you intend to go about it. Steps a human can read (what, where in the code, in which order, which risks), 15 lines at most — without splitting between workers yet. The user approves or corrects: wait for their answer before `plan`.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The approach, 15 lines at most." },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "The choices you would rather have approved, 5 at most.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "plan",
    description:
      "Submit the mission breakdown. The tasks then wait for the user's approval: nothing starts before that.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The plan in a few sentences." },
        tasks: {
          type: "array",
          description: "One entry per worker.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", description: "Catalog role: backend, frontend, qa, review." },
              title: { type: "string" },
              brief: { type: "string", description: "Complete instructions, contracts included." },
              scope: {
                type: "array",
                items: { type: "string" },
                description: "Paths this task may write to. Any write elsewhere will be refused.",
              },
              base: { type: "string", description: "Starting branch; empty = integration branch." },
              branch: { type: "string" },
            },
            required: ["role", "title"],
          },
        },
      },
      required: ["summary", "tasks"],
    },
  },
  {
    name: "status",
    description: "State of the mission and of each of its tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spawn",
    description:
      "Creates the branch and worktree of an approved task, then launches its worker. Refused until the plan is approved.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "rework",
    description:
      "Sends a task back for rework with what is wrong with it. Call it when QA or a review rejects: the task restarts in its worktree, its work intact, and the checks will judge again afterwards. This is how a verdict travels down to whoever must fix it.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: {
          type: "string",
          description:
            "What must be fixed, precisely: this text is appended to the worker's instructions, and the worker will not have read the report.",
        },
      },
      required: ["taskId", "reason"],
    },
  },
  {
    name: "collect",
    description: "What a task produced: commits and files touched.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "report",
    description:
      "Records the mission report: what was done, how it works, where to look, how to verify it. Write it for someone who did not follow the work.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "In Markdown, short and concrete: what changes for the user, the entry points in the code, the contracts between the parts, what one needs to know to pick it up.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "pr",
    description:
      "Opens the pull request of the integration branch, closes the mission and cleans up the worktrees. Only call it once everything is integrated and approved. If the team opens its PRs with a repository command, the tool gives it back to you on the first call: run it, then call `pr` again with `url`.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "What the mission changes, and how to verify it." },
        base: {
          type: "string",
          description:
            "Branch to base the PR on. Only fill it in if the mission extends work in progress: the PR then stacks on top of it and only shows what the mission adds. Empty = the repository's default branch.",
        },
        url: {
          type: "string",
          description:
            "URL of a pull request that is already open — the one the team command just produced. When set, Cockpit opens nothing: it closes the mission on this PR.",
        },
      },
    },
  },
  {
    name: "integrate",
    description:
      "Merges the delivered branches into the integration branch. Returns the conflicts to resolve, without forcing anything. When the repository declares checks, a task is merged only once they pass: failed ones come back in `gatesFailed` with their output (send them to `rework`), running ones in `gatesPending`.",
    inputSchema: { type: "object", properties: {} },
  },
];

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cockpit-mission", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    } else if (message.method === "tools/call") {
      const answer = await call(message.params?.name, message.params?.arguments ?? {});
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          isError: answer.ok === false,
        },
      });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
"#;

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
		if sandboxed { crate::sandbox::container_path(&path) } else { path }
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

	match call.tool.as_str() {
		"understand" | "approach" => {
			let step = if call.tool == "understand" {
				mission::Step::Understanding
			} else {
				mission::Step::Approach
			};
			let summary = call
				.input
				.get("summary")
				.and_then(|value| value.as_str())
				.unwrap_or_default();
			let questions: Vec<String> = call
				.input
				.get("questions")
				.and_then(|value| value.as_array())
				.map(|items| {
					items
						.iter()
						.filter_map(|item| item.as_str().map(str::to_string))
						.collect()
				})
				.unwrap_or_default();
			mission::submit_draft(&mission.id, step, summary, questions)?;
			Ok(json!({
				"state": step.awaiting(),
				"message": format!(
					"Your {} has been submitted. The user is reviewing it: stop here, their answer \
					 will reach you as a message.",
					step.protocol_label()
				),
			}))
		}

		"plan" => {
			let summary = call
				.input
				.get("summary")
				.and_then(|value| value.as_str())
				.unwrap_or_default();
			let tasks = read_tasks(&call.input, &mission.branch)?;
			if tasks.is_empty() {
				return Err(CockpitError::msg("A plan without tasks commits no one."));
			}
			let count = tasks.len();
			mission::submit_plan(&mission.id, summary, tasks)?;
			Ok(json!({
				"state": "awaitingApproval",
				"tasks": count,
				"message": "Plan recorded. It is waiting for the user's approval: \
				            only call `spawn` once the mission has moved to `running`.",
			}))
		}

		"status" => {
			let mission = mission::get(&call.mission)?;
			Ok(json!({
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
			}))
		}

		"spawn" => {
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
			if running >= MAX_RUNNING {
				return Err(CockpitError::msg(format!(
					"{running} workers are already running: wait for one before launching another."
				)));
			}

			let task_id = call
				.input
				.get("taskId")
				.and_then(|value| value.as_str())
				.unwrap_or_default()
				.to_string();
			let task = mission
				.tasks
				.iter()
				.find(|task| task.id == task_id)
				.cloned()
				.ok_or_else(|| CockpitError::msg("Unknown task."))?;
			if task.state != TaskState::Planned {
				return Err(CockpitError::msg(format!(
					"This task is already {:?}.",
					task.state
				)));
			}

			// Branche et worktree d'abord : un exécutant sans terrain propre
			// écrirait dans celui du maître, et l'isolation ne serait qu'un mot.
			let worktree = prepare_worktree(&mission, &task).await?;
			mission::set_task_worktree(&mission.id, &task.id, &worktree)?;

			// Le maître, et lui seul : c'est `spawn` qui passe par ici.
			let session = crate::launch_task_agent(
				app.clone(),
				&mission.id,
				&task.id,
				crate::executions::MASTER,
			)
			.await?;
			Ok(json!({
				"sessionId": session,
				"worktree": worktree,
				"branch": task.branch,
				"message": "Worker launched. Its writes outside its scope will be refused.",
			}))
		}

		"rework" => {
			let task_id = call
				.input
				.get("taskId")
				.and_then(|value| value.as_str())
				.unwrap_or_default();
			let reason = call
				.input
				.get("reason")
				.and_then(|value| value.as_str())
				.unwrap_or_default();
			// Les rôles qui jugent sont ceux du catalogue : ce sont eux qu'on
			// remet en attente, puisqu'ils auront à rejuger le travail corrigé.
			let verifiers: std::collections::HashSet<String> = crate::roles_for(&mission.cwd)
				.into_iter()
				.filter(|role| role.verifies)
				.map(|role| role.id)
				.collect();
			// Les agents des tâches qu'on relance n'ont plus rien à faire : leur
			// laisser la vie revenait à empiler un CLI par reprise, chacun avec
			// son serveur MCP, jusqu'à saturer la machine.
			let sessions: Vec<String> = mission
				.tasks
				.iter()
				.filter(|task| task.id == task_id || verifiers.contains(&task.role))
				.filter_map(|task| task.session_id.clone())
				.collect();
			let updated = mission::rework(&mission.id, task_id, reason, |role| {
				verifiers.contains(role)
			})?;
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
		"collect" => {
			let task_id = call
				.input
				.get("taskId")
				.and_then(|value| value.as_str())
				.unwrap_or_default();
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

		"integrate" => {
			// Jamais dans `mission.cwd` : c'est le dépôt principal, où vit la
			// branche de travail de l'utilisateur. Un merge lancé là atterrit dans
			// ce qui s'y trouvait sorti — et c'est ainsi qu'une mission a fusionné
			// sa tâche dans le `dev` local de quelqu'un.
			let worktree = integration_worktree(&mission).await?;
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
					if head.trim().is_empty() { "detached HEAD" } else { head.trim() },
				)));
			}

			let mut merged = Vec::new();
			let mut conflicts = Vec::new();

			// Les portes du dépôt (`gates.rs`) : une tâche n'est fusionnée que
			// sur un code de sortie, pas sur ce qu'elle dit d'elle-même. Celles
			// qu'un redémarrage a interrompues repartent ici.
			let gate_commands = crate::gates::commands_for(&mission.cwd);
			crate::gates::ensure(&mission);
			// Les rôles du projet de la mission, comme au ramassage des tâches
			// rendues (`collect_finished_tasks`) : les deux doivent s'accorder
			// sur qui juge, sans quoi une recette passerait les portes ici.
			let juges: std::collections::HashSet<String> = crate::roles_for(&mission.cwd)
				.into_iter()
				.filter(|role| role.verifies)
				.map(|role| role.id)
				.collect();
			let mut gates_pending = Vec::new();
			let mut gates_failed = Vec::new();

			for task in &mission.tasks {
				// La branche qui porte le travail, pas celle qu'on lui avait
				// assignée : un exécutant qui s'est créé sa propre branche a bien
				// livré, ailleurs. Fusionner la branche déclarée laissait son code
				// dehors et refermait la mission dessus.
				let branche = mission::working_branch(task).to_string();
				if task.state != TaskState::Delivered || branche.is_empty() {
					continue;
				}
				let decision = mission::gate_decision(
					task.gate,
					!gate_commands.is_empty(),
					juges.contains(&task.role),
				);
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
						gates_pending.push(json!({ "taskId": task.id, "task": task.title }));
						continue;
					}
					mission::GateDecision::Refuse => {
						// Relue : `start` vient peut-être d'en poser la raison.
						let output = mission::get(&mission.id)
							.ok()
							.and_then(|fresh| fresh.tasks.into_iter().find(|t| t.id == task.id))
							.map(|fresh| fresh.gate_output)
							.unwrap_or_else(|| task.gate_output.clone());
						gates_failed.push(json!({
							"taskId": task.id,
							"task": task.title,
							"output": output,
						}));
						continue;
					}
				}
				// Une tâche qui vérifie sans rien commiter n'apporte que les
				// fusions de ses sœurs, reçues avant son lancement
				// (`sync_verifier_worktree`). La fusionner à son tour ramenait
				// ces fusions dans la PR : six commits de fusion pour deux
				// commits de travail. Elle est intégrée sans fusion.
				if !brings_own_commits(cwd, &branche).await {
					mission::set_task_state(&mission.id, &task.id, TaskState::Integrated, "")?;
					merged.push(branche.clone());
					continue;
				}
				match crate::git::run_git(cwd, &["merge", "--no-ff", "--no-edit", &branche]).await
				{
					Ok(_) => {
						mission::set_task_state(&mission.id, &task.id, TaskState::Integrated, "")?;
						merged.push(branche.clone());
					}
					Err(error) => {
						conflicts.push(json!({
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

			if conflicts.is_empty() && !merged.is_empty() {
				mission::set_state(&mission.id, MissionState::Integrating, "")?;
			}

			// Les preuves de recette suivent, elles que les branches ne portent pas.
			// Une tâche abandonnée peut avoir produit du code avant de renoncer —
			// trois reprises épuisées ne veulent pas dire trois reprises vides. Son
			// travail n'est intégré par personne, et la mission se refermait dessus
			// sans un mot : la branche restait là, sans PR pour la porter et sans
			// rien pour la nommer. On ne bloque pas — renoncer est une décision —
			// mais on ne laisse plus partir en silence.
			let mut abandonne = Vec::new();
			for task in &mission.tasks {
				if !matches!(task.state, TaskState::Failed) {
					continue;
				}
				let branche = mission::working_branch(task);
				if branche.is_empty() {
					continue;
				}
				let restes = crate::git::run_git(
					cwd,
					&["rev-list", "--count", &format!("{}..{branche}", mission.branch)],
				)
				.await
				.ok()
				.and_then(|raw| raw.trim().parse::<u32>().ok())
				.unwrap_or(0);
				if restes > 0 {
					abandonne.push(json!({
						"task": task.title,
						"branch": branche,
						"commits": restes,
					}));
				}
			}

			let evidence = gather_evidence(&mission, &worktree);

			// Une recette sans trace n'est pas une recette. Le rôle qui vérifie
			// pouvait rendre « c'est bon » sans avoir rien exécuté ni rien
			// déposé : la mission se fermait sur une parole, et personne ne s'en
			// apercevait avant la production. On ne bloque pas — c'est au maître
			// de juger — mais on le dit, et on nomme la tâche concernée.
			let verifiers: std::collections::HashSet<String> = crate::roles_for(&mission.cwd)
				.into_iter()
				.filter(|role| role.verifies)
				.map(|role| role.id)
				.collect();
			let recettes_muettes: Vec<String> = mission
				.tasks
				.iter()
				.filter(|task| verifiers.contains(&task.role))
				.filter(|task| {
					matches!(task.state, TaskState::Delivered | TaskState::Integrated)
				})
				.filter(|_| evidence.is_empty())
				.map(|task| task.title.clone())
				.collect();

			let portes = {
				let titres = |entries: &[serde_json::Value]| {
					entries
						.iter()
						.filter_map(|entry| Some(format!("\"{}\"", entry.get("task")?.as_str()?)))
						.collect::<Vec<_>>()
						.join(", ")
				};
				let mut texte = String::new();
				if !gates_failed.is_empty() {
					texte.push_str(&format!(
						" Not merged, the repository checks failed for {}: send them back \
						 with `rework`, quoting the output given in `gatesFailed`.",
						titres(&gates_failed)
					));
				}
				if !gates_pending.is_empty() {
					texte.push_str(&format!(
						" Not merged yet, the repository checks are still running for {}: \
						 call `integrate` again once `status` shows them finished.",
						titres(&gates_pending)
					));
				}
				texte
			};

			Ok(json!({
				"merged": merged,
				"conflicts": conflicts,
				"gatesFailed": gates_failed,
				"gatesPending": gates_pending,
				"worktree": worktree,
				"evidence": evidence,
				"evidenceMissing": recettes_muettes,
				"abandonedWithWork": abandonne,
				"message": if conflicts.is_empty() {
					let perdu = if abandonne.is_empty() {
						String::new()
					} else {
						let liste = abandonne
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
					let alerte = if recettes_muettes.is_empty() {
						String::new()
					} else {
						format!(
							" Warning: {} gave its verdict without leaving any \
							 evidence of execution. Ask it for something to verify it with before \
							 opening the pull request.",
							recettes_muettes.join(", "),
						)
					};
					format!(
						"Branches merged into `{worktree}`. It is up to you to validate the whole \
						 before the pull request.{portes}{alerte}{perdu}"
					)
				} else {
					format!(
						"Conflicts remain: resolve them in `{worktree}`, then call \
						 `integrate` again."
					)
				},
			}))
		}

		"report" => {
			let summary = call
				.input
				.get("summary")
				.and_then(|value| value.as_str())
				.unwrap_or_default();
			if summary.trim().is_empty() {
				return Err(CockpitError::msg("An empty report helps no one."));
			}
			mission::set_summary(&mission.id, summary)?;
			Ok(json!({ "message": "Report recorded." }))
		}

		"pr" => {
			let title = call
				.input
				.get("title")
				.and_then(|value| value.as_str())
				.filter(|title| !title.trim().is_empty())
				.map(String::from)
				.unwrap_or_else(|| mission.title.clone());
			let body = call
				.input
				.get("body")
				.and_then(|value| value.as_str())
				.unwrap_or_default()
				.to_string();

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

			let body = if body.trim().is_empty() && !mission.summary.trim().is_empty() {
				mission.summary.clone()
			} else {
				body
			};
			// La base peut être déclarée par le maître : une mission qui prolonge
			// un travail en cours s'empile dessus plutôt que de repartir de la
			// branche par défaut, où sa PR montrerait aussi le travail du voisin.
			let base = call
				.input
				.get("base")
				.and_then(|value| value.as_str())
				.map(str::trim)
				.filter(|value| !value.is_empty())
				.map(str::to_string);
			if let Some(base) = &base {
				mission::set_base(&mission.id, base)?;
			}
			let mission = mission::get(&mission.id)?;

			// L'équipe a peut-être sa propre façon d'ouvrir une pull request : le bon
			// gabarit, ses labels, l'envoi des captures de recette. Tout cela vit
			// dans une commande du dépôt, que le cockpit ne saurait pas refaire — et
			// qu'un autre projet n'a pas. Quand elle est déclarée, c'est le maître
			// qui la joue, dans son worktree, et qui rend l'adresse obtenue.
			let team_command = crate::mission_pr_command(&mission);
			let url = call
				.input
				.get("url")
				.and_then(|value| value.as_str())
				.map(str::trim)
				.filter(|value| !value.is_empty())
				.map(str::to_string);

			let url = match (url, team_command) {
				// L'adresse est là : la pull request existe déjà, le cockpit n'a plus
				// qu'à en tirer les conséquences.
				(Some(url), _) => {
					if !url.starts_with("http") {
						return Err(CockpitError::msg(
							"`url` expects the URL of the opened pull request.",
						));
					}
					url
				}
				// Commande d'équipe déclarée : on rend la main au maître plutôt que
				// d'ouvrir une pull request qui ignorerait sa méthode.
				(None, Some(command)) => {
					let worktree = integration_worktree(&mission).await?;
					// Les preuves de recette sont réunies avant de rendre la main : la
					// commande d'équipe les joint à la pull request, et elle les cherche
					// là où elle s'exécute.
					let evidence = gather_evidence(&mission, &worktree);
					return Ok(json!({
						"command": command,
						"worktree": worktree,
						"evidence": evidence,
						"message": format!(
							"This team opens its pull requests with `{command}`. Run it in \
							 `{worktree}`, then call `pr` again with `url` — the URL it \
							 produced. The mission will close at that point. The workers' QA \
							 evidence has been gathered there ({} file(s) under \
							 `.claude/work/`): git ignores it, it will not leave with the \
							 branch.",
							evidence.len()
						),
					}));
				}
				// Aucune méthode maison : le cockpit ouvre la pull request lui-même.
				// Le `git push` part du worktree d'intégration, comme le merge : aucune
				// commande de mission ne s'exécute dans le dépôt principal.
				(None, None) => {
					let from = integration_worktree(&mission).await?;
					crate::open_mission_pr(
						&from,
						&mission.branch,
						&crate::mission_base(&mission).await,
						&title,
						&body,
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

		other => Err(CockpitError::msg(format!("Unknown tool: {other}"))),
	}
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
					.map(|list| {
						list.iter()
							.filter_map(|item| item.as_str().map(String::from))
							.collect()
					})
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
	let existe = crate::git::run_git(
		repo,
		&["rev-parse", "--verify", &format!("refs/heads/{}", task.branch)],
	)
	.await
	.is_ok();

	let chemin = path.to_string_lossy().to_string();
	if existe {
		crate::git::run_git(repo, &["worktree", "add", &chemin, &task.branch]).await?;
	} else {
		crate::git::run_git(
			repo,
			&["worktree", "add", "-b", &task.branch, &chemin, &base],
		)
		.await?;
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
pub async fn sync_verifier_worktree(
	mission: &mission::Mission,
	task: &Task,
	worktree: &str,
) -> Result<SyncReport> {
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
		.map_or(true, |count| count > 0)
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
		collected.extend(crate::qa::collect_into(
			std::path::Path::new(&task.worktree),
			into,
		));
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
		return Err(CockpitError::msg(crate::i18n::t(
			"orchestrator.noIntegrationBranch",
		)));
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

	fn mission_avec(cwd: &str, branch: &str, tasks: Vec<Task>) -> mission::Mission {
		mission::Mission {
			id: "m1".into(),
			title: "Mission de test".into(),
			ticket: String::new(),
			ticket_url: String::new(),
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
		assert!(qa.join("backend.txt").exists(), "le fichier du lot backend doit être là");

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
		assert!(brings_own_commits(&depot, "feat/w-review").await, "review a commité sa note");

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
