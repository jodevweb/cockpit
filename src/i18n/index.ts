import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Les langues de Cockpit.
 *
 * Les catalogues vivent dans `src/locales/<langue>/<espace>.json` ; l'anglais
 * est la référence, et toute clé absente d'une langue retombe sur lui. Une
 * langue n'est chargée que lorsqu'elle sert : dix catalogues complets dans le
 * paquet de démarrage pèseraient pour rien.
 *
 * Usage : `const { t } = useTranslation("views")` puis `t("today.title")` dans
 * un composant ; `t("lib:format.ago", { … })` hors de React. Les valeurs
 * s'insèrent avec `{{nom}}`, les pluriels avec les suffixes `_one` / `_other`
 * (et `_few`, `_many` pour les langues qui en ont).
 */

export const LANGUAGES = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
	{ code: "es", label: "Español" },
	{ code: "de", label: "Deutsch" },
	{ code: "pt-BR", label: "Português (Brasil)" },
	{ code: "zh-CN", label: "简体中文" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "ru", label: "Русский" },
	{ code: "it", label: "Italiano" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

const CACHE_KEY = "cockpit.language";

const loaders = import.meta.glob<{ default: Record<string, unknown> }>("../locales/*/*.json");

/** Un code quelconque (`fr-FR`, `pt-PT`, `zh-Hans`…), ramené à une langue livrée. */
export function normalizeLanguage(code: string | null | undefined): LanguageCode {
	const value = (code ?? "").trim().replace("_", "-").toLowerCase();
	if (value.startsWith("pt")) return "pt-BR";
	if (value.startsWith("zh")) return "zh-CN";
	const primary = value.split(/[-.]/)[0];
	return LANGUAGES.find((language) => language.code.toLowerCase() === primary)?.code ?? "en";
}

async function loadLanguage(language: string) {
	const prefix = `../locales/${language}/`;
	await Promise.all(
		Object.entries(loaders)
			.filter(([path]) => path.startsWith(prefix))
			.map(async ([path, load]) => {
				const namespace = path.slice(prefix.length).replace(/\.json$/, "");
				const module = await load();
				i18n.addResourceBundle(language, namespace, module.default, true, true);
			}),
	);
}

/** À appeler une fois, avant le premier rendu. */
export async function initI18n(language: string) {
	const lng = normalizeLanguage(language);
	await i18n.use(initReactI18next).init({
		lng,
		fallbackLng: "en",
		defaultNS: "common",
		ns: ["common"],
		resources: {},
		interpolation: { escapeValue: false },
		returnNull: false,
		react: { useSuspense: false },
	});
	await loadLanguage("en");
	if (lng !== "en") await loadLanguage(lng);
	document.documentElement.lang = lng;
	try {
		localStorage.setItem(CACHE_KEY, lng);
	} catch {
		// Mode privé : la langue sera relue au prochain démarrage, rien de plus.
	}
}

/** La dernière langue utilisée sur ce poste, pour peindre le premier écran. */
export function cachedLanguage(): string | null {
	try {
		return localStorage.getItem(CACHE_KEY);
	} catch {
		return null;
	}
}

/** La langue en cours, au format BCP 47 : c'est ce qu'attendent les `Intl.*`. */
export function locale(): string {
	return i18n.language || "en";
}

/** Traduire hors d'un composant. Ne jamais l'appeler au chargement d'un module : la langue n'y est pas encore connue. */
export function t(key: string, options?: Record<string, unknown>): string {
	return String(i18n.t(key, options as never));
}

export { i18n };
