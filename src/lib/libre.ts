import { useSyncExternalStore } from "react";

/**
 * Les agents libres : un dossier, un agent, rien d'autre.
 *
 * Ce qu'on faisait au terminal — `cd ~/Sites/x` puis `claude` — sans passer
 * par un chantier ni une mission. Leurs conversations vivent dans le même
 * registre que toutes les autres (`agents.tsx`) : mêmes autorisations, mêmes
 * questions, même relais à la fermeture. Ce qui les distingue tient ici, à
 * part : la liste de ceux qu'on a lancés ainsi, ce qu'on avait choisi pour les
 * lancer, et ce qu'on retient pour la prochaine fois dans le même dossier.
 *
 * Tenu à part plutôt que dans l'état des agents, parce que l'écran Workspaces
 * se construit à partir des conversations ouvertes : c'est ce registre qui lui
 * dit lesquelles ne sont pas à lui — y compris après un redémarrage, quand une
 * conversation revient de son relais sans rien savoir de la façon dont elle
 * avait été lancée.
 */

export type LibrePlace = "ici" | "branche" | "worktree";

export interface LibreAgent {
	/** Identifiant du registre, stable d'un lancement de l'app à l'autre. */
	id: string;
	/** La conversation ouverte en ce moment ; `null` une fois fermée. */
	runId: string | null;
	sessionId: string | null;
	/** Ce qui permet de reprendre le fil, même des jours plus tard. */
	claudeSessionId: string | null;
	/** Le dossier choisi. */
	folder: string;
	/** Celui où il travaille vraiment — le worktree, s'il en a un. */
	cwd: string;
	place: LibrePlace;
	branch: string;
	/** Worktree créé pour lui ; vide s'il travaille sur place. */
	worktree: string;
	model: string;
	account: string;
	mode: string;
	depth: string;
	label: string;
	createdAt: number;
	archivedAt: number | null;
}

/** Ce qu'on retient d'un lancement pour le suivant, dans le même dossier. */
export interface LibreChoices {
	place: LibrePlace;
	model: string;
	account: string;
	mode: string;
	depth: string;
}

const KEY = "cockpit.libres";
const CHOICES_KEY = "cockpit.libres.choix";
// Les archivés restent consultables un temps, pas pour toujours.
const KEEP_ARCHIVED = 40;

const listeners = new Set<() => void>();

function read<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Stockage indisponible : la liste tient jusqu'à la fermeture.
	}
}

// Les identifiants de conversation ne survivent pas à un redémarrage : « run-3 »
// désignera bientôt un autre agent, peut-être celui d'un workspace. On n'en
// garde que la session, par laquelle un agent revenu de son relais se reconnaît.
let agents: LibreAgent[] = read<LibreAgent[]>(KEY, []).map((agent) => ({ ...agent, runId: null }));
let selected: string | null = null;
let launcher: { open: boolean; folder: string } = { open: false, folder: "" };
let onScreen = false;

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function save(next: LibreAgent[]): void {
	const live = next.filter((agent) => !agent.archivedAt);
	const archived = next
		.filter((agent) => agent.archivedAt)
		.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
		.slice(0, KEEP_ARCHIVED);
	agents = [...live, ...archived];
	write(KEY, agents);
	emit();
}

export function useLibres(): LibreAgent[] {
	return useSyncExternalStore(subscribe, () => agents);
}

export function libres(): LibreAgent[] {
	return agents;
}

export function addLibre(agent: Omit<LibreAgent, "id" | "createdAt" | "archivedAt">): LibreAgent {
	const created: LibreAgent = {
		...agent,
		id: `libre-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		createdAt: Date.now(),
		archivedAt: null,
	};
	save([created, ...agents]);
	return created;
}

export function patchLibre(id: string, patch: Partial<LibreAgent>): void {
	let changed = false;
	const next = agents.map((agent) => {
		if (agent.id !== id) return agent;
		const merged = { ...agent, ...patch };
		if ((Object.keys(patch) as Array<keyof LibreAgent>).some((key) => agent[key] !== merged[key])) {
			changed = true;
			return merged;
		}
		return agent;
	});
	if (changed) save(next);
}

/** L'agent libre derrière une conversation, s'il y en a un. */
export function libreOf(run: {
	id: string;
	sessionId: string | null;
	claudeSessionId: string | null;
}): LibreAgent | null {
	return (
		agents.find(
			(agent) =>
				!agent.archivedAt &&
				(agent.runId === run.id ||
					(run.sessionId !== null && agent.sessionId === run.sessionId) ||
					(run.claudeSessionId !== null && agent.claudeSessionId === run.claudeSessionId)),
		) ?? null
	);
}

/** Une conversation qui n'appartient pas à l'écran Workspaces. */
export function isLibreRun(run: {
	id: string;
	free?: boolean;
	sessionId: string | null;
	claudeSessionId: string | null;
}): boolean {
	return Boolean(run.free) || libreOf(run) !== null;
}

// ── Ce qu'on retient par dossier ────────────────────────────────────────

export function lastChoices(folder: string): LibreChoices | null {
	return read<Record<string, LibreChoices>>(CHOICES_KEY, {})[folder] ?? null;
}

export function rememberChoices(folder: string, choices: LibreChoices): void {
	const all = read<Record<string, LibreChoices>>(CHOICES_KEY, {});
	write(CHOICES_KEY, { ...all, [folder]: choices });
}

/** Les dossiers où l'on a déjà lancé un agent libre, du plus récent au plus ancien. */
export function libreFolders(): Array<{ folder: string; choices: LibreChoices | null; at: number }> {
	const seen = new Map<string, number>();
	for (const agent of agents) {
		seen.set(agent.folder, Math.max(seen.get(agent.folder) ?? 0, agent.createdAt));
	}
	return [...seen.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([folder, at]) => ({ folder, choices: lastChoices(folder), at }));
}

// ── L'agent qu'on regarde, et le lanceur ────────────────────────────────

export function selectLibre(id: string | null): void {
	if (selected === id) return;
	selected = id;
	emit();
}

export function useSelectedLibre(): string | null {
	return useSyncExternalStore(subscribe, () => selected);
}

/** L'écran Agents libres le dit quand il est affiché : ce qu'il montre est lu. */
export function setLibresOnScreen(value: boolean): void {
	onScreen = value;
}

/** Cette conversation est-elle celle que l'écran Agents libres montre ? */
export function libreVisible(runId: string): boolean {
	if (!onScreen || !selected) return false;
	return agents.find((agent) => agent.id === selected)?.runId === runId;
}

export function openLauncher(folder = ""): void {
	launcher = { open: true, folder };
	emit();
}

export function closeLauncher(): void {
	launcher = { open: false, folder: "" };
	emit();
}

export function useLauncher(): { open: boolean; folder: string } {
	return useSyncExternalStore(subscribe, () => launcher);
}

// ── Ce que Cockpit lance, écrit comme on l'aurait tapé ──────────────────

function quote(value: string): string {
	return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Ramène le dossier personnel à `~`, comme dans un terminal. */
export function tilde(path: string, home: string): string {
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * La ligne de commande équivalente : ce que le lanceur s'apprête à faire, dans
 * les mots du terminal. Rien de ce que Cockpit lance ne doit être caché.
 */
export function equivalentCommand(options: {
	folder: string;
	place: LibrePlace;
	branch: string;
	worktree: string;
	model: string;
	mode: string;
	accountDir: string;
}): string[] {
	const env = options.accountDir ? `CLAUDE_CONFIG_DIR=${quote(options.accountDir)} ` : "";
	const flags = [
		options.model ? `--model ${quote(options.model)}` : "",
		options.mode && options.mode !== "default" ? `--permission-mode ${options.mode}` : "",
	]
		.filter(Boolean)
		.join(" ");
	const claude = `${env}claude${flags ? ` ${flags}` : ""}`;
	if (options.place === "branche") {
		return [`cd ${quote(options.folder)} && git switch -c ${quote(options.branch)}`, claude];
	}
	if (options.place === "worktree") {
		return [
			`git -C ${quote(options.folder)} worktree add -b ${quote(options.branch)} ${quote(options.worktree)}`,
			`cd ${quote(options.worktree)} && ${claude}`,
		];
	}
	return [`cd ${quote(options.folder)}`, claude];
}

/** Une branche neuve, datée : `agent/22-10-0915`. Renommée d'après la consigne, si elle en a une. */
export function defaultBranch(prompt = "", date = new Date()): string {
	const words = prompt
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter((word) => word.length > 2)
		.slice(0, 4);
	if (words.length > 0) return `agent/${words.join("-")}`;
	const pad = (value: number) => String(value).padStart(2, "0");
	return `agent/${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
