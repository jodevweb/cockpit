//! Exécution de commandes avec sortie streamée vers l'UI.
//!
//! Chaque lancement crée un job identifié ; stdout et stderr sont poussés ligne
//! par ligne dans le webview via l'événement `job://output`. Un job reste
//! interruptible tant qu'il tourne.

use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLine {
	pub job_id: String,
	pub stream: String,
	pub line: String,
	pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
	pub job_id: String,
	pub label: String,
	pub command: String,
	pub cwd: String,
	pub state: String,
	pub exit_code: Option<i32>,
	pub started_at: i64,
	pub ended_at: Option<i64>,
	pub pid: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
	pub label: String,
	/// Ligne de commande complète, exécutée via `zsh -lc` pour hériter du PATH
	/// utilisateur (bun, pnpm, mise…).
	pub command: String,
	pub cwd: String,
}

#[derive(Default)]
pub struct JobRegistry {
	jobs: Mutex<HashMap<String, JobStatus>>,
}

pub type SharedJobs = Arc<JobRegistry>;

impl JobRegistry {
	pub fn snapshot(&self) -> Vec<JobStatus> {
		let jobs = self.jobs.lock().unwrap();
		let mut list: Vec<JobStatus> = jobs.values().cloned().collect();
		list.sort_by_key(|j| std::cmp::Reverse(j.started_at));
		list
	}

	fn set(&self, status: JobStatus) {
		self.jobs
			.lock()
			.unwrap()
			.insert(status.job_id.clone(), status);
	}

	fn finish(&self, job_id: &str, state: &str, exit_code: Option<i32>) -> Option<JobStatus> {
		let mut jobs = self.jobs.lock().unwrap();
		let status = jobs.get_mut(job_id)?;
		// Un job déjà terminé ne doit pas être « re-terminé » par une annulation
		// arrivée trop tard.
		if status.state != "running" {
			return Some(status.clone());
		}
		status.state = state.to_string();
		status.exit_code = exit_code;
		status.ended_at = Some(chrono::Utc::now().timestamp());
		Some(status.clone())
	}
}

fn emit_line(app: &AppHandle, job_id: &str, stream: &str, line: String) {
	let _ = app.emit(
		"job://output",
		JobLine {
			job_id: job_id.to_string(),
			stream: stream.to_string(),
			line,
			at: chrono::Utc::now().timestamp_millis(),
		},
	);
}

pub async fn spawn_job(app: AppHandle, jobs: SharedJobs, request: JobRequest) -> Result<JobStatus> {
	let cwd = std::path::PathBuf::from(&request.cwd);
	if !cwd.is_dir() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"runner.dirNotFound",
			&[("path", &request.cwd)],
		)));
	}

	let job_id = format!("job-{}", JOB_SEQUENCE.fetch_add(1, Ordering::SeqCst));

	let mut child = Command::new("zsh")
		.arg("-lc")
		.arg(&request.command)
		.current_dir(&cwd)
		// Sans TTY, les outils qui détectent un terminal changent de rendu ;
		// on force un mode non interactif propre.
		.env("CI", "1")
		.env("FORCE_COLOR", "1")
		.env("TERM", "xterm-256color")
		// Groupe de processus dédié : `pnpm`/`turbo` essaiment des enfants, et
		// une annulation doit emporter toute la descendance.
		.process_group(0)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.stdin(Stdio::null())
		.kill_on_drop(false)
		.spawn()
		.map_err(|e| CockpitError::msg(crate::i18n::tf("runner.launchFailed", &[("error", &e)])))?;

	let status = JobStatus {
		job_id: job_id.clone(),
		label: request.label.clone(),
		command: request.command.clone(),
		cwd: request.cwd.clone(),
		state: "running".into(),
		exit_code: None,
		started_at: chrono::Utc::now().timestamp(),
		ended_at: None,
		pid: child.id(),
	};
	jobs.set(status.clone());

	let stdout = child.stdout.take();
	let stderr = child.stderr.take();

	if let Some(stdout) = stdout {
		let app = app.clone();
		let id = job_id.clone();
		tokio::spawn(async move {
			let mut lines = BufReader::new(stdout).lines();
			while let Ok(Some(line)) = lines.next_line().await {
				emit_line(&app, &id, "stdout", line);
			}
		});
	}
	if let Some(stderr) = stderr {
		let app = app.clone();
		let id = job_id.clone();
		tokio::spawn(async move {
			let mut lines = BufReader::new(stderr).lines();
			while let Ok(Some(line)) = lines.next_line().await {
				emit_line(&app, &id, "stderr", line);
			}
		});
	}

	{
		let app = app.clone();
		let jobs = jobs.clone();
		let id = job_id.clone();
		tokio::spawn(async move {
			let outcome = child.wait().await;
			let (state, code) = match outcome {
				Ok(exit) if exit.success() => ("succeeded", exit.code()),
				Ok(exit) => ("failed", exit.code()),
				Err(_) => ("failed", None),
			};
			if let Some(status) = jobs.finish(&id, state, code) {
				let _ = app.emit("job://status", status);
			}
		});
	}

	Ok(status)
}

pub fn kill_job(jobs: &SharedJobs, job_id: &str) -> Result<()> {
	let pid = {
		let registry = jobs.jobs.lock().unwrap();
		let status = registry
			.get(job_id)
			.ok_or_else(|| CockpitError::msg(crate::i18n::t("runner.unknownJob")))?;
		if status.state != "running" {
			return Ok(());
		}
		status.pid
	};

	if let Some(pid) = pid {
		// Le `-` cible le groupe entier créé au spawn.
		let _ = std::process::Command::new("kill")
			.args(["-TERM", &format!("-{pid}")])
			.status();
	}
	jobs.finish(job_id, "cancelled", None);
	Ok(())
}

/// Exécution courte et bloquante, pour les commandes dont on veut juste la
/// sortie (git, gh, docker ps…).
pub async fn capture(cwd: &str, command: &str) -> Result<String> {
	capture_with_env(cwd, command, &[]).await
}

/// Le même, avec des variables d'environnement.
///
/// **C'est par là que passent les secrets, jamais par la ligne de commande.**
/// Un `SECRET=… commande` est lisible dans `ps` par tout processus du poste, et
/// se retrouve dans l'historique du shell ; l'environnement d'un processus, lui,
/// n'est lisible que par son propriétaire.
pub async fn capture_with_env(
	cwd: &str,
	command: &str,
	env: &[(&str, &str)],
) -> Result<String> {
	let mut builder = Command::new("zsh");
	builder.arg("-lc").arg(command).current_dir(cwd);
	for (name, value) in env {
		builder.env(name, value);
	}
	let output = builder
		.output()
		.await
		.map_err(|e| CockpitError::msg(format!("{command} : {e}")))?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
		let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
		let detail = if stderr.is_empty() { stdout } else { stderr };
		return Err(CockpitError::msg(format!("{command} : {detail}")));
	}
	Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
