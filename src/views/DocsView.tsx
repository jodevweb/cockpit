import clsx from "clsx";
import {
	ArrowLeft,
	Braces,
	ClipboardCheck,
	FileCode,
	FileText,
	FolderOpen,
	GitBranch,
	LayoutGrid,
	List,
	ScrollText,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import {
	Badge,
	Button,
	Empty,
	ErrorNote,
	Freshness,
	SearchField,
	Spinner,
	ViewHeader,
} from "@/components/ui";
import { bytes, fromTimestamp } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { DocEntry } from "@/lib/types";
import { usePersistentState, useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { useTranslation } from "react-i18next";

/**
 * Icône par nature de document.
 *
 * Une liste de noms de fichiers se ressemble toute ; la forme du document —
 * compte rendu, revue, données — se reconnaît d'un coup d'œil.
 */
function iconOf(doc: DocEntry) {
	const extension = doc.name.split(".").pop()?.toLowerCase() ?? "";
	if (doc.category === "revue") return ClipboardCheck;
	if (extension === "json" || extension === "yml" || extension === "yaml") return Braces;
	if (["ts", "tsx", "js", "sql", "sh"].includes(extension)) return FileCode;
	if (doc.category === "wiki") return ScrollText;
	return FileText;
}

/**
 * Livrables des agents, en mosaïque.
 *
 * Une liste de trois cents lignes ne dit ni ce qu'on regarde ni d'où ça vient.
 * En cartes, la nature du document, son worktree et son extrait tiennent dans
 * le même coup d'œil — et le regroupement par famille remplace le tri par date
 * qui mélangeait un plan de migration et une note de QA.
 */
export function DocsView() {
	const { worktrees, focus, clearFocus, notify, go, reloadWorktrees } = useCockpit();
	const { t } = useTranslation("views");
	const [query, setQuery] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [layout, setLayout] = usePersistentState<"grid" | "list">("docs.layout", "grid");
	const [groupBy, setGroupBy] = usePersistentState<"category" | "worktree">(
		"docs.groupBy",
		"category",
	);
	const [category, setCategory] = useState<string | null>(null);

	const roots = useMemo(
		() =>
			worktrees.map(
				(tree) => [tree.path, tree.branch ?? tree.folderName] as [string, string],
			),
		[worktrees],
	);

	// Les agents écrivent leurs livrables en continu : un balayage périodique
	// suffit à les voir arriver sans surveiller tous les worktrees.
	const docs = useAsync(
		() => (roots.length ? api.docs.scan(roots, 400) : Promise.resolve([])),
		[roots.length, roots.map(([path]) => path).join("|")],
		{ enabled: roots.length > 0, pollMs: 30_000 },
	);

	// Les worktrees vont et viennent au fil de la journée, et cet écran ne
	// regarde que ceux qu'il connaît : un document écrit dans un worktree
	// apparu depuis restait introuvable, même en rechargeant la liste — c'est
	// la liste des dossiers à balayer qui était périmée, pas le balayage.
	const refresh = useCallback(() => {
		reloadWorktrees();
		docs.reload();
	}, [docs, reloadWorktrees]);
	useEffect(() => {
		reloadWorktrees();
		// Au montage seulement : arriver sur l'écran vaut demande d'état frais.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (focus.docPath) {
			setSelectedPath(focus.docPath);
			clearFocus();
		}
	}, [focus.docPath, clearFocus]);

	const all = useMemo(() => docs.data ?? [], [docs.data]);

	const items = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return all.filter((doc) => {
			if (category && doc.category !== category) return false;
			if (!needle) return true;
			return `${doc.name} ${doc.relative} ${doc.worktree} ${doc.preview}`
				.toLowerCase()
				.includes(needle);
		});
	}, [all, category, query]);

	const categories = useMemo(() => {
		const counts = new Map<string, number>();
		for (const doc of all) counts.set(doc.category, (counts.get(doc.category) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	}, [all]);

	// Les groupes suivent l'ordre d'arrivée des documents, déjà triés par
	// fraîcheur : le plus récent ouvre chaque famille.
	const groups = useMemo(() => {
		const map = new Map<string, DocEntry[]>();
		for (const doc of items) {
			const key = groupBy === "category" ? doc.category : doc.worktree;
			const list = map.get(key) ?? [];
			list.push(doc);
			map.set(key, list);
		}
		return [...map.entries()];
	}, [items, groupBy]);

	const selected = useMemo(
		() => all.find((doc) => doc.path === selectedPath) ?? null,
		[all, selectedPath],
	);

	const content = useAsync(
		() => (selected ? api.docs.read(selected.path) : Promise.resolve("")),
		[selected?.path],
		{ enabled: Boolean(selected) },
	);

	// Échap remonte d'un cran, comme partout ailleurs dans l'app.
	useEffect(() => {
		if (!selected) return;
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") setSelectedPath(null);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [selected]);

	// Lecture plein écran : un document se lit sans la mosaïque à côté.
	if (selected) {
		return (
			<>
				{/* Le retour est la première chose à trouver quand on a fini de lire :
				    à gauche, avant le titre, et sur Échap. */}
				<div className="hairline-b flex h-13 shrink-0 items-center gap-3 px-4 py-2.5">
					<Button
						icon={ArrowLeft}
						variant="outline"
						onClick={() => setSelectedPath(null)}
						title={t("docs.backToGrid")}
					>
						{t("docs.title")}
					</Button>
					<div className="min-w-0 flex-1">
						<h1 className="truncate text-[14px] leading-tight font-semibold tracking-[-0.01em]">
							{selected.name}
						</h1>
						<p className="truncate text-[11px] text-ink-faint">
							{selected.worktree} · {selected.relative} · {bytes(selected.size)}
						</p>
					</div>
					<Button
						icon={GitBranch}
						onClick={() => go("worktrees", { worktreePath: selected.worktreePath })}
						title={t("docs.openWorktree")}
					>
						{selected.worktree}
					</Button>
					<Button
						icon={FolderOpen}
						onClick={() => {
							void api.system.reveal(selected.path).catch((error) => notify(String(error)));
						}}
					>
						{t("docs.reveal")}
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
					{content.loading && !content.data ? (
						<div className="flex justify-center py-10">
							<Spinner />
						</div>
					) : content.error ? (
						<ErrorNote error={content.error} />
					) : (
						<div className="text-selectable mx-auto max-w-3xl">
							{/* Un livrable cite les fichiers de son propre worktree. */}
							<Markdown source={content.data ?? ""} cwd={selected.worktreePath} />
						</div>
					)}
				</div>
			</>
		);
	}

	return (
		<>
			<ViewHeader
				title={t("docs.title")}
				subtitle={t("docs.subtitle")}
				actions={
					<>
						<Freshness at={docs.updatedAt} loading={docs.loading} onReload={refresh} />
						<div className="flex items-center gap-1 rounded-lg border border-line-soft p-0.5">
							<Button
								size="sm"
								icon={LayoutGrid}
								active={layout === "grid"}
								onClick={() => setLayout("grid")}
								title={t("docs.grid")}
							/>
							<Button
								size="sm"
								icon={List}
								active={layout === "list"}
								onClick={() => setLayout("list")}
								title={t("docs.list")}
							/>
						</div>
					</>
				}
			/>

			<div className="hairline-b flex flex-wrap items-center gap-2 px-4 py-2">
				<div className="w-72">
					<SearchField value={query} onChange={setQuery} placeholder={t("docs.search")} />
				</div>

				<div className="flex flex-wrap items-center gap-1">
					<Button size="sm" active={category === null} onClick={() => setCategory(null)}>
						{t("docs.all", { count: all.length })}
					</Button>
					{categories.map(([name, count]) => (
						<Button
							key={name}
							size="sm"
							active={category === name}
							onClick={() => setCategory(category === name ? null : name)}
						>
							{name} · {count}
						</Button>
					))}
				</div>

				<div className="ml-auto flex items-center gap-1 rounded-lg border border-line-soft p-0.5">
					<Button
						size="sm"
						active={groupBy === "category"}
						onClick={() => setGroupBy("category")}
						title={t("docs.groupByTypeTitle")}
					>
						{t("docs.groupByType")}
					</Button>
					<Button
						size="sm"
						active={groupBy === "worktree"}
						onClick={() => setGroupBy("worktree")}
						title={t("docs.groupByWorktreeTitle")}
					>
						{t("docs.groupByWorktree")}
					</Button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{docs.error ? <ErrorNote error={docs.error} onRetry={refresh} /> : null}
				{items.length === 0 && !docs.loading ? (
					<Empty
						icon={FileText}
						message={t("docs.empty")}
						hint={t("docs.emptyHint")}
					/>
				) : null}

				<div className="flex flex-col gap-5">
					{groups.map(([group, entries]) => (
						<section key={group}>
							<div className="mb-2 flex items-center gap-1.5">
								<h2 className="text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
									{group}
								</h2>
								<span className="font-mono text-[10px] text-ink-faint/70">
									{entries.length}
								</span>
							</div>

							{/* Colonnes déduites de la place disponible, pas de paliers : la
							    fenêtre n'occupe pas toute la largeur de l'écran, et les paliers
							    `xl`/`2xl` mesurent l'écran — d'où deux colonnes et la moitié
							    droite vide sur une fenêtre pourtant large. */}
							{layout === "grid" ? (
								<div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-2">
									{entries.map((doc) => (
										<DocCard
											key={doc.path}
											doc={doc}
											onOpen={() => setSelectedPath(doc.path)}
										/>
									))}
								</div>
							) : (
								<div className="panel flex flex-col divide-y divide-line-soft">
									{entries.map((doc) => (
										<button
											key={doc.path}
											type="button"
											onClick={() => setSelectedPath(doc.path)}
											className="flex items-center gap-2 p-2.5 text-left hover:bg-hover"
										>
											<span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
												{doc.name}
											</span>
											<Badge tone="accent">{doc.worktree}</Badge>
											<span className="shrink-0 font-mono text-[10px] text-ink-faint">
												{fromTimestamp(doc.modified)}
											</span>
										</button>
									))}
								</div>
							)}
						</section>
					))}
				</div>
			</div>
		</>
	);
}

function DocCard({ doc, onOpen }: { doc: DocEntry; onOpen: () => void }) {
	const { t } = useTranslation("views");
	const Icon = iconOf(doc);
	return (
		<button
			type="button"
			onClick={onOpen}
			title={doc.relative}
			className="panel flex flex-col gap-1.5 p-3 text-left transition-colors hover:border-line"
		>
			<div className="flex items-center gap-2">
				<Icon size={13} className="shrink-0 text-ink-faint" />
				<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
					{doc.name}
				</span>
				{doc.untracked ? <Badge tone="warning">{t("docs.untracked")}</Badge> : null}
			</div>

			{doc.preview ? (
				<p className="line-clamp-3 text-[10px] leading-snug text-ink-faint">
					{doc.preview}
				</p>
			) : (
				<p className="text-[10px] text-ink-faint/60 italic">{t("docs.noPreview")}</p>
			)}

			<div className="mt-auto flex items-center gap-1.5 pt-1">
				<span
					className={clsx(
						"min-w-0 flex-1 truncate font-mono text-[10px]",
						"text-accent-soft/80",
					)}
					title={doc.worktreePath}
				>
					{doc.worktree}
				</span>
				<span className="shrink-0 font-mono text-[10px] text-ink-faint">
					{fromTimestamp(doc.modified)}
				</span>
			</div>
		</button>
	);
}
