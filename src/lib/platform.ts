/**
 * La plateforme sous l'interface : macOS ou le reste (Windows, en pratique).
 *
 * Trois choses en dépendent et rien d'autre : la touche des raccourcis (⌘ sur
 * Mac, Ctrl ailleurs), la façon de les écrire (« ⌘⇧C » contre « Ctrl+Shift+C »)
 * et la barre de titre (superposée aux boutons de fenêtre sur Mac, native
 * ailleurs). Tout passe par ici : un `event.metaKey` écrit en dur est un
 * raccourci mort sous Windows, où la touche Windows n'arrive pas à la page.
 *
 * La détection lit l'agent utilisateur de la webview — WKWebView dit
 * « Macintosh », WebView2 « Windows NT ». `localStorage["cockpit.platform"]`
 * (`mac` ou `windows`) la force : de quoi regarder l'interface Windows dans un
 * navigateur sur Mac avant de livrer.
 */

function detectMac(): boolean {
	try {
		const forced = localStorage.getItem("cockpit.platform");
		if (forced === "mac") return true;
		if (forced === "windows") return false;
	} catch {
		// Pas de stockage (mode privé) : on lit l'agent.
	}
	if (typeof navigator === "undefined") return true;
	const hints = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
	const source = `${hints ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
	return /mac|iphone|ipad|ipod/i.test(source);
}

/** macOS (et iPadOS, pour l'appli mobile) : ⌘, symboles, barre de titre superposée. */
export const isMac = detectMac();

/** Windows : l'Explorateur au lieu du Finder, `\` dans les chemins des agents. */
export const isWindows = !isMac && typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent ?? "");

/** Le nom de la touche de commande, seul : « ⌘ » ou « Ctrl ». */
export const modLabel = isMac ? "⌘" : "Ctrl";
/** « ⌥ » ou « Alt ». */
export const altLabel = isMac ? "⌥" : "Alt";
/** « ⇧ » ou « Shift ». */
export const shiftLabel = isMac ? "⇧" : "Shift";
/** La touche Contrôle elle-même — celle qui interrompt un terminal : « ⌃ » ou « Ctrl ». */
export const ctrlLabel = isMac ? "⌃" : "Ctrl";
/** « ↵ » ou « Enter ». */
export const enterLabel = isMac ? "↵" : "Enter";

/**
 * La touche de commande de l'app est-elle enfoncée ?
 *
 * Sur Mac, ⌘. Ailleurs, Ctrl — mais pas n'importe lequel :
 * - Ctrl+Alt, c'est AltGr sur un clavier européen : « @ », « { », « € »… Un
 *   caractère qu'on tape, pas un raccourci.
 * - Dans un terminal, Ctrl+lettre appartient au shell (Ctrl+P remonte
 *   l'historique, Ctrl+K coupe la ligne, Ctrl+N descend). Seuls les raccourcis
 *   avec Maj y restent à l'app, comme dans Windows Terminal.
 * Ctrl+C/V/X/A/Z ne servent à aucun raccourci de l'app : ils restent au champ
 * de saisie qui a le focus.
 */
export function modKey(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; target?: EventTarget | null }): boolean {
	if (isMac) return event.metaKey;
	if (!event.ctrlKey || event.altKey || event.metaKey) return false;
	if (!event.shiftKey && insideTerminal(event.target)) return false;
	return true;
}

/** Le focus est-il dans un terminal xterm ? */
export function insideTerminal(target: EventTarget | null | undefined): boolean {
	return target instanceof Element && target.closest(".xterm") !== null;
}

/**
 * AltGr sous Windows : la webview le rapporte comme Ctrl+Alt. La frappe
 * produit un caractère et doit être traitée comme du texte.
 */
export function isAltGraph(event: { ctrlKey: boolean; altKey: boolean; getModifierState?(key: string): boolean }): boolean {
	if (isMac) return false;
	if (event.getModifierState?.("AltGraph")) return true;
	return event.ctrlKey && event.altKey;
}

const SYMBOLS: Record<string, string> = { "⌘": modLabel, "⌥": altLabel, "⇧": shiftLabel, "⌃": ctrlLabel };
const KEYS: Record<string, string> = { "↵": enterLabel, "⏎": enterLabel };

/**
 * Un raccourci écrit à la façon du Mac, rendu pour la plateforme :
 * `formatShortcut("⌘⇧C")` donne « ⌘⇧C » sur Mac, « Ctrl+Shift+C » ailleurs ;
 * `formatShortcut("⌘↵")` donne « ⌘↵ » ou « Ctrl+Enter ».
 */
export function formatShortcut(mac: string): string {
	if (isMac) return mac;
	const parts: string[] = [];
	let rest = mac;
	while (rest && SYMBOLS[rest[0]]) {
		parts.push(SYMBOLS[rest[0]]);
		rest = rest.slice(1);
	}
	rest = rest.trim();
	if (rest) parts.push(KEYS[rest] ?? rest.replace(/[↵⏎]/g, enterLabel));
	return parts.join("+");
}

/**
 * Les touches, prêtes pour les catalogues de traduction : `{{mod}}{{shift}}C`
 * donne « ⌘⇧C » sur Mac, « Ctrl+Shift+C » ailleurs. Les modificateurs portent
 * leur « + » sous Windows ; `{{modKey}}`, `{{altKey}}`, `{{shiftKey}}` sont
 * les noms seuls, pour « {{modKey}}-clic ». Passés à i18next comme variables
 * par défaut : chaque `t()` les connaît sans qu'on les lui donne.
 */
export const shortcutVariables = {
	mod: isMac ? "⌘" : "Ctrl+",
	alt: isMac ? "⌥" : "Alt+",
	shift: isMac ? "⇧" : "Shift+",
	ctrl: isMac ? "⌃" : "Ctrl+",
	enter: enterLabel,
	modKey: modLabel,
	altKey: altLabel,
	shiftKey: shiftLabel,
};

/**
 * La valeur de `data-tauri-drag-region` des zones qui tiennent lieu de barre
 * de titre. Sur Mac, la barre est superposée au contenu : ces zones déplacent
 * la fenêtre. Ailleurs, la fenêtre garde sa barre native ; l'attribut n'est
 * pas posé (`undefined` n'est pas rendu), pour qu'un en-tête ne soit pas une
 * seconde poignée qui avale les clics.
 */
export const dragRegion: "deep" | undefined = isMac ? "deep" : undefined;

/**
 * Le contexte i18next des textes qui nomment le système : `t("x.reveal",
 * { context: platformContext })` lit `reveal_windows` hors du Mac — « Explorateur
 * de fichiers » au lieu de « Finder » — et `reveal` sur Mac.
 */
export const platformContext: "windows" | undefined = isMac ? undefined : "windows";
