import type { Turn } from "@/app/agents";
import { delivered } from "@/lib/delivered";
import { commandOf, isTestCommand, kindOf, pathOf, type Episode } from "@/lib/episodes";
import { mediaOfPath, type Media } from "@/lib/media";

/**
 * Le film d'un épisode : huit images au plus, tirées de ce que l'agent a fait.
 *
 * Rien n'est demandé à l'agent. Le cockpit voit passer chaque appel d'outil —
 * 21 840 en un mois sur le poste où l'idée est née — et c'est assez pour
 * raconter un tour sans le relire : ce qu'il a lu, ce qu'il a supposé, ce qu'il
 * a changé, ses tests rouges puis verts, ce qu'il a vu à l'écran, ce qu'il a
 * livré.
 *
 * Les images se choisissent par des règles fixes et non par un modèle : la
 * même conversation donne toujours le même film, et une image absente dit
 * qu'il ne s'est rien passé de ce genre, pas qu'un résumé l'a jugée moins
 * intéressante.
 */

export type FrameKind = "read" | "think" | "edit" | "test" | "fix" | "see" | "deliver";

interface FrameBase {
	key: string;
	kind: FrameKind;
	/** Millisecondes depuis le début de l'épisode, quand le fil est daté. */
	offset: number | null;
	caption: string;
	/** Le tour à rouvrir quand on clique l'image. */
	turn: Turn | null;
}

export type Frame =
	| (FrameBase & { kind: "read"; files: string[]; more: number })
	| (FrameBase & { kind: "think"; quote: string })
	| (FrameBase & { kind: "edit" | "fix"; file: string; removed: string[]; added: string[] })
	| (FrameBase & { kind: "test"; command: string; ok: boolean; lines: string[] })
	| (FrameBase & { kind: "see"; media: Media })
	| (FrameBase & { kind: "deliver"; title: string; detail: string });

export type Phase = "read" | "edit" | "test" | "see" | "run" | "agent";

export interface Segment {
	phase: Phase;
	/** Part de la durée totale, entre 0 et 1. */
	share: number;
	ms: number;
}

export interface Film {
	frames: Frame[];
	segments: Segment[];
	/** Durée de l'épisode, quand elle se mesure. */
	duration: number | null;
	calls: number;
}

const MAX_FRAMES = 8;

/** Ce que l'agent fait dans un navigateur : le sien, ou celui d'un serveur MCP du dépôt. */
export function isBrowserTool(name: string | undefined): boolean {
	return !!name && (name.startsWith("mcp__navigateur__") || /playwright|browser|chrome/i.test(name));
}

function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** La première phrase, bornée : une image se lit en une seconde. */
export function firstSentence(value: string, max = 150): string {
	const clean = value
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/[#*_`>]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const found = /^(.+?[.!?…])(\s|$)/.exec(clean)?.[1] ?? clean;
	return found.length > max ? `${found.slice(0, max - 1).trimEnd()}…` : found;
}

function lines(value: string, max: number): string[] {
	return value
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim())
		.slice(0, max);
}

/** Ce qu'un diff change, en trois lignes de chaque côté au plus. */
function diffOf(turn: Turn): { removed: string[]; added: string[] } {
	const input = turn.input ?? {};
	if (turn.tool === "Write") return { removed: [], added: lines(text(input.content), 3) };
	if (turn.tool === "MultiEdit" && Array.isArray(input.edits)) {
		const first = (input.edits as Array<Record<string, unknown>>)[0] ?? {};
		return { removed: lines(text(first.old_string), 3), added: lines(text(first.new_string), 3) };
	}
	return { removed: lines(text(input.old_string), 3), added: lines(text(input.new_string), 3) };
}

/**
 * Ce qu'une sortie de test dit en deux ou trois lignes : celles qui comptent
 * (réussis, échoués, résumé), pas l'en-tête de l'outil.
 */
function testLines(output: string): string[] {
	const all = output.split("\n").map((line) => line.trim()).filter(Boolean);
	const telling = all.filter((line) =>
		/(✓|✗|×|✔|✘|PASS|FAIL|passed|failed|pass(ing)?\b|fail(ing|ed)?\b|réussi|échou|Tests?:|error)/i.test(line),
	);
	return (telling.length > 0 ? telling.slice(-3) : all.slice(-3)).map((line) =>
		line.length > 90 ? `${line.slice(0, 89)}…` : line,
	);
}

function startOf(episode: Episode): number | null {
	return episode.ask?.at ?? episode.turns.find((turn) => turn.at)?.at ?? null;
}

function imagesOf(turn: Turn): Media[] {
	const found: Media[] = [];
	(turn.outputImages ?? []).forEach((src, index) =>
		found.push({ key: `${turn.toolId ?? turn.at ?? ""}#${index}`, kind: "image", src, label: "capture" }),
	);
	if (turn.tool === "Read" && !turn.outputError && found.length === 0) {
		const media = mediaOfPath(pathOf(turn));
		if (media?.kind === "image") found.push(media);
	}
	return found;
}

const cache = new WeakMap<Episode, Map<string, Film>>();

/**
 * Le film d'un épisode. Mis en cache par épisode et par état de son fil : un
 * film se recalcule quand le fil bouge, pas à chaque rendu.
 */
export function filmOf(episode: Episode, cwd: string): Film {
	const signature = `${episode.turns.length}:${episode.turns.at(-1)?.doneAt ?? episode.turns.at(-1)?.at ?? 0}:${cwd}`;
	const known = cache.get(episode)?.get(signature);
	if (known) return known;
	const film = build(episode, cwd);
	const entry = cache.get(episode) ?? new Map<string, Film>();
	entry.clear();
	entry.set(signature, film);
	cache.set(episode, entry);
	return film;
}

function build(episode: Episode, cwd: string): Film {
	const start = startOf(episode);
	const offset = (turn: Turn | null) => (start && turn?.at ? Math.max(0, turn.at - start) : null);
	const tools = episode.turns.filter((turn) => turn.kind === "tool");
	const frames: Frame[] = [];
	const add = (frame: Frame) => frames.push(frame);

	// 1. Ce qu'il a lu avant de toucher à quoi que ce soit. Écrire une capture
	// n'est pas toucher au code : c'est la preuve qu'on range, pas le travail.
	const isCodeEdit = (turn: Turn) => kindOf(turn) === "edit" && !turn.outputError && !mediaOfPath(pathOf(turn));
	const firstEdit = tools.findIndex(isCodeEdit);
	const before = firstEdit === -1 ? tools : tools.slice(0, firstEdit);
	const read = [...new Set(before.filter((turn) => kindOf(turn) === "read" && pathOf(turn)).map((turn) => basename(pathOf(turn))))];
	const firstRead = before.find((turn) => kindOf(turn) === "read") ?? null;
	if (read.length > 0) {
		add({
			key: "read",
			kind: "read",
			offset: offset(firstRead),
			caption: `Lit ${read.length} fichier${read.length > 1 ? "s" : ""}.`,
			turn: firstRead,
			files: read.slice(0, 6),
			more: Math.max(0, read.length - 6),
		});
	}

	// 2. Ce qu'il a supposé : sa première phrase de fond avant d'écrire.
	const said = episode.turns.filter((turn) => turn.kind === "assistant" && turn.text.trim().length > 40);
	const answer = said.at(-1) ?? null;
	const firstEditTurn = firstEdit === -1 ? null : tools[firstEdit];
	const hypothesis = said.find(
		(turn) => turn !== answer && (!firstEditTurn || (turn.at ?? 0) <= (firstEditTurn.at ?? Number.MAX_SAFE_INTEGER)),
	);
	if (hypothesis) {
		add({
			key: "think",
			kind: "think",
			offset: offset(hypothesis),
			caption: "Ce qu'il suppose.",
			turn: hypothesis,
			quote: firstSentence(hypothesis.text, 140),
		});
	}

	// 3. Son premier changement.
	if (firstEditTurn) {
		const diff = diffOf(firstEditTurn);
		add({
			key: "edit",
			kind: "edit",
			offset: offset(firstEditTurn),
			caption: `Modifie ${basename(pathOf(firstEditTurn))}.`,
			turn: firstEditTurn,
			file: basename(pathOf(firstEditTurn)),
			...diff,
		});
	}

	// 4. Ses tests : le premier rendu, la correction qui suit un échec, le dernier.
	const tests = tools.filter((turn) => kindOf(turn) === "run" && isTestCommand(commandOf(turn)) && turn.output !== undefined);
	const testFrame = (turn: Turn, key: string): Frame => {
		const ok = !turn.outputError;
		const out = testLines(text(turn.output));
		return {
			key,
			kind: "test",
			offset: offset(turn),
			caption: ok ? "Les tests passent." : "Des tests échouent.",
			turn,
			command: commandOf(turn).split("\n")[0],
			ok,
			lines: out,
		};
	};
	const firstTest = tests[0];
	if (firstTest) add(testFrame(firstTest, "test-first"));
	if (firstTest?.outputError) {
		const index = tools.indexOf(firstTest);
		const fix = tools.slice(index + 1).find(isCodeEdit);
		if (fix) {
			add({
				key: "fix",
				kind: "fix",
				offset: offset(fix),
				caption: `Corrige ${basename(pathOf(fix))}.`,
				turn: fix,
				file: basename(pathOf(fix)),
				...diffOf(fix),
			});
		}
	}
	const lastTest = tests.at(-1);
	if (lastTest && lastTest !== firstTest) add(testFrame(lastTest, "test-last"));

	// 5. Ce qu'il a vu à l'écran : la dernière capture de l'épisode.
	const seen = [...tools].reverse().find((turn) => imagesOf(turn).length > 0);
	if (seen) {
		add({
			key: "see",
			kind: "see",
			offset: offset(seen),
			caption: isBrowserTool(seen.tool) ? "Vérifie dans le navigateur." : "Regarde le résultat.",
			turn: seen,
			media: imagesOf(seen).at(-1)!,
		});
	}

	// 6. Ce qu'il a livré, ou à défaut ce qu'il conclut.
	const shipped = delivered(episode, answer, cwd);
	const review = shipped.reviews.at(-1);
	const commit = shipped.commits.at(-1);
	if (review || commit || shipped.pushed.length > 0) {
		add({
			key: "deliver",
			kind: "deliver",
			offset: offset(shipped.turns.at(-1) ?? null),
			caption: "Livre.",
			turn: shipped.turns.at(-1) ?? null,
			title: review ? `PR ${review.label}` : commit ? `Commit ${commit.sha}` : `Poussé : ${shipped.pushed.at(-1)}`,
			detail: commit?.message ?? (shipped.pushed.length > 0 ? `branche ${shipped.pushed.at(-1)}` : ""),
		});
	} else if (answer) {
		add({
			key: "deliver",
			kind: "deliver",
			offset: offset(answer),
			caption: "Rend la main.",
			turn: answer,
			title: firstSentence(answer.text, 90),
			detail: "",
		});
	}

	// L'ordre du film est celui du temps, pas celui des règles.
	frames.sort((a, b) => (a.offset ?? Number.MAX_SAFE_INTEGER) - (b.offset ?? Number.MAX_SAFE_INTEGER));
	const kept = frames.length > MAX_FRAMES ? frames.slice(0, MAX_FRAMES - 1).concat(frames.at(-1)!) : frames;

	return { frames: kept, ...timeline(tools, start), calls: tools.length };
}

function phaseOf(turn: Turn): Phase {
	if (isBrowserTool(turn.tool)) return "see";
	const kind = kindOf(turn);
	if (kind === "run") return isTestCommand(commandOf(turn)) ? "test" : "run";
	if (kind === "edit") return "edit";
	if (kind === "agent") return "agent";
	return "read";
}

/**
 * Où est passé le temps : chaque appel compte de son départ à sa réponse, et
 * les segments voisins d'une même nature se fondent. Un fil non daté (relu
 * d'une vieille session) n'a pas de frise plutôt qu'une frise inventée.
 */
function timeline(tools: Turn[], start: number | null): { segments: Segment[]; duration: number | null } {
	const timed = tools.filter((turn) => turn.at);
	if (timed.length === 0 || !start) return { segments: [], duration: null };
	const end = Math.max(...timed.map((turn) => turn.doneAt ?? turn.at ?? 0));
	const total = end - start;
	if (total <= 0) return { segments: [], duration: null };
	const merged: Segment[] = [];
	for (const turn of timed) {
		const ms = Math.max(0, (turn.doneAt ?? turn.at ?? 0) - (turn.at ?? 0));
		if (ms === 0) continue;
		const phase = phaseOf(turn);
		const last = merged.at(-1);
		if (last && last.phase === phase) last.ms += ms;
		else merged.push({ phase, ms, share: 0 });
	}
	const busy = merged.reduce((sum, segment) => sum + segment.ms, 0) || 1;
	for (const segment of merged) segment.share = segment.ms / busy;
	return { segments: merged, duration: total };
}

export const PHASE_LABELS: Record<Phase, string> = {
	read: "lire",
	edit: "modifier",
	test: "tester",
	see: "vérifier à l'écran",
	run: "commandes",
	agent: "sous-agents",
};

/** « 4:30 », « 1 h 02 » : l'heure du film, pas l'heure de la journée. */
export function clock(ms: number | null): string {
	if (ms === null) return "";
	const seconds = Math.round(ms / 1000);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")}`;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}
