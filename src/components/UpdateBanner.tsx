import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { Download, RefreshCw, X } from "lucide-react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { Button } from "@/components/ui";
import { useCockpit } from "@/app/store";

/**
 * La mise à jour de l'application, proposée plutôt qu'imposée.
 *
 * Tant qu'une seule personne développait le cockpit, se mettre à jour voulait
 * dire recompiler. À plusieurs, ça n'a plus de sens : chacun doit pouvoir
 * recevoir une version sans rien savoir de Rust ni de pnpm.
 *
 * Rien ne s'installe sans un clic. Une application qui se met à jour toute
 * seule redémarre au milieu d'un travail — et ici, redémarrer coupe les agents
 * en cours. On signale donc, et on attend.
 *
 * L'archive n'est acceptée que si elle est signée par la clé du projet : c'est
 * cette vérification, faite par le plugin avant de poser quoi que ce soit, qui
 * fait qu'un serveur compromis ne peut pas livrer n'importe quoi.
 *
 * L'état vit dans un contexte plutôt que dans la carte : le bouton des réglages
 * et la carte sont deux composants distincts, et chacun cherchant de son côté,
 * le premier annonçait une version que la seconde ignorait.
 */

/** Où en est la mise à jour, du point de vue de l'utilisateur. */
type Stage =
	| { kind: "idle" }
	| { kind: "available"; update: Update }
	| { kind: "downloading"; update: Update; percent: number | null }
	| { kind: "ready" }
	| { kind: "failed"; message: string };

interface UpdateStore {
	stage: Stage;
	version: string | null;
	checking: boolean;
	/** Cherche une version ; `announce` fait parler même quand il n'y a rien. */
	look: (announce?: boolean) => Promise<void>;
	install: (update: Update) => Promise<void>;
	dismiss: () => void;
}

const Context = createContext<UpdateStore | null>(null);

/**
 * Assez souvent pour qu'une version publiée dans la soirée soit proposée sans
 * qu'on ait à relancer l'application, assez rarement pour rester discret.
 */
const INTERVAL_MS = 20 * 60 * 1000;

export function UpdateProvider({ children }: { children: ReactNode }) {
	const { notify } = useCockpit();
	const [stage, setStage] = useState<Stage>({ kind: "idle" });
	const [version, setVersion] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	// Une version écartée ne revient pas d'elle-même. Elle revient en revanche
	// si on la redemande : fermer la carte n'est pas un refus définitif.
	const [dismissed, setDismissed] = useState<string | null>(null);

	useEffect(() => {
		void getVersion()
			.then(setVersion)
			.catch(() => undefined);
	}, []);

	const look = useCallback(
		async (announce = false) => {
			if (announce) setChecking(true);
			try {
				const update = await check();
				if (update) {
					setDismissed(null);
					setStage({ kind: "available", update });
					if (announce) notify(`Version ${update.version} disponible.`);
				} else if (announce) {
					notify("Cockpit est à jour.");
				}
			} catch (error) {
				// Hors ligne, ou dépôt de versions injoignable : on regardera de
				// nouveau tout à l'heure, sans alerter pour autant.
				if (announce) notify(`Vérification impossible : ${error}`);
			} finally {
				if (announce) setChecking(false);
			}
		},
		[notify],
	);

	useEffect(() => {
		void look();
		const timer = setInterval(() => void look(), INTERVAL_MS);
		return () => clearInterval(timer);
	}, [look]);

	const install = useCallback(
		async (update: Update) => {
			setStage({ kind: "downloading", update, percent: null });
			try {
				let total = 0;
				let received = 0;
				await update.downloadAndInstall((event) => {
					if (event.event === "Started") {
						total = event.data.contentLength ?? 0;
					} else if (event.event === "Progress") {
						received += event.data.chunkLength;
						setStage({
							kind: "downloading",
							update,
							percent: total > 0 ? Math.round((received / total) * 100) : null,
						});
					}
				});
				setStage({ kind: "ready" });
				// Laisser lire « installée » avant que la fenêtre disparaisse : un
				// redémarrage instantané ressemble à un plantage.
				setTimeout(() => void relaunch(), 1200);
			} catch (error) {
				setStage({ kind: "failed", message: String(error) });
				notify(`Mise à jour impossible : ${error}`);
			}
		},
		[notify],
	);

	const dismiss = useCallback(() => {
		setStage((current) => {
			if (current.kind === "available") setDismissed(current.update.version);
			return { kind: "idle" };
		});
	}, []);

	const value = useMemo<UpdateStore>(
		() => ({
			stage:
				stage.kind === "available" && dismissed === stage.update.version
					? { kind: "idle" }
					: stage,
			version,
			checking,
			look,
			install,
			dismiss,
		}),
		[stage, dismissed, version, checking, look, install, dismiss],
	);

	return <Context.Provider value={value}>{children}</Context.Provider>;
}

function useUpdate(): UpdateStore {
	const store = useContext(Context);
	if (!store) throw new Error("useUpdate doit être utilisé dans UpdateProvider");
	return store;
}

export function UpdateBanner() {
	const { stage, install, dismiss } = useUpdate();
	if (stage.kind === "idle") return null;

	return (
		<div className="animate-in fixed right-4 bottom-4 z-50 w-80">
			<div className="panel flex flex-col gap-2 p-3 shadow-xl shadow-black/40">
				{stage.kind === "available" ? (
					<>
						<div className="flex items-start gap-2">
							<Download size={13} className="mt-0.5 shrink-0 text-accent-soft" />
							<div className="min-w-0 flex-1">
								<p className="text-[12.5px] font-medium text-ink">
									Version {stage.update.version} disponible
								</p>
								{stage.update.body ? (
									<p className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-ink-faint">
										{stage.update.body}
									</p>
								) : null}
							</div>
							<button
								type="button"
								onClick={dismiss}
								title="Plus tard"
								className="focus-ring shrink-0 rounded text-ink-faint hover:text-ink"
							>
								<X size={12} />
							</button>
						</div>
						{/* Ce que coûte le clic est dit avant, pas après : la mise à
						    jour relance l'application, et les agents en cours s'arrêtent
						    avec elle. */}
						<p className="text-[10px] leading-snug text-ink-faint">
							L'installation relance le cockpit — les agents en cours seront
							arrêtés, et leurs tâches reprises au redémarrage.
						</p>
						<div className="flex justify-end gap-2">
							<Button size="sm" onClick={dismiss}>
								Plus tard
							</Button>
							<Button
								size="sm"
								variant="solid"
								icon={Download}
								onClick={() => void install(stage.update)}
							>
								Mettre à jour
							</Button>
						</div>
					</>
				) : null}

				{stage.kind === "downloading" ? (
					<div className="flex flex-col gap-1.5">
						<div className="flex items-center gap-2">
							<RefreshCw size={12} className="shrink-0 animate-spin-slow text-accent-soft" />
							<span className="text-[11px] text-ink">
								Téléchargement de la version {stage.update.version}…
							</span>
						</div>
						<div className="h-1 overflow-hidden rounded-full bg-raised">
							<div
								className="h-full rounded-full bg-accent transition-[width] duration-200"
								style={{ width: `${stage.percent ?? 8}%` }}
							/>
						</div>
					</div>
				) : null}

				{stage.kind === "ready" ? (
					<div className="flex items-center gap-2">
						<RefreshCw size={12} className="shrink-0 animate-spin-slow text-success" />
						<span className="text-[11px] text-ink">Installée — redémarrage…</span>
					</div>
				) : null}

				{stage.kind === "failed" ? (
					<div className="flex items-start gap-2">
						<div className="min-w-0 flex-1">
							<p className="text-[11px] text-critical">Mise à jour impossible</p>
							<p className="mt-0.5 line-clamp-2 text-[10px] text-ink-faint">
								{stage.message}
							</p>
						</div>
						<Button size="sm" onClick={dismiss}>
							Fermer
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * La version installée, et de quoi aller en chercher une autre à la demande.
 *
 * Le bouton ne fait que demander : c'est la carte, en bas à droite, qui propose
 * — et elle le fait maintenant, puisque les deux partagent le même état.
 */
export function UpdateCheck() {
	const { version, checking, look, stage, install } = useUpdate();

	return (
		<div className="flex shrink-0 items-center gap-2">
			<span className="shrink-0 font-mono text-[11px] text-ink-faint">
				version {version ?? "…"}
			</span>
			{/* Quand une version attend, l'installer d'ici évite de la chercher des
			    yeux à l'autre bout de l'écran. */}
			{stage.kind === "available" ? (
				<Button
					size="sm"
					variant="solid"
					icon={Download}
					onClick={() => void install(stage.update)}
				>
					Installer {stage.update.version}
				</Button>
			) : (
				<Button
					size="sm"
					icon={RefreshCw}
					loading={checking}
					onClick={() => void look(true)}
				>
					Chercher une mise à jour
				</Button>
			)}
		</div>
	);
}
