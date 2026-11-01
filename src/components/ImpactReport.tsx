import clsx from "clsx";
import {
	AlertTriangle,
	Clock,
	ExternalLink,
	Eye,
	FileText,
	History,
	Lightbulb,
	ListChecks,
	RefreshCw,
	Scale,
	Target,
	Trash2,
	Wrench,
} from "lucide-react";
import { Inline } from "@/components/Markdown";
import { PanelReport } from "@/components/PanelReport";
import { PropertiesReport } from "@/components/PropertiesReport";
import { Badge, Button } from "@/components/ui";
import { api } from "@/lib/ipc";
import type {
	Change,
	ImpactAnalysis,
	ImpactSection,
	Panel,
	PropertyAudit,
	Severity,
} from "@/lib/types";
import { useCockpit } from "@/app/store";
import { locale, t } from "@/i18n";
import { useTranslation } from "react-i18next";

/**
 * Chaque bloc a sa silhouette, et l'ordre ne change jamais.
 *
 * On revient sur cet écran plusieurs fois par jour : la mémoire doit pouvoir
 * s'appuyer sur la place d'un bloc plutôt que sur son titre. L'icône donne le
 * repère avant la lecture — c'est aussi ce qui distingue « ce qui peut casser »
 * de « à vérifier » quand on parcourt en diagonale.
 */
const BLOCS: Record<
	string,
	{ icon: React.ComponentType<{ size?: number; className?: string }>; tint: string }
> = {
	produit: { icon: Eye, tint: "text-accent-soft" },
	pourquoi: { icon: History, tint: "text-info" },
	choix: { icon: Scale, tint: "text-ink-muted" },
	risques: { icon: AlertTriangle, tint: "text-warning" },
	verifier: { icon: ListChecks, tint: "text-success" },
	mieux: { icon: Lightbulb, tint: "text-ink-muted" },
	autre: { icon: FileText, tint: "text-ink-muted" },
};

export const VERDICT_TONE: Record<string, Severity | "neutral"> = {
	ok: "success",
	réserves: "warning",
	bloquant: "critical",
};

/** La couleur d'une puce selon ce qu'elle met en jeu. */
const GRAVITE: Record<string, string> = {
	critical: "border-l-critical",
	warning: "border-l-warning",
	info: "border-l-info",
	success: "border-l-success",
	neutral: "border-l-line",
};

export const RISQUE_TONE: Record<string, Severity | "neutral"> = {
	faible: "success",
	moyen: "warning",
	élevé: "critical",
};

/** Une date lisible, en un coup d'œil, depuis des secondes epoch. */
function depuis(at: number): string {
	const minutes = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
	if (minutes < 1) return t("components1:impactReport.ago.now");
	if (minutes < 60) return t("components1:impactReport.ago.minutes", { count: minutes });
	const heures = Math.round(minutes / 60);
	if (heures < 24) return t("components1:impactReport.ago.hours", { count: heures });
	return t("components1:impactReport.ago.days", { count: Math.round(heures / 24) });
}

/**
 * Le verdict et le risque arrivent du Rust sous leur valeur stockée (`réserves`,
 * `élevé`…) : on les compare tels quels, on ne traduit que ce qu'on affiche.
 */
const VERDICT_KEYS: Record<string, string> = { ok: "ok", réserves: "reserves", bloquant: "blocking" };
const RISQUE_KEYS: Record<string, string> = { faible: "low", moyen: "medium", élevé: "high" };

export function verdictLabel(verdict: string): string {
	if (!verdict) return t("components1:impactReport.noVerdict");
	const key = VERDICT_KEYS[verdict];
	return key ? t(`components1:impactReport.verdict.${key}`) : verdict;
}

export function riskLabel(risk: string): string {
	const key = RISQUE_KEYS[risk];
	return t("components1:impactReport.risk", {
		level: key ? t(`components1:impactReport.riskLevel.${key}`) : risk || t("components1:impactReport.riskLevel.unknown"),
	});
}

/** Le nom anglais de la langue de l'interface, pour dire à l'agent dans quelle langue répondre. */
function languageName(): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(locale()) ?? "English";
	} catch {
		return "English";
	}
}

function Bloc({ section }: { section: ImpactSection }) {
	const { icon: Icon, tint } = BLOCS[section.id] ?? BLOCS.autre;
	return (
		<section className="animate-in">
			<div className="mb-1.5 flex items-center gap-1.5">
				<Icon size={12} className={tint} />
				<h3 className="text-[11px] font-semibold tracking-[0.05em] text-ink-muted uppercase">
					{section.title}
				</h3>
			</div>
			{section.body ? (
				<p className="text-selectable mb-1.5 text-[12px] leading-relaxed whitespace-pre-line text-ink-muted">
					<Inline text={section.body} />
				</p>
			) : null}
			{section.points.length ? (
				<ul className="flex flex-col gap-1">
					{section.points.map((point, index) => (
						<li
							key={index}
							className={clsx(
								// Les bordures en utilitaires plutôt que par `panel` : la
								// règle groupée de `panel` réécrit `border` en entier, et
								// reposait donc la couleur juste après qu'on l'a choisie.
								"text-selectable flex items-start gap-2 rounded-[var(--radius-panel)] border border-line-soft border-l-2 bg-surface px-2.5 py-1.5 text-[12px] leading-snug text-ink",
								// La gravité se lit à la couleur, jamais au mot : le texte de
								// la puce a été débarrassé de sa marque à la lecture. Une
								// bordure plutôt qu'une pastille — sur trois risques
								// d'affilée, six pixels de couleur ne se comparent pas.
								GRAVITE[point.severity] ?? GRAVITE.neutral,
							)}
						>
							<span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-faint/60" />
							<span>
								<Inline text={point.text} />
							</span>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}

/**
 * Ce que le cockpit a compris d'un changement.
 *
 * Le rapport n'est pas rendu comme du markdown : il a été relu et découpé côté
 * Rust, et chaque bloc a ici sa forme. Un mur de texte se serait lu comme une
 * revue de plus — or tout l'intérêt est de pouvoir sauter directement à « ce qui
 * peut casser » sans lire le reste.
 */
/**
 * Le brief remis à l'agent qui va traiter ce qu'on vient de lire.
 *
 * On lui rend la lecture entière plutôt qu'un résumé : elle a coûté plusieurs
 * minutes et contient déjà le pourquoi, les choix et les scénarios de panne.
 * La refaire deviner serait payer deux fois. Ce qui est ajouté, c'est
 * seulement la consigne — ce qu'on attend de lui, et ce qu'il ne doit pas
 * faire.
 */
export function briefFor(change: Change, analysis: ImpactAnalysis): string {
	const bloc = (id: string) => analysis.sections.find((section) => section.id === id);
	const lignes = (id: string) =>
		(bloc(id)?.points ?? []).map((point) => `- ${point.text}`).join("\n");

	const risques = lignes("risques");
	const verifications = lignes("verifier");

	return [
		`You are taking over the branch \`${change.branch}\` (${change.repo} ${change.reference}).`,
		"",
		"An impact reading has already been done on this change. Here is what it",
		"concluded — take it as a starting point, not as gospel: check against the",
		"code before acting, and say so if you find it off the mark.",
		"",
		`## What it changes\n${bloc("produit")?.body || analysis.headline}`,
		bloc("pourquoi")?.body ? `\n## Why now\n${bloc("pourquoi")?.body}` : "",
		risques ? `\n## What can break\n${risques}` : "",
		verifications ? `\n## To check before merging\n${verifications}` : "",
		"",
		"## What I expect from you",
		"Handle the risks above in the order they are written — the first one is",
		"the most serious. For each: confirm it against the code, fix it if it is",
		"real, and say plainly if it is not rather than inventing a fix. Touch",
		"nothing else: no refactor, no cleanup, no improvement nobody asked for.",
		"End with what you changed and what remains open.",
		"",
		`Reply in ${languageName()}, the language of the user's interface.`,
	]
		.filter(Boolean)
		.join("\n");
}

export function ImpactReport({
	change,
	analysis,
	running,
	panel,
	confronting,
	audit,
	auditing,
	onAnalyze,
	onForget,
	onWorkOn,
	onConfront,
	onAudit,
}: {
	change: Change;
	analysis: ImpactAnalysis;
	running: boolean;
	/** La confrontation déjà faite sur ce changement, s'il y en a une. */
	panel: Panel | null;
	confronting: boolean;
	/** Ce que les propriétés déclarées ont donné sur ce changement. */
	audit: PropertyAudit | null;
	auditing: boolean;
	onAnalyze: () => void;
	onForget: () => void;
	/** Ouvrir un agent sur cette branche, nourri de la lecture. */
	onWorkOn: () => void;
	/** Faire relire le même changement sous trois angles. */
	onConfront: () => void;
	/** Juger ce changement propriété par propriété. */
	onAudit: () => void;
}) {
	const { t } = useTranslation("components1");
	const { notify } = useCockpit();
	// Une analyse est scellée à la tête de la branche : quatre commits plus tard,
	// elle raconte un état qui n'existe plus. Le dire vaut mieux que l'effacer —
	// une lecture périmée reste souvent juste sur l'essentiel.
	const perimee =
		analysis.headSha !== "" &&
		change.headSha !== "" &&
		analysis.headSha !== change.headSha;

	return (
		// Seule la zone centrale défile. Le pied était `sticky` à l'intérieur du
		// conteneur défilant : il suivait le texte au lieu de rester en bas, et
		// se retrouvait au milieu du rapport dès qu'on faisait défiler.
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="hairline-b flex shrink-0 items-start gap-2 px-4 py-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<Badge tone={VERDICT_TONE[analysis.verdict] ?? "neutral"}>
							{verdictLabel(analysis.verdict)}
						</Badge>
						<Badge tone={RISQUE_TONE[analysis.risk] ?? "neutral"}>
							{riskLabel(analysis.risk)}
						</Badge>
						<span className="font-mono text-[10px] text-ink-faint">
							{change.repo} {change.reference}
						</span>
					</div>
					<h2 className="text-selectable mt-1 text-[14px] leading-snug font-semibold text-ink">
						{change.title}
					</h2>
					<p className="mt-0.5 font-mono text-[10px] text-ink-faint">
						{change.branch} → {change.base}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						size="sm"
						variant="solid"
						icon={Wrench}
						onClick={onWorkOn}
						title={t("impactReport.workOnTitle")}
					>
						{t("impactReport.workOn")}
					</Button>
					{change.url ? (
						<Button
							size="sm"
							icon={ExternalLink}
							title={t("impactReport.openForge")}
							onClick={() => {
								void api.system.openUrl(change.url).catch((error) => notify(String(error)));
							}}
						/>
					) : null}
				</div>
			</header>

			{perimee ? (
				<div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-warning/8 px-4 py-2">
					<AlertTriangle size={12} className="shrink-0 text-warning" />
					<p className="flex-1 text-[11px] text-warning">
						{t("impactReport.stale")}
					</p>
					<Button size="sm" icon={RefreshCw} loading={running} onClick={onAnalyze}>
						{t("impactReport.reread")}
					</Button>
				</div>
			) : null}

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
				{/* Ce qui est enfreint passe en premier : c'est un fait vérifiable,
				    là où tout le reste est une lecture. */}
				{audit ? (
					<PropertiesReport
						audit={audit}
						stale={
							audit.headSha !== "" &&
							change.headSha !== "" &&
							audit.headSha !== change.headSha
						}
					/>
				) : null}

				{/* Le désaccord passe avant le rapport : c'est ce qui reste à
				    trancher, quand le reste a déjà été conclu par quelqu'un. */}
				{panel ? (
					<PanelReport
						panel={panel}
						stale={
							panel.headSha !== "" &&
							change.headSha !== "" &&
							panel.headSha !== change.headSha
						}
					/>
				) : null}

				{analysis.sections.map((section) => (
					<Bloc key={section.id + section.title} section={section} />
				))}
			</div>

			<footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft bg-base px-4 py-2">
				<span className="flex items-center gap-1 text-[10px] text-ink-faint">
					<Clock size={10} /> {depuis(analysis.at)}
				</span>
				{analysis.engine ? (
					<span className="text-[10px] text-ink-faint">
						{analysis.engine}
						{analysis.model ? ` · ${analysis.model}` : ""}
					</span>
				) : null}
				{analysis.durationSeconds > 0 ? (
					<span className="font-mono text-[10px] text-ink-faint">
						{t("impactReport.readingMinutes", {
							count: Math.max(1, Math.round(analysis.durationSeconds / 60)),
						})}
					</span>
				) : null}
				{/* « en tarif API » et non « coût » : le moteur rend ce montant de la
				    même façon qu'on paie à l'usage ou qu'on tourne sur un
				    abonnement. Sur abonnement rien n'est débité — c'est le quota de
				    la fenêtre qui se consomme, et l'écrire « 1,67 $ » ferait croire
				    à une facture qui n'existe pas. */}
				{analysis.costUsd > 0 ? (
					<span
						className="font-mono text-[10px] text-ink-faint"
						title={t("impactReport.apiCostTitle")}
					>
						{t("impactReport.apiCost", { cost: analysis.costUsd.toFixed(2) })}
					</span>
				) : null}
				<div className="ml-auto flex items-center gap-1.5">
					{analysis.briefPath ? (
						<Button
							size="sm"
							icon={FileText}
							title={t("impactReport.briefTitle")}
							onClick={() => {
								void api.system
									.reveal(analysis.briefPath)
									.catch((error) => notify(String(error)));
							}}
						>
							{t("impactReport.brief")}
						</Button>
					) : null}
					{/* Jeter une lecture plutôt que la corriger : quand un rapport est
					    à côté de la plaque, on ne veut pas le garder « en attendant »,
					    il finirait par se lire comme un fait établi. */}
					{/* Quatre agents au lieu d'un : jamais lancée d'elle-même, et son
					    prix est dit avant qu'on clique. Une fois faite, elle se refait
					    seulement si on le redemande — la branche a peut-être bougé. */}
					<Button
						size="sm"
						icon={Target}
						loading={auditing}
						onClick={onAudit}
						title={t("impactReport.auditTitle")}
					>
						{audit ? t("impactReport.reaudit") : t("impactReport.audit")}
					</Button>
					<Button
						size="sm"
						icon={Scale}
						loading={confronting}
						onClick={onConfront}
						title={
							panel
								? t("impactReport.reconfrontTitle")
								: t("impactReport.confrontTitle")
						}
					>
						{panel ? t("impactReport.reconfront") : t("impactReport.confront")}
					</Button>
					<Button size="sm" icon={Trash2} variant="danger" onClick={onForget}>
						{t("impactReport.forget")}
					</Button>
					<Button size="sm" icon={RefreshCw} loading={running} onClick={onAnalyze}>
						{t("impactReport.reread")}
					</Button>
				</div>
			</footer>
		</div>
	);
}

/** La barre de volume d'un diff : la proportion se voit avant les chiffres. */
export function DiffBar({
	additions,
	deletions,
}: {
	additions: number | null;
	deletions: number | null;
}) {
	if (additions === null || deletions === null) return null;
	const total = additions + deletions;
	const part = total === 0 ? 50 : Math.round((additions / total) * 100);
	return (
		<span className="flex items-center gap-1.5">
			<span className="flex h-1 w-14 overflow-hidden rounded-full bg-raised">
				<span className="bg-success" style={{ width: `${part}%` }} />
				<span className="bg-critical" style={{ width: `${100 - part}%` }} />
			</span>
			<span className="font-mono text-[10px] text-success">+{additions}</span>
			<span className="font-mono text-[10px] text-critical">−{deletions}</span>
		</span>
	);
}

/** Depuis quand une analyse existe, ou son absence. */
export function AnalysisAge({ at }: { at: number }) {
	return (
		// `whitespace-nowrap` : « il y a 9 h » se coupait entre deux mots au
		// premier pied de carte un peu chargé, et le compteur se lisait sur deux
		// lignes bancales.
		<span className="font-mono text-[10px] whitespace-nowrap text-ink-faint">
			{depuis(at)}
		</span>
	);
}
