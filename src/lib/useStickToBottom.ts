import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Garde un conteneur collé en bas tant que l'utilisateur n'a pas remonté.
 *
 * C'est le comportement attendu d'un flux qui s'écrit tout seul — journal de
 * job, timeline d'un agent : on veut voir arriver la suite sans rien faire,
 * mais remonter dans l'historique ne doit pas être interrompu par un
 * défilement automatique à la ligne suivante. Redescendre en bas réarme le
 * suivi.
 *
 * Le décrochage se juge sur le déplacement, jamais sur la distance au bas.
 * Mesurer la distance paraît plus simple, mais c'est faux dès que la sortie est
 * rapide : le recalage écrit `scrollTop`, l'événement `scroll` qui en découle
 * n'est distribué qu'au tour suivant, et d'ici là de nouvelles lignes ont
 * grandi le conteneur. La distance au bas est alors énorme alors que personne
 * n'a touché à rien — et le suivi s'arrêtait tout seul au bout d'une seconde de
 * `pnpm dev`. Un contenu qui s'ajoute ne bouge pas `scrollTop` ; une main qui
 * remonte, si.
 *
 * `deps` déclenche le recalage : y passer ce qui fait grandir le contenu.
 */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[]) {
	const ref = useRef<T>(null);
	const [stuck, setStuck] = useState(true);
	/** Dernière position imposée par le suivi, référence du déplacement. */
	const anchor = useRef(0);

	// Avant peinture : le conteneur vient de grandir, le recaler après laisserait
	// voir une image intermédiaire à l'ancienne position.
	useLayoutEffect(() => {
		if (!stuck) return;
		const node = ref.current;
		if (!node) return;
		node.scrollTop = node.scrollHeight;
		anchor.current = node.scrollTop;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, stuck]);

	const onScroll = useCallback(
		(event: React.UIEvent<T>) => {
			const node = event.currentTarget;
			// Marge de 32 px : un scroll inertiel s'arrête rarement au pixel près.
			const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 32;

			if (stuck) {
				// Le seuil de 2 px absorbe les positions fractionnaires des écrans
				// à haute densité, où `scrollTop` n'est pas un entier.
				if (!atBottom && node.scrollTop < anchor.current - 2) setStuck(false);
				return;
			}
			if (atBottom) setStuck(true);
		},
		[stuck],
	);

	return { ref, stuck, onScroll };
}
