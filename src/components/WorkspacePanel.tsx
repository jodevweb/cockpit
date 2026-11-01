import { open } from "@tauri-apps/plugin-dialog";
import { rememberFolder } from "@/lib/recentFolders";
import { isLibreRun, useLibres } from "@/lib/libre";
import clsx from "clsx";
import {
	Bot,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Coins,
	Eraser,
	FolderGit2,
	FolderOpen,
	GitBranch,
	Globe,
	Layers,
	ListChecks,
	LayoutDashboard,
	Moon,
	Square,
	Terminal,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { AgentChat, RunState } from "@/components/AgentChat";
import { BranchBoard } from "@/components/BranchBoard";
import { BrowserView } from "@/components/BrowserView";
import { useReviewFlow } from "@/app/review";
import { FileFinder } from "@/components/FileFinder";
import { SatellitesProvider, type Satellites } from "@/components/WorkspaceTiles";
import { totalSpend } from "@/components/MissionHistory";
import { QuickMenu, type QuickAction } from "@/components/QuickMenu";
import { TerminalView } from "@/components/TerminalView";
import { useConfirm } from "@/components/Confirm";
import { PortsMonitor } from "@/components/PortsMonitor";
import { Badge, Button, Dot, Empty } from "@/components/ui";
import { truncate } from "@/lib/format";
import { api } from "@/lib/ipc";
import { findIntegrationWorktree, MISSION_STATE_LABELS } from "@/lib/missions";
import {
	looksLikeBranch,
	createWorktreeTracked,
} from "@/lib/worktreeFlow";
import type { PermissionRequest } from "@/lib/types";
import { usePersistentState, useAsync } from "@/lib/useAsync";
import { useAgentRuns, type AgentRun } from "@/app/agents";
import { useCockpit } from "@/app/store";
import { useTerminals, type TerminalTab } from "@/app/terminals";
import { isQuestion } from "@/app/agents";
import { useHibernate, type SleepingGroup } from "@/app/hibernate";
import { useWorkspace, type TabRef } from "@/app/workspace";
import { dragRegion, formatShortcut } from "@/lib/platform";
import { basename } from "@/lib/paths";

/**
 * Un workspace : un worktree, ses agents, ses terminaux.
 *
 * Un seul endroit où le travail vivant s'affiche, en pleine largeur. Il a
 * longtemps existé aussi en panneau ancré à droite, visible par-dessus
 * n'importe quel écran ; c'était une deuxième fenêtre sur les mêmes objets, et
 * sur l'écran Agents elle donnait deux fois la même conversation — la vraie à
 * droite, sa copie relue du disque à gauche.
 *
 * Ce qui tourne ailleurs se rappelle depuis le dock, en bas à droite : un clic
 * ramène ici. Seules les croix arrêtent quelque chose.
 */

export interface WorkGroup {
	cwd: string;
	label: string;
	runs: AgentRun[];
	terminals: TerminalTab[];
	/** Onglets dans l'ordre d'affichage : agents d'abord, terminaux ensuite. */
	tabs: TabRef[];
	/**
	 * La mission qui a fait naître ce dossier, quand il en vient une.
	 *
	 * Un plan de cinq tâches ouvre cinq worktrees, donc cinq workspaces : alignés
	 * à plat, ils noyaient le reste et ne disaient plus à quoi ils servaient. Ce
	 * rattachement permet de les présenter ensemble, sous le nom de la mission.
	 */
	mission: { id: string; title: string; role: string } | null;
}

/** `2056`, `#2056` ou l'adresse d'une PR → son numéro. */
function prNumberOf(query: string): number | null {
	const text = query.trim();
	const match = text.match(/^#?(\d{1,6})$/) ?? text.match(/\/pull\/(\d{1,6})\b/);
	return match ? Number(match[1]) : null;
}

function same(a: TabRef | null, b: TabRef | null): boolean {
	return a !== null && b !== null && a.kind === b.kind && a.id === b.id;
}

/**
 * Nom d'onglet dans un groupe déjà titré par sa branche.
 *
 * Répéter le dossier sur chaque onglet ne distingue rien : ce qu'on cherche,
 * c'est lequel des deux agents, ou lequel des trois terminaux. On ne numérote
 * donc qu'à partir du deuxième, et un terminal nommé garde son nom.
 */
function tabName(base: string, index: number, total: number, custom?: string): string {
	if (custom) return custom;
	return total > 1 ? `${base} ${index + 1}` : base;
}

/**
 * Nom d'un onglet de conversation.
 *
 * « Agent 1 », « Agent 2 » ne distinguent rien dès qu'on en a trois sur le même
 * worktree : on ouvre les trois pour retrouver le bon. La consigne qu'on a
 * donnée, elle, dit de quoi il s'agit. On ne prend pas l'activité en cours,
 * pourtant plus précise : un onglet qui se renomme à chaque outil appelé n'est
 * plus un repère. Sans consigne — un agent ouvert pour discuter — le numéro
 * reste le seul nom possible.
 */
function agentTabName(
	run: AgentRun,
	index: number,
	total: number,
	role?: string,
): string {
	const prompt = run.turns.find((turn) => turn.kind === "user")?.text ?? "";
	const line = prompt
		.split("\n")
		.find((entry) => entry.trim())
		?.trim();
	if (line) return truncate(line, 30);
	// Sans consigne, le rôle que ce chantier tient dans sa mission dit encore
	// quelque chose — « recette » se reconnaît, « Agent 2 » non.
	if (role) return tabName(role, index, total);
	return tabName(t("components3:workspacePanel.tabs.agent"), index, total);
}

/**
 * Ce qu'on lit en survolant un onglet : où il travaille, puis sur quoi.
 *
 * La branche titre déjà le workspace au-dessus, mais un onglet se survole sans
 * lever les yeux — et avec plusieurs workspaces ouverts, savoir lequel on
 * s'apprête à rejoindre évite d'y envoyer une commande de travers.
 */
function tabTitle(group: WorkGroup, detail?: string): string {
	const folder = basename(group.cwd);
	const place = folder === group.label ? group.label : `${group.label} · ${folder}`;
	return detail ? `${place}\n${group.cwd}\n\n${detail}` : `${place}\n${group.cwd}`;
}

/**
 * Les groupes de travail en cours.
 *
 * Un groupe existe tant qu'il lui reste un agent ou un terminal : c'est ce qui
 * tourne qui le fait vivre, pas une déclaration. Le nom vient de la branche du
 * worktree quand on la connaît — « feat/auth » dit plus que « monorepo-feat-auth ».
 */
export function useWorkGroups(): WorkGroup[] {
	const { runs: all } = useAgentRuns();
	// Les agents libres ont leur écran : un workspace ne se forme pas autour
	// d'eux. Relu à chaque changement du registre, pour qu'un agent revenu de
	// son relais n'y apparaisse pas le temps d'être reconnu.
	const registry = useLibres();
	const runs = useMemo(() => all.filter((run) => !isLibreRun(run)), [all, registry]);
	const { tabs: terminals } = useTerminals();
	const { worktrees, missions, config } = useCockpit();
	const { t } = useTranslation("components3");

	// À quel dépôt appartient chaque dossier ouvert. Un workspace n'est qu'un
	// dossier avec des agents dedans : rien n'y disait de quel projet il
	// relevait, et changer de projet laissait donc les mêmes onglets à l'écran,
	// venus d'un autre dépôt.
	const dossiers = useMemo(
		() =>
			[...new Set([...runs.map((run) => run.cwd), ...terminals.map((t) => t.cwd)])].sort(),
		[runs, terminals],
	);
	const origines = useAsync(
		(): Promise<Record<string, string>> =>
			dossiers.length > 0 ? api.worktrees.reposOf(dossiers) : Promise.resolve({}),
		[dossiers.join("|")],
	);

	// À quelle mission appartient chaque dossier — celui du maître comme ceux
	// des exécutants. Le rôle sert de nom court : dans une mission, « backend »
	// distingue mieux qu'une branche dont les cinq versions partagent le préfixe.
	const belongsTo = useMemo(() => {
		const table = new Map<string, { id: string; title: string; role: string }>();
		for (const mission of missions) {
			// Le maître travaille dans le worktree de la branche d'intégration, pas
			// dans `mission.cwd` — celui-ci est le dépôt principal, où le cockpit
			// n'écrit jamais. Les rattacher revenait à étiqueter la copie de
			// travail de l'utilisateur « mission · maître » dès qu'il y ouvrait un
			// terminal, et à laisser le vrai workspace du maître passer pour un
			// dossier ordinaire, détaché de la mission qui l'a fait naître.
			const integration = findIntegrationWorktree(mission, worktrees);
			if (integration) {
				table.set(integration.path, {
					id: mission.id,
					title: mission.title,
					role: t("workspacePanel.masterRole"),
				});
			}
			for (const task of mission.tasks) {
				if (task.worktree) {
					table.set(task.worktree, {
						id: mission.id,
						title: mission.title,
						role: task.role,
					});
				}
			}
		}
		return table;
	}, [missions, worktrees, t]);

	return useMemo(() => {
		const groups = new Map<string, WorkGroup>();
		const reach = (cwd: string) => {
			const existing = groups.get(cwd);
			if (existing) return existing;
			const tree = worktrees.find((entry) => entry.path === cwd);
			const group: WorkGroup = {
				cwd,
				label: tree?.branch ?? tree?.folderName ?? basename(cwd),
				runs: [],
				terminals: [],
				tabs: [],
				mission: belongsTo.get(cwd) ?? null,
			};
			groups.set(cwd, group);
			return group;
		};

		for (const run of runs) reach(run.cwd).runs.push(run);
		for (const terminal of terminals) reach(terminal.cwd).terminals.push(terminal);

		for (const group of groups.values()) {
			group.tabs = [
				...group.runs.map((run) => ({ kind: "agent" as const, id: run.id })),
				...group.terminals.map((terminal) => ({
					kind: "terminal" as const,
					id: terminal.id,
				})),
			];
		}

		// Ce qui relève d'un autre projet sort de l'écran. On ne masque que ce
		// qu'on sait classer ailleurs : un dossier hors dépôt, ou un dépôt qu'on
		// n'a pas encore résolu, reste visible plutôt que de disparaître sans
		// que rien ne l'explique.
		const repo = (config?.mainRepo ?? "").replace(/\/+$/, "");
		const table = origines.data ?? {};
		return [...groups.values()].filter((group) => {
			if (!repo) return true;
			const origine = (table[group.cwd] ?? "").replace(/\/+$/, "");
			return origine === "" || origine === repo;
		});
	}, [runs, terminals, worktrees, belongsTo, origines.data, config?.mainRepo]);
}

/** Ce qu'un groupe donne à voir de loin, sans l'ouvrir. */
interface GroupSignals {
	waiting: boolean;
	asking: boolean;
	busy: boolean;
	live: boolean;
	unread: number;
}

/**
 * Un agent bloqué sur une autorisation — ou sur une question qu'il nous pose —
 * ne repart pas tout seul : il expire au bout de cinq minutes. C'est le seul
 * signal qui ne peut pas attendre qu'on regarde.
 */
function groupSignals(
	group: WorkGroup,
	pendingFor: (runId: string) => PermissionRequest[],
): GroupSignals {
	const requests = group.runs.flatMap((run) => pendingFor(run.id));
	return {
		waiting: requests.length > 0,
		asking: requests.some(isQuestion),
		busy: group.runs.some((run) => run.thinking),
		live:
			group.runs.some((run) => run.running) ||
			group.terminals.some((terminal) => terminal.running),
		unread:
			group.runs.reduce((total, run) => total + run.unread, 0) +
			group.terminals.filter((terminal) => terminal.unread).length,
	};
}

/**
 * Les workspaces ouverts, en tête d'écran.
 *
 * L'écran Workspaces n'en montre qu'un à la fois : les autres se lisent ici,
 * en clair et à leur place — le dock flottant, lui, ne sert qu'aux écrans qui
 * n'en montrent aucun. La barre reste affichée même avec un seul workspace,
 * parce que c'est aussi d'ici qu'on en ouvre un autre.
 */
/**
 * La croix d'une entrée du rail.
 *
 * Révélée au survol : une croix permanente sur chaque entrée transformerait la
 * barre en tableau de bord de suppression, alors qu'on y vient pour choisir où
 * travailler. Elle reste atteignable au clavier — le conteneur la montre dès que
 * le focus entre.
 *
 * `stopPropagation` parce que la zone cliquable est juste à côté : sans lui, on
 * sélectionnerait le workspace qu'on vient de fermer.
 */
function RailClose({ title, onClose }: { title: string; onClose: () => void }) {
	return (
		<button
			type="button"
			title={title}
			onClick={(event) => {
				event.stopPropagation();
				onClose();
			}}
			className="focus-ring -mr-1 ml-0.5 shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-critical focus-visible:opacity-100"
		>
			<X size={10} />
		</button>
	);
}

/** Clé stable d'une entrée du rail, celle sous laquelle son rang est retenu. */
function rowKey(row: RailRow): string {
	return row.kind === "mission" ? `mission:${row.id}` : `group:${row.group.cwd}`;
}

/**
 * L'ordre du rail, tel qu'on l'a arrangé.
 *
 * Sans lui, les entrées suivent l'ordre d'ouverture des agents : celui qu'on
 * regarde le plus se retrouve au fond dès qu'on ouvre autre chose, et il n'y
 * avait aucun moyen de ranger sa barre. L'ordre vit dans le poste plutôt que
 * dans la configuration : c'est une disposition d'écran, elle n'a pas à voyager
 * d'une machine à l'autre ni à figurer dans un fichier qu'on relit.
 *
 * Une entrée inconnue va au bout, dans son ordre naturel — un workspace qui
 * s'ouvre ne doit pas s'insérer au milieu de ce qu'on avait rangé. Une entrée
 * fermée garde sa place : rouverte, elle la retrouve.
 */
function useRailOrder() {
	const [order, setOrder] = usePersistentState<string[]>("workspace.railOrder", []);

	const sort = useCallback(
		(rows: RailRow[]) => {
			if (order.length === 0) return rows;
			const rank = new Map(order.map((key, index) => [key, index]));
			return rows
				.map((row, index) => ({ row, index, rank: rank.get(rowKey(row)) }))
				.sort((a, b) => {
					// Les inconnues restent groupées à la fin, dans leur ordre d'arrivée.
					if (a.rank === undefined && b.rank === undefined) return a.index - b.index;
					if (a.rank === undefined) return 1;
					if (b.rank === undefined) return -1;
					return a.rank - b.rank;
				})
				.map((entry) => entry.row);
		},
		[order],
	);

	/** Déplace `dragged` à la place de `target`, et retient le tout. */
	const move = useCallback(
		(rows: RailRow[], dragged: string, target: string) => {
			const keys = rows.map(rowKey);
			const from = keys.indexOf(dragged);
			const to = keys.indexOf(target);
			if (from === -1 || to === -1 || from === to) return;
			keys.splice(to, 0, keys.splice(from, 1)[0]);

			setOrder((previous) => {
				// Ce qui n'est pas à l'écran garde son rang derrière : une barre rangée
				// ne doit pas se défaire parce qu'un workspace était fermé ce jour-là.
				const visible = new Set(keys);
				const absent = previous.filter((key) => !visible.has(key));
				return [...keys, ...absent].slice(0, 100);
			});
		},
		[setOrder],
	);

	return { sort, move };
}

function GroupRail({
	groups,
	sleeping,
	activeCwd,
	pendingFor,
	onSelect,
	onWake,
	onCloseGroup,
	onCloseMission,
	onForget,
}: {
	groups: WorkGroup[];
	sleeping: SleepingGroup[];
	activeCwd: string | null;
	pendingFor: (runId: string) => PermissionRequest[];
	onSelect: (cwd: string) => void;
	onWake: (cwd: string) => void;
	/** Quitter un workspace sans y entrer : c'est ce que la croix promet. */
	onCloseGroup: (group: WorkGroup) => void;
	onCloseMission: (title: string, members: WorkGroup[]) => void;
	/** Oublier un workspace endormi — rien à arrêter, juste une empreinte. */
	onForget: (cwd: string) => void;
}) {
	// Les workspaces d'une même mission comptent pour une entrée : c'est la
	// mission qu'on choisit d'abord, ses worktrees ensuite. Les autres restent
	// tels quels — un workspace ouvert à la main n'appartient à personne.
	const natural: RailRow[] = [];
	const missionAt = new Map<string, number>();
	for (const group of groups) {
		if (!group.mission) {
			natural.push({ kind: "group", group });
			continue;
		}
		const seen = missionAt.get(group.mission.id);
		if (seen === undefined) {
			missionAt.set(group.mission.id, natural.length);
			natural.push({
				kind: "mission",
				id: group.mission.id,
				title: group.mission.title,
				members: [group],
			});
			continue;
		}
		(natural[seen] as MissionRow).members.push(group);
	}

	const { go, missions } = useCockpit();
	const { t } = useTranslation("components3");
	const { sort, move } = useRailOrder();
	const rows = sort(natural);

	// Le déplacement se fait au pointeur, pas au glisser-déposer HTML.
	//
	// La première version s'appuyait sur l'API `dragstart`/`drop` : on attrapait
	// bien une entrée, mais rien ne tombait. Deux raisons se cumulent, et aucune
	// ne se corrige d'ici. Le webview intercepte le dépôt natif — il faut bien,
	// c'est par là qu'arrivent les fichiers joints aux conversations — et les
	// rendus déclenchés pendant le geste interrompent la séquence.
	//
	// Les événements de pointeur ne dépendent d'aucun de ces mécanismes : on suit
	// le doigt, on regarde ce qu'il survole, et on range au relâchement. Le clic
	// ordinaire survit — sans franchir le seuil de quelques pixels, rien ne
	// commence, et le bouton de l'entrée reçoit son clic comme avant.
	const grabbed = useRef<{ key: string; x: number; y: number } | null>(null);
	const [moving, setMoving] = useState<string | null>(null);
	const [over, setOver] = useState<string | null>(null);
	// La cible vit aussi dans une référence : au relâchement, on la lit sans
	// passer par un calcul de state. Un `setState` dont la fonction déplace
	// vraiment l'entrée serait rejoué deux fois en mode strict, et le rangement se
	// ferait deux fois.
	const overRef = useRef<string | null>(null);
	const aim = (key: string | null) => {
		overRef.current = key;
		setOver(key);
	};

	useEffect(() => {
		const follow = (event: PointerEvent) => {
			const held = grabbed.current;
			if (!held) return;
			const far =
				Math.abs(event.clientX - held.x) > 4 || Math.abs(event.clientY - held.y) > 4;
			if (!far) return;
			setMoving(held.key);
			// Ce qui est sous le pointeur, quelle que soit la profondeur du nœud :
			// les entrées portent leur clé, c'est elle qu'on remonte.
			const target = document
				.elementFromPoint(event.clientX, event.clientY)
				?.closest("[data-rail-key]");
			const key = target?.getAttribute("data-rail-key") ?? null;
			aim(key === held.key ? null : key);
		};

		const drop = () => {
			const held = grabbed.current;
			const target = overRef.current;
			grabbed.current = null;
			aim(null);
			setMoving(null);
			// La cible est celle que l'utilisateur voyait surlignée : c'est la
			// promesse que fait le surlignage.
			if (held && target && target !== held.key) move(rows, held.key, target);
		};

		window.addEventListener("pointermove", follow);
		window.addEventListener("pointerup", drop);
		window.addEventListener("pointercancel", drop);
		return () => {
			window.removeEventListener("pointermove", follow);
			window.removeEventListener("pointerup", drop);
			window.removeEventListener("pointercancel", drop);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rows.map(rowKey).join("|")]);

	/** Ce qu'une entrée doit porter pour être saisie et reconnue. */
	const dragHandlers = (row: RailRow) => {
		const key = rowKey(row);
		return {
			"data-rail-key": key,
			"data-tauri-drag-region": "false",
			onPointerDown: (event: React.PointerEvent) => {
				// Bouton principal seulement : un clic droit ouvre un menu, il ne
				// déplace rien.
				if (event.button !== 0) return;
				grabbed.current = { key, x: event.clientX, y: event.clientY };
			},
			className: clsx(
				moving === key && "opacity-40",
				over === key && "ring-1 ring-accent-soft/60",
			),
		};
	};

	const openMission = rows.find(
		(row): row is MissionRow =>
			row.kind === "mission" && row.members.some((member) => member.cwd === activeCwd),
	);

	return (
		// Le défilement horizontal est enfermé dans la liste, et n'englobe pas le
		// bouton : un conteneur qui défile rogne ce qui dépasse de lui, et le
		// panneau du menu — plus haut que cette barre — s'y trouvait coupé à sa
		// première ligne.
		<div className="hairline-b flex flex-col">
			{/* Cette bande longe le haut de la fenêtre, à droite de la barre de
			    titre en surimpression : c'est elle qu'on vise pour déplacer ou
			    agrandir l'app, et elle ne répondait pas — il fallait aller
			    chercher la colonne de gauche. Les entrées, elles, se refusent au
			    geste : elles se déplacent au pointeur pour être réordonnées, et
			    un glissement qui emmène la fenêtre entière les figerait. */}
			<div data-tauri-drag-region={dragRegion} className="flex items-center gap-1 px-2 py-1.5">
				<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
					{rows.map((row) => {
						if (row.kind === "mission") {
							const signals = row.members
								.map((member) => groupSignals(member, pendingFor))
								.reduce((total, entry) => ({
									waiting: total.waiting || entry.waiting,
									asking: total.asking || entry.asking,
									busy: total.busy || entry.busy,
									live: total.live || entry.live,
									unread: total.unread + entry.unread,
								}));
							const selected = openMission?.id === row.id;
							const drag = dragHandlers(row);
							return (
								<div
									key={`mission-${row.id}`}
									{...drag}
									className={clsx(
										"group flex h-7 shrink-0 items-center rounded-lg pr-2 pl-2.5 text-[11px] transition-colors",
										selected
											? "bg-accent-dim text-accent-soft"
											: signals.waiting
												? "text-warning hover:bg-hover"
												: "text-ink-muted hover:bg-hover",
										drag.className,
									)}
								>
									<button
										type="button"
										// Rouvrir une mission retombe sur celui de ses worktrees
										// qu'on regardait, ou sur le premier.
										onClick={() =>
											onSelect(
												(row.members.find((member) => member.cwd === activeCwd) ??
													row.members[0]).cwd,
											)
										}
										title={t("workspacePanel.rail.missionTitle", {
										title: row.title,
										count: row.members.length,
									})}
										className="focus-ring flex min-w-0 items-center gap-1.5"
									>
										<Layers size={11} className="shrink-0" />
										<span className="max-w-44 truncate font-medium">{row.title}</span>
										{/* Ce nombre compte les chantiers de la mission, pas ses
										    agents — un chiffre nu à côté d'un titre se lit
										    pourtant comme un nombre d'agents, et faisait
										    chercher l'écart. L'icône dit ce qu'on compte. */}
										<span className="flex shrink-0 items-center gap-0.5 rounded-full bg-raised px-1 text-[10px] font-semibold text-ink-faint">
											<GitBranch size={9} />
											{row.members.length}
										</span>
										{!selected && signals.unread > 0 ? (
											<span className="rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
												{signals.unread}
											</span>
										) : null}
									</button>
									<RailClose
										title={t("workspacePanel.rail.closeMission", { count: row.members.length })}
										onClose={() => onCloseMission(row.title, row.members)}
									/>
								</div>
							);
						}

						const group = row.group;
						const signals = groupSignals(group, pendingFor);
						const selected = group.cwd === activeCwd;
						const drag = dragHandlers(row);
						return (
							<div
								key={group.cwd}
								{...drag}
								className={clsx(
									"group flex h-7 shrink-0 items-center rounded-lg pr-2 pl-2.5 text-[11px] transition-colors",
									selected
										? "bg-accent-dim text-accent-soft"
										: signals.waiting
											? "text-warning hover:bg-hover"
											: "text-ink-muted hover:bg-hover",
									drag.className,
								)}
							>
								<button
									type="button"
									onClick={() => onSelect(group.cwd)}
									title={group.cwd}
									className="focus-ring flex min-w-0 items-center gap-1.5"
								>
									<Dot
										tone={signals.waiting ? "warning" : signals.live ? "success" : "neutral"}
										pulse={signals.busy || signals.waiting}
									/>
									<span className="max-w-44 truncate font-medium">{group.label}</span>
									{!selected && signals.unread > 0 ? (
										<span className="rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
											{signals.unread}
										</span>
									) : null}
								</button>
								<RailClose
									title={t("workspacePanel.closeWorkspace")}
									onClose={() => onCloseGroup(group)}
								/>
							</div>
						);
					})}

				{/* Ce qui dort se range après ce qui tourne, en retrait : présent
				    pour qu'on sache que le chantier existe encore, discret pour
				    qu'il ne dispute pas la place à ce qui travaille. */}
				{sleeping.map((entry) => (
					<div
						key={`sleeping-${entry.cwd}`}
						className="group flex h-7 shrink-0 items-center rounded-lg border border-dashed border-line pr-2 pl-2.5 text-[11px] text-ink-faint transition-colors hover:bg-hover hover:text-ink-muted"
					>
						<button
							type="button"
							onClick={() => onWake(entry.cwd)}
							title={t("workspacePanel.rail.sleepingTitle", {
								cwd: entry.cwd,
								state: describeSleeping(entry),
							})}
							className="focus-ring flex min-w-0 items-center gap-1.5"
						>
							<Moon size={10} className="shrink-0" />
							<span className="max-w-44 truncate">{entry.label}</span>
						</button>
						{/* Rien ne tourne ici : l'oublier ne coupe aucun travail, seulement
						    la trace qui le proposait à la reprise. Pas de confirmation. */}
						<RailClose
							title={t("workspacePanel.rail.forgetSleeping")}
							onClose={() => onForget(entry.cwd)}
						/>
					</div>
				))}
				</div>
				<div className="shrink-0 pl-1">
					<NewGroupMenu label={t("workspacePanel.rail.newWorkspace")} align="right" />
				</div>
			</div>

			{/* Second niveau : les worktrees de la mission ouverte. Il n'apparaît
			    que pour elle — une barre qui montrerait tout le temps tous les
			    sous-dossiers de toutes les missions ne regrouperait rien. */}
			{openMission ? (
				// Cette barre dit qu'on n'est pas dans un workspace ordinaire mais
				// dans une mission : son liseré, son état et son avancement. Sans
				// eux, cinq dossiers ouverts sur des branches jumelles ne se
				// distinguaient d'un chantier lancé à la main que par un bouton
				// nommé « Mission », qui ne disait ni laquelle ni où elle en était.
				<div className="flex items-center gap-1 overflow-x-auto border-t border-l-2 border-l-accent/60 border-t-line-soft/60 bg-accent/[0.04] px-2 py-1">
					{/* Le chemin de retour vers la mission : on travaille dans ses
					    worktrees, et rien ici n'y ramenait — il fallait passer par le
					    menu, en se rappelant de quelle mission il s'agissait. */}
					<button
						type="button"
						title={t("workspacePanel.rail.openMission", { title: openMission.title })}
						onClick={() => go("missions")}
						className="focus-ring flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-accent-soft hover:bg-hover"
					>
						<ListChecks size={11} className="shrink-0" />
						<span className="max-w-52 truncate font-semibold">{openMission.title}</span>
						{(() => {
							const suivie = missions.find((entry) => entry.id === openMission.id);
							if (!suivie) return null;
							const total = suivie.tasks.length;
							const rendues = suivie.tasks.filter((task) =>
								["delivered", "integrated"].includes(task.state),
							).length;
							const etats = MISSION_STATE_LABELS;
							return (
								<span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-ink-faint">
									<span>{etats[suivie.state] ?? suivie.state}</span>
									{total > 0 ? (
										<span>
											{t("workspacePanel.rail.delivered", { done: rendues, total })}
										</span>
									) : null}
								</span>
							);
						})()}
					</button>
					<span className="mx-0.5 h-4 w-px shrink-0 bg-line-soft" />
					{openMission.members.map((member) => {
						const signals = groupSignals(member, pendingFor);
						const selected = member.cwd === activeCwd;
						return (
							<div
								key={member.cwd}
								className={clsx(
									"group flex h-6 shrink-0 items-center rounded-md pr-1.5 pl-2 text-[11px] transition-colors",
									selected
										? "bg-raised text-ink"
										: signals.waiting
											? "text-warning hover:bg-hover"
											: "text-ink-faint hover:bg-hover hover:text-ink-muted",
								)}
							>
								<button
									type="button"
									onClick={() => onSelect(member.cwd)}
									title={`${member.mission?.role ?? ""}\n${member.cwd}`}
									className="focus-ring flex min-w-0 items-center gap-1.5"
								>
									<Dot
										tone={signals.waiting ? "warning" : signals.live ? "success" : "neutral"}
										pulse={signals.busy || signals.waiting}
									/>
									<span className="max-w-36 truncate font-medium">
										{member.mission?.role ?? member.label}
									</span>
									{!selected && signals.unread > 0 ? (
										<span className="rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
											{signals.unread}
										</span>
									) : null}
								</button>
								<RailClose
									title={t("workspacePanel.rail.closeMissionWorkspace")}
									onClose={() => onCloseGroup(member)}
								/>
							</div>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

/**
 * Une entrée de la barre : un workspace seul, ou une mission et les siens.
 */
type RailRow =
	| { kind: "group"; group: WorkGroup }
	| { kind: "mission"; id: string; title: string; members: WorkGroup[] };

type MissionRow = Extract<RailRow, { kind: "mission" }>;

/** Ce qu'un workspace endormi contenait, en une ligne. */
function describeSleeping(entry: SleepingGroup): string {
	const parts: string[] = [];
	if (entry.agents.length > 0) {
		parts.push(t("components3:workspacePanel.summary.agents", { count: entry.agents.length }));
	}
	if (entry.terminals.length > 0) {
		parts.push(
			t("components3:workspacePanel.summary.terminals", { count: entry.terminals.length }),
		);
	}
	return parts.length > 0
		? t("components3:workspacePanel.sleeping.withParts", { parts: parts.join(" · ") })
		: t("components3:workspacePanel.sleeping.empty");
}

/**
 * Ouvrir un workspace sur le worktree de son choix.
 *
 * Un workspace naissait jusqu'ici d'un geste fait ailleurs — lancer un agent
 * depuis l'écran Worktrees, un terminal depuis une PR — ce qui obligeait à
 * quitter l'écran Workspaces pour en commencer un. La liste est celle des
 * worktrees : c'est le seul choix qui compte, l'agent et le shell s'ajoutent
 * ensuite dans le workspace.
 *
 * Entrée lance un agent, ⇧Entrée ouvre un terminal — les deux façons d'entrer
 * dans un dossier, sans avoir à choisir un mode avant de savoir quoi y faire.
 */
function NewGroupMenu({ label, align }: { label: string; align?: "left" | "right" }) {
	const { worktrees, config, reloadWorktrees, worktreesLoading, notify, runJob } =
		useCockpit();
	const { open: openAgent } = useAgentRuns();
	const { t } = useTranslation("components3");
	const terminals = useTerminals();
	const groups = useWorkGroups();
	const mainRepo = config?.mainRepo ?? null;

	// Les branches ne se lisent qu'à l'ouverture du menu : c'est un appel git de
	// plus, inutile tant qu'on ne cherche pas où travailler.
	const [opened, setOpened] = useState(false);
	// `includeRemote` : la branche qu'on vient relire est presque toujours celle
	// d'un collègue, poussée et jamais sortie ici. Sans les distantes, la
	// chercher ne donnait rien et il fallait passer par l'écran Worktrees.
	const branches = useAsync(() => api.git.branches(undefined, true), [], { enabled: opened });

	/**
	 * Ouvrir un dossier que le cockpit ne connaît pas.
	 *
	 * La liste ci-dessous ne montre que les worktrees du dépôt principal du
	 * projet actif : un worktree d'un autre dépôt, un dossier cloné à la main,
	 * un checkout de passage n'y figurent pas, et rien ne permettait d'y
	 * travailler. Le sélecteur du système, lui, atteint tout le disque.
	 */
	const browse = useCallback(async () => {
		const chosen = await open({
			directory: true,
			multiple: false,
			title: t("workspacePanel.menu.browseDialog"),
			defaultPath: config?.projectsRoot || config?.mainRepo || undefined,
		});
		if (typeof chosen === "string") {
			openAgent(chosen, "", undefined, undefined, true);
			rememberFolder(chosen);
		}
	}, [config?.mainRepo, config?.projectsRoot, openAgent, t]);

	/**
	 * Lancer la création d'un worktree, puis ouvrir son workspace.
	 *
	 * La création part dans un agent sur le dépôt principal ; le guet, lui,
	 * attend que le worktree existe pour ouvrir ce qu'on voulait depuis le
	 * début. Sans lui, ce menu rendait la main sur un agent en train de
	 * travailler, et il fallait revenir ici coller la même branche.
	 */
	const startReview = useReviewFlow();
	const createAndOpen = useCallback(
		(branch: string) => {
			if (!mainRepo) return;
			// Suivie dans le centre d'activité : la création dure des minutes, et
			// son échec se disait seulement dans une notification fugace.
			void createWorktreeTracked(
				branch,
				{ mainRepo, runJob, openAgent: (cwd, prompt) => openAgent(cwd, prompt, undefined, undefined, true) },
				{
					onReady: (path) => {
						reloadWorktrees();
						openAgent(path, "", undefined, undefined, true);
					},
				},
			).catch(() => undefined);
		},
		[mainRepo, openAgent, reloadWorktrees, runJob],
	);

	const actions = useMemo<QuickAction[]>(() => {
		const known = new Set(groups.map((group) => group.cwd));
		const places = worktrees.map((tree) => ({
			path: tree.path,
			// Une HEAD détachée n'a pas de branche : la nommer par son dossier
			// laisserait croire qu'on va travailler sur une branche du même nom,
			// et deux worktrees peuvent porter le même nom de dossier.
			name: tree.branch ?? tree.folderName,
			folder: tree.folderName,
			detached: tree.isDetached,
		}));
		// Le dépôt principal n'est pas toujours listé comme worktree, et c'est
		// pourtant là qu'on travaille le plus souvent.
		if (mainRepo && !places.some((place) => place.path === mainRepo)) {
			places.unshift({
				path: mainRepo,
				name: basename(mainRepo),
				folder: basename(mainRepo),
				detached: false,
			});
		}

		const list: QuickAction[] = [
			{
				id: "browse",
				group: t("workspacePanel.menu.browseGroup"),
				label: t("workspacePanel.menu.browseLabel"),
				hint: t("workspacePanel.menu.browseHint"),
				run: () => void browse(),
			},
		];

		list.push(
			...places.map((place) => ({
				id: place.path,
				group: t("workspacePanel.menu.worktreesGroup"),
				label: place.name,
				hint: place.folder === place.name ? place.path : place.folder,
				note: place.detached
					? t("workspacePanel.menu.detachedHead")
					: known.has(place.path)
						? t("workspacePanel.menu.alreadyOpen")
						: undefined,
				run: () => openAgent(place.path, "", undefined, undefined, true),
				extra: {
					icon: Terminal,
					title: t("workspacePanel.menu.openTerminalHere"),
					run: () => terminals.open(place.path),
				},
			})),
		);

		// Une branche sans worktree ne peut pas encore accueillir de workspace.
		// Plutôt que de la taire, on propose de le créer — en déléguant à
		// `/create-worktree`, qui monte l'infra namespacée du dépôt (base,
		// bucket, Redis) et connaît ses gardes. Le cockpit n'a pas à refaire ce
		// travail : il dériverait dès que les conventions bougeraient.
		// Rien tant que la relecture est en cours : `for-each-ref` sur trois
		// cents branches prend une seconde ou deux, et pendant ce temps la liste
		// d'avant est fausse — elle proposait de créer un worktree pour une
		// branche qui venait d'en recevoir un.
		if (mainRepo && !branches.loading) {
			for (const branch of branches.data?.branches ?? []) {
				if (branch.worktreePath) continue;
				list.push({
					id: `branch:${branch.remote}/${branch.name}`,
					group: branch.remoteOnly
						? t("workspacePanel.menu.remoteBranchesGroup")
						: t("workspacePanel.menu.localBranchesGroup"),
					label: branch.name,
					hint: branch.remoteOnly
						? t("workspacePanel.menu.remoteBranchHint", { remote: branch.remote })
						: t("workspacePanel.menu.localBranchHint"),
					note: branch.lastCommit?.author || t("workspacePanel.menu.creationNote"),
					run: () => createAndOpen(branch.name),
				});
			}
		}

		return list;
	}, [
		branches.data,
		branches.loading,
		browse,
		createAndOpen,
		groups,
		mainRepo,
		openAgent,
		terminals,
		worktrees,
		t,
	]);

	return (
		<QuickMenu
			label={label}
			icon={FolderGit2}
			title={t("workspacePanel.menu.title")}
			actions={actions}
			// Les deux listes viennent d'un scan périodique : sans relecture à
			// l'ouverture, un worktree créé à l'instant n'y est pas, et une
			// branche changée depuis y porte encore son ancien nom. On demande
			// donc l'état frais au moment précis où on s'apprête à le lire.
			onOpen={() => {
				reloadWorktrees();
				if (opened) branches.reload();
				else setOpened(true);
			}}
			loading={worktreesLoading || branches.loading}
			emptyMessage={t("workspacePanel.menu.empty")}
			// Coller une branche que le cockpit n'a pas encore vue — parce qu'elle
			// vient d'être poussée et qu'on n'a pas refetché — ne doit pas finir sur
			// « rien à ce nom ». C'est le geste le plus courant avant une relecture.
			onQuery={useCallback(
				(query: string) => {
					// Un numéro ou une adresse de PR : on relit, ou on ouvre seulement
					// sa branche. C'était le geste le plus courant — copier la
					// branche d'une PR pour la coller ici avant de la relire.
					const pr = prNumberOf(query);
					if (pr) {
						return {
							id: `pr:${pr}`,
							group: t("workspacePanel.menu.prGroup"),
							label: `PR #${pr}`,
							hint: t("workspacePanel.menu.prHint"),
							note: t("workspacePanel.menu.prNote"),
							run: (): void => void startReview(pr, "revue").catch((error) => notify(String(error))),
							extra: {
								icon: FolderGit2,
								title: t("workspacePanel.menu.prOpenBranch"),
								run: (): void =>
									void api.reviews
										.prepare(pr, "revue")
										.then((prepared) =>
											prepared.worktree
												? openAgent(prepared.worktree, "", undefined, undefined, true)
												: createAndOpen(prepared.branch),
										)
										.catch((error) => notify(String(error))),
							},
						};
					}
					return mainRepo && looksLikeBranch(query)
						? {
								id: `create:${query}`,
								group: t("workspacePanel.menu.newBranchGroup"),
								label: query,
								hint: t("workspacePanel.menu.newBranchHint"),
								note: t("workspacePanel.menu.creationNote"),
								run: () => createAndOpen(query),
							}
						: null;
				},
				[createAndOpen, mainRepo, startReview, notify, openAgent, t],
			)}
			align={align}
		/>
	);
}

/**
 * Ce que ce chantier a fait tourner jusqu'ici.
 *
 * Un chiffre, et le détail au survol : combien d'agents, combien sont morts
 * sans rien rendre, et ce que les moteurs annoncent avoir consommé. Rien ne
 * s'affiche quand il n'y a rien à dire — un zéro se lirait comme « gratuit »
 * là où il veut dire « on ne sait pas ».
 */
function WorkspaceSpend({ cwd }: { cwd: string }) {
	const runs = useAsync(() => api.executions.forWorkspace(cwd), [cwd], {
		pollMs: 60_000,
	});
	const spend = totalSpend(runs.data ?? []);
	if (!spend) return null;
	return (
		<span
			className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-ink-faint"
			title={spend.title}
		>
			<Coins size={10} />
			{spend.label}
		</span>
	);
}

/**
 * L'écran quand aucun workspace n'est ouvert.
 *
 * C'est un écran entier : autant qu'il dise par où commencer, plutôt que de
 * rester vide en attendant qu'on devine.
 */
function WorkspaceEmpty() {
	const { t } = useTranslation("components3");
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
			<Empty
				icon={Bot}
				message={t("workspacePanel.empty.message")}
				hint={t("workspacePanel.empty.hint")}
			/>
			{/* L'enchaînement, montré plutôt qu'expliqué. C'est la question qui
			    revient le plus de ceux qui découvrent — « comment j'ouvre un agent
			    sur une branche ? » — et elle ne se pose qu'ici, devant un écran
			    qui ne disait rien de la marche à suivre. */}
			<div className="flex items-center gap-2 text-[11px] text-ink-faint">
				<span className="flex items-center gap-1.5">
					<GitBranch size={12} className="text-accent-soft" />
					{t("workspacePanel.empty.stepBranch")}
				</span>
				<ChevronRight size={11} className="text-ink-faint/60" />
				<span className="flex items-center gap-1.5">
					<FolderOpen size={12} className="text-accent-soft" />
					{t("workspacePanel.empty.stepFolder")}
				</span>
				<ChevronRight size={11} className="text-ink-faint/60" />
				<span className="flex items-center gap-1.5">
					<Bot size={12} className="text-accent-soft" />
					{t("workspacePanel.empty.stepAgents")}
				</span>
			</div>
			<NewGroupMenu label={t("workspacePanel.empty.openBranch")} />
		</div>
	);
}

export function WorkspacePanel() {
	const workspace = useWorkspace();
	const groups = useWorkGroups();
	const agents = useAgentRuns();
	const terminals = useTerminals();
	const { confirm } = useConfirm();
	const { t } = useTranslation("components3");
	const { sleeping, sleep, wake, forget } = useHibernate();

	const owned = groups.find((entry) => entry.cwd === workspace.cwd) ?? null;
	// Un workspace qui se ferme ne doit pas laisser l'écran nu le temps que
	// l'état rattrape : on bascule sur le suivant dès ce rendu-ci, les effets
	// ci-dessous ne font que l'inscrire.
	const group = owned ?? groups[groups.length - 1] ?? null;
	// L'onglet retenu peut avoir été fermé depuis le dock : on retombe alors sur
	// le premier du groupe plutôt que d'afficher un panneau vide.
	//
	// La vue de branche, le territoire et le navigateur ne sont plus des onglets dès
	// qu'un agent est là : ils sont épinglés en tuiles sur sa carte, où on les
	// voit sans quitter ce qu'il fait. Un worktree sans agent n'a pas de carte :
	// il garde la vue de branche et le navigateur en onglets — il a déjà sa PR,
	// son ticket, ses commits et ses documents.
	const bare = group !== null && group.runs.length === 0;
	const boardTab: TabRef | null = group && bare ? { kind: "board", id: group.cwd } : null;
	const browserTab: TabRef | null = group && bare ? { kind: "browser", id: group.cwd } : null;
	const driving = group ? drivingTool(group.runs) : null;
	const devCommand = useCockpit().config?.workflow?.devCommand?.trim() ?? "";
	const active =
		group === null
			? null
			: browserTab && workspace.tab?.kind === "browser"
				? browserTab
				: boardTab && workspace.tab?.kind === "board"
					? boardTab
					: (group.tabs.find((tab) => same(tab, workspace.tab)) ?? group.tabs[0] ?? boardTab);

	// Le reste de l'app ouvre encore « la vue de branche » d'un dossier (après
	// une revue lancée, par exemple). Avec un agent, c'est une tuile de sa
	// carte : on y va, et on l'ouvre.
	const [ask, setAsk] = useState<Satellites["ask"]>(null);
	const [, setLecture] = usePersistentState<"carte" | "fil">("agent.lecture", "carte");
	const asked = workspace.tab;
	const firstRun = group?.runs[0]?.id ?? null;
	useEffect(() => {
		if (!asked || !firstRun) return;
		const tile = asked.kind === "board" ? "branch" : asked.kind === "map" ? "territory" : asked.kind === "browser" ? "browser" : null;
		if (!tile) return;
		setAsk({ runId: firstRun, tile, at: Date.now() });
		setLecture("carte");
	}, [asked, firstRun, setLecture]);

	const drivingKey = driving ? `${driving.runId}:${driving.tool}` : "";
	const devRunning = group?.terminals.some((entry) => entry.label === "dev") ?? false;
	const openTerminal = terminals.open;
	const satellites = useMemo<Satellites | null>(
		() =>
			group && group.runs.length > 0
				? {
						group,
						driving,
						// Un terminal « dev » déjà ouvert ici : il démarre, ou il a
						// échoué — dans les deux cas on n'en lance pas un second.
						onStartServer:
							devCommand && !devRunning
								? () => openTerminal(group.cwd, { command: devCommand, label: "dev", background: true })
								: undefined,
						ask,
					}
				: null,
		// `driving` est recalculé à chaque rendu : sa clé dit s'il a changé.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[group, drivingKey, devCommand, devRunning, openTerminal, ask],
	);

	// Fermer un workspace arrête tout ce qu'il contient — des agents au milieu
	// d'une édition, des serveurs de dev. On le demande donc, en nommant ce qui va
	// s'arrêter : la croix d'un onglet ne se rattrape déjà pas.
	//
	// Défini pour n'importe quel groupe, et non pour celui qu'on regarde : la
	// croix du rail doit pouvoir quitter un workspace sans qu'on ait à y entrer
	// d'abord — c'était trois gestes pour en fermer un.
	const closeWorkGroup = async (target: WorkGroup) => {
		const ok = await confirm({
			title: t("workspacePanel.confirm.closeTitle", { label: target.label }),
			message: t("workspacePanel.confirm.message", { what: summary(target) }),
			confirmLabel: t("workspacePanel.confirm.closeLabel"),
			danger: true,
		});
		if (!ok) return;
		for (const tab of target.tabs) {
			if (tab.kind === "agent") agents.close(tab.id);
			else terminals.close(tab.id);
		}
		void api.browser.stop(target.cwd).catch(() => undefined);
		// Fermer est définitif : sans cet oubli, l'empreinte de la session le
		// ferait réapparaître endormi au prochain lancement.
		forget(target.cwd);
	};

	/** Une mission tient plusieurs workspaces : on les nomme avant de tout fermer. */
	const closeMission = async (title: string, members: WorkGroup[]) => {
		const ok = await confirm({
			title: t("workspacePanel.confirm.closeMissionTitle", { count: members.length, title }),
			message: t("workspacePanel.confirm.message", {
				what: members.map((member) => member.label).join(", "),
			}),
			confirmLabel: t("workspacePanel.confirm.closeAll"),
			danger: true,
		});
		if (!ok) return;
		for (const member of members) {
			for (const tab of member.tabs) {
				if (tab.kind === "agent") agents.close(tab.id);
				else terminals.close(tab.id);
			}
			void api.browser.stop(member.cwd).catch(() => undefined);
			forget(member.cwd);
		}
	};

	const { cwd: openCwd, minimize, showGroup, show, tab: remembered } = workspace;

	useEffect(() => {
		// Le groupe s'est vidé — dernier agent arrêté, dernier terminal fermé.
		if (openCwd && owned === null) minimize();
	}, [minimize, openCwd, owned]);
	useEffect(() => {
		if (group && active && !same(active, remembered)) show(group.cwd, active);
	}, [active, group, remembered, show]);
	useEffect(() => {
		// Un workspace replié laisserait l'écran vide alors qu'il reste du travail
		// ouvert : on retombe sur le dernier.
		if (openCwd === null && groups.length > 0) {
			showGroup(groups[groups.length - 1].cwd);
		}
	}, [groups, openCwd, showGroup]);

	// Un écran sans workspace vivant garde le rail : c'est là que dorment ceux
	// de la veille, et sans lui on ne saurait pas qu'ils existent.
	if (!group || !active) {
		return (
			<section className="flex min-w-0 flex-1 flex-col bg-surface">
				<GroupRail
					groups={groups}
					sleeping={sleeping}
					activeCwd={null}
					pendingFor={agents.pendingFor}
					onSelect={showGroup}
					onWake={wake}
					onCloseGroup={(target) => void closeWorkGroup(target)}
					onCloseMission={(title, members) => void closeMission(title, members)}
					onForget={forget}
				/>
				<WorkspaceEmpty />
			</section>
		);
	}

	const run =
		active.kind === "agent"
			? (group.runs.find((entry) => entry.id === active.id) ?? null)
			: null;
	const terminal =
		active.kind === "terminal"
			? (group.terminals.find((entry) => entry.id === active.id) ?? null)
			: null;

	const closeTab = (tab: TabRef) => {
		if (tab.kind === "agent") agents.close(tab.id);
		else terminals.close(tab.id);
	};

	// Fermer un workspace de mission ferme la mission entière. Il en tient
	// autant qu'elle a d'exécutants, plus celui du maître : les fermer un par
	// un demandait cinq clics et cinq confirmations pour un seul geste, et rien
	// ne disait qu'il en restait. La croix d'un onglet, elle, ne ferme toujours
	// que son onglet.
	const closeGroup = () => {
		if (!group.mission) return closeWorkGroup(group);
		const members = groups.filter(
			(entry) => entry.mission?.id === group.mission?.id,
		);
		return members.length > 1
			? closeMission(group.mission.title, members)
			: closeWorkGroup(group);
	};

	return (
		<section className="animate-in relative flex h-full min-w-0 flex-1 flex-col bg-surface">
			<GroupRail
				groups={groups}
				sleeping={sleeping}
				activeCwd={group.cwd}
				pendingFor={agents.pendingFor}
				onSelect={showGroup}
				onWake={wake}
				onCloseGroup={(target) => void closeWorkGroup(target)}
				onCloseMission={(title, members) => void closeMission(title, members)}
				onForget={forget}
			/>

			{/* Cet écran n'a pas d'en-tête de vue : c'est cette barre qui tient
			    lieu de barre de titre, donc aussi de poignée de fenêtre. */}
			<div
				data-tauri-drag-region={dragRegion}
				className="hairline-b flex items-center gap-1.5 px-2.5 py-2"
			>
				<GitBranch size={13} className="shrink-0 text-accent-soft" />
				{/* Le rôle avant la branche quand le workspace vient d'une mission :
				    ses cinq worktrees partagent le même préfixe de branche, et
				    « backend » dit du premier coup lequel on regarde. */}
				{group.mission ? (
					// La barre de mission juste au-dessus porte déjà son titre, son état
					// et son avancement : le répéter ici mangeait une ligne pour redire
					// ce qu'on venait de lire. Reste ce qu'elle ne dit pas — le rôle de
					// ce dossier-ci, et sa branche.
					<span
						className="shrink-0 truncate text-[12.5px] font-semibold text-ink"
						title={`${group.mission.title}\n${group.cwd}`}
					>
						{group.mission.role}
						<span className="ml-1.5 font-mono text-[11px] font-normal text-ink-faint">
							{group.label}
						</span>
					</span>
				) : (
					<span
						className="shrink-0 truncate text-[12.5px] font-semibold text-ink"
						title={group.cwd}
					>
						{group.label}
					</span>
				)}
				{/* Le dossier, quand la branche ne le nomme pas : deux worktrees de
				    la même branche existent, et c'est là qu'on écrit.
				    `shrink-0` et non `flex-1` : depuis que les onglets partagent
				    cette ligne, deux `flex-1` s'y disputaient la place à parts
				    égales — les onglets se retrouvaient poussés au milieu, sur la
				    moitié de la largeur, avec du vide de chaque côté. L'espace
				    restant revient entièrement à ce qu'on ouvre. */}
				{basename(group.cwd) === group.label ? null : (
					<span
						className="max-w-32 shrink-0 truncate font-mono text-[10px] text-ink-faint"
						title={group.cwd}
					>
						{basename(group.cwd)}
					</span>
				)}
				{/* Ce que ce chantier a déjà fait tourner, agents refermés compris.
				    Les jauges plus bas ne parlent que de la conversation ouverte ;
				    fermer un onglet effaçait tout le reste, alors que le relevé le
				    garde. */}
				<WorkspaceSpend cwd={group.cwd} />
				<span className="mx-0.5 h-4 w-px shrink-0 bg-line-soft" />

			{/* Même précaution que sur le rail : le défilement horizontal reste
			    enfermé dans la liste des onglets. Un conteneur qui défile rogne
			    ce qui dépasse de lui, et les menus ouverts depuis les boutons de
			    droite — plus hauts que cette barre — s'y trouvaient coupés à
			    leur première ligne. */}
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
					{boardTab ? (
						<TabChip
							icon={LayoutDashboard}
							label={t("workspacePanel.tabs.board")}
							title={t("workspacePanel.tabs.boardTitle")}
							tone="neutral"
							pulse={false}
							badge={null}
							selected={active.kind === "board"}
							onSelect={() => show(group.cwd, boardTab)}
						/>
					) : null}
					{browserTab ? (
						<TabChip
							icon={Globe}
							label={t("workspacePanel.tabs.browser")}
							title={t("workspacePanel.tabs.browserTitle")}
							tone="neutral"
							pulse={false}
							badge={null}
							selected={active.kind === "browser"}
							onSelect={() => show(group.cwd, browserTab)}
						/>
					) : null}
					{group.runs.map((entry, index) => (
						<TabChip
							key={entry.id}
							icon={Bot}
							label={agentTabName(entry, index, group.runs.length, group.mission?.role)}
							title={tabTitle(
								group,
								entry.turns.find((turn) => turn.kind === "user")?.text,
							)}
							tone={entry.running ? "success" : "neutral"}
							pulse={entry.thinking}
							badge={entry.unread > 0 ? String(entry.unread) : null}
							selected={active.kind === "agent" && active.id === entry.id}
							onSelect={() => agents.show(entry.id)}
							onClose={() => closeTab({ kind: "agent", id: entry.id })}
							closeTitle={t("workspacePanel.tabs.closeAgent")}
						/>
					))}
					{group.terminals.map((entry, index) => (
						<TabChip
							key={entry.id}
							icon={Terminal}
							label={tabName(
								t("workspacePanel.tabs.terminal"),
								index,
								group.terminals.length,
								entry.label,
							)}
							title={tabTitle(group)}
							tone={entry.running ? "info" : "neutral"}
							pulse={false}
							badge={entry.unread ? "•" : null}
							selected={active.kind === "terminal" && active.id === entry.id}
							onSelect={() => show(group.cwd, { kind: "terminal", id: entry.id })}
							onClose={() => closeTab({ kind: "terminal", id: entry.id })}
							closeTitle={t("workspacePanel.tabs.closeTerminal")}
						/>
					))}
				{/* Deux boutons nommés plutôt qu'un « + » : il n'ouvrait que des
				    terminaux, et rien ne disait où ajouter un agent. */}
			</div>
			<div className="flex shrink-0 items-center gap-1 pl-1">
					{/* Ce qui écoute ici, à côté de ce qui s'y édite : la question
					    « sur quel port tourne ce chantier » se pose depuis le
					    workspace, pas depuis l'inventaire général de la machine. */}
					<PortsMonitor cwd={group.cwd} label={group.label} />
					<FileFinder group={group} />
					<Button
						size="sm"
						icon={Bot}
						onClick={() => agents.open(group.cwd, "", undefined, undefined, true)}
						title={t("workspacePanel.toolbar.addAgentTitle")}
					>
						{t("workspacePanel.toolbar.addAgent")}
					</Button>
					<Button
						size="sm"
						icon={Terminal}
						onClick={() => terminals.open(group.cwd)}
						title={t("workspacePanel.toolbar.addTerminalTitle")}
					>
						{t("workspacePanel.toolbar.addTerminal")}
					</Button>
				
				{run ? <RunState run={run} /> : null}
				{run?.running ? (
					<Button
						size="sm"
						icon={Square}
						onClick={() => agents.stop(run.id)}
						title={t("workspacePanel.toolbar.stop")}
					/>
				) : null}

				{terminal ? (
					<>
						<Badge tone={terminal.running ? "success" : "neutral"}>
							{terminal.running ? t("workspacePanel.status.shell") : t("workspacePanel.status.finished")}
						</Badge>
						{terminal.running ? (
							<Button
								size="sm"
								onClick={() => terminals.interrupt(terminal.id)}
								title={t("workspacePanel.toolbar.interrupt")}
							>
								{formatShortcut("⌃C")}
							</Button>
						) : null}
						<Button
							size="sm"
							icon={Eraser}
							onClick={() => terminals.clear(terminal.id)}
							title={t("workspacePanel.toolbar.clear")}
						/>
					</>
				) : null}

				{/* Ranger plutôt que fermer : les processus s'arrêtent — ils ne
				    survivent de toute façon pas à l'app — mais le workspace reste
				    dans le rail, prêt à reprendre sa conversation là où elle en
				    était. C'est le geste courant ; la croix, elle, est définitive. */}
				<Button
					size="sm"
					icon={Moon}
					onClick={() => sleep(group.cwd)}
					title={t("workspacePanel.toolbar.sleep")}
				/>
				{/* Fermer le workspace, pas l'onglet : les croix des onglets ne
				    ferment qu'eux, et rien n'arrêtait un workspace entier. */}
				<Button
					size="sm"
					icon={X}
					onClick={() => void closeGroup()}
					title={
						group.mission
							? t("workspacePanel.toolbar.closeMission", { title: group.mission.title })
							: t("workspacePanel.closeWorkspace")
					}
				/>
			</div>
			</div>

			{/* Tous les onglets du groupe restent montés, seul le visible est
			    affiché. Les démonter revenait à reconstruire une conversation
			    entière — jusqu'à six cents tours, chacun remis en markdown — à
			    chaque aller-retour entre un agent et un terminal : le clic
			    suivant tombait pendant ce travail et semblait ignoré. Masqué par
			    `visibility`, pas par `display` : le second remet les dimensions à
			    zéro, ce dont ni le défilement d'une conversation ni la grille
			    d'un émulateur ne se remettent. */}
			<div className="relative min-h-0 flex-1">
				<SatellitesProvider value={satellites}>
				{boardTab ? (
					<TabPane active={active.kind === "board"}>
						<BranchBoard group={group} active={active.kind === "board"} />
					</TabPane>
				) : null}
				{browserTab ? (
					<TabPane active={active.kind === "browser"}>
						<BrowserView
							cwd={group.cwd}
							active={active.kind === "browser"}
							driving={null}
							onStartServer={
								// Un terminal « dev » déjà ouvert ici : il démarre, ou il a
								// échoué — dans les deux cas on n'en lance pas un second.
								devCommand && !group.terminals.some((entry) => entry.label === "dev")
									? () => terminals.open(group.cwd, { command: devCommand, label: "dev", background: true })
									: undefined
							}
						/>
					</TabPane>
				) : null}
				{group.runs.map((entry) => (
					<TabPane
						key={`agent-${entry.id}`}
						active={active.kind === "agent" && active.id === entry.id}
					>
						<AgentChat
							run={entry}
							active={active.kind === "agent" && active.id === entry.id}
						/>
					</TabPane>
				))}
				{group.terminals.map((entry) => (
					<TabPane
						key={`terminal-${entry.id}`}
						active={active.kind === "terminal" && active.id === entry.id}
					>
						<TerminalView
							tab={entry}
							active={active.kind === "terminal" && active.id === entry.id}
						/>
					</TabPane>
				))}
				</SatellitesProvider>
			</div>
		</section>
	);
}

/**
 * L'outil de navigateur qu'un agent de ce workspace emploie en ce moment.
 *
 * On ne lit que la fin de chaque conversation : la question est « maintenant »,
 * et ce calcul repasse à chaque événement de chaque agent. Les sous-agents
 * comptent — c'est souvent à eux qu'on confie la recette.
 */
function drivingTool(runs: AgentRun[]): Satellites["driving"] {
	const pending = (turns: AgentRun["turns"]): string | null => {
		for (const turn of turns.slice(-4).reverse()) {
			if (turn.kind !== "tool" || turn.output !== undefined) continue;
			if (turn.tool?.startsWith("mcp__navigateur__")) return turn.tool.slice("mcp__navigateur__".length);
			if (turn.sub) {
				const inner = pending(turn.sub);
				if (inner) return inner;
			}
		}
		return null;
	};
	for (const run of runs) {
		if (!run.thinking) continue;
		const tool = pending(run.turns);
		if (tool) return { runId: run.id, label: run.label, tool };
	}
	return null;
}

function TabPane({ active, children }: { active: boolean; children: React.ReactNode }) {
	return (
		<div
			aria-hidden={!active}
			className={clsx(
				"absolute inset-0 flex flex-col",
				!active && "invisible pointer-events-none",
			)}
		>
			{children}
		</div>
	);
}

function TabChip({
	icon: Icon,
	label,
	title,
	tone,
	pulse,
	badge,
	selected,
	onSelect,
	onClose,
	closeTitle,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>;
	label: string;
	/** Survol : le workspace, puis la consigne en entier — le nom est tronqué. */
	title: string;
	tone: "success" | "info" | "neutral" | "critical";
	pulse: boolean;
	badge: string | null;
	selected: boolean;
	onSelect: () => void;
	/** Absent : l'onglet n'a rien à arrêter (la carte du chantier). */
	onClose?: () => void;
	closeTitle?: string;
}) {
	return (
		<div
			className={clsx(
				"group flex h-6 shrink-0 items-center gap-1.5 rounded-lg pr-1 pl-2 text-[11px] transition-colors",
				selected ? "bg-accent-dim text-accent-soft" : "text-ink-muted hover:bg-hover",
			)}
		>
			<Icon size={11} className="shrink-0" />
			<Dot tone={tone} pulse={pulse} />
			<button
				type="button"
				onClick={onSelect}
				title={title}
				className="focus-ring max-w-44 truncate rounded"
			>
				{label}
			</button>
			{badge ? (
				<span className="rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
					{badge}
				</span>
			) : null}
			{/* La croix arrête un processus : elle ne s'affiche que sur l'onglet
			    visé, pour ne pas se cliquer par ricochet. */}
			{onClose ? (
				<button
					type="button"
					onClick={onClose}
					title={closeTitle}
					className={clsx(
						"focus-ring rounded p-0.5 opacity-0 transition-opacity hover:text-critical group-hover:opacity-100",
						selected && "opacity-60",
					)}
				>
					<X size={10} />
				</button>
			) : null}
		</div>
	);
}

/**
 * Workspaces en cours, en bas à droite des écrans qui ne les montrent pas.
 *
 * C'est leur seule trace quand on regarde ailleurs : sans elle, des agents et
 * des serveurs de dev continueraient de tourner sans que rien ne le signale.
 * Il les liste **tous**, y compris celui que l'écran Workspaces affichera —
 * hors de cet écran, aucun n'est plus visible que les autres.
 *
 * Un clic ramène à l'écran Workspaces, sur le groupe entier et l'onglet qu'on
 * y regardait : `showGroup` et `agents.show` y naviguent d'eux-mêmes.
 *
 * Il se coupe, et ce n'est pas un caprice de réglage : selon la façon de
 * travailler, ce rappel est le fil qui retient ce qui tourne, ou un encombrement
 * permanent pour qui retourne de toute façon dans l'écran Workspaces. Les deux
 * usages sont réels, aucun n'a raison contre l'autre.
 */
export const DOCK_KEY = "workspace.dock";

export function WorkspaceDock() {
	const { show, showGroup } = useWorkspace();
	const { go } = useCockpit();
	const { t } = useTranslation("components3");
	const groups = useWorkGroups();
	const agents = useAgentRuns();
	const terminals = useTerminals();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [visible] = usePersistentState(DOCK_KEY, true);

	if (!visible || groups.length === 0) return null;

	const reach = (cwd: string, tab?: TabRef) => {
		if (tab) show(cwd, tab);
		else showGroup(cwd);
		go("workspace");
	};

	return (
		<div className="animate-in fixed right-4 bottom-4 z-30 flex flex-col items-end gap-1.5">
			{groups.map((group) => {
				const { waiting, asking, busy, live, unread } = groupSignals(
					group,
					agents.pendingFor,
				);
				const open = expanded === group.cwd;

				return (
					<div
						key={group.cwd}
						className={clsx(
							"panel flex flex-col shadow-xl shadow-black/40",
							waiting && "border-warning/50",
						)}
					>
						<div className="flex items-center gap-2 py-1 pr-1 pl-2.5">
							<Dot
								tone={waiting ? "warning" : live ? "success" : "neutral"}
								pulse={busy || waiting}
							/>
							<button
								type="button"
								onClick={() => reach(group.cwd)}
								title={t("workspacePanel.dock.openTitle", { cwd: group.cwd })}
								className="focus-ring flex items-center gap-2 rounded-lg text-[11px] text-ink"
							>
								<span className="max-w-44 truncate font-medium">{group.label}</span>
								<span
									className={clsx(
										"text-[10px]",
										waiting ? "text-warning" : "text-ink-faint",
									)}
								>
									{asking
										? t("workspacePanel.status.asking")
										: waiting
											? t("workspacePanel.status.permission")
											: summary(group)}
								</span>
								{unread > 0 ? (
									<span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-ink">
										{unread}
									</span>
								) : null}
							</button>
							<Button
								size="sm"
								icon={open ? ChevronDown : ChevronUp}
								onClick={() => setExpanded(open ? null : group.cwd)}
								title={open ? t("workspacePanel.dock.collapse") : t("workspacePanel.dock.expand")}
							/>
						</div>

						{open ? (
							<div className="flex flex-col gap-0.5 border-t border-line-soft p-1">
								{group.runs.map((run, index) => (
									<DockRow
										key={run.id}
										icon={Bot}
										label={agentTabName(run, index, group.runs.length)}
										title={tabTitle(
											group,
											run.turns.find((turn) => turn.kind === "user")?.text,
										)}
										hint={
											agents.pendingFor(run.id).some(isQuestion)
												? t("workspacePanel.status.asking")
												: agents.pendingFor(run.id).length > 0
													? t("workspacePanel.status.permission")
													: run.running
														? run.thinking
															? (run.activity ?? t("workspacePanel.status.thinking"))
															: t("workspacePanel.status.ready")
														: t("workspacePanel.status.finished")
										}
										tone={run.running ? "success" : "neutral"}
										pulse={run.thinking}
										onSelect={() => reach(group.cwd, { kind: "agent", id: run.id })}
										onClose={() => agents.close(run.id)}
										closeTitle={t("workspacePanel.tabs.closeAgent")}
									/>
								))}
								{group.terminals.map((terminal, index) => (
									<DockRow
										key={terminal.id}
										icon={Terminal}
										label={tabName(
											t("workspacePanel.tabs.terminal"),
											index,
											group.terminals.length,
											terminal.label,
										)}
										title={tabTitle(group)}
										hint={
											terminal.running
												? t("workspacePanel.status.shellOpen")
												: t("workspacePanel.status.finished")
										}
										tone={terminal.running ? "info" : "neutral"}
										pulse={false}
										onSelect={() => reach(group.cwd, { kind: "terminal", id: terminal.id })}
										onClose={() => terminals.close(terminal.id)}
										closeTitle={t("workspacePanel.tabs.closeTerminal")}
									/>
								))}
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function summary(group: WorkGroup): string {
	const parts: string[] = [];
	if (group.runs.length > 0) {
		parts.push(t("components3:workspacePanel.summary.agents", { count: group.runs.length }));
	}
	if (group.terminals.length > 0) {
		parts.push(
			t("components3:workspacePanel.summary.terminals", { count: group.terminals.length }),
		);
	}
	return parts.join(" · ");
}

function DockRow({
	icon: Icon,
	label,
	title,
	hint,
	tone,
	pulse,
	onSelect,
	onClose,
	closeTitle,
}: {
	icon: React.ComponentType<{ size?: number; className?: string }>;
	label: string;
	title: string;
	hint: string;
	tone: "success" | "info" | "neutral";
	pulse: boolean;
	onSelect: () => void;
	onClose: () => void;
	closeTitle: string;
}) {
	return (
		<div className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-hover">
			<Icon size={11} className="shrink-0 text-ink-faint" />
			<Dot tone={tone} pulse={pulse} />
			<button
				type="button"
				onClick={onSelect}
				title={title}
				className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded text-left"
			>
				<span className="min-w-0 max-w-36 truncate text-[11px] text-ink-muted">
					{label}
				</span>
				<span className="ml-auto shrink-0 text-[10px] text-ink-faint">{hint}</span>
			</button>
			<button
				type="button"
				onClick={onClose}
				title={closeTitle}
				className="focus-ring rounded p-0.5 text-ink-faint opacity-0 transition-opacity hover:text-critical group-hover:opacity-100"
			>
				<X size={10} />
			</button>
		</div>
	);
}
