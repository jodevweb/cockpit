//! Ce que le cockpit a fait en ton nom.
//!
//! L'app pousse des branches, fusionne des PR, supprime des worktrees et lance
//! des agents qui écrivent dans le dépôt. Sans trace, impossible de répondre à
//! « qui a poussé ça ? » ou de comprendre un dépôt qui a bougé pendant qu'on
//! regardait ailleurs. Le journal ne remplace pas `git reflog` : il note
//! l'intention et son résultat, à l'endroit où on la donne.
//!
//! Un fichier JSONL, tronqué au-delà d'un millier d'entrées : c'est un carnet
//! de bord, pas une base de données.

use crate::config::config_dir;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

const MAX_ENTRIES: usize = 1000;

/// Toi. La valeur par défaut, et pendant longtemps la seule.
pub const HUMAN: &str = "me";
/// La Permanence, quand elle agit sans que personne ne regarde.
pub const PERMANENCE: &str = "permanence";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
	pub at: u64,
	/// Projet actif au moment de l'action.
	pub project: String,
	/// `git` · `agent` · `worktree` · `github` — de quoi filtrer d'un coup d'œil.
	pub kind: String,
	/// Ce qui a été fait, en clair.
	pub label: String,
	/// Cible concernée : branche, dossier, numéro de PR.
	#[serde(default)]
	pub target: String,
	pub ok: bool,
	/// Message d'erreur quand l'action a échoué.
	#[serde(default)]
	pub detail: String,
	/// Qui a agi : [`HUMAN`] ou [`PERMANENCE`].
	///
	/// Les entrées écrites avant l'arrivée de ce champ n'en portent pas ; elles
	/// se relisent comme humaines, ce qu'elles étaient toutes.
	#[serde(default = "human")]
	pub actor: String,
	/// L'engagement auquel rattacher l'entrée, quand la Permanence a agi.
	#[serde(default)]
	pub engagement: String,
}

fn human() -> String {
	HUMAN.to_string()
}

fn journal_path() -> PathBuf {
	config_dir().join("journal.jsonl")
}

fn now() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0)
}

/// Enregistre une action faite à ta demande. Silencieux en cas d'échec : ne
/// jamais faire échouer une opération réussie parce que son journal n'a pas pu
/// s'écrire.
pub fn record(kind: &str, label: &str, target: &str, ok: bool, detail: &str) {
	write(HUMAN, "", kind, label, target, ok, detail);
}

/// Enregistre une action faite par quelqu'un d'autre que toi.
///
/// L'acteur se passe explicitement, jamais par un contexte ambiant : la
/// Permanence agit pendant que tu cliques ailleurs, et un acteur posé
/// globalement finirait par signer tes propres gestes. Une attribution fausse
/// coûte plus cher qu'une attribution absente — c'est tout ce que ce champ
/// existe pour empêcher.
pub fn record_as(
	actor: &str,
	engagement: &str,
	kind: &str,
	label: &str,
	target: &str,
	ok: bool,
	detail: &str,
) {
	write(actor, engagement, kind, label, target, ok, detail);
}

fn write(
	actor: &str,
	engagement: &str,
	kind: &str,
	label: &str,
	target: &str,
	ok: bool,
	detail: &str,
) {
	let entry = JournalEntry {
		at: now(),
		project: crate::config::Config::load().active_project,
		kind: kind.to_string(),
		label: label.to_string(),
		target: target.to_string(),
		ok,
		// Une erreur entière noierait le carnet ; sa première ligne suffit.
		detail: detail.lines().next().unwrap_or_default().chars().take(300).collect(),
		actor: actor.to_string(),
		engagement: engagement.to_string(),
	};

	let Ok(line) = serde_json::to_string(&entry) else {
		return;
	};
	let _ = std::fs::create_dir_all(config_dir());
	if let Ok(mut file) = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(journal_path())
	{
		let _ = writeln!(file, "{line}");
	}
}

/// Entrées les plus récentes d'abord.
pub fn list(limit: usize) -> Vec<JournalEntry> {
	let Ok(raw) = std::fs::read_to_string(journal_path()) else {
		return Vec::new();
	};
	let mut entries: Vec<JournalEntry> = raw
		.lines()
		.filter(|line| !line.trim().is_empty())
		.filter_map(|line| serde_json::from_str(line).ok())
		.collect();

	// Le fichier ne se relit qu'en entier : autant profiter de la lecture pour
	// le ramener à sa taille utile.
	if entries.len() > MAX_ENTRIES {
		let kept = entries.split_off(entries.len() - MAX_ENTRIES);
		entries = kept;
		if let Ok(compacted) = entries
			.iter()
			.map(serde_json::to_string)
			.collect::<Result<Vec<_>, _>>()
		{
			let _ = std::fs::write(journal_path(), format!("{}\n", compacted.join("\n")));
		}
	}

	entries.reverse();
	entries.truncate(limit);
	entries
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Le journal d'une installation existante n'a pas d'acteur, et toutes ses
	/// lignes en avaient un : toi. Les relire autrement inventerait une
	/// Permanence là où il n'y en avait pas.
	#[test]
	fn une_entree_sans_acteur_se_relit_comme_humaine() {
		let raw = r#"{"at":1,"project":"cockpit","kind":"git","label":"Push","target":"main","ok":true,"detail":""}"#;
		let entry: JournalEntry = serde_json::from_str(raw).expect("relecture");
		assert_eq!(entry.actor, HUMAN);
		assert!(entry.engagement.is_empty());
	}

	#[test]
	fn un_acteur_declare_est_conserve() {
		let entry = JournalEntry {
			at: 1,
			project: "cockpit".into(),
			kind: "github".into(),
			label: "Création de PR".into(),
			target: "ci-412".into(),
			ok: true,
			detail: String::new(),
			actor: PERMANENCE.into(),
			engagement: "eng-7".into(),
		};
		let raw = serde_json::to_string(&entry).expect("écriture");
		let back: JournalEntry = serde_json::from_str(&raw).expect("relecture");
		assert_eq!(back.actor, PERMANENCE);
		assert_eq!(back.engagement, "eng-7");
	}
}
