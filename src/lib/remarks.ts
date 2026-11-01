import { useSyncExternalStore } from "react";

/**
 * Des remarques posées sur la carte, envoyées à l'agent d'un seul geste.
 *
 * Piloter depuis le fil oblige à décrire ce dont on parle — « dans le fichier
 * où tu as changé l'arrondi, tout à l'heure » — alors que la carte le montre
 * déjà. Une remarque s'accroche donc à ce qu'on désigne (une étape, un
 * fichier, une zone) et s'écrit en une ligne ; on en pose plusieurs, puis on
 * les envoie ensemble, comme une revue. L'agent reçoit chaque remarque avec ce
 * qu'elle vise, écrit en toutes lettres.
 *
 * Tenu hors de React : une remarque posée sur la carte d'un agent doit se
 * retrouver dans la carte du chantier, et inversement.
 */

export interface Remark {
	id: string;
	runId: string;
	/** Ce que la remarque vise, tel que l'agent le lira : « l'étape … », « `chemin` ». */
	anchor: string;
	text: string;
	at: number;
	/** Ce qu'elle désigne sur une carte (un nœud), pour l'y signaler. */
	target?: string;
}

let remarks: Remark[] = [];
const listeners = new Set<() => void>();
let counter = 0;

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function addRemark(runId: string, anchor: string, text: string, target?: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	remarks = [...remarks, { id: `remark-${++counter}`, runId, anchor, text: trimmed, at: Date.now(), target }];
	emit();
}

export function removeRemark(id: string): void {
	remarks = remarks.filter((remark) => remark.id !== id);
	emit();
}

/** Retire les remarques d'un agent — une fois envoyées, ou abandonnées. */
export function clearRemarks(runId: string): void {
	remarks = remarks.filter((remark) => remark.runId !== runId);
	emit();
}

export function useAllRemarks(): Remark[] {
	return useSyncExternalStore(subscribe, () => remarks);
}

/** Le message qui part : chaque remarque avec ce qu'elle vise. */
export function composeRemarks(list: Remark[]): string {
	if (list.length === 1) {
		const [only] = list;
		return `À propos de ${only.anchor} : ${only.text}`;
	}
	const lines = list.map((remark, index) => `${index + 1}. À propos de ${remark.anchor} : ${remark.text}`);
	return `Quelques remarques sur ton travail :\n\n${lines.join("\n")}\n\nTiens-en compte pour la suite ; dis-moi si l'une d'elles te paraît fausse.`;
}
