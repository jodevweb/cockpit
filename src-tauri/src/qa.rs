//! Livrables de self-QA d'un worktree.
//!
//! Les agents déposent leurs captures et leurs comptes rendus dans
//! `.claude/work` — souvent rangés par ticket. Jusqu'ici il fallait ouvrir le
//! Finder pour les regarder, worktree par worktree : ce module les recense pour
//! que le cockpit les montre là où on regarde déjà le travail en cours.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Dossiers où chercher, relatifs au worktree.
///
/// Liste fermée plutôt que parcours du dépôt entier : on veut les livrables de
/// QA, pas les images du produit.
const ROOTS: [&str; 5] = [".claude/work", ".claude/qa", "qa", "docs/qa", "self-qa"];

/// Profondeur maximale sous une racine — `.claude/work/qa/NW-1234/final` en
/// consomme déjà quatre.
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QaFile {
	pub path: String,
	pub name: String,
	/// Chemin relatif au worktree — c'est ce qu'on affiche.
	pub relative: String,
	/// Dossier parent relatif, qui sert de titre de groupe.
	pub group: String,
	/// `image` · `video` · `markdown` · `text` · `other` : décide du rendu.
	pub kind: String,
	pub size: u64,
	/// Dernière modification, en secondes epoch.
	pub modified: Option<u64>,
}

fn kind_of(extension: &str) -> &'static str {
	match extension {
		"png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "bmp" => "image",
		"mp4" | "mov" | "webm" | "m4v" => "video",
		"md" | "markdown" => "markdown",
		"txt" | "json" | "log" | "csv" | "yml" | "yaml" | "diff" | "patch" => "text",
		_ => "other",
	}
}

/// Fichiers sans intérêt à l'écran : métadonnées du système ou marqueurs vides.
fn ignored(name: &str) -> bool {
	name.starts_with('.') || name == "Thumbs.db"
}

fn walk(root: &Path, base: &Path, depth: usize, out: &mut Vec<QaFile>, limit: usize) {
	if depth > MAX_DEPTH || out.len() >= limit {
		return;
	}
	let Ok(entries) = std::fs::read_dir(root) else {
		return;
	};

	// Un ordre stable rend le carousel prévisible : les captures sont numérotées
	// (`01-…`, `02-…`), l'ordre alphabétique est donc l'ordre de lecture.
	let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
	paths.sort();

	for path in paths {
		if out.len() >= limit {
			return;
		}
		let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
			continue;
		};
		if ignored(&name) {
			continue;
		}

		if path.is_dir() {
			walk(&path, base, depth + 1, out, limit);
			continue;
		}

		let extension = path
			.extension()
			.map(|e| e.to_string_lossy().to_lowercase())
			.unwrap_or_default();
		let kind = kind_of(&extension);
		if kind == "other" {
			continue;
		}

		let metadata = std::fs::metadata(&path).ok();
		let relative = path
			.strip_prefix(base)
			.unwrap_or(&path)
			.to_string_lossy()
			.to_string();
		let group = PathBuf::from(&relative)
			.parent()
			.map(|parent| parent.to_string_lossy().to_string())
			.unwrap_or_default();

		out.push(QaFile {
			path: path.to_string_lossy().to_string(),
			name,
			relative,
			group,
			kind: kind.to_string(),
			size: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
			modified: metadata
				.and_then(|m| m.modified().ok())
				.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
				.map(|d| d.as_secs()),
		});
	}
}

/// Encodage base64 standard, sans dépendance.
///
/// Une capture d'écran pèse quelques centaines de kilooctets : la table tient
/// en trois lignes, une crate de plus ne se justifie pas.
fn base64(bytes: &[u8]) -> String {
	const ALPHABET: &[u8; 64] =
		b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for chunk in bytes.chunks(3) {
		let b = [
			chunk[0],
			*chunk.get(1).unwrap_or(&0),
			*chunk.get(2).unwrap_or(&0),
		];
		let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
		out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
		out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
		out.push(if chunk.len() > 1 {
			ALPHABET[(n >> 6 & 63) as usize] as char
		} else {
			'='
		});
		out.push(if chunk.len() > 2 {
			ALPHABET[(n & 63) as usize] as char
		} else {
			'='
		});
	}
	out
}

fn mime_of(extension: &str) -> &'static str {
	match extension {
		"png" => "image/png",
		"jpg" | "jpeg" => "image/jpeg",
		"gif" => "image/gif",
		"webp" => "image/webp",
		"avif" => "image/avif",
		"svg" => "image/svg+xml",
		"bmp" => "image/bmp",
		"mp4" | "m4v" => "video/mp4",
		"mov" => "video/quicktime",
		"webm" => "video/webm",
		_ => "application/octet-stream",
	}
}

/// Le fichier en data URI, pour l'afficher quand le protocole `asset` échoue.
///
/// Repli et non voie principale : le base64 pèse un tiers de plus et transite
/// par l'IPC. Mais il ne dépend d'aucun périmètre à configurer, là où
/// `asset://` refuse silencieusement tout ce qui sort de son scope — un dossier
/// caché comme `.claude` suffit à le faire échouer selon la plateforme.
pub fn data_url(path: &Path, max_bytes: u64) -> Result<String, String> {
	let metadata = std::fs::metadata(path).map_err(|e| crate::i18n::tf("qa.fileUnreadable", &[("error", &e)]))?;
	if metadata.len() > max_bytes {
		return Err(crate::i18n::tf(
			"qa.fileTooLarge",
			&[("size", &(metadata.len() / 1_048_576))],
		));
	}
	let bytes = std::fs::read(path).map_err(|e| crate::i18n::tf("qa.readFailed", &[("error", &e)]))?;
	let extension = path
		.extension()
		.map(|e| e.to_string_lossy().to_lowercase())
		.unwrap_or_default();
	Ok(format!(
		"data:{};base64,{}",
		mime_of(&extension),
		base64(&bytes)
	))
}

/// Recopie les livrables de QA d'un worktree vers un autre, chemins conservés.
///
/// Ces fichiers sont ignorés par git — et doivent l'être : une capture d'écran
/// n'a rien à faire dans la branche qui partira en production. Ils ne suivent
/// donc pas les branches au moment de fusionner, et le worktree qui les portait
/// est rangé à la fin de la mission. Sans cette copie, la pull request
/// s'ouvrirait depuis un dossier où il n'y a plus rien à joindre.
///
/// Rien n'est commité ici : on déplace des fichiers, la branche reste intacte.
pub fn collect_into(from: &Path, to: &Path) -> Vec<String> {
	let mut copied = Vec::new();
	if from == to {
		return copied;
	}
	for file in scan(from, 2_000) {
		let target = to.join(&file.relative);
		if let Some(parent) = target.parent() {
			if std::fs::create_dir_all(parent).is_err() {
				continue;
			}
		}
		if std::fs::copy(&file.path, &target).is_ok() {
			copied.push(file.relative);
		}
	}
	copied
}

/// Livrables de QA d'un worktree, groupés par dossier et prêts à afficher.
pub fn scan(worktree: &Path, limit: usize) -> Vec<QaFile> {
	let mut files = Vec::new();
	for root in ROOTS {
		let candidate = worktree.join(root);
		if candidate.is_dir() {
			walk(&candidate, worktree, 0, &mut files, limit);
		}
	}
	files
}
