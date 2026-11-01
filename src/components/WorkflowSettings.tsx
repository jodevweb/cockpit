import clsx from "clsx";
import { AlertTriangle, Check, KeyRound, Plug, Plus, Route, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Badge, Button, Field, Spinner, TextInput } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { Engine, Role, TeamMember } from "@/lib/types";
import { useCockpit } from "@/app/store";
import { useTerminals } from "@/app/terminals";

/**
 * Ce qui décrit la façon de travailler d'une équipe, et ce qui la sert.
 *
 * Ces réglages vivaient dans le code : les colonnes du suivi, les branches, les
 * rôles confiés aux exécutants. Les avoir sortis ne suffisait pas — tant qu'ils
 * ne s'éditent que dans un fichier TOML, ils restent hors de portée de qui
 * installe l'outil sans le lire.
 *
 * Les listes se saisissent séparées par des virgules plutôt qu'en tableaux
 * cliquables : on en modifie une ou deux fois par projet, et un champ de texte
 * se relit d'un coup d'œil là où une liste d'étiquettes demande de compter.
 */

/** Liste de valeurs ↔ texte, avec la tolérance qu'on attend d'une saisie. */
const toText = (values: string[] | undefined) => (values ?? []).join(", ");
const fromText = (text: string) =>
	text
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);

export function ConnectorsSettings() {
	const { connectors, go } = useCockpit();
	const { t } = useTranslation("components3");

	if (connectors.length === 0) {
		return (
			<div className="flex justify-center py-4">
				<Spinner />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<p className="mb-1 text-[11px] leading-relaxed text-ink-faint">
				{t("workflowSettings.connectors.intro")}
			</p>
			{connectors.map((connector) => (
				<div
					key={connector.id}
					className={clsx(
						"flex items-center gap-2 rounded-lg border px-2.5 py-2",
						connector.configured
							? "border-line-soft bg-surface/40"
							: "border-line-soft bg-base/40",
					)}
				>
					<Plug
						size={12}
						className={clsx(
							"shrink-0",
							connector.configured ? "text-success" : "text-ink-faint",
						)}
					/>
					<span className="text-[11px] font-medium text-ink">{connector.label}</span>
					<Badge>{connector.kind}</Badge>
					<span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
						{connector.configured
							? t("workflowSettings.connectors.ready")
							: t("workflowSettings.connectors.missing", { missing: connector.missing })}
					</span>
					{connector.configured ? (
						<Check size={12} className="shrink-0 text-success" />
					) : (
						<Button size="sm" onClick={() => go("settings")}>
							{t("workflowSettings.connectors.fill")}
						</Button>
					)}
				</div>
			))}
		</div>
	);
}

export function WorkflowSettings() {
	const { config, reloadConfig, notify } = useCockpit();
	const { t } = useTranslation("components3");
	const [draft, setDraft] = useState({
		activeStates: "",
		reviewStates: "",
		doneStates: "",
		blockedState: "",
		baseBranches: "",
		dailyWeekdays: "",
		prCommand: "",
		worktreeCommand: "",
		worktreeRemoveCommand: "",
		devCommand: "",
		testCommands: "",
		visualReports: true,
		agentBrowser: true,
		browserCommand: "",
		browserServer: "",
		reviewReadOnly: true,
	});
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!config?.workflow) return;
		const workflow = config.workflow;
		setDraft({
			activeStates: toText(workflow.activeStates),
			reviewStates: toText(workflow.reviewStates),
			doneStates: toText(workflow.doneStates),
			blockedState: workflow.blockedState ?? "",
			baseBranches: toText(workflow.baseBranches),
			dailyWeekdays: (workflow.dailyWeekdays ?? []).join(", "),
			prCommand: workflow.prCommand ?? "",
			worktreeCommand: workflow.worktreeCommand ?? "",
			worktreeRemoveCommand: workflow.worktreeRemoveCommand ?? "",
			devCommand: workflow.devCommand ?? "",
			testCommands: toText(workflow.testCommands ?? []),
			visualReports: workflow.visualReports ?? true,
			agentBrowser: workflow.agentBrowser ?? true,
			browserCommand: workflow.browserCommand ?? "",
			browserServer: workflow.browserServer ?? "",
			reviewReadOnly: workflow.reviewReadOnly ?? true,
		});
	}, [config?.workflow]);

	const save = async () => {
		setSaving(true);
		try {
			// Sur le projet actif, jamais sur le global : la façon de travailler
			// d'une équipe lui appartient, et l'écrire ailleurs la donnait à tous.
			// Mêmes noms que ceux que la vue rend — le patch se fusionne dans le
			// projet sérialisé, et deux graphies du même champ s'y contrediraient.
			await api.config.updateProject({
				workflow: {
					activeStates: fromText(draft.activeStates),
					reviewStates: fromText(draft.reviewStates),
					doneStates: fromText(draft.doneStates),
					blockedState: draft.blockedState.trim(),
					baseBranches: fromText(draft.baseBranches),
					dailyWeekdays: fromText(draft.dailyWeekdays)
						.map((day) => Number(day))
						.filter((day) => day >= 1 && day <= 7),
					prCommand: draft.prCommand.trim(),
					worktreeCommand: draft.worktreeCommand.trim(),
					worktreeRemoveCommand: draft.worktreeRemoveCommand.trim(),
					devCommand: draft.devCommand.trim(),
					testCommands: fromText(draft.testCommands),
					visualReports: draft.visualReports,
					agentBrowser: draft.agentBrowser,
					browserCommand: draft.browserCommand.trim(),
					browserServer: draft.browserServer.trim(),
					reviewReadOnly: draft.reviewReadOnly,
				},
			});
			reloadConfig();
			notify(t("workflowSettings.workflow.saved"));
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	const themes = config?.workflow?.themes?.length ?? 0;

	// Une substitution mal écrite ne se voit nulle part : `(folder)` part tel
	// quel dans la ligne de commande, `zsh` refuse de l'interpréter, la commande
	// sort en erreur, et l'écran qui l'a lancée n'en disait rien. Repéré sur une
	// configuration réelle, où la suppression d'un worktree ne faisait jamais rien.
	const malFormees = (
		[
			[t("workflowSettings.workflow.createWorktree.label"), draft.worktreeCommand],
			[t("workflowSettings.workflow.removeWorktree.label"), draft.worktreeRemoveCommand],
			[t("workflowSettings.workflow.devServer.label"), draft.devCommand],
		] as const
	)
		.filter(([, commande]) => /[([]\s*(branch|path|folder)\s*[)\]]/.test(commande))
		.map(([label]) => label);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("workflowSettings.workflow.intro")}
			</p>

			<div className="grid grid-cols-3 gap-2">
				<Field
					label={t("workflowSettings.workflow.active.label")}
					hint={t("workflowSettings.workflow.active.hint")}
				>
					<TextInput
						value={draft.activeStates}
						onChange={(activeStates) => setDraft({ ...draft, activeStates })}
						placeholder="In Progress"
					/>
				</Field>
				<Field
					label={t("workflowSettings.workflow.review.label")}
					hint={t("workflowSettings.workflow.review.hint")}
				>
					<TextInput
						value={draft.reviewStates}
						onChange={(reviewStates) => setDraft({ ...draft, reviewStates })}
						placeholder="In Review"
					/>
				</Field>
				<Field label={t("workflowSettings.workflow.done.label")}>
					<TextInput
						value={draft.doneStates}
						onChange={(doneStates) => setDraft({ ...draft, doneStates })}
						placeholder="Done"
					/>
				</Field>
				<Field
					label={t("workflowSettings.workflow.blocked.label")}
					hint={t("workflowSettings.workflow.blocked.hint")}
				>
					<TextInput
						value={draft.blockedState}
						onChange={(blockedState) => setDraft({ ...draft, blockedState })}
						placeholder="Blocked"
					/>
				</Field>
				<Field
					label={t("workflowSettings.workflow.baseBranches.label")}
					hint={t("workflowSettings.workflow.baseBranches.hint")}
				>
					<TextInput
						value={draft.baseBranches}
						onChange={(baseBranches) => setDraft({ ...draft, baseBranches })}
						placeholder="main, develop"
						mono
					/>
				</Field>
				<Field
					label={t("workflowSettings.workflow.dailyWeekdays.label")}
					hint={t("workflowSettings.workflow.dailyWeekdays.hint")}
				>
					<TextInput
						value={draft.dailyWeekdays}
						onChange={(dailyWeekdays) => setDraft({ ...draft, dailyWeekdays })}
						placeholder="1, 3, 5"
						mono
					/>
				</Field>
			</div>

			{/* La façon dont l'équipe ouvre ses pull requests tient souvent dans une
			    commande du dépôt : le bon gabarit, ses labels, l'envoi des captures
			    de recette. Le cockpit ne saurait pas la refaire, et un autre projet
			    ne l'a pas — d'où un réglage par projet plutôt qu'un comportement figé. */}
			<Field
				label={t("workflowSettings.workflow.prCommand.label")}
				hint={t("workflowSettings.workflow.prCommand.hint")}
			>
				<TextInput
					value={draft.prCommand}
					onChange={(prCommand) => setDraft({ ...draft, prCommand })}
					placeholder="/pull-request-creation"
					mono
				/>
			</Field>

			{/* Le cycle de vie d'un worktree n'est pas le même d'une équipe à
			    l'autre : l'une clone une base et réserve un espace, l'autre se
			    contente d'un dossier. Ces commandes vivaient dans le binaire,
			    écrites pour une seule d'entre elles. */}
			<Field
				label={t("workflowSettings.workflow.createWorktree.label")}
				hint={t("workflowSettings.workflow.createWorktree.hint")}
			>
				<TextInput
					value={draft.worktreeCommand}
					onChange={(worktreeCommand) => setDraft({ ...draft, worktreeCommand })}
					placeholder="/create-worktree {branch}"
					mono
				/>
			</Field>
			<Field
				label={t("workflowSettings.workflow.removeWorktree.label")}
				hint={t("workflowSettings.workflow.removeWorktree.hint")}
			>
				<TextInput
					value={draft.worktreeRemoveCommand}
					onChange={(worktreeRemoveCommand) =>
						setDraft({ ...draft, worktreeRemoveCommand })
					}
					placeholder="pnpm worktree:remove {folder} --force"
					mono
				/>
			</Field>
			<Field
				label={t("workflowSettings.workflow.devServer.label")}
				hint={t("workflowSettings.workflow.devServer.hint")}
			>
				<TextInput
					value={draft.devCommand}
					onChange={(devCommand) => setDraft({ ...draft, devCommand })}
					placeholder="pnpm dev"
					mono
				/>
			</Field>
			<p className="-mt-1 text-[10px] leading-relaxed text-ink-faint">
				{t("workflowSettings.replacedAtLaunch")}{" "}
				<span className="font-mono">
					{"{branch}"} {"{path}"} {"{folder}"}
				</span>
			</p>
			{malFormees.length > 0 ? (
				<p className="-mt-0.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-warning">
					<AlertTriangle size={11} className="mt-px shrink-0" />
					<span>
						{t("workflowSettings.workflow.malformed", { commands: malFormees.join(", ") })}
					</span>
				</p>
			) : null}

			<Field
				label={t("workflowSettings.workflow.testCommands.label")}
				hint={t("workflowSettings.workflow.testCommands.hint")}
			>
				<TextInput
					value={draft.testCommands}
					onChange={(testCommands) => setDraft({ ...draft, testCommands })}
					placeholder="check:unit, ./scripts/tests.sh"
					mono
				/>
			</Field>

			{/* La consigne elle-même vit dans la bibliothèque de prompts (« Rendre
			    compte en images ») : ici, on dit seulement si elle part. */}
			<label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line-soft px-3 py-2.5">
				<input
					type="checkbox"
					checked={draft.visualReports}
					onChange={(event) => setDraft({ ...draft, visualReports: event.target.checked })}
					className="mt-0.5 accent-[var(--color-accent)]"
				/>
				<span className="flex flex-col gap-0.5">
					<span className="text-[12px] font-medium text-ink">
						{t("workflowSettings.workflow.visualReports.title")}
					</span>
					<span className="text-[11px] leading-relaxed text-ink-faint">
						{t("workflowSettings.workflow.visualReports.detail")}
					</span>
				</span>
			</label>

			<label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line-soft px-3 py-2.5">
				<input
					type="checkbox"
					checked={draft.agentBrowser}
					onChange={(event) => setDraft({ ...draft, agentBrowser: event.target.checked })}
					className="mt-0.5 accent-[var(--color-accent)]"
				/>
				<span className="flex flex-col gap-0.5">
					<span className="text-[12px] font-medium text-ink">
						{t("workflowSettings.workflow.agentBrowser.title")}
					</span>
					<span className="text-[11px] leading-relaxed text-ink-faint">
						{t("workflowSettings.workflow.agentBrowser.detail")}
					</span>
				</span>
			</label>
			{draft.agentBrowser ? (
				<>
					<Field
						label={t("workflowSettings.workflow.browser.label")}
						hint={t("workflowSettings.workflow.browser.hint")}
					>
						<TextInput
							value={draft.browserCommand}
							onChange={(browserCommand) => setDraft({ ...draft, browserCommand })}
							placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
							mono
						/>
					</Field>
					<Field
						label={t("workflowSettings.workflow.browserServer.label")}
						hint={t("workflowSettings.workflow.browserServer.hint")}
					>
						<TextInput
							value={draft.browserServer}
							onChange={(browserServer) => setDraft({ ...draft, browserServer })}
							placeholder="npx -y @playwright/mcp@0.0.83"
							mono
						/>
					</Field>
				</>
			) : null}

			{/* Une garantie, pas une politesse : cochée, l'agent qui relit une PR
			    n'a ni les outils d'écriture ni le droit de lancer autre chose
			    qu'une lecture. Décochée, il garde la consigne de ne rien corriger,
			    mais plus rien ne l'en empêche. */}
			<label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line-soft px-3 py-2.5">
				<input
					type="checkbox"
					checked={draft.reviewReadOnly}
					onChange={(event) => setDraft({ ...draft, reviewReadOnly: event.target.checked })}
					className="mt-0.5 accent-[var(--color-accent)]"
				/>
				<span className="flex flex-col gap-0.5">
					<span className="text-[12px] font-medium text-ink">
						{t("workflowSettings.workflow.reviewReadOnly.title")}
					</span>
					<span className="text-[11px] leading-relaxed text-ink-faint">
						{t("workflowSettings.workflow.reviewReadOnly.detail")}
					</span>
				</span>
			</label>

			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 text-[10px] text-ink-faint">
					{themes > 0
						? t("workflowSettings.workflow.themes", { count: themes })
						: t("workflowSettings.workflow.noThemes")}
				</span>
				<Button variant="solid" icon={Check} disabled={saving} onClick={() => void save()}>
					{saving ? t("workflowSettings.saving") : t("workflowSettings.save")}
				</Button>
			</div>
		</div>
	);
}

/**
 * Le catalogue des rôles confiés aux exécutants d'une mission.
 *
 * Un rôle décrit une responsabilité et un périmètre, pas une pile technique :
 * « développeur backend » ne veut pas dire la même chose d'un projet à l'autre,
 * et c'est le prompt qu'on y met qui fait la différence.
 */
export function RolesSettings() {
	const { config, reloadConfig, notify } = useCockpit();
	const { t } = useTranslation("components3");
	const [roles, setRoles] = useState<Role[]>([]);
	const [saving, setSaving] = useState(false);

	// Une configuration vierge ne déclare aucun rôle : le cockpit applique alors
	// ceux du catalogue. Les montrer vides laisserait croire qu'il n'y en a pas,
	// et surtout empêcherait d'en régler un sans tout écrire à la main.
	useEffect(() => {
		if (config?.roles && config.roles.length > 0) {
			setRoles(config.roles);
			return;
		}
		void api.missions
			.roles()
			.then(setRoles)
			.catch(() => undefined);
	}, [config?.roles]);

	const save = async (next: Role[]) => {
		setSaving(true);
		try {
			// Les rôles suivent le projet : un produit et un outil interne ne se
			// découpent pas de la même façon.
			await api.config.updateProject({
				roles: next.map((role) => ({
					id: role.id,
					label: role.label,
					prompt: role.prompt,
					model: role.model,
					engine: role.engine,
					permission_mode: role.permissionMode,
					depth: role.depth ?? "",
					command: role.command,
					verifies: role.verifies,
					scope: role.scope,
				})),
			});
			reloadConfig();
			notify(t("workflowSettings.roles.saved"));
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	const update = (index: number, patch: Partial<Role>) => {
		setRoles((current) =>
			current.map((role, position) => (position === index ? { ...role, ...patch } : role)),
		);
	};

	/** Ce moteur sait-il exprimer une profondeur ? Sinon le réglage n'a aucun effet. */
	const depthKnown = (engineId: string) => {
		const moteur =
			(config?.engines ?? []).find((entry) => entry.id === engineId) ??
			(config?.engines ?? [])[0] ??
			null;
		return Boolean(
			moteur &&
				(moteur.depthFast?.trim() ||
					moteur.depthNormal?.trim() ||
					moteur.depthDeep?.trim()),
		);
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("workflowSettings.roles.intro")}
			</p>

			{roles.map((role, index) => (
				<div
					key={`${role.id}-${index}`}
					className={clsx(
						"flex flex-col gap-2 rounded-xl border p-2.5",
						// Le maître se règle ici comme les autres, mais il ne joue pas le
						// même jeu : il pilote la mission au lieu d'exécuter une tâche.
						role.id === "master"
							? "border-accent/30 bg-accent/[0.05]"
							: "border-line-soft bg-surface/40",
					)}
				>
					{role.id === "master" ? (
						<p className="text-[10px] leading-relaxed text-ink-faint">
							{t("workflowSettings.roles.masterNote")}
						</p>
					) : null}
					{/* Six colonnes, dont deux pour la profondeur : ses quatre boutons
					    ne tiennent pas dans un cinquième de la largeur, et débordaient
					    du cadre par la droite. */}
					<div className="grid grid-cols-6 gap-2">
						<Field
							label={t("workflowSettings.fields.key")}
							hint={t("workflowSettings.roles.keyHint")}
						>
							<TextInput
								value={role.id}
								onChange={(id) => update(index, { id })}
								disabled={role.id === "master"}
								mono
							/>
						</Field>
						<Field label={t("workflowSettings.fields.displayName")}>
								<TextInput
									value={role.label}
								onChange={(label) => update(index, { label })}
							/>
						</Field>
						<Field
							label={t("workflowSettings.roles.engine.label")}
							hint={t("workflowSettings.roles.engine.hint")}
						>
							<select
								value={role.engine}
								onChange={(event) => update(index, { engine: event.target.value })}
								className="focus-ring w-full rounded-lg border border-line-soft bg-raised px-2 py-1.5 text-[11px] text-ink"
							>
								{/* Vide plutôt qu'un moteur nommé d'office : un rôle qui ne
								    choisit pas suit le premier déclaré, et suivra celui qui le
								    remplacera. */}
								<option value="">{t("workflowSettings.roles.engine.default")}</option>
								{(config?.engines ?? []).map((engine) => (
									<option key={engine.id} value={engine.id}>
										{engine.label || engine.id}
									</option>
								))}
							</select>
						</Field>
						<Field
							label={t("workflowSettings.roles.model.label")}
							hint={t("workflowSettings.roles.model.hint")}
						>
							<TextInput
								value={role.model}
								onChange={(model) => update(index, { model })}
								placeholder="fable, opus, sonnet…"
								mono
							/>
						</Field>
						{/* Le levier de coût le plus direct : une recette qui relit un
						    diff n'a pas besoin de la dépense d'un maître qui découpe une
						    mission. Grisé quand le moteur du rôle ne sait pas l'exprimer —
						    le cockpit n'invente pas de drapeau. */}
						<div className="col-span-2">
						<Field
							label={t("workflowSettings.roles.depth.label")}
							hint={t("workflowSettings.roles.depth.hint")}
						>
							{/* `flex-wrap` : à fenêtre étroite, deux colonnes ne suffisent
							    plus non plus — les boutons passent à la ligne au lieu de
							    sortir du panneau. */}
							<div className="flex flex-wrap items-center gap-1">
								{[
									{ id: "", label: t("workflowSettings.roles.depth.engine") },
									{ id: "fast", label: t("workflowSettings.depth.fast") },
									{ id: "normal", label: t("workflowSettings.depth.normal") },
									{ id: "deep", label: t("workflowSettings.depth.deep") },
								].map((niveau) => (
									<Button
										key={niveau.id || "defaut"}
										size="sm"
										active={(role.depth ?? "") === niveau.id}
										disabled={!depthKnown(role.engine)}
										title={
											depthKnown(role.engine)
												? undefined
												: t("workflowSettings.roles.depth.unsupported")
										}
										onClick={() => update(index, { depth: niveau.id })}
									>
										{niveau.label}
									</Button>
								))}
							</div>
						</Field>
						</div>
						<Field
							label={t("workflowSettings.roles.scope.label")}
							hint={t("workflowSettings.roles.scope.hint")}
						>
							<TextInput
								value={toText(role.scope)}
								onChange={(scope) => update(index, { scope: fromText(scope) })}
								placeholder="apps/api/**"
								mono
							/>
						</Field>
					</div>
					{/* La méthode d'une équipe vit dans ses commandes, pas dans un
					    prompt recopié : on appelle la commande, et c'est la version
					    du dépôt qui fait foi. */}
					<Field
						label={t("workflowSettings.roles.command.label")}
						hint={t("workflowSettings.roles.command.hint")}
					>
						<TextInput
							value={role.command}
							onChange={(command) => update(index, { command })}
							placeholder="/linear-story-implementer {ticketUrl}"
							mono
						/>
					</Field>
					<p className="-mt-1 text-[10px] leading-relaxed text-ink-faint">
						{t("workflowSettings.replacedAtLaunch")}{" "}
						<span className="font-mono">
							{"{ticket}"} {"{ticketUrl}"} {"{branch}"} {"{mission}"} {"{task}"}{" "}
							{"{brief}"}
						</span>
					</p>
					<Field label={t("workflowSettings.roles.prompt")}>
						<textarea
							value={role.prompt}
							onChange={(event) => update(index, { prompt: event.target.value })}
							rows={3}
							className="focus-ring text-selectable w-full resize-none rounded-lg border border-line-soft bg-raised px-2.5 py-2 text-[11px] leading-relaxed text-ink"
						/>
					</Field>
					<div className="flex items-center justify-between gap-3">
						{/* Ce réglage décide de l'ordre, pas du contenu : un rôle qui
						    juge le travail des autres attend qu'ils aient livré. */}
						<label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
							<input
								type="checkbox"
								checked={role.verifies}
								onChange={(event) => update(index, { verifies: event.target.checked })}
								className="focus-ring accent-accent"
							/>
							{t("workflowSettings.roles.verifies")}
						</label>
						<Button
							size="sm"
							icon={Trash2}
							variant="danger"
							onClick={() => {
								const next = roles.filter((_, position) => position !== index);
								setRoles(next);
								void save(next);
								}}
							>
								{t("workflowSettings.remove")}
							</Button>
						</div>
					</div>
				))}

			<div className="flex items-center gap-2">
				<Button
					size="sm"
					icon={Plus}
					onClick={() =>
						setRoles([
							...roles,
							{
								id: "nouveau",
								label: t("workflowSettings.roles.newLabel"),
								prompt: "",
								model: "",
								engine: "",
								permissionMode: "bypassPermissions",
								depth: "",
								command: "",
								verifies: false,
								scope: [],
							},
						])
					}
				>
					{t("workflowSettings.roles.add")}
				</Button>
				<div className="flex-1" />
				<Button
					variant="solid"
					icon={Check}
					disabled={saving}
					onClick={() => void save(roles)}
				>
					{saving ? t("workflowSettings.saving") : t("workflowSettings.roles.save")}
				</Button>
			</div>
		</div>
	);
}

/**
 * L'équipe du projet : qui la compose, et sous quels comptes on la reconnaît.
 *
 * Ces correspondances ne se devinent pas — Linear identifie par un UUID, GitHub
 * par un login, Sentry par l'email du compte — et rien ne fonctionne sans elles :
 * un ticket réassigné, une PR en attente ou une erreur de prod ne se rattachent
 * à personne. Elles ne s'éditaient qu'à la main dans le fichier de
 * configuration, ce qui revenait à réserver le daily et le tableau d'équipe à
 * qui accepte d'ouvrir un TOML.
 *
 * L'UUID Linear est le seul champ vraiment ingrat : il se lit dans l'URL du
 * profil, et l'écran le dit plutôt que de laisser chercher.
 */
export function TeamSettings() {
	const { config, reloadConfig, notify, activeProject } = useCockpit();
	const { t } = useTranslation("components3");
	const [members, setMembers] = useState<TeamMember[]>([]);
	const [linearTeamId, setLinearTeamId] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!config?.team) return;
		setMembers(config.team.members ?? []);
		setLinearTeamId(config.team.linearTeamId ?? "");
	}, [config?.team]);

	const save = async (next: TeamMember[], team = linearTeamId) => {
		setSaving(true);
		try {
			// L'équipe suit le projet : les membres d'un produit n'ont rien à faire
			// dans le daily d'un autre.
			await api.config.updateProject({
				team: {
					linearTeamId: team.trim(),
					members: next.map((member) => ({
						name: member.name.trim(),
						role: member.role.trim() || "dev",
						roleLabel: member.roleLabel.trim(),
						linearId: member.linearId.trim(),
						github: member.github.trim(),
						githubAliases: member.githubAliases,
						sentryEmails: member.sentryEmails,
						sentryNames: member.sentryNames,
					})),
				},
			});
			reloadConfig();
			notify(t("workflowSettings.team.saved"));
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	const update = (index: number, patch: Partial<TeamMember>) => {
		setMembers((current) =>
			current.map((member, position) =>
				position === index ? { ...member, ...patch } : member,
			),
		);
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("workflowSettings.team.intro")}
			</p>

			{/* Un projet déclaré solo n'a pas d'équipe, par choix : ses membres sont
			    écartés à la lecture. Le dire ici, sinon on saisit cinq personnes qui
			    disparaissent au rechargement sans que rien ne l'explique. */}
			{activeProject?.solo ? (
				<p className="rounded-lg border border-warning/30 bg-warning/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-ink-muted">
					<Trans
						t={t}
						i18nKey="workflowSettings.team.soloWarning"
						components={{ strong: <strong /> }}
					/>
				</p>
			) : null}

			<Field
				label={t("workflowSettings.team.linearTeam.label")}
				hint={t("workflowSettings.team.linearTeam.hint")}
			>
				<TextInput
					value={linearTeamId}
					onChange={setLinearTeamId}
					placeholder="11111111-1111-1111-1111-111111111111"
					mono
				/>
			</Field>

			{members.length === 0 ? (
				<p className="rounded-lg border border-line-soft bg-surface/40 px-2.5 py-2 text-[11px] text-ink-faint">
					{t("workflowSettings.team.empty")}
				</p>
			) : null}

			{members.map((member, index) => (
				<div
					key={index}
					className="flex flex-col gap-2 rounded-xl border border-line-soft bg-surface/40 p-2.5"
				>
					<div className="grid grid-cols-4 gap-2">
						<Field label={t("workflowSettings.team.name")}>
							<TextInput
								value={member.name}
								onChange={(name) => update(index, { name })}
								placeholder="Alice Martin"
							/>
						</Field>
						{/* `dev` ou `product` : ce n'est pas décoratif — seuls les devs
						    sont attendus sur des pull requests, et le daily le sait. */}
						<Field
							label={t("workflowSettings.team.role.label")}
							hint={t("workflowSettings.team.role.hint")}
						>
							<TextInput
								value={member.role}
								onChange={(role) => update(index, { role })}
								placeholder="dev"
								mono
							/>
						</Field>
						<Field
							label={t("workflowSettings.team.roleLabel.label")}
							hint={t("workflowSettings.team.roleLabel.hint")}
						>
							<TextInput
								value={member.roleLabel}
								onChange={(roleLabel) => update(index, { roleLabel })}
								placeholder={t("workflowSettings.team.roleLabel.placeholder")}
							/>
						</Field>
						<Field label="GitHub" hint={t("workflowSettings.team.github.hint")}>
							<TextInput
								value={member.github}
								onChange={(github) => update(index, { github })}
								placeholder="alice-dev"
								mono
							/>
						</Field>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Field
							label={t("workflowSettings.team.linearId.label")}
							hint={t("workflowSettings.team.linearId.hint")}
						>
							<TextInput
								value={member.linearId}
								onChange={(linearId) => update(index, { linearId })}
								placeholder="22222222-2222-2222-2222-222222222222"
								mono
							/>
						</Field>
						{/* Un compte renommé ou un second login : sans eux, ses anciennes
						    PR passent pour celles de quelqu'un d'autre. */}
						<Field
							label={t("workflowSettings.team.githubAliases.label")}
							hint={t("workflowSettings.team.githubAliases.hint")}
						>
							<TextInput
								value={toText(member.githubAliases)}
								onChange={(value) => update(index, { githubAliases: fromText(value) })}
								mono
							/>
						</Field>
						<Field
							label={t("workflowSettings.team.sentryEmails.label")}
							hint={t("workflowSettings.team.sentryEmails.hint")}
						>
							<TextInput
								value={toText(member.sentryEmails)}
								onChange={(value) => update(index, { sentryEmails: fromText(value) })}
								placeholder="alice@example.com"
								mono
							/>
						</Field>
						<Field
							label={t("workflowSettings.team.sentryNames.label")}
							hint={t("workflowSettings.team.sentryNames.hint")}
						>
							<TextInput
								value={toText(member.sentryNames)}
								onChange={(value) => update(index, { sentryNames: fromText(value) })}
								placeholder="Alice Martin"
							/>
						</Field>
					</div>
					<div className="flex justify-end">
						<Button
							size="sm"
							icon={Trash2}
							variant="danger"
							onClick={() => {
								const next = members.filter((_, position) => position !== index);
								setMembers(next);
								void save(next);
							}}
						>
							{t("workflowSettings.remove")}
						</Button>
					</div>
				</div>
			))}

			<div className="flex items-center gap-2">
				<Button
					size="sm"
					icon={Plus}
					onClick={() =>
						setMembers([
							...members,
							{
								name: "",
								role: "dev",
								roleLabel: "",
								linearId: "",
								github: "",
								githubAliases: [],
								sentryEmails: [],
								sentryNames: [],
							},
						])
					}
				>
					{t("workflowSettings.team.add")}
				</Button>
				<div className="flex-1" />
				<Button
					variant="solid"
					icon={Check}
					disabled={saving}
					onClick={() => void save(members)}
				>
					{saving ? t("workflowSettings.saving") : t("workflowSettings.team.save")}
				</Button>
			</div>
		</div>
	);
}

/**
 * Les moteurs d'agents : quel programme fait tourner un agent, et comment.
 *
 * Le cockpit ne parle pas à un modèle, il pilote un agent — quelque chose qui
 * lit des fichiers, en écrit, lance des commandes et demande l'autorisation de le
 * faire. Une clé d'API ne fait rien de tout cela : c'est le programme qui
 * l'exécute. Déclarer un moteur, c'est donc désigner ce programme.
 *
 * Ce qui rend la chose extensible sans recompiler : le binaire, les variables
 * d'environnement qu'il reçoit — l'adresse d'un service compatible, un jeton — et
 * les modèles qu'il accepte. Une passerelle qui expose un autre fournisseur
 * derrière une API compatible se déclare ainsi en trois champs, et ses modèles
 * apparaissent dans les sélecteurs comme les autres.
 *
 * Trois protocoles sont câblés : `claude-stream-json` (le défaut, process
 * unique qui reste ouvert d'un tour à l'autre), `codex-exec` (un process
 * relancé à chaque tour — `codex exec`/`codex exec resume`, pas la même
 * conversation qu'on rouvre) et `gemini-stream-json` (un seul tour possible :
 * aucune source ne documente de reprise pour ce mode). Le montrer plutôt que
 * le taire évite de laisser croire qu'un CLI quelconque conviendra.
 */
export function EnginesSettings() {
	const { config, reloadConfig, notify } = useCockpit();
	const { t } = useTranslation("components3");
	const [engines, setEngines] = useState<Engine[]>([]);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (config?.engines) setEngines(config.engines);
	}, [config?.engines]);

	const save = async (next: Engine[]) => {
		setSaving(true);
		try {
			// Sur le projet actif comme les rôles ; les moteurs s'héritent, donc un
			// projet qui n'en déclare pas garde ceux du poste.
			await api.config.updateProject({
				engines: next.map((engine) => ({
					id: engine.id.trim(),
					label: engine.label.trim() || engine.id.trim(),
					command: engine.command.trim(),
					protocol: engine.protocol.trim(),
					models: engine.models,
					env: engine.env.filter((entry) => entry.name.trim() !== ""),
					extraArgs: engine.extraArgs.trim(),
					depthFast: engine.depthFast?.trim() ?? "",
					depthNormal: engine.depthNormal?.trim() ?? "",
					depthDeep: engine.depthDeep?.trim() ?? "",
				})),
			});
			reloadConfig();
			notify(t("workflowSettings.engines.saved"));
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	const update = (index: number, patch: Partial<Engine>) => {
		setEngines((current) =>
			current.map((engine, position) =>
				position === index ? { ...engine, ...patch } : engine,
			),
		);
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("workflowSettings.engines.intro")}
			</p>

			{engines.map((engine, index) => (
				<div
					key={index}
					className="flex flex-col gap-2 rounded-xl border border-line-soft bg-surface/40 p-2.5"
				>
					<div className="grid grid-cols-4 gap-2">
						<Field
							label={t("workflowSettings.fields.key")}
							hint={t("workflowSettings.engines.keyHint")}
						>
							<TextInput
								value={engine.id}
								onChange={(id) => update(index, { id })}
								placeholder="claude"
								mono
							/>
						</Field>
						<Field label={t("workflowSettings.fields.displayName")}>
								<TextInput
									value={engine.label}
								onChange={(label) => update(index, { label })}
								placeholder="Claude Code"
							/>
						</Field>
						<Field
							label={t("workflowSettings.engines.binary.label")}
							hint={t("workflowSettings.engines.binary.hint")}
						>
							<TextInput
								value={engine.command}
								onChange={(command) => update(index, { command })}
								placeholder="/opt/homebrew/bin/claude"
								mono
							/>
						</Field>
						<Field
							label={t("workflowSettings.engines.protocol.label")}
							hint={t("workflowSettings.engines.protocol.hint")}
						>
							<TextInput
								value={engine.protocol || "claude-stream-json"}
								onChange={(protocol) => update(index, { protocol })}
								mono
							/>
						</Field>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Field
							label={t("workflowSettings.engines.models.label")}
							hint={t("workflowSettings.engines.models.hint")}
						>
							<TextInput
								value={toText(engine.models)}
								onChange={(value) => update(index, { models: fromText(value) })}
								placeholder="fable, opus, sonnet, haiku"
								mono
							/>
						</Field>
						<Field
							label={t("workflowSettings.engines.args.label")}
							hint={t("workflowSettings.engines.args.hint")}
						>
							<TextInput
								value={engine.extraArgs}
								onChange={(extraArgs) => update(index, { extraArgs })}
								mono
							/>
						</Field>
					</div>

					{/* Le cockpit ne connaît pas les drapeaux des moteurs et n'a pas à
					    les deviner : il demande « vite », « normalement » ou « à fond »,
					    et c'est ici qu'on dit comment ce moteur-là l'obtient. Laissé
					    vide, le réglage se grise sur les rôles au lieu de partir dans le
					    vide — et le jour où un moteur renomme son drapeau, c'est une
					    ligne de configuration, pas une version du cockpit. */}
					<div className="grid grid-cols-3 gap-2">
						<Field
							label={t("workflowSettings.depth.fast")}
							hint={t("workflowSettings.engines.depthFastHint")}
						>
							<TextInput
								value={engine.depthFast ?? ""}
								onChange={(depthFast) => update(index, { depthFast })}
								placeholder="--effort low"
								mono
							/>
						</Field>
						<Field label={t("workflowSettings.depth.normal")}>
							<TextInput
								value={engine.depthNormal ?? ""}
								onChange={(depthNormal) => update(index, { depthNormal })}
								placeholder="--effort high"
								mono
							/>
						</Field>
						<Field
							label={t("workflowSettings.depth.deep")}
							hint={t("workflowSettings.engines.depthDeepHint")}
						>
							<TextInput
								value={engine.depthDeep ?? ""}
								onChange={(depthDeep) => update(index, { depthDeep })}
								placeholder="--effort xhigh"
								mono
							/>
						</Field>
					</div>

					{/* C'est par ici qu'un moteur pointe ailleurs : une valeur vide efface
					    la variable au lieu d'en poser une chaîne vide, qu'un CLI lirait
					    comme une adresse invalide. */}
					<Field
						label={t("workflowSettings.engines.env.label")}
						hint={t("workflowSettings.engines.env.hint")}
					>
						<textarea
							value={engine.env.map((entry) => `${entry.name}=${entry.value}`).join("\n")}
							onChange={(event) =>
								update(index, {
									env: event.target.value
										.split("\n")
										.map((line) => line.trim())
										.filter(Boolean)
										.map((line) => {
											const at = line.indexOf("=");
											return at === -1
												? { name: line, value: "" }
												: {
														name: line.slice(0, at).trim(),
														value: line.slice(at + 1).trim(),
													};
										}),
								})
							}
							rows={3}
							placeholder={t("workflowSettings.engines.env.placeholder")}
							className="focus-ring text-selectable w-full resize-none rounded-lg border border-line-soft bg-raised px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink"
						/>
					</Field>

					<div className="flex items-center justify-between gap-3">
						<span className="text-[10px] text-ink-faint">
							{engine.env.length > 0
								? t("workflowSettings.engines.variables", { count: engine.env.length })
								: t("workflowSettings.engines.noVariables")}
						</span>
						{/* Le dernier moteur ne se retire pas : sans lui, plus rien ne
						    pourrait lancer d'agent, et l'écran ne dirait pas pourquoi. */}
						{engines.length > 1 ? (
							<Button
								size="sm"
								icon={Trash2}
								variant="danger"
								onClick={() => {
									const next = engines.filter((_, position) => position !== index);
									setEngines(next);
									void save(next);
								}}
							>
								{t("workflowSettings.remove")}
							</Button>
						) : null}
					</div>
				</div>
			))}

			<div className="flex items-center gap-2">
				<Button
					size="sm"
					icon={Plus}
					onClick={() =>
						setEngines([
							...engines,
							{
								id: "",
								label: "",
								command: "",
								protocol: "claude-stream-json",
								models: [],
								env: [],
								extraArgs: "",
								depthFast: "",
								depthNormal: "",
								depthDeep: "",
							},
						])
					}
				>
					{t("workflowSettings.engines.add")}
				</Button>
				<div className="flex-1" />
				<Button
					variant="solid"
					icon={Check}
					disabled={saving}
					onClick={() => void save(engines)}
				>
					{saving ? t("workflowSettings.saving") : t("workflowSettings.engines.save")}
				</Button>
			</div>
		</div>
	);
}

/**
 * Comment une mission démarre : guidée, ou autonome.
 *
 * Guidée par défaut : on valide ce que le maître a compris du ticket, puis son
 * approche, puis son découpage. L'autonome reste pour les équipes qui
 * préfèrent aller vite — le maître découpe directement, un seul accord. Le
 * choix vaut pour les missions ouvertes ensuite ; celles en cours finissent
 * sur le chemin qu'elles ont pris.
 */
export function MissionModeSettings() {
	const { config, reloadConfig, notify } = useCockpit();
	const { t } = useTranslation("components3");
	const autonomous = config?.missions?.autonomous ?? false;

	const choose = async (next: boolean) => {
		if (!config?.missions || next === autonomous) return;
		try {
			await api.config.update({
				missions: { ...config.missions, autonomous: next },
			});
			reloadConfig();
		} catch (error) {
			notify(String(error));
		}
	};

	const options = [
		{
			value: false,
			icon: Route,
			title: t("workflowSettings.missionMode.guided.title"),
			detail: t("workflowSettings.missionMode.guided.detail"),
		},
		{
			value: true,
			icon: Zap,
			title: t("workflowSettings.missionMode.autonomous.title"),
			detail: t("workflowSettings.missionMode.autonomous.detail"),
		},
	];

	return (
		<div className="grid grid-cols-2 gap-3">
			{options.map((option) => {
				const active = option.value === autonomous;
				const Icon = option.icon;
				return (
					<button
						key={String(option.value)}
						type="button"
						onClick={() => void choose(option.value)}
						className={clsx(
							"focus-ring flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
							active
								? "border-accent/50 bg-accent/[0.07]"
								: "border-line-soft hover:border-line hover:bg-hover/40",
						)}
					>
						<span
							className={clsx(
								"grid size-8 shrink-0 place-items-center rounded-lg",
								active ? "bg-accent text-accent-ink" : "bg-raised text-ink-faint",
							)}
						>
							<Icon size={15} />
						</span>
						<span className="min-w-0">
							<span className="flex items-center gap-2 text-[12px] font-semibold text-ink">
								{option.title}
								{option.value === false ? (
									<span className="text-[10px] font-normal text-ink-faint">
										{t("workflowSettings.missionMode.default")}
									</span>
								) : null}
							</span>
							<span className="mt-0.5 block text-[11px] leading-relaxed text-ink-muted">
								{option.detail}
							</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}


/**
 * Ce qu'une mission a le droit de coûter.
 *
 * Les missions sont ce qui consomme le plus dans le cockpit : la boucle lance
 * les tâches prêtes toutes les six secondes, et le parallélisme était borné —
 * pas la dépense. Quatre agents en série coûtent autant que quatre en
 * parallèle.
 *
 * Comme partout ailleurs : on quitte le champ, c'est enregistré.
 */
export function MissionBudgetSettings() {
	const { config, reloadConfig, notify } = useCockpit();
	const { t } = useTranslation("components3");
	const [draft, setDraft] = useState({
		tokenBudget: 0,
		quotaFloorPercent: 0,
		memoryCeilingPercent: 0,
		autonomous: false,
	});

	useEffect(() => {
		if (config?.missions) setDraft(config.missions);
	}, [config?.missions]);

	const save = async () => {
		try {
			await api.config.update({ missions: draft });
			reloadConfig();
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("workflowSettings.budget.intro")}
			</p>
			<div className="grid grid-cols-3 gap-3">
				<Field
					label={t("workflowSettings.budget.tokenBudget.label")}
					hint={t("workflowSettings.budget.tokenBudget.hint")}
				>
					<div className="flex items-center gap-1.5">
						<TextInput
							value={draft.tokenBudget === 0 ? "" : String(draft.tokenBudget)}
							mono
							placeholder={t("workflowSettings.defaultPlaceholder")}
							onChange={(value) =>
								setDraft((current) => ({
									...current,
									tokenBudget: Number(value.replace(/\D/g, "")) || 0,
								}))
							}
							onBlur={() => void save()}
						/>
						<span className="shrink-0 text-[10px] text-ink-faint">
							{t("workflowSettings.budget.tokenBudget.unit")}
						</span>
					</div>
				</Field>
				<Field
					label={t("workflowSettings.budget.quotaFloor.label")}
					hint={t("workflowSettings.budget.quotaFloor.hint")}
				>
					<div className="flex items-center gap-1.5">
						<TextInput
							value={draft.quotaFloorPercent === 0 ? "" : String(draft.quotaFloorPercent)}
							mono
							placeholder={t("workflowSettings.defaultPlaceholder")}
							onChange={(value) =>
								setDraft((current) => ({
									...current,
									quotaFloorPercent: Number(value.replace(/\D/g, "")) || 0,
								}))
							}
							onBlur={() => void save()}
						/>
						<span className="shrink-0 text-[10px] text-ink-faint">
							{t("workflowSettings.budget.quotaFloor.unit")}
						</span>
					</div>
				</Field>
				<Field
					label={t("workflowSettings.budget.memoryCeiling.label")}
					hint={t("workflowSettings.budget.memoryCeiling.hint")}
				>
					<div className="flex items-center gap-1.5">
						<TextInput
							value={
								draft.memoryCeilingPercent === 0 ? "" : String(draft.memoryCeilingPercent)
							}
							mono
							placeholder={t("workflowSettings.defaultPlaceholder")}
							onChange={(value) =>
								setDraft((current) => ({
									...current,
									memoryCeilingPercent: Number(value.replace(/\D/g, "")) || 0,
								}))
							}
							onBlur={() => void save()}
						/>
						<span className="shrink-0 text-[10px] text-ink-faint">
							{t("workflowSettings.budget.memoryCeiling.unit")}
						</span>
					</div>
				</Field>
			</div>
		</div>
	);
}

/**
 * Où un agent a le droit de tourner.
 *
 * Le plafond ci-dessus refuse un agent de plus quand la machine sature ; il
 * ne borne rien pour un agent isolé qui déraille tout seul — un `pnpm dev`
 * qu'il lance lui-même via son propre outil Bash, invisible du cockpit.
 * L'isolation par conteneurs couvre ce cas-là : un plafond imposé par le
 * runtime, pas mesuré après coup.
 *
 * Off par défaut, comme toute intégration : ni Docker ni OrbStack ne sont un
 * prérequis du cockpit tant que ceci reste éteint.
 */
export function SandboxSettings() {
	const { config, reloadConfig, notify, go } = useCockpit();
	const { t } = useTranslation("components3");
	const terminals = useTerminals();
	const [draft, setDraft] = useState({
		enabled: false,
		runtime: "",
		image: "",
		memoryMb: 0,
		cpus: 0,
	});

	// Un abonnement connecté sur le poste range son jeton dans le trousseau
	// macOS, inaccessible à un conteneur Linux — vérifié empiriquement. Un
	// agent isolé s'authentifie donc par un jeton `claude setup-token`
	// plutôt que `claude login`. Ce jeton ne s'écrit dans aucun fichier — la
	// commande l'affiche une seule fois — d'où le second geste : le coller
	// dans Réglages → Jetons d'accès, où le cockpit le range et le repose à
	// chaque lancement isolé.
	const connect = async () => {
		try {
			const { cwd, command } = await api.sandbox.login();
			terminals.open(cwd, { command, label: t("workflowSettings.sandbox.terminalLabel") });
			go("workspace");
		} catch (error) {
			notify(String(error));
		}
	};

	useEffect(() => {
		if (config?.sandbox) setDraft(config.sandbox);
	}, [config?.sandbox]);

	const save = async (next = draft) => {
		try {
			await api.config.update({ sandbox: next });
			reloadConfig();
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("workflowSettings.sandbox.intro")}
			</p>
			<label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
				<input
					type="checkbox"
					checked={draft.enabled}
					onChange={(event) => {
						const next = { ...draft, enabled: event.target.checked };
						setDraft(next);
						void save(next);
					}}
					className="focus-ring accent-accent"
				/>
				{t("workflowSettings.sandbox.enable")}
			</label>
			{draft.enabled ? (
				<div className="grid grid-cols-3 gap-3">
					<Field label="Runtime" hint={t("workflowSettings.sandbox.runtime.hint")}>
						<TextInput
							value={draft.runtime}
							mono
							placeholder={t("workflowSettings.sandbox.runtime.placeholder")}
							onChange={(value) => setDraft((current) => ({ ...current, runtime: value }))}
							onBlur={() => void save()}
						/>
					</Field>
					<Field
						label={t("workflowSettings.sandbox.memory.label")}
						hint={t("workflowSettings.sandbox.memory.hint")}
					>
						<div className="flex items-center gap-1.5">
							<TextInput
								value={draft.memoryMb === 0 ? "" : String(draft.memoryMb)}
								mono
								placeholder={t("workflowSettings.defaultPlaceholder")}
								onChange={(value) =>
									setDraft((current) => ({
										...current,
										memoryMb: Number(value.replace(/\D/g, "")) || 0,
									}))
								}
								onBlur={() => void save()}
							/>
							<span className="shrink-0 text-[10px] text-ink-faint">
								{t("workflowSettings.sandbox.memory.unit")}
							</span>
						</div>
					</Field>
					<Field label="Image" hint={t("workflowSettings.sandbox.image.hint")}>
						<TextInput
							value={draft.image}
							mono
							placeholder="cockpit-agent:latest"
							onChange={(value) => setDraft((current) => ({ ...current, image: value }))}
							onBlur={() => void save()}
						/>
					</Field>
				</div>
			) : null}
			{draft.enabled ? (
				<div className="flex items-start gap-2 rounded-lg bg-raised px-3 py-2.5">
					<p className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-faint">
						<Trans
							t={t}
							i18nKey="workflowSettings.sandbox.loginNote"
							components={{ code: <code className="rounded bg-base px-1 py-0.5 text-[10.5px]" /> }}
						/>
					</p>
					<Button size="sm" icon={KeyRound} onClick={() => void connect()}>
						{t("workflowSettings.sandbox.connect")}
					</Button>
				</div>
			) : null}
		</div>
	);
}
