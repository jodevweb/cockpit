import { BellOff, CheckCircle2, Ticket } from "lucide-react";
import { FeedPanel, type FeedSource } from "@/components/FeedPanel";
import { KpiBoard } from "@/components/KpiBoard";
import { Button, ViewHeader } from "@/components/ui";
import { api } from "@/lib/ipc";
import { announceChange } from "@/lib/refresh";
import { usePersistentState } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { useTranslation } from "react-i18next";

export function ObservabilityView() {
	const { config, notify } = useCockpit();
	const { t } = useTranslation("views");
	const [showKpi, setShowKpi] = usePersistentState("observability.kpi", false);

	const sources: FeedSource[] = [
		{
			id: "sentry",
			label: "Sentry",
			changes: "issues",
			load: () => api.feeds.sentry("is:unresolved"),
			// Traiter une issue depuis le cockpit évite l'aller-retour navigateur
			// quand on triage une série d'erreurs.
			actions: (item, reload) => (
				<>
					<Button
						icon={Ticket}
						onClick={() => {
							const meta = (label: string) =>
								item.meta.find((field) => field.label === label)?.value ?? "";
							void api.feeds
								.sentryToLinear({
									issueId: item.id,
									title: item.title,
									permalink: item.url,
									project: meta("projet"),
									culprit: item.subtitle,
									users: meta("utilisateurs"),
									events: meta("occurrences"),
								})
								.then((url) => {
									notify(t("observability.ticketCreated"));
									void api.system.openUrl(url).catch(() => undefined);
									reload();
								})
								.catch((error) => notify(String(error)));
						}}
						title={t("observability.ticketTitle")}
					>
						{t("observability.ticket")}
					</Button>
					<Button
						icon={CheckCircle2}
						onClick={() => {
							void api.feeds
								.sentrySetStatus(item.id, "resolved")
								.then(() => {
									notify(t("observability.resolved"));
									reload();
									void announceChange("issues");
								})
								.catch((error) => notify(String(error)));
						}}
					>
						{t("observability.resolve")}
					</Button>
					<Button
						icon={BellOff}
						onClick={() => {
							void api.feeds
								.sentrySetStatus(item.id, "ignored")
								.then(() => {
									notify(t("observability.ignored"));
									reload();
									void announceChange("issues");
								})
								.catch((error) => notify(String(error)));
						}}
					>
						{t("observability.ignore")}
					</Button>
				</>
			),
		},
		{
			id: "sentry-regressions",
			label: t("observability.regressions"),
			// `is:regressed` — `is:regression` n'existe pas et Sentry répond 400.
			load: () => api.feeds.sentry("is:unresolved is:regressed"),
		},
		{
			id: "bs-incidents",
			label: t("observability.incidents"),
			load: () => api.feeds.betterstackIncidents(),
		},
		{
			id: "bs-monitors",
			label: t("observability.monitors"),
			load: () => api.feeds.betterstackMonitors(),
		},
	];

	return (
		<>
			<ViewHeader
				title={t("observability.title")}
				actions={
					<>
						<Button active={!showKpi} onClick={() => setShowKpi(false)}>
							{t("observability.errorsAndIncidents")}
						</Button>
						<Button active={showKpi} onClick={() => setShowKpi(true)}>
							KPI
						</Button>
					</>
				}
				subtitle={
					config?.sentryOrg
						? `Sentry · ${config.sentryOrg}${
								config.sentryProjects.length ? ` (${config.sentryProjects.join(", ")})` : ""
							} · Better Stack`
						: t("observability.subtitle")
				}
			/>
			{showKpi ? (
				<KpiBoard />
			) : (
				<FeedPanel
					sources={sources}
					pollMs={120_000}
					emptyHint={t("observability.emptyHint")}
				/>
			)}
		</>
	);
}
