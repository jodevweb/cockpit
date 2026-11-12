import clsx from "clsx";
import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	CircleDot,
	Layers,
	Play,
	RefreshCw,
	Rocket,
	Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Badge,
	Button,
	Empty,
	ErrorNote,
	MissingConnector,
	PrLabels,
	PriorityBadge,
	Section,
	Spinner,
	ViewHeader,
} from "@/components/ui";
import { api } from "@/lib/ipc";
import type { Flag, MemberBoard, MemberPr, PrFlowItem } from "@/lib/types";
import { DailyPresenter } from "@/components/DailyPresenter";
import { TeamWorkGrid } from "@/components/TeamWorkGrid";
import { useAsync, usePersistentState } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

function useOpenUrl() {
	const { notify } = useCockpit();
	// Un lien qui ne s'ouvre pas doit le dire : avalé, l'échec ressemble à un
	// bouton mort.
	return (url: string) => {
		if (!url) return;
		void api.system.openUrl(url).catch((error) => notify(String(error)));
	};
}

/** Un lien externe rendu comme du texte : la board est faite de liens. */
function Link({
	children,
	url,
	className,
}: {
	children: React.ReactNode;
	url: string;
	className?: string;
}) {
	const open = useOpenUrl();
	return (
		<button
			type="button"
			onClick={() => open(url)}
			className={clsx("text-left hover:underline", className)}
		>
			{children}
		</button>
	);
}

function Chip({
	label,
	value,
	tone,
}: {
	label: string;
	value: number | string;
	tone?: "critical" | "warning" | "success" | "info";
}) {
	return (
		<div className="panel flex min-w-24 flex-col gap-0.5 px-2.5 py-1.5">
			<span className="text-[10px] tracking-[0.06em] text-ink-faint uppercase">
				{label}
			</span>
			<span
				className={clsx(
					"font-mono text-[14px] leading-none font-semibold tabular-nums",
					tone === "critical" && "text-critical",
					tone === "warning" && "text-warning",
					tone === "success" && "text-success",
					tone === "info" && "text-info",
					!tone && "text-ink",
				)}
			>
				{value}
			</span>
		</div>
	);
}

// ──────────────────────────────── À traiter ────────────────────────────────

function FlagCard({ flag }: { flag: Flag }) {
	const [open, setOpen] = useState(false);
	const expandable = flag.items.length > 1;
	const red = flag.severity === "red";

	return (
		<div
			className={clsx(
				"rounded-xl border p-2.5",
				red ? "border-critical/25 bg-critical/8" : "border-warning/20 bg-warning/6",
			)}
		>
			<div className="flex items-start gap-2">
				<button
					type="button"
					disabled={!expandable}
					onClick={() => setOpen((value) => !value)}
					className="flex min-w-0 flex-1 items-start gap-2 text-left"
				>
					{expandable ? (
						open ? (
							<ChevronDown size={12} className="mt-0.5 shrink-0 text-ink-faint" />
						) : (
							<ChevronRight size={12} className="mt-0.5 shrink-0 text-ink-faint" />
						)
					) : (
						<CircleDot
							size={12}
							className={clsx("mt-0.5 shrink-0", red ? "text-critical" : "text-warning")}
						/>
					)}
					<div className="min-w-0 flex-1">
						<p className="text-selectable text-[11px] leading-snug text-ink">
							<span className="font-semibold">{flag.member}</span> — {flag.question}
						</p>
					</div>
				</button>
				<div className="flex shrink-0 items-center gap-1.5">
					{expandable ? <Badge>×{flag.items.length}</Badge> : null}
					{flag.prUrl ? (
						<Link url={flag.prUrl} className="font-mono text-[10px] text-ink-faint">
							#{flag.prNumber} ↗
						</Link>
					) : flag.ticketUrl ? (
						<Link url={flag.ticketUrl} className="font-mono text-[10px] text-ink-faint">
							{flag.ticketId} ↗
						</Link>
					) : null}
				</div>
			</div>

			{open ? (
				<div className="mt-2 flex flex-col gap-0.5 border-t border-line-soft pt-2 pl-5">
					{flag.items.map((item) => (
						<Link
							key={item.url + item.label}
							url={item.url}
							className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface"
						>
							<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">
								{item.label}
							</span>
							<span className="shrink-0 font-mono text-[10px] text-ink-faint">
								{item.meta}
							</span>
						</Link>
					))}
				</div>
			) : null}
		</div>
	);
}

// ───────────────────────────────── Flux PR ─────────────────────────────────

function PrLine({ pr, note }: { pr: PrFlowItem; note?: string }) {
	return (
		<Link
			url={pr.url}
			className="flex w-full items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface"
		>
			<span className="shrink-0 font-mono text-[10px] text-ink-faint">#{pr.number}</span>
			<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
				{pr.title}
			</span>
			<PrLabels labels={pr.labels} max={2} />
			{note ? <span className="shrink-0 text-[10px] text-warning">{note}</span> : null}
			<span className="shrink-0 text-[10px] text-ink-faint">{pr.author}</span>
		</Link>
	);
}

// ──────────────────────────────── Membre ────────────────────────────────

const CI_MARK: Record<string, { label: string; className: string }> = {
	failing: { label: "CI ✗", className: "text-critical" },
	pending: { label: "CI …", className: "text-warning" },
	success: { label: "CI ✓", className: "text-success" },
	none: { label: "", className: "" },
};

const DECISION_KEY: Record<string, string> = {
	APPROVED: "team.decision.approved",
	CHANGES_REQUESTED: "team.decision.changesRequested",
	REVIEW_REQUIRED: "team.decision.reviewRequired",
};

function PrRow({ pr }: { pr: MemberPr }) {
	const { t } = useTranslation("views");
	const ci = CI_MARK[pr.ciState] ?? CI_MARK.none;
	return (
		<Link
			url={pr.url}
			className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface"
		>
			<span className="shrink-0 font-mono text-[10px] text-ink-faint">#{pr.number}</span>
			<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">{pr.title}</span>
			<PrLabels labels={pr.labels} max={2} />
			{pr.isDraft ? <Badge>{t("team.draft")}</Badge> : null}
			{pr.stacked ? (
				<span className="shrink-0 text-[10px] text-critical">← {pr.baseRef}</span>
			) : null}
			{ci.label ? (
				<span className={clsx("shrink-0 font-mono text-[10px]", ci.className)}>
					{ci.label}
				</span>
			) : null}
			{DECISION_KEY[pr.reviewDecision] ? (
				<span className="shrink-0 text-[10px] text-ink-faint">
					{t(DECISION_KEY[pr.reviewDecision])}
				</span>
			) : null}
			<span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
				{t("team.ageDays", { count: pr.ageDays })}
			</span>
		</Link>
	);
}

function MemberCard({ member, expanded }: { member: MemberBoard; expanded: boolean }) {
	// La colonne « bloqué » porte le nom que l'équipe lui a donné dans Linear :
	// « Blocked » chez nous, mais rien ne l'impose ailleurs.
	const { config } = useCockpit();
	const { t } = useTranslation("views");
	const blockedState = config?.workflow.blockedState ?? "";
	const { metrics } = member;
	const tickets = [...member.activeTickets, ...member.reviewTickets];
	const shown = expanded ? tickets : tickets.slice(0, 3);
	const merged = member.delta.filter((item) => item.kind === "merged");

	return (
		<div className="panel flex flex-col gap-2.5 p-3">
			<div className="flex items-baseline gap-2">
				<h3 className="text-[13px] font-semibold text-ink">{member.name}</h3>
				<span className="text-[10px] text-ink-faint">{member.roleLabel}</span>
				{metrics.cycleTotal > 0 ? (
					<span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
						{t("team.member.cycle", { done: metrics.cycleDone, total: metrics.cycleTotal })}
					</span>
				) : null}
			</div>

			<p className="text-selectable text-[11px] leading-relaxed text-ink-muted">
				{member.narrative.text}
			</p>

			{member.narrative.current.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{member.narrative.current.map((theme) => (
						<Badge key={theme.label}>
							{theme.label} ×{theme.count}
						</Badge>
					))}
					{member.narrative.shipped.map((theme) => (
						<Badge key={`done-${theme.label}`} tone="success">
							✓ {theme.label}
						</Badge>
					))}
				</div>
			) : null}

			<div className="flex flex-wrap gap-1.5">
				<Chip
					label={t("team.chip.wip")}
					value={metrics.activeWip}
					tone={metrics.activeWip >= 4 ? "warning" : undefined}
				/>
				<Chip label={t("team.chip.review")} value={metrics.inReview} />
				<Chip label={t("team.chip.prs")} value={metrics.openPrs} />
				<Chip
					label={t("team.chip.toReview")}
					value={metrics.reviewPending}
					tone={metrics.reviewPending > 0 ? "info" : undefined}
				/>
				<Chip
					label={t("team.chip.merged")}
					value={metrics.mergedSinceDaily}
					tone={metrics.mergedSinceDaily > 0 ? "success" : undefined}
				/>
			</div>

			{shown.length > 0 ? (
				<div className="flex flex-col gap-0.5">
					{shown.map((ticket) => (
						<Link
							key={ticket.identifier}
							url={ticket.url}
							className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface"
						>
							<span className="shrink-0 font-mono text-[10px] text-ink-faint">
								{ticket.identifier}
							</span>
							<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
								{ticket.title}
							</span>
							<PriorityBadge priority={ticket.priority} label={ticket.priorityLabel} />
							<span
								className={clsx(
									"shrink-0 text-[10px]",
									blockedState && ticket.stateName === blockedState
										? "text-critical"
										: "text-ink-faint",
								)}
							>
								{ticket.stateName}
							</span>
							<span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
								{ticket.progress}% · {t("team.ageDays", { count: ticket.ageDays })}
							</span>
						</Link>
					))}
					{!expanded && tickets.length > shown.length ? (
						<span className="px-1.5 text-[10px] text-ink-faint">
							{t("team.member.more", { count: tickets.length - shown.length })}
						</span>
					) : null}
				</div>
			) : null}

			{expanded ? (
				<>
					{member.prs.length > 0 ? (
						<Section title={t("team.member.openPrs")} count={member.prs.length}>
							<div className="flex flex-col gap-0.5">
								{member.prs.map((pr) => (
									<PrRow key={pr.number} pr={pr} />
								))}
							</div>
						</Section>
					) : null}

					{member.reviewInbox.length > 0 ? (
						<Section title={t("team.member.reviewInbox")} count={member.reviewInbox.length}>
							<div className="flex flex-col gap-0.5">
								{member.reviewInbox.map((item) => (
									<Link
										key={item.number}
										url={item.url}
										className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface"
									>
										<span className="shrink-0 font-mono text-[10px] text-ink-faint">
											#{item.number}
										</span>
										<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
											{item.title}
										</span>
										<PrLabels labels={item.labels} max={2} />
										<span className="shrink-0 text-[10px] text-ink-faint">
											{t("team.member.reviewFrom", {
												author: item.author,
												age: t("team.ageDays", { count: item.ageDays }),
											})}
										</span>
									</Link>
								))}
							</div>
						</Section>
					) : null}

					{merged.length > 0 ? (
						<Section title={t("team.member.shipped")} count={merged.length}>
							<div className="flex flex-col gap-0.5">
								{merged.map((item) => (
									<Link
										key={item.url}
										url={item.url}
										className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface"
									>
										<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
											{item.label}
										</span>
										<PrLabels labels={item.labels} max={2} />
									</Link>
								))}
							</div>
						</Section>
					) : null}

					{member.next.length > 0 ? (
						<Section title={t("team.member.next")}>
							<div className="flex flex-col gap-0.5">
								{member.next.map((ticket) => (
									<Link
										key={ticket.identifier}
										url={ticket.url}
										className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface"
									>
										<span className="shrink-0 font-mono text-[10px] text-ink-faint">
											{ticket.identifier}
										</span>
										<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
											{ticket.title}
										</span>
										<Badge>{ticket.priorityLabel}</Badge>
									</Link>
								))}
							</div>
						</Section>
					) : null}
				</>
			) : null}
		</div>
	);
}

// ──────────────────────────────── L'écran ────────────────────────────────

export function TeamView() {
	const { config, connectors, hasConnector, go } = useCockpit();
	const { t } = useTranslation("views");
	const [cycleOnly, setCycleOnly] = usePersistentState("team.cycleOnly", true);
	const [focused, setFocused] = useState<string | null>(null);
	const [urgentOnly, setUrgentOnly] = useState(false);
	const [presenting, setPresenting] = useState(false);

	// Deux minutes : le daily dure moins longtemps que ça, et Linear comme
	// GitHub n'aiment pas être sondés en boucle.
	const board = useAsync(() => api.team.board(cycleOnly), [cycleOnly], { pollMs: 120_000 });
	// Ce que le suivi configuré sait faire : c'est lui qui dit s'il y a un cycle,
	// donc un identifiant d'équipe à réclamer.
	const provider = useAsync(() => api.feeds.ticketProvider().catch(() => null), []);
	const data = board.data;

	const flags = useMemo(() => {
		let list = data?.flags ?? [];
		if (focused) list = list.filter((flag) => flag.member === focused);
		if (urgentOnly) list = list.filter((flag) => flag.severity === "red");
		return list;
	}, [data, focused, urgentOnly]);

	const members = useMemo(() => {
		const list = data?.members ?? [];
		return focused ? list.filter((member) => member.name === focused) : list;
	}, [data, focused]);

	const devs = members.filter((member) => member.role === "dev");
	const product = members.filter((member) => member.role !== "dev");

	// Le flux suit le focus comme le reste de l'écran. Il restait entier quand
	// tout le reste se réduisait à une personne : on lisait les PR de l'équipe
	// en croyant lire les siennes, et le même tableau s'affichait quel que soit
	// le membre choisi.
	const flow = useMemo(() => {
		const source = data?.prFlow;
		if (!source || !focused) return source;
		const mine = (items: PrFlowItem[]) => items.filter((item) => item.author === focused);
		return {
			...source,
			readyToMerge: mine(source.readyToMerge),
			ciFailing: mine(source.ciFailing),
			stacked: mine(source.stacked),
		};
	}, [data, focused]);

	// Le daily se lit dans le suivi de tâches : sans lui, il n'y a rien à
	// raconter, et l'erreur d'API ne dirait pas ce qui manque.
	if (!hasConnector("tickets")) {
		const tickets = connectors.find((entry) => entry.kind === "tickets");
		return (
			<>
				<ViewHeader title={t("team.title")} subtitle={t("team.noTracker.subtitle")} />
				<MissingConnector
					service={tickets?.label ?? t("team.noTracker.service")}
					missing={tickets?.missing ?? t("team.noTracker.token")}
					onConfigure={() => go("settings")}
				/>
			</>
		);
	}

	// Un jeton ne fait pas une équipe. Il manquait souvent l'identifiant de
	// l'équipe et ses membres — deux réglages que rien ne réclamait, et que la
	// « clé d'équipe » du panneau Linear ne remplace pas : celle-ci ne sert qu'à
	// lire un numéro de ticket. On le dit, plutôt que d'afficher un tableau vide
	// ou de renvoyer l'erreur d'un cycle introuvable.
	//
	// L'identifiant d'équipe n'est réclamé qu'aux suivis qui ont des cycles :
	// ailleurs il n'existe pas, et l'exiger interdirait le daily à une équipe qui
	// travaille sur GitLab ou sur les issues de son dépôt.
	const team = config?.team;
	const needsTeamId = provider.data?.capabilities?.cycles !== false;
	if (team && ((needsTeamId && !team.linearTeamId.trim()) || team.members.length === 0)) {
		return (
			<>
				<ViewHeader title={t("team.title")} subtitle={t("team.noTeam.subtitle")} />
				<div className="p-5">
					<div className="panel mx-auto flex max-w-xl flex-col gap-2.5 p-4">
						<p className="text-[12.5px] font-medium text-ink">
							{t("team.noTeam.title")}
						</p>
						<p className="text-[11px] leading-relaxed text-ink-muted">
							{!team.linearTeamId.trim()
								? t("team.noTeam.missingId")
								: t("team.noTeam.noMembers")}
						</p>
						<div className="flex justify-end">
							<Button variant="solid" onClick={() => go("settings")}>
								{t("team.noTeam.open")}
							</Button>
						</div>
					</div>
				</div>
			</>
		);
	}

	if (presenting && data) {
		return (
			<DailyPresenter
				members={data.members}
				flags={data.flags}
				sinceDaily={data.sinceDaily}
				onClose={() => setPresenting(false)}
			/>
		);
	}

	return (
		<>
			<ViewHeader
				title={t("team.title")}
				subtitle={
					data
						? data.cycle
							? t("team.subtitleCycle", { number: data.cycle.number, since: data.sinceDaily })
							: t("team.subtitle", { since: data.sinceDaily })
						: t("team.loading")
				}
				actions={
					<>
						<Button
							variant="solid"
							icon={Play}
							onClick={() => setPresenting(true)}
							disabled={!data}
							title={t("team.present")}
						>
							{t("team.title")}
						</Button>
						<Button active={cycleOnly} onClick={() => setCycleOnly((value) => !value)}>
							{cycleOnly ? t("team.currentCycle") : t("team.all")}
						</Button>
						{board.loading ? <Spinner /> : null}
						<Button size="sm" icon={RefreshCw} onClick={board.reload} />
					</>
				}
			/>

			{board.error ? <ErrorNote error={board.error} onRetry={board.reload} /> : null}
			{data?.githubError ? (
				<div className="mx-3 mt-3 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/8 p-2.5">
					<AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
					<p className="text-selectable text-[11px] leading-relaxed text-ink-muted">
						{t("team.githubError", { error: data.githubError })}
					</p>
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{!data && board.loading ? (
					<div className="flex justify-center py-16">
						<Spinner />
					</div>
				) : null}

				{data ? (
					<div className="flex max-w-7xl flex-col gap-5">
						<div className="flex flex-wrap items-center gap-1.5">
							<Button active={focused === null} onClick={() => setFocused(null)}>
								{t("team.wholeTeam")}
							</Button>
							{(data.members ?? []).map((member) => {
								const red = data.flags.filter(
									(flag) => flag.member === member.name && flag.severity === "red",
								).length;
								return (
									<Button
										key={member.name}
										active={focused === member.name}
										onClick={() =>
											setFocused((current) =>
												current === member.name ? null : member.name,
											)
										}
									>
										{member.name}
										{red > 0 ? <span className="ml-1 text-critical">{red}</span> : null}
									</Button>
								);
							})}
						</div>

						<div className="flex flex-wrap gap-1.5">
							<Chip
								label={t("team.chip.blocking")}
								value={data.totals.redFlags}
								tone={data.totals.redFlags > 0 ? "critical" : undefined}
							/>
							<Chip label={t("team.chip.toChallenge")} value={data.totals.orangeFlags} tone="warning" />
							<Chip label={t("team.chip.wip")} value={data.totals.activeWip} />
							<Chip label={t("team.chip.inReview")} value={data.totals.inReview} />
							<Chip
								label={t("team.chip.readyToMerge")}
								value={data.totals.readyToMerge}
								tone={data.totals.readyToMerge > 0 ? "success" : undefined}
							/>
							<Chip
								label="CI ✗"
								value={data.totals.ciFailing}
								tone={data.totals.ciFailing > 0 ? "critical" : undefined}
							/>
							<Chip label={t("team.chip.merged")} value={data.totals.mergedSinceDaily} tone="success" />
						</div>

						<Section
							title={t("team.flags.title")}
							count={flags.length}
							actions={
								<Button
									size="sm"
									active={urgentOnly}
									onClick={() => setUrgentOnly((v) => !v)}
								>
									{t("team.flags.urgentOnly")}
								</Button>
							}
						>
							{flags.length === 0 ? (
								<Empty
									icon={CircleDot}
									message={t("team.flags.empty")}
									hint={t("team.flags.emptyHint")}
								/>
							) : (
								<div className="flex flex-col gap-1.5">
									{flags.map((flag) => (
										<FlagCard key={flag.key} flag={flag} />
									))}
								</div>
							)}
						</Section>

						{flow &&
						(flow.readyToMerge.length > 0 ||
							flow.ciFailing.length > 0 ||
							flow.stacked.length > 0) ? (
							<Section title={t("team.flow.title")}>
								<div className="grid grid-cols-3 gap-3">
									<div className="panel flex flex-col gap-1 p-2.5">
										<div className="flex items-center gap-1.5 text-[10px] text-success">
											<Rocket size={11} />
											{t("team.flow.ready", { count: flow.readyToMerge.length })}
										</div>
										{flow.readyToMerge.map((pr) => (
											<PrLine key={pr.number} pr={pr} />
										))}
									</div>
									<div className="panel flex flex-col gap-1 p-2.5">
										<div className="flex items-center gap-1.5 text-[10px] text-critical">
											<AlertTriangle size={11} />
											{t("team.flow.ciFailing", { count: flow.ciFailing.length })}
										</div>
										{flow.ciFailing.map((pr) => (
											<PrLine key={pr.number} pr={pr} />
										))}
									</div>
									<div className="panel flex flex-col gap-1 p-2.5">
										<div className="flex items-center gap-1.5 text-[10px] text-warning">
											<Layers size={11} />
											{t("team.flow.stacked", { count: flow.stacked.length })}
										</div>
										{flow.stacked.map((pr) => (
											<PrLine
												key={pr.number}
												pr={pr}
												note={pr.blockedBy ? t("team.flow.blockedBy", { number: pr.blockedBy }) : pr.base}
											/>
										))}
									</div>
								</div>
							</Section>
						) : null}

						{/* Qui fait quoi : tickets et PR réunis par personne, avec les
						    mêmes vues filtrantes que partout ailleurs. La grille reçoit
						    le tableau déjà chargé et la personne sélectionnée. */}
						<Section title={t("team.focus")} count={devs.length}>
							<TeamWorkGrid members={devs} focus={focused} onFocus={setFocused} compact />
						</Section>

						{product.length > 0 ? (
							<Section title={t("team.product")} count={product.length}>
								<div
									className={clsx(
										"grid gap-3",
										focused ? "grid-cols-1" : "grid-cols-2 xl:grid-cols-3",
									)}
								>
									{product.map((member) => (
										<MemberCard
											key={member.name}
											member={member}
											expanded={Boolean(focused)}
										/>
									))}
								</div>
							</Section>
						) : null}

						{data.members.length === 0 ? (
							<Empty
								icon={Users}
								message={t("team.noMember")}
								hint={t("team.noMemberHint")}
							/>
						) : null}
					</div>
				) : null}
			</div>
		</>
	);
}
