//! Ce que l'agent saura avant de commencer.
//!
//! Un agent lancé dans un worktree ne sait rien de ce que le cockpit, lui, sait
//! déjà : quel ticket a produit cette branche, ce qui a été reproché sur la
//! demande de fusion, ce qui a déjà été tenté ici et n'a pas marché. Il le
//! redécouvre à sa façon — en lisant des fichiers au hasard, en posant des
//! questions dont la réponse était à portée, et en dépensant pour ça une
//! fenêtre de contexte qu'il aurait mieux employée ailleurs.
//!
//! Ce module rassemble ces faits en **sections**, chacune indépendante, chacune
//! nommée. Il ne les envoie pas : c'est l'interface qui les montre, permet d'en
//! écarter, et ne joint que ce qui reste. Voir ce que l'agent va savoir est le
//! but — un contexte injecté en douce serait pire que pas de contexte du tout,
//! puisqu'on ne pourrait plus expliquer ce qu'il a fait.
//!
//! Trois règles tiennent tout le module :
//!
//! - **Une source muette est une section absente**, jamais une erreur. Sans
//!   suivi de tâches déclaré, il n'y a pas de section ticket, et personne n'a
//!   rien à désactiver. Composer un brief ne peut pas échouer.
//! - **Rien n'est supposé.** Aucun nom de forge, de colonne ou d'équipe n'est
//!   écrit ici : ce qui est lu vient de ce que le poste a déclaré.
//! - **Chaque section est bornée.** Un contexte qui déborde chasse la consigne,
//!   et un agent noyé travaille moins bien qu'un agent ignorant.

use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Ce qu'une section de contexte pèse au maximum.
///
/// Choisi pour que le brief complet reste sous quelques milliers de jetons : à
/// ce prix il tient dans n'importe quelle fenêtre sans discussion. Au-delà, on
/// coupe en le disant — un agent qui sait qu'il lui manque la fin va la
/// chercher, là où un agent qui l'ignore conclut sur ce qu'il n'a pas lu.
const MAX_SECTION_CHARS: usize = 6_000;

/// Nombre de conversations passées rappelées sur un même dossier.
const MAX_ATTEMPTS: usize = 3;

/// Un fait rassemblé, prêt à être joint — ou écarté.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefSection {
	/// Stable : c'est par lui qu'on décoche, et qu'un réglage écarte.
	pub id: String,
	/// Ce qui s'affiche sur la puce — court, il tient sur une ligne.
	pub label: String,
	/// Le sous-titre de la puce : d'où ça vient, ou ce que ça contient.
	pub detail: String,
	/// Le markdown réellement joint à la consigne.
	pub text: String,
	/// Longueur du texte, pour que le coût soit visible avant l'envoi.
	pub chars: usize,
	/// Cochée à l'ouverture.
	pub on: bool,
	/// Ce que cette section met en jeu, quand ça se compte.
	///
	/// Les leçons du carnet y déposent leurs identifiants : leur emploi se note
	/// à l'assemblage, jamais à la composition. Une leçon rassemblée puis
	/// décochée n'a servi à personne, et la compter fausserait exactement la
	/// mesure qui sert à repérer celles qui ne servent jamais.
	#[serde(default)]
	pub ids: Vec<String>,
}

/// Une source de contexte, telle que les réglages la présentent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefSource {
	pub id: String,
	pub label: String,
	/// Ce que cette source apporte, et ce qu'elle coûte.
	pub hint: String,
}

/// Le catalogue des sources, dans l'ordre où elles sont jointes.
///
/// Déclaré ici et non dans l'écran de réglages : un identifiant écrit deux fois
/// finit par ne plus désigner la même chose, et une case qui décoche une
/// section inexistante ne se voit pas.
pub fn sources() -> Vec<BriefSource> {
	let source = |id: &str, label: &str, hint: &str| BriefSource {
		id: id.into(),
		label: label.into(),
		hint: hint.into(),
	};
	vec![
		source(
			"conventions",
			"Les règles du dépôt",
			"où le dépôt écrit ses conventions, et les compétences qu'il range — un moteur ne lit que le fichier de sa famille",
		),
		source(
			"product",
			"Ce que fait le produit",
			"la phrase déclarée pour la lecture des changements — sans elle, un agent ne parle que du code",
		),
		source(
			"lessons",
			"Le carnet du projet",
			"ce qu'on a déjà eu à reprendre à la main, filtré sur les fichiers en jeu",
		),
		source(
			"place",
			"La branche et son état",
			"base, écart, fichiers non commités, derniers commits — lu dans le dépôt, toujours disponible",
		),
		source(
			"ticket",
			"Le ticket de la branche",
			"la demande et ses commentaires, chez le suivi déclaré",
		),
		source(
			"review",
			"Les retours de revue",
			"description et échanges de la demande de fusion ouverte sur cette branche",
		),
		source(
			"attempts",
			"Ce qui a déjà été tenté",
			"les conversations passées dans ce dossier, en une ligne chacune",
		),
	]
}

/// Le dossier complet, tel que l'interface le reçoit.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
	pub cwd: String,
	pub branch: String,
	pub sections: Vec<BriefSection>,
	/// Ce qui a été cherché sans être trouvé, en clair.
	///
	/// Une source interrogée qui ne répond pas — jeton périmé, ticket
	/// introuvable — doit se dire. Sans ça, le brief paraît complet alors qu'il
	/// lui manque justement ce qui aurait compté.
	pub missing: Vec<String>,
}

impl Brief {
	fn push(&mut self, section: Option<BriefSection>) {
		if let Some(section) = section {
			self.sections.push(section);
		}
	}
}

/// Fabrique une section, ou rien si elle n'a rien à dire.
fn section(id: &str, label: &str, detail: &str, text: String, on: bool) -> Option<BriefSection> {
	let text = text.trim().to_string();
	if text.is_empty() {
		return None;
	}
	let text = clamp(&text);
	Some(BriefSection {
		id: id.into(),
		label: label.into(),
		detail: detail.into(),
		chars: text.chars().count(),
		text,
		on,
		ids: Vec::new(),
	})
}

/// Coupe un texte trop long en le disant à celui qui le lira.
fn clamp(text: &str) -> String {
	if text.chars().count() <= MAX_SECTION_CHARS {
		return text.to_string();
	}
	let kept: String = text.chars().take(MAX_SECTION_CHARS).collect();
	format!("{kept}\n\n> (coupé ici — va lire la source si ce qui manque compte.)")
}

/// Assemble ce qui a été retenu, la consigne en dernier.
///
/// L'ordre n'est pas indifférent : ce qu'un agent lit en dernier pèse le plus
/// lourd dans ce qu'il fait ensuite. Le contexte encadre, la consigne décide —
/// l'inverse produisait des agents qui commentaient le dossier au lieu de
/// traiter la demande.
///
/// Fonction pure, et c'est voulu : c'est le seul endroit où le texte final se
/// décide, donc le seul qu'il faille pouvoir vérifier sans réseau ni dépôt. Ce
/// qui doit être noté au passage — l'emploi d'une leçon — l'est par l'appelant,
/// voir [`employed`].
pub fn assemble(sections: &[BriefSection], prompt: &str) -> String {
	let retained: Vec<&BriefSection> = sections.iter().filter(|section| section.on).collect();
	if retained.is_empty() {
		return prompt.trim().to_string();
	}

	let mut out = String::from(
		"# Ce que le cockpit a rassemblé pour toi\n\n\
		 Ce qui suit a été réuni automatiquement à partir du dépôt et des outils déclarés. \
		 C'est un point de départ, pas une vérité : si quelque chose contredit ce que tu lis \
		 dans le code, c'est le code qui a raison, et dis-le.\n\n",
	);
	for entry in retained {
		out.push_str(entry.text.trim());
		out.push_str("\n\n");
	}

	let prompt = prompt.trim();
	if prompt.is_empty() {
		return out.trim_end().to_string();
	}
	out.push_str("---\n\n# Ce qu'on te demande\n\n");
	out.push_str(prompt);
	out
}

/// Le contexte d'un dossier, assemblé avec une consigne, sans passer par un
/// écran.
///
/// Pour les agents que personne ne regarde partir : les exécutants d'une
/// mission, le maître. Il n'y a là ni champ de saisie ni case à décocher — ce
/// sont justement ceux qui travaillent le plus longtemps seuls, et à qui il
/// manque le plus de savoir ce que le cockpit sait déjà.
///
/// Ne peut pas échouer : sans contexte joignable, la consigne part telle quelle.
pub async fn for_agent(cwd: &str, prompt: &str) -> String {
	let brief = compose(cwd).await;
	let retained: Vec<BriefSection> = brief
		.sections
		.into_iter()
		.filter(|section| section.on)
		.collect();
	if retained.is_empty() {
		return prompt.to_string();
	}
	crate::notebook::mark_used(&employed(&retained));
	crate::notebook::mark_briefed(cwd);
	assemble(&retained, prompt)
}

/// Ce que les sections retenues mettent en jeu, à noter une fois l'envoi décidé.
///
/// Séparé de [`assemble`] pour que celle-ci reste vérifiable sans toucher au
/// disque : une fonction dite pure qui écrirait en douce serait un piège pour
/// qui la relira.
pub fn employed(sections: &[BriefSection]) -> Vec<String> {
	sections
		.iter()
		.filter(|section| section.on)
		.flat_map(|section| section.ids.clone())
		.collect()
}

/// Rassemble tout ce qui est joignable sur ce dossier de travail.
///
/// Ne rend jamais d'erreur : au pire un dossier vide, avec ses manques nommés.
/// Un contexte est un bonus, et rater un bonus n'a pas à empêcher de lancer un
/// agent.
pub async fn compose(cwd: &str) -> Brief {
	let mut brief = Brief {
		cwd: cwd.to_string(),
		..Default::default()
	};

	let path = PathBuf::from(cwd);
	if !path.is_dir() {
		brief.missing.push("le dossier n'existe pas".into());
		return brief;
	}

	let branch = crate::git::current_branch(&path).await.unwrap_or_default();
	brief.branch = branch.clone();

	// Le dépôt principal porte la configuration : un worktree n'est pas un
	// projet, c'est une sortie de projet. Résoudre depuis le projet actif ferait
	// dépendre le contexte de l'onglet ouvert.
	let repo = crate::git::main_worktree(&path)
		.await
		.unwrap_or_else(|_| path.clone());
	let config = Config::for_repo(&repo.to_string_lossy());
	if !config.brief.enabled {
		return brief;
	}

	// Les trois sources lentes partent ensemble : elles ne dépendent pas les
	// unes des autres, et les attendre l'une après l'autre ajouterait leurs
	// latences là où le champ de saisie attend.
	let (place, ticket, review) = futures::join!(
		place_section(&path, &branch),
		ticket_section(&config, &branch),
		review_section(&config, &branch),
	);

	brief.push(conventions_section(&repo));
	brief.push(product_section(&config));
	brief.push(lessons_section(&repo, &path).await);
	brief.push(place);
	match ticket {
		Ok(found) => brief.push(found),
		Err(reason) => brief.missing.push(reason),
	}
	match review {
		Ok(found) => brief.push(found),
		Err(reason) => brief.missing.push(reason),
	}
	brief.push(attempts_section(cwd));

	// Le réglage décoche, il n'efface pas : la section reste visible et se
	// rattrape d'un clic, ce qui vaut mieux qu'un contexte qu'on croit absent.
	for entry in &mut brief.sections {
		if !config.brief.wants(&entry.id) {
			entry.on = false;
		}
	}
	brief
}

// ── Ce que fait ce produit ──────────────────────────────────────────────────

/// Le brief du produit, déjà déclaré pour la lecture des changements.
///
/// Réutilisé plutôt que redemandé : c'est la même phrase qui répond à « que
/// fait ce produit, et pour qui », et deux réglages pour une seule question
/// finissent toujours par diverger.
fn product_section(config: &Config) -> Option<BriefSection> {
	let brief = config.impact.brief.trim();
	section(
		"product",
		"Le produit",
		"ce que l'équipe a déclaré",
		format!("## Ce que fait ce produit\n\n{brief}"),
		true,
	)
}

// ── Ce qu'on a déjà eu à reprendre ──────────────────────────────────────────

/// Les leçons du carnet qui concernent les fichiers en jeu.
///
/// C'est la seule section qui apprend quelque chose que le dépôt ne dit pas :
/// les autres rassemblent des faits, celle-ci porte ce qu'un humain a jugé bon
/// de retenir après avoir repris du travail à la main.
///
/// Filtrée par portée, jamais servie en entier. Une mémoire qui parle à chaque
/// lancement cesse d'être lue, et son bruit dégrade ce qui l'entoure.
async fn lessons_section(repo: &Path, cwd: &Path) -> Option<BriefSection> {
	let project = repo.to_string_lossy().to_string();
	// Les fichiers déjà en jeu décident de ce qui remonte. Sans eux, on n'a que
	// les leçons sans portée — celles qui valent pour tout le dépôt.
	let files: Vec<String> = crate::git::working_diff(cwd)
		.await
		.map(|changes| changes.into_iter().map(|change| change.path).collect())
		.unwrap_or_default();

	let found = crate::notebook::relevant(&project, &files);
	if found.is_empty() {
		return None;
	}

	let mut out = String::from(
		"## Ce que ce dépôt a déjà eu à corriger\n\n\
		 Ces règles viennent de travaux repris à la main après coup. Elles ont été validées \
		 par quelqu'un, mais elles ne sont pas la loi : si l'une d'elles ne s'applique pas ici, \
		 dis-le plutôt que de la suivre de travers.\n\n",
	);
	for lesson in &found {
		out.push_str(&format!("- {}", lesson.text.trim()));
		if !lesson.scope.is_empty() {
			out.push_str(&format!(" _(sur {})_", lesson.scope.join(", ")));
		}
		out.push('\n');
	}

	// L'emploi se notera à l'assemblage, pas ici : une leçon rassemblée puis
	// décochée n'a servi à personne.
	let mut built = section(
		"lessons",
		"Le carnet",
		&plural(found.len(), "leçon"),
		out,
		true,
	)?;
	built.ids = found.into_iter().map(|lesson| lesson.id).collect();
	Some(built)
}

// ── Où tu travailles ────────────────────────────────────────────────────────

/// La branche, sa base, et ce qui bouge déjà dans la copie de travail.
///
/// Toujours disponible : c'est du git, il n'y a rien à configurer. C'est aussi
/// la section qui évite le plus d'erreurs bêtes — un agent qui ignore qu'il
/// travaille sur du travail en cours écrase ce qui s'y trouvait.
async fn place_section(path: &Path, branch: &str) -> Option<BriefSection> {
	let mut out = String::from("## Où tu travailles\n\n");
	out.push_str(&format!("- Dossier : `{}`\n", path.to_string_lossy()));

	if branch.is_empty() {
		out.push_str("- Branche : détachée — aucun nom de branche à citer.\n");
	} else {
		out.push_str(&format!("- Branche : `{branch}`\n"));
	}

	let named = crate::git::default_branch(path).await;
	let base = crate::git::freshest(path, &named).await;
	if !named.is_empty() && !branch.is_empty() && named != branch {
		if let Ok(counts) = crate::git::run_git(
			path,
			&[
				"rev-list",
				"--left-right",
				"--count",
				&format!("{base}...{branch}"),
			],
		)
		.await
		{
			let mut parts = counts.split_whitespace();
			let behind: usize = parts.next().unwrap_or("0").parse().unwrap_or(0);
			let ahead: usize = parts.next().unwrap_or("0").parse().unwrap_or(0);
			out.push_str(&format!(
				"- Base : `{base}` — {} en avance, {} en retard\n",
				plural(ahead, "commit"),
				plural(behind, "commit"),
			));
		}
	}

	// Ce qui n'est pas commité est ce qu'on risque de perdre : c'est le fait le
	// plus utile de toute la section.
	if let Ok(changes) = crate::git::working_diff(path).await {
		if changes.is_empty() {
			out.push_str("- Copie de travail : propre, rien en cours.\n");
		} else {
			out.push_str(&format!(
				"- Copie de travail : {} non commité(s)\n",
				plural(changes.len(), "fichier")
			));
			out.push_str("\n### Fichiers déjà modifiés ici\n\n");
			for change in changes.iter().take(40) {
				if change.state == "untracked" {
					out.push_str(&format!("- `{}` (nouveau)\n", change.path));
				} else {
					out.push_str(&format!(
						"- `{}` (+{} −{})\n",
						change.path, change.added, change.removed
					));
				}
			}
			if changes.len() > 40 {
				out.push_str(&format!("- … et {} autres\n", changes.len() - 40));
			}
		}
	}

	if let Ok(commits) = crate::git::recent_commits(path, 5).await {
		if !commits.is_empty() {
			out.push_str("\n### Derniers commits\n\n");
			for commit in commits {
				out.push_str(&format!(
					"- `{}` {} ({})\n",
					&commit.sha[..commit.sha.len().min(8)],
					commit.subject,
					commit.relative
				));
			}
		}
	}

	section("place", "La branche", "état du dépôt", out, true)
}

fn plural(count: usize, word: &str) -> String {
	if count > 1 {
		format!("{count} {word}s")
	} else {
		format!("{count} {word}")
	}
}

// ── Le ticket ───────────────────────────────────────────────────────────────

/// Le ticket que cette branche traite, lu chez le suivi déclaré.
///
/// L'identifiant se déduit du nom de la branche. C'est la seule piste dont on
/// dispose sans rien demander — et elle vaut, puisque la plupart des suivis
/// proposent eux-mêmes le nom de branche qui porte leur identifiant.
///
/// Rend `Err` quand une source déclarée n'a pas répondu : ce manque-là se dit.
async fn ticket_section(config: &Config, branch: &str) -> Result<Option<BriefSection>, String> {
	let Some((identifier, title, markdown)) = ticket_markdown(config, branch).await? else {
		return Ok(None);
	};
	Ok(section(
		"ticket",
		&format!("Ticket {identifier}"),
		&title,
		markdown,
		true,
	))
}

/// Le ticket d'une branche, mis à plat.
///
/// Partagé avec la lecture des changements : les deux veulent la même chose —
/// ce qui était demandé — et deux lectures différentes du même ticket finiraient
/// par ne pas dire la même chose. Rend l'identifiant, le titre et le markdown.
pub(crate) async fn ticket_markdown(
	config: &Config,
	branch: &str,
) -> Result<Option<(String, String, String)>, String> {
	if branch.trim().is_empty() {
		return Ok(None);
	}
	let ids = crate::team::extract_ticket_ids(&[branch], config.linear.team_key.trim());
	let Some(id) = ids.first() else {
		return Ok(None);
	};

	// Pas de suivi déclaré : rien à dire, et rien à signaler non plus. On n'a
	// pas manqué une source, il n'y en avait pas.
	let Ok(provider) = crate::tickets::provider(config) else {
		return Ok(None);
	};
	let ticket = match provider.get(id).await {
		Ok(ticket) => ticket,
		Err(error) => {
			return Err(format!("ticket {id} illisible ({error})"));
		}
	};

	let mut out = format!("## Ticket {} — {}\n\n", ticket.identifier, ticket.title);
	let state = ticket
		.state
		.as_ref()
		.map(|state| state.name.clone())
		.unwrap_or_default();
	if !state.is_empty() {
		out.push_str(&format!("- État : {state}\n"));
	}
	if !ticket.url.is_empty() {
		out.push_str(&format!("- Adresse : {}\n", ticket.url));
	}
	if !ticket.labels.is_empty() {
		out.push_str(&format!(
			"- Libellés : {}\n",
			ticket
				.labels
				.iter()
				.map(|label| label.name.clone())
				.collect::<Vec<_>>()
				.join(", ")
		));
	}
	out.push('\n');

	let description = ticket.description.trim();
	if description.is_empty() {
		out.push_str(
			"Le ticket n'a pas de description : ne suppose pas ce qu'il voulait dire, demande.\n",
		);
	} else {
		out.push_str("### La demande, telle qu'elle a été écrite\n\n");
		out.push_str(description);
		out.push('\n');
	}

	// Les commentaires portent souvent la vraie contrainte — celle qui a été
	// découverte après l'écriture du ticket.
	let comments: Vec<String> = ticket
		.comments
		.iter()
		.filter(|comment| !comment.body.trim().is_empty())
		.map(|comment| {
			let author = if comment.author.trim().is_empty() {
				"quelqu'un"
			} else {
				comment.author.trim()
			};
			format!(
				"- **{author}** : {}",
				comment.body.trim().chars().take(600).collect::<String>()
			)
		})
		.collect();
	if !comments.is_empty() {
		out.push_str("\n### Ce qui s'est dit sur le ticket\n\n");
		out.push_str(&comments.join("\n"));
		out.push('\n');
	}

	Ok(Some((ticket.identifier, ticket.title, out)))
}

// ── Les retours de revue ────────────────────────────────────────────────────

/// Ce qui a été dit sur la demande de fusion de cette branche.
///
/// C'est le contexte que le développeur transmet le plus souvent à la main, en
/// recopiant un commentaire dans une conversation d'agent. Ce maillon-là ne
/// porte aucun jugement : autant le faire porter au cockpit, qui a déjà les
/// jetons d'accès.
async fn review_section(config: &Config, branch: &str) -> Result<Option<BriefSection>, String> {
	if branch.trim().is_empty() {
		return Ok(None);
	}

	if !config.github.repo.trim().is_empty() {
		return github_review(config, branch).await;
	}
	if !config.gitlab.project.trim().is_empty() && !config.gitlab.token.trim().is_empty() {
		return gitlab_review(config, branch).await;
	}
	Ok(None)
}

async fn github_review(config: &Config, branch: &str) -> Result<Option<BriefSection>, String> {
	let pr = match crate::integrations::github_pull_for_branch(config, branch).await {
		Ok(Some(pr)) => pr,
		// Aucune demande de fusion n'est un fait ordinaire, pas un manque.
		Ok(None) => return Ok(None),
		Err(error) => return Err(format!("pull requests illisibles ({error})")),
	};

	let conversation =
		match crate::integrations::github_pull_conversation(config, &pr.number.to_string()).await {
			Ok(value) => value,
			Err(error) => return Err(format!("pull request #{} illisible ({error})", pr.number)),
		};

	let mut echanges = Vec::new();
	for (pointer, kind) in [("/reviews", "revue"), ("/comments", "commentaire")] {
		let Some(list) = conversation.pointer(pointer).and_then(|v| v.as_array()) else {
			continue;
		};
		for entry in list {
			let body = entry
				.get("body")
				.and_then(|v| v.as_str())
				.unwrap_or_default()
				.trim();
			if body.is_empty() {
				continue;
			}
			let author = entry
				.pointer("/user/login")
				.and_then(|v| v.as_str())
				.unwrap_or("quelqu'un");
			let state = entry
				.get("state")
				.and_then(|v| v.as_str())
				.unwrap_or_default()
				.to_lowercase();
			echanges.push(format!(
				"- **{author}** ({kind}{}) : {}",
				if state.is_empty() {
					String::new()
				} else {
					format!(", {state}")
				},
				body.chars().take(800).collect::<String>()
			));
		}
	}

	let body = conversation
		.pointer("/detail/body")
		.and_then(|v| v.as_str())
		.unwrap_or_default()
		.trim()
		.to_string();

	Ok(review_text(
		&format!("#{}", pr.number),
		&pr.title,
		&pr.url,
		&pr.state,
		&body,
		&echanges,
	))
}

async fn gitlab_review(config: &Config, branch: &str) -> Result<Option<BriefSection>, String> {
	let mr = match crate::integrations::gitlab_merge_request_for_branch(config, branch).await {
		Ok(Some(mr)) => mr,
		Ok(None) => return Ok(None),
		Err(error) => return Err(format!("merge requests illisibles ({error})")),
	};
	let iid = mr
		.get("iid")
		.and_then(|v| v.as_i64())
		.map(|iid| iid.to_string())
		.unwrap_or_default();
	if iid.is_empty() {
		return Ok(None);
	}

	let mut echanges = Vec::new();
	match crate::integrations::gitlab_merge_request_notes(config, &iid).await {
		Ok(notes) => {
			for note in notes {
				// Les notes système racontent la mécanique — assignation, push —
				// et jamais le fond.
				if note.get("system").and_then(|v| v.as_bool()).unwrap_or(false) {
					continue;
				}
				let body = note
					.get("body")
					.and_then(|v| v.as_str())
					.unwrap_or_default()
					.trim();
				if body.is_empty() {
					continue;
				}
				let author = note
					.pointer("/author/name")
					.and_then(|v| v.as_str())
					.unwrap_or("quelqu'un");
				echanges.push(format!(
					"- **{author}** : {}",
					body.chars().take(800).collect::<String>()
				));
			}
		}
		Err(error) => return Err(format!("échanges de la MR !{iid} illisibles ({error})")),
	}

	let text_of = |pointer: &str| {
		mr.pointer(pointer)
			.and_then(|v| v.as_str())
			.unwrap_or_default()
			.trim()
			.to_string()
	};
	Ok(review_text(
		&format!("!{iid}"),
		&text_of("/title"),
		&text_of("/web_url"),
		&text_of("/state"),
		&text_of("/description"),
		&echanges,
	))
}

/// La mise en forme commune aux deux forges.
///
/// Séparée du réseau pour être vérifiable : c'est ici que se joue la seule
/// décision de fond de la section — une demande de fusion sans description ni
/// échange n'apprend rien et ne mérite pas d'occuper le contexte.
fn review_text(
	reference: &str,
	title: &str,
	url: &str,
	state: &str,
	body: &str,
	echanges: &[String],
) -> Option<BriefSection> {
	if body.trim().is_empty() && echanges.is_empty() {
		return None;
	}

	let mut out = format!("## Demande de fusion {reference} — {title}\n\n");
	if !state.trim().is_empty() {
		out.push_str(&format!("- État : {state}\n"));
	}
	if !url.trim().is_empty() {
		out.push_str(&format!("- Adresse : {url}\n"));
	}
	out.push('\n');
	if !body.trim().is_empty() {
		out.push_str("### Description\n\n");
		out.push_str(body.trim());
		out.push_str("\n\n");
	}
	if !echanges.is_empty() {
		out.push_str(
			"### Ce qui a été dit\n\n\
			 Les retours ci-dessous n'ont pas forcément été traités. Vérifie dans le code avant \
			 de conclure qu'un point est réglé.\n\n",
		);
		out.push_str(&echanges.join("\n"));
		out.push('\n');
	}

	let detail = if echanges.is_empty() {
		"description seule".to_string()
	} else {
		plural(echanges.len(), "retour")
	};
	section(
		"review",
		&format!("Revue {reference}"),
		&detail,
		out,
		true,
	)
}

// ── Ce qui a déjà été tenté ─────────────────────────────────────────────────

/// Les conversations déjà tenues dans ce dossier.
///
/// Un worktree qui porte trois conversations passées a une histoire : soit le
/// travail avance par étapes, soit quelque chose y résiste. Dans les deux cas
/// l'agent qui arrive gagne à le savoir — et c'est une information que
/// personne ne pense à recopier.
///
/// Lecture ciblée sur le dossier concerné, jamais un balayage de tout
/// l'historique : le champ de saisie attend cette réponse.
fn attempts_section(cwd: &str) -> Option<BriefSection> {
	let key = crate::sessions::project_key(cwd);
	// Tous les comptes : ce qui a déjà été tenté dans ce dossier reste vrai même
	// si le projet a changé d'identité depuis, et c'est justement ce qu'un agent
	// qui arrive gagne à savoir.
	let mut files: Vec<(std::time::SystemTime, PathBuf)> = crate::sessions::projects_roots()
		.iter()
		.filter_map(|root| std::fs::read_dir(root.join(&key)).ok())
		.flatten()
		.flatten()
		.map(|entry| entry.path())
		.filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
		.filter_map(|path| {
			let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
			Some((modified, path))
		})
		.collect();
	if files.is_empty() {
		return None;
	}
	files.sort_by(|a, b| b.0.cmp(&a.0));

	let mut lines = Vec::new();
	for (_, path) in files.iter().take(MAX_ATTEMPTS) {
		let Ok(summary) = crate::sessions::read_session(path, &key) else {
			continue;
		};
		let title = summary.title.trim();
		if title.is_empty() {
			continue;
		}
		let mut line = format!("- « {} »", title.chars().take(200).collect::<String>());
		let mut facts = Vec::new();
		if summary.user_messages > 0 {
			facts.push(plural(summary.user_messages, "échange"));
		}
		if summary.has_error {
			facts.push("s'est terminée sur une erreur".into());
		}
		if !facts.is_empty() {
			line.push_str(&format!(" ({})", facts.join(", ")));
		}
		lines.push(line);
	}
	if lines.is_empty() {
		return None;
	}

	let count = lines.len();
	let out = format!(
		"## Ce qui a déjà été tenté dans ce dossier\n\n\
		 {} conversation(s) s'y sont déjà tenues. Ce n'est pas forcément lié à ce qu'on te \
		 demande — mais si ça l'est, ne recommence pas ce qui a échoué.\n\n{}\n",
		count,
		lines.join("\n")
	);
	section(
		"attempts",
		"Tentatives",
		&plural(count, "conversation"),
		out,
		true,
	)
}

// ── Ce que le dépôt exige de qui écrit dedans ───────────────────────────────

/// Les fichiers d'instructions que les agents se sont accordés à lire, dans
/// l'ordre où on les cherche.
///
/// Aucun n'est universel : `AGENTS.md` est la convention la plus partagée,
/// `CLAUDE.md` et `GEMINI.md` sont propres à un moteur. Un dépôt qui n'en a
/// aucun n'a rien déclaré, et la section n'existe pas.
const INSTRUCTION_FILES: [&str; 5] = [
	"AGENTS.md",
	"CLAUDE.md",
	".claude/CLAUDE.md",
	"GEMINI.md",
	".github/copilot-instructions.md",
];

/// Où le dépôt range ses règles, et ce qu'il en attend.
///
/// Un moteur lit le fichier de sa propre famille et ignore les autres : Claude
/// charge `CLAUDE.md` et ses compétences tout seul, Codex ne connaît
/// qu'`AGENTS.md`, Gemini que `GEMINI.md`. Lancé sur un dépôt qui ne parle pas
/// sa langue, un agent démarre donc sans rien — pas parce que le contexte
/// manque, mais parce qu'il ne sait pas qu'il existe. Vérifié sur le monorepo
/// pour lequel ce cockpit a été écrit : vingt-six compétences rangées dans
/// `.claude/skills/`, invisibles à tout moteur qui n'est pas celui-là.
///
/// La section ne recopie pas ces fichiers — ils font des centaines de lignes,
/// et un agent sait lire. Elle dit qu'ils sont là et où, ce qui coûte quelques
/// centaines de caractères et suffit à transformer une ignorance en lecture.
fn conventions_section(repo: &Path) -> Option<BriefSection> {
	let found: Vec<&str> = INSTRUCTION_FILES
		.iter()
		.copied()
		.filter(|name| repo.join(name).is_file())
		.collect();
	let skills = skill_names(repo);
	if found.is_empty() && skills.is_empty() {
		return None;
	}

	let mut out = String::from(
		"## Les règles du dépôt\n\n\
		 Ce dépôt déclare ses conventions par écrit. Va les lire avant d'écrire du code : \
		 elles priment sur tes habitudes, et un agent qui ne les a pas lues produit du code \
		 à reprendre.\n\n",
	);
	if !found.is_empty() {
		out.push_str("Fichiers d'instructions présents :\n\n");
		for name in &found {
			out.push_str(&format!("- `{name}`\n"));
		}
		out.push('\n');
	}
	if !skills.is_empty() {
		out.push_str(&format!(
			"Le dépôt range aussi {} en markdown ordinaire, un dossier par sujet dans \
			 `.claude/skills/<nom>/SKILL.md`. Ouvre celles qui recouvrent ce qu'on te demande \
			 — elles portent les conventions du domaine, pas des généralités :\n\n{}\n",
			plural(skills.len(), "compétence"),
			skills
				.iter()
				.map(|name| format!("`{name}`"))
				.collect::<Vec<_>>()
				.join(", ")
		));
	}

	let detail = match (found.len(), skills.len()) {
		(0, count) => plural(count, "compétence"),
		(count, 0) => plural(count, "fichier"),
		(files, count) => format!(
			"{}, {}",
			plural(files, "fichier"),
			plural(count, "compétence")
		),
	};
	section("conventions", "Les règles du dépôt", &detail, out, true)
}

/// Les compétences déclarées par le dépôt, par ordre alphabétique.
///
/// Lues sur le disque plutôt que devinées : un dossier qui contient un
/// `SKILL.md` est une compétence, le reste ne l'est pas.
fn skill_names(repo: &Path) -> Vec<String> {
	let Ok(entries) = std::fs::read_dir(repo.join(".claude/skills")) else {
		return Vec::new();
	};
	let mut names: Vec<String> = entries
		.flatten()
		.filter(|entry| entry.path().join("SKILL.md").is_file())
		.map(|entry| entry.file_name().to_string_lossy().to_string())
		.collect();
	names.sort();
	names
}

#[cfg(test)]
mod tests {
	use super::*;

	fn fake(id: &str, text: &str, on: bool) -> BriefSection {
		BriefSection {
			id: id.into(),
			label: id.into(),
			detail: String::new(),
			chars: text.chars().count(),
			text: text.into(),
			on,
			ids: Vec::new(),
		}
	}

	#[test]
	fn sans_section_le_prompt_part_seul() {
		assert_eq!(assemble(&[], "  corrige l’arrondi du panier  "), "corrige l’arrondi du panier");
	}

	#[test]
	fn une_section_decochee_ne_part_pas() {
		let sections = vec![fake("place", "## Où\n\nici", false)];
		assert_eq!(assemble(&sections, "vas-y"), "vas-y");
	}

	#[test]
	fn la_consigne_vient_en_dernier() {
		let sections = vec![fake("place", "## Où\n\nici", true)];
		let out = assemble(&sections, "corrige l’arrondi du panier");
		let contexte = out.find("## Où").expect("la section est jointe");
		let consigne = out.find("corrige l’arrondi du panier").expect("la consigne est là");
		assert!(contexte < consigne, "le contexte doit précéder la consigne");
		assert!(out.contains("Ce qu'on te demande"));
	}

	#[test]
	fn un_brief_sans_consigne_reste_lisible() {
		let sections = vec![fake("place", "## Où\n\nici", true)];
		let out = assemble(&sections, "   ");
		assert!(!out.contains("Ce qu'on te demande"));
		assert!(out.trim_end().ends_with("ici"));
	}

	/// Une leçon rassemblée puis décochée n'a servi à personne. La compter
	/// fausserait précisément la mesure qui repère celles qui ne servent jamais.
	#[test]
	fn seules_les_sections_retenues_comptent_leurs_emplois() {
		let mut jointe = fake("lessons", "## Le carnet", true);
		jointe.ids = vec!["l-1".into(), "l-2".into()];
		let mut ecartee = fake("attempts", "## Tentatives", false);
		ecartee.ids = vec!["l-3".into()];

		assert_eq!(employed(&[jointe.clone(), ecartee.clone()]), vec!["l-1", "l-2"]);

		jointe.on = false;
		assert!(employed(&[jointe, ecartee]).is_empty());
	}

	#[test]
	fn une_section_vide_n_existe_pas() {
		assert!(section("x", "X", "", "   \n  ".into(), true).is_none());
	}

	#[test]
	fn une_section_trop_longue_dit_qu_elle_est_coupee() {
		let long = "a".repeat(MAX_SECTION_CHARS + 500);
		let built = section("x", "X", "", long, true).expect("section produite");
		assert!(built.text.contains("coupé ici"));
		assert!(built.chars <= MAX_SECTION_CHARS + 200);
	}

	#[test]
	fn une_revue_sans_rien_a_dire_est_ecartee() {
		assert!(review_text("#1", "Titre", "url", "open", "  ", &[]).is_none());
	}

	#[test]
	fn une_revue_avec_un_seul_retour_compte_juste() {
		let built = review_text(
			"#1",
			"Titre",
			"url",
			"open",
			"",
			&["- **alex** : revois ça".into()],
		)
		.expect("section produite");
		assert_eq!(built.detail, "1 retour");
		assert!(built.text.contains("revois ça"));
	}

	#[test]
	fn le_pluriel_ne_s_invente_pas_au_singulier() {
		assert_eq!(plural(0, "commit"), "0 commit");
		assert_eq!(plural(1, "commit"), "1 commit");
		assert_eq!(plural(3, "commit"), "3 commits");
	}

	/// Un dépôt jetable, avec un commit et un fichier laissé de côté.
	///
	/// Le test qui suit passe par de vraies commandes git : c'est le seul moyen
	/// de vérifier que la section décrit le dépôt et non ce qu'on croit qu'il
	/// contient. Les fonctions de lecture, elles, ne sont pas simulables — et
	/// simuler `git` reviendrait à tester notre imitation.
	fn depot_jetable(nom: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!("cockpit-brief-{}-{nom}", std::process::id()));
		std::fs::remove_dir_all(&dir).ok();
		std::fs::create_dir_all(&dir).unwrap();

		let git = |args: &[&str]| {
			std::process::Command::new("git")
				.args(args)
				.current_dir(&dir)
				.output()
				.expect("git est installé sur ce poste");
		};
		git(&["init", "--quiet"]);
		git(&["config", "user.email", "test@example.invalid"]);
		git(&["config", "user.name", "Test"]);
		std::fs::write(dir.join("lisez-moi.md"), "premier jet\n").unwrap();
		git(&["add", "."]);
		git(&["commit", "--quiet", "-m", "Pose le socle"]);
		dir
	}

	/// Un dépôt qui ne déclare rien ne produit pas une section vide : il n'en
	/// produit aucune. Une puce « Les règles du dépôt » sans règles derrière
	/// ferait croire à un contexte qui n'existe pas.
	#[test]
	fn un_depot_sans_regles_na_pas_de_section() {
		let dir = depot_jetable("conventions-nues");
		assert!(conventions_section(&dir).is_none());
	}

	/// Le cas qui motive la section : les compétences sont rangées sous
	/// `.claude/`, et un moteur qui n'est pas celui-là ne les voit jamais. La
	/// section les nomme sans les recopier — un agent sait ouvrir un fichier.
	#[test]
	fn la_section_nomme_les_regles_sans_les_recopier() {
		let dir = depot_jetable("conventions-completes");
		std::fs::write(dir.join("AGENTS.md"), "# Règles\n").unwrap();
		std::fs::create_dir_all(dir.join(".claude")).unwrap();
		std::fs::write(dir.join(".claude/CLAUDE.md"), "x".repeat(50_000)).unwrap();
		for nom in ["writing-frontend-code", "managing-database"] {
			let skill = dir.join(".claude/skills").join(nom);
			std::fs::create_dir_all(&skill).unwrap();
			std::fs::write(skill.join("SKILL.md"), "# Conventions\n").unwrap();
		}
		// Un dossier sans SKILL.md n'est pas une compétence.
		std::fs::create_dir_all(dir.join(".claude/skills/brouillon")).unwrap();

		let section = conventions_section(&dir).expect("le dépôt déclare des règles");
		assert!(section.text.contains("`AGENTS.md`"));
		assert!(section.text.contains("`.claude/CLAUDE.md`"));
		assert!(section.text.contains("`managing-database`"));
		assert!(section.text.contains("`writing-frontend-code`"));
		assert!(!section.text.contains("brouillon"), "un dossier nu n'est pas une compétence");
		assert!(section.on, "les règles du dépôt partent cochées");
		assert!(
			section.chars < 2_000,
			"la section pointe les fichiers, elle ne les recopie pas ({} caractères)",
			section.chars
		);
	}

	#[tokio::test]
	async fn la_section_de_branche_decrit_le_depot() {
		let dir = depot_jetable("place");
		// Un fichier modifié et un fichier neuf : les deux formes que prend un
		// travail en cours, et celles qu'un agent risque d'écraser.
		std::fs::write(dir.join("lisez-moi.md"), "premier jet\nune ligne de plus\n").unwrap();
		std::fs::write(dir.join("brouillon.txt"), "en cours\n").unwrap();

		let branche = crate::git::current_branch(&dir).await.unwrap_or_default();
		let built = place_section(&dir, &branche)
			.await
			.expect("la section existe toujours : elle ne dépend que de git");

		assert!(built.text.contains("Pose le socle"), "le commit est cité");
		assert!(
			built.text.contains("lisez-moi.md"),
			"le fichier modifié est cité"
		);
		assert!(
			built.text.contains("`brouillon.txt` (nouveau)"),
			"le fichier non suivi est cité comme neuf : {}",
			built.text
		);
		assert!(
			built.text.contains("2 fichiers non commité"),
			"le décompte est juste : {}",
			built.text
		);
		std::fs::remove_dir_all(&dir).ok();
	}

	/// Le cas qui compte le plus : rien en cours. Un agent qui croit à tort
	/// qu'il y a du travail non commité devient prudent pour rien.
	#[tokio::test]
	async fn un_depot_propre_le_dit() {
		let dir = depot_jetable("propre");
		let branche = crate::git::current_branch(&dir).await.unwrap_or_default();
		let built = place_section(&dir, &branche).await.expect("section produite");

		assert!(built.text.contains("propre, rien en cours"));
		assert!(!built.text.contains("Fichiers déjà modifiés"));
		std::fs::remove_dir_all(&dir).ok();
	}

	/// Composer sur un dossier qui n'existe pas ne doit pas empêcher d'écrire à
	/// un agent : c'est un bonus qui manque, pas une panne.
	#[tokio::test]
	async fn un_dossier_absent_ne_fait_pas_echouer_la_composition() {
		let built = compose("/dossier/qui/n/existe/pas").await;
		assert!(built.sections.is_empty());
		assert_eq!(built.missing, vec!["le dossier n'existe pas".to_string()]);
	}
}
