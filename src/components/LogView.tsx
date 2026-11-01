import anser from "anser";
import clsx from "clsx";
import { useMemo } from "react";
import type { JobLine } from "@/lib/types";
import { useStickToBottom } from "@/lib/useStickToBottom";

/**
 * Console de sortie d'un job. Les codes ANSI sont convertis en segments
 * colorés (pnpm, turbo et biome en émettent beaucoup), et l'auto-scroll se
 * désactive dès que tu remontes dans l'historique.
 */
export function LogView({ lines, empty }: { lines: JobLine[]; empty?: string }) {
	const bottom = useStickToBottom<HTMLDivElement>([lines]);

	return (
		<div
			ref={bottom.ref}
			onScroll={bottom.onScroll}
			className="text-selectable min-h-0 flex-1 overflow-auto bg-void px-3 py-2 font-mono text-[11px] leading-[1.65]"
		>
			{lines.length === 0 ? (
				<p className="px-1 py-6 text-center text-ink-faint">
					{empty ?? "Aucune sortie pour l'instant."}
				</p>
			) : (
				lines.map((line, index) => (
					<div
						key={`${line.at}-${index}`}
						className={
							line.stream === "stderr"
								? "whitespace-pre-wrap break-all text-critical/85"
								: "whitespace-pre-wrap break-all text-ink-muted"
						}
					>
						{anser
							.ansiToJson(line.line, { use_classes: false, json: true })
							.map((chunk, chunkIndex) => (
								<span
									key={`${index}-${chunkIndex}`}
									style={{
										color: chunk.fg ? `rgb(${chunk.fg})` : undefined,
										fontWeight: chunk.decoration === "bold" ? 600 : undefined,
									}}
								>
									{chunk.content}
								</span>
							))}
					</div>
				))
			)}
		</div>
	);
}

type DiffRow =
	| { kind: "hunk"; text: string }
	| { kind: "file"; text: string }
	| {
			kind: "add" | "remove" | "context";
			text: string;
			oldNo: number | null;
			newNo: number | null;
	  };

/**
 * Découpe un diff unifié en lignes numérotées.
 *
 * Les numéros ne sont pas dans le texte : ils se déduisent des en-têtes de hunk
 * `@@ -12,7 +12,9 @@`, puis s'incrementent selon le côté touché. Sans eux, on
 * lit un diff sans jamais savoir où on est dans le fichier.
 */
function parseDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;

	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) {
			const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match) {
				oldNo = Number(match[1]);
				newNo = Number(match[2]);
			}
			rows.push({ kind: "hunk", text: line });
			continue;
		}
		// En-têtes de fichier : `diff --git`, `index`, `+++`, `---`, `new file`…
		if (
			line.startsWith("diff ") ||
			line.startsWith("index ") ||
			line.startsWith("+++") ||
			line.startsWith("---") ||
			line.startsWith("new file") ||
			line.startsWith("deleted file") ||
			line.startsWith("similarity index") ||
			line.startsWith("rename ")
		) {
			rows.push({ kind: "file", text: line });
			continue;
		}
		if (line.startsWith("+")) {
			rows.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
			continue;
		}
		if (line.startsWith("-")) {
			rows.push({ kind: "remove", text: line.slice(1), oldNo: oldNo++, newNo: null });
			continue;
		}
		if (line.startsWith("\\")) {
			// « \ No newline at end of file »
			rows.push({ kind: "file", text: line });
			continue;
		}
		rows.push({
			kind: "context",
			text: line.startsWith(" ") ? line.slice(1) : line,
			oldNo: oldNo++,
			newNo: newNo++,
		});
	}

	return rows;
}

/**
 * Diff unifié en trois colonnes : numéros d'origine, numéros d'arrivée, contenu.
 *
 * La couleur seule ne suffit pas à distinguer un ajout d'une suppression — d'où
 * la gouttière `+`/`−` et le liseré à gauche, qui restent lisibles même sur les
 * lignes longues et pour un œil qui distingue mal le rouge du vert.
 */
export function DiffView({ diff }: { diff: string }) {
	const rows = useMemo(() => parseDiff(diff), [diff]);

	if (!diff.trim()) {
		return (
			<p className="px-3 py-6 text-center text-[11px] text-ink-faint">
				Aucune modification à afficher.
			</p>
		);
	}

	return (
		<div className="text-selectable overflow-auto bg-void font-mono text-[11px] leading-[1.6]">
			{rows.map((row, index) => {
				if (row.kind === "file") {
					return (
						<div
							key={index}
							className="truncate bg-surface/60 px-3 py-0.5 text-[10px] text-ink-faint"
						>
							{row.text}
						</div>
					);
				}

				if (row.kind === "hunk") {
					return (
						<div
							key={index}
							className="mt-1 border-y border-line-soft bg-raised/40 px-3 py-0.5 text-[10px] text-accent-soft"
						>
							{row.text}
						</div>
					);
				}

				const added = row.kind === "add";
				const removed = row.kind === "remove";
				return (
					<div
						key={index}
						className={clsx(
							"flex items-start",
							added && "bg-success/10",
							removed && "bg-critical/10",
						)}
					>
						<span className="w-11 shrink-0 select-none pr-2 text-right text-[10px] text-ink-faint/50 tabular-nums">
							{row.oldNo ?? ""}
						</span>
						<span className="w-11 shrink-0 select-none pr-2 text-right text-[10px] text-ink-faint/50 tabular-nums">
							{row.newNo ?? ""}
						</span>
						<span
							className={clsx(
								"w-4 shrink-0 select-none border-l-2 text-center",
								added && "border-success/60 text-success",
								removed && "border-critical/60 text-critical",
								!added && !removed && "border-transparent text-transparent",
							)}
						>
							{added ? "+" : removed ? "−" : " "}
						</span>
						<span
							className={clsx(
								"min-w-0 flex-1 pr-3 whitespace-pre-wrap break-all",
								added && "text-success",
								removed && "text-critical",
								!added && !removed && "text-ink-muted",
							)}
						>
							{row.text || " "}
						</span>
					</div>
				);
			})}
		</div>
	);
}
