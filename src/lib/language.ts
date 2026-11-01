import { locale, normalizeLanguage } from "@/i18n";

/**
 * La langue en cours, nommée pour un prompt.
 *
 * Les prompts restent en anglais (un prompt anglais et une consigne de langue
 * valent mieux que dix prompts traduits) : c'est cette consigne qui fait
 * répondre l'agent dans la langue de la personne. Même table que
 * `english_name` côté Rust, pour que les deux disent la même chose.
 */
const ENGLISH_NAMES: Record<string, string> = {
	en: "English",
	fr: "French",
	es: "Spanish",
	de: "German",
	"pt-BR": "Brazilian Portuguese",
	"zh-CN": "Simplified Chinese",
	ja: "Japanese",
	ko: "Korean",
	ru: "Russian",
	it: "Italian",
};

/** Le nom anglais de la langue de l'interface (« French », « Japanese »…). */
export function languageName(): string {
	return ENGLISH_NAMES[normalizeLanguage(locale())] ?? "English";
}

/** La consigne de langue à joindre à un prompt dont la réponse est lue par la personne. */
export function replyDirective(): string {
	return (
		`Write every reply, summary and any text meant for the user in ${languageName()}. ` +
		"Keep code, identifiers, file paths and the exact protocol markers requested in these instructions unchanged."
	);
}

/**
 * Une table de libellés dont chaque valeur se traduit à la lecture.
 *
 * Les tables exportées (`Record<état, libellé>`) se lisent partout par simple
 * indexation ; traduites au chargement du module, elles le seraient avant que
 * la langue soit connue. Chaque entrée est donc un accesseur qui appelle `t`.
 */
export function lazyLabels<K extends string>(keys: readonly K[], translate: (key: K) => string): Record<K, string> {
	const table = {} as Record<K, string>;
	for (const key of keys) {
		Object.defineProperty(table, key, { enumerable: true, get: () => translate(key) });
	}
	return table;
}

/**
 * Un tableau relu à chaque accès : `liste[0]`, `liste.map(…)`, `liste.length`
 * marchent comme sur un tableau, mais la traduction se fait à la lecture,
 * jamais au chargement du module.
 */
export function lazyArray<T>(read: () => T[]): T[] {
	return new Proxy([] as T[], {
		get(_target, prop) {
			const list = read();
			return Reflect.get(list, prop, list);
		},
		has(_target, prop) {
			return Reflect.has(read(), prop);
		},
		ownKeys() {
			return Reflect.ownKeys(read());
		},
		getOwnPropertyDescriptor(_target, prop) {
			const descriptor = Reflect.getOwnPropertyDescriptor(read(), prop);
			// Le tableau cible porte `length` non configurable : on doit le rendre tel quel.
			if (descriptor && prop !== "length") descriptor.configurable = true;
			return descriptor;
		},
	});
}

/** `lazyArray` pour une simple liste de libellés. */
export function lazyList(read: () => string[]): readonly string[] {
	return lazyArray(read);
}
