//! Commandes « / » de Claude Code, telles que le CLI les comprend.
//!
//! Ce sont des fichiers Markdown : `~/.claude/commands/review.md` définit
//! `/review`, dont le corps devient le prompt envoyé. Rien à interpréter ici —
//! le cockpit se contente de les nommer pour qu'on les retrouve sans les
//! connaître par cœur, et laisse le CLI faire le travail. On a vérifié qu'il
//! les résout aussi en mode `-p --input-format stream-json`, celui par lequel
//! le cockpit lance ses agents : une commande envoyée comme un message
//! ordinaire est bien exécutée comme telle.
//!
//! Trois provenances, dans l'ordre où on les propose : le dossier du worktree
//! (les commandes de l'équipe, versionnées avec le code), le dossier personnel,
//! puis les plugins installés. Une commande de projet l'emporte sur une
//! commande personnelle de même nom — c'est la règle du CLI, et l'inverse
//! surprendrait : le dépôt décide chez lui.

use crate::error::Result;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
	/// Ce qu'on tape, sans la barre oblique : « review », « frontend:composant ».
	pub name: String,
	pub description: String,
	/// Ce que la commande attend après son nom, quand elle le déclare.
	pub argument_hint: Option<String>,
	/// « project », « user » ou « plugin » — d'où elle vient.
	pub scope: String,
	/// Fichier qui la définit, pour aller la relire ou la corriger.
	pub source: String,
}

/// Découpe l'en-tête YAML d'un fichier de commande.
///
/// Un analyseur complet serait hors sujet : ces en-têtes tiennent en deux
/// clés, `description` et `argument-hint`, sur une ligne chacune. On lit donc
/// ligne à ligne, et ce qu'on ne comprend pas est ignoré plutôt que de faire
/// échouer la lecture — une commande mal formée reste utilisable.
fn front_matter(text: &str) -> (Option<String>, Option<String>, &str) {
	let rest = match text.strip_prefix("---\n") {
		Some(value) => value,
		None => return (None, None, text),
	};
	let Some(end) = rest.find("\n---") else {
		return (None, None, text);
	};
	let (header, body) = rest.split_at(end);

	let mut description = None;
	let mut hint = None;
	for line in header.lines() {
		let Some((key, value)) = line.split_once(':') else {
			continue;
		};
		let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
		if value.is_empty() {
			continue;
		}
		match key.trim() {
			"description" => description = Some(value),
			"argument-hint" | "argumentHint" => hint = Some(value),
			_ => {}
		}
	}

	// `\n---` consommé, plus le saut de ligne qui suit s'il y en a un.
	let body = body.trim_start_matches("\n---").trim_start_matches('\n');
	(description, hint, body)
}

/// Première ligne parlante du corps, quand l'en-tête ne décrit rien.
///
/// Beaucoup de commandes n'ont pas de `description` : sans ce repli, la liste
/// afficherait une colonne vide là où le fichier dit pourtant ce qu'il fait.
fn first_line(body: &str) -> String {
	for line in body.lines() {
		let line = line.trim().trim_start_matches('#').trim();
		if line.is_empty() {
			continue;
		}
		return if line.chars().count() > 90 {
			format!("{}…", line.chars().take(89).collect::<String>())
		} else {
			line.to_string()
		};
	}
	String::new()
}

/// Nom d'une commande d'après son chemin sous `commands/`.
///
/// Les sous-dossiers deviennent des préfixes séparés par `:` — c'est la
/// convention du CLI : `commands/frontend/composant.md` donne
/// `/frontend:composant`.
fn command_name(root: &Path, file: &Path, prefix: Option<&str>) -> Option<String> {
	let relative = file.strip_prefix(root).ok()?;
	let stem = relative.with_extension("");
	let mut parts: Vec<String> = stem
		.components()
		.map(|part| part.as_os_str().to_string_lossy().to_string())
		.collect();
	if parts.is_empty() {
		return None;
	}
	if let Some(prefix) = prefix {
		parts.insert(0, prefix.to_string());
	}
	Some(parts.join(":"))
}

/// Les skills, qui s'invoquent comme des commandes.
///
/// Un skill est un dossier portant un `SKILL.md` dont l'en-tête le décrit, et
/// le CLI l'expose sous le nom de ce dossier. Ils forment le gros de ce que le
/// balayage des seuls `commands/` manquait — vingt-cinq sur ce dépôt, avec des
/// descriptions autrement plus parlantes que leur nom.
fn scan_skills(root: &Path, scope: &str, prefix: Option<&str>, out: &mut Vec<SlashCommand>) {
	if !root.is_dir() {
		return;
	}
	let Ok(entries) = std::fs::read_dir(root) else {
		return;
	};
	for entry in entries.flatten() {
		let file = entry.path().join("SKILL.md");
		if !file.is_file() {
			continue;
		}
		let Some(folder) = entry.file_name().to_str().map(str::to_string) else {
			continue;
		};
		let Ok(text) = std::fs::read_to_string(&file) else {
			continue;
		};
		let (description, argument_hint, body) = front_matter(&text);
		let name = match prefix {
			Some(prefix) => format!("{prefix}:{folder}"),
			None => folder,
		};
		out.push(SlashCommand {
			name,
			// Les descriptions de skills tiennent le paragraphe : elles disent
			// quand s'en servir autant que ce qu'elles font. La liste n'en
			// montre qu'une ligne, le reste se lit dans le fichier.
			description: shorten(&description.unwrap_or_else(|| first_line(body))),
			argument_hint,
			scope: scope.to_string(),
			source: file.to_string_lossy().to_string(),
		});
	}
}

/// Coupe une description à ce qu'une ligne de menu peut montrer.
fn shorten(value: &str) -> String {
	let value = value.trim();
	if value.chars().count() <= 120 {
		return value.to_string();
	}
	format!("{}…", value.chars().take(119).collect::<String>())
}

fn scan(root: &Path, scope: &str, prefix: Option<&str>, out: &mut Vec<SlashCommand>) {
	if !root.is_dir() {
		return;
	}
	// Profondeur bornée : une arborescence de commandes reste plate ou presque,
	// et un lien symbolique vers le dépôt entier ne doit pas se parcourir.
	for entry in WalkDir::new(root)
		.max_depth(4)
		.into_iter()
		.filter_map(|entry| entry.ok())
	{
		let path = entry.path();
		if !entry.file_type().is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
			continue;
		}
		let Some(name) = command_name(root, path, prefix) else {
			continue;
		};
		let Ok(text) = std::fs::read_to_string(path) else {
			continue;
		};
		let (description, argument_hint, body) = front_matter(&text);
		out.push(SlashCommand {
			name,
			description: description.unwrap_or_else(|| first_line(body)),
			argument_hint,
			scope: scope.to_string(),
			source: path.to_string_lossy().to_string(),
		});
	}
}

/// Plugins déclarés actifs, tous fichiers de réglages confondus.
///
/// `enabledPlugins` est la clé qui décide, et elle vit dans les réglages — du
/// poste, du dépôt, ou locaux au dépôt. On a d'abord cru que le registre
/// d'installation suffisait : il dit seulement où un plugin a été téléchargé,
/// pas s'il est allumé ici. Un plugin installé pour un autre dépôt mais activé
/// globalement passait ainsi à la trappe.
/// Le dossier de configuration du compte sous lequel on travaille.
///
/// Les commandes personnelles, les skills et les plugins y vivent, et non dans
/// un `~/.claude` supposé : un projet rattaché à un autre compte a son propre
/// outillage, et proposer celui du voisin ferait échouer chaque appel — la
/// commande existe à l'écran, pas là où l'agent la cherche.
fn compte_dir() -> PathBuf {
	let config = crate::config::Config::active();
	crate::config::account_dir(&crate::config::account_for(&config))
}

fn enabled_plugins(cwd: &Path) -> HashSet<String> {
	let mut names = HashSet::new();
	let mut files: Vec<PathBuf> = vec![compte_dir().join("settings.json")];
	files.push(cwd.join(".claude/settings.json"));
	files.push(cwd.join(".claude/settings.local.json"));

	for file in files {
		let Ok(text) = std::fs::read_to_string(&file) else {
			continue;
		};
		let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
			continue;
		};
		let Some(entries) = parsed.get("enabledPlugins").and_then(|v| v.as_object()) else {
			continue;
		};
		for (key, value) in entries {
			if value.as_bool() == Some(true) {
				names.insert(key.clone());
			}
		}
	}
	names
}

/// Commandes et skills fournis par les plugins actifs sur ce dossier.
///
/// Le registre d'installation ne sert plus qu'à retrouver *où* vit un plugin ;
/// c'est `enabledPlugins` qui dit lesquels comptent.
fn plugins(cwd: &Path, out: &mut Vec<SlashCommand>) {
	let enabled = enabled_plugins(cwd);
	if enabled.is_empty() {
		return;
	}
	let registry = compte_dir().join("plugins/installed_plugins.json");
	let Ok(text) = std::fs::read_to_string(&registry) else {
		return;
	};
	let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
		return;
	};
	let Some(plugins) = parsed.get("plugins").and_then(|value| value.as_object()) else {
		return;
	};

	for (key, entries) in plugins {
		if !enabled.contains(key) {
			continue;
		}
		// « playwright@claude-plugins-official » — seul le nom sert de préfixe.
		let label = key.split('@').next().unwrap_or(key).to_string();
		let Some(entries) = entries.as_array() else {
			continue;
		};
		// Un plugin peut avoir été installé plusieurs fois, une par projet :
		// n'importe quel exemplaire porte les mêmes fichiers.
		for entry in entries {
			let Some(install) = entry.get("installPath").and_then(|value| value.as_str()) else {
				continue;
			};
			let base = PathBuf::from(install);
			if !base.is_dir() {
				continue;
			}
			scan(&base.join("commands"), "plugin", Some(&label), out);
			scan_skills(&base.join("skills"), "plugin", Some(&label), out);
			break;
		}
	}
}

/// Les commandes utilisables depuis ce dossier, sans doublon de nom.
pub fn list(cwd: String) -> Result<Vec<SlashCommand>> {
	let cwd = PathBuf::from(cwd);
	let mut found = Vec::new();

	scan(&cwd.join(".claude/commands"), "project", None, &mut found);
	scan_skills(&cwd.join(".claude/skills"), "skill", None, &mut found);
	let compte = compte_dir();
	scan(&compte.join("commands"), "user", None, &mut found);
	scan_skills(&compte.join("skills"), "skill", None, &mut found);
	plugins(&cwd, &mut found);

	// Premier arrivé, premier servi : l'ordre de collecte porte déjà la
	// précédence — projet, puis personnel, puis plugins.
	let mut seen = HashSet::new();
	found.retain(|command| seen.insert(command.name.clone()));
	found.sort_by(|a, b| a.name.cmp(&b.name));
	Ok(found)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn len_tete_donne_la_description_et_les_arguments() {
		let (description, hint, body) =
			front_matter("---\ndescription: Relit la PR\nargument-hint: [numéro]\n---\n\nCorps du prompt.\n");
		assert_eq!(description.as_deref(), Some("Relit la PR"));
		assert_eq!(hint.as_deref(), Some("[numéro]"));
		assert_eq!(body.trim(), "Corps du prompt.");
	}

	/// Une commande sans en-tête reste utilisable : c'est la forme la plus
	/// courante des commandes écrites à la va-vite.
	#[test]
	fn sans_en_tete_le_corps_est_intact() {
		let (description, hint, body) = front_matter("# Revue\n\nRelis le diff.\n");
		assert!(description.is_none());
		assert!(hint.is_none());
		assert_eq!(body, "# Revue\n\nRelis le diff.\n");
		// Faute de description déclarée, le titre en tient lieu.
		assert_eq!(first_line(body), "Revue");
	}

	/// Une description de skill tient le paragraphe : la liste n'en montre
	/// qu'une ligne, sans couper un caractère en deux.
	#[test]
	fn une_description_trop_longue_est_coupee() {
		let court = "Relit le diff courant";
		assert_eq!(shorten(court), court);

		let long = "é".repeat(300);
		let coupe = shorten(&long);
		assert_eq!(coupe.chars().count(), 120);
		assert!(coupe.ends_with('…'));
	}

	/// Les sous-dossiers font partie du nom, séparés par `:` — sans quoi deux
	/// commandes homonymes dans deux dossiers s'écraseraient.
	#[test]
	fn les_sous_dossiers_prefixent_le_nom() {
		let root = Path::new("/tmp/commands");
		assert_eq!(
			command_name(root, Path::new("/tmp/commands/revue.md"), None).as_deref(),
			Some("revue")
		);
		assert_eq!(
			command_name(root, Path::new("/tmp/commands/front/composant.md"), None).as_deref(),
			Some("front:composant")
		);
		assert_eq!(
			command_name(root, Path::new("/tmp/commands/test.md"), Some("playwright")).as_deref(),
			Some("playwright:test")
		);
	}
}
