//! Lecture des sessions d'agents Claude Code.
//!
//! Claude Code écrit un JSONL par session dans
//! `~/.claude/projects/<chemin-encodé>/<session-id>.jsonl`, plus un dossier
//! `<session-id>/subagents/` pour les sous-agents. On ne touche jamais à ces
//! fichiers : lecture seule, et on tolère les lignes inconnues (le format bouge
//! d'une version de Claude Code à l'autre).

use crate::error::{CockpitError, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Où le compte sous lequel on travaille range ses conversations.
pub fn projects_root() -> PathBuf {
	let config = crate::config::Config::active();
	crate::config::account_dir(&crate::config::account_for(&config)).join("projects")
}

/// Toutes les racines à lire, un compte déclaré par entrée.
///
/// Ce qui s'affiche des sessions ne dépend pas du projet ouvert : l'écran montre
/// ce qui tourne sur le poste, et un agent lancé sur le dépôt de l'employeur ne
/// doit pas disparaître de la liste parce qu'on regarde autre chose. Les
/// doublons sont écartés par `account_dirs` : deux comptes peuvent pointer le
/// même dossier, ce qui compterait chaque session deux fois.
///
/// **Le compte de l'isolation en fait partie.** Un agent en conteneur n'écrit
/// pas dans le `$HOME` du poste mais dans celui que `sandbox.rs` lui monte : ses
/// conversations existent, ailleurs. Tant que cette racine manquait ici, activer
/// l'isolation rendait le cockpit aveugle sur cinq fronts d'un coup — l'écran
/// des sessions, le verdict d'une vérification (`session_file` ne retrouvait
/// plus le fil), le ménage de `forget_project`, le contexte joint de `brief.rs`
/// et le décompte de jetons d'`usage.rs`. Aucun ne le disait : chacun se
/// contentait de ne rien trouver.
pub fn projects_roots() -> Vec<PathBuf> {
	let config = crate::config::Config::active();
	let mut roots: Vec<PathBuf> = crate::config::account_dirs(&config)
		.into_iter()
		.map(|dir| dir.join("projects"))
		.collect();
	let sandbox = crate::sandbox::sandbox_account_dir().join("projects");
	if !roots.contains(&sandbox) {
		roots.push(sandbox);
	}
	roots
}

/// Nom du dossier où Claude Code range les conversations d'un répertoire.
///
/// L'encodage est celui du CLI (lu dans son code, 2.1) : tout ce qui n'est pas
/// une lettre ou un chiffre ASCII devient un tiret — `/Users/moi/Sites/api`
/// donne `-Users-moi-Sites-api`, `C:\Users\moi\api` donne `C--Users-moi-api`.
/// Le CLI compte en unités UTF-16 : un caractère hors du plan de base en
/// donne deux. Au-delà de 200, il tronque et ajoute une empreinte du chemin
/// complet, pour que deux longs chemins voisins ne se confondent pas.
///
/// Remplacer seulement `/` et `.` — ce qu'on faisait — ratait tout dossier
/// dont le nom porte une espace ou un `_`, et tous les chemins Windows.
pub fn project_key(cwd: &str) -> String {
	const MAX: usize = 200;
	let cwd = normalized_cwd(cwd);
	let encoded: String = cwd
		.chars()
		.flat_map(|c| {
			let width = if c.is_ascii_alphanumeric() { 1 } else { c.len_utf16() };
			std::iter::repeat_n(if c.is_ascii_alphanumeric() { c } else { '-' }, width)
		})
		.collect();
	if encoded.len() <= MAX {
		return encoded;
	}
	// `Math.abs(hash).toString(36)` : l'empreinte de `String.hashCode` en Java,
	// sur les unités UTF-16 du chemin.
	let hash = cwd
		.encode_utf16()
		.fold(0i32, |hash, unit| hash.wrapping_mul(31).wrapping_add(unit as i32));
	format!("{}-{}", &encoded[..MAX], base36((hash as i64).unsigned_abs()))
}

/// Le dossier tel que le CLI le voit. Sous Windows, la lettre du lecteur en
/// majuscule — `process.cwd()` l'écrit ainsi, et `c:` comme `C:` désignent le
/// même dossier pour le système, pas pour l'encodage.
fn normalized_cwd(cwd: &str) -> String {
	let mut text = cwd.to_string();
	if cfg!(windows) && text.as_bytes().get(1) == Some(&b':') {
		text[..1].make_ascii_uppercase();
	}
	text
}

fn base36(mut value: u64) -> String {
	const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
	if value == 0 {
		return "0".into();
	}
	let mut out = Vec::new();
	while value > 0 {
		out.push(DIGITS[(value % 36) as usize]);
		value /= 36;
	}
	out.reverse();
	String::from_utf8(out).unwrap_or_default()
}

/// Oublie les conversations tenues dans un répertoire.
///
/// Un worktree supprimé laisse derrière lui ses transcripts, qui continuent de
/// peupler l'écran des sessions en désignant un dossier qui n'existe plus. Rend
/// vrai quand il y avait effectivement quelque chose à effacer.
///
/// Tous les comptes, et pas seulement celui d'aujourd'hui : un dossier a pu être
/// travaillé sous une identité puis sous une autre, et n'en effacer qu'une
/// laisserait la ligne à l'écran après qu'on a demandé de l'oublier.
pub fn forget_project(cwd: &str) -> bool {
	let key = project_key(cwd);
	let mut effacé = false;
	for root in projects_roots() {
		let dir = root.join(&key);
		if dir.is_dir() && std::fs::remove_dir_all(&dir).is_ok() {
			effacé = true;
		}
	}
	effacé
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
	pub input: u64,
	pub output: u64,
	pub cache_read: u64,
	pub cache_write: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
	pub id: String,
	pub file: String,
	/// Répertoire de travail réel, lu dans les entrées du JSONL.
	pub cwd: String,
	pub project_key: String,
	pub git_branch: Option<String>,
	pub title: String,
	pub last_prompt: Option<String>,
	pub started_at: Option<String>,
	pub updated_at: Option<String>,
	/// Secondes écoulées depuis la dernière écriture — sert à classer une
	/// session « en cours » vs « dormante ».
	pub idle_seconds: i64,
	pub user_messages: usize,
	pub assistant_messages: usize,
	pub tool_calls: usize,
	pub subagents: usize,
	pub models: Vec<String>,
	pub usage: TokenUsage,
	pub top_tools: Vec<ToolCount>,
	pub files_touched: Vec<String>,
	pub cli_version: Option<String>,
	pub has_error: bool,
	/// L'agent a rendu la main et attend une réponse : sa dernière écriture est
	/// un message sans appel d'outil derrière. C'est la différence entre « il
	/// travaille » et « il te bloque », qu'on ne voit sinon qu'en ouvrant le
	/// terminal.
	pub awaiting_input: bool,
	pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCount {
	pub name: String,
	pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
	pub index: usize,
	pub kind: String,
	pub timestamp: Option<String>,
	pub text: String,
	pub tool: Option<String>,
	pub detail: Option<String>,
	pub is_sidechain: bool,
	pub model: Option<String>,
	pub tokens: Option<u64>,
}

fn as_text(content: &Value) -> String {
	match content {
		Value::String(s) => s.clone(),
		Value::Array(items) => items
			.iter()
			.filter_map(|item| {
				if item.get("type")?.as_str()? == "text" {
					item.get("text")?.as_str().map(|s| s.to_string())
				} else {
					None
				}
			})
			.collect::<Vec<_>>()
			.join("\n"),
		_ => String::new(),
	}
}

/// Retire un bloc `<tag>…</tag>` et tout son contenu, autant de fois qu'il
/// apparaît.
///
/// Une balise ouvrante sans fermante — message coupé en cours d'écriture —
/// emporte la fin du texte : mieux vaut perdre une phrase tronquée que
/// d'afficher du XML à moitié fermé.
fn strip_block(text: &str, tag: &str) -> String {
	let open = format!("<{tag}");
	let close = format!("</{tag}>");
	let mut out = String::with_capacity(text.len());
	let mut rest = text;

	while let Some(start) = rest.find(&open) {
		out.push_str(&rest[..start]);
		let after = &rest[start..];
		match after.find(&close) {
			Some(end) => rest = &after[end + close.len()..],
			None => return out,
		}
	}
	out.push_str(rest);
	out
}

fn clean_prompt(raw: &str) -> String {
	// Le CLI glisse dans le fil des messages qui ne viennent de personne :
	// notifications de tâches de fond, rappels système, sorties de commandes
	// locales. Ils s'affichaient en XML brut au milieu de la conversation, sans
	// rien apprendre à qui la relit — on les retire avec leur contenu.
	let mut text = raw.to_string();
	for tag in [
		"task-notification",
		"system-reminder",
		"local-command-stdout",
		"local-command-stderr",
	] {
		text = strip_block(&text, tag);
	}

	// Ceux-là, en revanche, entourent une intention qu'on veut garder : la
	// commande tapée et ses arguments. Seules les balises tombent.
	for tag in ["command-message", "command-name", "command-args"] {
		text = text
			.replace(&format!("<{tag}>"), " ")
			.replace(&format!("</{tag}>"), " ");
	}
	text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(text: &str, max: usize) -> String {
	let trimmed = text.trim();
	if trimmed.chars().count() <= max {
		return trimmed.to_string();
	}
	let cut: String = trimmed.chars().take(max).collect();
	format!("{cut}…")
}

/// Résumé d'un `tool_use` en une ligne parlante (« Edit apps/web/…/page.tsx »).
fn describe_tool(name: &str, input: &Value) -> String {
	let get = |key: &str| input.get(key).and_then(|v| v.as_str()).unwrap_or("");
	match name {
		"Bash" => truncate(get("command"), 200),
		"Read" | "Write" | "NotebookEdit" => get("file_path").to_string(),
		"Edit" => format!("{} — {}", get("file_path"), truncate(get("old_string"), 60)),
		"Glob" | "Grep" => format!("{} {}", get("pattern"), get("path")).trim().to_string(),
		"Task" | "Agent" => format!("{} · {}", get("subagent_type"), truncate(get("description"), 80)),
		"WebFetch" | "WebSearch" => format!("{}{}", get("url"), get("query")),
		"TodoWrite" => crate::i18n::t("sessions.todoUpdate"),
		_ => truncate(&input.to_string(), 180),
	}
}

fn tool_file_path(name: &str, input: &Value) -> Option<String> {
	matches!(name, "Edit" | "Write" | "NotebookEdit")
		.then(|| input.get("file_path")?.as_str().map(|s| s.to_string()))
		.flatten()
}

struct Accumulator {
	summary: SessionSummary,
	tools: BTreeMap<String, usize>,
	files: BTreeMap<String, ()>,
	first_user_prompt: Option<String>,
}

fn new_accumulator(path: &Path, id: String, project_key: String) -> Accumulator {
	let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
	Accumulator {
		summary: SessionSummary {
			id,
			file: path.to_string_lossy().to_string(),
			cwd: String::new(),
			project_key,
			git_branch: None,
			title: String::new(),
			last_prompt: None,
			started_at: None,
			updated_at: None,
			idle_seconds: 0,
			user_messages: 0,
			assistant_messages: 0,
			tool_calls: 0,
			subagents: 0,
			models: Vec::new(),
			usage: TokenUsage::default(),
			top_tools: Vec::new(),
			files_touched: Vec::new(),
			cli_version: None,
			has_error: false,
			awaiting_input: false,
			size_bytes,
		},
		tools: BTreeMap::new(),
		files: BTreeMap::new(),
		first_user_prompt: None,
	}
}

fn ingest(acc: &mut Accumulator, entry: &Value) {
	let kind = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");

	if let Some(ts) = entry.get("timestamp").and_then(|v| v.as_str()) {
		if acc.summary.started_at.is_none() {
			acc.summary.started_at = Some(ts.to_string());
		}
		acc.summary.updated_at = Some(ts.to_string());
	}
	if acc.summary.cwd.is_empty() {
		if let Some(cwd) = entry.get("cwd").and_then(|v| v.as_str()) {
			// Sous Windows, le CLI écrit `C:\…` : l'interface attend des `/`.
			acc.summary.cwd = crate::platform::display_path(std::path::Path::new(cwd));
		}
	}
	if acc.summary.git_branch.is_none() {
		if let Some(branch) = entry.get("gitBranch").and_then(|v| v.as_str()) {
			if !branch.is_empty() {
				acc.summary.git_branch = Some(branch.to_string());
			}
		}
	}
	if acc.summary.cli_version.is_none() {
		if let Some(version) = entry.get("version").and_then(|v| v.as_str()) {
			acc.summary.cli_version = Some(version.to_string());
		}
	}

	let is_sidechain = entry
		.get("isSidechain")
		.and_then(|v| v.as_bool())
		.unwrap_or(false);

	match kind {
		"user" => {
			if is_sidechain {
				return;
			}
			// Retour d'outil ou réponse humaine : dans les deux cas la balle est
			// repassée à l'agent.
			acc.summary.awaiting_input = false;
			acc.summary.user_messages += 1;
			if acc.first_user_prompt.is_none() {
				if let Some(content) = entry.pointer("/message/content") {
					let text = clean_prompt(&as_text(content));
					if !text.is_empty() {
						acc.first_user_prompt = Some(text);
					}
				}
			}
		}
		"assistant" => {
			acc.summary.assistant_messages += 1;
			if let Some(model) = entry.pointer("/message/model").and_then(|v| v.as_str()) {
				if !acc.summary.models.iter().any(|m| m == model) {
					acc.summary.models.push(model.to_string());
				}
			}
			if let Some(usage) = entry.pointer("/message/usage") {
				let read = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
				acc.summary.usage.input += read("input_tokens");
				acc.summary.usage.output += read("output_tokens");
				acc.summary.usage.cache_read += read("cache_read_input_tokens");
				acc.summary.usage.cache_write += read("cache_creation_input_tokens");
			}
			// Chaque entrée écrase la précédente : à la fin du fichier, le
			// drapeau reflète donc bien la dernière chose qu'a faite l'agent.
			acc.summary.awaiting_input = !entry
				.pointer("/message/content")
				.and_then(|v| v.as_array())
				.is_some_and(|items| {
					items
						.iter()
						.any(|item| item.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
				});

			if let Some(items) = entry.pointer("/message/content").and_then(|v| v.as_array()) {
				for item in items {
					if item.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
						let name = item
							.get("name")
							.and_then(|v| v.as_str())
							.unwrap_or("tool")
							.to_string();
						acc.summary.tool_calls += 1;
						if matches!(name.as_str(), "Task" | "Agent") {
							acc.summary.subagents += 1;
						}
						if let Some(input) = item.get("input") {
							if let Some(file) = tool_file_path(&name, input) {
								acc.files.insert(file, ());
							}
						}
						*acc.tools.entry(name).or_insert(0) += 1;
					}
				}
			}
		}
		"last-prompt" => {
			if let Some(prompt) = entry.get("lastPrompt").and_then(|v| v.as_str()) {
				acc.summary.last_prompt = Some(clean_prompt(prompt));
			}
		}
		"summary" => {
			if let Some(summary) = entry.get("summary").and_then(|v| v.as_str()) {
				acc.summary.title = summary.to_string();
			}
		}
		_ => {}
	}

	if entry.get("isApiErrorMessage").and_then(|v| v.as_bool()) == Some(true) {
		acc.summary.has_error = true;
	}
}

fn finalize(mut acc: Accumulator) -> SessionSummary {
	if acc.summary.title.is_empty() {
		acc.summary.title = acc
			.first_user_prompt
			.clone()
			.map(|p| truncate(&p, 110))
			.unwrap_or_else(|| crate::i18n::t("sessions.noPrompt"));
	}
	if acc.summary.last_prompt.is_none() {
		acc.summary.last_prompt = acc.first_user_prompt.clone();
	}

	let mut tools: Vec<ToolCount> = acc
		.tools
		.into_iter()
		.map(|(name, count)| ToolCount { name, count })
		.collect();
	tools.sort_by_key(|a| std::cmp::Reverse(a.count));
	tools.truncate(8);
	acc.summary.top_tools = tools;

	acc.summary.files_touched = acc.files.into_keys().take(200).collect();

	// Nombre de sous-agents réel : le dossier `subagents/` fait foi quand il
	// existe, les `tool_use` Task n'étant qu'une approximation.
	let session_dir = PathBuf::from(&acc.summary.file).with_extension("");
	let subagent_dir = session_dir.join("subagents");
	if let Ok(entries) = std::fs::read_dir(&subagent_dir) {
		let count = entries
			.flatten()
			.filter(|e| {
				e.path()
					.extension()
					.map(|ext| ext == "jsonl")
					.unwrap_or(false)
			})
			.count();
		if count > 0 {
			acc.summary.subagents = count;
		}
	}

	let mtime = std::fs::metadata(&acc.summary.file)
		.and_then(|m| m.modified())
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_secs() as i64)
		.unwrap_or(0);
	let now = chrono::Utc::now().timestamp();
	acc.summary.idle_seconds = (now - mtime).max(0);

	acc.summary
}

pub fn read_session(path: &Path, project_key: &str) -> Result<SessionSummary> {
	let file = std::fs::File::open(path)?;
	let reader = BufReader::with_capacity(256 * 1024, file);
	let id = path
		.file_stem()
		.map(|s| s.to_string_lossy().to_string())
		.unwrap_or_default();
	let mut acc = new_accumulator(path, id, project_key.to_string());

	for line in reader.lines() {
		let Ok(line) = line else { continue };
		if line.trim().is_empty() {
			continue;
		}
		let Ok(entry) = serde_json::from_str::<Value>(&line) else {
			continue;
		};
		ingest(&mut acc, &entry);
	}

	Ok(finalize(acc))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessions {
	pub key: String,
	pub cwd: String,
	pub sessions: Vec<SessionSummary>,
}

/// Cache des résumés, indexé par (mtime, taille).
///
/// Sans lui, chaque écriture d'un agent actif ferait re-parser l'intégralité
/// des journaux de tous les projets — plusieurs dizaines de Mo de JSON toutes
/// les deux secondes. Un fichier ne change jamais sans que sa taille ou sa date
/// bouge, donc l'invalidation est exacte.
struct CacheEntry {
	mtime: i64,
	size: u64,
	summary: SessionSummary,
}

fn cache() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, CacheEntry>> {
	static CACHE: std::sync::OnceLock<
		std::sync::Mutex<std::collections::HashMap<PathBuf, CacheEntry>>,
	> = std::sync::OnceLock::new();
	CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn file_stamp(path: &Path) -> (i64, u64) {
	let Ok(meta) = std::fs::metadata(path) else {
		return (0, 0);
	};
	let mtime = meta
		.modified()
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_secs() as i64)
		.unwrap_or(0);
	(mtime, meta.len())
}

fn summary_cached(path: &Path, project_key: &str) -> Result<SessionSummary> {
	let (mtime, size) = file_stamp(path);

	if let Ok(store) = cache().lock() {
		if let Some(entry) = store.get(path) {
			if entry.mtime == mtime && entry.size == size {
				let mut summary = entry.summary.clone();
				// Seule donnée relative au moment présent : à recalculer.
				summary.idle_seconds = (chrono::Utc::now().timestamp() - mtime).max(0);
				return Ok(summary);
			}
		}
	}

	let summary = read_session(path, project_key)?;
	if let Ok(mut store) = cache().lock() {
		store.insert(
			path.to_path_buf(),
			CacheEntry {
				mtime,
				size,
				summary: summary.clone(),
			},
		);
	}
	Ok(summary)
}

/// Balaie les `projects/` de chaque compte, un dossier = un cwd. Les sessions
/// sont triées de la plus fraîche à la plus ancienne, et `limit_per_project`
/// borne le coût de parsing sur les projets à très long historique.
///
/// Un même répertoire peut avoir été travaillé sous deux comptes : ses fichiers
/// sont alors réunis sous une seule entrée, parce que c'est le dossier qu'on
/// reconnaît à l'écran, pas l'identité qui l'a ouvert. La limite s'applique
/// après cette réunion, sinon deux comptes doubleraient discrètement le plafond.
pub fn scan_all(limit_per_project: usize) -> Result<Vec<ProjectSessions>> {
	// Clé de dossier → fichiers de session, tous comptes confondus.
	let mut par_projet: BTreeMap<String, Vec<(PathBuf, i64)>> = BTreeMap::new();

	for root in projects_roots() {
		if !root.exists() {
			continue;
		}
		for entry in std::fs::read_dir(&root)? {
			let Ok(entry) = entry else { continue };
			let dir = entry.path();
			if !dir.is_dir() {
				continue;
			}
			let key = dir
				.file_name()
				.map(|n| n.to_string_lossy().to_string())
				.unwrap_or_default();

			let files = par_projet.entry(key).or_default();
			for path in std::fs::read_dir(&dir)?
				.flatten()
				.map(|e| e.path())
				.filter(|p| p.extension().map(|ext| ext == "jsonl").unwrap_or(false))
			{
				let mtime = std::fs::metadata(&path)
					.and_then(|m| m.modified())
					.ok()
					.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
					.map(|d| d.as_secs() as i64)
					.unwrap_or(0);
				files.push((path, mtime));
			}
		}
	}

	let mut projects = Vec::new();
	for (key, mut files) in par_projet {
		files.sort_by_key(|a| std::cmp::Reverse(a.1));
		files.truncate(limit_per_project);

		let sessions: Vec<SessionSummary> = files
			.into_iter()
			.filter_map(|(path, _)| summary_cached(&path, &key).ok())
			.filter(|s| s.user_messages > 0 || s.assistant_messages > 0)
			.collect();

		if sessions.is_empty() {
			continue;
		}

		let cwd = sessions
			.iter()
			.find(|s| !s.cwd.is_empty())
			.map(|s| s.cwd.clone())
			.unwrap_or_else(|| key.replace('-', "/"));

		projects.push(ProjectSessions { key, cwd, sessions });
	}

	projects.sort_by_key(|p| {
		std::cmp::Reverse(
			p.sessions
				.iter()
				.map(|s| -s.idle_seconds)
				.max()
				.unwrap_or(i64::MIN),
		)
	});

	Ok(projects)
}

/// Timeline complète d'une session : c'est la vue « reprendre le fil » quand tu
/// reviens sur un worktree laissé en plan.
pub fn read_timeline(file: &Path, max_events: usize) -> Result<Vec<SessionEvent>> {
	if !file.exists() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"sessions.notFound",
			&[("path", &file.display())],
		)));
	}

	// On ne veut que la fin du fil, et un transcript grossit sans limite : le
	// relire en entier pour n'en garder que les derniers messages coûtait
	// plusieurs mégaoctets de JSON reparsés toutes les quatre secondes, par
	// agent affiché. On part donc de la fin, et on ne remonte que si la fenêtre
	// n'a pas suffi.
	let taille = std::fs::metadata(file)?.len();
	let mut fenetre = ((max_events as u64).saturating_mul(4 * 1024)).clamp(64 * 1024, 16 * 1024 * 1024);

	loop {
		let depuis = taille.saturating_sub(fenetre);
		let events = read_timeline_from(file, depuis, max_events)?;
		// Assez d'événements, ou déjà tout le fichier : on a fini.
		if events.len() >= max_events || depuis == 0 {
			return Ok(events);
		}
		fenetre = fenetre.saturating_mul(4);
	}
}

/// Lit le fil à partir d'un décalage, en jetant la ligne coupée du début.
fn read_timeline_from(file: &Path, depuis: u64, max_events: usize) -> Result<Vec<SessionEvent>> {
	use std::io::Seek;

	let mut handle = std::fs::File::open(file)?;
	if depuis > 0 {
		handle.seek(std::io::SeekFrom::Start(depuis))?;
	}
	let mut reader = BufReader::with_capacity(256 * 1024, handle);
	// Le décalage tombe au milieu d'une ligne : celle-là n'est pas du JSON
	// valide, on la laisse au tour précédent.
	if depuis > 0 {
		let mut coupee = String::new();
		let _ = reader.read_line(&mut coupee);
	}

	let mut events: Vec<SessionEvent> = Vec::new();

	for line in reader.lines() {
		let Ok(line) = line else { continue };
		if line.trim().is_empty() {
			continue;
		}
		let Ok(entry) = serde_json::from_str::<Value>(&line) else {
			continue;
		};
		let kind = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
		let timestamp = entry
			.get("timestamp")
			.and_then(|v| v.as_str())
			.map(|s| s.to_string());
		let is_sidechain = entry
			.get("isSidechain")
			.and_then(|v| v.as_bool())
			.unwrap_or(false);
		let index = events.len();

		match kind {
			"user" => {
				let Some(content) = entry.pointer("/message/content") else {
					continue;
				};
				// Un « user » porteur de tool_result est en réalité le retour
				// d'un outil : on l'affiche comme tel.
				if let Some(items) = content.as_array() {
					let results: Vec<&Value> = items
						.iter()
						.filter(|i| i.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
						.collect();
					if !results.is_empty() {
						for result in results {
							let body = result
								.get("content")
								.map(as_text)
								.unwrap_or_default();
							let is_error = result.get("is_error").and_then(|v| v.as_bool())
								== Some(true);
							events.push(SessionEvent {
								index: events.len(),
								kind: if is_error { "tool-error" } else { "tool-result" }
									.into(),
								timestamp: timestamp.clone(),
								text: truncate(&body, 1600),
								tool: None,
								detail: None,
								is_sidechain,
								model: None,
								tokens: None,
							});
						}
						continue;
					}
				}
				let text = clean_prompt(&as_text(content));
				if text.is_empty() {
					continue;
				}
				events.push(SessionEvent {
					index,
					kind: "user".into(),
					timestamp,
					text,
					tool: None,
					detail: None,
					is_sidechain,
					model: None,
					tokens: None,
				});
			}
			"assistant" => {
				let model = entry
					.pointer("/message/model")
					.and_then(|v| v.as_str())
					.map(|s| s.to_string());
				let tokens = entry
					.pointer("/message/usage/output_tokens")
					.and_then(|v| v.as_u64());
				let Some(items) = entry.pointer("/message/content").and_then(|v| v.as_array())
				else {
					continue;
				};
				for item in items {
					match item.get("type").and_then(|v| v.as_str()) {
						Some("text") => {
							let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
							if text.trim().is_empty() {
								continue;
							}
							events.push(SessionEvent {
								index: events.len(),
								kind: "assistant".into(),
								timestamp: timestamp.clone(),
								text: text.to_string(),
								tool: None,
								detail: None,
								is_sidechain,
								model: model.clone(),
								tokens,
							});
						}
						Some("thinking") => {
							let text = item
								.get("thinking")
								.and_then(|v| v.as_str())
								.unwrap_or("");
							if text.trim().is_empty() {
								continue;
							}
							events.push(SessionEvent {
								index: events.len(),
								kind: "thinking".into(),
								timestamp: timestamp.clone(),
								text: truncate(text, 4000),
								tool: None,
								detail: None,
								is_sidechain,
								model: model.clone(),
								tokens: None,
							});
						}
						Some("tool_use") => {
							let name = item
								.get("name")
								.and_then(|v| v.as_str())
								.unwrap_or("tool")
								.to_string();
							let empty = Value::Object(Default::default());
							let input = item.get("input").unwrap_or(&empty);
							events.push(SessionEvent {
								index: events.len(),
								kind: "tool".into(),
								timestamp: timestamp.clone(),
								text: describe_tool(&name, input),
								tool: Some(name),
								detail: Some(truncate(
									&serde_json::to_string_pretty(input).unwrap_or_default(),
									4000,
								)),
								is_sidechain,
								model: model.clone(),
								tokens: None,
							});
						}
						_ => {}
					}
				}
			}
			_ => {}
		}
	}

	// On garde la fin de la conversation : c'est là qu'est l'état courant.
	if events.len() > max_events {
		events = events.split_off(events.len() - max_events);
		for (position, event) in events.iter_mut().enumerate() {
			event.index = position;
		}
	}

	Ok(events)
}

/// Traduit un message du flux vers le relevé du cockpit (`executions.rs`).
///
/// Prend la forme de Claude Code, celle que les autres protocoles atteignent
/// avant d'être émis — voir `executions::from_claude_shaped`, qui dit pourquoi
/// il n'y a qu'un traducteur.
///
/// Écrit ici et pas ailleurs : cette forme y est déjà décodée, et `as_text`,
/// `truncate`, `describe_tool` et `clean_prompt` s'y réutilisent au lieu d'être
/// recopiés une fois de plus. Un message qui n'a rien de retenable rend une
/// liste vide — jamais une erreur.
pub fn to_cockpit(payload: &Value) -> Vec<crate::executions::ExecEvent> {
	use crate::executions::ExecEvent;

	let mut out = Vec::new();
	match payload.get("type").and_then(|v| v.as_str()).unwrap_or("") {
		"user" => {
			let Some(content) = payload.pointer("/message/content") else {
				return out;
			};
			// Un « user » porteur de `tool_result` est en réalité le retour d'un
			// outil : même lecture que la timeline, pour que les deux racontent
			// la même histoire.
			if let Some(items) = content.as_array() {
				for result in items
					.iter()
					.filter(|i| i.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
				{
					let body = result.get("content").map(as_text).unwrap_or_default();
					out.push(ExecEvent::ToolDone {
						id: result
							.get("tool_use_id")
							.and_then(|v| v.as_str())
							.unwrap_or_default()
							.to_string(),
						ok: result.get("is_error").and_then(|v| v.as_bool()) != Some(true),
						bytes: body.len() as u64,
						excerpt: crate::executions::clip_excerpt(&body),
					});
				}
				if !out.is_empty() {
					return out;
				}
			}
			let text = clean_prompt(&as_text(content));
			if !text.is_empty() {
				out.push(ExecEvent::Prompt {
					text: crate::executions::clip_text(&text),
				});
			}
		}
		"assistant" => {
			let Some(items) = payload.pointer("/message/content").and_then(|v| v.as_array())
			else {
				return out;
			};
			for item in items {
				match item.get("type").and_then(|v| v.as_str()) {
					Some("text") => {
						let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
						if !text.trim().is_empty() {
							out.push(ExecEvent::Say {
								text: crate::executions::clip_text(text),
							});
						}
					}
					Some("thinking") => {
						let text = item.get("thinking").and_then(|v| v.as_str()).unwrap_or("");
						if !text.trim().is_empty() {
							out.push(ExecEvent::Think {
								text: crate::executions::clip_text(text),
							});
						}
					}
					Some("tool_use") => {
						let name = item
							.get("name")
							.and_then(|v| v.as_str())
							.unwrap_or("tool")
							.to_string();
						let empty = Value::Object(Default::default());
						let input = item.get("input").unwrap_or(&empty);
						out.push(ExecEvent::Tool {
							id: item
								.get("id")
								.and_then(|v| v.as_str())
								.unwrap_or_default()
								.to_string(),
							hint: describe_tool(&name, input),
							name,
							input: crate::executions::clip_input(
								&serde_json::to_string(input).unwrap_or_default(),
							),
						});
					}
					_ => {}
				}
			}
		}
		"result" => {
			out.push(ExecEvent::TurnEnd {
				ok: payload.get("is_error").and_then(|v| v.as_bool()) != Some(true),
				text: crate::executions::clip_text(
					payload.get("result").and_then(|v| v.as_str()).unwrap_or(""),
				),
			});
		}
		// `system` (l'initialisation) et `cockpit` (nos propres messages à
		// l'écran) ne racontent rien qu'on veuille relire six semaines plus
		// tard : l'un décrit un démarrage que `Opening` porte déjà, l'autre est
		// un artefact d'affichage.
		_ => {}
	}
	out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRun {
	pub id: String,
	pub file: String,
	pub name: String,
	pub description: String,
	pub status: String,
	pub updated_at: Option<String>,
}

/// Sous-agents d'une session : chaque `agent-*.meta.json` décrit un run lancé
/// par l'agent principal.
pub fn read_subagents(session_file: &Path) -> Result<Vec<SubagentRun>> {
	let dir = session_file.with_extension("").join("subagents");
	if !dir.exists() {
		return Ok(Vec::new());
	}

	let mut runs = Vec::new();
	for entry in std::fs::read_dir(&dir)?.flatten() {
		let path = entry.path();
		if !path.to_string_lossy().ends_with(".meta.json") {
			continue;
		}
		let Ok(raw) = std::fs::read_to_string(&path) else {
			continue;
		};
		let Ok(meta) = serde_json::from_str::<Value>(&raw) else {
			continue;
		};
		let get = |key: &str| {
			meta.get(key)
				.and_then(|v| v.as_str())
				.unwrap_or_default()
				.to_string()
		};
		let jsonl = path.to_string_lossy().replace(".meta.json", ".jsonl");
		runs.push(SubagentRun {
			id: path
				.file_stem()
				.map(|s| s.to_string_lossy().replace(".meta", ""))
				.unwrap_or_default(),
			file: jsonl,
			name: {
				let value = get("agentType");
				if value.is_empty() {
					get("subagentType")
				} else {
					value
				}
			},
			description: {
				let value = get("description");
				if value.is_empty() {
					get("prompt")
				} else {
					value
				}
			},
			status: {
				let value = get("status");
				if value.is_empty() {
					crate::i18n::t("sessions.unknownStatus")
				} else {
					value
				}
			},
			updated_at: meta
				.get("updatedAt")
				.or_else(|| meta.get("timestamp"))
				.and_then(|v| v.as_str())
				.map(|s| s.to_string()),
		});
	}

	runs.sort_by(|a, b| a.name.cmp(&b.name));
	Ok(runs)
}

#[cfg(test)]
mod tests {
	#[test]
	fn le_dossier_des_conversations_s_encode_comme_le_cli() {
		// Valeurs relevées en rejouant l'encodage du CLI (`replace(/[^a-zA-Z0-9]/g, "-")`).
		assert_eq!(super::project_key("/Users/moi/Sites/api"), "-Users-moi-Sites-api");
		assert_eq!(super::project_key("/Users/moi/mon projet_v2.1"), "-Users-moi-mon-projet-v2-1");
		assert_eq!(super::project_key(r"C:\Users\me\proj"), "C--Users-me-proj");
		assert_eq!(super::project_key("C:/Users/me/proj"), "C--Users-me-proj");
		// Un caractère hors du plan de base compte deux unités UTF-16.
		assert_eq!(super::project_key("/Users/moi/été/🚀x"), "-Users-moi--t----x");
	}

	#[test]
	fn un_long_chemin_est_tronque_et_signe_comme_le_cli() {
		let long = format!("/Users/moi/{}fin", "dossier-tres-long/".repeat(12));
		let key = super::project_key(&long);
		assert!(key.ends_with("-dossier-t-5cp5p9"), "{key}");
		assert_eq!(key.len(), 200 + 1 + "5cp5p9".len());
		// Une empreinte négative : le CLI en prend la valeur absolue.
		assert!(super::project_key(&format!("{long}/v0")).ends_with("-ql2s4"));
	}

	#[test]
	fn sous_windows_la_lettre_du_lecteur_ne_change_pas_le_dossier() {
		if cfg!(windows) {
			assert_eq!(super::project_key(r"c:\Users\me\proj"), "C--Users-me-proj");
		}
	}
	use super::*;
	use crate::executions::ExecEvent;

	// ── Les racines à lire ──

	#[test]
	fn le_compte_de_lisolation_est_balayé_comme_les_autres() {
		// Un agent en conteneur écrit ses conversations dans le `$HOME` que
		// `sandbox.rs` lui monte. Oublier cette racine ne provoquait aucune
		// erreur : le verdict d'une vérification, l'écran des sessions, le
		// ménage des worktrees, le contexte joint et le décompte de jetons se
		// contentaient de ne rien trouver.
		let racines = projects_roots();
		let sandbox = crate::sandbox::sandbox_account_dir().join("projects");
		assert!(
			racines.contains(&sandbox),
			"le compte de l'isolation manque parmi {racines:?}"
		);
	}

	#[test]
	fn aucune_racine_nest_lue_deux_fois() {
		// Deux comptes peuvent pointer le même dossier, et compter chaque
		// session deux fois fausserait la consommation de jetons.
		let mut racines = projects_roots();
		let total = racines.len();
		racines.sort();
		racines.dedup();
		assert_eq!(racines.len(), total);
	}

	// ── La traduction vers le relevé ──

	#[test]
	fn une_phrase_de_l_agent_devient_un_dire() {
		let payload = serde_json::json!({
			"type": "assistant",
			"message": { "content": [{ "type": "text", "text": "J'ai corrigé le sélecteur." }] }
		});
		assert_eq!(
			to_cockpit(&payload),
			vec![ExecEvent::Say {
				text: "J'ai corrigé le sélecteur.".into()
			}]
		);
	}

	#[test]
	fn un_appel_d_outil_garde_son_identifiant_pour_qu_on_y_rattache_sa_sortie() {
		let payload = serde_json::json!({
			"type": "assistant",
			"message": { "content": [{
				"type": "tool_use",
				"id": "toolu_1",
				"name": "Edit",
				"input": { "file_path": "src/a.ts", "old_string": "avant" }
			}] }
		});
		let events = to_cockpit(&payload);
		let ExecEvent::Tool { id, name, hint, .. } = &events[0] else {
			panic!("attendu un appel d'outil, reçu {:?}", events[0]);
		};
		assert_eq!(id, "toolu_1");
		assert_eq!(name, "Edit");
		// La même ligne parlante que la timeline : les deux racontent pareil.
		assert!(hint.contains("src/a.ts"));
	}

	#[test]
	fn une_sortie_d_outil_dit_sa_taille_reelle_et_non_celle_de_son_extrait() {
		let gros = "x".repeat(50_000);
		let payload = serde_json::json!({
			"type": "user",
			"message": { "content": [{
				"type": "tool_result",
				"tool_use_id": "toolu_1",
				"content": gros,
			}] }
		});
		let events = to_cockpit(&payload);
		let ExecEvent::ToolDone { id, ok, bytes, excerpt } = &events[0] else {
			panic!("attendu une sortie d'outil, reçu {:?}", events[0]);
		};
		assert_eq!(id, "toolu_1");
		assert!(ok);
		assert_eq!(*bytes, 50_000);
		assert!(excerpt.chars().count() < 2_100, "l'extrait doit être borné");
		assert!(excerpt.ends_with('…'), "une sortie coupée doit le dire");
	}

	#[test]
	fn une_sortie_en_erreur_se_distingue() {
		let payload = serde_json::json!({
			"type": "user",
			"message": { "content": [{
				"type": "tool_result",
				"tool_use_id": "toolu_2",
				"content": "command not found",
				"is_error": true,
			}] }
		});
		let ExecEvent::ToolDone { ok, .. } = &to_cockpit(&payload)[0] else {
			panic!("attendu une sortie d'outil");
		};
		assert!(!ok);
	}

	#[test]
	fn la_consigne_arrive_debarrassee_de_ce_que_le_cli_y_glisse() {
		let payload = serde_json::json!({
			"type": "user",
			"message": { "content": "Corrige <system-reminder>bruit</system-reminder> le bouton" }
		});
		assert_eq!(
			to_cockpit(&payload),
			vec![ExecEvent::Prompt {
				text: "Corrige le bouton".into()
			}]
		);
	}

	#[test]
	fn la_fin_d_un_tour_porte_son_verdict() {
		let ok = serde_json::json!({ "type": "result", "result": "terminé" });
		assert_eq!(
			to_cockpit(&ok),
			vec![ExecEvent::TurnEnd {
				ok: true,
				text: "terminé".into()
			}]
		);
		let rate = serde_json::json!({ "type": "result", "is_error": true, "result": "échec" });
		let ExecEvent::TurnEnd { ok, .. } = &to_cockpit(&rate)[0] else {
			panic!("attendu une fin de tour");
		};
		assert!(!ok);
	}

	#[test]
	fn ce_qui_ne_raconte_rien_ne_produit_rien() {
		// L'initialisation décrit un démarrage que `Opening` porte déjà, et
		// `cockpit` est un artefact d'affichage : ni l'un ni l'autre n'a de
		// raison de vivre six semaines dans un relevé.
		for payload in [
			serde_json::json!({ "type": "system", "subtype": "init", "model": "opus" }),
			serde_json::json!({ "type": "cockpit", "subtype": "ended" }),
			serde_json::json!({ "type": "assistant", "message": { "content": [] } }),
			serde_json::json!({ "type": "assistant" }),
			serde_json::json!({}),
		] {
			assert!(
				to_cockpit(&payload).is_empty(),
				"rien ne devait sortir de {payload}"
			);
		}
	}

	#[test]
	fn un_texte_vide_ne_fait_pas_une_ligne_de_relevé() {
		let payload = serde_json::json!({
			"type": "assistant",
			"message": { "content": [{ "type": "text", "text": "   " }] }
		});
		assert!(to_cockpit(&payload).is_empty());
	}

	#[test]
	fn un_evenement_codex_traverse_jusqu_au_releve() {
		// La chaîne complète, celle qui donne enfin un historique à Codex :
		// événement natif → forme de Claude → relevé du cockpit.
		let natif = serde_json::json!({
			"type": "item.completed",
			"item": { "type": "agent_message", "text": "Voilà ce que j'ai fait." }
		});
		let shaped = crate::codex::to_claude_shaped(&natif).expect("traduction Codex");
		assert_eq!(
			to_cockpit(&shaped),
			vec![ExecEvent::Say {
				text: "Voilà ce que j'ai fait.".into()
			}]
		);
	}

	#[test]
	fn ce_que_codex_n_annonce_pas_n_entre_pas_dans_le_releve() {
		// `to_claude_shaped` écarte ce qui n'a pas de champ vérifié ; le relevé
		// ne doit surtout pas rattraper ce qu'elle a écarté. Un historique
		// Codex incomplet est assumé — un historique inventé ne le serait pas.
		let natif = serde_json::json!({
			"type": "item.completed",
			"item": { "type": "reasoning", "text": "je réfléchis" }
		});
		assert!(crate::codex::to_claude_shaped(&natif).is_none());
	}

	/// Ce que le CLI injecte dans le fil ne doit jamais s'afficher tel quel.
	#[test]
	fn nettoyage_des_blocs_techniques() {
		let raw = "Avant <task-notification><task-id>abc</task-id></task-notification> après";
		assert_eq!(clean_prompt(raw), "Avant après");

		// Deux blocs, et un rappel système au milieu.
		let raw = "<system-reminder>bruit</system-reminder>Fais ceci\
			<task-notification>x</task-notification>";
		assert_eq!(clean_prompt(raw), "Fais ceci");

		// Message coupé en cours d'écriture : on ne laisse pas la balise ouverte.
		assert_eq!(clean_prompt("Texte <task-notification>début…"), "Texte");

		// Un message ordinaire traverse sans dommage.
		assert_eq!(clean_prompt("  Corrige   la CI  "), "Corrige la CI");

		// La commande tapée reste lisible : seules ses balises tombent.
		assert_eq!(
			clean_prompt("<command-name>/review</command-name><command-args>42</command-args>"),
			"/review 42"
		);
	}
}
