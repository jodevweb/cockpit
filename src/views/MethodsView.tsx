import clsx from "clsx";
import { Blocks, Download, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCockpit } from "@/app/store";
import { useConfirm } from "@/components/Confirm";
import { Badge, Button, Empty, ErrorNote, Section, Spinner, ViewHeader } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { MethodAvailable, MethodInstalled } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/** Le style des champs de l'app (voir `TextInput`). */
const FIELD =
	"focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2.5 text-xs text-ink placeholder:text-ink-faint focus:border-accent/40";

/** Combien de plugins disponibles on montre à la fois : il y en a des milliers. */
const SHOWN = 40;

/** Une ligne de la liste : installé, ou proposé par une marketplace. */
type Row = { id: string; name: string; description: string; marketplace: string; installs: number; installed?: MethodInstalled };

/**
 * L'explorateur de méthodes : les plugins Claude Code (skills, commandes,
 * sous-agents, hooks, serveurs MCP) qu'un projet peut adopter.
 *
 * On ne choisit pas un plugin à son nom ni à son nombre d'installations : on le
 * choisit à ce qu'il fait tourner sur le poste. La fiche le met donc en tête —
 * hooks, serveurs, scripts — lu dans la source au commit épinglé, avant toute
 * installation, avec ce que le plugin coûte en contexte à chaque session.
 */
export function MethodsView() {
	const { activeProject, notify } = useCockpit();
	const { confirm } = useConfirm();
	const { t } = useTranslation("views");
	const project = activeProject?.mainRepo ?? "";
	const catalog = useAsync(() => (project ? api.methods.catalog(project) : Promise.resolve(null)), [project]);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const inspection = useAsync(
		() => (project && selected ? api.methods.inspect(project, selected) : Promise.resolve(null)),
		[project, selected],
	);

	const [scope, setScope] = useState<"project" | "local">("project");
	const [busy, setBusy] = useState(false);
	const installedEntry = catalog.data?.installed.find((plugin) => plugin.id === selected) ?? null;
	const measure = useAsync(
		() =>
			project && installedEntry && activeProject?.id
				? api.methods.measure(project, activeProject.id, installedEntry.id)
				: Promise.resolve(null),
		[project, installedEntry?.id, activeProject?.id],
	);

	const rows = useMemo(() => {
		const data = catalog.data;
		if (!data) return { installed: [] as Row[], available: [] as Row[], total: 0 };
		const needle = query.trim().toLowerCase();
		const matches = (row: Row) =>
			!needle || row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle);
		const byId = new Map(data.available.map((plugin) => [plugin.pluginId, plugin]));
		const toRow = (plugin: MethodAvailable): Row => ({
			id: plugin.pluginId,
			name: plugin.name,
			description: plugin.description,
			marketplace: plugin.marketplaceName,
			installs: plugin.installCount,
		});
		const installed = data.installed
			.map((plugin) => {
				const known = byId.get(plugin.id);
				const [name, marketplace = ""] = plugin.id.split("@");
				return {
					...(known ? toRow(known) : { id: plugin.id, name, description: "", marketplace, installs: 0 }),
					installed: plugin,
				};
			})
			.filter(matches);
		const taken = new Set(data.installed.map((plugin) => plugin.id));
		const candidates = data.available
			.filter((plugin) => !taken.has(plugin.pluginId))
			.map(toRow)
			.filter(matches)
			.sort((a, b) => b.installs - a.installs);
		return { installed, available: candidates.slice(0, SHOWN), total: candidates.length };
	}, [catalog.data, query]);

	if (!project) {
		return (
			<>
				<ViewHeader title={t("methods.title")} subtitle={t("methods.subtitle")} />
				<Empty icon={Blocks} message={t("methods.noProject")} />
			</>
		);
	}

	const detail = inspection.data;
	const executes = detail ? detail.inventory.hooks.length + detail.inventory.servers.length > 0 : false;
	const changedSinceApproval =
		detail != null && installedEntry != null && detail.approved != null && detail.approved !== detail.inventory.fingerprint;

	const install = async () => {
		if (!detail || !selected) return;
		const name = detail.inventory.name || selected;
		const ok = await confirm({
			title: t("methods.installTitle", { name }),
			message: executes
				? t("methods.installRuns", {
						hooks: detail.inventory.hooks.length,
						servers: detail.inventory.servers.length,
					})
				: t("methods.installSafe"),
			confirmLabel: t("methods.install"),
			danger: executes,
		});
		if (!ok) return;
		setBusy(true);
		try {
			let result = await api.methods.install(project, selected, scope, detail.inventory.fingerprint);
			// La marketplace veut lancer une commande pour installer : on la montre
			// telle quelle, et on ne l'accepte que pour cette empreinte-là.
			if (result.kind === "needsCommand") {
				const accepted = await confirm({
					title: t("methods.commandTitle"),
					message: t("methods.commandMessage", { command: result.command }),
					confirmLabel: t("methods.commandAccept"),
					danger: true,
				});
				if (!accepted) return;
				result = await api.methods.install(project, selected, scope, detail.inventory.fingerprint, result.sha256);
			}
			if (result.kind === "installed") {
				notify(scope === "project" ? t("methods.installedProject", { name }) : t("methods.installedLocal", { name }));
				catalog.reload();
				inspection.reload();
			}
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const uninstall = async () => {
		if (!installedEntry) return;
		const ok = await confirm({
			title: t("methods.uninstallTitle", { name: installedEntry.id.split("@")[0] }),
			confirmLabel: t("methods.uninstall"),
			danger: true,
		});
		if (!ok) return;
		setBusy(true);
		try {
			await api.methods.uninstall(project, installedEntry.id, installedEntry.scope);
			notify(t("methods.uninstalled"));
			catalog.reload();
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const item = (row: Row) => (
		<button
			key={row.id}
			type="button"
			onClick={() => setSelected(row.id)}
			className={clsx(
				"panel focus-ring flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
				selected === row.id ? "ring-1 ring-accent" : "hover:bg-raised",
			)}
		>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[12.5px] text-ink">{row.name}</span>
				<span className="block truncate text-[10.5px] text-ink-faint">{row.description || row.marketplace}</span>
			</span>
			{row.installed ? (
				<Badge tone="success">{t(`methods.scope.${row.installed.scope}`, { defaultValue: row.installed.scope })}</Badge>
			) : (
				<span className="shrink-0 font-mono text-[10px] text-ink-faint">
					{t("methods.installs", { count: row.installs })}
				</span>
			)}
		</button>
	);

	return (
		<>
			<ViewHeader
				title={t("methods.title")}
				subtitle={t("methods.subtitle")}
				actions={
					<>
						{catalog.loading ? <Spinner /> : null}
						<Button size="sm" icon={RefreshCw} title={t("methods.refresh")} onClick={catalog.reload} />
					</>
				}
			/>

			<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-5 overflow-hidden p-4">
				<div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("methods.search")}
						className={FIELD}
					/>
					{catalog.error ? <ErrorNote error={catalog.error} onRetry={catalog.reload} /> : null}
					<Section title={t("methods.installed")} count={rows.installed.length}>
						{rows.installed.length === 0 && !catalog.loading ? <Empty message={t("methods.noneInstalled")} /> : null}
						<div className="flex flex-col gap-1">{rows.installed.map(item)}</div>
					</Section>
					<Section title={t("methods.available")} count={rows.total}>
						{rows.available.length === 0 && !catalog.loading ? <Empty message={t("methods.noneAvailable")} /> : null}
						<div className="flex flex-col gap-1">{rows.available.map(item)}</div>
						{rows.total > rows.available.length ? (
							<p className="mt-2 text-[11px] text-ink-faint">
								{t("methods.more", { shown: rows.available.length, total: rows.total })}
							</p>
						) : null}
					</Section>
				</div>

				<div className="min-h-0 overflow-y-auto">
					{!selected ? <Empty icon={Blocks} message={t("methods.pick")} hint={t("methods.pickHint")} /> : null}
					{selected && inspection.loading ? (
						<div className="flex items-center gap-2 p-3 text-[12px] text-ink-muted">
							<Spinner />
							{t("methods.reading")}
						</div>
					) : null}
					{inspection.error ? <ErrorNote error={inspection.error} onRetry={inspection.reload} /> : null}
					{detail && !inspection.loading ? (
						<div className="flex flex-col gap-4">
							<div>
								<div className="text-[15px] font-semibold text-ink">
									{detail.inventory.name || selected}
									{detail.inventory.version ? (
										<span className="ml-2 font-mono text-[11px] font-normal text-ink-faint">
											{detail.inventory.version}
										</span>
									) : null}
								</div>
								{detail.alwaysOnTokens != null ? (
									<div className="mt-1 text-[12px] text-ink-muted">
										{t("methods.alwaysOn", { tokens: detail.alwaysOnTokens })}
									</div>
								) : null}
							</div>

							<div className="flex flex-wrap items-center gap-2">
								{installedEntry ? (
									<>
										<Badge tone="success">
											{t("methods.installedFor", {
												scope: t(`methods.scope.${installedEntry.scope}`, { defaultValue: installedEntry.scope }),
											})}
										</Badge>
										{installedEntry.scope !== "user" ? (
											<Button size="sm" icon={Trash2} loading={busy} onClick={() => void uninstall()}>
												{t("methods.uninstall")}
											</Button>
										) : (
											<span className="text-[11px] text-ink-faint">{t("methods.userScopeHint")}</span>
										)}
									</>
								) : (
									<>
										<select
											value={scope}
											onChange={(event) => setScope(event.target.value as "project" | "local")}
											className={clsx(FIELD, "w-auto")}
											title={t("methods.scopeTitle")}
										>
											<option value="project">{t("methods.forProject")}</option>
											<option value="local">{t("methods.forMachine")}</option>
										</select>
										<Button variant="solid" icon={Download} loading={busy} onClick={() => void install()}>
											{t("methods.install")}
										</Button>
									</>
								)}
							</div>

							{changedSinceApproval ? (
								<div className="rounded-xl border border-critical/30 bg-critical/8 p-3 text-[12px] text-ink">
									{t("methods.changedSinceApproval")}
								</div>
							) : null}

							<div
								className={clsx(
									"rounded-xl border p-3",
									executes ? "border-warning/30 bg-warning/8" : "border-success/25 bg-success/8",
								)}
							>
								<div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
									{executes ? (
										<ShieldAlert size={14} className="text-warning" />
									) : (
										<ShieldCheck size={14} className="text-success" />
									)}
									{executes ? t("methods.executes") : t("methods.executesNothing")}
								</div>
								{executes ? (
									<div className="mt-2 flex flex-col gap-1.5">
										{detail.inventory.hooks.map((hook, index) => (
											<div key={`h${index}`} className="text-[11px]">
												<Badge tone="warning">{hook.event}</Badge>
												<code className="ml-2 break-all font-mono text-[10.5px] text-ink">{hook.command}</code>
											</div>
										))}
										{detail.inventory.servers.map((server) => (
											<div key={`s${server.name}`} className="text-[11px]">
												<Badge tone="info">MCP · {server.name}</Badge>
												<code className="ml-2 break-all font-mono text-[10.5px] text-ink">{server.target}</code>
											</div>
										))}
										{detail.inventory.scripts.length > 0 ? (
											<div className="text-[11px] text-ink-muted">
												{t("methods.scripts", { files: detail.inventory.scripts.join(", ") })}
											</div>
										) : null}
										<div className="font-mono text-[10px] text-ink-faint" title={detail.inventory.fingerprint}>
											{t("methods.fingerprint", { value: detail.inventory.fingerprint.slice(0, 12) })}
										</div>
									</div>
								) : (
									<p className="mt-1 text-[11.5px] text-ink-muted">{t("methods.executesNothingHint")}</p>
								)}
							</div>

							{installedEntry && measure.data ? (
								<Section title={t("methods.measureTitle", { days: measure.data.days })}>
									<div className="grid grid-cols-2 gap-2.5">
										{(["before", "after"] as const).map((side) => {
											const period = measure.data![side];
											return (
												<div key={side} className="panel p-3">
													<div className="text-[10.5px] font-medium tracking-[0.06em] text-ink-faint uppercase">
														{t(`methods.${side}`)}
													</div>
													<div className="mt-1 text-[12px] text-ink">
														{t("methods.periodRuns", { count: period.executions, failed: period.failed })}
													</div>
													<div className="text-[11px] text-ink-muted">
														{[
															period.medianTurns != null ? t("methods.periodTurns", { turns: Math.round(period.medianTurns) }) : null,
															period.medianCostUsd != null
																? t("methods.periodCost", { cost: period.medianCostUsd.toFixed(2) })
																: null,
														]
															.filter(Boolean)
															.join(" · ")}
													</div>
												</div>
											);
										})}
									</div>
									{measure.data.before.executions < 5 || measure.data.after.executions < 5 ? (
										<p className="mt-2 text-[11px] text-ink-faint">{t("methods.measureFew")}</p>
									) : null}
								</Section>
							) : null}

							{(
								[
									["skills", detail.inventory.skills],
									["commands", detail.inventory.commands],
									["agents", detail.inventory.agents],
								] as const
							).map(([kind, list]) =>
								list.length > 0 ? (
									<Section key={kind} title={t(`methods.${kind}`)} count={list.length}>
										<div className="flex flex-wrap gap-1.5">
											{list.map((name) => (
												<Badge key={name} mono>
													{name}
												</Badge>
											))}
										</div>
									</Section>
								) : null,
							)}

							{detail.source.sha || detail.source.url || detail.source.repo || detail.source.path ? (
								<div className="font-mono text-[10.5px] text-ink-faint">
									{t("methods.source", {
										where: detail.source.url || detail.source.repo || detail.source.path,
										at: detail.source.sha ? detail.source.sha.slice(0, 10) : detail.source.ref || "—",
									})}
								</div>
							) : null}
						</div>
					) : null}
				</div>
			</div>
		</>
	);
}
