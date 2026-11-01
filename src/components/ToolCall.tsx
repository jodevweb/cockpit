import clsx from "clsx";
import {
	Bot,
	ChevronRight,
	FileText,
	Globe,
	ListTodo,
	PenLine,
	Search,
	Terminal,
	Wrench,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { FileLink, resolvePath } from "@/components/FileLink";
import { LocalImage, isImagePath } from "@/components/LocalImage";
import { Spinner } from "@/components/ui";
import { useFileViewer } from "@/lib/fileViewer";
import { api } from "@/lib/ipc";
import { hasTauri } from "@/lib/preview";
import type { Turn } from "@/app/agents";

/**
 * Un appel d'outil, lisible.
 *
 * La conversation n'en montrait que le nom — « Bash », « Read », « Grep » —
 * suivi d'un bout d'entrée tronqué, et jamais ce que l'outil avait répondu. On
 * suivait donc un agent sans savoir ce qu'il trouvait : vingt lignes « Bash »
 * d'affilée ne disent ni ce qui a été lancé, ni si ça a marché.
 *
 * Le parti pris est de tout tenir sur une ligne, dépliable. Chaque appel dit ce
 * qu'il fait dans les mots du métier — « Lu », « Modifié », « Cherché » — avec
 * sa cible ; ce qu'il a répondu attend qu'on le demande. Une sortie en erreur,
 * elle, se signale d'elle-même : c'est le seul cas où l'on veut être arrêté.
 */

interface Shape {
	icon: React.ComponentType<{ size?: number; className?: string }>;
	verb: string;
	/** La cible, telle qu'on la reconnaît : un fichier, un motif, une commande. */
	target: string;
	/** Vrai quand la cible est un chemin, donc ouvrable. */
	isFile: boolean;
	/** Précision de second rang : le dossier fouillé, les lignes lues. */
	note?: string;
	/** La cible est une commande shell — police à chasse fixe, jamais tronquée. */
	mono?: boolean;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Nombre de lignes d'un fragment, pour chiffrer une édition. */
function count(value: unknown): number {
	const body = text(value);
	return body ? body.split("\n").length : 0;
}

/**
 * Ce qu'un appel d'outil raconte, d'après son entrée.
 *
 * Les noms viennent du CLI ; ceux qu'on ne connaît pas — un outil MCP, un
 * nouveau venu — retombent sur leur propre nom plutôt que de disparaître.
 */
function describe(turn: Turn): Shape {
	const input = turn.input ?? {};
	const tool = turn.tool ?? "outil";
	const file = text(input.file_path) || text(input.notebook_path);
	const pattern = text(input.pattern);

	switch (tool) {
		case "Bash":
		case "BashOutput": {
			const command = text(input.command) || turn.text;
			return {
				icon: Terminal,
				verb: text(input.description) || "Shell",
				target: command,
				isFile: false,
				mono: true,
			};
		}
		case "Read": {
			const from = input.offset ? Number(input.offset) : null;
			const limit = input.limit ? Number(input.limit) : null;
			return {
				icon: FileText,
				verb: "Lu",
				target: file || turn.text,
				isFile: true,
				note: from ? `à partir de la ligne ${from}` : limit ? `${limit} lignes` : undefined,
			};
		}
		case "Write":
			return {
				icon: PenLine,
				verb: "Écrit",
				target: file || turn.text,
				isFile: true,
				note: `${count(input.content)} lignes`,
			};
		case "Edit": {
			const removed = count(input.old_string);
			const added = count(input.new_string);
			return {
				icon: PenLine,
				verb: "Modifié",
				target: file || turn.text,
				isFile: true,
				note: `+${added} −${removed}`,
			};
		}
		case "NotebookEdit":
			return { icon: PenLine, verb: "Modifié", target: file || turn.text, isFile: true };
		case "Grep":
			return {
				icon: Search,
				verb: "Cherché",
				target: pattern || turn.text,
				isFile: false,
				note: text(input.path) || undefined,
				mono: true,
			};
		case "Glob":
			return {
				icon: Search,
				verb: "Listé",
				target: pattern || turn.text,
				isFile: false,
				note: text(input.path) || undefined,
				mono: true,
			};
		case "Task":
			return {
				icon: Bot,
				verb: "Sous-agent",
				target: text(input.description) || turn.text,
				isFile: false,
				note: text(input.subagent_type) || undefined,
			};
		case "WebFetch":
			return { icon: Globe, verb: "Consulté", target: text(input.url), isFile: false };
		case "WebSearch":
			return { icon: Globe, verb: "Recherché", target: text(input.query), isFile: false };
		case "TodoWrite":
			return { icon: ListTodo, verb: "Liste de tâches", target: "", isFile: false };
		case "mcp__cockpit__etapes": {
			const etapes = Array.isArray(input.etapes) ? (input.etapes as Array<Record<string, unknown>>) : [];
			const faites = etapes.filter((etape) => etape.etat === "faite").length;
			return { icon: ListTodo, verb: "Étapes", target: `${faites} / ${etapes.length} faites`, isFile: false };
		}
		default:
			return { icon: Wrench, verb: tool, target: turn.text, isFile: false };
	}
}

/**
 * L'icône d'un outil, sans son appel.
 *
 * Le journal d'une session ne tient pas des `Turn` mais des événements relus
 * d'un fichier : il n'a pas l'entrée structurée que `describe` exploite, et
 * affichait donc la même clé à molette pour lire un fichier, lancer une suite
 * de tests ou déléguer à un sous-agent. La table est la même — la dupliquer
 * l'aurait laissée diverger au premier outil ajouté.
 */
/**
 * Ce qu'un appel fait, en deux mots — pour le dire ailleurs que sur sa ligne.
 *
 * Le bandeau des sous-agents doit annoncer où en est chacun d'eux sans
 * réinventer la table des outils, qui vit ici et n'a pas à être recopiée.
 */
export function actionCourte(turn: Turn): string {
	const shape = describe(turn);
	const cible = shape.isFile ? (shape.target.split("/").pop() ?? "") : shape.target;
	return cible ? `${shape.verb} ${cible}` : shape.verb;
}

export function toolIcon(tool: string | null | undefined) {
	return describe({ kind: "tool", text: "", tool: tool ?? undefined }).icon;
}

/** Une sortie utile à lire, ou le silence poli d'un outil qui a fait son travail. */
function summarize(output: string): string {
	const lines = output.split("\n").filter((line) => line.trim());
	if (lines.length === 0) return "";
	return lines.length === 1 ? lines[0].slice(0, 120) : `${lines.length} lignes`;
}

export function ToolCall({
	turn,
	cwd,
	running,
	sub,
	openOnDemand,
}: {
	turn: Turn;
	cwd: string;
	/** L'agent travaille encore : sans quoi une sortie absente est définitive. */
	running: boolean;
	/**
	 * Le fil du sous-agent lancé par cet appel, déjà rendu.
	 *
	 * Passé tout fait plutôt que construit ici : afficher une conversation est
	 * le travail de l'écran qui en tient une, et le lui demander d'ici ferait
	 * s'importer mutuellement les deux modules.
	 */
	sub?: ReactNode;
	/**
	 * Ouvre cet appel sans qu'on ait cliqué dessus.
	 *
	 * Le bandeau des sous-agents renvoie vers l'appel qui a lancé celui qu'on
	 * suit : y arriver replié obligerait à un second clic, au bon endroit, sur
	 * une ligne qu'on vient à peine de trouver.
	 */
	openOnDemand?: boolean;
}) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (openOnDemand) setOpen(true);
	}, [openOnDemand]);
	const [zoomed, setZoomed] = useState<number | null>(null);
	const viewer = useFileViewer();
	const shape = describe(turn);
	const output = turn.output ?? "";
	// Ce que l'appel donne à voir. Deux sources, jamais les deux à la fois : les
	// images que l'outil a réellement renvoyées, ou — quand il a lu un fichier
	// image sans rien rapporter d'affichable — le fichier lui-même, relu du
	// disque plutôt que gardé en mémoire.
	const returned = turn.outputImages ?? [];
	const readFile =
		returned.length === 0 &&
		shape.isFile &&
		shape.target &&
		isImagePath(shape.target) &&
		// Hors de la fenêtre native, aucun fichier du poste n'est lisible :
		// l'aperçu navigateur n'afficherait qu'un cadre cassé.
		hasTauri()
			? resolvePath(shape.target, cwd).target
			: null;
	// Tant que la sortie n'est pas là et que l'agent tourne, l'outil travaille.
	// Un agent arrêté, lui, ne rendra plus rien : afficher une attente serait
	// mentir sur ce qui va se passer.
	const pending = turn.output === undefined && running;
	// Ce qu'un sous-agent a déjà fait, pendant qu'il le fait. Sans ce compte, la
	// ligne d'un `Task` reste identique pendant des minutes : on ne sait pas si
	// le sous-agent avance, ni s'il est parti quelque part.
	const étapes = turn.sub?.length ?? 0;
	const summary =
		summarize(output) ||
		(returned.length > 0 ? "image" : "") ||
		(étapes > 0 && !output ? `${étapes} étape${étapes > 1 ? "s" : ""}` : "");

	return (
		<div
			className={clsx(
				"rounded-lg px-1.5",
				turn.outputError && "border border-critical/30 bg-critical/[0.04]",
			)}
		>
			<div className="flex items-baseline gap-2 py-0.5">
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					// Un sous-agent se déplie dès qu'il commence à parler : sa sortie,
					// elle, n'arrivera qu'à la fin de son travail, et c'est pendant
					// qu'il travaille qu'on veut pouvoir regarder.
					disabled={!output && !sub}
					title={
						sub
							? "Voir ce que fait ce sous-agent"
							: output
								? "Voir ce que l'outil a répondu"
								: undefined
					}
					className={clsx(
						"focus-ring -ml-1 flex min-w-0 flex-1 items-baseline gap-2 rounded px-1 text-left",
						(output || sub) && "hover:bg-hover",
					)}
				>
					<ChevronRight
						size={10}
						className={clsx(
							"shrink-0 self-center transition-transform",
							open && "rotate-90",
							output || sub ? "text-ink-faint" : "text-transparent",
						)}
					/>
					<shape.icon
						size={11}
						className={clsx(
							"shrink-0 self-center",
							turn.outputError ? "text-critical" : "text-info",
						)}
					/>
					<span className="shrink-0 text-[11px] font-medium text-info">{shape.verb}</span>

					{shape.target ? (
						shape.isFile ? (
							<FileLink
								path={shape.target}
								cwd={cwd}
								className="min-w-0 truncate font-mono text-[10px] text-ink-muted"
							/>
						) : (
							<span
								className={clsx(
									"min-w-0 flex-1 truncate text-[10px] text-ink-faint",
									shape.mono && "font-mono",
								)}
							>
								{shape.target}
							</span>
						)
					) : null}

					{shape.note ? (
						<span className="shrink-0 font-mono text-[10px] text-ink-faint/60">
							{shape.note}
						</span>
					) : null}

					<span className="ml-auto shrink-0 pl-2 text-[10px] text-ink-faint/60">
						{pending ? (
							<span className="flex items-center gap-1.5">
								{étapes > 0 ? <span>{summary}</span> : null}
								<Spinner />
							</span>
						) : turn.outputError ? (
							<span className="text-critical">échec</span>
						) : (
							summary
						)}
					</span>
				</button>
			</div>

			{/* Montrée, pas citée. Un agent qui lit une capture d'écran répondait
			    « Lu /tmp/gtA.png » et rien d'autre : le chemin était là, l'image
			    nulle part, et il fallait sortir de l'app pour savoir ce qu'il
			    venait de regarder. Elle tient sous la ligne, bornée en hauteur ;
			    le clic l'ouvre en grand. */}
			{returned.length > 0 || readFile ? (
				<div className="mb-1 flex flex-wrap gap-1.5 pb-0.5 pl-6">
					{readFile ? (
						<button
							type="button"
							// Même repli que les liens de fichiers : sans visionneuse
							// montée au-dessus de nous, l'éditeur du poste prend le relais.
							onClick={() =>
								viewer
									? viewer.open(readFile)
									: void api.system.openEditor(readFile).catch(() => undefined)
							}
							title={`${readFile}\nCliquer pour ouvrir`}
							className="focus-ring block overflow-hidden rounded-lg border border-line-soft bg-void transition-colors hover:border-line"
						>
							<LocalImage
								path={readFile}
								alt={readFile.split("/").pop() ?? ""}
								className="max-h-40 max-w-full object-contain"
							/>
						</button>
					) : null}
					{/* Celles-ci n'ont pas de fichier derrière elles — un outil qui
					    rend une capture ne l'écrit pas toujours quelque part. Rien à
					    ouvrir, donc : le clic les déplie sur place. */}
					{returned.map((image, index) => (
						<button
							key={index}
							type="button"
							onClick={() => setZoomed(zoomed === index ? null : index)}
							title={zoomed === index ? "Réduire" : "Agrandir"}
							className="focus-ring block overflow-hidden rounded-lg border border-line-soft bg-void transition-colors hover:border-line"
						>
							<img
								src={image}
								alt={`${shape.verb} ${index + 1}`}
								className={clsx(
									"max-w-full object-contain",
									zoomed === index ? "max-h-none" : "max-h-40",
								)}
							/>
						</button>
					))}
				</div>
			) : null}

			{/* Le fil du sous-agent, décalé et bordé : on doit voir d'un coup d'œil
			    que ces lignes sont d'un autre agent que celui qu'on lit. */}
			{open && sub ? (
				<div className="mb-1 ml-3 border-l-2 border-line-soft pl-2">{sub}</div>
			) : null}

			{open && output ? (
				<pre
					className={clsx(
						"text-selectable mb-1 max-h-72 overflow-auto rounded-lg border border-line-soft bg-void p-2.5 font-mono text-[11px] whitespace-pre-wrap",
						turn.outputError ? "text-critical/90" : "text-ink-muted",
					)}
				>
					{output}
				</pre>
			) : null}
		</div>
	);
}
