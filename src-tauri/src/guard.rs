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
//! La ligne est lue comme un shell la lirait, guillemets compris : un message
//! de commit qui contient « ; git push -f » reste un message. Ce qui enveloppe
//! une commande sans en changer le sens est retiré avant de la juger —
//! `bash -c`, `sh -lc`, `eval`, `xargs`, `env`, `sudo`, `time`, `nohup`, `(…)`,
//! `$(…)`, `{ …; }`, `then`, `do` — et les options longues abrégées que git
//! accepte (`--forc`, `--dele`) valent les entières.
//!
//! Ce qu'il ne fait pas, exprès : deviner ce qu'une ligne de commande écrit
//! sur le disque. Il ne reconnaît que des commandes git dont la forme se lit
//! sans ambiguïté, et laisse passer tout le reste. Il reste donc des chemins
//! qu'il ne voit pas — un alias déjà défini dans le `.gitconfig` du poste, un
//! script qui pousse à la place de l'agent — : c'est un garde-fou contre le
//! geste de routine, pas une enceinte. L'enceinte, c'est le conteneur.

use std::path::PathBuf;

use crate::config::config_dir;

/// Le hook. Lit l'appel d'outil sur son entrée, rend un refus ou rien.
pub(crate) const GUARD: &str = r#"#!/usr/bin/env node
// Garde-fou git des exécutants de mission — écrit par le cockpit (guard.rs).
const PROTECTED = (process.env.COCKPIT_PROTECTED_BRANCHES ?? "")
  .split("\n").map((b) => b.trim()).filter(Boolean);

/**
 * Les commandes d'une ligne de shell, chacune en mots.
 *
 * Les séparateurs (`;`, `&&`, `||`, `|`, `&`, retour à la ligne) ne comptent
 * qu'hors des guillemets : un message de commit qui contient « ; git push -f »
 * reste un message, pas une seconde commande.
 */
function commands(line) {
  const out = [];
  let current = [];
  let word = "";
  let inWord = false;
  let quote = null;
  const s = String(line ?? "");
  const endWord = () => {
    if (inWord) current.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (current.length) out.push(current);
    current = [];
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) word += s[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\" && i + 1 < s.length) { word += s[++i]; inWord = true; continue; }
    // Les parenthèses ouvrent ou ferment une sous-commande : `(git push -f)`,
    // `$(git push -f)` se jugent comme la commande qu'elles contiennent.
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endCommand();
      // `&&`, `||` : un seul séparateur.
      if ((c === "&" || c === "|") && s[i + 1] === c) i += 1;
      continue;
    }
    if (c === " " || c === "\t") { endWord(); continue; }
    word += c;
    inWord = true;
  }
  endCommand();
  return out;
}

/** Les mots qui précèdent la vraie commande sans en changer le sens. */
const PREFIXES = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "time", "nohup", "exec", "command", "builtin", "nice", "stdbuf"]);
const SHELLS = /(^|[\/\\])(ba|z|da|k)?sh(\.exe)?$/;
const GIT = /(^|[\/\\])git(\.exe)?$/;

/** Retire ce qui enveloppe la commande : préfixes, affectations, `env`, `sudo`, `xargs`. */
function unwrap(w) {
  let words = w.map((word, index) => (index === 0 ? word.replace(/^[({]+/, "") : word)).filter((word, index) => index > 0 || word !== "");
  for (let guard = 0; guard < 20 && words.length; guard += 1) {
    const first = words[0];
    if (first === "" || first === "(" || first === "{" || PREFIXES.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      words = words.slice(1);
      if (words.length) words[0] = words[0].replace(/^[({]+/, "");
      continue;
    }
    if (first === "env" || first === "sudo" || first === "xargs" || first === "doas") {
      // Leurs options, et la valeur de celles qui en prennent une.
      let i = 1;
      const withValue = { env: ["-u", "--unset", "-C", "--chdir", "-S"], sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"], xargs: ["-n", "-L", "-P", "-I", "-d", "-E", "-s", "-a"], doas: ["-u", "-C"] }[first];
      while (i < words.length && (words[i].startsWith("-") || (first === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])))) {
        i += withValue.includes(words[i]) ? 2 : 1;
      }
      words = words.slice(i);
      continue;
    }
    break;
  }
  return words;
}

const short = (word, letter) => /^-[A-Za-z]+$/.test(word) && word.includes(letter);
/** Une option longue, ou une abréviation qu'en accepte git (`--forc`, `--dele`). */
const long = (word, option, min) => {
  const base = word.split("=")[0];
  return base.length >= min && base.startsWith("--") && option.startsWith(base);
};
const branchName = (ref) => ref.replace(/^\+/, "").replace(/^refs\/heads\//, "");

/** La raison du refus pour une commande en mots, ou `null`. */
function judgeWords(raw, protectedBranches, depth) {
  const w = unwrap(raw);
  if (!w.length) return null;
  // `bash -c "…"`, `sh -lc '…'` : le texte est une ligne de commande de plus.
  if (SHELLS.test(w[0])) {
    const flag = w.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    if (flag > 0 && w[flag + 1] !== undefined) return judge(w[flag + 1], protectedBranches, depth + 1);
    return null;
  }
  if (w[0] === "eval") return judge(w.slice(1).join(" "), protectedBranches, depth + 1);
  if (!GIT.test(w[0])) return null;

  let i = 1;
  const twoTokens = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];
  while (i < w.length && w[i].startsWith("-")) {
    // `-c alias.p="push -f"` : un alias posé pour la durée de la commande.
    if (w[i] === "-c" && /^alias\./.test(w[i + 1] ?? "")) {
      return "Defining git aliases is not allowed for a mission worker.";
    }
    i += twoTokens.includes(w[i]) ? 2 : 1;
  }
  const sub = w[i];
  const rest = w.slice(i + 1);
  const flags = rest.filter((a) => a.startsWith("-"));

  if (sub === "config" && rest.some((a) => /^alias\./.test(a))) {
    return "Defining git aliases is not allowed for a mission worker.";
  }

  if (sub === "push") {
    // Les options qui prennent une valeur en deux mots : la valeur n'est ni
    // le dépôt distant ni une branche.
    const valued = ["-o", "--push-option", "--repo", "--receive-pack", "--exec"];
    const positional = [];
    for (let k = 0; k < rest.length; k += 1) {
      if (valued.includes(rest[k])) { k += 1; continue; }
      if (!rest[k].startsWith("-")) positional.push(rest[k]);
    }
    const refs = positional.slice(1);
    if (flags.some((f) => short(f, "f") || long(f, "--force", 4) || long(f, "--force-with-lease", 4) || long(f, "--force-if-includes", 4))
      || refs.some((ref) => ref.startsWith("+"))) {
      return "Force-pushing is not allowed for a mission worker: it rewrites a history others read. Push normally, or report the problem.";
    }
    if (flags.some((f) => short(f, "d") || long(f, "--delete", 4) || long(f, "--mirror", 4) || long(f, "--prune", 5) || long(f, "--all", 5))
      || refs.some((ref) => ref.startsWith(":"))) {
      return "Deleting, mirroring or pushing every branch is not allowed for a mission worker.";
    }
    for (const ref of refs) {
      const target = branchName(ref.includes(":") ? ref.split(":").pop() : ref);
      if (protectedBranches.includes(target)) {
        return `Pushing to \`${target}\` is not allowed for a mission worker: the integration merges your branch, you never push to it. Commit on your own branch.`;
      }
    }
  }

  const listing = ["--list", "-l", "-a", "--all", "-r", "--remotes", "--contains", "--no-contains", "--merged",
    "--no-merged", "--points-at", "--show-current", "--format", "-u", "--set-upstream-to", "--unset-upstream"];
  const positional = rest.filter((a) => !a.startsWith("-"));
  const creates =
    (sub === "checkout" && flags.some((f) => ["-b", "-B", "--orphan", "-t"].includes(f) || long(f, "--track", 4) || long(f, "--orphan", 4)))
    || (sub === "switch" && flags.some((f) => ["-c", "-C", "-t"].includes(f) || long(f, "--create", 4) || long(f, "--force-create", 4) || long(f, "--orphan", 4) || long(f, "--track", 4)))
    // Un worktree de plus : une branche de plus, et un dossier hors du sien.
    || (sub === "worktree" && rest[0] === "add")
    || (sub === "update-ref" && rest.some((a) => a.startsWith("refs/heads/")))
    || (sub === "branch" && positional.length > 0
      && !flags.some((f) => listing.some((r) => f === r || f.startsWith(`${r}=`))));
  if (creates) {
    return "Creating, renaming or deleting branches is not allowed for a mission worker: your work must stay on the branch the cockpit gave you, where the integration looks for it. Commit there.";
  }
  return null;
}

/** La raison du refus, ou `null` quand la ligne de commande passe. */
function judge(line, protectedBranches, depth = 0) {
  // Une imbrication sans fin (`bash -c "bash -c …"`) ne mérite pas d'être lue
  // jusqu'au bout : au-delà, on refuse.
  if (depth > 4) return "This command nests too many shells to be checked.";
  for (const words of commands(line)) {
    const reason = judgeWords(words, protectedBranches, depth);
    if (reason) return reason;
  }
  return null;
}


let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { return; }
  if (input.tool_name !== "Bash") return;
  const reason = judge(input.tool_input?.command, PROTECTED);
  if (reason) {
    // Pas de `process.exit` juste derrière : la sortie partirait peut-être
    // sans le refus, et le CLI lirait un accord.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }));
  }
  process.exitCode = 0;
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
	// Écrit à côté puis renommé : plusieurs exécutants partent souvent ensemble,
	// et un hook qui lirait un script à moitié écrit laisserait tout passer.
	write_atomic(&guard_path(), GUARD).ok()?;

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
	write_atomic(&path, &serde_json::to_string_pretty(&settings).ok()?).ok()?;
	Some(seen(&path))
}

/// Écrit un fichier sans qu'on puisse jamais le lire à moitié : une copie
/// propre à ce processus, puis un renommage, qui remplace d'un coup.
fn write_atomic(path: &std::path::Path, content: &str) -> std::io::Result<()> {
	static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
	let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
	let temp = path.with_extension(format!("tmp-{}-{n}", std::process::id()));
	std::fs::write(&temp, content)?;
	match std::fs::rename(&temp, path) {
		Ok(()) => Ok(()),
		Err(error) => {
			let _ = std::fs::remove_file(&temp);
			// Sous Windows, un hook qui lit le fichier à cet instant empêche de le
			// remplacer. S'il porte déjà ce contenu, il n'y a rien à faire.
			if std::fs::read_to_string(path).map(|present| present == content).unwrap_or(false) {
				Ok(())
			} else {
				Err(error)
			}
		}
	}
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
			// Un séparateur entre guillemets n'ouvre pas de seconde commande.
			"git commit -m \"fix: x; git push --force is now blocked\"",
			"echo \"a | git push -f\"",
			"git branch -u origin/x",
			"git push -o ci.skip origin feat/mission-42-back",
			"git push --follow-tags",
			"bash -c 'pnpm test'",
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
			"git --git-dir .git push -f",
			"git push --forc",
			"git push --dele origin x",
			"git push --all origin",
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
			"git worktree add ../x",
			"git checkout --track origin/x",
			"git switch --track origin/x",
			"git update-ref refs/heads/x HEAD",
			"git branch -v nom",
		] {
			assert!(sans_node_on_passe!(refuse(command)), "laissé passer : {command}");
		}
	}

	/// Ce qu'un agent écrirait pour passer à côté sans le vouloir — ou en le
	/// voulant : une enveloppe de shell autour de la même commande.
	#[test]
	fn les_enveloppes_ne_cachent_pas_la_commande() {
		for command in [
			"bash -c \"git push --force\"",
			"sh -lc 'git checkout -b x'",
			"(git push -f)",
			"{ git push -f; }",
			"if true; then git push -f; fi",
			"time git push -f",
			"nohup git push -f",
			"sudo -u bob git push -f",
			"env -i git push -f",
			"sleep 1 & git push -f",
			"eval \"git push -f\"",
			"xargs -n 1 git push -f",
			"echo $(git push -f)",
			"git config alias.p \"push -f\"",
			"git -c alias.p=\"push -f\" p",
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
