import clsx from "clsx";
import { FlaskConical, Play, Plus, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MODELS } from "@/app/agents";
import { useCockpit } from "@/app/store";
import { useConfirm } from "@/components/Confirm";
import { Badge, Button, Empty, ErrorNote, Metric, Section, Spinner, ViewHeader } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { ReplaySetup, ReplayTrial } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/** Au plus cinq essais par campagne : la même borne que `replay::MAX_TRIALS`. */
const MAX_TRIALS = 5;

/** Le style des champs de l'app (voir `TextInput`). */
const FIELD =
	"focus-ring rounded-lg border border-line-soft bg-raised px-2.5 text-xs text-ink placeholder:text-ink-faint focus:border-accent/40";

const blankSetup = (label: string): ReplaySetup => ({
	label,
	engine: "",
	model: "",
	depth: "",
	instructions: "",
});

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Résolu, échoué, non jugeable ou interrompu : ce qu'un essai a donné. */
function outcome(trial: ReplayTrial): "resolved" | "failed" | "notJudgeable" | "error" {
	if (!trial.judgement) return "error";
	return trial.judgement.verdict.kind as "resolved" | "failed" | "notJudgeable";
}

/**
 * Le rejeu de l'historique : juger une configuration d'agents sur les problèmes
 * que le dépôt a déjà résolus.
 *
 * Chaque PR fusionnée qui ajoute des tests est un cas. Un agent repart du
 * commit d'avant avec ce qu'avait l'humain, et son résultat est jugé par les
 * tests de l'humain, qu'il n'a jamais vus. Deux configurations jouées sur les
 * mêmes cas se comparent sur autre chose qu'une impression.
 *
 * Chaque essai est une vraie tâche d'agent : l'écran dit combien il en lance et
 * ce qu'elles coûteront d'après les précédentes, et demande l'accord avant.
 */
export function ReplayView() {
	const { activeProject, notify } = useCockpit();
	const { confirm } = useConfirm();
	const { t } = useTranslation("views");
	const repo = activeProject?.mainRepo ?? "";

	const progress = useAsync(() => api.replay.progress(), [], { pollMs: 5_000 });
	// Une campagne tourne peut-être sur un autre projet : elle n'a rien à faire
	// ni dans les chiffres ni dans le bouton de celui-ci.
	const running = progress.data != null && progress.data.repo === repo;
	const busyElsewhere = progress.data != null && progress.data.repo !== repo;
	const cases = useAsync(() => (repo ? api.replay.cases(repo) : Promise.resolve([])), [repo]);
	const trials = useAsync(
		() => (repo ? api.replay.trials(repo) : Promise.resolve([])),
		[repo, progress.data?.done],
	);

	const [chosen, setChosen] = useState<number[]>([]);
	const [setups, setSetups] = useState<ReplaySetup[]>([blankSetup("A")]);
	const [launching, setLaunching] = useState(false);

	const total = chosen.length * setups.length;
	const tooMany = total > MAX_TRIALS;

	// L'estimation vient des essais déjà joués sur ce dépôt : c'est la seule
	// mesure honnête de ce que coûte une tâche ici.
	const estimate = useMemo(() => {
		const worked = (trials.data ?? []).filter((trial) => trial.durationMs > 0);
		const minutes = median(worked.map((trial) => trial.durationMs / 60_000));
		const cost = median(worked.map((trial) => trial.costUsd));
		return minutes == null || cost == null ? null : { minutes, cost };
	}, [trials.data]);

	// Une ligne par configuration : résolus sur jugés, et ce que ça a coûté.
	const report = useMemo(() => {
		const groups = new Map<string, ReplayTrial[]>();
		for (const trial of trials.data ?? []) {
			const key = trial.setup.label || t("replay.unnamed");
			groups.set(key, [...(groups.get(key) ?? []), trial]);
		}
		return [...groups.entries()].map(([label, list]) => {
			const counts = { resolved: 0, failed: 0, notJudgeable: 0, error: 0 };
			for (const trial of list) counts[outcome(trial)] += 1;
			const worked = list.filter((trial) => trial.durationMs > 0);
			return {
				label,
				counts,
				judged: counts.resolved + counts.failed,
				cost: median(worked.map((trial) => trial.costUsd)),
				minutes: median(worked.map((trial) => trial.durationMs / 60_000)),
			};
		});
	}, [trials.data, t]);

	const toggle = (number: number) =>
		setChosen((current) =>
			current.includes(number) ? current.filter((entry) => entry !== number) : [...current, number],
		);
	const patchSetup = (index: number, patch: Partial<ReplaySetup>) =>
		setSetups((current) => current.map((setup, at) => (at === index ? { ...setup, ...patch } : setup)));

	const launch = async () => {
		if (!repo || total === 0 || tooMany) return;
		const message = estimate
			? t("replay.confirmEstimate", {
					count: total,
					minutes: Math.round(estimate.minutes * total),
					cost: (estimate.cost * total).toFixed(2),
				})
			: t("replay.confirmNoEstimate", { count: total });
		const ok = await confirm({ title: t("replay.confirmTitle", { count: total }), message, confirmLabel: t("replay.launch") });
		if (!ok) return;
		setLaunching(true);
		try {
			const engaged = await api.replay.run(repo, chosen, setups);
			notify(t("replay.launched", { count: engaged }));
			setChosen([]);
			progress.reload();
		} catch (error) {
			notify(String(error));
		} finally {
			setLaunching(false);
		}
	};

	if (!repo) {
		return (
			<>
				<ViewHeader title={t("replay.title")} subtitle={t("replay.subtitle")} />
				<Empty icon={FlaskConical} message={t("replay.noProject")} />
			</>
		);
	}

	return (
		<>
			<ViewHeader
				title={t("replay.title")}
				subtitle={t("replay.subtitle")}
				actions={
					<>
						{cases.loading || trials.loading ? <Spinner /> : null}
						<Button
							size="sm"
							icon={RefreshCw}
							title={t("replay.refresh")}
							onClick={() => {
								cases.reload();
								trials.reload();
							}}
						/>
					</>
				}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<p className="mb-4 max-w-3xl text-[12px] leading-relaxed text-ink-muted">{t("replay.intro")}</p>

				{running ? (
					<div className="panel mb-4 flex items-center gap-2.5 px-3 py-2.5 text-[12px] text-ink">
						<Spinner />
						{t("replay.running", { done: progress.data?.done ?? 0, total: progress.data?.total ?? 0 })}
					</div>
				) : null}

				<div className="grid grid-cols-2 gap-5">
					<Section title={t("replay.cases")} count={cases.data?.length}>
						{cases.error ? <ErrorNote error={cases.error} onRetry={cases.reload} /> : null}
						{(cases.data ?? []).length === 0 && !cases.error && !cases.loading ? (
							<Empty message={t("replay.noCases")} hint={t("replay.noCasesHint")} />
						) : null}
						<div className="flex flex-col gap-1">
							{(cases.data ?? []).map((item) => {
								const number = item.number ?? 0;
								const on = chosen.includes(number);
								return (
									<button
										key={`${item.head}`}
										type="button"
										disabled={item.number == null || running}
										onClick={() => toggle(number)}
										className={clsx(
											"panel focus-ring flex items-center gap-2.5 px-3 py-2 text-left transition-colors",
											on ? "ring-1 ring-accent" : "hover:bg-raised",
										)}
									>
										<input type="checkbox" readOnly checked={on} className="pointer-events-none" />
										<span className="min-w-0 flex-1">
											<span className="block truncate text-[12.5px] text-ink">{item.title}</span>
											<span className="block truncate font-mono text-[10px] text-ink-faint">
												{t("replay.caseMeta", { tests: item.tests.length, files: item.sources.length })}
											</span>
										</span>
										{item.number != null ? <Badge mono>#{item.number}</Badge> : null}
									</button>
								);
							})}
						</div>
					</Section>

					<Section
						title={t("replay.setups")}
						count={setups.length}
						actions={
							setups.length < 2 ? (
								<Button
									size="sm"
									icon={Plus}
									onClick={() =>
										setSetups((current) => {
											const taken = new Set(current.map((setup) => setup.label));
											const label = ["A", "B", "C"].find((name) => !taken.has(name)) ?? "B";
											return [...current, blankSetup(label)];
										})
									}
								>
									{t("replay.addSetup")}
								</Button>
							) : null
						}
					>
						<div className="flex flex-col gap-2">
							{setups.map((setup, index) => (
								<div key={index} className="panel flex flex-col gap-2 p-3">
									<div className="flex items-center gap-2">
										<input
											value={setup.label}
											onChange={(event) => patchSetup(index, { label: event.target.value })}
											placeholder={t("replay.labelPlaceholder")}
											className={clsx(FIELD, "h-7 min-w-0 flex-1")}
										/>
										<select
											value={setup.model}
											onChange={(event) => patchSetup(index, { model: event.target.value })}
											className={clsx(FIELD, "h-7")}
											title={t("replay.model")}
										>
											{MODELS.map((model) => (
												<option key={model.id} value={model.id}>
													{model.id ? model.label : t("replay.defaultModel")}
												</option>
											))}
										</select>
										{setups.length > 1 ? (
											<Button
												size="sm"
												icon={X}
												title={t("replay.removeSetup")}
												onClick={() => setSetups((current) => current.filter((_, at) => at !== index))}
											/>
										) : null}
									</div>
									<textarea
										value={setup.instructions}
										onChange={(event) => patchSetup(index, { instructions: event.target.value })}
										placeholder={t("replay.instructionsPlaceholder")}
										rows={2}
										className={clsx(FIELD, "resize-y py-1.5")}
									/>
								</div>
							))}
						</div>

						<div className="mt-3 flex items-center gap-3">
							<span className={clsx("text-[12px]", tooMany ? "text-critical" : "text-ink-muted")}>
								{tooMany
									? t("replay.tooMany", { count: total, max: MAX_TRIALS })
									: total === 0
										? t("replay.pickCases")
										: estimate
											? t("replay.summaryEstimate", {
													count: total,
													minutes: Math.round(estimate.minutes * total),
													cost: (estimate.cost * total).toFixed(2),
												})
											: t("replay.summary", { count: total })}
							</span>
							<span className="flex-1" />
							<Button
								variant="solid"
								icon={Play}
								disabled={total === 0 || tooMany || running || busyElsewhere}
								loading={launching}
								onClick={() => void launch()}
							>
								{t("replay.launch")}
							</Button>
						</div>
					</Section>
				</div>

				<Section title={t("replay.report")} count={trials.data?.length} className="mt-5">
					{trials.error ? <ErrorNote error={trials.error} onRetry={trials.reload} /> : null}
					{(trials.data ?? []).length === 0 && !trials.error ? (
						<Empty message={t("replay.noTrials")} />
					) : null}
					{report.length > 0 ? (
						<div className="mb-3 grid grid-cols-4 gap-2.5">
							{report.map((row) => (
								<Metric
									key={row.label}
									label={row.label}
									value={`${row.counts.resolved}/${row.judged}`}
									tone={row.judged > 0 && row.counts.resolved === row.judged ? "success" : "neutral"}
									hint={[
										row.cost != null ? t("replay.medianCost", { cost: row.cost.toFixed(2) }) : null,
										row.minutes != null ? t("replay.medianMinutes", { minutes: Math.round(row.minutes) }) : null,
										row.counts.notJudgeable > 0
											? t("replay.notJudgeableCount", { count: row.counts.notJudgeable })
											: null,
									]
										.filter(Boolean)
										.join(" · ")}
								/>
							))}
						</div>
					) : null}
					<div className="flex flex-col gap-1">
						{(trials.data ?? []).slice(0, 40).map((trial, index) => {
							const kind = outcome(trial);
							const verdict = trial.judgement?.verdict;
							const detail =
								verdict?.kind === "failed"
									? verdict.command
									: verdict?.kind === "notJudgeable"
										? verdict.reason
										: (trial.error ?? "");
							return (
								<div key={`${trial.at}-${index}`} className="panel flex items-center gap-2.5 px-3 py-2">
									<Badge
										tone={
											kind === "resolved"
												? "success"
												: kind === "failed"
													? "critical"
													: kind === "error"
														? "warning"
														: "neutral"
										}
									>
										{t(`replay.outcome.${kind}`)}
									</Badge>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[12.5px] text-ink">
											{trial.number != null ? `#${trial.number} · ` : ""}
											{trial.title}
										</span>
										{detail ? (
											<span className="block truncate text-[10.5px] text-ink-faint" title={detail}>
												{detail}
											</span>
										) : null}
									</span>
									<span className="shrink-0 text-[11px] text-ink-muted">
										{trial.setup.label || t("replay.unnamed")}
									</span>
									{trial.durationMs > 0 ? (
										<span className="shrink-0 font-mono text-[10px] text-ink-faint">
											{t("replay.trialCost", {
												cost: trial.costUsd.toFixed(2),
												minutes: Math.max(1, Math.round(trial.durationMs / 60_000)),
											})}
										</span>
									) : null}
								</div>
							);
						})}
					</div>
				</Section>
			</div>
		</>
	);
}
