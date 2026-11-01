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
pub const VISUAL_TEMPLATE: &str = "Ton compte rendu se regarde avant de se lire. L'utilisateur pilote \
plusieurs agents à la fois : il doit comprendre ce que tu as fait d'un coup d'œil — l'image d'abord, le \
texte ensuite.

- Ta conclusion commence par UNE phrase qui dit ce qui est vrai maintenant (« La liste tient sur un écran \
de téléphone. »), pas ce que tu as fait. Le détail vient après, aussi court que possible.
- Si ta tâche change ce qui se voit à l'écran et que tu peux le capturer (navigateur piloté, outil de \
capture, script du dépôt) : prends une capture AVANT de toucher au code, puis une APRÈS, du même écran et au \
même cadrage. Range-les dans `.claude/work/rendu/` sous les noms `avant-<sujet>.png` et `apres-<sujet>.png`. \
Sur la capture d'après, pose des repères numérotés avec l'outil `mcp__cockpit__illustrer` (genre `capture`) \
: un repère par changement visible, une phrase par repère.
- Pour le reste, `mcp__cockpit__illustrer` dessine à partir de tes données. Choisis le genre selon ce que tu \
as fait : `frise` pour un bug (la chaîne d'événements et le maillon qui casse), `avant_apres` pour une \
refonte (ce qui dépend de quoi), `mesure` pour une optimisation (des chiffres sortis d'une commande, avec \
la commande), `table` pour une migration, `matrice` pour comparer des options. Une à trois images, pas plus.
- Sans cet outil, un bloc ```mermaid court (douze nœuds au plus) remplace `frise` et `avant_apres`.
- Cite chaque capture dans ta conclusion en Markdown : `![légende](chemin)`.
- N'invente jamais une image ni un chiffre : pas de capture si tu n'as pas pu lancer l'application, pas de \
mesure sans commande, pas de schéma décoratif. Dis-le en une phrase à la place.
- Pour une réponse à une question, un correctif de quelques lignes, ou une tâche sans effet visible ni \
structurel : aucune image, la phrase de tête et du texte court.

La liste des fichiers modifiés, le film de ton travail et tes tests sont déjà dessinés à partir de ce que \
le cockpit a vu passer : ne les refais pas.";

/// La consigne de la liste d'étapes, jointe quand le pont du cockpit est là
/// pour porter son outil (voir `permissions.rs`).
///
/// Le CLI n'a plus d'outil de liste de tâches : sans celui-ci, rien ne dit où
/// en est un agent lancé depuis une heure, sinon qu'il tourne encore.
pub const STEPS_TEMPLATE: &str = "Sur toute tâche de plus de deux étapes, tiens la liste de tes étapes avec \
l'outil `mcp__cockpit__etapes` : pose-la avant ton premier geste, puis rappelle-la chaque fois qu'une étape \
commence, se termine, ou que tu en découvres une nouvelle. C'est par elle que l'utilisateur voit où tu en es. \
Des étapes concrètes, cinq à douze, une seule en cours à la fois. Pour une question ou un correctif de \
quelques lignes : pas de liste.";

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

fn prompt(id: &str, group: &str, label: &str, text: &str) -> Prompt {
	Prompt {
		id: id.into(),
		group: group.into(),
		label: label.into(),
		text: text.trim().into(),
	}
}

pub fn defaults() -> Vec<Prompt> {
	vec![
		// Les deux consignes du geste « Relire » (voir `review.rs`) : `{pr}`,
		// `{titre}`, `{auteur}`, `{branche}` et `{base}` y sont remplacés.
		prompt("revue", "Revue", "Code review complète d'une PR", crate::review::REVIEW_TEMPLATE),
		prompt("revue-suivi", "Revue", "Vérifier les corrections d'une PR", crate::review::FOLLOWUP_TEMPLATE),
		// Ajoutée aux consignes de chaque agent, jamais envoyée comme message
		// (voir `visual`).
		prompt("rendu", "Rendu", "Rendre compte en images", VISUAL_TEMPLATE),
		prompt(
			"ship",
			"Livraison",
			"Vérifier puis commit + push",
			"Lance les vérifications déclarées par le dépôt sur ce qui est modifié — mise en forme, \
			 types, tests. Si tout passe, commit avec un message conventionnel décrivant le \
			 changement, puis push. Si quelque chose échoue, corrige d'abord et ne commit pas tant \
			 que ce n'est pas vert. Ne touche à rien d'autre que ce qui est déjà modifié.",
		),
		prompt(
			"review-then-ship",
			"Livraison",
			"Relire puis commit + push",
			"Relis les changements en cours comme le ferait un relecteur exigeant : correction, cas \
			 limites, cohérence avec le reste du dépôt. Traite les remarques justifiées, écarte les \
			 autres en disant pourquoi. Relance ensuite les vérifications du projet ; si tout est \
			 vert, commit et push.",
		),
		prompt(
			"open-pr",
			"Livraison",
			"Ouvrir la pull request",
			"Ouvre la pull request de cette branche : ce qui change, pourquoi, et la preuve que ça \
			 marche. Lie le ticket s'il y en a un. Vérifie d'abord que la branche est à jour avec sa \
			 base et que les vérifications passent en local.",
		),
		prompt(
			"review-comments",
			"Revue",
			"Traiter les retours de revue",
			"Récupère les commentaires laissés sur la pull request de cette branche — humains comme \
			 automatiques. Pour chacun : applique la correction si elle est pertinente, sinon réponds \
			 en expliquant pourquoi tu ne l'appliques pas. Résous les fils traités. \
			 Termine par un commit + push des corrections.",
		),
		prompt(
			"pr-health",
			"Revue",
			"État de santé de la PR",
			"Fais le point sur la pull request de cette branche : état de l'intégration continue, \
			 conflits avec sa base, relecteurs en attente, commentaires non résolus, taille du diff. \
			 Dis-moi ce qui bloque la fusion et dans quel ordre traiter.",
		),
		prompt(
			"ci-red",
			"Correctifs",
			"L'intégration continue est rouge",
			"L'intégration continue échoue sur cette branche. Trouve quels travaux échouent, lis les \
			 journaux, identifie la cause réelle (pas le symptôme) et corrige. \
			 Rejoue les tests concernés en local pour vérifier avant de pousser.",
		),
		prompt(
			"conflicts",
			"Correctifs",
			"Résoudre les conflits avec la base",
			"Fusionne la branche de base dans celle-ci et résous les conflits. Pour chaque conflit, \
			 garde l'intention des deux côtés plutôt que d'écraser. \
			 Vérifie ensuite que la construction et les tests des parties touchées passent.",
		),
		prompt(
			"self-qa",
			"Qualité",
			"Recette de ce qui a été fait",
			"Vérifie sur pièces ce qui a été implémenté sur cette branche : exécute réellement le \
			 code et produis les preuves (captures, appels d'API, cas adversariaux) plutôt qu'une \
			 relecture. Signale tout écart avec le comportement attendu.",
		),
		prompt(
			"conventions",
			"Qualité",
			"Vérifier les conventions",
			"Vérifie que les fichiers modifiés respectent les conventions du dépôt, telles que sa \
			 documentation et le code existant les établissent. \
			 Applique les corrections évidentes, liste celles qui demandent un arbitrage.",
		),
		prompt(
			"tests",
			"Qualité",
			"Compléter les tests",
			"Regarde ce que cette branche change et dis-moi ce qui n'est pas couvert par les tests. \
			 Écris les tests manquants qui ont de la valeur (cas limites, régressions possibles), \
			 pas du test de façade. Lance-les pour vérifier qu'ils passent.",
		),
		prompt(
			"prod-error",
			"Investigation",
			"Investiguer une erreur de production",
			"Investigue cette erreur de production : reproduis-la si possible, remonte à la cause \
			 dans le code, et propose un correctif avec son test de non-régression. \
			 Vérifie d'abord si un ticket existe déjà pour elle.",
		),
		prompt(
			"ticket",
			"Investigation",
			"Implémenter un ticket",
			"Implémente le ticket correspondant à cette branche : lis-le, repère ce qu'il touche, \
			 puis procède par couches — données, service, interface — en vérifiant à chaque étape. \
			 Respecte les conventions du dépôt.",
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
		.map_err(|e| CockpitError::msg(format!("Dossier de configuration : {e}")))?;
	let raw = toml::to_string_pretty(&Library {
		prompts: prompts.clone(),
	})
	.map_err(|e| CockpitError::msg(format!("Sérialisation : {e}")))?;
	std::fs::write(library_path(), raw)
		.map_err(|e| CockpitError::msg(format!("Écriture de prompts.toml : {e}")))?;
	Ok(prompts)
}

/// Crée ou remplace un prompt. Un `id` vide en fabrique un depuis le libellé.
pub fn save(mut prompt: Prompt) -> Result<Vec<Prompt>> {
	if prompt.label.trim().is_empty() || prompt.text.trim().is_empty() {
		return Err(CockpitError::msg("Un prompt a besoin d'un libellé et d'un texte."));
	}
	if prompt.id.trim().is_empty() {
		prompt.id = slug(&prompt.label);
	}
	if prompt.group.trim().is_empty() {
		prompt.group = "Mes prompts".into();
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
