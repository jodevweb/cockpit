#!/usr/bin/env node
// Vérifie les catalogues de traduction contre l'anglais, qui fait référence.
//
//   node scripts/i18n-check.mjs            → toutes les langues
//   node scripts/i18n-check.mjs de ja      → seulement celles-ci
//
// Pour chaque espace (`src/locales/<langue>/*.json` et
// `src-tauri/locales/<langue>/*.json`) : clés manquantes, clés en trop,
// variables `{{nom}}` qui ne correspondent pas, valeurs vides. Les pluriels
// (`_one`, `_few`, `_many`, `_other`…) varient d'une langue à l'autre : on
// compare leur racine, pas chaque forme.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const bases = ["src/locales", "src-tauri/locales"].map((dir) => path.join(root, dir));
const wanted = process.argv.slice(2);
const PLURAL = /_(zero|one|two|few|many|other)$/;

function flatten(value, prefix = "", out = {}) {
	for (const [key, child] of Object.entries(value)) {
		const full = prefix ? `${prefix}.${key}` : key;
		if (child && typeof child === "object") flatten(child, full, out);
		else out[full] = String(child ?? "");
	}
	return out;
}

const vars = (text) => [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort().join(",");
const stem = (key) => key.replace(PLURAL, "");
const sansCount = (list) => list.split(",").filter((name) => name && name !== "count").join(",");
let PLURAL_STEMS;

let problems = 0;
for (const base of bases) {
	if (!fs.existsSync(path.join(base, "en"))) continue;
	const languages = fs.readdirSync(base).filter((dir) => dir !== "en" && (!wanted.length || wanted.includes(dir)));
	for (const file of fs.readdirSync(path.join(base, "en")).filter((name) => name.endsWith(".json"))) {
		const reference = flatten(JSON.parse(fs.readFileSync(path.join(base, "en", file), "utf8")));
		const referenceStems = new Map();
		PLURAL_STEMS = new Set(Object.keys(reference).filter((key) => PLURAL.test(key)).map(stem));
		for (const [key, text] of Object.entries(reference)) {
			if (!referenceStems.has(stem(key))) referenceStems.set(stem(key), vars(text));
		}
		for (const language of languages) {
			const target = path.join(base, language, file);
			const label = `${path.relative(root, base)}/${language}/${file}`;
			if (!fs.existsSync(target)) {
				console.log(`✗ ${label} : fichier absent`);
				problems++;
				continue;
			}
			let translated;
			try {
				translated = flatten(JSON.parse(fs.readFileSync(target, "utf8")));
			} catch (error) {
				console.log(`✗ ${label} : JSON illisible (${error.message})`);
				problems++;
				continue;
			}
			const stems = new Map();
			for (const [key, text] of Object.entries(translated)) {
				if (!text.trim()) {
					console.log(`✗ ${label} : valeur vide « ${key} »`);
					problems++;
				}
				const s = stem(key);
				if (!referenceStems.has(s)) {
					console.log(`✗ ${label} : clé en trop « ${key} »`);
					problems++;
				}
				if (!stems.has(s)) stems.set(s, vars(text));
			}
			for (const [s, expected] of referenceStems) {
				if (!stems.has(s)) {
					console.log(`✗ ${label} : clé manquante « ${s} »`);
					problems++;
				} else if (stems.get(s) !== expected && !(PLURAL_STEMS.has(s) && sansCount(stems.get(s)) === sansCount(expected))) {
					// Un pluriel peut ajouter ou omettre `{{count}}` : en russe, la forme
					// `_one` sert aussi à 21, 31… et doit donc porter le nombre.
					console.log(`✗ ${label} : variables « ${s} » : attendu [${expected}], trouvé [${stems.get(s)}]`);
					problems++;
				}
			}
		}
	}
}
console.log(problems ? `\n${problems} problème(s).` : "✓ Catalogues cohérents.");
process.exit(problems ? 1 : 0);
