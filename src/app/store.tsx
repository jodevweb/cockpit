import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { setTestCommands } from "@/lib/episodes";
import { api, events } from "@/lib/ipc";
import { isPreview } from "@/lib/preview";
import type {
	Connector,
	ConfigView,
	JobLine,
	JobStatus,
	Mission,
	ProjectSessions,
	ProjectView,
	Worktree,
} from "@/lib/types";
import { bumpProjectEpoch } from "@/lib/projectScope";
import { useAsync } from "@/lib/useAsync";
import { toast as sonner } from "sonner";
import { t } from "@/i18n";
import { basename } from "@/lib/paths";

export type ViewId =
	// Tout le travail sur un plan : les projets en îles, le travail dans le
	// sens où il avance. L'écran d'accueil.
	| "map"
	| "today"
	// Ce qui attend ta décision, tous agents confondus, rangé par ce que ça
	// débloque : le goulot, c'est toi.
	| "decisions"
	// La journée en images : ce que chaque agent a fait, à regarder plutôt
	// qu'à lire.
	| "recap"
	| "agents"
	// Les plugins (skills, hooks, serveurs MCP) qu'un projet peut adopter, lus
	// avant d'être installés.
	| "methods"
	// Les PR fusionnées comme banc d'essai : juger une configuration d'agents
	// sur ce que le dépôt a déjà résolu.
	| "replay"
	// Le travail vivant est une destination, pas un tiroir : les agents et les
	// terminaux ouverts ont leur écran, que le panneau de droite ne fait que
	// prêter quand on regarde ailleurs.
	| "workspace"
	// Un dossier, un agent : ce qu'on lançait au terminal, sans chantier ni
	// mission. À côté des workspaces, jamais dedans.
	| "libres"
	// Une mission relie un ticket, son plan et les agents qui l'exécutent.
	| "missions"
	// L'opérateur autonome : ce qu'il a engagé, ce qu'il a écarté, ce qu'il a
	// produit. Absent du rail tant qu'il n'est pas activé.
	| "permanence"
	| "worktrees"
	| "git"
	| "scripts"
	| "docs"
	// Ce qui bouge sur tous les dépôts, et ce que chaque changement implique.
	| "impact"
	| "infra"
	| "settings";

export interface NotifyAction {
	label: string;
	onClick: () => void;
}

interface Focus {
	worktreePath?: string;
	sessionFile?: string;
	docPath?: string;
	jobId?: string;
	/** Rubrique visée dans les Réglages. Un bouton « ⚙ » qui ouvre la mauvaise
	    page oblige à chercher ce qu'on venait justement corriger. */
	settingsTab?: string;
	/** Mission à ouvrir sur son parcours, plutôt que dans la liste. */
	missionId?: string;
}

interface CockpitStore {
	view: ViewId;
	go: (view: ViewId, focus?: Focus) => void;
	focus: Focus;
	clearFocus: () => void;

	config: ConfigView | null;
	configError: string | null;
	reloadConfig: () => void;

	/** Projets déclarés, et celui dont les écrans montrent les données. */
	projectList: ProjectView[];
	activeProject: ProjectView | null;
	switchProject: (id: string) => void;

	worktrees: Worktree[];
	worktreesError: string | null;
	worktreesLoading: boolean;
	/** Âge des worktrees affichés — un cockpit doit dater ce qu'il montre. */
	worktreesUpdatedAt: number | null;
	reloadWorktrees: () => void;

	/**
	 * Les missions en cours, pour ce qui a besoin de savoir à quelle mission
	 * appartient un dossier.
	 *
	 * Elles vivent ici plutôt que dans chaque écran : une mission découpée en
	 * cinq tâches ouvre cinq worktrees, et les workspaces s'y perdaient faute de
	 * pouvoir les rattacher à ce qui les avait fait naître.
	 */
	missions: Mission[];
	/** Vrai tant que la première liste n'est pas arrivée : un écran qui dit
	    « aucune mission » avant de savoir affirme quelque chose de faux. */
	missionsLoading: boolean;

	projects: ProjectSessions[];
	sessionsError: string | null;
	sessionsLoading: boolean;
	reloadSessions: () => void;

	jobs: JobStatus[];
	jobLines: Record<string, JobLine[]>;
	runJob: (label: string, command: string, cwd: string) => Promise<JobStatus | null>;
	killJob: (jobId: string) => void;
	clearJobLines: (jobId: string) => void;

	toast: string | null;
	/** Annonce un fait ; `action` y ajoute un geste — « Relire », « Voir ». */
	notify: (message: string, action?: NotifyAction) => void;

	/** Services branchés sur le projet actif. */
	connectors: Connector[];
	/**
	 * Vrai quand au moins un service de cette nature répond.
	 *
	 * C'est ce qui décide de montrer un écran ou de l'escamoter : un tableau de
	 * bord d'incidents sans supervision configurée n'affiche pas une erreur, il
	 * n'a simplement pas lieu d'être.
	 */
	hasConnector: (kind: string) => boolean;
}

const Context = createContext<CockpitStore | null>(null);

/** Conserve la sortie d'un job dans une limite raisonnable (mémoire + rendu). */
const MAX_LINES_PER_JOB = 4000;

/**
 * Silence, en secondes, à partir duquel un agent est tenu pour avoir rendu la
 * main.
 *
 * Un agent au travail alterne phrases et appels d'outils : entre deux, il
 * ressemble à un agent qui attend. Vingt secondes séparent nettement les deux —
 * une pause de réflexion dure rarement autant, et une vraie question n'est pas
 * pressée à ce point.
 */
const HANDBACK_SILENCE = 20;

export function CockpitProvider({ children }: { children: ReactNode }) {
	// L'écran d'accueil est celui qui dit par quoi commencer.
	// L'écran d'entrée, ou celui que l'aperçu demande. `?view=missions` ouvre
	// directement une vue quand l'app tourne dans un navigateur : sans cela, on ne
	// peut en capturer aucune autre que la première, et l'aperçu ne sert qu'à
	// moitié.
	const [view, setView] = useState<ViewId>(() => {
		if (!isPreview()) return "map";
		const asked = new URLSearchParams(window.location.search).get("view");
		return (asked as ViewId) || "map";
	});
	const [focus, setFocus] = useState<Focus>({});
	const [toast, setToast] = useState<string | null>(null);
	const [jobs, setJobs] = useState<JobStatus[]>([]);
	const [jobLines, setJobLines] = useState<Record<string, JobLine[]>>({});

	const configState = useAsync(() => api.config.get(), []);
	// Les cartes d'agents lisent la même règle de tests : posée pendant le rendu,
	// avant elles, pour qu'aucune ne se dessine avec l'ancienne.
	const testCommands = configState.data?.workflow?.testCommands;
	useMemo(() => setTestCommands(testCommands ?? []), [testCommands]);
	// Le watcher `.git` couvre commits, checkouts et fetches ; le polling ne
	// reste que pour les éditions de fichiers, qui ne touchent pas `.git`.
	const worktreeState = useAsync(() => api.worktrees.list(), [], {
		pollMs: 20_000,
		subscribe: events.onGitChanged,
	});
	const sessionState = useAsync(() => api.sessions.scan(40), []);
	// Assez souvent pour qu'un exécutant qui démarre trouve son groupe, assez
	// rarement pour ne pas peser : ce n'est qu'une table de correspondance.
	const missionState = useAsync(() => api.missions.list().catch(() => []), [], {
		pollMs: 15_000,
	});

	// Un agent qui écrit dans son JSONL déclenche un rescan : c'est ce qui rend
	// la vue Agents « vivante » sans polling agressif.
	useEffect(() => {
		let disposed = false;
		let timer: number | undefined;
		const unlisten = events.onSessionsChanged(() => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				if (!disposed) sessionState.reload();
			}, 900);
		});
		return () => {
			disposed = true;
			window.clearTimeout(timer);
			void unlisten.then((off) => off());
		};
		// `reload` est stable : l'abonnement se pose une fois, pour toute la session.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const lineSub = events.onJobLine((line) => {
			setJobLines((current) => {
				const existing = current[line.jobId] ?? [];
				const next =
					existing.length >= MAX_LINES_PER_JOB
						? [...existing.slice(-MAX_LINES_PER_JOB + 1), line]
						: [...existing, line];
				return { ...current, [line.jobId]: next };
			});
		});
		const statusSub = events.onJobStatus((status) => {
			setJobs((current) =>
				current.map((job) => (job.jobId === status.jobId ? status : job)),
			);
			// Un script long (install, migration, e2e) se lance puis s'oublie :
			// c'est au cockpit de rappeler qu'il est fini.
			if (status.state === "succeeded" || status.state === "failed") {
				void api.system
					.notify(
						status.label,
						status.state === "succeeded"
							? t("app:store.job.succeeded")
							: status.exitCode !== null
								? t("app:store.job.failedWithCode", { code: status.exitCode })
								: t("app:store.job.failed"),
					)
					.catch(() => undefined);

				// Un échec doit se voir dans l'app, pas seulement dans une
				// notification système qu'on rate en regardant ailleurs.
				if (status.state === "failed") {
					setToast(
						status.exitCode !== null
							? t("app:store.job.failedToastWithCode", { label: status.label, code: status.exitCode })
							: t("app:store.job.failedToast", { label: status.label }),
					);
				}

				// Un job qui touche aux worktrees change la liste sous nos yeux :
				// on relit plutôt que d'attendre le prochain sondage, qui laisse
				// croire que la suppression n'a rien fait.
				if (status.label.startsWith("worktree ")) {
					worktreeState.reload();
					if (status.state === "succeeded") {
						setToast(t("app:store.job.worktreeDone", { label: status.label }));
					}
				}
			}
		});
		return () => {
			void lineSub.then((off) => off());
			void statusSub.then((off) => off());
		};
		// `reload` est stable : l'abonnement se pose une fois, pour toute la session.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Un agent qui rend la main n'attire pas l'attention tout seul : le cockpit
	// n'est pas forcément au premier plan. Le premier scan ne notifie rien —
	// sinon toutes les sessions dormantes sonneraient au démarrage.
	//
	// Encore faut-il qu'il ait vraiment rendu la main. Un agent au travail écrit
	// une phrase, appelle un outil, écrit la suivante : chaque phrase sans outil
	// derrière ressemble à une attente, et le drapeau bascule à chaque écriture.
	// Notifier là-dessus donnait une alerte toutes les deux secondes pendant
	// qu'il travaillait. On attend donc qu'il se taise : même dernière écriture,
	// et un silence d'au moins `HANDBACK_SILENCE`. S'il reprend la parole, le
	// compte repart de zéro et rien n'est envoyé.
	const waitingSeen = useRef<Map<string, { updatedAt: string; notified: boolean }> | null>(null);
	const recheckTimer = useRef<number | undefined>(undefined);
	useEffect(() => {
		const waiting = (sessionState.data ?? [])
			.flatMap((project) => project.sessions)
			// Au-delà d'une heure d'inactivité, l'attente n'est plus une nouvelle.
			.filter((session) => session.awaitingInput && session.idleSeconds < 3600);

		const seen = waitingSeen.current;
		if (seen === null) {
			waitingSeen.current = new Map(
				waiting.map((session) => [
					session.id,
					{ updatedAt: session.updatedAt ?? "", notified: true },
				]),
			);
			return;
		}

		// Vrai dès qu'une attente est encore trop fraîche pour être jugée : le
		// scan est déclenché par les écritures des agents, et celui qui vient de
		// se taire n'en produira plus. Sans ce rappel, sa notification
		// n'arriverait jamais.
		let pending = false;
		for (const session of waiting) {
			const stamp = session.updatedAt ?? "";
			const known = seen.get(session.id);
			if (!known || known.updatedAt !== stamp) {
				seen.set(session.id, { updatedAt: stamp, notified: false });
			}
			const entry = seen.get(session.id);
			if (!entry || entry.notified) continue;
			if (session.idleSeconds < HANDBACK_SILENCE) {
				pending = true;
				continue;
			}
			entry.notified = true;
			void api.system
				.notify(
					session.gitBranch ?? (basename(session.cwd) || "Agent"),
					t("app:store.notify.waitingReply", { title: session.title }),
				)
				.catch(() => undefined);
		}
		// Une session relancée doit pouvoir re-notifier plus tard.
		const live = new Set(waiting.map((session) => session.id));
		for (const id of [...seen.keys()]) {
			if (!live.has(id)) seen.delete(id);
		}

		window.clearTimeout(recheckTimer.current);
		if (pending) {
			recheckTimer.current = window.setTimeout(
				() => sessionState.reload(),
				(HANDBACK_SILENCE + 1) * 1000,
			);
		}
		// Seule une nouvelle lecture des sessions relance ce calcul : `reload` est stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionState.data]);

	useEffect(() => () => window.clearTimeout(recheckTimer.current), []);

	// ── Veille : les changements d'état qui méritent qu'on soit prévenu ──
	//
	// Ce flux ne sert qu'à ça ; les écrans qui l'affichent le rechargent de leur
	// côté, et la mémoire courte côté Rust évite l'appel en double. On ne
	// notifie que les transitions, jamais l'état initial.
	const watchedPrs = useAsync(() => api.git.pullRequests().catch(() => []), [], {
		pollMs: 180_000,
	});

	const seenCiRed = useRef<Set<number> | null>(null);
	const seenMergeable = useRef<Set<number> | null>(null);
	useEffect(() => {
		const prs = watchedPrs.data ?? [];
		const local = new Set(
			(worktreeState.data ?? []).map((tree) => tree.branch).filter(Boolean) as string[],
		);

		// Seules tes branches : une CI rouge chez quelqu'un d'autre n'est pas une
		// notification, c'est du bruit.
		const red = new Set(
			prs
				.filter((pr) => pr.ciState === "failing" && local.has(pr.headRef))
				.map((pr) => pr.number),
		);
		const mergeable = new Set(
			prs
				.filter(
					(pr) =>
						!pr.isDraft &&
						pr.reviewDecision === "APPROVED" &&
						pr.ciState === "success" &&
						local.has(pr.headRef),
				)
				.map((pr) => pr.number),
		);

		if (seenCiRed.current === null) {
			seenCiRed.current = red;
			seenMergeable.current = mergeable;
			return;
		}

		for (const number of red) {
			if (seenCiRed.current.has(number)) continue;
			const pr = prs.find((entry) => entry.number === number);
			void api.system
				.notify(t("app:store.notify.ciFailed", { number }), pr?.title ?? "")
				.catch(() => undefined);
		}
		for (const number of mergeable) {
			if (seenMergeable.current?.has(number)) continue;
			const pr = prs.find((entry) => entry.number === number);
			void api.system
				.notify(t("app:store.notify.readyToMerge", { number }), pr?.title ?? "")
				.catch(() => undefined);
		}

		seenCiRed.current = red;
		seenMergeable.current = mergeable;
	}, [watchedPrs.data, worktreeState.data]);

	// Chaque annonce passe par la pile de notifications. `toast` reste tenu
	// pour les écrans qui le lisent encore, mais c'est la pile qui s'affiche.
	useEffect(() => {
		if (!toast) return;
		const timer = window.setTimeout(() => setToast(null), 3200);
		return () => window.clearTimeout(timer);
	}, [toast]);

	const notify = useCallback((message: string, action?: NotifyAction) => {
		setToast(message);
		// Une erreur remontée telle quelle (`String(error)`) se reconnaît à son
		// préfixe : elle mérite la teinte d'erreur, et de rester plus longtemps.
		const failed = /^(Ipc)?Error\b|^Erreur\b/.test(message);
		const clean = message.replace(/^(Ipc)?Error:\s*/, "");
		const options = {
			action: action ? { label: action.label, onClick: action.onClick } : undefined,
			duration: failed ? 7000 : 3600,
		};
		if (failed) sonner.error(clean, options);
		else sonner(clean, options);
	}, []);

	// Mémoïsés : sans ça la liste est un tableau neuf à chaque rendu du provider,
	// et le contexte entier — donc tous les écrans — change au moindre toast.
	const projectList = useMemo(
		() => configState.data?.projects ?? [],
		[configState.data?.projects],
	);
	const activeProject = useMemo(
		() =>
			projectList.find((project) => project.id === configState.data?.activeProject) ?? null,
		[projectList, configState.data?.activeProject],
	);

	/**
	 * Change de projet, puis relit tout ce qui en dépend.
	 *
	 * Presque chaque écran lit le dépôt principal ou le dépôt GitHub du projet :
	 * sans ce rechargement groupé, on continuerait d'afficher les worktrees de
	 * l'un et les PR de l'autre.
	 */
	// Les conversations vivent toutes dans `~/.claude/projects`, sans notion de
	// projet : l'écran Agents les montrait donc toutes, quel que soit le projet
	// affiché. On les rattache au dépôt d'où elles viennent, comme les
	// workspaces — un dossier qu'on ne sait pas classer reste visible plutôt que
	// de disparaître sans que rien ne l'explique.
	const sessionCwds = useMemo(
		() => (sessionState.data ?? []).map((project) => project.cwd).sort(),
		[sessionState.data],
	);
	const sessionRepos = useAsync(
		(): Promise<Record<string, string>> =>
			sessionCwds.length > 0 ? api.worktrees.reposOf(sessionCwds) : Promise.resolve({}),
		[sessionCwds.join("|")],
	);
	const sessionsOfProject = useMemo(() => {
		const all = sessionState.data ?? [];
		const repo = (configState.data?.mainRepo ?? "").replace(/\/+$/, "");
		if (!repo) return all;
		const table = sessionRepos.data ?? {};
		return all.filter((project) => {
			const origine = (table[project.cwd] ?? "").replace(/\/+$/, "");
			return origine === "" || origine === repo;
		});
	}, [sessionState.data, sessionRepos.data, configState.data?.mainRepo]);

	const switchProject = useCallback(
		(id: string) => {
			void api.config
				.activateProject(id)
				.then(() => {
					// Un seul signal suffit : chaque chargement du cockpit en dépend,
					// et relire trois d'entre eux à la main laissait les autres sur
					// les données du projet précédent.
					bumpProjectEpoch();
					setFocus({});
				})
				.catch((error) => setToast(String(error)));
		},
		[],
	);

	const go = useCallback((next: ViewId, nextFocus?: Focus) => {
		setView(next);
		if (nextFocus) setFocus(nextFocus);
	}, []);

	const runJob = useCallback(async (label: string, command: string, cwd: string) => {
		try {
			const status = await api.jobs.run(label, command, cwd);
			setJobs((current) => [status, ...current]);
			setJobLines((current) => ({ ...current, [status.jobId]: [] }));
			return status;
		} catch (error) {
			setToast(error instanceof Error ? error.message : String(error));
			return null;
		}
	}, []);

	const killJob = useCallback((jobId: string) => {
		void api.jobs.kill(jobId).catch(() => undefined);
		setJobs((current) =>
			current.map((job) =>
				job.jobId === jobId ? { ...job, state: "cancelled" as const } : job,
			),
		);
	}, []);

	const clearJobLines = useCallback((jobId: string) => {
		setJobLines((current) => ({ ...current, [jobId]: [] }));
	}, []);

	// Ce qui est branché dépend du projet : deux projets n'ont ni les mêmes
	// clés ni les mêmes services, et les écrans doivent suivre.
	const connectorState = useAsync(
		() => api.config.connectors().catch(() => []),
		[activeProject?.id, configState.data],
	);
	const connectors = useMemo(() => connectorState.data ?? [], [connectorState.data]);
	const hasConnector = useCallback(
		(kind: string) => {
			// Tant qu'on ne sait pas, on ne cache rien. La liste arrive un instant
			// après le premier rendu : filtrer dessus la ferait apparaître vide, puis
			// se remplir — un menu qui clignote au lancement, et des entrées qui
			// bougent sous le curseur.
			if (connectors.length === 0) return true;
			return connectors.some((entry) => entry.kind === kind && entry.configured);
		},
		[connectors],
	);

	const value = useMemo<CockpitStore>(
		() => ({
			view,
			go,
			focus,
			clearFocus: () => setFocus({}),
			config: configState.data,
			configError: configState.error,
			reloadConfig: configState.reload,
			projectList,
			activeProject,
			switchProject,
			worktrees: worktreeState.data ?? [],
			worktreesError: worktreeState.error,
			worktreesLoading: worktreeState.loading,
			worktreesUpdatedAt: worktreeState.updatedAt,
			missions: missionState.data ?? [],
			missionsLoading: missionState.initial && missionState.loading,
			reloadWorktrees: worktreeState.reload,
			projects: sessionsOfProject,
			sessionsError: sessionState.error,
			sessionsLoading: sessionState.loading,
			reloadSessions: sessionState.reload,
			jobs,
			jobLines,
			runJob,
			killJob,
			clearJobLines,
			toast,
			notify,
			connectors,
			hasConnector,
		}),
		[
			view,
			go,
			focus,
			configState.data,
			configState.error,
			configState.reload,
			projectList,
			activeProject,
			switchProject,
			worktreeState.data,
			worktreeState.error,
			worktreeState.loading,
			worktreeState.updatedAt,
			worktreeState.reload,
			missionState.data,
			missionState.initial,
			missionState.loading,
			sessionsOfProject,
			sessionState.error,
			sessionState.loading,
			sessionState.reload,
			jobs,
			jobLines,
			connectors,
			hasConnector,
			runJob,
			killJob,
			clearJobLines,
			toast,
			notify,
		],
	);

	return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCockpit(): CockpitStore {
	const store = useContext(Context);
	if (!store) throw new Error("useCockpit must be used inside CockpitProvider");
	return store;
}

/** Toutes les sessions à plat, triées par fraîcheur — base des vues Agents. */
export function useAllSessions() {
	const { projects } = useCockpit();
	return useMemo(
		() =>
			projects
				.flatMap((project) => project.sessions)
				.sort((a, b) => a.idleSeconds - b.idleSeconds),
		[projects],
	);
}

/** Sessions rattachées à un worktree donné (comparaison par chemin réel). */
export function useSessionsForPath(path: string | undefined) {
	const sessions = useAllSessions();
	return useMemo(
		() => (path ? sessions.filter((session) => session.cwd === path) : []),
		[sessions, path],
	);
}
