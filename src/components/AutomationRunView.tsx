import clsx from "clsx";
import { ChevronLeft, ChevronRight, ClipboardCopy, ExternalLink, FileDown, FolderOpen, MonitorPlay, RotateCw, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCockpit } from "@/app/store";
import { useConfirm } from "@/components/Confirm";
import { Spinner } from "@/components/ui";
import { longDay, runLabel, runMarkdown, shortStamp, SOURCE_COLOR, SOURCE_LABEL, TONE_CLASS } from "@/lib/automations";
import { requestDailyPresentation } from "@/lib/dailyHandoff";
import { api } from "@/lib/ipc";
import type { AutomationItem, AutomationOverview } from "@/lib/types";
import { locale } from "@/i18n";
import { useTranslation } from "react-i18next";

/**
 * Le rendu d'une exécution, et d'où vient chacune de ses lignes.
 *
 * Une ligne se clique pour être écartée de la présentation : elle reste dans
 * l'exécution, barrée, et se remet d'un autre clic. À droite, la provenance
 * et la trace — ce qui a été lu, ce qui n'a pas répondu, ce que la rédaction
 * a coûté.
 */
export function AutomationRunView({
	entry,
	runId,
	onPick,
	onClose,
	onChanged,
}: {
	entry: AutomationOverview;
	runId: string;
	onPick: (runId: string) => void;
	onClose: () => void;
	onChanged: () => void;
}) {
	const { t } = useTranslation("components1");
	const { go } = useCockpit();
	const { confirm } = useConfirm();
	const [busy, setBusy] = useState<"" | "pdf" | "slack" | "correct">("");
	const [correction, setCorrection] = useState("");
	const openable = entry.runs.filter((run) => run.state === "ready" || run.state === "partial" || run.state === "failed");
	const index = openable.findIndex((run) => run.id === runId);
	const run = openable[index] ?? openable[0];
	const [dropped, setDropped] = useState<Set<string>>(() => new Set(run?.dropped ?? []));
	const [shownRun, setShownRun] = useState(run?.id);
	if (run && run.id !== shownRun) {
		setShownRun(run.id);
		setDropped(new Set(run.dropped));
	}

	if (!run) {
		return (
			<div className="flex flex-1 items-center justify-center text-[13px] text-ink-muted">{t("automationRunView.empty")}</div>
		);
	}

	const { automation } = entry;
	const byId = new Map(run.items.map((item) => [item.id, item]));
	const total = run.parts.reduce((sum, part) => sum + part.lines.length, 0);
	const kept = run.parts.reduce((sum, part) => sum + part.lines.filter((line) => !dropped.has(line.id)).length, 0);
	const label = runLabel(run);
	const silent = run.sources.filter((source) => source.state === "silent");

	const toggle = (line: string) => {
		const out = !dropped.has(line);
		const nextSet = new Set(dropped);
		if (out) nextSet.add(line);
		else nextSet.delete(line);
		setDropped(nextSet);
		void api.automations.dropLine(automation.id, run.id, line, out).then(onChanged).catch(() => undefined);
	};

	const copy = () => {
		void navigator.clipboard.writeText(runMarkdown(automation.name, { ...run, dropped: [...dropped] }));
		toast.success(t("automationRunView.copied"));
	};

	const rerun = async () => {
		try {
			await api.automations.runNow(automation.id);
			toast.success(t("automationRunView.rerun"), { description: t("automationRunView.rerunDescription") });
			onChanged();
			onClose();
		} catch (error) {
			toast.error(String(error));
		}
	};

	const exportPdf = async () => {
		setBusy("pdf");
		try {
			await api.automations.exportPdf(automation.id, run.id);
			onChanged();
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy("");
		}
	};

	const postSlack = async () => {
		const ok = await confirm({
			title: t("automationRunView.slackConfirmTitle"),
			message: t("automationRunView.slackConfirmMessage", { count: kept }),
			confirmLabel: t("automationRunView.publish"),
		});
		if (!ok) return;
		setBusy("slack");
		try {
			await api.automations.postSlack(automation.id, run.id);
			toast.success(t("automationRunView.postedSlack"));
			onChanged();
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy("");
		}
	};

	const correct = async () => {
		if (!correction.trim()) return;
		setBusy("correct");
		try {
			await api.automations.correct(automation.id, correction);
			setCorrection("");
			toast.success(t("automationRunView.correctionAdded"), { description: t("automationRunView.correctionAddedDescription") });
			onChanged();
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy("");
		}
	};

	const counts = ["github", "tracker", "sentry", "cockpit"].map((source) => ({
		source,
		count: run.items.filter((item) => item.source === source).length,
	}));
	const used = counts.reduce((sum, entry) => sum + entry.count, 0);

	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-4">
			<div className="mx-auto flex max-w-[1320px] flex-col gap-4">
				<div className="flex flex-wrap items-end justify-between gap-4 px-1 pt-1">
					<div className="flex flex-col gap-1.5">
						<nav aria-label={t("automationRunView.breadcrumb")} className="flex flex-wrap gap-1.5 text-[12.5px] font-semibold">
							<button type="button" onClick={onClose} className="focus-ring rounded text-accent hover:underline">
								{t("automationRunView.automations")}
							</button>
							<span className="text-ink-muted">/</span>
							<button type="button" onClick={onClose} className="focus-ring rounded text-accent hover:underline">
								{automation.name}
							</button>
						</nav>
						<div className="flex flex-wrap items-center gap-2.5">
							<button
								type="button"
								aria-label={t("automationRunView.previous")}
								disabled={index >= openable.length - 1}
								onClick={() => onPick(openable[index + 1].id)}
								className="focus-ring flex size-8 items-center justify-center rounded-lg border border-line bg-surface hover:bg-hover disabled:opacity-40"
							>
								<ChevronLeft size={15} />
							</button>
							<h1 className="text-[22px] font-semibold text-ink">
								{automation.name} · {longDay(new Date(run.to))}
							</h1>
							<button
								type="button"
								aria-label={t("automationRunView.next")}
								disabled={index <= 0}
								onClick={() => onPick(openable[index - 1].id)}
								className="focus-ring flex size-8 items-center justify-center rounded-lg border border-line bg-surface hover:bg-hover disabled:opacity-40"
							>
								<ChevronRight size={15} />
							</button>
							<span className={clsx("inline-flex h-6 items-center rounded-full px-2.5 text-[11.5px] font-semibold", TONE_CLASS[label.tone])}>
								{label.label}
								{silent.length > 0
									? ` · ${t("automationRunView.without", { sources: silent.map((source) => SOURCE_LABEL[source.source] ?? source.source).join(", ") })}`
									: ""}
							</span>
						</div>
						<span className="font-mono text-[12px] text-ink-muted">
							{t("automationRunView.covers", { from: shortStamp(new Date(run.from)), to: shortStamp(new Date(run.to)) })}
							{run.endedAt
								? ` · ${t("automationRunView.readyAt", { time: new Date(run.endedAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) })}`
								: ""}
						</span>
					</div>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={copy}
							disabled={run.state === "failed"}
							className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover disabled:opacity-50"
						>
							<ClipboardCopy size={14} /> {t("automationRunView.copyMarkdown")}
						</button>
						{run.state !== "failed" ? (
							<button
								type="button"
								onClick={() => void exportPdf()}
								disabled={busy === "pdf"}
								className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover disabled:opacity-50"
							>
								{busy === "pdf" ? <Spinner size={13} /> : <FileDown size={14} />}
								{run.exports.length > 0 ? t("automationRunView.redoPdf") : t("automationRunView.exportPdf")}
							</button>
						) : null}
						{run.exports.length > 0 ? (
							<button
								type="button"
								onClick={() => void api.automations.revealExports(automation.id).catch(() => undefined)}
								title={t("automationRunView.pdfFolderTitle")}
								className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover"
							>
								<FolderOpen size={14} /> {t("automationRunView.folder")}
							</button>
						) : null}
						{automation.slackWebhook && run.state !== "failed" ? (
							<button
								type="button"
								onClick={() => void postSlack()}
								disabled={busy === "slack" || Boolean(run.postedAt)}
								title={
									run.postedAt
										? t("automationRunView.postedOn", { date: shortStamp(new Date(run.postedAt)) })
										: t("automationRunView.publishTitle")
								}
								className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover disabled:opacity-60"
							>
								{busy === "slack" ? <Spinner size={13} /> : <Send size={14} />}
								{run.postedAt ? t("automationRunView.postedSlack") : t("automationRunView.sendSlack")}
							</button>
						) : null}
						{automation.template === "daily" && run.state !== "failed" ? (
							<button
								type="button"
								onClick={() => {
									requestDailyPresentation();
									go("team");
								}}
								className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-semibold text-accent-ink hover:bg-accent-soft"
							>
								<MonitorPlay size={14} /> {t("automationRunView.presentDaily")}
							</button>
						) : null}
					</div>
				</div>

				<div className="flex flex-wrap items-start gap-4">
					<article className="flex min-w-0 flex-[999_1_600px] flex-col gap-5 rounded-2xl bg-surface p-6 shadow-card">
						{run.state === "failed" ? (
							<div className="rounded-xl bg-critical/10 p-4 text-[13.5px] text-critical">
								{t("automationRunView.failed", { reason: run.reason })}
							</div>
						) : (
							<>
								<div className="flex flex-wrap items-start justify-between gap-3">
									{run.headline ? <p className="max-w-3xl text-[15px] font-medium text-ink">{run.headline}</p> : <span />}
									<span className="font-mono text-[12px] text-ink-muted">
										{t("automationRunView.kept", { kept, total })}
									</span>
								</div>
								<p className="-mt-3 text-[12.5px] text-ink-muted">
									{t("automationRunView.clickHint")}
								</p>
								{run.parts.map((part, partIndex) => (
									<section key={part.title} className="flex flex-col gap-1">
										<div className="flex items-center gap-2.5 px-3 pb-1">
											<span className={clsx("size-2.5 rounded-[3px]", PART_COLORS[partIndex % PART_COLORS.length])} />
											<h2 className="text-[15.5px] font-semibold text-ink">{part.title}</h2>
											<span className="font-mono text-[11.5px] text-ink-muted">
												{part.lines.filter((line) => !dropped.has(line.id)).length}
											</span>
										</div>
										{part.lines.length === 0 ? <p className="px-3 text-[13px] text-ink-muted">{t("automationRunView.nothing")}</p> : null}
										{part.lines.map((line) => {
											const out = dropped.has(line.id);
											return (
												<div
													key={line.id}
													className={clsx("flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-hover", out && "opacity-55")}
												>
													<button
														type="button"
														aria-pressed={out}
														onClick={() => toggle(line.id)}
														className="focus-ring flex min-w-0 flex-1 flex-col gap-1 rounded text-left"
														title={out ? t("automationRunView.restore") : t("automationRunView.drop")}
													>
														<span className={clsx("text-[14px] font-semibold text-ink", out && "line-through")}>{line.title}</span>
														{line.detail ? (
															<span className={clsx("text-[13px] text-ink-muted", out && "line-through")}>{line.detail}</span>
														) : null}
													</button>
													<span className="flex max-w-[45%] shrink-0 flex-wrap justify-end gap-1.5">
														{line.unsourced ? (
															<span className="rounded-md bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
																{t("automationRunView.unsourced")}
															</span>
														) : null}
														{line.refs.map((ref) => (
															<RefChip key={ref} item={byId.get(ref)} reference={ref} />
														))}
														{out ? (
															<span className="rounded-md bg-raised px-2 py-0.5 text-[11px] font-semibold text-ink-muted">{t("automationRunView.dropped")}</span>
														) : null}
													</span>
												</div>
											);
										})}
									</section>
								))}
							</>
						)}
					</article>

					<aside className="flex min-w-[300px] flex-[1_1_340px] flex-col gap-4 lg:max-w-[420px]">
						<section className="flex flex-col gap-3 rounded-2xl bg-surface p-5 shadow-card">
							<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								{t("automationRunView.sourcesTitle")}
							</span>
							{used > 0 ? (
								<div className="flex h-3 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={t("automationRunView.sourcesChart")}>
									{counts
										.filter((entry) => entry.count > 0)
										.map((entry) => (
											<span key={entry.source} style={{ flex: entry.count, background: SOURCE_COLOR[entry.source] }} />
										))}
								</div>
							) : null}
							<div className="grid grid-cols-2 gap-2">
								{counts.map((entry) => (
									<span key={entry.source} className="flex items-center gap-2 text-[12.5px] text-ink">
										<span className="size-2.5 rounded-[3px]" style={{ background: SOURCE_COLOR[entry.source] }} />
										{SOURCE_LABEL[entry.source]}
										<span className="ml-auto font-mono text-ink-muted">{entry.count}</span>
									</span>
								))}
							</div>
						</section>

						<section className="flex flex-col rounded-2xl bg-surface p-5 shadow-card">
							<span className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">{t("automationRunView.trace")}</span>
							<TraceRow ok title={t("automationRunView.period")} note={`${shortStamp(new Date(run.from))} → ${shortStamp(new Date(run.to))}`} />
							{run.sources.map((source) => (
								<TraceRow
									key={source.source}
									ok={source.state !== "silent"}
									muted={source.state === "unconfigured"}
									title={t(
										source.state === "read"
											? "automationRunView.source.read"
											: source.state === "silent"
												? "automationRunView.source.silent"
												: "automationRunView.source.unconfigured",
										{ source: SOURCE_LABEL[source.source] ?? source.source },
									)}
									note={
										source.state === "read"
											? t("automationRunView.source.items", { count: source.count })
											: source.state === "silent"
												? t("automationRunView.source.silentNote", {
														note: source.note || t("automationRunView.source.noAnswer"),
													})
												: t("automationRunView.source.unconfiguredNote", { note: source.note })
									}
								/>
							))}
							{run.state !== "failed" ? (
								<TraceRow
									ok
									title={t("automationRunView.writing")}
									note={
										run.valuation?.provenance === "none"
											? t("automationRunView.nothingToWrite")
											: t("automationRunView.toollessAgent", {
													valuation:
														run.valuation?.usd != null
															? t("automationRunView.valued", { cost: run.valuation.usd.toFixed(2) })
															: t("automationRunView.unknownValuation"),
												})
									}
								/>
							) : (
								<TraceRow ok={false} title={t("automationRunView.writing")} note={run.reason} />
							)}
							<button
								type="button"
								onClick={() => void rerun()}
								className="focus-ring mt-3 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover"
							>
								<RotateCw size={14} /> {t("automationRunView.rerunButton")}
							</button>
						</section>

						<section className="flex flex-col gap-2.5 rounded-2xl bg-surface p-5 shadow-card">
							<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								{t("automationRunView.correctTitle")}
							</span>
							<p className="text-[12.5px] text-ink-muted">
								{t("automationRunView.correctHint")}
							</p>
							<label className="flex flex-col gap-1.5">
								<span className="text-[12.5px] font-semibold text-ink">{t("automationRunView.correction")}</span>
								<input
									value={correction}
									onChange={(event) => setCorrection(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void correct();
									}}
									placeholder={t("automationRunView.correctionPlaceholder")}
									className="focus-ring h-10 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink"
								/>
							</label>
							<button
								type="button"
								onClick={() => void correct()}
								disabled={!correction.trim() || busy === "correct"}
								className="focus-ring inline-flex h-9 items-center justify-center rounded-lg bg-accent px-3 text-[12.5px] font-semibold text-accent-ink hover:bg-accent-soft disabled:opacity-50"
							>
								{t("automationRunView.addCorrection")}
							</button>
							{automation.corrections.length > 0 ? (
								<span className="text-[12px] text-ink-muted">
									{t("automationRunView.correctionsInPlace", { count: automation.corrections.length })}
								</span>
							) : null}
						</section>
					</aside>
				</div>
			</div>
		</div>
	);
}

const PART_COLORS = ["bg-accent", "bg-info", "bg-warning", "bg-ink-muted"];

function RefChip({ item, reference }: { item?: AutomationItem; reference: string }) {
	const label = reference.replace(/^gh:[^#]*#/, "PR #").replace(/^tk:/, "").replace(/^ck:/, "");
	const tone =
		item?.source === "tracker"
			? "bg-info/12 text-info"
			: item?.source === "cockpit"
				? "bg-accent-dim text-accent"
				: "bg-raised text-ink";
	const content = (
		<>
			{label}
			{item?.url ? <ExternalLink size={10} /> : null}
		</>
	);
	if (!item?.url) {
		return <span className={clsx("inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px]", tone)}>{content}</span>;
	}
	return (
		<button
			type="button"
			title={item.title}
			onClick={() => void api.system.openUrl(item.url).catch(() => undefined)}
			className={clsx("focus-ring inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] hover:underline", tone)}
		>
			{content}
		</button>
	);
}

function TraceRow({ ok, muted, title, note }: { ok: boolean; muted?: boolean; title: string; note: string }) {
	return (
		<div className="flex items-start gap-3 border-t border-line-soft py-2.5 first-of-type:border-t-0">
			<span
				className={clsx(
					"flex size-5.5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold",
					muted ? "bg-raised text-ink-muted" : ok ? "bg-accent-dim text-accent" : "bg-warning/15 text-warning",
				)}
			>
				{muted ? "–" : ok ? "✓" : "!"}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-[13px] font-semibold text-ink">{title}</span>
				<span className="block text-[12.5px] text-ink-muted">{note}</span>
			</span>
		</div>
	);
}
