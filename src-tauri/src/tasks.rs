//! Tâches personnelles, celles qui n'ont leur place nulle part ailleurs.
//!
//! Le cockpit sait déjà tout ce que les outils racontent — tickets, PR, CI.
//! Restent les intentions qui n'existent que dans la tête : rappeler un
//! prestataire, relire une migration avant lundi. Elles vivent ici, à côté du
//! reste, plutôt que dans un carnet que l'on ne rouvre pas.
//!
//! Un fichier par projet : les listes ne se mélangent pas d'un contexte à
//! l'autre, et l'ensemble reste lisible à la main.

use crate::config::config_dir;
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Task {
	pub id: String,
	pub text: String,
	pub done: bool,
	/// `normal` ou `high` — deux niveaux suffisent à trier une liste du jour.
	pub priority: String,
	pub created_at: u64,
	/// Renseigné au moment où la case est cochée.
	pub done_at: Option<u64>,
}

fn tasks_path(project: &str) -> PathBuf {
	let safe: String = project
		.chars()
		.map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
		.collect();
	config_dir().join(format!("tasks-{safe}.json"))
}

fn now() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0)
}

pub fn list(project: &str) -> Vec<Task> {
	let Ok(raw) = std::fs::read_to_string(tasks_path(project)) else {
		return Vec::new();
	};
	let mut tasks: Vec<Task> = serde_json::from_str(&raw).unwrap_or_default();

	// Ce qui reste à faire d'abord, l'urgent en tête, le plus ancien avant :
	// une liste du jour se lit de haut en bas, sans arbitrage.
	tasks.sort_by(|a, b| {
		a.done
			.cmp(&b.done)
			.then_with(|| (b.priority == "high").cmp(&(a.priority == "high")))
			.then_with(|| a.created_at.cmp(&b.created_at))
	});
	tasks
}

fn write(project: &str, tasks: &[Task]) -> Result<()> {
	std::fs::create_dir_all(config_dir())
		.map_err(|e| CockpitError::msg(crate::i18n::tf("tasks.configDir", &[("error", &e)])))?;
	let raw = serde_json::to_string_pretty(tasks)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("tasks.serialize", &[("error", &e)])))?;
	std::fs::write(tasks_path(project), raw)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("tasks.write", &[("error", &e)])))?;
	Ok(())
}

pub fn add(project: &str, text: &str, priority: &str) -> Result<Vec<Task>> {
	let text = text.trim();
	if text.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("tasks.titleRequired")));
	}
	let mut tasks = list(project);
	tasks.push(Task {
		// L'horodatage suffit à distinguer deux tâches saisies à la main.
		id: format!("{:x}", now().wrapping_mul(1_000_003) ^ tasks.len() as u64),
		text: text.to_string(),
		done: false,
		priority: if priority == "high" { "high" } else { "normal" }.to_string(),
		created_at: now(),
		done_at: None,
	});
	write(project, &tasks)?;
	Ok(list(project))
}

/// Coche ou décoche une tâche.
pub fn toggle(project: &str, id: &str) -> Result<Vec<Task>> {
	let mut tasks = list(project);
	if let Some(task) = tasks.iter_mut().find(|task| task.id == id) {
		task.done = !task.done;
		task.done_at = task.done.then(now);
	}
	write(project, &tasks)?;
	Ok(list(project))
}

pub fn remove(project: &str, id: &str) -> Result<Vec<Task>> {
	let mut tasks = list(project);
	tasks.retain(|task| task.id != id);
	write(project, &tasks)?;
	Ok(list(project))
}

/// Oublie les tâches faites : une liste du jour ne garde pas ses archives.
pub fn clear_done(project: &str) -> Result<Vec<Task>> {
	let mut tasks = list(project);
	tasks.retain(|task| !task.done);
	write(project, &tasks)?;
	Ok(list(project))
}
