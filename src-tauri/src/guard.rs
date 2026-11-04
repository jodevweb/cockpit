//! Les gestes git qu'un exécutant de mission ne fait pas, même sans filet.
//!
//! Un exécutant travaille en `bypassPermissions` : il ne demande rien, et le
//! pont d'autorisation ne juge que les écritures de fichiers qu'il sait lire
//! (`Write`, `Edit`). Son outil `Bash` passe donc sans examen — y compris les
//! quelques commandes qui défont ce que la mission construit :
//!
//! - **réécrire l'histoire d'une branche distante** (`git push --force`,
//!   `+refspec`, `--delete`) : ce qui est poussé est ce que d'autres lisent ;
//! - **pousser sur une branche protégée** — la branche d'intégration de la
//!   mission, sa base, les `workflow.base_branches` du projet : c'est
//!   l'intégration qui fusionne, jamais l'exécutant ;
//! - **se créer une branche** (`checkout -b`, `switch -c`, `branch <nom>`,
//!   `worktree add -b`) : le travail part alors là où l'intégration ne va pas
//!   le chercher. Le cockpit le rattrapait après coup (`Task::actual_branch`) ;
//!   ici, il ne se produit plus.
//!
//! Le garde-fou est un hook `PreToolUse` du CLI, passé par `--settings`.
//! Vérifié sur Claude Code 2.1.318 : le hook est appelé en
//! `bypassPermissions` comme ailleurs, son refus empêche la commande et
//! revient à l'agent avec sa raison, et `--settings` **s'ajoute** aux hooks
//! que le dépôt déclare dans `.claude/settings.json` au lieu de les remplacer.
//!
//! Ce qu'il ne fait pas, exprès : deviner ce qu'une ligne de commande écrit
//! sur le disque. Il ne reconnaît que des commandes git dont la forme se lit
//! sans ambiguïté, et laisse passer tout le reste.

use std::path::PathBuf;

use crate::config::config_dir;

/// Le hook. Lit l'appel d'outil sur son entrée, rend un refus ou rien.
pub(crate) const GUARD: &str = r#"#!/usr/bin/env node
// Garde-fou git des exécutants de mission — écrit par le cockpit (guard.rs).
const PROTECTED = (process.env.COCKPIT_PROTECTED_BRANCHES ?? "")
  .split("\n").map((b) => b.trim()).filter(Boolean);

/** Les mots d'une commande, guillemets simples et doubles compris. */
function words(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Les commandes d'une ligne : `a && b`, `a; b`, `a | b`, une par ligne. */
function segments(command) {
  return String(command ?? "").split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

const short = (word, letter) => /^-[A-Za-z]+$/.test(word) && word.includes(letter);
const branchName = (ref) => ref.replace(/^\+/, "").replace(/^refs\/heads\//, "");

/** La raison du refus, ou `null` quand la commande passe. */
function judge(command) {
  for (const segment of segments(command)) {
    let w = words(segment);
    // `env X=1 git …`, `X=1 git …`, `sudo git …` : on va jusqu'au git.
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || w[0] === "env" || w[0] === "command")) w = w.slice(1);
    if (!w.length || !/(^|[\/\\])git(\.exe)?$/.test(w[0])) continue;
    let i = 1;
    while (i < w.length && w[i].startsWith("-")) {
      i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
    }
    const sub = w[i];
    const rest = w.slice(i + 1);
    const flags = rest.filter((a) => a.startsWith("-"));
    const positional = rest.filter((a) => !a.startsWith("-"));

    if (sub === "push") {
      if (flags.some((f) => f === "--force" || f.startsWith("--force-with-lease") || f === "--force-if-includes" || short(f, "f"))
        || positional.slice(1).some((ref) => ref.startsWith("+"))) {
        return "Force-pushing is not allowed for a mission worker: it rewrites a history others read. Push normally, or report the problem.";
      }
      if (flags.some((f) => f === "--delete" || f === "--mirror" || f === "--prune" || short(f, "d"))
        || positional.slice(1).some((ref) => ref.startsWith(":"))) {
        return "Deleting or mirroring remote branches is not allowed for a mission worker.";
      }
      for (const ref of positional.slice(1)) {
        const target = branchName(ref.includes(":") ? ref.split(":").pop() : ref);
        if (PROTECTED.includes(target)) {
          return `Pushing to \`${target}\` is not allowed for a mission worker: the integration merges your branch, you never push to it. Commit on your own branch.`;
        }
      }
    }

    const creates =
      (sub === "checkout" && flags.some((f) => f === "-b" || f === "-B" || f === "--orphan"))
      || (sub === "switch" && flags.some((f) => ["-c", "-C", "--create", "--force-create", "--orphan"].includes(f)))
      || (sub === "worktree" && rest[0] === "add" && flags.some((f) => f === "-b" || f === "-B"))
      || (sub === "branch" && positional.length > 0
        && !flags.some((f) => ["--list", "-l", "-a", "--all", "-r", "--remotes", "--contains", "--no-contains",
          "--merged", "--no-merged", "--points-at", "--show-current", "-v", "-vv", "--verbose", "--format"].some((r) => f === r || f.startsWith(`${r}=`))));
    if (creates) {
      return "Creating, renaming or deleting branches is not allowed for a mission worker: your work must stay on the branch the cockpit gave you, where the integration looks for it. Commit there.";
    }
  }
  return null;
}

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { process.exit(0); }
  if (input.tool_name !== "Bash") process.exit(0);
  const reason = judge(input.tool_input?.command);
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }));
  }
  process.exit(0);
});
"#;

fn guard_path() -> PathBuf {
	config_dir().join("mission-guard.mjs")
}

/// Écrit le hook et ses réglages, puis rend le fichier à passer par
/// `--settings`. `None` sans Node — l'exécutant part alors sans ce garde-fou,
/// comme il partait avant lui.
///
/// `sandboxed` : mêmes règles que `permissions::bridge_arguments` — dans un
/// conteneur, le `node` de l'image et les chemins sous leur forme conteneur.
pub fn settings_argument(sandboxed: bool) -> Option<String> {
	let node = if sandboxed {
		"node".to_string()
	} else {
		crate::agent::node_binary()?
	};
	std::fs::create_dir_all(config_dir()).ok()?;
	std::fs::write(guard_path(), GUARD).ok()?;

	let seen = |path: &std::path::Path| {
		let path = path.to_string_lossy().to_string();
		if sandboxed { crate::sandbox::container_path(&path) } else { path }
	};
	let quote = |text: &str| format!("\"{}\"", text.replace('"', "\\\""));
	let settings = serde_json::json!({
		"hooks": {
			"PreToolUse": [{
				"matcher": "Bash",
				"hooks": [{
					"type": "command",
					"command": format!("{} {}", quote(&node), quote(&seen(&guard_path()))),
				}],
			}],
		},
	});
	let path = config_dir().join("mission-guard.json");
	std::fs::write(&path, serde_json::to_string_pretty(&settings).ok()?).ok()?;
	Some(seen(&path))
}

/// Les branches qu'un exécutant de cette mission ne pousse jamais.
pub fn protected_branches(mission_id: &str) -> Vec<String> {
	let Ok(mission) = crate::mission::get(mission_id) else {
		return Vec::new();
	};
	let mut branches: Vec<String> = crate::config::Config::for_repo(&mission.cwd).workflow.base_branches;
	branches.push(mission.branch.clone());
	branches.push(mission.base.clone());
	let mut seen = Vec::new();
	for branch in branches {
		let branch = branch.trim().to_string();
		if !branch.is_empty() && !seen.contains(&branch) {
			seen.push(branch);
		}
	}
	seen
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;
	use std::process::{Command, Stdio};

	/// Joue le vrai script, tel que le CLI le lancera : c'est lui qui juge, pas
	/// une copie de sa logique en Rust.
	fn juge(command: &str) -> Option<String> {
		let node = which_node()?;
		// Un fichier par appel : les tests tournent en parallèle.
		static SUITE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
		let rang = SUITE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
		let dir = std::env::temp_dir().join(format!("cockpit-guard-{}-{rang}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let script = dir.join("guard.mjs");
		std::fs::write(&script, GUARD).unwrap();
		let mut child = Command::new(node)
			.arg(&script)
			.env("COCKPIT_PROTECTED_BRANCHES", "main\ndev\nfeat/mission-42")
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.spawn()
			.unwrap();
		let input = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": command } });
		child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
		let output = child.wait_with_output().unwrap();
		assert!(output.status.success());
		let text = String::from_utf8_lossy(&output.stdout).to_string();
		if text.trim().is_empty() {
			return Some(String::new());
		}
		let value: serde_json::Value = serde_json::from_str(&text).unwrap();
		assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "deny");
		Some(value["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap().to_string())
	}

	fn which_node() -> Option<String> {
		let probe = Command::new("node").arg("--version").output().ok()?;
		probe.status.success().then(|| "node".to_string())
	}

	/// `None` : Node absent, le test ne peut rien dire. Sinon vrai si refusé.
	fn refuse(command: &str) -> Option<bool> {
		juge(command).map(|reason| !reason.is_empty())
	}

	macro_rules! sans_node_on_passe {
		($e:expr) => {
			match $e {
				Some(value) => value,
				None => {
					eprintln!("node introuvable : test du garde-fou sauté");
					return;
				}
			}
		};
	}

	#[test]
	fn le_travail_ordinaire_passe() {
		for command in [
			"git status",
			"git add -A && git commit -m 'feat: x'",
			"git push",
			"git push origin feat/mission-42-back",
			"git push -u origin HEAD",
			"git checkout -- src/main.rs",
			"git checkout src/main.rs",
			"git switch -",
			"git branch",
			"git branch --show-current",
			"git branch -a --contains abc123",
			"git log --oneline main..HEAD",
			"pnpm test",
			"echo 'git push --force'",
		] {
			assert!(!sans_node_on_passe!(refuse(command)), "refusé à tort : {command}");
		}
	}

	#[test]
	fn reecrire_l_histoire_distante_est_refuse() {
		for command in [
			"git push --force",
			"git push -f origin x",
			"git push -uf origin x",
			"git push --force-with-lease",
			"git push --force-with-lease=x:abc origin x",
			"git push origin +x",
			"git push --delete origin x",
			"git push origin :x",
			"git add . && git commit -m x && git push --force",
			"GIT_TRACE=1 git push --force",
			"git -C ../autre push -f",
		] {
			assert!(sans_node_on_passe!(refuse(command)), "laissé passer : {command}");
		}
	}

	#[test]
	fn les_branches_protegees_ne_se_poussent_pas() {
		for command in [
			"git push origin main",
			"git push origin HEAD:dev",
			"git push origin feat/mission-42",
			"git push origin refs/heads/main",
		] {
			assert!(sans_node_on_passe!(refuse(command)), "laissé passer : {command}");
		}
	}

	#[test]
	fn on_ne_se_cree_pas_de_branche() {
		for command in [
			"git checkout -b fix/autre",
			"git checkout -B fix/autre",
			"git switch -c fix/autre",
			"git switch --create fix/autre",
			"git branch fix/autre",
			"git branch -m nouveau-nom",
			"git branch -D feat/mission-42-back",
			"git worktree add -b x ../x",
		] {
			assert!(sans_node_on_passe!(refuse(command)), "laissé passer : {command}");
		}
	}

	#[test]
	fn un_autre_outil_ne_regarde_pas_le_garde_fou() {
		// Le hook n'est branché que sur Bash ; s'il était appelé pour autre
		// chose, il ne doit rien refuser.
		let Some(node) = which_node() else { return };
		let dir = std::env::temp_dir().join(format!("cockpit-guard-autre-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let script = dir.join("guard.mjs");
		std::fs::write(&script, GUARD).unwrap();
		let mut child = Command::new(node)
			.arg(&script)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.spawn()
			.unwrap();
		let input = serde_json::json!({ "tool_name": "Write", "tool_input": { "command": "git push --force" } });
		child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
		let output = child.wait_with_output().unwrap();
		assert!(String::from_utf8_lossy(&output.stdout).trim().is_empty());
	}
}
