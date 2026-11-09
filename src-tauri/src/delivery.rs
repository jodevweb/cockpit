//! Le dossier de livraison : ce que le cockpit a mesuré d'une mission, posé sur
//! sa pull request.
//!
//! Le relecteur d'une PR d'agents ne voyait qu'un diff et une description
//! rédigée par un agent — ce que l'agent *dit* avoir fait. Le cockpit sait
//! pourtant bien davantage, et sans rien demander à personne : les portes du
//! dépôt ont passé ou non (`gates.rs`), la recette et la relecture ont rendu un
//! verdict (`mission::Verdict`), les propriétés tiennent ou non
//! (`properties.rs`), la recette a été filmée (`proof.rs`), et le relevé des
//! exécutions sait ce que la mission a coûté (`executions.rs`).
//!
//! Le dossier assemble ces faits, les montre dans l'écran de la mission —
//! vidéos comprises, lues sur le poste — et, si le projet le veut
//! (`workflow.deliveryDossier`, vrai par défaut), les publie sur la PR :
//!
//! - une **section de la description**, entre deux balises, réécrite en place ;
//! - un **statut de commit** `cockpit/dossier` sur la tête de la branche. Un
//!   statut et non un *check run* : l'API des check runs est réservée aux
//!   GitHub Apps, un jeton personnel ne peut pas en créer.
//!
//! Les vidéos ne partent jamais : elles restent sur le poste. Une capture peut
//! montrer un jeton ou une donnée client, et un dépôt public la montrerait à
//! tout le monde.
//!
//! Une règle tient tout le module : **rien n'est présenté comme acquis qui ne
//! l'est pas.** Une recette indécise, une propriété décorative, une porte qui
//! tourne encore se disent telles quelles, jamais derrière une coche.

use serde::Serialize;

use crate::error::{CockpitError, Result};
use crate::mission::{self, Gate, Mission, TaskState, Verdict};

const START: &str = "<!-- cockpit:dossier:start -->";
const END: &str = "<!-- cockpit:dossier:end -->";
const CONTEXT: &str = "cockpit/dossier";

/// Ce que le dossier conclut, et ce que dira le statut de commit.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "DeliveryOverall"))]
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Overall {
	Success,
	Pending,
	Failure,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "DeliveryGate"))]
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateLine {
	pub task: String,
	pub gate: Gate,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "DeliveryVerdict"))]
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerdictLine {
	pub task: String,
	pub role: String,
	/// Vide tant que la vérification n'a rien rendu.
	pub verdict: String,
	pub delivered: bool,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "DeliveryProperties"))]
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesLine {
	pub total: usize,
	pub held: usize,
	pub broken: usize,
	/// Ni tenue ni enfreinte : indécise ou hors sujet.
	pub unsettled: usize,
	/// Parmi celles qui tiennent, celles qui n'ont jamais attrapé de bug quand on
	/// les a rejouées sur les anciens correctifs du dépôt.
	pub decorative: usize,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "DeliveryFilm"))]
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilmLine {
	pub task: String,
	/// Le fichier sur le poste, lu par l'interface (`asset://`). Jamais publié.
	pub path: String,
	#[cfg_attr(test, ts(type = "number"))]
	pub bytes: u64,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "DeliveryChanges"))]
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
	pub files: u32,
	pub insertions: u32,
	pub deletions: u32,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "DeliveryCost"))]
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostLine {
	pub tasks: usize,
	pub reworks: u32,
	#[cfg_attr(test, ts(type = "number"))]
	pub worked_seconds: u64,
	#[cfg_attr(test, ts(type = "number"))]
	pub tokens: u64,
	pub usd: f64,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, rename = "DeliveryDossier"))]
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dossier {
	pub mission_id: String,
	pub title: String,
	pub branch: String,
	/// Les commandes que le dépôt déclare comme portes ; vide s'il n'en a pas.
	pub gate_commands: Vec<String>,
	pub gates: Vec<GateLine>,
	pub verdicts: Vec<VerdictLine>,
	pub properties: Option<PropertiesLine>,
	pub films: Vec<FilmLine>,
	pub changes: Option<Changes>,
	pub cost: CostLine,
	pub overall: Overall,
	/// Le dossier en markdown, tel qu'il partirait sur la PR.
	pub markdown: String,
}

// ── Ce qu'on conclut ────────────────────────────────────────────────────────

/// L'état d'ensemble. L'échec l'emporte sur l'attente, l'attente sur le succès :
/// une seule porte rouge suffit, et un verdict indécis n'est pas un accord.
pub fn overall(gates: &[GateLine], verdicts: &[VerdictLine], properties: Option<&PropertiesLine>) -> Overall {
	let failed = gates.iter().any(|line| line.gate == Gate::Failed)
		|| verdicts
			.iter()
			.any(|line| Verdict::parse(&line.verdict) == Some(Verdict::Blocking))
		|| properties.is_some_and(|line| line.broken > 0);
	if failed {
		return Overall::Failure;
	}
	let pending = gates
		.iter()
		.any(|line| line.gate == Gate::Running || line.gate == Gate::None)
		|| verdicts
			.iter()
			.any(|line| !line.delivered || matches!(Verdict::parse(&line.verdict), None | Some(Verdict::Undecided)))
		|| properties.is_some_and(|line| line.unsettled > 0);
	if pending {
		Overall::Pending
	} else {
		Overall::Success
	}
}

// ── Ce qu'on écrit ──────────────────────────────────────────────────────────

fn t(key: &str) -> String {
	crate::i18n::t(&format!("delivery.{key}"))
}

fn tf(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
	crate::i18n::tf(&format!("delivery.{key}"), args)
}

/// Le dossier en markdown. Pur : tout ce qu'il dit vient de `dossier`.
pub fn render(dossier: &Dossier) -> String {
	let mut lines = vec![format!("### {}", t("title")), String::new()];
	let quoted = |tasks: &[&str]| {
		tasks
			.iter()
			.map(|task| format!("« {task} »"))
			.collect::<Vec<_>>()
			.join(", ")
	};

	// Portes.
	if dossier.gate_commands.is_empty() {
		lines.push(format!("- ➖ {}", t("gates.none")));
	} else {
		let commands = dossier
			.gate_commands
			.iter()
			.map(|c| format!("`{c}`"))
			.collect::<Vec<_>>()
			.join(", ");
		let of = |gate: Gate| {
			dossier
				.gates
				.iter()
				.filter(|line| line.gate == gate)
				.map(|line| line.task.as_str())
				.collect::<Vec<_>>()
		};
		let failed = of(Gate::Failed);
		let waiting: Vec<&str> = of(Gate::Running).into_iter().chain(of(Gate::None)).collect();
		if !failed.is_empty() {
			lines.push(format!(
				"- ❌ {}",
				tf("gates.failed", &[("commands", &commands), ("tasks", &quoted(&failed))])
			));
		} else if !waiting.is_empty() {
			lines.push(format!(
				"- ⏳ {}",
				tf(
					"gates.waiting",
					&[("commands", &commands), ("tasks", &quoted(&waiting))]
				)
			));
		} else {
			lines.push(format!("- ✅ {}", tf("gates.passed", &[("commands", &commands)])));
		}
	}

	// Verdicts.
	if dossier.verdicts.is_empty() {
		lines.push(format!("- ➖ {}", t("verdicts.none")));
	}
	for line in &dossier.verdicts {
		let (mark, label) = match (line.delivered, Verdict::parse(&line.verdict)) {
			(false, _) => ("⏳", t("verdicts.waiting")),
			(true, Some(Verdict::Ok)) => ("✅", t("verdicts.ok")),
			(true, Some(Verdict::Reserves)) => ("⚠️", t("verdicts.reserves")),
			(true, Some(Verdict::Blocking)) => ("❌", t("verdicts.blocking")),
			(true, Some(Verdict::Undecided) | None) => ("⚠️", t("verdicts.undecided")),
		};
		lines.push(format!(
			"- {mark} {}",
			tf("verdicts.line", &[("task", &line.task), ("verdict", &label)])
		));
	}

	// Propriétés.
	match &dossier.properties {
		None => lines.push(format!("- ➖ {}", t("properties.none"))),
		Some(p) => {
			let mark = if p.broken > 0 {
				"❌"
			} else if p.unsettled > 0 || p.decorative > 0 {
				"⚠️"
			} else {
				"✅"
			};
			let mut text = tf("properties.held", &[("held", &p.held), ("total", &p.total)]);
			if p.broken > 0 {
				text.push_str(&format!(" · {}", tf("properties.broken", &[("count", &p.broken)])));
			}
			if p.unsettled > 0 {
				text.push_str(&format!(
					" · {}",
					tf("properties.unsettled", &[("count", &p.unsettled)])
				));
			}
			if p.decorative > 0 {
				text.push_str(&format!(
					" · {}",
					tf("properties.decorative", &[("count", &p.decorative)])
				));
			}
			lines.push(format!("- {mark} {text}"));
		}
	}

	// Ce qui a changé, la recette filmée, le coût.
	if let Some(changes) = &dossier.changes {
		lines.push(format!(
			"- 📄 {}",
			tf(
				"changes",
				&[
					("files", &changes.files),
					("insertions", &changes.insertions),
					("deletions", &changes.deletions)
				]
			)
		));
	}
	if !dossier.films.is_empty() {
		lines.push(format!("- 🎬 {}", tf("films", &[("count", &dossier.films.len())])));
	}
	let cost = &dossier.cost;
	lines.push(format!(
		"- 💸 {}",
		tf(
			"cost",
			&[
				("tasks", &cost.tasks),
				("reworks", &cost.reworks),
				("minutes", &(cost.worked_seconds / 60)),
				("tokens", &human_tokens(cost.tokens)),
			]
		)
	));
	lines.push(String::new());
	lines.push(format!("*{}*", t("footer")));
	lines.join("\n")
}

fn human_tokens(tokens: u64) -> String {
	match tokens {
		0 => "0".into(),
		t if t >= 1_000_000 => format!("{:.1} M", t as f64 / 1_000_000.0),
		t if t >= 1_000 => format!("{} k", t / 1_000),
		t => t.to_string(),
	}
}

/// La description, avec le dossier à sa place : entre ses balises s'il y est
/// déjà, à la fin sinon. Le reste de la description n'est jamais touché.
pub fn with_section(body: &str, dossier_markdown: &str) -> String {
	let section = format!("{START}\n{dossier_markdown}\n{END}");
	if let (Some(start), Some(end)) = (body.find(START), body.find(END)) {
		if start < end {
			return format!("{}{section}{}", &body[..start], &body[end + END.len()..]);
		}
	}
	let trimmed = body.trim_end();
	if trimmed.is_empty() {
		section
	} else {
		format!("{trimmed}\n\n{section}")
	}
}

/// `https://github.com/owner/repo/pull/42` → (`owner/repo`, 42).
pub fn github_pull(url: &str) -> Option<(String, u64)> {
	let rest = url.trim().strip_prefix("https://github.com/")?;
	let mut parts = rest.split('/');
	let owner = parts.next()?;
	let repo = parts.next()?;
	if parts.next()? != "pull" {
		return None;
	}
	let number = parts.next()?.split(['?', '#']).next()?.parse().ok()?;
	Some((format!("{owner}/{repo}"), number))
}

// ── Ce qu'on lit ────────────────────────────────────────────────────────────

/// Les vidéos de recette d'un worktree, depuis `since_ms`.
fn films_of(worktree: &str, since_ms: u64) -> Vec<(String, u64)> {
	if worktree.trim().is_empty() {
		return Vec::new();
	}
	let dir = crate::proof::root().join(crate::mcp::key_of(worktree));
	let Ok(entries) = std::fs::read_dir(dir) else {
		return Vec::new();
	};
	let mut films: Vec<(u64, String, u64)> = entries
		.filter_map(|entry| {
			let entry = entry.ok()?;
			let stamp: u64 = entry.file_name().to_str()?.parse().ok()?;
			let film = entry.path().join("preuve.mp4");
			let bytes = std::fs::metadata(&film).ok()?.len();
			(stamp >= since_ms && bytes > 0).then(|| (stamp, film.to_string_lossy().to_string(), bytes))
		})
		.collect();
	films.sort();
	films.into_iter().map(|(_, path, bytes)| (path, bytes)).collect()
}

fn millis(rfc3339: &str) -> u64 {
	chrono::DateTime::parse_from_rfc3339(rfc3339)
		.map(|at| at.timestamp_millis().max(0) as u64)
		.unwrap_or(0)
}

fn parse_shortstat(raw: &str) -> Option<Changes> {
	let number = |word: &str| {
		raw.split(',')
			.find(|part| part.contains(word))
			.and_then(|part| part.split_whitespace().next())
			.and_then(|n| n.parse::<u32>().ok())
			.unwrap_or(0)
	};
	let files = number("file");
	(files > 0).then(|| Changes {
		files,
		insertions: number("insertion"),
		deletions: number("deletion"),
	})
}

fn properties_of(mission: &Mission) -> Option<PropertiesLine> {
	let config = crate::config::Config::load();
	let project = config
		.projects
		.iter()
		.find(|project| crate::platform::same_path(&project.main_repo, &mission.cwd))?;
	let audit = crate::properties::read_audit(&format!("local:{}@{}", project.id, mission.branch))?;
	let calibrations = crate::properties::read_calibrations(&project.id);
	let mut line = PropertiesLine {
		total: audit.checks.len(),
		..Default::default()
	};
	for check in &audit.checks {
		match check.verdict.as_str() {
			"tenue" => {
				line.held += 1;
				if calibrations
					.iter()
					.any(|c| c.property_id == check.property_id && c.decorative())
				{
					line.decorative += 1;
				}
			}
			"enfreinte" => line.broken += 1,
			_ => line.unsettled += 1,
		}
	}
	(line.total > 0).then_some(line)
}

/// Assemble le dossier d'une mission, à partir de ce qui est déjà relevé.
pub async fn compose(mission_id: &str) -> Result<Dossier> {
	let mission = mission::get(mission_id)?;
	let verifiers: Vec<String> = crate::roles_for(&mission.cwd)
		.into_iter()
		.filter(|role| role.verifies)
		.map(|role| role.id)
		.collect();
	let gate_commands = crate::gates::commands_for(&mission.cwd);
	let since = millis(&mission.created_at);

	let mut gates = Vec::new();
	let mut verdicts = Vec::new();
	let mut films = Vec::new();
	for task in mission.tasks.iter().filter(|task| task.state != TaskState::Failed) {
		if verifiers.contains(&task.role) {
			verdicts.push(VerdictLine {
				task: task.title.clone(),
				role: task.role.clone(),
				verdict: task.verdict.clone(),
				delivered: matches!(task.state, TaskState::Delivered | TaskState::Integrated),
			});
		} else if !gate_commands.is_empty() {
			gates.push(GateLine {
				task: task.title.clone(),
				gate: task.gate,
			});
		}
		for (path, bytes) in films_of(&task.worktree, since) {
			films.push(FilmLine {
				task: task.title.clone(),
				path,
				bytes,
			});
		}
	}

	let base = crate::mission_commands::mission_base(&mission).await;
	let changes = crate::git::run_git(
		std::path::Path::new(&mission.cwd),
		&["diff", "--shortstat", &format!("{base}...{}", mission.branch)],
	)
	.await
	.ok()
	.and_then(|raw| parse_shortstat(&raw));

	let mut cost = CostLine {
		tasks: mission.tasks.len(),
		reworks: mission.tasks.iter().map(|task| task.attempts).sum(),
		worked_seconds: mission.tasks.iter().map(|task| task.worked_seconds).sum(),
		..Default::default()
	};
	for execution in crate::executions::fold()
		.into_iter()
		.filter(|e| e.opening.mission == mission.id)
	{
		cost.tokens += execution.tally.input_tokens + execution.tally.output_tokens + execution.tally.cache_tokens;
		cost.usd += execution.tally.cost.reported_usd + execution.tally.cost.estimated_usd;
	}

	let properties = properties_of(&mission);
	let state = overall(&gates, &verdicts, properties.as_ref());
	let mut dossier = Dossier {
		mission_id: mission.id.clone(),
		title: mission.title.clone(),
		branch: mission.branch.clone(),
		gate_commands,
		gates,
		verdicts,
		properties,
		films,
		changes,
		cost,
		overall: state,
		markdown: String::new(),
	};
	dossier.markdown = render(&dossier);
	Ok(dossier)
}

// ── Ce qu'on publie ─────────────────────────────────────────────────────────

/// Publie le dossier sur la pull request de la mission : section de la
/// description et statut de commit. Rend l'adresse de la PR.
pub async fn publish(mission_id: &str) -> Result<String> {
	let mission = mission::get(mission_id)?;
	let (repo, number) = github_pull(&mission.pr_url)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("delivery.errors.noGithubPull")))?;
	let dossier = compose(mission_id).await?;
	let config = crate::config::Config::for_repo(&mission.cwd);
	let token = crate::integrations::github_token(&config).await?;
	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(20))
		.user_agent("cockpit")
		.build()
		.map_err(CockpitError::from)?;
	let api = |path: String| format!("https://api.github.com/repos/{repo}/{path}");
	let auth = format!("Bearer {token}");

	let pull: serde_json::Value = client
		.get(api(format!("pulls/{number}")))
		.header("Authorization", &auth)
		.header("Accept", "application/vnd.github+json")
		.send()
		.await
		.map_err(CockpitError::from)?
		.error_for_status()
		.map_err(CockpitError::from)?
		.json()
		.await
		.map_err(CockpitError::from)?;
	let body = pull.get("body").and_then(|b| b.as_str()).unwrap_or_default();
	let head = pull
		.pointer("/head/sha")
		.and_then(|s| s.as_str())
		.unwrap_or_default()
		.to_string();

	client
		.patch(api(format!("pulls/{number}")))
		.header("Authorization", &auth)
		.header("Accept", "application/vnd.github+json")
		.json(&serde_json::json!({ "body": with_section(body, &dossier.markdown) }))
		.send()
		.await
		.map_err(CockpitError::from)?
		.error_for_status()
		.map_err(CockpitError::from)?;

	if !head.is_empty() {
		let (state, description) = match dossier.overall {
			Overall::Success => ("success", t("status.success")),
			Overall::Pending => ("pending", t("status.pending")),
			Overall::Failure => ("failure", t("status.failure")),
		};
		// Un jeton sans `repo:status` échoue ici : le dossier est déjà dans la
		// description, on le dit sans annuler ce qui a réussi.
		if let Err(error) = client
			.post(api(format!("statuses/{head}")))
			.header("Authorization", &auth)
			.header("Accept", "application/vnd.github+json")
			.json(&serde_json::json!({
				"state": state,
				"context": CONTEXT,
				"description": description.chars().take(140).collect::<String>(),
				"target_url": mission.pr_url,
			}))
			.send()
			.await
			.and_then(|response| response.error_for_status())
		{
			crate::journal::record(
				"mission",
				&t("journal.statusFailed"),
				&mission.title,
				false,
				&error.to_string(),
			);
		}
	}
	crate::journal::record(
		"mission",
		&t("journal.published"),
		&mission.title,
		true,
		&mission.pr_url,
	);
	Ok(mission.pr_url.clone())
}

/// À la fermeture d'une mission sur sa PR : publie le dossier si le projet le
/// veut. En tâche de fond, jamais bloquant : un dossier qui ne part pas ne doit
/// pas empêcher la mission de se clore.
pub fn publish_on_close(mission_id: &str) {
	let Ok(mission) = mission::get(mission_id) else { return };
	if !crate::config::Config::for_repo(&mission.cwd).workflow.delivery_dossier
		|| github_pull(&mission.pr_url).is_none()
	{
		return;
	}
	let id = mission_id.to_string();
	tauri::async_runtime::spawn(async move {
		if let Err(error) = publish(&id).await {
			if let Ok(mission) = mission::get(&id) {
				crate::journal::record(
					"mission",
					&t("journal.publishFailed"),
					&mission.title,
					false,
					&error.to_string(),
				);
			}
		}
	});
}

#[cfg(test)]
mod tests {
	use super::*;

	fn gate(task: &str, gate: Gate) -> GateLine {
		GateLine {
			task: task.into(),
			gate,
		}
	}

	fn verdict(task: &str, verdict: &str, delivered: bool) -> VerdictLine {
		VerdictLine {
			task: task.into(),
			role: "qa".into(),
			verdict: verdict.into(),
			delivered,
		}
	}

	#[test]
	fn une_seule_porte_rouge_suffit() {
		let gates = [gate("a", Gate::Passed), gate("b", Gate::Failed)];
		assert_eq!(overall(&gates, &[verdict("qa", "ok", true)], None), Overall::Failure);
	}

	#[test]
	fn un_verdict_indecis_n_est_pas_un_accord() {
		let gates = [gate("a", Gate::Passed)];
		assert_eq!(
			overall(&gates, &[verdict("qa", "undecided", true)], None),
			Overall::Pending
		);
		assert_eq!(overall(&gates, &[verdict("qa", "", true)], None), Overall::Pending);
		assert_eq!(overall(&gates, &[verdict("qa", "ok", false)], None), Overall::Pending);
	}

	#[test]
	fn une_propriete_enfreinte_fait_echouer() {
		let props = PropertiesLine {
			total: 3,
			held: 2,
			broken: 1,
			..Default::default()
		};
		assert_eq!(overall(&[], &[], Some(&props)), Overall::Failure);
	}

	#[test]
	fn tout_tient_alors_c_est_un_succes() {
		let props = PropertiesLine {
			total: 2,
			held: 2,
			decorative: 1,
			..Default::default()
		};
		assert_eq!(
			overall(&[gate("a", Gate::Passed)], &[verdict("qa", "ok", true)], Some(&props)),
			Overall::Success
		);
	}

	#[test]
	fn la_section_se_remplace_sans_toucher_au_reste() {
		let premier = with_section("Ce que fait la PR.", "v1");
		assert!(premier.starts_with("Ce que fait la PR.\n\n"));
		let second = with_section(&format!("{premier}\n\nNote ajoutée à la main."), "v2");
		assert!(second.contains("v2") && !second.contains("v1"), "{second}");
		assert!(second.contains("Ce que fait la PR.") && second.contains("Note ajoutée à la main."));
		assert_eq!(second.matches(START).count(), 1);
		assert_eq!(with_section("", "seul"), format!("{START}\nseul\n{END}"));
	}

	#[test]
	fn l_adresse_d_une_pr_github_se_lit() {
		assert_eq!(github_pull("https://github.com/o/r/pull/42"), Some(("o/r".into(), 42)));
		assert_eq!(
			github_pull("https://github.com/o/r/pull/42#discussion"),
			Some(("o/r".into(), 42))
		);
		assert_eq!(github_pull("https://gitlab.com/o/r/-/merge_requests/1"), None);
		assert_eq!(github_pull(""), None);
	}

	#[test]
	fn git_shortstat_se_lit() {
		let changes = parse_shortstat(" 7 files changed, 120 insertions(+), 14 deletions(-)\n").unwrap();
		assert_eq!(
			changes,
			Changes {
				files: 7,
				insertions: 120,
				deletions: 14
			}
		);
		assert_eq!(
			parse_shortstat(" 1 file changed, 3 deletions(-)").unwrap().insertions,
			0
		);
		assert!(parse_shortstat("").is_none());
	}

	#[test]
	fn le_rendu_ne_maquille_rien() {
		let dossier = Dossier {
			mission_id: "m".into(),
			title: "t".into(),
			branch: "b".into(),
			gate_commands: vec!["pnpm test".into()],
			gates: vec![gate("Back", Gate::Failed)],
			verdicts: vec![verdict("Recette", "undecided", true)],
			properties: Some(PropertiesLine {
				total: 2,
				held: 2,
				decorative: 1,
				..Default::default()
			}),
			films: vec![],
			changes: None,
			cost: CostLine::default(),
			overall: Overall::Failure,
			markdown: String::new(),
		};
		let text = render(&dossier);
		assert!(text.contains("❌"), "porte en échec : {text}");
		assert!(
			!text
				.lines()
				.any(|line| line.starts_with("- ✅") && line.contains("Recette")),
			"{text}"
		);
		assert!(
			text.lines().any(|line| line.starts_with("- ⚠️")),
			"propriété décorative signalée : {text}"
		);
		// Une liste, pas des lignes nues : un simple retour à la ligne se fond
		// dans le paragraphe en markdown.
		assert!(
			text.lines()
				.filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with('*'))
				.all(|line| line.starts_with("- ")),
			"{text}"
		);
		assert!(!text.contains("<sub>"), "pas de HTML : l'interface ne le rend pas");
	}
}
