import clsx from "clsx";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
	const { t } = useTranslation("components3");
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
			group: t("permanenceSettings.oracle.groupCommand"),
		})),
		...(config?.properties ?? []).map((property) => ({
			kind: "property" as const,
			key: property.id,
			label: property.text || property.id,
			group: t("permanenceSettings.oracle.groupProperty"),
		})),
		{
			kind: "ci" as const,
			key: "success",
			label: t("permanenceSettings.oracle.ciGreen"),
			group: t("permanenceSettings.oracle.groupCi"),
		},
		{
			kind: "comment" as const,
			key: "posted",
			label: t("permanenceSettings.oracle.commentPosted"),
			group: t("permanenceSettings.oracle.groupGithub"),
		},
	];

	return (
		<div className="flex flex-col gap-5">
			<p className="flex items-start gap-2 text-[11px] leading-relaxed text-ink-faint">
				<span className="min-w-0 flex-1">
				<Trans
						t={t}
						i18nKey="permanenceSettings.intro"
						components={{ strong: <strong className="text-ink-muted" /> }}
					/>
				</span>
				{saving ? <Spinner /> : null}
			</p>

			{/* ── Service ────────────────────────────────────────────────────── */}
			<Block
				title={t("permanenceSettings.service.title")}
				scope={t("permanenceSettings.scope.station")}
				aside={
					<label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
						{draft.enabled ? t("permanenceSettings.service.enabled") : t("permanenceSettings.service.disabled")}
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
					<Trans
						t={t}
						i18nKey="permanenceSettings.service.disabledHint"
						components={{ kbd: <KeyHint>{""}</KeyHint> }}
					/>
				</p>

				<div className="grid grid-cols-2 gap-3">
					<Field
						label={t("permanenceSettings.service.hours")}
						hint={t("permanenceSettings.service.hoursHint")}
					>
						<TextInput
							value={draft.hours}
							mono
							placeholder="08:00-19:00"
							onChange={(hours) => setDraft({ ...draft, hours })}
							onBlur={commitService}
						/>
					</Field>
					<Field label={t("permanenceSettings.service.cadence")} hint={t("permanenceSettings.service.cadenceHint")}>
						<Number
							value={draft.cadenceMinutes}
							suffix={t("permanenceSettings.unit.minutes")}
							onChange={(cadenceMinutes) => setDraft({ ...draft, cadenceMinutes })}
							onCommit={commitService}
						/>
					</Field>
					<Field
						label={t("permanenceSettings.service.dailyTokens")}
						hint={t("permanenceSettings.service.dailyTokensHint")}
					>
						<Number
							value={draft.dailyTokens}
							onChange={(dailyTokens) => setDraft({ ...draft, dailyTokens })}
							onCommit={commitService}
						/>
					</Field>
					<Field label={t("permanenceSettings.service.dailyEngagements")} hint={t("permanenceSettings.service.dailyEngagementsHint")}>
						<Number
							value={draft.dailyEngagements}
							onChange={(dailyEngagements) => setDraft({ ...draft, dailyEngagements })}
							onCommit={commitService}
						/>
					</Field>
					{/* Le plafond qui compte vraiment : il porte sur ce que tu partages
					    avec elle, pas sur ce qu'elle s'accorde à elle-même. */}
					<Field
						label={t("permanenceSettings.service.quotaFloor")}
						hint={t("permanenceSettings.service.quotaFloorHint")}
					>
						<Number
							value={draft.quotaFloorPercent}
							suffix={t("permanenceSettings.unit.percentLeft")}
							onChange={(quotaFloorPercent) => setDraft({ ...draft, quotaFloorPercent })}
							onCommit={commitService}
						/>
					</Field>
					<Field label={t("permanenceSettings.service.retention")} hint={t("permanenceSettings.service.retentionHint")}>
						<Number
							value={draft.retentionDays}
							suffix={t("permanenceSettings.unit.days")}
							onChange={(retentionDays) => setDraft({ ...draft, retentionDays })}
							onCommit={commitService}
						/>
					</Field>
				</div>

				<Check
					checked={draft.catchUp}
					label={t("permanenceSettings.service.catchUp")}
					hint={t("permanenceSettings.service.catchUpHint")}
					onChange={(catchUp) => void saveService({ catchUp })}
				/>
				<Check
					checked={draft.notifyFailures}
					label={t("permanenceSettings.service.notifyFailures")}
					onChange={(notifyFailures) => void saveService({ notifyFailures })}
				/>
				<Check
					checked={draft.notifyAll}
					label={t("permanenceSettings.service.notifyAll")}
					hint={t("permanenceSettings.service.notifyAllHint")}
					onChange={(notifyAll) => void saveService({ notifyAll })}
				/>

			</Block>

			{/* ── Garde-fous ─────────────────────────────────────────────────── */}
			<Block title={t("permanenceSettings.guards.title")} scope={t("permanenceSettings.scope.station")}>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					{t("permanenceSettings.guards.intro")}
				</p>
				<div className="grid grid-cols-2 gap-3">
					<Field
						label={t("permanenceSettings.guards.maxRunning")}
						hint={t("permanenceSettings.guards.maxRunningHint")}
					>
						<Number
							value={draft.maxRunning}
							onChange={(maxRunning) => setDraft({ ...draft, maxRunning })}
							onCommit={commitService}
						/>
					</Field>
					<Field
						label={t("permanenceSettings.guards.rehearsal")}
						hint={t("permanenceSettings.guards.rehearsalHint")}
					>
						<Number
							value={draft.rehearsal}
							suffix={t("permanenceSettings.unit.engagements")}
							onChange={(rehearsal) => setDraft({ ...draft, rehearsal })}
							onCommit={commitService}
						/>
					</Field>
					<Field
						label={t("permanenceSettings.guards.grace")}
						hint={t("permanenceSettings.guards.graceHint")}
					>
						<Number
							value={draft.graceHours}
							suffix={t("permanenceSettings.unit.hours")}
							onChange={(graceHours) => setDraft({ ...draft, graceHours })}
							onCommit={commitService}
						/>
					</Field>
					<Field
						label={t("permanenceSettings.guards.breaker")}
						hint={t("permanenceSettings.guards.breakerHint")}
					>
						<Number
							value={draft.breaker}
							suffix={t("permanenceSettings.unit.failures")}
							onChange={(breaker) => setDraft({ ...draft, breaker })}
							onCommit={commitService}
						/>
					</Field>
				</div>
			</Block>

			{/* ── Rôle ───────────────────────────────────────────────────────── */}
			<Block title={t("permanenceSettings.role.title")} scope={t("permanenceSettings.scope.station")}>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					{t("permanenceSettings.role.intro")}
				</p>
				<div className="grid grid-cols-2 gap-3">
					<Field label={t("permanenceSettings.role.engine")} hint={t("permanenceSettings.role.engineHint")}>
						<Select
							value={draft.engine}
							onChange={(engine) => setDraft({ ...draft, engine })}
						>
							<option value="">{t("permanenceSettings.role.engineFirst")}</option>
							{(config?.engines ?? []).map((engine) => (
								<option key={engine.id} value={engine.id}>
									{engine.label || engine.id}
								</option>
							))}
						</Select>
					</Field>
					<div />
					<Field label={t("permanenceSettings.role.triageModel")} hint={t("permanenceSettings.role.triageModelHint")}>
						<TextInput
							value={draft.triage?.model ?? ""}
							mono
							placeholder="haiku"
							onChange={(model) =>
								setDraft({ ...draft, triage: { ...draft.triage, model } })
							}
						/>
					</Field>
					<Field label={t("permanenceSettings.role.triageDepth")}>
						<Depth
							value={draft.triage?.depth ?? ""}
							onChange={(depth) => setDraft({ ...draft, triage: { ...draft.triage, depth } })}
						/>
					</Field>
					<Field label={t("permanenceSettings.role.workModel")}>
						<TextInput
							value={draft.work?.model ?? ""}
							mono
							placeholder="sonnet"
							onChange={(model) => setDraft({ ...draft, work: { ...draft.work, model } })}
						/>
					</Field>
					<Field label={t("permanenceSettings.role.workDepth")}>
						<Depth
							value={draft.work?.depth ?? ""}
							onChange={(depth) => setDraft({ ...draft, work: { ...draft.work, depth } })}
						/>
					</Field>
				</div>
				<Field
					label={t("permanenceSettings.role.prompt")}
					hint={t("permanenceSettings.role.promptHint")}
				>
					<textarea
						rows={3}
						spellCheck={false}
						value={draft.prompt}
						onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
						className="focus-ring w-full resize-y rounded-lg border border-line-soft bg-raised px-2.5 py-1.5 text-xs leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/40"
						placeholder={t("permanenceSettings.role.promptPlaceholder")}
					/>
				</Field>
			</Block>

			{/* ── Règles ─────────────────────────────────────────────────────── */}
			<Block
				title={t("permanenceSettings.rules.title")}
				scope={t("permanenceSettings.scope.project")}
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
						{t("permanenceSettings.rules.add")}
					</Button>
				}
			>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					{t("permanenceSettings.rules.intro")}
				</p>
				{rules.length === 0 ? (
					<p className="rounded-lg border border-dashed border-line-soft px-3 py-4 text-center text-[11px] text-ink-faint">
						{t("permanenceSettings.rules.empty")}
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
				title={t("permanenceSettings.powers.title")}
				scope={t("permanenceSettings.scope.project")}
				aside={
					<span className="font-mono text-[10px] text-ink-faint">
						{t("permanenceSettings.powers.enabledCount", {
							count: powers.length + (draft.comment?.enabled ? 1 : 0),
							total: POWERS.length + 1,
						})}
					</span>
				}
			>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					{t("permanenceSettings.powers.intro")}
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
									: t("permanenceSettings.powers.notImplemented")
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
					<Trans
						t={t}
						i18nKey="permanenceSettings.powers.neverShared"
						values={{ branches: PROTECTED_HINT }}
						components={{ b: <span className="font-medium text-ink-muted" /> }}
					/>
				</p>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					<Trans
						t={t}
						i18nKey="permanenceSettings.powers.never"
						values={{ list: NEVER.join(", ") }}
						components={{ b: <span className="font-medium text-ink-muted" /> }}
					/>
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
	const { t } = useTranslation("components3");
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
				<span className="text-[12px] font-medium text-ink">{t("permanenceSettings.comment.title")}</span>
				<Badge tone="warning">{t("permanenceSettings.comment.readByHuman")}</Badge>
			</div>
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("permanenceSettings.comment.intro")}
			</p>

			<div className="flex flex-col gap-1 border-l-2 border-line-soft pl-2.5">
				<p className="text-[10px] tracking-[0.06em] text-ink-faint uppercase">
					{t("permanenceSettings.comment.scopesTitle")}
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
						{t("permanenceSettings.comment.noScope")}
					</p>
				) : null}
			</div>

			<div className="flex flex-col gap-1 border-l-2 border-line-soft pl-2.5">
				<p className="text-[10px] tracking-[0.06em] text-ink-faint uppercase">
					{t("permanenceSettings.comment.alwaysTitle")}
				</p>
				<div className="flex items-center gap-2 text-[11.5px] text-ink-muted">
					{t("permanenceSettings.comment.perDayBefore")}
					<div className="w-16">
						<Number
							value={comment.perDay}
							onChange={(perDay) => onChange({ ...comment, perDay })}
						/>
					</div>
					{t("permanenceSettings.comment.perDayAfter")}
				</div>
				<Fixed>
					{t("permanenceSettings.comment.noMonologue")}
				</Fixed>
				<Fixed>
					<Trans
						t={t}
						i18nKey="permanenceSettings.comment.signature"
						values={{ signature: COMMENT_SIGNATURE }}
						components={{ mono: <span className="font-mono" /> }}
					/>
				</Fixed>
				<Fixed>
					{t("permanenceSettings.comment.optOut")}
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
	const { t } = useTranslation("components3");
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
						placeholder={t("permanenceSettings.rule.labelPlaceholder")}
						onChange={(label) => setDraft({ ...draft, label })}
						onBlur={() => commit(draft)}
					/>
				</div>
				{/* Une règle inapplicable se dit inapplicable, elle ne disparaît pas :
				    sinon on la croit perdue. */}
				{draft.enabled && !stated ? <Badge tone="critical">{t("permanenceSettings.rule.noOracle")}</Badge> : null}
				{draft.trigger && !known ? (
					<Badge tone="critical">{t("permanenceSettings.rule.unknownTrigger")}</Badge>
				) : null}
				<Button size="sm" icon={Trash2} onClick={onRemove} title={t("permanenceSettings.rule.remove")} />
			</div>

			<div className="grid grid-cols-2 gap-3">
				<Field label={t("permanenceSettings.rule.trigger")}>
					<Select
						value={draft.trigger}
						onChange={(trigger) => commit({ ...draft, trigger })}
					>
						<option value="">{t("permanenceSettings.rule.choose")}</option>
						{TRIGGERS.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.label}
							</option>
						))}
					</Select>
				</Field>
				<Field label={t("permanenceSettings.rule.oracle")} hint={t("permanenceSettings.rule.oracleHint")}>
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
						<option value="">{t("permanenceSettings.rule.oracleNone")}</option>
						{sources.map((source) => (
							<option key={`${source.kind}:${source.key}`} value={`${source.kind}:${source.key}`}>
								{source.group} · {source.label}
							</option>
						))}
					</Select>
				</Field>
				<Field label={t("permanenceSettings.rule.condition")} hint={t("permanenceSettings.rule.conditionHint")}>
					<TextInput
						value={draft.condition}
						placeholder={t("permanenceSettings.rule.conditionPlaceholder")}
						onChange={(condition) => setDraft({ ...draft, condition })}
						onBlur={() => commit(draft)}
					/>
				</Field>
				<Field label={t("permanenceSettings.rule.reaction")} hint={t("permanenceSettings.rule.reactionHint")}>
					<TextInput
						value={draft.reaction}
						placeholder={t("permanenceSettings.rule.reactionPlaceholder")}
						onChange={(reaction) => setDraft({ ...draft, reaction })}
						onBlur={() => commit(draft)}
					/>
				</Field>
				{/* Le délai n'a de sens que pour les deux déclencheurs d'horloge :
				    l'afficher ailleurs poserait une question sans réponse. */}
				{draft.trigger === "schedule" || draft.trigger === "pr_stale" ? (
					<Field
						label={t("permanenceSettings.rule.delay")}
						hint={
							draft.trigger === "schedule"
								? t("permanenceSettings.rule.delayScheduleHint")
								: t("permanenceSettings.rule.delayStaleHint")
						}
					>
						<Number
							value={draft.everyHours}
							suffix={t("permanenceSettings.unit.hours")}
							onChange={(everyHours) => setDraft({ ...draft, everyHours })}
							onCommit={() => commit(draft)}
						/>
					</Field>
				) : null}
				<Field label={t("permanenceSettings.rule.tokenBudget")} hint={t("permanenceSettings.rule.tokenBudgetHint")}>
					<Number
						value={draft.tokenBudget}
						onChange={(tokenBudget) => setDraft({ ...draft, tokenBudget })}
						onCommit={() => commit(draft)}
					/>
				</Field>
				<Field label={t("permanenceSettings.rule.perHour")} hint={t("permanenceSettings.rule.perHourHint")}>
					<Number value={draft.perHour} onChange={(perHour) => setDraft({ ...draft, perHour })} />
				</Field>
			</div>

			{/* La porte humaine, rendue règle par règle. Par défaut la Permanence
			    approuve elle-même le plan des missions qu'elle ouvre : l'accord a
			    été donné une fois, ici, en cochant cette règle. */}
			<Check
				checked={draft.needsApproval}
				label={t("permanenceSettings.rule.needsApproval")}
				hint={t("permanenceSettings.rule.needsApprovalHint")}
				onChange={(needsApproval) => commit({ ...draft, needsApproval })}
			/>

			<div className="flex justify-end">
				<Button size="sm" variant="outline" onClick={() => commit(draft)}>
					{t("permanenceSettings.rule.save")}
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
	const { t } = useTranslation("components3");
	return (
		<div className="flex items-center gap-1.5">
			<input
				type="text"
				inputMode="numeric"
				spellCheck={false}
				value={value === 0 ? "" : String(value)}
				placeholder={t("permanenceSettings.unit.default")}
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
	const { t } = useTranslation("components3");
	return (
		<Select value={value} onChange={onChange}>
			<option value="">{t("permanenceSettings.depth.engine")}</option>
			<option value="fast">{t("permanenceSettings.depth.fast")}</option>
			<option value="normal">{t("permanenceSettings.depth.normal")}</option>
			<option value="deep">{t("permanenceSettings.depth.deep")}</option>
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
