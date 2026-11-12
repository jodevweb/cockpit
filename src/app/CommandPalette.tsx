import clsx from "clsx";
import {
	ArrowDownToLine,
	ArrowUpFromLine,
	Bot,
	Boxes,
	CornerDownLeft,
	FolderOpen,
	FolderPlus,
	FileText,
	GitBranch,
	GitPullRequest,
	LayoutGrid,
	Play,
	Terminal,
	Wand2,
	Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { KeyHint } from "@/components/ui";
import { recentFolders, rememberFolder } from "@/lib/recentFolders";
import { api } from "@/lib/ipc";
import { truncate } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";
import { useAgentActions } from "./agents";
import { libreFolders, openLauncher, tilde } from "@/lib/libre";
import { useTerminalActions } from "./terminals";
import { useAllSessions, useCockpit, type ViewId } from "./store";
import { basename, homeOf } from "@/lib/paths";
import { platformContext } from "@/lib/platform";

interface Action {
	id: string;
	label: string;
	hint: string;
	group: string;
	icon: React.ComponentType<{ size?: number; className?: string }>;
	run: () => void;
}

/**
 * Score de correspondance : sous-chaîne exacte d'abord, puis lettres dans
 * l'ordre. Suffisant et prévisible pour quelques centaines d'entrées — pas
 * besoin d'une lib de fuzzy search.
 */
function score(haystack: string, needle: string): number {
	if (!needle) return 1;
	const target = haystack.toLowerCase();
	const query = needle.toLowerCase();

	const direct = target.indexOf(query);
	if (direct === 0) return 1000;
	if (direct > 0) return 800 - direct;

	let cursor = 0;
	let hits = 0;
	for (const char of query) {
		const found = target.indexOf(char, cursor);
		if (found === -1) return 0;
		cursor = found + 1;
		hits += 1;
	}
	return 300 + hits - cursor / 10;
}

const VIEWS: ViewId[] = [
	"map",
	"today",
	"decisions",
	"recap",
	"agents",
	"workspace",
	"libres",
	"worktrees",
	"git",
	"scripts",
	"docs",
	"infra",
	"settings",
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
	const {
		go,
		worktrees,
		config,
		runJob,
		notify,
		projectList,
		activeProject,
		switchProject,
	} = useCockpit();
	const { open: openAgent } = useAgentActions();
	const { open: openTerminal } = useTerminalActions();
	const sessions = useAllSessions();
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const { t } = useTranslation("app");

	const mainRepo = config?.mainRepo ?? "";
	const prompts = useAsync(() => api.prompts.list().catch(() => []), []);
	// Les PR servent à résoudre « 1789 » en une entrée ouvrable ; la liste est
	// déjà en mémoire courte côté Rust, la palette ne coûte donc rien.
	const pulls = useAsync(() => api.git.pullRequests().catch(() => []), []);
	const scripts = useAsync(
		() => (mainRepo ? api.scripts.list(mainRepo) : Promise.resolve([])),
		[mainRepo],
		{ enabled: Boolean(mainRepo) },
	);

	const actions = useMemo<Action[]>(() => {
		const list: Action[] = [];

		for (const view of VIEWS) {
			list.push({
				id: `view:${view}`,
				label: t(`commandPalette.views.${view}`),
				hint: t("commandPalette.hint.goTo"),
				group: t("commandPalette.group.navigation"),
				icon: LayoutGrid,
				run: () => go(view),
			});
		}

		// Un agent libre : le lanceur, puis un dossier déjà connu en une frappe.
		list.push({
			id: "libre:new",
			label: t("commandPalette.libre.launch"),
			hint: t("commandPalette.libre.launchHint"),
			group: t("commandPalette.group.libres"),
			icon: Zap,
			run: () => openLauncher(),
		});
		for (const entry of libreFolders()) {
			list.push({
				id: `libre:${entry.folder}`,
				label: t("commandPalette.libre.launchIn", {
					folder: tilde(entry.folder, homeOf(entry.folder)),
				}),
				hint: t("commandPalette.libre.launchInHint"),
				group: t("commandPalette.group.libres"),
				icon: Zap,
				run: () => openLauncher(entry.folder),
			});
		}

		// Changer de projet est l'action la plus structurante : elle change ce que
		// tous les autres écrans montrent.
		for (const project of projectList) {
			if (project.id === activeProject?.id) continue;
			list.push({
				id: `project:${project.id}`,
				label: t("commandPalette.project.label", { name: project.name }),
				hint: project.githubRepo || project.mainRepo,
				group: t("commandPalette.group.projects"),
				icon: Boxes,
				run: () => switchProject(project.id),
			});
		}

		for (const tree of worktrees) {
			const name = tree.branch ?? tree.folderName;
			// Le quotidien git, sans passer par l'écran Git : c'est ce qu'on fait
			// vingt fois par jour, ça doit tenir en une frappe.
			list.push({
				id: `wt-pull:${tree.path}`,
				label: `Pull ${name}`,
				hint:
					tree.status.behind > 0
						? t("commandPalette.git.behind", { count: tree.status.behind })
						: t("commandPalette.git.upToDate"),
				group: "Git",
				icon: ArrowDownToLine,
				run: () => {
					void api.git
						.pull(tree.path)
						.then(() => notify(t("commandPalette.git.pulled", { name })))
						.catch((error) => notify(String(error)));
				},
			});
			if (tree.status.ahead > 0) {
				list.push({
					id: `wt-push:${tree.path}`,
					label: `Push ${name}`,
					hint: t("commandPalette.git.ahead", { count: tree.status.ahead }),
					group: "Git",
					icon: ArrowUpFromLine,
					run: () => {
						void api.git
							.push(tree.path)
							.then(() => notify(t("commandPalette.git.pushed", { name })))
							.catch((error) => notify(String(error)));
					},
				});
			}
			list.push({
				id: `wt:${tree.path}`,
				label: name,
				hint: tree.folderName,
				group: "Worktrees",
				icon: GitBranch,
				run: () => go("worktrees", { worktreePath: tree.path }),
			});
			list.push({
				id: `wt-editor:${tree.path}`,
				label: t("commandPalette.worktree.openEditor", { name }),
				hint: tree.path,
				group: "Worktrees",
				icon: FolderOpen,
				run: () => {
					void api.system.openEditor(tree.path).catch((error) => notify(String(error)));
				},
			});
			list.push({
				id: `wt-agent:${tree.path}`,
				label: t("commandPalette.worktree.launchAgent", { name }),
				hint: t("commandPalette.worktree.launchAgentHint"),
				group: "Worktrees",
				icon: Bot,
				run: () => openAgent(tree.path),
			});
			list.push({
				id: `wt-term:${tree.path}`,
				label: t("commandPalette.worktree.terminal", { name }),
				hint: t("commandPalette.worktree.terminalHint"),
				group: "Worktrees",
				icon: Terminal,
				run: () => openTerminal(tree.path),
			});
			list.push({
				id: `wt-term-app:${tree.path}`,
				label: t("commandPalette.worktree.terminalApp", { context: platformContext, name }),
				hint: tree.path,
				group: "Worktrees",
				icon: Terminal,
				run: () => {
					void api.system.openTerminal(tree.path).catch((error) => notify(String(error)));
				},
			});
		}

		for (const session of sessions.slice(0, 60)) {
			list.push({
				id: `session:${session.id}`,
				label: truncate(session.title, 70),
				hint: session.gitBranch ?? session.cwd,
				group: "Sessions",
				icon: Bot,
				run: () => go("agents", { sessionFile: session.file }),
			});
		}

		for (const script of scripts.data ?? []) {
			list.push({
				id: `script:${script.name}`,
				label: `pnpm ${script.name}`,
				hint: truncate(script.command, 60),
				group: "Scripts",
				icon: Play,
				run: () => {
					void runJob(`pnpm ${script.name}`, `pnpm ${script.name}`, mainRepo);
					go("scripts");
				},
			});
		}

		// Les prompts de la bibliothèque, lançables sans passer par un écran.
		for (const prompt of prompts.data ?? []) {
			list.push({
				id: `prompt:${prompt.id}`,
				label: prompt.label,
				hint: `agent · ${prompt.group}`,
				group: "Agents",
				icon: Wand2,
				// Le dépôt principal par défaut : la palette ne demande pas de
				// worktree, et c'est le point de départ le plus courant.
				run: () => openAgent(mainRepo, prompt.text),
			});
		}

		// Un agent dans un dossier, sans branche ni worktree : le plus court
		// chemin vers « fais ça, là ».
		list.push({
			id: "action:agent-folder",
			label: t("commandPalette.folder.newAgent"),
			hint: t("commandPalette.folder.newAgentHint"),
			group: "Actions",
			icon: FolderPlus,
			run: () => {
				void open({ directory: true, multiple: false, title: t("commandPalette.folder.dialogTitle") })
					.then((chosen) => {
						if (typeof chosen !== "string") return;
						openAgent(chosen, "", undefined, undefined, true);
						rememberFolder(chosen);
						go("workspace");
					})
					.catch((error) => notify(String(error)));
			},
		});
		for (const path of recentFolders().slice(0, 8)) {
			list.push({
				id: `folder:${path}`,
				label: t("commandPalette.folder.newAgentIn", {
					folder: basename(path),
				}),
				hint: path,
				group: t("commandPalette.group.recentFolders"),
				icon: FolderPlus,
				run: () => {
					openAgent(path, "", undefined, undefined, true);
					rememberFolder(path);
					go("workspace");
				},
			});
		}

		list.push({
			id: "action:config",
			label: t("commandPalette.openConfig"),
			hint: config?.configPath ?? "",
			group: "Actions",
			icon: FileText,
			run: () => {
				if (config?.configPath) {
					void api.system.reveal(config.configPath).catch((error) => notify(String(error)));
				}
			},
		});

		return list;
	}, [
		go,
		worktrees,
		sessions,
		scripts.data,
		mainRepo,
		runJob,
		config,
		notify,
		openAgent,
		openTerminal,
		prompts.data,
		projectList,
		activeProject,
		switchProject,
		t,
	]);

	// Un identifiant tapé tel quel doit mener à la chose, pas à une liste :
	// « 1789 » ouvre la PR, « ABC-2691 » ouvre le ticket.
	const identifiers = useMemo<Action[]>(() => {
		const trimmed = query.trim();
		const list: Action[] = [];

		const prNumber = trimmed.match(/^#?(\d{2,6})$/)?.[1];
		if (prNumber) {
			const number = Number(prNumber);
			const known = (pulls.data ?? []).find((pr) => pr.number === number);
			list.push({
				id: `pr:${number}`,
				label: known ? `#${number} ${known.title}` : t("commandPalette.identifiers.openPr", { number }),
				hint: known
					? [
							`${known.headRef} → ${known.baseRef} · ${known.author}`,
							known.labels.map((label) => label.name).join(", "),
						]
							.filter(Boolean)
							.join(" · ")
					: t("commandPalette.identifiers.onGithub"),
				group: t("commandPalette.group.identifiers"),
				icon: GitPullRequest,
				run: () => {
					const url =
						known?.url ??
						(config?.githubRepo
							? `https://github.com/${config.githubRepo}/pull/${number}`
							: "");
					if (url) void api.system.openUrl(url).catch((error) => notify(String(error)));
				},
			});
		}

		const ticket = trimmed.toUpperCase().match(/^([A-Z]{2,5}-\d+)$/)?.[1];
		if (ticket) {
			list.push({
				id: `ticket:${ticket}`,
				label: t("commandPalette.identifiers.openTicket", { ticket }),
				hint: t("commandPalette.identifiers.linearTicket"),
				group: t("commandPalette.group.identifiers"),
				icon: FileText,
				// On demande son URL à Linear plutôt que de la deviner : le nom du
				// workspace n'apparaît nulle part dans la configuration.
				run: () => {
					void api.feeds
						.linearIssue(ticket)
						.then((issue) => api.system.openUrl(issue.url))
						.catch((error) => notify(String(error)));
				},
			});
		}

		return list;
	}, [query, pulls.data, config, notify, t]);

	const results = useMemo(() => {
		// Les identifiants passent devant : si on tape un numéro, c'est lui qu'on
		// cherche, pas une correspondance floue dans un titre.
		return [
			...identifiers,
			...actions
				.map((action) => ({
					action,
					value: Math.max(
						score(action.label, query),
						score(action.hint, query) * 0.6,
						score(action.group, query) * 0.4,
					),
				}))
				.filter((entry) => entry.value > 0)
				.sort((a, b) => b.value - a.value)
				.slice(0, 40)
				.map((entry) => entry.action),
		];
	}, [actions, query, identifiers]);

	useEffect(() => setCursor(0), [query]);

	useEffect(() => {
		const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
		node?.scrollIntoView({ block: "nearest" });
	}, [cursor]);

	const commit = (action: Action | undefined) => {
		if (!action) return;
		action.run();
		onClose();
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center bg-overlay/60 pt-[12vh] backdrop-blur-[2px]"
			onClick={onClose}
		>
			<div
				className="animate-in panel flex max-h-[62vh] w-[560px] flex-col overflow-hidden shadow-2xl shadow-black/50"
				onClick={(event) => event.stopPropagation()}
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: c'est le seul but de la palette
					autoFocus
					value={query}
					spellCheck={false}
					placeholder={t("commandPalette.placeholder")}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setCursor((current) => Math.min(current + 1, results.length - 1));
						} else if (event.key === "ArrowUp") {
							event.preventDefault();
							setCursor((current) => Math.max(current - 1, 0));
						} else if (event.key === "Enter") {
							event.preventDefault();
							commit(results[cursor]);
						} else if (event.key === "Escape") {
							onClose();
						}
					}}
					className="hairline-b h-12 shrink-0 bg-transparent px-4 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
				/>

				<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
					{results.length === 0 ? (
						<p className="px-3 py-8 text-center text-xs text-ink-faint">{t("commandPalette.noResults")}</p>
					) : (
						results.map((action, index) => (
							<button
								key={action.id}
								type="button"
								data-index={index}
								onMouseEnter={() => setCursor(index)}
								onClick={() => commit(action)}
								className={clsx(
									"flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-100",
									index === cursor ? "bg-hover" : "hover:bg-surface",
								)}
							>
								<action.icon
									size={13}
									className={index === cursor ? "text-accent-soft" : "text-ink-faint"}
								/>
								<span className="min-w-0 flex-1 truncate text-xs text-ink">
									{action.label}
								</span>
								<span className="max-w-[42%] shrink-0 truncate font-mono text-[10px] text-ink-faint">
									{action.hint}
								</span>
							</button>
						))
					)}
				</div>

				<div className="hairline-b flex h-8 shrink-0 items-center gap-3 px-3 text-[10px] text-ink-faint">
					<span className="flex items-center gap-1">
						<KeyHint>↑</KeyHint>
						<KeyHint>↓</KeyHint> {t("commandPalette.keys.navigate")}
					</span>
					<span className="flex items-center gap-1">
						<KeyHint>
							<CornerDownLeft size={9} />
						</KeyHint>
						{t("commandPalette.keys.run")}
					</span>
					<span className="flex items-center gap-1">
						<KeyHint>esc</KeyHint> {t("commandPalette.keys.close")}
					</span>
				</div>
			</div>
		</div>
	);
}
