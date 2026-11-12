import clsx from "clsx";
import { AssistantSettings } from "@/components/Assistant";
import { VoiceSettings } from "@/components/NarrationToggle";
import { Check, ExternalLink, FolderOpen, KeyRound, Plus, Save } from "lucide-react";
import {
	useEffect,
	useMemo,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LANGUAGES } from "@/i18n";
import {
	Badge,
	Button,
	Dot,
	ErrorNote,
	Field,
	Section,
	TextInput,
	ViewHeader,
} from "@/components/ui";
import { useConfirm } from "@/components/Confirm";
import { RemoteAccess } from "@/components/RemoteAccess";
import { UpdateCheck } from "@/components/UpdateBanner";
import {
	ConnectorsSettings,
	EnginesSettings,
	RolesSettings,
	MissionBudgetSettings,
	MissionModeSettings,
	SandboxSettings,
	WorkflowSettings,
} from "@/components/WorkflowSettings";
import { AccountsSettings } from "@/components/AccountsSettings";
import { McpSettings } from "@/components/McpSettings";
import { BriefSettings } from "@/components/BriefSettings";
import { CommandsSettings } from "@/components/CommandsSettings";
import { ImpactSettings } from "@/components/ImpactSettings";
import { PermanenceSettings } from "@/components/PermanenceSettings";
import { ProjectGround } from "@/components/ProjectGround";
import { PropertiesSettings } from "@/components/PropertiesSettings";
import { api } from "@/lib/ipc";
import {
	applyTheme,
	readThemeChoice,
	saveThemeChoice,
	watchSystemTheme,
	type ThemeChoice,
} from "@/lib/theme";
import type { DeclaredSettings, Ground } from "@/lib/types";
import { usePersistentState, useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { RESUME_KEY, type ResumeMode } from "@/app/hibernate";
import { DOCK_KEY } from "@/components/WorkspacePanel";
import { platformContext } from "@/lib/platform";

/**
 * Les rubriques des réglages, dans l'ordre où l'on s'en sert.
 *
 * « Projets » d'abord : sans dépôt, rien d'autre ne s'applique à quoi que ce
 * soit. Le poste et la version ferment la liste — on n'y touche qu'une fois.
 */
const TABS = [
	{ id: "projects" },
	{ id: "services" },
	{ id: "team" },
	{ id: "agents" },
	{ id: "voice" },
	{ id: "permanence" },
	{ id: "workstation" },
	{ id: "mobile" },
	{ id: "version" },
] as const;

type SettingsTab = (typeof TABS)[number]["id"];

/** Clé de service → chemin du champ dans le TOML (snake_case côté Rust). */
const SECRET_PATHS: Record<string, [string, string]> = {
	github: ["github", "token"],
	linear: ["linear", "token"],
	gitlab: ["gitlab", "token"],
	trigger: ["trigger", "token"],
	railway: ["railway", "token"],
	betterstack: ["betterstack", "token"],
	stripe: ["stripe", "token"],
	// `SandboxConfig` sérialise en camelCase (`memoryMb`…), à la différence
	// des autres structs de secrets ci-dessus : le champ suit sa convention,
	// pas celle du reste de cette table.
	sandbox_oauth_token: ["sandbox", "oauthToken"],
};

/**
 * Liste des environnements Trigger.dev — un par secret key, puisqu'une clé ne
 * donne accès qu'à un couple projet + environnement. Chacun devient un onglet
 * dans l'écran Delivery.
 */
function TriggerEnvironments() {
	const { t } = useTranslation("views");
	const { config, reloadConfig, notify } = useCockpit();
	const { confirm } = useConfirm();
	const [draft, setDraft] = useState({ name: "", token: "", projectRef: "" });
	const [busy, setBusy] = useState(false);

	const environments = config?.triggerEnvironments ?? [];

	const save = async (name: string, token: string, projectRef: string) => {
		setBusy(true);
		try {
			await api.config.saveTriggerEnv(name, token, projectRef);
			setDraft({ name: "", token: "", projectRef: "" });
			reloadConfig();
			notify(t("settings.trigger.saved", { name }));
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (name: string) => {
		const ok = await confirm({
			title: t("settings.trigger.removeTitle", { name }),
			confirmLabel: t("settings.common.remove"),
			danger: true,
		});
		if (!ok) return;
		try {
			await api.config.removeTriggerEnv(name);
			reloadConfig();
			notify(t("settings.trigger.removed", { name }));
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<div className="panel flex flex-col divide-y divide-line-soft">
			{environments.map((environment) => (
				<div key={environment.name} className="flex items-center gap-2 p-2.5">
					<Dot tone="success" />
					<span className="w-32 shrink-0 truncate text-[11px] font-medium text-ink">
						{environment.name}
					</span>
					<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
						{environment.projectRef || t("settings.trigger.defaultProject")}
					</span>
					{environment.fromDefaultKey ? (
						<Badge>{t("settings.trigger.mainKey")}</Badge>
					) : (
						<Button size="sm" onClick={() => void remove(environment.name)}>
							{t("settings.common.remove")}
						</Button>
					)}
				</div>
			))}

			<div className="flex items-end gap-2 p-2.5">
				<Field label={t("settings.common.name")}>
					<TextInput
						value={draft.name}
						onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
						placeholder={t("settings.trigger.namePlaceholder")}
					/>
				</Field>
				<Field label={t("settings.trigger.secretKey")}>
					<TextInput
						type="password"
						value={draft.token}
						onChange={(value) => setDraft((current) => ({ ...current, token: value }))}
						placeholder="tr_prod_…"
						mono
					/>
				</Field>
				<Field label={t("settings.trigger.project")} hint={t("settings.trigger.projectHint")}>
					<TextInput
						value={draft.projectRef}
						onChange={(value) => setDraft((current) => ({ ...current, projectRef: value }))}
						placeholder="proj_…"
						mono
					/>
				</Field>
				<Button
					variant="solid"
					icon={Plus}
					disabled={busy || !draft.name.trim() || !draft.token.trim()}
					onClick={() => void save(draft.name, draft.token, draft.projectRef)}
				>
					{t("settings.common.add")}
				</Button>
			</div>
		</div>
	);
}

/**
 * Projets pilotés par le cockpit.
 *
 * Chaque champ laissé vide hérite des réglages globaux plus bas : déclarer un
 * side project ne demande donc que son dépôt. C'est ce qui permet au cockpit de
 * servir autant un monorepo d'entreprise qu'un dépôt personnel sans Linear
 * derrière.
 */
function Projects() {
	const { t } = useTranslation("views");
	const { config, reloadConfig, notify, activeProject, switchProject } = useCockpit();
	const { confirm } = useConfirm();
	const [draft, setDraft] = useState({
		name: "",
		mainRepo: "",
		githubRepo: "",
	});
	const [busy, setBusy] = useState(false);
	// Ce que le cockpit trouve à l'emplacement saisi : c'est lui qui décide si
	// « Ajouter » peut aboutir, plutôt qu'un refus après coup.
	const [ground, setGround] = useState<Ground | null>(null);

	const projects = config?.projects ?? [];

	const add = async () => {
		setBusy(true);
		try {
			await api.config.saveProject({
				id: "",
				name: draft.name,
				color: "",
				main_repo: draft.mainRepo,
				// Le dépôt déduit du serveur quand on ne l'a pas saisi : il est
				// déjà sous les yeux dans le bloc de préparation, le retaper
				// n'ajoute qu'une occasion de se tromper.
				github: { repo: draft.githubRepo || ground?.slug || "", token: "" },
			});
			setDraft({ name: "", mainRepo: "", githubRepo: "" });
			reloadConfig();
			notify(t("settings.projects.added", { name: draft.name || draft.mainRepo }));
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string, name: string) => {
		const ok = await confirm({
			title: t("settings.projects.removeTitle", { name }),
			message: t("settings.projects.removeMessage"),
			confirmLabel: t("settings.common.remove"),
			danger: true,
		});
		if (!ok) return;
		try {
			await api.config.removeProject(id);
			reloadConfig();
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<div className="panel flex flex-col divide-y divide-line-soft">
			{projects.map((project) => (
				<div key={project.id} className="flex items-center gap-2 p-2.5">
					<Dot tone={project.id === activeProject?.id ? "success" : "neutral"} />
					<button
						type="button"
						onClick={() => switchProject(project.id)}
						className="focus-ring min-w-0 flex-1 rounded text-left"
						title={t("settings.projects.activate")}
					>
						<span className="block truncate text-[11px] font-medium text-ink">
							{project.name}
						</span>
						<span className="block truncate font-mono text-[10px] text-ink-faint">
							{project.mainRepo}
						</span>
					</button>
					{project.githubRepo ? <Badge>{project.githubRepo}</Badge> : null}
					{projects.length > 1 ? (
						<Button size="sm" onClick={() => void remove(project.id, project.name)}>
							{t("settings.common.remove")}
						</Button>
					) : null}
				</div>
			))}

			{/* Le formulaire n'est pas un projet de plus : sans ce fond ni ce titre,
			    ses trois champs se lisaient comme la suite de la dernière ligne, et
			    « Nom » semblait renommer le projet du dessus. */}
			<div className="flex flex-col gap-2 bg-void/40 p-2.5">
			<div className="flex items-end gap-2">
				<span className="mb-1.5 shrink-0 text-[10px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
					{t("settings.projects.new")}
				</span>
				<Field label={t("settings.common.name")}>
					<TextInput
						value={draft.name}
						onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
						placeholder={t("settings.projects.namePlaceholder")}
					/>
				</Field>
				<Field
					label={t("settings.projects.folder")}
					hint={t("settings.projects.folderHint")}
				>
					<TextInput
						value={draft.mainRepo}
						onChange={(value) => setDraft((current) => ({ ...current, mainRepo: value }))}
						placeholder={t("settings.projects.folderPlaceholder")}
						mono
					/>
				</Field>
				<Field label="GitHub" hint={t("settings.projects.githubHint")}>
					<TextInput
						value={draft.githubRepo}
						onChange={(value) => setDraft((current) => ({ ...current, githubRepo: value }))}
						placeholder={ground?.slug || t("settings.projects.githubPlaceholder")}
						mono
					/>
				</Field>
				<Button
					variant="solid"
					icon={Plus}
					// Un dossier qui n'est pas encore un dépôt ne peut pas devenir un
					// projet : plutôt que de refuser au clic, on le dit avant.
					disabled={busy || !draft.mainRepo.trim() || ground?.isRepo === false}
					title={
						ground?.isRepo === false
							? t("settings.projects.prepareFirst")
							: undefined
					}
					onClick={() => void add()}
				>
					{t("settings.common.add")}
				</Button>
			</div>

				{/* Ce qu'il faut préparer avant que ce dossier devienne un projet.
				    Il ne s'affiche que quand un chemin est saisi, et il dit ce que
				    le cockpit a compris de ce chemin — c'est là que se voit qu'un
				    « ~ » a été développé. */}
				{draft.mainRepo.trim() ? (
					<ProjectGround
						path={draft.mainRepo}
						suggestedName={draft.name}
						onReady={setGround}
					/>
				) : null}
			</div>
		</div>
	);
}

/** Les champs du fichier de configuration que l'écran édite. */
type SettingsDraft = {
	projectsRoot: string;
	mainRepo: string;
	editor: string;
	githubRepo: string;
	linearTeamKey: string;
	linearTeamId: string;
	triggerProjectRef: string;
	railwayProjectId: string;
	gitlabProject: string;
	gitlabHost: string;
};

type SetDraft = Dispatch<SetStateAction<SettingsDraft>>;
type SettingsScope = "project" | "global";

/**
 * La rubrique affichée.
 *
 * L'écran était une seule page : douze sections à la file, où l'on cherchait
 * l'équipe en passant devant les jetons d'accès. Le découpage suit ce qu'on
 * vient y faire — brancher un service, décrire une équipe, régler son poste —
 * et non l'ordre dans lequel ces réglages sont apparus.
 *
 * Retenue d'une fois sur l'autre : on revient dans les réglages pour finir ce
 * qu'on y faisait.
 */
function useSettingsTab() {
	const { focus, clearFocus } = useCockpit();
	const [tab, setTab] = usePersistentState<SettingsTab>("settings.tab", "projects");

	// En aperçu, la rubrique se demande par l'adresse : c'est ce qui permet de
	// regarder un réglage avant de le livrer, sans avoir à cliquer jusqu'à lui.
	// Hors aperçu, l'adresse ne porte rien et la rubrique retenue l'emporte.
	useEffect(() => {
		const wanted = new URLSearchParams(window.location.search).get("tab");
		if (wanted && TABS.some((entry) => entry.id === wanted)) {
			setTab(wanted as SettingsTab);
		}
		// Au montage seulement : ensuite, c'est le clic qui décide.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Un écran peut demander sa rubrique — la Permanence renvoie ici depuis son
	// engrenage, et atterrir sur « Projets » ferait chercher.
	useEffect(() => {
		const wanted = focus.settingsTab;
		if (wanted && TABS.some((entry) => entry.id === wanted)) {
			setTab(wanted as SettingsTab);
			clearFocus();
		}
	}, [focus.settingsTab, clearFocus, setTab]);

	return [tab, setTab] as const;
}

/**
 * Le formulaire du fichier de configuration : les champs déclarés dans la
 * portée choisie, les secrets collés, et leur enregistrement.
 */
function useSettingsForm(scope: SettingsScope) {
	const { t } = useTranslation("views");
	const { config, reloadConfig, notify } = useCockpit();
	const [draft, setDraft] = useState<SettingsDraft>({
		projectsRoot: "",
		mainRepo: "",
		editor: "zed",
		githubRepo: "",
		linearTeamKey: "",
		linearTeamId: "",
		triggerProjectRef: "",
		railwayProjectId: "",
		gitlabProject: "",
		gitlabHost: "",
	});
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);

	// Ce qu'on édite est ce que la portée choisie déclare — jamais la fusion des
	// deux. Le formulaire se remplissait des valeurs résolues : sur un second
	// projet il affichait celles du premier, et les enregistrer les y recopiait
	// en dur. Un champ vide veut dire « pas déclaré ici », et se lit comme tel.
	const declared = useMemo<DeclaredSettings | null>(() => {
		if (!config) return null;
		if (scope === "global") return config.global;
		return (
			config.projects.find((project) => project.id === config.activeProject)?.declared ?? null
		);
	}, [config, scope]);

	useEffect(() => {
		if (!declared) return;
		setDraft({
			projectsRoot: declared.projectsRoot,
			mainRepo: declared.mainRepo,
			editor: declared.editor,
			githubRepo: declared.githubRepo,
			linearTeamKey: declared.linearTeamKey,
			linearTeamId: declared.linearTeamId,
			triggerProjectRef: declared.triggerProjectRef,
			railwayProjectId: declared.railwayProjectId,
			gitlabProject: declared.gitlabProject,
			gitlabHost: declared.gitlabHost,
		});
	}, [declared]);

	const save = async () => {
		setSaving(true);
		const patch: Record<string, unknown> = {
			general: {
				projects_root: draft.projectsRoot,
				main_repo: draft.mainRepo,
				editor: draft.editor,
			},
			github: { repo: draft.githubRepo },
			linear: { team_key: draft.linearTeamKey, team_id: draft.linearTeamId },
			gitlab: { project: draft.gitlabProject, host: draft.gitlabHost },
			trigger: { project_ref: draft.triggerProjectRef },
			railway: { project_id: draft.railwayProjectId },
		};

		// Un champ secret vide veut dire « ne touche pas » : on n'écrase jamais
		// un token existant par erreur.
		//
		// `sandbox` part toujours en global, quelle que soit la portée choisie
		// à l'écran : l'isolation est un réglage de poste, jamais de projet, et
		// `project_update` n'a nulle part où le ranger — un jeton collé en
		// portée « projet » (la valeur de départ de ce sélecteur) se faisait
		// silencieusement jeter, vérifié sur la config réécrite sans lui.
		const globalOnly: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(secrets)) {
			if (!value.trim()) continue;
			const [section, field] = SECRET_PATHS[key];
			const bucket = section === "sandbox" ? globalOnly : patch;
			bucket[section] = { ...(bucket[section] as object), [field]: value.trim() };
		}

		try {
			// Le projet et le global partagent la forme du patch : mêmes noms de
			// sections de part et d'autre.
			await (scope === "project"
				? api.config.updateProject(patch)
				: api.config.update(patch));
			if (Object.keys(globalOnly).length > 0) {
				await api.config.update(globalOnly);
			}
			setSecrets({});
			reloadConfig();
			notify(t("settings.saved"));
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	return { draft, setDraft, secrets, setSecrets, saving, save };
}

export function SettingsView() {
	const { t } = useTranslation("views");
	const { config, configError, reloadConfig } = useCockpit();
	/**
	 * Où va l'enregistrement.
	 *
	 * « Projet » écrit dans le projet actif, « Défauts » dans les valeurs
	 * partagées dont héritent les projets qui ne disent rien. Sans ce choix, le
	 * multi-projets se réduirait à changer de dépôt : deux projets sur des
	 * comptes GitHub différents seraient impossibles.
	 */
	const [scope, setScope] = useState<SettingsScope>("project");
	const [tab, setTab] = useSettingsTab();
	const { draft, setDraft, secrets, setSecrets, saving, save } = useSettingsForm(scope);

	// Les rubriques qui écrivent dans le fichier de configuration : la portée et
	// le bouton « Enregistrer » ne concernent qu'elles. Ailleurs, chaque panneau a
	// son propre bouton — l'en-tête en montrait un qui n'enregistrait pas ce qu'on
	// venait de modifier.
	const declaresConfig = tab === "services" || tab === "workstation";
	const scoped = declaresConfig || tab === "team" || tab === "agents";

	return (
		<>
			<ViewHeader
				title={t("settings.title")}
				subtitle={config?.configPath}
				actions={
					<>
						<Button
							icon={FolderOpen}
							onClick={() => {
								if (config?.configPath) {
									void api.system.reveal(config.configPath).catch(() => undefined);
								}
							}}
						>
							{t("settings.revealFile")}
						</Button>
						{/* Ce bouton n'écrit que les champs du fichier de configuration :
						    l'afficher sur une rubrique dont les panneaux ont leur propre
						    bouton laissait croire qu'il enregistrait leur contenu. */}
						{declaresConfig ? (
							<Button
								variant="solid"
								icon={Save}
								disabled={saving}
								onClick={() => void save()}
							>
								{saving ? t("settings.saving") : t("settings.save")}
							</Button>
						) : null}
					</>
				}
			/>

			{configError ? <ErrorNote error={configError} onRetry={reloadConfig} /> : null}

			<div className="flex min-h-0 flex-1">
				<SettingsNav tab={tab} onSelect={setTab} />

				<div className="min-h-0 flex-1 overflow-y-auto p-5">
				<div className="flex max-w-3xl flex-col gap-6">
					{tab === "projects" ? (
						<Section title={t("settings.sections.projects")}>
							<Projects />
						</Section>
					) : null}

					{/* La portée décide de tout ce qui suit : elle doit se lire avant
					    de toucher au moindre champ, pas se deviner dans un coin. */}
					{scoped ? <ScopePicker scope={scope} onChange={setScope} /> : null}

					{tab === "services" ? (
						<Section title={t("settings.sections.services")}>
							<ConnectorsSettings />
						</Section>
					) : null}

					{tab === "team" ? <TeamTab /> : null}

					{tab === "agents" ? <AgentsTab /> : null}

					{/* La Permanence a sa propre rubrique : ce n'est pas un agent qu'on
					    lance mais un service qui tourne, et la seule chose du cockpit
					    qui agisse sans qu'on la regarde partir. */}
					{tab === "permanence" ? <PermanenceSettings /> : null}

					{/* Un réglage de poste : la clé ElevenLabs est dans le trousseau du
					    Mac, pas dans la configuration d'un projet. */}
					{tab === "voice" ? <VoiceTab /> : null}

					{tab === "mobile" ? (
						<Section title={t("settings.sections.mobile")}>
							<RemoteAccess />
						</Section>
					) : null}

					{tab === "version" ? <VersionTab /> : null}

					{tab === "workstation" ? <WorkstationTab draft={draft} setDraft={setDraft} /> : null}

					{tab === "services" ? (
						<ServicesTab
							draft={draft}
							setDraft={setDraft}
							secrets={secrets}
							setSecrets={setSecrets}
							scope={scope}
						/>
					) : null}

					{declaresConfig ? (
						<div className="flex justify-end pb-6">
							<Button
								variant="solid"
								icon={Check}
								disabled={saving}
								onClick={() => void save()}
							>
								{t("settings.saveConfig")}
							</Button>
						</div>
					) : null}
				</div>
				</div>
			</div>
		</>
	);
}

/** Le menu des rubriques, à gauche de l'écran. */
function SettingsNav({
	tab,
	onSelect,
}: {
	tab: SettingsTab;
	onSelect: (tab: SettingsTab) => void;
}) {
	const { t } = useTranslation("views");
	return (
		// Le menu tient dans une colonne fixe : ces libellés ne changent pas, et
		// une largeur qui suit le texte ferait danser le contenu d'une rubrique à
		// l'autre.
		<nav className="hairline-r flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto p-2.5">
			{TABS.map((entry) => (
				<button
					key={entry.id}
					type="button"
					onClick={() => onSelect(entry.id)}
					title={t(`settings.tabs.${entry.id}.hint`)}
					className={clsx(
						"focus-ring rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
						tab === entry.id
							? "bg-accent-dim font-medium text-accent-soft"
							: "text-ink-muted hover:bg-hover hover:text-ink",
					)}
				>
					{t(`settings.tabs.${entry.id}.label`)}
				</button>
			))}
		</nav>
	);
}

/** Le choix de la portée : le projet actif, ou les valeurs partagées. */
function ScopePicker({
	scope,
	onChange,
}: {
	scope: SettingsScope;
	onChange: (scope: SettingsScope) => void;
}) {
	const { t } = useTranslation("views");
	const { config, activeProject } = useCockpit();
	// Dès qu'un second projet existe, les cibles ne s'héritent plus : ce que
	// l'écran dit doit suivre ce que le backend fait.
	const cloisonne = (config?.projects.length ?? 0) > 1;
	return (
		<div
			className={clsx(
				"flex items-center gap-3 rounded-xl border p-3",
				scope === "project"
					? "border-accent/30 bg-accent/[0.06]"
					: "border-line-soft bg-surface/40",
			)}
		>
			<div className="min-w-0 flex-1">
				<p className="text-[12.5px] font-medium text-ink">
					{scope === "project"
						? t("settings.scope.projectTitle", {
								name: activeProject?.name ?? t("settings.scope.thisProject"),
							})
						: t("settings.scope.globalTitle")}
				</p>
				<p className="mt-0.5 text-[10px] leading-snug text-ink-faint">
					{scope === "project"
						? cloisonne
							? t("settings.scope.projectHintIsolated")
							: t("settings.scope.projectHint")
						: cloisonne
							? t("settings.scope.globalHintIsolated")
							: t("settings.scope.globalHint")}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1 rounded-lg border border-line-soft p-0.5">
				<Button size="sm" active={scope === "project"} onClick={() => onChange("project")}>
					{activeProject?.name ?? t("settings.scope.project")}
				</Button>
				<Button size="sm" active={scope === "global"} onClick={() => onChange("global")}>
					{t("settings.scope.defaults")}
				</Button>
			</div>
		</div>
	);
}

/** La rubrique « Équipe » : comment ce projet travaille, et avec qui. */
function TeamTab() {
	const { t } = useTranslation("views");
	return (
		<>
			<Section title={t("settings.sections.workflow")}>
				<WorkflowSettings />
			</Section>
		</>
	);
}

/** La rubrique « Agents » : sous quelle identité, avec quoi, et dans quelles limites. */
function AgentsTab() {
	const { t } = useTranslation("views");
	return (
		<>
			{/* Les comptes en tête : c'est sous eux que tout le reste tourne,
			    et un moteur réglé au détail près sur la mauvaise identité ne
			    sert à rien. */}
			<Section title={t("settings.sections.accounts")}>
				<AccountsSettings />
			</Section>

			{/* Les moteurs avant les rôles : un rôle choisit son moteur, et
			    on ne choisit pas dans une liste qu'on n'a pas encore
			    remplie. */}
			<Section title={t("settings.sections.engines")}>
				<EnginesSettings />
			</Section>

			{/* Juste après les moteurs : un rôle choisit son moteur, ses
			    outils viennent du dépôt. Les deux décident de ce qu'un agent
			    peut faire, et l'un sans l'autre ne dit rien. */}
			<Section title={t("settings.sections.mcp")}>
				<McpSettings />
			</Section>

			<Section title={t("settings.sections.roles")}>
				<RolesSettings />
			</Section>

			<Section title={t("settings.sections.missionMode")}>
				<MissionModeSettings />
			</Section>

			{/* Ce qu'une mission a le droit de coûter, juste après les rôles
			    qui la peuplent : c'est le même sujet vu par la dépense. */}
			<Section title={t("settings.sections.missionBudget")}>
				<MissionBudgetSettings />
			</Section>

			{/* Juste après la dépense : la même question posée à la
			    machine plutôt qu'au portefeuille. */}
			<Section title={t("settings.sections.sandbox")}>
				<SandboxSettings />
			</Section>

			{/* Ce qui doit rester vrai vient en premier : c'est la seule
			    chose de cet onglet qu'une machine puisse vérifier, et le
			    reste — contexte, rôles, lectures — sert à s'en approcher. */}
			<Section title={t("settings.sections.properties")}>
				<PropertiesSettings />
			</Section>

			{/* Les commandes du dépôt : ce que le cockpit sait lancer en
			    ton nom, à côté de ce qu'il sait vérifier. */}
			<Section title={t("settings.sections.commands")}>
				<CommandsSettings />
			</Section>

			{/* Ce qu'un agent sait avant de commencer se règle au même
			    endroit que ce qu'il a le droit de faire : les deux décident
			    de ce qu'il produira. */}
			<Section title={t("settings.sections.brief")}>
				<BriefSettings />
			</Section>

			{/* La lecture des changements est un agent comme les autres :
			    elle a son moteur et sa profondeur, et se règle donc ici
			    plutôt que dans un coin de l'écran qui l'utilise. */}
			<Section title={t("settings.sections.impact")}>
				<ImpactSettings />
			</Section>
		</>
	);
}

/** La rubrique « Voix et assistant ». */
function VoiceTab() {
	const { t } = useTranslation("views");
	return (
		<>
			<Section title={t("settings.sections.voice")}>
				<p className="mb-3 max-w-xl text-[12px] leading-relaxed text-ink-muted">
					{t("settings.voice.intro")}
				</p>
				<VoiceSettings />
			</Section>
			<Section title={t("settings.sections.assistant")}>
				<AssistantSettings />
			</Section>
		</>
	);
}

/** La rubrique « Version » : la vérification des mises à jour. */
function VersionTab() {
	const { t } = useTranslation("views");
	return (
		<Section title={t("settings.sections.version")}>
			{/* Le texte cède avant le bouton : à cette largeur, une phrase qui
			    ne se replie pas pousse l'action hors du cadre. */}
			<div className="panel flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5 p-3.5">
				<p className="min-w-[16rem] flex-1 text-[11px] leading-relaxed text-ink-muted">
					{t("settings.version.intro")}
				</p>
				<UpdateCheck />
			</div>
		</Section>
	);
}

/** La rubrique « Poste » : langue, apparence, démarrage, dossiers et éditeur. */
function WorkstationTab({ draft, setDraft }: { draft: SettingsDraft; setDraft: SetDraft }) {
	const { t } = useTranslation("views");
	return (
		<>
			<Section title={t("settings.sections.language")}>
				<LanguageSetting />
			</Section>

			<Section title={t("settings.sections.appearance")}>
				<ThemeSetting />
			</Section>

			<Section title={t("settings.sections.onClose")}>
				<RelaySetting />
			</Section>

			<Section title={t("settings.sections.onStart")}>
				<ResumeSetting />
			</Section>

			<Section title={t("settings.sections.dock")}>
				<DockSetting />
			</Section>

			<Section title={t("settings.sections.workstation")}>
				<div className="panel grid grid-cols-2 gap-3 p-3.5">
					<Field
						label={t("settings.workstation.projectsRoot")}
						hint={t("settings.workstation.projectsRootHint")}
					>
						<TextInput
							value={draft.projectsRoot}
							onChange={(value) =>
								setDraft((current) => ({ ...current, projectsRoot: value }))
							}
							mono
						/>
					</Field>
					<Field
						label={t("settings.workstation.mainRepo")}
						hint={t("settings.workstation.mainRepoHint")}
					>
						<TextInput
							value={draft.mainRepo}
							onChange={(value) =>
								setDraft((current) => ({ ...current, mainRepo: value }))
							}
							mono
						/>
					</Field>
					<Field label={t("settings.workstation.editor")} hint="zed · cursor · code">
						<TextInput
							value={draft.editor}
							onChange={(value) =>
								setDraft((current) => ({ ...current, editor: value }))
							}
							mono
						/>
					</Field>
				</div>
			</Section>
		</>
	);
}

/** La rubrique « Services » : identifiants, environnements, secrets et liens. */
function ServicesTab({
	draft,
	setDraft,
	secrets,
	setSecrets,
	scope,
}: {
	draft: SettingsDraft;
	setDraft: SetDraft;
	secrets: Record<string, string>;
	setSecrets: Dispatch<SetStateAction<Record<string, string>>>;
	scope: SettingsScope;
}) {
	const { t } = useTranslation("views");
	return (
		<>
			<ServiceIdentifiers draft={draft} setDraft={setDraft} />

			<Section title={t("settings.sections.triggerEnvironments")}>
				<TriggerEnvironments />
				<p className="mt-1.5 px-1 text-[10px] leading-relaxed text-ink-faint">
					{t("settings.trigger.help")}
				</p>
			</Section>

			<ServiceSecrets secrets={secrets} setSecrets={setSecrets} scope={scope} />

			<ServiceLinks />
		</>
	);
}

/** Les identifiants des services : dépôt, organisation, projets, clé de ticket. */
function ServiceIdentifiers({ draft, setDraft }: { draft: SettingsDraft; setDraft: SetDraft }) {
	const { t } = useTranslation("views");
	return (
		<Section title={t("settings.sections.identifiers")}>
			<div className="panel grid grid-cols-2 gap-3 p-3.5">
				<Field label={t("settings.services.githubRepo")} hint="owner/repo">
					<TextInput
						value={draft.githubRepo}
						onChange={(value) =>
							setDraft((current) => ({ ...current, githubRepo: value }))
						}
						placeholder="northwind/storefront"
						mono
					/>
				</Field>
				{/* La clé sert à lire un numéro de ticket (ABC-3044) ; l'UUID, à
				    demander à Linear les états, membres et labels de l'équipe.
				    Deux réglages distincts, côte à côte pour qu'on ne prenne pas
				    l'un pour l'autre. */}
				<Field
					label={t("settings.services.ticketKey")}
					hint={t("settings.services.ticketKeyHint")}
				>
					<TextInput
						value={draft.linearTeamKey}
						onChange={(value) =>
							setDraft((current) => ({ ...current, linearTeamKey: value }))
						}
						mono
					/>
				</Field>
				<Field
					label={t("settings.services.linearTeamId")}
					hint={t("settings.services.linearTeamIdHint")}
				>
					<TextInput
						value={draft.linearTeamId}
						onChange={(value) =>
							setDraft((current) => ({ ...current, linearTeamId: value }))
						}
						placeholder="11111111-1111-1111-1111-111111111111"
						mono
					/>
				</Field>
				{/* Le suivi de tâches se déduit de ce qui est renseigné : Linear
				    s'il a un jeton, sinon GitLab si son projet est là, sinon les
				    issues du dépôt GitHub. Un réglage de plus pour le redire
				    serait un réglage de plus à oublier de changer. */}
				<Field
					label={t("settings.services.gitlabProject")}
					hint={t("settings.services.gitlabProjectHint")}
				>
					<TextInput
						value={draft.gitlabProject}
						onChange={(value) =>
							setDraft((current) => ({ ...current, gitlabProject: value }))
						}
						placeholder={t("settings.services.gitlabProjectPlaceholder")}
						mono
					/>
				</Field>
				<Field
					label={t("settings.services.gitlabHost")}
					hint={t("settings.services.gitlabHostHint")}
				>
					<TextInput
						value={draft.gitlabHost}
						onChange={(value) =>
							setDraft((current) => ({ ...current, gitlabHost: value }))
						}
						placeholder={t("settings.services.gitlabHostPlaceholder")}
						mono
					/>
				</Field>
				<Field label={t("settings.services.triggerProject")}>
					<TextInput
						value={draft.triggerProjectRef}
						onChange={(value) =>
							setDraft((current) => ({ ...current, triggerProjectRef: value }))
						}
						placeholder="proj_…"
						mono
					/>
				</Field>
				<Field label={t("settings.services.railwayProject")}>
					<TextInput
						value={draft.railwayProjectId}
						onChange={(value) =>
							setDraft((current) => ({ ...current, railwayProjectId: value }))
						}
						mono
					/>
				</Field>
			</div>
		</Section>
	);
}

/** Les jetons d'accès : un champ par service, vide tant qu'on n'y colle rien. */
function ServiceSecrets({
	secrets,
	setSecrets,
	scope,
}: {
	secrets: Record<string, string>;
	setSecrets: Dispatch<SetStateAction<Record<string, string>>>;
	scope: SettingsScope;
}) {
	const { t } = useTranslation("views");
	const { config, activeProject } = useCockpit();
	return (
		<Section title={t("settings.sections.secrets")}>
			<div className="panel flex flex-col divide-y divide-line-soft">
				{config?.secrets.map((secret) => (
					<div key={secret.key} className="flex items-start gap-3 p-3.5">
						<div className="w-32 shrink-0">
							<div className="flex items-center gap-1.5">
								<Dot tone={secret.configured ? "success" : "neutral"} />
								<span className="text-[12.5px] font-medium text-ink">
									{secret.label}
								</span>
							</div>
							{/* Distinguer « défini ici » de « hérité » : un champ vide
							    ne dit pas la même chose dans les deux cas. */}
							{scope === "project" &&
							activeProject?.overrides.includes(secret.key) ? (
								<Badge tone="accent">{t("settings.secrets.override")}</Badge>
							) : secret.configured ? (
								<Badge tone="success">
									{scope === "project"
										? t("settings.secrets.inherited")
										: t("settings.secrets.configured")}
								</Badge>
							) : (
								<Badge tone="neutral">{t("settings.secrets.missing")}</Badge>
							)}
						</div>
						<div className="min-w-0 flex-1">
							<TextInput
								type="password"
								value={secrets[secret.key] ?? ""}
								onChange={(value) =>
									setSecrets((current) => ({ ...current, [secret.key]: value }))
								}
								placeholder={
									secret.configured
										? t("settings.secrets.keepPlaceholder")
										: t("settings.secrets.pastePlaceholder")
								}
								mono
							/>
							<p className="mt-1 text-[10px] leading-snug text-ink-faint">
								{secret.hint}
							</p>
						</div>
					</div>
				))}
			</div>
			<p className="mt-2 flex items-start gap-2 px-1 text-[10px] leading-relaxed text-ink-faint">
				<KeyRound size={11} className="mt-0.5 shrink-0" />
				{t("settings.secrets.storage", { path: config?.configPath ?? "" })}
			</p>
		</Section>
	);
}

/** Où créer les jetons de chaque service. */
function ServiceLinks() {
	const { t } = useTranslation("views");
	return (
		<Section title={t("settings.sections.links")}>
			<div className="panel flex flex-col gap-2 p-3.5 text-[11px] text-ink-muted">
				{[
					["Linear", "https://linear.app/settings/api"],
					["GitLab", "https://gitlab.com/-/user_settings/personal_access_tokens"],
					["Trigger.dev", "https://cloud.trigger.dev"],
					["Railway", "https://railway.app/account/tokens"],
					["Better Stack", "https://uptime.betterstack.com/team/api-tokens"],
					["Stripe", "https://dashboard.stripe.com/apikeys"],
				].map(([label, url]) => (
					<button
						key={label}
						type="button"
						onClick={() => {
							void api.system.openUrl(url).catch(() => undefined);
						}}
						className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-surface"
					>
						<ExternalLink size={11} className="text-ink-faint" />
						<span className="w-24 shrink-0">{label}</span>
						<span className="truncate font-mono text-[10px] text-ink-faint">
							{url}
						</span>
					</button>
				))}
			</div>
		</Section>
	);
}

/**
 * Sombre, clair, ou ce que dit le système.
 *
 * Trois boutons plutôt qu'un interrupteur : « système » n'est pas un état
 * intermédiaire entre les deux autres, c'est une délégation — et un interrupteur
 * à deux positions ne saurait pas la représenter.
 *
 * Le choix s'applique immédiatement, sans passer par « Enregistrer » : on juge
 * un thème en le voyant, et l'attente d'une confirmation pour découvrir le
 * résultat est exactement ce qui rend un réglage d'apparence pénible.
 */
function ThemeSetting() {
	const { t } = useTranslation("views");
	const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice());

	// « Système » reste vivant : la bascule du soir de macOS doit suivre, sinon
	// le réglage ne veut dire ce qu'il annonce qu'au moment où on le choisit.
	useEffect(() => {
		if (choice !== "system") return;
		return watchSystemTheme(() => applyTheme("system"));
	}, [choice]);

	const options: Array<{ value: ThemeChoice; label: string; hint: string }> = [
		{ value: "dark", label: t("settings.theme.dark"), hint: t("settings.theme.darkHint") },
		{ value: "light", label: t("settings.theme.light"), hint: t("settings.theme.lightHint") },
		{ value: "system", label: t("settings.theme.system"), hint: t("settings.theme.systemHint", { context: platformContext }) },
	];

	return (
		<div className="panel flex flex-col gap-2.5 p-3.5">
			<div className="flex flex-wrap gap-1.5">
				{options.map((option) => (
					<Button
						key={option.value}
						size="sm"
						active={choice === option.value}
						onClick={() => {
							setChoice(option.value);
							saveThemeChoice(option.value);
						}}
						title={option.hint}
					>
						{option.label}
					</Button>
				))}
			</div>
			<p className="text-[10px] leading-relaxed text-ink-faint">
				{t("settings.theme.help")}
			</p>
		</div>
	);
}

/**
 * La langue de l'interface, et celle dans laquelle les agents répondent.
 *
 * Réglée côté Rust : les messages qu'il produit et les prompts des agents la
 * suivent aussi. Le changement recharge la fenêtre — des textes calculés hors
 * des composants ne se retraduiraient pas autrement.
 */
function LanguageSetting() {
	const { t } = useTranslation("common");
	const current = useAsync(() => api.language.get(), []);
	const [saving, setSaving] = useState(false);
	const choice = current.data?.choice ?? "";

	const choose = async (next: string) => {
		setSaving(true);
		try {
			await api.language.set(next);
			window.location.reload();
		} catch (error) {
			setSaving(false);
			toast.error(String(error));
		}
	};

	return (
		<div className="panel flex flex-col gap-2.5 p-3.5">
			<select
				className="focus-ring w-64 rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
				value={choice}
				disabled={saving || current.loading}
				onChange={(event) => void choose(event.target.value)}
			>
				<option value="">{t("language.system")}</option>
				{LANGUAGES.map((language) => (
					<option key={language.code} value={language.code}>
						{language.label}
					</option>
				))}
			</select>
			<p className="text-[10px] leading-relaxed text-ink-faint">{t("language.hint")}</p>
		</div>
	);
}

/**
 * Les agents de workspace survivent-ils à la fermeture du cockpit ?
 *
 * Un réglage du poste, pas du projet : c'est la machine qui garde des
 * processus vivants. Il vaut pour les agents lancés ensuite — un agent déjà
 * parti garde la façon dont il a été lancé, et l'écran le dit.
 */
function RelaySetting() {
	const { t } = useTranslation("views");
	const setting = useAsync(() => api.agents.relaySetting(), []);
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const value = enabled ?? setting.data?.enabled ?? true;

	const choose = (next: boolean) => {
		setEnabled(next);
		void api.agents.saveRelaySetting({ enabled: next }).catch(() => setEnabled(!next));
	};

	return (
		<div className="panel flex flex-col gap-2.5 p-3.5">
			<div className="flex flex-wrap gap-1.5">
				<Button size="sm" active={value} onClick={() => choose(true)}>
					{t("settings.relay.continue")}
				</Button>
				<Button size="sm" active={!value} onClick={() => choose(false)}>
					{t("settings.relay.stop")}
				</Button>
			</div>
			<p className="text-[10px] leading-relaxed text-ink-faint">
				{value
					? t("settings.relay.continueHelp")
					: t("settings.relay.stopHelp")}{" "}
				{t("settings.relay.note")}
			</p>
		</div>
	);
}

/**
 * Ce que le cockpit fait, au lancement, de ce qui tournait la veille.
 *
 * Les agents et les shells sont ses processus enfants : ils meurent avec lui, et
 * ce qu'il garde n'est qu'une empreinte — le worktree, la session de chaque
 * conversation, le nom de chaque terminal. Reprendre, c'est donc les recréer, et
 * cela coûte : autant de processus lancés d'un coup. D'où le réglage, plutôt
 * qu'un comportement imposé.
 *
 * Le choix vaut pour le lancement suivant : le changer maintenant ne rouvre rien
 * — l'écran le dit, sans quoi on cliquerait en attendant qu'il se passe quelque
 * chose.
 */
function ResumeSetting() {
	const { t } = useTranslation("views");
	const [mode, setMode] = usePersistentState<ResumeMode>(RESUME_KEY, "resume");

	const options: Array<{ value: ResumeMode; label: string; hint: string }> = [
		{
			value: "resume",
			label: t("settings.resume.resume"),
			hint: t("settings.resume.resumeHint"),
		},
		{
			value: "reopen",
			label: t("settings.resume.reopen"),
			hint: t("settings.resume.reopenHint"),
		},
		{
			value: "off",
			label: t("settings.resume.off"),
			hint: t("settings.resume.offHint"),
		},
	];

	return (
		<div className="panel flex flex-col gap-2.5 p-3.5">
			<div className="flex flex-wrap gap-1.5">
				{options.map((option) => (
					<Button
						key={option.value}
						size="sm"
						active={mode === option.value}
						onClick={() => setMode(option.value)}
						title={option.hint}
					>
						{option.label}
					</Button>
				))}
			</div>
			<p className="text-[10px] leading-relaxed text-ink-faint">
				{mode === "resume"
					? t("settings.resume.resumeHelp")
					: mode === "reopen"
						? t("settings.resume.reopenHelp")
						: t("settings.resume.offHelp")}{" "}
				{t("settings.resume.note")}
			</p>
		</div>
	);
}

/**
 * Le rappel des workspaces, en bas à droite des écrans qui ne les montrent pas.
 *
 * Il existe pour une raison sérieuse — sans lui, des agents et des serveurs de
 * dev tournent sans que rien ne le signale — mais tout le monde n'en a pas
 * besoin : qui repasse de toute façon par l'écran Workspaces n'y voit qu'un
 * encombrement. Les deux façons de travailler sont légitimes.
 */
function DockSetting() {
	const { t } = useTranslation("views");
	const [visible, setVisible] = usePersistentState(DOCK_KEY, true);

	return (
		<div className="panel flex flex-col gap-2.5 p-3.5">
			<div className="flex flex-wrap gap-1.5">
				<Button size="sm" active={visible} onClick={() => setVisible(true)}>
					{t("settings.dock.show")}
				</Button>
				<Button size="sm" active={!visible} onClick={() => setVisible(false)}>
					{t("settings.dock.hide")}
				</Button>
			</div>
			<p className="text-[10px] leading-relaxed text-ink-faint">
				{visible
					? t("settings.dock.showHelp")
					: t("settings.dock.hideHelp")}
			</p>
		</div>
	);
}
