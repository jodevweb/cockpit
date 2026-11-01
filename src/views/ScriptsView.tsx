import clsx from "clsx";
import { AlertOctagon, Check, Play, Square, Terminal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LogView } from "@/components/LogView";
import {
	Badge,
	Button,
	Dot,
	Empty,
	ErrorNote,
	Field,
	SearchField,
	Section,
	TextInput,
	ViewHeader,
} from "@/components/ui";
import { duration, fromTimestamp, shortPath } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { JobStatus, RepoCommand } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

function jobTone(job: JobStatus) {
	if (job.state === "running") return "info" as const;
	if (job.state === "succeeded") return "success" as const;
	if (job.state === "cancelled") return "neutral" as const;
	return "critical" as const;
}

function CommandForm({
	command,
	cwd,
	onRun,
}: {
	command: RepoCommand;
	cwd: string;
	onRun: (label: string, line: string) => void;
}) {
	const [positional, setPositional] = useState("");
	const [values, setValues] = useState<Record<string, string | boolean>>({});

	useEffect(() => {
		setPositional("");
		setValues({});
	}, [command.id]);

	// La ligne s'assemble côté Rust, à chaque frappe : c'est ce qui partira
	// vraiment, et l'écran ne doit pas en montrer une autre version.
	const assembled = useAsync(
		() =>
			api.repoCommands.line(
				command,
				positional,
				Object.entries(values).map(([id, value]) => [id, String(value)] as [string, string]),
			),
		[command.id, positional, values],
	);
	const line = assembled.data ?? command.base;
	const missing = Boolean(command.positional?.required && !positional.trim());

	return (
		<div className="flex flex-col gap-3 p-3">
			<div>
				<div className="flex items-center gap-2">
					<h3 className="text-[13px] font-semibold text-ink">{command.label}</h3>
					{command.danger ? <Badge tone="critical">sensible</Badge> : null}
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
					{command.description}
				</p>
			</div>

			{command.positional ? (
				<Field label={command.positional.label} hint={command.positional.hint}>
					<TextInput
						value={positional}
						onChange={setPositional}
						placeholder={command.positional.placeholder}
						mono
					/>
				</Field>
			) : null}

			{command.options.length > 0 ? (
				<Section title="Options">
					<div className="flex flex-col gap-2">
						{command.options.map((option) => {
							if (option.kind === "boolean") {
								const checked = values[option.id] === true;
								return (
									<button
										key={option.id}
										type="button"
										onClick={() =>
											setValues((current) => ({
												...current,
												[option.id]: !checked,
											}))
										}
										className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-surface"
									>
										<span
											className={clsx(
												"flex size-[15px] shrink-0 items-center justify-center rounded-[5px] border transition-colors",
												checked
													? "border-accent bg-accent text-accent-ink"
													: "border-line bg-raised",
											)}
										>
											{checked ? <Check size={10} strokeWidth={3} /> : null}
										</span>
										<span className="min-w-0 flex-1">
											<span className="block text-[11px] text-ink-muted">
												{option.label}
											</span>
											{option.hint ? (
												<span className="block text-[10px] text-ink-faint">
													{option.hint}
												</span>
											) : null}
										</span>
										<code className="shrink-0 font-mono text-[10px] text-ink-faint">
											{option.flag}
										</code>
									</button>
								);
							}

							if (option.kind === "select") {
								return (
									<Field key={option.id} label={option.label} hint={option.hint}>
										<select
											value={String(values[option.id] ?? "")}
											onChange={(event) =>
												setValues((current) => ({
													...current,
													[option.id]: event.target.value,
												}))
											}
											className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2 text-xs text-ink"
										>
											{option.choices.map((choice) => (
												<option key={choice} value={choice}>
													{choice || "— défaut —"}
												</option>
											))}
										</select>
									</Field>
								);
							}

							return (
								<Field key={option.id} label={option.label} hint={option.hint}>
									<TextInput
										value={String(values[option.id] ?? "")}
										onChange={(value) =>
											setValues((current) => ({ ...current, [option.id]: value }))
										}
										placeholder={option.placeholder}
										mono
									/>
								</Field>
							);
						})}
					</div>
				</Section>
			) : null}

			<div className="rounded-lg border border-line-soft bg-void p-2.5">
				<div className="mb-1 text-[10px] tracking-[0.07em] text-ink-faint uppercase">
					Commande
				</div>
				<code className="text-selectable block font-mono text-[11px] break-all text-accent-soft">
					{line}
				</code>
				<div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
					dans {shortPath(cwd, 2)}
				</div>
			</div>

			<div className="flex gap-2">
				<Button
					variant="solid"
					icon={Play}
					disabled={missing}
					className="h-8 flex-1 justify-center"
					onClick={() => onRun(command.label, line)}
				>
					Exécuter
				</Button>
				<Button
					variant="outline"
					icon={Terminal}
					className="h-8 justify-center"
					title="Ouvrir dans Terminal.app plutôt que dans le cockpit"
					onClick={() => {
						void api.system.openTerminal(cwd, line).catch(() => undefined);
					}}
				/>
			</div>
			{missing ? (
				<p className="flex items-center gap-1.5 text-[11px] text-warning">
					<AlertOctagon size={11} />
					{command.positional?.label} est requis.
				</p>
			) : null}
		</div>
	);
}

export function ScriptsView() {
	const { config, worktrees, jobs, jobLines, runJob, killJob, clearJobLines, notify } =
		useCockpit();
	const mainRepo = config?.mainRepo ?? "";

	// Les commandes viennent du projet : elles décrivent son outillage, et un
	// cockpit neuf n'en propose aucune plutôt que celles d'une autre équipe.
	const catalog = useMemo(() => config?.commands ?? [], [config?.commands]);

	const [targetPath, setTargetPath] = useState<string>("");
	const [commandId, setCommandId] = useState<string>("");
	const [query, setQuery] = useState("");
	const [selectedJob, setSelectedJob] = useState<string | null>(null);

	useEffect(() => {
		if (!targetPath && mainRepo) setTargetPath(mainRepo);
	}, [mainRepo, targetPath]);

	const packageScripts = useAsync(
		() => (targetPath ? api.scripts.list(targetPath) : Promise.resolve([])),
		[targetPath],
		{ enabled: Boolean(targetPath) },
	);

	const command = useMemo(
		() => catalog.find((entry) => entry.id === commandId) ?? catalog[0] ?? null,
		[catalog, commandId],
	);

	const cwd = command?.scoped === false ? mainRepo : targetPath || mainRepo;

	const groupedCatalog = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const list = needle
			? catalog.filter((entry) =>
					`${entry.label} ${entry.description} ${entry.base}`
						.toLowerCase()
						.includes(needle),
				)
			: catalog;
		const groups = new Map<string, RepoCommand[]>();
		for (const entry of list) {
			const bucket = groups.get(entry.group) ?? [];
			bucket.push(entry);
			groups.set(entry.group, bucket);
		}
		return [...groups.entries()];
	}, [catalog, query]);

	const filteredScripts = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const list = packageScripts.data ?? [];
		if (!needle) return list;
		return list.filter((script) =>
			`${script.name} ${script.command}`.toLowerCase().includes(needle),
		);
	}, [packageScripts.data, query]);

	const activeJob = useMemo(
		() => jobs.find((job) => job.jobId === selectedJob) ?? jobs[0] ?? null,
		[jobs, selectedJob],
	);

	const launch = (label: string, line: string) => {
		void runJob(label, line, cwd).then((status) => {
			if (status) setSelectedJob(status.jobId);
		});
	};

	return (
		<>
			<ViewHeader
				title="Scripts"
				subtitle="Commandes maison paramétrables et scripts du dépôt, exécutés avec sortie live."
				actions={
					<select
						value={targetPath}
						onChange={(event) => setTargetPath(event.target.value)}
						className="focus-ring h-7 max-w-64 rounded-lg border border-line-soft bg-raised px-2 text-[11px] text-ink-muted"
						title="Worktree cible"
					>
						{worktrees.map((tree) => (
							<option key={tree.path} value={tree.path}>
								{tree.branch ?? tree.folderName}
							</option>
						))}
					</select>
				}
			/>

			<div className="flex min-h-0 flex-1">
				<div className="hairline-r flex w-64 shrink-0 flex-col bg-base">
					<div className="p-2.5">
						<SearchField value={query} onChange={setQuery} placeholder="Chercher…" />
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
						{groupedCatalog.map(([group, entries]) => (
							<div key={group} className="mb-2">
								<div className="px-2 py-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
									{group}
								</div>
								{entries.map((entry) => (
									<button
										key={entry.id}
										type="button"
										onClick={() => setCommandId(entry.id)}
										className={clsx(
											"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
											commandId === entry.id
												? "bg-raised text-ink"
												: "text-ink-muted hover:bg-surface",
										)}
									>
										<span className="min-w-0 flex-1 truncate text-[11px]">
											{entry.label}
										</span>
										{entry.options.length > 0 ? (
											<span className="shrink-0 font-mono text-[10px] text-ink-faint">
												{entry.options.length}
											</span>
										) : null}
									</button>
								))}
							</div>
						))}

						{filteredScripts.length > 0 ? (
							<div className="mb-2">
								<div className="px-2 py-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
									package.json
								</div>
								{filteredScripts.map((script) => (
									<button
										key={script.name}
										type="button"
										title={script.command}
										onClick={() =>
											launch(
												`${script.runner} ${script.name}`,
												`${script.runner} ${script.name}`,
											)
										}
										className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ink-muted transition-colors hover:bg-surface"
									>
										<Play size={10} className="shrink-0 text-ink-faint" />
										<span className="min-w-0 flex-1 truncate font-mono text-[11px]">
											{script.name}
										</span>
									</button>
								))}
							</div>
						) : null}
					</div>
				</div>

				<div className="hairline-r w-80 shrink-0 overflow-y-auto bg-base">
					{packageScripts.error ? <ErrorNote error={packageScripts.error} /> : null}
					{command ? (
						<CommandForm command={command} cwd={cwd} onRun={launch} />
					) : (
						// Un cockpit qui n'a rien à proposer le dit, plutôt que d'afficher
						// un formulaire vide qu'on croirait cassé.
						<Empty
							icon={Terminal}
							message="Aucune commande déclarée pour ce projet."
							hint="Réglages → Agents → Commandes du dépôt : le cockpit peut les détecter depuis les scripts du dépôt, ou tu les écris."
						/>
					)}
				</div>

				<div className="flex min-w-0 flex-1 flex-col bg-base">
					<div className="hairline-b flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto px-2">
						{jobs.length === 0 ? (
							<span className="px-2 text-[11px] text-ink-faint">
								Aucune exécution pour l'instant.
							</span>
						) : (
							jobs.slice(0, 12).map((job) => (
								<button
									key={job.jobId}
									type="button"
									onClick={() => setSelectedJob(job.jobId)}
									className={clsx(
										"flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors",
										activeJob?.jobId === job.jobId
											? "bg-raised text-ink"
											: "text-ink-muted hover:bg-surface",
									)}
								>
									<Dot tone={jobTone(job)} pulse={job.state === "running"} />
									<span className="max-w-40 truncate">{job.label}</span>
								</button>
							))
						)}
					</div>

					{activeJob ? (
						<>
							<div className="hairline-b flex items-center gap-2 px-3 py-2">
								<Badge tone={jobTone(activeJob)}>
									{activeJob.state === "running"
										? "en cours"
										: activeJob.state === "succeeded"
											? "terminé"
											: activeJob.state === "cancelled"
												? "annulé"
												: `échec ${activeJob.exitCode ?? ""}`}
								</Badge>
								<code className="text-selectable min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
									{activeJob.command}
								</code>
								<span className="shrink-0 font-mono text-[10px] text-ink-faint">
									{activeJob.endedAt
										? duration(activeJob.endedAt - activeJob.startedAt)
										: fromTimestamp(activeJob.startedAt)}
								</span>
								{activeJob.state === "running" ? (
									<Button
										size="sm"
										variant="danger"
										icon={Square}
										onClick={() => killJob(activeJob.jobId)}
									>
										Stop
									</Button>
								) : (
									<Button
										size="sm"
										icon={Trash2}
										title="Vider la sortie"
										onClick={() => clearJobLines(activeJob.jobId)}
									/>
								)}
								<Button
									size="sm"
									icon={Terminal}
									title="Rejouer dans Terminal.app"
									onClick={() => {
										void api.system
											.openTerminal(activeJob.cwd, activeJob.command)
											.catch((error) => notify(String(error)));
									}}
								/>
							</div>
							<LogView lines={jobLines[activeJob.jobId] ?? []} />
						</>
					) : (
						<Empty
							icon={Play}
							message="Lance une commande"
							hint="La sortie s'affiche ici en direct, avec les couleurs du terminal."
						/>
					)}
				</div>
			</div>
		</>
	);
}
