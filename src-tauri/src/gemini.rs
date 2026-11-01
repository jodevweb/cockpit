//! Adaptateur pour le protocole `gemini-stream-json` (`gemini --output-format
//! stream-json`, Google Gemini CLI).
//!
//! Le moins bien documenté des deux protocoles supplémentaires. Ce qui suit
//! vient de la pull request qui a livré le format
//! (google-gemini/gemini-cli#10883, fermant la demande #8203), pas d'une
//! page de documentation stabilisée : au moment où ceci a été écrit, une page
//! officielle (headless.md, miroir GitHub) décrivait `stream-json` avec ses
//! six types d'événements, tandis qu'une autre (le site rendu) ne mentionnait
//! que deux formats et l'ignorait complètement. Le schéma ci-dessous est donc
//! à confiance moyenne — pas vérifié comme celui de `codex.rs`, dont la
//! documentation était au moins cohérente d'une source à l'autre.
//!
//! Deux conséquences directes, assumées plutôt que masquées :
//!
//! - **Aucune reprise.** Rien, nulle part, ne documente comment continuer une
//!   conversation lancée par `-p`/`--output-format stream-json` — le
//!   `--resume <id>` documenté ouvre l'interface interactive sur une session
//!   passée, pas une nouvelle question en tâche de fond. Un agent Gemini ne
//!   reçoit donc qu'**un seul message** : une fois le tour fini, le process
//!   meurt et suit le chemin par défaut (pas de `PerTurn`, contrairement à
//!   Codex) — `agent::send` retombe alors sur l'erreur générique « agent plus
//!   actif », qui est vraie plutôt qu'inventée.
//! - **Le texte de l'agent n'est pas accumulé.** Le schéma vu suggère des
//!   morceaux de message (`"delta":true`), sans qu'on sache s'ils sont
//!   incrémentaux ou cumulatifs — les concaténer à l'aveugle risquerait un
//!   texte dupliqué ou tronqué, une donnée fausse. Chaque morceau est donc
//!   traduit tel quel, au risque d'un fil plus haché qu'avec la vraie
//!   sémantique, jamais un texte inventé.
//!
//! À vérifier contre le vrai binaire dès qu'il est disponible — absent de
//! tout poste où ceci a été écrit.

use serde_json::{json, Value};

fn shell_quote(value: &str) -> String {
	format!("'{}'", value.replace('\'', "'\\''"))
}

/// Ligne de commande du tour unique — il n'y en a qu'un, voir la doc du
/// module. Ordre des drapeaux tel que proposé dans la pull request qui a
/// livré le format : `--output-format` avant `--prompt`.
pub fn first_turn(binary: &str, prompt: &str) -> String {
	format!(
		"{} --output-format stream-json --prompt {}",
		shell_quote(binary),
		shell_quote(prompt)
	)
}

/// Traduit un événement vers la forme que le fil de discussion sait déjà
/// lire (`readEvent`, `src/app/agents.tsx`) — celle de Claude Code. Confiance
/// moyenne sur les noms de champs : voir la doc du module.
pub fn to_claude_shaped(payload: &Value) -> Option<Value> {
	let kind = payload.get("type").and_then(|v| v.as_str())?;
	match kind {
		"message" => {
			let role = payload.get("role").and_then(|v| v.as_str())?;
			// Le message utilisateur est celui qu'on a nous-mêmes envoyé : le
			// réafficher doublerait la bulle que l'interface a déjà posée à
			// l'envoi.
			if role != "assistant" {
				return None;
			}
			let text = payload.get("content").and_then(|v| v.as_str())?;
			if text.is_empty() {
				return None;
			}
			Some(json!({
				"type": "assistant",
				"message": { "content": [{ "type": "text", "text": text }] },
			}))
		}
		"tool_use" => {
			let name = payload.get("tool_name").and_then(|v| v.as_str())?;
			let id = payload
				.get("tool_id")
				.and_then(|v| v.as_str())
				.unwrap_or("gemini-tool");
			let input = payload.get("parameters").cloned().unwrap_or_else(|| json!({}));
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
		"tool_result" => {
			let id = payload.get("tool_id").and_then(|v| v.as_str())?;
			let output = payload.get("output").and_then(|v| v.as_str()).unwrap_or("");
			let failed = payload.get("status").and_then(|v| v.as_str()) == Some("error");
			Some(json!({
				"type": "user",
				"message": { "content": [{
					"type": "tool_result",
					"tool_use_id": id,
					"content": output,
					"is_error": failed,
				}] },
			}))
		}
		"result" => Some(json!({
			"type": "result",
			"is_error": payload.get("status").and_then(|v| v.as_str()) == Some("error"),
		})),
		// `init` (métadonnées de session) et `error` (avertissement non fatal,
		// pas la fin du tour) n'ont pas d'équivalent affichable côté Claude —
		// rien à en faire pour l'instant plutôt qu'un mauvais raccourci.
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn la_ligne_de_commande_suit_l_ordre_documente() {
		assert_eq!(
			first_turn("gemini", "list files"),
			"'gemini' --output-format stream-json --prompt 'list files'"
		);
	}

	#[test]
	fn un_message_assistant_se_traduit_en_texte() {
		let payload = json!({"type": "message", "role": "assistant", "content": "Voici."});
		let translated = to_claude_shaped(&payload).unwrap();
		assert_eq!(translated["type"], "assistant");
		assert_eq!(translated["message"]["content"][0]["text"], "Voici.");
	}

	#[test]
	fn un_message_utilisateur_ne_se_traduit_pas() {
		// On l'a déjà affiché nous-mêmes à l'envoi : pas de doublon.
		let payload = json!({"type": "message", "role": "user", "content": "list files"});
		assert!(to_claude_shaped(&payload).is_none());
	}

	#[test]
	fn un_appel_d_outil_se_traduit_avec_ses_parametres() {
		let payload = json!({
			"type": "tool_use",
			"tool_name": "Bash",
			"tool_id": "bash-123",
			"parameters": { "command": "ls" },
		});
		let translated = to_claude_shaped(&payload).unwrap();
		assert_eq!(translated["message"]["content"][0]["name"], "Bash");
		assert_eq!(translated["message"]["content"][0]["input"]["command"], "ls");
	}

	#[test]
	fn un_resultat_d_outil_se_traduit_avec_son_erreur() {
		let payload = json!({
			"type": "tool_result",
			"tool_id": "bash-123",
			"status": "success",
			"output": "file1.txt",
		});
		let translated = to_claude_shaped(&payload).unwrap();
		assert_eq!(translated["message"]["content"][0]["tool_use_id"], "bash-123");
		assert_eq!(translated["message"]["content"][0]["content"], "file1.txt");
		assert_eq!(translated["message"]["content"][0]["is_error"], false);
	}

	#[test]
	fn la_fin_du_tour_se_traduit_selon_son_statut() {
		let ok = to_claude_shaped(&json!({"type": "result", "status": "success"})).unwrap();
		assert_eq!(ok["is_error"], false);
		let ko = to_claude_shaped(&json!({"type": "result", "status": "error"})).unwrap();
		assert_eq!(ko["is_error"], true);
	}

	#[test]
	fn init_et_error_n_ont_pas_de_traduction() {
		assert!(to_claude_shaped(&json!({"type": "init", "session_id": "abc"})).is_none());
		assert!(to_claude_shaped(&json!({"type": "error", "message": "avertissement"})).is_none());
	}

	/// Même démarche que pour Codex : pas de vrai binaire `gemini` sur ce
	/// poste, donc un faux CLI qui imite la forme vue dans la pull request,
	/// lancé exactement comme `agent.rs` le ferait.
	#[tokio::test]
	async fn le_faux_gemini_confirme_la_ligne_de_commande_et_la_lecture() {
		use tokio::io::{AsyncBufReadExt, BufReader};
		use tokio::process::Command;

		let dir = std::env::temp_dir().join(format!("cockpit-gemini-test-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let script = dir.join("gemini");
		std::fs::write(
			&script,
			r#"#!/bin/sh
# Cherche --prompt et prend l'argument suivant.
prompt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prompt" ]; then prompt="$arg"; fi
  prev="$arg"
done
echo '{"type":"init","session_id":"gem-session-1","model":"gemini-2.0-flash-exp"}'
echo "{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"got: $prompt\"}"
echo '{"type":"result","status":"success","stats":{"total_tokens":10}}'
"#,
		)
		.unwrap();
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
		}

		let command = format!(
			"export PATH={}:$PATH; {}",
			dir.display(),
			first_turn("gemini", "list the files")
		);
		let child = Command::new("zsh")
			.arg("-lc")
			.arg(&command)
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("le faux gemini doit se lancer");
		let stdout = child.stdout.expect("stdout piped");
		let mut lines = BufReader::new(stdout).lines();
		let mut events = Vec::new();
		while let Ok(Some(line)) = lines.next_line().await {
			if let Ok(payload) = serde_json::from_str::<Value>(&line) {
				events.push(payload);
			}
		}

		let translated: Vec<Value> = events.iter().filter_map(to_claude_shaped).collect();
		// `init` ne se traduit pas : seuls le message et le résultat doivent
		// traverser.
		assert_eq!(translated.len(), 2);
		assert_eq!(translated[0]["message"]["content"][0]["text"], "got: list the files");
		assert_eq!(translated[1]["type"], "result");

		let _ = std::fs::remove_dir_all(&dir);
	}
}
