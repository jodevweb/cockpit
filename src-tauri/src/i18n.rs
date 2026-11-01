//! Les textes que le Rust montre ou écrit, dans la langue de l'utilisateur.
//!
//! Les catalogues vivent dans `src-tauri/locales/<langue>/<espace>.json`,
//! embarqués dans le binaire. Une clé se lit avec des points
//! (`"remote.pairing_expired"`) dans un JSON imbriqué ; les valeurs s'insèrent
//! avec la même syntaxe que i18next côté interface : `{{nom}}`.
//!
//! L'anglais est la référence : une clé absente d'une langue retombe sur lui,
//! puis sur la clé elle-même — un oubli se voit, il ne casse rien.
//!
//! La langue vient du réglage `general.language` ; vide, elle suit le système.
//! Elle est gardée en mémoire : `Config::load` relit le disque, et `t` est
//! appelé partout.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

/// Les langues livrées, dans l'ordre du sélecteur. Le code est celui de BCP 47,
/// le même que côté interface.
pub const SUPPORTED: [&str; 10] = ["en", "fr", "es", "de", "pt-BR", "zh-CN", "ja", "ko", "ru", "it"];

/// Le nom anglais de chaque langue : c'est ce qu'on dit à un agent, qui
/// comprend mieux « French » qu'un code.
fn english_name(code: &str) -> &'static str {
	match code {
		"fr" => "French",
		"es" => "Spanish",
		"de" => "German",
		"pt-BR" => "Brazilian Portuguese",
		"zh-CN" => "Simplified Chinese",
		"ja" => "Japanese",
		"ko" => "Korean",
		"ru" => "Russian",
		"it" => "Italian",
		_ => "English",
	}
}

macro_rules! catalogs {
	($($lang:literal),*) => {
		fn raw_catalogs() -> Vec<(&'static str, &'static str)> {
			vec![$(
				($lang, include_str!(concat!("../locales/", $lang, "/core.json"))),
				($lang, include_str!(concat!("../locales/", $lang, "/agents.json"))),
				($lang, include_str!(concat!("../locales/", $lang, "/missions.json"))),
				($lang, include_str!(concat!("../locales/", $lang, "/mobile.json"))),
			)*]
		}
	};
}
catalogs!("en", "fr", "es", "de", "pt-BR", "zh-CN", "ja", "ko", "ru", "it");

/// Chaque langue, ses espaces fusionnés en un seul arbre.
fn catalogs() -> &'static HashMap<&'static str, Value> {
	static CATALOGS: OnceLock<HashMap<&'static str, Value>> = OnceLock::new();
	CATALOGS.get_or_init(|| {
		let mut map: HashMap<&'static str, Value> = HashMap::new();
		for (lang, raw) in raw_catalogs() {
			let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(raw) else {
				continue;
			};
			let tree = map.entry(lang).or_insert_with(|| Value::Object(Default::default()));
			if let Value::Object(target) = tree {
				target.extend(entries);
			}
		}
		map
	})
}

fn current() -> &'static RwLock<Option<String>> {
	static CURRENT: OnceLock<RwLock<Option<String>>> = OnceLock::new();
	CURRENT.get_or_init(|| RwLock::new(None))
}

/// La langue du système, ramenée à une langue livrée. `AppleLanguages` donne
/// l'ordre de préférence de l'utilisateur (`fr-FR`, `pt-BR`, `zh-Hans-CN`…).
pub fn system_language() -> &'static str {
	let listed = std::process::Command::new("defaults")
		.args(["read", "-g", "AppleLanguages"])
		.output()
		.ok()
		.map(|output| String::from_utf8_lossy(&output.stdout).to_string())
		.unwrap_or_default();
	let first = listed
		.split(|c: char| c == '"' || c == '\n' || c == ',' || c == '(' || c == ')')
		.map(str::trim)
		.find(|item| !item.is_empty())
		.map(str::to_string)
		.or_else(|| std::env::var("LANG").ok())
		.unwrap_or_default();
	normalize(&first)
}

/// Un code de langue quelconque, ramené à une langue livrée (l'anglais à défaut).
pub fn normalize(code: &str) -> &'static str {
	let code = code.trim().replace('_', "-");
	let lower = code.to_lowercase();
	if lower.starts_with("pt") {
		return "pt-BR";
	}
	if lower.starts_with("zh") {
		return "zh-CN";
	}
	let primary = lower.split(['-', '.']).next().unwrap_or("");
	SUPPORTED
		.iter()
		.find(|lang| lang.eq_ignore_ascii_case(primary))
		.copied()
		.unwrap_or("en")
}

/// Le réglage tel qu'enregistré : un code livré, ou vide pour « comme le système ».
pub fn resolve(choice: &str) -> &'static str {
	if choice.trim().is_empty() {
		system_language()
	} else {
		normalize(choice)
	}
}

/// La langue en cours.
pub fn lang() -> String {
	// Les tests ne doivent pas dépendre de la langue de la machine qui les lance.
	if cfg!(test) {
		return "en".into();
	}
	if let Some(lang) = current().read().ok().and_then(|guard| guard.clone()) {
		return lang;
	}
	let lang = resolve(&crate::config::Config::load().general.language).to_string();
	if let Ok(mut guard) = current().write() {
		*guard = Some(lang.clone());
	}
	lang
}

/// Après un changement de réglage : la prochaine lecture repart de la config.
pub fn invalidate() {
	if let Ok(mut guard) = current().write() {
		*guard = None;
	}
}

fn lookup<'a>(tree: &'a Value, key: &str) -> Option<&'a str> {
	let mut node = tree;
	for part in key.split('.') {
		node = node.get(part)?;
	}
	node.as_str()
}

/// Le texte d'une clé dans la langue en cours.
pub fn t(key: &str) -> String {
	t_in(&lang(), key)
}

/// Le texte d'une clé dans une langue donnée, anglais puis clé à défaut.
pub fn t_in(lang: &str, key: &str) -> String {
	let catalogs = catalogs();
	catalogs
		.get(lang)
		.and_then(|tree| lookup(tree, key))
		.or_else(|| catalogs.get("en").and_then(|tree| lookup(tree, key)))
		.unwrap_or(key)
		.to_string()
}

/// Le texte d'une clé, ses `{{nom}}` remplacés.
pub fn tf(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
	let mut text = t(key);
	for (name, value) in args {
		text = text.replace(&format!("{{{{{name}}}}}"), &value.to_string());
	}
	text
}

/// Un espace entier, anglais en dessous, pour la page mobile qui traduit
/// elle-même ses textes.
pub fn namespace_for(lang: &str, prefix: &str) -> Value {
	let catalogs = catalogs();
	let mut merged = catalogs
		.get("en")
		.and_then(|tree| tree.get(prefix))
		.cloned()
		.unwrap_or(Value::Object(Default::default()));
	if let Some(Value::Object(local)) = catalogs.get(lang).and_then(|tree| tree.get(prefix)) {
		deep_merge(&mut merged, &Value::Object(local.clone()));
	}
	merged
}

fn deep_merge(base: &mut Value, over: &Value) {
	match (base, over) {
		(Value::Object(base), Value::Object(over)) => {
			for (key, value) in over {
				deep_merge(base.entry(key.clone()).or_insert(Value::Null), value);
			}
		}
		(base, over) => *base = over.clone(),
	}
}

/// La consigne de langue jointe à tout prompt : les prompts sont écrits en
/// anglais, que les modèles suivent le mieux, et l'agent répond dans la langue
/// de l'utilisateur. Les marqueurs de protocole (`VERDICT:`, etc.) restent tels
/// quels : le code les lit.
pub fn reply_directive() -> String {
	let lang = lang();
	format!(
		"Write every reply, summary and any text meant for the user in {name}. \
		 Keep code, identifiers, file paths and the exact protocol markers requested \
		 in these instructions unchanged.",
		name = english_name(&lang)
	)
}

/// Le nom anglais de la langue en cours (pour composer un prompt).
pub fn language_name() -> &'static str {
	english_name(&lang())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn les_codes_se_ramenent_a_une_langue_livree() {
		assert_eq!(normalize("fr-FR"), "fr");
		assert_eq!(normalize("pt-PT"), "pt-BR");
		assert_eq!(normalize("zh-Hans-CN"), "zh-CN");
		assert_eq!(normalize("ja_JP.UTF-8"), "ja");
		assert_eq!(normalize("nl-NL"), "en");
		assert_eq!(normalize(""), "en");
	}

	#[test]
	fn une_cle_absente_retombe_sur_la_cle() {
		assert_eq!(t_in("fr", "cle.qui.n.existe.pas"), "cle.qui.n.existe.pas");
	}

	#[test]
	fn tous_les_catalogues_se_lisent() {
		for (lang, raw) in raw_catalogs() {
			assert!(serde_json::from_str::<Value>(raw).is_ok(), "catalogue illisible : {lang}");
		}
	}
}
