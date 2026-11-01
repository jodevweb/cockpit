import { locale } from "@/i18n";
import clsx from "clsx";
import { ArrowLeft, FlaskConical, Lock, X } from "lucide-react";
import type { TFunction } from "i18next";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useConfirm } from "@/components/Confirm";
import { Modal, Spinner } from "@/components/ui";
import { DAY_LABELS, hm, longDay, previewSchedule, runLabel, shortStamp, SOURCE_LABEL, TONE_CLASS } from "@/lib/automations";
import { api } from "@/lib/ipc";
import type { Automation, AutomationRun } from "@/lib/types";

/**
 * Le réglage d'une automatisation, de son rythme à sa consigne.
 *
 * À droite, ce qui va se passer, recalculé à chaque clic : les trois prochains
 * rendez-vous et la période que chacun couvrira. On règle un rythme en le
 * voyant, pas en l'imaginant.
 */

type ModelId = "daily" | "revue" | "sprint" | "sentry" | "blank";

function models(t: TFunction): Array<{ id: ModelId; name: string; description: string; make: () => Automation }> {
	const named = (id: Exclude<ModelId, "blank">) => ({
		id,
		name: t(`automationEditor.models.${id}.name`),
		description: t(`automationEditor.models.${id}.description`),
	});
	return [
		{
			...named("daily"),
			make: () => ({
				...blank(),
				name: t("automationEditor.models.daily.name"),
				template: "daily",
				prompt: t("automationEditor.models.daily.prompt"),
				sources: { github: true, tracker: true, cockpit: true, sentry: true },
			}),
		},
		{
			...named("revue"),
			make: () => ({
				...blank(),
				name: t("automationEditor.models.revue.name"),
				days: [1, 2, 3, 4, 5],
				time: "09:00",
				leadMinutes: 15,
				sources: { github: true, tracker: false, cockpit: false, sentry: false },
				prompt: t("automationEditor.models.revue.prompt"),
			}),
		},
		{
			...named("sprint"),
			make: () => ({
				...blank(),
				name: t("automationEditor.models.sprint.name"),
				days: [5],
				time: "17:00",
				leadMinutes: 60,
				pdf: true,
				prompt: t("automationEditor.models.sprint.prompt"),
			}),
		},
		{
			...named("sentry"),
			make: () => ({
				...blank(),
				name: t("automationEditor.models.sentry.name"),
				days: [1, 2, 3, 4, 5],
				time: "10:00",
				leadMinutes: 0,
				window: "day",
				sources: { github: false, tracker: false, cockpit: false, sentry: true },
				prompt: t("automationEditor.models.sentry.prompt"),
			}),
		},
		{
			id: "blank",
			name: t("automationEditor.models.blank.name"),
			description: t("automationEditor.models.blank.description"),
			make: () => blank(),
		},
	];
}

function blank(): Automation {
	return {
		id: "",
		name: "",
		template: "blank",
		days: [1, 3, 5],
		time: "14:00",
		leadMinutes: 30,
		window: "since",
		sources: { github: true, tracker: true, cockpit: true, sentry: false },
		prompt: "",
		catchUp: true,
		notify: true,
		enabled: true,
		createdAt: "",
		corrections: [],
		pdf: false,
		slackWebhook: "",
	};
}

const leads = (t: TFunction): Array<[number, string]> => [
	[0, t("automationEditor.leads.onTime")],
	[15, t("automationEditor.leads.minutes", { count: 15 })],
	[30, t("automationEditor.leads.minutes", { count: 30 })],
	[60, t("automationEditor.leads.hour")],
];

const SOURCE_KEYS: Array<{ key: keyof Automation["sources"]; brand?: string }> = [
	{ key: "github", brand: "GitHub" },
	{ key: "tracker" },
	{ key: "cockpit", brand: "Cockpit" },
	{ key: "sentry", brand: "Sentry" },
];

const sourceList = (t: TFunction): Array<{ key: keyof Automation["sources"]; name: string; what: string }> =>
	SOURCE_KEYS.map(({ key, brand }) => ({
		key,
		name: brand ?? t(`automationEditor.sources.${key}.name`),
		what: t(`automationEditor.sources.${key}.what`),
	}));

export function AutomationEditor({
	initial,
	onClose,
	onSaved,
	onRemoved,
}: {
	initial: Automation | null;
	onClose: () => void;
	onSaved: (saved: Automation) => void;
	onRemoved: () => void;
}) {
	const { t } = useTranslation("components1");
	const MODELS = models(t);
	const LEADS = leads(t);
	const SOURCES = sourceList(t);
	const creating = initial === null;
	const [model, setModel] = useState<string>("daily");
	const [draft, setDraft] = useState<Automation>(() => initial ?? MODELS[0].make());
	const [saving, setSaving] = useState(false);
	const [trial, setTrial] = useState<{ running: boolean; run: AutomationRun | null; error: string }>({
		running: false,
		run: null,
		error: "",
	});
	const [showTrial, setShowTrial] = useState(false);

	const tryNow = async () => {
		setShowTrial(true);
		setTrial({ running: true, run: null, error: "" });
		try {
			setTrial({ running: false, run: await api.automations.tryOnce(draft), error: "" });
		} catch (error) {
			setTrial({ running: false, run: null, error: String(error) });
		}
	};
	const { confirm } = useConfirm();

	const set = <K extends keyof Automation>(key: K, value: Automation[K]) =>
		setDraft((current) => ({ ...current, [key]: value }));
	const next = previewSchedule(draft);
	const picked = DAY_LABELS.filter((_, index) => draft.days.includes(index + 1)).map((day) => (locale().startsWith("fr") ? day.toLowerCase() + "." : day));
	const sources = SOURCES.filter((source) => draft.sources[source.key]).map((source) => source.name);
	const sentenceValues = {
		days: picked.join(", "),
		time: draft.time,
		sources: sources.length > 0 ? sources.join(", ") : t("automationEditor.sentence.noSource"),
		output: draft.template === "daily" ? t("automationEditor.sentence.outputDaily") : t("automationEditor.sentence.output"),
		minutes: draft.leadMinutes,
	};
	const sentence =
		picked.length === 0
			? t("automationEditor.sentence.noDay")
			: draft.leadMinutes > 0
				? t("automationEditor.sentence.ahead", sentenceValues)
				: t("automationEditor.sentence.onTime", sentenceValues);

	const save = async () => {
		setSaving(true);
		try {
			const saved = await api.automations.save(draft);
			toast.success(creating ? t("automationEditor.toast.created", { name: saved.name }) : t("automationEditor.toast.saved"));
			onSaved(saved);
		} catch (error) {
			toast.error(String(error));
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		if (!initial) return;
		const ok = await confirm({
			title: t("automationEditor.remove.title", { name: initial.name }),
			message: t("automationEditor.remove.message"),
			confirmLabel: t("automationEditor.remove.confirm"),
			danger: true,
		});
		if (!ok) return;
		await api.automations.remove(initial.id);
		onRemoved();
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-4">
			<div className="mx-auto flex max-w-[1320px] flex-col gap-4">
				<div className="flex flex-wrap items-end justify-between gap-3 px-1 pt-1">
					<div>
						<button
							type="button"
							onClick={onClose}
							className="focus-ring inline-flex items-center gap-1 rounded text-[12.5px] font-semibold text-accent hover:underline"
						>
							<ArrowLeft size={13} /> {t("automationEditor.back")}
						</button>
						<h1 className="mt-1 text-[22px] font-semibold text-ink">
							{creating ? t("automationEditor.title.new") : t("automationEditor.title.edit", { name: initial.name })}
						</h1>
					</div>
					<div className="flex gap-2">
						{!creating ? (
							<button
								type="button"
								onClick={() => void remove()}
								className="focus-ring inline-flex h-9 items-center rounded-lg px-3 text-[12.5px] font-semibold text-critical hover:bg-critical/10"
							>
								{t("automationEditor.remove.confirm")}
							</button>
						) : null}
						<button
							type="button"
							onClick={onClose}
							className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover"
						>
							{t("automationEditor.cancel")}
						</button>
						<button
							type="button"
							onClick={() => void tryNow()}
							disabled={trial.running}
							title={t("automationEditor.trial.hint")}
							className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover disabled:opacity-50"
						>
							{trial.running ? <Spinner size={13} /> : <FlaskConical size={14} />} {t("automationEditor.trial.button")}
						</button>
						<button
							type="button"
							onClick={() => void save()}
							disabled={saving}
							className="focus-ring inline-flex h-9 items-center rounded-lg bg-accent px-4 text-[12.5px] font-semibold text-accent-ink hover:bg-accent-soft disabled:opacity-50"
						>
							{creating ? t("automationEditor.saveAndEnable") : t("automationEditor.save")}
						</button>
					</div>
				</div>

				{creating ? (
					<section className="rounded-2xl bg-surface p-4 shadow-card">
						<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
							{t("automationEditor.startFrom")}
						</span>
						<div className="mt-2.5 grid gap-2.5 sm:grid-cols-3 xl:grid-cols-5">
							{MODELS.map((entry) => (
								<button
									key={entry.id}
									type="button"
									onClick={() => {
										setModel(entry.id);
										setDraft(entry.make());
									}}
									className={clsx(
										"focus-ring flex flex-col gap-1 rounded-xl bg-surface p-3.5 text-left",
										model === entry.id ? "ring-2 ring-accent" : "ring-1 ring-line hover:ring-ink-faint",
									)}
								>
									<span className="text-[14px] font-semibold text-ink">{entry.name}</span>
									<span className="text-[12.5px] text-ink-muted">{entry.description}</span>
								</button>
							))}
						</div>
					</section>
				) : null}

				<div className="flex flex-wrap items-start gap-4">
					<div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
						<Card step={1} title={t("automationEditor.when.title")}>
							<label className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">{t("automationEditor.when.name")}</span>
								<input
									value={draft.name}
									onChange={(event) => set("name", event.target.value)}
									placeholder={t("automationEditor.models.daily.name")}
									className="focus-ring h-10 rounded-lg border border-line bg-surface px-3 text-[14px] text-ink"
								/>
							</label>
							<div className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">{t("automationEditor.when.occurs")}</span>
								<div role="group" aria-label={t("automationEditor.when.days")} className="flex flex-wrap gap-1.5">
									{DAY_LABELS.map((label, index) => {
										const day = index + 1;
										const on = draft.days.includes(day);
										return (
											<button
												key={label}
												type="button"
												aria-pressed={on}
												onClick={() =>
													set(
														"days",
														on ? draft.days.filter((entry) => entry !== day) : [...draft.days, day].sort(),
													)
												}
												className={clsx(
													"focus-ring h-10 min-w-12 rounded-lg px-3 text-[13px] font-semibold",
													on ? "bg-accent text-accent-ink" : "border border-line bg-surface text-ink hover:bg-hover",
												)}
											>
												{label}
											</button>
										);
									})}
								</div>
							</div>
							<div className="flex flex-wrap gap-5">
								<label className="flex flex-col gap-1.5">
									<span className="text-[13px] font-semibold text-ink">{t("automationEditor.when.at")}</span>
									<input
										type="time"
										value={draft.time}
										onChange={(event) => set("time", event.target.value)}
										className="focus-ring h-10 rounded-lg border border-line bg-surface px-3 font-mono text-[14px] text-ink"
									/>
								</label>
								<div className="flex flex-col gap-1.5">
									<span className="text-[13px] font-semibold text-ink">{t("automationEditor.when.ready")}</span>
									<div role="group" aria-label={t("automationEditor.when.lead")} className="flex flex-wrap gap-1.5">
										{LEADS.map(([value, label]) => (
											<button
												key={value}
												type="button"
												aria-pressed={draft.leadMinutes === value}
												onClick={() => set("leadMinutes", value)}
												className={clsx(
													"focus-ring h-10 rounded-lg px-3 text-[13px] font-semibold",
													draft.leadMinutes === value
														? "bg-accent text-accent-ink"
														: "border border-line bg-surface text-ink hover:bg-hover",
												)}
											>
												{label}
											</button>
										))}
									</div>
								</div>
							</div>
							<div className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">{t("automationEditor.when.window")}</span>
								<div className="grid gap-2.5 sm:grid-cols-2">
									{(
										[
											["since", t("automationEditor.window.since.name"), t("automationEditor.window.since.description")],
											["day", t("automationEditor.window.day.name"), t("automationEditor.window.day.description")],
										] as const
									).map(([id, name, description]) => (
										<button
											key={id}
											type="button"
											onClick={() => set("window", id)}
											className={clsx(
												"focus-ring flex flex-col gap-1 rounded-xl p-3 text-left",
												draft.window === id ? "ring-2 ring-accent" : "ring-1 ring-line hover:ring-ink-faint",
											)}
										>
											<span className="text-[13.5px] font-semibold text-ink">{name}</span>
											<span className="text-[12.5px] text-ink-muted">{description}</span>
										</button>
									))}
								</div>
							</div>
						</Card>

						<Card step={2} title={t("automationEditor.reads.title")}>
							<p className="text-[13px] text-ink-muted">
								{t("automationEditor.reads.description")}
							</p>
							<div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-4">
								{SOURCES.map((source) => {
									const on = draft.sources[source.key];
									return (
										<button
											key={source.key}
											type="button"
											aria-pressed={on}
											onClick={() => set("sources", { ...draft.sources, [source.key]: !on })}
											className={clsx(
												"focus-ring flex flex-col gap-1.5 rounded-xl p-3 text-left",
												on ? "ring-2 ring-accent" : "ring-1 ring-line hover:ring-ink-faint",
											)}
										>
											<span className="flex items-center justify-between gap-2">
												<span className="text-[14px] font-semibold text-ink">{source.name}</span>
												<span
													className={clsx("relative h-5.5 w-9.5 rounded-full transition-colors", on ? "bg-accent" : "bg-line")}
													aria-hidden="true"
												>
													<span
														className={clsx(
															"absolute top-0.75 size-4 rounded-full bg-surface transition-[left]",
															on ? "left-[19px]" : "left-0.75",
														)}
													/>
												</span>
											</span>
											<span className="text-[12.5px] text-ink-muted">{source.what}</span>
										</button>
									);
								})}
							</div>
						</Card>

						<Card step={3} title={t("automationEditor.asks.title")}>
							<label className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">{t("automationEditor.asks.prompt")}</span>
								<textarea
									value={draft.prompt}
									onChange={(event) => set("prompt", event.target.value)}
									rows={6}
									placeholder={t("automationEditor.asks.placeholder")}
									className="focus-ring resize-y rounded-lg border border-line bg-surface p-3 text-[14px] leading-relaxed text-ink"
								/>
							</label>
							<p className="text-[12.5px] text-ink-muted">
								{t("automationEditor.asks.context")}
							</p>
							{draft.corrections.length > 0 ? (
								<div className="flex flex-col gap-1.5">
									<span className="text-[13px] font-semibold text-ink">
										{t("automationEditor.asks.corrections", { count: draft.corrections.length })}
									</span>
									{draft.corrections.map((correction, index) => (
										<div key={`${correction.at}-${index}`} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2">
											<span className="min-w-0 flex-1 text-[13px] text-ink">{correction.text}</span>
											<span className="shrink-0 font-mono text-[11px] text-ink-muted">
												{shortStamp(new Date(correction.at))}
											</span>
											<button
												type="button"
												aria-label={t("automationEditor.asks.removeCorrection")}
												onClick={() =>
													set(
														"corrections",
														draft.corrections.filter((_, position) => position !== index),
													)
												}
												className="focus-ring flex size-7 items-center justify-center rounded-md text-ink-muted hover:bg-hover hover:text-ink"
											>
												<X size={13} />
											</button>
										</div>
									))}
								</div>
							) : null}
						</Card>

						<Card step={4} title={t("automationEditor.delivery.title")}>
							<div className="grid gap-x-5 gap-y-1 md:grid-cols-2">
								<Check checked={draft.notify} onChange={(value) => set("notify", value)}>
									{t("automationEditor.delivery.notify")}
								</Check>
								<Check checked={draft.catchUp} onChange={(value) => set("catchUp", value)}>
									{t("automationEditor.delivery.catchUp")}
								</Check>
								<Check
									checked={draft.template === "daily"}
									onChange={(value) => set("template", value ? "daily" : "blank")}
								>
									{t("automationEditor.delivery.daily")}
								</Check>
								<Check checked={draft.pdf} onChange={(value) => set("pdf", value)}>
									{t("automationEditor.delivery.pdf")}
								</Check>
								<Check checked={draft.enabled} onChange={(value) => set("enabled", value)}>
									{t("automationEditor.delivery.enabled")}
								</Check>
							</div>
							<label className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">{t("automationEditor.delivery.slack")}</span>
								<input
									type="password"
									value={draft.slackWebhook}
									onChange={(event) => set("slackWebhook", event.target.value)}
									placeholder="https://hooks.slack.com/services/…"
									autoComplete="off"
									className="focus-ring h-10 rounded-lg border border-line bg-surface px-3 font-mono text-[13px] text-ink"
								/>
								<span className="text-[12px] text-ink-muted">
									{t("automationEditor.delivery.slackHint")}
								</span>
							</label>
							<div className="flex items-center gap-2.5 rounded-xl bg-raised px-3 py-2.5">
								<Lock size={16} className="shrink-0 text-accent" />
								<span className="text-[12.5px] text-ink-muted">
									<Trans
										t={t}
										i18nKey="automationEditor.delivery.readOnly"
										components={{ strong: <strong className="text-ink" /> }}
									/>
								</span>
							</div>
						</Card>
					</div>

					<aside className="flex min-w-[300px] flex-[1_1_340px] flex-col gap-4 lg:sticky lg:top-0 lg:max-w-[420px]">
						<section className="flex flex-col gap-3 rounded-2xl bg-surface p-5 shadow-card">
							<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								{t("automationEditor.preview.title")}
							</span>
							<p className="text-[15.5px] leading-snug font-medium text-ink">{sentence}</p>
							<div className="flex flex-col gap-2">
								{next.map((entry) => (
									<div key={entry.occurrence.toISOString()} className="flex flex-col gap-1 rounded-xl bg-raised px-3.5 py-2.5">
										<span className="flex items-baseline justify-between gap-2">
											<span className="text-[13px] font-semibold text-ink">
												{longDay(entry.occurrence)} · {hm(entry.occurrence)}
											</span>
											<span className="font-mono text-[11.5px] text-accent">{t("automationEditor.preview.ready", { time: hm(entry.ready) })}</span>
										</span>
										<span className="font-mono text-[11.5px] text-ink-muted">
											{t("automationEditor.covers", { from: shortStamp(entry.from), to: shortStamp(entry.ready) })}
										</span>
									</div>
								))}
								{picked.length === 0 ? <p className="text-[13px] text-critical">{t("automationEditor.preview.pickDay")}</p> : null}
							</div>
						</section>
						<section className="flex flex-col gap-1 rounded-2xl bg-surface p-5 shadow-card">
							<span className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								{t("automationEditor.steps.title")}
							</span>
							{(["period", "read", "write", "store", "notify"] as const)
								.map((step) => [
									t(`automationEditor.steps.${step}.title`),
									t(`automationEditor.steps.${step}.description`),
								])
								.map(([title, description], index, all) => (
								<div key={title} className="flex gap-3">
									<div className="flex flex-col items-center">
										<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-dim font-mono text-[11.5px] font-semibold text-accent">
											{index + 1}
										</span>
										{index < all.length - 1 ? <span className="min-h-3 w-0.5 flex-1 bg-line-soft" /> : null}
									</div>
									<div className="pt-0.5 pb-3">
										<span className="block text-[13px] font-semibold text-ink">{title}</span>
										<span className="block text-[12.5px] text-ink-muted">{description}</span>
									</div>
								</div>
							))}
						</section>
					</aside>
				</div>
			</div>
			{showTrial ? <TrialResult trial={trial} onClose={() => setShowTrial(false)} /> : null}
		</div>
	);
}

/** Ce qu'un essai à blanc a donné : rien n'a été rangé ni envoyé. */
function TrialResult({
	trial,
	onClose,
}: {
	trial: { running: boolean; run: AutomationRun | null; error: string };
	onClose: () => void;
}) {
	const { t } = useTranslation("components1");
	const run = trial.run;
	return (
		<Modal onClose={onClose}>
			<div className="flex max-h-[80vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-2xl bg-surface p-6 shadow-card">
				<div className="flex items-start justify-between gap-3">
					<div>
						<h2 className="text-[18px] font-semibold text-ink">{t("automationEditor.trial.title")}</h2>
						<p className="text-[12.5px] text-ink-muted">{t("automationEditor.trial.subtitle")}</p>
					</div>
					<button
						type="button"
						aria-label={t("automationEditor.close")}
						onClick={onClose}
						className="focus-ring flex size-8 items-center justify-center rounded-lg text-ink-muted hover:bg-hover"
					>
						<X size={15} />
					</button>
				</div>
				{trial.running ? (
					<div className="flex items-center gap-2.5 py-8 text-[13.5px] text-ink-muted">
						<Spinner /> {t("automationEditor.trial.running")}
					</div>
				) : trial.error ? (
					<p className="rounded-xl bg-critical/10 p-4 text-[13.5px] text-critical">{trial.error}</p>
				) : run ? (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<span className={`inline-flex h-6 items-center rounded-full px-2.5 text-[11.5px] font-semibold ${TONE_CLASS[runLabel(run).tone]}`}>
								{run.state === "partial" ? t("automationEditor.trial.partial") : t("automationEditor.trial.ready")}
							</span>
							<span className="font-mono text-[12px] text-ink-muted">
								{t("automationEditor.covers", { from: shortStamp(new Date(run.from)), to: shortStamp(new Date(run.to)) })}
							</span>
							{run.sources.map((source) => (
								<span
									key={source.source}
									className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium ${
										source.state === "read"
											? "bg-raised text-ink"
											: source.state === "silent"
												? "bg-warning/15 text-warning"
												: "bg-raised text-ink-muted"
									}`}
									title={source.note}
								>
									{SOURCE_LABEL[source.source] ?? source.source}{" "}
									{source.state === "read"
										? source.count
										: source.state === "silent"
											? t("automationEditor.trial.silent")
											: t("automationEditor.trial.unplugged")}
								</span>
							))}
						</div>
						{run.headline ? <p className="text-[14.5px] font-medium text-ink">{run.headline}</p> : null}
						{run.parts.map((part) => (
							<section key={part.title} className="flex flex-col gap-1.5">
								<h3 className="text-[14px] font-semibold text-ink">{part.title}</h3>
								{part.lines.length === 0 ? <p className="text-[13px] text-ink-muted">{t("automationEditor.trial.nothing")}</p> : null}
								{part.lines.map((line) => (
									<div key={line.id} className="rounded-lg bg-raised px-3 py-2">
										<span className="block text-[13.5px] font-semibold text-ink">{line.title}</span>
										{line.detail ? <span className="block text-[12.5px] text-ink-muted">{line.detail}</span> : null}
										<span className="mt-1 flex flex-wrap gap-1.5 font-mono text-[11px] text-ink-muted">
											{line.unsourced ? <span className="text-warning">{t("automationEditor.trial.unsourced")}</span> : null}
											{line.refs.map((ref) => (
												<span key={ref}>{ref.replace(/^\w+:/, "")}</span>
											))}
										</span>
									</div>
								))}
							</section>
						))}
					</>
				) : null}
			</div>
		</Modal>
	);
}

function Card({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-4 rounded-2xl bg-surface p-5 shadow-card">
			<div className="flex items-center gap-2.5">
				<span className="flex size-6.5 items-center justify-center rounded-full bg-accent-dim font-mono text-[12px] font-semibold text-accent">
					{step}
				</span>
				<h2 className="text-[16px] font-semibold text-ink">{title}</h2>
			</div>
			{children}
		</section>
	);
}

function Check({
	checked,
	onChange,
	children,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	children: React.ReactNode;
}) {
	return (
		<label className="flex min-h-10 cursor-pointer items-center gap-2.5">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				className="size-4 accent-[var(--color-accent)]"
			/>
			<span className="text-[13.5px] text-ink">{children}</span>
		</label>
	);
}
