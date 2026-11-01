import clsx from "clsx";
import { Activity, Eye, RefreshCw, TriangleAlert, X } from "lucide-react";
import { Badge, Button, Empty, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { HandbackSide } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useTranslation } from "react-i18next";

/**
 * L'état de la boucle : ce qui a été livré, repris, attrapé.
 *
 * Les alertes viennent en premier, et les chiffres après. C'est délibéré : rien
 * ici n'est un objectif, et un écran qui ouvrirait sur des compteurs inviterait
 * à les faire baisser — c'est-à-dire à relire moins et à confronter moins.
 *
 * Ce que ce panneau sert à voir tient en une question : est-ce que les
 * garde-fous attrapent encore quelque chose ? Un dispositif qui ne signale plus
 * rien n'est pas forcément un dispositif qui marche.
 */
export function ReliabilityPanel({
	project,
	onClose,
}: {
	project: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("components1");
	const metrics = useAsync(() => api.metrics.collect(project), [project]);
	const data = metrics.data;

	return (
		<div className="animate-in fixed inset-0 z-40 flex items-start justify-center bg-overlay/70 p-10">
			<div className="panel flex max-h-full w-full max-w-3xl flex-col overflow-hidden shadow-2xl shadow-black/50">
				<div className="hairline-b flex items-center gap-2 px-4 py-2.5">
					<Activity size={13} className="shrink-0 text-accent-soft" />
					<span className="text-[12.5px] font-semibold text-ink">{t("reliabilityPanel.title")}</span>
					<span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
						{data ? t("reliabilityPanel.window", { count: data.windowDays }) : "…"} —{" "}
						{t("reliabilityPanel.notGoals")}
					</span>
					{metrics.loading ? <Spinner /> : null}
					<Button size="sm" icon={RefreshCw} onClick={metrics.reload} />
					<Button size="sm" icon={X} onClick={onClose} />
				</div>

				<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
					{!data ? (
						<div className="flex justify-center py-10">
							<Spinner />
						</div>
					) : (
						<>
							{/* Ce qui mérite un regard, avant tout compteur. */}
							{data.warnings.length > 0 ? (
								<section className="flex flex-col gap-1.5">
									{data.warnings.map((warning, index) => (
										<p
											key={index}
											className="flex items-start gap-2 rounded-[var(--radius-panel)] border border-warning/30 bg-warning/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-muted"
										>
											<TriangleAlert size={12} className="mt-0.5 shrink-0 text-warning" />
											<span>{warning}</span>
										</p>
									))}
								</section>
							) : (
								<p className="flex items-start gap-2 rounded-[var(--radius-panel)] border border-line-soft bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-muted">
									<Eye size={12} className="mt-0.5 shrink-0 text-ink-faint" />
									<span>
										{t("reliabilityPanel.nothing")}
									</span>
								</p>
							)}

							<Block
								title={t("reliabilityPanel.handbacks.title")}
								hint={t("reliabilityPanel.handbacks.hint")}
							>
								<Tile value={data.handbacks.delivered} label={t("reliabilityPanel.handbacks.delivered")} />
								<Tile value={data.handbacks.takenBack} label={t("reliabilityPanel.handbacks.takenBack")} />
								<Tile
									value={t("reliabilityPanel.percent", { value: data.handbacks.rate })}
									label={t("reliabilityPanel.handbacks.rate")}
									tone={data.handbacks.rate >= 50 ? "warning" : "neutral"}
								/>
								<Tile
									value={data.handbacks.pending}
									label={t("reliabilityPanel.handbacks.pending")}
									tone={data.handbacks.pending > 0 ? "accent" : "neutral"}
								/>
							</Block>

							{/* La seule question que le cockpit se pose sur lui-même : ce
							    qu'il joint aux agents change-t-il quelque chose ? */}
							<section>
								<h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
									{t("reliabilityPanel.context.title")}
								</h3>
								{data.handbacks.comparable ? (
									<>
										<div className="mt-2 grid grid-cols-2 gap-2">
											<Side
												label={t("reliabilityPanel.context.with")}
												side={data.handbacks.briefed}
												better={data.handbacks.briefed.rate < data.handbacks.plain.rate}
											/>
											<Side
												label={t("reliabilityPanel.context.without")}
												side={data.handbacks.plain}
												better={data.handbacks.plain.rate < data.handbacks.briefed.rate}
											/>
										</div>
										{/* Sans cette phrase, deux pourcentages côte à côte se
										    lisent comme une preuve. Ils n'en sont pas une. */}
										<p className="mt-1.5 text-[10.5px] leading-snug text-ink-faint">
											{t("reliabilityPanel.context.caveat")}
										</p>
									</>
								) : (
									<p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
										{t("reliabilityPanel.context.notComparable", {
											briefed: data.handbacks.briefed.delivered,
											plain: data.handbacks.plain.delivered,
										})}
									</p>
								)}
							</section>

							<Block
								title={t("reliabilityPanel.turns.title")}
								hint={t("reliabilityPanel.turns.hint")}
							>
								<Tile value={data.turns.sessions} label={t("reliabilityPanel.turns.sessions")} />
								<Tile value={data.turns.median} label={t("reliabilityPanel.turns.median")} />
								<Tile
									value={data.turns.longHaul}
									label={t("reliabilityPanel.turns.longHaul")}
									tone={data.turns.longHaul > 0 ? "warning" : "neutral"}
								/>
								<Tile value={data.turns.withError} label={t("reliabilityPanel.turns.withError")} />
							</Block>

							<Block
								title={t("reliabilityPanel.guardrails.title")}
								hint={t("reliabilityPanel.guardrails.hint")}
							>
								<Tile value={data.guardrails.properties} label={t("reliabilityPanel.guardrails.properties")} />
								<Tile value={data.guardrails.calibrated} label={t("reliabilityPanel.guardrails.calibrated")} />
								<Tile
									value={data.guardrails.decorative}
									label={t("reliabilityPanel.guardrails.decorative")}
									tone={data.guardrails.decorative > 0 ? "warning" : "neutral"}
								/>
							</Block>

							<Block
								title={t("reliabilityPanel.memory.title")}
								hint={t("reliabilityPanel.memory.hint")}
							>
								<Tile value={data.memory.lessons} label={t("reliabilityPanel.memory.lessons")} />
								<Tile value={data.memory.uses} label={t("reliabilityPanel.memory.uses")} />
								<Tile
									value={data.memory.idle}
									label={t("reliabilityPanel.memory.idle")}
									tone={data.memory.idle > 0 ? "warning" : "neutral"}
								/>
								<Tile value={data.memory.stale} label={t("reliabilityPanel.memory.stale")} />
							</Block>

							{/* Le titre se corrige tout seul dès qu'un autre que toi a agi :
							    « en ton nom » deviendrait faux, et personne ne le verrait. */}
							<section>
								<h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
									{data.deeds.some((deed) => deed.actor !== "me")
										? t("reliabilityPanel.deeds.titleMixed")
										: t("reliabilityPanel.deeds.titleMine")}
								</h3>
								{data.deeds.length === 0 ? (
									<Empty message={t("reliabilityPanel.deeds.empty")} />
								) : (
									<ul className="mt-2 flex flex-col gap-1">
										{data.deeds.map((deed) => (
											<li
												key={`${deed.kind}-${deed.actor}`}
												className="flex items-center gap-2 rounded-lg border border-line-soft bg-surface px-2.5 py-1.5"
											>
												<span className="font-mono text-[11px] text-ink">{deed.kind}</span>
												{deed.actor !== "me" ? <Badge>{t("reliabilityPanel.deeds.permanence")}</Badge> : null}
												<span className="ml-auto font-mono text-[11px] text-ink-muted tabular-nums">
													{deed.count}
												</span>
												{deed.failed > 0 ? (
													<span className="font-mono text-[10px] text-critical tabular-nums">
														{t("reliabilityPanel.deeds.failed", { count: deed.failed })}
													</span>
												) : null}
											</li>
										))}
									</ul>
								)}
							</section>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * Une colonne de la comparaison.
 *
 * Le vert ne dit pas « bien » : il dit « moins repris que l'autre ». C'est une
 * comparaison relative entre deux populations, pas une note.
 */
function Side({
	label,
	side,
	better,
}: {
	label: string;
	side: HandbackSide;
	better: boolean;
}) {
	const { t } = useTranslation("components1");
	return (
		<div
			className={clsx(
				"rounded-[var(--radius-panel)] border bg-surface px-2.5 py-2",
				better ? "border-success/40" : "border-line-soft",
			)}
		>
			<p className="text-[10px] tracking-wide text-ink-faint uppercase">{label}</p>
			<p
				className={clsx(
					"mt-1 font-mono text-[18px] leading-none tabular-nums",
					better ? "text-success" : "text-ink",
				)}
			>
				{t("reliabilityPanel.percent", { value: side.rate })}
			</p>
			<p className="mt-1 text-[10px] leading-snug text-ink-faint">
				{t("reliabilityPanel.context.side", { takenBack: side.takenBack, count: side.delivered })}
			</p>
		</div>
	);
}

function Block({
	title,
	hint,
	children,
}: {
	title: string;
	hint: string;
	children: React.ReactNode;
}) {
	return (
		<section>
			<h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
				{title}
			</h3>
			<p className="mt-0.5 text-[10.5px] leading-snug text-ink-faint">{hint}</p>
			<div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">{children}</div>
		</section>
	);
}

function Tile({
	value,
	label,
	tone = "neutral",
}: {
	value: number | string;
	label: string;
	tone?: "neutral" | "warning" | "accent";
}) {
	return (
		<div
			className={clsx(
				"rounded-[var(--radius-panel)] border bg-surface px-2.5 py-2",
				tone === "warning"
					? "border-warning/40"
					: tone === "accent"
						? "border-accent/40"
						: "border-line-soft",
			)}
		>
			<p
				className={clsx(
					"font-mono text-[18px] leading-none tabular-nums",
					tone === "warning"
						? "text-warning"
						: tone === "accent"
							? "text-accent-soft"
							: "text-ink",
				)}
			>
				{value}
			</p>
			<p className="mt-1 text-[10px] leading-snug text-ink-faint">{label}</p>
		</div>
	);
}
