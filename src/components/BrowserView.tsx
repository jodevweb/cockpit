import clsx from "clsx";
import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, PenLine, Power, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrowserAnnotator } from "@/components/BrowserAnnotator";
import { Button } from "@/components/ui";
import { useCockpit } from "@/app/store";
import { t as translate } from "@/i18n";
import { api } from "@/lib/ipc";
import { isPreview, PREVIEW_PAGE } from "@/lib/preview";
import type { BrowserAction, ListeningPort } from "@/lib/types";
import { useAsync, usePersistentState } from "@/lib/useAsync";
import { isAltGraph, isMac } from "@/lib/platform";
import { basename } from "@/lib/paths";

/**
 * Le navigateur d'un workspace : la page que l'agent pilote, en direct.
 *
 * Ce n'est pas un navigateur de plus à côté du sien : c'est le sien. L'image
 * vient du navigateur que ses outils pilotent — ce qu'on voit ici est ce qu'il
 * fait, au moment où il le fait. On peut y cliquer et y écrire : les gestes
 * partent dans la même page, pour reprendre la main ou lui montrer un écran.
 *
 * La page prend la taille de l'onglet : on regarde la page elle-même, pas sa
 * photo réduite. Et l'ouvrir suffit — elle va d'elle-même sur ce qui écoute
 * dans ce workspace, quitte à lancer d'abord son serveur.
 */

type Status = "idle" | "opening" | "live" | "failed";

/** Ce que fait l'agent dans la page, dit en un mot (clé du catalogue `components3`). */
const GESTURES: Array<[RegExp, string]> = [
	[/navigate/, "navigate"],
	[/click|hover|drag|select/, "click"],
	[/type|fill|press_key/, "type"],
	[/screenshot/, "screenshot"],
	[/snapshot|find|console|network/, "read"],
	[/wait/, "wait"],
];

/** La phrase « l'agent navigue », traduite au rendu. */
export function gestureLabel(tool: string): string {
	const gesture = GESTURES.find(([pattern]) => pattern.test(tool))?.[1] ?? "act";
	return translate(`components3:browserView.gesture.${gesture}`);
}

/** Sous Windows, les touches Ctrl+… qui vont à la page plutôt qu'à l'app. */
const PAGE_EDIT_KEYS = new Set(["a", "c", "x", "z", "y"]);

/** Les touches de modification, dans l'encodage du protocole de débogage. */
function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
	return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

/** Combien de temps on attend qu'un serveur lancé se mette à écouter. */
const SERVER_WAIT_MS = 120_000;

/** Une adresse saisie à la main : « localhost:3000 » doit suffire. */
function toUrl(typed: string): string {
	const value = typed.trim();
	if (!value) return "";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("about:")) return value;
	return /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(value) ? `http://${value}` : `https://${value}`;
}

function belongsTo(port: ListeningPort, cwd: string): boolean {
	if (!port.cwd || !cwd) return false;
	const root = cwd.replace(/\/+$/, "");
	return port.cwd === root || port.cwd.startsWith(`${root}/`);
}

/** Le dossier d'un serveur dans son workspace : `apps/web`, le même d'un worktree à l'autre. */
function placeOf(server: ListeningPort, cwd: string): string {
	return server.cwd.slice(cwd.replace(/\/+$/, "").length).replace(/^\/+/, "");
}

/** Le nom court d'un serveur, pour sa pastille : son dossier, sinon son processus. */
function nameOf(server: ListeningPort, cwd: string): string {
	return basename(placeOf(server, cwd)) || server.process;
}

/** Les serveurs qui rendent des pages, à leur nom de processus. */
const PAGE_SERVERS = /next|vite|nuxt|astro|remix|webpack|parcel|rsbuild|storybook/i;

/**
 * Le serveur sur lequel ouvrir le navigateur.
 *
 * Le plus petit port d'un monorepo est souvent son API : on s'ouvrait sur du
 * JSON alors qu'on venait voir l'application. On retourne d'abord là où l'on
 * est allé la dernière fois dans ce projet — le dossier du serveur, qui ne
 * change pas d'un worktree à l'autre, là où son port change. À défaut, un
 * serveur de pages passe devant les autres.
 */
function homeOf(servers: ListeningPort[], cwd: string, home: string | null): ListeningPort | null {
	return (
		(home === null ? undefined : servers.find((server) => placeOf(server, cwd) === home)) ??
		servers.find((server) => PAGE_SERVERS.test(server.process)) ??
		servers[0] ??
		null
	);
}

/** Ce qui écoute dans ce workspace, le plus petit port d'abord. */
function serversOf(ports: ListeningPort[] | null, cwd: string): ListeningPort[] {
	const seen = new Set<number>();
	return (ports ?? [])
		.filter((port) => belongsTo(port, cwd) && !seen.has(port.port) && seen.add(port.port))
		.sort((a, b) => a.port - b.port);
}

export function BrowserView({
	cwd,
	active,
	driving,
	onStartServer,
}: {
	cwd: string;
	/** L'onglet est celui qu'on regarde : masqué, il ne diffuse rien. */
	active: boolean;
	/** L'outil que l'agent emploie en ce moment dans la page, s'il y en a un. */
	driving: string | null;
	/** Lance le serveur de dev de l'équipe, si elle en a déclaré un. */
	onStartServer?: () => void;
}) {
	const { t } = useTranslation("components3");
	const { activeProject } = useCockpit();
	// Le dossier du serveur qu'on a choisi d'ouvrir, par projet.
	const [home, setHome] = usePersistentState<string | null>(`browser.home.${activeProject?.id ?? "defaut"}`, null);
	const [status, setStatus] = useState<Status>("idle");
	const [error, setError] = useState<string | null>(null);
	// L'adresse de la page, et celle qu'on est en train d'écrire.
	const [url, setUrl] = useState("");
	const [typed, setTyped] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	// On attend qu'un serveur lancé se mette à écouter.
	const [waiting, setWaiting] = useState(false);
	// On montre la page à l'agent : les gestes ne partent plus dans la page.
	const [annotating, setAnnotating] = useState(false);
	const canvas = useRef<HTMLCanvasElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const size = useRef({ width: 1280, height: 800 });
	const shown = useRef({ url: "", title: "" });

	const act = useCallback(
		(action: BrowserAction) => {
			// Un geste refusé veut dire que le navigateur n'est plus regardé, ou
			// s'est fermé : on le montre, plutôt que de laisser une image figée
			// sur laquelle plus rien ne répond.
			void api.browser.act(cwd, action).catch(() => {
				setStatus((current) => (current === "live" ? "idle" : current));
			});
		},
		[cwd],
	);

	const ports = useAsync(() => api.system.ports(), [], { pollMs: waiting ? 2000 : 10_000, enabled: active });
	const servers = serversOf(ports.data, cwd);
	const blank = url === "" || url === "about:blank";

	const open = useCallback(async () => {
		setStatus("opening");
		setError(null);
		try {
			await api.browser.watch(cwd);
			setStatus("live");
		} catch (failure) {
			setError(String(failure));
			setStatus("failed");
		}
	}, [cwd]);

	// Les images : on demande la suivante une fois la précédente dessinée. Le
	// rythme est donc celui de l'affichage — rien ne s'empile, et une app
	// occupée ralentit le film au lieu de se figer dessous.
	useEffect(() => {
		if (status !== "live") return;
		let alive = true;
		const context = canvas.current?.getContext("2d");
		if (isPreview()) {
			// Hors de la fenêtre native : une page d'exemple, dite comme telle.
			const sample = new Image();
			sample.onload = () => {
				if (!alive || !canvas.current || !context) return;
				canvas.current.width = PREVIEW_PAGE.width;
				canvas.current.height = PREVIEW_PAGE.height;
				context.drawImage(sample, 0, 0, PREVIEW_PAGE.width, PREVIEW_PAGE.height);
			};
			sample.src = PREVIEW_PAGE.src;
			size.current = { width: PREVIEW_PAGE.width, height: PREVIEW_PAGE.height };
			setUrl(PREVIEW_PAGE.url);
			setTitle(PREVIEW_PAGE.title);
			return () => {
				alive = false;
			};
		}
		void (async () => {
			let seq = 0;
			// L'image suivante se demande dès que celle-ci est arrivée, pendant
			// qu'on la décode et la dessine : attendre d'avoir fini pour demander
			// ajoutait un aller-retour avec l'app entre deux images, et la page
			// avait un temps de retard sur ce qu'on y faisait. Une seule demande
			// reste en vol à la fois — rien ne s'empile.
			let next = api.browser.frame(cwd, seq);
			// Une demande en vol qu'on abandonne ne doit pas crier dans la console.
			next.catch(() => undefined);
			while (alive) {
				let block: ArrayBuffer;
				try {
					block = await next;
				} catch {
					// Le navigateur s'est fermé, ou on a cessé de le regarder.
					if (alive) setStatus("idle");
					return;
				}
				if (!alive) return;
				// Rien n'a bougé pendant l'attente : la page est simplement immobile.
				if (block.byteLength < 4) {
					next = api.browser.frame(cwd, seq);
					next.catch(() => undefined);
					continue;
				}
				const length = new DataView(block).getUint32(0, true);
				const shot = JSON.parse(new TextDecoder().decode(new Uint8Array(block, 4, length))) as {
					seq: number;
					width: number;
					height: number;
					url: string;
					title: string;
				};
				seq = shot.seq;
				next = api.browser.frame(cwd, seq);
				next.catch(() => undefined);
				try {
					// Décodée puis relâchée aussitôt : une image posée en adresse
					// `data:` restait dans le cache du moteur, une par image.
					const bitmap = await createImageBitmap(new Blob([new Uint8Array(block, 4 + length)], { type: "image/jpeg" }));
					if (alive && canvas.current && context) {
						if (canvas.current.width !== bitmap.width) canvas.current.width = bitmap.width;
						if (canvas.current.height !== bitmap.height) canvas.current.height = bitmap.height;
						context.drawImage(bitmap, 0, 0);
					}
					bitmap.close();
				} catch {
					continue;
				}
				size.current = { width: shot.width, height: shot.height };
				if (shot.url !== shown.current.url || shot.title !== shown.current.title) {
					shown.current = { url: shot.url, title: shot.title };
					setUrl(shot.url);
					setTitle(shot.title);
				}
			}
		})();
		return () => {
			alive = false;
		};
	}, [status, cwd]);

	// La page prend la taille de l'onglet, et la suit quand il change.
	useEffect(() => {
		const element = stage.current;
		if (!element || status !== "live" || isPreview()) return;
		let timer = 0;
		const fit = () => {
			const box = element.getBoundingClientRect();
			if (box.width < 50 || box.height < 50) return;
			act({ kind: "resize", width: Math.round(box.width), height: Math.round(box.height) });
		};
		fit();
		const observer = new ResizeObserver(() => {
			window.clearTimeout(timer);
			timer = window.setTimeout(fit, 180);
		});
		observer.observe(element);
		return () => {
			window.clearTimeout(timer);
			observer.disconnect();
		};
	}, [status, act]);

	// Masqué, on cesse de regarder : le navigateur continue pour l'agent, mais
	// plus aucune image ne traverse l'app pour un onglet que personne ne voit.
	useEffect(() => {
		if (active) return;
		setStatus((current) => (current === "live" || current === "opening" ? "idle" : current));
		void api.browser.unwatch(cwd).catch(() => undefined);
	}, [active, cwd]);
	useEffect(() => () => void api.browser.unwatch(cwd).catch(() => undefined), [cwd]);

	// À l'écran et pas encore branché : on se branche dès que le navigateur
	// existe — lancé par l'agent — sans le lancer soi-même pour autant.
	useEffect(() => {
		if (!active || status !== "idle") return;
		let alive = true;
		const look = async () => {
			const running = await api.browser.running(cwd).catch(() => false);
			if (alive && running) void open();
		};
		void look();
		const timer = window.setInterval(look, 2500);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, [active, status, cwd, open, driving]);

	// Ouvert sur une page vide : on va de soi-même sur ce qui écoute ici. On ne
	// le fait qu'une fois par ouverture — revenir à une page vide est un choix.
	const led = useRef(false);
	useEffect(() => {
		if (status !== "live") {
			led.current = false;
			return;
		}
		if (led.current || !blank || servers.length === 0 || isPreview()) return;
		led.current = true;
		setWaiting(false);
		const first = homeOf(servers, cwd, home);
		if (first) act({ kind: "navigate", url: `http://localhost:${first.port}` });
	}, [status, blank, servers, act, cwd, home]);

	// Rien n'écoute : on lance le serveur de l'équipe, et la page s'ouvrira
	// d'elle-même dès qu'il répondra.
	const started = useRef(false);
	useEffect(() => {
		if (status !== "live" || !blank || isPreview()) return;
		if (started.current || !onStartServer || ports.initial || servers.length > 0) return;
		started.current = true;
		setWaiting(true);
		onStartServer();
	}, [status, blank, onStartServer, ports.initial, servers.length]);
	// Un serveur qui ne vient pas : on cesse de l'annoncer.
	useEffect(() => {
		if (!waiting) return;
		const timer = window.setTimeout(() => setWaiting(false), SERVER_WAIT_MS);
		return () => window.clearTimeout(timer);
	}, [waiting]);

	const go = (target: string) => {
		const address = toUrl(target);
		if (!address) return;
		setTyped(null);
		led.current = true;
		if (status === "live") act({ kind: "navigate", url: address });
		else void open().then(() => act({ kind: "navigate", url: address }));
	};

	/** Un point de l'écran, ramené au repère de la page. */
	const pointOf = (event: { clientX: number; clientY: number }) => {
		const box = canvas.current?.getBoundingClientRect();
		if (!box || box.width === 0) return null;
		return {
			x: ((event.clientX - box.left) / box.width) * size.current.width,
			y: ((event.clientY - box.top) / box.height) * size.current.height,
		};
	};

	// La molette demande un écouteur non passif pour ne pas faire défiler l'app.
	useEffect(() => {
		const element = stage.current;
		if (!element || status !== "live") return;
		// Un pavé tactile envoie plus de cent crans par seconde, inertie
		// comprise : un message par cran saturait la liaison avec l'app, et le
		// défilement arrivait par à-coups. On les additionne et on en envoie un
		// par image affichée — la page défile d'autant, en une fois.
		let pending: { x: number; y: number; deltaX: number; deltaY: number } | null = null;
		let frame = 0;
		const flush = () => {
			frame = 0;
			if (pending) act({ kind: "wheel", ...pending });
			pending = null;
		};
		const wheel = (event: WheelEvent) => {
			const point = pointOf(event);
			if (!point) return;
			event.preventDefault();
			pending = {
				...point,
				deltaX: (pending?.deltaX ?? 0) + event.deltaX,
				deltaY: (pending?.deltaY ?? 0) + event.deltaY,
			};
			if (!frame) frame = requestAnimationFrame(flush);
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => {
			element.removeEventListener("wheel", wheel);
			cancelAnimationFrame(frame);
		};
	}, [status, act]);

	const lastMove = useRef(0);
	const mouse = (kind: "mousePressed" | "mouseReleased" | "mouseMoved") => (event: React.MouseEvent) => {
		if (status !== "live") return;
		if (kind === "mouseMoved") {
			// Une position par image affichée : à vingt par seconde, un survol
			// ou un glisser suivait la main avec un temps de retard visible.
			if (event.timeStamp - lastMove.current < 16) return;
			lastMove.current = event.timeStamp;
		}
		const point = pointOf(event);
		if (!point) return;
		if (kind === "mousePressed") {
			// Le clic ne doit pas reprendre le focus au champ de saisie caché.
			event.preventDefault();
			keys.current?.focus();
		}
		act({
			kind: "mouse",
			event: kind,
			...point,
			button: kind === "mouseMoved" && event.buttons === 0 ? "none" : (BUTTONS[event.button] ?? "left"),
			clickCount: kind === "mouseMoved" ? 0 : Math.max(1, event.detail),
			modifiers: modifiersOf(event),
		});
	};

	// La saisie passe par un champ caché qui garde le focus. Lire les touches
	// sur un simple cadre suffisait aux lettres, pas au reste : un accent
	// composé (« ^ » puis « e »), un caractère obtenu avec ⌥, un texte collé
	// n'arrivent pas en touches mais en texte — et lire le presse-papiers par
	// programme demande à la fenêtre une permission qu'un collage natif n'exige
	// pas. Les touches partent telles quelles ; ce qui se compose part en texte.
	const keys = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const sendText = (text: string) => {
		if (text) act({ kind: "text", text });
		if (keys.current) keys.current.value = "";
	};

	const key = (kind: "keyDown" | "keyUp") => (event: React.KeyboardEvent) => {
		if (status !== "live") return;
		// ⌘V : le collage natif arrive dans le champ caché, et `onPaste` le relaie.
		// Les autres raccourcis ⌘ restent à l'app : ⌘K, ⌘W, changer d'onglet.
		if (event.metaKey) return;
		// Sous Windows, Ctrl tient ce rôle : Ctrl+V colle par le même chemin, et
		// les raccourcis de l'app (Ctrl+K, Ctrl+Maj+…) lui restent. Seules les
		// commandes d'édition — tout sélectionner, copier, couper, annuler,
		// rétablir — partent à la page, où elles agissent sur sa sélection.
		const altGraph = isAltGraph(event);
		const lower = event.key.toLowerCase();
		const pageEdit = PAGE_EDIT_KEYS.has(lower) && (!event.shiftKey || lower === "z");
		if (!isMac && event.ctrlKey && !altGraph && !pageEdit) return;
		// Une touche morte ou une composition : le texte viendra par `onInput`.
		if (event.key === "Dead" || event.key === "Process" || event.nativeEvent.isComposing || event.keyCode === 229) return;
		// AltGr (Ctrl+Alt pour la webview) donne un caractère, pas un raccourci.
		const printable = event.key.length === 1 && (!event.ctrlKey || altGraph);
		// ⌥ + touche donne un caractère sur un clavier Mac (« | », « { », « ~ ») :
		// envoyé comme touche avec ⌥ enfoncé, la page y verrait un raccourci.
		if (printable && event.altKey) {
			event.preventDefault();
			if (kind === "keyDown") sendText(event.key);
			return;
		}
		event.preventDefault();
		act({
			kind: "key",
			event: kind,
			key: event.key,
			code: event.code,
			text: printable ? event.key : event.key === "Enter" ? "\r" : "",
			keyCode: event.keyCode,
			modifiers: modifiersOf(event),
		});
	};

	const live = status === "live";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-1 border-b border-line-soft px-3 py-1.5">
				<Button size="sm" icon={ArrowLeft} disabled={!live} onClick={() => act({ kind: "back" })} title={t("browserView.back")} />
				<Button size="sm" icon={ArrowRight} disabled={!live} onClick={() => act({ kind: "forward" })} title={t("browserView.forward")} />
				<Button size="sm" icon={RotateCw} disabled={!live} onClick={() => act({ kind: "reload" })} title={t("browserView.reload")} />
				<form
					className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-raised px-2.5 py-1"
					onSubmit={(event) => {
						event.preventDefault();
						go(typed ?? url);
					}}
				>
					<Globe size={12} className="shrink-0 text-ink-faint" />
					<input
						value={typed ?? (blank ? "" : url)}
						onChange={(event) => setTyped(event.target.value)}
						onBlur={() => setTyped(null)}
						placeholder={t("browserView.addressPlaceholder")}
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-faint"
					/>
					{title && typed === null ? (
						<span className="max-w-56 shrink-0 truncate text-[11px] text-ink-faint">{title}</span>
					) : null}
				</form>
				{/* Ce qui écoute dans ce workspace : on y va d'un clic, sans rien écrire. */}
				{servers.slice(0, 5).map((server) => (
					<button
						key={server.port}
						type="button"
						onClick={() => {
							// Choisir un serveur, c'est dire où l'on veut arriver la prochaine fois.
							setHome(placeOf(server, cwd));
							go(`localhost:${server.port}`);
						}}
						title={`${server.process} — ${server.cwd}`}
						className={clsx(
							"focus-ring shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]",
							url.includes(`localhost:${server.port}`)
								? "bg-accent-dim text-accent"
								: "bg-raised text-ink-muted hover:bg-hover hover:text-ink",
						)}
					>
						{nameOf(server, cwd)} :{server.port}
					</button>
				))}
				{driving ? (
					<span className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent-dim px-2.5 py-1 text-[11px] font-medium text-accent">
						<span className="animate-pulse-dot size-1.5 rounded-full bg-accent" />
						<Bot size={12} />
						{gestureLabel(driving)}
					</span>
				) : null}
				<Button
					size="sm"
					icon={PenLine}
					variant={annotating ? "solid" : undefined}
					disabled={!live}
					onClick={() => setAnnotating((value) => !value)}
					title={t("browserView.annotateTitle")}
				>
					{t("browserView.annotate")}
				</Button>
				<Button
					size="sm"
					icon={ExternalLink}
					disabled={!live || blank}
					onClick={() => void api.system.openUrl(url)}
					title={t("browserView.openExternal")}
				/>
				<Button
					size="sm"
					icon={Power}
					disabled={status === "idle"}
					onClick={() => {
						void api.browser.stop(cwd).catch(() => undefined);
						setStatus("idle");
						setUrl("");
						setTitle("");
						shown.current = { url: "", title: "" };
						started.current = false;
					}}
					title={t("browserView.stop")}
				/>
			</div>

			<div
				ref={stage}
				tabIndex={-1}
				onFocus={(event) => {
					if (event.target === stage.current) keys.current?.focus();
				}}
				className={clsx(
					"relative min-h-0 flex-1 overflow-hidden bg-surface outline-none",
					// Le contour dit qui tient la souris : l'agent, en ce moment.
					driving && live && "shadow-[inset_0_0_0_3px_var(--color-accent)]",
				)}
			>
				<textarea
					ref={keys}
					aria-label={t("browserView.keyboardInput")}
					autoCapitalize="off"
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
					onKeyDown={key("keyDown")}
					onKeyUp={key("keyUp")}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={(event) => {
						composing.current = false;
						sendText(event.data);
					}}
					onInput={(event) => {
						// Pendant une composition, le texte n'est pas encore le bon.
						if (!composing.current) sendText(event.currentTarget.value);
					}}
					onPaste={(event) => {
						event.preventDefault();
						sendText(event.clipboardData.getData("text/plain"));
					}}
					className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
				/>
				{/* La page est à la taille de l'onglet : un pixel de l'image pour un
				    pixel de l'écran, sauf le temps d'un redimensionnement. */}
				<canvas
					ref={canvas}
					onMouseDown={mouse("mousePressed")}
					onMouseUp={mouse("mouseReleased")}
					onMouseMove={mouse("mouseMoved")}
					onContextMenu={(event) => event.preventDefault()}
					className={clsx("absolute inset-0 m-auto max-h-full max-w-full", !live && "hidden")}
				/>

				{live && annotating ? (
					<BrowserAnnotator cwd={cwd} canvas={canvas} stage={stage} size={size} onClose={() => setAnnotating(false)} />
				) : null}

				{!live ? (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-base p-8 text-center">
						<span className="grid size-12 place-items-center rounded-2xl bg-accent-dim text-accent">
							<Globe size={20} />
						</span>
						<p className="max-w-md text-[12.5px] leading-relaxed text-ink-muted">
							{status === "opening"
								? t("browserView.starting")
								: status === "failed"
									? error
									: t("browserView.notRunning")}
						</p>
						{status !== "opening" ? (
							<Button variant="solid" icon={Globe} onClick={() => void open()}>
								{t("browserView.open")}
							</Button>
						) : null}
					</div>
				) : null}

				{live && blank ? (
					<div className="pointer-events-none absolute inset-x-0 top-10 flex justify-center">
						<span className="rounded-full bg-raised px-3 py-1.5 text-[11.5px] text-ink-muted shadow-pop">
							{servers.length > 0
								? t("browserView.openingServer")
								: waiting
									? t("browserView.serverStarting")
									: onStartServer
										? t("browserView.nothingListening")
										: t("browserView.nothingListeningHint")}
						</span>
					</div>
				) : null}
			</div>
		</div>
	);
}
