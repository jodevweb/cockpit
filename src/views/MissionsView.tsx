import clsx from "clsx";
import {
	BookOpen,
	Bot,
	ClipboardCopy,
	Clock,
	Coins,
	ChevronDown,
	ChevronRight,
	CircleDot,
	GitBranch,
	GitMerge,
	GitPullRequest,
	Hourglass,
	ListChecks,
	MessageSquare,
	Route,
	PauseCircle,
	Play,
	PlayCircle,
	Plus,
	RotateCcw,
	StopCircle,
	ShieldAlert,
	ShieldQuestion,
	Ticket,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	Badge,
	Button,
	Empty,
	ErrorNote,
	Field,
	Spinner,
	TextInput,
	ViewHeader,
} from "@/components/ui";
import { QuestionForm } from "@/components/AgentChat";
import { MissionHistory, totalSpend } from "@/components/MissionHistory";
import { JourneyDots, MissionJourney } from "@/components/MissionJourney";
import { QuickMenu } from "@/components/QuickMenu";
import { useConfirm } from "@/components/Confirm";
import { Markdown } from "@/components/Markdown";
import { withActivity } from "@/lib/activity";
import { duration, elapsedSeconds, fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import {
	awaitedDecision,
	awaitsHuman,
	MISSION_STATE_LABELS,
	resolveMasterCwd,
} from "@/lib/missions";
import { readQuestions } from "@/lib/types";
import type {
	AgentActivity,
	Mission,
	MissionActivity,
	MissionState,
	MissionOverrun,
	MissionTask,
} from "@/lib/types";
import { isQuestion, useAgentActions, useAgentGuard } from "@/app/agents";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { useWorkspace } from "@/app/workspace";

/**
 * Missions : un ticket, un plan, des exécutants.
 *
 * L'écran raconte une progression, pas un enregistrement. La première version
 * affichait des champs et des états — « aucune tâche », « maître actif » — sans
 * jamais montrer ce qui se passait : on lançait un agent, et plus rien ne
 * bougeait. Ici, chaque étape dit ce qu'elle attend, et ce que les agents
 * fabriquent reste visible en continu.
 *
 * Une mission s'ouvre en collant l'adresse d'un ticket : titre, identifiant et
 * branche viennent du suivi de tâches. Redemander à quelqu'un ce qu'il a déjà
 * sous les yeux est la meilleure façon de rendre un outil pénible.
 */

/**
 * Ce que la mission est en train de faire, en une ligne.
 *
 * Une étape seule ne suffit pas : « Analyse » s'affichait aussi bien quand le
 * maître n'était pas lancé que quand il découpait déjà le ticket, et le texte
 * réclamait de le lancer alors qu'il travaillait. On lit donc l'état de la
 * mission **et** celui de son maître, et sa dernière phrase remplace la consigne
 * générique dès qu'il en a une : c'est elle qui dit que quelque chose avance.
 */
function situation(
	mission: Mission,
	master: AgentActivity | null,
	step: { label: string; waiting: string },
	/** L'activité a été lue : un maître absent l'est vraiment, pas « pas encore su ». */
	known: boolean,
): { label: string; detail: string; live: boolean } {
	// `working`, pas `running` : un maître qui a fini son tour garde son
	// processus ouvert en attendant la suite. Lire `running` faisait tourner la
	// roue ici pendant que sa propre ligne, plus bas, le disait en attente.
	const busy = master?.working === true;

	// Une mission guidée, avant l'exécution, se pilote depuis son parcours :
	// la carte ne fait que dire qui a la main.
	if (mission.guided && !["running", "integrating", "done", "failed"].includes(mission.state)) {
		const label = MISSION_STATE_LABELS[mission.state];
		return {
			label: label.charAt(0).toUpperCase() + label.slice(1),
			detail: awaitsHuman(mission)
				? `${awaitedDecision(mission)}.`
				: known && !master?.running
					? // Annoncer une rédaction que personne ne mène ferait attendre
						// une proposition qui ne viendra pas.
						"Le maître ne tourne pas — ouvre le parcours, il y repart tout seul."
					: "Le maître rédige sa proposition — suis-le dans le parcours, ticket à côté.",
			live: busy && !awaitsHuman(mission),
		};
	}
	if (mission.paused && mission.state !== "failed") {
		return {
			label: "En pause",
			detail: "Rien ne repart tant que tu n'as pas repris la mission.",
			live: false,
		};
	}
	// Ce que dit l'agent est déjà sous les yeux, ligne « Agent maître » : le
	// répéter ici ne donnait rien de plus et faisait bouger deux textes pour un
	// seul événement. Cette ligne-ci dit l'étape, pas le détail.
	if (mission.state === "planning" && busy) {
		return {
			label: "Découpage",
			detail:
				"Le maître lit le ticket et découpe le travail en tâches. Tu relis son plan avant que le moindre exécutant ne parte.",
			live: true,
		};
	}
	if (mission.state === "integrating" && busy) {
		return {
			label: "Intégration",
			detail:
				"Le maître recompose les branches livrées dans la branche d'intégration, puis ouvrira la pull request.",
			live: true,
		};
	}
	return { label: step.label, detail: step.waiting, live: false };
}

/** Les étapes, dans l'ordre où on les traverse. */
const STEPS: Array<{ state: MissionState; label: string; waiting: string }> = [
	{
		state: "planning",
		label: "Analyse",
		waiting: "Lance le maître : il lira le ticket et proposera un découpage.",
	},
	{
		state: "awaitingApproval",
		label: "Plan",
		waiting: "Un découpage est proposé. Relis-le : rien ne démarre sans ton accord.",
	},
	{
		state: "running",
		label: "Exécution",
		waiting: "Les exécutants partent dès que leur base existe, chacun dans son worktree.",
	},
	{
		state: "integrating",
		label: "Intégration",
		waiting: "Tout est livré. Le maître recompose les branches, puis ouvre la PR.",
	},
	{ state: "done", label: "Livrée", waiting: "Mission close." },
];

/** Rang de l'étape d'exécution : la seule qui dure assez pour se remplir. */
const STEP_RUNNING = 2;

/** États où une mission a des agents à piloter — donc à reprendre ou couper. */
const ONGOING: MissionState[] = ["running", "integrating"];

/** Comment se dit un verdict, et sur quel ton. */
const VERDICTS: Record<string, { label: string; tone: "critical" | "warning" | "success" }> = {
	blocking: { label: "refusée", tone: "critical" },
	reserves: { label: "réserves", tone: "warning" },
	ok: { label: "vérifiée", tone: "success" },
	// Elle a parlé sans conclure. Ni refus ni accord — et surtout pas un blanc,
	// qui se lirait comme « rien à redire ».
	undecided: { label: "sans verdict", tone: "warning" },
};

const TASK_LABELS: Record<string, { label: string; tone: string }> = {
	planned: { label: "à lancer", tone: "neutral" },
	running: { label: "en cours", tone: "info" },
	delivered: { label: "livrée", tone: "success" },
	integrated: { label: "intégrée", tone: "accent" },
	failed: { label: "échouée", tone: "critical" },
};

export function MissionsView() {
	const { notify, activeProject, hasConnector, connectors, go, focus, clearFocus } =
		useCockpit();
	const { confirm } = useConfirm();
	const missions = useAsync(() => api.missions.list(), [], { pollMs: 10_000 });
	// Ce qui déborde, sur toutes les missions à la fois : le repère se calcule
	// sur l'historique commun, le demander mission par mission relirait les
	// mêmes fichiers pour le même chiffre. Une tâche qui traîne se compte en
	// heures — la guetter à la minute n'apprendrait rien de plus.
	const overruns = useAsync(() => api.missions.overruns(), [], { pollMs: 120_000 });
	const [reference, setReference] = useState("");
	const [opening, setOpening] = useState(false);

	const open = async (picked?: string) => {
		const source = (picked ?? reference).trim();
		if (!source) return;
		// La même question qu'au bouton « Lancer en mission » : ce geste démarre
		// un agent, où qu'on le fasse.
		const ok = await confirm({
			title: `Lancer une mission sur ${source} ?`,
			message:
				"L'agent maître démarre tout de suite et lit le ticket. Rien d'autre ne part avant ton accord.",
			confirmLabel: "Lancer la mission",
		});
		if (!ok) return;
		setOpening(true);
		try {
			// Ouvrir, c'est aussi lancer le maître : ce champ créait la mission
			// seule, et une mission guidée arrivait sur un parcours qui annonçait
			// « le maître écrit » au-dessus d'un maître que personne n'avait démarré.
			const { mission } = await withActivity(
				`Mission depuis ${source}`,
				() => api.missions.startFromTicket(source),
				{
					firstStep: "Je lis le ticket et je lance l'agent maître…",
					result: (value) => value.message,
				},
			);
			setReference("");
			missions.reload();
			// Guidée, elle se suit sur son parcours : le ticket s'y lit pendant que
			// le maître le lit.
			if (mission.guided) setOpenId(mission.id);
		} catch (error) {
			notify(String(error));
			// La mission peut exister sans son maître — Node absent, worktree
			// refusé : elle doit paraître dans la liste, d'où on la relancera.
			missions.reload();
		} finally {
			setOpening(false);
		}
	};

	const list = missions.data ?? [];

	// La mission ouverte sur son parcours. On y arrive aussi d'ailleurs — le
	// bouton « Lancer en mission » d'un ticket, un blocage d'Aujourd'hui — et
	// c'est alors elle qu'on veut voir, pas la liste où la chercher.
	const [openId, setOpenId] = useState<string | null>(null);
	useEffect(() => {
		if (focus.missionId) {
			setOpenId(focus.missionId);
			clearFocus();
			missions.reload();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focus.missionId]);

	const remove = async (mission: Mission) => {
		// Ce que la suppression emporte est énuméré : c'est du travail sur
		// disque, et « supprimer la mission » ne dit pas assez que des branches
		// et des worktrees partent avec elle.
		const worktrees = mission.tasks.filter((task) => task.worktree).length;
		const ok = await confirm({
			title: `Tout supprimer pour « ${mission.title} » ?`,
			message:
				`Les agents sont coupés, puis ${worktrees} worktree(s), les branches ` +
				`de la mission — branche d'intégration comprise — et les conversations ` +
				`des exécutants sont effacés. Le travail non poussé sera perdu.`,
			confirmLabel: "Tout supprimer",
			danger: true,
		});
		if (!ok) return;
		try {
			const done = await api.missions.purge(mission.id);
			notify(`Mission supprimée — ${done.length} élément(s) effacé(s).`);
			setOpenId(null);
		} catch (error) {
			notify(String(error));
		}
		missions.reload();
	};

	const opened = openId ? list.find((mission) => mission.id === openId) : undefined;
	if (openId && hasConnector("tickets")) {
		if (!opened) {
			return (
				<div className="flex min-h-0 flex-1 items-center justify-center">
					<Spinner />
				</div>
			);
		}
		return (
			<MissionJourney
				mission={opened}
				onBack={() => setOpenId(null)}
				onChange={missions.reload}
				execution={
					<MissionCard
						mission={opened}
						overruns={(overruns.data ?? []).filter((entry) => entry.missionId === opened.id)}
						onChange={missions.reload}
						onRemove={() => void remove(opened)}
					/>
				}
			/>
		);
	}

	// Une mission part d'un ticket : sans suivi de tâches, le champ ci-dessous
	// n'a rien à lire et l'écran se réduisait à un formulaire qui échoue. Dire
	// à quoi sert la fonctionnalité, et ce qu'il lui manque, vaut mieux qu'un
	// message d'erreur au premier essai.
	if (!hasConnector("tickets")) {
		const tickets = connectors.find((entry) => entry.kind === "tickets");
		return (
			<>
				<ViewHeader title="Missions" subtitle="Un ticket, un plan, des exécutants" />
				<div className="flex min-h-0 flex-1 items-center justify-center p-8">
					<div className="panel flex max-w-lg flex-col gap-3 p-6">
						<div className="flex items-center gap-2">
							<ListChecks size={16} className="shrink-0 text-accent-soft" />
							<h2 className="text-[13px] font-semibold text-ink">
								Ce que fait une mission
							</h2>
						</div>
						<p className="text-[11.5px] leading-relaxed text-ink-muted">
							Tu donnes un ticket. Un agent maître le lit, propose un découpage en
							tâches, et attend ton accord — rien ne part avant. Une fois le plan
							approuvé, chaque tâche reçoit son exécutant, sa branche et son
							worktree ; le maître recompose leur travail à la fin et ouvre la pull
							request.
						</p>
						<p className="text-[11.5px] leading-relaxed text-ink-muted">
							C'est la différence avec un agent lancé à la main : ici le cockpit
							tient le lien entre le ticket, le plan, les branches et ce qui a été
							livré — et le retrouve entier même s'il redémarre au milieu.
						</p>
						<div className="rounded-lg border border-line-soft bg-surface/60 p-3">
							<p className="text-[11px] font-medium text-ink">Ce qu'il manque ici</p>
							<p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
								Un suivi de tâches, pour lire le ticket d'origine :{" "}
								{tickets?.missing ?? "un jeton Linear, GitLab ou GitHub"}. Les rôles
								des exécutants ont déjà des valeurs par défaut — tu pourras les
								ajuster ensuite dans « Rôles des agents ».
							</p>
						</div>
						<Button variant="solid" className="self-start" onClick={() => go("settings")}>
							Ouvrir les Réglages
						</Button>
					</div>
				</div>
			</>
		);
	}

	return (
		<>
			<ViewHeader
				title="Missions"
				subtitle="Un ticket, un plan, des exécutants"
				actions={missions.loading ? <Spinner /> : null}
			/>

			{missions.error ? (
				<ErrorNote error={missions.error} onRetry={missions.reload} />
			) : null}

			<div className="min-h-0 flex-1 overflow-y-auto p-5">
				<div className="flex max-w-5xl flex-col gap-4">
					{/* On choisit un ticket dans ceux qui existent, plutôt que d'aller
					    chercher son adresse ailleurs pour la recoller ici. Le collage
					    reste accepté : c'est le geste de qui arrive du navigateur, et le
					    lui interdire ne rendrait service à personne. */}
					<section className="panel flex flex-col gap-2 p-4">
						<span className="text-[11px] font-medium text-ink-muted">
							Ouvrir une mission
						</span>
						<div className="flex items-center gap-2.5">
							<TicketPicker onPick={(identifier) => void open(identifier)} />
							<div className="min-w-0 flex-1">
								<TextInput
									value={reference}
									onChange={setReference}
									placeholder={`ou colle une adresse — ${activeProject?.linearTeamKey || "ABC"}-42, #317…`}
								/>
							</div>
							<Button
								variant="solid"
								icon={Plus}
								disabled={!reference.trim() || opening}
								onClick={() => void open()}
							>
								{opening ? "Lecture du ticket…" : "Ouvrir"}
							</Button>
						</div>
						<span className="text-[10px] leading-relaxed text-ink-faint">
							Le titre et la branche d'intégration viennent du ticket : rien d'autre à
							saisir.
						</span>
					</section>

					{list.length === 0 && !missions.loading ? (
						<Empty
							icon={CircleDot}
							message="Aucune mission en cours"
							hint="Choisis un ticket ci-dessus : un agent maître le lit, propose un découpage et attend ton accord avant de lancer quoi que ce soit. Chaque tâche part ensuite sur sa propre branche, et le maître recompose à la fin."
						/>
					) : null}

					{list.map((mission) => (
						<MissionCard
							key={mission.id}
							mission={mission}
							overruns={(overruns.data ?? []).filter(
								(entry) => entry.missionId === mission.id,
							)}
							onChange={missions.reload}
							onRemove={() => void remove(mission)}
							onJourney={mission.guided ? () => setOpenId(mission.id) : undefined}
						/>
					))}
				</div>
			</div>
		</>
	);
}

function MissionCard({
	mission,
	overruns,
	onChange,
	onRemove,
	onJourney,
}: {
	mission: Mission;
	/** Ses tâches qui débordent du temps qu'une tâche coûte d'ordinaire. */
	overruns: MissionOverrun[];
	onChange: () => void;
	onRemove: () => void;
	/** Ouvre le parcours d'une mission guidée ; absent quand on y est déjà. */
	onJourney?: () => void;
}) {
	const { notify, go, worktrees } = useCockpit();
	const { show } = useWorkspace();
	const [open, setOpen] = useState(mission.state !== "done");
	const [adding, setAdding] = useState(false);
	// Ce que les agents fabriquent : c'est cette information qui manquait, et
	// sans laquelle l'écran semblait figé.
	const activity = useAsync<MissionActivity>(() => api.missions.activity(mission.id), [], {
		pollMs: 4000,
		enabled: mission.state !== "done",
	});

	const stepIndex = Math.max(
		0,
		STEPS.findIndex((step) => step.state === mission.state),
	);
	const step = STEPS[stepIndex] ?? STEPS[0];
	const master = activity.data?.master ?? null;
	const now = situation(mission, master, step, activity.data != null);
	// Le maître travaille dans le worktree de la branche d'intégration, pas
	// dans `mission.cwd` — celui-ci est le dépôt principal, où le cockpit
	// n'écrit jamais (cf. WorkspacePanel.useWorkGroups).
	const masterCwd = resolveMasterCwd(mission, worktrees);
	// Mission guidée avant son dernier accord : tout se décide dans le parcours.
	const prelude =
		mission.guided && !["running", "integrating", "done", "failed"].includes(mission.state);

	// Les rôles qui jugent le travail des autres, et l'état de ceux qui le
	// produisent : c'est ce qui explique qu'une recette n'ait pas démarré.
	const roles = useAsync(() => api.missions.roles(), []);
	const verifying = new Set(
		(roles.data ?? []).filter((role) => role.verifies).map((role) => role.id),
	);
	const implementationDone = mission.tasks
		.filter((task) => !verifying.has(task.role))
		.every((task) => ["delivered", "integrated", "failed"].includes(task.state));

	// Ce que l'étape d'exécution a réellement produit. Une reprise fait reculer
	// ce compte, et c'est voulu : le travail est bien reparti en arrière.
	const delivered = {
		total: mission.tasks.length,
		done: mission.tasks.filter((task) =>
			["delivered", "integrated"].includes(task.state),
		).length,
		reworked: mission.tasks.filter((task) => task.attempts > 0).length,
		get ratio() {
			return this.total > 0 ? this.done / this.total : 0;
		},
	};

	// Approuver un plan déclenche worktrees et exécutants : plusieurs secondes
	// pendant lesquelles le bouton restait cliquable et l'écran muet. On retient
	// donc l'action en cours, pour la faire tourner et la neutraliser.
	const [busy, setBusy] = useState<string | null>(null);

	// Ce que le plan coûtera, tant qu'on peut encore ne pas le lancer. Après
	// l'accord, l'information n'a plus d'usage : on ne la charge donc que là.
	const attend = mission.state === "awaitingApproval";
	const estimate = useAsync(
		() => api.missions.estimate(mission.tasks.length),
		[mission.tasks.length, attend],
		{ enabled: attend },
	);

	// Les vérifications qui refusent encore. Une tâche abandonnée n'en fait pas
	// partie : renoncer à son travail est déjà une décision, et son verdict
	// n'engage plus rien.
	const refus = mission.tasks
		.filter((task) => task.verdict === "blocking" && task.state !== "failed")
		.map((task) => task.title);

	// Celles qui ont rendu sans qu'on sache ce qu'elles concluent. Elles ferment
	// la pull request au même titre qu'un refus : on ne signe pas un travail sur
	// un rapport qu'on n'a pas su lire.
	const indécises = mission.tasks
		.filter((task) => task.verdict === "undecided" && task.state !== "failed");

	const run = async (key: string, action: () => Promise<unknown>, done: string) => {
		setBusy(key);
		try {
			await action();
			notify(done);
			onChange();
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(null);
		}
	};

	return (
		<section className="panel flex flex-col gap-3 p-3">
			<div className="flex items-start gap-2">
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					className="focus-ring mt-0.5 rounded text-ink-faint"
				>
					{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
				</button>

				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-[13px] font-semibold text-ink">{mission.title}</h3>
						{mission.guided ? <JourneyDots mission={mission} /> : null}
						{mission.ticket ? (
							<button
								type="button"
								onClick={() => {
									if (mission.ticketUrl) {
										void api.system.openUrl(mission.ticketUrl).catch(() => undefined);
									}
								}}
								className="focus-ring rounded"
							>
								<Badge mono>{mission.ticket}</Badge>
							</button>
						) : null}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-ink-faint">
						<span className="flex items-center gap-1">
							<GitBranch size={10} />
							{mission.branch || "sans branche"}
						</span>
						{/* Le temps depuis l'approbation, pas depuis l'ouverture : c'est
						    ce que la mission a coûté, non ce qu'elle a attendu. */}
						{mission.startedAt ? (
							<span
								className="flex items-center gap-1"
								title={
									mission.finishedAt
										? `Du ${fromIso(mission.startedAt)} au ${fromIso(mission.finishedAt)}`
										: `Démarrée ${fromIso(mission.startedAt)}`
								}
							>
								<Clock size={10} />
								{duration(elapsedSeconds(mission.startedAt, mission.finishedAt))}
								{mission.finishedAt ? "" : "…"}
							</span>
						) : null}
						{/* Sur quoi la PR se greffera. Modifiable tant que la mission
						    n'est pas close : c'est en cours de route qu'on s'aperçoit
						    qu'un travail en prolonge un autre. */}
						<MissionBase mission={mission} onChange={onChange} />
						{/* Ce qu'elle a coûté, juste après ce qu'elle a duré : c'est la
						    même question posée par la dépense, et elle n'avait jusqu'ici
						    aucune réponse à l'écran. */}
						<MissionSpend missionId={mission.id} />
						<span>· {fromIso(mission.updatedAt)}</span>
					</div>
				</div>

				{onJourney ? (
					<Button
						variant={awaitsHuman(mission) ? "solid" : "outline"}
						size="sm"
						icon={Route}
						onClick={onJourney}
					>
						{awaitsHuman(mission) ? "À toi — ouvrir" : "Parcours"}
					</Button>
				) : null}
				<Button size="sm" icon={Trash2} title="Supprimer" onClick={onRemove} />
			</div>

			{/* Les étapes disent où l'on en est, un pourcentage ne le dirait pas.
			    Mais l'étape en cours dure : elle se remplit donc au fur et à mesure
			    que les tâches rendent, faute de quoi rien ne bougeait pendant tout
			    le travail — y compris quand une reprise défaisait ce qui était
			    acquis. */}
			{/* Une mission guidée porte déjà ses étapes à côté du titre : cette
			    barre-ci ne dit que l'exécution, qu'elle n'a pas encore atteinte. */}
			{prelude ? null : (
				<div className="flex items-center gap-1">
					{STEPS.map((entry, index) => (
						<div
							key={entry.state}
							className={clsx(
								"h-1 flex-1 overflow-hidden rounded-full transition-colors",
								index < stepIndex && "bg-accent",
								index > stepIndex && "bg-raised",
								index === stepIndex && (index === STEP_RUNNING ? "bg-raised" : "bg-accent-soft"),
							)}
						>
							{index === stepIndex && index === STEP_RUNNING ? (
								<div
									className="h-full rounded-full bg-accent-soft transition-[width] duration-500"
									style={{ width: `${Math.round(delivered.ratio * 100)}%` }}
								/>
							) : null}
						</div>
					))}
				</div>
			)}
			{delivered.total > 0 && mission.state === "running" ? (
				<div className="-mt-1.5 text-[10px] text-ink-faint">
					{delivered.done} tâche{delivered.done > 1 ? "s" : ""} rendue
					{delivered.done > 1 ? "s" : ""} sur {delivered.total}
					{delivered.reworked > 0
						? ` · ${delivered.reworked} passée${delivered.reworked > 1 ? "s" : ""} par une reprise`
						: ""}
				</div>
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={mission.state === "failed" ? "critical" : "accent"}>
					{now.label}
				</Badge>
				{now.live ? <Spinner className="shrink-0" /> : null}
				<span className="min-w-0 flex-1 text-[11px] text-ink-muted">{now.detail}</span>

				{mission.state === "planning" && !mission.masterSession && !mission.guided ? (
					<Button
						variant="solid"
						icon={Bot}
						loading={busy === "master"}
						onClick={() =>
							void run(
								"master",
								() => api.missions.launchMaster(mission.id),
								"Maître lancé.",
							)
						}
					>
						{busy === "master" ? "Lancement…" : "Lancer le maître"}
					</Button>
				) : null}
				{attend && estimate.data && estimate.data.sample > 0 ? (
					// Un plan s'approuve sans savoir ce qu'il engage : quatre tâches
					// confiées à des agents, c'est une nuit de machine ou dix minutes,
					// et rien ne le disait avant de cliquer.
					<span
						className="flex items-center gap-1.5 text-[11px] text-ink-faint"
						title={`Médiane de ${estimate.data.sample} mission${
							estimate.data.sample > 1 ? "s" : ""
						} close${estimate.data.sample > 1 ? "s" : ""} de taille voisine`}
					>
						<Hourglass size={12} className="shrink-0" />
						<span>
							≈ {duration(estimate.data.expectedSeconds)} de travail
							{estimate.data.failureRate > 0.25
								? ` · ${Math.round(estimate.data.failureRate * 100)} % ont échoué`
								: ""}
							{estimate.data.thin ? " · estimation peu sûre" : ""}
						</span>
					</span>
				) : null}
				{mission.state === "awaitingApproval" && !mission.guided ? (
					<Button
						variant="solid"
						icon={Play}
						loading={busy === "approve"}
						onClick={() =>
							void run(
								"approve",
								() => api.missions.approve(mission.id),
								"Plan approuvé — les exécutants partent.",
							)
						}
					>
						{busy === "approve" ? "Lancement des exécutants…" : "Approuver le plan"}
					</Button>
				) : null}
				{mission.state === "integrating" ? (
					// Ce que la pull request emportera, avant de la demander. Le bouton
					// refuse déjà de partir s'il reste du travail dehors, mais rien ne
					// le disait : on cliquait sans savoir si la recomposition avait eu
					// lieu, et une intégration silencieuse ressemble à une panne.
					(() => {
						const dedans = mission.tasks.filter(
							(task) => task.state === "integrated",
						).length;
						const dehors = mission.tasks.filter((task) =>
							["planned", "running", "delivered"].includes(task.state),
						).length;
						return (
							<span
								className={clsx(
									"flex items-center gap-1.5 text-[11px]",
									dehors > 0 ? "text-warning" : "text-success",
								)}
								title={
									dehors > 0
										? "La pull request refusera de partir tant que ce travail n'est pas fusionné ou abandonné."
										: "Tout le travail livré est dans la branche d'intégration."
								}
							>
								<GitMerge size={12} className="shrink-0" />
								<span>
									{dedans}/{mission.tasks.length} intégrées
									{dehors > 0 ? ` · ${dehors} encore dehors` : ""}
								</span>
							</span>
						);
					})()
				) : null}
				{/* Une vérification qui refuse ferme la pull request. Le bouton le disait
				    déjà en échouant, mais après le clic : on croyait à une panne là où
				    quelqu'un avait simplement nommé un défaut. */}
				{mission.state === "integrating" && refus.length > 0 ? (
					<span
						className="flex items-center gap-1.5 text-[11px] text-critical"
						title={`${refus.join(", ")} — corrige ce qui est reproché, puis relance la vérification : son nouveau verdict lèvera le refus.`}
					>
						<ShieldAlert size={12} className="shrink-0" />
						<span>
							{refus.length} vérification{refus.length > 1 ? "s" : ""} refuse
							{refus.length > 1 ? "nt" : ""}
						</span>
					</span>
				) : null}
				{/* Une vérification sans verdict ferme la PR. Le dire sans nommer
				    laquelle, ni donner le geste qui en sort, laissait l'écran bloqué
				    sans recours visible : on la nomme, et on la relance d'ici. */}
				{mission.state === "integrating"
					? indécises.map((task) => (
							<span
								key={task.id}
								className="flex min-w-0 items-center gap-1.5 text-[11px] text-warning"
								title="Son rapport ne conclut pas de façon lisible. La relancer lui fait tout relire, et finir par « VERDICT: ok », « réserves » ou « bloquant »."
							>
								<ShieldAlert size={12} className="shrink-0" />
								<span className="min-w-0 truncate">Sans verdict : {task.title}</span>
								<Button
									size="sm"
									icon={RotateCcw}
									loading={busy === `rerun:${task.id}`}
									onClick={() =>
										void run(
											`rerun:${task.id}`,
											() => api.missions.rerun(mission.id, task.id),
											`${task.title} — relancée.`,
										)
									}
								>
									Relancer
								</Button>
							</span>
						))
					: null}
				{mission.state === "integrating" ? (
					<Button
						variant="solid"
						icon={GitPullRequest}
						loading={busy === "pr"}
						disabled={refus.length > 0 || indécises.length > 0}
						title={
							refus.length > 0
								? "Une vérification refuse encore : lève son verdict avant d'ouvrir la pull request."
								: indécises.length > 0
									? "Une vérification n'a pas conclu : on ne sait pas si le travail passe. Relance-la avant d'ouvrir la pull request."
									: undefined
						}
						onClick={() =>
							void run(
								"pr",
								() => api.missions.openPr(mission.id),
								"Pull request ouverte.",
							)
						}
					>
						{busy === "pr" ? "Ouverture…" : "Ouvrir la PR"}
					</Button>
				) : null}
				{mission.prUrl ? (
					<Button
						icon={GitPullRequest}
						onClick={() => {
							void api.system.openUrl(mission.prUrl).catch(() => undefined);
						}}
					>
						Voir la PR
					</Button>
				) : null}

				{/* Reprendre, suspendre, couper : les trois gestes qui manquaient
				    quand une mission tournait toute seule et qu'on voulait la
				    main. Ils n'ont de sens qu'une fois le plan approuvé. */}
				{ONGOING.includes(mission.state) ? (
					mission.paused ? (
						<Button
							variant="solid"
							icon={PlayCircle}
							loading={busy === "resume"}
							title="Relance le maître et tout ce qui doit tourner"
							onClick={() =>
								void run(
									"resume",
									() => api.missions.resume(mission.id),
									"Mission reprise.",
								)
							}
						>
							{busy === "resume" ? "Reprise…" : "Reprendre"}
						</Button>
					) : (
						<>
							<Button
								icon={PauseCircle}
								loading={busy === "pause"}
								title="Coupe les agents et suspend le lanceur — le travail reste en place"
								onClick={() =>
									void run(
										"pause",
										() => api.missions.pause(mission.id),
										"Mission suspendue.",
									)
								}
							>
								Pause
							</Button>
							<Button
								variant="danger"
								icon={StopCircle}
								loading={busy === "stop"}
								title="Coupe tout et abandonne la mission"
								onClick={() =>
									void run("stop", () => api.missions.stop(mission.id), "Mission arrêtée.")
								}
							>
								Arrêter
							</Button>
						</>
					)
				) : null}
			</div>

			{open ? (
				<>
					<Pending sessionId={mission.masterSession} />

					{master ? (
						<AgentLine
							title="Agent maître"
							activity={master}
							onOpen={() => {
								// On ouvre son onglet, pas seulement l'écran : « Suivre »
								// doit mener à la conversation, pas à un sélecteur.
								show(masterCwd, { kind: "agent", id: master.sessionId });
								go("workspace");
							}}
						/>
					) : null}

					{/* Le compte rendu passe avant le plan : c'est ce qu'on relit après
					    coup, quand quelqu'un demande comment ça marche. */}
					{mission.summary ? (
						<div className="rounded-lg border border-success/25 bg-success/[0.06] p-3">
							<div className="mb-1.5 flex items-center gap-2">
								<BookOpen size={12} className="shrink-0 text-success" />
								<span className="text-[10px] font-semibold tracking-[0.08em] text-success uppercase">
									Comment ça marche
								</span>
								<div className="flex-1" />
								<Button
									size="sm"
									icon={ClipboardCopy}
									onClick={() => {
										void navigator.clipboard
											.writeText(
												`# ${mission.title}${mission.ticket ? ` (${mission.ticket})` : ""}\n\n${mission.summary}${mission.prUrl ? `\n\nPull request : ${mission.prUrl}` : ""}`,
											)
											.then(() => notify("Compte rendu copié."))
											.catch(() => undefined);
									}}
								>
									Copier
								</Button>
							</div>
							<Markdown source={mission.summary} />
						</div>
					) : null}

					{mission.plan ? (
						<div className="rounded-lg border border-accent/25 bg-accent/[0.06] p-2.5">
							<div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-accent-soft uppercase">
								Plan proposé
							</div>
							<p className="text-selectable text-[11px] leading-relaxed text-ink-muted">
								{mission.plan}
							</p>
						</div>
					) : null}

					{mission.tasks.length > 0 ? (
						<div className="flex flex-col gap-1">
							{mission.tasks.map((task) => (
								<TaskRow
									key={task.id}
									mission={mission}
									task={task}
									overrun={overruns.find(
										(entry) => entry.taskId === task.id,
									)}
									activity={
										activity.data?.tasks.find((entry) => entry.taskId === task.id)
											?.activity ?? null
									}
									// Une recette qui ne démarre pas doit dire qu'elle attend son
									// tour, sinon elle passe pour oubliée.
									held={verifying.has(task.role) && !implementationDone}
									onChange={onChange}
								/>
							))}
						</div>
					) : null}

					{adding ? (
						<TaskForm
							mission={mission}
							onDone={() => {
								setAdding(false);
								onChange();
							}}
						/>
					) : mission.state !== "done" && !prelude ? (
						<div className="flex justify-end">
							<Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
								Ajouter une tâche à la main
							</Button>
						</div>
					) : null}
					{/* Ce qui s'est réellement passé : la suite des agents qui ont
					    tourné, leurs reprises, leurs coûts, et pourquoi ceux qui sont
					    morts sont morts. Les états des tâches ci-dessus disent où l'on
					    en est ; eux seuls disent comment on y est arrivé. */}
					<MissionHistory missionId={mission.id} />
				</>
			) : null}
		</section>
	);
}

/**
 * Ce que cette mission a coûté, d'après les moteurs qui l'ont fait tourner.
 *
 * Chargé à part de la fiche : le relevé vit dans son propre carnet, et une
 * mission qui n'a rien fait tourner n'affiche rien plutôt qu'un zéro — qui se
 * lirait comme « gratuite » alors qu'il veut dire « on ne sait pas ».
 */
function MissionSpend({ missionId }: { missionId: string }) {
	const runs = useAsync(() => api.executions.forMission(missionId), [missionId], {
		pollMs: 60_000,
	});
	const spend = totalSpend(runs.data ?? []);
	if (!spend) return null;
	return (
		<span className="flex items-center gap-1" title={spend.title}>
			<Coins size={10} />
			{spend.label}
		</span>
	);
}

/**
 * La branche sur laquelle la pull request finale se greffera.
 *
 * Vide, la PR vise la branche par défaut du dépôt. Renseignée, elle s'empile
 * sur un travail encore en revue et ne montre alors que ce que la mission
 * ajoute — la forge affiche la dépendance entre les deux. Le choix se fait ici
 * plutôt qu'à l'ouverture : c'est souvent en cours de route qu'on s'aperçoit
 * qu'un ticket en prolonge un autre.
 */
function MissionBase({ mission, onChange }: { mission: Mission; onChange: () => void }) {
	const { notify } = useCockpit();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(mission.base);
	const branches = useAsync(() => api.git.branches(), [], { enabled: editing });
	// Les branches qui portent une pull request ouverte : ce sont les seules qui
	// produisent une pile. GitHub la construit tout seul dès que deux PR
	// ouvertes s'enchaînent par leur base — il n'y a rien de plus à demander,
	// mais empiler sur une branche sans PR ne donne qu'une base inhabituelle.
	const open = useAsync(() => api.git.pullRequests(), [], { enabled: editing });

	const save = async (value: string) => {
		try {
			await api.missions.setBase(mission.id, value.trim());
			setEditing(false);
			notify(
				value.trim()
					? `La PR se greffera sur ${value.trim()}.`
					: "La PR visera la branche par défaut.",
			);
			onChange();
		} catch (error) {
			notify(String(error));
		}
	};

	if (mission.state === "done") {
		return mission.base ? <span className="text-accent-soft">→ {mission.base}</span> : null;
	}

	if (!editing) {
		return (
			<button
				type="button"
				onClick={() => {
					setDraft(mission.base);
					setEditing(true);
				}}
				title="Branche sur laquelle la pull request se greffera"
				className={clsx(
					"focus-ring rounded px-1",
					mission.base ? "text-accent-soft" : "text-ink-faint hover:text-ink-muted",
				)}
			>
				{mission.base ? `→ ${mission.base}` : "→ branche par défaut"}
			</button>
		);
	}

	return (
		<span className="flex items-center gap-1">
			<select
				value={draft}
				autoFocus
				onChange={(event) => void save(event.target.value)}
				onBlur={() => setEditing(false)}
				className="focus-ring h-6 max-w-64 rounded border border-line-soft bg-raised px-1 font-mono text-[10px] text-ink"
			>
				<option value="">branche par défaut</option>
				{/* Celles qui empilent d'abord, et dites comme telles : le reste
				    des branches reste accessible, mais sans promettre une pile
				    qu'elles ne produiront pas. */}
				{(() => {
					const stacking = new Set(
						(open.data ?? []).map((pr) => pr.headRef).filter(Boolean),
					);
					const all = (branches.data?.branches ?? []).filter(
						(branch) => branch.name !== mission.branch,
					);
					const empilables = all.filter((branch) => stacking.has(branch.name));
					const autres = all.filter((branch) => !stacking.has(branch.name));
					return (
						<>
							{empilables.length > 0 ? (
								<optgroup label="PR ouvertes — la pile sera reconnue">
									{empilables.map((branch) => (
										<option key={branch.name} value={branch.name}>
											{branch.name}
										</option>
									))}
								</optgroup>
							) : null}
							<optgroup label="Autres branches">
								{autres.map((branch) => (
									<option key={branch.name} value={branch.name}>
										{branch.name}
									</option>
								))}
							</optgroup>
						</>
					);
				})()}
			</select>
			{branches.loading || open.loading ? <Spinner /> : null}
		</span>
	);
}

/**
 * Ce qu'un agent attend de nous, répondu sur place.
 *
 * Une mission qui bloque bloque sur une seule chose à la fois, et aller la
 * débloquer coûtait un détour par Workspaces puis la bonne conversation parmi
 * dix. Les exécutants tournent maintenant sans demander la permission de chaque
 * commande : ce qui remonte ici est donc rare, et mérite d'autant plus d'être
 * traitable sans quitter l'écran.
 */
function Pending({ sessionId }: { sessionId: string | null | undefined }) {
	const { pendingForSession } = useAgentGuard();
	const { decide, answer } = useAgentActions();
	const requests = pendingForSession(sessionId);
	if (requests.length === 0) return null;

	return (
		<div className="flex flex-col gap-1.5 rounded-lg border border-warning/25 bg-warning/[0.08] p-2">
			{requests.map((request) =>
				isQuestion(request) ? (
					<QuestionForm
						key={request.id}
						questions={readQuestions(request.input)}
						onAnswer={(answers) => answer(request.id, answers)}
						onSkip={() =>
							decide(
								request.id,
								false,
								"L'utilisateur a passé la question : avance avec ce que tu sais, " +
									"ou demande-lui dans ta réponse.",
							)
						}
					/>
				) : (
					<div key={request.id} className="flex items-center gap-2">
						<ShieldQuestion size={12} className="shrink-0 text-warning" />
						<div className="min-w-0 flex-1">
							<p className="text-[11px] text-ink">
								Demande à utiliser{" "}
								<span className="font-mono font-medium">{request.tool}</span>
							</p>
							<p className="truncate font-mono text-[10px] text-ink-faint">
								{JSON.stringify(request.input).slice(0, 120)}
							</p>
						</div>
						<Button size="sm" onClick={() => decide(request.id, false)}>
							Refuser
						</Button>
						<Button size="sm" variant="solid" onClick={() => decide(request.id, true)}>
							Autoriser
						</Button>
					</div>
				),
			)}
		</div>
	);
}

/**
 * Ce qu'un agent est en train de faire.
 *
 * « Actif » ne veut rien dire : on veut savoir s'il réfléchit, s'il attend une
 * autorisation, ou s'il s'est arrêté — et pouvoir ouvrir sa conversation d'un
 * clic quand la réponse ne suffit pas.
 */
function AgentLine({
	title,
	activity,
	onOpen,
}: {
	title: string;
	activity: AgentActivity;
	onOpen: () => void;
}) {
	const state = activity.waiting
		? { label: `${activity.waiting} autorisation(s) à donner`, tone: "text-critical" }
		: activity.working
			? { label: "travaille…", tone: "text-accent-soft" }
			: activity.running
				? { label: "en attente", tone: "text-ink-faint" }
				: { label: "arrêté", tone: "text-ink-faint" };

	return (
		<div className="flex items-start gap-2 rounded-lg bg-base/60 px-2.5 py-2">
			<Bot size={12} className="mt-0.5 shrink-0 text-ink-faint" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-[11px] font-medium text-ink">{title}</span>
					<span className={clsx("text-[10px]", state.tone)}>{state.label}</span>
				</div>
				{activity.last ? (
					<p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-faint">
						{activity.last}
					</p>
				) : null}
			</div>
			<Button
				size="sm"
				icon={MessageSquare}
				onClick={onOpen}
				title="Ouvrir la conversation"
			>
				Suivre
			</Button>
		</div>
	);
}

function TaskRow({
	mission,
	task,
	activity,
	overrun,
	held,
	onChange,
}: {
	mission: Mission;
	task: MissionTask;
	activity: AgentActivity | null;
	/** Renseigné quand cette tâche déborde nettement du temps ordinaire. */
	overrun?: MissionOverrun;
	/** Retenue tant que l'implémentation n'a pas livré. */
	held?: boolean;
	onChange: () => void;
}) {
	const { notify, go } = useCockpit();
	const { show } = useWorkspace();
	const state = TASK_LABELS[task.state] ?? TASK_LABELS.planned;
	const [busy, setBusy] = useState(false);

	// Le passage en cours s'ajoute au cumul des précédents : sans lui, une tâche
	// qui travaille depuis une heure afficherait le temps de sa reprise passée.
	const worked =
		task.workedSeconds +
		(task.state === "running" ? elapsedSeconds(task.startedAt) : 0);

	const act = async (action: () => Promise<unknown>, done: string) => {
		setBusy(true);
		try {
			await action();
			notify(done);
			onChange();
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-1 rounded-lg px-1.5 py-1 hover:bg-surface">
			<div className="flex items-center gap-2">
				<Ticket size={11} className="shrink-0 text-ink-faint" />
				<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
					<span className="font-mono text-[10px] text-accent-soft">{task.role}</span>{" "}
					{task.title}
				</span>
				{task.scope.length === 0 ? (
					<span
						className="shrink-0 text-[10px] text-warning"
						title="Aucun périmètre : cette tâche peut écrire partout"
					>
						sans périmètre
					</span>
				) : null}
				{/* L'exécutant s'est créé sa propre branche. Son travail existe, mais
				    pas là où on l'attendait : le dire ici évite de découvrir en
				    ouvrant la pull request qu'elle ne porte rien. */}
				{task.actualBranch ? (
					<span
						className="shrink-0 truncate font-mono text-[10px] text-warning"
						title={`L'exécutant a travaillé sur « ${task.actualBranch} » au lieu de « ${task.branch} ». C'est cette branche que l'intégration fusionnera.`}
					>
						↳ {task.actualBranch}
					</span>
				) : null}
				{/* Le temps de travail cumulé, reprises comprises : c'est lui qui dit
				    ce qu'une tâche a réellement coûté, là où l'écart entre son premier
				    départ et sa dernière livraison compte surtout de l'attente. */}
				{worked > 0 ? (
					<span
						className={clsx(
							"shrink-0 font-mono text-[10px]",
							// Une tâche qui déborde le dit là où son temps s'affiche déjà :
							// c'est le chiffre qu'on regarde pour s'en douter, et il ne
							// disait rien de ce qui est ordinaire.
							overrun ? "text-warning" : "text-ink-faint",
						)}
						title={
							overrun
								? `Cette tâche tourne depuis ${duration(overrun.seconds)}, là où une tâche en coûte ${duration(overrun.expected)} d'ordinaire. Rien n'est coupé : à toi de juger s'il faut la reprendre, la redécouper, ou l'arrêter.`
								: task.attempts > 0
									? `Temps de travail cumulé sur ${task.attempts + 1} passages`
									: "Temps de travail"
						}
					>
						{duration(worked)}
						{task.state === "running" ? "…" : ""}
					</span>
				) : null}
				{/* Une reprise en cours alerte — le cycle peut ne pas converger. Une
				    fois la copie rendue, elle n'est plus qu'un antécédent : la dire
				    sur le même ton laissait croire que la tâche patinait encore. */}
				{task.attempts > 0 ? (
					<span
						className={clsx(
							"shrink-0 text-[10px]",
							task.state === "delivered" || task.state === "integrated"
								? "text-ink-faint"
								: "text-warning",
						)}
						// La série des motifs, et pas seulement leur nombre : deux
						// reprises qui reprochent la même chose ne se voient qu'en
						// les lisant l'une sous l'autre.
						title={[
							`Renvoyée en correction ${task.attempts} fois sur 3 au maximum`,
							...(task.reproaches ?? []).map(
								(motif, rang) => `${rang + 1}. ${motif}`,
							),
						].join("\n")}
					>
						{task.state === "delivered" || task.state === "integrated"
							? `${task.attempts} reprise${task.attempts > 1 ? "s" : ""}`
							: `reprise ${task.attempts}/3`}
					</span>
				) : null}
				{/* Le verdict d'une vérification, lu par le cockpit dans son propre
				    rapport. Il ne s'adressait qu'au maître : ni toi ni la mission ne
				    saviez qu'une recette avait refusé, et la pull request s'ouvrait
				    dessus. Un refus se lève en corrigeant, puis en la relançant. */}
				{VERDICTS[task.verdict] ? (
					<Badge tone={VERDICTS[task.verdict].tone}>
						{VERDICTS[task.verdict].label}
					</Badge>
				) : null}
				<Badge tone={state.tone as "neutral"}>
					{held && task.state === "planned" ? "attend son tour" : state.label}
				</Badge>
				{/* Une tâche planifiée part d'elle-même dès que sa base existe. Le
				    bouton ne sert plus qu'à forcer la main — quand une dépendance
				    tarde, ou après un échec qu'on vient de corriger. */}
				{task.state === "planned" && mission.state === "running" ? (
					<Button
						size="sm"
						icon={Play}
						loading={busy}
						title="Forcer le lancement sans attendre sa base"
						onClick={() =>
							void act(
								() => api.missions.launch(mission.id, task.id),
								`${task.title} — exécutant lancé.`,
							)
						}
					>
						Forcer
					</Button>
				) : null}
				{/* Une vérification ne rejuge que ce qui a changé depuis son dernier
				    verdict — c'est ce qui rend les reprises rapides. Après un
				    correctif qui touche à l'architecture, ce verdict partiel ne vaut
				    plus : ce bouton lui fait tout reprendre. */}
				{task.checkpoint && task.state !== "running" ? (
					<Button
						size="sm"
						icon={RotateCcw}
						loading={busy}
						title="Oublier ce qu'elle a déjà validé et tout relire"
						onClick={() =>
							void act(
								() => api.missions.rerun(mission.id, task.id),
								`${task.title} — relecture complète lancée.`,
							)
						}
					>
						Tout relire
					</Button>
				) : null}
				{task.sessionId ? (
					<Button
						size="sm"
						icon={MessageSquare}
						onClick={() => {
							show(task.worktree || mission.cwd, {
								kind: "agent",
								id: task.sessionId as string,
							});
							go("workspace");
						}}
					>
						Suivre
					</Button>
				) : null}
				{/* Une tâche « en cours » sans conversation rattachée n'a rien à
				    suivre : son exécutant n'a jamais démarré. On le dit, et on donne
				    le geste qui la débloque — sinon l'écran affiche une tâche
				    éternellement en cours sans le moindre recours. */}
				{task.state === "running" && !task.sessionId ? (
					<Button
						size="sm"
						icon={RotateCcw}
						loading={busy}
						title="Aucun exécutant ne s'est rattaché à cette tâche : la relancer depuis le début"
						onClick={() =>
							void act(
								() => api.missions.rerun(mission.id, task.id),
								`${task.title} — exécutant relancé.`,
							)
						}
					>
						Relancer
					</Button>
				) : null}
			</div>
			{activity && (activity.working || activity.waiting > 0 || activity.last) ? (
				<p className="line-clamp-1 pl-5 text-[10px] text-ink-faint">
					{activity.waiting > 0 ? (
						<span className="text-critical">
							{activity.waiting} autorisation(s) à donner ·{" "}
						</span>
					) : null}
					{activity.last}
				</p>
			) : null}
			{/* On répond ici même : c'est cette tâche-là qui bloque, la chercher
			    dans Workspaces ne dit rien de plus. */}
			<div className="pl-5">
				<Pending sessionId={task.sessionId} />
			</div>
		</div>
	);
}

/** Ajout manuel : utile pour compléter un plan, jamais le point d'entrée. */
function TaskForm({ mission, onDone }: { mission: Mission; onDone: () => void }) {
	const { notify } = useCockpit();
	const roles = useAsync(() => api.missions.roles(), []);
	const [form, setForm] = useState({ role: "backend", title: "", scope: "" });

	const submit = async () => {
		try {
			await api.missions.addTask(mission.id, {
				id: "",
				engineSession: "",
				actualBranch: "",
				verdict: "",
				role: form.role,
				title: form.title.trim(),
				brief: "",
				scope: form.scope
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean),
				base: mission.branch,
				branch: "",
				worktree: "",
				sessionId: null,
				state: "planned",
				note: "",
				attempts: 0,
				reproaches: [],
				startedAt: null,
				finishedAt: null,
				workedSeconds: 0,
				checkpoint: "",
			});
			onDone();
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-line-soft bg-base/60 p-3.5">
			<div className="grid grid-cols-3 gap-3">
				<Field label="Rôle">
					<select
						value={form.role}
						onChange={(event) => setForm({ ...form, role: event.target.value })}
						className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2 text-xs text-ink"
					>
						{/* Le maître pilote la mission, il n'en exécute pas les tâches :
						    sa clé n'a rien à faire dans ce choix. */}
						{(roles.data ?? [])
							.filter((role) => role.id !== "master")
							.map((role) => (
								<option key={role.id} value={role.id}>
									{role.label}
								</option>
							))}
					</select>
				</Field>
				<Field label="Intitulé">
					<TextInput
						value={form.title}
						onChange={(title) => setForm({ ...form, title })}
						placeholder="Points d'entrée de facturation"
					/>
				</Field>
				<Field label="Périmètre" hint="chemins séparés par des virgules">
					<TextInput
						value={form.scope}
						onChange={(scope) => setForm({ ...form, scope })}
						placeholder="apps/api/**"
						mono
					/>
				</Field>
			</div>
			<div className="flex justify-end gap-2">
				<Button size="sm" onClick={onDone}>
					Annuler
				</Button>
				<Button
					size="sm"
					variant="solid"
					disabled={!form.title.trim()}
					onClick={() => void submit()}
				>
					Ajouter la tâche
				</Button>
			</div>
		</div>
	);
}

/**
 * Choisir le ticket sur lequel ouvrir une mission.
 *
 * Coller une adresse supposait d'aller la chercher ailleurs : ouvrir le suivi
 * dans un navigateur, trouver le ticket, copier l'URL, revenir. Quatre gestes
 * pour désigner quelque chose que le cockpit sait déjà lister.
 *
 * La liste vient du suivi configuré, quel qu'il soit — Linear, GitLab, les issues
 * du dépôt : c'est le même fournisseur qui sert les autres écrans, et rien n'est
 * à déclarer de plus ici. Elle ne se charge qu'à l'ouverture du menu, un appel
 * réseau n'ayant pas à partir tant qu'on n'a rien demandé.
 */
function TicketPicker({ onPick }: { onPick: (identifier: string) => void }) {
	const [opened, setOpened] = useState(false);
	const provider = useAsync(() => api.feeds.ticketProvider().catch(() => null), []);
	const tickets = useAsync(() => api.feeds.linear(false).catch(() => []), [], {
		enabled: opened,
	});

	const actions = (tickets.data ?? []).map((ticket) => ({
		id: ticket.id,
		// Les siens d'abord : c'est sur son propre travail qu'on ouvre une mission
		// neuf fois sur dix, et un groupe suffit à les faire remonter.
		group: ticket.meta.find((field) => field.label === "assigné")?.value
			? "Assignés"
			: "Autres",
		label: `${ticket.id} ${ticket.title}`,
		hint: ticket.status,
		note: ticket.tags?.[0]?.label,
		run: () => onPick(ticket.id),
	}));

	// Sans suivi de tâches, rien à proposer : le champ de saisie reste, lui, et
	// suffit à ouvrir une mission sur un ticket qu'on nomme.
	if (provider.data === null && !provider.loading) return null;

	return (
		<QuickMenu
			label={provider.data?.label ?? "Tickets"}
			icon={Ticket}
			title="Choisir un ticket du suivi"
			actions={actions}
			loading={tickets.loading}
			emptyMessage="Aucun ticket ouvert à proposer."
			onOpen={() => setOpened(true)}
			width={460}
		/>
	);
}
