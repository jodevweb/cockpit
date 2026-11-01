import clsx from "clsx";
import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Spinner } from "@/components/ui";

/**
 * Menu de raccourcis d'un onglet de travail.
 *
 * Ce qu'on relance dix fois par jour — un prompt d'agent, un script du dépôt —
 * ne devrait pas se retaper : le menu le met à un clic de l'endroit où on
 * travaille déjà, sans quitter la conversation ni le shell. Le champ de
 * recherche prend le focus à l'ouverture, ce qui donne un second chemin, au
 * clavier : quelques lettres puis Entrée.
 */
export interface QuickAction {
	id: string;
	group: string;
	label: string;
	/** Ligne secondaire : le prompt envoyé, la commande tapée. */
	hint?: string;
	/** Mention de droite, pour ce qui ne part pas tout seul. */
	note?: string;
	run: () => void;
	/** Second geste sur la même entrée — ⇧Entrée au clavier. */
	extra?: {
		icon: React.ComponentType<{ size?: number; className?: string }>;
		title: string;
		run: () => void;
	};
}

export function QuickMenu({
	label,
	icon,
	title,
	actions,
	loading,
	emptyMessage,
	onQuery,
	footer,
	onOpen,
	width = 340,
	align = "left",
}: {
	label: string;
	icon?: React.ComponentType<{ size?: number; className?: string }>;
	title?: string;
	actions: QuickAction[];
	loading?: boolean;
	emptyMessage: string;
	/**
	 * Ce qu'on peut faire de la saisie elle-même, quand elle ne désigne rien
	 * de connu.
	 *
	 * Une recherche qui ne trouve rien n'est pas toujours une erreur de frappe :
	 * on colle souvent le nom de quelque chose qui n'existe pas *encore ici* —
	 * la branche d'un collègue, par exemple. Rendre une action ici transforme le
	 * cul-de-sac en point de départ, plutôt que de renvoyer l'utilisateur
	 * chercher le bon écran.
	 */
	onQuery?: (query: string) => QuickAction | null;
	footer?: ReactNode;
	/** Appelé à chaque ouverture : la liste ne se charge qu'au besoin. */
	onOpen?: () => void;
	width?: number;
	/** Bord sur lequel le panneau s'aligne — « right » quand le bouton est
	    lui-même collé à droite, où un panneau aligné à gauche déborderait. */
	align?: "left" | "right";
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const box = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLInputElement>(null);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return actions;
		return actions.filter((action) =>
			`${action.group} ${action.label} ${action.hint ?? ""}`.toLowerCase().includes(needle),
		);
	}, [actions, query]);

	// Ce que la saisie permet de faire à elle seule — mais seulement quand rien
	// ne correspond. Le proposer à côté des correspondances en ferait un piège :
	// taper « invitation » pour retrouver la branche d'un collègue afficherait
	// aussi « créer une branche nommée invitation », à une touche Entrée de
	// distance.
	const proposition = useMemo(
		() =>
			query.trim() && filtered.length === 0 ? (onQuery?.(query.trim()) ?? null) : null,
		[filtered.length, onQuery, query],
	);
	const visibles = useMemo(
		() => (proposition ? [...filtered, proposition] : filtered),
		[filtered, proposition],
	);

	// Le curseur désigne une position dans la liste filtrée : la frappe suivante
	// la redécoupe, il repart donc du haut.
	useEffect(() => setCursor(0), [query]);

	useEffect(() => {
		if (!open) return;
		field.current?.focus();
		const dismiss = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", dismiss);
		window.addEventListener("keydown", escape);
		return () => {
			window.removeEventListener("mousedown", dismiss);
			window.removeEventListener("keydown", escape);
		};
	}, [open]);

	const toggle = () => {
		const next = !open;
		setOpen(next);
		setQuery("");
		if (next) onOpen?.();
	};

	const choose = (action: QuickAction, secondary: boolean) => {
		setOpen(false);
		setQuery("");
		if (secondary && action.extra) action.extra.run();
		else action.run();
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setCursor((value) => Math.min(visibles.length - 1, Math.max(0, value + step)));
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const action = visibles[cursor];
			// ⇧Entrée déclenche le second geste — envoyer sans relire, par exemple.
			if (action) choose(action, event.shiftKey || event.metaKey);
		}
	};

	return (
		<div ref={box} className="relative">
			<Button
				size="sm"
				icon={icon ?? ChevronDown}
				title={title}
				onClick={toggle}
				active={open}
			>
				{label}
			</Button>

			{open ? (
				<div
					style={{ width }}
					className={clsx(
						"panel animate-in absolute top-7 z-50 flex max-h-96 flex-col overflow-hidden p-1 shadow-xl shadow-black/40",
						align === "right" ? "right-0" : "left-0",
					)}
				>
					<div className="relative shrink-0 p-1">
						<Search
							size={12}
							className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
						/>
						<input
							ref={field}
							value={query}
							spellCheck={false}
							placeholder="Chercher…"
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={onKeyDown}
							className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-void pr-2 pl-7 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent/40"
						/>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto">
						{loading && actions.length === 0 ? (
							<div className="flex justify-center py-6">
								<Spinner />
							</div>
						) : visibles.length === 0 ? (
							<p className="px-2 py-6 text-center text-[11px] text-ink-faint">
								{query.trim() ? "Rien à ce nom." : emptyMessage}
							</p>
						) : (
							visibles.map((action, index) => (
								<QuickRow
									key={action.id}
									action={action}
									// L'entête n'apparaît qu'au changement de groupe : la liste
									// filtrée reste ainsi un seul index, celui du curseur.
									header={index === 0 || visibles[index - 1].group !== action.group}
									focused={index === cursor}
									onHover={() => setCursor(index)}
									onChoose={(secondary) => choose(action, secondary)}
								/>
							))
						)}
					</div>

					{footer ? (
						<div className="shrink-0 border-t border-line-soft px-2 py-1.5 text-[10px] leading-snug text-ink-faint">
							{footer}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function QuickRow({
	action,
	header,
	focused,
	onHover,
	onChoose,
}: {
	action: QuickAction;
	header: boolean;
	focused: boolean;
	onHover: () => void;
	onChoose: (secondary: boolean) => void;
}) {
	const row = useRef<HTMLDivElement>(null);
	const Extra = action.extra?.icon;

	// Le curseur se déplace aussi au clavier : sans ça il sortirait du cadre.
	useEffect(() => {
		if (focused) row.current?.scrollIntoView({ block: "nearest" });
	}, [focused]);

	return (
		<>
			{header ? (
				<div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
					{action.group}
				</div>
			) : null}
			<div
				ref={row}
				onMouseEnter={onHover}
				className={clsx(
					"group flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors",
					focused && "bg-hover",
				)}
			>
				<button
					type="button"
					onClick={() => onChoose(false)}
					className="focus-ring min-w-0 flex-1 rounded text-left"
				>
					<span className="block truncate text-[11px] text-ink">{action.label}</span>
					{action.hint ? (
						<span className="block truncate font-mono text-[10px] text-ink-faint">
							{action.hint}
						</span>
					) : null}
				</button>
				{action.note ? (
					<span className="shrink-0 text-[10px] text-ink-faint">{action.note}</span>
				) : null}
				{Extra && action.extra ? (
					<button
						type="button"
						title={`${action.extra.title} (⇧Entrée)`}
						onClick={() => onChoose(true)}
						className={clsx(
							"focus-ring shrink-0 rounded p-1 text-ink-faint transition-opacity hover:text-accent-soft",
							focused ? "opacity-100" : "opacity-0 group-hover:opacity-100",
						)}
					>
						<Extra size={11} />
					</button>
				) : null}
			</div>
		</>
	);
}
