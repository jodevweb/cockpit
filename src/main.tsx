import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { cachedLanguage, initI18n } from "./i18n";
import { api } from "./lib/ipc";
import { applyTheme, readThemeChoice } from "./lib/theme";
import { installWindowZoom } from "./lib/windowZoom";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

// Avant le rendu : l'écouteur vit sur le document, pas sur un composant.
installWindowZoom();

// Avant le rendu aussi, et pour la même raison : posé par un effet, le thème
// clair n'apparaîtrait qu'après un premier écran sombre.
applyTheme(readThemeChoice());

// La langue avant le premier rendu : un écran peint en anglais puis repeint
// dans la bonne langue se verrait. Le Rust a le dernier mot (le réglage peut
// suivre le système) ; à défaut, la dernière langue connue, puis le navigateur.
void (async () => {
	// `?lang=de` force une langue — utile en aperçu pour relire une traduction.
	const forced = new URLSearchParams(window.location.search).get("lang");
	const language =
		forced ??
		(await api.language
			.get()
			.then((view) => view.resolved)
			.catch(() => cachedLanguage() ?? navigator.language));
	await initI18n(language);
	createRoot(container).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
})();
