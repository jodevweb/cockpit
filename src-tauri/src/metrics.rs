//! Mesurer la boucle, sinon on croira qu'elle marche.
//!
//! Tout ce que le cockpit a ajouté — le contexte joint, la confrontation, le
//! carnet, les propriétés — repose sur des convictions. Ce module les confronte
//! à ce qui s'est réellement passé, à partir de ce qui existe déjà : les
//! conversations sur le disque, le carnet, les verdicts, le journal.
//!
//! **Ce n'est pas un tableau de bord.** Il n'y a rien à optimiser ici, et aucun
//! de ces chiffres n'est un objectif : les prendre pour tels produirait
//! exactement le comportement qu'on cherche à éviter — moins de reprises parce
//! qu'on relit moins, moins de désaccords parce qu'on confronte moins.
//!
//! Ce qu'il sert à voir tient en une phrase : **est-ce que les garde-fous
//! attrapent encore quelque chose ?** Un garde-fou qui n'a rien signalé depuis
//! des semaines n'est pas une bonne nouvelle, c'est un soupçon — soit le code
//! est devenu parfait, soit le filet est troué. Les alertes de ce module disent
//! toutes la même chose sous des formes différentes.

use serde::Serialize;

/// Fenêtre d'observation. Assez longue pour lisser une semaine creuse, assez
/// courte pour parler du travail d'aujourd'hui et non de celui du trimestre.
const WINDOW_DAYS: i64 = 30;

/// Ce que les agents ont livré, et ce qu'il a fallu reprendre.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Handbacks {
	pub delivered: u64,
	pub taken_back: u64,
	/// Part des rendus repris à la main, en pourcentage entier.
	pub rate: u64,
	/// Depuis quand on compte, en secondes epoch.
	pub since: u64,
	pub pending: usize,
	/// Le même taux, selon qu'un dossier de contexte était parti ou non.
	pub briefed: Side,
	pub plain: Side,
	/// Assez d'observations des deux côtés pour qu'un écart veuille dire
	/// quelque chose.
	pub comparable: bool,
}

/// Une population de rendus, et ce qu'elle a coûté en reprises.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Side {
	pub delivered: u64,
	pub taken_back: u64,
	pub rate: u64,
}

/// En deçà, on n'affiche pas de comparaison.
///
/// Cinq rendus de chaque côté ne prouvent rien non plus, mais en dessous
/// l'écart est du bruit pur — et un chiffre affiché est un chiffre qu'on croit.
const COMPARABLE_AT: u64 = 5;

fn side(delivered: u64, taken_back: u64) -> Side {
	Side {
		delivered,
		taken_back,
		rate: if delivered == 0 {
			0
		} else {
			(taken_back * 100) / delivered
		},
	}
}

/// Ce qu'il a fallu d'échanges pour arriver au bout.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Turns {
	pub sessions: usize,
	/// Médiane des messages humains par conversation.
	///
	/// La médiane et non la moyenne : une seule session de trente relances
	/// tirerait une moyenne vers le haut et ferait croire à un problème général.
	pub median: usize,
	/// Conversations qui ont demandé plus de dix relances.
	pub long_haul: usize,
	/// Celles qui se sont terminées sur une erreur.
	pub with_error: usize,
}

/// Ce que les garde-fous ont attrapé, et ce qu'ils valent.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Guardrails {
	pub properties: usize,
	/// Éprouvées sur les correctifs du dépôt.
	pub calibrated: usize,
	/// Éprouvées sans rien attraper : elles rassurent sans garantir.
	pub decorative: usize,
	/// Vérifications menées, et propriétés enfreintes qu'elles ont trouvées.
	pub audits: usize,
	pub breaches: usize,
	/// Confrontations menées, et désaccords qu'elles ont remontés.
	pub panels: usize,
	pub disputes: usize,
}

/// Ce que le carnet a retenu, et ce qui s'en sert.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
	pub lessons: usize,
	/// Fois où une leçon est partie avec un agent, toutes leçons confondues.
	pub uses: usize,
	/// Leçons qui n'ont jamais servi.
	pub idle: usize,
	/// Leçons sans emploi depuis deux mois.
	pub stale: usize,
}

/// Ce que le cockpit a fait, par nature d'action **et par acteur**.
///
/// Séparer les deux n'est pas un raffinement : le titre de ce bloc dit « en ton
/// nom », et le jour où la Permanence agit seule, additionner ses gestes aux
/// tiens rendrait la phrase fausse sans que rien ne le signale.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Deed {
	pub kind: String,
	pub count: usize,
	pub failed: usize,
	/// `me` ou `permanence` — voir `journal::HUMAN`.
	pub actor: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
	pub window_days: i64,
	pub handbacks: Handbacks,
	pub turns: Turns,
	pub guardrails: Guardrails,
	pub memory: Memory,
	pub deeds: Vec<Deed>,
	/// Ce qui mérite un regard — jamais un ordre, jamais un score.
	pub warnings: Vec<String>,
}

fn now() -> i64 {
	chrono::Utc::now().timestamp()
}

fn median(mut values: Vec<usize>) -> usize {
	if values.is_empty() {
		return 0;
	}
	values.sort_unstable();
	values[values.len() / 2]
}

/// Rassemble ce qui s'est passé, sans rien demander à personne.
pub fn collect(project: &str) -> Metrics {
	let cutoff = now() - WINDOW_DAYS * 86_400;

	// ── Les reprises ────────────────────────────────────────────────────
	let tally = crate::notebook::tally();
	let briefed = side(tally.delivered_briefed, tally.taken_back_briefed);
	let plain = side(
		tally.delivered.saturating_sub(tally.delivered_briefed),
		tally.taken_back.saturating_sub(tally.taken_back_briefed),
	);
	let handbacks = Handbacks {
		delivered: tally.delivered,
		taken_back: tally.taken_back,
		rate: if tally.delivered == 0 {
			0
		} else {
			(tally.taken_back * 100) / tally.delivered
		},
		since: tally.since,
		pending: crate::notebook::handbacks(project).len(),
		comparable: briefed.delivered >= COMPARABLE_AT && plain.delivered >= COMPARABLE_AT,
		briefed,
		plain,
	};

	// ── Les conversations ───────────────────────────────────────────────
	let mut messages = Vec::new();
	let mut long_haul = 0;
	let mut with_error = 0;
	if let Ok(projects) = crate::sessions::scan_all(60) {
		for entry in projects {
			for session in entry.sessions {
				let stamp = session
					.updated_at
					.as_deref()
					.and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
					.map(|date| date.timestamp())
					.unwrap_or(0);
				if stamp < cutoff {
					continue;
				}
				// Une conversation d'un seul message n'a rien à dire sur le nombre
				// d'allers-retours : elle n'a pas encore commencé.
				if session.user_messages == 0 {
					continue;
				}
				messages.push(session.user_messages);
				if session.user_messages > 10 {
					long_haul += 1;
				}
				if session.has_error {
					with_error += 1;
				}
			}
		}
	}
	let turns = Turns {
		sessions: messages.len(),
		median: median(messages),
		long_haul,
		with_error,
	};

	// ── Les garde-fous ──────────────────────────────────────────────────
	let config = if project.is_empty() {
		crate::config::Config::active()
	} else {
		crate::config::Config::for_repo(project)
	};
	let calibrations = crate::properties::read_calibrations(project);
	let guardrails = Guardrails {
		properties: config.properties.len(),
		calibrated: calibrations.iter().filter(|entry| entry.tried > 0).count(),
		decorative: calibrations.iter().filter(|entry| entry.decorative()).count(),
		..Default::default()
	};

	// ── La mémoire ──────────────────────────────────────────────────────
	let lessons = crate::notebook::lessons(project);
	let memory = Memory {
		lessons: lessons.len(),
		uses: lessons.iter().map(|lesson| lesson.uses).sum(),
		idle: lessons.iter().filter(|lesson| lesson.uses == 0).count(),
		stale: lessons.iter().filter(|lesson| crate::notebook::stale(lesson)).count(),
	};

	// ── Ce que le cockpit a fait ────────────────────────────────────────
	let mut deeds: Vec<Deed> = Vec::new();
	for entry in crate::journal::list(500) {
		if (entry.at as i64) < cutoff {
			continue;
		}
		match deeds
			.iter_mut()
			.find(|deed| deed.kind == entry.kind && deed.actor == entry.actor)
		{
			Some(deed) => {
				deed.count += 1;
				if !entry.ok {
					deed.failed += 1;
				}
			}
			None => deeds.push(Deed {
				kind: entry.kind.clone(),
				count: 1,
				failed: usize::from(!entry.ok),
				actor: entry.actor.clone(),
			}),
		}
	}
	deeds.sort_by(|a, b| b.count.cmp(&a.count));

	let mut metrics = Metrics {
		window_days: WINDOW_DAYS,
		handbacks,
		turns,
		guardrails,
		memory,
		deeds,
		warnings: Vec::new(),
	};
	metrics.warnings = warnings(&metrics);
	metrics
}

/// Ce qui mérite un regard.
///
/// Toutes ces alertes disent la même chose : un dispositif qui ne signale plus
/// rien n'est pas forcément un dispositif qui marche. C'est la seule chose que
/// ce module ait à dire, et il vaut mieux la dire plusieurs fois qu'une seule.
fn warnings(metrics: &Metrics) -> Vec<String> {
	let mut out = Vec::new();

	if metrics.guardrails.properties == 0 {
		out.push(crate::i18n::t("metrics.noProperties"));
	} else if metrics.guardrails.calibrated == 0 {
		out.push(crate::i18n::t("metrics.uncalibrated"));
	}

	if metrics.guardrails.decorative > 0 {
		out.push(crate::i18n::tf(
			"metrics.decorative",
			&[("count", &metrics.guardrails.decorative)],
		));
	}

	if metrics.memory.idle > 0 && metrics.memory.lessons > 0 {
		out.push(crate::i18n::tf(
			"metrics.idleLessons",
			&[("idle", &metrics.memory.idle), ("total", &metrics.memory.lessons)],
		));
	}

	if metrics.handbacks.delivered >= 20 && metrics.handbacks.taken_back == 0 {
		out.push(crate::i18n::t("metrics.noTakeBack"));
	}

	if metrics.handbacks.rate >= 50 && metrics.handbacks.delivered >= 10 {
		out.push(crate::i18n::tf(
			"metrics.takeBackRate",
			&[("rate", &metrics.handbacks.rate)],
		));
	}

	if metrics.turns.long_haul > 0 && metrics.turns.sessions > 0 {
		let part = metrics.turns.long_haul * 100 / metrics.turns.sessions;
		if part >= 30 {
			out.push(crate::i18n::tf("metrics.longHaul", &[("part", &part)]));
		}
	}

	out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn base() -> Metrics {
		Metrics {
			guardrails: Guardrails {
				properties: 3,
				calibrated: 3,
				..Default::default()
			},
			..Default::default()
		}
	}

	#[test]
	fn la_mediane_ignore_l_exception() {
		// Une session de trente relances ne doit pas décrire les huit autres.
		assert_eq!(median(vec![2, 3, 3, 4, 30]), 3);
		assert_eq!(median(vec![]), 0);
		assert_eq!(median(vec![7]), 7);
	}

	#[test]
	fn un_taux_se_calcule_sans_diviser_par_zero() {
		assert_eq!(side(0, 0).rate, 0);
		assert_eq!(side(10, 3).rate, 30);
		assert_eq!(side(3, 3).rate, 100);
	}

	/// Le seuil existe pour une raison : sous quelques rendus de chaque côté,
	/// l'écart entre les deux taux est du bruit — et un chiffre affiché est un
	/// chiffre qu'on croit.
	#[test]
	fn la_comparaison_attend_d_avoir_les_deux_cotes() {
		let comparable = |briefed: u64, plain: u64| briefed >= COMPARABLE_AT && plain >= COMPARABLE_AT;
		assert!(!comparable(20, 0), "rien sans contexte : rien à comparer");
		assert!(!comparable(0, 20), "rien avec contexte : rien à comparer");
		assert!(!comparable(4, 40), "quatre rendus d'un côté ne disent rien");
		assert!(comparable(5, 5));
	}

	#[test]
	fn sans_propriete_declaree_on_le_dit() {
		let mut metrics = base();
		metrics.guardrails.properties = 0;
		let found = warnings(&metrics);
		assert!(found.iter().any(|line| line.contains("No property declared")));
	}

	/// La mise en garde qui compte : un dispositif muet n'est pas un dispositif
	/// qui marche.
	#[test]
	fn des_proprietes_jamais_eprouvees_sont_signalees() {
		let mut metrics = base();
		metrics.guardrails.calibrated = 0;
		assert!(warnings(&metrics).iter().any(|line| line.contains("can fail")));
	}

	#[test]
	fn une_propriete_decorative_est_nommee() {
		let mut metrics = base();
		metrics.guardrails.decorative = 2;
		assert!(warnings(&metrics)
			.iter()
			.any(|line| line.contains("2 property(ies) caught nothing")));
	}

	/// Zéro reprise sur beaucoup de rendus : le chiffre flatteur qui doit
	/// inquiéter plutôt que rassurer.
	#[test]
	fn aucune_reprise_sur_beaucoup_de_rendus_inquiete() {
		let mut metrics = base();
		metrics.handbacks.delivered = 40;
		metrics.handbacks.taken_back = 0;
		assert!(warnings(&metrics)
			.iter()
			.any(|line| line.contains("nobody reviews anymore")));

		// Trois rendus sans reprise ne prouvent rien : on se tait.
		metrics.handbacks.delivered = 3;
		assert!(!warnings(&metrics)
			.iter()
			.any(|line| line.contains("nobody reviews anymore")));
	}

	#[test]
	fn un_rendu_sur_deux_repris_se_dit() {
		let mut metrics = base();
		metrics.handbacks.delivered = 20;
		metrics.handbacks.taken_back = 12;
		metrics.handbacks.rate = 60;
		assert!(warnings(&metrics)
			.iter()
			.any(|line| line.contains("taken back by hand")));
	}

	#[test]
	fn une_boucle_saine_ne_dit_rien() {
		let mut metrics = base();
		metrics.handbacks.delivered = 30;
		metrics.handbacks.taken_back = 4;
		metrics.handbacks.rate = 13;
		metrics.memory.lessons = 3;
		metrics.memory.idle = 0;
		metrics.turns.sessions = 20;
		metrics.turns.long_haul = 2;
		assert!(
			warnings(&metrics).is_empty(),
			"rien à signaler : {:?}",
			warnings(&metrics)
		);
	}
}
