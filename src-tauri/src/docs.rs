//! Découverte des documents produits par les agents.
//!
//! Claude, Cursor et les slash-commands maison déposent leurs livrables au même
//! endroit : `.claude/work`, `.claude/reviews`, `docs/`, plus les markdown
//! laissés à la racine. On les remonte triés par fraîcheur, avec le worktree
//! d'origine, pour retrouver « ce que l'agent a écrit hier soir ».

use crate::error::Result;
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const SCAN_DIRS: &[(&str, &str)] = &[
	(".claude/work", "travail agent"),
	(".claude/reviews", "revue"),
	(".claude/worktrees", "worktree"),
	("docs", "wiki"),
	(".cursor/rules", "règle cursor"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
	pub path: String,
	pub relative: String,
	pub name: String,
	pub category: String,
	pub worktree: String,
	pub worktree_path: String,
	pub modified: i64,
	pub size: u64,
	pub preview: String,
	pub untracked: bool,
}

fn mtime(path: &Path) -> i64 {
	std::fs::metadata(path)
		.and_then(|m| m.modified())
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_secs() as i64)
		.unwrap_or(0)
}

fn preview_of(path: &Path) -> String {
	let Ok(raw) = std::fs::read_to_string(path) else {
		return String::new();
	};
	raw.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty() && !line.starts_with("---"))
		.take(4)
		.map(|line| line.trim_start_matches('#').trim())
		.collect::<Vec<_>>()
		.join(" · ")
		.chars()
		.take(220)
		.collect()
}

/// Scanne un worktree. `max_depth` reste faible : on cherche des livrables, pas
/// à indexer tout le monorepo.
pub fn scan_worktree(root: &Path, worktree_label: &str) -> Vec<DocEntry> {
	let mut entries = Vec::new();

	for (dir, category) in SCAN_DIRS {
		let base = root.join(dir);
		if !base.exists() {
			continue;
		}
		for entry in WalkDir::new(&base)
			.max_depth(4)
			.into_iter()
			.flatten()
			.filter(|e| e.file_type().is_file())
		{
			let path = entry.path();
			let is_doc = path
				.extension()
				.map(|ext| matches!(ext.to_string_lossy().as_ref(), "md" | "mdx" | "json" | "txt"))
				.unwrap_or(false);
			if !is_doc {
				continue;
			}
			let relative = path
				.strip_prefix(root)
				.unwrap_or(path)
				.to_string_lossy()
				.to_string();
			entries.push(DocEntry {
				path: path.to_string_lossy().to_string(),
				relative,
				name: path
					.file_name()
					.map(|n| n.to_string_lossy().to_string())
					.unwrap_or_default(),
				category: (*category).to_string(),
				worktree: worktree_label.to_string(),
				worktree_path: root.to_string_lossy().to_string(),
				modified: mtime(path),
				size: entry.metadata().map(|m| m.len()).unwrap_or(0),
				preview: preview_of(path),
				untracked: false,
			});
		}
	}

	// Markdown laissés à la racine : typiquement les rapports d'un agent.
	if let Ok(read) = std::fs::read_dir(root) {
		for entry in read.flatten() {
			let path = entry.path();
			if !path.is_file() {
				continue;
			}
			let is_md = path.extension().map(|e| e == "md").unwrap_or(false);
			let name = path
				.file_name()
				.map(|n| n.to_string_lossy().to_string())
				.unwrap_or_default();
			if !is_md || name == "README.md" {
				continue;
			}
			entries.push(DocEntry {
				path: path.to_string_lossy().to_string(),
				relative: name.clone(),
				name,
				category: "racine".into(),
				worktree: worktree_label.to_string(),
				worktree_path: root.to_string_lossy().to_string(),
				modified: mtime(&path),
				size: entry.metadata().map(|m| m.len()).unwrap_or(0),
				preview: preview_of(&path),
				untracked: true,
			});
		}
	}

	entries
}

pub fn scan_many(roots: Vec<(PathBuf, String)>, limit: usize) -> Result<Vec<DocEntry>> {
	let mut all: Vec<DocEntry> = roots
		.iter()
		.flat_map(|(root, label)| scan_worktree(root, label))
		.collect();
	all.sort_by_key(|a| std::cmp::Reverse(a.modified));
	all.truncate(limit);
	Ok(all)
}

pub fn read_doc(path: &Path) -> Result<String> {
	Ok(std::fs::read_to_string(path)?)
}
