import type { Turn } from "@/app/agents";
import { t } from "@/i18n";
import { replyDirective } from "@/lib/language";
import type { Episode } from "@/lib/episodes";
import { firstSentence, isBrowserTool } from "@/lib/film";

/**
 * Le test qu'on tire de la recette d'un agent.
 *
 * Le serveur Playwright rend, après chaque geste, le code qu'il vient
 * d'exécuter (« ### Ran Playwright code »). La recette de l'agent est donc
 * déjà écrite, ligne à ligne ; elle se perdait avec la conversation. On la
 * rassemble en un test, proposé — jamais écrit dans le dépôt d'office : c'est
 * l'agent, à qui on le demande, qui le range selon les règles du dépôt.
 *
 * Ce qu'on ne peut pas savoir, on ne l'invente pas : l'agent a cliqué, il n'a
 * pas déclaré ce qu'il attendait. Le test ne vérifie que l'adresse où la
 * recette s'est terminée, et le dit en commentaire.
 */

export interface ProofTest {
	title: string;
	code: string;
	steps: number;
	/** Les gestes écartés : ceux qui regardent la page sans rien y faire. */
	skipped: number;
}

const CODE = /### Ran Playwright code\s*```(?:js|javascript|ts)?\s*\n([\s\S]*?)```/g;
const PAGE_URL = /- Page URL:\s*(\S+)/g;

/** Regarder n'est pas agir : une capture ou une lecture du DOM ne se rejoue pas. */
const OBSERVE = /page\.(screenshot|evaluate|accessibility|content)\b|^\s*\/\//;

function browserTurns(turns: Turn[]): Turn[] {
	const found: Turn[] = [];
	const visit = (entries: Turn[]) => {
		for (const turn of entries) {
			if (turn.kind !== "tool") continue;
			if (turn.sub) visit(turn.sub);
			if (isBrowserTool(turn.tool) && !turn.outputError && typeof turn.output === "string") found.push(turn);
		}
	};
	visit(turns);
	return found;
}

const cache = new WeakMap<Episode, ProofTest | null>();

export function proofTestOf(episode: Episode): ProofTest | null {
	if (cache.has(episode)) return cache.get(episode) ?? null;
	const lines: string[] = [];
	let skipped = 0;
	let lastUrl = "";
	for (const turn of browserTurns(episode.turns)) {
		const output = turn.output ?? "";
		for (const match of output.matchAll(CODE)) {
			for (const line of match[1].split("\n")) {
				if (!line.trim()) continue;
				if (OBSERVE.test(line)) {
					if (!/^\s*\/\//.test(line)) skipped += 1;
					continue;
				}
				lines.push(line.trim());
			}
		}
		for (const match of output.matchAll(PAGE_URL)) lastUrl = match[1];
	}
	// Trois gestes au moins : un `goto` seul n'est pas une recette.
	if (lines.length < 3) {
		cache.set(episode, null);
		return null;
	}
	const title = episode.ask ? firstSentence(episode.ask.text, 80).replace(/["\\]/g, "") : t("lib:proof.defaultTitle").replace(/["\\]/g, "");
	const body = lines.map((line) => `\t${line}`).join("\n");
	const end = lastUrl
		? `\n\t// The agent didn't say what it expected: we only check where the walkthrough ends.\n\tawait expect(page).toHaveURL(${JSON.stringify(lastUrl)});`
		: "";
	const code = `import { expect, test } from "@playwright/test";\n\ntest("${title}", async ({ page }) => {\n${body}${end}\n});\n`;
	const result = { title, code, steps: lines.length, skipped };
	cache.set(episode, result);
	return result;
}

/** La consigne qui demande à l'agent de ranger le test dans le dépôt. */
export function askToKeep(test: ProofTest): string {
	return (
		"Here is the Playwright test drawn from your walkthrough in the browser. Add it to the repository " +
		"following its conventions (end-to-end test folder, selectors, test data), " +
		"replace the URL check with what you actually expected from each step, then " +
		"run it to prove it passes.\n\n```ts\n" +
		test.code +
		"```\n\n" +
		replyDirective()
	);
}
