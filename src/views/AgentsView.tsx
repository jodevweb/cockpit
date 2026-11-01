import clsx from "clsx";
import {
	Activity,
	ArrowDown,
	BookMarked,
	Bot,
	Brain,
	ChevronRight,
	FolderOpen,
	PanelsTopLeft,
	PlayCircle,
	RefreshCw,
	Terminal,
	Gauge,
	MessageSquare,
	User,
	Wand2,
	Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { NotebookPanel } from "@/components/NotebookPanel";
import { ReliabilityPanel } from "@/components/ReliabilityPanel";
import { PromptLauncher } from "@/components/PromptLauncher";
import { toolIcon } from "@/components/ToolCall";
import { UsagePanel } from "@/components/UsagePanel";
import {
	Badge,
	Button,
	Dot,
	Empty,
	ErrorNote,
	Row,
	SearchField,
	Section,
	SkeletonRows,
	Spinner,
	ViewHeader,
} from "@/components/ui";
import {
	compactNumber,
	fromIso,
	fromSeconds,
	modelLabel,
	shortPath,
	truncate,
} from "@/lib/format";
import { api } from "@/lib/ipc";
import type { SessionEvent, SessionSummary } from "@/lib/types";
import { useAsync, usePersistentState } from "@/lib/useAsync";
import { useStickToBottom } from "@/lib/useStickToBottom";
import { useAgentActions, useOpenRunFor } from "@/app/agents";
import { useAllSessions, useCockpit } from "@/app/store";

/** Un agent est « vivant » si son journal a bougé dans les 3 dernières minutes. */
function activityTone(idleSeconds: number) {
	if (idleSeconds < 180) return { tone: "success" as const, label: "actif", pulse: true };
	if (idleSeconds < 3600)
		return { tone: "warning" as const, label: "récent", pulse: false };
	return { tone: "neutral" as const, label: "dormant", pulse: false };
}

function SessionRow({
	session,
	selected,
	onSelect,
}: {
	session: SessionSummary;
	selected: boolean;
	onSelect: () => void;
}) {
	const activity = activityTone(session.idleSeconds);
	const tokens = session.usage.input + session.usage.output + session.usage.cacheWrite;

	return (
		<Row selected={selected} onClick={onSelect}>
			<div className="flex items-center gap-2">
				<Dot tone={activity.tone} pulse={activity.pulse} />
				<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
					{session.title}
				</span>
				{session.awaitingInput && session.idleSeconds < 3600 ? (
					<Badge tone="critical">attend</Badge>
				) : null}
				{session.hasError ? <Badge tone="critical">err</Badge> : null}
			</div>
			<div className="mt-1 flex items-center gap-2 pl-3.5 text-[10px] text-ink-faint">
				<span className="truncate font-mono">
					{session.gitBranch ?? shortPath(session.cwd, 1)}
				</span>
				<span className="ml-auto shrink-0 tabular-nums">
					{fromSeconds(session.idleSeconds)}
				</span>
			</div>
			<div className="mt-1 flex items-center gap-2.5 pl-3.5 font-mono text-[10px] text-ink-faint/70">
				<span title="échanges">
					{session.userMessages}↔{session.assistantMessages}
				</span>
				<span title="appels d'outils">{session.toolCalls} outils</span>
				{session.subagents > 0 ? (
					<span className="text-accent-soft/80" title="sous-agents">
						{session.subagents} agents
					</span>
				) : null}
				<span className="ml-auto" title="tokens (entrée + sortie + écriture cache)">
					{compactNumber(tokens)} tk
				</span>
			</div>
		</Row>
	);
}

const EVENT_STYLES: Record<
	string,
	{
		icon: React.ComponentType<{ size?: number; className?: string }>;
		accent: string;
		label: string;
	}
> = {
	user: { icon: User, accent: "text-accent-soft", label: "Toi" },
	assistant: { icon: Bot, accent: "text-ink", label: "Agent" },
	thinking: { icon: Brain, accent: "text-ink-faint", label: "Réflexion" },
	tool: { icon: Wrench, accent: "text-info", label: "Outil" },
	"tool-result": { icon: ChevronRight, accent: "text-ink-faint", label: "Retour" },
	"tool-error": { icon: ChevronRight, accent: "text-critical", label: "Erreur" },
};

function TimelineEntry({ event, cwd }: { event: SessionEvent; cwd: string }) {
	const [expanded, setExpanded] = useState(false);
	const style = EVENT_STYLES[event.kind] ?? EVENT_STYLES.assistant;
	const long = event.text.length > 700;
	const body = expanded || !long ? event.text : `${event.text.slice(0, 700)}…`;

	if (
		event.kind === "tool" ||
		event.kind === "tool-result" ||
		event.kind === "tool-error"
	) {
		// L'icône vient de l'outil lui-même, pas de la catégorie « outil » : lire
		// un fichier, lancer des tests et déléguer à un sous-agent portaient la
		// même clé à molette, et le journal se lisait comme une seule masse.
		const call = event.kind === "tool";
		const Icon = call ? toolIcon(event.tool) : style.icon;
		const failed = event.kind === "tool-error";
		return (
			<div
				className={clsx(
					"animate-in group flex gap-2.5 py-1 pr-4",
					// Les retours s'indentent sous leur appel : c'est ce qui rattache
					// une sortie à ce qui l'a produite, sans tracer de fil.
					call ? "pl-4" : "pl-9",
				)}
			>
				<Icon
					size={12}
					className={clsx(
						"mt-1 shrink-0",
						failed ? "text-critical" : call ? "text-info" : "text-ink-faint",
					)}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						{event.tool && call ? (
							<span className="shrink-0 font-mono text-[11px] font-medium text-info">
								{event.tool}
							</span>
						) : null}
						<button
							type="button"
							onClick={() => setExpanded((open) => !open)}
							className={clsx(
								"text-selectable min-w-0 flex-1 truncate text-left font-mono text-[11px] hover:text-ink-muted",
								failed ? "text-critical" : "text-ink-faint",
							)}
						>
							{event.text.split("\n")[0] || "—"}
						</button>
					</div>
					{expanded ? (
						<pre className="text-selectable mt-1.5 max-h-80 overflow-auto rounded-lg border border-line-soft bg-void p-2.5 font-mono text-[11px] whitespace-pre-wrap text-ink-muted">
							{event.detail ?? event.text}
						</pre>
					) : null}
				</div>
			</div>
		);
	}

	if (event.kind === "thinking") {
		return (
			<div className="animate-in px-4 py-1.5">
				<button
					type="button"
					onClick={() => setExpanded((open) => !open)}
					className="flex items-center gap-2 text-[11px] text-ink-faint italic hover:text-ink-muted"
				>
					<Brain size={11} />
					Réflexion interne
					<ChevronRight
						size={11}
						className={clsx("transition-transform", expanded && "rotate-90")}
					/>
				</button>
				{expanded ? (
					<p className="text-selectable mt-1.5 border-l-2 border-line pl-3 text-[11px] whitespace-pre-wrap text-ink-faint italic">
						{event.text}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<div
			className={clsx(
				"animate-in px-4 py-2.5",
				event.kind === "user" && "border-l-2 border-accent/50 bg-accent/[0.03]",
			)}
		>
			<div className="mb-1 flex items-center gap-2">
				<style.icon size={12} className={style.accent} />
				<span className="text-[10px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
					{style.label}
				</span>
				{event.model ? (
					<span className="font-mono text-[10px] text-ink-faint/60">
						{modelLabel(event.model)}
					</span>
				) : null}
				<span className="ml-auto font-mono text-[10px] text-ink-faint/60">
					{fromIso(event.timestamp)}
				</span>
			</div>
			{event.kind === "user" ? (
				<p className="text-selectable text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
					{body}
				</p>
			) : (
				<Markdown source={body} cwd={cwd} />
			)}
			{long ? (
				<button
					type="button"
					onClick={() => setExpanded((open) => !open)}
					className="mt-1 text-[11px] text-accent-soft hover:underline"
				>
					{expanded ? "Réduire" : "Tout afficher"}
				</button>
			) : null}
		</div>
	);
}

function SessionContext({
	session,
	live,
	onResumeHere,
}: {
	session: SessionSummary;
	/** Cette session est déjà ouverte dans son workspace. */
	live: boolean;
	onResumeHere: () => void;
}) {
	const { notify } = useCockpit();
	const subagents = useAsync(() => api.sessions.subagents(session.file), [session.file]);
	const usage = session.usage;
	const total = usage.input + usage.output + usage.cacheWrite;

	const resume = () => {
		void api.system
			.openTerminal(session.cwd, `claude --resume ${session.id}`)
			.catch((error) => notify(String(error)));
	};

	return (
		<aside className="hairline-r flex w-72 shrink-0 flex-col overflow-y-auto bg-base">
			<div className="flex flex-col gap-2 p-3">
				{/* Un agent déjà ouvert ne se reprend pas : on va le voir. Le bouton
				    change donc de verbe, faute de quoi on relançait un second agent
				    sur le même fil sans que rien ne le dise. */}
				<Button
					variant="solid"
					icon={live ? PanelsTopLeft : MessageSquare}
					onClick={onResumeHere}
					className="h-8 w-full justify-center"
					title={
						live
							? "Cette conversation tourne déjà — aller la voir dans son workspace"
							: "Rouvre la conversation dans un workspace du cockpit"
					}
				>
					{live ? "Aller à la conversation" : "Reprendre la conversation"}
				</Button>
				<Button
					icon={PlayCircle}
					onClick={resume}
					className="h-8 w-full justify-center"
					title="Rouvre la conversation dans Terminal.app"
				>
					Reprendre dans Terminal
				</Button>
				<div className="grid grid-cols-2 gap-2">
					<Button
						variant="outline"
						icon={FolderOpen}
						className="h-7 justify-center"
						onClick={() => {
							void api.system
								.openEditor(session.cwd)
								.catch((error) => notify(String(error)));
						}}
					>
						Éditeur
					</Button>
					<Button
						variant="outline"
						icon={Terminal}
						className="h-7 justify-center"
						onClick={() => {
							void api.system
								.openTerminal(session.cwd)
								.catch((error) => notify(String(error)));
						}}
					>
						Terminal
					</Button>
				</div>
			</div>

			<div className="flex flex-col gap-3 px-3 pb-4">
				<Section title="Contexte">
					<dl className="flex flex-col gap-1.5 text-[11px]">
						{[
							["Répertoire", shortPath(session.cwd, 2)],
							["Branche", session.gitBranch ?? "—"],
							["Modèles", session.models.map(modelLabel).join(", ") || "—"],
							["Démarrée", fromIso(session.startedAt)],
							["Dernière écriture", fromSeconds(session.idleSeconds)],
							["Version CLI", session.cliVersion ?? "—"],
							["Identifiant", session.id.slice(0, 8)],
						].map(([label, value]) => (
							<div key={label} className="flex items-baseline justify-between gap-3">
								<dt className="shrink-0 text-ink-faint">{label}</dt>
								<dd className="text-selectable truncate text-right font-mono text-ink-muted">
									{value}
								</dd>
							</div>
						))}
					</dl>
				</Section>

				<Section title="Consommation">
					<div className="grid grid-cols-2 gap-1.5">
						{[
							["entrée", usage.input],
							["sortie", usage.output],
							["cache lu", usage.cacheRead],
							["cache écrit", usage.cacheWrite],
						].map(([label, value]) => (
							<div
								key={label as string}
								className="rounded-lg border border-line-soft bg-surface px-2 py-1.5"
							>
								<div className="text-[10px] text-ink-faint">{label}</div>
								<div className="font-mono text-[12.5px] text-ink-muted tabular-nums">
									{compactNumber(value as number)}
								</div>
							</div>
						))}
					</div>
					<p className="mt-1.5 text-[10px] text-ink-faint">
						{compactNumber(total)} tokens facturables cumulés (hors cache lu).
					</p>
				</Section>

				{session.topTools.length > 0 ? (
					<Section title="Outils">
						<div className="flex flex-wrap gap-1">
							{session.topTools.map((tool) => (
								<span
									key={tool.name}
									className="flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
								>
									{tool.name}
									<span className="text-ink-faint">{tool.count}</span>
								</span>
							))}
						</div>
					</Section>
				) : null}

				{(subagents.data ?? []).length > 0 ? (
					<Section title="Sous-agents" count={subagents.data?.length}>
						<div className="flex flex-col gap-1">
							{subagents.data?.map((run) => (
								<div
									key={run.id}
									className="rounded-lg border border-line-soft bg-surface px-2 py-1.5"
								>
									<div className="flex items-center gap-1.5">
										<Bot size={11} className="text-accent-soft" />
										<span className="truncate text-[11px] font-medium text-ink-muted">
											{run.name || "agent"}
										</span>
										<Badge tone={run.status === "completed" ? "success" : "neutral"}>
											{run.status}
										</Badge>
									</div>
									{run.description ? (
										<p className="mt-0.5 line-clamp-2 text-[10px] text-ink-faint">
											{truncate(run.description, 140)}
										</p>
									) : null}
								</div>
							))}
						</div>
					</Section>
				) : null}

				{session.filesTouched.length > 0 ? (
					<Section title="Fichiers écrits" count={session.filesTouched.length}>
						<div className="flex flex-col gap-0.5">
							{session.filesTouched.slice(0, 40).map((file) => (
								<button
									key={file}
									type="button"
									title={file}
									onClick={() => {
										void api.system.reveal(file).catch(() => undefined);
									}}
									className="truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-ink-faint hover:bg-surface hover:text-ink-muted"
								>
									{file.replace(session.cwd + "/", "")}
								</button>
							))}
						</div>
					</Section>
				) : null}
			</div>
		</aside>
	);
}

/**
 * Ce qu'on montre à la place d'une conversation qui vit ailleurs.
 *
 * Cet écran lit des journaux : ce qu'il affiche est toujours en retard d'une
 * écriture sur disque, et n'accepte pas de réponse. Le recopier à côté de
 * l'agent avec qui on est en train de parler donnait deux fois la même
 * conversation, dont une fausse. Le journal reste accessible d'un clic — on
 * vient parfois y chercher un tour ancien, sorti du fil.
 */
function LiveElsewhere({
	onGo,
	onReadArchive,
}: {
	onGo: () => void;
	onReadArchive: () => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6">
			<Empty
				icon={MessageSquare}
				message="Conversation ouverte dans son workspace"
				hint="C'est là qu'elle se poursuit, en direct. Ici, on ne lirait que son journal — figé à la dernière écriture, et sans pouvoir répondre."
			/>
			<div className="flex items-center gap-2">
				<Button variant="solid" icon={PanelsTopLeft} onClick={onGo}>
					Aller à la conversation
				</Button>
				<Button variant="outline" onClick={onReadArchive}>
					Lire le journal
				</Button>
			</div>
		</div>
	);
}

export function AgentsView() {
	const { sessionsError, sessionsLoading, reloadSessions, focus, clearFocus, activeProject } =
		useCockpit();
	const { open: openAgent, show: showAgent } = useAgentActions();
	const sessions = useAllSessions();
	const [query, setQuery] = useState("");
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [showThinking, setShowThinking] = usePersistentState("agents.thinking", false);
	const [showTools, setShowTools] = usePersistentState("agents.tools", true);

	// Une session ciblée depuis une autre vue (ou la palette) prend la main.
	useEffect(() => {
		if (focus.sessionFile) {
			setSelectedFile(focus.sessionFile);
			clearFocus();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focus.sessionFile]);

	const [scope, setScope] = useState<"live" | "recent" | "all">("recent");

	// Le journal d'une session ne s'efface jamais : sans filtre, la colonne
	// empile des mois de sessions dormantes et noie les deux qui tournent.
	const scoped = useMemo(() => {
		if (scope === "all") return sessions;
		const ceiling = scope === "live" ? 180 : 3600;
		return sessions.filter((session) => session.idleSeconds < ceiling);
	}, [sessions, scope]);

	const hidden = sessions.length - scoped.length;

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		// Une recherche explicite porte sur tout : on cherche justement ce qui
		// n'est plus à l'écran.
		const pool = needle ? sessions : scoped;
		if (!needle) return pool;
		return pool.filter((session) =>
			[session.title, session.cwd, session.gitBranch ?? "", session.lastPrompt ?? ""]
				.join(" ")
				.toLowerCase()
				.includes(needle),
		);
	}, [sessions, scoped, query]);

	const selected = useMemo(
		() => filtered.find((session) => session.file === selectedFile) ?? filtered[0] ?? null,
		[filtered, selectedFile],
	);

	// La session affichée tourne-t-elle déjà dans un workspace ? Si oui,
	// cet écran n'en montrerait qu'une photo — prise à la dernière écriture sur
	// disque — juste à côté de la vraie. On propose d'y aller plutôt.
	const liveRunId = useOpenRunFor(selected?.id);
	const [archive, setArchive] = useState(false);
	useEffect(() => setArchive(false), [selected?.file]);
	const showTimeline = !liveRunId || archive;

	// On dépend de `updatedAt`, pas de `idleSeconds` : ce dernier est recalculé
	// à chaque scan et relancerait la lecture du journal en boucle.
	const timeline = useAsync(
		() => (selected ? api.sessions.timeline(selected.file, 500) : Promise.resolve([])),
		[selected?.file, selected?.updatedAt],
		// Relire cinq cents événements à chaque écriture d'un agent qu'on ne
		// regarde pas ici, c'est du disque pour rien.
		{ enabled: Boolean(selected) && showTimeline },
	);

	const events = useMemo(() => {
		const list = timeline.data ?? [];
		return list.filter((event) => {
			if (!showThinking && event.kind === "thinking") return false;
			if (!showTools && event.kind.startsWith("tool")) return false;
			return true;
		});
	}, [timeline.data, showThinking, showTools]);

	// La timeline se lit du plus ancien au plus récent : sans recalage, chaque
	// écriture de l'agent arrive hors écran, en bas.
	const bottom = useStickToBottom<HTMLDivElement>([events, selected?.file]);
	const [launcherCwd, setLauncherCwd] = useState<string | null>(null);
	const [showUsage, setShowUsage] = useState(false);
	const [showNotebook, setShowNotebook] = useState(false);
	const [showReliability, setShowReliability] = useState(false);

	// `show` met la conversation au premier plan de son workspace et y emmène :
	// c'est là, et seulement là, qu'elle s'affiche.
	const goToLive = () => {
		if (liveRunId) showAgent(liveRunId);
	};

	const live = sessions.filter((session) => session.idleSeconds < 180).length;

	return (
		<>
			<ViewHeader
				title="Agents IA"
				subtitle={
					<span className="flex items-center gap-2">
						{live > 0 ? (
							<span className="flex items-center gap-1.5 text-success">
								<Dot tone="success" pulse /> {live} agent{live > 1 ? "s" : ""} en activité
							</span>
						) : (
							<span>Aucun agent actif</span>
						)}
						<span className="text-ink-faint/60">·</span>
						<span>{sessions.length} sessions indexées</span>
					</span>
				}
				actions={
					<>
						<Button
							size="sm"
							active={showTools}
							onClick={() => setShowTools(!showTools)}
							title="Afficher les appels d'outils"
						>
							Outils
						</Button>
						<Button
							size="sm"
							active={showThinking}
							onClick={() => setShowThinking(!showThinking)}
							title="Afficher la réflexion interne"
						>
							Réflexion
						</Button>
						{/* Le carnet vit ici : c'est l'écran des agents, et ce qu'il
						    contient part avec eux. */}
						<Button
							size="sm"
							icon={BookMarked}
							onClick={() => setShowNotebook(true)}
							title="Ce que ce dépôt a déjà eu à corriger derrière un agent"
						>
							Carnet
						</Button>
						{/* La mesure à côté du carnet : les deux disent si la boucle
						    tient, l'un par ce qu'on a corrigé, l'autre par ce que les
						    garde-fous attrapent encore. */}
						<Button
							size="sm"
							icon={Activity}
							onClick={() => setShowReliability(true)}
							title="Ce que les agents rendent, ce qu'il faut reprendre, ce que les garde-fous attrapent"
						>
							Boucle
						</Button>
						<Button
							size="sm"
							icon={Gauge}
							onClick={() => setShowUsage(true)}
							title="Consommation en jetons — volumes, pas quota"
						>
							Conso
						</Button>
						{sessionsLoading ? <Spinner /> : null}
						<Button size="sm" icon={RefreshCw} onClick={reloadSessions} title="Rescanner" />
					</>
				}
			/>

			{sessionsError ? <ErrorNote error={sessionsError} onRetry={reloadSessions} /> : null}

			<div className="flex min-h-0 flex-1">
				<div className="hairline-r flex w-80 shrink-0 flex-col bg-base">
					<div className="flex flex-col gap-1.5 p-2.5">
						<SearchField
							value={query}
							onChange={setQuery}
							placeholder="Filtrer les sessions…"
						/>
						<div className="flex items-center gap-1">
							{(
								[
									["live", "En cours"],
									["recent", "Récentes"],
									["all", "Toutes"],
								] as Array<["live" | "recent" | "all", string]>
							).map(([id, label]) => (
								<Button
									key={id}
									size="sm"
									active={scope === id}
									onClick={() => setScope(id)}
								>
									{label}
								</Button>
							))}
							<span className="ml-auto font-mono text-[10px] text-ink-faint tabular-nums">
								{filtered.length}
							</span>
						</div>
						{hidden > 0 && !query.trim() ? (
							<button
								type="button"
								onClick={() => setScope("all")}
								className="text-left text-[10px] text-ink-faint hover:text-ink-muted"
							>
								{hidden} session{hidden > 1 ? "s" : ""} dormante{hidden > 1 ? "s" : ""}{" "}
								masquée
								{hidden > 1 ? "s" : ""} — tout afficher
							</button>
						) : null}
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
						{filtered.length === 0 ? (
							<Empty
								icon={Bot}
								message="Aucune session"
								hint="Les sessions apparaissent dès qu'un agent Claude Code écrit dans ~/.claude/projects."
							/>
						) : (
							filtered.map((session) => (
								<SessionRow
									key={session.file}
									session={session}
									selected={selected?.file === session.file}
									onSelect={() => setSelectedFile(session.file)}
								/>
							))
						)}
					</div>
				</div>

				<div className="flex min-w-0 flex-1 flex-col bg-base">
					{selected ? (
						<>
							<div className="hairline-b flex items-center gap-2 px-4 py-2">
								<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
									{selected.title}
								</span>
								<Button
									size="sm"
									icon={Wand2}
									onClick={() => setLauncherCwd(selected.cwd)}
									title="Lancer un agent sur ce dossier avec un prompt tout prêt"
								>
									Actions
								</Button>
								{showTimeline && !bottom.stuck ? (
									<Button
										size="sm"
										icon={ArrowDown}
										onClick={() => {
											const node = bottom.ref.current;
											if (node) node.scrollTop = node.scrollHeight;
										}}
										title="Revenir aux derniers événements"
									>
										En bas
									</Button>
								) : null}
								{showTimeline ? (
									<Badge mono>{events.length} événements</Badge>
								) : (
									<Badge tone="success">en cours</Badge>
								)}
							</div>
							{showTimeline ? (
								<div
									ref={bottom.ref}
									onScroll={bottom.onScroll}
									className="min-h-0 flex-1 divide-y divide-line-soft/60 overflow-y-auto"
								>
									{timeline.error ? (
										<ErrorNote error={timeline.error} onRetry={timeline.reload} />
									) : null}
									{timeline.initial && timeline.loading ? (
										<SkeletonRows rows={6} className="px-4 py-6" />
									) : null}
									{events.map((event) => (
										<TimelineEntry
											key={`${event.index}-${event.kind}`}
											event={event}
											cwd={selected.cwd}
										/>
									))}
									{!timeline.loading && events.length === 0 ? (
										<Empty message="Rien à afficher avec ces filtres." />
									) : null}
								</div>
							) : (
								<LiveElsewhere onGo={goToLive} onReadArchive={() => setArchive(true)} />
							)}
						</>
					) : (
						<Empty
							icon={Bot}
							message="Sélectionne une session"
							hint="Chaque session correspond à un agent lancé dans un worktree."
						/>
					)}
				</div>

				{selected ? (
					<SessionContext
						session={selected}
						live={Boolean(liveRunId)}
						onResumeHere={() =>
							liveRunId
								? goToLive()
								: openAgent(selected.cwd, "", selected.id, selected.file)
						}
					/>
				) : null}
			</div>

			{launcherCwd ? (
				<PromptLauncher cwd={launcherCwd} onClose={() => setLauncherCwd(null)} />
			) : null}

			{showUsage ? <UsagePanel onClose={() => setShowUsage(false)} /> : null}

			{showReliability ? (
				<ReliabilityPanel
					project={activeProject?.mainRepo ?? ""}
					onClose={() => setShowReliability(false)}
				/>
			) : null}

			{showNotebook ? (
				<NotebookPanel
					project={activeProject?.mainRepo ?? ""}
					onClose={() => setShowNotebook(false)}
				/>
			) : null}
		</>
	);
}
