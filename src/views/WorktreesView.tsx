import clsx from "clsx";
import {
	Bot,
	FileDiff,
	FolderOpen,
	GitBranch,
	GitCommitHorizontal,
	Play,
	RefreshCw,
	Terminal,
	Eraser,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffView } from "@/components/LogView";
import {
	Badge,
	Button,
	Dot,
	Empty,
	ErrorNote,
	Freshness,
	Row,
	SearchField,
	Section,
	Spinner,
	ViewHeader,
} from "@/components/ui";
import { bytes, fromSeconds, fromTimestamp, shortPath } from "@/lib/format";
import { api, events } from "@/lib/ipc";
import type { DiskUsage, Worktree } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { BranchActions } from "@/views/GitView";
import { FleetGrid } from "@/components/FleetGrid";
import { useConfirm } from "@/components/Confirm";
import { JobProgress, useJobRunning } from "@/components/JobProgress";
import { QaGallery } from "@/components/QaGallery";
import { useAgentActions } from "@/app/agents";
import { createWorktreeTracked } from "@/lib/worktreeFlow";
import { useCockpit, useSessionsForPath } from "@/app/store";
import { useTerminals } from "@/app/terminals";
import { useWorkspace } from "@/app/workspace";

function dirtyCount(tree: Worktree) {
	return tree.status.modified + tree.status.staged + tree.status.untracked;
}

function WorktreeRow({
	tree,
	selected,
	liveAgents,
	usage,
	onSelect,
}: {
	tree: Worktree;
	selected: boolean;
	liveAgents: number;
	usage?: DiskUsage;
	onSelect: () => void;
}) {
	const { t } = useTranslation("views");
	const dirty = dirtyCount(tree);
	return (
		<Row selected={selected} onClick={onSelect}>
			<div className="flex items-center gap-2">
				<GitBranch
					size={12}
					className={tree.isMain ? "shrink-0 text-accent-soft" : "shrink-0 text-ink-faint"}
				/>
				<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
					{tree.branch ?? tree.folderName}
				</span>
				{liveAgents > 0 ? (
					<span className="flex shrink-0 items-center gap-1 text-[10px] text-success">
						<Dot tone="success" pulse />
						{liveAgents}
					</span>
				) : null}
			</div>
			<div className="mt-1 flex items-center gap-2 pl-[18px] text-[10px] text-ink-faint">
				<span className="truncate font-mono">{tree.folderName}</span>
				<span className="ml-auto shrink-0 tabular-nums">
					{fromTimestamp(tree.lastActivity)}
				</span>
			</div>
			<div className="mt-1 flex items-center gap-2 pl-[18px] font-mono text-[10px]">
				{dirty > 0 ? (
					<span className="text-warning">{t("worktrees.row.dirty", { count: dirty })}</span>
				) : (
					<span className="text-ink-faint/70">{t("worktrees.row.clean")}</span>
				)}
				{tree.status.conflicted > 0 ? (
					<span className="text-critical">{t("worktrees.row.conflicts", { count: tree.status.conflicted })}</span>
				) : null}
				{tree.status.ahead > 0 ? (
					<span className="text-info">↑{tree.status.ahead}</span>
				) : null}
				{usage && usage.builds > 0 ? (
					// Le poids qui coûte, pas le poids affiché par le système : les
					// dépendances sont clonées depuis le store et ne prennent presque
					// rien. Montrer le total ferait supprimer des dossiers pour rien.
					<span
						className="text-warning"
						title={t("worktrees.row.usageHint", {
							total: bytes(usage.bytes),
							builds: bytes(usage.builds),
							dependencies: bytes(usage.dependencies),
						})}
					>
						{t("worktrees.row.builds", { size: bytes(usage.builds) })}
					</span>
				) : null}
				{tree.status.behind > 0 ? (
					<span className="text-ink-faint">↓{tree.status.behind}</span>
				) : null}
				{tree.isMain ? <Badge tone="accent">{t("worktrees.row.main")}</Badge> : null}
			</div>
		</Row>
	);
}

function WorktreeDetail({ tree }: { tree: Worktree }) {
	const { t } = useTranslation("views");
	const { notify, go, hasConnector, config } = useCockpit();
	// Sans commande déclarée, le geste disparaît : lancer un `pnpm dev` qui
	// n'existe peut-être pas ici ouvrirait un terminal sur une erreur.
	const devCommand = config?.workflow?.devCommand?.trim() ?? "";
	const { open: openAgent } = useAgentActions();
	const { open: openTerminal, tabs: terminals } = useTerminals();
	const { show: showTab } = useWorkspace();
	const sessions = useSessionsForPath(tree.path);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);

	// Les fichiers de travail bougent sans passer par `.git` : polling court ici,
	// là où l'historique se contente de l'événement du watcher.
	const changes = useAsync(() => api.worktrees.changes(tree.path), [tree.path], {
		pollMs: 10_000,
		subscribe: events.onGitChanged,
	});
	const commits = useAsync(() => api.worktrees.commits(tree.path, 10), [tree.path], {
		subscribe: events.onGitChanged,
	});
	const diff = useAsync(
		() =>
			selectedFile ? api.worktrees.fileDiff(tree.path, selectedFile) : Promise.resolve(""),
		[tree.path, selectedFile],
		{ enabled: Boolean(selectedFile) },
	);

	useEffect(() => setSelectedFile(null), [tree.path]);

	const guard = (promise: Promise<unknown>) => {
		void promise.catch((error) => notify(String(error)));
	};

	return (
		<div className="flex min-w-0 flex-1 flex-col bg-base">
			<div className="hairline-b flex flex-wrap items-center gap-1.5 px-4 py-2.5">
				<div className="mr-auto min-w-0">
					<div className="truncate text-[13px] font-semibold text-ink">
						{tree.branch ?? tree.folderName}
					</div>
					<div className="truncate font-mono text-[10px] text-ink-faint">{tree.path}</div>
				</div>
				<Button icon={FolderOpen} onClick={() => guard(api.system.openEditor(tree.path))}>
					{t("worktrees.detail.editor")}
				</Button>
				<Button
					icon={Terminal}
					onClick={() => openTerminal(tree.path)}
					title={t("worktrees.detail.terminalHint")}
				>
					{t("worktrees.detail.terminal")}
				</Button>
				{/* Sans le CLI, ce bouton ne peut que rendre une erreur : il attend
				    qu'il soit installé plutôt que de le laisser découvrir au clic. */}
				{hasConnector("agents") ? (
					<Button
						icon={Bot}
						onClick={() => openAgent(tree.path)}
						title={t("worktrees.detail.agentHint")}
					>
						{t("worktrees.detail.agent")}
					</Button>
				) : null}
				{/* Les gestes git là où l'on travaille, et pas seulement dans l'écran
				    qui compare des branches : commiter ce qu'on vient de faire ne
				    devrait pas demander de changer d'écran. Mêmes boutons, même
				    composant — ils ne peuvent donc plus diverger. */}
				<BranchActions
					path={tree.path}
					branch={tree.branch ?? tree.folderName}
					ahead={tree.status.ahead}
					behind={tree.status.behind}
					onDone={() => {
						changes.reload();
						commits.reload();
					}}
				/>
				{devCommand ? (
					<Button
						variant="solid"
						icon={Play}
						onClick={() => {
							// Un serveur de dev déjà debout tient le port : on revient
							// dessus plutôt que d'en lancer un second qui échouerait.
							const live = terminals.find(
								(entry) => entry.cwd === tree.path && entry.label === "dev" && entry.running,
							);
							if (live) showTab(tree.path, { kind: "terminal", id: live.id });
							else openTerminal(tree.path, { command: devCommand, label: "dev" });
						}}
						title={t("worktrees.detail.devHint", { command: devCommand })}
					>
						{t("worktrees.detail.dev")}
					</Button>
				) : null}
			</div>

			<div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-line-soft overflow-hidden">
				<div className="flex min-h-0 flex-col overflow-y-auto p-3">
					<Section
						title={t("worktrees.detail.changes")}
						count={changes.data?.length}
						actions={
							// Le spinner s'ajoute au bouton au lieu de le remplacer :
							// l'échanger décalait toute la barre à chaque rechargement,
							// et il y en a un toutes les quelques secondes.
							<>
								<span className="flex w-4 justify-center">
									{changes.loading ? <Spinner /> : null}
								</span>
								<Button size="sm" icon={RefreshCw} onClick={changes.reload} />
							</>
						}
					>
						{changes.error ? <ErrorNote error={changes.error} /> : null}
						{/* `initial` et non `loading` : sur un arbre propre, se fier au
						    chargement en cours faisait clignoter le message à chaque
						    rafraîchissement. */}
						{(changes.data ?? []).length === 0 && !changes.initial ? (
							<p className="px-1 py-3 text-[11px] text-ink-faint">
								{t("worktrees.detail.cleanTree")}
							</p>
						) : (
							<div className="flex flex-col gap-0.5">
								{changes.data?.map((change) => (
									<button
										key={change.path}
										type="button"
										onClick={() => setSelectedFile(change.path)}
										className={clsx(
											"flex items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors",
											selectedFile === change.path ? "bg-raised" : "hover:bg-surface",
										)}
									>
										<FileDiff size={11} className="shrink-0 text-ink-faint" />
										<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
											{change.path}
										</span>
										{change.state === "untracked" ? (
											<Badge>{t("worktrees.detail.new")}</Badge>
										) : (
											<span className="shrink-0 font-mono text-[10px]">
												<span className="text-success">+{change.added}</span>{" "}
												<span className="text-critical">−{change.removed}</span>
											</span>
										)}
									</button>
								))}
							</div>
						)}
					</Section>

					<Section title={t("worktrees.detail.recentCommits")} className="mt-4">
						<div className="flex flex-col gap-1">
							{commits.data?.map((commit) => (
								<div key={commit.sha} className="flex items-start gap-2 px-1 py-1">
									<GitCommitHorizontal size={11} className="mt-1 shrink-0 text-ink-faint" />
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
						</div>
					</Section>

					{/* Les livrables de QA vivent dans le worktree : c'est ici qu'on les
					    consulte, plutôt que dans le Finder. */}
					<Section title={t("worktrees.detail.selfQa")} className="mt-4">
						<QaGallery path={tree.path} />
					</Section>

					{sessions.length > 0 ? (
						<Section title={t("worktrees.detail.agentSessions")} count={sessions.length} className="mt-4">
							<div className="flex flex-col gap-0.5">
								{sessions.slice(0, 8).map((session) => (
									<button
										key={session.file}
										type="button"
										onClick={() => go("agents", { sessionFile: session.file })}
										className="flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface"
									>
										<Dot
											tone={session.idleSeconds < 180 ? "success" : "neutral"}
											pulse={session.idleSeconds < 180}
										/>
										<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
											{session.title}
										</span>
										<span className="shrink-0 font-mono text-[10px] text-ink-faint">
											{fromSeconds(session.idleSeconds)}
										</span>
									</button>
								))}
							</div>
						</Section>
					) : null}
				</div>

				<div className="flex min-h-0 flex-col">
					{selectedFile ? (
						<>
							<div className="hairline-b flex items-center gap-2 px-3 py-2">
								<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
									{selectedFile}
								</span>
								<Button size="sm" onClick={() => setSelectedFile(null)}>
									{t("worktrees.detail.close")}
								</Button>
							</div>
							<div className="min-h-0 flex-1 overflow-auto">
								{diff.loading ? (
									<div className="flex justify-center py-8">
										<Spinner />
									</div>
								) : diff.error ? (
									<ErrorNote error={diff.error} />
								) : (
									<DiffView diff={diff.data ?? t("worktrees.detail.untracked")} />
								)}
							</div>
						</>
					) : (
						<Empty
							icon={FileDiff}
							message={t("worktrees.detail.pickFile")}
							hint={t("worktrees.detail.pickFileHint")}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

export function WorktreesView() {
	const { t } = useTranslation("views");
	const {
		worktrees,
		worktreesError,
		worktreesLoading,
		worktreesUpdatedAt,
		reloadWorktrees,
		focus,
		clearFocus,
		notify,
		runJob,
		config,
	} = useCockpit();
	const { confirm, promptText } = useConfirm();
	const { open: openWorkspaceAgent } = useAgentActions();
	// Job de suppression en cours : il porte l'avancement affiché sous le bouton.
	const [removalJob, setRemovalJob] = useState<string | null>(null);
	// Tant que le job tourne, pas de second clic ; une fois terminé — réussi ou
	// non — le bouton se rouvre, et `JobProgress` dit ce qui s'est passé.
	const removalRunning = useJobRunning(removalJob);
	const [query, setQuery] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	// La flotte est l'entrée par défaut : elle ne montre que ce qui bouge. La
	// liste complète reste accessible pour fouiller.
	const [mode, setMode] = useState<"fleet" | "list">("fleet");
	const sessions = useCockpit().projects.flatMap((project) => project.sessions);

	useEffect(() => {
		if (focus.worktreePath) {
			setSelectedPath(focus.worktreePath);
			clearFocus();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focus.worktreePath]);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const list = needle
			? worktrees.filter((tree) =>
					`${tree.branch ?? ""} ${tree.folderName}`.toLowerCase().includes(needle),
				)
			: worktrees;
		// Le principal en tête, puis par activité décroissante.
		return [...list].sort((a, b) => {
			if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
			return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
		});
	}, [worktrees, query]);

	const selected = useMemo(
		() => filtered.find((tree) => tree.path === selectedPath) ?? filtered[0] ?? null,
		[filtered, selectedPath],
	);

	// Le poids se mesure à part de la liste : parcourir trente-cinq worktrees
	// coûte des centaines de milliers d'inodes, quand la liste, elle, se
	// rafraîchit toutes les quelques secondes. Le résultat vaut dix minutes côté
	// Rust, donc ce rappel-là ne remesure presque jamais.
	const paths = useMemo(() => worktrees.map((tree) => tree.path), [worktrees]);
	const usage = useAsync(
		() => (paths.length > 0 ? api.worktrees.usage(paths) : Promise.resolve([])),
		[paths.join("|")],
	);
	const usageByPath = useMemo(
		() => new Map((usage.data ?? []).map((entry) => [entry.path, entry])),
		[usage.data],
	);
	const buildsTotal = (usage.data ?? []).reduce((sum, entry) => sum + entry.builds, 0);

	const liveByPath = useMemo(() => {
		const map = new Map<string, number>();
		for (const session of sessions) {
			if (session.idleSeconds > 180) continue;
			map.set(session.cwd, (map.get(session.cwd) ?? 0) + 1);
		}
		return map;
	}, [sessions]);

	const mainRepo = config?.mainRepo ?? "";

	return (
		<>
			<ViewHeader
				title={mode === "fleet" ? t("worktrees.fleet") : t("worktrees.title")}
				// Le total des builds vit dans le sous-titre, pas dans un écran à
				// part : c'est le chiffre qui explique un disque qui se remplit, et
				// il n'était visible nulle part. Rien tant que la mesure n'est pas
				// revenue — un « 0 Go » le temps du calcul se lirait comme un
				// verdict.
				subtitle={[
					t("worktrees.trees", { count: worktrees.length }),
					shortPath(mainRepo, 2),
					...(buildsTotal > 0 ? [t("worktrees.erasableBuilds", { size: bytes(buildsTotal) })] : []),
				].join(" · ")}
				actions={
					<>
						<Freshness
							at={worktreesUpdatedAt}
							loading={worktreesLoading}
							onReload={reloadWorktrees}
						/>
						<Button
							active={mode === "fleet"}
							onClick={() => {
								setMode("fleet");
								setSelectedPath(null);
							}}
						>
							{t("worktrees.fleet")}
						</Button>
						<Button active={mode === "list"} onClick={() => setMode("list")}>
							{t("worktrees.list")}
						</Button>
						<Button
							icon={GitBranch}
							onClick={() => {
								void promptText({
									title: t("worktrees.create.title"),
									message: t("worktrees.create.message"),
									placeholder: t("worktrees.create.placeholder"),
								}).then((branch) => {
									if (!branch) return;
									// Créer un worktree n'est jamais le but : on vient y
									// travailler. La création suivie l'annonce dans le centre
									// d'activité, puis ouvre le workspace — sans changer
									// d'écran : on est passé à autre chose entre-temps.
									void createWorktreeTracked(
										branch,
										{ mainRepo, runJob, openAgent: openWorkspaceAgent },
										{
											onReady: (path) => {
												reloadWorktrees();
												openWorkspaceAgent(path, "", undefined, undefined, true);
											},
										},
									).catch(() => undefined);
								});
							}}
							title={t("worktrees.create.hint")}
						>
							{t("worktrees.create.button")}
						</Button>
						{worktreesLoading ? <Spinner /> : null}
						<Button size="sm" icon={RefreshCw} onClick={reloadWorktrees} />
					</>
				}
			/>

			{worktreesError ? (
				<ErrorNote error={worktreesError} onRetry={reloadWorktrees} />
			) : null}

			{mode === "fleet" && !selectedPath ? (
				<FleetGrid
					onOpen={(path) => {
						setSelectedPath(path);
						setMode("list");
					}}
				/>
			) : (
				<div className="flex min-h-0 flex-1">
					<div className="hairline-r flex w-72 shrink-0 flex-col bg-base">
						<div className="p-2.5">
							<SearchField value={query} onChange={setQuery} placeholder={t("worktrees.filter")} />
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
							{filtered.map((tree) => (
								<WorktreeRow
									key={tree.path}
									tree={tree}
									selected={selected?.path === tree.path}
									liveAgents={liveByPath.get(tree.path) ?? 0}
									usage={usageByPath.get(tree.path)}
									onSelect={() => setSelectedPath(tree.path)}
								/>
							))}
						</div>
						{selected ? (
							(() => {
								const poids = usageByPath.get(selected.path);
								if (!poids || poids.builds === 0) return null;
								return (
									<div className="hairline-b flex flex-col gap-1.5 p-2">
										<Button
											variant="ghost"
											icon={Eraser}
											className="w-full justify-center"
											onClick={() => {
												void confirm({
													title: t("worktrees.purge.title", { name: selected.folderName }),
													message: t("worktrees.purge.message", { size: bytes(poids.builds) }),
													confirmLabel: t("worktrees.purge.confirm"),
												}).then((ok) => {
													if (!ok) return;
													void api.worktrees
														.purgeBuilds(selected.path, false)
														.then((rendu) => {
															notify(t("worktrees.purge.done", { size: bytes(rendu) }));
															usage.reload();
														})
														.catch((error) => notify(String(error)));
												});
											}}
										>
											{t("worktrees.purge.button", { size: bytes(poids.builds) })}
										</Button>
									</div>
								);
							})()
						) : null}
						{selected && !selected.isMain ? (
							<div className="hairline-b flex flex-col gap-1.5 p-2">
								{/* Le démontage de l'infra est long : sans son avancement, le
							    clic paraît sans effet et on le répète. */}
								<JobProgress jobId={removalJob} />
								<Button
									variant="danger"
									icon={Trash2}
									disabled={removalRunning}
									className="w-full justify-center"
									onClick={() => {
										const name = selected.folderName;
										void confirm({
											title: t("worktrees.remove.title", { name }),
											message: t("worktrees.remove.message"),
											confirmLabel: t("worktrees.remove.confirm"),
											danger: true,
										}).then((ok) => {
											if (!ok) return;
											// `--force` : la confirmation vient d'avoir lieu. Sans lui, le
											// CLI la repose sur une entrée standard que le runner ferme,
											// lit une réponse vide et renonce — en code 0.
											void api.git
												.worktreeCommand("remove", selected.branch ?? name, selected.path)
												.then(({ command }) =>
													runJob(`worktree remove ${name}`, command, mainRepo),
												)
												.then((status) => setRemovalJob(status?.jobId ?? null))
												.catch((error) => notify(String(error)));
										});
									}}
								>
									{t("worktrees.remove.button", { name: selected.folderName })}
								</Button>
							</div>
						) : null}
					</div>

					{selected ? (
						<WorktreeDetail tree={selected} />
					) : (
						<Empty icon={GitBranch} message={t("worktrees.none")} />
					)}
				</div>
			)}
		</>
	);
}
