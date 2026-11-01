import { api } from "@/lib/ipc";

/**
 * Double-clic sur une barre de titre : plein écran de travail.
 *
 * Tauri branche déjà le double-clic des zones `data-tauri-drag-region` sur sa
 * maximisation, qui délègue au zoom d'AppKit. Celui-ci s'arrête à quelques
 * pixels des bords et macOS considère alors la fenêtre déjà zoomée : le
 * double-clic suivant la rétrécissait au lieu de finir le travail, si bien
 * qu'on ne pouvait jamais occuper tout l'écran.
 *
 * On intercepte donc l'événement avant lui — en phase de capture, la
 * propagation stoppée n'atteint jamais son écouteur, posé sur `document` en
 * phase de bulle — et on applique nous-mêmes la zone de travail du moniteur.
 *
 * Le geste de déplacement, lui, reste celui de Tauri : seul le double-clic
 * change de mains.
 */

const CLICKABLE = new Set([
	"A",
	"BUTTON",
	"INPUT",
	"SELECT",
	"TEXTAREA",
	"LABEL",
	"SUMMARY",
]);
const INTERACTIVE_ROLES = new Set([
	"button",
	"link",
	"menuitem",
	"tab",
	"checkbox",
	"radio",
	"switch",
	"option",
]);

function clickable(element: HTMLElement): boolean {
	return (
		CLICKABLE.has(element.tagName) ||
		(element.hasAttribute("contenteditable") &&
			element.getAttribute("contenteditable") !== "false") ||
		(element.hasAttribute("tabindex") && element.getAttribute("tabindex") !== "-1") ||
		INTERACTIVE_ROLES.has(element.getAttribute("role") ?? "")
	);
}

/** Mêmes règles que Tauri : `deep` couvre le sous-arbre, `false` bloque. */
function isDragRegion(path: EventTarget[]): boolean {
	for (const entry of path) {
		if (!(entry instanceof HTMLElement)) continue;
		const attribute = entry.getAttribute("data-tauri-drag-region");
		if (clickable(entry) && attribute === null) return false;
		if (attribute === null) continue;
		if (attribute === "false") return false;
		if (attribute === "deep") return true;
		if (attribute === "" || attribute === "true") return entry === path[0];
	}
	return false;
}

export function installWindowZoom() {
	document.addEventListener(
		"mouseup",
		(event) => {
			if (event.button !== 0 || event.detail !== 2) return;
			if (!isDragRegion(event.composedPath())) return;
			// Coupe la route à la maximisation de Tauri, qui ferait l'inverse.
			event.stopPropagation();
			void api.system.zoomToggle().catch(() => undefined);
		},
		true,
	);
}
