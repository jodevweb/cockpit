import { useSyncExternalStore } from "react";

/**
 * Ce que le cockpit est en train de faire pour toi, en arrière-plan.
 *
 * Beaucoup de gestes ne finissent pas tout de suite : créer un worktree prend
 * des minutes, une revue tourne le temps qu'un agent lise la PR, une mission
 * démarre son maître. L'assistant vocal disait « je lance la revue », puis
 * plus rien : le travail avait bien lieu, mais nulle part on ne le voyait, ni
 * ne savait s'il avait abouti.
 *
 * Chaque geste long ouvre ici une activité : un titre, les étapes qu'il
 * franchit, et son issue — réussie, avec de quoi aller voir le résultat, ou
 * ratée, avec la raison en clair. Le panneau (`ActivityCenter`) la montre tant
 * qu'elle tourne.
 *
 * Tenu hors de React : les gestes partent de partout — un hook, un module de
 * flux, l'assistant — et doivent pouvoir s'annoncer sans passer par un
 * contexte.
 */

export interface ActivityStep {
	text: string;
	at: number;
}

export interface ActivityAction {
	label: string;
	run: () => void;
}

export interface Activity {
	id: string;
	title: string;
	steps: ActivityStep[];
	state: "running" | "done" | "failed";
	startedAt: number;
	endedAt: number | null;
	/** Ce qui a été obtenu, ou la raison de l'échec. */
	result: string | null;
	/** Où aller voir le résultat. */
	action: ActivityAction | null;
}

export interface ActivityHandle {
	id: string;
	step: (text: string) => void;
	done: (result?: string, action?: ActivityAction) => void;
	fail: (error: unknown) => void;
	/** Vrai tant que l'activité n'est ni réussie, ni ratée, ni écartée. */
	alive: () => boolean;
}

let activities: Activity[] = [];
/** Le panneau replié par la personne ; une nouvelle activité le rouvre. */
let collapsed = false;
/** Ouvert à la main depuis la pastille, même sans action du cockpit en cours. */
let manual = false;
const listeners = new Set<() => void>();
let counter = 0;
let snapshot = { activities, collapsed, manual };

function emit() {
	snapshot = { activities, collapsed, manual };
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function update(id: string, change: (activity: Activity) => Activity) {
	activities = activities.map((activity) => (activity.id === id ? change(activity) : activity));
	emit();
}

/** Une réussite s'efface d'elle-même ; un échec reste jusqu'à ce qu'on l'écarte. */
const DONE_LINGER_MS = 12_000;

function clean(message: unknown): string {
	const text = message instanceof Error ? message.message : String(message);
	return text.replace(/^(Ipc)?Error:\s*/, "").trim() || "Échec sans explication.";
}

export function startActivity(title: string, firstStep?: string): ActivityHandle {
	const id = `activity-${++counter}`;
	const now = Date.now();
	activities = [
		{
			id,
			title,
			steps: firstStep ? [{ text: firstStep, at: now }] : [],
			state: "running" as const,
			startedAt: now,
			endedAt: null,
			result: null,
			action: null,
		},
		...activities,
	].slice(0, 30);
	// Quelque chose commence : on le montre, même si le panneau était replié.
	collapsed = false;
	emit();

	const alive = () => activities.some((activity) => activity.id === id && activity.state === "running");
	return {
		id,
		alive,
		step: (text) => {
			if (!alive()) return;
			update(id, (activity) => ({ ...activity, steps: [...activity.steps, { text, at: Date.now() }] }));
		},
		done: (result, action) => {
			if (!alive()) return;
			update(id, (activity) => ({
				...activity,
				state: "done",
				endedAt: Date.now(),
				result: result ?? null,
				action: action ?? null,
			}));
			window.setTimeout(() => dismissActivity(id), DONE_LINGER_MS);
		},
		fail: (error) => {
			if (!alive()) return;
			update(id, (activity) => ({ ...activity, state: "failed", endedAt: Date.now(), result: clean(error) }));
		},
	};
}

/**
 * Mène une tâche en l'annonçant : elle réussit avec ce qu'elle rend, ou échoue
 * avec sa raison. L'erreur est relancée, pour que l'appelant garde la main.
 */
export async function withActivity<T>(
	title: string,
	task: (activity: ActivityHandle) => Promise<T>,
	options: { firstStep?: string; result?: (value: T) => string | undefined; action?: (value: T) => ActivityAction | undefined } = {},
): Promise<T> {
	const activity = startActivity(title, options.firstStep);
	try {
		const value = await task(activity);
		activity.done(options.result?.(value), options.action?.(value));
		return value;
	} catch (error) {
		activity.fail(error);
		throw error;
	}
}

export function dismissActivity(id: string): void {
	activities = activities.filter((activity) => activity.id !== id);
	emit();
}

export function setActivitiesCollapsed(value: boolean): void {
	collapsed = value;
	if (value) manual = false;
	emit();
}

/** Ouvre le panneau depuis la pastille, qu'une action du cockpit tourne ou non. */
export function openActivities(): void {
	collapsed = false;
	manual = true;
	emit();
}

export function useActivities(): { activities: Activity[]; collapsed: boolean; manual: boolean } {
	return useSyncExternalStore(subscribe, () => snapshot);
}
