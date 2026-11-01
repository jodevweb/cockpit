import { useSyncExternalStore } from "react";
import type { Turn } from "@/app/agents";
import { commandOf, episodes, isTestCommand, kindOf, summarize } from "@/lib/episodes";
import { api } from "@/lib/ipc";
import { hasTauri } from "@/lib/preview";
import type { Voice } from "@/lib/types";

/**
 * La voix qui raconte ce que fait un agent, pendant qu'on regarde ailleurs.
 *
 * Elle ne dit que ce qu'un collègue dirait à voix haute : ce que l'agent
 * explique, si les tests passent, qu'il a besoin de toi, qu'il a fini — avec
 * un bilan. Jamais une commande, un chemin ou un nom d'outil : une voix de
 * synthèse les ânonne à toute vitesse, et la première version, qui lisait
 * chaque geste, était incompréhensible dès que l'agent lançait une commande.
 *
 * Un seul agent à la fois : quatre agents qui parlent ensemble, c'est du
 * bruit. On l'active sur celui qu'on veut suivre, et il continue de parler
 * quand on change d'onglet.
 */

/* ── Qui on écoute ───────────────────────────────────────────────────── */

let narrated: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function setNarrated(runId: string | null): void {
	if (narrated === runId) return;
	narrated = runId;
	if (runId === null) silence();
	emit();
}

export function narratedNow(): string | null {
	return narrated;
}

export function useNarrated(): string | null {
	return useSyncExternalStore(subscribe, () => narrated);
}

/* ── La voix ─────────────────────────────────────────────────────────── */

export type Engine = "system" | "elevenlabs";

export interface VoiceSettings {
	engine: Engine;
	/** Une voix du Mac : celle du moteur système, et du repli. */
	systemVoice: string | null;
	/** L'identifiant d'une voix du compte ElevenLabs ; vide, la première qui convient. */
	cloudVoice: string | null;
	/** Le modèle ElevenLabs. */
	cloudModel: string;
	/** En mots par minute, comme `say`. */
	rate: number;
}

/** Les modèles ElevenLabs qui parlent français : le plus naturel, et le plus rapide. */
export const CLOUD_MODELS: Array<[string, string]> = [
	["Naturelle", "eleven_multilingual_v2"],
	["Rapide", "eleven_flash_v2_5"],
];

export const RATES: Array<[string, number]> = [
	["Posé", 165],
	["Normal", 185],
	["Rapide", 210],
];

/** Les voix du Mac, de la plus naturelle à la plus synthétique. */
const PREFERRED = [
	/^Audrey \(Premium\)/,
	/^Thomas \(Premium\)/,
	/^Audrey \(Enhanced\)/,
	/^Thomas \(Enhanced\)/,
	/^Audrey/,
	/^Aurélie/,
	/^Marie/,
	/^Amélie/,
];

export function pickVoice(voices: Voice[]): string | null {
	for (const pattern of PREFERRED) {
		const found = voices.find((voice) => pattern.test(voice.name));
		if (found) return found.name;
	}
	return voices.find((voice) => voice.locale.startsWith("fr"))?.name ?? null;
}

/** Une voix Premium ou Enhanced : sans elle, le Mac ne fait pas mieux qu'Amélie. */
export function hasGoodSystemVoice(voices: Voice[]): boolean {
	return voices.some((voice) => voice.locale.startsWith("fr") && /\((Premium|Enhanced)\)/.test(voice.name));
}

const SETTINGS_KEY = "cockpit.narration";

function load(): VoiceSettings {
	const initial: VoiceSettings = {
		engine: "system",
		systemVoice: null,
		cloudVoice: null,
		cloudModel: "eleven_multilingual_v2",
		rate: 185,
	};
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		const stored = raw ? { ...initial, ...(JSON.parse(raw) as Partial<VoiceSettings>) } : initial;
		// Un moteur retiré (OpenAI, avant ElevenLabs) retombe sur le Mac.
		return stored.engine === "elevenlabs" ? stored : { ...stored, engine: "system" };
	} catch {
		return initial;
	}
}

let settings = load();

export function voiceSettings(): VoiceSettings {
	return settings;
}

export function updateVoice(patch: Partial<VoiceSettings>): void {
	settings = { ...settings, ...patch };
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// Stockage indisponible : le choix vaut pour la session.
	}
	emit();
}

export function useVoiceSettings(): VoiceSettings {
	return useSyncExternalStore(subscribe, () => settings);
}

/** La dernière raison pour laquelle ElevenLabs a laissé la main au Mac. */
let fallback: string | null = null;

export function useFallback(): string | null {
	return useSyncExternalStore(subscribe, () => fallback);
}

async function ensureSystemVoice(): Promise<void> {
	if (settings.systemVoice || !hasTauri()) return;
	try {
		const best = pickVoice(await api.speech.voices());
		if (best) updateVoice({ systemVoice: best });
	} catch {
		// Sans liste de voix, `say` prend celle du système.
	}
}

/* ── La file ─────────────────────────────────────────────────────────── */

export interface Line {
	text: string;
	/** Les mots de l'agent et les verdicts : ils passent avant tout le reste. */
	keep: boolean;
}

let queue: Line[] = [];
let busy = false;
let lastSpoken = Date.now();

/** Au-delà, ce qui est en retard saute : mieux vaut le présent qu'un récit en différé. */
const BACKLOG = 2;

async function utter(text: string): Promise<void> {
	lastSpoken = Date.now();
	if (hasTauri()) {
		const reason = await api.speech
			.say(text, {
				engine: settings.engine,
				voice: settings.engine === "elevenlabs" ? settings.cloudVoice : settings.systemVoice,
				model: settings.cloudModel,
				systemVoice: settings.systemVoice,
				rate: settings.rate,
			})
			.catch(() => null);
		if (reason !== fallback) {
			fallback = reason;
			emit();
		}
		return;
	}
	// Hors de la fenêtre native : la synthèse du navigateur, pour l'aperçu.
	return new Promise((resolve) => {
		if (typeof speechSynthesis === "undefined") return resolve();
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = "fr-FR";
		utterance.rate = settings.rate / 185;
		utterance.onend = () => resolve();
		utterance.onerror = () => resolve();
		speechSynthesis.speak(utterance);
	});
}

async function pump(): Promise<void> {
	if (busy) return;
	busy = true;
	await ensureSystemVoice();
	while (queue.length > 0) {
		const line = queue.shift() as Line;
		await utter(line.text);
	}
	lastSpoken = Date.now();
	busy = false;
}

export function say(lines: Line[]): void {
	if (lines.length === 0) return;
	queue.push(...lines);
	if (queue.length > BACKLOG) {
		// Les mots de l'agent d'abord, les plus récents seulement.
		const kept = queue.filter((line) => line.keep);
		queue = (kept.length > 0 ? kept : queue).slice(-BACKLOG);
	}
	void pump();
}

export function silence(): void {
	queue = [];
	if (hasTauri()) void api.speech.stop().catch(() => undefined);
	else if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}

/** Depuis combien de temps rien n'a été dit. */
export function silentFor(): number {
	return busy ? 0 : Date.now() - lastSpoken;
}

/* ── Ce qu'on dit ────────────────────────────────────────────────────── */

const NUMBERS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"];
function count(value: number): string {
	return NUMBERS[value] ?? String(value);
}

/** `points.test.ts` → « points test », `MAX_POINTS` → « max points », `lineTotal` → « line total ». */
function readable(name: string): string {
	return name
		.replace(/\.[a-z0-9]{1,5}$/i, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[._-]+/g, " ")
		.toLowerCase()
		.trim();
}

const DROPPED = "\u2063";

/** Ce qui ne se prononce pas : du code, une commande, une expression. */
const CODE = /[{}()[\]<>=;$|\\&^~]|=>|::|--\w/;

/**
 * Ce qu'un texte d'agent devient à voix haute, ou rien.
 *
 * Les noms de fichiers et d'identifiants se lisent comme des mots, les
 * adresses et les blocs de code disparaissent, et toute phrase qui reste du
 * code est écartée plutôt qu'ânonnée. Deux phrases au plus : la voix résume,
 * elle ne lit pas.
 */
export function humanize(text: string, max = 230): string {
	const prose = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*#+\s*/gm, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/https?:\/\/[^\s)]+/g, "")
		// Un bout de code imprononçable emporte sa phrase : « Je lance pour
		// vérifier », amputé de sa commande, ne dit plus rien.
		.replace(/`([^`]+)`/g, (_, code: string) =>
			CODE.test(code) || /\s/.test(code) ? DROPPED : readable(code.split("/").pop() ?? code),
		)
		.replace(/(?:~|\.{0,2})?\/?(?:[\w.@-]+\/)+([\w.@-]+)/g, (_, file: string) => readable(file))
		.replace(/\b[\w-]+\.(?:tsx?|jsx?|mjs|json|rs|py|rb|go|php|css|scss|md|ya?ml|toml|sql|sh|lock|env)\b/g, (file) =>
			readable(file),
		)
		.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (id) => readable(id))
		.replace(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g, (id) => readable(id))
		.replace(/\*\*|__/g, "")
		.replace(/[*>#]/g, "")
		.replace(/\s*→\s*(?:puis\s+)?/g, ", puis ")
		.replace(/\s*·\s*/g, ", ")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.trim();

	const sentences = prose
		.split(/(?<=[.!?…])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 3 && !CODE.test(sentence) && !sentence.includes(DROPPED));
	let out = "";
	let taken = 0;
	for (const sentence of sentences) {
		if (out && `${out} ${sentence}`.length > max) break;
		out = out ? `${out} ${sentence}` : sentence;
		taken += 1;
		if (taken >= 2) break;
	}
	if (out.length > max) out = `${out.slice(0, out.lastIndexOf(" ", max))}…`;
	return out.length >= 8 ? out : "";
}

/** Le bilan d'une consigne terminée, dit en une phrase. */
export function wrapUp(turns: Turn[]): string {
	const current = episodes(turns).at(-1);
	if (!current) return "C'est terminé, il te rend la main.";
	const s = summarize(current);
	const changed =
		s.changes.length > 0 ? `il a modifié ${count(s.changes.length)} fichier${s.changes.length > 1 ? "s" : ""}` : "";
	const tests = s.testsFail === true ? "les tests échouent" : s.testsFail === false ? "les tests passent" : "";
	if (changed && tests) return `C'est terminé : ${changed}, ${s.testsFail ? "mais" : "et"} ${tests}.`;
	if (changed || tests) return `C'est terminé : ${changed || tests}.`;
	return "C'est terminé, il te rend la main.";
}

/** Où il en est, pour « il travaille toujours ». */
export function progress(turns: Turn[]): string {
	const current = episodes(turns).at(-1);
	const changed = current ? summarize(current).changes.length : 0;
	return changed > 0
		? `Il travaille toujours. Il a modifié ${count(changed)} fichier${changed > 1 ? "s" : ""} depuis ta consigne.`
		: "Il travaille toujours, il explore le code.";
}

/** Ce qu'on sait déjà avoir dit, pour ne dire que la suite. */
export interface Heard {
	count: number;
	/** Les appels dont on a déjà annoncé le résultat. */
	results: Set<string>;
	thinking: boolean;
	pending: number;
}

export function heardNow(turns: Turn[], thinking: boolean, pending: number): Heard {
	return {
		count: turns.length,
		results: new Set(
			turns.filter((turn) => turn.output !== undefined && turn.toolId).map((turn) => turn.toolId as string),
		),
		thinking,
		pending,
	};
}

/** La suite du récit : ce qui est arrivé depuis la dernière fois, dans l'ordre. */
export function narrate(heard: Heard, turns: Turn[], thinking: boolean, pending: Array<{ tool: string }>): Line[] {
	const lines: Line[] = [];
	// La conversation est bornée : si elle a été raccourcie par le début, on
	// repart de ce qu'on a sous les yeux.
	const fresh = turns.slice(Math.min(heard.count, turns.length));
	for (const turn of fresh) {
		if (turn.kind === "assistant") {
			const said = humanize(turn.text);
			if (said) lines.push({ text: said, keep: true });
		} else if (turn.kind === "tool" && kindOf(turn) === "agent") {
			lines.push({ text: "Il confie une partie du travail à un sous-agent.", keep: false });
		} else if (turn.kind === "error") {
			lines.push({ text: "Il a rencontré une erreur.", keep: true });
		}
	}

	// Un seul verdict qui compte à l'oreille : les tests. Les autres commandes
	// se taisent, qu'elles réussissent ou non.
	const verdict = turns
		.filter(
			(turn) =>
				turn.toolId &&
				turn.output !== undefined &&
				!heard.results.has(turn.toolId) &&
				kindOf(turn) === "run" &&
				isTestCommand(commandOf(turn)),
		)
		.at(-1);
	if (verdict) lines.push({ text: verdict.outputError ? "Les tests échouent." : "Les tests passent.", keep: true });

	if (pending.length > heard.pending) {
		const tool = pending.at(-1)?.tool ?? "";
		lines.push({
			text:
				tool === "AskUserQuestion"
					? "Il a besoin de toi : il te pose une question."
					: "Il attend ton autorisation pour continuer.",
			keep: true,
		});
	}
	if (heard.thinking && !thinking && pending.length === 0) {
		lines.push({ text: wrapUp(turns), keep: true });
	}
	return lines;
}
