import clsx from "clsx";
import { ChevronLeft, ChevronRight, Clapperboard, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentActions, useAgentRuns, type AgentRun, type Turn } from "@/app/agents";
import { useDecisions } from "@/app/decisions";
import { useCockpit } from "@/app/store";
import { FrameArt } from "@/components/Film";
import { Illustration } from "@/components/Illustration";
import { LocalImage } from "@/components/LocalImage";
import { MediaThumb } from "@/components/MediaThumb";
import { plancheOf, type PlancheData } from "@/components/Planche";
import { Button } from "@/components/ui";
import { delivered } from "@/lib/delivered";
import { episodes, summarize, type Episode } from "@/lib/episodes";
import { clock, type Frame } from "@/lib/film";
import { localFileUrl } from "@/lib/localFile";
import { say, silence } from "@/lib/narrator";
import { markRecapSeen } from "@/lib/recapSeen";
import { usePersistentState } from "@/lib/useAsync";
import { t } from "@/i18n";

/**
 * La journée en images : ce que chaque agent a fait, à regarder plutôt qu'à
 * lire.
 *
 * On revient d'une réunion, quatre agents ont travaillé : il fallait ouvrir
 * quatre conversations et lire quatre conclusions. Ici chaque tour terminé
 * devient une histoire courte — sa phrase de tête, puis ce qu'il montre : la
 * recette filmée, l'avant et l'après, les images qu'il a décrites, le film de
 * son tour — jouée en grand, l'une après l'autre, et dite à voix haute si on
 * le veut.
 *
 * Seules les conversations ouvertes dans le cockpit y figurent : c'est ce
 * qu'on a sous la main, et ce qu'on peut reprendre d'un clic.
 */

type Period = "1h" | "3h" | "day";

const PERIODS: Array<[Period, number]> = [
	["1h", 3_600_000],
	["3h", 3 * 3_600_000],
	["day", 0],
];

function since(period: Period): number {
	if (period === "day") {
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		return start.getTime();
	}
	return Date.now() - (PERIODS.find(([id]) => id === period)?.[1] ?? 0);
}

/** Une image d'une histoire : un instant du film, ou ce que la planche montre. */
type Slide =
	| { kind: "video"; key: string; path: string; caption: string }
	| { kind: "media"; key: string; media: NonNullable<PlancheData["apres"]>; caption: string }
	| { kind: "illustration"; key: string; item: PlancheData["illustrations"][number]; caption: string; cwd: string }
	| { kind: "frame"; key: string; frame: Frame; caption: string };

interface Story {
	key: string;
	run: AgentRun;
	episode: Episode;
	answer: Turn;
	head: string;
	at: number;
	duration: number | null;
	status: { label: string; tone: "success" | "warning" | "neutral"; pr?: boolean };
	slides: Slide[];
}

const MAX_SLIDES = 7;

/** Ce que le film dit de plus utile quand il faut choisir. */
const FRAME_RANK: Record<Frame["kind"], number> = {
	test: 0,
	deliver: 1,
	see: 2,
	edit: 3,
	fix: 4,
	think: 5,
	read: 6,
};

function storiesOf(runs: AgentRun[], from: number): Story[] {
	const found: Story[] = [];
	for (const run of runs) {
		const list = episodes(run.turns);
		list.forEach((episode, index) => {
			if (index === list.length - 1 && run.thinking) return;
			const summary = summarize(episode);
			const answer = summary.answer;
			if (!answer || (answer.at ?? 0) < from) return;
			const data = plancheOf(episode, answer, run.cwd);
			// Une réponse de conversation (« d'accord, je m'arrête là ») n'a rien
			// à raconter : ni image, ni changement.
			if (data.empty && summary.changes.length === 0) return;
			const shipped = delivered(episode, answer, run.cwd);
			const slides: Slide[] = [];
			if (data.video) slides.push({ kind: "video", key: "video", path: data.video.path, caption: t("views:recap.caption.video") });
			if (data.apres) slides.push({ kind: "media", key: "apres", media: data.apres, caption: t("views:recap.caption.after") });
			if (data.avant) slides.unshift({ kind: "media", key: "avant", media: data.avant, caption: t("views:recap.caption.before") });
			for (const item of data.illustrations) slides.push({ kind: "illustration", key: item.key, item, caption: item.titre, cwd: run.cwd });
			// Sept images au plus : une histoire se regarde en une vingtaine de
			// secondes. Ce qui prouve passe d'abord, puis les moments du film qui
			// disent le plus — les tests, la livraison, le changement.
			const room = Math.max(0, MAX_SLIDES - slides.length);
			const frames = data.film.frames
				.filter((frame) => !(frame.kind === "see" && (data.avant || data.apres)))
				.map((frame, order) => ({ frame, order, rank: FRAME_RANK[frame.kind] }))
				.sort((x, y) => x.rank - y.rank)
				.slice(0, room)
				.sort((x, y) => x.order - y.order);
			for (const { frame } of frames) slides.push({ kind: "frame", key: frame.key, frame, caption: frame.caption });
			slides.splice(MAX_SLIDES);
			const review = shipped.reviews.at(-1);
			const status = summary.asks
				? { label: t("views:recap.status.waiting"), tone: "warning" as const }
				: review
					? { label: t("views:recap.status.prReady", { label: review.label }), tone: "success" as const, pr: true }
					: summary.testsFail === false
						? { label: t("views:recap.status.testsGreen"), tone: "success" as const }
						: summary.testsFail
							? { label: t("views:recap.status.testsRed"), tone: "warning" as const }
							: { label: t("views:recap.status.handedBack"), tone: "neutral" as const };
			found.push({
				key: `${run.id}-${index}`,
				run,
				episode,
				answer,
				head: data.head,
				at: answer.at ?? 0,
				duration: data.film.duration,
				status,
				slides,
			});
		});
	}
	return found.sort((a, b) => b.at - a.at);
}

function Cover({ story }: { story: Story }) {
	const first = story.slides.find((slide) => slide.kind !== "frame") ?? story.slides[0];
	if (!first) return <div className="h-full bg-raised" />;
	return <SlideArt slide={first} compact />;
}

function SlideArt({ slide, compact }: { slide: Slide; compact?: boolean }) {
	if (slide.kind === "video") {
		return (
			<video
				src={localFileUrl(slide.path)}
				muted
				loop
				playsInline
				autoPlay={!compact}
				preload="metadata"
				className="h-full w-full bg-[#0f1315] object-contain"
			/>
		);
	}
	if (slide.kind === "media") {
		return slide.media.path ? (
			<LocalImage path={slide.media.path} alt={slide.caption} className="h-full w-full bg-raised object-contain" />
		) : (
			<MediaThumb media={slide.media} width={compact ? 320 : 900} className="h-full w-full object-contain" />
		);
	}
	if (slide.kind === "illustration") {
		return (
			<div className={clsx("h-full overflow-hidden bg-raised", compact ? "p-2 [zoom:0.6]" : "overflow-y-auto p-6")}>
				<Illustration item={slide.item} cwd={slide.cwd} />
			</div>
		);
	}
	return <FrameArt frame={slide.frame} large={!compact} />;
}

const TONES = {
	success: "bg-success/12 text-success",
	warning: "bg-warning/12 text-warning",
	neutral: "bg-raised text-ink-muted",
};

export function RecapView() {
	const { t } = useTranslation("views");
	const { runs } = useAgentRuns();
	const decisions = useDecisions();
	const { go } = useCockpit();
	const [period, setPeriod] = usePersistentState<Period>("recap.period", "3h");
	const [playing, setPlaying] = useState<number | null>(null);
	const stories = useMemo(() => storiesOf(runs, since(period)), [runs, period]);
	// L'avoir ouvert, c'est l'avoir vu : l'onglet du haut repart de zéro.
	useEffect(() => {
		markRecapSeen();
		return markRecapSeen;
	}, []);
	const agents = new Set(stories.map((story) => story.run.id)).size;
	const prs = stories.filter((story) => story.status.pr).length;

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-5 pb-4">
				<div className="flex min-w-0 flex-col">
					<h1 className="m-0 text-[20px] font-semibold text-ink">{t("recap.title")}</h1>
					<span className="text-[13px] text-ink-muted">
						{stories.length === 0
							? t("recap.noTurns")
							: [
									t("recap.turns", { count: stories.length }),
									t("recap.agents", { count: agents }),
									...(prs > 0 ? [t("recap.prsReady", { count: prs })] : []),
								].join(" · ")}
						{decisions.length > 0 ? (
							<>
								{" · "}
								<button type="button" onClick={() => go("decisions")} className="focus-ring rounded font-semibold text-warning hover:underline">
									{t("recap.decisionsWaiting", { count: decisions.length })}
								</button>
							</>
						) : null}
					</span>
				</div>
				<span className="flex-1" />
				<div className="flex rounded-lg bg-raised p-0.5">
					{PERIODS.map(([id]) => (
						<button
							key={id}
							type="button"
							onClick={() => setPeriod(id)}
							className={clsx(
								"focus-ring h-7 rounded-md px-3 text-[12px]",
								period === id ? "bg-surface font-medium text-ink shadow-card" : "text-ink-muted hover:text-ink",
							)}
						>
							{t(`recap.period.${id}`)}
						</button>
					))}
				</div>
				<Button variant="solid" icon={Play} disabled={stories.length === 0} onClick={() => setPlaying(0)}>
					{t("recap.watchAll")}
				</Button>
			</header>

			{stories.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
					<span className="grid size-12 place-items-center rounded-2xl bg-accent-dim text-accent">
						<Clapperboard size={20} />
					</span>
					<p className="max-w-md text-[13px] leading-relaxed text-ink-muted">
						{t("recap.empty")}
					</p>
				</div>
			) : (
				<div className="grid items-start gap-4 px-6 pb-6 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
					{stories.map((story, index) => (
						<button
							key={story.key}
							type="button"
							onClick={() => setPlaying(index)}
							className="focus-ring flex flex-col overflow-hidden rounded-2xl bg-surface text-left shadow-card transition-transform hover:-translate-y-0.5"
						>
							<span className="relative block h-44 overflow-hidden bg-raised">
								<Cover story={story} />
								<span className="absolute right-2 bottom-2 flex items-center gap-1 rounded-md bg-[#0f1315]/80 px-2 py-0.5 font-mono text-[11px] text-[#eef3f4]">
									<Play size={10} /> {t("recap.images", { count: story.slides.length })}
								</span>
							</span>
							<span className="flex flex-col gap-1.5 p-3.5">
								<span className="flex items-center gap-2 text-[11.5px] text-ink-muted">
									<span className="min-w-0 flex-1 truncate">{story.run.label}</span>
									{story.duration ? <span className="font-mono">{clock(story.duration)}</span> : null}
								</span>
								<span className="line-clamp-3 text-[14px] leading-snug font-semibold text-ink">{story.head}</span>
								<span className={clsx("self-start rounded-md px-2 py-0.5 text-[11px] font-semibold", TONES[story.status.tone])}>
									{story.status.label}
								</span>
							</span>
						</button>
					))}
				</div>
			)}

			<AnimatePresence>
				{playing !== null && stories[playing] ? (
					<Player stories={stories} start={playing} onClose={() => setPlaying(null)} />
				) : null}
			</AnimatePresence>
		</div>
	);
}

const SLIDE_SECONDS = 3.2;

/**
 * Les histoires en plein écran, comme on les fait défiler sur un téléphone :
 * une barre par image en haut, la phrase en légende, et la voix si on la veut.
 */
function Player({ stories, start, onClose }: { stories: Story[]; start: number; onClose: () => void }) {
	const { t } = useTranslation("views");
	const { show } = useAgentActions();
	const [storyIndex, setStoryIndex] = useState(start);
	const [slideIndex, setSlideIndex] = useState(-1);
	const [paused, setPaused] = useState(false);
	const [voice, setVoice] = usePersistentState("recap.voice", false);
	const story = stories[storyIndex];
	// L'image -1 est la carte de titre : la phrase de tête, seule.
	const count = story.slides.length;

	const next = () => {
		if (slideIndex < count - 1) setSlideIndex(slideIndex + 1);
		else if (storyIndex < stories.length - 1) {
			setStoryIndex(storyIndex + 1);
			setSlideIndex(-1);
		} else onClose();
	};
	const previous = () => {
		if (slideIndex > -1) setSlideIndex(slideIndex - 1);
		else if (storyIndex > 0) {
			setStoryIndex(storyIndex - 1);
			setSlideIndex(-1);
		}
	};

	useEffect(() => {
		if (paused) return;
		const timer = window.setTimeout(next, (slideIndex === -1 ? 2.6 : SLIDE_SECONDS) * 1000);
		return () => window.clearTimeout(timer);
	});

	// La voix dit la phrase de tête de chaque histoire, à son arrivée.
	useEffect(() => {
		if (!voice) return;
		silence();
		say([{ text: `${story.run.label}. ${story.head}`, keep: true }]);
	}, [voice, story]);
	useEffect(() => () => silence(), []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
			else if (event.key === "ArrowRight") next();
			else if (event.key === "ArrowLeft") previous();
			else if (event.key === " ") {
				event.preventDefault();
				setPaused((value) => !value);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const slide = slideIndex >= 0 ? story.slides[slideIndex] : null;

	return (
		<motion.div
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			className="fixed inset-0 z-50 flex items-center justify-center bg-[#06090a]/85 p-6"
			onClick={onClose}
		>
			<div
				className="relative flex h-full max-h-[760px] w-full max-w-[1040px] flex-col overflow-hidden rounded-3xl bg-[#0f1315] text-[#eef3f4] shadow-pop"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex gap-1 px-5 pt-4">
					{[-1, ...story.slides.map((_, index) => index)].map((index) => (
						<span key={index} className="h-1 flex-1 overflow-hidden rounded-full bg-[#313b40]">
							<span
								className={clsx("block h-full bg-[#eef3f4]", index === slideIndex && !paused ? "animate-[film-fill_3.2s_linear]" : "")}
								style={{ width: index < slideIndex ? "100%" : index === slideIndex ? (paused ? "100%" : undefined) : "0%" }}
							/>
						</span>
					))}
				</div>
				<div className="flex items-center gap-2 px-5 pt-3 text-[12.5px] text-[#aab6ba]">
					<span className="min-w-0 flex-1 truncate">
						<b className="text-[#eef3f4]">{story.run.label}</b> · {t("recap.player.story", { index: storyIndex + 1, total: stories.length })}
					</span>
					<button
						type="button"
						aria-label={voice ? t("recap.player.voiceOff") : t("recap.player.voiceOn")}
						title={voice ? t("recap.player.voiceOff") : t("recap.player.voiceOn")}
						onClick={() => setVoice(!voice)}
						className="focus-ring grid size-8 place-items-center rounded-full hover:bg-[#283236]"
					>
						{voice ? <Volume2 size={15} /> : <VolumeX size={15} />}
					</button>
					<button
						type="button"
						aria-label={paused ? t("recap.player.resume") : t("recap.player.pause")}
						onClick={() => setPaused((value) => !value)}
						className="focus-ring grid size-8 place-items-center rounded-full hover:bg-[#283236]"
					>
						{paused ? <Play size={15} /> : <Pause size={15} />}
					</button>
					<button type="button" aria-label={t("recap.player.close")} onClick={onClose} className="focus-ring grid size-8 place-items-center rounded-full hover:bg-[#283236]">
						<X size={16} />
					</button>
				</div>

				<div className="relative min-h-0 flex-1 px-5 py-4">
					<AnimatePresence mode="wait">
						<motion.div
							key={`${storyIndex}:${slideIndex}`}
							initial={{ opacity: 0, scale: 0.985 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.25 }}
							className="h-full overflow-hidden rounded-2xl"
						>
							{slide ? (
								<div className="h-full overflow-hidden rounded-2xl bg-surface text-ink">
									<SlideArt slide={slide} />
								</div>
							) : (
								<div className="flex h-full flex-col items-center justify-center gap-4 px-10 text-center">
									<span className={clsx("rounded-md px-2.5 py-0.5 text-[12px] font-semibold", TONES[story.status.tone])}>
										{story.status.label}
									</span>
									<p className="m-0 max-w-3xl text-[28px] leading-tight font-semibold">{story.head}</p>
									{story.duration ? <span className="font-mono text-[12px] text-[#aab6ba]">{t("recap.player.workTime", { duration: clock(story.duration) })}</span> : null}
								</div>
							)}
						</motion.div>
					</AnimatePresence>
					<button
						type="button"
						aria-label={t("recap.player.previous")}
						onClick={previous}
						className="focus-ring absolute top-1/2 left-1 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-[#283236]/80 hover:bg-[#283236]"
					>
						<ChevronLeft size={18} />
					</button>
					<button
						type="button"
						aria-label={t("recap.player.next")}
						onClick={next}
						className="focus-ring absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-[#283236]/80 hover:bg-[#283236]"
					>
						<ChevronRight size={18} />
					</button>
				</div>

				<div className="flex items-center gap-3 px-5 pb-5">
					<span className="min-w-0 flex-1 text-[15px] leading-snug">{slide ? slide.caption : " "}</span>
					<button
						type="button"
						onClick={() => {
							show(story.run.id);
							onClose();
						}}
						className="focus-ring rounded-xl bg-[#2bb3a3] px-4 py-2 text-[13px] font-semibold text-[#03211e]"
					>
						{t("recap.player.openConversation")}
					</button>
				</div>
			</div>
		</motion.div>
	);
}
