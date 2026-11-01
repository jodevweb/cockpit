import clsx from "clsx";
import { Pause, Play } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { openLightbox } from "@/components/Lightbox";
import { MediaThumb } from "@/components/MediaThumb";
import { clock, PHASE_LABELS, type Film as FilmData, type Frame, type Phase } from "@/lib/film";

/**
 * Le film d'un épisode, dessiné : chaque image est un geste de l'agent, mis
 * en scène selon sa nature — des tuiles pour ce qu'il a lu, une bulle pour ce
 * qu'il suppose, un diff pour ce qu'il change, un terminal pour ses tests, la
 * capture pour ce qu'il a vu.
 *
 * Deux formes : la bande (sous une conclusion, une ligne de vignettes) et la
 * salle (l'onglet Film, qui joue les images à la suite comme une courte vidéo,
 * avec la frise du temps passé).
 */

const PHASE_COLORS: Record<Phase, string> = {
	read: "bg-ink-faint/45",
	edit: "bg-[var(--agent-3)]",
	test: "bg-warning",
	see: "bg-accent",
	run: "bg-[var(--agent-2)]",
	agent: "bg-[var(--agent-1)]",
};

const FRAME_SECONDS = 2.4;

export function FrameArt({ frame, large }: { frame: Frame; large?: boolean }) {
	const size = large ? "text-[13px]" : "text-[10px]";
	switch (frame.kind) {
		case "read":
			return (
				<div className="flex h-full items-center justify-center bg-raised p-3">
					<div className={clsx("grid w-full grid-cols-3 gap-1.5", large && "max-w-xl gap-3")}>
					{frame.files.map((file) => (
						<span
							key={file}
							title={file}
							className={clsx(
								"truncate rounded-md bg-accent-dim font-mono text-accent",
								large ? "flex h-20 items-end p-2.5 shadow-card" : "px-1.5 py-1",
								size,
							)}
						>
							{file}
						</span>
					))}
					{frame.more > 0 ? (
						<span className={clsx("rounded-md bg-surface px-1.5 py-1 text-center text-ink-muted", size)}>+{frame.more}</span>
					) : null}
					</div>
				</div>
			);
		case "think":
			return (
				<div className="flex h-full items-center bg-[color-mix(in_srgb,var(--agent-1)_10%,var(--surface))] p-3">
					<p
						className={clsx(
							"m-0 rounded-xl bg-surface px-3 py-2 leading-snug text-ink shadow-card",
							large ? "text-[15px]" : "line-clamp-4 text-[11px]",
						)}
					>
						« {frame.quote} »
					</p>
				</div>
			);
		case "edit":
		case "fix":
			return (
				<div className={clsx("flex h-full flex-col gap-0.5 overflow-hidden bg-raised p-3 font-mono leading-relaxed", size)}>
					<span className="text-ink-muted">{frame.file}</span>
					{frame.removed.map((line, index) => (
						<span key={`r${index}`} className="truncate rounded bg-critical/10 px-1 text-critical">
							− {line.trim()}
						</span>
					))}
					{frame.added.map((line, index) => (
						<span key={`a${index}`} className="truncate rounded bg-success/10 px-1 text-success">
							+ {line.trim()}
						</span>
					))}
				</div>
			);
		case "test":
			return (
				<div className={clsx("flex h-full flex-col gap-0.5 overflow-hidden bg-[#141a20] p-3 font-mono leading-relaxed text-[#aab6ba]", size)}>
					<span className="truncate">$ {frame.command}</span>
					{frame.lines.map((line, index) => (
						<span key={index} className={clsx("truncate", frame.ok ? "text-[#4ade80]" : "text-[#ff8a80]")}>
							{line}
						</span>
					))}
					<span className={clsx("mt-auto h-1.5 rounded-full", frame.ok ? "bg-[#4ade80]" : "bg-[#ff6f66]")} />
				</div>
			);
		case "see":
			return <MediaThumb media={frame.media} width={large ? 720 : 240} className="h-full w-full bg-raised" />;
		case "deliver":
			return (
				<div className="flex h-full flex-col justify-center gap-1.5 bg-accent-dim p-3">
					<span className={clsx("font-bold text-accent", large ? "text-[18px]" : "line-clamp-3 text-[12px]")}>{frame.title}</span>
					{frame.detail ? <span className={clsx("text-accent/80", large ? "text-[13px]" : "line-clamp-2 text-[10.5px]")}>{frame.detail}</span> : null}
				</div>
			);
	}
}

/** La bande : les images du film en vignettes, sous une conclusion. */
export const FilmStrip = memo(function FilmStrip({
	film,
	onOpen,
}: {
	film: FilmData;
	/** Ouvre la salle sur cette image. */
	onOpen?: (index: number) => void;
}) {
	if (film.frames.length < 2) return null;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-baseline gap-2">
				<span className="text-[10.5px] font-semibold tracking-[0.05em] text-ink-muted uppercase">Le film du tour</span>
				<span className="text-[10.5px] text-ink-faint">
					{film.calls} appel{film.calls > 1 ? "s" : ""}
					{film.duration ? ` · ${clock(film.duration)}` : ""}
				</span>
			</div>
			<ol className="m-0 flex list-none gap-2 overflow-x-auto p-0 pb-1">
				{film.frames.map((frame, index) => (
					<li key={frame.key} className="w-36 shrink-0">
						<button
							type="button"
							onClick={() => (frame.kind === "see" ? openLightbox([frame.media]) : onOpen?.(index))}
							className="focus-ring flex w-full flex-col overflow-hidden rounded-lg bg-surface text-left shadow-card"
						>
							<span className="block h-20 overflow-hidden">
								<FrameArt frame={frame} />
							</span>
							<span className="flex flex-col px-2 py-1.5">
								<span className="font-mono text-[9.5px] text-ink-faint">{clock(frame.offset)}</span>
								<span className="truncate text-[11px] text-ink">{frame.caption}</span>
							</span>
						</button>
					</li>
				))}
			</ol>
		</div>
	);
});

/** La frise du temps passé, par nature de geste. */
export function PhaseBar({ film, playhead }: { film: FilmData; playhead?: number | null }) {
	if (film.segments.length === 0) return null;
	const phases = [...new Set(film.segments.map((segment) => segment.phase))];
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted">
				{phases.map((phase) => {
					const ms = film.segments.filter((segment) => segment.phase === phase).reduce((sum, segment) => sum + segment.ms, 0);
					return (
						<span key={phase} className="flex items-center gap-1.5">
							<span className={clsx("size-2.5 rounded-[3px]", PHASE_COLORS[phase])} />
							{PHASE_LABELS[phase]} <span className="font-mono text-ink-faint">{clock(ms)}</span>
						</span>
					);
				})}
			</div>
			<div className="relative flex h-5 gap-0.5 overflow-hidden rounded-md">
				{film.segments.map((segment, index) => (
					<span
						key={index}
						title={`${PHASE_LABELS[segment.phase]} · ${clock(segment.ms)}`}
						className={PHASE_COLORS[segment.phase]}
						style={{ flexGrow: Math.max(segment.share, 0.004), flexBasis: 0 }}
					/>
				))}
				{playhead !== null && playhead !== undefined ? (
					<span
						aria-hidden="true"
						className="absolute -top-1 -bottom-1 w-[3px] rounded bg-ink transition-[left] duration-500"
						style={{ left: `${playhead * 100}%` }}
					/>
				) : null}
			</div>
		</div>
	);
}

/**
 * La salle : l'image en grand, jouée à la suite, la bande dessous, la frise du
 * temps en bas. C'est la « mini vidéo » d'un tour — sans encodage, puisque
 * chaque image se dessine de ce que le cockpit a déjà sous la main.
 */
export function FilmTheater({ film, start = 0 }: { film: FilmData; start?: number }) {
	const [index, setIndex] = useState(start);
	const [playing, setPlaying] = useState(true);
	const count = film.frames.length;

	useEffect(() => setIndex(Math.min(start, Math.max(0, count - 1))), [start, count]);
	useEffect(() => {
		if (!playing || count < 2) return;
		const timer = window.setTimeout(() => setIndex((value) => (value + 1) % count), FRAME_SECONDS * 1000);
		return () => window.clearTimeout(timer);
	}, [playing, index, count]);

	if (count === 0) {
		return (
			<p className="px-4 py-10 text-center text-[12px] text-ink-faint">
				Rien à filmer pour l'instant : le film se fabrique à partir des gestes de l'agent.
			</p>
		);
	}
	const frame = film.frames[Math.min(index, count - 1)];
	const playhead = film.duration && frame.offset !== null ? Math.min(1, frame.offset / film.duration) : null;

	return (
		<div className="flex flex-col gap-4">
			<div className="overflow-hidden rounded-2xl bg-surface shadow-pop">
				<div className="relative h-72 overflow-hidden">
					<FrameArt frame={frame} large />
					<span className="absolute bottom-3 left-1/2 max-w-[90%] -translate-x-1/2 rounded-lg bg-[#0f1315]/80 px-3 py-1.5 text-center text-[13px] text-[#eef3f4]">
						{frame.caption}
					</span>
				</div>
				<div className="flex items-center gap-3 px-4 py-2.5">
					<button
						type="button"
						aria-label={playing ? "Mettre en pause" : "Lire"}
						onClick={() => setPlaying((value) => !value)}
						className="focus-ring grid size-8 place-items-center rounded-full bg-accent text-accent-ink"
					>
						{playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
					</button>
					<div className="flex flex-1 gap-1">
						{film.frames.map((entry, position) => (
							<button
								key={entry.key}
								type="button"
								aria-label={`Image ${position + 1} : ${entry.caption}`}
								onClick={() => {
									setIndex(position);
									setPlaying(false);
								}}
								className="focus-ring h-1.5 flex-1 overflow-hidden rounded-full bg-line"
							>
								<span
									className={clsx("block h-full bg-accent", position === index && playing ? "animate-[film-fill_2.4s_linear]" : "")}
									style={{ width: position < index ? "100%" : position === index ? (playing ? undefined : "100%") : "0%" }}
								/>
							</button>
						))}
					</div>
					<span className="font-mono text-[11px] text-ink-faint">{clock(frame.offset)}</span>
				</div>
			</div>
			<FilmStrip film={film} onOpen={(position) => {
				setIndex(position);
				setPlaying(false);
			}} />
			<PhaseBar film={film} playhead={playhead} />
		</div>
	);
}
