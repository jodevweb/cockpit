import { withActivity } from "@/lib/activity";
import { api } from "@/lib/ipc";

/**
 * Lancer la création d'un worktree, telle que l'équipe l'a déclarée.
 *
 * Deux écrans le proposent, et ils écrivaient chacun leur commande — l'une
 * jouée par un agent, l'autre par un job, toutes deux propres à une seule
 * équipe. Le cockpit demande maintenant au réglage ce qu'il faut jouer, et ne
 * décide plus que d'une chose : par où le jouer.
 */
export async function startWorktreeCreation(
	branch: string,
	runners: {
		mainRepo: string;
		runJob: (label: string, command: string, cwd: string) => unknown;
		openAgent: (cwd: string, prompt: string) => void;
	},
): Promise<void> {
	const { command, byAgent } = await api.git.worktreeCommand("create", branch);
	if (byAgent) runners.openAgent(runners.mainRepo, command);
	else runners.runJob(`worktree ${branch}`, command, runners.mainRepo);
}

/**
 * Attendre qu'un worktree apparaisse, pour enchaîner sur ce qu'on voulait
 * vraiment en faire.
 *
 * Créer un worktree n'est pas le but : c'est le préalable. Le but est d'y
 * travailler — ouvrir la branche d'un collègue et la relire. Or la création est
 * longue (dépendances, base, bucket) et se fait ailleurs, dans un agent ou un
 * job ; sans ce guet il fallait la surveiller soi-même, puis revenir dans un
 * second écran coller la même branche une deuxième fois.
 *
 * On interroge le pont plutôt que l'état de l'interface : ce guet survit à un
 * changement d'écran, et c'est justement pendant l'attente qu'on va regarder
 * autre chose.
 */
export async function waitForWorktree(
	branch: string,
	options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<string | null> {
	const { intervalMs = 3_000, timeoutMs = 15 * 60_000 } = options;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const trees = await api.worktrees.list();
			const found = trees.find((tree) => tree.branch === branch);
			if (found) return found.path;
		} catch {
			// Le pont peut refuser le temps d'un rafraîchissement de config : on
			// retente au tour suivant plutôt que d'abandonner un guet qui a
			// plusieurs minutes devant lui.
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return null;
}

/**
 * Créer un worktree et attendre qu'il soit prêt, en l'annonçant.
 *
 * La création dure des minutes (dépendances, base, bucket) et se déroulait
 * sans rien dire : on lançait, puis plus rien jusqu'à ce que le workspace
 * s'ouvre — ou pas. Le centre d'activité la montre de bout en bout, et dit
 * pourquoi quand elle n'aboutit pas.
 */
export async function createWorktreeTracked(
	branch: string,
	runners: Parameters<typeof startWorktreeCreation>[1],
	options: { title?: string; onReady?: (path: string) => void } = {},
): Promise<string> {
	return withActivity(
		options.title ?? `Worktree ${branch}`,
		async (activity) => {
			await startWorktreeCreation(branch, runners);
			activity.step("Création en cours — dépendances, base… ça peut prendre quelques minutes.");
			const path = await waitForWorktree(branch);
			if (!path) throw new Error(`Le worktree de ${branch} n'est pas apparu après 15 minutes.`);
			activity.step("Worktree prêt.");
			options.onReady?.(path);
			return path;
		},
		{ firstStep: "Je lance la création du worktree…", result: () => "Worktree prêt, son workspace est ouvert." },
	);
}

/**
 * Une saisie ressemble-t-elle à un nom de branche ?
 *
 * Assez permissif pour accepter ce qu'une équipe nomme (`fix/…`, `NW-3124`,
 * `renovate/lock-file`), assez strict pour ne pas proposer de créer un worktree
 * quand on tape trois lettres en cherchant un dossier déjà ouvert. Les règles
 * viennent de `git check-ref-format` : ce qui est refusé ici le serait aussi
 * par git.
 */
export function looksLikeBranch(value: string): boolean {
	const name = value.trim();
	if (name.length < 3) return false;
	// Espaces, `~^:?*[`, `..` et `@{` : git les refuse dans un nom de référence.
	if (/[\s~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{")) return false;
	if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".lock")) return false;
	return true;
}
