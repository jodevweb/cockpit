import clsx from "clsx";
import {
	Bot,
	FileText,
	GitCommitHorizontal,
	GitPullRequest,
	Image as ImageIcon,
	ListChecks,
	Network,
	PencilLine,
	ScanSearch,
	Terminal,
	Ticket,
} from "lucide-react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAgentRuns } from "@/app/agents";
import { movedSince, useReview, useReviewFlow } from "@/app/review";
import { useCockpit } from "@/app/store";
import { useWorkspace } from "@/app/workspace";
import { PrActions } from "@/components/actions";
import { ContextGauge } from "@/components/ChantierMap";
import { MediaThumb } from "@/components/MediaThumb";
import { ReviewPanel } from "@/components/ReviewPanel";
import { LinearIssue } from "@/components/LinearIssue";
import { Button, LoadingBar, SkeletonRows } from "@/components/ui";
import type { WorkGroup } from "@/components/WorkspacePanel";
import type { QaFile } from "@/lib/types";
import { agentColor } from "@/lib/chantier";
import { useFileViewer } from "@/lib/fileViewer";
import { fromSeconds } from "@/lib/format";
import { api } from "@/lib/ipc";
import { openLightbox } from "@/components/Lightbox";
import { mediaOfPath } from "@/lib/media";
import { MISSION_STATE_LABELS } from "@/lib/missions";
import { useAsync } from "@/lib/useAsync";
import { ticketsIn } from "@/lib/world";

/**
 * Tout ce qui tient à une branche, en cartes.
 *
 * Un workspace ne montrait que des conversations d'agents : la PR, le ticket,
 * la revue, les commits, les documents, les captures de recette vivaient
 * chacun sur un autre écran, ou nulle part. Ici le worktree se lit comme un
 * dossier complet — ce qu'on est en train de faire, pourquoi, où ça en est —
 * et chaque carte porte le geste qui va avec.
 *
 * Rien n'est à saisir : la PR se retrouve par la branche, le ticket par son
 * identifiant dans le nom de la branche ou dans la PR, les documents et les
 * captures par le dossier.
 */
/** Ce que la vue sait montrer seul, dans son propre panneau. */
export type BoardSection =
	| "pr"
	| "ticket"
	| "review"
	| "mission"
	| "agents"
	| "commits"
	| "docs"
	| "captures"
	| "ports";

/** La partie demandée, quand on n'en veut qu'une : les autres cartes se taisent. */
const Only = createContext<BoardSection | null>(null);

/** Masquée, la vue ne se redessine pas : elle se remet à jour en redevenant visible. */
export const BranchBoard = memo(
	BranchBoardView,
	(before, after) => !before.active && !after.active && before.group.cwd === after.group.cwd,
);

function BranchBoardView({
	group,
	active,
	only = null,
}: {
	group: WorkGroup;
	active: boolean;
	/**
	 * Une seule partie de la vue, à sa pleine mesure : la PR, le ticket en
	 * fiche complète, la revue, les commits… Depuis la carte d'un agent, on
	 * ouvre l'une sans avoir les autres autour.
	 */
	only?: BoardSection | null;
}) {
	const { t } = useTranslation("components2");
	const { worktrees, missions, activeProject, notify, config } = useCockpit();
	const readOnly = config?.workflow?.reviewReadOnly ?? true;
	const { show } = useWorkspace();
	const { runs } = useAgentRuns();
	const viewer = useFileViewer();
	const review = useReviewFlow();
	const [busy, setBusy] = useState(false);

	const cwd = group.cwd;
	const tree = worktrees.find((entry) => entry.path === cwd) ?? null;
	const branch = tree?.branch ?? group.label;
	const options = { enabled: active };

	const prs = useAsync(() => api.git.pullRequests().catch(() => []), [activeProject?.id], { ...options, pollMs: 120_000 });
	const openPr = (prs.data ?? []).find((pr) => pr.headRef === branch) ?? null;
	// Une PR fusionnée ou fermée ne figure pas parmi les ouvertes : on la
	// demande à part, pour la branche seule.
	const past = useAsync(() => (openPr || !branch ? Promise.resolve(null) : api.reviews.branchPr(branch).catch(() => null)), [branch, Boolean(openPr)], options);
	const number = openPr?.number ?? past.data?.number ?? null;
	const { review: current } = useReview(number);

	const prefixes = useMemo(
		() => new Set([activeProject?.linearTeamKey ?? ""].map((key) => key.toUpperCase()).filter(Boolean)),
		[activeProject?.linearTeamKey],
	);
	const ticketIds = useMemo(
		() => [...new Set([...ticketsIn(branch, prefixes), ...(openPr?.linearIds ?? []).map((id) => id.toUpperCase())])].slice(0, 2),
		[branch, prefixes, openPr?.linearIds],
	);
	const tickets = useAsync(
		() => Promise.all(ticketIds.map((id) => api.feeds.linearIssue(id).catch(() => null))),
		[ticketIds.join(",")],
		options,
	);
	const commits = useAsync(() => api.worktrees.commits(cwd, 8).catch(() => []), [cwd], { ...options, pollMs: 30_000 });
	const changes = useAsync(() => api.worktrees.changes(cwd).catch(() => []), [cwd], { ...options, pollMs: 15_000 });
	const docs = useAsync(() => api.docs.scan([[cwd, branch]], 40).catch(() => []), [cwd], { ...options, pollMs: 60_000 });
	const qa = useAsync(() => api.worktrees.qa(cwd).catch(() => []), [cwd], { ...options, pollMs: 60_000 });
	const ports = useAsync(() => api.system.ports().catch(() => []), [cwd], { ...options, pollMs: 20_000 });
	const mission = group.mission ? missions.find((entry) => entry.id === group.mission?.id) ?? null : null;
	const here = runs.filter((run) => run.cwd === cwd);
	const myPorts = (ports.data ?? []).filter((port) => port.cwd === cwd || port.cwd.startsWith(`${cwd}/`));
	const visuals = (qa.data ?? []).filter((file) => file.kind === "image" || file.kind === "video");

	const start = async (kind: "revue" | "verification") => {
		if (!number) return;
		setBusy(true);
		try {
			await review(number, kind);
		} catch (error) {
			notify(String(error).replace(/^(Ipc)?Error:\s*/, ""));
		} finally {
			setBusy(false);
		}
	};

	// Rien n'était encore arrivé et l'écran restait figé sur ses états vides :
	// on croyait le clic perdu. Tant qu'une source n'a jamais répondu, sa carte
	// montre qu'elle cherche, et un fil court en haut de la vue.
	const sources = [prs, past, tickets, commits, changes, docs, qa];
	const fetching = active && sources.some((source) => source.loading);
	const firstLoad = active && sources.some((source) => source.initial);

	const prState = openPr
		? openPr.isDraft
			? t("branchBoard.pr.draft")
			: t("branchBoard.pr.open")
		: past.data?.state === "merged"
			? t("branchBoard.pr.merged")
			: past.data?.state === "closed"
				? t("branchBoard.pr.closed")
				: null;

	if (only === "ticket") {
		return (
			<div className="min-h-0 flex-1 overflow-y-auto bg-base px-5 py-4">
				{ticketIds.length === 0 ? (
					<p className="text-[12px] text-ink-faint">{t("branchBoard.ticket.none")}</p>
				) : (
					<div className="mx-auto flex max-w-[900px] flex-col gap-6">
						{ticketIds.map((id) => (
							<LinearIssue key={id} identifier={id} />
						))}
					</div>
				)}
			</div>
		);
	}

	if (only === "captures") return <CaptureGallery files={visuals} loading={qa.initial} />;

	if (only === "review") {
		return (
			<div className="min-h-0 flex-1 overflow-y-auto bg-base px-4 py-4">
				{current ? (
					<ReviewPanel
						review={current}
						cwd={cwd}
						headSha={openPr?.headSha ?? null}
						busy={busy}
						onRecheck={() => (openPr ? void start("verification") : undefined)}
						onReview={() => (openPr ? void start("revue") : undefined)}
					/>
				) : (
					<div className="flex flex-col items-start gap-3 p-2">
						<p className="text-[12.5px] text-ink-muted">
							{number
								? t("branchBoard.review.notYet", { number })
								: t("branchBoard.review.noPr")}
						</p>
						{openPr ? (
							<Button size="sm" variant="solid" icon={ScanSearch} onClick={() => void start("revue")} loading={busy}>
								{t("branchBoard.review.reviewPr")}
							</Button>
						) : null}
					</div>
				)}
			</div>
		);
	}

	return (
		<Only.Provider value={only}>
		<div className="relative min-h-0 flex-1 overflow-y-auto bg-base px-4 py-4">
			<div className="sticky -top-4 z-10 -mx-4 -mt-4 mb-1">
				<LoadingBar active={fetching} />
			</div>
			<div className="mx-auto flex max-w-[1400px] flex-col gap-3">
				{firstLoad ? (
					<p className="px-1 text-[11.5px] text-ink-faint">{t("branchBoard.gathering", { branch })}</p>
				) : null}
				{/* La PR et ce qui la motive : ce qu'on regarde en premier. */}
				<div className={only ? "flex flex-col gap-3" : "grid grid-cols-1 gap-3 lg:grid-cols-3"}>
					<Card
						icon={GitPullRequest}
						section="pr"
						title={number ? t("branchBoard.pr.number", { number }) : t("branchBoard.pr.title")}
						tone={openPr ? "accent" : undefined}
						className="lg:col-span-2"
						aside={prState ? <Pill>{prState}</Pill> : null}
						loading={prs.initial || (past.initial && !openPr)}
					>
						{number ? (
							<div className="flex flex-col gap-2">
								<button
									type="button"
									onClick={() => void api.system.openUrl(openPr?.url ?? past.data?.url ?? "").catch(() => undefined)}
									className="focus-ring rounded text-left text-[14px] leading-snug font-semibold text-ink hover:underline"
								>
									{openPr?.title ?? past.data?.title}
								</button>
								{openPr ? (
									<div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-muted">
										<Pill tone={openPr.ciState === "failing" ? "critical" : openPr.ciState === "success" ? "success" : undefined}>
											{openPr.ciState === "failing"
												? t("branchBoard.pr.ciRed")
												: openPr.ciState === "success"
													? t("branchBoard.pr.ciGreen")
													: t("branchBoard.pr.ciRunning")}
										</Pill>
										<Pill tone={openPr.reviewDecision === "APPROVED" ? "success" : openPr.reviewDecision === "CHANGES_REQUESTED" ? "warning" : undefined}>
											{openPr.reviewDecision === "APPROVED"
												? t("branchBoard.pr.approved")
												: openPr.reviewDecision === "CHANGES_REQUESTED"
													? t("branchBoard.pr.changesRequested")
													: t("branchBoard.pr.notApproved")}
										</Pill>
										<span>
											<Trans
												t={t}
												i18nKey="branchBoard.pr.byAuthor"
												values={{ author: openPr.author }}
												components={{ author: <span className="text-ink" /> }}
											/>{" "}
											· {openPr.baseRef} ← {openPr.headRef}
										</span>
										{openPr.reviewRequestLogins.length > 0 ? (
											<span>· {t("branchBoard.pr.reviewRequested", { logins: openPr.reviewRequestLogins.join(", ") })}</span>
										) : null}
									</div>
								) : null}
								<div className="flex flex-wrap items-center gap-1">
									{openPr ? (
										current ? (
											movedSince(current, openPr.headSha) ? (
												<Button size="sm" variant="solid" icon={ScanSearch} onClick={() => void start("verification")} loading={busy}>
													{t("branchBoard.review.recheck")}
												</Button>
											) : null
										) : (
											<Button size="sm" variant="solid" icon={ScanSearch} onClick={() => void start("revue")} loading={busy}>
												{t("branchBoard.review.reviewThisPr")}
											</Button>
										)
									) : null}
									{openPr ? (
										<PrActions
											number={openPr.number}
											url={openPr.url}
											headRef={openPr.headRef}
											ciFailing={openPr.ciState === "failing"}
											changesRequested={openPr.reviewDecision === "CHANGES_REQUESTED"}
										/>
									) : null}
								</div>
							</div>
						) : (
							<p className="text-[12px] text-ink-faint">
								{prs.initial || past.loading ? t("branchBoard.pr.searching") : t("branchBoard.pr.none", { branch })}
							</p>
						)}
					</Card>

					<Card
						icon={Ticket}
						section="ticket"
						title={t("branchBoard.ticket.title", { count: ticketIds.length })}
						aside={ticketIds.length ? <Pill>{ticketIds.join(" · ")}</Pill> : null}
						loading={ticketIds.length > 0 && tickets.initial}
					>
						{ticketIds.length === 0 ? (
							<p className="text-[12px] text-ink-faint">{t("branchBoard.ticket.none")}</p>
						) : (
							<div className="flex flex-col gap-2.5">
								{(tickets.data ?? []).map((issue, index) =>
									issue ? (
										<div key={issue.identifier} className="flex flex-col gap-1">
											<button
												type="button"
												onClick={() => void api.system.openUrl(issue.url).catch(() => undefined)}
												className="focus-ring rounded text-left text-[13px] leading-snug font-semibold text-ink hover:underline"
											>
												{issue.title}
											</button>
											<span className="text-[11px] text-ink-muted">
												{issue.state?.name ?? "—"}
												{issue.assignee ? ` · ${issue.assignee.name}` : ""}
											</span>
											{issue.description ? (
												// Le premier paragraphe seulement, sans balisage : la carte
												// dit de quoi parle le ticket, le lien mène au reste.
												<p className="line-clamp-3 text-[11.5px] leading-relaxed text-ink-muted">
													{issue.description.split(/\n\s*\n/)[0].replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim()}
												</p>
											) : null}
										</div>
									) : (
										<span key={ticketIds[index]} className="text-[11.5px] text-ink-faint">
											{t("branchBoard.ticket.notFound", { id: ticketIds[index] })}
										</span>
									),
								)}
							</div>
						)}
					</Card>
				</div>

				{/* La revue, quand il y en a une : elle prend toute la largeur, c'est
				    elle qu'on lit et qu'on poste. */}
				{only ? null : current && openPr ? (
					<ReviewPanel
						review={current}
						cwd={cwd}
						headSha={openPr.headSha}
						busy={busy}
						onRecheck={() => void start("verification")}
						onReview={() => void start("revue")}
					/>
				) : current ? (
					<ReviewPanel review={current} cwd={cwd} headSha={null} busy={busy} onRecheck={() => undefined} onReview={() => undefined} />
				) : null}

				<div className={only ? "flex flex-col gap-3" : "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"}>
					{mission ? (
						<Card icon={ListChecks} section="mission" title={t("branchBoard.mission.title")} aside={<Pill tone="accent">{MISSION_STATE_LABELS[mission.state]}</Pill>}>
							<p className="text-[13px] font-semibold text-ink">{mission.title}</p>
							<p className="mt-1 text-[11.5px] text-ink-muted">
								{group.mission?.role} · {t("branchBoard.mission.tasks", { count: mission.tasks.length })}
							</p>
						</Card>
					) : null}

					<Card icon={Bot} section="agents" title={t("branchBoard.agents.title")} aside={<Pill>{here.length}</Pill>}>
						{here.length === 0 ? (
							<p className="text-[12px] text-ink-faint">{t("branchBoard.agents.none")}</p>
						) : (
							<div className="flex flex-col gap-3">
								{here.map((run, index) => (
									<button
										key={run.id}
										type="button"
										onClick={() => show(cwd, { kind: "agent", id: run.id })}
										className="focus-ring flex flex-col gap-1 rounded-lg p-1.5 text-left hover:bg-raised"
									>
										<span className="flex items-center gap-1.5 text-[12px]">
											<span className="size-2 rounded-full" style={{ background: agentColor(index) }} />
											<span className="min-w-0 flex-1 truncate font-medium text-ink">{run.label}</span>
											{run.profile === "review" ? <Pill>{readOnly ? t("branchBoard.agents.reviewReadOnly") : t("branchBoard.agents.review")}</Pill> : null}
											<span className={clsx("shrink-0 text-[10.5px]", run.thinking ? "text-success" : run.running ? "text-info" : "text-ink-faint")}>
												{run.thinking
												? t("branchBoard.agents.working")
												: run.running
													? t("branchBoard.agents.waiting")
													: t("branchBoard.agents.stopped")}
											</span>
										</span>
										<ContextGauge run={run} compact />
									</button>
								))}
							</div>
						)}
						{group.terminals.length > 0 ? (
							<div className="mt-2 flex flex-wrap gap-1">
								{group.terminals.map((terminal) => (
									<button
										key={terminal.id}
										type="button"
										onClick={() => show(cwd, { kind: "terminal", id: terminal.id })}
										className="focus-ring flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
									>
										<Terminal size={11} />
										{terminal.label || t("branchBoard.agents.terminal")}
									</button>
								))}
							</div>
						) : null}
					</Card>

					<Card
						icon={GitCommitHorizontal}
						section="commits"
						title={t("branchBoard.commits.title")}
						aside={
							tree?.status ? (
								<Pill>{t("branchBoard.commits.aheadBehind", { ahead: tree.status.ahead, behind: tree.status.behind })}</Pill>
							) : null
						}
						loading={commits.initial}
					>
						{(commits.data ?? []).length === 0 ? (
							<p className="text-[12px] text-ink-faint">{t("branchBoard.commits.none")}</p>
						) : (
							<ul className="flex flex-col gap-1">
								{(commits.data ?? []).map((commit) => (
									<li key={commit.sha} className="flex items-baseline gap-2 text-[11.5px]">
										<span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{commit.sha.slice(0, 7)}</span>
										<span className="min-w-0 flex-1 truncate text-ink">{commit.subject}</span>
										<span className="shrink-0 text-[10.5px] text-ink-faint">{commit.relative}</span>
									</li>
								))}
							</ul>
						)}
					</Card>

					<Card
						icon={PencilLine}
						section="commits"
						title={t("branchBoard.changes.title")}
						aside={changes.initial ? null : <Pill>{(changes.data ?? []).length}</Pill>}
						loading={changes.initial}
					>
						{(changes.data ?? []).length === 0 ? (
							<p className="text-[12px] text-ink-faint">{t("branchBoard.changes.none")}</p>
						) : (
							<ul className="flex flex-col gap-0.5">
								{(changes.data ?? []).slice(0, 12).map((change) => (
									<li key={change.path}>
										<button
											type="button"
											onClick={() => viewer?.open(`${cwd}/${change.path}`)}
											className="focus-ring flex w-full items-center gap-2 rounded px-1 text-left text-[11.5px] hover:bg-raised"
										>
											<span className="min-w-0 flex-1 truncate font-mono text-ink">{change.path}</span>
											{change.state === "untracked" ? (
												<span className="shrink-0 text-[10.5px] text-info">{t("branchBoard.new")}</span>
											) : (
												<span className="shrink-0 font-mono text-[10.5px]">
													<span className="text-success">+{change.added}</span> <span className="text-critical">−{change.removed}</span>
												</span>
											)}
										</button>
									</li>
								))}
							</ul>
						)}
					</Card>

					{visuals.length > 0 ? (
						<Card icon={ImageIcon} section="captures" title={t("branchBoard.captures.title")} aside={<Pill>{visuals.length}</Pill>}>
							{/* La carte défile : aucune raison de s'arrêter aux neuf premières. */}
							<div className="grid grid-cols-3 gap-1.5">
								{visuals.map((file) => {
									const media = mediaOfPath(file.path);
									return media ? (
										<button
											key={file.path}
											type="button"
											onClick={() => viewer?.open(file.path)}
											className="focus-ring overflow-hidden rounded-md"
											title={file.relative}
										>
											<MediaThumb media={media} width={120} className="h-20 w-full rounded-md" />
										</button>
									) : null;
								})}
							</div>
						</Card>
					) : null}

					{myPorts.length > 0 ? (
						<Card icon={Network} section="ports" title={t("branchBoard.ports.title")} aside={<Pill>{myPorts.length}</Pill>}>
							<ul className="flex flex-col gap-1">
								{myPorts.map((port) => (
									<li key={`${port.pid}-${port.port}`}>
										<button
											type="button"
											onClick={() => void api.system.openUrl(`http://localhost:${port.port}`).catch(() => undefined)}
											className="focus-ring flex w-full items-center gap-2 rounded px-1 text-left text-[11.5px] hover:bg-raised"
										>
											<span className="font-mono text-ink">:{port.port}</span>
											<span className="min-w-0 flex-1 truncate text-ink-muted">{port.process}</span>
											<span className="shrink-0 text-[10.5px] text-ink-faint">{t("branchBoard.ports.memory", { mb: Math.round(port.memoryMb) })}</span>
										</button>
									</li>
								))}
							</ul>
						</Card>
					) : null}
				</div>

				{/* Chaque document du worktree est une carte : on les lit sans les
				    chercher. */}
				{docs.initial && active && (!only || only === "docs") ? (
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4" aria-hidden>
						{[0, 1, 2, 3].map((index) => (
							<div key={index} className="h-40 rounded-[var(--radius-panel)] bg-surface p-3.5 shadow-[var(--shadow-card)]">
								<SkeletonRows rows={3} />
							</div>
						))}
					</div>
				) : null}
				{(docs.data ?? []).length > 0 && (!only || only === "docs") ? (
					<>
						<p className="mt-1 px-1 text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
							{t("branchBoard.docs.title", { count: (docs.data ?? []).length })}
						</p>
						<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
							{(docs.data ?? []).map((doc) => (
								<button
									key={doc.path}
									type="button"
									onClick={() => viewer?.open(doc.path)}
									className="focus-ring flex h-40 flex-col gap-1.5 overflow-hidden rounded-[var(--radius-panel)] bg-surface p-3.5 text-left shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-pop)]"
								>
									<span className="flex items-center gap-1.5">
										<FileText size={13} className="shrink-0 text-accent" />
										<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{doc.name}</span>
										{doc.untracked ? <Pill tone="accent">{t("branchBoard.new")}</Pill> : null}
									</span>
									<span className="truncate font-mono text-[10px] text-ink-faint">{doc.relative}</span>
									<span className="line-clamp-4 text-[11.5px] leading-relaxed text-ink-muted">{doc.preview}</span>
									<span className="mt-auto text-[10.5px] text-ink-faint">{fromSeconds(Date.now() / 1000 - doc.modified)}</span>
								</button>
							))}
						</div>
					</>
				) : null}
			</div>
		</div>
		</Only.Provider>
	);
}

/** Combien de captures on dessine d'un coup : la suite vient en défilant. */
const CAPTURE_PAGE = 24;

/**
 * Les captures de recette, à une taille où on les juge.
 *
 * Dans la vue, elles tenaient en neuf vignettes de 80 px : de quoi savoir qu'il
 * y en a, pas ce qu'elles montrent. Seules dans leur panneau, elles prennent la
 * largeur qu'on leur donne, les plus récentes d'abord, et toutes y sont — la
 * suite se dessine en défilant, pour ne pas décoder cent images d'un coup. Un
 * clic ouvre en grand, avec les flèches pour passer de l'une à l'autre.
 */
function CaptureGallery({ files, loading }: { files: QaFile[]; loading: boolean }) {
	const { t } = useTranslation("components2");
	const all = useMemo(
		() =>
			[...files]
				.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
				.flatMap((file) => {
					const media = mediaOfPath(file.path);
					return media ? [{ file, media }] : [];
				}),
		[files],
	);
	const [count, setCount] = useState(CAPTURE_PAGE);
	const more = useRef<HTMLDivElement>(null);
	const rest = all.length - count;
	useEffect(() => {
		const node = more.current;
		if (!node || rest <= 0) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setCount((value) => value + CAPTURE_PAGE);
			},
			{ rootMargin: "600px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [rest]);

	const shown = all.slice(0, count);
	const media = useMemo(() => all.map((entry) => entry.media), [all]);

	return (
		<div className="min-h-0 flex-1 overflow-y-auto bg-base px-4 py-4">
			{loading ? (
				<SkeletonRows rows={4} />
			) : all.length === 0 ? (
				<p className="p-2 text-[12.5px] text-ink-muted">{t("branchBoard.captures.none")}</p>
			) : (
				<>
					<p className="mb-3 px-1 text-[11.5px] text-ink-faint">
						{t("branchBoard.captures.count", { count: all.length })}
					</p>
					<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
						{shown.map(({ file, media: item }, index) => (
							<button
								key={file.path}
								type="button"
								onClick={() => openLightbox(media, index)}
								title={file.relative}
								className="focus-ring group flex flex-col overflow-hidden rounded-[var(--radius-panel)] bg-surface text-left shadow-[var(--shadow-card)] transition-shadow hover:shadow-pop"
							>
								<MediaThumb media={item} width={520} className="aspect-[16/10] w-full" />
								<span className="flex items-baseline gap-2 px-3 py-2">
									<span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{file.name}</span>
									{file.modified ? (
										<span className="shrink-0 text-[10.5px] text-ink-faint">
											{fromSeconds(Date.now() / 1000 - file.modified)}
										</span>
									) : null}
								</span>
							</button>
						))}
					</div>
					{rest > 0 ? (
						<div ref={more} className="py-4 text-center text-[11.5px] text-ink-faint">
							{t("branchBoard.captures.more", { count: rest })}
						</div>
					) : null}
				</>
			)}
		</div>
	);
}

function Card({
	icon: Icon,
	title,
	aside,
	tone,
	className,
	loading,
	section,
	children,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>;
	title: string;
	aside?: React.ReactNode;
	tone?: "accent";
	className?: string;
	/** Rien n'est encore arrivé : la carte dit qu'elle cherche, pas « aucun ». */
	loading?: boolean;
	/** La partie de la vue à laquelle cette carte appartient, quand on n'en montre qu'une. */
	section?: BoardSection;
	children: React.ReactNode;
}) {
	const only = useContext(Only);
	if (only && section !== only) return null;
	return (
		<section
			className={clsx(
				// Seule dans son panneau, la carte n'a plus à se borner.
				only && "!max-h-none",
				"flex max-h-80 min-h-0 flex-col gap-2.5 overflow-hidden rounded-[var(--radius-panel)] bg-surface p-4 shadow-[var(--shadow-card)]",
				tone === "accent" && "ring-1 ring-accent/30",
				className,
			)}
		>
			<header className="flex items-center gap-2">
				<Icon size={14} className={tone === "accent" ? "text-accent" : "text-ink-faint"} />
				<span className="text-[12px] font-semibold text-ink">{title}</span>
				<span className="ml-auto">{aside}</span>
			</header>
			<div className="min-h-0 overflow-y-auto">{loading ? <SkeletonRows rows={3} /> : children}</div>
		</section>
	);
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: "accent" | "success" | "warning" | "critical" }) {
	const tones = {
		accent: "bg-accent-dim text-accent-soft",
		success: "bg-success/12 text-success",
		warning: "bg-warning/12 text-warning",
		critical: "bg-critical/12 text-critical",
	};
	return (
		<span className={clsx("inline-flex h-[18px] items-center rounded-md px-1.5 text-[10.5px] font-semibold whitespace-nowrap", tone ? tones[tone] : "bg-raised text-ink-muted")}>
			{children}
		</span>
	);
}

