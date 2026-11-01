import clsx from "clsx";
import {
	Archive,
	Folder,
	FolderOpen,
	GitBranch,
	GitFork,
	MessageSquare,
	RotateCcw,
	Square,
	SquareTerminal,
	Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentChat } from "@/components/AgentChat";
import { LibreLauncher } from "@/components/LibreLauncher";
import { Modal, Spinner } from "@/components/ui";
import { MODELS, PERMISSION_MODES, useAgentGuard, useAgentRuns, type AgentRun } from "@/app/agents";
import { useCockpit } from "@/app/store";
import { api } from "@/lib/ipc";
import {
	openLauncher,
	patchLibre,
	selectLibre,
	setLibresOnScreen,
	tilde,
	useLauncher,
	useLibres,
	useSelectedLibre,
	type LibreAgent,
} from "@/lib/libre";
import { useAsync } from "@/lib/useAsync";
import { t } from "@/i18n";
import { formatShortcut, platformContext } from "@/lib/platform";
import { homeOf } from "@/lib/paths";

/**
 * L'écran des agents libres.
 *
 * Ce qu'on lançait au terminal, rangé par dossier : qui travaille, qui attend
 * une réponse, qui a fini. La conversation est la même que partout ailleurs
 * (`AgentChat`) ; ce qui change, c'est qu'il n'y a autour ni chantier, ni
 * terminaux, ni navigateur — rien qu'on n'ait pas demandé.
 */

type Filter = "tous" | "toi" | "cours" | "finis";

interface Entry {
	agent: LibreAgent;
	run: AgentRun | null;
	state: "attend" | "travaille" | "pret" | "arrete" | "ferme";
	line: string;
}

function stateLabel(state: Entry["state"]): string {
	return t(`views:libres.state.${state}`);
}

function show(path: string): string {
	return tilde(path, homeOf(path));
}

function ago(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000);
	if (minutes < 1) return t("views:libres.ago.now");
	if (minutes < 60) return t("views:libres.ago.minutes", { count: minutes });
	const hours = Math.round(minutes / 60);
	if (hours < 24) return t("views:libres.ago.hours", { count: hours });
	return t("views:libres.ago.days", { count: Math.round(hours / 24) });
}

function lastWords(run: AgentRun): string {
	for (let index = run.turns.length - 1; index >= 0; index -= 1) {
		const turn = run.turns[index];
		if (turn.kind === "assistant" && turn.text.trim()) return turn.text.trim().split("\n")[0];
	}
	return "";
}

/** Ce que chaque agent libre est en train de faire, lu dans sa conversation. */
function useEntries(): Entry[] {
	const agents = useLibres();
	const { runs } = useAgentRuns();
	const { pendingFor } = useAgentGuard();
	const { t } = useTranslation("views");
	return useMemo(
		() =>
			agents
				.filter((agent) => !agent.archivedAt)
				.map((agent): Entry => {
					const run = runs.find((candidate) => candidate.id === agent.runId) ?? null;
					if (!run) return { agent, run, state: "ferme", line: t("libres.line.closed") };
					const pending = pendingFor(run.id);
					if (pending.length > 0) {
						return { agent, run, state: "attend", line: pending[0].tool === "AskUserQuestion" ? t("libres.line.question") : t("libres.line.asks", { tool: pending[0].tool }) };
					}
					if (run.thinking) return { agent, run, state: "travaille", line: run.activity ?? t("libres.line.thinking") };
					if (run.running) return { agent, run, state: "pret", line: lastWords(run) || t("libres.line.firstMessage") };
					return { agent, run, state: "arrete", line: lastWords(run) || t("libres.state.arrete") };
				}),
		[agents, runs, pendingFor, t],
	);
}

/** Combien d'agents libres attendent quelque chose de toi — pour l'onglet du haut. */
export function useLibresWaiting(): { open: number; waiting: number } {
	const entries = useEntries();
	return {
		open: entries.filter((entry) => entry.state !== "ferme").length,
		waiting: entries.filter((entry) => entry.state === "attend").length,
	};
}

/**
 * Ce qui doit tourner même quand l'écran n'est pas affiché : le lanceur, et le
 * rattachement des sessions — sans `claudeSessionId` retenu, un agent fermé ne
 * se reprendrait plus.
 */
export function LibreHost() {
	const launcher = useLauncher();
	const agents = useLibres();
	const { runs } = useAgentRuns();

	useEffect(() => {
		for (const agent of agents) {
			if (!agent.runId || agent.archivedAt) continue;
			const run = runs.find((candidate) => candidate.id === agent.runId);
			if (!run) continue;
			if (run.sessionId !== agent.sessionId || run.claudeSessionId !== agent.claudeSessionId) {
				patchLibre(agent.id, {
					sessionId: run.sessionId ?? agent.sessionId,
					claudeSessionId: run.claudeSessionId ?? agent.claudeSessionId,
				});
			}
		}
	}, [agents, runs]);

	return launcher.open ? <LibreLauncher initialFolder={launcher.folder} /> : null;
}

export function LibresView() {
	const { t } = useTranslation("views");
	const entries = useEntries();
	const selected = useSelectedLibre();
	const [filter, setFilter] = useState<Filter>("tous");

	useEffect(() => {
		setLibresOnScreen(true);
		return () => setLibresOnScreen(false);
	}, []);

	// Rien de choisi, ou un agent archivé entre-temps : on montre le premier.
	const current = entries.find((entry) => entry.agent.id === selected) ?? entries[0] ?? null;
	useEffect(() => {
		if (current && current.agent.id !== selected) selectLibre(current.agent.id);
	}, [current, selected]);

	if (entries.length === 0) return <LibresEmpty />;

	const counts = {
		tous: entries.length,
		toi: entries.filter((entry) => entry.state === "attend" || entry.state === "pret").length,
		cours: entries.filter((entry) => entry.state === "travaille").length,
		finis: entries.filter((entry) => entry.state === "arrete" || entry.state === "ferme").length,
	};
	const visible = entries.filter((entry) =>
		filter === "tous"
			? true
			: filter === "toi"
				? entry.state === "attend" || entry.state === "pret"
				: filter === "cours"
					? entry.state === "travaille"
					: entry.state === "arrete" || entry.state === "ferme",
	);
	const folders = [...new Set(visible.map((entry) => entry.agent.folder))];

	return (
		<div className="flex min-h-0 flex-1 gap-4 p-4">
			<aside className="flex w-[340px] shrink-0 flex-col gap-3">
				<div className="flex items-baseline gap-2 px-1 pt-1">
					<h1 className="text-[19px] font-semibold text-ink">{t("libres.title")}</h1>
					<span className="font-mono text-[11.5px] text-ink-muted">
						{t("libres.open", { count: entries.length })}
					</span>
				</div>
				<div className="flex flex-wrap gap-1.5">
					{(
						[
							["tous", t("libres.filter.all")],
							["toi", t("libres.filter.yours")],
							["cours", t("libres.filter.running")],
							["finis", t("libres.filter.finished")],
						] as Array<[Filter, string]>
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							onClick={() => setFilter(id)}
							className={clsx(
								"focus-ring h-7 rounded-[7px] px-2.5 text-[11.5px] font-medium",
								filter === id ? "bg-ink text-base" : "bg-surface text-ink-muted shadow-card hover:text-ink",
							)}
						>
							{label} · {counts[id]}
						</button>
					))}
				</div>
				<div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pb-2">
					{folders.map((folder) => (
						<div key={folder}>
							<div className="flex items-center gap-1.5 px-1 pb-1.5 font-mono text-[11.5px] text-ink-muted">
								<Folder size={12} />
								<span className="truncate">{show(folder)}</span>
								<button
									type="button"
									title={t("libres.oneMore")}
									onClick={() => openLauncher(folder)}
									className="focus-ring ml-auto rounded px-1 text-ink-faint hover:text-accent"
								>
									+
								</button>
							</div>
							<div className="flex flex-col gap-1.5">
								{visible
									.filter((entry) => entry.agent.folder === folder)
									.map((entry) => (
										<AgentCard
											key={entry.agent.id}
											entry={entry}
											selected={current?.agent.id === entry.agent.id}
										/>
									))}
							</div>
						</div>
					))}
				</div>
			</aside>
			{current ? <AgentDetail key={current.agent.id} entry={current} /> : null}
		</div>
	);
}

function Dot({ state }: { state: Entry["state"] }) {
	return (
		<span
			className={clsx(
				"h-2 w-2 shrink-0 rounded-full",
				state === "attend" && "bg-warning",
				state === "travaille" && "animate-pulse bg-success",
				state === "pret" && "bg-accent",
				(state === "arrete" || state === "ferme") && "bg-ink-faint",
			)}
		/>
	);
}

function Tag({ children }: { children: React.ReactNode }) {
	return <span className="rounded-[5px] bg-raised px-1.5 py-px font-mono text-[10.5px] text-ink-muted">{children}</span>;
}

function placeTag(agent: LibreAgent): string {
	if (agent.place === "worktree") return `worktree · ${agent.branch}`;
	if (agent.place === "branche") return agent.branch;
	return agent.branch ? `${t("views:libres.inPlace")} · ${agent.branch}` : t("views:libres.inPlace");
}

function modelTag(agent: LibreAgent): string {
	return agent.model ? (MODELS.find((entry) => entry.id === agent.model)?.label ?? agent.model) : t("views:libres.defaultModel");
}

function AgentCard({ entry, selected }: { entry: Entry; selected: boolean }) {
	const { config } = useCockpit();
	const account = config?.accounts?.find((candidate) => candidate.id === entry.agent.account)?.label ?? entry.agent.account;
	return (
		<button
			type="button"
			onClick={() => selectLibre(entry.agent.id)}
			className={clsx(
				"focus-ring flex flex-col gap-1.5 rounded-xl bg-surface p-3 text-left transition-shadow duration-150",
				selected ? "ring-2 ring-accent" : "shadow-card hover:shadow-[var(--shadow-pop)]",
			)}
		>
			<span className="flex items-center gap-2">
				<Dot state={entry.state} />
				<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{entry.agent.label}</span>
				<span className="font-mono text-[10.5px] text-ink-muted">{ago(entry.agent.createdAt)}</span>
			</span>
			<span
				className={clsx(
					"truncate text-[12px]",
					entry.state === "attend" ? "font-medium text-warning" : entry.state === "travaille" ? "text-success" : "text-ink-muted",
				)}
			>
				{entry.state === "attend" || entry.state === "travaille" ? `${stateLabel(entry.state)} · ` : ""}
				{entry.line}
			</span>
			<span className="flex flex-wrap gap-1">
				<Tag>{placeTag(entry.agent)}</Tag>
				<Tag>{modelTag(entry.agent)}</Tag>
				<Tag>{account}</Tag>
			</span>
		</button>
	);
}

function AgentDetail({ entry }: { entry: Entry }) {
	const { t } = useTranslation("views");
	const { config, notify } = useCockpit();
	const { stop, open, close } = useAgentRuns();
	const [tab, setTab] = useState<"chat" | "diff">("chat");
	const [archiving, setArchiving] = useState(false);
	const [resuming, setResuming] = useState(false);
	const { agent, run } = entry;
	const account = config?.accounts?.find((candidate) => candidate.id === agent.account)?.label ?? agent.account;
	const mode = PERMISSION_MODES.find((candidate) => candidate.id === agent.mode)?.label ?? agent.mode;
	const changes = useAsync(() => api.worktrees.changes(agent.cwd).catch(() => []), [agent.cwd, tab], {
		pollMs: tab === "diff" ? 5000 : undefined,
		enabled: agent.place !== "ici" || Boolean(agent.branch),
	});

	const resume = async () => {
		if (!agent.claudeSessionId) {
			notify(t("libres.detail.nothingToResume"));
			return;
		}
		setResuming(true);
		try {
			const scan = await api.sessions.scan(80).catch(() => []);
			const file = scan.flatMap((project) => project.sessions).find((session) => session.id === agent.claudeSessionId)?.file;
			const runId = open(agent.cwd, "", agent.claudeSessionId, file, true, {
				label: agent.label,
				libre: { mode: agent.mode, model: agent.model, account: agent.account, depth: agent.depth },
			});
			patchLibre(agent.id, { runId: runId ?? null });
		} finally {
			setResuming(false);
		}
	};

	const badge =
		entry.state === "attend"
			? "bg-warning/10 text-warning"
			: entry.state === "travaille"
				? "bg-success/10 text-success"
				: entry.state === "pret"
					? "bg-accent-dim text-accent"
					: "bg-raised text-ink-muted";

	return (
		<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-panel)] bg-surface shadow-card">
			<div className="flex items-start gap-3 px-5 pt-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2.5">
						<h2 className="truncate text-[17px] font-semibold text-ink">{agent.label}</h2>
						<span className={clsx("shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold", badge)}>
							{stateLabel(entry.state)}
						</span>
					</div>
					<div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-ink-muted">
						<span className="flex items-center gap-1.5">
							{agent.place === "worktree" ? <GitFork size={12} /> : <Folder size={12} />}
							<span className="font-mono">{show(agent.cwd)}</span>
						</span>
						{agent.branch ? (
							<span className="flex items-center gap-1.5">
								<GitBranch size={12} />
								<span className="font-mono">{agent.branch}</span>
							</span>
						) : null}
						<span>
							{modelTag(agent)} · {account} · {mode}
						</span>
					</div>
				</div>
				<div className="flex shrink-0 gap-1.5">
					<IconAction label={t("libres.detail.openTerminal")} onClick={() => void api.system.openTerminal(agent.cwd)}>
						<SquareTerminal size={15} />
					</IconAction>
					<IconAction label={t("libres.detail.reveal", { context: platformContext })} onClick={() => void api.system.reveal(agent.cwd)}>
						<FolderOpen size={15} />
					</IconAction>
					{run?.running ? (
						<TextAction onClick={() => stop(run.id)} icon={<Square size={12} />}>
							{t("libres.detail.stop")}
						</TextAction>
					) : (
						<TextAction
							onClick={() => void resume()}
							icon={resuming ? <Spinner size={12} /> : <RotateCcw size={12} />}
						>
							{t("libres.detail.resume")}
						</TextAction>
					)}
					<TextAction onClick={() => setArchiving(true)} icon={<Archive size={12} />}>
						{t("libres.detail.archive")}
					</TextAction>
				</div>
			</div>

			<div role="tablist" className="mt-3 flex gap-1 border-b border-line-soft px-5">
				<TabButton on={tab === "chat"} onClick={() => setTab("chat")}>
					{t("libres.detail.conversation")}
				</TabButton>
				<TabButton on={tab === "diff"} onClick={() => setTab("diff")}>
					{t("libres.detail.changes")}
					{changes.data && changes.data.length > 0 ? ` · ${changes.data.length}` : ""}
				</TabButton>
			</div>

			<div className="flex min-h-0 flex-1 flex-col">
				{tab === "chat" ? (
					run ? (
						<AgentChat run={run} active />
					) : (
						<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
							<MessageSquare size={22} className="text-ink-faint" />
							<p className="max-w-sm text-[13px] text-ink-muted">
								{t("libres.detail.closed")}
							</p>
							<button
								type="button"
								onClick={() => void resume()}
								className="focus-ring flex h-9 items-center gap-2 rounded-[10px] bg-accent px-3.5 text-[13px] font-semibold text-accent-ink hover:bg-accent-soft"
							>
								<RotateCcw size={14} />
								{t("libres.detail.resume")}
							</button>
						</div>
					)
				) : (
					<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-5 py-4">
						{changes.initial && changes.loading ? <Spinner /> : null}
						{changes.data?.length === 0 ? (
							<p className="text-[13px] text-ink-muted">{t("libres.detail.noChanges")}</p>
						) : null}
						{changes.data?.map((change) => (
							<button
								key={change.path}
								type="button"
								onClick={() => void api.system.openFile(`${agent.cwd}/${change.path}`)}
								className="focus-ring flex items-center gap-2.5 rounded-[10px] bg-base px-3 py-2 text-left hover:bg-hover"
							>
								<span className="w-14 shrink-0 text-[11px] text-ink-muted">{change.state}</span>
								<span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{change.path}</span>
								<span className="font-mono text-[11.5px] text-success">+{change.added}</span>
								<span className="font-mono text-[11.5px] text-critical">−{change.removed}</span>
							</button>
						))}
					</div>
				)}
			</div>

			{archiving ? (
				<ArchiveDialog
					agent={agent}
					onClose={() => setArchiving(false)}
					onDone={() => {
						if (run) close(run.id);
						patchLibre(agent.id, { archivedAt: Date.now(), runId: null });
						selectLibre(null);
						setArchiving(false);
					}}
					onError={(error) => notify(error)}
				/>
			) : null}
		</main>
	);
}

function ArchiveDialog({
	agent,
	onClose,
	onDone,
	onError,
}: {
	agent: LibreAgent;
	onClose: () => void;
	onDone: () => void;
	onError: (message: string) => void;
}) {
	const { t } = useTranslation("views");
	const [choice, setChoice] = useState<"keep" | "leave" | "discard">("keep");
	const [busy, setBusy] = useState(false);
	const hasTree = Boolean(agent.worktree);

	const confirm = async () => {
		setBusy(true);
		try {
			if (hasTree && choice !== "leave") await api.libre.archive(agent.worktree, agent.branch, choice);
			onDone();
		} catch (error) {
			onError(String(error));
			setBusy(false);
		}
	};

	const options: Array<{ id: typeof choice; label: string; hint: string; danger?: boolean }> = [
		{ id: "keep", label: t("libres.archive.keep"), hint: t("libres.archive.keepHint") },
		{ id: "leave", label: t("libres.archive.leave"), hint: t("libres.archive.leaveHint") },
		{
			id: "discard",
			label: t("libres.archive.discard"),
			hint: t("libres.archive.discardHint"),
			danger: true,
		},
	];

	return (
		<Modal onClose={onClose} align="center">
			<div className="animate-in w-[480px] rounded-2xl bg-surface p-5 shadow-[var(--shadow-pop)]">
				<h3 className="text-[16px] font-semibold text-ink">{t("libres.archive.title", { label: agent.label })}</h3>
				{hasTree ? (
					<>
						<p className="mt-1.5 text-[13px] leading-snug text-ink-muted">
							<Trans
								t={t}
								i18nKey="libres.archive.worktreeQuestion"
								values={{ branch: agent.branch }}
								components={{ branch: <span className="font-mono text-ink" /> }}
							/>
						</p>
						<div className="mt-4 flex flex-col gap-2">
							{options.map((option) => (
								<button
									key={option.id}
									type="button"
									onClick={() => setChoice(option.id)}
									className={clsx(
										"focus-ring flex items-start gap-3 rounded-xl border-[1.5px] px-3.5 py-3 text-left",
										choice === option.id ? "border-accent bg-accent-dim" : "border-line-soft hover:border-line",
									)}
								>
									<span
										className={clsx(
											"mt-0.5 h-4 w-4 shrink-0 rounded-full",
											choice === option.id ? "border-[5px] border-accent bg-surface" : "border-[1.5px] border-line",
										)}
									/>
									<span>
										<span className={clsx("block text-[13px] font-semibold", option.danger ? "text-critical" : "text-ink")}>
											{option.label}
										</span>
										<span className="mt-0.5 block text-[12px] text-ink-muted">{option.hint}</span>
									</span>
								</button>
							))}
						</div>
					</>
				) : (
					<p className="mt-1.5 text-[13px] leading-snug text-ink-muted">
						{t("libres.archive.inPlace")}
					</p>
				)}
				<div className="mt-5 flex justify-end gap-2">
					<button
						type="button"
						onClick={onClose}
						className="focus-ring h-9 rounded-[9px] border border-line px-3.5 text-[12.5px] font-medium text-ink hover:bg-hover"
					>
						{t("libres.archive.cancel")}
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => void confirm()}
						className={clsx(
							"focus-ring flex h-9 items-center gap-2 rounded-[9px] px-3.5 text-[12.5px] font-semibold disabled:opacity-50",
							choice === "discard" && hasTree ? "bg-critical text-accent-ink" : "bg-accent text-accent-ink hover:bg-accent-soft",
						)}
					>
						{busy ? <Spinner size={12} /> : null}
						{t("libres.archive.confirm")}
					</button>
				</div>
			</div>
		</Modal>
	);
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-line-soft text-ink-muted hover:border-line hover:text-ink"
		>
			{children}
		</button>
	);
}

function TextAction({ onClick, icon, children }: { onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="focus-ring flex h-8 items-center gap-1.5 rounded-lg border border-line-soft px-2.5 text-[12px] font-medium text-ink hover:border-line"
		>
			{icon}
			{children}
		</button>
	);
}

function TabButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={on}
			onClick={onClick}
			className={clsx(
				"focus-ring -mb-px h-9 border-b-2 px-3 text-[12.5px] font-medium",
				on ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
			)}
		>
			{children}
		</button>
	);
}

/** Premier passage : ce que l'écran remplace, et de quoi commencer tout de suite. */
function LibresEmpty() {
	const { t } = useTranslation("views");
	const { projectList } = useCockpit();
	return (
		<div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
			<div className="flex w-[640px] max-w-full flex-col items-center text-center">
				<div className="w-[440px] max-w-full rounded-[14px] bg-void px-5 py-4 text-left font-mono text-[13px] leading-[1.8] text-ink shadow-card">
					<div>
						<span className="text-accent">~ ❯</span> cd ~/Sites/{t("libres.empty.projectFolder")}
					</div>
					<div>
						<span className="text-accent">~/Sites/{t("libres.empty.projectFolder")} ❯</span> claude
					</div>
					<div className="text-ink-muted">{t("libres.empty.becomes")}</div>
					<div>
						<Trans
							t={t}
							i18nKey="libres.empty.shortcut"
							components={{ key: <span className="font-semibold text-warning" /> }}
						/>
					</div>
				</div>
				<h1 className="mt-8 text-[24px] font-semibold text-ink">{t("libres.empty.title")}</h1>
				<p className="mt-2.5 max-w-[520px] text-[14px] leading-relaxed text-ink-muted">
					{t("libres.empty.body")}
				</p>
				<button
					type="button"
					onClick={() => openLauncher()}
					className="focus-ring mt-6 flex h-10 items-center gap-2 rounded-[10px] bg-accent px-4 text-[13.5px] font-semibold text-accent-ink hover:bg-accent-soft"
				>
					<Zap size={15} />
					{t("libres.empty.launch")}
					<span className="font-mono text-[11px] opacity-80">{formatShortcut("⌘N")}</span>
				</button>
				{projectList.some((project) => project.mainRepo) ? (
					<div className="mt-8 w-full text-left">
						<h2 className="mb-2 text-[10.5px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
							{t("libres.empty.orProject")}
						</h2>
						<div className="grid grid-cols-3 gap-2.5">
							{projectList
								.filter((project) => project.mainRepo)
								.slice(0, 6)
								.map((project) => (
									<button
										key={project.id}
										type="button"
										onClick={() => openLauncher(project.mainRepo)}
										className="focus-ring flex flex-col gap-1 rounded-xl bg-surface p-3.5 text-left shadow-card hover:shadow-[var(--shadow-pop)]"
									>
										<span className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
											<span
												className="h-2 w-2 rounded-full"
												style={{ background: project.color || "var(--color-accent)" }}
											/>
											{project.name}
										</span>
										<span className="truncate font-mono text-[11.5px] text-ink-muted">{show(project.mainRepo)}</span>
									</button>
								))}
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
