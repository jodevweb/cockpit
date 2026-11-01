import clsx from "clsx";
import { GitPullRequest, Ticket } from "lucide-react";
import { useMemo } from "react";
import { PrActions, TicketActions } from "@/components/actions";
import { Badge, Dot, Empty, PrLabels, PriorityBadge } from "@/components/ui";
import { fromIso } from "@/lib/format";
import type { MemberBoard, MemberPr, TicketCard } from "@/lib/types";

/**
 * Sur quoi quelqu'un travaille, à l'instant où on le lui demande.
 *
 * Le daily posait mal la question. Il rangeait les tickets par état déclaré dans
 * le suivi, le plus ancien en tête — au motif que c'est ce qui traîne qu'on veut
 * voir — et alignait les pull requests dans une colonne à part. Résultat : quand
 * quelqu'un racontait sa matinée, l'écran montrait un ticket qu'il n'avait pas
 * touché depuis trois semaines, et la PR qu'il venait d'ouvrir se trouvait
 * ailleurs. Deux listes, aucune ne suivait le récit.
 *
 * Ce qu'on lit ici est donc bâti sur l'inverse : **l'activité récente**, et le
 * **sujet** plutôt que l'objet. Un ticket et les pull requests qui le portent
 * forment une seule ligne — c'est un seul travail — et l'ordre suit la dernière
 * chose qui a bougé. Une PR sans ticket reste une ligne à part entière : elle
 * existe, même si personne ne l'a rattachée.
 *
 * Ce qui traîne n'a pas disparu pour autant : il a son propre signal, les
 * alertes du daily le disent en toutes lettres. Cette liste-ci répond à une
 * seule question, et une bonne réponse à une question vaut mieux que deux
 * réponses tièdes à deux questions mélangées.
 */

/** Un travail en cours : son ticket s'il en a un, ses pull requests s'il en a. */
interface Subject {
	key: string;
	ticket: TicketCard | null;
	prs: MemberPr[];
	/** Jours ouvrés depuis la dernière activité, tous objets confondus. */
	idleDays: number;
	updatedAt: string;
}

/** L'état qui décide de la couleur d'un sujet : le plus urgent l'emporte. */
function subjectTone(subject: Subject): { tone: "critical" | "warning" | "success" | "neutral"; label: string } {
	const pr = subject.prs;
	if (pr.some((entry) => entry.ciState === "failing")) {
		return { tone: "critical", label: "CI en échec" };
	}
	if (pr.some((entry) => entry.reviewDecision === "CHANGES_REQUESTED")) {
		return { tone: "warning", label: "changements demandés" };
	}
	if (pr.some((entry) => entry.stacked)) {
		return { tone: "warning", label: "PR empilée" };
	}
	if (
		pr.length > 0 &&
		pr.every(
			(entry) =>
				entry.reviewDecision === "APPROVED" && entry.ciState === "success" && !entry.isDraft,
		)
	) {
		return { tone: "success", label: "prête à merger" };
	}
	if (pr.some((entry) => entry.isDraft)) return { tone: "neutral", label: "brouillon" };
	if (pr.length > 0) return { tone: "neutral", label: "en review" };
	return { tone: "neutral", label: subject.ticket?.stateName ?? "" };
}

/**
 * Rassemble tickets et pull requests en sujets.
 *
 * Le lien vient du suivi lui-même — une PR cite son ticket, un ticket connaît ses
 * PR — et non d'une convention de nommage qu'il faudrait deviner.
 */
function useSubjects(member: MemberBoard, prs: MemberPr[]): Subject[] {
	return useMemo(() => {
		const tickets = [...member.activeTickets, ...member.reviewTickets];
		const byTicket = new Map<string, Subject>();
		const used = new Set<number>();

		for (const ticket of tickets) {
			const linked = prs.filter(
				(pr) => pr.ticketId === ticket.identifier || ticket.prNumbers.includes(pr.number),
			);
			linked.forEach((pr) => used.add(pr.number));
			const idle = Math.min(
				ticket.ageDays,
				...linked.map((pr) => pr.idleDays),
			);
			byTicket.set(ticket.identifier, {
				key: ticket.identifier,
				ticket,
				prs: linked,
				idleDays: Number.isFinite(idle) ? idle : ticket.ageDays,
				updatedAt: ticket.updatedAt,
			});
		}

		// Une PR qui ne cite aucun ticket est un travail comme un autre : la taire
		// reviendrait à dire que rien ne se passe, alors qu'elle est ouverte.
		const orphans = prs
			.filter((pr) => !used.has(pr.number))
			.map<Subject>((pr) => ({
				key: `pr-${pr.number}`,
				ticket: null,
				prs: [pr],
				idleDays: pr.idleDays,
				updatedAt: pr.updatedAt,
			}));

		return [...byTicket.values(), ...orphans].sort(
			(a, b) => a.idleDays - b.idleDays || b.updatedAt.localeCompare(a.updatedAt),
		);
	}, [member, prs]);
}

export function NowFeed({
	member,
	prs,
	onOpen,
}: {
	member: MemberBoard;
	/** PR déjà filtrées par la vue hôte (facette « ça bloque », etc.). */
	prs: MemberPr[];
	onOpen: (url: string) => void;
}) {
	const subjects = useSubjects(member, prs);

	if (subjects.length === 0) {
		return (
			<Empty
				icon={Ticket}
				message="Rien en cours"
				hint="Aucun ticket actif ni pull request ouverte. Ce qui est à venir se lit plus bas."
			/>
		);
	}

	return (
		<div className="flex flex-col gap-1">
			{subjects.map((subject) => {
				const state = subjectTone(subject);
				const ticket = subject.ticket;
				return (
					<div
						key={subject.key}
						className="group flex flex-col gap-1 rounded-lg border border-line-soft bg-surface/40 px-2.5 py-2"
					>
						<div className="flex items-center gap-2">
							<Dot tone={state.tone} />
							{ticket ? (
								<button
									type="button"
									onClick={() => onOpen(ticket.url)}
									className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded text-left"
								>
									<span className="shrink-0 font-mono text-[10px] text-ink-faint">
										{ticket.identifier}
									</span>
									<span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
										{ticket.title}
									</span>
								</button>
							) : (
								<button
									type="button"
									onClick={() => onOpen(subject.prs[0].url)}
									className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded text-left"
								>
									<GitPullRequest size={11} className="shrink-0 text-ink-faint" />
									<span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
										{subject.prs[0].title}
									</span>
									<Badge>sans ticket</Badge>
								</button>
							)}
							{ticket ? <PriorityBadge priority={ticket.priority} /> : null}
							{/* Quand ça a bougé, en clair : c'est ce qui distingue le sujet du
							    moment d'un chantier laissé de côté. */}
							<span
								className={clsx(
									"shrink-0 font-mono text-[10px]",
									subject.idleDays <= 1 ? "text-success" : "text-ink-faint",
								)}
								title={`Dernière activité ${fromIso(subject.updatedAt)}`}
							>
								{subject.idleDays <= 0
									? "aujourd'hui"
									: subject.idleDays === 1
										? "hier"
										: `${subject.idleDays} j`}
							</span>
						</div>

						{/* La ligne du dessous dit l'état réel du travail : où en est le
						    ticket, et ce que font ses pull requests. */}
						<div className="flex flex-wrap items-center gap-1.5 pl-[18px]">
							{ticket ? (
								<span className="text-[10px] text-ink-faint">{ticket.stateName}</span>
							) : null}
							{state.label && state.label !== ticket?.stateName ? (
								<span
									className={clsx(
										"text-[10px]",
										state.tone === "critical"
											? "text-critical"
											: state.tone === "warning"
												? "text-warning"
												: state.tone === "success"
													? "text-success"
													: "text-ink-faint",
									)}
								>
									· {state.label}
								</span>
							) : null}
							{subject.prs.map((pr) => (
								<button
									key={pr.number}
									type="button"
									onClick={() => onOpen(pr.url)}
									className="focus-ring flex items-center gap-1 rounded font-mono text-[10px] text-ink-faint hover:text-ink-muted"
									title={pr.title}
								>
									<GitPullRequest size={9} />#{pr.number}
								</button>
							))}
							{subject.prs[0]?.labels?.length ? (
								<PrLabels labels={subject.prs[0].labels} max={2} />
							) : null}

							<span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
								{ticket ? (
									<TicketActions
										identifier={ticket.identifier}
										title={ticket.title}
										url={ticket.url}
									/>
								) : null}
								{subject.prs[0] ? (
									<PrActions
										number={subject.prs[0].number}
										headRef={subject.prs[0].headRef}
										ciFailing={subject.prs.some((pr) => pr.ciState === "failing")}
										changesRequested={subject.prs.some(
											(pr) => pr.reviewDecision === "CHANGES_REQUESTED",
										)}
									/>
								) : null}
							</span>
						</div>
					</div>
				);
			})}
		</div>
	);
}
