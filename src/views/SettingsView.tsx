import clsx from "clsx";
import { AssistantSettings } from "@/components/Assistant";
import { VoiceSettings } from "@/components/NarrationToggle";
import { Check, ExternalLink, FolderOpen, KeyRound, Plus, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	Badge,
	Button,
	Dot,
	ErrorNote,
	Field,
	Section,
	Spinner,
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
	TeamSettings,
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

/**
 * Les rubriques des réglages, dans l'ordre où l'on s'en sert.
 *
 * « Projets » d'abord : sans dépôt, rien d'autre ne s'applique à quoi que ce
 * soit. Le poste et la version ferment la liste — on n'y touche qu'une fois.
 */
const TABS = [
	{ id: "projects", label: "Projets", hint: "les dépôts que le cockpit pilote" },
	{ id: "services", label: "Services", hint: "ce qui est branché, et avec quelles clés" },
	{ id: "team", label: "Équipe & workflow", hint: "qui travaille, et comment" },
	{ id: "agents", label: "Agents", hint: "les rôles confiés aux exécutants" },
	{ id: "voice", label: "Voix & assistant", hint: "la voix, l'écoute, ElevenLabs" },
	{
		id: "permanence",
		label: "Permanence",
		hint: "ce qu'elle surveille, et ce qu'elle s'autorise",
	},
	{ id: "workstation", label: "Poste", hint: "dossiers, éditeur, apparence, démarrage" },
	{ id: "mobile", label: "Accès mobile", hint: "suivre les agents depuis le téléphone" },
	{ id: "version", label: "Version", hint: "mises à jour" },
] as const;

type SettingsTab = (typeof TABS)[number]["id"];

/** Clé de service → chemin du champ dans le TOML (snake_case côté Rust). */
const SECRET_PATHS: Record<string, [string, string]> = {
	github: ["github", "token"],
	sentry: ["sentry", "token"],
	linear: ["linear", "token"],
	gitlab: ["gitlab", "token"],
	trigger: ["trigger", "token"],
	railway: ["railway", "token"],
	betterstack: ["betterstack", "token"],
	betterstack_telemetry: ["betterstack", "telemetry_token"],
	betterstack_clickhouse_host: ["betterstack", "clickhouse_host"],
	betterstack_clickhouse_username: ["betterstack", "clickhouse_username"],
	betterstack_clickhouse_password: ["betterstack", "clickhouse_password"],
	stripe: ["stripe", "token"],
	// `SandboxConfig` sérialise en camelCase (`memoryMb`…), à la différence
	// des autres structs de secrets ci-dessus : le champ suit sa convention,
	// pas celle du reste de cette table.
	sandbox_oauth_token: ["sandbox", "oauthToken"],
};

/**
 * Cases à cocher alimentées par l'organisation Sentry : plusieurs projets se
 * suivent en même temps, encore faut-il savoir lesquels existent — un champ
 * texte laissait deviner les slugs.
 */
function SentryProjectPicker({
	selected,
	onChange,
}: {
	/** Slugs séparés par des virgules, tels que stockés dans le brouillon. */
	selected: string;
	onChange: (value: string) => void;
}) {
	const projects = useAsync(() => api.feeds.sentryProjects(), []);
	const chosen = selected
		.split(",")
		.map((slug) => slug.trim())
		.filter(Boolean);

	const toggle = (slug: string) => {
		const next = chosen.includes(slug)
			? chosen.filter((value) => value !== slug)
			: [...chosen, slug];
		onChange(next.join(", "));
	};

	if (projects.error) {
		// Sans token valide on garde la saisie manuelle plutôt que de bloquer.
		return (
			<>
				<TextInput value={selected} onChange={onChange} mono />
				<p className="mt-1 text-[10px] text-ink-faint">
					Liste indisponible ({projects.error}) — saisis les slugs à la main.
				</p>
			</>
		);
	}

	return (
		<div className="flex flex-wrap gap-1">
			{projects.loading && !projects.data ? <Spinner /> : null}
			{(projects.data ?? []).map((project) => {
				const active = chosen.includes(project.slug);
				return (
					<button
						key={project.slug}
						type="button"
						onClick={() => toggle(project.slug)}
						className={clsx(
							"focus-ring rounded-lg border px-2 py-1 font-mono text-[10px] transition-colors",
							active
								? "border-accent-soft/40 bg-accent-soft/12 text-ink"
								: "border-line-soft bg-surface text-ink-faint hover:text-ink-muted",
						)}
					>
						{active ? "✓ " : ""}
						{project.slug}
					</button>
				);
			})}
		</div>
	);
}

/**
 * Liste des environnements Trigger.dev — un par secret key, puisqu'une clé ne
 * donne accès qu'à un couple projet + environnement. Chacun devient un onglet
 * dans l'écran Delivery.
 */
function TriggerEnvironments() {
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
			notify(`Environnement « ${name} » enregistré.`);
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (name: string) => {
		const ok = await confirm({
			title: `Retirer l'environnement « ${name} » ?`,
			confirmLabel: "Retirer",
			danger: true,
		});
		if (!ok) return;
		try {
			await api.config.removeTriggerEnv(name);
			reloadConfig();
			notify(`Environnement « ${name} » retiré.`);
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
						{environment.projectRef || "projet par défaut"}
					</span>
					{environment.fromDefaultKey ? (
						<Badge>clé principale</Badge>
					) : (
						<Button size="sm" onClick={() => void remove(environment.name)}>
							Retirer
						</Button>
					)}
				</div>
			))}

			<div className="flex items-end gap-2 p-2.5">
				<Field label="Nom">
					<TextInput
						value={draft.name}
						onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
						placeholder="Production"
					/>
				</Field>
				<Field label="Secret key">
					<TextInput
						type="password"
						value={draft.token}
						onChange={(value) => setDraft((current) => ({ ...current, token: value }))}
						placeholder="tr_prod_…"
						mono
					/>
				</Field>
				<Field label="Projet" hint="Vide = celui ci-dessus.">
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
					Ajouter
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
 * servir autant un monorepo d'entreprise qu'un dépôt personnel sans Linear ni
 * Sentry derrière.
 */
function Projects() {
	const { config, reloadConfig, notify, activeProject, switchProject } = useCockpit();
	const { confirm } = useConfirm();
	const [draft, setDraft] = useState({
		name: "",
		mainRepo: "",
		githubRepo: "",
		solo: false,
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
				solo: draft.solo,
				main_repo: draft.mainRepo,
				// Le dépôt déduit du serveur quand on ne l'a pas saisi : il est
				// déjà sous les yeux dans le bloc de préparation, le retaper
				// n'ajoute qu'une occasion de se tromper.
				github: { repo: draft.githubRepo || ground?.slug || "", token: "" },
			});
			setDraft({ name: "", mainRepo: "", githubRepo: "", solo: false });
			reloadConfig();
			notify(`Projet « ${draft.name || draft.mainRepo} » ajouté.`);
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string, name: string) => {
		const ok = await confirm({
			title: `Retirer le projet « ${name} » ?`,
			message: "Seule la configuration du cockpit est modifiée — le dépôt reste intact.",
			confirmLabel: "Retirer",
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
						title="Activer ce projet"
					>
						<span className="block truncate text-[11px] font-medium text-ink">
							{project.name}
						</span>
						<span className="block truncate font-mono text-[10px] text-ink-faint">
							{project.mainRepo}
						</span>
					</button>
					{project.githubRepo ? <Badge>{project.githubRepo}</Badge> : null}
					{project.solo ? <Badge>solo</Badge> : null}
					{projects.length > 1 ? (
						<Button size="sm" onClick={() => void remove(project.id, project.name)}>
							Retirer
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
					Nouveau
				</span>
				<Field label="Nom">
					<TextInput
						value={draft.name}
						onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
						placeholder="Side project"
					/>
				</Field>
				<Field
					label="Dossier"
					hint="Un chemin, un « ~ », ou juste un nom sous ton dossier de projets."
				>
					<TextInput
						value={draft.mainRepo}
						onChange={(value) => setDraft((current) => ({ ...current, mainRepo: value }))}
						placeholder="~/Sites/mon-projet"
						mono
					/>
				</Field>
				<Field label="GitHub" hint="Vide = déduit du dépôt, s'il en a un.">
					<TextInput
						value={draft.githubRepo}
						onChange={(value) => setDraft((current) => ({ ...current, githubRepo: value }))}
						placeholder={ground?.slug || "moi/mon-projet"}
						mono
					/>
				</Field>
				<Button
					size="sm"
					active={draft.solo}
					onClick={() => setDraft((current) => ({ ...current, solo: !current.solo }))}
					title="Projet sans équipe : masque le daily"
					className="h-7"
				>
					Solo
				</Button>
				<Button
					variant="solid"
					icon={Plus}
					// Un dossier qui n'est pas encore un dépôt ne peut pas devenir un
					// projet : plutôt que de refuser au clic, on le dit avant.
					disabled={busy || !draft.mainRepo.trim() || ground?.isRepo === false}
					title={
						ground?.isRepo === false
							? "Prépare le terrain d'abord — le bloc ci-dessous s'en charge"
							: undefined
					}
					onClick={() => void add()}
				>
					Ajouter
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

export function SettingsView() {
	const { config, configError, reloadConfig, notify, activeProject, focus, clearFocus } =
		useCockpit();
	const [draft, setDraft] = useState({
		projectsRoot: "",
		mainRepo: "",
		editor: "zed",
		githubRepo: "",
		sentryOrg: "",
		sentryProjects: "",
		linearTeamKey: "",
		triggerProjectRef: "",
		railwayProjectId: "",
		gitlabProject: "",
		gitlabHost: "",
	});
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);
	/**
	 * Où va l'enregistrement.
	 *
	 * « Projet » écrit dans le projet actif, « Défauts » dans les valeurs
	 * partagées dont héritent les projets qui ne disent rien. Sans ce choix, le
	 * multi-projets se réduirait à changer de dépôt : deux projets sur des
	 * comptes GitHub différents seraient impossibles.
	 */
	const [scope, setScope] = useState<"project" | "global">("project");
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
	// Les rubriques qui écrivent dans le fichier de configuration : la portée et
	// le bouton « Enregistrer » ne concernent qu'elles. Ailleurs, chaque panneau a
	// son propre bouton — l'en-tête en montrait un qui n'enregistrait pas ce qu'on
	// venait de modifier.
	const declaresConfig = tab === "services" || tab === "workstation";
	const scoped = declaresConfig || tab === "team" || tab === "agents";
	// Dès qu'un second projet existe, les cibles ne s'héritent plus : ce que
	// l'écran dit doit suivre ce que le backend fait.
	const cloisonne = (config?.projects.length ?? 0) > 1;

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
			sentryOrg: declared.sentryOrg,
			sentryProjects: declared.sentryProjects.join(", "),
			linearTeamKey: declared.linearTeamKey,
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
			sentry: {
				org: draft.sentryOrg,
				projects: draft.sentryProjects
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean),
			},
			linear: { team_key: draft.linearTeamKey },
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
			notify("Configuration enregistrée.");
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<ViewHeader
				title="Réglages"
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
							Révéler le fichier
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
								{saving ? "Enregistrement…" : "Enregistrer"}
							</Button>
						) : null}
					</>
				}
			/>

			{configError ? <ErrorNote error={configError} onRetry={reloadConfig} /> : null}

			<div className="flex min-h-0 flex-1">
				{/* Le menu tient dans une colonne fixe : ces libellés ne changent pas,
				    et une largeur qui suit le texte ferait danser le contenu d'une
				    rubrique à l'autre. */}
				<nav className="hairline-r flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto p-2.5">
					{TABS.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => setTab(entry.id)}
							title={entry.hint}
							className={clsx(
								"focus-ring rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
								tab === entry.id
									? "bg-accent-dim font-medium text-accent-soft"
									: "text-ink-muted hover:bg-hover hover:text-ink",
							)}
						>
							{entry.label}
						</button>
					))}
				</nav>

				<div className="min-h-0 flex-1 overflow-y-auto p-5">
				<div className="flex max-w-3xl flex-col gap-6">
					{tab === "projects" ? (
						<Section title="Projets">
							<Projects />
						</Section>
					) : null}

					{/* La portée décide de tout ce qui suit : elle doit se lire avant
					    de toucher au moindre champ, pas se deviner dans un coin. */}
					{scoped ? (
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
									? `Les réglages ci-dessous s'appliquent à « ${activeProject?.name ?? "ce projet"} »`
									: "Les réglages ci-dessous sont les valeurs par défaut, héritées par tous les projets"}
							</p>
							<p className="mt-0.5 text-[10px] leading-snug text-ink-faint">
								{scope === "project"
									? cloisonne
										? "Tu ne vois ici que ce que ce projet déclare. Un champ vide n'est pas configuré pour lui : dès qu'il y a plusieurs projets, aucun n'emprunte le dépôt ni l'équipe d'un autre. Seuls les jetons d'accès restent partagés."
										: "Un champ laissé vide hérite des valeurs par défaut. Renseigne-le pour que ce projet ait le sien — un autre compte GitHub, une autre clé Sentry."
									: cloisonne
										? "Ces valeurs servent de repli aux jetons d'accès. Les dépôts et les équipes, eux, se déclarent projet par projet."
										: "Ces valeurs servent partout où un projet ne dit rien. Bascule sur le projet pour lui donner ses propres réglages."}
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-1 rounded-lg border border-line-soft p-0.5">
							<Button
								size="sm"
								active={scope === "project"}
								onClick={() => setScope("project")}
							>
								{activeProject?.name ?? "Projet"}
							</Button>
							<Button
								size="sm"
								active={scope === "global"}
								onClick={() => setScope("global")}
							>
								Défauts
							</Button>
						</div>
					</div>
					) : null}

					{tab === "services" ? (
						<Section title="Services connectés">
							<ConnectorsSettings />
						</Section>
					) : null}

					{tab === "team" ? (
						<>
							<Section title="Flux de travail">
								<WorkflowSettings />
							</Section>

							{/* L'équipe juste après le flux de travail : les deux décrivent
							    la même chose — comment ce projet travaille — et se règlent
							    au même moment, quand on branche un nouveau dépôt. */}
							<Section title="Équipe">
								<TeamSettings />
							</Section>
						</>
					) : null}

					{tab === "agents" ? (
						<>
							{/* Les comptes en tête : c'est sous eux que tout le reste tourne,
							    et un moteur réglé au détail près sur la mauvaise identité ne
							    sert à rien. */}
							<Section title="Comptes">
								<AccountsSettings />
							</Section>

							{/* Les moteurs avant les rôles : un rôle choisit son moteur, et
							    on ne choisit pas dans une liste qu'on n'a pas encore
							    remplie. */}
							<Section title="Moteurs d'agents">
								<EnginesSettings />
							</Section>

							{/* Juste après les moteurs : un rôle choisit son moteur, ses
							    outils viennent du dépôt. Les deux décident de ce qu'un agent
							    peut faire, et l'un sans l'autre ne dit rien. */}
							<Section title="Outils du dépôt (MCP)">
								<McpSettings />
							</Section>

							<Section title="Rôles des agents">
								<RolesSettings />
							</Section>

							<Section title="Comment démarre une mission">
								<MissionModeSettings />
							</Section>

							{/* Ce qu'une mission a le droit de coûter, juste après les rôles
							    qui la peuplent : c'est le même sujet vu par la dépense. */}
							<Section title="Ce qu'une mission a le droit de coûter">
								<MissionBudgetSettings />
							</Section>

							{/* Juste après la dépense : la même question posée à la
							    machine plutôt qu'au portefeuille. */}
							<Section title="Isolation des agents">
								<SandboxSettings />
							</Section>

							{/* Ce qui doit rester vrai vient en premier : c'est la seule
							    chose de cet onglet qu'une machine puisse vérifier, et le
							    reste — contexte, rôles, lectures — sert à s'en approcher. */}
							<Section title="Ce qui doit rester vrai">
								<PropertiesSettings />
							</Section>

							{/* Les commandes du dépôt : ce que le cockpit sait lancer en
							    ton nom, à côté de ce qu'il sait vérifier. */}
							<Section title="Commandes du dépôt">
								<CommandsSettings />
							</Section>

							{/* Ce qu'un agent sait avant de commencer se règle au même
							    endroit que ce qu'il a le droit de faire : les deux décident
							    de ce qu'il produira. */}
							<Section title="Contexte des agents">
								<BriefSettings />
							</Section>

							{/* La lecture des changements est un agent comme les autres :
							    elle a son moteur et sa profondeur, et se règle donc ici
							    plutôt que dans un coin de l'écran qui l'utilise. */}
							<Section title="Lecture des changements">
								<ImpactSettings />
							</Section>
						</>
					) : null}

					{/* La Permanence a sa propre rubrique : ce n'est pas un agent qu'on
					    lance mais un service qui tourne, et la seule chose du cockpit
					    qui agisse sans qu'on la regarde partir. */}
					{tab === "permanence" ? <PermanenceSettings /> : null}

					{/* Un réglage de poste : la clé ElevenLabs est dans le trousseau du
					    Mac, pas dans la configuration d'un projet. */}
					{tab === "voice" ? (
						<>
							<Section title="Voix">
								<p className="mb-3 max-w-xl text-[12px] leading-relaxed text-ink-muted">
									La voix qui raconte ce que fait un agent quand tu l'écoutes, et qui te répond quand tu parles à
									l'assistant. La clé ElevenLabs sert aux deux : à parler, et à t'entendre.
								</p>
								<VoiceSettings />
							</Section>
							<Section title="Assistant vocal">
								<AssistantSettings />
							</Section>
						</>
					) : null}

					{tab === "mobile" ? (
						<Section title="Accès mobile">
							<RemoteAccess />
						</Section>
					) : null}

					{tab === "version" ? (
					<Section title="Version">
						{/* Le texte cède avant le bouton : à cette largeur, une phrase qui
						    ne se replie pas pousse l'action hors du cadre. */}
						<div className="panel flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5 p-3.5">
							<p className="min-w-[16rem] flex-1 text-[11px] leading-relaxed text-ink-muted">
								Le cockpit vérifie tout seul, quelques fois par jour. Rien ne
								s'installe sans ton accord : une mise à jour relance l'application.
								Les agents de workspace continuent pendant ce temps, sauf si tu
								l'as coupé dans Poste → À la fermeture ; ceux des missions sont
								repris au redémarrage.
							</p>
							<UpdateCheck />
						</div>
					</Section>
					) : null}

					{tab === "workstation" ? (
					<>
					<Section title="Apparence">
						<ThemeSetting />
					</Section>

					<Section title="À la fermeture">
						<RelaySetting />
					</Section>

					<Section title="Au démarrage">
						<ResumeSetting />
					</Section>

					<Section title="Rappel des workspaces">
						<DockSetting />
					</Section>

					<Section title="Poste de travail">
						<div className="panel grid grid-cols-2 gap-3 p-3.5">
							<Field
								label="Dossier des projets"
								hint="Racine contenant le monorepo et les worktrees."
							>
								<TextInput
									value={draft.projectsRoot}
									onChange={(value) =>
										setDraft((current) => ({ ...current, projectsRoot: value }))
									}
									mono
								/>
							</Field>
							<Field label="Dépôt principal" hint="Source de vérité des worktrees git.">
								<TextInput
									value={draft.mainRepo}
									onChange={(value) =>
										setDraft((current) => ({ ...current, mainRepo: value }))
									}
									mono
								/>
							</Field>
							<Field label="Éditeur" hint="zed · cursor · code">
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
					) : null}

					{tab === "services" ? (
					<>
					<Section title="Identifiants de projet">
						<div className="panel grid grid-cols-2 gap-3 p-3.5">
							<Field label="Dépôt GitHub" hint="owner/repo">
								<TextInput
									value={draft.githubRepo}
									onChange={(value) =>
										setDraft((current) => ({ ...current, githubRepo: value }))
									}
									placeholder="northwind/storefront"
									mono
								/>
							</Field>
							<Field label="Organisation Sentry">
								<TextInput
									value={draft.sentryOrg}
									onChange={(value) =>
										setDraft((current) => ({ ...current, sentryOrg: value }))
									}
									mono
								/>
							</Field>
							<Field label="Projets Sentry" hint="Aucun coché = toute l'organisation.">
								<SentryProjectPicker
									selected={draft.sentryProjects}
									onChange={(value) =>
										setDraft((current) => ({ ...current, sentryProjects: value }))
									}
								/>
							</Field>
							{/* Ce champ ne désigne pas l'équipe du daily : il sert à lire un
							    numéro de ticket (ABC-3044). Nommé « Équipe Linear », il
							    passait pour le réglage qui manquait au daily — lequel
							    attend un UUID et des membres, dans la section Équipe. */}
							<Field
								label="Clé des tickets"
								hint="préfixe Linear, ex. ABC — l'équipe du daily se règle plus bas"
							>
								<TextInput
									value={draft.linearTeamKey}
									onChange={(value) =>
										setDraft((current) => ({ ...current, linearTeamKey: value }))
									}
									mono
								/>
							</Field>
							{/* Le suivi de tâches se déduit de ce qui est renseigné : Linear
							    s'il a un jeton, sinon GitLab si son projet est là, sinon les
							    issues du dépôt GitHub. Un réglage de plus pour le redire
							    serait un réglage de plus à oublier de changer. */}
							<Field
								label="Projet GitLab"
								hint="chemin avec son groupe, ex. groupe/produit"
							>
								<TextInput
									value={draft.gitlabProject}
									onChange={(value) =>
										setDraft((current) => ({ ...current, gitlabProject: value }))
									}
									placeholder="groupe/produit"
									mono
								/>
							</Field>
							<Field
								label="Instance GitLab"
								hint="vide = gitlab.com ; sinon la racine de la vôtre"
							>
								<TextInput
									value={draft.gitlabHost}
									onChange={(value) =>
										setDraft((current) => ({ ...current, gitlabHost: value }))
									}
									placeholder="https://gitlab.exemple.com"
									mono
								/>
							</Field>
							<Field label="Projet Trigger.dev">
								<TextInput
									value={draft.triggerProjectRef}
									onChange={(value) =>
										setDraft((current) => ({ ...current, triggerProjectRef: value }))
									}
									placeholder="proj_…"
									mono
								/>
							</Field>
							<Field label="Projet Railway">
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

					<Section title="Environnements Trigger.dev">
						<TriggerEnvironments />
						<p className="mt-1.5 px-1 text-[10px] leading-relaxed text-ink-faint">
							Une secret key ne vaut que pour un projet et un environnement : ajoute une
							entrée par environnement à suivre (Production, Staging, Test…). Chacune
							devient un onglet dans Delivery.
						</p>
					</Section>

					<Section title="Jetons d'accès">
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
											<Badge tone="accent">propre au projet</Badge>
										) : secret.configured ? (
											<Badge tone="success">
												{scope === "project" ? "hérité" : "configuré"}
											</Badge>
										) : (
											<Badge tone="neutral">absent</Badge>
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
													? "•••••••• — laisse vide pour conserver"
													: "Coller le token"
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
							Les jetons sont écrits dans {config?.configPath} en permissions 600 et ne
							redescendent jamais dans l'interface. Chaque valeur peut aussi être fournie
							par variable d'environnement (COCKPIT_SENTRY_TOKEN, COCKPIT_LINEAR_TOKEN…),
							qui l'emporte alors sur le fichier.
						</p>
					</Section>

					<Section title="Repères">
						<div className="panel flex flex-col gap-2 p-3.5 text-[11px] text-ink-muted">
							{[
								["Sentry", "https://sentry.io/settings/account/api/auth-tokens/"],
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
					</>
					) : null}

					{declaresConfig ? (
						<div className="flex justify-end pb-6">
							<Button
								variant="solid"
								icon={Check}
								disabled={saving}
								onClick={() => void save()}
							>
								Enregistrer la configuration
							</Button>
						</div>
					) : null}
				</div>
				</div>
			</div>
		</>
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
	const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice());

	// « Système » reste vivant : la bascule du soir de macOS doit suivre, sinon
	// le réglage ne veut dire ce qu'il annonce qu'au moment où on le choisit.
	useEffect(() => {
		if (choice !== "system") return;
		return watchSystemTheme(() => applyTheme("system"));
	}, [choice]);

	const options: Array<{ value: ThemeChoice; label: string; hint: string }> = [
		{ value: "dark", label: "Sombre", hint: "le thème d'origine" },
		{ value: "light", label: "Clair", hint: "mêmes rôles, autres valeurs" },
		{ value: "system", label: "Système", hint: "suit macOS, bascule comprise" },
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
				Le choix vaut pour ce poste et s'applique tout de suite — il n'attend pas
				« Enregistrer la configuration », qui ne concerne que les réglages du projet. Les
				terminaux ouverts se repeignent avec le reste.
			</p>
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
					Les agents continuent
				</Button>
				<Button size="sm" active={!value} onClick={() => choose(false)}>
					Les agents s'arrêtent
				</Button>
			</div>
			<p className="text-[10px] leading-relaxed text-ink-faint">
				{value
					? "Fermer le cockpit, ou le mettre à jour, n'arrête plus les agents de workspace lancés à la main : ils finissent leur tour sans fenêtre, et tu les retrouves au lancement suivant, conversation relue. Le navigateur du workspace, lui, se ferme avec l'app. Les missions, la revue et les agents isolés en conteneur gardent leur comportement : ils s'arrêtent et sont repris."
					: "Fermer le cockpit arrête tous les agents en cours ; au lancement suivant, ils sont repris selon le réglage « Au démarrage »."}{" "}
				Le choix vaut pour les agents lancés à partir de maintenant.
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
	const [mode, setMode] = usePersistentState<ResumeMode>(RESUME_KEY, "resume");

	const options: Array<{ value: ResumeMode; label: string; hint: string }> = [
		{
			value: "resume",
			label: "Reprendre le travail",
			hint: "rouvre tout et demande à chaque agent de reprendre où il en était",
		},
		{
			value: "reopen",
			label: "Rouvrir sans relancer",
			hint: "les conversations sont là, relues, mais personne ne repart de lui-même",
		},
		{
			value: "off",
			label: "Ne rien rouvrir",
			hint: "les workspaces attendent dans la barre ; un clic les réveille",
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
					? "Chaque agent rouvert reçoit une consigne de reprise : faire le point sur l'état réel du dépôt avant de continuer, plutôt que de repartir sur sa dernière action. Son contexte, lui, est intact — le CLI reprend la conversation par son identifiant."
					: mode === "reopen"
						? "Les conversations sont rouvertes et relisibles ; c'est toi qui relances le travail."
						: "Rien ne repart : ce qui tournait hier s'affiche endormi dans la barre des workspaces."}{" "}
				Ce choix s'applique au prochain lancement du cockpit. Les missions en cours, elles,
				reprennent toujours — leurs exécutants comme leur agent maître.
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
	const [visible, setVisible] = usePersistentState(DOCK_KEY, true);

	return (
		<div className="panel flex flex-col gap-2.5 p-3.5">
			<div className="flex flex-wrap gap-1.5">
				<Button size="sm" active={visible} onClick={() => setVisible(true)}>
					Afficher
				</Button>
				<Button size="sm" active={!visible} onClick={() => setVisible(false)}>
					Masquer
				</Button>
			</div>
			<p className="text-[10px] leading-relaxed text-ink-faint">
				{visible
					? "Les workspaces en cours restent rappelés en bas à droite, hors de leur écran : c'est leur seule trace quand tu regardes ailleurs."
					: "Rien ne s'affiche par-dessus les autres écrans. Ce qui tourne reste visible dans l'écran Workspaces, et les notifications continuent de te prévenir."}
			</p>
		</div>
	);
}
