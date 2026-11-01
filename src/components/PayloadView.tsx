import clsx from "clsx";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { fromIso } from "@/lib/format";

/** Clés qu'on ne montre pas : bruit technique ou déjà affiché ailleurs. */
const HIDDEN = /^(id|node_id|_links?|url|.*_url|avatar|gravatar.*|sha|guid|type|object)$/i;

/** Clés dont la valeur est une date à mettre en forme. */
const DATE_KEY = /(_at|date|time|seen|created|updated|started|finished|ended)$/i;

/** Clés dont le contenu mérite un rendu markdown plutôt qu'une ligne. */
const LONG_TEXT =
	/^(body|description|message|summary|culprit|title|reason|conclusion_message)$/i;

interface Row {
	key: string;
	label: string;
	value: string;
	long: boolean;
}

function humanize(key: string): string {
	return key
		.replace(/[_.]/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase();
}

function render(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "boolean") return value ? "oui" : "non";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return value;

	if (Array.isArray(value)) {
		if (value.length === 0) return null;
		// Une liste d'objets nommés se résume à ses noms.
		const names = value
			.map((entry) =>
				typeof entry === "string"
					? entry
					: ((entry as Record<string, unknown>)?.name ??
						(entry as Record<string, unknown>)?.login ??
						(entry as Record<string, unknown>)?.slug),
			)
			.filter((entry): entry is string => typeof entry === "string");
		return names.length > 0 ? names.join(", ") : `${value.length} éléments`;
	}

	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const label = record.name ?? record.login ?? record.slug ?? record.email;
		return typeof label === "string" ? label : null;
	}
	return null;
}

/**
 * Met à plat la charge utile d'un service en lignes lisibles.
 *
 * Chaque API a sa forme, et écrire une fiche par service ne tient pas à
 * l'échelle. On parcourt donc les champs de premier niveau — plus ceux d'un
 * objet imbriqué court — en écartant le bruit technique, et on formate ce qui
 * ressemble à une date ou à un texte long.
 */
function flatten(payload: unknown): Row[] {
	if (!payload || typeof payload !== "object") return [];
	const rows: Row[] = [];

	const push = (key: string, raw: unknown, prefix = "") => {
		if (HIDDEN.test(key)) return;
		const value = render(raw);
		if (value === null) return;

		const full = prefix ? `${prefix}.${key}` : key;
		rows.push({
			key: full,
			label: humanize(full),
			value: DATE_KEY.test(key) && /\d{4}-\d{2}/.test(value) ? fromIso(value) : value,
			long: LONG_TEXT.test(key) && value.length > 90,
		});
	};

	for (const [key, raw] of Object.entries(payload as Record<string, unknown>)) {
		if (
			raw &&
			typeof raw === "object" &&
			!Array.isArray(raw) &&
			render(raw) === null &&
			Object.keys(raw).length <= 8
		) {
			// Objet sans nom lisible : on descend d'un niveau plutôt que de le taire.
			for (const [subKey, subRaw] of Object.entries(raw as Record<string, unknown>)) {
				push(subKey, subRaw, key);
			}
			continue;
		}
		push(key, raw);
	}

	return rows;
}

/**
 * Fiche par défaut d'un élément de flux : lisible sans connaître l'API, avec la
 * charge brute conservée en repli pour les cas où seul le JSON répond.
 */
export function PayloadView({ payload }: { payload: unknown }) {
	const rows = useMemo(() => flatten(payload), [payload]);
	const [showRaw, setShowRaw] = useState(false);

	const short = rows.filter((row) => !row.long);
	const long = rows.filter((row) => row.long);

	return (
		<div className="flex flex-col gap-3 p-3">
			{short.length > 0 ? (
				<div className="grid grid-cols-2 gap-x-4 gap-y-1.5 xl:grid-cols-3">
					{short.map((row) => (
						<div key={row.key} className="min-w-0">
							<div className="truncate text-[10px] tracking-[0.06em] text-ink-faint uppercase">
								{row.label}
							</div>
							<div className="text-selectable truncate font-mono text-[11px] text-ink-muted">
								{row.value}
							</div>
						</div>
					))}
				</div>
			) : null}

			{long.map((row) => (
				<div key={row.key} className="rounded-xl border border-line-soft p-3">
					<div className="mb-1.5 text-[10px] tracking-[0.06em] text-ink-faint uppercase">
						{row.label}
					</div>
					<Markdown source={row.value} />
				</div>
			))}

			{rows.length === 0 ? (
				<p className="text-[11px] text-ink-faint">Aucun détail exploitable.</p>
			) : null}

			<div>
				<button
					type="button"
					onClick={() => setShowRaw((open) => !open)}
					className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink-muted"
				>
					{showRaw ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
					Données brutes
				</button>
				{showRaw ? (
					<pre
						className={clsx(
							"text-selectable mt-1.5 max-h-96 overflow-auto rounded-xl border border-line-soft bg-void p-3",
							"font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-muted",
						)}
					>
						{JSON.stringify(payload, null, 2)}
					</pre>
				) : null}
			</div>
		</div>
	);
}
