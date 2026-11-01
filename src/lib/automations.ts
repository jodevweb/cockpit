import type { Automation, AutomationRun } from "./types";

/**
 * Ce que l'écran des automatisations dit des dates, des états et des sources.
 * Le calendrier lui-même vit dans `automations.rs` ; ce qui est recalculé ici
 * ne sert qu'à prévisualiser un réglage avant qu'il soit enregistré.
 */

export const DAY_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** `2026-10-26T14:00`, heure locale, comme le rend le backend. */
export function parseLocal(key: string): Date {
	const [date, time = "00:00"] = key.split("T");
	const [y, m, d] = date.split("-").map(Number);
	const [h, min] = time.split(":").map(Number);
	return new Date(y, m - 1, d, h, min);
}

const dayFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const shortFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const timeFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function hm(date: Date): string {
	return timeFormat.format(date);
}

export function longDay(date: Date): string {
	const text = dayFormat.format(date);
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function shortStamp(date: Date): string {
	return `${shortFormat.format(date)} ${hm(date)}`;
}

/** « Aujourd'hui 13:30 », « Demain 8:50 », « mer. 28 oct. 13:30 ». */
export function relativeStamp(date: Date, now = new Date()): string {
	const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diff = Math.round((day(date) - day(now)) / 86_400_000);
	if (diff === 0) return `aujourd'hui ${hm(date)}`;
	if (diff === 1) return `demain ${hm(date)}`;
	if (diff === -1) return `hier ${hm(date)}`;
	return shortStamp(date);
}

/** « Lun · Mer · Ven à 14:00 », « Du lundi au vendredi à 9:00 ». */
export function rhythm(automation: Automation): string {
	const days = [...automation.days].sort();
	if (days.length === 0) return "Aucun jour choisi";
	if (days.join() === "1,2,3,4,5") return `Du lundi au vendredi à ${automation.time}`;
	if (days.length === 7) return `Tous les jours à ${automation.time}`;
	return `${days.map((day) => DAY_LABELS[day - 1]).join(" · ")} à ${automation.time}`;
}

export type Tone = "accent" | "info" | "warning" | "critical" | "neutral";

export function runLabel(run: AutomationRun): { label: string; tone: Tone } {
	switch (run.state) {
		case "running":
			return { label: "En cours", tone: "info" };
		case "partial":
			return { label: "Partielle", tone: "warning" };
		case "failed":
			return { label: "Échec", tone: "critical" };
		case "missed":
			return { label: "Manquée", tone: "critical" };
		default:
			return run.trigger === "catchUp"
				? { label: "Rattrapée", tone: "info" }
				: run.trigger === "manual"
					? { label: "À la main", tone: "neutral" }
					: { label: "À l'heure", tone: "accent" };
	}
}

export const TONE_CLASS: Record<Tone, string> = {
	accent: "bg-accent-dim text-accent",
	info: "bg-info/12 text-info",
	warning: "bg-warning/15 text-warning",
	critical: "bg-critical/10 text-critical",
	neutral: "bg-raised text-ink-muted",
};

export const SOURCE_LABEL: Record<string, string> = {
	github: "GitHub",
	tracker: "Suivi de tâches",
	cockpit: "Cockpit",
	sentry: "Sentry",
};

/** Couleur d'une source dans les barres de provenance, lisible dans les deux thèmes. */
export const SOURCE_COLOR: Record<string, string> = {
	github: "var(--color-ink)",
	tracker: "var(--color-info)",
	cockpit: "var(--color-accent)",
	sentry: "var(--color-warning)",
};

/** Ce qui est arrivé à un élément, dit en clair. */
export const EVENT_LABEL: Record<string, string> = {
	merged: "PR fusionnée",
	opened: "PR ouverte",
	updated: "PR mise à jour",
	reviewed: "PR relue",
	done: "Ticket terminé",
	started: "Ticket en cours",
	moved: "Ticket déplacé",
	canceled: "Ticket annulé",
	agent: "Agents",
	git: "Geste git",
	resolved: "Erreur résolue",
	assigned: "Erreur assignée",
};

/**
 * Les prochains rendez-vous d'un réglage pas encore enregistré, avec la
 * période que chacun couvrira. Même règle que `automations::upcoming`.
 */
export function previewSchedule(
	draft: Pick<Automation, "days" | "time" | "leadMinutes" | "window">,
	now = new Date(),
	count = 3,
): Array<{ occurrence: Date; ready: Date; from: Date }> {
	const [h, m] = draft.time.split(":").map(Number);
	if (Number.isNaN(h) || draft.days.length === 0) return [];
	const all: Date[] = [];
	for (let offset = -14; offset < 60; offset++) {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m || 0);
		const iso = ((day.getDay() + 6) % 7) + 1;
		if (draft.days.includes(iso)) all.push(day);
	}
	const lead = draft.leadMinutes * 60_000;
	const result: Array<{ occurrence: Date; ready: Date; from: Date }> = [];
	all.forEach((occurrence, index) => {
		const ready = new Date(occurrence.getTime() - lead);
		if (ready <= now || result.length >= count) return;
		const previous = all[index - 1];
		const from =
			draft.window === "day" || !previous
				? new Date(ready.getTime() - 86_400_000)
				: new Date(previous.getTime() - lead);
		result.push({ occurrence, ready, from });
	});
	return result;
}

/** Le texte d'un rendu, à coller dans Slack ou un document. */
export function runMarkdown(name: string, run: AutomationRun): string {
	const lines = [`# ${name} — ${longDay(new Date(run.to))}`, ""];
	if (run.headline) lines.push(run.headline, "");
	const byId = new Map(run.items.map((item) => [item.id, item]));
	for (const part of run.parts) {
		const kept = part.lines.filter((line) => !run.dropped.includes(line.id));
		lines.push(`## ${part.title}`);
		if (kept.length === 0) lines.push("- —");
		for (const line of kept) {
			const links = line.refs
				.map((ref) => byId.get(ref))
				.filter((item) => item?.url)
				.map((item) => `[${item!.id.replace(/^\w+:/, "")}](${item!.url})`);
			lines.push(`- **${line.title}**${line.detail ? ` — ${line.detail}` : ""}${links.length ? ` (${links.join(", ")})` : ""}`);
		}
		lines.push("");
	}
	const silent = run.sources.filter((source) => source.state === "silent");
	if (silent.length > 0) {
		lines.push(`_Sans réponse cette fois : ${silent.map((source) => SOURCE_LABEL[source.source] ?? source.source).join(", ")}._`);
	}
	return lines.join("\n");
}
