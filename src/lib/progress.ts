import type { AgentRun, Turn } from "@/app/agents";

/**
 * Où en est un agent dans sa consigne — sans rien inventer.
 *
 * Un pourcentage suppose un total, et un agent découvre son travail en
 * avançant : personne ne sait s'il en est à 40 % ou à 90 %. On ne compte donc
 * que ce qui existe vraiment : les étapes qu'il a lui-même déclarées quand il
 * tient une liste, les sous-agents qu'il a lancés et ceux qui ont rendu, et
 * depuis quand il n'a plus rien fait. Sans liste, il n'y a pas de fraction, et
 * la carte le dit plutôt que d'en fabriquer une.
 */

export type StepState = "pending" | "active" | "done";

export interface Step {
	label: string;
	state: StepState;
}

export interface Helper {
	label: string;
	/** Le type de sous-agent, quand l'appel le précise. */
	kind: string;
	state: "running" | "done" | "failed";
	startedAt: number | null;
	endedAt: number | null;
}

export interface Progress {
	/** La consigne en cours, telle qu'elle a été écrite. */
	brief: string;
	/** Quand elle est partie — `null` si le fil n'a pas daté ce message. */
	since: number | null;
	/** Les étapes déclarées par l'agent ; vide s'il ne tient pas de liste. */
	steps: Step[];
	helpers: Helper[];
	/** Appels d'outils depuis la consigne, sous-agents non compris. */
	calls: number;
	/** Fichiers distincts écrits depuis la consigne. */
	written: number;
	/** Dernier signe de vie : un appel parti, ou une réponse revenue. */
	lastAt: number | null;
	/** Ce qu'il a fait en dernier, en clair. */
	lastAction: string;
}

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const WRITERS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Tenir sa liste n'est pas un geste sur le travail : ni compté, ni cité. */
const LIST_TOOLS = new Set(["mcp__cockpit__etapes", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

/** Les états de l'outil du cockpit (voir `permissions.rs`). */
const ETATS: Record<string, StepState> = { faite: "done", en_cours: "active" };

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function stateOf(status: string): StepState {
	if (status === "completed") return "done";
	if (status === "in_progress") return "active";
	return "pending";
}

/**
 * La liste que l'agent tient, quelle que soit sa forme.
 *
 * `mcp__cockpit__etapes` est l'outil du cockpit : le CLI n'en a plus en propre,
 * et c'est donc celui qu'on rencontre. Il renvoie la liste entière.
 * `TodoWrite` réécrit la liste entière à chaque appel : le dernier fait foi.
 * `TaskCreate`/`TaskUpdate` la construisent pièce à pièce : chaque création
 * prend le numéro suivant, que le CLI rappelle dans sa réponse.
 */
function stepsOf(turns: Turn[]): Step[] {
	let todos: Step[] | null = null;
	const tasks = new Map<string, Step>();
	let next = 1;

	for (const turn of turns) {
		if (turn.kind !== "tool" || turn.outputError) continue;
		const input = turn.input ?? {};
		if (turn.tool === "mcp__cockpit__etapes" && Array.isArray(input.etapes)) {
			todos = (input.etapes as Array<Record<string, unknown>>).map((etape) => ({
				label: text(etape.titre),
				state: ETATS[text(etape.etat)] ?? "pending",
			}));
		} else if (turn.tool === "TodoWrite" && Array.isArray(input.todos)) {
			todos = (input.todos as Array<Record<string, unknown>>).map((todo) => ({
				label: text(todo.content) || text(todo.activeForm),
				state: stateOf(text(todo.status)),
			}));
		} else if (turn.tool === "TaskCreate") {
			const id = /#(\d+)/.exec(turn.output ?? "")?.[1] ?? String(next);
			next = Math.max(next, Number(id)) + 1;
			tasks.set(id, { label: text(input.subject) || text(input.description), state: "pending" });
		} else if (turn.tool === "TaskUpdate") {
			const id = text(input.taskId);
			const task = tasks.get(id);
			if (!task) continue;
			if (text(input.status) === "deleted") tasks.delete(id);
			else {
				if (input.status) task.state = stateOf(text(input.status));
				if (text(input.subject)) task.label = text(input.subject);
			}
		}
	}
	// Un agent n'emploie qu'une de ces formes.
	return tasks.size > 0 ? [...tasks.values()] : (todos ?? []);
}

function helperOf(turn: Turn): Helper {
	const input = turn.input ?? {};
	const pending = turn.background ? turn.background.endedAt === null : turn.output === undefined;
	return {
		label: text(input.description) || turn.text,
		kind: text(input.subagent_type),
		state: turn.outputError ? "failed" : pending ? "running" : "done",
		startedAt: turn.at ?? null,
		endedAt: turn.background ? turn.background.endedAt : (turn.doneAt ?? null),
	};
}

const cache = new WeakMap<Turn[], Progress>();

export function progressOf(run: AgentRun): Progress {
	// Les tours d'un agent sont remplacés, jamais modifiés : ils servent de clé.
	const cached = cache.get(run.turns);
	if (cached) return cached;

	// La consigne en cours part du dernier message qui n'en prolonge pas un autre.
	let from = 0;
	for (let index = run.turns.length - 1; index >= 0; index -= 1) {
		const turn = run.turns[index];
		if (turn.kind === "user" && turn.follows !== true) {
			from = index;
			break;
		}
	}
	const head = run.turns[from];
	const turns = run.turns.slice(from);

	const helpers: Helper[] = [];
	const files = new Set<string>();
	let calls = 0;
	let lastAt: number | null = null;
	let lastAction = "";
	const visit = (list: Turn[], nested: boolean) => {
		for (const turn of list) {
			const at = Math.max(turn.at ?? 0, turn.doneAt ?? 0);
			if (at > 0 && (lastAt === null || at > lastAt)) lastAt = at;
			if (turn.kind !== "tool") continue;
			if (turn.sub) visit(turn.sub, true);
			if (LIST_TOOLS.has(turn.tool ?? "")) continue;
			if (!nested && AGENT_TOOLS.has(turn.tool ?? "")) helpers.push(helperOf(turn));
			else if (!nested) calls += 1;
			if (WRITERS.has(turn.tool ?? "") && !turn.outputError) {
				const path = text(turn.input?.file_path) || text(turn.input?.notebook_path);
				if (path) files.add(path);
			}
			if (!nested) lastAction = turn.text || turn.tool || lastAction;
		}
	};
	visit(turns, false);

	const result: Progress = {
		brief: head?.kind === "user" ? head.text : "",
		since: head?.kind === "user" ? (head.at ?? null) : null,
		// La liste, elle, se lit sur tout le fil : elle survit aux relances.
		steps: stepsOf(run.turns),
		helpers,
		calls,
		written: files.size,
		lastAt,
		lastAction,
	};
	cache.set(run.turns, result);
	return result;
}
