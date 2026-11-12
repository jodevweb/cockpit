import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { Lightbox } from "@/components/Lightbox";
import { useResolvedTheme } from "@/lib/theme";
import { AgentsView } from "@/views/AgentsView";
import { MethodsView } from "@/views/MethodsView";
import { ReplayView } from "@/views/ReplayView";
import { MapView } from "@/views/MapView";
import { TodayView } from "@/views/TodayView";
import { DecisionsView } from "@/views/DecisionsView";
import { RecapView } from "@/views/RecapView";
import { DeliveryView } from "@/views/DeliveryView";
import { ImpactView } from "@/views/ImpactView";
import { DocsView } from "@/views/DocsView";
import { GitView } from "@/views/GitView";
import { InfraView } from "@/views/InfraView";
import { ObservabilityView } from "@/views/ObservabilityView";
import { OverviewView } from "@/views/OverviewView";
import { ScriptsView } from "@/views/ScriptsView";
import { SettingsView } from "@/views/SettingsView";
import { TeamView } from "@/views/TeamView";
import { MissionsView } from "@/views/MissionsView";
import { PermanenceView } from "@/views/PermanenceView";
import { WorktreesView } from "@/views/WorktreesView";
import { LibreHost, LibresView } from "@/views/LibresView";
import { openLauncher } from "@/lib/libre";
import { modKey } from "@/lib/platform";
import { ConfirmProvider } from "@/components/Confirm";
import { ViewBoundary } from "@/components/ViewBoundary";
import { Assistant } from "@/components/Assistant";
import { ChangeTourProvider } from "@/components/ChangeTour";
import { FileViewerProvider } from "@/components/FileViewer";
import { UpdateBanner, UpdateProvider } from "@/components/UpdateBanner";
import { useWorkGroups, WorkspaceDock, WorkspacePanel } from "@/components/WorkspacePanel";
import { CommandPalette } from "./CommandPalette";
import { ActivityPanel } from "@/components/ActivityCenter";
import { Sidebar } from "./Sidebar";
import { AgentRunsProvider } from "./agents";
import { HibernateProvider } from "./hibernate";
import { CockpitProvider, useCockpit, type ViewId } from "./store";
import { TerminalsProvider, useTerminalActions } from "./terminals";
import { WorkspaceProvider, useWorkspace } from "./workspace";

/** Les chiffres suivent l'ordre de l'atelier — voir `GROUPS` dans `Sidebar.tsx`. */
const SHORTCUTS: Record<string, ViewId> = {
	"1": "today",
	"2": "overview",
	"3": "team",
	"4": "agents",
	"5": "docs",
	"6": "delivery",
	"7": "observability",
	"8": "worktrees",
	"9": "git",
	"0": "scripts",
	// Les préférences sont sur ⌘, partout sur macOS (Ctrl+, sous Windows).
	",": "settings",
};

/**
 * Raccourcis du clavier, à part du shell qui rend les écrans.
 *
 * Ils ont besoin de savoir ce qui tourne — quel groupe rouvrir, où ouvrir un
 * terminal — et cette liste bouge à chaque message d'agent. Les tenir ici évite
 * que la vue affichée soit rendue à nouveau à chaque fois : ce composant ne rend
 * rien, son propre rendu ne coûte rien.
 */
function Shortcuts({ onTogglePalette }: { onTogglePalette: () => void }) {
	const { go, view, config } = useCockpit();
	const workspace = useWorkspace();
	const terminals = useTerminalActions();
	const groups = useWorkGroups();

	// Le workspace visé par ⌘⇧T quand on n'est pas dans l'écran Workspaces : le
	// dernier ouvert, à défaut le dépôt principal.
	const lastGroup = groups.length > 0 ? groups[groups.length - 1].cwd : null;
	const terminalTarget = workspace.cwd ?? lastGroup ?? config?.mainRepo ?? null;

	// D'où l'on venait avant d'entrer dans un écran qui se visite — Workspaces,
	// Impact, Missions : y aller et en revenir doit ramener sur ce qu'on lisait,
	// pas sur un écran d'accueil. Les trois partagent la même mémoire, puisqu'on
	// ne peut pas être dans deux à la fois.
	const VISITES: ViewId[] = ["workspace", "impact", "missions", "permanence"];
	const origin = useRef<ViewId>("map");
	if (!VISITES.includes(view)) origin.current = view;

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			// ⌘ sur Mac, Ctrl ailleurs — voir `modKey` pour ce que Ctrl laisse à la saisie.
			if (!modKey(event)) return;
			// ⌘⇧A : bascule entre l'écran Workspaces et l'écran qu'on lisait.
			if (event.shiftKey && event.key.toLowerCase() === "a") {
				event.preventDefault();
				// L'écran choisit lui-même le workspace à montrer s'il n'y en a
				// pas encore un de retenu.
				go(view === "workspace" ? origin.current : "workspace");
				return;
			}
			// ⌘⇧I : le moniteur des changements, et retour à ce qu'on lisait.
			if (event.shiftKey && event.key.toLowerCase() === "i") {
				event.preventDefault();
				go(view === "impact" ? origin.current : "impact");
				return;
			}
			// ⌘⇧M : les missions, et retour à ce qu'on lisait. Le rail annonçait ce
			// raccourci depuis le début sans que rien ne l'implémente — promettre
			// une touche qui ne fait rien est pire que ne rien annoncer.
			if (event.shiftKey && event.key.toLowerCase() === "m") {
				event.preventDefault();
				go(view === "missions" ? origin.current : "missions");
				return;
			}
			// ⌘⇧P : la Permanence, et retour à ce qu'on lisait. Elle doit être
			// atteignable de partout : si on découvre depuis l'écran Git qu'elle
			// déraille, on ne doit pas avoir à naviguer pour la suspendre.
			if (event.shiftKey && event.key.toLowerCase() === "p") {
				event.preventDefault();
				go(view === "permanence" ? origin.current : "permanence");
				return;
			}
			// ⌘⇧D : ce qui attend ta décision, et retour à ce qu'on lisait.
			if (event.shiftKey && event.key.toLowerCase() === "d") {
				event.preventDefault();
				go(view === "decisions" ? origin.current : "decisions");
				return;
			}
			// ⌘⇧J : la journée en images, et retour.
			if (event.shiftKey && event.key.toLowerCase() === "j") {
				event.preventDefault();
				go(view === "recap" ? origin.current : "recap");
				return;
			}
			// ⌘⇧C : la carte, d'où que l'on soit.
			if (event.shiftKey && event.key.toLowerCase() === "c") {
				event.preventDefault();
				go("map");
				return;
			}
			// ⌘⇧T : un terminal de plus sur le workspace en cours.
			if (event.shiftKey && event.key.toLowerCase() === "t") {
				event.preventDefault();
				if (terminalTarget) terminals.open(terminalTarget);
				return;
			}
			if (event.key === "k") {
				event.preventDefault();
				onTogglePalette();
				return;
			}
			// ⌘N : un agent libre, comme on ouvrait un terminal pour taper `claude`.
			if (!event.shiftKey && event.key.toLowerCase() === "n") {
				event.preventDefault();
				openLauncher();
				return;
			}
			const target = SHORTCUTS[event.key];
			if (target) {
				event.preventDefault();
				go(target);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [go, lastGroup, onTogglePalette, terminalTarget, terminals, view, workspace]);

	return null;
}

function Shell() {
	const { view } = useCockpit();
	const resolvedTheme = useResolvedTheme();
	const [paletteOpen, setPaletteOpen] = useState(false);
	const togglePalette = useCallback(() => setPaletteOpen((open) => !open), []);

	const workspaceView = view === "workspace";

	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-void">
			<Shortcuts onTogglePalette={togglePalette} />
			<Sidebar onOpenPalette={() => setPaletteOpen(true)} />
			<div className="flex min-h-0 flex-1">

			{/* La frontière encadre l'écran, jamais le rail : un écran qui tombe
			    doit laisser de quoi aller ailleurs. `key` la remonte à chaque
			    changement de vue, pour qu'une erreur ne colle pas à la suivante. */}
			{workspaceView ? (
				<ViewBoundary view="Workspaces">
					<WorkspacePanel />
				</ViewBoundary>
			) : (
				<main className="flex min-w-0 flex-1 flex-col bg-base">
				<ViewBoundary key={view} view={view}>
					{/* Un écran qui arrive monte d'un cran en apparaissant : le
					    changement se voit sans qu'on ait à relire le titre. */}
					<motion.div
						key={view}
						initial={{ opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
						className="flex min-h-0 flex-1 flex-col"
					>
					{view === "map" ? <MapView /> : null}
					{view === "today" ? <TodayView /> : null}
					{view === "decisions" ? <DecisionsView /> : null}
					{view === "recap" ? <RecapView /> : null}
					{view === "overview" ? <OverviewView /> : null}
					{view === "team" ? <TeamView /> : null}
					{view === "agents" ? <AgentsView /> : null}
					{view === "methods" ? <MethodsView /> : null}
					{view === "replay" ? <ReplayView /> : null}
					{view === "libres" ? <LibresView /> : null}
					{view === "missions" ? <MissionsView /> : null}
					{view === "permanence" ? <PermanenceView /> : null}
					{view === "worktrees" ? <WorktreesView /> : null}
					{view === "git" ? <GitView /> : null}
					{view === "scripts" ? <ScriptsView /> : null}
					{view === "docs" ? <DocsView /> : null}
					{view === "observability" ? <ObservabilityView /> : null}
					{view === "delivery" ? <DeliveryView /> : null}
					{view === "impact" ? <ImpactView /> : null}
					{view === "infra" ? <InfraView /> : null}
					{view === "settings" ? <SettingsView /> : null}
					</motion.div>
					</ViewBoundary>
				</main>
			)}

			{/* Hors de l'écran Workspaces, le dock est la seule trace de ce qui
			    tourne : sans lui, des agents et des serveurs de dev
			    travailleraient sans que rien ne le signale. Dedans, le rail des
			    workspaces le dit déjà, en haut et sans se superposer. */}
			</div>

			{/* Ni sur l'écran Workspaces ni sur la carte : l'un et l'autre montrent
			    déjà chaque chantier, le dock n'y ferait que les répéter. */}
			{workspaceView || view === "map" || view === "libres" ? null : <WorkspaceDock />}

			{paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}

			{/* Le lanceur d'agent libre, ouvrable de partout (⌘N). */}
			<LibreHost />

			{/* Ce qui tourne en arrière-plan : visible où que l'on soit. */}
			<ActivityPanel />

			<UpdateBanner />

			{/* Une image ouverte en grand, d'où qu'on l'ait touchée. */}
			<Lightbox />

			{/* Les notifications s'empilent au lieu de s'écraser, et peuvent
			    porter un geste — « Relire », « Voir ». */}
			<Toaster
				position="bottom-center"
				theme={resolvedTheme}
				gap={8}
				toastOptions={{
					classNames: {
						toast:
							"!rounded-xl !border-0 !bg-surface !text-ink !shadow-[var(--shadow-pop)] !font-sans !text-[12.5px]",
						description: "!text-ink-muted",
						actionButton: "!bg-accent !text-accent-ink !rounded-lg !font-semibold",
						error: "!text-critical",
						success: "!text-ink",
					},
				}}
			/>
		</div>
	);
}

export function App() {
	return (
		<CockpitProvider>
			{/* Au-dessus du shell : conversations et shells doivent survivre au
			    repli du panneau qui les affiche. `WorkspaceProvider` vient en
			    premier — c'est lui qui dit ce qui est visible, et les deux
			    registres en dépendent pour savoir ce qui mérite une pastille. */}
			<WorkspaceProvider>
				<TerminalsProvider>
					<AgentRunsProvider>
						<ConfirmProvider>
							{/* Au-dessus du shell : un lien de fichier peut être cliqué
							    depuis n'importe quel écran, et la lecture se superpose à
							    celui qu'on regarde sans le remplacer. */}
							<FileViewerProvider>
								{/* Sous les deux registres : c'est ce qui tourne
								    qu'il enregistre, et il les rouvre au réveil. */}
								{/* La visite lit les agents en direct et ouvre des
								    fichiers : sous les deux. */}
								<ChangeTourProvider>
								<HibernateProvider>
									{/* Au-dessus du shell : la carte de mise à jour et le
									    bouton des réglages regardent le même état, sans quoi
									    l'un annonce une version que l'autre ignore. */}
									<UpdateProvider>
										<Shell />
										{/* Par-dessus tout, sous tous les registres : il pilote
										    ce que les écrans pilotent. */}
										<Assistant />
									</UpdateProvider>
								</HibernateProvider>
								</ChangeTourProvider>
							</FileViewerProvider>
						</ConfirmProvider>
					</AgentRunsProvider>
				</TerminalsProvider>
			</WorkspaceProvider>
		</CockpitProvider>
	);
}
