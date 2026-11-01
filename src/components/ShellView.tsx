import anser from "anser";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { Turn } from "@/app/agents";
import { duration } from "@/lib/format";
import { useStickToBottom } from "@/lib/useStickToBottom";

/**
 * Le terminal de l'agent : ses commandes, dans l'ordre, et ce qu'elles ont
 * répondu.
 *
 * Ouvrir « en ce moment » sur un agent dans son shell montrait un panneau
 * vide, ou un appel seul et replié. Ici on voit la commande dès qu'elle part, depuis quand
 * elle tourne, et sa sortie à l'instant où elle revient — à la suite de celles
 * d'avant, comme dans un terminal qu'on regarderait par-dessus son épaule.
 *
 * Ce n'est pas un flux ligne à ligne : le CLI ne rend la sortie d'une commande
 * qu'une fois celle-ci terminée (vérifié sur le 2.1.291). On le dit sur la
 * ligne qui tourne plutôt que de laisser croire à un terminal figé.
 */

/** Au-delà, une sortie ne garde que sa fin : c'est là qu'est le verdict. */
const TAIL = 400;

function commandOf(turn: Turn): string {
	const command = turn.input?.command;
	return typeof command === "string" && command ? command : turn.text;
}

export function ShellView({
	turns,
	live,
	pondering,
}: {
	/** Les commandes de la consigne en cours, la plus récente en dernier. */
	turns: Turn[];
	/** L'agent travaille encore : une commande sans sortie tourne. */
	live: boolean;
	/** Sa dernière commande a répondu : il lit la sortie, rien ne tourne. */
	pondering: boolean;
}) {
	const { t } = useTranslation("components2");
	const last = turns[turns.length - 1];
	const bottom = useStickToBottom<HTMLDivElement>([turns.length, last?.output, pondering]);

	return (
		<div
			ref={bottom.ref}
			onScroll={bottom.onScroll}
			className="text-selectable min-h-0 flex-1 overflow-auto bg-void px-4 py-3 font-mono text-[11.5px] leading-[1.65]"
		>
			{turns.map((turn, index) => (
				<Command key={turn.toolId ?? index} turn={turn} live={live} />
			))}
			{pondering ? (
				<div className="flex items-center gap-2 text-ink-faint">
					<span className="text-accent">$</span>
					<Cursor />
					<span>{t("shellView.pondering")}</span>
				</div>
			) : null}
			{turns.length === 0 && !pondering ? (
				<p className="py-6 text-center text-ink-faint">{t("shellView.noCommand")}</p>
			) : null}
		</div>
	);
}

function Command({ turn, live }: { turn: Turn; live: boolean }) {
	const { t } = useTranslation("components2");
	const running = turn.output === undefined && live;
	const lines = (turn.output ?? "").split("\n");
	const cut = Math.max(0, lines.length - TAIL);
	const shown = cut > 0 ? lines.slice(cut).join("\n") : (turn.output ?? "");
	const took = turn.at && turn.doneAt ? turn.doneAt - turn.at : null;

	return (
		<div className="mb-3">
			<div className="flex items-start gap-2">
				<span className={turn.outputError ? "text-critical" : "text-accent"}>$</span>
				<span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-medium text-ink">
					{commandOf(turn)}
				</span>
				{took !== null && took >= 1000 ? (
					<span className="shrink-0 text-[10.5px] text-ink-faint">{duration(Math.round(took / 1000))}</span>
				) : null}
			</div>
			{running ? (
				<div className="mt-0.5 flex items-center gap-2 text-ink-faint">
					<Cursor />
					<span>
						{turn.at ? (
							<Trans t={t} i18nKey="shellView.runningSince" components={{ elapsed: <Elapsed since={turn.at} /> }} />
						) : (
							t("shellView.running")
						)}
					</span>
				</div>
			) : turn.output === undefined ? (
				<div className="mt-0.5 text-ink-faint">{t("shellView.interrupted")}</div>
			) : shown.trim() ? (
				<div
					className={
						turn.outputError
							? "mt-0.5 whitespace-pre-wrap break-all text-critical/85"
							: "mt-0.5 whitespace-pre-wrap break-all text-ink-muted"
					}
				>
					{cut > 0 ? <div className="text-ink-faint">{t("shellView.linesAbove", { count: cut })}</div> : null}
					{anser.ansiToJson(shown, { use_classes: false, json: true }).map((chunk, index) => (
						<span
							key={index}
							style={{
								color: chunk.fg ? `rgb(${chunk.fg})` : undefined,
								fontWeight: chunk.decoration === "bold" ? 600 : undefined,
							}}
						>
							{chunk.content}
						</span>
					))}
				</div>
			) : (
				<div className="mt-0.5 text-ink-faint">{t("shellView.noOutput")}</div>
			)}
		</div>
	);
}

function Cursor() {
	return <span className="inline-block h-[13px] w-[7px] shrink-0 animate-pulse bg-accent" />;
}

/** « depuis 12s », tenu à jour tant que la commande tourne. */
function Elapsed({ since }: { since: number }) {
	const { t } = useTranslation("components2");
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	return <> {t("shellView.since", { duration: duration(Math.max(0, Math.round((now - since) / 1000))) })}</>;
}
