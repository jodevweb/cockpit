import {
	Background,
	BackgroundVariant,
	Handle,
	Position,
	ReactFlow,
	useReactFlow,
	useStore,
	type Edge,
	type Node,
	type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import {
	AlertTriangle,
	Bot,
	Check,
	ChevronsLeftRight,
	ExternalLink,
	GitBranch,
	GitCommitHorizontal,
	GitPullRequest,
	ChevronsRightLeft,
	FileCode2,
	FileText,
	FlaskConical,
	HelpCircle,
	Images,
	LocateFixed,
	ClipboardCheck,
	Diff,
	MessageSquarePlus,
	Minimize2,
	MessageSquareText,
	Send,
	PackageCheck,
	Repeat,
	Route,
	Search,
	Sparkles,
	Terminal,
	User,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ShellView } from "@/components/ShellView";
import { SidePanel } from "@/components/SidePanel";
import { RAIL_WIDTH, TILE_TITLES, TileBody, TileRail, useHasTiles, type TileId } from "@/components/WorkspaceTiles";
import { Markdown } from "@/components/Markdown";
import { RemarkTray } from "@/components/ChantierMap";
import { Button } from "@/components/ui";
import { lastCompaction } from "@/lib/chantier";
import { addRemark, composeRemarks, useAllRemarks } from "@/lib/remarks";
import { Diagram, firstDiagram } from "@/components/Diagram";
import { Illustration } from "@/components/Illustration";
import { illustrationsOf, type Illustration as IllustrationItem } from "@/lib/illustrations";
import { useTranslation } from "react-i18next";
import { t as translate } from "@/i18n";

/** Les textes de la carte, hors composant : appelé au rendu, jamais au chargement. */
function tr(key: string, options?: Record<string, unknown>): string {
	return translate(`components2:agentMap.${key}`, options);
}

/** Le genre d'une illustration, dit en un mot sur la carte. */
function genreShort(genre: IllustrationItem["genre"]): string {
	return tr(`genre.${genre}`);
}
import { MediaThumb } from "@/components/MediaThumb";
import { delivered, isEmpty, type Delivered } from "@/lib/delivered";
import { useFileViewer } from "@/lib/fileViewer";
import { footprint, headline, tileWidth, type Fate, type Footprint } from "@/lib/footprint";
import { useNodeSizes } from "@/lib/flowSizes";
import { api } from "@/lib/ipc";
import { firstCommit, hasWork } from "@/lib/tour";
import { useAsync } from "@/lib/useAsync";
import { attachedMedia, seenMedia, splitAttachments, stageOf, type Media } from "@/lib/media";
import { openLightbox } from "@/components/Lightbox";
import { backgroundPending, REVIEW_TOOL, useAgentActions, type Turn } from "@/app/agents";
import { useReview, useReviewFlow } from "@/app/review";
import { ReviewPanel } from "@/components/ReviewPanel";
import { useCockpit } from "@/app/store";
import {
	commandOf,
	episodes,
	gestureOf,
	loops,
	pathOf,
	summarize,
	tookOf,
	type Episode,
	type Loop,
} from "@/lib/episodes";
import { duration, fromSeconds } from "@/lib/format";

/**
 * La carte d'un agent : ce qu'il fait, dessiné plutôt que raconté.
 *
 * Le fil de conversation est un journal : il dit tout, dans l'ordre, et laisse
 * au lecteur le soin d'y trouver ce qui compte. La carte fait ce tri. Pour
 * l'épisode en cours — une consigne et ce qui y répond — elle montre les
 * étapes qui valent un regard : ce qu'il a exploré, ce qu'il a confié à des
 * sous-agents, chaque fichier changé, les tests, sa conclusion. L'étape en
 * cours respire ; ce qui a échoué est rouge ; ce qui t'attend est orange et
 * passe devant tout le reste.
 *
 * Rien n'est perdu : chaque nœud garde les tours d'où il vient, et les rouvre
 * tels quels dans le panneau de détail.
 */

type Phase = "done" | "live" | "failed" | "yours" | "idle";

interface MapNode extends Record<string, unknown> {
	icon: "ask" | "explore" | "agent" | "change" | "test" | "run" | "answer" | "question" | "live" | "episode" | "visual" | "delivered" | "review" | "footprint";
	phase: Phase;
	eyebrow: string;
	title: string;
	detail?: string;
	/** Petites pastilles : une par fichier lu, par exemple. */
	dots?: Array<{ key: string; label: string; tone?: "failed" }>;
	bars?: { added: number; removed: number; scale: number };
	turns: Turn[];
	/** Pour le nœud de conclusion : le texte entier, à lire dans le panneau. */
	markdown?: string;
	selected?: boolean;
	/** Une remarque attend d'être envoyée à propos de cette étape. */
	remarked?: boolean;
	/** L'épisode d'où vient ce nœud, pour le replier ou le déplier d'un clic. */
	episode?: number;
	/** Un clic replie ou déplie l'épisode plutôt que d'ouvrir le détail. */
	toggles?: "expand" | "collapse";
	/** Ce qui se regarde : en mosaïque sur la carte, en galerie dans le détail. */
	media?: Media[];
	/** Le temps passé sur cette étape, du premier appel au dernier retour. */
	took?: number | null;
	/** Une répétition qui mérite un regard : « repris 6 fois en 14m ». */
	warn?: string;
	/** Pour l'étape en cours : depuis quand elle tourne. */
	since?: number | null;
	/** Ce que l'épisode a livré, pour le panneau de détail. */
	delivered?: Delivered;
	/** La PR dont l'agent a remis la revue : le détail montre la revue entière. */
	review?: number;
	/** Le schéma que porte ce message, dessiné sur la carte avant son texte. */
	diagram?: string;
	/** Les images que l'agent a décrites pour sa conclusion (`illustrer`). */
	illustrations?: IllustrationItem[];
	/** Le constat tiré du dépôt : ce qui a réellement changé, zone par zone. */
	footprint?: Footprint;
	/** L'agent est dans son shell : les commandes de la consigne, à lire en terminal. */
	shell?: Turn[];
	/** Sa dernière commande a répondu : il la lit, rien ne tourne. */
	pondering?: boolean;
}

const ICONS = {
	ask: User,
	explore: Search,
	agent: Bot,
	change: FileCode2,
	test: FlaskConical,
	run: Terminal,
	answer: Sparkles,
	question: HelpCircle,
	live: Bot,
	episode: User,
	visual: Images,
	delivered: PackageCheck,
	review: ClipboardCheck,
	footprint: Diff,
};

const WIDTH = 236;
const COL = 290;
const ROW = 132;

/** La place qu'une carte prend dans sa colonne : une mosaïque la rallonge. */
function heightOf(data: MapNode): number {
	const count = data.media?.length ?? 0;
	const warn = data.warn ? 18 : 0;
	if (data.footprint) return ROW + 8 + data.footprint.zones.length * 40;
	const diagram = (data.diagram ? 120 : 0) + (data.illustrations?.length ? 30 : 0);
	if (count === 0) return ROW + warn + diagram;
	if (data.icon === "answer" || data.icon === "question") return ROW + (count === 1 ? 120 : 72) + diagram;
	if (data.icon !== "visual" && data.icon !== "delivered") return ROW + 44 + warn;
	return ROW + (count === 1 ? 120 : count === 2 ? 72 : 140) + warn;
}

function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/** L'appel encore sans réponse : ce que l'agent est en train de faire. */
function currentTool(episode: Episode): Turn | null {
	return (
		[...episode.turns].reverse().find((turn) => turn.kind === "tool" && turn.output === undefined) ?? null
	);
}

/** Ce que dit un message, sans la liste des pièces jointes que le cockpit y ajoute. */
function said(turn: Turn): string {
	return splitAttachments(turn.text).text || turn.text;
}

function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Les colonnes de la carte d'un épisode, de la consigne à la conclusion. */
type Column = Array<{ id: string; data: MapNode }>;

function build(
	episode: Episode,
	live: boolean,
	activity: string | null,
	waiting: boolean,
	cwd: string,
	print: Footprint | null,
): Column[] {
	const s = summarize(episode);
	const columns: Column[] = [];
	const circling = loops(episode);
	const loopOn = (kind: Loop["kind"], target?: string) =>
		circling.find((loop) => loop.kind === kind && (target === undefined || loop.target === target));

	if (episode.ask) {
		columns.push([
			{
				id: "ask",
				data: {
					icon: "ask",
					phase: "done",
					eyebrow: tr("eyebrow.ask"),
					title: clip(said(episode.ask), 120),
					// Ce que tu as précisé en route reste avec la consigne : on la
					// relit avec l'échange entier, question comprise.
					detail:
						episode.replies.length > 0
							? tr("ask.replies", { count: episode.replies.length })
							: undefined,
					turns: [
						episode.ask,
						...episode.replies.flatMap(({ question, reply }) => (question ? [question, reply] : [reply])),
					],
					media: attachedMedia(episode.ask),
				},
			},
		]);
	}

	if (s.reads.length > 0) {
		const files = [...new Set(s.reads.map(pathOf).filter(Boolean))];
		const searches = s.reads.length - s.reads.filter((turn) => pathOf(turn) && turn.tool === "Read").length;
		columns.push([
			{
				id: "explore",
				data: {
					icon: "explore",
					phase: "done",
					eyebrow: tr("eyebrow.explore"),
					title: tr("explore.files", { count: files.length || s.reads.length }),
					detail: searches > 0 ? tr("explore.searches", { count: searches }) : undefined,
					took: tookOf(s.reads),
					dots: s.reads.slice(0, 40).map((turn, index) => ({
						key: `${turn.toolId ?? index}`,
						label: pathOf(turn) ? basename(pathOf(turn)) : clip(turn.text, 40),
						tone: turn.outputError ? "failed" : undefined,
					})),
					turns: s.reads,
				},
			},
		]);
	}

	if (s.agents.length > 0) {
		columns.push(
			s.agents.map((turn, index) => {
				// Lancé en arrière-plan, l'appel a répondu tout de suite : c'est la
				// notification de fin qui clôt le sous-agent, pas cette réponse.
				const away = turn.background?.endedAt === null;
				const running = (live && !turn.output) || away;
				const ended = turn.background?.endedAt;
				const failed = turn.outputError || turn.background?.status === "failed";
				return {
					id: `agent-${index}`,
					data: {
						icon: "agent",
						phase: failed ? "failed" : running ? "live" : "done",
						eyebrow: tr("eyebrow.subagent"),
						title: clip(
							(turn.input?.description as string | undefined) || turn.text,
							90,
						),
						detail: turn.sub ? tr("agent.gestures", { count: turn.sub.filter((sub) => sub.kind === "tool").length }) : undefined,
						took: running ? null : ended && turn.at ? ended - turn.at : tookOf([turn]),
						since: running ? turn.at ?? null : null,
						turns: [turn, ...(turn.sub ?? [])],
					},
				};
			}),
		);
	}

	if (s.changes.length > 0) {
		const scale = Math.max(1, ...s.changes.map((change) => change.added + change.removed));
		const shown = s.changes.slice(0, 6);
		const rest = s.changes.slice(6);
		columns.push([
			...shown.map((change, index) => ({
				id: `change-${index}`,
				data: {
					icon: "change" as const,
					phase: "done" as Phase,
					eyebrow: tr("eyebrow.changed"),
					title: basename(change.path),
					detail: change.path,
					bars: { added: change.added, removed: change.removed, scale },
					took: tookOf(change.turns),
					warn: warnOf(loopOn("edits", change.path)),
					turns: change.turns,
				},
			})),
			...(rest.length > 0
				? [
						{
							id: "change-more",
							data: {
								icon: "change" as const,
								phase: "done" as Phase,
								eyebrow: tr("eyebrow.andAlso"),
								title: tr("change.others", { count: rest.length }),
								detail: rest.map((change) => basename(change.path)).join(" · "),
								warn: warnOf(rest.map((change) => loopOn("edits", change.path)).find(Boolean)),
								turns: rest.flatMap((change) => change.turns),
							},
						},
					]
				: []),
		]);
	}

	const checks: Array<{ id: string; data: MapNode }> = [];
	if (s.tests.length > 0) {
		const failed = s.tests.filter((turn) => turn.outputError).length;
		const lastFailed = s.testsFail === true;
		const running = live && s.testPending;
		checks.push({
			id: "tests",
			data: {
				icon: "test",
				phase: lastFailed && !running ? "failed" : "done",
				eyebrow: tr("eyebrow.tests"),
				title: running
					? tr("tests.running")
					: s.testsFail === null
						? tr("tests.noResult")
						: lastFailed
							? tr("tests.failing")
							: tr("tests.passing"),
				detail:
					running && failed > 0
						? tr("tests.failuresSoFar", { count: failed })
						: failed > 0 && !lastFailed
						? tr("tests.failuresBefore", { count: failed })
						: tr("tests.runs", { count: s.tests.length }),
				dots: s.tests.map((turn, index) => ({
					key: `${turn.toolId ?? index}`,
					label: clip(commandOf(turn), 60),
					tone: turn.outputError ? "failed" : undefined,
				})),
				took: tookOf(s.tests),
				warn: warnOf(loopOn("tests")),
				turns: s.tests,
			},
		});
	}
	if (s.commands.length > 0) {
		const failed = s.commands.filter((turn) => turn.outputError).length;
		checks.push({
			id: "commands",
			data: {
				icon: "run",
				phase: failed > 0 ? "failed" : "done",
				eyebrow: tr("eyebrow.commands"),
				title: tr("commands.ran", { count: s.commands.length }),
				detail:
					failed > 0
						? tr("failedCount", { count: failed })
						: clip(commandOf(s.commands.at(-1) as Turn), 44),
				dots: s.commands.map((turn, index) => ({
					key: `${turn.toolId ?? index}`,
					label: clip(commandOf(turn), 60),
					tone: turn.outputError ? "failed" : undefined,
				})),
				took: tookOf(s.commands),
				warn: warnOf(loopOn("repeat")),
				turns: s.commands,
			},
		});
	}
	// Ce que l'agent a regardé — captures d'un navigateur, images, PDF — se
	// montre : c'est souvent la preuve la plus directe de ce qu'il vérifie.
	const seen = seenMedia(episode);
	if (seen.length > 0) {
		checks.push({
			id: "visuals",
			data: {
				icon: "visual",
				phase: "done",
				eyebrow: tr("eyebrow.visuals"),
				title: countMedia(seen),
				media: seen,
				turns: [],
			},
		});
	}
	if (checks.length > 0) columns.push(checks);

	// Sa revue, quand c'est un agent de revue qui l'a remise : c'est ce qu'on
	// vient chercher sur sa carte. Elle ne vivait que dans l'onglet « Vue », et
	// la carte de l'agent n'en disait que ses phrases — on cherchait la revue
	// sans la trouver.
	const remises = episode.turns.filter((turn) => turn.kind === "tool" && turn.tool === REVIEW_TOOL);
	remises.forEach((turn, index) => {
		const input = turn.input ?? {};
		const findings = Array.isArray(input.findings) ? (input.findings as Array<Record<string, unknown>>) : [];
		const count = (severity: string) => findings.filter((finding) => finding.severity === severity).length;
		const parts = [
			count("bloquant") ? tr("review.blocking", { count: count("bloquant") }) : "",
			count("important") ? tr("review.important", { count: count("important") }) : "",
			count("suggestion") ? tr("review.suggestion", { count: count("suggestion") }) : "",
		].filter(Boolean);
		const verdict =
			input.verdict === "merge"
				? tr("review.merge")
				: input.verdict === "bloquant"
					? tr("review.blockingVerdict")
					: tr("review.changes");
		const pr = Number(String(input.pr ?? "").replace(/[^0-9]/g, "")) || undefined;
		columns.push([
			{
				id: `review-${index}`,
				data: {
					icon: "review",
					phase: input.verdict === "merge" ? "done" : "yours",
					eyebrow: pr ? tr("eyebrow.reviewPr", { pr }) : tr("eyebrow.review"),
					// Relue depuis le disque, l'entrée d'un appel peut être tronquée :
					// on ne prétend pas « rien à relever » faute de l'avoir lue.
					title: !Array.isArray(input.findings)
						? tr("review.delivered")
						: `${verdict} · ${parts.length ? parts.join(", ") : tr("review.nothing")}`,
					detail: tr("review.open"),
					dots: findings.map((finding, at) => ({
						key: String(finding.id ?? at),
						label: `${severityWord(String(finding.severity ?? ""))} · ${String(finding.file ?? "")}`,
						tone: finding.severity === "bloquant" || finding.severity === "important" ? ("failed" as const) : undefined,
					})),
					turns: [turn],
					review: pr,
				},
			},
		]);
	});

	// Ce qu'il a dit : une carte par message, à identifiant stable (son rang dans
	// l'épisode). La fin de la carte n'avait qu'une case — « sa conclusion » ou
	// « en ce moment » — dont le contenu changeait : un agent qui reprenait
	// après avoir parlé (une tâche de fond, un sous-agent qui rend la main)
	// effaçait le message qu'on était en train de lire, et chaque nouvelle
	// phrase écrasait la précédente. Désormais un message ajouté s'ajoute ; aucun
	// n'en remplace un autre.
	const SHOWN = 3;
	const messages = s.said;
	// Ce que la conclusion donne à voir passe devant ce qu'elle dit : les
	// captures « avant » et « après » d'abord, dans cet ordre, puis le reste.
	const shipped = delivered(episode, s.answer, cwd);
	const proof = [...shipped.media].sort((a, b) => stageRank(a) - stageRank(b));
	const drawn = illustrationsOf(episode.turns);
	// Le constat passe devant sa conclusion : on regarde ce que le dépôt dit
	// avant de lire ce que l'agent en raconte. Il n'apparaît qu'une fois la main
	// rendue — pendant le travail, le dépôt change sous le dessin.
	const constat: Column =
		print && !live && !waiting
			? [
					{
						id: "footprint",
						data: {
							icon: "footprint",
							phase: "done",
							eyebrow: tr("eyebrow.footprint", { base: print.baseLabel }),
							title: headline(print),
							footprint: print,
							turns: [],
						},
					},
				]
			: [];
	if (messages.length === 0 && constat.length > 0) columns.push(constat);
	if (messages.length > 0) {
		const column: Column = [...constat];
		if (messages.length > SHOWN) {
			const older = messages.slice(0, messages.length - SHOWN);
			column.push({
				id: "said-earlier",
				data: {
					icon: "answer",
					phase: "done",
					eyebrow: tr("eyebrow.earlier"),
					title: tr("said.earlier", { count: older.length }),
					markdown: older.map((turn) => turn.text).join("\n\n---\n\n"),
					turns: older,
				},
			});
		}
		messages.slice(-SHOWN).forEach((turn, offset) => {
			const index = messages.length - Math.min(SHOWN, messages.length) + offset;
			const last = index === messages.length - 1;
			// Le dernier message n'est une conclusion que si l'agent a rendu la
			// main ; tant qu'il travaille, c'est ce qu'il a dit en chemin.
			const concluding = last && !live && !waiting;
			const asking = concluding && s.asks;
			column.push({
				id: `said-${index}`,
				data: {
					icon: asking ? "question" : "answer",
					phase: asking ? "yours" : "done",
					eyebrow: asking ? tr("eyebrow.asking") : concluding ? tr("eyebrow.conclusion") : tr("eyebrow.said"),
					title: clip(prose(turn.text), 150),
					markdown: turn.text,
					diagram: firstDiagram(turn.text) ?? undefined,
					illustrations: concluding && drawn.length > 0 ? drawn : undefined,
					media: concluding && proof.length > 0 ? proof : undefined,
					turns: [turn],
				},
			});
		});
		columns.push(column);
	}

	// Ce qui se passe maintenant vient après ce qu'il a dit, jamais à sa place.
	if (waiting) {
		columns.push([
			{
				id: "outcome-waiting",
				data: {
					icon: "question",
					phase: "yours",
					eyebrow: tr("eyebrow.yours"),
					title: tr("waiting.title"),
					detail: tr("waiting.detail"),
					turns: [],
				},
			},
		]);
	} else if (live) {
		const current = currentTool(episode);
		// Dans son shell, « en ce moment » s'ouvre sur un terminal : la commande
		// qui tourne à la suite de celles d'avant, plutôt qu'un appel seul.
		const inShell = current ? current.tool === "Bash" : activity === "Bash";
		// Entre deux appels, l'activité nomme encore le dernier outil alors qu'il
		// a déjà répondu : le panneau s'ouvrait vide. On y montre cet appel-là —
		// c'est sa sortie que l'agent est en train de lire.
		const latest = activity ? [...episode.turns].reverse().find((turn) => turn.kind === "tool") : undefined;
		columns.push([
			{
				id: "outcome-live",
				data: {
					icon: "live",
					phase: "live",
					eyebrow: tr("eyebrow.now"),
					title: current
						? capitalize(gestureOf(current))
						: activity
							? tr("live.using", { tool: activity })
							: tr("live.thinking"),
					since: current?.at ?? lastSign(episode),
					turns: current ? [current] : latest ? [latest] : [],
					shell: inShell
						? episode.turns.filter((turn) => turn.kind === "tool" && turn.tool === "Bash").slice(-40)
						: undefined,
					pondering: inShell && !current,
				},
			},
		]);
	}

	// Un échec qui ne rentre dans aucune case (erreur du moteur) se dit quand même.
	const loose = episode.turns.filter((turn) => turn.kind === "error");
	if (loose.length > 0) {
		// À la suite de ce qui précède, jamais sous la consigne elle-même.
		if (columns.length <= 1) columns.push([]);
		const last = columns[columns.length - 1];
		last.push({
			id: "errors",
			data: {
				icon: "run",
				phase: "failed",
				eyebrow: tr("eyebrow.error"),
				title: clip(loose.at(-1)?.text ?? "", 90),
				turns: loose,
			},
		});
	}

	// En bout de ligne, ce qui reste une fois la conversation finie : la PR,
	// les commits, les fichiers produits.
	if (!isEmpty(shipped)) {
		const facts = [
			shipped.reviews.length > 0 ? tr("delivered.pr", { list: shipped.reviews.map((review) => review.label).join(", ") }) : null,
			shipped.commits.length > 0 ? tr("delivered.commits", { count: shipped.commits.length }) : null,
			shipped.pushed.length > 0 ? tr("delivered.pushed", { branches: shipped.pushed.join(", ") }) : null,
			shipped.media.length > 0 ? countMedia(shipped.media) : null,
		].filter((fact): fact is string => fact !== null);
		columns.push([
			{
				id: "delivered",
				data: {
					icon: "delivered",
					phase: "done",
					eyebrow: tr("eyebrow.delivered"),
					title: facts[0] ?? "",
					detail: facts.slice(1).join(" · ") || undefined,
					// Déjà en tête de la conclusion : la mosaïque ne se répète pas ici,
					// la galerie reste à un clic.
					media: shipped.media.length > 0 && !(messages.length > 0 && !live && !waiting) ? shipped.media : undefined,
					delivered: shipped,
					turns: shipped.turns,
				},
			},
		]);
	}

	// Une seule étape est « en cours » : celle de droite. Rallumer aussi la
	// colonne précédente montrait deux cartes au travail, et une étape finie
	// ne se distinguait plus de celle qui tourne.

	return columns;
}

/** La gravité d'un point de revue, dite dans la langue de l'interface. */
function severityWord(severity: string): string {
	return severity === "bloquant" || severity === "important" || severity === "suggestion"
		? tr(`severity.${severity}`)
		: severity;
}

/** « avant » / « après » : la valeur reste celle du code, le mot suit la langue. */
function stageWord(stage: "avant" | "après"): string {
	return stage === "avant" ? tr("stage.before") : tr("stage.after");
}

function stageRank(media: Media): number {
	const stage = stageOf(media);
	return stage === "avant" ? 0 : stage === "après" ? 1 : 2;
}

/**
 * Ce qu'un message dit, une fois retiré ce qu'il montre : le texte d'un
 * schéma ou le chemin d'une image n'ont rien à faire dans un résumé.
 */
function prose(markdown: string): string {
	return markdown
		.replace(/```mermaid[\s\S]*?```/g, " ")
		.replace(/!\[[^\]]*\]\([^)\s]+\)/g, " ");
}

/** « 2 images · 1 PDF · 1 vidéo » */
function countMedia(media: Media[]): string {
	const count = (kind: Media["kind"]) => media.filter((item) => item.kind === kind).length;
	const images = count("image");
	const pdfs = count("pdf");
	const videos = count("video");
	return [
		images > 0 ? tr("media.images", { count: images }) : null,
		pdfs > 0 ? tr("media.pdfs", { count: pdfs }) : null,
		videos > 0 ? tr("media.videos", { count: videos }) : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/** Une boucle, dite en quelques mots sur la carte qu'elle concerne. */
function warnOf(loop: Loop | undefined): string | undefined {
	if (!loop) return undefined;
	const during = loop.span ? duration(loop.span / 1000) : null;
	switch (loop.kind) {
		case "edits":
			return during
				? tr("warn.editsDuring", { count: loop.count, duration: during })
				: tr("warn.edits", { count: loop.count });
		case "tests":
			return during
				? tr("warn.testsDuring", { count: loop.count, duration: during })
				: tr("warn.tests", { count: loop.count });
		case "repeat":
			return tr("warn.repeat", { command: clip(loop.target, 28), count: loop.count });
	}
}

/** La boucle la plus marquée, dite pour la barre d'état. */
function loopSentence(loop: Loop): string {
	switch (loop.kind) {
		case "edits":
			return tr("loop.edits", { file: basename(loop.target), count: loop.count });
		case "tests":
			return tr("loop.tests", { target: clip(loop.target, 40), count: loop.count });
		case "repeat":
			return tr("loop.repeat", { target: clip(loop.target, 40), count: loop.count });
	}
}

/** Un épisode passé, replié en une carte : ce qu'on demandait, ce qui en est sorti. */
function folded(episode: Episode): MapNode {
	const s = summarize(episode);
	const failed = s.failures.length > 0 || s.testsFail === true;
	const facts: string[] = [];
	if (s.changes.length > 0) facts.push(tr("folded.changed", { count: s.changes.length }));
	if (s.testsFail !== null) facts.push(s.testsFail ? tr("folded.testsKo") : tr("folded.testsOk"));
	if (s.failures.length > 0) facts.push(tr("failedCount", { count: s.failures.length }));
	const circling = loops(episode)[0];
	const started = episode.ask?.at;
	const ended = lastSign(episode);
	if (s.changes.length === 0) facts.push(tr("folded.nothingChanged"));
	if (started && ended && ended > started) facts.push(duration((ended - started) / 1000));
	return {
		icon: "episode",
		phase: failed ? "failed" : "done",
		eyebrow: tr("eyebrow.pastAsk"),
		title: episode.ask ? clip(said(episode.ask), 90) : tr("folded.resumed"),
		detail: facts.join(" · "),
		turns: [],
		toggles: "expand",
		warn: circling ? tr("folded.circled", { loop: loopSentence(circling) }) : undefined,
	};
}

/**
 * Toute la session, une ligne par consigne : le passé replié, sauf ce qu'on a
 * déplié. Mises bout à bout, les consignes faisaient une seule ligne sans fin
 * où l'on ne voyait plus où l'une s'arrêtait.
 */
function session(
	all: Episode[],
	open: Set<number>,
	live: boolean,
	activity: string | null,
	waiting: boolean,
	cwd: string,
	/** Le constat, et l'épisode auquel il revient. */
	print: { of: number; found: Footprint } | null,
): Column[][] {
	const last = all.length - 1;
	return all.map((episode, index) => {
		const tag = (column: Column) =>
			column.map((entry) => ({ id: `${index}:${entry.id}`, data: { ...entry.data, episode: index } }));
		if (index !== last && !open.has(index)) {
			return [[{ id: `${index}:folded`, data: { ...folded(episode), episode: index } }]];
		}
		const own = build(episode, index === last && live, activity, index === last && waiting, cwd, print?.of === index ? print.found : null);
		if (index !== last) {
			// Déplié à la demande : sa consigne le replie.
			const ask = own[0]?.find((entry) => entry.id === "ask");
			if (ask) ask.data = { ...ask.data, eyebrow: tr("eyebrow.pastAsk"), toggles: "collapse" };
		}
		return own.map(tag);
	});
}

/** L'écart entre deux lignes : assez pour qu'elles se lisent comme deux consignes. */
const ROW_GAP = 56;

export function AgentMap({
	runId,
	turns,
	cwd,
	active,
	thinking,
	activity,
	alert,
	renderTurn,
	onTour,
}: {
	/** L'agent dont c'est la carte : les remarques posées dessus lui sont adressées. */
	runId?: string;
	/** L'onglet est celui qu'on regarde : masqué, la carte ne se dessine pas. */
	active: boolean;
	turns: Turn[];
	cwd: string;
	thinking: boolean;
	activity: string | null;
	/** Ce que l'agent te demande — question ou autorisation — prêt à répondre. */
	alert: ReactNode | null;
	renderTurn: (turn: Turn, key: number) => ReactNode;
	/** Ouvre la visite des changements, quand il y a de quoi visiter. */
	onTour?: () => void;
}) {
	const { t } = useTranslation("components2");
	const all = useMemo(() => episodes(turns), [turns]);
	const compactedAt = useMemo(() => lastCompaction(turns), [turns]);
	// Une commande de test déclarée dans les réglages change le rangement :
	// la carte se redessine, sans attendre le prochain geste de l'agent.
	const tests = useCockpit().config?.workflow?.testCommands?.join("\n") ?? "";
	const last = all.length - 1;
	// Toute la session tient sur une carte : les épisodes passés s'y replient
	// en une carte chacun, et se déplient sur place. Une nouvelle consigne ne
	// remplace plus la carte, elle la prolonge.
	const [open, setOpen] = useState<Set<number>>(() => new Set());
	// L'épisode que la vue cadre : le présent, sauf si l'on vient d'en déplier un.
	const [focus, setFocus] = useState<number | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	// Le panneau montre une étape ou une tuile agrandie, jamais les deux.
	const [tile, setTile] = useState<TileId | null>(null);
	const openTile = useCallback((next: TileId | null) => {
		setTile(next);
		if (next) setSelected(null);
	}, []);
	const rail = useHasTiles() && Boolean(runId);
	// La place prise par le panneau ouvert : la question de l'agent se range à
	// côté, ou passe devant quand il ne reste plus de quoi la lire.
	const [layout, setLayout] = useState({ panel: 0, frame: 0 });
	const onLayout = useCallback((panel: number, frame: number) => {
		setLayout((current) => (current.panel === panel && current.frame === frame ? current : { panel, frame }));
	}, []);
	const railSpace = rail ? RAIL_WIDTH : 0;
	const cramped = layout.panel > 0 && layout.frame - layout.panel - railSpace - 48 < 420;
	const everyRemark = useAllRemarks();
	const remarks = useMemo(
		() => (runId ? everyRemark.filter((remark) => remark.runId === runId) : []),
		[everyRemark, runId],
	);
	const remarked = useMemo(() => new Set(remarks.map((remark) => remark.target)), [remarks]);

	// La vue suit l'agent tant qu'on ne la prend pas en main : déplacer ou
	// zoomer la carte soi-même l'arrête, sinon elle se recadrerait sous les
	// yeux à chaque étape, pendant qu'on relit un fichier.
	const [following, setFollowing] = useState(true);

	// Une nouvelle consigne ramène sur le présent.
	useEffect(() => {
		setFocus(null);
		setSelected(null);
		setFollowing(true);
	}, [last]);

	// Revenir sur la carte, c'est la retrouver cadrée.
	useEffect(() => {
		if (active) setFollowing(true);
	}, [active]);

	const shown = focus ?? last;
	const live = thinking;
	const waiting = alert !== null;

	// Le constat se lit dans le dépôt une fois la main rendue. Il appartient à
	// la dernière consigne qui a changé quelque chose : une question posée
	// ensuite ne l'emporte pas avec elle, et ne le fait pas passer pour sien.
	const worked = useMemo(() => all.map((episode) => hasWork(episode.turns)).lastIndexOf(true), [all]);
	const since = useMemo(() => firstCommit(turns), [turns]);
	const settled = active && !live && !waiting && worked >= 0 && !!cwd;
	const changes = useAsync(() => api.tour.changes(cwd, since), [cwd, since, turns.length], { enabled: settled });
	const print = useMemo(() => {
		const found = settled && changes.data ? footprint(changes.data) : null;
		return found ? { of: worked, found } : null;
	}, [settled, changes.data, worked]);

	const toggle = (index: number) => {
		const next = new Set(open);
		if (next.has(index)) next.delete(index);
		else next.add(index);
		setOpen(next);
		setFocus(next.has(index) ? index : null);
		setSelected(null);
		setFollowing(true);
	};

	// Les nœuds portent la taille mesurée au rendu précédent : sans elle, une
	// rafale d'événements les laissait tous invisibles (voir `useNodeSizes`).
	// Elle sert aussi à les empiler : une estimation de hauteur faisait se
	// chevaucher les cartes qui portent une alerte ou des barres.
	const { onNodesChange, withSizes, sizes } = useNodeSizes<Node<MapNode>>();

	const { nodes, edges, byId } = useMemo(() => {
		const span = (entry: { id: string; data: MapNode }) => {
			const measured = sizes.get(entry.id)?.height;
			return measured ? Math.max(ROW, measured + 22) : heightOf(entry.data);
		};
		if (all.length === 0) return { nodes: [], edges: [], byId: new Map<string, MapNode>() };
		const rows = session(all, open, live, activity, waiting, cwd, print);
		const nodes: Node<MapNode>[] = [];
		const byId = new Map<string, MapNode>();
		const edges: Edge[] = [];
		let offset = 0;
		rows.forEach((columns, row) => {
			const heights = columns.map((column) => column.reduce((sum, entry) => sum + span(entry), 0));
			const tallest = Math.max(ROW, ...heights);
			columns.forEach((column, x) => {
				let y = offset + (tallest - heights[x]) / 2;
				for (const entry of column) {
					const data = { ...entry.data, selected: selected === entry.id, remarked: remarked.has(entry.id) };
					byId.set(entry.id, data);
					nodes.push({
						id: entry.id,
						type: "step",
						position: { x: x * COL, y },
						data,
					});
					y += span(entry);
				}
			});
			offset += tallest + ROW_GAP;

			// D'une consigne à la suivante, le fil descend le long de la marge :
			// on lit la session de haut en bas, chaque ligne de gauche à droite.
			const from = columns[0]?.[0];
			const to = rows[row + 1]?.[0]?.[0];
			if (from && to) {
				edges.push({
					id: `${from.id}=>${to.id}`,
					source: from.id,
					sourceHandle: "down",
					target: to.id,
					targetHandle: "up",
					type: "smoothstep",
					style: { stroke: "var(--color-line)", strokeWidth: 1.6, strokeDasharray: "4 4" },
				});
			}

			for (let x = 0; x < columns.length - 1; x++) {
				for (const from of columns[x]) {
					for (const to of columns[x + 1]) {
						const flowing = to.data.phase === "live" || to.data.phase === "yours";
						edges.push({
							id: `${from.id}->${to.id}`,
							source: from.id,
							target: to.id,
							animated: flowing,
							style: {
								stroke:
									to.data.phase === "yours"
										? "var(--color-warning)"
										: flowing
											? "var(--color-accent)"
											: to.data.phase === "failed"
												? "color-mix(in srgb, var(--color-critical) 55%, transparent)"
												: "var(--color-line)",
								strokeWidth: flowing ? 2.2 : 1.6,
							},
						});
					}
				}
			}
		});
		return { nodes, edges, byId };
	}, [all, open, live, activity, waiting, selected, tests, cwd, sizes, remarked, print]);

	const sized = useMemo(() => withSizes(nodes), [nodes, withSizes]);

	// Ce que la vue cadre : l'épisode choisi, avec la ligne repliée du dessus
	// pour rappeler qu'il y a une histoire avant.
	const framed = nodes
		.filter((node) => node.data.episode === shown || (node.data.episode === shown - 1 && node.data.toggles === "expand"))
		.map((node) => node.id);

	// Le panneau suit la carte : une étape ouverte se met à jour d'elle-même à
	// mesure que l'agent avance. Il fallait cliquer « Voir la mise à jour » à
	// chaque geste, et « en ce moment », ouvert une seconde trop tôt, restait
	// vide. On ne garde l'ancienne version que d'une étape qui a quitté la
	// carte — fermer le panneau sous les yeux serait pire — et on le dit.
	const reading = useRef<{ id: string; data: MapNode } | null>(null);
	const fresh = selected ? (byId.get(selected) ?? null) : null;
	if (!selected) reading.current = null;
	else if (fresh) reading.current = { id: selected, data: fresh };
	const detail = reading.current?.id === selected ? reading.current.data : null;
	const gone = Boolean(detail && !fresh);

	const tiles = rail && runId ? (
		<>
			<TileRail runId={runId} active={active} open={tile} onOpen={openTile} />
			<AnimatePresence>
				{tile ? (
					<SidePanel
						panelKey={`tile-${tile}`}
						eyebrow={TILE_TITLES[tile].eyebrow}
						title={TILE_TITLES[tile].title}
						flush
						onClose={() => setTile(null)}
						onLayout={onLayout}
					>
						<TileBody tile={tile} runId={runId} />
					</SidePanel>
				) : null}
			</AnimatePresence>
		</>
	) : null;

	if (all.length === 0) {
		return (
			<div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
				<span className="grid size-12 place-items-center rounded-2xl bg-accent-dim text-accent">
					<Sparkles size={20} />
				</span>
				<p className="max-w-sm text-[12.5px] leading-relaxed text-ink-muted">
					{t("agentMap.empty")}
				</p>
				{alert ? <div className="w-full max-w-xl">{alert}</div> : null}
				{tiles}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<EpisodeStrip
				all={all}
				shown={shown}
				live={thinking}
				waiting={alert !== null}
				onPick={(index) => {
					setSelected(null);
					setFollowing(true);
					if (index === last) {
						setFocus(null);
						return;
					}
					setOpen((current) => new Set(current).add(index));
					setFocus(index);
				}}
			/>

			<StateBar
				episode={all[last]}
				live={thinking}
				waiting={alert !== null}
				onTour={onTour}
				compactedAt={compactedAt}
			/>

			<div className="mission-graph relative min-h-0 flex-1 bg-base">
				{/* Les onglets d'un workspace restent tous montés : quatre agents au
				    travail, c'étaient quatre graphes qui se redessinaient et
				    animaient leurs arêtes à chaque outil, dont trois invisibles. Et
				    la clé changeait à chaque nœud ajouté, ce qui reconstruisait le
				    graphe entier au lieu de le compléter — de quoi figer l'app. */}
				{active ? (
				<ReactFlow
					nodes={sized}
					onNodesChange={onNodesChange}
					edges={edges}
					nodeTypes={NODE_TYPES}
					fitView
					// Une question posée occupe le haut : la carte se range dessous
					// plutôt que de disparaître derrière.
					fitViewOptions={{
						nodes: framed.map((id) => ({ id })),
						padding: framePadding(alert !== null, rail),
						maxZoom: 1,
					}}
					minZoom={0.3}
					maxZoom={1.5}
					// La session s'étire vers le haut : on la parcourt au défilement,
					// et on zoome au pincement.
					panOnScroll
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
					proOptions={{ hideAttribution: true }}
					onNodeClick={(event, node) => {
						const data = node.data as MapNode;
						// Une carte repliée se déplie d'un clic n'importe où ; une consigne
						// dépliée ne se replie que par son bouton, pour qu'on puisse encore
						// en relire l'échange.
						const folding =
							data.toggles === "expand" ||
							(data.toggles === "collapse" &&
								(event.target as Element).closest("[data-fold]") !== null);
						if (folding && data.episode !== undefined) toggle(data.episode);
						else {
							setTile(null);
							setSelected((current) => (current === node.id ? null : node.id));
						}
					}}
					onPaneClick={() => setSelected(null)}
					// Seul un geste porte un événement : un recadrage de notre fait
					// n'en a pas, et ne doit pas couper le suivi.
					// et un clic sur une carte en porte un sans rien déplacer. Un
					// défilement ou un pincement déplace dès son premier cran ; un
					// glisser, dès que la vue bouge.
					onMoveStart={(event) => {
						if (event?.type === "wheel") setFollowing(false);
					}}
					onMove={(event) => {
						if (event) setFollowing(false);
					}}
				>
					<Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
					<Refit framed={framed} padded={alert !== null} rail={rail} enabled={following} />
				</ReactFlow>
				) : null}

				{runId && remarks.length > 0 ? (
					<div className="absolute bottom-4 left-4 z-10 w-[300px] shadow-pop rounded-lg">
						<RemarkTray runId={runId} remarks={remarks} className="bg-surface" />
					</div>
				) : null}

				{active && !following ? (
					<button
						type="button"
						onClick={() => {
							setFocus(null);
							setFollowing(true);
						}}
						className="focus-ring absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-[11.5px] font-medium text-ink shadow-pop hover:bg-hover"
					>
						<LocateFixed size={13} className={thinking ? "text-accent" : "text-ink-muted"} />
						{t("agentMap.backToNow")}
					</button>
				) : null}

				{/* Ce qui t'attend passe devant la carte : impossible à manquer, et on
				    y répond sur place. */}
				<AnimatePresence>
					{alert ? (
						<motion.div
							key="alert"
							initial={{ opacity: 0, y: -16, scale: 0.98 }}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={{ opacity: 0, y: -12 }}
							transition={{ type: "spring", stiffness: 380, damping: 32 }}
							// À côté du panneau ouvert tant qu'il reste de quoi la lire ;
							// sinon devant lui — ce qui t'attend ne se cache derrière rien.
							style={
								layout.panel > 0 && !cramped
									? { left: railSpace + 16, right: layout.panel + 28 }
									: { left: 16, right: 16 }
							}
							className={clsx("pointer-events-none absolute top-4 flex justify-center", cramped ? "z-30" : "z-10")}
						>
							<div className="pointer-events-auto relative w-[min(640px,100%)] rounded-2xl bg-surface p-4 shadow-pop ring-2 ring-warning/60">
								<span className="animate-pulse-dot pointer-events-none absolute -inset-1.5 rounded-[20px] border-2 border-warning/40" />
								<div className="mb-2.5 flex items-center gap-2">
									<span className="grid size-7 place-items-center rounded-lg bg-warning/15 text-warning">
										<HelpCircle size={15} />
									</span>
									<span className="text-[13px] font-semibold text-ink">{t("agentMap.needsYou")}</span>
								</div>
								{alert}
							</div>
						</motion.div>
					) : null}
				</AnimatePresence>

				<AnimatePresence>
					{detail ? (
						<SidePanel
							panelKey={`step-${selected}`}
							eyebrow={detail.eyebrow}
							title={detail.markdown ? t("agentMap.panel.fullText") : detail.shell ? t("agentMap.panel.terminal") : detail.title}
							flush={Boolean(detail.shell)}
							onClose={() => setSelected(null)}
							onLayout={onLayout}
							banner={
								gone ? (
									<div className="border-b border-line-soft bg-raised px-4 py-1.5 text-[11.5px] text-ink-muted">
										{t("agentMap.panel.gone")}
									</div>
								) : null
							}
							footer={runId ? <StepRemark runId={runId} nodeId={selected ?? ""} node={detail} /> : null}
						>
							{detail.shell ? (
								<ShellView turns={detail.shell} live={thinking && !gone} pondering={Boolean(detail.pondering) && !gone} />
							) : detail.markdown ? (
								<div className="flex flex-col gap-3 px-4 py-3">
									{detail.illustrations?.map((item) => (
										<Illustration key={item.key} item={item} cwd={cwd} />
									))}
									<Markdown source={detail.markdown} cwd={cwd} />
								</div>
							) : detail.icon === "visual" && detail.media ? (
								<Gallery media={detail.media} />
							) : detail.footprint ? (
								<FootprintDetail print={detail.footprint} onTour={onTour} />
							) : detail.review ? (
								<ReviewDetail pr={detail.review} cwd={cwd} />
							) : detail.delivered ? (
								<DeliveredDetail delivered={detail.delivered} onTour={onTour} />
							) : detail.turns.length === 0 ? (
								<p className="px-4 py-6 text-[12px] text-ink-faint">
									{detail.phase === "live"
										? t("agentMap.panel.thinking")
										: t("agentMap.panel.nothing")}
								</p>
							) : (
								<div className="divide-y divide-line-soft/60">
									{detail.turns.map((turn, index) => renderTurn(turn, index))}
								</div>
							)}
						</SidePanel>
					) : null}
				</AnimatePresence>
				{tiles}
			</div>
		</div>
	);
}

/**
 * Une remarque sur l'étape qu'on regarde.
 *
 * L'agent la reçoit avec ce qu'elle vise écrit en toutes lettres — l'étape et
 * les fichiers qu'elle a touchés — pour qu'il n'ait pas à deviner de quoi on
 * parle. « Plus tard » la range avec les autres, à envoyer ensemble.
 */
function StepRemark({ runId, nodeId, node }: { runId: string; nodeId: string; node: MapNode }) {
	const { t } = useTranslation("components2");
	const actions = useAgentActions();
	const [text, setText] = useState("");
	useEffect(() => setText(""), [nodeId]);

	const files = [...new Set(node.turns.map((turn) => pathOf(turn)).filter(Boolean))].slice(0, 4);
	const title = node.title.length > 90 ? `${node.title.slice(0, 89)}…` : node.title;
	const anchor = `${t("agentMap.remark.anchor", { title })}${files.length > 0 ? ` (${files.map((file) => `\`${file}\``).join(", ")})` : ""}`;

	const submit = (later: boolean) => {
		if (!text.trim()) return;
		if (later) addRemark(runId, anchor, text, nodeId);
		else actions.send(runId, composeRemarks([{ id: "", runId, anchor, text: text.trim(), at: Date.now() }]));
		setText("");
	};

	return (
		<div className="border-t border-line-soft bg-raised/60 px-3 py-2.5">
			<textarea
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(false);
				}}
				rows={2}
				placeholder={t("agentMap.remark.placeholder")}
				className="focus-ring w-full resize-none rounded-md bg-surface px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-faint"
			/>
			<div className="mt-1.5 flex justify-end gap-1">
				<Button size="sm" onClick={() => submit(true)} disabled={!text.trim()} title={t("agentMap.remark.laterTitle")}>
					{t("agentMap.remark.later")}
				</Button>
				<Button size="sm" variant="solid" icon={Send} onClick={() => submit(false)} disabled={!text.trim()} title="⌘↵">
					{t("agentMap.remark.send")}
				</Button>
			</div>
		</div>
	);
}

/** La revue remise, en entier, dans le panneau de détail de la carte. */
function ReviewDetail({ pr, cwd }: { pr: number; cwd: string }) {
	const { t } = useTranslation("components2");
	const { review } = useReview(pr);
	const start = useReviewFlow();
	const [busy, setBusy] = useState(false);
	const relaunch = (kind: "revue" | "verification") => {
		setBusy(true);
		void start(pr, kind)
			.catch(() => undefined)
			.finally(() => setBusy(false));
	};
	if (!review) return <p className="px-4 py-3 text-[12px] text-ink-faint">{t("agentMap.review.loading")}</p>;
	return (
		<div className="p-3">
			<ReviewPanel
				review={review}
				cwd={cwd}
				headSha={null}
				busy={busy}
				onRecheck={() => relaunch("verification")}
				onReview={() => relaunch("revue")}
			/>
		</div>
	);
}

/** Les épisodes, en frise : la carte de chacun se rouvre d'un clic. */
function EpisodeStrip({
	all,
	shown,
	live,
	waiting,
	onPick,
}: {
	all: Episode[];
	shown: number;
	live: boolean;
	waiting: boolean;
	onPick: (index: number) => void;
}) {
	const { t } = useTranslation("components2");
	return (
		<div className="hairline-b flex items-center gap-1.5 overflow-x-auto px-3 py-2">
			<span className="shrink-0 pr-1 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
				{t("agentMap.strip.episodes")}
			</span>
			{all.map((episode, index) => {
				const last = index === all.length - 1;
				const s = summarize(episode);
				const tone =
					last && waiting
						? "bg-warning"
						: last && live
							? "bg-accent"
							: s.failures.length > 0 || s.testsFail
								? "bg-critical"
								: s.asks
									? "bg-warning"
									: "bg-success";
				return (
					<button
						key={index}
						type="button"
						onClick={() => onPick(index)}
						title={episode.ask?.text}
						className={clsx(
							"focus-ring relative flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] transition-colors",
							shown === index ? "text-ink" : "text-ink-muted hover:bg-hover/50",
						)}
					>
						{shown === index ? (
							<motion.span
								layoutId="episode-active"
								transition={{ type: "spring", stiffness: 520, damping: 40 }}
								className="absolute inset-0 rounded-lg bg-surface shadow-card"
							/>
						) : null}
						<span
							className={clsx(
								"relative size-2 shrink-0 rounded-full",
								tone,
								last && (live || waiting) && "animate-pulse-dot",
							)}
						/>
						<span className="relative truncate">
							{episode.ask ? clip(said(episode.ask), 36) : t("agentMap.folded.resumed")}
						</span>
					</button>
				);
			})}
		</div>
	);
}

/* ── L'état de l'agent ─────────────────────────────────────────────── */

/** Le dernier moment où l'agent a donné signe de vie, quand on le sait. */
function lastSign(episode: Episode): number | null {
	let latest: number | null = null;
	const see = (at: number | null | undefined) => {
		if (at && (latest === null || at > latest)) latest = at;
	};
	for (const turn of episode.turns) {
		see(turn.at);
		see(turn.doneAt);
		see(turn.background?.endedAt);
		// Un sous-agent d'arrière-plan qui lit le code est un signe de vie, même
		// si le maître, lui, ne dit plus rien en l'attendant.
		if (turn.background) for (const sub of turn.sub ?? []) see(sub.doneAt ?? sub.at);
	}
	return latest;
}

/** L'heure, rafraîchie tant qu'on la montre : vite quand ça bouge, rarement sinon. */
function useNow(every: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), every);
		return () => window.clearInterval(timer);
	}, [every]);
	return now;
}

/** Au-delà, un silence mérite qu'on le remarque — sans conclure pour autant. */
const QUIET_MS = 3 * 60_000;

/**
 * Ce que fait l'agent maintenant, en une ligne et avec une durée.
 *
 * La carte raconte l'épisode ; elle répondait mal à « est-ce qu'il travaille
 * encore ? ». C'est un état unique, qui se lit dans le temps : « lance git
 * merge dev depuis 42 s » et « muet depuis 6 min » ne veulent pas dire la même
 * chose, alors qu'ils dessinaient la même carte. Les durées viennent des
 * horodatages des tours ; un tour sans date n'en fabrique pas.
 */
function StateBar({
	episode,
	live,
	waiting,
	onTour,
	compactedAt,
}: {
	episode: Episode | undefined;
	live: boolean;
	waiting: boolean;
	onTour?: () => void;
	/** Le dernier compactage de la conversation : ce qui précède n'est plus qu'un résumé. */
	compactedAt?: number | null;
}) {
	const { t } = useTranslation("components2");
	const now = useNow(live || waiting ? 1000 : 30_000);
	if (!episode) return null;
	const s = summarize(episode);
	const started = episode.ask?.at ?? null;
	const sign = lastSign(episode);
	const current = live ? currentTool(episode) : null;
	// Les sous-agents partis en arrière-plan : le maître a pu rendre la main, eux
	// travaillent encore.
	const away = backgroundPending(episode.turns).length;
	const awaySaid = t("agentMap.state.subagents", { count: away });

	let tone: "live" | "yours" | "done" | "failed";
	let label: string;
	let what: string | null = null;
	let since: number | null = null;
	let total: number | null = null;

	if (waiting) {
		tone = "yours";
		label = t("agentMap.state.waiting");
		since = sign;
	} else if (live) {
		tone = "live";
		label = t("agentMap.state.working");
		what = current
			? gestureOf(current)
			: away > 0
				? t("agentMap.state.awaiting", { agents: awaySaid })
				: t("agentMap.state.thinking");
		since = current?.at ?? sign;
		total = started ? now - started : null;
	} else {
		const failed = s.failures.length > 0 || s.testsFail === true;
		tone = s.asks ? "yours" : failed ? "failed" : "done";
		label = s.asks ? t("agentMap.state.asks") : t("agentMap.state.done");
		since = sign;
		total = started && sign ? sign - started : null;
	}

	const quiet = live && since !== null && now - since > QUIET_MS;
	const failures = s.failures.length;
	const circling = loops(episode)[0];

	return (
		<div
			className={clsx(
				"hairline-b flex min-h-10 items-center gap-2.5 px-3 py-2 text-[12px]",
				tone === "live" && "bg-accent-dim",
				tone === "yours" && "bg-warning/10",
			)}
			aria-live="polite"
		>
			<span
				className={clsx(
					"grid size-5 shrink-0 place-items-center rounded-full",
					tone === "live" && "bg-accent text-accent-ink",
					tone === "yours" && "bg-warning text-accent-ink",
					tone === "done" && "bg-raised text-ink-muted",
					tone === "failed" && "bg-critical/15 text-critical",
				)}
			>
				{tone === "live" ? (
					<span className="animate-pulse-dot size-2 rounded-full bg-current" />
				) : tone === "yours" ? (
					<HelpCircle size={12} />
				) : tone === "failed" ? (
					<AlertTriangle size={11} />
				) : (
					<Check size={12} />
				)}
			</span>
			<span
				className={clsx(
					"shrink-0 font-semibold",
					tone === "live" ? "text-accent" : tone === "yours" ? "text-warning" : "text-ink",
				)}
			>
				{label}
			</span>
			{what ? <span className="min-w-0 truncate font-mono text-[11px] text-ink">{what}</span> : null}
			{/* « Terminé » seul laissait un doute : l'agent prépare-t-il encore
			    quelque chose en arrière-plan ? On le dit dans les deux cas — et on
			    ne répond « non » que si aucun sous-agent ne court encore. */}
			{!live && !waiting ? (
				<span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[11px] text-ink-muted">
					{away > 0 ? t("agentMap.state.background", { agents: awaySaid }) : t("agentMap.state.idle")}
				</span>
			) : null}
			{since !== null ? (
				<span
					className={clsx(
						"shrink-0 font-mono text-[11px] tabular-nums",
						quiet ? "text-warning" : "text-ink-faint",
					)}
					title={quiet ? t("agentMap.state.quietTitle") : undefined}
				>
					{live || waiting
						? t("agentMap.state.since", { duration: duration(Math.max(0, (now - since) / 1000)) })
						: fromSeconds((now - since) / 1000)}
				</span>
			) : null}
			{circling ? (
				<span
					className="flex min-w-0 items-center gap-1 truncate rounded-md bg-warning/12 px-1.5 py-0.5 text-[11px] font-medium text-warning"
					title={t("agentMap.state.loopTitle")}
				>
					<Repeat size={11} className="shrink-0" />
					<span className="truncate">{live ? t("agentMap.state.circling") : t("agentMap.state.circled")} — {loopSentence(circling)}</span>
				</span>
			) : null}
			{compactedAt ? (
				<span
					className="flex shrink-0 items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[11px] font-medium text-ink-muted"
					title={t("agentMap.state.compactedTitle")}
				>
					<Minimize2 size={11} className="shrink-0" />
					{t("agentMap.state.compacted", { ago: fromSeconds((now - compactedAt) / 1000) })}
				</span>
			) : null}
			<span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10.5px] text-ink-faint tabular-nums">
				{!live && !waiting && failures > 0 ? (
					<span className="text-critical">
						{t("agentMap.failedCount", { count: failures })}
					</span>
				) : null}
				{total !== null && total > 0 ? (
					<span>
						{live
							? t("agentMap.state.sinceAsk", { duration: duration(total / 1000) })
							: t("agentMap.state.total", { duration: duration(total / 1000) })}
					</span>
				) : null}
			</span>
			{/* Le travail fini se relit : la visite part d'ici. */}
			{!live && !waiting && onTour ? (
				<button
					type="button"
					onClick={onTour}
					className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-accent-ink hover:brightness-110"
				>
					<Route size={12} />
					{t("agentMap.state.tour")}
				</button>
			) : null}
		</div>
	);
}

/* ── Les nœuds ───────────────────────────────────────────────────────── */

function StepNode({ data }: NodeProps<Node<MapNode>>) {
	const { t } = useTranslation("components2");
	const Icon = ICONS[data.icon];
	const live = data.phase === "live";
	const yours = data.phase === "yours";
	// Un message qui montre quelque chose le montre d'abord : l'image, puis le texte.
	const shows = data.icon === "answer" || data.icon === "question";
	return (
		<div
			className={clsx(
				"relative flex cursor-pointer flex-col gap-2 rounded-2xl border bg-surface px-3.5 py-3 transition-[border-color,box-shadow,transform] duration-300 hover:-translate-y-0.5",
				data.phase === "done" && "border-transparent",
				live && "border-accent shadow-[0_0_0_4px_var(--color-accent-dim)]",
				yours && "border-warning shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-warning)_20%,transparent)]",
				data.phase === "failed" && "border-critical/60",
				data.warn && data.phase === "done" && "border-warning/60",
				// Choisir une carte n'est pas la mettre au travail : un contour d'encre,
				// jamais la couleur de ce qui tourne.
				data.selected && "outline-2 outline-offset-2 outline-ink-muted outline-solid",
			)}
			style={{
				width: WIDTH,
				boxShadow: live || yours ? undefined : "var(--shadow-card)",
			}}
		>
			<Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-line" />
			<Handle id="up" type="target" position={Position.Top} className="!size-1.5 !border-0 !opacity-0" />
			{live || yours ? (
				<span
					className={clsx(
						"animate-pulse-dot pointer-events-none absolute -inset-[6px] rounded-[22px] border",
						live ? "border-accent/40" : "border-warning/50",
					)}
				/>
			) : null}

			<div className="flex items-center gap-2">
				<span
					className={clsx(
						"grid size-7 shrink-0 place-items-center rounded-lg",
						// Fini, c'est neutre. Le vert ne dit qu'une chose : les tests passent.
						data.phase === "done" && data.icon === "test" && "bg-success/12 text-success",
						data.phase === "done" && data.icon !== "test" && "bg-raised text-ink-muted",
						live && "bg-accent text-accent-ink",
						yours && "bg-warning text-accent-ink",
						data.phase === "failed" && "bg-critical/15 text-critical",
					)}
				>
					{data.phase === "failed" ? <AlertTriangle size={14} /> : <Icon size={14} />}
				</span>
				<span
					className={clsx(
						"min-w-0 flex-1 truncate font-mono text-[10px] tracking-[0.08em] uppercase",
						yours ? "text-warning" : live ? "text-accent" : "text-ink-faint",
					)}
				>
					{data.eyebrow}
				</span>
				{data.icon === "answer" || data.icon === "question" ? (
					<MessageSquareText size={12} className="shrink-0 text-ink-faint" />
				) : null}
				{data.remarked ? (
					<MessageSquarePlus size={12} className="shrink-0 text-accent" aria-label={t("agentMap.node.remarkPending")} />
				) : null}
				{data.since ? (
					<Since at={data.since} />
				) : data.took ? (
					<span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums" title={t("agentMap.node.took")}>
						{duration(data.took / 1000)}
					</span>
				) : null}
				{data.toggles ? (
					<span
						data-fold
						className="flex shrink-0 items-center gap-1 rounded px-1 font-mono text-[10px] text-ink-faint hover:bg-hover hover:text-ink"
						title={data.toggles === "expand" ? t("agentMap.node.expandTitle") : t("agentMap.node.collapseTitle")}
					>
						{data.toggles === "expand" ? <ChevronsLeftRight size={12} /> : <ChevronsRightLeft size={12} />}
						{data.toggles === "expand" ? t("agentMap.node.expand") : t("agentMap.node.collapse")}
					</span>
				) : null}
			</div>

			{shows && data.media && data.media.length > 0 ? <Mosaic media={data.media} /> : null}
			{shows && data.diagram ? <Diagram source={data.diagram} compact /> : null}
			{shows && data.illustrations?.length ? (
				<span className="flex items-center gap-1.5 rounded-lg bg-accent-dim/60 px-2 py-1 text-[11px] text-accent">
					<Images size={12} className="shrink-0" />
					<span className="min-w-0 truncate">
						{t("agentMap.media.images", { count: data.illustrations.length })} ·{" "}
						{[...new Set(data.illustrations.map((item) => genreShort(item.genre)))].join(", ")}
					</span>
				</span>
			) : null}

			<div
				className={clsx(
					"text-[12.5px] leading-snug text-ink",
					data.icon === "answer" || data.icon === "ask" ? "line-clamp-4" : "line-clamp-2 font-semibold",
				)}
			>
				{data.title}
			</div>

			{data.footprint ? <FootprintSketch print={data.footprint} /> : null}

			{data.bars ? (
				<div className="flex items-center gap-2">
					<div className="flex h-1.5 flex-1 gap-[2px]">
						<span
							className="rounded-full bg-success"
							style={{ width: `${(data.bars.added / data.bars.scale) * 100}%` }}
						/>
						<span
							className="rounded-full bg-critical/80"
							style={{ width: `${(data.bars.removed / data.bars.scale) * 100}%` }}
						/>
					</div>
					<span className="font-mono text-[10px] text-ink-faint tabular-nums">
						+{data.bars.added} −{data.bars.removed}
					</span>
				</div>
			) : null}

			{!shows && data.media && data.media.length > 0 ? (
				data.icon === "visual" || data.icon === "delivered" ? (
					<Mosaic media={data.media} />
				) : (
					<div className="flex gap-1">
						{data.media.slice(0, 5).map((media, index) => (
							<span
								key={media.key}
								role="button"
								title={t("agentMap.viewLarge")}
								onClick={(event) => {
									if (media.kind === "pdf") return;
									event.stopPropagation();
									openLightbox(data.media ?? [], index);
								}}
								className="cursor-zoom-in"
							>
								<MediaThumb media={media} width={36} className="size-9 rounded-md border border-line-soft" />
							</span>
						))}
					</div>
				)
			) : null}

			{data.dots && data.dots.length > 0 ? (
				<div className="flex flex-wrap gap-[3px]">
					{data.dots.map((dot) => (
						<span
							key={dot.key}
							title={dot.label}
							className={clsx(
								"h-2.5 w-2 rounded-[3px]",
								dot.tone === "failed" ? "bg-critical" : "bg-info/50",
							)}
						/>
					))}
				</div>
			) : null}

			{data.detail ? (
				<div
					className={clsx(
						"truncate font-mono text-[10px]",
						live ? "text-accent" : data.phase === "failed" ? "text-critical" : "text-ink-faint",
					)}
				>
					{data.detail}
				</div>
			) : null}

			{data.warn ? (
				<div className="flex items-center gap-1 truncate font-mono text-[10px] text-warning">
					<Repeat size={10} className="shrink-0" />
					<span className="truncate">{data.warn}</span>
				</div>
			) : null}

			<Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-line" />
			<Handle id="down" type="source" position={Position.Bottom} className="!size-1.5 !border-0 !opacity-0" />
		</div>
	);
}

/**
 * Depuis quand l'étape en cours tourne. Au-delà de quelques minutes, une
 * commande qui ne rend pas la main et un agent qui travaille se dessinaient
 * pareil : la durée passe à l'orange.
 */
function Since({ at }: { at: number }) {
	const { t } = useTranslation("components2");
	const now = useNow(1000);
	const elapsed = Math.max(0, now - at);
	const long = elapsed > QUIET_MS;
	return (
		<span
			className={clsx("shrink-0 font-mono text-[10px] tabular-nums", long ? "font-semibold text-warning" : "text-accent")}
			title={long ? t("agentMap.since.longTitle") : t("agentMap.since.title")}
		>
			{duration(elapsed / 1000)}
		</span>
	);
}

/** Quatre vignettes au plus, la dernière comptant celles qui ne tiennent pas. */
function Mosaic({ media }: { media: Media[] }) {
	const { t } = useTranslation("components2");
	const shown = media.slice(0, 4);
	const rest = media.length - shown.length;
	const single = shown.length === 1;
	return (
		<div className={clsx("grid gap-1", single ? "grid-cols-1" : "grid-cols-2")}>
			{shown.map((item, index) => (
				// Une vignette s'ouvre en grand ; le reste de la carte ouvre son
				// détail. Un PDF garde le geste de la carte : il se lit ailleurs.
				<div
					key={item.key}
					role={item.kind === "pdf" ? undefined : "button"}
					title={item.kind === "pdf" ? undefined : t("agentMap.viewLarge")}
					onClick={
						item.kind === "pdf"
							? undefined
							: (event) => {
									event.stopPropagation();
									openLightbox(media, index);
								}
					}
					className={clsx(
						"relative overflow-hidden rounded-lg border border-line-soft bg-raised",
						item.kind !== "pdf" && "cursor-zoom-in hover:border-line",
					)}
				>
					<MediaThumb
						media={item}
						width={single ? WIDTH - 28 : (WIDTH - 32) / 2}
						className={clsx("w-full", single ? "h-28" : "h-16")}
					/>
					{item.kind === "pdf" ? (
						<span className="absolute bottom-1 left-1 rounded bg-void/80 px-1 font-mono text-[9px] text-ink">PDF</span>
					) : null}
					{stageOf(item) ? (
						<span className="absolute top-1 left-1 rounded bg-void/80 px-1 font-mono text-[9px] text-ink">
							{stageWord(stageOf(item) as "avant" | "après")}
						</span>
					) : null}
					{rest > 0 && index === shown.length - 1 ? (
						<span className="absolute inset-0 grid place-items-center bg-void/60 font-mono text-[12px] font-semibold text-ink">
							+{rest}
						</span>
					) : null}
				</div>
			))}
		</div>
	);
}

const FATE_TONE: Record<Fate, string> = {
	deleted: "bg-critical/80",
	created: "bg-success",
	modified: "bg-info/50",
};

/** Le sort d'un fichier, en un mot. */
function fateWord(fate: Fate): string {
	return tr(`fate.${fate}`);
}

/**
 * Le constat, en petit : une ligne par zone du dépôt, une tuile par fichier.
 * La couleur dit son sort, la largeur son volume.
 */
function FootprintSketch({ print }: { print: Footprint }) {
	return (
		<div className="flex flex-col gap-1.5">
			{print.zones.map((zone) => (
				<div key={zone.name} className="flex flex-col gap-1">
					<div className="flex items-baseline gap-2 font-mono text-[10px] text-ink-faint">
						<span className="min-w-0 flex-1 truncate" title={zone.name}>
							{zone.name}
						</span>
						<span className="shrink-0 tabular-nums">
							+{zone.added} −{zone.removed}
						</span>
					</div>
					<div className="flex max-h-[26px] flex-wrap gap-[3px] overflow-hidden">
						{zone.tiles.map((tile) => (
							<span
								key={tile.path}
								title={`${tile.path} — ${fateWord(tile.fate)}, +${tile.added} −${tile.removed}`}
								className={clsx("h-3 rounded-[3px]", FATE_TONE[tile.fate])}
								style={{ width: tileWidth(tile) }}
							/>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

/** Le constat, en grand : chaque fichier nommé, rangé dans sa zone. */
function FootprintDetail({ print, onTour }: { print: Footprint; onTour?: () => void }) {
	const { t } = useTranslation("components2");
	const viewer = useFileViewer();
	const scale = Math.max(1, ...print.zones.flatMap((zone) => zone.tiles.map((tile) => tile.added + tile.removed)));
	const fates: Array<[Fate, number]> = [
		["deleted", print.deleted],
		["created", print.created],
		["modified", print.modified],
	];
	return (
		<div className="pb-3">
			<p className="px-4 pt-3 text-[11.5px] leading-relaxed text-ink-muted">
				{t("agentMap.footprint.lede", { base: print.baseLabel })}
			</p>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2 font-mono text-[10.5px] text-ink-muted">
				{fates
					.filter(([, count]) => count > 0)
					.map(([fate, count]) => (
						<span key={fate} className="flex items-center gap-1.5">
							<span className={clsx("size-2.5 rounded-[3px]", FATE_TONE[fate])} />
							{t(`agentMap.fateCount.${fate}`, { count })}
						</span>
					))}
				<span className="ml-auto tabular-nums">
					+{print.additions} −{print.deletions}
				</span>
			</div>
			{onTour ? (
				<div className="px-4 pt-3">
					<button
						type="button"
						onClick={onTour}
						className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110"
					>
						<Route size={13} />
						{t("agentMap.tourFiles")}
					</button>
				</div>
			) : null}
			{print.zones.map((zone) => (
				<div key={zone.name}>
					<div className="flex items-baseline gap-2 px-4 pt-3 pb-1 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
						<span className="min-w-0 flex-1 truncate">{zone.name}</span>
						<span className="shrink-0 tabular-nums">
							+{zone.added} −{zone.removed}
						</span>
					</div>
					{zone.tiles.map((tile) => {
						const gone = tile.fate === "deleted";
						return (
							<button
								key={tile.path}
								type="button"
								// Un fichier supprimé n'a plus rien à ouvrir : sa ligne reste, inerte.
								disabled={gone || !viewer}
								onClick={() => viewer?.open(`${print.root.replace(/\/$/, "")}/${tile.path}`)}
								title={tile.path}
								className="focus-ring flex w-full items-center gap-2 px-4 py-1 text-left enabled:hover:bg-hover"
							>
								<span className={clsx("size-2.5 shrink-0 rounded-[3px]", FATE_TONE[tile.fate])} />
								<span className={clsx("min-w-0 flex-1 truncate text-[12px]", gone ? "text-ink-muted line-through" : "text-ink")}>
									{tile.name}
								</span>
								<span className="flex h-1.5 w-16 shrink-0 gap-[2px]">
									<span className="rounded-full bg-success" style={{ width: `${(tile.added / scale) * 100}%` }} />
									<span className="rounded-full bg-critical/80" style={{ width: `${(tile.removed / scale) * 100}%` }} />
								</span>
								<span className="w-[68px] shrink-0 text-right font-mono text-[10px] text-ink-faint tabular-nums">
									+{tile.added} −{tile.removed}
								</span>
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}

/** Ce qui a été livré, chaque chose là où elle se consulte. */
function DeliveredDetail({ delivered, onTour }: { delivered: Delivered; onTour?: () => void }) {
	const { t } = useTranslation("components2");
	const section = "px-4 pt-3 pb-1 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase";
	return (
		<div className="pb-3">
			{onTour ? (
				<div className="px-4 pt-3">
					<button
						type="button"
						onClick={onTour}
						className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110"
					>
						<Route size={13} />
						{t("agentMap.tourFiles")}
					</button>
				</div>
			) : null}
			{delivered.reviews.length > 0 ? (
				<>
					<div className={section}>{t("agentMap.deliveredSections.pullRequests")}</div>
					{delivered.reviews.map((review) => (
						<button
							key={review.url}
							type="button"
							onClick={() => void api.system.openUrl(review.url)}
							className="focus-ring flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-hover"
						>
							<GitPullRequest size={13} className="shrink-0 text-accent" />
							<span className="text-[12px] font-semibold text-ink">{review.label}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">{review.url}</span>
							<ExternalLink size={11} className="shrink-0 text-ink-faint" />
						</button>
					))}
				</>
			) : null}
			{delivered.commits.length > 0 ? (
				<>
					<div className={section}>{t("agentMap.deliveredSections.commits")}</div>
					{delivered.commits.map((commit) => (
						<div key={commit.sha} className="flex items-baseline gap-2 px-4 py-1">
							<GitCommitHorizontal size={12} className="shrink-0 self-center text-ink-faint" />
							<span className="shrink-0 font-mono text-[10.5px] text-accent">{commit.sha}</span>
							<span className="min-w-0 flex-1 truncate text-[12px] text-ink">{commit.message}</span>
							<span className="shrink-0 font-mono text-[10px] text-ink-faint">{commit.branch}</span>
						</div>
					))}
				</>
			) : null}
			{delivered.pushed.length > 0 ? (
				<>
					<div className={section}>{t("agentMap.deliveredSections.pushed")}</div>
					{delivered.pushed.map((branch) => (
						<div key={branch} className="flex items-center gap-2 px-4 py-1 font-mono text-[11px] text-ink">
							<GitBranch size={12} className="shrink-0 text-ink-faint" />
							{branch}
						</div>
					))}
				</>
			) : null}
			{delivered.media.length > 0 ? (
				<>
					<div className={section}>{t("agentMap.deliveredSections.files")}</div>
					<Gallery media={delivered.media} />
				</>
			) : null}
		</div>
	);
}

/**
 * Tous les visuels de l'épisode, en grand. Un fichier s'ouvre dans la
 * visionneuse — le PDF s'y lit page à page ; une capture renvoyée par un
 * outil n'existe qu'en mémoire, elle s'agrandit sur place.
 */
function Gallery({ media }: { media: Media[] }) {
	const { t } = useTranslation("components2");
	const viewer = useFileViewer();
	const [zoomed, setZoomed] = useState<string | null>(null);
	return (
		<div className="grid grid-cols-2 gap-2 p-3">
			{media.map((item) => {
				const big = zoomed === item.key;
				return (
					<button
						key={item.key}
						type="button"
						onClick={() => {
							// Une image ou une vidéo s'ouvre en grand ; un PDF se lit
							// page à page dans la visionneuse.
							if (item.kind !== "pdf") openLightbox(media, media.indexOf(item));
							else if (item.path && viewer) viewer.open(item.path);
							else setZoomed(big ? null : item.key);
						}}
						title={item.kind === "pdf" ? (item.path ?? t("agentMap.gallery.enlarge")) : t("agentMap.viewLarge")}
						className={clsx(
							"focus-ring group flex flex-col overflow-hidden rounded-xl border border-line-soft bg-raised text-left hover:border-line",
							big && "col-span-2",
						)}
					>
						<MediaThumb
							media={item}
							width={big ? 420 : 200}
							className={clsx("w-full", big ? "h-auto object-contain" : "h-32")}
						/>
						<span className="flex items-center gap-1.5 px-2 py-1.5">
							{item.kind === "pdf" ? <FileText size={11} className="shrink-0 text-ink-faint" /> : null}
							<span className="min-w-0 truncate font-mono text-[10px] text-ink-muted">{item.label}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}

const NODE_TYPES = { step: StepNode };

/** Recadre quand un nœud apparaît, sans remonter le graphe pour autant. */
/**
 * La marge du cadrage : une question posée occupe le haut de la carte, les
 * tuiles sa gauche — les étapes se rangent à côté, pas dessous.
 */
function framePadding(padded: boolean, rail: boolean) {
	if (!padded && !rail) return 0.2;
	return {
		top: padded ? "300px" : "56px",
		bottom: padded ? "32px" : "56px",
		left: rail ? `${RAIL_WIDTH + 28}px` : "48px",
		right: "48px",
	} as const;
}

function Refit({ framed, padded, rail, enabled }: { framed: string[]; padded: boolean; rail: boolean; enabled: boolean }) {
	const { fitView } = useReactFlow();
	const shape = framed.join(",");
	// Cadrer sur des nœuds pas encore mesurés ne fait rien : on attend qu'ils le
	// soient. Pas `useNodesInitialized` : la carte passe ses nœuds sans
	// `onNodesChange`, les mesures ne reviennent donc jamais dans nos objets et
	// ce drapeau restait faux pour toujours — la carte ne se recadrait plus
	// qu'au montage, et une étape ajoutée en direct tombait hors du cadre.
	const ready = useStore((state) =>
		framed.every((id) => Boolean(state.nodeLookup.get(id)?.measured.width)),
	);
	// Une carte qui grandit (une alerte, une vignette) change le cadre autant
	// qu'une carte qui apparaît : sans ça, le bas d'une colonne restait coupé.
	const extent = useStore((state) =>
		framed
			.map((id) => {
				const node = state.nodeLookup.get(id);
				return node ? `${Math.round(node.internals.positionAbsolute.y)}:${node.measured.height ?? 0}` : "";
			})
			.join(","),
	);
	useEffect(() => {
		if (!ready || !enabled) return;
		// Deux images d'attente : à la première, les nœuds qu'on vient de déplier
		// sont montés mais pas encore mesurés, et le cadrage les ignorerait.
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() =>
			void fitView({
				nodes: shape.split(",").map((id) => ({ id })),
				padding: framePadding(padded, rail),
				maxZoom: 1,
				duration: 320,
			}),
			);
		});
		return () => cancelAnimationFrame(frame);
	}, [shape, extent, padded, rail, fitView, ready, enabled]);
	return null;
}
