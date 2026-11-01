import clsx from "clsx";
import type { Severity } from "@/lib/types";
import { Badge, Dot } from "@/components/ui";
import { fromTimestamp } from "@/lib/format";
import type { Engagement, PermanenceVerdict } from "@/lib/types";

/**
 * Ce que la Permanence a engagé, et ce qu'il en est advenu.
 *
 * **L'oracle est affiché avant le verdict**, jamais après : on doit pouvoir
 * juger si la preuve visée est la bonne, indépendamment du fait qu'elle soit
 * atteinte. C'est la transposition de ce que fait `impact.rs` en séparant le
 * dossier de faits de la lecture qu'un agent en donne.
 *
 * **Un succès n'a droit à aucun accent de couleur.** Le succès est silencieux,
 * l'échec parle — sinon on reconstruit une boîte de réception d'IA.
 */
export function EngagementCard({
	engagement,
	onOpen,
}: {
	engagement: Engagement;
	onOpen?: () => void;
}) {
	const running = engagement.stage === "planning" || engagement.stage === "running";
	const tone = verdictTone(engagement.verdict);
	// Seuls l'échec et l'indécidable teintent la carte. « Hors sujet » et
	// « à blanc » sont des issues normales, pas des problèmes.
	const alarming =
		engagement.verdict === "missed" || engagement.verdict === "undecided";

	return (
		<button
			type="button"
			onClick={onOpen}
			disabled={!onOpen}
			className={clsx(
				"panel flex h-full w-full flex-col gap-2 p-3 text-left transition-colors",
				onOpen && "hover:bg-raised",
				alarming && "border-critical/25 bg-critical/[0.04]",
			)}
		>
			<div className="flex items-start gap-2">
				<Dot tone={running ? "info" : tone} pulse={running} />
				<div className="min-w-0 flex-1">
					{/* L'objectif d'abord : c'est ce que l'agent s'est engagé à
					    obtenir, pas ce que le signal disait. */}
					<p className="truncate text-[12px] font-medium text-ink">
						{engagement.goal || engagement.label}
					</p>
					<p className="truncate text-[10.5px] text-ink-faint">
						{engagement.trigger || "sans déclencheur"} · {engagement.label}
					</p>
				</div>
				{/* Une répétition rend le verdict « à blanc » : afficher les deux
				    dirait deux fois la même chose. La mention ne reste que tant que
				    la répétition court. */}
				{engagement.rehearsal && running ? <Badge tone="accent">à blanc</Badge> : null}
				{!running ? <Badge tone={tone}>{verdictLabel(engagement.verdict)}</Badge> : null}
			</div>

			{/* La chronologie en pastilles, bornée : au-delà, on compte. Le détail
			    complet est au clic. */}
			{engagement.steps.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1.5">
					{engagement.steps.slice(0, 5).map((step, index) => (
						<span
							key={index}
							title={step.result || step.what}
							className={clsx(
								"inline-flex h-[20px] max-w-[200px] shrink-0 items-center gap-1 rounded-full px-2 text-[10.5px]",
								step.ok ? "bg-raised text-ink-muted" : "bg-critical/12 text-critical",
							)}
						>
							<span className="shrink-0">{step.result ? "✓" : "○"}</span>
							<span className="min-w-0 truncate">{step.what}</span>
						</span>
					))}
					{engagement.steps.length > 5 ? (
						<span className="font-mono text-[10px] text-ink-faint">
							+{engagement.steps.length - 5}
						</span>
					) : null}
				</div>
			) : null}

			{/* La preuve visée, avant tout jugement sur le fait qu'elle soit
			    atteinte. Sans oracle, l'engagement n'aurait pas dû partir. */}
			<div className="flex items-center gap-2 rounded-lg bg-raised px-2 py-1.5">
				<span className="shrink-0 text-[9.5px] tracking-[0.07em] text-ink-faint uppercase">
					Oracle
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-muted">
					{engagement.oracle?.kind
						? `${engagement.oracle.kind} · ${engagement.oracle.key}`
						: "aucun — n'aurait pas dû partir"}
				</span>
			</div>

			{engagement.why ? (
				<p className="line-clamp-3 break-words text-[11px] leading-relaxed text-ink-muted">
					{engagement.why}
				</p>
			) : null}

			<div className="mt-auto flex items-center gap-2 pt-0.5">
				<span className="font-mono text-[10px] text-ink-faint">
					{engagement.steps.length} étape(s)
					{engagement.costUsd > 0 ? (
						<span
							title="ce que cela vaudrait aux tarifs de l'API ; sur un abonnement rien n'est débité, c'est le quota de la fenêtre qui se consomme"
						>
							{" · ≈ "}
							{engagement.costUsd.toFixed(2).replace(".", ",")} $
						</span>
					) : null}
				</span>
				<span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
					{running
						? `démarré ${fromTimestamp(engagement.startedAt)}`
						: fromTimestamp(engagement.endedAt || engagement.startedAt)}
				</span>
			</div>
		</button>
	);
}

const LABELS: Record<PermanenceVerdict, string> = {
	pending: "en cours",
	reached: "atteint",
	missed: "manqué",
	offTopic: "hors sujet",
	undecided: "indécidable",
	rehearsed: "à blanc",
};

export function verdictLabel(verdict: PermanenceVerdict): string {
	return LABELS[verdict] ?? verdict;
}

/**
 * `undecided` est en `warning` et non en `success` : c'est tout l'enjeu du
 * quatrième verdict. Une panne d'oracle n'est pas une réussite, et elle ne doit
 * pas se lire comme telle d'un coup d'œil.
 */
export function verdictTone(verdict: PermanenceVerdict): Severity | "neutral" {
	switch (verdict) {
		case "reached":
			return "success";
		case "missed":
			return "critical";
		case "undecided":
			return "warning";
		case "rehearsed":
			return "info";
		default:
			return "neutral";
	}
}
