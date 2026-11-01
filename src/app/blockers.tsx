import { AlertTriangle, Bot, ListChecks, ScanSearch, ShieldQuestion } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { fromSeconds, shortPath } from "@/lib/format";
import { api } from "@/lib/ipc";
import { awaitedDecision, awaitsHuman } from "@/lib/missions";
import { replyDirective } from "@/lib/language";
import type { PullRequest } from "@/lib/types";
import { useAgentGuard, useAgentRuns } from "./agents";
import { movedSince, useReviewFlow, useReviews } from "./review";
import { useAllSessions, useCockpit } from "./store";

/**
 * Ce qui t'attend, partagé par l'écran Aujourd'hui et la carte.
 *
 * Deux écrans qui annoncent « ça t'attend » doivent dire la même chose : la
 * liste vivait dans Aujourd'hui, la carte en a besoin pour son bandeau, et la
 * recopier aurait laissé les deux diverger au premier cas ajouté d'un côté.
 */

/** Une chose qui t'attend, telle que le bandeau de tête la montre. */
export type Blocker = {
	key: string;
	icon: React.ComponentType<{ size?: number; className?: string }>;
	tone: "critical" | "warning" | "accent";
	title: string;
	detail: string;
	meta?: string;
	onClick: () => void;
	/**
	 * Le geste qui lève ce blocage, quand le cockpit sait lequel c'est.
	 *
	 * Voir qu'une CI est rouge depuis trois jours ne la répare pas : il fallait
	 * ouvrir la PR, retrouver le worktree, lancer un agent et lui réexpliquer le
	 * contexte que l'écran avait déjà sous les yeux. Le cockpit sait faire ces
	 * quatre gestes ; il ne les proposait pas.
	 */
	fix?: { label: string; run: () => Promise<unknown> };
};

export function useBlockers(prs: PullRequest[]): Blocker[] {
	const { go, worktrees, missions } = useCockpit();
	const { t } = useTranslation("app");
	const sessions = useAllSessions();
	const { show, runs } = useAgentRuns();
	// Une demande d'autorisation arrête un agent net : c'est le seul cas où la
	// machine attend un clic.
	const { pendingForSession } = useAgentGuard();
	const reviews = useReviews();
	const startReview = useReviewFlow();

	// Une PR relue qui a bougé depuis : l'auteur a poussé des corrections, et
	// c'est à toi de les vérifier. Une revue qui disait « tu peux fusionner »
	// sur le commit actuel, elle, n'attend plus rien.
	const toRecheck = reviews
		.map((review) => ({ review, pr: prs.find((entry) => entry.number === review.number) }))
		.filter(({ review, pr }) => pr && movedSince(review, pr.headSha));

	// Un agent qui a rendu la main est le seul cas où c'est toi qui bloques la
	// machine, et non l'inverse : il passe donc avant tout le reste.
	const waiting = sessions.filter(
		(session) => session.awaitingInput && session.idleSeconds < 24 * 3600,
	);

	const localBranches = useMemo(
		() => new Set(worktrees.map((tree) => tree.branch).filter(Boolean) as string[]),
		[worktrees],
	);
	const ciFailing = prs.filter((pr) => localBranches.has(pr.headRef) && pr.ciState === "failing");

	// Les autorisations en attente, agent par agent : elles passent avant tout le
	// reste, un travail lancé s'y est arrêté.
	const permissions = useMemo(
		() =>
			runs
				.map((run) => ({ run, waiting: pendingForSession(run.sessionId) }))
				.filter((entry) => entry.waiting.length > 0),
		[runs, pendingForSession],
	);

	// Ce qu'une mission attend de toi. Un plan non approuvé est un chantier à
	// l'arrêt : rien ne démarre sans cet accord, et rien ne le disait ici.
	const toApprove = missions.filter(awaitsHuman);
	const failedTasks = missions.flatMap((mission) =>
		mission.tasks
			.filter((task) => task.state === "failed")
			.map((task) => ({ mission, task })),
	);

	// Tout ce qui arrête quelque chose, dans l'ordre où ça coûte : une
	// autorisation gèle un agent en plein travail, un plan non approuvé gèle une
	// mission entière, une tâche en échec a déjà perdu son temps.
	return [
		...permissions.map(({ run, waiting: asks }) => ({
			key: `perm-${run.id}`,
			icon: ShieldQuestion,
			tone: "warning" as const,
			title: t("blockers.permission.title", {
				tool: asks[0]?.tool ?? t("blockers.permission.anAgent"),
				count: asks.length,
			}),
			detail: shortPath(run.cwd, 2),
			meta: t("blockers.permission.meta"),
			onClick: () => show(run.id),
		})),
		...toApprove.map((mission) => ({
			key: `plan-${mission.id}`,
			icon: ListChecks,
			tone: "accent" as const,
			title: mission.title,
			detail: awaitedDecision(mission),
			meta: t("blockers.plan.meta"),
			onClick: () => go("missions", { missionId: mission.id }),
		})),
		...toRecheck.map(({ review, pr }) => ({
			key: `recheck-${review.number}`,
			icon: ScanSearch,
			tone: "accent" as const,
			title: t("blockers.recheck.title", {
				author: review.author || t("blockers.recheck.theAuthor"),
				number: review.number,
			}),
			detail: pr?.title ?? review.title,
			meta: t("blockers.recheck.meta"),
			onClick: () => void startReview(review.number, "verification"),
			fix: { label: t("blockers.recheck.fix"), run: () => startReview(review.number, "verification") },
		})),
		...waiting.map((session) => {
			// Un agent piloté ici se rouvre dans le panneau ; les autres s'ouvrent
			// dans leur timeline.
			const run = runs.find((entry) => entry.cwd === session.cwd);
			return {
				key: `wait-${session.file}`,
				icon: Bot,
				tone: "critical" as const,
				title: session.title,
				detail: session.gitBranch ?? shortPath(session.cwd, 2),
				meta: fromSeconds(session.idleSeconds),
				onClick: () => (run ? show(run.id) : go("agents", { sessionFile: session.file })),
			};
		}),
		...failedTasks.slice(0, 6).map(({ mission, task }) => ({
			key: `fail-${mission.id}-${task.id}`,
			icon: AlertTriangle,
			tone: "critical" as const,
			title: task.title,
			detail: `${mission.title} · ${task.note || t("blockers.failedTask.noReason")}`,
			onClick: () => go("missions"),
			fix: {
				label: t("blockers.failedTask.fix"),
				run: () => api.missions.rerun(mission.id, task.id),
			},
		})),
		...ciFailing.map((pr) => {
			const tree = worktrees.find((entry) => entry.branch === pr.headRef);
			return {
				key: `ci-${pr.number}`,
				icon: AlertTriangle,
				tone: "critical" as const,
				title: pr.title,
				detail: `#${pr.number} · ${pr.headRef}`,
				meta: t("blockers.ci.meta"),
				onClick: () => {
					void api.system.openUrl(pr.url).catch(() => undefined);
				},
				// Sans worktree sorti sur cette branche, il n'y a pas de terrain où
				// lancer quoi que ce soit : on se garde de le proposer plutôt que
				// d'ouvrir un agent dans un dossier au hasard.
				fix: tree
					? {
							label: t("blockers.ci.fix"),
							run: () =>
								api.prompts.launch(
									tree.path,
									`Continuous integration is failing on pull request #${pr.number} ` +
										`(branch ${pr.headRef}). Find which jobs fail, read their ` +
										`logs, identify the real cause rather than the symptom, and ` +
										`fix it. Rerun the affected tests locally before pushing.\n\n` +
										replyDirective(),
								),
						}
					: undefined,
			};
		}),
	];
}
