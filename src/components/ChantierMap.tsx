import clsx from "clsx";
import {
	AlertTriangle,
	ArrowUpRight,
	ChevronRight,
	Clock,
	FileText,
	Folder,
	GitMerge,
	Layers,
	MessageSquarePlus,
	Rocket,
	Send,
	X,
} from "lucide-react";
import type { TFunction } from "i18next";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentActions, type AgentRun } from "@/app/agents";
import { Button, LoadingBar } from "@/components/ui";
import {
	agentColor,
	buildZones,
	collapse,
	collisions as findCollisions,
	compactAt,
	findZone,
	knowledgeOf,
	lastCompaction,
	pathsToStamp,
	relativeTo,
	slices,
	squarify,
	staleness,
	touchesOf,
	type Collision,
	type Rect,
	type Stale,
	type Zone,
} from "@/lib/chantier";
import { useFileViewer } from "@/lib/fileViewer";
import { compactNumber, fromSeconds } from "@/lib/format";
import { api } from "@/lib/ipc";
import {
	addRemark,
	clearRemarks,
	composeRemarks,
	removeRemark,
	useAllRemarks,
	type Remark,
} from "@/lib/remarks";
import { useAsync } from "@/lib/useAsync";

/**
 * La carte du chantier : tous les agents d'un worktree, posés sur le code.
 *
 * Le fil et la carte d'un agent racontent une histoire, dans l'ordre. Ici on
 * regarde un lieu : le dépôt en pavés proportionnels à leur poids, et sur
 * chaque pavé les agents qui y ont lu ou écrit. Trois choses s'y lisent d'un
 * coup d'œil, qu'aucun fil ne montre :
 *
 * - **qui travaille où**, et donc qui risque de se croiser ;
 * - **les collisions** — un fichier écrit par deux agents du même worktree ;
 * - **les lectures périmées** — un agent qui s'appuie sur une version d'un
 *   fichier que le disque a dépassée, quelle que soit la main qui l'a changé.
 *
 * Et chaque agent a sa jauge : de quoi son contexte est rempli, compté par le
 * CLI lui-même, et quand il a été résumé pour la dernière fois.
 *
 * On pilote depuis la carte : prévenir un agent de ce qui a changé, lui poser
 * une remarque sur un fichier, lancer un agent cantonné à une zone.
 */

const ago = (at: number | null | undefined) => (at ? fromSeconds((Date.now() - at) / 1000) : "—");

function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function agentState(run: AgentRun, t: TFunction): { label: string; tone: string } {
	if (!run.running) return { label: t("chantierMap.state.stopped"), tone: "text-ink-faint" };
	if (run.thinking) return { label: t("chantierMap.state.working"), tone: "text-success" };
	return { label: t("chantierMap.state.waiting"), tone: "text-info" };
}

/** Ce que la carte sait d'un fichier touché, agents confondus. */
interface FileMark {
	/** Relatif à la racine. */
	path: string;
	readers: Set<number>;
	writers: Set<number>;
	lastAt: number;
	collision: boolean;
	stale: Stale[];
}

/**
 * Masqué, l'onglet ne se redessine pas : chaque événement de chaque agent le
 * faisait recalculer, pour un écran que personne ne regardait. Il se remet à
 * jour en redevenant visible.
 */
export const ChantierMap = memo(ChantierMapView, (before, after) => !before.active && !after.active && before.cwd === after.cwd);

function ChantierMapView({ cwd, runs, active }: { cwd: string; runs: AgentRun[]; active: boolean }) {
	const { t } = useTranslation("components1");
	const actions = useAgentActions();
	const viewer = useFileViewer();
	const allRemarks = useAllRemarks();

	const territory = useAsync(() => api.chantier.territory(cwd), [cwd], {
		enabled: active,
		pollMs: 30_000,
	});

	const paths = useMemo(() => pathsToStamp(runs), [runs]);
	const pathsKey = paths.join("\n");
	const stamps = useAsync(() => api.chantier.stamps(paths), [pathsKey], {
		enabled: active && paths.length > 0,
		pollMs: 4_000,
	});
	const stampMap = useMemo(() => {
		const map = new Map<string, number | null>();
		for (const stamp of stamps.data ?? []) map.set(stamp.path, stamp.modifiedMs);
		return map;
	}, [stamps.data]);

	const stale = useMemo(() => staleness(runs, stampMap), [runs, stampMap]);
	const collisions = useMemo(() => findCollisions(runs), [runs]);
	const indexOf = useMemo(() => new Map(runs.map((run, index) => [run.id, index])), [runs]);

	// Chaque fichier touché, relatif à la racine : de quoi colorer la carte.
	const marks = useMemo(() => {
		const out = new Map<string, FileMark>();
		const reach = (absolute: string) => {
			const path = relativeTo(cwd, absolute);
			if (path === null) return null;
			let mark = out.get(path);
			if (!mark) {
				mark = { path, readers: new Set(), writers: new Set(), lastAt: 0, collision: false, stale: [] };
				out.set(path, mark);
			}
			return mark;
		};
		runs.forEach((run, index) => {
			for (const touch of touchesOf(run)) {
				if (touch.kind === "search") continue;
				const mark = reach(touch.path);
				if (!mark) continue;
				(touch.kind === "write" ? mark.writers : mark.readers).add(index);
				mark.lastAt = Math.max(mark.lastAt, touch.at ?? 0);
			}
		});
		for (const collision of collisions) {
			const mark = reach(collision.path);
			if (mark) mark.collision = true;
		}
		for (const entry of stale) {
			const mark = reach(entry.path);
			if (mark) mark.stale.push(entry);
		}
		return out;
	}, [runs, cwd, collisions, stale]);

	const [focus, setFocus] = useState("");
	const [selected, setSelected] = useState<{ path: string; file: boolean } | null>(null);
	const [hoverAgent, setHoverAgent] = useState<number | null>(null);

	const root = useMemo(() => buildZones(territory.data?.files ?? []), [territory.data]);
	const focusZone = useMemo(() => collapse(findZone(root, focus) ?? root), [root, focus]);

	/** Montre un fichier sur la carte : on se place dans son dossier et on le désigne. */
	const reveal = (absolute: string) => {
		const path = relativeTo(cwd, absolute);
		if (path === null) return;
		setFocus(path.split("/").slice(0, -1).join("/"));
		setSelected({ path, file: true });
	};

	const warn = (runId: string, entries: Stale[]) => {
		const lines = entries.map((entry) => {
			const shown = relativeTo(cwd, entry.path) ?? entry.path;
			const who = entry.modifiedAt === null
				? "deleted since"
				: entry.by
					? `modified by the agent “${entry.by.label}” ${ago(entry.modifiedAt)}`
					: `modified outside your tools ${ago(entry.modifiedAt)} (a terminal, git, or me)`;
			return `- \`${shown}\` — ${who}`;
		});
		actions.send(
			runId,
			`Heads up: ${entries.length > 1 ? "these files have" : "this file has"} changed since you read ${entries.length > 1 ? "them" : "it"}:\n${lines.join("\n")}\n\nRe-read ${entries.length > 1 ? "them" : "it"} before relying on ${entries.length > 1 ? "them" : "it"} or modifying ${entries.length > 1 ? "them" : "it"}.`,
		);
	};

	const warnCollision = (collision: Collision) => {
		const shown = relativeTo(cwd, collision.path) ?? collision.path;
		for (const writer of collision.writers) {
			const others = collision.writers.filter((entry) => entry.runId !== writer.runId);
			actions.send(
				writer.runId,
				`Heads up: you're not the only one writing to \`${shown}\`. ${others
					.map((other) => `The agent “${other.label}” modified it ${ago(other.at)}.`)
					.join(" ")} Re-read the file as it is now before touching it, and don't undo its work without telling me.`,
			);
		}
	};

	const alerts = collisions.length + new Set(stale.map((entry) => `${entry.runId} ${entry.path}`)).size;

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-base">
			<LoadingBar active={active && (territory.loading || (stamps.initial && stamps.loading))} />
			<AlertStrip
				cwd={cwd}
				runs={runs}
				indexOf={indexOf}
				stale={stale}
				collisions={collisions}
				onReveal={reveal}
				onWarn={warn}
				onWarnCollision={warnCollision}
			/>
			<div className="flex min-h-0 flex-1 gap-3 p-3">
				<section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-panel)] bg-surface shadow-[var(--shadow-card)]">
					<header className="flex items-center gap-1.5 px-3 pt-2.5 pb-2">
						<Layers size={13} className="shrink-0 text-accent-soft" />
						<Breadcrumb
							root={basename(cwd)}
							path={focusZone.path}
							onGo={(path) => {
								setFocus(path);
								setSelected(null);
							}}
						/>
						<span className="ml-auto shrink-0 text-[10.5px] text-ink-faint">
							{territory.data
								? `${t("chantierMap.files", { count: focusZone.files, formatted: compactNumber(focusZone.files) })}${territory.data.truncated ? ` ${t("chantierMap.truncated")}` : ""}`
								: null}
						</span>
						{focusZone.path ? (
							<Button
								size="sm"
								icon={MessageSquarePlus}
								onClick={() => setSelected({ path: focusZone.path, file: false })}
								title={t("chantierMap.folderAction.hint")}
							>
								{t("chantierMap.folderAction.label")}
							</Button>
						) : null}
					</header>
					<Legend runs={runs} hover={hoverAgent} onHover={setHoverAgent} />
					<div className="relative min-h-0 flex-1 px-3 pb-3">
						{territory.error ? (
							<p className="px-2 py-10 text-center text-[12px] text-ink-faint">
								{t("chantierMap.noTerritory", { error: territory.error })}
							</p>
						) : !territory.data ? (
							// Le dépôt se lit en quelques secondes sur un gros projet : la
							// forme de la carte apparaît tout de suite, ses pavés ensuite.
							<div className="grid h-full grid-cols-6 grid-rows-4 gap-1.5" aria-label={t("chantierMap.readingRepo")}>
								{[
									"col-span-3 row-span-3",
									"col-span-2 row-span-2",
									"col-span-1 row-span-2",
									"col-span-3 row-span-2",
									"col-span-3 row-span-1",
									"col-span-2 row-span-1",
									"col-span-1 row-span-1",
								].map((span, index) => (
									<div key={index} className={clsx("skeleton rounded-md", span)} />
								))}
							</div>
						) : (
							<Treemap
								zone={focusZone}
								marks={marks}
								hoverAgent={hoverAgent}
								selected={selected?.path ?? null}
								onEnter={(zone) => {
									setFocus(zone.path);
									setSelected(null);
								}}
								onSelect={(path, file) => setSelected({ path, file })}
							/>
						)}
					</div>
				</section>

				{/* La fiche de ce qu'on désigne vit en tête de colonne : posée sur
				    la carte, elle cachait justement le pavé qu'on venait de choisir. */}
				<aside className="flex w-[320px] shrink-0 flex-col gap-2.5 overflow-y-auto pr-0.5">
					{selected ? (
						<SelectionCard
							cwd={cwd}
							runs={runs}
							selection={selected}
							mark={marks.get(selected.path) ?? null}
							onClose={() => setSelected(null)}
							onOpen={(path) => viewer?.open(`${cwd.replace(/\/$/, "")}/${path}`)}
						/>
					) : null}
					{runs.map((run, index) => (
						<AgentCard
							key={run.id}
							run={run}
							index={index}
							cwd={cwd}
							stale={stale.filter((entry) => entry.runId === run.id)}
							remarks={allRemarks.filter((remark) => remark.runId === run.id)}
							highlighted={hoverAgent === index}
							onHover={(value) => setHoverAgent(value ? index : null)}
							onReveal={reveal}
							onWarn={(entries) => warn(run.id, entries)}
						/>
					))}
					{alerts === 0 && runs.length > 1 ? (
						<p className="px-1 text-[11px] leading-relaxed text-ink-faint">
							{t("chantierMap.allClear")}
						</p>
					) : null}
				</aside>
			</div>
		</div>
	);
}

// ───────────────────────────── Bandeau ─────────────────────────────

function AlertStrip({
	cwd,
	runs,
	indexOf,
	stale,
	collisions,
	onReveal,
	onWarn,
	onWarnCollision,
}: {
	cwd: string;
	runs: AgentRun[];
	indexOf: Map<string, number>;
	stale: Stale[];
	collisions: Collision[];
	onReveal: (path: string) => void;
	onWarn: (runId: string, entries: Stale[]) => void;
	onWarnCollision: (collision: Collision) => void;
}) {
	// Les lectures périmées, regroupées par agent : c'est à lui qu'on s'adresse.
	const byRun = useMemo(() => {
		const groups = new Map<string, Stale[]>();
		for (const entry of stale) {
			groups.set(entry.runId, [...(groups.get(entry.runId) ?? []), entry]);
		}
		return [...groups.entries()];
	}, [stale]);
	const { t } = useTranslation("components1");

	if (collisions.length === 0 && byRun.length === 0) return null;
	const label = (runId: string) => runs.find((run) => run.id === runId)?.label ?? t("chantierMap.agentFallback");

	return (
		<div className="flex flex-wrap gap-2 px-3 pt-3">
			{collisions.map((collision) => (
				<div
					key={collision.path}
					className="flex min-w-0 items-center gap-2 rounded-xl bg-critical/10 py-1.5 pr-1.5 pl-2.5 text-[11.5px] text-ink"
				>
					<GitMerge size={13} className="shrink-0 text-critical" />
					<button
						type="button"
						onClick={() => onReveal(collision.path)}
						className="focus-ring min-w-0 truncate rounded text-left"
						title={collision.path}
					>
						<span className="font-mono text-[11px]">{relativeTo(cwd, collision.path) ?? collision.path}</span>
						<span className="text-ink-muted"> {t("chantierMap.alerts.writtenBy")} </span>
						{collision.writers.map((writer, index) => (
							<span key={writer.runId}>
								{index > 0 ? <span className="text-ink-muted"> {t("chantierMap.alerts.and")} </span> : null}
								<AgentName label={writer.label} index={indexOf.get(writer.runId) ?? 0} />
							</span>
						))}
					</button>
					<Button size="sm" variant="danger" icon={Send} onClick={() => onWarnCollision(collision)}>
						{t("chantierMap.alerts.warn")}
					</Button>
				</div>
			))}
			{byRun.map(([runId, entries]) => (
				<div
					key={runId}
					className="flex min-w-0 items-center gap-2 rounded-xl bg-warning/10 py-1.5 pr-1.5 pl-2.5 text-[11.5px] text-ink"
				>
					<Clock size={13} className="shrink-0 text-warning" />
					<button
						type="button"
						onClick={() => onReveal(entries[0].path)}
						className="focus-ring min-w-0 truncate rounded text-left"
					>
						<AgentName label={label(runId)} index={indexOf.get(runId) ?? 0} />
						<span className="text-ink-muted">
							{" "}
							{t("chantierMap.alerts.reliesOn", { count: entries.length })}{" "}
						</span>
						<span className="font-mono text-[11px]">
							{entries
								.slice(0, 2)
								.map((entry) => basename(entry.path))
								.join(", ")}
							{entries.length > 2 ? "…" : ""}
						</span>
					</button>
					<Button size="sm" variant="warning" icon={Send} onClick={() => onWarn(runId, entries)}>
						{t("chantierMap.alerts.warnAgent")}
					</Button>
				</div>
			))}
		</div>
	);
}

function AgentName({ label, index }: { label: string; index: number }) {
	return (
		<span className="inline-flex items-center gap-1 font-medium">
			<span className="inline-block size-2 rounded-full" style={{ background: agentColor(index) }} />
			{label}
		</span>
	);
}

// ───────────────────────────── Territoire ─────────────────────────────

function Breadcrumb({ root, path, onGo }: { root: string; path: string; onGo: (path: string) => void }) {
	const parts = path ? path.split("/") : [];
	return (
		<nav className="flex min-w-0 items-center gap-0.5 text-[12px]">
			<button
				type="button"
				onClick={() => onGo("")}
				className={clsx("focus-ring truncate rounded px-1 font-semibold", parts.length ? "text-ink-muted hover:text-ink" : "text-ink")}
			>
				{root}
			</button>
			{parts.map((part, index) => (
				<span key={index} className="flex min-w-0 items-center gap-0.5">
					<ChevronRight size={11} className="shrink-0 text-ink-faint" />
					<button
						type="button"
						onClick={() => onGo(parts.slice(0, index + 1).join("/"))}
						className={clsx(
							"focus-ring truncate rounded px-1 font-mono text-[11.5px]",
							index === parts.length - 1 ? "text-ink" : "text-ink-muted hover:text-ink",
						)}
					>
						{part}
					</button>
				</span>
			))}
		</nav>
	);
}

function Legend({
	runs,
	hover,
	onHover,
}: {
	runs: AgentRun[];
	hover: number | null;
	onHover: (index: number | null) => void;
}) {
	const { t } = useTranslation("components1");
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-[10.5px] text-ink-muted">
			{runs.map((run, index) => (
				<button
					key={run.id}
					type="button"
					onMouseEnter={() => onHover(index)}
					onMouseLeave={() => onHover(null)}
					className={clsx("focus-ring flex items-center gap-1 rounded", hover !== null && hover !== index && "opacity-40")}
				>
					<span className="size-2 rounded-full" style={{ background: agentColor(index) }} />
					<span className="max-w-40 truncate">{run.label}</span>
				</button>
			))}
			<span className="ml-auto flex items-center gap-3 text-ink-faint">
				<span className="flex items-center gap-1">
					<span className="h-1 w-3 rounded-full bg-ink-faint/60" /> {t("chantierMap.legend.read")}
				</span>
				<span className="flex items-center gap-1">
					<span className="h-1.5 w-3 rounded-full bg-ink-muted" /> {t("chantierMap.legend.written")}
				</span>
				<span className="flex items-center gap-1">
					<span className="size-2 rounded-sm ring-2 ring-critical" /> {t("chantierMap.legend.collision")}
				</span>
				<span className="flex items-center gap-1">
					<span className="size-2 rounded-sm outline-2 -outline-offset-2 outline-dashed outline-warning" /> {t("chantierMap.legend.stale")}
				</span>
			</span>
		</div>
	);
}

interface Summary {
	readers: Set<number>;
	writers: Set<number>;
	collision: boolean;
	stale: boolean;
	lastAt: number;
}

function summarize(zone: Zone, marks: Map<string, FileMark>): Summary {
	const summary: Summary = { readers: new Set(), writers: new Set(), collision: false, stale: false, lastAt: 0 };
	const prefix = `${zone.path}/`;
	for (const mark of marks.values()) {
		if (mark.path !== zone.path && !mark.path.startsWith(prefix)) continue;
		for (const index of mark.readers) summary.readers.add(index);
		for (const index of mark.writers) summary.writers.add(index);
		summary.collision ||= mark.collision;
		summary.stale ||= mark.stale.length > 0;
		summary.lastAt = Math.max(summary.lastAt, mark.lastAt);
	}
	return summary;
}

interface Tile {
	zone: Zone;
	rect: Rect;
	depth: number;
	/** Ses sous-zones sont dessinées dedans : il ne garde que son en-tête. */
	nested: boolean;
	/** `fo/src` quand `fo` n'a que `src` : un pavé plutôt que deux emboîtés. */
	label: string;
}

/** Jusqu'où descendre, tant que la place le permet. */
const MAX_DEPTH = 3;

const HEADER = 20;
const GAP = 3;

function Treemap({
	zone,
	marks,
	hoverAgent,
	selected,
	onEnter,
	onSelect,
}: {
	zone: Zone;
	marks: Map<string, FileMark>;
	hoverAgent: number | null;
	selected: string | null;
	onEnter: (zone: Zone) => void;
	onSelect: (path: string, file: boolean) => void;
}) {
	const { t } = useTranslation("components1");
	const box = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	useLayoutEffect(() => {
		const element = box.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const tiles = useMemo(() => {
		const out: Tile[] = [];
		if (size.w < 20 || size.h < 20) return out;
		// Au-delà de quatre-vingts pavés, les plus petits ne se voient plus : ils
		// restent comptés dans le poids de leur dossier.
		const place = (children: Zone[], area: Rect, depth: number) => {
			for (const placed of squarify(children.slice(0, 80), area)) {
				const rect = shrink(placed.rect, depth === 1 ? GAP / 2 : 1.5);
				if (rect.w < 6 || rect.h < 6) continue;
				const entry = collapse(placed);
				const label = entry === placed ? placed.name : `${placed.name}/${entry.path.slice(placed.path.length + 1)}`;
				const roomy = rect.w >= 110 && rect.h >= 64;
				const nested = entry.children.length > 0 && depth < MAX_DEPTH && roomy;
				out.push({ zone: entry, rect, depth, nested, label });
				if (nested) {
					place(entry.children, { x: rect.x + 4, y: rect.y + HEADER, w: rect.w - 8, h: rect.h - HEADER - 4 }, depth + 1);
				}
			}
		};
		place(zone.children, { x: 0, y: 0, w: size.w, h: size.h }, 1);
		return out;
	}, [zone, size]);

	return (
		<div ref={box} className="relative h-full w-full">
			{tiles.map((tile) => (
				<TileView
					key={tile.zone.path}
					tile={tile}
					summary={summarize(tile.zone, marks)}
					hoverAgent={hoverAgent}
					selected={selected === tile.zone.path}
					onClick={() => {
						if (tile.zone.children.length > 0) onEnter(tile.zone);
						else onSelect(tile.zone.path, true);
					}}
				/>
			))}
			{zone.children.length === 0 ? (
				<p className="py-10 text-center text-[12px] text-ink-faint">{t("chantierMap.emptyFolder")}</p>
			) : null}
		</div>
	);
}

function shrink(rect: Rect, by: number): Rect {
	return { x: rect.x + by, y: rect.y + by, w: Math.max(0, rect.w - by * 2), h: Math.max(0, rect.h - by * 2) };
}

function TileView({
	tile,
	summary,
	hoverAgent,
	selected,
	onClick,
}: {
	tile: Tile;
	summary: Summary;
	hoverAgent: number | null;
	selected: boolean;
	onClick: () => void;
}) {
	const { t } = useTranslation("components1");
	const { zone, rect, depth, nested } = tile;
	const folder = zone.children.length > 0;
	const touched = summary.readers.size + summary.writers.size > 0;
	const agents = [...new Set([...summary.writers, ...summary.readers])].sort((a, b) => a - b);
	const dimmed =
		hoverAgent !== null && !summary.readers.has(hoverAgent) && !summary.writers.has(hoverAgent);
	const roomy = rect.w > 54 && rect.h > 18;

	return (
		<button
			type="button"
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
			title={`${zone.path}${folder ? `/ — ${t("chantierMap.files", { count: zone.files, formatted: zone.files })}` : ""}`}
			className={clsx(
				// Un bouton centre son contenu : le nom d'une zone doit rester en
				// haut, là où ses sous-zones lui laissent la place.
				"focus-ring absolute flex flex-col justify-start overflow-hidden rounded-md text-left transition-[left,top,width,height,opacity,background-color] duration-300 ease-[var(--ease-out-quart)]",
				depth % 2 === 1 ? "bg-raised" : "bg-surface",
				!touched && "text-ink-faint",
				touched && "text-ink",
				summary.collision && "ring-2 ring-critical",
				// Un anneau ne sait pas être pointillé : le contour, si.
				summary.stale && "outline-2 -outline-offset-2 outline-dashed outline-warning",
				selected && !summary.collision && "ring-2 ring-accent",
				dimmed && "opacity-25",
				"hover:brightness-95",
			)}
			style={{
				left: rect.x,
				top: rect.y,
				width: rect.w,
				height: rect.h,
				// Une zone où l'on travaille prend la teinte de qui y travaille ;
				// à plusieurs, celle de l'accent.
				background: touched
					? `color-mix(in srgb, ${agents.length === 1 ? agentColor(agents[0]) : "var(--accent)"} ${nested ? 8 : 18}%, var(--${depth % 2 === 1 ? "raised" : "surface"}))`
					: undefined,
			}}
		>
			{roomy ? (
				<span
					className={clsx(
						"flex items-center gap-1 truncate px-1.5",
						nested || depth === 1 ? "h-5 shrink-0 text-[11px] font-semibold" : "pt-1 text-[10px]",
					)}
				>
					{folder ? (
						<Folder size={10} className="shrink-0 opacity-60" />
					) : depth === 1 ? (
						<FileText size={11} className="shrink-0 opacity-60" />
					) : null}
					<span className={clsx("truncate", !folder && "font-mono")}>{tile.label}</span>
					{summary.collision ? <GitMerge size={10} className="shrink-0 text-critical" /> : null}
					{!summary.collision && summary.stale ? <Clock size={10} className="shrink-0 text-warning" /> : null}
					{/* Un dossier ouvert sur ses sous-zones dit dans son en-tête qui
					    est passé par là : un trait en bas se lirait comme celui de
					    la dernière sous-zone. */}
					{nested && touched ? (
						<span className="ml-auto flex shrink-0 gap-0.5 pl-1">
							{agents.map((index) => (
								<span key={index} className="size-1.5 rounded-full" style={{ background: agentColor(index) }} />
							))}
						</span>
					) : null}
				</span>
			) : null}
			{/* Qui est passé ici : un trait par agent, épais s'il a écrit. */}
			{touched && !nested && rect.h > 10 ? (
				<span className="absolute right-1 bottom-1 left-1 flex gap-0.5">
					{agents.map((index) => (
						<span
							key={index}
							className={clsx("min-w-1 flex-1 rounded-full", summary.writers.has(index) ? "h-1.5" : "h-1 opacity-60")}
							style={{ background: agentColor(index) }}
						/>
					))}
				</span>
			) : null}
		</button>
	);
}

// ───────────────────────────── Sélection ─────────────────────────────

function SelectionCard({
	cwd,
	runs,
	selection,
	mark,
	onClose,
	onOpen,
}: {
	cwd: string;
	runs: AgentRun[];
	selection: { path: string; file: boolean };
	mark: FileMark | null;
	onClose: () => void;
	onOpen: (path: string) => void;
}) {
	const { t } = useTranslation("components1");
	const actions = useAgentActions();
	const [text, setText] = useState("");
	const [target, setTarget] = useState<string>(runs[0]?.id ?? "new");
	useEffect(() => setText(""), [selection.path]);

	const absolute = `${cwd.replace(/\/$/, "")}/${selection.path}`;
	const anchor = selection.file ? `\`${selection.path}\`` : `\`${selection.path}/\``;
	// Ce que chaque agent a fait de ce fichier.
	const rows = runs
		.map((run, index) => {
			const touches = touchesOf(run).filter(
				(touch) =>
					touch.path === absolute || (!selection.file && touch.path.startsWith(`${absolute}/`)),
			);
			const reads = touches.filter((touch) => touch.kind === "read");
			const writes = touches.filter((touch) => touch.kind === "write");
			const latest = (list: typeof touches) => Math.max(0, ...list.map((touch) => touch.at ?? 0)) || null;
			const lastRead = latest(reads);
			const lastWrite = latest(writes);
			const known = knowledgeOf(run).get(absolute);
			return { run, index, reads: reads.length, writes: writes.length, lastRead, lastWrite, blurred: known?.blurred ?? false };
		})
		.filter((row) => row.reads + row.writes > 0);

	const submit = (later: boolean) => {
		if (!text.trim()) return;
		if (target === "new") {
			actions.open(
				cwd,
				`Your scope: \`${selection.path}${selection.file ? "" : "/"}\`. Don't modify anything outside it without asking me.\n\n${text.trim()}`,
				undefined,
				undefined,
				true,
			);
		} else if (later) {
			addRemark(target, anchor, text);
		} else {
			actions.send(target, composeRemarks([{ id: "", runId: target, anchor, text: text.trim(), at: Date.now() }]));
		}
		setText("");
	};

	return (
		<div className="animate-in shrink-0 rounded-[var(--radius-panel)] bg-surface p-3 shadow-[var(--shadow-pop)] ring-2 ring-accent/40">
			<div className="flex items-start gap-2">
				{selection.file ? (
					<FileText size={14} className="mt-0.5 shrink-0 text-ink-muted" />
				) : (
					<Folder size={14} className="mt-0.5 shrink-0 text-ink-muted" />
				)}
				<div className="min-w-0 flex-1">
					<p className="truncate font-mono text-[12px] text-ink" title={selection.path}>
						{selection.path}
						{selection.file ? "" : "/"}
					</p>
					{mark?.collision ? (
						<p className="mt-0.5 text-[11px] text-critical">{t("chantierMap.selection.multipleWriters")}</p>
					) : null}
				</div>
				{selection.file ? (
					<Button size="sm" icon={ArrowUpRight} onClick={() => onOpen(selection.path)} title={t("chantierMap.selection.openFile")} />
				) : null}
				<Button size="sm" icon={X} onClick={onClose} title={t("chantierMap.close")} />
			</div>

			{rows.length > 0 ? (
				<ul className="mt-2 space-y-1">
					{rows.map((row) => (
						<li key={row.run.id} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
							<span className="size-2 shrink-0 rounded-full" style={{ background: agentColor(row.index) }} />
							<span className="truncate font-medium text-ink">{row.run.label}</span>
							<span className="ml-auto shrink-0">
								{row.writes > 0
									? t("chantierMap.selection.wrote", { ago: ago(row.lastWrite) })
									: t("chantierMap.selection.read", { ago: ago(row.lastRead) })}
								{row.blurred ? ` · ${t("chantierMap.selection.summarized")}` : ""}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="mt-2 text-[11px] text-ink-faint">{t("chantierMap.selection.untouched")}</p>
			)}
			{mark?.stale.map((entry) => (
				<p key={entry.runId} className="mt-1.5 flex items-start gap-1.5 text-[11px] text-warning">
					<Clock size={11} className="mt-0.5 shrink-0" />
					<span>
						{entry.by
							? t("chantierMap.selection.staleBy", {
									agent: runs.find((run) => run.id === entry.runId)?.label ?? "",
									ago: ago(entry.knownAt),
									by: entry.by.label,
								})
							: t("chantierMap.selection.stale", {
									agent: runs.find((run) => run.id === entry.runId)?.label ?? "",
									ago: ago(entry.knownAt),
								})}
					</span>
				</p>
			))}

			<div className="mt-3 rounded-lg bg-raised p-2">
				<div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
					<span className="shrink-0">{t("chantierMap.selection.for")}</span>
					<select
						value={target}
						onChange={(event) => setTarget(event.target.value)}
						className="focus-ring min-w-0 flex-1 truncate rounded bg-surface px-1.5 py-0.5 text-[11px] text-ink"
					>
						{runs.map((run) => (
							<option key={run.id} value={run.id}>
								{run.label}
							</option>
						))}
						<option value="new">{t("chantierMap.selection.newAgent")}</option>
					</select>
				</div>
				<textarea
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(false);
					}}
					rows={2}
					placeholder={
						target === "new"
							? t("chantierMap.selection.newAgentPlaceholder")
							: t("chantierMap.selection.remarkPlaceholder")
					}
					className="focus-ring mt-1.5 w-full resize-none rounded-md bg-surface px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-faint"
				/>
				<div className="mt-1.5 flex justify-end gap-1">
					{target !== "new" ? (
						<Button size="sm" onClick={() => submit(true)} disabled={!text.trim()} title={t("chantierMap.selection.laterHint")}>
							{t("chantierMap.selection.later")}
						</Button>
					) : null}
					<Button size="sm" variant="solid" icon={target === "new" ? Rocket : Send} onClick={() => submit(false)} disabled={!text.trim()}>
						{target === "new" ? t("chantierMap.selection.launch") : t("chantierMap.send")}
					</Button>
				</div>
			</div>
		</div>
	);
}

// ───────────────────────────── Agents ─────────────────────────────

function AgentCard({
	run,
	index,
	cwd,
	stale,
	remarks,
	highlighted,
	onHover,
	onReveal,
	onWarn,
}: {
	run: AgentRun;
	index: number;
	cwd: string;
	stale: Stale[];
	remarks: Remark[];
	highlighted: boolean;
	onHover: (value: boolean) => void;
	onReveal: (path: string) => void;
	onWarn: (entries: Stale[]) => void;
}) {
	const { t } = useTranslation("components1");
	const actions = useAgentActions();
	const state = agentState(run, t);
	const known = useMemo(() => knowledgeOf(run), [run]);
	const writes = useMemo(
		() => new Set(touchesOf(run).filter((touch) => touch.kind === "write").map((touch) => touch.path)).size,
		[run],
	);

	return (
		<article
			onMouseEnter={() => onHover(true)}
			onMouseLeave={() => onHover(false)}
			className={clsx(
				"rounded-[var(--radius-panel)] bg-surface p-3 shadow-[var(--shadow-card)] transition-shadow",
				highlighted && "outline outline-2",
			)}
			style={highlighted ? { outlineColor: agentColor(index) } : undefined}
		>
			<header className="flex items-center gap-2">
				<span className="size-2.5 shrink-0 rounded-full" style={{ background: agentColor(index) }} />
				<button
					type="button"
					onClick={() => actions.show(run.id)}
					className="focus-ring min-w-0 flex-1 truncate rounded text-left text-[12.5px] font-semibold text-ink hover:underline"
					title={t("chantierMap.agent.openConversation")}
				>
					{run.label}
				</button>
				<span className={clsx("shrink-0 text-[10.5px] font-medium", state.tone)}>{state.label}</span>
			</header>

			<ContextGauge run={run} />

			<p className="mt-2 text-[11px] text-ink-muted">
				{t("chantierMap.agent.known", { count: known.size })} · {t("chantierMap.agent.writes", { count: writes })}
			</p>

			{stale.length > 0 ? (
				<div className="mt-2 rounded-lg bg-warning/8 p-2">
					<p className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
						<AlertTriangle size={11} />
						{t("chantierMap.agent.stale", { count: stale.length })}
					</p>
					<ul className="mt-1 space-y-0.5">
						{stale.slice(0, 4).map((entry) => (
							<li key={entry.path}>
								<button
									type="button"
									onClick={() => onReveal(entry.path)}
									className="focus-ring flex w-full items-center gap-1 rounded text-left text-[10.5px] text-ink-muted hover:text-ink"
									title={entry.path}
								>
									<span className="truncate font-mono">{relativeTo(cwd, entry.path) ?? entry.path}</span>
									<span className="ml-auto shrink-0 text-ink-faint">
										{entry.modifiedAt === null ? t("chantierMap.agent.deleted") : entry.by ? entry.by.label : t("chantierMap.agent.outsideAgents")}
									</span>
								</button>
							</li>
						))}
					</ul>
					<Button size="sm" variant="warning" icon={Send} onClick={() => onWarn(stale)} className="mt-1 -ml-1">
						{t("chantierMap.alerts.warnAgent")}
					</Button>
				</div>
			) : null}

			{remarks.length > 0 ? <RemarkTray runId={run.id} remarks={remarks} /> : null}
		</article>
	);
}

/** Les remarques en attente pour un agent, envoyées ensemble. */
export function RemarkTray({
	runId,
	remarks,
	className,
}: {
	runId: string;
	remarks: Remark[];
	className?: string;
}) {
	const { t } = useTranslation("components1");
	const actions = useAgentActions();
	return (
		<div className={clsx("rounded-lg bg-accent-dim/60 p-2", className ?? "mt-2")}>
			<p className="flex items-center gap-1.5 text-[11px] font-medium text-accent-soft">
				<MessageSquarePlus size={11} />
				{t("chantierMap.remarks.pending", { count: remarks.length })}
			</p>
			<ul className="mt-1 space-y-0.5">
				{remarks.map((remark) => (
					<li key={remark.id} className="group flex items-start gap-1 text-[10.5px] text-ink-muted">
						<span className="min-w-0 flex-1">
							<span className="font-mono text-ink-faint">{remark.anchor}</span> — {remark.text}
						</span>
						<button
							type="button"
							onClick={() => removeRemark(remark.id)}
							className="focus-ring shrink-0 rounded opacity-0 group-hover:opacity-100 hover:text-critical"
							title={t("chantierMap.remarks.remove")}
						>
							<X size={10} />
						</button>
					</li>
				))}
			</ul>
			<div className="mt-1 flex gap-1">
				<Button
					size="sm"
					variant="solid"
					icon={Send}
					onClick={() => {
						actions.send(runId, composeRemarks(remarks));
						clearRemarks(runId);
					}}
				>
					{t("chantierMap.send")}
				</Button>
				<Button size="sm" onClick={() => clearRemarks(runId)}>
					{t("chantierMap.remarks.discard")}
				</Button>
			</div>
		</div>
	);
}

/**
 * De quoi est rempli le contexte d'un agent.
 *
 * La barre est à l'échelle de la fenêtre entière : sa partie vide est ce qui
 * reste. Le trait marque où le CLI compactera de lui-même — au-delà, l'agent
 * oubliera le détail de ce qu'il a lu.
 */
export function ContextGauge({ run, compact = false }: { run: AgentRun; compact?: boolean }) {
	const { t } = useTranslation("components1");
	const [open, setOpen] = useState(false);
	const usage = run.usage;
	const compactedAt = lastCompaction(run.turns);

	if (!usage) {
		const window = run.contextWindow;
		return (
			<div className={clsx(compact ? "" : "mt-2.5")}>
				<div className="h-2 overflow-hidden rounded-full bg-raised">
					{window && run.contextTokens > 0 ? (
						<div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.min(100, (run.contextTokens / window) * 100)}%` }} />
					) : null}
				</div>
				<p className="mt-1 text-[10.5px] text-ink-faint">
					{run.noUsage
						? t("chantierMap.context.noDetail")
						: run.contextTokens > 0
							? window
								? t("chantierMap.context.pendingOfWindow", {
										tokens: compactNumber(run.contextTokens),
										window: compactNumber(window),
									})
								: t("chantierMap.context.pending", { tokens: compactNumber(run.contextTokens) })
							: t("chantierMap.context.notMeasured")}
				</p>
			</div>
		);
	}

	const parts = slices(usage);
	const threshold = compactAt(usage);
	const used = parts.reduce((sum, part) => sum + part.tokens, 0);
	const heavy = [...(usage.messages?.toolCallsByType ?? [])]
		.sort((a, b) => b.resultTokens + b.callTokens - (a.resultTokens + a.callTokens))
		.slice(0, 3);

	return (
		<div className={clsx(compact ? "" : "mt-2.5")}>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="focus-ring block w-full rounded text-left"
				title={t("chantierMap.context.detail")}
			>
				<div className="relative flex h-2 overflow-hidden rounded-full bg-raised">
					{parts.map((part) => (
						<div
							key={part.key}
							className="h-full transition-[width] duration-500"
							style={{ width: `${(part.tokens / usage.maxTokens) * 100}%`, background: part.color }}
							title={t("chantierMap.context.partTitle", { label: part.label, tokens: compactNumber(part.tokens) })}
						/>
					))}
					{threshold ? (
						<span className="absolute top-0 bottom-0 w-px bg-ink-muted" style={{ left: `${threshold * 100}%` }} />
					) : null}
				</div>
				<p className="mt-1 flex items-center gap-1 text-[10.5px] text-ink-muted">
					<span className="font-mono text-ink">{compactNumber(usage.totalTokens || used)}</span>
					<span>{t("chantierMap.context.ofMax", { max: compactNumber(usage.maxTokens) })}</span>
					<span className="text-ink-faint">· {t("chantierMap.context.percent", { percent: usage.percentage })}</span>
					{compactedAt ? (
						<span className="ml-auto text-ink-faint" title={t("chantierMap.context.compactedHint")}>
							{t("chantierMap.context.compacted", { ago: ago(compactedAt) })}
						</span>
					) : null}
				</p>
			</button>
			{open ? (
				<div className="mt-1.5 space-y-1.5 rounded-lg bg-raised p-2 text-[10.5px] text-ink-muted">
					<ul className="space-y-0.5">
						{parts.map((part) => (
							<li key={part.key} className="flex items-center gap-1.5">
								<span className="size-2 shrink-0 rounded-sm" style={{ background: part.color }} />
								{part.label}
								<span className="ml-auto font-mono text-ink">{compactNumber(part.tokens)}</span>
							</li>
						))}
					</ul>
					{heavy.length > 0 ? (
						<p>
							{t("chantierMap.context.heavy", {
								list: heavy.map((tool) => `${tool.name} ${compactNumber(tool.resultTokens + tool.callTokens)}`).join(" · "),
							})}
						</p>
					) : null}
					{usage.memoryFiles && usage.memoryFiles.length > 0 ? (
						<p className="truncate" title={usage.memoryFiles.map((file) => file.path).join("\n")}>
							{t("chantierMap.context.memory", { list: usage.memoryFiles.map((file) => basename(file.path)).join(", ") })}
						</p>
					) : null}
					{usage.mcpServers.length > 0 ? (
						<p>
							{t("chantierMap.context.mcp", {
								list: usage.mcpServers
									.map((server) =>
										t("chantierMap.context.mcpServer", {
											name: server.name,
											loaded: server.loaded,
											deferred: server.deferred,
										}),
									)
									.join(" · "),
							})}
						</p>
					) : null}
					{threshold ? (
						<p className="text-ink-faint">
							{t("chantierMap.context.autoCompact", { percent: Math.round(threshold * 100) })}
						</p>
					) : null}
					<p className="text-ink-faint">{t("chantierMap.context.countedAt", { ago: ago(usage.at) })}</p>
				</div>
			) : null}
		</div>
	);
}
