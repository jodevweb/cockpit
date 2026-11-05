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
	const entries = atelierNav(page).locator("button");
	const count = await entries.count();
	expect(count).toBeGreaterThan(5);
	const labels = (await entries.allInnerTexts()).map((text) => text.split("\n")[0].trim());
	for (let index = 0; index < count; index += 1) {
		if (index > 0) await atelier.click();
		await atelierNav(page).locator("button").nth(index).click();
		await page.waitForTimeout(400);
		expect(errors, `en ouvrant ${labels[index]}`).toEqual([]);
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
	expect(errors).toEqual([]);
});
