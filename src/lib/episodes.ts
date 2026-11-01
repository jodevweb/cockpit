import type { Turn } from "@/app/agents";
import { t } from "@/i18n";

/**
 * Lire le fil d'un agent comme une suite d'épisodes : une consigne, et tout
 * ce qui y répond.
 *
 * Le fil brut raconte chaque geste. Pour le montrer en carte, on le range par
 * nature — ce qu'il a lu, ce qu'il a changé, ce qu'il a lancé, ce qui a
 * échoué, ce qu'il conclut — sans rien perdre : chaque regroupement garde les
 * tours d'où il vient, pour les rouvrir tels quels.
 */

export type Kind = "read" | "edit" | "run" | "agent" | "other";

const KIND_OF: Record<string, Kind> = {
	Read: "read",
	Glob: "read",
	Grep: "read",
	LS: "read",
	NotebookRead: "read",
	WebFetch: "read",
	WebSearch: "read",
	ToolSearch: "read",
	Edit: "edit",
	MultiEdit: "edit",
	Write: "edit",
	NotebookEdit: "edit",
	Bash: "run",
	BashOutput: "run",
	KillShell: "run",
	Task: "agent",
	Agent: "agent",
};

const TEST_COMMAND =
	/\b(vitest|jest|pytest|phpunit|pest|playwright|cypress|rspec|mocha|cargo test|go test|npm test|pnpm test|yarn test|bun test|deno test|swift test|dotnet test|mvn test|gradlew? test|artisan test|rails test|rake test|mix test|make test|turbo (?:run )?test|nx (?:run(?:-many)? )?test|test:\w+)\b/;

/** Ce que l'équipe a déclaré en plus, dans ses réglages (`workflow.testCommands`). */
let declaredTests: string[] = [];

/**
 * Retient les commandes de test propres à l'équipe. Appelé au chargement de
 * la configuration : chaque carte lit ensuite la même règle.
 */
export function setTestCommands(words: string[]): void {
	declaredTests = words.map((word) => word.trim()).filter(Boolean);
}

/**
 * `pnpm --filter web test cart`, `npm run test -- points` : le gestionnaire de
 * paquets, ses drapeaux, puis le mot `test`. La règle ci-dessus ne voyait que
 * la forme collée (`pnpm test`) et laissait passer les tests d'un monorepo.
 */
const PACKAGE_TEST = /\b(?:pnpm|npm|yarn|bun)\b[^|;&\n]*?\s(?:run\s+)?test(?::\w+)?\b/;

export function isTestCommand(command: string): boolean {
	return TEST_COMMAND.test(command) || PACKAGE_TEST.test(command) || declaredTests.some((word) => command.includes(word));
}

export function kindOf(turn: Turn): Kind {
	return KIND_OF[turn.tool ?? ""] ?? "other";
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function lines(value: string): number {
	return value ? value.split("\n").length : 0;
}

export function pathOf(turn: Turn): string {
	const input = turn.input ?? {};
	return text(input.file_path) || text(input.notebook_path) || text(input.path);
}

export function commandOf(turn: Turn): string {
	return text(turn.input?.command);
}

/**
 * Ce que fait un appel, dit comme un geste : « lance git merge dev » plutôt
 * que « Bash ». Le nom de l'outil ne dit rien de ce qui se passe.
 */
export function gestureOf(turn: Turn): string {
	const path = pathOf(turn);
	const file = path.split("/").filter(Boolean).pop() ?? path;
	const input = turn.input ?? {};
	switch (kindOf(turn)) {
		case "run":
			return commandOf(turn)
				? t("lib:episodes.gesture.runs", { command: commandOf(turn).split("\n")[0] })
				: t("lib:episodes.gesture.uses", { tool: turn.tool });
		case "edit":
			return file ? t("lib:episodes.gesture.edits", { file }) : t("lib:episodes.gesture.editsAFile");
		case "agent":
			return text(input.description)
				? t("lib:episodes.gesture.delegated", { description: text(input.description) })
				: t("lib:episodes.gesture.launchedSubagent");
		case "read":
			if (turn.tool === "Read" && file) return t("lib:episodes.gesture.reads", { file });
			if (text(input.pattern)) return t("lib:episodes.gesture.searches", { query: text(input.pattern) });
			if (text(input.query)) return t("lib:episodes.gesture.searches", { query: text(input.query) });
			return file ? t("lib:episodes.gesture.browses", { file }) : t("lib:episodes.gesture.uses", { tool: turn.tool });
		default:
			return turn.tool
				? t("lib:episodes.gesture.uses", { tool: turn.tool })
				: t("lib:episodes.gesture.usesATool");
	}
}

export interface Change {
	path: string;
	added: number;
	removed: number;
	turns: Turn[];
}

export interface Episode {
	/** La consigne qui l'ouvre ; absente pour un fil repris en cours de route. */
	ask: Turn | null;
	turns: Turn[];
	/** Ce que tu as répondu en cours de route, et à quoi. */
	replies: Array<{ question: Turn | null; reply: Turn }>;
}

/** Un texte qui se termine sur une question, mise en forme Markdown mise à part. */
export function endsWithQuestion(value: string): boolean {
	const lastParagraph = value.trim().split(/\n\s*\n/).at(-1) ?? "";
	return /\?\s*$/.test(lastParagraph.replace(/[*_`]+\s*$/, ""));
}

/** Le dernier message de l'agent dans un épisode. */
function lastSaid(episode: Episode): Turn | null {
	return [...episode.turns].reverse().find((turn) => turn.kind === "assistant" && turn.text.trim()) ?? null;
}

/**
 * L'épisode attend-il une suite ? Oui quand l'agent travaille encore, ou
 * quand il s'est arrêté sur une question — la question doit être son dernier
 * mot : s'il a continué après, il n'attendait pas de réponse.
 */
export function awaitsReply(episode: Episode | undefined, working = false): boolean {
	if (!episode) return false;
	if (working) return true;
	const question = lastSaid(episode);
	const spoken = episode.turns.filter((entry) => entry.kind !== "system");
	return question !== null && spoken.at(-1) === question && endsWithQuestion(question.text);
}

/**
 * Découpe le fil en épisodes : une consigne, et tout ce qui y répond.
 *
 * Tout message n'ouvre pas une consigne. Répondre à une question de l'agent,
 * ou le reprendre pendant qu'il travaille, prolonge l'épisode en cours : en
 * ouvrir un nouveau coupait l'échange en deux, la question d'un côté et sa
 * suite de l'autre. Le choix fait à l'envoi (`follows`) l'emporte toujours ;
 * la règle du « ? » ne vaut que pour les messages qui n'en portent pas.
 */
export function episodes(turns: Turn[]): Episode[] {
	const found: Episode[] = [];
	for (const turn of turns) {
		if (turn.kind === "user") {
			const current = found.at(-1);
			const asked = awaitsReply(current);
			if (current && (turn.follows ?? asked)) {
				current.replies.push({ question: asked ? lastSaid(current) : null, reply: turn });
				current.turns.push(turn);
				continue;
			}
			found.push({ ask: turn, turns: [], replies: [] });
			continue;
		}
		if (found.length === 0) found.push({ ask: null, turns: [], replies: [] });
		found[found.length - 1].turns.push(turn);
	}
	return found;
}

export interface Summary {
	tools: Turn[];
	reads: Turn[];
	agents: Turn[];
	changes: Change[];
	tests: Turn[];
	commands: Turn[];
	failures: Turn[];
	/** Tout ce qu'il a dit dans l'épisode, dans l'ordre. */
	said: Turn[];
	/** Son dernier mot : ce qu'il conclut. */
	answer: Turn | null;
	/** Sa dernière phrase, même de transition : où il en est. */
	lastWords: Turn | null;
	/** Sa conclusion se termine sur une question. */
	asks: boolean;
	/**
	 * Le verdict du dernier test *terminé* ; `null` sans aucun. Un test encore
	 * en cours n'a pas de sortie, et passait jusqu'ici pour réussi.
	 */
	testsFail: boolean | null;
	/** Le dernier test lancé n'a pas encore rendu la main. */
	testPending: boolean;
}

export function summarize(episode: Episode): Summary {
	const tools = episode.turns.filter((turn) => turn.kind === "tool");
	const changes = new Map<string, Change>();
	for (const tool of tools) {
		if (kindOf(tool) !== "edit" || tool.outputError) continue;
		const path = pathOf(tool);
		if (!path) continue;
		const input = tool.input ?? {};
		const change = changes.get(path) ?? { path, added: 0, removed: 0, turns: [] };
		change.turns.push(tool);
		if (tool.tool === "Write") {
			change.added += lines(text(input.content));
		} else if (tool.tool === "MultiEdit" && Array.isArray(input.edits)) {
			for (const edit of input.edits as Array<Record<string, unknown>>) {
				change.added += lines(text(edit.new_string));
				change.removed += lines(text(edit.old_string));
			}
		} else {
			change.added += lines(text(input.new_string));
			change.removed += lines(text(input.old_string));
		}
		changes.set(path, change);
	}

	const runs = tools.filter((tool) => kindOf(tool) === "run");
	const tests = runs.filter((tool) => isTestCommand(commandOf(tool)));
	const commands = runs.filter((tool) => !tests.includes(tool));
	const failures = [
		...tools.filter((tool) => tool.outputError && !tests.includes(tool)),
		...episode.turns.filter((turn) => turn.kind === "error"),
	];
	const said = episode.turns.filter((turn) => turn.kind === "assistant" && turn.text.trim());
	const answer = said.at(-1) ?? null;
	const asks = answer ? endsWithQuestion(answer.text) : false;
	const finished = tests.filter((tool) => tool.output !== undefined);

	return {
		tools,
		reads: tools.filter((tool) => kindOf(tool) === "read"),
		agents: tools.filter((tool) => kindOf(tool) === "agent"),
		changes: [...changes.values()],
		tests,
		commands,
		failures,
		said,
		answer,
		lastWords: answer,
		asks,
		testsFail: finished.length > 0 ? finished.at(-1)?.outputError === true : null,
		testPending: tests.length > 0 && tests.at(-1)?.output === undefined,
	};
}

/**
 * Ce qui tourne en rond dans un épisode.
 *
 * Un agent qui patine ressemble à un agent qui travaille : des outils
 * s'enchaînent, la carte s'allume. Ce qui le trahit, c'est la répétition —
 * le même fichier repris encore et encore, le même test qui échoue, la même
 * commande relancée à l'identique. Aucun seuil ne prouve qu'il est bloqué ;
 * ils disent qu'il vaut la peine d'aller voir.
 */
export interface Loop {
	kind: "edits" | "tests" | "repeat";
	/** Le fichier ou la commande qui revient. */
	target: string;
	count: number;
	/** Entre la première et la dernière fois, quand les tours sont datés. */
	span: number | null;
	turns: Turn[];
}

/** Le même fichier repris autant de fois dans une consigne. */
export const LOOP_EDITS = 5;
/** Le même test en échec autant de fois de suite. */
export const LOOP_FAILED_TESTS = 3;
/** La même commande relancée à l'identique autant de fois. */
export const LOOP_REPEATS = 3;

function spanOf(turns: Turn[]): number | null {
	const first = turns[0]?.at;
	const last = turns.at(-1);
	const end = last?.doneAt ?? last?.at;
	return first && end && end > first ? end - first : null;
}

export function loops(episode: Episode): Loop[] {
	const found: Loop[] = [];
	const tools = episode.turns.filter((turn) => turn.kind === "tool");

	const edits = new Map<string, Turn[]>();
	for (const tool of tools) {
		if (kindOf(tool) !== "edit") continue;
		const path = pathOf(tool);
		if (path) edits.set(path, [...(edits.get(path) ?? []), tool]);
	}
	for (const [path, turns] of edits) {
		if (turns.length >= LOOP_EDITS) {
			found.push({ kind: "edits", target: path, count: turns.length, span: spanOf(turns), turns });
		}
	}

	// Les échecs qui se suivent sur le même test : un test qui finit par passer
	// n'est plus une boucle, c'est une correction qui a marché.
	const runs = tools.filter((tool) => kindOf(tool) === "run" && commandOf(tool));
	const tests = runs.filter((tool) => isTestCommand(commandOf(tool)) && tool.output !== undefined);
	const lastTest = tests.at(-1);
	if (lastTest?.outputError) {
		const streak: Turn[] = [];
		for (const test of [...tests].reverse()) {
			if (!test.outputError || commandOf(test) !== commandOf(lastTest)) break;
			streak.unshift(test);
		}
		if (streak.length >= LOOP_FAILED_TESTS) {
			found.push({
				kind: "tests",
				target: commandOf(lastTest),
				count: streak.length,
				span: spanOf(streak),
				turns: streak,
			});
		}
	}

	const repeats = new Map<string, Turn[]>();
	for (const run of runs) {
		if (isTestCommand(commandOf(run))) continue;
		const command = commandOf(run).trim();
		repeats.set(command, [...(repeats.get(command) ?? []), run]);
	}
	for (const [command, turns] of repeats) {
		if (turns.length >= LOOP_REPEATS) {
			found.push({ kind: "repeat", target: command, count: turns.length, span: spanOf(turns), turns });
		}
	}

	return found.sort((a, b) => b.count - a.count);
}

/** Combien de temps ont pris ces tours, du premier appel au dernier retour. */
export function tookOf(turns: Turn[]): number | null {
	let start: number | null = null;
	let end: number | null = null;
	for (const turn of turns) {
		if (turn.at && (start === null || turn.at < start)) start = turn.at;
		const done = turn.doneAt ?? turn.at;
		if (done && (end === null || done > end)) end = done;
	}
	return start !== null && end !== null && end > start ? end - start : null;
}
