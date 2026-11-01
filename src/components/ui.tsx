import clsx from "clsx";
import { AlertTriangle, Loader2, Plug, Search } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Severity } from "@/lib/types";

/* ── Primitives ────────────────────────────────────────────────────────── */

export function Button({
	children,
	onClick,
	variant = "ghost",
	size = "md",
	icon: Icon,
	disabled,
	loading,
	title,
	active,
	className,
}: {
	children?: ReactNode;
	onClick?: () => void;
	variant?: "ghost" | "solid" | "outline" | "danger" | "warning";
	size?: "sm" | "md";
	icon?: React.ComponentType<{ size?: number; className?: string }>;
	disabled?: boolean;
	/** Action en cours : le bouton tourne à la place de son icône et ne répond
	    plus. Sans quoi on reclique, faute de savoir si le premier clic a pris. */
	loading?: boolean;
	title?: string;
	active?: boolean;
	className?: string;
}) {
	const variants = {
		ghost: "text-ink-muted hover:text-ink hover:bg-hover",
		solid: "bg-accent text-accent-ink hover:bg-accent-soft",
		outline: "border border-line text-ink-muted hover:text-ink hover:border-ink-faint",
		danger: "text-critical hover:bg-critical/10",
		// Le pendant de `danger` pour ce qui se répare sans casse : une
		// autorisation à accorder, une connexion à relancer. Sans lui, colorer un
		// bouton en avertissement passait par `className`, que Tailwind ne fait
		// pas gagner contre la couleur du variant — l'ordre de la feuille de
		// style décide, pas celui de l'attribut, et la couleur restait grise.
		warning: "text-warning hover:bg-warning/10",
	};

	return (
		<button
			type="button"
			title={title}
			disabled={disabled || loading}
			onClick={onClick}
			className={clsx(
				"focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
				size === "sm" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-xs",
				variants[variant],
				active && "bg-accent-dim text-accent-soft",
				className,
			)}
		>
			{loading ? (
				<Loader2
					size={size === "sm" ? 12 : 13}
					className="animate-spin-slow shrink-0"
				/>
			) : Icon ? (
				<Icon size={size === "sm" ? 12 : 13} />
			) : null}
			{children}
		</button>
	);
}

export function Badge({
	children,
	tone = "neutral",
	mono,
}: {
	children: ReactNode;
	tone?: Severity | "neutral" | "accent";
	mono?: boolean;
}) {
	const tones = {
		critical: "bg-critical/12 text-critical",
		warning: "bg-warning/12 text-warning",
		success: "bg-success/12 text-success",
		info: "bg-info/12 text-info",
		accent: "bg-accent-dim text-accent-soft",
		neutral: "bg-raised text-ink-muted",
	};
	return (
		<span
			className={clsx(
				"inline-flex h-[18px] shrink-0 items-center rounded-md px-1.5 text-[10px] font-medium tracking-wide whitespace-nowrap",
				mono && "font-mono",
				tones[tone],
			)}
		>
			{children}
		</span>
	);
}

/* ── Étiquettes ───────────────────────────────────────────────────────── */

export interface ChipItem {
	label: string;
	/** Hexadécimal sans `#`, quand la source fournit sa propre couleur. */
	color?: string;
	tone?: Severity | "neutral";
}

/**
 * Étiquettes d'une ligne : labels d'une PR, priorité d'un ticket.
 *
 * Elles sont rendues avec la couleur d'origine quand la source en donne une —
 * un label GitHub se reconnaît à sa couleur avant qu'on l'ait lu, ce qui est
 * précisément ce qu'on demande à une liste dense de PR.
 */
export function Chips({
	items,
	max = 3,
	className,
}: {
	items: ChipItem[];
	/** Au-delà, le surplus est résumé par un `+N` (titre complet au survol). */
	max?: number;
	className?: string;
}) {
	// `?.` : ce composant est rendu depuis une vingtaine d'endroits, alimentés
	// par autant de sources. Une étiquette sans libellé — un champ renommé côté
	// serveur, une source qui change de forme — faisait tomber tout l'écran sur
	// un `undefined.trim()`. Elle est maintenant simplement ignorée.
	const kept = items.filter((item) => item.label?.trim());
	if (kept.length === 0) return null;
	const shown = kept.slice(0, max);
	const rest = kept.length - shown.length;

	const tones = {
		critical: "border-critical/30 bg-critical/10 text-critical",
		warning: "border-warning/30 bg-warning/10 text-warning",
		success: "border-success/30 bg-success/10 text-success",
		info: "border-info/30 bg-info/10 text-info",
		neutral: "border-line-soft bg-raised text-ink-muted",
	};

	return (
		// `inline-flex` : les étiquettes se glissent aussi bien dans une ligne de
		// texte que dans une rangée flex, sans casser l'alignement.
		<span
			className={clsx("inline-flex shrink-0 items-center gap-1 align-middle", className)}
		>
			{shown.map((item) => (
				<span
					key={item.label}
					title={item.label}
					className={clsx(
						"inline-flex h-[16px] max-w-32 shrink-0 items-center gap-1 rounded border px-1 text-[10px] leading-none font-medium whitespace-nowrap",
						tones[item.tone ?? "neutral"],
					)}
				>
					{item.color ? (
						<span
							className="size-1.5 shrink-0 rounded-full"
							style={{ backgroundColor: `#${item.color}` }}
						/>
					) : null}
					<span className="truncate">{item.label}</span>
				</span>
			))}
			{rest > 0 ? (
				<span
					title={kept.map((item) => item.label).join(", ")}
					className="shrink-0 font-mono text-[10px] text-ink-faint"
				>
					+{rest}
				</span>
			) : null}
		</span>
	);
}

/** Labels GitHub ramenés à des étiquettes, pour les composants qui rendent `Chips` eux-mêmes. */
export function prChips(labels: Array<{ name: string; color: string }>): ChipItem[] {
	return labels.map((label) => ({ label: label.name, color: label.color }));
}

/** Labels d'une pull request, tels que GitHub les colore. */
export function PrLabels({
	labels,
	max,
	className,
}: {
	labels: Array<{ name: string; color: string }>;
	max?: number;
	className?: string;
}) {
	return <Chips items={prChips(labels)} max={max} className={className} />;
}

/** Ton d'une priorité Linear : 0 = non définie, 1 = urgent … 4 = basse. */
const PRIORITY_TONES: Record<number, Severity | "neutral"> = {
	1: "critical",
	2: "warning",
	3: "info",
	4: "neutral",
};

/**
 * Priorité d'un ticket Linear. Rien à afficher quand elle n'est pas définie :
 * une puce « — » occuperait la place sans rien dire.
 */
export function PriorityBadge({
	priority,
	label,
	className,
}: {
	priority: number;
	label?: string;
	className?: string;
}) {
	if (!PRIORITY_TONES[priority]) return null;
	const text = label && label !== "—" ? label : PRIORITY_LABELS[priority];
	return (
		<Chips
			items={[{ label: text, tone: PRIORITY_TONES[priority] }]}
			max={1}
			className={className}
		/>
	);
}

const PRIORITY_LABELS: Record<number, string> = {
	1: "Urgent",
	2: "Haute",
	3: "Moyenne",
	4: "Basse",
};

export function Dot({ tone, pulse }: { tone: Severity | "neutral"; pulse?: boolean }) {
	const tones = {
		critical: "bg-critical",
		warning: "bg-warning",
		success: "bg-success",
		info: "bg-info",
		neutral: "bg-ink-faint",
	};
	return (
		<span
			className={clsx(
				"size-1.5 shrink-0 rounded-full",
				tones[tone],
				pulse && "animate-pulse-dot",
			)}
		/>
	);
}

/**
 * Ce qu'affiche un écran dont le service n'est pas branché.
 *
 * Ni erreur ni page blanche : une clé manquante n'est pas une panne, et le dire
 * clairement évite qu'on cherche du côté du réseau. Le geste utile — ouvrir les
 * Réglages — est à portée de clic.
 */
export function MissingConnector({
	service,
	missing,
	onConfigure,
}: {
	service: string;
	missing: string;
	onConfigure?: () => void;
}) {
	return (
		<div className="flex flex-1 items-center justify-center p-8">
			<div className="panel flex max-w-md flex-col items-center gap-2 p-6 text-center">
				<Plug size={20} className="text-ink-faint" />
				<p className="text-[13px] font-medium text-ink">{service} n'est pas connecté</p>
				<p className="text-[11px] leading-relaxed text-ink-faint">
					Il manque {missing}. Cet écran s'affichera dès que ce sera renseigné.
				</p>
				{onConfigure ? (
					<Button variant="solid" onClick={onConfigure}>
						Ouvrir les Réglages
					</Button>
				) : null}
			</div>
		</div>
	);
}

/* ── Structures d'écran ───────────────────────────────────────────────── */

export function ViewHeader({
	title,
	subtitle,
	actions,
}: {
	title: string;
	subtitle?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		// L'en-tête d'écran occupe la place d'une barre de titre : il en fait
		// aussi office. « deep » vaut pour tout ce qu'il contient — titre,
		// sous-titre, espaces vides — là où l'attribut nu n'aurait marché qu'en
		// visant le conteneur lui-même, jamais son texte. Les boutons d'action
		// bloquent le glissement d'eux-mêmes : le script de Tauri s'arrête sur
		// le premier élément cliquable qu'il rencontre.
		<header
			data-tauri-drag-region="deep"
			className="hairline-b flex h-13 shrink-0 items-center justify-between gap-4 px-5 py-2.5"
		>
			<div className="min-w-0">
				<h1 className="truncate text-[14px] leading-tight font-semibold tracking-[-0.01em]">
					{title}
				</h1>
				{subtitle ? (
					<p className="truncate text-[11px] text-ink-faint">{subtitle}</p>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">{actions}</div>
		</header>
	);
}

export function Section({
	title,
	count,
	actions,
	children,
	className,
}: {
	title: string;
	count?: number;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		// `shrink-0` : empilées dans une colonne qui défile, les sections se
		// laisseraient comprimer sous la hauteur de leur contenu, qui déborderait
		// alors par-dessus la section suivante.
		<section className={clsx("flex min-h-0 shrink-0 flex-col", className)}>
			{/* Un titre de section doit se lire sans être crié : le gris très pâle
			    d'avant se confondait avec les métadonnées des lignes, et l'œil ne
			    trouvait plus les paliers de l'écran. Le compteur porte la même
			    couleur que le titre — il en fait partie, ce n'est pas une note. */}
			<div className="flex h-7 shrink-0 items-center justify-between gap-2 px-0.5">
				<div className="flex items-baseline gap-1.5">
					<h2 className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
						{title}
					</h2>
					{count !== undefined ? (
						<span className="font-mono text-[10px] text-ink-faint">{count}</span>
					) : null}
				</div>
				<div className="flex items-center gap-1">{actions}</div>
			</div>
			{children}
		</section>
	);
}

/**
 * État vide.
 *
 * « Aucune donnée » laisse l'utilisateur seul devant un écran mort : quand rien
 * ne s'affiche parce qu'il manque une configuration, l'écran doit dire quoi
 * faire et proposer le geste — c'est ce qui rend un projet neuf utilisable.
 */
export function Empty({
	message,
	hint,
	icon: Icon,
	action,
}: {
	message: string;
	hint?: string;
	icon?: React.ComponentType<{ size?: number; className?: string }>;
	action?: { label: string; onClick: () => void };
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
			{Icon ? <Icon size={20} className="text-ink-faint/50" /> : null}
			<p className="text-xs text-ink-muted">{message}</p>
			{hint ? <p className="max-w-xs text-[11px] text-ink-faint">{hint}</p> : null}
			{action ? (
				<Button variant="solid" className="mt-1" onClick={action.onClick}>
					{action.label}
				</Button>
			) : null}
		</div>
	);
}

/**
 * Âge de la donnée affichée.
 *
 * Un cockpit montre des états passés : sans leur âge, on croit lire le présent.
 * Le compteur se met à jour tout seul — un « il y a 4 s » figé mentirait au
 * bout d'une minute.
 */
export function Freshness({
	at,
	loading,
	onReload,
}: {
	at: number | null;
	loading?: boolean;
	onReload?: () => void;
}) {
	const [, tick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => tick((value) => value + 1), 10_000);
		return () => clearInterval(timer);
	}, []);

	const label = (() => {
		if (at === null) return "jamais chargé";
		const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
		if (seconds < 10) return "à l'instant";
		if (seconds < 60) return `il y a ${seconds} s`;
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) return `il y a ${minutes} min`;
		return `il y a ${Math.round(minutes / 60)} h`;
	})();

	const content = (
		<span className="flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
			{loading ? <Spinner /> : null}
			{label}
		</span>
	);

	if (!onReload) return content;
	return (
		<button
			type="button"
			onClick={onReload}
			title="Recharger maintenant"
			className="focus-ring rounded px-1 py-0.5 hover:bg-hover"
		>
			{content}
		</button>
	);
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
	return (
		<div className="animate-in m-3 flex items-start gap-2.5 rounded-xl border border-critical/25 bg-critical/8 p-3">
			<AlertTriangle size={14} className="mt-0.5 shrink-0 text-critical" />
			<div className="min-w-0 flex-1">
				<p className="text-selectable text-[11px] leading-relaxed break-words text-ink-muted">
					{error}
				</p>
			</div>
			{onRetry ? (
				<Button size="sm" onClick={onRetry}>
					Réessayer
				</Button>
			) : null}
		</div>
	);
}

/**
 * Le cercle d'attente, pour une action courte et située.
 *
 * Un arc plutôt qu'une icône qui tourne : sa longueur respire, ce qui se lit
 * comme une activité, là où une roue à vitesse constante donne l'impression que
 * rien n'avance. Il tient dans un bouton, à côté d'un titre — c'est son emploi.
 *
 * Pour un premier chargement, préférer `SkeletonRows` : il montre la forme de ce
 * qui arrive au lieu d'occuper le temps.
 */
export function Spinner({ className, size = 13 }: { className?: string; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 32 32"
			fill="none"
			className={clsx("animate-tourne text-ink-faint", className)}
			aria-hidden
		>
			<circle cx="16" cy="16" r="13" stroke="currentColor" strokeOpacity="0.2" strokeWidth="4" />
			<circle
				cx="16"
				cy="16"
				r="13"
				stroke="currentColor"
				strokeWidth="4"
				strokeLinecap="round"
				pathLength={100}
				className="animate-arc"
			/>
		</svg>
	);
}

/** Un bloc gris qui prend la place de ce qui arrive. */
export function Skeleton({
	className,
	style,
}: {
	className?: string;
	style?: React.CSSProperties;
}) {
	return <div className={clsx("skeleton", className)} style={style} aria-hidden />;
}

/**
 * La silhouette d'une liste en cours de chargement.
 *
 * Les largeurs varient d'une ligne à l'autre : des barres identiques font un
 * motif, et un motif ne ressemble à rien de ce qui va s'afficher.
 */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
	const widths = ["78%", "62%", "85%", "54%", "70%", "46%"];
	return (
		<div className={clsx("flex flex-col gap-2", className)} aria-hidden>
			{Array.from({ length: rows }, (_, index) => (
				<div key={index} className="flex items-center gap-2">
					<Skeleton className="size-3.5 shrink-0 rounded-full" />
					<Skeleton className="h-3" style={{ width: widths[index % widths.length] }} />
				</div>
			))}
		</div>
	);
}

/**
 * Le rafraîchissement d'un contenu déjà affiché.
 *
 * Un fil de deux pixels en haut de la vue : il dit que ça travaille sans rien
 * masquer de ce qu'on est en train de lire — c'est précisément ce qu'un voile ou
 * un remplacement par un cercle font perdre.
 */
export function LoadingBar({ active }: { active: boolean }) {
	if (!active) return null;
	return (
		<div className="loading-bar relative h-0.5 w-full overflow-hidden bg-line-soft/40" aria-hidden />
	);
}

export function SearchField({
	value,
	onChange,
	placeholder = "Filtrer…",
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}) {
	return (
		<div className={clsx("relative", className)}>
			<Search
				size={12}
				className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
			/>
			<input
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				spellCheck={false}
				className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised pr-2 pl-7 text-xs text-ink placeholder:text-ink-faint focus:border-accent/40"
			/>
		</div>
	);
}

/* ── Tuiles de mesure ─────────────────────────────────────────────────── */

export function Metric({
	label,
	value,
	tone = "neutral",
	hint,
	onClick,
}: {
	label: string;
	value: string | number;
	tone?: Severity | "neutral";
	hint?: string;
	onClick?: () => void;
}) {
	const tones = {
		critical: "text-critical",
		warning: "text-warning",
		success: "text-success",
		info: "text-info",
		neutral: "text-ink",
	};
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={!onClick}
			className={clsx(
				"panel flex min-w-0 flex-col gap-0.5 px-3.5 py-2.5 text-left transition-colors duration-150",
				onClick && "hover:border-line hover:bg-raised",
			)}
		>
			<span className="truncate text-[10px] font-medium tracking-[0.07em] text-ink-faint uppercase">
				{label}
			</span>
			<span
				className={clsx(
					"font-mono text-xl leading-none font-semibold tracking-tight tabular-nums",
					tones[tone],
				)}
			>
				{value}
			</span>
			{hint ? <span className="truncate text-[10px] text-ink-faint">{hint}</span> : null}
		</button>
	);
}

/** Ligne de liste sélectionnable — la brique de toutes les colonnes maîtres. */
export function Row({
	selected,
	onClick,
	onDoubleClick,
	children,
	className,
}: {
	selected?: boolean;
	onClick?: () => void;
	onDoubleClick?: () => void;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onClick}
			onDoubleClick={onDoubleClick}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onClick?.();
				}
			}}
			className={clsx(
				"focus-ring group relative w-full cursor-default rounded-xl px-3 py-2.5 text-left transition-colors duration-120",
				selected ? "bg-raised" : "hover:bg-surface",
				className,
			)}
		>
			{selected ? (
				<span className="absolute top-1/2 left-0 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent" />
			) : null}
			{children}
		</div>
	);
}

export function KeyHint({ children }: { children: ReactNode }) {
	return (
		<kbd className="rounded border border-line bg-raised px-1 py-px font-mono text-[10px] text-ink-faint">
			{children}
		</kbd>
	);
}

/**
 * Fenêtre modale, posée au-dessus de toute l'application.
 *
 * `createPortal` vers le `body`, et c'est tout l'intérêt : un `position: fixed`
 * n'est relatif au viewport que si aucun ancêtre ne porte de `transform`. Or le
 * cockpit anime ses panneaux — `animate-in` applique un `translateY`, conservé
 * par son `fill-mode: both` — et une modale rendue à l'intérieur se retrouvait
 * mesurée par rapport à ce panneau : son voile s'arrêtait au bord du rail de
 * navigation, qui restait net et cliquable derrière.
 *
 * Sortir du sous-arbre règle la question une fois pour toutes, quel que soit le
 * CSS des parents. Échap et le clic sur le voile ferment : une fenêtre qui
 * couvre tout doit se quitter sans chercher la croix.
 */
export function Modal({
	onClose,
	children,
	align = "start",
}: {
	onClose: () => void;
	children: ReactNode;
	/** `start` colle la fenêtre en haut, `center` la centre verticalement. */
	align?: "start" | "center";
}) {
	useEffect(() => {
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", escape);
		return () => window.removeEventListener("keydown", escape);
	}, [onClose]);

	return createPortal(
		<div
			className={clsx(
				"animate-veil fixed inset-0 z-50 flex justify-center bg-overlay/70 p-10",
				align === "center" ? "items-center" : "items-start",
			)}
			onClick={onClose}
		>
			{/* Le clic s'arrête à la fenêtre : seul le voile ferme. */}
			<div onClick={(event) => event.stopPropagation()} className="contents">
				{children}
			</div>
		</div>,
		document.body,
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-[11px] font-medium text-ink-muted">{label}</span>
			{children}
			{hint ? (
				<span className="text-[10px] leading-snug text-ink-faint">{hint}</span>
			) : null}
		</label>
	);
}

export function TextInput({
	value,
	onChange,
	onBlur,
	placeholder,
	type = "text",
	mono,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	/** Appelé en quittant le champ — pour enregistrer sans bouton. */
	onBlur?: () => void;
	placeholder?: string;
	type?: "text" | "password";
	mono?: boolean;
	/** Valeur imposée : lisible, mais pas modifiable. */
	disabled?: boolean;
}) {
	return (
		<input
			type={type}
			value={value}
			spellCheck={false}
			autoComplete="off"
			placeholder={placeholder}
			disabled={disabled}
			onChange={(event) => onChange(event.target.value)}
			onBlur={onBlur}
			className={clsx(
				"focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2.5 text-xs text-ink placeholder:text-ink-faint focus:border-accent/40",
				mono && "font-mono",
				disabled && "cursor-not-allowed opacity-50",
			)}
		/>
	);
}

export const severityTone: Record<string, Severity | "neutral"> = {
	critical: "critical",
	warning: "warning",
	success: "success",
	info: "info",
};
