import { BellOff, CheckCircle2, Ticket } from "lucide-react";
import { FeedPanel, type FeedSource } from "@/components/FeedPanel";
import { KpiBoard } from "@/components/KpiBoard";
import { Button, ViewHeader } from "@/components/ui";
import { api } from "@/lib/ipc";
import { announceChange } from "@/lib/refresh";
import { usePersistentState } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

export function ObservabilityView() {
	const { config, notify } = useCockpit();
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
									notify("Ticket Linear créé.");
									void api.system.openUrl(url).catch(() => undefined);
									reload();
								})
								.catch((error) => notify(String(error)));
						}}
						title="Créer le ticket Linear et l'annoter dans Sentry"
					>
						Ticket
					</Button>
					<Button
						icon={CheckCircle2}
						onClick={() => {
							void api.feeds
								.sentrySetStatus(item.id, "resolved")
								.then(() => {
									notify("Issue résolue.");
									reload();
									void announceChange("issues");
								})
								.catch((error) => notify(String(error)));
						}}
					>
						Résoudre
					</Button>
					<Button
						icon={BellOff}
						onClick={() => {
							void api.feeds
								.sentrySetStatus(item.id, "ignored")
								.then(() => {
									notify("Issue ignorée.");
									reload();
									void announceChange("issues");
								})
								.catch((error) => notify(String(error)));
						}}
					>
						Ignorer
					</Button>
				</>
			),
		},
		{
			id: "sentry-regressions",
			label: "Régressions",
			// `is:regressed` — `is:regression` n'existe pas et Sentry répond 400.
			load: () => api.feeds.sentry("is:unresolved is:regressed"),
		},
		{
			id: "bs-incidents",
			label: "Incidents",
			load: () => api.feeds.betterstackIncidents(),
		},
		{
			id: "bs-monitors",
			label: "Monitors",
			load: () => api.feeds.betterstackMonitors(),
		},
	];

	return (
		<>
			<ViewHeader
				title="Observabilité"
				actions={
					<>
						<Button active={!showKpi} onClick={() => setShowKpi(false)}>
							Erreurs & incidents
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
						: "Sentry et Better Stack"
				}
			/>
			{showKpi ? (
				<KpiBoard />
			) : (
				<FeedPanel
					sources={sources}
					pollMs={120_000}
					emptyHint="Vérifie le token et l'organisation dans Réglages si tu attendais des résultats."
				/>
			)}
		</>
	);
}
