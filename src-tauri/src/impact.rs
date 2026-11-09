//! Comprendre ce qu'un changement implique, pas le relire.
//!
//! Une revue de code dit si le code est bon. Ce module répond à une autre
//! question, celle qu'on se pose vraiment devant une branche qu'on n'a pas
//! écrite : *qu'est-ce que ça change, et pourquoi en est-on arrivé là ?* Ce
//! qu'un utilisateur verra, ce qui a provoqué ce travail, ce que les choix
//! techniques coûteront, ce qui risque de casser.
//!
//! Le travail se fait en deux temps, et la séparation est délibérée.
//!
//! 1. **Le dossier**, constitué sans agent : le diff, les fichiers, les commits,
//!    la description, les échanges de revue. Rien d'interprété — que du fait,
//!    rassemblé à un seul endroit. Cette étape marche même pour un dépôt qui
//!    n'est pas cloné sur ce poste.
//! 2. **La lecture**, confiée à un agent qui ne peut rien écrire. Il reçoit le
//!    dossier et, quand le dépôt est là, la liberté d'aller voir le code autour
//!    — c'est toute la différence entre « le diff dit » et « ça implique ».
//!
//! Ce que l'agent rend n'est pas cru sur parole : le cockpit le relit et en tire
//! des sections, des risques et un verdict. Un rapport qui ne respecterait aucune
//! des formes attendues s'affiche tel quel plutôt que de disparaître — mieux vaut
//! un texte brut qu'un écran vide.
//!
//! Enfin, une analyse est scellée au SHA de tête. La branche bouge, l'analyse
//! devient un souvenir : c'est ce qui l'empêche de devenir un mensonge au bout
//! d'une semaine.

use crate::config::{config_dir, Config};
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Ce qu'une analyse laisse voir depuis la liste.
///
/// Volontairement plat et court : c'est ce que porte une carte, et une carte se
/// lit sans ouvrir quoi que ce soit.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
	pub key: String,
	/// Tête de la branche au moment de la lecture — le sceau de fraîcheur.
	#[serde(default)]
	pub head_sha: String,
	/// Date de la lecture, en secondes epoch.
	#[serde(default)]
	pub at: u64,
	/// `faible` · `moyen` · `élevé` — ce que l'agent a annoncé, normalisé.
	#[serde(default)]
	pub risk: String,
	/// `ok` · `réserves` · `bloquant`, lu comme le cockpit lit les verdicts de
	/// recette : sur l'intention, pas sur la forme.
	#[serde(default)]
	pub verdict: String,
	/// La phrase en clair : ce que ça change, pour quelqu'un qui n'a pas lu le
	/// code. C'est elle qui s'affiche sur la carte.
	#[serde(default)]
	pub headline: String,
	#[serde(default)]
	pub risk_count: usize,
	#[serde(default)]
	pub check_count: usize,
	#[serde(default)]
	pub duration_seconds: u64,
	#[serde(default)]
	pub cost_usd: f64,
	#[serde(default)]
	pub engine: String,
	#[serde(default)]
	pub model: String,
}

/// Un point d'une section : une ligne de liste, avec sa gravité quand elle en a.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Point {
	pub text: String,
	/// `critical` · `warning` · `info` · `neutral`.
	pub severity: String,
}

/// Un bloc du rapport.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Section {
	/// Identifiant reconnu (`produit`, `pourquoi`, `choix`, `risques`,
	/// `verifier`, `mieux`) ou `autre` quand le titre ne dit rien de connu.
	pub id: String,
	pub title: String,
	/// Le texte du bloc, hors listes.
	#[serde(default)]
	pub body: String,
	#[serde(default)]
	pub points: Vec<Point>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
	#[serde(flatten)]
	pub summary: Summary,
	/// Ce qu'on analysait, pour que la fiche reste lisible seule.
	#[serde(default)]
	pub title: String,
	#[serde(default)]
	pub branch: String,
	#[serde(default)]
	pub url: String,
	#[serde(default)]
	pub sections: Vec<Section>,
	/// Le rapport complet, pour qui veut tout lire.
	#[serde(default)]
	pub raw: String,
	/// Chemin du dossier factuel envoyé à l'agent, gardé pour pouvoir vérifier
	/// sur quoi il a conclu.
	#[serde(default)]
	pub brief_path: String,
}

// ── Où vivent les analyses ──────────────────────────────────────────────────

fn impact_dir() -> PathBuf {
	config_dir().join("impact")
}

/// Nom de fichier pour une clé : `github:acme/repo#412` ne peut pas en être un.
fn slug(key: &str) -> String {
	key.chars()
		.map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
		.collect()
}

fn path_of(key: &str) -> PathBuf {
	impact_dir().join(format!("{}.json", slug(key)))
}

/// Le dossier de faits, à côté de l'analyse qu'il a nourrie.
fn brief_path_of(key: &str) -> PathBuf {
	impact_dir().join(format!("{}.md", slug(key)))
}

/// L'analyse gardée pour cette clé, s'il y en a une.
pub fn read(key: &str) -> Option<Analysis> {
	let raw = std::fs::read_to_string(path_of(key)).ok()?;
	serde_json::from_str(&raw).ok()
}

/// Le résumé seul — ce que le recensement pose sur les cartes.
pub fn summary(key: &str) -> Option<Summary> {
	read(key).map(|analysis| analysis.summary)
}

fn write(analysis: &Analysis) -> Result<()> {
	std::fs::create_dir_all(impact_dir())
		.map_err(|e| CockpitError::msg(crate::i18n::tf("impact.errors.folder", &[("error", &e)])))?;
	let raw = serde_json::to_string_pretty(analysis)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("impact.errors.unreadable", &[("error", &e)])))?;
	std::fs::write(path_of(&analysis.summary.key), raw)
		.map_err(|e| CockpitError::msg(crate::i18n::tf("impact.errors.write", &[("error", &e)])))
}

/// Oublie une analyse — et le dossier qui l'a nourrie.
pub fn forget(key: &str) -> Result<()> {
	let _ = std::fs::remove_file(path_of(key));
	let _ = std::fs::remove_file(brief_path_of(key));
	Ok(())
}

// ── Ce qui tourne en ce moment ──────────────────────────────────────────────

/// Les clés en cours d'analyse.
///
/// Une analyse dure des minutes : sans ce registre, rien n'empêcherait d'en
/// lancer trois sur la même pull request en cliquant trois fois, et l'écran
/// n'aurait aucun moyen de dire que la première travaille encore.
fn running() -> &'static Mutex<std::collections::HashSet<String>> {
	static RUNNING: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
		std::sync::OnceLock::new();
	RUNNING.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

pub fn in_progress() -> Vec<String> {
	running()
		.lock()
		.map(|set| set.iter().cloned().collect())
		.unwrap_or_default()
}

/// Marqueur sur disque d'une lecture commencée.
///
/// Le registre ci-dessus vit en mémoire : il disparaît avec le cockpit, et une
/// lecture interrompue par sa fermeture ne laissait alors rien du tout — ni
/// résultat, ni trace, ni message. On l'apprenait en revenant sur l'écran et en
/// ne trouvant pas l'analyse qu'on croyait lancée.
fn running_marker(key: &str) -> PathBuf {
	impact_dir().join(format!("{}.running", slug(key)))
}

fn claim(key: &str) -> bool {
	let pris = running()
		.lock()
		.map(|mut set| set.insert(key.to_string()))
		.unwrap_or(false);
	if pris {
		let _ = std::fs::create_dir_all(impact_dir());
		let _ = std::fs::write(running_marker(key), key);
	}
	pris
}

fn release(key: &str) {
	if let Ok(mut set) = running().lock() {
		set.remove(key);
	}
	let _ = std::fs::remove_file(running_marker(key));
}

/// Au démarrage : dire ce qu'une fermeture a interrompu.
///
/// L'agent d'analyse meurt avec le cockpit — il est lancé pour rendre une seule
/// réponse, et son processus est rattaché au nôtre. Ce qui restait, jusqu'ici,
/// c'était un écran qui affichait « pas encore lu » sans jamais dire qu'une
/// lecture avait été commencée et perdue. On le note au journal, où l'on va
/// chercher ce que le cockpit a fait en son nom.
pub fn report_interrupted() {
	let Ok(entries) = std::fs::read_dir(impact_dir()) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.extension().is_none_or(|extension| extension != "running") {
			continue;
		}
		let key = std::fs::read_to_string(&path).unwrap_or_default();
		crate::journal::record(
			"impact",
			&crate::i18n::t("impact.interrupted.label"),
			key.trim(),
			false,
			&crate::i18n::t("impact.interrupted.detail"),
		);
		let _ = std::fs::remove_file(path);
	}
}

// ── Le dossier ──────────────────────────────────────────────────────────────

/// Au-delà, on tronque le diff envoyé à l'agent.
///
/// Un diff de refonte fait des centaines de milliers de caractères, dont la
/// lecture intégrale coûte cher pour un gain nul : passé un certain volume, ce
/// qui compte se lit dans la liste des fichiers et dans le code, pas dans le
/// diff ligne à ligne. La troncature est dite à l'agent, qui sait alors qu'il
/// doit aller voir dans le dépôt.
const MAX_DIFF_CHARS: usize = 180_000;

/// Rassemble les faits, sans agent et sans interprétation.
///
/// Partagé avec la confrontation : trois lectures d'un même changement doivent
/// partir des mêmes faits, sinon leur désaccord ne dit plus rien — on ne saurait
/// pas s'ils divergent sur le fond ou parce qu'ils n'ont pas lu la même chose.
pub(crate) async fn dossier(change: &crate::monitor::Change, config: &Config) -> Result<String> {
	let mut out = String::new();
	out.push_str(&format!("# {}\n\n", change.title));
	out.push_str(&format!(
		"- Repository: {} ({})\n- Branch: {} → {}\n- Author: {}\n",
		change.repo,
		change.forge,
		change.branch,
		change.base,
		if change.author.is_empty() {
			"unknown"
		} else {
			&change.author
		}
	));
	if !change.url.is_empty() {
		out.push_str(&format!("- URL: {}\n", change.url));
	}
	if !change.labels.is_empty() {
		out.push_str(&format!(
			"- Labels: {}\n",
			change
				.labels
				.iter()
				.map(|label| label.label.clone())
				.collect::<Vec<_>>()
				.join(", ")
		));
	}
	out.push_str(&format!(
		"- Continuous integration status: {}\n",
		match change.ci.as_str() {
			"success" => "passing",
			"failing" => "failing",
			"pending" => "running",
			_ => "unknown or missing",
		}
	));
	if change.forge == "local" {
		out.push_str(
			"- No merge request has been opened: this work exists only on this branch.\n",
		);
	}
	out.push('\n');

	let diff = match change.forge.as_str() {
		"github" => {
			let conversation = crate::integrations::github_pull_conversation(
				config,
				change.reference.trim_start_matches('#'),
			)
			.await
			.ok();
			if let Some(conversation) = &conversation {
				out.push_str(&github_conversation(conversation));
			}
			crate::integrations::github_pull_diff(
				config,
				change.reference.trim_start_matches('#'),
			)
			.await?
		}
		"gitlab" => {
			crate::integrations::gitlab_merge_request_diff(
				config,
				change.reference.trim_start_matches('!'),
			)
			.await?
		}
		_ => {
			let repo = PathBuf::from(&change.repo_path);
			let merge_base =
				crate::git::run_git(&repo, &["merge-base", &change.base, &change.branch])
					.await
					.map(|raw| raw.trim().to_string())
					.unwrap_or_else(|_| change.base.clone());
			crate::git::run_git(&repo, &["diff", &merge_base, &change.branch]).await?
		}
	};

	// Le ticket dit ce qui était demandé ; le diff ne dit que ce qui a été fait.
	// Sans lui, l'analyse ne pouvait pas répondre à « pourquoi maintenant »
	// autrement qu'en le devinant, ni voir qu'un changement passe à côté de sa
	// demande. Un ticket illisible ne fait pas échouer la lecture : elle
	// continue sur ce qu'elle a, comme avant.
	match crate::brief::ticket_markdown(config, &change.branch).await {
		Ok(Some((_, _, markdown))) => {
			out.push_str(&markdown);
			out.push('\n');
		}
		Ok(None) => {}
		Err(reason) => {
			out.push_str(&format!(
				"> This branch's ticket could not be read ({reason}). What follows therefore does \
				 not say what was asked for.\n\n"
			));
		}
	}

	// Les commits racontent l'ordre dans lequel le travail s'est fait — souvent
	// la meilleure trace du « pourquoi ».
	if !change.repo_path.is_empty() {
		let repo = PathBuf::from(&change.repo_path);
		if let Ok(log) = crate::git::run_git(
			&repo,
			&[
				"log",
				"--format=- %s (%an)",
				"--no-merges",
				&format!("{}..{}", change.base, change.branch),
			],
		)
		.await
		{
			if !log.trim().is_empty() {
				out.push_str("## Branch commits\n\n");
				out.push_str(log.trim());
				out.push_str("\n\n");
			}
		}
	}

	out.push_str("## Diff\n\n```diff\n");
	if diff.len() > MAX_DIFF_CHARS {
		out.push_str(&diff.chars().take(MAX_DIFF_CHARS).collect::<String>());
		out.push_str(
			"\n```\n\n> The diff was cut here, it is too large to be read in full. Read the \
			 affected files in the repository for what is missing.\n",
		);
	} else {
		out.push_str(&diff);
		out.push_str("\n```\n");
	}

	Ok(out)
}

/// La description et les échanges d'une pull request GitHub, mis à plat.
fn github_conversation(conversation: &serde_json::Value) -> String {
	let mut out = String::new();
	let body = conversation
		.pointer("/detail/body")
		.and_then(|v| v.as_str())
		.unwrap_or_default()
		.trim();
	if !body.is_empty() {
		out.push_str("## Description as written\n\n");
		out.push_str(body);
		out.push_str("\n\n");
	}

	let mut echanges = Vec::new();
	for (pointer, kind) in [("/reviews", "review"), ("/comments", "comment")] {
		if let Some(list) = conversation.pointer(pointer).and_then(|v| v.as_array()) {
			for entry in list {
				let text = entry
					.get("body")
					.and_then(|v| v.as_str())
					.unwrap_or_default()
					.trim();
				if text.is_empty() {
					continue;
				}
				let author = entry
					.pointer("/user/login")
					.and_then(|v| v.as_str())
					.unwrap_or("someone");
				let state = entry
					.get("state")
					.and_then(|v| v.as_str())
					.unwrap_or_default();
				echanges.push(format!(
					"- **{author}** ({kind}{}): {}",
					if state.is_empty() {
						String::new()
					} else {
						format!(", {}", state.to_lowercase())
					},
					text.chars().take(1200).collect::<String>()
				));
			}
		}
	}
	if !echanges.is_empty() {
		out.push_str("## What was said\n\n");
		out.push_str(&echanges.join("\n"));
		out.push_str("\n\n");
	}
	out
}

// ── La consigne ─────────────────────────────────────────────────────────────

/// Ce qu'on demande à l'agent.
///
/// La consigne est longue à dessein, et tout y sert. Sans elle, un agent à qui
/// l'on tend un diff produit ce qu'on lui a appris à produire : une revue de
/// code. Or une revue répond à « est-ce bien écrit », quand la question posée
/// ici est « qu'est-ce que ça change ». Chaque interdiction ci-dessous corrige
/// une dérive observée : le jargon, la paraphrase du diff, la liste de
/// remarques de style, le « il faudrait peut-être » sans conséquence nommée.
fn consigne(dossier: &str, brief: &str) -> String {
	let mut prompt = String::new();
	prompt.push_str(
		"You are reading a code change for someone who decides, not for someone who codes.\n\
		 This person knows the product but not this diff. They want to understand what this \
		 change implies, and walk away knowing what to do.\n\n\
		 You are not doing a code review. Do not point out questions of style, naming or \
		 formatting. Do not paraphrase the diff: \"adds a function X\" teaches nobody anything. \
		 Every sentence must state a consequence, a reason or a risk.\n\n\
		 Write in plain everyday language. No jargon when an ordinary word exists. If a technical \
		 term is unavoidable, explain it in three words in parentheses. No superlatives, no \
		 \"it is advisable to\", no hollow conclusion.\n\n\
		 You are in the repository: go read the code around the diff. That is what will let you \
		 say what this change really implies, and not only what it shows. You cannot modify \
		 anything, and that is not what you are asked to do.\n\n",
	);
	prompt.push_str(&crate::i18n::reply_directive());
	prompt.push_str("\n\n");

	if !brief.trim().is_empty() {
		prompt.push_str("## What this product does\n\n");
		prompt.push_str(brief.trim());
		prompt.push_str("\n\n");
	}

	prompt.push_str(
		"## The report you must return\n\n\
		 Return exactly these sections, in this order, with these titles. Nothing before, nothing \
		 after. Keep the section titles, the `[high]`/`[medium]`/`[low]` tags and the `Verdict:` \
		 and `Risk:` lines in English exactly — only the text under them follows the language \
		 instruction.\n\n\
		 ## In plain words\n\
		 One or two sentences, no more. What someone who uses the product will see change. If \
		 nothing changes for them, say so and say what it changes for the team.\n\n\
		 ## Why now\n\
		 What triggered this work: a bug suffered, a limit reached, a request, a debt that was \
		 blocking something else. Rely on the ticket, the commits, the description and the \
		 discussion. If you cannot know, say so frankly rather than inventing a plausible \
		 reason.\n\
		 If the dossier contains a ticket and the change departs from it — it does less, more, or \
		 something else — say so here in one sentence. That is the gap a reviewer does not see \
		 when they only have the diff in front of them.\n\n\
		 ## Choices made\n\
		 The technical decisions that commit what comes next, and what they cost. For each one: \
		 what was chosen, over what, and what it implies six months from now. Ignore decisions \
		 without consequence.\n\n\
		 ## What can break\n\
		 One bullet per risk, the most serious first. Start each bullet with [high], [medium] or \
		 [low], then describe the concrete scenario: which situation, which resulting behavior. \
		 A risk without a scenario is not a risk, it is an impression — do not write it. If there \
		 are none, write \"Nothing found.\" and explain in one sentence why the change is \
		 safe.\n\n\
		 ## Check before merging\n\
		 One bullet per check, phrased as an action one can take: what to open, what to try, \
		 what to look at. Not \"test the flow\" but the precise flow, with the case that would \
		 break it.\n\n\
		 ## What could be better\n\
		 Possible improvements, kept apart from the rest because they do not block. Nothing \
		 mandatory here: if there is nothing useful to say, say so in one line.\n\n\
		 ## Verdict\n\
		 A single line, exactly in this form:\n\
		 `Verdict: ok` if it can ship as is, `Verdict: concerns` if things must be checked \
		 first, `Verdict: blocking` if merging as is would cause a problem.\n\
		 Then a second line: `Risk: low`, `Risk: medium` or `Risk: high`, depending on what \
		 this change puts at stake.\n\n\
		 ## The dossier\n\n",
	);
	prompt.push_str(dossier);
	prompt
}

// ── La lecture ──────────────────────────────────────────────────────────────

/// Analyse un changement et garde le résultat.
///
/// Le changement est retrouvé par un recensement du seul projet concerné plutôt
/// que reçu de l'interface : ce qu'on analyse doit venir de la forge, pas de ce
/// que l'écran croit savoir. Le recensement qui vient d'alimenter la liste est
/// encore en mémoire courte, l'appel est donc gratuit.
pub async fn analyze(key: String) -> Result<Analysis> {
	if !claim(&key) {
		return Err(CockpitError::msg(crate::i18n::t("impact.errors.alreadyRunning")));
	}
	// Quoi qu'il arrive ensuite, la clé doit être libérée : une erreur qui
	// laisserait le verrou posé rendrait le changement inanalysable jusqu'au
	// redémarrage.
	let outcome = analyze_inner(&key).await;
	release(&key);
	outcome
}

async fn analyze_inner(key: &str) -> Result<Analysis> {
	let project = project_of(key);
	let scan = crate::monitor::scan(project.as_deref()).await?;
	let change = scan
		.changes
		.into_iter()
		.find(|change| change.key == key)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("impact.errors.changeGone")))?;

	let base = Config::load();
	let cloisonne = base.projects.len() > 1;
	let mut config = base.clone();
	if let Some(project) = base.projects.iter().find(|p| p.id == change.project) {
		project.merge_into(&mut config, cloisonne);
	}

	let dossier = dossier(&change, &config).await?;
	let brief_path = brief_path_of(key);
	let _ = std::fs::create_dir_all(impact_dir());
	let _ = std::fs::write(&brief_path, &dossier);

	// Le worktree d'abord : c'est là que le code de la branche est réellement
	// sorti, donc le seul endroit où lire autour du diff a un sens. À défaut le
	// dépôt principal, qui a au moins l'historique. À défaut encore, le dossier
	// d'analyse — l'agent n'aura que le dossier, et c'est mieux que rien.
	let cwd = [
		change.worktree.clone(),
		change.repo_path.clone(),
		impact_dir().to_string_lossy().to_string(),
	]
	.into_iter()
	.find(|candidate| !candidate.is_empty() && std::path::Path::new(candidate).is_dir())
	.ok_or_else(|| CockpitError::msg(crate::i18n::t("impact.errors.noWorkdir")))?;

	let settings = &config.impact;
	let rendu = crate::agent::run_once(
		&cwd,
		&consigne(&dossier, &settings.brief),
		&settings.engine,
		&settings.model,
		&settings.depth,
		// Un agent qui comprend n'écrit pas. Le lui interdire vaut mieux que
		// compter sur sa bonne volonté : il travaille dans un worktree qui
		// contient du travail en cours, et personne ne relit ce qu'il ferait.
		&["Write", "Edit", "MultiEdit", "NotebookEdit"],
		crate::executions::Origin::cockpit("impact"),
	)
	.await?;

	let mut analysis = parse(&rendu.text);
	analysis.summary.key = key.to_string();
	analysis.summary.head_sha = change.head_sha.clone();
	analysis.summary.at = now();
	analysis.summary.duration_seconds = rendu.duration_ms / 1000;
	analysis.summary.cost_usd = rendu.cost_usd;
	analysis.summary.engine = crate::config::engine_for(&config, &settings.engine).label;
	analysis.summary.model = settings.model.clone();
	analysis.title = change.title.clone();
	analysis.branch = change.branch.clone();
	analysis.url = change.url.clone();
	analysis.brief_path = brief_path.to_string_lossy().to_string();

	write(&analysis)?;
	crate::journal::record(
		"impact",
		&crate::i18n::t("impact.journal.analysis"),
		&format!("{} {}", change.repo, change.reference),
		true,
		&analysis.summary.headline,
	);
	Ok(analysis)
}

/// Le projet d'où vient une clé, quand elle le dit.
///
/// Seules les clés locales portent l'identifiant du projet ; pour les autres, on
/// balaie tout — c'est le prix d'une clé lisible.
fn project_of(key: &str) -> Option<String> {
	key.strip_prefix("local:")
		.and_then(|rest| rest.split('@').next())
		.map(|id| id.to_string())
}

fn now() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0)
}

// ── Relire ce que l'agent a écrit ───────────────────────────────────────────

/// Les titres qu'on sait reconnaître, et ce qu'ils désignent.
///
/// Reconnus par mot-clé et non par égalité : un agent qui écrit « Ce qui peut
/// casser (régressions) » ou « What can break » dit la même chose, et un
/// rapport ne doit pas se perdre parce qu'un titre a pris un complément.
const TITRES: [(&str, &[&str]); 6] = [
	("produit", &["en clair", "in plain", "plain english"]),
	("pourquoi", &["pourquoi", "why"]),
	("choix", &["choix", "choices", "decisions", "décisions"]),
	("risques", &["casser", "risque", "risk", "break", "regress"]),
	("verifier", &["vérifier", "verifier", "check", "before merg"]),
	("mieux", &["mieux", "améliorer", "ameliorer", "better", "improve"]),
];

fn section_id(titre: &str) -> String {
	let bas = titre.to_lowercase();
	TITRES
		.iter()
		.find(|(_, cles)| cles.iter().any(|cle| bas.contains(cle)))
		.map(|(id, _)| id.to_string())
		.unwrap_or_else(|| "autre".into())
}

/// La gravité annoncée en tête de puce, quand il y en a une.
///
/// L'agent est prié d'écrire `[élevé]`, mais il écrit aussi `**Élevé** :` ou
/// `(high)` selon l'humeur du modèle. On regarde les premiers caractères de la
/// puce et on y cherche le mot, décoration comprise.
fn severity_of(ligne: &str) -> (String, String) {
	let debut: String = ligne.chars().take(24).collect::<String>().to_lowercase();
	let (severite, marqueurs): (&str, &[&str]) = if debut.contains("élevé")
		|| debut.contains("eleve")
		|| debut.contains("high")
		|| debut.contains("critique")
	{
		("critical", &["élevé", "eleve", "high", "critique"])
	} else if debut.contains("moyen") || debut.contains("medium") {
		("warning", &["moyen", "medium"])
	} else if debut.contains("faible") || debut.contains("low") {
		("info", &["faible", "low"])
	} else {
		return ("neutral".into(), ligne.trim().to_string())
	};

	// La marque enlevée, la puce doit se lire seule : la gravité s'affiche par
	// la couleur, la répéter en toutes lettres vole une ligne pour rien.
	let mut reste = ligne.to_string();
	for marqueur in marqueurs {
		let bas = reste.to_lowercase();
		if let Some(position) = bas.find(marqueur) {
			let fin = position + marqueur.len();
			reste = format!("{}{}", &reste[..position], &reste[fin..]);
			break;
		}
	}
	let nettoye = reste
		.trim()
		.trim_start_matches(['[', ']', '(', ')', '*', '_', ':', '-', ' '])
		.trim_start_matches(['[', ']', '(', ')', '*', '_', ':', '-', ' '])
		.trim()
		.to_string();
	(
		severite.into(),
		if nettoye.is_empty() {
			ligne.trim().to_string()
		} else {
			nettoye
		},
	)
}

/// Découpe le rapport en sections lisibles.
///
/// Tolérant par construction : un rapport qui n'aurait aucun titre reconnu
/// ressort en une seule section `autre`, et l'écran l'affiche tel quel. Perdre
/// le texte parce qu'il n'a pas la bonne forme serait le pire des deux mondes —
/// l'analyse a été payée, autant la lire.
pub fn parse(rapport: &str) -> Analysis {
	let mut analysis = Analysis {
		raw: rapport.trim().to_string(),
		..Default::default()
	};

	let mut courante: Option<Section> = None;
	let mut corps: Vec<String> = Vec::new();

	let cloture = |analysis: &mut Analysis, section: Option<Section>, corps: &mut Vec<String>| {
		if let Some(mut section) = section {
			section.body = corps.join("\n").trim().to_string();
			if !section.body.is_empty() || !section.points.is_empty() {
				analysis.sections.push(section);
			}
		}
		corps.clear();
	};

	for ligne in rapport.lines() {
		let taille = ligne.trim_start();

		if let Some(titre) = taille.strip_prefix("## ").or(taille.strip_prefix("### ")) {
			let titre = titre.trim().trim_matches(['*', '#', ':']).trim();
			cloture(&mut analysis, courante.take(), &mut corps);
			courante = Some(Section {
				id: section_id(titre),
				title: titre.to_string(),
				..Default::default()
			});
			continue;
		}

		// Le verdict et le niveau de risque se lisent où qu'ils soient : certains
		// modèles les posent sous un titre, d'autres en dernière ligne.
		if let Some(valeur) = ligne_de(taille, "verdict") {
			analysis.summary.verdict = normalise_verdict(&valeur);
			continue;
		}
		if let Some(valeur) = ligne_de(taille, "risque").or_else(|| ligne_de(taille, "risk")) {
			if let Some(niveau) = normalise_risque(&valeur) {
				analysis.summary.risk = niveau;
				continue;
			}
		}

		let Some(section) = courante.as_mut() else {
			// Du texte avant le premier titre : c'est souvent le résumé, qu'on
			// garde plutôt que de le jeter.
			if !taille.is_empty() {
				corps.push(ligne.to_string());
			}
			continue;
		};

		if let Some(puce) = taille
			.strip_prefix("- ")
			.or(taille.strip_prefix("* "))
			.or_else(|| {
				taille
					.split_once(". ")
					.filter(|(tete, _)| tete.chars().all(|c| c.is_ascii_digit()))
					.map(|(_, reste)| reste)
			}) {
			let (severity, text) = if section.id == "risques" {
				severity_of(puce)
			} else {
				("neutral".into(), puce.trim().to_string())
			};
			if !text.is_empty() {
				section.points.push(Point { text, severity });
			}
			continue;
		}

		corps.push(ligne.to_string());
	}
	cloture(&mut analysis, courante.take(), &mut corps);

	// Si aucun titre n'a été reconnu, le texte d'ouverture est tout ce qu'on a.
	if analysis.sections.is_empty() && !analysis.raw.is_empty() {
		analysis.sections.push(Section {
			id: "autre".into(),
			title: crate::i18n::t("impact.rawReportTitle"),
			body: analysis.raw.clone(),
			points: Vec::new(),
		});
	}

	let section = |id: &str| analysis.sections.iter().find(|section| section.id == id);
	analysis.summary.headline = section("produit")
		.map(|section| {
			if section.body.trim().is_empty() {
				section
					.points
					.iter()
					.map(|point| point.text.clone())
					.collect::<Vec<_>>()
					.join(" ")
			} else {
				section.body.clone()
			}
		})
		.unwrap_or_default()
		.replace('\n', " ")
		.trim()
		.to_string();
	analysis.summary.risk_count = section("risques")
		.map(|section| {
			// « Rien de repéré » est une phrase, pas un risque : une section qui
			// conclut à l'absence de risque ne doit pas en afficher un.
			section
				.points
				.iter()
				.filter(|point| point.severity != "neutral" || point.text.len() > 40)
				.count()
		})
		.unwrap_or(0);
	analysis.summary.check_count = section("verifier")
		.map(|section| section.points.len())
		.unwrap_or(0);

	// Un verdict absent se déduit de ce qui a été trouvé, plutôt que de laisser
	// la carte muette : des risques élevés sans verdict, c'est au minimum des
	// réserves.
	if analysis.summary.verdict.is_empty() {
		let grave = section("risques").is_some_and(|section| {
			section
				.points
				.iter()
				.any(|point| point.severity == "critical")
		});
		analysis.summary.verdict = if grave || analysis.summary.risk_count > 0 {
			"réserves".into()
		} else {
			"ok".into()
		};
	}
	if analysis.summary.risk.is_empty() {
		analysis.summary.risk = match analysis.summary.verdict.as_str() {
			"bloquant" => "élevé".into(),
			"réserves" => "moyen".into(),
			_ => "faible".into(),
		};
	}

	analysis
}

/// `Verdict: ok`, `**Verdict :** OK`, `- verdict = bloquant`…
fn ligne_de(ligne: &str, mot: &str) -> Option<String> {
	let nu: String = ligne
		.chars()
		.filter(|c| !matches!(c, '*' | '`' | '#' | '>' | '_' | '|'))
		.collect();
	let nu = nu.trim().trim_start_matches(['-', ' ']).to_lowercase();
	let reste = nu.strip_prefix(mot)?;
	let valeur = reste
		.trim_start_matches([':', '=', ' ', '\u{a0}'])
		.trim()
		.to_string();
	// Sans séparateur, « risquez » commencerait par « risque » : on exige que le
	// mot soit suivi d'une ponctuation ou d'un espace, donc que le reste ait été
	// effectivement rogné.
	if reste.len() == valeur.len() && !valeur.is_empty() {
		return None;
	}
	Some(valeur)
}

fn normalise_verdict(valeur: &str) -> String {
	let mot = valeur.split_whitespace().next().unwrap_or("");
	match mot {
		m if m.starts_with("bloqu") || m.starts_with("block") => "bloquant".into(),
		m if m.starts_with("réserve")
			|| m.starts_with("reserve")
			|| m.starts_with("concern") =>
		{
			"réserves".into()
		}
		m if m.starts_with("ok") || m.starts_with("pass") || m.starts_with("clean") => "ok".into(),
		_ => String::new(),
	}
}

fn normalise_risque(valeur: &str) -> Option<String> {
	let mot = valeur.split_whitespace().next().unwrap_or("");
	match mot {
		m if m.starts_with("élev") || m.starts_with("elev") || m.starts_with("high") => {
			Some("élevé".into())
		}
		m if m.starts_with("moyen") || m.starts_with("medium") => Some("moyen".into()),
		m if m.starts_with("faible") || m.starts_with("low") => Some("faible".into()),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const RAPPORT: &str = "## En clair\n\
		Les points de fidélité ne sont plus perdus quand une commande échoue : ils reviennent au compte.\n\n\
		## Pourquoi maintenant\n\
		Trois clients ont signalé la perte en deux semaines.\n\n\
		## Les choix faits\n\
		- Reprise par file d'attente plutôt qu'en direct, pour survivre à une panne du \
		fournisseur.\n\n\
		## Ce qui peut casser\n\
		- [élevé] Un double remboursement si le webhook arrive deux fois.\n\
		- [faible] Le libellé du reçu n'est pas traduit.\n\n\
		## À vérifier avant de fusionner\n\
		- Rejouer un webhook déjà traité et vérifier qu'aucun point n'est ajouté.\n\n\
		## Verdict\n\
		Verdict: réserves\n\
		Risque: moyen\n";

	#[test]
	fn lit_les_sections_et_le_verdict() {
		let analysis = parse(RAPPORT);
		assert_eq!(analysis.summary.verdict, "réserves");
		assert_eq!(analysis.summary.risk, "moyen");
		assert!(analysis.summary.headline.starts_with("Les points de fidélité"));
		assert_eq!(analysis.summary.risk_count, 2);
		assert_eq!(analysis.summary.check_count, 1);

		let risques = analysis
			.sections
			.iter()
			.find(|section| section.id == "risques")
			.expect("section des risques");
		assert_eq!(risques.points[0].severity, "critical");
		// La marque de gravité est retirée du texte : la couleur la porte déjà.
		assert!(risques.points[0].text.starts_with("Un double remboursement"));
		assert_eq!(risques.points[1].severity, "info");
	}

	#[test]
	fn reconnait_les_titres_anglais_et_decores() {
		let analysis = parse(
			"## **Why now**\nParce que.\n\n## What can break\n- [high] Ça casse.\n",
		);
		assert_eq!(analysis.sections[0].id, "pourquoi");
		assert_eq!(analysis.sections[1].id, "risques");
		assert_eq!(analysis.sections[1].points[0].severity, "critical");
	}

	#[test]
	fn un_rapport_sans_forme_reste_lisible() {
		// Le pire cas : l'agent ignore la consigne. On préfère afficher son texte
		// brut plutôt qu'un écran vide sur une analyse déjà payée.
		let analysis = parse("Ça change la facturation, et rien d'autre.");
		assert_eq!(analysis.sections.len(), 1);
		assert_eq!(analysis.sections[0].id, "autre");
		assert!(analysis.sections[0].body.contains("facturation"));
	}

	#[test]
	fn un_verdict_absent_se_deduit_des_risques() {
		let analysis = parse("## Ce qui peut casser\n- [élevé] Les paiements peuvent doubler.\n");
		assert_eq!(analysis.summary.verdict, "réserves");
		assert_eq!(analysis.summary.risk, "moyen");
	}

	#[test]
	fn aucun_risque_donne_un_verdict_ok() {
		let analysis = parse("## En clair\nRien ne change pour l'utilisateur.\n");
		assert_eq!(analysis.summary.verdict, "ok");
		assert_eq!(analysis.summary.risk, "faible");
	}

	#[test]
	fn le_mot_verdict_ne_se_confond_pas_avec_un_autre() {
		// « Risquez » commence par « risque » : sans séparateur exigé, la phrase
		// passait pour une déclaration de niveau et disparaissait du rapport.
		assert_eq!(ligne_de("Risquez de perdre des données", "risque"), None);
		assert_eq!(
			ligne_de("**Risque :** élevé", "risque").as_deref(),
			Some("élevé")
		);
	}

	/// Le rapport tel que la consigne anglaise le demande désormais : il doit se
	/// relire comme l'ancien rapport français, mêmes identifiants et mêmes
	/// valeurs gardées.
	#[test]
	fn lit_un_rapport_aux_marqueurs_anglais() {
		let analysis = parse(
			"## In plain words\n\
			 Loyalty points are no longer lost when an order fails.\n\n\
			 ## Why now\n\
			 Three customers reported it.\n\n\
			 ## Choices made\n\
			 - A queue rather than a direct call.\n\n\
			 ## What can break\n\
			 - [high] A double refund if the webhook arrives twice.\n\
			 - [medium] The receipt label is not translated.\n\n\
			 ## Check before merging\n\
			 - Replay an already processed webhook.\n\n\
			 ## What could be better\n\
			 Nothing useful.\n\n\
			 ## Verdict\n\
			 Verdict: concerns\n\
			 Risk: medium\n",
		);
		let ids: Vec<&str> = analysis.sections.iter().map(|s| s.id.as_str()).collect();
		assert_eq!(ids, vec!["produit", "pourquoi", "choix", "risques", "verifier", "mieux"]);
		assert_eq!(analysis.summary.verdict, "réserves");
		assert_eq!(analysis.summary.risk, "moyen");
		assert_eq!(analysis.summary.risk_count, 2);
		assert!(analysis.summary.headline.starts_with("Loyalty points"));
		assert_eq!(parse("Verdict: blocking\n").summary.verdict, "bloquant");
		assert_eq!(parse("Verdict: ok\nRisk: high\n").summary.risk, "élevé");
	}

	#[test]
	fn une_cle_devient_un_nom_de_fichier() {
		assert_eq!(slug("github:acme/monorepo#412"), "github-acme-monorepo-412");
	}
}
