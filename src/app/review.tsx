import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/ipc";
import type { Review } from "@/lib/types";
import { startWorktreeCreation, waitForWorktree } from "@/lib/worktreeFlow";
import { startActivity, type ActivityHandle } from "@/lib/activity";
import { REVIEW_EVENT, useAgentActions } from "./agents";
import { useCockpit } from "./store";
import { useWorkspace } from "./workspace";

/**
 * Relire une PR, ou vérifier ses corrections : un seul geste.
 *
 * La personne retrouvait la branche, l'ouvrait dans « + Chantier », attendait
 * le worktree, retapait sa consigne. Le geste fait tout cela, et une chose de
 * plus qu'elle ne faisait pas : il met la branche à jour avant de relire. Un
 * worktree rouvert pour un deuxième tour était resté sur la version du premier
 * — on vérifiait des corrections qu'on n'avait pas sous les yeux.
 *
 * Le même geste sert la carte, la vue de branche, l'assistant vocal et
 * « + Chantier ».
 */
/**
 * Les revues lancées et pas encore remises, par numéro de PR : leur ligne du
 * centre d'activité reste ouverte tant que l'agent lit — c'est la partie la
 * plus longue, et celle qu'on perdait de vue.
 */
const pending = new Map<number, { activity: ActivityHandle; open: () => void }>();

if (typeof window !== "undefined") {
	window.addEventListener(REVIEW_EVENT, (event) => {
		const review = (event as CustomEvent<Review>).detail;
		const waiting = review ? pending.get(review.number) : undefined;
		if (!review || !waiting) return;
		pending.delete(review.number);
		const round = review.rounds[review.rounds.length - 1];
		const count = round?.findings.length ?? 0;
		const verdict =
			round?.verdict === "merge" ? "tu peux fusionner" : round?.verdict === "bloquant" ? "bloquant" : "corrections attendues";
		// La suite, dite : sans elle, on attendait devant un agent qui avait fini,
		// sans savoir s'il préparait encore quelque chose.
		const next =
			round?.verdict === "merge"
				? "Rien ne tourne : tu peux fusionner."
				: "Rien ne tourne maintenant : à toi de poster les points, puis « Revérifier » quand l'auteur aura poussé.";
		waiting.activity.done(`Revue remise : ${count} point${count > 1 ? "s" : ""} · ${verdict}. ${next}`, {
			label: "Voir",
			run: waiting.open,
		});
	});
}

export function useReviewFlow() {
	const { config, runJob, go } = useCockpit();
	const { open } = useAgentActions();
	const { show } = useWorkspace();

	return useCallback(
		/**
		 * `asked` : la consigne tapée qui a déclenché le geste, quand il vient du
		 * champ d'un agent. Elle part avec la revue — ce qu'on y a précisé (« en
		 * profondeur », « surtout l'import ») ne doit pas se perdre en route.
		 */
		async (number: number, kind: "revue" | "verification" = "revue", asked?: string) => {
			const activity = startActivity(
				kind === "verification" ? `Vérification de la PR #${number}` : `Revue de la PR #${number}`,
				asked
					? "Ta consigne demande une revue : je passe par « Relire », pour qu'elle soit remise en carte. Je lis la PR sur GitHub…"
					: "Je lis la PR sur GitHub et je récupère sa branche…",
			);
			try {
				const prepared = await api.reviews.prepare(number, kind);
				if (prepared.warning) activity.step(prepared.warning);
				const prompt = asked?.trim()
					? `${prepared.prompt}\n\n---\nCe que la personne a écrit en demandant cette revue — à suivre pour savoir où porter l'attention, sans sortir du cadre ci-dessus :\n${asked.trim()}`
					: prepared.prompt;

				const launch = (path: string) => {
					activity.step("Je lance l'agent de revue — il lit la PR, tu seras prévenu à la remise.");
					open(path, prompt, undefined, undefined, true, {
						profile: "review",
						label: kind === "verification" ? `Vérification #${number}` : `Revue #${number}`,
					});
					pending.set(number, {
						activity,
						open: () => {
							go("workspace");
							show(path, { kind: "board", id: path });
						},
					});
				};

				if (prepared.worktree) {
					// La branche telle que l'auteur l'a poussée. Une branche qu'on a
					// modifiée sur le poste refuse l'avance rapide : on le dit, et on
					// relit quand même — ce qui est là vaut mieux que rien.
					activity.step(`Je mets ${prepared.branch} à jour…`);
					try {
						await api.git.pull(prepared.worktree);
					} catch (error) {
						activity.step(
							`Mise à jour impossible (${String(error).replace(/^(Ipc)?Error:\s*/, "")}) : je relis la version du poste.`,
						);
					}
					launch(prepared.worktree);
					return;
				}

				const mainRepo = config?.mainRepo;
				if (!mainRepo) throw new Error("Aucun dépôt principal n'est réglé pour ce projet.");
				activity.step(`Je crée le worktree de ${prepared.branch} — ça peut prendre quelques minutes.`);
				await startWorktreeCreation(prepared.branch, {
					mainRepo,
					runJob,
					openAgent: (cwd, prompt) => open(cwd, prompt, undefined, undefined, true),
				});
				const path = await waitForWorktree(prepared.branch);
				if (!path) throw new Error(`Le worktree de ${prepared.branch} n'est pas apparu après 15 minutes.`);
				launch(path);
			} catch (error) {
				activity.fail(error);
				throw error;
			}
		},
		[config?.mainRepo, go, open, runJob, show],
	);
}

/** La revue d'une PR, relue dès qu'un agent en remet une nouvelle. */
export function useReview(number: number | null | undefined): { review: Review | null; reload: () => void } {
	const [review, setReview] = useState<Review | null>(null);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!number) {
			setReview(null);
			return;
		}
		let alive = true;
		void api.reviews
			.get(number)
			.then((found) => alive && setReview(found))
			.catch(() => alive && setReview(null));
		return () => {
			alive = false;
		};
	}, [number, tick]);
	useEffect(() => {
		const onReview = (event: Event) => {
			const detail = (event as CustomEvent<Review>).detail;
			if (detail?.number === number) setReview(detail);
		};
		window.addEventListener(REVIEW_EVENT, onReview);
		return () => window.removeEventListener(REVIEW_EVENT, onReview);
	}, [number]);
	return { review, reload: () => setTick((value) => value + 1) };
}

/** Toutes les revues du projet : pour savoir, de loin, ce qui est à revérifier. */
export function useReviews(): Review[] {
	const [reviews, setReviews] = useState<Review[]>([]);
	const { activeProject } = useCockpit();
	useEffect(() => {
		let alive = true;
		const load = () =>
			void api.reviews
				.list()
				.then((list) => alive && setReviews(list))
				.catch(() => undefined);
		load();
		window.addEventListener(REVIEW_EVENT, load);
		return () => {
			alive = false;
			window.removeEventListener(REVIEW_EVENT, load);
		};
	}, [activeProject?.id]);
	return reviews;
}

/**
 * La PR a-t-elle bougé depuis le dernier tour relu ?
 *
 * C'est ce qui fait passer une revue de « faite » à « à revérifier » : un
 * commit de tête différent de celui qu'on a relu.
 */
export function movedSince(review: Review | null | undefined, headSha: string | null | undefined): boolean {
	const last = review?.rounds[review.rounds.length - 1];
	return Boolean(last?.headSha && headSha && last.headSha !== headSha);
}
