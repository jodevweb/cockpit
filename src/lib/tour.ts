import type { Turn } from "@/app/agents";
import { commandOf, kindOf, pathOf } from "@/lib/episodes";

/**
 * Ce que la conversation apporte à la visite des changements : le pourquoi.
 *
 * Git dit ce qui a changé ; seul l'agent sait pourquoi. À chaque fichier, on
 * retrouve ce qu'il disait juste avant de le toucher — c'est presque toujours
 * l'annonce de ce qu'il allait faire (« je corrige le calcul dans
 * points.ts »).
 */

const COMMIT = /^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/m;

/** Tous les tours, sous-agents compris, dans l'ordre où ils sont arrivés. */
function flatten(turns: Turn[]): Turn[][] {
	const lists: Turn[][] = [turns];
	for (const turn of turns) if (turn.sub?.length) lists.push(...flatten(turn.sub));
	return lists;
}

function clean(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[*_#>`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Un chemin tel que l'outil l'a reçu, ramené à la racine du dépôt. */
export function relativeTo(root: string, cwd: string, path: string): string | null {
	const absolute = path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
	const base = `${root.replace(/\/$/, "")}/`;
	return absolute.startsWith(base) ? absolute.slice(base.length) : null;
}

export interface AgentNotes {
	/** Ce que l'agent disait avant de toucher chaque fichier, sans doublon. */
	said: Map<string, string[]>;
	/** L'ordre dans lequel il les a touchés : la visite suit son fil. */
	order: Map<string, number>;
}

export function agentNotes(turns: Turn[], root: string, cwd: string): AgentNotes {
	const said = new Map<string, string[]>();
	const order = new Map<string, number>();
	let rank = 0;
	for (const list of flatten(turns)) {
		let lastWords: string | null = null;
		for (const turn of list) {
			if (turn.kind === "assistant" && turn.text.trim()) {
				lastWords = clip(clean(turn.text), 420);
				continue;
			}
			if (turn.kind !== "tool" || kindOf(turn) !== "edit" || turn.outputError) continue;
			const path = pathOf(turn);
			const relative = path ? relativeTo(root, cwd, path) : null;
			if (!relative) continue;
			if (!order.has(relative)) order.set(relative, rank++);
			if (lastWords) {
				const known = said.get(relative) ?? [];
				if (!known.includes(lastWords)) said.set(relative, [...known, lastWords]);
			}
		}
	}
	return { said, order };
}

/**
 * Le premier commit de l'agent, s'il en a fait un : sur la branche
 * d'intégration, c'est le seul repère de là où son travail commence.
 */
export function firstCommit(turns: Turn[]): string | null {
	for (const list of flatten(turns)) {
		for (const turn of list) {
			if (turn.kind !== "tool" || kindOf(turn) !== "run") continue;
			if (!/\bgit\b.*\bcommit\b/.test(commandOf(turn))) continue;
			const match = (turn.output ?? "").match(COMMIT);
			if (match) return match[1];
		}
	}
	return null;
}

/** Son dernier mot : la conclusion, qui aide le récit à viser juste. */
export function conclusionOf(turns: Turn[]): string {
	const last = [...turns].reverse().find((turn) => turn.kind === "assistant" && turn.text.trim());
	return last ? clip(last.text.trim(), 4000) : "";
}

/** Y a-t-il de quoi visiter ? Sans écriture ni commit, la visite serait vide. */
export function hasWork(turns: Turn[]): boolean {
	return flatten(turns).some((list) =>
		list.some(
			(turn) =>
				turn.kind === "tool" &&
				!turn.outputError &&
				(kindOf(turn) === "edit" || /\bgit\b.*\bcommit\b/.test(commandOf(turn))),
		),
	);
}
