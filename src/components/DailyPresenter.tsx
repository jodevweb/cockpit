import clsx from "clsx";
import { ChevronLeft, ChevronRight, ClipboardCopy, CircleDot, ExternalLink, Pause, Play, Plus, Timer, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, PriorityBadge } from "@/components/ui";
import { t as translate } from "@/i18n";
import { api } from "@/lib/ipc";
import type { Flag, MemberBoard } from "@/lib/types";
import { usePersistentState } from "@/lib/useAsync";

/** Budget de parole par personne. Dépassé, le chrono passe au rouge. */
const SPEAKING_BUDGET = 90;

interface Parked {
	subject: string;
	member: string;
}

/** Engagement pris à un daily, relu au suivant. */
interface Commitment {
	text: string;
	/** Verdict donné au daily suivant. */
	status: "pending" | "done" | "ongoing" | "postponed";
}

/** Le verdict d'un engagement, dit au rendu. */
function statusLabel(status: Commitment["status"]): string {
	return status === "pending" ? "—" : translate(`components3:dailyPresenter.status.${status}`);
}

function clock(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Une ligne d'une partie, dite à voix haute, ouvrable d'un clic. */
interface Said {
	key: string;
	title: string;
	detail?: string;
	links: Array<{ label: string; url: string }>;
	tone?: "critical" | "warning";
}

interface Part {
	title: string;
	lines: Said[];
	empty: string;
}

/** Les parties d'une personne, tirées du tableau d'équipe. */
function partsOf(member: MemberBoard, flags: Flag[]): Part[] {
	const merged = member.delta.filter((item) => item.kind === "merged");
	const opened = member.delta.filter((item) => item.kind === "opened");
	return [
		{
			title: translate("components3:dailyPresenter.parts.shipped"),
			empty: translate("components3:dailyPresenter.parts.shippedEmpty"),
			lines: [
				...merged.map((item) => ({ key: item.url, title: item.label, links: [{ label: "PR", url: item.url }] })),
				...(opened.length > 0
					? [{ key: "opened", title: translate("components3:dailyPresenter.parts.openedSince", { count: opened.length }), links: [] }]
					: []),
			],
		},
		{
			title: translate("components3:dailyPresenter.parts.ongoing"),
			empty: translate("components3:dailyPresenter.parts.ongoingEmpty"),
			lines: member.activeTickets.slice(0, 6).map((ticket) => ({
				key: ticket.identifier,
				title: ticket.title,
				detail: translate("components3:dailyPresenter.parts.ticketDetail", {
					id: ticket.identifier,
					progress: ticket.progress,
					days: ticket.ageDays,
				}),
				links: ticket.url ? [{ label: ticket.identifier, url: ticket.url }] : [],
			})),
		},
		{
			title: translate("components3:dailyPresenter.parts.toHandle"),
			empty: translate("components3:dailyPresenter.parts.toHandleEmpty"),
			lines: flags.slice(0, 5).map((flag) => ({
				key: flag.key,
				title: flag.question,
				links: [
					...(flag.ticketUrl && flag.ticketId ? [{ label: flag.ticketId, url: flag.ticketUrl }] : []),
					...(flag.prUrl && flag.prNumber ? [{ label: `PR #${flag.prNumber}`, url: flag.prUrl }] : []),
				],
				tone: flag.severity === "red" ? ("critical" as const) : ("warning" as const),
			})),
		},
	];
}

/**
 * Mode présentation du daily : le tour de parole, une personne à la fois.
 *
 * Pensé pour être partagé en visio — corps de texte agrandi, une partie à la
 * fois, navigation au clavier pour ne pas chercher la souris devant tout le
 * monde. À gauche le tour de parole, au centre la partie en cours, à droite
 * l'engagement pris au daily précédent.
 *
 * La partie de celui qui a une automatisation de daily vient de son rendu du
 * jour, lignes écartées comprises : c'est ce qu'il a relu, pas ce que le
 * tableau d'équipe devine.
 *
 * Le parking répond au travers le plus courant du rituel : un sujet technique
 * transverse surgit au milieu d'un tour de parole. Plutôt que de couper ou de
 * laisser filer, on le note d'un clic et il est rappelé à la fin.
 */
export function DailyPresenter({
	members,
	flags,
	sinceDaily,
	onClose,
}: {
	members: MemberBoard[];
	flags: Flag[];
	sinceDaily: string;
	onClose: () => void;
}) {
		const { t } = useTranslation("components3");
	// L'ordre de passage est stable d'un daily à l'autre : chacun sait quand
	// vient son tour, ce qui évite les « à qui le tour ? ».
	const [order] = usePersistentState<string[]>("daily.order", []);
	const speakers = useMemo(() => {
		const devs = members.filter((member) => member.role === "dev");
		if (order.length === 0) return devs;
		const rank = (name: string) => {
			const index = order.indexOf(name);
			return index === -1 ? 999 : index;
		};
		return [...devs].sort((a, b) => rank(a.name) - rank(b.name));
	}, [members, order]);

	const [index, setIndex] = useState(0);
	const [part, setPart] = useState(0);
	const [elapsed, setElapsed] = useState(0);
	const [total, setTotal] = useState(0);
	const [paused, setPaused] = useState(false);
	const [parked, setParked] = useState<Parked[]>([]);
	const [subject, setSubject] = useState("");
	const [done, setDone] = useState(false);
	// Les engagements survivent d'un daily à l'autre : c'est tout leur intérêt.
	const [commitments, setCommitments] = usePersistentState<Record<string, Commitment>>("daily.commitments", {});
	const [nextPledge, setNextPledge] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const pledgeRef = useRef<HTMLInputElement>(null);

	const current = speakers[index] ?? null;
	const currentFlags = flags.filter((flag) => flag.member === current?.name);
	const parts = current ? partsOf(current, currentFlags) : [];
	const shown = parts[Math.min(part, parts.length - 1)] ?? null;

	// Chrono : remis à zéro à chaque changement de personne, cumulé pour le daily.
	useEffect(() => {
		if (paused || done) return;
		const timer = window.setInterval(() => {
			setElapsed((value) => value + 1);
			setTotal((value) => value + 1);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [paused, done]);

	const speaker = (direction: 1 | -1) => {
		setElapsed(0);
		setPart(0);
		setIndex((value) => {
			const next = value + direction;
			if (next >= speakers.length) {
				setDone(true);
				return value;
			}
			return Math.max(0, next);
		});
	};

	// → avance d'une partie, puis passe à la personne suivante : on déroule le
	// tour sans quitter le clavier.
	const forward = () => {
		if (part < parts.length - 1) setPart(part + 1);
		else speaker(1);
	};
	const backward = () => {
		if (part > 0) setPart(part - 1);
		else if (index > 0) speaker(-1);
	};

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			// La saisie du parking ou d'un engagement ne doit pas déclencher la navigation.
			if (document.activeElement === inputRef.current || document.activeElement === pledgeRef.current) {
				if (event.key === "Escape") (document.activeElement as HTMLElement).blur();
				return;
			}
			if (event.key === "ArrowRight" || event.key === " ") {
				event.preventDefault();
				forward();
			}
			if (event.key === "ArrowLeft") backward();
			if (event.key === "Escape") onClose();
			if (event.key === "p") setPaused((value) => !value);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	});

	const pledge = commitments[current?.name ?? ""] ?? null;

	const setStatus = (status: Commitment["status"]) => {
		if (!current || !pledge) return;
		setCommitments({ ...commitments, [current.name]: { ...pledge, status } });
	};

	const savePledge = () => {
		if (!current || !nextPledge.trim()) return;
		setCommitments({ ...commitments, [current.name]: { text: nextPledge.trim(), status: "pending" } });
		setNextPledge("");
	};

	/** Trace du daily, à coller dans Slack. */
	const recap = () => {
		const lines = [t("dailyPresenter.recap.heading", { date: sinceDaily }), ""];
		for (const member of speakers) {
			const memberFlags = flags.filter((flag) => flag.member === member.name);
			lines.push(`## ${member.name}`);
			lines.push(member.narrative.text);
			const merged = member.delta.filter((item) => item.kind === "merged");
			if (merged.length > 0) lines.push(t("dailyPresenter.recap.shipped", { items: merged.map((item) => item.label).join(" · ") }));
			for (const flag of memberFlags.filter((entry) => entry.severity === "red")) lines.push(`- ⚠︎ ${flag.question}`);
			const own = commitments[member.name];
			if (own?.text) {
				lines.push(
					own.status !== "pending"
						? t("dailyPresenter.recap.commitmentWithStatus", { text: own.text, status: statusLabel(own.status) })
						: t("dailyPresenter.recap.commitment", { text: own.text }),
				);
			}
			lines.push("");
		}
		if (parked.length > 0) {
			lines.push(t("dailyPresenter.recap.parked"));
			for (const entry of parked) lines.push(`- ${entry.subject} (${entry.member})`);
		}
		void navigator.clipboard.writeText(lines.join("\n"));
	};

	const park = () => {
		if (!subject.trim() || !current) return;
		setParked((list) => [...list, { subject: subject.trim(), member: current.name }]);
		setSubject("");
	};

	const over = elapsed > SPEAKING_BUDGET;
	const ring = 2 * Math.PI * 27;
	const left = Math.max(0, SPEAKING_BUDGET - elapsed) / SPEAKING_BUDGET;

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-void">
			<div className="hairline-b flex items-center gap-3 px-6 py-3">
				<span className="text-[14px] font-semibold text-ink">{t("dailyPresenter.title")}</span>
				<span className="text-[12px] text-ink-muted">{t("dailyPresenter.since", { date: sinceDaily })}</span>
				<div className="ml-auto flex items-center gap-3">
					<span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
						<Timer size={13} />
						{t("dailyPresenter.total", { time: clock(total) })}
					</span>
					<span className="font-mono text-[12px] text-ink-muted">
						{Math.min(index + 1, speakers.length)} / {speakers.length}
					</span>
					<Button size="sm" icon={X} onClick={onClose} title={t("dailyPresenter.quit")} />
				</div>
			</div>

			{done ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-10">
					<div className="text-center">
						<p className="text-[26px] font-semibold text-ink">{t("dailyPresenter.done.title")}</p>
						<p className="mt-1 text-[13px] text-ink-muted">
							{t("dailyPresenter.done.duration", { time: clock(total), count: speakers.length })}
						</p>
					</div>
					{parked.length > 0 ? (
						<div className="w-full max-w-2xl">
							<div className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
								{t("dailyPresenter.done.parked", { count: parked.length })}
							</div>
							<div className="flex flex-col gap-1.5">
								{parked.map((entry, position) => (
									<div key={position} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-[13.5px] shadow-card">
										<CircleDot size={13} className="shrink-0 text-accent" />
										<span className="min-w-0 flex-1 text-ink">{entry.subject}</span>
										<Badge>{entry.member}</Badge>
									</div>
								))}
							</div>
						</div>
					) : (
						<p className="text-[13px] text-ink-muted">{t("dailyPresenter.done.noParked")}</p>
					)}
					<div className="flex gap-2">
						<Button icon={ClipboardCopy} onClick={recap}>
							{t("dailyPresenter.done.copyRecap")}
						</Button>
						<Button variant="solid" onClick={onClose}>
								{t("dailyPresenter.done.close")}
						</Button>
					</div>
				</div>
			) : current ? (
				<div className="flex min-h-0 flex-1 gap-4 overflow-y-auto p-5">
					<aside aria-label={t("dailyPresenter.speakers")} className="flex w-[240px] shrink-0 flex-col gap-1 self-start rounded-2xl bg-surface p-3 shadow-card">
						{speakers.map((member, position) => {
							const now = position === index;
							const past = position < index;
							return (
								<button
									key={member.name}
									type="button"
									onClick={() => {
										setIndex(position);
										setPart(0);
										setElapsed(0);
									}}
									className={clsx(
										"focus-ring flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 text-left",
										now ? "bg-raised font-semibold" : "hover:bg-hover",
									)}
								>
									<span
										className={clsx(
											"flex size-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold",
											now ? "bg-accent text-accent-ink" : "bg-raised text-ink-muted",
										)}
									>
										{member.name.slice(0, 2).toUpperCase()}
									</span>
									<span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{member.name}</span>
									{now ? (
										<span className="rounded-full bg-accent-dim px-2 py-0.5 text-[11px] font-semibold text-accent">{t("dailyPresenter.speaker.speaking")}</span>
									) : past ? (
										<span className="text-[11px] text-ink-muted">{t("dailyPresenter.speaker.done")}</span>
									) : null}
								</button>
							);
						})}
					</aside>

					<main className="flex min-w-0 flex-1 flex-col gap-5 rounded-2xl bg-surface p-7 shadow-card">
						<div className="flex flex-wrap items-center justify-between gap-4">
							<div className="min-w-0">
								<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
									{current.roleLabel}
								</span>
								<h1 className="mt-1 text-[28px] leading-tight font-semibold text-ink">{current.name}</h1>
								<p className="mt-1.5 max-w-3xl text-[15px] leading-relaxed text-ink-muted">
									{current.narrative.text}
								</p>
							</div>
							<div className="flex items-center gap-3">
								<div className="relative size-16">
									<svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={t("dailyPresenter.timeLeft")}>
										<circle cx="32" cy="32" r="27" fill="none" stroke="var(--color-line-soft)" strokeWidth="6" />
										<circle
											cx="32"
											cy="32"
											r="27"
											fill="none"
											stroke={over ? "var(--color-critical)" : "var(--color-accent)"}
											strokeWidth="6"
											strokeLinecap="round"
											strokeDasharray={ring}
											strokeDashoffset={ring * (1 - left)}
											transform="rotate(-90 32 32)"
										/>
									</svg>
									<span
										className={clsx(
											"absolute inset-0 flex items-center justify-center font-mono text-[14px] font-semibold tabular-nums",
											over ? "text-critical" : "text-ink",
										)}
									>
										{clock(elapsed)}
									</span>
								</div>
								<Button icon={paused ? Play : Pause} onClick={() => setPaused(!paused)} title={t("dailyPresenter.pause")} />
							</div>
						</div>

						<div role="tablist" aria-label={t("dailyPresenter.partsLabel")} className="flex flex-wrap gap-1 rounded-xl bg-raised p-1">
							{parts.map((entry, position) => (
								<button
									key={entry.title}
									type="button"
									role="tab"
									aria-selected={position === part}
									onClick={() => setPart(position)}
									className={clsx(
										"focus-ring min-h-10 flex-1 rounded-lg px-3 text-[13.5px] font-semibold",
										position === part ? "bg-surface text-ink shadow-card" : "text-ink-muted hover:text-ink",
									)}
								>
									{entry.title} <span className="font-mono text-[11.5px] text-ink-muted">{entry.lines.length}</span>
								</button>
							))}
						</div>

						<div className="flex min-h-[220px] flex-col gap-3">
							{shown && shown.lines.length === 0 ? <p className="text-[15px] text-ink-muted">{shown.empty}</p> : null}
							{shown?.lines.map((line) => (
								<div key={line.key} className="flex flex-col gap-1.5 rounded-xl bg-raised px-5 py-4">
									<span
										className={clsx(
											"text-[19px] leading-snug font-semibold",
											line.tone === "critical" ? "text-critical" : line.tone === "warning" ? "text-warning" : "text-ink",
										)}
									>
										{line.title}
									</span>
									{line.detail ? <span className="text-[15px] leading-relaxed text-ink-muted">{line.detail}</span> : null}
									{line.links.length > 0 ? (
										<span className="flex flex-wrap gap-2">
											{line.links.map((link) => (
												<button
													key={link.url}
													type="button"
													onClick={() => void api.system.openUrl(link.url).catch(() => undefined)}
													className="focus-ring inline-flex items-center gap-1 rounded font-mono text-[12.5px] text-accent hover:underline"
												>
													{link.label} <ExternalLink size={11} />
												</button>
											))}
										</span>
									) : null}
								</div>
							))}
							{part === 1
 && current.activeTickets.length > 0 ? (
								<div className="flex flex-wrap gap-1.5">
									{current.activeTickets.slice(0, 6).map((ticket) => (
										<PriorityBadge key={ticket.identifier} priority={ticket.priority} label={ticket.priorityLabel} />
									))}
								</div>
							) : null}
						</div>

						<div className="mt-auto flex flex-wrap items-center justify-between gap-2">
							<Button icon={ChevronLeft} onClick={backward} disabled={index === 0 && part === 0}>
								{t("dailyPresenter.nav.previous")}
							</Button>
							<Button variant="solid" onClick={forward}>
								{part < parts.length - 1
									? t("dailyPresenter.nav.nextPart")
									: index < speakers.length - 1
										? t("dailyPresenter.nav.nextSpeaker")
										: t("dailyPresenter.nav.finish")}
								<ChevronRight size={14} />
							</Button>
						</div>
					</main>

					<aside aria-label={t("dailyPresenter.sideLabel")} className="flex w-[300px] shrink-0 flex-col gap-4 self-start">
						<section className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-card">
							<span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								{t("dailyPresenter.pledge.title", { name: current.name })}
							</span>
							{pledge?.text ? (
								<div className="flex flex-col gap-2.5 rounded-xl border border-line-soft p-3">
									<span className="text-[14px] leading-snug font-semibold text-ink">{pledge.text}</span>
									<div role="group" aria-label={t("dailyPresenter.pledge.status")} className="flex flex-wrap gap-1.5">
										{(["done", "ongoing", "postponed"] as const).map((status) => (
											<button
												key={status}
												type="button"
												aria-pressed={pledge.status === status}
												onClick={() => setStatus(status)}
												className={clsx(
													"focus-ring h-9 rounded-lg px-3 text-[12.5px] font-semibold",
													pledge.status === status
														? status === "done"
															? "bg-accent-dim text-accent"
															: status === "ongoing"
																? "bg-info/12 text-info"
																: "bg-warning/15 text-warning"
														: "border border-line text-ink-muted hover:text-ink",
												)}
											>
												{statusLabel(status)}
											</button>
										))}
									</div>
								</div>
							) : (
								<p className="text-[13px] text-ink-muted">{t("dailyPresenter.pledge.none")}</p>
							)}
							<input
								ref={pledgeRef}
								value={nextPledge}
								onChange={(event) => setNextPledge(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") savePledge();
								}}
								placeholder={t("dailyPresenter.pledge.placeholder")}
								className="focus-ring h-10 w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-ink"
							/>
						</section>
						<section className="flex flex-col gap-2.5 rounded-2xl bg-surface p-4 shadow-card">
							<span className="flex items-center justify-between text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								{t("dailyPresenter.parked.title")}
								{parked.length > 0 ? <Badge tone="accent">{parked.length}</Badge> : null}
							</span>
							{parked.map((entry, position) => (
								<span key={position} className="text-[12.5px] text-ink">
									{entry.subject} <span className="text-ink-muted">· {entry.member}</span>
								</span>
							))}
							<div className="flex gap-1.5">
								<input
									ref={inputRef}
									value={subject}
									onChange={(event) => setSubject(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") park();
									}}
									placeholder={t("dailyPresenter.parked.placeholder")}
									className="focus-ring h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink"
								/>
								<Button icon={Plus} onClick={park} disabled={!subject.trim()} title={t("dailyPresenter.parked.add")} />
							</div>
						</section>
						<p className="px-1 text-[11px] text-ink-muted">{t("dailyPresenter.shortcuts")}</p>
					</aside>
				</div>
			) : (
				<div className="flex flex-1 items-center justify-center">
					<p className="text-[13px] text-ink-muted">{t("dailyPresenter.noDevelopers")}</p>
				</div>
			)}
		</div>
	);
}
