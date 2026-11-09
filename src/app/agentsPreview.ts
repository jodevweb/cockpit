import { t } from "@/i18n";
import { isPreview } from "@/lib/preview";
import type { ContextUsage } from "@/lib/types";
import type { AgentRun } from "./agents";

/**
 * Deux agents ouverts, pour que l'écran Workspaces existe hors de Tauri.
 *
 * Les agents ne se listent pas au démarrage : ils naissent d'un lancement et
 * vivent dans ce registre. Hors du pont natif, personne ne les lance — l'écran
 * s'ouvrait donc sur « Aucun workspace ouvert », et il était impossible d'y
 * regarder quoi que ce soit. Un agent qui parle, un autre à l'arrêt : de quoi
 * juger les deux états.
 */
export function previewRuns(): AgentRun[] {
	if (!isPreview()) return [];
	const common = {
		mode: "acceptEdits",
		model: "",
		activeModel: "claude-opus-5",
		commands: ["/pull-request-creation", "/review"],
		equipment: {
			probed: true,
			servers: [
				{ name: "linear", status: "connected" },
				{ name: "claude.ai Sentry", status: "connected" },
				{ name: "stripe", status: "needs-auth" },
				{ name: "figma-dev-mode", status: "failed" },
			],
			skills: ["performing-self-qa", "writing-tests", "product-write-task"],
			subagents: ["Explore", "Plan", "code-simplifier"],
			plugins: ["figma"],
		},
		contextWindow: 200_000,
		unread: 0,
	};
	// Une mesure telle que le CLI la rend, pour que la jauge du chantier se
	// voie en aperçu : rien ne répond à `probeContext` hors du pont natif.
	const usage = (messages: number, tools: Array<[string, number, number]>): ContextUsage => ({
		totalTokens: 21_400 + messages,
		maxTokens: 200_000,
		percentage: Math.round(((21_400 + messages) / 200_000) * 100),
		model: "claude-opus-5",
		autoCompactThreshold: 167_000,
		isAutoCompactEnabled: true,
		categories: [
			{ name: "System prompt", tokens: 2_300, kind: "used" },
			{ name: "System tools", tokens: 3_100, kind: "used" },
			{ name: "MCP tools", tokens: 5_600, kind: "used" },
			{ name: "MCP server instructions", tokens: 2_600, kind: "used" },
			{ name: "MCP tools (deferred)", tokens: 38_000, kind: "deferred" },
			{ name: "Memory files", tokens: 4_200, kind: "used" },
			{ name: "Skills", tokens: 3_600, kind: "used" },
			{ name: "Messages", tokens: messages, kind: "used" },
			{ name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
			{ name: "Free space", tokens: 200_000 - 21_400 - messages - 33_000, kind: "free" },
		],
		memoryFiles: [
			{ path: "/Users/demo/code/fix-cart-rounding-nw-3044/CLAUDE.md", type: "Project", tokens: 3_100 },
			{ path: "/Users/demo/.claude/CLAUDE.md", type: "User", tokens: 1_100 },
		],
		mcpServers: [
			{ name: "linear", tokens: 3_900, loaded: 6, deferred: 22 },
			{ name: "claude.ai Sentry", tokens: 1_700, loaded: 3, deferred: 14 },
		],
		skills: { total: 12, tokens: 3_600 },
		messages: {
			toolCallTokens: Math.round(messages * 0.08),
			toolResultTokens: Math.round(messages * 0.62),
			assistantMessageTokens: Math.round(messages * 0.22),
			userMessageTokens: Math.round(messages * 0.08),
			toolCallsByType: tools.map(([name, callTokens, resultTokens]) => ({ name, callTokens, resultTokens })),
		},
		at: Date.now(),
	});
	const min = (minutes: number) => Date.now() - minutes * 60_000;
	// Une capture d'écran esquissée, comme le navigateur en renvoie : une liste
	// de cartes, dont le titre déborde ou non.
	const sketch = (overflow: boolean) =>
		`data:image/svg+xml;utf8,${encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 300"><rect width="390" height="300" fill="#f4f6f8"/>${[0, 1, 2]
				.map(
					(row) =>
						`<rect x="16" y="${20 + row * 88}" width="${overflow ? 470 : 358}" height="74" rx="10" fill="${overflow ? "#fbe9e7" : "#fff"}" stroke="${overflow ? "#cf3f35" : "#d9dee4"}"/><rect x="30" y="${34 + row * 88}" width="${overflow ? 420 : 240}" height="10" rx="5" fill="#141a20"/>${overflow ? "" : `<rect x="30" y="${50 + row * 88}" width="150" height="10" rx="5" fill="#141a20"/>`}<rect x="30" y="${70 + row * 88}" width="60" height="12" rx="6" fill="#dcf1ed"/>`,
				)
				.join("")}</svg>`,
		)}`;
	return [
		{
			...common,
			id: "run-1",
			sessionId: "agent-1",
			claudeSessionId: "sess-9",
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
			label: "Lead · Fix cart total rounding",
			contextTokens: 84_000,
			usage: usage(62_600, [
				["Read", 900, 31_000],
				["Grep", 300, 4_200],
				["Edit", 2_100, 600],
				["Task", 400, 3_800],
			]),
			running: true,
			thinking: false,
			activity: "waiting for your reply",
			turns: [
				{
					kind: "user",
					text: "The cart shows €10.00 but the payment provider charges €9.99. Find where the gap comes from.\n\nAttached files, read them before replying:\n- /Users/demo/Captures/cart-total.png\n- /Users/demo/Notes/rounding-rules.md",
					context: "The branch · Ticket NW-3044 · Review #318",
					at: min(34),
				},
				{
					kind: "assistant",
					text: "Converted prices have to be rounded line by line. I'm checking how the cart computes its total.",
					at: min(33),
				},
				// Deux lectures que l'agent « Rounding rules per currency » rendra périmées
				// en écrivant ces fichiers après lui : c'est ce que la carte du
				// chantier doit montrer.
				{
					kind: "tool",
					text: "apps/web/src/cart/rounding.ts",
					tool: "Read",
					toolId: "t-r1",
					input: { file_path: "apps/web/src/cart/rounding.ts" },
					output: "Read 88 lines.",
					at: min(32),
					doneAt: min(32),
				},
				{
					kind: "tool",
					text: "apps/web/src/cart.ts",
					tool: "Read",
					toolId: "t-r2",
					input: { file_path: "apps/web/src/cart.ts" },
					output: "Read 310 lines.",
					at: min(31),
					doneAt: min(31),
				},
				{
					kind: "tool",
					text: "apps/web/src/cart/totals.ts",
					tool: "Read",
					toolId: "t-r3",
					input: { file_path: "apps/web/src/cart/totals.ts" },
					output: "Read 42 lines.",
					at: min(30),
					doneAt: min(30),
				},
				// Une écriture, pour que le récapitulatif des fichiers touchés se
				// voie en aperçu : c'est lui qui répond à « et maintenant, où est
				// le résultat ».
				{
					kind: "tool",
					text: "apps/web/src/cart.ts",
					tool: "Edit",
					toolId: "t0",
					input: { file_path: "apps/web/src/cart.ts" },
					output: "The file has been updated.",
					at: min(28),
					doneAt: min(28),
				},
				{
					kind: "tool",
					text: "",
					tool: "Grep",
					toolId: "t1",
					input: { pattern: "lineTotal|toFixed", path: "apps/web/src" },
					output:
						"apps/web/src/cart.ts:142  const total = lines.reduce((sum, line) => sum + line.price * line.qty, 0);",
				},
				// Une délégation en cours, pour que le fil d'un sous-agent se voie
				// en aperçu : c'est le seul endroit où l'on peut juger un fil
				// imbriqué, un vrai sous-agent ne vivant que dans la fenêtre native.
				{
					kind: "tool",
					text: "cover the per-line rounding rule",
					tool: "Task",
					toolId: "t2",
					at: Date.now() - 195_000,
					// Parti en arrière-plan : l'appel a répondu, le sous-agent court
					// encore — c'est l'état que la carte ne doit pas dire « terminé ».
					output: "Async agent launched successfully.",
					doneAt: Date.now() - 194_000,
					background: { endedAt: null },
					input: {
						description: "cover the per-line rounding rule",
						subagent_type: "general-purpose",
					},
					sub: [
						{
							kind: "user",
							text: "Write the cart total tests: single currency, EUR to USD, a discount line, a zero-price line.",
						},
						{
							kind: "tool",
							text: "",
							tool: "Read",
							toolId: "s1",
							input: { file_path: "apps/web/src/cart.test.ts" },
							output: "Read 31 lines.",
						},
						{
							kind: "assistant",
							text: "The file has no multi-currency case. I'm adding all four.",
						},
						{
							kind: "tool",
							text: "",
							tool: "Edit",
							toolId: "s2",
							input: {
								file_path: "apps/web/src/cart.test.ts",
								old_string: "x",
								new_string: "y\nz\nw",
							},
						},
					],
				},
				{
					kind: "assistant",
					text: "It is `toFixed(2)` on the raw sum: no per-line rounding. I'm fixing it, but should converted prices round half-to-even, as the ticket asks?",
				},
			],
		},
		{
			...common,
			id: "run-2",
			sessionId: "agent-3",
			claudeSessionId: "sess-1",
			cwd: "/Users/demo/code/storefront-topic-2",
			label: "Cart totals",
			contextTokens: 21_000,
			running: false,
			thinking: false,
			activity: null,
			// Trois consignes, datées : de quoi voir la session entière sur la
			// carte, les épisodes passés repliés, et des durées qui ont un sens.
			turns: [
				{ kind: "user", text: "Explain how loyalty points are granted after a payment.", at: Date.now() - 48 * 60_000 },
				{ kind: "tool", tool: "Grep", text: "grant_points", input: { pattern: "grant_points" }, output: "3 files", at: Date.now() - 47 * 60_000, doneAt: Date.now() - 47 * 60_000 },
				{ kind: "tool", tool: "Read", text: "loyalty/points.ts", input: { file_path: "src/loyalty/points.ts" }, output: "…", at: Date.now() - 46 * 60_000, doneAt: Date.now() - 46 * 60_000 },
				{ kind: "assistant", text: "Points are granted in the `invoice.paid` webhook, once per invoice. Should I look at refunds too?", at: Date.now() - 44 * 60_000 },
				{ kind: "user", text: "No, just that for now.", at: Date.now() - 43 * 60_000 },
				{ kind: "assistant", text: "Okay, I'll stop there.", at: Date.now() - 43 * 60_000 },
				{ kind: "user", text: "Add a test that replays the same webhook twice.", at: Date.now() - 40 * 60_000 },
				{ kind: "tool", tool: "Write", text: "points.test.ts", input: { file_path: "src/loyalty/points.test.ts", content: "a\nb\nc\nd\ne\nf" }, output: "ok", at: Date.now() - 38 * 60_000, doneAt: Date.now() - 38 * 60_000 },
				{ kind: "tool", tool: "Bash", text: "npm test", input: { command: "npm test -- points" }, output: "1 failed", outputError: true, at: Date.now() - 37 * 60_000, doneAt: Date.now() - 36 * 60_000 },
				{ kind: "assistant", text: "The test fails: the replayed webhook grants the points twice. That's a real bug.", at: Date.now() - 35 * 60_000 },
				{ kind: "user", text: "Restore loyalty points after a failed checkout.", at: Date.now() - 20 * 60_000 },
				{ kind: "tool", tool: "Edit", text: "points.ts", input: { file_path: "src/loyalty/points.ts", old_string: "a", new_string: "a\nb\nc" }, output: "ok", at: Date.now() - 16 * 60_000, doneAt: Date.now() - 16 * 60_000 },
				{ kind: "tool", tool: "Bash", text: "npm test", input: { command: "npm test -- points" }, output: "ok", at: Date.now() - 12 * 60_000, doneAt: Date.now() - 11 * 60_000 },
				{
					kind: "assistant",
					text: "The restore must not replay points already granted. I added the guard and the tests pass.",
					at: Date.now() - 9 * 60_000,
				},
			],
		},
		// Un second agent sur le même worktree, qui écrit après le maître dans
		// deux fichiers que celui-ci a lus : de quoi voir une collision et une
		// lecture périmée sur la carte du chantier.
		{
			...common,
			id: "run-4",
			sessionId: "agent-5",
			claudeSessionId: "sess-5",
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
			label: "Rounding rules per currency",
			contextTokens: 41_000,
			usage: usage(19_600, [
				["Read", 500, 9_800],
				["Edit", 1_700, 400],
				["Bash", 300, 2_900],
			]),
			running: true,
			thinking: true,
			activity: "Edit",
			turns: [
				{ kind: "user", text: "Move the rounding rules into a per-currency module, with their tests.", at: min(26) },
				{ kind: "tool", tool: "Read", text: "rounding.ts", toolId: "u1", input: { file_path: "apps/web/src/cart/rounding.ts" }, output: "Read 88 lines.", at: min(25), doneAt: min(25) },
				{ kind: "tool", tool: "Read", text: "currencies", toolId: "u2", input: { file_path: "apps/web/src/currencies/index.ts" }, output: "Read 40 lines.", at: min(24), doneAt: min(24) },
				{
					kind: "system",
					text: t("app:agents.turn.compactedAuto"),
					compact: { trigger: "auto", preTokens: 161_000 },
					at: min(20),
				},
				{ kind: "tool", tool: "Edit", text: "rounding.ts", toolId: "u3", input: { file_path: "apps/web/src/cart/rounding.ts", old_string: "a", new_string: "a\nb" }, output: "ok", at: min(12), doneAt: min(12) },
				{ kind: "tool", tool: "Write", text: "currencies/eur.ts", toolId: "u4", input: { file_path: "apps/web/src/currencies/eur.ts", content: "a\nb\nc" }, output: "ok", at: min(10), doneAt: min(10) },
				{ kind: "tool", tool: "Bash", text: "pnpm test currencies", toolId: "u5", input: { command: "pnpm test currencies" }, output: "12 passed", at: min(8), doneAt: min(7) },
				{ kind: "assistant", text: "The currency module is in place. Wiring the cart into it now.", at: min(7) },
				{ kind: "tool", tool: "Edit", text: "cart.ts", toolId: "u6", input: { file_path: "apps/web/src/cart.ts", old_string: "a", new_string: "b" }, output: "ok", at: min(6), doneAt: min(6) },
			],
		},
		// Un agent qui a fini un travail visible : captures avant et après, une
		// image annotée, une mesure, des tests rouges puis verts, une PR. De quoi
		// juger la planche et le film d'un tour, qui ne vivent que de ces gestes.
		{
			...common,
			id: "run-5",
			sessionId: "agent-6",
			claudeSessionId: "sess-6",
			cwd: "/Users/demo/code/storefront-staging",
			label: "Cart summary overflows on mobile",
			contextTokens: 58_000,
			running: true,
			thinking: false,
			activity: null,
			turns: [
				{ kind: "user", text: "The cart summary overflows on mobile, and the cart page takes two seconds to load. Fix both.", at: min(19) },
				{ kind: "tool", tool: "Read", text: "CartSummary.tsx", toolId: "p1", input: { file_path: "apps/web/src/cart/CartSummary.tsx" }, output: "Read 120 lines.", at: min(18.5), doneAt: min(18.4) },
				{ kind: "tool", tool: "Read", text: "CartLines.tsx", toolId: "p2", input: { file_path: "apps/web/src/cart/CartLines.tsx" }, output: "Read 64 lines.", at: min(18.3), doneAt: min(18.2) },
				{ kind: "tool", tool: "Read", text: "orders.service.ts", toolId: "p3", input: { file_path: "apps/api/src/orders/orders.service.ts" }, output: "Read 210 lines.", at: min(18), doneAt: min(17.9) },
				{ kind: "tool", tool: "mcp__navigateur__browser_take_screenshot", text: "capture", toolId: "p4", input: {}, output: "Screenshot taken.", outputImages: [sketch(true)], at: min(17.5), doneAt: min(17.4) },
				{ kind: "tool", tool: "Write", text: "before-cart.png", toolId: "p5", input: { file_path: "/Users/demo/code/storefront-staging/.claude/work/rendu/before-cart.png", content: "" }, output: "ok", at: min(17.3), doneAt: min(17.3) },
				{ kind: "assistant", text: "Line titles in the summary never wrap, and the cart query loads every line with all of its product images. Starting with the summary.", at: min(17) },
				{ kind: "tool", tool: "Edit", text: "CartSummary.tsx", toolId: "p6", input: { file_path: "/Users/demo/code/storefront-staging/apps/web/src/cart/CartSummary.tsx", old_string: "<h3 className=\"truncate\">{line.title}</h3>", new_string: "<h3 className=\"line-clamp-2 break-words\">{line.title}</h3>\n<Badges line={line} wrap />" }, output: "ok", at: min(15), doneAt: min(15) },
				{ kind: "tool", tool: "Bash", text: "pnpm test cart", toolId: "p7", input: { command: "pnpm --filter web test cart" }, output: " ✓ CartLines > renders the lines\n ✗ CartSummary > truncates long titles\n ✗ CartSummary > keeps badges on one line\n Tests: 2 failed, 14 passed", outputError: true, at: min(13), doneAt: min(12.5) },
				{ kind: "tool", tool: "Edit", text: "CartSummary.spec.tsx", toolId: "p8", input: { file_path: "/Users/demo/code/storefront-staging/apps/web/src/cart/CartSummary.spec.tsx", old_string: "expect(title).toHaveClass(\"truncate\")", new_string: "expect(title).toHaveClass(\"line-clamp-2\")" }, output: "ok", at: min(12), doneAt: min(12) },
				{ kind: "tool", tool: "Edit", text: "orders.service.ts", toolId: "p9", input: { file_path: "/Users/demo/code/storefront-staging/apps/api/src/orders/orders.service.ts", old_string: "include: { images: true }", new_string: "select: { id: true, title: true, price: true }" }, output: "ok", at: min(10), doneAt: min(10) },
				{ kind: "tool", tool: "Bash", text: "pnpm test cart", toolId: "p10", input: { command: "pnpm --filter web test cart" }, output: " ✓ CartLines > renders the lines\n ✓ CartSummary > wraps the title onto two lines\n Tests: 16 passed", at: min(8), doneAt: min(7.6) },
				{ kind: "tool", tool: "mcp__navigateur__browser_navigate", text: "localhost:3000", toolId: "p11", input: { url: "http://localhost:3000" }, output: "### Ran Playwright code\n```js\nawait page.goto('http://localhost:3000/');\n```\n### Page\n- Page URL: http://localhost:3000/", at: min(7), doneAt: min(6.9) },
				{ kind: "tool", tool: "mcp__navigateur__browser_resize", text: "390×844", toolId: "p11r", input: { width: 390, height: 844 }, output: "### Ran Playwright code\n```js\nawait page.setViewportSize({ width: 390, height: 844 });\n```", at: min(6.9), doneAt: min(6.9) },
				{ kind: "tool", tool: "mcp__navigateur__browser_click", text: "Cart", toolId: "p11c", input: { element: "Cart" }, output: "### Ran Playwright code\n```js\nawait page.getByRole('link', { name: 'Cart' }).click();\n```\n### Page\n- Page URL: http://localhost:3000/cart", at: min(6.85), doneAt: min(6.8) },
				{ kind: "tool", tool: "mcp__navigateur__browser_take_screenshot", text: "capture", toolId: "p11b", input: {}, output: "Screenshot taken.", outputImages: [sketch(false)], at: min(6.7), doneAt: min(6.6) },
				{ kind: "tool", tool: "Write", text: "after-cart.png", toolId: "p12", input: { file_path: "/Users/demo/code/storefront-staging/.claude/work/rendu/after-cart.png", content: "" }, output: "ok", at: min(6.5), doneAt: min(6.5) },
				{ kind: "tool", tool: "mcp__cockpit__illustrer", text: "capture", toolId: "p13", input: { genre: "capture", titre: "The cart summary at 390 px wide", source: "capture", image: "/Users/demo/code/storefront-staging/.claude/work/rendu/after-cart.png", reperes: [{ x: 0.3, y: 0.18, texte: "The title wraps onto two lines instead of being cut off." }, { x: 0.82, y: 0.78, texte: "The total stays visible without scrolling." }] }, output: "Illustration noted (capture).", at: min(6), doneAt: min(6) },
				{ kind: "tool", tool: "mcp__cockpit__illustrer", text: "mesure", toolId: "p14", input: { genre: "mesure", titre: "The cart query", source: "mesure", unite: "ms", commande: "pnpm --filter api bench orders:cart", mesures: [{ label: "GET /api/cart · p95", avant: 1840, apres: 310 }, { label: "Response size", avant: 912, apres: 64, unite: "KB" }] }, output: "Illustration noted (mesure).", at: min(5.5), doneAt: min(5.5) },
				{ kind: "tool", tool: "mcp__cockpit__illustrer", text: "frise", toolId: "p15", input: { genre: "frise", titre: "Why the cart was slow", source: "depot", etapes: [{ label: "Cart", detail: "lists 40 lines", etat: "neutre" }, { label: "API", detail: "include: images", etat: "casse" }, { label: "Database", detail: "1,200 images read", etat: "neutre" }, { label: "Response", detail: "912 KB", etat: "neutre" }] }, output: "Illustration noted (frise).", at: min(5.2), doneAt: min(5.2) },
				{ kind: "tool", tool: "Bash", text: "git commit", toolId: "p16", input: { command: "git commit -am \"fix(cart): readable summary on mobile, cart page 6× faster\"" }, output: "[fix/cart-mobile 4e1c2ab] fix(cart): readable summary on mobile, cart page 6× faster\n 4 files changed, 41 insertions(+), 12 deletions(-)", at: min(4), doneAt: min(4) },
				{ kind: "tool", tool: "Bash", text: "gh pr create", toolId: "p17", input: { command: "gh pr create --fill" }, output: "https://github.com/northwind/storefront/pull/2074", at: min(3.5), doneAt: min(3.2) },
				{
					kind: "assistant",
					text:
						"The cart summary fits on a phone screen, and the cart page responds in 310 ms instead of 1.8 s.\n\n" +
						"![before](.claude/work/rendu/before-cart.png) ![after](.claude/work/rendu/after-cart.png)\n\n" +
						"**UI**: line titles in the summary wrap onto two lines (`line-clamp-2`) instead of being cut off, and badges move below the title under 480 px. The test that required `truncate` was updated: it described the bug.\n\n" +
						"**API**: the cart loaded every line with all of its product images (`include: { images: true }`), 1,200 rows for 40 lines. It now reads only the id, the title and the price. Measured with the repo benchmark, 200 requests.\n\n" +
						"**What I did not do**: the product page still loads images, on purpose. Paginating the cart is left for another ticket.\n\n" +
						"PR: https://github.com/northwind/storefront/pull/2074",
					at: min(3),
				},
			],
		},
		// Un agent qui n'a encore rien reçu : le seul état où le dossier de
		// contexte se décide, et donc le seul où la barre existe. Sans lui, aucun
		// aperçu ne permettait de la regarder.
		{
			...common,
			id: "run-3",
			sessionId: "agent-4",
			claudeSessionId: null,
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
			label: "New agent",
			contextTokens: 0,
			running: true,
			thinking: false,
			activity: null,
			turns: [],
		},
	];
}
