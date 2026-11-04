import { useSyncExternalStore } from "react";

/**
 * Ce qu'on a retiré à la main du bandeau « ça t'attend ».
 *
 * Le bandeau lit les conversations de tout le poste, y compris celles qu'on a
 * lâchées exprès : une question laissée sans réponse dans un autre dossier y
 * restait vingt-quatre heures, sans qu'on puisse rien y faire sinon effacer la
 * conversation elle-même. La croix retient seulement « vu, pas maintenant ».
 *
 * On retient l'empreinte de ce qu'on a écarté, pas l'élément : une session qui
 * reparle, une PR qui reçoit un nouveau commit change d'empreinte et revient
 * d'elle-même. Écarter ne fait taire que l'état qu'on avait sous les yeux.
 */

const KEY = "cockpit.blockers.dismissed";
// Les clés s'accumulent au fil des sessions : on garde les plus récentes.
const KEEP = 200;

type Dismissed = Record<string, string>;

const listeners = new Set<() => void>();

function read(): Dismissed {
	try {
		const raw = localStorage.getItem(KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : {};
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Dismissed) : {};
	} catch {
		return {};
	}
}

let dismissed = read();

export function dismiss(key: string, stamp: string): void {
	const next: Dismissed = { ...dismissed };
	delete next[key];
	next[key] = stamp;
	const keys = Object.keys(next);
	for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[old];
	dismissed = next;
	try {
		localStorage.setItem(KEY, JSON.stringify(dismissed));
	} catch {
		// Stockage indisponible : l'élément reste écarté jusqu'à la fermeture.
	}
	for (const listener of listeners) listener();
}

/** Vrai tant que l'élément n'a pas changé depuis qu'on l'a écarté. */
export function isDismissed(map: Dismissed, key: string, stamp: string): boolean {
	return map[key] === stamp;
}

export function useDismissed(): Dismissed {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => dismissed,
	);
}
