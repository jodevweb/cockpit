import clsx from "clsx";
import {
	ArrowLeft,
	Bot,
	Check,
	Compass,
	ExternalLink,
	Eye,
	FolderTree,
	GitBranch,
	GitPullRequest,
	HelpCircle,
	History,
	Hourglass,
	Lightbulb,
	ListTree,
	MessageSquare,
	PenLine,
	RotateCcw,
	ShieldCheck,
	StopCircle,
	Ticket,
	Users,
	XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useConfirm } from "@/components/Confirm";
import { Markdown } from "@/components/Markdown";
import { MissionGraph } from "@/components/MissionGraph";
import { Badge, Button, ErrorNote, PriorityBadge } from "@/components/ui";
import { useCockpit } from "@/app/store";
import { duration, fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import type {
	Mission,
	MissionActivity,
	MissionDraft,
	MissionStep,
	MissionTask,
} from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * Le parcours d'une mission guidée : on lit le ticket avec le maître, puis on
 * valide ce qu'il a compris, son approche, et son découpage — un accord à la
 * fois.
 *
 * La mission autonome ne connaissait qu'un bouton, « Approuver le plan », posé
 * dans une carte : on approuvait un découpage sans avoir jamais vérifié que le
 * ticket avait été compris. Ici le ticket reste sous les yeux d'un bout à
 * l'autre, et chaque étape dit qui a la main — le maître qui écrit, ou toi qui
 * relis.
 */

type Phase = "done" | "yours" | "master" | "upcoming" | "failed";

interface JourneyStep {
	label: string;
	icon: React.ComponentType<{ size?: number; className?: string }>;
	/** Étape validée par un accord — absente pour exécution et livraison. */
	step?: MissionStep;
	working?: Mission["state"];
	awaiting?: Mission["state"];
}

const JOURNEY: JourneyStep[] = [
	{
		label: "Compréhension",
		icon: Lightbulb,
		step: "understanding",
		working: "understanding",
		awaiting: "awaitingUnderstanding",
	},
	{
		label: "Approche",
		icon: Compass,
		step: "approach",
		working: "approaching",
		awaiting: "awaitingApproach",
	},
	{
		label: "Découpage",
		icon: ListTree,
		step: "split",
		working: "planning",
		awaiting: "awaitingApproval",
	},
	{ label: "Exécution", icon: Users },
	{ label: "Livraison", icon: GitPullRequest },
];

/** Ce que dit chaque étape, selon qui a la main. */
const COPY: Record<
	MissionStep,
	{ working: string; workingHint: string; proposal: string; approve: string }
> = {
	understanding: {
		working: "Le maître lit le ticket",
		workingHint:
			"Lis-le à gauche en même temps que lui. Dans un instant, il te dira ce qu'il en a compris — dix lignes au plus, et ses questions à part.",
		proposal: "Ce que le maître a compris",
		approve: "Valider — passer à l'approche",
	},
	approach: {
		working: "Le maître prépare son approche",
		workingHint:
			"Comment il compte s'y prendre : les étapes, les endroits du code, l'ordre, les risques. Pas encore de répartition entre exécutants.",
		proposal: "L'approche proposée",
		approve: "Valider — passer au découpage",
	},
	split: {
		working: "Le maître découpe le travail",
		workingHint:
			"Qui fait quoi, où, et dans quel ordre — fidèle à l'approche que tu as validée. Rien ne partira avant ton accord.",
		proposal: "Le découpage proposé",
		approve: "Valider — lancer les exécutants",
	},
};

function draftsOf(mission: Mission, step: MissionStep): MissionDraft[] {
	if (step === "understanding") return mission.understanding ?? [];
	if (step === "approach") return mission.approach ?? [];
	return mission.split ?? [];
}

/** L'étape où en est la mission, de 0 (compréhension) à 4 (livraison). */
function currentIndex(mission: Mission): number {
	switch (mission.state) {
		case "understanding":
		case "awaitingUnderstanding":
			return 0;
		case "approaching":
		case "awaitingApproach":
			return 1;
		case "planning":
		case "awaitingApproval":
			return 2;
		case "running":
			return 3;
		case "integrating":
		case "done":
			return 4;
		case "failed": {
			// Arrêtée : on la situe là où elle est allée, pas au début.
			if (mission.startedAt) return 3;
			const approved = (drafts: MissionDraft[]) => drafts.at(-1)?.review?.approved === true;
			if (approved(mission.approach ?? [])) return 2;
			if (approved(mission.understanding ?? [])) return 1;
			return 0;
		}
	}
}

function phaseOf(mission: Mission, index: number, current: number): Phase {
	if (mission.state === "done") return "done";
	if (index < current) return "done";
	if (index > current) return "upcoming";
	if (mission.state === "failed") return "failed";
	const entry = JOURNEY[index];
	if (entry?.awaiting === mission.state) return "yours";
	return "master";
}

export function MissionJourney({
	mission: initial,
	onBack,
	onChange,
	execution,
}: {
	mission: Mission;
	onBack: () => void;
	onChange: () => void;
	/** La fiche d'exécution, rendue par l'écran des missions. */
	execution: ReactNode;
}) {
	const { notify } = useCockpit();
	const { confirm } = useConfirm();
	// Plus vif que la liste : on attend ici une réponse du maître, et dix
	// secondes de retard sur une proposition qui vient d'arriver se sentent.
	const live = useAsync(() => api.missions.get(initial.id), [initial.id], {
		pollMs: 3000,
	});
	const mission = live.data ?? initial;
	const activity = useAsync(() => api.missions.activity(mission.id), [mission.id], {
		pollMs: 2500,
		enabled: mission.state !== "done" && mission.state !== "failed",
	});

	// Tant que l'activité n'a pas été lue, on ne sait pas : dire « absent » sur
	// une simple absence de réponse affichait l'alerte à chaque ouverture.
	const masterAlive = activity.data ? activity.data.master?.running === true : null;

	const current = currentIndex(mission);
	const [viewed, setViewed] = useState<number | null>(null);
	// Quand la mission avance, on la suit — sauf si l'on relit volontairement
	// une étape passée, qu'on ne vous arrache pas des mains.
	useEffect(() => setViewed(null), [current]);
	const shown = viewed ?? current;

	const refresh = () => {
		live.reload();
		activity.reload();
		onChange();
	};

	// Ouvrir le parcours suffit : une étape qui attend le maître le démarre
	// d'elle-même. Une mission en pause reste en pause — c'est un geste explicite.
	const awaitsMaster =
		JOURNEY[current]?.step !== undefined && phaseOf(mission, current, current) === "master";
	const [autoStarting, setAutoStarting] = useState(false);
	useEffect(() => {
		if (!awaitsMaster || masterAlive !== false || mission.paused) return;
		if (autoLaunched.has(mission.id)) return;
		autoLaunched.add(mission.id);
		setAutoStarting(true);
		api.missions
			.launchMaster(mission.id)
			.then(refresh)
			.catch((error) => notify(String(error)))
			.finally(() => setAutoStarting(false));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [awaitsMaster, masterAlive, mission.id, mission.paused]);

	const stop = async () => {
		const ok = await confirm({
			title: `Abandonner « ${mission.title} » ?`,
			message:
				"Le maître est coupé et la mission close. Ce qui a été validé reste lisible dans son historique.",
			confirmLabel: "Abandonner",
			danger: true,
		});
		if (!ok) return;
		try {
			await api.missions.stop(mission.id);
			notify("Mission abandonnée.");
			refresh();
		} catch (error) {
			notify(String(error));
		}
	};

	const entry = JOURNEY[shown];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* En-tête : d'où l'on vient, sur quoi l'on travaille. */}
			<header className="hairline-b flex items-center gap-3 px-5 py-3">
				<Button icon={ArrowLeft} onClick={onBack}>
					Missions
				</Button>
				<div className="h-5 w-px bg-line-soft" />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						{mission.ticket ? <Badge mono>{mission.ticket}</Badge> : null}
						<h1 className="truncate text-[14px] font-semibold text-ink">{mission.title}</h1>
					</div>
					<div className="mt-0.5 flex items-center gap-1 font-mono text-[10px] text-ink-faint">
						<GitBranch size={10} />
						{mission.branch || "sans branche"}
					</div>
				</div>
				{current < 3 && mission.state !== "failed" ? (
					<Button variant="danger" icon={StopCircle} onClick={() => void stop()}>
						Abandonner
					</Button>
				) : null}
			</header>

			<Stepper
				mission={mission}
				current={current}
				shown={shown}
				// Un démarrage en cours n'est pas un arrêt : le fil se tait là-dessus.
				masterAlive={autoStarting ? null : masterAlive}
				onPick={(index) => setViewed(index === current ? null : index)}
			/>

			<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
				{/* Le ticket, toujours là : on le lit en même temps que le maître,
				    et c'est contre lui qu'on juge chacune de ses propositions. */}
				<aside className="flex min-h-0 flex-col border-r border-line-soft bg-base/40">
					<TicketReader reference={mission.ticket} fallbackTitle={mission.title} />
				</aside>

				<main className="min-h-0 overflow-y-auto">
					<div className="mx-auto flex max-w-3xl flex-col gap-4 p-5">
						{mission.state === "failed" && mission.note ? (
							<div className="flex items-start gap-2.5 rounded-xl border border-critical/30 bg-critical/[0.07] p-3">
								<XCircle size={15} className="mt-0.5 shrink-0 text-critical" />
								<p className="text-[12px] leading-relaxed text-ink-muted">{mission.note}</p>
							</div>
						) : null}

						{entry?.step ? (
							<StepPanel
								key={`${entry.step}-${shown === current}`}
								mission={mission}
								step={entry.step}
								phase={phaseOf(mission, shown, current)}
								activity={activity.data ?? null}
								masterLast={activity.data?.master?.last ?? ""}
								masterAlive={masterAlive}
								autoStarting={autoStarting}
								onDone={refresh}
							/>
						) : (
							<>
								{/* Le même graphe qu'au découpage, désormais vivant : qui
								    travaille, qui attend qui, où ça coince. */}
								{mission.tasks.length > 0 ? (
									<MissionGraph
										mission={mission}
										activity={activity.data ?? null}
										height={520}
										vertical
										withTicket={false}
									/>
								) : null}
								{execution}
							</>
						)}
					</div>
				</main>
			</div>
		</div>
	);
}

/* ── Le fil des étapes ─────────────────────────────────────────────────── */

function Stepper({
	mission,
	current,
	shown,
	masterAlive,
	onPick,
}: {
	mission: Mission;
	current: number;
	shown: number;
	/** `null` tant qu'on ne sait pas encore. */
	masterAlive: boolean | null;
	onPick: (index: number) => void;
}) {
	// Une étape d'accord sans maître n'avance pas : le fil ne doit pas dire
	// « le maître écrit » au-dessus d'un panneau qui dit le contraire.
	const stalled = (index: number, phase: Phase) =>
		phase === "master" && masterAlive === false && JOURNEY[index]?.step !== undefined;

	const delivered = mission.tasks.filter((task) =>
		["delivered", "integrated"].includes(task.state),
	).length;

	const sub = (index: number, phase: Phase): string => {
		const entry = JOURNEY[index];
		if (phase === "yours") return "à toi";
		if (phase === "failed") return "arrêtée";
		if (stalled(index, phase)) return "maître à l'arrêt";
		if (phase === "master") {
			if (index === 3) return `${delivered}/${mission.tasks.length} tâches`;
			if (index === 4) return mission.state === "integrating" ? "intégration…" : "";
			return "le maître écrit…";
		}
		if (phase === "done") {
			if (entry?.step) {
				const versions = draftsOf(mission, entry.step).length;
				return versions > 1 ? `validée · v${versions}` : "validée";
			}
			if (index === 3) return `${mission.tasks.length} tâches`;
			return mission.prUrl ? "PR ouverte" : "close";
		}
		return "";
	};

	return (
		<nav className="hairline-b px-6 py-4">
			<ol className="flex items-start">
				{JOURNEY.map((entry, index) => {
					const phase = phaseOf(mission, index, current);
					const idle = stalled(index, phase);
					const Icon = phase === "done" ? Check : idle ? Hourglass : entry.icon;
					const reachable = index <= current;
					return (
						<li key={entry.label} className="flex flex-1 items-start last:flex-none">
							<button
								type="button"
								disabled={!reachable}
								onClick={() => onPick(index)}
								className={clsx(
									"focus-ring group flex w-24 flex-col items-center gap-1.5 rounded-lg py-0.5",
									reachable ? "cursor-pointer" : "cursor-default",
								)}
							>
								<span
									className={clsx(
										"relative grid size-9 place-items-center rounded-full border-2 transition-colors duration-300",
										phase === "done" && "border-success/60 bg-success/15 text-success",
										phase === "yours" && "border-accent bg-accent text-accent-ink",
										phase === "master" &&
											(idle
												? "border-warning/50 bg-warning/10 text-warning"
												: "border-accent/50 bg-accent-dim text-accent-soft"),
										phase === "upcoming" && "border-line-soft bg-surface text-ink-faint",
										phase === "failed" && "border-critical/60 bg-critical/15 text-critical",
										shown === index && "ring-2 ring-accent/30 ring-offset-2 ring-offset-base",
									)}
								>
									<Icon size={15} className={clsx(phase === "master" && !idle && "breathe")} />
									{/* Ce qui attend une décision se remarque d'un coup d'œil,
									    même depuis l'autre bout de l'écran. */}
									{phase === "yours" ? (
										<span className="animate-pulse-dot absolute -inset-1 rounded-full border-2 border-accent/40" />
									) : null}
								</span>
								<span
									className={clsx(
										"text-[11px] font-medium",
										phase === "upcoming" ? "text-ink-faint" : "text-ink",
									)}
								>
									{entry.label}
								</span>
								<span
									className={clsx(
										"h-3 text-[10px]",
										phase === "yours"
											? "font-semibold text-accent-soft"
											: idle
												? "font-semibold text-warning"
												: "text-ink-faint",
									)}
								>
									{sub(index, phase)}
								</span>
							</button>
							{index < JOURNEY.length - 1 ? (
								<span
									className={clsx(
										"mx-1 mt-[17px] h-0.5 flex-1 rounded-full transition-colors duration-500",
										index < current || mission.state === "done" ? "bg-success/50" : "bg-line-soft",
									)}
								/>
							) : null}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

/* ── Une étape à accord ─────────────────────────────────────────────────── */

function StepPanel({
	mission,
	step,
	phase,
	activity,
	masterLast,
	masterAlive,
	autoStarting,
	onDone,
}: {
	mission: Mission;
	step: MissionStep;
	phase: Phase;
	activity: MissionActivity | null;
	masterLast: string;
	masterAlive: boolean | null;
	autoStarting: boolean;
	onDone: () => void;
}) {
	const drafts = draftsOf(mission, step);
	const last = drafts.at(-1);
	const earlier = drafts.slice(0, -1);

	if (phase === "master") {
		return (
			<>
				<Working
					mission={mission}
					step={step}
					last={masterLast}
					alive={masterAlive}
					autoStarting={autoStarting}
					// Une correction en cours de prise en compte : on rappelle ce
					// qu'on a demandé, c'est ce qu'on va vérifier à la prochaine version.
					correction={last?.review && !last.review.approved ? last.review : null}
					onDone={onDone}
				/>
				{drafts.length > 0 ? <Versions drafts={drafts} step={step} /> : null}
			</>
		);
	}

	if (!last) {
		return (
			<p className="rounded-xl border border-line-soft p-4 text-[12px] text-ink-faint">
				Rien n'a été proposé à cette étape.
			</p>
		);
	}

	return (
		<>
			{phase === "yours" ? (
				<div className="rise flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-accent-soft uppercase">
					<span className="animate-pulse-dot size-1.5 rounded-full bg-accent" />À toi de jouer
				</div>
			) : null}

			{step === "split" ? (
				<>
					{/* Le plan se voit avant de se lire : qui part tout de suite, qui
					    attend qui, où finissent les vérifications. */}
					<MissionGraph
						mission={mission}
						activity={activity}
						height={480}
						vertical
						withTicket={false}
					/>
					<SplitProposal mission={mission} draft={last} version={drafts.length} />
				</>
			) : (
				<Proposal step={step} draft={last} version={drafts.length} />
			)}

			{phase === "yours" ? (
				<Decision mission={mission} step={step} draft={last} onDone={onDone} />
			) : (
				<Verdict draft={last} />
			)}

			{earlier.length > 0 ? <Versions drafts={earlier} step={step} /> : null}
		</>
	);
}

/**
 * Les missions dont on a déjà tenté de remettre le maître debout. Hors du
 * composant : il se remonte à chaque étape, et un lancement qui échoue ne doit
 * pas être retenté en boucle — le bouton prend alors le relais.
 */
const autoLaunched = new Set<string>();

/** Le maître a la main : ce qu'il fait, et ce qu'on peut faire en attendant. */
function Working({
	mission,
	step,
	last,
	alive,
	autoStarting,
	correction,
	onDone,
}: {
	mission: Mission;
	step: MissionStep;
	last: string;
	/** `null` tant qu'on ne sait pas encore. */
	alive: boolean | null;
	/** Le parcours est en train de le démarrer de lui-même. */
	autoStarting: boolean;
	correction: MissionDraft["review"];
	onDone: () => void;
}) {
	const { notify } = useCockpit();
	const [busy, setBusy] = useState(false);
	// Ce qu'il consulte, à mesure : une ligne qui change dit que ça avance, et
	// voir passer les fichiers qu'il ouvre permet de lire les mêmes.
	const [trail, setTrail] = useState<string[]>([]);
	useEffect(() => {
		const line = last.trim();
		if (!line) return;
		setTrail((current) => (current[0] === line ? current : [line, ...current].slice(0, 6)));
	}, [last]);

	const relaunch = async () => {
		setBusy(true);
		try {
			await api.missions.launchMaster(mission.id);
			notify("Maître relancé : il repart de ce qui a été validé.");
			onDone();
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const copy = COPY[step];
	const absent = alive === false;
	// Le lancement automatique en cours n'est pas une panne : on ne l'habille
	// pas en alerte.
	const starting = absent && (busy || autoStarting);
	const stopped = absent && !starting;

	return (
		<section className="panel rise flex flex-col gap-4 p-5">
			<div className="flex items-start gap-3.5">
				<span
					className={clsx(
						"relative grid size-11 shrink-0 place-items-center rounded-full",
						stopped ? "bg-warning/10 text-warning" : "bg-accent-dim text-accent-soft",
					)}
				>
					<Bot size={19} className={clsx((alive || starting) && "breathe")} />
					{alive ? (
						<span className="animate-pulse-dot absolute -inset-1 rounded-full border border-accent/40" />
					) : null}
				</span>
				<div className="min-w-0 flex-1">
					{/* Le titre suit l'état réel : « Le maître lit le ticket » au-dessus
					    d'un maître absent disait deux choses contraires à la fois. */}
					<h2 className="text-[14px] font-semibold text-ink">
						{starting ? "Le maître démarre…" : stopped ? "Le maître est à l'arrêt" : copy.working}
					</h2>
					<p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
						{starting
							? "Il prend le ticket et repart de ce qui a déjà été validé. Quelques secondes."
							: stopped
								? "Personne ne travaille sur cette étape pour l'instant : aucune proposition n'arrivera tant qu'il n'est pas relancé."
								: copy.workingHint}
					</p>
				</div>
			</div>

			{correction ? (
				<div className="rounded-xl border border-warning/25 bg-warning/[0.06] p-3">
					<div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-warning uppercase">
						<PenLine size={11} />
						Ta correction, en cours de prise en compte
					</div>
					{correction.feedback ? (
						<p className="text-selectable text-[12px] leading-relaxed text-ink-muted">
							{correction.feedback}
						</p>
					) : null}
					{correction.answers.some((answer) => answer.trim()) ? (
						<p className="mt-1 text-[11px] text-ink-faint">+ tes réponses à ses questions</p>
					) : null}
				</div>
			) : null}

			{!stopped ? (
				<div className="rounded-xl border border-line-soft bg-base/50 p-3">
					<div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
						<Eye size={11} />
						Ce qu'il fait en ce moment
					</div>
					{trail.length === 0 ? (
						<div className="flex flex-col gap-1.5">
							<div className="skeleton h-3 w-3/4 rounded" />
							<div className="skeleton h-3 w-1/2 rounded" />
						</div>
					) : (
						<ul className="flex flex-col gap-1">
							{trail.map((line, index) => (
								<li
									key={`${line}-${index}`}
									className={clsx(
										"animate-in flex items-start gap-2 font-mono text-[11px] leading-relaxed",
										index === 0 ? "text-ink" : "text-ink-faint",
									)}
									style={{ opacity: 1 - index * 0.14 }}
								>
									<span
										className={clsx(
											"mt-[7px] size-1 shrink-0 rounded-full",
											index === 0 ? "bg-accent-soft" : "bg-line",
										)}
									/>
									<span className="min-w-0 break-words">{line}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			) : (
				// Un maître absent ne se voit pas : rien ne bouge, et l'on attendrait
				// indéfiniment une proposition qui ne viendra pas. Cockpit redémarré,
				// maître coupé — la cause importe moins que le geste pour repartir.
				<div className="flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/[0.06] p-3">
					<Hourglass size={15} className="shrink-0 text-warning" />
					<p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-muted">
						Le maître ne tourne pas. Relance-le : il repartira de ce qui a déjà été validé, sans te
						redemander ce que tu as signé.
					</p>
					<Button variant="solid" icon={RotateCcw} loading={busy} onClick={() => void relaunch()}>
						Relancer le maître
					</Button>
				</div>
			)}
		</section>
	);
}

/**
 * Une proposition du maître, lisible d'un coup d'œil.
 *
 * Chaque ligne est posée seule, et ce qui précède un deux-points devient son
 * intitulé : « On demande : … », « Hors périmètre : … » se lisent comme une
 * fiche plutôt que comme un paragraphe.
 */
function Proposal({
	step,
	draft,
	version,
}: {
	step: MissionStep;
	draft: MissionDraft;
	version: number;
}) {
	const lines = draft.text.split("\n").filter((line) => line.trim());
	const max = step === "understanding" ? 10 : 15;
	const Icon = step === "understanding" ? Lightbulb : Compass;

	return (
		<article className="panel rise overflow-hidden">
			<div className="flex items-center gap-2.5 border-b border-line-soft bg-accent/[0.05] px-4 py-3">
				<span className="grid size-7 place-items-center rounded-lg bg-accent-dim text-accent-soft">
					<Icon size={14} />
				</span>
				<h2 className="flex-1 text-[13px] font-semibold text-ink">{COPY[step].proposal}</h2>
				{version > 1 ? <Badge tone="accent">v{version}</Badge> : null}
				<span
					className="font-mono text-[10px] text-ink-faint"
					title="Le cockpit refuse toute proposition plus longue"
				>
					{lines.length}/{max} lignes
				</span>
			</div>
			<ol className="flex flex-col px-4 py-2">
				{lines.map((line, index) => (
					<ProposalLine key={index} line={line} />
				))}
			</ol>
			<div className="px-4 pb-3 text-[10px] text-ink-faint">{fromIso(draft.submittedAt)}</div>
		</article>
	);
}

function ProposalLine({ line }: { line: string }) {
	const clean = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
	const match = clean.match(/^\**([^:*]{2,32})\**\s*:\s*(.+)$/);
	return (
		<li className="text-selectable flex gap-3 border-b border-line-soft/60 py-2 text-[12.5px] leading-relaxed last:border-b-0">
			<span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-accent-soft/60" />
			{match ? (
				<span className="grid min-w-0 flex-1 grid-cols-[112px_minmax(0,1fr)] gap-3">
					<span className="text-[11.5px] font-semibold text-ink">{match[1]}</span>
					<span className="text-ink-muted">{match[2]}</span>
				</span>
			) : (
				<span className="min-w-0 text-ink-muted">{clean}</span>
			)}
		</li>
	);
}

/** Le découpage : une carte par exécutant, avec ce qu'il touche et quand il part. */
function SplitProposal({
	mission,
	draft,
	version,
}: {
	mission: Mission;
	draft: MissionDraft;
	version: number;
}) {
	const roles = useAsync(() => api.missions.roles(), []);
	const estimate = useAsync(
		() => api.missions.estimate(mission.tasks.length),
		[mission.tasks.length],
	);
	const verifying = new Set(
		(roles.data ?? []).filter((role) => role.verifies).map((role) => role.id),
	);
	const labelOf = (id: string) => roles.data?.find((role) => role.id === id)?.label ?? id;

	return (
		<article className="panel rise overflow-hidden">
			<div className="flex items-center gap-2.5 border-b border-line-soft bg-accent/[0.05] px-4 py-3">
				<span className="grid size-7 place-items-center rounded-lg bg-accent-dim text-accent-soft">
					<ListTree size={14} />
				</span>
				<h2 className="flex-1 text-[13px] font-semibold text-ink">{COPY.split.proposal}</h2>
				{version > 1 ? <Badge tone="accent">v{version}</Badge> : null}
				<Badge>
					{mission.tasks.length} exécutant{mission.tasks.length > 1 ? "s" : ""}
				</Badge>
			</div>

			{draft.text ? (
				<p className="text-selectable border-b border-line-soft px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted">
					{draft.text}
				</p>
			) : null}

			<ol className="flex flex-col gap-2 p-3">
				{mission.tasks.map((task, index) => (
					<TaskCard
						key={task.id}
						index={index}
						task={task}
						mission={mission}
						role={labelOf(task.role)}
						verifies={verifying.has(task.role)}
					/>
				))}
			</ol>

			{estimate.data && estimate.data.sample > 0 ? (
				// Ce que l'accord engage, avant de le donner : quatre tâches confiées à
				// des agents, c'est une nuit de machine ou dix minutes.
				<div className="flex items-center gap-1.5 border-t border-line-soft px-4 py-2.5 text-[11px] text-ink-faint">
					<Hourglass size={12} className="shrink-0" />≈ {duration(estimate.data.expectedSeconds)} de
					travail, d'après {estimate.data.sample} mission{estimate.data.sample > 1 ? "s" : ""} de
					taille voisine
					{estimate.data.failureRate > 0.25
						? ` · ${Math.round(estimate.data.failureRate * 100)} % ont échoué`
						: ""}
				</div>
			) : null}
		</article>
	);
}

function TaskCard({
	index,
	task,
	mission,
	role,
	verifies,
}: {
	index: number;
	task: MissionTask;
	mission: Mission;
	role: string;
	verifies: boolean;
}) {
	const [open, setOpen] = useState(false);
	const after =
		task.base && task.base !== mission.branch
			? mission.tasks.find((sister) => sister.branch === task.base)
			: undefined;

	return (
		<li className="rounded-xl border border-line-soft bg-surface/60 p-3">
			<div className="flex items-start gap-2.5">
				<span className="grid size-6 shrink-0 place-items-center rounded-full bg-raised font-mono text-[11px] text-ink-muted">
					{index + 1}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<Badge tone={verifies ? "info" : "accent"}>{role}</Badge>
						{verifies ? (
							<span className="flex items-center gap-1 text-[10px] text-info">
								<ShieldCheck size={11} />
								juge le travail des autres
							</span>
						) : null}
					</div>
					<p className="text-selectable mt-1 text-[12.5px] leading-snug font-medium text-ink">
						{task.title}
					</p>

					<div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-faint">
						<FolderTree size={11} className="shrink-0" />
						{task.scope.length > 0 ? (
							task.scope.map((path) => (
								<span
									key={path}
									className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
								>
									{path}
								</span>
							))
						) : verifies ? (
							// Une vérification lit tout : son absence de périmètre est la règle.
							<span>tout le dépôt, en lecture</span>
						) : (
							<span className="text-warning">tout le dépôt — aucun périmètre déclaré</span>
						)}
					</div>
					{after ? (
						<div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-ink-faint">
							<GitBranch size={11} className="shrink-0" />
							part après « {after.title} »
						</div>
					) : null}

					{task.brief ? (
						<>
							<button
								type="button"
								onClick={() => setOpen((value) => !value)}
								className="focus-ring mt-2 rounded text-[10.5px] font-medium text-accent-soft hover:text-accent"
							>
								{open ? "Masquer la consigne" : "Lire sa consigne complète"}
							</button>
							{open ? (
								<div className="mt-2 rounded-lg border border-line-soft bg-base/60 p-3">
									<Markdown source={task.brief} />
								</div>
							) : null}
						</>
					) : null}
				</div>
			</div>
		</li>
	);
}

/** Valider, ou corriger — et répondre aux questions dans le même geste. */
function Decision({
	mission,
	step,
	draft,
	onDone,
}: {
	mission: Mission;
	step: MissionStep;
	draft: MissionDraft;
	onDone: () => void;
}) {
	const { notify } = useCockpit();
	const [answers, setAnswers] = useState<string[]>(() => draft.questions.map(() => ""));
	const [feedback, setFeedback] = useState("");
	const [busy, setBusy] = useState<"approve" | "correct" | null>(null);

	const answered = answers.filter((answer) => answer.trim()).length;
	const open = draft.questions.length - answered;
	const canCorrect = feedback.trim().length > 0 || answered > 0;

	const send = async (approved: boolean) => {
		setBusy(approved ? "approve" : "correct");
		try {
			await api.missions.review(mission.id, step, approved, feedback, answers);
			notify(
				approved
					? step === "split"
						? "Découpage validé — les exécutants partent."
						: "Validé — le maître passe à la suite."
					: "Correction envoyée — le maître reprend sa proposition.",
			);
			onDone();
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			{draft.questions.length > 0 ? (
				<section className="rise rise-1 flex flex-col gap-2">
					<div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-warning uppercase">
						<HelpCircle size={12} />
						Il a besoin de toi · {draft.questions.length} question
						{draft.questions.length > 1 ? "s" : ""}
					</div>
					{draft.questions.map((question, index) => (
						<div
							key={question}
							className={clsx(
								"rounded-xl border p-3 transition-colors",
								answers[index]?.trim()
									? "border-success/30 bg-success/[0.05]"
									: "border-warning/30 bg-warning/[0.05]",
							)}
						>
							<p className="text-selectable mb-2 text-[12.5px] leading-relaxed text-ink">
								{question}
							</p>
							<textarea
								rows={1}
								value={answers[index] ?? ""}
								onChange={(event) =>
									setAnswers((current) =>
										current.map((value, at) => (at === index ? event.target.value : value)),
									)
								}
								placeholder="Ta réponse…"
								className="focus-ring w-full resize-y rounded-lg border border-line-soft bg-raised px-2.5 py-1.5 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/40"
							/>
						</div>
					))}
				</section>
			) : null}

			<section className="rise rise-2 sticky bottom-0 flex flex-col gap-2.5 rounded-xl border border-accent/35 bg-surface p-3 shadow-[0_-12px_24px_-12px_rgba(0,0,0,0.35)]">
				<div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
					<MessageSquare size={12} />
					Une précision, une correction ?
				</div>
				<textarea
					rows={2}
					value={feedback}
					onChange={(event) => setFeedback(event.target.value)}
					placeholder={
						step === "understanding"
							? "Ex. : ce n'est pas l'écran admin qui est visé, c'est l'espace client."
							: step === "approach"
								? "Ex. : réutilise le service d'export existant plutôt qu'en créer un."
								: "Ex. : fusionne les deux tâches front, elles touchent les mêmes fichiers."
					}
					className="focus-ring w-full resize-y rounded-lg border border-line-soft bg-raised px-2.5 py-1.5 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/40"
				/>
				<div className="flex flex-wrap items-center gap-2">
					<span className="min-w-0 flex-1 text-[10.5px] leading-snug text-ink-faint">
						{open > 0
							? `${open} question${open > 1 ? "s" : ""} sans réponse : en validant, le maître tranchera seul.`
							: feedback.trim()
								? "Valider transmet aussi ta précision."
								: "Rien ne part sans ton accord."}
					</span>
					<Button
						variant="outline"
						icon={PenLine}
						disabled={!canCorrect || busy !== null}
						loading={busy === "correct"}
						title={
							canCorrect
								? undefined
								: "Écris ce qui ne va pas : sans motif, le maître referait la même proposition."
						}
						onClick={() => void send(false)}
					>
						Demander une nouvelle version
					</Button>
					<Button
						variant="solid"
						icon={Check}
						loading={busy === "approve"}
						disabled={busy !== null}
						onClick={() => void send(true)}
					>
						{COPY[step].approve}
					</Button>
				</div>
			</section>
		</>
	);
}

/** Ce qui a été décidé sur une étape passée. */
function Verdict({ draft }: { draft: MissionDraft }) {
	const review = draft.review;
	if (!review) return null;
	return (
		<div
			className={clsx(
				"flex flex-col gap-1.5 rounded-xl border p-3",
				review.approved
					? "border-success/30 bg-success/[0.05]"
					: "border-warning/30 bg-warning/[0.05]",
			)}
		>
			<div
				className={clsx(
					"flex items-center gap-1.5 text-[11px] font-semibold",
					review.approved ? "text-success" : "text-warning",
				)}
			>
				{review.approved ? <Check size={12} /> : <PenLine size={12} />}
				{review.approved ? "Validée" : "Corrigée"} · {fromIso(review.at)}
			</div>
			<ReviewDetails draft={draft} />
		</div>
	);
}

function ReviewDetails({ draft }: { draft: MissionDraft }) {
	const review = draft.review;
	if (!review) return null;
	const pairs = draft.questions
		.map((question, index) => ({
			question,
			answer: review.answers[index] ?? "",
		}))
		.filter((pair) => pair.answer.trim());
	return (
		<>
			{pairs.map((pair) => (
				<p key={pair.question} className="text-[11.5px] leading-relaxed text-ink-muted">
					<span className="text-ink-faint">{pair.question} → </span>
					{pair.answer}
				</p>
			))}
			{review.feedback ? (
				<p className="text-selectable text-[11.5px] leading-relaxed text-ink-muted">
					« {review.feedback} »
				</p>
			) : null}
		</>
	);
}

/** Les versions précédentes, avec ce qui leur a été reproché : le dialogue entier. */
function Versions({ drafts, step }: { drafts: MissionDraft[]; step: MissionStep }) {
	const [open, setOpen] = useState(false);
	if (drafts.length === 0) return null;
	return (
		<section className="flex flex-col gap-2">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="focus-ring flex items-center gap-1.5 self-start rounded text-[11px] font-medium text-ink-faint hover:text-ink-muted"
			>
				<History size={12} />
				{open ? "Masquer" : "Voir"} les versions précédentes · {drafts.length}
			</button>
			{open
				? drafts.map((draft, index) => (
						<div
							key={draft.submittedAt + index}
							className="animate-in flex flex-col gap-2 rounded-xl border border-line-soft p-3 opacity-80"
						>
							<div className="flex items-center gap-2 text-[10px] text-ink-faint">
								<Badge>v{index + 1}</Badge>
								{fromIso(draft.submittedAt)}
							</div>
							{step === "split" ? (
								<p className="text-[12px] leading-relaxed text-ink-muted">{draft.text}</p>
							) : (
								<ol className="flex flex-col">
									{draft.text
										.split("\n")
										.filter((line) => line.trim())
										.map((line, at) => (
											<ProposalLine key={at} line={line} />
										))}
								</ol>
							)}
							{draft.review ? (
								<div className="border-t border-line-soft pt-2">
									<ReviewDetails draft={draft} />
								</div>
							) : null}
						</div>
					))
				: null}
		</section>
	);
}

/* ── Le ticket, en lecture ─────────────────────────────────────────────── */

function TicketReader({ reference, fallbackTitle }: { reference: string; fallbackTitle: string }) {
	const { notify } = useCockpit();
	const issue = useAsync(
		() => (reference ? api.feeds.linearIssue(reference) : Promise.resolve(null)),
		[reference],
	);
	const comments = useMemo(() => issue.data?.comments ?? [], [issue.data]);

	return (
		<>
			<div className="flex items-center gap-2 border-b border-line-soft px-5 py-2.5">
				<Ticket size={13} className="shrink-0 text-accent-soft" />
				<span className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
					Le ticket
				</span>
				<span className="flex-1" />
				{issue.data?.url ? (
					<Button
						size="sm"
						icon={ExternalLink}
						title="Ouvrir chez le fournisseur"
						onClick={() => {
							void api.system
								.openUrl(issue.data?.url ?? "")
								.catch((error) => notify(String(error)));
						}}
					/>
				) : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{!reference ? (
					<p className="text-[12px] text-ink-faint">
						Cette mission ne vient pas d'un ticket : « {fallbackTitle} ».
					</p>
				) : issue.error ? (
					<ErrorNote error={issue.error} onRetry={issue.reload} />
				) : !issue.data ? (
					<div className="flex flex-col gap-2">
						<div className="skeleton h-4 w-2/3 rounded" />
						<div className="skeleton h-3 w-full rounded" />
						<div className="skeleton h-3 w-5/6 rounded" />
						<div className="skeleton h-3 w-3/4 rounded" />
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div>
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="font-mono text-[11px] text-ink-faint">
									{issue.data.identifier}
								</span>
								{issue.data.state ? <Badge tone="accent">{issue.data.state.name}</Badge> : null}
								<PriorityBadge priority={issue.data.priority} />
								{issue.data.labels.map((label) => (
									<span
										key={label.id}
										className="flex items-center gap-1 rounded-md border border-line-soft px-1.5 py-0.5 text-[10px] text-ink-muted"
									>
										{label.color ? (
											<span
												className="size-1.5 rounded-full"
												style={{ backgroundColor: label.color }}
											/>
										) : null}
										{label.name}
									</span>
								))}
							</div>
							<h2 className="text-selectable mt-1.5 text-[15px] leading-snug font-semibold text-ink">
								{issue.data.title}
							</h2>
							{issue.data.assignee ? (
								<p className="mt-1 text-[10.5px] text-ink-faint">
									Assigné à {issue.data.assignee.name}
								</p>
							) : null}
						</div>

						{issue.data.description ? (
							<Markdown source={issue.data.description} />
						) : (
							<p className="text-[12px] text-ink-faint">Pas de description.</p>
						)}

						{comments.length > 0 ? (
							<div>
								<div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
									<MessageSquare size={11} />
									Commentaires · {comments.length}
								</div>
								<div className="flex flex-col gap-2.5">
									{comments.map((comment) => (
										<div key={comment.id} className="rounded-xl border border-line-soft p-2.5">
											<div className="mb-1 flex items-baseline gap-2">
												<span className="text-[11px] font-medium text-ink">{comment.author}</span>
												<span className="font-mono text-[10px] text-ink-faint">
													{fromIso(comment.createdAt)}
												</span>
											</div>
											<Markdown source={comment.body} />
										</div>
									))}
								</div>
							</div>
						) : null}
					</div>
				)}
			</div>
		</>
	);
}

/** Un repère discret pour la liste : où en est une mission guidée. */
export function JourneyDots({ mission }: { mission: Mission }) {
	const current = currentIndex(mission);
	return (
		<span className="flex items-center gap-1">
			{JOURNEY.map((entry, index) => {
				const phase = phaseOf(mission, index, current);
				return (
					<span
						key={entry.label}
						title={entry.label}
						className={clsx(
							"h-1.5 rounded-full transition-all",
							phase === "yours" ? "w-4 bg-accent" : "w-1.5",
							phase === "done" && "bg-success/70",
							phase === "master" && "bg-accent-soft/60",
							phase === "upcoming" && "bg-line",
							phase === "failed" && "bg-critical",
						)}
					/>
				);
			})}
		</span>
	);
}
