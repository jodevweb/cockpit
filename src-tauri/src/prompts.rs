//! Bibliothèque de prompts pour lancer un agent sans le retaper.
//!
//! Les thèmes par défaut ne sont pas inventés : ils viennent du dépouillement
//! d'un historique réel de conversations (499 demandes humaines une fois
//! écartés les prompts de sous-agents et les relances) — tests et recette,
//! pull requests, commit/push, retours de revue, conflits.
//!
//! Leur formulation, en revanche, ne suppose aucun outillage : ni gestionnaire
//! de paquets, ni commande d'équipe, ni nom de branche, ni prestataire de
//! revue. Un prompt qui dirait « lance `pnpm code:fix` » serait faux partout
//! ailleurs que sur le poste qui l'a écrit ; chacun adapte les siens depuis
//! l'application.
//!
//! Les prompts vivent dans `~/.config/cockpit/prompts.toml`, éditable à la
//! main ou depuis l'app. Tant que le fichier n'existe pas, la liste par défaut
//! s'applique ; dès qu'il existe, il fait foi.

use crate::config::config_dir;
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Prompt {
	/// Stable : c'est la clé de mise à jour et de suppression.
	pub id: String,
	pub label: String,
	/// Regroupement d'affichage (« Livraison », « Revue »…).
	pub group: String,
	/// Ce qui sera envoyé à l'agent, tel quel.
	pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct Library {
	prompts: Vec<Prompt>,
}

fn library_path() -> PathBuf {
	config_dir().join("prompts.toml")
}

/// La consigne de rendu en images (identifiant `rendu`).
///
/// Elle ne part pas comme un message : elle s'ajoute aux consignes de l'agent
/// (voir `agent.rs`), pour qu'il sache dès son premier geste qu'une capture
/// « avant » se prend avant de toucher au code. Elle ne suppose ni navigateur,
/// ni outil, ni forme de dépôt : sans moyen de capturer, il le dit, et rien
/// d'autre ne change.
pub const VISUAL_TEMPLATE: &str = "Your report is looked at before it is read. The user steers \
several agents at once: they must understand what you did at a glance — the image first, the text \
second.

- Your conclusion starts with ONE sentence saying what is true now (\"The list fits on a phone \
screen.\"), not what you did. Details come after, as short as possible.
- If your task changes what is visible on screen and you can capture it (driven browser, screenshot \
tool, repository script): take a screenshot BEFORE touching the code, then one AFTER, of the same screen \
with the same framing. Store them in `.claude/work/rendu/` as `before-<subject>.png` and \
`after-<subject>.png`. On the after screenshot, place numbered markers with the `mcp__cockpit__illustrer` \
tool (genre `capture`): one marker per visible change, one sentence per marker.
- For everything else, `mcp__cockpit__illustrer` draws from your data. Pick the genre according to what \
you did: `frise` for a bug (the chain of events and the link that breaks), `avant_apres` for a \
refactor (what depends on what), `mesure` for an optimisation (numbers that came out of a command, with \
the command), `table` for a migration, `matrice` to compare options. One to three images, no more.
- Without that tool, a short ```mermaid block (twelve nodes at most) replaces `frise` and `avant_apres`.
- Cite each screenshot in your conclusion in Markdown: `![caption](path)`.
- Never invent an image or a number: no screenshot if you could not run the application, no \
measurement without a command, no decorative diagram. Say so in one sentence instead.
- For an answer to a question, a fix of a few lines, or a task with no visible or structural \
effect: no image, just the opening sentence and short text.

The list of modified files, the film of your work and your tests are already drawn from what \
Cockpit saw go by: do not redo them.";

/// La consigne de la liste d'étapes, jointe quand le pont du cockpit est là
/// pour porter son outil (voir `permissions.rs`).
///
/// Le CLI n'a plus d'outil de liste de tâches : sans celui-ci, rien ne dit où
/// en est un agent lancé depuis une heure, sinon qu'il tourne encore.
pub const STEPS_TEMPLATE: &str = "On any task of more than two steps, keep the list of your steps with \
the `mcp__cockpit__etapes` tool: set it before your first action, then call it again each time a step \
starts, ends, or you discover a new one. It is how the user sees where you are. \
Concrete steps, five to twelve, only one in progress at a time. For a question or a fix of \
a few lines: no list.";

/// La consigne de rendu en images telle que l'équipe l'a réglée, ou rien si
/// elle l'a coupée (`workflow.visual_reports`).
pub fn visual() -> Option<String> {
	if !crate::config::Config::active().workflow.visual_reports {
		return None;
	}
	let text = list()
		.into_iter()
		.find(|prompt| prompt.id == "rendu")
		.map(|prompt| prompt.text)
		.unwrap_or_else(|| VISUAL_TEMPLATE.to_string());
	Some(text).filter(|text| !text.trim().is_empty())
}

/// `group` et `label` sont des clés de catalogue : la bibliothèque par défaut
/// s'affiche dans la langue de l'utilisateur. Le texte, lui, part à l'agent :
/// il reste en anglais, comme tous les prompts.
fn prompt(id: &str, group: &str, label: &str, text: &str) -> Prompt {
	Prompt {
		id: id.into(),
		group: crate::i18n::t(group),
		label: crate::i18n::t(label),
		text: text.trim().into(),
	}
}

pub fn defaults() -> Vec<Prompt> {
	vec![
		// Les deux consignes du geste « Relire » (voir `review.rs`) : `{pr}`,
		// `{titre}`, `{auteur}`, `{branche}` et `{base}` y sont remplacés.
		prompt("revue", "prompts.group.review", "prompts.label.review", crate::review::REVIEW_TEMPLATE),
		prompt("revue-suivi", "prompts.group.review", "prompts.label.reviewFollowup", crate::review::FOLLOWUP_TEMPLATE),
		// Ajoutée aux consignes de chaque agent, jamais envoyée comme message
		// (voir `visual`).
		prompt("rendu", "prompts.group.visual", "prompts.label.visual", VISUAL_TEMPLATE),
		prompt(
			"ship",
			"prompts.group.delivery",
			"prompts.label.ship",
			"Run the checks the repository declares on what has been modified — formatting, \
			 types, tests. If everything passes, commit with a conventional message describing the \
			 change, then push. If something fails, fix it first and do not commit until \
			 it is green. Do not touch anything other than what is already modified.",
		),
		prompt(
			"review-then-ship",
			"prompts.group.delivery",
			"prompts.label.reviewThenShip",
			"Review the pending changes as a demanding reviewer would: correctness, edge \
			 cases, consistency with the rest of the repository. Address the justified remarks, dismiss the \
			 others saying why. Then run the project's checks again; if everything is \
			 green, commit and push.",
		),
		prompt(
			"open-pr",
			"prompts.group.delivery",
			"prompts.label.openPr",
			"Open the pull request for this branch: what changes, why, and the proof that it \
			 works. Link the ticket if there is one. First check that the branch is up to date with its \
			 base and that the checks pass locally.",
		),
		prompt(
			"review-comments",
			"prompts.group.review",
			"prompts.label.reviewComments",
			"Fetch the comments left on this branch's pull request — human as well as \
			 automated. For each one: apply the fix if it is relevant, otherwise reply \
			 explaining why you are not applying it. Resolve the threads you handled. \
			 Finish with a commit + push of the fixes.",
		),
		prompt(
			"pr-health",
			"prompts.group.review",
			"prompts.label.prHealth",
			"Take stock of this branch's pull request: continuous integration status, \
			 conflicts with its base, pending reviewers, unresolved comments, diff size. \
			 Tell me what is blocking the merge and in which order to handle it.",
		),
		prompt(
			"ci-red",
			"prompts.group.fixes",
			"prompts.label.ciRed",
			"Continuous integration is failing on this branch. Find which jobs fail, read the \
			 logs, identify the real cause (not the symptom) and fix it. \
			 Re-run the affected tests locally to check before pushing.",
		),
		prompt(
			"conflicts",
			"prompts.group.fixes",
			"prompts.label.conflicts",
			"Merge the base branch into this one and resolve the conflicts. For each conflict, \
			 keep the intent of both sides rather than overwriting. \
			 Then check that the build and the tests of the affected parts pass.",
		),
		prompt(
			"self-qa",
			"prompts.group.quality",
			"prompts.label.selfQa",
			"Verify on the evidence what was implemented on this branch: actually run the \
			 code and produce the proof (screenshots, API calls, adversarial cases) rather than a \
			 read-through. Report any gap with the expected behaviour.",
		),
		prompt(
			"conventions",
			"prompts.group.quality",
			"prompts.label.conventions",
			"Check that the modified files follow the repository's conventions, as its \
			 documentation and existing code establish them. \
			 Apply the obvious fixes, list the ones that need a decision.",
		),
		prompt(
			"tests",
			"prompts.group.quality",
			"prompts.label.tests",
			"Look at what this branch changes and tell me what is not covered by tests. \
			 Write the missing tests that have value (edge cases, possible regressions), \
			 not window-dressing tests. Run them to check that they pass.",
		),
		prompt(
			"prod-error",
			"prompts.group.investigation",
			"prompts.label.prodError",
			"Investigate this production error: reproduce it if possible, trace it back to the cause \
			 in the code, and propose a fix with its regression test. \
			 First check whether a ticket already exists for it.",
		),
		prompt(
			"ticket",
			"prompts.group.investigation",
			"prompts.label.ticket",
			"Implement the ticket matching this branch: read it, find what it touches, \
			 then proceed layer by layer — data, service, interface — checking at each step. \
			 Follow the repository's conventions.",
		),
	]
}

pub fn list() -> Vec<Prompt> {
	// Dès que le fichier existe, il fait foi — y compris vide : sinon supprimer
	// le dernier prompt ferait réapparaître toute la liste par défaut.
	match std::fs::read_to_string(library_path()) {
		Ok(raw) => toml::from_str::<Library>(&raw)
			.map(|library| library.prompts)
			.unwrap_or_else(|_| defaults()),
		Err(_) => defaults(),
	}
}

fn write(prompts: Vec<Prompt>) -> Result<Vec<Prompt>> {
	std::fs::create_dir_all(config_dir())
		.map_err(|e| CockpitError::msg(crate::i18n::tf("prompts.configFolderError", &[("error", &e)])))?;
	let raw = toml::to_string_pretty(&Library {
		prompts: prompts.clone(),
	})
	.map_err(|e| CockpitError::msg(crate::i18n::tf("prompts.serializeError", &[("error", &e)])))?;
	std::fs::write(library_path(), raw)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("prompts.writeError", &[("error", &e)])))?;
	Ok(prompts)
}

/// Crée ou remplace un prompt. Un `id` vide en fabrique un depuis le libellé.
pub fn save(mut prompt: Prompt) -> Result<Vec<Prompt>> {
	if prompt.label.trim().is_empty() || prompt.text.trim().is_empty() {
		return Err(CockpitError::msg(crate::i18n::t("prompts.labelAndTextRequired")));
	}
	if prompt.id.trim().is_empty() {
		prompt.id = slug(&prompt.label);
	}
	if prompt.group.trim().is_empty() {
		prompt.group = crate::i18n::t("prompts.group.mine");
	}

	let mut prompts = list();
	match prompts.iter_mut().find(|existing| existing.id == prompt.id) {
		Some(existing) => *existing = prompt,
		None => prompts.push(prompt),
	}
	write(prompts)
}

pub fn remove(id: &str) -> Result<Vec<Prompt>> {
	let mut prompts = list();
	prompts.retain(|prompt| prompt.id != id);
	write(prompts)
}

/// Remet la bibliothèque livrée avec l'app.
pub fn reset() -> Result<Vec<Prompt>> {
	write(defaults())
}

/// Identifiant lisible tiré du libellé (`Commit + push` → `commit-push`).
fn slug(label: &str) -> String {
	let mut out = String::new();
	let mut last_dash = true;
	for c in label.to_lowercase().chars() {
		if c.is_ascii_alphanumeric() {
			out.push(c);
			last_dash = false;
		} else if !last_dash {
			out.push('-');
			last_dash = true;
		}
	}
	out.trim_matches('-').to_string()
}
