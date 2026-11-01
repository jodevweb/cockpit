//! Relais des demandes d'autorisation d'un agent vers l'interface.
//!
//! Le CLI sait déléguer ses demandes à un outil MCP (`--permission-prompt-tool`).
//! On lui en fournit un, minuscule, qui ne décide de rien : il dépose la demande
//! dans un dossier, attend une réponse, et la rend au CLI. Le cockpit surveille
//! ce dossier, affiche la question et écrit la réponse.
//!
//! Ce détour par le disque évite d'embarquer un serveur HTTP dans l'app pour
//! deux messages, et survit au fait que l'agent est un processus séparé.

use crate::config::config_dir;
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Le script MCP, écrit à côté de la configuration au premier lancement.
///
/// Il parle JSON-RPC sur son entrée/sortie standard — le strict nécessaire du
/// protocole : `initialize`, `tools/list`, `tools/call`.
const BRIDGE: &str = r#"#!/usr/bin/env node
// Pont d'autorisation du cockpit — généré, ne pas éditer à la main.
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".config", "cockpit", "permissions");
mkdirSync(DIR, { recursive: true });

// L'agent qui nous a lancés, transmis par le cockpit. Sans lui, une demande
// s'afficherait dans toutes les conversations ouvertes au lieu de la sienne.
const SESSION = process.env.COCKPIT_AGENT_SESSION ?? null;

// Le mode de l'agent. Fournir un `--permission-prompt-tool` fait passer par ici
// chaque outil que l'agent veut employer, `bypassPermissions` compris : le mode
// seul ne suffisait donc pas, et un agent censé être autonome demandait la
// permission de chaque commande. On tranche ici plutôt que de déranger.
const BYPASS = process.env.COCKPIT_PERMISSION_MODE === "bypassPermissions";

// Chemins où cet agent a le droit d'écrire, passés par le cockpit. Vide = tout.
//
// Le périmètre était vérifié côté cockpit, en relisant les demandes déposées
// sur le disque. Or en mode `bypassPermissions` — celui des exécutants de
// mission — ce pont répondait « oui » sans rien déposer : il n'y avait donc
// rien à relire, et la barrière annoncée au maître comme au rôle ne s'appliquait
// jamais. Elle se juge ici, avant l'auto-approbation.
const SCOPE = (process.env.COCKPIT_SCOPE ?? "")
  .split("\n")
  .map((entry) => entry.trim())
  .filter(Boolean);

// Les outils dont on sait lire la cible sans l'interpréter. `Bash` en est
// exclu : deviner ce qu'une ligne de commande touche serait une promesse qu'on
// ne peut pas tenir.
const ECRITURES = { Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path" };

/** Le même test que `within_scope` côté Rust — même règle des deux côtés. */
function dansLePerimetre(chemin) {
  if (SCOPE.length === 0) return true;
  const cible = String(chemin ?? "").replace(/^\.\//, "");
  return SCOPE.some((autorise) => {
    const prefixe = autorise.replace(/^\.\//, "").replace(/\*+$/, "").replace(/\/+$/, "");
    if (!prefixe) return true;
    return cible === prefixe || cible.startsWith(`${prefixe}/`);
  });
}

// Ce qui remonte toujours, quel que soit le mode : une question posée à
// l'utilisateur n'est pas une permission à accorder, c'est une réponse à
// donner. L'auto-approuver la ferait disparaître sans que personne la lise.
const TOUJOURS_DEMANDER = new Set(["AskUserQuestion"]);

// La liste d'étapes que l'agent tient pour dire où il en est. Elle n'agit sur
// rien : la faire approuver poserait une question à chaque étape cochée.
const ETAPES = "mcp__cockpit__etapes";

// Une image que l'agent décrit en données et que le cockpit dessine. Elle
// n'agit sur rien non plus : la faire approuver couperait chaque conclusion.
const ILLUSTRER = "mcp__cockpit__illustrer";

const GENRES = ["frise", "avant_apres", "mesure", "table", "capture", "matrice"];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** Dépose la demande, attend le verdict de l'interface. */
async function ask(toolName, input) {
  if (toolName === ETAPES || toolName === ILLUSTRER) return { allow: true };
  // Le périmètre passe avant le mode : un agent lancé sans filet garde le droit
  // de tout faire chez lui, jamais celui d'écrire chez le voisin.
  const champ = ECRITURES[toolName];
  if (champ) {
    const cible = input?.[champ];
    if (cible && !dansLePerimetre(cible)) {
      return {
        allow: false,
        reason:
          `Outside your scope: ${cible}. You only modify ${SCOPE.join(", ")}. ` +
          `If this file needs to change, report it instead of modifying it.`,
      };
    }
  }
  if (BYPASS && !TOUJOURS_DEMANDER.has(toolName)) {
    return { allow: true };
  }
  // Son navigateur est un bac à sable : un profil à part, sans les sessions de
  // personne, et l'on voit ce qu'il y fait. Demander la permission de chaque
  // clic rendrait une recette impraticable. Deux gestes en sortent, et restent
  // à approuver : exécuter du code hors de la page, et lire un fichier du poste.
  if (toolName.startsWith("mcp__navigateur__") && !/unsafe|file_upload/.test(toolName)) {
    return { allow: true };
  }
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(
    join(DIR, `${id}.request`),
    JSON.stringify({
      id,
      sessionId: SESSION,
      tool: toolName,
      input,
      at: new Date().toISOString(),
    }),
  );

  const answerPath = join(DIR, `${id}.response`);
  // Sans réponse au bout d'une demi-heure, on refuse : mieux vaut un agent
  // bloqué qui le dit qu'une action passée en douce. Cinq minutes suffisaient
  // tant qu'on répondait depuis le poste ; depuis que la demande peut partir
  // sur le téléphone, elle doit survivre au temps de sortir de réunion.
  for (let waited = 0; waited < 1_800_000; waited += 250) {
    if (existsSync(answerPath)) {
      const answer = JSON.parse(readFileSync(answerPath, "utf8"));
      unlinkSync(answerPath);
      return answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { allow: false, reason: "No answer from Cockpit." };
}

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
          serverInfo: { name: "cockpit-permissions", version: "1" },
        },
      });
    } else if (message.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "approve",
              description: "Asks for permission to run a tool.",
              inputSchema: {
                type: "object",
                properties: {
                  tool_name: { type: "string" },
                  input: { type: "object" },
                },
                required: ["tool_name", "input"],
              },
            },
            {
              name: "etapes",
              description:
                "Keep the list of your task's steps, so the user can see where you are. " +
                "Send the whole list on every call: set it before starting, then call it again " +
                "each time a step starts, ends or is added. Only one step in progress at a time. " +
                "Write the step titles in the user's language; keep the `etat` values exactly as listed " +
                "(a_faire = to do, en_cours = in progress, faite = done).",
              inputSchema: {
                type: "object",
                properties: {
                  etapes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        titre: { type: "string", description: "The step, in a few words." },
                        etat: { type: "string", enum: ["a_faire", "en_cours", "faite"] },
                      },
                      required: ["titre", "etat"],
                    },
                  },
                },
                required: ["etapes"],
              },
            },
            {
              name: "illustrer",
              description:
                "Shows part of your report as an image: you provide the data, Cockpit " +
                "draws. One call per image, just before concluding, only when the image says " +
                "more than the text. Pick the genre according to what you did:\n" +
                "- frise (timeline): a bug, the chain of events and the link that breaks (`etapes`).\n" +
                "- avant_apres (before/after): a refactor, what depended on what before and after (`avant`, `apres`).\n" +
                "- mesure (measurement): an optimisation, numbers MEASURED by a command (`mesures`, `unite`, `commande`).\n" +
                "- table: a migration or a schema that changes (`table`, `colonnes`).\n" +
                "- capture (screenshot): a screenshot you took, with numbered markers (`image`, `reperes`).\n" +
                "- matrice (matrix): options compared on a few criteria (`options`, `criteres`).\n" +
                "Keep the field names and enum values exactly as written; write the visible texts in the user's language. " +
                "Invent no number and no state: `source` says where what you show comes from.",
              inputSchema: {
                type: "object",
                properties: {
                  genre: { type: "string", enum: GENRES },
                  titre: { type: "string", description: "What the image shows, in one short sentence." },
                  source: {
                    type: "string",
                    enum: ["mesure", "depot", "capture", "agent"],
                    description:
                      "mesure: output of a command you ran; depot: read in the code or git; " +
                      "capture: seen on screen; agent: your reading, your reasoning.",
                  },
                  etapes: {
                    type: "array",
                    description: "frise: the links, in order (etat: ok, casse = broken, neutre = neutral).",
                    items: {
                      type: "object",
                      properties: {
                        label: { type: "string" },
                        detail: { type: "string" },
                        etat: { type: "string", enum: ["ok", "casse", "neutre"] },
                      },
                      required: ["label"],
                    },
                  },
                  avant: {
                    type: "object",
                    description: "avant_apres: the graph before.",
                    properties: {
                      noeuds: { type: "array", items: { type: "string" } },
                      liens: {
                        type: "array",
                        items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
                      },
                    },
                  },
                  apres: {
                    type: "object",
                    description: "avant_apres: the graph after, same shape.",
                    properties: {
                      noeuds: { type: "array", items: { type: "string" } },
                      liens: {
                        type: "array",
                        items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
                      },
                    },
                  },
                  unite: { type: "string", description: "mesure: ms, MB, requests…" },
                  commande: { type: "string", description: "mesure: the command that produced the numbers." },
                  mesures: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        label: { type: "string" },
                        avant: { type: "number" },
                        apres: { type: "number" },
                        unite: { type: "string", description: "If this row does not use the image's unit." },
                      },
                      required: ["label", "avant", "apres"],
                    },
                  },
                  table: { type: "string", description: "table: its name." },
                  colonnes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        nom: { type: "string" },
                        type: { type: "string" },
                        changement: { type: "string", enum: ["ajout", "retrait", "modif", "garde"], description: "ajout = added, retrait = removed, modif = modified, garde = kept." },
                      },
                      required: ["nom"],
                    },
                  },
                  image: { type: "string", description: "capture: absolute path of the image." },
                  reperes: {
                    type: "array",
                    description: "capture: x and y between 0 and 1, from the top-left corner.",
                    items: {
                      type: "object",
                      properties: {
                        x: { type: "number" },
                        y: { type: "number" },
                        texte: { type: "string" },
                      },
                      required: ["x", "y", "texte"],
                    },
                  },
                  options: { type: "array", items: { type: "string" }, description: "matrice: the columns." },
                  criteres: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        nom: { type: "string" },
                        valeurs: { type: "array", items: { type: "string" } },
                        bons: { type: "array", items: { type: "boolean" } },
                      },
                      required: ["nom", "valeurs"],
                    },
                  },
                },
                required: ["genre", "titre", "source"],
              },
            },
          ],
        },
      });
    } else if (message.method === "tools/call" && message.params?.name === "illustrer") {
      // Comme la liste d'étapes : le cockpit lit l'appel dans le fil, il n'y a
      // rien à garder ici. On ne vérifie que ce qui rendrait le dessin vide,
      // pour que l'agent l'apprenne tant qu'il peut encore corriger.
      const args = message.params?.arguments ?? {};
      const manque = !GENRES.includes(args.genre)
        ? `unknown genre (${GENRES.join(", ")})`
        : args.genre === "frise" && !(args.etapes?.length > 0)
          ? "a frise without `etapes`"
          : args.genre === "avant_apres" && !(args.avant?.noeuds?.length > 0 && args.apres?.noeuds?.length > 0)
            ? "`avant` and `apres` must have `noeuds`"
            : args.genre === "mesure" && !(args.mesures?.length > 0)
              ? "a mesure without `mesures`"
              : args.genre === "table" && !(args.colonnes?.length > 0)
                ? "a table without `colonnes`"
                : args.genre === "capture" && !args.image
                  ? "a capture without `image`"
                  : args.genre === "matrice" && !(args.options?.length > 0 && args.criteres?.length > 0)
                    ? "a matrice without `options` or `criteres`"
                    : null;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: manque
          ? { isError: true, content: [{ type: "text", text: `Illustration refused: ${manque}.` }] }
          : { content: [{ type: "text", text: `Illustration recorded (${args.genre}): Cockpit draws it under your conclusion.` }] },
      });
    } else if (message.method === "tools/call" && message.params?.name === "etapes") {
      // Rien à garder ici : le cockpit lit la liste dans l'appel lui-même, tel
      // qu'il passe dans le fil de l'agent.
      const etapes = message.params?.arguments?.etapes ?? [];
      const faites = etapes.filter((etape) => etape?.etat === "faite").length;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `List recorded: ${faites}/${etapes.length} done.` }] },
      });
    } else if (message.method === "tools/call") {
      const { tool_name: toolName, input } = message.params?.arguments ?? {};
      const answer = await ask(toolName, input);
      // Forme attendue par --permission-prompt-tool.
      const payload = answer.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: answer.reason ?? "Refused from Cockpit." };
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
"#;

pub fn permissions_dir() -> PathBuf {
	config_dir().join("permissions")
}

fn bridge_path() -> PathBuf {
	config_dir().join("mcp-permission.mjs")
}

/// Écrit le pont et la configuration MCP, puis renvoie les arguments à passer
/// au CLI. `None` si Node n'est pas disponible : on retombe alors sur le mode
/// d'autorisation choisi au démarrage.
///
/// Cette vérification n'était qu'une intention : le pont était annoncé au CLI
/// quoi qu'il arrive. Sur un poste sans Node — ce qui est le cas courant depuis
/// que Claude Code s'installe en binaire natif — le serveur ne démarrait pas, et
/// chaque agent mourait sur « MCP tool mcp__cockpit__approve », message qui ne
/// désigne en rien sa cause.
///
/// `sandboxed` change ce qu'on écrit dans `command` : dans un conteneur,
/// `node_binary()` renvoie un chemin macOS que le conteneur ne connaît pas —
/// vérifié empiriquement, même défaut que celui trouvé sur `claude` (voir
/// `agent.rs`). Le nom nu suffit, l'image pose son propre `node` sur son PATH.
pub fn bridge_arguments(sandboxed: bool) -> Option<(String, String)> {
	// Le chemin absolu, jamais `node` tout court côté hôte : le CLI hérite du
	// PATH que lui donne le cockpit, où Homebrew et les gestionnaires de
	// versions n'ont pas forcément leur place. Dans un conteneur ce problème
	// n'existe pas — voir la doc ci-dessus.
	let node = if sandboxed {
		"node".to_string()
	} else {
		crate::agent::node_binary()?
	};

	std::fs::create_dir_all(permissions_dir()).ok()?;
	std::fs::write(bridge_path(), BRIDGE).ok()?;

	let config = config_dir().join("mcp-permission.json");
	let payload = serde_json::json!({
		"mcpServers": {
			"cockpit": {
				"command": node,
				"args": [bridge_path().to_string_lossy()],
			}
		}
	});
	std::fs::write(&config, serde_json::to_string_pretty(&payload).ok()?).ok()?;

	Some((
		config.to_string_lossy().to_string(),
		"mcp__cockpit__approve".to_string(),
	))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
	pub id: String,
	/// Agent à l'origine de la demande, quand le pont a pu l'identifier.
	#[serde(default)]
	pub session_id: Option<String>,
	pub tool: String,
	#[serde(default)]
	pub input: serde_json::Value,
	#[serde(default)]
	pub at: String,
}

/// Demandes en attente de réponse, les plus anciennes d'abord.
pub fn pending() -> Vec<PermissionRequest> {
	let Ok(entries) = std::fs::read_dir(permissions_dir()) else {
		return Vec::new();
	};

	let mut requests: Vec<PermissionRequest> = entries
		.flatten()
		.filter(|entry| {
			entry
				.path()
				.extension()
				.is_some_and(|extension| extension == "request")
		})
		.filter_map(|entry| {
			let raw = std::fs::read_to_string(entry.path()).ok()?;
			serde_json::from_str(&raw).ok()
		})
		.collect();

	requests.sort_by(|a, b| a.at.cmp(&b.at));
	requests
}

/// Au démarrage : rendre la main à ce qui attend encore une réponse.
///
/// Le pont vit dans le processus de l'agent, pas dans le cockpit — et un agent
/// survit à un cockpit tué sans ménagement, son sous-arbre n'ayant pas toujours
/// suivi. Effacer sa demande, comme on le faisait, ne l'arrêtait donc pas : il
/// continuait d'attendre un fichier que plus personne n'écrirait, pendant une
/// demi-heure, avant d'abandonner sur un « sent no response for 1800s » qui ne
/// désigne rien.
///
/// On lui répond donc, tout de suite et en disant pourquoi. Une demande sans
/// interlocuteur ne peut de toute façon plus être accordée : le nouveau cockpit
/// ne pilote plus cet agent et n'a aucun moyen d'afficher sa question. Refuser
/// en le nommant vaut mieux que faire attendre pour rien.
pub fn release_orphans(alive: &std::collections::HashSet<String>) {
	for request in pending() {
		// Un agent détaché a survécu au cockpit précédent, et celui-ci le
		// pilote de nouveau : sa question attend une réponse qu'on peut donner.
		if request
			.session_id
			.as_deref()
			.is_some_and(|session| alive.contains(session))
		{
			continue;
		}
		let _ = answer(
			&request.id,
			false,
			Some(
				"Cockpit restarted during this request: no one was left to answer \
				 it. Stop here and ask again — a Cockpit is listening again."
					.into(),
			),
		);
	}

	// Les réponses que personne n'est venu lire : leur pont est mort avant de
	// les relever. Sans ce ménage, le dossier accumule un fichier par agent
	// interrompu, indéfiniment.
	let Ok(entries) = std::fs::read_dir(permissions_dir()) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.extension().is_none_or(|extension| extension != "response") {
			continue;
		}
		let vieille = entry
			.metadata()
			.and_then(|meta| meta.modified())
			.map(|at| at.elapsed().map(|age| age.as_secs() > 3_600).unwrap_or(false))
			.unwrap_or(false);
		if vieille {
			let _ = std::fs::remove_file(path);
		}
	}
}

/// Oublie les demandes d'un agent arrêté.
///
/// Le pont supprime sa demande en la lisant ; tué avant, il laisse un fichier
/// que plus personne ne relèvera et qui resterait affiché indéfiniment.
pub fn discard(session_id: Option<&str>) {
	let dir = permissions_dir();
	for request in pending() {
		let concerned = match session_id {
			Some(wanted) => request.session_id.as_deref() == Some(wanted),
			// Sans agent visé, on purge tout : au démarrage, aucune demande
			// d'une exécution précédente n'a encore quelqu'un pour y répondre.
			None => true,
		};
		if !concerned {
			continue;
		}
		let _ = std::fs::remove_file(dir.join(format!("{}.request", request.id)));
		let _ = std::fs::remove_file(dir.join(format!("{}.response", request.id)));
	}
}

pub fn answer(id: &str, allow: bool, reason: Option<String>) -> Result<()> {
	let dir = permissions_dir();
	let payload = serde_json::json!({
		"allow": allow,
		"reason": reason.unwrap_or_else(|| "Refused from Cockpit.".into()),
	});

	std::fs::write(
		dir.join(format!("{id}.response")),
		serde_json::to_string(&payload)
			.map_err(|e| CockpitError::msg(crate::i18n::tf("permissions.unreadableAnswer", &[("error", &e)])))?,
	)
	.map_err(|e| CockpitError::msg(crate::i18n::tf("permissions.writeError", &[("error", &e)])))?;

	// La demande est traitée : on la retire pour qu'elle sorte de la liste.
	let _ = std::fs::remove_file(dir.join(format!("{id}.request")));
	Ok(())
}
