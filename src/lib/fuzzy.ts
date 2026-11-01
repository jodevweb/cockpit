/**
 * Retrouver un fichier en tapant un bout de son nom.
 *
 * Le menu ne savait que chercher une suite exacte de lettres dans le chemin
 * entier, rangé par ordre alphabétique : « agentmap » ne trouvait pas
 * `AgentMap.tsx` avant d'avoir fait défiler tous les dossiers en `a`, et
 * « agmap » ne trouvait rien. Ici le nom du fichier compte plus que son
 * dossier, les lettres peuvent sauter, et plusieurs mots se combinent —
 * « panel work » trouve `WorkspacePanel.tsx`.
 */

export interface Match {
	score: number;
	/** Les positions des lettres trouvées dans le chemin, pour les montrer. */
	hits: number[];
}

const BOUNDARY = /[/\-_. ]/;

/** Un mot dans un chemin : d'un bloc si possible, lettres éparses sinon. */
function word(needle: string, path: string, lower: string, nameAt: number): Match | null {
	// D'un bloc dans le nom du fichier : ce qu'on cherche presque toujours.
	const inName = lower.indexOf(needle, nameAt);
	if (inName !== -1) {
		const starts = inName === nameAt || BOUNDARY.test(lower[inName - 1]);
		return {
			score: 1000 + (inName === nameAt ? 400 : starts ? 200 : 0) - (inName - nameAt) - (lower.length - nameAt - needle.length) / 4,
			hits: Array.from({ length: needle.length }, (_, index) => inName + index),
		};
	}
	// D'un bloc ailleurs dans le chemin : un dossier.
	const inPath = lower.indexOf(needle);
	if (inPath !== -1) {
		return {
			score: 500 - inPath / 4,
			hits: Array.from({ length: needle.length }, (_, index) => inPath + index),
		};
	}
	// Lettres dans l'ordre, en commençant le plus près possible du nom.
	const scan = (from: number): Match | null => {
		const hits: number[] = [];
		let score = 100;
		let at = from;
		for (const char of needle) {
			const found = lower.indexOf(char, at);
			if (found === -1) return null;
			const previous = hits[hits.length - 1];
			if (previous !== undefined && found === previous + 1) score += 12;
			else if (found === 0 || BOUNDARY.test(lower[found - 1])) score += 8;
			// Une majuscule au milieu d'un nom ouvre un mot : « am » pour AgentMap.
			else if (path[found] !== lower[found]) score += 8;
			else score -= 2;
			hits.push(found);
			at = found + 1;
		}
		return { score: score + (from === nameAt ? 60 : 0), hits };
	};
	return scan(nameAt) ?? scan(0);
}

/** Le chemin correspond-il à ce qu'on a tapé, et à quel point ? */
export function fuzzy(query: string, path: string, lower = path.toLowerCase()): Match | null {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return null;
	const nameAt = lower.lastIndexOf("/") + 1;
	let score = 0;
	const hits: number[] = [];
	for (const needle of words) {
		const found = word(needle, path, lower, nameAt);
		if (!found) return null;
		score += found.score;
		hits.push(...found.hits);
	}
	return { score, hits };
}
