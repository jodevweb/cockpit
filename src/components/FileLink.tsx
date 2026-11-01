import clsx from "clsx";
import { Fragment, type ReactNode } from "react";
import { useFileViewer } from "@/lib/fileViewer";
import { api } from "@/lib/ipc";
import { useTranslation } from "react-i18next";
import { modKey, platformContext } from "@/lib/platform";
import { fileUrl, isAbsolutePath, joinPath, toSlashes } from "@/lib/paths";

/**
 * Les chemins de fichiers cités par un agent, rendus ouvrables.
 *
 * Un agent annonce son travail en le nommant — « écrit dans
 * `.claude/reviews/review-PR-1785.md` ». Le chemin est là, exact, mais il
 * fallait le recopier à la main dans un terminal ou aller le chercher dans un
 * autre écran. Il devient un lien.
 *
 * Reconnaître un chemin dans du texte libre demande de choisir entre en rater
 * et en inventer. On préfère en rater : une extension connue est exigée, si
 * bien que « et/ou » ou « lundi/mardi » ne deviennent pas des liens morts. Un
 * chemin sans extension — un dossier — n'est pas reconnu non plus.
 */

const EXTENSIONS = [
	"md",
	"mdx",
	"txt",
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"jsonc",
	"toml",
	"yaml",
	"yml",
	"lock",
	"rs",
	"py",
	"rb",
	"go",
	"java",
	"kt",
	"swift",
	"c",
	"h",
	"cpp",
	"sh",
	"bash",
	"zsh",
	"sql",
	"prisma",
	"graphql",
	"gql",
	"css",
	"scss",
	"html",
	"vue",
	"svelte",
	"svg",
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"pdf",
	"csv",
	"xml",
	"ini",
	"conf",
	"env",
	"log",
	// Ce qu'un agent produit pour qu'on le regarde plutôt qu'on le lise : une
	// démo filmée, un enregistrement, un document de travail.
	"mp4",
	"m4v",
	"mov",
	"webm",
	"mkv",
	"avi",
	"mp3",
	"m4a",
	"wav",
	"ogg",
	"flac",
	"heic",
	"avif",
	"docx",
	"doc",
	"xlsx",
	"xls",
	"pptx",
	"ppt",
	"key",
	"pages",
	"numbers",
	"odt",
	"rtf",
	"zip",
];

/**
 * Un chemin : au moins un séparateur, puis une extension connue.
 *
 * Le suffixe `:12` ou `:12:5` est courant dans les sorties d'outils — on le
 * capture pour ne pas couper le lien au milieu, et on le retire à l'ouverture.
 *
 * Sous Windows, un agent écrit `C:\Users\…\app.ts` ou `src\app.ts` : la lettre
 * de lecteur et la contre-oblique comptent aussi.
 */
const PATH = new RegExp(
	String.raw`(?:\b[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+\.(?:${EXTENSIONS.join("|")})\b(?::\d+(?::\d+)?)?`,
	"g",
);

/** Le texte entier est-il un chemin ? Sert pour le code inline du markdown. */
export function isPath(text: string): boolean {
	const trimmed = text.trim();
	if (/\s/.test(trimmed)) return false;
	const match = trimmed.match(new RegExp(PATH.source));
	return match?.[0] === trimmed;
}

/**
 * Chemin absolu réellement ouvrable, et la ligne visée s'il y en a une.
 *
 * Les agents citent presque toujours des chemins relatifs à leur worktree :
 * sans lui, `.claude/reviews/x.md` ne désigne rien.
 */
export function resolvePath(
	path: string,
	cwd?: string | null,
): { target: string; line?: number } {
	const at = path.match(/:(\d+)(?::\d+)?$/);
	const clean = path.replace(/:\d+(?::\d+)?$/, "");
	const line = at ? Number(at[1]) : undefined;

	if (isAbsolutePath(clean)) return { target: toSlashes(clean), line };
	if (!cwd) return { target: toSlashes(clean).replace(/^\.\//, ""), line };
	return { target: joinPath(cwd, clean), line };
}

export function FileLink({
	path,
	cwd,
	className,
	children,
}: {
	path: string;
	cwd?: string | null;
	className?: string;
	children?: ReactNode;
}) {
	const { t } = useTranslation("components1");
	const { target, line } = resolvePath(path, cwd);
	const viewer = useFileViewer();

	return (
		<button
			type="button"
			// Le glisser reste posé — il ne coûte rien et fonctionne partout où le
			// navigateur gère le dépôt HTML5. Mais il n'est plus annoncé : dans la
			// fenêtre native, le dépôt de fichiers est capté par le système avant
			// le webview, et rien ne garantit qu'un glisser sortant aboutisse. Une
			// infobulle qui promet un geste qui ne marche peut-être pas est pire
			// que le silence — ⇧-clic, lui, copie le chemin à coup sûr.
			draggable
			onDragStart={(event) => {
				event.dataTransfer.setData("text/uri-list", fileUrl(target));
				event.dataTransfer.setData("text/plain", target);
				event.dataTransfer.effectAllowed = "copy";
			}}
			title={`${target}\n\n${t("fileLink.hint", { context: platformContext })}`}
			onClick={(event) => {
				event.stopPropagation();
				// Lire sans quitter l'app est le geste courant ; l'éditeur reste à
				// une touche pour ce qu'on vient modifier. Sans visionneuse
				// disponible, le clic simple retombe sur l'éditeur.
				if (event.shiftKey) {
					void navigator.clipboard.writeText(target).catch(() => undefined);
					return;
				}
				if (event.altKey) {
					void api.system.reveal(target).catch(() => undefined);
					return;
				}
				if (modKey(event) || !viewer) {
					void api.system.openEditor(target).catch(() => undefined);
					return;
				}
				viewer.open(target, line);
			}}
			className={clsx(
				"underline decoration-accent/30 underline-offset-2 hover:decoration-accent",
				className ?? "font-mono text-accent-soft",
			)}
		>
			{children ?? path}
		</button>
	);
}

/**
 * Découpe un texte en morceaux, les chemins devenant des liens.
 *
 * Rend le texte inchangé quand il n'y en a aucun — le cas courant, et il ne
 * doit rien coûter.
 */
export function linkifyPaths(text: string, cwd?: string | null): ReactNode {
	const pattern = new RegExp(PATH.source, "g");
	const out: ReactNode[] = [];
	let last = 0;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(text)) !== null) {
		if (match.index > last) out.push(text.slice(last, match.index));
		out.push(
			<FileLink key={`${match.index}-${match[0]}`} path={match[0]} cwd={cwd}>
				{match[0]}
			</FileLink>,
		);
		last = match.index + match[0].length;
	}

	if (out.length === 0) return text;
	if (last < text.length) out.push(text.slice(last));
	return out.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}
