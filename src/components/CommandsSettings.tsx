import clsx from "clsx";
import {
	AlertOctagon,
	ChevronDown,
	ChevronRight,
	FolderInput,
	Plus,
	SquareTerminal,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Empty, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { RepoCommand } from "@/lib/types";
import { useCockpit } from "@/app/store";

/**
 * Les commandes maison de ce dépôt.
 *
 * Elles vivaient dans le binaire, écrites pour une seule équipe : personne
 * d'autre ne pouvait les changer, ni même les voir. Elles se déclarent
 * maintenant ici, et rien n'est fourni par défaut à une installation neuve.
 *
 * Le bouton de détection lit ce que le dépôt dit de lui-même — ses scripts —
 * plutôt que de faire tout retaper. C'est ce qui rend l'écran utile ailleurs
 * que chez celui qui l'a écrit.
 *
 * L'édition fine — les options et leurs drapeaux — se fait dans le fichier de
 * configuration, accessible depuis le haut de cet écran : un formulaire à
 * options imbriquées coûterait plus à utiliser qu'à éviter, et ces commandes se
 * touchent une fois par trimestre.
 */
export function CommandsSettings() {
	const { t } = useTranslation("components3");
	const { config, reloadConfig, notify, activeProject } = useCockpit();
	const [draft, setDraft] = useState<RepoCommand[]>([]);
	const [saving, setSaving] = useState(false);
	const [detecting, setDetecting] = useState(false);
	const [found, setFound] = useState<RepoCommand[] | null>(null);

	const repo = activeProject?.mainRepo ?? "";

	useEffect(() => {
		setDraft(config?.commands ?? []);
	}, [config?.commands]);

	const save = async (next: RepoCommand[]) => {
		setSaving(true);
		try {
			await api.config.updateProject({ commands: next });
			reloadConfig();
			notify(t("commandsSettings.saved"));
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	const detect = async () => {
		setDetecting(true);
		try {
			const scripts = await api.repoCommands.detect(repo);
			// Ce qui est déjà déclaré ne se repropose pas : on chercherait ensuite
			// lequel des deux doublons est le bon.
			const known = new Set(draft.map((entry) => entry.id));
			setFound(scripts.filter((entry) => !known.has(entry.id)));
		} catch (error) {
			notify(String(error));
		} finally {
			setDetecting(false);
		}
	};

	const add = (command: RepoCommand) => {
		const next = [...draft, command];
		setDraft(next);
		void save(next);
	};

	const remove = (id: string) => {
		const next = draft.filter((entry) => entry.id !== id);
		setDraft(next);
		void save(next);
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("commandsSettings.intro")}
			</p>

			<div className="panel flex flex-col gap-2 p-3.5">
				{draft.length === 0 ? (
					<Empty
						icon={SquareTerminal}
						message={t("commandsSettings.empty")}
						hint={t("commandsSettings.emptyHint")}
					/>
				) : (
					draft.map((command) => (
						<CommandRow
							key={command.id}
							command={command}
							onRemove={() => remove(command.id)}
						/>
					))
				)}

				<div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2.5">
					<Button
						size="sm"
						icon={FolderInput}
						loading={detecting}
						disabled={!repo}
						onClick={() => void detect()}
						title={t("commandsSettings.detectHint")}
					>
						{t("commandsSettings.detect")}
					</Button>
					<Button
						size="sm"
						icon={Plus}
						onClick={() =>
							add({
								id: `cmd-${Date.now().toString(36)}`,
								group: t("commandsSettings.defaultGroup"),
								label: t("commandsSettings.defaultLabel"),
								description: "",
								base: "",
								positional: null,
								options: [],
								scoped: true,
								danger: false,
							})
						}
					>
						{t("commandsSettings.write")}
					</Button>
					{saving ? <Spinner /> : null}
				</div>
			</div>

			{found ? (
				<div className="panel flex flex-col gap-2 p-3.5">
					<div className="flex items-center gap-2">
						<h4 className="text-[11px] font-semibold tracking-[0.06em] text-accent-soft uppercase">
							{t("commandsSettings.found", { count: found.length })}
						</h4>
						{found.length > 0 ? (
							<Button
								size="sm"
								className="ml-auto"
								onClick={() => {
									const next = [...draft, ...found];
									setDraft(next);
									setFound([]);
									void save(next);
								}}
							>
								{t("commandsSettings.addAll")}
							</Button>
						) : null}
						<Button
							size="sm"
							className={found.length > 0 ? "" : "ml-auto"}
							onClick={() => setFound(null)}
						>
							{t("commandsSettings.close")}
						</Button>
					</div>

					{found.length === 0 ? (
						<p className="text-[11px] text-ink-faint">
							{t("commandsSettings.nothingNew")}
						</p>
					) : (
						found.map((command) => (
							<div
								key={command.id}
								className="flex items-center gap-2 rounded-[var(--radius-panel)] border border-line-soft bg-surface px-2.5 py-1.5"
							>
								<span className="font-mono text-[11px] text-ink">{command.label}</span>
								<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
									{command.base}
								</span>
								<Button
									size="sm"
									onClick={() => {
										add(command);
										setFound((current) =>
											(current ?? []).filter((entry) => entry.id !== command.id),
										);
									}}
								>
									{t("commandsSettings.add")}
								</Button>
							</div>
						))
					)}
				</div>
			) : null}
		</div>
	);
}

function CommandRow({
	command,
	onRemove,
}: {
	command: RepoCommand;
	onRemove: () => void;
}) {
	const { t } = useTranslation("components3");
	const [open, setOpen] = useState(false);
	const details = command.options.length > 0 || command.positional !== null;

	return (
		<article
			className={clsx(
				"rounded-[var(--radius-panel)] border bg-surface p-2.5",
				command.danger ? "border-critical/30" : "border-line-soft",
			)}
		>
			<div className="flex items-center gap-2">
				<span className="text-[12px] font-medium text-ink">
					{command.label || t("commandsSettings.unnamed")}
				</span>
				<span className="shrink-0 text-[10px] text-ink-faint">{command.group}</span>
				{command.danger ? (
					<span className="flex items-center gap-1 text-[10px] text-critical">
						<AlertOctagon size={10} /> {t("commandsSettings.sensitive")}
					</span>
				) : null}
				{!command.scoped ? (
					<span className="text-[10px] text-ink-faint">{t("commandsSettings.mainRepo")}</span>
				) : null}
				<Button
					size="sm"
					icon={Trash2}
					variant="danger"
					className="ml-auto"
					onClick={onRemove}
					title={t("commandsSettings.remove")}
				/>
			</div>

			<p className="mt-1 font-mono text-[10.5px] break-all text-ink-muted">{command.base}</p>
			{command.description ? (
				<p className="mt-0.5 text-[10.5px] leading-snug text-ink-faint">
					{command.description}
				</p>
			) : null}

			{details ? (
				<>
					<button
						type="button"
						onClick={() => setOpen((value) => !value)}
						className="focus-ring mt-1.5 flex items-center gap-1 rounded text-[10.5px] text-ink-faint transition-colors hover:text-ink"
					>
						{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
						{command.options.length > 0
							? t("commandsSettings.options", { count: command.options.length })
							: t("commandsSettings.expectsArgument")}
					</button>
					{open ? (
						<ul className="mt-1 flex flex-col gap-0.5">
							{command.positional ? (
								<li className="text-[10.5px] text-ink-muted">
									<span className="font-mono text-ink-faint">
										{command.positional.required
											? t("commandsSettings.requiredArgument")
											: t("commandsSettings.argument")}
									</span>{" "}
									— {command.positional.label}
								</li>
							) : null}
							{command.options.map((option) => (
								<li key={option.id} className="text-[10.5px] text-ink-muted">
									<span className="font-mono text-ink-faint">{option.flag}</span>{" "}
									— {option.label}
								</li>
							))}
						</ul>
					) : null}
				</>
			) : null}
		</article>
	);
}
