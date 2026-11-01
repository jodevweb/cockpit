import clsx from "clsx";
import {
	Check,
	CornerDownLeft,
	GitMerge,
	GitPullRequest,
	Plus,
	Ticket,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
	Badge,
	Button,
	Dot,
	Empty,
	PrLabels,
	SkeletonRows,
	ViewHeader,
} from "@/components/ui";
import { PrActions, TicketActions } from "@/components/actions";
import { fromTimestamp, shortPath } from "@/lib/format";
import { api } from "@/lib/ipc";
import { AgentDay } from "@/components/AgentDay";
import { useAsync } from "@/lib/useAsync";
import { useBlockers, type Blocker } from "@/app/blockers";
import { useCockpit } from "@/app/store";

const TONES = {
	critical: {
		tile: "border-critical/35 bg-critical/[0.07] hover:border-critical/60",
		icon: "text-critical",
	},
	warning: {
		tile: "border-warning/35 bg-warning/[0.07] hover:border-warning/60",
		icon: "text-warning",
	},
	accent: {
		tile: "border-accent/35 bg-accent/[0.07] hover:border-accent/60",
		icon: "text-accent-soft",
	},
} as const;

/**
 * Ce qui attend une décision de ta part, aujourd'hui.
 *
 * Le cockpit sait déjà tout : agents en attente, PR à relire, CI rouge,
 * worktrees à ranger. Mais chaque information vivait sur son écran, si bien
 * qu'il fallait faire le tour pour savoir par quoi commencer. Cet écran ne
 * collecte rien de neuf — il rassemble, et n'affiche que ce sur quoi on peut
 * agir maintenant.
 *
 * Il l'a d'abord fait en empilant huit listes dans une colonne étroite : pour
 * savoir si un ticket t'attendait, il fallait dérouler l'écran, et la moitié
 * droite restait vide. La forme dit maintenant la hiérarchie — ce qui arrête
 * une machine occupe un bandeau en pleine largeur, le reste tient en cartes
 * côte à côte, chacune bornée en hauteur et qui défile chez elle. Un écran,
 * un coup d'œil.
 */
export function TodayView() {
	const { go, activeProject, config, worktrees } = useCockpit();

	const tasks = useAsync(() => api.tasks.list(), [activeProject?.id]);
	const prs = useAsync(() => api.git.pullRequests().catch(() => []), [activeProject?.id], {
		pollMs: 180_000,
	});
	const journal = useAsync(() => api.journal.list(40), [activeProject?.id], {
		pollMs: 60_000,
	});
	const myTickets = useAsync(
		() => api.feeds.linear(true).catch(() => []),
		[activeProject?.id],
		{ pollMs: 180_000 },
	);
	const hygiene = useAsync(
		() => api.worktrees.hygiene().catch(() => []),
		[activeProject?.id],
		{
			pollMs: 600_000,
		},
	);

	const localBranches = useMemo(
		() => new Set(worktrees.map((tree) => tree.branch).filter(Boolean) as string[]),
		[worktrees],
	);

	// Les colonnes de fin se déclarent dans les réglages : une équipe qui appelle
	// « Terminé » ce que Linear nomme « Done » verrait sinon ses tickets finis
	// rester dans la liste pour toujours.
	const doneStates = useMemo(
		() => new Set(config?.workflow.doneStates ?? []),
		[config?.workflow.doneStates],
	);
	const openTickets = (myTickets.data ?? []).filter(
		(ticket) => !doneStates.has(ticket.status),
	);

	const mine = (prs.data ?? []).filter((pr) => localBranches.has(pr.headRef));
	const readyToMerge = mine.filter(
		(pr) => !pr.isDraft && pr.reviewDecision === "APPROVED" && pr.ciState === "success",
	);
	// Les PR des autres qui attendent explicitement une relecture.
	const toReview = (prs.data ?? []).filter(
		(pr) =>
			!localBranches.has(pr.headRef) && pr.reviewRequestLogins.length > 0 && !pr.isDraft,
	);
	const removable = (hygiene.data ?? []).filter((entry) => entry.removable);

	const pending = tasks.data?.filter((task) => !task.done) ?? [];
	const done = tasks.data?.filter((task) => task.done) ?? [];

	const blockers = useBlockers(prs.data ?? []);

	const nothing =
		blockers.length === 0 &&
		readyToMerge.length === 0 &&
		toReview.length === 0 &&
		removable.length === 0 &&
		pending.length === 0;


	return (
		<>
			<ViewHeader
				title="Aujourd'hui"
				subtitle={activeProject?.name}
				actions={
					<Button
						icon={Check}
						disabled={done.length === 0}
						onClick={() => {
							void api.tasks.clearDone().then(() => tasks.reload());
						}}
						title="Retirer les tâches faites"
					>
						Nettoyer
					</Button>
				}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="flex flex-col gap-4">
					{nothing && !tasks.initial ? (
						<Empty
							icon={Check}
							message="Rien ne t'attend"
							hint="Aucun agent en attente, aucune PR bloquée, rien à ranger."
						/>
					) : null}

					{/* Ce qui arrête une machine se lit avant tout le reste, et sans
					    défiler : le bandeau prend toute la largeur et se place au-dessus
					    des cartes, qui n'attendent rien de toi. */}
					<Blockers items={blockers} />

					{/* Ce qui s'est passé, pas seulement ce qui attend : qui a tourné,
					    quand, et qui a coincé. */}
					<AgentDay />

					{/* Le reste tient côte à côte. Chaque carte est bornée en hauteur et
					    défile chez elle : une liste longue ne repousse plus les autres
					    hors de l'écran. */}
					{/* `items-start` : sans lui, une carte d'une seule ligne s'étire sur
					    toute la hauteur de sa rangée et n'affiche que du vide. */}
					<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
						{/* Ce qui t'est assigné, avec de quoi s'y mettre : c'est ici qu'on
						    décide de commencer, pas dans un tableau de bord qu'on lit. */}
						{openTickets.length > 0 ? (
							<Card title="Mes tickets" count={openTickets.length}>
								{openTickets.map((ticket) => (
										<div
											key={ticket.id}
											className="group relative flex items-start gap-2 p-2.5"
										>
											{/* Sur deux étages : dans une carte, un titre qui partage sa
											    ligne avec l'identifiant et l'état n'a plus la place de se
											    lire — il n'en restait que « Remo… ». */}
											<button
												type="button"
												onClick={() => {
													void api.system.openUrl(ticket.url).catch(() => undefined);
												}}
												className="flex min-w-0 flex-1 items-start gap-2 text-left"
											>
												<Ticket size={13} className="mt-px shrink-0 text-ink-faint" />
												<span className="min-w-0 flex-1">
													<span className="block truncate text-[12.5px] text-ink">
														{ticket.title}
													</span>
													<span className="flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
														<span className="shrink-0">{ticket.id}</span>
														<span className="text-line">·</span>
														<span className="truncate">{ticket.status}</span>
													</span>
												</span>
											</button>
											{/* En superposition, pas dans le flux : masquées par l'opacité,
											    ces actions gardaient leur largeur en permanence et rognaient
											    le titre de moitié. */}
											<span className="absolute top-1.5 right-1.5 flex gap-1 rounded-lg bg-raised px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100">
												<TicketActions
													identifier={ticket.id}
													title={ticket.title}
													url={ticket.url}
												/>
											</span>
										</div>
									))}
							</Card>
						) : null}

						{/* Les notes viennent après ce qui bloque : elles n'engagent que
						    toi, et rien ne t'attend dessus. */}
						<Card title="À faire" count={pending.length}>
							<TaskList tasks={tasks} pending={pending} done={done} />
						</Card>

						{readyToMerge.length > 0 ? (
							<PrCard
								title="Prêtes à merger"
								tone="success"
								icon={GitMerge}
								items={readyToMerge}
							/>
						) : null}

						{toReview.length > 0 ? (
							<PrCard title="À relire" tone="info" icon={GitPullRequest} items={toReview} />
						) : null}

						{/* Ce que le cockpit a fait en ton nom : une app qui pousse et
						    fusionne doit pouvoir rendre des comptes. */}
						{(journal.data ?? []).length > 0 ? (
							<Card title="Activité du cockpit" count={journal.data?.length}>
								{(journal.data ?? []).map((entry, index) => (
									<div
										key={`${entry.at}-${index}`}
										className="flex items-center gap-2 px-2.5 py-1.5"
									>
										<Dot tone={entry.ok ? "success" : "critical"} />
										<span className="shrink-0 text-[11px] text-ink">{entry.label}</span>
										{/* Ce que tu n'as pas demandé se distingue de ce que tu as
										    demandé, ligne par ligne : c'est la seule question à
										    laquelle ce carnet doit savoir répondre. */}
										{entry.actor !== "me" ? <Badge>Permanence</Badge> : null}
										<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
											{entry.detail || shortPath(entry.target, 1)}
										</span>
										<span className="shrink-0 font-mono text-[10px] text-ink-faint">
											{fromTimestamp(entry.at)}
										</span>
									</div>
								))}
							</Card>
						) : null}

						{removable.length > 0 ? (
							<Card title="Worktrees à ranger" count={removable.length}>
								<button
									type="button"
									onClick={() => go("worktrees")}
									className="flex w-full items-center gap-2 p-2.5 text-left hover:bg-hover"
								>
									<Trash2 size={13} className="shrink-0 text-ink-faint" />
									<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
										{removable
											.slice(0, 4)
											.map((entry) => entry.branch ?? entry.folderName)
											.join(", ")}
										{removable.length > 4 ? `, +${removable.length - 4}` : ""}
									</span>
									<Badge>{removable.length}</Badge>
								</button>
							</Card>
						) : null}
					</div>
				</div>
			</div>
		</>
	);
}

/**
 * Le bandeau de tête : ce qui t'attend, en tuiles.
 *
 * Chaque tuile porte la couleur de ce qu'elle coûte, parce que « trois choses
 * t'attendent » ne dit pas si l'une d'elles gèle un agent depuis une heure.
 * En tuiles plutôt qu'en lignes : à cinq blocages on tient sur deux rangées au
 * lieu de cinq, et le reste de l'écran commence plus haut.
 */
function Blockers({ items }: { items: Blocker[] }) {
	if (items.length === 0) return null;
	const worst = items.some((item) => item.tone === "critical") ? "critical" : "warning";
	return (
		<section className="panel shrink-0 overflow-hidden">
			<header className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
				<Dot tone={worst} pulse />
				<h2 className="text-[11px] font-semibold tracking-[0.06em] text-ink uppercase">
					Ça t'attend
				</h2>
				<span className="font-mono text-[10px] text-ink-faint">{items.length}</span>
			</header>
			<div className="grid grid-cols-1 gap-2 p-2 md:grid-cols-2 2xl:grid-cols-3">
				{items.map((item) => {
					const tone = TONES[item.tone];
					return (
						// Le geste vit à côté de la tuile, pas dedans : un bouton dans un
						// bouton est du HTML invalide, et le clic partait de travers.
						<div
							key={item.key}
							className={clsx(
								"group flex items-center gap-2.5 rounded-xl border p-2.5 transition-colors duration-120",
								tone.tile,
							)}
						>
							<button
								type="button"
								onClick={item.onClick}
								className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 text-left"
							>
								<item.icon size={15} className={clsx("shrink-0", tone.icon)} />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[12.5px] text-ink">{item.title}</span>
									<span className="block truncate font-mono text-[10px] text-ink-faint">
										{item.detail}
									</span>
								</span>
								{item.meta ? (
									<span className={clsx("shrink-0 font-mono text-[10px]", tone.icon)}>
										{item.meta}
									</span>
								) : null}
							</button>
							{item.fix ? <Fix item={item} /> : null}
						</div>
					);
				})}
			</div>
		</section>
	);
}

/**
 * Le geste qui lève un blocage.
 *
 * Discret jusqu'au survol : cet écran se lit d'abord, et une rangée de boutons
 * permanents en ferait un formulaire. Mais il reste toujours atteignable au
 * clavier — ce qu'on ne voit qu'au survol n'existe pas pour qui n'a pas de
 * souris.
 */
function Fix({ item }: { item: Blocker }) {
	const { notify } = useCockpit();
	const [busy, setBusy] = useState(false);
	if (!item.fix) return null;
	return (
		<Button
			size="sm"
			variant="solid"
			loading={busy}
			className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 focus:opacity-100"
			onClick={() => {
				setBusy(true);
				void item
					.fix!.run()
					.then(() => notify(`${item.fix!.label} — c'est parti.`))
					.catch((error) => notify(String(error)))
					.finally(() => setBusy(false));
			}}
		>
			{item.fix.label}
		</Button>
	);
}

/**
 * Une carte de la grille : en-tête, puis un contenu qui défile chez lui.
 *
 * La hauteur est bornée pour que toutes les cartes restent visibles ensemble —
 * c'est le point de l'écran. Une liste plus longue défile à l'intérieur, sans
 * repousser ses voisines.
 */
function Card({
	title,
	count,
	children,
}: {
	title: string;
	count?: number;
	children: ReactNode;
}) {
	return (
		<section className="panel flex max-h-[22rem] min-h-0 flex-col overflow-hidden">
			<header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line-soft px-3">
				<h2 className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
					{title}
				</h2>
				{count !== undefined ? (
					<span className="font-mono text-[10px] text-ink-faint">{count}</span>
				) : null}
			</header>
			<div className="min-h-0 flex-1 divide-y divide-line-soft overflow-y-auto">{children}</div>
		</section>
	);
}

function PrCard({
	title,
	tone,
	icon: Icon,
	items,
}: {
	title: string;
	tone: "success" | "info";
	icon: React.ComponentType<{ size?: number; className?: string }>;
	items: Array<{
		number: number;
		title: string;
		url: string;
		headRef: string;
		labels: Array<{ name: string; color: string }>;
	}>;
}) {
	const { notify } = useCockpit();
	return (
		<Card title={title} count={items.length}>
			{items.map((pr) => (
				// Cet écran dit par quoi commencer : autant pouvoir s'y mettre. Les
				// actions sont celles du détail d'une PR, au même endroit sur la
				// ligne, révélées au survol pour que la liste reste lisible.
				<div key={pr.number} className="group relative flex items-start gap-2 p-2.5">
					<button
						type="button"
						onClick={() => {
							void api.system.openUrl(pr.url).catch((error) => notify(String(error)));
						}}
						className="flex min-w-0 flex-1 items-start gap-2 text-left"
					>
						<Icon
							size={13}
							className={clsx(
								"mt-px shrink-0",
								tone === "success" ? "text-success" : "text-info",
							)}
						/>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[12.5px] text-ink">{pr.title}</span>
							<span className="flex items-center gap-1.5 font-mono text-[10px] text-ink-faint">
								<span className="shrink-0">#{pr.number}</span>
								<span className="text-line">·</span>
								<span className="truncate">{pr.headRef}</span>
								<PrLabels labels={pr.labels} max={2} />
							</span>
						</span>
					</button>
					<span className="absolute top-1.5 right-1.5 flex gap-1 rounded-lg bg-raised px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100">
						<PrActions number={pr.number} headRef={pr.headRef} />
					</span>
				</div>
			))}
		</Card>
	);
}

/** Liste de tâches avec saisie en tête : ajouter doit coûter une frappe. */
function TaskList({
	tasks,
	pending,
	done,
}: {
	tasks: { reload: () => void; initial: boolean; loading: boolean };
	pending: import("@/lib/types").Task[];
	done: import("@/lib/types").Task[];
}) {
	const { notify } = useCockpit();
	const [draft, setDraft] = useState("");
	const [high, setHigh] = useState(false);

	const add = () => {
		const text = draft.trim();
		if (!text) return;
		setDraft("");
		void api.tasks
			.add(text, high ? "high" : "normal")
			.then(() => {
				setHigh(false);
				tasks.reload();
			})
			.catch((error) => notify(String(error)));
	};

	return (
		<>
			{/* La saisie ne défile pas avec les tâches : ajouter une note doit rester
			    à un clic, même quand la liste est longue. */}
			<div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line-soft bg-surface p-2.5">
				<input
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") add();
					}}
					placeholder="Une tâche à ne pas oublier…"
					className="focus-ring text-selectable min-w-0 flex-1 rounded-lg border border-line-soft bg-void px-2.5 py-1.5 text-[12.5px] text-ink"
				/>
				<Button
					size="sm"
					active={high}
					onClick={() => setHigh((value) => !value)}
					title="Marquer comme urgent"
				>
					Urgent
				</Button>
				<Button variant="solid" icon={draft.trim() ? CornerDownLeft : Plus} onClick={add}>
					Ajouter
				</Button>
			</div>

			{tasks.initial && tasks.loading ? <SkeletonRows rows={3} className="p-2.5" /> : null}

			{[...pending, ...done].map((task) => (
				<div
					key={task.id}
					className="flex items-center gap-2 border-b border-line-soft p-2.5 last:border-b-0"
				>
					<button
						type="button"
						onClick={() => {
							void api.tasks.toggle(task.id).then(() => tasks.reload());
						}}
						title={task.done ? "Rouvrir" : "Terminer"}
						className={clsx(
							"focus-ring flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
							task.done
								? "border-success/50 bg-success/15 text-success"
								: "border-line hover:border-ink-faint",
						)}
					>
						{task.done ? <Check size={10} /> : null}
					</button>
					{task.priority === "high" && !task.done ? <Dot tone="critical" /> : null}
					<span
						className={clsx(
							"min-w-0 flex-1 text-[12.5px]",
							task.done ? "text-ink-faint line-through" : "text-ink",
						)}
					>
						{task.text}
					</span>
					<Button
						size="sm"
						icon={X}
						title="Supprimer"
						onClick={() => {
							void api.tasks.remove(task.id).then(() => tasks.reload());
						}}
					/>
				</div>
			))}
		</>
	);
}
