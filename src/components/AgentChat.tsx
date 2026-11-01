import { motion } from "motion/react";
import clsx from "clsx";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
	ArrowLeftRight,
	Bot,
	Check,
	ChevronDown,
	CornerDownLeft,
	CornerDownRight,
	Layers,
	MessageCircleQuestion,
	Paperclip,
	Plug,
	Plus,
	PlugZap,
	RotateCw,
	ShieldCheck,
	ShieldOff,
	ShieldQuestion,
	Sparkles,
	Square,
	User,
	Wand2,
	X,
	Route,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { locale, t as i18nT } from "@/i18n";
import { BriefBar } from "@/components/BriefBar";
import { IMAGE_EXTENSIONS, LocalImage } from "@/components/LocalImage";
import { Markdown } from "@/components/Markdown";
import { AgentMap } from "@/components/AgentMap";
import { ProducedFiles } from "@/components/ProducedFiles";
import { QuickMenu, type QuickAction } from "@/components/QuickMenu";
import { actionCourte, ToolCall } from "@/components/ToolCall";
import { Badge, Button, Dot, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import { useFileViewer } from "@/lib/fileViewer";
import { hasTauri } from "@/lib/preview";
import { useReviewFlow } from "@/app/review";
import { reviewIntent } from "@/lib/reviewIntent";
import { useCockpit } from "@/app/store";
import { useAsync, usePersistentState } from "@/lib/useAsync";
import { useStickToBottom } from "@/lib/useStickToBottom";
import { awaitsReply, endsWithQuestion, episodes, summarize, type Episode } from "@/lib/episodes";
import { filmOf } from "@/lib/film";
import { FilmTheater } from "@/components/Film";
import { Planche, plancheOf } from "@/components/Planche";
import { ATTACH_EVENT, type AttachDetail } from "@/components/BrowserAnnotator";
import { splitAttachments, ATTACHMENTS_HEADER } from "@/lib/media";
import { hasWork } from "@/lib/tour";
import { useChangeTour } from "@/components/ChangeTour";
import { NarrationToggle, useNarration } from "@/components/NarrationToggle";
import { withFollows } from "@/lib/threadMarks";
import {
	readQuestions,
	type AgentQuestion,
	type Attachment,
	type Brief,
	type ContextUsage,
	type SlashCommand,
	type UsageLimit,
} from "@/lib/types";
import { slices as contextSlices } from "@/lib/chantier";
import {
	isQuestion,
	modelChoices,
	modelCore,
	modelFamily,
	modelLabel,
	modelQuota,
	PERMISSION_MODES,
	shortModel,
	useAgentActions,
	useAgentGuard,
	type AgentRun,
	type ModelSpec,
	type Turn,
} from "@/app/agents";

/**
 * Le nom de commande en cours de frappe, avec sa position dans le texte.
 *
 * On a d'abord cru qu'une commande ne valait qu'en tête de message ; le CLI la
 * résout en réalité où qu'elle soit — « fais-moi une /code-review » exécute la
 * commande, vérification faite. Le menu s'ouvre donc sur toute barre oblique
 * qui commence un mot, et la complétion ne remplace que ce mot-là.
 *
 * Un début de mot, c'est-à-dire précédée d'un blanc ou rien : sans cette
 * condition, `src/app` ouvrirait le menu sur « app ». L'espace clôt le nom —
 * ce qui suit, ce sont ses arguments, et le menu s'efface pour laisser écrire.
 */
interface CommandDraft {
	/** Ce qui est tapé après la barre oblique. */
	query: string;
	/** Position de la barre oblique : la complétion réécrit à partir de là. */
	at: number;
	/** Vrai quand la barre oblique commence un mot — le cas d'une commande. */
	wordStart: boolean;
}

/**
 * La détection part du curseur, et non de la fin du texte : on écrit rarement un
 * message d'une seule traite, et une commande ajoutée au milieu d'une phrase
 * déjà rédigée ouvrait jusqu'ici un menu vide — la barre oblique n'était plus le
 * dernier caractère de la zone de saisie.
 */
function commandQuery(draft: string, caret: number): CommandDraft | null {
	const upTo = draft.slice(0, Math.min(Math.max(caret, 0), draft.length));
	// La dernière barre oblique avant le curseur, sans blanc entre les deux : au
	// prochain espace, ce qui suit devient les arguments de la commande.
	const match = /\/([^\s/]*)$/.exec(upTo);
	if (!match) return null;
	const before = upTo[match.index - 1];
	return {
		query: match[1],
		at: match.index,
		wordStart: match.index === 0 || /\s/.test(before ?? ""),
	};
}

/**
 * Les commandes intégrées au CLI, qui n'ont pas de fichier à lire.
 *
 * Elles marchent bien dans le mode où le cockpit lance ses agents — vérifié
 * sur `/context`, qui rend son tableau d'occupation — mais rien sur le disque
 * ne les décrit. Cette table ne décide de rien : ce qui existe reste ce que le
 * CLI annonce. Une commande retirée d'une version à l'autre disparaît d'
 * elle-même ; une nouvelle s'affiche sans description, ce qui reste utilisable.
 */
const BUILT_IN: Record<string, string> = {
	agents: "agents",
	clear: "clear",
	compact: "compact",
	config: "config",
	context: "context",
	doctor: "doctor",
	effort: "effort",
	fast: "fast",
	init: "init",
	insights: "insights",
	mcp: "mcp",
	model: "model",
	recap: "recap",
	"reload-skills": "reloadSkills",
	rename: "rename",
	review: "review",
	"security-review": "securityReview",
	usage: "usage",
	"usage-credits": "usageCredits",
};

/**
 * Ce que le CLI accepte, décrit par ce qu'on a su lire des fichiers.
 *
 * Deux sources, et chacune sait ce que l'autre ignore. Le CLI annonce au
 * démarrage la liste exacte de ses commandes — dépôt, personnelles, plugins,
 * et celles que les skills exposent — mais rien de plus que leurs noms. Le
 * balayage des dossiers, lui, en manque plus de la moitié et donne en revanche
 * la description et les arguments attendus.
 *
 * On part donc de la liste du CLI, qui fait foi sur l'existence, et on y
 * accroche ce que le balayage sait. Tant que le CLI n'a pas parlé — agent qui
 * démarre — le balayage sert seul, faute de mieux.
 */
function mergeCommands(scanned: SlashCommand[], announced: string[]): SlashCommand[] {
	if (announced.length === 0) return scanned;
	const known = new Map(scanned.map((command) => [command.name, command]));
	return (
		announced
			// Les commandes de service du CLI n'ont rien à faire dans une
			// conversation : elles pilotent son interface, pas le travail.
			.filter((name) => !name.startsWith("__") && !name.startsWith("workflow-launch"))
			.map(
				(name) =>
					known.get(name) ?? {
						name,
						description: BUILT_IN[name] ? i18nT(`components1:agentChat.builtIn.${BUILT_IN[name]}`) : "",
						argumentHint: null,
						// Un nom préfixé vient d'un plugin ; les autres sont intégrées
						// au CLI, ou vivent hors des chemins balayés.
						scope: name.includes(":") ? "plugin" : "cli",
						source: "",
					},
			)
	);
}

/**
 * Les commandes qui correspondent à ce qu'on tape.
 *
 * Sous-chaîne plutôt que préfixe : on retient rarement le préfixe d'une
 * commande de plugin, alors qu'on se souvient d'un morceau de son nom. Celles
 * qui commencent par la frappe passent devant, elles restent le cas courant.
 */
function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
	const needle = query.toLowerCase();
	if (!needle) return commands;
	const hits = commands.filter((command) => command.name.toLowerCase().includes(needle));
	return hits.sort((a, b) => {
		const first = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
		const second = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
		return first - second || a.name.localeCompare(b.name);
	});
}

/**
 * Les commandes proposées, au-dessus du champ.
 *
 * Au-dessus et non en dessous : le champ est déjà au bas de l'écran, une liste
 * sous lui sortirait de la fenêtre.
 */
function CommandMenu({
	commands,
	cursor,
	loading,
	onChoose,
}: {
	commands: SlashCommand[];
	cursor: number;
	loading: boolean;
	onChoose: (command: SlashCommand) => void;
}) {
	const { t } = useTranslation("components1");
	const list = useRef<HTMLDivElement>(null);

	// La sélection au clavier peut sortir de la partie visible.
	useEffect(() => {
		const node = list.current?.children[cursor];
		if (node) node.scrollIntoView({ block: "nearest" });
	}, [cursor]);

	if (commands.length === 0) {
		return (
			<div className="panel animate-in absolute right-2.5 bottom-full left-2.5 z-40 mb-1 overflow-hidden px-2.5 py-2 shadow-xl shadow-black/40">
				<p className="text-[11px] text-ink-muted">
					{loading ? t("agentChat.commandMenu.loading") : t("agentChat.commandMenu.empty")}
				</p>
				{loading ? null : (
					<p className="mt-0.5 text-[10px] text-ink-faint">
						<Trans
							t={t}
							i18nKey="agentChat.commandMenu.emptyHint"
							components={{ mono: <span className="font-mono" /> }}
						/>
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="panel animate-in absolute right-2.5 bottom-full left-2.5 z-40 mb-1 overflow-hidden shadow-xl shadow-black/40">
			<div ref={list} className="max-h-64 overflow-y-auto p-1">
				{commands.map((command, index) => (
					<button
						key={`${command.scope}:${command.name}`}
						type="button"
						title={command.source}
						onMouseDown={(event) => {
							// Le champ garde le focus : sans ça, le clic le lui prend
							// et la complétion écrit dans le vide.
							event.preventDefault();
							onChoose(command);
						}}
						className={clsx(
							"flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left",
							index === cursor ? "bg-accent-dim" : "hover:bg-hover",
						)}
					>
						<span className="shrink-0 font-mono text-[11px] text-accent-soft">
							/{command.name}
						</span>
						{command.argumentHint ? (
							<span className="shrink-0 font-mono text-[10px] text-ink-faint/70">
								{command.argumentHint}
							</span>
						) : null}
						<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
							{command.description}
						</span>
						<Badge>{t(`agentChat.scope.${command.scope}`)}</Badge>
					</button>
				))}
			</div>
			<div className="hairline-b" />
			<p className="px-2.5 py-1.5 text-[10px] text-ink-faint">
				{loading
					? t("agentChat.commandMenu.loading")
					: t("agentChat.commandMenu.help")}
			</p>
		</div>
	);
}

/**
 * Ce qu'on joint à un message, et les trois gestes qui l'y mettent.
 *
 * Un agent lit les fichiers du disque — images comprises. Joindre une capture
 * n'a donc pas besoin d'un canal multimodal : il suffit de mettre le fichier
 * quelque part de stable et d'en donner le chemin. La copie vit hors du dépôt,
 * sans quoi chaque capture collée salirait `git status`.
 *
 * Trois entrées, parce qu'on ne joint pas un fichier de la même façon selon
 * d'où il vient : glissé depuis le Finder, collé depuis le presse-papier, ou
 * choisi dans un sélecteur. Les deux premières sont les vrais gestes ; la
 * troisième reste le recours quand on ne sait plus où est le fichier.
 */
function useAttachments(sessionId: string | null, active: boolean) {
	const { notify } = useCockpit();
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [dropping, setDropping] = useState(false);
	const zone = useRef<HTMLDivElement>(null);

	const attachPaths = useCallback(
		async (paths: string[]) => {
			if (!sessionId) return;
			for (const path of paths) {
				try {
					const joined = await api.agents.attach(sessionId, path);
					setAttachments((current) => [...current, joined]);
				} catch (error) {
					// Un fichier trop lourd ou illisible ne doit pas emporter les autres.
					notify(String(error));
				}
			}
		},
		[sessionId, notify],
	);

	/** Un contenu collé : il n'existe que dans le presse-papier, on l'écrit. */
	const attach = useCallback(
		async (file: File) => {
			if (!sessionId) return;
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				// Par tranches : `String.fromCharCode(...bytes)` d'un coup dépasse la
				// pile dès quelques centaines de kilooctets, et une capture en pèse
				// plus que ça.
				let binary = "";
				for (let index = 0; index < bytes.length; index += 8192) {
					binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
				}
				const name = file.name || `capture-${Date.now()}.png`;
				const joined = await api.agents.attachClipboard(sessionId, name, btoa(binary));
				setAttachments((current) => [...current, joined]);
			} catch (error) {
				notify(String(error));
			}
		},
		[sessionId, notify],
	);

	// Le glisser-déposer passe par la fenêtre, pas par le DOM : le webview
	// intercepte les fichiers avant que `drop` ne les voie. L'événement Tauri, lui,
	// donne les chemins — et sa position dit si le dépôt visait bien cette
	// conversation, plutôt qu'un autre onglet resté monté derrière.
	useEffect(() => {
		// Hors du pont natif, `getCurrentWebview()` lit `__TAURI_INTERNALS__` et
		// jette avant même de rendre — l'écran devient noir.
		if (!active || !sessionId || !hasTauri()) return;
		let disposed = false;
		let off: (() => void) | undefined;

		const inside = (position: { x: number; y: number }) => {
			const node = zone.current;
			if (!node) return false;
			const box = node.getBoundingClientRect();
			const ratio = window.devicePixelRatio || 1;
			const x = position.x / ratio;
			const y = position.y / ratio;
			return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
		};

		void getCurrentWebview()
			.onDragDropEvent((event) => {
				if (event.payload.type === "over") {
					setDropping(inside(event.payload.position));
					return;
				}
				if (event.payload.type === "drop") {
					const here = inside(event.payload.position);
					setDropping(false);
					if (here) void attachPaths(event.payload.paths);
					return;
				}
				setDropping(false);
			})
			.then((unlisten) => {
				if (disposed) unlisten();
				else off = unlisten;
			});

		return () => {
			disposed = true;
			off?.();
			setDropping(false);
		};
	}, [active, sessionId, attachPaths]);

	return { attachments, setAttachments, attach, attachPaths, dropping, zone };
}

/**
 * Le contexte rassemblé pour le premier message d'une conversation.
 *
 * Ne vaut que là : une fois le dossier joint, l'agent l'a dans sa conversation,
 * et le renvoyer à chaque tour reviendrait à le payer autant de fois. La barre
 * disparaît donc dès l'envoi — c'est aussi ce qui dit qu'il est bien parti.
 *
 * Rien ici ne peut empêcher d'écrire à un agent : une composition qui échoue
 * laisse simplement la consigne partir seule. Un contexte est un bonus.
 */
function useBrief(run: AgentRun) {
	const [brief, setBrief] = useState<Brief | null>(null);
	const [loading, setLoading] = useState(false);
	/** Le dossier est parti : on ne le repropose pas. */
	const [spent, setSpent] = useState(false);
	// Le dossier ne se compose qu'une fois par conversation. Sans cette garde,
	// chaque rendu du panneau relancerait une salve d'appels réseau.
	const asked = useRef("");

	// Un fil déjà entamé n'a plus de premier message : c'est le cas d'un agent
	// lancé avec sa consigne depuis un autre écran, ou repris.
	const fresh = run.turns.length === 0 && run.running && !spent;

	const compose = useCallback(() => {
		setLoading(true);
		api.brief
			.compose(run.cwd)
			.then(setBrief)
			.catch(() => setBrief(null))
			.finally(() => setLoading(false));
	}, [run.cwd]);

	useEffect(() => {
		if (!fresh || asked.current === run.cwd) return;
		asked.current = run.cwd;
		compose();
	}, [fresh, compose, run.cwd]);

	const toggle = useCallback((id: string) => {
		setBrief((current) =>
			current
				? {
						...current,
						sections: current.sections.map((section) =>
							section.id === id ? { ...section, on: !section.on } : section,
						),
					}
				: current,
		);
	}, []);

	/**
	 * Assemble la consigne avec ce qui est resté coché.
	 *
	 * Rend le texte à envoyer et, quand il y a eu contexte, de quoi le nommer
	 * dans le fil. L'assemblage est fait côté Rust : c'est le seul endroit où le
	 * texte final se décide.
	 */
	const join = useCallback(
		async (consigne: string): Promise<{ text: string; joined: string | null }> => {
			const retained = brief?.sections.filter((section) => section.on) ?? [];
			if (!fresh || retained.length === 0) return { text: consigne, joined: null };
			setSpent(true);
			try {
				return {
					text: await api.brief.assemble(retained, consigne, run.cwd),
					joined: retained.map((section) => section.label).join(" · "),
				};
			} catch {
				return { text: consigne, joined: null };
			}
		},
		[brief, fresh],
	);

	return { brief: fresh ? brief : null, loading, toggle, refresh: compose, join };
}

/** Les pièces jointes, telles que l'agent les lira en tête du message. */
function manifest(attachments: Attachment[]): string {
	const lines = attachments.map((file) => `- ${file.path}`).join("\n");
	// Marqueur de protocole, en anglais fixe : `splitAttachments` le relit pour
	// replier les pièces jointes dans le fil, quelle que soit la langue.
	return `${ATTACHMENTS_HEADER}\n${lines}`;
}

/**
 * Une pièce jointe, montrée plutôt que citée.
 *
 * On joignait une image et le fil n'en gardait que le chemin absolu : il
 * fallait sortir de l'app pour savoir ce qu'on venait d'envoyer. Les images
 * s'affichent ici, le reste se donne à ouvrir — dans la visionneuse quand elle
 * est là, dans l'éditeur du poste sinon.
 */
function AttachmentCard({ path }: { path: string }) {
	const { t } = useTranslation("components1");
	const viewer = useFileViewer();
	const { notify } = useCockpit();
	const name = path.split("/").pop() || path;
	const extension = name.split(".").pop()?.toLowerCase() ?? "";
	const open = () => {
		if (viewer) return viewer.open(path);
		void api.system.openEditor(path).catch((error: unknown) => notify(String(error)));
	};

	if (IMAGE_EXTENSIONS.includes(extension) && hasTauri()) {
		return (
			<button
				type="button"
				onClick={open}
				title={t("agentChat.attachment.open", { target: name })}
				className="focus-ring group block overflow-hidden rounded-xl border border-line-soft bg-void transition-colors hover:border-line"
			>
				<LocalImage
					path={path}
					alt={name}
					className="max-h-64 max-w-full object-contain"
				/>
				<span className="block truncate px-2 py-1 text-left font-mono text-[10px] text-ink-faint">
					{name}
				</span>
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={open}
			title={t("agentChat.attachment.open", { target: path })}
			className="focus-ring flex items-center gap-2 rounded-xl border border-line-soft bg-void px-2.5 py-2 text-left transition-colors hover:border-line"
		>
			<Paperclip size={12} className="shrink-0 text-ink-faint" />
			<span className="min-w-0 truncate text-[11px] text-ink-muted">{name}</span>
		</button>
	);
}

/**
 * Conversation avec un agent piloté par le cockpit.
 *
 * Le CLI dialogue en flux JSON par son entrée et sa sortie standard : on peut
 * donc lui parler sans terminal, et afficher ses réponses avec le même rendu
 * markdown que le reste de l'app.
 *
 * L'état vit dans `AgentRunsProvider` : ce composant ne fait que le montrer, ce
 * qui lui permet d'être démonté — workspace quitté — sans que la conversation
 * s'interrompe. L'écran, lui, le garde monté d'un onglet à l'autre : `active`
 * dit s'il est celui qu'on regarde.
 */
export const AgentChat = memo(function AgentChat({
	run,
	active,
}: {
	run: AgentRun;
	active: boolean;
}) {
	const { send, close, changeMode, changeModel, setAutoApprove, decide, answer } =
		useAgentActions();
	const { t } = useTranslation("components1");
	const { notify, config } = useCockpit();
	const startReview = useReviewFlow();
	const { autoApprove, pendingFor } = useAgentGuard();
	const [draft, setDraft] = useState("");
	// Les messages relus du disque retrouvent où on les avait rangés.
	const turns = useMemo(
		() => withFollows(run.turns, run.claudeSessionId),
		[run.turns, run.claudeSessionId],
	);
	// Où ira le prochain message : suite de la consigne en cours, ou nouvelle
	// consigne. Cockpit devine, et le dit avant l'envoi plutôt qu'après — une
	// règle qui se trompe en silence ne se découvrait qu'à la ligne de trop.
	const current = useMemo(() => episodes(turns).at(-1), [turns]);
	const guess = awaitsReply(current, run.thinking);
	const [override, setOverride] = useState<boolean | null>(null);
	const follows = current ? (override ?? guess) : undefined;
	useEffect(() => setOverride(null), [guess]);
	const bottom = useStickToBottom<HTMLDivElement>([run.turns, run.thinking]);
	const pending = pendingFor(run.id);

	// La visite des changements : dès qu'il y a de quoi visiter, et annoncée
	// quand le travail se termine vraiment — l'agent a rendu la main, ne
	// demande rien et n'attend pas de réponse.
	// La voix : muette sauf si c'est cet agent qu'on écoute.
	useNarration(run, pending);

	const tour = useChangeTour();
	const canTour = useMemo(() => hasWork(run.turns), [run.turns]);
	const openTour = useCallback(() => tour?.open(run.id), [tour, run.id]);
	const wasThinking = useRef(run.thinking);
	useEffect(() => {
		const ended = wasThinking.current && !run.thinking;
		wasThinking.current = run.thinking;
		if (!ended || !canTour || pending.length > 0 || awaitsReply(current)) return;
		notify(t("agentChat.finished", { label: run.label }), { label: t("agentChat.tour.visit"), onClick: openTour });
	}, [run.thinking, run.label, canTour, pending.length, current, notify, openTour, t]);
	const composer = useRef<HTMLTextAreaElement>(null);
	const { attachments, setAttachments, attach, attachPaths, dropping, zone } =
		useAttachments(run.sessionId, active);

	// Les commandes du CLI, proposées à la frappe. La liste ne se lit qu'à la
	// première barre oblique : la plupart des conversations n'en tapent jamais,
	// et parcourir trois arborescences pour rien à chaque ouverture d'onglet
	// serait du disque gaspillé.
	const [asked, setAsked] = useState(false);
	const commands = useAsync(() => api.commands.list(run.cwd), [run.cwd], {
		enabled: asked,
	});
	const available = useMemo(
		() => mergeCommands(commands.data ?? [], run.commands),
		[commands.data, run.commands],
	);
	/** Position du curseur dans le champ : c'est là que se cherche la commande. */
	const [caret, setCaret] = useState(0);
	const typed = commandQuery(draft, caret);
	const query = typed?.query ?? null;
	const matches = useMemo(
		() => (query === null ? [] : filterCommands(available, query)),
		[available, query],
	);
	const [cursor, setCursor] = useState(0);
	// La frappe redécoupe la liste : le curseur repart du premier résultat.
	useEffect(() => setCursor(0), [query]);

	// Échap ferme la liste pour la barre oblique en cours, sans rien changer au
	// texte. Une autre barre oblique — donc une autre position — rouvre le menu :
	// on doit pouvoir en écrire autant qu'on veut dans un même message.
	const [dismissed, setDismissed] = useState<number | null>(null);
	useEffect(() => {
		if (typed === null && dismissed !== null) setDismissed(null);
	}, [typed, dismissed]);

	// La barre oblique qui commence un mot ouvre toujours le menu, même sans rien
	// à proposer : c'est ce qui apprend que les commandes existent, et où les
	// écrire. Collée à un mot, elle ressemble à un chemin — « src/app » n'est pas
	// une commande — et n'ouvre le menu que si ce qui est tapé commence vraiment
	// le nom d'une commande connue.
	const relevant = useMemo(
		() =>
			query
				? matches.filter((command) =>
						command.name.toLowerCase().startsWith(query.toLowerCase()),
					)
				: [],
		[matches, query],
	);
	const menuOpen =
		typed !== null &&
		typed.at !== dismissed &&
		(typed.wordStart
			? matches.length > 0 || query === "" || commands.loading
			: relevant.length > 0);

	/** Remplace la commande en cours de frappe par celle qu'on a choisie. */
	const complete = (command: SlashCommand) => {
		// Seul le mot commencé est réécrit : le reste de la phrase déjà tapée —
		// avant comme après le curseur — doit survivre à la complétion.
		const before = typed ? draft.slice(0, typed.at) : "";
		const after = typed ? draft.slice(caret) : "";
		const head = `${before}/${command.name} `;
		setDraft(`${head}${after}`);
		setCaret(head.length);
		setDismissed(null);
		setAsked(true);
		requestAnimationFrame(() => {
			const node = composer.current;
			if (!node) return;
			node.focus();
			node.setSelectionRange(head.length, head.length);
		});
	};

	// Le curseur dans le champ dit « à toi de parler » mieux qu'une phrase : sur
	// une conversation reprise, l'agent n'a rien à dire tant qu'on n'a pas écrit.
	const ready = run.running && Boolean(run.sessionId);
	useEffect(() => {
		if (active && ready) composer.current?.focus();
	}, [active, ready]);

	const brief = useBrief(run);

	const submit = (flip = false) => {
		const text = draft.trim();
		if (!text && attachments.length === 0) return;
		setDraft("");
		setCaret(0);
		setDismissed(null);
		setAttachments([]);
		// Les chemins passent en tête du message : l'agent lit un fichier local
		// comme n'importe quel autre — image comprise — et rien n'a eu besoin de
		// traverser la conversation encodé. Le nom d'origine accompagne le chemin,
		// qui est celui de la copie.
		const consigne =
			attachments.length === 0 ? text : `${manifest(attachments)}\n\n${text}`;

		// Le contexte est joint au premier message seulement : ensuite l'agent l'a
		// dans sa conversation, et le renvoyer reviendrait à le payer à chaque tour.
		const choice = follows === undefined ? undefined : flip ? !follows : follows;
		setOverride(null);

		// Demander une revue en toutes lettres vaut le bouton « Relire » : même
		// agent de revue, même remise en carte. Seulement à la première consigne
		// d'un fil — un agent déjà au travail garde ce qu'on lui dit.
		const untouched = !run.turns.some((turn) => turn.kind !== "system" && turn.kind !== "error");
		const asked = untouched && run.profile !== "review" ? reviewIntent(text, config?.githubRepo) : null;
		if (asked) {
			startReview(asked.number, "revue", consigne)
				// La revue a son propre onglet : celui-ci, resté vide, ne sert plus.
				.then(() => close(run.id))
				// Le centre d'activité dit pourquoi ; la consigne, elle, revient
				// dans le champ plutôt que de disparaître avec l'échec.
				.catch(() => setDraft((current) => current || text));
			return;
		}
		void brief.join(consigne).then(({ text: envoi, joined }) => {
			send(run.id, envoi, {
				display: joined ? consigne : undefined,
				context: joined ?? undefined,
				follows: choice,
			});
		});
	};

	/**
	 * Dépose un prompt tout prêt dans le champ, curseur à la fin.
	 *
	 * Le champ plutôt que l'envoi direct : la plupart de ces prompts se
	 * complètent d'un mot — le numéro de la PR, le fichier visé. Ce qui a déjà
	 * été tapé est conservé, une frappe en cours ne doit pas disparaître parce
	 * qu'on ouvre le menu.
	 */
	// L'appel qu'on demande à voir depuis le bandeau. Il reste ouvert ensuite :
	// on est allé le chercher, le refermer dans le dos de qui l'a demandé serait
	// reprendre ce qu'on vient de donner.
	const [ouvrir, setOuvrir] = useState<string | null>(null);

	// La carte par défaut : ce qui vaut un regard, dessiné. Le fil complet
	// reste à un clic, et le choix vaut pour toutes les conversations.
	const [lecture, setLecture] = usePersistentState<Lecture>("agent.lecture", "carte");
	// Une valeur d'une version précédente (ou inconnue) retombe sur la carte.
	const vue: Lecture = lecture === "fil" || lecture === "film" ? lecture : "carte";
	// L'image du film sur laquelle s'ouvre la salle, quand on y arrive depuis
	// la bande d'une planche.
	const [filmStart, setFilmStart] = useState(0);
	const openFilm = useCallback(
		(index: number) => {
			setFilmStart(index);
			setLecture("film");
		},
		[setLecture],
	);

	// Chaque conclusion d'un épisode terminé se lit en planche : l'image
	// d'abord, le texte replié. Une question posée reste du texte — c'est une
	// réponse qu'on attend, pas un compte rendu à regarder.
	const planches = useMemo(() => {
		const found = new Map<Turn, Episode>();
		const list = episodes(run.turns);
		list.forEach((episode, index) => {
			if (index === list.length - 1 && run.thinking) return;
			const answer = summarize(episode).answer;
			if (answer && !endsWithQuestion(answer.text)) found.set(answer, episode);
		});
		return found;
	}, [run.turns, run.thinking]);
	const askAgent = useCallback((text: string) => send(run.id, text), [send, run.id]);
	const lastFilm = useMemo(() => {
		const episode = episodes(turns).at(-1);
		return episode ? filmOf(episode, run.cwd) : null;
	}, [turns, run.cwd]);

	// Ce que l'agent te demande : sous le fil en lecture complète, en tête de
	// carte sinon — là où il est impossible de le manquer.
	const demandes =
		pending.length > 0 ? (
			<>
				{pending.map((request) =>
						isQuestion(request) ? (
							<QuestionForm
								key={request.id}
								questions={readQuestions(request.input)}
								onAnswer={(answers) => answer(request.id, answers)}
								onSkip={() =>
									decide(
										request.id,
										false,
										"The user skipped the question: go ahead with what you know, " +
											"or ask them in your reply.",
									)
								}
							/>
						) : (
							<div key={request.id} className="flex items-center gap-2">
								<ShieldQuestion size={13} className="shrink-0 text-warning" />
								<div className="min-w-0 flex-1">
									<p className="text-[11px] text-ink">
										<Trans
											t={t}
											i18nKey="agentChat.permission.asks"
											values={{ tool: request.tool }}
											components={{ tool: <span className="font-mono font-medium" /> }}
										/>
									</p>
									<p className="truncate font-mono text-[10px] text-ink-faint">
										{JSON.stringify(request.input).slice(0, 140)}
									</p>
								</div>
								<Button size="sm" onClick={() => decide(request.id, false)}>
									{t("agentChat.permission.deny")}
								</Button>
								<Button size="sm" variant="solid" onClick={() => decide(request.id, true)}>
									{t("agentChat.permission.allow")}
								</Button>
								<Button
									size="sm"
									onClick={() => {
										setAutoApprove(true);
										decide(request.id, true);
									}}
									title={t("agentChat.permission.allowAllTitle")}
								>
									{t("agentChat.permission.allowAll")}
								</Button>
							</div>
						),
					)}
			</>
		) : null;

	const insert = (text: string) => {
		const next = draft.trim() ? `${draft.trimEnd()}\n${text}` : text;
		setDraft(next);
		setCaret(next.length);
		requestAnimationFrame(() => {
			const node = composer.current;
			if (!node) return;
			node.focus();
			node.setSelectionRange(node.value.length, node.value.length);
		});
	};

	// L'écran annoté depuis le navigateur du workspace (`BrowserAnnotator`)
	// rejoint la consigne : l'image en pièce jointe, la désignation en texte.
	// La conversation qu'on regarde d'abord ; à défaut, la première de ce
	// workspace — le navigateur occupe souvent l'onglet de l'agent.
	const insertRef = useRef(insert);
	insertRef.current = insert;
	useEffect(() => {
		const take = (event: Event) => {
			const detail = (event as CustomEvent<AttachDetail>).detail;
			if (!detail || detail.taken || detail.cwd !== run.cwd || !run.sessionId) return;
			if (detail.pass === "active" && !active) return;
			detail.taken = true;
			void attach(detail.file);
			insertRef.current(detail.note);
		};
		window.addEventListener(ATTACH_EVENT, take);
		return () => window.removeEventListener(ATTACH_EVENT, take);
	}, [active, run.cwd, run.sessionId, attach]);

	return (
		<>
			<div className="hairline-b flex items-center gap-2 px-3 py-2">
				<LectureToggle value={vue} onChange={setLecture} />
				<NarrationToggle runId={run.id} />
				<PromptMenu
					onInsert={insert}
					onSend={(text) => send(run.id, text)}
					canSend={ready}
				/>
				<ModelSelect
					model={run.model}
					active={run.activeModel}
					onChange={(model) => changeModel(run.id, model)}
				/>
				<ModeSelect
					mode={run.mode}
					running={run.running}
					onChange={(mode) => changeMode(run.id, mode)}
				/>
				{/* En mode Bypass le CLI ne demande plus rien : le filet n'a plus d'objet. */}
				{run.mode === "bypassPermissions" ? null : (
					<Button
						size="sm"
						icon={autoApprove ? ShieldOff : ShieldCheck}
						active={autoApprove}
						onClick={() => setAutoApprove(!autoApprove)}
						title={
							autoApprove
								? t("agentChat.guard.onTitle")
								: t("agentChat.guard.offTitle")
						}
					>
						{autoApprove ? t("agentChat.guard.on") : t("agentChat.guard.off")}
					</Button>
				)}
				{canTour && !run.thinking ? (
					<Button size="sm" icon={Route} onClick={openTour} title={t("agentChat.tour.title")}>
						{t("agentChat.tour.label")}
					</Button>
				) : null}
				<Equipement run={run} />
				<ContextGauge tokens={run.contextTokens} window={run.contextWindow} usage={run.usage} />
				{/* Ce que cette conversation a coûté depuis le début, à côté de ce
				    qu'elle occupe maintenant : les deux répondent à deux questions
				    différentes, et seule la première était affichée. */}
				<SpendGauge sessionId={run.sessionId} />
				<span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-ink-faint">
					{run.cwd}
				</span>
			</div>

			{/* Entre l'en-tête et le fil : ce qui tourne encore ne défile pas avec
			    ce qui s'est déjà dit. */}
			<SousAgentsEnCours
				turns={run.turns}
				onOuvrir={(toolId) => {
					setOuvrir(toolId);
					// Le fil peut être long, et l'appel loin au-dessus : on y va.
					requestAnimationFrame(() =>
						document
							.getElementById(`appel-${toolId}`)
							?.scrollIntoView({ block: "center", behavior: "smooth" }),
					);
				}}
			/>

			{/* Toujours montée : repasser par le fil ne doit pas refermer ce qu'on
			    avait déplié sur la carte. Masquée, elle ne dessine rien. */}
			<div className={clsx("min-h-0 flex-1 flex-col", vue === "carte" ? "flex" : "hidden")}>
				<AgentMap
					runId={run.id}
					active={active && vue === "carte"}
					turns={turns}
					cwd={run.cwd}
					thinking={run.thinking}
					activity={run.activity}
					alert={demandes}
					onTour={canTour ? openTour : undefined}
					renderTurn={(turn, key) => (
						// Ce qui a échoué s'ouvre de lui-même : c'est la sortie qu'on
						// vient chercher en cliquant sur un nœud rouge.
						<TurnRow
							key={key}
							turn={turn}
							cwd={run.cwd}
							running={run.running}
							openOnDemand={turn.outputError === true}
						/>
					)}
				/>
			</div>
			{vue === "fil" ? (
			<div
				ref={bottom.ref}
				onScroll={bottom.onScroll}
				className="min-h-0 flex-1 divide-y divide-line-soft/60 overflow-y-auto"
			>
				{run.turns.map((turn, index) => {
					const episode = planches.get(turn);
					return episode ? (
						<PlancheRow
							key={index}
							episode={episode}
							answer={turn}
							cwd={run.cwd}
							onFilm={openFilm}
							onAsk={askAgent}
							running={run.running}
						/>
					) : (
						<TurnRow
							key={index}
							turn={turn}
							cwd={run.cwd}
							running={run.running}
							openOnDemand={!!turn.toolId && ouvrir === turn.toolId}
						/>
					);
				})}

				{run.thinking ? (
					<div className="animate-in flex items-center gap-2 px-3 py-2.5">
						<Spinner />
						<span className="text-[11px] text-ink-faint">
							{run.activity ? t("agentChat.thinking.using", { tool: run.activity }) : t("agentChat.thinking.idle")}
						</span>
					</div>
				) : null}

				{/* Ce que l'agent a écrit sur le disque, en fin de fil : c'est là
				    qu'on se demande « et maintenant, où est le résultat ». Rien
				    tant qu'il travaille — la liste bougerait sous les yeux. */}
				{!run.thinking ? <ProducedFiles turns={run.turns} cwd={run.cwd} /> : null}

				{/* Un agent repris n'a rien à dire tant qu'on ne lui a pas écrit : le
				    seul moment où l'attente est légitime, c'est le démarrage. */}
				{run.turns.length === 0 && !run.thinking ? (
					!run.sessionId ? (
						<div className="flex items-center justify-center gap-2 py-10">
							<Spinner />
							<span className="text-[11px] text-ink-faint">{t("agentChat.starting")}</span>
						</div>
					) : (
						<p className="px-4 py-10 text-center text-[11px] leading-relaxed text-ink-faint">
							{t("agentChat.ready")}
						</p>
					)
				) : null}
			</div>
			) : null}

			{vue === "film" ? (
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					<div className="mx-auto max-w-[64rem]">
						{lastFilm ? (
							<FilmTheater film={lastFilm} start={filmStart} />
						) : (
							<p className="py-10 text-center text-[12px] text-ink-faint">
								{t("agentChat.film.empty")}
							</p>
						)}
					</div>
				</div>
			) : null}

			{pending.length > 0 && vue === "fil" ? (
				<div className="flex flex-col gap-1.5 border-t border-warning/25 bg-warning/8 p-2.5">
					{demandes}
				</div>
			) : null}

			{/* Au-dessus du champ, pas dedans : ce qui part avec la consigne se
			    décide avant de l'écrire, et doit rester lisible pendant qu'on tape. */}
			<BriefBar
				brief={brief.brief}
				loading={brief.loading}
				onToggle={brief.toggle}
				onRefresh={brief.refresh}
			/>

			{follows !== undefined && current && run.running ? (
				<FollowPill
					follows={follows}
					consigne={current.ask?.text ?? null}
					onFlip={() => setOverride(!follows)}
				/>
			) : null}

			<div
				ref={zone}
				className={clsx(
					"relative flex items-end gap-2 border-t p-2.5 transition-colors",
					dropping ? "border-accent bg-accent/5" : "border-line-soft",
				)}
			>
				{menuOpen ? (
					<CommandMenu
						commands={matches}
						cursor={cursor}
						loading={commands.loading}
						onChoose={complete}
					/>
				) : null}
				{/* Ce qui est joint se voit avant d'envoyer : un chemin perdu dans le
				    texte s'édite par accident, et on ne sait plus ce que l'agent va
				    recevoir. */}
				{attachments.length > 0 ? (
					<div className="absolute inset-x-2.5 bottom-full mb-1 flex flex-wrap gap-1.5">
						{attachments.map((file) => (
							<span
								key={file.path}
								className="flex max-w-full items-center gap-1.5 rounded-lg border border-line-soft bg-surface px-2 py-1"
								title={file.path}
							>
								<Paperclip size={10} className="shrink-0 text-ink-faint" />
								<span className="min-w-0 truncate text-[10px] text-ink-muted">
									{file.name}
								</span>
								<span className="shrink-0 font-mono text-[10px] text-ink-faint">
									{t("agentChat.attachments.size", { size: Math.max(1, Math.round(file.size / 1024)) })}
								</span>
								<button
									type="button"
									className="focus-ring shrink-0 rounded text-ink-faint hover:text-critical"
									title={t("agentChat.attachments.remove")}
									onClick={() =>
										setAttachments((current) =>
											current.filter((entry) => entry.path !== file.path),
										)
									}
								>
									<X size={10} />
								</button>
							</span>
						))}
					</div>
				) : null}
				{/* Le recours quand le fichier n'est ni sous la main ni dans le
				    presse-papier : on va le chercher. */}
				<Button
					icon={Paperclip}
					title={t("agentChat.attachments.add")}
					disabled={!run.running || !run.sessionId}
					onClick={() => {
						void openDialog({ multiple: true })
							.then((chosen) => {
								if (!chosen) return;
								void attachPaths(Array.isArray(chosen) ? chosen : [chosen]);
							})
							.catch(() => undefined);
					}}
				/>
				<textarea
					ref={composer}
					value={draft}
					onChange={(event) => {
						const value = event.target.value;
						const at = event.target.selectionStart ?? value.length;
						setDraft(value);
						setCaret(at);
						// Charger la liste dès la barre oblique, pas au premier
						// caractère tapé après : sinon le menu s'ouvre en retard,
						// une fois qu'on a déjà écrit ce qu'on cherchait.
						if (!asked && commandQuery(value, at) !== null) setAsked(true);
					}}
					// Clic, flèches, sélection : le menu suit le curseur, puisque
					// c'est à cet endroit que la commande s'écrit.
					onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? draft.length)}
					// Une capture d'écran se colle : c'est le geste le plus courant, et
					// il n'existe nulle part ailleurs — le presse-papier ne contient
					// aucun chemin, seulement des octets.
					onPaste={(event) => {
						const files = Array.from(event.clipboardData?.files ?? []);
						if (files.length === 0) return;
						// Le texte accompagnant une capture reste utile ; c'est
						// l'insertion du fichier lui-même qu'on empêche.
						event.preventDefault();
						for (const file of files) void attach(file);
					}}
					onKeyDown={(event) => {
						// Le menu ouvert prend la main sur les touches qui le
						// pilotent — et sur Entrée, qui choisit au lieu d'envoyer.
						if (menuOpen) {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								const step = event.key === "ArrowDown" ? 1 : -1;
								setCursor((value) =>
									Math.min(matches.length - 1, Math.max(0, value + step)),
								);
								return;
							}
							if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
								event.preventDefault();
								const chosen = matches[cursor];
								if (chosen) complete(chosen);
								return;
							}
							if (event.key === "Escape") {
								event.preventDefault();
								// On ferme la liste sans toucher au texte : ajouter un
								// espace pour s'en débarrasser modifiait le message, et
								// la barre oblique suivante ne rouvrait plus rien.
								setDismissed(typed?.at ?? null);
								return;
							}
						}
						// Entrée envoie, ⇧Entrée retourne à la ligne — comme partout.
						// ⌥Entrée envoie en rangeant le message de l'autre côté.
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit(event.altKey);
						}
					}}
					rows={2}
					placeholder={
						run.running ? t("agentChat.composer.placeholder") : t("agentChat.composer.ended")
					}
					disabled={!run.running || !run.sessionId}
					className="focus-ring text-selectable min-h-0 flex-1 resize-none rounded-lg border border-line-soft bg-void px-2.5 py-2 text-[12.5px] leading-relaxed text-ink disabled:opacity-50"
				/>
				{/* Tant que l'agent travaille, c'est l'arrêt qu'on veut à portée, pas
				    l'envoi : une consigne mal formulée partait sans rattrapage
				    possible, et la seule issue était de couper l'agent — donc de
				    perdre la conversation et tout son contexte. L'interruption, elle,
				    le laisse en place : on corrige et on renvoie. */}
				{run.thinking ? (
					<Button
						variant="danger"
						icon={Square}
						disabled={!run.running || !run.sessionId}
						onClick={() => {
							if (!run.sessionId) return;
							void api.agents
								.interrupt(run.sessionId)
								.then(() => {
									// Interrompre, c'est presque toujours vouloir reformuler.
									// On rend la consigne au champ de saisie plutôt que de la
									// faire retaper — sans écraser un brouillon déjà commencé,
									// qui est forcément plus récent que ce qu'on a envoyé.
									const dernier = [...run.turns]
										.reverse()
										.find((turn) => turn.kind === "user");
									if (dernier?.text && !draft.trim()) {
										setDraft(splitAttachments(dernier.text).text);
									}
									notify(t("agentChat.interrupt.done"));
								})
								.catch((error) => notify(String(error)));
						}}
						title={t("agentChat.interrupt.title")}
					>
						{t("agentChat.interrupt.label")}
					</Button>
				) : (
					<Button
						variant="solid"
						icon={CornerDownLeft}
						// Une pièce jointe suffit à faire un message : « regarde ça » se dit
						// aussi bien par le fichier seul.
						disabled={
							!run.running ||
							!run.sessionId ||
							(!draft.trim() && attachments.length === 0)
						}
						onClick={() => submit()}
					>
						{t("agentChat.composer.send")}
					</Button>
				)}
			</div>
		</>
	);
});

/**
 * Où ira le prochain message, dit avant l'envoi : à la suite de la consigne
 * en cours, ou comme une nouvelle. Un clic inverse ; ⌥Entrée envoie de
 * l'autre côté sans toucher à la souris.
 */
function FollowPill({
	follows,
	consigne,
	onFlip,
}: {
	follows: boolean;
	consigne: string | null;
	onFlip: () => void;
}) {
	const { t } = useTranslation("components1");
	const court = consigne ? consigne.replace(/\s+/g, " ").trim() : "";
	return (
		<div className="flex items-center gap-2 border-t border-line-soft px-3 pt-2 text-[11px]">
			<span className={clsx("flex min-w-0 items-center gap-1.5", follows ? "text-ink-muted" : "text-ink")}>
				{follows ? <CornerDownRight size={12} className="shrink-0" /> : <Plus size={12} className="shrink-0" />}
				{follows ? (
					<>
						<span className="shrink-0">{t("agentChat.follow.of")}</span>
						<span className="min-w-0 truncate text-ink">
							{t("agentChat.follow.quoted", { text: court.length > 60 ? `${court.slice(0, 59)}…` : court || t("agentChat.follow.currentFallback") })}
						</span>
					</>
				) : (
					<span>{t("agentChat.follow.new")}</span>
				)}
			</span>
			<button
				type="button"
				onClick={onFlip}
				title={t("agentChat.follow.flipTitle")}
				className="focus-ring flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-ink-faint hover:bg-hover hover:text-ink"
			>
				<ArrowLeftRight size={11} />
				{follows ? t("agentChat.follow.toNew") : t("agentChat.follow.toFollow")}
			</button>
		</div>
	);
}

/**
 * Les questions d'un `AskUserQuestion`, posées pour de vrai.
 *
 * Elles arrivaient jusqu'ici sous les traits d'une demande d'autorisation :
 * « l'agent demande à utiliser AskUserQuestion », avec Autoriser et Refuser pour
 * seules réponses. Autoriser lançait un outil qui n'a aucun moyen d'interroger
 * qui que ce soit dans un agent sans terminal — il se concluait par « the user
 * did not answer » et l'agent repartait sans sa réponse.
 *
 * Un choix libre reste possible : toutes les options proposées ne conviennent
 * pas toujours, et l'agent gagne plus à lire « ni l'un ni l'autre, c'est ceci »
 * qu'une option prise par défaut.
 */
export function QuestionForm({
	questions,
	onAnswer,
	onSkip,
}: {
	questions: AgentQuestion[];
	onAnswer: (answers: Array<{ header: string; choice: string }>) => void;
	onSkip: () => void;
}) {
	const { t } = useTranslation("components1");
	const [picked, setPicked] = useState<Record<number, string[]>>({});
	const [custom, setCustom] = useState("");

	const choose = (index: number, label: string, multi: boolean) => {
		setPicked((current) => {
			const already = current[index] ?? [];
			if (!multi) return { ...current, [index]: [label] };
			return {
				...current,
				[index]: already.includes(label)
					? already.filter((entry) => entry !== label)
					: [...already, label],
			};
		});
	};

	const answers = questions.flatMap((question, index) => {
		const chosen = picked[index] ?? [];
		if (chosen.length === 0) return [];
		return [{ header: question.header, choice: chosen.join(", ") }];
	});
	// Une précision libre vaut réponse à elle seule : l'agent n'a pas besoin
	// qu'on ait coché quelque chose pour comprendre « aucune des options ».
	const complete = custom.trim() !== "" || answers.length === questions.length;

	const submit = () => {
		if (!complete) return;
		const extra = custom.trim();
		onAnswer(extra ? [...answers, { header: "Clarification", choice: extra }] : answers);
	};

	return (
		<div className="flex flex-col gap-2.5">
			{questions.map((question, index) => (
				<div key={index} className="flex flex-col gap-1.5">
					<div className="flex items-baseline gap-2">
						<MessageCircleQuestion
							size={13}
							className="shrink-0 self-center text-warning"
						/>
						<span className="shrink-0 text-[10px] font-semibold tracking-wide text-warning uppercase">
							{question.header}
						</span>
						<p className="text-selectable min-w-0 flex-1 text-[12.5px] text-ink">
							{question.question}
						</p>
					</div>
					<div className="flex flex-col gap-1 pl-[21px]">
						{question.options.map((option) => {
							const selected = (picked[index] ?? []).includes(option.label);
							return (
								<button
									key={option.label}
									type="button"
									onClick={() => choose(index, option.label, question.multiSelect)}
									className={clsx(
										"focus-ring flex flex-col gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors",
										selected
											? "border-accent/50 bg-accent-dim"
											: "border-line-soft hover:bg-hover",
									)}
								>
									<span
										className={clsx(
											"flex items-center gap-1.5 text-[11px] font-medium",
											selected ? "text-accent-soft" : "text-ink",
										)}
									>
										<Check
											size={11}
											className={clsx("shrink-0", selected ? "" : "text-transparent")}
										/>
										{option.label}
									</span>
									{option.description ? (
										<span className="pl-[18px] text-[10px] leading-snug text-ink-faint">
											{option.description}
										</span>
									) : null}
								</button>
							);
						})}
					</div>
				</div>
			))}

			<div className="flex items-end gap-2">
				<input
					value={custom}
					onChange={(event) => setCustom(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							submit();
						}
					}}
					placeholder={t("agentChat.question.placeholder")}
					className="focus-ring text-selectable min-w-0 flex-1 rounded-lg border border-line-soft bg-void px-2.5 py-1.5 text-[11px] text-ink"
				/>
				<Button size="sm" onClick={onSkip} title={t("agentChat.question.skipTitle")}>
					{t("agentChat.question.skip")}
				</Button>
				<Button size="sm" variant="solid" disabled={!complete} onClick={submit}>
					{t("agentChat.question.answer")}
				</Button>
			</div>
		</div>
	);
}

/** Ce qu'on a demandé, et ce qu'on a joint pour le demander. */
function UserTurn({ text, context }: { text: string; context?: string }) {
	const { t } = useTranslation("components1");
	const { text: dit, paths } = splitAttachments(text);
	return (
		<div className="flex max-w-[64rem] flex-col gap-2 rounded-2xl border border-accent/25 bg-accent/[0.06] px-3 py-2">
			{dit ? (
				<div className="flex gap-2">
					<User size={11} className="mt-1 shrink-0 text-accent-soft" />
					<p className="text-selectable min-w-0 flex-1 text-[12.5px] whitespace-pre-wrap text-ink">
						{dit}
					</p>
				</div>
			) : null}
			{paths.length > 0 ? (
				<div className="flex flex-wrap gap-2">
					{paths.map((path) => (
						<AttachmentCard key={path} path={path} />
					))}
				</div>
			) : null}
			{/* Ce qui est parti avec ce message sans y être écrit. Sans cette ligne,
			    une réponse qui s'appuie sur le ticket paraîtrait sortie de nulle part. */}
			{context ? (
				<p className="flex items-center gap-1.5 border-t border-accent/15 pt-1.5 text-[10px] text-ink-faint">
					<Layers size={10} className="shrink-0" />
					<span className="min-w-0 truncate">{t("agentChat.userTurn.context", { context })}</span>
				</p>
			) : null}
		</div>
	);
}

/**
 * Un tour de la conversation.
 *
 * Mémoïsé, et c'est tout l'intérêt : un agent qui travaille envoie plusieurs
 * messages par seconde, et chacun rendait à nouveau l'intégralité du fil — avec
 * le markdown de chaque réponse remis en forme au passage. Les tours déjà là ne
 * changent jamais d'identité, ils ne sont donc plus retouchés.
 */
/**
 * Carte ou fil : deux lectures de la même conversation.
 *
 * Un segment plutôt qu'une case : les deux sont des façons de lire, pas un
 * réglage qu'on active. Celle qui est choisie se pose sur une pastille qui
 * glisse, comme l'entrée active de la barre latérale.
 */
type Lecture = "carte" | "fil" | "film";

/**
 * Une conclusion en planche, dans le fil. Une réponse qui n'a rien à montrer
 * redevient la ligne de texte qu'elle était : on n'invente pas d'image.
 */
const PlancheRow = memo(function PlancheRow({
	episode,
	answer,
	cwd,
	running,
	onFilm,
	onAsk,
}: {
	episode: Episode;
	answer: Turn;
	cwd: string;
	running: boolean;
	onFilm: (index: number) => void;
	onAsk: (text: string) => void;
}) {
	const empty = useMemo(() => plancheOf(episode, answer, cwd).empty, [episode, answer, cwd]);
	if (empty) return <TurnRow turn={answer} cwd={cwd} running={running} />;
	return (
		<div className="animate-in px-3 py-3">
			<Planche episode={episode} answer={answer} cwd={cwd} onFilm={onFilm} onAsk={onAsk} />
		</div>
	);
});

function LectureToggle({
	value,
	onChange,
}: {
	value: Lecture;
	onChange: (value: Lecture) => void;
}) {
	const { t } = useTranslation("components1");
	const options: Array<[Lecture, string, string]> = [
		["carte", t("agentChat.lecture.map"), t("agentChat.lecture.mapHint")],
		["fil", t("agentChat.lecture.thread"), t("agentChat.lecture.threadHint")],
		["film", t("agentChat.lecture.film"), t("agentChat.lecture.filmHint")],
	];
	return (
		<div className="flex shrink-0 items-center rounded-lg bg-raised p-0.5">
			{options.map(([id, label, hint]) => (
				<button
					key={id}
					type="button"
					title={hint}
					onClick={() => onChange(id)}
					className={clsx(
						"focus-ring relative h-6 rounded-md px-2.5 text-[11.5px] font-medium transition-colors",
						value === id ? "text-ink" : "text-ink-faint hover:text-ink-muted",
					)}
				>
					{value === id ? (
						<motion.span
							layoutId="lecture-agent"
							transition={{ type: "spring", stiffness: 520, damping: 40 }}
							className="absolute inset-0 rounded-md bg-surface shadow-card"
						/>
					) : null}
					<span className="relative">{label}</span>
				</button>
			))}
		</div>
	);
}

const TurnRow = memo(function TurnRow({
	turn,
	cwd,
	running,
	nested,
	openOnDemand,
}: {
	turn: Turn;
	cwd: string;
	running: boolean;
	/** Ce tour appartient au fil d'un sous-agent, pas à la conversation. */
	nested?: boolean;
	/** Le bandeau renvoie ici : l'appel s'ouvre en arrivant. */
	openOnDemand?: boolean;
}) {
	const { t } = useTranslation("components1");
	return (
		<div id={turn.toolId ? `appel-${turn.toolId}` : undefined} className="animate-in px-3 py-2.5">
			{/* Une conversation se lit sur une colonne, pas sur la largeur d'un écran
			    de 27 pouces : au-delà, l'œil perd le début de la ligne suivante. La
			    colonne reste alignée à gauche — le fil ne flotte pas au milieu du
			    vide. Les appels d'outil s'en affranchissent : un diff ou une sortie
			    de test veulent toute la place qu'on peut leur donner. */}
			{turn.kind === "tool" ? (
				<ToolCall
					turn={turn}
					cwd={cwd}
					running={running}
					openOnDemand={openOnDemand}
					sub={
						turn.sub && turn.sub.length > 0 ? (
							<div className="divide-y divide-line-soft/40">
								{turn.sub.map((interne, index) => (
									// Le même rendu que le fil principal, et pas une version
									// allégée : un sous-agent lit des fichiers, lance des
									// commandes et se trompe exactement comme un agent. Ce
									// qu'on sait montrer de l'un vaut pour l'autre.
									<TurnRow
										key={index}
										turn={interne}
										cwd={cwd}
										running={running}
										nested
									/>
								))}
							</div>
						) : undefined
					}
				/>
			) : turn.kind === "user" ? (
				// La consigne est une bulle, pas une bande : c'est ce qui distingue
				// d'un coup d'œil ce qu'on a demandé de ce que l'agent répond.
				//
				// Sauf dans le fil d'un sous-agent, où cette même bulle mentirait :
				// ce n'est pas une consigne qu'on a écrite, c'est le briefing que
				// l'agent a rédigé pour son sous-traitant. Le lui attribuer visuellement
				// laisserait croire qu'on a demandé quelque chose qu'on n'a jamais tapé.
				nested ? (
					<div className="max-w-[64rem] border-l-2 border-ink-faint/30 pl-2">
						<p className="pb-0.5 text-[10px] tracking-wide text-ink-faint uppercase">
							{t("agentChat.turn.leadInstruction")}
						</p>
						<p className="text-selectable text-[12px] whitespace-pre-wrap text-ink-muted">
							{turn.text}
						</p>
					</div>
				) : (
					<UserTurn text={turn.text} context={turn.context} />
				)
			) : turn.kind === "error" ? (
				<p className="text-selectable max-w-[64rem] font-mono text-[11px] text-critical">
					{turn.text}
				</p>
			) : turn.kind === "system" ? (
				<p className="text-[10px] text-ink-faint">{turn.text}</p>
			) : (
				<div className="max-w-[64rem]">
					<Markdown source={turn.text} cwd={cwd} />
				</div>
			)}
		</div>
	);
});

/**
 * Bibliothèque de prompts, à portée de la conversation en cours.
 *
 * Les mêmes consignes reviennent à longueur de journée — « traite les retours
 * CodeRabbit », « vérifie puis commit ». Les retaper dans chaque agent est du
 * temps perdu ; le menu les injecte dans le fil ouvert, là où le contexte est
 * déjà chargé, au lieu d'en démarrer un nouveau comme le fait la vue Agents.
 *
 * La liste ne se lit qu'à la première ouverture : un fichier de config n'a pas
 * à être relu à chaque affichage d'un onglet.
 */
function PromptMenu({
	onInsert,
	onSend,
	canSend,
}: {
	onInsert: (text: string) => void;
	onSend: (text: string) => void;
	canSend: boolean;
}) {
	const { t } = useTranslation("components1");
	const [wanted, setWanted] = useState(false);
	const prompts = useAsync(() => api.prompts.list(), [], { enabled: wanted });

	const actions = useMemo<QuickAction[]>(
		() =>
			(prompts.data ?? []).map((prompt) => ({
				id: prompt.id,
				group: prompt.group || t("agentChat.prompts.group"),
				label: prompt.label,
				// Le prompt est un pavé : replié sur une ligne, il sert de rappel du
				// contenu sans faire dérailler la hauteur du menu.
				hint: prompt.text.replace(/\s+/g, " ").trim(),
				run: () => onInsert(prompt.text),
				extra: canSend
					? {
							icon: CornerDownLeft,
							title: t("agentChat.prompts.sendNow"),
							run: () => onSend(prompt.text),
						}
					: undefined,
			})),
		[canSend, onInsert, onSend, prompts.data, t],
	);

	return (
		<QuickMenu
			label={t("agentChat.prompts.label")}
			icon={Wand2}
			title={t("agentChat.prompts.title")}
			actions={actions}
			loading={prompts.loading}
			onOpen={() => (wanted ? prompts.reload() : setWanted(true))}
			emptyMessage={prompts.error ?? t("agentChat.prompts.empty")}
			width={380}
			footer={
				<>
					<Trans
						t={t}
						i18nKey="agentChat.prompts.footer"
						components={{ mono: <span className="font-mono" /> }}
					/>
				</>
			}
		/>
	);
}

/**
 * Choix du niveau d'autorisation.
 *
 * Changer de mode sur un agent vivant le relance sur la même session Claude —
 * le drapeau n'est lisible qu'au démarrage du CLI — et le choix devient celui
 * des prochains lancements.
 */
/**
 * Le modèle de la conversation, et de quoi en changer.
 *
 * Deux informations distinctes se disputaient la même place : ce qu'on a
 * demandé et ce qui tourne. On affiche ce qui tourne — le CLI le rapporte à
 * chaque réponse, fenêtre longue comprise — et le menu, lui, porte la demande.
 * Tant que rien n'a encore été dit, il n'y a que la demande à montrer.
 */
function ModelSelect({
	model,
	active,
	onChange,
}: {
	model: string;
	active: string | null;
	onChange: (model: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const { t } = useTranslation("components1");
	const [quotas, setQuotas] = useState<UsageLimit[]>([]);
	const [custom, setCustom] = useState("");
	const box = useRef<HTMLDivElement>(null);
	const { config } = useCockpit();
	// Les agents du chat tournent sur le premier moteur déclaré : c'est lui qui
	// dit quels modèles proposer, et ses réglages qu'on édite pour en ajouter.
	const choices = useMemo(
		() => modelChoices(config?.engines[0]?.models ?? []),
		[config?.engines],
	);
	const running = shortModel(active);
	// Ce qui tourne prime sur ce qu'on a demandé. Le CLI peut employer un autre
	// modèle que l'alias du lancement — un `/model` dans la conversation, un
	// repli, le réglage du poste quand rien n'était demandé — et le menu cochait
	// alors « Opus » pendant que le bouton affichait `haiku-4-5-20251001`.
	// Un identifiant complet se reconnaît tel quel ; sinon, par sa famille.
	const famille = modelFamily(active);
	const coche =
		choices.find((entry) => entry.id && entry.id === modelCore(active))?.id ??
		(model && famille === modelFamily(model) ? model : famille || model);
	// Deux choses différentes, et c'est le désaccord qu'il faut montrer : un
	// modèle demandé qui n'est pas celui qui répond mérite d'être dit, pas
	// silencieusement remplacé dans l'affichage. Un identifiant versionné se
	// compare en entier — `opus-5` qui répond à `opus-5-5` est un repli.
	const versionne = /\d/.test(model);
	const ecart = Boolean(
		model &&
			active &&
			(versionne ? modelCore(active) !== model : famille && famille !== model),
	);
	const choose = (next: string) => {
		setOpen(false);
		setCustom("");
		onChange(next);
	};

	// À l'ouverture, et seulement là : cet appel lit le disque et reprend le
	// dernier relevé de quota. Il ne lance aucun CLI — c'est ce qui autorise à
	// le demander sur un simple clic, là où `usage.limits()` coûterait une
	// conversation dans les journaux de l'utilisateur à chaque menu ouvert.
	useEffect(() => {
		if (!open) return;
		let vivant = true;
		void api.sessions
			.spend()
			.then((spend) => {
				if (vivant) setQuotas(spend.quotas ?? []);
			})
			.catch(() => {});
		return () => {
			vivant = false;
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const dismiss = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", dismiss);
		window.addEventListener("keydown", escape);
		return () => {
			window.removeEventListener("mousedown", dismiss);
			window.removeEventListener("keydown", escape);
		};
	}, [open]);

	return (
		<div ref={box} className="relative">
			<Button
				size="sm"
				icon={Sparkles}
				onClick={() => setOpen((value) => !value)}
				title={
					running
						? t("agentChat.model.currentTitle", { model: active })
						: t("agentChat.model.chooseTitle")
				}
			>
				{running ?? modelLabel(model)}
			</Button>

			{open ? (
				<div className="panel animate-in absolute top-7 left-0 z-50 w-[19rem] overflow-hidden p-1 shadow-xl shadow-black/40">
					{choices.map((entry) => (
						<button
							key={entry.id || "default"}
							type="button"
							onClick={() => choose(entry.id)}
							className={clsx(
								"focus-ring flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left",
								entry.id === coche ? "bg-accent-dim" : "hover:bg-hover",
							)}
						>
							<span className="flex items-baseline gap-2">
								<span className="shrink-0 text-[11px] font-medium text-ink">
									{entry.label}
								</span>
								<span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
									{entry.hint}
								</span>
								{entry.id === coche ? (
									<Check size={11} className="shrink-0 text-accent-soft" />
								) : null}
							</span>
							<ModelCost spec={entry} quotas={quotas} />
						</button>
					))}
					<div className="border-t border-line-soft px-1 pt-1.5 pb-1">
						<input
							value={custom}
							onChange={(event) => setCustom(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && custom.trim()) {
									event.preventDefault();
									choose(custom.trim());
								}
							}}
							placeholder={t("agentChat.model.customPlaceholder")}
							title={t("agentChat.model.customTitle")}
							className="focus-ring w-full rounded-lg border border-line-soft bg-void px-2 py-1 font-mono text-[10px] text-ink"
						/>
					</div>
					{ecart ? (
						<p className="border-t border-line-soft px-2 py-1.5 text-[10px] text-warning">
							{t("agentChat.model.mismatch", { requested: modelLabel(model), answering: shortModel(active) })}
						</p>
					) : null}
					<QuotaFooter quotas={quotas} />
					<p className="border-t border-line-soft px-2 py-1.5 text-[10px] text-ink-faint">
						{t("agentChat.model.restartNote")}
					</p>
				</div>
			) : null}
		</div>
	);
}

/**
 * Ce que coûte un modèle, dans les deux monnaies où la question se pose.
 *
 * Un forfait ne se compte pas en dollars et une clé d'API ne se compte pas en
 * pourcentages : les deux réponses cohabitent parce que le cockpit ne sait pas
 * laquelle concerne celui qui regarde. Le quota vient du relevé du CLI — un
 * chiffre mesuré, pas une estimation — et le tarif est celui publié pour
 * l'API. Ni l'un ni l'autre n'est calculé ici : un coût inventé serait pire
 * qu'un coût absent.
 */
function ModelCost({ spec, quotas }: { spec: ModelSpec; quotas: UsageLimit[] }) {
	// « Défaut » ne désigne aucun modèle : on ne peut rien en dire de vrai.
	const { t } = useTranslation("components1");
	if (!spec.id) return null;
	// Seul un compteur dédié se dit ligne par ligne. Répéter « 78 % du quota
	// commun » sur trois modèles affichait trois alertes pour un seul plafond :
	// le commun se dit une fois, en pied de menu.
	const dedie = spec.quota ? modelQuota(spec, quotas) : null;

	return (
		<span className="flex items-center gap-1.5 text-[10px] text-ink-faint">
			{spec.quota ? (
				<span className={clsx(dedie && dedie.percent >= 90 && "text-critical")}>
					{t("agentChat.cost.dedicated")}
					{dedie ? ` · ${t("agentChat.percent", { value: dedie.percent })}` : ""}
				</span>
			) : null}
			{spec.price ? (
				<span className="ml-auto shrink-0 tabular-nums">
					{t("agentChat.cost.price", { in: spec.price.in, out: spec.price.out })}
				</span>
			) : null}
		</span>
	);
}

/**
 * L'état des compteurs d'abonnement, sous la liste.
 *
 * Un compteur pour plusieurs modèles : le dire une fois plutôt qu'à chaque
 * ligne. C'est aussi ici que se règle la question posée par le menu — « est-ce
 * compris dans le forfait ? » — dont la réponse n'est ni oui ni non mais « oui,
 * tant qu'il reste du quota, et Fable a le sien ».
 */
function QuotaFooter({ quotas }: { quotas: UsageLimit[] }) {
	const { t } = useTranslation("components1");
	const commun = quotas.find(
		(entry) => entry.label.startsWith("Cette semaine") && !entry.label.includes("("),
	);

	return (
		<p className="border-t border-line-soft px-2 py-1.5 text-[10px] leading-snug text-ink-faint">
			{commun ? (
				<>
					<Trans
						t={t}
						i18nKey="agentChat.quota.common"
						values={{ percent: commun.percent }}
						components={{
							tone: (
								<span
									className={clsx(
										commun.percent >= 90
											? "text-critical"
											: commun.percent >= 75
												? "text-warning"
												: "text-ink-muted",
									)}
								/>
							),
						}}
					/>
				</>
			) : (
				t("agentChat.quota.none")
			)}
		</p>
	);
}

/**
 * Ce que la conversation occupe dans la fenêtre du modèle.
 *
 * Un fil qui s'approche de sa limite se met à oublier son début, sans rien
 * dire. La jauge prévient avant : elle passe à l'orange aux trois quarts, au
 * rouge à quatre-vingt-dix pour cent — le moment de résumer et de repartir.
 */
/**
 * Ce que cette conversation a coûté, et ce qu'il reste.
 *
 * La jauge de contexte à côté dit ce que le modèle a **sous les yeux** ; celle-ci
 * dit ce qu'on a **payé**. Un fil peut n'occuper que 8 % de sa fenêtre et avoir
 * consommé un million de jetons, parce que chaque tour repaie la lecture de tout
 * ce qui précède — c'est exactement ce qu'on ne voyait pas.
 *
 * Aucun plafond ici : c'est un indicateur, pas un garde-fou. Il ne bloque rien
 * et ne demande rien ; il évite seulement de découvrir après coup où est parti
 * le quota.
 */
function SpendGauge({ sessionId }: { sessionId: string | null }) {
	// Une minute : parcourir les journaux de session n'est pas gratuit, et ce
	// chiffre ne bouge qu'au rythme des tours de parole.
	const spend = useAsync(
		() => (sessionId ? api.agents.spend(sessionId) : Promise.resolve(null)),
		[sessionId],
		{ pollMs: 60_000, enabled: Boolean(sessionId) },
	);
	const { t } = useTranslation("components1");
	const data = spend.data;
	if (!data || data.total === 0) return null;

	const left = data.remaining;
	const tight = left !== null && left <= 15;
	const low = left !== null && left <= 30;

	return (
		<div
			className="flex shrink-0 items-center gap-1.5"
			title={
				`${t("agentChat.spend.summary", { total: data.total.toLocaleString(locale()), share: data.share })} ` +
				(left === null
					? t("agentChat.spend.noQuota")
					: data.resetsAt
						? t("agentChat.spend.leftResets", { left, limit: data.tightest, when: data.resetsAt })
						: t("agentChat.spend.left", { left, limit: data.tightest }))
			}
		>
			{/* La barre porte la part de cette conversation dans la fenêtre, pas le
			    quota : c'est la seule mise en rapport honnête, le quota n'étant
			    annoncé qu'en pourcentage et jamais en jetons. */}
			<div className="h-1 w-12 overflow-hidden rounded-full bg-raised">
				<div
					className={clsx("h-full", data.share >= 50 ? "bg-warning" : "bg-accent/70")}
					style={{ width: `${Math.min(data.share, 100)}%` }}
				/>
			</div>
			<span className="font-mono text-[10px] text-ink-faint tabular-nums">
				{data.total >= 1_000_000
					? `${(data.total / 1_000_000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} M`
					: `${Math.round(data.total / 1000)} k`}
			</span>
			<span
				className={clsx(
					"font-mono text-[10px] tabular-nums",
					tight ? "text-critical" : low ? "text-warning" : "text-ink-faint/60",
				)}
			>
				{t("agentChat.percent", { value: left === null ? "—" : left })}
			</span>
		</div>
	);
}

function ContextGauge({
	tokens,
	window,
	usage,
}: {
	tokens: number;
	window: number | null;
	usage?: ContextUsage;
}) {
	const { t } = useTranslation("components1");
	// La répartition comptée par le CLI, quand elle est revenue : la barre dit
	// alors de quoi le contexte est fait, pas seulement combien il pèse.
	if (usage && usage.maxTokens > 0) {
		const parts = contextSlices(usage);
		const ratio = usage.totalTokens / usage.maxTokens;
		const tone = ratio >= 0.9 ? "text-critical" : ratio >= 0.75 ? "text-warning" : "text-ink-faint";
		return (
			<div
				className="flex shrink-0 items-center gap-1.5"
				title={
					`${t("agentChat.context.breakdown", { used: usage.totalTokens.toLocaleString(locale()), max: usage.maxTokens.toLocaleString(locale()) })}\n` +
					parts.map((part) => t("agentChat.context.part", { label: part.label, tokens: part.tokens.toLocaleString(locale()) })).join("\n") +
					(usage.isAutoCompactEnabled && usage.autoCompactThreshold
						? `\n${t("agentChat.context.autoCompact", { percent: Math.round((usage.autoCompactThreshold / usage.maxTokens) * 100) })}`
						: "")
				}
			>
				<div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-raised">
					{parts.map((part) => (
						<div key={part.key} className="h-full" style={{ width: `${(part.tokens / usage.maxTokens) * 100}%`, background: part.color }} />
					))}
				</div>
				<span className={clsx("font-mono text-[10px] tabular-nums", tone)}>{t("agentChat.percent", { value: usage.percentage })}</span>
			</div>
		);
	}
	if (window === null && tokens <= 0) return null;

	// Fenêtre encore inconnue — le CLI ne l'annonce qu'à la fin du premier tour.
	// On montre alors ce qu'on sait vraiment, le volume, plutôt qu'un
	// pourcentage calculé sur une échelle supposée : c'est ainsi qu'un fil de
	// 36 000 jetons s'affichait à 18 % alors qu'il en occupait 4.
	if (window === null) {
		return (
			<span
				className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint"
				title={
					t("agentChat.context.unknownWindow", { tokens: tokens.toLocaleString(locale()) })
				}
			>
				{Math.round(tokens / 1000)} k
			</span>
		);
	}

	const limit = window;
	const ratio = Math.min(1, tokens / limit);
	const percent = Math.round(ratio * 100);
	const tone =
		ratio >= 0.9 ? "text-critical" : ratio >= 0.75 ? "text-warning" : "text-ink-faint";
	const bar = ratio >= 0.9 ? "bg-critical" : ratio >= 0.75 ? "bg-warning" : "bg-accent/70";

	return (
		<div
			className="flex shrink-0 items-center gap-1.5"
			title={
				t("agentChat.context.window", { tokens: tokens.toLocaleString(locale()), limit: limit.toLocaleString(locale()) })
			}
		>
			<div className="h-1 w-12 overflow-hidden rounded-full bg-raised">
				<div className={clsx("h-full", bar)} style={{ width: `${percent}%` }} />
			</div>
			<span className={clsx("font-mono text-[10px] tabular-nums", tone)}>{t("agentChat.percent", { value: percent })}</span>
		</div>
	);
}

function ModeSelect({
	mode,
	running,
	onChange,
}: {
	mode: string;
	running: boolean;
	onChange: (mode: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const { t } = useTranslation("components1");
	const current = PERMISSION_MODES.find((entry) => entry.id === mode);

	useEffect(() => {
		if (!open) return;
		const dismiss = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", dismiss);
		window.addEventListener("keydown", escape);
		return () => {
			window.removeEventListener("mousedown", dismiss);
			window.removeEventListener("keydown", escape);
		};
	}, [open]);

	return (
		<div ref={box} className="relative">
			<Button
				size="sm"
				icon={ChevronDown}
				onClick={() => setOpen((value) => !value)}
				title={current?.hint}
				className={clsx(mode === "bypassPermissions" && "text-critical")}
			>
				{current?.label ?? mode}
			</Button>

			{open ? (
				<div className="panel animate-in absolute top-7 left-0 z-50 w-64 overflow-hidden p-1 shadow-xl shadow-black/40">
					{PERMISSION_MODES.map((entry) => (
						<button
							key={entry.id}
							type="button"
							onClick={() => {
								setOpen(false);
								onChange(entry.id);
							}}
							className="focus-ring flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
						>
							<Check
								size={12}
								className={clsx(
									"mt-0.5 shrink-0",
									entry.id === mode ? "text-accent-soft" : "text-transparent",
								)}
							/>
							<span className="min-w-0 flex-1">
								<span
									className={clsx(
										"block text-[11px] font-medium",
										entry.id === "bypassPermissions" ? "text-critical" : "text-ink",
									)}
								>
									{entry.label}
								</span>
								<span className="block text-[10px] leading-snug text-ink-faint">
									{entry.hint}
								</span>
							</span>
						</button>
					))}
					{running ? (
						<p className="px-2 py-1.5 text-[10px] leading-snug text-ink-faint">
							{t("agentChat.mode.restartNote")}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Ce dont l'agent dispose vraiment : ses serveurs MCP, ses skills, ses agents.
 *
 * Le cockpit annonçait ce que le `.mcp.json` déclarait ; l'agent travaillait
 * avec ce qui avait répondu. Entre les deux, rien ne disait qu'un serveur était
 * tombé ou qu'une autorisation avait expiré : l'agent ne s'en servait pas, et
 * ça passait pour un choix de sa part.
 *
 * **L'état à l'ouverture ne veut rien dire.** Mesuré sur seize serveurs : onze
 * s'y déclarent en cours de connexion, et sont connectés vingt-cinq secondes
 * plus tard. Afficher cet instantané reviendrait à crier onze pannes à chaque
 * agent lancé. On pose donc la question à la session, un peu après son
 * démarrage — c'est la seule réponse qui distingue le serveur qui met du temps
 * de celui qui ne viendra jamais.
 *
 * Et la pastille se tait quand tout va : un moniteur qui parle sans arrêt finit
 * par ne plus être lu.
 */

/** Le délai laissé aux serveurs avant de les juger. Mesuré, pas supposé. */
const DELAI_CONNEXION = 20_000;

/**
 * Deux façons de ne pas marcher, qui n'appellent pas le même geste.
 *
 * Une autorisation qui manque se règle en l'accordant — c'est une tâche, pas
 * une panne. Un serveur qui ne répond pas est cassé. Les peindre de la même
 * couleur, c'est laisser chercher lequel des deux demande quoi.
 */
interface EtatMcp {
	libelle: string;
	ton: "success" | "warning" | "critical";
	/** L'agent n'a aucun de ses outils : c'est ce qui justifie d'alerter. */
	ennui: boolean;
	aide: string;
}

/** Le ton et la gravité de chaque état ; le libellé et l'aide se lisent au rendu. */
const ETATS_MCP: Record<string, Pick<EtatMcp, "ton" | "ennui"> & { cle: string }> = {
	connected: { cle: "connected", ton: "success", ennui: false },
	pending: { cle: "pending", ton: "success", ennui: false },
	"needs-auth": { cle: "needsAuth", ton: "warning", ennui: true },
	failed: { cle: "failed", ton: "critical", ennui: true },
};

function etatMcp(status: string): EtatMcp {
	const connu = ETATS_MCP[status];
	if (!connu) {
		return {
			libelle: status,
			ton: "critical",
			ennui: true,
			aide: i18nT("components1:agentChat.mcpState.unknownHelp"),
		};
	}
	return {
		libelle: i18nT(`components1:agentChat.mcpState.${connu.cle}`),
		ton: connu.ton,
		ennui: connu.ennui,
		aide: i18nT(`components1:agentChat.mcpState.${connu.cle}Help`),
	};
}

function Equipement({ run }: { run: AgentRun }) {
	const { t } = useTranslation("components1");
	const [ouvert, setOuvert] = useState(false);
	const { servers, probed, skills, subagents, plugins } = run.equipment;

	// La question se pose seule, une fois la session en place : sans elle,
	// personne n'est prévenu — il faudrait penser à aller voir, ce qui est
	// exactement ce qu'on ne fait pas quand on ne sait pas qu'il y a un problème.
	useEffect(() => {
		if (!run.sessionId || !run.running || !hasTauri()) return;
		const sonde = () => void api.agents.probeMcp(run.sessionId!).catch(() => undefined);
		const attente = setTimeout(sonde, probed ? 0 : DELAI_CONNEXION);
		return () => clearTimeout(attente);
		// Volontairement lié à la seule session : rouvrir l'onglet repose la
		// question, ce qui est le moment où on veut une réponse fraîche.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [run.sessionId, run.running]);

	const fautifs = servers.filter((serveur) => etatMcp(serveur.status).ennui);
	const connectés = servers.filter((serveur) => serveur.status === "connected").length;

	// Rien à dire tant que rien ne cloche : ni pastille verte, ni compteur.
	// L'équipement reste consultable par le menu, il n'a juste pas à occuper
	// l'en-tête pour annoncer que tout va bien.
	if (!ouvert && fautifs.length === 0) {
		return probed && servers.length > 0 ? (
			<Button
				size="sm"
				icon={Plug}
				onClick={() => setOuvert(true)}
				title={t("agentChat.equipment.connectedTitle", { count: connectés })}
			/>
		) : null;
	}

	return (
		<div className="relative">
			<Button
				size="sm"
				icon={fautifs.length > 0 ? PlugZap : Plug}
				active={ouvert}
				// Le ton du pire de ses serveurs : un seul en échec suffit à passer
				// la pastille au rouge, sans quoi il se cacherait derrière trois
				// autorisations à accorder.
				variant={
					fautifs.some((serveur) => etatMcp(serveur.status).ton === "critical")
						? "danger"
						: fautifs.length > 0
							? "warning"
							: "ghost"
				}
				onClick={() => setOuvert(!ouvert)}
				title={
					fautifs.length > 0
						? t("agentChat.equipment.unavailableTitle", {
								count: fautifs.length,
								names: fautifs.map((serveur) => serveur.name).join(", "),
							})
						: t("agentChat.equipment.title")
				}
			>
				{fautifs.length > 0 ? String(fautifs.length) : undefined}
			</Button>

			{ouvert ? (
				<>
					{/* Un clic ailleurs referme : le panneau ne survit pas à
					    l'attention qu'on porte au reste. */}
					<button
						type="button"
						aria-label={t("agentChat.equipment.close")}
						onClick={() => setOuvert(false)}
						className="fixed inset-0 z-40 cursor-default"
					/>
					<div className="animate-in absolute top-full left-0 z-50 mt-1 w-80 rounded-xl border border-line bg-raised p-2 shadow-lg">
						<div className="flex items-baseline justify-between px-1 pb-1">
							<span className="text-[11px] font-semibold text-ink">{t("agentChat.equipment.servers")}</span>
							<span className="font-mono text-[10px] text-ink-faint">
								{probed ? t("agentChat.equipment.connectedCount", { connected: connectés, total: servers.length }) : "…"}
							</span>
						</div>

						{servers.length === 0 ? (
							<p className="px-1 pb-1 text-[11px] text-ink-faint">
								{probed
									? t("agentChat.equipment.noServers")
									: t("agentChat.equipment.probing")}
							</p>
						) : (
							<ul className="max-h-56 overflow-y-auto">
								{/* Ce qui ne va pas d'abord : c'est pour ça qu'on ouvre. */}
								{[...servers]
									.sort(
										(a, b) =>
											Number(etatMcp(b.status).ennui) - Number(etatMcp(a.status).ennui),
									)
									.map((serveur) => {
										const etat = etatMcp(serveur.status);
										return (
											<li
												key={serveur.name}
												className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-hover"
											>
												<Dot tone={etat.ton} />
												<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
													{serveur.name}
												</span>
												<span
													title={etat.aide}
													className={clsx(
														"shrink-0 text-[10px]",
														etat.ton === "critical"
															? "text-critical"
															: etat.ton === "warning"
																? "text-warning"
																: "text-ink-faint",
													)}
												>
													{etat.libelle}
												</span>
												{/* Relancer un serveur tombé ne touche pas à la
												    conversation : c'est le CLI qui rouvre la
												    connexion, l'agent continue son travail. */}
												{etat.ennui && run.sessionId ? (
													<Button
														size="sm"
														icon={RotateCw}
														title={t("agentChat.equipment.reconnect", { name: serveur.name })}
														onClick={() =>
															void api.agents
																.reconnectMcp(run.sessionId!, serveur.name)
																.then(() =>
																	setTimeout(
																		() =>
																			void api.agents
																				.probeMcp(run.sessionId!)
																				.catch(() => undefined),
																		3000,
																	),
																)
																.catch(() => undefined)
														}
													/>
												) : null}
											</li>
										);
									})}
							</ul>
						)}

						{/* Ce qui est chargé sans être connecté à quoi que ce soit :
						    annoncé une fois au démarrage, et stable ensuite. On donne
						    le compte et les noms — savoir qu'une skill existe ne dit
						    pas laquelle. */}
						<div className="mt-1 border-t border-line-soft pt-1.5">
							<Chargés titre={t("agentChat.equipment.skills")} entrées={skills} />
							<Chargés titre={t("agentChat.equipment.subagents")} entrées={subagents} />
							<Chargés titre={t("agentChat.equipment.plugins")} entrées={plugins} />
						</div>
					</div>
				</>
			) : null}
		</div>
	);
}

/** Une famille de ce qui est chargé : son compte, et ses noms au survol. */
function Chargés({ titre, entrées }: { titre: string; entrées: string[] }) {
	if (entrées.length === 0) return null;
	return (
		<div
			title={entrées.join("\n")}
			className="flex items-baseline justify-between px-1 py-0.5 text-[10px]"
		>
			<span className="text-ink-faint">{titre}</span>
			<span className="min-w-0 flex-1 truncate pl-2 text-right text-ink-muted">
				{entrées.slice(0, 3).join(", ")}
				{entrées.length > 3 ? ` +${entrées.length - 3}` : ""}
			</span>
		</div>
	);
}

/** Depuis combien de temps il travaille, dit court. */
function depuis(at: number | undefined, maintenant: number): string {
	if (!at) return "";
	const secondes = Math.max(0, Math.round((maintenant - at) / 1000));
	if (secondes < 60) return i18nT("components1:agentChat.duration.seconds", { count: secondes });
	const minutes = Math.floor(secondes / 60);
	return minutes < 60
		? i18nT("components1:agentChat.duration.minutes", { count: minutes })
		: i18nT("components1:agentChat.duration.hours", { count: Math.floor(minutes / 60) });
}

/**
 * Les sous-agents au travail, hors du fil.
 *
 * Leur appel vit dans la conversation, à sa place chronologique — et c'est
 * précisément le problème : le maître continue d'écrire, la ligne remonte, et
 * ce qui tourne encore sort de l'écran. On se retrouve à attendre sans savoir
 * qui travaille ni depuis combien de temps.
 *
 * Ce bandeau ne bouge pas tant qu'un sous-agent n'a pas rendu son travail. Il
 * dit qui, sur quoi, et ce qu'il vient de faire ; il disparaît de lui-même
 * quand le dernier a terminé, sa trace restant dans le fil. Rien à replier :
 * ce qui se répare tout seul n'a pas besoin d'un bouton.
 */
function SousAgentsEnCours({
	turns,
	onOuvrir,
}: {
	turns: Turn[];
	onOuvrir: (toolId: string) => void;
}) {
	// Un appel de délégation dont la sortie n'est pas revenue est un sous-agent
	// qui travaille : c'est le même signal qui fait tourner le sablier sur sa
	// ligne, et il n'y en a pas de plus fiable — le CLI n'annonce pas la fin
	// d'un sous-agent autrement que par le résultat de son appel.
	const { t } = useTranslation("components1");
	const actifs = turns.filter(
		(turn) => turn.kind === "tool" && turn.tool === "Task" && turn.output === undefined,
	);

	// Une horloge qui ne tourne que tant qu'il y a quelqu'un à chronométrer.
	// Cinq secondes suffisent : on lit « 2 min », pas un chronomètre.
	const [maintenant, setMaintenant] = useState(() => Date.now());
	useEffect(() => {
		if (actifs.length === 0) return;
		const battement = setInterval(() => setMaintenant(Date.now()), 5000);
		return () => clearInterval(battement);
	}, [actifs.length]);

	if (actifs.length === 0) return null;

	return (
		<div className="hairline-b flex shrink-0 items-center gap-2 overflow-x-auto border-l-2 border-l-info/60 bg-info/[0.07] px-3 py-2">
			<span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-info">
				<Bot size={12} />
				{t("agentChat.subagents.count", { count: actifs.length })}
			</span>

			{actifs.map((turn, index) => {
				const étapes = turn.sub?.length ?? 0;
				// La dernière chose qu'il a faite vaut mieux qu'un compte d'étapes :
				// « Lu editor.tsx » dit où il en est, « 7 étapes » ne dit rien de ce
				// qu'il cherche.
				const dernière = [...(turn.sub ?? [])]
					.reverse()
					.find((interne) => interne.kind === "tool");
				const rôle = String(turn.input?.subagent_type ?? t("agentChat.subagents.defaultRole"));
				const mission = String(turn.input?.description ?? turn.text ?? "");

				return (
					<button
						key={turn.toolId ?? index}
						type="button"
						onClick={() => turn.toolId && onOuvrir(turn.toolId)}
						title={t("agentChat.subagents.openTitle", { role: rôle, mission })}
						className="focus-ring flex min-w-0 shrink-0 items-center gap-2 rounded-lg border border-line-soft bg-raised px-2 py-1 text-left transition-colors hover:border-line"
					>
						<Spinner />
						<span className="min-w-0">
							<span className="block max-w-56 truncate text-[11px] text-ink">
								{mission || rôle}
							</span>
							<span className="block max-w-56 truncate font-mono text-[10px] text-ink-faint">
								{dernière ? actionCourte(dernière) : t("agentChat.subagents.starting", { role: rôle })}
							</span>
						</span>
						<span className="shrink-0 text-right font-mono text-[10px] text-ink-faint tabular-nums">
							{/* Le temps passé d'abord : c'est lui qui dit si l'on attend
							    normalement ou si quelque chose ne va pas. */}
							<span className="block">{depuis(turn.at, maintenant)}</span>
							{étapes > 0 ? (
								<span className="block">
									{t("agentChat.subagents.steps", { count: étapes })}
								</span>
							) : null}
						</span>
					</button>
				);
			})}
		</div>
	);
}

/** Badge d'état, partagé par le panneau et le dock. */
export function RunState({ run }: { run: AgentRun }) {
	const { t } = useTranslation("components1");
	if (!run.running) return <Badge>{t("agentChat.runState.done")}</Badge>;
	if (run.thinking) return <Badge tone="info">{run.activity ?? t("agentChat.runState.thinking")}</Badge>;
	return <Badge tone="success">{t("agentChat.runState.ready")}</Badge>;
}
