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
//! Vérifié contre la documentation officielle
//! (developers.openai.com/codex/noninteractive.md, août 2026), pas contre le
//! binaire — absent du poste où ceci a été écrit. Le format des fichiers de
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

/// Ligne de commande du premier tour.
///
/// `--` avant le message : il vient d'un humain ou d'un téléphone, et un texte
/// qui commence par `-` serait sinon lu comme une option de `codex exec`.
pub fn first_turn(binary: &str, prompt: &str) -> String {
	format!("{} exec --json -- {}", shell_quote(binary), shell_quote(prompt))
}

/// Ligne de commande d'un tour suivant — un process de plus, jamais une
/// écriture sur celui d'avant, qui n'existe déjà plus.
pub fn resume_turn(binary: &str, thread_id: &str, prompt: &str) -> String {
	format!(
		"{} exec resume {} --json -- {}",
		shell_quote(binary),
		shell_quote(thread_id),
		shell_quote(prompt)
	)
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

/// Distingué de `turn_finished` : une mission qui recomposerait le travail
/// d'un exécutant Codex (pas encore possible, voir `PROTOCOL_CODEX_EXEC`)
/// aurait besoin de savoir laquelle des deux fins c'est, pas seulement que
/// c'est fini.
pub fn turn_failed(payload: &Value) -> bool {
	payload.get("type").and_then(|v| v.as_str()) == Some("turn.failed")
}

/// Traduit un événement `codex-exec` vers la forme que le fil de discussion
/// sait déjà lire (`readEvent`, `src/app/agents.tsx`) — celle de Claude Code.
/// Le front n'apprend donc pas une seconde forme d'événement pour un second
/// protocole ; il continue de lire ce qu'il a toujours lu.
///
/// Ne traduit que ce qui a une forme vérifiée contre la documentation
/// officielle : le texte d'un message d'agent, l'annonce d'une commande
/// lancée, et la fin d'un tour. Le reste — fichiers modifiés, raisonnement,
/// sortie d'une commande, appels d'outils MCP, recherche web — n'a pas de
/// champ vérifié ici : mieux vaut ne rien afficher qu'inventer un champ qui
/// n'existe pas et laisser croire à une sortie vide. `None` dit à l'appelant
/// de ne rien émettre pour cette ligne.
pub fn to_claude_shaped(payload: &Value) -> Option<Value> {
	let kind = payload.get("type").and_then(|v| v.as_str())?;
	match kind {
		"item.completed" => {
			let item = payload.get("item")?;
			if item.get("type").and_then(|v| v.as_str()) != Some("agent_message") {
				return None;
			}
			let text = item.get("text").and_then(|v| v.as_str())?;
			Some(json!({
				"type": "assistant",
				"message": { "content": [{ "type": "text", "text": text }] },
			}))
		}
		"item.started" => {
			let item = payload.get("item")?;
			if item.get("type").and_then(|v| v.as_str()) != Some("command_execution") {
				return None;
			}
			let command = item.get("command").and_then(|v| v.as_str())?;
			let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("codex-tool");
			Some(json!({
				"type": "assistant",
				"message": { "content": [{
					"type": "tool_use",
					"id": id,
					"name": "command_execution",
					"input": { "command": command },
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

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn le_debut_de_fil_donne_son_identifiant() {
		let payload = json!({"type": "thread.started", "thread_id": "abc-123"});
		assert_eq!(thread_id(&payload), Some("abc-123"));
	}

	#[test]
	fn les_autres_evenements_ne_donnent_pas_d_identifiant() {
		assert_eq!(thread_id(&json!({"type": "turn.started"})), None);
		assert_eq!(
			thread_id(&json!({"type": "item.completed", "item": {}})),
			None
		);
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
			assert!(!turn_finished(&json!({"type": kind})), "{kind} ne devrait pas finir un tour");
		}
	}

	#[test]
	fn les_lignes_de_commande_citent_correctement() {
		assert_eq!(first_turn("codex", "fix it"), "'codex' exec --json -- 'fix it'");
		assert_eq!(
			resume_turn("codex", "abc", "go on"),
			"'codex' exec resume 'abc' --json -- 'go on'"
		);
	}

	#[test]
	fn les_guillemets_simples_du_message_sont_echappes() {
		// Un message qui contient lui-même une apostrophe ne doit pas casser
		// hors de la citation shell.
		assert_eq!(first_turn("codex", "l'agent"), "'codex' exec --json -- 'l'\\''agent'");
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
		// `reasoning`, `file_change`, `mcp_tool_call`, `web_search`,
		// `plan_update` : aucun champ vérifié contre la documentation. Un item
		// inconnu à l'intérieur d'un type connu ne se traduit pas non plus.
		assert!(to_claude_shaped(&json!({"type": "thread.started", "thread_id": "x"})).is_none());
		assert!(to_claude_shaped(&json!({"type": "turn.started"})).is_none());
		assert!(
			to_claude_shaped(&json!({"type": "item.completed", "item": {"type": "reasoning"}}))
				.is_none()
		);
		assert!(to_claude_shaped(&json!({"type": "item.completed", "item": {"type": "file_change"}}))
			.is_none());
	}

	/// Le vrai binaire `codex` est absent de tout poste où ce module a été
	/// écrit et testé : ce test fait tourner un faux `codex` (un script qui
	/// imite la forme documentée de `codex exec`/`codex exec resume --json`)
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
if [ "$1" = "exec" ] && [ "$2" = "resume" ]; then
  thread="$3"; shift 3
  [ "$1" = "--json" ] && shift
  [ "$1" = "--" ] && shift
  echo "{\"type\":\"thread.started\",\"thread_id\":\"$thread\"}"
  echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"resume: $1\"}}"
  echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
elif [ "$1" = "exec" ]; then
  shift
  [ "$1" = "--json" ] && shift
  [ "$1" = "--" ] && shift
  echo '{"type":"thread.started","thread_id":"thread-xyz"}'
  echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"got: $1\"}}"
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

		async fn run(command: &str) -> Vec<Value> {
			let child = crate::platform::shell_async(command)
				.stdout(std::process::Stdio::piped())
				.spawn()
				.expect("le faux codex doit se lancer");
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
			first_turn("codex", "fix the failing test")
		);
		let events = run(&command).await;
		let started = events.iter().find(|e| thread_id(e).is_some()).unwrap();
		assert_eq!(thread_id(started), Some("thread-xyz"));
		assert!(events.iter().any(|e| turn_finished(e)));
		assert!(
			events
				.iter()
				.any(|e| e.get("item").and_then(|i| i.get("text")).and_then(|t| t.as_str())
					== Some("got: fix the failing test"))
		);

		// Le tour suivant reprend le même fil — c'est la partie qu'une simple
		// vérification de texte ne peut pas prouver : que la commande générée
		// se lance et rend vraiment le `thread_id` qu'on lui a donné.
		let command = format!(
			"export PATH={}:$PATH; {}",
			crate::platform::shell_path(&dir.to_string_lossy()),
			resume_turn("codex", "thread-xyz", "go on")
		);
		let events = run(&command).await;
		let started = events.iter().find(|e| thread_id(e).is_some()).unwrap();
		assert_eq!(thread_id(started), Some("thread-xyz"));

		let _ = std::fs::remove_dir_all(&dir);
	}
}
