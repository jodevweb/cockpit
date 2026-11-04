#!/usr/bin/env node
// Le contrat du cockpit avec le CLI Claude Code : les options qu'il passe et
// les valeurs qu'il leur donne existent-elles encore dans la version publiée ?
//
//   node scripts/cli-contract.mjs
//
// Le cockpit pilote `claude` par sa ligne de commande (voir `agent.rs`) : une
// option renommée ou retirée ne se voit qu'au lancement d'un agent, chez
// quelqu'un, par un CLI qui refuse de démarrer. Ce script lit `claude --help`
// et `claude auth --help` — sans connexion, sans appel au modèle, sans rien
// dépenser — et échoue dès qu'un élément manque. La CI le joue chaque nuit
// contre la dernière version publiée (`.github/workflows/contrat-cli.yml`).
//
// Ce qu'il ne vérifie pas : le comportement (le flux stream-json, les hooks,
// le pont d'autorisation). Cela demande un compte connecté ; voir les sondes
// de `src-tauri/examples/`.

import { execFileSync } from "node:child_process";

/** Ce que le cockpit envoie, et où. Requis : sans lui, un agent ne part pas. */
const REQUIRED = [
	["--print", "agent.rs : tours ponctuels (`-p`)"],
	["--output-format", "agent.rs : sortie stream-json / json"],
	["--input-format", "agent.rs : conversation stream-json"],
	["stream-json", "agent.rs : valeur de --input-format / --output-format"],
	["--verbose", "agent.rs : stream-json l'exige en sortie"],
	["--model", "agent.rs : modèle du rôle"],
	["--permission-mode", "agent.rs : mode de l'agent"],
	["bypassPermissions", "config.rs : mode des exécutants"],
	["acceptEdits", "agent.rs : mode par défaut"],
	["--permission-prompt-tool", "permissions.rs : le pont d'autorisation"],
	["--mcp-config", "mcp.rs, permissions.rs, orchestrator.rs, review.rs, browser.rs"],
	["--strict-mcp-config", "agent.rs : tours sans outils"],
	["--settings", "guard.rs : garde-fou git des exécutants"],
	["--resume", "agent.rs : reprise d'une conversation"],
	["--append-system-prompt", "agent.rs : consignes ajoutées"],
	["--allowedTools", "review.rs : outils de lecture de la revue"],
	["--disallowedTools", "review.rs, agent.rs : outils retirés"],
	["--tools", "agent.rs : tours sans outils"],
	["--disable-slash-commands", "agent.rs : tours sans commandes"],
	["--no-session-persistence", "agent.rs : tours qui ne laissent pas de session"],
];

/** Ce que le cockpit sait détecter et contourner : son absence se dit, sans échouer. */
const OPTIONAL = [["--forward-subagent-text", "agent.rs : sondé au démarrage, repli sans"]];

function run(args) {
	try {
		return execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		// `--help` sort parfois en code non nul : sa sortie compte quand même.
		return `${error.stdout ?? ""}${error.stderr ?? ""}`;
	}
}

const version = run(["--version"]).trim();
if (!version) {
	console.error("échec : `claude` est introuvable sur ce poste.");
	process.exit(1);
}
const help = run(["--help"]);
const auth = run(["auth", "--help"]);
console.log(`Claude Code ${version}\n`);

let missing = 0;
for (const [needle, where] of REQUIRED) {
	const ok = help.includes(needle);
	if (!ok) missing += 1;
	console.log(`${ok ? "ok      " : "MANQUANT"} ${needle.padEnd(26)} ${where}`);
}
for (const [needle, where] of OPTIONAL) {
	console.log(`${help.includes(needle) ? "ok      " : "absent  "} ${needle.padEnd(26)} ${where}`);
}
// `claude auth status` : ce que les comptes et la liste « prêt à démarrer »
// demandent au CLI (accounts.rs).
const status = /\bstatus\b/.test(auth);
if (!status) missing += 1;
console.log(`${status ? "ok      " : "MANQUANT"} ${"auth status".padEnd(26)} accounts.rs : qui est connecté`);

if (missing > 0) {
	console.error(`\n${missing} élément(s) du contrat absent(s) de Claude Code ${version}.`);
	process.exit(1);
}
console.log("\nContrat tenu.");
