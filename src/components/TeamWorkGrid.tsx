import clsx from "clsx";
import {
	AlertTriangle,
	Eye,
	GitBranch,
	GitPullRequest,
	Layers,
	Ticket,
	Users,
} from "lucide-react";
import { useMemo } from "react";
import {
	Badge,
	Button,
	Empty,
	ErrorNote,
	Freshness,
	PrLabels,
	PriorityBadge,
	SkeletonRows,
} from "@/components/ui";
import { api } from "@/lib/ipc";
import { TicketActions } from "@/components/actions";
import { NowFeed } from "@/components/NowFeed";
import type { MemberBoard, MemberPr, TicketCard } from "@/lib/types";
import { usePersistentState, useAsync } from "@/lib/useAsync";
import { useAgentActions } from "@/app/agents";
import { useCockpit } from "@/app/store";

/**
 * Qui travaille sur quoi, à l'instant T.
 *
 * Les listes à plat répondent mal à la question qu'on se pose le matin : où en
 * est chacun. Ici la personne est le point d'entrée — un clic sur son nom
 * rassemble ses tickets **et** ses PR, là où il fallait auparavant ouvrir
 * Linear, poser un filtre, puis tout recommencer côté pull requests.
 */

interface WorkView {
	id: string;
	label: string;
	hint: string;
	/** Retient les PR à montrer ; `null` les garde toutes. */
	pr: ((pr: MemberPr) => boolean) | null;
	/** Masque les personnes que la vue ne concerne pas. */
	membersWithPrOnly: boolean;
}

const BASE_BRANCHES = new Set(["dev", "main", "master", "stage"]);

const VIEWS: WorkView[] = [
	{
		id: "all",
		label: "Tout",
		hint: "Tickets du cycle et PR ouvertes",
		pr: null,
		membersWithPrOnly: false,
	},
	{
		id: "blocked",
		label: "Ça bloque",
		hint: "CI en échec, changements demandés, PR empilées",
		pr: (pr) =>
			pr.ciState === "failing" || pr.reviewDecision === "CHANGES_REQUESTED" || pr.stacked,
		membersWithPrOnly: true,
	},
	{
		id: "review",
		label: "Attend une review",
		hint: "Ni approuvée, ni brouillon : la balle est chez les relecteurs",
		pr: (pr) => !pr.isDraft && pr.reviewDecision !== "APPROVED" && pr.ciState !== "failing",
		membersWithPrOnly: true,
	},
	{
		id: "ready",
		label: "À merger",
		hint: "Approuvées, CI verte, sur une branche de base",
		pr: (pr) =>
			pr.reviewDecision === "APPROVED" &&
			pr.ciState === "success" &&
			!pr.isDraft &&
			BASE_BRANCHES.has(pr.baseRef),
		membersWithPrOnly: true,
	},
];

/** État d'une PR, dans l'ordre où il faut s'en occuper. */
function prState(pr: MemberPr): { rank: number; label: string; tone: string } {
	if (pr.ciState === "failing")
		return { rank: 0, label: "CI en échec", tone: "text-critical" };
	if (pr.reviewDecision === "CHANGES_REQUESTED")
		return { rank: 1, label: "changements demandés", tone: "text-warning" };
	if (pr.stacked)
		return { rank: 2, label: `empilée sur ${pr.baseRef}`, tone: "text-critical" };
	if (pr.reviewDecision === "APPROVED" && pr.ciState === "success")
		return { rank: 3, label: "prête à merger", tone: "text-success" };
	if (pr.ciState === "pending")
		return { rank: 4, label: "CI en cours", tone: "text-warning" };
	if (pr.isDraft) return { rank: 5, label: "brouillon", tone: "text-ink-faint" };
	return { rank: 4, label: "en attente de review", tone: "text-ink-faint" };
}

function urgency(prs: MemberPr[]): number {
	return prs.filter((pr) => prState(pr).rank <= 2).length;
}

/** Initiales, pour reconnaître une personne sans lire. */
function initials(name: string): string {
	return name
		.split(/[\s-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
}

export function TeamWorkGrid({
	members: given,
	focus: givenFocus,
	onFocus,
	compact,
}: {
	/** Membres déjà chargés par l'écran hôte ; sinon le composant les charge. */
	members?: MemberBoard[];
	/** Personne sélectionnée, quand l'hôte la pilote (le Daily filtre aussi ses flags). */
	focus?: string | null;
	onFocus?: (name: string | null) => void;
	/** Masque la barre de personnes, quand l'hôte en a déjà une. */
	compact?: boolean;
} = {}) {
	const { notify, worktrees, go } = useCockpit();
	const { open: openAgent } = useAgentActions();
	const [viewId, setViewId] = usePersistentState("team.view", "all");
	/** Personne au premier plan ; `null` montre toute l'équipe. */
	const [ownFocus, setOwnFocus] = usePersistentState<string | null>("team.focus", null);
	const [cycleOnly, setCycleOnly] = usePersistentState("team.cycleOnly", true);

	const focus = givenFocus !== undefined ? givenFocus : ownFocus;
	const setFocus = onFocus ?? setOwnFocus;

	// Un tableau fourni par l'hôte évite de redemander à Linear et GitHub ce
	// qu'ils viennent de répondre.
	const board = useAsync(() => api.team.board(cycleOnly), [cycleOnly], {
		pollMs: 180_000,
		enabled: given === undefined,
	});
	const view = VIEWS.find((entry) => entry.id === viewId) ?? VIEWS[0];
	const everyone = useMemo(() => given ?? board.data?.members ?? [], [given, board.data]);

	const open = (url: string) => {
		void api.system.openUrl(url).catch((error) => notify(String(error)));
	};
	const treeOf = (branch: string) => worktrees.find((tree) => tree.branch === branch);
	const onAgent = (branch: string) => {
		const tree = treeOf(branch);
		if (tree) openAgent(tree.path);
		else notify("Aucun worktree local pour cette branche.");
	};
	const onWorktree = (branch: string) => {
		const tree = treeOf(branch);
		if (tree) go("worktrees", { worktreePath: tree.path });
		else notify("Aucun worktree local pour cette branche.");
	};

	const cards = useMemo(() => {
		return (
			everyone
				.filter((member) => !focus || member.name === focus)
				.map((member) => ({
					member,
					prs: [...(view.pr ? member.prs.filter(view.pr) : member.prs)].sort(
						(a, b) => prState(a).rank - prState(b).rank || a.ageDays - b.ageDays,
					),
				}))
				.filter((entry) => !view.membersWithPrOnly || entry.prs.length > 0)
				// Les personnes bloquées d'abord : c'est là qu'il faut regarder.
				.sort(
					(a, b) =>
						urgency(b.prs) - urgency(a.prs) ||
						b.prs.length - a.prs.length ||
						a.member.name.localeCompare(b.member.name),
				)
		);
	}, [everyone, focus, view]);

	const focused = focus ? everyone.find((member) => member.name === focus) : null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* La personne est le premier filtre, pas un critère caché derrière un
			    panneau : un clic ici recadre tickets et PR d'un seul geste. */}
			<div
				className={clsx(
					"flex flex-wrap items-center gap-1.5",
					compact ? "pb-2" : "hairline-b px-4 py-2",
				)}
			>
				{compact ? null : (
					<>
						<Button
							size="sm"
							icon={Users}
							active={focus === null}
							onClick={() => setFocus(null)}
							title="Toute l'équipe"
						>
							Tous
						</Button>
						{everyone.map((member) => {
							const active = focus === member.name;
							const blocked = urgency(member.prs);
							return (
								<button
									key={member.name}
									type="button"
									onClick={() => setFocus(active ? null : member.name)}
									title={`${member.name} — ${member.prs.length} PR, ${member.metrics.activeWip} ticket(s) actif(s)`}
									className={clsx(
										"focus-ring flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11px] transition-colors",
										active
											? "border-accent-soft/50 bg-accent-dim text-ink"
											: "border-line-soft text-ink-muted hover:border-line hover:text-ink",
									)}
								>
									<span
										className={clsx(
											"flex h-4 w-4 items-center justify-center rounded font-mono text-[10px]",
											active ? "bg-accent text-accent-ink" : "bg-raised text-ink-faint",
										)}
									>
										{initials(member.name)}
									</span>
									{member.name}
									{blocked > 0 ? (
										<span className="font-mono text-[10px] text-critical">{blocked}</span>
									) : null}
								</button>
							);
						})}
					</>
				)}

				<div className={clsx("flex items-center gap-1.5", compact ? "" : "ml-auto")}>
					{VIEWS.map((entry) => (
						<Button
							key={entry.id}
							size="sm"
							active={entry.id === view.id}
							onClick={() => setViewId(entry.id)}
							title={entry.hint}
						>
							{entry.label}
						</Button>
					))}
					<Button
						size="sm"
						active={cycleOnly}
						onClick={() => setCycleOnly(!cycleOnly)}
						title="Limiter aux tickets du cycle en cours"
					>
						Cycle
					</Button>
					{given === undefined ? (
						<Freshness
							at={board.updatedAt}
							loading={board.loading}
							onReload={board.reload}
						/>
					) : null}
				</div>
			</div>

			<div className={clsx("min-h-0 flex-1", compact ? "" : "overflow-y-auto p-3")}>
				{board.error ? <ErrorNote error={board.error} onRetry={board.reload} /> : null}
				{given === undefined && board.initial && board.loading ? (
					<SkeletonRows rows={5} className="px-4 py-6" />
				) : null}
				{cards.length === 0 ? (
					<Empty
						icon={Eye}
						message={
							focus
								? `Rien pour ${focus} dans « ${view.label} »`
								: `Rien dans « ${view.label} »`
						}
						hint={view.hint}
						action={{ label: "Voir tout", onClick: () => setViewId("all") }}
					/>
				) : null}

				{/* Une personne au premier plan mérite la largeur : ses tickets d'un
				    côté, ses PR de l'autre, sans changer d'écran. */}
				{focused && cards.length > 0 ? (
					<FocusPanel
						member={focused}
						prs={cards[0].prs}
						onOpen={open}
						onAgent={onAgent}
						onWorktree={onWorktree}
					/>
				) : (
					<div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
						{cards.map(({ member, prs }) => (
							<MemberCard
								key={member.name}
								member={member}
								prs={prs}
								showTickets={view.id === "all"}
								onSelect={() => setFocus(member.name)}
								onOpen={open}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function PrLine({
	pr,
	onOpen,
	onAgent,
	onWorktree,
}: {
	pr: MemberPr;
	onOpen: (url: string) => void;
	onAgent?: (branch: string) => void;
	onWorktree?: (branch: string) => void;
}) {
	const state = prState(pr);
	return (
		<div className="group flex items-start gap-1.5">
			<GitPullRequest size={11} className={clsx("mt-1 shrink-0", state.tone)} />
			<div className="min-w-0 flex-1">
				<button
					type="button"
					onClick={() => onOpen(pr.url)}
					className="focus-ring block w-full truncate rounded text-left text-[11px] text-ink hover:underline"
					title={pr.title}
				>
					<span className="font-mono text-[10px] text-ink-faint">#{pr.number}</span>{" "}
					{pr.title}
				</button>
				<div className="flex items-center gap-1.5 font-mono text-[10px]">
					<span className={state.tone}>{state.label}</span>
					<span className="text-ink-faint">· {pr.ageDays} j</span>
					{pr.stacked ? <Layers size={9} className="text-critical" /> : null}
					{pr.ticketId ? (
						<span className="truncate text-ink-faint">· {pr.ticketId}</span>
					) : null}
					<PrLabels labels={pr.labels} max={2} className="ml-auto" />
				</div>
			</div>
			{onAgent && onWorktree ? (
				<div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
					{state.rank <= 1 ? (
						<Button
							size="sm"
							icon={AlertTriangle}
							onClick={() => onAgent(pr.headRef)}
							title="Ouvrir un agent sur cette branche"
						/>
					) : null}
					<Button
						size="sm"
						icon={GitBranch}
						onClick={() => onWorktree(pr.headRef)}
						title="Ouvrir le worktree"
					/>
				</div>
			) : null}
		</div>
	);
}

function TicketLine({
	ticket,
	onOpen,
}: {
	ticket: TicketCard;
	onOpen: (url: string) => void;
}) {
	return (
		// Le daily se lit, mais c'est aussi là qu'on décide de s'y mettre : les
		// actions du ticket y sont les mêmes qu'ailleurs, révélées au survol pour ne
		// pas encombrer une liste qu'on parcourt.
		<div className="group flex items-start gap-1.5">
			<button
				type="button"
				onClick={() => onOpen(ticket.url)}
				className="focus-ring flex min-w-0 flex-1 items-start gap-1.5 rounded text-left hover:underline"
				title={ticket.title}
			>
				<Ticket size={11} className="mt-0.5 shrink-0 text-ink-faint" />
				<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
					<span className="font-mono text-[10px] text-ink-faint">{ticket.identifier}</span>{" "}
					{ticket.title}
				</span>
				<PriorityBadge priority={ticket.priority} label={ticket.priorityLabel} />
				<span className="shrink-0 font-mono text-[10px] text-ink-faint">
					{ticket.progress}%
				</span>
			</button>
			<span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
				<TicketActions identifier={ticket.identifier} title={ticket.title} />
			</span>
		</div>
	);
}

/** Une personne, en pleine largeur : tickets à gauche, PR à droite. */
function FocusPanel({
	member,
	prs,
	onOpen,
	onAgent,
	onWorktree,
}: {
	member: MemberBoard;
	prs: MemberPr[];
	onOpen: (url: string) => void;
	onAgent: (branch: string) => void;
	onWorktree: (branch: string) => void;
}) {
	const metrics = member.metrics;
	return (
		<div className="flex flex-col gap-3">
			<div className="panel flex flex-col gap-1 p-3">
				<div className="flex items-center gap-2">
					<span className="text-[13px] font-semibold text-ink">{member.name}</span>
					<Badge>{member.roleLabel}</Badge>
					<span className="ml-auto flex items-center gap-3 font-mono text-[10px] text-ink-faint">
						<span title="tickets actifs">{metrics.activeWip} WIP</span>
						<span title="PR ouvertes">{metrics.openPrs} PR</span>
						<span title="PR des autres à relire" className="text-info">
							{metrics.prsToReview} à relire
						</span>
						<span title="mergées depuis le dernier daily" className="text-success">
							{metrics.mergedSinceDaily} livrées
						</span>
					</span>
				</div>
				<p className="text-[11px] leading-relaxed text-ink-muted">
					{member.narrative.text}
				</p>
			</div>

			{/* Ce sur quoi la personne travaille, en un seul fil : tickets et pull
			    requests d'un même sujet sur la même ligne, le plus récemment touché
			    en tête. Deux colonnes séparées obligeaient à faire le rapprochement
			    de tête pendant qu'elle parlait. */}
			<section className="panel flex flex-col gap-1.5 p-3">
				<h3 className="mb-0.5 text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
					En ce moment
				</h3>
				<NowFeed member={member} prs={prs} onOpen={onOpen} />
			</section>

			<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
				<section className="panel flex flex-col gap-1.5 p-3">
					<h3 className="mb-0.5 text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
						À suivre
					</h3>
					{member.next.length === 0 ? (
						<p className="py-1 text-[11px] text-ink-faint">
							Rien de prêt à démarrer ensuite.
						</p>
					) : null}
					{member.next.length > 0 ? (
						<>
							<div className="mt-1 border-t border-line-soft pt-1.5 text-[10px] text-ink-faint">
								À suivre
							</div>
							{member.next.slice(0, 4).map((ticket) => (
								<button
									key={ticket.identifier}
									type="button"
									onClick={() => onOpen(ticket.url)}
									className="focus-ring flex items-center gap-1.5 rounded text-left hover:underline"
								>
									<Ticket size={11} className="shrink-0 text-ink-faint/60" />
									<span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
										<span className="font-mono text-[10px]">{ticket.identifier}</span>{" "}
										{ticket.title}
									</span>
									<Badge>{ticket.priorityLabel}</Badge>
								</button>
							))}
						</>
					) : null}
				</section>

				<section className="panel flex flex-col gap-1.5 p-3">
					<h3 className="mb-0.5 text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
						Pull requests · {prs.length}
					</h3>
					{prs.length === 0 ? (
						<p className="py-1 text-[11px] text-ink-faint">Aucune PR ouverte.</p>
					) : null}
					{prs.map((pr) => (
						<PrLine
							key={pr.number}
							pr={pr}
							onOpen={onOpen}
							onAgent={onAgent}
							onWorktree={onWorktree}
						/>
					))}

					{member.reviewInbox.length > 0 ? (
						<>
							<div className="mt-1 flex items-center gap-1.5 border-t border-line-soft pt-1.5 text-[10px] text-ink-faint">
								<Eye size={10} /> Doit relire pour les autres
							</div>
							{member.reviewInbox.map((item) => (
								<button
									key={item.number}
									type="button"
									onClick={() => onOpen(item.url)}
									className="focus-ring flex items-center gap-1.5 rounded text-left hover:underline"
									title={item.title}
								>
									<span className="font-mono text-[10px] text-ink-faint">
										#{item.number}
									</span>
									<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
										{item.title}
									</span>
									<PrLabels labels={item.labels} max={2} />
									<span className="shrink-0 font-mono text-[10px] text-ink-faint">
										{item.author} · {item.ageDays} j
									</span>
								</button>
							))}
						</>
					) : null}
				</section>
			</div>
		</div>
	);
}

function MemberCard({
	member,
	prs,
	showTickets,
	onSelect,
	onOpen,
}: {
	member: MemberBoard;
	prs: MemberPr[];
	showTickets: boolean;
	onSelect: () => void;
	onOpen: (url: string) => void;
}) {
	const blocked = urgency(prs);

	return (
		<section className="panel flex flex-col gap-2 p-3">
			{/* Le nom est un bouton : c'est le geste qui recadre tout sur la
			    personne, et il doit être le plus évident de la carte. */}
			<button
				type="button"
				onClick={onSelect}
				className="focus-ring flex items-center gap-2 rounded text-left"
				title={`Ne voir que ${member.name}`}
			>
				<span className="flex h-5 w-5 items-center justify-center rounded bg-raised font-mono text-[10px] text-ink-faint">
					{initials(member.name)}
				</span>
				<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink hover:underline">
					{member.name}
				</span>
				{blocked > 0 ? (
					<Badge tone="critical">
						{blocked} bloquée{blocked > 1 ? "s" : ""}
					</Badge>
				) : null}
				{member.metrics.prsToReview > 0 ? (
					<span
						className="flex items-center gap-1 font-mono text-[10px] text-info"
						title="PR des autres à relire"
					>
						<Eye size={11} />
						{member.metrics.prsToReview}
					</span>
				) : null}
				<span className="font-mono text-[10px] text-ink-faint" title="tickets actifs">
					{member.metrics.activeWip} WIP
				</span>
			</button>

			{prs.length === 0 && (!showTickets || member.activeTickets.length === 0) ? (
				<p className="py-1 text-[11px] text-ink-faint">Rien en cours.</p>
			) : null}

			{prs.slice(0, 6).map((pr) => (
				<PrLine key={pr.number} pr={pr} onOpen={onOpen} />
			))}

			{showTickets && member.activeTickets.length > 0 ? (
				<div className="mt-1 flex flex-col gap-1 border-t border-line-soft pt-2">
					{member.activeTickets.slice(0, 4).map((ticket) => (
						<TicketLine key={ticket.identifier} ticket={ticket} onOpen={onOpen} />
					))}
				</div>
			) : null}
		</section>
	);
}
