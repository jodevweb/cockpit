#!/usr/bin/env node
// Pont navigateur du cockpit — écrit sur le disque par le cockpit.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, dirname } from "node:path";

const PORT = process.env.COCKPIT_BROWSER_PORT;
const LAUNCH = JSON.parse(process.env.COCKPIT_BROWSER_LAUNCH ?? "[]");
const SERVER = JSON.parse(process.env.COCKPIT_BROWSER_SERVER ?? "[]");
const PID_FILE = process.env.COCKPIT_BROWSER_PID;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

// `npx` est un script Node : lancé depuis le Finder, le cockpit n'a pas le
// dossier de Node dans son PATH, et `env node` échouerait.
// Le séparateur du système : `:` ici, `;` sous Windows.
const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` };

const alive = async () => {
  try {
    return (await fetch(`${ENDPOINT}/json/version`)).ok;
  } catch {
    return false;
  }
};

let ready = null;
/** Le navigateur répond — quitte à le lancer. Une seule fois par agent. */
const ensure = () =>
  (ready ??= (async () => {
    if (await alive()) return;
    if (LAUNCH.length === 0) return;
    const child = spawn(LAUNCH[0], LAUNCH.slice(1), { detached: true, stdio: "ignore", env, windowsHide: true });
    child.unref();
    if (PID_FILE && child.pid) writeFileSync(PID_FILE, String(child.pid));
    for (let waited = 0; waited < 15000; waited += 150) {
      if (await alive()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })());

const server = spawn(SERVER[0], [...SERVER.slice(1), "--cdp-endpoint", ENDPOINT], {
  stdio: ["pipe", "inherit", "inherit"],
  env,
  windowsHide: true,
});
server.on("exit", (code) => process.exit(code ?? 0));

// Les messages passent dans l'ordre : un appel d'outil attend le navigateur,
// et tout ce qui le suit attend derrière lui.
let queue = Promise.resolve();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    queue = queue.then(async () => {
      if (line.includes('"tools/call"')) await ensure();
      server.stdin.write(`${line}\n`);
    });
  }
});
process.stdin.on("end", () => server.kill());
