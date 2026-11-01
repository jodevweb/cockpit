import clsx from "clsx";
import { AudioLines, CornerDownLeft, Loader2, Mic, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentActions, useAgentRuns } from "@/app/agents";
import { useCockpit, type ViewId } from "@/app/store";
import { useWorkspace } from "@/app/workspace";
import { useChangeTour } from "@/components/ChangeTour";
import {
	type AssistantContext,
	buildPrompt,
	type Decision,
	acceleratorOf,
	parseDecision,
	resolve,
	SHORTCUT_EVENT,
	shortcutLabel,
	SYSTEM,
} from "@/lib/assistant";
import { api, events, type ShortcutStatus } from "@/lib/ipc";
import { humanize, say, setNarrated } from "@/lib/narrator";
import { hasTauri } from "@/lib/preview";
import { recentFolders, rememberFolder } from "@/lib/recentFolders";
import { useReviewFlow } from "@/app/review";
import { createWorktreeTracked } from "@/lib/worktreeFlow";
import { startActivity, withActivity } from "@/lib/activity";

/**
 * L'assistant vocal : ⌥ Espace maintenu, on parle, on relâche ; il comprend,
 * agit dans le cockpit, et répond à voix haute.
 *
 * ⌘J ouvre la même chose au clavier : pour quand on ne peut pas parler, et
 * pour vérifier ce qu'il comprend sans micro.
 */

/** Le raccourci pour parler, tel qu'il est vraiment réglé. */
function useShortcut(): ShortcutStatus | null {
	const [status, setStatus] = useState<ShortcutStatus | null>(null);
	useEffect(() => {
		const load = () => void api.assistant.shortcut().then(setStatus).catch(() => undefined);
		load();
		window.addEventListener(SHORTCUT_EVENT, load);
		return () => window.removeEventListener(SHORTCUT_EVENT, load);
	}, []);
	return status;
}

const VIEWS: Array<{ id: ViewId; label: string }> = [
	{ id: "map", label: "Carte — tous les projets et le travail en cours" },
	{ id: "today", label: "Aujourd'hui" },
	{ id: "overview", label: "Vue d'ensemble" },
	{ id: "team", label: "Daily de l'équipe" },
	{ id: "missions", label: "Missions" },
	{ id: "workspace", label: "Workspaces, agents et terminaux ouverts" },
	{ id: "agents", label: "Agents IA, historique des sessions" },
	{ id: "worktrees", label: "Worktrees" },
	{ id: "git", label: "Git, branches" },
	{ id: "delivery", label: "Flux : Linear, PR, CI, déploiements" },
	{ id: "impact", label: "Impact" },
	{ id: "observability", label: "Observabilité" },
	{ id: "docs", label: "Documents" },
	{ id: "scripts", label: "Scripts" },
	{ id: "infra", label: "Serveurs et conteneurs" },
	{ id: "permanence", label: "Permanence" },
	{ id: "settings", label: "Réglages" },
];

type Phase = "idle" | "listening" | "transcribing" | "thinking" | "done" | "answered" | "error";

function folderOf(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

export function Assistant() {
	const { go, view, worktrees, projectList, activeProject, switchProject, runJob, config } = useCockpit();
	const { runs } = useAgentRuns();
	const { open: openAgent, send: sendAgent, show: showAgent } = useAgentActions();
	const { showGroup, cwd: workspaceCwd, tab: workspaceTab } = useWorkspace();
	const tour = useChangeTour();
	const startReview = useReviewFlow();
	// La PR d'Ici, retenue à la demande : « relis-la » ne la nomme pas.
	const herePr = useRef<number | null>(null);

	const shortcut = useShortcut();
	const talk = shortcutLabel(shortcut?.accelerator ?? "alt+Space");
	const { notify } = useCockpit();

	// Un raccourci qui n'a pas pris se dit une fois, au démarrage : sans ça, on
	// maintient la touche, rien ne se passe, et rien ne dit pourquoi.
	const warned = useRef(false);
	useEffect(() => {
		if (!shortcut || shortcut.registered || warned.current || !hasTauri()) return;
		warned.current = true;
		notify(`${shortcutLabel(shortcut.accelerator)} est déjà pris : l'assistant vocal ne t'entendra pas`, {
			label: "Choisir un raccourci",
			onClick: () => go("settings", { settingsTab: "voice" }),
		});
	}, [shortcut, notify, go]);
	const [phase, setPhase] = useState<Phase>("idle");
	const [heard, setHeard] = useState("");
	const [reply, setReply] = useState("");
	const [typing, setTyping] = useState(false);
	const [draft, setDraft] = useState("");
	const hide = useRef<number | null>(null);
	// Les dossiers où un agent peut être lancé, relus à chaque demande.
	const places = useRef<string[]>([]);
	const field = useRef<HTMLInputElement>(null);

	// Le contexte se lit au moment de la demande : ce qui est ouvert maintenant.
	const latest = useRef({ view, worktrees, projectList, activeProject, runs, config, workspaceCwd, workspaceTab });
	latest.current = { view, worktrees, projectList, activeProject, runs, config, workspaceCwd, workspaceTab };
	// Ce qu'« Ici » désignait à la dernière demande : l'action s'exécute sur ce
	// que Claude a vu, même si l'écran a bougé entre-temps.
	const here = useRef<{ cwd: string; runId: string | null } | null>(null);

	const settle = useCallback((next: Phase, text: string) => {
		setPhase(next);
		setReply(text);
		// À voix haute, sans les `/` des branches ni les chemins : le bandeau
		// garde le texte exact.
		if (text) say([{ text: humanize(text, 400) || text, keep: true }]);
		if (hide.current) window.clearTimeout(hide.current);
		hide.current = window.setTimeout(() => setPhase("idle"), next === "error" ? 9000 : 6000);
	}, []);

	/** Ce que Claude doit savoir du cockpit pour choisir. */
	const context = useCallback(async (): Promise<AssistantContext> => {
		const now = latest.current;
		const [missions, branches, folders, prs] = await Promise.all([
			api.missions.list().catch(() => []),
			api.git.branches().catch(() => null),
			api.system.folders().catch(() => []),
			api.git.pullRequests().catch(() => []),
		]);

		// Ici : le workspace qu'on regarde, sinon le dernier ouvert. Sans lui,
		// « je suis déjà sur le workspace de la PR » ne désignait rien, et
		// l'assistant répondait en rouvrant ce qui était déjà ouvert.
		const cwd = now.workspaceCwd;
		const inFolder = cwd ? now.runs.filter((run) => run.cwd === cwd) : [];
		const front =
			(now.workspaceTab?.kind === "agent" ? inFolder.find((run) => run.id === now.workspaceTab?.id) : undefined) ??
			inFolder.find((run) => run.running) ??
			null;
		const branch = cwd ? (now.worktrees.find((tree) => tree.path === cwd)?.branch ?? null) : null;
		const pr = branch ? prs.find((entry) => entry.headRef === branch) : undefined;
		here.current = cwd ? { cwd, runId: front?.id ?? null } : null;
		herePr.current = pr?.number ?? null;
		places.current = [
			...new Set([
				...recentFolders(),
				...now.worktrees.map((tree) => tree.path),
				...now.runs.map((run) => run.cwd),
				...(now.config?.mainRepo ? [now.config.mainRepo] : []),
				...folders.map((folder) => folder.path),
			]),
		];
		return {
			view: now.view,
			here: cwd
				? {
						folder: folderOf(cwd),
						branch,
						onScreen: now.view === "workspace",
						agent: front
							? {
									id: front.id,
									label: front.label,
									state: front.thinking ? "travaille" : front.running ? "attend" : "arrêté",
								}
							: null,
						pr: pr ? { number: pr.number, title: pr.title } : null,
					}
				: null,
			prs: prs.slice(0, 40).map((entry) => ({
				number: entry.number,
				title: entry.title,
				branch: entry.headRef,
				author: entry.author,
				reviewers: entry.reviewRequestLogins,
				review: entry.reviewDecision,
			})),
			views: VIEWS,
			projects: now.projectList.map((project) => ({ name: project.name, active: project.id === now.activeProject?.id })),
			worktrees: now.worktrees.map((tree) => ({ folder: tree.folderName, branch: tree.branch })),
			folders: [...new Set(places.current.map(folderOf))].slice(0, 150),
			agents: now.runs.map((run) => ({
				id: run.id,
				label: run.label,
				folder: folderOf(run.cwd),
				state: run.thinking ? "travaille" : run.running ? "attend" : "arrêté",
			})),
			missions: missions.slice(0, 30).map((mission) => ({
				id: mission.id,
				ticket: mission.ticket,
				title: mission.title,
				state: mission.state,
			})),
			branches: (branches?.branches ?? []).filter((branch) => !branch.remoteOnly).slice(0, 60).map((branch) => branch.name),
		};
	}, []);

	/** Fait ce que Claude a décidé ; rend ce qu'il faut dire, ou jette une erreur à dire. */
	const perform = useCallback(
		async (decision: Decision, ctx: AssistantContext): Promise<string> => {
			const now = latest.current;
			const p = decision.params;
			const tree = (folder?: string) => {
				const found = resolve(folder, now.worktrees, (entry) => [entry.folderName, entry.branch ?? ""]);
				if (!found) throw new Error(`Je ne trouve pas le worktree « ${folder ?? ""} ».`);
				return found;
			};
			const agent = (id?: string) => {
				const found = resolve(id, now.runs, (run) => [run.id, run.label, folderOf(run.cwd)]);
				if (!found) throw new Error(`Je ne trouve pas l'agent « ${id ?? ""} ».`);
				return found;
			};
			const mainRepo = now.config?.mainRepo ?? "";

			switch (decision.action) {
				case "go_to": {
					const target = resolve(p.view, VIEWS, (entry) => [entry.id, entry.label]);
					if (!target) throw new Error(`Je ne connais pas l'écran « ${p.view ?? ""} ».`);
					go(target.id);
					break;
				}
				case "switch_project": {
					const project = resolve(p.project, now.projectList, (entry) => [entry.name, entry.id]);
					if (!project) throw new Error(`Je ne trouve pas le projet « ${p.project ?? ""} ».`);
					switchProject(project.id);
					break;
				}
				case "open_workspace": {
					const cwds = [...new Set([...now.runs.map((run) => run.cwd), ...now.worktrees.map((entry) => entry.path)])];
					const cwd = resolve(p.folder, cwds, (path) => [folderOf(path)]);
					if (!cwd) throw new Error(`Je ne trouve pas le workspace « ${p.folder ?? ""} ».`);
					showGroup(cwd);
					go("workspace");
					break;
				}
				case "open_worktree":
					go("worktrees", { worktreePath: tree(p.folder).path });
					break;
				case "start_mission": {
					if (!p.ticket?.trim()) throw new Error("De quel ticket veux-tu partir ?");
					const ticket = p.ticket.trim();
					const result = await withActivity(`Mission depuis ${ticket}`, () => api.missions.startFromTicket(ticket), {
						firstStep: "Je lis le ticket et je lance l'agent maître…",
						result: (value) => (value.started ? `Mission lancée : ${value.mission.title}.` : "La mission existait déjà."),
						action: (value) => ({ label: "Voir", run: () => go("missions", { missionId: value.mission.id }) }),
					});
					go("missions", { missionId: result.mission.id });
					return result.started ? decision.say || result.message : `La mission existait déjà : ${result.mission.title}. Je te l'ouvre.`;
				}
				case "open_mission": {
					const mission = resolve(p.mission, ctx.missions, (entry) => [entry.id, entry.ticket, entry.title]);
					if (!mission) throw new Error(`Je ne trouve pas la mission « ${p.mission ?? ""} ».`);
					go("missions", { missionId: mission.id });
					break;
				}
				case "create_branch": {
					if (!mainRepo) throw new Error("Aucun dépôt principal n'est réglé pour ce projet.");
					const message = await withActivity(`Branche ${p.name ?? ""}`, () => api.git.createBranch(mainRepo, p.name ?? "", p.base || undefined), {
						firstStep: "Je crée la branche…",
						result: (value) => value,
					});
					return decision.say || message;
				}
				case "create_worktree": {
					if (!mainRepo) throw new Error("Aucun dépôt principal n'est réglé pour ce projet.");
					if (!p.branch?.trim()) throw new Error("Pour quelle branche ?");
					// Créer ne suffisait pas : rien n'attendait le worktree, et son
					// workspace ne s'ouvrait jamais. La création suivie l'annonce, puis
					// ouvre le workspace quand il est prêt. On répond sans l'attendre.
					const branch = p.branch.trim();
					void createWorktreeTracked(
						branch,
						{ mainRepo, runJob, openAgent: (cwd, prompt) => openAgent(cwd, prompt, undefined, undefined, true) },
						{
							onReady: (path) => {
								openAgent(path, "", undefined, undefined, true);
								showGroup(path);
								go("workspace");
							},
						},
					).catch(() => undefined);
					break;
				}
				case "review_pr":
				case "recheck_pr": {
					const number = Number.parseInt((p.pr ?? "").replace(/[^0-9]/g, ""), 10) || herePr.current;
					if (!number) throw new Error("Quelle PR veux-tu que je relise ?");
					// Le geste prend du temps (branche, worktree) : on ne l'attend pas
					// pour répondre, ses étapes s'annoncent d'elles-mêmes.
					void startReview(number, decision.action === "recheck_pr" ? "verification" : "revue").catch((error) =>
						settle("error", error instanceof Error ? error.message : String(error).replace(/^(Ipc)?Error:\s*/, "")),
					);
					break;
				}
				case "tell_agent": {
					if (!p.prompt?.trim()) throw new Error("Que dois-je lui demander ?");
					// L'agent nommé, sinon celui d'Ici.
					const target = p.agent?.trim()
						? agent(p.agent)
						: (now.runs.find((run) => run.id === here.current?.runId) ?? null);
					const cwd = target?.cwd ?? here.current?.cwd ?? null;
					if (!cwd) throw new Error("Aucun workspace n'est ouvert : dis-moi dans quel dossier travailler.");
					startActivity(`Consigne pour ${target?.label ?? folderOf(cwd)}`).done(
						target?.running && target.sessionId ? "Consigne envoyée : l'agent s'y met." : "Nouvel agent lancé avec la consigne.",
						{
							label: "Voir",
							run: () => {
								showGroup(cwd);
								go("workspace");
							},
						},
					);
					if (target?.running && target.sessionId) {
						sendAgent(target.id, p.prompt.trim());
						showAgent(target.id);
					} else {
						// Pas d'agent vivant ici : on en lance un, dans le même dossier.
						openAgent(cwd, p.prompt.trim(), undefined, undefined, true);
						showGroup(cwd);
						go("workspace");
					}
					break;
				}
				case "launch_agent": {
					// N'importe quel dossier connu, pas seulement un worktree : ni
					// branche ni worktree à créer, un agent dans le dossier, c'est tout.
					// Sans dossier nommé, celui d'Ici.
					const path = p.folder?.trim()
						? resolve(p.folder, places.current, (candidate) => [folderOf(candidate), candidate])
						: (here.current?.cwd ?? null);
					if (!path) throw new Error(`Je ne trouve pas le dossier « ${p.folder ?? ""} ».`);
					openAgent(path, p.prompt || undefined, undefined, undefined, true);
					rememberFolder(path);
					showGroup(path);
					go("workspace");
					break;
				}
				case "git_pull": {
					const target = tree(p.folder);
					await withActivity(`Pull · ${target.branch ?? target.folderName}`, () => api.git.pull(target.path), {
						firstStep: "Je récupère les derniers commits…",
						result: () => "Branche à jour.",
					});
					break;
				}
				case "git_push": {
					const target = tree(p.folder);
					await withActivity(`Push · ${target.branch ?? target.folderName}`, () => api.git.push(target.path), {
						firstStep: "Je pousse la branche…",
						result: () => "Branche poussée.",
					});
					break;
				}
				case "listen_agent":
					setNarrated(agent(p.agent).id);
					break;
				case "stop_listening":
					setNarrated(null);
					break;
				case "visit_changes":
					tour?.open(agent(p.agent).id);
					break;
				default:
					break;
			}
			return decision.say;
		},
		[go, switchProject, showGroup, openAgent, sendAgent, showAgent, runJob, tour, startReview, settle],
	);

	/** Une phrase, entendue ou tapée : la comprendre et agir. */
	const handle = useCallback(
		async (utterance: string) => {
			const text = utterance.trim();
			if (!text) {
				setPhase("idle");
				return;
			}
			setHeard(text);
			setReply("");
			setPhase("thinking");
			try {
				const ctx = await context();
				const answer = await api.assistant.ask(SYSTEM, buildPrompt(text, ctx));
				const decision = parseDecision(answer);
				if (!decision) throw new Error("Je n'ai pas compris ta demande.");
				const said = await perform(decision, ctx);
				// Sans action, il a répondu ou posé une question : rien n'est « fait ».
				settle(decision.action ? "done" : "answered", said || "C'est fait.");
			} catch (error) {
				settle("error", error instanceof Error ? error.message : String(error).replace(/^(Ipc)?Error:\s*/, ""));
			}
			// L'écran qu'on vient d'ouvrir prend volontiers le focus (le champ d'un
			// agent) : la phrase suivante partait chez lui.
			requestAnimationFrame(() => field.current?.focus());
		},
		[context, perform, settle],
	);

	// L'oreille, côté Rust : le raccourci maintenu ouvre et referme le micro.
	useEffect(() => {
		if (!hasTauri()) return;
		const off = events.onAssistantVoice((event) => {
			if (hide.current) window.clearTimeout(hide.current);
			if (event.state === "listening") {
				setHeard("");
				setReply("");
				setPhase("listening");
			} else if (event.state === "transcribing") setPhase("transcribing");
			else if (event.state === "heard") void handle(event.text);
			else if (event.state === "idle") setPhase("idle");
			else settle("error", event.text);
		});
		return () => {
			void off.then((unsubscribe) => unsubscribe());
		};
	}, [handle, settle]);

	// ⌘J : la même chose au clavier.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey && event.key.toLowerCase() === "j") {
				event.preventDefault();
				setTyping((value) => !value);
			} else if (event.key === "Escape" && typing) setTyping(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [typing]);

	const visible = typing || phase !== "idle";

	return (
		<AnimatePresence>
			{visible ? (
				<motion.div
					initial={{ opacity: 0, y: -16, scale: 0.97 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={{ opacity: 0, y: -12, scale: 0.97 }}
					transition={{ type: "spring", stiffness: 420, damping: 34 }}
					// En haut, comme Spotlight : en bas, il recouvrait le champ où l'on
					// répond à un agent.
					className="fixed top-14 left-1/2 z-[60] w-[min(560px,calc(100%-32px))] -translate-x-1/2"
				>
					<div
						className={clsx(
							"flex flex-col gap-2 rounded-2xl bg-surface px-4 py-3 shadow-pop ring-1",
							phase === "error" ? "ring-critical/40" : phase === "listening" ? "ring-accent" : "ring-line-soft",
						)}
					>
						<div className="flex items-center gap-2.5">
							<span
								className={clsx(
									"grid size-8 shrink-0 place-items-center rounded-full",
									phase === "listening" ? "bg-accent text-accent-ink" : "bg-accent-dim text-accent",
								)}
							>
								{phase === "listening" ? (
									<Mic size={15} className="animate-pulse" />
								) : phase === "transcribing" ? (
									<AudioLines size={15} />
								) : phase === "thinking" ? (
									<Loader2 size={15} className="animate-spin" />
								) : (
									<Sparkles size={15} />
								)}
							</span>
							<div className="min-w-0 flex-1">
								<div className="text-[12.5px] font-semibold text-ink">
									{phase === "listening"
										? `J'écoute… relâche ${talk} quand tu as fini`
										: phase === "transcribing"
											? "Je transcris…"
											: phase === "thinking"
												? "Je réfléchis…"
												: phase === "error"
													? "Je n'ai pas pu"
													: phase === "done"
														? "C'est fait"
														: phase === "answered"
															? "Cockpit te répond"
															: "Demande à Cockpit"}
								</div>
								{heard ? <div className="truncate text-[11.5px] text-ink-muted">« {heard} »</div> : null}
							</div>
							<button
								type="button"
								onClick={() => {
									setTyping(false);
									setPhase("idle");
								}}
								className="grid size-6 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
								aria-label="Fermer"
							>
								<X size={13} />
							</button>
						</div>

						{reply ? (
							<p className={clsx("text-[12.5px] leading-relaxed", phase === "error" ? "text-critical" : "text-ink")}>
								{reply}
							</p>
						) : null}

						{typing ? (
							<form
								onSubmit={(event) => {
									event.preventDefault();
									const text = draft;
									setDraft("");
									void handle(text);
								}}
								className="flex items-center gap-2 rounded-xl border border-line-soft bg-base px-3 py-1.5"
							>
								<input
									// biome-ignore lint/a11y/noAutofocus: on l'ouvre pour taper
									autoFocus
									ref={field}
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									placeholder="Ouvre le workspace du panier, crée une mission depuis NW-3050…"
									className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
								/>
								<CornerDownLeft size={12} className="shrink-0 text-ink-faint" />
							</form>
						) : phase === "idle" ? null : (
							<p className="text-[10.5px] text-ink-faint">{talk} maintenu pour parler · ⌘J pour écrire</p>
						)}
					</div>
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}

/**
 * La rubrique de l'assistant dans les Réglages : comment lui parler, ce qu'il
 * lui faut, et de quoi vérifier que le micro l'entend — quand ⌥ Espace ne
 * répond pas, c'est la première chose à savoir.
 */
export function AssistantSettings() {
	const shortcut = useShortcut();
	const [hasKey, setHasKey] = useState<boolean | null>(null);
	const [test, setTest] = useState<{ state: "idle" | "listening" | "transcribing" | "done" | "error"; text: string }>({
		state: "idle",
		text: "",
	});
	const native = hasTauri();

	useEffect(() => {
		if (native) void api.speech.hasKey().then(setHasKey);
	}, [native]);

	const tryMic = async () => {
		setTest({ state: "listening", text: "" });
		try {
			await api.assistant.listen();
			await new Promise((resolve) => setTimeout(resolve, 4000));
			setTest({ state: "transcribing", text: "" });
			const text = await api.assistant.heard();
			setTest({ state: "done", text: text || "(rien entendu — parle plus près du micro)" });
		} catch (error) {
			setTest({ state: "error", text: String(error).replace(/^(Ipc)?Error:\s*/, "") });
		}
	};

	const row = "flex items-start gap-3 text-[12px] leading-relaxed text-ink-muted";
	const key = "shrink-0 rounded-md border border-line-soft bg-base px-1.5 py-0.5 font-mono text-[11px] text-ink";

	return (
		<div className="flex max-w-xl flex-col gap-3">
			<div className={row}>
				<span className={key}>{shortcutLabel(shortcut?.accelerator ?? "alt+Space")}</span>
				<span>
					Maintiens, parle, relâche : l'assistant comprend, agit et te répond à voix haute — même quand le
					cockpit est derrière une autre fenêtre.
				</span>
			</div>
			<ShortcutPicker status={shortcut} />
			<div className={row}>
				<span className={key}>⌘J</span>
				<span>La même chose au clavier, cockpit au premier plan.</span>
			</div>
			<p className="text-[11.5px] leading-relaxed text-ink-faint">
				Ce que tu dis est transcrit par ElevenLabs (la clé de la voix, ci-dessus) puis compris par Claude, sur ton
				abonnement : quelques secondes de ton forfait ElevenLabs et un peu de ton quota Claude par demande. Les actions
				s'exécutent directement ; ce qu'il ne trouve pas, il ne le devine pas.
			</p>
			{native && hasKey === false ? (
				<p className="rounded-md bg-warning/10 px-2.5 py-1.5 text-[11.5px] text-warning">
					Sans clé ElevenLabs, l'assistant ne t'entend pas — ⌘J reste possible. Range-la dans la section Voix.
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<button
					type="button"
					disabled={!native || test.state === "listening" || test.state === "transcribing"}
					onClick={() => void tryMic()}
					className="flex items-center gap-1.5 rounded-lg border border-line-soft px-3 py-1.5 text-[12px] text-ink hover:bg-hover disabled:opacity-50"
				>
					<Mic size={12} className={test.state === "listening" ? "animate-pulse text-accent" : ""} />
					{test.state === "listening"
						? "Parle… (4 s)"
						: test.state === "transcribing"
							? "Je transcris…"
							: "Tester le micro"}
				</button>
				{!native ? <span className="text-[11px] text-ink-faint">Dans l'application seulement.</span> : null}
			</div>
			{test.state === "done" ? (
				<p className="text-[12px] text-ink">
					Entendu : <span className="text-ink-muted">« {test.text} »</span>
				</p>
			) : test.state === "error" ? (
				<p className="text-[11.5px] leading-relaxed text-critical">
					{test.text}
					<br />
					<span className="text-ink-faint">
						Si le micro est refusé : Réglages Système → Confidentialité et sécurité → Micro → Cockpit.
					</span>
				</p>
			) : null}
		</div>
	);
}

/** Les raccourcis qu'on propose d'office : peu pris ailleurs sur un Mac. */
const PRESETS = ["alt+Space", "control+alt+Space", "shift+alt+Space", "control+alt+KeyJ"];

/**
 * Où en est le raccourci, et de quoi en changer.
 *
 * Un raccourci déjà pris par une autre application ne se voyait nulle part :
 * on maintenait la touche, rien ne se passait. L'état est lu de Rust, qui
 * sait si l'enregistrement a pris ; un autre choix s'essaie à chaud, et si
 * lui aussi est pris, l'ancien est remis.
 */
function ShortcutPicker({ status }: { status: ShortcutStatus | null }) {
	const [recording, setRecording] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const choose = useCallback(async (accelerator: string) => {
		setError(null);
		try {
			await api.assistant.setShortcut(accelerator);
			window.dispatchEvent(new Event(SHORTCUT_EVENT));
		} catch (failure) {
			setError(String(failure).replace(/^(Ipc)?Error:\s*/, ""));
			window.dispatchEvent(new Event(SHORTCUT_EVENT));
		}
	}, []);

	// La prochaine combinaison tapée devient le raccourci.
	useEffect(() => {
		if (!recording) return;
		const onKey = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") {
				setRecording(false);
				return;
			}
			const accelerator = acceleratorOf(event);
			if (!accelerator) return;
			setRecording(false);
			void choose(accelerator);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [recording, choose]);

	return (
		<div className="flex flex-col gap-2 rounded-xl border border-line-soft p-3">
			<div className="flex items-center gap-2 text-[12px]">
				<span
					className={clsx("size-2 shrink-0 rounded-full", status?.registered ? "bg-success" : "bg-warning")}
				/>
				{status?.registered ? (
					<span className="text-ink">
						{shortcutLabel(status.accelerator)} est actif, dans toutes les applications.
					</span>
				) : (
					<span className="text-warning">
						{shortcutLabel(status?.accelerator ?? "alt+Space")} n'a pas pu s'enregistrer
						{status?.error ? ` : ${status.error}` : "."} Choisis-en un autre.
					</span>
				)}
			</div>
			<div className="flex flex-wrap gap-1.5">
				{PRESETS.map((accelerator) => (
					<button
						key={accelerator}
						type="button"
						onClick={() => void choose(accelerator)}
						className={clsx(
							"rounded-md border px-2 py-1 font-mono text-[11px]",
							status?.accelerator === accelerator && status.registered
								? "border-accent bg-accent-dim text-accent"
								: "border-line-soft text-ink-muted hover:bg-hover hover:text-ink",
						)}
					>
						{shortcutLabel(accelerator)}
					</button>
				))}
				<button
					type="button"
					onClick={() => {
						setError(null);
						setRecording((value) => !value);
					}}
					className={clsx(
						"rounded-md border px-2 py-1 text-[11px]",
						recording ? "animate-pulse border-accent text-accent" : "border-line-soft text-ink-muted hover:bg-hover hover:text-ink",
					)}
				>
					{recording ? "Tape la combinaison… (Échap pour annuler)" : "Enregistrer un raccourci…"}
				</button>
			</div>
			{error ? <p className="text-[11px] text-critical">{error}</p> : null}
		</div>
	);
}
