import clsx from "clsx";
import {
	AlertTriangle,
	FileText,
	Gauge as Gauge2,
	GitMerge,
	GitPullRequest,
	Layers,
	ListChecks,
	RefreshCw,
	Rocket,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BarList, Gauge, Sparkline, StackedBar } from "@/components/Charts";
import {
	Button,
	Chips,
	type ChipItem,
	Dot,
	Empty,
	LoadingBar,
	Skeleton,
	SkeletonRows,
	ViewHeader,
	prChips,
} from "@/components/ui";
import { compactNumber, fromIso, fromTimestamp } from "@/lib/format";
import { api } from "@/lib/ipc";
import { awaitsHuman } from "@/lib/missions";
import { useAsync } from "@/lib/useAsync";
import { ProjectsHealth } from "@/components/ProjectsHealth";
import { PrActions } from "@/components/actions";
import { useAllSessions, useCockpit } from "@/app/store";

const BASE_BRANCHES = new Set(["dev", "main", "master", "stage"]);

function Tile({
	label,
	value,
	tone,
	hint,
	onClick,
}: {
	label: string;
	value: number | string;
	tone?: "critical" | "warning" | "success" | "info";
	hint?: string;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={!onClick}
			className={clsx(
				"panel flex min-w-0 flex-col gap-0.5 px-3 py-2 text-left",
				onClick && "transition-colors hover:border-line",
			)}
		>
			<span className="truncate text-[10px] tracking-[0.06em] text-ink-faint uppercase">
				{label}
			</span>
			<span
				className={clsx(
					"font-mono text-[19px] leading-none font-semibold tabular-nums",
					tone === "critical" && "text-critical",
					tone === "warning" && "text-warning",
					tone === "success" && "text-success",
					tone === "info" && "text-info",
					!tone && "text-ink",
				)}
			>
				{value}
			</span>
			{hint ? <span className="truncate text-[10px] text-ink-faint">{hint}</span> : null}
		</button>
	);
}

/**
 * La silhouette d'un compteur.
 *
 * Les tuiles ne s'affichent que si leur valeur dépasse zéro — ce qui, pendant
 * le chargement, les masque toutes : l'écran paraissait vide, puis se peuplait
 * d'un coup. Quatre silhouettes au même gabarit disent qu'on compte encore.
 */
function TileSkeleton() {
	return (
		<div className="panel flex w-[11rem] flex-col gap-1.5 px-3 py-2">
			<Skeleton className="h-2.5 w-20" />
			<Skeleton className="h-4 w-10" />
		</div>
	);
}

function Panel({
	title,
	count,
	icon: Icon,
	action,
	loading,
	rows = 3,
	children,
}: {
	title: string;
	count?: number;
	icon: React.ComponentType<{ size?: number; className?: string }>;
	action?: React.ReactNode;
	/**
	 * Vrai tant que la première réponse n'est pas arrivée.
	 *
	 * Sans cette distinction, un bloc affichait « Aucune erreur critique » avant
	 * même d'avoir interrogé Sentry, puis se remplissait : on lisait une réponse
	 * rassurante qui n'en était pas une, et l'écran semblait sauter tout seul.
	 * Une silhouette dit la même chose honnêtement — ça arrive.
	 */
	loading?: boolean;
	/** Hauteur de la silhouette : autant de lignes que le bloc en montre. */
	rows?: number;
	children: React.ReactNode;
}) {
	return (
		<section className="panel flex min-h-0 flex-col p-3">
			<div className="mb-2 flex items-center gap-1.5">
				<Icon size={12} className="shrink-0 text-ink-faint" />
				<h2 className="text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
					{title}
				</h2>
				{/* Le compteur se tait pendant le chargement : « 0 » est une
				    affirmation, et elle est fausse une fois sur deux. */}
				{count !== undefined && !loading ? (
					<span className="font-mono text-[10px] text-ink-faint/70">{count}</span>
				) : null}
				<div className="ml-auto">{action}</div>
			</div>
			{loading ? <SkeletonRows rows={rows} className="px-1 py-1" /> : children}
		</section>
	);
}


function Line({
	primary,
	secondary,
	trailing,
	tone,
	chips,
	onClick,
	action,
}: {
	primary: string;
	secondary?: string;
	trailing?: string;
	tone?: string;
	/** Repères de la ligne : labels d'une PR, priorité d'un ticket. */
	chips?: ChipItem[];
	onClick?: () => void;
	/**
	 * Action propre à la ligne, révélée au survol.
	 *
	 * Un bouton ne peut pas vivre dans un bouton : la ligne est donc un conteneur
	 * dont seule la zone de lecture est cliquable. Et l'action reste discrète —
	 * cet écran se lit d'abord, une rangée de boutons permanents en ferait un
	 * formulaire.
	 */
	action?: ReactNode;
}) {
	return (
		<div
			className={clsx(
				"group flex w-full items-center gap-2 rounded-lg px-1.5 py-1",
				onClick && "hover:bg-surface",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				disabled={!onClick}
				className="flex min-w-0 flex-1 items-center gap-2 text-left"
			>
				<span
					className={clsx(
						"min-w-0 flex-1 truncate text-[11px]",
						tone ?? "text-ink-muted",
					)}
				>
					{primary}
				</span>
				{chips ? <Chips items={chips} max={2} /> : null}
				{secondary ? (
					<span className="shrink-0 truncate text-[10px] text-ink-faint">{secondary}</span>
				) : null}
				{trailing ? (
					<span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
						{trailing}
					</span>
				) : null}
			</button>
			{action ? (
				<div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
					{action}
				</div>
			) : null}
		</div>
	);
}

/**
 * Ce qui attend une décision, avant tout le reste.
 *
 * L'écran d'accueil ne récapitule pas l'état du monde : il répond à « par quoi
 * je commence ». Les agents qui posent une question passent en premier — ce sont
 * les seuls blocages dont on est soi-même la cause.
 */
export function OverviewView() {
	const { t } = useTranslation("views");
	const { worktrees, worktreesLoading, go, notify, missions, missionsLoading } =
		useCockpit();
	const sessions = useAllSessions();

	// Ces flux sont facultatifs : une clé absente ne doit pas casser l'accueil.
	// La mémoire courte côté Rust évite qu'ils repartent sur le réseau à chaque
	// passage sur cet écran.
	const board = useAsync(() => api.team.board(true).catch(() => null), [], {
		pollMs: 180_000,
	});
	const prs = useAsync(() => api.git.pullRequests().catch(() => []), [], {
		pollMs: 180_000,
	});
	const sentry = useAsync(() => api.feeds.sentry("is:unresolved").catch(() => []), [], {
		pollMs: 180_000,
	});
	const usage = useAsync(() => api.sessions.usage().catch(() => null), [], {
		pollMs: 600_000,
	});

	const docs = useAsync(
		() =>
			api.docs
				.scan(
					worktrees.map(
						(tree) => [tree.path, tree.branch ?? tree.folderName] as [string, string],
					),
					40,
				)
				.catch(() => []),
		[worktrees.length],
		{ enabled: worktrees.length > 0 },
	);

	const waiting = sessions.filter(
		(session) => session.awaitingInput && session.idleSeconds < 3600,
	);
	const live = sessions.filter((session) => session.idleSeconds < 180);

	const ready = useMemo(
		() =>
			(prs.data ?? []).filter(
				(pr) =>
					!pr.isDraft &&
					pr.reviewDecision === "APPROVED" &&
					pr.ciState === "success" &&
					BASE_BRANCHES.has(pr.baseRef),
			),
		[prs.data],
	);
	const broken = useMemo(
		() => (prs.data ?? []).filter((pr) => !pr.isDraft && pr.ciState === "failing"),
		[prs.data],
	);
	const stacked = useMemo(
		() => (prs.data ?? []).filter((pr) => !BASE_BRANCHES.has(pr.baseRef)),
		[prs.data],
	);

	// Les missions vivantes : ni closes, ni abandonnées.
	const liveMissions = missions.filter(
		(mission) => !["done", "failed"].includes(mission.state),
	);

	const dirty = worktrees.filter(
		(tree) => tree.status.modified + tree.status.staged + tree.status.untracked > 0,
	);
	const redFlags = (board.data?.flags ?? []).filter((flag) => flag.severity === "red");
	const critical = (sentry.data ?? []).filter((issue) => issue.severity === "critical");

	// Jetons facturés par jour : entrée + sortie + écriture de cache. Le cache
	// relu est exclu, il ne se facture pas comme du texte produit.
	const usageDays = useMemo(() => {
		const days = usage.data?.byDay ?? [];
		return days.slice(-21).map((bucket) => ({
			key: bucket.key,
			value: bucket.totals.input + bucket.totals.output + bucket.totals.cacheWrite,
		}));
	}, [usage.data]);

	const prSegments = useMemo(() => {
		const list = prs.data ?? [];
		const drafts = list.filter((pr) => pr.isDraft).length;
		const review = list.length - ready.length - broken.length - stacked.length - drafts;
		return [
			{ label: t("overview.prSegments.ready"), value: ready.length, color: "var(--color-success)" },
			{ label: t("overview.prSegments.ciFailing"), value: broken.length, color: "var(--color-critical)" },
			{ label: t("overview.prSegments.stacked"), value: stacked.length, color: "var(--color-warning)" },
			{ label: t("overview.prSegments.inReview"), value: Math.max(0, review), color: "var(--color-ink-faint)" },
			{ label: t("overview.prSegments.drafts"), value: drafts, color: "var(--color-accent-dim)" },
		];
	}, [prs.data, ready.length, broken.length, stacked.length, t]);

	const errorsByProject = useMemo(() => {
		const counts = new Map<string, number>();
		for (const issue of sentry.data ?? []) {
			const project = issue.meta.find((field) => field.label === "projet")?.value ?? "—";
			counts.set(project, (counts.get(project) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([label, value]) => ({ label, value }))
			.sort((a, b) => b.value - a.value)
			.slice(0, 6);
	}, [sentry.data]);

	const reviewLoad = useMemo(
		() =>
			(board.data?.members ?? [])
				.filter((member) => member.role === "dev" && member.metrics.reviewPending > 0)
				.map((member) => ({
					label: member.name,
					value: member.metrics.reviewPending,
				}))
				.sort((a, b) => b.value - a.value),
		[board.data],
	);

	const cycle = useMemo(() => {
		const members = board.data?.members ?? [];
		return {
			done: members.reduce((sum, member) => sum + member.metrics.cycleDone, 0),
			total: members.reduce((sum, member) => sum + member.metrics.cycleTotal, 0),
		};
	}, [board.data]);




	const open = (url: string) => {
		if (url) void api.system.openUrl(url).catch((error) => notify(String(error)));
	};

	const loading = board.loading || prs.loading || sentry.loading;
	// « En cours de premier chargement » n'est pas « en train de rafraîchir » :
	// le premier justifie une silhouette, le second ne doit rien effacer.
	const boardLoading = board.initial && board.loading;
	const prsLoading = prs.initial && prs.loading;
	const sentryLoading = sentry.initial && sentry.loading;
	const docsLoading = docs.initial && docs.loading;
	// Les compteurs viennent de trois sources : tant qu'une manque, un « 0 »
	// affiché serait faux.
	const tilesLoading = prsLoading || sentryLoading || boardLoading;

	return (
		<>
			<ViewHeader
				title={t("overview.title")}
				subtitle={t("overview.subtitle")}
				actions={
					<>
						{/* Un cercle isolé en haut à droite ne disait pas ce qu'il
						    attendait ; le compte de sources encore en route, si. */}
						{loading ? (
							<span className="font-mono text-[10px] text-ink-faint">
								{loading && !tilesLoading && !docsLoading
									? t("overview.refreshing")
									: t("overview.sourcesLoading", {
											count: [boardLoading, prsLoading, sentryLoading, docsLoading].filter(
												Boolean,
											).length,
										})}
							</span>
						) : null}
						<Button
							size="sm"
							icon={RefreshCw}
							onClick={() => {
								void api.feeds.invalidate().finally(() => {
									board.reload();
									prs.reload();
									sentry.reload();
								});
							}}
						/>
					</>
				}
			/>

			{/* Le fil court sous l'en-tête pendant qu'une source travaille : il dit
			    que ça avance sans masquer ce qu'on lit déjà, là où le cercle
			    obligeait à deviner. */}
			<LoadingBar active={loading} />

			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<div className="flex max-w-7xl flex-col gap-4">
					{/* Le reste de l'écran ne parle que du projet actif : cette ligne
					    est le seul endroit d'où l'on voit les autres. */}
					<ProjectsHealth />
					{waiting.length > 0 ? (
						<button
							type="button"
							onClick={() => go("agents")}
							className="breathe flex items-center gap-2 rounded-xl border border-critical/25 bg-critical/8 px-3 py-2 text-left"
						>
							<Dot tone="critical" pulse />
							<span className="shrink-0 text-[12.5px] font-medium text-ink">
								{t("overview.waitingBanner", { count: waiting.length })}
							</span>
							<span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
								{waiting.map((session) => session.gitBranch ?? session.title).join(" · ")}
							</span>
						</button>
					) : null}

					{/* Ne s'affiche que ce qui a quelque chose à dire. Six compteurs dont
					    quatre à zéro occupaient toute la largeur sans rien apprendre, et
					    faisaient passer le seul chiffre qui comptait pour un détail parmi
					    d'autres. Les worktrees restent toujours là : ils disent l'état du
					    poste, pas un incident, et leur absence se lirait comme une panne. */}
					<div className="flex flex-wrap gap-2">
						{tilesLoading
							? [0, 1, 2, 3].map((index) => <TileSkeleton key={index} />)
							: null}
						{tilesLoading ? null : [
							{
								label: t("overview.tiles.liveAgents"),
								value: live.length,
								tone: live.length > 0 ? ("success" as const) : undefined,
								hint: waiting.length > 0 ? t("overview.tiles.waiting", { count: waiting.length }) : undefined,
								view: "agents" as const,
								always: false,
							},
							{
								label: t("overview.tiles.readyToMerge"),
								value: ready.length,
								tone: ready.length > 0 ? ("success" as const) : undefined,
								hint: undefined,
								view: "delivery" as const,
								always: false,
							},
							{
								label: t("overview.tiles.ciFailing"),
								value: broken.length,
								tone: broken.length > 0 ? ("critical" as const) : undefined,
								hint: undefined,
								view: "delivery" as const,
								always: false,
							},
							{
								label: t("overview.tiles.dailyBlockers"),
								value: redFlags.length,
								tone: redFlags.length > 0 ? ("critical" as const) : undefined,
								hint: undefined,
								view: "team" as const,
								always: false,
							},
							{
								label: t("overview.tiles.prodErrors"),
								value: critical.length,
								tone: critical.length > 0 ? ("warning" as const) : undefined,
								hint: undefined,
								view: "observability" as const,
								always: false,
							},
							{
								label: t("overview.tiles.activeWorktrees"),
								value: dirty.length,
								tone: undefined,
								hint: t("overview.tiles.total", { count: worktrees.length }),
								view: "worktrees" as const,
								always: true,
							},
						]
							.filter((tile) => tile.always || tile.value > 0)
							.map((tile, index) => (
								<div
									key={tile.label}
									className={clsx("rise w-[11rem]", index < 3 && `rise-${index + 1}`)}
								>
									<Tile
										label={tile.label}
										value={tile.value}
										tone={tile.tone}
										hint={tile.hint}
										onClick={() => go(tile.view)}
									/>
								</div>
							))}
					</div>

					<div className="columns-1 gap-3 lg:columns-2 xl:columns-3 [&>*]:mb-3 [&>*]:break-inside-avoid">
						<Panel
							title={t("overview.usage.title")}
							icon={Gauge2}
							loading={usage.initial && usage.loading}
							rows={4}
						>
							{usageDays.length > 1 ? (
								<>
									<Sparkline
										values={usageDays.map((day) => day.value)}
										labels={usageDays.map(
											(day) => t("overview.usage.dayLabel", { day: day.key, tokens: compactNumber(day.value) }),
										)}
									/>
									<p className="mt-1 text-[10px] text-ink-faint">
										{t("overview.usage.summary", {
											today: compactNumber(
												(usage.data?.today.input ?? 0) +
													(usage.data?.today.output ?? 0) +
													(usage.data?.today.cacheWrite ?? 0),
											),
											week: compactNumber(
												(usage.data?.last7Days.input ?? 0) +
													(usage.data?.last7Days.output ?? 0) +
													(usage.data?.last7Days.cacheWrite ?? 0),
											),
										})}
									</p>
								</>
							) : (
								<p className="px-1 py-2 text-[11px] text-ink-faint">
									{t("overview.usage.none")}
								</p>
							)}
						</Panel>

						{(prs.data ?? []).length > 0 ? (
							<Panel
								title={t("overview.prState")}
								icon={GitPullRequest}
								count={prs.data?.length}
								loading={prsLoading}
								rows={2}
							>
								<StackedBar segments={prSegments} />
							</Panel>
						) : null}

						<Panel title={t("overview.cycle.title")} icon={Rocket} loading={boardLoading} rows={2}>
							{cycle.total > 0 ? (
								<>
									<Gauge value={cycle.done} total={cycle.total} label={t("overview.cycle.ticketsDone")} />
									{reviewLoad.length > 0 ? (
										<div className="mt-2.5">
											<div className="mb-1 text-[10px] tracking-[0.06em] text-ink-faint uppercase">
												{t("overview.cycle.reviewLoad")}
											</div>
											<BarList rows={reviewLoad} />
										</div>
									) : null}
								</>
							) : (
								<p className="px-1 py-2 text-[11px] text-ink-faint">{t("overview.cycle.none")}</p>
							)}
						</Panel>
					</div>

					<div className="columns-1 gap-3 lg:columns-2 [&>*]:mb-3 [&>*]:break-inside-avoid">
						{/* Ce qui t'attend a quitté cet écran : il vit dans « Aujourd'hui »,
						    qui l'ordonne par ce qui bloque quoi. Le garder ici en donnait
						    une seconde version, moins complète, et laissait deux écrans
						    répondre à la même question sans jamais tout à fait pareil.

						    À sa place, ce qu'aucun écran ne montrait : où en sont les
						    missions. C'est pourtant le cœur de l'outil — du travail confié
						    à des agents, qui avance pendant qu'on regarde ailleurs. */}
						<Panel
							title={t("overview.missions.title")}
							icon={ListChecks}
							count={liveMissions.length}
							loading={missionsLoading}
						>
							{liveMissions.length === 0 ? (
								<p className="px-1 py-2 text-[11px] text-ink-faint">
									{t("overview.missions.none")}
								</p>
							) : (
								<div className="flex flex-col gap-0.5">
									{liveMissions.slice(0, 6).map((mission) => {
										const total = mission.tasks.length;
										const finies = mission.tasks.filter((task) =>
											["delivered", "integrated"].includes(task.state),
										).length;
										const actives = mission.tasks.filter(
											(task) => task.state === "running",
										).length;
										return (
											<Line
												key={mission.id}
												primary={mission.title}
												secondary={
													total > 0
													? t("overview.missions.delivered", { done: finies, total })
													: t("overview.missions.splitting")
												}
												trailing={actives > 0 ? t("overview.missions.running", { count: actives }) : undefined}
												tone={
													awaitsHuman(mission) ? "text-accent-soft" : undefined
												}
												onClick={() => go("missions", { missionId: mission.id })}
											/>
										);
									})}
								</div>
							)}
						</Panel>

						<Panel
							title={t("overview.production.title")}
							icon={AlertTriangle}
							count={critical.length}
							loading={sentryLoading}
						>
							{critical.length === 0 ? (
								<p className="px-1 py-2 text-[11px] text-ink-faint">
									{t("overview.production.none")}
								</p>
							) : (
								<div className="flex flex-col gap-0.5">
									{errorsByProject.length > 1 ? (
										<div className="mb-2">
											<BarList rows={errorsByProject} />
										</div>
									) : null}
									{critical.slice(0, 5).map((issue) => (
										<Line
											key={issue.id}
											primary={issue.title}
											secondary={
												issue.meta.find((field) => field.label === "projet")?.value
											}
											trailing={fromIso(issue.timestamp)}
											onClick={() => open(issue.url)}
										/>
									))}
								</div>
							)}
						</Panel>

						{broken.length + stacked.length > 0 ? (
						<Panel
							title={t("overview.prFlow.title")}
							icon={GitPullRequest}
							count={prs.data?.length}
							loading={prsLoading}
							rows={4}
							action={
								<Button size="sm" onClick={() => go("delivery")}>
									{t("overview.prFlow.see")}
								</Button>
							}
						>
							<div className="flex flex-col gap-0.5">
								{broken.slice(0, 4).map((pr) => (
									<Line
										key={pr.number}
										primary={`#${pr.number} ${pr.title}`}
										secondary={t("overview.prSegments.ciFailing")}
										chips={prChips(pr.labels)}
										tone="text-critical"
										onClick={() => open(pr.url)}
										action={
											<PrActions number={pr.number} headRef={pr.headRef} ciFailing />
										}
									/>
								))}
								{stacked.slice(0, 3).map((pr) => (
									<Line
										key={pr.number}
										primary={`#${pr.number} ${pr.title}`}
										secondary={t("overview.prFlow.stackedOn", { base: pr.baseRef })}
										chips={prChips(pr.labels)}
										tone="text-warning"
										onClick={() => open(pr.url)}
									/>
								))}
								{broken.length === 0 && stacked.length === 0 ? (
									<p className="px-1 py-2 text-[11px] text-ink-faint">
										{ready.length > 0
											? t("overview.prFlow.ready", { count: ready.length })
											: t("overview.prFlow.noneFailing")}
									</p>
								) : null}
							</div>
						</Panel>
						) : null}

						<Panel
							title={t("overview.fleet.title")}
							icon={Layers}
							count={dirty.length}
							loading={worktrees.length === 0 && worktreesLoading}
						>
							{dirty.length === 0 ? (
								<p className="px-1 py-2 text-[11px] text-ink-faint">
									{t("overview.fleet.allClean")}
								</p>
							) : (
								<div className="flex flex-col gap-0.5">
									{dirty.slice(0, 6).map((tree) => (
										<Line
											key={tree.path}
											primary={tree.branch ?? tree.folderName}
											secondary={t("overview.fleet.changes", {
												count: tree.status.modified + tree.status.staged + tree.status.untracked,
											})}
											trailing={fromTimestamp(tree.lastActivity)}
											onClick={() => go("worktrees", { worktreePath: tree.path })}
										/>
									))}
								</div>
							)}
						</Panel>

						{redFlags.length > 0 ? (
							<Panel
								title={t("overview.daily.title")}
								icon={Rocket}
								count={redFlags.length}
								loading={boardLoading}
								action={
									<Button size="sm" onClick={() => go("team")}>
										{t("overview.daily.button")}
									</Button>
								}
							>
								<div className="flex flex-col gap-0.5">
									{redFlags.slice(0, 6).map((flag) => (
										<Line
											key={flag.key}
											primary={flag.question}
											secondary={flag.member}
											tone="text-critical"
											onClick={() =>
												flag.prUrl || flag.ticketUrl
													? open(flag.prUrl ?? flag.ticketUrl ?? "")
													: go("team")
											}
										/>
									))}
								</div>
							</Panel>
						) : null}

						{(docs.data ?? []).length > 0 ? (
						<Panel
							title={t("overview.docs.title")}
							icon={FileText}
							count={docs.data?.length}
							loading={docsLoading}
						>
							{(docs.data ?? []).length === 0 ? (
								<p className="px-1 py-2 text-[11px] text-ink-faint">
									{t("overview.docs.none")}
								</p>
							) : (
								<div className="flex flex-col gap-0.5">
									{(docs.data ?? []).slice(0, 6).map((doc) => (
										<Line
											key={doc.path}
											primary={doc.name}
											secondary={doc.worktree}
											trailing={fromTimestamp(doc.modified)}
											onClick={() => go("docs", { docPath: doc.path })}
										/>
									))}
								</div>
							)}
						</Panel>
						) : null}
					</div>

					{board.data?.githubError ? (
						<p className="text-center text-[10px] text-ink-faint">
							{t("overview.githubError", { error: board.data.githubError })}
						</p>
					) : null}

					{worktrees.length === 0 && sessions.length === 0 && !loading ? (
						<Empty
							icon={GitMerge}
							message={t("overview.empty.message")}
							hint={t("overview.empty.hint")}
						/>
					) : null}
				</div>
			</div>
		</>
	);
}
