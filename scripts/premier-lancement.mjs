// Le premier lancement, vu de l'interface : ce que voit quelqu'un qui installe
// Cockpit sur un poste où rien n'est réglé.
//
//   node scripts/premier-lancement.mjs <dossier de sortie>
//
// Se branche sur l'app installée par le port de débogage de WebView2 (Windows :
// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`), fait
// le tour des écrans de la barre du haut, et rend pour chacun une capture. Les
// erreurs de la console et les exceptions de la page sont relevées tout du long :
// un écran qui s'affiche en cachant une erreur passe sinon pour sain.
//
// Échoue si l'interface ne se charge pas, si une exception remonte de la page,
// ou si un écran ne s'ouvre pas. Lancé par `.github/workflows/premier-lancement.yml`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `playwright-core` seul en CI, sans les dépendances du projet ; dans le dépôt,
// celui qu'apporte `@playwright/test`.
const { chromium } = await import("playwright-core").catch(() => import("@playwright/test"));

const sortie = process.argv[2] ?? "premier-lancement";
mkdirSync(sortie, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// L'app met quelques secondes à ouvrir son port : on réessaie plutôt que de
// conclure trop tôt qu'elle n'est pas là.
let browser = null;
for (let essai = 0; essai < 30 && !browser; essai += 1) {
	browser = await chromium.connectOverCDP("http://localhost:9333").catch(() => null);
	if (!browser) await pause(2000);
}
if (!browser) {
	console.error("::error::Le port de débogage de l'app ne répond pas au bout d'une minute.");
	process.exit(1);
}

let page = null;
for (let essai = 0; essai < 30 && !page; essai += 1) {
	page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().includes("tauri.localhost")) ?? null;
	if (!page) await pause(1000);
}
if (!page) {
	console.error("::error::La page de l'app ne s'est pas ouverte.");
	process.exit(1);
}

const erreurs = [];
page.on("console", (message) => {
	if (message.type() === "error") erreurs.push(`console : ${message.text()}`);
});
page.on("pageerror", (error) => erreurs.push(`exception : ${error.message}`));

const capture = async (nom) => {
	await page.screenshot({ path: join(sortie, `${nom}.png`) });
	console.log(`capture ${nom}.png`);
};

await page.waitForLoadState("domcontentloaded");
await pause(6000);
await capture("01-ouverture");

// Les écrans de la barre du haut, dans l'ordre où on les découvre : les boutons
// qui précèdent le champ « aller à, lancer… ». Ce qui suit — lancer un agent,
// les jauges, l'atelier — ouvre des fenêtres, pas des écrans.
const onglets = await page.locator("header button").evaluateAll((boutons) => {
	const textes = [];
	for (const bouton of boutons) {
		const texte = (bouton.innerText || "").trim();
		if (texte.includes("Ctrl+K") || texte.includes("…")) break;
		const nom = texte.split("\n")[0].trim();
		if (nom.length > 1) textes.push(nom);
	}
	return textes;
});
const vus = [...new Set(onglets)].slice(0, 8);
console.log("écrans :", vus.join(", ") || "(aucun)");
if (vus.length === 0) erreurs.push("aucun écran dans la barre du haut");

let rang = 2;
for (const onglet of vus) {
	try {
		// Une fenêtre restée ouverte (un accueil, une invite) couvrirait la barre.
		await page.keyboard.press("Escape");
		await page.locator("header button", { hasText: onglet }).first().click({ timeout: 5000 });
		await pause(2500);
		await capture(`${String(rang).padStart(2, "0")}-${onglet.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
	} catch (error) {
		erreurs.push(`écran « ${onglet} » : ${String(error).split("\n")[0]}`);
	}
	rang += 1;
}

writeFileSync(join(sortie, "texte.txt"), await page.locator("body").innerText().catch(() => ""));
writeFileSync(join(sortie, "erreurs.txt"), erreurs.join("\n"));
await browser.close().catch(() => {});

if (erreurs.length > 0) {
	console.log(erreurs.map((ligne) => `::warning::${ligne}`).join("\n"));
}
// Une exception de la page fait échouer ; une erreur de console seule
// s'affiche, sans faire échouer : sans réseau ni CLI, certaines sont attendues
// et c'est leur liste qu'on veut lire.
process.exit(erreurs.some((ligne) => !ligne.startsWith("console")) ? 1 : 0);
