import clsx from "clsx";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { StartMission } from "@/components/StartMission";
import { Badge, Button, ErrorNote, PriorityBadge, Spinner } from "@/components/ui";
import { fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import { announceChange } from "@/lib/refresh";
import type { NamedRef } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

/** Échelle Linear : 0 = non défini, 1 = urgent … 4 = basse. */
const PRIORITIES = [
	{ value: 1, label: "Urgent", tone: "text-critical" },
	{ value: 2, label: "Haute", tone: "text-warning" },
	{ value: 3, label: "Moyenne", tone: "text-ink-muted" },
	{ value: 4, label: "Basse", tone: "text-ink-faint" },
	{ value: 0, label: "—", tone: "text-ink-faint" },
];

function Chip({
	item,
	active,
	onClick,
}: {
	item: NamedRef;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={clsx(
				"focus-ring flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors",
				active
					? "border-accent-soft/40 bg-accent-soft/12 text-ink"
					: "border-line-soft text-ink-faint hover:text-ink-muted",
			)}
		>
			{item.color ? (
				<span
					className="size-1.5 shrink-0 rounded-full"
					style={{ backgroundColor: item.color }}
				/>
			) : null}
			{item.name}
		</button>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
				{label}
			</div>
			<div className="flex flex-wrap gap-1">{children}</div>
		</div>
	);
}

/**
 * Fiche complète d'un ticket Linear, modifiable sur place.
 *
 * Le détail générique des flux affiche le JSON de la source : lisible pour
 * déboguer, inutile pour travailler. Ici on rend la description en markdown et
 * on expose les quatre champs qu'on change vraiment au quotidien — état,
 * priorité, assigné, labels — sans quitter le cockpit.
 */
export function LinearIssue({ identifier }: { identifier: string }) {
	const { notify } = useCockpit();
	const issue = useAsync(() => api.feeds.linearIssue(identifier), [identifier]);
	// Les options ne dépendent pas du ticket : une seule fois pour l'équipe.
	const options = useAsync(() => api.feeds.linearOptions(), []);
	// Tous les suivis n'ont pas de priorité : proposer un sélecteur qui ne
	// changerait rien vaut moins que ne rien proposer du tout.
	const provider = useAsync(() => api.feeds.ticketProvider().catch(() => null), []);
	const supports = provider.data?.capabilities;

	const apply = async (patch: Record<string, unknown>, label: string) => {
		try {
			await api.feeds.linearUpdate(identifier, patch);
			notify(`${identifier} · ${label}`);
			issue.reload();
			// La liste qui a ouvert cette fiche affiche le même ticket : sans cette
			// annonce, elle continuait d'annoncer l'état d'avant, et on doutait de ce
			// qu'on venait de faire.
			void announceChange("tickets");
		} catch (error) {
			notify(String(error));
		}
	};

	if (issue.error) {
		return <ErrorNote error={issue.error} onRetry={issue.reload} />;
	}
	if (!issue.data) {
		return (
			<div className="flex justify-center py-10">
				<Spinner />
			</div>
		);
	}

	const data = issue.data;
	const labelIds = new Set(data.labels.map((label) => label.id));

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="hairline-b flex items-start gap-2 px-4 py-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="shrink-0 font-mono text-[11px] text-ink-faint">
							{data.identifier}
						</span>
						{data.state ? <Badge tone="accent">{data.state.name}</Badge> : null}
						{/* La priorité se lit avec l'identifiant : plus bas, elle se
						    confond avec les boutons qui la modifient. */}
						<PriorityBadge priority={data.priority} />
						<span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
							{fromIso(data.updatedAt)}
						</span>
					</div>
					<h2 className="text-selectable mt-0.5 text-[14px] leading-snug font-semibold text-ink">
						{data.title}
					</h2>
					{data.branchName ? (
						<p className="mt-0.5 font-mono text-[10px] text-ink-faint">{data.branchName}</p>
					) : null}
				</div>
				{/* L'action principale de la fiche : c'est ici qu'on décide de
				    travailler sur ce ticket, pas dans un autre écran où il faudrait le
				    retrouver. */}
				<StartMission reference={data.identifier} title={data.title} />
				<Button size="sm" icon={RefreshCw} onClick={issue.reload} />
				<Button
					size="sm"
					icon={ExternalLink}
					onClick={() => {
						void api.system.openUrl(data.url).catch((error) => notify(String(error)));
					}}
				/>
			</div>

			<div className="grid shrink-0 grid-cols-2 gap-3 border-b border-line-soft p-3">
				<Field label="État">
					{options.loading && !options.data ? <Spinner /> : null}
					{(options.data?.states ?? []).map((state) => (
						<Chip
							key={state.id}
							item={state}
							active={data.state?.id === state.id}
							onClick={() => void apply({ stateId: state.id }, `→ ${state.name}`)}
						/>
					))}
				</Field>

				{supports && !supports.priority ? null : (
					<Field label="Priorité">
						{PRIORITIES.map((priority) => (
							<button
								key={priority.value}
								type="button"
								onClick={() =>
									void apply({ priority: priority.value }, `priorité ${priority.label}`)
								}
								className={clsx(
									"focus-ring rounded-md border px-1.5 py-0.5 text-[10px] transition-colors",
									data.priority === priority.value
										? "border-accent-soft/40 bg-accent-soft/12 text-ink"
										: `border-line-soft ${priority.tone} hover:text-ink-muted`,
								)}
							>
								{priority.label}
							</button>
						))}
					</Field>
				)}

				<Field label="Assigné">
					<button
						type="button"
						onClick={() => void apply({ assigneeId: null }, "désassigné")}
						className={clsx(
							"focus-ring rounded-md border px-1.5 py-0.5 text-[10px]",
							data.assignee
								? "border-line-soft text-ink-faint hover:text-ink-muted"
								: "border-accent-soft/40 bg-accent-soft/12 text-ink",
						)}
					>
						personne
					</button>
					{(options.data?.members ?? []).map((member) => (
						<Chip
							key={member.id}
							item={member}
							active={data.assignee?.id === member.id}
							onClick={() =>
								void apply({ assigneeId: member.id }, `assigné à ${member.name}`)
							}
						/>
					))}
				</Field>

				<Field label="Labels">
					{(options.data?.labels ?? []).map((label) => {
						const active = labelIds.has(label.id);
						return (
							<Chip
								key={label.id}
								item={label}
								active={active}
								onClick={() => {
									// L'API remplace la liste entière : on la recompose.
									const next = active
										? [...labelIds].filter((id) => id !== label.id)
										: [...labelIds, label.id];
									void apply(
										{ labelIds: next },
										active ? `label ${label.name} retiré` : `label ${label.name} ajouté`,
									);
								}}
							/>
						);
					})}
				</Field>
			</div>

			<div className="min-h-0 flex-1 px-5 py-4">
				{data.description ? (
					<div className="max-w-3xl">
						<Markdown source={data.description} />
					</div>
				) : (
					<p className="text-[11px] text-ink-faint">Pas de description.</p>
				)}

				{data.comments.length > 0 ? (
					<div className="mt-6 max-w-3xl">
						<div className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							Commentaires · {data.comments.length}
						</div>
						<div className="flex flex-col gap-3">
							{data.comments.map((comment) => (
								<div key={comment.id} className="rounded-xl border border-line-soft p-2.5">
									<div className="mb-1 flex items-baseline gap-2">
										<span className="text-[11px] font-medium text-ink">
											{comment.author}
										</span>
										<span className="font-mono text-[10px] text-ink-faint">
											{fromIso(comment.createdAt)}
										</span>
									</div>
									<Markdown source={comment.body} />
								</div>
							))}
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
