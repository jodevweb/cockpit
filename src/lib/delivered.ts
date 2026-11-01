import type { Turn } from "@/app/agents";
import { commandOf, kindOf, pathOf, type Episode } from "@/lib/episodes";
import { mediaOfPath, type Media } from "@/lib/media";
import { joinPath } from "@/lib/paths";

/**
 * Ce qu'un épisode a livré : la question qu'on se pose en revenant vers un
 * agent, « et où est le résultat ? ».
 *
 * Sa conclusion est du texte, et il n'y cite pas toujours sa PR. Ce qui fait
 * foi, ce sont les sorties de commandes : l'adresse que `gh pr create` rend,
 * la ligne qu'écrit `git commit`, la branche que `git push` annonce. On n'en
 * devine rien d'autre.
 */

export interface Delivered {
	/** Les demandes de fusion ouvertes ou citées, dans l'ordre d'apparition. */
	reviews: Array<{ url: string; label: string }>;
	commits: Array<{ sha: string; message: string; branch: string }>;
	/** Les branches poussées. */
	pushed: string[];
	/** Les images et PDF produits : écrits par l'agent, ou cités dans sa conclusion. */
	media: Media[];
	turns: Turn[];
}

// GitHub (`/pull/12`) et GitLab (`/-/merge_requests/12`), où qu'ils soient hébergés.
const REVIEW = /https?:\/\/[^\s)<>"'`]+?\/(?:pull|-\/merge_requests)\/(\d+)\b/g;
// `[main 3f2a1bc] message`, `[feat/x (root-commit) 3f2a1bc] message`
const COMMIT = /^\[([^\s\]]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/gm;
// `   3f2a1bc..9e8d7f6  feat/x -> feat/x`, `* [new branch]      feat/x -> feat/x`,
// `+ 3f2a1bc...9e8d7f6 feat/x -> feat/x (forced update)`
const PUSHED = /^\s*(?:\*|\+|[0-9a-f]{7,}\.\.\.?[0-9a-f]{7,}|\[new branch\])\s+.*?->\s+(\S+)(?:\s+\(.*\))?\s*$/gm;
// Un chemin absolu vers une image ou un PDF, tel qu'un agent l'écrit en conclusion.
// `C:\…` et `dossier\fichier` aussi : un agent sous Windows cite ses chemins ainsi.
const MEDIA_PATH = /(?:^|[\s(`"'])((?:[A-Za-z]:[\\/]|\/|\.{0,2}[\\/]?[\w.@+-]+[\\/])[^\s`"')]*\.(?:pdf|png|jpe?g|gif|webp|svg|mp4|m4v|mov|webm))\b/gi;

function textOf(turn: Turn): string {
	return typeof turn.output === "string" ? turn.output : "";
}

export function delivered(episode: Episode, answer: Turn | null, cwd: string): Delivered {
	const found: Delivered = { reviews: [], commits: [], pushed: [], media: [], turns: [] };
	const reviews = new Map<string, string>();
	const media = new Map<string, Media>();

	for (const turn of episode.turns) {
		if (turn.kind !== "tool" || turn.outputError) continue;
		const output = textOf(turn);
		let useful = false;

		for (const match of output.matchAll(REVIEW)) {
			reviews.set(match[0], `#${match[1]}`);
			useful = true;
		}
		if (kindOf(turn) === "run") {
			const command = commandOf(turn);
			if (/\bgit\b.*\bcommit\b/.test(command)) {
				for (const match of output.matchAll(COMMIT)) {
					found.commits.push({ branch: match[1], sha: match[2].slice(0, 7), message: match[3] });
					useful = true;
				}
			}
			if (/\bgit\b.*\bpush\b/.test(command)) {
				for (const match of output.matchAll(PUSHED)) {
					if (!found.pushed.includes(match[1])) found.pushed.push(match[1]);
					useful = true;
				}
			}
		}
		if (kindOf(turn) === "edit" && turn.tool === "Write") {
			const item = mediaOfPath(pathOf(turn));
			if (item) {
				media.set(item.key, item);
				useful = true;
			}
		}
		if (useful) found.turns.push(turn);
	}

	// La conclusion cite volontiers ce qu'elle a produit par un autre moyen —
	// une capture prise par un script, un PDF exporté : on le montre, et une
	// vignette qui ne se charge pas dira simplement que le fichier n'est plus là.
	if (answer) {
		for (const match of answer.text.matchAll(REVIEW)) reviews.set(match[0], `#${match[1]}`);
		for (const match of answer.text.matchAll(MEDIA_PATH)) {
			// Un agent cite ses fichiers relativement à son dossier de travail :
			// « Vidéo : .claude/work/demo/demo.mp4 ».
			const cited = joinPath(cwd, match[1]);
			const item = mediaOfPath(cited);
			if (item) media.set(item.key, item);
		}
	}

	found.reviews = [...reviews].map(([url, label]) => ({ url, label }));
	found.media = [...media.values()];
	return found;
}

export function isEmpty(result: Delivered): boolean {
	return (
		result.reviews.length === 0 &&
		result.commits.length === 0 &&
		result.pushed.length === 0 &&
		result.media.length === 0
	);
}
