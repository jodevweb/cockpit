import { GitPullRequest } from "lucide-react";
import { LinearIssue } from "@/components/LinearIssue";
import { StartMission } from "@/components/StartMission";
import { PullRequestDetail } from "@/components/PullRequestDetail";
import { FeedPanel, type FeedSource } from "@/components/FeedPanel";
import { Button, ViewHeader } from "@/components/ui";
import { api } from "@/lib/ipc";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { useTranslation } from "react-i18next";

export function DeliveryView() {
	const { config, worktrees, notify, go } = useCockpit();
	const { t } = useTranslation("views");
	// L'onglet porte le nom du suivi configuré : « Linear » écrit en dur mentait
	// dès qu'une équipe travaillait ailleurs.
	const provider = useAsync(() => api.feeds.ticketProvider().catch(() => null), []);

	const sources: FeedSource[] = [
		{
			id: "linear",
			label: provider.data?.label ?? t("delivery.tickets"),
			changes: "tickets",
			load: () => api.feeds.linear(false),
			detail: (item) => <LinearIssue identifier={item.id} />,
			// Le champ `branchName` de Linear correspond au nommage des worktrees :
			// on peut donc sauter directement au worktree de l'US.
			actions: (item) => {
				const branch = item.meta.find((field) => field.label === "branche")?.value;
				const tree = branch
					? worktrees.find((candidate) => candidate.branch === branch)
					: undefined;
				// Deux suites possibles pour un ticket, et elles ne s'excluent pas :
				// reprendre le travail déjà commencé, ou le confier à une mission.
				return (
					<>
						{tree ? (
							<Button
								icon={GitPullRequest}
								onClick={() => go("worktrees", { worktreePath: tree.path })}
							>
								{t("delivery.openWorktree")}
							</Button>
						) : null}
						<StartMission reference={item.id} title={item.title} />
					</>
				);
			},
		},
		{
			id: "github",
			label: "Pull requests",
			changes: "prs",
			// On marque les PR dont la branche est sortie ici : la facette « suivi
			// local » remplace le filtre « mes PR » de l'ancien tableau, sans rien
			// coder de spécial dans le panneau.
			load: async () => {
				const items = await api.feeds.githubPulls();
				return items.map((item) => {
					const branch = item.meta.find((field) => field.label === "branche")?.value;
					const local = worktrees.some((tree) => tree.branch === branch);
					return {
						...item,
						meta: [...item.meta, { label: t("delivery.localTracking"), value: local ? t("delivery.yes") : t("delivery.no") }],
					};
				});
			},
			detail: (item) => <PullRequestDetail item={item} />,
			actions: (item) => (
				<Button
					onClick={() => {
						const branch = item.meta.find((field) => field.label === "branche")?.value;
						const tree = worktrees.find((candidate) => candidate.branch === branch);
						if (tree) {
							go("worktrees", { worktreePath: tree.path });
						} else {
							notify(t("delivery.noLocalWorktree"));
						}
					}}
				>
					Worktree
				</Button>
			),
		},
		{ id: "actions", label: "CI", load: () => api.feeds.githubRuns() },
		// Une secret key Trigger.dev ne vaut que pour son environnement : chacun
		// devient donc son propre onglet.
		...(config?.triggerEnvironments.length
			? config.triggerEnvironments.map((environment) => ({
					id: `trigger-${environment.name}`,
					label:
						config.triggerEnvironments.length > 1
							? `Trigger · ${environment.name}`
							: "Trigger.dev",
					load: () => api.feeds.trigger(environment.name),
				}))
			: [{ id: "trigger", label: "Trigger.dev", load: () => api.feeds.trigger() }]),
		{ id: "railway", label: "Railway", load: () => api.feeds.railway() },
		{ id: "stripe", label: "Stripe", load: () => api.feeds.stripe() },
	];

	return (
		<>
			<ViewHeader
				title={t("delivery.title")}
				subtitle={config?.githubRepo || "Linear, GitHub, Trigger.dev, Railway, Stripe"}
			/>
			{/* Une seule matière ici : les flux bruts, à plat, avec filtres et
			    recherche. Le travail de l'équipe se lit dans le Daily, où il est
			    rassemblé par personne. */}
			<FeedPanel
				sources={sources}
				pollMs={120_000}
				emptyHint={t("delivery.emptyHint")}
			/>
		</>
	);
}
