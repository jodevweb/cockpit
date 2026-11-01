import { t } from "@/i18n";
import type { FileChange, TourChanges } from "@/lib/types";

/**
 * Le constat : ce que le dépôt dit du travail d'un agent, dessiné.
 *
 * Sa conclusion est un récit — « j'ai supprimé la fonctionnalité, enlevé le
 * code mort du front et du back ». Le constat ne lui demande rien : il vient
 * de `git diff`, rangé par zones du dépôt. S'il a oublié un fichier, ou touché
 * une zone dont il ne parle pas, ça se voit ici et nulle part dans son texte.
 */

export type Fate = "deleted" | "created" | "modified";

export interface Tile {
	path: string;
	name: string;
	fate: Fate;
	added: number;
	removed: number;
}

export interface Zone {
	/** Le dossier qui la désigne, relatif à la racine du dépôt. */
	name: string;
	tiles: Tile[];
	added: number;
	removed: number;
}

export interface Footprint {
	root: string;
	/** « depuis dev » : ce que le constat compare, dit tel que git le sait. */
	baseLabel: string;
	zones: Zone[];
	deleted: number;
	created: number;
	modified: number;
	additions: number;
	deletions: number;
}

/** Au-delà, les zones les plus légères se rangent ensemble. */
const MAX_ZONES = 4;
const ROOT = "racine";
const ELSEWHERE = "ailleurs";

function fateOf(state: string): Fate {
	if (state === "deleted") return "deleted";
	if (state === "added" || state === "untracked") return "created";
	return "modified";
}

/** Les dossiers d'un chemin, sans le nom du fichier. */
function folders(path: string): string[] {
	return path.split("/").filter(Boolean).slice(0, -1);
}

/**
 * La profondeur à laquelle le changement se sépare en zones.
 *
 * Rien n'est supposé de la forme du dépôt : dans un monorepo tout vit sous
 * `apps/`, et c'est au niveau d'en dessous que le front se distingue du back.
 * On descend donc jusqu'au premier niveau où les fichiers ne sont plus tous
 * ensemble.
 */
function depthOf(files: FileChange[]): number {
	// Un lockfile posé à la racine ne fait pas une zone à lui seul : sans cet
	// écart, tout le reste se rangeait sous `apps` et le dessin ne séparait rien.
	const nested = files.filter((file) => folders(file.path).length > 0);
	for (let depth = 1; depth <= 3; depth++) {
		const names = new Set(nested.map((file) => folders(file.path).slice(0, depth).join("/")));
		if (names.size > 1) return depth;
	}
	return 3;
}

export function footprint(changes: TourChanges): Footprint | null {
	if (changes.files.length === 0) return null;
	const depth = depthOf(changes.files);
	const zones = new Map<string, Zone>();
	for (const file of changes.files) {
		const name = folders(file.path).slice(0, depth).join("/") || ROOT;
		const zone = zones.get(name) ?? { name, tiles: [], added: 0, removed: 0 };
		zone.tiles.push({
			path: file.path,
			name: file.path.split("/").pop() ?? file.path,
			fate: fateOf(file.state),
			added: file.added,
			removed: file.removed,
		});
		zone.added += file.added;
		zone.removed += file.removed;
		zones.set(name, zone);
	}

	const weight = (zone: Zone) => zone.added + zone.removed;
	const ranked = [...zones.values()].sort((a, b) => weight(b) - weight(a));
	const kept = ranked.length > MAX_ZONES ? ranked.slice(0, MAX_ZONES - 1) : ranked;
	const rest = ranked.slice(kept.length);
	if (rest.length > 0) {
		kept.push({
			name: ELSEWHERE,
			tiles: rest.flatMap((zone) => zone.tiles),
			added: rest.reduce((sum, zone) => sum + zone.added, 0),
			removed: rest.reduce((sum, zone) => sum + zone.removed, 0),
		});
	}
	// Dans une zone, ce qui pèse le plus d'abord : c'est ce qu'on vient vérifier.
	for (const zone of kept) zone.tiles.sort((a, b) => b.added + b.removed - (a.added + a.removed));

	const count = (fate: Fate) => changes.files.filter((file) => fateOf(file.state) === fate).length;
	return {
		root: changes.root,
		baseLabel: changes.baseLabel,
		zones: kept,
		deleted: count("deleted"),
		created: count("created"),
		modified: count("modified"),
		additions: changes.additions,
		deletions: changes.deletions,
	};
}

/** « 12 supprimés · 1 créé · 3 modifiés » — le plus radical en premier. */
export function headline(print: Footprint): string {
	const say = (count: number, key: string) => (count > 0 ? t(`lib:footprint.${key}`, { count }) : null);
	return [say(print.deleted, "deleted"), say(print.created, "created"), say(print.modified, "modified")]
		.filter(Boolean)
		.join(" · ");
}

/**
 * La largeur d'une tuile, en pixels : elle grandit avec le volume, mais en
 * racine — un lockfile de trois mille lignes ne doit pas écraser le reste.
 */
export function tileWidth(tile: Tile, unit = 2.4, max = 72): number {
	return Math.round(Math.min(max, Math.max(7, Math.sqrt(tile.added + tile.removed) * unit)));
}
