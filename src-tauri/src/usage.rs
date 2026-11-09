//! Consommation Claude Code, reconstituée depuis les journaux locaux.
//!
//! Chaque réponse d'assistant porte son `usage` dans le JSONL de la session :
//! en les additionnant on obtient une mesure exacte de ce qui a été consommé,
//! par jour, par modèle et par dossier de travail.
//!
//! Ce que ces fichiers ne contiennent pas : le plafond de l'abonnement et sa
//! date de renouvellement. Le champ `rateLimits` des journaux est
//! systématiquement `null`, et le cache de statistiques du CLI ne compte que des
//! jetons. Les totaux calculés ici sont donc des volumes, pas des parts.
//!
//! Ces plafonds existent pourtant : le CLI les connaît et les dit à qui lui
//! demande `/usage`. On les lui demande — voir `limits()` — et on les présente
//! à part, avec la mise en garde qu'il y attache : ils ne voient que cette
//! machine.

use crate::error::Result;
use crate::sessions::projects_roots;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
	pub input: u64,
	pub output: u64,
	pub cache_read: u64,
	pub cache_write: u64,
	/// Réponses d'assistant comptabilisées.
	pub messages: u64,
}

impl Totals {
	fn add(&mut self, other: &Totals) {
		self.input += other.input;
		self.output += other.output;
		self.cache_read += other.cache_read;
		self.cache_write += other.cache_write;
		self.messages += other.messages;
	}
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
	/// Date `AAAA-MM-JJ`, nom de modèle ou dossier, selon la série.
	pub key: String,
	pub label: String,
	pub totals: Totals,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
	pub generated_at: String,
	/// Fenêtre glissante de cinq heures — l'unité sur laquelle Claude compte.
	pub last_5h: Totals,
	pub today: Totals,
	pub last_7_days: Totals,
	pub last_30_days: Totals,
	pub all_time: Totals,
	/// Les 30 derniers jours, du plus ancien au plus récent.
	pub by_day: Vec<Bucket>,
	pub by_model: Vec<Bucket>,
	pub by_worktree: Vec<Bucket>,
	/// Ce que chaque mission a consommé, tous ses worktrees additionnés.
	pub by_mission: Vec<Bucket>,
	/// Vrai si un journal a déjà porté une information de plafond ; sert à
	/// signaler honnêtement qu'aucun quota n'est lisible.
	pub rate_limit_seen: bool,
}

/// Ce qu'on dépense, ramené à ce qui tient dans un coin d'écran.
///
/// **Toujours visible, et c'est le point.** Le reste de ce module est un écran
/// qu'on ouvre ; celui-ci se lit sans rien ouvrir. Un dispositif qui fait
/// travailler des modèles pour vous doit dire ce qu'il coûte pendant qu'il le
/// fait — pas une fois la facture arrivée, et pas seulement à qui pense à
/// aller regarder.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
	/// Jetons consommés aujourd'hui, entrée et sortie confondues.
	///
	/// Des jetons et non des euros : sur un abonnement, rien n'est débité et un
	/// montant en dollars ferait croire à une facture qui n'existe pas. Ce qui
	/// décide, c'est le quota — d'où `remaining` juste en dessous.
	pub today: u64,
	/// Sur la fenêtre glissante de cinq heures, l'unité sur laquelle Claude
	/// compte.
	pub window: u64,
	/// Ce qu'il reste du quota le plus serré, en pourcentage. `None` quand le
	/// CLI ne l'annonce pas — et « on ne sait pas » n'est pas « tout va bien ».
	pub remaining: Option<u32>,
	/// L'intitulé de ce quota, pour que le chiffre veuille dire quelque chose.
	pub tightest: String,
	/// Quand il repart.
	pub resets_at: String,
	/// Tous les compteurs du dernier relevé, dans l'ordre où le CLI les donne.
	///
	/// Le témoin n'en montre qu'un ; le sélecteur de modèle, lui, a besoin de
	/// tous : un modèle qui tire sur un compteur dédié — Fable — ne se paie pas
	/// comme un modèle qui tire sur le compteur commun, et c'est cette
	/// différence-là qu'on veut lire avant de choisir. Vide tant qu'aucun relevé
	/// n'a été fait : lire les plafonds coûte un lancement du CLI, et on ne le
	/// déclenche pas pour ouvrir un menu.
	pub quotas: Vec<Limit>,
}

/// Un plafond d'abonnement, tel que le CLI le rapporte.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
	/// `session` ou `week` : ce que le code compare. Le libellé, lui, est
	/// traduit et ne se compare jamais.
	pub kind: String,
	/// « Session en cours », « Cette semaine », « Cette semaine (Fable) »…
	pub label: String,
	pub percent: u32,
	/// Quand le compteur repart, tel que le CLI l'écrit. Vide si non annoncé.
	pub resets_at: String,
}

/// Ce que l'abonnement autorise encore, et quand il se renouvelle.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
	pub limits: Vec<Limit>,
	/// Ce que le CLI dit de la provenance des chiffres — à recopier tel quel :
	/// ils ne couvrent que cette machine, et l'omettre les ferait passer pour
	/// une vérité de compte.
	pub note: String,
	pub checked_at: String,
	/// Pourquoi la lecture a échoué, le cas échéant.
	pub error: String,
}

/// Ce qu'on dépense, sans rien lancer.
///
/// Ne lit que les journaux déjà sur le disque : contrairement à [`limits`],
/// cet appel ne démarre aucun processus et peut donc se rafraîchir souvent. Le
/// quota, lui, est celui du dernier relevé — on ne relance pas un CLI pour
/// afficher un témoin.
pub fn spend(roots: &[String], last_limits: Option<&Limits>) -> Spend {
	let report = match report_for(roots, &[]) {
		Ok(report) => report,
		Err(_) => return Spend::default(),
	};
	let today = report.today.input + report.today.output + report.today.cache_read + report.today.cache_write;

	// La contrainte qui mordra la première, jamais une moyenne : c'est elle qui
	// décidera, et c'est donc elle qu'on veut sous les yeux.
	let tightest = last_limits
		.map(|limits| limits.limits.iter().max_by_key(|limit| limit.percent))
		.unwrap_or(None);

	Spend {
		today,
		window: report.last_5h.input + report.last_5h.output + report.last_5h.cache_read + report.last_5h.cache_write,
		remaining: tightest.map(|limit| 100u32.saturating_sub(limit.percent)),
		tightest: tightest.map(|limit| limit.label.clone()).unwrap_or_default(),
		resets_at: tightest.map(|limit| limit.resets_at.clone()).unwrap_or_default(),
		// Tous les compteurs, pas seulement le plus serré : c'est le seul moyen
		// de dire d'un modèle donné sur quel quota il tire. Fable a le sien, et
		// « compris dans le forfait » n'y répond pas de la même façon que pour
		// Opus. Recopiés du dernier relevé, jamais redemandés.
		quotas: last_limits.map(|limits| limits.limits.clone()).unwrap_or_default(),
	}
}

/// Ce qu'une conversation a consommé depuis son premier message.
///
/// Distinct de la jauge de contexte, qui montre ce que le modèle a **sous les
/// yeux** au dernier tour : une conversation peut occuper 8 % de sa fenêtre
/// tout en ayant coûté un million de jetons, parce que chaque tour repaie la
/// lecture de tout ce qui précède. Les deux chiffres répondent à deux questions
/// — « est-ce que ça va tenir ? » et « combien ça m'a coûté ? » — et le second
/// n'était nulle part.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpend {
	/// Jetons de cette conversation, cache compris.
	pub total: u64,
	/// Sa part de ce qui a été consommé sur la fenêtre glissante de cinq heures.
	///
	/// C'est la seule mise en rapport honnête qu'on puisse faire : le quota est
	/// annoncé en pourcentage, jamais en jetons, et convertir l'un en l'autre
	/// demanderait de supposer un plafond que personne ne publie.
	pub share: u32,
	/// Ce qu'il reste du quota le plus serré. `None` si le CLI ne l'annonce pas.
	pub remaining: Option<u32>,
	pub tightest: String,
	pub resets_at: String,
}

/// Ce qu'a coûté une conversation, retrouvée par son identifiant.
pub fn session_spend(session_id: &str, roots: &[String], last_limits: Option<&Limits>) -> SessionSpend {
	let Ok(projects) = crate::sessions::scan_all(60) else {
		return SessionSpend::default();
	};
	let found = projects
		.iter()
		.flat_map(|entry| entry.sessions.iter())
		.find(|session| session.id == session_id);
	let Some(session) = found else {
		return SessionSpend::default();
	};

	let total = session.usage.input + session.usage.output + session.usage.cache_read + session.usage.cache_write;

	let window = report_for(roots, &[])
		.map(|report| {
			report.last_5h.input + report.last_5h.output + report.last_5h.cache_read + report.last_5h.cache_write
		})
		.unwrap_or(0);

	let tightest = last_limits
		.map(|limits| limits.limits.iter().max_by_key(|limit| limit.percent))
		.unwrap_or(None);

	SessionSpend {
		total,
		// Une part de zéro n'a pas de sens : sans fenêtre mesurée, on ne prétend
		// pas savoir quelle place cette conversation y tient.
		share: if window == 0 {
			0
		} else {
			((total.min(window) * 100) / window) as u32
		},
		remaining: tightest.map(|limit| 100u32.saturating_sub(limit.percent)),
		tightest: tightest.map(|limit| limit.label.clone()).unwrap_or_default(),
		resets_at: tightest.map(|limit| limit.resets_at.clone()).unwrap_or_default(),
	}
}

/// Interroge le CLI sur les plafonds de l'abonnement.
///
/// Aucun fichier local ne les porte : le cache de statistiques du CLI compte des
/// jetons, jamais un quota. Seule la commande `/usage` sait les dire, et il faut
/// donc la lui demander — ce qui coûte un lancement de CLI, d'où le cache en
/// amont plutôt qu'un appel à chaque affichage.
pub async fn limits() -> Limits {
	let binary = match crate::agent::claude_binary() {
		Some(path) => path,
		None => {
			return Limits {
				error: crate::i18n::t("usage.claudeNotFound"),
				..Default::default()
			}
		}
	};

	let mut commande = tokio::process::Command::new(&binary);
	commande
		.args(["-p", "/usage"])
		.current_dir(dirs::home_dir().unwrap_or_default());
	crate::platform::quiet_async(&mut commande);
	// Les plafonds sont ceux d'un compte, pas d'un poste : les demander sans dire
	// lequel rendait ceux du compte par défaut, même en pilotant un projet
	// rattaché à un autre — un quota rassurant emprunté à quelqu'un d'autre.
	for (name, value) in crate::config::account_env(&crate::config::Config::active()) {
		commande.env(name, value);
	}
	let sortie = commande.output().await;

	let texte = match sortie {
		Ok(sortie) if sortie.status.success() => String::from_utf8_lossy(&sortie.stdout).to_string(),
		Ok(sortie) => {
			return Limits {
				error: String::from_utf8_lossy(&sortie.stderr)
					.lines()
					.next()
					.map(str::to_string)
					.unwrap_or_else(|| crate::i18n::t("usage.cliRefused")),
				..Default::default()
			}
		}
		Err(error) => {
			return Limits {
				error: crate::i18n::tf("usage.limitsRead", &[("error", &error)]),
				..Default::default()
			}
		}
	};

	parse_limits(&texte)
}

/// Lit les plafonds dans ce que `/usage` écrit.
///
/// Le format est celui d'un texte destiné à un humain : on n'en extrait que ce
/// qui est stable — un intitulé, un pourcentage, une échéance — et on laisse
/// tomber le reste plutôt que d'inventer une structure qu'il n'a pas.
fn parse_limits(texte: &str) -> Limits {
	let mut limits = Vec::new();
	let mut note = String::new();

	for ligne in texte.lines() {
		let ligne = ligne.trim();
		if ligne.starts_with("Approximate,") {
			note = ligne.to_string();
			continue;
		}
		let Some(reste) = ligne.strip_prefix("Current ") else {
			continue;
		};
		let Some((intitule, valeur)) = reste.split_once(':') else {
			continue;
		};
		let Some((pourcent, echeance)) = valeur.trim().split_once("% used") else {
			continue;
		};
		let Ok(percent) = pourcent.trim().parse::<u32>() else {
			continue;
		};

		let intitule = intitule.trim();
		limits.push(Limit {
			kind: if intitule == "session" { "session" } else { "week" }.to_string(),
			label: match intitule {
				"session" => crate::i18n::t("usage.limits.session"),
				"week (all models)" => crate::i18n::t("usage.limits.week"),
				autre => {
					let autre = autre.strip_prefix("week ").unwrap_or(autre);
					format!("{} {autre}", crate::i18n::t("usage.limits.week"))
				}
			},
			percent,
			resets_at: echeance
				.split_once("resets ")
				.map(|(_, quand)| quand.trim().to_string())
				.unwrap_or_default(),
		});
	}

	Limits {
		limits,
		note,
		checked_at: chrono::Utc::now().to_rfc3339(),
		error: String::new(),
	}
}

/// Une entrée d'assistant réduite à ce qui compte pour la comptabilité.
#[derive(Clone)]
struct Sample {
	at: DateTime<Utc>,
	model: String,
	cwd: String,
	totals: Totals,
}

/// Relevés déjà calculés pour un fichier, tant qu'il n'a pas bougé.
struct Cached {
	mtime: i64,
	size: u64,
	samples: Vec<Sample>,
}

/// Les journaux pèsent plusieurs centaines de mégaoctets et ne changent qu'à la
/// marge : tout relire à chaque calcul bloquait l'application plusieurs
/// secondes. On garde les relevés par fichier et on ne rouvre que ceux dont la
/// taille ou la date a changé.
fn cache() -> &'static std::sync::Mutex<HashMap<std::path::PathBuf, Cached>> {
	static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<std::path::PathBuf, Cached>>> =
		std::sync::OnceLock::new();
	CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn read_samples() -> Vec<Sample> {
	let mut samples = Vec::new();

	// Ce qui a été consommé l'a été par le poste, quel que soit le compte qui
	// signait : les courbes montrent le travail fait, pas l'identité sous
	// laquelle il l'a été.
	for entry in projects_roots()
		.iter()
		.flat_map(|root| walkdir::WalkDir::new(root).follow_links(false))
		.filter_map(|e| e.ok())
	{
		let path = entry.path();
		if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
			continue;
		}

		let stamp = std::fs::metadata(path).ok().map(|meta| {
			let mtime = meta
				.modified()
				.ok()
				.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
				.map(|d| d.as_secs() as i64)
				.unwrap_or(0);
			(mtime, meta.len())
		});

		if let Some((mtime, size)) = stamp {
			if let Ok(store) = cache().lock() {
				if let Some(entry) = store.get(path) {
					if entry.mtime == mtime && entry.size == size {
						samples.extend(entry.samples.iter().cloned());
						continue;
					}
				}
			}
		}

		let before = samples.len();
		let Ok(content) = std::fs::read_to_string(path) else {
			continue;
		};

		// Le `cwd` n'est pas répété sur chaque ligne : on retient le dernier vu.
		let mut cwd = String::new();
		for line in content.lines() {
			if !line.contains("\"usage\"") && !line.contains("\"cwd\"") {
				continue;
			}
			let Ok(value) = serde_json::from_str::<Value>(line) else {
				continue;
			};
			if let Some(found) = value.get("cwd").and_then(|v| v.as_str()) {
				// Sous Windows, le CLI écrit `C:\Users\…` ; les chantiers se
				// comparent et se découpent sur `/`.
				cwd = crate::platform::display_path(std::path::Path::new(found));
			}
			let Some(usage) = value.pointer("/message/usage") else {
				continue;
			};
			let Some(at) = value
				.get("timestamp")
				.and_then(|v| v.as_str())
				.and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
				.map(|date| date.with_timezone(&Utc))
			else {
				continue;
			};

			let read = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
			let totals = Totals {
				input: read("input_tokens"),
				output: read("output_tokens"),
				cache_read: read("cache_read_input_tokens"),
				cache_write: read("cache_creation_input_tokens"),
				messages: 1,
			};
			// Les entrées sans aucun jeton sont des accusés de réception.
			if totals.input + totals.output + totals.cache_read + totals.cache_write == 0 {
				continue;
			}

			samples.push(Sample {
				at,
				model: value
					.pointer("/message/model")
					.and_then(|v| v.as_str())
					.unwrap_or("inconnu")
					.to_string(),
				cwd: cwd.clone(),
				totals,
			});
		}

		if let Some((mtime, size)) = stamp {
			if let Ok(mut store) = cache().lock() {
				store.insert(
					path.to_path_buf(),
					Cached {
						mtime,
						size,
						samples: samples[before..].to_vec(),
					},
				);
			}
		}
	}

	samples
}

/// Nom lisible d'un modèle (`claude-opus-5-20260115` → `opus-5`).
fn model_label(model: &str) -> String {
	let trimmed = model.trim_start_matches("claude-");
	let mut parts: Vec<&str> = trimmed.split('-').collect();
	// La date de version en fin de nom n'apprend rien ici.
	if parts
		.last()
		.is_some_and(|last| last.len() == 8 && last.chars().all(|c| c.is_ascii_digit()))
	{
		parts.pop();
	}
	if parts.is_empty() {
		model.to_string()
	} else {
		parts.join("-")
	}
}

fn folder_label(cwd: &str) -> String {
	if cwd.is_empty() {
		return "hors worktree".into();
	}
	cwd.rsplit('/').next().unwrap_or(cwd).to_string()
}

/// Le chantier auquel appartient un dossier de travail.
///
/// Un agent ne travaille pas à la racine : il descend dans `apps/api`,
/// `packages/ui`, et c'est ce dossier-là que son journal enregistre. Regroupé
/// tel quel, le relevé alignait « api », « fo », « packages » — des morceaux de
/// monorepo — là où l'on cherche « sur quel chantier partent mes jetons ». On
/// remonte donc chaque dossier à la racine qui le contient.
///
/// La racine la plus longue gagne : un worktree peut vivre dans un autre, et
/// c'est toujours le plus précis qui décrit le travail.
fn rattach<'a>(cwd: &str, roots: &'a [String]) -> Option<&'a String> {
	roots
		.iter()
		.filter(|root| cwd == root.as_str() || cwd.starts_with(&format!("{root}/")))
		.max_by_key(|root| root.len())
}

fn ranked(map: HashMap<String, Totals>, label: impl Fn(&str) -> String) -> Vec<Bucket> {
	let mut buckets: Vec<Bucket> = map
		.into_iter()
		.map(|(key, totals)| Bucket {
			label: label(&key),
			key,
			totals,
		})
		.collect();
	// Les jetons produits pèsent le plus lourd : on classe dessus.
	buckets.sort_by(|a, b| (b.totals.output + b.totals.input).cmp(&(a.totals.output + a.totals.input)));
	buckets
}

/// Les relevés, rattachés aux chantiers qu'on connaît.
///
/// `roots` sont les racines des worktrees, `missions` celles qui appartiennent à
/// une mission, avec son titre. Rien n'est deviné ici : c'est l'appelant qui sait
/// ce qui existe, et un dossier qu'il ne connaît pas reste compté sous son propre
/// nom plutôt que d'être écarté.
pub fn report_for(roots: &[String], missions: &[(String, String)]) -> Result<UsageReport> {
	let samples = read_samples();
	let now = Utc::now();
	let today = now.date_naive();

	let mut last_5h = Totals::default();
	let mut today_totals = Totals::default();
	let mut last_7 = Totals::default();
	let mut last_30 = Totals::default();
	let mut all_time = Totals::default();
	let mut by_day: HashMap<String, Totals> = HashMap::new();
	let mut by_model: HashMap<String, Totals> = HashMap::new();
	let mut by_worktree: HashMap<String, Totals> = HashMap::new();
	let mut by_mission: HashMap<String, Totals> = HashMap::new();

	for sample in &samples {
		all_time.add(&sample.totals);

		let age = now - sample.at;
		if age <= Duration::hours(5) {
			last_5h.add(&sample.totals);
		}
		if sample.at.date_naive() == today {
			today_totals.add(&sample.totals);
		}
		if age <= Duration::days(7) {
			last_7.add(&sample.totals);
		}
		if age <= Duration::days(30) {
			last_30.add(&sample.totals);
			by_day
				.entry(sample.at.date_naive().to_string())
				.or_default()
				.add(&sample.totals);
			by_model.entry(sample.model.clone()).or_default().add(&sample.totals);
			let chantier = rattach(&sample.cwd, roots)
				.cloned()
				.unwrap_or_else(|| sample.cwd.clone());
			by_worktree.entry(chantier.clone()).or_default().add(&sample.totals);

			// Une mission tient plusieurs worktrees : ce que ses agents consomment
			// n'a de sens qu'additionné sous son nom.
			if let Some((_, titre)) = missions
				.iter()
				.find(|(path, _)| path == &chantier || chantier.starts_with(&format!("{path}/")))
			{
				by_mission.entry(titre.clone()).or_default().add(&sample.totals);
			}
		}
	}

	let mut days = ranked(by_day, |key| key.to_string());
	days.sort_by(|a, b| a.key.cmp(&b.key));

	Ok(UsageReport {
		generated_at: now.to_rfc3339(),
		last_5h,
		today: today_totals,
		last_7_days: last_7,
		last_30_days: last_30,
		all_time,
		by_day: days,
		by_model: ranked(by_model, model_label),
		by_worktree: ranked(by_worktree, folder_label),
		by_mission: ranked(by_mission, |key| key.to_string()),
		// Aucun journal local n'a jamais porté de plafond exploitable.
		rate_limit_seen: false,
	})
}

#[cfg(test)]
mod limit_tests {
	use super::*;

	/// Le CLI écrit pour un humain : ce qu'on en extrait doit résister à sa
	/// mise en forme, et ignorer ce qui n'a pas de structure stable.
	#[test]
	fn les_plafonds_se_lisent_dans_la_sortie_du_cli() {
		let sortie = "You are currently using your subscription to power your Claude Code usage\n\
			\n\
			Current session: 20% used · resets Aug 4 at 8:20pm (Europe/Paris)\n\
			Current week (all models): 21% used · resets Aug 10 at 12pm (Europe/Paris)\n\
			Current week (Fable): 0% used\n\
			\n\
			What's contributing to your limits usage?\n\
			Approximate, based on local sessions on this machine — does not include other devices.\n\
			\n\
			Last 24h · 7278 requests · 52 sessions\n";

		let lu = parse_limits(sortie);
		assert_eq!(lu.limits.len(), 3, "trois plafonds annoncés");

		assert_eq!(lu.limits[0].label, "Current session");
		assert_eq!(lu.limits[0].percent, 20);
		assert_eq!(lu.limits[0].resets_at, "Aug 4 at 8:20pm (Europe/Paris)");

		assert_eq!(lu.limits[1].label, "This week");
		assert_eq!(lu.limits[1].percent, 21);

		// Sans échéance annoncée, le champ reste vide plutôt qu'inventé.
		assert_eq!(lu.limits[2].label, "This week (Fable)");
		assert_eq!(lu.limits[2].percent, 0);
		assert!(lu.limits[2].resets_at.is_empty());

		assert!(lu.note.starts_with("Approximate,"), "la mise en garde est reprise");
	}
}
