/**
 * L'assistant vocal : ce qu'il sait faire, ce qu'on lui dit du cockpit, et
 * comment on lit ce qu'il répond.
 *
 * Il ne fait rien lui-même. Claude choisit une action dans ce catalogue et en
 * remplit les paramètres avec ce qu'il voit du contexte — les noms exacts des
 * worktrees, des agents, des missions — puis le cockpit l'exécute avec les
 * mêmes gestes que ses écrans. Une action qui vise quelque chose d'introuvable
 * n'est pas devinée : l'assistant le dit.
 */

import { t } from "@/i18n";
import { languageName } from "@/lib/language";

const MODIFIERS: Record<string, string> = { control: "⌃", ctrl: "⌃", alt: "⌥", option: "⌥", shift: "⇧", super: "⌘", cmd: "⌘", command: "⌘" };

/** `control+alt+KeyJ` → « ⌃⌥ J », `alt+Space` → « ⌥ Espace » (dans la langue de l'interface). */
export function shortcutLabel(accelerator: string): string {
	const parts = accelerator.split("+").filter(Boolean);
	const key = parts.pop() ?? "";
	const mods = parts.map((part) => MODIFIERS[part.toLowerCase()] ?? part).join("");
	const name =
		key === "Space"
			? t("lib:assistant.keys.space")
			: key
					.replace(/^Key/, "")
					.replace(/^Digit/, "")
					.replace(/^Arrow(.*)$/, (_, direction: string) => t("lib:assistant.keys.arrow", { direction }))
					.replace("Backquote", "`");
	return mods ? `${mods} ${name}` : name;
}

/**
 * Un raccourci depuis une frappe au clavier, au format que Rust relit, ou
 * `null` : une touche seule, ou Maj seule, ouvrirait le micro à chaque
 * caractère tapé ailleurs.
 */
export function acceleratorOf(event: KeyboardEvent): string | null {
	if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"].includes(event.key)) return null;
	const mods = [event.shiftKey && "shift", event.ctrlKey && "control", event.altKey && "alt", event.metaKey && "super"].filter(
		Boolean,
	) as string[];
	const strong = mods.filter((mod) => mod !== "shift");
	if (strong.length === 0 && !/^F\d+$/.test(event.code)) return null;
	return [...mods, event.code].join("+");
}

/** Où le raccourci change : la page l'annonce, le bandeau le relit. */
export const SHORTCUT_EVENT = "assistant-shortcut";

export interface AssistantAction {
	name: string;
	/** Ce que fait l'action, pour le modèle. */
	description: string;
	/** Les paramètres attendus, avec ce qu'ils désignent. */
	params: Record<string, string>;
}

export const ACTIONS: AssistantAction[] = [
	{ name: "go_to", description: "Show a cockpit screen.", params: { view: "screen identifier, as listed" } },
	{ name: "switch_project", description: "Change the active project.", params: { project: "project name, as listed" } },
	{
		name: "open_workspace",
		description: "Open a folder's workspace: its agents and terminals.",
		params: { folder: "folder name of a worktree or an agent, as listed" },
	},
	{
		name: "open_worktree",
		description: "Show a worktree in the Worktrees screen.",
		params: { folder: "folder name of the worktree, as listed" },
	},
	{
		name: "start_mission",
		description:
			"Create a mission from a ticket (Linear or other) and launch its lead agent. If a mission already exists for that ticket, it is reopened.",
		params: { ticket: "ticket identifier (e.g. NW-3050) or its URL" },
	},
	{ name: "open_mission", description: "Show an existing mission.", params: { mission: "mission identifier, as listed" } },
	{
		name: "create_branch",
		description: "Create a git branch in the main repository, without checking it out.",
		params: {
			name: "valid git branch name (e.g. fix/cart-rounding), no spaces or accents",
			base: "starting branch, optional (defaults to the integration branch)",
		},
	},
	{
		name: "create_worktree",
		description: "Create a worktree for a branch, using the team's command.",
		params: { branch: "branch name" },
	},
	{
		name: "review_pr",
		description:
			"Have a read-only agent review a PR (full code review): the cockpit updates its branch, opens or creates its worktree, launches the agent with the review instructions, and files the points raised. For a PR the person REVIEWS — usually someone else's.",
		params: { pr: "PR number, as listed — optional: empty = the PR from Here" },
	},
	{
		name: "recheck_pr",
		description:
			"Check the fixes pushed to an already reviewed PR: the agent checks each point of the previous review, rereads what changed, and says whether it can be merged.",
		params: { pr: "PR number, as listed — optional: empty = the PR from Here" },
	},
	{
		name: "tell_agent",
		description:
			"Hand work to an agent that is already open: send it an instruction. By default, the agent from Here. If there is no live agent in that folder, the cockpit launches one with the instruction.",
		params: {
			agent: "agent identifier, as listed — optional: empty = the agent from Here",
			prompt: "the complete instruction, written for the agent (see the rules)",
		},
	},
	{
		name: "launch_agent",
		description:
			"Launch a NEW agent in a folder — a worktree, a repository, any listed folder — without creating a branch or a worktree, and open its workspace. With an instruction if the person gives one.",
		params: {
			folder: "folder name, as listed under Folders or Worktrees — optional: empty = the folder from Here",
			prompt: "the instruction to give the agent, optional",
		},
	},
	{ name: "git_pull", description: "Pull a worktree.", params: { folder: "folder name of the worktree" } },
	{ name: "git_push", description: "Push a worktree's branch.", params: { folder: "folder name of the worktree" } },
	{
		name: "listen_agent",
		description: "Narrate out loud what an open agent is doing.",
		params: { agent: "agent identifier, as listed" },
	},
	{ name: "stop_listening", description: "Stop narrating what an agent is doing.", params: {} },
	{
		name: "visit_changes",
		description: "Open the guided tour of an agent's changes.",
		params: { agent: "agent identifier, as listed" },
	},
];

/** Ce que la personne a sous les yeux au moment où elle parle. */
export interface Here {
	/** Le workspace affiché à l'écran — ou, ailleurs, le dernier ouvert. */
	folder: string;
	branch: string | null;
	/** Vrai si l'écran Workspaces est celui qu'on regarde. */
	onScreen: boolean;
	/** L'agent au premier plan dans ce workspace, s'il y en a un. */
	agent: { id: string; label: string; state: string } | null;
	/** La PR ouverte depuis cette branche, quand on la connaît. */
	pr: { number: number; title: string } | null;
}

export interface AssistantContext {
	view: string;
	here: Here | null;
	prs: Array<{ number: number; title: string; branch: string; author: string; reviewers: string[]; review: string }>;
	views: Array<{ id: string; label: string }>;
	projects: Array<{ name: string; active: boolean }>;
	worktrees: Array<{ folder: string; branch: string | null }>;
	/** Les dossiers où un agent peut être lancé : récents d'abord, puis le répertoire de projets. */
	folders: string[];
	agents: Array<{ id: string; label: string; folder: string; state: string }>;
	missions: Array<{ id: string; ticket: string; title: string; state: string }>;
	branches: string[];
}

/**
 * La consigne système, en anglais : un prompt anglais et une consigne de
 * langue (en tête de `buildPrompt`, lue au moment de la demande) valent mieux
 * qu'un prompt par langue. Les noms d'actions, les clés JSON et « Here »
 * restent fixes : le code les relit.
 */
export const SYSTEM = `You are the voice assistant of Cockpit, a control station for coding agents. \
The person speaks to you; their sentence has been transcribed, sometimes imperfectly ("worktri" for worktree, \
a ticket identifier split the wrong way). You pick ONE action from the catalog and fill in its parameters.

Rules:
- Parameters that designate something that exists (folder, agent, mission, screen, project) reuse \
EXACTLY a value from the context. Pick the closest to what was said; if several are \
plausible or none is, don't pick: action null, and ask which one in "say".
- A branch name to create is written in lowercase, with hyphens, no spaces or accents.
- A question about the state of the cockpit (how many agents, how a mission is going): action null, and the \
answer in "say", drawn from the context.
- "Here" is what the person has in front of them. "Here", "this workspace", "this agent", "my PR", \
"the worktree I'm in" (and their equivalents in any language) designate Here, unless they name something else.
- A request for WORK (fix, implement, address a review, run tests, push a \
fix…) is handed to an agent: tell_agent if an agent is open in the target folder (Here by \
default), otherwise launch_agent in that folder. A PR cited by its number is found through its branch in \
the PR list, then in the worktrees and agents. NEVER open a workspace that is already open to \
answer a request for work: it does nothing.
- REVIEWING is not FIXING. "Review / reread / do the code review of PR 2056" → review_pr. \
"X fixed it / pushed their fixes, check it / can I merge" → recheck_pr. But \
"fix / apply the fixes from X's review on MY PR" is work on their own code → \
tell_agent (or launch_agent). review_pr and recheck_pr take care of the worktree and the agent: don't \
precede them with an open_workspace.
- An agent's instruction ("prompt") stands on its own: written in the second person, it restates everything \
useful that was said — PR number, ticket, name of the person who reviewed — and says where to find what's \
needed (for example: read the PR's review comments with gh). Don't invent anything you don't \
know, such as the content of a review: it's up to the agent to go and read it. Write it in the person's language.
- "say": one or two short sentences in the person's language (given at the top of the request), informal \
register (e.g. "tu" in French), in the first person, spoken out loud — no Markdown, no paths, no code. For an action: what you're doing \
("I'm handing Frank's review to the workspace agent."). NEVER announce an action you're not taking: \
without an action, say what you're missing.

Reply with a JSON object alone, no text around it: {"say": string, "action": string | null, "params": object}`;

function lines<T>(items: T[], render: (item: T) => string, empty = "(none)"): string {
	return items.length > 0 ? items.map((item) => `- ${render(item)}`).join("\n") : empty;
}

function hereLines(here: Here | null): string {
	if (!here) return "(no workspace open)";
	return [
		`- workspace: ${here.folder}${here.onScreen ? " (shown on screen)" : " (the last one opened, not on screen)"}`,
		`- branch: ${here.branch ?? "unknown"}`,
		`- foreground agent: ${here.agent ? `${here.agent.id} — ${here.agent.label} — ${here.agent.state}` : "none"}`,
		`- PR for this branch: ${here.pr ? `#${here.pr.number} — ${here.pr.title}` : "none known"}`,
	].join("\n");
}

export function buildPrompt(utterance: string, context: AssistantContext): string {
	return `Language: the person speaks ${languageName()}. Write "say" and any agent "prompt" in ${languageName()}, \
unless the request itself is clearly in another language — then use that one.

Request: "${utterance}"

Current screen: ${context.view}

Here:
${hereLines(context.here)}

Open PRs (number — branch — title — author — requested reviewers — decision):
${lines(context.prs, (pr) => `#${pr.number} — ${pr.branch} — ${pr.title} — ${pr.author} — ${pr.reviewers.join(", ") || "nobody"} — ${pr.review || "none"}`)}

Screens:
${lines(context.views, (view) => `${view.id} — ${view.label}`)}

Projects:
${lines(context.projects, (project) => `${project.name}${project.active ? " (active)" : ""}`)}

Worktrees (folder — branch):
${lines(context.worktrees, (tree) => `${tree.folder} — ${tree.branch ?? "detached"}`)}

Folders (most recent first):
${context.folders.length > 0 ? context.folders.join(", ") : "(none)"}

Open agents (identifier — name — folder — state):
${lines(context.agents, (agent) => `${agent.id} — ${agent.label} — ${agent.folder} — ${agent.state}`)}

Missions (identifier — ticket — title — state):
${lines(context.missions, (mission) => `${mission.id} — ${mission.ticket || "no ticket"} — ${mission.title} — ${mission.state}`)}

Local branches:
${context.branches.length > 0 ? context.branches.join(", ") : "(unknown)"}

Action catalog:
${ACTIONS.map((action) => `- ${action.name}: ${action.description} Parameters: ${JSON.stringify(action.params)}`).join("\n")}`;
}

export interface Decision {
	say: string;
	action: string | null;
	params: Record<string, string>;
}

/** Ce que Claude a répondu, débarrassé de ce qui entoure l'objet JSON. */
export function parseDecision(text: string): Decision | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const raw = JSON.parse(text.slice(start, end + 1)) as Partial<Decision>;
		const action = typeof raw.action === "string" && ACTIONS.some((entry) => entry.name === raw.action) ? raw.action : null;
		const params: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw.params ?? {})) {
			if (typeof value === "string" || typeof value === "number") params[key] = String(value);
		}
		return { say: typeof raw.say === "string" ? raw.say : "", action, params };
	} catch {
		return null;
	}
}

/**
 * Retrouve ce que désigne un nom, sans deviner : exact d'abord (casse et
 * accents mis de côté), puis une seule correspondance partielle. Deux
 * candidats ou aucun, c'est `null` — l'assistant le dira.
 */
export function resolve<T>(wanted: string | undefined, items: T[], names: (item: T) => string[]): T | null {
	if (!wanted?.trim()) return null;
	const norm = (value: string) =>
		value
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.trim();
	const target = norm(wanted);
	const exact = items.filter((item) => names(item).some((name) => norm(name) === target));
	if (exact.length === 1) return exact[0];
	const partial = items.filter((item) => names(item).some((name) => norm(name).includes(target) || target.includes(norm(name))));
	return partial.length === 1 ? partial[0] : null;
}
