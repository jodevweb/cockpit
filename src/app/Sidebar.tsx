import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import {
	Activity,
	AlarmClock,
	Check,
	ChevronRight,
	ChevronsUpDown,
	Boxes,
	Blocks,
	Bot,
	FlaskConical,
	FileText,
	GitBranch,
	LayoutGrid,
	Map as MapIcon,
	Network,
	PanelsTopLeft,
	ListChecks,
	Radar,
	Rocket,
	ScanEye,
	Settings,
	Sun,
	Terminal,
	Users,
	Inbox,
	Clapperboard,
	ChevronDown,
	Folder,
	SquareTerminal,
	Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { t as translate } from "@/i18n";
import { ResourcesPanel, ResourcesTicker, SpendTicker } from "@/components/ResourcesPanel";
import { UsagePanel } from "@/components/UsagePanel";
import { Dot, KeyHint } from "@/components/ui";
import { useWorkGroups } from "@/components/WorkspacePanel";
import { shortPath } from "@/lib/format";
import { Logo } from "@/components/Logo";
import { ActivityChip } from "@/components/ActivityCenter";
import { hasTauri } from "@/lib/preview";
import { api, events } from "@/lib/ipc";
import { useAsync } from "@/lib/useAsync";
import { useAgentRuns } from "./agents";
import { freezes, useDecisions } from "./decisions";
import { useRecapSeen } from "@/lib/recapSeen";
import { defaultBranch, libreFolders, openLauncher, tilde } from "@/lib/libre";
import { useLibreLaunch } from "@/components/LibreLauncher";
import { useLibresWaiting } from "@/views/LibresView";
import { MODELS, PERMISSION_MODES } from "./agents";
import { useAllSessions, useCockpit, type ViewId } from "./store";
import { dragRegion, formatShortcut, isMac } from "@/lib/platform";
import { homeOf } from "@/lib/paths";

interface Entry {
	id: ViewId;
	icon: React.ComponentType<{ size?: number; className?: string }>;
	shortcut: string;
}

/**
 * Les écrans qui n'ont de sens qu'avec un service branché.
 *
 * Une entrée de menu qui mène à un écran vide se clique une fois, jamais deux :
 * elle apprend surtout à se méfier du menu. Mieux vaut qu'elle n'y soit pas —
 * et qu'elle réapparaisse d'elle-même dès la clé renseignée.
 */
const NEEDS: Partial<Record<ViewId, string>> = {
	team: "tickets",
	observability: "monitoring",
	// Sans suivi de tâches ni dépôt GitHub, l'écran des flux n'a ni tickets ni
	// pull requests à montrer : il ne reste que ses onglets vides.
	delivery: "tickets",
	// L'infra locale a longtemps été masquée sans Docker — elle ne listait que
	// des conteneurs. Elle montre aussi les serveurs de développement en écoute,
	// leur worktree d'origine et ce qu'ils retiennent en mémoire, ce qui ne doit
	// rien à Docker : la masquer rendait introuvable le seul endroit d'où l'on
	// pouvait arrêter un serveur oublié.
	// Les agents et les missions supposent le CLI installé. L'entrée revient dès
	// qu'il l'est — c'est la même règle que pour une clé d'API.
	agents: "agents",
	missions: "agents",
	permanence: "agents",
};

/**
 * Les écrans, dans l'ordre du métier : piloter, produire, livrer.
 *
 * L'ordre précédent partait de l'outil — Worktrees et Git figuraient au premier
 * rang, avant même les missions, comme dans un environnement de développement.
 * Or on n'ouvre pas ce cockpit pour manipuler des branches : on l'ouvre pour
 * décider quoi lancer, le faire faire, puis vérifier que c'est parti. Le
 * maniement du dépôt reste accessible, mais il descend en « Outillage » — c'est
 * un moyen, plus une destination.
 */
const GROUPS: Array<{ id: string; entries: Entry[] }> = [
	{
		id: "pilot",
		entries: [
			// La carte d'abord : c'est l'écran d'où l'on part.
			{ id: "map", icon: MapIcon, shortcut: "⇧C" },
			{ id: "today", icon: Sun, shortcut: "1" },
			// Ce qui attend ta décision, puis la journée en images : les deux
			// écrans d'un pilote dont les agents attendent plus qu'ils ne
			// travaillent.
			{ id: "decisions", icon: Inbox, shortcut: "⇧D" },
			{ id: "recap", icon: Clapperboard, shortcut: "⇧J" },
			{ id: "automations", icon: AlarmClock, shortcut: "⇧R" },
			// Juste après « Aujourd'hui » : c'est un poste de pilotage, pas une
			// chose qu'on produit.
			{ id: "permanence", icon: Radar, shortcut: "⇧P" },
			{ id: "overview", icon: LayoutGrid, shortcut: "2" },
			{ id: "team", icon: Users, shortcut: "3" },
		],
	},
	{
		id: "produce",
		entries: [
			// Pas de chiffre : ce sont les deux écrans sur lesquels on revient le
			// plus souvent, ils méritent un raccourci qu'on n'atteint pas par erreur.
			{ id: "missions", icon: ListChecks, shortcut: "⇧M" },
			{ id: "workspace", icon: PanelsTopLeft, shortcut: "⇧A" },
			// ⌘N ouvre le lanceur, pas l'écran : pas de raccourci affiché ici.
			{ id: "libres", icon: SquareTerminal, shortcut: "" },
			{ id: "agents", icon: Bot, shortcut: "4" },
			{ id: "methods", icon: Blocks, shortcut: "" },
			{ id: "replay", icon: FlaskConical, shortcut: "" },
			{ id: "docs", icon: FileText, shortcut: "5" },
		],
	},
	{
		id: "deliver",
		entries: [
			{ id: "delivery", icon: Rocket, shortcut: "6" },
			{ id: "impact", icon: ScanEye, shortcut: "⇧I" },
			{ id: "observability", icon: Activity, shortcut: "7" },
		],
	},
	{
		id: "tooling",
		entries: [
			{ id: "worktrees", icon: GitBranch, shortcut: "8" },
			{ id: "git", icon: Network, shortcut: "9" },
			{ id: "scripts", icon: Terminal, shortcut: "0" },
			// Plus de chiffre libre : l'infra locale se rejoint par la palette.
			{ id: "infra", icon: Boxes, shortcut: "" },
		],
	},
];

/**
 * Bascule d'un projet à l'autre.
 *
 * Tout l'écran dépend de ce choix : il est donc en haut, toujours visible, et
 * porte le nom du projet plutôt qu'un réglage caché. Avec un seul projet
 * déclaré, il se contente de le nommer — pas de menu pour un choix inexistant.
 */
function ProjectSwitcher() {
	const { projectList, activeProject, switchProject } = useCockpit();
	const { t } = useTranslation("app");
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const dismiss = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		window.addEventListener("mousedown", dismiss);
		return () => window.removeEventListener("mousedown", dismiss);
	}, [open]);

	if (projectList.length === 0) return null;
	const only = projectList.length === 1;

	return (
		<div ref={box} className="relative mx-3 mb-2">
			<button
				type="button"
				disabled={only}
				onClick={() => setOpen((value) => !value)}
				title={activeProject?.mainRepo}
				className={clsx(
					"focus-ring flex h-8 w-full items-center gap-2 rounded-lg border border-line-soft bg-surface px-2.5 text-left transition-colors duration-150",
					!only && "hover:border-line",
				)}
			>
				<span
					className="h-2 w-2 shrink-0 rounded-full"
					style={{ background: activeProject?.color || "var(--color-accent)" }}
				/>
				<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
					{activeProject?.name ?? t("sidebar.project")}
				</span>
				{only ? null : <ChevronsUpDown size={12} className="shrink-0 text-ink-faint" />}
			</button>

			{open ? (
				<div className="panel animate-in absolute top-9 right-0 left-0 z-50 overflow-hidden p-1 shadow-xl shadow-black/40">
					{projectList.map((project) => (
						<button
							key={project.id}
							type="button"
							onClick={() => {
								setOpen(false);
								if (project.id !== activeProject?.id) switchProject(project.id);
							}}
							className="focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
						>
							<span
								className="h-2 w-2 shrink-0 rounded-full"
								style={{ background: project.color || "var(--color-accent)" }}
							/>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[11px] text-ink">
									{project.name}
								</span>
								<span className="block truncate font-mono text-[10px] text-ink-faint">
									{project.githubRepo || shortPath(project.mainRepo)}
								</span>
							</span>
							{project.id === activeProject?.id ? (
								<Check size={12} className="shrink-0 text-accent-soft" />
							) : null}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * Ce qui tourne dans les workspaces, en bout d'entrée.
 *
 * Composant à part, et pas un cas de plus dans `badgeFor` : c'est le seul
 * compteur de la colonne qui se lit dans l'état des agents, lequel change à
 * chaque phrase reçue. Isolé ici, il ne fait rendre à nouveau que lui-même.
 */
function WorkspaceTail({ shortcut }: { shortcut: string }) {
	const groups = useWorkGroups();
	const { pendingFor } = useAgentRuns();

	// Ce qui **tourne**, pas ce qui est ouvert. Le compte portait sur les
	// onglets, agents et terminaux confondus — donc un agent qui a rendu sa
	// réponse et un terminal qu'on a laissé ouvert y pesaient autant qu'un agent
	// au travail. À côté d'un point vert qui dit « en vie », ce nombre se lit
	// comme un nombre d'agents en train de travailler : il doit l'être.
	const count = groups.reduce(
		(total, group) =>
			total +
			group.runs.filter((run) => run.running).length +
			group.terminals.filter((terminal) => terminal.running).length,
		0,
	);
	if (count === 0) {
		return (
			<span className="font-mono text-[10px] text-ink-faint/0 group-hover:text-ink-faint/60">
				{formatShortcut(`⌘${shortcut}`)}
			</span>
		);
	}

	// Un agent qui attend une autorisation expire au bout de cinq minutes : c'est
	// le seul état que la colonne doit signaler sans qu'on ouvre l'écran.
	const waiting = groups.some((group) =>
		group.runs.some((run) => pendingFor(run.id).length > 0),
	);

	return (
		<span
			className={clsx(
				"flex items-center gap-1 font-mono text-[10px]",
				waiting ? "text-warning" : "text-accent-soft",
			)}
		>
			<Dot tone={waiting ? "warning" : "success"} pulse={waiting} />
			{count}
		</span>
	);
}

/**
 * Combien de décisions t'attendent, en bout d'onglet.
 *
 * Isolé comme `WorkspaceTail` : il se lit dans l'état des agents, qui change à
 * chaque phrase reçue, et ne fait rendre à nouveau que lui-même.
 */
function DecisionsTail() {
	const decisions = useDecisions();
	if (decisions.length === 0) return null;
	const frozen = decisions.some(freezes);
	return (
		<span className={clsx("flex items-center gap-1 font-mono text-[10px]", frozen ? "text-warning" : "text-ink-muted")}>
			<Dot tone={frozen ? "warning" : "neutral"} pulse={frozen} />
			{decisions.length}
		</span>
	);
}

/**
 * Combien de tours se sont terminés depuis le dernier récap regardé.
 *
 * Compté sans dessiner aucune histoire : un agent dont le dernier mot est
 * arrivé après la visite, qui ne travaille plus. Le calcul doit rester trivial,
 * il se refait à chaque phrase reçue.
 */
function RecapTail() {
	const { runs } = useAgentRuns();
	const seenAt = useRecapSeen();
	const { t } = useTranslation("app");
	const fresh = runs.filter((run) => {
		if (run.thinking) return false;
		for (let index = run.turns.length - 1; index >= 0; index -= 1) {
			const turn = run.turns[index];
			if (turn.kind === "assistant") return (turn.at ?? 0) > seenAt;
		}
		return false;
	}).length;
	if (fresh === 0) return null;
	return (
		<span className="flex items-center gap-1 font-mono text-[10px] text-accent-soft" title={t("sidebar.recapFresh", { count: fresh })}>
			<Dot tone="success" />
			{fresh}
		</span>
	);
}

/**
 * Le prochain rendu attendu aujourd'hui, ou ce qui tourne en ce moment.
 *
 * Une minute de retard suffit : l'heure d'un rendez-vous ne bouge pas, et ce
 * témoin n'a qu'à dire « 13:30 » le matin d'un daily.
 */
function AutomationsTail() {
	const { t } = useTranslation("app");
	const overview = useAsync(() => api.automations.overview(), [], {
		pollMs: 60_000,
		subscribe: (onChange) => events.onAutomationRun(onChange),
	});
	const list = overview.data ?? [];
	if (list.some((entry) => entry.running)) {
		return (
			<span className="flex items-center gap-1 font-mono text-[10px] text-info" title={t("sidebar.automations.running")}>
				<Dot tone="info" pulse />
			</span>
		);
	}
	const today = new Date();
	const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	const next = list
		.filter((entry) => entry.automation.enabled)
		.map((entry) => entry.upcoming[0]?.ready)
		.filter((ready): ready is string => Boolean(ready) && ready.startsWith(key))
		.sort()[0];
	if (!next) return null;
	return (
		<span className="font-mono text-[10px] text-ink-faint" title={t("sidebar.automations.nextToday")}>
			{next.slice(11)}
		</span>
	);
}

/** Les agents libres qui attendent une réponse — sinon combien sont ouverts. */
function LibresTail() {
	const { open, waiting } = useLibresWaiting();
	if (open === 0) return null;
	return (
		<span className={clsx("flex items-center gap-1 font-mono text-[10px]", waiting > 0 ? "text-warning" : "text-ink-faint")}>
			{waiting > 0 ? <Dot tone="warning" pulse /> : null}
			{waiting > 0 ? waiting : open}
		</span>
	);
}

/**
 * La porte d'entrée des agents libres : un clic ouvre le lanceur, la flèche
 * relance un dossier récent avec les choix qu'on y avait faits — sans passer
 * par le lanceur du tout.
 */
function LaunchButton() {
	const { t } = useTranslation("app");
	const [menu, setMenu] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const start = useLibreLaunch();
	const recents = menu ? libreFolders().filter((entry) => entry.choices).slice(0, 5) : [];

	useEffect(() => {
		if (!menu) return;
		const dismiss = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setMenu(false);
		};
		window.addEventListener("mousedown", dismiss);
		return () => window.removeEventListener("mousedown", dismiss);
	}, [menu]);

	const home = homeOf;
	const describe = (entry: (typeof recents)[number]) => {
		const choices = entry.choices;
		if (!choices) return "";
		const place =
			choices.place === "ici"
				? t("sidebar.launch.placeHere")
				: choices.place === "branche"
					? t("sidebar.launch.placeBranch")
					: t("sidebar.launch.placeWorktree");
		const model = choices.model
			? (MODELS.find((model) => model.id === choices.model)?.label ?? choices.model)
			: t("sidebar.launch.defaultModel");
		const mode = PERMISSION_MODES.find((entry) => entry.id === choices.mode)?.label ?? choices.mode;
		return `${place} · ${model} · ${mode}`;
	};

	return (
		<div ref={box} className="relative mr-1 shrink-0">
			<div className="flex items-stretch overflow-hidden rounded-lg">
			<button
				type="button"
				onClick={() => openLauncher()}
				title={t("sidebar.launch.title")}
				className="focus-ring flex h-7 items-center gap-1.5 bg-accent pr-2 pl-2.5 text-[12px] font-semibold text-accent-ink hover:bg-accent-soft"
			>
				<Zap size={13} />
				<span className="whitespace-nowrap">{t("sidebar.launch.button")}</span>
			</button>
			<button
				type="button"
				aria-label={t("sidebar.launch.again")}
				onClick={() => setMenu((open) => !open)}
				className="focus-ring flex h-7 w-6 items-center justify-center border-l border-accent-ink/20 bg-accent text-accent-ink hover:bg-accent-soft"
			>
				<ChevronDown size={13} />
			</button>
			</div>
			{menu ? (
				<div className="absolute top-9 right-0 z-50 w-[380px] rounded-xl bg-surface p-1.5 shadow-[var(--shadow-pop)]">
					<div className="px-2.5 pt-2 pb-1.5 text-[10px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
						{t("sidebar.launch.again")}
					</div>
					{recents.length === 0 ? (
						<p className="px-2.5 pb-2 text-[12px] text-ink-muted">
							{t("sidebar.launch.noneYet")}
						</p>
					) : null}
					{recents.map((entry) => (
						<button
							key={entry.folder}
							type="button"
							onClick={() => {
								setMenu(false);
								if (!entry.choices) return;
								void start({
									folder: entry.folder,
									root: entry.folder,
									place: entry.choices.place,
									branch: defaultBranch(),
									prompt: "",
									choices: entry.choices,
									remember: true,
								});
							}}
							className="focus-ring flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-hover"
						>
							<Folder size={15} className="shrink-0 text-ink-muted" />
							<span className="min-w-0 flex-1">
								<span className="block truncate font-mono text-[12.5px] text-ink">{tilde(entry.folder, home(entry.folder))}</span>
								<span className="block truncate text-[11.5px] text-ink-muted">{describe(entry)}</span>
							</span>
						</button>
					))}
					<div className="mx-1.5 my-1 h-px bg-line-soft" />
					<button
						type="button"
						onClick={() => {
							setMenu(false);
							openLauncher();
						}}
						className="focus-ring flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-semibold text-accent hover:bg-hover"
					>
						<Zap size={15} />
						<span className="flex-1">{t("sidebar.launch.other")}</span>
						<KeyHint>{formatShortcut("⌘N")}</KeyHint>
					</button>
				</div>
			) : null}
		</div>
	);
}

/**
 * La barre du haut, et l'atelier qu'elle ouvre.
 *
 * Le rail de gauche listait une vingtaine d'écrans en permanence. La carte les
 * remplace comme point de départ : on y voit le travail, et chaque carte mène
 * à l'écran qui la détaille. Restent en haut ce qu'on atteint sans passer par
 * elle — la carte elle-même, les workspaces où l'on parle aux agents, la
 * recherche — et ce qui doit se voir sans rien ouvrir, la dépense et la
 * machine. Tout le reste vit dans l'atelier, à un clic, et dans ⌘K.
 *
 * La barre sert aussi de poignée de fenêtre : la barre de titre est masquée,
 * et ses pastilles se posent sur son bord gauche.
 */
export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
	const { view, go } = useCockpit();
	const { t } = useTranslation("app");
	const [atelier, setAtelier] = useState(false);
	const [resources, setResources] = useState(false);
	// Le détail de la consommation, ouvert depuis le témoin.
	const [usage, setUsage] = useState(false);
	const live = useLiveTabs();
	const current =
		view === "map" || view === "workspace" || view === "libres" || view === "decisions" || view === "recap" || view === "automations" || live.some((tab) => tab.entry.id === view) ? null : entryOf(view);

	return (
		<>
			<header
				data-tauri-drag-region={dragRegion}
				className={clsx(
					"hairline-b relative z-30 flex h-11 shrink-0 items-center gap-1 bg-base pr-2",
					// Les pastilles de fenêtre de macOS occupent le coin. Ailleurs, la
					// barre de titre est native, au-dessus : rien à réserver.
					hasTauri() && isMac ? "pl-[84px]" : "pl-3",
				)}
			>
				<Logo size={20} className="mr-1.5 shadow-sm shadow-black/30" />
				<TopTab active={view === "map"} onClick={() => go("map")} icon={MapIcon} title={t("sidebar.top.mapTitle")}>
					{t("sidebar.views.map")}
				</TopTab>
				<TopTab
					active={view === "workspace"}
					onClick={() => go("workspace")}
					icon={PanelsTopLeft}
					title={t("sidebar.top.workspaceTitle")}
				>
					{t("sidebar.views.workspace")}
					<WorkspaceTail shortcut="⇧A" />
				</TopTab>
				<TopTab
					active={view === "libres"}
					onClick={() => go("libres")}
					icon={SquareTerminal}
					title={t("sidebar.top.libresTitle")}
				>
					{t("sidebar.views.libres")}
					<LibresTail />
				</TopTab>
				<TopTab
					active={view === "decisions"}
					onClick={() => go("decisions")}
					icon={Inbox}
					title={t("sidebar.top.decisionsTitle")}
				>
					{t("sidebar.views.decisions")}
					<DecisionsTail />
				</TopTab>
				<TopTab
					active={view === "recap"}
					onClick={() => go("recap")}
					icon={Clapperboard}
					title={t("sidebar.top.recapTitle")}
				>
					{t("sidebar.top.recap")}
					<RecapTail />
				</TopTab>
				<TopTab
					active={view === "automations"}
					onClick={() => go("automations")}
					icon={AlarmClock}
					title={t("sidebar.top.automationsTitle")}
				>
					{t("sidebar.views.automations")}
					<AutomationsTail />
				</TopTab>
				{live.map((tab) => (
					<TopTab
						key={tab.entry.id}
						active={view === tab.entry.id}
						onClick={() => go(tab.entry.id)}
						icon={tab.entry.icon}
						title={tab.title}
					>
						{viewLabel(tab.entry.id)}
						<span
							className={clsx(
								"flex items-center gap-1 font-mono text-[10px]",
								tab.waiting ? "text-warning" : "text-accent-soft",
							)}
						>
							<Dot tone={tab.waiting ? "warning" : "success"} pulse={tab.waiting} />
							{tab.count}
						</span>
					</TopTab>
				))}
				{current ? (
					<>
						<ChevronRight size={12} className="shrink-0 text-ink-faint" />
						<TopTab active onClick={() => undefined} icon={current.icon}>
							{viewLabel(current.id)}
						</TopTab>
					</>
				) : null}

				<span data-tauri-drag-region={dragRegion} className="h-full min-w-4 flex-1" />

				<button
					type="button"
					onClick={onOpenPalette}
					className="focus-ring flex h-7 w-56 min-w-[132px] shrink items-center justify-between gap-2 rounded-lg border border-line-soft bg-surface px-2.5 text-[11px] text-ink-faint transition-colors duration-150 hover:border-line hover:text-ink-muted"
				>
					<span className="truncate whitespace-nowrap">{t("sidebar.search")}</span>
					<KeyHint>{formatShortcut("⌘K")}</KeyHint>
				</button>
				{/* Ce qu'on dépense et ce que la machine encaisse : à voir sans rien
				    ouvrir, un quota qui s'épuise coûte plus cher qu'un écran de plus. */}
				<LaunchButton />
				<div className="w-36 shrink-0">
					<SpendTicker onOpen={() => setUsage(true)} />
				</div>
				<div className="w-40 shrink-0">
					<ResourcesTicker onOpen={() => setResources(true)} />
				</div>
				<ActivityChip />
				<TopTab active={atelier} onClick={() => setAtelier((open) => !open)} icon={LayoutGrid} title={t("sidebar.atelier.title")}>
					{t("sidebar.atelier.name")}
				</TopTab>
			</header>

			<AnimatePresence>
				{atelier ? <Atelier onClose={() => setAtelier(false)} /> : null}
			</AnimatePresence>
			{resources ? <ResourcesPanel onClose={() => setResources(false)} /> : null}
			{usage ? <UsagePanel onClose={() => setUsage(false)} /> : null}
		</>
	);
}

/**
 * Les écrans où quelque chose tourne, épinglés dans la barre du haut.
 *
 * Le fil d'Ariane ne montrait que l'écran courant : on lançait une mission,
 * on repartait dans les workspaces, et l'entrée « Missions » disparaissait
 * alors que la mission travaillait toujours. Ce qui tourne reste à un clic
 * tant qu'il tourne, et s'en va de lui-même une fois fini.
 *
 * Une mission suspendue ne tourne pas ; une mission qui attend un accord, si —
 * c'est même elle qu'il faut voir, d'où la teinte d'alerte.
 */
function useLiveTabs(): Array<{ entry: Entry; count: number; waiting: boolean; title: string }> {
	const { missions, jobs } = useCockpit();
	const tabs: Array<{ entry: Entry; count: number; waiting: boolean; title: string }> = [];

	const ongoing = missions.filter(
		(mission) => mission.state !== "done" && mission.state !== "failed" && !mission.paused,
	);
	const entryMissions = entryOf("missions");
	if (ongoing.length > 0 && entryMissions) {
		const waiting = ongoing.filter((mission) => mission.state.startsWith("awaiting")).length;
		tabs.push({
			entry: entryMissions,
			count: ongoing.length,
			waiting: waiting > 0,
			title:
				waiting > 0
					? translate("app:sidebar.live.missionsWaiting", {
							missions: translate("app:sidebar.live.missions", { count: ongoing.length }),
							count: waiting,
						})
					: translate("app:sidebar.live.missionsOngoing", {
							missions: translate("app:sidebar.live.missions", { count: ongoing.length }),
						}),
		});
	}

	const running = jobs.filter((job) => job.state === "running").length;
	const entryScripts = entryOf("scripts");
	if (running > 0 && entryScripts) {
		tabs.push({
			entry: entryScripts,
			count: running,
			waiting: false,
			title: translate("app:sidebar.live.scripts", { count: running }),
		});
	}

	return tabs;
}

/** Le nom d'un écran, tel que la barre et l'atelier l'affichent. */
function viewLabel(view: ViewId): string {
	return translate(`app:sidebar.views.${view}`);
}

/** L'entrée du catalogue qui correspond à un écran, réglages compris. */
function entryOf(view: ViewId): Entry | null {
	if (view === "settings") return { id: "settings", icon: Settings, shortcut: "," };
	for (const group of GROUPS) {
		const found = group.entries.find((entry) => entry.id === view);
		if (found) return found;
	}
	return null;
}

function TopTab({
	active,
	onClick,
	icon: Icon,
	title,
	children,
}: {
	active: boolean;
	onClick: () => void;
	icon: React.ComponentType<{ size?: number; className?: string }>;
	title?: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className={clsx(
				"focus-ring group relative flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors duration-150",
				active ? "bg-surface font-medium text-ink shadow-card" : "text-ink-muted hover:bg-surface hover:text-ink",
			)}
		>
			<Icon size={14} className={active ? "text-accent" : "text-ink-faint"} />
			{children}
		</button>
	);
}

/**
 * Tous les écrans, le projet, les réglages : ce que le rail montrait en
 * permanence, rangé dans un tiroir qu'on ouvre quand on en a besoin.
 */
function Atelier({ onClose }: { onClose: () => void }) {
	const { view, go, jobs, worktrees, activeProject, hasConnector, config } = useCockpit();
	const { t } = useTranslation("app");
	const sessions = useAllSessions();

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Une session écrite il y a moins de 3 minutes = un agent probablement en
	// train de travailler. C'est l'indicateur qu'on veut voir sans cliquer.
	const liveAgents = sessions.filter((session) => session.idleSeconds < 180).length;
	const runningJobs = jobs.filter((job) => job.state === "running").length;
	const dirtyTrees = worktrees.filter(
		(tree) => tree.status.modified + tree.status.untracked + tree.status.staged > 0,
	).length;

	const badgeFor = (id: ViewId) => {
		if (id === "agents" && liveAgents > 0) return liveAgents;
		if (id === "scripts" && runningJobs > 0) return runningJobs;
		if (id === "worktrees" && dirtyTrees > 0) return dirtyTrees;
		return null;
	};
	const open = (id: ViewId) => {
		go(id);
		onClose();
	};

	return (
		<>
			<motion.button
				type="button"
				aria-label={t("sidebar.atelier.close")}
				onClick={onClose}
				initial={{ opacity: 0 }}
				animate={{ opacity: 0.25 }}
				exit={{ opacity: 0 }}
				className="fixed inset-0 top-11 z-40 cursor-default bg-overlay"
			/>
			<motion.nav
				initial={{ opacity: 0, y: -8 }}
				animate={{ opacity: 1, y: 0 }}
				exit={{ opacity: 0, y: -6 }}
				transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
				className="fixed top-12 right-2 z-50 flex max-h-[calc(100vh-4rem)] w-[560px] flex-col overflow-hidden rounded-[var(--radius-panel)] bg-base shadow-[var(--shadow-pop)]"
			>
				<div className="flex items-center gap-2 px-3 pt-3">
					<span className="text-[13px] font-semibold text-ink">{t("sidebar.atelier.name")}</span>
					<span className="text-[11px] text-ink-faint">{t("sidebar.atelier.subtitle")}</span>
				</div>
				<div className="pt-2">
					<ProjectSwitcher />
				</div>
				<div className="grid min-h-0 grid-cols-2 gap-x-2 gap-y-4 overflow-y-auto px-2 pb-3">
					{GROUPS.map((group) => (
						<div key={group.id} className="flex flex-col gap-0.5">
							<span className="px-2.5 pb-1 text-[10px] font-semibold tracking-[0.09em] text-ink-faint/70 uppercase">
								{t(`sidebar.groups.${group.id}`)}
							</span>
							{group.entries
								// Un projet sans équipe n'a pas de daily à tenir.
								.filter((entry) => entry.id !== "team" || activeProject?.hasTeam !== false)
								// Un service absent : l'entrée revient d'elle-même dès que la
								// clé est renseignée.
								.filter((entry) => {
									const needs = NEEDS[entry.id];
									return !needs || hasConnector(needs);
								})
								.filter((entry) => entry.id !== "permanence" || config?.permanence?.enabled === true)
								.map((entry) => {
									const active = view === entry.id;
									const badge = badgeFor(entry.id);
									return (
										<button
											key={entry.id}
											type="button"
											data-screen={entry.id}
											onClick={() => open(entry.id)}
											className={clsx(
												"focus-ring group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] transition-colors duration-150",
												active ? "bg-surface font-medium text-ink shadow-card" : "text-ink-muted hover:bg-surface hover:text-ink",
											)}
										>
											<entry.icon size={14} className={active ? "text-accent" : "text-ink-faint"} />
											<span className="flex-1 text-left">{viewLabel(entry.id)}</span>
											{entry.id === "workspace" ? (
												<WorkspaceTail shortcut={entry.shortcut} />
											) : badge !== null ? (
												<span className="flex items-center gap-1 font-mono text-[10px] text-accent-soft">
													{entry.id === "agents" ? <Dot tone="success" pulse /> : null}
													{badge}
												</span>
											) : entry.shortcut ? (
												<span className="font-mono text-[10px] text-ink-faint/60">{formatShortcut(`⌘${entry.shortcut}`)}</span>
											) : null}
										</button>
									);
								})}
						</div>
					))}
				</div>
				<div className="hairline-b" />
				<button
					type="button"
					data-screen="settings"
					onClick={() => open("settings")}
					className={clsx(
						"focus-ring m-2 flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] transition-colors duration-150",
						view === "settings" ? "bg-hover font-medium text-ink" : "text-ink-muted hover:bg-surface hover:text-ink",
					)}
				>
					<Settings size={14} className={view === "settings" ? "text-accent-soft" : "text-ink-faint"} />
					{t("sidebar.views.settings")}
					<span className="ml-auto font-mono text-[10px] text-ink-faint/60">{formatShortcut("⌘,")}</span>
				</button>
			</motion.nav>
		</>
	);
}
