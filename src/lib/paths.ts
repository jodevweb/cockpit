/**
 * Les chemins de fichiers, côté interface.
 *
 * Le Rust envoie des chemins à barres obliques (`/`), Windows compris. Les
 * agents, eux, écrivent ce qu'ils voient : sous Windows, Claude Code cite
 * `C:\Users\…\src\app.ts` ou `C:/Users/…`, et parfois `src\app.ts` en relatif.
 * Ces fonctions acceptent les deux séparateurs et les lettres de lecteur ; sur
 * un chemin Unix, elles rendent exactement ce que rendait le découpage sur `/`.
 */

/** `C:\…`, `C:/…` ou `\\serveur\partage` : un chemin Windows absolu. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** Un chemin Windows, à ramener aux barres obliques. */
function looksWindows(path: string): boolean {
	return WINDOWS_ABSOLUTE.test(path) || (path.includes("\\") && !path.includes("/"));
}

/**
 * Le même chemin, séparé par `/`. Un chemin Unix est rendu tel quel — une
 * contre-oblique y est un caractère de nom de fichier, aussi rare soit-il.
 */
export function toSlashes(path: string): string {
	// `\\?\C:\…` : le préfixe « verbatim » d'un chemin canonisé sous Windows.
	const plain = path.replace(/^(?:\\\\|\/\/)\?[\\/](?=[A-Za-z]:)/, "");
	return looksWindows(plain) ? plain.replace(/\\/g, "/") : plain;
}

/** Absolu : `/…`, `~…`, `C:\…`, `C:/…`, `\\serveur\…`. */
export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || path.startsWith("~") || WINDOWS_ABSOLUTE.test(path);
}

/** Les segments, sans les vides : `/a/b/` → `["a", "b"]`, `C:\a\b` → `["C:", "a", "b"]`. */
export function pathParts(path: string): string[] {
	return toSlashes(path).split("/").filter(Boolean);
}

/** Le dernier segment — le nom du fichier ou du dossier — ou le chemin lui-même s'il n'en a pas. */
export function basename(path: string): string {
	return pathParts(path).pop() ?? path;
}

/** Le dossier parent, à barres obliques ; `""` pour un nom seul. */
export function dirname(path: string): string {
	const slashed = toSlashes(path);
	return slashed.slice(0, Math.max(0, slashed.lastIndexOf("/")));
}

/**
 * Un chemin cité, rendu absolu par rapport au dossier de travail : absolu, il
 * reste tel quel (aux séparateurs près) ; relatif, il se pose sur `cwd`. `~`
 * n'est pas traité ici — l'appelant qui le comprend le teste avant.
 */
export function joinPath(cwd: string, path: string): string {
	if (path.startsWith("/") || WINDOWS_ABSOLUTE.test(path)) return toSlashes(path);
	return `${toSlashes(cwd).replace(/\/$/, "")}/${toSlashes(path).replace(/^\.\//, "")}`;
}

/** L'URL `file:` d'un chemin absolu : `file:///Users/…` ou `file:///C:/Users/…`. */
export function fileUrl(path: string): string {
	const slashed = toSlashes(path);
	return /^[A-Za-z]:\//.test(slashed) ? `file:///${slashed}` : `file://${slashed}`;
}

/**
 * Le dossier personnel, deviné d'un chemin absolu — `/Users/moi` sur Mac,
 * `C:/Users/moi` (ou `C:\Users\moi`) sous Windows — de quoi écrire `~` comme un
 * terminal. `""` si le chemin n'est pas sous un dossier personnel.
 */
export function homeOf(path: string): string {
	return /^(?:\/Users\/[^/]+|[A-Za-z]:[\\/][Uu]sers[\\/][^\\/]+)/.exec(path)?.[0] ?? "";
}
