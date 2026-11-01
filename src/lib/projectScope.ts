import { useSyncExternalStore } from "react";

/**
 * Le projet affiché, réduit à un compteur.
 *
 * Presque tout ce que le cockpit montre dépend du projet actif — worktrees,
 * pull requests, incidents, missions. Chaque écran charge pourtant ses données
 * de son côté, avec son propre sondage : changer de projet ne les prévenait
 * pas, et l'on continuait de lire les worktrees d'un dépôt et les incidents
 * d'un autre, parfois trois minutes durant.
 *
 * Plutôt que d'ajouter la dépendance à la quarantaine d'appels concernés — où
 * l'oubli d'un seul recrée le défaut — ce compteur vit à part et `useAsync` le
 * lit pour tout le monde. Il est délibérément hors du store : celui-ci dépend
 * de `useAsync`, l'inverse tournerait en rond.
 */

let epoch = 0;
const listeners = new Set<() => void>();

/** Le projet a changé : tout ce qui en dépend doit être relu. */
export function bumpProjectEpoch(): void {
	epoch += 1;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useProjectEpoch(): number {
	return useSyncExternalStore(subscribe, () => epoch, () => epoch);
}
