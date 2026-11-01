import clsx from "clsx";
import { Pencil, Play, Plus, RotateCcw, Terminal, Trash2, Wand2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Badge, Button, Field, Spinner, TextInput } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { Prompt } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useAgentActions } from "@/app/agents";
import { useConfirm } from "@/components/Confirm";
import { useCockpit } from "@/app/store";
import { platformContext } from "@/lib/platform";

const EMPTY: Prompt = { id: "", label: "", group: "", text: "" };

/**
 * Actions prêtes à lancer sur le dossier d'une session.
 *
 * Les enchaînements qu'on retape à longueur de journée (« si c'est vert, commit
 * et push », « traite les retours CodeRabbit ») deviennent un clic, qui ouvre un
 * agent dans le worktree avec le prompt déjà écrit. Chaque entrée reste
 * modifiable : la bibliothèque livrée n'est qu'un point de départ.
 */
export function PromptLauncher({ cwd, onClose }: { cwd: string; onClose: () => void }) {
	const { t } = useTranslation("components2");
	const { notify } = useCockpit();
	const { confirm } = useConfirm();
	const { open: openAgent } = useAgentActions();
	const prompts = useAsync(() => api.prompts.list(), []);
	const [editing, setEditing] = useState<Prompt | null>(null);
	const [busy, setBusy] = useState(false);

	const groups = useMemo(() => {
		const map = new Map<string, Prompt[]>();
		for (const prompt of prompts.data ?? []) {
			const key = prompt.group || t("promptLauncher.myPrompts");
			map.set(key, [...(map.get(key) ?? []), prompt]);
		}
		return [...map.entries()];
	}, [prompts.data, t]);

	// Par défaut on reste dans le cockpit ; Terminal.app devient le recours
	// pour ce qui exige une vraie interactivité.
	const launch = (prompt: Prompt) => {
		openAgent(cwd, prompt.text);
		onClose();
	};

	const launchInTerminal = async (prompt: Prompt) => {
		setBusy(true);
		try {
			await api.prompts.launch(cwd, prompt.text);
			notify(t("promptLauncher.openedInTerminal", { label: prompt.label }));
			onClose();
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const save = async () => {
		if (!editing) return;
		try {
			await api.prompts.save(editing);
			setEditing(null);
			prompts.reload();
			notify(t("promptLauncher.saved"));
		} catch (error) {
			notify(String(error));
		}
	};

	const remove = async (prompt: Prompt) => {
		const ok = await confirm({
			title: t("promptLauncher.deleteTitle", { label: prompt.label }),
			confirmLabel: t("promptLauncher.delete"),
			danger: true,
		});
		if (!ok) return;
		try {
			await api.prompts.remove(prompt.id);
			prompts.reload();
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<div className="animate-in fixed inset-0 z-40 flex items-start justify-center bg-overlay/70 p-10">
			<div className="panel flex max-h-full w-full max-w-2xl flex-col overflow-hidden shadow-2xl shadow-black/50">
				<div className="hairline-b flex items-center gap-2 px-4 py-2.5">
					<Wand2 size={13} className="text-accent-soft" />
					<span className="text-[12.5px] font-semibold text-ink">{t("promptLauncher.title")}</span>
					<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
						{cwd}
					</span>
					<Button
						size="sm"
						icon={RotateCcw}
						title={t("promptLauncher.reset")}
						onClick={() => {
							void api.prompts
								.reset()
								.then(() => prompts.reload())
								.catch((error) => notify(String(error)));
						}}
					/>
					<Button size="sm" icon={X} onClick={onClose} />
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto p-3">
					{prompts.loading && !prompts.data ? (
						<div className="flex justify-center py-8">
							<Spinner />
						</div>
					) : null}

					{editing ? (
						<div className="flex flex-col gap-2">
							<Field label={t("promptLauncher.label")}>
								<TextInput
									value={editing.label}
									onChange={(label) => setEditing({ ...editing, label })}
									placeholder={t("promptLauncher.labelPlaceholder")}
								/>
							</Field>
							<Field label={t("promptLauncher.group")} hint={t("promptLauncher.groupHint")}>
								<TextInput
									value={editing.group}
									onChange={(group) => setEditing({ ...editing, group })}
								/>
							</Field>
							<Field label={t("promptLauncher.text")}>
								<textarea
									value={editing.text}
									onChange={(event) => setEditing({ ...editing, text: event.target.value })}
									rows={8}
									className="focus-ring text-selectable w-full rounded-lg border border-line-soft bg-void p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted"
								/>
							</Field>
							<div className="flex justify-end gap-1.5">
								<Button onClick={() => setEditing(null)}>{t("promptLauncher.cancel")}</Button>
								<Button variant="solid" onClick={() => void save()}>
									{t("promptLauncher.save")}
								</Button>
							</div>
						</div>
					) : (
						<div className="flex flex-col gap-3">
							{groups.map(([group, list]) => (
								<div key={group}>
									<div className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										{group}
									</div>
									<div className="flex flex-col gap-1">
										{list.map((prompt) => (
											<div
												key={prompt.id}
												className={clsx(
													"group flex items-start gap-2 rounded-lg px-2 py-1.5",
													"hover:bg-surface",
												)}
											>
												<button
													type="button"
													disabled={busy}
													onClick={() => void launch(prompt)}
													className="min-w-0 flex-1 text-left"
												>
													<div className="flex items-center gap-1.5">
														<Play size={10} className="shrink-0 text-accent-soft" />
														<span className="truncate text-[12.5px] font-medium text-ink">
															{prompt.label}
														</span>
													</div>
													<p className="mt-0.5 line-clamp-2 pl-4 text-[10px] leading-snug text-ink-faint">
														{prompt.text}
													</p>
												</button>
												<Button
													size="sm"
													icon={Terminal}
													title={t("promptLauncher.openInTerminal", { context: platformContext })}
													disabled={busy}
													onClick={() => void launchInTerminal(prompt)}
												/>
												<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
													<Button
														size="sm"
														icon={Pencil}
														onClick={() => setEditing(prompt)}
													/>
													<Button
														size="sm"
														icon={Trash2}
														onClick={() => void remove(prompt)}
													/>
												</div>
											</div>
										))}
									</div>
								</div>
							))}

							<Button icon={Plus} onClick={() => setEditing({ ...EMPTY })}>
								{t("promptLauncher.new")}
							</Button>

							<p className="px-1 text-[10px] leading-relaxed text-ink-faint">
								<Trans
									t={t}
									i18nKey="promptLauncher.footer"
									context={platformContext}
									values={{ path: "~/.config/cockpit/prompts.toml" }}
									components={{ path: <Badge mono>{null}</Badge> }}
								/>
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
