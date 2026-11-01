/**
 * Une consigne tapée demande-t-elle la revue d'une PR ?
 *
 * Écrire « occupe-toi de la code review de cette PR » dans le champ d'un agent
 * lançait un agent ordinaire : il relisait, mais sans l'outil de remise — pas
 * de carte de revue, pas de tour suivi, et la vue de branche restait sur « pas
 * encore relue » alors qu'on venait de le demander. La consigne passe donc par
 * le geste « Relire », le même que le bouton.
 *
 * Volontairement étroit : se tromper ici retire l'écriture à un agent à qui on
 * demandait de corriger. Il faut une PR nommée par son numéro (une seule), le
 * mot de la revue, et aucun verbe qui demande de toucher au code.
 */
const REVIEW = /(?:^|[^\p{L}])(?:code[- ]?review|review(?:er|e|es|ez)?|revue|relis|relire|relecture)(?![\p{L}])/iu;

/** Corriger, appliquer, répondre, fusionner : ce n'est plus relire. */
const ACTS =
	/(?:^|[^\p{L}])(?:corrig|fix|appliqu|adress|trait|r[ée]pond|r[ée]sou|impl[ée]ment|merge|fusionn|pousse|commit)\p{L}*/iu;

const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi;
const PR_WORD = /(?:^|[^\p{L}])(?:PR|MR|pull[ -]?request)\s*(?:n°\s*|#)?(\d+)/giu;

export function reviewIntent(text: string, repo?: string | null): { number: number } | null {
	const consigne = text.trim();
	// Une commande « / » sait ce qu'elle fait : on ne la détourne pas.
	if (!consigne || consigne.startsWith("/")) return null;
	if (!REVIEW.test(consigne) || ACTS.test(consigne)) return null;

	const numbers = new Set<number>();
	for (const found of consigne.matchAll(PR_URL)) {
		// La PR d'un autre dépôt n'est pas de celles que le geste sait relire.
		if (repo && found[1].toLowerCase() !== repo.trim().toLowerCase()) return null;
		numbers.add(Number(found[2]));
	}
	for (const found of consigne.matchAll(PR_WORD)) numbers.add(Number(found[1]));
	if (numbers.size !== 1) return null;
	const [number] = numbers;
	return Number.isSafeInteger(number) && number > 0 ? { number } : null;
}
