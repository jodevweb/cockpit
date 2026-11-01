import clsx from "clsx";
import { ExternalLink, Undo2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { verdictLabel, verdictTone } from "@/components/EngagementCard";
import { useConfirm } from "@/components/Confirm";
import { Badge, Button, Dot } from "@/components/ui";
import { locale } from "@/i18n";
import { fromTimestamp } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { Engagement, PermanenceState } from "@/lib/types";
import { useCockpit } from "@/app/store";

/**
 * Le détail d'un engagement.
 *
 * Panneau et non modale : on doit pouvoir regarder la liste pendant qu'on lit.
 *
 * **Chaque étape porte son résultat**, pas seulement son intention — une ligne
 * qui dit « lance un agent » sans dire ce qu'il a produit est une ligne de log,
 * pas une ligne de journal.
 */
export function EngagementPanel({
	engagement,
	onClose,
	onChange,
}: {
	engagement: Engagement;
	onClose: () => void;
	onChange: (state: PermanenceState) => void;
}) {
	const { t } = useTranslation("components3");
	const { notify } = useCockpit();
	const { confirm } = useConfirm();
	const [busy, setBusy] = useState(false);

	const running = engagement.stage === "planning" || engagement.stage === "running";
	const stuck = engagement.produced.filter((entry) => !entry.undoable);
	// « Annuler » grisé sans raison est le pire des deux mondes : on ne sait ni
	// pourquoi, ni ce qu'il faudrait faire à la main.
	const blocking =
		engagement.produced.length === 0
			? t("engagementPanel.nothingProduced")
			: stuck.length > 0
				? t("engagementPanel.cannotUndo", { items: stuck.map((entry) => entry.label).join(", ") })
				: "";

	const undo = async () => {
		const ok = await confirm({
			title: t("engagementPanel.undoConfirmTitle"),
			message: engagement.produced.map((entry) => entry.label).join(", "),
			confirmLabel: t("engagementPanel.undoConfirm"),
			danger: true,
		});
		if (!ok) return;
		setBusy(true);
		try {
			const result = await api.permanence.undo(engagement.id);
			onChange(result.state);
			notify(
				result.failed.length > 0
					? t("engagementPanel.undoFailed", { items: result.failed.join(", ") })
					: t("engagementPanel.undone", { items: result.stopped.join(", ") }),
			);
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<aside className="animate-in flex w-[380px] shrink-0 flex-col bg-surface shadow-[inset_1px_0_0_var(--color-line-soft)]">
			<header className="hairline-b flex items-center gap-2 px-3.5 py-2.5">
				<Dot tone={running ? "info" : verdictTone(engagement.verdict)} pulse={running} />
				<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">
					{engagement.goal || engagement.label}
				</span>
				<Button size="sm" icon={X} onClick={onClose} title={t("engagementPanel.close")} />
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
				<Block title={t("engagementPanel.trigger")}>
					<p className="text-[11.5px] text-ink">{engagement.label}</p>
					<p className="font-mono text-[10.5px] text-ink-faint">
						{t("engagementPanel.triggerLine", {
							trigger: engagement.trigger || t("engagementPanel.noTrigger"),
							rule: engagement.rule,
						})}
					</p>
				</Block>

				{/* L'oracle avant le verdict : on doit pouvoir juger si la preuve
				    visée est la bonne, indépendamment du fait qu'elle soit atteinte. */}
				<Block title={t("engagementPanel.oracle")}>
					<div className="flex items-center gap-2 rounded-lg bg-raised px-2 py-1.5">
						<span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-muted">
							{engagement.oracle?.kind
								? `${engagement.oracle.kind} · ${engagement.oracle.key}`
								: t("engagementPanel.none")}
						</span>
						{!running ? (
							<Badge tone={verdictTone(engagement.verdict)}>
								{verdictLabel(engagement.verdict)}
							</Badge>
						) : null}
					</div>
					{engagement.why ? (
						<p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
							{engagement.why}
						</p>
					) : null}
				</Block>

				<Block title={t("engagementPanel.timeline")}>
					<div className="flex flex-col">
						{engagement.steps.length === 0 ? (
							<p className="text-[11px] text-ink-faint">{t("engagementPanel.nothingYet")}</p>
						) : (
							engagement.steps.map((step, index) => (
								/* L'horodatage à droite plutôt qu'en colonne : « il y a
								   quatre minutes » ne tient pas dans une gouttière, et une
								   gouttière assez large pour lui écraserait le texte. */
								<div key={index} className="flex gap-2 py-1">
									<div className="min-w-0 flex-1">
										<p className="text-[11.5px] text-ink">{step.what}</p>
										{step.result ? (
											<p
												className={clsx(
													"font-mono text-[10.5px] leading-snug break-words",
													step.ok ? "text-ink-muted" : "text-critical",
												)}
											>
												{step.result}
											</p>
										) : null}
									</div>
									<span className="shrink-0 pt-0.5 font-mono text-[10px] whitespace-nowrap text-ink-faint">
										{fromTimestamp(step.at)}
									</span>
								</div>
							))
						)}
					</div>
				</Block>

				{engagement.produced.length > 0 ? (
					<Block title={t("engagementPanel.produced")}>
						<div className="flex flex-col gap-1">
							{engagement.produced.map((entry, index) => (
								<div
									key={index}
									className="flex items-center gap-2 rounded-lg bg-raised px-2 py-1.5"
								>
									<Badge mono>{entry.kind}</Badge>
									<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
										{entry.label}
									</span>
									{entry.url ? (
										<Button
											size="sm"
											icon={ExternalLink}
											title={t("engagementPanel.open")}
											onClick={() =>
												void api.system
													.openUrl(entry.url)
													.catch((error) => notify(String(error)))
											}
										/>
									) : null}
								</div>
							))}
						</div>
					</Block>
				) : null}

				<Block title={t("engagementPanel.cost")}>
					<p
						className="font-mono text-[11px] text-ink-muted"
						title={t("engagementPanel.costHint")}
					>
						≈{" "}
						{engagement.costUsd.toLocaleString(locale(), {
							minimumFractionDigits: 2,
							maximumFractionDigits: 2,
						})}{" "}
						$
						{engagement.endedAt > engagement.startedAt
							? ` · ${Math.max(1, Math.round((engagement.endedAt - engagement.startedAt) / 60))} min`
							: ""}
					</p>
				</Block>

				<div>
					<Button
						icon={Undo2}
						variant="outline"
						className="w-full justify-center"
						disabled={Boolean(blocking) || busy}
						loading={busy}
						title={blocking || t("engagementPanel.undoHint")}
						onClick={() => void undo()}
					>
						{t("engagementPanel.undo")}
					</Button>
					{blocking ? (
						<p className="mt-1 text-[10px] leading-snug text-ink-faint">{blocking}</p>
					) : null}
				</div>
			</div>
		</aside>
	);
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section>
			<h3 className="mb-1.5 text-[10px] tracking-[0.07em] text-ink-faint uppercase">
				{title}
			</h3>
			{children}
		</section>
	);
}
