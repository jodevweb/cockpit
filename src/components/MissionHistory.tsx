import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Dot, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { Execution, Outcome } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * Ce qui s'est réellement passé pendant une mission.
 *
 * Une mission montre l'état courant de ses tâches — livrée, en cours, refusée —
 * jamais la suite des tentatives qui y a mené. « 1 reprise » ne dit ni ce qui a
 * échoué, ni ce que la reprise a coûté, ni pourquoi le premier essai est mort.
 * Ces faits existent depuis que le cockpit tient son propre relevé ; il ne
 * manquait qu'un endroit pour les lire.
 *
 * Replié par défaut : c'est ce qu'on va chercher quand on se demande « mais que
 * s'est-il passé », pas ce qu'on lit à chaque coup d'œil.
 */
export function MissionHistory({ missionId }: { missionId: string }) {
	const [open, setOpen] = useState(false);
	const runs = useAsync(
		() => (open ? api.executions.forMission(missionId) : Promise.resolve([])),
		[missionId, open],
		{ enabled: open },
	);

	return (
		<div className="flex flex-col">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="focus-ring flex items-center gap-1.5 self-start rounded-md py-1 text-[11px] text-ink-faint hover:text-ink-muted"
			>
				{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
				Ce qui s'est passé
				{open && runs.data?.length ? (
					<span className="font-mono text-[10px]">{runs.data.length} agents</span>
				) : null}
			</button>

			{open ? (
				runs.loading ? (
					<div className="flex items-center gap-2 px-2 py-1 text-[11px] text-ink-faint">
						<Spinner /> relecture…
					</div>
				) : !runs.data?.length ? (
					<p className="px-2 py-1 text-[11px] leading-relaxed text-ink-faint">
						Aucun agent relevé pour cette mission. Le cockpit ne tient ce carnet que
						depuis la version 0.54 : ce qui a tourné avant n'y figure pas.
					</p>
				) : (
					<div className="flex flex-col gap-0.5 pl-1">
						{runs.data.map((run) => (
							<HistoryLine key={run.id} run={run} />
						))}
					</div>
				)
			) : null}
		</div>
	);
}

/** Ce qu'une issue veut dire, en clair. Le nom de la variante ne sort jamais. */
const ISSUES: Record<Outcome, { label: string; tone: "success" | "warning" | "neutral" }> = {
	running: { label: "en cours", tone: "success" },
	answered: { label: "a rendu", tone: "success" },
	failed: { label: "en erreur", tone: "warning" },
	lostAtLaunch: { label: "perdu au lancement", tone: "warning" },
	stopped: { label: "arrêté", tone: "neutral" },
	orphaned: { label: "cockpit fermé", tone: "neutral" },
};

/** Qui a demandé ce lancement. Le distinguer est tout l'intérêt de l'avoir noté. */
const ACTEURS: Record<string, string> = {
	me: "toi",
	master: "le maître",
	cockpit: "le cockpit",
	permanence: "la Permanence",
};

export function HistoryLine({ run }: { run: Execution }) {
	const issue = ISSUES[run.outcome] ?? { label: run.outcome, tone: "neutral" as const };
	const heure = run.startedAt.slice(11, 16);
	const qui = ACTEURS[run.origin.actor] ?? run.origin.actor;
	const role = run.origin.role || "agent";

	return (
		<div className="flex flex-col rounded-md px-1.5 py-1 hover:bg-hover">
			<div className="flex items-baseline gap-2">
				<span className="shrink-0 font-mono text-[10px] text-ink-faint">{heure}</span>
				<span className="shrink-0 text-[11px] font-medium text-ink">{role}</span>
				{run.origin.attempt > 0 ? (
					<span className="shrink-0 text-[10px] text-warning">
						reprise {run.origin.attempt}
					</span>
				) : null}
				<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
					{run.model || run.engineLabel} · lancé par {qui}
				</span>
				<Spend run={run} />
				<span className="flex shrink-0 items-center gap-1 text-[10px] text-ink-muted">
					<Dot tone={issue.tone} pulse={run.outcome === "running"} />
					{issue.label}
				</span>
			</div>

			{/* Le motif, quand il y en a un. C'est ce qui transforme « ça a raté »
			    en « voilà quoi corriger » — et il n'existait nulle part avant que
			    les agents cessent de mourir sans un mot. */}
			{run.note ? (
				<span className="truncate pl-12 font-mono text-[10px] text-warning" title={run.note}>
					└ {run.note}
				</span>
			) : null}
		</div>
	);
}

/**
 * Ce qu'un agent a consommé.
 *
 * Le montant n'est jamais une facture : sur un abonnement rien n'est débité,
 * c'est le quota de la fenêtre qui se consomme. Et un moteur qui n'annonce
 * aucun coût — Codex, Gemini — ne se lit pas comme un moteur gratuit : ses
 * tours muets se disent.
 */
export function Spend({ run }: { run: Execution }) {
	const { reportedUsd, unknownTurns } = run.tally.cost;
	if (reportedUsd > 0) {
		return (
			<span
				className="shrink-0 font-mono text-[10px] text-ink-muted"
				title={`Valorisation annoncée par le moteur — pas une dépense.\n${run.tally.inputTokens} jetons en entrée, ${run.tally.outputTokens} en sortie`}
			>
				{reportedUsd.toFixed(2)} $
			</span>
		);
	}
	if (unknownTurns > 0) {
		return (
			<span
				className="shrink-0 font-mono text-[10px] text-ink-faint"
				title={`${run.engineLabel} n'annonce pas ce que coûtent ses tours. Ce n'est pas un coût nul : c'est un chiffre qu'on n'a pas.`}
			>
				coût non dit
			</span>
		);
	}
	return null;
}

/**
 * Ce qu'un ensemble d'exécutions a coûté, sans mélanger les natures.
 *
 * Rendu comme un texte court : c'est une valeur qu'on lit à côté d'une durée,
 * pas un tableau de bord.
 */
export function totalSpend(runs: Execution[]): { label: string; title: string } | null {
	if (!runs.length) return null;
	const annonce = runs.reduce((sum, run) => sum + run.tally.cost.reportedUsd, 0);
	const muets = runs.reduce((sum, run) => sum + run.tally.cost.unknownTurns, 0);
	const perdu = runs
		.filter((run) => run.outcome === "lostAtLaunch" || run.outcome === "failed")
		.reduce((sum, run) => sum + run.tally.cost.reportedUsd, 0);

	if (annonce === 0 && muets === 0) return null;
	const label = annonce > 0 ? `${annonce.toFixed(2)} $` : "coût non dit";
	const details = [
		`${runs.length} agent${runs.length > 1 ? "s" : ""}`,
		annonce > 0 ? "valorisation annoncée par les moteurs, jamais une dépense" : null,
		perdu > 0 ? `dont ${perdu.toFixed(2)} $ sur des agents qui n'ont rien rendu` : null,
		muets > 0 ? `${muets} tour${muets > 1 ? "s" : ""} dont le coût n'est pas annoncé` : null,
	].filter(Boolean);
	return { label, title: details.join("\n") };
}
