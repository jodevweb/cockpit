import { ChevronDown, ChevronRight, FileText, FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileLink } from "@/components/FileLink";
import { Button } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { Turn } from "@/app/agents";
import { useCockpit } from "@/app/store";

/** Les outils dont on sait lire la cible sans interpréter une ligne de commande. */
const ECRITURES: Record<string, string> = {
	Write: "file_path",
	Edit: "file_path",
	MultiEdit: "file_path",
	NotebookEdit: "notebook_path",
};

/**
 * Ce que l'agent a écrit pendant la conversation, qu'il l'ait dit ou non.
 *
 * Un agent cite ses fichiers quand il y pense — et il n'y pense pas toujours.
 * Le rapport se terminait alors sur « c'est fait » sans que rien ne dise *où*,
 * et il fallait fouiller le worktree ou relire tous les appels d'outils pour
 * retrouver le livrable. Or le cockpit voit passer chaque écriture : autant la
 * retenir et la rendre atteignable.
 *
 * Ce sont les appels d'outils qui font foi, pas le texte de l'agent : `Bash`
 * est donc exclu — deviner ce qu'une ligne de commande touche serait une
 * promesse qu'on ne peut pas tenir.
 *
 * **Replié dès que la liste est longue.** Une session qui touche quarante
 * fichiers en affichait quarante, chacun en chemin absolu : le bloc mangeait
 * tout l'écran et repoussait la conversation hors de vue. Le compte, lui, se lit
 * d'un coup d'œil ; le détail se déplie quand on le cherche. En dessous du
 * seuil, la liste reste ouverte — la replier ferait cliquer pour trois lignes.
 */
const REPLI: number = 5;

/** Le chemin tel qu'on le lit : relatif au chantier, qui est déjà nommé. */
function relatif(path: string, cwd: string): string {
	const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return path.startsWith(base) ? path.slice(base.length) : path;
}
export function ProducedFiles({ turns, cwd }: { turns: Turn[]; cwd: string }) {
	const files = useMemo(() => {
		const vus = new Map<string, number>();
		for (const turn of turns) {
			if (turn.kind !== "tool" || !turn.tool) continue;
			const champ = ECRITURES[turn.tool];
			if (!champ) continue;
			const cible = turn.input?.[champ];
			if (typeof cible !== "string" || !cible.trim()) continue;
			// Un même fichier repasse à chaque correction : on compte les
			// touches plutôt que de le lister dix fois.
			vus.set(cible, (vus.get(cible) ?? 0) + 1);
		}
		return [...vus.entries()].map(([path, touches]) => ({ path, touches }));
	}, [turns]);

	const { t } = useTranslation("components1");
	const { notify } = useCockpit();
	const [ouvert, setOuvert] = useState(false);
	if (files.length === 0) return null;

	const long = files.length > REPLI;
	const visible = !long || ouvert;

	return (
		<section className="panel mx-auto mt-2 flex max-w-3xl flex-col gap-1.5 p-3">
			<div className="flex items-center gap-1.5">
				<FileText size={11} className="shrink-0 text-accent-soft" />
				{long ? (
					<button
						type="button"
						onClick={() => setOuvert((value) => !value)}
						className="focus-ring flex items-center gap-1 rounded text-[11px] font-semibold tracking-[0.05em] text-ink-muted uppercase hover:text-ink"
					>
						{t("producedFiles.count", { count: files.length })}
						{ouvert ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
					</button>
				) : (
					<h3 className="text-[11px] font-semibold tracking-[0.05em] text-ink-muted uppercase">
						{t("producedFiles.count", { count: files.length })}
					</h3>
				)}
				<Button
					size="sm"
					icon={FolderOpen}
					className="ml-auto"
					title={t("producedFiles.reveal.title")}
					onClick={() => {
						void api.system.reveal(cwd).catch((error) => notify(String(error)));
					}}
				>
					{t("producedFiles.reveal.label")}
				</Button>
			</div>
			{visible ? (
			<ul className="flex flex-col gap-0.5">
				{files.map((file) => (
					<li key={file.path} className="flex items-center gap-1.5">
						{/* Le même lien que dans le fil : un clic ouvre la visionneuse,
						    qui sait rendre images, markdown, PDF et texte. Le chemin
						    s'affiche relatif au chantier — l'absolu, répété quarante
						    fois, ne portait que du préfixe identique et poussait la
						    seule partie utile hors de l'écran. Le lien, lui, garde le
						    chemin entier : c'est lui qu'on copie et qu'on ouvre. */}
						<FileLink
							path={file.path}
							cwd={cwd}
							className="min-w-0 truncate font-mono text-[11px]"
						>
							{relatif(file.path, cwd)}
						</FileLink>
						{file.touches > 1 ? (
							<span className="shrink-0 font-mono text-[10px] text-ink-faint">
								×{file.touches}
							</span>
						) : null}
					</li>
				))}
			</ul>
			) : null}
		</section>
	);
}
