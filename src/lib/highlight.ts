import { useEffect, useState } from "react";

/**
 * La coloration du code, pour le lire — pas pour l'éditer.
 *
 * La visionneuse montrait un `.tsx` en gris uniforme : on relit ce qu'un agent
 * a écrit sans rien pour distinguer un mot-clé d'une chaîne ou d'un
 * commentaire. Le fichier est colorié d'un seul tenant — un commentaire ou une
 * chaîne peut courir sur plusieurs lignes — puis redécoupé ligne par ligne,
 * parce que la visionneuse numérote, cherche et désigne des lignes.
 *
 * La bibliothèque ne se charge qu'à la première ouverture d'un fichier de
 * code, et le texte s'affiche sans l'attendre.
 */

/** Un morceau de ligne et la classe de couleur qu'il porte, s'il en a une. */
export interface Segment {
	text: string;
	tone?: string;
}

/** Au-delà, colorier coûte plus que ce que la couleur apporte. */
const MAX_CHARS = 250_000;

const BY_EXTENSION: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "json", json5: "json",
	css: "css", scss: "scss",
	html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", astro: "xml",
	rs: "rust", py: "python", go: "go", php: "php", rb: "ruby",
	java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
	sh: "bash", bash: "bash", zsh: "bash",
	yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini", conf: "ini",
	sql: "sql", graphql: "graphql", gql: "graphql",
	diff: "diff", patch: "diff",
};

const BY_NAME: Record<string, string> = {
	dockerfile: "dockerfile",
	makefile: "makefile",
	".env": "ini",
	".gitignore": "ini",
	".npmrc": "ini",
};

/** Le langage d'un fichier d'après son nom, ou rien si on ne le colorie pas. */
export function languageOf(path: string): string | null {
	const name = (path.split("/").pop() ?? "").toLowerCase();
	if (BY_NAME[name]) return BY_NAME[name];
	if (name.startsWith(".env.")) return "ini";
	if (name.startsWith("dockerfile")) return "dockerfile";
	const extension = name.includes(".") ? (name.split(".").pop() ?? "") : "";
	return BY_EXTENSION[extension] ?? null;
}

type Engine = { highlight: (code: string, options: { language: string; ignoreIllegals: boolean }) => { value: string } };

let engine: Promise<Engine> | null = null;

/** Le moteur et ses langages, chargés une fois, à la demande. */
function load(): Promise<Engine> {
	engine ??= (async () => {
		const [core, ...languages] = await Promise.all([
			import("highlight.js/lib/core"),
			import("highlight.js/lib/languages/typescript"),
			import("highlight.js/lib/languages/javascript"),
			import("highlight.js/lib/languages/json"),
			import("highlight.js/lib/languages/css"),
			import("highlight.js/lib/languages/scss"),
			import("highlight.js/lib/languages/xml"),
			import("highlight.js/lib/languages/rust"),
			import("highlight.js/lib/languages/python"),
			import("highlight.js/lib/languages/go"),
			import("highlight.js/lib/languages/php"),
			import("highlight.js/lib/languages/ruby"),
			import("highlight.js/lib/languages/java"),
			import("highlight.js/lib/languages/kotlin"),
			import("highlight.js/lib/languages/swift"),
			import("highlight.js/lib/languages/c"),
			import("highlight.js/lib/languages/cpp"),
			import("highlight.js/lib/languages/bash"),
			import("highlight.js/lib/languages/yaml"),
			import("highlight.js/lib/languages/ini"),
			import("highlight.js/lib/languages/sql"),
			import("highlight.js/lib/languages/graphql"),
			import("highlight.js/lib/languages/diff"),
			import("highlight.js/lib/languages/dockerfile"),
			import("highlight.js/lib/languages/makefile"),
		]);
		const names = [
			"typescript", "javascript", "json", "css", "scss", "xml", "rust", "python", "go", "php", "ruby",
			"java", "kotlin", "swift", "c", "cpp", "bash", "yaml", "ini", "sql", "graphql", "diff", "dockerfile", "makefile",
		];
		languages.forEach((language, index) => core.default.registerLanguage(names[index], language.default));
		return core.default as Engine;
	})();
	return engine;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/**
 * Redécoupe le rendu du moteur — du HTML à `span` imbriqués — en lignes de
 * morceaux. Une couleur ouverte avant un saut de ligne continue après lui.
 */
export function splitLines(html: string): Segment[][] {
	const lines: Segment[][] = [[]];
	const stack: string[] = [];
	const push = (text: string) => {
		if (!text) return;
		// La classe la plus proche décide : `hljs-title function_` dans un
		// `hljs-function` garde sa couleur de titre.
		const tone = stack[stack.length - 1];
		const parts = text.split("\n");
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part) lines[lines.length - 1].push(tone ? { text: part, tone } : { text: part });
		});
	};
	const tag = /<span class="([^"]*)">|<\/span>/g;
	let cursor = 0;
	for (let match = tag.exec(html); match; match = tag.exec(html)) {
		push(decode(html.slice(cursor, match.index)));
		if (match[0] === "</span>") stack.pop();
		else stack.push(match[1]);
		cursor = tag.lastIndex;
	}
	push(decode(html.slice(cursor)));
	return lines;
}

function decode(text: string): string {
	return text.includes("&") ? text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity) : text;
}

/**
 * Les lignes d'un fichier, coloriées — ou `null` tant que ce n'est pas prêt,
 * ou quand le fichier ne se colorie pas. L'appelant affiche alors le texte nu.
 */
export function useHighlight(code: string, path: string, enabled: boolean): Segment[][] | null {
	const language = enabled ? languageOf(path) : null;
	const [result, setResult] = useState<{ code: string; language: string; lines: Segment[][] } | null>(null);
	useEffect(() => {
		if (!language || !code || code.length > MAX_CHARS) return;
		let alive = true;
		void load()
			.then((hljs) => {
				if (!alive) return;
				const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
				setResult({ code, language, lines: splitLines(html) });
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [code, language]);
	// Un résultat qui ne correspond plus au texte affiché décalerait les lignes.
	return result && language && result.code === code && result.language === language ? result.lines : null;
}
