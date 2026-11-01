import clsx from "clsx";
import { BarChart3, ExternalLink, Hash, LineChart, RefreshCw, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Empty, ErrorNote, SearchField, Spinner } from "@/components/ui";
import { fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { KpiChart, KpiValue } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { useTranslation } from "react-i18next";
import { t as translate } from "@/i18n";

/** Chaque type de graphique a sa silhouette : on repère la forme avant le texte. */
const CHART_ICON: Record<
	string,
	React.ComponentType<{ size?: number; className?: string }>
> = {
	line_chart: LineChart,
	number_chart: Hash,
	table_chart: Table2,
	bar_chart: BarChart3,
};

function groupBySection(charts: KpiChart[]) {
	const sections = new Map<string, KpiChart[]>();
	for (const chart of charts) {
		const key = chart.section || translate("components1:kpiBoard.noSection");
		sections.set(key, [...(sections.get(key) ?? []), chart]);
	}
	return [...sections.entries()];
}

/**
 * Inventaire des dashboards Telemetry — ce qui est mesuré, où, et à quand
 * remonte la dernière modification.
 *
 * Les valeurs elles-mêmes ne sont pas affichées : chaque graphique est une
 * requête SQL sur une source, qui demande les identifiants ClickHouse de
 * celle-ci. Tant qu'ils ne sont pas configurés, le cockpit sert de table des
 * matières et renvoie au dashboard d'un clic.
 */
export function KpiBoard() {
	const { t } = useTranslation("components1");
	const { notify } = useCockpit();
	const [query, setQuery] = useState("");
	const [openId, setOpenId] = useState<string | null>(null);
	const [hours, setHours] = useState(24);
	const dashboards = useAsync(() => api.feeds.betterstackDashboards(), [], {
		pollMs: 300_000,
	});

	// Les valeurs se calculent à la demande : chaque graphique est une requête
	// SQL, on ne les lance pas pour les onze dashboards à l'ouverture.
	const values = useAsync(
		() =>
			openId
				? api.feeds.betterstackKpiValues(openId, hours)
				: Promise.resolve([] as KpiValue[]),
		[openId, hours],
		{ enabled: Boolean(openId), pollMs: 120_000 },
	);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return dashboards.data ?? [];
		return (dashboards.data ?? [])
			.map((dashboard) => ({
				...dashboard,
				charts: dashboard.charts.filter((chart) =>
					`${chart.name} ${chart.section}`.toLowerCase().includes(needle),
				),
			}))
			.filter(
				(dashboard) =>
					dashboard.charts.length > 0 || dashboard.name.toLowerCase().includes(needle),
			);
	}, [dashboards.data, query]);

	const open = (url: string) => {
		void api.system.openUrl(url).catch((error) => notify(String(error)));
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="hairline-b flex items-center gap-2 px-3 py-2">
				<div className="max-w-sm flex-1">
					<SearchField
						value={query}
						onChange={setQuery}
						placeholder={t("kpiBoard.filter")}
					/>
				</div>
				<span className="ml-auto text-[10px] text-ink-faint">
					{t("kpiBoard.dashboards", { count: filtered.length })} ·{" "}
					{t("kpiBoard.indicators", {
						count: filtered.reduce((total, dashboard) => total + dashboard.charts.length, 0),
					})}
				</span>
				{dashboards.loading ? <Spinner /> : null}
				<Button size="sm" icon={RefreshCw} onClick={dashboards.reload} />
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{dashboards.error ? (
					<ErrorNote error={dashboards.error} onRetry={dashboards.reload} />
				) : null}

				{!dashboards.error && filtered.length === 0 && !dashboards.initial ? (
					<Empty
						icon={BarChart3}
						message={t("kpiBoard.empty.message")}
						hint={t("kpiBoard.empty.hint")}
					/>
				) : null}

				<div className="mx-auto flex max-w-5xl flex-col gap-4">
					{filtered.map((dashboard) => (
						<div key={dashboard.id} className="panel p-3">
							<div className="mb-2 flex items-baseline gap-2">
								<button
									type="button"
									onClick={() =>
										setOpenId((current) => (current === dashboard.id ? null : dashboard.id))
									}
									className="flex min-w-0 items-baseline gap-2 text-left"
								>
									<h3 className="truncate text-[13px] font-semibold text-ink hover:underline">
										{dashboard.name}
									</h3>
									<span className="shrink-0 text-[10px] text-ink-faint">
										{openId === dashboard.id ? t("kpiBoard.hide") : t("kpiBoard.show")}
									</span>
								</button>
								{openId === dashboard.id ? (
									<select
										value={hours}
										onChange={(event) => setHours(Number(event.target.value))}
										className="focus-ring rounded-lg border border-line-soft bg-surface px-1.5 py-0.5 text-[10px] text-ink-muted"
									>
										<option value={1}>{t("kpiBoard.hours", { count: 1 })}</option>
										<option value={24}>{t("kpiBoard.hours", { count: 24 })}</option>
										<option value={168}>{t("kpiBoard.days", { count: 7 })}</option>
										<option value={720}>{t("kpiBoard.days", { count: 30 })}</option>
									</select>
								) : null}
								{openId === dashboard.id && values.loading ? <Spinner /> : null}
								<button
									type="button"
									onClick={() => open(dashboard.url)}
									title={t("kpiBoard.openExternal")}
									className="shrink-0 text-ink-faint hover:text-ink-muted"
								>
									<ExternalLink size={11} />
								</button>
								<span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
									{fromIso(dashboard.updatedAt)}
								</span>
							</div>

							{openId === dashboard.id ? (
								<div className="mb-2 flex flex-col gap-2">
									{values.error ? <ErrorNote error={values.error} /> : null}

									<div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
										{(values.data ?? [])
											.filter((value) => value.kind === "number_chart")
											.map((value) => (
												<div key={value.chartId} className="panel p-2.5">
													<div className="truncate text-[10px] text-ink-faint">
														{value.name}
													</div>
													<div
														className={clsx(
															"mt-0.5 truncate font-mono text-[18px] font-semibold tabular-nums",
															value.error ? "text-ink-faint" : "text-ink",
														)}
														title={value.error ?? undefined}
													>
														{value.error ? "—" : (value.rows[0]?.[0] ?? "∅")}
													</div>
												</div>
											))}
									</div>

									{(values.data ?? [])
										.filter(
											(value) => value.kind !== "number_chart" && value.rows.length > 0,
										)
										.map((value) => (
											<div key={value.chartId} className="panel overflow-x-auto p-2.5">
												<div className="mb-1 text-[10px] text-ink-faint">{value.name}</div>
												<table className="w-full text-[10px]">
													<tbody>
														{value.rows.slice(0, 8).map((row, index) => (
															<tr
																key={index}
																className="border-b border-line-soft last:border-0"
															>
																{row.map((cell, cellIndex) => (
																	<td
																		key={cellIndex}
																		className="py-0.5 pr-3 font-mono whitespace-nowrap text-ink-muted"
																	>
																		{cell}
																	</td>
																))}
															</tr>
														))}
													</tbody>
												</table>
											</div>
										))}
								</div>
							) : null}

							<div className="flex flex-col gap-2">
								{groupBySection(dashboard.charts).map(([section, charts]) => (
									<div key={section}>
										<div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
											{section}
										</div>
										<div className="grid grid-cols-2 gap-1 xl:grid-cols-3">
											{charts.map((chart) => {
												const Icon = CHART_ICON[chart.kind] ?? LineChart;
												return (
													<button
														key={chart.id}
														type="button"
														onClick={() => open(dashboard.url)}
														className={clsx(
															"flex items-center gap-1.5 rounded-lg px-2 py-1 text-left",
															"hover:bg-surface",
														)}
													>
														<Icon size={11} className="shrink-0 text-ink-faint" />
														<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
															{chart.name}
														</span>
													</button>
												);
											})}
										</div>
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
