import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui";
import { useCockpit } from "@/app/store";

/**
 * Avancement d'un job lancé depuis un écran, **et son issue**.
 *
 * Certaines commandes travaillent une à deux minutes — la suppression d'un
 * worktree démonte des bases, des buckets et une stack Docker. Sans son
 * avancement, on croit que le clic n'a rien fait, on réessaie, on s'agace. Le
 * job écrit déjà sa progression : il suffit d'en montrer la dernière ligne, là
 * où on attend.
 *
 * Ce composant ne montrait que ça, et disparaissait dès que le job se terminait
 * — réussi ou non. Une commande qui échoue en deux dixièmes de seconde
 * n'affichait donc rien du tout : le worktree restait là, sans un mot pour dire
 * pourquoi. C'est le cas réel qui a fait remonter ce défaut, sur une commande
 * de suppression dont la configuration portait `(folder)` au lieu de
 * `{folder}` : `zsh` refusait de l'interpréter, sortait en erreur, et l'écran
 * n'en disait rien.
 *
 * Un échec reste donc affiché, avec ce que la commande a écrit en dernier. La
 * réussite, elle, ne s'annonce pas : le worktree a disparu de la liste, ça se
 * voit sans qu'on l'écrive.
 */
export function JobProgress({ jobId }: { jobId: string | null }) {
	const { t } = useTranslation("components3");
	const { jobs, jobLines } = useCockpit();
	if (!jobId) return null;

	const job = jobs.find((entry) => entry.jobId === jobId);
	if (!job) return null;

	const lines = jobLines[jobId] ?? [];
	/** La dernière ligne non vide, en préférant le canal demandé. */
	const derniere = (stream?: "stdout" | "stderr") =>
		[...lines]
			.reverse()
			.find((line) => line.line.trim() && (!stream || line.stream === stream))
			?.line.trim();

	if (job.state === "running") {
		return (
			<div className="flex min-w-0 items-center gap-1.5">
				<Spinner />
				<span className="min-w-0 truncate font-mono text-[10px] text-ink-faint">
					{derniere() ?? t("jobProgress.starting")}
				</span>
			</div>
		);
	}

	// Une réussite n'a rien à dire : ce qu'elle a fait se voit à l'écran.
	if (job.state === "succeeded") return null;

	// Ce que la commande a écrit sur son canal d'erreur explique presque
	// toujours l'échec ; à défaut, sa dernière sortie, à défaut le code.
	const motif =
		derniere("stderr") ??
		derniere("stdout") ??
		(job.exitCode === null
			? t("jobProgress.silentStop")
			: t("jobProgress.exitCode", { code: job.exitCode }));

	return (
		<div className="flex min-w-0 items-center gap-1.5" title={motif}>
			<AlertTriangle size={11} className="shrink-0 text-critical" />
			<span className="min-w-0 truncate font-mono text-[10px] text-critical">
				{t(job.state === "cancelled" ? "jobProgress.cancelled" : "jobProgress.failed", { reason: motif })}
			</span>
		</div>
	);
}

/**
 * Ce job tourne-t-il encore ?
 *
 * Les écrans s'en servent pour désactiver le bouton qui l'a lancé. Ils
 * regardaient jusqu'ici « ai-je lancé un job ? », qui reste vrai pour toujours :
 * après un échec, le bouton ne redevenait jamais cliquable et il fallait
 * changer d'écran pour réessayer.
 */
export function useJobRunning(jobId: string | null): boolean {
	const { jobs } = useCockpit();
	if (!jobId) return false;
	return jobs.some((entry) => entry.jobId === jobId && entry.state === "running");
}
