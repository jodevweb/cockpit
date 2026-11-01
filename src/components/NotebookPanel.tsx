import clsx from "clsx";
import {
	BookMarked,
	ChevronDown,
	ChevronRight,
	Plus,
	RefreshCw,
	Sparkles,
	Trash2,
	X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Empty, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { Handback, Lesson } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

/**
 * Ce que ce dépôt a déjà eu à corriger derrière un agent.
 *
 * Deux listes, dans cet ordre : ce qui attend d'être lu, puis ce qui a été
 * retenu. L'ordre n'est pas neutre — une reprise non lue est du travail qui se
 * perd, une leçon retenue travaille déjà toute seule.
 *
 * Rien n'entre ici sans un clic. L'agent propose un texte, on le corrige, on le
 * garde ou on le jette. Une mémoire qui se remplirait toute seule deviendrait
 * une consigne permanente que personne n'a écrite.
 */
export function NotebookPanel({
	project,
	onClose,
}: {
	project: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("components3");
	const { notify } = useCockpit();
	const [lessons, setLessons] = useState<Lesson[] | null>(null);
	const [handbacks, setHandbacks] = useState<Handback[] | null>(null);
	const [drafting, setDrafting] = useState<string | null>(null);
	/** La leçon en cours d'écriture — proposée par un agent, ou partie de rien. */
	const [draft, setDraft] = useState<Lesson | null>(null);

	const loaded = useAsync(async () => {
		const [list, pending] = await Promise.all([
			api.notebook.lessons(project),
			api.notebook.handbacks(project),
		]);
		setLessons(list);
		setHandbacks(pending);
		return true;
	}, [project]);

	const list = lessons ?? [];
	const pending = handbacks ?? [];

	const propose = async (id: string) => {
		setDrafting(id);
		try {
			setDraft(await api.notebook.draft(id));
		} catch (error) {
			// « Rien à retenir » est une réponse, pas une panne : le dire ainsi
			// évite de faire chercher une erreur là où il n'y en a pas.
			notify(String(error));
		} finally {
			setDrafting(null);
		}
	};

	const keep = async (lesson: Lesson) => {
		try {
			setLessons(await api.notebook.save(lesson));
			setDraft(null);
			notify(t("notebookPanel.kept"));
		} catch (error) {
			notify(String(error));
		}
	};

	const drop = async (id: string) => {
		try {
			setLessons(await api.notebook.forget(id));
		} catch (error) {
			notify(String(error));
		}
	};

	const dismiss = async (id: string) => {
		try {
			setHandbacks(await api.notebook.dismiss(id));
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<div className="animate-in fixed inset-0 z-40 flex items-start justify-center bg-overlay/70 p-10">
			<div className="panel flex max-h-full w-full max-w-3xl flex-col overflow-hidden shadow-2xl shadow-black/50">
				<div className="hairline-b flex items-center gap-2 px-4 py-2.5">
					<BookMarked size={13} className="shrink-0 text-accent-soft" />
					<span className="text-[12.5px] font-semibold text-ink">{t("notebookPanel.title")}</span>
					<span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
						{t("notebookPanel.subtitle")}
					</span>
					{loaded.loading ? <Spinner /> : null}
					<Button size="sm" icon={RefreshCw} onClick={loaded.reload} title={t("notebookPanel.reload")} />
					<Button size="sm" icon={X} onClick={onClose} title={t("notebookPanel.close")} />
				</div>

				<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
					{pending.length > 0 ? (
						<section className="flex flex-col gap-2">
							<h3 className="text-[11px] font-semibold tracking-[0.06em] text-warning uppercase">
								{t("notebookPanel.pending", { count: pending.length })}
							</h3>
							<p className="text-[11px] leading-relaxed text-ink-faint">
								{t("notebookPanel.pendingHint")}
							</p>
							{pending.map((entry) => (
								<HandbackCard
									key={entry.id}
									handback={entry}
									drafting={drafting === entry.id}
									onDraft={() => void propose(entry.id)}
									onDismiss={() => void dismiss(entry.id)}
								/>
							))}
						</section>
					) : null}

					{draft ? (
						<DraftForm
							draft={draft}
							onChange={setDraft}
							onKeep={() => void keep(draft)}
							onCancel={() => setDraft(null)}
						/>
					) : null}

					<section className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							<h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
								{t("notebookPanel.lessons", { count: list.length })}
							</h3>
							<Button
								size="sm"
								icon={Plus}
								className="ml-auto"
								onClick={() =>
									setDraft({
										id: "",
										text: "",
										scope: [],
										source: "main",
										project,
										at: 0,
										uses: 0,
										lastUsed: 0,
									})
								}
							>
								{t("notebookPanel.write")}
							</Button>
						</div>

						{list.length === 0 ? (
							<Empty
								icon={BookMarked}
								message={t("notebookPanel.empty")}
								hint={t("notebookPanel.emptyHint")}
							/>
						) : (
							list.map((lesson) => (
								<LessonCard
									key={lesson.id}
									lesson={lesson}
									onEdit={() => setDraft(lesson)}
									onDrop={() => void drop(lesson.id)}
								/>
							))
						)}
					</section>
				</div>
			</div>
		</div>
	);
}

/** Sans emploi depuis deux mois : à relire, ou à retirer. */
function isStale(lesson: Lesson): boolean {
	const reference = lesson.lastUsed > 0 ? lesson.lastUsed : lesson.at;
	if (reference === 0) return false;
	return Date.now() / 1000 - reference > 60 * 86_400;
}

function HandbackCard({
	handback,
	drafting,
	onDraft,
	onDismiss,
}: {
	handback: Handback;
	drafting: boolean;
	onDraft: () => void;
	onDismiss: () => void;
}) {
	const { t } = useTranslation("components3");
	const [open, setOpen] = useState(false);
	return (
		<article className="rounded-[var(--radius-panel)] border border-warning/30 bg-warning/[0.05] p-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-[11px] text-ink">{handback.branch || t("notebookPanel.noBranch")}</span>
				<span className="text-[10px] text-ink-faint">
					{t("notebookPanel.filesReworked", { count: handback.files.length })}
				</span>
				<span className="ml-auto flex items-center gap-1.5">
					<Button size="sm" icon={Sparkles} loading={drafting} onClick={onDraft}>
						{t("notebookPanel.draftLesson")}
					</Button>
					<Button
						size="sm"
						icon={X}
						onClick={onDismiss}
						title={t("notebookPanel.dismissHandback")}
					/>
				</span>
			</div>

			<p className="mt-1.5 font-mono text-[10px] break-all text-ink-faint">
				{handback.files.slice(0, 6).join(" · ")}
				{handback.files.length > 6 ? ` · +${handback.files.length - 6}` : ""}
			</p>

			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="focus-ring mt-1.5 flex items-center gap-1 rounded text-[10.5px] text-ink-faint transition-colors hover:text-ink"
			>
				{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
				{open ? t("notebookPanel.collapse") : t("notebookPanel.showPatch")}
			</button>
			{open ? (
				<pre className="text-selectable mt-1.5 max-h-64 overflow-auto rounded-lg border border-line-soft bg-void px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-muted">
					{handback.patch}
				</pre>
			) : null}
		</article>
	);
}

function DraftForm({
	draft,
	onChange,
	onKeep,
	onCancel,
}: {
	draft: Lesson;
	onChange: (lesson: Lesson) => void;
	onKeep: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("components3");
	return (
		<section className="rounded-[var(--radius-panel)] border border-accent/40 bg-accent/[0.06] p-3">
			<h3 className="text-[11px] font-semibold tracking-[0.06em] text-accent-soft uppercase">
				{draft.id ? t("notebookPanel.editLesson") : t("notebookPanel.newLesson")}
			</h3>
			<p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
				{t("notebookPanel.draftHint")}
			</p>

			<textarea
				value={draft.text}
				onChange={(event) => onChange({ ...draft, text: event.target.value })}
				rows={3}
				placeholder={t("notebookPanel.textPlaceholder")}
				className="focus-ring text-selectable mt-2 w-full resize-none rounded-lg border border-line-soft bg-void px-2.5 py-2 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint"
			/>

			<label className="mt-2 block">
				<span className="text-[10px] tracking-wide text-ink-faint uppercase">
					{t("notebookPanel.scope")}
				</span>
				<input
					value={draft.scope.join(", ")}
					onChange={(event) =>
						onChange({
							...draft,
							scope: event.target.value
								.split(",")
								.map((part) => part.trim())
								.filter(Boolean),
						})
					}
					placeholder="apps/api, packages/db"
					className="focus-ring mt-1 h-7 w-full rounded-lg border border-line-soft bg-void px-2 font-mono text-[11px] text-ink placeholder:text-ink-faint"
				/>
			</label>

			<div className="mt-2.5 flex justify-end gap-1.5">
				<Button size="sm" onClick={onCancel}>
					{t("notebookPanel.cancel")}
				</Button>
				<Button size="sm" variant="solid" onClick={onKeep} disabled={!draft.text.trim()}>
					{t("notebookPanel.keep")}
				</Button>
			</div>
		</section>
	);
}

function LessonCard({
	lesson,
	onEdit,
	onDrop,
}: {
	lesson: Lesson;
	onEdit: () => void;
	onDrop: () => void;
}) {
	const { t } = useTranslation("components3");
	const stale = isStale(lesson);
	return (
		<article
			className={clsx(
				"group relative rounded-[var(--radius-panel)] border bg-surface p-3",
				stale ? "border-line-soft opacity-70" : "border-line-soft",
			)}
		>
			<p className="text-selectable pr-16 text-[12px] leading-relaxed text-ink">
				{lesson.text}
			</p>

			<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="font-mono text-[10px] text-ink-faint">
					{lesson.scope.length > 0 ? lesson.scope.join(" · ") : t("notebookPanel.wholeRepo")}
				</span>
				<span className="text-[10px] text-ink-faint">
					{lesson.uses === 0
						? t("notebookPanel.neverUsed")
						: t("notebookPanel.uses", { count: lesson.uses })}
				</span>
				{lesson.source === "reprise" ? (
					<span className="text-[10px] text-ink-faint">{t("notebookPanel.fromHandback")}</span>
				) : null}
				{/* Signalée, jamais effacée d'office : on ne veut pas découvrir
				    qu'une règle a disparu sans savoir laquelle ni pourquoi. */}
				{stale ? (
					<span className="text-[10px] text-warning">
						{t("notebookPanel.stale")}
					</span>
				) : null}
			</div>

			{/* En superposition : réservées dans le flux, ces actions rogneraient le
			    texte de la leçon de moitié. */}
			<div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
				<Button size="sm" onClick={onEdit} title={t("notebookPanel.correct")}>
					{t("notebookPanel.edit")}
				</Button>
				<Button size="sm" icon={Trash2} variant="danger" onClick={onDrop} title={t("notebookPanel.forget")} />
			</div>
		</article>
	);
}
