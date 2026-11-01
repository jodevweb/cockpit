import clsx from "clsx";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import {
	AlertTriangle,
	Check,
	Folder,
	FolderOpen,
	GitBranch,
	GitFork,
	ShieldAlert,
	SquareTerminal,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MODELS, modelChoices, PERMISSION_MODES, useAgentRuns } from "@/app/agents";
import { useCockpit } from "@/app/store";
import { api } from "@/lib/ipc";
import {
	addLibre,
	closeLauncher,
	defaultBranch,
	equivalentCommand,
	lastChoices,
	libreFolders,
	rememberChoices,
	selectLibre,
	tilde,
	type LibreChoices,
	type LibrePlace,
} from "@/lib/libre";
import { hasTauri } from "@/lib/preview";
import { recentFolders, rememberFolder } from "@/lib/recentFolders";
import { useAsync } from "@/lib/useAsync";
import { Modal, Spinner } from "./ui";

/**
 * Le lanceur d'un agent libre.
 *
 * Il remplace deux lignes de terminal — `cd`, puis `claude` — et ne doit
 * jamais être plus lent qu'elles : tout y est rempli d'avance, par ce qu'on
 * avait choisi la dernière fois dans ce dossier, à défaut par les réglages.
 * Choisir le dossier puis ⌘↵ suffit ; les étapes suivantes ne servent qu'à
 * changer quelque chose, jamais de passage obligé.
 *
 * En pied, la ligne de commande équivalente suit chaque choix : ce que Cockpit
 * lance, on aurait pu le taper soi-même.
 */

type Step = 1 | 2 | 3 | 4;

const PLACES: Array<{ id: LibrePlace; label: string; hint: string; icon: typeof Folder }> = [
	{
		id: "ici",
		label: "Sur place, tel quel",
		hint: "Exactement ton terminal : la branche courante, tes modifications en cours. Rien n'est créé.",
		icon: SquareTerminal,
	},
	{
		id: "branche",
		label: "Nouvelle branche",
		hint: "Même dossier, mais l'agent part sur sa branche. Ton travail en cours le suit.",
		icon: GitBranch,
	},
	{
		id: "worktree",
		label: "Worktree isolé",
		hint: "Une copie à part, à côté du dépôt, sur une branche neuve. Ton dossier n'est pas touché.",
		icon: GitFork,
	},
];

const DEPTHS = [
	{ id: "", label: "Celle du moteur" },
	{ id: "fast", label: "Rapide" },
	{ id: "normal", label: "Normale" },
	{ id: "deep", label: "Profonde" },
];

/** Le dossier personnel, deviné d'un chemin absolu : de quoi écrire `~` comme un terminal. */
function homeOf(path: string): string {
	return /^\/Users\/[^/]+/.exec(path)?.[0] ?? "";
}

function basename(path: string): string {
	return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Même règle que `libre.rs` : `<dépôt>-<fin de la branche>`, à côté du dépôt. */
function worktreeFor(root: string, branch: string): string {
	const tail = (branch.split("/").pop() ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "agent";
	const parent = root.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
	return `${parent}/${basename(root)}-${tail}`;
}

/**
 * Lancer un agent libre : sortir sa branche ou son worktree, ouvrir la
 * conversation, l'inscrire au registre, l'afficher.
 *
 * Partagé par le lanceur et par « Relancer comme la dernière fois », qui saute
 * le lanceur : les deux doivent faire exactement la même chose.
 */
export function useLibreLaunch() {
	const { go, notify } = useCockpit();
	const { open } = useAgentRuns();
	return useCallback(
		async (request: {
			folder: string;
			root: string;
			place: LibrePlace;
			branch: string;
			prompt: string;
			choices: LibreChoices;
			remember: boolean;
		}): Promise<boolean> => {
			try {
				const prepared = await api.libre.prepare(request.folder, request.place, request.branch);
				const firstLine = request.prompt.split("\n").find((line) => line.trim())?.trim() ?? "";
				const label = firstLine
					? firstLine.slice(0, 60)
					: request.place === "ici"
						? basename(request.folder)
						: `${basename(request.root || request.folder)} · ${prepared.branch}`;
				const { mode, model, account, depth } = request.choices;
				const runId = open(prepared.cwd, request.prompt.trim(), undefined, undefined, true, {
					label,
					libre: { mode, model, account, depth },
				});
				const created = addLibre({
					runId: runId ?? null,
					sessionId: null,
					claudeSessionId: null,
					folder: request.folder,
					cwd: prepared.cwd,
					place: request.place,
					branch: prepared.branch,
					worktree: prepared.worktree,
					model,
					account,
					mode,
					depth,
					label,
				});
				if (request.remember) rememberChoices(request.folder, { ...request.choices, place: request.place });
				rememberFolder(request.folder);
				selectLibre(created.id);
				go("libres");
				return true;
			} catch (error) {
				notify(`L'agent n'a pas pu partir : ${String(error)}`);
				return false;
			}
		},
		[go, notify, open],
	);
}

export function LibreLauncher({ initialFolder }: { initialFolder: string }) {
	const { config, projectList, go } = useCockpit();
	const { runs } = useAgentRuns();
	const engine = config?.engines?.[0];

	// ── Le dossier ──────────────────────────────────────────────────────
	const suggestions = useMemo(() => {
		const seen = new Set<string>();
		const list: Array<{ path: string; note: string }> = [];
		const push = (path: string, note: string) => {
			const clean = path.replace(/\/+$/, "");
			if (!clean || seen.has(clean)) return;
			seen.add(clean);
			list.push({ path: clean, note });
		};
		for (const entry of libreFolders()) push(entry.folder, "agent libre");
		for (const path of recentFolders()) push(path, "agent récent");
		return list.slice(0, 6);
	}, []);
	const [query, setQuery] = useState(initialFolder || suggestions[0]?.path || config?.mainRepo || "");
	const [folder, setFolder] = useState(query);
	useEffect(() => {
		const timer = setTimeout(() => setFolder(query.trim()), 250);
		return () => clearTimeout(timer);
	}, [query]);
	const inspection = useAsync(
		() => (folder ? api.libre.inspect(folder) : Promise.resolve(null)),
		[folder],
		{ resetOnChange: true },
	);
	const seen = inspection.data;
	const path = seen?.path ?? folder;
	const home = homeOf(path) || homeOf(config?.mainRepo ?? "");
	const show = (value: string) => tilde(value, home);

	// ── Les choix, pré-remplis ──────────────────────────────────────────
	// Le projet qui contient ce dossier dit sous quel compte il travaille ; un
	// dossier hors projet prend celui du poste, comme `claude` tout court.
	const projectAccount = useMemo(() => {
		const owner = projectList.find(
			(project) => project.mainRepo && (path === project.mainRepo || path.startsWith(`${project.mainRepo}/`)),
		);
		return owner?.account || "poste";
	}, [projectList, path]);
	const defaults = useCallback(
		(target: string): LibreChoices =>
			lastChoices(target) ?? {
				place: "ici",
				model: "",
				account: projectAccount,
				mode: "acceptEdits",
				depth: "",
			},
		[projectAccount],
	);
	const [choices, setChoices] = useState<LibreChoices>(() => defaults(folder));
	// Changer de dossier reprend ce qu'on y avait choisi la dernière fois.
	useEffect(() => setChoices(defaults(path)), [path, defaults]);
	const set = <K extends keyof LibreChoices>(key: K, value: LibreChoices[K]) =>
		setChoices((current) => ({ ...current, [key]: value }));

	const [step, setStep] = useState<Step>(1);
	const [prompt, setPrompt] = useState("");
	const [remember, setRemember] = useState(true);
	const [branchEdit, setBranchEdit] = useState<string | null>(null);
	const branch = branchEdit ?? defaultBranch(prompt);
	const [launching, setLaunching] = useState(false);

	const isGit = seen?.isGit ?? false;
	const place: LibrePlace = isGit ? choices.place : "ici";
	const worktree = isGit ? worktreeFor(seen?.root ?? path, branch) : "";
	const accounts = config?.accounts?.length ? config.accounts : [{ id: "poste", label: "Compte du poste", dir: "" }];
	const account = accounts.find((entry) => entry.id === choices.account) ?? accounts[0];
	const statuses = useAsync(() => api.accounts.status(), []);
	const models = modelChoices(engine?.models ?? []);
	const depthSupported = (id: string) =>
		id === "" ||
		Boolean(
			(id === "fast" && engine?.depthFast?.trim()) ||
				(id === "normal" && engine?.depthNormal?.trim()) ||
				(id === "deep" && engine?.depthDeep?.trim()),
		);
	const busy = runs.some((run) => run.running && run.cwd === path);

	const command = equivalentCommand({
		folder: show(path),
		place,
		branch,
		worktree: show(worktree),
		model: choices.model,
		mode: choices.mode,
		accountDir: account?.dir ?? "",
	});

	const modelName = MODELS.find((entry) => entry.id === choices.model)?.label ?? choices.model;
	const modeEntry = PERMISSION_MODES.find((entry) => entry.id === choices.mode);
	const where =
		place === "ici"
			? `${show(path)}, tel quel`
			: place === "branche"
				? `${show(path)}, sur une nouvelle branche ${branch}`
				: `une copie isolée de ${basename(seen?.root || path)}, sur ${branch}`;
	const summary = `${engine?.label ?? "Claude Code"} (${choices.model ? modelName : "modèle du poste"}) s'ouvre dans ${where}, sous le compte ${account?.label ?? "du poste"}, en mode ${modeEntry?.label ?? choices.mode} — ${modeEntry?.hint ?? ""}.`;

	const ready = Boolean(seen?.exists) && !launching;

	const start = useLibreLaunch();
	const launch = useCallback(async () => {
		if (!seen?.exists || launching) return;
		setLaunching(true);
		const ok = await start({
			folder: seen.path,
			root: seen.root,
			place,
			branch,
			prompt,
			choices,
			remember,
		});
		if (ok) closeLauncher();
		else setLaunching(false);
	}, [seen, launching, place, branch, prompt, choices, remember, start]);

	// ⌘↵ lance d'où que l'on soit dans le lanceur.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey && event.key === "Enter") {
				event.preventDefault();
				void launch();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [launch]);

	const browse = async () => {
		if (!hasTauri()) return;
		const chosen = await pickFolder({
			directory: true,
			multiple: false,
			title: "Lancer un agent dans ce dossier",
			defaultPath: path || config?.projectsRoot || undefined,
		});
		if (typeof chosen === "string") {
			setQuery(chosen);
			setFolder(chosen);
		}
	};

	const modelShort = choices.model ? modelName : "modèle du poste";
	const steps: Array<{ n: Step; label: string; value: string }> = [
		{ n: 1, label: "Dossier", value: seen?.exists ? show(path) : "à choisir" },
		{ n: 2, label: "Où travailler", value: PLACES.find((entry) => entry.id === place)?.label ?? "" },
		{ n: 3, label: "Agent", value: `${modelShort} · ${account?.label ?? ""} · ${modeEntry?.label ?? ""}` },
		{ n: 4, label: "Lancer", value: remember ? "retenu pour ce dossier" : "pour cette fois" },
	];

	return (
		<Modal onClose={closeLauncher} align="center">
			<div
				role="dialog"
				aria-label="Lancer un agent"
				className="animate-in flex h-[640px] max-h-[calc(100vh-5rem)] w-[900px] max-w-[calc(100vw-5rem)] flex-col overflow-hidden rounded-[18px] bg-surface shadow-[var(--shadow-pop)]"
			>
				<header className="hairline-b flex h-14 shrink-0 items-center gap-3 px-5">
					<span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent-dim text-accent">
						<Zap size={16} />
					</span>
					<div className="min-w-0 flex-1">
						<div className="text-[15px] font-semibold text-ink">Lancer un agent</div>
						<div className="text-[11.5px] text-ink-muted">Un dossier, un agent. Ni chantier ni mission.</div>
					</div>
					<button
						type="button"
						aria-label="Fermer"
						onClick={closeLauncher}
						className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-ink-muted hover:text-ink"
					>
						<X size={15} />
					</button>
				</header>

				<div className="flex min-h-0 flex-1">
					<nav aria-label="Étapes" className="hairline-r flex w-60 shrink-0 flex-col gap-1 bg-base p-3">
						{steps.map((entry) => (
							<button
								key={entry.n}
								type="button"
								onClick={() => setStep(entry.n)}
								className={clsx(
									"focus-ring flex items-center gap-3 rounded-[10px] p-2.5 text-left transition-colors duration-150",
									step === entry.n ? "bg-surface shadow-card" : "hover:bg-hover",
								)}
							>
								<span
									className={clsx(
										"flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold",
										step === entry.n ? "bg-accent text-accent-ink" : "bg-hover text-ink-muted",
									)}
								>
									{entry.n}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block text-[12.5px] font-semibold text-ink">{entry.label}</span>
									<span className="block truncate font-mono text-[11px] text-ink-muted">{entry.value}</span>
								</span>
							</button>
						))}
						<div className="flex-1" />
						<p className="rounded-[10px] bg-surface p-3 text-[11.5px] leading-snug text-ink-muted shadow-card">
							Tout est déjà rempli. Choisis un dossier, puis <span className="font-semibold text-ink">⌘↵</span> :
							l'agent part.
						</p>
					</nav>

					<div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
						{step === 1 ? (
							<>
								<h2 className="text-[17px] font-semibold text-ink">Dans quel dossier ?</h2>
								<p className="mt-1 text-[12.5px] text-ink-muted">
									C'est le <span className="font-mono">cd</span> : l'agent y travaillera comme si tu l'avais ouvert dans
									ton terminal.
								</p>
								<div className="mt-4 flex gap-2">
									<label
										className={clsx(
											"flex h-10 flex-1 items-center gap-2 rounded-[10px] border-[1.5px] px-3",
											seen && !seen.exists ? "border-critical/60" : "border-accent/60",
										)}
									>
										<span className="sr-only">Chemin du dossier</span>
										<Folder size={15} className="shrink-0 text-ink-muted" />
										<input
											autoFocus
											value={query}
											spellCheck={false}
											onChange={(event) => setQuery(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter" && !event.metaKey) {
													event.preventDefault();
													setFolder(query.trim());
													setStep(2);
												}
											}}
											placeholder="~/Sites/mon-projet"
											className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint"
										/>
										{inspection.loading ? <Spinner /> : null}
									</label>
									{hasTauri() ? (
										<button
											type="button"
											onClick={() => void browse()}
											className="focus-ring flex h-10 items-center gap-2 rounded-[10px] border border-line px-3.5 text-[12.5px] font-medium text-ink hover:bg-hover"
										>
											<FolderOpen size={15} />
											Choisir dans le Finder…
										</button>
									) : null}
								</div>
								<p className="mt-2 h-4 text-[11.5px] text-ink-muted">
									{seen
										? !seen.exists
											? "Ce dossier n'existe pas."
											: seen.isGit
												? `Dépôt git · ${seen.branch || "HEAD détachée"} · ${seen.dirty === 0 ? "propre" : `${seen.dirty} fichier${seen.dirty > 1 ? "s" : ""} modifié${seen.dirty > 1 ? "s" : ""}`}`
												: "Pas un dépôt git : l'agent y travaillera sur place."
										: ""}
								</p>

								{suggestions.length > 0 ? (
									<>
										<h3 className="mt-4 mb-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
											Récents
										</h3>
										<div className="flex flex-col gap-1">
											{suggestions.map((entry) => (
												<FolderRow
													key={entry.path}
													label={show(entry.path)}
													note={entry.note}
													selected={entry.path === path}
													onPick={() => {
														setQuery(entry.path);
														setFolder(entry.path);
													}}
												/>
											))}
										</div>
									</>
								) : null}

								{projectList.length > 0 ? (
									<>
										<h3 className="mt-4 mb-2 text-[10.5px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
											Projets déclarés dans les réglages
										</h3>
										<div className="flex flex-wrap gap-2">
											{projectList
												.filter((project) => project.mainRepo)
												.map((project) => (
													<button
														key={project.id}
														type="button"
														onClick={() => {
															setQuery(project.mainRepo);
															setFolder(project.mainRepo);
														}}
														className={clsx(
															"focus-ring flex h-8 items-center gap-2 rounded-lg border px-3 text-[12.5px] font-medium",
															path === project.mainRepo
																? "border-accent bg-accent-dim text-accent"
																: "border-line text-ink hover:bg-hover",
														)}
													>
														<span
															className="h-2 w-2 rounded-full"
															style={{ background: project.color || "var(--color-accent)" }}
														/>
														{project.name}
													</button>
												))}
										</div>
									</>
								) : null}
							</>
						) : null}

						{step === 2 ? (
							<>
								<h2 className="text-[17px] font-semibold text-ink">Où travaille-t-il ?</h2>
								<p className="mt-1 text-[12.5px] text-ink-muted">
									Dans <span className="font-mono text-ink">{show(path)}</span>
								</p>
								<div className="mt-4 grid grid-cols-3 gap-3">
									{PLACES.map((entry) => {
										const disabled = !isGit && entry.id !== "ici";
										const on = place === entry.id;
										return (
											<button
												key={entry.id}
												type="button"
												disabled={disabled}
												onClick={() => set("place", entry.id)}
												className={clsx(
													"focus-ring flex min-h-[150px] flex-col gap-2 rounded-xl border-[1.5px] p-4 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
													on ? "border-accent bg-accent-dim text-accent" : "border-line-soft hover:border-line",
												)}
											>
												<entry.icon size={19} />
												<span className={clsx("text-[13.5px] font-semibold", on ? "text-accent" : "text-ink")}>
													{entry.label}
												</span>
												<span className="text-[12px] leading-snug text-ink-muted">{entry.hint}</span>
											</button>
										);
									})}
								</div>

								{!isGit ? (
									<p className="mt-3 rounded-[10px] bg-raised px-3.5 py-3 text-[12.5px] text-ink-muted">
										Ce dossier n'est pas un dépôt git : l'agent y travaille sur place. Branche et worktree ne s'appliquent
										pas.
									</p>
								) : null}

								{busy && place === "ici" ? (
									<div className="mt-3 flex items-start gap-3 rounded-[10px] bg-warning/10 px-3.5 py-3 text-[12.5px] text-warning">
										<AlertTriangle size={17} className="mt-px shrink-0" />
										<span className="flex-1 leading-snug">
											Un agent travaille déjà dans ce dossier. Deux agents au même endroit écrivent dans les mêmes
											fichiers.
										</span>
										<button
											type="button"
											onClick={() => set("place", "worktree")}
											className="focus-ring h-7 shrink-0 rounded-lg bg-warning px-2.5 text-[11.5px] font-semibold text-accent-ink"
										>
											Prendre un worktree
										</button>
									</div>
								) : null}

								{place !== "ici" ? (
									<div className="mt-4 grid grid-cols-2 gap-3">
										<label className="flex flex-col gap-1.5">
											<span className="text-[11.5px] font-semibold text-ink-muted">Nom de la branche</span>
											<input
												value={branch}
												spellCheck={false}
												onChange={(event) => setBranchEdit(event.target.value)}
												className="focus-ring h-9 rounded-[10px] border border-line px-3 font-mono text-[12.5px] text-ink"
											/>
											<span className="text-[11px] text-ink-muted">
												{branchEdit === null ? "Tirée de ta première consigne, si tu en donnes une." : " "}
											</span>
										</label>
										<div className="flex flex-col gap-1.5">
											<span className="text-[11.5px] font-semibold text-ink-muted">À partir de</span>
											<span className="flex h-9 items-center rounded-[10px] bg-raised px-3 font-mono text-[12.5px] text-ink">
												{seen?.branch || "HEAD"}
											</span>
											{place === "worktree" ? (
												<span className="truncate text-[11px] text-ink-muted">
													Copie créée dans <span className="font-mono text-ink">{show(worktree)}</span>
												</span>
											) : null}
										</div>
									</div>
								) : null}

								<p className="mt-6 border-t border-line-soft pt-3.5 text-[12.5px] text-ink-muted">
									Tu veux le parcours complet — chantier, terminaux, navigateur, serveurs ?{" "}
									<button
										type="button"
										onClick={() => {
											closeLauncher();
											go("workspace");
										}}
										className="focus-ring font-medium text-accent hover:underline"
									>
										Ouvrir plutôt un workspace →
									</button>
								</p>
							</>
						) : null}

						{step === 3 ? (
							<>
								<h2 className="text-[17px] font-semibold text-ink">Quel agent ?</h2>
								<p className="mt-1 text-[12.5px] text-ink-muted">
									Moteur, modèles et comptes viennent des réglages. Rien ne se déclare ici.
								</p>
								<div className="mt-5 grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-4 gap-y-4">
									<span className="text-[12.5px] font-semibold text-ink-muted">Moteur</span>
									<span className="text-[12.5px] text-ink">
										<span className="font-semibold">{engine?.label ?? "Claude Code"}</span>
										<span className="text-ink-muted">
											{(config?.engines?.length ?? 1) > 1 ? " — le premier déclaré" : " — le seul moteur déclaré"}
										</span>
									</span>

									<span className="text-[12.5px] font-semibold text-ink-muted">Modèle</span>
									<div className="flex flex-wrap gap-2">
										{models.map((entry) => (
											<Chip
												key={entry.id || "poste"}
												on={choices.model === entry.id}
												title={entry.hint}
												onClick={() => set("model", entry.id)}
											>
												{entry.id ? entry.label : "Réglage du poste"}
											</Chip>
										))}
									</div>

									<span className="mt-3 self-start text-[12.5px] font-semibold text-ink-muted">Compte</span>
									<div className="grid grid-cols-2 gap-2">
										{accounts.map((entry) => {
											const status = statuses.data?.find((candidate) => candidate.id === entry.id);
											const on = choices.account === entry.id;
											return (
												<button
													key={entry.id}
													type="button"
													onClick={() => set("account", entry.id)}
													className={clsx(
														"focus-ring flex flex-col items-start gap-1 rounded-xl border-[1.5px] px-3.5 py-3 text-left",
														on ? "border-accent bg-accent-dim" : "border-line-soft hover:border-line",
													)}
												>
													<span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
														{entry.label}
														{status ? (
															<span
																className={clsx(
																	"rounded-md px-1.5 py-px text-[10.5px] font-semibold",
																	status.loggedIn ? "bg-success/10 text-success" : "bg-critical/10 text-critical",
																)}
															>
																{status.loggedIn ? "connecté" : "déconnecté"}
															</span>
														) : null}
													</span>
													<span className="font-mono text-[11.5px] text-ink-muted">{entry.dir || "~/.claude"}</span>
													<span className="text-[11px] text-ink-muted">
														{entry.id === projectAccount ? "celui du projet de ce dossier" : status?.email || " "}
													</span>
												</button>
											);
										})}
									</div>

									<span className="text-[12.5px] font-semibold text-ink-muted">Permissions</span>
									<div className="flex flex-wrap gap-2">
										{PERMISSION_MODES.map((entry) => (
											<Chip
												key={entry.id}
												on={choices.mode === entry.id}
												title={entry.hint}
												onClick={() => set("mode", entry.id)}
											>
												{entry.label}
											</Chip>
										))}
									</div>

									<span className="text-[12.5px] font-semibold text-ink-muted">Profondeur</span>
									<div className="flex flex-wrap gap-2">
										{DEPTHS.map((entry) => (
											<Chip
												key={entry.id || "moteur"}
												on={choices.depth === entry.id}
												disabled={!depthSupported(entry.id)}
												title={
													depthSupported(entry.id)
														? undefined
														: "Ce moteur ne dit pas comment l'obtenir — Réglages → Moteurs"
												}
												onClick={() => set("depth", entry.id)}
											>
												{entry.label}
											</Chip>
										))}
									</div>
								</div>

								{choices.mode === "bypassPermissions" && place === "ici" ? (
									<div className="mt-5 flex items-center gap-3 rounded-[10px] bg-critical/10 px-3.5 py-3 text-[12.5px] text-critical">
										<ShieldAlert size={17} className="shrink-0" />
										<span className="leading-snug">
											Bypass, sur place, sur ta branche courante : l'agent peut lancer n'importe quelle commande sans te
											demander. Un worktree limite la casse.
										</span>
									</div>
								) : null}
							</>
						) : null}

						{step === 4 ? (
							<>
								<h2 className="text-[17px] font-semibold text-ink">Prêt à partir</h2>
								<p className="mt-3.5 rounded-[14px] bg-raised px-5 py-4 text-[14.5px] leading-relaxed text-ink">
									{summary}
								</p>
								<label className="mt-5 flex flex-col gap-1.5">
									<span className="text-[11.5px] font-semibold text-ink-muted">
										Première consigne <span className="font-normal">— facultatif</span>
									</span>
									<textarea
										value={prompt}
										onChange={(event) => setPrompt(event.target.value)}
										placeholder="Vide : l'agent attend ta première phrase, comme « claude » tout court."
										className="focus-ring h-24 resize-none rounded-[10px] border border-line p-3 text-[13px] text-ink placeholder:text-ink-faint"
									/>
								</label>
								<button
									type="button"
									onClick={() => setRemember((value) => !value)}
									className="focus-ring mt-4 flex items-center gap-2.5 rounded text-left text-[12.5px] text-ink"
								>
									<span
										className={clsx(
											"flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px]",
											remember ? "bg-accent text-accent-ink" : "border-[1.5px] border-line",
										)}
									>
										{remember ? <Check size={12} strokeWidth={3} /> : null}
									</span>
									<span>
										Retenir ces choix pour <span className="font-mono">{show(path)}</span> — la prochaine fois, ⌘N puis ⌘↵
										suffit
									</span>
								</button>
							</>
						) : null}
					</div>
				</div>

				<footer className="flex shrink-0 border-t border-line-soft items-center gap-3 px-5 py-3.5">
					<div className="min-w-0 flex-1 rounded-[10px] bg-void px-3.5 py-2.5">
						<div className="mb-1 text-[9.5px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
							Ce que tu aurais tapé
						</div>
						{command.map((line) => (
							<div key={line} className="font-mono text-[11.5px] break-all text-ink">
								<span className="text-accent">❯ </span>
								{line}
							</div>
						))}
					</div>
					{step > 1 ? (
						<button
							type="button"
							onClick={() => setStep((step - 1) as Step)}
							className="focus-ring h-10 rounded-[10px] border border-line px-3.5 text-[12.5px] font-medium text-ink hover:bg-hover"
						>
							Retour
						</button>
					) : null}
					{step < 4 ? (
						<button
							type="button"
							onClick={() => setStep((step + 1) as Step)}
							className="focus-ring h-10 rounded-[10px] border border-line px-3.5 text-[12.5px] font-medium text-ink hover:bg-hover"
						>
							Régler la suite
						</button>
					) : null}
					<button
						type="button"
						disabled={!ready}
						onClick={() => void launch()}
						className="focus-ring flex h-10 items-center gap-2 rounded-[10px] bg-accent px-4 text-[13.5px] font-semibold text-accent-ink hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
					>
						{launching ? <Spinner /> : null}
						Lancer
						<span className="font-mono text-[11px] opacity-80">⌘↵</span>
					</button>
				</footer>
			</div>
		</Modal>
	);
}

function FolderRow({
	label,
	note,
	selected,
	onPick,
}: {
	label: string;
	note: string;
	selected: boolean;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onPick}
			className={clsx(
				"focus-ring flex w-full items-center gap-3 rounded-[10px] border-[1.5px] px-3 py-2 text-left",
				selected ? "border-accent bg-accent-dim" : "border-transparent hover:bg-hover",
			)}
		>
			<Folder size={16} className="shrink-0 text-ink-muted" />
			<span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{label}</span>
			<span className="shrink-0 text-[11.5px] text-ink-muted">{note}</span>
		</button>
	);
}

function Chip({
	on,
	disabled,
	title,
	onClick,
	children,
}: {
	on: boolean;
	disabled?: boolean;
	title?: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			title={title}
			onClick={onClick}
			className={clsx(
				"focus-ring h-8 rounded-[9px] border-[1.5px] px-3 text-[12.5px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
				on ? "border-accent bg-accent-dim text-accent" : "border-line-soft text-ink hover:border-line",
			)}
		>
			{children}
		</button>
	);
}
