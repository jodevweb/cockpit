import clsx from "clsx";
import { Bot, Inbox, ListChecks, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAgentActions } from "@/app/agents";
import { freezes, useDecisions, waitedSince, type Decision } from "@/app/decisions";
import { useCockpit } from "@/app/store";
import { FilmStrip } from "@/components/Film";
import { Markdown } from "@/components/Markdown";
import { Button, KeyHint } from "@/components/ui";
import { filmOf } from "@/lib/film";
import { shortPath } from "@/lib/format";
import { t } from "@/i18n";

/**
 * Ce qui attend ta décision, en une file.
 *
 * Une décision à la fois, en grand, avec ce qu'il faut pour trancher sans
 * rouvrir la conversation : la question, ses options en cartes, ce que l'agent
 * a fait juste avant (le film de son tour). Le clavier suffit — un chiffre
 * choisit, ↑ ↓ passe d'une décision à l'autre — parce qu'on répond ici entre
 * deux choses, pas en s'installant.
 */

function kindLabel(kind: Decision["kind"]): string {
	return t(`views:decisions.kind.${kind}`);
}

const KIND_ICONS = {
	question: MessageCircleQuestion,
	permission: ShieldQuestion,
	reply: Bot,
	plan: ListChecks,
};

/** `<Trans>` injecte le texte de la touche : `KeyHint` l'exige à la déclaration. */
function Key({ children }: { children?: ReactNode }) {
	return <KeyHint>{children}</KeyHint>;
}

function titleOf(decision: Decision): string {
	switch (decision.kind) {
		case "question":
			return decision.questions[0]?.question || t("views:decisions.aQuestion");
		case "permission":
			return t("views:decisions.useTool", { tool: decision.request.tool });
		case "reply":
			return lastQuestion(decision.text);
		case "plan":
			return decision.mission.title;
	}
}

/** La phrase qui pose la question, au bout du message. */
function lastQuestion(text: string): string {
	const sentences = text
		.replace(/[*_`#>]+/g, "")
		.split(/(?<=[.!?…])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	return [...sentences].reverse().find((sentence) => sentence.endsWith("?")) ?? sentences.at(-1) ?? "";
}

function whoOf(decision: Decision): string {
	return decision.kind === "plan" ? t("views:decisions.mission") : decision.run.label;
}

/** Ce qu'une autorisation demande, dit en une ligne. */
function requestSummary(input: unknown): string {
	const value = (input ?? {}) as Record<string, unknown>;
	for (const key of ["command", "file_path", "url", "path", "pattern"]) {
		if (typeof value[key] === "string" && value[key]) return String(value[key]);
	}
	return JSON.stringify(input).slice(0, 220);
}

export function DecisionsView() {
	const { t } = useTranslation("views");
	const decisions = useDecisions();
	const [selected, setSelected] = useState<string | null>(null);
	const current = decisions.find((decision) => decision.key === selected) ?? decisions[0] ?? null;
	const index = current ? decisions.indexOf(current) : -1;
	const now = Date.now();
	const oldest = decisions.reduce<number | null>((min, decision) => (min === null || decision.since < min ? decision.since : min), null);

	// ↑ ↓ (ou j k) : d'une décision à l'autre, sans la souris.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target && /INPUT|TEXTAREA/.test(target.tagName)) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
			if (!step || decisions.length === 0) return;
			event.preventDefault();
			const next = decisions[Math.min(decisions.length - 1, Math.max(0, index + step))];
			setSelected(next.key);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [decisions, index]);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-6 pt-5 pb-3">
				<h1 className="m-0 text-[20px] font-semibold text-ink">{t("decisions.title")}</h1>
				<span className="text-[13px] text-ink-muted">
					{decisions.length === 0
						? t("decisions.nothingWaiting")
							: t("decisions.summary", { count: decisions.length, since: waitedSince(oldest ?? now, now) })}
				</span>
				<span className="ml-auto flex items-center gap-2 text-[11.5px] text-ink-faint">
					<Trans
						t={t}
						i18nKey="decisions.keys"
						components={{ up: <Key />, down: <Key />, one: <Key />, nine: <Key />, back: <Key /> }}
					/>
				</span>
			</header>

			{decisions.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
					<span className="grid size-12 place-items-center rounded-2xl bg-accent-dim text-accent">
						<Inbox size={20} />
					</span>
					<p className="max-w-md text-[13px] leading-relaxed text-ink-muted">
						{t("decisions.empty")}
					</p>
				</div>
			) : (
				<div className="flex flex-wrap items-start gap-5 px-6 pb-6">
					<aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-2 lg:max-w-[400px]">
						{decisions.map((decision, position) => {
							const Icon = KIND_ICONS[decision.kind];
							const on = decision === current;
							return (
								<button
									key={decision.key}
									type="button"
									onClick={() => setSelected(decision.key)}
									className={clsx(
										"focus-ring flex gap-3 rounded-2xl bg-surface p-3.5 text-left transition-shadow",
										on ? "shadow-[0_0_0_2px_var(--color-accent),var(--shadow-card)]" : "shadow-card hover:shadow-pop",
									)}
								>
									<span
										className={clsx(
											"grid size-8 shrink-0 place-items-center rounded-lg",
											freezes(decision) ? "bg-warning/15 text-warning" : "bg-raised text-ink-muted",
										)}
									>
										<Icon size={15} />
									</span>
									<span className="flex min-w-0 flex-1 flex-col gap-1">
										<span className="line-clamp-2 text-[13.5px] leading-snug font-semibold text-ink">{titleOf(decision)}</span>
										<span className="truncate text-[11.5px] text-ink-muted">
											{whoOf(decision)} · {kindLabel(decision.kind)}
										</span>
										<span className="flex flex-wrap gap-1.5">
											{freezes(decision) ? (
												<span className="rounded-md bg-warning/12 px-2 py-0.5 text-[10.5px] font-semibold text-warning">
													{decision.kind === "plan" ? t("decisions.blocksTasks", { count: decision.unblocks }) : t("decisions.agentStopped")}
												</span>
											) : null}
											<span className="rounded-md bg-raised px-2 py-0.5 text-[10.5px] text-ink-muted">{waitedSince(decision.since, now)}</span>
										</span>
									</span>
									<span className="font-mono text-[11px] text-ink-faint">{position + 1}</span>
								</button>
							);
						})}
					</aside>

					{current ? (
						<section className="flex min-w-0 flex-[999_1_560px] flex-col gap-4 rounded-2xl bg-surface p-5 shadow-card">
							<DecisionDetail key={current.key} decision={current} />
						</section>
					) : null}
				</div>
			)}
		</div>
	);
}

function DecisionDetail({ decision }: { decision: Decision }) {
	const { t } = useTranslation("views");
	const { show } = useAgentActions();
	const { go } = useCockpit();
	const film = useMemo(
		() => (decision.kind !== "plan" && decision.episode ? filmOf(decision.episode, decision.run.cwd) : null),
		[decision],
	);
	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-[12px] text-ink-muted">
					{whoOf(decision)}
					{decision.kind !== "plan" ? ` · ${shortPath(decision.run.cwd, 2)}` : ""}
				</span>
				<span className="flex-1" />
				<span className="rounded-full bg-warning/12 px-2.5 py-0.5 text-[11px] font-semibold text-warning">
					{waitedSince(decision.since)}
				</span>
				{decision.kind === "plan" ? (
					<Button size="sm" onClick={() => go("missions", { missionId: decision.mission.id })}>
						{t("decisions.openMission")}
					</Button>
				) : (
					<Button size="sm" onClick={() => show(decision.run.id)}>
						{t("decisions.openConversation")}
					</Button>
				)}
			</div>
			{decision.kind === "question" ? <QuestionDecision decision={decision} /> : null}
			{decision.kind === "permission" ? <PermissionDecision decision={decision} /> : null}
			{decision.kind === "reply" ? <ReplyDecision decision={decision} /> : null}
			{decision.kind === "plan" ? (
				<div className="flex flex-col gap-2">
					<h2 className="m-0 text-[20px] leading-tight font-semibold text-ink">{decision.mission.title}</h2>
					<p className="m-0 text-[13px] text-ink-muted">{decision.detail}</p>
					{decision.mission.tasks.length > 0 ? (
						<ol className="m-0 flex list-none flex-col gap-1.5 p-0">
							{decision.mission.tasks.map((task, index) => (
								<li key={task.id} className="flex gap-2 text-[13px] text-ink">
									<span className="font-mono text-[11px] text-ink-faint">{index + 1}</span>
									{task.title}
								</li>
							))}
						</ol>
					) : null}
				</div>
			) : null}
			{film && film.frames.length >= 2 ? (
				<div className="border-t border-line-soft pt-3">
					<p className="m-0 mb-2 text-[11.5px] text-ink-muted">{t("decisions.beforeAsking")}</p>
					<FilmStrip film={film} />
				</div>
			) : null}
		</>
	);
}

/** Les chiffres choisissent : la touche « 1 » prend la première option. */
function useDigits(count: number, onPick: (index: number) => void) {
	const pick = useRef(onPick);
	pick.current = onPick;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target && /INPUT|TEXTAREA/.test(target.tagName)) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const digit = Number(event.key);
			if (!Number.isInteger(digit) || digit < 1 || digit > count) return;
			event.preventDefault();
			pick.current(digit - 1);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [count]);
}

function OptionCard({
	index,
	label,
	description,
	selected,
	onPick,
}: {
	index: number;
	label: string;
	description?: string;
	selected?: boolean;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onPick}
			className={clsx(
				"focus-ring flex flex-col gap-1.5 rounded-xl p-3.5 text-left transition-shadow",
				selected ? "bg-accent-dim/60 shadow-[0_0_0_2px_var(--color-accent)]" : "bg-raised hover:shadow-[0_0_0_1px_var(--color-line)]",
			)}
		>
			<span className="flex items-center justify-between gap-2">
				<span className="text-[14px] leading-snug font-semibold text-ink">{label}</span>
				<span className={clsx("rounded-md px-1.5 py-0.5 font-mono text-[11px]", selected ? "bg-accent text-accent-ink" : "bg-surface text-ink-muted")}>
					{index + 1}
				</span>
			</span>
			{description ? <span className="text-[12px] leading-snug text-ink-muted">{description}</span> : null}
		</button>
	);
}

function QuestionDecision({ decision }: { decision: Extract<Decision, { kind: "question" }> }) {
	const { t } = useTranslation("views");
	const { answer, decide } = useAgentActions();
	const [step, setStep] = useState(0);
	const [picked, setPicked] = useState<Array<{ header: string; choice: string }>>([]);
	const [custom, setCustom] = useState("");
	const question = decision.questions[step];

	const choose = (label: string) => {
		if (!question) return;
		const next = [...picked.filter((entry) => entry.header !== question.header), { header: question.header, choice: label }];
		setPicked(next);
		// La dernière question tranchée part d'elle-même : aucun clic de plus.
		if (step >= decision.questions.length - 1) answer(decision.request.id, next);
		else setStep(step + 1);
	};
	useDigits(question?.options.length ?? 0, (index) => {
		const option = question?.options[index];
		if (option) choose(option.label);
	});

	if (!question) return null;
	return (
		<div className="flex flex-col gap-3">
			{decision.questions.length > 1 ? (
				<span className="text-[11px] font-semibold tracking-wide text-warning uppercase">
					{t("decisions.question.step", { step: step + 1, total: decision.questions.length, header: question.header })}
				</span>
			) : (
				<span className="text-[11px] font-semibold tracking-wide text-warning uppercase">{question.header}</span>
			)}
			<h2 className="m-0 text-[20px] leading-tight font-semibold text-ink">{question.question}</h2>
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{question.options.map((option, index) => (
					<OptionCard
						key={option.label}
						index={index}
						label={option.label}
						description={option.description}
						selected={picked.some((entry) => entry.header === question.header && entry.choice === option.label)}
						onPick={() => choose(option.label)}
					/>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<input
					value={custom}
					onChange={(event) => setCustom(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && custom.trim()) {
							answer(decision.request.id, [...picked, { header: "Clarification", choice: custom.trim() }]);
						}
					}}
					placeholder={t("decisions.question.customPlaceholder")}
					className="focus-ring min-w-0 flex-1 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
				/>
				<Button
					size="sm"
					onClick={() =>
						decide(
							decision.request.id,
							false,
							"The user skipped the question: move on with what you know, or ask them in your reply.",
						)
					}
					title={t("decisions.question.skipHint")}
				>
					{t("decisions.question.skip")}
				</Button>
			</div>
		</div>
	);
}

function PermissionDecision({ decision }: { decision: Extract<Decision, { kind: "permission" }> }) {
	const { t } = useTranslation("views");
	const { decide } = useAgentActions();
	useDigits(2, (index) => decide(decision.request.id, index === 0));
	return (
		<div className="flex flex-col gap-3">
			<span className="text-[11px] font-semibold tracking-wide text-warning uppercase">{t("decisions.permission.label")}</span>
			<h2 className="m-0 text-[20px] leading-tight font-semibold text-ink">
				<Trans
					t={t}
					i18nKey="decisions.permission.wantsTool"
					values={{ tool: decision.request.tool }}
					components={{ tool: <span className="font-mono text-[18px]" /> }}
				/>
			</h2>
			<code className="block max-h-48 overflow-auto rounded-lg bg-raised px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap text-ink">
				{requestSummary(decision.request.input)}
			</code>
			<div className="grid gap-3 sm:grid-cols-2">
				<OptionCard index={0} label={t("decisions.permission.allow")} description={t("decisions.permission.allowHint")} onPick={() => decide(decision.request.id, true)} />
				<OptionCard index={1} label={t("decisions.permission.deny")} description={t("decisions.permission.denyHint")} onPick={() => decide(decision.request.id, false)} />
			</div>
		</div>
	);
}

function ReplyDecision({ decision }: { decision: Extract<Decision, { kind: "reply" }> }) {
	const { t } = useTranslation("views");
	const { send } = useAgentActions();
	const [draft, setDraft] = useState("");
	const [whole, setWhole] = useState(false);
	const reply = (text: string) => {
		if (!text.trim()) return;
		send(decision.run.id, text.trim(), { follows: true });
		setDraft("");
	};
	useDigits(decision.options.length, (index) => reply(t("decisions.reply.option", { number: index + 1, option: decision.options[index] })));
	const question = lastQuestion(decision.text);
	return (
		<div className="flex flex-col gap-3">
			<span className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">{t("decisions.reply.label")}</span>
			<h2 className="m-0 text-[20px] leading-tight font-semibold text-ink">{question}</h2>
			{decision.options.length > 0 ? (
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{decision.options.map((option, index) => (
						<OptionCard key={option} index={index} label={option} onPick={() => reply(t("decisions.reply.option", { number: index + 1, option }))} />
					))}
				</div>
			) : null}
			<button
				type="button"
				onClick={() => setWhole((value) => !value)}
				className="focus-ring self-start rounded text-[12px] font-medium text-accent hover:text-accent-soft"
			>
				{whole ? t("decisions.reply.collapse") : t("decisions.reply.expand")}
			</button>
			{whole ? (
				<div className="max-h-80 overflow-y-auto rounded-lg bg-raised p-3">
					<Markdown source={decision.text} cwd={decision.run.cwd} />
				</div>
			) : null}
			<div className="flex items-end gap-2">
				<textarea
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							reply(draft);
						}
					}}
					rows={2}
					placeholder={t("decisions.reply.placeholder")}
					className="focus-ring min-w-0 flex-1 resize-none rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
				/>
				<Button variant="solid" disabled={!draft.trim()} onClick={() => reply(draft)}>
					{t("decisions.reply.send")}
				</Button>
			</div>
		</div>
	);
}
