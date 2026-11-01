//! La confrontation : plusieurs lectures d'un même changement, et le désaccord.
//!
//! Une lecture d'Impact rend un verdict, et ce verdict décide si un changement
//! part. Il vient d'un seul agent, en un seul passage : rien ne dit ce qu'il a
//! manqué, et un agent qui n'a rien vu écrit exactement la même chose qu'un
//! changement sans risque.
//!
//! Ce module fait lire le même dossier de faits par plusieurs agents, chacun
//! avec un **angle distinct** — pas trois fois la même question, qui produirait
//! trois fois la même réponse et n'apprendrait rien. Puis un dernier agent ne
//! garde que ce sur quoi ils divergent.
//!
//! **C'est un filtre d'attention, pas une redondance.** Là où les lectures
//! convergent, il n'y a rien à lire ; là où elles divergent se trouve
//! précisément ce qu'un humain sait trancher et qu'une machine ne sait pas.
//! Rendre trois rapports à lire au lieu d'un serait l'inverse du but.
//!
//! Deux décisions qui engagent, à connaître avant de toucher au module :
//!
//! - **Le verdict retenu est le plus sévère, jamais le majoritaire.** Un risque
//!   vu par un seul reste un risque : deux « ok » ne l'effacent pas, ils disent
//!   seulement que deux angles ne l'ont pas croisé.
//! - **Une voix qui échoue ne fait pas échouer la confrontation**, mais elle est
//!   nommée. Deux avis sur trois valent mieux que rien, à condition qu'on sache
//!   qu'il en manque un.

use crate::config::{config_dir, Config};
use crate::error::{CockpitError, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Un angle de lecture.
///
/// Les trois angles ne supposent rien du métier ni de la technique employée :
/// tout changement, dans tout dépôt, peut casser quelque chose, se comporter
/// autrement une fois déployé, et changer ce que vit celui qui s'en sert.
struct Lens {
	id: &'static str,
	label: &'static str,
	/// Ce qui distingue cet angle des autres, dit à l'agent.
	angle: &'static str,
}

const LENSES: [Lens; 3] = [
	Lens {
		id: "casse",
		label: "Ce qui casse",
		angle: "Tu cherches ce que ce changement casse. Pas ce qu'il améliore, pas ce qu'il \
		        vaut : ce qui, à cause de lui, va se comporter autrement que prévu. Cas \
		        limites, valeurs absentes, entrées inattendues, ordre des opérations, erreurs \
		        avalées. Un risque que tu ne sais pas déclencher n'est pas un risque : ne \
		        l'écris pas.",
	},
	Lens {
		id: "exploitation",
		label: "Une fois déployé",
		angle: "Tu regardes ce qui se passe après la mise en service, pas pendant l'écriture. \
		        Données déjà en place et incompatibles avec le nouveau code, migration qu'on \
		        ne sait pas défaire, dépendance à un service qui peut tomber, montée en \
		        charge, retour arrière impossible, comportement au redémarrage. Si rien de \
		        tout cela n'est en jeu, dis-le franchement plutôt que d'inventer.",
	},
	Lens {
		id: "usage",
		label: "Pour qui s'en sert",
		angle: "Tu te mets à la place de celui qui utilise ce que ce dépôt produit — une \
		        interface, une commande, une bibliothèque, une API. Qu'est-ce qui change pour \
		        lui sans qu'on l'ait prévenu ? Qu'est-ce qui devient impossible, plus lent, \
		        ou différent de ce qu'il avait appris ? Une rupture de contrat compte même \
		        quand le code est juste.",
	},
];

/// Ce qu'une lecture a conclu.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
	pub lens: String,
	pub label: String,
	/// `ok` · `réserves` · `bloquant`.
	pub verdict: String,
	/// `faible` · `moyen` · `élevé`.
	pub risk: String,
	/// Une ou deux phrases : ce que cet angle a vu.
	pub summary: String,
	pub points: Vec<String>,
	pub cost_usd: f64,
}

/// Un point sur lequel les lectures ne disent pas la même chose.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Dispute {
	/// Ce qui est affirmé, en une phrase.
	pub claim: String,
	/// Les angles qui le soutiennent, par leur nom affiché.
	pub held_by: Vec<String>,
	/// Ceux qui disent le contraire, ou qui ne l'ont pas vu.
	pub against: Vec<String>,
	/// Pourquoi ce désaccord compte — la conséquence si le mauvais camp a raison.
	pub why: String,
	/// Le geste qui tranche : quoi ouvrir, quoi essayer, quoi regarder.
	pub check: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
	pub key: String,
	/// Tête de la branche au moment de la confrontation : le sceau de fraîcheur.
	pub head_sha: String,
	pub at: u64,
	/// Le plus sévère des verdicts rendus, jamais le plus fréquent.
	pub verdict: String,
	/// Ce que toutes les lectures disent — court, puisque personne n'en discute.
	pub agreed: String,
	pub disputes: Vec<Dispute>,
	pub voices: Vec<Voice>,
	/// Les angles qui n'ont pas répondu, avec leur motif.
	pub silent: Vec<String>,
	pub cost_usd: f64,
	pub duration_seconds: u64,
}

// ── Où vivent les confrontations ────────────────────────────────────────────

fn panels_dir() -> PathBuf {
	config_dir().join("panels")
}

fn slug(key: &str) -> String {
	key.chars()
		.map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
		.collect()
}

fn path_of(key: &str) -> PathBuf {
	panels_dir().join(format!("{}.json", slug(key)))
}

pub fn read(key: &str) -> Option<Panel> {
	let raw = std::fs::read_to_string(path_of(key)).ok()?;
	serde_json::from_str(&raw).ok()
}

pub fn forget(key: &str) -> Result<()> {
	let _ = std::fs::remove_file(path_of(key));
	Ok(())
}

fn write(panel: &Panel) -> Result<()> {
	std::fs::create_dir_all(panels_dir())
		.map_err(|e| CockpitError::msg(format!("Dossier des confrontations : {e}")))?;
	let raw = serde_json::to_string_pretty(panel)
		.map_err(|e| CockpitError::msg(format!("Confrontation illisible : {e}")))?;
	std::fs::write(path_of(&panel.key), raw)
		.map_err(|e| CockpitError::msg(format!("Écriture de la confrontation : {e}")))
}

/// Les confrontations en cours : quatre agents partent d'un coup, on ne les
/// lance pas deux fois pour un double clic.
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

fn claim(key: &str) -> bool {
	running()
		.lock()
		.map(|mut set| set.insert(key.to_string()))
		.unwrap_or(false)
}

fn release(key: &str) {
	if let Ok(mut set) = running().lock() {
		set.remove(key);
	}
}

fn now() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0)
}

// ── Les consignes ───────────────────────────────────────────────────────────

/// Ce qu'on demande à un angle.
///
/// Court à dessein, et l'inverse de la consigne d'Impact : on ne veut pas un
/// rapport mais un avis. Trois à cinq points, un verdict, rien d'autre — c'est
/// ce qui rend la confrontation payable, puisqu'elle coûte autant de lectures
/// qu'elle a d'angles.
fn lens_prompt(lens: &Lens, product: &str, dossier: &str) -> String {
	let mut prompt = String::new();
	prompt.push_str(
		"Tu lis un changement de code avec un angle précis, et lui seul. D'autres agents \
		 lisent le même changement sous d'autres angles : ne cherche pas à être complet, \
		 cherche à être juste sur ta part.\n\n",
	);
	prompt.push_str(lens.angle);
	prompt.push_str(
		"\n\nTu es dans le dépôt : va lire le code autour du diff plutôt que de conclure sur \
		 ce que le diff montre. Tu ne peux rien modifier.\n\n\
		 N'invente pas de risque pour avoir quelque chose à dire. « Rien de repéré sous cet \
		 angle » est une réponse utile, et une réponse fréquente : c'est même ce qui donne du \
		 poids aux fois où tu signales quelque chose.\n\n",
	);
	if !product.trim().is_empty() {
		prompt.push_str("## Ce que fait ce produit\n\n");
		prompt.push_str(product.trim());
		prompt.push_str("\n\n");
	}
	prompt.push_str(
		"## Ce que tu rends\n\n\
		 Exactement cette forme, rien avant, rien après :\n\n\
		 Verdict: ok | réserves | bloquant\n\
		 Risque: faible | moyen | élevé\n\
		 Résumé: une phrase, deux au plus, disant ce que tu as vu sous ton angle.\n\n\
		 Puis une liste à puces, trois à cinq au maximum, la plus grave en premier. Chaque \
		 puce dit une situation concrète et ce qui s'y produit — pas une inquiétude, pas une \
		 formule de prudence. Si tu n'as rien vu, écris une seule puce : « Rien de repéré \
		 sous cet angle. » suivie d'une raison en une phrase.\n\n\
		 ## Le dossier\n\n",
	);
	prompt.push_str(dossier);
	prompt
}

/// Ce qu'on demande à la synthèse.
///
/// Sa seule valeur est de retirer : ce que tous disent n'a pas besoin d'être lu
/// trois fois, et ce qui reste — le désaccord — est la seule chose qu'un humain
/// soit mieux placé qu'elle pour trancher.
fn merge_prompt(avis: &str) -> String {
	format!(
		"Trois agents ont lu le même changement de code, chacun sous un angle différent. \
		 Leurs avis sont ci-dessous. Ton travail n'est pas de les résumer : c'est de dire où \
		 ils ne sont pas d'accord.\n\n\
		 Un désaccord, ce n'est pas seulement « l'un dit oui, l'autre dit non ». C'en est un \
		 aussi quand l'un signale quelque chose que les autres n'ont pas vu alors qu'ils \
		 auraient dû le croiser, ou quand deux avis décrivent la même chose avec des \
		 conséquences incompatibles.\n\n\
		 N'invente pas de désaccord pour remplir. Trois avis concordants sont un résultat, \
		 et c'est ce qui rend un désaccord digne d'attention quand il y en a un.\n\n\
		 Rends exactement cette forme :\n\n\
		 ## Accord\n\n\
		 Deux lignes au plus : ce que les trois disent, ensemble. Si même ça ne se dégage \
		 pas, écris « Aucun point commun. »\n\n\
		 ## Désaccords\n\n\
		 Une sous-section par désaccord, dans cette forme exacte :\n\n\
		 ### <l'affirmation contestée, en une phrase>\n\
		 - Soutenu par : <noms des angles, séparés par des virgules>\n\
		 - Contesté par : <noms des angles qui disent le contraire ou ne l'ont pas vu>\n\
		 - Pourquoi : <ce qui se passe si le camp qui a raison est celui qu'on n'a pas suivi>\n\
		 - Tranche : <le geste qui règle la question — quoi ouvrir, quoi essayer, quoi \
		 regarder>\n\n\
		 S'il n'y a aucun désaccord, écris sous le titre « Aucun désaccord. » et rien \
		 d'autre.\n\n\
		 ## Les avis\n\n{avis}"
	)
}

// ── La confrontation ────────────────────────────────────────────────────────

/// Fait lire un changement sous trois angles, et ne garde que le désaccord.
pub async fn confront(key: String) -> Result<Panel> {
	if !claim(&key) {
		return Err(CockpitError::msg(
			"Une confrontation de ce changement est déjà en cours.",
		));
	}
	let outcome = confront_inner(&key).await;
	release(&key);
	outcome
}

async fn confront_inner(key: &str) -> Result<Panel> {
	let started = now();
	let project = key
		.strip_prefix("local:")
		.and_then(|rest| rest.split('@').next())
		.map(|id| id.to_string());
	let scan = crate::monitor::scan(project.as_deref()).await?;
	let change = scan
		.changes
		.into_iter()
		.find(|change| change.key == key)
		.ok_or_else(|| {
			CockpitError::msg(
				"Ce changement n'existe plus : la demande de fusion a été fermée, ou la \
				 branche a disparu.",
			)
		})?;

	let base = Config::load();
	let cloisonne = base.projects.len() > 1;
	let mut config = base.clone();
	if let Some(project) = base.projects.iter().find(|p| p.id == change.project) {
		project.merge_into(&mut config, cloisonne);
	}

	let dossier = crate::impact::dossier(&change, &config).await?;
	let cwd = [
		change.worktree.clone(),
		change.repo_path.clone(),
		std::env::temp_dir().to_string_lossy().to_string(),
	]
	.into_iter()
	.find(|candidate| !candidate.is_empty() && std::path::Path::new(candidate).is_dir())
	.ok_or_else(|| CockpitError::msg("Aucun dossier où faire travailler les agents."))?;

	let settings = config.impact.clone();
	// Les trois angles partent ensemble : ils ne dépendent pas les uns des
	// autres, et les enchaîner tripleraient l'attente pour rien.
	let lectures = futures::future::join_all(LENSES.iter().map(|lens| {
		let prompt = lens_prompt(lens, &settings.brief, &dossier);
		let cwd = cwd.clone();
		let settings = settings.clone();
		async move {
			let rendu = crate::agent::run_once(
				&cwd,
				&prompt,
				&settings.engine,
				&settings.model,
				// Jamais la profondeur d'Impact : trois lectures poussées coûtent
				// trois fois ce qu'on accepte de payer pour une. L'angle fait le
				// travail que la profondeur ferait, pour moins cher.
				"",
				&["Write", "Edit", "MultiEdit", "NotebookEdit"],
				crate::executions::Origin::cockpit("confrontation"),
			)
			.await;
			(lens, rendu)
		}
	}))
	.await;

	let mut voices = Vec::new();
	let mut silent = Vec::new();
	let mut cost = 0.0;
	for (lens, rendu) in lectures {
		match rendu {
			Ok(rendu) => {
				cost += rendu.cost_usd;
				voices.push(parse_voice(lens.id, lens.label, &rendu.text, rendu.cost_usd));
			}
			// Un angle muet ne fait pas échouer la confrontation : deux avis
			// valent mieux que rien. Mais il est nommé — un désaccord qu'on n'a
			// pas cherché ne doit pas passer pour un accord.
			Err(error) => silent.push(format!("{} : {error}", lens.label)),
		}
	}

	if voices.is_empty() {
		return Err(CockpitError::msg(format!(
			"Aucun angle n'a répondu. {}",
			silent.join(" — ")
		)));
	}

	let (agreed, disputes, merge_cost) = merge(&voices, &cwd, &settings).await;
	cost += merge_cost;

	let panel = Panel {
		key: key.to_string(),
		head_sha: change.head_sha.clone(),
		at: now(),
		verdict: harshest(&voices),
		agreed,
		disputes,
		voices,
		silent,
		cost_usd: cost,
		duration_seconds: now().saturating_sub(started),
	};
	write(&panel)?;
	crate::journal::record(
		"impact",
		"Confrontation d'un changement",
		&format!("{} {}", change.repo, change.reference),
		true,
		&format!(
			"{} — {} désaccord(s)",
			panel.verdict,
			panel.disputes.len()
		),
	);
	Ok(panel)
}

/// Fait rendre la synthèse, et se rabat sur les faits quand elle échoue.
///
/// Sans synthèse, la confrontation garde sa valeur la plus dure — le verdict le
/// plus sévère et les avis bruts. C'est le confort de lecture qu'on perd, pas la
/// vérification.
async fn merge(
	voices: &[Voice],
	cwd: &str,
	settings: &crate::config::ImpactConfig,
) -> (String, Vec<Dispute>, f64) {
	let avis = voices
		.iter()
		.map(|voice| {
			format!(
				"### {} (verdict : {}, risque : {})\n\n{}\n\n{}",
				voice.label,
				voice.verdict,
				voice.risk,
				voice.summary,
				voice
					.points
					.iter()
					.map(|point| format!("- {point}"))
					.collect::<Vec<_>>()
					.join("\n")
			)
		})
		.collect::<Vec<_>>()
		.join("\n\n");

	match crate::agent::run_once(
		cwd,
		&merge_prompt(&avis),
		&settings.engine,
		&settings.model,
		"",
		&["Write", "Edit", "MultiEdit", "NotebookEdit"],
		crate::executions::Origin::cockpit("confrontation-synthese"),
	)
	.await
	{
		Ok(rendu) => {
			let (agreed, disputes) = parse_merge(&rendu.text);
			(agreed, disputes, rendu.cost_usd)
		}
		Err(error) => (
			format!("La synthèse n'a pas abouti ({error}). Les avis bruts restent lisibles."),
			Vec::new(),
			0.0,
		),
	}
}

/// Le plus sévère des verdicts rendus.
///
/// Et non le plus fréquent : deux angles qui n'ont rien vu ne prouvent pas que
/// le troisième s'est trompé, ils disent seulement qu'ils regardaient ailleurs.
/// Prendre la majorité reviendrait à faire disparaître exactement ce que la
/// confrontation sert à trouver.
fn harshest(voices: &[Voice]) -> String {
	let rank = |verdict: &str| match verdict {
		"bloquant" => 2,
		"réserves" => 1,
		_ => 0,
	};
	voices
		.iter()
		.map(|voice| voice.verdict.clone())
		.max_by_key(|verdict| rank(verdict))
		.unwrap_or_else(|| "ok".into())
}

// ── Relecture de ce que les agents ont écrit ────────────────────────────────

/// Normalise un verdict quelle que soit la façon dont il a été écrit.
fn verdict_of(line: &str) -> Option<String> {
	let bas = line.to_lowercase();
	if bas.contains("bloquant") || bas.contains("blocking") {
		return Some("bloquant".into());
	}
	if bas.contains("réserve") || bas.contains("reserve") || bas.contains("concern") {
		return Some("réserves".into());
	}
	if bas.contains("ok") || bas.contains("rien") {
		return Some("ok".into());
	}
	None
}

fn risk_of(line: &str) -> Option<String> {
	let bas = line.to_lowercase();
	if bas.contains("élevé") || bas.contains("eleve") || bas.contains("high") {
		return Some("élevé".into());
	}
	if bas.contains("moyen") || bas.contains("medium") {
		return Some("moyen".into());
	}
	if bas.contains("faible") || bas.contains("low") {
		return Some("faible".into());
	}
	None
}

/// Découpe l'avis d'un angle.
///
/// Tolérant comme le reste : un avis dont la forme dérive garde ses puces et son
/// texte, et seul ce qui n'a pas été reconnu manque. Perdre un avis payé parce
/// qu'un modèle a mis un tiret là où on attendait deux-points serait absurde.
fn parse_voice(lens: &str, label: &str, text: &str, cost: f64) -> Voice {
	let mut voice = Voice {
		lens: lens.into(),
		label: label.into(),
		verdict: "ok".into(),
		risk: "faible".into(),
		cost_usd: cost,
		..Default::default()
	};

	let mut resume = Vec::new();
	for line in text.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		let bas = trimmed.to_lowercase();
		if bas.starts_with("verdict") {
			if let Some(found) = verdict_of(trimmed) {
				voice.verdict = found;
			}
			continue;
		}
		if bas.starts_with("risque") || bas.starts_with("risk") {
			if let Some(found) = risk_of(trimmed) {
				voice.risk = found;
			}
			continue;
		}
		if let Some(rest) = trimmed
			.strip_prefix("Résumé:")
			.or_else(|| trimmed.strip_prefix("Résumé :"))
			.or_else(|| trimmed.strip_prefix("Resume:"))
		{
			resume.push(rest.trim().to_string());
			continue;
		}
		if let Some(rest) = trimmed
			.strip_prefix("- ")
			.or_else(|| trimmed.strip_prefix("* "))
		{
			let point = rest.trim();
			if !point.is_empty() {
				voice.points.push(point.to_string());
			}
			continue;
		}
		// Ni marqueur ni puce : du texte libre, qui sert de résumé tant qu'on
		// n'en a pas trouvé un déclaré.
		if voice.points.is_empty() && !trimmed.starts_with('#') {
			resume.push(trimmed.to_string());
		}
	}

	voice.summary = resume.join(" ").chars().take(400).collect();
	voice
}

/// Découpe la synthèse en accord et désaccords.
fn parse_merge(text: &str) -> (String, Vec<Dispute>) {
	let mut agreed = Vec::new();
	let mut disputes: Vec<Dispute> = Vec::new();
	// `accord` · `désaccords` · rien : où l'on se trouve dans le rendu.
	let mut zone = "";

	for line in text.lines() {
		let trimmed = line.trim();
		if let Some(title) = trimmed.strip_prefix("### ") {
			let title = title.trim();
			if !title.is_empty() && !title.to_lowercase().starts_with("aucun") {
				disputes.push(Dispute {
					claim: title.to_string(),
					..Default::default()
				});
			}
			continue;
		}
		if let Some(title) = trimmed.strip_prefix("## ") {
			let bas = title.to_lowercase();
			zone = if bas.contains("accord") && !bas.contains("désaccord") && !bas.contains("desaccord")
			{
				"accord"
			} else if bas.contains("désaccord") || bas.contains("desaccord") {
				"désaccords"
			} else {
				""
			};
			continue;
		}
		if trimmed.is_empty() {
			continue;
		}

		if zone == "accord" {
			agreed.push(trimmed.to_string());
			continue;
		}

		let Some(current) = disputes.last_mut() else {
			continue;
		};
		let champ = trimmed
			.trim_start_matches(['-', '*', ' '])
			.trim_start_matches("**");
		let bas = champ.to_lowercase();
		let valeur = |raw: &str| {
			raw.split_once(':')
				.map(|(_, value)| value.trim().trim_start_matches("**").trim().to_string())
				.unwrap_or_default()
		};
		if bas.starts_with("soutenu") {
			current.held_by = noms(&valeur(champ));
		} else if bas.starts_with("contesté") || bas.starts_with("conteste") {
			current.against = noms(&valeur(champ));
		} else if bas.starts_with("pourquoi") {
			current.why = valeur(champ);
		} else if bas.starts_with("tranche") {
			current.check = valeur(champ);
		}
	}

	// Un désaccord sans conséquence nommée n'en est pas un : c'est une nuance de
	// formulation entre deux agents, et la remonter ferait perdre le temps qu'on
	// cherche à faire gagner.
	disputes.retain(|dispute| !dispute.why.trim().is_empty() || !dispute.check.trim().is_empty());

	(
		agreed.join(" ").chars().take(600).collect(),
		disputes,
	)
}

fn noms(raw: &str) -> Vec<String> {
	raw.split(',')
		.map(|part| part.trim().trim_matches('*').trim().to_string())
		.filter(|part| !part.is_empty() && part.to_lowercase() != "aucun")
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn voice(verdict: &str) -> Voice {
		Voice {
			verdict: verdict.into(),
			..Default::default()
		}
	}

	/// La règle qui donne son sens à la confrontation : un risque vu par un seul
	/// angle survit à deux angles qui ne l'ont pas vu.
	#[test]
	fn le_verdict_le_plus_severe_l_emporte() {
		assert_eq!(
			harshest(&[voice("ok"), voice("ok"), voice("bloquant")]),
			"bloquant"
		);
		assert_eq!(
			harshest(&[voice("ok"), voice("réserves"), voice("ok")]),
			"réserves"
		);
		assert_eq!(harshest(&[voice("ok"), voice("ok")]), "ok");
		assert_eq!(harshest(&[]), "ok");
	}

	#[test]
	fn un_avis_bien_forme_se_relit_entierement() {
		let texte = "Verdict: bloquant\nRisque: élevé\nRésumé: la reprise rejoue les points de fidélité.\n\n\
		             - Une commande retentée deux fois crédite deux fois les points.\n\
		             - Le verrou porte sur la session, pas sur le client.";
		let voice = parse_voice("casse", "Ce qui casse", texte, 0.12);
		assert_eq!(voice.verdict, "bloquant");
		assert_eq!(voice.risk, "élevé");
		assert_eq!(voice.summary, "la reprise rejoue les points de fidélité.");
		assert_eq!(voice.points.len(), 2);
		assert_eq!(voice.cost_usd, 0.12);
	}

	/// Un modèle qui ne suit pas la forme ne doit pas coûter l'avis entier.
	#[test]
	fn un_avis_sans_marqueur_garde_ses_puces() {
		let texte = "J'ai regardé la migration.\n\n- Elle ne sait pas se défaire.";
		let voice = parse_voice("exploitation", "Une fois déployé", texte, 0.0);
		assert_eq!(voice.verdict, "ok", "sans verdict lu, on ne dramatise pas");
		assert_eq!(voice.points, vec!["Elle ne sait pas se défaire."]);
		assert!(voice.summary.contains("regardé la migration"));
	}

	#[test]
	fn la_synthese_rend_l_accord_et_les_desaccords() {
		let texte = "## Accord\n\nLe changement fait ce qu'il annonce.\n\n\
		             ## Désaccords\n\n\
		             ### La migration est réversible\n\
		             - Soutenu par : Une fois déployé\n\
		             - Contesté par : Ce qui casse, Pour qui s'en sert\n\
		             - Pourquoi : un retour arrière perdrait les commandes du jour\n\
		             - Tranche : rejouer la migration inverse sur une copie de la base\n";
		let (agreed, disputes) = parse_merge(texte);
		assert_eq!(agreed, "Le changement fait ce qu'il annonce.");
		assert_eq!(disputes.len(), 1);
		assert_eq!(disputes[0].claim, "La migration est réversible");
		assert_eq!(disputes[0].held_by, vec!["Une fois déployé"]);
		assert_eq!(disputes[0].against.len(), 2);
		assert!(disputes[0].why.contains("retour arrière"));
		assert!(disputes[0].check.contains("copie de la base"));
	}

	/// Trois avis concordants sont un résultat : la synthèse doit pouvoir ne
	/// rien remonter sans qu'on fabrique un désaccord vide.
	#[test]
	fn sans_desaccord_rien_n_est_invente() {
		let texte = "## Accord\n\nRien de risqué ici.\n\n## Désaccords\n\nAucun désaccord.\n";
		let (agreed, disputes) = parse_merge(texte);
		assert_eq!(agreed, "Rien de risqué ici.");
		assert!(disputes.is_empty());
	}

	/// Un titre sans conséquence ni geste est une nuance de formulation, pas un
	/// désaccord : le remonter ferait perdre le temps qu'on veut faire gagner.
	#[test]
	fn un_desaccord_sans_consequence_est_ecarte() {
		let texte = "## Désaccords\n\n### Le nommage pourrait être plus clair\n\
		             - Soutenu par : Pour qui s'en sert\n";
		let (_, disputes) = parse_merge(texte);
		assert!(disputes.is_empty());
	}
}
