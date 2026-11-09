import { invoke } from "@tauri-apps/api/core";
import { isPreview, previewDelay, previewFor } from "@/lib/preview";
import { listen } from "@tauri-apps/api/event";
import { t } from "@/i18n";
import type {
	Account,
	Readiness,
	Automation,
	AutomationOverview,
	AutomationRun,
	LibreInspection,
	LibrePrepared,
	AccountStatus,
	AgentEvent,
	AgentStatus,
	RelaySetting,
	Attachment,
	BranchDiff,
	BranchPr,
	BranchOverview,
	Brief,
	DiskUsage,
	BriefSection,
	BriefSource,
	ConfigView,
	FileStamp,
	Review,
	ReviewPrepared,
	Territory,
	Connector,
	Container,
	DocEntry,
	FeedItem,
	FileChange,
	FileEntry,
	Ground,
	Groundwork,
	Calibration,
	Handback,
	ImpactAnalysis,
	ImpactScan,
	JobLine,
	JobStatus,
	JournalEntry,
	PermanenceHalt,
	PermanenceState,
	ListeningPort,
	PackageScript,
	Panel,
	PropertyAudit,
	PropertySuggestion,
	ProjectSessions,
	Execution,
	McpApproval,
	McpServer,
	SessionEvent,
	SessionSpend,
	ResourceReport,
	SlashCommand,
	KpiDashboard,
	KpiValue,
	LinearIssueDetail,
	LinearOptions,
	Metrics,
	Lesson,
	PermissionRequest,
	ProjectHealth,
	ProjectInput,
	Prompt,
	Mission,
	MissionActivity,
	MissionEstimate,
	MissionExposure,
	RepoRoles,
	DeliveryDossier,
	MissionOverrun,
	MissionState,
	MissionStep,
	MissionTask,
	PullRequest,
	RemoteStatus,
	RepoCommand,
	Role,
	TaskState,
	QaFile,
	SentryProject,
	TicketProviderInfo,
	SubagentRun,
	Task,
	TerminalChunk,
	TerminalExit,
	TerminalInfo,
	Commit,
	TeamBoard,
	UsageLimits,
	UsageReport,
	UsageSpend,
	Worktree,
	WorktreeHygiene,
	WorktreeCommand,
	TourChanges,
	BrowserAction,
	InspectedElement,
	TourStory,
	Voice,
	CloudVoice,
	MethodCatalog,
	MethodInspection,
	MethodInstallation,
	MethodMeasure,
	ReplayCase,
	ReplayProgress,
	ReplaySetup,
	ReplayTrial,
} from "./types";

/** Toutes les erreurs backend remontent en `string` : on les normalise ici. */
export class IpcError extends Error {}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	// Hors de la fenêtre native, en développement : on répond à la place du pont,
	// faute de quoi l'app rend un écran noir et ne se regarde jamais autrement
	// qu'une fois compilée. Rien de ceci n'existe dans l'application livrée —
	// `import.meta.env.DEV` retire le bloc à la construction.
	if (isPreview()) {
		const canned = previewFor(command, args);
		const delay = previewDelay(command);
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		if (canned !== undefined) return canned as T;
		throw new IpcError(t("lib:ipc.previewMissing", { command }));
	}
	try {
		return await invoke<T>(command, args);
	} catch (error) {
		throw new IpcError(typeof error === "string" ? error : String(error));
	}
}

export const api = {
	config: {
		get: () => call<ConfigView>("config_get"),
		update: (patch: Record<string, unknown>) =>
			call<ConfigView>("config_update", { patch }),
		path: () => call<string>("config_file_path"),
		/** Bascule le projet courant ; tous les écrans en dépendent. */
		activateProject: (id: string) => call<ConfigView>("project_activate", { id }),
		saveProject: (project: ProjectInput) => call<ConfigView>("project_save", { project }),
		/** Ce qu'il y a à cet emplacement : dossier, dépôt, serveur, comptes. */
		inspectProject: (path: string) => call<Ground>("project_inspect", { path }),
		/** Crée ce qui manque — dossier, dépôt local, dépôt distant. */
		prepareProject: (request: Groundwork) =>
			call<Ground>("project_prepare", { request }),
		/** Patch appliqué au projet actif : un champ vidé redevient hérité. */
		/** Sans `project`, c'est le projet actif qui est modifié. */
		updateProject: (patch: Record<string, unknown>, project?: string) =>
			call<ConfigView>("project_update", { patch, project }),
		removeProject: (id: string) => call<ConfigView>("project_remove", { id }),
		/** Santé de tous les projets, chacun avec ses propres réglages. */
		health: () => call<ProjectHealth[]>("projects_health"),
		// Les jetons ne redescendant pas dans le webview, un environnement se
		// modifie par une commande dédiée : un token vide conserve l'existant.
		saveTriggerEnv: (name: string, token?: string, projectRef?: string) =>
			call<ConfigView>("trigger_env_save", { name, token, projectRef }),
		removeTriggerEnv: (name: string) => call<ConfigView>("trigger_env_remove", { name }),
		/** Ce qui est branché sur ce projet, et ce qui manque. */
		connectors: () => call<Connector[]>("connectors_list"),
	},

	/**
	 * Les comptes sous lesquels les agents travaillent.
	 *
	 * Le cockpit ne détient aucun jeton : il désigne un dossier de configuration,
	 * et c'est le CLI qui s'y connecte lui-même. `status` est donc une question
	 * posée au CLI, pas une lecture de ce que le cockpit aurait retenu.
	 */
	accounts: {
		status: (force = false) => call<AccountStatus[]>("accounts_status", { force }),
		save: (entries: Account[]) => call<ConfigView>("accounts_save", { entries }),
		/** Après une connexion faite au terminal : oublie la réponse d'avant. */
		refresh: () => call<void>("accounts_refresh"),
	},

	/**
	 * Les rendez-vous qui se préparent seuls : une consigne, un rythme, un rendu.
	 * Lecture seule par construction — voir `automations.rs`.
	 */
	automations: {
		overview: () => call<AutomationOverview[]>("automations_overview"),
		save: (automation: Automation) => call<Automation>("automation_save", { automation }),
		remove: (id: string) => call<void>("automation_remove", { id }),
		/** Rend l'identifiant de l'exécution ; le travail s'annonce ensuite par événement. */
		runNow: (id: string) => call<string>("automation_run_now", { id }),
		dropLine: (id: string, run: string, line: string, dropped: boolean) =>
			call<void>("automation_drop_line", { id, run, line, dropped }),
		/** Le rendu de daily prêt aujourd'hui, s'il y en a un. */
		latestDaily: () => call<AutomationRun | null>("automation_latest_daily"),
		/** Un essai à blanc sur la période qu'elle couvrirait maintenant : rien n'est rangé. */
		tryOnce: (automation: Automation) => call<AutomationRun>("automation_try", { automation }),
		/** Ajoute une correction datée à la consigne. */
		correct: (id: string, text: string) => call<Automation>("automation_correct", { id, text }),
		/** Met le rendu en PDF, l'ouvre, et rend son chemin. */
		exportPdf: (id: string, run: string) => call<string>("automation_export_pdf", { id, run }),
		/** Publie le rendu sur Slack — sur un clic seulement. */
		postSlack: (id: string, run: string) => call<void>("automation_post_slack", { id, run }),
		revealExports: (id: string) => call<void>("automation_reveal_exports", { id }),
	},

	/** Les agents libres : un dossier, un agent, sans chantier ni mission. */
	libre: {
		inspect: (path: string) => call<LibreInspection>("libre_inspect", { path }),
		/** `place` : `ici`, `branche` ou `worktree`. */
		prepare: (path: string, place: string, branch: string) =>
			call<LibrePrepared>("libre_prepare", { path, place, branch }),
		/** `action` : `keep` garde la branche, `discard` jette tout. */
		archive: (worktree: string, branch: string, action: "keep" | "discard") =>
			call<void>("libre_archive", { worktree, branch, action }),
	},

	worktrees: {
		list: () => call<Worktree[]>("worktrees_list"),
		/** Dépôt d'origine de chaque dossier ; vide quand ce n'en est pas un. */
		reposOf: (paths: string[]) =>
			call<Record<string, string>>("repos_of", { paths }),
		hygiene: () => call<WorktreeHygiene[]>("worktrees_hygiene"),
		/**
		 * Le poids de plusieurs worktrees. À la demande : mesurer parcourt des
		 * centaines de milliers d'inodes, le résultat vaut dix minutes.
		 */
		usage: (paths: string[], refresh = false) =>
			call<DiskUsage[]>("worktrees_usage", { paths, refresh }),
		/** Efface les sorties de build ; rend les octets rendus au disque. */
		purgeBuilds: (path: string, dependencies: boolean) =>
			call<number>("worktree_purge_builds", { path, dependencies }),
		changes: (path: string) => call<FileChange[]>("worktree_changes", { path }),
		fileDiff: (path: string, file: string) =>
			call<string>("worktree_file_diff", { path, file }),
		/** Captures et comptes rendus de self-QA déposés dans le worktree. */
		qa: (path: string) => call<QaFile[]>("worktree_qa", { path }),
		commits: (path: string, limit = 12) =>
			call<Commit[]>("worktree_commits", { path, limit }),
	},

	reviews: {
		/** Prépare un tour : la PR, sa branche à jour, son worktree, la consigne. */
		prepare: (number: number, kind: "revue" | "verification") =>
			call<ReviewPrepared>("review_prepare", { number, kind }),
		/** Range la revue qu'un agent vient de remettre par son outil. */
		record: (cwd: string, input: unknown) => call<Review>("review_record", { cwd, input }),
		get: (number: number) => call<Review | null>("review_get", { number }),
		list: () => call<Review[]>("reviews_list"),
		posted: (number: number, finding: string, posted: boolean) =>
			call<Review>("review_posted", { number, finding, posted }),
		/** La PR d'une branche, ouverte, fusionnée ou fermée. */
		branchPr: (branch: string) => call<BranchPr | null>("branch_pr", { branch }),
	},

	chantier: {
		/** Les fichiers d'un worktree et leur poids — le fond de la carte. */
		territory: (cwd: string) => call<Territory>("chantier_territory", { cwd }),
		/** Dates de modification : ce qui a bougé depuis qu'un agent l'a lu. */
		stamps: (paths: string[]) => call<FileStamp[]>("files_stamps", { paths }),
	},

	git: {
		/** `includeRemote` ajoute les branches qui n'existent que sur le serveur. */
		branches: (base?: string, includeRemote?: boolean) =>
			call<BranchOverview>("git_branches", { base, includeRemote }),
		branchDiff: (branch: string, base: string) =>
			call<BranchDiff>("git_branch_diff", { branch, base }),
		branchFileDiff: (branch: string, base: string, file: string) =>
			call<string>("git_branch_file_diff", { branch, base, file }),
		graph: (refs: string[], limit = 40) => call<string>("git_graph", { refs, limit }),
		// Écritures : `path` vise le worktree concerné, jamais « le dépôt courant ».
		fetch: (path: string) => call<string>("git_fetch", { path }),
		pull: (path: string) => call<string>("git_pull", { path }),
		push: (path: string) => call<string>("git_push", { path }),
		commit: (path: string, message: string) =>
			call<string>("git_commit", { path, message }),
		stash: (path: string, message?: string) => call<string>("git_stash", { path, message }),
		stashPop: (path: string) => call<string>("git_stash_pop", { path }),
		stashList: (path: string) => call<string[]>("git_stash_list", { path }),
		/** Crée une branche sans la sortir ; part de la branche d'intégration par défaut. */
		createBranch: (repo: string, name: string, base?: string) =>
			call<string>("git_create_branch", { repo, name, base: base ?? null }),
		/** Pousse la branche puis ouvre la PR ; rend son URL. */
		createPr: (path: string, title: string, body?: string, draft?: boolean) =>
			call<string>("git_create_pr", { path, title, body, draft }),
		pullRequests: () => call<PullRequest[]>("pull_requests"),
		/**
		 * Ce que l'équipe a déclaré pour créer ou démonter un worktree.
		 *
		 * Résolu côté Rust — substitutions et repli générique compris — pour que
		 * les écrans qui l'appellent ne puissent pas diverger.
		 */
		worktreeCommand: (action: "create" | "remove", branch: string, path?: string) =>
			call<WorktreeCommand>("worktree_command", { action, branch, path }),
		mergePullRequest: (number: number, method = "squash") =>
			call<void>("pull_request_merge", { number, method }),
	},

	team: {
		board: (cycleOnly = true) => call<TeamBoard>("team_board", { cycleOnly }),
	},

	agents: {
		/** Démarre un agent piloté par le cockpit et renvoie son identifiant. */
		start: (
			cwd: string,
			prompt: string,
			permissionMode?: string,
			model?: string,
			resume?: string,
			/** Moteur qui fait tourner l'agent ; vide = le premier déclaré. */
			engine?: string,
			/** `review` : lecture seule, et l'outil qui remet la revue. */
			profile?: string,
			/** Compte imposé — celui d'un agent libre ; absent = celui du projet. */
			account?: string,
			/** `fast`, `normal`, `deep` ; absent = rien de demandé au moteur. */
			depth?: string,
		) =>
			call<string>("agent_start", {
				cwd,
				prompt,
				permissionMode,
				model,
				resume,
				engine,
				profile: profile ?? null,
				account: account || null,
				depth: depth || null,
			}),
		send: (sessionId: string, text: string) =>
			call<void>("agent_send", { sessionId, text }),
		/**
		 * Coupe le tour en cours sans tuer l'agent : la conversation reste
		 * ouverte et on peut renvoyer une consigne corrigée.
		 */
		interrupt: (sessionId: string) => call<void>("agent_interrupt", { sessionId }),
		/**
		 * Demande où en sont les serveurs MCP de cette session.
		 *
		 * Ne rend rien : la réponse revient par le flux de l'agent, comme le
		 * reste de ce que le CLI raconte.
		 */
		probeMcp: (sessionId: string) => call<void>("agent_probe_mcp", { sessionId }),
		/**
		 * Demande de quoi est rempli le contexte de cette session. Même chemin que
		 * `probeMcp` : la réponse revient par le flux de l'agent.
		 */
		probeContext: (sessionId: string) => call<void>("agent_probe_context", { sessionId }),
		/** Relance un serveur MCP tombé, sans toucher à la conversation. */
		reconnectMcp: (sessionId: string, server: string) =>
			call<void>("agent_reconnect_mcp", { sessionId, server }),
		stop: (sessionId: string) => call<void>("agent_stop", { sessionId }),
		list: () => call<AgentStatus[]>("agents_list"),
		/** Les agents de workspace survivent-ils à la fermeture du cockpit ? */
		relaySetting: () => call<RelaySetting>("relay_setting"),
		saveRelaySetting: (setting: RelaySetting) =>
			call<void>("relay_setting_save", { setting }),
		/** Les agents retrouvés vivants au démarrage de cette session du cockpit. */
		survivors: () => call<string[]>("relay_survivors"),
		/** Ce qu'a coûté cette conversation depuis son premier message. */
		spend: (sessionId: string) => call<SessionSpend>("agent_spend", { sessionId }),
		/** Fil d'un agent lancé par le cockpit lui-même — mission, exécutant. */
		timeline: (sessionId: string) => call<SessionEvent[]>("agent_timeline", { sessionId }),
		/** Demandes d'autorisation en attente de ta décision. */
		permissions: () => call<PermissionRequest[]>("permissions_pending"),
		answerPermission: (id: string, allow: boolean, reason?: string) =>
			call<void>("permission_answer", { id, allow, reason }),
		/** Oublie les demandes d'un agent arrêté : plus personne ne les lira. */
		discardPermissions: (sessionId: string) =>
			call<void>("permissions_discard", { sessionId }),
		/**
		 * Joint un fichier du disque à une conversation, et rend où il a été copié.
		 *
		 * Le CLI sait lire un fichier local, images comprises : lui donner un chemin
		 * suffit, et rien n'a besoin de traverser la conversation encodé.
		 */
		attach: (sessionId: string, path: string) =>
			call<Attachment>("agent_attach", { sessionId, path }),
		/** Même chose pour un contenu collé, qui n'a pas de chemin sur le disque. */
		attachClipboard: (sessionId: string, name: string, data: string) =>
			call<Attachment>("agent_attach_clipboard", { sessionId, name, data }),
	},

	/**
	 * Ce que le cockpit sait déjà d'un dossier de travail.
	 *
	 * `compose` ne rejette jamais : ce qui n'a pas pu être lu revient dans
	 * `missing`, et le champ de saisie reste utilisable même hors ligne.
	 */
	brief: {
		compose: (cwd: string) => call<Brief>("brief_compose", { cwd }),
		/**
		 * Le texte final : contexte retenu, puis consigne.
		 *
		 * `cwd` sert à retenir qu'un contexte est parti dans ce dossier — c'est ce
		 * qui permettra de comparer ce que rendent les agents qui en ont reçu.
		 */
		assemble: (sections: BriefSection[], prompt: string, cwd?: string) =>
			call<string>("brief_assemble", { sections, prompt, cwd }),
		/** Le catalogue des sources joignables, pour les réglages. */
		sources: () => call<BriefSource[]>("brief_sources"),
	},

	/**
	 * L'état de la boucle : ce qui a été livré, repris, attrapé.
	 *
	 * Sans projet, celui qui est actif. Rien ici n'est un objectif — c'est une
	 * façon de voir si les garde-fous attrapent encore quelque chose.
	 */
	metrics: {
		collect: (project?: string) => call<Metrics>("metrics_collect", { project }),
	},

	/**
	 * Les commandes maison du dépôt.
	 *
	 * Distinct de `commands`, qui désigne les commandes « / » de Claude Code :
	 * ce sont deux catalogues sans rapport, et les confondre ferait proposer un
	 * `pnpm test` là où l'on attend une slash-command.
	 *
	 * `line` assemble côté Rust : c'est ce qui part réellement dans un terminal,
	 * et deux surfaces qui l'assembleraient chacune finiraient par diverger.
	 */
	repoCommands: {
		detect: (repo: string) => call<RepoCommand[]>("commands_detect", { repo }),
		line: (command: RepoCommand, positional: string, values: Array<[string, string]>) =>
			call<string>("command_line", { command, positional, values }),
	},

	/**
	 * Ce qui doit rester vrai, et ce que valent ces garde-fous.
	 *
	 * `calibrate` rejoue une propriété sur les corrections passées du dépôt :
	 * c'est ce qui distingue un garde-fou d'une phrase rassurante.
	 */
	properties: {
		audit: (key: string) => call<PropertyAudit>("properties_audit", { key }),
		read: (key: string) => call<PropertyAudit | null>("properties_read", { key }),
		calibrations: (project: string) =>
			call<Calibration[]>("properties_calibrations", { project }),
		calibrate: (project: string, property: string) =>
			call<Calibration>("properties_calibrate", { project, property }),
		/** Propose des propriétés d'après ce que le dépôt a déjà eu à corriger. */
		suggest: (project: string) =>
			call<PropertySuggestion[]>("properties_suggest", { project }),
	},

	/**
	 * Le carnet du projet : ce qu'on a eu à reprendre derrière un agent.
	 *
	 * `collect` relève ce qui a bougé depuis le dernier rendu ; il rend `null`
	 * quand rien n'a été repris, ou qu'un agent travaille encore là — ses
	 * propres écritures se feraient compter comme une correction humaine.
	 */
	notebook: {
		lessons: (project?: string) => call<Lesson[]>("notebook_lessons", { project }),
		save: (lesson: Lesson) => call<Lesson[]>("notebook_save", { lesson }),
		forget: (id: string) => call<Lesson[]>("notebook_forget", { id }),
		handbacks: (project?: string) => call<Handback[]>("notebook_handbacks", { project }),
		collect: (cwd: string) => call<Handback | null>("notebook_collect", { cwd }),
		/** Fait lire une reprise et propose une leçon — sans l'enregistrer. */
		draft: (id: string) => call<Lesson>("notebook_draft", { id }),
		dismiss: (id: string) => call<Handback[]>("notebook_dismiss", { id }),
	},

	prompts: {
		list: () => call<Prompt[]>("prompts_list"),
		save: (prompt: Prompt) => call<Prompt[]>("prompt_save", { prompt }),
		remove: (id: string) => call<Prompt[]>("prompt_remove", { id }),
		reset: () => call<Prompt[]>("prompts_reset"),
		/** Ouvre un agent Claude Code sur `cwd` avec le prompt pré-rempli. */
		launch: (cwd: string, text: string) => call<void>("prompt_launch", { cwd, text }),
	},

	/** Ce que les agents ont fait, relevé par le cockpit. */
	executions: {
		/** La timeline d'une mission : ce qui a tourné pour elle, dans l'ordre. */
		forMission: (mission: string) =>
			call<Execution[]>("mission_executions", { mission }),
		/** Ce qu'un chantier a fait tourner, agents refermés compris. */
		forWorkspace: (cwd: string) => call<Execution[]>("workspace_executions", { cwd }),
		/** Ce qui a tourné ces dernières heures, ou tourne encore : la journée des agents. */
		recent: (hours = 12) => call<Execution[]>("executions_recent", { hours }),
	},

	/** La langue de l'interface et des agents. `""` = suivre le système. */
	language: {
		get: () => call<{ choice: string; resolved: string; supported: string[] }>("language_get"),
		set: (choice: string) =>
			call<{ choice: string; resolved: string; supported: string[] }>("language_set", { choice }),
	},

	/** Les serveurs MCP du dépôt, et ce qu'un agent en verra. */
	mcp: {
		servers: (cwd?: string) => call<McpServer[]>("mcp_servers", { cwd: cwd ?? null }),
		approval: (cwd?: string) => call<McpApproval>("mcp_approval", { cwd: cwd ?? null }),
		approve: (cwd?: string) => call<McpApproval>("mcp_approve", { cwd: cwd ?? null }),
		revoke: (cwd?: string) => call<McpApproval>("mcp_revoke", { cwd: cwd ?? null }),
	},

	sessions: {
		scan: (limitPerProject = 40) =>
			call<ProjectSessions[]>("sessions_scan", { limitPerProject }),
		timeline: (file: string, maxEvents = 400) =>
			call<SessionEvent[]>("session_timeline", { file, maxEvents }),
		subagents: (file: string) => call<SubagentRun[]>("session_subagents", { file }),
		usage: () => call<UsageReport>("usage_report"),
		/** Plafonds de l'abonnement ; `refresh` force une relecture du CLI. */
		limits: (refresh?: boolean) => call<UsageLimits>("usage_limits", { refresh }),
		/** Ce qu'on dépense — ne lance rien, lit les journaux du disque. */
		spend: () => call<UsageSpend>("usage_spend"),
	},

	/** Fichiers d'un worktree : les trouver, les modifier. */
	files: {
		list: (root: string) => call<FileEntry[]>("files_list", { root }),
		write: (path: string, content: string) => call<void>("file_write", { path, content }),
	},

	docs: {
		scan: (roots: Array<[string, string]>, limit = 300) =>
			call<DocEntry[]>("docs_scan", { roots, limit }),
		read: (path: string) => call<string>("doc_read", { path }),
	},

	scripts: {
		list: (path: string) => call<PackageScript[]>("scripts_list", { path }),
	},

	/** Ce que le cockpit et ses processus pèsent sur la machine. */
	resources: {
		report: () => call<ResourceReport>("resource_report"),
	},

	/** Isolation des agents par conteneur. */
	sandbox: {
		/**
		 * De quoi connecter le compte des agents isolés — `claude setup-token`
		 * dans un terminal, une fois. Le jeton survit ensuite d'un lancement à
		 * l'autre : voir `sandbox::sandbox_account_dir` côté Rust.
		 */
		login: () => call<{ cwd: string; command: string }>("sandbox_login"),
	},

	/** Commandes « / » de Claude Code utilisables depuis un worktree. */
	commands: {
		list: (cwd: string) => call<SlashCommand[]>("slash_commands", { cwd }),
	},

	/** Tâches personnelles du projet actif. */
	tasks: {
		list: () => call<Task[]>("tasks_list"),
		add: (text: string, priority: "normal" | "high" = "normal") =>
			call<Task[]>("task_add", { text, priority }),
		toggle: (id: string) => call<Task[]>("task_toggle", { id }),
		remove: (id: string) => call<Task[]>("task_remove", { id }),
		clearDone: () => call<Task[]>("tasks_clear_done"),
	},

	/** Ce que le cockpit a fait en ton nom : commits, push, merges. */
	journal: {
		list: (limit = 200) => call<JournalEntry[]>("journal_list", { limit }),
	},

	/** L'opérateur autonome : ce qu'il a vu, et s'il regarde encore. */
	permanence: {
		state: () => call<PermanenceState>("permanence_state"),
		/** Un geste, pas un réglage : il coûte un clic et se défait aussi vite. */
		suspend: (suspended: boolean) =>
			call<PermanenceState>("permanence_suspend", { suspended }),
		/** Un regard tout de suite, sans attendre la cadence. */
		look: () => call<PermanenceState>("permanence_look"),
		/**
		 * Tout arrêter : plus rien ne part, et ce qui tourne est coupé. Rend le
		 * compte rendu de ce qui a été effectivement stoppé.
		 */
		halt: (reason?: string) => call<PermanenceHalt>("permanence_halt", { reason }),
		/** Défait ce qu'un engagement a produit, et dit ce qui a résisté. */
		undo: (id: string) => call<PermanenceHalt>("permanence_undo", { id }),
		/** Réarme le coupe-circuit — geste humain, jamais automatique. */
		rearm: () => call<PermanenceState>("permanence_rearm"),
		/**
		 * Ouvre ou referme une pull request au commentaire.
		 *
		 * Le consentement porte sur l'objet : il se donne sur la PR, pas dans un
		 * écran de réglages où l'on coche une fois pour toutes.
		 */
		allowPr: (number: number, allowed: boolean) =>
			call<ConfigView>("permanence_allow_pr", { number, allowed }),
		/** Met fin au rodage : elle passe du blanc au réel. */
		goLive: () => call<PermanenceState>("permanence_go_live"),
		/** Remet un signal écarté en attente d'un nouveau tri. */
		retrySignal: (key: string, at: number) =>
			call<PermanenceState>("permanence_retry_signal", { key, at }),
	},

	jobs: {
		run: (label: string, command: string, cwd: string) =>
			call<JobStatus>("job_run", { request: { label, command, cwd } }),
		kill: (jobId: string) => call<void>("job_kill", { jobId }),
		list: () => call<JobStatus[]>("jobs_list"),
	},

	/** Shells interactifs du panneau de travail, un PTY chacun. */
	terminals: {
		open: (
			cwd: string,
			options: {
				command?: string;
				label?: string;
				cols?: number;
				rows?: number;
				/** Force le compte du shell ; absent = celui du projet ouvert. */
				account?: string;
			} = {},
		) => call<TerminalInfo>("terminal_open", { cwd, ...options }),
		write: (id: string, data: string) => call<void>("terminal_write", { id, data }),
		resize: (id: string, cols: number, rows: number) =>
			call<void>("terminal_resize", { id, cols, rows }),
		close: (id: string) => call<void>("terminal_close", { id }),
		list: () => call<TerminalInfo[]>("terminals_list"),
	},

	/** Le navigateur d'un workspace : celui que l'agent pilote, et qu'on regarde. */
	browser: {
		/** Se branche sur son image, en le lançant s'il ne tourne pas. */
		watch: (cwd: string) => call<void>("browser_watch", { cwd }),
		/** Tourne-t-il déjà — lancé par un agent ? Ne lance rien. */
		running: (cwd: string) => call<boolean>("browser_running", { cwd }),
		/** L'élément sous ce point de la page : balise, texte, sélecteur, composant React. */
		inspect: (cwd: string, x: number, y: number) =>
			call<InspectedElement | null>("browser_inspect", { cwd, x, y }),
		/**
		 * L'image qui suit `after`, en binaire : la longueur de l'en-tête, l'en-tête
		 * en JSON, le JPEG. Vide si la page n'a pas bougé ; rejette si le
		 * navigateur s'est fermé.
		 */
		frame: (cwd: string, after: number) => call<ArrayBuffer>("browser_frame", { cwd, after }),
		/**
		 * Une image de la page à l'instant, sans se brancher : même enveloppe que
		 * `frame`, vide quand aucun navigateur ne tourne. Ne lance rien.
		 */
		snapshot: (cwd: string) => call<ArrayBuffer>("browser_snapshot", { cwd }),
		act: (cwd: string, action: BrowserAction) => call<void>("browser_act", { cwd, action }),
		/** Cesse de regarder ; l'agent garde son navigateur. */
		unwatch: (cwd: string) => call<void>("browser_unwatch", { cwd }),
		stop: (cwd: string) => call<void>("browser_stop", { cwd }),
	},

	/** Méthodes : les plugins qu'un projet peut adopter. */
	methods: {
		/** Les plugins du projet, et ceux des marketplaces connues. */
		catalog: (project: string) => call<MethodCatalog>("methods_catalog", { project }),
		/** Ce qu'un plugin contient et exécute, lu sans l'installer. */
		inspect: (project: string, pluginId: string) =>
			call<MethodInspection>("methods_inspect", { project, pluginId }),
		/** Installe pour le projet ou ce poste, si ce qu'il exécute est encore ce qu'on a lu. */
		install: (project: string, pluginId: string, scope: string, approved: string, accept?: string) =>
			call<MethodInstallation>("methods_install", { project, pluginId, scope, approved, accept: accept ?? null }),
		uninstall: (project: string, pluginId: string, scope: string) =>
			call<string>("methods_uninstall", { project, pluginId, scope }),
		/** Les agents du projet avant et après l'installation. */
		measure: (project: string, projectId: string, pluginId: string) =>
			call<MethodMeasure>("methods_measure", { project, projectId, pluginId }),
	},

	/** Rejeu de l'historique : les PR fusionnées comme cas d'essai. */
	replay: {
		/** Les PR fusionnées qui ajoutent des tests, les plus récentes d'abord. */
		cases: (project: string) => call<ReplayCase[]>("replay_cases", { project }),
		/** Les essais déjà joués, les plus récents d'abord. */
		trials: (project: string) => call<ReplayTrial[]>("replay_trials", { project }),
		/** La campagne en cours, ou `null`. */
		progress: () => call<ReplayProgress | null>("replay_progress"),
		/** Lance une campagne ; rend le nombre d'essais engagés. */
		run: (project: string, numbers: number[], setups: ReplaySetup[]) =>
			call<number>("replay_run", { project, numbers, setups }),
	},

	/** Missions : un ticket, un plan, des exécutants. */
	missions: {
		/** Toutes les missions, tous projets confondus — pour les îles de la carte. */
		everywhere: () => call<Mission[]>("missions_everywhere"),
		list: () => call<Mission[]>("missions_list"),
		/** Ce que coûtera un découpage de `tasks` tâches, d'après les missions closes. */
		estimate: (taskCount: number) =>
			call<MissionEstimate>("mission_estimate", { taskCount }),
		/** Les tâches en cours qui débordent de ce qu'une tâche coûte d'ordinaire. */
		overruns: () => call<MissionOverrun[]>("mission_overruns"),
		/** Les rôles du plan qui partiront sans filet : `bypassPermissions` hors conteneur. */
		exposure: (id: string) => call<MissionExposure>("mission_exposure", { id }),
		/** Le dossier de livraison : ce que le cockpit a mesuré de la mission. */
		dossier: (id: string) => call<DeliveryDossier>("mission_dossier", { id }),
		/** Le publie sur la pull request : section de description et statut de commit. */
		publishDossier: (id: string) => call<string>("mission_dossier_publish", { id }),
		get: (id: string) => call<Mission>("mission_get", { id }),
		create: (
			title: string,
			options: { ticket?: string; ticketUrl?: string; cwd?: string; branch?: string } = {},
		) => call<Mission>("mission_create", { title, ...options }),
		/** Ouvre une mission depuis l'adresse ou l'identifiant d'un ticket. */
		fromTicket: (reference: string) => call<Mission>("mission_from_ticket", { reference }),
		/**
		 * Ouvre la mission d'un ticket et lance son maître, d'un seul geste.
		 *
		 * Rend `started: false` quand une mission était déjà ouverte sur ce ticket :
		 * on y retourne plutôt que d'en créer une seconde, qui viserait la même
		 * branche d'intégration.
		 */
		startFromTicket: (reference: string) =>
			call<{ mission: Mission; started: boolean; message: string; session?: string }>(
				"mission_start_from_ticket",
				{ reference },
			),
		/** Ce que le maître et les exécutants fabriquent à cet instant. */
		activity: (id: string) => call<MissionActivity>("mission_activity", { id }),
		remove: (id: string) => call<void>("mission_remove", { id }),
		/** Efface la mission et tout ce qu'elle a créé — sans retour possible. */
		purge: (id: string) => call<string[]>("mission_purge", { id }),
		/** Coupe les agents et suspend le lanceur ; le travail reste en place. */
		pause: (id: string) => call<Mission>("mission_pause", { id }),
		/** Relance d'un coup le maître et tout ce qui doit tourner. */
		resume: (id: string) => call<Mission>("mission_resume", { id }),
		/** Coupe tout et abandonne la mission. */
		stop: (id: string) => call<Mission>("mission_stop", { id }),
		/** Soumet un plan : la mission attend ensuite une approbation. */
		plan: (id: string, plan: string, tasks: MissionTask[]) =>
			call<Mission>("mission_plan", { id, plan, tasks }),
		approve: (id: string) => call<Mission>("mission_approve", { id }),
		/** Valide ou corrige une étape d'une mission guidée ; le maître en est prévenu. */
		review: (
			id: string,
			step: MissionStep,
			approved: boolean,
			feedback?: string,
			answers?: string[],
		) => call<Mission>("mission_review", { id, step, approved, feedback, answers }),
		setState: (id: string, state: MissionState, note?: string) =>
			call<Mission>("mission_state", { id, state, note }),
		addTask: (id: string, task: MissionTask) =>
			call<Mission>("mission_task_add", { id, task }),
		setTaskState: (id: string, taskId: string, state: TaskState, note?: string) =>
			call<Mission>("mission_task_state", { id, taskId, state, note }),
		/** Rattache un agent en cours ; `taskId` vide vise le maître. */
		attach: (id: string, taskId: string, sessionId: string) =>
			call<Mission>("mission_attach", { id, taskId, sessionId }),
		/** Lance l'agent maître, avec ses outils d'orchestration. */
		launchMaster: (id: string, brief?: string) =>
			call<string>("mission_master_launch", { id, brief }),
		/** Lance l'exécutant d'une tâche avec la consigne de son rôle. */
		/** Branche sur laquelle la PR finale se greffe ; vide = branche par défaut. */
		setBase: (id: string, base: string) => call<Mission>("mission_set_base", { id, base }),
		/** Relance une tâche en lui faisant tout reprendre depuis le début. */
		rerun: (id: string, taskId: string) =>
			call<string>("mission_task_rerun", { id, taskId }),
		launch: (id: string, taskId: string) =>
			call<string>("mission_task_launch", { id, taskId }),
		/** Ouvre la PR d'intégration, clôt la mission et range les worktrees. */
		openPr: (id: string, title?: string, body?: string) =>
			call<Mission>("mission_pr", { id, title, body }),
		/** Range les worktrees des tâches intégrées. */
		cleanup: (id: string) => call<string[]>("mission_cleanup", { id }),
		roles: () => call<Role[]>("roles_list"),
		repoRoles: () => call<RepoRoles>("repo_roles"),
		/** Valide le fichier de rôles du dépôt tel qu'il est. */
		trustRepoRoles: () => call<RepoRoles>("repo_roles_trust"),
	},

	/** Accès mobile : serveur local exposé au tailnet. */
	remote: {
		status: () => call<RemoteStatus>("remote_status"),
		enable: (enabled: boolean) => call<void>("remote_enable", { enabled }),
		// Un jeton vide conserve celui déjà enregistré : l'écran ne le relit jamais.
		ntfy: (server: string, topic: string, token: string) =>
			call<void>("remote_ntfy", { server, topic, token }),
		pair: () => call<{ code: string; url: string; qr: string }>("remote_pair"),
		revoke: (id: string) => call<void>("remote_revoke", { id }),
		/** Publie un message de test et rend ce que le relais en dit. */
		test: () => call<string>("remote_test"),
		/** Réveil du téléphone pour ce que la veille de l'interface repère. */
		wake: (title: string, body: string) => call<void>("remote_wake", { title, body }),
	},

	tour: {
		changes: (cwd: string, since?: string | null) =>
			call<TourChanges>("tour_changes", { cwd, since: since ?? null }),
		fileDiff: (root: string, base: string, file: string, untracked: boolean) =>
			call<string>("tour_file_diff", { root, base, file, untracked }),
		story: (
			cwd: string,
			since: string | null,
			notes: Array<{ path: string; said: string }>,
			conclusion: string,
		) => call<TourStory>("tour_story", { cwd, since, notes, conclusion }),
	},
	assistant: {
		/** Claude, allégé : sans outils ni MCP, sans réflexion, sur l'abonnement. */
		ask: (system: string, prompt: string, model?: string) =>
			call<string>("assistant_ask", { system, prompt, model: model ?? null }),
		/** Le micro depuis l'interface ; le raccourci ⌥ Espace passe par Rust. */
		listen: () => call<void>("voice_start"),
		/** Referme le micro et rend la phrase transcrite (vide pour un effleurement). */
		heard: () => call<string>("voice_stop"),
		/** Le raccourci pour parler, et s'il a vraiment pu s'enregistrer. */
		shortcut: () => call<ShortcutStatus>("assistant_shortcut"),
		/** En change ; l'ancien est remis si le nouveau est déjà pris. */
		setShortcut: (accelerator: string) => call<ShortcutStatus>("assistant_set_shortcut", { accelerator }),
	},
	speech: {
		voices: () => call<Voice[]>("speech_voices"),
		/**
		 * Rend la main quand la phrase est dite, ou coupée. Rend la raison du
		 * repli sur la voix du Mac quand ElevenLabs a échoué, `null` sinon.
		 */
		say: (
			text: string,
			options: {
				engine: "system" | "elevenlabs";
				voice: string | null;
				model: string | null;
				systemVoice: string | null;
				rate: number;
			},
		) => call<string | null>("speech_say", { text, ...options }),
		/** La clé ElevenLabs, dans le trousseau du Mac ; vide l'efface. */
		setKey: (key: string) => call<void>("speech_set_key", { key }),
		hasKey: () => call<boolean>("speech_has_key"),
		cloudVoices: () => call<CloudVoice[]>("speech_cloud_voices"),
		stop: () => call<void>("speech_stop"),
	},
	system: {
		/** Les prérequis du poste : ce qu'il faut avant de lancer un agent. */
		readiness: () => call<Readiness>("readiness_check"),
		openEditor: (path: string) => call<void>("open_editor", { path }),
		openTerminal: (cwd: string, command?: string) =>
			call<void>("open_terminal", { cwd, command }),
		reveal: (path: string) => call<void>("reveal_in_finder", { path }),
		/** Les dossiers du répertoire de projets, un niveau : où lancer un agent. */
		folders: () => call<Array<{ name: string; path: string }>>("folders_list"),
		/** Avec l'application que macOS associe au fichier. */
		openFile: (path: string) => call<void>("open_file", { path }),
		/** Aperçu d'un fichier local en data URI — repli quand `asset://` échoue. */
		fileDataUrl: (path: string) => call<string>("file_data_url", { path }),
		notify: (title: string, body: string) => call<void>("notify_desktop", { title, body }),
		/** Plein écran de travail, ou retour au cadre précédent. */
		zoomToggle: () => call<void>("window_zoom_toggle"),
		containers: () => call<Container[]>("docker_containers"),
		ports: () => call<ListeningPort[]>("listening_ports"),
		/** Arrête ce qui occupe un port — SIGTERM, puis SIGKILL s'il s'accroche. */
		stopProcess: (pid: number) => call<void>("stop_process", { pid }),
		// Passe par `open` côté Rust : le plugin `opener` lance le navigateur
		// comme processus enfant du cockpit, ce qui donne un Chrome inutilisable.
		openUrl: (url: string) => call<void>("open_external", { url }),
	},

	impact: {
		/** Tout ce qui bouge ; sans projet, tous ceux qui sont déclarés. */
		scan: (project?: string) => call<ImpactScan>("impact_scan", { project }),
		/** Les clés dont l'analyse tourne en ce moment. */
		running: () => call<string[]>("impact_running"),
		/**
		 * Lit un changement. Long : plusieurs minutes, le temps qu'un agent
		 * parcoure le dépôt.
		 */
		analyze: (key: string) => call<ImpactAnalysis>("impact_analyze", { key }),
		read: (key: string) => call<ImpactAnalysis | null>("impact_read", { key }),
		forget: (key: string) => call<void>("impact_forget", { key }),
	},

	/**
	 * La confrontation : le même changement lu sous trois angles, et le
	 * désaccord seul.
	 *
	 * Plus longue et plus chère qu'une lecture — quatre agents au lieu d'un —
	 * donc jamais lancée d'elle-même.
	 */
	panel: {
		confront: (key: string) => call<Panel>("panel_confront", { key }),
		read: (key: string) => call<Panel | null>("panel_read", { key }),
		running: () => call<string[]>("panel_running"),
	},

	feeds: {
		/** Force le prochain appel à repartir du service (bouton rafraîchir). */
		invalidate: () => call<void>("feeds_invalidate"),
		sentry: (query?: string) => call<FeedItem[]>("feed_sentry", { query }),
		sentryProjects: () => call<SentryProject[]>("sentry_projects"),
		sentrySetStatus: (issueId: string, status: string) =>
			call<void>("sentry_set_status", { issueId, status }),
		/** Crée le ticket Linear d'une issue Sentry et renvoie son URL. */
		sentryToLinear: (fields: {
			issueId: string;
			title: string;
			permalink: string;
			project: string;
			culprit: string;
			users: string;
			events: string;
		}) => call<string>("sentry_to_linear", fields),
		betterstackDashboards: () => call<KpiDashboard[]>("betterstack_dashboards"),
		betterstackKpiValues: (dashboardId: string, hours = 24) =>
			call<KpiValue[]>("betterstack_kpi_values", { dashboardId, hours }),
		betterstackMonitors: () => call<FeedItem[]>("feed_betterstack_monitors"),
		betterstackIncidents: () => call<FeedItem[]>("feed_betterstack_incidents"),
		/** Ce que le suivi de tâches sait faire, et comment il s'appelle. */
		ticketProvider: () => call<TicketProviderInfo>("ticket_provider"),
		linear: (onlyMine = false) => call<FeedItem[]>("feed_linear", { onlyMine }),
		linearIssue: (id: string) => call<LinearIssueDetail>("linear_issue", { id }),
		linearOptions: () => call<LinearOptions>("linear_options"),
		linearUpdate: (id: string, patch: Record<string, unknown>) =>
			call<void>("linear_update", { id, patch }),
		githubPulls: () => call<FeedItem[]>("feed_github_pulls"),
		githubRuns: () => call<FeedItem[]>("feed_github_runs"),
		trigger: (environment?: string) => call<FeedItem[]>("feed_trigger", { environment }),
		railway: () => call<FeedItem[]>("feed_railway"),
		stripe: () => call<FeedItem[]>("feed_stripe"),
	},
};

/**
 * S'abonner à un événement natif, ou ne rien faire hors de Tauri.
 *
 * `listen` touche `__TAURI_INTERNALS__` dès l'appel : sans pont il jette, et
 * comme la plupart des abonnements sont posés au montage, l'erreur remontait
 * jusqu'à faire écran noir. Le mode aperçu n'a de toute façon aucun événement
 * à recevoir — un désabonnement qui ne fait rien est la bonne réponse.
 */
function subscribe<T>(
	name: string,
	handler: (event: { payload: T }) => void,
): Promise<() => void> {
	if (isPreview()) return Promise.resolve(() => undefined);
	return listen<T>(name, handler);
}

export const events = {
	/** Message d'un agent piloté par le cockpit. */
	onAgentEvent: (handler: (event: AgentEvent) => void) =>
		subscribe<AgentEvent>("agent://event", (event) => handler(event.payload)),
	onJobLine: (handler: (line: JobLine) => void) =>
		subscribe<JobLine>("job://output", (event) => handler(event.payload)),
	onJobStatus: (handler: (status: JobStatus) => void) =>
		subscribe<JobStatus>("job://status", (event) => handler(event.payload)),
	/** Sortie d'un terminal intégré, en base64. */
	onTerminalOutput: (handler: (chunk: TerminalChunk) => void) =>
		subscribe<TerminalChunk>("terminal://output", (event) => handler(event.payload)),
	onTerminalExit: (handler: (exit: TerminalExit) => void) =>
		subscribe<TerminalExit>("terminal://exit", (event) => handler(event.payload)),
	onSessionsChanged: (handler: () => void) => subscribe("sessions://changed", () => handler()),
	/** Mouvement dans le `.git` du dépôt principal : commit, checkout, fetch… */
	onGitChanged: (handler: () => void) => subscribe("git://changed", () => handler()),
	/** Une exécution d'automatisation a commencé, avancé ou fini. */
	onAutomationRun: (handler: () => void) => subscribe("automation://run", () => handler()),
	/** L'oreille de l'assistant : j'écoute, je transcris, ce qui a été entendu. */
	onAssistantVoice: (handler: (event: AssistantVoice) => void) =>
		subscribe<AssistantVoice>("assistant-voice", (event) => handler(event.payload)),
};

export interface ShortcutStatus {
	/** `alt+Space`, `control+alt+KeyJ`… */
	accelerator: string;
	registered: boolean;
	error: string | null;
}

export interface AssistantVoice {
	state: "listening" | "transcribing" | "heard" | "idle" | "error";
	text: string;
}
