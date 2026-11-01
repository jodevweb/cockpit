import clsx from "clsx";
import { Play } from "lucide-react";
import { LocalImage } from "@/components/LocalImage";
import { PdfThumb } from "@/components/PdfView";
import { localFileUrl } from "@/lib/localFile";
import type { Media } from "@/lib/media";

/**
 * Un visuel en vignette, qu'il vienne du disque ou de la réponse d'un outil.
 *
 * `width` sert au PDF, dont la première page se dessine à la taille voulue ;
 * une image s'ajuste d'elle-même à son cadre.
 */
export function MediaThumb({ media, width, className }: { media: Media; width: number; className?: string }) {
	const frame = clsx("block object-cover object-top", className);
	if (media.kind === "pdf" && media.path) {
		return <PdfThumb path={media.path} width={width} className={frame} />;
	}
	if (media.kind === "video" && media.path) {
		// La première image, sans lire le reste : `#t=` fait chercher une image
		// plutôt que d'afficher un cadre noir.
		return (
			<span className={clsx("relative block bg-void", className)}>
				<video src={`${localFileUrl(media.path)}#t=0.5`} muted preload="metadata" className="h-full w-full object-cover" />
				<span className="absolute inset-0 grid place-items-center">
					<span className="grid size-7 place-items-center rounded-full bg-void/70 text-ink">
						<Play size={12} className="ml-0.5" />
					</span>
				</span>
			</span>
		);
	}
	if (media.src) return <img src={media.src} alt={media.label} loading="lazy" className={frame} />;
	if (media.path) return <LocalImage path={media.path} alt={media.label} className={frame} />;
	return null;
}
