import type {
	Automation,
	AutomationItem,
	AutomationOverview,
	AutomationPart,
	AutomationRun,
	AutomationRunState,
	AutomationTrigger,
} from "./types";

/**
 * Les automatisations de l'aperçu : un daily, une revue du matin, et un
 * historique qui montre chacun des états — à l'heure, rattrapée, partielle,
 * manquée. Les dates se calculent depuis maintenant, pour que la frise de la
 * semaine ait toujours quelque chose à montrer.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const key = (date: Date) =>
	`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

function occurrences(days: number[], time: string, from: Date, count: number, direction: 1 | -1): Date[] {
	const [h, m] = time.split(":").map(Number);
	const found: Date[] = [];
	const cursor = new Date(from);
	for (let step = 0; step < 60 && found.length < count; step++) {
		const day = new Date(cursor);
		day.setDate(cursor.getDate() + step * direction);
		day.setHours(h, m, 0, 0);
		const iso = ((day.getDay() + 6) % 7) + 1;
		if (!days.includes(iso)) continue;
		if (direction === 1 ? day > from : day <= from) found.push(day);
	}
	return found;
}

const daily: Automation = {
	id: "auto-daily",
	name: "Mon daily",
	template: "daily",
	days: [1, 3, 5],
	time: "14:00",
	leadMinutes: 30,
	window: "since",
	sources: { github: true, tracker: true, cockpit: true, sentry: true },
	prompt:
		"Résume ce que j'ai fait sur la période, pour le daily de l'équipe. Quatre parties : Livré, En cours, Bloqué, Ensuite. Une ligne par sujet ; regroupe une PR et le ticket qu'elle traite. Pas de jargon interne au code : l'équipe produit écoute aussi.",
	catchUp: true,
	notify: true,
	enabled: true,
	createdAt: "2026-09-01T08:00:00Z",
	corrections: [{ at: "2026-10-21T12:10:00Z", text: "Ne cite pas les PR de dépendances." }],
	pdf: true,
	slackWebhook: "••••••••",
};

const morning: Automation = {
	...daily,
	id: "auto-revue",
	name: "Revue du matin",
	template: "blank",
	days: [1, 2, 3, 4, 5],
	time: "09:00",
	leadMinutes: 10,
	sources: { github: true, tracker: false, cockpit: false, sentry: false },
	corrections: [],
	pdf: false,
	slackWebhook: "",
	prompt: "Les PR qui attendent ma relecture, de la plus ancienne à la plus récente, avec ce qui a bougé cette nuit.",
};

const ITEMS: AutomationItem[] = [
	{ id: "gh:northwind/storefront#412", source: "github", title: "Catalog: add a product and its product page", url: "https://github.com/northwind/storefront/pull/412", event: "merged", detail: "northwind/storefront · PR #412 · closed", at: "" },
	{ id: "tk:NW-3514", source: "tracker", title: "Catalog: adding a product and its product page", url: "https://linear.app/northwind/issue/NW-3514", event: "done", detail: "NW-3514 · En recette · Catalog", at: "" },
	{ id: "gh:northwind/storefront#418", source: "github", title: "Loyalty: rebase onto main", url: "https://github.com/northwind/storefront/pull/418", event: "updated", detail: "northwind/storefront · PR #418 · open", at: "" },
	{ id: "ck:storefront-loyalty", source: "cockpit", title: "Agents dans storefront-loyalty", url: "", event: "agent", detail: "6 tours · 41 min", at: "" },
	{ id: "gh:northwind/storefront#421", source: "github", title: "Product search filters", url: "https://github.com/northwind/storefront/pull/421", event: "opened", detail: "northwind/storefront · PR #421 · open", at: "" },
	{ id: "tk:NW-3530", source: "tracker", title: "Loyalty points ledger: schema", url: "https://linear.app/northwind/issue/NW-3530", event: "moved", detail: "NW-3530 · Bloqué · Loyalty", at: "" },
	{ id: "gh:northwind/storefront#409", source: "github", title: "Dependency bump", url: "https://github.com/northwind/storefront/pull/409", event: "reviewed", detail: "northwind/storefront · PR #409 · open", at: "" },
	{ id: "tk:NW-3541", source: "tracker", title: "Checkout v2: QA", url: "https://linear.app/northwind/issue/NW-3541", event: "started", detail: "NW-3541 · En cours · Checkout", at: "" },
];

const PARTS: AutomationPart[] = [
	{
		title: "Livré",
		lines: [
			{ id: "p0l0", title: "Catalog: adding a product and its product page", detail: "Merged, the ticket moved to QA.", refs: ["gh:northwind/storefront#412", "tk:NW-3514"], unsourced: false },
			{ id: "p0l1", title: "Loyalty: branch up to date with main", detail: "Conflicts resolved by an agent, CI back to green.", refs: ["gh:northwind/storefront#418", "ck:storefront-loyalty"], unsourced: false },
		],
	},
	{
		title: "En cours",
		lines: [
			{ id: "p1l0", title: "Product search filters", detail: "PR open, one review requested.", refs: ["gh:northwind/storefront#421"], unsourced: false },
			{ id: "p1l1", title: "Checkout v2", detail: "QA on staging still to do.", refs: ["tk:NW-3541"], unsourced: false },
		],
	},
	{
		title: "Bloqué",
		lines: [
			{ id: "p2l0", title: "Loyalty points ledger: the schema", detail: "Question asked Thursday in the ticket, no answer yet.", refs: ["tk:NW-3530"], unsourced: false },
			{ id: "p2l1", title: "Dependency bump", detail: "Reviewed, nothing to tell the team.", refs: ["gh:northwind/storefront#409"], unsourced: false },
		],
	},
	{
		title: "Ensuite",
		lines: [
			{ id: "p3l0", title: "Checkout QA, then merge", detail: "By Wednesday.", refs: ["tk:NW-3541"], unsourced: false },
			{ id: "p3l1", title: "Sync with the product team on the points ledger", detail: "Proposed, not scheduled yet.", refs: [], unsourced: true },
		],
	},
];

function run(
	automation: Automation,
	occurrence: Date,
	state: AutomationRunState,
	trigger: AutomationTrigger | null,
	previous: Date,
	offsetMinutes: number,
	extra: Partial<AutomationRun> = {},
): AutomationRun {
	const ready = new Date(occurrence.getTime() - automation.leadMinutes * 60_000 + offsetMinutes * 60_000);
	const done = new Date(ready.getTime() + 108_000);
	const from = new Date(previous.getTime() - automation.leadMinutes * 60_000);
	const finished = state === "ready" || state === "partial";
	return {
		id: `run-${occurrence.getTime().toString(16)}`,
		automation: automation.id,
		occurrence: key(occurrence),
		trigger,
		state,
		from: from.toISOString(),
		to: ready.toISOString(),
		startedAt: ready.toISOString(),
		endedAt: state === "missed" ? ready.toISOString() : done.toISOString(),
		sources: finished
			? [
					{ source: "github", state: "read", count: 5, note: "" },
					state === "partial"
						? { source: "tracker", state: "silent", count: 0, note: "Linear 401 : jeton expiré" }
						: { source: "tracker", state: "read", count: 3, note: "" },
					{ source: "cockpit", state: "read", count: 1, note: "" },
					{ source: "sentry", state: "unconfigured", count: 0, note: "aucun jeton Sentry dans les réglages" },
				]
			: [],
		headline: finished ? "A week focused on the catalog and loyalty points; the points ledger is waiting on a decision." : "",
		items: finished ? ITEMS : [],
		parts: finished ? PARTS : [],
		dropped: finished ? ["p2l1"] : [],
		valuation: finished ? { usd: 0.21, provenance: "cli" } : null,
		durationMs: finished ? 108_000 : 0,
		viewer: "bob",
		exports: finished && automation.pdf ? [`/Users/demo/.config/cockpit/automations/${automation.id}/rendu.pdf`] : [],
		postedAt: "",
		reason:
			state === "missed"
				? "Le cockpit était fermé jusqu'après le rendez-vous."
				: state === "failed"
					? "Claude n'a pas répondu en 300 s."
					: "",
		...extra,
	};
}

export function previewAutomations(): AutomationOverview[] {
	const now = new Date();
	const past = occurrences(daily.days, daily.time, now, 6, -1);
	const states: Array<[AutomationRunState, AutomationTrigger | null, number]> = [
		["ready", "schedule", 1],
		["ready", "catchUp", 22],
		["partial", "schedule", 0],
		["missed", null, 0],
		["ready", "schedule", 1],
	];
	const runs = past.slice(0, 5).map((occurrence, index) =>
		run(daily, occurrence, states[index][0], states[index][1], past[index + 1] ?? occurrence, states[index][2]),
	);
	const upcoming = (automation: Automation) =>
		occurrences(automation.days, automation.time, now, 6, 1).map((occurrence) => ({
			occurrence: key(occurrence),
			ready: key(new Date(occurrence.getTime() - automation.leadMinutes * 60_000)),
		}));
	const morningPast = occurrences(morning.days, morning.time, now, 3, -1);
	return [
		{ automation: daily, runs, upcoming: upcoming(daily), running: false },
		{
			automation: morning,
			runs: morningPast.map((occurrence, index) =>
				run(morning, occurrence, "ready", "schedule", morningPast[index + 1] ?? occurrence, 0),
			),
			upcoming: upcoming(morning),
			running: false,
		},
	];
}

/** Le rendu de daily du jour, comme si celui de 13 h 30 venait de tomber. */
export function previewLatestDaily(): AutomationRun {
	const now = new Date();
	const start = new Date(now.getTime() - 40 * 60_000);
	return run(daily, new Date(now.getTime() + 30 * 60_000), "ready", "schedule", new Date(now.getTime() - 2 * 86_400_000), 0, {
		startedAt: start.toISOString(),
		endedAt: now.toISOString(),
	});
}
