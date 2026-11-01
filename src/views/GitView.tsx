import clsx from "clsx";
import {
	Archive,
	ArrowDownToLine,
	ArrowUpFromLine,
	ChevronDown,
	ChevronRight,
	FolderOpen,
	GitBranch,
	GitCommitHorizontal,
	GitMerge,
	GitPullRequest,
	Network,
	Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffView } from "@/components/LogView";
import {
	Badge,
	Button,
	Empty,
	ErrorNote,
	Freshness,
	Row,
	SearchField,
	Spinner,
	ViewHeader,
} from "@/components/ui";
import { useConfirm } from "@/components/Confirm";
import { api, events } from "@/lib/ipc";
import type { Branch, FileChange } from "@/lib/types";
import { usePersistentState, useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

/** Lettre et couleur d'un statut de fichier, à la manière d'un client git. */
const STATE_MARK: Record<string, { letter: string; className: string }> = {
	added: { letter: "A", className: "bg-success/15 text-success" },
	modified: { letter: "M", className: "bg-warning/15 text-warning" },
	deleted: { letter: "D", className: "bg-critical/15 text-critical" },
	renamed: { letter: "R", className: "bg-info/15 text-info" },
	copied: { letter: "C", className: "bg-info/15 text-info" },
};

/** Le statut connu (clé de `STATE_MARK`), ramené à « modifié » s'il est inconnu. */
function stateKey(state: string) {
	return STATE_MARK[state] ? state : "modified";
}

function stateMark(state: string) {
	return STATE_MARK[stateKey(state)];
}

// ────────────────────────────── Arbre de fichiers ──────────────────────────────

interface Dir {
	name: string;
	path: string;
	dirs: Map<string, Dir>;
	files: FileChange[];
}

function emptyDir(name: string, path: string): Dir {
	return { name, path, dirs: new Map(), files: [] };
}

/** Chemins plats de git → arborescence de dossiers. */
function buildTree(files: FileChange[]): Dir {
	const root = emptyDir("", "");
	for (const file of files) {
		const parts = file.path.split("/");
		parts.pop();
		let node = root;
		let prefix = "";
		for (const part of parts) {
			prefix = prefix ? `${prefix}/${part}` : part;
			let child = node.dirs.get(part);
			if (!child) {
				child = emptyDir(part, prefix);
				node.dirs.set(part, child);
			}
			node = child;
		}
		node.files.push(file);
	}
	return root;
}

interface Stats {
	count: number;
	added: number;
	removed: number;
}

function statsOf(dir: Dir): Stats {
	const total = dir.files.reduce<Stats>(
		(acc, file) => ({
			count: acc.count + 1,
			added: acc.added + file.added,
			removed: acc.removed + file.removed,
		}),
		{ count: 0, added: 0, removed: 0 },
	);
	for (const child of dir.dirs.values()) {
		const sub = statsOf(child);
		total.count += sub.count;
		total.added += sub.added;
		total.removed += sub.removed;
	}
	return total;
}

/**
 * Replie les dossiers qui ne contiennent qu'un sous-dossier : `src` → `lib` →
 * `git` devient `src/lib/git`. Trois niveaux de chevrons pour un seul chemin
 * réel n'apprennent rien et éloignent les fichiers du regard.
 */
function collapse(dir: Dir): { label: string; node: Dir } {
	let node = dir;
	let label = dir.name;
	while (node.files.length === 0 && node.dirs.size === 1) {
		const [only] = node.dirs.values();
		label = label ? `${label}/${only.name}` : only.name;
		node = only;
	}
	return { label, node };
}

function Numbers({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="shrink-0 font-mono text-[10px] tabular-nums">
			{added > 0 ? <span className="text-success">+{added}</span> : null}
			{added > 0 && removed > 0 ? " " : null}
			{removed > 0 ? <span className="text-critical">−{removed}</span> : null}
		</span>
	);
}

function FileTree({
	dir,
	depth,
	closed,
	toggle,
	selected,
	onSelect,
}: {
	dir: Dir;
	depth: number;
	closed: Set<string>;
	toggle: (path: string) => void;
	selected: string | null;
	onSelect: (path: string) => void;
}) {
	const { t } = useTranslation("views");
	const folders = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
	const files = [...dir.files].sort((a, b) => a.path.localeCompare(b.path));

	return (
		<>
			{folders.map((child) => {
				const { label, node } = collapse(child);
				const isClosed = closed.has(node.path);
				const stats = statsOf(node);
				return (
					<div key={node.path}>
						<button
							type="button"
							onClick={() => toggle(node.path)}
							className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left hover:bg-surface"
							style={{ paddingLeft: depth * 12 + 6 }}
						>
							{isClosed ? (
								<ChevronRight size={11} className="shrink-0 text-ink-faint" />
							) : (
								<ChevronDown size={11} className="shrink-0 text-ink-faint" />
							)}
							<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
								{label}
							</span>
							<span className="shrink-0 font-mono text-[10px] text-ink-faint/70">
								{stats.count}
							</span>
							<Numbers added={stats.added} removed={stats.removed} />
						</button>
						{isClosed ? null : (
							<FileTree
								dir={node}
								depth={depth + 1}
								closed={closed}
								toggle={toggle}
								selected={selected}
								onSelect={onSelect}
							/>
						)}
					</div>
				);
			})}

			{files.map((file) => {
				const mark = stateMark(file.state);
				const name = file.path.split("/").pop() ?? file.path;
				return (
					<button
						key={file.path}
						type="button"
						onClick={() => onSelect(file.path)}
						title={`${file.path} — ${t(`git.state.${stateKey(file.state)}`)}`}
						className={clsx(
							"flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left transition-colors",
							selected === file.path ? "bg-raised" : "hover:bg-surface",
						)}
						style={{ paddingLeft: depth * 12 + 6 }}
					>
						<span
							className={clsx(
								"flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold",
								mark.className,
							)}
						>
							{mark.letter}
						</span>
						<span
							className={clsx(
								"min-w-0 flex-1 truncate font-mono text-[11px]",
								file.state === "deleted" ? "text-ink-faint line-through" : "text-ink-muted",
							)}
						>
							{name}
						</span>
						<Numbers added={file.added} removed={file.removed} />
					</button>
				);
			})}
		</>
	);
}

// ─────────────────────────────── Liste des branches ───────────────────────────────

function BranchRow({
	branch,
	base,
	selected,
	onSelect,
}: {
	branch: Branch;
	base: string;
	selected: boolean;
	onSelect: () => void;
}) {
	const { t } = useTranslation("views");
	return (
		<Row selected={selected} onClick={onSelect}>
			<div className="flex items-center gap-2">
				<GitBranch
					size={12}
					className={clsx(
						"shrink-0",
						branch.isDefault ? "text-accent-soft" : "text-ink-faint",
					)}
				/>
				<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
					{branch.name}
				</span>
				{branch.isCurrent ? <Badge tone="accent">HEAD</Badge> : null}
			</div>
			<div className="mt-1 flex items-center gap-2 pl-[18px] text-[10px] text-ink-faint">
				<span className="min-w-0 flex-1 truncate">{branch.lastCommit?.subject ?? "—"}</span>
				<span className="shrink-0 tabular-nums">{branch.lastCommit?.relative}</span>
			</div>
			<div className="mt-1 flex items-center gap-2 pl-[18px] font-mono text-[10px]">
				{branch.name === base ? (
					<span className="text-accent-soft">{t("git.branch.base")}</span>
				) : branch.commitsAhead > 0 ? (
					<span className="text-info">
						{t("git.branch.commitsAhead", { count: branch.commitsAhead, base })}
					</span>
				) : (
					<span className="text-ink-faint/70">{t("git.branch.upToDate", { base })}</span>
				)}
				{branch.ahead > 0 ? <span className="text-warning">↑{branch.ahead}</span> : null}
				{branch.behind > 0 ? (
					<span className="text-ink-faint">↓{branch.behind}</span>
				) : null}
				{branch.worktreePath ? (
					<span className="ml-auto text-ink-faint/70">{t("git.branch.worktree")}</span>
				) : null}
			</div>
		</Row>
	);
}

// ────────────────────────────────── L'écran ──────────────────────────────────

type Panel = "files" | "commits" | "graph";

/**
 * Actions d'écriture sur la branche affichée.
 *
 * Elles n'ont de sens que si la branche est sortie quelque part : git écrit
 * dans un dossier, pas dans une référence. D'où le rattachement au worktree,
 * et l'absence totale de ces boutons pour une branche qui n'en a pas.
 *
 * Exporté parce que le worktree se regarde depuis deux écrans : ici, où l'on
 * compare des branches, et dans Worktrees, où l'on travaille dedans. Ces gestes
 * n'existaient que du premier côté — on venait donc dans Git pour commiter ce
 * qu'on venait de faire ailleurs.
 */
export function BranchActions({
	path,
	branch,
	ahead,
	behind,
	onDone,
}: {
	path: string;
	branch: string;
	ahead: number;
	behind: number;
	onDone: () => void;
}) {
	const { t } = useTranslation("views");
	const { notify } = useCockpit();
	const { confirm, promptText } = useConfirm();
	const [busy, setBusy] = useState<string | null>(null);

	const run = async (label: string, action: () => Promise<string>) => {
		setBusy(label);
		try {
			const output = await action();
			// git dit peu de choses quand tout va bien : mieux vaut sa dernière
			// ligne qu'un « terminé » qui n'apprend rien.
			const last = output.trim().split("\n").filter(Boolean).pop();
			notify(last ? `${label} — ${last}` : t("git.actions.done", { label }));
			onDone();
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(null);
		}
	};

	const createPr = async () => {
		const title = await promptText({
			title: t("git.actions.pr.title", { branch }),
			message: t("git.actions.pr.message"),
			placeholder: t("git.actions.pr.placeholder"),
			confirmLabel: t("git.actions.pr.confirm"),
		});
		if (!title) return;
		setBusy("PR");
		try {
			const url = await api.git.createPr(path, title);
			notify(t("git.actions.pr.opened", { branch }));
			if (url) void api.system.openUrl(url).catch(() => undefined);
			onDone();
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(null);
		}
	};

	const stash = async () => {
		const message = await promptText({
			title: t("git.actions.stash.title", { branch }),
			message: t("git.actions.stash.message"),
			placeholder: t("git.actions.stash.placeholder"),
			confirmLabel: t("git.actions.stash.confirm"),
		});
		if (message === null) return;
		await run("Stash", () => api.git.stash(path, message));
	};

	const commit = async () => {
		const message = await promptText({
			title: t("git.actions.commit.title", { branch }),
			message: t("git.actions.commit.message"),
			placeholder: t("git.actions.commit.placeholder"),
			confirmLabel: t("git.actions.commit.confirm"),
		});
		if (!message) return;
		await run("Commit", () => api.git.commit(path, message));
	};

	const push = async () => {
		const ok = await confirm({
			title: t("git.actions.push.title", { branch }),
			message:
				ahead > 0
					? t("git.actions.push.messageAhead", { count: ahead })
					: t("git.actions.push.messageNew"),
			confirmLabel: t("git.actions.push.confirm"),
		});
		if (!ok) return;
		await run("Push", () => api.git.push(path));
	};

	return (
		<>
			<Button
				icon={ArrowDownToLine}
				disabled={busy !== null}
				onClick={() => void run("Pull", () => api.git.pull(path))}
				title={
					behind > 0
						? t("git.actions.pull.hintBehind", { count: behind })
						: t("git.actions.pull.hintUpToDate")
				}
			>
				Pull{behind > 0 ? ` ${behind}` : ""}
			</Button>
			<Button
				icon={GitCommitHorizontal}
				disabled={busy !== null}
				onClick={() => void commit()}
				title={t("git.actions.commit.hint")}
			>
				Commit
			</Button>
			<Button
				icon={ArrowUpFromLine}
				disabled={busy !== null}
				onClick={() => void push()}
				title={t("git.actions.push.hint")}
			>
				Push{ahead > 0 ? ` ${ahead}` : ""}
			</Button>
			<Button
				icon={GitPullRequest}
				disabled={busy !== null}
				onClick={() => void createPr()}
				title={t("git.actions.pr.hint")}
			>
				PR
			</Button>
			<Button
				icon={Archive}
				disabled={busy !== null}
				onClick={() => void stash()}
				title={t("git.actions.stash.hint")}
			>
				Stash
			</Button>
		</>
	);
}

export function GitView() {
	const { t } = useTranslation("views");
	const { notify, go } = useCockpit();
	const [query, setQuery] = useState("");
	const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [closed, setClosed] = useState<Set<string>>(new Set());
	const [panel, setPanel] = useState<Panel>("files");
	const [sort, setSort] = usePersistentState<"activity" | "name" | "commits">(
		"git.sort",
		"activity",
	);
	const [scope, setScope] = usePersistentState<"all" | "worktree" | "ahead" | "unpushed">(
		"git.scope",
		"all",
	);

	// La base est mémorisée : le dépôt n'a qu'une branche d'intégration, et on
	// ne veut pas la re-choisir à chaque ouverture de l'écran.
	const [baseOverride, setBaseOverride] = usePersistentState<string | null>(
		"git.base",
		null,
	);

	const overview = useAsync(
		() => api.git.branches(baseOverride ?? undefined),
		[baseOverride],
		{
			subscribe: events.onGitChanged,
		},
	);
	const base = overview.data?.base ?? "main";
	const branches = useMemo(() => overview.data?.branches ?? [], [overview.data]);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		let list = needle
			? branches.filter((branch) => branch.name.toLowerCase().includes(needle))
			: branches;

		if (scope === "worktree") list = list.filter((branch) => branch.worktreePath);
		// « Non fusionnées » : ce qui apporte encore quelque chose à la base.
		if (scope === "ahead") list = list.filter((branch) => branch.commitsAhead > 0);
		if (scope === "unpushed")
			list = list.filter((branch) => branch.ahead > 0 || !branch.upstream);

		const sorted = [...list];
		sorted.sort((a, b) => {
			switch (sort) {
				case "name":
					return a.name.localeCompare(b.name);
				case "commits":
					return b.commitsAhead - a.commitsAhead;
				default:
					return (b.lastCommit?.timestamp ?? 0) - (a.lastCommit?.timestamp ?? 0);
			}
		});
		return sorted;
	}, [branches, query, sort, scope]);

	const current = useMemo(
		() =>
			filtered.find((branch) => branch.name === selectedBranch) ??
			filtered.find((branch) => branch.isCurrent) ??
			filtered[0] ??
			null,
		[filtered, selectedBranch],
	);

	const diff = useAsync(
		() =>
			current
				? api.git.branchDiff(current.name, base)
				: Promise.reject(new Error(t("git.noBranchSelected"))),
		[current?.name, base],
		{ enabled: Boolean(current), subscribe: events.onGitChanged },
	);

	const fileDiff = useAsync(
		() =>
			current && selectedFile
				? api.git.branchFileDiff(current.name, base, selectedFile)
				: Promise.resolve(""),
		[current?.name, base, selectedFile],
		{ enabled: Boolean(current && selectedFile) },
	);

	const graph = useAsync(
		() => (current ? api.git.graph([current.name, base], 60) : Promise.resolve("")),
		[current?.name, base],
		{ enabled: Boolean(current) && panel === "graph" },
	);

	// Changer de branche remet le volet de droite à zéro : le fichier affiché
	// n'a aucune raison d'exister dans la branche suivante.
	useEffect(() => setSelectedFile(null), [current?.name]);

	const tree = useMemo(() => buildTree(diff.data?.files ?? []), [diff.data]);

	const toggle = (path: string) =>
		setClosed((previous) => {
			const next = new Set(previous);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});

	const fileCount = diff.data?.files.length ?? 0;

	return (
		<>
			<ViewHeader
				title="Git"
				subtitle={
					overview.data
						? t("git.subtitle", { count: branches.length, base })
						: t("git.reading")
				}
				actions={
					<>
						<label className="flex items-center gap-1.5 text-[10px] text-ink-faint">
							{t("git.compareTo")}
							<select
								value={base}
								onChange={(event) => setBaseOverride(event.target.value)}
								className="focus-ring max-w-44 rounded-lg border border-line-soft bg-surface px-2 py-1 font-mono text-[11px] text-ink-muted"
							>
								{/* La base courante figure toujours dans la liste, même si
								    elle a été choisie automatiquement. */}
								{(branches.some((branch) => branch.name === base)
									? branches
									: [{ name: base } as Branch, ...branches]
								).map((branch) => (
									<option key={branch.name} value={branch.name}>
										{branch.name}
									</option>
								))}
							</select>
						</label>
						{overview.loading || diff.loading ? <Spinner /> : null}
						<Freshness
							at={overview.updatedAt}
							loading={overview.loading}
							onReload={overview.reload}
						/>
					</>
				}
			/>

			{overview.error ? (
				<ErrorNote error={overview.error} onRetry={overview.reload} />
			) : null}

			<div className="flex min-h-0 flex-1">
				<div className="hairline-r flex w-72 shrink-0 flex-col bg-base">
					<div className="flex flex-col gap-1.5 p-2.5">
						<SearchField
							value={query}
							onChange={setQuery}
							placeholder={t("git.filterPlaceholder")}
						/>
						<div className="flex items-center gap-1.5">
							<select
								value={scope}
								onChange={(event) => setScope(event.target.value as typeof scope)}
								className="focus-ring min-w-0 flex-1 rounded-lg border border-line-soft bg-surface px-1.5 py-1 text-[10px] text-ink-muted"
							>
								<option value="all">{t("git.scope.all")}</option>
								<option value="worktree">{t("git.scope.worktree")}</option>
								<option value="ahead">{t("git.scope.ahead")}</option>
								<option value="unpushed">{t("git.scope.unpushed")}</option>
							</select>
							<select
								value={sort}
								onChange={(event) => setSort(event.target.value as typeof sort)}
								className="focus-ring min-w-0 flex-1 rounded-lg border border-line-soft bg-surface px-1.5 py-1 text-[10px] text-ink-muted"
							>
								<option value="activity">{t("git.sort.activity")}</option>
								<option value="commits">{t("git.sort.commits")}</option>
								<option value="name">{t("git.sort.name")}</option>
							</select>
							<span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
								{filtered.length}
							</span>
						</div>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
						{filtered.map((branch) => (
							<BranchRow
								key={branch.name}
								branch={branch}
								base={base}
								selected={current?.name === branch.name}
								onSelect={() => setSelectedBranch(branch.name)}
							/>
						))}
						{filtered.length === 0 && !overview.loading ? (
							<Empty icon={GitBranch} message={t("git.noBranch")} />
						) : null}
					</div>
				</div>

				{current ? (
					<div className="flex min-w-0 flex-1 flex-col bg-base">
						<div className="hairline-b flex flex-wrap items-center gap-1.5 px-4 py-2.5">
							<div className="mr-auto min-w-0">
								<div className="truncate text-[13px] font-semibold text-ink">
									{current.name}
								</div>
								<div className="truncate font-mono text-[10px] text-ink-faint">
									{t("git.fileCount", { count: fileCount })} ·{" "}
									<span className="text-success">+{diff.data?.additions ?? 0}</span>{" "}
									<span className="text-critical">−{diff.data?.deletions ?? 0}</span> ·{" "}
									{t("git.since", { sha: diff.data?.mergeBase.slice(0, 8) ?? "…", base })}
								</div>
							</div>
							{current.worktreePath ? (
								<>
									<BranchActions
										path={current.worktreePath}
										branch={current.name}
										ahead={current.ahead}
										behind={current.behind}
										onDone={() => {
											overview.reload();
											diff.reload();
										}}
									/>
									<Button
										icon={FolderOpen}
										onClick={() => {
											void api.system
												.openEditor(current.worktreePath as string)
												.catch((error) => notify(String(error)));
										}}
									>
										{t("git.editor")}
									</Button>
									<Button
										icon={Terminal}
										onClick={() => {
											void api.system
												.openTerminal(current.worktreePath as string)
												.catch((error) => notify(String(error)));
										}}
									>
										{t("git.terminal")}
									</Button>
									<Button
										icon={GitBranch}
										onClick={() =>
											go("worktrees", { worktreePath: current.worktreePath ?? undefined })
										}
										title={t("git.openWorktree")}
									>
										{t("git.worktree")}
									</Button>
								</>
							) : null}
						</div>

						<div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-line-soft overflow-hidden">
							<div className="flex min-h-0 flex-col">
								<div className="hairline-b flex shrink-0 items-center gap-1 px-2.5 py-1.5">
									{(
										[
											["files", t("git.panel.files"), fileCount],
											["commits", t("git.panel.commits"), diff.data?.commits.length ?? 0],
											["graph", t("git.panel.graph"), null],
										] as Array<[Panel, string, number | null]>
									).map(([id, label, count]) => (
										<button
											key={id}
											type="button"
											onClick={() => setPanel(id)}
											className={clsx(
												"flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] transition-colors",
												panel === id
													? "bg-raised text-ink"
													: "text-ink-faint hover:bg-surface hover:text-ink-muted",
											)}
										>
											{label}
											{count !== null ? (
												<span className="font-mono text-[10px] text-ink-faint/70">
													{count}
												</span>
											) : null}
										</button>
									))}
								</div>

								<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
									{diff.error ? (
										<ErrorNote error={diff.error} onRetry={diff.reload} />
									) : null}

									{panel === "files" ? (
										fileCount === 0 && !diff.loading ? (
											<Empty
												icon={GitMerge}
												message={t("git.noDifference", { branch: current.name, base })}
												hint={t("git.noDifferenceHint")}
											/>
										) : (
											<FileTree
												dir={tree}
												depth={0}
												closed={closed}
												toggle={toggle}
												selected={selectedFile}
												onSelect={setSelectedFile}
											/>
										)
									) : null}

									{panel === "commits" ? (
										<div className="flex flex-col gap-1 p-1">
											{(diff.data?.commits ?? []).map((commit) => (
												<div key={commit.sha} className="flex items-start gap-2 px-1 py-1">
													<GitCommitHorizontal
														size={11}
														className="mt-1 shrink-0 text-ink-faint"
													/>
													<div className="min-w-0 flex-1">
														<p className="truncate text-[11px] text-ink-muted">
															{commit.subject}
														</p>
														<p className="font-mono text-[10px] text-ink-faint">
															{commit.sha} · {commit.author} · {commit.relative}
														</p>
													</div>
												</div>
											))}
											{(diff.data?.commits ?? []).length === 0 && !diff.loading ? (
												<Empty icon={GitCommitHorizontal} message={t("git.noOwnCommit")} />
											) : null}
										</div>
									) : null}

									{panel === "graph" ? (
										graph.loading ? (
											<div className="flex justify-center py-8">
												<Spinner />
											</div>
										) : graph.error ? (
											<ErrorNote error={graph.error} onRetry={graph.reload} />
										) : (
											<pre className="text-selectable overflow-x-auto p-2 font-mono text-[10px] leading-relaxed whitespace-pre text-ink-muted">
												{/* Le backend sépare les champs par 0x1f, qui n'apparaît
												    jamais dans un message de commit. */}
												{(graph.data ?? "").replaceAll("", "  ")}
											</pre>
										)
									) : null}
								</div>
							</div>

							<div className="flex min-h-0 flex-col">
								{selectedFile ? (
									<>
										<div className="hairline-b flex items-center gap-2 px-3 py-2">
											<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
												{selectedFile}
											</span>
											<Button size="sm" onClick={() => setSelectedFile(null)}>
												{t("git.close")}
											</Button>
										</div>
										<div className="min-h-0 flex-1 overflow-auto">
											{fileDiff.loading ? (
												<div className="flex justify-center py-8">
													<Spinner />
												</div>
											) : fileDiff.error ? (
												<ErrorNote error={fileDiff.error} />
											) : (
												<DiffView diff={fileDiff.data ?? ""} />
											)}
										</div>
									</>
								) : (
									<Empty
										icon={Network}
										message={t("git.pickFile")}
										hint={t("git.pickFileHint", { base })}
									/>
								)}
							</div>
						</div>
					</div>
				) : (
					<Empty icon={GitBranch} message={t("git.nothingToShow")} />
				)}
			</div>
		</>
	);
}
