import clsx from "clsx";
import { FileText, Minus, MoveHorizontal, Plus } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { localFileBytes } from "@/lib/localFile";

/**
 * Lire un PDF dans le cockpit.
 *
 * Le lecteur du webview ne s'en chargeait pas : la politique de sécurité de la
 * fenêtre n'autorise aucun cadre venu d'ailleurs, et le protocole `asset://`
 * s'arrête au dossier personnel — là où un agent ne dépose presque jamais ses
 * rapports. pdf.js rend les pages lui-même, depuis des octets qu'on sait lire
 * partout ; il sert aussi les vignettes de la carte, qu'un cadre ne donnait pas.
 *
 * Chargé à la première ouverture seulement : quelques mégaoctets qu'on ne paie
 * pas au démarrage.
 */

async function pdfjs() {
	const [lib, worker] = await Promise.all([
		import("pdfjs-dist"),
		import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
	]);
	lib.GlobalWorkerOptions.workerSrc = worker.default;
	return lib;
}

/** Les documents ouverts, par chemin : la vignette et le lecteur partagent le même. */
const documents = new Map<string, Promise<PDFDocumentProxy>>();
/** Ce qui libère un document : depuis pdf.js 6, c'est le chargement, plus le document. */
const loadings = new Map<string, PDFDocumentLoadingTask>();
const KEEP = 6;

function openPdf(path: string): Promise<PDFDocumentProxy> {
	const known = documents.get(path);
	if (known) {
		// Le plus récent en dernier : c'est le premier qu'on garde.
		documents.delete(path);
		documents.set(path, known);
		return known;
	}
	const loading = Promise.all([pdfjs(), localFileBytes(path)]).then(
		([lib, data]) => {
			const task = lib.getDocument({ data });
			loadings.set(path, task);
			return task.promise;
		},
	);
	loading.catch(() => {
		documents.delete(path);
		loadings.delete(path);
	});
	documents.set(path, loading);
	while (documents.size > KEEP) {
		const [oldest] = documents.entries().next().value as [string, Promise<PDFDocumentProxy>];
		documents.delete(oldest);
		const task = loadings.get(oldest);
		loadings.delete(oldest);
		void task?.destroy().catch(() => {});
	}
	return loading;
}

function usePdf(path: string): { pdf: PDFDocumentProxy | null; error: unknown } {
	const [state, setState] = useState<{ path: string; pdf: PDFDocumentProxy | null; error: unknown }>({
		path,
		pdf: null,
		error: null,
	});
	useEffect(() => {
		let alive = true;
		setState({ path, pdf: null, error: null });
		openPdf(path).then(
			(pdf) => alive && setState({ path, pdf, error: null }),
			(error) => alive && setState({ path, pdf: null, error }),
		);
		return () => {
			alive = false;
		};
	}, [path]);
	return state.path === path ? state : { pdf: null, error: null };
}

/** Dessine une page à la largeur voulue, nette sur un écran Retina. */
async function paint(
	pdf: PDFDocumentProxy,
	number: number,
	canvas: HTMLCanvasElement,
	width: number,
	started?: (task: RenderTask) => void,
) {
	const page = await pdf.getPage(number);
	const base = page.getViewport({ scale: 1 });
	const ratio = window.devicePixelRatio || 1;
	const viewport = page.getViewport({ scale: (width / base.width) * ratio });
	canvas.width = Math.floor(viewport.width);
	canvas.height = Math.floor(viewport.height);
	canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
	canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
	const task = page.render({ canvas, viewport });
	started?.(task);
	await task.promise;
}

/* ── La vignette ─────────────────────────────────────────────────────── */

/** Les premières pages déjà dessinées : une carte se redessine souvent. */
const thumbs = new Map<string, string>();

/** La première page, en image : ce qu'on reconnaît d'un document sans l'ouvrir. */
export function PdfThumb({ path, width, className }: { path: string; width: number; className?: string }) {
	const key = `${path}@${width}`;
	const [src, setSrc] = useState(() => thumbs.get(key) ?? null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const known = thumbs.get(key);
		if (known) {
			setSrc(known);
			return;
		}
		let alive = true;
		setSrc(null);
		setFailed(false);
		openPdf(path)
			.then(async (pdf) => {
				const canvas = document.createElement("canvas");
				await paint(pdf, 1, canvas, width);
				const url = canvas.toDataURL("image/png");
				thumbs.set(key, url);
				if (alive) setSrc(url);
			})
			.catch(() => alive && setFailed(true));
		return () => {
			alive = false;
		};
	}, [key, path, width]);

	if (src) return <img src={src} alt="" className={className} />;
	return (
		<span className={clsx("flex items-center justify-center bg-raised", className)}>
			{failed ? <FileText size={16} className="text-ink-faint" /> : <Spinner />}
		</span>
	);
}

/* ── Le lecteur ──────────────────────────────────────────────────────── */

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** Toutes les pages, l'une sous l'autre ; chacune ne se dessine qu'en approchant de l'écran. */
export function PdfDocument({ path }: { path: string }) {
	const { t } = useTranslation("components2");
	const { pdf, error } = usePdf(path);
	const frame = useRef<HTMLDivElement>(null);
	const [available, setAvailable] = useState(0);
	// `null` : à la largeur du cadre. Sinon, un facteur de la taille réelle.
	const [zoom, setZoom] = useState<number | null>(null);
	const [ratio, setRatio] = useState(1.414);
	const [current, setCurrent] = useState(1);

	useEffect(() => {
		const node = frame.current;
		if (!node) return;
		const observer = new ResizeObserver(() => setAvailable(node.clientWidth));
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	// La proportion de la première page réserve la place des autres avant
	// qu'elles soient dessinées : la barre de défilement ne saute pas.
	const [natural, setNatural] = useState(612);
	useEffect(() => {
		if (!pdf) return;
		void pdf.getPage(1).then((page) => {
			const viewport = page.getViewport({ scale: 1 });
			setNatural(viewport.width);
			setRatio(viewport.height / viewport.width);
		});
	}, [pdf]);

	const fit = Math.max(200, Math.min(available - 48, 1100));
	const width = zoom === null ? fit : Math.round(natural * zoom * (96 / 72));

	const step = (direction: 1 | -1) => {
		const now = zoom ?? width / (natural * (96 / 72));
		const next =
			direction > 0 ? ZOOMS.find((value) => value > now + 0.01) : [...ZOOMS].reverse().find((value) => value < now - 0.01);
		if (next) setZoom(next);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="hairline-b flex items-center gap-1.5 px-3 py-1.5">
				<span className="font-mono text-[11px] text-ink-muted tabular-nums">
					{pdf ? t("pdfView.page", { current, total: pdf.numPages }) : "…"}
				</span>
				<span className="flex-1" />
				<Button size="sm" icon={Minus} onClick={() => step(-1)} title={t("pdfView.zoomOut")} />
				<span className="w-11 text-center font-mono text-[11px] text-ink-muted tabular-nums">
					{t("pdfView.percent", { value: Math.round((width / (natural * (96 / 72))) * 100) })}
				</span>
				<Button size="sm" icon={Plus} onClick={() => step(1)} title={t("pdfView.zoomIn")} />
				<Button
					size="sm"
					icon={MoveHorizontal}
					active={zoom === null}
					onClick={() => setZoom(null)}
					title={t("pdfView.fitWidth")}
				/>
			</div>
			<div ref={frame} className="min-h-0 flex-1 overflow-auto bg-void">
				{error ? (
					<div className="p-4">
						<ErrorNote error={error instanceof Error ? error.message : String(error)} />
					</div>
				) : !pdf || available === 0 ? (
					<div className="flex justify-center py-12">
						<Spinner />
					</div>
				) : (
					<div className="flex flex-col items-center gap-4 px-6 py-5">
						{Array.from({ length: pdf.numPages }, (_, index) => (
							<PdfPage
								key={index}
								pdf={pdf}
								number={index + 1}
								width={width}
								height={Math.round(width * ratio)}
								root={frame.current}
								onSeen={setCurrent}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function PdfPage({
	pdf,
	number,
	width,
	height,
	root,
	onSeen,
}: {
	pdf: PDFDocumentProxy;
	number: number;
	width: number;
	height: number;
	root: HTMLElement | null;
	onSeen: (number: number) => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const [near, setNear] = useState(false);
	const [drawn, setDrawn] = useState<number | null>(null);

	useEffect(() => {
		const node = box.current;
		if (!node) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) setNear(true);
				}
			},
			{ root, rootMargin: "800px 0px" },
		);
		observer.observe(node);
		// La page qui occupe le milieu du cadre est celle qu'on lit.
		const reading = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onSeen(number);
			},
			{ root, rootMargin: "-50% 0px -50% 0px" },
		);
		reading.observe(node);
		return () => {
			observer.disconnect();
			reading.disconnect();
		};
	}, [root, number, onSeen]);

	useEffect(() => {
		if (!near || !canvas.current || drawn === width) return;
		let alive = true;
		// Un zoom pendant le dessin : deux rendus sur un même canevas, pdf.js
		// refuse. Le précédent s'arrête avant que le suivant commence.
		let task: RenderTask | null = null;
		paint(pdf, number, canvas.current, width, (started) => {
			task = started;
		}).then(
			() => alive && setDrawn(width),
			() => {},
		);
		return () => {
			alive = false;
			(task as RenderTask | null)?.cancel();
		};
	}, [near, pdf, number, width, drawn]);

	return (
		<div
			ref={box}
			className="shrink-0 bg-white shadow-card"
			style={{ width, minHeight: drawn === null ? height : undefined }}
		>
			<canvas ref={canvas} className={drawn === null ? "hidden" : "block"} />
		</div>
	);
}
