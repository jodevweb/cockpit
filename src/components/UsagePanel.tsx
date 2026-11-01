import clsx from "clsx";
import { Info, RefreshCw, X } from "lucide-react";
import { Button, Spinner } from "@/components/ui";
import { compactNumber } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { UsageBucket, UsageLimit, UsageTotals } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/** Jetons facturés : le cache lu ne compte pas comme du texte produit. */
function billable(totals: UsageTotals) {
	return totals.input + totals.output + totals.cacheWrite;
}

/**
 * Ce que l'abonnement autorise encore, et quand il repart.
 *
 * Un volume de jetons ne se compare à rien : savoir qu'on a consommé douze
 * millions de jetons ne dit pas s'il reste de la marge avant ce soir. Ces
 * chiffres-là viennent du CLI, seul à connaître les plafonds — d'où le
 * rafraîchissement à la demande, chaque lecture lui coûtant un lancement.
 */
function Limits() {
	// Même raison qu'ailleurs : chaque lecture lance le CLI. Le panneau se
	// ferme, on le rouvre — c'est déjà le rythme auquel on veut ce chiffre.
	const limits = useAsync(() => api.sessions.limits(), []);
	const data = limits.data;

	if (data?.error) {
		return (
			<div className="mb-4 rounded-xl border border-line-soft bg-surface/60 p-2.5">
				<p className="text-[10px] text-ink-faint">
					Plafonds indisponibles — {data.error}
				</p>
			</div>
		);
	}

	if (!data || data.limits.length === 0) {
		return (
			<div className="mb-4 flex items-center gap-2 rounded-xl border border-line-soft bg-surface/60 p-2.5">
				{limits.loading ? <Spinner /> : null}
				<p className="text-[10px] text-ink-faint">
					{limits.loading ? "Lecture des plafonds…" : "Plafonds non annoncés."}
				</p>
			</div>
		);
	}

	return (
		<div className="mb-4 flex flex-col gap-2.5 rounded-xl border border-line-soft bg-surface/60 p-3">
			<div className="flex items-center gap-2">
				<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
					Abonnement
				</span>
				<div className="flex-1" />
				{limits.loading ? <Spinner /> : null}
				<Button
					size="sm"
					icon={RefreshCw}
					title="Redemander au CLI"
					onClick={() => void api.sessions.limits(true).then(() => limits.reload())}
				/>
			</div>

			{data.limits.map((limit: UsageLimit) => (
				<div key={limit.label} className="flex flex-col gap-1">
					<div className="flex items-baseline gap-2">
						<span className="text-[11px] text-ink">{limit.label}</span>
						<div className="flex-1" />
						{/* Ce qui reste, pas ce qui est pris : c'est la question qu'on se
						    pose en ouvrant cet écran. */}
						<span
							className={clsx(
								"font-mono text-[11px] font-semibold",
								limit.percent >= 90
									? "text-critical"
									: limit.percent >= 70
										? "text-warning"
										: "text-ink",
							)}
						>
							{100 - limit.percent}% restants
						</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-raised">
						<div
							className={clsx(
								"h-full rounded-full transition-[width] duration-500",
								limit.percent >= 90
									? "bg-critical"
									: limit.percent >= 70
										? "bg-warning"
										: "bg-accent",
							)}
							style={{ width: `${Math.min(limit.percent, 100)}%` }}
						/>
					</div>
					{limit.resetsAt ? (
						<span className="text-[10px] text-ink-faint">
							{limit.percent}% consommés · repart {limit.resetsAt}
						</span>
					) : (
						<span className="text-[10px] text-ink-faint">{limit.percent}% consommés</span>
					)}
				</div>
			))}

			{/* La mise en garde du CLI est recopiée telle quelle : ces chiffres ne
			    voient que cette machine, et les présenter autrement en ferait une
			    vérité de compte qu'ils ne sont pas. */}
			{data.note ? (
				<p className="text-[10px] leading-relaxed text-ink-faint">{data.note}</p>
			) : null}
		</div>
	);
}

function Stat({
	label,
	totals,
	hint,
}: {
	label: string;
	totals: UsageTotals;
	hint?: string;
}) {
	return (
		<div className="panel flex flex-col gap-1 p-3">
			<span className="text-[10px] tracking-[0.06em] text-ink-faint uppercase">
				{label}
			</span>
			<span className="font-mono text-[19px] leading-none font-semibold text-ink tabular-nums">
				{compactNumber(billable(totals))}
			</span>
			<span className="font-mono text-[10px] text-ink-faint">
				{compactNumber(totals.output)} produits · {totals.messages} réponses
			</span>
			{hint ? <span className="text-[10px] text-ink-faint">{hint}</span> : null}
		</div>
	);
}

/** Barres proportionnelles : la comparaison prime sur la valeur absolue. */
function Bars({ buckets, empty }: { buckets: UsageBucket[]; empty: string }) {
	const max = Math.max(1, ...buckets.map((bucket) => billable(bucket.totals)));
	if (buckets.length === 0) {
		return <p className="px-1 py-3 text-[11px] text-ink-faint">{empty}</p>;
	}
	return (
		<div className="flex flex-col gap-1">
			{buckets.slice(0, 12).map((bucket) => {
				const value = billable(bucket.totals);
				return (
					<div key={bucket.key} className="flex items-center gap-2">
						<span className="w-40 shrink-0 truncate font-mono text-[10px] text-ink-muted">
							{bucket.label}
						</span>
						<div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface">
							<div
								className="h-full rounded-full bg-accent-soft/60"
								style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
							/>
						</div>
						<span className="w-14 shrink-0 text-right font-mono text-[10px] text-ink-faint tabular-nums">
							{compactNumber(value)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
				{title}
			</div>
			{children}
		</div>
	);
}

/**
 * Consommation Claude Code : ce qu'il reste, puis ce qui a été consommé.
 *
 * Deux sources, qui ne disent pas la même chose. Les plafonds viennent du CLI,
 * seul à connaître l'état de l'abonnement — c'est ce qu'on lit en premier,
 * parce que c'est la question qu'on se pose. Les volumes, eux, sont
 * reconstitués depuis les journaux : ils disent où part la consommation, pas
 * combien il en reste.
 */
export function UsagePanel({ onClose }: { onClose: () => void }) {
	const usage = useAsync(() => api.sessions.usage(), [], { pollMs: 300_000 });
	const data = usage.data;

	return (
		<div className="animate-in fixed inset-0 z-40 flex items-start justify-center bg-overlay/70 p-10">
			<div className="panel flex max-h-full w-full max-w-3xl flex-col overflow-hidden shadow-2xl shadow-black/50">
				<div className="hairline-b flex items-center gap-2 px-4 py-2.5">
					<span className="text-[12.5px] font-semibold text-ink">Consommation Claude</span>
					<span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
						d'après les journaux de ~/.claude/projects
					</span>
					{usage.loading ? <Spinner /> : null}
					<Button size="sm" icon={RefreshCw} onClick={usage.reload} />
					<Button size="sm" icon={X} onClick={onClose} />
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					{usage.loading && !data ? (
						<div className="flex justify-center py-10">
							<Spinner />
						</div>
					) : null}

					{/* Les plafonds d'abord : c'est la seule chose qui dise s'il reste
					    de la marge, là où un volume de jetons ne se compare à rien. */}
					<Limits />

					{data ? (
						<div className="flex flex-col gap-4">
							<div className="grid grid-cols-4 gap-2">
								<Stat label="5 dernières heures" totals={data.last5h} />
								<Stat label="Aujourd'hui" totals={data.today} />
								<Stat label="7 jours" totals={data.last7Days} />
								<Stat label="30 jours" totals={data.last30Days} />
							</div>

							<div
								className={clsx(
									"flex items-start gap-2 rounded-xl border border-line-soft p-2.5",
									"bg-surface/60",
								)}
							>
								<Info size={12} className="mt-0.5 shrink-0 text-ink-faint" />
								<p className="text-[10px] leading-relaxed text-ink-faint">
									Volumes mesurés en jetons, à distinguer des plafonds ci-dessus : le
									total additionne entrée, sortie et écriture de cache ; le cache relu
									est compté à part car il ne se facture pas comme du texte produit.
								</p>
							</div>

							<Section title="Par jour (30 derniers jours)">
								<Bars buckets={[...data.byDay].reverse()} empty="Aucune activité." />
							</Section>

							<Section title="Par worktree">
								<Bars
									buckets={data.byWorktree}
									empty="Aucun dossier identifié."
								/>
							</Section>

							{/* Ce qu'une mission coûte ne se lit nulle part ailleurs : ses
							    agents travaillent dans plusieurs worktrees, et leurs relevés
							    n'ont de sens qu'additionnés sous son nom. */}
							{data.byMission.length > 0 ? (
								<Section title="Par mission">
									<Bars buckets={data.byMission} empty="Aucune mission mesurée." />
								</Section>
							) : null}

							<Section title="Par modèle">
								<Bars buckets={data.byModel} empty="Aucun modèle identifié." />
							</Section>

							<p className="text-[10px] text-ink-faint">
								Depuis le début : {compactNumber(billable(data.allTime))} jetons sur{" "}
								{data.allTime.messages} réponses · cache relu{" "}
								{compactNumber(data.allTime.cacheRead)}.
							</p>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
