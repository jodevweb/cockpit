import { AlertTriangle, Check, Plug, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { McpApproval } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * Ce que les agents de ce dépôt auront vraiment comme outils.
 *
 * Un dépôt déclare ses serveurs MCP dans son `.mcp.json`, et Claude Code
 * n'active ces serveurs qu'après une approbation qu'il demande **par
 * répertoire**, de façon interactive. Un agent lancé sans terminal ne pouvait
 * pas y répondre : ses outils restaient absents, sans que rien ne le dise, et
 * un worktree neuf n'était jamais approuvé.
 *
 * Le cockpit joint désormais ce fichier au lancement — une fois approuvé ici :
 * ces serveurs sont des commandes que le dépôt fait lancer sur le poste, et un
 * dépôt cloné peut y écrire n'importe quoi. L'approbation vaut pour un contenu
 * précis ; le fichier change, elle est redemandée. Ce
 * bloc existe pour la question d'après, qui n'avait aucune réponse nulle part :
 * **est-ce que mes outils vont marcher ?** Un serveur peut être déclaré et
 * rester injoignable — une adresse locale n'existe pas dans un conteneur, une
 * autorisation OAuth vit dans le trousseau du poste. Autant le savoir avant de
 * lancer que le déduire d'un agent qui invente.
 */
export function McpSettings() {
	const servers = useAsync(() => api.mcp.servers(), [], { pollMs: 0 });
	const lue = useAsync(() => api.mcp.approval(), [], { pollMs: 0 });
	// La réponse d'un geste fait foi jusqu'à la relecture suivante.
	const [decidee, setDecidee] = useState<McpApproval | null>(null);
	const approval = { loading: lue.loading, data: decidee ?? lue.data };
	const [busy, setBusy] = useState(false);

	const decide = async (approve: boolean) => {
		setBusy(true);
		try {
			setDecidee(await (approve ? api.mcp.approve() : api.mcp.revoke()));
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy(false);
		}
	};

	if (servers.loading) {
		return (
			<div className="flex items-center gap-2 text-[11px] text-ink-faint">
				<Spinner /> lecture du dépôt…
			</div>
		);
	}

	if (!servers.data?.length) {
		return (
			<p className="text-[11px] leading-relaxed text-ink-faint">
				Ce dépôt ne déclare aucun serveur MCP. Les agents n'auront que les outils
				de leur compte. Un dépôt qui veut partager les siens les écrit dans un{" "}
				<span className="font-mono">.mcp.json</span> à sa racine, commité avec le
				reste — c'est ce fichier que le cockpit joint à chaque agent qu'il lance.
			</p>
		);
	}

	const bloques = servers.data.filter((server) => !server.reachable);

	return (
		<div className="flex flex-col gap-2">
			{approval.data?.approved ? (
				<div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 px-2.5 py-2">
					<ShieldCheck size={13} className="mt-px shrink-0 text-success" />
					<p className="flex-1 text-[11px] leading-relaxed text-ink-muted">
						Approuvés : déclarés par <span className="font-mono">.mcp.json</span> et
						joints à chaque agent lancé sur ce dépôt, worktrees compris — tant que le
						fichier ne change pas.
					</p>
					<Button size="sm" loading={busy} onClick={() => void decide(false)}>
						Retirer
					</Button>
				</div>
			) : (
				<div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-2.5 py-2">
					<ShieldAlert size={13} className="mt-px shrink-0 text-warning" />
					<p className="flex-1 text-[11px] leading-relaxed text-ink-muted">
						{approval.data?.changed
							? "Le .mcp.json a changé depuis ton approbation. "
							: "Pas encore approuvés. "}
						Les agents partent sans ces serveurs : ce sont des commandes que le
						dépôt fait lancer sur ton poste. Relis-les avant d'approuver.
					</p>
					<Button
						size="sm"
						variant="warning"
						icon={ShieldCheck}
						loading={busy}
						disabled={approval.loading}
						onClick={() => void decide(true)}
					>
						Approuver
					</Button>
				</div>
			)}

			<div className="flex flex-col gap-1">
				{servers.data.map((server) => (
					<div
						key={server.name}
						className="flex items-start gap-2 rounded-lg bg-surface/40 px-2 py-1.5"
					>
						{server.reachable ? (
							<Check size={11} className="mt-0.5 shrink-0 text-success" />
						) : (
							<AlertTriangle size={11} className="mt-0.5 shrink-0 text-warning" />
						)}
						<div className="flex min-w-0 flex-1 flex-col">
							<div className="flex items-baseline gap-1.5">
								<span className="font-mono text-[11px] text-ink">{server.name}</span>
								<span className="text-[10px] text-ink-faint">{server.kind}</span>
							</div>
							<span className="truncate font-mono text-[10px] text-ink-faint">
								{server.target}
							</span>
							{server.blocker ? (
								<span className="mt-0.5 text-[10px] leading-relaxed text-warning">
									{server.blocker}
								</span>
							) : null}
						</div>
					</div>
				))}
			</div>

			{bloques.length > 0 ? (
				<p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-ink-faint">
					<Plug size={11} className="mt-px shrink-0" />
					<span>
						{bloques.length} serveur{bloques.length > 1 ? "s" : ""} ne répondra
						{bloques.length > 1 ? "ont" : ""} pas dans les conditions actuelles.
						L'agent le saura et le dira, plutôt que de faire comme si l'outil
						existait — mais si tu comptes dessus, éteins l'isolation pour ce
						travail, ou donne au serveur un jeton qu'il porte lui-même.
					</span>
				</p>
			) : null}
		</div>
	);
}
