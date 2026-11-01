import clsx from "clsx";
import {
	ArrowLeft,
	ArrowRight,
	Check,
	ChevronDown,
	ChevronRight,
	FileCode2,
	Folder,
	MessageSquareQuote,
	RotateCcw,
	Sparkles,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useAgentRuns } from "@/app/agents";
import { useCockpit } from "@/app/store";
import { DiffView } from "@/components/LogView";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { useFileViewer } from "@/lib/fileViewer";
import { api } from "@/lib/ipc";
import { agentNotes, conclusionOf, firstCommit } from "@/lib/tour";
import type { FileChange, TourStory } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * La visite des changements d'un agent : un fichier après l'autre, dans
 * l'ordre où les lire, avec ce qui a changé et pourquoi.
 *
 * Relire le travail d'un agent, c'était ouvrir un diff de quarante fichiers
 * rangés par ordre alphabétique et deviner par où commencer. La visite prend
 * par la main : l'arbre des fichiers à gauche, qui se remplit et suit le
 * parcours ; à droite, une étape par fichier — ce que l'agent en disait en le
 * modifiant, ou le récit qu'un modèle en écrit à la demande, puis le diff.
 */

interface TourTarget {
	runId: string;
}

const TourContext = createContext<{ open: (runId: string) => void } | null>(null);

export function useChangeTour() {
	return useContext(TourContext);
}

export function ChangeTourProvider({ children }: { children: ReactNode }) {
	const [target, setTarget] = useState<TourTarget | null>(null);
	const open = useCallback((runId: string) => setTarget({ runId }), []);
	const value = useMemo(() => ({ open }), [open]);
	return (
		<TourContext.Provider value={value}>
			{children}
			<AnimatePresence>
				{target ? <Tour key={target.runId} runId={target.runId} onClose={() => setTarget(null)} /> : null}
			</AnimatePresence>
		</TourContext.Provider>
	);
}

/* ── L'ordre et l'arbre ──────────────────────────────────────────────── */

// `label` est une clé du catalogue `components3`, traduite au rendu.
const STATE: Record<string, { label: string; tone: string; dot: string }> = {
	added: { label: "changeTour.state.added", tone: "text-success", dot: "bg-success" },
	untracked: { label: "changeTour.state.untracked", tone: "text-success", dot: "bg-success" },
	modified: { label: "changeTour.state.modified", tone: "text-warning", dot: "bg-warning" },
	deleted: { label: "changeTour.state.deleted", tone: "text-critical", dot: "bg-critical" },
};

function stateOf(file: FileChange) {
	return STATE[file.state] ?? STATE.modified;
}

/**
 * Le récit décide de l'ordre quand il existe ; sinon, celui dans lequel
 * l'agent a touché les fichiers ; ce qu'il n'a pas touché lui-même — généré
 * par une commande — vient en dernier.
 */
function orderFiles(files: FileChange[], order: Map<string, number>, story: TourStory | null): FileChange[] {
	const told = new Map(story?.files.map((entry, index) => [entry.path, index]) ?? []);
	const rank = (file: FileChange) =>
		told.get(file.path) ?? (story ? 10_000 : 0) + (order.get(file.path) ?? 5_000);
	return [...files].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

interface TreeNode {
	name: string;
	path: string;
	children: TreeNode[];
	file?: FileChange;
}

/** Les chemins en arbre, les dossiers à un seul enfant fusionnés (`src/lib`). */
function buildTree(files: FileChange[]): TreeNode {
	const root: TreeNode = { name: "", path: "", children: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		let node = root;
		parts.forEach((part, index) => {
			const path = parts.slice(0, index + 1).join("/");
			const isFile = index === parts.length - 1;
			let child = node.children.find((entry) => entry.name === part && !!entry.file === isFile);
			if (!child) {
				child = { name: part, path, children: [], file: isFile ? file : undefined };
				node.children.push(child);
			}
			node = child;
		});
	}
	const squash = (node: TreeNode): TreeNode => {
		node.children = node.children.map(squash);
		if (!node.file && node.children.length === 1 && !node.children[0].file && node.name) {
			const only = node.children[0];
			return { ...only, name: `${node.name}/${only.name}` };
		}
		return node;
	};
	const sorted = (node: TreeNode): TreeNode => ({
		...node,
		children: node.children
			.map(sorted)
			.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name)),
	});
	return sorted(squash(root));
}

/* ── La visite ───────────────────────────────────────────────────────── */

function Tour({ runId, onClose }: { runId: string; onClose: () => void }) {
	const { t } = useTranslation("components3");
	const { runs } = useAgentRuns();
	const { notify } = useCockpit();
	const run = runs.find((entry) => entry.id === runId);
	const turns = run?.turns ?? [];
	const cwd = run?.cwd ?? "";
	const since = useMemo(() => firstCommit(turns), [turns]);

	// En direct : un agent qui travaille encore ajoute des fichiers à l'arbre
	// pendant qu'on le parcourt.
	const changes = useAsync(() => api.tour.changes(cwd, since), [cwd, since, turns.length], {
		enabled: !!cwd,
	});
	const data = changes.data;
	const notes = useMemo(
		() => (data ? agentNotes(turns, data.root, cwd) : { said: new Map(), order: new Map() }),
		[data, turns, cwd],
	);

	const [story, setStory] = useState<TourStory | null>(null);
	const [telling, setTelling] = useState(false);
	const tell = async () => {
		if (!data) return;
		setTelling(true);
		try {
			const told = await api.tour.story(
				cwd,
				since,
				[...notes.said].map(([path, said]) => ({ path, said: said.join(" / ") })),
				conclusionOf(turns),
			);
			setStory(told);
		} catch (error) {
			notify(String(error));
		} finally {
			setTelling(false);
		}
	};

	const files = useMemo(() => (data ? orderFiles(data.files, notes.order, story) : []), [data, notes, story]);
	const tree = useMemo(() => buildTree(files), [files]);

	// 0 : l'introduction ; 1…n : un fichier chacun ; n + 1 : la fin.
	const [step, setStep] = useState(0);
	const [seen, setSeen] = useState<Set<string>>(() => new Set());
	const last = files.length + 1;
	const current = step >= 1 && step <= files.length ? files[step - 1] : null;
	useEffect(() => {
		if (current) setSeen((known) => (known.has(current.path) ? known : new Set(known).add(current.path)));
	}, [current]);

	const go = useCallback((next: number) => setStep(Math.max(0, Math.min(last, next))), [last]);
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if ((event.target as HTMLElement)?.closest("input, textarea")) return;
			if (event.key === "ArrowRight") go(step + 1);
			else if (event.key === "ArrowLeft") go(step - 1);
			else if (event.key === "Escape") onClose();
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [go, step, onClose]);

	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 p-6"
			onClick={onClose}
		>
			<motion.div
				initial={{ y: 16, scale: 0.98 }}
				animate={{ y: 0, scale: 1 }}
				exit={{ y: 12, scale: 0.98 }}
				transition={{ type: "spring", stiffness: 380, damping: 34 }}
				className="panel flex h-full w-full max-w-7xl flex-col overflow-hidden shadow-2xl shadow-black/50"
				onClick={(event) => event.stopPropagation()}
			>
				{/* En-tête : où l'on est dans la visite. */}
				<div className="hairline-b flex shrink-0 items-center gap-3 px-4 py-2.5">
					<span className="grid size-7 place-items-center rounded-lg bg-accent-dim text-accent">
						<Sparkles size={14} />
					</span>
					<div className="min-w-0 flex-1">
						<div className="truncate text-[13px] font-semibold text-ink">{t("changeTour.title")}</div>
						<div className="truncate font-mono text-[10px] text-ink-faint">
							{run?.label ?? t("changeTour.agent")}
							{data ? ` · ${data.baseLabel} · ${t("changeTour.fileCount", { count: files.length })}` : ""}
							{data ? (
								<>
									{" · "}
									<span className="text-success">+{data.additions}</span>{" "}
									<span className="text-critical">−{data.deletions}</span>
								</>
							) : null}
						</div>
					</div>
					{data && files.length > 0 ? (
						<Button
							size="sm"
							icon={telling ? undefined : Sparkles}
							active={!!story}
							disabled={telling}
							onClick={() => void tell()}
							title={t("changeTour.tellTitle")}
						>
							{telling ? t("changeTour.telling") : story ? t("changeTour.tellAgain") : t("changeTour.tell")}
						</Button>
					) : null}
					<Button size="sm" icon={X} onClick={onClose} title={t("changeTour.closeEsc")} />
				</div>

				{/* La progression : une case par étape. */}
				{files.length > 0 ? (
					<div className="flex h-1 shrink-0 gap-px bg-line-soft">
						{Array.from({ length: last + 1 }, (_, index) => (
							<button
								key={index}
								type="button"
								onClick={() => go(index)}
								className={clsx(
									"h-full flex-1 transition-colors",
									index < step ? "bg-accent/60" : index === step ? "bg-accent" : "bg-transparent hover:bg-line",
								)}
								aria-label={t("changeTour.stepAria", { index })}
							/>
						))}
					</div>
				) : null}

				<div className="flex min-h-0 flex-1">
					{/* L'arbre : il se construit, puis suit la visite. */}
					<aside className="hairline-r flex w-72 shrink-0 flex-col overflow-y-auto bg-base py-2">
						{changes.loading && !data ? (
							<div className="flex justify-center py-8">
								<Spinner />
							</div>
						) : (
							<TreeView
								node={tree}
								depth={0}
								current={current?.path ?? null}
								seen={seen}
								onPick={(file) => go(files.indexOf(file) + 1)}
							/>
						)}
					</aside>

					<section className="relative flex min-w-0 flex-1 flex-col">
						{changes.error ? (
							<ErrorNote error={String(changes.error)} onRetry={changes.reload} />
						) : !data ? (
							<div className="flex flex-1 items-center justify-center">
								<Spinner />
							</div>
						) : files.length === 0 ? (
							<div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
								<p className="text-[13px] font-semibold text-ink">{t("changeTour.empty.title")}</p>
								<p className="max-w-sm text-[12px] text-ink-muted">
									{t("changeTour.empty.body", { base: data.baseLabel })}
								</p>
							</div>
						) : (
							<AnimatePresence mode="wait" initial={false}>
								<motion.div
									key={step}
									initial={{ opacity: 0, x: 24 }}
									animate={{ opacity: 1, x: 0 }}
									exit={{ opacity: 0, x: -24 }}
									transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
									className="flex min-h-0 flex-1 flex-col"
								>
									{step === 0 ? (
										<Intro
											files={files}
											story={story}
											telling={telling}
											baseLabel={data.baseLabel}
											additions={data.additions}
											deletions={data.deletions}
											onStart={() => go(1)}
										/>
									) : current ? (
										<FileStep
											file={current}
											index={step}
											total={files.length}
											root={data.root}
											base={data.base}
											said={notes.said.get(current.path) ?? []}
											story={story?.files.find((entry) => entry.path === current.path)?.story ?? null}
										/>
									) : (
										<Outro files={files} onRestart={() => go(0)} onClose={onClose} />
									)}
								</motion.div>
							</AnimatePresence>
						)}

						{data && files.length > 0 ? (
							<div className="border-t border-line-soft flex shrink-0 items-center gap-2 px-4 py-2.5">
								<Button icon={ArrowLeft} disabled={step === 0} onClick={() => go(step - 1)}>
									{t("changeTour.nav.previous")}
								</Button>
								<span className="flex-1 text-center font-mono text-[10.5px] text-ink-faint">
									{step === 0
										? t("changeTour.nav.intro")
										: step === last
											? t("changeTour.nav.end")
											: t("changeTour.nav.fileOf", { step, total: files.length })}
									{"  ·  ←  →"}
								</span>
								{step < last ? (
									<Button variant="solid" onClick={() => go(step + 1)}>
										{step === 0 ? t("changeTour.start") : step === files.length ? t("changeTour.nav.finish") : t("changeTour.nav.next")}
										<ArrowRight size={13} />
									</Button>
								) : (
									<Button variant="solid" icon={Check} onClick={onClose}>
										{t("changeTour.close")}
									</Button>
								)}
							</div>
						) : null}
					</section>
				</div>
			</motion.div>
		</motion.div>
	);
}

function TreeView({
	node,
	depth,
	current,
	seen,
	onPick,
}: {
	node: TreeNode;
	depth: number;
	current: string | null;
	seen: Set<string>;
	onPick: (file: FileChange) => void;
}) {
	return (
		<>
			{node.children.map((child, index) => (
				<TreeRow
					key={child.path}
					node={child}
					depth={depth}
					order={index}
					current={current}
					seen={seen}
					onPick={onPick}
				/>
			))}
		</>
	);
}

function TreeRow({
	node,
	depth,
	order,
	current,
	seen,
	onPick,
}: {
	node: TreeNode;
	depth: number;
	order: number;
	current: string | null;
	seen: Set<string>;
	onPick: (file: FileChange) => void;
}) {
	const [open, setOpen] = useState(true);
	const indent = { paddingLeft: 10 + depth * 14 };
	const appear = {
		initial: { opacity: 0, x: -8 },
		animate: { opacity: 1, x: 0 },
		transition: { delay: Math.min(0.6, (depth * 4 + order) * 0.025) },
	};

	if (!node.file) {
		return (
			<motion.div {...appear}>
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					className="flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-[11px] text-ink-muted hover:text-ink"
					style={indent}
				>
					{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
					<Folder size={11} className="shrink-0 text-ink-faint" />
					<span className="truncate">{node.name}</span>
				</button>
				{open ? <TreeView node={node} depth={depth + 1} current={current} seen={seen} onPick={onPick} /> : null}
			</motion.div>
		);
	}

	const file = node.file;
	const active = current === file.path;
	const state = stateOf(file);
	return (
		<motion.button
			{...appear}
			type="button"
			onClick={() => onPick(file)}
			className={clsx(
				"relative flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-[11px]",
				active ? "text-ink" : seen.has(file.path) ? "text-ink-muted" : "text-ink-muted hover:text-ink",
			)}
			style={indent}
		>
			{active ? (
				<motion.span
					layoutId="tour-current"
					transition={{ type: "spring", stiffness: 500, damping: 40 }}
					className="absolute inset-y-0 right-1 left-1 rounded-md bg-accent-dim ring-1 ring-accent/40"
				/>
			) : null}
			<span className={clsx("relative size-1.5 shrink-0 rounded-full", state.dot)} />
			<span className={clsx("relative min-w-0 flex-1 truncate", file.state === "deleted" && "line-through")}>
				{node.name}
			</span>
			{seen.has(file.path) && !active ? <Check size={10} className="relative shrink-0 text-accent" /> : null}
			<span className="relative shrink-0 text-[9.5px] tabular-nums">
				<span className="text-success">+{file.added}</span> <span className="text-critical">−{file.removed}</span>
			</span>
		</motion.button>
	);
}

/* ── Les étapes ──────────────────────────────────────────────────────── */

function Intro({
	files,
	story,
	telling,
	baseLabel,
	additions,
	deletions,
	onStart,
}: {
	files: FileChange[];
	story: TourStory | null;
	telling: boolean;
	baseLabel: string;
	additions: number;
	deletions: number;
	onStart: () => void;
}) {
	const { t } = useTranslation("components3");
	const counts = (["added", "untracked", "modified", "deleted"] as const)
		.map((state) => ({ state, count: files.filter((file) => file.state === state).length }))
		.filter((entry) => entry.count > 0);
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-10 text-center">
			<div className="flex flex-col items-center gap-2">
				<span className="font-mono text-[10px] tracking-[0.1em] text-ink-faint uppercase">{baseLabel}</span>
				<h2 className="text-[22px] font-semibold text-ink">
					{t("changeTour.intro.heading", { count: files.length })}
				</h2>
				<p className="font-mono text-[12px]">
					<span className="text-success">+{additions}</span> <span className="text-critical">−{deletions}</span>
				</p>
			</div>
			<div className="flex flex-wrap justify-center gap-2">
				{counts.map(({ state, count }) => (
					<span key={state} className="flex items-center gap-1.5 rounded-full bg-raised px-3 py-1 text-[11.5px] text-ink">
						<span className={clsx("size-1.5 rounded-full", STATE[state].dot)} />
						{t(`changeTour.count.${state}`, { count })}
					</span>
				))}
			</div>
			{story ? (
				<p className="max-w-2xl text-[14px] leading-relaxed text-ink">{story.intro}</p>
			) : (
				<p className="max-w-xl text-[12.5px] leading-relaxed text-ink-muted">
					{telling
						? t("changeTour.intro.telling")
						: t("changeTour.intro.hint")}
				</p>
			)}
			<Button variant="solid" onClick={onStart}>
				{t("changeTour.start")}
				<ArrowRight size={13} />
			</Button>
		</div>
	);
}

function FileStep({
	file,
	index,
	total,
	root,
	base,
	said,
	story,
}: {
	file: FileChange;
	index: number;
	total: number;
	root: string;
	base: string;
	said: string[];
	story: string | null;
}) {
	const { t } = useTranslation("components3");
	const viewer = useFileViewer();
	const diff = useAsync(
		() => api.tour.fileDiff(root, base, file.path, file.state === "untracked"),
		[root, base, file.path, file.state],
	);
	const state = stateOf(file);
	const slash = file.path.lastIndexOf("/");
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-col gap-3 px-6 pt-5 pb-4">
				<div className="flex items-center gap-2">
					<span className="font-mono text-[10px] tracking-[0.1em] text-ink-faint uppercase">
						{t("changeTour.file.stepOf", { index, total })}
					</span>
					<span className={clsx("font-mono text-[10px] tracking-[0.1em] uppercase", state.tone)}>· {t(state.label)}</span>
					<span className="font-mono text-[10px] tabular-nums">
						<span className="text-success">+{file.added}</span> <span className="text-critical">−{file.removed}</span>
					</span>
					<span className="flex-1" />
					{file.state !== "deleted" && viewer ? (
						<Button size="sm" icon={FileCode2} onClick={() => viewer.open(`${root}/${file.path}`)}>
							{t("changeTour.file.open")}
						</Button>
					) : null}
				</div>
				<h3 className="truncate font-mono text-[15px] text-ink" title={file.path}>
					<span className="text-ink-faint">{slash >= 0 ? file.path.slice(0, slash + 1) : ""}</span>
					<span className="font-semibold">{slash >= 0 ? file.path.slice(slash + 1) : file.path}</span>
				</h3>

				{/* Le guide : le récit s'il existe, sinon les mots de l'agent. */}
				<div className="rounded-xl border border-accent/25 bg-accent-dim/60 px-4 py-3">
					{story ? (
						<>
							<div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-accent uppercase">
								<Sparkles size={11} /> {t("changeTour.file.story")}
							</div>
							<p className="text-[13px] leading-relaxed text-ink">{story}</p>
						</>
					) : said.length > 0 ? (
						<>
							<div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-accent uppercase">
								<MessageSquareQuote size={11} /> {t("changeTour.file.said")}
							</div>
							<div className="flex flex-col gap-1.5">
								{said.slice(-3).map((text) => (
									<p key={text} className="text-[12.5px] leading-relaxed text-ink">
										{t("changeTour.file.quote", { text })}
									</p>
								))}
							</div>
						</>
					) : (
						<p className="text-[12.5px] leading-relaxed text-ink-muted">
							{t("changeTour.file.silent")}
						</p>
					)}
				</div>
			</div>
			<div className="border-t border-line-soft min-h-0 flex-1 overflow-auto">
				{diff.loading && !diff.data ? (
					<div className="flex justify-center py-8">
						<Spinner />
					</div>
				) : diff.error ? (
					<ErrorNote error={String(diff.error)} onRetry={diff.reload} />
				) : (
					<DiffView diff={diff.data ?? ""} />
				)}
			</div>
		</div>
	);
}

function Outro({ files, onRestart, onClose }: { files: FileChange[]; onRestart: () => void; onClose: () => void }) {
	const { t } = useTranslation("components3");
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
			<span className="grid size-12 place-items-center rounded-2xl bg-success/12 text-success">
				<Check size={22} />
			</span>
			<h2 className="text-[20px] font-semibold text-ink">{t("changeTour.outro.title")}</h2>
			<p className="max-w-md text-[12.5px] text-ink-muted">
				{t("changeTour.outro.body", { count: files.length })}
			</p>
			<div className="flex gap-2">
				<Button icon={RotateCcw} onClick={onRestart}>
					{t("changeTour.outro.restart")}
				</Button>
				<Button variant="solid" icon={Check} onClick={onClose}>
					{t("changeTour.close")}
				</Button>
			</div>
		</div>
	);
}
