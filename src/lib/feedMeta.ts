import { t } from "@/i18n";

/**
 * Les libellés de métadonnées des flux (`meta("branche", …)` côté Rust) sont
 * des identifiants : des écrans les comparent tels quels. On ne les traduit
 * qu'à l'affichage. Un libellé inconnu s'affiche tel qu'il arrive.
 */
const KEYS: Record<string, string> = {
	type: "type",
	niveau: "level",
	projet: "project",
	auteur: "author",
	assigné: "assignee",
	déploiement: "deployment",
	essai: "attempt",
	version: "version",
	run: "run",
	tâche: "task",
	environnement: "environment",
	commit: "commit",
	événement: "event",
	branche: "branch",
	labels: "labels",
	"à reviewer par": "reviewers",
	priorité: "priority",
	origine: "origin",
	url: "url",
	occurrences: "occurrences",
	utilisateurs: "users",
};

export function metaLabel(label: string): string {
	const key = KEYS[label];
	return key ? t(`lib:feedMeta.${key}`) : label;
}
