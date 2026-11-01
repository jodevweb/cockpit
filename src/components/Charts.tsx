import clsx from "clsx";

/**
 * Petites figures pour la vue d'ensemble.
 *
 * Trois règles tenues ici, parce qu'elles décident de la lisibilité :
 * les marques sont fines et arrondies côté valeur ; deux segments voisins sont
 * séparés par un filet de la couleur du fond plutôt que collés ; et la couleur
 * ne porte jamais l'information seule — chaque segment ou barre est étiqueté.
 *
 * Le dernier point n'est pas cosmétique : les teintes de statut du thème
 * (orange et vert) tombent à ΔE 6.7 en protanopie, mesuré. Elles restent
 * utilisables tant qu'un libellé double la couleur, pas au-delà.
 */

/** Courbe d'une seule série : la tendance, sans axes ni graduations. */
export function Sparkline({
	values,
	labels,
	className,
	height = 34,
}: {
	values: number[];
	/** Une entrée par point, lue au survol. */
	labels?: string[];
	className?: string;
	height?: number;
}) {
	if (values.length < 2) return null;

	const max = Math.max(...values, 1);
	const step = 100 / (values.length - 1);
	const points = values.map((value, index) => {
		const x = index * step;
		// 4 % de marge haute : la pointe ne doit pas toucher le bord.
		const y = 100 - (value / max) * 96;
		return `${x},${y}`;
	});

	return (
		<svg
			viewBox="0 0 100 100"
			preserveAspectRatio="none"
			style={{ height }}
			className={clsx("w-full", className)}
			role="img"
			aria-label={`Tendance sur ${values.length} points`}
		>
			<polyline
				points={points.join(" ")}
				fill="none"
				stroke="var(--color-accent-soft)"
				strokeWidth="2"
				vectorEffect="non-scaling-stroke"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{/* Dernier point marqué : c'est la valeur qu'on cherche des yeux. */}
			<circle
				cx={points[points.length - 1].split(",")[0]}
				cy={points[points.length - 1].split(",")[1]}
				r="1.6"
				fill="var(--color-accent-soft)"
				vectorEffect="non-scaling-stroke"
			/>
			{labels?.map((label, index) => (
				<title key={index}>{label}</title>
			))}
		</svg>
	);
}

export interface Segment {
	label: string;
	value: number;
	color: string;
}

/** Répartition d'un total en parts, étiquetées sous la barre. */
export function StackedBar({ segments }: { segments: Segment[] }) {
	const total = segments.reduce((sum, segment) => sum + segment.value, 0);
	if (total === 0) return null;

	const shown = segments.filter((segment) => segment.value > 0);

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full">
				{shown.map((segment) => (
					<div
						key={segment.label}
						title={`${segment.label} : ${segment.value}`}
						style={{
							width: `${(segment.value / total) * 100}%`,
							backgroundColor: segment.color,
						}}
						className="h-full first:rounded-l-full last:rounded-r-full"
					/>
				))}
			</div>
			<div className="flex flex-wrap gap-x-3 gap-y-0.5">
				{shown.map((segment) => (
					<span key={segment.label} className="flex items-center gap-1 text-[10px]">
						<span
							className="size-1.5 shrink-0 rounded-full"
							style={{ backgroundColor: segment.color }}
						/>
						<span className="text-ink-muted">{segment.label}</span>
						<span className="font-mono text-ink-faint tabular-nums">{segment.value}</span>
					</span>
				))}
			</div>
		</div>
	);
}

/** Barres horizontales proportionnelles — comparer des grandeurs, pas des identités. */
export function BarList({
	rows,
	empty,
	max: forcedMax,
}: {
	rows: Array<{ label: string; value: number; hint?: string }>;
	empty?: string;
	max?: number;
}) {
	if (rows.length === 0) {
		return empty ? <p className="px-1 py-2 text-[11px] text-ink-faint">{empty}</p> : null;
	}
	const max = Math.max(forcedMax ?? 0, ...rows.map((row) => row.value), 1);

	return (
		<div className="flex flex-col gap-1">
			{rows.map((row) => (
				<div key={row.label} className="flex items-center gap-2">
					<span
						className="w-28 shrink-0 truncate text-[10px] text-ink-muted"
						title={row.label}
					>
						{row.label}
					</span>
					<div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface">
						<div
							className="h-full rounded-full bg-accent-soft/70"
							style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
						/>
					</div>
					<span className="w-10 shrink-0 text-right font-mono text-[10px] text-ink-faint tabular-nums">
						{row.value}
					</span>
					{row.hint ? (
						<span className="w-12 shrink-0 text-right text-[10px] text-ink-faint">
							{row.hint}
						</span>
					) : null}
				</div>
			))}
		</div>
	);
}

/** Avancement d'un cycle : une part d'un tout, avec son chiffre en clair. */
export function Gauge({
	value,
	total,
	label,
}: {
	value: number;
	total: number;
	label: string;
}) {
	const ratio = total > 0 ? value / total : 0;
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-baseline gap-1.5">
				<span className="font-mono text-[18px] leading-none font-semibold text-ink tabular-nums">
					{Math.round(ratio * 100)}%
				</span>
				<span className="text-[10px] text-ink-faint">
					{label} · {value}/{total}
				</span>
			</div>
			<div className="h-2 w-full overflow-hidden rounded-full bg-surface">
				<div
					className="h-full rounded-full bg-success/70"
					style={{ width: `${Math.max(2, ratio * 100)}%` }}
				/>
			</div>
		</div>
	);
}
