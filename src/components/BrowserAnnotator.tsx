import clsx from "clsx";
import { Circle, Eraser, MousePointer2, MoveUpRight, Paperclip, Type, X } from "lucide-react";
import { useCallback, useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useCockpit } from "@/app/store";
import { t as translate } from "@/i18n";
import { api } from "@/lib/ipc";
import type { InspectedElement } from "@/lib/types";

/**
 * Montrer l'écran à un agent plutôt que de le lui décrire.
 *
 * On entoure, on fléche, on écrit sur la page du navigateur du workspace, et
 * l'on pointe un élément : le cockpit lit alors ce qu'il est (balise, texte,
 * sélecteur, composant React et son fichier quand la page les expose). Le tout
 * part avec la prochaine consigne : l'image annotée en pièce jointe, et la
 * désignation exacte en texte — l'agent ne cherche plus de quoi on parle.
 *
 * Les formes vivent dans le repère de la page (pixels CSS), comme les clics :
 * elles restent à leur place quand l'onglet change de taille.
 */

type Tool = "ellipse" | "arrow" | "text" | "point";

type Shape =
	| { kind: "ellipse" | "arrow"; x1: number; y1: number; x2: number; y2: number }
	| { kind: "text"; x: number; y: number; text: string }
	| { kind: "element"; element: InspectedElement };

/** L'événement qu'écoute la conversation de ce workspace pour joindre l'écran. */
export const ATTACH_EVENT = "cockpit:joindre";

export interface AttachDetail {
	cwd: string;
	file: File;
	note: string;
	/** `active` : seule la conversation qu'on regarde le prend ; `any` : la première. */
	pass: "active" | "any";
	/** Posé par la conversation qui l'a pris : personne, et on le dit. */
	taken?: boolean;
}

const INK = "#cf3f35";
const MARK = "#6a55e8";

// Le libellé est une clé du catalogue `components3`, traduite au rendu.
const TOOLS: Array<[Tool, string, typeof Circle]> = [
	["ellipse", "browserAnnotator.tool.ellipse", Circle],
	["arrow", "browserAnnotator.tool.arrow", MoveUpRight],
	["text", "browserAnnotator.tool.text", Type],
	["point", "browserAnnotator.tool.point", MousePointer2],
];

function describe(element: InspectedElement, index: number): string {
		const parts = [
		element.text
			? translate("components3:browserAnnotator.describe.markerWithText", { index, tag: element.tag, text: element.text })
			: translate("components3:browserAnnotator.describe.marker", { index, tag: element.tag }),
	];
	if (element.component) {
		parts.push(
			element.source
				? translate("components3:browserAnnotator.describe.componentWithSource", { name: element.component, source: element.source })
				: translate("components3:browserAnnotator.describe.component", { name: element.component }),
		);
	}
	if (element.testid) parts.push(`data-testid="${element.testid}"`);
	if (element.label) parts.push(`aria-label="${element.label}"`);
	parts.push(translate("components3:browserAnnotator.describe.selector", { selector: element.selector }));
	return parts.join(" — ");
}

export function BrowserAnnotator({
	cwd,
	canvas,
	stage,
	size,
	onClose,
}: {
	cwd: string;
	/** L'image de la page, telle qu'elle est dessinée. */
	canvas: RefObject<HTMLCanvasElement | null>;
	stage: RefObject<HTMLDivElement | null>;
	/** La taille de la page en pixels CSS : le repère des formes. */
	size: RefObject<{ width: number; height: number }>;
	onClose: () => void;
}) {
	const { t } = useTranslation("components3");
	const { notify } = useCockpit();
	const [tool, setTool] = useState<Tool>("ellipse");
	const [shapes, setShapes] = useState<Shape[]>([]);
	const [draft, setDraft] = useState<Shape | null>(null);
	const [writing, setWriting] = useState<{ x: number; y: number; text: string } | null>(null);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	// Où l'image de la page est posée dans la scène : l'annotation la recouvre
	// exactement.
	const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

	useEffect(() => {
		const measure = () => {
			const page = canvas.current?.getBoundingClientRect();
			const scene = stage.current?.getBoundingClientRect();
			if (!page || !scene) return;
			setBox({ left: page.left - scene.left, top: page.top - scene.top, width: page.width, height: page.height });
		};
		measure();
		const observer = new ResizeObserver(measure);
		if (stage.current) observer.observe(stage.current);
		if (canvas.current) observer.observe(canvas.current);
		return () => observer.disconnect();
	}, [canvas, stage]);

	const page = size.current ?? { width: 1280, height: 800 };
	const pointOf = useCallback(
		(event: { clientX: number; clientY: number }) => {
			const rect = canvas.current?.getBoundingClientRect();
			if (!rect || rect.width === 0) return null;
			return {
				x: ((event.clientX - rect.left) / rect.width) * page.width,
				y: ((event.clientY - rect.top) / rect.height) * page.height,
			};
		},
		[canvas, page.width, page.height],
	);

	const elements = shapes.filter((shape): shape is Extract<Shape, { kind: "element" }> => shape.kind === "element");

	const down = (event: React.PointerEvent) => {
		const point = pointOf(event);
		if (!point) return;
		if (tool === "point") {
			void api.browser
				.inspect(cwd, point.x, point.y)
				.then((element) => {
					if (element) setShapes((current) => [...current, { kind: "element", element }]);
					else notify(t("browserAnnotator.nothingHere"));
				})
				.catch((error) => notify(String(error)));
			return;
		}
		if (tool === "text") {
			setWriting({ ...point, text: "" });
			return;
		}
		(event.target as Element).setPointerCapture?.(event.pointerId);
		setDraft({ kind: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y });
	};
	const move = (event: React.PointerEvent) => {
		if (!draft || draft.kind === "text" || draft.kind === "element") return;
		const point = pointOf(event);
		if (point) setDraft({ ...draft, x2: point.x, y2: point.y });
	};
	const up = () => {
		if (!draft || draft.kind === "text" || draft.kind === "element") return;
		// Un clic sans glisser ne trace rien : il n'y a rien à entourer.
		if (Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 6) setShapes((current) => [...current, draft]);
		setDraft(null);
	};

	/** L'image envoyée : la page telle qu'on la voit, les formes par-dessus. */
	const compose = async (): Promise<File | null> => {
		const source = canvas.current;
		if (!source || source.width === 0) return null;
		const out = document.createElement("canvas");
		out.width = source.width;
		out.height = source.height;
		const context = out.getContext("2d");
		if (!context) return null;
		context.drawImage(source, 0, 0);
		const scale = source.width / page.width;
		context.lineWidth = 4 * scale;
		context.lineCap = "round";
		context.font = `600 ${18 * scale}px "Instrument Sans", -apple-system, sans-serif`;
		let mark = 0;
		for (const shape of shapes) {
			if (shape.kind === "ellipse") {
				context.strokeStyle = INK;
				context.beginPath();
				context.ellipse(
					((shape.x1 + shape.x2) / 2) * scale,
					((shape.y1 + shape.y2) / 2) * scale,
					(Math.abs(shape.x2 - shape.x1) / 2) * scale,
					(Math.abs(shape.y2 - shape.y1) / 2) * scale,
					0,
					0,
					Math.PI * 2,
				);
				context.stroke();
			} else if (shape.kind === "arrow") {
				context.strokeStyle = INK;
				context.fillStyle = INK;
				const [x1, y1, x2, y2] = [shape.x1 * scale, shape.y1 * scale, shape.x2 * scale, shape.y2 * scale];
				context.beginPath();
				context.moveTo(x1, y1);
				context.lineTo(x2, y2);
				context.stroke();
				const angle = Math.atan2(y2 - y1, x2 - x1);
				const head = 16 * scale;
				context.beginPath();
				context.moveTo(x2, y2);
				context.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
				context.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
				context.closePath();
				context.fill();
			} else if (shape.kind === "text") {
				const width = context.measureText(shape.text).width;
				context.fillStyle = INK;
				context.fillRect(shape.x * scale - 6 * scale, shape.y * scale - 20 * scale, width + 12 * scale, 28 * scale);
				context.fillStyle = "#ffffff";
				context.fillText(shape.text, shape.x * scale, shape.y * scale);
			} else if (shape.kind === "element") {
				mark += 1;
				const { x, y, width, height } = shape.element.rect;
				context.strokeStyle = MARK;
				context.setLineDash([8 * scale, 5 * scale]);
				context.strokeRect(x * scale, y * scale, width * scale, height * scale);
				context.setLineDash([]);
				context.fillStyle = MARK;
				context.beginPath();
				context.arc(x * scale, y * scale, 13 * scale, 0, Math.PI * 2);
				context.fill();
				context.fillStyle = "#ffffff";
				context.textAlign = "center";
				context.fillText(String(mark), x * scale, y * scale + 6 * scale);
				context.textAlign = "start";
			}
		}
		const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
		return blob ? new File([blob], `ecran-annote-${Date.now()}.png`, { type: "image/png" }) : null;
	};

	const send = async () => {
		setBusy(true);
		try {
			const file = await compose();
			if (!file) {
				notify(t("browserAnnotator.noImage"));
				return;
			}
			const lines = [note.trim() || t("browserAnnotator.defaultNote")];
			elements.forEach((shape, index) => lines.push(describe(shape.element, index + 1)));
			const url = elements[0]?.element.url;
			if (url) lines.push(t("browserAnnotator.pageUrl", { url }));
			const detail: AttachDetail = { cwd, file, note: lines.join("\n"), pass: "active" };
			window.dispatchEvent(new CustomEvent<AttachDetail>(ATTACH_EVENT, { detail }));
			if (!detail.taken) {
				detail.pass = "any";
				window.dispatchEvent(new CustomEvent<AttachDetail>(ATTACH_EVENT, { detail }));
			}
			if (!detail.taken) {
				notify(t("browserAnnotator.noConversation"));
				return;
			}
			notify(t("browserAnnotator.attached"));
			onClose();
		} finally {
			setBusy(false);
		}
	};

	const all = draft ? [...shapes, draft] : shapes;
	let counter = 0;

	return (
		<>
			<div className="absolute top-2 left-1/2 z-20 flex w-max max-w-[calc(100%-16px)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl bg-surface p-1.5 shadow-pop">
				{TOOLS.map(([id, label, Icon]) => (
					<button
						key={id}
						type="button"
						title={t(label)}
						aria-label={t(label)}
						aria-pressed={tool === id}
						onClick={() => setTool(id)}
						className={clsx(
							"focus-ring grid size-8 place-items-center rounded-lg",
							tool === id ? "bg-accent-dim text-accent" : "text-ink-muted hover:bg-hover hover:text-ink",
						)}
					>
						<Icon size={15} />
					</button>
				))}
				<button
					type="button"
					title={t("browserAnnotator.clear")}
					aria-label={t("browserAnnotator.clear")}
					onClick={() => setShapes([])}
					className="focus-ring grid size-8 place-items-center rounded-lg text-ink-muted hover:bg-hover hover:text-ink"
				>
					<Eraser size={15} />
				</button>
				<span className="mx-1 h-5 w-px bg-line" />
				<input
					value={note}
					onChange={(event) => setNote(event.target.value)}
					placeholder={t("browserAnnotator.notePlaceholder")}
					aria-label={t("browserAnnotator.notePlaceholder")}
					className="w-56 min-w-0 flex-1 rounded-lg bg-raised px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint"
				/>
				<button
					type="button"
					disabled={busy || shapes.length === 0}
					onClick={() => void send()}
					className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap text-accent-ink disabled:opacity-50"
				>
					<Paperclip size={13} />
					{t("browserAnnotator.send")}
				</button>
				<button
					type="button"
					title={t("browserAnnotator.close")}
					aria-label={t("browserAnnotator.close")}
					onClick={onClose}
					className="focus-ring grid size-8 place-items-center rounded-lg text-ink-muted hover:bg-hover hover:text-ink"
				>
					<X size={15} />
				</button>
			</div>

			{box ? (
				<svg
					role="img"
					aria-label={t("browserAnnotator.overlay")}
					viewBox={`0 0 ${page.width} ${page.height}`}
					preserveAspectRatio="none"
					className={clsx("absolute z-10", tool === "point" ? "cursor-help" : "cursor-crosshair")}
					style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
					onPointerDown={down}
					onPointerMove={move}
					onPointerUp={up}
				>
					<defs>
						<marker id="pointe" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
							<path d="M0,0 L10,5 L0,10 z" fill={INK} />
						</marker>
					</defs>
					<rect width={page.width} height={page.height} fill="rgba(15,19,21,0.06)" />
					{all.map((shape, index) => {
						if (shape.kind === "ellipse") {
							return (
								<ellipse
									key={index}
									cx={(shape.x1 + shape.x2) / 2}
									cy={(shape.y1 + shape.y2) / 2}
									rx={Math.abs(shape.x2 - shape.x1) / 2}
									ry={Math.abs(shape.y2 - shape.y1) / 2}
									fill="none"
									stroke={INK}
									strokeWidth={4}
								/>
							);
						}
						if (shape.kind === "arrow") {
							return (
								<line
									key={index}
									x1={shape.x1}
									y1={shape.y1}
									x2={shape.x2}
									y2={shape.y2}
									stroke={INK}
									strokeWidth={4}
									strokeLinecap="round"
									markerEnd="url(#pointe)"
								/>
							);
						}
						if (shape.kind === "text") {
							return (
								<text key={index} x={shape.x} y={shape.y} fill={INK} fontSize={18} fontWeight={600} fontFamily="var(--font-sans)">
									{shape.text}
								</text>
							);
						}
						if (shape.kind !== "element") return null;
						counter += 1;
						const { x, y, width, height } = shape.element.rect;
						return (
							<g key={index}>
								<title>{describe(shape.element, counter)}</title>
								<rect x={x} y={y} width={width} height={height} fill="rgba(106,85,232,0.10)" stroke={MARK} strokeWidth={2} strokeDasharray="8 5" />
								<circle cx={x} cy={y} r={13} fill={MARK} />
								<text x={x} y={y + 5} textAnchor="middle" fill="#fff" fontSize={14} fontWeight={700} fontFamily="var(--font-sans)">
									{counter}
								</text>
							</g>
						);
					})}
				</svg>
			) : null}

			{writing && box ? (
				<input
					autoFocus
					value={writing.text}
					onChange={(event) => setWriting({ ...writing, text: event.target.value })}
					onBlur={() => setWriting(null)}
					onKeyDown={(event) => {
						if (event.key === "Escape") setWriting(null);
						if (event.key !== "Enter") return;
						if (writing.text.trim()) setShapes((current) => [...current, { kind: "text", x: writing.x, y: writing.y, text: writing.text.trim() }]);
						setWriting(null);
					}}
					placeholder={t("browserAnnotator.textPlaceholder")}
					className="absolute z-30 w-56 rounded-md bg-surface px-2 py-1 text-[12px] text-ink shadow-pop outline-none"
					style={{ left: box.left + (writing.x / page.width) * box.width, top: box.top + (writing.y / page.height) * box.height - 14 }}
				/>
			) : null}

			{elements.length > 0 ? (
				<ol className="absolute right-2 bottom-2 z-20 m-0 flex max-w-sm list-none flex-col gap-1.5 rounded-xl bg-surface p-2.5 text-[11.5px] shadow-pop">
					{elements.map((shape, index) => (
						<li key={index} className="flex gap-2">
							<span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--agent-1)] text-[10.5px] font-bold text-white">
								{index + 1}
							</span>
							<span className="min-w-0">
								<span className="font-mono text-ink">&lt;{shape.element.tag}&gt;</span>
								{shape.element.text ? <span className="text-ink"> {t("browserAnnotator.quote", { text: shape.element.text })}</span> : null}
								{shape.element.component ? (
									<span className="block truncate text-ink-muted">
										{shape.element.component}
										{shape.element.source ? ` · ${shape.element.source}` : ""}
									</span>
								) : null}
								<span className="block truncate font-mono text-[10.5px] text-ink-faint">{shape.element.selector}</span>
							</span>
						</li>
					))}
				</ol>
			) : null}
		</>
	);
}
