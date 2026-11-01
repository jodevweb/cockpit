import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hasTauri } from "@/lib/preview";

/**
 * Thème de l'interface : sombre, clair, ou celui du système.
 *
 * La préférence vit dans `localStorage` plutôt que dans `config.toml`. Deux
 * raisons. C'est un choix de poste, pas de projet — le partager entre les deux
 * n'aurait aucun sens, et il n'a pas à voyager avec une configuration qu'on
 * recopie d'une machine à l'autre. Et surtout, elle doit être lisible avant le
 * premier rendu : passer par l'IPC ferait apparaître l'app en sombre le temps
 * d'un aller-retour, puis basculer sous les yeux.
 */
export type ThemeChoice = "dark" | "light" | "system";

/** Ce qui est réellement posé sur le document, une fois « système » résolu. */
export type ResolvedTheme = "dark" | "light";

const KEY = "cockpit.theme";

export function readThemeChoice(): ThemeChoice {
	try {
		const raw = localStorage.getItem(KEY);
		// Atelier est clair par défaut : c'est le visage de l'outil. Un choix
		// déjà enregistré, lui, est respecté.
		return raw === "light" || raw === "dark" || raw === "system" ? raw : "light";
	} catch {
		// Mode privé, quota : le thème n'est pas critique, on retombe sur le clair.
		return "light";
	}
}

/** Ce que le système demande, quand on lui laisse le choix. */
export function systemTheme(): ResolvedTheme {
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
	return choice === "system" ? systemTheme() : choice;
}

/**
 * Pose le thème sur le document, et l'annonce à la fenêtre.
 *
 * `data-theme` suffit à l'interface : les jetons de `tokens.css` s'y attachent,
 * et tout le reste en découle. Mais la fenêtre elle-même n'est pas peinte par
 * nous — barre de titre en surimpression, ascenseurs, champs natifs : sans le
 * dire à macOS, une interface claire garde une barre de titre sombre et des
 * ascenseurs blancs sur blanc.
 */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
	const resolved = resolveTheme(choice);
	const root = document.documentElement;
	root.dataset.theme = resolved;
	// La classe `dark` de l'index sert au thème Tailwind : elle doit suivre,
	// sinon les rares utilitaires `dark:` restent bloqués sur le sombre.
	root.classList.toggle("dark", resolved === "dark");
	root.style.colorScheme = resolved;

	// Hors de la fenêtre native — un navigateur, pendant `vite dev` — il n'y a
	// personne à prévenir. Et `getCurrentWindow()` ne se contente pas d'échouer :
	// il lève à la lecture de ses métadonnées, avant même qu'on puisse rattraper
	// une promesse. Appelé au démarrage comme ici, cela laissait la page
	// définitivement noire.
	if (hasTauri()) {
		const window = getCurrentWindow();
		void window.setTheme(resolved).catch(() => undefined);
		// Le fond de la fenêtre suit : c'est lui qu'on voit avant que la page
		// ne dessine. Mêmes valeurs que `--void` dans `tokens.css`.
		void window
			.setBackgroundColor(resolved === "light" ? [236, 239, 242, 255] : [15, 19, 21, 255])
			.catch(() => undefined);
	}

	return resolved;
}

export function saveThemeChoice(choice: ThemeChoice): ResolvedTheme {
	try {
		localStorage.setItem(KEY, choice);
	} catch {
		// Sans persistance, le thème tient au moins pour cette session.
	}
	return applyTheme(choice);
}

/**
 * Suit les changements du système, tant que « système » est le choix retenu.
 *
 * Rend la fonction de désabonnement : un écouteur laissé derrière continuerait
 * de repeindre l'app après qu'on a choisi un thème fixe.
 */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
	const query = window.matchMedia("(prefers-color-scheme: light)");
	const handler = () => onChange(systemTheme());
	query.addEventListener("change", handler);
	return () => query.removeEventListener("change", handler);
}

/**
 * Le thème effectivement posé, suivi en direct.
 *
 * Pour les composants tiers qui prennent un thème en paramètre (les
 * notifications) : ils doivent basculer avec l'interface, pas au prochain
 * lancement. On observe l'attribut plutôt que de dupliquer l'état du choix.
 */
export function useResolvedTheme(): ResolvedTheme {
	const read = (): ResolvedTheme =>
		document.documentElement.dataset.theme === "dark" ? "dark" : "light";
	const [theme, setTheme] = useState<ResolvedTheme>(read);
	useEffect(() => {
		const observer = new MutationObserver(() => setTheme(read()));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	return theme;
}
