import clsx from "clsx";
import { Copy, History, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCockpit } from "@/app/store";
import { Button, Modal, Spinner } from "@/components/ui";
import { locale } from "@/i18n";
import { fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { Mission, MissionChange, MissionEvent, TaskState } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * L'historique d'une mission, étape par étape.
 *
 * La fiche dit où en est la mission ; elle ne dit pas comment elle y est
 * arrivée. Deux portes rouges de suite n'y laissent que la dernière sortie, et
 * une recette renvoyée trois fois ne s'y lit que comme un compteur. Ici chaque
 * événement garde ce qu'il disait au moment où il s'est produit, et l'état des
 * branches se recompose à n'importe quel instant passé.
 *
 * Les événements viennent de `mission_events.rs`, qui les déduit de chaque
 * écriture de la fiche. Une mission ouverte avant leur arrivée n'en a pas : on
 * le dit plutôt que de montrer une frise vide sans explication.
 */

/** Les reprises au-delà desquelles une tâche rend la main : `mission::MAX_ATTEMPTS`. */
const MAX_ATTEMPTS = 3;

type Tone = "neutral" | "live" | "done" | "failed" | "human";

const DOT: Record<Tone, string> = {
	neutral: "bg-ink-faint",
	live: "bg-accent",
	done: "bg-success",
	failed: "bg-critical",
	human: "bg-warning",
};

interface Entry {
	event: MissionEvent;
	/** Sa place dans l'historique complet, pour recomposer l'état à cet instant. */
	index: number;
	tone: Tone;
}

/**
 * Ce qu'on montre de l'historique.
 *
 * Une reprise remet sa tâche « à faire » dans le même geste : la transition
 * n'apprend rien que la reprise n'ait déjà dit, et doublait chaque renvoi dans
 * la liste. Pareil pour la porte qui se lance au même instant qu'une livraison.
 */
function visible(events: MissionEvent[]): Entry[] {
	return events.flatMap((event, index) => {
		const change = event.change;
		if (change.kind === "task" && change.to === "planned") {
			const reworked = events.some(
				(other) =>
					other.at === event.at && other.change.kind === "rework" && other.change.task === change.task,
			);
			if (reworked) return [];
		}
		return [{ event, index, tone: toneOf(change) }];
	});
}

function toneOf(change: MissionChange): Tone {
	switch (change.kind) {
		case "review":
			return change.approved ? "human" : "failed";
		case "paused":
			return "human";
		case "state":
			if (change.to === "failed") return "failed";
			if (change.to === "done") return "done";
			if (change.to.startsWith("awaiting")) return "human";
			return "live";
		case "task":
			if (change.to === "failed") return "failed";
			if (change.to === "delivered" || change.to === "integrated") return "done";
			return change.to === "running" ? "live" : "neutral";
		case "rework":
			return "failed";
		case "gate":
			if (change.gate === "failed") return "failed";
			if (change.gate === "passed") return "done";
			return "live";
		case "pr":
			return "done";
		default:
			return "neutral";
	}
}

/** Où en était chaque tâche juste après l'événement `upTo` : état et dernier commit jugé. */
function snapshot(events: MissionEvent[], upTo: number) {
	const tasks = new Map<string, { state: TaskState | null; commit: string; gate: string }>();
	const touch = (task: string) => {
		const known = tasks.get(task) ?? { state: null, commit: "", gate: "" };
		tasks.set(task, known);
		return known;
	};
	for (const { change } of events.slice(0, upTo + 1)) {
		if (change.kind === "taskAdded") touch(change.task).state = "planned";
		if (change.kind === "task") touch(change.task).state = change.to;
		if (change.kind === "gate") {
			const entry = touch(change.task);
			entry.gate = change.gate;
			if (change.commit) entry.commit = change.commit;
		}
	}
	return tasks;
}

function clock(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

function fullDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

/** Le bouton qui ouvre l'historique, là où l'on regarde déjà la mission. */
export function MissionTimelineButton({ mission }: { mission: Mission }) {
	const { t } = useTranslation("components2");
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button size="sm" icon={History} title={t("missionTimeline.open")} onClick={() => setOpen(true)}>
				{t("missionTimeline.button")}
			</Button>
			{open ? (
				<Modal onClose={() => setOpen(false)} align="center">
					<div
						role="dialog"
						aria-label={t("missionTimeline.title", { title: mission.title })}
						className="flex h-[min(820px,calc(100vh-80px))] w-[min(1180px,100%)] flex-col overflow-hidden rounded-2xl bg-base shadow-pop"
					>
						<header className="hairline-b flex items-center gap-3 bg-surface px-5 py-3">
							<History size={15} className="text-ink-muted" />
							<h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">
								{t("missionTimeline.title", { title: mission.title })}
							</h2>
							<Button icon={X} title={t("missionTimeline.close")} onClick={() => setOpen(false)} />
						</header>
						<MissionTimeline mission={mission} />
					</div>
				</Modal>
			) : null}
		</>
	);
}

export function MissionTimeline({ mission }: { mission: Mission }) {
	const { t } = useTranslation("components2");
	const closed = mission.state === "done" || mission.state === "failed";
	const events = useAsync(() => api.missions.events(mission.id), [mission.id], {
		pollMs: closed ? undefined : 4000,
	});
	const all = useMemo(() => events.data ?? [], [events.data]);
	const entries = useMemo(() => visible(all), [all]);
	// Rien de choisi : on suit le dernier événement, comme une mission qui avance.
	const [picked, setPicked] = useState<number | null>(null);
	const selected = picked !== null && picked < entries.length ? picked : entries.length - 1;

	if (events.loading && !events.data) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-faint">
				<Spinner /> {t("missionTimeline.loading")}
			</div>
		);
	}
	if (entries.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center p-10">
				<p className="max-w-md text-center text-[13px] leading-relaxed text-ink-muted">
					{t("missionTimeline.empty")}
				</p>
			</div>
		);
	}

	const current = entries[selected];
	const start = Date.parse(entries[0].event.at);
	const end = closed ? Date.parse(entries[entries.length - 1].event.at) : Math.max(Date.now(), start);
	const span = Math.max(end - start, 1);
	const position = (iso: string) => ((Date.parse(iso) - start) / span) * 100;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
			<Scrubber
				entries={entries}
				selected={selected}
				onPick={setPicked}
				position={position}
				start={entries[0].event.at}
				end={closed ? entries[entries.length - 1].event.at : null}
				title={(entry) => describe(entry.event.change, mission, t)}
			/>

			<div className="flex min-h-0 flex-1 gap-4">
				<ol
					aria-label={t("missionTimeline.list")}
					className="flex w-[380px] shrink-0 flex-col gap-0.5 overflow-y-auto rounded-2xl bg-surface p-2 shadow-card"
				>
					{entries.map((entry, index) => (
						<li key={`${entry.index}`}>
							<button
								type="button"
								aria-current={index === selected ? "step" : undefined}
								onClick={() => setPicked(index)}
								className={clsx(
									"focus-ring flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
									index === selected ? "bg-accent-dim" : "hover:bg-hover",
								)}
							>
								<span className="w-11 shrink-0 font-mono text-[11px] text-ink-muted">
									{clock(entry.event.at)}
								</span>
								<span className={clsx("size-2 shrink-0 rounded-full", DOT[entry.tone])} />
								<span className="flex min-w-0 flex-col">
									<span
										className={clsx(
											"truncate text-[12px] text-ink",
											index === selected ? "font-semibold" : "font-medium",
										)}
									>
										{describe(entry.event.change, mission, t)}
									</span>
									<span className="text-[11px] text-ink-muted">{actorOf(entry.event.change, mission, t)}</span>
								</span>
							</button>
						</li>
					))}
				</ol>

				<Detail
					mission={mission}
					all={all}
					entry={current}
					position={selected + 1}
					total={entries.length}
				/>
			</div>
		</div>
	);
}

type T = ReturnType<typeof useTranslation>["t"];

function taskTitle(mission: Mission, id: string): string {
	return mission.tasks.find((task) => task.id === id)?.title ?? id;
}

function stepLabel(step: string, t: T): string {
	return t(`missionTimeline.steps.${step}`);
}

/** Ce que dit l'événement, en une ligne. */
function describe(change: MissionChange, mission: Mission, t: T): string {
	switch (change.kind) {
		case "opened":
			return t(change.guided ? "missionTimeline.event.openedGuided" : "missionTimeline.event.opened");
		case "state":
			return t(`missionTimeline.states.${change.to}`);
		case "draft":
			return t("missionTimeline.event.draft", { step: stepLabel(change.step, t), version: change.version });
		case "review":
			return t(change.approved ? "missionTimeline.event.reviewApproved" : "missionTimeline.event.reviewCorrected", {
				step: stepLabel(change.step, t),
			});
		case "plan":
			return t("missionTimeline.event.plan", { count: change.tasks });
		case "taskAdded":
			return t("missionTimeline.event.taskAdded", { title: change.title });
		case "task":
			return t("missionTimeline.event.task", {
				title: taskTitle(mission, change.task),
				state: t(`missions.taskStates.${change.to}`, { ns: "views" }),
			});
		case "rework":
			return t("missionTimeline.event.rework", { title: taskTitle(mission, change.task) });
		case "gate":
			return t(`missionTimeline.event.gate.${change.gate}`, { title: taskTitle(mission, change.task) });
		case "paused":
			return t(change.paused ? "missionTimeline.event.paused" : "missionTimeline.event.resumed");
		case "pr":
			return t("missionTimeline.event.pr");
	}
}

/** Qui a agi : toi, le maître, une tâche, les portes ou le cockpit. */
function actorOf(change: MissionChange, mission: Mission, t: T): string {
	switch (change.kind) {
		case "review":
		case "paused":
			return t("missionTimeline.actor.you");
		case "draft":
		case "plan":
		case "taskAdded":
			return t("missionTimeline.actor.lead");
		case "state":
			return change.to.startsWith("awaiting")
				? t("missionTimeline.actor.waitingForYou")
				: t("missionTimeline.actor.cockpit");
		case "task":
		case "rework": {
			const role = mission.tasks.find((task) => task.id === change.task)?.role;
			return role ? t("missionTimeline.actor.role", { role }) : t("missionTimeline.actor.cockpit");
		}
		case "gate":
			return t("missionTimeline.actor.checks");
		default:
			return t("missionTimeline.actor.cockpit");
	}
}

function Scrubber({
	entries,
	selected,
	onPick,
	position,
	start,
	end,
	title,
}: {
	entries: Entry[];
	selected: number;
	onPick: (index: number) => void;
	position: (iso: string) => number;
	start: string;
	end: string | null;
	title: (entry: Entry) => string;
}) {
	const { t } = useTranslation("components2");
	const cursor = position(entries[selected].event.at);
	return (
		<section
			aria-label={t("missionTimeline.scrubber")}
			className="flex shrink-0 flex-col gap-2 rounded-2xl bg-surface px-5 pt-3 pb-3.5 shadow-card"
		>
			<div className="flex items-baseline justify-between gap-4">
				<p className="min-w-0 truncate text-[12px] text-ink">
					<span className="text-ink-muted">{t("missionTimeline.viewing")} </span>
					<b className="font-mono">{clock(entries[selected].event.at)}</b>
					<span className="text-ink-muted"> · {title(entries[selected])}</span>
				</p>
				<p className="shrink-0 text-[11px] text-ink-muted">{t("missionTimeline.hint")}</p>
			</div>
			<div className="relative h-7">
				<div className="absolute inset-x-0 top-[13px] h-0.5 rounded-full bg-line-soft" />
				<div className="absolute left-0 top-[13px] h-0.5 rounded-full bg-accent" style={{ width: `${cursor}%` }} />
				<div
					className="absolute top-0.5 h-6 w-0.5 -translate-x-1/2 rounded-full bg-ink"
					style={{ left: `${cursor}%` }}
				/>
				{entries.map((entry, index) => (
					<button
						key={entry.index}
						type="button"
						aria-label={`${clock(entry.event.at)} · ${title(entry)}`}
						onClick={() => onPick(index)}
						className={clsx(
							"focus-ring absolute top-1.5 size-3.5 -translate-x-1/2 rounded-full border-2 border-surface",
							DOT[entry.tone],
							index === selected && "ring-2 ring-ink/25",
						)}
						style={{ left: `${position(entry.event.at)}%` }}
					/>
				))}
			</div>
			<div className="flex justify-between font-mono text-[11px] text-ink-muted">
				<span>{clock(start)}</span>
				<span>{end ? clock(end) : t("missionTimeline.now")}</span>
			</div>
		</section>
	);
}

function Detail({
	mission,
	all,
	entry,
	position,
	total,
}: {
	mission: Mission;
	all: MissionEvent[];
	entry: Entry;
	position: number;
	total: number;
}) {
	const { t } = useTranslation("components2");
	const change = entry.event.change;
	const tasks = snapshot(all, entry.index);

	return (
		<section
			aria-label={t("missionTimeline.detail")}
			className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto rounded-2xl bg-surface p-5 shadow-card"
		>
			<div className="flex flex-col gap-1">
				<p className="text-[10px] font-semibold tracking-wider text-ink-muted uppercase">
					{t("missionTimeline.position", { position, total })}
				</p>
				<h3 className="text-[17px] font-semibold text-ink">{describe(change, mission, t)}</h3>
				<p className="text-[12px] text-ink-muted">
					{actorOf(change, mission, t)} · {fullDate(entry.event.at)} · {fromIso(entry.event.at)}
				</p>
			</div>

			<Body change={change} />

			{tasks.size > 0 ? (
				<div className="flex flex-col gap-1.5">
					<p className="text-[11px] font-semibold text-ink-muted">{t("missionTimeline.branches")}</p>
					<div className="flex flex-col divide-y divide-line-soft rounded-xl border border-line-soft">
						<div className="flex items-center gap-3 px-3 py-2 text-[12px]">
							<span className="w-28 shrink-0 text-ink-muted">{t("missionTimeline.integration")}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
								{mission.branch || "—"}
							</span>
						</div>
						{[...tasks.entries()].map(([id, state]) => {
							const task = mission.tasks.find((candidate) => candidate.id === id);
							return (
								<div key={id} className="flex items-center gap-3 px-3 py-2 text-[12px]">
									<span className="w-28 shrink-0 truncate text-ink-muted" title={task?.title}>
										{task?.title ?? id}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
										{task?.branch || "—"}
										{state.commit ? ` @ ${state.commit.slice(0, 7)}` : ""}
									</span>
									<span className="shrink-0 text-[11px] text-ink-muted">
										{state.state ? t(`missions.taskStates.${state.state}`, { ns: "views" }) : "—"}
										{state.gate === "failed" ? ` · ${t("missionTimeline.gateFailedShort")}` : ""}
										{state.gate === "passed" ? ` · ${t("missionTimeline.gatePassedShort")}` : ""}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			) : null}
		</section>
	);
}

/** Le corps de l'événement : ce qu'il disait à ce moment-là, tel quel. */
function Body({ change }: { change: MissionChange }) {
	const { t } = useTranslation("components2");
	const { notify } = useCockpit();
	const text = (label: string, value: string) =>
		value.trim() ? (
			<div className="flex flex-col gap-1">
				<p className="text-[11px] font-semibold text-ink-muted">{label}</p>
				<p className="text-selectable text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{value}</p>
			</div>
		) : null;

	switch (change.kind) {
		case "state":
			return (
				<>
					<p className="text-[13px] text-ink">
						{t("missionTimeline.fromTo", {
							from: t(`missionTimeline.states.${change.from}`),
							to: t(`missionTimeline.states.${change.to}`),
						})}
					</p>
					{text(t("missionTimeline.note"), change.note)}
				</>
			);
		case "draft":
			return (
				<p className="text-[13px] text-ink">
					{t("missionTimeline.questions", { count: change.questions })}
				</p>
			);
		case "review":
			return text(t("missionTimeline.feedback"), change.feedback);
		case "taskAdded":
			return <p className="text-[13px] text-ink">{t("missionTimeline.role", { role: change.role })}</p>;
		case "task":
			return (
				<>
					<p className="text-[13px] text-ink">
						{t("missionTimeline.fromTo", {
							from: t(`missions.taskStates.${change.from}`, { ns: "views" }),
							to: t(`missions.taskStates.${change.to}`, { ns: "views" }),
						})}
					</p>
					{text(t("missionTimeline.note"), change.note)}
				</>
			);
		case "rework":
			return (
				<>
					<p className="text-[13px] text-ink">
						{t("missionTimeline.attempt", { attempt: change.attempt, max: MAX_ATTEMPTS })}
					</p>
					{text(t("missionTimeline.reason"), change.reason)}
				</>
			);
		case "gate":
			return (
				<>
					{change.output.trim() ? (
						<pre className="text-selectable overflow-x-auto rounded-xl bg-raised p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-ink">
							{change.output}
						</pre>
					) : null}
					{change.commit ? (
						<div className="flex items-center gap-2 text-[12px]">
							<span className="text-ink-muted">{t("missionTimeline.commit")}</span>
							<code className="font-mono text-[11px] text-ink">{change.commit.slice(0, 12)}</code>
							<Button
								size="sm"
								icon={Copy}
								title={t("missionTimeline.copy")}
								onClick={() => {
									void navigator.clipboard
										.writeText(change.commit)
										.then(() => notify(t("missionTimeline.copied")))
										.catch(() => undefined);
								}}
							/>
						</div>
					) : null}
				</>
			);
		case "pr":
			return (
				<div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void api.system.openUrl(change.url).catch(() => undefined)}
					>
						{t("missionTimeline.openPr")}
					</Button>
				</div>
			);
		default:
			return null;
	}
}
