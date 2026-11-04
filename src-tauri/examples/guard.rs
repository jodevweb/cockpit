//! Sonde du garde-fou git des exécutants : écrit le hook et ses réglages tels
//! que le cockpit les passe au CLI, puis joue la commande du hook dans le shell
//! du poste, comme le CLI le fera.
//!
//! `cargo run --example guard`
//!
//! Les tests de `guard.rs` éprouvent ce que le script décide. Ce qu'ils ne
//! peuvent pas montrer, c'est la ligne que le CLI exécutera : le chemin de
//! Node et celui du script, entre guillemets, lus par zsh sous macOS et par le
//! bash de Git for Windows sous Windows. C'est ce que cette sonde exerce. Elle
//! écrit `mission-guard.mjs` et `mission-guard.json` dans le vrai
//! `~/.config/cockpit/` — les mêmes fichiers que le premier exécutant lancé
//! écrirait.

use std::io::Write;
use std::process::Stdio;

use cockpit_lib::guard;

fn main() {
	let Some(path) = guard::settings_argument(false) else {
		eprintln!("échec : Node introuvable, le garde-fou ne serait pas posé.");
		std::process::exit(1);
	};
	println!("réglages   : {path}");
	let settings: serde_json::Value =
		serde_json::from_str(&std::fs::read_to_string(&path).expect("réglages illisibles"))
			.expect("réglages invalides");
	let command = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
		.as_str()
		.expect("commande du hook absente")
		.to_string();
	println!("hook       : {command}");

	let mut ok = true;
	for (bash, attendu) in [
		("git push --force", true),
		("git checkout -b autre", true),
		("git push origin main", true),
		("git status", false),
	] {
		let mut child = cockpit_lib::platform::shell(&command)
			.env("COCKPIT_PROTECTED_BRANCHES", "main")
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.expect("shell introuvable");
		let input = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": bash } });
		child
			.stdin
			.take()
			.unwrap()
			.write_all(input.to_string().as_bytes())
			.unwrap();
		let output = child.wait_with_output().unwrap();
		let refuse = String::from_utf8_lossy(&output.stdout).contains("\"deny\"");
		let bon = output.status.success() && refuse == attendu;
		ok &= bon;
		println!(
			"{} {bash:<26} → {}{}",
			if bon { "ok  " } else { "ÉCHEC" },
			if refuse { "refusé" } else { "permis" },
			if output.status.success() {
				String::new()
			} else {
				format!(" (sortie {:?} : {})", output.status.code(), String::from_utf8_lossy(&output.stderr).trim())
			},
		);
	}
	if !ok {
		std::process::exit(1);
	}
}
