import { isLibreRun, useLibres } from "@/lib/libre";
import {
	Background,
	BackgroundVariant,
	Controls,
	Handle,
	MiniMap,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	useStore,
	type Edge,
	type Node,
	type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import {
	ArrowUpRight,
	Bot,
	ChevronRight,
	GitMerge,
	GitPullRequest,
	ListChecks,
	Map as MapIcon,
	ScanSearch,
	Rocket,
	Ticket,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReadinessCard } from "@/components/ReadinessCard";
import { t as translate } from "@/i18n";
import { useBlockers, type Blocker } from "@/app/blockers";
import { useAgentRuns, type AgentRun } from "@/app/agents";
import { useCockpit } from "@/app/store";
import { useWorkspace } from "@/app/workspace";
import { PrActions, TicketActions } from "@/components/actions";
import { ChantierMap } from "@/components/ChantierMap";
import { Button, LoadingBar } from "@/components/ui";
import { useWorkGroups, type WorkGroup } from "@/components/WorkspacePanel";
import { agentColor, collisions } from "@/lib/chantier";
import { useNodeSizes } from "@/lib/flowSizes";
import { fromIso, fromSeconds } from "@/lib/format";
import { api } from "@/lib/ipc";
import { awaitsHuman, MISSION_STATE_LABELS } from "@/lib/missions";
import type { FeedItem, Mission, ProjectView, PullRequest, Review } from "@/lib/types";
import { movedSince, useReviewFlow, useReviews } from "@/app/review";
import { useAsync } from "@/lib/useAsync";
import {
	links,
	place,
	REGIONS,
	ticketsIn,
	type Box,
	type CardKind,
	type IslandInput,
	type LinkKeys,
	type RegionId,
	type WorldCard,
} from "@/lib/world";
import { basename } from "@/lib/paths";

/**
 * La carte : tout le travail, sur un seul plan.
 *
 * Les écrans du rail découpent le travail par outil — tickets ici, PR là,
 * agents ailleurs — et laissent au lecteur le soin de recoudre. La carte le
 * montre d'un tenant : chaque projet est une île ; dans celle du projet ouvert,
 * le travail se range dans le sens où il avance (il arrive, on le fait, on le
 * livre, il tourne en prod), et des fils relient un ticket à la mission qui le
 * traite, au chantier où elle travaille, à la PR qui en sort.
 *
 * On s'y déplace par altitudes : tous les projets, un projet, une région, un
 * chantier. De loin, les cartes s'effacent derrière leurs chiffres ; de près,
 * elles portent leurs gestes. Ce qui t'attend reste épinglé en haut, où que
 * l'on regarde.
 *
 * Les îles des autres projets ne montrent que ce qu'on sait sans changer de
 * projet — agents vivants, missions. Y descendre ouvre ce projet, et son
 * détail se charge.
 */

type Altitude = { level: "world" } | { level: "island" } | { level: "region"; region: RegionId };

interface CardData extends Record<string, unknown> {
	kind: CardKind;
	payload: CardPayload;
	live?: boolean;
}

type CardPayload =
	| { kind: "ticket"; item: FeedItem; taken: boolean }
	| { kind: "mission"; mission: Mission }
	| { kind: "chantier"; group: WorkGroup }
	| { kind: "pr"; pr: PullRequest; mine: boolean; review: Review | null }
	| { kind: "deploy"; item: FeedItem }
	| { kind: "more"; label: string; view: Parameters<ReturnType<typeof useCockpit>["go"]>[0] };

/** Ce qu'une île repliée résume : ce qu'on sait sans ouvrir son projet. */
interface IslandPulse {
	agents: number;
	working: number;
	missions: number;
	awaiting: number;
}

/** Les gestes que les nœuds déclenchent, tenus hors de leurs données. */
interface MapActions {
	openChantier: (cwd: string) => void;
	openProject: (id: string) => void;
	goRegion: (region: RegionId) => void;
}

const ActionsContext = createContext<MapActions | null>(null);
function useMapActions(): MapActions {
	const actions = useContext(ActionsContext);
	if (!actions) throw new Error("useMapActions hors de la carte");
	return actions;
}

/**
 * Le niveau de détail que permet le zoom.
 *
 * Le sélecteur ne rend qu'une bande : les nœuds ne se redessinent qu'au
 * passage d'un seuil, pas à chaque cran de molette.
 */
type Band = "far" | "mid" | "near";
function useBand(): Band {
	return useStore((state) => {
		const zoom = state.transform[2];
		return zoom < 0.42 ? "far" : zoom < 0.56 ? "mid" : "near";
	});
}

export function MapView() {
	return (
		<ReactFlowProvider>
			<World />
		</ReactFlowProvider>
	);
}

function World() {
	const { t } = useTranslation("views");
	const { projectList, activeProject, switchProject, missions, go, config } = useCockpit();
	const { runs: all, pendingFor } = useAgentRuns();
	// Un agent libre ne relève d'aucune île : il vit dans son propre écran. Relu à
	// chaque changement du registre, que `isLibreRun` consulte sans le recevoir.
	const registry = useLibres();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const runs = useMemo(() => all.filter((run) => !isLibreRun(run)), [all, registry]);
	const groups = useWorkGroups();
	const workspace = useWorkspace();

	const prs = useAsync(() => api.git.pullRequests().catch(() => []), [activeProject?.id], {
		pollMs: 180_000,
	});
	const tickets = useAsync(() => api.feeds.linear(true).catch(() => []), [activeProject?.id], {
		pollMs: 180_000,
	});
	const deploys = useAsync(() => api.feeds.railway().catch(() => []), [activeProject?.id], {
		pollMs: 300_000,
	});
	const everywhere = useAsync(() => api.missions.everywhere().catch(() => []), [], { pollMs: 30_000 });
	// À quel dépôt appartient chaque agent, pour le compter sous son île.
	const cwds = useMemo(() => [...new Set(runs.map((run) => run.cwd))].sort(), [runs]);
	const repos = useAsync(
		(): Promise<Record<string, string>> => (cwds.length > 0 ? api.worktrees.reposOf(cwds) : Promise.resolve({})),
		[cwds.join("|")],
	);

	const blockers = useBlockers(prs.data ?? []);
	const reviews = useReviews();
	const doneStates = useMemo(() => new Set(config?.workflow.doneStates ?? []), [config?.workflow.doneStates]);

	// ── Les cartes du projet ouvert ─────────────────────────────────────
	const cards = useMemo(() => {
		const out: Array<WorldCard<CardData> & { keys: LinkKeys }> = [];
		const card = (id: string, kind: CardKind, region: RegionId, payload: CardPayload, keys: LinkKeys, live = false) =>
			out.push({ id, kind, region, data: { kind, payload, live }, keys });
		const missionTickets = new Set(missions.map((mission) => mission.ticket.toUpperCase()).filter(Boolean));
		// Les préfixes de tickets qu'on sait réels : l'équipe du projet, et ceux
		// des tickets et missions qu'on a sous les yeux.
		const prefixes = new Set(
			[
				activeProject?.linearTeamKey ?? "",
				...(tickets.data ?? []).map((item) => item.id),
				...missionTickets,
			]
				.map((value) => value.split("-")[0].toUpperCase())
				.filter(Boolean),
		);

		// Arrive : les tickets qui te sont confiés.
		const open = (tickets.data ?? []).filter((item) => !doneStates.has(item.status));
		for (const item of open.slice(0, 5)) {
			const branch = item.meta.find((field) => field.label === "branche")?.value ?? "";
			card(`ticket:${item.id}`, "ticket", "arrive", { kind: "ticket", item, taken: missionTickets.has(item.id.toUpperCase()) }, {
				tickets: [item.id.toUpperCase()],
				branches: branch ? [branch] : [],
			});
		}
		if (open.length > 5) card("more:tickets", "more", "arrive", { kind: "more", label: t("map.more.tickets", { count: open.length - 5 }), view: "today" }, { tickets: [], branches: [] });

		// En cours : les missions, puis les chantiers — ceux qu'on pilote à la main
		// comme ceux qu'une mission a ouverts.
		const recent = Date.now() - 24 * 3600_000;
		for (const mission of missions) {
			const finished = mission.finishedAt ? Date.parse(mission.finishedAt) : null;
			if ((mission.state === "done" || mission.state === "failed") && finished !== null && finished < recent) continue;
			card(`mission:${mission.id}`, "mission", "encours", { kind: "mission", mission }, {
				tickets: mission.ticket ? [mission.ticket.toUpperCase()] : [],
				branches: [mission.branch, ...mission.tasks.map((task) => task.branch)].filter(Boolean),
				mission: mission.id,
				prUrl: mission.prUrl || undefined,
			}, mission.state === "running" || mission.state === "integrating");
		}
		for (const group of groups) {
			card(`chantier:${group.cwd}`, "chantier", "encours", { kind: "chantier", group }, {
				tickets: ticketsIn(`${group.label} ${group.cwd}`, prefixes),
				branches: [group.label],
				mission: group.mission?.id,
			}, group.runs.some((run) => run.thinking));
		}

		// Livrer : tes PR d'abord, puis celles qu'on attend de toi.
		const all = prs.data ?? [];
		const local = new Set(groups.map((group) => group.label));
		const sorted = [...all].sort((a, b) => Number(local.has(b.headRef)) - Number(local.has(a.headRef)));
		for (const pr of sorted.slice(0, 6)) {
			card(`pr:${pr.number}`, "pr", "livrer", {
				kind: "pr",
				pr,
				mine: local.has(pr.headRef),
				review: reviews.find((entry) => entry.number === pr.number) ?? null,
			}, {
				tickets: [...pr.linearIds.map((id) => id.toUpperCase()), ...ticketsIn(pr.headRef, prefixes)],
				branches: [pr.headRef],
				url: pr.url,
			});
		}
		if (all.length > 6) card("more:prs", "more", "livrer", { kind: "more", label: t("map.more.prs", { count: all.length - 6 }), view: "delivery" }, { tickets: [], branches: [] });
		for (const item of (deploys.data ?? []).slice(0, 2)) {
			card(`deploy:${item.id}`, "deploy", "livrer", { kind: "deploy", item }, { tickets: [], branches: [] });
		}
		return out;
	}, [tickets.data, missions, groups, prs.data, deploys.data, doneStates, activeProject?.linearTeamKey, reviews, t]);

	// ── Les îles ────────────────────────────────────────────────────────
	const pulses = useMemo(() => {
		const table = new Map<string, IslandPulse>();
		const repoOf = (cwd: string) => (repos.data?.[cwd] ?? "").replace(/\/+$/, "");
		for (const project of projectList) {
			const root = project.mainRepo.replace(/\/+$/, "");
			const theirs = runs.filter((run) => run.running && repoOf(run.cwd) === root);
			const theirMissions = (everywhere.data ?? []).filter(
				(mission) => mission.cwd.replace(/\/+$/, "") === root && mission.state !== "done" && mission.state !== "failed",
			);
			table.set(project.id, {
				agents: theirs.length,
				working: theirs.filter((run) => run.thinking).length,
				missions: theirMissions.length,
				awaiting:
					theirMissions.filter(awaitsHuman).length +
					theirs.filter((run) => pendingFor(run.id).length > 0).length,
			});
		}
		return table;
	}, [projectList, runs, repos.data, everywhere.data, pendingFor]);

	const islands: Array<IslandInput<CardData>> = useMemo(() => {
		const list: ProjectView[] = projectList.length > 0
			? projectList
			: [{ id: "local", name: (config?.mainRepo ? basename(config.mainRepo) : undefined) ?? t("map.defaultProject") } as ProjectView];
		const activeId = activeProject?.id ?? list[0]?.id;
		return list.map((project) => ({
			id: project.id,
			name: project.name,
			open: project.id === activeId,
			cards: project.id === activeId ? cards : [],
		}));
	}, [projectList, activeProject?.id, cards, config?.mainRepo, t]);

	const placed = useMemo(() => place(islands), [islands]);
	const edges = useMemo<Edge[]>(() => {
		const live = new Set(cards.filter((card) => card.data.live).map((card) => card.id));
		return links(cards).map((link) => ({
			id: `${link.source}→${link.target}`,
			source: link.source,
			target: link.target,
			animated: live.has(link.source) || live.has(link.target),
			// Un fil vivant se voit, les autres se devinent : une carte chargée en
			// compte des dizaines, et tous au même trait faisaient une toile.
			style: {
				stroke: "var(--color-accent)",
				strokeWidth: 1.6,
				opacity: live.has(link.source) || live.has(link.target) ? 0.85 : 0.35,
			},
		}));
	}, [cards]);

	const nodes = useMemo<Node[]>(() => {
		const out: Node[] = [];
		for (const island of placed.islands) {
			const project = projectList.find((entry) => entry.id === island.id);
			out.push({
				id: `island:${island.id}`,
				type: "island",
				position: { x: island.box.x, y: island.box.y },
				width: island.box.w,
				height: island.box.h,
				zIndex: -2,
				selectable: false,
				data: {
					name: island.name,
					open: island.open,
					projectId: island.id,
					color: project?.color || "",
					pulse: pulses.get(island.id) ?? null,
					counts: island.open
						? {
								agents: runs.filter((run) => run.running && groups.some((group) => group.cwd === run.cwd)).length,
								waiting: blockers.length,
								prs: (prs.data ?? []).length,
							}
						: null,
				},
			});
		}
		for (const region of placed.regions) {
			out.push({
				id: `region:${region.island}:${region.id}`,
				type: "region",
				position: { x: region.box.x, y: region.box.y },
				width: region.box.w,
				height: region.box.h,
				zIndex: -1,
				selectable: false,
				data: { ...region, summary: regionSummary(region.id, cards) },
			});
		}
		for (const card of placed.cards) {
			out.push({
				id: card.id,
				type: "card",
				position: { x: card.box.x, y: card.box.y },
				width: card.box.w,
				height: card.box.h,
				data: card.data,
			});
		}
		return out;
	}, [placed, projectList, pulses, runs, groups, blockers.length, prs.data, cards]);

	const { onNodesChange, withSizes } = useNodeSizes<Node>();
	const sized = useMemo(() => withSizes(nodes), [nodes, withSizes]);

	// ── Les altitudes ───────────────────────────────────────────────────
	const [altitude, setAltitude] = useState<Altitude>({ level: "island" });
	const [chantier, setChantier] = useState<string | null>(null);
	const openIsland = placed.islands.find((island) => island.open) ?? null;
	const target: Box | null = useMemo(() => {
		if (altitude.level === "world") return placed.bounds;
		if (!openIsland) return placed.bounds;
		if (altitude.level === "island") return openIsland.box;
		return placed.regions.find((region) => region.island === openIsland.id && region.id === altitude.region)?.box ?? openIsland.box;
	}, [altitude, placed, openIsland]);

	const actions = useMemo<MapActions>(
		() => ({
			openChantier: (cwd) => setChantier(cwd),
			openProject: (id) => {
				setChantier(null);
				setAltitude({ level: "island" });
				if (id !== activeProject?.id) switchProject(id);
			},
			goRegion: (region) => setAltitude({ level: "region", region }),
		}),
		[activeProject?.id, switchProject],
	);

	const openGroup = chantier ? groups.find((group) => group.cwd === chantier) ?? null : null;
	const regionLabel = altitude.level === "region" ? REGIONS.find((entry) => entry.id === altitude.region)?.label : null;

	return (
		<ActionsContext.Provider value={actions}>
			<div className="relative flex min-h-0 flex-1 flex-col bg-base">
				<LoadingBar active={[prs, tickets, everywhere].some((source) => source.initial && source.loading)} />
				<Waiting items={blockers} />
				<ReadinessCard />
				<div className="mission-graph relative min-h-0 flex-1">
					<ReactFlow
						nodes={sized}
						edges={edges}
						onNodesChange={onNodesChange}
						nodeTypes={NODE_TYPES}
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable={false}
						// Sans gestionnaire de clic, React Flow rend des nœuds ni
						// sélectionnables ni déplaçables insensibles au pointeur : les
						// boutons des cartes ne recevaient rien. Les gestes vivent
						// dans les cartes elles-mêmes ; celui-ci ne sert qu'à les
						// rendre cliquables.
						onNodeClick={() => undefined}
						panOnScroll
						minZoom={0.06}
						maxZoom={1.6}
						proOptions={{ hideAttribution: true }}
						// Un nœud mesuré dessine les fils : rien ne sert de les tracer
						// avant, ils partiraient d'un point zéro.
						onlyRenderVisibleElements={false}
					>
						<Background variant={BackgroundVariant.Dots} gap={22} size={1.3} />
						<Camera target={target} signature={`${altitude.level}:${"region" in altitude ? altitude.region : ""}:${activeProject?.id ?? ""}`} />
						<MiniMap
							pannable
							zoomable
							position="bottom-right"
							className="!rounded-xl !bg-surface !shadow-[var(--shadow-pop)]"
							nodeColor={(node) =>
								node.type === "island"
									? "var(--color-raised)"
									: node.type === "region"
										? "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))"
										: "var(--color-accent)"
							}
							nodeStrokeWidth={0}
							bgColor="var(--color-surface)"
							maskColor="color-mix(in srgb, var(--color-void) 55%, transparent)"
						/>
						<Controls position="bottom-left" showInteractive={false} />
					</ReactFlow>

					{/* Où l'on est, et de quoi remonter : c'est aussi la navigation. */}
					<nav className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-xl bg-raised p-1 shadow-[var(--shadow-pop)]">
						<Crumb current={altitude.level === "world" && !chantier} onClick={() => { setChantier(null); setAltitude({ level: "world" }); }}>
							<MapIcon size={12} /> {t("map.allProjects")}
						</Crumb>
						{openIsland ? (
							<>
								<ChevronRight size={12} className="text-ink-faint" />
								<Crumb current={altitude.level === "island" && !chantier} onClick={() => { setChantier(null); setAltitude({ level: "island" }); }}>
									{openIsland.name}
								</Crumb>
							</>
						) : null}
						{regionLabel && altitude.level === "region" ? (
							<>
								<ChevronRight size={12} className="text-ink-faint" />
								<Crumb current={!chantier} onClick={() => setChantier(null)}>
									{regionLabel}
								</Crumb>
							</>
						) : null}
						{openGroup ? (
							<>
								<ChevronRight size={12} className="text-ink-faint" />
								<Crumb current onClick={() => undefined}>
									<span className="font-mono">{openGroup.label}</span>
								</Crumb>
							</>
						) : null}
					</nav>

					{/* Le chantier s'ouvre sur place : la carte reste derrière, on y
					    revient d'un clic sans avoir changé d'écran. */}
					<AnimatePresence>
						{openGroup ? (
							<motion.section
								key={openGroup.cwd}
								initial={{ opacity: 0, y: 16, scale: 0.985 }}
								animate={{ opacity: 1, y: 0, scale: 1 }}
								exit={{ opacity: 0, y: 12 }}
								transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
								className="absolute inset-x-4 top-3 bottom-16 z-20 flex flex-col overflow-hidden rounded-[var(--radius-panel)] bg-base shadow-[var(--shadow-pop)]"
							>
								<header className="hairline-b flex items-center gap-2 bg-surface px-3 py-2">
									<span className="text-[12.5px] font-semibold text-ink">{openGroup.mission?.role ?? t("map.chantier")}</span>
									<span className="font-mono text-[11px] text-ink-faint">{openGroup.label}</span>
									<span className="ml-auto" />
									<Button
										size="sm"
										icon={ArrowUpRight}
										onClick={() => {
											workspace.showGroup(openGroup.cwd);
											go("workspace");
										}}
									>
										{t("map.openWorkspace")}
									</Button>
									<Button size="sm" icon={X} onClick={() => setChantier(null)} title={t("map.backToMap")} />
								</header>
								<ChantierMap cwd={openGroup.cwd} runs={openGroup.runs} active />
							</motion.section>
						) : null}
					</AnimatePresence>
				</div>
			</div>
		</ActionsContext.Provider>
	);
}

/** Ce qu'une région dit d'elle-même vue de loin : un chiffre, et ce qui presse. */
function regionSummary(region: RegionId, cards: Array<WorldCard<CardData>>): { big: string; alert: string | null } {
	const mine = cards.filter((card) => card.region === region && card.kind !== "more");
	const count = (kind: CardKind) => mine.filter((card) => card.kind === kind).length;
	switch (region) {
		case "arrive":
			return {
				big: translate("views:map.summary.tickets", { count: count("ticket") }),
				alert: null,
			};
		case "encours": {
			const agents = mine
				.filter((card) => card.data.payload.kind === "chantier")
				.reduce((sum, card) => sum + (card.data.payload.kind === "chantier" ? card.data.payload.group.runs.length : 0), 0);
			const clashes = mine.reduce(
				(sum, card) => sum + (card.data.payload.kind === "chantier" ? collisions(card.data.payload.group.runs).length : 0),
				0,
			);
			return {
				big: translate("views:map.summary.agents", { count: agents }),
				alert:
					clashes > 0
						? translate("views:map.summary.collisions", { count: clashes })
						: `${translate("views:map.summary.missions", { count: count("mission") })} · ${translate("views:map.summary.chantiers", { count: count("chantier") })}`,
			};
		}
		case "livrer": {
			const red = mine.filter((card) => card.data.payload.kind === "pr" && card.data.payload.pr.ciState === "failing").length;
			return {
				big: translate("views:map.summary.prs", { count: count("pr") }),
				alert: red > 0 ? translate("views:map.summary.redCi", { count: red }) : null,
			};
		}
	}
}

// ───────────────────────────── Caméra ─────────────────────────────

/**
 * Cadre l'altitude choisie, et seulement quand elle change.
 *
 * Recadrer à chaque rafraîchissement des données arracherait la vue à qui la
 * déplace ; on ne bouge la caméra que sur un geste — une altitude, un projet
 * qu'on ouvre — ou quand l'île vient d'apparaître.
 */
function Camera({ target, signature }: { target: Box | null; signature: string }) {
	const flow = useReactFlow();
	const framed = useRef<string | null>(null);
	const ready = target !== null && target.w > 0;
	useEffect(() => {
		if (!ready || !target || framed.current === signature) return;
		// Le premier cadrage se fait sans animation : l'écran s'ouvre déjà en
		// place, plutôt que de voler depuis l'origine.
		const first = framed.current === null;
		framed.current = signature;
		void flow.fitBounds(
			{ x: target.x, y: target.y, width: target.w, height: target.h },
			{ padding: 0.06, duration: first ? 0 : 650 },
		);
	}, [flow, signature, ready, target]);
	return null;
}

function Crumb({ current, onClick, children }: { current: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={clsx(
				"focus-ring flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors",
				current ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-ink-muted hover:text-ink",
			)}
		>
			{children}
		</button>
	);
}

// ───────────────────────────── Ce qui t'attend ─────────────────────────────

const TONE = {
	critical: "bg-critical/10 text-critical",
	warning: "bg-warning/12 text-warning",
	accent: "bg-accent-dim text-accent-soft",
} as const;

/** Épinglé au-dessus de la carte : ce qui arrête une machine, où que l'on regarde. */
function Waiting({ items }: { items: Blocker[] }) {
	const { t } = useTranslation("views");
	if (items.length === 0) return null;
	return (
		<div className="hairline-b flex shrink-0 items-center gap-2 overflow-x-auto bg-surface px-3 py-2">
			<span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">{t("map.waiting")}</span>
			{items.slice(0, 6).map((item) => (
				// La croix vit à côté de la puce, pas dedans : un bouton dans un
				// bouton est du HTML invalide.
				<div
					key={item.key}
					className={clsx("flex h-7 max-w-80 shrink-0 items-center rounded-lg text-[11.5px] font-medium", TONE[item.tone])}
				>
					<button
						type="button"
						onClick={item.onClick}
						title={`${item.title}\n${item.detail}`}
						className="focus-ring flex h-full min-w-0 items-center gap-1.5 rounded-lg pr-1 pl-2.5"
					>
						<item.icon size={12} className="shrink-0" />
						<span className="truncate">{item.title}</span>
						{item.meta ? <span className="shrink-0 font-mono text-[10px] opacity-80">{item.meta}</span> : null}
					</button>
					<button
						type="button"
						onClick={item.dismiss}
						title={t("map.waitingDismiss")}
						aria-label={t("map.waitingDismiss")}
						className="focus-ring mr-1 grid size-5 shrink-0 place-items-center rounded-md opacity-60 hover:bg-hover hover:opacity-100"
					>
						<X size={11} />
					</button>
				</div>
			))}
			{items.length > 6 ? <span className="shrink-0 text-[11px] text-ink-faint">+ {items.length - 6}</span> : null}
		</div>
	);
}

// ───────────────────────────── Nœuds ─────────────────────────────

interface IslandData extends Record<string, unknown> {
	name: string;
	open: boolean;
	projectId: string;
	color: string;
	pulse: IslandPulse | null;
	counts: { agents: number; waiting: number; prs: number } | null;
}

function IslandNode({ data }: NodeProps<Node<IslandData>>) {
	const band = useBand();
	const { t } = useTranslation("views");
	const { openProject } = useMapActions();
	const tint = data.color ? `#${data.color.replace(/^#/, "")}` : "var(--color-accent)";

	if (!data.open) {
		const pulse = data.pulse;
		return (
			<button
				type="button"
				onClick={() => openProject(data.projectId)}
				// Une île repliée se lit surtout de haut : ses lettres sont faites pour
				// le zoom de la vue d'ensemble, pas pour le sien.
				className="focus-ring flex h-full w-full flex-col items-start justify-between rounded-[40px] bg-surface/70 p-10 text-left shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-pop)]"
				title={t("map.island.open", { name: data.name })}
			>
				<span className="flex items-center gap-3 text-[52px] leading-none font-bold tracking-tight text-ink">
					<span className="size-5 rounded-full" style={{ background: tint }} />
					{data.name}
				</span>
				<span className="flex flex-col gap-2 text-[30px] text-ink-muted">
					{pulse && pulse.agents + pulse.missions > 0 ? (
						<>
							<span>
								<span className="font-mono text-ink">{pulse.agents}</span>{" "}
								{t("map.island.agentsWord", { count: pulse.agents })}
								{pulse.working > 0 ? (
									<span className="text-success"> · {t("map.island.working", { count: pulse.working })}</span>
								) : null}
							</span>
							<span>
								<span className="font-mono text-ink">{pulse.missions}</span>{" "}
								{t("map.island.missionsWord", { count: pulse.missions })}
							</span>
							{pulse.awaiting > 0 ? <span className="font-semibold text-warning">{t("map.island.awaiting", { count: pulse.awaiting })}</span> : null}
						</>
					) : (
						<span>{t("map.island.calm")}</span>
					)}
				</span>
				<span className="text-[22px] font-medium text-accent-soft">{t("map.island.openProject")}</span>
			</button>
		);
	}

	return (
		<div className="relative h-full w-full rounded-[40px] bg-surface/55 shadow-[0_0_0_1px_rgba(20,30,40,0.05)]">
			<div
				className={clsx("absolute top-5 left-9 flex items-center gap-2.5 text-[30px] font-bold tracking-tight text-ink transition-opacity", band === "far" && "opacity-0")}
			>
				<span className="size-3 rounded-full" style={{ background: tint }} />
				{data.name}
			</div>
			{/* Vu de très haut, l'île ne dit que l'essentiel — en grand. */}
			<div
				className={clsx(
					"pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-6 text-center transition-opacity duration-300",
					band === "far" ? "opacity-100" : "opacity-0",
				)}
			>
				<span className="text-[190px] leading-none font-bold tracking-tight text-ink">{data.name}</span>
				{data.counts ? (
					<span className="font-mono text-[90px] text-accent">
						{t("map.summary.agents", { count: data.counts.agents })} · {t("map.summary.prs", { count: data.counts.prs })}
					</span>
				) : null}
				{data.counts && data.counts.waiting > 0 ? (
					<span className="text-[80px] font-semibold text-warning">
						{t("map.island.thingsWaiting", { count: data.counts.waiting })}
					</span>
				) : null}
			</div>
		</div>
	);
}

interface RegionData extends Record<string, unknown> {
	id: RegionId;
	label: string;
	hint: string;
	count: number;
	summary: { big: string; alert: string | null };
}

function RegionNode({ data }: NodeProps<Node<RegionData>>) {
	const band = useBand();
	const { t } = useTranslation("views");
	const { goRegion } = useMapActions();
	const live = data.id === "encours";
	return (
		<div
			className={clsx(
				"relative h-full w-full rounded-[26px] border-[1.5px] border-dashed transition-opacity",
				live ? "border-accent/35 bg-accent-dim/40" : "border-line bg-surface/50",
				band === "far" && "opacity-0",
			)}
		>
			<button
				type="button"
				onClick={() => goRegion(data.id)}
				className="focus-ring absolute top-3.5 left-4 flex items-baseline gap-2 rounded text-left"
				title={t("map.region.frame")}
			>
				<span className={clsx("text-[13px] font-semibold tracking-[0.02em] uppercase", live ? "text-accent" : "text-ink-muted")}>{data.label}</span>
				<span className="text-[12px] text-ink-faint">{data.hint}</span>
			</button>
			<div
				className={clsx(
					"pointer-events-none absolute inset-x-0 top-1/3 flex flex-col items-center gap-3 text-center transition-opacity duration-300",
					band === "mid" ? "opacity-100" : "opacity-0",
				)}
			>
				<span className="font-mono text-[64px] leading-none font-medium text-ink">{data.summary.big}</span>
				{data.summary.alert ? <span className="text-[28px] font-semibold text-warning">{data.summary.alert}</span> : null}
			</div>
			{data.count === 0 ? (
				<p className="absolute inset-x-6 top-20 text-center text-[12px] leading-relaxed text-ink-faint">
					{t(`map.region.empty.${data.id}`)}
				</p>
			) : null}
		</div>
	);
}

function CardNode({ data }: NodeProps<Node<CardData>>) {
	const { t } = useTranslation("views");
	const band = useBand();
	const payload = data.payload;
	return (
		<div
			className={clsx(
				"relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-card)] transition-opacity duration-300",
				band === "far" && "opacity-10",
				band === "mid" && "opacity-20",
				data.live && "ring-2 ring-accent/50",
			)}
		>
			<Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-line" />
			{payload.kind === "ticket" ? <TicketCard item={payload.item} taken={payload.taken} /> : null}
			{payload.kind === "mission" ? <MissionCard mission={payload.mission} /> : null}
			{payload.kind === "chantier" ? <ChantierCard group={payload.group} /> : null}
			{payload.kind === "pr" ? <PrCard pr={payload.pr} mine={payload.mine} review={payload.review} /> : null}
			{payload.kind === "deploy" ? <FeedCard item={payload.item} icon={Rocket} eyebrow={t("map.card.deploy")} /> : null}
			{payload.kind === "more" ? <MoreCard label={payload.label} view={payload.view} /> : null}
			<Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-line" />
		</div>
	);
}

const NODE_TYPES = { island: IslandNode, region: RegionNode, card: CardNode };

function Eyebrow({ children, tone }: { children: React.ReactNode; tone?: string }) {
	return (
		<span className={clsx("truncate font-mono text-[10px] tracking-[0.08em] uppercase", tone ?? "text-ink-faint")}>{children}</span>
	);
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "accent" | "warning" | "critical" | "success" | "neutral" }) {
	const tones = {
		accent: "bg-accent-dim text-accent-soft",
		warning: "bg-warning/12 text-warning",
		critical: "bg-critical/12 text-critical",
		success: "bg-success/12 text-success",
		neutral: "bg-raised text-ink-muted",
	};
	return (
		<span className={clsx("inline-flex h-[18px] max-w-36 shrink-0 items-center truncate rounded-md px-1.5 text-[10.5px] font-semibold whitespace-nowrap", tones[tone])}>
			{children}
		</span>
	);
}

function TicketCard({ item, taken }: { item: FeedItem; taken: boolean }) {
	const { t } = useTranslation("views");
	return (
		<div className={clsx("flex h-full flex-col gap-1.5 px-3.5 py-3", taken && "opacity-70")}>
			<div className="flex items-center gap-2">
				<Ticket size={12} className="shrink-0 text-ink-faint" />
				<Eyebrow>
					{item.id} · {item.status}
				</Eyebrow>
				{taken ? <span className="ml-auto"><Pill tone="accent">{t("map.ticket.inMission")}</Pill></span> : null}
			</div>
			<button
				type="button"
				onClick={() => void api.system.openUrl(item.url).catch(() => undefined)}
				className="focus-ring line-clamp-2 rounded text-left text-[13px] leading-snug font-semibold text-ink hover:underline"
			>
				{item.title}
			</button>
			<div className="mt-auto flex items-center gap-1">
				<TicketActions identifier={item.id} title={item.title} url={item.url} />
			</div>
		</div>
	);
}

function FeedCard({
	item,
	icon: Icon,
	eyebrow,
}: {
	item: FeedItem;
	icon: React.ComponentType<{ size?: number; className?: string }>;
	eyebrow: string;
}) {
	const severe = item.severity === "critical";
	return (
		<button
			type="button"
			onClick={() => item.url && void api.system.openUrl(item.url).catch(() => undefined)}
			className="focus-ring flex h-full flex-col gap-1.5 px-3.5 py-3 text-left"
		>
			<span className="flex w-full items-center gap-2">
				<Icon size={12} className={clsx("shrink-0", severe ? "text-critical" : "text-ink-faint")} />
				<Eyebrow tone={severe ? "text-critical" : undefined}>{eyebrow}</Eyebrow>
				{item.status ? <span className="ml-auto truncate font-mono text-[10px] text-ink-faint">{item.status}</span> : null}
			</span>
			<span className="line-clamp-2 text-[12.5px] leading-snug font-semibold text-ink">{item.title}</span>
			<span className="mt-auto truncate font-mono text-[10.5px] text-ink-faint">
				{item.subtitle || (item.timestamp ? fromIso(item.timestamp) : "")}
			</span>
		</button>
	);
}

const TASK_TONE: Record<string, string> = {
	delivered: "bg-success/60",
	integrated: "bg-success",
	running: "bg-accent",
	failed: "bg-critical",
};

function MissionCard({ mission }: { mission: Mission }) {
	const { t } = useTranslation("views");
	const { go } = useCockpit();
	const waiting = awaitsHuman(mission);
	// Rendue : l'exécutant a livré, que le maître l'ait déjà recomposée ou non.
	const done = mission.tasks.filter((task) => task.state === "delivered" || task.state === "integrated").length;
	return (
		<button
			type="button"
			onClick={() => go("missions", { missionId: mission.id })}
			className="focus-ring flex h-full flex-col gap-1.5 px-3.5 py-3 text-left"
		>
			<span className="flex w-full items-center gap-2">
				<ListChecks size={12} className="shrink-0 text-accent" />
				<Eyebrow>
					{t("map.mission.eyebrow")}
					{mission.ticket ? ` · ${mission.ticket}` : ""}
				</Eyebrow>
				<span className="ml-auto">
					<Pill tone={waiting ? "warning" : mission.state === "failed" ? "critical" : mission.state === "done" ? "success" : "accent"}>
						{MISSION_STATE_LABELS[mission.state]}
					</Pill>
				</span>
			</span>
			<span className="line-clamp-2 text-[13px] leading-snug font-semibold text-ink">{mission.title}</span>
			{mission.tasks.length > 0 ? (
				<span className="mt-auto flex flex-col gap-1.5">
					<span className="flex gap-1">
						{mission.tasks.map((task) => (
							<span
								key={task.id}
								title={`${task.role} · ${task.title}`}
								className={clsx("h-1.5 flex-1 rounded-full", TASK_TONE[task.state] ?? "bg-raised")}
							/>
						))}
					</span>
					<span className="text-[11px] text-ink-muted">
						{t("map.mission.tasksDelivered", { count: mission.tasks.length, done })}
					</span>
				</span>
			) : (
				<span className="mt-auto text-[11px] text-ink-muted">{waiting ? t("map.mission.awaitingApproval") : t("map.mission.planning")}</span>
			)}
		</button>
	);
}

function agentLine(run: AgentRun): { label: string; tone: string } {
	if (!run.running) return { label: translate("views:map.agent.stopped"), tone: "text-ink-faint" };
	if (run.thinking) {
		return {
			label: run.activity
				? translate("views:map.agent.workingOn", { activity: run.activity })
				: translate("views:map.agent.working"),
			tone: "text-success",
		};
	}
	return { label: translate("views:map.agent.waiting"), tone: "text-info" };
}

function ChantierCard({ group }: { group: WorkGroup }) {
	const { t } = useTranslation("views");
	const { openChantier } = useMapActions();
	const clashes = collisions(group.runs).length;
	const ask = group.runs.find((run) => run.turns.find((turn) => turn.kind === "user"))?.turns.find((turn) => turn.kind === "user")?.text;
	return (
		<button
			type="button"
			onClick={() => openChantier(group.cwd)}
			className="focus-ring flex h-full flex-col gap-1.5 px-3.5 py-3 text-left"
			title={t("map.chantierCard.open")}
		>
			<span className="flex w-full items-center gap-2">
				<Bot size={12} className="shrink-0 text-accent" />
				<Eyebrow>{group.mission ? group.mission.role : t("map.chantier")} · {group.label}</Eyebrow>
				{clashes > 0 ? (
					<span className="ml-auto">
						<Pill tone="critical">
							<GitMerge size={10} className="mr-0.5" />
							{clashes}
						</Pill>
					</span>
				) : null}
			</span>
			<span className="line-clamp-2 text-[13px] leading-snug font-semibold text-ink">
				{ask ? ask.split("\n")[0] : t("map.chantierCard.agentsOnWorktree", { count: group.runs.length })}
			</span>
			<span className="mt-auto flex flex-col gap-0.5">
				{group.runs.slice(0, 3).map((run, index) => {
					const line = agentLine(run);
					return (
						<span key={run.id} className="flex items-center gap-1.5 text-[11px]">
							<span className="size-2 shrink-0 rounded-full" style={{ background: agentColor(index) }} />
							<span className="min-w-0 truncate text-ink">{run.label}</span>
							<span className={clsx("ml-auto shrink-0", line.tone)}>{line.label}</span>
						</span>
					);
				})}
				{group.runs.length > 3 ? <span className="text-[10.5px] text-ink-faint">{t("map.chantierCard.others", { count: group.runs.length - 3 })}</span> : null}
				{group.runs.length === 0 && group.terminals.length > 0 ? (
					<span className="text-[11px] text-ink-muted">{t("map.chantierCard.terminals", { count: group.terminals.length })}</span>
				) : null}
			</span>
		</button>
	);
}

function PrCard({ pr, mine, review }: { pr: PullRequest; mine: boolean; review: Review | null }) {
	const { t } = useTranslation("views");
	const startReview = useReviewFlow();
	const { notify } = useCockpit();
	const moved = movedSince(review, pr.headSha);
	const last = review?.rounds[review.rounds.length - 1];
	const relaunch = (kind: "revue" | "verification") =>
		void startReview(pr.number, kind).catch((error) => notify(String(error).replace(/^(Ipc)?Error:\s*/, "")));
	const ci =
		pr.ciState === "failing"
			? { label: t("map.pr.ciFailing"), tone: "critical" as const }
			: pr.ciState === "success"
				? { label: t("map.pr.ciPassing"), tone: "success" as const }
				: { label: t("map.pr.ciRunning"), tone: "neutral" as const };
	const reviewLabel =
		pr.reviewDecision === "APPROVED"
			? t("map.pr.approved")
			: pr.reviewDecision === "CHANGES_REQUESTED"
				? t("map.pr.changesRequested")
				: pr.reviewRequestLogins.length > 0
					? t("map.pr.reviewRequested", { logins: pr.reviewRequestLogins.join(", ") })
					: t("map.pr.notReviewed");
	return (
		<div className="flex h-full flex-col gap-1.5 px-3.5 py-3">
			<div className="flex items-center gap-2">
				<GitPullRequest size={12} className={clsx("shrink-0", mine ? "text-accent" : "text-ink-faint")} />
				<Eyebrow>
					#{pr.number} · {pr.author}
					{mine ? ` · ${t("map.pr.fromHere")}` : ""}
					{pr.isDraft ? ` · ${t("map.pr.draft")}` : ""}
				</Eyebrow>
				<span className="ml-auto">
					<Pill tone={ci.tone}>{ci.label}</Pill>
				</span>
			</div>
			<button
				type="button"
				onClick={() => void api.system.openUrl(pr.url).catch(() => undefined)}
				className="focus-ring line-clamp-2 rounded text-left text-[13px] leading-snug font-semibold text-ink hover:underline"
			>
				{pr.title}
			</button>
			<div className="mt-auto flex items-center gap-1">
				{/* Ta revue avant tout le reste : c'est le geste qu'on vient faire. */}
				{moved ? (
					<Button size="sm" variant="solid" icon={ScanSearch} onClick={() => relaunch("verification")}>
						{t("map.pr.recheck")}
					</Button>
				) : !review && !mine ? (
					<Button size="sm" icon={ScanSearch} onClick={() => relaunch("revue")}>
						{t("map.pr.review")}
					</Button>
				) : null}
				<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
					{last
						? t("map.pr.reviewRound", {
								round: last.number,
								verdict:
									last.verdict === "merge"
										? t("map.pr.toMerge")
										: t("map.pr.findings", { count: last.findings.length }),
							})
						: `${reviewLabel} · ${fromSeconds((Date.now() - Date.parse(pr.createdAt)) / 1000)}`}
				</span>
				<PrActions
					number={pr.number}
					url={pr.url}
					headRef={pr.headRef}
					ciFailing={pr.ciState === "failing"}
					changesRequested={pr.reviewDecision === "CHANGES_REQUESTED"}
				/>
			</div>
		</div>
	);
}

function MoreCard({ label, view }: { label: string; view: Parameters<ReturnType<typeof useCockpit>["go"]>[0] }) {
	const { go } = useCockpit();
	return (
		<button
			type="button"
			onClick={() => go(view)}
			className="focus-ring flex h-full items-center justify-between px-3.5 text-left text-[12px] font-medium text-ink-muted hover:text-ink"
		>
			+ {label}
			<ArrowUpRight size={13} />
		</button>
	);
}

