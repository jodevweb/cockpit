import { metaLabel } from "@/lib/feedMeta";
import clsx from "clsx";
import { ExternalLink, Inbox, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	Badge,
	Button,
	Chips,
	Dot,
	Empty,
	ErrorNote,
	Row,
	SearchField,
	Spinner,
} from "@/components/ui";
import { PayloadView } from "@/components/PayloadView";
import { t as translate } from "@/i18n";
import { fromIso, truncate } from "@/lib/format";
import { api } from "@/lib/ipc";
import { onChange, type ChangeTopic } from "@/lib/refresh";
import type { FeedItem } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

export interface FeedSource {
	id: string;
	label: string;
	load: () => Promise<FeedItem[]>;
	/** Actions contextuelles proposées sur l'élément sélectionné. */
	actions?: (item: FeedItem, reload: () => void) => ReactNode;
	/** Ce dont ce flux se recharge à l'annonce ; `tickets` par défaut. */
	changes?: ChangeTopic;
	/**
	 * Rendu du panneau de détail. Sans lui, on affiche le JSON de la source :
	 * pratique pour déboguer, inutile pour travailler — d'où la possibilité pour
	 * une source d'imposer sa propre fiche.
	 */
	detail?: (item: FeedItem, reload: () => void) => ReactNode;
}

/**
 * Liste + détail pour n'importe quelle source distante. Le même composant sert
 * à Linear, GitHub, Trigger et Railway : c'est ce qui donne au cockpit
 * une lecture homogène quel que soit le SaaS derrière.
 */
type SortId = "recent" | "oldest" | "severity" | "status" | "title";

const SORTS: SortId[] = ["recent", "oldest", "severity", "status", "title"];

const SEVERITY_RANK: Record<string, number> = {
	critical: 0,
	warning: 1,
	info: 2,
	success: 3,
};

const SEVERITIES = new Set(["critical", "warning", "info", "success"]);

/** Une dimension de filtrage et ses valeurs, avec leur fréquence. */
interface Facet {
	key: string;
	label: string;
	values: Array<{ value: string; count: number }>;
}

/**
 * Dimensions de filtrage déduites des données affichées.
 *
 * Chaque source a ses propres champs (`environnement` chez Trigger, `auteur`
 * sur les PR) : les découvrir dans les éléments évite
 * d'écrire une barre de filtres par service. On écarte ce qui ne discrimine
 * rien — une valeur unique — et ce qui est presque unique par élément, comme un
 * identifiant.
 */
function buildFacets(items: FeedItem[]): Facet[] {
	const counters = new Map<string, Map<string, number>>();

	const bump = (key: string, value: string) => {
		if (!value.trim()) return;
		const values = counters.get(key) ?? new Map<string, number>();
		values.set(value, (values.get(value) ?? 0) + 1);
		counters.set(key, values);
	};

	for (const item of items) {
		bump("severity", item.severity);
		bump("status", item.status);
		for (const field of item.meta) bump(`meta:${field.label}`, field.value);
	}

	const facets: Facet[] = [];
	for (const [key, values] of counters) {
		const distinct = values.size;
		if (distinct < 2 || distinct > 25) continue;
		// Autant de valeurs que d'éléments : c'est un identifiant, pas un critère.
		if (distinct > items.length * 0.6) continue;

		facets.push({
			key,
			label:
				key === "severity"
					? translate("components2:feedPanel.sort.severity")
					: key === "status"
						? translate("components2:feedPanel.sort.status")
						: metaLabel(key.slice(5)),
			values: [...values.entries()]
				.map(([value, count]) => ({ value, count }))
				.sort((a, b) => b.count - a.count),
		});
	}

	// Gravité et statut d'abord : ce sont les questions qu'on se pose en premier.
	const priority = (facet: Facet) =>
		facet.key === "severity" ? 0 : facet.key === "status" ? 1 : 2;
	return facets.sort((a, b) => priority(a) - priority(b) || a.label.localeCompare(b.label));
}

function valueOf(item: FeedItem, key: string): string {
	if (key === "severity") return item.severity;
	if (key === "status") return item.status;
	const label = key.slice(5);
	return item.meta.find((field) => field.label === label)?.value ?? "";
}

export function FeedPanel({
	sources,
	pollMs,
	emptyHint,
}: {
	sources: FeedSource[];
	pollMs?: number;
	emptyHint?: string;
}) {
	const { t } = useTranslation("components2");
	const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [sort, setSort] = useState<SortId>("recent");
	/** Clé de facette → valeurs retenues. Une facette vide ne filtre pas. */
	const [picked, setPicked] = useState<Record<string, string[]>>({});
	const [showFilters, setShowFilters] = useState(false);

	const source = sources.find((entry) => entry.id === sourceId) ?? sources[0];

	// Les facettes d'un flux ne veulent rien dire dans un autre : un statut
	// Linear retenu ici ne correspond à aucune PR, et la liste se vidait sans
	// qu'on comprenne pourquoi. Changer de source repart donc à zéro.
	useEffect(() => {
		setPicked({});
		setQuery("");
		setSelectedId(null);
	}, [sourceId]);
	// `resetOnChange` : changer d'onglet doit vider l'écran plutôt que laisser
	// croire que les éléments du service précédent sont ceux du nouveau.
	const feed = useAsync(() => source.load(), [source.id], {
		pollMs,
		resetOnChange: true,
		// Ce qu'on modifie depuis une fiche s'affiche aussi dans cette liste : elle
		// se remet à jour sur annonce, plutôt que d'attendre le prochain sondage en
		// affichant un état qu'on vient soi-même de changer.
		subscribe: (onRefresh) => onChange(source.changes ?? "tickets", onRefresh),
	});

	// Les facettes viennent des données brutes : elles ne doivent pas se réduire
	// à mesure qu'on filtre, sinon on ne peut plus élargir sa sélection.
	const facets = useMemo(() => buildFacets(feed.data ?? []), [feed.data]);

	const toggle = (key: string, value: string) =>
		setPicked((current) => {
			const values = current[key] ?? [];
			const next = values.includes(value)
				? values.filter((entry) => entry !== value)
				: [...values, value];
			return { ...current, [key]: next };
		});

	const activeCount = Object.values(picked).reduce(
		(total, values) => total + values.length,
		0,
	);

	const items = useMemo(() => {
		const needle = query.trim().toLowerCase();
		let list = feed.data ?? [];

		if (needle) {
			list = list.filter((item) =>
				`${item.title} ${item.subtitle} ${item.status} ${item.id} ${item.meta
					.map((field) => field.value)
					.join(" ")} ${(item.tags ?? []).map((entry) => entry.label).join(" ")}`
					.toLowerCase()
					.includes(needle),
			);
		}

		for (const [key, values] of Object.entries(picked)) {
			if (values.length === 0) continue;
			list = list.filter((item) => values.includes(valueOf(item, key)));
		}

		const time = (item: FeedItem) => (item.timestamp ? Date.parse(item.timestamp) || 0 : 0);
		const sorted = [...list];
		sorted.sort((a, b) => {
			switch (sort) {
				case "oldest":
					return time(a) - time(b);
				case "severity":
					return (
						(SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
						time(b) - time(a)
					);
				case "status":
					return a.status.localeCompare(b.status) || time(b) - time(a);
				case "title":
					return a.title.localeCompare(b.title);
				default:
					return time(b) - time(a);
			}
		});
		return sorted;
	}, [feed.data, query, picked, sort]);

	const selected = useMemo(
		() => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
		[items, selectedId],
	);

	return (
		<div className="flex min-h-0 flex-1">
			<div className="hairline-r flex w-96 shrink-0 flex-col bg-base">
				<div className="flex items-center gap-1 overflow-x-auto p-2">
					{sources.map((entry) => (
						<Button
							key={entry.id}
							size="sm"
							active={entry.id === source.id}
							onClick={() => {
								setSourceId(entry.id);
								setSelectedId(null);
							}}
						>
							{entry.label}
						</Button>
					))}
					<div className="ml-auto flex items-center gap-1">
						{feed.loading ? <Spinner /> : null}
						<Button
							size="sm"
							icon={RefreshCw}
							onClick={() => {
								void api.feeds.invalidate().finally(() => feed.reload());
							}}
						/>
					</div>
				</div>

				<div className="flex flex-col gap-1.5 px-2.5 pb-2">
					<SearchField value={query} onChange={setQuery} />

					<div className="flex items-center gap-1.5">
						<select
							value={sort}
							onChange={(event) => setSort(event.target.value as SortId)}
							className="focus-ring rounded-lg border border-line-soft bg-surface px-1.5 py-1 text-[10px] text-ink-muted"
							title={t("feedPanel.sortHint")}
						>
							{SORTS.map((option) => (
								<option key={option} value={option}>
									{t(`feedPanel.sort.${option}`)}
								</option>
							))}
						</select>

						{facets.length > 0 ? (
							<Button
								size="sm"
								icon={SlidersHorizontal}
								active={showFilters || activeCount > 0}
								onClick={() => setShowFilters((open) => !open)}
							>
								{t("feedPanel.filters")}
								{activeCount > 0 ? ` · ${activeCount}` : ""}
							</Button>
						) : null}

						{activeCount > 0 ? (
							<Button
								size="sm"
								icon={X}
								onClick={() => setPicked({})}
								title={t("feedPanel.clearAll")}
							/>
						) : null}

						<span className="ml-auto font-mono text-[10px] text-ink-faint tabular-nums">
							{items.length}
							{feed.data && items.length !== feed.data.length ? `/${feed.data.length}` : ""}
						</span>
					</div>

					{showFilters ? (
						<div className="flex flex-col gap-2 rounded-xl border border-line-soft bg-surface/50 p-2">
							{facets.map((facet) => (
								<div key={facet.key}>
									<div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										{facet.label}
									</div>
									<div className="flex flex-wrap gap-1">
										{facet.values.map(({ value, count }) => {
											const active = (picked[facet.key] ?? []).includes(value);
											return (
												<button
													key={value}
													type="button"
													onClick={() => toggle(facet.key, value)}
													className={clsx(
														"focus-ring rounded-md border px-1.5 py-0.5 text-[10px] transition-colors",
														active
															? "border-accent-soft/40 bg-accent-soft/12 text-ink"
															: "border-line-soft text-ink-faint hover:text-ink-muted",
													)}
												>
													{facet.key === "severity"
														? SEVERITIES.has(value)
															? t(`feedPanel.severity.${value}`)
															: value
														: truncate(value, 28)}
													<span className="ml-1 text-ink-faint/70">{count}</span>
												</button>
											);
										})}
									</div>
								</div>
							))}
						</div>
					) : null}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
					{feed.initial && feed.loading ? (
						<div className="flex flex-col gap-1.5 p-1.5">
							{[0, 1, 2, 3, 4, 5].map((row) => (
								<div
									key={row}
									className="animate-pulse-dot rounded-lg bg-surface"
									style={{ height: 52, opacity: 1 - row * 0.14 }}
								/>
							))}
						</div>
					) : null}
					{feed.error ? <ErrorNote error={feed.error} onRetry={feed.reload} /> : null}
					{!feed.error && items.length === 0 && !feed.loading ? (
						<Empty icon={Inbox} message={t("feedPanel.empty")} hint={emptyHint} />
					) : null}
					{items.map((item) => (
						<Row
							key={`${item.source}-${item.id}`}
							selected={selected?.id === item.id}
							onClick={() => setSelectedId(item.id)}
						>
							<div className="flex items-center gap-2">
								<Dot tone={item.severity} />
								<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
									{item.title}
								</span>
								<span className="shrink-0 font-mono text-[10px] text-ink-faint">
									{fromIso(item.timestamp)}
								</span>
							</div>
							<div className="mt-0.5 flex items-center gap-2 pl-3.5">
								<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
									{item.subtitle || item.id}
								</span>
								{/* Labels de PR, priorité d'un ticket : ce sont eux qu'on
								    cherche en balayant la liste, ils passent donc avant le
								    statut. */}
								<Chips items={item.tags ?? []} max={2} />
								<Badge tone={item.severity}>{truncate(item.status, 16)}</Badge>
							</div>
						</Row>
					))}
				</div>
			</div>

			<div className="flex min-w-0 flex-1 flex-col bg-base">
				{selected && source.detail ? (
					source.detail(selected, feed.reload)
				) : selected ? (
					<>
						<div className="hairline-b flex items-start gap-3 px-4 py-3">
							<div className="min-w-0 flex-1">
								<h2 className="text-selectable text-[13px] leading-snug font-semibold text-ink">
									{selected.title}
								</h2>
								<div className="mt-0.5 flex flex-wrap items-center gap-2">
									<p className="text-selectable font-mono text-[11px] text-ink-faint">
										{selected.subtitle}
									</p>
									<Chips items={selected.tags ?? []} max={6} />
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1.5">
								{source.actions?.(selected, feed.reload)}
								{selected.url.startsWith("http") ? (
									<Button
										icon={ExternalLink}
										variant="outline"
										onClick={() => {
											void api.system.openUrl(selected.url).catch(() => undefined);
										}}
									>
										Ouvrir
									</Button>
								) : null}
							</div>
						</div>

						<div className="grid shrink-0 grid-cols-4 gap-px bg-line-soft">
							{selected.meta
								.filter((field) => field.value)
								.map((field) => (
									<div key={field.label} className="bg-base px-3 py-2">
										<div className="text-[10px] tracking-[0.06em] text-ink-faint uppercase">
											{metaLabel(field.label)}
										</div>
										<div className="text-selectable truncate font-mono text-[11px] text-ink-muted">
											{field.value}
										</div>
									</div>
								))}
						</div>

						<div className="min-h-0 flex-1 overflow-auto p-3">
							<PayloadView payload={selected.payload} />
						</div>
					</>
				) : (
					<Empty icon={Inbox} message={t("feedPanel.selectItem")} />
				)}
			</div>
		</div>
	);
}
