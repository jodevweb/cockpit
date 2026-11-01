import clsx from "clsx";
import { Check, ChevronDown, Hand, Loader2, Pause, X } from "lucide-react";
import { useAgentActions, useAgentRuns, type AgentRun } from "@/app/agents";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { duration, fromSeconds } from "@/lib/format";
import { dismissActivity, openActivities, setActivitiesCollapsed, useActivities, type Activity } from "@/lib/activity";

/**
 * Ce qui tourne en arrière-plan, bien en vue.
 *
 * Un panneau en haut à droite tant qu'une action est en cours : son étape du
 * moment, depuis combien de temps, et à la fin ce qu'elle a donné. Replié, il
 * devient une pastille dans la barre du haut ; une action qui commence le
 * rouvre.
 */

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [active]);
	return now;
}

/** Ce que font les agents, vu de loin : qui travaille, qui t'attend. */
interface AgentPulse {
	run: AgentRun;
	/** `working` : il travaille ; `asks` : question ou autorisation ; `replied` : son tour est fini. */
	kind: "working" | "asks" | "replied";
	since: number | null;
	what: string;
}

function lastAt(run: AgentRun): number | null {
	for (let index = run.turns.length - 1; index >= 0; index -= 1) {
		const at = run.turns[index].doneAt ?? run.turns[index].at;
		if (at) return at;
	}
	return null;
}

/** Au-delà, une réponse laissée sans suite n'est plus une attente : un oubli. */
const REPLIED_FOR_MS = 12 * 3600_000;

function useAgentPulses(): AgentPulse[] {
	const { t } = useTranslation("components3");
	const { runs, pendingFor } = useAgentRuns();
	const out: AgentPulse[] = [];
	for (const run of runs) {
		if (!run.running) continue;
		const asks = pendingFor(run.id);
		if (asks.length > 0) {
			out.push({
				run,
				kind: "asks",
				since: lastAt(run),
				what:
					asks[0]?.tool === "AskUserQuestion"
						? t("activityCenter.pulse.asksQuestion")
						: t("activityCenter.pulse.asksPermission", {
								tool: asks[0]?.tool ?? t("activityCenter.pulse.tool"),
							}),
			});
			continue;
		}
		if (run.thinking) {
			out.push({ run, kind: "working", since: lastAt(run), what: run.activity ? t("activityCenter.pulse.using", { tool: run.activity }) : t("activityCenter.pulse.thinking") });
			continue;
		}
		const last = [...run.turns].reverse().find((turn) => turn.kind === "assistant" || turn.kind === "user");
		const at = lastAt(run);
		if (last?.kind === "assistant" && at && Date.now() - at < REPLIED_FOR_MS) {
			out.push({ run, kind: "replied", since: at, what: t("activityCenter.pulse.replied") });
		}
	}
	return out;
}

/**
 * La pastille de la barre du haut : ce qui travaille, ou ce qui t'attend.
 *
 * C'est la réponse, depuis n'importe quel écran, à « est-ce que quelque chose
 * tourne, ou est-ce à moi de jouer ? » — sans laquelle on attendait devant un
 * agent qui avait fini depuis longtemps.
 */
export function ActivityChip() {
	const { t } = useTranslation("components3");
	const { activities, collapsed, manual } = useActivities();
	const pulses = useAgentPulses();
	const running = activities.filter((activity) => activity.state === "running").length;
	const failed = activities.filter((activity) => activity.state === "failed").length;
	const working = running + pulses.filter((pulse) => pulse.kind === "working").length;
	const yours = pulses.filter((pulse) => pulse.kind !== "working").length + failed;
	const open = !collapsed && (activities.length > 0 || manual);
	if (working === 0 && yours === 0 && activities.length === 0) return null;
	return (
		<button
			type="button"
			onClick={() => (open ? setActivitiesCollapsed(true) : openActivities())}
			title={open ? t("activityCenter.chip.collapse") : t("activityCenter.chip.hint")}
			className={clsx(
				"focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors",
				working > 0 ? "bg-accent-dim text-accent-soft" : yours > 0 ? "bg-warning/12 text-warning" : "bg-success/12 text-success",
			)}
		>
			{working > 0 ? <Loader2 size={13} className="animate-spin" /> : yours > 0 ? <Hand size={13} /> : <Check size={13} />}
			{working > 0
				? t("activityCenter.chip.working", { count: working })
				: yours > 0
					? t("activityCenter.chip.yours")
					: t("activityCenter.chip.done")}
			{working > 0 && yours > 0 ? (
				<span className="rounded bg-warning/15 px-1 text-warning">
					{t("activityCenter.chip.yoursCount", { count: yours })}
				</span>
			) : null}
			{working === 0 && yours > 1 ? <span>· {yours}</span> : null}
		</button>
	);
}

/** Le panneau, sous la barre du haut : le cockpit, les agents, ce qui t'attend. */
export function ActivityPanel() {
	const { t } = useTranslation("components3");
	const { activities, collapsed, manual } = useActivities();
	const pulses = useAgentPulses();
	const { show } = useAgentActions();
	const working = pulses.filter((pulse) => pulse.kind === "working");
	const yours = pulses.filter((pulse) => pulse.kind !== "working");
	const running = activities.some((activity) => activity.state === "running") || working.length > 0;
	const now = useNow(running || yours.length > 0);
	const visible = !collapsed && (activities.length > 0 || manual);

	return (
		<AnimatePresence>
			{visible ? (
				<motion.aside
					key="activity"
					initial={{ opacity: 0, y: -10 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: -8 }}
					transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
					className="fixed top-13 right-3 z-[55] flex max-h-[70vh] w-[390px] flex-col overflow-hidden rounded-[var(--radius-panel)] bg-surface shadow-[var(--shadow-pop)] ring-1 ring-line-soft"
					aria-live="polite"
				>
					<header className="flex items-center gap-2 px-3.5 pt-3 pb-2">
						<span className="text-[12px] font-semibold text-ink">
							{running
								? t("activityCenter.panel.running")
								: yours.length > 0
									? t("activityCenter.panel.yourTurn")
									: t("activityCenter.panel.idle")}
						</span>
						<button
							type="button"
							onClick={() => setActivitiesCollapsed(true)}
							className="focus-ring ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-hover hover:text-ink"
							title={t("activityCenter.panel.collapseHint")}
						>
							<ChevronDown size={12} />
							{t("activityCenter.panel.collapse")}
						</button>
					</header>
					<div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-2.5 pb-3">
						{activities.length > 0 ? (
							<Section title={t("activityCenter.panel.cockpit")}>
								<AnimatePresence initial={false}>
									{activities.map((activity) => (
										<motion.div
											key={activity.id}
											layout
											initial={{ opacity: 0, scale: 0.98 }}
											animate={{ opacity: 1, scale: 1 }}
											exit={{ opacity: 0, height: 0 }}
											transition={{ duration: 0.18 }}
										>
											<Row activity={activity} now={now} />
										</motion.div>
									))}
								</AnimatePresence>
							</Section>
						) : null}
						{working.length > 0 ? (
							<Section title={t("activityCenter.panel.working")}>
								{working.map((pulse) => (
									<AgentLine key={pulse.run.id} pulse={pulse} now={now} onOpen={() => show(pulse.run.id)} />
								))}
							</Section>
						) : null}
						{yours.length > 0 ? (
							<Section title={t("activityCenter.panel.yourTurn")}>
								{yours.map((pulse) => (
									<AgentLine key={pulse.run.id} pulse={pulse} now={now} onOpen={() => show(pulse.run.id)} />
								))}
							</Section>
						) : null}
						{activities.length === 0 && working.length === 0 && yours.length === 0 ? (
							<p className="px-1.5 py-2 text-[12px] text-ink-muted">
								{t("activityCenter.panel.empty")}
							</p>
						) : null}
					</div>
				</motion.aside>
			) : null}
		</AnimatePresence>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<p className="px-1 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">{title}</p>
			{children}
		</div>
	);
}

function AgentLine({ pulse, now, onOpen }: { pulse: AgentPulse; now: number; onOpen: () => void }) {
	const { t } = useTranslation("components3");
	const tone =
		pulse.kind === "working" ? "bg-accent-dim/50" : pulse.kind === "asks" ? "bg-warning/12" : "bg-raised";
	return (
		<button
			type="button"
			onClick={onOpen}
			className={clsx("focus-ring relative flex w-full items-start gap-2.5 overflow-hidden rounded-xl px-3 py-2 text-left hover:brightness-95", tone)}
			title={t("activityCenter.openAgent")}
		>
			{pulse.kind === "working" ? <span className="loading-bar absolute inset-x-0 bottom-0 h-0.5" aria-hidden /> : null}
			<span
				className={clsx(
					"mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
					pulse.kind === "working" ? "bg-accent text-accent-ink" : pulse.kind === "asks" ? "bg-warning text-white" : "bg-ink-faint/30 text-ink",
				)}
			>
				{pulse.kind === "working" ? <Loader2 size={12} className="animate-spin" /> : pulse.kind === "asks" ? <Hand size={11} /> : <Pause size={10} />}
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{pulse.run.label}</span>
					{pulse.since ? (
						<span className="shrink-0 font-mono text-[10.5px] text-ink-faint tabular-nums">
							{pulse.kind === "working" ? duration(Math.max(0, (now - pulse.since) / 1000)) : fromSeconds((now - pulse.since) / 1000)}
						</span>
					) : null}
				</span>
				<span className={clsx("block text-[11.5px]", pulse.kind === "asks" ? "text-warning" : "text-ink-muted")}>{pulse.what}</span>
			</span>
		</button>
	);
}

function Row({ activity, now }: { activity: Activity; now: number }) {
	const { t } = useTranslation("components3");
	const [open, setOpen] = useState(false);
	const current = activity.steps[activity.steps.length - 1];
	const elapsed = ((activity.endedAt ?? now) - activity.startedAt) / 1000;
	const running = activity.state === "running";
	const failed = activity.state === "failed";

	return (
		<div
			className={clsx(
				"relative overflow-hidden rounded-xl px-3 py-2.5",
				running ? "bg-accent-dim/50" : failed ? "bg-critical/8" : "bg-success/8",
			)}
		>
			{/* Une action qui tourne se voit bouger : un fil qui court en bas. */}
			{running ? <span className="loading-bar absolute inset-x-0 bottom-0 h-0.5" aria-hidden /> : null}
			<div className="flex items-start gap-2.5">
				<span
					className={clsx(
						"mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
						running ? "bg-accent text-accent-ink" : failed ? "bg-critical text-white" : "bg-success text-white",
					)}
				>
					{running ? <Loader2 size={12} className="animate-spin" /> : failed ? <X size={12} /> : <Check size={12} />}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink" title={activity.title}>
							{activity.title}
						</span>
						<span className="shrink-0 font-mono text-[10.5px] text-ink-faint tabular-nums">{duration(Math.max(0, elapsed))}</span>
					</div>
					<p className={clsx("mt-0.5 text-[11.5px] leading-snug", failed ? "text-critical" : "text-ink-muted")}>
						{activity.state === "running"
							? (current?.text ?? t("activityCenter.row.working"))
							: (activity.result ?? (failed ? t("activityCenter.row.failed") : t("activityCenter.row.done")))}
					</p>
					{activity.steps.length > 1 ? (
						<button
							type="button"
							onClick={() => setOpen((value) => !value)}
							className="focus-ring mt-1 rounded text-[10.5px] text-ink-faint hover:text-ink"
						>
							{open
								? t("activityCenter.row.hideSteps")
								: t("activityCenter.row.steps", { count: activity.steps.length })}
						</button>
					) : null}
					{open ? (
						<ol className="mt-1 flex flex-col gap-0.5 border-l border-line pl-2">
							{activity.steps.map((step, index) => (
								<li key={index} className="text-[10.5px] text-ink-muted">
									<span className="font-mono text-ink-faint">{duration(Math.max(0, (step.at - activity.startedAt) / 1000))}</span> · {step.text}
								</li>
							))}
						</ol>
					) : null}
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					<button
						type="button"
						onClick={() => dismissActivity(activity.id)}
						className="focus-ring rounded p-0.5 text-ink-faint hover:text-ink"
						title={running ? t("activityCenter.row.unfollow") : t("activityCenter.row.dismiss")}
					>
						<X size={12} />
					</button>
					{activity.action ? (
						<button
							type="button"
							onClick={() => {
								activity.action?.run();
								dismissActivity(activity.id);
							}}
							className="focus-ring rounded-md bg-surface px-2 py-0.5 text-[11px] font-medium text-ink shadow-card hover:bg-hover"
						>
							{activity.action.label}
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}
