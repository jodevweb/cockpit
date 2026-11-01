import clsx from "clsx";
import { ChevronDown, ChevronRight, FlaskConical } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Turn } from "@/app/agents";
import { FilmStrip } from "@/components/Film";
import { Illustration } from "@/components/Illustration";
import { LocalImage } from "@/components/LocalImage";
import { openLightbox } from "@/components/Lightbox";
import { Markdown } from "@/components/Markdown";
import { MediaThumb } from "@/components/MediaThumb";
import { locale } from "@/i18n";
import { delivered } from "@/lib/delivered";
import { summarize, type Episode } from "@/lib/episodes";
import { clock, filmOf, firstSentence } from "@/lib/film";
import { illustrationsOf } from "@/lib/illustrations";
import { localFileUrl } from "@/lib/localFile";
import { askToKeep, proofTestOf, type ProofTest } from "@/lib/proof";
import { seenMedia, stageOf, type Media } from "@/lib/media";

/**
 * La réponse d'un agent, en planche : ce qui est vrai maintenant en une phrase,
 * puis ce qui se voit, puis ce que le dépôt constate, et le texte en dernier,
 * replié.
 *
 * Mesuré en octobre 2026 : 592 conclusions, 1 800 signes de texte en médiane,
 * 4 % portant un schéma. Le schéma de fin de course restait un rajout sous un
 * mur de texte. Ici l'image devient la réponse, et le texte sa légende.
 *
 * Chaque image dit d'où elle vient — filmée par le cockpit, capturée par
 * l'agent, constatée dans git, dite par l'agent — comme le schéma Mermaid le
 * disait déjà. Une réponse sans rien à montrer reste du texte : on ne fabrique
 * pas d'image pour remplir.
 */

/** Au-delà, le texte se replie derrière la planche. */
const FOLD = 600;

function resolve(path: string, cwd: string): string {
	return path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
}

/** Le texte sans sa première phrase, déjà dite en tête. */
function rest(text: string, head: string): string {
	const trimmed = text.trim();
	const index = trimmed.indexOf(head.replace(/…$/, ""));
	if (index !== 0) return trimmed;
	return trimmed.slice(head.replace(/…$/, "").length).trim();
}

export interface PlancheData {
	head: string;
	avant: Media | null;
	apres: Media | null;
	others: Media[];
	illustrations: ReturnType<typeof illustrationsOf>;
	film: ReturnType<typeof filmOf>;
	changes: ReturnType<typeof summarize>["changes"];
	/** La recette filmée par le cockpit, quand l'agent a piloté le navigateur. */
	video: Turn["video"] | null;
	test: ProofTest | null;
	/** Rien à montrer : la réponse reste un texte. */
	empty: boolean;
}

export function plancheOf(episode: Episode, answer: Turn, cwd: string): PlancheData {
	const summary = summarize(episode);
	const shipped = delivered(episode, answer, cwd);
	// Ce que l'agent a produit d'abord (ses captures nommées), puis ce qu'il a
	// vu passer : une capture d'écran renvoyée par le navigateur vaut preuve.
	const media = new Map<string, Media>();
	for (const item of shipped.media) media.set(item.key, item);
	for (const item of seenMedia(episode)) if (!media.has(item.key)) media.set(item.key, item);
	const all = [...media.values()];
	const avant = all.find((item) => stageOf(item) === "avant") ?? null;
	const apres = all.find((item) => stageOf(item) === "après") ?? null;
	const illustrations = illustrationsOf(episode.turns);
	// Une capture déjà annotée par l'agent ne se répète pas en vignette nue.
	const annotated = new Set(
		illustrations.flatMap((item) => (item.genre === "capture" ? [resolve(item.image, cwd)] : [])),
	);
	// Les captures vues au passage ne servent que s'il n'y a pas déjà une
	// preuve en tête : un avant/après ou une capture annotée les répète.
	const proven = (avant && apres) || annotated.size > 0;
	const others = all
		.filter((item) => item !== avant && item !== apres && !(item.path && annotated.has(item.path)))
		.filter((item) => !proven || !item.src)
		.slice(0, 6);
	const film = filmOf(episode, cwd);
	const head = firstSentence(answer.text, 220);
	const video = [...episode.turns].reverse().find((turn) => turn.video)?.video ?? null;
	const test = proofTestOf(episode);
	const empty =
		!avant && !apres && !video && !test && others.length === 0 && illustrations.length === 0 && film.frames.length < 3;
	return { head, avant, apres, others, illustrations, film, changes: summary.changes, video, test, empty };
}

/** Une image en entier dans son cadre : l'avant et l'après doivent tomber au même pixel. */
function Whole({ media }: { media: Media }) {
	if (media.src) return <img src={media.src} alt={media.label} className="h-full w-full object-contain" />;
	if (media.path) return <LocalImage path={media.path} alt={media.label} className="h-full w-full object-contain" />;
	return null;
}

/** Le balayage d'arrivée : l'avant s'ouvre puis se referme, pour dire qu'il se glisse. */
const SWEEP: Array<[number, number]> = [
	[0, 50],
	[0.35, 84],
	[0.7, 16],
	[1, 50],
];

/** L'avant et l'après superposés : on glisse pour passer de l'un à l'autre. */
export function BeforeAfter({ avant, apres }: { avant: Media; apres: Media }) {
	const { t: tr } = useTranslation("components3");
	const [split, setSplit] = useState(50);
	const touched = useRef(false);

	useEffect(() => {
		const duration = 2600;
		const started = performance.now();
		let frame = 0;
		const step = (now: number) => {
			if (touched.current) return;
			const t = Math.min(1, (now - started) / duration);
			const index = SWEEP.findIndex(([at]) => at >= t);
			const [t1, v1] = SWEEP[Math.max(0, index - 1)];
			const [t2, v2] = SWEEP[Math.max(0, index)];
			const local = t2 === t1 ? 1 : (t - t1) / (t2 - t1);
			// Adouci aux deux bouts : un balayage linéaire paraît mécanique.
			const eased = local < 0.5 ? 2 * local * local : 1 - (-2 * local + 2) ** 2 / 2;
			setSplit(v1 + (v2 - v1) * eased);
			if (t < 1) frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [avant.key, apres.key]);

	return (
		<figure className="m-0 flex min-w-0 flex-col gap-1.5">
			<div className="relative h-72 overflow-hidden rounded-xl bg-raised shadow-card">
				<button
					type="button"
					title={tr("planche.enlarge")}
					onClick={() => openLightbox([avant, apres], 1)}
					className="absolute inset-0 block"
				>
					<Whole media={apres} />
				</button>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0"
					style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
				>
					<Whole media={avant} />
				</div>
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 w-0.5 bg-critical"
					style={{ left: `${split}%` }}
				/>
				<span className="pointer-events-none absolute top-2 left-2 rounded-md bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-critical shadow-card">
					{tr("planche.before")}
				</span>
				<span className="pointer-events-none absolute top-2 right-2 rounded-md bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-accent shadow-card">
					{tr("planche.after")}
				</span>
			</div>
			<label className="flex items-center gap-2 text-[11px] text-ink-muted">
				<span className="shrink-0">{tr("planche.slide")}</span>
				<input
					type="range"
					min={0}
					max={100}
					value={split}
					onChange={(event) => {
						touched.current = true;
						setSplit(Number(event.target.value));
					}}
					className="min-w-0 flex-1 accent-[var(--accent)]"
				/>
			</label>
		</figure>
	);
}

/** La recette filmée par le cockpit, avec ses chapitres : les pages traversées. */
function ProofVideo({ video }: { video: NonNullable<Turn["video"]> }) {
	const { t } = useTranslation("components3");
	const player = useRef<HTMLVideoElement>(null);
	return (
		<figure className="m-0 flex min-w-0 flex-col gap-2">
			<div className="relative overflow-hidden rounded-xl bg-[#0f1315] shadow-card">
				<video
					ref={player}
					src={localFileUrl(video.path)}
					controls
					muted
					loop
					playsInline
					autoPlay
					className="block max-h-80 w-full bg-[#0f1315] object-contain"
				/>
				<span className="pointer-events-none absolute top-2 left-2 rounded-md bg-[rgba(43,179,163,0.22)] px-2 py-0.5 text-[10.5px] font-semibold text-[#62d6c6]">
					{t("planche.filmed", { seconds: Math.round(video.seconds) })}
				</span>
			</div>
			{video.chapters.length > 1 ? (
				<div className="flex flex-wrap gap-1.5">
					{video.chapters.map((chapter) => (
						<button
							key={`${chapter.at}-${chapter.url}`}
							type="button"
							title={chapter.url}
							onClick={() => {
								if (!player.current) return;
								player.current.currentTime = chapter.at;
								void player.current.play();
							}}
							className="focus-ring flex max-w-[16rem] items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
						>
							<span className="font-mono text-accent">{clock(chapter.at * 1000)}</span>
							<span className="truncate">{pageName(chapter.url)}</span>
						</button>
					))}
				</div>
			) : null}
		</figure>
	);
}

/** Une adresse dite comme une page : son chemin, sans le serveur. */
function pageName(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.pathname === "/" ? parsed.host : parsed.pathname;
	} catch {
		return url;
	}
}

/** Le test tiré de la recette, proposé : copié, ou confié à l'agent pour qu'il le range. */
function ProofTestBlock({ test, onAsk }: { test: ProofTest; onAsk?: (text: string) => void }) {
	const { t } = useTranslation("components3");
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	return (
		<section className="flex flex-col gap-2 rounded-xl bg-surface p-3 shadow-card">
			<div className="flex flex-wrap items-center gap-2">
				<FlaskConical size={13} className="shrink-0 text-accent" />
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					className="focus-ring flex items-center gap-1 rounded text-[12.5px] font-semibold text-ink"
				>
					{t("planche.test.title")}
					{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				</button>
				<span className="text-[11px] text-ink-muted">
					{t("planche.test.steps", { count: test.steps })}
					{test.skipped > 0 ? ` · ${t("planche.test.skipped", { count: test.skipped })}` : ""}
				</span>
				<span className="flex-1" />
				<button
					type="button"
					onClick={() => {
						void navigator.clipboard?.writeText(test.code).then(() => setCopied(true));
					}}
					className="focus-ring rounded-md bg-raised px-2.5 py-1 text-[11.5px] text-ink hover:bg-hover"
				>
					{copied ? t("planche.test.copied") : t("planche.test.copy")}
				</button>
				{onAsk ? (
					<button
						type="button"
						onClick={() => onAsk(askToKeep(test))}
						className="focus-ring rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-accent-ink"
					>
						{t("planche.test.ask")}
					</button>
				) : null}
			</div>
			{open ? (
				<pre className="m-0 max-h-72 overflow-auto rounded-lg bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink">
					{test.code}
				</pre>
			) : null}
		</section>
	);
}

/** Ce que git constate : une tuile par fichier, large comme son volume. */
function Constat({ changes }: { changes: PlancheData["changes"] }) {
	const { t } = useTranslation("components3");
	if (changes.length === 0) return null;
	const added = changes.reduce((sum, change) => sum + change.added, 0);
	const removed = changes.reduce((sum, change) => sum + change.removed, 0);
	const max = Math.max(...changes.map((change) => change.added + change.removed), 1);
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
			<span className="text-[10.5px] font-semibold tracking-[0.05em] text-ink-muted uppercase">{t("planche.observed")}</span>
			<span className="flex items-center gap-[3px]">
				{changes.slice(0, 18).map((change) => (
					<span
						key={change.path}
						title={`${change.path} · +${change.added} −${change.removed}`}
						className={clsx("h-3.5 rounded-[3px]", change.removed > change.added ? "bg-critical/55" : change.removed === 0 ? "bg-success/60" : "bg-warning/60")}
						style={{ width: `${8 + ((change.added + change.removed) / max) * 46}px` }}
					/>
				))}
			</span>
			<span className="font-mono text-[11px] text-ink-muted">
				{t("planche.files", { count: changes.length })} · +{added} −{removed}
			</span>
		</div>
	);
}

export const Planche = memo(function Planche({
	episode,
	answer,
	cwd,
	onFilm,
	onAsk,
}: {
	episode: Episode;
	answer: Turn;
	cwd: string;
	/** Ouvre l'onglet Film, sur cette image. */
	onFilm?: (index: number) => void;
	/** Écrit à l'agent : faire ranger le test tiré de sa recette. */
	onAsk?: (text: string) => void;
}) {
	const { t } = useTranslation("components3");
	const data = useMemo(() => plancheOf(episode, answer, cwd), [episode, answer, cwd]);
	const body = rest(answer.text, data.head);
	const [open, setOpen] = useState(body.length <= FOLD);

	return (
		<article className="flex max-w-[64rem] flex-col gap-3.5">
			<h3 className="m-0 text-[15.5px] leading-snug font-semibold text-ink">{data.head}</h3>

			{data.video || (data.avant && data.apres) ? (
				<div className={clsx("grid gap-3", data.video && data.avant && data.apres ? "xl:grid-cols-2" : "")}>
					{data.video ? <ProofVideo video={data.video} /> : null}
					{data.avant && data.apres ? <BeforeAfter avant={data.avant} apres={data.apres} /> : null}
				</div>
			) : null}

			{data.test ? <ProofTestBlock test={data.test} onAsk={onAsk} /> : null}

			{data.illustrations.length > 0 ? (
				<div className={clsx("grid items-start gap-3", data.illustrations.length > 1 ? "lg:grid-cols-2" : "")}>
					{data.illustrations.map((item) => (
						<Illustration key={item.key} item={item} cwd={cwd} />
					))}
				</div>
			) : null}

			{data.others.length > 0 || (!data.apres && data.avant) || (!data.avant && data.apres) ? (
				<div className="flex flex-wrap gap-2">
					{[data.avant && !data.apres ? data.avant : null, data.apres && !data.avant ? data.apres : null, ...data.others]
						.filter((item): item is Media => item !== null)
						.map((item, index, list) => (
							<button
								key={item.key}
								type="button"
								title={item.label}
								onClick={() => openLightbox(list, index)}
								className="focus-ring h-28 w-44 overflow-hidden rounded-lg bg-raised shadow-card"
							>
								{item.path && item.kind === "image" ? (
									<LocalImage path={item.path} alt={item.label} className="h-full w-full object-cover object-top" />
								) : (
									<MediaThumb media={item} width={240} className="h-full w-full" />
								)}
							</button>
						))}
				</div>
			) : null}

			<FilmStrip film={data.film} onOpen={onFilm} />

			<Constat changes={data.changes} />

			{body ? (
				open ? (
					<div className="flex flex-col gap-1">
						<Markdown source={body} cwd={cwd} />
						{body.length > FOLD ? (
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="focus-ring flex items-center gap-1 self-start rounded text-[11.5px] font-medium text-ink-faint hover:text-ink"
							>
								<ChevronDown size={12} /> {t("planche.foldDetail")}
							</button>
						) : null}
					</div>
				) : (
					<button
						type="button"
						onClick={() => setOpen(true)}
						className="focus-ring flex items-center gap-1 self-start rounded text-[12px] font-semibold text-accent hover:text-accent-soft"
					>
						<ChevronRight size={12} />{" "}
						{t("planche.readDetail", { count: body.length, chars: body.length.toLocaleString(locale()) })}
					</button>
				)
			) : null}
		</article>
	);
});
