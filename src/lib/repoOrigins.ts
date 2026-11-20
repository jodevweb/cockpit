import { useEffect, useMemo, useState } from "react";
import { api } from "./ipc";
import { folderKey } from "./missions";

/**
 * À quel dépôt appartient chaque dossier ouvert.
 *
 * Un workspace n'est qu'un dossier avec des agents dedans : c'est cette table
 * qui dit de quel projet il relève. Elle vivait dans un `useAsync`, que le
 * changement de projet vide par principe — et pendant qu'on la relisait, aucun
 * dossier n'avait d'origine, donc tous passaient pour ceux du projet affiché :
 * ouvrir Atelier Notice montrait, mélangés, les workspaces d'Agence HQ.
 *
 * Or un dossier ne change pas de dépôt. La table est donc gardée pour toute la
 * session, hors de React, et ne fait que s'enrichir.
 */
const known = new Map<string, string>();
const listeners = new Set<() => void>();
const asked = new Set<string>();

function resolve(paths: string[]) {
	const missing = paths.filter((path) => !known.has(path) && !asked.has(path));
	if (missing.length === 0) return;
	for (const path of missing) asked.add(path);
	void api.worktrees
		.reposOf(missing)
		.then((table) => {
			for (const path of missing) known.set(path, table[path] ?? "");
		})
		.catch(() => undefined)
		.finally(() => {
			// Un échec n'est pas une réponse : le dossier pourra être redemandé.
			for (const path of missing) asked.delete(path);
			for (const listener of listeners) listener();
		});
}

/**
 * Le dépôt de chacun de ces dossiers, `""` tant qu'on ne le sait pas (ou pour
 * un dossier hors dépôt). Se met à jour quand une réponse arrive.
 */
export function useRepoOrigins(paths: string[]): Record<string, string> {
	const key = [...new Set(paths)].sort().join("|");
	const [version, setVersion] = useState(0);

	useEffect(() => {
		const listener = () => setVersion((value) => value + 1);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);

	useEffect(() => {
		if (key) resolve(key.split("|"));
	}, [key]);

	return useMemo(() => {
		const table: Record<string, string> = {};
		if (key) for (const path of key.split("|")) table[path] = known.get(path) ?? "";
		return table;
		// `version` dit qu'une réponse est arrivée : la table, hors de React, a changé.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, version]);
}

/**
 * Ce dossier relève-t-il du projet dont `mainRepo` est le dépôt ?
 *
 * La comparaison se fait à l'écriture près : `repos_of` rend `D:/jorda/x`,
 * alors que `config.toml` garde le chemin tel qu'il a été saisi — souvent
 * `D:\jorda\x` sous Windows. Comparés tels quels, aucun dossier n'était jamais
 * du projet affiché.
 *
 * Un dossier dont on ne connaît pas encore le dépôt, ou qui n'est dans aucun,
 * reste visible : mieux vaut le montrer que le faire disparaître sans que rien
 * ne l'explique.
 */
export function belongsToProject(origin: string | undefined, mainRepo: string | null | undefined): boolean {
	const repo = (mainRepo ?? "").trim();
	if (!repo || !origin) return true;
	return folderKey(origin) === folderKey(repo);
}
