//! Sonde du relevé d'exécutions : écrit une exécution complète, la relit, et
//! la retire.
//!
//! `cargo run --example executions`
//!
//! Les décisions de lecture sont éprouvées par les tests purs du module
//! (`fold_raw`, `to_evict`, `turn_of`). Ce qu'ils ne peuvent pas montrer, c'est
//! le chemin d'écriture réel : le dossier créé, les droits posés, une ligne
//! ajoutée puis relue depuis le disque. C'est ce que cette sonde exerce — sans
//! lancer le moindre agent, ni toucher à une mission.
//!
//! Elle écrit dans le vrai `~/.config/cockpit/executions/` puis retire ses
//! propres lignes : un relevé de production n'a pas à porter les traces d'une
//! vérification.

use cockpit_lib::executions::{self, ExecEvent, Opening, Origin, Outcome, Step};
use cockpit_lib::protocol::Protocol;

fn main() {
	let index = executions::dir().join("index.jsonl");
	let existait = index.exists();
	let avant = std::fs::read_to_string(&index).unwrap_or_default();

	println!("journal     : {}", index.display());

	let id = executions::open(Opening {
		session_id: "agent-sonde".into(),
		protocol: "claude-stream-json".into(),
		engine: "claude".into(),
		engine_label: "Claude Code".into(),
		model: "opus".into(),
		mission: "mission-sonde".into(),
		origin: Origin::master("backend", "tache-2", 1),
		cwd: std::env::current_dir()
			.map(|p| p.to_string_lossy().to_string())
			.unwrap_or_default(),
		project: "sonde".into(),
		sandboxed: false,
	});
	println!("exécution   : {id}");

	executions::mark_engine_session(&id, "conversation-du-moteur");

	// Le détail, tel qu'il arrive du flux : la consigne, puis ce que le moteur
	// en a fait. On passe par la forme de Claude Code — celle que les trois
	// protocoles atteignent — pour exercer la vraie chaîne de traduction.
	executions::note_events(
		&id,
		&[ExecEvent::Prompt {
			text: "Corrige le sélecteur de propriété.".into(),
		}],
	);
	for payload in [
		serde_json::json!({
			"type": "assistant",
			"message": { "content": [{ "type": "text", "text": "Je regarde le composant." }] }
		}),
		serde_json::json!({
			"type": "assistant",
			"message": { "content": [{
				"type": "tool_use", "id": "toolu_1", "name": "Edit",
				"input": { "file_path": "src/Select.tsx", "old_string": "avant" }
			}] }
		}),
		serde_json::json!({
			"type": "user",
			"message": { "content": [{
				"type": "tool_result", "tool_use_id": "toolu_1", "content": "modifié"
			}] }
		}),
	] {
		executions::note_events(&id, &executions::from_claude_shaped(&payload));
	}

	// Et la même chose depuis un événement Codex natif : c'est cette chaîne-là
	// qui donne enfin un historique aux moteurs qui n'en écrivent aucun.
	let codex = serde_json::json!({
		"type": "item.completed",
		"item": { "type": "agent_message", "text": "Commande jouée." }
	});
	let shaped = cockpit_lib::codex::to_claude_shaped(&codex).expect("traduction Codex");
	executions::note_events(&id, &executions::from_claude_shaped(&shaped));

	executions::note_turn(
		&id,
		Protocol::Claude,
		&serde_json::json!({
			"type": "result",
			"total_cost_usd": 0.1234,
			"usage": { "input_tokens": 4200, "output_tokens": 310, "cache_read_input_tokens": 90 }
		}),
	);
	executions::note_turn(&id, Protocol::Codex, &serde_json::json!({ "type": "turn.completed" }));
	executions::note_step(&id, Step::Answered, "");

	let relu = executions::for_mission("mission-sonde");
	let Some(exec) = relu.iter().find(|exec| exec.id == id) else {
		eprintln!("ÉCHEC : l'exécution ne se relit pas depuis le disque.");
		std::process::exit(1);
	};

	println!("issue       : {:?}", exec.outcome);
	println!("moteur      : {} · {}", exec.opening.engine_label, exec.opening.model);
	println!(
		"origine     : {} · rôle {} · tâche {} · tentative {}",
		exec.opening.origin.actor, exec.opening.origin.role, exec.opening.origin.task, exec.opening.origin.attempt
	);
	println!("conversation: {}", exec.engine_session);
	println!(
		"tours       : {} · {} jetons d'entrée · {} de sortie",
		exec.tally.turns, exec.tally.input_tokens, exec.tally.output_tokens
	);
	println!(
		"coût        : {:.4} $ annoncés · {:.4} $ estimés · {} tour(s) muet(s)",
		exec.tally.cost.reported_usd, exec.tally.cost.estimated_usd, exec.tally.cost.unknown_turns
	);
	println!(
		"étapes      : {:?}",
		exec.steps.iter().map(|m| m.step).collect::<Vec<_>>()
	);

	// Le détail relu depuis le disque, dans la forme que l'écran Agents affiche
	// déjà : c'est le critère qui prouve que le trou est bouché.
	let timeline = executions::timeline_as_events(&id);
	println!("\ntimeline    : {} événements", timeline.len());
	for event in &timeline {
		let tool = event.tool.as_deref().map(|t| format!(" [{t}]")).unwrap_or_default();
		println!(
			"  {:<12}{}{}",
			event.kind,
			tool,
			cockpit_lib::executions::clip_input(&event.text)
		);
	}
	assert!(
		timeline.iter().any(|e| e.kind == "user"),
		"la consigne doit figurer dans la timeline"
	);
	assert!(
		timeline.iter().filter(|e| e.kind == "assistant").count() >= 2,
		"les phrases de l'agent, Codex compris, doivent y figurer"
	);
	assert!(
		timeline.iter().any(|e| e.kind == "tool-result"),
		"la sortie de l'outil doit y figurer"
	);
	assert!(
		timeline.last().is_some_and(|e| e.kind == "system"),
		"la timeline doit se terminer sur la fin de l'agent"
	);
	println!(
		"observable  : coût {} · découpage {} · sorties d'outils {}",
		exec.observability.reports_cost,
		exec.observability.reports_token_split,
		exec.observability.reports_tool_results
	);

	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let mode = std::fs::metadata(&index)
			.map(|meta| meta.permissions().mode() & 0o777)
			.unwrap_or(0);
		println!("droits      : {mode:o}");
		assert_eq!(mode, 0o600, "le journal doit rester lisible par son seul propriétaire");
	}

	assert_eq!(exec.outcome, Outcome::Answered);
	assert_eq!(exec.tally.turns, 2);
	// Le tour Codex n'annonce aucun coût : compté à part, jamais comme gratuit.
	assert_eq!(exec.tally.cost.unknown_turns, 1);

	// Le détail vit dans son dossier du jour, à côté de l'index.
	let detail = executions::dir()
		.join(&exec.started_at[..10])
		.join(format!("{id}.jsonl"));
	println!("\ndétail      : {}", detail.display());
	let _ = std::fs::remove_file(&detail);
	let _ = std::fs::remove_dir(executions::dir().join(&exec.started_at[..10]));

	// On remet le journal dans l'état où on l'a trouvé.
	if existait {
		std::fs::write(&index, avant).expect("restauration du journal");
	} else {
		std::fs::remove_file(&index).expect("retrait du journal de sonde");
		let _ = std::fs::remove_dir(executions::dir());
	}
	println!("\nrelevé restauré — rien de la sonde ne reste sur le poste.");
}
