import clsx from "clsx";
import { Check, CircleDashed, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCockpit } from "@/app/store";
import { Button } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { ReadinessCheck } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * Ce qu'il manque au poste avant de lancer un agent, posé sur la carte.
 *
 * Un cockpit fraîchement installé s'ouvrait sur une carte vide, et chaque
 * prérequis absent se découvrait au premier geste qui en avait besoin — par un
 * message qui ne désignait pas la cause. La carte dit donc d'emblée ce qui
 * manque et comment le régler, puis s'efface d'elle-même : elle n'apparaît
 * que tant qu'un prérequis essentiel manque.
 */
export function ReadinessCard() {
	const { t } = useTranslation("components3");
	const { t: tViews } = useTranslation("views");
	// Les chemins des réglages, avec les libellés que l'écran affiche, dans sa
	// langue : une consigne qui nomme un onglet introuvable ne sert à rien.
	const where: Partial<Record<ReadinessCheck["id"], string>> = {
		project: tViews("settings.tabs.projects.label"),
		claudeAuth: `${tViews("settings.tabs.agents.label")} → ${tViews("settings.sections.accounts")}`,
	};
	const { go } = useCockpit();
	const state = useAsync(() => api.system.readiness(), []);
	const readiness = state.data;
	if (!readiness || readiness.ready) return null;

	const action = (check: ReadinessCheck) => {
		if (check.ok) return null;
		// Un projet se déclare, un compte se connecte : les deux gestes existent
		// déjà dans les réglages, on y mène plutôt que d'en refaire un ici.
		if (check.id === "project" || check.id === "claudeAuth") {
			return (
				<Button size="sm" onClick={() => go("settings")}>
					{t("readiness.openSettings")}
				</Button>
			);
		}
		return null;
	};

	return (
		<div className="pointer-events-auto absolute top-14 left-3 z-20 w-[380px] max-w-[calc(100%-1.5rem)] rounded-[var(--radius-panel)] border border-line-soft bg-surface p-3 shadow-[var(--shadow-pop)]">
			<div className="mb-1 flex items-center gap-2">
				<span className="flex-1 text-[13px] font-semibold text-ink">{t("readiness.title")}</span>
				<Button
					size="sm"
					icon={RefreshCw}
					loading={state.loading}
					onClick={() => state.reload()}
				>
					{t("readiness.recheck")}
				</Button>
			</div>
			<p className="mb-2.5 text-[11px] leading-relaxed text-ink-muted">{t("readiness.intro")}</p>
			<ul className="flex flex-col gap-2">
				{readiness.checks.map((check) => (
					<li key={check.id} className="flex items-start gap-2">
						{check.ok ? (
							<Check size={14} className="mt-0.5 shrink-0 text-success" />
						) : check.required ? (
							<X size={14} className="mt-0.5 shrink-0 text-critical" />
						) : (
							<CircleDashed size={14} className="mt-0.5 shrink-0 text-ink-faint" />
						)}
						<div className="min-w-0 flex-1">
							<div
								className={clsx(
									"text-[12px]",
									check.ok || !check.required ? "text-ink-muted" : "font-medium text-ink",
								)}
							>
								{t(`readiness.checks.${check.id}.label`)}
								{!check.required ? (
									<span className="ml-1.5 text-[10px] text-ink-faint">{t("readiness.optional")}</span>
								) : null}
							</div>
							{check.ok && check.detail ? (
								<div className="truncate font-mono text-[10px] text-ink-faint" title={check.detail}>
									{check.detail}
								</div>
							) : null}
							{!check.ok ? (
								<div className="text-selectable text-[11px] leading-relaxed text-ink-muted">
									{t(`readiness.checks.${check.id}.fix`, { where: where[check.id] ?? "" })}
								</div>
							) : null}
						</div>
						{action(check)}
					</li>
				))}
			</ul>
			<p className="mt-2.5 text-[10px] leading-relaxed text-ink-faint">{t("readiness.restart")}</p>
		</div>
	);
}
