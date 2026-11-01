import clsx from "clsx";
import { AlertTriangle, GitBranch, GitMerge, GitPullRequest } from "lucide-react";
import { useMemo } from "react";
import { Badge, Dot, Freshness, Skeleton } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { ProjectHealth } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useAllSessions, useCockpit } from "@/app/store";

/**
 * Une ligne par projet : ce qui bouge, ce qui bloque.
 *
 * Le reste du cockpit ne montre que le projet actif — pratique pour travailler,
 * aveugle pour surveiller. Cette vue interroge chaque projet avec ses propres
 * réglages, ce qui permet de savoir qu'une CI est rouge ailleurs sans avoir à
 * basculer dessus.
 */
export function ProjectsHealth() {
	const { activeProject, switchProject, go } = useCockpit();
	const sessions = useAllSessions();

	// Cinq minutes : ces chiffres se lisent d'un coup d'œil au passage, ils ne
	// justifient pas de frapper GitHub pour chaque projet en continu.
	const health = useAsync(() => api.config.health(), [], { pollMs: 300_000 });

	// Les agents vivants se comptent côté front : le scan des sessions est déjà
	// chargé, le refaire par projet coûterait un balayage disque de plus.
	const agentsByRepo = useMemo(() => {
		const counts = new Map<string, number>();
		for (const session of sessions) {
			if (session.idleSeconds >= 180) continue;
			counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
		}
		return counts;
	}, [sessions]);

	const projects = health.data ?? [];
	if (projects.length === 0 && health.initial) {
		// La silhouette du bandeau, pas un cercle au milieu du vide : un rond qui
		// tourne ne dit ni ce qu'il attend ni la place que ça prendra, et l'écran
		// sautait quand la barre venait s'insérer au-dessus du reste.
		return (
			<div className="panel flex flex-col divide-y divide-line-soft">
				<div className="flex items-center gap-2 px-3 py-1.5">
					<Skeleton className="h-2.5 w-14" />
				</div>
				{[0, 1].map((index) => (
					<div key={index} className="flex items-center gap-2.5 px-3 py-2">
						<Skeleton className="size-2 shrink-0 rounded-full" />
						<Skeleton className="h-3 w-28" />
						<Skeleton className="ml-auto h-3 w-16" />
					</div>
				))}
			</div>
		);
	}

	return (
		<div className="panel flex flex-col divide-y divide-line-soft">
			<div className="flex items-center gap-2 px-3 py-1.5">
				<span className="flex-1 text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
					Projets
				</span>
				<Freshness
					at={health.updatedAt}
					loading={health.loading}
					onReload={health.reload}
				/>
			</div>

			{projects.map((project) => {
				const live = countAgents(project, agentsByRepo);
				const active = project.id === activeProject?.id;
				return (
					<div key={project.id} className="flex items-center gap-2 px-3 py-2">
						<span
							className="h-2 w-2 shrink-0 rounded-full"
							style={{ background: project.color || "var(--color-accent)" }}
						/>
						<button
							type="button"
							onClick={() => (active ? go("worktrees") : switchProject(project.id))}
							title={active ? "Ouvrir les worktrees" : "Basculer sur ce projet"}
							className="focus-ring min-w-0 flex-1 rounded text-left"
						>
							<span
								className={clsx(
									"block truncate text-[12.5px]",
									active ? "font-semibold text-ink" : "text-ink-muted",
								)}
							>
								{project.name}
								{active ? (
									<span className="ml-1.5 text-[10px] text-accent-soft">actif</span>
								) : null}
							</span>
							<span className="block truncate font-mono text-[10px] text-ink-faint">
								{project.githubRepo || project.mainRepo}
							</span>
						</button>

						{/* Chaque compteur ne s'affiche que s'il vaut quelque chose : une
						    ligne de zéros ne dit rien et fatigue l'œil. */}
						<div className="flex shrink-0 items-center gap-2.5 font-mono text-[10px]">
							{live > 0 ? (
								<span
									className="flex items-center gap-1 text-success"
									title="agents actifs"
								>
									<Dot tone="success" pulse />
									{live}
								</span>
							) : null}
							{project.ciFailing > 0 ? (
								<span className="flex items-center gap-1 text-critical" title="CI en échec">
									<AlertTriangle size={11} />
									{project.ciFailing}
								</span>
							) : null}
							{project.readyToMerge > 0 ? (
								<span
									className="flex items-center gap-1 text-success"
									title="prêtes à merger"
								>
									<GitMerge size={11} />
									{project.readyToMerge}
								</span>
							) : null}
							{project.openPrs > 0 ? (
								<span
									className="flex items-center gap-1 text-ink-faint"
									title="PR ouvertes"
								>
									<GitPullRequest size={11} />
									{project.openPrs}
								</span>
							) : null}
							<span className="flex items-center gap-1 text-ink-faint" title="worktrees">
								<GitBranch size={11} />
								{project.worktrees}
							</span>
							{project.dirty > 0 ? (
								<span
									className="text-warning"
									title="worktrees avec du travail non commité"
								>
									{project.dirty} sales
								</span>
							) : null}
							{project.unpushed > 0 ? (
								<span className="text-info" title="worktrees avec des commits non poussés">
									↑{project.unpushed}
								</span>
							) : null}
							{/* Une source injoignable ne doit pas faire disparaître le
							    projet : on montre ce qu'on a, en disant que c'est partiel. */}
							{project.error ? (
								<span title={project.error}>
									<Badge tone="warning">partiel</Badge>
								</span>
							) : null}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/**
 * Agents vivants d'un projet.
 *
 * Une session appartient au projet dont elle occupe un worktree ; faute de lien
 * explicite, on se rabat sur le préfixe du chemin — les worktrees d'un dépôt
 * vivent à côté de lui.
 */
function countAgents(project: ProjectHealth, byCwd: Map<string, number>): number {
	const parent = project.mainRepo.replace(/\/[^/]+$/, "");
	let total = 0;
	for (const [cwd, count] of byCwd) {
		if (cwd === project.mainRepo || cwd.startsWith(`${parent}/`)) total += count;
	}
	return total;
}
