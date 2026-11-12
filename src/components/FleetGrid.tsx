import clsx from "clsx";
import {
	ArrowUpFromLine,
	Bot,
	ChevronDown,
	ChevronRight,
	FilePen,
	FolderOpen,
	GitBranch,
	GitBranchPlus,
	GitCommitHorizontal,
	Terminal,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dot, StatTile } from "@/components/ui";
import { fromSeconds, fromTimestamp, truncate } from "@/lib/format";
import { api } from "@/lib/ipc";
import { useAsync } from "@/lib/useAsync";
import type { SessionSummary, Worktree, WorktreeHygiene } from "@/lib/types";
import { useAgentActions } from "@/app/agents";
import { useTerminalActions } from "@/app/terminals";
import { useConfirm } from "@/components/Confirm";
import { JobProgress, useJobRunning } from "@/components/JobProgress";
import { useAllSessions, useCockpit } from "@/app/store";
import { useTranslation } from "react-i18next";

/** Un jour ouvré de tolérance : un worktree touché hier compte encore. */
const RECENT_GIT_SECONDS = 24 * 3600;
const LIVE_AGENT_SECONDS = 180;
const RECENT_AGENT_SECONDS = 3600;

type Status = "waiting" | "flight" | "recent" | "resting";

interface Ship {
	tree: Worktree;
	status: Status;
	agent: SessionSummary | null;
	dirty: number;
}

/**
 * Trois états seulement, parce qu'une liste de dix-sept arbres où tout se
 * ressemble ne dit rien : ce qui tourne maintenant, ce qui vient de tourner, et
 * le reste — qu'on ne montre que sur demande.
 */
function classify(tree: Worktree, agent: SessionSummary | null, now: number): Status {
	const dirty = tree.status.modified + tree.status.staged + tree.status.untracked;
	const agentLive = agent !== null && agent.idleSeconds < LIVE_AGENT_SECONDS;
	const gitFresh =
		tree.lastActivity !== null && now - tree.lastActivity < RECENT_GIT_SECONDS;

	// Un agent qui attend passe devant tout le reste : c'est le seul cas où
	// c'est toi qui bloques, pas la machine.
	if (agent !== null && agent.awaitingInput && agent.idleSeconds < RECENT_AGENT_SECONDS) {
		return "waiting";
	}
	if (agentLive || dirty > 0 || gitFresh) return "flight";
	if (agent !== null && agent.idleSeconds < RECENT_AGENT_SECONDS) return "recent";
	return "resting";
}

function ShipCard({ ship, onOpen }: { ship: Ship; onOpen: () => void }) {
	const { t } = useTranslation("components1");
	const { notify } = useCockpit();
	const { open: openAgent } = useAgentActions();
	const { open: openTerminal } = useTerminalActions();
	const { tree, agent } = ship;
	const live = agent !== null && agent.idleSeconds < LIVE_AGENT_SECONDS;

	const guard = (promise: Promise<unknown>) => {
		void promise.catch((error) => notify(String(error)));
	};

	// Le liseré dit l'état avant qu'on lise quoi que ce soit : c'est ce qui
	// permet de balayer une flotte de vingt cartes.
	const edge = {
		waiting: "before:bg-critical",
		flight: live ? "before:bg-success" : ship.dirty > 0 ? "before:bg-warning" : "before:bg-accent/50",
		recent: "before:bg-warning/60",
		resting: "before:bg-line",
	}[ship.status];

	return (
		<div
			className={clsx(
				"panel relative flex flex-col gap-2.5 overflow-hidden p-3.5 pl-4 transition-[border-color,transform] duration-150 before:absolute before:inset-y-0 before:left-0 before:w-[3px] hover:-translate-y-px hover:border-line",
				edge,
			)}
		>
			<button type="button" onClick={onOpen} className="min-w-0 text-left">
				<div className="flex items-center gap-2">
					<GitBranch
						size={12}
						className={clsx(
							"shrink-0",
							tree.isMain ? "text-accent-soft" : "text-ink-faint",
						)}
					/>
					<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
						{tree.branch ?? tree.folderName}
					</span>
					{live ? <Dot tone="success" pulse /> : null}
					{tree.isMain ? <Badge tone="accent">{t("fleetGrid.main")}</Badge> : null}
				</div>
				<p className="mt-0.5 truncate pl-5 font-mono text-[10px] text-ink-faint">{tree.folderName}</p>

				{/* Le dernier commit : c'est ce qui dit où en est une branche, bien
				    mieux qu'un « propre » isolé sur sa ligne. */}
				{tree.lastCommit ? (
					<div className="mt-2 flex items-start gap-1.5 rounded-lg bg-raised/60 px-2 py-1.5">
						<GitCommitHorizontal size={12} className="mt-px shrink-0 text-ink-faint" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[11.5px] text-ink-muted">
								{tree.lastCommit.subject}
							</span>
							<span className="block truncate font-mono text-[10px] text-ink-faint">
								{tree.lastCommit.sha.slice(0, 7)} · {tree.lastCommit.author} · {tree.lastCommit.relative}
							</span>
						</span>
					</div>
				) : null}

				<div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-ink-faint">
					{ship.dirty > 0 ? (
						<span className="text-warning">{t("fleetGrid.changes", { count: ship.dirty })}</span>
					) : (
						<span>{t("fleetGrid.clean")}</span>
					)}
					{tree.status.conflicted > 0 ? (
						<span className="text-critical">
							{t("fleetGrid.conflicts", { count: tree.status.conflicted })}
						</span>
					) : null}
					{tree.status.ahead > 0 ? (
						<span className="text-info">↑{tree.status.ahead}</span>
					) : null}
					{tree.status.behind > 0 ? <span>↓{tree.status.behind}</span> : null}
					<span className="ml-auto">{fromTimestamp(tree.lastActivity)}</span>
				</div>

				{agent ? (
					<div className="mt-1.5 flex items-start gap-1.5">
						<Bot
							size={11}
							className={clsx(
								"mt-0.5 shrink-0",
								ship.status === "waiting"
									? "text-critical"
									: live
										? "text-success"
										: "text-ink-faint",
							)}
						/>
						<div className="min-w-0 flex-1">
							<p className="truncate text-[11px] text-ink-muted">
								{truncate(agent.lastPrompt ?? agent.title, 70)}
							</p>
							<p className="font-mono text-[10px] text-ink-faint">
								{ship.status === "waiting" ? (
									<span className="text-critical">{t("fleetGrid.awaitingReply")}</span>
								) : (
									<>{live ? t("fleetGrid.running") : t("fleetGrid.idle")}</>
								)}{" "}
								· {fromSeconds(agent.idleSeconds)}
								{agent.subagents > 0
									? ` · ${t("fleetGrid.subagents", { count: agent.subagents })}`
									: ""}
							</p>
						</div>
					</div>
				) : null}
			</button>

			<div className="mt-auto flex gap-1 border-t border-line-soft pt-2.5">
				<Button
					size="sm"
					icon={Bot}
					onClick={() => openAgent(tree.path)}
					title={t("fleetGrid.launchAgent")}
				>
					{t("fleetGrid.agent")}
				</Button>
				<Button
					size="sm"
					icon={Terminal}
					onClick={() => openTerminal(tree.path)}
					title={t("fleetGrid.openTerminal")}
				/>
				<Button
					size="sm"
					icon={FolderOpen}
					onClick={() => guard(api.system.openEditor(tree.path))}
					title={t("fleetGrid.openEditor")}
				/>
				<Button size="sm" className="ml-auto" onClick={onOpen}>
					{t("fleetGrid.detail")}
				</Button>
			</div>
		</div>
	);
}

function Group({
	title,
	tone,
	ships,
	onOpen,
	children,
}: {
	title: string;
	tone: "success" | "warning" | "neutral" | "critical";
	ships: Ship[];
	onOpen: (path: string) => void;
	/** Ce qui se range après les cartes, dans la même grille. */
	children?: React.ReactNode;
}) {
	if (ships.length === 0) return null;
	return (
		<section>
			<div className="mb-1.5 flex items-center gap-1.5">
				<Dot tone={tone} />
				<h2 className="text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
					{title}
				</h2>
				<span className="font-mono text-[10px] text-ink-faint/70">{ships.length}</span>
			</div>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
				{ships.map((ship) => (
					<ShipCard
						key={ship.tree.path}
						ship={ship}
						onOpen={() => onOpen(ship.tree.path)}
					/>
				))}
				{children}
			</div>
		</section>
	);
}

/**
 * Worktrees dont la branche est retombée côté GitHub : PR mergée ou fermée,
 * rien de non commité. Ils survivent parce que personne ne fait le ménage —
 * autant le proposer là où on les regarde.
 */
/**
 * Une ligne du bandeau des worktrees supprimables.
 *
 * Extraite pour qu'elle puisse interroger l'état du job qui la concerne : le
 * bouton ne se rouvre qu'une fois ce job terminé, et l'échec reste affiché à
 * côté. Auparavant, un clic suffisait à désactiver le bouton pour toujours —
 * il fallait changer d'écran pour réessayer.
 */
function RemovableRow({
	entry,
	jobId,
	onRemove,
}: {
	entry: WorktreeHygiene;
	jobId: string | null;
	onRemove: () => void;
}) {
	const { t } = useTranslation("components1");
	const running = useJobRunning(jobId);
	return (
		<div className="flex items-center gap-2 rounded-lg px-1.5 py-1">
			<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">
				{entry.branch ?? entry.folderName}
			</span>
			{entry.pr ? (
				<span className="shrink-0 text-[10px] text-ink-faint">
					#{entry.pr.number} · {entry.reason}
				</span>
			) : (
				<span className="shrink-0 text-[10px] text-ink-faint">{entry.reason}</span>
			)}
			<JobProgress jobId={jobId} />
			<Button size="sm" icon={Trash2} disabled={running} onClick={onRemove}>
				{t("fleetGrid.remove")}
			</Button>
		</div>
	);
}

function Hygiene() {
	const { t } = useTranslation("components1");
	const { runJob, config, jobs, reloadWorktrees } = useCockpit();
	const { confirm } = useConfirm();
	const [open, setOpen] = useState(false);
	// Un job par dossier en cours de suppression : c'est ce qui permet de
	// montrer l'avancement à la bonne ligne.
	const [removing, setRemoving] = useState<Record<string, string>>({});
	const hygiene = useAsync(() => api.worktrees.hygiene(), [], { pollMs: 600_000 });

	// L'hygiène se sonde toutes les dix minutes — trop lent pour une ligne qu'on
	// vient de supprimer soi-même. On relit dès que le job correspondant sort.
	const settled = jobs.filter(
		(job) =>
			job.label.startsWith("worktree ") &&
			(job.state === "succeeded" || job.state === "failed"),
	).length;
	const seen = useRef(settled);
	useEffect(() => {
		if (settled === seen.current) return;
		seen.current = settled;
		hygiene.reload();
		reloadWorktrees();
		// Seule la fin d'un job déclenche la relecture : les `reload` n'ont rien à y ajouter.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [settled]);
	const removable = (hygiene.data ?? []).filter((entry) => entry.removable);

	if (removable.length === 0) return null;

	// L'entrée entière, et non le seul nom de dossier : la commande déclarée par
	// l'équipe peut vouloir la branche ou le chemin, et les redériver du nom
	// serait deviner.
	const remove = async (entry: WorktreeHygiene) => {
		const folder = entry.folderName;
		const ok = await confirm({
			title: t("fleetGrid.confirmTitle", { folder }),
			message: t("fleetGrid.confirmMessage"),
			confirmLabel: t("fleetGrid.remove"),
			danger: true,
		});
		if (!ok) return;
		// `--force` : la question a déjà été posée ici. Sans lui, le CLI la
		// repose sur stdin — que le runner ferme — lit une réponse vide, renonce…
		// et sort en code 0, donnant l'illusion d'une suppression réussie.
		const { command } = await api.git.worktreeCommand(
			"remove",
			entry.branch ?? folder,
			entry.path,
		);
		const status = await runJob(`worktree remove ${folder}`, command, config?.mainRepo ?? "");
		if (status) setRemoving((current) => ({ ...current, [folder]: status.jobId }));
	};

	return (
		<section className="rounded-xl border border-line-soft bg-surface/40 p-2.5">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-1.5 text-left"
			>
				<Trash2 size={11} className="shrink-0 text-ink-faint" />
				<span className="text-[11px] text-ink-muted">
					{t("fleetGrid.removable", { count: removable.length })}
				</span>
				<span className="ml-auto text-[10px] text-ink-faint">
					{open ? t("fleetGrid.hide") : t("fleetGrid.show")}
				</span>
			</button>

			{open ? (
				<div className="mt-2 flex flex-col gap-1">
					{removable.map((entry) => (
						<RemovableRow
							key={entry.path}
							entry={entry}
							jobId={removing[entry.folderName] ?? null}
							onRemove={() => void remove(entry)}
						/>
					))}
				</div>
			) : null}
		</section>
	);
}

/**
 * La carte qui propose d'en ouvrir un autre.
 *
 * Avec le seul `main`, l'écran montrait une carte perdue à gauche d'un grand
 * vide, sans dire à quoi servent les worktrees ni comment en créer un — le
 * bouton « Nouveau » était tout en haut à droite, à l'autre bout de l'écran.
 */
function Invitation({ onCreate }: { onCreate: () => void }) {
	const { t } = useTranslation("components1");
	return (
		<button
			type="button"
			onClick={onCreate}
			// `auto / -1` : la carte va jusqu'au bout de sa rangée. Une flotte de
			// deux arbres laissait sinon quatre colonnes vides à droite.
			className="focus-ring flex min-h-[7rem] items-center gap-4 rounded-[var(--radius-panel)] border border-dashed border-line p-5 text-left transition-colors [grid-column:auto/-1] hover:border-accent/60 hover:bg-accent-dim/40"
		>
			<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-dim text-accent">
				<GitBranchPlus size={18} />
			</span>
			<span className="flex min-w-0 flex-col gap-1">
				<span className="text-[13px] font-semibold text-ink">{t("fleetGrid.invite.title")}</span>
				<span className="text-[11.5px] leading-relaxed text-ink-faint">{t("fleetGrid.invite.body")}</span>
			</span>
		</button>
	);
}

export function FleetGrid({
	onOpen,
	onCreate,
}: {
	onOpen: (path: string) => void;
	/** Créer un worktree : le même geste que le bouton « Nouveau » de l'en-tête. */
	onCreate?: () => void;
}) {
	const { t } = useTranslation("components1");
	const { worktrees } = useCockpit();
	const sessions = useAllSessions();
	const [showResting, setShowResting] = useState(false);

	const fleet = useMemo(() => {
		const now = Math.floor(Date.now() / 1000);
		// La session la plus fraîche du dossier représente le worktree.
		const byPath = new Map<string, SessionSummary>();
		for (const session of sessions) {
			const current = byPath.get(session.cwd);
			if (!current || session.idleSeconds < current.idleSeconds) {
				byPath.set(session.cwd, session);
			}
		}

		return worktrees
			.map((tree) => {
				const agent = byPath.get(tree.path) ?? null;
				return {
					tree,
					agent,
					dirty: tree.status.modified + tree.status.staged + tree.status.untracked,
					status: classify(tree, agent, now),
				} satisfies Ship;
			})
			.sort((a, b) => {
				const live = (ship: Ship) =>
					ship.agent && ship.agent.idleSeconds < LIVE_AGENT_SECONDS ? 0 : 1;
				return live(a) - live(b) || (b.tree.lastActivity ?? 0) - (a.tree.lastActivity ?? 0);
			});
	}, [worktrees, sessions]);

	const waiting = fleet.filter((ship) => ship.status === "waiting");
	const flight = fleet.filter((ship) => ship.status === "flight");
	const recent = fleet.filter((ship) => ship.status === "recent");
	const resting = fleet.filter((ship) => ship.status === "resting");

	const live = fleet.filter((ship) => ship.agent && ship.agent.idleSeconds < LIVE_AGENT_SECONDS).length;
	const dirty = fleet.reduce((sum, ship) => sum + ship.dirty, 0);
	const ahead = fleet.reduce((sum, ship) => sum + ship.tree.status.ahead, 0);
	// L'invitation se range dans le premier groupe affiché, au bout de ses
	// cartes : tant que la flotte tient sur une rangée, elle comble le vide.
	const invite = onCreate && fleet.length < 4 ? <Invitation onCreate={onCreate} /> : null;
	const first =
		waiting.length > 0 ? "waiting" : flight.length > 0 ? "flight" : recent.length > 0 ? "recent" : null;

	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-5">
			<div className="flex flex-col gap-5">
				{/* La flotte en quatre chiffres : ce qui tourne, ce qui n'est pas
				    commité, ce qui n'est pas poussé. */}
				<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<StatTile icon={GitBranch} label={t("fleetGrid.stats.trees")} value={fleet.length} tone="accent" />
					<StatTile icon={Bot} label={t("fleetGrid.stats.agents")} value={live} tone="success" />
					<StatTile icon={FilePen} label={t("fleetGrid.stats.dirty")} value={dirty} tone="warning" />
					<StatTile icon={ArrowUpFromLine} label={t("fleetGrid.stats.ahead")} value={ahead} tone="info" />
				</div>
				<Hygiene />
				<Group title={t("fleetGrid.group.waiting")} tone="critical" ships={waiting} onOpen={onOpen}>
					{first === "waiting" ? invite : null}
				</Group>
				<Group title={t("fleetGrid.group.flight")} tone="success" ships={flight} onOpen={onOpen}>
					{first === "flight" ? invite : null}
				</Group>
				<Group title={t("fleetGrid.group.recent")} tone="warning" ships={recent} onOpen={onOpen}>
					{first === "recent" ? invite : null}
				</Group>
				{first === null && invite ? (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">{invite}</div>
				) : null}

				{resting.length > 0 ? (
					<section>
						<button
							type="button"
							onClick={() => setShowResting((open) => !open)}
							className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase hover:text-ink-muted"
						>
							{showResting ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
							{t("fleetGrid.group.resting")}
							<span className="font-mono normal-case">{resting.length}</span>
						</button>
						{showResting ? (
							<div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
								{resting.map((ship) => (
									<ShipCard
										key={ship.tree.path}
										ship={ship}
										onOpen={() => onOpen(ship.tree.path)}
									/>
								))}
							</div>
						) : null}
					</section>
				) : null}

				{fleet.length === 0 ? (
					<p className="py-10 text-center text-[11px] text-ink-faint">{t("fleetGrid.empty")}</p>
				) : null}
			</div>
		</div>
	);
}
