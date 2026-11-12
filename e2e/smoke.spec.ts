import { expect, test, type Page } from "@playwright/test";

// Ce que l'interface doit tenir quel que soit le changement : chaque écran
// s'ouvre sans lever d'erreur, et les gestes qui protègent une mission restent
// visibles. Les données sont celles du mode aperçu (`src/lib/preview.ts`).

/** Les erreurs de la page : exceptions non rattrapées et `console.error`. */
function watchErrors(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(`exception: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(`console: ${message.text()}`);
	});
	return errors;
}

/** L'atelier ouvert : le tiroir de tous les écrans, reconnu à son titre. */
const atelierNav = (page: Page) => page.locator("nav", { hasText: "Workshop" });

/** Un onglet de la barre du haut, par le début de son libellé. */
const topTab = (page: Page, label: string) =>
	page.locator("header button", { hasText: label }).first();

test("la carte s'ouvre sur le projet d'exemple, sans erreur", async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto("/");
	await expect(page.getByText("Northwind").first()).toBeVisible();
	expect(errors).toEqual([]);
});

test("chaque onglet de la barre du haut s'ouvre sans erreur", async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto("/");
	for (const label of ["Workspaces", "Free agents", "Decisions", "Recap", "Automations", "Missions", "Map"]) {
		await topTab(page, label).click();
		// Laisse aux données d'aperçu, servies avec un léger délai, le temps
		// d'arriver et de se dessiner.
		await page.waitForTimeout(400);
		expect(errors, `en ouvrant ${label}`).toEqual([]);
	}
});

test("chaque écran de l'atelier s'ouvre sans erreur", async ({ page }) => {
	// Une vingtaine d'écrans à ouvrir l'un après l'autre : les 30 s par défaut
	// passaient seul, et cédaient quand les autres tests tournaient en même temps.
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await page.goto("/");
	const atelier = topTab(page, "Workshop");
	await atelier.click();
	// Les écrans seulement, par leur identifiant. Le premier bouton du menu était
	// le sélecteur de projet : il ne referme pas l'atelier, et le clic suivant sur
	// « Workshop » le refermait au lieu de l'ouvrir. L'écran d'après ne passait
	// que si le clic tombait pendant l'animation de fermeture — en local, oui ;
	// sur une CI chargée, le menu avait disparu et le test attendait deux minutes.
	const screens = await atelierNav(page)
		.locator("[data-screen]")
		.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-screen") ?? ""));
	expect(screens.length).toBeGreaterThan(5);
	for (const screen of screens) {
		if (!(await atelierNav(page).isVisible())) await atelier.click();
		await atelierNav(page).locator(`[data-screen="${screen}"]`).click();
		await expect(atelierNav(page)).toBeHidden();
		await page.waitForTimeout(400);
		expect(errors, `en ouvrant ${screen}`).toEqual([]);
	}
});

test("le poste d'exemple est prêt : pas de carte « prêt à démarrer »", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("Northwind").first()).toBeVisible();
	await expect(page.getByText("Ready to start?")).toHaveCount(0);
});

test.describe("missions", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
		await topTab(page, "Missions").click();
	});

	test("une porte en échec se voit sur sa tâche, avec sa sortie", async ({ page }) => {
		const badge = page.getByText("checks fail", { exact: true });
		await expect(badge).toBeVisible();
		await expect(badge).toHaveAttribute("title", /pnpm test/);
	});

	test("l'historique garde chaque passage et ce qu'il disait", async ({ page }) => {
		const errors = watchErrors(page);
		const card = page
			.getByRole("heading", { name: "Fix cart total rounding on multi-currency orders" })
			.locator("xpath=ancestor::div[contains(@class,'items-start')][1]");
		await card.getByRole("button", { name: "History" }).click();
		const dialog = page.getByRole("dialog", { name: /^History · Fix cart total/ });
		await expect(dialog).toBeVisible();
		// Rien de choisi : on suit le dernier événement.
		await expect(dialog.getByText("Event 17 of 17")).toBeVisible();

		const events = dialog.getByRole("list", { name: "Events" });
		await events.getByRole("button", { name: /Checks fail · Per-line rounding/ }).click();
		await expect(dialog.getByText("expected 10.01 to be 10")).toBeVisible();
		await expect(dialog.getByText("4d81b7e2c09a")).toBeVisible();
		// Ce que la tâche avait changé à cet instant, fichier par fichier.
		await dialog.getByRole("button", { name: "See the diff at that moment" }).click();
		await dialog.getByRole("button", { name: /apps\/api\/cart\/total\.ts/ }).click();
		await expect(dialog.getByText("Each line is rounded on its own", { exact: false })).toBeVisible();

		// Une reprise : son motif, et l'état des branches à cet instant-là.
		await events.getByRole("button", { name: /Functional QA sent back/ }).click();
		await expect(dialog.getByText("Attempt 1 of 3")).toBeVisible();
		await expect(dialog.getByText("Re-run QA once the per-line rounding is delivered.")).toBeVisible();
		await expect(dialog.getByText("4d81b7e2c09a")).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	test("le graphe montre la boucle de correction et mène à son historique", async ({ page }) => {
		const errors = watchErrors(page);
		await page
			.getByRole("heading", { name: "Fix cart total rounding on multi-currency orders" })
			.locator("xpath=ancestor::div[contains(@class,'items-start')][1]")
			.getByRole("button", { name: "Journey" })
			.click();
		const graph = page.locator(".mission-graph");
		// Deux boucles : la recette renvoyée une fois, et la porte rouge de l'API.
		// Le compteur vit dans le nœud, où rien ne peut passer dessus.
		await expect(graph.locator(".react-flow__edge-loop")).toHaveCount(2);
		await expect(graph.getByText("1/3", { exact: true })).toBeVisible();

		await graph.getByText("Functional QA").click();
		await page.getByRole("button", { name: "See its loop in the history" }).click();
		const dialog = page.getByRole("dialog", { name: /^History · Fix cart total/ });
		// Ouvert sur la reprise de cette tâche, pas sur le dernier événement.
		await expect(dialog.getByText("Attempt 1 of 3")).toBeVisible();
		expect(errors).toEqual([]);
	});

	test("l'approbation d'un plan nomme les exécutants sans filet", async ({ page }) => {
		await expect(page.getByText("No container for backend, frontend, qa.")).toBeVisible();
		await expect(page.getByText(/Agents → Agent isolation/)).toBeVisible();
	});
});

test("les portes se règlent dans Équipe & flux", async ({ page }) => {
	await page.goto("/");
	await topTab(page, "Workshop").click();
	await atelierNav(page).locator("button", { hasText: "Settings" }).click();
	await page.getByRole("button", { name: "Team & workflow", exact: true }).click();
	const field = page.getByRole("textbox", { name: "Checks before integration" });
	await expect(field).toBeVisible();
	await expect(field).toHaveAttribute("placeholder", "pnpm test, pnpm lint");
});

test("les réglages disent quels rôles viennent du dépôt", async ({ page }) => {
	await page.goto("/?tab=agents");
	await topTab(page, "Workshop").click();
	await atelierNav(page).locator("button", { hasText: "Settings" }).click();
	await expect(page.getByText(/also declares roles in \.cockpit\/roles\.toml: backend/)).toBeVisible();
	// `backend` tourne sans rien demander et le dépôt change sa consigne : il
	// redemande l'accord jusqu'à ce qu'on valide le fichier.
	const untrusted = page.getByTestId("repo-roles-untrusted");
	// Un seul rôle : le verbe est au singulier.
	await expect(untrusted).toContainText("backend asks for approval");
	await untrusted.getByRole("button", { name: "Validate this file" }).click();
	await expect(page.getByTestId("repo-roles-trusted")).toBeVisible();
});

test("la croix retire un élément du bandeau « ça t'attend »", async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto("/");
	const bar = page.getByText("Waiting on you", { exact: true }).locator("xpath=..");
	const item = bar.getByRole("button", { name: /^Show delivery estimates at checkout/ });
	await expect(item).toBeVisible();
	await item.locator("xpath=following-sibling::button[1]").click();
	await expect(item).toHaveCount(0);
	// Écarter ne fait taire que le bandeau : la mission reste là où elle vit.
	await page.locator("header button", { hasText: "Missions" }).first().click();
	await expect(page.getByText("Show delivery estimates at checkout").first()).toBeVisible();
	expect(errors).toEqual([]);
});

test("les méthodes montrent ce qu'un plugin exécute avant de l'installer", async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto("/");
	await topTab(page, "Workshop").click();
	await atelierNav(page).locator("button", { hasText: "Methods" }).click();
	// Un plugin qui exécute du code : le hook et sa commande sont en tête.
	await page.locator("button", { hasText: "security-guard" }).first().click();
	await expect(page.getByText("Runs code on this machine")).toBeVisible();
	await expect(page.getByText("check_command.py").first()).toBeVisible();
	// Un plugin de skills seuls : rien ne s'exécute, et il le dit.
	await page.locator("button", { hasText: "test-first" }).first().click();
	await expect(page.getByText("Runs nothing")).toBeVisible();
	// L'installer : une confirmation, puis le rappel de commiter les réglages.
	await page.getByRole("button", { name: "Install", exact: true }).click();
	// La confirmation s'ouvre par-dessus : son bouton est le dernier « Install ».
	await page.getByRole("button", { name: "Install", exact: true }).last().click();
	await expect(page.getByText(/commit \.claude\/settings\.json/).first()).toBeVisible();
	// Un plugin installé : l'avant/après de ses agents.
	await page.locator("button", { hasText: "review-kit" }).first().click();
	await expect(page.getByText("Before", { exact: true })).toBeVisible();
	await expect(page.getByText("27 runs · 2 failed")).toBeVisible();
	expect(errors).toEqual([]);
});

test("le rejeu montre ses cas, son rapport, et compte les essais avant de lancer", async ({ page }) => {
	const errors = watchErrors(page);
	await page.goto("/");
	await topTab(page, "Workshop").click();
	await atelierNav(page).locator("button", { hasText: "Replay" }).click();
	await expect(page.getByText("Cart total ignores line quantities").first()).toBeVisible();
	// Le rapport : la configuration « test d'abord » a résolu ses deux cas.
	await expect(page.getByText("2/2").first()).toBeVisible();
	// Deux cas choisis, une configuration : deux essais, annoncés avant le lancement.
	await page.locator("button", { hasText: "Cart total ignores line quantities" }).first().click();
	await page.locator("button", { hasText: "Rounding drift on multi-currency orders" }).first().click();
	await expect(page.getByText(/^2 trial\(s\)/).first()).toBeVisible();
	expect(errors).toEqual([]);
});
