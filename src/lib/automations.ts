import { locale, t } from "@/i18n";
import { lazyList } from "@/lib/language";
import type { Automation, AutomationRun } from "./types";

/**
 * Ce que l'écran des automatisations dit des dates, des états et des sources.
 * Le calendrier lui-même vit dans `automations.rs` ; ce qui est recalculé ici
 * ne sert qu'à prévisualiser un réglage avant qu'il soit enregistré.
 */

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Les jours, du lundi au dimanche, en abrégé dans la langue de l'interface. */
export function dayLabels(): string[] {
	return DAY_KEYS.map((key) => t(`lib:automations.days.${key}`));
}

/**
 * `dayLabels()` sous la forme d'un tableau, pour les écrans qui l'indexent :
 * relu à chaque accès, jamais figé au chargement du module, où la langue n'est
 * pas encore connue.
 */
export const DAY_LABELS: readonly string[] = lazyList(dayLabels);

/** `2026-10-26T14:00`, heure locale, comme le rend le backend. */
export function parseLocal(key: string): Date {
	const [date, time = "00:00"] = key.split("T");
	const [y, m, d] = date.split("-").map(Number);
	const [h, min] = time.split(":").map(Number);
	return new Date(y, m - 1, d, h, min);
}

// Créés à la première demande dans la langue en cours, pas au chargement.
const formats = new Map<string, Intl.DateTimeFormat>();
function format(kind: "day" | "short" | "time"): Intl.DateTimeFormat {
	const key = `${locale()}|${kind}`;
	let found = formats.get(key);
	if (!found) {
		const options: Intl.DateTimeFormatOptions =
			kind === "day"
				? { weekday: "long", day: "numeric", month: "long" }
				: kind === "short"
					? { weekday: "short", day: "numeric", month: "short" }
					: { hour: "2-digit", minute: "2-digit" };
		found = new Intl.DateTimeFormat(locale(), options);
		formats.set(key, found);
	}
	return found;
}

export function hm(date: Date): string {
	return format("time").format(date);
}

export function longDay(date: Date): string {
	const text = format("day").format(date);
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function shortStamp(date: Date): string {
	return `${format("short").format(date)} ${hm(date)}`;
}

/** « Aujourd'hui 13:30 », « Demain 8:50 », « mer. 28 oct. 13:30 ». */
export function relativeStamp(date: Date, now = new Date()): string {
	const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diff = Math.round((day(date) - day(now)) / 86_400_000);
	if (diff === 0) return t("lib:automations.stamp.today", { time: hm(date) });
	if (diff === 1) return t("lib:automations.stamp.tomorrow", { time: hm(date) });
	if (diff === -1) return t("lib:automations.stamp.yesterday", { time: hm(date) });
	return shortStamp(date);
}

/** « Lun · Mer · Ven à 14:00 », « Du lundi au vendredi à 9:00 ». */
export function rhythm(automation: Automation): string {
	const days = [...automation.days].sort();
	if (days.length === 0) return t("lib:automations.rhythm.none");
	if (days.join() === "1,2,3,4,5") return t("lib:automations.rhythm.weekdays", { time: automation.time });
	if (days.length === 7) return t("lib:automations.rhythm.everyDay", { time: automation.time });
	const labels = dayLabels();
	return t("lib:automations.rhythm.days", {
		days: days.map((day) => labels[day - 1]).join(" · "),
		time: automation.time,
	});
}

export type Tone = "accent" | "info" | "warning" | "critical" | "neutral";

export function runLabel(run: AutomationRun): { label: string; tone: Tone } {
	switch (run.state) {
		case "running":
			return { label: t("lib:automations.run.running"), tone: "info" };
		case "partial":
			return { label: t("lib:automations.run.partial"), tone: "warning" };
		case "failed":
			return { label: t("lib:automations.run.failed"), tone: "critical" };
		case "missed":
			return { label: t("lib:automations.run.missed"), tone: "critical" };
		default:
			return run.trigger === "catchUp"
				? { label: t("lib:automations.run.caughtUp"), tone: "info" }
				: run.trigger === "manual"
					? { label: t("lib:automations.run.manual"), tone: "neutral" }
					: { label: t("lib:automations.run.onTime"), tone: "accent" };
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
	// Relu à chaque accès : la langue n'est pas connue au chargement du module.
	get tracker() {
		return t("lib:automations.source.tracker");
	},
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
	get merged() {
		return t("lib:automations.event.merged");
	},
	get opened() {
		return t("lib:automations.event.opened");
	},
	get updated() {
		return t("lib:automations.event.updated");
	},
	get reviewed() {
		return t("lib:automations.event.reviewed");
	},
	get done() {
		return t("lib:automations.event.done");
	},
	get started() {
		return t("lib:automations.event.started");
	},
	get moved() {
		return t("lib:automations.event.moved");
	},
	get canceled() {
		return t("lib:automations.event.canceled");
	},
	get agent() {
		return t("lib:automations.event.agent");
	},
	get git() {
		return t("lib:automations.event.git");
	},
	get resolved() {
		return t("lib:automations.event.resolved");
	},
	get assigned() {
		return t("lib:automations.event.assigned");
	},
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
		const sources = silent.map((source) => SOURCE_LABEL[source.source] ?? source.source).join(", ");
		lines.push(`_${t("lib:automations.markdown.silent", { sources })}_`);
	}
	return lines.join("\n");
}
