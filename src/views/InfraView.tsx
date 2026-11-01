import clsx from "clsx";
import { Boxes, RefreshCw, Square } from "lucide-react";
import { useMemo } from "react";
import {
	Badge,
	Button,
	Dot,
	Empty,
	ErrorNote,
	Metric,
	Section,
	Spinner,
	ViewHeader,
} from "@/components/ui";
import { shortPath } from "@/lib/format";
import { api } from "@/lib/ipc";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

export function InfraView() {
	const { notify, worktrees } = useCockpit();
	const containers = useAsync(() => api.system.containers(), [], { pollMs: 15_000 });
	const ports = useAsync(() => api.system.ports(), [], { pollMs: 15_000 });

	const running = (containers.data ?? []).filter((item) => item.state === "running");

	const stop = async (pid: number, port: number) => {
		try {
			await api.system.stopProcess(pid);
			notify(`Port ${port} libéré.`);
			ports.reload();
		} catch (error) {
			notify(String(error));
		}
	};

	// Les serveurs de développement se rangent par convention entre 3000 et
	// 4999 ; le reste de ce qu'écoute la machine (AirPlay, bases système) n'a
	// rien à faire dans cette vue.
	const devPorts = useMemo(
		() => (ports.data ?? []).filter((port) => port.port >= 3000 && port.port <= 4999),
		[ports.data],
	);

	return (
		<>
			<ViewHeader
				title="Serveurs & conteneurs"
				subtitle="Ce qui tourne sur le poste : serveurs de développement et conteneurs."
				actions={
					<>
						{containers.loading || ports.loading ? <Spinner /> : null}
						<Button
							size="sm"
							icon={RefreshCw}
							onClick={() => {
								containers.reload();
								ports.reload();
							}}
						/>
					</>
				}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<div className="grid grid-cols-4 gap-2.5">
					<Metric label="Conteneurs actifs" value={running.length} tone="info" />
					<Metric
						label="Conteneurs arrêtés"
						value={(containers.data ?? []).length - running.length}
					/>
					<Metric label="Ports dev" value={devPorts.length} />
					<Metric label="Worktrees" value={worktrees.length} />
				</div>

				<div className="mt-5 grid grid-cols-2 gap-5">
					<Section title="Docker" count={containers.data?.length}>
						{containers.error ? (
							<ErrorNote error={containers.error} onRetry={containers.reload} />
						) : null}
						{(containers.data ?? []).length === 0 && !containers.error ? (
							<Empty icon={Boxes} message="Aucun conteneur" />
						) : null}
						<div className="flex flex-col gap-1">
							{containers.data?.map((container) => (
								<div
									key={container.id}
									className="panel flex items-center gap-2.5 px-3 py-2"
								>
									<Dot
										tone={container.state === "running" ? "success" : "neutral"}
										pulse={container.state === "running"}
									/>
									<div className="min-w-0 flex-1">
										<div className="truncate text-[12.5px] text-ink">{container.name}</div>
										<div className="truncate font-mono text-[10px] text-ink-faint">
											{container.image}
										</div>
									</div>
									<div className="max-w-40 shrink-0 truncate text-right font-mono text-[10px] text-ink-faint">
										{container.ports || container.status}
									</div>
									<Button
										size="sm"
										title="Voir les logs"
										onClick={() => {
											void api.system
												.openTerminal("/", `docker logs -f --tail 200 ${container.name}`)
												.catch((error) => notify(String(error)));
										}}
									>
										Logs
									</Button>
								</div>
							))}
						</div>
					</Section>

					{/* Un serveur de développement se lance dans un worktree et s'y
					    oublie : trois semaines plus tard, le port 3000 est pris par un
					    sujet livré depuis longtemps, et il fallait chercher le pid à la
					    main pour s'en débarrasser. On dit donc d'où chaque serveur
					    vient, et on offre de l'arrêter. */}
					<Section title="Serveurs en écoute" count={devPorts.length}>
						{ports.error ? <ErrorNote error={ports.error} onRetry={ports.reload} /> : null}
						{devPorts.length === 0 && !ports.error ? (
							<Empty message="Aucun serveur de développement actif" />
						) : null}
						<div className="flex flex-col gap-1">
							{devPorts.map((port) => {
								// Le worktree le plus profond qui contient le dossier du
								// processus : sur des chemins imbriqués, le plus long gagne.
								const origin = worktrees
									.filter((tree) => port.cwd && port.cwd.startsWith(tree.path))
									.sort((a, b) => b.path.length - a.path.length)[0];
								return (
									<div
										key={`${port.port}-${port.pid}`}
										className="panel flex items-center gap-2.5 px-3 py-2"
									>
										<Badge tone="accent" mono>
											{port.port}
										</Badge>
										<span className="min-w-0 flex-1">
											<span className="block truncate font-mono text-[11px] text-ink-muted">
												{port.process}
											</span>
											<span className="block truncate font-mono text-[10px] text-ink-faint">
												{origin
													? (origin.branch ?? origin.folderName)
													: port.cwd
														? shortPath(port.cwd, 2)
														: "dossier inconnu"}
											</span>
										</span>
										{/* Ce que ce serveur retient, sa descendance comprise. Sans
										    ce chiffre, huit serveurs oubliés dans des workspaces
										    refermés passaient pour une fuite du cockpit. */}
										<span
											className={clsx(
												"shrink-0 font-mono text-[10px] tabular-nums",
												port.memoryMb > 1024
													? "text-critical"
													: port.memoryMb > 256
														? "text-warning"
														: "text-ink-faint",
											)}
											title="mémoire retenue, sous-processus compris"
										>
											{port.memoryMb >= 1024
												? `${(port.memoryMb / 1024).toFixed(1)} Go`
												: `${Math.round(port.memoryMb)} Mo`}
										</span>
										<span className="shrink-0 font-mono text-[10px] text-ink-faint">
											pid {port.pid}
										</span>
										<Button
											size="sm"
											onClick={() => {
												void api.system
													.openUrl(`http://localhost:${port.port}`)
													.catch(() => undefined);
											}}
										>
											Ouvrir
										</Button>
										<Button
											size="sm"
											icon={Square}
											title="Arrêter ce serveur"
											onClick={() => void stop(port.pid, port.port)}
										/>
									</div>
								);
							})}
						</div>
					</Section>
				</div>
			</div>
		</>
	);
}
