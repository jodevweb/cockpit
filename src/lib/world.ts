/**
 * Le monde de la carte : des îles par projet, et dans l'île du projet ouvert,
 * le travail rangé dans le sens où il avance.
 *
 * Rien ici ne va chercher de données ni ne dessine : on reçoit des cartes déjà
 * classées, on leur donne une place, et on dit lesquelles se suivent. C'est ce
 * qui permet de vérifier le rangement sans écran, et de garder la vue libre de
 * tout calcul de coordonnées.
 */

export type RegionId = "arrive" | "encours" | "livrer" | "prod";

export const REGIONS: Array<{ id: RegionId; label: string; hint: string; columns: number }> = [
	{ id: "arrive", label: "Arrive", hint: "à trier", columns: 1 },
	{ id: "encours", label: "En cours", hint: "tu gardes la main ou tu délègues", columns: 2 },
	{ id: "livrer", label: "Livrer", hint: "relire et fusionner", columns: 1 },
	{ id: "prod", label: "En prod", hint: "ce que ça change", columns: 1 },
];

export type CardKind =
	| "ticket"
	| "sentry"
	| "mission"
	| "chantier"
	| "pr"
	| "deploy"
	| "monitor"
	| "more";

/**
 * La hauteur de chaque sorte de carte, fixée d'avance.
 *
 * Une carte mesurée après coup déplacerait toutes celles de dessous à son
 * arrivée : la carte sauterait à chaque rafraîchissement. Une hauteur fixe
 * par sorte garde chaque carte à sa place, et son contenu s'y range.
 */
export const CARD_HEIGHT: Record<CardKind, number> = {
	ticket: 116,
	sentry: 100,
	mission: 150,
	chantier: 168,
	pr: 122,
	deploy: 84,
	monitor: 84,
	more: 52,
};

export const CARD_WIDTH = 300;
const GAP = 14;
const REGION_PAD = 18;
const REGION_HEADER = 46;
const REGION_GAP = 28;
const ISLAND_PAD = 36;
const ISLAND_HEADER = 70;
const ISLAND_GAP = 140;
/** Une île qu'on n'a pas ouverte : son résumé, sans le détail. */
const COMPACT_WIDTH = 560;
const COMPACT_HEIGHT = 440;

export interface WorldCard<T = unknown> {
	id: string;
	kind: CardKind;
	region: RegionId;
	data: T;
}

export interface IslandInput<T = unknown> {
	id: string;
	name: string;
	/** Le projet ouvert : le seul dont on dessine le détail. */
	open: boolean;
	cards: Array<WorldCard<T>>;
}

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Placed<T = unknown> {
	islands: Array<{ id: string; name: string; open: boolean; box: Box }>;
	regions: Array<{ island: string; id: RegionId; label: string; hint: string; box: Box; count: number }>;
	cards: Array<WorldCard<T> & { island: string; box: Box }>;
	bounds: Box;
}

/**
 * Donne une place à chaque île, chaque région et chaque carte.
 *
 * Les régions d'une île partagent une même hauteur — celle de la plus remplie :
 * des colonnes de hauteurs inégales se liraient comme des niveaux différents.
 */
export function place<T>(islands: Array<IslandInput<T>>): Placed<T> {
	const out: Placed<T> = { islands: [], regions: [], cards: [], bounds: { x: 0, y: 0, w: 0, h: 0 } };
	let cursor = 0;

	for (const island of islands) {
		if (!island.open) {
			const box = { x: cursor, y: 0, w: COMPACT_WIDTH, h: COMPACT_HEIGHT };
			out.islands.push({ id: island.id, name: island.name, open: false, box });
			cursor += COMPACT_WIDTH + ISLAND_GAP;
			continue;
		}

		// Chaque région en colonnes : les cartes s'y répartissent à tour de rôle
		// dans la colonne la moins haute.
		const columns = REGIONS.map((region) => {
			const heights = new Array(region.columns).fill(0) as number[];
			const slots: Array<{ card: WorldCard<T>; column: number; y: number }> = [];
			for (const card of island.cards.filter((entry) => entry.region === region.id)) {
				const column = heights.indexOf(Math.min(...heights));
				slots.push({ card, column, y: heights[column] });
				heights[column] += CARD_HEIGHT[card.kind] + GAP;
			}
			return { region, slots, height: Math.max(0, ...heights) - GAP };
		});
		const inner = Math.max(240, ...columns.map((column) => column.height));
		const regionHeight = REGION_HEADER + inner + REGION_PAD;

		let x = cursor + ISLAND_PAD;
		const y = ISLAND_HEADER;
		for (const { region, slots } of columns) {
			const width = region.columns * CARD_WIDTH + (region.columns - 1) * GAP + REGION_PAD * 2;
			const box = { x, y, w: width, h: regionHeight };
			out.regions.push({
				island: island.id,
				id: region.id,
				label: region.label,
				hint: region.hint,
				box,
				count: slots.filter((slot) => slot.card.kind !== "more").length,
			});
			for (const slot of slots) {
				out.cards.push({
					...slot.card,
					island: island.id,
					box: {
						x: x + REGION_PAD + slot.column * (CARD_WIDTH + GAP),
						y: y + REGION_HEADER + slot.y,
						w: CARD_WIDTH,
						h: CARD_HEIGHT[slot.card.kind],
					},
				});
			}
			x += width + REGION_GAP;
		}
		const width = x - REGION_GAP + ISLAND_PAD - cursor;
		const box = { x: cursor, y: 0, w: width, h: ISLAND_HEADER + regionHeight + ISLAND_PAD };
		out.islands.push({ id: island.id, name: island.name, open: true, box });
		cursor += width + ISLAND_GAP;
	}

	const tallest = Math.max(COMPACT_HEIGHT, ...out.islands.map((island) => island.box.h));
	// Les îles repliées se posent à mi-hauteur de la plus haute : alignées en
	// haut, elles laissaient un grand vide dessous qui se lisait comme une erreur.
	for (const island of out.islands) {
		if (!island.open) island.box.y = Math.round((tallest - island.box.h) / 2);
	}
	out.bounds = { x: 0, y: 0, w: Math.max(0, cursor - ISLAND_GAP), h: tallest };
	return out;
}

/** Ce qu'une carte dit d'elle-même pour qu'on la relie : ses identifiants. */
export interface LinkKeys {
	/** Tickets qu'elle porte ou mentionne, en majuscules (`NW-3044`). */
	tickets: string[];
	/** Branches qu'elle occupe. */
	branches: string[];
	/** La mission dont elle relève, ou qu'elle est. */
	mission?: string;
	/** L'adresse d'une PR, pour une mission qui l'a ouverte. */
	prUrl?: string;
	url?: string;
}

const TICKET = /\b([a-z][a-z0-9]{1,9})-(\d{1,6})\b/gi;

/**
 * Les identifiants de tickets qu'on lit dans un nom de branche ou un titre.
 *
 * Seulement sous un préfixe connu : `topic-2-nw-3002` contient aussi
 * `topic-2`, qui a la forme d'un ticket sans en être un.
 */
export function ticketsIn(text: string, prefixes: ReadonlySet<string>): string[] {
	return [...text.matchAll(TICKET)]
		.filter((match) => prefixes.has(match[1].toUpperCase()))
		.map((match) => `${match[1]}-${match[2]}`.toUpperCase());
}

export interface Link {
	source: string;
	target: string;
}

const ORDER: Record<RegionId, number> = { arrive: 0, encours: 1, livrer: 2, prod: 3 };

/**
 * Les fils entre cartes, toujours dans le sens du travail.
 *
 * Deux cartes se relient quand elles partagent un identifiant sûr : un ticket
 * nommé des deux côtés, une branche, une mission, l'adresse d'une PR. On ne
 * relie pas sur une ressemblance de titre — un fil faux ferait plus de tort
 * qu'un fil absent. Un ticket repris par une mission ne se relie qu'à elle,
 * pas en plus à chacun de ses chantiers : la mission porte déjà ce lien.
 */
export function links(cards: Array<{ id: string; kind: CardKind; region: RegionId; keys: LinkKeys }>): Link[] {
	const out: Link[] = [];
	const seen = new Set<string>();
	const add = (a: (typeof cards)[number], b: (typeof cards)[number]) => {
		const [source, target] = ORDER[a.region] <= ORDER[b.region] ? [a, b] : [b, a];
		const key = `${source.id}→${target.id}`;
		if (source.id === target.id || seen.has(key)) return;
		seen.add(key);
		out.push({ source: source.id, target: target.id });
	};
	const shares = (a: string[], b: string[]) => a.some((entry) => b.includes(entry));

	for (let i = 0; i < cards.length; i += 1) {
		for (let j = i + 1; j < cards.length; j += 1) {
			const a = cards[i];
			const b = cards[j];
			if (a.region === b.region && a.kind === b.kind) continue;
			const pair = new Set([a.kind, b.kind]);
			// Une mission et ses chantiers : par la mission elle-même.
			if (pair.has("mission") && pair.has("chantier")) {
				if (a.keys.mission && a.keys.mission === b.keys.mission) add(a, b);
				continue;
			}
			// Une mission et sa PR : par l'adresse qu'elle a ouverte, ou sa branche.
			if (pair.has("mission") && pair.has("pr")) {
				const mission = a.kind === "mission" ? a : b;
				const pr = a.kind === "pr" ? a : b;
				if ((mission.keys.prUrl && mission.keys.prUrl === pr.keys.url) || shares(mission.keys.branches, pr.keys.branches)) {
					add(a, b);
				}
				continue;
			}
			// Un chantier et une PR : par la branche.
			if (pair.has("chantier") && pair.has("pr")) {
				if (shares(a.keys.branches, b.keys.branches)) add(a, b);
				continue;
			}
			// Un ticket et ce qui le traite.
			if (pair.has("ticket")) {
				const other = a.kind === "ticket" ? b : a;
				const ticket = a.kind === "ticket" ? a : b;
				if (!shares(ticket.keys.tickets, other.keys.tickets)) continue;
				// Un chantier né d'une mission reçoit le ticket par elle.
				if (other.kind === "chantier" && other.keys.mission) continue;
				// Une PR déjà reliée à un chantier ou à une mission du même ticket
				// l'est par eux : on ne tire pas un second fil par-dessus.
				if (
					other.kind === "pr" &&
					cards.some(
						(card) =>
							(card.kind === "chantier" || card.kind === "mission") &&
							shares(card.keys.tickets, ticket.keys.tickets),
					)
				) {
					continue;
				}
				add(ticket, other);
			}
		}
	}
	return out;
}
