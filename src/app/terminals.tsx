import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { isMac } from "@/lib/platform";
import "@xterm/xterm/css/xterm.css";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { api, events } from "@/lib/ipc";
import { useCockpit } from "./store";
import { useWorkspace } from "./workspace";
import { t } from "@/i18n";

/**
 * Terminaux intégrés du panneau de travail.
 *
 * Un terminal est un shell derrière un vrai PTY : il survit à l'onglet qui le
 * montre, comme un agent survit à sa conversation. L'émulateur, lui, est un
 * objet du DOM qu'on ne peut pas recréer à chaque affichage sans perdre tout ce
 * qui a défilé — on garde donc chaque instance vivante hors écran et on la
 * déplace dans le panneau quand son onglet passe au premier plan.
 */

export interface TerminalTab {
	id: string;
	cwd: string;
	label: string;
	running: boolean;
	exitCode: number | null;
	/** Sortie arrivée pendant que le panneau montrait autre chose. */
	unread: boolean;
}

/**
 * Les commandes du registre, à l'identité stable — voir `AgentActions` : la
 * liste des onglets change (pastille de sortie non lue, shell qui se termine)
 * sans que ceux qui se contentent d'ouvrir un terminal aient à en tenir compte.
 */
interface TerminalActions {
	/**
	 * Ouvre un shell dans `cwd`, éventuellement sur une commande déjà tapée.
	 *
	 * `account` force le compte du shell — les réglages s'en servent pour ouvrir
	 * une connexion sur un compte qu'aucun projet n'utilise encore. Absent, c'est
	 * celui du projet ouvert.
	 */
	open: (
		cwd: string,
		/** `background` : le shell s'ouvre sans prendre la vue. */
		options?: { command?: string; label?: string; account?: string; background?: boolean },
	) => void;
	/** Ferme le shell et sa descendance. */
	close: (id: string) => void;
	/** ⌃C, pour arrêter ce qui tourne sans fermer l'onglet. */
	interrupt: (id: string) => void;
	/** Tape une commande dans le shell ; `execute` la valide par un retour. */
	run: (id: string, line: string, execute: boolean) => void;
	clear: (id: string) => void;
	/** Fait entrer l'émulateur dans le panneau, et l'en retire. */
	attach: (id: string, container: HTMLElement) => void;
	detach: (id: string) => void;
}

interface TerminalsStore extends TerminalActions {
	tabs: TerminalTab[];
}

const ActionsContext = createContext<TerminalActions | null>(null);
const TabsContext = createContext<TerminalTab[] | null>(null);

interface Instance {
	term: Terminal;
	fit: FitAddon;
	host: HTMLDivElement;
	observer: ResizeObserver | null;
}

/**
 * Palette alignée sur la direction artistique du cockpit.
 *
 * Le thème par défaut de l'émulateur est un noir pur qui découpe un rectangle
 * dans le panneau ; les seize couleurs ANSI, elles, servent à lire la sortie de
 * `pnpm`, `git` ou `vitest` et doivent rester distinctes sur ce fond.
 */
const DARK_THEME = {
	background: "#101117",
	foreground: "#d5d6e2",
	cursor: "#a8a6ff",
	cursorAccent: "#101117",
	selectionBackground: "#2b2a52",
	black: "#272834",
	red: "#ff6b6b",
	green: "#4ade80",
	yellow: "#ffb454",
	blue: "#7c7aff",
	magenta: "#c792ea",
	cyan: "#56c8ff",
	white: "#b0b1c2",
	brightBlack: "#7d7e93",
	brightRed: "#ff8f8f",
	brightGreen: "#7beba4",
	brightYellow: "#ffcb85",
	brightBlue: "#a8a6ff",
	brightMagenta: "#dcb4f5",
	brightCyan: "#8fdcff",
	brightWhite: "#f4f5f9",
};

/**
 * Le même terminal en clair.
 *
 * L'émulateur ne lit pas nos jetons CSS : il veut des valeurs. Les seize
 * couleurs ANSI sont donc reprises assombries — un jaune lisible sur du
 * graphite disparaît sur du blanc — et les « bright » restent distinctes de
 * leur version normale, sans quoi `git diff` et `vitest` perdent la moitié de
 * leur vocabulaire.
 */
const LIGHT_THEME = {
	background: "#ffffff",
	foreground: "#26283a",
	cursor: "#5250e6",
	cursorAccent: "#ffffff",
	selectionBackground: "#dcdbff",
	black: "#3c3f52",
	red: "#c22c2c",
	green: "#16703e",
	yellow: "#8a5200",
	blue: "#3a38cf",
	magenta: "#8a3fb0",
	cyan: "#0b6a9e",
	white: "#6f7288",
	brightBlack: "#8b8ea3",
	brightRed: "#e04a4a",
	brightGreen: "#1f9455",
	brightYellow: "#b07300",
	brightBlue: "#5250e6",
	brightMagenta: "#a955cf",
	brightCyan: "#1188cc",
	brightWhite: "#1b1c24",
};

/** Le jeu qui correspond au thème posé sur le document, à l'instant présent. */
function terminalTheme() {
	return document.documentElement.dataset.theme === "light" ? LIGHT_THEME : DARK_THEME;
}

/**
 * Dépôt hors écran des émulateurs qui ne sont pas affichés.
 *
 * Volontairement décalé plutôt que masqué : `display: none` remet les
 * dimensions à zéro, et l'émulateur recalcule alors une grille d'une colonne
 * sur une ligne dont il ne se remet pas.
 */
function attic(): HTMLElement {
	const existing = document.getElementById("cockpit-terminal-attic");
	if (existing) return existing;
	const node = document.createElement("div");
	node.id = "cockpit-terminal-attic";
	node.setAttribute("aria-hidden", "true");
	node.style.cssText =
		"position:fixed;top:0;left:-20000px;width:900px;height:600px;pointer-events:none;";
	document.body.appendChild(node);
	return node;
}

/** Les blocs remontent en base64 : une lecture peut couper un caractère en deux. */
function decode(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function TerminalsProvider({ children }: { children: ReactNode }) {
	const { notify, go } = useCockpit();
	const workspace = useWorkspace();
	const [tabs, setTabs] = useState<TerminalTab[]>([]);
	const instances = useRef(new Map<string, Instance>());
	const visible = workspace.visible;
	const show = workspace.show;
	const dropped = workspace.dropped;

	const patch = useCallback((id: string, update: (tab: TerminalTab) => TerminalTab) => {
		setTabs((current) => current.map((tab) => (tab.id === id ? update(tab) : tab)));
	}, []);

	// Même règle que pour les agents : un onglet qu'on regarde est un onglet lu,
	// quel que soit le chemin par lequel on y est arrivé. La remise à zéro ne
	// vivait que dans l'attache du terminal à son conteneur — donc au premier
	// affichage seulement, jamais au retour sur l'écran.
	const onScreen = workspace.onScreen;
	const openTab = workspace.tab;
	useEffect(() => {
		if (!onScreen || openTab?.kind !== "terminal") return;
		patch(openTab.id, (tab) => (tab.unread ? { ...tab, unread: false } : tab));
	}, [onScreen, openTab, patch]);

	// Les terminaux déjà ouverts gardent la palette qu'ils avaient à leur
	// création : sans les repeindre, basculer en clair laisse des rectangles noirs
	// au milieu de l'interface, et l'inverse un aplat blanc aveuglant. On observe
	// l'attribut posé sur le document plutôt que d'ajouter un abonnement de plus :
	// c'est lui qui fait foi, quelle qu'en soit l'origine — préférence changée ou
	// bascule du système.
	useEffect(() => {
		const observer = new MutationObserver(() => {
			const theme = terminalTheme();
			for (const instance of instances.current.values()) {
				instance.term.options.theme = theme;
			}
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const outputSub = events.onTerminalOutput((chunk) => {
			const instance = instances.current.get(chunk.id);
			if (!instance) return;
			instance.term.write(decode(chunk.data));
			// Une pastille suffit : compter les lignes d'un serveur de dev
			// n'apprendrait rien, il en produit sans arrêt.
			if (!visible("terminal", chunk.id)) {
				setTabs((current) =>
					current.map((tab) =>
						tab.id === chunk.id && !tab.unread ? { ...tab, unread: true } : tab,
					),
				);
			}
		});

		const exitSub = events.onTerminalExit((exit) => {
			const instance = instances.current.get(exit.id);
			// Le shell est parti mais l'onglet reste : on garde ce qui a défilé,
			// sinon fermer par erreur effacerait la trace de ce qui s'est passé.
			instance?.term.write(
				`\r\n\x1b[38;5;244m— ${
					exit.code !== null && exit.code !== 0
						? t("app:terminals.exitedWithCode", { code: exit.code })
						: t("app:terminals.exited")
				}\x1b[0m\r\n`,
			);
			setTabs((current) =>
				current.map((tab) =>
					tab.id === exit.id ? { ...tab, running: false, exitCode: exit.code } : tab,
				),
			);
		});

		return () => {
			void outputSub.then((off) => off());
			void exitSub.then((off) => off());
		};
	}, [visible]);

	// Les émulateurs vivent hors de React : sans ce nettoyage, un rechargement à
	// chaud laisserait des instances orphelines qui continuent d'écrire.
	useEffect(() => {
		const map = instances.current;
		return () => {
			for (const instance of map.values()) {
				instance.observer?.disconnect();
				instance.term.dispose();
				instance.host.remove();
			}
			map.clear();
		};
	}, []);

	const open = useCallback(
		(cwd: string, options: { command?: string; label?: string; account?: string; background?: boolean } = {}) => {
			// Les shells ne s'affichent que dans l'écran Workspaces : on y va,
			// sinon le terminal s'ouvre là où personne ne le voit.
			go("workspace");

			const host = document.createElement("div");
			host.style.cssText = "width:100%;height:100%;";
			attic().appendChild(host);

			const term = new Terminal({
				theme: terminalTheme(),
				// Cascadia et Consolas : les chasses fixes de Windows, après celles du Mac.
				fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", "Cascadia Mono", "Consolas", monospace',
				fontSize: 12,
				lineHeight: 1.25,
				cursorBlink: true,
				// De quoi remonter dans la sortie d'un build sans tout garder.
				scrollback: 5000,
				allowProposedApi: true,
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(host);
			if (!isMac) windowsClipboard(term);
			try {
				fit.fit();
			} catch {
				// Grille par défaut : elle sera recalculée à l'affichage.
			}

			void api.terminals
				.open(cwd, {
					command: options.command,
					label: options.label,
					account: options.account,
					cols: term.cols,
					rows: term.rows,
				})
				.then((info) => {
					instances.current.set(info.id, { term, fit, host, observer: null });
					term.onData((data) => {
						void api.terminals.write(info.id, data).catch(() => undefined);
					});
					// L'ajustement à la taille du panneau change la grille : le PTY
					// doit suivre, sans quoi les retours à la ligne tombent à côté.
					term.onResize(({ cols, rows }) => {
						void api.terminals.resize(info.id, cols, rows).catch(() => undefined);
					});
					setTabs((current) => [
						...current,
						{
							id: info.id,
							cwd: info.cwd,
							// Sans nom donné, c'est le panneau qui numérote : dans un
							// groupe déjà titré par sa branche, « Terminal 2 » situe
							// mieux qu'un dossier répété d'onglet en onglet.
							label: options.label ?? "",
							running: true,
							exitCode: null,
							unread: false,
						},
					]);
					// Un serveur lancé pour le navigateur ne lui prend pas l'écran.
					if (!options.background) show(cwd, { kind: "terminal", id: info.id });
				})
				.catch((error) => {
					term.dispose();
					host.remove();
					notify(String(error));
				});
		},
		[go, notify, show],
	);

	const close = useCallback(
		(id: string) => {
			void api.terminals.close(id).catch(() => undefined);
			const instance = instances.current.get(id);
			if (instance) {
				instance.observer?.disconnect();
				instance.term.dispose();
				instance.host.remove();
				instances.current.delete(id);
			}
			setTabs((current) => current.filter((tab) => tab.id !== id));
			dropped("terminal", id);
		},
		[dropped],
	);

	const interrupt = useCallback((id: string) => {
		void api.terminals.write(id, "\x03").catch(() => undefined);
	}, []);

	const clear = useCallback((id: string) => {
		instances.current.get(id)?.term.clear();
	}, []);

	/**
	 * Une commande envoyée depuis l'interface passe par la ligne de saisie du
	 * shell, pas par un canal à part : elle s'affiche, entre dans l'historique et
	 * se rappelle ensuite à la flèche du haut. Sans le retour final, elle attend
	 * qu'on la complète — un argument manquant, un flag de dernière minute.
	 */
	const run = useCallback((id: string, line: string, execute: boolean) => {
		void api.terminals.write(id, execute ? `${line}\r` : line).catch(() => undefined);
		instances.current.get(id)?.term.focus();
	}, []);

	const attach = useCallback(
		(id: string, container: HTMLElement) => {
			const instance = instances.current.get(id);
			if (!instance) return;
			container.appendChild(instance.host);

			const resize = () => {
				try {
					instance.fit.fit();
				} catch {
					// Panneau en cours d'animation : la prochaine mesure suffira.
				}
			};
			const observer = new ResizeObserver(resize);
			observer.observe(container);
			instance.observer = observer;

			// Une frame d'attente : le conteneur vient d'être inséré et n'a pas
			// encore de dimensions au moment de l'effet.
			requestAnimationFrame(() => {
				resize();
				instance.term.focus();
			});

			patch(id, (tab) => (tab.unread ? { ...tab, unread: false } : tab));
		},
		[patch],
	);

	const detach = useCallback((id: string) => {
		const instance = instances.current.get(id);
		if (!instance) return;
		instance.observer?.disconnect();
		instance.observer = null;
		attic().appendChild(instance.host);
	}, []);

	const actions = useMemo<TerminalActions>(
		() => ({ open, close, interrupt, run, clear, attach, detach }),
		[open, close, interrupt, run, clear, attach, detach],
	);

	return (
		<ActionsContext.Provider value={actions}>
			<TabsContext.Provider value={tabs}>{children}</TabsContext.Provider>
		</ActionsContext.Provider>
	);
}

/** Les commandes seules — sans réagir à ce que les shells ouverts deviennent. */
export function useTerminalActions(): TerminalActions {
	const store = useContext(ActionsContext);
	if (!store)
		throw new Error("useTerminalActions must be used inside TerminalsProvider");
	return store;
}

export function useTerminals(): TerminalsStore {
	const tabs = useContext(TabsContext);
	const actions = useContext(ActionsContext);
	if (!tabs || !actions) {
		throw new Error("useTerminals must be used inside TerminalsProvider");
	}
	return useMemo(() => ({ ...actions, tabs }), [actions, tabs]);
}

/**
 * Copier-coller dans un terminal, sous Windows.
 *
 * Sur Mac, ⌘C et ⌘V n'arrivent jamais au shell : le navigateur copie et colle,
 * ⌃C interrompt. Sous Windows, Ctrl sert aux deux. On fait comme Windows
 * Terminal : Ctrl+C copie s'il y a une sélection, interrompt sinon ; Ctrl+V et
 * Ctrl+Maj+V collent ; Ctrl+Maj+C copie. Ces frappes-là ne remontent pas à
 * l'app — Ctrl+Maj+C y mène à la carte, et on veut copier.
 */
function windowsClipboard(term: Terminal) {
	term.attachCustomKeyEventHandler((event) => {
		if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey) return true;
		const key = event.key.toLowerCase();
		if (key === "c" && (event.shiftKey || term.hasSelection())) {
			const text = term.getSelection();
			if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
			if (!event.shiftKey) term.clearSelection();
			event.preventDefault();
			event.stopPropagation();
			return false;
		}
		if (key === "v") {
			// Le collage natif arrive par l'événement `paste` du champ de xterm,
			// qui le relaie au shell : on laisse faire le navigateur, sans envoyer ^V.
			event.stopPropagation();
			return false;
		}
		return true;
	});
}
