import { useSyncExternalStore } from "react";

/**
 * Quand on a regardé le récap pour la dernière fois.
 *
 * L'onglet du haut compte ce qui s'est terminé depuis : c'est ce qui donne
 * envie d'y aller, plutôt qu'un écran qu'on doit penser à chercher. Gardé hors
 * de React, comme la visionneuse : l'écran le pose, l'onglet le lit.
 */

const KEY = "recap.seenAt";
const listeners = new Set<() => void>();

function read(): number {
	try {
		return Number(localStorage.getItem(KEY)) || 0;
	} catch {
		return 0;
	}
}

let seenAt = read();

export function markRecapSeen(): void {
	seenAt = Date.now();
	try {
		localStorage.setItem(KEY, String(seenAt));
	} catch {
		// Stockage indisponible : l'onglet recomptera depuis le lancement.
	}
	for (const listener of listeners) listener();
}

export function useRecapSeen(): number {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => seenAt,
	);
}
