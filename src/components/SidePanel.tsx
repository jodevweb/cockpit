import clsx from "clsx";
import { Maximize2, Minimize2, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { usePersistentState } from "@/lib/useAsync";

/**
 * Le panneau qui s'ouvre sur la carte d'un agent : le détail d'une étape, ou
 * une tuile agrandie.
 *
 * Il faisait 460 px quelle que soit la fenêtre : un diff, une revue ou une
 * capture s'y lisaient par le trou d'une serrure. Il prend désormais la moitié
 * de la carte, se tire par son bord — la largeur choisie est retenue — et
 * passe en plein cadre d'un bouton.
 */

const MIN_WIDTH = 380;

export function SidePanel({
	panelKey,
	eyebrow,
	title,
	actions,
	banner,
	footer,
	flush,
	onClose,
	onLayout,
	children,
}: {
	/** Change quand le contenu change de nature : le panneau rejoue son entrée. */
	panelKey: string;
	eyebrow: string;
	title: string;
	/** Des gestes propres au contenu, à gauche des boutons du panneau. */
	actions?: ReactNode;
	banner?: ReactNode;
	footer?: ReactNode;
	/** Le contenu gère lui-même son défilement et ses marges. */
	flush?: boolean;
	onClose: () => void;
	/**
	 * La place que le panneau prend, et celle du cadre qui le porte — `0` quand
	 * il se ferme. Ce qui flotte sur la carte s'en sert pour ne pas finir dessous.
	 */
	onLayout?: (width: number, frame: number) => void;
	children: ReactNode;
}) {
	// `null` : la largeur par défaut, relative à la carte.
	const [width, setWidth] = usePersistentState<number | null>("agent.panel.width", null);
	const [full, setFull] = usePersistentState("agent.panel.full", false);
	const panel = useRef<HTMLElement>(null);

	useEffect(() => {
		const node = panel.current;
		const frame = node?.parentElement;
		if (!node || !frame || !onLayout) return;
		const report = () => onLayout(node.offsetWidth, frame.clientWidth);
		report();
		const observer = new ResizeObserver(report);
		observer.observe(node);
		observer.observe(frame);
		return () => {
			observer.disconnect();
			onLayout(0, 0);
		};
	}, [onLayout]);

	// Le glisser-déposer HTML5 ne passe pas dans le webview : événements de pointeur.
	const drag = (event: React.PointerEvent<HTMLDivElement>) => {
		const node = panel.current;
		const frame = node?.parentElement;
		if (!node || !frame) return;
		event.preventDefault();
		const handle = event.currentTarget;
		handle.setPointerCapture(event.pointerId);
		const right = node.getBoundingClientRect().right;
		const most = frame.getBoundingClientRect().width - 24;
		const move = (moving: PointerEvent) => {
			setWidth(Math.round(Math.min(most, Math.max(MIN_WIDTH, right - moving.clientX))));
		};
		const stop = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", stop);
			handle.removeEventListener("pointercancel", stop);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", stop);
		handle.addEventListener("pointercancel", stop);
	};

	return (
		<motion.aside
			ref={panel}
			key={panelKey}
			initial={{ opacity: 0, x: 28 }}
			animate={{ opacity: 1, x: 0 }}
			exit={{ opacity: 0, x: 28 }}
			transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
			style={
				full
					? undefined
					: { width: width ? `min(${width}px, calc(100% - 24px))` : "min(max(52%, 560px), calc(100% - 24px))" }
			}
			className={clsx(
				"absolute top-3 right-3 bottom-3 z-20 flex flex-col overflow-hidden rounded-2xl bg-surface shadow-pop",
				full && "left-3",
			)}
		>
			{full ? null : (
				<div
					onPointerDown={drag}
					onDoubleClick={() => setWidth(null)}
					title="Tirer pour élargir — double-clic pour la largeur d'origine"
					className="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize"
				>
					<span className="absolute inset-y-6 left-0.5 w-0.5 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-60" />
				</div>
			)}
			<div className="flex items-start gap-2 border-b border-line-soft px-4 py-3">
				<div className="min-w-0 flex-1">
					<div className="font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">{eyebrow}</div>
					<div className="truncate text-[13px] font-semibold text-ink">{title}</div>
				</div>
				{actions}
				<button
					type="button"
					onClick={() => setFull(!full)}
					className="focus-ring grid size-6 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
					title={full ? "Revenir à côté de la carte" : "Plein cadre"}
					aria-label={full ? "Revenir à côté de la carte" : "Plein cadre"}
				>
					{full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
				</button>
				<button
					type="button"
					onClick={onClose}
					className="focus-ring grid size-6 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
					aria-label="Fermer"
				>
					<X size={13} />
				</button>
			</div>
			{banner}
			<div className={clsx("min-h-0 flex-1", flush ? "flex flex-col" : "overflow-y-auto")}>{children}</div>
			{footer}
		</motion.aside>
	);
}
