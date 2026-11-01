import type { Node, NodeChange } from "@xyflow/react";
import { useCallback, useState } from "react";

type Size = { width: number; height: number };

/**
 * Les tailles que React Flow mesure, rendues aux nœuds à chaque mise à jour.
 *
 * Un graphe qui se redessine à chaque événement — la carte d'un agent, le
 * graphe d'une mission en cours — reconstruit ses nœuds, et React Flow efface
 * alors la mesure de chacun : un nœud sans mesure est rendu invisible jusqu'à
 * ce qu'il soit remesuré. Or la remesure ne se relance que si l'état « mesuré »
 * du nœud a changé entre deux rendus. Sous une rafale d'événements, il restait
 * « non mesuré » de bout en bout : plus rien ne relançait la mesure, et la
 * carte restait vide jusqu'à ce qu'on la remonte (recharger, passer par le
 * fil). Reproduit : 120 événements en quelques secondes, treize cartes sur
 * treize invisibles pour de bon.
 *
 * C'est l'usage prévu de React Flow en mode contrôlé : récupérer les
 * changements de dimensions par `onNodesChange` et les reporter sur les
 * nœuds. Un nœud garde alors sa taille d'une mise à jour à l'autre, et n'est
 * plus jamais caché une fois mesuré.
 */
export function useNodeSizes<T extends Node>() {
	const [sizes, setSizes] = useState<Map<string, Size>>(() => new Map());

	const onNodesChange = useCallback((changes: NodeChange<T>[]) => {
		setSizes((current) => {
			let next: Map<string, Size> | null = null;
			for (const change of changes) {
				if (change.type !== "dimensions" || !change.dimensions) continue;
				const known = (next ?? current).get(change.id);
				const { width, height } = change.dimensions;
				if (known && known.width === width && known.height === height) continue;
				next ??= new Map(current);
				next.set(change.id, { width, height });
			}
			return next ?? current;
		});
	}, []);

	const withSizes = useCallback(
		(nodes: T[]): T[] =>
			nodes.map((node) => {
				const measured = sizes.get(node.id);
				return measured ? { ...node, measured } : node;
			}),
		[sizes],
	);

	return { onNodesChange, withSizes, sizes };
}
