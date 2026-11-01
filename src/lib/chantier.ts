import type { AgentRun, Turn } from "@/app/agents";
import type { ContextUsage } from "@/lib/types";
import { t } from "@/i18n";
import { joinPath as joinCited } from "@/lib/paths";

/**
 * Lire un chantier comme un lieu, pas comme une suite de messages.
 *
 * La carte d'un agent raconte ce qu'il a fait, dans l'ordre. Un workspace porte
 * souvent plusieurs agents sur le même worktree, et les questions qui comptent
 * alors ne sont plus chronologiques : qui travaille où, qui a sous les yeux une
 * version dépassée d'un fichier, qui écrit par-dessus qui.
 *
 * Tout part de ce que le cockpit a vu passer — les appels d'outils de chaque
 * agent — croisé avec ce que dit le disque. Ce qu'un agent fait par une
 * commande (`cat`, `sed -i`, un script) échappe à cette lecture : on ne le
 * devine pas, on ne voit que les outils de fichiers.
 */

const READERS = new Set(["Read", "NotebookRead"]);
const WRITERS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SEARCHERS = new Set(["Grep", "Glob", "LS"]);

/**
 * Marge entre l'horloge d'un appel et la date que le disque inscrit.
 *
 * `at` est posé à l'arrivée de l'appel dans le flux, la date du fichier au
 * moment où l'outil l'écrit : quelques centaines de millisecondes d'écart, et
 * davantage sur une machine chargée.
 */
const CLOCK_SLACK_MS = 2_000;

/**
 * Les chemins déjà normalisés. Un agent touche les mêmes fichiers des
 * dizaines de fois, et chaque événement de chaque agent relisait tout : le
 * profil d'une rafale le donnait premier poste de dépense de l'interface.
 */
const joined = new Map<string, string>();

export function joinPath(cwd: string, path: string): string {
	if (!path) return path;
	const key = `${cwd}\u0000${path}`;
	const known = joined.get(key);
	if (known !== undefined) return known;
	const result = normalize(cwd, path);
	if (joined.size > 20_000) joined.clear();
	joined.set(key, result);
	return result;
}

function normalize(cwd: string, path: string): string {
	const absolute = joinCited(cwd, path);
	// `a/./b` et `a/b/../c` : le même fichier doit avoir le même nom partout.
	const parts: string[] = [];
	for (const part of absolute.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	// Sous Windows, le lecteur ouvre le chemin (`C:/…`), sans barre devant ;
	// sa lettre en capitale, comme dans les chemins que le Rust envoie.
	if (/^[A-Za-z]:$/.test(parts[0] ?? "")) return [parts[0].toUpperCase(), ...parts.slice(1)].join("/");
	return `/${parts.join("/")}`;
}

/** Le chemin relatif à la racine du worktree, ou `null` s'il en sort. */
export function relativeTo(root: string, absolute: string): string | null {
	const prefix = `${root.replace(/\/$/, "")}/`;
	return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : null;
}

function targetOf(turn: Turn): string | null {
	const input = turn.input ?? {};
	const value = input.file_path ?? input.notebook_path ?? (SEARCHERS.has(turn.tool ?? "") ? input.path : undefined);
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type TouchKind = "read" | "write" | "search";

export interface Touch {
	path: string;
	kind: TouchKind;
	at: number | null;
	/** Fait par un sous-agent : sur le disque, oui ; dans le contexte du maître, non. */
	delegated: boolean;
}

/**
 * Les touches d'un agent, une fois par état de sa conversation.
 *
 * Les tours d'un agent ne changent que lorsqu'il parle : la liste est
 * remplacée, jamais modifiée sur place. Elle sert donc de clé — un agent qui
 * ne bouge pas ne coûte plus rien quand un autre écrit.
 */
const touchCache = new WeakMap<Turn[], { cwd: string; touches: Touch[] }>();

/** Tout ce qu'un agent a lu, cherché ou écrit, sous-agents compris. */
export function touchesOf(run: AgentRun): Touch[] {
	const cached = touchCache.get(run.turns);
	if (cached && cached.cwd === run.cwd) return cached.touches;
	const touches = computeTouches(run);
	touchCache.set(run.turns, { cwd: run.cwd, touches });
	return touches;
}

function computeTouches(run: AgentRun): Touch[] {
	const out: Touch[] = [];
	const visit = (turns: Turn[], delegated: boolean) => {
		for (const turn of turns) {
			if (turn.kind !== "tool") continue;
			if (turn.sub) visit(turn.sub, true);
			const tool = turn.tool ?? "";
			const kind: TouchKind | null = READERS.has(tool)
				? "read"
				: WRITERS.has(tool)
					? "write"
					: SEARCHERS.has(tool)
						? "search"
						: null;
			if (!kind) continue;
			// Un appel refusé ou en échec n'a rien lu ni rien écrit.
			if (turn.outputError) continue;
			const target = targetOf(turn);
			if (!target) continue;
			const at = kind === "write" ? (turn.doneAt ?? turn.at ?? null) : (turn.at ?? null);
			out.push({ path: joinPath(run.cwd, target), kind, at, delegated });
		}
	};
	visit(run.turns, false);
	return out;
}

/** Ce qu'un agent a sous les yeux d'un fichier, dans son propre contexte. */
export interface Knowledge {
	path: string;
	/** Dernière fois qu'il en a vu le contenu : lu, ou écrit lui-même. */
	knownAt: number;
	/** Lu avant le dernier compactage : il n'en garde qu'un résumé. */
	blurred: boolean;
}

/** L'instant du dernier compactage de ce contexte, s'il y en a eu un. */
export function lastCompaction(turns: Turn[]): number | null {
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		if (turns[index].compact) return turns[index].at ?? null;
	}
	return null;
}

/**
 * Les fichiers dont le contenu est dans le contexte de l'agent.
 *
 * Seulement le sien : ce qu'un sous-agent a lu est resté dans le contexte du
 * sous-agent, le maître n'en a reçu que le compte rendu.
 */
const knowledgeCache = new WeakMap<Turn[], { cwd: string; known: Map<string, Knowledge> }>();

export function knowledgeOf(run: AgentRun): Map<string, Knowledge> {
	const cached = knowledgeCache.get(run.turns);
	if (cached && cached.cwd === run.cwd) return cached.known;
	const known = computeKnowledge(run);
	knowledgeCache.set(run.turns, { cwd: run.cwd, known });
	return known;
}

function computeKnowledge(run: AgentRun): Map<string, Knowledge> {
	const compactedAt = lastCompaction(run.turns);
	const known = new Map<string, Knowledge>();
	for (const touch of touchesOf(run)) {
		if (touch.delegated || touch.kind === "search" || touch.at === null) continue;
		const previous = known.get(touch.path);
		if (previous && previous.knownAt >= touch.at) continue;
		known.set(touch.path, {
			path: touch.path,
			knownAt: touch.at,
			blurred: compactedAt !== null && touch.at < compactedAt,
		});
	}
	return known;
}

export interface Stale {
	runId: string;
	path: string;
	knownAt: number;
	/** `null` : le fichier a disparu. */
	modifiedAt: number | null;
	/** L'agent du chantier qui l'a écrit depuis, quand c'en est un. */
	by: { runId: string; label: string } | null;
}

/**
 * Ce que chaque agent croit savoir et qui n'est plus vrai sur le disque.
 *
 * Le disque fait foi : un fichier modifié après la dernière fois où l'agent l'a
 * vu est périmé dans sa tête, quelle que soit la main qui l'a changé. On nomme
 * cette main quand c'est un autre agent du chantier ; sinon, c'est un terminal,
 * un `git`, ou toi.
 */
export function staleness(runs: AgentRun[], stamps: ReadonlyMap<string, number | null>): Stale[] {
	const writes = runs.map((run) => ({
		run,
		writes: touchesOf(run).filter((touch) => touch.kind === "write" && touch.at !== null),
	}));
	const out: Stale[] = [];
	for (const run of runs) {
		for (const knowledge of knowledgeOf(run).values()) {
			if (!stamps.has(knowledge.path)) continue;
			const modifiedAt = stamps.get(knowledge.path) ?? null;
			if (modifiedAt !== null && modifiedAt <= knowledge.knownAt + CLOCK_SLACK_MS) continue;
			// Le plus récent des autres agents à l'avoir écrit après lui.
			let by: Stale["by"] = null;
			let latest = knowledge.knownAt + CLOCK_SLACK_MS;
			for (const other of writes) {
				if (other.run.id === run.id) continue;
				for (const write of other.writes) {
					if (write.path === knowledge.path && (write.at as number) > latest) {
						latest = write.at as number;
						by = { runId: other.run.id, label: other.run.label };
					}
				}
			}
			out.push({ runId: run.id, path: knowledge.path, knownAt: knowledge.knownAt, modifiedAt, by });
		}
	}
	return out.sort((a, b) => (b.modifiedAt ?? Infinity) - (a.modifiedAt ?? Infinity));
}

export interface Collision {
	path: string;
	writers: Array<{ runId: string; label: string; at: number | null }>;
}

/**
 * Les fichiers que plusieurs agents du chantier ont écrits.
 *
 * Dans un même worktree, rien ne les en empêche et rien ne le signale : le
 * second écrase ou recoud le travail du premier, et chacun croit être seul.
 */
export function collisions(runs: AgentRun[]): Collision[] {
	const byPath = new Map<string, Map<string, { runId: string; label: string; at: number | null }>>();
	for (const run of runs) {
		for (const touch of touchesOf(run)) {
			if (touch.kind !== "write") continue;
			const writers = byPath.get(touch.path) ?? new Map();
			const previous = writers.get(run.id);
			if (!previous || (touch.at ?? 0) > (previous.at ?? 0)) {
				writers.set(run.id, { runId: run.id, label: run.label, at: touch.at });
			}
			byPath.set(touch.path, writers);
		}
	}
	return [...byPath.entries()]
		.filter(([, writers]) => writers.size > 1)
		.map(([path, writers]) => ({
			path,
			writers: [...writers.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
		}));
}

/** Les chemins que la carte doit dater sur le disque. */
export function pathsToStamp(runs: AgentRun[]): string[] {
	const paths = new Set<string>();
	for (const run of runs) for (const path of knowledgeOf(run).keys()) paths.add(path);
	return [...paths].sort();
}

/** La couleur d'un agent, par son rang dans le chantier. */
export function agentColor(index: number): string {
	return `var(--agent-${(index % 6) + 1})`;
}

// ───────────────────────────── Contexte ─────────────────────────────

export type SliceKey = "system" | "mcp" | "memory" | "skills" | "messages" | "other";

export interface Slice {
	key: SliceKey;
	label: string;
	tokens: number;
	color: string;
}

const SLICE_OF: Record<string, SliceKey> = {
	"System prompt": "system",
	"System tools": "system",
	"Custom agents": "system",
	"MCP tools": "mcp",
	"MCP server instructions": "mcp",
	"Memory files": "memory",
	Skills: "skills",
	Messages: "messages",
};

const SLICE_LOOK: Record<SliceKey, { label: string; color: string }> = {
	// Libellés lus à l'accès (le `...` du calcul les fige au bon moment).
	messages: { get label() { return t("lib:chantier.slices.messages"); }, color: "var(--accent)" },
	memory: { get label() { return t("lib:chantier.slices.memory"); }, color: "var(--agent-3)" },
	skills: { label: "Skills", color: "var(--agent-4)" },
	mcp: { label: "MCP", color: "var(--agent-1)" },
	system: { get label() { return t("lib:chantier.slices.system"); }, color: "var(--ink-faint)" },
	other: { get label() { return t("lib:chantier.slices.other"); }, color: "var(--line)" },
};

/**
 * Le contexte en tranches lisibles : ce qui occupe vraiment la fenêtre.
 *
 * Les catégories « différées » (outils qu'on ne charge qu'à la demande) et le
 * tampon de compactage ne sont pas du contenu : elles restent hors des tranches.
 */
export function slices(usage: ContextUsage): Slice[] {
	const totals = new Map<SliceKey, number>();
	for (const category of usage.categories) {
		if (category.kind !== "used") continue;
		const key = SLICE_OF[category.name] ?? "other";
		totals.set(key, (totals.get(key) ?? 0) + category.tokens);
	}
	const order: SliceKey[] = ["messages", "memory", "skills", "mcp", "system", "other"];
	return order
		.filter((key) => (totals.get(key) ?? 0) > 0)
		.map((key) => ({ key, tokens: totals.get(key) ?? 0, ...SLICE_LOOK[key] }));
}

/** Où se déclenchera le compactage automatique, en fraction de la fenêtre. */
export function compactAt(usage: ContextUsage): number | null {
	if (!usage.isAutoCompactEnabled || !usage.autoCompactThreshold || !usage.maxTokens) return null;
	return usage.autoCompactThreshold / usage.maxTokens;
}

// ───────────────────────────── Territoire ─────────────────────────────

export interface Zone {
	/** Relatif à la racine ; `""` pour la racine elle-même. */
	path: string;
	name: string;
	bytes: number;
	files: number;
	children: Zone[];
}

/**
 * Ce qu'on ne dessine pas : des fichiers que personne n'écrit à la main.
 *
 * Un lockfile pèse souvent plus que tout le code d'une application — sur la
 * première carte dessinée, `pnpm-lock.yaml` en prenait le tiers. La carte doit
 * montrer où l'on travaille, pas où sont les octets.
 */
const GENERATED =
	/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|go\.sum)$|\.(min\.js|min\.css|map|snap)$|(^|\/)__snapshots__\//;

/**
 * Plafond du poids d'un fichier sur la carte.
 *
 * Au-delà, un fichier de données ou un gros module généré écraserait tout le
 * reste. Plafonné, il reste parmi les plus gros sans effacer ses voisins.
 */
const MAX_WEIGHT = 48 * 1024;

/** L'arbre du dépôt, chaque dossier pesant la somme de ce qu'il contient. */
export function buildZones(files: Array<{ path: string; bytes: number }>): Zone {
	const root: Zone = { path: "", name: "", bytes: 0, files: 0, children: [] };
	const index = new Map<string, Zone>([["", root]]);
	for (const file of files) {
		if (GENERATED.test(file.path)) continue;
		const parts = file.path.split("/");
		// Un fichier vide pèserait zéro et disparaîtrait de la carte : il occupe
		// au moins la place d'une ligne.
		const bytes = Math.min(Math.max(file.bytes, 64), MAX_WEIGHT);
		let parent = root;
		parent.bytes += bytes;
		parent.files += 1;
		for (let depth = 0; depth < parts.length; depth += 1) {
			const path = parts.slice(0, depth + 1).join("/");
			let zone = index.get(path);
			if (!zone) {
				zone = { path, name: parts[depth], bytes: 0, files: 0, children: [] };
				index.set(path, zone);
				parent.children.push(zone);
			}
			zone.bytes += bytes;
			zone.files += 1;
			parent = zone;
		}
	}
	const sort = (zone: Zone) => {
		zone.children.sort((a, b) => b.bytes - a.bytes);
		zone.children.forEach(sort);
	};
	sort(root);
	return root;
}

/**
 * Descend d'un cran tant qu'un dossier n'a qu'un seul enfant : `apps/web/src`
 * se lit d'un coup plutôt qu'en trois clics.
 */
export function collapse(zone: Zone): Zone {
	let current = zone;
	while (current.children.length === 1 && current.children[0].children.length > 0) {
		current = current.children[0];
	}
	return current;
}

export function findZone(root: Zone, path: string): Zone | null {
	if (!path) return root;
	let current: Zone | undefined = root;
	const parts = path.split("/");
	for (let depth = 0; depth < parts.length && current; depth += 1) {
		const target = parts.slice(0, depth + 1).join("/");
		current = current.children.find((child) => child.path === target);
	}
	return current ?? null;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Pavage « squarified » (Bruls, Huizing, van Wijk) : des cases aussi proches
 * du carré que possible, pour que la taille se lise et que le nom tienne.
 */
export function squarify<T extends { bytes: number }>(items: T[], box: Rect): Array<T & { rect: Rect }> {
	const total = items.reduce((sum, item) => sum + item.bytes, 0);
	if (total <= 0 || box.w <= 0 || box.h <= 0) return [];
	const scale = (box.w * box.h) / total;
	const areas = items.map((item) => ({ item, area: item.bytes * scale }));
	const out: Array<T & { rect: Rect }> = [];
	let free = { ...box };
	let row: typeof areas = [];

	const worst = (candidate: typeof areas, side: number) => {
		const sum = candidate.reduce((acc, entry) => acc + entry.area, 0);
		let max = 0;
		let min = Infinity;
		for (const entry of candidate) {
			max = Math.max(max, entry.area);
			min = Math.min(min, entry.area);
		}
		return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
	};

	const layout = (entries: typeof areas) => {
		const sum = entries.reduce((acc, entry) => acc + entry.area, 0);
		const horizontal = free.w >= free.h;
		const thickness = horizontal ? sum / free.h : sum / free.w;
		let offset = 0;
		for (const entry of entries) {
			const length = entry.area / thickness;
			const rect = horizontal
				? { x: free.x, y: free.y + offset, w: thickness, h: length }
				: { x: free.x + offset, y: free.y, w: length, h: thickness };
			out.push({ ...entry.item, rect });
			offset += length;
		}
		free = horizontal
			? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
			: { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness };
	};

	for (const entry of areas) {
		const side = Math.min(free.w, free.h);
		if (row.length === 0 || worst([...row, entry], side) <= worst(row, side)) {
			row.push(entry);
		} else {
			layout(row);
			row = [entry];
		}
	}
	if (row.length > 0) layout(row);
	return out;
}
