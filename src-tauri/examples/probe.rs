//! Sonde de vérification : exerce toute la chaîne de lecture sur les données
//! réelles du poste, sans passer par l'interface.
//!
//! `cargo run --example probe`

use cockpit_lib::{config::Config, docs, git, sessions, slash, system};
use std::path::{Path, PathBuf};

#[tokio::main]
async fn main() {
	let config = Config::load();
	println!("config      : {}", cockpit_lib::config::config_path().display());
	println!("dépôt       : {}", config.general.main_repo);
	println!("éditeur     : {}\n", config.general.editor);

	let repo = PathBuf::from(&config.general.main_repo);
	match git::list_worktrees(&repo).await {
		Ok(trees) => {
			println!("── worktrees : {} ──", trees.len());
			for tree in trees.iter().take(6) {
				let status = &tree.status;
				println!(
					"  {:<44} {:<34} {}M {}S {}U ↑{} ↓{}",
					tree.folder_name,
					tree.branch.clone().unwrap_or_else(|| "(detached)".into()),
					status.modified,
					status.staged,
					status.untracked,
					status.ahead,
					status.behind,
				);
			}
		}
		Err(error) => println!("worktrees : ERREUR {error}"),
	}

	match sessions::scan_all(20) {
		Ok(projects) => {
			let total: usize = projects.iter().map(|p| p.sessions.len()).sum();
			println!("\n── sessions : {total} dans {} projets ──", projects.len());
			let mut all: Vec<_> = projects.iter().flat_map(|p| p.sessions.iter()).collect();
			all.sort_by_key(|s| s.idle_seconds);
			for session in all.iter().take(6) {
				println!(
					"  [{:>6}s] {:<58} {:>3}↔{:<3} {:>4} outils {:>3} agents  {}",
					session.idle_seconds,
					session.title.chars().take(58).collect::<String>(),
					session.user_messages,
					session.assistant_messages,
					session.tool_calls,
					session.subagents,
					session.git_branch.clone().unwrap_or_default(),
				);
			}

			if let Some(first) = all.first() {
				let file = Path::new(&first.file);
				match sessions::read_timeline(file, 400) {
					Ok(events) => {
						println!("\n── timeline de la session la plus fraîche : {} événements ──", events.len());
						for event in events.iter().rev().take(5).rev() {
							println!(
								"  {:<12} {}",
								event.kind,
								event.text.replace('\n', " ").chars().take(96).collect::<String>()
							);
						}
					}
					Err(error) => println!("timeline : ERREUR {error}"),
				}
				match sessions::read_subagents(file) {
					Ok(runs) => println!("  sous-agents : {}", runs.len()),
					Err(error) => println!("  sous-agents : ERREUR {error}"),
				}
			}
		}
		Err(error) => println!("sessions : ERREUR {error}"),
	}

	let roots = vec![(repo.clone(), "monorepo".to_string())];
	match docs::scan_many(roots, 8) {
		Ok(entries) => {
			println!("\n── documents : {} ──", entries.len());
			for doc in entries.iter().take(5) {
				println!("  {:<12} {:<48} {}", doc.category, doc.name, doc.relative);
			}
		}
		Err(error) => println!("documents : ERREUR {error}"),
	}

	match system::package_scripts(&repo) {
		Ok(scripts) => println!("\nscripts package.json : {}", scripts.len()),
		Err(error) => println!("scripts : ERREUR {error}"),
	}
	match slash::list(repo.to_string_lossy().into_owned()) {
		Ok(commands) => println!("slash-commands       : {}", commands.len()),
		Err(error) => println!("slash-commands : ERREUR {error}"),
	}
	match system::listening_ports().await {
		Ok(ports) => println!(
			"ports en écoute      : {} (dev : {})",
			ports.len(),
			ports.iter().filter(|p| p.port >= 3000 && p.port <= 4999).count()
		),
		Err(error) => println!("ports : ERREUR {error}"),
	}
	match system::docker_containers().await {
		Ok(containers) => println!(
			"conteneurs docker    : {} ({} actifs)",
			containers.len(),
			containers.iter().filter(|c| c.state == "running").count()
		),
		Err(error) => println!("docker : {error}"),
	}
}
