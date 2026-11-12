import { t } from "@/i18n";
import { lazyList } from "./language";

/** Miroir des structures sérialisées par le backend Rust (camelCase). */

export type Severity = "critical" | "warning" | "info" | "success";

export interface Commit {
	sha: string;
	subject: string;
	author: string;
	relative: string;
	timestamp: number;
}

export interface WorktreeStatus {
	modified: number;
	staged: number;
	untracked: number;
	conflicted: number;
	ahead: number;
	behind: number;
	upstream: string | null;
}

export interface Worktree {
	path: string;
	folderName: string;
	branch: string | null;
	head: string;
	isMain: boolean;
	isDetached: boolean;
	isLocked: boolean;
	status: WorktreeStatus;
	lastCommit: Commit | null;
	lastActivity: number | null;
}

/** Ce qu'un worktree occupe, et ce qu'on récupérerait sans rien perdre. */
export interface DiskUsage {
	path: string;
	/** Poids total, tel que le système le rapporte. */
	bytes: number;
	/**
	 * Sorties de build et caches — le seul poids qui coûte vraiment. Produits
	 * localement, uniques à chaque worktree, partagés avec rien.
	 */
	builds: number;
	/**
	 * Dépendances installées. Compté à part : sur APFS, pnpm clone ses paquets
	 * depuis son store, donc les blocs sont partagés et ce poids est une
	 * illusion — `du` le compte pourtant dans chaque worktree.
	 */
	dependencies: number;
	measuredAt: number;
}

/** Label GitHub d'une PR. `color` est un hexadécimal sans `#`. */
export interface PrLabel {
	name: string;
	color: string;
}

export interface PullRequest {
	number: number;
	title: string;
	url: string;
	headRef: string;
	/** Le commit de tête : dit si la PR a bougé depuis une revue. */
	headSha: string;
	baseRef: string;
	author: string;
	isDraft: boolean;
	reviewDecision: string;
	ciState: string;
	createdAt: string;
	linearIds: string[];
	reviewRequestLogins: string[];
	labels: PrLabel[];
}

export interface BranchPr {
	number: number;
	state: "open" | "merged" | "closed";
	title: string;
	url: string;
	mergedAt: string;
}

/** Ce qu'il faut jouer pour créer ou démonter un worktree, et comment. */
export interface WorktreeCommand {
	command: string;
	/** Commande du dépôt : elle passe par un agent, pas par un shell. */
	byAgent: boolean;
}

export interface WorktreeHygiene {
	path: string;
	folderName: string;
	branch: string | null;
	dirty: number;
	pr: BranchPr | null;
	removable: boolean;
	reason: string;
}

export interface FileChange {
	path: string;
	added: number;
	removed: number;
	state: string;
}

/** Ce qu'un agent a changé dans son dossier, depuis quand. */
export interface TourChanges {
	root: string;
	base: string;
	/** « depuis dev », « depuis avant 3f2a1bc » */
	baseLabel: string;
	files: FileChange[];
	additions: number;
	deletions: number;
}

/** La visite racontée par un modèle, dans l'ordre où lire les fichiers. */
export interface TourStory {
	intro: string;
	files: Array<{ path: string; story: string }>;
	costUsd: number;
}

export interface Voice {
	name: string;
	locale: string;
}

/** Une voix du compte ElevenLabs. */
export interface CloudVoice {
	id: string;
	name: string;
	/** « femme · français · premade » */
	description: string;
	female: boolean;
	french: boolean;
}

export interface Branch {
	name: string;
	isCurrent: boolean;
	isDefault: boolean;
	worktreePath: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	/** Commits propres à la branche depuis sa divergence avec la base. */
	commitsAhead: number;
	/** N'existe que sur le serveur : personne ne l'a sortie sur ce poste. */
	remoteOnly: boolean;
	/** Le serveur qui la porte (`origin`), quand elle vient de là. */
	remote: string;
	lastCommit: Commit | null;
}

export interface BranchOverview {
	base: string;
	branches: Branch[];
}

export interface BranchDiff {
	branch: string;
	base: string;
	mergeBase: string;
	files: FileChange[];
	commits: Commit[];
	additions: number;
	deletions: number;
}

// ───────────────────────────── Team board (daily) ─────────────────────────────

export interface FlagItem {
	label: string;
	url: string;
	meta: string;
}

export interface Flag {
	severity: "red" | "orange";
	member: string;
	category: string;
	question: string;
	ticketId: string | null;
	ticketUrl: string | null;
	prNumber: number | null;
	prUrl: string | null;
	items: FlagItem[];
	key: string;
}

export interface TicketCard {
	identifier: string;
	title: string;
	description: string;
	url: string;
	stateName: string;
	phase: string;
	progress: number;
	ageDays: number;
	/** Dernière activité, telle que le suivi la donne. */
	updatedAt: string;
	prNumbers: number[];
	/** Échelle Linear : 0 = non définie, 1 = urgent … 4 = basse. */
	priority: number;
	priorityLabel: string;
}

export interface MemberPr {
	number: number;
	url: string;
	title: string;
	/** Branche de la PR — sert à retrouver le worktree local. */
	headRef: string;
	baseRef: string;
	ciState: string;
	reviewDecision: string;
	isDraft: boolean;
	stacked: boolean;
	ageDays: number;
	/** Jours ouvrés sans activité : c'est lui qui dit si c'est le sujet du moment. */
	idleDays: number;
	updatedAt: string;
	ticketId: string | null;
	labels: PrLabel[];
}

export interface ReviewInboxItem {
	number: number;
	url: string;
	title: string;
	author: string;
	ageDays: number;
	labels: PrLabel[];
}

export interface DeltaItem {
	kind: "merged" | "opened";
	label: string;
	url: string;
	ticketId: string | null;
	labels: PrLabel[];
}

export interface NextTicket {
	identifier: string;
	title: string;
	url: string;
	priorityLabel: string;
}

export interface ThemeCount {
	label: string;
	count: number;
}

export interface Narrative {
	text: string;
	current: ThemeCount[];
	shipped: ThemeCount[];
}

export interface MemberMetrics {
	activeWip: number;
	inReview: number;
	openPrs: number;
	prsToReview: number;
	oldestReviewDays: number;
	mergedSinceDaily: number;
	reviewPending: number;
	upcoming: number;
	cycleDone: number;
	cycleTotal: number;
	cycleProgress: number;
}

export interface MemberBoard {
	name: string;
	role: string;
	roleLabel: string;
	github: string | null;
	narrative: Narrative;
	activeTickets: TicketCard[];
	reviewTickets: TicketCard[];
	next: NextTicket[];
	prs: MemberPr[];
	reviewInbox: ReviewInboxItem[];
	delta: DeltaItem[];
	metrics: MemberMetrics;
}

export interface PrFlowItem {
	number: number;
	url: string;
	title: string;
	author: string;
	ticketId: string | null;
	blockedBy: number | null;
	base: string;
	labels: PrLabel[];
}

export interface PrFlow {
	readyToMerge: PrFlowItem[];
	ciFailing: PrFlowItem[];
	stacked: PrFlowItem[];
	ciPending: number;
	ciSuccess: number;
}

export interface BoardTotals {
	activeWip: number;
	inReview: number;
	openPrs: number;
	mergedSinceDaily: number;
	blocked: number;
	readyToMerge: number;
	ciFailing: number;
	redFlags: number;
	orangeFlags: number;
}

export interface Cycle {
	number: number;
	startsAt: string;
	endsAt: string;
}

export interface TeamBoard {
	generatedAt: string;
	cycle: Cycle | null;
	sinceDaily: string;
	cycleOnly: boolean;
	repo: string;
	flags: Flag[];
	members: MemberBoard[];
	prFlow: PrFlow;
	totals: BoardTotals;
	githubError: string | null;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ToolCount {
	name: string;
	count: number;
}

export interface SessionSummary {
	id: string;
	file: string;
	cwd: string;
	projectKey: string;
	gitBranch: string | null;
	title: string;
	lastPrompt: string | null;
	startedAt: string | null;
	updatedAt: string | null;
	idleSeconds: number;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	subagents: number;
	models: string[];
	usage: TokenUsage;
	topTools: ToolCount[];
	filesTouched: string[];
	cliVersion: string | null;
	hasError: boolean;
	/** L'agent a rendu la main : sa dernière écriture n'appelle aucun outil. */
	awaitingInput: boolean;
	sizeBytes: number;
}

export interface ProjectSessions {
	key: string;
	cwd: string;
	sessions: SessionSummary[];
}

export type EventKind =
	"user" | "assistant" | "thinking" | "tool" | "tool-result" | "tool-error";

export interface SessionEvent {
	index: number;
	kind: EventKind;
	timestamp: string | null;
	text: string;
	tool: string | null;
	detail: string | null;
	isSidechain: boolean;
	model: string | null;
	tokens: number | null;
}

export interface SubagentRun {
	id: string;
	file: string;
	name: string;
	description: string;
	status: string;
	updatedAt: string | null;
}

export interface DocEntry {
	path: string;
	relative: string;
	name: string;
	category: string;
	worktree: string;
	worktreePath: string;
	modified: number;
	size: number;
	preview: string;
	untracked: boolean;
}

/** Un fichier du worktree, tel que le sélecteur le propose. */
export interface FileEntry {
	path: string;
	relative: string;
}

/**
 * Une pièce jointe d'une conversation, copiée hors du dépôt.
 *
 * `path` est ce qu'on donne à l'agent — il sait lire un fichier local, image
 * comprise ; `name` est ce qu'on affiche.
 */
export interface Attachment {
	path: string;
	name: string;
	size: number;
}

export interface PackageScript {
	name: string;
	command: string;
	group: string;
	/** De quoi le lancer — déduit du dépôt, jamais supposé. */
	runner: string;
}

/**
 * Une commande « / » de Claude Code, telle que le CLI la comprend.
 *
 * `name` est ce qu'on tape sans la barre oblique, sous-dossiers compris :
 * « review », « frontend:composant ».
 */
export interface SlashCommand {
	name: string;
	description: string;
	/** Ce que la commande attend après son nom, quand elle le déclare. */
	argumentHint: string | null;
	/**
	 * D'où elle vient : le worktree, le dossier personnel, un plugin — ou le
	 * CLI lui-même, pour celles qu'il annonce sans qu'on ait trouvé leur
	 * fichier (un skill, un dossier hors des chemins balayés).
	 */
	scope: "project" | "user" | "plugin" | "cli";
	/** Fichier qui la définit. */
	source: string;
}

/** Consommation d'un processus et de tout ce qu'il a lancé. */
export interface Usage {
	memoryMb: number;
	/** Pourcentage d'un cœur : 200 % = deux cœurs saturés. */
	cpu: number;
	processes: number;
}

export interface NamedUsage {
	id: string;
	cwd: string;
	usage: Usage;
	/** Le plus gros processus du sous-arbre, quand ce n'est pas la racine. */
	heaviest: string | null;
}

export interface ResourceReport {
	/** Le cockpit seul, sans ce qu'il a lancé. */
	app: Usage;
	/** Lui et toute sa descendance. */
	total: Usage;
	agents: NamedUsage[];
	terminals: NamedUsage[];
	machineTotalMb: number;
	machineUsedMb: number;
}

/** D'où vient un chiffre de coût — et s'il en existe un. */
export interface CostTotal {
	reportedUsd: number;
	estimatedUsd: number;
	/** Tours dont le coût n'est ni annoncé ni estimé. Ce n'est pas zéro. */
	unknownTurns: number;
}

export interface Tally {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	cost: CostTotal;
}

/** Pourquoi un agent a été lancé, et pour le compte de qui. */
export interface Origin {
	/** `me`, `permanence`, `master` ou `cockpit`. */
	actor: string;
	engagement: string;
	role: string;
	task: string;
	attempt: number;
}

export type Outcome =
	| "running"
	| "answered"
	| "failed"
	| "lostAtLaunch"
	| "stopped"
	| "orphaned";

/** Une étape du cycle de vie, connue du cockpit lui-même. */
export interface Moment {
	at: string;
	step: string;
	note: string;
}

/** Un lancement d'agent, tel que le cockpit l'a relevé. */
export interface Execution {
	id: string;
	startedAt: string;
	endedAt: string;
	sessionId: string;
	protocol: string;
	engine: string;
	engineLabel: string;
	model: string;
	mission: string;
	origin: Origin;
	cwd: string;
	project: string;
	sandboxed: boolean;
	engineSession: string;
	outcome: Outcome;
	tally: Tally;
	/** Ce qui a été dit de la fin, quand il y a quelque chose à en dire. */
	note: string;
	eventsDropped: number;
	steps: Moment[];
	/** Ce que son moteur sait annoncer — pour que ses silences se lisent. */
	observability: {
		reportsCost: boolean;
		reportsTokenSplit: boolean;
		reportsToolResults: boolean;
		reportsThinking: boolean;
		resumable: boolean;
	};
}

/** Un serveur MCP déclaré par le dépôt, et ce qu'un agent en verra. */
export interface McpServer {
	name: string;
	/** `http`, `sse` ou `stdio`. */
	kind: string;
	/** L'adresse ou la commande, telle qu'elle est déclarée. */
	target: string;
	reachable: boolean;
	/** Pourquoi il ne répondra pas. Vide quand rien ne s'y oppose. */
	blocker: string;
}

/** L'approbation des serveurs du `.mcp.json`, pour tout le dépôt. */
export interface McpApproval {
	/** Le contenu actuel du fichier est approuvé : les agents le reçoivent. */
	approved: boolean;
	/** Une approbation existait pour un autre contenu : le fichier a changé. */
	changed: boolean;
}

export interface JobStatus {
	jobId: string;
	label: string;
	command: string;
	cwd: string;
	state: "running" | "succeeded" | "failed" | "cancelled";
	exitCode: number | null;
	startedAt: number;
	endedAt: number | null;
	pid: number | null;
}

export interface JobLine {
	jobId: string;
	stream: "stdout" | "stderr";
	line: string;
	at: number;
}

/** Terminal intégré : un shell derrière un vrai PTY, rattaché à un worktree. */
export interface TerminalInfo {
	id: string;
	cwd: string;
	label: string;
	running: boolean;
	startedAt: number;
}

export interface TerminalChunk {
	id: string;
	/** Sortie brute encodée en base64 — un bloc peut couper un caractère en deux. */
	data: string;
}

export interface TerminalExit {
	id: string;
	code: number | null;
}

export interface MetaField {
	label: string;
	value: string;
}

export interface FeedItem {
	id: string;
	source: string;
	title: string;
	subtitle: string;
	status: string;
	severity: Severity;
	url: string;
	timestamp: string | null;
	meta: MetaField[];
	/** Repères lus dès la liste : labels d'une PR, priorité d'un ticket. */
	tags: Tag[];
	payload: unknown;
}

/** Étiquette d'un élément de flux, avec sa couleur d'origine si la source en a une. */
export interface Tag {
	label: string;
	/** Hexadécimal sans `#`, vide quand la source n'en fournit pas. */
	color: string;
	tone: Severity | "neutral";
}

export interface Container {
	id: string;
	name: string;
	image: string;
	state: string;
	status: string;
	ports: string;
}

/**
 * Un élément de la page, lu sous un point : ce qu'on désigne à un agent quand
 * on lui montre l'écran (`browser_inspect`).
 */
export interface InspectedElement {
	tag: string;
	text: string;
	testid: string | null;
	role: string | null;
	label: string | null;
	selector: string;
	/** Le composant React qui l'a rendu, quand la page en est une en développement. */
	component: string | null;
	/** Son fichier et sa ligne, quand React les expose encore. */
	source: string | null;
	url: string;
	/** En pixels CSS de la page. */
	rect: { x: number; y: number; width: number; height: number };
}

/** Un geste fait dans la page depuis l'interface. */
export type BrowserAction =
	| { kind: "navigate"; url: string }
	| { kind: "back" }
	| { kind: "forward" }
	| { kind: "reload" }
	/** La page prend la taille de l'onglet, en pixels CSS. */
	| { kind: "resize"; width: number; height: number }
	| {
			kind: "mouse";
			event: "mousePressed" | "mouseReleased" | "mouseMoved";
			x: number;
			y: number;
			button: "none" | "left" | "middle" | "right";
			clickCount: number;
			modifiers: number;
	  }
	| { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
	| { kind: "text"; text: string }
	| {
			kind: "key";
			event: "keyDown" | "keyUp";
			key: string;
			code: string;
			text: string;
			keyCode: number;
			modifiers: number;
	  };

export interface ListeningPort {
	port: number;
	process: string;
	pid: number;
	/** Dossier du processus : c'est lui qui rattache un serveur à son worktree. */
	cwd: string;
	/** Mémoire du processus et de sa descendance, en Mo. */
	memoryMb: number;
}

export interface SecretStatus {
	key: string;
	label: string;
	configured: boolean;
	hint: string;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	messages: number;
}

export interface UsageBucket {
	key: string;
	label: string;
	totals: UsageTotals;
}

/** Un plafond d'abonnement et son échéance, tels que le CLI les rapporte. */
export interface UsageLimit {
	/** `session` ou `week` : à comparer, contrairement au libellé, traduit. */
	kind: string;
	label: string;
	percent: number;
	/** Quand le compteur repart, en clair ; vide si le CLI ne l'annonce pas. */
	resetsAt: string;
}

export interface UsageLimits {
	limits: UsageLimit[];
	/** Ce que le CLI dit de la portée de ces chiffres — à afficher tel quel. */
	note: string;
	checkedAt: string;
	error: string;
}

/**
 * Ce qu'on dépense, ramené à ce qui tient dans un coin d'écran.
 *
 * Des jetons et non des euros : sur un abonnement rien n'est débité, et un
 * montant ferait croire à une facture qui n'existe pas. Ce qui décide, c'est le
 * quota restant.
 */
export interface UsageSpend {
	today: number;
	/** Sur la fenêtre glissante de cinq heures. */
	window: number;
	/** Ce qu'il reste du quota le plus serré. `null` = le CLI ne l'annonce pas. */
	remaining: number | null;
	tightest: string;
	resetsAt: string;
	/**
	 * Tous les compteurs du dernier relevé — vide tant qu'il n'y en a pas eu.
	 *
	 * Le témoin n'en montre qu'un ; le sélecteur de modèle a besoin de tous,
	 * pour dire de chaque modèle sur quel quota il tire.
	 */
	quotas: UsageLimit[];
}

/**
 * Ce qu'une conversation a consommé depuis son premier message.
 *
 * Distinct de la jauge de contexte, qui montre ce que le modèle a **sous les
 * yeux** au dernier tour : une conversation peut occuper 8 % de sa fenêtre tout
 * en ayant coûté un million de jetons, parce que chaque tour repaie la lecture
 * de tout ce qui précède.
 */
export interface SessionSpend {
	total: number;
	/** Sa part de ce qui a été consommé sur la fenêtre glissante de cinq heures. */
	share: number;
	remaining: number | null;
	tightest: string;
	resetsAt: string;
}

export interface UsageReport {
	generatedAt: string;
	last5h: UsageTotals;
	today: UsageTotals;
	last7Days: UsageTotals;
	last30Days: UsageTotals;
	allTime: UsageTotals;
	byDay: UsageBucket[];
	byModel: UsageBucket[];
	byWorktree: UsageBucket[];
	/** Ce que chaque mission a consommé, tous ses worktrees additionnés. */
	byMission: UsageBucket[];
	rateLimitSeen: boolean;
}

export interface Prompt {
	id: string;
	label: string;
	group: string;
	text: string;
}

/**
 * Un fait que le cockpit joint à la consigne — ou qu'on écarte.
 *
 * `text` est le markdown réellement envoyé : ce qui s'affiche à l'écran doit
 * pouvoir être déplié jusqu'à lui, sans quoi « voir ce que l'agent va savoir »
 * n'est qu'une promesse.
 */
export interface BriefSection {
	id: string;
	label: string;
	detail: string;
	text: string;
	chars: number;
	on: boolean;
	/**
	 * Ce que la section met en jeu, quand ça se compte.
	 *
	 * Les leçons du carnet y déposent leurs identifiants ; leur emploi n'est
	 * noté qu'au moment de l'envoi, jamais à la composition.
	 */
	ids: string[];
}

export interface Brief {
	cwd: string;
	branch: string;
	sections: BriefSection[];
	/** Sources interrogées sans réponse, dites plutôt que tues. */
	missing: string[];
}

/** Une source joignable, telle que les réglages la présentent. */
export interface BriefSource {
	id: string;
	label: string;
	hint: string;
}

/** Ce que le poste a décidé de joindre au lancement d'un agent. */
export interface BriefConfig {
	enabled: boolean;
	/** Sources décochées à l'ouverture, par identifiant. */
	off: string[];
}

export interface KpiChart {
	id: string;
	name: string;
	kind: string;
	section: string;
}

export interface KpiValue {
	chartId: string;
	name: string;
	kind: string;
	columns: string[];
	rows: string[][];
	error: string | null;
}

export interface KpiDashboard {
	id: string;
	name: string;
	group: string;
	url: string;
	updatedAt: string;
	charts: KpiChart[];
}

export interface PermissionRequest {
	id: string;
	/** Agent à l'origine de la demande — absent des demandes antérieures. */
	sessionId: string | null;
	tool: string;
	input: unknown;
	at: string;
}

/** Une question posée par `AskUserQuestion`, telle qu'elle arrive dans `input`. */
export interface AgentQuestion {
	question: string;
	header: string;
	multiSelect: boolean;
	options: Array<{ label: string; description?: string }>;
}

/**
 * Reconnaît la charge utile d'`AskUserQuestion`.
 *
 * L'outil arrive par le même canal que les autorisations — le CLI, sans
 * terminal, n'a pas d'autre moyen de nous joindre — mais ce n'est pas une
 * permission : l'autoriser exécute un outil qui n'a personne à qui parler et
 * répond « the user did not answer ». C'est à nous de poser la question.
 */
export function readQuestions(input: unknown): AgentQuestion[] {
	const questions = (input as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(questions)) return [];
	return questions.flatMap((entry) => {
		const raw = entry as Partial<AgentQuestion> & { options?: unknown };
		if (typeof raw.question !== "string" || !Array.isArray(raw.options)) return [];
		const options = raw.options.flatMap((option) => {
			const item = option as { label?: unknown; description?: unknown };
			if (typeof item.label !== "string") return [];
			return [
				{
					label: item.label,
					description: typeof item.description === "string" ? item.description : undefined,
				},
			];
		});
		if (options.length === 0) return [];
		return [
			{
				question: raw.question,
				header: typeof raw.header === "string" ? raw.header : "Question",
				multiSelect: raw.multiSelect === true,
				options,
			},
		];
	});
}

export interface AgentEvent {
	sessionId: string;
	/** Objet brut émis par le CLI Claude Code. */
	payload: unknown;
}

export interface AgentStatus {
	sessionId: string;
	cwd: string;
	running: boolean;
	claudeSessionId: string | null;
	/** En plein tour — un agent retrouvé après un redémarrage peut travailler. */
	working: boolean;
	/** Porté par un relais : il survit à la fermeture du cockpit. */
	detached: boolean;
}

/** Les agents de workspace continuent-ils quand le cockpit se ferme ? */
export interface RelaySetting {
	enabled: boolean;
}

export interface NamedRef {
	id: string;
	name: string;
	color: string;
}

export interface LinearComment {
	id: string;
	body: string;
	author: string;
	createdAt: string;
}

export interface LinearIssueDetail {
	id: string;
	identifier: string;
	title: string;
	description: string;
	url: string;
	priority: number;
	estimate: number | null;
	branchName: string;
	updatedAt: string;
	state: NamedRef | null;
	assignee: NamedRef | null;
	labels: NamedRef[];
	comments: LinearComment[];
}

/** Ce qu'une mission coûtera, d'après celles qui lui ressemblent. */




export interface LinearOptions {
	states: NamedRef[];
	members: NamedRef[];
	labels: NamedRef[];
}

export interface SentryProject {
	slug: string;
	name: string;
}

export interface TriggerEnvironmentView {
	name: string;
	projectRef: string;
	/** Issu du champ « Trigger.dev » des jetons, pas de la liste d'environnements. */
	fromDefaultKey: boolean;
}

/**
 * Un projet piloté par le cockpit.
 *
 * Les `has*` disent ce qui est réellement joignable : un écran sans intégration
 * derrière doit s'effacer, pas s'afficher vide.
 */
/** État de santé d'un projet, pour la vue d'ensemble multi-projets. */
export interface ProjectHealth {
	id: string;
	name: string;
	color: string;
	mainRepo: string;
	githubRepo: string;
	worktrees: number;
	dirty: number;
	unpushed: number;
	openPrs: number;
	ciFailing: number;
	readyToMerge: number;
	error: string | null;
}

/** Une action faite par le cockpit, à ta demande ou non. */
export interface JournalEntry {
	at: number;
	project: string;
	kind: string;
	label: string;
	target: string;
	ok: boolean;
	detail: string;
	/** Qui a agi : `me` ou `permanence`. */
	actor: string;
	/** L'engagement d'où vient l'entrée, quand la Permanence a agi. */
	engagement: string;
}

/** Une tâche personnelle, propre au projet actif. */
export interface Task {
	id: string;
	text: string;
	done: boolean;
	priority: "normal" | "high";
	createdAt: number;
	doneAt: number | null;
}

/** Un livrable de self-QA : capture, vidéo ou compte rendu. */
export interface QaFile {
	path: string;
	name: string;
	relative: string;
	group: string;
	kind: "image" | "video" | "markdown" | "text" | "other";
	size: number;
	modified: number | null;
}

export interface ProjectView {
	id: string;
	name: string;
	color: string;
	mainRepo: string;
	githubRepo: string;
	linearTeamKey: string;
	sentryProjects: string[];
	railwayProjectId: string;
	triggerProjectRef: string;
	solo: boolean;
	/** Le compte sous lequel il fait travailler ses agents, héritage appliqué. */
	account: string;
	/** Clés que ce projet définit lui-même ; les autres sont héritées. */
	overrides: string[];
	/** Ce que le projet déclare, sans rien de ce qu'il hérite. */
	declared: DeclaredSettings;
	hasGithub: boolean;
	hasLinear: boolean;
	hasTeam: boolean;
}

/**
 * Ce que le front envoie pour créer un projet (snake_case côté Rust).
 *
 * Seul l'essentiel : le reste se règle ensuite dans Réglages, où chaque champ
 * laissé vide continue d'hériter du global.
 */
export interface ProjectInput {
	id: string;
	name: string;
	color: string;
	solo: boolean;
	main_repo: string;
	github: { repo: string; token: string };
}

/** Ce qu'une portée déclare elle-même, sans rien de ce qu'elle hérite. */
export interface DeclaredSettings {
	projectsRoot: string;
	mainRepo: string;
	editor: string;
	githubRepo: string;
	sentryOrg: string;
	sentryProjects: string[];
	linearTeamKey: string;
	triggerProjectRef: string;
	railwayProjectId: string;
	/** Ce que fait ce produit, tel que cette portée le déclare. */
	impactBrief: string;
	/** Chemin du projet GitLab (`groupe/projet`) et instance qui le sert. */
	gitlabProject: string;
	gitlabHost: string;
	/** Le compte que cette portée désigne ; vide = celui qu'elle hérite. */
	account: string;
}

export interface ConfigView {
	/** Les réglages globaux tels qu'ils sont écrits, sans projet par-dessus. */
	global: DeclaredSettings;
	projects: ProjectView[];
	activeProject: string;
	projectsRoot: string;
	mainRepo: string;
	editor: string;
	githubRepo: string;
	sentryOrg: string;
	sentryProjects: string[];
	linearTeamKey: string;
	triggerProjectRef: string;
	triggerEnvironments: TriggerEnvironmentView[];
	railwayProjectId: string;
	configPath: string;
	secrets: SecretStatus[];
	/** Colonnes, branches et sujets : la façon de travailler de l'équipe. */
	workflow: {
		baseBranches: string[];
		activeStates: string[];
		reviewStates: string[];
		doneStates: string[];
		blockedState: string;
		dailyWeekdays: number[];
		themes: Array<{ label: string; phrase: string; keywords: string[] }>;
		/**
		 * Commande d'équipe qui ouvre une pull request — `/pull-request-creation`,
		 * typiquement. Vide : le cockpit ouvre la PR par la forge.
		 */
		prCommand: string;
		/** Comment l'équipe sort une branche en worktree. Vide = `git worktree add`. */
		worktreeCommand: string;
		/** Comment elle la démonte. Vide = `git worktree remove --force`. */
		worktreeRemoveCommand: string;
		/** Ce qui lance son serveur de dev. Vide = le geste n'est pas proposé. */
		devCommand: string;
		/** Ce qui signale une commande de test, en plus de ce qui est reconnu d'office. */
		testCommands: string[];
		/** Ce qui doit passer, dans le worktree d'une tâche, avant son intégration. */
		gateCommands: string[];
		/** Les agents rendent compte en images quand elles valent mieux que du texte. Vrai par défaut. */
		visualReports: boolean;
		/** Les agents pilotent le navigateur de leur workspace. Vrai par défaut. */
		agentBrowser: boolean;
		/** Le navigateur à lancer. Vide = le premier trouvé (Chrome, Chromium, Edge, Brave). */
		browserCommand: string;
		/** Le serveur MCP des gestes de navigateur. Vide = celui de Playwright. */
		browserServer: string;
		/** L'agent de revue travaille en lecture seule. Vrai par défaut. */
		reviewReadOnly: boolean;
		/** Le dossier de livraison part sur la pull request d'une mission. Vrai par défaut. */
		deliveryDossier: boolean;
	};
	/** Comment le cockpit lit les changements en vol. */
	impact: {
		/** Ce que fait le produit, et pour qui — transmis tel quel à l'analyse. */
		brief: string;
		engine: string;
		model: string;
		depth: string;
		/** `null` = jamais choisi, ce qui vaut « oui ». */
		includeLocalBranches: boolean | null;
	};
	/** Ce qu'un agent reçoit en plus de la consigne, au lancement. */
	brief: BriefConfig;
	/** Ce que ce projet veut voir rester vrai. */
	properties: Property[];
	/** Ses commandes maison, déclarées ou détectées. */
	commands: RepoCommand[];
	/** Ce que la Permanence surveille, et ce qu'elle s'autorise. */
	permanence: PermanenceConfig;
	/** Ce qu'une mission a le droit de coûter. */
	missions: MissionsConfig;
	/** Où un agent a le droit de tourner — en direct, ou isolé dans un conteneur. */
	sandbox: SandboxConfig;
	/** Catalogue des rôles confiés aux exécutants. */
	roles: Role[];
	/** Moteurs d'agents déclarés — au moins celui d'origine. */
	engines: Engine[];
	/** Les comptes installés sur ce poste, celui du poste en tête. */
	accounts: Account[];
	/** Celui sous lequel le projet actif travaille, héritage appliqué. */
	account: string;
	/** L'équipe du projet : qui la compose, et sous quels comptes. */
	team: {
		linearTeamId: string;
		members: TeamMember[];
	};
}

/**
 * Ce que le cockpit trouve à un emplacement, avant d'en faire un projet.
 *
 * Ouvrir un projet demande un dossier, un dépôt git et parfois une forge : dire
 * lesquels manquent vaut mieux que refuser en bloc.
 */
export interface Ground {
	/** Le chemin tel que le cockpit l'a compris — tilde développé, nom résolu. */
	path: string;
	exists: boolean;
	isRepo: boolean;
	/** Le dossier existe et contient déjà quelque chose. */
	occupied: boolean;
	remote: string;
	/** `propriétaire/dépôt` déduit du serveur. */
	slug: string;
	/** Les comptes GitHub dont une session `gh` existe sur ce poste. */
	accounts: string[];
}

/** Ce qu'on demande au cockpit de préparer avant d'ouvrir un projet. */
export interface Groundwork {
	path: string;
	createDir?: boolean;
	gitInit?: boolean;
	createRemote?: boolean;
	account?: string;
	repo?: string;
	/** Privé par défaut : un dépôt public créé par inadvertance ne se dé-publie pas. */
	public?: boolean;
}

/**
 * Ce qu'une mission a le droit de coûter.
 *
 * Les missions sont ce qui consomme le plus : la boucle lance les tâches prêtes
 * toutes les six secondes, et le parallélisme était borné, pas la dépense.
 */
export interface MissionsConfig {
	/** Au-delà, la mission se met en pause. 0 = le défaut (500 000). */
	tokenBudget: number;
	/** Sous ce pourcentage de quota restant, aucune tâche ne démarre. 0 = 15 %. */
	quotaFloorPercent: number;
	/** Au-delà de ce pourcentage de mémoire machine utilisée, aucun agent ne
	 *  démarre. 0 = le défaut (85 %). */
	memoryCeilingPercent: number;
	/** Le maître découpe directement, sans faire valider compréhension ni approche. */
	autonomous: boolean;
}

/** Isoler un agent dans un conteneur, avec un plafond mémoire imposé par
 *  l'OS. Off par défaut : une intégration de plus, pas un prérequis. */
export interface SandboxConfig {
	enabled: boolean;
	/** `orb` ou `docker`. Vide = détecté sur le poste. */
	runtime: string;
	/** Image utilisée pour lancer un agent. Vide = l'image par défaut du cockpit. */
	image: string;
	/** Mégaoctets alloués à chaque agent. 0 = le défaut (4096). */
	memoryMb: number;
	/** Cœurs alloués à chaque agent. 0 = pas de limite. */
	cpus: number;
}

// ─────────────────────────────── La Permanence ───────────────────────────────

/**
 * D'où l'oracle d'un engagement tire sa preuve.
 *
 * `command` sort en 0, `property` rend un verdict avec sa preuve `fichier:ligne`,
 * `ci` est `success`. Un `kind` ou une `key` vide veut dire « pas d'oracle » —
 * et une règle sans oracle ne démarre pas.
 */
export interface Oracle {
	kind: "" | "command" | "property" | "ci" | "comment";
	key: string;
}

/**
 * Les signaux que la boucle sait regarder.
 *
 * Du programme, pas du métier : ils décrivent ce que le cockpit observe déjà
 * (`monitor::Change`, `properties::audit`, les tickets Linear assignés), là où
 * la condition, la réaction et l'oracle d'une règle viennent du dépôt. Un
 * déclencheur inconnu rend la règle inapplicable plutôt que de la faire
 * disparaître.
 */
export const TRIGGERS = [
	{
		id: "ci_red",
		get label() {
			return t("lib:types.triggers.ci_red.label");
		},
		get hint() {
			return t("lib:types.triggers.ci_red.hint");
		},
	},
	{
		id: "review_changes_requested",
		get label() {
			return t("lib:types.triggers.review_changes_requested.label");
		},
		get hint() {
			return t("lib:types.triggers.review_changes_requested.hint");
		},
	},
	{
		id: "pr_stale",
		get label() {
			return t("lib:types.triggers.pr_stale.label");
		},
		get hint() {
			return t("lib:types.triggers.pr_stale.hint");
		},
	},
	{
		id: "schedule",
		get label() {
			return t("lib:types.triggers.schedule.label");
		},
		get hint() {
			return t("lib:types.triggers.schedule.hint");
		},
	},
	{
		id: "linear_assigned",
		get label() {
			return t("lib:types.triggers.linear_assigned.label");
		},
		get hint() {
			return t("lib:types.triggers.linear_assigned.hint");
		},
	},
] as const;

/** Ce qui réveille la Permanence, et ce qu'elle a le droit d'en faire. */
export interface PermanenceRule {
	id: string;
	label: string;
	/** Livrée éteinte, toujours. */
	enabled: boolean;
	/** Le signal observé, parmi ce que la boucle sait regarder. */
	trigger: string;
	/** Ce qui doit être vrai en plus du signal — jugé au tri. */
	condition: string;
	reaction: string;
	/** Pour `schedule` et `pr_stale` : le délai en heures. 0 = 24 h / 72 h. */
	everyHours: number;
	oracle: Oracle;
	/**
	 * Cette règle redemande ton accord avant que le travail ne parte.
	 *
	 * La Permanence approuve normalement elle-même le plan des missions qu'elle
	 * ouvre — le consentement a été donné une fois, à la règle. Ce drapeau le
	 * rend à la mission, sans remettre tout le dispositif en question.
	 */
	needsApproval: boolean;
	tokenBudget: number;
	perHour: number;
}

/**
 * Les quatre portes qui ouvrent une PR au commentaire.
 *
 * Le consentement porte sur l'objet, pas sur le pouvoir : on n'autorise pas
 * « commenter », on autorise « commenter là ».
 */
export const COMMENT_SCOPES = [
	{
		id: "i_commented",
		get label() {
			return t("lib:types.commentScopes.i_commented");
		},
	},
	{
		id: "i_allowed",
		get label() {
			return t("lib:types.commentScopes.i_allowed");
		},
	},
	{
		id: "hers",
		get label() {
			return t("lib:types.commentScopes.hers");
		},
	},
	{
		id: "mine",
		get label() {
			return t("lib:types.commentScopes.mine");
		},
	},
] as const;

/** Signature apposée en fin de commentaire. Non configurable, côté Rust aussi. */
export const COMMENT_SIGNATURE = "— la Permanence";

export interface CommentPower {
	enabled: boolean;
	/** Conditions retenues parmi `COMMENT_SCOPES`. Vide = nulle part. */
	scopes: string[];
	/** Au plus tant de commentaires par PR et par jour. 0 = le défaut (1). */
	perDay: number;
}

/** Ce qu'elle ne fera jamais, quoi qu'on coche — en dur, ici comme en Rust. */
export const NEVER: readonly string[] = lazyList(() =>
	["review", "assign", "close", "merge", "deploy"].map((key) => t(`lib:types.never.${key}`)),
);

/**
 * Les gestes qu'on peut lui confier, un par un.
 *
 * `id` correspond à ce que la couche d'outils exposera. Ce catalogue est du
 * programme, pas du métier : il décrit ce que le cockpit sait faire, là où les
 * règles et les oracles viennent du dépôt.
 */
export const POWERS = [
	{
		id: "rerun_pipeline",
		get label() {
			return t("lib:types.powers.rerun_pipeline");
		},
	},
	{
		id: "create_branch",
		get label() {
			return t("lib:types.powers.create_branch");
		},
	},
	{
		id: "open_draft_pr",
		get label() {
			return t("lib:types.powers.open_draft_pr");
		},
	},
	{
		id: "set_label",
		get label() {
			return t("lib:types.powers.set_label");
		},
	},
	{
		id: "open_worktree",
		get label() {
			return t("lib:types.powers.open_worktree");
		},
	},
	{
		id: "start_agent",
		get label() {
			return t("lib:types.powers.start_agent");
		},
	},
	{
		id: "run_command",
		get label() {
			return t("lib:types.powers.run_command");
		},
	},
	{
		id: "open_mission",
		get label() {
			return t("lib:types.powers.open_mission");
		},
	},
] as const;

/**
 * Les gestes que le cockpit sait réellement poser.
 *
 * Tout `POWERS` y figure désormais. La liste reste : cocher une case qui ne
 * fait rien est pire que ne pas l'afficher, et le jour où l'on ajoute un
 * pouvoir sans l'implémenter, l'écran doit le dire.
 */
export const IMPLEMENTED_POWERS: string[] = POWERS.map((power) => power.id);

export interface PermanenceConfig {
	/** Désactivée par défaut, et l'entrée quitte alors le rail. */
	enabled: boolean;
	/** `HH:MM-HH:MM`. Vide = toujours. */
	hours: string;
	/** 0 = le défaut (2 min). */
	cadenceMinutes: number;
	/** Rattraper l'absence, ou déclarer forfait en disant ce qui a été sauté. */
	catchUp: boolean;
	/** 0 = les défauts (200k jetons, 20 engagements). */
	dailyTokens: number;
	dailyEngagements: number;
	/**
	 * Engagements menés de front. **Un seul par défaut**, et c'est le garde-fou
	 * le plus fort : le plafond journalier ne protège pas d'une rafale.
	 */
	maxRunning: number;
	/** Engagements joués à blanc avant qu'elle n'agisse. 0 = le défaut (10). */
	rehearsal: number;
	/** Heures pendant lesquelles un objet traité est laissé tranquille. 0 = 6. */
	graceHours: number;
	/** Échecs consécutifs avant qu'elle ne se suspende elle-même. 0 = 3. */
	breaker: number;
	/** Elle se met au repos sous ce pourcentage de quota restant. 0 = 15 %. */
	quotaFloorPercent: number;
	notifyFailures: boolean;
	notifyAll: boolean;
	/** 0 = le défaut (14 jours). */
	retentionDays: number;
	engine: string;
	/** Le tri : 95 % des appels, un petit modèle. */
	triage: Role;
	/** Le travail : seulement quand un engagement démarre. */
	work: Role;
	/** Consigne permanente, jointe au contexte de chaque engagement. */
	prompt: string;
	rules: PermanenceRule[];
	/** Liste blanche, vide par défaut. */
	powers: string[];
	comment: CommentPower;
	/** Pull requests ouvertes nommément au commentaire. La trace des « oui, ici ». */
	allowedPrs: number[];
}

/**
 * Pourquoi la boucle n'a rien regardé.
 *
 * Une valeur par porte, jamais un simple booléen : « elle ne fait rien » est
 * une réponse inutilisable, là où « hors des heures déclarées » se corrige en
 * dix secondes.
 */
export type PermanenceClosed =
	| "disabled"
	| "suspended"
	| "offHours"
	| "capped"
	| "quota"
	/** Elle s'est arrêtée elle-même. Distinct de `suspended`, qui est ton geste. */
	| "tripped";

/** Un signal vu par la boucle, et ce qu'elle en a fait. */
export interface PermanenceSignal {
	key: string;
	project: string;
	source: string;
	label: string;
	/** Le déclencheur reconnu ; vide = un delta qui ne ressemble à rien de nommable. */
	trigger: string;
	at: number;
	/** Pourquoi il n'a rien produit. Vide quand il a été retenu. */
	dropped: string;
	/** La règle retenue par le tri. Vide tant qu'il n'a pas tranché. */
	rule: string;
	/** Le tri l'a retenu : il attend un engagement. */
	retained: boolean;
	/** Le tri ne l'a pas encore regardé. */
	pending: boolean;
}

/** Ce qu'un regard a donné — le battement de cœur. */
export interface PermanenceLook {
	at: number;
	/** La porte qui a bloqué ; `null` quand la boucle a bien regardé. */
	closed: PermanenceClosed | null;
	seen: number;
	fresh: number;
	/** Sources qui n'ont pas répondu : un regard partiel qui se tait ment. */
	blind: string[];
}

export interface PermanenceState {
	/** Suspendue d'un geste — distinct de « désactivée », qui est un réglage. */
	suspended: boolean;
	lastLook: PermanenceLook | null;
	since: number;
	/** Vrai tant qu'aucun regard n'a posé le curseur. */
	cold: boolean;
	signals: PermanenceSignal[];
	skipped: number;

	/** Objets laissés tranquilles jusqu'à cette date (epoch, en secondes). */
	quarantine: Record<string, number>;
	/** Engagements à blanc restants avant qu'elle n'agisse pour de vrai. */
	rehearsalLeft: number;
	/** L'empreinte des pouvoirs sur laquelle le rodage a été armé ; `null` = jamais. */
	armedOn: string | null;
	/** Échecs consécutifs. Le premier succès remet à zéro. */
	failures: number;
	/** Le coupe-circuit a sauté, et pourquoi. Vide sinon. */
	tripped: string;
	/** Les engagements, les plus récents d'abord. */
	engagements: Engagement[];
	/** Ce qu'elle tient en ce moment : agents lancés, missions ouvertes. */
	holds: PermanenceHold[];
}

/** Où en est un engagement. */
export type PermanenceStage = "planning" | "running" | "done" | "abandoned";

/**
 * Ce que l'oracle a dit. **Quatre valeurs, pas deux.**
 *
 * Confondre `undecided` avec `reached` transformerait une panne en succès —
 * c'est le mode de défaillance le plus coûteux du dispositif.
 */
export type PermanenceVerdict =
	| "pending"
	| "reached"
	| "missed"
	| "offTopic"
	| "undecided"
	/** Joué à blanc : elle a dit ce qu'elle aurait fait, rien n'a été fait. */
	| "rehearsed";

/** Une étape, avec son résultat — pas seulement son intention. */
export interface PermanenceStep {
	at: number;
	what: string;
	result: string;
	ok: boolean;
}

/** Ce qui existe maintenant et n'existait pas. */
export interface PermanenceProduced {
	/** `branch` · `pr` · `mission` · `comment` · `label`. */
	kind: string;
	/** Ce que c'est, en clair. */
	label: string;
	/** La référence technique — identifiant de mission, nom du label. */
	reference: string;
	url: string;
	/** Le cockpit sait le défaire. */
	undoable: boolean;
}

export interface Engagement {
	id: string;
	rule: string;
	key: string;
	label: string;
	trigger: string;
	/** Une phrase, écrite par l'agent. */
	goal: string;
	oracle: Oracle;
	stage: PermanenceStage;
	verdict: PermanenceVerdict;
	/** Pourquoi ce verdict. Toujours là quand ce n'est pas « atteint ». */
	why: string;
	steps: PermanenceStep[];
	produced: PermanenceProduced[];
	mission: string;
	rehearsal: boolean;
	startedAt: number;
	endedAt: number;
	costUsd: number;
}

/** Quelque chose que la Permanence a mis en route et peut couper. */
export interface PermanenceHold {
	/** `agent` — une session du CLI. `mission` — une mission ouverte. */
	kind: string;
	id: string;
	label: string;
	since: number;
}

/**
 * Ce qu'un arrêt d'urgence a réellement coupé.
 *
 * Un bouton d'urgence qui ne dit pas ce qu'il a fait laisse dans le doute au
 * pire moment : on reclique, ou on croit que c'est arrêté alors qu'il restait
 * quelque chose.
 */
export interface PermanenceHalt {
	state: PermanenceState;
	stopped: string[];
	/** Ce qui n'a pas pu être coupé, et pourquoi. Jamais tu. */
	failed: string[];
}

// ─────────────────────────────── Accès mobile ───────────────────────────────

export interface RemoteDevice {
	id: string;
	name: string;
	node: string;
	createdAt: string;
	lastSeen: string;
}

export interface RemoteStatus {
	enabled: boolean;
	/** Nom de la machine dans le tailnet ; vide si Tailscale ne répond pas. */
	host: string;
	/** Vrai quand un Funnel expose la machine sur Internet. */
	funnel: boolean;
	ntfyServer: string;
	ntfyTopic: string;
	/** Vrai quand un jeton de publication est enregistré ; sa valeur ne descend jamais. */
	ntfyAuthenticated: boolean;
	/** Verdict de la dernière tentative de réveil du téléphone. */
	lastWake: { ok: boolean; detail: string; at: string } | null;
	devices: RemoteDevice[];
	serveCommand: string;
}

// ──────────────────────────────── Missions ────────────────────────────────










/**
 * Un moteur d'agent : le programme qui fait tourner un agent.
 *
 * Le cockpit ne parle pas à un modèle, il pilote un agent — quelque chose qui
 * lit, écrit et lance des commandes. Une clé d'API ne fait rien de cela ; c'est
 * le programme qui l'exécute. D'où `command`, et `env` pour ce qu'il faut lui
 * mettre dans l'environnement — l'adresse d'un service compatible, un jeton.
 */
export interface Engine {
	id: string;
	label: string;
	/** Binaire à lancer ; vide = `claude` cherché aux emplacements connus. */
	command: string;
	/** Protocole de dialogue ; seul `claude-stream-json` est implémenté. */
	protocol: string;
	models: string[];
	env: Array<{ name: string; value: string }>;
	extraArgs: string;
	/**
	 * Ce que ce moteur ajoute à sa ligne de commande pour chaque profondeur.
	 *
	 * Le cockpit ne connaît pas les drapeaux des moteurs : il exprime une
	 * intention, chacun dit ici comment il l'obtient. Vide = ce moteur ne sait
	 * pas, et le réglage se grise plutôt que de partir dans le vide.
	 */
	depthFast: string;
	depthNormal: string;
	depthDeep: string;
}

/**
 * Un compte sous lequel les agents travaillent.
 *
 * Distinct du moteur, qui est le programme : le même `claude` sert deux projets
 * sous deux identités. Tout tient dans `dir` — Claude Code y range ses jetons
 * comme ses conversations, et le cockpit ne fait que désigner lequel.
 */
export interface Account {
	id: string;
	label: string;
	/** Dossier de configuration ; vide = celui du poste. */
	dir: string;
}

/** Ce qu'un compte répond quand on lui demande qui il est. */
export interface AccountStatus extends Account {
	/** Dossier réellement lu, tilde résolu. */
	resolvedDir: string;
	loggedIn: boolean;
	email: string;
	/** `max`, `pro`, `team`… tel que le CLI le nomme. */
	plan: string;
	organization: string;
	/** Les projets rattachés à ce compte, par leur nom. */
	projects: string[];
	/** Ce qui a empêché de répondre, le cas échéant. */
	error: string;
}

export interface Role {
	id: string;
	label: string;
	prompt: string;
	model: string;
	/** Moteur qui fait tourner ce rôle ; vide = le premier déclaré. */
	engine: string;
	permissionMode: string;
	/** Profondeur de réflexion : `fast`, `normal`, `deep` ou vide. */
	depth: string;
	/**
	 * Commande lancée en tête de la consigne — une skill du dépôt, typiquement.
	 * `{ticket}`, `{ticketUrl}`, `{branch}`, `{mission}`, `{task}` et `{brief}`
	 * y sont remplacés au lancement.
	 */
	command: string;
	/** Ce rôle juge le travail des autres : il attend qu'ils aient livré. */
	verifies: boolean;
	scope: string[];
}

/**
 * Un membre de l'équipe, tel qu'il faut le reconnaître dans chaque outil.
 *
 * Trois services, trois identités : Linear par un UUID, GitHub par un login (et
 * ses anciens comptes), Sentry par l'email ou le nom du compte. Sans ces
 * correspondances, un ticket réassigné ou une erreur de prod ne se rattachent à
 * personne.
 */
export interface TeamMember {
	name: string;
	/** `dev` ou `product` : seuls les devs sont attendus sur des PR. */
	role: string;
	roleLabel: string;
	linearId: string;
	github: string;
	githubAliases: string[];
	sentryEmails: string[];
	sentryNames: string[];
}

/** Un service branché sur le cockpit, et ce qui lui manque le cas échéant. */
export interface Connector {
	id: string;
	label: string;
	/** `repository` | `tickets` | `ci` | `monitoring` | `deploy` | `payments` */
	kind: string;
	configured: boolean;
	/** Ce qui manque, dit en clair. */
	missing: string;
}

/** Ce que le suivi de tâches configuré sait faire. */
export interface TicketProviderInfo {
	/** Nom affiché : « Linear », « Issues », « Jira »… */
	label: string;
	capabilities: {
		priority: boolean;
		richStates: boolean;
		estimate: boolean;
		branchName: boolean;
		/** Des cycles ou sprints : sans eux, pas d'identifiant d'équipe à réclamer. */
		cycles: boolean;
	};
}

/** Ce que fabrique un agent en ce moment — l'état vécu, pas l'état stocké. */
export interface AgentActivity {
	sessionId: string;
	running: boolean;
	/** A écrit dans les dernières secondes. */
	working: boolean;
	/** Sa dernière phrase, ou le dernier outil appelé. */
	last: string;
	/** Demandes d'autorisation en attente pour cet agent. */
	waiting: number;
}

export interface MissionActivity {
	master: AgentActivity | null;
	tasks: Array<{ taskId: string; activity: AgentActivity }>;
}

/* ── Impact : ce qui bouge, et ce qu'on en a compris ───────────────────── */

/** Un changement en vol, quelle que soit la forge qui le porte. */
export interface Change {
	/** Clé stable, et seul lien avec l'analyse. */
	key: string;
	project: string;
	projectName: string;
	projectColor: string;
	forge: "github" | "gitlab" | "local";
	repo: string;
	/** `#412`, `!17`, ou le nom de la branche. */
	reference: string;
	title: string;
	author: string;
	branch: string;
	base: string;
	url: string;
	draft: boolean;
	/** Tête de la branche : c'est elle qui scelle une analyse. */
	headSha: string;
	/** `null` quand la forge ne compte pas les lignes — GitLab, notamment. */
	additions: number | null;
	deletions: number | null;
	changedFiles: number | null;
	ci: "success" | "failing" | "pending" | "none";
	review: "approved" | "changes_requested" | "review_required" | "";
	/** Identifiants à qui la revue a été demandée — vide sur GitLab et en local. */
	reviewRequested: string[];
	updatedAt: string;
	worktree: string;
	repoPath: string;
	/**
	 * Étiquettes de la forge, telles que le recensement les rend.
	 *
	 * `Tag` et non `PrLabel` : le champ s'appelle `label`, pas `name`. Les avoir
	 * confondus faisait lire `undefined.trim()` dans `Chips` et emportait tout
	 * l'écran — une page blanche pour une étiquette.
	 */
	labels: Tag[];
	analysis: ImpactSummary | null;
}

/** Ce qu'un écran peut réparer lui-même, quand le cockpit connaît la bonne valeur. */
export interface ScanFix {
	/** Ce que le bouton annonce. */
	label: string;
	/** Projet auquel appliquer le correctif. */
	project: string;
	/** Patch de configuration, même forme que celui des réglages. */
	patch: Record<string, unknown>;
}

/** Une source qui n'a pas répondu, et pourquoi. */
export interface ScanNote {
	source: string;
	message: string;
	/** La correction, quand le cockpit sait laquelle appliquer. */
	fix?: ScanFix;
}

export interface ImpactScan {
	changes: Change[];
	notes: ScanNote[];
}

/** Ce qu'une analyse laisse voir depuis la carte. */
export interface ImpactSummary {
	key: string;
	headSha: string;
	/** Secondes epoch. */
	at: number;
	risk: "faible" | "moyen" | "élevé" | "";
	verdict: "ok" | "réserves" | "bloquant" | "";
	/** La phrase en clair : ce que ça change, sans avoir lu le code. */
	headline: string;
	riskCount: number;
	checkCount: number;
	durationSeconds: number;
	costUsd: number;
	engine: string;
	model: string;
}

export interface ImpactPoint {
	text: string;
	severity: Severity | "neutral";
}

export interface ImpactSection {
	/** `produit` · `pourquoi` · `choix` · `risques` · `verifier` · `mieux` · `autre`. */
	id: string;
	title: string;
	body: string;
	points: ImpactPoint[];
}

export interface ImpactAnalysis extends ImpactSummary {
	title: string;
	branch: string;
	url: string;
	sections: ImpactSection[];
	/** Le rapport complet, pour qui veut tout lire. */
	raw: string;
	/** Le dossier factuel envoyé à l'agent. */
	briefPath: string;
}

// ─────────────────────────── Mesurer la boucle ───────────────────────────

/** Une population de rendus, et ce qu'elle a coûté en reprises. */
export interface HandbackSide {
	delivered: number;
	takenBack: number;
	rate: number;
}

/** Ce que les agents ont livré, et ce qu'il a fallu reprendre. */
export interface HandbackStats {
	delivered: number;
	takenBack: number;
	/** Part des rendus repris à la main, en pourcentage entier. */
	rate: number;
	since: number;
	pending: number;
	/** Le même taux selon qu'un dossier de contexte était parti ou non. */
	briefed: HandbackSide;
	plain: HandbackSide;
	/** Assez d'observations des deux côtés pour qu'un écart veuille dire quelque chose. */
	comparable: boolean;
}

export interface TurnStats {
	sessions: number;
	/** Médiane des messages humains par conversation. */
	median: number;
	longHaul: number;
	withError: number;
}

export interface GuardrailStats {
	properties: number;
	calibrated: number;
	/** Éprouvées sans rien attraper : elles rassurent sans garantir. */
	decorative: number;
	audits: number;
	breaches: number;
	panels: number;
	disputes: number;
}

export interface MemoryStats {
	lessons: number;
	uses: number;
	idle: number;
	stale: number;
}

/** Ce que le cockpit a fait en ton nom, par nature d'action. */
export interface Deed {
	kind: string;
	count: number;
	failed: number;
	/** Qui a agi : `me` ou `permanence`. */
	actor: string;
}

/**
 * L'état de la boucle d'orchestration.
 *
 * Aucun de ces chiffres n'est un objectif : les prendre pour tels produirait
 * exactement ce qu'on cherche à éviter — moins de reprises parce qu'on relit
 * moins.
 */
export interface Metrics {
	windowDays: number;
	handbacks: HandbackStats;
	turns: TurnStats;
	guardrails: GuardrailStats;
	memory: MemoryStats;
	deeds: Deed[];
	warnings: string[];
}

// ─────────────────────── Commandes maison du dépôt ───────────────────────

/** Une option d'une commande maison, telle qu'elle s'affiche. */
export interface CommandOption {
	id: string;
	/** Drapeau transmis tel quel : `--force`, `--from`. */
	flag: string;
	label: string;
	/** `boolean` · `text` · `number` · `select`. */
	kind: string;
	hint: string;
	placeholder: string;
	choices: string[];
	defaultValue: string;
}

export interface CommandPositional {
	label: string;
	placeholder: string;
	required: boolean;
	hint: string;
}

/**
 * Une commande qu'on ne retape pas de mémoire : à options, à drapeaux, ou qui
 * monte quelque chose. Déclarée par projet, jamais fournie par le cockpit.
 */
export interface RepoCommand {
	id: string;
	group: string;
	label: string;
	description: string;
	/** La commande sans argument ni option. */
	base: string;
	positional: CommandPositional | null;
	options: CommandOption[];
	/** Vrai : elle tourne dans le worktree choisi ; faux : dans le dépôt principal. */
	scoped: boolean;
	danger: boolean;
}

// ─────────────────────────── Ce qui doit rester vrai ───────────────────────────

/** Une propriété que ce dépôt veut voir tenir, écrite en français. */
export interface Property {
	id: string;
	text: string;
	/** Fichiers ou dossiers concernés ; vide = tout le dépôt. */
	scope: string[];
}

/** Le verdict d'une propriété sur un changement. */
export interface PropertyCheck {
	propertyId: string;
	text: string;
	/** `tenue` · `enfreinte` · `hors sujet` · `indécis`. */
	verdict: string;
	/** `fichier:ligne`, autant que l'agent a pu en donner. */
	evidence: string[];
	note: string;
	costUsd: number;
}

export interface PropertyAudit {
	key: string;
	headSha: string;
	at: number;
	checks: PropertyCheck[];
	costUsd: number;
	durationSeconds: number;
}

/** Une correction du dépôt rejouée contre une propriété. */
export interface CalibrationSample {
	sha: string;
	subject: string;
	/** La propriété aurait-elle signalé le problème avant cette correction ? */
	caught: boolean;
	note: string;
}

/**
 * Ce qu'une propriété vaut, mesuré sur de vraies corrections.
 *
 * `caught === 0` sur un `tried` non nul : la propriété est décorative, elle
 * rassure sans rien garantir.
 */
export interface Calibration {
	propertyId: string;
	at: number;
	tried: number;
	caught: number;
	samples: CalibrationSample[];
	costUsd: number;
}

/** Une propriété proposée d'après l'historique du dépôt. */
export interface PropertySuggestion {
	text: string;
	scope: string[];
	/** La correction qui la justifie — c'est ce qui permet de la juger. */
	why: string;
}

// ────────────────────────────── Carnet du projet ──────────────────────────────

/** Une règle retenue après avoir repris du travail à la main. */
export interface Lesson {
	id: string;
	text: string;
	/** Fichiers ou dossiers concernés ; vide = tout le dépôt. */
	scope: string[];
	/** `reprise` (tirée d'une correction) · `main` (écrite à la main). */
	source: string;
	project: string;
	at: number;
	/** Combien de fois elle est partie avec un agent. */
	uses: number;
	lastUsed: number;
}

/**
 * Une reprise en main relevée : ce qu'un humain a changé après le rendu d'un
 * agent, alors qu'aucun agent ne tournait.
 */
export interface Handback {
	id: string;
	cwd: string;
	project: string;
	branch: string;
	at: number;
	files: string[];
	patch: string;
}

// ────────────────────────────── Confrontation ──────────────────────────────

/** Ce qu'un angle de lecture a conclu, à lui seul. */
export interface PanelVoice {
	lens: string;
	label: string;
	verdict: "ok" | "réserves" | "bloquant" | "";
	risk: "faible" | "moyen" | "élevé" | "";
	summary: string;
	points: string[];
	costUsd: number;
}

/**
 * Un point sur lequel les lectures ne disent pas la même chose.
 *
 * C'est la seule chose que la confrontation demande de lire : là où les angles
 * convergent, il n'y a rien à trancher.
 */
export interface PanelDispute {
	claim: string;
	heldBy: string[];
	against: string[];
	/** La conséquence si le camp qu'on n'a pas suivi avait raison. */
	why: string;
	/** Le geste qui règle la question. */
	check: string;
}

export interface Panel {
	key: string;
	headSha: string;
	at: number;
	/** Le plus sévère des verdicts rendus, jamais le plus fréquent. */
	verdict: "ok" | "réserves" | "bloquant" | "";
	agreed: string;
	disputes: PanelDispute[];
	voices: PanelVoice[];
	/** Les angles qui n'ont pas répondu, avec leur motif. */
	silent: string[];
	costUsd: number;
	durationSeconds: number;
}

/**
 * De quoi est rempli le contexte d'un agent, tel que le CLI le compte.
 *
 * Même source que `/context` (requête de contrôle `get_context_usage`), allégée
 * côté natif (`chantier::slim`). Ce sont des chiffres **rapportés**, pas des
 * estimations du cockpit — à l'exception près que le CLI lui-même qualifie sa
 * répartition d'« estimée » : le total, lui, est exact.
 */
export interface ContextUsage {
	totalTokens: number;
	maxTokens: number;
	percentage: number;
	model?: string;
	autoCompactThreshold?: number;
	isAutoCompactEnabled?: boolean;
	categories: Array<{ name: string; tokens: number; kind: "used" | "deferred" | "buffer" | "free" | string }>;
	memoryFiles?: Array<{ path: string; type: string; tokens: number }>;
	mcpServers: Array<{ name: string; tokens: number; loaded: number; deferred: number }>;
	skills?: { total: number; tokens: number };
	messages?: {
		toolCallTokens?: number;
		toolResultTokens?: number;
		assistantMessageTokens?: number;
		userMessageTokens?: number;
		toolCallsByType?: Array<{ name: string; callTokens: number; resultTokens: number }>;
	};
	/** Quand la mesure a été reçue. */
	at: number;
}

export interface FileStamp {
	path: string;
	/** `null` : le fichier n'existe plus. */
	modifiedMs: number | null;
}

export interface Territory {
	root: string;
	files: Array<{ path: string; bytes: number }>;
	truncated: boolean;
}

/** Un point relevé par une revue de code. */
export interface ReviewFinding {
	id: string;
	severity: "bloquant" | "important" | "suggestion" | string;
	file: string;
	/** `42` ou `42-57`, dans la version de la PR. */
	lines: string;
	problem: string;
	fix: string;
	/** Le commentaire à poster soi-même sur la PR. */
	comment: string;
}

export interface ReviewCheck {
	id: string;
	status: "corrige" | "partiel" | "non_corrige" | string;
	note: string;
}

export interface ReviewRound {
	number: number;
	kind: "revue" | "verification" | string;
	at: string;
	headSha: string;
	summary: string;
	verdict: "merge" | "corrections" | "bloquant" | string;
	findings: ReviewFinding[];
	checks: ReviewCheck[];
}

/** La revue d'une PR : ses tours, et ce qu'on en a déjà posté. */
export interface Review {
	repo: string;
	number: number;
	title: string;
	author: string;
	branch: string;
	base: string;
	url: string;
	rounds: ReviewRound[];
	posted: string[];
}

export interface ReviewPrepared {
	number: number;
	title: string;
	author: string;
	branch: string;
	base: string;
	url: string;
	headSha: string;
	worktree: string | null;
	prompt: string;
	warning: string | null;
}

/** Ce qu'on sait d'un dossier avant d'y lancer un agent libre. */
export interface LibreInspection {
	/** Chemin absolu, tilde résolu. */
	path: string;
	exists: boolean;
	isGit: boolean;
	/** Racine du dépôt quand le dossier en fait partie. */
	root: string;
	/** Branche sortie ; vide sur une HEAD détachée. */
	branch: string;
	/** Fichiers modifiés ou non suivis. */
	dirty: number;
}

/** Où travaillera l'agent libre, une fois sa branche ou son worktree prêts. */
export interface LibrePrepared {
	cwd: string;
	branch: string;
	/** Worktree créé pour lui ; vide s'il travaille sur place. */
	worktree: string;
}

// Dérivés du Rust par ts-rs (`cargo test`, voir src-tauri/.cargo/config.toml) :
// ne pas les redéfinir ici, les changer côté Rust.
export type { MissionState } from "./generated/MissionState";
export type { TaskState } from "./generated/TaskState";
export type { MissionTask } from "./generated/MissionTask";
export type { TaskGate } from "./generated/TaskGate";
export type { MissionStep } from "./generated/MissionStep";
export type { MissionDraft } from "./generated/MissionDraft";
export type { MissionReview } from "./generated/MissionReview";
export type { Mission } from "./generated/Mission";
export type { MissionEvent } from "./generated/MissionEvent";
export type { MissionChange } from "./generated/MissionChange";
export type { MissionExposure } from "./generated/MissionExposure";
export type { RepoRoles } from "./generated/RepoRoles";
export type { MissionEstimate } from "./generated/MissionEstimate";
export type { MissionOverrun } from "./generated/MissionOverrun";
export type { ReadinessCheck } from "./generated/ReadinessCheck";
export type { Readiness } from "./generated/Readiness";
export type { DeliveryDossier } from "./generated/DeliveryDossier";

// ── Méthodes : les plugins Claude Code (`methods.rs`) ───────────────────────

export interface MethodInstalled {
	id: string;
	version: string;
	/** `user`, `project` ou `local`. */
	scope: string;
	enabled: boolean;
	installPath: string;
	installedAt: string;
}

export interface MethodSource {
	source: string;
	url: string;
	repo: string;
	path: string;
	ref: string;
	sha: string;
}

export interface MethodAvailable {
	pluginId: string;
	name: string;
	description: string;
	marketplaceName: string;
	source: MethodSource;
	installCount: number;
}

export interface MethodCatalog {
	installed: MethodInstalled[];
	available: MethodAvailable[];
}

export interface MethodInspection {
	inventory: {
		name: string;
		description: string;
		version: string;
		skills: string[];
		agents: string[];
		commands: string[];
		/** Ce qui s'exécute sur le poste. */
		hooks: Array<{ event: string; command: string }>;
		servers: Array<{ name: string; target: string }>;
		scripts: string[];
		/** Empreinte de ce qui s'exécute ; vide quand rien ne s'exécute. */
		fingerprint: string;
	};
	alwaysOnTokens: number | null;
	source: MethodSource;
	/** L'empreinte approuvée en l'installant d'ici ; différente de l'actuelle =
	    ce qui s'exécute a changé depuis ton accord. */
	approved: string | null;
}

export type MethodInstallation =
	| { kind: "installed"; message: string }
	| { kind: "needsCommand"; command: string; sha256: string };

export interface MethodPeriod {
	executions: number;
	failed: number;
	medianTurns: number | null;
	medianCostUsd: number | null;
}

export interface MethodMeasure {
	since: string;
	days: number;
	before: MethodPeriod;
	after: MethodPeriod;
}

// ── Rejeu de l'historique (`replay.rs`) ─────────────────────────────────────

/** Une PR fusionnée, vue comme un cas d'essai. */
export interface ReplayCase {
	number: number | null;
	title: string;
	base: string;
	head: string;
	/** Les fichiers de test de la PR : le juge. */
	tests: string[];
	/** Les autres fichiers touchés : la solution, jamais montrée à l'agent. */
	sources: string[];
}

/** La configuration jugée. */
export interface ReplaySetup {
	label: string;
	engine: string;
	model: string;
	depth: string;
	instructions: string;
}

export type ReplayVerdict =
	| { kind: "resolved" }
	| { kind: "failed"; command: string; output: string }
	| { kind: "notJudgeable"; reason: string };

export interface ReplayTrial {
	at: string;
	number: number | null;
	title: string;
	setup: ReplaySetup;
	judgement: { verdict: ReplayVerdict; agentFiles: string[]; sharedFiles: string[] } | null;
	error: string | null;
	costUsd: number;
	durationMs: number;
}

export interface ReplayProgress {
	repo: string;
	done: number;
	total: number;
}
