import type { Turn } from "@/app/agents";
import { isImagePath } from "@/components/LocalImage";
import type { Episode } from "@/lib/episodes";
import { basename } from "@/lib/paths";

/**
 * Ce qu'une conversation donne à voir plutôt qu'à lire : captures, images,
 * PDF.
 *
 * La carte résumait « 6 fichiers parcourus » là où l'agent venait de prendre
 * trois captures de l'écran qu'il corrigeait. On relève donc ce qui se
 * regarde, d'où qu'il vienne — tes pièces jointes, les images qu'un outil a
 * renvoyées, les fichiers visuels qu'il a lus — pour le montrer en vignettes.
 */

export interface Media {
	key: string;
	kind: "image" | "pdf" | "video";
	/** Un fichier du poste, relu à l'affichage. */
	path?: string;
	/** Une image renvoyée par un outil, gardée en mémoire. */
	src?: string;
	label: string;
}

/**
 * « avant » ou « après », lu dans le nom du fichier : c'est ainsi que la
 * consigne de rendu demande à l'agent de nommer ses captures.
 */
export function stageOf(media: Media): "avant" | "après" | null {
	if (/^(avant|before)\b/i.test(media.label)) return "avant";
	if (/^(apr[eè]s|after)\b/i.test(media.label)) return "après";
	return null;
}

export function isPdfPath(path: string): boolean {
	return /\.pdf$/i.test(path);
}

/** Ce que le webview sait lire : une démo filmée par un agent, typiquement. */
export function isVideoPath(path: string): boolean {
	return /\.(mp4|m4v|mov|webm)$/i.test(path);
}

export function mediaOfPath(path: string): Media | null {
	if (isPdfPath(path)) return { key: path, kind: "pdf", path, label: basename(path) };
	if (isVideoPath(path)) return { key: path, kind: "video", path, label: basename(path) };
	if (isImagePath(path)) return { key: path, kind: "image", path, label: basename(path) };
	return null;
}

/**
 * Ce qu'un message contient de pièces jointes, et ce qu'il reste à lire.
 *
 * Le manifeste est écrit par le cockpit lui-même juste avant l'envoi : ses
 * lignes sont donc reconnaissables, et on peut les rendre pour ce qu'elles
 * sont — une image, un fichier — au lieu de laisser un chemin absolu au milieu
 * du texte. Ce qui n'en vient pas est laissé strictement intact : un message
 * qui parle de fichiers ne doit pas se faire réécrire.
 */
/** L'en-tête du manifeste de pièces jointes, tel que le cockpit l'écrit dans la consigne. */
export const ATTACHMENTS_HEADER = "Attached files, read them before replying:";
const ATTACHMENTS_PATTERN = /Attached files?, read (?:them|it) before replying:|Fichiers? joints?, à lire avant de répondre :/;

export function splitAttachments(text: string): { text: string; paths: string[] } {
	// Le manifeste s'écrit en anglais (`ATTACHMENTS_HEADER`) ; les anciens
	// messages enregistrés le portent encore en français.
	const found = ATTACHMENTS_PATTERN.exec(text);
	if (!found) return { text, paths: [] };
	const marque = found.index;
	const lignes = text.slice(marque).split("\n");
	const paths: string[] = [];
	let fin = marque;
	for (const [index, ligne] of lignes.entries()) {
		if (index === 0) continue;
		const chemin = ligne.startsWith("- ") ? ligne.slice(2).trim() : "";
		if (!chemin) break;
		paths.push(chemin);
		fin = marque + lignes.slice(0, index + 1).join("\n").length;
	}
	if (paths.length === 0) return { text, paths: [] };
	return { text: (text.slice(0, marque) + text.slice(fin)).trim(), paths };
}

/** Ce que tu as joint à ta consigne et qui se regarde. */
export function attachedMedia(ask: Turn | null): Media[] {
	if (!ask) return [];
	return splitAttachments(ask.text)
		.paths.map(mediaOfPath)
		.filter((media): media is Media => media !== null);
}

/**
 * Ce que l'agent a eu sous les yeux pendant l'épisode, le plus récent d'abord.
 *
 * Sous-agents compris : c'est souvent à eux qu'on confie la recette dans le
 * navigateur, et donc les captures.
 */
export function seenMedia(episode: Episode): Media[] {
	const found = new Map<string, Media>();
	const visit = (turns: Turn[]) => {
		for (const turn of turns) {
			if (turn.kind !== "tool") continue;
			if (turn.sub) visit(turn.sub);
			(turn.outputImages ?? []).forEach((src, index) => {
				const key = `${turn.toolId ?? turn.at ?? ""}#${index}`;
				found.set(key, { key, kind: "image", src, label: "capture" });
			});
			const path = turn.input?.file_path;
			if (turn.tool === "Read" && typeof path === "string" && !turn.outputError) {
				const media = mediaOfPath(path);
				// Une image lue arrive aussi en `outputImages` quand le fichier
				// n'est plus relisible ; sinon, c'est son chemin qui fait foi.
				if (media && !(turn.outputImages && turn.outputImages.length > 0)) {
					found.delete(path);
					found.set(path, media);
				}
			}
		}
	};
	visit(episode.turns);
	return [...found.values()].reverse();
}
