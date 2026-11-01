import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/ipc";
import { isPreview } from "@/lib/preview";

/**
 * L'adresse d'un fichier du poste, telle que la page peut la charger.
 *
 * Dans la fenêtre native, c'est le protocole `asset://`. Hors d'elle, en
 * développement, `convertFileSrc` jette faute de pont : toute image locale
 * cassait l'aperçu. Vite y sert alors le fichier lui-même, dans les limites de
 * ce qu'il autorise.
 */
export function localFileUrl(path: string): string {
	return isPreview() ? `/@fs${path}` : convertFileSrc(path);
}

/**
 * Les octets d'un fichier du poste.
 *
 * `asset://` d'abord, c'est la voie rapide ; il ne couvre que le dossier
 * personnel, et un agent dépose volontiers ses livrables dans `/tmp`. L'IPC
 * prend alors le relais, partout où l'app sait lire.
 */
export async function localFileBytes(path: string): Promise<Uint8Array> {
	try {
		const response = await fetch(localFileUrl(path));
		if (response.ok) return new Uint8Array(await response.arrayBuffer());
	} catch {
		// Hors périmètre ou refusé : l'IPC essaie à son tour.
	}
	const dataUrl = await api.system.fileDataUrl(path);
	const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
