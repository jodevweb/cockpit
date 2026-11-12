/**
 * « Ceci vient de changer » — dit une fois, entendu partout.
 *
 * Un même objet s'affiche à plusieurs endroits : un ticket dans sa fiche et dans
 * la liste qui l'a ouverte, sur la carte, sur l'accueil. Quand on le modifie
 * depuis l'un d'eux, seul celui-là se rechargeait : on passait un ticket en
 * revue, sa fiche l'affichait, et la liste juste à côté continuait d'annoncer
 * l'état d'avant. On finissait par douter de ce qu'on venait de faire.
 *
 * Deux raisons à cela, et il faut traiter les deux. Les écrans ne se parlent pas
 * — d'où cette annonce. Et le cockpit garde en mémoire les réponses des services
 * quelques secondes, pour ne pas les marteler : une liste rechargée dans la
 * foulée d'une modification relit donc la version périmée. `announceChange` vide
 * cette mémoire avant de prévenir, sans quoi tout le monde se rafraîchirait pour
 * rien.
 *
 * Volontairement minuscule : un événement du navigateur, pas un gestionnaire
 * d'état. Ce qui circule ici, c'est un signal — « va revoir » — et non la donnée
 * elle-même, que chaque écran sait déjà aller chercher.
 */

import { api } from "@/lib/ipc";

/** Ce dont on annonce le changement. */
export type ChangeTopic = "tickets" | "prs" | "missions" | "issues";

const EVENT = "cockpit:changed";

/**
 * Annonce qu'un objet a changé, après avoir vidé la mémoire courte des services.
 *
 * L'attente sur `invalidate` est volontaire : prévenir d'abord ferait recharger
 * les écrans avant que le cache ne soit vide, et ils reliraient l'ancienne
 * réponse — le bug qu'on cherche précisément à corriger.
 */
export async function announceChange(topic: ChangeTopic): Promise<void> {
	try {
		await api.feeds.invalidate();
	} catch {
		// Le cache est un confort : son échec ne doit pas empêcher l'annonce.
	}
	window.dispatchEvent(new CustomEvent(EVENT, { detail: topic }));
}

/**
 * S'abonne aux annonces d'un sujet. Rend la fonction de désabonnement, ce qui en
 * fait un `subscribe` utilisable tel quel par `useAsync`.
 */
export function onChange(topic: ChangeTopic, handler: () => void): () => void {
	const listener = (event: Event) => {
		if ((event as CustomEvent<ChangeTopic>).detail === topic) handler();
	};
	window.addEventListener(EVENT, listener);
	return () => window.removeEventListener(EVENT, listener);
}
