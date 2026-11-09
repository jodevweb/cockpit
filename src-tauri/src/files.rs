//! Les fichiers d'un worktree, pour les ouvrir et les modifier sans sortir.
//!
//! Le cockpit savait déjà lire un fichier qu'un agent avait nommé. Ce qu'il ne
//! savait pas, c'est en trouver un dont personne n'a parlé — un `.env` à
//! corriger, une config à relire. Or ce sont précisément ceux-là qui vivent
//! hors de git : `.env` est ignoré partout, `git ls-files` ne le voit pas. On
//! parcourt donc le disque, en écartant ce qui n'intéresse personne.
//!
//! Toute la liste part d'un coup plutôt qu'à chaque frappe : sept mille
//! fichiers sur un gros dépôt, moins d'une seconde à parcourir, et le filtrage
//! devient instantané côté interface. Rescanner à chaque lettre coûterait cent
//! fois plus pour un résultat identique.

use crate::error::{CockpitError, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Dossiers qu'on ne parcourt jamais.
///
/// Ce sont des artefacts : ils pèsent l'essentiel du disque, ne se modifient
/// pas à la main, et noieraient toute recherche. `node_modules` seul multiplie
/// le nombre de fichiers par cinquante.
const SKIP: &[&str] = &[
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	".turbo",
	".cache",
	".vercel",
	".svelte-kit",
	"storybook-static",
	"__pycache__",
	".venv",
];

/// Au-delà, la liste ne sert plus à chercher : elle sert à attendre.
const MAX_FILES: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
	/// Chemin absolu, celui qu'on ouvre.
	pub path: String,
	/// Chemin relatif au worktree, celui qu'on lit et qu'on cherche.
	pub relative: String,
}

/// Les fichiers d'un worktree, artefacts écartés.
///
/// Leur taille n'est plus relevée : c'était un appel au disque de plus par
/// fichier — vingt mille sur un gros dépôt — pour une mention que personne ne
/// lisait.
pub fn list(root: String) -> Result<Vec<FileEntry>> {
	let root = PathBuf::from(&root);
	if !root.is_dir() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"files.folderNotFound",
			&[("path", &root.display())],
		)));
	}

	let mut entries = Vec::new();
	let walker = WalkDir::new(&root).into_iter().filter_entry(|entry| {
		if entry.depth() == 0 {
			return true;
		}
		let name = entry.file_name().to_string_lossy();
		// Les dossiers cachés passent — `.claude`, `.github`, `.vscode` sont
		// exactement ce qu'on vient éditer. Seuls les artefacts sont écartés.
		!SKIP.contains(&name.as_ref())
	});

	for entry in walker.filter_map(|entry| entry.ok()) {
		if !entry.file_type().is_file() {
			continue;
		}
		let Ok(relative) = entry.path().strip_prefix(&root) else {
			continue;
		};
		// Séparateurs `/` : l'interface découpe les chemins dessus.
		entries.push(FileEntry {
			path: crate::platform::display_path(entry.path()),
			relative: crate::platform::display_path(relative),
		});
		if entries.len() >= MAX_FILES {
			break;
		}
	}

	entries.sort_by(|a, b| a.relative.cmp(&b.relative));
	Ok(entries)
}

/// Enregistre un fichier, sans jamais le laisser à moitié écrit.
///
/// Écriture dans un fichier voisin puis renommage : le remplacement est
/// atomique pour le système de fichiers. Écrire directement dans le fichier
/// cible le tronquerait d'abord — une panne au mauvais moment, et un `.env` de
/// production se retrouve vide.
pub fn write(path: String, content: String) -> Result<()> {
	let target = PathBuf::from(&path);
	let Some(parent) = target.parent() else {
		return Err(CockpitError::msg(crate::i18n::t("files.invalidPath")));
	};
	if !parent.is_dir() {
		return Err(CockpitError::msg(crate::i18n::tf(
			"files.folderMissing",
			&[("path", &parent.display())],
		)));
	}
	if target.is_dir() {
		return Err(CockpitError::msg(crate::i18n::t("files.isFolder")));
	}

	let temporary = temporary_beside(&target);
	// Le temporaire naît en 600 : écrit avec les droits par défaut, le contenu
	// d'un `.env` en 600 restait lisible de tous le temps de l'écriture.
	{
		use std::io::Write;
		let mut options = std::fs::OpenOptions::new();
		options.write(true).create_new(true);
		#[cfg(unix)]
		{
			use std::os::unix::fs::OpenOptionsExt;
			options.mode(0o600);
		}
		let written = options
			.open(&temporary)
			.and_then(|mut file| file.write_all(content.as_bytes()));
		if let Err(e) = written {
			let _ = std::fs::remove_file(&temporary);
			return Err(CockpitError::msg(crate::i18n::tf("files.writeFile", &[("path", &target.display()), ("error", &e)])));
		}
	}

	// Les droits d'origine survivent au remplacement : un fichier en 600 ne
	// doit pas ressortir lisible par tout le monde.
	// Un fichier neuf, lui, prend les droits ordinaires (644), comme avant.
	let existing = std::fs::metadata(&target).ok();
	if let Some(meta) = &existing {
		let _ = std::fs::set_permissions(&temporary, meta.permissions());
	}
	#[cfg(unix)]
	if existing.is_none() {
		use std::os::unix::fs::PermissionsExt;
		let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o644));
	}

	std::fs::rename(&temporary, &target).map_err(|e| {
		let _ = std::fs::remove_file(&temporary);
		CockpitError::msg(crate::i18n::tf("files.replaceFile", &[("path", &target.display()), ("error", &e)]))
	})?;
	Ok(())
}

// ───────────────────────── Pièces jointes d'un agent ─────────────────────────
//
// Joindre une capture ou un document à une conversation, comme dans les éditeurs
// à agent. Le CLI sait déjà lire un fichier local — images comprises : il suffit
// de lui en donner le chemin. Rien ne transite donc en base64 dans la
// conversation, et le procédé marche pour tout ce qui se lit, pas seulement les
// images.
//
// Les pièces jointes vivent hors du dépôt, dans la configuration du cockpit :
// déposées dans le worktree, elles apparaîtraient dans `git status` et
// finiraient un jour commitées par mégarde.

/// Au-delà, ce n'est plus une pièce jointe : le CLI passerait son tour à lire.
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1_048_576;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
	/// Chemin absolu, celui qu'on donne à l'agent.
	pub path: String,
	/// Nom d'origine, celui qu'on affiche.
	pub name: String,
	pub size: u64,
}

/// Où vivent les pièces jointes d'une conversation.
fn attachments_dir(session: &str) -> PathBuf {
	let session = session.trim();
	let folder = if session.is_empty() { "sans-session" } else { session };
	crate::config::config_dir().join("joint").join(sanitize(folder))
}

/// Nom de fichier sûr : ni séparateur, ni remontée de dossier.
///
/// Le nom vient du webview — d'un fichier déposé, d'un presse-papier. `../` y
/// serait un chemin d'écriture arbitraire, et le cockpit tourne sans bac à sable.
fn sanitize(name: &str) -> String {
	let cleaned: String = name
		.chars()
		.map(|c| match c {
			'/' | '\\' | ':' => '-',
			c if c.is_control() => '-',
			// Ce que Windows refuse dans un nom de fichier.
			'<' | '>' | '"' | '|' | '?' | '*' if cfg!(windows) => '-',
			c => c,
		})
		.collect();
	let cleaned = cleaned.trim().trim_start_matches('.').to_string();
	if cleaned.is_empty() {
		"fichier".into()
	} else {
		cleaned
	}
}

/// Chemin libre pour cette pièce jointe, dossier créé au besoin.
fn attachment_target(session: &str, name: &str) -> Result<PathBuf> {
	let dir = attachments_dir(session);
	std::fs::create_dir_all(&dir)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("files.attachmentsDir", &[("error", &e)])))?;

	let safe = sanitize(name);
	let candidate = dir.join(&safe);
	if !candidate.exists() {
		return Ok(candidate);
	}
	// Deux captures du même nom dans la même conversation : on numérote plutôt
	// que d'écraser la première, dont l'agent a peut-être déjà parlé.
	let stem = Path::new(&safe)
		.file_stem()
		.map(|value| value.to_string_lossy().to_string())
		.unwrap_or_else(|| "fichier".into());
	let extension = Path::new(&safe)
		.extension()
		.map(|value| format!(".{}", value.to_string_lossy()))
		.unwrap_or_default();
	for index in 2..1_000 {
		let candidate = dir.join(format!("{stem}-{index}{extension}"));
		if !candidate.exists() {
			return Ok(candidate);
		}
	}
	Err(CockpitError::msg(crate::i18n::t("files.tooManySameName")))
}

/// Joint un fichier déjà sur le disque : glissé depuis le Finder, ou choisi.
///
/// Copié plutôt que référencé sur place : le fichier d'origine peut être
/// déplacé, renommé ou supprimé dans la minute, et la conversation garderait un
/// chemin mort. Une copie coûte quelques mégaoctets et reste lisible plus tard.
pub fn attach(session: String, path: String) -> Result<Attachment> {
	let source = PathBuf::from(&path);
	let meta = std::fs::metadata(&source)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("files.fileUnreadable", &[("error", &e)])))?;
	if meta.is_dir() {
		return Err(CockpitError::msg(crate::i18n::t("files.folderNotAttachable")));
	}
	if meta.len() > MAX_ATTACHMENT_BYTES {
		return Err(CockpitError::msg(crate::i18n::tf(
			"files.fileTooLarge",
			&[
				("name", &source.file_name().unwrap_or_default().to_string_lossy()),
				("size", &(meta.len() / 1_048_576)),
				("max", &(MAX_ATTACHMENT_BYTES / 1_048_576)),
			],
		)));
	}

	let name = source
		.file_name()
		.map(|value| value.to_string_lossy().to_string())
		.unwrap_or_else(|| "fichier".into());
	let target = attachment_target(&session, &name)?;
	std::fs::copy(&source, &target)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("files.copyAttachment", &[("error", &e)])))?;

	Ok(Attachment {
		path: target.to_string_lossy().to_string(),
		name,
		size: meta.len(),
	})
}

/// Joint un contenu venu du presse-papier, qui n'a pas de chemin sur le disque.
///
/// Une capture collée n'existe que dans le presse-papier : le webview en rend
/// les octets, encodés, et c'est ici qu'ils prennent corps.
pub fn attach_bytes(session: String, name: String, data: String) -> Result<Attachment> {
	use base64::Engine;

	let bytes = base64::engine::general_purpose::STANDARD
		.decode(data.trim())
		.map_err(|_| CockpitError::msg(crate::i18n::t("files.badEncoding")))?;
	if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
		return Err(CockpitError::msg(crate::i18n::tf(
			"files.attachmentTooLarge",
			&[("size", &(bytes.len() / 1_048_576)), ("max", &(MAX_ATTACHMENT_BYTES / 1_048_576))],
		)));
	}
	if bytes.is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("files.emptyAttachment")));
	}

	let target = attachment_target(&session, &name)?;
	std::fs::write(&target, &bytes)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("files.writeAttachment", &[("error", &e)])))?;

	Ok(Attachment {
		path: target.to_string_lossy().to_string(),
		name: sanitize(&name),
		size: bytes.len() as u64,
	})
}

/// Fichier temporaire dans le même dossier que la cible.
///
/// Même dossier, donc même volume : un renommage entre volumes n'est pas
/// atomique, et `/tmp` peut très bien être ailleurs.
fn temporary_beside(target: &Path) -> PathBuf {
	let name = target
		.file_name()
		.map(|value| value.to_string_lossy().to_string())
		.unwrap_or_else(|| "fichier".into());
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|value| value.as_nanos())
		.unwrap_or(0);
	target.with_file_name(format!(".{name}.cockpit-{stamp}"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn le_temporaire_reste_dans_le_dossier_cible() {
		let cible = Path::new("/Code/monorepo/packages/tasks/.env");
		let temporaire = temporary_beside(cible);
		assert_eq!(temporaire.parent(), cible.parent());
		assert_ne!(temporaire.file_name(), cible.file_name());
	}

	/// Le nom d'une pièce jointe vient du webview : il ne doit pas pouvoir
	/// désigner un autre dossier. Un `../` accepté ici serait une écriture
	/// arbitraire sur le disque de l'utilisateur.
	#[test]
	fn le_nom_d_une_piece_jointe_ne_sort_pas_de_son_dossier() {
		for hostile in ["../../.zshrc", "/etc/passwd", "..", ".", "  "] {
			let safe = sanitize(hostile);
			assert!(!safe.contains('/'), "{hostile} garde un séparateur");
			assert!(!safe.starts_with('.'), "{hostile} reste un chemin relatif");
			assert!(!safe.trim().is_empty(), "{hostile} rend un nom vide");
		}
		// Un nom ordinaire, lui, traverse intact — extension comprise.
		assert_eq!(sanitize("01-capture écran.png"), "01-capture écran.png");
	}

	/// Deux captures du même nom ne doivent pas s'écraser : l'agent a peut-être
	/// déjà parlé de la première.
	#[test]
	fn deux_pieces_jointes_homonymes_cohabitent() {
		let session = format!("test-{}", std::process::id());
		let premier = attachment_target(&session, "capture.png").unwrap();
		std::fs::create_dir_all(premier.parent().unwrap()).unwrap();
		std::fs::write(&premier, b"un").unwrap();

		let second = attachment_target(&session, "capture.png").unwrap();
		assert_ne!(premier, second);
		assert_eq!(
			second.file_name().unwrap().to_string_lossy(),
			"capture-2.png"
		);
		std::fs::remove_dir_all(attachments_dir(&session)).ok();
	}

	/// Un remplacement doit laisser le fichier intact ou complet, jamais entre
	/// les deux — et surtout pas vide.
	#[test]
	fn l_ecriture_remplace_sans_etape_vide() {
		let dossier = std::env::temp_dir().join(format!(
			"cockpit-test-{}",
			std::process::id()
		));
		std::fs::create_dir_all(&dossier).unwrap();
		let fichier = dossier.join(".env");
		std::fs::write(&fichier, "AVANT=1").unwrap();

		write(fichier.to_string_lossy().to_string(), "APRES=2".into()).unwrap();
		assert_eq!(std::fs::read_to_string(&fichier).unwrap(), "APRES=2");

		// Aucun résidu : le temporaire a bien été renommé, pas laissé derrière.
		let restes = std::fs::read_dir(&dossier).unwrap().count();
		assert_eq!(restes, 1);
		std::fs::remove_dir_all(&dossier).ok();
	}
}
