import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	type ReactNode,
} from "react";
import { useWorkGroups } from "@/components/WorkspacePanel";
import { api } from "@/lib/ipc";
import { hasTauri } from "@/lib/preview";
import { usePersistentState } from "@/lib/useAsync";
import { useAgentActions } from "./agents";
import { useAllSessions } from "./store";
import { useTerminalActions } from "./terminals";

/**
 * Les workspaces mis de côté, et ceux qu'on retrouve au lancement suivant.
 *
 * Un shell est un processus enfant du cockpit : il meurt avec lui. Un agent
 * de workspace, lui, peut lui survivre — il tourne alors dans un relais
 * (`relay.rs`), et le cockpit suivant le retrouve tel quel, sans rien reprendre.
 * Pour tout le reste — relais coupé dans les réglages, agent mort pendant
 * l'absence, shells — on garde de quoi reconstituer : le worktree, la session
 * Claude de chaque conversation, le nom de chaque terminal.
 *
 * Une conversation se reprend vraiment — le CLI sait rouvrir une session par
 * son identifiant, et son journal est relu depuis le disque. Un terminal, non :
 * ce qui a défilé dans un PTY n'existe plus une fois le processus parti. On
 * rouvre un shell au même endroit, vide.
 *
 * Ce qui repart au lancement se règle : rien, les workspaces seuls, ou les
 * workspaces et leurs agents remis au travail. Rien du tout était le seul
 * comportement au début — six workspaces restaurés d'office, ce sont six
 * processus lancés pour des chantiers qu'on ne rouvrira peut-être pas de la
 * journée. C'est vrai le matin où l'on démarre pour autre chose, et faux quand
 * on redémarre au milieu d'un chantier : le choix appartient donc à qui
 * travaille, pas à ce fichier.
 *
 * Deux listes, et c'est la distinction qui fait tout marcher : celle des
 * workspaces qu'on a **rangés** — un geste, ils restent jusqu'au réveil — et
 * l'**empreinte** de ce qui tournait, réécrite en continu et relevée au
 * démarrage suivant. Sans cette séparation, un workspace fermé pour de bon
 * réapparaîtrait le lendemain, faute de pouvoir distinguer une croix d'une
 * fermeture d'application.
 */

export interface SleepingAgent {
	/** Session Claude à reprendre ; `null` pour un agent qui n'a jamais parlé. */
	claudeSessionId: string | null;
	/** Ce qu'on lui avait demandé, pour reconnaître l'onglet avant de l'ouvrir. */
	title: string;
}

export interface SleepingGroup {
	cwd: string;
	label: string;
	agents: SleepingAgent[];
	terminals: Array<{ label: string }>;
	/** Horodatage — un chantier laissé il y a trois jours se voit. */
	at: number;
}

/**
 * Ce que le cockpit fait de la veille, au lancement suivant.
 *
 * `off` : les workspaces attendent dans la barre, un clic les réveille.
 * `reopen` : ils se rouvrent, conversations relues, sans rien demander aux agents.
 * `resume` : ils se rouvrent et chaque agent est invité à reprendre son travail.
 */
export type ResumeMode = "off" | "reopen" | "resume";

/** Clé de la préférence — partagée avec l'écran des réglages. */
export const RESUME_KEY = "workspace.resumeMode";

/**
 * Ce qu'on dit à un agent qu'on vient de reprendre.
 *
 * Sa conversation est relue par le CLI, son contexte est donc intact — mais il
 * ne sait pas qu'il a été interrompu. Sans consigne, il pourrait relancer la
 * commande qu'il avait en cours, ou conclure sur un état qui a changé depuis. On
 * lui demande donc de constater avant de continuer, et de redemander ce qu'il
 * attendait de nous plutôt que de le supposer.
 */
export const RESUME_PROMPT =
	"Le cockpit vient de redémarrer : ta conversation est reprise là où elle s'était " +
	"arrêtée. Fais d'abord le point — relis ce que tu étais en train de faire, vérifie " +
	"l'état réel du dépôt plutôt que de te fier à ta dernière action, et dis en une ligne " +
	"où tu en es. Reprends ensuite. Si tu attendais une réponse de ma part, redemande-la.";

interface HibernateStore {
	sleeping: SleepingGroup[];
	/** Arrête les processus d'un workspace, en gardant de quoi le reprendre. */
	sleep: (cwd: string) => void;
	/** Relance ce qui dormait : conversations reprises, shells rouverts. */
	wake: (cwd: string) => void;
	/** Oublie un workspace endormi sans le rouvrir. */
	forget: (cwd: string) => void;
}

const Context = createContext<HibernateStore | null>(null);

export function HibernateProvider({ children }: { children: ReactNode }) {
	const groups = useWorkGroups();
	const agents = useAgentActions();
	const terminals = useTerminalActions();
	const sessions = useAllSessions();

	const [sleeping, setSleeping] = usePersistentState<SleepingGroup[]>(
		"workspace.sleeping",
		[],
	);
	const [imprint, setImprint] = usePersistentState<SleepingGroup[]>(
		"workspace.imprint",
		[],
	);
	// Lu une fois, au montage : la préférence prend effet au lancement suivant,
	// ce qui est le seul moment où elle veut dire quelque chose.
	const [resumeMode] = usePersistentState<ResumeMode>(RESUME_KEY, "resume");

	// Les identités changent à chaque message reçu ; ces références donnent aux
	// fonctions ci-dessous l'état courant sans les recréer pour autant.
	const live = useRef(groups);
	live.current = groups;
	const known = useRef(sleeping);
	known.current = sleeping;
	const index = useRef(sessions);
	index.current = sessions;

	/**
	 * Ce qu'il faudrait pour rouvrir ce workspace tel qu'il est maintenant.
	 *
	 * Le titre d'un agent vient de sa première consigne, comme son onglet : sans
	 * lui, une liste de workspaces endormis n'annonce que des dossiers.
	 */
	const capture = useCallback((cwd: string): SleepingGroup | null => {
		const group = live.current.find((entry) => entry.cwd === cwd);
		if (!group) return null;
		return {
			cwd: group.cwd,
			label: group.label,
			agents: group.runs.map((run) => ({
				claudeSessionId: run.claudeSessionId,
				title: run.turns.find((turn) => turn.kind === "user")?.text.slice(0, 120) ?? "",
			})),
			terminals: group.terminals.map((terminal) => ({ label: terminal.label })),
			at: Date.now(),
		};
	}, []);

	// Ce que la dernière session avait laissé ouvert rejoint les workspaces
	// rangés, une seule fois au démarrage. Ensuite l'empreinte reprend son
	// travail d'enregistrement, et peut être écrasée sans rien perdre.
	const restored = useRef(false);
	useEffect(() => {
		if (restored.current) return;
		restored.current = true;
		if (imprint.length === 0) return;
		setSleeping((current) => {
			const already = new Set(current.map((entry) => entry.cwd));
			return [...current, ...imprint.filter((entry) => !already.has(entry.cwd))];
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Puis la reprise, si elle est demandée.
	//
	// Elle attend que les sessions du disque soient indexées : c'est là que se
	// trouve le journal de chaque conversation, et un agent rouvert avant l'index
	// s'afficherait vide — le CLI reprendrait bien son fil, mais l'écran ne
	// montrerait rien de ce qui précède. Un poste sans aucune session n'a rien à
	// attendre : le délai borne le cas.
	const resumed = useRef(false);
	useEffect(() => {
		if (resumed.current || resumeMode === "off") return;
		const go = async () => {
			if (resumed.current) return;
			resumed.current = true;
			const entries = known.current;
			if (entries.length === 0) return;
			// Un agent détaché qui a continué pendant la fermeture est déjà là,
			// vivant : le reprendre par `--resume` lancerait un second CLI sur la
			// même conversation, et les deux s'y écriraient dessus.
			const alive = new Set(
				hasTauri()
					? (await api.agents.list().catch(() => []))
							.map((status) => status.claudeSessionId)
							.filter((id): id is string => Boolean(id))
					: [],
			);
			setSleeping([]);
			for (const entry of entries) {
				restore(
					{
						...entry,
						agents: entry.agents.filter(
							(agent) => !agent.claudeSessionId || !alive.has(agent.claudeSessionId),
						),
					},
					resumeMode === "resume" ? RESUME_PROMPT : "",
				);
			}
		};
		if (sessions.length > 0) {
			void go();
			return;
		}
		const timer = window.setTimeout(() => void go(), 2500);
		return () => window.clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [resumeMode, sessions.length]);

	const sleep = useCallback(
		(cwd: string) => {
			const snapshot = capture(cwd);
			const group = live.current.find((entry) => entry.cwd === cwd);
			if (!snapshot || !group) return;

			setSleeping((current) => [snapshot, ...current.filter((entry) => entry.cwd !== cwd)]);
			// Les processus s'arrêtent : c'est l'instantané, pris juste avant, qui
			// permettra de les reconstituer.
			for (const run of group.runs) agents.close(run.id);
			for (const terminal of group.terminals) terminals.close(terminal.id);
		},
		[agents, capture, setSleeping, terminals],
	);

	/**
	 * Rouvre ce qu'un instantané décrit : ses conversations, puis ses shells.
	 *
	 * `prompt` est ce qu'on adresse aux agents en les rouvrant — vide pour les
	 * rendre simplement disponibles, une consigne de reprise pour les remettre au
	 * travail. Partagé entre le réveil d'un clic et la reprise du démarrage : les
	 * deux rouvrent la même chose, seule l'intention diffère.
	 */
	const restore = useCallback(
		(entry: SleepingGroup, prompt: string) => {
			for (const agent of entry.agents) {
				// Le journal de la session dit ce qui s'est dit avant : on le
				// retrouve par son identifiant parmi les sessions indexées, faute
				// de quoi l'agent rouvre sur une conversation vide.
				const file = agent.claudeSessionId
					? index.current.find((session) => session.id === agent.claudeSessionId)?.file
					: undefined;
				agents.open(entry.cwd, prompt, agent.claudeSessionId ?? undefined, file, true);
			}
			for (const terminal of entry.terminals) {
				terminals.open(entry.cwd, terminal.label ? { label: terminal.label } : undefined);
			}
		},
		[agents, terminals],
	);

	const wake = useCallback(
		(cwd: string) => {
			const entry = known.current.find((group) => group.cwd === cwd);
			if (!entry) return;
			setSleeping((current) => current.filter((group) => group.cwd !== cwd));
			// Un réveil demandé n'est pas une reprise : on rouvre, et c'est celui
			// qui a cliqué qui dira quoi faire.
			restore(entry, "");
		},
		[restore, setSleeping],
	);

	const forget = useCallback(
		(cwd: string) => setSleeping((current) => current.filter((entry) => entry.cwd !== cwd)),
		[setSleeping],
	);

	// L'empreinte se réécrit plutôt que de s'annoncer au moment de fermer : une
	// fermeture peut être brutale — plantage, redémarrage du poste — et il n'y a
	// alors personne pour enregistrer quoi que ce soit.
	//
	// La signature ne bouge qu'à l'ouverture ou à la fermeture d'un onglet, pas
	// à chaque phrase reçue : sans elle, on écrirait dans le stockage local
	// plusieurs fois par seconde.
	const signature = groups
		.map((group) => `${group.cwd}:${group.runs.length}:${group.terminals.length}`)
		.join("|");
	useEffect(() => {
		if (!restored.current) return;
		setImprint(
			live.current
				.map((group) => capture(group.cwd))
				.filter((entry): entry is SleepingGroup => entry !== null),
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [signature]);

	// Un workspace rouvert n'est plus endormi. Le réveil l'a déjà retiré, mais
	// on couvre le cas où il repart par un autre chemin — la palette, un agent
	// lancé depuis un autre écran.
	//
	// Pas avant la reprise du démarrage, quand elle est demandée : un agent
	// détaché retrouvé vivant rend son workspace « ouvert » avant elle, et
	// l'effacer ici priverait la reprise de ce qu'il restait à rouvrir dans ce
	// même dossier — ses terminaux, ses autres conversations.
	const liveCwds = groups.map((group) => group.cwd).join("|");
	useEffect(() => {
		if (!resumed.current && resumeMode !== "off") return;
		const alive = new Set(live.current.map((group) => group.cwd));
		setSleeping((current) =>
			current.some((entry) => alive.has(entry.cwd))
				? current.filter((entry) => !alive.has(entry.cwd))
				: current,
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [liveCwds]);

	const value = useMemo<HibernateStore>(
		() => ({ sleeping, sleep, wake, forget }),
		[forget, sleep, sleeping, wake],
	);

	return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useHibernate(): HibernateStore {
	const store = useContext(Context);
	if (!store) throw new Error("useHibernate doit être utilisé dans HibernateProvider");
	return store;
}
