import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { applyTheme, readThemeChoice } from "./lib/theme";
import { installWindowZoom } from "./lib/windowZoom";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Racine introuvable");

// Avant le rendu : l'écouteur vit sur le document, pas sur un composant.
installWindowZoom();

// Avant le rendu aussi, et pour la même raison : posé par un effet, le thème
// clair n'apparaîtrait qu'après un premier écran sombre.
applyTheme(readThemeChoice());

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
