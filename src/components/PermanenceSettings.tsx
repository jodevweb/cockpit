import clsx from "clsx";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Field, KeyHint, Spinner, TextInput } from "@/components/ui";
import { api } from "@/lib/ipc";
import {
	COMMENT_SCOPES,
	COMMENT_SIGNATURE,
	NEVER,
	IMPLEMENTED_POWERS,
	POWERS,
	TRIGGERS,
	type PermanenceConfig,
	type PermanenceRule,
} from "@/lib/types";
import { useCockpit } from "@/app/store";

/** Recopié de `config::PROTECTED_BRANCHES` — le plancher, pas la liste complète. */
const PROTECTED_HINT = "main, master, dev, develop, staging, prod";

/**
 * Ce que la Permanence surveille, et ce qu'elle s'autorise.
 *
 * Deux portées, dites plutôt que devinées : le **service** décrit le poste — les
 * heures, la cadence, les plafonds, les modèles ne changent pas quand on bascule
 * de projet ; les **règles et les pouvoirs** décrivent un dépôt, et hérités ils
 * feraient agir la Permanence sur un projet avec les autorisations d'un autre.
 *
 * Tout part éteint. Une installation neuve ne fait rien tant que personne ne l'a
 * demandé, la liste blanche est vide, et les règles sont livrées désactivées :
 * une règle absente ne déclenche rien, et ce n'est pas une erreur.
 */
export function PermanenceSettings() {
	const { config, reloadConfig, notify } = useCockpit();
	const [draft, setDraft] = useState<PermanenceConfig | null>(null);
	// Sert l'indicateur discret de l'en-tête : sans bouton d'enregistrement, il
	// faut bien que quelque chose dise que c'est pris.
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (config?.permanence) setDraft(config.permanence);
	}, [config?.permanence]);

	if (!draft) return null;

	/**
	 * Enregistre en quittant le champ.
	 *
	 * Le mélange précédent — cases qui partent au clic, champs qui attendent un
	 * bouton — donnait un écran où l'on ne savait jamais ce qui était déjà pris.
	 * Ici tout suit la même règle : on quitte le champ, c'est enregistré.
	 */
	const commitService = () =>
		void saveService({
			hours: draft.hours,
			cadenceMinutes: draft.cadenceMinutes,
			dailyTokens: draft.dailyTokens,
			dailyEngagements: draft.dailyEngagements,
			quotaFloorPercent: draft.quotaFloorPercent,
			retentionDays: draft.retentionDays,
			maxRunning: draft.maxRunning,
			rehearsal: draft.rehearsal,
			graceHours: draft.graceHours,
			breaker: draft.breaker,
			catchUp: draft.catchUp,
			notifyFailures: draft.notifyFailures,
			notifyAll: draft.notifyAll,
			engine: draft.engine,
			triage: draft.triage,
			work: draft.work,
			prompt: draft.prompt,
		});

	/** Le service et les rôles : réglages du poste. */
	const saveService = async (patch: Partial<PermanenceConfig>) => {
		const next = { ...draft, ...patch };
		setDraft(next);
		setSaving(true);
		try {
			await api.config.update({ permanence: patch });
			reloadConfig();
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	/** Les règles et les pouvoirs : réglages du projet actif. */
	const saveProject = async (patch: Partial<PermanenceConfig>) => {
		const next = { ...draft, ...patch };
		setDraft(next);
		setSaving(true);
		try {
			await api.config.updateProject({ permanence: patch });
			reloadConfig();
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	const rules = draft.rules ?? [];
	const powers = draft.powers ?? [];
	const oracleSources = [
		...(config?.commands ?? []).map((command) => ({
			kind: "command" as const,
			key: command.id,
			label: command.label || command.id,
			group: "Commande du dépôt",
		})),
		...(config?.properties ?? []).map((property) => ({
			kind: "property" as const,
			key: property.id,
			label: property.text || property.id,
			group: "Propriété du projet",
		})),
		{ kind: "ci" as const, key: "success", label: "la CI passe au vert", group: "État de CI" },
		{
			kind: "comment" as const,
			key: "posted",
			label: "elle a posté un commentaire",
			group: "GitHub",
		},
	];

	return (
		<div className="flex flex-col gap-5">
			<p className="flex items-start gap-2 text-[11px] leading-relaxed text-ink-faint">
				<span className="min-w-0 flex-1">
				Un opérateur qui tient l'écosystème pendant que tu fais autre chose. Il ne décide
				pas quoi construire : il répare, relance, met à jour — et il peut prouver qu'il a
				réussi, parce que l'opération a des oracles que le produit n'a pas. Il ne tourne
				que quand le cockpit est ouvert. <strong className="text-ink-muted">Tout se règle
				sans bouton</strong> : ce que tu changes est pris en quittant le champ.
				</span>
				{saving ? <Spinner /> : null}
			</p>

			{/* ── Service ────────────────────────────────────────────────────── */}
			<Block
				title="Service"
				scope="ce poste"
				aside={
					<label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
						{draft.enabled ? "Activée" : "Désactivée"}
						<input
							type="checkbox"
							className="accent-accent"
							checked={draft.enabled}
							onChange={(event) => void saveService({ enabled: event.target.checked })}
						/>
					</label>
				}
			>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					Désactivée, l'entrée quitte le rail : un écran qui ne peut rien faire ne reste
					pas au menu. On la rallume ici. Suspendre, en revanche, est un geste — il se
					fait depuis l'écran, ou avec <KeyHint>⇧P</KeyHint>.
				</p>

				<div className="grid grid-cols-2 gap-3">
					<Field
						label="Heures de service"
						hint="Vide = toujours. Une plage qui passe minuit se lit telle quelle."
					>
						<TextInput
							value={draft.hours}
							mono
							placeholder="08:00-19:00"
							onChange={(hours) => setDraft({ ...draft, hours })}
							onBlur={commitService}
						/>
					</Field>
					<Field label="Cadence" hint="Entre deux regards. Vide = 2 minutes.">
						<Number
							value={draft.cadenceMinutes}
							suffix="min"
							onChange={(cadenceMinutes) => setDraft({ ...draft, cadenceMinutes })}
							onCommit={commitService}
						/>
					</Field>
					<Field
						label="Plafond de jetons par jour"
						hint="Celui qu'elle s'impose. Vide = 200 000."
					>
						<Number
							value={draft.dailyTokens}
							onChange={(dailyTokens) => setDraft({ ...draft, dailyTokens })}
							onCommit={commitService}
						/>
					</Field>
					<Field label="Plafond d'engagements par jour" hint="Vide = 20.">
						<Number
							value={draft.dailyEngagements}
							onChange={(dailyEngagements) => setDraft({ ...draft, dailyEngagements })}
							onCommit={commitService}
						/>
					</Field>
					{/* Le plafond qui compte vraiment : il porte sur ce que tu partages
					    avec elle, pas sur ce qu'elle s'accorde à elle-même. */}
					<Field
						label="Elle te laisse la place sous"
						hint="Pourcentage de quota d'abonnement restant. Vide = 15 %. Elle travaille en fond, toi au premier plan."
					>
						<Number
							value={draft.quotaFloorPercent}
							suffix="% restants"
							onChange={(quotaFloorPercent) => setDraft({ ...draft, quotaFloorPercent })}
							onCommit={commitService}
						/>
					</Field>
					<Field label="Garder l'historique" hint="Engagements terminés. Vide = 14 jours.">
						<Number
							value={draft.retentionDays}
							suffix="jours"
							onChange={(retentionDays) => setDraft({ ...draft, retentionDays })}
							onCommit={commitService}
						/>
					</Field>
				</div>

				<Check
					checked={draft.catchUp}
					label="Au réveil, rattraper ce qui s'est accumulé"
					hint="Décoché, elle repart à zéro en disant ce qu'elle a sauté. Rattraper une nuit de signaux d'un coup est le plus sûr moyen de brûler un plafond."
					onChange={(catchUp) => void saveService({ catchUp })}
				/>
				<Check
					checked={draft.notifyFailures}
					label="Me notifier en cas d'échec"
					onChange={(notifyFailures) => void saveService({ notifyFailures })}
				/>
				<Check
					checked={draft.notifyAll}
					label="Me notifier à chaque engagement"
					hint="Le succès est silencieux, l'échec parle : notifier chaque engagement rouvre une boîte de réception, et lire douze rapports ne vaut pas mieux que faire le travail."
					onChange={(notifyAll) => void saveService({ notifyAll })}
				/>

			</Block>

			{/* ── Garde-fous ─────────────────────────────────────────────────── */}
			<Block title="Garde-fous" scope="ce poste">
				<p className="text-[11px] leading-relaxed text-ink-faint">
					Chacun répond à une façon précise dont ça part en vrille, et aucun ne
					remplace les autres. Ce sont eux qui rendent l'activation supportable.
				</p>
				<div className="grid grid-cols-2 gap-3">
					<Field
						label="Engagements en même temps"
						hint="Un seul par défaut. Un opérateur de permanence ne traite pas huit incidents en parallèle — et le plafond du jour ne protège pas d'une rafale."
					>
						<Number
							value={draft.maxRunning}
							onChange={(maxRunning) => setDraft({ ...draft, maxRunning })}
							onCommit={commitService}
						/>
					</Field>
					<Field
						label="Rodage à blanc"
						hint="Elle décide, écrit ce qu'elle aurait fait, et n'agit pas. Le compteur repart dès que tu changes ses pouvoirs. Vide = 10."
					>
						<Number
							value={draft.rehearsal}
							suffix="engagements"
							onChange={(rehearsal) => setDraft({ ...draft, rehearsal })}
							onCommit={commitService}
						/>
					</Field>
					<Field
						label="Quarantaine par objet"
						hint="Après un engagement, la même PR est laissée tranquille. C'est ce qui l'empêche de se réveiller sur son propre commit, et de s'acharner. Vide = 6 h."
					>
						<Number
							value={draft.graceHours}
							suffix="heures"
							onChange={(graceHours) => setDraft({ ...draft, graceHours })}
							onCommit={commitService}
						/>
					</Field>
					<Field
						label="Coupe-circuit"
						hint="Échecs d'affilée après lesquels elle se suspend. Le réarmement est un geste : une reprise automatique referait ce qu'il sert à empêcher. Vide = 3."
					>
						<Number
							value={draft.breaker}
							suffix="échecs"
							onChange={(breaker) => setDraft({ ...draft, breaker })}
							onCommit={commitService}
						/>
					</Field>
				</div>
			</Block>

			{/* ── Rôle ───────────────────────────────────────────────────────── */}
			<Block title="Rôle" scope="ce poste">
				<p className="text-[11px] leading-relaxed text-ink-faint">
					Deux modèles, pas un. Le tri regarde chaque delta — c'est 95 % des appels, sur
					des entrées minuscules ; le travail ne démarre que lorsqu'un engagement part.
				</p>
				<div className="grid grid-cols-2 gap-3">
					<Field label="Moteur" hint="Vide = le premier déclaré.">
						<Select
							value={draft.engine}
							onChange={(engine) => setDraft({ ...draft, engine })}
						>
							<option value="">Le premier déclaré</option>
							{(config?.engines ?? []).map((engine) => (
								<option key={engine.id} value={engine.id}>
									{engine.label || engine.id}
								</option>
							))}
						</Select>
					</Field>
					<div />
					<Field label="Tri — modèle" hint="Le plus petit qui sache dire « rien ».">
						<TextInput
							value={draft.triage?.model ?? ""}
							mono
							placeholder="haiku"
							onChange={(model) =>
								setDraft({ ...draft, triage: { ...draft.triage, model } })
							}
						/>
					</Field>
					<Field label="Tri — profondeur">
						<Depth
							value={draft.triage?.depth ?? ""}
							onChange={(depth) => setDraft({ ...draft, triage: { ...draft.triage, depth } })}
						/>
					</Field>
					<Field label="Travail — modèle">
						<TextInput
							value={draft.work?.model ?? ""}
							mono
							placeholder="sonnet"
							onChange={(model) => setDraft({ ...draft, work: { ...draft.work, model } })}
						/>
					</Field>
					<Field label="Travail — profondeur">
						<Depth
							value={draft.work?.depth ?? ""}
							onChange={(depth) => setDraft({ ...draft, work: { ...draft.work, depth } })}
						/>
					</Field>
				</div>
				<Field
					label="Consigne permanente"
					hint="Jointe au contexte de chaque engagement, en plus du dossier du dépôt."
				>
					<textarea
						rows={3}
						spellCheck={false}
						value={draft.prompt}
						onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
						className="focus-ring w-full resize-y rounded-lg border border-line-soft bg-raised px-2.5 py-1.5 text-xs leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/40"
						placeholder="Ce qu'elle doit savoir avant d'agir, quel que soit l'engagement."
					/>
				</Field>
			</Block>

			{/* ── Règles ─────────────────────────────────────────────────────── */}
			<Block
				title="Règles"
				scope="ce projet"
				aside={
					<Button
						icon={Plus}
						size="sm"
						onClick={() =>
							void saveProject({
								rules: [
									...rules,
									{
										id: `rule-${Date.now()}`,
										label: "",
										enabled: false,
										trigger: "",
										condition: "",
										reaction: "",
										oracle: { kind: "", key: "" },
										needsApproval: false,
										everyHours: 0,
										tokenBudget: 0,
										perHour: 0,
									},
								],
							})
						}
					>
						Ajouter
					</Button>
				}
			>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					Livrées éteintes. Une règle sans oracle énonçable ne démarre pas, même
					allumée : c'est la seule condition d'arrêt d'un agent qui n'en a aucune.
				</p>
				{rules.length === 0 ? (
					<p className="rounded-lg border border-dashed border-line-soft px-3 py-4 text-center text-[11px] text-ink-faint">
						Aucune règle. La Permanence ne fera rien tant que tu ne lui auras pas dit quoi
						surveiller.
					</p>
				) : (
					rules.map((rule, index) => (
						<Rule
							key={rule.id}
							rule={rule}
							sources={oracleSources}
							onChange={(next) =>
								void saveProject({
									rules: rules.map((entry, position) =>
										position === index ? next : entry,
									),
								})
							}
							onRemove={() =>
								void saveProject({
									rules: rules.filter((_, position) => position !== index),
								})
							}
						/>
					))
				)}
			</Block>

			{/* ── Pouvoirs ───────────────────────────────────────────────────── */}
			<Block
				title="Pouvoirs"
				scope="ce projet"
				aside={
					<span className="font-mono text-[10px] text-ink-faint">
						{powers.length + (draft.comment?.enabled ? 1 : 0)} / {POWERS.length + 1} activés
					</span>
				}
			>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					Liste blanche, vide au départ, cochée un par un. Le critère : quelqu'un d'autre
					que toi peut-il s'en apercevoir ?
				</p>
				<div className="grid grid-cols-2 gap-x-4">
					{POWERS.map((power) => (
						<Check
							key={power.id}
							checked={powers.includes(power.id)}
							label={power.label}
							/* Cocher un geste que le cockpit ne sait pas encore poser ne
							   sert à rien : le dire vaut mieux que de le laisser croire. */
							hint={
								IMPLEMENTED_POWERS.includes(power.id)
									? undefined
									: "pas encore implémenté — le geste sera refusé"
							}
							onChange={(on) =>
								void saveProject({
									powers: on
										? [...powers, power.id]
										: powers.filter((entry) => entry !== power.id),
								})
							}
						/>
					))}
				</div>

				<Comment
					value={draft.comment}
					onChange={(comment) => void saveProject({ comment })}
				/>

				{/* En dur, sans outil correspondant. Le critère n'est pas « ce qu'un
				    humain lit » — un commentaire aussi se lit — mais ce qui engage une
				    décision plutôt qu'un compte rendu. */}
				{/* Le garde-fou qui ne se coche pas, et qui prime sur tout ce qui
				    précède : aucun geste ne touche une branche partagée. */}
				<p className="border-t border-line-soft pt-3 text-[11px] leading-relaxed text-ink-faint">
					<span className="font-medium text-ink-muted">Jamais sur une branche partagée.</span>{" "}
					Quoi que tu coches, elle n'écrit ni sur {PROTECTED_HINT}, ni sur les branches de
					base déclarées dans ton workflow. Elle ne travaille que sur des branches à elle —
					toucher à une branche partagée n'est pas un geste d'opérateur, c'est un geste qui
					engage tout le monde.
				</p>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					<span className="font-medium text-ink-muted">Jamais :</span> {NEVER.join(", ")}.
					Ces gestes n'ont pas d'outil — ce sont ceux qui engagent une décision, pas un
					compte rendu.
				</p>
			</Block>
		</div>
	);
}

/* ── Le pouvoir qui se borne au lieu de s'activer ───────────────────────── */

/**
 * Commenter une pull request.
 *
 * Le consentement porte sur l'objet et non sur le pouvoir : on n'autorise pas
 * « commenter », on autorise « commenter là ». Et ce n'est jamais un objectif —
 * un commentaire n'a pas d'oracle, il est le compte rendu d'un engagement qui
 * a déjà le sien.
 */
function Comment({
	value,
	onChange,
}: {
	value: PermanenceConfig["comment"];
	onChange: (next: PermanenceConfig["comment"]) => void;
}) {
	const comment = value ?? { enabled: false, scopes: [], perDay: 0 };
	const scopes = comment.scopes ?? [];

	return (
		<div className="flex flex-col gap-2.5 rounded-xl border border-warning/25 p-3">
			<div className="flex items-center gap-2">
				<input
					type="checkbox"
					className="accent-accent"
					checked={comment.enabled}
					onChange={(event) => onChange({ ...comment, enabled: event.target.checked })}
				/>
				<span className="text-[12px] font-medium text-ink">Commenter une pull request</span>
				<Badge tone="warning">lu par un humain</Badge>
			</div>
			<p className="text-[11px] leading-relaxed text-ink-faint">
				Jamais un objectif : seulement le compte rendu d'un engagement qui a déjà son
				oracle. Elle dit ce qu'elle a fait sur la branche, elle n'ouvre pas de
				conversation.
			</p>

			<div className="flex flex-col gap-1 border-l-2 border-line-soft pl-2.5">
				<p className="text-[10px] tracking-[0.06em] text-ink-faint uppercase">
					Elle n'écrit que là où l'une de ces conditions est vraie
				</p>
				{COMMENT_SCOPES.map((scope) => (
					<Check
						key={scope.id}
						checked={scopes.includes(scope.id)}
						label={scope.label}
						onChange={(on) =>
							onChange({
								...comment,
								scopes: on
									? [...scopes, scope.id]
									: scopes.filter((entry) => entry !== scope.id),
							})
						}
					/>
				))}
				{/* Une liste vide n'est pas une erreur : c'est un pouvoir inerte, et il
				    vaut mieux le dire que le laisser croire actif. */}
				{comment.enabled && scopes.length === 0 ? (
					<p className="text-[11px] text-warning">
						Aucune condition cochée : elle ne commentera nulle part.
					</p>
				) : null}
			</div>

			<div className="flex flex-col gap-1 border-l-2 border-line-soft pl-2.5">
				<p className="text-[10px] tracking-[0.06em] text-ink-faint uppercase">
					Et dans tous les cas
				</p>
				<div className="flex items-center gap-2 text-[11.5px] text-ink-muted">
					Au plus
					<div className="w-16">
						<Number
							value={comment.perDay}
							onChange={(perDay) => onChange({ ...comment, perDay })}
						/>
					</div>
					commentaire(s) par PR et par jour.
				</div>
				<Fixed>
					Jamais deux d'affilée sans une réponse humaine entre les deux — sinon elle
					monologue.
				</Fixed>
				<Fixed>
					Signé <span className="font-mono">{COMMENT_SIGNATURE}</span> en fin de message.
					Non modifiable : sur une PR, c'est ton compte que tes collègues lisent.
				</Fixed>
				<Fixed>
					« Ne commente plus ici » retire une PR d'un geste, sans toucher au réglage.
				</Fixed>
			</div>
		</div>
	);
}

/* ── Une règle ──────────────────────────────────────────────────────────── */

interface OracleSource {
	kind: "command" | "property" | "ci" | "comment";
	key: string;
	label: string;
	group: string;
}

function Rule({
	rule,
	sources,
	onChange,
	onRemove,
}: {
	rule: PermanenceRule;
	sources: OracleSource[];
	onChange: (next: PermanenceRule) => void;
	onRemove: () => void;
}) {
	const [draft, setDraft] = useState(rule);
	useEffect(() => setDraft(rule), [rule]);

	const known = TRIGGERS.some((entry) => entry.id === draft.trigger);
	const stated = Boolean(draft.oracle?.kind && draft.oracle?.key);
	const commit = (next: PermanenceRule) => {
		setDraft(next);
		onChange(next);
	};

	return (
		<div
			className={clsx(
				"flex flex-col gap-2.5 rounded-xl border border-line-soft p-3",
				!draft.enabled && "opacity-70",
			)}
		>
			<div className="flex items-center gap-2">
				<input
					type="checkbox"
					className="accent-accent"
					checked={draft.enabled}
					onChange={(event) => commit({ ...draft, enabled: event.target.checked })}
				/>
				<div className="min-w-0 flex-1">
					<TextInput
						value={draft.label}
						placeholder="Ce qu'elle fera, en une ligne"
						onChange={(label) => setDraft({ ...draft, label })}
						onBlur={() => commit(draft)}
					/>
				</div>
				{/* Une règle inapplicable se dit inapplicable, elle ne disparaît pas :
				    sinon on la croit perdue. */}
				{draft.enabled && !stated ? <Badge tone="critical">sans oracle</Badge> : null}
				{draft.trigger && !known ? (
					<Badge tone="critical">déclencheur inconnu</Badge>
				) : null}
				<Button size="sm" icon={Trash2} onClick={onRemove} title="Retirer cette règle" />
			</div>

			<div className="grid grid-cols-2 gap-3">
				<Field label="Déclencheur">
					<Select
						value={draft.trigger}
						onChange={(trigger) => commit({ ...draft, trigger })}
					>
						<option value="">Choisir…</option>
						{TRIGGERS.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.label}
							</option>
						))}
					</Select>
				</Field>
				<Field label="Oracle" hint="La preuve visée, choisie parmi ce que ce dépôt déclare.">
					<Select
						value={draft.oracle?.kind ? `${draft.oracle.kind}:${draft.oracle.key}` : ""}
						onChange={(value) => {
							const [kind, ...rest] = value.split(":");
							commit({
								...draft,
								oracle: value
									? { kind: kind as OracleSource["kind"], key: rest.join(":") }
									: { kind: "", key: "" },
							});
						}}
					>
						<option value="">Aucun — la règle ne partira pas</option>
						{sources.map((source) => (
							<option key={`${source.kind}:${source.key}`} value={`${source.kind}:${source.key}`}>
								{source.group} · {source.label}
							</option>
						))}
					</Select>
				</Field>
				<Field label="Condition" hint="En français. Jugée au tri, avant tout engagement.">
					<TextInput
						value={draft.condition}
						placeholder="l'auteur du dernier commit, c'est moi"
						onChange={(condition) => setDraft({ ...draft, condition })}
						onBlur={() => commit(draft)}
					/>
				</Field>
				<Field label="Réaction" hint="Ce qu'elle tente. L'objectif, lui, est écrit par elle.">
					<TextInput
						value={draft.reaction}
						placeholder="répare, ouvre une PR en brouillon"
						onChange={(reaction) => setDraft({ ...draft, reaction })}
						onBlur={() => commit(draft)}
					/>
				</Field>
				{/* Le délai n'a de sens que pour les deux déclencheurs d'horloge :
				    l'afficher ailleurs poserait une question sans réponse. */}
				{draft.trigger === "schedule" || draft.trigger === "pr_stale" ? (
					<Field
						label="Délai"
						hint={
							draft.trigger === "schedule"
								? "Entre deux départs de cette règle. Vide = 24 h."
								: "Au-delà, un changement est considéré endormi. Vide = 72 h."
						}
					>
						<Number
							value={draft.everyHours}
							suffix="heures"
							onChange={(everyHours) => setDraft({ ...draft, everyHours })}
							onCommit={() => commit(draft)}
						/>
					</Field>
				) : null}
				<Field label="Budget de jetons" hint="Par engagement de cette règle. Vide = le plafond du jour.">
					<Number
						value={draft.tokenBudget}
						onChange={(tokenBudget) => setDraft({ ...draft, tokenBudget })}
						onCommit={() => commit(draft)}
					/>
				</Field>
				<Field label="Au plus par heure" hint="Vide = seul le plafond journalier s'applique.">
					<Number value={draft.perHour} onChange={(perHour) => setDraft({ ...draft, perHour })} />
				</Field>
			</div>

			{/* La porte humaine, rendue règle par règle. Par défaut la Permanence
			    approuve elle-même le plan des missions qu'elle ouvre : l'accord a
			    été donné une fois, ici, en cochant cette règle. */}
			<Check
				checked={draft.needsApproval}
				label="Me demander mon accord avant que le travail ne parte"
				hint="Sans ça, elle approuve elle-même le plan de la mission — l'accord, c'est cette règle. Coche pour une règle à enjeu."
				onChange={(needsApproval) => commit({ ...draft, needsApproval })}
			/>

			<div className="flex justify-end">
				<Button size="sm" variant="outline" onClick={() => commit(draft)}>
					Enregistrer cette règle
				</Button>
			</div>
		</div>
	);
}

/* ── Petites briques ────────────────────────────────────────────────────── */

/**
 * Un bloc de réglages, avec sa portée écrite dans l'en-tête.
 *
 * La portée n'est pas un détail : c'est elle qui dit si le champ suivra le
 * poste ou le dépôt. La deviner, c'est régler le mauvais.
 */
function Block({
	title,
	scope,
	aside,
	children,
}: {
	title: string;
	scope: string;
	aside?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="panel flex flex-col gap-3 p-3.5">
			<header className="flex items-center gap-2">
				<h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
					{title}
				</h3>
				<Badge>{scope}</Badge>
				<div className="ml-auto flex items-center gap-2">{aside}</div>
			</header>
			{children}
		</section>
	);
}

/** Un entier, où le vide vaut « la valeur par défaut » et jamais « zéro ». */
function Number({
	value,
	suffix,
	onChange,
	onCommit,
}: {
	value: number;
	suffix?: string;
	onChange: (value: number) => void;
	/** Appelé en quittant le champ — l'écran n'a pas de bouton d'enregistrement. */
	onCommit?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<input
				type="text"
				inputMode="numeric"
				spellCheck={false}
				value={value === 0 ? "" : String(value)}
				placeholder="défaut"
				onChange={(event) => {
					const digits = event.target.value.replace(/\D/g, "");
					onChange(digits === "" ? 0 : globalThis.Number(digits));
				}}
				onBlur={onCommit}
				className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent/40"
			/>
			{suffix ? <span className="shrink-0 text-[10px] text-ink-faint">{suffix}</span> : null}
		</div>
	);
}

/** Une liste déroulante, avec le même habillage que partout ailleurs. */
function Select({
	value,
	onChange,
	children,
}: {
	value: string;
	onChange: (value: string) => void;
	children: React.ReactNode;
}) {
	return (
		<select
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className="focus-ring w-full rounded-lg border border-line-soft bg-raised px-2 py-1.5 text-[11px] text-ink"
		>
			{children}
		</select>
	);
}

function Depth({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	return (
		<Select value={value} onChange={onChange}>
			<option value="">Celle du moteur</option>
			<option value="fast">Rapide</option>
			<option value="normal">Normale</option>
			<option value="deep">Profonde</option>
		</Select>
	);
}

function Check({
	checked,
	label,
	hint,
	onChange,
}: {
	checked: boolean;
	label: string;
	hint?: string;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="flex cursor-pointer items-start gap-2 py-0.5">
			<input
				type="checkbox"
				className="mt-0.5 accent-accent"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span className="min-w-0">
				<span className="text-[11.5px] text-ink-muted">{label}</span>
				{hint ? (
					<span className="block text-[10px] leading-snug text-ink-faint">{hint}</span>
				) : null}
			</span>
		</label>
	);
}

/** Une règle du dispositif, ni cochable ni négociable. */
function Fixed({ children }: { children: React.ReactNode }) {
	return (
		<p className="text-[11px] leading-relaxed text-ink-faint">
			<span className="text-ink-faint">· </span>
			{children}
		</p>
	);
}
