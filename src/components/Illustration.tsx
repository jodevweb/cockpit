import clsx from "clsx";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LocalImage } from "@/components/LocalImage";
import { openLightbox } from "@/components/Lightbox";
import { locale, t as translate } from "@/i18n";
import {
	type AvantApres,
	type Capture,
	type Frise,
	type Graphe,
	type Illustration as Item,
	type Matrice,
	type Mesure,
	type Source,
	type Table,
} from "@/lib/illustrations";

/**
 * Une image décrite par un agent, dessinée par le cockpit.
 *
 * Six genres, un par nature de travail (voir `lib/illustrations.ts`). Le rendu
 * ne dépend que des données : deux agents qui décrivent la même migration
 * produisent la même image, ce qu'aucun schéma libre ne garantissait.
 */
export const Illustration = memo(function Illustration({ item, cwd }: { item: Item; cwd: string }) {
	const { t } = useTranslation("components2");
	return (
		<figure className="m-0 flex min-w-0 flex-col gap-2 rounded-xl bg-surface p-3 shadow-card">
			<figcaption className="flex items-start gap-2">
				<span className="min-w-0 flex-1 text-[12.5px] leading-snug font-semibold text-ink">{item.titre || t(`illustration.genre.${item.genre}`)}</span>
				<SourceBadge source={item.source} />
			</figcaption>
			{item.genre === "frise" ? <FriseView item={item} /> : null}
			{item.genre === "avant_apres" ? <AvantApresView item={item} /> : null}
			{item.genre === "mesure" ? <MesureView item={item} /> : null}
			{item.genre === "table" ? <TableView item={item} /> : null}
			{item.genre === "capture" ? <CaptureView item={item} cwd={cwd} /> : null}
			{item.genre === "matrice" ? <MatriceView item={item} /> : null}
		</figure>
	);
});

const SOURCE_TONES: Record<Source, string> = {
	mesure: "bg-accent-dim text-accent",
	depot: "bg-raised text-ink",
	capture: "bg-info/12 text-info",
	agent: "bg-[color-mix(in_srgb,var(--agent-1)_14%,transparent)] text-[var(--agent-1)]",
};

export function SourceBadge({ source }: { source: Source }) {
	const { t } = useTranslation("components2");
	return (
		<span className={clsx("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold", SOURCE_TONES[source])}>
			{t(`illustration.source.${source}`)}
		</span>
	);
}

function FriseView({ item }: { item: Frise }) {
	return (
		<ol className="m-0 flex list-none flex-wrap items-start gap-y-3 p-0">
			{item.etapes.map((etape, index) => (
				<li key={index} className="flex min-w-0 items-start">
					{index > 0 ? <span aria-hidden="true" className="mt-[7px] h-0.5 w-5 shrink-0 bg-line" /> : null}
					<span className="flex max-w-[9.5rem] flex-col items-center gap-1 px-1 text-center">
						<span
							className={clsx(
								"rounded-full",
								etape.etat === "casse"
									? "size-4 bg-critical ring-4 ring-critical/15"
									: etape.etat === "ok"
										? "size-3 bg-success"
										: "size-3 bg-ink-faint/60",
							)}
						/>
						<span
							className={clsx(
								"text-[11.5px] leading-tight",
								etape.etat === "casse" ? "font-semibold text-critical" : "text-ink",
							)}
						>
							{etape.label}
						</span>
						{etape.detail ? <span className="text-[10.5px] leading-tight text-ink-muted">{etape.detail}</span> : null}
					</span>
				</li>
			))}
		</ol>
	);
}

/** Rangs de gauche à droite : un nœud se place après tout ce dont il dépend. */
function layout(graphe: Graphe) {
	const incoming = new Map<string, string[]>();
	for (const noeud of graphe.noeuds) incoming.set(noeud, []);
	for (const [de, vers] of graphe.liens) incoming.get(vers)?.push(de);
	const depth = new Map<string, number>();
	const visit = (noeud: string, seen: Set<string>): number => {
		const known = depth.get(noeud);
		if (known !== undefined) return known;
		// Un cycle ne doit pas faire tourner la mise en page : on le coupe là
		// où on le rencontre.
		if (seen.has(noeud)) return 0;
		seen.add(noeud);
		const parents = incoming.get(noeud) ?? [];
		const value = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((parent) => visit(parent, seen)));
		depth.set(noeud, value);
		return value;
	};
	for (const noeud of graphe.noeuds) visit(noeud, new Set());
	const columns: string[][] = [];
	for (const noeud of graphe.noeuds) {
		const column = depth.get(noeud) ?? 0;
		(columns[column] ??= []).push(noeud);
	}
	return columns.filter(Boolean);
}

const NODE_W = 128;
const NODE_H = 26;
const GAP_X = 34;
const GAP_Y = 10;

function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function GrapheView({
	graphe,
	tone,
	marked,
}: {
	graphe: Graphe;
	tone: "avant" | "apres";
	/** Les nœuds propres à ce côté : ajoutés après, disparus avant. */
	marked: Set<string>;
}) {
	const { t } = useTranslation("components2");
	const columns = useMemo(() => layout(graphe), [graphe]);
	const position = new Map<string, { x: number; y: number }>();
	columns.forEach((column, columnIndex) =>
		column.forEach((noeud, rowIndex) =>
			position.set(noeud, { x: columnIndex * (NODE_W + GAP_X), y: rowIndex * (NODE_H + GAP_Y) }),
		),
	);
	const width = columns.length * (NODE_W + GAP_X) - GAP_X;
	const height = Math.max(...columns.map((column) => column.length)) * (NODE_H + GAP_Y) - GAP_Y;
	const markFill = tone === "apres" ? "var(--accent-dim)" : "color-mix(in srgb, var(--critical) 12%, transparent)";
	const markStroke = tone === "apres" ? "var(--accent)" : "var(--critical)";

	return (
		<svg
			role="img"
			aria-label={t(tone === "avant" ? "illustration.beforeGraph" : "illustration.afterGraph", { nodes: graphe.noeuds.join(", ") })}
			viewBox={`-2 -2 ${width + 4} ${height + 4}`}
			className="block h-auto max-h-56 w-full"
			style={{ maxWidth: width + 4 }}
		>
			{graphe.liens.map(([de, vers], index) => {
				const from = position.get(de);
				const to = position.get(vers);
				if (!from || !to) return null;
				const x1 = from.x + NODE_W;
				const y1 = from.y + NODE_H / 2;
				const x2 = to.x;
				const y2 = to.y + NODE_H / 2;
				const bend = Math.max(12, (x2 - x1) / 2);
				return (
					<path
						key={index}
						d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
						fill="none"
						stroke="var(--ink-faint)"
						strokeOpacity={0.55}
						strokeWidth={1.3}
					/>
				);
			})}
			{graphe.noeuds.map((noeud) => {
				const at = position.get(noeud);
				if (!at) return null;
				const mark = marked.has(noeud);
				return (
					<g key={noeud} transform={`translate(${at.x},${at.y})`}>
						<title>{noeud}</title>
						<rect
							width={NODE_W}
							height={NODE_H}
							rx={7}
							fill={mark ? markFill : "var(--raised)"}
							stroke={mark ? markStroke : "var(--line)"}
							strokeWidth={mark ? 1.4 : 1}
						/>
						<text
							x={NODE_W / 2}
							y={NODE_H / 2 + 4}
							textAnchor="middle"
							fontSize={11}
							fontFamily="var(--font-mono)"
							fill="var(--ink)"
						>
							{clip(noeud, 17)}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

function AvantApresView({ item }: { item: AvantApres }) {
	const { t } = useTranslation("components2");
	const avant = new Set(item.avant.noeuds);
	const apres = new Set(item.apres.noeuds);
	const disparus = new Set(item.avant.noeuds.filter((noeud) => !apres.has(noeud)));
	const nouveaux = new Set(item.apres.noeuds.filter((noeud) => !avant.has(noeud)));
	return (
		<div className="grid gap-3 sm:grid-cols-2">
			<div className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-critical/5 p-2.5">
				<span className="text-[10.5px] font-semibold tracking-wide text-critical uppercase">{t("illustration.before")}</span>
				<GrapheView graphe={item.avant} tone="avant" marked={disparus} />
			</div>
			<div className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-accent-dim/50 p-2.5">
				<span className="text-[10.5px] font-semibold tracking-wide text-accent uppercase">{t("illustration.after")}</span>
				<GrapheView graphe={item.apres} tone="apres" marked={nouveaux} />
			</div>
		</div>
	);
}

/** Le chiffre tel qu'on le lit dans la langue de l'interface. */
function format(value: number): string {
	return value.toLocaleString(locale(), { maximumFractionDigits: 2 });
}

/** L'écart en pourcentage : « −83 % » se lit d'un coup, un rapport se calcule. */
function ratio(avant: number, apres: number): string | null {
	if (avant <= 0 || avant === apres) return null;
	const change = Math.round(((apres - avant) / avant) * 100);
	return change === 0
		? null
		: translate("components2:illustration.percent", {
				sign: change > 0 ? "+" : "−",
				value: Math.abs(change).toLocaleString(locale()),
			});
}

function MesureView({ item }: { item: Mesure }) {
	const { t } = useTranslation("components2");
	return (
		<div className="flex flex-col gap-3">
			{item.mesures.map((mesure, index) => {
				const max = Math.max(mesure.avant, mesure.apres, Number.EPSILON);
				const change = ratio(mesure.avant, mesure.apres);
				const unite = mesure.unite || item.unite;
				const unit = unite ? ` ${unite}` : "";
				return (
					<div key={index} className="flex flex-col gap-1">
						<div className="flex items-baseline gap-2">
							<span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted">{mesure.label}</span>
							{change ? <span className="font-mono text-[11px] font-semibold text-accent">{change}</span> : null}
						</div>
						<div className="flex items-center gap-2">
							<span className="w-10 shrink-0 text-[10.5px] text-ink-muted">{t("illustration.beforeShort")}</span>
							<span className="h-3.5 min-w-0 flex-1">
								<span className="block h-full rounded bg-ink-faint/45" style={{ width: `${(mesure.avant / max) * 100}%` }} />
							</span>
							<span className="w-20 shrink-0 text-right font-mono text-[11px] text-ink-muted">{format(mesure.avant)}{unit}</span>
						</div>
						<div className="flex items-center gap-2">
							<span className="w-10 shrink-0 text-[10.5px] text-ink-muted">{t("illustration.afterShort")}</span>
							<span className="h-3.5 min-w-0 flex-1">
								<span className="block h-full rounded bg-accent" style={{ width: `${(mesure.apres / max) * 100}%` }} />
							</span>
							<span className="w-20 shrink-0 text-right font-mono text-[11px] font-semibold text-ink">{format(mesure.apres)}{unit}</span>
						</div>
					</div>
				);
			})}
			{item.commande ? (
				<code className="truncate rounded-md bg-raised px-2 py-1 font-mono text-[10.5px] text-ink-muted" title={item.commande}>
					$ {item.commande}
				</code>
			) : (
				<span className="text-[10.5px] text-warning">{t("illustration.noCommand")}</span>
			)}
		</div>
	);
}

const CHANGE_STYLES: Record<Table["colonnes"][number]["changement"], string> = {
	ajout: "bg-success/10 text-success",
	retrait: "bg-critical/8 text-critical line-through decoration-critical/60",
	modif: "bg-warning/10 text-warning",
	garde: "text-ink",
};

const CHANGE_MARKS: Record<Table["colonnes"][number]["changement"], string> = {
	ajout: "+",
	retrait: "−",
	modif: "~",
	garde: "",
};

function TableView({ item }: { item: Table }) {
	return (
		<div className="overflow-hidden rounded-lg font-mono text-[11.5px] shadow-[0_0_0_1px_var(--line-soft)]">
			{item.table ? <div className="bg-raised px-3 py-1.5 font-semibold text-ink">{item.table}</div> : null}
			{item.colonnes.map((colonne, index) => (
				<div key={index} className={clsx("flex gap-3 px-3 py-1", CHANGE_STYLES[colonne.changement])}>
					<span className="w-3 shrink-0 text-center">{CHANGE_MARKS[colonne.changement]}</span>
					<span className="min-w-0 flex-1 truncate">{colonne.nom}</span>
					{colonne.type ? <span className="shrink-0 opacity-75">{colonne.type}</span> : null}
				</div>
			))}
		</div>
	);
}

function resolve(path: string, cwd: string): string {
	return path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
}

function CaptureView({ item, cwd }: { item: Capture; cwd: string }) {
	const { t } = useTranslation("components2");
	const path = resolve(item.image, cwd);
	return (
		<div className="flex flex-wrap items-start gap-3">
			<button
				type="button"
				title={t("illustration.enlarge")}
				onClick={() => openLightbox([{ key: path, kind: "image", path, label: item.titre || t("illustration.captureLabel") }])}
				className="focus-ring relative min-w-0 flex-[1_1_18rem] overflow-hidden rounded-lg bg-raised shadow-[0_0_0_1px_var(--line-soft)]"
			>
				<LocalImage path={path} alt={item.titre} className="block h-auto w-full" />
				{item.reperes.map((repere, index) => (
					<span
						key={index}
						aria-hidden="true"
						className="absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--agent-1)] text-[11px] font-bold text-white shadow-[0_0_0_3px_var(--surface)]"
						style={{ left: `${repere.x * 100}%`, top: `${repere.y * 100}%` }}
					>
						{index + 1}
					</span>
				))}
			</button>
			{item.reperes.length > 0 ? (
				<ol className="m-0 flex min-w-0 flex-[1_1_12rem] list-none flex-col gap-2 p-0">
					{item.reperes.map((repere, index) => (
						<li key={index} className="flex gap-2 text-[12px] leading-snug text-ink">
							<span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--agent-1)] text-[10.5px] font-bold text-white">
								{index + 1}
							</span>
							{repere.texte}
						</li>
					))}
				</ol>
			) : null}
		</div>
	);
}

function MatriceView({ item }: { item: Matrice }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-separate border-spacing-1 text-[11.5px]">
				<thead>
					<tr>
						<th className="p-0" />
						{item.options.map((option) => (
							<th key={option} scope="col" className="px-1.5 pb-1 text-center font-semibold text-ink">
								{option}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{item.criteres.map((critere) => (
						<tr key={critere.nom}>
							<th scope="row" className="pr-2 text-left font-normal whitespace-nowrap text-ink-muted">
								{critere.nom}
							</th>
							{critere.valeurs.map((valeur, index) => (
								<td
									key={index}
									className={clsx(
										"rounded-md px-2 py-1.5 text-center",
										critere.bons[index] === true
											? "bg-success/10 text-success"
											: critere.bons[index] === false
												? "bg-critical/8 text-critical"
												: "bg-raised text-ink",
									)}
								>
									{valeur || "—"}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
