import clsx from "clsx";
import {
	ChevronDown,
	ChevronRight,
	Handshake,
	Scale,
	Split,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Inline } from "@/components/Markdown";
import { Badge } from "@/components/ui";
import type { Panel, PanelDispute, PanelVoice, Severity } from "@/lib/types";

/**
 * Ce sur quoi trois lectures ne se sont pas entendues.
 *
 * L'écran ne montre pas trois rapports : ce serait trois fois plus à lire, soit
 * l'inverse du but. Il montre d'abord le désaccord — la seule chose qu'un
 * humain tranche mieux qu'une machine — et laisse les avis complets repliés,
 * pour qui veut vérifier d'où sort une affirmation.
 *
 * L'accord tient sur une ligne discrète et c'est voulu : ce que trois angles
 * disent ensemble ne demande pas d'attention, il demande juste à être su.
 */

const VERDICT_TONE: Record<string, Severity | "neutral"> = {
	ok: "success",
	réserves: "warning",
	bloquant: "critical",
};

/** La clé de catalogue d'un verdict : la valeur reste celle du back, seul son libellé se traduit. */
const VERDICT_KEY: Record<string, string> = {
	ok: "ok",
	réserves: "reserves",
	bloquant: "blocking",
};

function useVerdictLabel() {
	const { t } = useTranslation("components2");
	return (verdict: string) =>
		verdict
			? VERDICT_KEY[verdict]
				? t(`panelReport.verdict.${VERDICT_KEY[verdict]}`)
				: verdict
			: t("panelReport.noVerdict");
}

export function PanelReport({ panel, stale }: { panel: Panel; stale: boolean }) {
	const { t } = useTranslation("components2");
	const verdictLabel = useVerdictLabel();
	const [open, setOpen] = useState(false);

	return (
		<section
			className={clsx(
				"animate-in rounded-[var(--radius-panel)] border p-3",
				panel.disputes.length > 0
					? "border-warning/40 bg-warning/[0.06]"
					: "border-line-soft bg-surface",
			)}
		>
			<header className="flex flex-wrap items-center gap-1.5">
				<Scale size={12} className="shrink-0 text-accent-soft" />
				<h3 className="text-[11px] font-semibold tracking-[0.05em] text-ink-muted uppercase">
					{t("panelReport.title")}
				</h3>
				<Badge tone={VERDICT_TONE[panel.verdict] ?? "neutral"}>
					{verdictLabel(panel.verdict)}
				</Badge>
				<span className="text-[10px] text-ink-faint">
					{t("panelReport.angles", { count: panel.voices.length })} ·{" "}
					{panel.disputes.length === 0
						? t("panelReport.agreed")
						: t("panelReport.disputes", { count: panel.disputes.length })}
				</span>
				{/* Quatre agents pour une confrontation : le prix se voit, sinon on la
				    relance sans y penser. Même formulation qu'ailleurs — sur un
				    abonnement rien n'est débité, c'est le quota qui se consomme. */}
				<span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-ink-faint">
					{panel.durationSeconds > 0 ? (
						<span>{Math.max(1, Math.round(panel.durationSeconds / 60))} min</span>
					) : null}
					{panel.costUsd > 0 ? (
						<span title={t("panelReport.costHint")}>
							≈ {panel.costUsd.toFixed(2)} $
						</span>
					) : null}
				</span>
			</header>

			{/* Le verdict retenu est le plus sévère, pas le majoritaire : autant le
			    dire, sinon « bloquant » au-dessus de deux « ok » ressemble à un bug. */}
			{panel.verdict !== "ok" && panel.voices.some((voice) => voice.verdict === "ok") ? (
				<p className="mt-1.5 text-[10px] leading-snug text-ink-faint">
					{t("panelReport.severestWins")}
				</p>
			) : null}

			{stale ? (
				<p className="mt-1.5 flex items-start gap-1.5 text-[10.5px] text-warning">
					<TriangleAlert size={11} className="mt-px shrink-0" />
					<span>{t("panelReport.stale")}</span>
				</p>
			) : null}

			{panel.agreed ? (
				<p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-muted">
					<Handshake size={11} className="mt-1 shrink-0 text-success" />
					<span>
						<Inline text={panel.agreed} />
					</span>
				</p>
			) : null}

			{panel.disputes.length > 0 ? (
				<div className="mt-2.5 flex flex-col gap-2">
					{panel.disputes.map((dispute, index) => (
						<DisputeCard key={index} dispute={dispute} />
					))}
				</div>
			) : null}

			{/* Un angle muet compte : un désaccord qu'on n'a pas cherché ne doit pas
			    passer pour un accord. */}
			{panel.silent.length > 0 ? (
				<p className="mt-2 text-[10px] leading-snug text-warning">
					{t("panelReport.silent", { names: panel.silent.join(" · ") })}
				</p>
			) : null}

			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="focus-ring mt-2.5 flex items-center gap-1 rounded text-[10.5px] text-ink-faint transition-colors hover:text-ink"
			>
				{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
				{open ? t("panelReport.collapse") : t("panelReport.expand")}
			</button>

			{open ? (
				<div className="animate-in mt-2 flex flex-col gap-2">
					{panel.voices.map((voice) => (
						<VoiceCard key={voice.lens} voice={voice} />
					))}
				</div>
			) : null}
		</section>
	);
}

function DisputeCard({ dispute }: { dispute: PanelDispute }) {
	const { t } = useTranslation("components2");
	return (
		<article className="rounded-[var(--radius-panel)] border border-line-soft bg-surface p-2.5">
			<div className="flex items-start gap-2">
				<Split size={11} className="mt-1 shrink-0 text-warning" />
				<p className="text-selectable min-w-0 flex-1 text-[12px] leading-snug font-medium text-ink">
					<Inline text={dispute.claim} />
				</p>
			</div>

			{/* La couleur seule ne suffit pas : une carte où un seul camp s'exprime
			    laisserait deviner s'il soutient ou s'il conteste. */}
			<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[19px]">
				<Camp label={t("panelReport.heldBy")} names={dispute.heldBy} tone="success" />
				<Camp label={t("panelReport.against")} names={dispute.against} tone="critical" />
			</div>

			{dispute.why ? (
				<p className="text-selectable mt-1.5 pl-[19px] text-[11.5px] leading-relaxed text-ink-muted">
					<Inline text={dispute.why} />
				</p>
			) : null}

			{/* Le geste qui tranche est la seule chose actionnable de la carte : il
			    se distingue du reste, sinon il se lit comme une remarque de plus. */}
			{dispute.check ? (
				<p className="text-selectable mt-1.5 ml-[19px] rounded-lg border-l-2 border-l-accent bg-raised px-2 py-1 text-[11.5px] leading-relaxed text-ink">
					<Inline text={dispute.check} />
				</p>
			) : null}
		</article>
	);
}

function Camp({
	label,
	names,
	tone,
}: {
	label: string;
	names: string[];
	tone: "success" | "critical";
}) {
	if (names.length === 0) return null;
	return (
		<span className="flex flex-wrap items-center gap-1">
			<span className="text-[10px] text-ink-faint">{label}</span>
			{names.map((name) => (
				<span
					key={name}
					className={clsx(
						"rounded-full border px-1.5 py-px text-[10px]",
						tone === "success"
							? "border-success/40 bg-success/10 text-success"
							: "border-critical/40 bg-critical/10 text-critical",
					)}
				>
					{name}
				</span>
			))}
		</span>
	);
}

function VoiceCard({ voice }: { voice: PanelVoice }) {
	const verdictLabel = useVerdictLabel();
	return (
		<article className="rounded-[var(--radius-panel)] border border-line-soft bg-surface p-2.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="text-[11px] font-medium text-ink">{voice.label}</span>
				<Badge tone={VERDICT_TONE[voice.verdict] ?? "neutral"}>
					{verdictLabel(voice.verdict)}
				</Badge>
			</div>
			{voice.summary ? (
				<p className="text-selectable mt-1 text-[11.5px] leading-relaxed text-ink-muted">
					<Inline text={voice.summary} />
				</p>
			) : null}
			{voice.points.length > 0 ? (
				<ul className="mt-1.5 flex flex-col gap-1">
					{voice.points.map((point, index) => (
						<li
							key={index}
							className="text-selectable flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-muted"
						>
							<span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-faint/60" />
							<span>
								<Inline text={point} />
							</span>
						</li>
					))}
				</ul>
			) : null}
		</article>
	);
}
