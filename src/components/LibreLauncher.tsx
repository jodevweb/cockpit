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
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import { formatShortcut, modKey, platformContext } from "@/lib/platform";
import { basename, dirname, homeOf, toSlashes } from "@/lib/paths";
import type { AccountStatus, Engine, LibreInspection, ProjectView } from "@/lib/types";

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

const PLACE_ICONS: Array<{ id: LibrePlace; icon: typeof Folder }> = [
	{ id: "ici", icon: SquareTerminal },
	{ id: "branche", icon: GitBranch },
	{ id: "worktree", icon: GitFork },
];

const places = (t: TFunction): Array<{ id: LibrePlace; label: string; hint: string; icon: typeof Folder }> =>
	PLACE_ICONS.map(({ id, icon }) => ({
		id,
		icon,
		label: t(`libreLauncher.places.${id}.label`),
		hint: t(`libreLauncher.places.${id}.hint`),
	}));

const depths = (t: TFunction) => [
	{ id: "", label: t("libreLauncher.depths.engine") },
	{ id: "fast", label: t("libreLauncher.depths.fast") },
	{ id: "normal", label: t("libreLauncher.depths.normal") },
	{ id: "deep", label: t("libreLauncher.depths.deep") },
];

/** Même règle que `libre.rs` : `<dépôt>-<fin de la branche>`, à côté du dépôt. */
function worktreeFor(root: string, branch: string): string {
	const tail = (branch.split("/").pop() ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "agent";
	const parent = dirname(toSlashes(root).replace(/\/+$/, ""));
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
	const { t } = useTranslation("components1");
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
				notify(t("libreLauncher.launchFailed", { error: String(error) }));
				return false;
			}
		},
		[go, notify, open, t],
	);
}

export function LibreLauncher({ initialFolder }: { initialFolder: string }) {
	const { config, projectList, go } = useCockpit();
	const { runs } = useAgentRuns();
	const { t } = useTranslation("components1");
	const PLACES = places(t);
	const engine = config?.engines?.[0];

	// ── Le dossier ──────────────────────────────────────────────────────
	const { suggestions, query, setQuery, setFolder, folder, inspection, seen, path, show } = useLauncherFolder(
		initialFolder,
		config?.mainRepo,
		t,
	);

	// ── Les choix, pré-remplis ──────────────────────────────────────────
	const { projectAccount, choices, set } = useLauncherChoices(projectList, folder, path);

	const [step, setStep] = useState<Step>(1);
	const [prompt, setPrompt] = useState("");
	const [remember, setRemember] = useState(true);
	const [branchEdit, setBranchEdit] = useState<string | null>(null);
	const branch = branchEdit ?? defaultBranch(prompt);
	const [launching, setLaunching] = useState(false);

	const isGit = seen?.isGit ?? false;
	const place: LibrePlace = isGit ? choices.place : "ici";
	const worktree = isGit ? worktreeFor(seen?.root ?? path, branch) : "";
	const accounts = config?.accounts?.length ? config.accounts : [{ id: "poste", label: t("libreLauncher.machineAccount"), dir: "" }];
	const account = accounts.find((entry) => entry.id === choices.account) ?? accounts[0];
	const statuses = useAsync(() => api.accounts.status(), []);
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
			? t("libreLauncher.summary.whereHere", { folder: show(path) })
			: place === "branche"
				? t("libreLauncher.summary.whereBranch", { folder: show(path), branch })
				: t("libreLauncher.summary.whereWorktree", { repo: basename(seen?.root || path), branch });
	const summary = t("libreLauncher.summary.sentence", {
		engine: engine?.label ?? "Claude Code",
		model: choices.model ? modelName : t("libreLauncher.machineModel"),
		where,
		account: account?.label ?? t("libreLauncher.machineAccount"),
		mode: modeEntry?.label ?? choices.mode,
		hint: modeEntry?.hint ?? "",
	});

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
			if (modKey(event) && event.key === "Enter") {
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
			title: t("libreLauncher.browseTitle"),
			defaultPath: path || config?.projectsRoot || undefined,
		});
		if (typeof chosen === "string") {
			setQuery(chosen);
			setFolder(chosen);
		}
	};

	const modelShort = choices.model ? modelName : t("libreLauncher.machineModel");
	const steps: Array<{ n: Step; label: string; value: string }> = [
		{ n: 1, label: t("libreLauncher.steps.folder"), value: seen?.exists ? show(path) : t("libreLauncher.steps.toPick") },
		{ n: 2, label: t("libreLauncher.steps.place"), value: PLACES.find((entry) => entry.id === place)?.label ?? "" },
		{ n: 3, label: t("libreLauncher.steps.agent"), value: `${modelShort} · ${account?.label ?? ""} · ${modeEntry?.label ?? ""}` },
		{
			n: 4,
			label: t("libreLauncher.steps.launch"),
			value: remember ? t("libreLauncher.steps.remembered") : t("libreLauncher.steps.thisTime"),
		},
	];

	return (
		<Modal onClose={closeLauncher} align="center">
			<div
				role="dialog"
				aria-label={t("libreLauncher.title")}
				className="animate-in flex h-[640px] max-h-[calc(100vh-5rem)] w-[900px] max-w-[calc(100vw-5rem)] flex-col overflow-hidden rounded-[18px] bg-surface shadow-[var(--shadow-pop)]"
			>
				<LauncherHeader />

				<div className="flex min-h-0 flex-1">
					<StepNav steps={steps} step={step} onStep={setStep} />

					<div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
						{step === 1 ? (
							<FolderStep
								query={query}
								setQuery={setQuery}
								setFolder={setFolder}
								setStep={setStep}
								loading={inspection.loading}
								seen={seen}
								path={path}
								show={show}
								suggestions={suggestions}
								projectList={projectList}
								browse={browse}
							/>
						) : null}

						{step === 2 ? (
							<PlaceStep
								options={PLACES}
								place={place}
								isGit={isGit}
								busy={busy}
								path={path}
								show={show}
								branch={branch}
								branchEdit={branchEdit}
								setBranchEdit={setBranchEdit}
								from={seen?.branch || "HEAD"}
								worktree={worktree}
								set={set}
								go={go}
							/>
						) : null}

						{step === 3 ? (
							<AgentStep
								engine={engine}
								engineCount={config?.engines?.length}
								choices={choices}
								set={set}
								accounts={accounts}
								statuses={statuses.data}
								projectAccount={projectAccount}
								place={place}
							/>
						) : null}

						{step === 4 ? (
							<LaunchStep
								summary={summary}
								prompt={prompt}
								setPrompt={setPrompt}
								remember={remember}
								setRemember={setRemember}
								folder={show(path)}
							/>
						) : null}
					</div>
				</div>

				<LauncherFooter
					command={command}
					step={step}
					setStep={setStep}
					ready={ready}
					launching={launching}
					launch={launch}
				/>
			</div>
		</Modal>
	);
}

/**
 * Le dossier où l'agent travaillera : ce qu'on tape, attendu un quart de
 * seconde avant d'être inspecté, et les dossiers à suggérer.
 */
function useLauncherFolder(initialFolder: string, mainRepo: string | undefined, t: TFunction) {
	const suggestions = useMemo(() => {
		const seen = new Set<string>();
		const list: Array<{ path: string; note: string }> = [];
		const push = (path: string, note: string) => {
			const clean = path.replace(/\/+$/, "");
			if (!clean || seen.has(clean)) return;
			seen.add(clean);
			list.push({ path: clean, note });
		};
		for (const entry of libreFolders()) push(entry.folder, t("libreLauncher.folder.noteLibre"));
		for (const path of recentFolders()) push(path, t("libreLauncher.folder.noteRecent"));
		return list.slice(0, 6);
	}, [t]);
	const [query, setQuery] = useState(initialFolder || suggestions[0]?.path || mainRepo || "");
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
	const home = homeOf(path) || homeOf(mainRepo ?? "");
	const show = (value: string) => tilde(value, home);
	return { suggestions, query, setQuery, folder, setFolder, inspection, seen, path, show };
}

/** Les choix de l'agent, pré-remplis pour le dossier visé. */
function useLauncherChoices(projectList: ProjectView[], folder: string, path: string) {
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
	return { projectAccount, choices, set };
}

type SetChoice = ReturnType<typeof useLauncherChoices>["set"];
type PlaceOption = ReturnType<typeof places>[number];
type Show = (value: string) => string;

function LauncherHeader() {
	const { t } = useTranslation("components1");
	return (
		<header className="hairline-b flex h-14 shrink-0 items-center gap-3 px-5">
			<span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent-dim text-accent">
				<Zap size={16} />
			</span>
			<div className="min-w-0 flex-1">
				<div className="text-[15px] font-semibold text-ink">{t("libreLauncher.title")}</div>
				<div className="text-[11.5px] text-ink-muted">{t("libreLauncher.subtitle")}</div>
			</div>
			<button
				type="button"
				aria-label={t("libreLauncher.close")}
				onClick={closeLauncher}
				className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-ink-muted hover:text-ink"
			>
				<X size={15} />
			</button>
		</header>
	);
}

function StepNav({
	steps,
	step,
	onStep,
}: {
	steps: Array<{ n: Step; label: string; value: string }>;
	step: Step;
	onStep: (step: Step) => void;
}) {
	const { t } = useTranslation("components1");
	return (
		<nav aria-label={t("libreLauncher.steps.label")} className="hairline-r flex w-60 shrink-0 flex-col gap-1 bg-base p-3">
			{steps.map((entry) => (
				<button
					key={entry.n}
					type="button"
					onClick={() => onStep(entry.n)}
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
				<Trans
					t={t}
					i18nKey="libreLauncher.allSet"
					components={{ key: <span className="font-semibold text-ink" /> }}
				/>
			</p>
		</nav>
	);
}

/** Étape 1 : le dossier, tapé, suggéré ou choisi parmi les projets. */
function FolderStep({
	query,
	setQuery,
	setFolder,
	setStep,
	loading,
	seen,
	path,
	show,
	suggestions,
	projectList,
	browse,
}: {
	query: string;
	setQuery: (value: string) => void;
	setFolder: (value: string) => void;
	setStep: (step: Step) => void;
	loading: boolean;
	seen: LibreInspection | null | undefined;
	path: string;
	show: Show;
	suggestions: Array<{ path: string; note: string }>;
	projectList: ProjectView[];
	browse: () => Promise<void>;
}) {
	const { t } = useTranslation("components1");
	return (
		<>
			<h2 className="text-[17px] font-semibold text-ink">{t("libreLauncher.folder.title")}</h2>
			<p className="mt-1 text-[12.5px] text-ink-muted">
				<Trans
					t={t}
					i18nKey="libreLauncher.folder.description"
					components={{ code: <span className="font-mono" /> }}
				/>
			</p>
			<div className="mt-4 flex gap-2">
				<label
					className={clsx(
						"flex h-10 flex-1 items-center gap-2 rounded-[10px] border-[1.5px] px-3",
						seen && !seen.exists ? "border-critical/60" : "border-accent/60",
					)}
				>
					<span className="sr-only">{t("libreLauncher.folder.path")}</span>
					<Folder size={15} className="shrink-0 text-ink-muted" />
					<input
						autoFocus
						value={query}
						spellCheck={false}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !modKey(event)) {
								event.preventDefault();
								setFolder(query.trim());
								setStep(2);
							}
						}}
						placeholder={t("libreLauncher.folder.placeholder")}
						className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint"
					/>
					{loading ? <Spinner /> : null}
				</label>
				{hasTauri() ? (
					<button
						type="button"
						onClick={() => void browse()}
						className="focus-ring flex h-10 items-center gap-2 rounded-[10px] border border-line px-3.5 text-[12.5px] font-medium text-ink hover:bg-hover"
					>
						<FolderOpen size={15} />
						{t("libreLauncher.folder.browse", { context: platformContext })}
					</button>
				) : null}
			</div>
			<p className="mt-2 h-4 text-[11.5px] text-ink-muted">
				{seen
					? !seen.exists
						? t("libreLauncher.folder.missing")
						: seen.isGit
							? t("libreLauncher.folder.gitRepo", {
									branch: seen.branch || t("libreLauncher.folder.detached"),
									state:
										seen.dirty === 0
											? t("libreLauncher.folder.clean")
											: t("libreLauncher.folder.dirty", { count: seen.dirty }),
								})
							: t("libreLauncher.folder.notGit")
					: ""}
			</p>

			{suggestions.length > 0 ? (
				<>
					<h3 className="mt-4 mb-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
						{t("libreLauncher.folder.recent")}
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
						{t("libreLauncher.folder.projects")}
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
	);
}

/** Étape 2 : où l'agent travaille — ici, sur une branche, dans un worktree. */
function PlaceStep({
	options,
	place,
	isGit,
	busy,
	path,
	show,
	branch,
	branchEdit,
	setBranchEdit,
	from,
	worktree,
	set,
	go,
}: {
	options: PlaceOption[];
	place: LibrePlace;
	isGit: boolean;
	busy: boolean;
	path: string;
	show: Show;
	branch: string;
	branchEdit: string | null;
	setBranchEdit: (value: string) => void;
	from: string;
	worktree: string;
	set: SetChoice;
	go: ReturnType<typeof useCockpit>["go"];
}) {
	const { t } = useTranslation("components1");
	return (
		<>
			<h2 className="text-[17px] font-semibold text-ink">{t("libreLauncher.place.title")}</h2>
			<p className="mt-1 text-[12.5px] text-ink-muted">
				<Trans
					t={t}
					i18nKey="libreLauncher.place.in"
					values={{ folder: show(path) }}
					components={{ code: <span className="font-mono text-ink" /> }}
				/>
			</p>
			<div className="mt-4 grid grid-cols-3 gap-3">
				{options.map((entry) => {
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
					{t("libreLauncher.place.notGit")}
				</p>
			) : null}

			{busy && place === "ici" ? (
				<div className="mt-3 flex items-start gap-3 rounded-[10px] bg-warning/10 px-3.5 py-3 text-[12.5px] text-warning">
					<AlertTriangle size={17} className="mt-px shrink-0" />
					<span className="flex-1 leading-snug">
						{t("libreLauncher.place.busy")}
					</span>
					<button
						type="button"
						onClick={() => set("place", "worktree")}
						className="focus-ring h-7 shrink-0 rounded-lg bg-warning px-2.5 text-[11.5px] font-semibold text-accent-ink"
					>
						{t("libreLauncher.place.useWorktree")}
					</button>
				</div>
			) : null}

			{place !== "ici" ? (
				<div className="mt-4 grid grid-cols-2 gap-3">
					<label className="flex flex-col gap-1.5">
						<span className="text-[11.5px] font-semibold text-ink-muted">{t("libreLauncher.place.branchName")}</span>
						<input
							value={branch}
							spellCheck={false}
							onChange={(event) => setBranchEdit(event.target.value)}
							className="focus-ring h-9 rounded-[10px] border border-line px-3 font-mono text-[12.5px] text-ink"
						/>
						<span className="text-[11px] text-ink-muted">
							{branchEdit === null ? t("libreLauncher.place.branchHint") : " "}
						</span>
					</label>
					<div className="flex flex-col gap-1.5">
						<span className="text-[11.5px] font-semibold text-ink-muted">{t("libreLauncher.place.from")}</span>
						<span className="flex h-9 items-center rounded-[10px] bg-raised px-3 font-mono text-[12.5px] text-ink">
							{from}
						</span>
						{place === "worktree" ? (
							<span className="truncate text-[11px] text-ink-muted">
								<Trans
									t={t}
									i18nKey="libreLauncher.place.copyIn"
									values={{ path: show(worktree) }}
									components={{ code: <span className="font-mono text-ink" /> }}
								/>
							</span>
						) : null}
					</div>
				</div>
			) : null}

			<p className="mt-6 border-t border-line-soft pt-3.5 text-[12.5px] text-ink-muted">
				{t("libreLauncher.place.fullFlow")}{" "}
				<button
					type="button"
					onClick={() => {
						closeLauncher();
						go("workspace");
					}}
					className="focus-ring font-medium text-accent hover:underline"
				>
					{t("libreLauncher.place.openWorkspace")}
				</button>
			</p>
		</>
	);
}

/** Étape 3 : l'agent — moteur, modèle, compte, permissions, profondeur. */
function AgentStep({
	engine,
	engineCount,
	choices,
	set,
	accounts,
	statuses,
	projectAccount,
	place,
}: {
	engine: Engine | undefined;
	engineCount: number | undefined;
	choices: LibreChoices;
	set: SetChoice;
	accounts: Array<{ id: string; label: string; dir: string }>;
	statuses: AccountStatus[] | null | undefined;
	projectAccount: string;
	place: LibrePlace;
}) {
	const { t } = useTranslation("components1");
	const DEPTHS = depths(t);
	const models = modelChoices(engine?.models ?? []);
	const depthSupported = (id: string) =>
		id === "" ||
		Boolean(
			(id === "fast" && engine?.depthFast?.trim()) ||
				(id === "normal" && engine?.depthNormal?.trim()) ||
				(id === "deep" && engine?.depthDeep?.trim()),
		);
	return (
		<>
			<h2 className="text-[17px] font-semibold text-ink">{t("libreLauncher.agent.title")}</h2>
			<p className="mt-1 text-[12.5px] text-ink-muted">
				{t("libreLauncher.agent.description")}
			</p>
			<div className="mt-5 grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-4 gap-y-4">
				<span className="text-[12.5px] font-semibold text-ink-muted">{t("libreLauncher.agent.engine")}</span>
				<span className="text-[12.5px] text-ink">
					<span className="font-semibold">{engine?.label ?? "Claude Code"}</span>
					<span className="text-ink-muted">
						{(engineCount ?? 1) > 1 ? t("libreLauncher.agent.firstEngine") : t("libreLauncher.agent.onlyEngine")}
					</span>
				</span>

				<span className="text-[12.5px] font-semibold text-ink-muted">{t("libreLauncher.agent.model")}</span>
				<div className="flex flex-wrap gap-2">
					{models.map((entry) => (
						<Chip
							key={entry.id || "poste"}
							on={choices.model === entry.id}
							title={entry.hint}
							onClick={() => set("model", entry.id)}
						>
							{entry.id ? entry.label : t("libreLauncher.agent.machineSetting")}
						</Chip>
					))}
				</div>

				<span className="mt-3 self-start text-[12.5px] font-semibold text-ink-muted">{t("libreLauncher.agent.account")}</span>
				<div className="grid grid-cols-2 gap-2">
					{accounts.map((entry) => {
						const status = statuses?.find((candidate) => candidate.id === entry.id);
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
											{status.loggedIn ? t("libreLauncher.agent.loggedIn") : t("libreLauncher.agent.loggedOut")}
										</span>
									) : null}
								</span>
								<span className="font-mono text-[11.5px] text-ink-muted">{entry.dir || "~/.claude"}</span>
								<span className="text-[11px] text-ink-muted">
									{entry.id === projectAccount ? t("libreLauncher.agent.projectAccount") : status?.email || " "}
								</span>
							</button>
						);
					})}
				</div>

				<span className="text-[12.5px] font-semibold text-ink-muted">{t("libreLauncher.agent.permissions")}</span>
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

				<span className="text-[12.5px] font-semibold text-ink-muted">{t("libreLauncher.agent.depth")}</span>
				<div className="flex flex-wrap gap-2">
					{DEPTHS.map((entry) => (
						<Chip
							key={entry.id || "moteur"}
							on={choices.depth === entry.id}
							disabled={!depthSupported(entry.id)}
							title={
								depthSupported(entry.id)
									? undefined
									: t("libreLauncher.agent.depthUnsupported")
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
						{t("libreLauncher.agent.bypassWarning")}
					</span>
				</div>
			) : null}
		</>
	);
}

/** Étape 4 : le résumé en une phrase, la consigne, et s'il faut s'en souvenir. */
function LaunchStep({
	summary,
	prompt,
	setPrompt,
	remember,
	setRemember,
	folder,
}: {
	summary: string;
	prompt: string;
	setPrompt: (value: string) => void;
	remember: boolean;
	setRemember: (update: (value: boolean) => boolean) => void;
	folder: string;
}) {
	const { t } = useTranslation("components1");
	return (
		<>
			<h2 className="text-[17px] font-semibold text-ink">{t("libreLauncher.launch.title")}</h2>
			<p className="mt-3.5 rounded-[14px] bg-raised px-5 py-4 text-[14.5px] leading-relaxed text-ink">
				{summary}
			</p>
			<label className="mt-5 flex flex-col gap-1.5">
				<span className="text-[11.5px] font-semibold text-ink-muted">
					<Trans
						t={t}
						i18nKey="libreLauncher.launch.prompt"
						components={{ muted: <span className="font-normal" /> }}
					/>
				</span>
				<textarea
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
					placeholder={t("libreLauncher.launch.placeholder")}
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
					<Trans
						t={t}
						i18nKey="libreLauncher.launch.remember"
						values={{ folder }}
						components={{ code: <span className="font-mono" /> }}
					/>
				</span>
			</button>
		</>
	);
}

/** Le pied : la commande équivalente, la navigation entre étapes, et ⌘↵. */
function LauncherFooter({
	command,
	step,
	setStep,
	ready,
	launching,
	launch,
}: {
	command: string[];
	step: Step;
	setStep: (step: Step) => void;
	ready: boolean;
	launching: boolean;
	launch: () => Promise<void>;
}) {
	const { t } = useTranslation("components1");
	return (
		<footer className="flex shrink-0 border-t border-line-soft items-center gap-3 px-5 py-3.5">
			<div className="min-w-0 flex-1 rounded-[10px] bg-void px-3.5 py-2.5">
				<div className="mb-1 text-[9.5px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
					{t("libreLauncher.command")}
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
					{t("libreLauncher.back")}
				</button>
			) : null}
			{step < 4 ? (
				<button
					type="button"
					onClick={() => setStep((step + 1) as Step)}
					className="focus-ring h-10 rounded-[10px] border border-line px-3.5 text-[12.5px] font-medium text-ink hover:bg-hover"
				>
					{t("libreLauncher.next")}
				</button>
			) : null}
			<button
				type="button"
				disabled={!ready}
				onClick={() => void launch()}
				className="focus-ring flex h-10 items-center gap-2 rounded-[10px] bg-accent px-4 text-[13.5px] font-semibold text-accent-ink hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
			>
				{launching ? <Spinner /> : null}
				{t("libreLauncher.launch.button")}
				<span className="font-mono text-[11px] opacity-80">{formatShortcut("⌘↵")}</span>
			</button>
		</footer>
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
