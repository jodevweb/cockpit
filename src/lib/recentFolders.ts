/**
 * Les dossiers où l'on a lancé un agent, du plus récent au plus ancien.
 *
 * L'assistant les connaît en priorité : « lance un agent dans le dossier des
 * notes » vise presque toujours un dossier déjà ouvert une fois, même s'il vit
 * hors du répertoire de projets.
 */

const KEY = "cockpit.recentFolders";
const KEEP = 20;

export function recentFolders(): string[] {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? (JSON.parse(raw) as string[]).filter((path) => typeof path === "string") : [];
	} catch {
		return [];
	}
}

export function rememberFolder(path: string): void {
	if (!path) return;
	try {
		const next = [path, ...recentFolders().filter((known) => known !== path)].slice(0, KEEP);
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		// Stockage indisponible : l'assistant se contentera des autres dossiers.
	}
}
