import clsx from "clsx";
import {
	AppWindow,
	ChevronDown,
	ChevronUp,
	Copy,
	FileQuestion,
	FolderOpen,
	Pencil,
	PenLine,
	Save,
	Search,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IMAGE_EXTENSIONS, LocalImage } from "@/components/LocalImage";
import { Markdown } from "@/components/Markdown";
import { PdfDocument } from "@/components/PdfView";
import { Badge, Button, ErrorNote, Spinner } from "@/components/ui";
import { bytes } from "@/lib/format";
import { useHighlight, type Segment } from "@/lib/highlight";
import { FileViewerContext, type FileViewerStore } from "@/lib/fileViewer";
import { api } from "@/lib/ipc";
import { localFileUrl } from "@/lib/localFile";
import { useAsync } from "@/lib/useAsync";
import { useTranslation } from "react-i18next";
import { modKey, platformContext } from "@/lib/platform";
import { basename, dirname } from "@/lib/paths";

/**
 * Lecture d'un fichier sans quitter le cockpit.
 *
 * Un agent annonce un livrable, on clique, on le lit. Passer la main à
 * l'éditeur pour ça fait perdre le fil : on change d'application, de fenêtre,
 * et la conversation qu'on suivait disparaît derrière.
 *
 * C'est une visionneuse, pas un éditeur : elle affiche, elle n'écrit pas. Le
 * bouton « Éditeur » reste là pour ce qui doit être modifié — la relecture est
 * le geste fréquent, l'édition celui qu'on assume.
 */

/**
 * Ce qui s'affiche en pages plutôt qu'en texte, par pdf.js (`PdfView`).
 *
 * Le PDF est le livrable qui suit le markdown en fréquence — un rapport, une
 * facture, une maquette exportée. Sans lui, cliquer sur le fichier qu'un agent
 * vient de produire ouvrait sa visionneuse sur des octets illisibles.
 */
const EMBEDDED = ["pdf"];

/** Ce que le webview lit lui-même : une démo filmée par un agent, un enregistrement. */
const VIDEO = ["mp4", "m4v", "mov", "webm", "ogv"];
const AUDIO = ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"];

/**
 * Ce qui n'est pas du texte et que le cockpit ne sait pas montrer : on ne le
 * lit même pas. Le lire comme du texte finissait sur « stream did not contain
 * valid UTF-8 », une erreur qui ne dit pas quoi faire.
 */
const OPAQUE = [
	"mkv", "avi", "wmv", "flv",
	"docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf",
	"key", "pages", "numbers",
	"zip", "gz", "tgz", "tar", "rar", "7z", "dmg", "pkg",
	"heic", "tiff", "tif", "psd", "sketch", "fig", "ai", "eps",
	"ttf", "otf", "woff", "woff2", "sqlite", "db", "wasm",
];

/** Au-delà, le rendu coûte plus que ce que le fichier apprend. */
const MAX_BYTES = 600_000;

/**
 * Les positions d'un terme dans le fichier, ligne par ligne.
 *
 * Recherche littérale et insensible à la casse : on vient chercher une clé
 * qu'on connaît — « FAL_API_KEY » — pas construire une expression. Une regex
 * mal fermée ne doit pas faire disparaître les résultats.
 */
function findMatches(
	lines: string[],
	query: string,
): Array<{ line: number; start: number }> {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const out: Array<{ line: number; start: number }> = [];
	lines.forEach((content, index) => {
		const haystack = content.toLowerCase();
		let from = 0;
		for (;;) {
			const at = haystack.indexOf(needle, from);
			if (at === -1) break;
			out.push({ line: index, start: at });
			from = at + needle.length;
		}
	});
	return out;
}

/** Une ligne, coloriée quand on sait la colorier, avec ses occurrences mises en évidence. */
function Line({
	content,
	segments,
	query,
	hits,
	current,
}: {
	content: string;
	/** La ligne découpée en morceaux de couleur ; absente, le texte s'affiche nu. */
	segments?: Segment[];
	query: string;
	/** Positions des occurrences dans cette ligne. */
	hits: number[];
	/** Position de l'occurrence sélectionnée, si elle est sur cette ligne. */
	current: number | null;
}) {
	const pieces = segments ?? [{ text: content }];
	if (hits.length === 0) {
		if (!segments) return <>{content}</>;
		return (
			<>
				{pieces.map((piece, index) =>
					piece.tone ? (
						<span key={index} className={piece.tone}>
							{piece.text}
						</span>
					) : (
						piece.text
					),
				)}
			</>
		);
	}

	// Une occurrence peut couper un morceau de couleur, ou en enjamber deux :
	// on avance morceau par morceau, en fermant à chaque frontière.
	const size = query.trim().length;
	const parts: React.ReactNode[] = [];
	let offset = 0;
	pieces.forEach((piece, pieceIndex) => {
		const end = offset + piece.text.length;
		let cursor = offset;
		const emit = (from: number, to: number, hit: number | null) => {
			if (to <= from) return;
			const text = piece.text.slice(from - offset, to - offset);
			parts.push(
				hit === null ? (
					<span key={`${pieceIndex}-${from}`} className={piece.tone}>
						{text}
					</span>
				) : (
					<mark
						key={`${pieceIndex}-${from}`}
						className={clsx("rounded-sm", hit === current ? "bg-warning text-void" : "bg-accent/30 text-ink")}
					>
						{text}
					</mark>
				),
			);
		};
		for (const start of hits) {
			const from = Math.max(start, cursor);
			const to = Math.min(start + size, end);
			if (to <= from) continue;
			emit(cursor, from, null);
			emit(from, to, start);
			cursor = to;
		}
		emit(cursor, end, null);
		offset = end;
	});
	return <>{parts}</>;
}

function extensionOf(path: string): string {
	return basename(path).split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Ce que le cockpit ne montre pas lui-même : dit clairement, avec de quoi
 * l'ouvrir ailleurs en un clic plutôt qu'une erreur d'encodage.
 */
function Opaque({ path, name, reason }: { path: string; name: string; reason: "unplayable" | "unknown" }) {
	const { t } = useTranslation("components1");
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
			<span className="grid size-12 place-items-center rounded-2xl bg-raised text-ink-muted">
				<FileQuestion size={20} />
			</span>
			<p className="max-w-sm text-[12.5px] leading-relaxed text-ink-muted">
				{reason === "unplayable"
					? t("fileViewer.opaque.unplayable", { context: platformContext })
					: t("fileViewer.opaque.unknown", { context: platformContext, name })}
			</p>
			<div className="flex gap-2">
				<Button
					variant="solid"
					icon={AppWindow}
					onClick={() => {
						setError(null);
						void api.system.openFile(path).catch((failure) => setError(String(failure)));
					}}
				>
					{t("fileViewer.opaque.openDefault")}
				</Button>
				<Button icon={FolderOpen} onClick={() => void api.system.reveal(path).catch(() => undefined)}>
					{t("fileViewer.opaque.showInFinder", { context: platformContext })}
				</Button>
			</div>
			{error ? <p className="max-w-md text-[11px] text-critical">{error}</p> : null}
		</div>
	);
}

export function FileViewerProvider({ children }: { children: ReactNode }) {
	const [target, setTarget] = useState<{ path: string; line?: number } | null>(null);

	const open = useCallback((path: string, line?: number) => setTarget({ path, line }), []);
	const value = useMemo<FileViewerStore>(() => ({ open }), [open]);

	return (
		<FileViewerContext.Provider value={value}>
			{children}
			{target ? <Viewer target={target} onClose={() => setTarget(null)} /> : null}
		</FileViewerContext.Provider>
	);
}

function Viewer({
	target,
	onClose,
}: {
	target: { path: string; line?: number };
	onClose: () => void;
}) {
	const { t } = useTranslation("components1");
	const { path, line } = target;
	const extension = extensionOf(path);
	const isImage = IMAGE_EXTENSIONS.includes(extension);
	const isEmbedded = EMBEDDED.includes(extension);
	const isVideo = VIDEO.includes(extension);
	const isAudio = AUDIO.includes(extension);
	// Un lecteur qui refuse le fichier (un codec que le webview ne connaît pas)
	// se replie sur l'application du Mac, comme ce qu'on ne sait pas montrer.
	const [unplayable, setUnplayable] = useState(false);
	useEffect(() => setUnplayable(false), [path]);
	const isOpaque = OPAQUE.includes(extension) || unplayable;
	/** Rendu par le webview : rien à lire, rien à éditer, rien à chercher. */
	const isBinaryView = isImage || isEmbedded || isVideo || isAudio || isOpaque;
	const name = basename(path);

	const file = useAsync(
		() => (isBinaryView ? Promise.resolve("") : api.docs.read(path)),
		[path],
		{
			enabled: !isBinaryView,
		},
	);

	// La ligne visée n'a de sens qu'au premier rendu du contenu : après, c'est
	// à la molette de décider.
	useEffect(() => {
		if (!line || !file.data) return;
		const node = document.getElementById(`viewer-line-${line}`);
		node?.scrollIntoView({ block: "center" });
	}, [file.data, line]);

	// L'édition : un brouillon local tant qu'on n'a pas enregistré. Les
	// fichiers qu'on vient corriger ici — `.env`, une config — se tapent à la
	// main dans un champ monospace ; y mettre un vrai éditeur de code
	// coûterait une dépendance de plusieurs mégaoctets pour trois lignes de
	// variables.
	// La recherche : c'est par elle qu'on atteint une clé au milieu de deux
	// cents lignes de variables, sans faire défiler.
	const [query, setQuery] = useState("");
	const [hit, setHit] = useState(0);
	const search = useRef<HTMLInputElement>(null);
	/** Le conteneur qui défile, et le champ d'édition : la recherche vise l'un ou l'autre. */
	const viewport = useRef<HTMLDivElement>(null);
	const editor = useRef<HTMLTextAreaElement>(null);

	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const editing = draft !== null;

	// Changer de fichier ferme l'édition en cours : le brouillon appartient au
	// fichier qu'on regardait.
	useEffect(() => {
		setDraft(null);
		setFailure(null);
		setQuery("");
	}, [path]);

	const save = useCallback(async () => {
		if (draft === null) return;
		setSaving(true);
		setFailure(null);
		try {
			await api.files.write(path, draft);
			setDraft(null);
			file.reload();
		} catch (error) {
			setFailure(String(error));
		} finally {
			setSaving(false);
		}
	}, [draft, file, path]);

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			// ⌘S enregistre, comme partout — sans quoi le réflexe irait chercher
			// une sauvegarde du navigateur qui n'existe pas.
			if (event.key === "s" && modKey(event) && draft !== null) {
				event.preventDefault();
				void save();
				return;
			}
			// Échap ne referme pas sur un texte modifié : on ne perd pas une
			// correction par un réflexe de fermeture.
			if (event.key === "f" && modKey(event) && !isBinaryView) {
				event.preventDefault();
				search.current?.focus();
				search.current?.select();
				return;
			}
			// Échap referme d'abord la recherche, puis le brouillon, puis la
			// fenêtre : chaque échappement défait une seule chose.
			if (event.key === "Escape") {
				if (query) {
					setQuery("");
					return;
				}
				if (draft === null) onClose();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [draft, isBinaryView, onClose, query, save]);

	// Un fichier sans extension connue qui n'est pas du texte : la lecture
	// échoue sur l'encodage. Ce n'est pas une panne, c'est un autre genre de
	// fichier.
	const notText = !isBinaryView && /utf-?8/i.test(String(file.error ?? ""));
	const text = file.data ?? "";
	const tooBig = text.length > MAX_BYTES;
	const stored = tooBig ? text.slice(0, MAX_BYTES) : text;
	// En édition, c'est le brouillon qu'on a sous les yeux : chercher dans le
	// fichier enregistré donnerait des positions décalées de tout ce qu'on vient
	// de taper, et des occurrences introuvables à l'écran.
	const body = draft ?? stored;
	// Chercher dans un markdown veut dire chercher dans sa source : le rendu
	// n'a plus ni ses lignes ni ses marques. La vue bascule donc en texte brut
	// le temps de la recherche, et revient au rendu dès qu'on l'efface.
	const rendered = (extension === "md" || extension === "mdx") && !query.trim();
	const lines = useMemo(
		() => (isBinaryView || rendered ? [] : body.split("\n")),
		[body, isBinaryView, rendered],
	);

	// La couleur sert la lecture : en édition, c'est un champ de texte.
	const colored = useHighlight(body, path, !isBinaryView && !rendered && !editing);
	const tinted = colored && colored.length === lines.length ? colored : null;

	const matches = useMemo(() => findMatches(lines, query), [lines, query]);
	// La frappe redécoupe les résultats : on repart du premier.
	useEffect(() => setHit(0), [query]);
	const active = matches[hit] ?? null;

	// Amener l'occurrence choisie sous les yeux, sans bousculer le reste.
	//
	// Deux vues, deux gestes : le texte en lecture se fait défiler, le champ
	// d'édition se fait sélectionner. La recherche affichait ses compteurs dans
	// les deux cas, mais ne savait agir que sur le premier — dans un fichier
	// ouvert en modification, les flèches ne menaient nulle part et rien ne
	// s'allumait.
	useEffect(() => {
		if (!active) return;

		if (editing) {
			const field = editor.current;
			if (!field) return;
			// Position absolue de l'occurrence : les lignes précédentes, leurs
			// sauts compris.
			const offset =
				lines.slice(0, active.line).reduce((total, entry) => total + entry.length + 1, 0) +
				active.start;
			field.focus({ preventScroll: true });
			field.setSelectionRange(offset, offset + query.trim().length);
			// Le champ ne défile pas de lui-même vers une sélection posée par
			// programme : on l'y amène à la main, la ligne au milieu.
			const before = field.value.slice(0, offset).split("\n").length - 1;
			const lineHeight = field.scrollHeight / Math.max(1, field.value.split("\n").length);
			field.scrollTop = Math.max(0, before * lineHeight - field.clientHeight / 2);
			return;
		}

		const node = document.getElementById(`viewer-line-${active.line + 1}`);
		const box = viewport.current;
		if (!node || !box) return;
		box.scrollTop = node.offsetTop - box.clientHeight / 2 + node.clientHeight / 2;
	}, [active, editing, lines, query]);

	const step = useCallback(
		(delta: number) => {
			if (matches.length === 0) return;
			setHit((value) => (value + delta + matches.length) % matches.length);
		},
		[matches.length],
	);

	return (
		<div
			className="animate-in fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 p-8"
			onClick={onClose}
		>
			<div
				className="panel flex h-full w-full max-w-5xl flex-col overflow-hidden shadow-2xl shadow-black/50"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="hairline-b flex shrink-0 items-center gap-2 px-3 py-2">
					<div className="min-w-0 flex-1">
						<div className="truncate text-[12.5px] font-semibold text-ink">{name}</div>
						<div className="truncate font-mono text-[10px] text-ink-faint" title={path}>
							{path}
						</div>
					</div>
					{editing ? <Badge tone="warning">{t("fileViewer.unsaved")}</Badge> : null}
					{file.data && !editing ? <Badge mono>{bytes(text.length)}</Badge> : null}

					{editing ? (
						<>
							<Button
								size="sm"
								variant="solid"
								icon={Save}
								disabled={saving}
								onClick={() => void save()}
								title={t("fileViewer.saveTitle")}
							>
								{t("fileViewer.save")}
							</Button>
							<Button
								size="sm"
								onClick={() => {
									setDraft(null);
									setFailure(null);
								}}
								title={t("fileViewer.discardTitle")}
							>
								{t("fileViewer.cancel")}
							</Button>
						</>
					) : isBinaryView || tooBig ? null : (
						<Button
							size="sm"
							icon={Pencil}
							onClick={() => setDraft(text)}
							title={t("fileViewer.editTitle")}
						>
							{t("fileViewer.edit")}
						</Button>
					)}
					<Button
						size="sm"
						icon={Copy}
						onClick={() => void navigator.clipboard.writeText(path).catch(() => undefined)}
						title={t("fileViewer.copyPath")}
					/>
					<Button
						size="sm"
						icon={FolderOpen}
						onClick={() => void api.system.reveal(path).catch(() => undefined)}
						title={t("fileViewer.reveal", { context: platformContext })}
					/>
					{isBinaryView || notText ? (
						<Button
							size="sm"
							icon={AppWindow}
							onClick={() => void api.system.openFile(path).catch(() => undefined)}
							title={t("fileViewer.openWithTitle", { context: platformContext })}
						>
							{t("fileViewer.openWith")}
						</Button>
					) : (
						<Button
							size="sm"
							icon={PenLine}
							onClick={() => void api.system.openEditor(path).catch(() => undefined)}
							title={t("fileViewer.externalEditorTitle")}
						>
							{t("fileViewer.externalEditor")}
						</Button>
					)}
					<Button size="sm" icon={X} onClick={onClose} title={t("fileViewer.close")} />
				</div>

				{isBinaryView ? null : (
					<div className="hairline-b flex shrink-0 items-center gap-2 px-3 py-1.5">
						<Search size={12} className="shrink-0 text-ink-faint" />
						<input
							ref={search}
							value={query}
							spellCheck={false}
							placeholder={t("fileViewer.searchPlaceholder")}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									step(event.shiftKey ? -1 : 1);
								}
							}}
							className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
						/>
						{query.trim() ? (
							<>
								<span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
									{matches.length === 0 ? t("fileViewer.noMatch") : `${hit + 1}/${matches.length}`}
								</span>
								<Button
									size="sm"
									icon={ChevronUp}
									onClick={() => step(-1)}
									title={t("fileViewer.previousMatch")}
								/>
								<Button
									size="sm"
									icon={ChevronDown}
									onClick={() => step(1)}
									title={t("fileViewer.nextMatch")}
								/>
							</>
						) : null}
					</div>
				)}

				<div ref={viewport} className="min-h-0 flex-1 overflow-auto">
					{isOpaque || notText ? (
						<Opaque path={path} name={name} reason={unplayable ? "unplayable" : "unknown"} />
					) : null}
					{failure ? (
						<div className="p-3">
							<ErrorNote error={failure} />
						</div>
					) : null}
					{editing ? (
						<textarea
							ref={editor}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							className="text-selectable h-full w-full resize-none bg-void p-3 font-mono text-[11px] leading-[1.55] text-ink outline-none"
						/>
					) : isImage ? (
						<div className="flex h-full items-center justify-center p-4">
							{/* Pas un `img` nu : la visionneuse sert aussi les captures
							    qu'un agent dépose hors du dossier personnel — `/tmp`,
							    les dossiers temporaires du système — que le protocole
							    `asset://` refuse. `LocalImage` retombe alors sur l'IPC
							    au lieu de n'afficher qu'un cadre vide. */}
							<LocalImage
								path={path}
								alt={name}
								className="max-h-full max-w-full object-contain"
							/>
						</div>
					) : isOpaque || notText ? null : isEmbedded ? (
						<PdfDocument path={path} />
					) : isVideo ? (
						<div className="flex h-full items-center justify-center bg-void p-4">
							{/* biome-ignore lint/a11y/useMediaCaption: une démo d'agent n'a pas de sous-titres à part */}
							<video
								key={path}
								src={localFileUrl(path)}
								controls
								autoPlay
								className="max-h-full max-w-full rounded-lg"
								onError={() => setUnplayable(true)}
							/>
						</div>
					) : isAudio ? (
						<div className="flex h-full items-center justify-center p-8">
							{/* biome-ignore lint/a11y/useMediaCaption: un enregistrement n'a pas de sous-titres à part */}
							<audio key={path} src={localFileUrl(path)} controls className="w-full max-w-xl" onError={() => setUnplayable(true)} />
						</div>
					) : file.loading && !file.data ? (
						<div className="flex justify-center py-12">
							<Spinner />
						</div>
					) : file.error && !notText ? (
						<div className="p-4">
							<ErrorNote error={file.error} onRetry={file.reload} />
						</div>
					) : rendered ? (
						<div className="px-6 py-5">
							<Markdown source={body} cwd={dirname(path)} />
						</div>
					) : (
						// Numéros de ligne : c'est par eux qu'on se repère quand un
						// agent, un test ou une pile d'erreurs désigne un endroit.
						<pre className="text-selectable py-2 font-mono text-[11px] leading-[1.55]">
							{lines.map((content, index) => {
								const number = index + 1;
								return (
									<div
										key={number}
										id={`viewer-line-${number}`}
										className={clsx("flex gap-3 px-3", number === line && "bg-accent-dim")}
									>
										<span className="w-10 shrink-0 text-right text-ink-faint/50 select-none">
											{number}
										</span>
										<span className={clsx("min-w-0 break-all whitespace-pre-wrap", tinted ? "text-ink" : "text-ink-muted")}>
											<Line
												content={content}
												segments={tinted?.[index]}
												query={query}
												hits={matches
													.filter((match) => match.line === index)
													.map((match) => match.start)}
												current={active?.line === index ? active.start : null}
											/>
										</span>
									</div>
								);
							})}
						</pre>
					)}

					{tooBig ? (
						<p className="hairline-b border-t px-3 py-2 text-[11px] text-warning">
							{t("fileViewer.truncated", { size: bytes(MAX_BYTES) })}
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
