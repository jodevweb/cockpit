//! Les commandes maison d'un dépôt, telles qu'il les déclare.
//!
//! Un dépôt a des commandes qu'on ne retape pas de mémoire : celles à options,
//! celles dont on oublie les drapeaux, celles qui montent une infra. Elles
//! vivaient dans le binaire du cockpit, écrites pour une seule équipe — dix-huit
//! entrées qu'aucun autre projet ne pouvait ni changer, ni voir, ni retirer.
//!
//! Elles sont maintenant déclarées par projet, ou proposées par **la
//! détection**, qui lit ce que le dépôt déclare lui-même — ses scripts. Les
//! installations qui les avaient dans leur binaire les ont reçues dans leur
//! configuration au passage ; la graine qui les y portait est retirée.
//!
//! Rien n'est fourni par défaut à une installation neuve : une commande
//! inventée ici décrirait l'outillage de celui qui l'a écrite.

use crate::config::CommandConfig;
use crate::error::Result;
use std::path::Path;

/// Assemble la ligne finale à partir des valeurs saisies.
///
/// Côté Rust plutôt que dans l'écran : c'est ce qui part réellement dans un
/// terminal, et deux surfaces qui l'assembleraient chacune à leur façon
/// finiraient par ne plus lancer la même chose.
pub fn build(command: &CommandConfig, positional: &str, values: &[(String, String)]) -> String {
	let mut parts = vec![command.base.trim().to_string()];

	let argument = positional.trim();
	if !argument.is_empty() {
		parts.push(argument.to_string());
	}

	for option in &command.options {
		let Some((_, value)) = values.iter().find(|(id, _)| id == &option.id) else {
			continue;
		};
		let value = value.trim();
		if option.kind == "boolean" {
			// Une case cochée pose son drapeau, seul : `--force true` n'est pas
			// ce qu'attend une ligne de commande.
			if value == "true" {
				parts.push(option.flag.trim().to_string());
			}
			continue;
		}
		if value.is_empty() {
			continue;
		}
		parts.push(option.flag.trim().to_string());
		parts.push(value.to_string());
	}

	parts.retain(|part| !part.is_empty());
	parts.join(" ")
}

/// Ce que ce dépôt déclare, proposé comme commandes.
///
/// On lit ses scripts — c'est ce qu'un dépôt dit de lui-même de plus fiable. Le
/// lanceur n'est pas supposé : il se déduit du fichier de verrou présent, faute
/// de quoi on écrirait `pnpm` chez quelqu'un qui n'en a jamais installé.
pub fn detect(repo: &Path) -> Result<Vec<CommandConfig>> {
	let runner = script_runner(repo);
	let scripts = crate::system::package_scripts(repo)?;

	Ok(scripts
		.into_iter()
		.map(|script| CommandConfig {
			id: format!("script-{}", script.name),
			group: script.group.clone(),
			label: script.name.clone(),
			description: script.command.clone(),
			base: format!("{runner} {}", script_argument(&script.name)),
			// Un script de dépôt tourne là où l'on travaille : c'est le cas
			// courant, et l'exception se coche à la main.
			scoped: true,
			danger: false,
			positional: None,
			options: Vec::new(),
		})
		.collect())
}

/// Le nom d'un script, prêt pour la ligne de commande.
///
/// Il vient du `package.json` d'un dépôt — cloné, donc pas forcément de
/// confiance : un nom comme `x; curl …|sh` serait sinon une seconde commande,
/// jouée en plus du script affiché. Les noms ordinaires restent nus.
fn script_argument(name: &str) -> String {
	let plain = !name.is_empty()
		&& !name.starts_with('-')
		&& name
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || ":._-/@+=".contains(c));
	if plain {
		name.to_string()
	} else {
		format!("'{}'", name.replace('\'', "'\\''"))
	}
}

/// Le lanceur de scripts de ce dépôt, d'après ce qu'il porte.
///
/// Aucun défaut d'équipe : un dépôt sans fichier de verrou connu obtient `npm
/// run`, qui existe partout où il y a un `package.json`.
pub(crate) fn script_runner(repo: &Path) -> &'static str {
	for (fichier, lanceur) in [
		("pnpm-lock.yaml", "pnpm"),
		("bun.lockb", "bun run"),
		("bun.lock", "bun run"),
		("yarn.lock", "yarn"),
		("deno.lock", "deno task"),
	] {
		if repo.join(fichier).is_file() {
			return lanceur;
		}
	}
	"npm run"
}

/// Fabrique une commande à partir des champs minimaux — le reste est vide.
pub fn blank(id: &str) -> CommandConfig {
	CommandConfig {
		id: id.into(),
		group: "Commandes".into(),
		label: String::new(),
		description: String::new(),
		base: String::new(),
		scoped: true,
		danger: false,
		positional: None,
		options: Vec::new(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::config::CommandOptionConfig;

	#[test]
	fn un_nom_de_script_hostile_reste_un_argument() {
		assert_eq!(script_argument("dev:web"), "dev:web");
		assert_eq!(script_argument("x; curl e|sh"), "'x; curl e|sh'");
		assert_eq!(script_argument("a'b"), "'a'\\''b'");
	}

	fn option(id: &str, flag: &str, kind: &str) -> CommandOptionConfig {
		CommandOptionConfig {
			id: id.into(),
			flag: flag.into(),
			label: id.into(),
			kind: kind.into(),
			hint: String::new(),
			placeholder: String::new(),
			choices: Vec::new(),
			default_value: String::new(),
		}
	}

	fn command() -> CommandConfig {
		CommandConfig {
			base: "pnpm worktree:create".into(),
			options: vec![option("force", "--force", "boolean"), option("from", "--from", "text")],
			..blank("x")
		}
	}

	#[test]
	fn une_case_cochee_pose_son_drapeau_seul() {
		let line = build(&command(), "", &[("force".into(), "true".into())]);
		assert_eq!(line, "pnpm worktree:create --force");
	}

	#[test]
	fn une_case_decochee_ne_pose_rien() {
		let line = build(&command(), "", &[("force".into(), "false".into())]);
		assert_eq!(line, "pnpm worktree:create");
	}

	#[test]
	fn une_valeur_texte_suit_son_drapeau() {
		let line = build(&command(), "feat/x", &[("from".into(), " dev ".into())]);
		assert_eq!(line, "pnpm worktree:create feat/x --from dev");
	}

	/// Un champ laissé vide ne doit pas produire un drapeau orphelin, qui ferait
	/// échouer la commande sur une erreur d'usage incompréhensible.
	#[test]
	fn une_valeur_vide_n_ecrit_pas_son_drapeau() {
		let line = build(&command(), "", &[("from".into(), "   ".into())]);
		assert_eq!(line, "pnpm worktree:create");
	}

	/// Le lanceur se déduit du dépôt : l'écrire en dur supposerait l'outillage
	/// de celui qui a écrit le cockpit.
	#[test]
	fn le_lanceur_se_lit_dans_le_depot() {
		let dir = std::env::temp_dir().join(format!("cockpit-runner-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();

		assert_eq!(script_runner(&dir), "npm run", "sans verrou, le plus commun");

		std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
		assert_eq!(script_runner(&dir), "pnpm");

		std::fs::remove_dir_all(&dir).ok();
	}
}
