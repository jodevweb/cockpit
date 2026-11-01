import clsx from "clsx";
import { CircleHelp, CircleSlash, ShieldCheck, ShieldX, Target, TriangleAlert } from "lucide-react";
import { Inline } from "@/components/Markdown";
import type { PropertyAudit, PropertyCheck } from "@/lib/types";

/**
 * Ce qui doit rester vrai, et ce qui ne l'est plus.
 *
 * Ce bloc passe avant tout le reste du rapport : c'est le seul endroit de
 * l'écran où une machine dit quelque chose de vérifiable — avec un fichier et
 * une ligne — là où les lectures d'impact restent des interprétations.
 *
 * Les quatre verdicts comptent, et « hors sujet » autant que les autres : sans
 * lui, une propriété sur les migrations conclurait « tenue » sur un diff qui
 * n'en contient aucune, et ce faux vert se lirait comme une garantie.
 */

const VERDICTS: Record<
	string,
	{
		icon: React.ComponentType<{ size?: number; className?: string }>;
		tint: string;
		border: string;
		label: string;
	}
> = {
	enfreinte: {
		icon: ShieldX,
		tint: "text-critical",
		border: "border-l-critical",
		label: "enfreinte",
	},
	tenue: {
		icon: ShieldCheck,
		tint: "text-success",
		border: "border-l-success",
		label: "tenue",
	},
	"hors sujet": {
		icon: CircleSlash,
		tint: "text-ink-faint",
		border: "border-l-line",
		label: "hors sujet",
	},
	indécis: {
		icon: CircleHelp,
		tint: "text-warning",
		border: "border-l-warning",
		label: "indécis",
	},
};

export function PropertiesReport({
	audit,
	stale,
}: {
	audit: PropertyAudit;
	stale: boolean;
}) {
	const broken = audit.checks.filter((check) => check.verdict === "enfreinte");
	const undecided = audit.checks.filter((check) => check.verdict === "indécis");
	// Ce qui a été jugé sans rien signaler : compté, jamais détaillé. Trois
	// lignes vertes n'apprennent rien qu'un chiffre ne dise mieux.
	const quiet = audit.checks.filter(
		(check) => check.verdict === "tenue" || check.verdict === "hors sujet",
	);

	return (
		<section
			className={clsx(
				"animate-in rounded-[var(--radius-panel)] border p-3",
				broken.length > 0
					? "border-critical/40 bg-critical/[0.06]"
					: "border-line-soft bg-surface",
			)}
		>
			<header className="flex flex-wrap items-center gap-1.5">
				<Target size={12} className="shrink-0 text-accent-soft" />
				<h3 className="text-[11px] font-semibold tracking-[0.05em] text-ink-muted uppercase">
					Ce qui doit rester vrai
				</h3>
				<span
					className={clsx(
						"text-[10px]",
						broken.length > 0 ? "text-critical" : "text-ink-faint",
					)}
				>
					{broken.length === 0
						? `${audit.checks.length} propriété${audit.checks.length > 1 ? "s" : ""} jugée${audit.checks.length > 1 ? "s" : ""} · rien d'enfreint`
						: `${broken.length} enfreinte${broken.length > 1 ? "s" : ""} sur ${audit.checks.length}`}
				</span>
				<span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-ink-faint">
					{audit.durationSeconds > 0 ? (
						<span>{Math.max(1, Math.round(audit.durationSeconds / 60))} min</span>
					) : null}
					{audit.costUsd > 0 ? (
						<span title="Ce que cette vérification vaudrait aux tarifs de l'API. Sur un abonnement, rien n'est débité : c'est le quota de la fenêtre qui se consomme.">
							≈ {audit.costUsd.toFixed(2)} $
						</span>
					) : null}
				</span>
			</header>

			{stale ? (
				<p className="mt-1.5 flex items-start gap-1.5 text-[10.5px] text-warning">
					<TriangleAlert size={11} className="mt-px shrink-0" />
					<span>La branche a bougé depuis cette vérification.</span>
				</p>
			) : null}

			{/* Enfreintes d'abord, indécis ensuite : les deux demandent quelque
			    chose, le reste ne demande rien. */}
			<div className="mt-2 flex flex-col gap-1.5">
				{[...broken, ...undecided].map((check) => (
					<CheckCard key={check.propertyId} check={check} />
				))}
			</div>

			{quiet.length > 0 ? (
				<p className="mt-2 text-[10.5px] leading-snug text-ink-faint">
					{quiet.filter((check) => check.verdict === "tenue").length} tenue(s),{" "}
					{quiet.filter((check) => check.verdict === "hors sujet").length} sans rapport
					avec ce changement.
				</p>
			) : null}
		</section>
	);
}

function CheckCard({ check }: { check: PropertyCheck }) {
	const style = VERDICTS[check.verdict] ?? VERDICTS.indécis;
	const Icon = style.icon;

	return (
		<article
			className={clsx(
				"rounded-[var(--radius-panel)] border border-line-soft border-l-2 bg-surface p-2.5",
				style.border,
			)}
		>
			<div className="flex items-start gap-2">
				<Icon size={12} className={clsx("mt-0.5 shrink-0", style.tint)} />
				<div className="min-w-0 flex-1">
					<p className="text-selectable text-[12px] leading-snug text-ink">
						<Inline text={check.text} />
					</p>
					{check.note ? (
						<p className="text-selectable mt-1 text-[11.5px] leading-relaxed text-ink-muted">
							<Inline text={check.note} />
						</p>
					) : null}
					{/* La preuve est ce qui sépare ce bloc d'un avis : elle se lit en
					    mono, et elle se retrouve dans le dépôt. */}
					{check.evidence.length > 0 ? (
						<p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-ink-faint">
							{check.evidence.map((entry) => (
								<span key={entry}>{entry}</span>
							))}
						</p>
					) : null}
				</div>
				<span className={clsx("shrink-0 text-[10px]", style.tint)}>{style.label}</span>
			</div>
		</article>
	);
}
