import clsx from "clsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
	ChevronLeft,
	ChevronRight,
	FileText,
	FolderOpen,
	Image as ImageIcon,
	Play,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LocalImage } from "@/components/LocalImage";
import { Markdown } from "@/components/Markdown";
import { Badge, Button, Empty, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { QaFile } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

/**
 * Livrables de self-QA d'un worktree.
 *
 * Les agents déposent leurs captures dans `.claude/work`, rangées par ticket.
 * Les consulter demandait d'ouvrir le Finder et de naviguer à la main, worktree
 * par worktree : on les montre ici, à côté du travail qu'elles documentent, et
 * on les parcourt à la flèche comme une pellicule.
 */
export function QaGallery({ path }: { path: string }) {
	const { t } = useTranslation("components3");
	const { notify } = useCockpit();
	// Un agent en train de travailler dépose ses captures au fil de l'eau : la
	// galerie doit les voir arriver sans qu'on rouvre l'écran.
	const files = useAsync(() => api.worktrees.qa(path), [path], { pollMs: 8000 });
	const [openIndex, setOpenIndex] = useState<number | null>(null);

	const all = useMemo(() => files.data ?? [], [files.data]);
	// Les groupes gardent l'ordre du scan : `.claude/work` d'abord, puis la QA
	// rangée par ticket.
	const groups = useMemo(() => {
		const map = new Map<string, QaFile[]>();
		for (const file of all) {
			const list = map.get(file.group) ?? [];
			list.push(file);
			map.set(file.group, list);
		}
		return [...map.entries()];
	}, [all]);

	useEffect(() => setOpenIndex(null), [path]);

	if (files.initial && files.loading) {
		return (
			<div className="flex justify-center py-6">
				<Spinner />
			</div>
		);
	}

	if (all.length === 0) {
		return (
			<Empty
				icon={ImageIcon}
				message={t("qaGallery.empty")}
				hint={t("qaGallery.emptyHint")}
			/>
		);
	}

	return (
		<>
			<div className="flex flex-col gap-3">
				{groups.map(([group, entries]) => (
					<div key={group}>
						<div className="mb-1.5 flex items-center gap-1.5">
							<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
								{group || t("qaGallery.root")}
							</span>
							<span className="shrink-0 font-mono text-[10px] text-ink-faint/70">
								{entries.length}
							</span>
							<Button
								size="sm"
								icon={FolderOpen}
								title={t("qaGallery.openFolder")}
								onClick={() => {
									void api.system
										.reveal(entries[0].path)
										.catch((error) => notify(String(error)));
								}}
							/>
						</div>
						<div className="grid grid-cols-4 gap-1.5">
							{entries.map((file) => (
								<Thumbnail
									key={file.path}
									file={file}
									onOpen={() => setOpenIndex(all.indexOf(file))}
								/>
							))}
						</div>
					</div>
				))}
			</div>

			{openIndex !== null ? (
				<Lightbox
					files={all}
					index={openIndex}
					onIndex={setOpenIndex}
					onClose={() => setOpenIndex(null)}
				/>
			) : null}
		</>
	);
}

function Thumbnail({ file, onOpen }: { file: QaFile; onOpen: () => void }) {
	return (
		<button
			type="button"
			onClick={onOpen}
			title={file.relative}
			className="focus-ring group flex aspect-square flex-col overflow-hidden rounded-lg border border-line-soft bg-void transition-colors hover:border-line"
		>
			<div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
				{file.kind === "image" ? (
					<LocalImage
						path={file.path}
						alt={file.name}
						className="h-full w-full object-cover"
					/>
				) : file.kind === "video" ? (
					<>
						<video
							src={convertFileSrc(file.path)}
							muted
							preload="metadata"
							className="h-full w-full object-cover"
						/>
						<Play size={16} className="absolute text-ink drop-shadow" />
					</>
				) : (
					<FileText size={18} className="text-ink-faint" />
				)}
			</div>
			<span className="shrink-0 truncate px-1 py-1 text-left font-mono text-[10px] text-ink-faint group-hover:text-ink-muted">
				{file.name}
			</span>
		</button>
	);
}

/**
 * Visionneuse plein écran.
 *
 * Les flèches et Échap suffisent à tout faire : une pellicule se parcourt au
 * clavier, pas à la souris.
 */
function Lightbox({
	files,
	index,
	onIndex,
	onClose,
}: {
	files: QaFile[];
	index: number;
	onIndex: (index: number) => void;
	onClose: () => void;
}) {
	const { t } = useTranslation("components3");
	const file = files[index];
	const { notify } = useCockpit();
	const text = useAsync(
		() =>
			file && (file.kind === "markdown" || file.kind === "text")
				? api.docs.read(file.path)
				: Promise.resolve(""),
		[file?.path],
		{ enabled: Boolean(file) && file.kind !== "image" && file.kind !== "video" },
	);

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
			if (event.key === "ArrowRight") onIndex((index + 1) % files.length);
			if (event.key === "ArrowLeft") onIndex((index - 1 + files.length) % files.length);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [files.length, index, onClose, onIndex]);

	if (!file) return null;

	return (
		<div className="animate-in fixed inset-0 z-50 flex flex-col bg-overlay/95">
			<div className="flex shrink-0 items-center gap-2 px-3 py-2">
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
					{file.relative}
				</span>
				<Badge>{`${index + 1} / ${files.length}`}</Badge>
				<Button
					size="sm"
					icon={FolderOpen}
					title={t("qaGallery.reveal")}
					onClick={() => {
						void api.system.reveal(file.path).catch((error) => notify(String(error)));
					}}
				/>
				<Button size="sm" icon={X} onClick={onClose} title={t("qaGallery.close")} />
			</div>

			<div className="flex min-h-0 flex-1 items-center gap-2 px-2 pb-2">
				<Button
					icon={ChevronLeft}
					onClick={() => onIndex((index - 1 + files.length) % files.length)}
					title={t("qaGallery.previous")}
					className="h-10 shrink-0"
				/>

				<div className="flex h-full min-w-0 flex-1 items-center justify-center overflow-auto">
					{file.kind === "image" ? (
						<LocalImage
							path={file.path}
							alt={file.name}
							className="max-h-full max-w-full object-contain"
						/>
					) : file.kind === "video" ? (
						// eslint-disable-next-line jsx-a11y/media-has-caption
						<video
							src={convertFileSrc(file.path)}
							controls
							autoPlay
							className="max-h-full max-w-full"
						/>
					) : (
						<div className="text-selectable panel h-full w-full max-w-3xl overflow-y-auto p-4">
							{text.loading && !text.data ? (
								<Spinner />
							) : file.kind === "markdown" ? (
								<Markdown source={text.data ?? ""} />
							) : (
								<pre className="font-mono text-[11px] whitespace-pre-wrap text-ink-muted">
									{text.data ?? ""}
								</pre>
							)}
						</div>
					)}
				</div>

				<Button
					icon={ChevronRight}
					onClick={() => onIndex((index + 1) % files.length)}
					title={t("qaGallery.next")}
					className="h-10 shrink-0"
				/>
			</div>

			{/* Pellicule : savoir où l'on est dans la série compte autant que l'image. */}
			<div className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-3">
				{files.map((entry, position) => (
					<button
						key={entry.path}
						type="button"
						onClick={() => onIndex(position)}
						title={entry.name}
						className={clsx(
							"h-12 w-16 shrink-0 overflow-hidden rounded border transition-colors",
							position === index
								? "border-accent"
								: "border-line-soft opacity-60 hover:opacity-100",
						)}
					>
						{entry.kind === "image" ? (
							<LocalImage path={entry.path} alt="" className="h-full w-full object-cover" />
						) : (
							<span className="flex h-full w-full items-center justify-center">
								{entry.kind === "video" ? (
									<Play size={12} className="text-ink-faint" />
								) : (
									<FileText size={12} className="text-ink-faint" />
								)}
							</span>
						)}
					</button>
				))}
			</div>
		</div>
	);
}
