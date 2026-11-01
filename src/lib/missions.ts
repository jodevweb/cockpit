import { t } from "@/i18n";
import { lazyLabels } from "@/lib/language";
import type { Mission, Worktree } from "@/lib/types";

/**
 * Le worktree de la branche d'intégration d'une mission — celui où le maître
 * recompose, jamais `mission.cwd` qui est le dépôt principal. Deux endroits
 * calculaient cette même formule séparément (`WorkspacePanel.useWorkGroups`
 * et le bouton « Suivre » de `MissionsView`), et l'un des deux a régressé une
 * fois en 0.50.2 : voir mémoire `audit-missions-trouvailles`.
 */
export function findIntegrationWorktree(
	mission: Mission,
	worktrees: Worktree[],
): Worktree | undefined {
	return mission.branch
		? worktrees.find((tree) => tree.branch === mission.branch)
		: undefined;
}

/** Comme `findIntegrationWorktree`, avec repli sur `mission.cwd` quand la
 *  branche d'intégration n'a pas encore de worktree. */
export function resolveMasterCwd(mission: Mission, worktrees: Worktree[]): string {
	return findIntegrationWorktree(mission, worktrees)?.path ?? mission.cwd;
}

/** Un humain doit décider avant que la mission ne reparte. */
export function awaitsHuman(mission: Mission): boolean {
	return ["awaitingUnderstanding", "awaitingApproach", "awaitingApproval"].includes(mission.state);
}

/** Ce qu'une mission en attente demande, en quelques mots. */
export function awaitedDecision(mission: Mission): string {
	switch (mission.state) {
		case "awaitingUnderstanding":
			return t("lib:missions.awaited.understanding");
		case "awaitingApproach":
			return t("lib:missions.awaited.approach");
		default:
			return t("lib:missions.awaited.approval", { count: mission.tasks.length });
	}
}

/** L'état d'une mission, dit en deux mots. */
export const MISSION_STATE_LABELS: Record<Mission["state"], string> = lazyLabels(
	[
		"understanding",
		"awaitingUnderstanding",
		"approaching",
		"awaitingApproach",
		"planning",
		"awaitingApproval",
		"running",
		"integrating",
		"done",
		"failed",
	] as const,
	(state) => t(`lib:missions.state.${state}`),
);
