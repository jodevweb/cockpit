import clsx from "clsx";
import { Bot, Cpu, Gauge, Terminal, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Spinner } from "@/components/ui";
import { locale, t as translate } from "@/i18n";
import { api } from "@/lib/ipc";
import type { NamedUsage, ResourceReport } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { basename } from "@/lib/paths";
import { compactNumber } from "@/lib/format";
import { platformContext } from "@/lib/platform";

/**
 * Ce que le cockpit fait peser sur la machine, et à cause de quoi.
 *
 * Un agent ne coûte presque rien par lui-même — une dizaine de mégaoctets. Ce
 * qu'il lance, si : ses serveurs MCP, et parmi eux Playwright, qui démarre un
 * Chrome complet. Quatre agents ouverts, et la mémoire se compte en gigaoctets
 * sans que le cockpit y soit pour grand-chose. D'où la colonne « à cause de » :
 * elle nomme le plus gros processus de chaque sous-arbre, celui qui explique le
 * total.
 */

function memory(mb: number): string {
	return mb >= 1024
		? translate("components2:resources.gigabytes", {
				value: (mb / 1024).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
			})
		: translate("components2:resources.megabytes", { value: Math.round(mb) });
}

function shortCwd(cwd: string): string {
	return basename(cwd);
}

/** Barre de proportion : la part de ce workspace dans le total mesuré. */
function Share({ value, total }: { value: number; total: number }) {
	const ratio = total > 0 ? Math.min(1, value / total) : 0;
	return (
		<div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-raised">
			<div className="h-full bg-accent/70" style={{ width: `${ratio * 100}%` }} />
		</div>
	);
}

function Row({
	entry,
	total,
	icon: Icon,
}: {
	entry: NamedUsage;
	total: number;
	icon: typeof Bot;
}) {
	const { t } = useTranslation("components2");
	return (
		<div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
			<Icon size={11} className="shrink-0 text-ink-faint" />
			<span
				className="min-w-0 flex-1 truncate text-[11px] text-ink-muted"
				title={entry.cwd}
			>
				{shortCwd(entry.cwd)}
			</span>
			{entry.heaviest ? (
				<span
					className="shrink-0 font-mono text-[10px] text-warning/80"
					title={t("resources.heaviest", { name: entry.heaviest })}
				>
					{entry.heaviest}
				</span>
			) : null}
			<span className="shrink-0 font-mono text-[10px] text-ink-faint/70 tabular-nums">
				{t("resources.processesShort", { count: entry.usage.processes })}
			</span>
			<Share value={entry.usage.memoryMb} total={total} />
			<span className="w-16 shrink-0 text-right font-mono text-[11px] text-ink tabular-nums">
				{memory(entry.usage.memoryMb)}
			</span>
			<span className="w-12 shrink-0 text-right font-mono text-[10px] text-ink-faint tabular-nums">
				{t("resources.percent", { value: entry.usage.cpu.toFixed(0) })}
			</span>
		</div>
	);
}

export function ResourcesPanel({ onClose }: { onClose: () => void }) {
	// Deux secondes : assez court pour voir un agent partir en vrille, assez
	// long pour que la mesure elle-même ne pèse rien. Le `%` se calcule entre
	// deux relevés, la première valeur est donc toujours nulle.
	const { t } = useTranslation("components2");
	const report = useAsync(() => api.resources.report(), [], { pollMs: 2000 });

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onClose]);

	const data: ResourceReport | null = report.data;
	const total = data?.total.memoryMb ?? 0;

	return (
		<div
			className="animate-in fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 p-8"
			onClick={onClose}
		>
			<div
				className="panel flex max-h-full w-full max-w-3xl flex-col overflow-hidden shadow-2xl shadow-black/50"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="hairline-b flex shrink-0 items-center gap-2 px-3 py-2">
					<Cpu size={13} className="shrink-0 text-accent-soft" />
					<div className="min-w-0 flex-1">
						<div className="text-[12.5px] font-semibold text-ink">{t("resources.title")}</div>
						<div className="text-[10px] text-ink-faint">
							{t("resources.subtitle")}
						</div>
					</div>
					{report.loading ? <Spinner /> : null}
					<Button size="sm" icon={X} onClick={onClose} title={t("resources.close")} />
				</div>

				{!data ? (
					<div className="flex justify-center py-12">
						<Spinner />
					</div>
				) : (
					<div className="min-h-0 flex-1 overflow-y-auto p-3">
						<div className="grid grid-cols-3 gap-2">
							{[
								{
									label: t("resources.appOnly"),
									value: memory(data.app.memoryMb),
									hint: t("resources.cpu", { value: data.app.cpu.toFixed(0) }),
								},
								{
									label: t("resources.withChildren"),
									value: memory(data.total.memoryMb),
									hint: t("resources.processes", { count: data.total.processes, cpu: data.total.cpu.toFixed(0) }),
								},
								{
									label: t("resources.machine"),
									value: `${memory(data.machineUsedMb)} / ${memory(data.machineTotalMb)}`,
									hint:
										data.machineTotalMb > 0
											? t("resources.machineShare", { value: ((data.total.memoryMb / data.machineTotalMb) * 100).toFixed(0) })
											: "",
								},
							].map((card) => (
								<div
									key={card.label}
									className="rounded-lg border border-line-soft bg-surface px-2.5 py-2"
								>
									<div className="text-[10px] text-ink-faint">{card.label}</div>
									<div className="font-mono text-[14px] text-ink tabular-nums">
										{card.value}
									</div>
									<div className="text-[10px] text-ink-faint/70">{card.hint}</div>
								</div>
							))}
						</div>

						{data.agents.length > 0 ? (
							<div className="mt-4">
								<div className="mb-1 flex items-center gap-2 px-2">
									<span className="text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
										{t("resources.agents")}
									</span>
									<Badge mono>{data.agents.length}</Badge>
								</div>
								{data.agents.map((entry) => (
									<Row key={entry.id} entry={entry} total={total} icon={Bot} />
								))}
							</div>
						) : null}

						{data.terminals.length > 0 ? (
							<div className="mt-4">
								<div className="mb-1 flex items-center gap-2 px-2">
									<span className="text-[10px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
										{t("resources.terminals")}
									</span>
									<Badge mono>{data.terminals.length}</Badge>
								</div>
								{data.terminals.map((entry) => (
									<Row key={entry.id} entry={entry} total={total} icon={Terminal} />
								))}
							</div>
						) : null}

						<p className="mt-4 px-2 text-[10px] leading-relaxed text-ink-faint">
							{t("resources.footnote", { context: platformContext })}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Le compteur permanent, en bas de la barre latérale.
 *
 * Une consommation qu'il faut aller chercher ne prévient de rien. Ici elle est
 * sous les yeux, assez discrète pour s'oublier, et elle s'ouvre d'un clic quand
 * le ventilateur se met à souffler.
 */
/**
 * Ce qu'on dépense, toujours sous les yeux.
 *
 * Le panneau d'usage existe, mais il faut penser à l'ouvrir — c'est-à-dire
 * s'inquiéter d'abord, donc trop tard. Un outil qui fait travailler des modèles
 * pour vous doit dire ce qu'il coûte **pendant** qu'il le fait : sur un
 * forfait, ce n'est pas une facture qui surprend, c'est un quota qui s'épuise
 * un mardi après-midi sans qu'on ait rien vu venir.
 *
 * Des jetons et un pourcentage, pas des euros : sur un abonnement rien n'est
 * débité, et un montant ferait croire à une dépense qui n'existe pas.
 */
export function SpendTicker({ onOpen }: { onOpen: () => void }) {
	// Trente secondes, et sans rien lancer : cet appel lit les journaux déjà sur
	// le disque. Le quota, lui, est celui du dernier relevé — on ne démarre pas
	// un CLI pour rafraîchir un témoin.
	const { t } = useTranslation("components2");
	const spend = useAsync(() => api.sessions.spend(), [], { pollMs: 30_000 });
	const data = spend.data;
	if (!data) return null;

	const left = data.remaining;
	const tight = left !== null && left <= 15;
	const low = left !== null && left <= 30;

	return (
		<button
			type="button"
			onClick={onOpen}
			title={
				left === null
					? t("resources.spendNoQuota")
					: data.resetsAt
						? t("resources.spendLeftResets", { left, window: data.tightest, resets: data.resetsAt })
						: t("resources.spendLeft", { left, window: data.tightest })
			}
			className="focus-ring mx-2 flex h-6 items-center gap-2 rounded-lg px-2.5 text-[10px] transition-colors hover:bg-surface"
		>
			<Gauge
				size={11}
				className={clsx(
					"shrink-0",
					tight ? "text-critical" : low ? "text-warning" : "text-ink-faint",
				)}
			/>
			<span className="font-mono text-ink-faint tabular-nums">{compactNumber(data.today)}</span>
			{/* Ce qui reste prime sur ce qui a été pris : c'est la question qu'on se
			    pose en jetant un œil. */}
			<span
				className={clsx(
					"ml-auto font-mono tabular-nums",
					tight ? "text-critical" : low ? "text-warning" : "text-ink-faint/60",
				)}
			>
				{t("resources.percent", { value: left === null ? "—" : left })}
			</span>
		</button>
	);
}


export function ResourcesTicker({ onOpen }: { onOpen: () => void }) {
	// Cinq secondes : c'est un témoin, pas un moniteur. Le panneau ouvert, lui,
	// relève deux fois plus souvent.
	const { t } = useTranslation("components2");
	const report = useAsync(() => api.resources.report(), [], { pollMs: 5000 });
	const data = report.data;
	if (!data) return null;

	const heavy = data.total.memoryMb > 2048;
	return (
		<button
			type="button"
			onClick={onOpen}
			title={t("resources.tickerHint")}
			className="focus-ring mx-2 flex h-6 items-center gap-2 rounded-lg px-2.5 text-[10px] transition-colors hover:bg-surface"
		>
			<Cpu
				size={11}
				className={clsx("shrink-0", heavy ? "text-warning" : "text-ink-faint")}
			/>
			<span
				className={clsx(
					"font-mono tabular-nums",
					heavy ? "text-warning" : "text-ink-faint",
				)}
			>
				{memory(data.total.memoryMb)}
			</span>
			<span className="ml-auto font-mono text-ink-faint/60 tabular-nums">
				{t("resources.percent", { value: data.total.cpu.toFixed(0) })}
			</span>
		</button>
	);
}
