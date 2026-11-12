/**
 * L'app dans un navigateur, avec des données pour la regarder.
 *
 * Cockpit est une application Tauri : son interface n'existe que dans la fenêtre
 * native, et ouverte dans un navigateur elle rend un écran noir — le premier
 * appel au pont IPC échoue, et rien ne s'affiche jamais. Conséquence pratique,
 * et qui a coûté cher : on peut écrire des écrans entiers sans jamais les voir,
 * vérifier que tout compile, et livrer des changements qu'on croit visibles alors
 * qu'ils ne le sont pas.
 *
 * Ce module donne des réponses plausibles à la place du pont, uniquement en
 * développement et uniquement quand Tauri est absent. `pnpm vite:dev` suffit
 * alors à ouvrir l'app dans un navigateur, la parcourir, la capturer.
 *
 * Ce ne sont pas des données de test : personne ne s'appuie dessus pour décider
 * quoi que ce soit. Elles servent à juger une mise en page — assez fournies pour
 * que les écrans soient denses, assez variées pour montrer les cas qui comptent :
 * une CI rouge, un plan qui attend un accord, une autorisation demandée.
 */

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const MEMBERS = ["Alice", "Bob", "Dave", "Carol"];

/**
 * Les colonnes de l'équipe d'exemple.
 *
 * Ces noms n'ont rien d'universel — chaque équipe nomme les siens dans Linear,
 * et le cockpit les lit dans `workflow` plutôt que de les supposer. Ils vivent
 * ici en un seul endroit pour que le jeu d'aperçu reste cohérent avec la
 * configuration qu'il rend lui-même : un écran qui compare un état à
 * `doneStates` doit trouver la même chaîne des deux côtés.
 */
const ETATS = {
	actif: "In Progress",
	revue: "In Review",
	aFaire: "Todo",
	fini: "Done",
	bloque: "Blocked",
};

function ticket(index: number, state: string, phase: string) {
	return {
		identifier: `NW-${3000 + index}`,
		title: [
			"Show delivery estimates at checkout",
			"Make product search tolerate typos",
			"Sync new customer accounts to the CRM",
			"Keep the order summary visible while scrolling",
			"Send back-in-stock email alerts",
		][index % 5],
		description: "",
		url: "https://linear.app/northwind",
		stateName: state,
		phase,
		progress: [20, 45, 70, 90][index % 4],
		ageDays: index % 5,
		updatedAt: ago(index * 90 + 20),
		prNumbers: index % 2 === 0 ? [1800 + index] : [],
		priority: (index % 4) + 1,
		priorityLabel: ["Urgent", "Haute", "Moyenne", "Basse"][index % 4],
	};
}

function pr(index: number) {
	const ci = ["success", "failing", "pending", "success"][index % 4];
	return {
		number: 1800 + index,
		url: "https://github.com/northwind/storefront/pull/1",
		title: [
			"feat(checkout): show delivery estimates",
			"fix(cart): keep the order summary visible while scrolling",
			"chore(ci): cache the pnpm store between jobs",
			"feat(search): tolerate typos in product search",
		][index % 4],
		headRef: `topic-${index}-nw-${3000 + index}`,
		headSha: `abc${index}def0123`,
		baseRef: index % 5 === 0 ? "feat/foundation" : "dev",
		author: MEMBERS[index % MEMBERS.length],
		isDraft: index % 7 === 0,
		reviewDecision: index % 3 === 0 ? "APPROVED" : index % 3 === 1 ? "CHANGES_REQUESTED" : "",
		ciState: ci,
		createdAt: ago(index * 240 + 100),
		updatedAt: ago(index * 45 + 10),
		linearIds: [`NW-${3000 + index}`],
		reviewRequestLogins: index % 2 === 0 ? ["alice"] : [],
		labels: [
			{ name: index % 2 ? "front" : "back", color: index % 2 ? "7c7aff" : "4ade80" },
		],
	};
}

function commit(sha: string, subject: string, author: string, minutes: number) {
	return {
		sha,
		subject,
		author,
		relative: minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`,
		timestamp: Math.round(now / 1000) - minutes * 60,
	};
}

/**
 * Un fil de conversation d'agent, assez long pour juger la mise en page.
 *
 * On y met ce qui distingue un agent d'un chat : une réflexion, des appels
 * d'outil qui réussissent, un qui échoue, et un sous-agent — parce que ces
 * quatre formes ne se rendent pas de la même façon et qu'aucune ne doit se
 * confondre avec la voix de l'agent.
 */
const SESSION_TIMELINE = [
	{
		kind: "user",
		text: "The cart shows €10.00 but the payment provider charges €9.99. Find where the gap comes from.",
		tool: null,
		detail: null,
		model: null,
		tokens: null,
		minutes: 210,
	},
	{
		kind: "thinking",
		text: "The provider rounds each line to the cent before adding them up. If our cart sums the raw line amounts and rounds only once at the end, a cart with discounted lines can land one cent away from what gets charged.",
		tool: null,
		detail: null,
		model: "opus",
		tokens: 420,
		minutes: 209,
	},
	{
		kind: "assistant",
		text: "I'll look at how the cart computes its total, then compare it with the provider's rounding rule.",
		tool: null,
		detail: null,
		model: "opus",
		tokens: 180,
		minutes: 209,
	},
	{
		kind: "tool",
		text: "Searched “cartTotal|Math.round” in apps/web/src",
		tool: "Grep",
		detail: '{\n  "pattern": "cartTotal|Math.round",\n  "path": "apps/web/src"\n}',
		model: null,
		tokens: null,
		minutes: 208,
	},
	{
		kind: "tool-result",
		text: "apps/web/src/cart.ts:142  const total = Math.round(sum(lines) * 100) / 100;\napps/web/src/cart.ts:31   const CURRENCY_DECIMALS = 2;",
		tool: "Grep",
		detail: "2 results",
		model: null,
		tokens: null,
		minutes: 208,
	},
	{
		kind: "assistant",
		text: "It is `sum(lines)` first, rounding second: a single rounding on the raw sum. No per-line rule. I'll round each line before summing.",
		tool: null,
		detail: null,
		model: "opus",
		tokens: 260,
		minutes: 207,
	},
	{
		kind: "tool",
		text: "Edited apps/web/src/cart.ts",
		tool: "Edit",
		detail: '{\n  "file_path": "apps/web/src/cart.ts",\n  "replace_all": false\n}',
		model: null,
		tokens: null,
		minutes: 206,
	},
	{
		kind: "tool-result",
		text: "The file apps/web/src/cart.ts has been updated.",
		tool: "Edit",
		detail: null,
		model: null,
		tokens: null,
		minutes: 206,
	},
	{
		kind: "tool",
		text: "Subagent: cover per-line rounding with tests",
		tool: "Task",
		detail: '{\n  "description": "cart rounding tests",\n  "subagent_type": "general-purpose"\n}',
		model: null,
		tokens: null,
		minutes: 200,
	},
	{
		kind: "assistant",
		text: "The subagent wrote four cases: a single line, several lines, a discounted line, and a zero-decimal currency.",
		tool: null,
		detail: null,
		model: "opus",
		tokens: 210,
		minutes: 190,
	},
	{
		kind: "tool",
		text: "pnpm vitest run apps/web/src/cart.test.ts",
		tool: "Bash",
		detail: '{\n  "command": "pnpm vitest run apps/web/src/cart.test.ts"\n}',
		model: null,
		tokens: null,
		minutes: 188,
	},
	{
		kind: "tool-error",
		text: "FAIL  apps/web/src/cart.test.ts > rounds a zero-decimal currency per line\n  expected 1200, received 1199.5",
		tool: "Bash",
		detail: "sortie 1",
		model: null,
		tokens: null,
		minutes: 187,
	},
	{
		kind: "assistant",
		text: "Yen has no decimals: rounding to the cent is wrong there. I'll read the precision from the order's currency, then rerun.",
		tool: null,
		detail: null,
		model: "opus",
		tokens: 240,
		minutes: 186,
	},
	{
		kind: "tool-result",
		text: "Test Files  1 passed (1)\n     Tests  4 passed (4)",
		tool: "Bash",
		detail: "sortie 0",
		model: null,
		tokens: null,
		minutes: 184,
	},
	{
		kind: "assistant",
		// Une conclusion qui montre avant de dire : deux captures et un schéma,
		// comme la consigne de rendu les demande.
		text: [
			"All four cases pass. One thing left to decide: should coupons be rounded per line or on the order total, as the ticket suggests? I'll let you choose before I touch the summary display.",
			"",
			"![Cart total before](.claude/work/render/cart-total-before.png)",
			"![Cart total after](.claude/work/render/cart-total-after.png)",
			"",
			"```mermaid",
			"flowchart LR",
			"  lines[Cart lines] --> currency{Currency decimals?}",
			"  currency -- two --> cents[Round each line to the cent]",
			"  currency -- none --> units[Round each line to the unit]",
			"  cents --> total[Sum of rounded lines]",
			"  units --> total",
			"  total --> summary[Order summary]",
			"```",
		].join("\n"),
		tool: null,
		detail: null,
		model: "opus",
		tokens: 300,
		minutes: 183,
	},
].map((event, index) => ({
	index,
	kind: event.kind,
	timestamp: ago(event.minutes),
	text: event.text,
	tool: event.tool,
	detail: event.detail,
	isSidechain: false,
	model: event.model,
	tokens: event.tokens,
}));

/** Une revue en deux tours, poussée depuis : le cas complet de l'écran. */
const REVUE_2056 = {
	repo: "northwind/storefront",
	number: 2056,
	title: "fix(cart): round each line before summing totals",
	author: "frank",
	branch: "fix-cart-rounding-nw-3044",
	base: "dev",
	url: "https://github.com/northwind/storefront/pull/2056",
	posted: ["R1"],
	rounds: [
		{
			number: 1,
			kind: "revue",
			at: ago(26 * 60),
			headSha: "a1b2c3d4e5",
			verdict: "corrections",
			summary:
				"The PR rounds **each cart line** to the currency's precision before summing, the way the payment provider does, instead of rounding the raw total once. The logic lives in `cart/totals.ts` (new `roundLines` function), the cart calls it on every change, and the order summary now shows the rounded lines. Taxes keep their own rounding.",
			findings: [
				{ id: "R1", severity: "bloquant", file: "apps/web/src/cart/totals.ts", lines: "18-24", problem: "Coupon discounts are rounded per line too, while the provider applies them to the order total.", fix: "Apply `roundLines` to product lines only, and subtract the coupon after summing.", comment: "I think coupons go through per-line rounding here too — the provider applies them to the order total. Could you take them out of `roundLines`?" },
				{ id: "R2", severity: "important", file: "apps/web/src/cart.ts", lines: "142", problem: "`cartTotal` changed signature: the order summary still calls it the old way and will show a different total.", fix: "Keep the old signature as an overload, or update `CartSummary.tsx:57`.", comment: "Small thing: CartSummary.tsx still calls cartTotal with the old signature, so the summary may disagree with the cart." },
				{ id: "R3", severity: "suggestion", file: "apps/web/src/cart/totals.test.ts", lines: "30-41", problem: "No test covers a currency without decimals.", fix: "Add a JPY cart with three discounted lines.", comment: "Suggestion: a test with a zero-decimal currency like JPY? That's the case that breaks most often." },
			],
			checks: [],
		},
		{
			number: 2,
			kind: "verification",
			at: ago(110),
			headSha: "b7e8f9012a",
			verdict: "corrections",
			summary: "Frank moved coupons out of per-line rounding and added the zero-decimal test. The `cartTotal` signature hasn't been handled yet.",
			findings: [
				{ id: "R4", severity: "important", file: "apps/web/src/cart/totals.ts", lines: "31", problem: "The new coupon filter ignores gift cards, which are stored as a negative line.", fix: "Exclude lines of type `gift_card` from `roundLines` as well.", comment: "Gift cards are stored as negative lines, so they fall back into per-line rounding. Could you exclude them too?" },
			],
			checks: [
				{ id: "R1", status: "corrige", note: "coupons are applied after summing" },
				{ id: "R2", status: "non_corrige", note: "CartSummary.tsx still uses the old signature" },
				{ id: "R3", status: "corrige", note: "" },
			],
		},
	],
};

const DOCS = [
	["plan-cart-rounding.md", "plan", "Split plan — three tasks: back end, front end, QA.", 1],
	["review-cart.md", "revue", "Cart review: per-line rounding is properly isolated.", 1],
	["qa-checkout.md", "recette", "Real checkout against the payment sandbox: 4 cases, 4 green.", 1],
	["plan-loyalty.md", "plan", "Restore loyalty points after a failed checkout.", 2],
	["review-loyalty.md", "revue", "The restore never replays points already granted.", 2],
	["qa-loyalty.md", "recette", "Failed checkout replayed three times: no duplicate points.", 2],
	["plan-ci-e2e.md", "plan", "Split the e2e suite into four shards.", 3],
	["review-ci.md", "revue", "Shard 3 holds the slowest tests: needs rebalancing.", 3],
	["qa-ci.md", "recette", "Full suite in 6 min, down from 21 min.", 3],
	["decisions.md", "wiki", "What we settled on for billing, and why.", 0],
	["architecture.md", "wiki", "The boundaries between the API, the web app and the admin.", 0],
	["conventions.md", "wiki", "Branch naming, commit splitting, review.", 0],
	["ports.json", "données", '{ "web": 3000, "api": 3001 }', 0],
	["seed.json", "données", "Demo dataset: 3 customers, 12 orders.", 0],
].map(([name, category, preview, worktree], index) => ({
	path: `/Users/demo/code/storefront-topic-${worktree}/.claude/work/${name}`,
	relative: `.claude/work/${name}`,
	name: name as string,
	category: category as string,
	worktree: worktree === 0 ? "storefront" : `storefront-topic-${worktree}`,
	worktreePath: `/Users/demo/code/storefront${worktree === 0 ? "" : `-topic-${worktree}`}`,
	modified: Math.round(now / 1000) - index * 5400,
	size: 1200 + index * 640,
	preview: preview as string,
	untracked: index % 3 === 0,
}));

const TOTALS = {
	input: 182_000,
	output: 46_000,
	cacheRead: 920_000,
	cacheWrite: 61_000,
	messages: 412,
};

/**
 * Un rapport d'analyse tel que le cockpit le relit — sections, risques, verdict.
 *
 * Écrit à la main plutôt que repris d'un vrai rapport : il doit montrer les cas
 * qui décident de la mise en page — une section qui n'a que du texte, une autre
 * qui n'a que des puces, trois gravités différentes, une phrase de résumé assez
 * longue pour éprouver la carte.
 */
function analyse(index: number) {
	// Les longueurs sont celles qu'un vrai rapport produit : une puce de risque
	// fait deux à trois lignes, pas six mots. Un jeu d'exemple trop court laisse
	// croire à une mise en page qui tient, et l'écran se découvre serré une fois
	// branché sur de vraies données.
	const risques = [
		{
			text: "A webhook replayed twice restores the points twice: the restore table has no uniqueness constraint, and the payment provider resends on timeout. Scenario: the first call takes 31 seconds, the second arrives before the write.",
			severity: "critical",
		},
		{
			text: "The queue has no cap; a long provider outage would grow the table without limit, until it fills the production database disk.",
			severity: "warning",
		},
		{
			text: "The receipt label stays in English for French customers, while the rest of the checkout is translated.",
			severity: "info",
		},
		{
			text: "The branch is 40 commits behind its base: the green CI covers a state that is no longer the one the code will be merged into.",
			severity: "info",
		},
		{
			text: "The new column has no database default: existing rows will read it as `null`, and the balance calculation will silently skip them.",
			severity: "warning",
		},
		{
			text: "No test covers a partial refund, even though it is the most common case for annual members.",
			severity: "warning",
		},
	].slice(0, [6, 1, 3, 0][index % 4]);

	return {
		key: "",
		headSha: `abc${index}def`,
		at: Math.round(now / 1000) - index * 5400,
		risk: ["élevé", "faible", "moyen", "faible"][index % 4],
		verdict: ["réserves", "ok", "bloquant", "ok"][index % 4],
		headline: [
			"Loyalty points are no longer lost when a checkout fails: they return to the customer's account within a minute, without going through support. For the team, it ends manual point restores, which took one to two hours a week and always left a customer unhappy while they waited.",
			"Nothing changes for shoppers — this is an internal reorganization that prepares localization.",
			"The cart drawer finally shows the same total as the checkout page, including on orders with discounts.",
			"Tests run twice as fast; no visible effect on the store.",
		][index % 4],
		riskCount: risques.length,
		checkCount: 2,
		durationSeconds: 180 + index * 40,
		costUsd: 0,
		engine: "Claude Code",
		model: "opus",
		title: "",
		branch: "",
		url: "",
		raw: "",
		briefPath: "/Users/demo/.config/cockpit/impact/storefront.md",
		sections: [
			{
				id: "produit",
				title: "In plain words",
				body: "Loyalty points are no longer lost when a checkout fails: they return to the customer's account within a minute, without going through support. For the team, it ends manual point restores, which took one to two hours a week and always left a customer unhappy while they waited.",
				points: [],
			},
			{
				id: "pourquoi",
				title: "Why now",
				body: "Three customers reported lost points in two weeks, each time after a declined card. Support was restoring them by hand.",
				points: [],
			},
			{
				id: "choix",
				title: "The choices made",
				body: "Restore through a queue rather than inline: the restore survives a provider outage, at the cost of a one-minute delay. The alternative — restoring right inside the webhook call — was simpler but lost everything that failed during an outage, which is exactly the case we want to handle. The price of this choice is one more table to watch, and an intermediate state that support cannot see anywhere.",
				points: [],
			},
			{ id: "risques", title: "What could break", body: "", points: risques },
			{
				id: "verifier",
				title: "To check before merging",
				body: "",
				points: [
					{
						text: "Replay an already processed webhook and check that no points are added.",
						severity: "neutral",
					},
					{
						text: "Cut off the provider during a restore and look at the state of the queue.",
						severity: "neutral",
					},
				],
			},
			{
				id: "mieux",
				title: "What could be done better",
				body: "The restore log should be visible to support, to avoid the back-and-forth with the engineering team.",
				points: [],
			},
		],
	};
}

/** Un changement en vol, tel que le moniteur le recense. */
function change(index: number) {
	const forge = (["github", "gitlab", "local"] as const)[index % 3];
	const lu = index % 3 !== 1;
	const analysis = lu ? { ...analyse(index), key: `apercu-${index}` } : null;
	return {
		key: `apercu-${index}`,
		project: "principal",
		projectName: ["Storefront", "Marketing site"][index % 2],
		projectColor: "",
		forge,
		// La première carte porte un dépôt et une branche volontairement longs :
		// c'est le cas qui faisait sortir le nom du projet hors du cadre, et il
		// doit rester sous les yeux pour que la troncature ne se perde pas.
		repo:
			forge === "local"
				? "storefront"
				: index === 0
					? "northwind/storefront-internal-platform-monorepo"
					: "northwind/storefront",
		reference: forge === "github" ? `#${1800 + index}` : forge === "gitlab" ? `!${20 + index}` : `feat/topic-${index}`,
		title: [
			"Restore loyalty points after a failed checkout",
			"Extract UI strings for localization",
			"Make the cart drawer match the checkout totals",
			"Shard the e2e test suite",
		][index % 4],
		author: MEMBERS[index % MEMBERS.length],
		branch:
			index === 0
				? "fix/invite-link-invalid-after-password-setup-nw-3124"
				: `topic-${index}-nw-${3000 + index}`,
		base: index % 5 === 0 ? "feat/foundation" : "dev",
		url: forge === "local" ? "" : "https://github.com/northwind/storefront/pull/1",
		draft: index % 7 === 0,
		// La tête diffère de celle qu'a lue l'analyse une fois sur quatre : c'est
		// le cas « périmé », qu'on ne verrait jamais sans le poser ici.
		headSha: index % 4 === 2 ? "0000000" : `abc${index}def`,
		additions: forge === "gitlab" ? null : 40 + index * 73,
		deletions: forge === "gitlab" ? null : 12 + index * 19,
		changedFiles: 3 + index * 2,
		ci: (["success", "failing", "pending", "none"] as const)[index % 4],
		review: (["approved", "changes_requested", "review_required", ""] as const)[index % 4],
		updatedAt: ago(index * 45 + 10),
		worktree: index % 2 === 0 ? `/Users/demo/code/storefront-topic-${index}` : "",
		repoPath: "/Users/demo/code/storefront",
		// La forme du backend, `label` et non `name` : c'est en s'en écartant que
		// l'aperçu a laissé passer une page blanche jusqu'en production.
		labels: [
			{
				label: index % 2 ? "front" : "back",
				color: index % 2 ? "7c7aff" : "4ade80",
				tone: "neutral" as const,
			},
		],
		analysis,
	};
}

/**
 * L'état de la Permanence après un regard : quelques signaux écartés, dont
 * deux au déclencheur reconnu. C'est là-dessus que se juge le tri — un écran
 * qui n'écarte rien ne dit pas si la boucle voit ou si elle est aveugle.
 */
const PERMANENCE = {
	suspended: false,
	lastLook: {
		at: Math.round(now / 1000) - 90,
		closed: null,
		seen: 14,
		fresh: 3,
		blind: ["linear: token rejected (401)"],
	},
	since: Math.round(now / 1000) - 6 * 3600,
	cold: false,
	signals: [
		{
			key: "github:northwind/storefront#412",
			project: "Northwind",
			source: "GitHub",
			label: "#412 · fix(cart): keep the order summary visible while scrolling",
			trigger: "ci_red",
			at: Math.round(now / 1000) - 120,
			dropped: "",
			rule: "ci-red",
			retained: true,
			pending: false,
		},
		{
			key: "github:northwind/storefront#418",
			project: "Northwind",
			source: "GitHub",
			label: "#418 · chore: bump @tauri-apps/api",
			trigger: "",
			at: Math.round(now / 1000) - 900,
			dropped: "no recognized trigger",
			rule: "",
			retained: false,
			pending: false,
		},
		{
			key: "local:northwind@feat/theme",
			project: "Northwind",
			source: "Local",
			label: "feat/theme · Light theme on the order history page",
			trigger: "review_changes_requested",
			at: Math.round(now / 1000) - 2400,
			dropped: "the review is on a different repository than the rule's",
			rule: "",
			retained: false,
			pending: false,
		},
	],
	skipped: 0,
	quarantine: {},
	// Un rodage entamé : c'est l'état dans lequel on la découvre en l'activant,
	// et celui qu'il faut avoir regardé une fois.
	rehearsalLeft: 7,
	armedOn: "open_draft_pr,rerun_pipeline",
	failures: 0,
	tripped: "",
	holds: [],
	// Les quatre verdicts côte à côte, dont le rodage : c'est là-dessus qu'on
	// juge si « indécidable » se distingue d'« atteint » d'un coup d'œil.
	engagements: [
		{
			id: "eng-1",
			rule: "ci-red",
			key: "github:northwind/storefront#412",
			label: "#412 · fix(cart): keep the order summary visible while scrolling",
			trigger: "ci_red",
			goal: "Get the CI of #412 back to green",
			oracle: { kind: "command", key: "script-test" },
			stage: "running",
			verdict: "pending",
			why: "",
			steps: [
				{ at: Math.round(now / 1000) - 200, what: "reads the run log", result: "1 test fails: cart.test.ts:212", ok: true },
				{ at: Math.round(now / 1000) - 150, what: "reproduces locally", result: "failure confirmed", ok: true },
				{ at: Math.round(now / 1000) - 60, what: "opens a mission", result: "", ok: true },
			],
			produced: [],
			mission: "",
			rehearsal: false,
			startedAt: Math.round(now / 1000) - 240,
			endedAt: 0,
			costUsd: 0.21,
		},
		{
			id: "eng-2",
			rule: "deploy-check",
			key: "github:northwind/storefront#404",
			label: "#404 · chore: bump dependencies",
			trigger: "schedule",
			goal: "Check that the staging deployment went through",
			oracle: { kind: "ci", key: "success" },
			stage: "done",
			verdict: "undecided",
			why: "The deployment API did not answer. Nothing says whether it went through.",
			steps: [
				{ at: Math.round(now / 1000) - 4000, what: "queries the deployment", result: "timed out", ok: false },
			],
			produced: [],
			mission: "",
			rehearsal: false,
			startedAt: Math.round(now / 1000) - 4200,
			endedAt: Math.round(now / 1000) - 3900,
			costUsd: 0.06,
		},
		{
			id: "eng-3",
			rule: "ci-red",
			key: "github:northwind/storefront#399",
			label: "#399 · feat: cart totals",
			trigger: "ci_red",
			goal: "Get the CI of #399 back to green",
			oracle: { kind: "command", key: "script-test" },
			stage: "done",
			verdict: "rehearsed",
			why: "Rehearsal: the plan is written, nothing was done.",
			steps: [
				{ at: Math.round(now / 1000) - 7000, what: "read the run log", result: "planned — find which test fails before touching the code", ok: true },
				{ at: Math.round(now / 1000) - 7000, what: "open a mission", result: "planned — production code needs to change", ok: true },
			],
			produced: [],
			mission: "",
			rehearsal: true,
			startedAt: Math.round(now / 1000) - 7200,
			endedAt: Math.round(now / 1000) - 6900,
			costUsd: 0.09,
		},
	],
};

/** Ce que chaque commande rend en aperçu. Tout le reste tombe sur `null`. */
let previewShortcut: { accelerator: string; registered: boolean; error: string | null } = {
	accelerator: "alt+Space",
	registered: false,
	error: "Already taken by another application, or refused by macOS.",
};

/**
 * Un monorepo plausible pour la carte du chantier : des applications, des
 * paquets partagés, une API, de la doc. Les poids varient assez pour que le
 * pavage ressemble à un vrai dépôt.
 */
function territoireExemple(): Array<{ path: string; bytes: number }> {
	const files: Array<{ path: string; bytes: number }> = [];
	const add = (dir: string, names: string[], base: number) => {
		names.forEach((name, index) => {
			files.push({ path: `${dir}/${name}`, bytes: base * (1 + ((index * 7) % 5)) + index * 311 });
		});
	};
	add("apps/web/src", ["cart.ts", "App.tsx", "routes.tsx", "main.tsx", "cart.test.ts"], 4_200);
	add("apps/web/src/currencies", ["index.ts", "eur.ts", "jpy.ts"], 2_400);
	add("apps/web/src/catalog", ["index.ts", "ProductCard.tsx", "ProductGrid.tsx", "filters.ts", "search.ts"], 1_900);
	add("apps/web/src/cart", ["totals.ts", "rounding.ts", "CartSummary.tsx", "CartLines.tsx", "totals.test.ts"], 1_600);
	add("apps/web/src/account", ["Account.tsx", "Orders.tsx", "Addresses.tsx", "returns.ts", "loyalty.ts", "Account.test.tsx"], 3_300);
	add("apps/web/src/images", ["Upload.tsx", "Crop.tsx", "Gallery.tsx", "resize.ts"], 2_800);
	add("apps/admin/src", ["App.tsx", "Customers.tsx", "Billing.tsx", "Audit.tsx", "Flags.tsx", "api.ts"], 3_600);
	add("apps/admin/src/reports", ["Revenue.tsx", "Churn.tsx", "Export.tsx"], 2_700);
	add("packages/ui/src", ["Button.tsx", "Dialog.tsx", "Menu.tsx", "Table.tsx", "Toast.tsx", "Tabs.tsx", "tokens.css"], 2_100);
	add("packages/sdk/src", ["client.ts", "auth.ts", "orders.ts", "products.ts", "errors.ts"], 2_500);
	add("apps/api/src/loyalty", ["points.ts", "webhooks.ts", "invoices.ts", "points.test.ts"], 3_900);
	add("apps/api/src/orders", ["checkout.ts", "fulfillment.ts", "validate.ts", "queue.ts"], 3_400);
	add("apps/api/src/auth", ["session.ts", "oauth.ts", "tokens.ts"], 2_200);
	add("apps/api/src/db", ["schema.ts", "migrate.ts"], 6_800);
	add("apps/api/migrations", ["001_init.sql", "002_orders.sql", "003_loyalty.sql", "004_inventory.sql", "005_flags.sql"], 1_200);
	add("docs", ["architecture.md", "billing.md", "payments.md", "onboarding.md"], 2_600);
	add(".", ["package.json", "pnpm-lock.yaml", "README.md", "CLAUDE.md", "tsconfig.json"], 900);
	// Le lockfile pèse ce qu'il pèse dans un vrai dépôt.
	const lock = files.find((file) => file.path.endsWith("pnpm-lock.yaml"));
	if (lock) lock.bytes = 180_000;
	return files.map((file) => ({ ...file, path: file.path.replace(/^\.\//, "") }));
}

const REPONSES: Record<string, unknown> = {
	// Un dossier quelconque : dépôt git s'il ressemble à un projet, simple
	// dossier sinon — de quoi voir les deux visages du lanceur.
	libre_inspect: ({ path }: Record<string, unknown>) => {
		const raw = String(path ?? "");
		const full = raw.replace(/^~/, "/Users/demo");
		const git = /code\//.test(full);
		return {
			path: full,
			exists: full.length > 1,
			isGit: git,
			root: git ? full : "",
			branch: git ? "main" : "",
			dirty: git && full.includes("storefront") ? 3 : 0,
		};
	},
	libre_prepare: ({ path, place, branch }: Record<string, unknown>) => {
		const full = String(path ?? "").replace(/^~/, "/Users/demo");
		const tail = String(branch ?? "").split("/").pop() || "agent";
		return place === "worktree"
			? { cwd: `${full}-${tail}`, branch, worktree: `${full}-${tail}` }
			: { cwd: full, branch: place === "branche" ? branch : "main", worktree: "" };
	},
	libre_archive: null,
	// Le dépôt de chaque dossier : ce qui parle de cockpit relève du projet
	// Cockpit, le reste de Northwind — de quoi ranger les agents sous leur île.
	repos_of: ({ paths }: Record<string, unknown>) =>
		Object.fromEntries(
			(paths as string[]).map((path) => [
				path,
				path.includes("cockpit") ? "/Users/demo/code/cockpit" : "/Users/demo/code/storefront",
			]),
		),
	// Toutes les missions, tous projets confondus : celles de Northwind, plus une
	// sur Cockpit, pour que son île ait quelque chose à dire.
	missions_everywhere: () => [
		...(REPONSES.missions_list as Array<Record<string, unknown>>),
		{
			...(REPONSES.missions_list as Array<Record<string, unknown>>)[0],
			id: "mc1",
			title: "Wire the map to real data",
			ticket: "",
			cwd: "/Users/demo/code/cockpit",
			state: "running",
		},
	],
	feed_railway: [
		{
			id: "dep-1",
			source: "railway",
			title: "main → staging",
			subtitle: "storefront-web · 12 min ago",
			status: "up",
			severity: "success",
			url: "https://railway.app",
			timestamp: ago(12),
			meta: [],
			tags: [],
			payload: {},
		},
	],
	chantier_territory: ({ cwd }: Record<string, unknown>) => ({
		root: String(cwd),
		files: territoireExemple(),
		truncated: false,
	}),
	// Ce que le disque dit des fichiers lus par les agents d'aperçu : deux
	// écrits depuis par l'agent « Rounding rules per currency », un par personne de
	// connu — un terminal, un `git`, ou toi.
	files_stamps: ({ paths }: Record<string, unknown>) =>
		(paths as string[]).map((path) => {
			const minutes = path.endsWith("cart.ts")
				? 6
				: path.endsWith("cart/rounding.ts")
					? 12
					: path.endsWith("cart/totals.ts")
						? 2
						: 180;
			// Datés depuis le chargement, comme les tours des agents d'aperçu :
			// sinon chaque relevé reculerait l'horloge et inventerait des
			// lectures périmées.
			return { path, modifiedMs: now - minutes * 60_000 };
		}),
	// La visite des changements : l'agent « Fix cart total rounding » a
	// touché ces fichiers, dont un qu'il n'a jamais nommé (le lockfile).
	// Les captures d'exemple d'un agent : un écran esquissé, pour juger la
	// mise en page d'une conclusion qui montre un avant et un après.
	file_data_url: ({ path }: Record<string, unknown>) => {
		const after = /-after/.test(String(path));
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><rect width="480" height="300" fill="#f4f6f8"/><rect x="24" y="24" width="432" height="252" rx="12" fill="#fff" stroke="#d9dee4"/><rect x="44" y="48" width="260" height="10" rx="5" fill="#d9dee4"/><rect x="44" y="72" width="380" height="10" rx="5" fill="#e6eaee"/><rect x="44" y="96" width="330" height="10" rx="5" fill="#e6eaee"/><rect x="44" y="120" width="210" height="10" rx="5" fill="#2f6fdb" opacity=".5"/><rect x="320" y="224" width="116" height="32" rx="16" fill="${after ? "#fbe9c8" : "#f1f3f6"}" stroke="${after ? "#a96300" : "#d9dee4"}"/><text x="378" y="245" text-anchor="middle" font-family="monospace" font-size="13" fill="${after ? "#a96300" : "#525b69"}">${after ? "Total €9.99" : "Total €10.00"}</text></svg>`;
		return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
	},
	// Hors de la fenêtre native il n'y a pas de navigateur à diffuser : l'onglet
	// montre une page d'exemple (`PREVIEW_PAGE`), pour en juger la mise en page.
	browser_running: () => true,
	browser_watch: () => null,
	browser_frame: () => new ArrayBuffer(0),
	browser_snapshot: () => new ArrayBuffer(0),
	browser_act: () => null,
	// Un élément d'exemple sous le pointeur : la page d'aperçu n'a pas de DOM
	// à interroger, mais l'annotation doit pouvoir se juger.
	browser_inspect: ({ x, y }: Record<string, unknown>) => ({
		tag: "button",
		text: "Continue",
		testid: "checkout-submit",
		role: null,
		label: null,
		selector: "main > form.checkout > div.actions > button.primary",
		component: "CheckoutForm",
		source: "apps/web/src/checkout/CheckoutForm.tsx:42",
		url: "http://localhost:3000/checkout",
		rect: { x: Number(x) - 60, y: Number(y) - 18, width: 120, height: 36 },
	}),
	browser_unwatch: () => null,
	browser_stop: () => null,
	// Les méthodes : deux plugins installés, trois disponibles, et la lecture
	// d'un plugin qui exécute quelque chose — c'est le cas qu'il faut voir.
	methods_catalog: () => ({
		installed: [
			{ id: "commit-commands@claude-plugins-official", version: "1.0.1", scope: "user", enabled: true, installPath: "", installedAt: "2026-09-07T18:44:12Z" },
			{ id: "review-kit@northwind-tools", version: "2.3.0", scope: "project", enabled: true, installPath: "", installedAt: "2026-10-20T09:00:00Z" },
		],
		available: [
			{
				pluginId: "security-guard@claude-plugins-official",
				name: "security-guard",
				description: "Blocks risky shell commands before they run, and audits dependencies on install.",
				marketplaceName: "claude-plugins-official",
				source: { source: "git-subdir", url: "https://github.com/example/guards.git", repo: "", path: "plugins/security-guard", ref: "v1.4.0", sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
				installCount: 18240,
			},
			{
				pluginId: "test-first@claude-plugins-official",
				name: "test-first",
				description: "Skills that make the agent write a failing test before changing code.",
				marketplaceName: "claude-plugins-official",
				source: { source: "relative", url: "", repo: "", path: "plugins/test-first", ref: "", sha: "" },
				installCount: 9310,
			},
			{
				pluginId: "design-system@northwind-tools",
				name: "design-system",
				description: "Northwind's component conventions, as skills.",
				marketplaceName: "northwind-tools",
				source: { source: "github", url: "", repo: "northwind/agent-tools", path: "", ref: "main", sha: "" },
				installCount: 42,
			},
		],
	}),
	methods_install: () => ({ kind: "installed", message: "Installed for the project." }),
	methods_uninstall: () => "Uninstalled.",
	methods_measure: () => ({
		since: "2026-10-20T09:00:00Z",
		days: 14,
		before: { executions: 31, failed: 6, medianTurns: 18, medianCostUsd: 0.62 },
		after: { executions: 27, failed: 2, medianTurns: 14, medianCostUsd: 0.55 },
	}),
	methods_inspect: (args: Record<string, unknown>) => {
		const guard = args.pluginId === "security-guard@claude-plugins-official";
		return {
			inventory: {
				name: String(args.pluginId).split("@")[0],
				description: "",
				version: guard ? "1.4.0" : "0.9.0",
				skills: guard ? ["audit-dependencies"] : ["red-green", "test-naming"],
				agents: [],
				commands: guard ? ["guard-report"] : [],
				hooks: guard
					? [{ event: "PreToolUse", command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/check_command.py"' }]
					: [],
				servers: guard ? [{ name: "osv", target: "https://api.osv.dev/mcp" }] : [],
				scripts: guard ? ["hooks/check_command.py"] : [],
				fingerprint: guard ? "9f2c1e7a40b35d68c2e1f0a9b8d7c6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9" : "",
			},
			alwaysOnTokens: guard ? 340 : 120,
			source: guard
				? { source: "git-subdir", url: "https://github.com/example/guards.git", repo: "", path: "plugins/security-guard", ref: "v1.4.0", sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" }
				: { source: "relative", url: "", repo: "", path: "plugins/test-first", ref: "", sha: "" },
			approved: null,
		};
	},
	// Le rejeu : deux PR fusionnées qui ajoutent des tests, et une campagne
	// jouée avec deux configurations.
	replay_cases: () => [
		{
			number: 2051,
			title: "Cart total ignores line quantities",
			base: "4f2a9c1",
			head: "9b7e3d0",
			tests: ["src/cart/__tests__/total.test.ts"],
			sources: ["src/cart/total.ts"],
		},
		{
			number: 2044,
			title: "Rounding drift on multi-currency orders",
			base: "1c8d2aa",
			head: "7a0f5e2",
			tests: ["src/cart/__tests__/rounding.test.ts", "src/money/__tests__/minor-units.test.ts"],
			sources: ["src/cart/total.ts", "src/money/minor-units.ts"],
		},
	],
	replay_trials: () => {
		const sonnet = { label: "Sonnet", engine: "", model: "sonnet", depth: "", instructions: "" };
		const tdd = {
			label: "Sonnet + write the test first",
			engine: "",
			model: "sonnet",
			depth: "",
			instructions: "Write a failing test before changing the code.",
		};
		const trial = (
			number: number,
			title: string,
			setup: typeof sonnet,
			verdict: { kind: string; command?: string; output?: string; reason?: string },
			costUsd: number,
			minutes: number,
		) => ({
			at: "2026-11-05T10:20:00Z",
			number,
			title,
			setup,
			judgement: { verdict, agentFiles: ["src/cart/total.ts"], sharedFiles: ["src/cart/total.ts"] },
			error: null,
			costUsd,
			durationMs: minutes * 60_000,
		});
		const failed = { kind: "failed", command: "pnpm test", output: "expected 12.40, received 10.00" };
		return [
			trial(2051, "Cart total ignores line quantities", tdd, { kind: "resolved" }, 0.41, 6),
			trial(2051, "Cart total ignores line quantities", sonnet, { kind: "resolved" }, 0.33, 5),
			trial(2044, "Rounding drift on multi-currency orders", tdd, { kind: "resolved" }, 0.58, 9),
			trial(2044, "Rounding drift on multi-currency orders", sonnet, failed, 0.44, 8),
		];
	},
	replay_progress: () => null,
	replay_run: (args: Record<string, unknown>) =>
		((args.numbers as number[]) ?? []).length * Math.max(1, ((args.setups as unknown[]) ?? []).length),
	tour_changes: ({ cwd }: Record<string, unknown>) => ({
		root: String(cwd),
		base: "a1b2c3d",
		baseLabel: "since dev",
		files: [
			{ path: "apps/web/src/cart.ts", added: 14, removed: 3, state: "modified" },
			{ path: "apps/web/src/cart.test.ts", added: 38, removed: 0, state: "modified" },
			{ path: "apps/web/src/lib/rounding.ts", added: 22, removed: 0, state: "untracked" },
			{ path: "apps/web/src/legacy/totals.ts", added: 0, removed: 41, state: "deleted" },
			{ path: "pnpm-lock.yaml", added: 2, removed: 2, state: "modified" },
		],
		additions: 76,
		deletions: 46,
	}),
	tour_file_diff: ({ file }: Record<string, unknown>) =>
		`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -138,7 +138,11 @@ export function cartTotal(cart: Cart) {\n   const lines = cart.lines;\n-  const total = Math.round(sum(lines) * 100) / 100;\n+  // The payment provider rounds each line before summing.\n+  const decimals = currencyDecimals(cart.currency);\n+  const total = sum(roundLines(lines, decimals));\n   return {\n-    total,\n+    total: toMinorUnits(total, decimals),\n   };\n }\n`,
	tour_story: () => ({
		intro:
			"The cart used to round the raw sum once; it now rounds each line to the currency's precision before summing, like the payment provider. The old totals helper is gone, replaced by a dedicated, tested function.",
		files: [
			{ path: "apps/web/src/lib/rounding.ts", story: "The heart of the change: a function that rounds like the payment provider, line by line, using the currency's precision. Look closely at how the precision is resolved: does an unknown currency fall back to two decimals?" },
			{ path: "apps/web/src/cart.ts", story: "The cart uses the new function and stores the total in minor units. The two-decimal default is hard-coded, while the ticket asked to read it from the currency table." },
			{ path: "apps/web/src/cart.test.ts", story: "Four cases cover a single line, several lines, a discounted line and a zero-decimal currency. The case of a coupon on a multi-line cart is missing." },
			{ path: "apps/web/src/legacy/totals.ts", story: "The old totals helper is removed: nothing imported it anymore. Check that no other app in the monorepo depended on it." },
			{ path: "pnpm-lock.yaml", story: "Mechanical lockfile update, no new dependency." },
		],
		costUsd: 0.04,
	}),
	// Un raccourci déjà pris au départ : c'est le cas que l'écran doit rendre
	// visible, et le seul qu'on ne peut pas provoquer en aperçu.
	assistant_shortcut: () => previewShortcut,
	assistant_set_shortcut: ({ accelerator }: Record<string, unknown>) => {
		previewShortcut = { accelerator: String(accelerator), registered: true, error: null };
		return previewShortcut;
	},
	// L'assistant, sans Claude : de quoi voir le bandeau réagir en aperçu.
	assistant_ask: ({ prompt }: Record<string, unknown>) => {
		const asked = /Request: "(.*)"|Demande : « (.*) »/.exec(String(prompt))?.slice(1).find(Boolean) ?? "";
		if (/workspace/i.test(asked)) {
			return JSON.stringify({ say: "Opening the cart rounding workspace.", action: "open_workspace", params: { folder: "fix-cart-rounding-nw-3044" } });
		}
		if (/mission/i.test(asked)) {
			return JSON.stringify({ say: "Creating the mission and starting its master agent.", action: "go_to", params: { view: "missions" } });
		}
		return JSON.stringify({ say: "I can't find a “payments” workspace. Which one do you want to open?", action: null, params: {} });
	},
	speech_voices: [
		{ name: "Amélie", locale: "fr_CA" },
		{ name: "Flo (Français (France))", locale: "fr_FR" },
		{ name: "Erin", locale: "fr_FR" },
	],
	impact_scan: {
		changes: [0, 1, 2, 3, 4, 5, 6].map(change),
		// Une source muette, pour vérifier que le bandeau se voit sans écraser
		// la grille.
		notes: [
			{
				source: "Marketing site · GitLab",
				message: "401 — the token doesn't have the `api` scope.",
			},
			// Une note que le cockpit sait réparer : c'est le cas qui distingue
			// « on te dit ce qui ne va pas » de « on te propose de le régler ».
			{
				source: "Internal tools · GitHub",
				message:
					"This project's GitHub repository is set to “internal-tools”: the owner is missing. Expected “owner/repo”, as read in the repository URL. Here, that's “northwind/internal-tools”.",
				fix: {
					label: "Write “northwind/internal-tools”",
					project: "internal-tools",
					patch: { github: { repo: "northwind/internal-tools" } },
				},
			},
		],
	},
	impact_running: [],
	impact_read: analyse(0),
	panel_running: [],
	// Une boucle qui tourne, avec ce qu'il faut d'imperfections pour que les
	// alertes se voient : une propriété décorative, deux leçons inutilisées.
	metrics_collect: {
		windowDays: 30,
		handbacks: {
			delivered: 46,
			takenBack: 11,
			rate: 23,
			since: Math.round(Date.now() / 1000) - 40 * 86_400,
			pending: 1,
			briefed: { delivered: 28, takenBack: 5, rate: 17 },
			plain: { delivered: 18, takenBack: 6, rate: 33 },
			comparable: true,
		},
		turns: { sessions: 38, median: 3, longHaul: 5, withError: 4 },
		guardrails: {
			properties: 3,
			calibrated: 2,
			decorative: 1,
			audits: 12,
			breaches: 4,
			panels: 6,
			disputes: 9,
		},
		memory: { lessons: 7, uses: 24, idle: 2, stale: 1 },
		deeds: [
			{ kind: "agent", count: 64, failed: 2, actor: "me" },
			{ kind: "git", count: 41, failed: 0, actor: "me" },
			{ kind: "impact", count: 18, failed: 1, actor: "me" },
			{ kind: "worktree", count: 12, failed: 0, actor: "me" },
			{ kind: "github", count: 9, failed: 1, actor: "me" },
			{ kind: "github", count: 3, failed: 1, actor: "permanence" },
		],
		warnings: [
			"1 property caught nothing on real fixes. Rephrase or remove it: a decorative guardrail costs attention that is no longer paid elsewhere.",
			"2 lessons out of 7 never went out with an agent. Either their scope is too narrow, or they didn't need to be kept.",
		],
	},
	// Trois calibrations, dont une décorative : c'est ce cas-là qui donne son
	// sens à l'écran — un garde-fou qui n'attrape rien rassure sans garantir.
	properties_calibrations: [
		{
			propertyId: "p-1",
			at: Math.round(Date.now() / 1000) - 4 * 86_400,
			tried: 6,
			caught: 3,
			costUsd: 0.42,
			samples: [
				{
					sha: "3fa41b2c",
					subject: "fix(api): 500 when the request body is empty",
					caught: true,
					note: "The route read `body.email` without checking `body`.",
				},
				{
					sha: "9d7e1a04",
					subject: "Fix product CSV import on a file without a header",
					caught: true,
					note: "No validation before writing to the database.",
				},
				{
					sha: "b21c9f37",
					subject: "fix: checkout button label was cut off in German",
					caught: false,
					note: "Unrelated to a database write.",
				},
			],
		},
		{
			propertyId: "p-3",
			at: Math.round(Date.now() / 1000) - 4 * 86_400,
			tried: 6,
			caught: 0,
			costUsd: 0.38,
			samples: [
				{
					sha: "77aa10de",
					subject: "fix: VAT rounding on grouped invoices",
					caught: false,
					note: "The bug came from the order of operations, not the unit.",
				},
			],
		},
	],
	// Une propriété enfreinte, une indécise, deux muettes : la forme complète.
	properties_read: {
		key: "github:northwind/storefront#412",
		headSha: "9f2c1ab",
		at: Math.round(Date.now() / 1000) - 900,
		costUsd: 0.61,
		durationSeconds: 148,
		checks: [
			{
				propertyId: "p-1",
				text: "Every route that writes to the database validates its body before calling it.",
				verdict: "enfreinte",
				evidence: ["apps/api/src/orders.ts:118", "apps/api/src/orders.ts:126"],
				note: "`PATCH /orders/:id` writes `status` without going through the validation schema.",
				costUsd: 0.22,
			},
			{
				propertyId: "p-3",
				text: "Amounts stay in integer cents until they are displayed.",
				verdict: "indécis",
				evidence: [],
				note: "The diff touches a loyalty points calculation, not an amount: I can't decide without seeing the caller.",
				costUsd: 0.14,
			},
			{
				propertyId: "p-2",
				text: "A migration can be undone: it has its reverse, and that reverse has been run at least once.",
				verdict: "hors sujet",
				evidence: [],
				note: "No migration in this change.",
				costUsd: 0.12,
			},
		],
	},
	// Une confrontation qui a trouvé quelque chose : deux angles rassurants, un
	// qui bloque. C'est le cas qui justifie la fonctionnalité — et le seul qu'il
	// faille regarder pour juger l'écran.
	panel_read: {
		key: "github:northwind/storefront#412",
		headSha: "9f2c1ab",
		at: Math.round(Date.now() / 1000) - 1800,
		verdict: "bloquant",
		agreed:
			"The cart now rounds each line the way the payment provider does, and tests cover it.",
		voices: [
			{
				lens: "casse",
				label: "What breaks",
				verdict: "réserves",
				risk: "moyen",
				summary: "Shipping fees still use the old rounding, while everything else changed.",
				points: [
					"A cart with ten discounted lines and paid shipping shows €49.99 and gets charged €50.00.",
					"The currency precision is still hard-coded in the component: two values to change instead of one.",
				],
				costUsd: 0.31,
			},
			{
				lens: "exploitation",
				label: "Once deployed",
				verdict: "bloquant",
				risk: "élevé",
				summary:
					"Carts already saved were totalled with the old rule and are not recomputed.",
				points: [
					"A cart saved yesterday at €10.00 will be charged €9.99 without anyone reopening it: the order confirmation will show a different amount than the receipt.",
					"No backfill is planned for subscription orders that are already scheduled.",
				],
				costUsd: 0.28,
			},
			{
				lens: "usage",
				label: "For the people using it",
				verdict: "ok",
				risk: "faible",
				summary: "The total becomes accurate, and nothing changes in the checkout flow.",
				points: ["Nothing spotted from this angle: the display and the steps are unchanged."],
				costUsd: 0.19,
			},
		],
		disputes: [
			{
				claim: "Subscription orders already scheduled are charged the right amount after release.",
				heldBy: ["For the people using it"],
				against: ["Once deployed", "What breaks"],
				why: "If they aren't, customers get charged an amount that differs from their confirmation email, with nobody watching when it happens.",
				check: "Take a cart saved before this change, at €10.00, and run a scheduled checkout on a copy.",
			},
			{
				claim: "Shipping fees are rounded the way the payment provider does.",
				heldBy: [],
				against: ["What breaks"],
				why: "A charge that differs from the displayed total is exactly the bug we are fixing.",
				check: "Build a cart with ten discounted lines and paid shipping, then compare the summary with the sandbox charge.",
			},
		],
		silent: [],
		costUsd: 0.94,
		durationSeconds: 214,
	},
	config_get: {
		projects: [
			{
				id: "principal",
				name: "Northwind",
				color: "",
				mainRepo: "/Users/demo/code/storefront",
				githubRepo: "northwind/storefront",
				linearTeamKey: "NW",
				railwayProjectId: "",
				triggerProjectRef: "",
				account: "travail",
				overrides: ["account"],
				declared: {
					projectsRoot: "/Users/demo/code",
					mainRepo: "/Users/demo/code/storefront",
					editor: "zed",
					githubRepo: "northwind/storefront",
					linearTeamKey: "NW",
					linearTeamId: "",
					triggerProjectRef: "",
					railwayProjectId: "",
					impactBrief:
						"An online store: customers browse products, fill a cart and check out.",
					gitlabProject: "",
					gitlabHost: "https://gitlab.com",
					account: "travail",
				},
				hasGithub: true,
				hasLinear: true,
			},
			{
				id: "cockpit",
				name: "Cockpit",
				color: "6a55e8",
				mainRepo: "/Users/demo/code/cockpit",
				githubRepo: "northwind/storefront",
				linearTeamKey: "NW",
				railwayProjectId: "",
				triggerProjectRef: "",
				account: "travail",
				overrides: ["account"],
				declared: {
					projectsRoot: "/Users/demo/code",
					mainRepo: "/Users/demo/code/cockpit",
					editor: "zed",
					githubRepo: "northwind/storefront",
					linearTeamKey: "NW",
					linearTeamId: "",
					triggerProjectRef: "",
					railwayProjectId: "",
					impactBrief:
						"An online store: customers browse products, fill a cart and check out.",
					gitlabProject: "",
					gitlabHost: "https://gitlab.com",
					account: "travail",
				},
				hasGithub: true,
				hasLinear: true,
			},
			{
				id: "marketing",
				name: "Marketing site",
				color: "a8662a",
				mainRepo: "/Users/demo/code/marketing-site",
				githubRepo: "northwind/storefront",
				linearTeamKey: "NW",
				railwayProjectId: "",
				triggerProjectRef: "",
				account: "travail",
				overrides: ["account"],
				declared: {
					projectsRoot: "/Users/demo/code",
					mainRepo: "/Users/demo/code/marketing-site",
					editor: "zed",
					githubRepo: "northwind/storefront",
					linearTeamKey: "NW",
					linearTeamId: "",
					triggerProjectRef: "",
					railwayProjectId: "",
					impactBrief:
						"An online store: customers browse products, fill a cart and check out.",
					gitlabProject: "",
					gitlabHost: "https://gitlab.com",
					account: "travail",
				},
				hasGithub: true,
				hasLinear: true,
			},
		],
		activeProject: "principal",
		global: {
			projectsRoot: "/Users/demo/code",
			mainRepo: "/Users/demo/code/storefront",
			editor: "zed",
			githubRepo: "",
			linearTeamKey: "",
			linearTeamId: "",
			triggerProjectRef: "",
			railwayProjectId: "",
			impactBrief: "",
			gitlabProject: "",
			gitlabHost: "https://gitlab.com",
			account: "",
		},
		projectsRoot: "/Users/demo/code",
		mainRepo: "/Users/demo/code/storefront",
		editor: "zed",
		githubRepo: "northwind/storefront",
		linearTeamKey: "NW",
		linearTeamId: "eq-1",
		triggerProjectRef: "",
		triggerEnvironments: [],
		railwayProjectId: "",
		configPath: "~/.config/cockpit/config.toml",
		secrets: [],
		workflow: {
			baseBranches: ["dev", "main"],
			doneStates: [ETATS.fini],
			prCommand: "/pull-request-creation",
			worktreeCommand: "/create-worktree {branch}",
			worktreeRemoveCommand: "pnpm worktree:remove {folder} --force",
			devCommand: "pnpm dev",
			testCommands: [],
			gateCommands: [],
			deliveryDossier: true,
		},
		impact: {
			brief:
				"An online store: customers browse products, fill a cart and check out. What matters: the amount charged always matches the total shown, and an order confirmed is an order shipped.",
			engine: "claude",
			model: "opus",
			depth: "deep",
			includeLocalBranches: true,
		},
		// Une source décochée par défaut : c'est ce qui distingue « rien n'est
		// réglé » de « quelqu'un a choisi de ne pas joindre ça ».
		brief: { enabled: true, off: ["attempts"] },
		// Allumée, avec une règle vivante et une éteinte : c'est la seule façon
		// de voir l'écran autrement que dans son état vide. Une installation
		// réelle, elle, part avec tout à zéro.
		missions: { tokenBudget: 0, quotaFloorPercent: 0, memoryCeilingPercent: 0 },
		sandbox: { enabled: false, runtime: "", image: "", memoryMb: 0, cpus: 0 },
		permanence: {
			enabled: true,
			hours: "",
			cadenceMinutes: 0,
			catchUp: false,
			dailyTokens: 0,
			dailyEngagements: 0,
			quotaFloorPercent: 0,
			maxRunning: 0,
			rehearsal: 0,
			graceHours: 0,
			breaker: 0,
			notifyFailures: true,
			notifyAll: false,
			retentionDays: 0,
			engine: "claude",
			triage: {
				id: "triage",
				label: "Tri",
				prompt: "",
				model: "haiku",
				engine: "claude",
				permissionMode: "bypassPermissions",
				depth: "fast",
				command: "",
				verifies: false,
				scope: [],
			},
			work: {
				id: "work",
				label: "Travail",
				prompt: "",
				model: "sonnet",
				engine: "claude",
				permissionMode: "bypassPermissions",
				depth: "deep",
				command: "",
				verifies: false,
				scope: [],
			},
			prompt: "",
			rules: [
				{
					id: "ci-red",
					label: "Red CI on a default branch",
					enabled: true,
					trigger: "ci_red",
					condition: "I'm the author of the last commit",
					reaction: "fix it, open a draft PR",
					oracle: { kind: "command", key: "script-test" },
					needsApproval: false,
					everyHours: 0,
					tokenBudget: 40_000,
					perHour: 3,
				},
				{
					id: "dependency",
					label: "Outdated dependency",
					enabled: false,
					trigger: "schedule",
					condition: "",
					reaction: "update and verify",
					oracle: { kind: "", key: "" },
					needsApproval: false,
					everyHours: 0,
					tokenBudget: 0,
					perHour: 0,
				},
			],
			powers: [],
			comment: { enabled: false, scopes: [], perDay: 0 },
			allowedPrs: [],
		},
		commands: [
			{
				id: "worktree-create",
				group: "Worktrees",
				label: "Create a worktree",
				description: "Checks out the branch, prepares the environment and provisions the infra.",
				base: "pnpm worktree:create",
				positional: {
					label: "Branch",
					placeholder: "feat/my-feature",
					required: true,
					hint: "The folder is derived from the branch name.",
				},
				options: [
					{
						id: "from",
						flag: "--from",
						label: "Start from",
						kind: "text",
						hint: "Starting git reference.",
						placeholder: "dev",
						choices: [],
						defaultValue: "",
					},
					{
						id: "no-setup",
						flag: "--no-setup",
						label: "Skip setup",
						kind: "boolean",
						hint: "",
						placeholder: "",
						choices: [],
						defaultValue: "",
					},
				],
				scoped: false,
				danger: false,
			},
			{
				id: "script-test",
				group: "test",
				label: "test",
				description: "vitest run",
				base: "pnpm test",
				positional: null,
				options: [],
				scoped: true,
				danger: false,
			},
			{
				id: "db-push",
				group: "Database",
				label: "Schema push",
				description: "Pushes the schema without a migration — dev only.",
				base: "pnpm db:push",
				positional: null,
				options: [],
				scoped: true,
				danger: true,
			},
		],
		properties: [
			{
				id: "p-1",
				text: "Every route that writes to the database validates its body before calling it.",
				scope: ["apps/api"],
			},
			{
				id: "p-2",
				text: "A migration can be undone: it has its reverse, and that reverse has been run at least once.",
				scope: ["packages/db/migrations"],
			},
			{
				id: "p-3",
				text: "Amounts stay in integer cents until they are displayed.",
				scope: [],
			},
		],
		roles: [
			{
				id: "master",
				label: "Lead agent",
				prompt: "",
				model: "",
				engine: "claude",
				permissionMode: "bypassPermissions",
				depth: "deep",
				command: "",
				verifies: false,
				scope: [],
			},
			{
				id: "backend",
				label: "Back-end development",
				prompt: "You implement the server side.",
				model: "",
				engine: "claude",
				permissionMode: "bypassPermissions",
				depth: "normal",
				command: "",
				verifies: false,
				scope: [],
			},
			{
				id: "qa",
				label: "Recette",
				prompt: "You check against evidence.",
				model: "",
				engine: "claude",
				permissionMode: "bypassPermissions",
				depth: "fast",
				command: "",
				verifies: true,
				scope: [],
			},
		],
		engines: [
			{
				id: "claude",
				label: "Claude Code",
				command: "",
				protocol: "claude-stream-json",
				models: ["fable", "claude-opus-5-5", "opus", "sonnet", "haiku"],
				env: [],
				extraArgs: "",
				depthFast: "--effort low",
				depthNormal: "--effort high",
				depthDeep: "--effort xhigh",
			},
		],
		accounts: [
			{ id: "poste", label: "This machine's account", dir: "" },
			{ id: "travail", label: "Company account", dir: "~/.claude-travail" },
		],
		account: "travail",
	},
	accounts_status: [
		{
			id: "poste",
			label: "This machine's account",
			dir: "",
			resolvedDir: "/Users/demo/.claude",
			loggedIn: true,
			email: "frank@example.com",
			plan: "max",
			organization: "",
			projects: [],
			error: "",
		},
		{
			id: "travail",
			label: "Company account",
			dir: "~/.claude-travail",
			resolvedDir: "/Users/demo/.claude-travail",
			loggedIn: true,
			email: "frank@northwind.dev",
			plan: "team",
			organization: "Northwind",
			projects: ["Northwind"],
			error: "",
		},
	],

	connectors_list: [
		{ id: "github", label: "GitHub", kind: "repository", configured: true, missing: "" },
		{ id: "linear", label: "Linear", kind: "tickets", configured: true, missing: "" },
		{ id: "claude", label: "CLI Claude Code", kind: "agents", configured: true, missing: "" },
		{ id: "node", label: "Node", kind: "orchestration", configured: true, missing: "" },
		{ id: "docker", label: "Docker", kind: "containers", configured: true, missing: "" },
	],
	worktrees_list: [0, 1, 2, 3, 4].map((index) => ({
		path:
			index === 4
				? "/Users/demo/code/fix-cart-rounding-nw-3044"
				: `/Users/demo/code/storefront-topic-${index}`,
		folderName: index === 4 ? "fix-cart-rounding-nw-3044" : `storefront-topic-${index}`,
		branch:
			index === 0
				? "dev"
				: index === 4
					? "fix-cart-rounding-nw-3044"
					: `topic-${index}-nw-${3000 + index}`,
		head: "a1b2c3d",
		isMain: index === 0,
		isDetached: false,
		isLocked: false,
		status: {
			modified: index,
			staged: 0,
			untracked: index % 2,
			conflicted: 0,
			ahead: index,
			behind: 0,
			upstream: "origin/dev",
		},
		lastCommit: {
			sha: "a1b2c3d",
			subject: "fix(cart): round each line before summing totals",
			author: "Alice",
			relative: "2 h ago",
			timestamp: now / 1000 - 7200,
		},
		lastActivity: now / 1000 - 3600 * index,
	})),
	missions_list: [
		{
			id: "m0",
			title: "Show delivery estimates at checkout",
			ticket: "NW-3000",
			ticketUrl: "",
			branch: "topic-0-nw-3000",
			base: "",
			cwd: "/Users/demo/code/storefront",
			masterSession: "agent-4",
			state: "awaitingUnderstanding",
			plan: "",
			guided: true,
			understanding: [
				{
					text: [
						"The ask: show an estimated delivery date for each shipping option at checkout.",
						"Why: customers abandon their cart to email support asking when the order will arrive.",
						"What changes: a date range under each shipping option, computed from the warehouse and the carrier.",
						"Where: the checkout page (front end) and a new estimate endpoint in the API.",
						"Out of scope: tracking after shipment, which stays on the carrier's page.",
						"Express stays next-day only — confirmed in the comments.",
					].join("\n"),
					questions: [
						"Should the estimate account for the warehouse cut-off time, as Dave asks?",
						"Should the product page show the estimate too, or only checkout?",
					],
					submittedAt: ago(2),
					review: null,
				},
			],
			approach: [],
			split: [],
			prUrl: "",
			summary: "",
			note: "",
			paused: false,
			startedAt: null,
			finishedAt: null,
			createdAt: ago(6),
			updatedAt: ago(2),
			tasks: [],
		},
		{
			id: "m4",
			title: "Export invoices as CSV",
			ticket: "NW-3071",
			ticketUrl: "",
			branch: "invoices-csv-nw-3071",
			base: "",
			cwd: "/Users/demo/code/storefront",
			masterSession: "agent-4",
			state: "approaching",
			plan: "",
			guided: true,
			understanding: [
				{
					text: "The ask: a CSV export of invoices.\nWhy: accounting retypes them by hand.",
					questions: ["All invoices, or only the current month?"],
					submittedAt: ago(40),
					review: {
						approved: false,
						feedback: "This isn't for the admin: customers need to export from their own account.",
						answers: [""],
						at: ago(38),
					},
				},
				{
					text: "The ask: customers export their own invoices as CSV.\nWhy: their accounting retypes them by hand.\nOut of scope: the admin-side export.",
					questions: ["All invoices, or only the current month?"],
					submittedAt: ago(30),
					review: { approved: true, feedback: "", answers: ["Filterable by month"], at: ago(29) },
				},
			],
			approach: [],
			split: [],
			prUrl: "",
			summary: "",
			note: "",
			paused: false,
			startedAt: null,
			finishedAt: null,
			createdAt: ago(45),
			updatedAt: ago(1),
			tasks: [],
		},
		{
			id: "m1",
			title: "Fix cart total rounding on multi-currency orders",
			ticket: "NW-3044",
			ticketUrl: "",
			branch: "fix-cart-rounding-nw-3044",
			base: "",
			cwd: "/Users/demo/code/storefront",
			masterSession: "agent-1",
			state: "running",
			// Guidée : son parcours s'ouvre sur le graphe en direct, avec la boucle
			// d'une recette renvoyée et celle d'une porte rouge.
			guided: true,
			plan: "Three tasks: back end, front end, QA.",
			understanding: [],
			approach: [],
			split: [
				{
					text: "Three tasks: back end, front end, QA.\nThe API rounds each line first; the cart reads its total from there.",
					questions: ["Should QA wait for both the API and the cart, or start on the API alone?"],
					submittedAt: ago(226),
					review: { approved: true, feedback: "Keep the QA last.", answers: ["Wait for both."], at: ago(220) },
				},
			],
			prUrl: "",
			summary: "",
			note: "",
			paused: false,
			startedAt: ago(180),
			finishedAt: null,
			createdAt: ago(240),
			updatedAt: ago(12),
			tasks: [
				{
					id: "t1",
					role: "backend",
					title: "Per-line rounding in the API",
					brief: "",
					scope: ["apps/api/**"],
					base: "",
					branch: "fix-cart-rounding-nw-3044-backend",
					worktree: "/Users/demo/code/storefront-topic-1",
					sessionId: "agent-2",
					engineSession: "sess-42",
					actualBranch: "",
					verdict: "",
					state: "delivered",
					note: "Worker finished — 3 commits.",
					attempts: 0,
					startedAt: ago(150),
					finishedAt: ago(40),
					checkpoint: "",
					workedSeconds: 6600,
					gate: "failed",
					gateOutput: [
						"$ pnpm test",
						"exit 1",
						" FAIL  api/cart.test.ts > rounds each line",
						"   expected 10.01 to be 10",
					].join("\n"),
				},
				{
					id: "t2",
					role: "frontend",
					title: "Cart totals",
					brief: "",
					scope: ["apps/web/**"],
					base: "",
					branch: "fix-cart-rounding-nw-3044-web",
					worktree: "/Users/demo/code/storefront-topic-2",
					sessionId: "agent-3",
					engineSession: "",
					actualBranch: "fix/cart-rounding",
					verdict: "",
					state: "running",
					note: "",
					attempts: 0,
					startedAt: ago(35),
					finishedAt: null,
					checkpoint: "",
					workedSeconds: 2100,
					gate: "none",
					gateOutput: "",
					gateCommit: "",
				},
				{
					id: "t3",
					role: "qa",
					title: "Functional QA",
					brief: "",
					scope: [],
					base: "",
					branch: "fix-cart-rounding-nw-3044-qa",
					worktree: "",
					sessionId: null,
					engineSession: "",
					actualBranch: "",
					verdict: "blocking",
					state: "delivered",
					note: "The cart total isn't recomputed when a coupon is removed.",
					attempts: 1,
					startedAt: ago(90),
					finishedAt: ago(80),
					checkpoint: "",
					workedSeconds: 300,
					gate: "none",
					gateOutput: "",
					gateCommit: "",
				},
			],
		},
		{
			id: "m2",
			title: "Restore loyalty points after a failed checkout",
			ticket: "NW-3051",
			ticketUrl: "",
			branch: "loyalty-restore-nw-3051",
			base: "",
			cwd: "/Users/demo/code/storefront",
			masterSession: "agent-4",
			state: "awaitingApproval",
			plan: "The points ledger first, the retry screen in parallel; QA and review once both are delivered.",
			guided: true,
			understanding: [
				{
					text: "The ask: give loyalty points back to a customer whose checkout failed.\nWhy: today they are lost, and support restores them by hand.",
					questions: [],
					submittedAt: ago(28),
					review: { approved: true, feedback: "", answers: [], at: ago(26) },
				},
			],
			approach: [
				{
					text: "Step 1: the points ledger keeps track of reserved points.\nStep 2: a failed payment releases them.\nStep 3: the retry screen tells the customer what happened.",
					questions: [],
					submittedAt: ago(20),
					review: { approved: true, feedback: "", answers: [], at: ago(18) },
				},
			],
			split: [
				{
					text: "The points ledger first, the retry screen in parallel; QA and review once both are delivered.",
					questions: [],
					submittedAt: ago(4),
					review: null,
				},
			],
			prUrl: "",
			summary: "",
			note: "",
			paused: false,
			startedAt: null,
			finishedAt: null,
			createdAt: ago(30),
			updatedAt: ago(4),
			tasks: [0, 1, 2, 3].map((index) => ({
				id: `p${index}`,
				role: ["backend", "frontend", "qa", "review"][index],
				title: [
					"Release reserved points when a payment fails",
					"Retry screen: tell the customer what happened",
					"QA: replay a declined payment end to end",
					"Review the points ledger and the screen",
				][index],
				brief:
					index === 0
						? "## Context\n\nThe points ledger reserves points when the order is placed.\n\n## To do\n\n- Listen to `payment.failed`\n- Release the reservation"
						: "",
				scope: [["apps/api/loyalty/**"], ["apps/web/checkout/**"], [], []][index],
				base: "",
				branch: `loyalty-restore-nw-3051-${index}`,
				worktree: "",
				sessionId: null,
				state: "planned",
				note: "",
				attempts: 0,
				startedAt: null,
				finishedAt: null,
				checkpoint: "",
				workedSeconds: 0,
				gate: "none",
				gateOutput: "",
				gateCommit: "",
			})),
		},

		{
			id: "m3",
			title: "Shard the e2e test suite",
			ticket: "NW-3060",
			ticketUrl: "",
			branch: "ci-shard-e2e-nw-3060",
			base: "",
			cwd: "/Users/demo/code/storefront",
			masterSession: "agent-9",
			state: "integrating",
			plan: "Three tasks: splitting, QA, review.",
			prUrl: "",
			summary: "",
			note: "",
			paused: false,
			startedAt: ago(300),
			finishedAt: null,
			createdAt: ago(360),
			updatedAt: ago(2),
			tasks: [0, 1, 2].map((index) => ({
				id: `c${index}`,
				role: ["backend", "qa", "review"][index],
				title: ["Split into four shards", "QA of the suite", "Review the diff"][index],
				brief: "",
				scope: [],
				base: "",
				branch: `ci-shard-e2e-nw-3060-${index}`,
				worktree: "",
				sessionId: null,
				engineSession: "",
				actualBranch: "",
				// La recette refuse : la mission reste en intégration, et la pull
				// request ne peut pas s'ouvrir tant que ce verdict tient. La
				// relecture, elle, a rendu sans conclure.
				verdict: ["", "blocking", "undecided"][index],
				state: "integrated",
				note: "",
				attempts: 0,
				startedAt: ago(280),
				finishedAt: ago(30),
				checkpoint: "",
				workedSeconds: 4200,
				gate: "none",
				gateOutput: "",
				gateCommit: "",
			})),
		},
	],
	sessions_scan: [
		{
			key: "storefront",
			cwd: "/Users/demo/code/storefront-topic-2",
			sessions: [0, 1].map((index) => ({
				id: `sess-${index}`,
				file: `/tmp/sess-${index}.jsonl`,
				cwd: `/Users/demo/code/storefront-topic-${index + 1}`,
				projectKey: "storefront",
				gitBranch: `topic-${index + 1}-nw-${3001 + index}`,
				title: ["Cart total rounding", "Loyalty points restore"][index],
				lastPrompt: null,
				startedAt: ago(200),
				updatedAt: ago(index === 0 ? 3 : 90),
				idleSeconds: index === 0 ? 180 : 5400,
				userMessages: 12,
				assistantMessages: 34,
				toolCalls: 87,
				subagents: 2,
				models: ["opus"],
				usage: TOTALS,
				topTools: [{ name: "Edit", count: 31 }],
				filesTouched: ["apps/web/src/cart.ts"],
				cliVersion: "2.0.1",
				hasError: false,
				awaitingInput: index === 0,
				sizeBytes: 240_000,
			})),
		},
	],
	tasks_list: [
		{ id: "n1", text: "Review the loyalty mission plan", done: false, at: now },
		{ id: "n2", text: "Tell the team about the 0.27 release", done: true, at: now },
	],
	// Assez d'entrées pour que la carte déborde : c'est le seul moyen de voir si
	// elle défile chez elle plutôt que de pousser ses voisines hors de l'écran.
	// Ce que les agents ont fait : de quoi voir une histoire de mission avec
	// ses reprises, un agent mort au lancement et son motif, et un moteur qui
	// n'annonce aucun coût — les trois cas qu'on veut pouvoir lire.
	mission_executions: [
		{
			id: "exec-1", startedAt: "2026-08-28T14:03:00Z", endedAt: "2026-08-28T14:05:00Z",
			sessionId: "agent-1", protocol: "claude-stream-json", engine: "claude",
			engineLabel: "Claude Code", model: "opus-5", mission: "m1",
			origin: { actor: "me", engagement: "", role: "maître", task: "", attempt: 0 },
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044", project: "principal",
			sandboxed: false, engineSession: "s1", outcome: "answered" as const,
			tally: { turns: 4, inputTokens: 42000, outputTokens: 3100, cacheTokens: 900,
				cost: { reportedUsd: 0.21, estimatedUsd: 0, unknownTurns: 0 } },
			note: "", eventsDropped: 0, steps: [],
			observability: { reportsCost: true, reportsTokenSplit: true, reportsToolResults: true, reportsThinking: true, resumable: true },
		},
		{
			id: "exec-2", startedAt: "2026-08-28T14:05:00Z", endedAt: "2026-08-28T15:55:00Z",
			sessionId: "agent-2", protocol: "claude-stream-json", engine: "claude",
			engineLabel: "Claude Code", model: "sonnet-5", mission: "m1",
			origin: { actor: "master", engagement: "", role: "backend", task: "t1", attempt: 0 },
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044", project: "principal",
			sandboxed: false, engineSession: "s2", outcome: "answered" as const,
			tally: { turns: 22, inputTokens: 180000, outputTokens: 14000, cacheTokens: 5200,
				cost: { reportedUsd: 0.74, estimatedUsd: 0, unknownTurns: 0 } },
			note: "", eventsDropped: 0, steps: [],
			observability: { reportsCost: true, reportsTokenSplit: true, reportsToolResults: true, reportsThinking: true, resumable: true },
		},
		{
			id: "exec-3", startedAt: "2026-08-28T14:11:00Z", endedAt: "2026-08-28T14:11:20Z",
			sessionId: "agent-3", protocol: "claude-stream-json", engine: "claude",
			engineLabel: "Claude Code", model: "sonnet-5", mission: "m1",
			origin: { actor: "master", engagement: "", role: "qa", task: "t3", attempt: 0 },
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044", project: "principal",
			sandboxed: false, engineSession: "", outcome: "lostAtLaunch" as const,
			tally: { turns: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0,
				cost: { reportedUsd: 0, estimatedUsd: 0, unknownTurns: 0 } },
			note: "Error: MCP tool mcp__cockpit__approve (passed via --permission-prompt-tool) not found",
			eventsDropped: 0, steps: [],
			observability: { reportsCost: true, reportsTokenSplit: true, reportsToolResults: true, reportsThinking: true, resumable: true },
		},
		{
			id: "exec-4", startedAt: "2026-08-28T14:12:00Z", endedAt: "2026-08-28T14:41:00Z",
			sessionId: "agent-4", protocol: "codex-exec", engine: "codex",
			engineLabel: "Codex", model: "gpt-5", mission: "m1",
			origin: { actor: "master", engagement: "", role: "qa", task: "t3", attempt: 1 },
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044", project: "principal",
			sandboxed: false, engineSession: "fil-92", outcome: "answered" as const,
			tally: { turns: 9, inputTokens: 61000, outputTokens: 4200, cacheTokens: 0,
				cost: { reportedUsd: 0, estimatedUsd: 0, unknownTurns: 9 } },
			note: "", eventsDropped: 0, steps: [],
			observability: { reportsCost: false, reportsTokenSplit: true, reportsToolResults: false, reportsThinking: false, resumable: true },
		},
	],

	// Les outils que le dépôt d'exemple déclare : deux qui répondent, un qui ne
	// peut pas — c'est le cas qu'on veut voir rendu, puisque c'est celui qui
	// coûte des heures quand rien ne le dit.
	language_get: { choice: "", resolved: "en", supported: ["en", "fr", "es", "de", "pt-BR", "zh-CN", "ja", "ko", "ru", "it"] },
	language_set: { choice: "", resolved: "en", supported: ["en", "fr", "es", "de", "pt-BR", "zh-CN", "ja", "ko", "ru", "it"] },
	mcp_approval: { approved: false, changed: false },
	mcp_approve: { approved: true, changed: false },
	mcp_revoke: { approved: false, changed: false },
	mcp_servers: [
		{
			name: "linear",
			kind: "http",
			target: "https://mcp.linear.app/mcp",
			reachable: true,
			blocker: "",
		},
		{
			name: "playwright",
			kind: "stdio",
			target: "npx -y @playwright/mcp@latest --headless",
			reachable: true,
			blocker: "",
		},
		{
			name: "design-local",
			kind: "sse",
			target: "http://127.0.0.1:3845/sse",
			reachable: false,
			blocker: "local address: inside a container, this address points to the container, not the machine",
		},
	],
	journal_list: Array.from({ length: 14 }, (_, index) => ({
		at: Math.round(now / 1000) - index * 900,
		project: "principal",
		kind: ["mission", "github", "agent", "git"][index % 4],
		label: ["Lead launched", "PR opened", "Worker launched", "Branch pushed"][index % 4],
		target: [
			"Fix cart total rounding",
			`#${1801 + (index % 5)}`,
			"Cart totals",
			`topic-${(index % 3) + 1}-nw-${3001 + (index % 3)}`,
		][index % 4],
		ok: index % 5 !== 2,
		detail: "",
		// Quelques lignes que tu n'as pas demandées : c'est le cas qui compte, et
		// il ne se voit qu'à côté des autres.
		actor: index % 7 === 3 ? "permanence" : "me",
		engagement: index % 7 === 3 ? `eng-${index}` : "",
	})),
	// Plus une PR de Frank sur la branche du workspace d'aperçu, relue en
	// deux tours et poussée depuis : de quoi voir « Revérifier ».
	pull_requests: [
		...[0, 1, 2, 3, 4].map(pr),
		{
			...pr(1),
			number: 2056,
			title: "fix(cart): round each line before summing totals",
			headRef: "fix-cart-rounding-nw-3044",
			headSha: "c0ffee2a91",
			author: "frank",
			reviewDecision: "CHANGES_REQUESTED",
			ciState: "success",
			linearIds: ["NW-3044"],
			reviewRequestLogins: ["frank"],
		},
	],
	review_prepare: ({ number }: Record<string, unknown>) => ({
		number,
		title: REVUE_2056.title,
		author: "frank",
		branch: "fix-cart-rounding-nw-3044",
		base: "dev",
		url: REVUE_2056.url,
		headSha: "c0ffee2a91",
		worktree: "/Users/demo/code/fix-cart-rounding-nw-3044",
		prompt: "Check the fixes on PR #2056.",
		warning: null,
	}),
	git_pull: "Already up to date.",
	review_get: ({ number }: Record<string, unknown>) => (number === 2056 ? REVUE_2056 : null),
	reviews_list: () => [REVUE_2056],
	review_posted: () => REVUE_2056,
	branch_pr: () => null,
	worktree_commits: [
		{ sha: "c0ffee2a91", subject: "fix(cart): keep the old cartTotal signature", author: "frank", relative: "12 min ago", timestamp: 0 },
		{ sha: "b7e8f9012a", subject: "fix(cart): apply coupons after summing lines", author: "frank", relative: "2 h ago", timestamp: 0 },
		{ sha: "a1b2c3d4e5", subject: "fix(cart): round each line before summing totals", author: "frank", relative: "yesterday", timestamp: 0 },
		{ sha: "9f8e7d6c5b", subject: "test(cart): cover zero-decimal currencies", author: "frank", relative: "yesterday", timestamp: 0 },
	],
	worktree_changes: [
		{ path: "apps/web/src/cart/totals.ts", added: 6, removed: 2, state: "modified" },
		{ path: "apps/web/src/cart/notes.md", added: 0, removed: 0, state: "untracked" },
	],
	worktree_qa: [
		{ path: "/Users/demo/code/fix-cart-rounding-nw-3044/.qa/cart-total-before.png", name: "cart-total-before.png", relative: ".qa/cart-total-before.png", group: "recette", kind: "image", size: 1, modified: null },
		{ path: "/Users/demo/code/fix-cart-rounding-nw-3044/.qa/cart-total-after.png", name: "cart-total-after.png", relative: ".qa/cart-total-after.png", group: "recette", kind: "image", size: 1, modified: null },
	],
	feed_linear: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
		id: `NW-${3000 + index}`,
		source: "linear",
		title: ticket(index, ETATS.actif, "active").title,
		subtitle: "",
		status: [ETATS.actif, ETATS.revue, ETATS.aFaire, ETATS.actif, ETATS.bloque][index % 5],
		severity: "info",
		url: "https://linear.app/northwind",
		timestamp: ago(index * 120 + 15),
		meta: [
			{ label: "assigné", value: MEMBERS[index % MEMBERS.length] },
			{ label: "branche", value: `topic-${index}-nw-${3000 + index}` },
		],
		tags: [{ label: ["Urgent", "Haute", "Moyenne", "Basse"][index % 4] }],
		payload: {},
	})),
	ticket_provider: {
		label: "Linear",
		capabilities: {
			priority: true,
			richStates: true,
			estimate: true,
			branchName: true,
		},
	},
	// Deux plafonds dont un déjà bien entamé : c'est le cas qui décide si la
	// Permanence démarre ou non, et le seul qui vaille d'être regardé.
	// Un dossier qui n'existe pas encore : c'est l'état dans lequel on découvre
	// l'écran quand on ajoute un projet, et celui qu'il faut avoir regardé.
	project_inspect: {
		path: "/Users/demo/code/new-project",
		exists: false,
		isRepo: false,
		occupied: false,
		remote: "",
		slug: "",
		accounts: ["frank", "frank-personal"],
	},
	project_prepare: {
		path: "/Users/demo/code/new-project",
		exists: true,
		isRepo: true,
		occupied: true,
		remote: "https://github.com/frank/new-project.git",
		slug: "frank/new-project",
		accounts: ["frank", "frank-personal"],
	},
	permanence_state: PERMANENCE,
	// Regarder maintenant rend le même état : l'aperçu n'a pas de forge à
	// interroger, et c'est le rendu qu'on vient vérifier, pas la boucle.
	permanence_look: PERMANENCE,
	// L'aperçu ne retient rien : suspendre montre l'état au repos, et un
	// rechargement remet la Permanence en service. C'est assez pour juger le
	// bandeau, qui est la seule chose qu'on vient regarder ici.
	permanence_suspend: {
		suspended: true,
		lastLook: {
			at: Math.round(now / 1000) - 30,
			closed: "suspended",
			seen: 0,
			fresh: 0,
			blind: [],
		},
		since: Math.round(now / 1000) - 6 * 3600,
		cold: false,
		signals: [],
		skipped: 0,
		quarantine: {},
		rehearsalLeft: 7,
		armedOn: "open_draft_pr,rerun_pipeline",
		failures: 0,
		tripped: "",
		holds: [],
		engagements: [],
	},
	// L'aperçu n'a rien à couper : le bouton dit alors qu'il n'y avait rien, ce
	// qui est exactement ce qu'on veut vérifier.
	permanence_halt: {
		state: { ...PERMANENCE, tripped: "Stop requested from the screen.", holds: [] },
		stopped: [],
		failed: [],
	},
	// Un quota déjà bien entamé : c'est l'état où le témoin doit se voir.
	// Une conversation qui a coûté cher sans occuper beaucoup de contexte :
	// c'est précisément l'écart que cette jauge sert à montrer.
	agent_spend: {
		total: 842_000,
		share: 34,
		remaining: 22,
		tightest: "Week",
		resetsAt: "Monday",
	},
	usage_spend: {
		today: 1_284_000,
		window: 312_000,
		remaining: 22,
		tightest: "Week",
		resetsAt: "Monday",
		quotas: [
			{ kind: "session", label: "Current session", percent: 41, resetsAt: "at 6:00 PM" },
			{ kind: "week", label: "This week", percent: 78, resetsAt: "Monday" },
			{ kind: "week", label: "This week (Fable)", percent: 12, resetsAt: "" },
		],
	},
	usage_limits: {
		limits: [
			{ kind: "session", label: "Session", percent: 41, resetsAt: "at 6:00 PM" },
			{ label: "Week", percent: 78, resetsAt: "Monday" },
		],
		note: "These figures only cover this machine.",
		checkedAt: new Date(now).toISOString(),
		error: "",
	},
	usage_report: {
		generatedAt: new Date(now).toISOString(),
		last5h: TOTALS,
		today: TOTALS,
		last7Days: TOTALS,
		last30Days: TOTALS,
		allTime: TOTALS,
		byDay: [0, 1, 2, 3, 4, 5, 6].map((index) => ({
			key: `2026-08-0${index + 1}`,
			label: `0${index + 1}/08`,
			totals: TOTALS,
		})),
		byModel: [{ key: "opus", label: "Opus", totals: TOTALS }],
		byWorktree: [0, 1, 2].map((index) => ({
			key: `w${index}`,
			label: `storefront-topic-${index}`,
			totals: TOTALS,
		})),
		byMission: [
			{ key: "m1", label: "Fix cart total rounding", totals: TOTALS },
		],
		rateLimitSeen: false,
	},
	session_timeline: SESSION_TIMELINE,
	linear_issue: {
		id: "iss-3000",
		identifier: "NW-3000",
		title: "Show delivery estimates at checkout",
		description: [
			"Customers can't tell when their order will arrive until after they pay,",
			"and support gets a steady stream of \"when will it ship?\" emails from",
			"people who haven't checked out yet.",
			"",
			"## Expected",
			"",
			"- Each shipping option shows an estimated delivery date range.",
			"- The estimate uses the warehouse stock and the carrier's transit time.",
			"- Express keeps its next-day promise, or is hidden when it can't be met.",
		].join("\n"),
		url: "https://linear.app/northwind",
		priority: 1,
		estimate: 3,
		branchName: "topic-0-nw-3000",
		updatedAt: ago(15),
		state: { id: "st-2", name: ETATS.actif, color: "#f2c94c" },
		assignee: { id: "id-alice", name: "Alice", color: "#7c7aff" },
		labels: [
			{ id: "l1", name: "front", color: "#7c7aff" },
			{ id: "l2", name: "checkout", color: "#4ade80" },
		],
		comments: [
			{
				id: "c1",
				body: "Confirmed with product: express stays next-day only.",
				author: "Alice",
				createdAt: ago(120),
			},
			{
				id: "c2",
				body: "Does the estimate take the warehouse cut-off time into account?",
				author: "Dave",
				createdAt: ago(45),
			},
		],
	},
	repo_roles: { file: ".cockpit/roles.toml", ids: ["backend"], error: null, restricted: ["backend"], trusted: false },
	repo_roles_trust: { file: ".cockpit/roles.toml", ids: ["backend"], error: null, restricted: ["backend"], trusted: true },
	roles_list: [
		["backend", "Back-end", false],
		["frontend", "Front-end", false],
		["qa", "Recette", true],
		["review", "Relecture", true],
	].map(([id, label, verifies]) => ({
		id,
		label,
		verifies,
		prompt: "",
		model: "",
		engine: "",
		permissionMode: "",
		depth: "",
		command: "",
		scope: [],
	})),
	// Une journée plausible, calée sur l'heure réelle : la frise se lit par
	// rapport à « maintenant », des dates figées la laisseraient vide.
	executions_recent: () => {
		const run = (
			id: string,
			session: string,
			role: string,
			folder: string,
			start: number,
			end: number | null,
			outcome: string,
			usd: number,
		) => ({
			id, startedAt: ago(start), endedAt: end === null ? "" : ago(end),
			sessionId: session, protocol: "claude-stream-json", engine: "claude",
			engineLabel: "Claude Code", model: "sonnet-5", mission: "",
			origin: { actor: role ? "master" : "me", engagement: "", role, task: "", attempt: 0 },
			cwd: `/Users/demo/code/${folder}`, project: "principal", sandboxed: false,
			engineSession: "", outcome,
			tally: { turns: 12, inputTokens: 90000, outputTokens: 7000, cacheTokens: 0,
				cost: { reportedUsd: usd, estimatedUsd: 0, unknownTurns: 0 } },
			note: outcome === "failed" ? "The process stopped without returning an answer." : "",
			eventsDropped: 0, steps: [],
			observability: { reportsCost: true, reportsTokenSplit: true, reportsToolResults: true, reportsThinking: true, resumable: true },
		});
		return [
			run("r1", "s-ma", "maître", "loyalty-restore-nw-3051", 290, 270, "answered", 0.4),
			run("r2", "s-ma", "maître", "loyalty-restore-nw-3051", 60, null, "running", 0.3),
			run("r3", "s-be", "backend", "loyalty-restore-nw-3051-back", 265, 150, "answered", 1.8),
			run("r4", "s-fe", "frontend", "loyalty-restore-nw-3051-front", 262, 170, "answered", 1.2),
			run("r5", "s-fe", "frontend", "loyalty-restore-nw-3051-front", 120, null, "running", 0.9),
			run("r6", "s-qa", "qa", "loyalty-restore-nw-3051-qa", 165, 150, "failed", 0.2),
			run("r7", "s-me", "", "storefront-topic-1", 230, 200, "answered", 0.6),
			run("r8", "s-me", "", "storefront-topic-1", 95, 70, "answered", 0.5),
			run("r9", "s-pe", "", "storefront", 180, 176, "answered", 0.1),
		];
	},
	// La fiche demandée, pas toujours la même : c'est ce que relit le parcours.
	mission_get: ({ id }: Record<string, unknown>) =>
		(REPONSES.missions_list as Array<{ id: string }>).find((mission) => mission.id === id),
	// Une demande écrite dans Cockpit, sans suivi de tâches : la mission rendue
	// n'est pas guidée, pour que l'aperçu reste sur la liste et y affiche le message.
	mission_start_from_brief: ({ title }: Record<string, unknown>) => ({
		mission: {
			...(REPONSES.missions_list as Array<Record<string, unknown>>)[0],
			id: "m-brief",
			title,
			ticket: "",
			guided: false,
		},
		started: true,
		session: "agent-9",
		message: `Mission opened on ${String(title)}, the lead is analysing the issue.`,
	}),
	mission_activity: {
		master: {
			sessionId: "agent-4",
			running: true,
			working: true,
			last: "Read apps/web/billing/invoices.ts",
			waiting: 0,
		},
		tasks: [],
	},
	// L'historique de la mission « Fix cart total rounding » : une recette
	// renvoyée, puis une porte rouge sur l'API. Les autres n'ont pas d'historique,
	// comme une mission ouverte avant qu'il existe.
	mission_events: ({ id }: Record<string, unknown>) => {
		if (id !== "m1") return [];
		const output = [
			"$ pnpm test",
			"exit 1",
			" FAIL  api/cart.test.ts > rounds each line",
			"   expected 10.01 to be 10",
		].join("\n");
		return [
			{ at: ago(240), change: { kind: "opened", guided: true } },
			{ at: ago(226), change: { kind: "state", from: "planning", to: "awaitingApproval", note: "" } },
			{ at: ago(226), change: { kind: "draft", step: "split", version: 1, questions: 1 } },
			{ at: ago(226), change: { kind: "taskAdded", task: "t1", title: "Per-line rounding in the API", role: "backend" } },
			{ at: ago(226), change: { kind: "taskAdded", task: "t2", title: "Cart totals", role: "frontend" } },
			{ at: ago(226), change: { kind: "taskAdded", task: "t3", title: "Functional QA", role: "qa" } },
			{
				at: ago(180),
				change: { kind: "review", step: "split", version: 1, approved: true, feedback: "Keep the QA last." },
			},
			{ at: ago(180), change: { kind: "state", from: "awaitingApproval", to: "running", note: "" } },
			{ at: ago(150), change: { kind: "task", task: "t1", from: "planned", to: "running", note: "" } },
			{ at: ago(120), change: { kind: "task", task: "t3", from: "planned", to: "running", note: "" } },
			{
				at: ago(100),
				change: {
					kind: "task",
					task: "t3",
					from: "running",
					to: "delivered",
					note: "Verdict: blocking — the API still rounds on the order total.",
				},
			},
			{
				at: ago(96),
				change: {
					kind: "rework",
					task: "t3",
					attempt: 1,
					reason: "Re-run QA once the per-line rounding is delivered.",
				},
			},
			{ at: ago(96), change: { kind: "task", task: "t3", from: "delivered", to: "planned", note: "" } },
			{ at: ago(90), change: { kind: "task", task: "t3", from: "planned", to: "running", note: "" } },
			{
				at: ago(40),
				change: { kind: "task", task: "t1", from: "running", to: "delivered", note: "Worker finished — 3 commits." },
			},
			{ at: ago(39), change: { kind: "gate", task: "t1", gate: "running", output: "pnpm test", commit: "" } },
			{
				at: ago(37),
				change: {
					kind: "gate",
					task: "t1",
					gate: "failed",
					output,
					commit: "4d81b7e2c09a51f3e6b8d0c7a2f19e5b3c6d8a01",
				},
			},
			{ at: ago(35), change: { kind: "task", task: "t2", from: "planned", to: "running", note: "" } },
		];
	},
	// Ce que l'API avait changé quand sa porte a échoué : le test de l'arrondi
	// par ligne, et le calcul qu'il juge.
	mission_commit_diff: ({ commit }: Record<string, unknown>) => ({
		branch: commit,
		base: "fix-cart-rounding-nw-3044",
		mergeBase: "3e1a9c0b7d2f4e6a8c0b1d3f5a7c9e1b3d5f7a90",
		files: [
			{ path: "apps/api/cart/total.ts", added: 18, removed: 6, state: "modified" },
			{ path: "apps/api/cart/total.test.ts", added: 31, removed: 0, state: "added" },
		],
		commits: [],
		additions: 49,
		deletions: 6,
	}),
	mission_commit_file_diff: ({ file }: Record<string, unknown>) =>
		[
			`diff --git a/${file} b/${file}`,
			`--- a/${file}`,
			`+++ b/${file}`,
			"@@ -12,9 +12,15 @@ export function cartTotal(lines: CartLine[], currency: Currency) {",
			"-  const raw = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);",
			"-  return round(raw, currency.decimals);",
			"+  // Each line is rounded on its own, as the invoice shows it.",
			"+  return lines.reduce(",
			"+    (sum, line) => sum + round(line.price * line.quantity, currency.decimals),",
			"+    0,",
			"+  );",
			" }",
		].join("\n"),
	// Un poste d'exemple déjà prêt : la carte « prêt à démarrer » ne s'affiche
	// pas sur les captures du README.
	readiness_check: {
		ready: true,
		checks: [
			{ id: "git", required: true, ok: true, detail: "/usr/bin/git" },
			{ id: "claude", required: true, ok: true, detail: "/Users/demo/.local/bin/claude" },
			{ id: "claudeAuth", required: true, ok: true, detail: "demo@northwind.dev" },
			{ id: "node", required: true, ok: true, detail: "/opt/homebrew/bin/node" },
			{ id: "project", required: false, ok: true, detail: "/Users/demo/code/northwind" },
			{ id: "container", required: false, ok: false, detail: "" },
		],
	},
	// Le dossier d'une mission où une porte échoue et où la recette n'a pas
	// conclu : ce que l'écran doit montrer sans le maquiller.
	mission_dossier: {
		missionId: "m-preview",
		title: "Fix cart total rounding on multi-currency orders",
		branch: "fix/cart-rounding-nw-3044",
		gateCommands: ["pnpm test"],
		gates: [{ task: "Per-line rounding in the API", gate: "failed" }],
		verdicts: [{ task: "Functional QA", role: "qa", verdict: "blocking", delivered: true }],
		properties: { total: 6, held: 5, broken: 0, unsettled: 1, decorative: 1 },
		films: [],
		changes: { files: 7, insertions: 120, deletions: 14 },
		cost: { tasks: 3, reworks: 1, workedSeconds: 9000, tokens: 1_900_000, usd: 4.2 },
		overall: "failure",
		markdown: [
			"### Delivery dossier — Cockpit",
			"",
			"- ❌ Repository checks (`pnpm test`) fail for « Per-line rounding in the API »",
			"- ❌ Functional QA: rejected",
			"- ⚠️ Properties: 5/6 hold · 1 undecided · 1 never caught a past bug (decorative)",
			"- 📄 Changes: 7 file(s), +120 −14",
			"- 💸 Cost: 3 task(s), 1 rework(s), 150 min of work, ≈ 1.9 M tokens",
			"",
			"*Written by Cockpit from what it measured, not from what the agents said.*",
		].join("\n"),
	},
	mission_exposure: { sandboxed: false, unguardedRoles: ["backend", "frontend", "qa"] },
	mission_estimate: {
		sample: 7,
		medianSeconds: 11_400,
		medianSecondsPerTask: 2_850,
		expectedSeconds: 11_400,
		failureRate: 0.28,
		thin: false,
	},
	mission_overruns: [
		{
			missionId: "m1",
			missionTitle: "Fix cart total rounding on multi-currency orders",
			taskId: "t2",
			title: "Cart totals",
			seconds: 7 * 3600,
			expected: 2_850,
		},
	],
	linear_options: {
		states: [
			{ id: "st-1", name: ETATS.aFaire, color: "#7d7e93" },
			{ id: "st-2", name: ETATS.actif, color: "#f2c94c" },
			{ id: "st-3", name: ETATS.revue, color: "#56c8ff" },
			{ id: "st-4", name: ETATS.bloque, color: "#ff6b6b" },
			{ id: "st-5", name: ETATS.fini, color: "#4ade80" },
		],
		members: MEMBERS.map((name) => ({
			id: `id-${name.toLowerCase()}`,
			name,
			color: "#7c7aff",
		})),
		labels: [
			{ id: "l1", name: "front", color: "#7c7aff" },
			{ id: "l2", name: "checkout", color: "#4ade80" },
			{ id: "l3", name: "back", color: "#56c8ff" },
			{ id: "l4", name: "tech-debt", color: "#ffb454" },
		],
	},
	git_branches: {
		base: "dev",
		branches: [
			{
				name: "dev",
				isCurrent: false,
				isDefault: true,
				worktreePath: "/Users/demo/code/storefront",
				upstream: "origin/dev",
				ahead: 0,
				behind: 0,
				commitsAhead: 0,
				remoteOnly: false,
				remote: "",
				lastCommit: commit("a1b2c3d", "chore: release 0.29", "Alice", 30),
			},
			// Une branche d'un collègue, poussée et jamais sortie ici : c'est le
			// cas qui amène sur ce menu, et celui qu'on ne voyait pas.
			{
				name: "fix/invite-link-invalid-after-password-setup-nw-3124",
				isCurrent: false,
				isDefault: false,
				worktreePath: null,
				upstream: null,
				ahead: 0,
				behind: 0,
				commitsAhead: 3,
				remoteOnly: true,
				remote: "origin",
				lastCommit: commit("f0c41a8", "fix: keep the invite link valid", "Bob", 90),
			},
			...[1, 2, 3].map((index) => ({
				name: `topic-${index}-nw-${3000 + index}`,
				isCurrent: index === 1,
				isDefault: false,
				worktreePath: `/Users/demo/code/storefront-topic-${index}`,
				upstream: index === 3 ? null : `origin/topic-${index}-nw-${3000 + index}`,
				ahead: index,
				behind: index === 2 ? 4 : 0,
				commitsAhead: index + 1,
				remoteOnly: false,
				remote: "",
				lastCommit: commit(
					["b7e4f10", "c3a9d52", "d81f7ab"][index - 1],
					[
						"feat(search): tolerate typos in product search",
						"fix(cart): keep the order summary visible while scrolling",
						"chore(ci): cache the pnpm store between jobs",
					][index - 1],
					MEMBERS[index],
					index * 90 + 20,
				),
			})),
			{
				name: "feat/foundation",
				isCurrent: false,
				isDefault: false,
				worktreePath: null,
				upstream: "origin/feat/foundation",
				ahead: 0,
				behind: 37,
				commitsAhead: 12,
				lastCommit: commit("e02c6d4", "feat: foundation for the redesign", "Alice", 8600),
			},
		],
	},
	git_branch_diff: {
		branch: "topic-1-nw-3001",
		base: "dev",
		mergeBase: "a1b2c3d",
		additions: 148,
		deletions: 37,
		files: [
			{ path: "apps/web/src/catalog/search.ts", added: 92, removed: 21, state: "modified" },
			{ path: "apps/web/src/catalog/search.test.ts", added: 44, removed: 0, state: "added" },
			{ path: "apps/api/src/search/query.ts", added: 12, removed: 16, state: "modified" },
		],
		commits: [
			commit("b7e4f10", "feat(search): tolerate typos in product search", "Alice", 20),
			commit("9d3ac81", "test(search): cover misspelled queries", "Alice", 95),
		],
	},
	git_graph: [
		"* b7e4f10 (topic-1-nw-3001) feat(search): tolerate typos in product search",
		"* 9d3ac81 test(search): cover misspelled queries",
		"| * c3a9d52 (topic-2-nw-3002) fix(cart): keep the order summary visible while scrolling",
		"|/",
		"* a1b2c3d (HEAD -> dev, origin/dev) chore: release 0.29",
		"* 4f81b09 fix(web): lazy-load product images",
	].join("\n"),
	docs_scan: DOCS,
	// Un fichier de code a son exemple, pour juger la coloration ; le reste
	// retombe sur le document d'exemple.
	doc_read: ({ path }: Record<string, unknown>) => (/\.(tsx?|jsx?|rs|py|css|json)$/.test(String(path)) ? CODE_SAMPLE : DOC_SAMPLE),
	// De quoi éprouver la recherche de fichiers sur un dépôt de bonne taille.
	files_list: ({ root }: Record<string, unknown>) =>
		[
			"apps/web/src/cart.ts", "apps/web/src/cart/totals.ts", "apps/web/src/cart/notes.md", "apps/web/src/cart/rounding.ts",
			"apps/web/src/catalog/index.ts", "apps/web/.env.local", "apps/admin/src/app/page.tsx", "apps/api/src/loyalty/points.ts",
			"src/components/AgentMap.tsx", "src/components/WorkspacePanel.tsx", "src/components/FileViewer.tsx", "package.json", "README.md",
			...Array.from({ length: 6000 }, (_, index) => `packages/lib-${index % 40}/src/module-${index}/index.ts`),
		].map((relative) => ({ path: `${String(root)}/${relative}`, relative })),

	agents_list: [
		{
			sessionId: "agent-1",
			cwd: "/Users/demo/code/storefront-topic-1",
			running: true,
			claudeSessionId: "sess-0",
			working: true,
			detached: true,
		},
		{
			sessionId: "agent-3",
			cwd: "/Users/demo/code/storefront-topic-2",
			running: false,
			claudeSessionId: "sess-1",
			working: false,
			detached: false,
		},
	],
	relay_setting: { enabled: true },
	relay_survivors: [],
	// Une question en attente, pour voir la carte d'un agent qui a besoin de toi.
	permissions_pending: [
		{
			id: "perm-1",
			sessionId: "agent-1",
			tool: "AskUserQuestion",
			at: ago(1),
			input: {
				questions: [
					{
						question: "Should coupons be rounded per line, like products, or on the order total?",
						header: "Coupons",
						multiSelect: false,
						options: [
							{ label: "On the order total", description: "That's what the payment provider does today." },
							{ label: "Per line, like products", description: "Simpler, but the total will drift by a cent." },
						],
					},
				],
			},
		},
	],
	// Le carnet dans son état intéressant : une reprise à lire, deux leçons déjà
	// retenues dont une qui n'a jamais servi. C'est ce mélange qui fait juger
	// l'écran — un carnet vide ou parfait ne montre rien.
	notebook_handbacks: [
		{
			id: "hb-1",
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
			project: "/Users/demo/code/storefront",
			branch: "fix-cart-rounding-nw-3044",
			at: Math.round(Date.now() / 1000) - 5400,
			files: ["apps/web/src/cart.ts", "apps/web/src/rounding.ts"],
			patch: `### apps/web/src/rounding.ts
@@ -12,7 +12,7 @@
-const DECIMALS = 2;
+import { currencyDecimals } from "@northwind/money";
@@ -28,4 +28,4 @@
-  return Math.round(total * 100) / 100;
+  return roundLines(lines, currencyDecimals(currency));
`,
		},
	],
	notebook_lessons: [
		{
			id: "ls-1",
			text: "Money rules live in `@northwind/money`. Don't copy them into a component: they change without notice and two copies drift apart within a week.",
			scope: ["apps/web/src"],
			source: "reprise",
			project: "/Users/demo/code/storefront",
			at: Math.round(Date.now() / 1000) - 8 * 86_400,
			uses: 4,
			lastUsed: Math.round(Date.now() / 1000) - 2 * 86_400,
		},
		{
			id: "ls-2",
			text: "Write error messages in the second person, and say what to do next.",
			scope: [],
			source: "main",
			project: "/Users/demo/code/storefront",
			at: Math.round(Date.now() / 1000) - 100 * 86_400,
			uses: 0,
			lastUsed: 0,
		},
	],
	brief_sources: [
		{
			id: "product",
			label: "What the product does",
			hint: "the sentence declared for reading changes — without it, an agent only talks about code",
		},
		{
			id: "place",
			label: "The branch and its state",
			hint: "base, divergence, uncommitted files, latest commits — read from the repository, always available",
		},
		{
			id: "ticket",
			label: "The branch's ticket",
			hint: "the request and its comments, in the declared tracker",
		},
		{
			id: "review",
			label: "Review feedback",
			hint: "description and discussion of the merge request open on this branch",
		},
		{
			id: "attempts",
			label: "What has already been tried",
			hint: "past conversations in this folder, one line each",
		},
	],
	// Le dossier de contexte d'un agent qui démarre : quatre sources qui ont
	// répondu, une qui n'a rien pu dire. C'est ce mélange qu'il faut regarder —
	// un aperçu où tout marche ne montre pas comment un manque s'affiche.
	brief_compose: {
		cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
		branch: "fix-cart-rounding-nw-3044",
		missing: ["ticket NW-3044 unreadable (401 — the Linear token has expired)"],
		sections: [
			{
				id: "product",
				label: "The product",
				detail: "what the team declared",
				chars: 214,
				on: true,
				ids: [],
				text: "## What this product does\n\nAn online store. Customers browse products, fill a cart and check out. The cart total decides what gets charged: if it is wrong, the customer pays an amount that differs from what they saw.",
			},
			{
				id: "place",
				label: "The branch",
				detail: "repository state",
				chars: 486,
				on: true,
				ids: [],
				text: "## Where you're working\n\n- Folder: `/Users/demo/code/fix-cart-rounding-nw-3044`\n- Branch: `fix-cart-rounding-nw-3044`\n- Base: `main` — 3 commits ahead, 1 commit behind\n- Working copy: 2 uncommitted files\n\n### Files already changed here\n\n- `apps/web/src/cart.ts` (+24 −6)\n- `apps/web/src/rounding.ts` (new)\n\n### Latest commits\n\n- `9f2c1ab` Round each cart line before summing (2 hours ago)\n- `41ba07d` Move the rounding rule out of the component (3 hours ago)",
			},
			{
				id: "review",
				label: "Review #318",
				detail: "2 comments",
				chars: 402,
				on: true,
				ids: [],
				text: "## Merge request #318 — Fix cart total rounding on multi-currency orders\n\n- State: open\n- URL: https://github.com/northwind/storefront/pull/318\n\n### What was said\n\nThe comments below have not necessarily been addressed. Check the code before concluding that a point is settled.\n\n- **bob** (review, changes_requested): the currency precision is still hard-coded in the component.\n- **dave** (comment): what about currencies with no decimals, like JPY?",
			},
			{
				id: "attempts",
				label: "Attempts",
				detail: "2 conversations",
				chars: 268,
				on: false,
				ids: [],
				text: "## What has already been tried in this folder\n\n2 conversations have already taken place here. It's not necessarily related to what you're being asked — but if it is, don't repeat what failed.\n\n- “fix the cart rounding” (14 exchanges, ended on an error)\n- “move the rounding rule out of the component” (6 exchanges)",
			},
		],
	},
	worktrees_hygiene: [],
	// Le poids des worktrees. Un principal léger, des worktrees de travail qui
	// portent chacun leur build : c'est ce déséquilibre qu'il faut voir à
	// l'écran, et la raison pour laquelle les dépendances sont dites à part.
	worktrees_usage: [0, 1, 2, 3, 4].map((index) => ({
		path:
			index === 4
				? "/Users/demo/code/fix-cart-rounding-nw-3044"
				: `/Users/demo/code/storefront-topic-${index}`,
		bytes: index === 0 ? 2_900_000_000 : 3_700_000_000,
		builds: index === 0 ? 0 : 920_000_000 - index * 40_000_000,
		dependencies: 2_500_000_000,
		measuredAt: Math.floor(now / 1000) - 120,
	})),
	worktree_purge_builds: 0,
	scripts_list: [
		{ name: "dev", command: "turbo run dev", group: "storefront", runner: "pnpm" },
		{ name: "build", command: "turbo run build", group: "storefront", runner: "pnpm" },
		{ name: "test", command: "vitest run", group: "storefront", runner: "pnpm" },
		{ name: "test:e2e", command: "playwright test", group: "storefront", runner: "pnpm" },
		{ name: "lint", command: "biome check .", group: "storefront", runner: "pnpm" },
		{ name: "db:migrate", command: "prisma migrate deploy", group: "api", runner: "pnpm" },
	],
	// L'assemblage se fait côté Rust : l'aperçu montre une ligne plausible.
	command_line: "pnpm worktree:create feat/my-feature --from dev",
	commands_detect: [
		{
			id: "script-build",
			group: "storefront",
			label: "build",
			description: "turbo run build",
			base: "pnpm build",
			positional: null,
			options: [],
			scoped: true,
			danger: false,
		},
		{
			id: "script-lint",
			group: "storefront",
			label: "lint",
			description: "biome check .",
			base: "pnpm lint",
			positional: null,
			options: [],
			scoped: true,
			danger: false,
		},
	],
	listening_ports: [
		// Deux serveurs sur le workspace que l'aperçu ouvre : sans eux, le
		// moniteur du workspace s'y montrerait toujours vide.
		{
			port: 3100,
			process: "node",
			pid: 51022,
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044/apps/web",
			memoryMb: 1840,
		},
		{
			port: 5433,
			process: "postgres",
			pid: 51190,
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
			memoryMb: 260,
		},
		{
			port: 3000,
			process: "node",
			pid: 48211,
			cwd: "/Users/demo/code/storefront-topic-1/apps/web",
		memoryMb: 2100,
		},
		{
			port: 3001,
			process: "node",
			pid: 48242,
			cwd: "/Users/demo/code/storefront-topic-1/apps/api",
		memoryMb: 1800,
		},
		{
			port: 3100,
			process: "vite",
			pid: 51904,
			cwd: "/Users/demo/code/storefront-topic-3",
			memoryMb: 2180,
		},
		{ port: 4300, process: "node", pid: 22118, cwd: "", memoryMb: 1420 },
		{ port: 5432, process: "postgres", pid: 1204, cwd: "/", memoryMb: 180 },
		{ port: 6379, process: "redis-server", pid: 1288, cwd: "/", memoryMb: 40 },
	],
	docker_containers: [
		{
			id: "c1a2b3",
			name: "northwind-postgres",
			image: "postgres:16",
			state: "running",
			status: "Up 3 hours",
			ports: "5432->5432",
		},
		{
			id: "d4e5f6",
			name: "northwind-redis",
			image: "redis:7",
			state: "running",
			status: "Up 3 hours",
			ports: "6379->6379",
		},
		{
			id: "a7b8c9",
			name: "northwind-mailhog",
			image: "mailhog/mailhog",
			state: "exited",
			status: "Exited (0) 2 days ago",
			ports: "",
		},
	],
};

// Le chantier d'exemple a fait tourner les mêmes agents que la mission : un seul
// jeu à tenir, et les deux écrans montrent une histoire cohérente.
REPONSES.workspace_executions = REPONSES.mission_executions;

/** Vrai quand le pont natif est là — donc quand les API Tauri répondent. */
export function hasTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Vrai quand l'app tourne hors de sa fenêtre native, en développement. */
export function isPreview(): boolean {
	return (
		import.meta.env.DEV &&
		typeof window !== "undefined" &&
		!("__TAURI_INTERNALS__" in window)
	);
}

/**
 * Combien de temps l'aperçu fait attendre une commande.
 *
 * Le pont natif répond en quelques dizaines de millisecondes, l'aperçu
 * instantanément : les états de chargement — silhouettes, fils d'attente,
 * blocs encore vides — ne s'affichaient donc jamais assez longtemps pour
 * qu'on les regarde, et ils partaient en production sans avoir été vus.
 * `?slow` les rend observables, et `?slow=1500` règle la durée.
 *
 * Les commandes ne répondent pas toutes en même temps, exprès : c'est ainsi
 * qu'un écran se remplit pour de vrai, source après source.
 */
export function previewDelay(command: string): number {
	if (!isPreview() || typeof window === "undefined") return 0;
	const asked = new URLSearchParams(window.location.search).get("slow");
	if (asked === null) return 0;
	const base = Number(asked) || 1200;
	// Un décalage stable par commande, pour que l'ordre d'arrivée ne change pas
	// d'un rechargement à l'autre.
	let empreinte = 0;
	for (const lettre of command) empreinte = (empreinte + lettre.charCodeAt(0)) % 17;
	return base + empreinte * 90;
}

/** La réponse d'aperçu d'une commande, ou `undefined` si on n'en a pas.
 *
 * Une réponse peut être une fonction des arguments : une fiche demandée par
 * son identifiant doit rendre celle-là, pas toujours la même. */
export function previewFor(command: string, args?: Record<string, unknown>): unknown {
	const canned = REPONSES[command];
	return typeof canned === "function" ? canned(args ?? {}) : canned;
}

/** La page d'exemple que montre l'onglet « Navigateur » hors de la fenêtre native. */
const DOC_SAMPLE = [
		"# Plan — Fix cart total rounding on multi-currency orders",
		"",
		"## What's wrong",
		"",
		"The payment provider rounds each line to the currency's precision before",
		"summing. Our cart sums the raw amounts and rounds once: a cart shown at",
		"€10.00 gets charged €9.99, and the opposite happens too — the receipt",
		"disagrees with the order summary the customer just confirmed.",
		"",
		"## Split",
		"",
		"| Role | Task | Scope |",
		"| --- | --- | --- |",
		"| back | Per-line rounding in the API | `apps/api/src/orders/**` |",
		"| front | Cart totals and order summary | `apps/web/src/cart.ts` |",
		"| QA | Real checkout against the payment sandbox | — |",
		"",
		"## What we're not doing",
		"",
		"- Tax rounding: it follows its own rules, that's a separate topic.",
		"- Currency conversion rates, out of scope.",
	].join("\n");

const CODE_SAMPLE = `import { useMemo, useState } from "react";
import type { Currency } from "@/money";

/** The cart total, in minor units of the order's currency. */
export interface Total {
	amount: number;
	rounded: boolean;
}

const DEFAULT_DECIMALS = 2;

// The payment provider rounds each line before summing, whatever the currency.
export function cartTotal(lines: number[], currency: Currency): Total {
	const decimals = currency.decimals ?? DEFAULT_DECIMALS;
	const factor = 10 ** decimals;
	const amount = lines.reduce((total, line) => total + Math.round(line * factor), 0);
	return { amount, rounded: lines.some((line) => line * factor !== Math.round(line * factor)) };
}

export function CartSummary({ lines, currency }: { lines: number[]; currency: Currency }) {
	const [open, setOpen] = useState(false);
	const total = useMemo(() => cartTotal(lines, currency), [lines, currency]);
	if (!open && lines.length === 0) return null;
	return (
		<span className={total.rounded ? "text-warning" : "text-muted"} onFocus={() => setOpen(true)}>
			Total — \${currency.code}
		</span>
	);
}
`;

export const PREVIEW_PAGE = {
	url: "http://localhost:3100/cart",
	title: "Cart — Storefront",
	width: 1280,
	height: 713,
	src: `data:image/svg+xml;utf8,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 713"><rect width="1280" height="713" fill="#f4f6f8"/><rect width="1280" height="56" fill="#fff"/><rect x="32" y="20" width="120" height="16" rx="8" fill="#141a20"/><rect x="1080" y="14" width="168" height="28" rx="14" fill="#0f766e"/><rect x="240" y="104" width="800" height="480" rx="16" fill="#fff" stroke="#d9dee4"/><rect x="280" y="148" width="360" height="18" rx="9" fill="#d9dee4"/><rect x="280" y="196" width="720" height="14" rx="7" fill="#e6eaee"/><rect x="280" y="228" width="640" height="14" rx="7" fill="#e6eaee"/><rect x="280" y="260" width="420" height="14" rx="7" fill="#2f6fdb" opacity=".5"/><rect x="280" y="292" width="560" height="14" rx="7" fill="#e6eaee"/><rect x="820" y="520" width="180" height="40" rx="20" fill="#fbe9c8" stroke="#a96300"/><text x="910" y="546" text-anchor="middle" font-family="monospace" font-size="16" fill="#a96300">Total €9.99</text><text x="640" y="650" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#858d9b">Page d'exemple — l'image en direct n'existe que dans la fenêtre native</text></svg>`,
	)}`,
};
