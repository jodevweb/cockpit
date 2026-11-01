import { useMemo } from "react";
import { awaitsReply, endsWithQuestion, episodes, summarize, type Episode } from "@/lib/episodes";
import { awaitedDecision, awaitsHuman } from "@/lib/missions";
import { readQuestions, type AgentQuestion, type Mission, type PermissionRequest } from "@/lib/types";
import { isQuestion, useAgentRuns, type AgentRun } from "./agents";
import { useCockpit } from "./store";

/**
 * Ce qui attend ta décision, d'où que ça vienne.
 *
 * Mesuré sur un mois de travail réel : les agents ont travaillé 72 heures et
 * en ont attendu 117 une réponse humaine — 5 min 36 en médiane, une heure au
 * 90ᵉ centile. Le goulot n'était plus l'agent. Chaque attente vivait pourtant
 * dans son onglet, et l'on ne voyait que celle qu'on regardait.
 *
 * Quatre natures, de la plus coûteuse à la moins coûteuse :
 * - une **question** posée en plein travail (`AskUserQuestion`) gèle l'agent ;
 * - une **autorisation** aussi, et expire ;
 * - un **plan** de mission non approuvé gèle tout un chantier ;
 * - un agent qui a **rendu la main sur une question** attend, sans rien geler
 *   d'autre que lui.
 *
 * L'ordre : ce qui gèle passe devant, puis ce qui débloque le plus, puis ce qui
 * attend depuis le plus longtemps.
 */

export type Decision =
	| {
			kind: "question";
			key: string;
			run: AgentRun;
			request: PermissionRequest;
			questions: AgentQuestion[];
			since: number;
			unblocks: number;
			episode: Episode | null;
	  }
	| { kind: "permission"; key: string; run: AgentRun; request: PermissionRequest; since: number; unblocks: number; episode: Episode | null }
	| {
			kind: "reply";
			key: string;
			run: AgentRun;
			/** Le dernier mot de l'agent, sa question comprise. */
			text: string;
			/** Les options qu'il a lui-même énumérées, quand il l'a fait. */
			options: string[];
			since: number;
			unblocks: number;
			episode: Episode | null;
	  }
	| { kind: "plan"; key: string; mission: Mission; detail: string; since: number; unblocks: number };

/** Ce qui gèle quelque chose en plein travail. */
export function freezes(decision: Decision): boolean {
	return decision.kind !== "reply";
}

function stamp(value: string | number | undefined | null): number {
	if (typeof value === "number") return value;
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Les choix qu'un agent énumère au bout de sa question : « 1. … 2. … »,
 * « - Option A : … ». On les propose en réponse d'un geste ; on n'en invente
 * aucun s'il n'en a pas écrit.
 */
export function optionsOf(text: string): string[] {
	const paragraphs = text.trim().split(/\n\s*\n/).slice(-3).join("\n");
	const found: string[] = [];
	for (const line of paragraphs.split("\n")) {
		const match = /^\s*(?:\d+[.)]|[-*•]|\(?[A-Da-d][.)])\s+(.+)$/.exec(line);
		if (!match) continue;
		const clean = match[1]
			.replace(/\*\*|__|`/g, "")
			.split(/\s+[—–]\s+|\s*:\s+/)[0]
			.trim();
		if (clean && clean.length <= 90) found.push(clean);
	}
	return found.length >= 2 && found.length <= 6 ? found : [];
}

function lastEpisode(run: AgentRun): Episode | null {
	return episodes(run.turns).at(-1) ?? null;
}

export function useDecisions(): Decision[] {
	const { runs, pendingFor } = useAgentRuns();
	const { missions } = useCockpit();

	return useMemo(() => {
		const found: Decision[] = [];
		for (const run of runs) {
			const episode = lastEpisode(run);
			for (const request of pendingFor(run.id)) {
				if (isQuestion(request)) {
					found.push({
						kind: "question",
						key: `q-${request.id}`,
						run,
						request,
						questions: readQuestions(request.input),
						since: stamp(request.at),
						unblocks: 1,
						episode,
					});
				} else {
					found.push({ kind: "permission", key: `p-${request.id}`, run, request, since: stamp(request.at), unblocks: 1, episode });
				}
			}
			if (run.thinking || pendingFor(run.id).length > 0 || !episode) continue;
			if (!awaitsReply(episode)) continue;
			const answer = summarize(episode).answer;
			if (!answer || !endsWithQuestion(answer.text)) continue;
			found.push({
				kind: "reply",
				key: `r-${run.id}-${answer.at ?? episode.turns.length}`,
				run,
				text: answer.text,
				options: optionsOf(answer.text),
				since: answer.at ?? Date.now(),
				unblocks: 1,
				episode,
			});
		}
		for (const mission of missions.filter(awaitsHuman)) {
			found.push({
				kind: "plan",
				key: `m-${mission.id}`,
				mission,
				detail: awaitedDecision(mission),
				since: stamp(mission.updatedAt),
				unblocks: Math.max(1, mission.tasks.length),
			});
		}
		return found.sort(
			(a, b) =>
				Number(freezes(b)) - Number(freezes(a)) || b.unblocks - a.unblocks || a.since - b.since,
		);
	}, [runs, pendingFor, missions]);
}

/** « depuis 12 min », « depuis 2 h » : ce qu'attend la machine. */
export function waitedSince(since: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - since) / 60_000));
	if (minutes < 1) return "à l'instant";
	if (minutes < 60) return `depuis ${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `depuis ${hours} h ${String(minutes % 60).padStart(2, "0")}`;
	return `depuis ${Math.floor(hours / 24)} j`;
}
