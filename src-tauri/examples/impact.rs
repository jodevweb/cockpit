//! Sonde de l'écran Impact : recense, puis lit un changement pour de vrai.
//!
//! `cargo run --example impact` recense et s'arrête — lecture seule, aucun
//! agent lancé, rien d'écrit.
//!
//! `cargo run --example impact -- <clé>` va jusqu'au bout : dossier, agent,
//! relecture du rapport, écriture de l'analyse. C'est le seul moyen d'éprouver
//! la chaîne complète sans passer par la fenêtre — et donc de vérifier qu'un
//! vrai moteur, sur un vrai diff, rend bien ce que le parseur attend.

use cockpit_lib::{impact, monitor};

#[tokio::main]
async fn main() {
	let cle = std::env::args().nth(1);

	println!("── recensement ──");
	let scan = match monitor::scan(None).await {
		Ok(scan) => scan,
		Err(erreur) => {
			eprintln!("échec : {erreur}");
			return;
		}
	};

	for note in &scan.notes {
		println!("  ⚠ {} : {}", note.source, note.message);
	}
	println!("  {} changements", scan.changes.len());
	for change in &scan.changes {
		let taille = match (change.additions, change.deletions) {
			(Some(plus), Some(moins)) => format!("+{plus} −{moins}"),
			_ => "taille inconnue".into(),
		};
		println!(
			"  [{}] {:<52} {:<9} {taille:<16} {}",
			change.forge,
			change.key.chars().take(52).collect::<String>(),
			change.ci,
			change
				.analysis
				.as_ref()
				.map(|resume| format!("lu : {} / {}", resume.verdict, resume.risk))
				.unwrap_or_else(|| "pas encore lu".into()),
		);
	}

	let Some(cle) = cle else {
		println!("\nDonne une clé en argument pour lancer une lecture.");
		return;
	};

	println!("\n── lecture de {cle} ──");
	let debut = std::time::Instant::now();
	match impact::analyze(cle).await {
		Ok(analysis) => {
			println!("  en {} s", debut.elapsed().as_secs());
			println!("  verdict  : {}", analysis.summary.verdict);
			println!("  risque   : {}", analysis.summary.risk);
			println!("  en clair : {}", analysis.summary.headline);
			println!(
				"  {} risques, {} vérifications",
				analysis.summary.risk_count, analysis.summary.check_count
			);
			println!("\n  sections reconnues :");
			for section in &analysis.sections {
				println!(
					"    {:<10} « {} » — {} puce(s), {} caractères de texte",
					section.id,
					section.title,
					section.points.len(),
					section.body.len()
				);
			}
			// Une section `autre` veut dire qu'un titre n'a pas été reconnu : le
			// rapport reste lisible, mais la fiche perdra sa mise en page.
			if analysis.sections.iter().any(|section| section.id == "autre") {
				println!("\n  ⚠ un titre n'a pas été reconnu — voir le rapport brut.");
			}
		}
		Err(erreur) => eprintln!("  échec : {erreur}"),
	}
}
