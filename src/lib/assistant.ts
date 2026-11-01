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

const MODIFIERS: Record<string, string> = { control: "⌃", ctrl: "⌃", alt: "⌥", option: "⌥", shift: "⇧", super: "⌘", cmd: "⌘", command: "⌘" };

/** `control+alt+KeyJ` → « ⌃⌥ J », `alt+Space` → « ⌥ Espace ». */
export function shortcutLabel(accelerator: string): string {
	const parts = accelerator.split("+").filter(Boolean);
	const key = parts.pop() ?? "";
	const mods = parts.map((part) => MODIFIERS[part.toLowerCase()] ?? part).join("");
	const name =
		key === "Space"
			? "Espace"
			: key.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "Flèche ").replace("Backquote", "`");
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
	{ name: "go_to", description: "Afficher un écran du cockpit.", params: { view: "identifiant d'écran, tel que listé" } },
	{ name: "switch_project", description: "Changer de projet actif.", params: { project: "nom du projet, tel que listé" } },
	{
		name: "open_workspace",
		description: "Ouvrir le workspace d'un dossier : ses agents et terminaux.",
		params: { folder: "nom de dossier d'un worktree ou d'un agent, tel que listé" },
	},
	{
		name: "open_worktree",
		description: "Afficher un worktree dans l'écran Worktrees.",
		params: { folder: "nom de dossier du worktree, tel que listé" },
	},
	{
		name: "start_mission",
		description:
			"Créer une mission à partir d'un ticket (Linear ou autre) et lancer son agent maître. Si une mission existe déjà sur ce ticket, elle est rouverte.",
		params: { ticket: "identifiant du ticket (ex. NW-3050) ou son adresse" },
	},
	{ name: "open_mission", description: "Afficher une mission existante.", params: { mission: "identifiant de mission, tel que listé" } },
	{
		name: "create_branch",
		description: "Créer une branche git dans le dépôt principal, sans la sortir.",
		params: {
			name: "nom de branche git valide (ex. fix/cart-rounding), sans espace ni accent",
			base: "branche de départ, facultative (par défaut la branche d'intégration)",
		},
	},
	{
		name: "create_worktree",
		description: "Créer un worktree pour une branche, avec la commande de l'équipe.",
		params: { branch: "nom de la branche" },
	},
	{
		name: "review_pr",
		description:
			"Faire relire une PR par un agent en lecture seule (code review complète) : le cockpit met sa branche à jour, ouvre ou crée son worktree, lance l'agent avec la consigne de revue, et range les points relevés. Pour une PR que la personne RELIT — en général celle de quelqu'un d'autre.",
		params: { pr: "numéro de la PR, tel que listé — facultatif : vide = la PR d'Ici" },
	},
	{
		name: "recheck_pr",
		description:
			"Vérifier les corrections poussées sur une PR déjà relue : l'agent vérifie chaque point de la revue précédente, relit ce qui a changé, et dit si on peut fusionner.",
		params: { pr: "numéro de la PR, tel que listé — facultatif : vide = la PR d'Ici" },
	},
	{
		name: "tell_agent",
		description:
			"Confier un travail à un agent déjà ouvert : lui envoyer une consigne. Par défaut, l'agent d'Ici. S'il n'y a pas d'agent vivant dans ce dossier, le cockpit en lance un avec la consigne.",
		params: {
			agent: "identifiant d'agent, tel que listé — facultatif : vide = l'agent d'Ici",
			prompt: "la consigne complète, écrite pour l'agent (voir les règles)",
		},
	},
	{
		name: "launch_agent",
		description:
			"Lancer un NOUVEL agent dans un dossier — un worktree, un dépôt, n'importe quel dossier listé — sans créer de branche ni de worktree, et ouvrir son workspace. Avec une consigne si la personne en donne une.",
		params: {
			folder: "nom de dossier, tel que listé dans Dossiers ou Worktrees — facultatif : vide = le dossier d'Ici",
			prompt: "la consigne à donner à l'agent, facultative",
		},
	},
	{ name: "git_pull", description: "Faire un pull sur un worktree.", params: { folder: "nom de dossier du worktree" } },
	{ name: "git_push", description: "Pousser la branche d'un worktree.", params: { folder: "nom de dossier du worktree" } },
	{
		name: "listen_agent",
		description: "Raconter à voix haute ce que fait un agent ouvert.",
		params: { agent: "identifiant d'agent, tel que listé" },
	},
	{ name: "stop_listening", description: "Arrêter de raconter ce que fait un agent.", params: {} },
	{
		name: "visit_changes",
		description: "Ouvrir la visite guidée des changements d'un agent.",
		params: { agent: "identifiant d'agent, tel que listé" },
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

export const SYSTEM = `Tu es l'assistant vocal de Cockpit, un poste de pilotage d'agents de code. \
La personne te parle ; sa phrase a été transcrite, parfois imparfaitement (« worktri » pour worktree, \
un identifiant de ticket mal découpé). Tu choisis UNE action du catalogue et tu en remplis les paramètres.

Règles :
- Les paramètres qui désignent quelque chose d'existant (dossier, agent, mission, écran, projet) reprennent \
EXACTEMENT une valeur du contexte. Choisis la plus proche de ce qui a été dit ; s'il y en a plusieurs \
plausibles ou aucune, ne choisis pas : action null, et demande laquelle dans "say".
- Un nom de branche à créer s'écrit en minuscules, avec des tirets, sans espace ni accent.
- Une question sur l'état du cockpit (combien d'agents, où en est une mission) : action null, et la \
réponse dans "say", tirée du contexte.
- « Ici » est ce que la personne a sous les yeux. « Ici », « ce workspace », « cet agent », « ma PR », \
« le worktree où je suis » désignent Ici, sauf si elle nomme autre chose.
- Une demande de TRAVAIL (corriger, implémenter, traiter une review, lancer des tests, pousser un \
correctif…) se confie à un agent : tell_agent si un agent est ouvert dans le dossier visé (Ici par \
défaut), sinon launch_agent dans ce dossier. Une PR citée par son numéro se retrouve par sa branche dans \
la liste des PR, puis dans les worktrees et les agents. N'ouvre JAMAIS un workspace déjà ouvert pour \
répondre à une demande de travail : ça ne fait rien.
- RELIRE n'est pas CORRIGER. « Fais-moi la review / relis / code review de la PR 2056 » → review_pr. \
« X a corrigé / a poussé ses corrections, vérifie / est-ce que je peux merger » → recheck_pr. Mais \
« corrige / fais les corrections de la review de X sur MA PR » est un travail sur son propre code → \
tell_agent (ou launch_agent). review_pr et recheck_pr se chargent du worktree et de l'agent : ne les \
fais pas précéder d'un open_workspace.
- La consigne ("prompt") d'un agent est autonome : écrite à la deuxième personne, elle reprend tout ce \
qui a été dit d'utile — numéro de PR, ticket, nom de la personne qui a relu — et dit où trouver ce qu'il \
faut (par exemple : lire les commentaires de review de la PR avec gh). N'invente rien de ce que tu ne \
sais pas, comme le contenu d'une review : c'est à l'agent d'aller le lire.
- "say" : une ou deux phrases courtes en français, tutoiement, à la première personne, dites à voix \
haute — pas de Markdown, pas de chemin, pas de code. Pour une action : ce que tu fais (« Je confie la \
review de Frank à l'agent du workspace. »). N'annonce JAMAIS une action que tu ne fais pas : sans \
action, dis ce qui te manque.

Réponds par un objet JSON seul, sans texte autour : {"say": string, "action": string | null, "params": object}`;

function lines<T>(items: T[], render: (item: T) => string, empty = "(aucun)"): string {
	return items.length > 0 ? items.map((item) => `- ${render(item)}`).join("\n") : empty;
}

function hereLines(here: Here | null): string {
	if (!here) return "(aucun workspace ouvert)";
	return [
		`- workspace : ${here.folder}${here.onScreen ? " (affiché à l'écran)" : " (le dernier ouvert, pas à l'écran)"}`,
		`- branche : ${here.branch ?? "inconnue"}`,
		`- agent au premier plan : ${here.agent ? `${here.agent.id} — ${here.agent.label} — ${here.agent.state}` : "aucun"}`,
		`- PR de cette branche : ${here.pr ? `#${here.pr.number} — ${here.pr.title}` : "aucune connue"}`,
	].join("\n");
}

export function buildPrompt(utterance: string, context: AssistantContext): string {
	return `Demande : « ${utterance} »

Écran actuel : ${context.view}

Ici :
${hereLines(context.here)}

PR ouvertes (numéro — branche — titre — auteur — relecteurs demandés — décision) :
${lines(context.prs, (pr) => `#${pr.number} — ${pr.branch} — ${pr.title} — ${pr.author} — ${pr.reviewers.join(", ") || "personne"} — ${pr.review || "aucune"}`)}

Écrans :
${lines(context.views, (view) => `${view.id} — ${view.label}`)}

Projets :
${lines(context.projects, (project) => `${project.name}${project.active ? " (actif)" : ""}`)}

Worktrees (dossier — branche) :
${lines(context.worktrees, (tree) => `${tree.folder} — ${tree.branch ?? "détachée"}`)}

Dossiers (récents d'abord) :
${context.folders.length > 0 ? context.folders.join(", ") : "(aucun)"}

Agents ouverts (identifiant — nom — dossier — état) :
${lines(context.agents, (agent) => `${agent.id} — ${agent.label} — ${agent.folder} — ${agent.state}`)}

Missions (identifiant — ticket — titre — état) :
${lines(context.missions, (mission) => `${mission.id} — ${mission.ticket || "sans ticket"} — ${mission.title} — ${mission.state}`)}

Branches locales :
${context.branches.length > 0 ? context.branches.join(", ") : "(inconnues)"}

Catalogue d'actions :
${ACTIONS.map((action) => `- ${action.name} : ${action.description} Paramètres : ${JSON.stringify(action.params)}`).join("\n")}`;
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
