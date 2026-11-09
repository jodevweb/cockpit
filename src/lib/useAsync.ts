import { useCallback, useEffect, useRef, useState } from "react";
import { useProjectEpoch } from "./projectScope";

export interface AsyncState<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
	/** Vrai uniquement au tout premier chargement — évite les flashs de skeleton. */
	initial: boolean;
	/**
	 * Horodatage du dernier succès.
	 *
	 * Dans un outil de supervision, une donnée n'a de sens qu'avec son âge :
	 * « zéro incident » ne dit pas la même chose selon qu'on l'a lu il y a dix
	 * secondes ou il y a un quart d'heure.
	 */
	updatedAt: number | null;
	reload: () => void;
}

/** Vrai quand la fenêtre est visible à l'écran. */
function useVisible() {
	const [visible, setVisible] = useState(() => !document.hidden);
	useEffect(() => {
		const update = () => setVisible(!document.hidden);
		document.addEventListener("visibilitychange", update);
		window.addEventListener("focus", update);
		return () => {
			document.removeEventListener("visibilitychange", update);
			window.removeEventListener("focus", update);
		};
	}, []);
	return visible;
}

/**
 * Chargement asynchrone avec rechargement manuel, polling optionnel et
 * rafraîchissement piloté par événements.
 *
 * Les données précédentes restent affichées pendant un rechargement : dans un
 * outil de supervision, un écran qui se vide à chaque refresh est illisible.
 *
 * Le polling s'arrête quand la fenêtre est masquée, et repart avec un
 * rechargement immédiat au retour : un cockpit resté ouvert derrière une autre
 * app n'a aucune raison de continuer à taper les API SaaS, mais il doit être à
 * jour à la seconde où on le regarde.
 */
export function useAsync<T>(
	loader: () => Promise<T>,
	deps: unknown[] = [],
	options: {
		pollMs?: number;
		enabled?: boolean;
		/** Abonnement à un événement backend ; le retour désabonne. */
		subscribe?: (onChange: () => void) => Promise<() => void> | (() => void);
		/**
		 * Vide les données quand les dépendances changent.
		 *
		 * Conserver l'ancien résultat est bon pour un rafraîchissement — l'écran
		 * ne clignote pas — mais trompeur quand on change de source : on lit les
		 * données du service précédent en croyant voir les nouvelles.
		 */
		resetOnChange?: boolean;
	} = {},
): AsyncState<T> {
	const { pollMs, enabled = true, subscribe, resetOnChange = false } = options;
	const visible = useVisible();
	// Changer de projet change la source de presque tout : on relit, et on vide
	// au passage. Garder l'ancien résultat serait ici le pire des deux mondes —
	// lire les données d'un dépôt en croyant voir celles d'un autre.
	const projectEpoch = useProjectEpoch();
	const knownEpoch = useRef(projectEpoch);
	const projectChanged = knownEpoch.current !== projectEpoch;
	knownEpoch.current = projectEpoch;
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(enabled);
	const [initial, setInitial] = useState(true);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const generation = useRef(0);
	const loaderRef = useRef(loader);
	loaderRef.current = loader;

	const run = useCallback(async () => {
		if (!enabled) return;
		const current = ++generation.current;
		setLoading(true);
		try {
			const result = await loaderRef.current();
			if (current !== generation.current) return;
			setData(result);
			setError(null);
			setUpdatedAt(Date.now());
		} catch (cause) {
			if (current !== generation.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (current === generation.current) {
				setLoading(false);
				setInitial(false);
			}
		}
	}, [enabled]);

	useEffect(() => {
		if (resetOnChange || projectChanged) {
			setData(null);
			setError(null);
			setInitial(true);
		}
		void run();
		// `deps` vient de l'appelant : la règle ne peut pas le vérifier d'ici.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, enabled, projectEpoch]);

	useEffect(() => {
		if (!pollMs || !enabled || !visible) return;
		const timer = setInterval(() => void run(), pollMs);
		return () => clearInterval(timer);
	}, [pollMs, enabled, visible, run]);

	// Retour sur la fenêtre : on ne fait pas attendre le prochain tick.
	const wasVisible = useRef(visible);
	useEffect(() => {
		if (visible && !wasVisible.current && enabled) void run();
		wasVisible.current = visible;
	}, [visible, enabled, run]);

	useEffect(() => {
		if (!subscribe || !enabled) return;
		let dispose: (() => void) | undefined;
		let cancelled = false;
		void Promise.resolve(subscribe(() => void run())).then((off) => {
			// Le désabonnement peut arriver après le démontage : on l'applique
			// immédiatement plutôt que de laisser un écouteur orphelin.
			if (cancelled) off();
			else dispose = off;
		});
		return () => {
			cancelled = true;
			dispose?.();
		};
	}, [subscribe, enabled, run]);

	return { data, error, loading, initial, updatedAt, reload: run };
}

/** Persiste une valeur simple dans localStorage (préférences d'affichage). */
/**
 * Les instances qui partagent une clé, pour qu'elles restent d'accord.
 *
 * Chaque appel du hook a son propre `useState` : le réglage qui écrit et
 * l'écran qui lit ne partageaient que le stockage, jamais l'état. Régler « le
 * rappel des workspaces » sur *masquer* enregistrait bien la préférence, mais
 * le rappel lui-même gardait la valeur lue à son montage — il ne disparaissait
 * qu'au redémarrage de l'application.
 */
const partages = new Map<string, Set<(value: unknown) => void>>();

function abonnes(key: string): Set<(value: unknown) => void> {
	let set = partages.get(key);
	if (!set) {
		set = new Set();
		partages.set(key, set);
	}
	return set;
}

export function usePersistentState<T>(key: string, fallback: T) {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(`cockpit.${key}`);
			return raw === null ? fallback : (JSON.parse(raw) as T);
		} catch {
			return fallback;
		}
	});

	useEffect(() => {
		const notifier = setValue as unknown as (value: unknown) => void;
		abonnes(key).add(notifier);
		return () => {
			abonnes(key).delete(notifier);
		};
	}, [key]);

	useEffect(() => {
		try {
			localStorage.setItem(`cockpit.${key}`, JSON.stringify(value));
		} catch {
			// Quota plein ou mode privé : la préférence n'est pas critique.
		}
		// Les autres instances de la même clé suivent. Elles reçoivent la même
		// valeur, donc leur propre effet réécrit à l'identique et React s'arrête
		// là : pas de va-et-vient.
		for (const abonne of abonnes(key)) {
			if (abonne !== (setValue as unknown)) abonne(value);
		}
	}, [key, value]);

	return [value, setValue] as const;
}
