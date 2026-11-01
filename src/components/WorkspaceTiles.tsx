import clsx from "clsx";
import {
	AlertTriangle,
	Bot,
	ClipboardCheck,
	FileText,
	Gauge,
	GitCommitHorizontal,
	GitPullRequest,
	Globe,
	Image as ImageIcon,
	LayoutDashboard,
	LayoutGrid,
	ListChecks,
	Network,
	Ticket,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { movedSince, useReview } from "@/app/review";
import { useCockpit } from "@/app/store";
import { BranchBoard, type BoardSection } from "@/components/BranchBoard";
import { BrowserView } from "@/components/BrowserView";
import { ChantierMap } from "@/components/ChantierMap";
import { Dot } from "@/components/ui";
import type { WorkGroup } from "@/components/WorkspacePanel";
import {
	agentColor,
	collisions as findCollisions,
	pathsToStamp,
	relativeTo,
	squarify,
	staleness,
	touchesOf,
} from "@/lib/chantier";
import { duration } from "@/lib/format";
import { api } from "@/lib/ipc";
import { progressOf, type Progress } from "@/lib/progress";
import { MISSION_STATE_LABELS } from "@/lib/missions";
import { isPreview, PREVIEW_PAGE } from "@/lib/preview";
import { useAsync } from "@/lib/useAsync";
import { t as translate } from "@/i18n";
import { ticketsIn } from "@/lib/world";

/**
 * Ce qui entoure un agent, épinglé sur sa carte.
 *
 * La vue de branche, le territoire et le navigateur étaient trois onglets à côté de
 * celui de l'agent : pour savoir où en était la PR ou ce que montrait la page,
 * il fallait quitter la carte, puis y revenir. Ils tiennent maintenant dessus,
 * en trois tuiles qui disent l'essentiel sans qu'on clique — et qui s'ouvrent
 * sur place, dans le panneau de la carte, quand on veut l'écran entier.
 *
 * Une tuile est un résumé : elle ne monte pas l'écran qu'elle annonce. Trois
 * écrans vivants par agent, sur chaque carte, c'est ce qui figeait l'app quand
 * un agent travaillait.
 */

/** Les parties de la vue (`pr`, `ticket`, `review`…) sont les lignes de la tuile « Vue », chacune dans son panneau. */
export type TileId = "progress" | "branch" | BoardSection | "territory" | "browser";

export interface Satellites {
	group: WorkGroup;
	/** Qui pilote le navigateur en ce moment, et avec quel outil. */
	driving: { runId: string; label: string; tool: string } | null;
	/** Lance le serveur de dev de l'équipe, si elle en a déclaré un. */
	onStartServer?: () => void;
	/** Une tuile à ouvrir sur la carte d'un agent — demandée d'ailleurs dans l'app. */
	ask: { runId: string; tile: TileId; at: number } | null;
}

const Context = createContext<Satellites | null>(null);

export const SatellitesProvider = Context.Provider;

/** La carte a-t-elle des tuiles ? Hors d'un workspace, non. */
export function useHasTiles(): boolean {
	return useContext(Context) !== null;
}

/** Lu au rendu : la langue n'est pas connue au chargement du module. */
function tileTitle(id: TileId): { readonly eyebrow: string; readonly title: string } {
	return {
		get eyebrow() {
			return translate(`components2:workspaceTiles.tiles.${id}.eyebrow`);
		},
		get title() {
			return translate(`components2:workspaceTiles.tiles.${id}.title`);
		},
	};
}

export const TILE_TITLES: Record<TileId, { readonly eyebrow: string; readonly title: string }> = {
	progress: tileTitle("progress"),
	branch: tileTitle("branch"),
	pr: tileTitle("pr"),
	mission: tileTitle("mission"),
	agents: tileTitle("agents"),
	commits: tileTitle("commits"),
	docs: tileTitle("docs"),
	captures: tileTitle("captures"),
	ports: tileTitle("ports"),
	ticket: tileTitle("ticket"),
	review: tileTitle("review"),
	territory: tileTitle("territory"),
	browser: tileTitle("browser"),
};

/** La place que les tuiles prennent à gauche de la carte, marge comprise. */
export const RAIL_WIDTH = 212;

export function TileRail({
	runId,
	active,
	open,
	onOpen,
}: {
	runId: string;
	/** La carte est celle qu'on regarde : masquée, aucune tuile n'interroge rien. */
	active: boolean;
	open: TileId | null;
	onOpen: (tile: TileId | null) => void;
}) {
	const satellites = useContext(Context);
	const ask = satellites?.ask ?? null;
	const answered = useRef(0);
	useEffect(() => {
		if (!ask || ask.runId !== runId || ask.at === answered.current) return;
		answered.current = ask.at;
		onOpen(ask.tile);
	}, [ask, runId, onOpen]);

	if (!satellites) return null;
	const toggle = (tile: TileId) => onOpen(open === tile ? null : tile);

	return (
		// Sur une petite fenêtre, les tuiles défilent plutôt que de sortir de la
		// carte ; la marge intérieure laisse la place de leurs ombres.
		<div className="absolute top-2 bottom-2 left-2 z-10 flex w-[196px] flex-col gap-2 overflow-y-auto p-1 [scrollbar-width:none] pointer-events-none *:pointer-events-auto *:shrink-0">
			<ProgressTile
				satellites={satellites}
				runId={runId}
				active={active}
				selected={open === "progress"}
				onPick={() => toggle("progress")}
			/>
			<BranchTile satellites={satellites} active={active} open={open} onPick={toggle} />
			<TerritoryTile
				satellites={satellites}
				runId={runId}
				active={active}
				selected={open === "territory"}
				onPick={() => toggle("territory")}
			/>
			<BrowserTile
				satellites={satellites}
				runId={runId}
				// Agrandie, la page est diffusée en direct : la tuile n'a plus à la capturer.
				active={active && open !== "browser"}
				selected={open === "browser"}
				onPick={() => toggle("browser")}
			/>
		</div>
	);
}

/** L'écran entier d'une tuile, pour le panneau de la carte. */
export function TileBody({ tile, runId }: { tile: TileId; runId: string }) {
	const satellites = useContext(Context);
	if (!satellites) return null;
	const { group, driving, onStartServer } = satellites;
	if (tile === "progress") return <ProgressBoard satellites={satellites} runId={runId} />;
	if (tile === "branch") return <BranchBoard group={group} active />;
	if (tile === "territory") return <ChantierMap cwd={group.cwd} runs={group.runs} active />;
	if (tile === "browser") {
		return <BrowserView cwd={group.cwd} active driving={driving?.tool ?? null} onStartServer={onStartServer} />;
	}
	return <BranchBoard group={group} active only={tile} />;
}

// ───────────────────────────── La tuile ─────────────────────────────

function Tile({
	icon: Icon,
	label,
	aside,
	selected,
	alert,
	onPick,
	title,
	children,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>;
	label: string;
	aside?: ReactNode;
	selected: boolean;
	/** Quelque chose ici demande un regard. */
	alert?: boolean;
	onPick: () => void;
	title: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onPick}
			title={title}
			className={clsx(
				"focus-ring flex flex-col gap-1.5 rounded-xl bg-surface p-2.5 text-left shadow-[var(--shadow-card)] transition-shadow hover:shadow-pop",
				selected ? "ring-2 ring-accent" : alert && "ring-1 ring-warning/60",
			)}
		>
			<span className="flex w-full items-center gap-1.5">
				<Icon size={12} className={selected ? "text-accent" : "text-ink-faint"} />
				<span className="font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">{label}</span>
				<span className="ml-auto flex items-center gap-1 text-[10.5px] text-ink-muted">{aside}</span>
			</span>
			{children}
		</button>
	);
}

// ───────────────────────────── Avancement ─────────────────────────────

/** L'heure qu'il est, relue de loin en loin : une durée affichée doit avancer. */
function useNow(enabled: boolean, everyMs = 15_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), everyMs);
		return () => window.clearInterval(timer);
	}, [enabled, everyMs]);
	return now;
}

const since = (from: number | null, now: number) => (from ? duration(Math.max(0, (now - from) / 1000)) : null);

/** Au-delà, un agent au travail qui n'a rien fait mérite un regard. */
const SILENT_MS = 5 * 60_000;

function useProgress(satellites: Satellites, runId: string) {
	const run = satellites.group.runs.find((entry) => entry.id === runId) ?? null;
	const turns = run?.turns;
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const progress = useMemo(() => (run ? progressOf(run) : null), [turns]);
	return { run, progress };
}

function counts(progress: Progress) {
	return {
		done: progress.steps.filter((step) => step.state === "done").length,
		current: progress.steps.find((step) => step.state === "active") ?? null,
		back: progress.helpers.filter((helper) => helper.state !== "running").length,
	};
}

/** Les étapes, une case chacune : on voit le compte et où il en est, sans barre qui prétende mesurer. */
function StepCells({ progress }: { progress: Progress }) {
	return (
		<span className="flex w-full gap-0.5">
			{progress.steps.map((step, index) => (
				<span
					key={index}
					className={clsx(
						"h-1.5 min-w-0 flex-1 rounded-full",
						step.state === "done" ? "bg-success" : step.state === "active" ? "animate-pulse-dot bg-accent" : "bg-raised",
					)}
				/>
			))}
		</span>
	);
}

/**
 * Où en est l'agent, d'un coup d'œil — sans pourcentage.
 *
 * Un agent ne connaît pas la taille de son travail avant de l'avoir fini : un
 * chiffre en pour cent serait une estimation déguisée en mesure. La tuile
 * compte ce qui se compte — ses étapes s'il en tient la liste, ses
 * sous-agents rendus — et dit depuis quand il travaille et s'il bouge encore.
 */
function ProgressTile({
	satellites,
	runId,
	active,
	selected,
	onPick,
}: {
	satellites: Satellites;
	runId: string;
	active: boolean;
	selected: boolean;
	onPick: () => void;
}) {
	const { t } = useTranslation("components2");
	const { run, progress } = useProgress(satellites, runId);
	const busy = Boolean(run?.thinking);
	const now = useNow(active && busy);
	if (!run || !progress) return null;

	const { done, current, back } = counts(progress);
	const silent = busy && progress.lastAt !== null && now - progress.lastAt > SILENT_MS;
	const elapsed = busy ? since(progress.since, now) : null;

	return (
		<Tile
			icon={Gauge}
			label={t("workspaceTiles.progress.label")}
			selected={selected}
			alert={silent}
			onPick={onPick}
			title={t("workspaceTiles.progress.title")}
			aside={
				silent ? (
					<span className="text-warning">{t("workspaceTiles.progress.silent", { duration: since(progress.lastAt, now) })}</span>
				) : elapsed ? (
					<>
						<Dot tone="success" pulse />
						{elapsed}
					</>
				) : null
			}
		>
			{progress.steps.length > 0 ? (
				<>
					<span className="text-[12px] font-medium text-ink">
						{t("workspaceTiles.progress.steps", { done, count: progress.steps.length })}
					</span>
					<StepCells progress={progress} />
					{current ? <span className="w-full truncate text-[10.5px] text-ink-muted">{current.label}</span> : null}
				</>
			) : progress.helpers.length > 0 ? (
				<span className="text-[12px] font-medium text-ink">
					{t("workspaceTiles.progress.helpers", { back, count: progress.helpers.length })}
				</span>
			) : (
				<span className="text-[11px] text-ink-faint">
					{busy ? t("workspaceTiles.progress.busyNoSteps") : t("workspaceTiles.progress.idle")}
				</span>
			)}
			{progress.steps.length > 0 && progress.helpers.length > 0 ? (
				<span className="text-[10.5px] text-ink-faint">
					{t("workspaceTiles.progress.helpers", { back, count: progress.helpers.length })}
				</span>
			) : null}
			{busy && progress.steps.length === 0 && progress.lastAction ? (
				<span className="w-full truncate font-mono text-[10px] text-ink-faint">{progress.lastAction}</span>
			) : null}
		</Tile>
	);
}

/** L'avancement en entier : la consigne, les étapes, les sous-agents, les signes de vie. */
function ProgressBoard({ satellites, runId }: { satellites: Satellites; runId: string }) {
	const { t } = useTranslation("components2");
	const { run, progress } = useProgress(satellites, runId);
	const now = useNow(true, 5_000);
	if (!run || !progress) return null;

	const busy = run.thinking;
	const { done, back } = counts(progress);
	const silent = busy && progress.lastAt !== null && now - progress.lastAt > SILENT_MS;
	const facts = [
		{
			label: busy ? t("workspaceTiles.board.workingFor") : t("workspaceTiles.board.launchedAgo"),
			value: since(progress.since, now) ?? "—",
		},
		{ label: t("workspaceTiles.board.lastActionAgo"), value: since(progress.lastAt, now) ?? "—", warn: silent },
		{ label: t("workspaceTiles.board.toolCalls"), value: String(progress.calls) },
		{ label: t("workspaceTiles.board.filesWritten"), value: String(progress.written) },
	];

	return (
		<div className="flex flex-col gap-5 p-5">
			{progress.brief ? (
				<section>
					<Heading>{t("workspaceTiles.board.brief")}</Heading>
					<p className="text-selectable line-clamp-4 text-[12.5px] leading-relaxed text-ink-muted">{progress.brief}</p>
				</section>
			) : null}

			<section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{facts.map((fact) => (
					<div key={fact.label} className="rounded-xl border border-line-soft bg-surface/60 p-3">
						<div className={clsx("font-mono text-[15px]", fact.warn ? "text-warning" : "text-ink")}>{fact.value}</div>
						<div className="mt-0.5 text-[10.5px] text-ink-faint">{fact.label}</div>
					</div>
				))}
			</section>

			<section>
				<Heading aside={progress.steps.length > 0 ? `${done} / ${progress.steps.length}` : undefined}>{t("workspaceTiles.board.steps")}</Heading>
				{progress.steps.length > 0 ? (
					<>
						<StepCells progress={progress} />
						<ol className="mt-3 flex flex-col gap-1">
							{progress.steps.map((step, index) => (
								<li key={index} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
									<span className="mt-[7px]">
										<Dot
											tone={step.state === "done" ? "success" : step.state === "active" ? "info" : "neutral"}
											pulse={step.state === "active" && busy}
										/>
									</span>
									<span
										className={clsx(
											"min-w-0 flex-1",
											step.state === "done" ? "text-ink-faint line-through" : step.state === "active" ? "font-medium text-ink" : "text-ink-muted",
										)}
									>
										{step.label}
									</span>
								</li>
							))}
						</ol>
						<p className="mt-3 text-[10.5px] leading-relaxed text-ink-faint">
							{t("workspaceTiles.board.countNotPercent")}
						</p>
					</>
				) : (
					// Le dire plutôt que d'afficher une barre vide : sans liste, il n'y a
					// rien à compter, et une estimation passerait pour une mesure.
					<p className="rounded-xl border border-line-soft p-3 text-[12px] leading-relaxed text-ink-faint">
						{t("workspaceTiles.board.noSteps")}
					</p>
				)}
			</section>

			{progress.helpers.length > 0 ? (
				<section>
					<Heading aside={t("workspaceTiles.board.helpersBack", { back, count: progress.helpers.length })}>
						{t("workspaceTiles.board.helpers")}
					</Heading>
					<ul className="flex flex-col gap-1">
						{progress.helpers.map((helper, index) => (
							<li key={index} className="flex items-center gap-2 rounded-lg px-1 py-1 text-[12px]">
								<Dot
									tone={helper.state === "failed" ? "critical" : helper.state === "done" ? "success" : "info"}
									pulse={helper.state === "running"}
								/>
								<span className="min-w-0 flex-1 truncate text-ink">{helper.label}</span>
								{helper.kind ? <span className="font-mono text-[10px] text-ink-faint">{helper.kind}</span> : null}
								<span className="w-16 shrink-0 text-right font-mono text-[10.5px] text-ink-muted">
									{helper.state === "running"
										? (since(helper.startedAt, now) ?? t("workspaceTiles.board.helperRunning"))
										: helper.startedAt && helper.endedAt
											? duration(Math.max(0, (helper.endedAt - helper.startedAt) / 1000))
											: helper.state === "failed"
												? t("workspaceTiles.board.helperFailed")
												: t("workspaceTiles.board.helperDone")}
								</span>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{progress.lastAction ? (
				<section>
					<Heading>{t("workspaceTiles.board.lastAction")}</Heading>
					<p className="text-selectable truncate font-mono text-[11.5px] text-ink-muted">{progress.lastAction}</p>
				</section>
			) : null}
		</div>
	);
}

function Heading({ children, aside }: { children: ReactNode; aside?: string }) {
	return (
		<div className="mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
			<span className="flex-1">{children}</span>
			{aside ? <span className="font-mono tracking-normal normal-case">{aside}</span> : null}
		</div>
	);
}

// ───────────────────────────── Vue ─────────────────────────────

/** Ce qu'un tour de revue conclut, en deux mots. */
const VERDICT_TONES: Record<string, string> = {
	merge: "text-success",
	corrections: "text-warning",
	bloquant: "text-critical",
};

/**
 * La vue de branche, en trois lignes : la PR, le ticket, la revue.
 *
 * Une seule ligne « PR #2056 ouverte » obligeait à ouvrir la vue pour savoir où
 * en était le ticket ou si la revue demandait quelque chose. Chacune a sa
 * ligne, lisible sans rien survoler, et s'ouvre seule dans son panneau : la
 * vue entière les montrait toutes au même endroit, il fallait encore chercher.
 * L'en-tête, lui, ouvre toujours la vue entière.
 */
function BranchTile({
	satellites,
	active,
	open,
	onPick,
}: {
	satellites: Satellites;
	active: boolean;
	open: TileId | null;
	/** Ouvre le panneau d'une ligne, ou le referme s'il l'était déjà. */
	onPick: (tile: TileId) => void;
}) {
	const { t } = useTranslation("components2");
	const selected = open === "branch";
	const { worktrees, activeProject, missions } = useCockpit();
	const { group } = satellites;
	const cwd = group.cwd;
	const tree = worktrees.find((entry) => entry.path === cwd) ?? null;
	const branch = tree?.branch ?? group.label;
	const options = { enabled: active };

	// Ce que la vue montre encore au-delà de la PR : une ligne par carte qui a
	// quelque chose à dire, pour ne rien avoir à chercher dans la vue entière.
	const mission = group.mission ? (missions.find((entry) => entry.id === group.mission?.id) ?? null) : null;
	const docs = useAsync(() => api.docs.scan([[cwd, branch]], 40).catch(() => []), [cwd], { ...options, pollMs: 60_000 });
	const qa = useAsync(() => api.worktrees.qa(cwd).catch(() => []), [cwd], { ...options, pollMs: 60_000 });
	const ports = useAsync(() => api.system.ports().catch(() => []), [cwd], { ...options, pollMs: 20_000 });
	const captures = (qa.data ?? []).filter((file) => file.kind === "image" || file.kind === "video").length;
	const servers = (ports.data ?? []).filter((port) => port.cwd === cwd || port.cwd.startsWith(`${cwd}/`));
	const working = group.runs.filter((run) => run.thinking).length;
	const ahead = tree?.status?.ahead ?? 0;

	const prs = useAsync(() => api.git.pullRequests().catch(() => []), [activeProject?.id], { ...options, pollMs: 120_000 });
	const openPr = (prs.data ?? []).find((pr) => pr.headRef === branch) ?? null;
	const past = useAsync(
		() => (openPr || !branch ? Promise.resolve(null) : api.reviews.branchPr(branch).catch(() => null)),
		[branch, Boolean(openPr)],
		options,
	);
	const changes = useAsync(() => api.worktrees.changes(cwd).catch(() => []), [cwd], { ...options, pollMs: 15_000 });

	const number = openPr?.number ?? past.data?.number ?? null;
	const state = openPr
		? openPr.isDraft
			? t("workspaceTiles.branch.prDraft")
			: t("workspaceTiles.branch.prOpen")
		: past.data?.state === "merged"
			? t("workspaceTiles.branch.prMerged")
			: past.data?.state === "closed"
				? t("workspaceTiles.branch.prClosed")
				: null;
	const failing = openPr?.ciState === "failing";
	const pending = changes.data?.length ?? 0;

	// Le ticket se retrouve par son identifiant, dans le nom de la branche ou dans la PR.
	const teamKey = activeProject?.linearTeamKey?.toUpperCase() ?? "";
	const ticketId = useMemo(() => {
		const prefixes = new Set(teamKey ? [teamKey] : []);
		return [...ticketsIn(branch, prefixes), ...(openPr?.linearIds ?? []).map((id) => id.toUpperCase())][0] ?? null;
	}, [branch, teamKey, openPr?.linearIds]);
	const ticket = useAsync(
		() => (ticketId ? api.feeds.linearIssue(ticketId).catch(() => null) : Promise.resolve(null)),
		[ticketId],
		options,
	);

	const { review } = useReview(number);
	const round = review?.rounds[review.rounds.length - 1] ?? null;
	const verdict = round
		? VERDICT_TONES[round.verdict]
			? { label: t(`workspaceTiles.verdict.${round.verdict}`), tone: VERDICT_TONES[round.verdict] }
			: { label: round.verdict, tone: "text-ink-muted" }
		: null;
	const moved = Boolean(review && openPr && movedSince(review, openPr.headSha));

	const alert = failing || openPr?.reviewDecision === "CHANGES_REQUESTED" || round?.verdict === "bloquant";

	return (
		<div
			className={clsx(
				"flex flex-col gap-0.5 rounded-xl bg-surface p-2.5 shadow-[var(--shadow-card)] transition-shadow hover:shadow-pop",
				selected ? "ring-2 ring-accent" : alert && "ring-1 ring-warning/60",
			)}
		>
			<button
				type="button"
				onClick={() => onPick("branch")}
				title={t("workspaceTiles.branch.headerTitle")}
				className="focus-ring mb-0.5 flex w-full items-center gap-1.5 rounded text-left"
			>
				<LayoutDashboard size={12} className={selected ? "text-accent" : "text-ink-faint"} />
				<span className="font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">{t("workspaceTiles.branch.label")}</span>
				<span className="ml-auto truncate text-[10.5px] text-ink-faint">{t("workspaceTiles.branch.seeAll")}</span>
			</button>
			<Line
				icon={GitPullRequest}
				title={t("workspaceTiles.tiles.pr.title")}
				selected={open === "pr"}
				onPick={() => onPick("pr")}
				aside={
					openPr ? (
						<span className={clsx("flex items-center gap-1", failing && "text-critical")}>
							<Dot tone={failing ? "critical" : openPr.ciState === "success" ? "success" : "neutral"} />
							{failing
								? t("workspaceTiles.branch.ciRed")
								: openPr.ciState === "success"
									? t("workspaceTiles.branch.ciGreen")
									: t("workspaceTiles.branch.ciPending")}
						</span>
					) : null
				}
			>
				{prs.initial && active ? (
					<span className="text-ink-faint">{t("workspaceTiles.branch.searchingPr")}</span>
				) : number ? (
					`#${number} ${state ?? ""}`
				) : (
					<span className="text-ink-faint">{t("workspaceTiles.branch.noPr")}</span>
				)}
			</Line>
			<Line
				icon={Ticket}
				title={ticket.data ? ticket.data.title : t("workspaceTiles.tiles.ticket.title")}
				selected={open === "ticket"}
				onPick={() => onPick("ticket")}
				aside={ticket.data?.state ? <span className="truncate">{ticket.data.state.name}</span> : null}
			>
				{ticketId ?? <span className="text-ink-faint">{t("workspaceTiles.branch.noTicket")}</span>}
			</Line>
			<Line
				icon={ClipboardCheck}
				title={t("workspaceTiles.branch.reviewTitle")}
				selected={open === "review"}
				onPick={() => onPick("review")}
				aside={
					moved ? (
						<span className="text-warning">{t("workspaceTiles.branch.recheck")}</span>
					) : verdict ? (
						<span className={verdict.tone}>{verdict.label}</span>
					) : null
				}
			>
				{round ? (
					t("workspaceTiles.branch.reviewRound", { number: round.number })
				) : (
					<span className="text-ink-faint">{t("workspaceTiles.branch.notReviewed")}</span>
				)}
			</Line>
			{mission ? (
				<Line
					icon={ListChecks}
					title={mission.title}
					selected={open === "mission"}
					onPick={() => onPick("mission")}
					aside={<span className="truncate">{MISSION_STATE_LABELS[mission.state]}</span>}
				>
					{t("workspaceTiles.branch.mission")}
				</Line>
			) : null}
			<Line
				icon={Bot}
				title={t("workspaceTiles.branch.agentsTitle")}
				selected={open === "agents"}
				onPick={() => onPick("agents")}
				aside={working > 0 ? <span className="text-success">{t("workspaceTiles.branch.working", { count: working })}</span> : null}
			>
				{t("workspaceTiles.branch.agents", { count: group.runs.length })}
				{group.terminals.length > 0 ? ` · ${t("workspaceTiles.branch.terminals", { count: group.terminals.length })}` : ""}
			</Line>
			<Line
				icon={GitCommitHorizontal}
				title={t("workspaceTiles.branch.commitsTitle")}
				selected={open === "commits"}
				onPick={() => onPick("commits")}
				aside={pending > 0 ? <span className="text-warning">{t("workspaceTiles.branch.uncommitted", { count: pending })}</span> : null}
			>
				{ahead > 0 ? t("workspaceTiles.branch.commits", { count: ahead }) : t("workspaceTiles.branch.commitsLabel")}
			</Line>
			{(docs.data ?? []).length > 0 ? (
				<Line icon={FileText} title={t("workspaceTiles.tiles.docs.title")} selected={open === "docs"} onPick={() => onPick("docs")}>
					{t("workspaceTiles.branch.documents", { count: (docs.data ?? []).length })}
				</Line>
			) : null}
			{captures > 0 ? (
				<Line icon={ImageIcon} title={t("workspaceTiles.tiles.captures.title")} selected={open === "captures"} onPick={() => onPick("captures")}>
					{t("workspaceTiles.branch.captures", { count: captures })}
				</Line>
			) : null}
			{servers.length > 0 ? (
				<Line
					icon={Network}
					title={t("workspaceTiles.branch.portsTitle")}
					selected={open === "ports"}
					onPick={() => onPick("ports")}
					aside={<span className="font-mono">:{servers[0].port}</span>}
				>
					{t("workspaceTiles.branch.servers", { count: servers.length })}
				</Line>
			) : null}
		</div>
	);
}

/** Une ligne de la tuile : ce dont elle parle à gauche, où ça en est à droite. */
function Line({
	icon: Icon,
	title,
	aside,
	selected,
	onPick,
	children,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>;
	title: string;
	aside?: ReactNode;
	/** Son panneau est ouvert. */
	selected: boolean;
	onPick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onPick}
			title={title}
			className={clsx(
				"focus-ring -mx-1 flex items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] text-ink",
				selected ? "bg-accent-dim ring-1 ring-accent/50" : "hover:bg-hover",
			)}
		>
			<Icon size={11} className={clsx("shrink-0", selected ? "text-accent" : "text-ink-faint")} />
			<span className="min-w-0 flex-1 truncate">{children}</span>
			<span className="flex max-w-[84px] shrink-0 items-center text-[10.5px] text-ink-muted">{aside}</span>
		</button>
	);
}

// ───────────────────────────── Territoire ─────────────────────────────

/** Le dossier d'un fichier, à deux crans de profondeur : la zone qu'on reconnaît. */
function zoneOf(path: string): string {
	const parts = path.split("/");
	return parts.length <= 1 ? "." : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

const SKETCH = { w: 168, h: 52 };

function TerritoryTile({
	satellites,
	runId,
	active,
	selected,
	onPick,
}: {
	satellites: Satellites;
	runId: string;
	active: boolean;
	selected: boolean;
	onPick: () => void;
}) {
	const { t } = useTranslation("components2");
	const { group } = satellites;
	const index = group.runs.findIndex((run) => run.id === runId);
	const run = index >= 0 ? group.runs[index] : null;
	const turns = run?.turns;

	// Les zones où cet agent a lu ou écrit, pesées par le nombre de fichiers.
	const { zones, written, read } = useMemo(() => {
		const files = new Map<string, boolean>();
		if (run) {
			for (const touch of touchesOf(run)) {
				if (touch.kind === "search") continue;
				const path = relativeTo(run.cwd, touch.path);
				if (path === null) continue;
				files.set(path, files.get(path) === true || touch.kind === "write");
			}
		}
		const byZone = new Map<string, { name: string; bytes: number; writes: number }>();
		for (const [path, wrote] of files) {
			const name = zoneOf(path);
			const zone = byZone.get(name) ?? { name, bytes: 0, writes: 0 };
			zone.bytes += 1;
			if (wrote) zone.writes += 1;
			byZone.set(name, zone);
		}
		const ranked = [...byZone.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 14);
		const wrote = [...files.values()].filter(Boolean).length;
		return {
			zones: squarify(ranked, { x: 0, y: 0, w: SKETCH.w, h: SKETCH.h }),
			written: wrote,
			read: files.size - wrote,
		};
		// Les tours d'un agent sont remplacés, jamais modifiés : ils servent de clé.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [turns, run?.cwd]);

	const clashes = useMemo(
		() => findCollisions(group.runs).filter((entry) => entry.writers.some((writer) => writer.runId === runId)).length,
		[group.runs, runId],
	);

	const paths = useMemo(() => pathsToStamp(group.runs), [group.runs]);
	const stamps = useAsync(() => api.chantier.stamps(paths), [paths.join("\n")], {
		enabled: active && paths.length > 0,
		pollMs: 10_000,
	});
	const stale = useMemo(() => {
		const map = new Map<string, number | null>();
		for (const stamp of stamps.data ?? []) map.set(stamp.path, stamp.modifiedMs);
		return staleness(group.runs, map).filter((entry) => entry.runId === runId).length;
	}, [group.runs, stamps.data, runId]);

	const color = agentColor(Math.max(0, index));

	return (
		<Tile
			icon={LayoutGrid}
			label={t("workspaceTiles.territory.label")}
			selected={selected}
			alert={clashes > 0 || stale > 0}
			onPick={onPick}
			title={t("workspaceTiles.territory.title")}
			aside={
				clashes > 0 ? (
					<span className="flex items-center gap-1 text-critical">
						<AlertTriangle size={11} />
						{t("workspaceTiles.territory.collisions", { count: clashes })}
					</span>
				) : stale > 0 ? (
					<span className="flex items-center gap-1 text-warning">
						<AlertTriangle size={11} />
						{t("workspaceTiles.territory.stale", { count: stale })}
					</span>
				) : null
			}
		>
			{zones.length > 0 ? (
				<span className="relative block overflow-hidden rounded-md bg-raised" style={{ width: SKETCH.w, height: SKETCH.h }}>
					{zones.map((zone) => (
						<span
							key={zone.name}
							title={`${zone.name} — ${t("workspaceTiles.territory.files", { count: zone.bytes })}${zone.writes > 0 ? `, ${t("workspaceTiles.territory.written", { count: zone.writes })}` : ""}`}
							className="absolute overflow-hidden rounded-[3px] px-1 font-mono text-[8.5px] leading-[13px] whitespace-nowrap text-ink-muted"
							style={{
								left: zone.rect.x + 1,
								top: zone.rect.y + 1,
								width: Math.max(0, zone.rect.w - 2),
								height: Math.max(0, zone.rect.h - 2),
								background:
									zone.writes > 0
										? `color-mix(in srgb, ${color} ${Math.min(70, 28 + zone.writes * 8)}%, transparent)`
										: "color-mix(in srgb, var(--color-ink-faint) 16%, transparent)",
							}}
						>
							{zone.rect.w > 44 && zone.rect.h > 14 ? zone.name : ""}
						</span>
					))}
				</span>
			) : (
				<span className="text-[11px] text-ink-faint">{t("workspaceTiles.territory.untouched")}</span>
			)}
			{zones.length > 0 ? (
				<span className="text-[10.5px] text-ink-faint">
					{t("workspaceTiles.territory.written", { count: written })} · {t("workspaceTiles.territory.read", { count: read })}
					{group.runs.length > 1 ? ` · ${t("workspaceTiles.territory.agentsHere", { count: group.runs.length })}` : ""}
				</span>
			) : null}
		</Tile>
	);
}

// ───────────────────────────── Navigateur ─────────────────────────────

/** La largeur à laquelle la capture est réduite avant d'être dessinée. */
const THUMB = 336;

function BrowserTile({
	satellites,
	runId,
	active,
	selected,
	onPick,
}: {
	satellites: Satellites;
	runId: string;
	/** La tuile capture : la carte est à l'écran, et la page n'est pas agrandie. */
	active: boolean;
	selected: boolean;
	onPick: () => void;
}) {
	const { t } = useTranslation("components2");
	const { group, driving } = satellites;
	const cwd = group.cwd;
	const canvas = useRef<HTMLCanvasElement>(null);
	const [url, setUrl] = useState<string | null>(null);
	const busy = driving !== null;

	// Une image de loin en loin, jamais un flux : douze images par seconde sur
	// chaque carte, c'est ce qui faisait ramer l'app. La suivante n'est demandée
	// qu'une fois la précédente dessinée, plus souvent quand un agent pilote.
	useEffect(() => {
		if (!active) return;
		let alive = true;
		let timer = 0;
		const draw = (source: CanvasImageSource, width: number, height: number) => {
			const node = canvas.current;
			if (!node) return;
			node.width = THUMB;
			node.height = Math.round((THUMB * height) / width);
			node.getContext("2d")?.drawImage(source, 0, 0, node.width, node.height);
		};
		if (isPreview()) {
			const sample = new Image();
			sample.onload = () => {
				if (!alive) return;
				draw(sample, PREVIEW_PAGE.width, PREVIEW_PAGE.height);
				setUrl(PREVIEW_PAGE.url);
			};
			sample.src = PREVIEW_PAGE.src;
			return () => {
				alive = false;
			};
		}
		const look = async () => {
			try {
				const block = await api.browser.snapshot(cwd);
				if (!alive) return;
				if (block.byteLength < 4) {
					setUrl(null);
				} else {
					const length = new DataView(block).getUint32(0, true);
					const head = JSON.parse(new TextDecoder().decode(new Uint8Array(block, 4, length))) as { url: string };
					// Décodée puis relâchée aussitôt : rien ne reste dans le cache du moteur.
					const bitmap = await createImageBitmap(new Blob([new Uint8Array(block, 4 + length)], { type: "image/jpeg" }));
					if (alive) {
						draw(bitmap, bitmap.width, bitmap.height);
						setUrl(head.url);
					}
					bitmap.close();
				}
			} catch {
				if (alive) setUrl(null);
			}
			if (alive) timer = window.setTimeout(look, busy ? 2500 : 8000);
		};
		void look();
		return () => {
			alive = false;
			window.clearTimeout(timer);
		};
	}, [active, cwd, busy]);

	const mine = driving?.runId === runId;
	const blank = url === null || url === "" || url === "about:blank";

	return (
		<Tile
			icon={Globe}
			label={t("workspaceTiles.browser.label")}
			selected={selected}
			onPick={onPick}
			title={t("workspaceTiles.browser.title")}
			aside={
				selected ? (
					<>
						<Dot tone="success" pulse />
						{t("workspaceTiles.browser.live")}
					</>
				) : driving ? (
					<>
						<Dot tone="info" pulse />
						{mine ? t("workspaceTiles.browser.drivingSelf") : t("workspaceTiles.browser.drivingOther", { name: driving.label })}
					</>
				) : null
			}
		>
			{selected ? (
				<span className="text-[11px] text-ink-faint">{t("workspaceTiles.browser.openRight")}</span>
			) : blank ? (
				<span className="text-[11px] text-ink-faint">{t("workspaceTiles.browser.blank")}</span>
			) : null}
			{/* Toujours monté : l'image s'y dessine avant qu'on sache s'il faut la montrer. */}
			<canvas
				ref={canvas}
				className={clsx("w-full rounded-md bg-raised object-cover object-top", selected || blank ? "hidden" : "block")}
				style={{ aspectRatio: "16 / 10" }}
			/>
			{selected || blank ? null : (
				<span className="w-full truncate font-mono text-[10px] text-ink-faint">{url?.replace(/^https?:\/\//, "")}</span>
			)}
		</Tile>
	);
}
