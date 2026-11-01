import { ChevronLeft, ChevronRight, FileSearch, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { LocalImage } from "@/components/LocalImage";
import { useFileViewer } from "@/lib/fileViewer";
import { localFileUrl } from "@/lib/localFile";
import { stageOf, type Media } from "@/lib/media";

/**
 * Une image en grand, par-dessus tout.
 *
 * Les cartes montrent leurs images en vignettes : assez pour savoir qu'il y a
 * quelque chose à voir, trop peu pour le voir. Un clic sur une vignette l'ouvre
 * ici à la taille de la fenêtre, et l'on passe de l'avant à l'après aux
 * flèches — c'est en les enchaînant qu'un changement d'écran se juge.
 *
 * L'état vit hors de React : une vignette au fond d'un graphe ou d'un texte
 * Markdown l'ouvre sans qu'on ait à lui faire descendre un rappel.
 */

interface Open {
	media: Media[];
	index: number;
}

let current: Open | null = null;
const listeners = new Set<() => void>();

function set(next: Open | null) {
	current = next;
	for (const listener of listeners) listener();
}

/** Ouvre ces visuels en grand, sur celui qu'on vient de toucher. */
export function openLightbox(media: Media[], index = 0): void {
	// Un PDF se lit page à page dans la visionneuse : il n'a rien à faire ici.
	const shown = media.filter((item) => item.kind !== "pdf");
	if (shown.length === 0) return;
	const wanted = media[index];
	set({ media: shown, index: Math.max(0, shown.indexOf(wanted)) });
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function Lightbox() {
	const open = useSyncExternalStore(subscribe, () => current);
	const { t } = useTranslation("components2");
	const viewer = useFileViewer();
	const count = open?.media.length ?? 0;

	useEffect(() => {
		if (!open) return;
		const step = (delta: number) => {
			if (!current) return;
			const total = current.media.length;
			set({ ...current, index: (current.index + delta + total) % total });
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") set(null);
			else if (event.key === "ArrowLeft") step(-1);
			else if (event.key === "ArrowRight") step(1);
			else return;
			event.preventDefault();
			event.stopPropagation();
		};
		// En capture : Échap ferme l'image avant de fermer le panneau dessous.
		window.addEventListener("keydown", key, true);
		return () => window.removeEventListener("keydown", key, true);
	}, [open !== null]);

	const item = open ? open.media[open.index] : null;
	const stage = item ? stageOf(item) : null;
	const move = (delta: number) => open && set({ ...open, index: (open.index + delta + count) % count });
	const frame = "max-h-[calc(100vh-120px)] max-w-[calc(100vw-140px)] rounded-xl object-contain shadow-pop";

	return (
		<AnimatePresence>
			{open && item ? (
				<motion.div
					key="lightbox"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.16 }}
					className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-overlay/85 backdrop-blur-sm"
					onClick={() => set(null)}
				>
					<div className="absolute top-4 right-4 flex items-center gap-1">
						{item.path && viewer ? (
							<button
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									viewer.open(item.path as string);
									set(null);
								}}
								title={t("lightbox.openInViewer")}
								className="focus-ring grid size-9 place-items-center rounded-full bg-surface text-ink-muted shadow-pop hover:text-ink"
							>
								<FileSearch size={15} />
							</button>
						) : null}
						<button
							type="button"
							onClick={() => set(null)}
							aria-label={t("lightbox.close")}
							className="focus-ring grid size-9 place-items-center rounded-full bg-surface text-ink-muted shadow-pop hover:text-ink"
						>
							<X size={16} />
						</button>
					</div>

					{count > 1 ? (
						<>
							<button
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									move(-1);
								}}
								aria-label={t("lightbox.previous")}
								className="focus-ring absolute left-4 grid size-11 place-items-center rounded-full bg-surface text-ink shadow-pop hover:bg-hover"
							>
								<ChevronLeft size={20} />
							</button>
							<button
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									move(1);
								}}
								aria-label={t("lightbox.next")}
								className="focus-ring absolute right-4 grid size-11 place-items-center rounded-full bg-surface text-ink shadow-pop hover:bg-hover"
							>
								<ChevronRight size={20} />
							</button>
						</>
					) : null}

					{/* Cliquer l'image ne la ferme pas : on y regarde un détail. */}
					<div onClick={(event) => event.stopPropagation()} className="flex flex-col items-center gap-3">
						{item.kind === "video" && item.path ? (
							<video key={item.key} src={localFileUrl(item.path)} controls autoPlay className={frame} />
						) : item.src ? (
							<img key={item.key} src={item.src} alt={item.label} className={frame} />
						) : item.path ? (
							<LocalImage key={item.key} path={item.path} alt={item.label} className={frame} />
						) : null}
						<div className="flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 shadow-pop">
							{stage ? (
								<span className="rounded-full bg-accent-dim px-2 py-0.5 text-[11px] font-semibold text-accent">{stage}</span>
							) : null}
							<span className="max-w-[60vw] truncate font-mono text-[11px] text-ink-muted">{item.label}</span>
							{count > 1 ? (
								<span className="font-mono text-[11px] text-ink-faint tabular-nums">
									{open.index + 1} / {count}
								</span>
							) : null}
						</div>
					</div>
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
