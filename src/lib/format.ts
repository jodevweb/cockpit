/** Formatages partagés — dans la langue de l'interface, toujours compacts. */

import { locale, t } from "@/i18n";
import { pathParts } from "@/lib/paths";

const RELATIVE_STEPS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
	[60, "second"],
	[3600, "minute"],
	[86400, "hour"],
	[604800, "day"],
	[2629800, "week"],
	[31557600, "month"],
];

// Créés à la demande, pas au chargement : la langue n'y est pas encore connue.
let relativeCache: { locale: string; format: Intl.RelativeTimeFormat } | null = null;
function relative(): Intl.RelativeTimeFormat {
	const current = locale();
	if (relativeCache?.locale !== current) {
		relativeCache = { locale: current, format: new Intl.RelativeTimeFormat(current, { numeric: "auto" }) };
	}
	return relativeCache.format;
}

/** « il y a 3 min » à partir d'un nombre de secondes écoulées. */
export function fromSeconds(seconds: number): string {
	if (!Number.isFinite(seconds)) return "—";
	if (seconds < 45) return t("lib:format.justNow");

	let previous = 1;
	for (const [limit, unit] of RELATIVE_STEPS) {
		if (seconds < limit) {
			return relative().format(-Math.round(seconds / previous), unit);
		}
		previous = limit;
	}
	return relative().format(-Math.round(seconds / 31557600), "year");
}

export function fromTimestamp(seconds: number | null | undefined): string {
	if (!seconds) return "—";
	return fromSeconds(Date.now() / 1000 - seconds);
}

export function fromIso(iso: string | null | undefined): string {
	if (!iso) return "—";
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) return "—";
	return fromSeconds((Date.now() - parsed) / 1000);
}

let compactCache: { locale: string; format: Intl.NumberFormat } | null = null;

export function compactNumber(value: number): string {
	const current = locale();
	if (compactCache?.locale !== current) {
		compactCache = {
			locale: current,
			format: new Intl.NumberFormat(current, { notation: "compact", maximumFractionDigits: 1 }),
		};
	}
	return compactCache.format.format(value);
}

export function bytes(value: number): string {
	if (value < 1024) return t("lib:format.bytes", { value });
	if (value < 1024 * 1024) return t("lib:format.kilobytes", { value: (value / 1024).toFixed(0) });
	return t("lib:format.megabytes", { value: (value / (1024 * 1024)).toFixed(1) });
}

export function duration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Raccourcit un chemin absolu en gardant la fin, la partie qui identifie. */
export function shortPath(path: string, segments = 3): string {
	const parts = pathParts(path);
	if (parts.length <= segments) return path;
	return `…/${parts.slice(-segments).join("/")}`;
}

/** `feat/storefront-staging-v2-wave0` → `feat/storefront-staging…` pour les listes denses. */
export function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

/**
 * Modèle Claude → libellé court affichable (`claude-opus-5-5` → `Opus 5.5`).
 *
 * La version s'écrit avec des tirets dans l'identifiant ; un suffixe daté
 * (`claude-haiku-4-5-20251001`) n'en fait pas partie.
 */
export function modelLabel(model: string): string {
	const match = model.match(/(opus|sonnet|haiku|fable)-?(\d{1,2}(?:[.-]\d{1,2}(?!\d))*)?/i);
	if (!match) return model;
	const family = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
	return match[2] ? `${family} ${match[2].replace(/-/g, ".")}` : family;
}

/** Secondes écoulées entre deux horodatages ; la fin par défaut est maintenant. */
export function elapsedSeconds(
	from: string | null | undefined,
	to?: string | null,
): number {
	if (!from) return 0;
	const debut = new Date(from).getTime();
	if (Number.isNaN(debut)) return 0;
	const fin = to ? new Date(to).getTime() : Date.now();
	if (Number.isNaN(fin)) return 0;
	return Math.max(0, Math.round((fin - debut) / 1000));
}
