import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { isPreview } from "@/lib/preview";
import { useCockpit } from "./store";

/**
 * Ce que l'écran Workspaces montre en ce moment.
 *
 * Agents et terminaux ne sont pas des fenêtres indépendantes : ils appartiennent
 * au worktree sur lequel on travaille. L'écran affiche donc un **groupe** — un
 * dossier, ses agents, ses terminaux — et le quitter les emporte tous ensemble,
 * ce qui correspond à la façon dont on travaille : on ouvre un workspace, on le
 * met de côté, on y revient entier.
 *
 * Cet état vit à part des deux registres qu'il désigne : les agents et les
 * terminaux ont besoin de savoir s'ils sont visibles (pour compter ce qu'on n'a
 * pas lu), sans que l'écran ait à connaître leur cycle de vie.
 */

/**
 * `board` : tout ce qui tient à la branche, en cartes ; `map` : la carte du
 * chantier. Deux onglets sans processus derrière eux.
 */
export type TabKind = "agent" | "terminal" | "map" | "board" | "browser";

export interface TabRef {
	kind: TabKind;
	id: string;
}

interface WorkspaceStore {
	/** Dossier du groupe affiché ; `null` quand le panneau est replié. */
	cwd: string | null;
	/** Onglet retenu pour le groupe affiché — le panneau peut lui substituer
	    le premier onglet disponible si celui-ci a disparu. */
	tab: TabRef | null;
	/**
	 * L'écran Workspaces est-il celui qu'on regarde ?
	 *
	 * Exposé pour que les onglets sachent **quand** ils deviennent lus, et pas
	 * seulement s'ils le sont à l'instant où on le demande : `visible` est une
	 * lecture synchrone, elle ne réveille personne quand la réponse change.
	 */
	onScreen: boolean;
	/** Ouvre un onglet précis, en dépliant son groupe au passage. */
	show: (cwd: string, tab: TabRef) => void;
	/** Rouvre un groupe sur le dernier onglet qu'on y regardait. */
	showGroup: (cwd: string) => void;
	minimize: () => void;
	/**
	 * Lecture synchrone de la visibilité d'un onglet.
	 *
	 * « Visible » veut dire : cet onglet est celui que l'écran Workspaces
	 * montre, **et** l'écran Workspaces est l'écran affiché. Les deux comptent
	 * — un agent qui parle pendant qu'on lit une PR n'est pas lu, et son
	 * compteur de non-lus doit s'incrémenter comme s'il était rangé.
	 *
	 * Les messages d'agents arrivent d'un flux, pas d'un rendu : cette fonction
	 * garde une identité stable et lit une référence, ce qui permet de
	 * l'appeler depuis un abonnement sans le réabonner à chaque changement.
	 */
	visible: (kind: TabKind, id: string) => boolean;
	/** Un onglet a disparu : on oublie ce qu'on retenait de lui. */
	dropped: (kind: TabKind, id: string) => void;
}

const Context = createContext<WorkspaceStore | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
	const { view } = useCockpit();
	// Hors Tauri, l'écran s'ouvre déjà sur le workspace d'exemple : personne ne
	// peut en ouvrir un puisque personne ne lance d'agent.
	const [cwd, setCwd] = useState<string | null>(
		isPreview() ? "/Users/demo/code/fix-cart-rounding-nw-3044" : null,
	);
	// Dernier onglet regardé par groupe : rouvrir un workspace doit retomber sur
	// ce qu'on y faisait, pas sur son premier onglet.
	const [tabs, setTabs] = useState<Record<string, TabRef>>({});

	// Le workspace reste choisi quand on va lire autre chose — il n'est
	// simplement plus à l'écran. La distinction n'existe que pour `visible`.
	const onScreen = view === "workspace";

	const current = useRef<{
		cwd: string | null;
		tabs: Record<string, TabRef>;
		onScreen: boolean;
	}>({ cwd, tabs, onScreen });
	current.current = { cwd, tabs, onScreen };

	const show = useCallback((nextCwd: string, tab: TabRef) => {
		setCwd(nextCwd);
		setTabs((state) => ({ ...state, [nextCwd]: tab }));
	}, []);

	const showGroup = useCallback((nextCwd: string) => setCwd(nextCwd), []);

	const minimize = useCallback(() => setCwd(null), []);

	const visible = useCallback((kind: TabKind, id: string) => {
		const { cwd: openCwd, tabs: remembered, onScreen: shown } = current.current;
		if (!shown || !openCwd) return false;
		const tab = remembered[openCwd];
		return tab?.kind === kind && tab.id === id;
	}, []);

	const dropped = useCallback((kind: TabKind, id: string) => {
		setTabs((state) => {
			const next: Record<string, TabRef> = {};
			let changed = false;
			for (const [key, tab] of Object.entries(state)) {
				if (tab.kind === kind && tab.id === id) {
					changed = true;
					continue;
				}
				next[key] = tab;
			}
			return changed ? next : state;
		});
	}, []);

	const value = useMemo<WorkspaceStore>(
		() => ({
			cwd,
			tab: cwd ? (tabs[cwd] ?? null) : null,
			onScreen,
			show,
			showGroup,
			minimize,
			visible,
			dropped,
		}),
		[cwd, tabs, onScreen, show, showGroup, minimize, visible, dropped],
	);

	return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWorkspace(): WorkspaceStore {
	const store = useContext(Context);
	if (!store) throw new Error("useWorkspace must be used inside WorkspaceProvider");
	return store;
}
