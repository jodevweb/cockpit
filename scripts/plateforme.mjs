#!/usr/bin/env node
//
// Lance la variante d'un script qui convient au système : `scripts/<nom>.ps1`
// sous Windows quand elle existe, `scripts/<nom>.linux.sh` sous Linux quand
// elle existe, `scripts/<nom>.sh` sinon.
//
//   node scripts/plateforme.mjs install-app [arguments…]
//
// C'est ce qui permet à `pnpm install:app` ou `pnpm setup:mobile` d'avoir le
// même nom partout. Sous Windows, un script `.sh` est joué par le bash de Git
// for Windows — jamais par le `bash.exe` de System32, qui ouvrirait WSL.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [nom, ...args] = process.argv.slice(2);
if (!nom) {
	console.error("Usage : node scripts/plateforme.mjs <script> [arguments…]");
	process.exit(1);
}

const dossier = dirname(fileURLToPath(import.meta.url));
const ps1 = join(dossier, `${nom}.ps1`);
// Sous Linux, une variante `<nom>.linux.sh` passe avant le `.sh` commun, qui
// suppose souvent macOS (`/Applications`, `codesign`).
const linux = join(dossier, `${nom}.linux.sh`);
const sh = process.platform === "linux" && existsSync(linux) ? linux : join(dossier, `${nom}.sh`);

function bashDeGit() {
	if (process.env.COCKPIT_BASH && existsSync(process.env.COCKPIT_BASH)) return process.env.COCKPIT_BASH;
	const candidats = [];
	try {
		// …\Git\cmd\git.exe → …\Git\bin\bash.exe
		for (const ligne of execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/)) {
			if (ligne.trim()) candidats.push(join(dirname(dirname(ligne.trim())), "bin", "bash.exe"));
		}
	} catch {
		// Git absent du PATH : on essaie les emplacements ordinaires.
	}
	for (const base of [process.env.ProgramFiles, process.env.ProgramW6432, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
		if (base) candidats.push(join(base, "Git", "bin", "bash.exe"));
	}
	return candidats.find((chemin) => existsSync(chemin));
}

let commande;
let arguments_;
if (process.platform === "win32" && existsSync(ps1)) {
	commande = "powershell.exe";
	arguments_ = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args];
} else if (existsSync(sh)) {
	if (process.platform === "win32") {
		commande = bashDeGit();
		if (!commande) {
			console.error("✗ Git Bash introuvable : installe Git for Windows (https://git-scm.com/download/win).");
			process.exit(1);
		}
	} else {
		commande = "bash";
	}
	arguments_ = [sh, ...args];
} else {
	console.error(`✗ Aucun script « ${nom} » pour ce système.`);
	process.exit(1);
}

const resultat = spawnSync(commande, arguments_, { stdio: "inherit" });
if (resultat.error) {
	console.error(`✗ ${resultat.error.message}`);
	process.exit(1);
}
process.exit(resultat.status ?? 1);
