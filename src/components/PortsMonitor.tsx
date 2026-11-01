import { Activity, ExternalLink, RefreshCw, Square, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Button, Empty, ErrorNote, Modal, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { ListeningPort } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { useTranslation } from "react-i18next";

/**
 * Un port appartient-il à ce workspace ?
 *
 * Le `cwd` du processus est le seul lien fiable entre un serveur et le chantier
 * qui l'a lancé. On accepte le dossier lui-même et tout ce qui est dessous : un
 * serveur démarré depuis `apps/web` appartient au worktree qui le contient.
 */
function belongsTo(port: ListeningPort, cwd: string): boolean {
	if (!port.cwd || !cwd) return false;
	const racine = cwd.replace(/\/+$/, "");
	return port.cwd === racine || port.cwd.startsWith(`${racine}/`);
}

/**
 * Les serveurs de ce workspace, et rien d'autre.
 *
 * L'écran Infra les montre tous ensemble, conteneurs Docker compris — utile
 * pour faire le ménage, illisible quand on cherche « sur quel port tourne *ce*
 * chantier ». La question se pose depuis le workspace, la réponse doit y être :
 * ce qui écoute ici, ouvrable d'un clic, arrêtable du même endroit.
 */
export function PortsMonitor({ cwd, label }: { cwd: string; label: string }) {
	const { t } = useTranslation("components1");
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button
				size="sm"
				icon={Activity}
				active={open}
				onClick={() => setOpen(true)}
				title={t("portsMonitor.buttonHint")}
			>
				{t("portsMonitor.button")}
			</Button>
			{open ? (
				<PortsDialog cwd={cwd} label={label} onClose={() => setOpen(false)} />
			) : null}
		</>
	);
}

function PortsDialog({
	cwd,
	label,
	onClose,
}: {
	cwd: string;
	label: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("components1");
	const { notify } = useCockpit();
	const { confirm } = useConfirm();
	const [stopping, setStopping] = useState<number | null>(null);
	// Un serveur qu'on vient de lancer doit apparaître sans qu'on rouvre la
	// fenêtre ; dix secondes suffisent et ne coûtent qu'un `lsof`.
	const ports = useAsync(() => api.system.ports(), [], { pollMs: 10_000 });

	const mine = useMemo(
		() => (ports.data ?? []).filter((port) => belongsTo(port, cwd)).sort((a, b) => a.port - b.port),
		[ports.data, cwd],
	);

	const stop = useCallback(
		async (port: ListeningPort) => {
			const ok = await confirm({
				title: t("portsMonitor.stopConfirm.title", { process: port.process, port: port.port }),
				message: t("portsMonitor.stopConfirm.message"),
				confirmLabel: t("portsMonitor.stopConfirm.confirm"),
				danger: true,
			});
			if (!ok) return;
			setStopping(port.pid);
			try {
				await api.system.stopProcess(port.pid);
				notify(t("portsMonitor.stopped", { process: port.process, port: port.port }));
				ports.reload();
			} catch (error) {
				notify(String(error));
			} finally {
				setStopping(null);
			}
		},
		[confirm, notify, ports, t],
	);

	return (
		<Modal onClose={onClose}>
			<div className="panel flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden shadow-xl shadow-black/40">
				<header className="hairline-b flex shrink-0 items-center gap-2 px-4 py-2.5">
					<Activity size={13} className="shrink-0 text-accent-soft" />
					<div className="min-w-0 flex-1">
						<h2 className="truncate text-[13px] font-semibold text-ink">
							{t("portsMonitor.title", { label })}
						</h2>
						<p className="truncate font-mono text-[10px] text-ink-faint">{cwd}</p>
					</div>
					<Button
						size="sm"
						icon={RefreshCw}
						loading={ports.loading}
						onClick={() => ports.reload()}
						title={t("portsMonitor.reload")}
					/>
					<Button size="sm" icon={X} onClick={onClose} />
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto p-3">
					{ports.error ? (
						<ErrorNote error={ports.error} onRetry={() => ports.reload()} />
					) : ports.loading && !ports.data ? (
						<div className="flex justify-center py-8">
							<Spinner />
						</div>
					) : mine.length === 0 ? (
						<Empty
							icon={Activity}
							message={t("portsMonitor.empty.message")}
							hint={t("portsMonitor.empty.hint")}
						/>
					) : (
						<div className="flex flex-col gap-1.5">
							{mine.map((port) => (
								<div
									key={`${port.pid}-${port.port}`}
									className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-surface px-3 py-2"
								>
									<span className="shrink-0 font-mono text-[13px] tabular-nums text-accent-soft">
										{port.port}
									</span>
									<div className="min-w-0 flex-1">
										<p className="truncate text-[12px] text-ink">{port.process}</p>
										<p className="truncate font-mono text-[10px] text-ink-faint">
											pid {port.pid}
											{port.cwd === cwd ? "" : ` · ${port.cwd.slice(cwd.length + 1)}`}
										</p>
									</div>
									{/* La mémoire compte l'arbre entier : c'est elle qui explique
									    qu'un poste rame avec huit serveurs oubliés. */}
									{port.memoryMb > 0 ? (
										<span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">
											{t("portsMonitor.memory", { mb: Math.round(port.memoryMb) })}
										</span>
									) : null}
									<Button
										size="sm"
										icon={ExternalLink}
										title={t("portsMonitor.open", { url: `http://localhost:${port.port}` })}
										onClick={() => {
											void api.system
												.openUrl(`http://localhost:${port.port}`)
												.catch((error) => notify(String(error)));
										}}
									/>
									<Button
										size="sm"
										variant="danger"
										icon={Square}
										loading={stopping === port.pid}
										title={t("portsMonitor.stop")}
										onClick={() => void stop(port)}
									/>
								</div>
							))}
						</div>
					)}
				</div>

				<footer className="shrink-0 border-t border-line-soft px-4 py-2 text-[10px] leading-snug text-ink-faint">
					{t("portsMonitor.footer")}
				</footer>
			</div>
		</Modal>
	);
}
