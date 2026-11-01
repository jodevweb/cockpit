import { Image as ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/ipc";
import { localFileUrl } from "@/lib/localFile";
import { basename } from "@/lib/paths";

/**
 * Image locale, avec repli automatique.
 *
 * `asset://` est la voie rapide, mais il dépend d'un périmètre déclaré que la
 * moindre subtilité de chemin — un dossier caché, un accent, un fichier hors du
 * dossier personnel — fait échouer en silence : on ne voit alors qu'une
 * vignette cassée. C'est le cas de tout ce qu'un agent dépose dans `/tmp` ou
 * dans un dossier temporaire du système, là où atterrissent les captures
 * d'écran : le périmètre s'arrête à `$HOME`. Plutôt que d'élargir ce périmètre
 * au disque entier, on rattrape l'échec et on recharge le fichier par l'IPC,
 * qui lui passe partout où l'app peut lire.
 */
export function LocalImage({
	path,
	alt,
	className,
}: {
	path: string;
	alt: string;
	className?: string;
}) {
	const [src, setSrc] = useState(() => localFileUrl(path));
	const [failed, setFailed] = useState(false);

	// Un nouveau fichier repart toujours par la voie rapide.
	useEffect(() => {
		setSrc(localFileUrl(path));
		setFailed(false);
	}, [path]);

	if (failed) {
		return (
			<span className="flex h-full w-full items-center justify-center">
				<ImageIcon size={16} className="text-ink-faint" />
			</span>
		);
	}

	return (
		<img
			src={src}
			alt={alt}
			loading="lazy"
			className={className}
			onError={() => {
				void api.system
					.fileDataUrl(path)
					.then(setSrc)
					.catch(() => setFailed(true));
			}}
		/>
	);
}

/** Extensions qu'on sait afficher telles quelles, partout dans l'app. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];

/** Ce chemin désigne-t-il une image ? */
export function isImagePath(path: string): boolean {
	const extension = basename(path).split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_EXTENSIONS.includes(extension);
}
