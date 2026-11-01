import type { Turn } from "@/app/agents";

/**
 * Où tu as rangé chacun de tes messages : suite de la consigne en cours, ou
 * nouvelle consigne.
 *
 * Le choix se fait à l'envoi, mais le journal de Claude Code ne le garde pas :
 * une conversation relue depuis le disque retombait sur la règle du « ? » final,
 * et la carte changeait de forme après un redémarrage. On le garde donc ici,
 * par conversation, sous le début du message — la seule chose que le fil en
 * direct et le journal relu aient en commun.
 */

const PREFIX = "cockpit.suites.";

function keyOf(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function read(session: string): Record<string, boolean> {
	try {
		const raw = localStorage.getItem(PREFIX + session);
		return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
	} catch {
		return {};
	}
}

/** Retient où ce message a été rangé. */
export function rememberFollows(session: string, text: string, follows: boolean): void {
	try {
		const marks = read(session);
		marks[keyOf(text)] = follows;
		localStorage.setItem(PREFIX + session, JSON.stringify(marks));
	} catch {
		// Stockage plein ou indisponible : la règle par défaut reprend la main.
	}
}

/** Rend à chaque message relu le choix fait à son envoi, quand on l'a gardé. */
export function withFollows(turns: Turn[], session: string | null): Turn[] {
	if (!session) return turns;
	const marks = read(session);
	if (Object.keys(marks).length === 0) return turns;
	return turns.map((turn) => {
		if (turn.kind !== "user" || turn.follows !== undefined) return turn;
		const mark = marks[keyOf(turn.text)];
		return mark === undefined ? turn : { ...turn, follows: mark };
	});
}
