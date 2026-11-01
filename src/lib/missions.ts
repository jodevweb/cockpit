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
			return "le maître a lu le ticket · relis ce qu'il a compris";
		case "awaitingApproach":
			return "une approche attend ton accord";
		default:
			return `${mission.tasks.length} tâche${mission.tasks.length > 1 ? "s" : ""} · rien ne démarre avant ton accord`;
	}
}

/** L'état d'une mission, dit en deux mots. */
export const MISSION_STATE_LABELS: Record<Mission["state"], string> = {
	understanding: "lecture du ticket",
	awaitingUnderstanding: "compréhension à valider",
	approaching: "approche",
	awaitingApproach: "approche à valider",
	planning: "découpage",
	awaitingApproval: "attend ton accord",
	running: "en cours",
	integrating: "intégration",
	done: "close",
	failed: "arrêtée",
};
