import clsx from "clsx";
import { Activity } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { useCockpit } from "@/app/store";
import { useWorkspace } from "@/app/workspace";
import { duration } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { Execution } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * La journée des agents : une ligne par agent, une barre par période de travail.
 *
 * L'accueil disait ce qui attend, jamais ce qui s'est passé. Or la question du
 * matin — et du retour de déjeuner — est souvent « qu'est-ce qui a tourné, et
 * qu'est-ce qui a coincé ? ». Une frise y répond d'un regard : l'agent qui
 * travaille depuis trois heures, celui qui est mort à 11 h, la matinée où rien
 * n'a bougé.
 *
 * Tout vient du relevé d'exécutions, qui garde aussi les agents refermés.
 */

const LANES = 9;

interface Lane {
	key: string;
	label: string;
	sub: string;
	cwd: string;
	sessionId: string;
	runs: Execution[];
	live: boolean;
}

function tone(run: Execution): string {
	switch (run.outcome) {
		case "running":
			return "bg-accent";
		case "answered":
			return "bg-success/75";
		case "failed":
		case "lostAtLaunch":
			return "bg-critical/80";
		default:
			return "bg-ink-faint/40";
	}
}

function labelOf(run: Execution): { label: string; sub: string } {
	const folder = run.cwd.split("/").filter(Boolean).pop() ?? run.cwd;
	const role = run.origin.role && run.origin.role !== "me" ? run.origin.role : "";
	if (role) return { label: role, sub: folder };
	return { label: folder, sub: run.origin.actor === "permanence" ? "Permanence" : run.model };
}

function cost(run: Execution): number {
	return (run.tally.cost.reportedUsd ?? 0) + (run.tally.cost.estimatedUsd ?? 0);
}

export function AgentDay() {
	const { go } = useCockpit();
	const { show } = useWorkspace();
	const runs = useAsync(() => api.executions.recent(12), [], { pollMs: 30_000 });
	const [hover, setHover] = useState<{ run: Execution; lane: Lane } | null>(null);
	const now = Date.now();

	const { lanes, from, to, ticks } = useMemo(() => {
		const all = runs.data ?? [];
		const byAgent = new Map<string, Lane>();
		for (const run of all) {
			const key = run.sessionId || run.id;
			const lane = byAgent.get(key);
			if (lane) {
				lane.runs.push(run);
				lane.live ||= run.outcome === "running";
			} else {
				byAgent.set(key, {
					key,
					...labelOf(run),
					cwd: run.cwd,
					sessionId: run.sessionId,
					runs: [run],
					live: run.outcome === "running",
				});
			}
		}
		// Les agents qui travaillent d'abord, puis les plus récents.
		const lanes = [...byAgent.values()]
			.sort((a, b) => {
				if (a.live !== b.live) return a.live ? -1 : 1;
				const lastA = a.runs.at(-1)?.startedAt ?? "";
				const lastB = b.runs.at(-1)?.startedAt ?? "";
				return lastB.localeCompare(lastA);
			})
			.slice(0, LANES);

		const starts = lanes.flatMap((lane) => lane.runs.map((run) => Date.parse(run.startedAt)));
		// Au moins trois heures visibles : une frise de vingt minutes étirerait
		// chaque barre sur toute la largeur et ne dirait plus rien du rythme.
		const earliest = Math.min(now - 3 * 3600_000, ...starts.filter(Number.isFinite));
		const from = Math.max(earliest, now - 12 * 3600_000);
		const to = now + 10 * 60_000;
		const ticks: number[] = [];
		const first = new Date(from);
		first.setMinutes(0, 0, 0);
		const step = to - from > 8 * 3600_000 ? 2 : 1;
		for (let t = first.getTime() + 3600_000; t < to; t += step * 3600_000) ticks.push(t);
		return { lanes, from, to, ticks };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [runs.data]);

	const x = (time: number) => `${(((time - from) / (to - from)) * 100).toFixed(3)}%`;
	const span = (run: Execution) => {
		const start = Math.max(Date.parse(run.startedAt), from);
		const end = run.endedAt ? Date.parse(run.endedAt) : now;
		// Un tour de vingt secondes reste visible : sinon il disparaît de la frise.
		const width = Math.max(((end - start) / (to - from)) * 100, 0.6);
		return { left: x(start), width: `${width.toFixed(3)}%` };
	};

	const busy = lanes.filter((lane) => lane.live).length;

	return (
		<section className="panel flex flex-col gap-3 p-4">
			<div className="flex items-center gap-2">
				<span className="grid size-7 place-items-center rounded-lg bg-accent-dim text-accent">
					<Activity size={14} />
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="text-[13px] font-semibold text-ink">La journée des agents</h2>
					<p className="text-[11px] text-ink-faint">
						{lanes.length === 0
							? "Aucun agent n'a tourné ces dernières heures."
							: busy > 0
								? `${busy} au travail en ce moment · ${lanes.length} depuis ce matin`
								: `${lanes.length} agent${lanes.length > 1 ? "s" : ""} ces dernières heures, aucun au travail`}
					</p>
				</div>
				<div className="flex items-center gap-3 text-[10.5px] text-ink-muted">
					<span className="flex items-center gap-1.5">
						<span className="size-2 rounded-full bg-accent" />
						travaille
					</span>
					<span className="flex items-center gap-1.5">
						<span className="size-2 rounded-full bg-success/75" />
						terminé
					</span>
					<span className="flex items-center gap-1.5">
						<span className="size-2 rounded-full bg-critical/80" />
						échec
					</span>
				</div>
			</div>

			{lanes.length > 0 ? (
				<div className="relative grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
					{/* L'échelle des heures, alignée sur la piste. */}
					<span />
					<div className="relative h-4">
						{ticks.map((tick) => (
							<span
								key={tick}
								className="absolute -translate-x-1/2 font-mono text-[10px] text-ink-faint"
								style={{ left: x(tick) }}
							>
								{new Date(tick).getHours()} h
							</span>
						))}
					</div>

					{lanes.map((lane, index) => (
						<LaneRow
							key={lane.key}
							lane={lane}
							index={index}
							span={span}
							ticks={ticks}
							x={x}
							now={now}
							hovered={hover?.lane.key === lane.key ? hover.run.id : null}
							onHover={(run) => setHover(run ? { run, lane } : null)}
							onOpen={() => {
								if (lane.live && lane.sessionId) {
									show(lane.cwd, { kind: "agent", id: lane.sessionId });
									go("workspace");
								}
							}}
						/>
					))}

					{/* Maintenant : le bord où les barres vivantes poussent. */}
					<span />
					<div className="pointer-events-none relative h-0">
						<div
							className="absolute bottom-0 w-px bg-ink/50"
							style={{ left: x(now), height: `${lanes.length * 30 + 12}px` }}
						>
							<span className="absolute -top-1 right-1.5 font-mono text-[9.5px] whitespace-nowrap text-ink-muted">
								maintenant
							</span>
						</div>
					</div>
				</div>
			) : null}

			{hover ? (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-raised px-3 py-2 text-[11.5px] text-ink-muted">
					<span className="font-semibold text-ink">{hover.lane.label}</span>
					<span>
						{new Date(hover.run.startedAt).toLocaleTimeString("fr-FR", {
							hour: "2-digit",
							minute: "2-digit",
						})}{" "}
						·{" "}
						{duration(
							Math.round(
								((hover.run.endedAt ? Date.parse(hover.run.endedAt) : now) -
									Date.parse(hover.run.startedAt)) /
									1000,
							),
						)}
					</span>
					<span>{hover.run.tally.turns} tours</span>
					{cost(hover.run) > 0 ? <span>{cost(hover.run).toFixed(2)} $</span> : null}
					{hover.run.note ? <span className="text-ink-faint">{hover.run.note}</span> : null}
				</div>
			) : null}
		</section>
	);
}

function LaneRow({
	lane,
	index,
	span,
	ticks,
	x,
	now,
	hovered,
	onHover,
	onOpen,
}: {
	lane: Lane;
	index: number;
	span: (run: Execution) => { left: string; width: string };
	ticks: number[];
	x: (time: number) => string;
	now: number;
	hovered: string | null;
	onHover: (run: Execution | null) => void;
	onOpen: () => void;
}) {
	return (
		<>
			<button
				type="button"
				onClick={onOpen}
				disabled={!lane.live}
				className="focus-ring flex h-6 min-w-0 flex-col justify-center rounded text-left disabled:cursor-default"
				title={lane.live ? "Ouvrir sa conversation" : undefined}
			>
				<span className="flex items-center gap-1.5 truncate text-[12px] font-medium text-ink">
					{lane.live ? <span className="animate-pulse-dot size-1.5 shrink-0 rounded-full bg-accent" /> : null}
					<span className="truncate">{lane.label}</span>
				</span>
				<span className="truncate font-mono text-[9.5px] text-ink-faint">{lane.sub}</span>
			</button>
			<div className="relative h-6 rounded-md bg-raised/60" onMouseLeave={() => onHover(null)}>
				{ticks.map((tick) => (
					<span
						key={tick}
						className="absolute top-0 bottom-0 w-px bg-line-soft"
						style={{ left: x(tick) }}
					/>
				))}
				{lane.runs.map((run) => {
					const place = span(run);
					const live = run.outcome === "running";
					return (
						<motion.button
							key={run.id}
							type="button"
							initial={{ scaleX: 0, opacity: 0 }}
							animate={{ scaleX: 1, opacity: 1 }}
							transition={{ duration: 0.5, delay: index * 0.04, ease: [0.25, 1, 0.5, 1] }}
							onMouseEnter={() => onHover(run)}
							onFocus={() => onHover(run)}
							onClick={onOpen}
							className={clsx(
								"absolute top-1 bottom-1 origin-left rounded-[5px] transition-[filter,box-shadow]",
								tone(run),
								hovered === run.id && "brightness-110 ring-2 ring-ink/20",
								live && "shadow-[0_0_0_3px_var(--color-accent-dim)]",
							)}
							style={place}
							aria-label={`${lane.label}, ${run.outcome}`}
						/>
					);
				})}
				{lane.live ? (
					<span
						className="animate-pulse-dot absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
						style={{ left: x(now) }}
					/>
				) : null}
			</div>
		</>
	);
}
