//! Sonde de la liste « prêt à démarrer » : relève ce poste comme la carte le
//! fera à l'ouverture, et l'affiche.
//!
//! `cargo run --example readiness`
//!
//! Lecture seule : quelques recherches de programmes et un `claude auth
//! status` par compte déclaré. Rien n'est écrit.

use cockpit_lib::readiness;

#[tokio::main]
async fn main() {
	let vue = readiness::observe().await;
	for check in &vue.checks {
		println!(
			"{} {:<11} {}{}",
			if check.ok {
				"ok  "
			} else if check.required {
				"MANQUE"
			} else {
				"—   "
			},
			check.id,
			check.detail,
			if check.required { "" } else { " (facultatif)" },
		);
	}
	println!("prêt : {}", vue.ready);
}
