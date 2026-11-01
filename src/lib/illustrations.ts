import type { Turn } from "@/app/agents";
import { t } from "@/i18n";
import { lazyLabels } from "@/lib/language";

/**
 * Les images qu'un agent décrit en données, et que le cockpit dessine.
 *
 * Un schéma Mermaid laissé au libre choix de l'agent ne venait presque jamais :
 * 24 conclusions sur 592 en octobre 2026, et toutes de la même forme — un graphe
 * de boîtes, qu'il s'agisse d'un bug, d'une migration ou d'une optimisation. Un
 * outil à genres (`mcp__cockpit__illustrer`, voir `permissions.rs`) lui fait
 * choisir la forme qui répond à ce qu'il a fait, et lui fait fournir des
 * données plutôt qu'un dessin : le rendu, lui, reste le même d'un agent à
 * l'autre, aux couleurs de l'app.
 *
 * Chaque image dit d'où elle vient (`source`) : une barre mesurée par une
 * commande et une barre estimée par l'agent ne se lisent pas de la même façon,
 * et c'est la règle que le cockpit tient déjà pour ses schémas.
 */

export const ILLUSTRATE_TOOL = "mcp__cockpit__illustrer";

export type Source = "mesure" | "depot" | "capture" | "agent";

interface Base {
	/** L'appel d'où vient l'image : sa clé, et de quoi le rouvrir. */
	key: string;
	titre: string;
	source: Source;
}

export interface Frise extends Base {
	genre: "frise";
	etapes: Array<{ label: string; detail: string; etat: "ok" | "casse" | "neutre" }>;
}

export interface Graphe {
	noeuds: string[];
	liens: Array<[string, string]>;
}

export interface AvantApres extends Base {
	genre: "avant_apres";
	avant: Graphe;
	apres: Graphe;
}

export interface Mesure extends Base {
	genre: "mesure";
	unite: string;
	commande: string;
	/** Une unité par ligne l'emporte sur celle de l'image : on mesure souvent un temps et un poids. */
	mesures: Array<{ label: string; avant: number; apres: number; unite: string }>;
}

export interface Table extends Base {
	genre: "table";
	table: string;
	colonnes: Array<{ nom: string; type: string; changement: "ajout" | "retrait" | "modif" | "garde" }>;
}

export interface Capture extends Base {
	genre: "capture";
	image: string;
	reperes: Array<{ x: number; y: number; texte: string }>;
}

export interface Matrice extends Base {
	genre: "matrice";
	options: string[];
	criteres: Array<{ nom: string; valeurs: string[]; bons: Array<boolean | null> }>;
}

export type Illustration = Frise | AvantApres | Mesure | Table | Capture | Matrice;

const SOURCES: Source[] = ["mesure", "depot", "capture", "agent"];

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

/** Une fraction de l'image, bornée : un repère hors cadre ne se verrait pas. */
function fraction(value: unknown): number | null {
	const found = number(value);
	if (found === null) return null;
	// Un agent qui donne des pourcentages (« 40 ») au lieu de fractions : on
	// le comprend plutôt que de poser le repère hors de l'image.
	const scaled = found > 1 && found <= 100 ? found / 100 : found;
	return Math.min(1, Math.max(0, scaled));
}

function graphe(value: unknown): Graphe {
	const raw = record(value);
	const noeuds = list(raw.noeuds).map(text).filter(Boolean);
	const liens = list(raw.liens)
		.map((lien) => list(lien).map(text))
		.filter((lien): lien is [string, string] => lien.length === 2 && !!lien[0] && !!lien[1]);
	// Un lien vers un nœud qu'on n'a pas déclaré le déclare : l'agent l'a nommé,
	// il existe.
	for (const [de, vers] of liens) {
		if (!noeuds.includes(de)) noeuds.push(de);
		if (!noeuds.includes(vers)) noeuds.push(vers);
	}
	return { noeuds, liens };
}

/**
 * Lit un appel de l'outil. `null` quand il ne dessinerait rien : le pont l'a
 * déjà refusé, et l'agent l'a appris à ce moment-là.
 */
export function readIllustration(input: Record<string, unknown>, key: string): Illustration | null {
	const titre = text(input.titre);
	const source = SOURCES.includes(input.source as Source) ? (input.source as Source) : "agent";
	const base = { key, titre, source };
	switch (input.genre) {
		case "frise": {
			const etapes = list(input.etapes)
				.map(record)
				.map((etape) => ({
					label: text(etape.label),
					detail: text(etape.detail),
					etat: etape.etat === "casse" ? "casse" : etape.etat === "ok" ? "ok" : "neutre",
				}))
				.filter((etape) => etape.label) as Frise["etapes"];
			return etapes.length > 0 ? { ...base, genre: "frise", etapes } : null;
		}
		case "avant_apres": {
			const avant = graphe(input.avant);
			const apres = graphe(input.apres);
			return avant.noeuds.length > 0 && apres.noeuds.length > 0 ? { ...base, genre: "avant_apres", avant, apres } : null;
		}
		case "mesure": {
			const mesures = list(input.mesures)
				.map(record)
				.map((mesure) => ({
					label: text(mesure.label),
					avant: number(mesure.avant),
					apres: number(mesure.apres),
					unite: text(mesure.unite),
				}))
				.filter((mesure): mesure is Mesure["mesures"][number] => !!mesure.label && mesure.avant !== null && mesure.apres !== null);
			return mesures.length > 0
				? { ...base, genre: "mesure", unite: text(input.unite), commande: text(input.commande), mesures }
				: null;
		}
		case "table": {
			const colonnes = list(input.colonnes)
				.map(record)
				.map((colonne) => ({
					nom: text(colonne.nom),
					type: text(colonne.type),
					changement: (["ajout", "retrait", "modif"] as const).find((value) => value === colonne.changement) ?? "garde",
				}))
				.filter((colonne) => colonne.nom) as Table["colonnes"];
			return colonnes.length > 0 ? { ...base, genre: "table", table: text(input.table), colonnes } : null;
		}
		case "capture": {
			const image = text(input.image);
			if (!image) return null;
			const reperes = list(input.reperes)
				.map(record)
				.map((repere) => ({ x: fraction(repere.x), y: fraction(repere.y), texte: text(repere.texte) }))
				.filter((repere): repere is Capture["reperes"][number] => repere.x !== null && repere.y !== null && !!repere.texte);
			return { ...base, genre: "capture", image, reperes };
		}
		case "matrice": {
			const options = list(input.options).map(text).filter(Boolean);
			const criteres = list(input.criteres)
				.map(record)
				.map((critere) => ({
					nom: text(critere.nom),
					valeurs: options.map((_, index) => text(list(critere.valeurs)[index])),
					bons: options.map((_, index) => {
						const bon = list(critere.bons)[index];
						return typeof bon === "boolean" ? bon : null;
					}),
				}))
				.filter((critere) => critere.nom);
			return options.length > 0 && criteres.length > 0 ? { ...base, genre: "matrice", options, criteres } : null;
		}
		default:
			return null;
	}
}

/**
 * Les illustrations d'un fil, dans l'ordre — sous-agents compris, qui font
 * souvent la recette et donc les captures.
 *
 * Mises en cache sur la liste elle-même : le fil est remplacé à chaque message,
 * jamais muté, et chaque événement de chaque agent redessine les vues.
 */
const cache = new WeakMap<Turn[], Illustration[]>();

export function illustrationsOf(turns: Turn[]): Illustration[] {
	const known = cache.get(turns);
	if (known) return known;
	const found: Illustration[] = [];
	const visit = (entries: Turn[]) => {
		for (const turn of entries) {
			if (turn.kind !== "tool") continue;
			if (turn.sub) visit(turn.sub);
			if (turn.tool !== ILLUSTRATE_TOOL || turn.outputError || !turn.input) continue;
			const item = readIllustration(turn.input, turn.toolId ?? `${turn.at ?? found.length}`);
			if (item) found.push(item);
		}
	};
	visit(turns);
	cache.set(turns, found);
	return found;
}

export const SOURCE_LABELS: Record<Source, string> = lazyLabels(
	["mesure", "depot", "capture", "agent"] as const,
	(source) => t(`lib:illustrations.source.${source}`),
);
