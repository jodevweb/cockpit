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

/**
 * Un dossier sous une forme qu'on peut comparer.
 *
 * Le CLI note le dossier d'une session avec les séparateurs du système, le
 * cockpit celui d'un worktree avec ceux de la configuration : sous Windows,
 * `D:\jorda\shop-feat-x` et `D:/jorda/shop-feat-x` désignent le même endroit,
 * et la casse du lecteur n'y change rien.
 */
export function folderKey(path: string): string {
	const slashed = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
}

/**
 * Les dossiers où travaillent les agents des missions : le worktree
 * d'intégration de chaque maître, et celui de chaque tâche.
 *
 * Un agent de mission ne s'adresse jamais à toi par sa conversation : ce que la
 * mission attend de toi passe par ses accords et ses tâches en échec. Sa
 * dernière réplique — un rapport rendu, un tour fini — ne veut donc pas dire
 * qu'il t'attend.
 */
export function missionFolders(missions: Mission[], worktrees: Worktree[]): Set<string> {
	const folders = new Set<string>();
	for (const mission of missions) {
		const integration = findIntegrationWorktree(mission, worktrees);
		if (integration) folders.add(folderKey(integration.path));
		for (const task of mission.tasks) {
			if (task.worktree) folders.add(folderKey(task.worktree));
		}
	}
	return folders;
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
