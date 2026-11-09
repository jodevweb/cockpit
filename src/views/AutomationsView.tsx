import clsx from "clsx";
import { Clock, Lock, Play, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AutomationEditor } from "@/components/AutomationEditor";
import { AutomationRunView } from "@/components/AutomationRunView";
import { ErrorNote, Spinner } from "@/components/ui";
import {
	DAY_LABELS,
	parseLocal,
	relativeStamp,
	rhythm,
	runLabel,
	shortStamp,
	SOURCE_LABEL,
	TONE_CLASS,
} from "@/lib/automations";
import { api, events } from "@/lib/ipc";
import type { Automation, AutomationOverview, AutomationRun } from "@/lib/types";
import { useAsync, usePersistentState } from "@/lib/useAsync";
import { locale } from "@/i18n";
import { platformContext } from "@/lib/platform";

/**
 * Les automatisations : des rendez-vous qui se préparent seuls.
 *
 * Construit comme les écrans de travail — la liste à gauche, le détail en
 * grand — parce que c'en est un : on y revient avant chaque daily, on y relit
 * ce qui a été préparé, on y corrige le réglage. Trois états pour le panneau :
 * le détail d'une automatisation, son réglage, et le rendu d'une exécution.
 */

type Mode =
	| { kind: "detail" }
	| { kind: "edit"; draft: Automation | null }
	| { kind: "run"; runId: string };

export function AutomationsView() {
	const { t } = useTranslation("views");
	const overview = useAsync(() => api.automations.overview(), [], {
		subscribe: (onChange) => events.onAutomationRun(onChange),
		pollMs: 60_000,
	});
	const [selected, setSelected] = usePersistentState<string>("automations.selected", "");
	const [mode, setMode] = useState<Mode>({ kind: "detail" });

	const list = overview.data ?? [];
	const current = list.find((entry) => entry.automation.id === selected) ?? list[0] ?? null;

	useEffect(() => {
		if (current && current.automation.id !== selected) setSelected(current.automation.id);
	}, [current, selected, setSelected]);

	if (overview.error && !overview.data) {
		return (
			<div className="p-5">
				<ErrorNote error={overview.error} onRetry={overview.reload} />
			</div>
		);
	}

	if (mode.kind === "edit") {
		return (
			<AutomationEditor
				initial={mode.draft}
				onClose={() => setMode({ kind: "detail" })}
				onSaved={(saved) => {
					setSelected(saved.id);
					setMode({ kind: "detail" });
					overview.reload();
				}}
				onRemoved={() => {
					setSelected("");
					setMode({ kind: "detail" });
					overview.reload();
				}}
			/>
		);
	}

	if (mode.kind === "run" && current) {
		return (
			<AutomationRunView
				entry={current}
				runId={mode.runId}
				onPick={(runId) => setMode({ kind: "run", runId })}
				onClose={() => setMode({ kind: "detail" })}
				onChanged={overview.reload}
			/>
		);
	}

	if (!overview.data) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (list.length === 0) return <Empty onCreate={() => setMode({ kind: "edit", draft: null })} />;

	return (
		<div className="flex min-h-0 flex-1 gap-4 overflow-y-auto p-4">
			<aside className="flex w-[320px] shrink-0 flex-col gap-3">
				<div className="flex items-center justify-between gap-2 px-1 pt-1">
					<h1 className="text-[19px] font-semibold text-ink">{t("automations.title")}</h1>
					<button
						type="button"
						onClick={() => setMode({ kind: "edit", draft: null })}
						className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-semibold text-accent-ink hover:bg-accent-soft"
					>
						<Plus size={14} /> {t("automations.new")}
					</button>
				</div>
				<div className="flex flex-col gap-2">
					{list.map((entry) => (
						<AutomationCard
							key={entry.automation.id}
							entry={entry}
							selected={current?.automation.id === entry.automation.id}
							onClick={() => {
								setSelected(entry.automation.id);
								setMode({ kind: "detail" });
							}}
						/>
					))}
				</div>
				<p className="rounded-xl bg-surface p-3 text-[12px] leading-relaxed text-ink-muted shadow-card">
					{t("automations.whenItRuns", { context: platformContext })}
				</p>
			</aside>
			{current ? (
				<Detail
					key={current.automation.id}
					entry={current}
					onEdit={() => setMode({ kind: "edit", draft: current.automation })}
					onOpenRun={(runId) => setMode({ kind: "run", runId })}
					onChanged={overview.reload}
				/>
			) : null}
		</div>
	);
}

function lastRun(entry: AutomationOverview): AutomationRun | null {
	return entry.runs[0] ?? null;
}

function Chip({ tone, children }: { tone: keyof typeof TONE_CLASS; children: React.ReactNode }) {
	return (
		<span className={clsx("inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold", TONE_CLASS[tone])}>
			{children}
		</span>
	);
}

function AutomationCard({
	entry,
	selected,
	onClick,
}: {
	entry: AutomationOverview;
	selected: boolean;
	onClick: () => void;
}) {
	const { t } = useTranslation("views");
	const { automation } = entry;
	const last = lastRun(entry);
	const next = entry.upcoming[0];
	return (
		<button
			type="button"
			onClick={onClick}
			className={clsx(
				"focus-ring flex flex-col gap-1.5 rounded-xl bg-surface p-3 text-left transition-shadow duration-150",
				selected ? "ring-2 ring-accent" : "shadow-card hover:shadow-[var(--shadow-pop)]",
			)}
		>
			<span className="flex items-center gap-2">
				<span
					className={clsx("size-2 shrink-0 rounded-full", automation.enabled ? "bg-accent" : "bg-ink-faint")}
					aria-hidden="true"
				/>
				<span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{automation.name}</span>
				{entry.running ? <Spinner size={12} /> : null}
			</span>
			<span className="text-[12px] text-ink-muted">{rhythm(automation)}</span>
			<span className="flex items-center justify-between gap-2">
				<span className="truncate font-mono text-[11px] text-ink-muted">
					{!automation.enabled
						? t("automations.paused")
						: next
							? t("automations.nextRun", { when: relativeStamp(parseLocal(next.ready)) })
							: t("automations.noUpcoming")}
				</span>
				{last ? <Chip tone={runLabel(last).tone}>{runLabel(last).label}</Chip> : null}
			</span>
		</button>
	);
}

function Detail({
	entry,
	onEdit,
	onOpenRun,
	onChanged,
}: {
	entry: AutomationOverview;
	onEdit: () => void;
	onOpenRun: (runId: string) => void;
	onChanged: () => void;
}) {
	const { t } = useTranslation("views");
	const { automation } = entry;
	const [tab, setTab] = useState<"apercu" | "executions">("apercu");
	const [launching, setLaunching] = useState(false);
	const ready = entry.runs.find((run) => run.state === "ready" || run.state === "partial") ?? null;

	const runNow = async () => {
		setLaunching(true);
		try {
			await api.automations.runNow(automation.id);
			toast.success(t("automations.started", { name: automation.name }), {
				description: t("automations.startedHint"),
			});
			onChanged();
		} catch (error) {
			toast.error(String(error));
		} finally {
			setLaunching(false);
		}
	};

	const toggle = async () => {
		try {
			await api.automations.save({ ...automation, enabled: !automation.enabled });
			onChanged();
		} catch (error) {
			toast.error(String(error));
		}
	};

	return (
		<main className="flex min-w-0 flex-1 flex-col gap-4">
			<section className="rounded-2xl bg-surface px-5 pt-4 shadow-card">
				<div className="flex flex-wrap items-start gap-4">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2.5">
							<h2 className="text-[20px] font-semibold text-ink">{automation.name}</h2>
							<Chip tone={automation.enabled ? "accent" : "neutral"}>
								{automation.enabled ? t("automations.active") : t("automations.paused")}
							</Chip>
						</div>
						<p className="mt-1 line-clamp-2 max-w-3xl text-[13px] text-ink-muted">{automation.prompt}</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={() => void runNow()}
							disabled={launching || entry.running}
							className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover disabled:opacity-50"
						>
							{launching || entry.running ? <Spinner size={13} /> : <Play size={14} />}
							{entry.running ? t("automations.running") : t("automations.runNow")}
						</button>
						<button
							type="button"
							onClick={() => void toggle()}
							className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover"
						>
							{automation.enabled ? t("automations.pause") : t("automations.resume")}
						</button>
						<button
							type="button"
							onClick={onEdit}
							className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover"
						>
							{t("automations.edit")}
						</button>
						{ready ? (
							<button
								type="button"
								onClick={() => onOpenRun(ready.id)}
								className="focus-ring inline-flex h-9 items-center rounded-lg bg-accent px-3 text-[12.5px] font-semibold text-accent-ink hover:bg-accent-soft"
							>
								{t("automations.openLatest")}
							</button>
						) : null}
					</div>
				</div>
				<div role="tablist" className="mt-3 flex gap-1 border-t border-line-soft">
					{(
						[
							["apercu", t("automations.tab.overview")],
							["executions", t("automations.tab.runs", { count: entry.runs.length })],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							role="tab"
							aria-selected={tab === id}
							onClick={() => setTab(id)}
							className={clsx(
								"focus-ring -mb-px h-10 border-b-2 px-3 text-[12.5px] font-medium",
								tab === id ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
							)}
						>
							{label}
						</button>
					))}
				</div>
			</section>

			{tab === "apercu" ? (
				<>
					<Week entry={entry} />
					<div className="grid gap-4 xl:grid-cols-2">
						<section className="rounded-2xl bg-surface p-5 shadow-card">
							<h3 className="mb-2 text-[15px] font-semibold text-ink">{t("automations.recentRuns")}</h3>
							<RunList runs={entry.runs.slice(0, 5)} onOpen={onOpenRun} />
						</section>
						<WhatItDoes automation={automation} />
					</div>
				</>
			) : (
				<section className="rounded-2xl bg-surface p-5 shadow-card">
					<RunList runs={entry.runs} onOpen={onOpenRun} />
				</section>
			)}
		</main>
	);
}

function RunList({ runs, onOpen }: { runs: AutomationRun[]; onOpen: (runId: string) => void }) {
	const { t } = useTranslation("views");
	if (runs.length === 0) {
		return <p className="py-3 text-[13px] text-ink-muted">{t("automations.noRuns")}</p>;
	}
	return (
		<div className="flex flex-col">
			{runs.map((run) => {
				const { label, tone } = runLabel(run);
				const openable = run.state === "ready" || run.state === "partial" || run.state === "failed";
				const when = run.occurrence.startsWith("manual")
					? new Date(run.startedAt)
					: parseLocal(run.occurrence);
				const lines = run.parts.reduce((sum, part) => sum + part.lines.length, 0);
				const silent = run.sources.filter((source) => source.state === "silent");
				const note =
					run.state === "missed" || run.state === "failed"
						? run.reason
						: run.state === "running"
							? t("automations.run.reading")
							: [
									t("automations.run.lines", { count: lines }),
									run.trigger === "catchUp" ? t("automations.run.startedAt", { when: shortStamp(new Date(run.startedAt)) }) : "",
									silent.length > 0
										? t("automations.run.silent", {
												sources: silent.map((source) => SOURCE_LABEL[source.source] ?? source.source).join(", "),
											})
										: "",
								]
									.filter(Boolean)
									.join(" · ");
				return (
					<button
						key={run.id}
						type="button"
						disabled={!openable}
						onClick={() => onOpen(run.id)}
						className="focus-ring flex min-h-11 items-center gap-3 border-t border-line-soft px-1.5 py-2 text-left first:border-t-0 enabled:hover:bg-hover disabled:cursor-default"
					>
						<span className="w-[84px] shrink-0">
							<Chip tone={tone}>{label}</Chip>
						</span>
						<span className="min-w-0 flex-1">
							<span className="block text-[13px] font-semibold text-ink">
								{run.occurrence.startsWith("manual") ? t("automations.run.manual") : t("automations.run.scheduled")} · {shortStamp(when)}
							</span>
							<span className="block truncate text-[12px] text-ink-muted">{note}</span>
						</span>
						<span className="shrink-0 font-mono text-[11px] text-ink-muted">
							{run.durationMs > 0
								? t("automations.run.duration", {
										minutes: Math.floor(run.durationMs / 60_000),
										seconds: String(Math.round((run.durationMs % 60_000) / 1000)).padStart(2, "0"),
									})
								: "—"}
						</span>
					</button>
				);
			})}
		</div>
	);
}

function WhatItDoes({ automation }: { automation: Automation }) {
	const { t } = useTranslation("views");
	const sources = (Object.keys(automation.sources) as Array<keyof Automation["sources"]>).filter(
		(key) => automation.sources[key],
	);
	return (
		<section className="flex flex-col gap-3.5 rounded-2xl bg-surface p-5 shadow-card">
			<h3 className="text-[15px] font-semibold text-ink">{t("automations.what.title")}</h3>
			<div className="flex flex-col gap-1.5">
				<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">{t("automations.what.reads")}</span>
				<div className="flex flex-wrap gap-1.5">
					{sources.length === 0 ? <span className="text-[13px] text-ink-muted">{t("automations.what.noSource")}</span> : null}
					{sources.map((source) => (
						<span key={source} className="rounded-full bg-raised px-2.5 py-1 text-[12px] font-medium text-ink">
							{SOURCE_LABEL[source]}
						</span>
					))}
				</div>
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">{t("automations.what.ready")}</span>
				<span className="text-[13px] text-ink">
					{automation.leadMinutes > 0 ? t("automations.what.leadMinutes", { minutes: automation.leadMinutes }) : t("automations.what.onTime")}
					{automation.window === "since" ? t("automations.what.sincePrevious") : t("automations.what.last24h")}
				</span>
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">{t("automations.what.delivers")}</span>
				<span className="text-[13px] text-ink">
					{[
						automation.notify ? t("automations.what.notification") : "",
						automation.template === "daily" ? t("automations.what.dailyPart") : t("automations.what.renderHere"),
						automation.pdf ? t("automations.what.pdf") : "",
						automation.slackWebhook ? t("automations.what.slack") : "",
					]
						.filter(Boolean)
						.join(" · ")}
				</span>
			</div>
			<div className="flex items-center gap-2.5 rounded-xl bg-raised px-3 py-2.5">
				<Lock size={16} className="shrink-0 text-accent" />
				<span className="text-[12.5px] text-ink-muted">
					{t("automations.what.readOnly")}
				</span>
			</div>
		</section>
	);
}

/**
 * La semaine en cours : chaque bande est la période que couvre une exécution.
 *
 * C'est la réponse visuelle à « est-ce que rien ne tombe entre deux ? » : les
 * bandes se touchent, et un trou se verrait.
 */
function Week({ entry }: { entry: AutomationOverview }) {
	const { t } = useTranslation("views");
	const now = new Date();
	const start = useMemo(() => {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
		return day;
		// Le nom du jour sert de clé : `now` change à chaque rendu.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [now.toDateString()]);
	const span = 7 * 86_400_000;
	const pos = (date: Date) => Math.min(100, Math.max(0, ((date.getTime() - start.getTime()) / span) * 100));
	const inWeek = (date: Date) => date.getTime() >= start.getTime() && date.getTime() <= start.getTime() + span;

	type Mark = { at: Date; from: Date; state: "done" | "missed" | "partial" | "next"; label: string };
	const marks: Mark[] = [];
	for (const run of entry.runs) {
		if (run.occurrence.startsWith("manual") || run.state === "running") continue;
		const at = run.state === "missed" ? parseLocal(run.occurrence) : new Date(run.to);
		if (!inWeek(at) && !(run.from && inWeek(new Date(run.from)))) continue;
		marks.push({
			at,
			from: run.from ? new Date(run.from) : at,
			state: run.state === "missed" || run.state === "failed" ? "missed" : run.state === "partial" ? "partial" : "done",
			label: runLabel(run).label,
		});
	}
	// La prochaine couvre depuis la fin de la dernière réussie, même si elle
	// date de la semaine d'avant : c'est la bande qui part du bord gauche.
	const lastGood = entry.runs
		.filter((run) => (run.state === "ready" || run.state === "partial") && run.trigger !== "manual" && run.to)
		.map((run) => new Date(run.to))
		.sort((a, b) => b.getTime() - a.getTime())[0];
	let previous = marks.length > 0 ? marks.reduce((a, b) => (a.at > b.at ? a : b)).at : (lastGood ?? now);
	for (const next of entry.upcoming) {
		const ready = parseLocal(next.ready);
		if (!inWeek(ready)) break;
		marks.push({ at: ready, from: previous, state: "next", label: t("automations.week.planned") });
		previous = ready;
	}
	marks.sort((a, b) => a.at.getTime() - b.at.getTime());
	const tail = entry.upcoming.find((next) => !inWeek(parseLocal(next.ready)));

	const days = Array.from({ length: 7 }, (_, index) => {
		const day = new Date(start);
		day.setDate(start.getDate() + index);
		return `${DAY_LABELS[index]} ${day.getDate()}`;
	});

	return (
		<section className="rounded-2xl bg-surface p-5 shadow-card">
			<div className="flex flex-wrap items-baseline justify-between gap-3">
				<div>
					<h3 className="text-[15px] font-semibold text-ink">{t("automations.week.title")}</h3>
					<p className="mt-0.5 text-[12.5px] text-ink-muted">
						{t("automations.week.hint")}
					</p>
				</div>
				{!entry.automation.enabled ? <Chip tone="neutral">{t("automations.week.pausedNothing")}</Chip> : null}
			</div>
			<div className="mt-4 overflow-x-auto">
				<div className="min-w-[620px]">
					<div className="grid grid-cols-7 text-[11.5px] font-semibold text-ink-muted">
						{days.map((label) => (
							<span key={label}>{label}</span>
						))}
					</div>
					<div className="relative mt-2 h-[96px] rounded-xl bg-raised">
						{days.slice(1).map((label, index) => (
							<span
								key={label}
								className="absolute inset-y-0 w-px bg-line-soft"
								style={{ left: `${((index + 1) / 7) * 100}%` }}
								aria-hidden="true"
							/>
						))}
						{marks.map((mark, index) => {
							const left = pos(mark.from);
							const width = Math.max(0.6, pos(mark.at) - left);
							return (
								<div
									key={`band-${index}`}
									title={`${shortStamp(mark.from)} → ${shortStamp(mark.at)}`}
									className={clsx(
										"absolute top-3 flex h-7 items-center overflow-hidden rounded-md px-2",
										mark.state === "missed"
											? "bg-critical/20 text-critical"
											: index % 2 === 0
												? "bg-accent/30 text-accent"
												: "bg-info/30 text-info",
										// À venir : la même période, en pointillé — promise, pas encore couverte.
										mark.state === "next" && "border border-dashed border-current bg-transparent",
									)}
									style={{ left: `${left}%`, width: `${width}%` }}
								>
									<span className="truncate text-[10.5px] font-semibold">{mark.state === "missed" ? t("automations.week.missed") : ""}</span>
								</div>
							);
						})}
						{tail && previous.getTime() < start.getTime() + span ? (
							<div
								className="absolute top-3 h-7 rounded-md border border-dashed border-accent text-accent"
								style={{ left: `${pos(previous)}%`, width: `${100 - pos(previous)}%` }}
								title={t("automations.week.untilNext")}
							/>
						) : null}
						{marks.map((mark, index) => (
							<div
								key={`mark-${index}`}
								className="absolute top-[52px] flex -translate-x-1/2 flex-col items-center gap-1"
								style={{ left: `${pos(mark.at)}%` }}
								title={mark.label}
							>
								<span
									className={clsx(
										"size-3.5 rounded-full border-[3px]",
										mark.state === "missed"
											? "border-critical bg-surface"
											: mark.state === "next"
												? "border-accent bg-surface"
												: mark.state === "partial"
													? "border-warning bg-warning"
													: "border-accent bg-accent",
									)}
								/>
								<span className="font-mono text-[10.5px] text-ink-muted">
									{mark.at.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}
								</span>
							</div>
						))}
						<div className="absolute inset-y-0 w-0.5 bg-critical" style={{ left: `${pos(now)}%` }} aria-hidden="true" />
					</div>
					<div className="mt-3 flex flex-wrap gap-4 text-[11.5px] text-ink-muted">
						<span className="inline-flex items-center gap-1.5">
							<span className="size-3 rounded-full border-[3px] border-accent bg-accent" /> {t("automations.week.done")}
						</span>
						<span className="inline-flex items-center gap-1.5">
							<span className="size-3 rounded-full border-[3px] border-warning bg-warning" /> {t("automations.week.partial")}
						</span>
						<span className="inline-flex items-center gap-1.5">
							<span className="size-3 rounded-full border-[3px] border-accent bg-surface" /> {t("automations.week.planned")}
						</span>
						<span className="inline-flex items-center gap-1.5">
							<span className="h-3 w-0.5 bg-critical" /> {t("automations.week.now")}
						</span>
						<span className="inline-flex items-center gap-1.5">
							<Clock size={12} /> {t("automations.week.readyBefore", { minutes: entry.automation.leadMinutes })}
						</span>
					</div>
				</div>
			</div>
		</section>
	);
}

function Empty({ onCreate }: { onCreate: () => void }) {
	const { t } = useTranslation("views");
	return (
		<div className="flex flex-1 items-center justify-center p-6">
			<div className="flex max-w-lg flex-col items-center gap-4 rounded-2xl bg-surface p-8 text-center shadow-card">
				<span className="flex size-12 items-center justify-center rounded-2xl bg-accent-dim text-accent">
					<Clock size={24} />
				</span>
				<h1 className="text-[20px] font-semibold text-ink">{t("automations.empty.title")}</h1>
				<p className="text-[13.5px] leading-relaxed text-ink-muted">
					{t("automations.empty.body")}
				</p>
				<button
					type="button"
					onClick={onCreate}
					className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-accent-ink hover:bg-accent-soft"
				>
					<Plus size={15} /> {t("automations.empty.create")}
				</button>
			</div>
		</div>
	);
}
