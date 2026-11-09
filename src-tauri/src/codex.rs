//! Adaptateur pour le protocole `codex-exec` (`codex exec`, OpenAI Codex CLI).
//!
//! Le protocole par défaut (`claude-stream-json`) est un process qui reste
//! ouvert : `stdin` ne se ferme jamais entre deux tours, un message suivant
//! s'écrit dessus, sur le même process. `codex exec` fonctionne à l'opposé —
//! chaque tour est un process séparé qui se termine de lui-même une fois la
//! réponse rendue (la documentation officielle ne le dit pas explicitement,
//! mais ne décrit aucun mécanisme de tour suivant sur une entrée standard
//! restée ouverte). Le tour suivant se rejoue par une nouvelle invocation,
//! `codex exec resume <fil>`, jamais par une écriture sur un canal qui n'existe
//! déjà plus — voir `agent::send` et le champ `Running::per_turn`.
//!
//! Ligne de commande, événements, outils MCP, reprise, accès complet et hooks
//! vérifiés contre le binaire (codex-cli 0.167, sous Windows). Deux constats en
//! ont découlé : le message passe par l'entrée standard, qu'il faut refermer —
//! ouverte, `codex exec` l'attend sans fin — et chaque tour redonne tous ses
//! réglages, qu'une reprise n'hérite pas. Un hook hérite de l'environnement de
//! l'agent, et ne s'exécute qu'avec `--dangerously-bypass-hook-trust`. Le format des fichiers de
//! session sur disque (`~/.codex/sessions/**/rollout-*.jsonl`), lui, est
//! documenté comme divergeant de ce qu'écrit réellement le CLI (rapports de
//! rétro-ingénierie tiers, non vérifiables ici non plus) : le cockpit ne le
//! lit donc pas. Une session Codex vit dans les écrans tant que le cockpit
//! tourne ; son historique, une fois l'app fermée, n'est pour l'instant pas
//! relu — contrairement à une session Claude Code, entièrement reconstituée
//! depuis son JSONL par `sessions.rs`.

use serde_json::{json, Value};

fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// Ligne de commande du premier tour. `args` vient de ce module (voir
/// `permission_args`, `mcp_args`, `hook_args`) et commence par une espace.
///
/// Le `-` final : le message arrive sur l'entrée standard. En argument, la
/// consigne d'un exécutant avec son brief peut dépasser ce qu'une ligne de
/// commande admet.
pub fn first_turn(binary: &str, args: &str) -> String {
	format!("{} exec --json{args} -", shell_quote(binary))
}

/// Ligne de commande d'un tour suivant — un process de plus, jamais une
/// écriture sur celui d'avant, qui n'existe déjà plus.
pub fn resume_turn(binary: &str, thread_id: &str, args: &str) -> String {
	format!(
		"{} exec resume {} --json{args} -",
		shell_quote(binary),
		shell_quote(thread_id)
	)
}

/// Un réglage `-c clé=valeur`, dont la valeur est du TOML.
fn setting(key: &str, value: &str) -> String {
	format!(" -c {}", shell_quote(&format!("{key}={value}")))
}

/// Une chaîne TOML. Les échappements que produit JSON y sont tous valides.
fn toml_string(value: &str) -> String {
	toml_value(&Value::from(value))
}

/// Une valeur JSON écrite en TOML, à une exception près : `\\` devient `\u005C`.
///
/// Le bash de Git réduit `\\` à `\` en passant l'argument à un programme natif.
/// `"C:\\Users"` arrivait donc en `"C:\Users"`, faux en TOML (`\U`), et Codex refusait
/// de démarrer sur tout chemin Windows. L'échappement Unicode n'a rien à réduire.
fn toml_value(value: &Value) -> String {
	let json = value.to_string();
	let mut out = String::with_capacity(json.len());
	let mut chars = json.chars();
	while let Some(c) = chars.next() {
		if c != '\\' {
			out.push(c);
			continue;
		}
		match chars.next() {
			Some('\\') => out.push_str("\\u005C"),
			Some(escaped) => {
				out.push('\\');
				out.push(escaped);
			}
			None => out.push('\\'),
		}
	}
	out
}

/// Le mode de permission du cockpit, dans les termes de Codex.
///
/// Passé par `-c` et non par `--sandbox`, que `codex exec resume` ne connaît
/// pas : un agent garderait sinon son bac à sable au premier tour seulement.
/// Codex ne pose aucune question en `exec` : `acceptEdits` et `default`
/// reviennent donc au même, écrire dans son dossier et rien d'autre.
pub fn permission_args(mode: &str) -> String {
	match mode {
		"bypassPermissions" => " --dangerously-bypass-approvals-and-sandbox".to_string(),
		"plan" => setting("sandbox_mode", &toml_string("read-only")),
		_ => setting("sandbox_mode", &toml_string("workspace-write")),
	}
}

/// Les variables que les serveurs du cockpit lisent. Codex ne transmet à un
/// serveur MCP que ce qu'on lui nomme : sans elles, le pont de mission ne sait
/// plus sur quelle mission il agit.
const SERVER_ENV: [&str; 5] = [
	"COCKPIT_AGENT_SESSION",
	"COCKPIT_PERMISSION_MODE",
	"COCKPIT_MISSION_ID",
	"COCKPIT_SCOPE",
	"COCKPIT_CWD",
];

/// Une configuration MCP (`{"mcpServers": …}`, celle que reçoit Claude Code),
/// dans les termes de Codex.
///
/// L'approbation d'office : `codex exec` refuse sinon tout appel d'outil MCP
/// (« requires approval, but approval policy is never »). Ces serveurs sont ceux
/// du cockpit, ou ceux du dépôt une fois leur contenu approuvé (`mcp::approve`).
pub fn mcp_args(config: &Value) -> String {
	let Some(servers) = config.get("mcpServers").and_then(|servers| servers.as_object()) else {
		return String::new();
	};
	let mut out = String::new();
	for (name, server) in servers {
		// Le nom est un segment de chemin pointé : un point y créerait un niveau.
		let name: String = name
			.chars()
			.map(|c| {
				if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
					c
				} else {
					'_'
				}
			})
			.collect();
		let key = format!("mcp_servers.{name}");
		if let Some(command) = server.get("command").and_then(|v| v.as_str()) {
			out.push_str(&setting(&format!("{key}.command"), &toml_string(command)));
			if let Some(args) = server.get("args").filter(|args| args.is_array()) {
				out.push_str(&setting(&format!("{key}.args"), &toml_value(args)));
			}
			if let Some(env) = server
				.get("env")
				.and_then(|env| env.as_object())
				.filter(|env| !env.is_empty())
			{
				let table = env
					.iter()
					.filter_map(|(name, value)| Some(format!("{}={}", toml_string(name), toml_string(value.as_str()?))))
					.collect::<Vec<_>>()
					.join(",");
				out.push_str(&setting(&format!("{key}.env"), &format!("{{{table}}}")));
			}
			out.push_str(&setting(
				&format!("{key}.env_vars"),
				&toml_value(&Value::from(SERVER_ENV.to_vec())),
			));
		} else if let Some(url) = server.get("url").and_then(|v| v.as_str()) {
			out.push_str(&setting(&format!("{key}.url"), &toml_string(url)));
		} else {
			continue;
		}
		out.push_str(&setting(
			&format!("{key}.default_tools_approval_mode"),
			&toml_string("approve"),
		));
		// Le pont de mission attend jusqu'à deux minutes qu'un worktree soit prêt :
		// le délai par défaut couperait l'appel avant sa réponse.
		out.push_str(&setting(&format!("{key}.tool_timeout_sec"), "300"));
	}
	out
}

/// Le garde-fou d'un exécutant, en hook `PreToolUse` (voir `guard.rs`).
///
/// Le drapeau : Codex ignore tout hook qu'un humain n'a pas approuvé dans
/// `/hooks`, et l'approbation vaut pour une empreinte du script, que chaque
/// version du cockpit change. Il vaut aussi pour les hooks que le dépôt déclare,
/// qui tournent chez Claude Code sans autre forme de procès.
pub fn hook_args(node: &str, script: &str) -> String {
	let command = format!("\"{node}\" \"{script}\"");
	let hooks = format!(
		"[{{matcher=\"^(Bash|apply_patch)$\",hooks=[{{type=\"command\",command={}}}]}}]",
		toml_string(&command)
	);
	format!(
		" --dangerously-bypass-hook-trust{}",
		setting("hooks.PreToolUse", &hooks)
	)
}

/// Les consignes permanentes, l'équivalent de `--append-system-prompt`.
pub fn instructions_args(instructions: &str) -> String {
	setting("developer_instructions", &toml_string(instructions))
}

/// L'identifiant à retenir pour le tour suivant, annoncé une fois en tête de
/// flux : `{"type":"thread.started","thread_id":"..."}`.
pub fn thread_id(payload: &Value) -> Option<&str> {
	if payload.get("type").and_then(|v| v.as_str()) != Some("thread.started") {
		return None;
	}
	payload.get("thread_id").and_then(|v| v.as_str())
}

/// Le tour est-il fini, réussi ou non ? Le process va se terminer de
/// lui-même dans l'instant qui suit — c'est ce qui marque un tour rendu, au
/// même titre que `type == "result"` chez Claude Code.
pub fn turn_finished(payload: &Value) -> bool {
	matches!(
		payload.get("type").and_then(|v| v.as_str()),
		Some("turn.completed") | Some("turn.failed")
	)
}

/// Distingué de `turn_finished` : qu'un tour soit fini ne dit pas s'il a réussi.
pub fn turn_failed(payload: &Value) -> bool {
	payload.get("type").and_then(|v| v.as_str()) == Some("turn.failed")
}

/// Traduit un événement `codex-exec` vers la forme que le fil de discussion
/// sait déjà lire (`readEvent`, `src/app/agents.tsx`) — celle de Claude Code.
/// Le front n'apprend donc pas une seconde forme d'événement pour un second
/// protocole ; il continue de lire ce qu'il a toujours lu.
///
/// Ne traduit que les formes relevées sur le binaire : messages, commandes,
/// outils MCP, fichiers modifiés et fin de tour. Le reste — raisonnement,
/// recherche web — n'a pas de champ vérifié : mieux vaut ne rien afficher
/// qu'inventer un champ qui n'existe pas et laisser croire à une sortie vide.
/// `None` dit à l'appelant de ne rien émettre pour cette ligne.
pub fn to_claude_shaped(payload: &Value) -> Option<Value> {
	let kind = payload.get("type").and_then(|v| v.as_str())?;
	match kind {
		"item.completed" => {
			let item = payload.get("item")?;
			match item.get("type").and_then(|v| v.as_str())? {
				"agent_message" => {
					let text = item.get("text").and_then(|v| v.as_str())?;
					Some(json!({
						"type": "assistant",
						"message": { "content": [{ "type": "text", "text": text }] },
					}))
				}
				"command_execution" => {
					let output = item.get("aggregated_output").and_then(|v| v.as_str()).unwrap_or("");
					let failed = item.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(0) != 0;
					Some(tool_result(item, output, failed))
				}
				"mcp_tool_call" => {
					let failed = item.get("status").and_then(|v| v.as_str()) == Some("failed");
					Some(tool_result(item, &mcp_output(item), failed))
				}
				"file_change" => {
					let failed = item.get("status").and_then(|v| v.as_str()) == Some("failed");
					Some(tool_result(item, "", failed))
				}
				_ => None,
			}
		}
		"item.started" => {
			let item = payload.get("item")?;
			let (name, input) = match item.get("type").and_then(|v| v.as_str())? {
				"command_execution" => {
					let command = item.get("command").and_then(|v| v.as_str())?;
					("command_execution".to_string(), json!({ "command": command }))
				}
				// Le nom que Claude Code donne à ces outils : c'est par lui que
				// l'écran reconnaît la liste d'étapes et les outils de mission.
				"mcp_tool_call" => {
					let server = item.get("server").and_then(|v| v.as_str())?;
					let tool = item.get("tool").and_then(|v| v.as_str())?;
					let input = item.get("arguments").cloned().unwrap_or_else(|| json!({}));
					(format!("mcp__{server}__{tool}"), input)
				}
				"file_change" => {
					let changes = item.get("changes").cloned().unwrap_or_else(|| json!([]));
					("apply_patch".to_string(), json!({ "changes": changes }))
				}
				_ => return None,
			};
			let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("codex-tool");
			Some(json!({
				"type": "assistant",
				"message": { "content": [{
					"type": "tool_use",
					"id": id,
					"name": name,
					"input": input,
				}] },
			}))
		}
		"turn.completed" => Some(json!({ "type": "result", "is_error": false })),
		"turn.failed" => Some(json!({
			"type": "result",
			"is_error": true,
			"result": crate::i18n::t("codex.turnFailed"),
		})),
		_ => None,
	}
}

/// La fin d'un outil, rattachée à son appel par l'identifiant de l'élément.
fn tool_result(item: &Value, output: &str, failed: bool) -> Value {
	let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("codex-tool");
	json!({
		"type": "user",
		"message": { "content": [{
			"type": "tool_result",
			"tool_use_id": id,
			"content": output,
			"is_error": failed,
		}] },
	})
}

/// Le texte rendu par un outil MCP, ou la raison de son échec.
fn mcp_output(item: &Value) -> String {
	if let Some(error) = item
		.get("error")
		.and_then(|e| e.get("message"))
		.and_then(|m| m.as_str())
	{
		return error.to_string();
	}
	item.get("result")
		.and_then(|result| result.get("content"))
		.and_then(|content| content.as_array())
		.map(|parts| {
			parts
				.iter()
				.filter_map(|part| part.get("text").and_then(|t| t.as_str()))
				.collect::<Vec<_>>()
				.join("\n")
		})
		.unwrap_or_default()
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Lue comme la lit Codex : `clé=valeur` en TOML, valeur intacte.
	fn relu(setting: &str) -> toml::Value {
		toml::from_str::<toml::Table>(setting).unwrap().remove("v").unwrap()
	}

	#[test]
	fn une_valeur_toml_garde_ses_barres_obliques_inverses() {
		let chemin = r#"C:\Users\jorda\pont.mjs"#;
		let ecrit = toml_string(chemin);
		assert!(!ecrit.contains(r"\\"), "{ecrit}");
		assert_eq!(relu(&format!("v={ecrit}")).as_str(), Some(chemin));

		// Une barre seule devant une lettre reste du texte, pas un saut de ligne.
		let piege = "a\\nb\nc\"d";
		assert_eq!(relu(&format!("v={}", toml_string(piege))).as_str(), Some(piege));

		let liste = toml_value(&json!([chemin]));
		assert_eq!(relu(&format!("v={liste}"))[0].as_str(), Some(chemin));
	}

	/// L'incident : le bash de Git réduisait `\\` en route. Seul un vrai passage par
	/// ce shell le montre, et Codex ne démarrait pas sous Windows.
	#[cfg(windows)]
	#[test]
	fn un_chemin_windows_survit_au_shell() {
		let chemin = r#"C:\Users\jorda\pont.mjs"#;
		let valeur = format!("v={}", toml_value(&json!([chemin])));
		let commande = format!(
			"node -e 'process.stdout.write(process.argv[1])' {}",
			shell_quote(&valeur)
		);
		let sortie = crate::platform::shell(&commande).output().expect("node");
		let recu = String::from_utf8_lossy(&sortie.stdout).to_string();
		assert_eq!(relu(&recu)[0].as_str(), Some(chemin), "{recu}");
	}
	use serde_json::json;

	#[test]
	fn le_debut_de_fil_donne_son_identifiant() {
		let payload = json!({"type": "thread.started", "thread_id": "abc-123"});
		assert_eq!(thread_id(&payload), Some("abc-123"));
	}

	#[test]
	fn les_autres_evenements_ne_donnent_pas_d_identifiant() {
		assert_eq!(thread_id(&json!({"type": "turn.started"})), None);
		assert_eq!(thread_id(&json!({"type": "item.completed", "item": {}})), None);
	}

	#[test]
	fn un_tour_reussi_est_fini_et_pas_en_echec() {
		let payload = json!({"type": "turn.completed", "usage": {"input_tokens": 10}});
		assert!(turn_finished(&payload));
		assert!(!turn_failed(&payload));
	}

	#[test]
	fn un_tour_en_echec_est_fini_et_marque() {
		let payload = json!({"type": "turn.failed"});
		assert!(turn_finished(&payload));
		assert!(turn_failed(&payload));
	}

	#[test]
	fn un_evenement_intermediaire_n_est_pas_une_fin() {
		let items = ["thread.started", "turn.started", "item.started", "item.completed"];
		for kind in items {
			assert!(
				!turn_finished(&json!({"type": kind})),
				"{kind} ne devrait pas finir un tour"
			);
		}
	}

	#[test]
	fn les_lignes_de_commande_citent_correctement() {
		assert_eq!(first_turn("codex", " --model 'x'"), "'codex' exec --json --model 'x' -");
		assert_eq!(
			resume_turn("codex", "abc", " --model 'x'"),
			"'codex' exec resume 'abc' --json --model 'x' -"
		);
	}

	#[test]
	fn le_mode_de_permission_se_traduit_aussi_pour_une_reprise() {
		assert_eq!(
			permission_args("bypassPermissions"),
			" --dangerously-bypass-approvals-and-sandbox"
		);
		assert_eq!(permission_args("plan"), " -c 'sandbox_mode=\"read-only\"'");
		assert_eq!(permission_args("acceptEdits"), " -c 'sandbox_mode=\"workspace-write\"'");
		assert_eq!(permission_args("default"), " -c 'sandbox_mode=\"workspace-write\"'");
	}

	#[test]
	fn un_serveur_mcp_se_traduit_avec_son_approbation_et_son_environnement() {
		let args = mcp_args(&json!({ "mcpServers": { "mission": {
			"command": "C:/node.exe",
			"args": ["C:/l'outil.mjs"],
			"env": { "CLE": "valeur" },
		} } }));
		assert!(
			args.contains(r#"-c 'mcp_servers.mission.command="C:/node.exe"'"#),
			"{args}"
		);
		// L'apostrophe du chemin ne sort pas de la citation shell.
		assert!(
			args.contains(r#"mcp_servers.mission.args=["C:/l'\''outil.mjs"]"#),
			"{args}"
		);
		assert!(args.contains(r#"mcp_servers.mission.env={"CLE"="valeur"}"#), "{args}");
		assert!(args.contains("COCKPIT_MISSION_ID"), "{args}");
		assert!(
			args.contains(r#"mcp_servers.mission.default_tools_approval_mode="approve""#),
			"{args}"
		);
		assert!(args.contains("mcp_servers.mission.tool_timeout_sec=300"), "{args}");
	}

	#[test]
	fn un_nom_de_serveur_ne_cree_pas_de_niveau_de_configuration() {
		let args = mcp_args(&json!({ "mcpServers": { "a.b": { "url": "https://x" } } }));
		assert!(args.contains(r#"mcp_servers.a_b.url="https://x""#), "{args}");
	}

	#[test]
	fn une_configuration_sans_serveur_ne_donne_rien() {
		assert_eq!(mcp_args(&json!({})), "");
		assert_eq!(mcp_args(&json!({ "mcpServers": { "vide": {} } })), "");
	}

	#[test]
	fn le_hook_vise_les_commandes_et_les_modifications_de_fichiers() {
		let args = hook_args("C:/node.exe", "C:/guard.mjs");
		assert!(
			args.starts_with(" --dangerously-bypass-hook-trust -c 'hooks.PreToolUse=["),
			"{args}"
		);
		assert!(args.contains("^(Bash|apply_patch)$"), "{args}");
		assert!(args.contains(r#"command="\"C:/node.exe\" \"C:/guard.mjs\"""#), "{args}");
	}

	#[test]
	fn les_consignes_restent_une_seule_chaine_toml() {
		assert_eq!(
			instructions_args("a\nl'\"b\""),
			r#" -c 'developer_instructions="a\nl'\''\"b\""'"#
		);
	}

	#[test]
	fn un_outil_mcp_se_traduit_sous_le_nom_que_lit_l_ecran() {
		let started = to_claude_shaped(&json!({
			"type": "item.started",
			"item": { "id": "item_1", "type": "mcp_tool_call", "server": "mission", "tool": "plan", "arguments": { "summary": "s" }, "status": "in_progress" },
		}))
		.unwrap();
		let call = &started["message"]["content"][0];
		assert_eq!(call["name"], "mcp__mission__plan");
		assert_eq!(call["input"]["summary"], "s");

		let done = to_claude_shaped(&json!({
			"type": "item.completed",
			"item": { "id": "item_1", "type": "mcp_tool_call", "result": { "content": [{ "type": "text", "text": "pong" }] }, "error": null, "status": "completed" },
		}))
		.unwrap();
		let result = &done["message"]["content"][0];
		assert_eq!(result["tool_use_id"], "item_1");
		assert_eq!(result["content"], "pong");
		assert_eq!(result["is_error"], false);
	}

	#[test]
	fn un_outil_mcp_refuse_dit_pourquoi() {
		let done = to_claude_shaped(&json!({
			"type": "item.completed",
			"item": { "id": "item_1", "type": "mcp_tool_call", "result": null, "error": { "message": "non" }, "status": "failed" },
		}))
		.unwrap();
		assert_eq!(done["message"]["content"][0]["content"], "non");
		assert_eq!(done["message"]["content"][0]["is_error"], true);
	}

	#[test]
	fn la_fin_d_une_commande_porte_sa_sortie_et_son_echec() {
		let done = to_claude_shaped(&json!({
			"type": "item.completed",
			"item": { "id": "item_2", "type": "command_execution", "aggregated_output": "fatal", "exit_code": 128, "status": "failed" },
		}))
		.unwrap();
		let result = &done["message"]["content"][0];
		assert_eq!(result["tool_use_id"], "item_2");
		assert_eq!(result["content"], "fatal");
		assert_eq!(result["is_error"], true);
	}

	#[test]
	fn un_fichier_modifie_se_traduit_en_appel_d_outil() {
		let started = to_claude_shaped(&json!({
			"type": "item.started",
			"item": { "id": "item_3", "type": "file_change", "changes": [{ "path": "a.txt", "kind": "add" }], "status": "in_progress" },
		}))
		.unwrap();
		let call = &started["message"]["content"][0];
		assert_eq!(call["name"], "apply_patch");
		assert_eq!(call["input"]["changes"][0]["path"], "a.txt");
	}

	// Ces assertions portent sur les chemins exacts que lit `readEvent`
	// (src/app/agents.tsx) : `message.content[0].type`/`.text` pour un
	// message, `.input.command` pour l'appel d'outil, `type`/`is_error` pour
	// la fin d'un tour. Un changement de forme côté front doit faire échouer
	// ce test avant de faire taire un agent Codex en silence.

	#[test]
	fn un_message_d_agent_se_traduit_en_texte_assistant() {
		let payload = json!({
			"type": "item.completed",
			"item": { "id": "item_3", "type": "agent_message", "text": "Fini." },
		});
		let translated = to_claude_shaped(&payload).unwrap();
		assert_eq!(translated["type"], "assistant");
		assert_eq!(translated["message"]["content"][0]["type"], "text");
		assert_eq!(translated["message"]["content"][0]["text"], "Fini.");
	}

	#[test]
	fn une_commande_annoncee_se_traduit_en_appel_d_outil() {
		let payload = json!({
			"type": "item.started",
			"item": { "id": "item_1", "type": "command_execution", "command": "bash -lc ls", "status": "in_progress" },
		});
		let translated = to_claude_shaped(&payload).unwrap();
		assert_eq!(translated["message"]["content"][0]["type"], "tool_use");
		assert_eq!(translated["message"]["content"][0]["id"], "item_1");
		assert_eq!(translated["message"]["content"][0]["input"]["command"], "bash -lc ls");
	}

	#[test]
	fn un_tour_reussi_se_traduit_en_resultat_sans_erreur() {
		let translated = to_claude_shaped(&json!({"type": "turn.completed"})).unwrap();
		assert_eq!(translated["type"], "result");
		assert_eq!(translated["is_error"], false);
	}

	#[test]
	fn un_tour_en_echec_se_traduit_en_resultat_en_erreur() {
		let translated = to_claude_shaped(&json!({"type": "turn.failed"})).unwrap();
		assert_eq!(translated["type"], "result");
		assert_eq!(translated["is_error"], true);
	}

	#[test]
	fn ce_qui_n_a_pas_de_forme_verifiee_ne_se_traduit_pas() {
		// `reasoning`, `web_search`, `plan_update` : aucun champ relevé sur le
		// binaire. Un item inconnu à l'intérieur d'un type connu ne se traduit
		// pas non plus.
		assert!(to_claude_shaped(&json!({"type": "thread.started", "thread_id": "x"})).is_none());
		assert!(to_claude_shaped(&json!({"type": "turn.started"})).is_none());
		assert!(to_claude_shaped(&json!({"type": "item.completed", "item": {"type": "reasoning"}})).is_none());
	}

	/// La CI n'a pas le vrai binaire `codex` : ce test fait tourner un faux
	/// `codex` (un script qui imite la forme de `codex exec`/`codex exec resume --json`)
	/// à travers le shell de `platform` (`zsh -lc`, le bash de Git sous
	/// Windows), exactement comme `agent.rs` le ferait — pour
	/// vérifier la ligne de commande *et* le chemin d'I/O asynchrone
	/// (`tokio::process::Command`, `BufReader::lines()`), pas seulement le
	/// texte produit par `first_turn`/`resume_turn`.
	#[tokio::test]
	async fn le_faux_codex_confirme_la_ligne_de_commande_et_la_lecture() {
		use tokio::io::{AsyncBufReadExt, BufReader};

		let dir = std::env::temp_dir().join(format!("cockpit-codex-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let script = dir.join("codex");
		std::fs::write(
			&script,
			r#"#!/bin/sh
# Comme le vrai : tant que l'entrée reste ouverte, `cat` ne rend pas la main.
for last; do :; done
[ "$last" = "-" ] || exit 3
message="$(cat)"
if [ "$1" = "exec" ] && [ "$2" = "resume" ]; then
  thread="$3"
  echo "{\"type\":\"thread.started\",\"thread_id\":\"$thread\"}"
  echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"resume: $message\"}}"
  echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
elif [ "$1" = "exec" ]; then
  echo '{"type":"thread.started","thread_id":"thread-xyz"}'
  echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"got: $message\"}}"
  echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
fi
"#,
		)
		.unwrap();
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
		}

		async fn run(command: &str, message: &str) -> Vec<Value> {
			use tokio::io::AsyncWriteExt;
			let mut child = crate::platform::shell_async(command)
				.stdin(std::process::Stdio::piped())
				.stdout(std::process::Stdio::piped())
				.spawn()
				.expect("le faux codex doit se lancer");
			let mut stdin = child.stdin.take().expect("stdin piped");
			stdin.write_all(message.as_bytes()).await.unwrap();
			drop(stdin);
			let stdout = child.stdout.expect("stdout piped");
			let mut lines = BufReader::new(stdout).lines();
			let mut events = Vec::new();
			while let Ok(Some(line)) = lines.next_line().await {
				if let Ok(payload) = serde_json::from_str::<Value>(&line) {
					events.push(payload);
				}
			}
			events
		}

		let command = format!(
			"export PATH={}:$PATH; {}",
			crate::platform::shell_path(&dir.to_string_lossy()),
			first_turn("codex", " --model 'x'")
		);
		let events = run(&command, "fix the failing test").await;
		let started = events.iter().find(|e| thread_id(e).is_some()).unwrap();
		assert_eq!(thread_id(started), Some("thread-xyz"));
		assert!(events.iter().any(turn_finished));
		assert!(events
			.iter()
			.any(|e| e.get("item").and_then(|i| i.get("text")).and_then(|t| t.as_str())
				== Some("got: fix the failing test")));

		// Le tour suivant reprend le même fil — c'est la partie qu'une simple
		// vérification de texte ne peut pas prouver : que la commande générée
		// se lance et rend vraiment le `thread_id` qu'on lui a donné.
		let command = format!(
			"export PATH={}:$PATH; {}",
			crate::platform::shell_path(&dir.to_string_lossy()),
			resume_turn("codex", "thread-xyz", " --model 'x'")
		);
		let events = run(&command, "go on").await;
		let started = events.iter().find(|e| thread_id(e).is_some()).unwrap();
		assert_eq!(thread_id(started), Some("thread-xyz"));

		let _ = std::fs::remove_dir_all(&dir);
	}
}
