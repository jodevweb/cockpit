import { defineConfig, devices } from "@playwright/test";

// Les tests d'interface jouent l'app dans un navigateur, en mode aperçu : sans
// Tauri, `lib/ipc.ts` répond avec les données d'exemple de `lib/preview.ts`.
// Ils exercent donc l'interface entière — navigation, écrans, traductions —
// sans poste configuré, sans agent et sans réseau.
//
// Ils passent par le serveur de développement de Vite : l'aperçu n'existe
// qu'en développement (`isPreview` lit `import.meta.env.DEV`), et c'est voulu
// — le `dist/` que l'app embarque ne contient pas les données d'exemple.
export default defineConfig({
	testDir: "e2e",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: "http://localhost:41730",
		locale: "en-US",
		viewport: { width: 1568, height: 900 },
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1568, height: 900 } } }],
	// Un port que rien d'autre n'occupe d'ordinaire, et jamais un serveur déjà
	// là : le 4173 par défaut de Vite servait parfois l'app d'un autre projet,
	// et tous les tests échouaient contre elle. Un port pris fait désormais
	// échouer le lancement, avec un message qui le dit.
	webServer: {
		command: "pnpm exec vite --port 41730 --strictPort",
		url: "http://localhost:41730",
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
