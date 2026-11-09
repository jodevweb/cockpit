//! La Permanence : un opérateur qui tient l'écosystème pendant qu'on fait
//! autre chose.
//!
//! Ce module tient **la boucle et le tri**. La boucle regarde ce qui bouge,
//! compare à ce qu'elle avait vu au regard précédent, et range ce qui est
//! nouveau ; le tri décide ensuite lequel de ces deltas mérite un engagement.
//!
//! Rien n'est encore engagé : au bout du tri, un signal retenu attend. Un
//! dispositif qui décidera à notre place doit d'abord montrer ce qu'il voit et
//! ce qu'il aurait retenu — sans quoi on ne saurait pas si une règle ne se
//! déclenche jamais parce qu'elle est mal écrite ou parce que le signal
//! n'arrive pas. « Écartés » est l'écran qui répond à ça, et il se remplit ici.
//!
//! ## Ce que le tri coûte, et ce qu'il ne coûte pas
//!
//! Un delta dont le déclencheur n'est pas reconnaissable est écarté **sans
//! aucun appel** : c'est la majorité du trafic, et le faire lire à un modèle
//! serait payer pour apprendre ce qu'on savait déjà. Le tri ne part que s'il
//! reste des signaux nommables et qu'au moins une règle est vivante.
//!
//! ## Les portes, vérifiées avant de scruter et non après
//!
//! Désactivée · coupe-circuit sauté · suspendue d'un geste · hors des heures ·
//! plafond atteint · quota partagé sous le plancher. Chacune est une valeur
//! distincte : « elle ne fait rien » est une réponse inutilisable, là où « hors
//! des heures de service » se corrige en dix secondes.
//!
//! ## Les garde-fous contre l'emballement
//!
//! Ils répondent chacun à un mode de défaillance précis, et ne se remplacent
//! pas les uns les autres :
//!
//! - **Un seul engagement à la fois** (`max_running`). Un opérateur humain de
//!   permanence ne traite pas huit incidents en parallèle. Le plafond
//!   journalier ne protège pas d'une rafale : six engagements partis dans la
//!   même minute tiennent largement sous vingt.
//! - **La quarantaine** (`grace_hours`). Un objet qu'elle vient de traiter est
//!   laissé tranquille. Elle couvre deux pièges d'un coup : l'**auto-
//!   déclenchement** — elle pousse un commit, la tête de branche bouge, le
//!   delta la réveille sur son propre travail — et l'**acharnement** sur une
//!   correction qui n'a pas pris.
//! - **Le rodage** (`rehearsal`). Les premiers engagements se jouent à blanc :
//!   elle décide, elle écrit ce qu'elle aurait fait, elle n'agit pas. Le
//!   compteur se réarme dès que la liste des pouvoirs change.
//! - **Le coupe-circuit** (`breaker`). Trois échecs d'affilée et elle se
//!   suspend elle-même. Le réarmement est un geste humain : une reprise
//!   automatique ferait exactement ce que le coupe-circuit sert à empêcher.
//!
//! ## Le battement de cœur
//!
//! Chaque passage note son heure et son verdict. Sans cette trace, « rien à
//! signaler » et « je ne vois plus rien » sont indiscernables, et c'est le mode
//! de panne dangereux d'un dispositif qui travaille sans qu'on le regarde. Une
//! porte fermée est donc **notée comme un regard**, avec sa raison : se taire
//! parce qu'on dort n'est pas se taire parce qu'on est en panne.

use crate::config::Config;
use crate::error::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Mutex;

/// Au-delà, le journal des signaux écartés se tronque. C'est une fenêtre
/// d'observation, pas un entrepôt : ce qui compte est ce qu'on a écarté
/// récemment et pourquoi.
const MAX_DROPPED: usize = 200;

/// Pourquoi la boucle n'a rien regardé.
///
/// Une valeur par porte, et jamais un simple booléen : « elle ne fait rien »
/// est une réponse inutilisable, là où « hors des heures déclarées » se corrige
/// en dix secondes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Closed {
	/// Désactivée dans la configuration.
	Disabled,
	/// Suspendue d'un geste — un état, pas un réglage.
	Suspended,
	/// Hors de la plage horaire déclarée.
	OffHours,
	/// Son propre plafond de jetons ou d'engagements est atteint.
	Capped,
	/// Le quota d'abonnement partagé est passé sous le plancher.
	Quota,
	/// Le coupe-circuit a sauté : trop d'échecs d'affilée, elle s'est arrêtée
	/// elle-même. Distinct de `Suspended`, qui est ton geste à toi.
	Tripped,
}

impl Closed {
	/// Dit à l'écran, tel quel.
	pub fn reason(self) -> String {
		let key = match self {
			Closed::Disabled => "disabled",
			Closed::Suspended => "suspended",
			Closed::OffHours => "offHours",
			Closed::Capped => "capped",
			Closed::Quota => "quota",
			Closed::Tripped => "tripped",
		};
		crate::i18n::t(&format!("permanence.closed.{key}"))
	}
}

/* ── L'engagement ───────────────────────────────────────────────────────────
L'unité de travail n'est ni la session ni la journée : c'est l'engagement.

	déclencheur → objectif → actions → oracle → verdict

Un agent global n'a pas de condition d'arrêt naturelle, et un agent qui
boucle ressemble exactement à un agent qui travaille. L'engagement lui en
donne une : il reste global par sa surface — il peut toucher à tout — mais
borné par son horizon. Sans objectif énonçable et sans oracle, il ne démarre
pas.
────────────────────────────────────────────────────────────────────────── */

/// Où en est un engagement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
	/// Elle réfléchit à ce qu'elle va faire.
	Planning,
	/// Elle agit.
	Running,
	/// Elle a fini, et l'oracle a rendu son verdict.
	Done,
	/// Arrêtée en cours de route — par toi, ou par l'arrêt d'urgence.
	Abandoned,
}

/// Ce que l'oracle a dit. **Quatre valeurs, pas deux.**
///
/// `properties.rs` a rencontré le même problème et l'a tranché : un juge qui ne
/// peut pas conclure ne doit **jamais** rendre « conforme ». Confondre
/// l'indécidable avec l'atteint transformerait une panne en succès — c'est le
/// mode de défaillance le plus coûteux du dispositif entier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
	/// Pas encore jugé.
	#[default]
	Pending,
	/// L'oracle est atteint.
	Reached,
	/// L'oracle est manqué.
	Missed,
	/// L'oracle ne s'applique pas : le déclencheur portait sur autre chose.
	OffTopic,
	/// L'oracle est indécidable — la commande n'a pas tourné, l'API n'a pas
	/// répondu, le juge est muet. **Ce n'est pas un succès.**
	Undecided,
	/// Joué à blanc : elle a dit ce qu'elle aurait fait, rien n'a été fait.
	Rehearsed,
}

impl Verdict {
	/// Un engagement qui a échoué, au sens du coupe-circuit.
	///
	/// L'indécidable en fait partie : trois oracles muets d'affilée veulent dire
	/// que quelque chose est cassé, pas que tout va bien.
	pub fn failed(self) -> bool {
		matches!(self, Verdict::Missed | Verdict::Undecided)
	}

	pub fn label(self) -> String {
		let key = match self {
			Verdict::Pending => "pending",
			Verdict::Reached => "reached",
			Verdict::Missed => "missed",
			Verdict::OffTopic => "offTopic",
			Verdict::Undecided => "undecided",
			Verdict::Rehearsed => "rehearsed",
		};
		crate::i18n::t(&format!("permanence.verdict.{key}"))
	}
}

/// Une étape d'un engagement, avec **son résultat**.
///
/// Une ligne qui dit « lance un agent » sans dire ce qu'il a produit est une
/// ligne de log, pas une ligne de journal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
	pub at: u64,
	/// Ce qu'elle fait, en clair.
	pub what: String,
	/// Ce que ça a donné. Vide tant que l'étape court.
	pub result: String,
	pub ok: bool,
}

/// Ce qui existe maintenant et n'existait pas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Produced {
	/// `branch` · `pr` · `mission` · `comment` · `label`.
	pub kind: String,
	/// Ce que c'est, en clair, pour l'écran.
	pub label: String,
	/// La référence technique — identifiant de mission, nom du label.
	///
	/// Distincte du libellé : défaire quelque chose en découpant la phrase qui
	/// le décrit marche jusqu'au jour où l'on reformule la phrase.
	#[serde(default)]
	pub reference: String,
	pub url: String,
	/// Vrai quand le cockpit sait le défaire.
	pub undoable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Engagement {
	pub id: String,
	/// La règle qui l'a autorisé.
	pub rule: String,
	/// L'objet visé — la clé du changement.
	pub key: String,
	pub label: String,
	pub trigger: String,
	/// Une phrase, écrite par l'agent, lisible par un humain.
	pub goal: String,
	/// La preuve visée, telle que la règle l'a déclarée.
	pub oracle: crate::config::OracleConfig,
	pub stage: Stage,
	pub verdict: Verdict,
	/// Pourquoi ce verdict. Toujours renseigné quand il n'est pas `Reached` :
	/// un échec sans raison ne s'apprend pas.
	pub why: String,
	pub steps: Vec<Step>,
	pub produced: Vec<Produced>,
	/// La mission ouverte, quand l'engagement a délégué.
	pub mission: String,
	/// Joué à blanc : elle a dit, elle n'a pas fait.
	pub rehearsal: bool,
	pub started_at: u64,
	pub ended_at: u64,
	pub cost_usd: f64,
}

impl Engagement {
	pub fn running(&self) -> bool {
		matches!(self.stage, Stage::Planning | Stage::Running)
	}

	fn step(&mut self, what: &str, result: &str, ok: bool) {
		self.steps.push(Step {
			at: now(),
			what: what.to_string(),
			result: result.to_string(),
			ok,
		});
	}
}

/* ── Le tri ─────────────────────────────────────────────────────────────────
Un petit modèle décide ce qui mérite un engagement. C'est 95 % des appels de
la Permanence, sur des entrées minuscules : le delta, et les règles actives.
Il ne voit jamais l'état complet — le cache expire en cinq minutes, et chaque
réveil se paierait plein tarif.

**Sa réponse arrive par appel d'outil, jamais par du texte à relire.** Un
verdict qu'on extrait d'une phrase dépend de la façon dont le modèle a tourné
sa phrase, et finit par se tromper le jour où il la tourne autrement.
────────────────────────────────────────────────────────────────────────── */

fn triage_dir() -> std::path::PathBuf {
	crate::config::config_dir().join("permanence-triage")
}

fn bridge_path() -> std::path::PathBuf {
	crate::config::config_dir().join("mcp-permanence.mjs")
}

/// Le serveur MCP prêté au trieur : deux outils, et rien d'autre.
///
/// Il ne demande rien au cockpit et n'attend aucune réponse — `signal` et
/// `silence` sont des **déclarations**, pas des requêtes. Le pont écrit le
/// verdict sur le disque et acquitte lui-même : pas de boucle de traitement à
/// tenir, pas de course entre l'agent qui finit et le cockpit qui répond.
const BRIDGE: &str = r#"#!/usr/bin/env node
// Outils de tri de la Permanence — généré, ne pas éditer à la main.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".config", "cockpit", "permanence-triage");
mkdirSync(DIR, { recursive: true });

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let count = 0;
const record = (verdict, input) => {
  count += 1;
  writeFileSync(
    join(DIR, `${String(count).padStart(4, "0")}-${Date.now()}.json`),
    JSON.stringify({ verdict, ...input }),
  );
};

const TOOLS = [
  {
    name: "signal",
    description:
      "Keep this signal: it matches an active rule and deserves an engagement. Only call this tool if a rule truly applies — keeping one wrongly costs an agent, a branch and quota.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The signal key, exactly as it was given to you." },
        rule: { type: "string", description: "Identifier of the rule that applies." },
        why: { type: "string", description: "In one sentence: why this rule applies here." },
      },
      required: ["key", "rule", "why"],
    },
  },
  {
    name: "intend",
    description:
      "Declare what you intend to do, before doing it. The goal in one sentence a human can read, then the planned actions in order. Call this tool only once, and do not act before: that is what lets your plan be judged without having to suffer it.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "One sentence, in the first person, saying what you will achieve — not how.",
        },
        plan: {
          type: "array",
          description: "The planned actions, in order.",
          items: {
            type: "object",
            properties: {
              what: { type: "string", description: "The action, in plain words." },
              why: { type: "string", description: "Why it is needed." },
            },
            required: ["what"],
          },
        },
        mission: {
          type: "boolean",
          description:
            "True if code must be written: the cockpit will open a mission rather than let you act alone. False for a simple action — rerun, label, report.",
        },
        acts: {
          type: "array",
          description:
            "The actions to take, in order. You do not execute them yourself: the cockpit will play them after checking they are allowed. Request none if none is needed.",
          items: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description:
                  "rerun_pipeline · set_label · run_command · comment. Nothing else exists.",
              },
              value: {
                type: "string",
                description:
                  "What the action applies to: the label name, the command identifier, the comment text. Empty when the action does not need it.",
              },
            },
            required: ["tool"],
          },
        },
      },
      required: ["goal", "plan"],
    },
  },
  {
    name: "silence",
    description:
      "Dismiss this signal. It is the expected answer most of the time, and it costs nothing: just say why no rule applies.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The signal key, exactly as it was given to you." },
        why: { type: "string", description: "In a few words: why nothing happens." },
      },
      required: ["key", "why"],
    },
  },
];

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "permanence", version: "1" },
        },
      });
      continue;
    }
    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
      continue;
    }
    if (message.method === "tools/call") {
      const { name, arguments: input } = message.params ?? {};
      if (name === "signal" || name === "silence" || name === "intend") {
        record(name, input ?? {});
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "noted" }] },
        });
        continue;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "unknown tool" }], isError: true },
      });
    }
  }
});
"#;

/// Installe le pont et rend le chemin de sa configuration MCP.
///
/// `None` sans Node : le tri ne part pas plutôt que de partir sans outils et de
/// rendre du texte qu'il faudrait relire. Mieux vaut un tri qui ne tourne pas et
/// le dit qu'un tri qui devine.
fn bridge_config() -> Option<String> {
	let node = crate::agent::node_binary()?;
	std::fs::create_dir_all(triage_dir()).ok()?;
	std::fs::write(bridge_path(), BRIDGE).ok()?;

	let config = crate::config::config_dir().join("mcp-permanence.json");
	let payload = json!({
		"mcpServers": {
			"permanence": {
				"command": node,
				"args": [bridge_path().to_string_lossy()],
			}
		}
	});
	std::fs::write(&config, serde_json::to_string_pretty(&payload).ok()?).ok()?;
	Some(config.to_string_lossy().to_string())
}

/// Ce qu'un appel d'outil du tri a déclaré.
///
/// Distinct de [`Verdict`], qui est celui de l'oracle : le tri dit s'il faut y
/// aller, l'oracle dit si on y est arrivé.
#[derive(Debug, Clone, Deserialize)]
struct Sorted {
	verdict: String,
	#[serde(default)]
	key: String,
	#[serde(default)]
	rule: String,
	#[serde(default)]
	why: String,
}

/// Vide le dépôt des verdicts avant un tri.
///
/// Un tri qui ramasserait les verdicts du précédent attribuerait à un signal ce
/// qu'on avait dit d'un autre — et le tri est séquentiel, donc rien d'autre
/// n'écrit ici pendant ce temps.
fn clear_verdicts() {
	let _ = std::fs::create_dir_all(triage_dir());
	if let Ok(entries) = std::fs::read_dir(triage_dir()) {
		for entry in entries.flatten() {
			let _ = std::fs::remove_file(entry.path());
		}
	}
}

fn read_sorted() -> Vec<Sorted> {
	let Ok(entries) = std::fs::read_dir(triage_dir()) else {
		return Vec::new();
	};
	let mut paths: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
	paths.sort();
	paths
		.iter()
		.filter_map(|path| {
			let raw = std::fs::read_to_string(path).ok()?;
			serde_json::from_str::<Sorted>(&raw).ok()
		})
		.collect()
}

/// La consigne du trieur.
///
/// Elle tient en une page et ne porte que le delta : les règles actives d'un
/// côté, les signaux frais de l'autre. Aucun historique, aucun état complet —
/// c'est ce qui rend l'appel négligeable.
///
/// `me` : le compte GitHub sous lequel la Permanence tourne — vide s'il n'a
/// pas pu être lu (`gh` absent ou non connecté). Une condition du genre « la
/// revue m'est attribuée » ne se juge pas sans savoir qui est « moi » ; sans
/// ce compte, elle reste à bon droit non vérifiable plutôt que devinée.
fn triage_prompt(rules: &[&crate::config::PermanenceRule], signals: &[&Signal], me: &str) -> String {
	let mut out = String::from(
		"You are the triage of an autonomous operator. Your job: say which of these signals \
		 match an active rule, and which deserve nothing.\n\n\
		 **The expected answer most of the time is \"nothing\".** Keeping one wrongly costs an \
		 agent, a branch and quota; dismissing one wrongly only costs a signal that will come \
		 back at the next change. When in doubt, dismiss.\n\n\
		 You do not write text: you call `signal` or `silence` **once per signal**, without \
		 exception. A signal without a call is a lost signal.\n\n",
	);
	out.push_str(&crate::i18n::reply_directive());
	out.push_str(" This applies to the `why` fields.\n\n");
	if !me.is_empty() {
		out.push_str(&format!(
			"GitHub account you are running under: `{me}`. It is the \"me\" of any condition \
			 phrased in the first person — assigned, mentioned, reviewer.\n\n"
		));
	}

	out.push_str("## Active rules\n\n");
	for rule in rules {
		out.push_str(&format!(
			"- `{}` — {}\n  trigger: {}\n",
			rule.id,
			if rule.label.trim().is_empty() {
				"(untitled)"
			} else {
				rule.label.trim()
			},
			rule.trigger
		));
		if !rule.condition.trim().is_empty() {
			out.push_str(&format!("  condition: {}\n", rule.condition.trim()));
		}
	}

	out.push_str("\n## Signals to triage\n\n");
	for signal in signals {
		out.push_str(&format!(
			"- key `{}`\n  source: {} · {}\n  observed trigger: {}\n",
			signal.key,
			signal.source,
			signal.label,
			if signal.trigger.is_empty() {
				"none"
			} else {
				&signal.trigger
			},
		));
		if !signal.context.is_empty() {
			out.push_str(&format!("  {}\n", signal.context));
		}
	}

	out.push_str(
		"\nA signal whose observed trigger matches no rule gets `silence` without further \
		 thought. For the others, check that the rule's condition is really true here before \
		 calling `signal`.\n",
	);
	out
}

/// Un signal vu par la boucle, et ce qu'elle en a fait.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
	/// Clé du changement d'où il vient — `github:acme/produit#412`.
	pub key: String,
	pub project: String,
	/// La source, telle qu'elle s'affiche : `CI`, `GitHub`, `Linear`.
	pub source: String,
	/// Ce qui a changé, en une ligne.
	pub label: String,
	/// Le déclencheur reconnu, quand il correspond à ce que la boucle sait
	/// nommer. Vide = un delta qui ne ressemble à aucun signal déclarable.
	pub trigger: String,
	/// Faits complémentaires, en clair — auteur, reviewers demandés. Ce que
	/// le tri a besoin de savoir pour juger une condition qui parle de
	/// personnes plutôt que d'états, sans avoir à deviner. Vide quand rien
	/// de plus n'est su.
	#[serde(default)]
	pub context: String,
	pub at: u64,
	/// Pourquoi il n'a rien produit. Vide quand il a été retenu.
	pub dropped: String,
	/// La règle retenue par le tri. Vide tant qu'il n'a pas tranché.
	#[serde(default)]
	pub rule: String,
	/// Vrai quand le tri l'a retenu : il attend un engagement.
	#[serde(default)]
	pub retained: bool,
	/// Vrai tant que le tri ne l'a pas encore regardé.
	#[serde(default)]
	pub pending: bool,
}

/// Ce qu'un regard a donné.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Look {
	pub at: u64,
	/// Fermée : la porte qui a bloqué. Ouverte : `None`.
	pub closed: Option<Closed>,
	/// Changements comparés.
	pub seen: usize,
	/// Deltas trouvés depuis le regard précédent.
	pub fresh: usize,
	/// Sources qui n'ont pas répondu — un regard partiel qui se tait ment
	/// plus qu'un regard vide.
	pub blind: Vec<String>,
}

/// Ce que la Permanence sait d'elle-même, entre deux ouvertures du cockpit.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
	/// Suspendue d'un geste. Distinct de « désactivée », qui est un réglage.
	pub suspended: bool,
	/// Le dernier regard, quel qu'ait été son verdict.
	pub last_look: Option<Look>,
	/// Depuis quand elle est en service, en secondes epoch.
	pub since: u64,
	/// Empreinte du dernier état connu de chaque changement. C'est le curseur :
	/// il survit au sommeil du poste, et c'est lui qui distingue « rien de
	/// nouveau » de « je viens de démarrer ».
	pub cursor: std::collections::HashMap<String, String>,
	/// Vrai tant qu'aucun regard n'a encore rempli le curseur.
	///
	/// Le premier regard d'une installation voit *tout* comme nouveau. Le
	/// traiter comme un flot de signaux ferait partir la Permanence en rafale
	/// sur l'historique entier du dépôt : il sert donc à poser le curseur, et
	/// à rien d'autre.
	pub cold: bool,
	/// Les signaux vus et ce qu'ils sont devenus, les plus récents d'abord.
	pub signals: Vec<Signal>,
	/// Ce qui a été sauté pendant une absence, quand elle déclare forfait.
	pub skipped: u64,

	// ── Les garde-fous ───────────────────────────────────────────────────
	/// Objets laissés tranquilles jusqu'à cette date, en secondes epoch.
	///
	/// Un engagement met sa cible en quarantaine. C'est ce qui l'empêche de se
	/// réveiller sur son propre commit — la tête de branche bouge dès qu'elle
	/// pousse — et de s'acharner sur une correction qui n'a pas pris.
	pub quarantine: std::collections::HashMap<String, u64>,
	/// Engagements à blanc restants avant qu'elle n'agisse pour de vrai.
	pub rehearsal_left: u64,
	/// L'empreinte des pouvoirs sur laquelle le rodage courant a été armé.
	///
	/// `None` tant qu'il ne l'a jamais été. La distinction n'est pas cosmétique :
	/// une liste blanche vide a pour empreinte la chaîne vide, et une simple
	/// `String` confondrait « jamais armé » avec « armé sur rien » — le rodage
	/// ne se déclencherait alors jamais sur une installation neuve, qui est
	/// précisément celle qu'il protège.
	pub armed_on: Option<String>,
	/// Échecs consécutifs. Remis à zéro par le premier succès.
	pub failures: u64,
	/// Le coupe-circuit a sauté : elle s'est suspendue elle-même, et la raison
	/// est ici. Vide sinon.
	pub tripped: String,
	/// Les engagements, les plus récents d'abord.
	pub engagements: Vec<Engagement>,
	/// Ce qu'elle tient en ce moment : agents lancés, missions ouvertes.
	///
	/// C'est la seule liste qui permette de tout couper. Un agent qu'elle a
	/// lancé sans l'inscrire ici survivrait à l'arrêt d'urgence — d'où la règle
	/// qui gouverne l'étape suivante : **on inscrit avant de lancer**, jamais
	/// après.
	pub holds: Vec<Hold>,
}

/// Quelque chose que la Permanence a mis en route et peut couper.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hold {
	/// `agent` — une session du CLI. `mission` — une mission ouverte.
	pub kind: String,
	pub id: String,
	/// Ce que c'est, en clair, pour le compte rendu de l'arrêt.
	pub label: String,
	pub since: u64,
}

/// Ce qu'un arrêt d'urgence a réellement coupé.
///
/// Rendu à l'écran tel quel : un bouton d'urgence qui ne dit pas ce qu'il a
/// fait laisse dans le doute au pire moment — on reclique, ou pire, on croit
/// que c'est arrêté alors qu'il restait quelque chose.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Halt {
	pub state: State,
	/// Ce qui a été coupé, en clair.
	pub stopped: Vec<String>,
	/// Ce qui n'a pas pu l'être, et pourquoi. **Jamais tu.**
	pub failed: Vec<String>,
}

impl State {
	/// Cet objet est-il encore au calme ?
	pub fn quarantined(&self, key: &str, at: u64) -> bool {
		self.quarantine.get(key).is_some_and(|until| *until > at)
	}

	/// Met un objet au calme pour les heures qui viennent.
	pub fn quarantine_for(&mut self, key: &str, hours: u64, at: u64) {
		self.quarantine.insert(key.to_string(), at + hours * 3600);
	}

	/// Oublie les quarantaines expirées : sans ça, la carte grossit avec
	/// chaque PR jamais revue.
	pub fn sweep(&mut self, at: u64) {
		self.quarantine.retain(|_, until| *until > at);
	}

	/// Joue-t-elle encore à blanc ?
	pub fn rehearsing(&self) -> bool {
		self.rehearsal_left > 0
	}

	/// Engagements en cours.
	pub fn in_flight(&self) -> usize {
		self.engagements
			.iter()
			.filter(|engagement| engagement.running())
			.count()
	}

	/// Réarme le rodage quand ce qu'elle a le droit de faire a changé.
	///
	/// Le rodage protège de ce qu'on vient de lui donner, pas de ce qu'elle
	/// avait déjà : le compteur repart à chaque fois que la liste des pouvoirs
	/// bouge, y compris quand on la restreint — l'important est de regarder ce
	/// que le nouveau dispositif fait, pas de juger s'il fait plus ou moins.
	pub fn arm(&mut self, print: &str, count: u64) {
		if self.armed_on.as_deref() != Some(print) {
			self.armed_on = Some(print.to_string());
			self.rehearsal_left = count;
		}
	}
}

fn now() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|value| value.as_secs())
		.unwrap_or(0)
}

fn state_path() -> std::path::PathBuf {
	crate::config::config_dir().join("permanence.json")
}

/// Le fichier n'est lu qu'une fois : la boucle et l'écran le partagent, et deux
/// lectures concurrentes d'un JSON à chaque tour ne prouveraient rien de plus.
static STATE: Mutex<Option<State>> = Mutex::new(None);

fn load() -> State {
	let mut guard = STATE.lock().expect("état de la Permanence");
	if let Some(state) = guard.as_ref() {
		return state.clone();
	}
	let state = std::fs::read_to_string(state_path())
		.ok()
		.and_then(|raw| serde_json::from_str::<State>(&raw).ok())
		.unwrap_or(State {
			// Une installation neuve démarre froide : son premier regard pose le
			// curseur au lieu de croire que tout vient d'arriver.
			cold: true,
			since: now(),
			..Default::default()
		});
	*guard = Some(state.clone());
	state
}

fn store(state: State) -> State {
	if let Ok(raw) = serde_json::to_string_pretty(&state) {
		let _ = std::fs::create_dir_all(crate::config::config_dir());
		let _ = std::fs::write(state_path(), raw);
	}
	*STATE.lock().expect("état de la Permanence") = Some(state.clone());
	state
}

/// L'état courant, tel que l'écran le lit.
pub fn state() -> State {
	load()
}

/// Enregistre l'issue d'un engagement, et arrête tout si ça se répète.
///
/// Le coupe-circuit ne juge pas la gravité, seulement la répétition : trois
/// échecs d'affilée veulent dire que ce qu'elle essaie ne marche pas, quelle
/// qu'en soit la cause. Continuer, c'est au mieux brûler le quota, au pire
/// refaire le même dégât trois fois de plus.
pub fn record_outcome(ok: bool, detail: &str) -> State {
	let mut state = load();
	if ok {
		state.failures = 0;
		return store(state);
	}

	state.failures += 1;
	let limit = Config::active().permanence.breaker();
	if state.failures >= limit {
		state.tripped = crate::i18n::tf(
			"permanence.tripped",
			&[("count", &state.failures), ("last", &detail.trim())],
		);
		crate::journal::record_as(
			crate::journal::PERMANENCE,
			"",
			"permanence",
			&crate::i18n::t("permanence.journal.breakerTripped"),
			"",
			false,
			&state.tripped,
		);
	}
	store(state)
}

/// Inscrit ce qu'elle s'apprête à mettre en route.
///
/// **Avant de lancer, jamais après.** Un agent démarré puis inscrit laisse une
/// fenêtre — courte, mais réelle — pendant laquelle l'arrêt d'urgence ne le
/// verrait pas et le laisserait tourner.
pub fn hold(kind: &str, id: &str, label: &str) -> State {
	let mut state = load();
	state.holds.retain(|entry| entry.id != id);
	state.holds.push(Hold {
		kind: kind.to_string(),
		id: id.to_string(),
		label: label.to_string(),
		since: now(),
	});
	store(state)
}

/// Retire ce qui s'est terminé de lui-même.
pub fn release(id: &str) -> State {
	let mut state = load();
	state.holds.retain(|entry| entry.id != id);
	store(state)
}

/// **Tout arrêter.** Le geste qu'on cherche quand ça dérape.
///
/// Trois choses, dans cet ordre : fermer les portes pour qu'aucun engagement ne
/// reparte, couper ce qui tourne, puis rendre ce qui a été coupé. L'ordre
/// compte — couper d'abord laisserait la boucle relancer pendant qu'on coupe.
///
/// Il pose le coupe-circuit plutôt qu'une simple suspension : après un arrêt
/// d'urgence, on veut regarder avant que ça reparte, et le réarmement est un
/// geste humain.
pub fn halt(agents: &crate::agent::SharedAgents, reason: &str) -> Halt {
	let mut state = load();

	// La porte d'abord. Une boucle qui relancerait un engagement pendant qu'on
	// coupe les précédents transformerait l'arrêt en course.
	state.tripped = if reason.trim().is_empty() {
		crate::i18n::t("permanence.halt.requested")
	} else {
		reason.trim().to_string()
	};

	let held = std::mem::take(&mut state.holds);
	let mut stopped = Vec::new();
	let mut failed = Vec::new();

	for entry in held {
		let what = if entry.label.trim().is_empty() {
			entry.id.clone()
		} else {
			entry.label.clone()
		};
		match entry.kind.as_str() {
			"agent" => match crate::agent::stop(agents, &entry.id) {
				Ok(()) => stopped.push(format!("agent · {what}")),
				Err(error) => failed.push(format!("agent · {what} — {error}")),
			},
			// Une mission ne se tue pas : on la met en pause. Ses branches et son
			// travail restent là, et c'est un humain qui décidera d'en faire
			// quelque chose — les jeter serait détruire ce qu'on veut examiner.
			"mission" => match crate::mission::set_paused(&entry.id, true) {
				Ok(_) => stopped.push(format!("mission · {what}")),
				Err(error) => failed.push(format!("mission · {what} — {error}")),
			},
			other => failed.push(crate::i18n::tf(
				"permanence.halt.cannotStop",
				&[("kind", &other), ("what", &what)],
			)),
		}
	}

	crate::journal::record_as(
		crate::journal::PERMANENCE,
		"",
		"permanence",
		&crate::i18n::t("permanence.journal.emergencyStop"),
		"",
		failed.is_empty(),
		&crate::i18n::tf(
			"permanence.halt.summary",
			&[("stopped", &stopped.len()), ("failed", &failed.len())],
		),
	);

	Halt {
		state: store(state),
		stopped,
		failed,
	}
}

/// Ce qu'un engagement a produit peut-il être défait ?
///
/// Rend la raison quand la réponse est non. **Un « annuler » grisé sans raison
/// est le pire des deux mondes** : on ne sait ni pourquoi, ni ce qu'il faudrait
/// faire à la main.
pub fn undoable(engagement: &Engagement) -> std::result::Result<(), String> {
	if engagement.produced.is_empty() {
		return Err(crate::i18n::t("permanence.undo.nothingProduced"));
	}
	let stuck: Vec<&str> = engagement
		.produced
		.iter()
		.filter(|produced| !produced.undoable)
		.map(|produced| produced.label.as_str())
		.collect();
	if !stuck.is_empty() {
		return Err(crate::i18n::tf(
			"permanence.undo.cannotUndo",
			&[("items", &stuck.join(", "))],
		));
	}
	Ok(())
}

/// Défait ce qu'un engagement a produit.
///
/// Ne touche qu'à ce qui est réellement défaisable, et dit ce qui a résisté.
/// Une mission est mise en pause plutôt que supprimée : son travail reste là,
/// c'est justement ce qu'on veut regarder.
pub async fn undo(id: &str) -> Halt {
	let mut state = load();
	let Some(engagement) = state.engagements.iter().find(|entry| entry.id == id).cloned() else {
		return Halt {
			state,
			stopped: Vec::new(),
			failed: vec![crate::i18n::t("permanence.undo.engagementGone")],
		};
	};

	let config = Config::active();
	let mut undone = Vec::new();
	let mut failed = Vec::new();

	for produced in &engagement.produced {
		match produced.kind.as_str() {
			"mission" => match crate::mission::set_paused(&produced.reference, true) {
				Ok(_) => undone.push(crate::i18n::tf(
					"permanence.undo.missionPaused",
					&[("name", &produced.label)],
				)),
				Err(error) => failed.push(crate::i18n::tf(
					"permanence.undo.missionFailed",
					&[("name", &produced.label), ("error", &error)],
				)),
			},
			"label" => {
				let number = pr_number_of(&engagement.key);
				match number {
					Some(number) => {
						match crate::integrations::github_remove_label(&config, number, &produced.reference).await {
							Ok(()) => undone.push(crate::i18n::tf(
								"permanence.undo.labelRemoved",
								&[("label", &produced.reference)],
							)),
							Err(error) => failed.push(crate::i18n::tf(
								"permanence.undo.labelFailed",
								&[("label", &produced.reference), ("error", &error)],
							)),
						}
					}
					None => failed.push(crate::i18n::tf(
						"permanence.undo.labelNoTarget",
						&[("label", &produced.label)],
					)),
				}
			}
			other => failed.push(crate::i18n::tf(
				"permanence.undo.cannotUndoKind",
				&[("kind", &other), ("what", &produced.label)],
			)),
		}
	}

	if let Some(entry) = state.engagements.iter_mut().find(|entry| entry.id == id) {
		entry.step(
			&crate::i18n::t("permanence.undo.step"),
			&crate::i18n::tf(
				"permanence.undo.stepResult",
				&[("undone", &undone.len()), ("failed", &failed.len())],
			),
			failed.is_empty(),
		);
		// Ce qui a été défait ne se dit plus « produit » : la liste doit décrire
		// ce qui existe, pas ce qui a existé.
		entry
			.produced
			.retain(|produced| !produced.undoable || !failed.is_empty());
	}

	crate::journal::record_as(
		crate::journal::PERMANENCE,
		id,
		"permanence",
		&crate::i18n::t("permanence.journal.undo"),
		&engagement.key,
		failed.is_empty(),
		&crate::i18n::tf(
			"permanence.undo.summary",
			&[("undone", &undone.len()), ("failed", &failed.len())],
		),
	);

	Halt {
		state: store(state),
		stopped: undone,
		failed,
	}
}

/// Réarme le coupe-circuit. Geste humain, jamais automatique.
///
/// Une reprise automatique au bout de N minutes ferait exactement ce que le
/// coupe-circuit sert à empêcher : réessayer sans que personne ait regardé.
pub fn rearm() -> State {
	let mut state = load();
	state.tripped = String::new();
	state.failures = 0;
	store(state)
}

/// Met fin au rodage : elle passe du blanc au réel.
///
/// Un geste explicite, et un seul — c'est le moment où le dispositif cesse
/// d'être une démonstration. On peut aussi laisser le compteur s'épuiser.
pub fn go_live() -> State {
	let mut state = load();
	state.rehearsal_left = 0;
	store(state)
}

/// Suspend ou reprend. Un geste, pas un réglage : il coûte un clic et se défait
/// aussi vite.
pub fn suspend(suspended: bool) -> State {
	let mut state = load();
	state.suspended = suspended;
	if !suspended {
		state.since = now();
	}
	store(state)
}

/// Remet un signal écarté en attente d'un nouveau tri.
///
/// Rejoue le jugement, pas l'événement : `key` seul ne suffit pas à le
/// retrouver, un signal peut se répéter d'un regard à l'autre — c'est `at`
/// qui désigne l'écarté précis. Pose l'état et laisse le prochain tri
/// trancher, comme `suspend`/`rearm` : aucune commande ne déclenche elle-même
/// un traitement, seule la boucle le fait.
pub fn retry_signal(key: &str, at: u64) -> State {
	let mut state = load();
	if let Some(signal) = state
		.signals
		.iter_mut()
		.find(|signal| signal.key == key && signal.at == at && !signal.dropped.is_empty())
	{
		signal.pending = true;
		signal.dropped = String::new();
		signal.retained = false;
		signal.rule = String::new();
	}
	store(state)
}

/// Quelle porte est fermée, s'il y en a une.
///
/// `quota_used` est le pourcentage consommé du quota partagé, quand on le
/// connaît. Le lire coûte un lancement de CLI : la boucle ne le demande pas à
/// chaque tour, et une valeur absente ne ferme pas la porte.
fn gate(config: &crate::config::PermanenceConfig, state: &State, quota_used: Option<u32>) -> Option<Closed> {
	if !config.enabled {
		return Some(Closed::Disabled);
	}
	// Le coupe-circuit se lit avant la suspension : il *est* une suspension,
	// mais posée par elle et non par toi, et la distinguer est le seul moyen de
	// savoir qu'il s'est passé quelque chose.
	if !state.tripped.is_empty() {
		return Some(Closed::Tripped);
	}
	if state.suspended {
		return Some(Closed::Suspended);
	}
	if !config.open_at(minutes_now()) {
		return Some(Closed::OffHours);
	}
	if !config.quota_allows(quota_used) {
		return Some(Closed::Quota);
	}
	None
}

/// Minutes écoulées depuis minuit, heure locale.
fn minutes_now() -> u32 {
	use chrono::Timelike;
	let local = chrono::Local::now();
	local.hour() * 60 + local.minute()
}

/// L'empreinte d'un changement : ce qui, en changeant, veut dire qu'il s'est
/// passé quelque chose.
///
/// Pas le `updated_at` de la forge : il bouge pour un label posé, un titre
/// corrigé, un rebase — et la Permanence partirait sur du bruit. On ne retient
/// que ce dont un signal peut naître.
fn fingerprint(change: &crate::monitor::Change) -> String {
	format!("{}|{}|{}|{}", change.head_sha, change.ci, change.review, change.draft)
}

/// Ce qu'un delta veut dire, quand il veut dire quelque chose.
///
/// Rend l'identifiant d'un déclencheur de `TRIGGERS`, ou vide. Un delta sans
/// déclencheur nommable n'est pas une erreur : c'est la majorité du trafic, et
/// c'est précisément ce que « Écartés » sert à montrer.
fn trigger_of(before: Option<&str>, change: &crate::monitor::Change) -> String {
	let previous = before.map(|raw| raw.split('|').collect::<Vec<_>>());
	let was_ci = previous.as_ref().and_then(|parts| parts.get(1)).copied();
	let was_review = previous.as_ref().and_then(|parts| parts.get(2)).copied();

	// La CI qui passe au rouge, et seulement le passage : rester rouge n'est pas
	// un événement, sinon la Permanence se réveillerait à chaque tour sur la
	// même branche cassée.
	if change.ci == "failing" && was_ci != Some("failing") {
		return "ci_red".into();
	}
	if change.review == "changes_requested" && was_review != Some("changes_requested") {
		return "review_changes_requested".into();
	}
	String::new()
}

/// Les signaux qui ne naissent d'aucun delta.
///
/// `ci_red` et `review_changes_requested` viennent d'un changement d'état ;
/// ceux-ci viennent de l'horloge. Sans eux, une règle qui dit « tous les jours,
/// vérifie les dépendances » ne partirait jamais — et l'écran la proposait
/// pourtant.
///
/// Ils portent leur propre garde-fou : la quarantaine de leur clé. Un signal
/// d'horloge qui repartirait à chaque regard réveillerait la Permanence toutes
/// les deux minutes.
fn clock_signals(
	config: &crate::config::PermanenceConfig,
	state: &State,
	changes: &[crate::monitor::Change],
) -> Vec<Signal> {
	let mut out = Vec::new();
	let at = now();

	for rule in config.live_rules() {
		match rule.trigger.as_str() {
			"schedule" => {
				// Une clé par règle : deux règles d'horloge ne doivent pas se
				// mettre mutuellement en quarantaine.
				let key = format!("schedule:{}", rule.id);
				if state.quarantined(&key, at) {
					continue;
				}
				let every = if rule.every_hours == 0 { 24 } else { rule.every_hours };
				// Le curseur porte l'heure du dernier départ : rien d'autre ne
				// distingue « jamais parti » de « parti il y a une minute ».
				let last = state
					.cursor
					.get(&key)
					.and_then(|raw| raw.parse::<u64>().ok())
					.unwrap_or(0);
				if last > 0 && at.saturating_sub(last) < every * 3600 {
					continue;
				}
				out.push(Signal {
					key,
					project: String::new(),
					source: crate::i18n::t("permanence.signals.clock"),
					label: crate::i18n::tf(
						"permanence.signals.every",
						&[
							(
								"rule",
								&if rule.label.trim().is_empty() {
									rule.id.as_str()
								} else {
									rule.label.trim()
								},
							),
							("hours", &every),
						],
					),
					trigger: "schedule".into(),
					context: String::new(),
					at,
					dropped: String::new(),
					rule: String::new(),
					retained: false,
					pending: true,
				});
			}
			"pr_stale" => {
				let every = if rule.every_hours == 0 { 72 } else { rule.every_hours };
				for change in changes {
					if state.quarantined(&change.key, at) {
						continue;
					}
					// Une PR en brouillon n'attend personne : la signaler
					// endormie serait signaler un choix.
					if change.draft {
						continue;
					}
					let updated = chrono::DateTime::parse_from_rfc3339(&change.updated_at)
						.ok()
						.map(|date| date.timestamp() as u64)
						.unwrap_or(0);
					if updated == 0 || at.saturating_sub(updated) < every * 3600 {
						continue;
					}
					out.push(Signal {
						key: change.key.clone(),
						project: change.project_name.clone(),
						source: source_of(change),
						label: format!("{} · {}", change.reference, change.title),
						trigger: "pr_stale".into(),
						context: signal_context(change),
						at,
						dropped: String::new(),
						rule: String::new(),
						retained: false,
						pending: true,
					});
				}
			}
			_ => {}
		}
	}
	out
}

/// La source d'un changement, telle qu'elle s'affiche.
fn source_of(change: &crate::monitor::Change) -> String {
	match change.forge.as_str() {
		"github" => "GitHub".into(),
		"gitlab" => "GitLab".into(),
		_ => "Local".into(),
	}
}

/// Les faits sur les personnes, en clair — ce qu'une condition qui parle à
/// la première personne (« la revue m'est attribuée », « c'est moi
/// l'auteur ») a besoin de lire pour se juger sans deviner.
fn signal_context(change: &crate::monitor::Change) -> String {
	let mut faits = Vec::new();
	if !change.author.is_empty() {
		faits.push(crate::i18n::tf(
			"permanence.signals.author",
			&[("author", &change.author)],
		));
	}
	if !change.review_requested.is_empty() {
		faits.push(crate::i18n::tf(
			"permanence.signals.reviewRequested",
			&[("people", &change.review_requested.join(", "))],
		));
	}
	faits.join(" · ")
}

/// Ce qui distingue un ticket d'un autre pour le curseur : la priorité, pas
/// l'assignation — la liste elle-même ne contient déjà que « assigné à moi »
/// (`linear_issues(config, true)`). Un changement de priorité doit repasser
/// devant le tri ; un ticket qui reste urgent d'un regard à l'autre, non.
fn linear_fingerprint(issue: &crate::integrations::FeedItem) -> String {
	issue.tags.first().map(|tag| tag.label.clone()).unwrap_or_default()
}

fn linear_context(issue: &crate::integrations::FeedItem) -> String {
	let priority = issue
		.tags
		.first()
		.map(|tag| tag.label.clone())
		.unwrap_or_else(|| crate::i18n::t("permanence.signals.noPriority"));
	crate::i18n::tf("permanence.signals.assignedToMe", &[("priority", &priority)])
}

/// Un regard. C'est tout ce que la boucle sait faire pour l'instant.
///
/// Elle compare, elle range, elle note. Rien n'est lancé : les règles ne sont
/// pas encore consultées, et tout ce qui est vu part dans « Écartés » avec sa
/// raison.
pub async fn look(quota_used: Option<u32>, app: Option<tauri::AppHandle>) -> Result<State> {
	let config = Config::active();
	let mut state = load();

	// Les portes d'abord. Une porte fermée est un regard comme un autre : elle
	// s'inscrit au battement de cœur avec sa raison, faute de quoi un service
	// endormi et un service en panne se ressemblent.
	if let Some(closed) = gate(&config.permanence, &state, quota_used) {
		state.last_look = Some(Look {
			at: now(),
			closed: Some(closed),
			..Default::default()
		});
		return Ok(store(state));
	}

	// Ce qui attendait une mission se juge avant de chercher du neuf : un
	// engagement dont le travail est fini mais dont l'oracle n'a pas été posé
	// occupe la place et empêche le suivant de partir.
	state = ripen(state).await?;

	// Le rodage s'arme ici, pas au moment d'agir : il faut qu'un changement de
	// pouvoirs se voie au regard suivant, sans attendre qu'un engagement parte.
	state.arm(&config.permanence.powers_print(), config.permanence.rehearsal());
	state.sweep(now());

	let scan = crate::monitor::scan(None).await?;
	let cold = state.cold;
	let mut fresh = Vec::new();

	for change in &scan.changes {
		let print = fingerprint(change);
		let before = state.cursor.get(&change.key).cloned();
		if before.as_deref() == Some(print.as_str()) {
			continue;
		}
		let trigger = trigger_of(before.as_deref(), change);
		state.cursor.insert(change.key.clone(), print);

		// Le premier regard pose le curseur et ne signale rien : tout lui paraît
		// neuf, et il n'y a aucun moyen de distinguer ce qui vient d'arriver de
		// ce qui traînait là depuis trois semaines.
		if cold {
			continue;
		}

		// Un objet qu'elle vient de traiter est laissé tranquille, et le delta
		// n'est même pas noté : c'est *elle* qui l'a produit en poussant son
		// commit. Le voir passer ici, ce serait se répondre à soi-même.
		if state.quarantined(&change.key, now()) {
			continue;
		}

		fresh.push(Signal {
			key: change.key.clone(),
			project: change.project_name.clone(),
			source: source_of(change),
			label: format!("{} · {}", change.reference, change.title),
			trigger: trigger.clone(),
			context: signal_context(change),
			at: now(),
			// Un delta sans déclencheur nommable est écarté ici, sans rien
			// coûter : c'est la majorité du trafic, et faire lire ça à un
			// modèle serait payer pour apprendre ce qu'on savait déjà.
			dropped: if trigger.is_empty() {
				crate::i18n::t("permanence.dropped.noTrigger")
			} else {
				String::new()
			},
			rule: String::new(),
			retained: false,
			// Le reste attend le tri.
			pending: !trigger.is_empty(),
		});
	}

	// Les tickets Linear ne sont interrogés que si une règle vivante les
	// attend — même doctrine que `clock_signals` : on ne paie une source que
	// pour qui la regarde. Le delta se traite comme celui d'un `Change` : la
	// clé du curseur, pas le temps écoulé, décide si c'est neuf.
	let linear_needed = config
		.permanence
		.live_rules()
		.iter()
		.any(|rule| rule.trigger == "linear_assigned");
	let mut linear_blind = None;
	let linear_issues = if linear_needed {
		match crate::integrations::linear_issues(&config, true).await {
			Ok(issues) => issues,
			// Muet plutôt que faux : une règle qui ne se déclenche jamais parce
			// que Linear n'a pas répondu doit se voir, pas se confondre avec
			// « aucun ticket urgent ».
			Err(error) => {
				linear_blind = Some(crate::i18n::tf("permanence.blind.linear", &[("error", &error)]));
				Vec::new()
			}
		}
	} else {
		Vec::new()
	};

	for issue in &linear_issues {
		let key = format!("linear:{}", issue.id);
		let print = linear_fingerprint(issue);
		let before = state.cursor.get(&key).cloned();
		if before.as_deref() == Some(print.as_str()) {
			continue;
		}
		state.cursor.insert(key.clone(), print);

		if cold {
			continue;
		}
		if state.quarantined(&key, now()) {
			continue;
		}

		fresh.push(Signal {
			key,
			project: String::new(),
			source: "Linear".into(),
			label: format!("{} · {}", issue.id, issue.title),
			trigger: "linear_assigned".into(),
			context: linear_context(issue),
			at: now(),
			dropped: String::new(),
			rule: String::new(),
			retained: false,
			pending: true,
		});
	}

	// Les clés disparues sortent du curseur : une PR fermée qui reviendrait
	// six mois plus tard doit être vue comme nouvelle, pas comme inchangée.
	// Un ticket Linear suit la même règle, mais seulement quand on l'a
	// réellement regardé : sinon une règle éteinte puis rallumée perdrait la
	// mémoire de ce qu'elle avait déjà vu, pour rien.
	let alive: std::collections::HashSet<&str> = scan.changes.iter().map(|change| change.key.as_str()).collect();
	let linear_alive: std::collections::HashSet<String> = linear_issues
		.iter()
		.map(|issue| format!("linear:{}", issue.id))
		.collect();
	state.cursor.retain(|key, _| {
		if key.starts_with("linear:") {
			return !linear_needed || linear_alive.contains(key.as_str());
		}
		key.starts_with("schedule:") || alive.contains(key.as_str())
	});

	// Ce qui vient de l'horloge, une fois le curseur posé : au premier regard,
	// une règle « toutes les 24 h » partirait immédiatement sur une
	// installation qui vient de démarrer.
	if !cold {
		for signal in clock_signals(&config.permanence, &state, &scan.changes) {
			if signal.trigger == "schedule" {
				state.cursor.insert(signal.key.clone(), now().to_string());
			}
			fresh.push(signal);
		}
	}

	let count = fresh.len();
	for signal in fresh.into_iter().rev() {
		state.signals.insert(0, signal);
	}
	state.signals.truncate(MAX_DROPPED);
	state.cold = false;

	state.last_look = Some(Look {
		at: now(),
		closed: None,
		seen: scan.changes.len() + linear_issues.len(),
		fresh: count,
		// Ce qui n'a pas répondu, dit plutôt que tu. Un écran qui montre douze
		// changements au lieu de quinze sans le signaler ment plus qu'un écran
		// vide : on le croit complet.
		blind: scan
			.notes
			.iter()
			.map(|note| {
				crate::i18n::tf(
					"permanence.blind.source",
					&[("source", &note.source), ("message", &note.message)],
				)
			})
			.chain(linear_blind)
			.collect(),
	});

	let state = store(state);
	triage(state, app).await
}

/// Fait trancher le petit modèle sur ce qui attend.
///
/// Trois portes avant de dépenser quoi que ce soit : il faut des signaux en
/// attente, des règles vivantes, et un pont MCP installé. Aucune des trois, et
/// la fonction rend l'état sans avoir rien coûté — c'est le cas ordinaire, et
/// il doit rester gratuit.
async fn triage(mut state: State, app: Option<tauri::AppHandle>) -> Result<State> {
	let config = Config::active();
	let waiting: Vec<Signal> = state.signals.iter().filter(|signal| signal.pending).cloned().collect();
	if waiting.is_empty() {
		return Ok(state);
	}

	// Sans règle vivante, rien à trier : on le dit sur chaque signal plutôt que
	// de les laisser « en attente » d'un tri qui ne viendra pas.
	let rules = config.permanence.live_rules();
	if rules.is_empty() {
		return Ok(settle(state, |_| {
			(false, String::new(), crate::i18n::t("permanence.dropped.noActiveRule"))
		}));
	}

	let Some(mcp) = bridge_config() else {
		// Sans Node, le trieur rendrait du texte qu'il faudrait relire. Un tri qui
		// ne tourne pas et le dit vaut mieux qu'un tri qui devine.
		return Ok(settle(state, |_| {
			(false, String::new(), crate::i18n::t("permanence.dropped.noNode"))
		}));
	};

	let cwd = crate::config::Config::load()
		.projects
		.iter()
		.map(|project| project.main_repo.clone())
		.find(|repo| !repo.is_empty() && std::path::Path::new(repo).is_dir())
		.unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());

	clear_verdicts();
	let me = crate::integrations::github_login(&config).await.to_lowercase();
	let prompt = triage_prompt(&rules, &waiting.iter().collect::<Vec<_>>(), &me);
	let answer = crate::agent::run_once_with_tools(
		&cwd,
		&prompt,
		&config.permanence.engine,
		&config.permanence.triage.model,
		&config.permanence.triage.depth,
		&["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
		&mcp,
		// Le tri précède l'engagement : il n'y en a pas encore à nommer.
		crate::executions::Origin {
			role: "permanence-tri".into(),
			..crate::executions::Origin::permanence("")
		},
	)
	.await;

	if let Err(error) = answer {
		// Un trieur muet ne dit pas « rien à faire » : il dit qu'il n'a pas trié.
		// Confondre les deux ferait passer une panne pour un calme plat, et c'est
		// le mode de défaillance le plus coûteux du dispositif.
		return Ok(settle(state, |_| {
			(
				false,
				String::new(),
				crate::i18n::tf("permanence.dropped.noAnswer", &[("error", &error)]),
			)
		}));
	}

	let sorted = read_sorted();
	state = settle(state, |signal| {
		match sorted.iter().find(|entry| entry.key == signal.key) {
			Some(entry) if entry.verdict == "signal" => (true, entry.rule.clone(), String::new()),
			Some(entry) => (false, String::new(), reason_of(&entry.why)),
			// Un signal que le trieur a sauté n'est pas un signal écarté : rien
			// n'a été dit dessus, et le prétendre serait inventer un verdict.
			None => (false, String::new(), crate::i18n::t("permanence.dropped.notDecided")),
		}
	});
	// Ce que le tri a retenu part maintenant — un à la fois.
	engage(store(state), app).await
}

/* ── Ouvrir un engagement ──────────────────────────────────────────────────
C'est ici que les quatre garde-fous mordent enfin. Ils sont vérifiés dans
l'ordre où ils coûtent, et chacun rend sa propre raison : « elle n'a rien
fait » ne se corrige pas, « un engagement tourne déjà » se lit d'un coup.
────────────────────────────────────────────────────────────────────────── */

/// Pourquoi un signal retenu n'a pas donné d'engagement.
fn cannot_open(state: &State, config: &crate::config::PermanenceConfig, key: &str) -> Option<String> {
	if state.in_flight() as u64 >= config.max_running() {
		return Some(crate::i18n::tf(
			"permanence.cannotOpen.running",
			&[("max", &config.max_running())],
		));
	}
	if state.quarantined(key, now()) {
		return Some(crate::i18n::tf(
			"permanence.cannotOpen.quarantined",
			&[("hours", &config.grace_hours())],
		));
	}
	// Le plafond du jour se compte sur les engagements réellement partis, à
	// blanc compris : une répétition consomme un modèle, même si elle n'écrit
	// rien.
	let today = now().saturating_sub(24 * 3600);
	let done_today = state
		.engagements
		.iter()
		.filter(|engagement| engagement.started_at >= today)
		.count() as u64;
	if done_today >= config.daily_engagements() {
		return Some(crate::i18n::tf(
			"permanence.cannotOpen.dailyCap",
			&[("max", &config.daily_engagements())],
		));
	}
	None
}

/// Ouvre un engagement sur un signal retenu.
///
/// L'engagement est inscrit **avant** que quoi que ce soit ne parte : un agent
/// lancé puis inscrit laisserait une fenêtre pendant laquelle l'arrêt d'urgence
/// ne le verrait pas.
fn open(state: &mut State, signal: &Signal, rule: &crate::config::PermanenceRule) -> Engagement {
	let engagement = Engagement {
		id: format!("eng-{}-{}", now(), state.engagements.len()),
		rule: rule.id.clone(),
		key: signal.key.clone(),
		label: signal.label.clone(),
		trigger: signal.trigger.clone(),
		goal: String::new(),
		oracle: rule.oracle.clone(),
		stage: Stage::Planning,
		verdict: Verdict::Pending,
		why: String::new(),
		steps: Vec::new(),
		produced: Vec::new(),
		mission: String::new(),
		rehearsal: state.rehearsing(),
		started_at: now(),
		ended_at: 0,
		cost_usd: 0.0,
	};
	state.engagements.insert(0, engagement.clone());
	engagement
}

/// Referme un engagement, applique la quarantaine et nourrit le coupe-circuit.
///
/// Un engagement à blanc met **aussi** son objet en quarantaine : sinon la
/// répétition rejouerait le même signal à chaque tour, et on paierait dix fois
/// pour lire dix fois la même chose.
fn close(state: &mut State, id: &str, verdict: Verdict, why: &str) {
	let hours = Config::active().permanence.grace_hours();
	let mut key = String::new();
	if let Some(engagement) = state.engagements.iter_mut().find(|entry| entry.id == id) {
		engagement.stage = Stage::Done;
		engagement.verdict = verdict;
		engagement.why = why.to_string();
		engagement.ended_at = now();
		key = engagement.key.clone();
	}
	if !key.is_empty() {
		state.quarantine_for(&key, hours, now());
	}
	state.holds.retain(|hold| hold.id != id);

	// Le rodage se décompte à la fermeture, pas à l'ouverture : un engagement
	// interrompu en plein vol n'a rien montré, et ne doit pas être décompté
	// comme une répétition qu'on aurait pu juger.
	if verdict == Verdict::Rehearsed && state.rehearsal_left > 0 {
		state.rehearsal_left -= 1;
	}
}

/// Ce que le trieur a répondu, ramené à une ligne lisible.
fn reason_of(why: &str) -> String {
	let trimmed = why.trim();
	if trimmed.is_empty() {
		return crate::i18n::t("permanence.dropped.byTriage");
	}
	trimmed.chars().take(160).collect()
}

/// Ce que l'agent a déclaré vouloir faire.
#[derive(Debug, Clone, Deserialize, Default)]
struct Intent {
	#[serde(default)]
	goal: String,
	#[serde(default)]
	plan: Vec<PlannedStep>,
	#[serde(default)]
	mission: bool,
	#[serde(default)]
	acts: Vec<Act>,
}

/// Un geste demandé par l'agent — **demandé**, pas posé.
#[derive(Debug, Clone, Deserialize)]
struct Act {
	#[serde(default)]
	tool: String,
	#[serde(default)]
	value: String,
}

#[derive(Debug, Clone, Deserialize)]
struct PlannedStep {
	#[serde(default)]
	what: String,
	#[serde(default)]
	why: String,
}

/// La consigne d'un engagement.
///
/// Elle dit ce qu'on attend, ce qu'il a le droit de faire, et **ce qu'il ne
/// fera jamais**. La liste des interdits est recopiée depuis `NEVER` plutôt
/// qu'écrite ici : deux endroits finiraient par ne pas dire la même chose.
fn engagement_prompt(
	engagement: &Engagement,
	rule: &crate::config::PermanenceRule,
	config: &crate::config::PermanenceConfig,
	brief: &str,
) -> String {
	let mut out = String::from(
		"You are the autonomous operator of a control cockpit. A signal has been kept, and \
		 it is up to you to say what should be done about it.\n\n\
		 **You do nothing right away.** You call `intend` only once, with your goal and the \
		 actions you plan to take. Nothing will go out before.\n\n",
	);
	out.push_str(&crate::i18n::reply_directive());
	out.push_str(" This applies to the goal and the plan you declare.\n\n");

	out.push_str(&format!(
		"## The signal\n\n{}\n\ntrigger: {}\n\n",
		engagement.label, engagement.trigger
	));
	out.push_str(&format!(
		"## The rule that authorizes you\n\n{}\n",
		if rule.label.trim().is_empty() {
			rule.id.as_str()
		} else {
			rule.label.trim()
		}
	));
	if !rule.reaction.trim().is_empty() {
		out.push_str(&format!("expected reaction: {}\n", rule.reaction.trim()));
	}
	out.push_str(&format!(
		"oracle: {} · {}\n\n",
		engagement.oracle.kind, engagement.oracle.key
	));

	out.push_str("## What you are allowed to request\n\n");
	if config.powers.is_empty() && !config.comment.enabled {
		out.push_str(
			"Nothing is checked in the allow list. Say so in your goal and request no action: \
			 it is useful information, not a failure.\n\n",
		);
	} else {
		for power in &config.powers {
			out.push_str(&format!("- `{power}`\n"));
		}
		if config.comment.enabled {
			out.push_str("- `comment` — only where a declared condition is true\n");
		}
		out.push_str(
			"\n**You take none of these actions yourself.** You request them in `acts`, and \
			 the cockpit plays them after checking they are allowed. You will not see their \
			 result: if you need to adapt along the way, that means a mission is needed.\n\n",
		);
	}

	out.push_str(&format!(
		"## What you will never do\n\n{}\n\nThese actions have no tool. They commit to a \
		 decision, not a report.\n\n",
		crate::config::NEVER
			.iter()
			.map(|never| format!("- {never}"))
			.collect::<Vec<_>>()
			.join("\n")
	));

	if !config.prompt.trim().is_empty() {
		out.push_str(&format!("## Standing instructions\n\n{}\n\n", config.prompt.trim()));
	}
	if !brief.trim().is_empty() {
		out.push_str(&format!("## What the cockpit already knows\n\n{}\n\n", brief.trim()));
	}

	out.push_str(
		"Finally: `mission` is true if code must be written. The cockpit will then open a \
		 mission — with its scope, its verdicts and its verified integration — rather than \
		 let you do it alone. For a simple action, leave it false.\n",
	);
	out
}

/// Lit l'intention déclarée par l'agent.
fn read_intent() -> Option<Intent> {
	let Ok(entries) = std::fs::read_dir(triage_dir()) else {
		return None;
	};
	let mut paths: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
	paths.sort();
	for path in paths {
		let Ok(raw) = std::fs::read_to_string(&path) else {
			continue;
		};
		let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
			continue;
		};
		if value.get("verdict").and_then(|v| v.as_str()) == Some("intend") {
			return serde_json::from_value(value).ok();
		}
	}
	None
}

/* ── L'oracle ───────────────────────────────────────────────────────────────
La preuve, pas l'impression. C'est ce qui distingue l'opération du produit :
une CI est verte ou rouge, une commande sort en 0 ou non, une propriété est
tenue ou enfreinte.

**Une règle gouverne tout ce bloc : ce qui n'a pas pu être vérifié rend
`Undecided`, jamais `Reached`.** Un oracle qu'on n'a pas su interroger n'est
pas un oracle satisfait, et les confondre transformerait chaque panne en
succès silencieux.
────────────────────────────────────────────────────────────────────────── */

/// Au-delà, on considère que la commande ne rendra rien. Un oracle qui ne
/// répond pas est indécidable, pas faux — mais il ne doit pas bloquer la
/// Permanence pour autant.
const ORACLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Le numéro de la PR porté par une clé (`github:acme/produit#412`), quand
/// elle en porte un. Les gestes et l'oracle GitHub n'ont pas de sens sans lui.
fn pr_number_of(key: &str) -> Option<u64> {
	key.rsplit_once('#').and_then(|(_, tail)| tail.parse::<u64>().ok())
}

/// Interroge l'oracle d'un engagement.
///
/// Rend le verdict **et** sa raison : un verdict sans raison ne s'apprend pas,
/// et c'est précisément ce qu'on relit quand on se demande pourquoi elle a cru
/// avoir réussi.
async fn ask_oracle(oracle: &crate::config::OracleConfig, key: &str, config: &Config) -> (Verdict, String) {
	if !oracle.stated() {
		return (Verdict::Undecided, crate::i18n::t("permanence.oracle.none"));
	}

	match oracle.kind.trim() {
		"command" => ask_command(&oracle.key, config).await,
		"ci" => ask_ci(key).await,
		"property" => ask_property(&oracle.key, key).await,
		"comment" => ask_comment(key, config).await,
		other => (
			Verdict::Undecided,
			crate::i18n::tf("permanence.oracle.unknownKind", &[("kind", &other)]),
		),
	}
}

/// Une commande du dépôt sort-elle en 0 ?
async fn ask_command(id: &str, config: &Config) -> (Verdict, String) {
	let Some(command) = config.commands.iter().find(|entry| entry.id == id) else {
		return (
			Verdict::Undecided,
			crate::i18n::tf("permanence.oracle.commandGone", &[("id", &id)]),
		);
	};
	// Une commande marquée sensible ne sert pas d'oracle : vérifier ne doit
	// jamais détruire. C'est un garde-fou que l'équipe a déjà posé, gratuit à
	// respecter.
	if command.danger {
		return (
			Verdict::Undecided,
			crate::i18n::tf("permanence.oracle.commandSensitive", &[("name", &command.label)]),
		);
	}

	let cwd = config
		.projects
		.iter()
		.map(|project| project.main_repo.clone())
		.find(|repo| !repo.is_empty() && std::path::Path::new(repo).is_dir());
	let Some(cwd) = cwd else {
		return (Verdict::Undecided, crate::i18n::t("permanence.oracle.noRepo"));
	};

	let line = crate::commands::build(command, "", &[]);
	let mut run = crate::platform::shell_async(&line);
	run.current_dir(&cwd);
	let run = run.output();

	match tokio::time::timeout(ORACLE_TIMEOUT, run).await {
		Ok(Ok(output)) if output.status.success() => (
			Verdict::Reached,
			crate::i18n::tf("permanence.oracle.commandOk", &[("line", &line)]),
		),
		Ok(Ok(output)) => {
			let stderr = String::from_utf8_lossy(&output.stderr);
			let tail: String = stderr
				.lines()
				.rev()
				.take(3)
				.collect::<Vec<_>>()
				.join(" · ")
				.chars()
				.take(240)
				.collect();
			(
				Verdict::Missed,
				crate::i18n::tf(
					"permanence.oracle.commandFailed",
					&[
						("line", &line),
						("code", &output.status.code().unwrap_or(-1)),
						("tail", &tail),
					],
				),
			)
		}
		// N'a pas pu tourner : ce n'est pas un échec de l'objectif, c'est un
		// échec de la vérification. Les deux ne se traitent pas pareil.
		Ok(Err(error)) => (
			Verdict::Undecided,
			crate::i18n::tf(
				"permanence.oracle.commandNotLaunched",
				&[("line", &line), ("error", &error)],
			),
		),
		Err(_) => (
			Verdict::Undecided,
			crate::i18n::tf("permanence.oracle.commandTimeout", &[("line", &line)]),
		),
	}
}

/// La CI de ce changement est-elle repassée au vert ?
async fn ask_ci(key: &str) -> (Verdict, String) {
	let scan = match crate::monitor::scan(None).await {
		Ok(scan) => scan,
		Err(error) => {
			return (
				Verdict::Undecided,
				crate::i18n::tf("permanence.oracle.forgesSilent", &[("error", &error)]),
			)
		}
	};
	let Some(change) = scan.changes.iter().find(|change| change.key == key) else {
		// Le changement a disparu — fusionné, fermé. L'oracle ne s'applique
		// plus : ce n'est ni un succès ni un échec.
		return (Verdict::OffTopic, crate::i18n::t("permanence.oracle.changeGone"));
	};
	match change.ci.as_str() {
		"success" => (Verdict::Reached, crate::i18n::t("permanence.oracle.ciGreen")),
		"failing" => (Verdict::Missed, crate::i18n::t("permanence.oracle.ciRed")),
		// En attente : on ne sait pas encore. Attendre serait plus juste, mais
		// prétendre savoir serait faux.
		other => (
			Verdict::Undecided,
			crate::i18n::tf("permanence.oracle.ciPending", &[("state", &other)]),
		),
	}
}

/// A-t-elle déposé un commentaire sur cette PR ?
///
/// Pensé pour une réaction qui ne fait que lire et commenter — une revue de
/// code, par exemple — là où aucune commande ni propriété du dépôt n'a de
/// rapport avec ce qu'elle a réellement fait. La preuve, ici, c'est l'acte
/// lui-même : réutilise exactement ce que `may_comment` vérifie déjà pour
/// reconnaître « un commentaire qui vient de moi ».
async fn ask_comment(key: &str, config: &Config) -> (Verdict, String) {
	let Some(number) = pr_number_of(key) else {
		return (Verdict::OffTopic, crate::i18n::t("permanence.errors.notPullRequest"));
	};
	let me = crate::integrations::github_login(config).await.to_lowercase();
	if me.is_empty() {
		return (Verdict::Undecided, crate::i18n::t("permanence.oracle.noGithubAccount"));
	}
	match crate::integrations::github_commenters(config, number).await {
		Ok(commenters) => {
			if commenters.iter().any(|login| login.trim().to_lowercase() == me) {
				(
					Verdict::Reached,
					crate::i18n::tf("permanence.oracle.commented", &[("me", &me), ("number", &number)]),
				)
			} else {
				(
					Verdict::Missed,
					crate::i18n::tf("permanence.oracle.notCommented", &[("me", &me), ("number", &number)]),
				)
			}
		}
		Err(error) => (
			Verdict::Undecided,
			crate::i18n::tf("permanence.oracle.githubSilent", &[("error", &error)]),
		),
	}
}

/// Une propriété du dépôt est-elle tenue sur ce changement ?
async fn ask_property(id: &str, key: &str) -> (Verdict, String) {
	let audit = match crate::properties::audit(key.to_string()).await {
		Ok(audit) => audit,
		Err(error) => {
			return (
				Verdict::Undecided,
				crate::i18n::tf("permanence.oracle.checkFailed", &[("error", &error)]),
			)
		}
	};
	let Some(check) = audit.checks.iter().find(|check| check.property_id == id) else {
		return (
			Verdict::OffTopic,
			crate::i18n::tf("permanence.oracle.propertyNotApplicable", &[("id", &id)]),
		);
	};
	match check.verdict.as_str() {
		"tenue" => (Verdict::Reached, check.note.clone()),
		"enfreinte" => (Verdict::Missed, check.note.clone()),
		"hors sujet" => (Verdict::OffTopic, check.note.clone()),
		// « indécis » côté propriété devient « indécidable » ici : les deux
		// disent la même chose — le juge n'a pas su conclure.
		_ => (Verdict::Undecided, check.note.clone()),
	}
}

/// Mène les signaux retenus jusqu'à un engagement.
///
/// Un seul à la fois, et le garde-fou est vérifié **à chaque tour de boucle**
/// et non une fois au départ : deux signaux retenus dans le même tri ne doivent
/// pas partir ensemble sous prétexte que la place était libre au premier.
async fn engage(mut state: State, app: Option<tauri::AppHandle>) -> Result<State> {
	let config = Config::active();
	let waiting: Vec<Signal> = state
		.signals
		.iter()
		.filter(|signal| signal.retained)
		.filter(|signal| {
			// Ce qui a déjà son engagement n'en ouvre pas un second.
			!state.engagements.iter().any(|engagement| {
				engagement.key == signal.key
					&& engagement.started_at > 0
					&& (engagement.running() || engagement.ended_at > 0)
			})
		})
		.cloned()
		.collect();

	for signal in waiting {
		if let Some(reason) = cannot_open(&state, &config.permanence, &signal.key) {
			// La raison remplace le « retenu » : un signal qui attend sa place
			// n'est pas un signal oublié, et le dire évite qu'on croie la
			// Permanence bloquée.
			if let Some(entry) = state.signals.iter_mut().find(|entry| entry.key == signal.key) {
				entry.dropped = reason;
			}
			continue;
		}
		let Some(rule) = config.permanence.rules.iter().find(|rule| rule.id == signal.rule) else {
			if let Some(entry) = state.signals.iter_mut().find(|entry| entry.key == signal.key) {
				entry.retained = false;
				entry.dropped = crate::i18n::tf("permanence.dropped.ruleGone", &[("rule", &signal.rule)]);
			}
			continue;
		};

		state = run_engagement(state, &signal, rule, app.clone()).await;
	}

	Ok(state)
}

/// Un engagement, du premier appel au verdict.
async fn run_engagement(
	mut state: State,
	signal: &Signal,
	rule: &crate::config::PermanenceRule,
	app: Option<tauri::AppHandle>,
) -> State {
	let config = Config::active();
	let engagement = open(&mut state, signal, rule);
	let id = engagement.id.clone();
	let rehearsal = engagement.rehearsal;

	// Inscrit avant de lancer : un engagement démarré puis inscrit laisserait
	// une fenêtre pendant laquelle « Tout arrêter » ne le verrait pas.
	state.holds.push(Hold {
		kind: "engagement".into(),
		id: id.clone(),
		label: signal.label.clone(),
		since: now(),
	});
	state = store(state);

	let Some(mcp) = bridge_config() else {
		close(
			&mut state,
			&id,
			Verdict::Undecided,
			&crate::i18n::t("permanence.engagement.noNode"),
		);
		return store(state);
	};

	let cwd = Config::load()
		.projects
		.iter()
		.map(|project| project.main_repo.clone())
		.find(|repo| !repo.is_empty() && std::path::Path::new(repo).is_dir())
		.unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());

	// Le dossier de contexte, assemblé pour un agent que personne ne regarde
	// partir — c'est littéralement la définition d'un engagement.
	let brief = crate::brief::for_agent(&cwd, "").await;

	clear_verdicts();
	let prompt = engagement_prompt(&engagement, rule, &config.permanence, &brief);
	let answer = crate::agent::run_once_with_tools(
		&cwd,
		&prompt,
		&config.permanence.engine,
		&config.permanence.work.model,
		&config.permanence.work.depth,
		&["Write", "Edit", "MultiEdit", "NotebookEdit"],
		&mcp,
		crate::executions::Origin {
			role: "permanence-oracle".into(),
			..crate::executions::Origin::permanence(&engagement.id)
		},
	)
	.await;

	let cost = match &answer {
		Ok(rendered) => rendered.cost_usd,
		Err(_) => 0.0,
	};
	if let Some(entry) = state.engagements.iter_mut().find(|entry| entry.id == id) {
		entry.cost_usd = cost;
	}

	if let Err(error) = answer {
		close(
			&mut state,
			&id,
			Verdict::Undecided,
			&crate::i18n::tf("permanence.engagement.agentSilent", &[("error", &error)]),
		);
		let state = store(state);
		record_outcome(false, &crate::i18n::t("permanence.engagement.agentSilentShort"));
		return state;
	}

	// Sans intention déclarée, il n'y a pas d'objectif énonçable — donc pas
	// d'engagement. C'est la condition d'arrêt, et elle vaut aussi quand
	// l'agent a bavardé sans appeler l'outil.
	let Some(intent) = read_intent() else {
		close(
			&mut state,
			&id,
			Verdict::Undecided,
			&crate::i18n::t("permanence.engagement.noIntent"),
		);
		let state = store(state);
		record_outcome(false, &crate::i18n::t("permanence.engagement.noIntentShort"));
		return state;
	};

	if let Some(entry) = state.engagements.iter_mut().find(|entry| entry.id == id) {
		entry.goal = intent.goal.trim().to_string();
		for planned in &intent.plan {
			// En rodage, la raison du geste *est* le résultat : c'est tout ce
			// qu'on a à juger, et c'est précisément ce qu'on vient lire.
			let result = if rehearsal {
				let why = planned.why.trim();
				if why.is_empty() {
					crate::i18n::t("permanence.engagement.planned")
				} else {
					crate::i18n::tf("permanence.engagement.plannedWhy", &[("why", &why)])
				}
			} else {
				String::new()
			};
			entry.step(planned.what.trim(), &result, true);
		}
		if intent.mission {
			entry.step(
				&crate::i18n::t("permanence.engagement.openMissionStep"),
				&crate::i18n::t("permanence.engagement.openMissionWhy"),
				true,
			);
		}
	}

	if rehearsal {
		// Le rodage s'arrête ici, et c'est tout son intérêt : on a payé un
		// modèle pour savoir ce qu'elle *aurait* fait, sans qu'elle le fasse.
		close(
			&mut state,
			&id,
			Verdict::Rehearsed,
			&crate::i18n::t("permanence.engagement.rehearsed"),
		);
		return store(state);
	}

	// ── Le travail ──────────────────────────────────────────────────────
	if intent.mission && !config.permanence.allows("open_mission") {
		close(
			&mut state,
			&id,
			Verdict::OffTopic,
			&crate::i18n::t("permanence.engagement.missionNotAllowed"),
		);
		return store(state);
	}
	if intent.mission {
		// La branche d'intégration de la mission est dérivée de la règle et de
		// l'objectif : elle ne peut pas tomber sur une branche partagée, mais on
		// le vérifie quand même — c'est la seule chose qui empêche un
		// `branch_from` mal inspiré d'écrire dans `dev`.
		let declared = declared_bases(&config).await;
		let branch = crate::mission::branch_from(
			&engagement.rule,
			if intent.goal.trim().is_empty() {
				&engagement.label
			} else {
				&intent.goal
			},
		);
		if config.permanence.protected_branch(&branch, &declared) {
			close(
				&mut state,
				&id,
				Verdict::OffTopic,
				&crate::i18n::tf("permanence.engagement.sharedBranch", &[("branch", &branch)]),
			);
			return store(state);
		}
		match delegate(&engagement, &intent, &cwd, rule) {
			Ok(mission) => {
				if let Some(entry) = state.engagements.iter_mut().find(|entry| entry.id == id) {
					entry.stage = Stage::Running;
					entry.mission = mission.id.clone();
					entry.step(
						&crate::i18n::t("permanence.engagement.missionOpenedStep"),
						&crate::i18n::tf("permanence.engagement.missionName", &[("name", &mission.title)]),
						true,
					);
					entry.produced.push(Produced {
						kind: "mission".into(),
						label: mission.title.clone(),
						reference: mission.id.clone(),
						url: String::new(),
						undoable: true,
					});
				}
				// La mission entre dans ce qu'elle tient : l'arrêt d'urgence doit
				// pouvoir la mettre en pause.
				state.holds.push(Hold {
					kind: "mission".into(),
					id: mission.id.clone(),
					label: mission.title.clone(),
					since: now(),
				});
				if rule.needs_approval {
					if let Some(entry) = state.engagements.iter_mut().find(|entry| entry.id == id) {
						entry.step(
							&crate::i18n::t("permanence.engagement.awaitingApprovalStep"),
							&crate::i18n::t("permanence.engagement.awaitingApprovalWhy"),
							true,
						);
					}
				}
				// L'oracle ne se pose pas maintenant : la mission n'a rien
				// produit encore. Il sera interrogé quand elle se refermera —
				// juger tout de suite rendrait « manqué » sur un travail qui
				// n'a pas commencé.
				return store(state);
			}
			Err(error) => {
				close(
					&mut state,
					&id,
					Verdict::Undecided,
					&crate::i18n::tf("permanence.engagement.missionFailed", &[("error", &error)]),
				);
				let state = store(state);
				record_outcome(false, &crate::i18n::t("permanence.engagement.missionFailedShort"));
				return state;
			}
		}
	}

	// ── Les gestes ──────────────────────────────────────────────────────
	// L'agent les a demandés, le cockpit les joue — après avoir vérifié la
	// liste blanche, une fois par geste.
	if let Some(entry) = state.engagements.iter_mut().find(|entry| entry.id == id) {
		entry.stage = Stage::Running;
	}
	state = store(state);

	let mut refused = 0;
	for act in &intent.acts {
		let (result, ok, produced) = match perform(act, &engagement, &config, app.as_ref()).await {
			Ok((result, produced)) => (result, true, produced),
			Err(error) => {
				refused += 1;
				(error, false, None)
			}
		};
		crate::journal::record_as(
			crate::journal::PERMANENCE,
			&id,
			"permanence",
			&crate::i18n::tf("permanence.journal.act", &[("tool", &act.tool.trim())]),
			&engagement.key,
			ok,
			&result,
		);
		if let Some(entry) = state.engagements.iter_mut().find(|entry| entry.id == id) {
			entry.step(act.tool.trim(), &result, ok);
			if let Some(produced) = produced {
				entry.produced.push(produced);
			}
		}
		state = store(state);
	}

	let (verdict, why) = ask_oracle(&engagement.oracle, &engagement.key, &config).await;
	// Un oracle atteint alors que tous les gestes ont été refusés ne prouve
	// rien de ce qu'elle a fait : la situation s'est résolue sans elle, et le
	// dire évite de lui attribuer un succès qui ne lui revient pas.
	let posed = intent.acts.len().saturating_sub(refused);
	let why = match (verdict, intent.acts.is_empty(), posed) {
		(Verdict::Reached, true, _) => crate::i18n::tf("permanence.engagement.resolvedWithoutActs", &[("why", &why)]),
		(Verdict::Reached, false, 0) => crate::i18n::tf("permanence.engagement.resolvedAllRefused", &[("why", &why)]),
		_ if refused > 0 => crate::i18n::tf(
			"permanence.engagement.someRefused",
			&[("why", &why), ("count", &refused)],
		),
		_ => why,
	};
	close(&mut state, &id, verdict, &why);
	let state = store(state);
	record_outcome(!verdict.failed(), &why);
	state
}

/* ── Poser les gestes ───────────────────────────────────────────────────────
**L'agent déclare, le cockpit dispose.** C'est la doctrine d'`orchestrator.rs`
appliquée ici : décider demande du jugement, poser un geste demande de la
rigueur, et confier l'un à l'autre donne un agent qui hallucine des chemins.

Conséquence assumée : l'agent ne voit pas le résultat de ses gestes et ne
peut donc pas s'adapter en chaîne. C'est voulu — un agent qui enchaîne des
actions en s'adaptant, sans personne pour regarder, est exactement ce qu'on
cherche à éviter. S'il faut de l'adaptation, il faut une mission.
────────────────────────────────────────────────────────────────────────── */

/// Exécute un geste demandé, si et seulement s'il est autorisé.
///
/// Rend ce qu'il a produit, ou l'erreur. **La liste blanche est vérifiée ici**
/// et non dans la consigne : un modèle à qui on a dit « tu n'as pas le droit »
/// finira un jour par essayer quand même, et c'est le code qui doit refuser.
async fn perform(
	act: &Act,
	engagement: &Engagement,
	config: &Config,
	app: Option<&tauri::AppHandle>,
) -> std::result::Result<(String, Option<Produced>), String> {
	let power = act.tool.trim();
	if !config.permanence.allows(power) {
		return Err(crate::i18n::tf("permanence.acts.notAllowed", &[("power", &power)]));
	}

	// **Aucun geste ne touche une branche partagée.** Vérifié ici, une fois,
	// pour tous les gestes : le mettre dans chaque branche du `match` marcherait
	// jusqu'au jour où l'on en ajoute un et où l'on oublie la ligne.
	let branch = branch_of(&engagement.key, config).await;
	let declared = declared_bases(config).await;
	if !branch.is_empty() && config.permanence.protected_branch(&branch, &declared) && writes_to_branch(power) {
		return Err(crate::i18n::tf("permanence.acts.sharedBranch", &[("branch", &branch)]));
	}

	// Le numéro de la PR, quand la clé en porte un. Les gestes GitHub n'ont pas
	// de sens sans lui.
	let number = pr_number_of(&engagement.key);

	match power {
		"rerun_pipeline" => {
			if branch.is_empty() {
				return Err(crate::i18n::t("permanence.acts.noBranch"));
			}
			match crate::integrations::github_rerun(config, &branch).await {
				Ok(id) => Ok((crate::i18n::tf("permanence.acts.rerun", &[("id", &id)]), None)),
				Err(error) => Err(error.to_string()),
			}
		}
		"set_label" => {
			let label = act.value.trim();
			if label.is_empty() {
				return Err(crate::i18n::t("permanence.acts.noLabel"));
			}
			let Some(number) = number else {
				return Err(crate::i18n::t("permanence.errors.notPullRequest"));
			};
			match crate::integrations::github_add_label(config, number, label).await {
				Ok(()) => Ok((
					crate::i18n::tf("permanence.acts.labelSet", &[("label", &label)]),
					Some(Produced {
						kind: "label".into(),
						label: crate::i18n::tf("permanence.acts.labelOn", &[("label", &label), ("number", &number)]),
						reference: label.to_string(),
						url: String::new(),
						undoable: true,
					}),
				)),
				Err(error) => Err(error.to_string()),
			}
		}
		"run_command" => {
			let id = act.value.trim();
			let Some(command) = config.commands.iter().find(|entry| entry.id == id) else {
				return Err(crate::i18n::tf("permanence.acts.commandUnknown", &[("id", &id)]));
			};
			// Une commande sensible ne se joue jamais sans quelqu'un devant :
			// le drapeau vient de l'équipe, et le cocher dans la liste blanche
			// ne doit pas suffire à l'effacer.
			if command.danger {
				return Err(crate::i18n::tf(
					"permanence.acts.commandSensitive",
					&[("name", &command.label)],
				));
			}
			match ask_command(id, config).await {
				(Verdict::Reached, why) => Ok((why, None)),
				(_, why) => Err(why),
			}
		}
		"create_branch" => {
			let name = act.value.trim();
			if name.is_empty() {
				return Err(crate::i18n::t("permanence.acts.noBranchName"));
			}
			// Créer une branche qui porte le nom d'une branche partagée, c'est
			// se donner le droit d'y écrire au geste suivant.
			if config.permanence.protected_branch(name, &declared) {
				return Err(crate::i18n::tf("permanence.acts.sharedBranchName", &[("name", &name)]));
			}
			let repo = main_repo(config).ok_or_else(|| crate::i18n::t("permanence.acts.noRepo"))?;
			match crate::git::run_git(std::path::Path::new(&repo), &["branch", name]).await {
				Ok(_) => Ok((
					crate::i18n::tf("permanence.acts.branchCreated", &[("name", &name)]),
					Some(Produced {
						kind: "branch".into(),
						label: name.to_string(),
						reference: name.to_string(),
						url: String::new(),
						undoable: true,
					}),
				)),
				Err(error) => Err(error.to_string()),
			}
		}
		"open_worktree" => {
			let branch = act.value.trim();
			if branch.is_empty() {
				return Err(crate::i18n::t("permanence.acts.noWorktreeBranch"));
			}
			if config.permanence.protected_branch(branch, &declared) {
				return Err(crate::i18n::tf(
					"permanence.acts.sharedWorktree",
					&[("branch", &branch)],
				));
			}
			let repo = main_repo(config).ok_or_else(|| crate::i18n::t("permanence.acts.noRepo"))?;
			// La commande de l'équipe si elle en a une, `git worktree add`
			// sinon : le cockpit ne réinvente pas la façon de sortir une
			// branche, il joue celle qui est déclarée.
			let (line, by_agent) = config.workflow.worktree_creation(branch, "");
			if by_agent {
				return Err(crate::i18n::t("permanence.acts.worktreeByAgent"));
			}
			match crate::platform::shell_async(&line).current_dir(&repo).output().await {
				Ok(output) if output.status.success() => Ok((
					crate::i18n::tf("permanence.acts.worktreeOpened", &[("branch", &branch)]),
					Some(Produced {
						kind: "worktree".into(),
						label: branch.to_string(),
						reference: branch.to_string(),
						url: String::new(),
						undoable: true,
					}),
				)),
				Ok(output) => Err(crate::i18n::tf(
					"permanence.acts.lineFailed",
					&[
						("line", &line),
						(
							"error",
							&String::from_utf8_lossy(&output.stderr)
								.lines()
								.next()
								.unwrap_or_default()
								.chars()
								.take(160)
								.collect::<String>(),
						),
					],
				)),
				Err(error) => Err(crate::i18n::tf(
					"permanence.oracle.commandNotLaunched",
					&[("line", &line), ("error", &error)],
				)),
			}
		}
		"open_draft_pr" => {
			if branch.is_empty() {
				return Err(crate::i18n::t("permanence.acts.noBranch"));
			}
			let repo = main_repo(config).ok_or_else(|| crate::i18n::t("permanence.acts.noRepo"))?;
			let folder = std::path::Path::new(&repo);
			let base = crate::git::default_branch(folder).await;
			let title = if act.value.trim().is_empty() {
				engagement.goal.clone()
			} else {
				act.value.trim().to_string()
			};
			// **En brouillon, toujours.** Une PR prête à relire réclame
			// l'attention de quelqu'un ; c'est un geste qui engage une
			// décision, et ce n'en est pas un qu'elle a le droit de poser.
			match crate::integrations::create_pull_request(config, &branch, &base, &title, "", true).await {
				Ok(url) => Ok((
					crate::i18n::tf("permanence.acts.draftOpened", &[("url", &url)]),
					Some(Produced {
						kind: "pr".into(),
						label: crate::i18n::tf("permanence.acts.draftLabel", &[("branch", &branch)]),
						reference: branch.clone(),
						url,
						undoable: false,
					}),
				)),
				Err(error) => Err(error.to_string()),
			}
		}
		// Le geste le plus lourd de la liste, et le seul qui écrit du code sans
		// les garde-fous d'une mission — ni périmètre, ni verdict, ni
		// intégration vérifiée. Il n'existe que pour les cas où une mission
		// serait disproportionnée, et il est borné en conséquence : dans le
		// worktree de la branche, avec la consigne de l'engagement, inscrit
		// dans ce qu'elle tient pour que « Tout arrêter » le voie.
		"start_agent" => {
			if branch.is_empty() {
				return Err(crate::i18n::t("permanence.acts.noBranch"));
			}
			let repo = main_repo(config).ok_or_else(|| crate::i18n::t("permanence.acts.noRepo"))?;
			// Un agent lancé dans le dépôt principal écrirait sur la branche
			// courante — celle sur laquelle quelqu'un travaille peut-être en ce
			// moment. Sans worktree dédié, on refuse.
			let worktree = crate::git::worktree_for_branch(std::path::Path::new(&repo), &branch)
				.await
				.ok()
				.flatten()
				.map(|path| path.to_string_lossy().to_string());
			let Some(worktree) = worktree else {
				return Err(crate::i18n::tf("permanence.acts.noWorktree", &[("branch", &branch)]));
			};

			let Some(app) = app else {
				return Err(crate::i18n::t("permanence.acts.needsApp"));
			};

			let prompt = format!(
				"{}\n\nGoal: {}\n\nYou are working alone, with nobody to answer you: do not ask \
				 questions, and report what you are missing rather than inventing it. Commit what \
				 you produce — what is not committed does not exist.\n\n{}",
				act.value.trim(),
				engagement.goal,
				crate::i18n::reply_directive()
			);
			let agents = <tauri::AppHandle as tauri::Manager<tauri::Wry>>::state::<crate::agent::SharedAgents>(app);
			match crate::agent::start(
				app.clone(),
				agents.inner().clone(),
				worktree.clone(),
				prompt,
				Some("acceptEdits".into()),
				Some(config.permanence.work.model.clone()).filter(|m| !m.is_empty()),
				None,
				Some(config.permanence.engine.clone()).filter(|e| !e.is_empty()),
				crate::executions::Origin::permanence(&engagement.id),
			)
			.await
			{
				Ok(session) => {
					// Inscrit sur-le-champ : « Tout arrêter » ne coupe que ce
					// qu'elle tient, et un agent lancé sans l'être survivrait.
					let label = crate::i18n::tf("permanence.acts.agentOn", &[("branch", &branch)]);
					hold("agent", &session, &label);
					Ok((
						crate::i18n::tf("permanence.acts.agentStarted", &[("worktree", &worktree)]),
						Some(Produced {
							kind: "agent".into(),
							label,
							reference: session,
							url: String::new(),
							undoable: true,
						}),
					))
				}
				Err(error) => Err(error.to_string()),
			}
		}
		"comment" => {
			let Some(number) = number else {
				return Err(crate::i18n::t("permanence.errors.notPullRequest"));
			};
			let body = act.value.trim();
			if body.is_empty() {
				return Err(crate::i18n::t("permanence.acts.noText"));
			}
			if let Err(refus) = may_comment(config, number).await {
				return Err(refus);
			}
			match crate::integrations::github_comment(config, number, body).await {
				Ok(url) => Ok((
					crate::i18n::t("permanence.acts.commented"),
					Some(Produced {
						kind: "comment".into(),
						label: crate::i18n::tf("permanence.acts.commentOn", &[("number", &number)]),
						reference: number.to_string(),
						url,
						// Un commentaire se supprime sur GitHub, mais il a été lu :
						// le cockpit ne prétend pas pouvoir le défaire.
						undoable: false,
					}),
				)),
				Err(error) => Err(error.to_string()),
			}
		}
		other => Err(crate::i18n::tf("permanence.acts.unknown", &[("tool", &other)])),
	}
}

/// Les gestes qui écrivent sur une branche.
///
/// Relancer une CI, poser un label ou commenter ne touchent pas au code : les
/// interdire sur une branche partagée n'apporterait rien et rendrait la
/// Permanence inutile là où elle est justement la plus utile.
fn writes_to_branch(power: &str) -> bool {
	matches!(
		power,
		"create_branch" | "open_worktree" | "start_agent" | "open_draft_pr" | "open_mission"
	)
}

/// Les branches que l'équipe considère comme des bases, plus celle du dépôt.
async fn declared_bases(config: &Config) -> Vec<String> {
	let mut all = config.workflow.base_branches.clone();
	if let Some(repo) = main_repo(config) {
		let default = crate::git::default_branch(std::path::Path::new(&repo)).await;
		if !default.trim().is_empty() {
			all.push(default);
		}
	}
	all
}

/// Le dépôt local sur lequel poser un geste.
fn main_repo(config: &Config) -> Option<String> {
	config
		.projects
		.iter()
		.map(|project| project.main_repo.clone())
		.find(|repo| !repo.is_empty() && std::path::Path::new(repo).is_dir())
}

/// La branche d'un changement, relue depuis les forges.
async fn branch_of(key: &str, _config: &Config) -> String {
	crate::monitor::scan(None)
		.await
		.ok()
		.and_then(|scan| {
			scan.changes
				.into_iter()
				.find(|change| change.key == key)
				.map(|change| change.branch)
		})
		.unwrap_or_default()
}

/// Cette pull request est-elle ouverte au commentaire ?
///
/// Le consentement porte sur l'**objet** : on n'autorise pas « commenter », on
/// autorise « commenter là ». Aucune condition vraie, et elle n'écrit pas —
/// même si le pouvoir est coché.
async fn may_comment(config: &Config, number: u64) -> std::result::Result<(), String> {
	let comment = &config.permanence.comment;
	if !comment.enabled {
		return Err(crate::i18n::t("permanence.comment.disabled"));
	}
	if comment.scopes.is_empty() {
		return Err(crate::i18n::t("permanence.comment.noScopes"));
	}

	let me = crate::integrations::github_login(config).await.to_lowercase();

	if comment.opens("i_commented") {
		if !me.is_empty() {
			let commenters = crate::integrations::github_commenters(config, number)
				.await
				.unwrap_or_default();
			if commenters.iter().any(|login| login.trim().to_lowercase() == me) {
				return Ok(());
			}
		}
	}
	if comment.opens("i_allowed") && config.permanence.allowed_pr(number) {
		return Ok(());
	}
	// `hers` et `mine` demandent de savoir qui a ouvert la PR : le scan le dit.
	if comment.opens("hers") || comment.opens("mine") {
		let author = crate::monitor::scan(None)
			.await
			.ok()
			.and_then(|scan| {
				scan.changes
					.into_iter()
					.find(|change| change.key.ends_with(&format!("#{number}")))
					.map(|change| change.author)
			})
			.unwrap_or_default()
			.trim()
			.to_lowercase();
		if comment.opens("mine") && !me.is_empty() && author == me {
			return Ok(());
		}
	}

	Err(crate::i18n::tf(
		"permanence.comment.noCondition",
		&[("number", &number)],
	))
}

/// Interroge l'oracle des engagements dont le travail vient de s'achever.
///
/// C'est ici que se referme la boucle promise par le modèle : la mission dit
/// qu'elle a fini, l'oracle dit si l'objectif est atteint. **Une mission
/// terminée n'est pas un objectif atteint** — elle a produit quelque chose, ce
/// qui ne prouve pas que ce quelque chose marche.
async fn ripen(mut state: State) -> Result<State> {
	let config = Config::active();
	let pending: Vec<(String, String)> = state
		.engagements
		.iter()
		.filter(|engagement| engagement.running() && !engagement.mission.is_empty())
		.map(|engagement| (engagement.id.clone(), engagement.mission.clone()))
		.collect();

	for (id, mission_id) in pending {
		let Ok(mission) = crate::mission::get(&mission_id) else {
			close(
				&mut state,
				&id,
				Verdict::Undecided,
				&crate::i18n::t("permanence.engagement.missionGone"),
			);
			state = store(state);
			record_outcome(false, &crate::i18n::t("permanence.engagement.missionGoneShort"));
			continue;
		};

		let done = matches!(
			mission.state,
			crate::mission::MissionState::Done | crate::mission::MissionState::Failed
		);
		if !done {
			continue;
		}

		let (key, oracle) = state
			.engagements
			.iter()
			.find(|engagement| engagement.id == id)
			.map(|engagement| (engagement.key.clone(), engagement.oracle.clone()))
			.unwrap_or_default();

		let (verdict, why) = if mission.state == crate::mission::MissionState::Failed {
			// La mission a échoué : inutile d'interroger l'oracle, on sait déjà
			// que le travail n'a pas eu lieu.
			(
				Verdict::Missed,
				crate::i18n::tf("permanence.engagement.missionFailedNote", &[("note", &mission.note)]),
			)
		} else {
			ask_oracle(&oracle, &key, &config).await
		};

		if let Some(engagement) = state.engagements.iter_mut().find(|entry| entry.id == id) {
			engagement.step(
				&crate::i18n::t("permanence.engagement.askOracle"),
				&why,
				!verdict.failed(),
			);
			if !mission.pr_url.is_empty() {
				engagement.produced.push(Produced {
					kind: "pr".into(),
					label: mission.title.clone(),
					reference: mission.id.clone(),
					url: mission.pr_url.clone(),
					undoable: false,
				});
			}
		}
		close(&mut state, &id, verdict, &why);
		state.holds.retain(|hold| hold.id != mission_id);
		state = store(state);
		record_outcome(!verdict.failed(), &why);
	}

	Ok(state)
}

/// Confie le travail à une mission.
///
/// La Permanence ne réimplémente pas ce que `mission.rs` sait faire : périmètre
/// d'écriture, rôles, verdicts, intégration vérifiée — et une trace que
/// personne n'a eu à inventer pour elle. Dès qu'il faut écrire du code, elle
/// délègue.
///
/// **Le consentement remonte d'un cran.** Une mission attend normalement un
/// accord humain sur son plan ; ici l'accord a été donné une fois, à la règle,
/// avec son déclencheur, son oracle et son budget. Ce qui tient encore le
/// dispositif à ce moment-là : l'oracle, le périmètre, les plafonds et la liste
/// blanche.
fn delegate(
	engagement: &Engagement,
	intent: &Intent,
	cwd: &str,
	rule: &crate::config::PermanenceRule,
) -> Result<crate::mission::Mission> {
	let title = if intent.goal.trim().is_empty() {
		engagement.label.clone()
	} else {
		intent.goal.trim().to_string()
	};
	let branch = crate::mission::branch_from(&engagement.rule, &title);
	let mission = crate::mission::create(&title, "", "", cwd, &branch, false)?;

	crate::journal::record_as(
		crate::journal::PERMANENCE,
		&engagement.id,
		"mission",
		&crate::i18n::t("permanence.journal.missionOpened"),
		&mission.title,
		true,
		&if rule.needs_approval {
			crate::i18n::tf("permanence.journal.ruleAwaiting", &[("rule", &engagement.rule)])
		} else {
			crate::i18n::tf("permanence.journal.rule", &[("rule", &engagement.rule)])
		},
	);
	Ok(mission)
}

/// Applique un verdict à tous les signaux en attente.
fn settle(mut state: State, decide: impl Fn(&Signal) -> (bool, String, String)) -> State {
	for signal in state.signals.iter_mut().filter(|signal| signal.pending) {
		let (retained, rule, dropped) = decide(signal);
		signal.retained = retained;
		signal.rule = rule;
		signal.dropped = dropped;
		signal.pending = false;
	}
	state
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::config::PermanenceConfig;

	fn change(key: &str, ci: &str, review: &str) -> crate::monitor::Change {
		crate::monitor::Change {
			key: key.into(),
			project: "principal".into(),
			project_name: "Produit".into(),
			project_color: String::new(),
			forge: "github".into(),
			repo: "acme/produit".into(),
			reference: "#412".into(),
			title: "Corrige l'éditeur".into(),
			author: "moi".into(),
			branch: "fix/editeur".into(),
			base: "main".into(),
			url: String::new(),
			draft: false,
			head_sha: "abc123".into(),
			additions: None,
			deletions: None,
			changed_files: None,
			ci: ci.into(),
			review: review.into(),
			review_requested: Vec::new(),
			updated_at: String::new(),
			worktree: String::new(),
			repo_path: String::new(),
			labels: Vec::new(),
			analysis: None,
		}
	}

	/// L'empreinte ne retient que ce dont un signal peut naître : un titre
	/// corrigé ou un label posé ne doit pas réveiller la Permanence.
	#[test]
	fn un_titre_corrige_ne_bouge_pas_l_empreinte() {
		let mut avant = change("k", "success", "");
		let apres = {
			let mut copie = avant.clone();
			copie.title = "Corrige enfin l'éditeur".into();
			copie.updated_at = "2026-08-07T18:00:00Z".into();
			copie
		};
		assert_eq!(fingerprint(&avant), fingerprint(&apres));

		// La CI, elle, compte.
		avant.ci = "failing".into();
		assert_ne!(fingerprint(&avant), fingerprint(&apres));
	}

	/// Rester rouge n'est pas un événement : sans ça, la Permanence se
	/// réveillerait à chaque tour sur la même branche cassée.
	#[test]
	fn seul_le_passage_au_rouge_declenche() {
		let rouge = change("k", "failing", "");
		assert_eq!(trigger_of(Some("abc|success||false"), &rouge), "ci_red");
		assert_eq!(trigger_of(Some("abc|failing||false"), &rouge), "");

		// Sans passé connu, un rouge est un rouge : c'est le premier regard qui
		// décide s'il compte, pas cette fonction.
		assert_eq!(trigger_of(None, &rouge), "ci_red");
	}

	#[test]
	fn une_revue_qui_demande_des_changements_declenche_une_fois() {
		let demande = change("k", "success", "changes_requested");
		assert_eq!(
			trigger_of(Some("abc|success||false"), &demande),
			"review_changes_requested"
		);
		assert_eq!(trigger_of(Some("abc|success|changes_requested|false"), &demande), "");
	}

	#[test]
	fn un_delta_ordinaire_ne_declenche_rien() {
		let vert = change("k", "success", "");
		assert_eq!(trigger_of(Some("vieux|pending||false"), &vert), "");
	}

	/// La régression réelle : une condition « la revue m'est attribuée en
	/// tant que reviewer » se rendait « non vérifiable » même quand
	/// l'utilisateur était bien listé comme reviewer sur GitHub — la donnée
	/// n'atteignait simplement jamais le tri. Voir `signal_context`.
	#[test]
	fn le_contexte_du_signal_porte_les_reviewers_demandes() {
		let demande = crate::monitor::Change {
			review_requested: vec!["octocat".into(), "autre".into()],
			..change("k", "success", "changes_requested")
		};
		let contexte = signal_context(&demande);
		assert!(contexte.contains("review requested from: octocat, autre"));
		assert!(contexte.contains("author: moi"));
	}

	#[test]
	fn le_contexte_est_vide_sans_auteur_ni_reviewer_connu() {
		let mut sans_rien = change("k", "success", "");
		sans_rien.author = String::new();
		assert_eq!(signal_context(&sans_rien), "");
	}

	#[test]
	fn le_numero_de_pr_se_lit_dans_la_cle() {
		assert_eq!(pr_number_of("github:acme/produit#412"), Some(412));
		assert_eq!(pr_number_of("gitlab:groupe/produit!17"), None);
		assert_eq!(pr_number_of("local:produit@fix/editeur"), None);
	}

	fn linear_issue(priority: &str) -> crate::integrations::FeedItem {
		crate::integrations::FeedItem {
			id: "NW-2816".into(),
			source: "linear".into(),
			title: "Recherche produits par catégorie".into(),
			subtitle: String::new(),
			status: String::new(),
			severity: "info".into(),
			url: String::new(),
			timestamp: None,
			meta: Vec::new(),
			tags: if priority.is_empty() {
				Vec::new()
			} else {
				vec![crate::integrations::Tag {
					label: priority.into(),
					color: String::new(),
					tone: "critical".into(),
				}]
			},
			payload: serde_json::json!({}),
		}
	}

	#[test]
	fn l_empreinte_linear_suit_la_priorite_pas_le_titre() {
		assert_eq!(linear_fingerprint(&linear_issue("Urgent")), "Urgent");
		assert_ne!(
			linear_fingerprint(&linear_issue("Urgent")),
			linear_fingerprint(&linear_issue("Haute"))
		);
	}

	#[test]
	fn le_contexte_linear_dit_l_assignation_et_la_priorite() {
		let contexte = linear_context(&linear_issue("Urgent"));
		assert!(contexte.contains("assigned to me"));
		assert!(contexte.contains("Urgent"));
	}

	#[test]
	fn un_ticket_sans_priorite_ne_fait_pas_planter_le_contexte() {
		assert_eq!(linear_fingerprint(&linear_issue("")), "");
		assert!(linear_context(&linear_issue("")).contains("no priority"));
	}

	/// Les portes se ferment dans l'ordre où elles coûtent : un service
	/// désactivé n'a pas à consulter l'horloge, et surtout la raison rendue
	/// doit être la vraie — « hors des heures » quand on est désactivé
	/// enverrait corriger le mauvais réglage.
	#[test]
	fn chaque_porte_dit_laquelle_elle_est() {
		let repos = State::default();
		let eteinte = PermanenceConfig::default();
		assert_eq!(gate(&eteinte, &repos, None), Some(Closed::Disabled));

		let allumee = PermanenceConfig {
			enabled: true,
			..Default::default()
		};
		assert_eq!(gate(&allumee, &repos, None), None);

		let suspendue = State {
			suspended: true,
			..Default::default()
		};
		assert_eq!(gate(&allumee, &suspendue, None), Some(Closed::Suspended));

		// Le quota partagé ferme la porte, mais seulement quand on sait le lire.
		assert_eq!(gate(&allumee, &repos, Some(95)), Some(Closed::Quota));
		assert_eq!(gate(&allumee, &repos, Some(10)), None);
		assert_eq!(gate(&allumee, &repos, None), None);
	}

	fn waiting(key: &str, trigger: &str) -> Signal {
		Signal {
			key: key.into(),
			project: "Produit".into(),
			source: "GitHub".into(),
			label: "#412 · Corrige l'éditeur".into(),
			trigger: trigger.into(),
			context: String::new(),
			at: 0,
			dropped: String::new(),
			rule: String::new(),
			retained: false,
			pending: true,
		}
	}

	/// Le tri ne touche qu'à ce qui l'attend : un signal déjà tranché au regard
	/// précédent ne doit pas être rejugé par le verdict d'un autre tour.
	#[test]
	fn le_tri_ne_reprend_pas_ce_qui_est_deja_trie() {
		let deja = Signal {
			dropped: "aucun déclencheur reconnu".into(),
			pending: false,
			..waiting("vieux", "")
		};
		let state = State {
			signals: vec![deja, waiting("neuf", "ci_red")],
			..Default::default()
		};

		let apres = settle(state, |_| (true, "ci".into(), String::new()));
		assert_eq!(apres.signals[0].dropped, "aucun déclencheur reconnu");
		assert!(!apres.signals[0].retained, "l'ancien reste écarté");
		assert!(apres.signals[1].retained, "le neuf est retenu");
		assert_eq!(apres.signals[1].rule, "ci");
		assert!(apres.signals.iter().all(|signal| !signal.pending));
	}

	/// Un trieur muet ne dit pas « rien à faire » : il dit qu'il n'a pas trié.
	/// Confondre les deux ferait passer une panne pour un calme plat — c'est
	/// exactement ce que `properties.rs` refuse avec son verdict « indécis ».
	#[test]
	fn un_tri_sans_reponse_ne_vaut_pas_un_silence() {
		let state = State {
			signals: vec![waiting("k", "ci_red")],
			..Default::default()
		};
		let apres = settle(state, |_| {
			(false, String::new(), "tri sans réponse : le CLI a échoué".into())
		});
		assert!(!apres.signals[0].retained);
		assert!(
			apres.signals[0].dropped.contains("sans réponse"),
			"la panne doit se lire dans la raison : {}",
			apres.signals[0].dropped
		);
	}

	/// Un signal que le trieur a sauté n'a reçu aucun verdict : le dire vaut
	/// mieux que d'inventer un silence qu'il n'a pas prononcé.
	#[test]
	fn un_signal_oublie_par_le_tri_le_dit() {
		let state = State {
			signals: vec![waiting("absent", "ci_red")],
			..Default::default()
		};
		let apres = settle(state, |_| (false, String::new(), "le tri ne s'est pas prononcé".into()));
		assert_eq!(apres.signals[0].dropped, "le tri ne s'est pas prononcé");
	}

	/// Une raison vide reste une raison : un signal écarté sans un mot ne se
	/// distinguerait pas d'un signal qu'on n'a pas regardé.
	#[test]
	fn une_raison_vide_est_remplacee() {
		assert_eq!(reason_of(""), "dismissed by triage");
		assert_eq!(reason_of("   "), "dismissed by triage");
		assert_eq!(reason_of("  la CI est déjà repartie  "), "la CI est déjà repartie");
		assert_eq!(reason_of(&"x".repeat(400)).chars().count(), 160);
	}

	/// La consigne ne porte que le delta : les règles vivantes et les signaux
	/// frais. Y glisser un historique la rendrait chère à chaque réveil, et le
	/// cache expire bien avant le suivant.
	#[test]
	fn la_consigne_du_tri_ne_porte_que_le_delta() {
		let regle = crate::config::PermanenceRule {
			id: "ci".into(),
			label: "CI rouge".into(),
			trigger: "ci_red".into(),
			condition: "l'auteur du dernier commit, c'est moi".into(),
			..Default::default()
		};
		let signal = waiting("github:acme/produit#412", "ci_red");
		let prompt = triage_prompt(&[&regle], &[&signal], "octocat");

		assert!(prompt.contains("`ci`"), "la règle est nommée");
		assert!(prompt.contains("l'auteur du dernier commit"));
		assert!(prompt.contains("github:acme/produit#412"));
		assert!(prompt.contains("octocat"), "le compte GitHub est donné au tri");
		assert!(
			prompt.contains("When in doubt, dismiss"),
			"le biais doit être dit : retenir à tort coûte, écarter à tort ne coûte rien"
		);
	}

	/* ── Les garde-fous ─────────────────────────────────────────────────── */

	/// Le mode de défaillance le plus vicieux : elle pousse un commit, la tête
	/// de branche bouge, et le delta la réveille sur son propre travail.
	#[test]
	fn un_objet_qu_elle_vient_de_traiter_est_laisse_tranquille() {
		let mut state = State::default();
		let maintenant = 1_000_000;
		assert!(!state.quarantined("k", maintenant));

		state.quarantine_for("k", 6, maintenant);
		assert!(state.quarantined("k", maintenant + 3600), "une heure après");
		assert!(state.quarantined("k", maintenant + 5 * 3600), "cinq heures après");
		assert!(
			!state.quarantined("k", maintenant + 7 * 3600),
			"sept heures après, elle peut y revenir"
		);
		assert!(!state.quarantined("autre", maintenant), "un seul objet visé");
	}

	/// La carte des quarantaines ne doit pas grossir avec chaque PR jamais
	/// revue : elle se vide de ce qui a expiré.
	#[test]
	fn les_quarantaines_expirees_s_oublient() {
		let mut state = State::default();
		state.quarantine_for("vieux", 1, 0);
		state.quarantine_for("recent", 10, 1_000);
		state.sweep(5_000);
		assert!(!state.quarantine.contains_key("vieux"));
		assert!(state.quarantine.contains_key("recent"));
	}

	/// Le rodage protège de ce qu'on vient de lui donner. Élargir ses pouvoirs
	/// est un autre dispositif : on le regarde avant de le lâcher.
	/// Le piège trouvé au banc d'essai : une liste blanche vide a pour empreinte
	/// la chaîne vide, qui était aussi la valeur initiale. Le rodage ne s'armait
	/// donc jamais sur une installation neuve — celle qu'il protège.
	#[test]
	fn le_rodage_s_arme_meme_sans_aucun_pouvoir() {
		let mut state = State::default();
		assert!(state.armed_on.is_none(), "jamais armé au départ");
		state.arm("", 10);
		assert_eq!(state.rehearsal_left, 10);
		assert!(state.rehearsing());

		// Et il ne se réarme pas au regard suivant, à liste inchangée.
		state.rehearsal_left = 4;
		state.arm("", 10);
		assert_eq!(state.rehearsal_left, 4);
	}

	#[test]
	fn changer_les_pouvoirs_rearme_le_rodage() {
		let mut state = State::default();
		state.arm("rerun_pipeline", 10);
		assert_eq!(state.rehearsal_left, 10);
		assert!(state.rehearsing());

		// Le rodage s'écoule.
		state.rehearsal_left = 2;
		state.arm("rerun_pipeline", 10);
		assert_eq!(state.rehearsal_left, 2, "même dispositif : on ne réarme pas");

		// Un pouvoir de plus, et le compteur repart.
		state.arm("rerun_pipeline,open_draft_pr", 10);
		assert_eq!(state.rehearsal_left, 10);

		// Y compris quand on restreint : ce qui compte est que ça a changé.
		state.rehearsal_left = 1;
		state.arm("open_draft_pr", 10);
		assert_eq!(state.rehearsal_left, 10);
	}

	#[test]
	fn le_rodage_epuise_laisse_agir() {
		let mut state = State::default();
		state.arm("x", 1);
		assert!(state.rehearsing());
		state.rehearsal_left = 0;
		assert!(!state.rehearsing());
	}

	/// L'empreinte des pouvoirs ne doit pas bouger pour un simple
	/// réordonnancement : sinon le rodage repartirait sans raison.
	#[test]
	fn l_empreinte_des_pouvoirs_ignore_l_ordre() {
		use crate::config::{CommentConfig, PermanenceConfig};
		let un = PermanenceConfig {
			powers: vec!["b".into(), "a".into()],
			..Default::default()
		};
		let deux = PermanenceConfig {
			powers: vec!["a".into(), "b".into()],
			..Default::default()
		};
		assert_eq!(un.powers_print(), deux.powers_print());

		// Le pouvoir de commenter compte, et ses conditions avec lui : ouvrir
		// une porte de plus change ce qu'elle peut faire.
		let commente = PermanenceConfig {
			powers: vec!["a".into(), "b".into()],
			comment: CommentConfig {
				enabled: true,
				scopes: vec!["mine".into()],
				per_day: 1,
			},
			..Default::default()
		};
		assert_ne!(deux.powers_print(), commente.powers_print());

		let large = PermanenceConfig {
			comment: CommentConfig {
				scopes: vec!["mine".into(), "i_commented".into()],
				..commente.comment.clone()
			},
			..commente.clone()
		};
		assert_ne!(commente.powers_print(), large.powers_print());
	}

	/// Le coupe-circuit ne juge pas la gravité, seulement la répétition — et il
	/// se distingue de la suspension humaine, sinon on ne saurait pas qu'il
	/// s'est passé quelque chose.
	#[test]
	fn le_coupe_circuit_se_distingue_d_une_suspension() {
		use crate::config::PermanenceConfig;
		let allumee = PermanenceConfig {
			enabled: true,
			..Default::default()
		};
		let saute = State {
			tripped: "3 échecs d'affilée".into(),
			..Default::default()
		};
		assert_eq!(gate(&allumee, &saute, None), Some(Closed::Tripped));

		// Et il prime sur la suspension : la raison affichée doit être la
		// vraie, pas celle qu'on lit en premier.
		let les_deux = State {
			suspended: true,
			..saute
		};
		assert_eq!(gate(&allumee, &les_deux, None), Some(Closed::Tripped));
	}

	/* ── L'engagement ───────────────────────────────────────────────────── */

	fn engagement(id: &str, key: &str, stage: Stage) -> Engagement {
		Engagement {
			id: id.into(),
			rule: "ci".into(),
			key: key.into(),
			label: "#412 · Corrige l'éditeur".into(),
			trigger: "ci_red".into(),
			goal: String::new(),
			oracle: crate::config::OracleConfig {
				kind: "command".into(),
				key: "build".into(),
			},
			stage,
			verdict: Verdict::Pending,
			why: String::new(),
			steps: Vec::new(),
			produced: Vec::new(),
			mission: String::new(),
			rehearsal: false,
			started_at: now(),
			ended_at: 0,
			cost_usd: 0.0,
		}
	}

	/// Le garde-fou le plus fort : tant qu'un engagement tourne, aucun autre ne
	/// part — et la raison rendue doit être la bonne, pas « rien à signaler ».
	#[test]
	fn un_seul_engagement_a_la_fois() {
		use crate::config::PermanenceConfig;
		let config = PermanenceConfig {
			enabled: true,
			..Default::default()
		};
		let libre = State::default();
		assert!(cannot_open(&libre, &config, "k").is_none());

		let occupee = State {
			engagements: vec![engagement("e1", "autre", Stage::Running)],
			..Default::default()
		};
		let refus = cannot_open(&occupee, &config, "k").expect("refusé");
		assert!(refus.contains("already running"), "{refus}");

		// Un engagement terminé ne bloque plus la place.
		let finie = State {
			engagements: vec![engagement("e1", "autre", Stage::Done)],
			..Default::default()
		};
		assert!(cannot_open(&finie, &config, "k").is_none());
	}

	#[test]
	fn la_quarantaine_empeche_d_ouvrir() {
		use crate::config::PermanenceConfig;
		let config = PermanenceConfig {
			enabled: true,
			..Default::default()
		};
		let mut state = State::default();
		state.quarantine_for("k", 6, now());
		let refus = cannot_open(&state, &config, "k").expect("refusé");
		assert!(refus.contains("left alone"), "{refus}");
		assert!(cannot_open(&state, &config, "autre").is_none());
	}

	/// Le plafond du jour compte les répétitions : une répétition consomme un
	/// modèle, même si elle n'écrit rien.
	#[test]
	fn le_plafond_du_jour_compte_aussi_les_repetitions() {
		use crate::config::PermanenceConfig;
		let config = PermanenceConfig {
			enabled: true,
			daily_engagements: 2,
			..Default::default()
		};
		let mut state = State::default();
		for index in 0..2 {
			let mut done = engagement(&format!("e{index}"), &format!("k{index}"), Stage::Done);
			done.verdict = Verdict::Rehearsed;
			state.engagements.push(done);
		}
		let refus = cannot_open(&state, &config, "neuf").expect("refusé");
		assert!(refus.contains("daily cap"), "{refus}");
	}

	/// Fermer met l'objet en quarantaine, y compris après une répétition :
	/// sinon le même signal repartirait au tour suivant et on paierait dix fois
	/// pour lire dix fois la même chose.
	#[test]
	fn fermer_met_l_objet_en_quarantaine_meme_a_blanc() {
		let mut state = State {
			engagements: vec![engagement("e1", "k", Stage::Running)],
			rehearsal_left: 3,
			..Default::default()
		};
		state.holds.push(Hold {
			kind: "engagement".into(),
			id: "e1".into(),
			label: String::new(),
			since: 0,
		});

		close(&mut state, "e1", Verdict::Rehearsed, "répétition");
		assert!(state.quarantined("k", now()));
		assert!(state.holds.is_empty(), "ce qui est fini ne se tient plus");
		assert_eq!(state.rehearsal_left, 2, "la répétition se décompte");
		assert_eq!(state.engagements[0].stage, Stage::Done);
	}

	/// Le rodage ne se décompte que sur une répétition menée à son terme : un
	/// engagement coupé en plein vol n'a rien montré.
	#[test]
	fn un_engagement_interrompu_ne_consomme_pas_le_rodage() {
		let mut state = State {
			engagements: vec![engagement("e1", "k", Stage::Running)],
			rehearsal_left: 3,
			..Default::default()
		};
		close(&mut state, "e1", Verdict::Undecided, "l'agent n'a pas répondu");
		assert_eq!(state.rehearsal_left, 3);
	}

	/// Sans oracle, on ne rend jamais « atteint » : c'est la condition qui
	/// empêche un engagement de se déclarer réussi sur rien.
	#[tokio::test]
	async fn un_engagement_sans_oracle_reste_indecidable() {
		let (verdict, why) = ask_oracle(
			&crate::config::OracleConfig::default(),
			"github:acme/produit#412",
			&Config::default(),
		)
		.await;
		assert_eq!(verdict, Verdict::Undecided);
		assert!(why.contains("No oracle"), "{why}");
	}

	/// Un type d'oracle que le cockpit ne sait pas interroger est indécidable,
	/// pas satisfait. La différence est tout l'enjeu du quatrième verdict.
	#[tokio::test]
	async fn un_oracle_inconnu_ne_vaut_pas_une_reussite() {
		let (verdict, why) = ask_oracle(
			&crate::config::OracleConfig {
				kind: "divination".into(),
				key: "x".into(),
			},
			"k",
			&Config::default(),
		)
		.await;
		assert_eq!(verdict, Verdict::Undecided);
		assert!(why.contains("divination"), "{why}");
	}

	/// Une commande disparue de la configuration ne rend pas « manqué » : on ne
	/// sait pas si l'objectif est atteint, on sait qu'on n'a pas pu vérifier.
	#[tokio::test]
	async fn une_commande_absente_est_indecidable() {
		let (verdict, why) = ask_command("build", &Config::default()).await;
		assert_eq!(verdict, Verdict::Undecided);
		assert!(why.contains("no longer declared"), "{why}");
	}

	/// Vérifier ne doit rien changer : une commande marquée sensible ne peut
	/// pas servir de preuve. Le drapeau vient de l'équipe, il est gratuit à
	/// respecter.
	#[tokio::test]
	async fn une_commande_sensible_ne_sert_pas_de_preuve() {
		let config = Config {
			commands: vec![crate::config::CommandConfig {
				id: "deploy".into(),
				label: "Déployer".into(),
				base: "pnpm deploy".into(),
				danger: true,
				..Default::default()
			}],
			..Default::default()
		};
		let (verdict, why) = ask_command("deploy", &config).await;
		assert_eq!(verdict, Verdict::Undecided);
		assert!(why.contains("sensitive"), "{why}");
	}

	/// Un vrai regard, sur la vraie configuration du poste.
	///
	/// **Ignoré par défaut** : il interroge les forges, dépense des jetons et
	/// écrit l'état sur le disque. Ce n'est pas un test, c'est un banc d'essai —
	/// le seul moyen de voir la boucle tourner autrement qu'en aperçu.
	///
	/// ```sh
	/// cargo test --lib un_regard_reel -- --ignored --nocapture
	/// ```
	///
	/// Sans rodage actif dans la configuration, il refuse de partir : ce banc
	/// sert à regarder, pas à laisser un engagement agir sans surveillance.
	#[tokio::test]
	#[ignore]
	async fn un_regard_reel() {
		let config = Config::active();
		assert!(config.permanence.enabled, "la Permanence est éteinte : rien à observer");

		let before = state();
		assert!(
			before.rehearsing() || before.rehearsal_left > 0 || config.permanence.rehearsal() > 0,
			"ce banc ne se lance qu'en rodage"
		);

		println!("── avant ──");
		println!("  règles vivantes : {}", config.permanence.live_rules().len());
		println!("  rodage restant  : {}", before.rehearsal_left);
		println!("  curseur         : {} entrée(s)", before.cursor.len());

		let after = look(None, None).await.expect("le regard a échoué");

		println!("── après ──");
		match &after.last_look {
			Some(look) => {
				println!("  porte           : {:?}", look.closed);
				println!("  changements vus : {}", look.seen);
				println!("  deltas          : {}", look.fresh);
				for blind in &look.blind {
					println!("  source muette   : {blind}");
				}
			}
			None => println!("  aucun regard enregistré"),
		}
		println!("  signaux         : {}", after.signals.len());
		for signal in after.signals.iter().take(10) {
			println!(
				"    [{}] {} — {}",
				if signal.retained { "retenu" } else { "écarté" },
				signal.label,
				if signal.dropped.is_empty() {
					signal.rule.clone()
				} else {
					signal.dropped.clone()
				}
			);
		}
		println!("  engagements     : {}", after.engagements.len());
		for engagement in after.engagements.iter().take(5) {
			println!(
				"    {} · {} — {}",
				engagement.verdict.label(),
				engagement.goal,
				engagement.why
			);
			for step in &engagement.steps {
				println!("        {} → {}", step.what, step.result);
			}
		}
	}

	/* ── Les déclencheurs d'horloge ─────────────────────────────────────── */

	fn clock_rule(id: &str, trigger: &str, hours: u64) -> crate::config::PermanenceRule {
		crate::config::PermanenceRule {
			id: id.into(),
			label: format!("règle {id}"),
			enabled: true,
			trigger: trigger.into(),
			every_hours: hours,
			oracle: crate::config::OracleConfig {
				kind: "command".into(),
				key: "build".into(),
			},
			..Default::default()
		}
	}

	/// Une règle d'horloge part une fois, puis attend son délai. Sans ça, elle
	/// réveillerait la Permanence à chaque regard — toutes les deux minutes.
	#[test]
	fn une_regle_d_horloge_attend_son_delai() {
		use crate::config::PermanenceConfig;
		let config = PermanenceConfig {
			enabled: true,
			rules: vec![clock_rule("veille", "schedule", 24)],
			..Default::default()
		};

		let vierge = State::default();
		let premiers = clock_signals(&config, &vierge, &[]);
		assert_eq!(premiers.len(), 1, "jamais partie : elle part");
		assert_eq!(premiers[0].key, "schedule:veille");
		assert!(premiers[0].pending, "elle attend le tri");

		// Partie il y a une heure : elle se tait.
		let mut recente = State::default();
		recente
			.cursor
			.insert("schedule:veille".into(), (now() - 3600).to_string());
		assert!(clock_signals(&config, &recente, &[]).is_empty());

		// Partie il y a deux jours : elle repart.
		let mut vieille = State::default();
		vieille
			.cursor
			.insert("schedule:veille".into(), (now() - 48 * 3600).to_string());
		assert_eq!(clock_signals(&config, &vieille, &[]).len(), 1);
	}

	/// Deux règles d'horloge ne se mettent pas mutuellement en quarantaine :
	/// chacune a sa clé.
	#[test]
	fn deux_regles_d_horloge_ne_se_bloquent_pas() {
		use crate::config::PermanenceConfig;
		let config = PermanenceConfig {
			enabled: true,
			rules: vec![clock_rule("veille", "schedule", 24), clock_rule("deps", "schedule", 24)],
			..Default::default()
		};
		let signals = clock_signals(&config, &State::default(), &[]);
		assert_eq!(signals.len(), 2);
		let keys: Vec<&str> = signals.iter().map(|s| s.key.as_str()).collect();
		assert!(keys.contains(&"schedule:veille") && keys.contains(&"schedule:deps"));
	}

	/// Un brouillon n'attend personne : le signaler endormi serait signaler un
	/// choix délibéré.
	#[test]
	fn un_brouillon_n_est_jamais_endormi() {
		use crate::config::PermanenceConfig;
		let config = PermanenceConfig {
			enabled: true,
			rules: vec![clock_rule("dodo", "pr_stale", 72)],
			..Default::default()
		};
		let vieux = chrono::Utc::now() - chrono::Duration::days(10);

		let mut actif = change("k", "success", "");
		actif.updated_at = vieux.to_rfc3339();
		assert_eq!(clock_signals(&config, &State::default(), &[actif.clone()]).len(), 1);

		let mut brouillon = actif.clone();
		brouillon.draft = true;
		assert!(clock_signals(&config, &State::default(), &[brouillon]).is_empty());

		// Récent : rien non plus.
		let mut frais = actif;
		frais.updated_at = chrono::Utc::now().to_rfc3339();
		assert!(clock_signals(&config, &State::default(), &[frais]).is_empty());
	}

	/// Une règle éteinte, ou sans oracle, ne produit aucun signal d'horloge :
	/// `live_rules` est la seule porte d'entrée.
	#[test]
	fn une_regle_eteinte_ne_sonne_pas() {
		use crate::config::PermanenceConfig;
		let mut eteinte = clock_rule("veille", "schedule", 24);
		eteinte.enabled = false;
		let mut sans_oracle = clock_rule("autre", "schedule", 24);
		sans_oracle.oracle = crate::config::OracleConfig::default();

		let config = PermanenceConfig {
			enabled: true,
			rules: vec![eteinte, sans_oracle],
			..Default::default()
		};
		assert!(clock_signals(&config, &State::default(), &[]).is_empty());
	}

	/* ── Les gestes ─────────────────────────────────────────────────────── */

	/// La liste blanche est vérifiée dans le code, pas dans la consigne : un
	/// modèle à qui on a dit « tu n'as pas le droit » finira un jour par
	/// essayer quand même.
	#[tokio::test]
	async fn un_geste_hors_liste_blanche_est_refuse() {
		let config = Config::default();
		let act = Act {
			tool: "set_label".into(),
			value: "urgent".into(),
		};
		let refus = perform(
			&act,
			&engagement("e1", "github:acme/p#12", Stage::Running),
			&config,
			None,
		)
		.await
		.expect_err("refusé");
		assert!(refus.contains("allow list"), "{refus}");
	}

	/// Un geste inconnu est refusé plutôt qu'ignoré : le silence laisserait
	/// croire qu'il a été posé.
	#[tokio::test]
	async fn un_geste_inconnu_est_refuse_et_le_dit() {
		let config = Config {
			permanence: crate::config::PermanenceConfig {
				powers: vec!["deployer_en_prod".into()],
				..Default::default()
			},
			..Default::default()
		};
		let act = Act {
			tool: "deployer_en_prod".into(),
			value: String::new(),
		};
		let refus = perform(&act, &engagement("e1", "k", Stage::Running), &config, None)
			.await
			.expect_err("refusé");
		assert!(refus.contains("does not know how to perform"), "{refus}");
	}

	/// Cocher `run_command` dans la liste blanche n'efface pas le drapeau
	/// `danger` : une commande sensible ne se joue pas sans quelqu'un devant.
	#[tokio::test]
	async fn cocher_un_pouvoir_n_efface_pas_le_drapeau_sensible() {
		let config = Config {
			commands: vec![crate::config::CommandConfig {
				id: "deploy".into(),
				label: "Déployer".into(),
				base: "pnpm deploy".into(),
				danger: true,
				..Default::default()
			}],
			permanence: crate::config::PermanenceConfig {
				powers: vec!["run_command".into()],
				..Default::default()
			},
			..Default::default()
		};
		let act = Act {
			tool: "run_command".into(),
			value: "deploy".into(),
		};
		let refus = perform(&act, &engagement("e1", "k", Stage::Running), &config, None)
			.await
			.expect_err("refusé");
		assert!(refus.contains("sensitive"), "{refus}");
	}

	/// Le pouvoir de commenter ne s'active pas, il se borne : allumé sans
	/// condition cochée, il n'ouvre rien — par construction, pas par oubli.
	#[tokio::test]
	async fn commenter_sans_condition_ne_passe_pas() {
		let config = Config {
			permanence: crate::config::PermanenceConfig {
				comment: crate::config::CommentConfig {
					enabled: true,
					scopes: Vec::new(),
					per_day: 0,
				},
				..Default::default()
			},
			..Default::default()
		};
		let refus = may_comment(&config, 412).await.expect_err("refusé");
		assert!(refus.contains("by design"), "{refus}");

		// Éteint, c'est refusé aussi, mais pour une autre raison — et les deux
		// se corrigent à des endroits différents.
		let eteint = Config::default();
		let refus = may_comment(&eteint, 412).await.expect_err("refusé");
		assert!(refus.contains("not enabled"), "{refus}");
	}

	/// Une PR nommément autorisée passe. C'est la trace du « oui, ici ».
	#[tokio::test]
	async fn une_pr_autorisee_nommement_passe() {
		let config = Config {
			permanence: crate::config::PermanenceConfig {
				comment: crate::config::CommentConfig {
					enabled: true,
					scopes: vec!["i_allowed".into()],
					per_day: 0,
				},
				allowed_prs: vec![412],
				..Default::default()
			},
			..Default::default()
		};
		assert!(may_comment(&config, 412).await.is_ok());
		let refus = may_comment(&config, 999).await.expect_err("refusé");
		assert!(refus.contains("#999"), "{refus}");
	}

	/// L'indécidable compte comme un échec pour le coupe-circuit : trois
	/// oracles muets d'affilée veulent dire que quelque chose est cassé, pas
	/// que tout va bien.
	#[test]
	fn un_oracle_muet_compte_comme_un_echec() {
		assert!(Verdict::Missed.failed());
		assert!(Verdict::Undecided.failed());
		assert!(!Verdict::Reached.failed());
		assert!(!Verdict::OffTopic.failed(), "hors sujet n'est pas un échec");
		assert!(!Verdict::Rehearsed.failed());
	}

	/// La consigne dit ce qu'elle ne fera jamais, et la liste vient de `NEVER`
	/// plutôt que d'être réécrite : deux endroits finiraient par diverger.
	#[test]
	fn la_consigne_d_engagement_recopie_les_interdits() {
		use crate::config::{PermanenceConfig, PermanenceRule};
		let regle = PermanenceRule {
			id: "ci".into(),
			label: "CI rouge".into(),
			reaction: "répare".into(),
			..Default::default()
		};
		let prompt = engagement_prompt(
			&engagement("e1", "k", Stage::Planning),
			&regle,
			&PermanenceConfig::default(),
			"",
		);
		for never in crate::config::NEVER {
			assert!(prompt.contains(never), "« {never} » doit être dit");
		}
		assert!(prompt.contains("You do nothing right away"), "le plan précède l'action");
		// Liste blanche vide : on le dit, plutôt que de laisser l'agent
		// supposer qu'il peut tout.
		assert!(prompt.contains("Nothing is checked"));
	}

	/// L'arrêt d'urgence ne vaut que ce que vaut la liste de ce qu'elle tient :
	/// un agent lancé sans y être inscrit survivrait au bouton.
	#[test]
	fn ce_qu_elle_tient_se_note_sans_doublon() {
		let mut state = State::default();
		state.holds.push(Hold {
			kind: "agent".into(),
			id: "s1".into(),
			label: "répare #412".into(),
			since: 0,
		});
		// Réinscrire le même identifiant remplace au lieu d'empiler : sinon on
		// tenterait de couper deux fois la même chose, et le compte rendu
		// mentirait sur ce qui tournait.
		state.holds.retain(|entry| entry.id != "s1");
		state.holds.push(Hold {
			kind: "agent".into(),
			id: "s1".into(),
			label: "répare #412 (reprise)".into(),
			since: 10,
		});
		assert_eq!(state.holds.len(), 1);
		assert_eq!(state.holds[0].label, "répare #412 (reprise)");

		state.holds.retain(|entry| entry.id != "s1");
		assert!(state.holds.is_empty(), "ce qui se termine se retire");
	}

	/// Un arrêt d'urgence pose le coupe-circuit, pas une suspension : on veut
	/// regarder avant que ça reparte, et le réarmement se demande.
	#[test]
	fn un_arret_d_urgence_ferme_la_porte_pour_de_bon() {
		use crate::config::PermanenceConfig;
		let allumee = PermanenceConfig {
			enabled: true,
			..Default::default()
		};
		let apres = State {
			tripped: "Arrêt demandé.".into(),
			..Default::default()
		};
		assert_eq!(gate(&allumee, &apres, None), Some(Closed::Tripped));

		// Et il ne se lève pas tout seul : seul `rearm` vide ce champ.
		let repris = State {
			tripped: String::new(),
			..apres
		};
		assert_eq!(gate(&allumee, &repris, None), None);
	}

	/// Chaque porte a sa phrase : « elle ne fait rien » est une réponse
	/// inutilisable, là où une raison se corrige en dix secondes.
	#[test]
	fn chaque_fermeture_a_sa_raison() {
		for closed in [
			Closed::Disabled,
			Closed::Suspended,
			Closed::OffHours,
			Closed::Capped,
			Closed::Quota,
			Closed::Tripped,
		] {
			assert!(!closed.reason().is_empty());
		}
	}
}
