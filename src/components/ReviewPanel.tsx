import clsx from "clsx";
import {
	AlertOctagon,
	ArrowUpRight,
	Check,
	CircleDashed,
	Copy,
	FileCode2,
	Lightbulb,
	RefreshCw,
	ShieldAlert,
	ShieldCheck,
	TriangleAlert,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui";
import { useFileViewer } from "@/lib/fileViewer";
import { fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { Review, ReviewFinding } from "@/lib/types";

/**
 * Une revue de code, rangée pour qu'on la poste.
 *
 * La réponse de l'agent arrivait en texte : il fallait la relire, retrouver
 * chaque fichier, recopier chaque message, et se souvenir de ce qu'on avait
 * déjà posté. Ici chaque point est une carte : où (fichier et lignes, qui
 * s'ouvrent), pourquoi, comment le corriger, et le commentaire prêt à coller —
 * avec le lien qui ouvre la PR sur GitHub à cette ligne précise, là où on le
 * colle. On coche ce qu'on a posté.
 *
 * Une vérification dit d'abord ce que sont devenus les points d'avant, puis ce
 * qu'elle trouve de neuf.
 */

const SEVERITY = {
	bloquant: { icon: AlertOctagon, bar: "bg-critical", text: "text-critical", soft: "bg-critical/8" },
	important: { icon: TriangleAlert, bar: "bg-warning", text: "text-warning", soft: "bg-warning/8" },
	suggestion: { icon: Lightbulb, bar: "bg-info", text: "text-info", soft: "bg-info/8" },
} as const;

const VERDICT: Record<string, { tone: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
	merge: { tone: "bg-success/12 text-success", icon: ShieldCheck },
	corrections: { tone: "bg-warning/12 text-warning", icon: ShieldAlert },
	bloquant: { tone: "bg-critical/12 text-critical", icon: AlertOctagon },
};

const CHECK: Record<string, { tone: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
	corrige: { tone: "text-success", icon: Check },
	partiel: { tone: "text-warning", icon: CircleDashed },
	non_corrige: { tone: "text-critical", icon: X },
};

function severityOf(value: string): keyof typeof SEVERITY {
	return value in SEVERITY ? (value as keyof typeof SEVERITY) : "suggestion";
}

/** `42` ou `42-57` → la première et la dernière ligne. */
function span(lines: string): { start: number; end: number } | null {
	const numbers = (lines.match(/\d+/g) ?? []).map(Number);
	if (numbers.length === 0) return null;
	return { start: numbers[0], end: numbers[numbers.length - 1] };
}

/**
 * L'ancre GitHub d'un fichier dans « Files changed » : l'empreinte SHA-256 de
 * son chemin. Avec `R<ligne>`, la page s'ouvre sur la ligne, côté nouvelle
 * version — là où l'on poste un commentaire.
 */
async function diffAnchor(path: string): Promise<string> {
	const bytes = new TextEncoder().encode(path);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ReviewPanel({
	review,
	cwd,
	headSha,
	onRecheck,
	onReview,
	busy,
}: {
	review: Review;
	/** Le worktree relu : les fichiers s'ouvrent depuis lui. */
	cwd: string;
	/** Le commit de tête actuel de la PR, pour dire si elle a bougé. */
	headSha: string | null;
	onRecheck: () => void;
	onReview: () => void;
	busy: boolean;
}) {
	const { t } = useTranslation("components2");
	const [shown, setShown] = useState(review.rounds.length - 1);
	useEffect(() => setShown(review.rounds.length - 1), [review.rounds.length]);
	const round = review.rounds[shown];
	const last = review.rounds[review.rounds.length - 1];
	const moved = Boolean(last?.headSha && headSha && last.headSha !== headSha);
	// Tous les points jamais relevés, pour nommer ceux qu'une vérification cite.
	const everyFinding = useMemo(() => {
		const table = new Map<string, ReviewFinding>();
		for (const entry of review.rounds) for (const finding of entry.findings) table.set(finding.id, finding);
		return table;
	}, [review.rounds]);

	if (!round) return null;
	const verdictKey = round.verdict in VERDICT ? round.verdict : "corrections";
	const verdict = VERDICT[verdictKey];
	const groups = (["bloquant", "important", "suggestion"] as const).map((severity) => ({
		severity,
		items: round.findings.filter((finding) => severityOf(finding.severity) === severity),
	}));

	return (
		<section className="flex flex-col gap-3 rounded-[var(--radius-panel)] bg-surface p-4 shadow-[var(--shadow-card)]">
			<header className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">{t("reviewPanel.title")}</span>
				<span className={clsx("inline-flex h-6 items-center gap-1.5 rounded-lg px-2 text-[12px] font-semibold", verdict.tone)}>
					<verdict.icon size={13} />
					{t(`reviewPanel.verdict.${verdictKey}`)}
				</span>
				{review.rounds.length > 1 ? (
					<div className="flex items-center gap-0.5 rounded-lg bg-raised p-0.5">
						{review.rounds.map((entry, index) => (
							<button
								key={entry.number}
								type="button"
								onClick={() => setShown(index)}
								className={clsx(
									"focus-ring h-6 rounded-md px-2 text-[11px] font-medium",
									index === shown ? "bg-surface text-ink shadow-card" : "text-ink-muted hover:text-ink",
								)}
							>
								{entry.kind === "verification"
									? t("reviewPanel.roundVerification", { number: entry.number })
									: t("reviewPanel.round", { number: entry.number })}
							</button>
						))}
					</div>
				) : null}
				<span className="text-[11px] text-ink-faint">
					{fromIso(round.at)} · {t("reviewPanel.commit")} <span className="font-mono">{round.headSha.slice(0, 7) || "?"}</span>
				</span>
				<span className="ml-auto flex items-center gap-1">
					{moved ? (
						<Button size="sm" variant="solid" icon={RefreshCw} onClick={onRecheck} loading={busy}>
							{t("reviewPanel.recheck")}
						</Button>
					) : (
						<Button size="sm" icon={RefreshCw} onClick={onReview} loading={busy} title={t("reviewPanel.reviewAgainHint")}>
							{t("reviewPanel.reviewAgain")}
						</Button>
					)}
				</span>
			</header>

			{moved ? (
				<p className="flex items-center gap-2 rounded-xl bg-accent-dim px-3 py-2 text-[12px] text-ink">
					<RefreshCw size={13} className="shrink-0 text-accent" />
					{t("reviewPanel.pushedSince", { author: review.author || t("reviewPanel.theAuthor") })}
				</p>
			) : null}

			{round.summary ? (
				<div className="rounded-xl bg-raised px-3.5 py-3">
					<p className="mb-1 text-[11px] font-semibold tracking-[0.04em] text-ink-muted uppercase">{t("reviewPanel.understand")}</p>
					<div className="text-[12.5px] leading-relaxed text-ink">
						<Markdown source={round.summary} cwd={cwd} />
					</div>
				</div>
			) : null}

			{round.checks.length > 0 ? (
				<div className="flex flex-col gap-1">
					<p className="text-[11px] font-semibold tracking-[0.04em] text-ink-muted uppercase">{t("reviewPanel.previousPoints")}</p>
					{round.checks.map((check) => {
						const status = check.status in CHECK ? check.status : "partiel";
						const look = CHECK[status];
						const finding = everyFinding.get(check.id);
						return (
							<div key={check.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:bg-raised">
								<look.icon size={13} className={clsx("mt-0.5 shrink-0", look.tone)} />
								<span className="shrink-0 font-mono text-[11px] text-ink-faint">{check.id}</span>
								<span className="min-w-0 flex-1 text-ink">
									{finding ? finding.problem : t("reviewPanel.earlierPoint")}
									{check.note ? <span className="text-ink-muted"> — {check.note}</span> : null}
								</span>
								<span className={clsx("shrink-0 text-[11px] font-medium", look.tone)}>{t(`reviewPanel.check.${status}`)}</span>
							</div>
						);
					})}
				</div>
			) : null}

			{round.findings.length === 0 ? (
				<p className="rounded-xl bg-success/8 px-3 py-2.5 text-[12.5px] text-success">
					{t("reviewPanel.nothing")}
				</p>
			) : (
				groups
					.filter((group) => group.items.length > 0)
					.map((group) => (
						<div key={group.severity} className="flex flex-col gap-2">
							<p className={clsx("flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.04em] uppercase", SEVERITY[group.severity].text)}>
								{t(`reviewPanel.severity.${group.severity}`)}
								<span className="font-mono">{group.items.length}</span>
							</p>
							{group.items.map((finding) => (
								<FindingCard
									key={finding.id}
									finding={finding}
									review={review}
									cwd={cwd}
									posted={review.posted.includes(finding.id)}
								/>
							))}
						</div>
					))
			)}
		</section>
	);
}

function FindingCard({
	finding,
	review,
	cwd,
	posted,
}: {
	finding: ReviewFinding;
	review: Review;
	cwd: string;
	posted: boolean;
}) {
	const { t } = useTranslation("components2");
	const viewer = useFileViewer();
	const look = SEVERITY[severityOf(finding.severity)];
	const lines = span(finding.lines);
	const [link, setLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [done, setDone] = useState(posted);
	useEffect(() => setDone(posted), [posted]);

	useEffect(() => {
		if (!review.url || !finding.file) return;
		let alive = true;
		void diffAnchor(finding.file).then((hash) => {
			if (!alive) return;
			const at = span(finding.lines);
			const range = at ? (at.start === at.end ? `R${at.start}` : `R${at.start}-R${at.end}`) : "";
			setLink(`${review.url}/files#diff-${hash}${range}`);
		});
		return () => {
			alive = false;
		};
	}, [review.url, finding.file, finding.lines]);

	const copy = () => {
		void navigator.clipboard.writeText(finding.comment).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		});
	};
	const toggle = () => {
		const next = !done;
		setDone(next);
		void api.reviews.posted(review.number, finding.id, next).catch(() => setDone(!next));
	};

	return (
		<article className={clsx("relative overflow-hidden rounded-xl bg-base transition-opacity", done && "opacity-55")}>
			<span className={clsx("absolute inset-y-0 left-0 w-1", look.bar)} />
			<div className="flex flex-col gap-2 py-3 pr-3.5 pl-4">
				<div className="flex items-center gap-2">
					<look.icon size={13} className={clsx("shrink-0", look.text)} />
					<span className="font-mono text-[10.5px] text-ink-faint">{finding.id}</span>
					<button
						type="button"
						onClick={() => viewer?.open(`${cwd.replace(/\/$/, "")}/${finding.file}`, lines?.start)}
						className="focus-ring flex min-w-0 items-center gap-1 rounded font-mono text-[11.5px] text-ink hover:underline"
						title={t("reviewPanel.openFileAtLine")}
					>
						<FileCode2 size={12} className="shrink-0 text-ink-faint" />
						<span className="truncate">{finding.file}</span>
						{finding.lines ? <span className="shrink-0 text-ink-muted">:{finding.lines}</span> : null}
					</button>
					<span className="ml-auto flex shrink-0 items-center gap-1">
						{link ? (
							<Button
								size="sm"
								icon={ArrowUpRight}
								onClick={() => void api.system.openUrl(link).catch(() => undefined)}
								title={t("reviewPanel.openOnGitHub")}
							>
								GitHub
							</Button>
						) : null}
						<label className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[11px] text-ink-muted hover:text-ink">
							<input type="checkbox" checked={done} onChange={toggle} className="accent-[var(--color-accent)]" />
							{t("reviewPanel.posted")}
						</label>
					</span>
				</div>
				<p className="text-[12.5px] leading-relaxed text-ink">{finding.problem}</p>
				{finding.fix ? (
					<p className="text-[12px] leading-relaxed text-ink-muted">
						<span className="font-semibold text-ink">{t("reviewPanel.fix")} · </span>
						{finding.fix}
					</p>
				) : null}
				{finding.comment ? (
					<div className={clsx("flex items-start gap-2 rounded-lg px-3 py-2", look.soft)}>
						<p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink">{t("reviewPanel.quoted", { text: finding.comment })}</p>
						<Button size="sm" icon={copied ? Check : Copy} onClick={copy} title={t("reviewPanel.copyComment")}>
							{copied ? t("reviewPanel.copied") : t("reviewPanel.copy")}
						</Button>
					</div>
				) : null}
			</div>
		</article>
	);
}

export { VERDICT };
