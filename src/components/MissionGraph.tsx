import {
	Background,
	BackgroundVariant,
	Controls,
	Handle,
	Position,
	ReactFlow,
	type Edge,
	type Node,
	type NodeProps,
	useReactFlow,
	useStore,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import {
	Bot,
	Check,
	FolderTree,
	GitPullRequest,
	MessageSquare,
	RotateCcw,
	ShieldCheck,
	Ticket,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Badge, Button } from "@/components/ui";
import { useCockpit } from "@/app/store";
import { useWorkspace } from "@/app/workspace";
import { useNodeSizes } from "@/lib/flowSizes";
import { api } from "@/lib/ipc";
import { resolveMasterCwd } from "@/lib/missions";
import type { AgentActivity, Mission, MissionActivity, MissionTask } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * Le graphe d'une mission : qui fait quoi, qui attend qui, et qui travaille en
 * ce moment.
 *
 * Une mission est un graphe — un ticket, un maître, des tâches qui dépendent
 * les unes des autres, des vérifications qui attendent l'implémentation, une
 * pull request au bout. Elle s'affichait pourtant en liste, et la seule façon
 * de savoir pourquoi une recette ne partait pas était de lire la base de
 * chaque tâche. Ici la dépendance se voit, et l'état de chacun se lit à sa
 * couleur avant d'avoir lu un mot.
 *
 * Le placement se calcule à partir du plan, sans bibliothèque de disposition :
 * une mission tient en quelques tâches, et leurs niveaux se déduisent des
 * bases déclarées et des rôles qui vérifient.
 */

type Phase = "done" | "live" | "wait" | "failed" | "yours";

interface GraphData extends Record<string, unknown> {
	kind: "ticket" | "master" | "task" | "pr";
	phase: Phase;
	title: string;
	eyebrow: string;
	/** Ce que fait l'agent à l'instant, ou ce qu'on sait de la tâche. */
	detail: string;
	verifies?: boolean;
	attempts?: number;
	selected?: boolean;
	vertical?: boolean;
}

const NODE_W = 208;
/* En largeur : une colonne par niveau. */
const COL = 256;
const ROW = 104;
/* De haut en bas : une rangée par niveau, pour les panneaux étroits. */
const RANK = 138;
const LANE = 228;

function taskPhase(task: MissionTask, activity: AgentActivity | null): Phase {
	if (task.state === "failed") return "failed";
	if (task.state === "delivered" || task.state === "integrated") return "done";
	if (task.state === "running") return activity?.waiting ? "yours" : "live";
	return "wait";
}

/** Niveau de chaque tâche : 1 = part de l'intégration, puis une sœur de plus à chaque dépendance. */
function levels(mission: Mission, verifying: Set<string>): Map<string, number> {
	const byBranch = new Map(mission.tasks.map((task) => [task.branch, task]));
	const level = new Map<string, number>();
	const depth = (task: MissionTask, seen: Set<string>): number => {
		const known = level.get(task.id);
		if (known !== undefined) return known;
		const sister =
			task.base && task.base !== mission.branch ? byBranch.get(task.base) : undefined;
		// Une base circulaire ne doit pas faire tourner le calcul en rond.
		const value =
			sister && !seen.has(sister.id) ? depth(sister, new Set(seen).add(task.id)) + 1 : 1;
		level.set(task.id, value);
		return value;
	};
	const builders = mission.tasks.filter((task) => !verifying.has(task.role));
	for (const task of builders) depth(task, new Set());
	const deepest = Math.max(1, ...builders.map((task) => level.get(task.id) ?? 1));
	// Les vérifications jugent le travail des autres : elles viennent après.
	for (const task of mission.tasks) {
		if (verifying.has(task.role)) level.set(task.id, deepest + 1);
	}
	return level;
}

export function MissionGraph({
	mission,
	activity,
	height = 360,
	vertical = false,
	withTicket = true,
}: {
	mission: Mission;
	activity: MissionActivity | null;
	height?: number;
	/** De haut en bas plutôt que de gauche à droite : pour un panneau étroit. */
	vertical?: boolean;
	/** Le nœud du ticket ; inutile quand le ticket est déjà affiché à côté. */
	withTicket?: boolean;
}) {
	const roles = useAsync(() => api.missions.roles(), []);
	const [selected, setSelected] = useState<string | null>(null);

	const verifying = useMemo(
		() => new Set((roles.data ?? []).filter((role) => role.verifies).map((role) => role.id)),
		[roles.data],
	);
	const labelOf = (id: string) => roles.data?.find((role) => role.id === id)?.label ?? id;

	const { nodes, edges } = useMemo(() => {
		const nodes: Node<GraphData>[] = [];
		const edges: Edge[] = [];
		const level = levels(mission, verifying);
		const activityOf = (taskId: string) =>
			activity?.tasks.find((entry) => entry.taskId === taskId)?.activity ?? null;

		const masterBusy = activity?.master?.working === true;
		const masterPhase: Phase = masterBusy
			? "live"
			: ["awaitingUnderstanding", "awaitingApproach", "awaitingApproval"].includes(mission.state)
				? "yours"
				: ["running", "integrating", "done"].includes(mission.state)
					? "done"
					: "wait";

		// Les colonnes : ticket, maître, puis un niveau de tâches par colonne.
		const columns = new Map<number, MissionTask[]>();
		for (const task of mission.tasks) {
			const at = level.get(task.id) ?? 1;
			columns.set(at, [...(columns.get(at) ?? []), task]);
		}
		const deepest = Math.max(0, ...columns.keys());
		const tallest = Math.max(1, ...[...columns.values()].map((column) => column.length));
		const spread = vertical ? LANE : ROW;
		const centre = ((tallest - 1) * spread) / 2;
		// `rank` : le niveau (ticket, maître, tâches, PR) ; `offset` : la place
		// dans ce niveau. L'orientation ne change que l'axe qui porte chacun.
		const first = withTicket ? 1 : 0;
		const place = (rank: number, offset: number) =>
			vertical
				? { x: offset, y: (rank - 1 + first) * RANK }
				: { x: (rank - 1 + first) * COL, y: offset };

		if (withTicket) nodes.push({
			id: "ticket",
			type: "cockpit",
			position: place(0, centre),
			data: {
				kind: "ticket",
				phase: "done",
				eyebrow: "ticket",
				title: mission.ticket || "Sans ticket",
				detail: mission.title,
			},
		});
		nodes.push({
			id: "master",
			type: "cockpit",
			position: place(1, centre),
			data: {
				kind: "master",
				phase: masterPhase,
				eyebrow: "maître",
				title: "Supervise la mission",
				detail:
					masterPhase === "yours"
						? "attend ta décision"
						: activity?.master?.last || (masterBusy ? "travaille…" : "en retrait"),
			},
		});
		if (withTicket) edges.push(edge("ticket", "master", "done", masterPhase));

		const phases = new Map<string, Phase>();
		for (const [at, column] of columns) {
			const top = centre - ((column.length - 1) * spread) / 2;
			column.forEach((task, index) => {
				const live = activityOf(task.id);
				const phase = taskPhase(task, live);
				phases.set(task.id, phase);
				nodes.push({
					id: task.id,
					type: "cockpit",
					position: place(at + 1, top + index * spread),
					data: {
						vertical,
						kind: "task",
						phase,
						eyebrow: labelOf(task.role),
						title: task.title,
						detail:
							phase === "live" || phase === "yours"
								? phase === "yours"
									? "te demande une autorisation"
									: live?.last || "travaille…"
								: phase === "done"
									? task.verdict === "blocking"
										? "a refusé le travail"
										: "a rendu sa copie"
									: phase === "failed"
										? task.note || "a échoué"
										: task.scope.length > 0
											? task.scope.join(" · ")
											: "attend son tour",
						verifies: verifying.has(task.role),
						attempts: task.attempts,
						selected: selected === task.id,
					},
				});
			});
		}

		// Les liens : qui part de qui.
		const byBranch = new Map(mission.tasks.map((task) => [task.branch, task]));
		const builders = mission.tasks.filter((task) => !verifying.has(task.role));
		const feeds = new Set<string>();
		for (const task of mission.tasks) {
			if (verifying.has(task.role)) continue;
			const sister =
				task.base && task.base !== mission.branch ? byBranch.get(task.base) : undefined;
			if (sister) {
				feeds.add(sister.id);
				edges.push(edge(sister.id, task.id, phases.get(sister.id), phases.get(task.id)));
			} else {
				edges.push(edge("master", task.id, masterPhase, phases.get(task.id)));
			}
		}
		// Une vérification juge ce que rendent les dernières tâches de la chaîne.
		const leaves = builders.filter((task) => !feeds.has(task.id));
		const verifiers = mission.tasks.filter((task) => verifying.has(task.role));
		for (const check of verifiers) {
			for (const leaf of leaves.length > 0 ? leaves : [{ id: "master" } as MissionTask]) {
				edges.push(
					edge(leaf.id, check.id, phases.get(leaf.id) ?? masterPhase, phases.get(check.id)),
				);
			}
		}

		const prPhase: Phase = mission.prUrl
			? "done"
			: mission.state === "integrating"
				? "live"
				: "wait";
		if (mission.tasks.length > 0) {
			nodes.push({
				id: "pr",
				type: "cockpit",
				position: place(deepest + 2, centre),
				data: {
					kind: "pr",
					phase: prPhase,
					eyebrow: "pull request",
					title: mission.prUrl ? "Ouverte" : "À ouvrir",
					detail:
						prPhase === "live"
							? "le maître recompose"
							: mission.prUrl
								? mission.prUrl.replace(/^https?:\/\//, "")
								: "une fois tout vérifié",
				},
			});
			const last = verifiers.length > 0 ? verifiers : leaves;
			for (const task of last) {
				edges.push(edge(task.id, "pr", phases.get(task.id), prPhase));
			}
		}

		// Chaque nœud sait dans quel sens partent ses liens.
		for (const node of nodes) node.data.vertical = vertical;
		return { nodes, edges };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mission, activity, verifying, selected, roles.data, vertical, withTicket]);

	// Mis à jour en direct pendant l'exécution : sans les tailles mesurées, une
	// série de changements laissait les nœuds invisibles (voir `useNodeSizes`).
	const { onNodesChange, withSizes } = useNodeSizes<Node<GraphData>>();
	const sized = useMemo(() => withSizes(nodes), [nodes, withSizes]);

	const picked = mission.tasks.find((task) => task.id === selected) ?? null;

	return (
		<div
			className="mission-graph relative overflow-hidden rounded-2xl bg-base shadow-card"
			style={{ height }}
		>
			<ReactFlow
				// Le cadrage automatique ne vaut qu'au montage : un plan redéclaré
				// (une tâche de plus, une dépendance déplacée) doit être recadré.
				key={`${vertical}:${mission.tasks.map((task) => `${task.id}@${task.base}`).join(",")}`}
				nodes={sized}
				onNodesChange={onNodesChange}
				edges={edges}
				nodeTypes={NODE_TYPES}
				fitView
				fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
				minZoom={0.35}
				maxZoom={1.6}
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={false}
				proOptions={{ hideAttribution: true }}
				onNodeClick={(_, node) =>
					setSelected((current) =>
						node.data.kind === "task" && current !== node.id ? node.id : null,
					)
				}
				onPaneClick={() => setSelected(null)}
			>
				<Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
				<Controls showInteractive={false} position="bottom-left" />
				<Refit />
			</ReactFlow>

			<Legend />

			<AnimatePresence>
				{picked ? (
					<TaskDetail
						key={picked.id}
						mission={mission}
						task={picked}
						role={labelOf(picked.role)}
						activity={
							activity?.tasks.find((entry) => entry.taskId === picked.id)?.activity ?? null
						}
						onClose={() => setSelected(null)}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}

/**
 * Recadre le graphe chaque fois que son cadre change de taille.
 *
 * `fitView` ne cadre qu'au montage. Monté pendant qu'un écran glisse ou qu'un
 * panneau s'ouvre, il cadrait sur une surface encore nulle : les nœuds
 * existaient, mais hors champ, et le canevas paraissait vide.
 */
function Refit() {
	const { fitView } = useReactFlow();
	// Pas `useNodesInitialized` : sans `onNodesChange`, les mesures ne
	// reviennent jamais dans nos nœuds et ce drapeau reste faux pour toujours.
	const ready = useStore((state) => {
		if (state.nodeLookup.size === 0) return false;
		for (const node of state.nodeLookup.values()) if (!node.measured.width) return false;
		return true;
	});
	const width = useStore((state) => state.width);
	const height = useStore((state) => state.height);
	useEffect(() => {
		if (ready && width > 0 && height > 0) {
			void fitView({ padding: 0.12, maxZoom: 1 });
		}
	}, [ready, width, height, fitView]);
	return null;
}

function edge(source: string, target: string, from?: Phase, to?: Phase): Edge {
	const flowing = from === "done" && (to === "live" || to === "yours");
	const tone = flowing
		? "var(--color-accent)"
		: from === "done" && to === "done"
			? "color-mix(in srgb, var(--color-success) 65%, transparent)"
			: from === "done"
				? "color-mix(in srgb, var(--color-success) 40%, var(--color-line))"
				: "var(--color-line)";
	return {
		id: `${source}->${target}`,
		source,
		target,
		type: "default",
		animated: flowing,
		style: { stroke: tone, strokeWidth: flowing ? 2 : 1.6 },
	};
}

/* ── Les nœuds ───────────────────────────────────────────────────────── */

const ICONS = { ticket: Ticket, master: Bot, pr: GitPullRequest, task: FolderTree };

const PHASE_LABEL: Record<Phase, string> = {
	done: "fait",
	live: "travaille",
	wait: "attend",
	failed: "échec",
	yours: "à toi",
};

function CockpitNode({ data }: NodeProps<Node<GraphData>>) {
	const Icon = data.verifies ? ShieldCheck : ICONS[data.kind];
	const live = data.phase === "live";
	return (
		<div
			className={clsx(
				"relative flex flex-col gap-1.5 rounded-2xl border bg-surface px-3 py-2.5 transition-[border-color,box-shadow] duration-300",
				data.kind === "task" ? "cursor-pointer" : "cursor-default",
				data.phase === "done" && "border-success/35",
				data.phase === "live" && "border-accent shadow-[0_0_0_4px_var(--color-accent-dim)]",
				data.phase === "yours" && "border-warning shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-warning)_18%,transparent)]",
				data.phase === "wait" && "border-line-soft",
				data.phase === "failed" && "border-critical/50",
				data.selected && "ring-2 ring-accent ring-offset-2 ring-offset-base",
			)}
			style={{ width: NODE_W, boxShadow: live ? undefined : "var(--shadow-card)" }}
		>
			<Handle
				type="target"
				position={data.vertical ? Position.Top : Position.Left}
				className="!size-1.5 !border-0 !bg-line"
			/>
			{/* Ce qui travaille respire : on le repère sans lire. */}
			{live ? (
				<span className="animate-pulse-dot pointer-events-none absolute -inset-[5px] rounded-[20px] border border-accent/40" />
			) : null}
			<div className="flex items-center gap-1.5">
				<span
					className={clsx(
						"grid size-5 shrink-0 place-items-center rounded-md",
						data.phase === "done" && "bg-success/15 text-success",
						data.phase === "live" && "bg-accent-dim text-accent",
						data.phase === "yours" && "bg-warning/15 text-warning",
						data.phase === "wait" && "bg-raised text-ink-faint",
						data.phase === "failed" && "bg-critical/15 text-critical",
					)}
				>
					{data.phase === "done" ? <Check size={11} /> : <Icon size={11} />}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[9.5px] tracking-[0.08em] text-ink-faint uppercase">
					{data.eyebrow}
				</span>
				{data.attempts && data.attempts > 0 ? (
					<span
						className="flex items-center gap-0.5 font-mono text-[9.5px] text-warning"
						title="Renvoyée en correction"
					>
						<RotateCcw size={9} />
						{data.attempts}
					</span>
				) : null}
				<span
					className={clsx(
						"rounded-full px-1.5 py-px text-[9.5px] font-semibold",
						data.phase === "done" && "bg-success/12 text-success",
						data.phase === "live" && "bg-accent text-accent-ink",
						data.phase === "yours" && "bg-warning/15 text-warning",
						data.phase === "wait" && "bg-raised text-ink-faint",
						data.phase === "failed" && "bg-critical/12 text-critical",
					)}
				>
					{PHASE_LABEL[data.phase]}
				</span>
			</div>
			<div className="line-clamp-2 text-[12.5px] leading-snug font-semibold text-ink">
				{data.title}
			</div>
			<div
				className={clsx(
					"truncate font-mono text-[10px]",
					live ? "text-accent" : "text-ink-faint",
				)}
			>
				{data.detail}
			</div>
			<Handle
				type="source"
				position={data.vertical ? Position.Bottom : Position.Right}
				className="!size-1.5 !border-0 !bg-line"
			/>
		</div>
	);
}

const NODE_TYPES = { cockpit: CockpitNode };

function Legend() {
	const items: Array<[string, string]> = [
		["bg-success", "fait"],
		["bg-accent", "travaille"],
		["bg-warning", "à toi"],
		["bg-line", "attend"],
	];
	return (
		<div className="pointer-events-none absolute top-3 left-3 flex items-center gap-3 rounded-full bg-surface/90 px-3 py-1 text-[10.5px] text-ink-muted shadow-card backdrop-blur">
			{items.map(([tone, label]) => (
				<span key={label} className="flex items-center gap-1.5">
					<span className={clsx("size-2 rounded-full", tone)} />
					{label}
				</span>
			))}
		</div>
	);
}

/** La fiche d'une tâche, ouverte depuis son nœud. */
function TaskDetail({
	mission,
	task,
	role,
	activity,
	onClose,
}: {
	mission: Mission;
	task: MissionTask;
	role: string;
	activity: AgentActivity | null;
	onClose: () => void;
}) {
	const { go, worktrees } = useCockpit();
	const { show } = useWorkspace();
	return (
		<motion.aside
			initial={{ opacity: 0, x: 24 }}
			animate={{ opacity: 1, x: 0 }}
			exit={{ opacity: 0, x: 24 }}
			transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
			className="absolute top-3 right-3 bottom-3 flex w-[300px] flex-col gap-3 overflow-y-auto rounded-2xl bg-surface p-4 shadow-pop"
		>
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<Badge tone="accent">{role}</Badge>
					<h3 className="mt-1.5 text-[13.5px] leading-snug font-semibold text-ink">
						{task.title}
					</h3>
				</div>
				<Button size="sm" icon={X} title="Fermer" onClick={onClose} />
			</div>

			{activity?.running ? (
				<div className="rounded-xl bg-accent-dim px-3 py-2 font-mono text-[11px] text-accent">
					{activity.last || "travaille…"}
				</div>
			) : null}

			{task.scope.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{task.scope.map((path) => (
						<span
							key={path}
							className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
						>
							{path}
						</span>
					))}
				</div>
			) : null}

			{task.note ? (
				<p className="text-selectable text-[12px] leading-relaxed text-ink-muted">{task.note}</p>
			) : null}

			{task.reproaches?.length ? (
				<div className="rounded-xl border border-warning/30 bg-warning/[0.06] p-2.5">
					<div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-warning uppercase">
						Reprises · {task.reproaches.length}
					</div>
					<ol className="flex list-decimal flex-col gap-1 pl-4 text-[11.5px] text-ink-muted">
						{task.reproaches.map((reason, index) => (
							<li key={index}>{reason}</li>
						))}
					</ol>
				</div>
			) : null}

			{task.brief ? (
				<details className="text-[12px]">
					<summary className="cursor-pointer text-[11px] font-medium text-accent">
						Sa consigne complète
					</summary>
					<div className="mt-2">
						<Markdown source={task.brief} />
					</div>
				</details>
			) : null}

			<div className="mt-auto flex gap-2">
				{task.sessionId ? (
					<Button
						variant="solid"
						icon={MessageSquare}
						onClick={() => {
							show(task.worktree || resolveMasterCwd(mission, worktrees), {
								kind: "agent",
								id: task.sessionId as string,
							});
							go("workspace");
						}}
					>
						Suivre sa conversation
					</Button>
				) : (
					<span className="text-[11px] text-ink-faint">Pas encore d'agent sur cette tâche.</span>
				)}
			</div>
		</motion.aside>
	);
}
