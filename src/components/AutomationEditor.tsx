import clsx from "clsx";
import { ArrowLeft, FlaskConical, Lock, X } from "lucide-react";
import { useState } from "react";
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

const DAILY_PROMPT =
	"Résume ce que j'ai fait sur la période, pour le daily de l'équipe. Quatre parties : Livré, En cours, Bloqué, Ensuite. Une ligne par sujet ; regroupe une PR et le ticket qu'elle traite. Pas de jargon interne au code : l'équipe produit écoute aussi.";

const MODELS: Array<{ id: string; name: string; description: string; make: () => Automation }> = [
	{
		id: "daily",
		name: "Mon daily",
		description: "Ce que j'ai fait depuis le dernier, en quatre parties, placé dans l'écran Daily",
		make: () => ({
			...blank(),
			name: "Mon daily",
			template: "daily",
			prompt: DAILY_PROMPT,
			sources: { github: true, tracker: true, cockpit: true, sentry: true },
		}),
	},
	{
		id: "revue",
		name: "Revue du matin",
		description: "Les PR qui attendent ma relecture, et ce qui a bougé cette nuit",
		make: () => ({
			...blank(),
			name: "Revue du matin",
			days: [1, 2, 3, 4, 5],
			time: "09:00",
			leadMinutes: 15,
			sources: { github: true, tracker: false, cockpit: false, sentry: false },
			prompt:
				"Liste les PR que j'ai relues ou qui ont bougé depuis hier, de la plus ancienne à la plus récente. Deux parties : À relire, Déjà relu. Une ligne par PR, avec ce qui a changé.",
		}),
	},
	{
		id: "sprint",
		name: "Bilan de la semaine",
		description: "Ce que j'ai livré sur la semaine, pour la rétro",
		make: () => ({
			...blank(),
			name: "Bilan de la semaine",
			days: [5],
			time: "17:00",
			leadMinutes: 60,
			pdf: true,
			prompt:
				"Fais le bilan de ma semaine pour la rétro. Trois parties : Livré, Ce qui a ralenti, À reprendre. Regroupe par sujet, pas par outil.",
		}),
	},
	{
		id: "sentry",
		name: "Veille des erreurs",
		description: "Les erreurs qui me sont assignées et ont bougé depuis hier",
		make: () => ({
			...blank(),
			name: "Veille des erreurs",
			days: [1, 2, 3, 4, 5],
			time: "10:00",
			leadMinutes: 0,
			window: "day",
			sources: { github: false, tracker: false, cockpit: false, sentry: true },
			prompt:
				"Résume les erreurs qui me sont assignées et ont bougé depuis hier. Deux parties : Nouvelles ou en hausse, Résolues. Une ligne par erreur, avec ce qu'elle touche.",
		}),
	},
	{
		id: "blank",
		name: "Vierge",
		description: "Une consigne, un rythme, un rendu",
		make: () => blank(),
	},
];

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

const LEADS: Array<[number, string]> = [
	[0, "À l'heure"],
	[15, "15 min avant"],
	[30, "30 min avant"],
	[60, "1 h avant"],
];

const SOURCES: Array<{ key: keyof Automation["sources"]; name: string; what: string }> = [
	{ key: "github", name: "GitHub", what: "Mes PR ouvertes, fusionnées ou mises à jour, et celles que j'ai relues" },
	{ key: "tracker", name: "Suivi de tâches", what: "Mes tickets qui ont bougé, terminés compris" },
	{ key: "cockpit", name: "Cockpit", what: "Les tours d'agents terminés, par dossier, et les gestes git du journal" },
	{ key: "sentry", name: "Sentry", what: "Les erreurs qui me sont assignées et ont bougé sur la période" },
];

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
	const creating = initial === null;
	const [model, setModel] = useState("daily");
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
	const picked = DAY_LABELS.filter((_, index) => draft.days.includes(index + 1)).map((day) => day.toLowerCase() + ".");
	const sources = SOURCES.filter((source) => draft.sources[source.key]).map((source) => source.name);
	const sentence =
		picked.length === 0
			? "Aucun jour choisi : rien ne tournera."
			: `Chaque ${picked.join(", ")} à ${draft.time}, Cockpit lit ${sources.length > 0 ? sources.join(", ") : "aucune source"} et te rend ${draft.template === "daily" ? "ta partie du daily" : "un rendu"}${draft.leadMinutes > 0 ? `, ${draft.leadMinutes} min avant` : ", à l'heure"}.`;

	const save = async () => {
		setSaving(true);
		try {
			const saved = await api.automations.save(draft);
			toast.success(creating ? `${saved.name} est en place` : "Réglage enregistré");
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
			title: `Supprimer « ${initial.name} » ?`,
			message: "Elle ne tournera plus. Ses exécutions passées restent sur le disque.",
			confirmLabel: "Supprimer",
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
							<ArrowLeft size={13} /> Automatisations
						</button>
						<h1 className="mt-1 text-[22px] font-semibold text-ink">
							{creating ? "Nouvelle automatisation" : `Régler « ${initial.name} »`}
						</h1>
					</div>
					<div className="flex gap-2">
						{!creating ? (
							<button
								type="button"
								onClick={() => void remove()}
								className="focus-ring inline-flex h-9 items-center rounded-lg px-3 text-[12.5px] font-semibold text-critical hover:bg-critical/10"
							>
								Supprimer
							</button>
						) : null}
						<button
							type="button"
							onClick={onClose}
							className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover"
						>
							Annuler
						</button>
						<button
							type="button"
							onClick={() => void tryNow()}
							disabled={trial.running}
							title="Le même travail qu'une exécution, sur la période qu'elle couvrirait maintenant, sans rien ranger ni prévenir"
							className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink hover:bg-hover disabled:opacity-50"
						>
							{trial.running ? <Spinner size={13} /> : <FlaskConical size={14} />} Essayer à blanc
						</button>
						<button
							type="button"
							onClick={() => void save()}
							disabled={saving}
							className="focus-ring inline-flex h-9 items-center rounded-lg bg-accent px-4 text-[12.5px] font-semibold text-accent-ink hover:bg-accent-soft disabled:opacity-50"
						>
							{creating ? "Enregistrer et activer" : "Enregistrer"}
						</button>
					</div>
				</div>

				{creating ? (
					<section className="rounded-2xl bg-surface p-4 shadow-card">
						<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
							Partir d'un modèle
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
						<Card step={1} title="Quand">
							<label className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">Nom</span>
								<input
									value={draft.name}
									onChange={(event) => set("name", event.target.value)}
									placeholder="Mon daily"
									className="focus-ring h-10 rounded-lg border border-line bg-surface px-3 text-[14px] text-ink"
								/>
							</label>
							<div className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">Le rendez-vous a lieu</span>
								<div role="group" aria-label="Jours" className="flex flex-wrap gap-1.5">
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
									<span className="text-[13px] font-semibold text-ink">à</span>
									<input
										type="time"
										value={draft.time}
										onChange={(event) => set("time", event.target.value)}
										className="focus-ring h-10 rounded-lg border border-line bg-surface px-3 font-mono text-[14px] text-ink"
									/>
								</label>
								<div className="flex flex-col gap-1.5">
									<span className="text-[13px] font-semibold text-ink">Rendu prêt</span>
									<div role="group" aria-label="Avance" className="flex flex-wrap gap-1.5">
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
								<span className="text-[13px] font-semibold text-ink">Période couverte</span>
								<div className="grid gap-2.5 sm:grid-cols-2">
									{(
										[
											["since", "Depuis la dernière exécution", "Le lundi couvre le week-end ; rien ne se perd entre deux rendez-vous, même après un rattrapage."],
											["day", "Les dernières 24 heures", "Une fenêtre fixe, pour une veille qui revient chaque jour."],
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

						<Card step={2} title="Ce qu'elle lit">
							<p className="text-[13px] text-ink-muted">
								Les comptes déclarés dans les réglages, filtrés sur toi. Une source qui ne répond pas donne une
								partie absente et signalée, jamais un échec.
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

						<Card step={3} title="Ce qu'elle demande">
							<label className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">Consigne</span>
								<textarea
									value={draft.prompt}
									onChange={(event) => set("prompt", event.target.value)}
									rows={6}
									placeholder="Ce que tu attends du rendu, à qui il s'adresse, ce qu'il doit taire."
									className="focus-ring resize-y rounded-lg border border-line bg-surface p-3 text-[14px] leading-relaxed text-ink"
								/>
							</label>
							<p className="text-[12.5px] text-ink-muted">
								L'agent reçoit aussi la période, les éléments lus et le rendu précédent, pour dire ce qui a
								avancé depuis. Il cite chaque élément qu'il utilise : une référence inventée est écartée.
							</p>
							{draft.corrections.length > 0 ? (
								<div className="flex flex-col gap-1.5">
									<span className="text-[13px] font-semibold text-ink">
										Corrections demandées après des rendus · {draft.corrections.length}
									</span>
									{draft.corrections.map((correction, index) => (
										<div key={`${correction.at}-${index}`} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2">
											<span className="min-w-0 flex-1 text-[13px] text-ink">{correction.text}</span>
											<span className="shrink-0 font-mono text-[11px] text-ink-muted">
												{shortStamp(new Date(correction.at))}
											</span>
											<button
												type="button"
												aria-label="Retirer cette correction"
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

						<Card step={4} title="Où ça arrive">
							<div className="grid gap-x-5 gap-y-1 md:grid-cols-2">
								<Check checked={draft.notify} onChange={(value) => set("notify", value)}>
									Notification quand c'est prêt
								</Check>
								<Check checked={draft.catchUp} onChange={(value) => set("catchUp", value)}>
									Rattraper à l'ouverture si le rendez-vous n'est pas passé
								</Check>
								<Check
									checked={draft.template === "daily"}
									onChange={(value) => set("template", value ? "daily" : "blank")}
								>
									Placer ma partie dans l'écran Daily
								</Check>
								<Check checked={draft.pdf} onChange={(value) => set("pdf", value)}>
									Mettre chaque rendu en PDF
								</Check>
								<Check checked={draft.enabled} onChange={(value) => set("enabled", value)}>
									Active
								</Check>
							</div>
							<label className="flex flex-col gap-1.5">
								<span className="text-[13px] font-semibold text-ink">Webhook Slack, pour publier un rendu relu</span>
								<input
									type="password"
									value={draft.slackWebhook}
									onChange={(event) => set("slackWebhook", event.target.value)}
									placeholder="https://hooks.slack.com/services/…"
									autoComplete="off"
									className="focus-ring h-10 rounded-lg border border-line bg-surface px-3 font-mono text-[13px] text-ink"
								/>
								<span className="text-[12px] text-ink-muted">
									Rien n'y part tout seul : le bouton « Envoyer sur Slack » apparaît sur un rendu, après relecture.
									L'adresse reste dans Cockpit et ne s'affiche plus une fois enregistrée.
								</span>
							</label>
							<div className="flex items-center gap-2.5 rounded-xl bg-raised px-3 py-2.5">
								<Lock size={16} className="shrink-0 text-accent" />
								<span className="text-[12.5px] text-ink-muted">
									<strong className="text-ink">Lecture seule</strong>, sans réglage pour en sortir : l'agent
									n'a aucun outil, il ne peut rien pousser, commenter ni déplacer.
								</span>
							</div>
						</Card>
					</div>

					<aside className="flex min-w-[300px] flex-[1_1_340px] flex-col gap-4 lg:sticky lg:top-0 lg:max-w-[420px]">
						<section className="flex flex-col gap-3 rounded-2xl bg-surface p-5 shadow-card">
							<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								Ce qui va se passer
							</span>
							<p className="text-[15.5px] leading-snug font-medium text-ink">{sentence}</p>
							<div className="flex flex-col gap-2">
								{next.map((entry) => (
									<div key={entry.occurrence.toISOString()} className="flex flex-col gap-1 rounded-xl bg-raised px-3.5 py-2.5">
										<span className="flex items-baseline justify-between gap-2">
											<span className="text-[13px] font-semibold text-ink">
												{longDay(entry.occurrence)} · {hm(entry.occurrence)}
											</span>
											<span className="font-mono text-[11.5px] text-accent">prêt {hm(entry.ready)}</span>
										</span>
										<span className="font-mono text-[11.5px] text-ink-muted">
											couvre {shortStamp(entry.from)} → {shortStamp(entry.ready)}
										</span>
									</div>
								))}
								{picked.length === 0 ? <p className="text-[13px] text-critical">Choisis au moins un jour.</p> : null}
							</div>
						</section>
						<section className="flex flex-col gap-1 rounded-2xl bg-surface p-5 shadow-card">
							<span className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								À chaque exécution
							</span>
							{[
								["La période se calcule", "De la fin de la précédente réussie à maintenant, notée dans le rendu"],
								["Cockpit lit les sources", "Lui, pas l'agent : chaque élément garde son lien et son origine"],
								["Un agent rédige", "Sans aucun outil, avec ta consigne et les éléments, rien d'autre"],
								["Le rendu se range", "Une exécution de plus dans l'historique, jamais réécrite"],
								["Tu es prévenu", "Une notification, puis ta partie dans l'écran Daily"],
							].map(([title, description], index, all) => (
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
	const run = trial.run;
	return (
		<Modal onClose={onClose}>
			<div className="flex max-h-[80vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-2xl bg-surface p-6 shadow-card">
				<div className="flex items-start justify-between gap-3">
					<div>
						<h2 className="text-[18px] font-semibold text-ink">Essai à blanc</h2>
						<p className="text-[12.5px] text-ink-muted">Rien n'a été rangé ni envoyé : c'est ce qu'elle produirait maintenant.</p>
					</div>
					<button
						type="button"
						aria-label="Fermer"
						onClick={onClose}
						className="focus-ring flex size-8 items-center justify-center rounded-lg text-ink-muted hover:bg-hover"
					>
						<X size={15} />
					</button>
				</div>
				{trial.running ? (
					<div className="flex items-center gap-2.5 py-8 text-[13.5px] text-ink-muted">
						<Spinner /> Lecture des sources, puis rédaction — une à deux minutes.
					</div>
				) : trial.error ? (
					<p className="rounded-xl bg-critical/10 p-4 text-[13.5px] text-critical">{trial.error}</p>
				) : run ? (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<span className={`inline-flex h-6 items-center rounded-full px-2.5 text-[11.5px] font-semibold ${TONE_CLASS[runLabel(run).tone]}`}>
								{run.state === "partial" ? "Partielle" : "Prête"}
							</span>
							<span className="font-mono text-[12px] text-ink-muted">
								couvre {shortStamp(new Date(run.from))} → {shortStamp(new Date(run.to))}
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
									{source.state === "read" ? source.count : source.state === "silent" ? "muet" : "non branché"}
								</span>
							))}
						</div>
						{run.headline ? <p className="text-[14.5px] font-medium text-ink">{run.headline}</p> : null}
						{run.parts.map((part) => (
							<section key={part.title} className="flex flex-col gap-1.5">
								<h3 className="text-[14px] font-semibold text-ink">{part.title}</h3>
								{part.lines.length === 0 ? <p className="text-[13px] text-ink-muted">Rien.</p> : null}
								{part.lines.map((line) => (
									<div key={line.id} className="rounded-lg bg-raised px-3 py-2">
										<span className="block text-[13.5px] font-semibold text-ink">{line.title}</span>
										{line.detail ? <span className="block text-[12.5px] text-ink-muted">{line.detail}</span> : null}
										<span className="mt-1 flex flex-wrap gap-1.5 font-mono text-[11px] text-ink-muted">
											{line.unsourced ? <span className="text-warning">sans source</span> : null}
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
