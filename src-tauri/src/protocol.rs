//! Les trois façons de parler à un agent, réunies derrière une seule valeur.
//!
//! Un moteur déclare un protocole en configuration, sous forme de chaîne
//! (`claude-stream-json`, `codex-exec`, `gemini-stream-json`). Cette chaîne se
//! comparait ensuite en six endroits d'`agent.rs`, et dans trois d'entre eux le
//! cas non reconnu tombait dans la branche `_ =>` — celle de Claude Code. Le
//! garde posé au lancement rendait ce chemin inatteignable ; il n'empêchait pas
//! qu'un quatrième protocole ajouté un jour soit lu, silencieusement, comme s'il
//! parlait la langue du premier.
//!
//! Le passage par un `enum` est ce qui change cela : la chaîne se traduit une
//! fois, au démarrage, et tout ce qui suit est un `match` **exhaustif** — un
//! protocole de plus devient une erreur de compilation à chaque endroit qui
//! aurait dû le prévoir, et non un repli muet.
//!
//! Ce n'est volontairement pas un `trait` : trois implémentations connues à la
//! compilation ne justifient ni `Box<dyn>` ni fabrique, et un trait perdrait
//! précisément l'exhaustivité qui motive tout ceci.
//!
//! ## Ce que ce module ne fait pas
//!
//! Il ne construit pas la ligne de commande. Elle dépend du moteur autant que du
//! protocole — binaire déclaré, arguments de profondeur, variables
//! d'environnement, isolation — et la sortir d'`agent::start_with_mission`
//! reviendrait à y faire passer la moitié de sa portée. Ce module tient ce qui
//! ne dépend **que** du protocole : lire son flux, et dire ce qu'il sait
//! annoncer.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
	/// Claude Code, `--input-format stream-json`. Le process reste ouvert d'un
	/// tour à l'autre.
	Claude,
	/// `codex exec` : un process par tour, repris par son fil.
	Codex,
	/// `gemini --output-format stream-json` : un seul tour, aucune reprise.
	Gemini,
}

impl Protocol {
	/// Traduit ce qu'un moteur déclare. `None` pour un protocole que le cockpit
	/// ne sait pas parler — c'est le seul endroit où cette question se pose, et
	/// l'appelant a alors de quoi le dire au lieu de deviner.
	pub fn parse(declared: &str) -> Option<Self> {
		match declared.trim() {
			// Vide veut dire le protocole par défaut, comme
			// `EngineConfig::protocol_or_default`.
			"" | crate::config::DEFAULT_PROTOCOL => Some(Protocol::Claude),
			crate::config::PROTOCOL_CODEX_EXEC => Some(Protocol::Codex),
			crate::config::PROTOCOL_GEMINI_STREAM => Some(Protocol::Gemini),
			_ => None,
		}
	}

	pub fn id(&self) -> &'static str {
		match self {
			Protocol::Claude => crate::config::DEFAULT_PROTOCOL,
			Protocol::Codex => crate::config::PROTOCOL_CODEX_EXEC,
			Protocol::Gemini => crate::config::PROTOCOL_GEMINI_STREAM,
		}
	}

	/// Les protocoles implémentés, pour le dire à qui en déclare un autre.
	pub fn known() -> [&'static str; 3] {
		[
			crate::config::DEFAULT_PROTOCOL,
			crate::config::PROTOCOL_CODEX_EXEC,
			crate::config::PROTOCOL_GEMINI_STREAM,
		]
	}

	/// Le process reste-t-il ouvert d'un tour à l'autre ?
	///
	/// Faux pour `codex-exec`, dont chaque tour relance un process — la
	/// distinction qui décide si `send` écrit sur une entrée ou en rouvre une.
	pub fn keeps_process(&self) -> bool {
		!matches!(self, Protocol::Codex)
	}

	/// Le message de départ passe-t-il par l'entrée standard ?
	///
	/// Non chez Codex, qui le prend en argument : l'y écrire une seconde fois le
	/// dédoublerait.
	pub fn prompt_on_stdin(&self) -> bool {
		matches!(self, Protocol::Claude)
	}

	/// L'identifiant à retenir pour reprendre la conversation.
	///
	/// Rien chez Gemini, qui n'a aucune reprise documentée : capturer son
	/// `session_id` n'aurait aucun usage, et le ranger là où vit celui de Claude
	/// Code serait faux — ce champ nourrit ailleurs la résolution de fichiers
	/// propre à Claude Code (`remote.rs`, `orchestrator.rs`).
	pub fn resume_marker<'a>(&self, payload: &'a Value) -> Option<&'a str> {
		match self {
			Protocol::Codex => crate::codex::thread_id(payload),
			Protocol::Gemini => None,
			Protocol::Claude => payload.get("session_id").and_then(|v| v.as_str()),
		}
	}

	/// Le tour est-il rendu ?
	///
	/// Chez Claude Code c'est le seul moment où l'on sait qu'un exécutant a
	/// terminé, son processus lui survivant ; chez Codex le process va mourir
	/// dans l'instant, mais c'est ce même événement qui dit si c'est de la
	/// réussite ou de l'échec. Gemini nomme sa fin `result`, comme Claude.
	pub fn turn_over(&self, payload: &Value) -> bool {
		match self {
			Protocol::Codex => crate::codex::turn_finished(payload),
			Protocol::Claude | Protocol::Gemini => {
				payload.get("type").and_then(|v| v.as_str()) == Some("result")
			}
		}
	}

	/// Ce tour rendu était-il un échec ?
	///
	/// Codex nomme sa fin ratée ; Claude pose `is_error` sur son `result`.
	/// Gemini n'a aucun champ d'échec vérifié : ses tours se comptent donc comme
	/// rendus et jamais comme échoués — un échec inventé vaudrait moins qu'un
	/// échec absent.
	pub fn turn_failed(&self, payload: &Value) -> bool {
		match self {
			Protocol::Codex => crate::codex::turn_failed(payload),
			Protocol::Claude => {
				payload.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false)
			}
			Protocol::Gemini => false,
		}
	}

	/// Traduit un événement vers la forme que le fil de discussion sait déjà
	/// lire — celle de Claude Code. `None` dit à l'appelant de ne rien émettre :
	/// ce qui n'a pas de forme vérifiée ne s'affiche pas.
	pub fn to_claude_shaped(&self, payload: Value) -> Option<Value> {
		match self {
			Protocol::Codex => crate::codex::to_claude_shaped(&payload),
			Protocol::Gemini => crate::gemini::to_claude_shaped(&payload),
			Protocol::Claude => Some(payload),
		}
	}

	/// Ce que ce protocole sait annoncer — voir
	/// [`crate::executions::Observability`], qui dit pourquoi cette table
	/// existe.
	pub fn observability(&self) -> crate::executions::Observability {
		use crate::executions::Observability;
		match self {
			// Chaque tour relance un process, aucun coût annoncé, et les
			// sorties d'outils n'ont pas de forme vérifiée — voir `codex.rs`.
			Protocol::Codex => Observability {
				reports_cost: false,
				reports_token_split: true,
				reports_tool_results: false,
				reports_thinking: false,
				resumable: true,
			},
			// Un seul total de jetons, et aucune reprise documentée — voir
			// `gemini.rs`.
			Protocol::Gemini => Observability {
				reports_cost: false,
				reports_token_split: false,
				reports_tool_results: true,
				reports_thinking: false,
				resumable: false,
			},
			Protocol::Claude => Observability {
				reports_cost: true,
				reports_token_split: true,
				reports_tool_results: true,
				reports_thinking: true,
				resumable: true,
			},
		}
	}

	/// La consommation annoncée à la fin d'un tour. On ne retient que ce qui
	/// porte un champ vérifié : ce qui n'est pas dit devient
	/// [`crate::executions::Cost::Unknown`], jamais zéro.
	pub fn turn_usage(&self, payload: &Value) -> crate::executions::Turn {
		use crate::executions::{Cost, Turn};
		let nombre = |value: Option<&Value>| value.and_then(|v| v.as_u64()).unwrap_or(0);

		match self {
			// `turn.completed` porte son usage soit à la racine de l'événement,
			// soit sous `turn` selon la forme rencontrée.
			Protocol::Codex => {
				let usage = payload
					.get("usage")
					.or_else(|| payload.get("turn").and_then(|turn| turn.get("usage")));
				Turn {
					input_tokens: nombre(usage.and_then(|u| u.get("input_tokens"))),
					output_tokens: nombre(usage.and_then(|u| u.get("output_tokens"))),
					cache_tokens: nombre(usage.and_then(|u| u.get("cached_input_tokens"))),
					cost: None,
				}
			}
			// Un seul chiffre, qu'on ne répartit pas : le ranger en entrée
			// gonflerait une colonne au détriment de l'autre. Il compte comme
			// entrée faute de mieux, et `reports_token_split` dit pourquoi.
			Protocol::Gemini => Turn {
				input_tokens: nombre(
					payload
						.get("stats")
						.and_then(|stats| stats.get("total_tokens")),
				),
				..Default::default()
			},
			Protocol::Claude => {
				let usage = payload.get("usage");
				Turn {
					input_tokens: nombre(usage.and_then(|u| u.get("input_tokens"))),
					output_tokens: nombre(usage.and_then(|u| u.get("output_tokens"))),
					cache_tokens: nombre(usage.and_then(|u| u.get("cache_read_input_tokens")))
						+ nombre(usage.and_then(|u| u.get("cache_creation_input_tokens"))),
					cost: payload
						.get("total_cost_usd")
						.and_then(|v| v.as_f64())
						.map(|usd| Cost::Reported { usd }),
				}
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn les_trois_protocoles_se_reconnaissent() {
		assert_eq!(Protocol::parse("claude-stream-json"), Some(Protocol::Claude));
		assert_eq!(Protocol::parse("codex-exec"), Some(Protocol::Codex));
		assert_eq!(
			Protocol::parse("gemini-stream-json"),
			Some(Protocol::Gemini)
		);
	}

	#[test]
	fn un_moteur_qui_ne_declare_rien_parle_le_protocole_par_defaut() {
		// Même règle qu'`EngineConfig::protocol_or_default` : une ligne de
		// configuration vide ne doit pas empêcher un agent de partir.
		assert_eq!(Protocol::parse(""), Some(Protocol::Claude));
		assert_eq!(Protocol::parse("   "), Some(Protocol::Claude));
	}

	#[test]
	fn un_protocole_inconnu_ne_se_lit_pas_comme_celui_de_claude() {
		// Le défaut que cet enum existe pour fermer : trois `match` retombaient
		// silencieusement sur Claude Code.
		assert_eq!(Protocol::parse("un-protocole-a-venir"), None);
	}

	#[test]
	fn l_aller_retour_par_l_identifiant_est_fidele() {
		for id in Protocol::known() {
			assert_eq!(Protocol::parse(id).map(|p| p.id()), Some(id));
		}
	}

	#[test]
	fn seul_codex_relance_un_process_par_tour() {
		assert!(Protocol::Claude.keeps_process());
		assert!(Protocol::Gemini.keeps_process());
		assert!(!Protocol::Codex.keeps_process());
	}

	#[test]
	fn seul_claude_recoit_sa_consigne_sur_l_entree_standard() {
		assert!(Protocol::Claude.prompt_on_stdin());
		assert!(!Protocol::Codex.prompt_on_stdin());
		assert!(!Protocol::Gemini.prompt_on_stdin());
	}

	#[test]
	fn gemini_n_a_aucun_identifiant_de_reprise_a_retenir() {
		let payload = serde_json::json!({ "type": "init", "session_id": "s-1" });
		assert_eq!(Protocol::Gemini.resume_marker(&payload), None);
		assert_eq!(Protocol::Claude.resume_marker(&payload), Some("s-1"));
	}

	#[test]
	fn la_fin_d_un_tour_se_reconnait_dans_chaque_langue() {
		let claude = serde_json::json!({ "type": "result" });
		assert!(Protocol::Claude.turn_over(&claude));
		assert!(Protocol::Gemini.turn_over(&claude));
		assert!(!Protocol::Codex.turn_over(&claude));

		let codex = serde_json::json!({ "type": "turn.completed" });
		assert!(Protocol::Codex.turn_over(&codex));
	}

	#[test]
	fn gemini_ne_declare_jamais_un_echec_qu_il_ne_sait_pas_dire() {
		let quoi_que_ce_soit = serde_json::json!({ "type": "result", "is_error": true });
		assert!(!Protocol::Gemini.turn_failed(&quoi_que_ce_soit));
		assert!(Protocol::Claude.turn_failed(&quoi_que_ce_soit));

		let rate = serde_json::json!({ "type": "turn.failed" });
		assert!(Protocol::Codex.turn_failed(&rate));
	}

	// ── Ce que chaque moteur annonce ──

	#[test]
	fn un_tour_claude_porte_ses_jetons_et_sa_valorisation() {
		let payload = serde_json::json!({
			"type": "result",
			"total_cost_usd": 0.42,
			"usage": {
				"input_tokens": 1000,
				"output_tokens": 200,
				"cache_read_input_tokens": 30,
				"cache_creation_input_tokens": 12,
			}
		});
		let turn = Protocol::Claude.turn_usage(&payload);
		assert_eq!(turn.input_tokens, 1000);
		assert_eq!(turn.output_tokens, 200);
		assert_eq!(turn.cache_tokens, 42);
		assert_eq!(
			turn.cost,
			Some(crate::executions::Cost::Reported { usd: 0.42 })
		);
	}

	#[test]
	fn un_tour_codex_ne_ment_pas_sur_un_cout_qu_il_n_annonce_pas() {
		let payload = serde_json::json!({
			"type": "turn.completed",
			"usage": { "input_tokens": 800, "output_tokens": 90, "cached_input_tokens": 10 }
		});
		let turn = Protocol::Codex.turn_usage(&payload);
		assert_eq!(turn.input_tokens, 800);
		assert_eq!(turn.output_tokens, 90);
		assert_eq!(turn.cache_tokens, 10);
		// Ni zéro, ni inventé : absent.
		assert_eq!(turn.cost, None);
	}

	#[test]
	fn un_tour_gemini_ne_repartit_pas_un_total_qu_il_ne_decoupe_pas() {
		let payload = serde_json::json!({ "type": "result", "stats": { "total_tokens": 1234 } });
		let turn = Protocol::Gemini.turn_usage(&payload);
		assert_eq!(turn.input_tokens, 1234);
		assert_eq!(turn.output_tokens, 0);
		assert_eq!(turn.cost, None);
	}

	#[test]
	fn un_tour_sans_usage_ne_compte_aucun_jeton() {
		let turn = Protocol::Claude.turn_usage(&serde_json::json!({}));
		assert_eq!(turn, crate::executions::Turn::default());
	}

	#[test]
	fn l_observabilite_dit_ce_qu_un_moteur_tait() {
		// Le silence de Codex sur les coûts doit être lisible comme un silence,
		// jamais comme une économie.
		let codex = Protocol::Codex.observability();
		assert!(!codex.reports_cost);
		assert!(!codex.reports_tool_results);
		assert!(codex.resumable);

		let gemini = Protocol::Gemini.observability();
		assert!(!gemini.reports_token_split);
		assert!(!gemini.resumable);

		let claude = Protocol::Claude.observability();
		assert!(claude.reports_cost);
		assert!(claude.reports_thinking);
	}

	#[test]
	fn un_message_claude_traverse_sans_etre_traduit() {
		let payload = serde_json::json!({ "type": "assistant" });
		assert_eq!(
			Protocol::Claude.to_claude_shaped(payload.clone()),
			Some(payload)
		);
	}
}
