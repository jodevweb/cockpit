import clsx from "clsx";
import { FileText, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCockpit } from "@/app/store";
import { Button, Spinner } from "@/components/ui";
import type { WorkGroup } from "@/components/WorkspacePanel";
import { relativeTo, touchesOf } from "@/lib/chantier";
import { useFileViewer } from "@/lib/fileViewer";
import { locale } from "@/i18n";
import { fuzzy } from "@/lib/fuzzy";
import { api } from "@/lib/ipc";
import { useAsync, usePersistentState } from "@/lib/useAsync";

/**
 * Ouvrir un fichier du worktree, par son nom.
 *
 * L'ancien menu posait tous les fichiers du dépôt dans la page — jusqu'à vingt
 * mille lignes — rangés par ordre alphabétique, et ne trouvait qu'une suite
 * exacte de lettres : il mettait une seconde à s'ouvrir, et l'on y cherchait
 * un fichier en faisant défiler des dossiers.
 *
 * Ici rien ne s'affiche qu'on n'ait demandé. Sans rien taper, on a ce qu'on
 * vient presque toujours chercher : ce qu'on a ouvert récemment, ce que les
 * agents de ce dossier ont écrit, ce qui est modifié sans être commité. En
 * tapant, les meilleures correspondances seulement, le nom du fichier avant
 * son dossier. ⌘P l'ouvre depuis le clavier.
 */

/** Combien de lignes on dessine : au-delà, on précise sa recherche. */
const SHOWN = 60;
const RECENT = 12;

interface Row {
	path: string;
	relative: string;
	hits?: number[];
	/** Pourquoi cette ligne est là, quand ce n'est pas la recherche. */
	why?: "agent" | "changed";
}

interface Section {
	title: string;
	rows: Row[];
}

export function FileFinder({ group }: { group: WorkGroup }) {
	const { t } = useTranslation("components2");
	const { activeProject } = useCockpit();
	const viewer = useFileViewer();
	const cwd = group.cwd;
	const [open, setOpen] = useState(false);
	const [asked, setAsked] = useState(false);
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const box = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	// Par projet et en chemins relatifs : ce qu'on rouvre d'un worktree à l'autre.
	const [recent, setRecent] = usePersistentState<string[]>(`files.recent.${activeProject?.id ?? "defaut"}`, []);

	const files = useAsync(() => api.files.list(cwd), [cwd], { enabled: asked });
	const changes = useAsync(() => api.worktrees.changes(cwd).catch(() => []), [cwd], { enabled: open });

	// Le chemin en minuscules, calculé une fois : la recherche le relit à chaque frappe.
	const index = useMemo(
		() => (files.data ?? []).map((file) => ({ ...file, lower: file.relative.toLowerCase() })),
		[files.data],
	);
	const known = useMemo(() => new Set((files.data ?? []).map((file) => file.relative)), [files.data]);

	// Ce que les agents de ce dossier ont écrit, le plus récent d'abord.
	const runs = group.runs;
	const written = useMemo(() => {
		if (!open) return [];
		const at = new Map<string, number>();
		for (const run of runs) {
			for (const touch of touchesOf(run)) {
				if (touch.kind !== "write") continue;
				const relative = relativeTo(cwd, touch.path);
				if (relative !== null) at.set(relative, Math.max(at.get(relative) ?? 0, touch.at ?? 0));
			}
		}
		return [...at.entries()].sort((a, b) => b[1] - a[1]).map(([relative]) => relative);
	}, [open, runs, cwd]);
	const changed = useMemo(() => (changes.data ?? []).map((change) => change.path), [changes.data]);

	const row = (relative: string, why?: Row["why"]): Row => ({ path: `${cwd.replace(/\/+$/, "")}/${relative}`, relative, why });

	const sections = useMemo<Section[]>(() => {
		const needle = query.trim();
		if (!needle) {
			const taken = new Set<string>();
			const take = (paths: string[], limit: number, why?: Row["why"]) =>
				paths
					.filter((relative) => !taken.has(relative) && (known.size === 0 || known.has(relative)) && taken.add(relative))
					.slice(0, limit)
					.map((relative) => row(relative, why));
			return [
				{ title: t("fileFinder.recent"), rows: take(recent, 8) },
				{ title: t("fileFinder.writtenByAgents"), rows: take(written, 14, "agent") },
				{ title: t("fileFinder.uncommitted"), rows: take(changed, 14, "changed") },
			].filter((section) => section.rows.length > 0);
		}
		const boost = new Map<string, number>();
		for (const relative of changed) boost.set(relative, 120);
		for (const relative of written) boost.set(relative, 200);
		for (const relative of recent) boost.set(relative, (boost.get(relative) ?? 0) + 150);
		const found: Array<Row & { score: number }> = [];
		for (const file of index) {
			const match = fuzzy(needle, file.relative, file.lower);
			if (!match) continue;
			found.push({
				path: file.path,
				relative: file.relative,
				hits: match.hits,
				why: written.includes(file.relative) ? "agent" : changed.includes(file.relative) ? "changed" : undefined,
				score: match.score + (boost.get(file.relative) ?? 0),
			});
		}
		found.sort((a, b) => b.score - a.score || a.relative.length - b.relative.length);
		return found.length > 0 ? [{ title: t("fileFinder.files", { count: found.length }), rows: found.slice(0, SHOWN) }] : [];
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query, index, known, recent, written, changed, cwd, t]);

	const flat = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
	useEffect(() => setCursor(0), [query]);

	const show = () => {
		setOpen(true);
		setQuery("");
		// La liste se charge à la première ouverture, puis se rafraîchit derrière
		// celle qu'on a déjà : le menu s'ouvre sans attendre le disque.
		if (asked) files.reload();
		else setAsked(true);
	};

	useEffect(() => {
		if (!open) return;
		field.current?.focus();
		const dismiss = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		window.addEventListener("mousedown", dismiss);
		return () => window.removeEventListener("mousedown", dismiss);
	}, [open]);

	// ⌘P, comme partout où l'on ouvre un fichier par son nom.
	const toggle = useRef(() => {});
	toggle.current = () => (open ? setOpen(false) : show());
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
				event.preventDefault();
				toggle.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const choose = (picked: Row) => {
		setOpen(false);
		setRecent([picked.relative, ...recent.filter((entry) => entry !== picked.relative)].slice(0, RECENT));
		viewer?.open(picked.path);
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next = Math.min(flat.length - 1, Math.max(0, cursor + (event.key === "ArrowDown" ? 1 : -1)));
			setCursor(next);
			list.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (flat[cursor]) choose(flat[cursor]);
		}
	};

	const total = files.data?.length ?? 0;
	let rank = -1;

	return (
		<div ref={box} className="relative">
			<Button
				size="sm"
				icon={FileText}
				title={t("fileFinder.buttonHint")}
				onClick={() => (open ? setOpen(false) : show())}
				active={open}
			>
				{t("fileFinder.button")}
			</Button>

			{open ? (
				<div className="panel animate-in absolute top-7 right-0 z-50 flex max-h-[min(560px,70vh)] w-[min(620px,80vw)] flex-col overflow-hidden shadow-xl shadow-black/40">
					<div className="relative shrink-0 border-b border-line-soft p-2">
						<Search size={13} className="pointer-events-none absolute top-1/2 left-4.5 -translate-y-1/2 text-ink-faint" />
						<input
							ref={field}
							value={query}
							spellCheck={false}
							placeholder={t("fileFinder.placeholder")}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={onKeyDown}
							className="focus-ring h-8 w-full rounded-lg bg-raised pr-2 pl-8 text-[12.5px] text-ink placeholder:text-ink-faint"
						/>
					</div>

					<div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1">
						{sections.length === 0 ? (
							<p className="px-3 py-8 text-center text-[12px] text-ink-faint">
								{query.trim()
									? files.initial || (files.loading && total === 0)
										? t("fileFinder.scanning")
										: t("fileFinder.noMatch")
									: t("fileFinder.typeToSearch")}
							</p>
						) : (
							sections.map((section) => (
								<div key={section.title}>
									<div className="px-2 pt-2 pb-1 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase">
										{section.title}
									</div>
									{section.rows.map((entry) => {
										rank += 1;
										const at = rank;
										return (
											<FileRow
												key={`${section.title}-${entry.relative}`}
												row={entry}
												rank={at}
												selected={at === cursor}
												onHover={() => setCursor(at)}
												onPick={() => choose(entry)}
											/>
										);
									})}
								</div>
							))
						)}
					</div>

					<div className="flex shrink-0 items-center gap-3 border-t border-line-soft px-3 py-1.5 text-[10.5px] text-ink-faint">
						{files.loading ? <Spinner size={10} /> : null}
						<span>{total > 0
								? t("fileFinder.total", { count: total, formatted: total.toLocaleString(locale()) })
								: files.loading
									? t("fileFinder.scanningShort")
									: ""}</span>
						<span className="ml-auto">{t("fileFinder.keys")}</span>
					</div>
				</div>
			) : null}
		</div>
	);
}

function FileRow({
	row,
	rank,
	selected,
	onHover,
	onPick,
}: {
	row: Row;
	rank: number;
	selected: boolean;
	onHover: () => void;
	onPick: () => void;
}) {
	const { t } = useTranslation("components2");
	const cut = row.relative.lastIndexOf("/") + 1;
	const hits = useMemo(() => new Set(row.hits ?? []), [row.hits]);
	// Les lettres trouvées, en gras : on voit pourquoi ce fichier répond.
	const paint = (from: number, to: number) => {
		if (hits.size === 0) return row.relative.slice(from, to);
		const parts: React.ReactNode[] = [];
		for (let at = from; at < to; at += 1) {
			parts.push(
				hits.has(at) ? (
					<span key={at} className="font-semibold text-accent">
						{row.relative[at]}
					</span>
				) : (
					row.relative[at]
				),
			);
		}
		return parts;
	};
	return (
		<button
			type="button"
			data-row={rank}
			onMouseMove={onHover}
			onClick={onPick}
			className={clsx(
				"flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left",
				selected ? "bg-accent-dim" : "hover:bg-hover",
			)}
		>
			<span className="shrink-0 text-[12.5px] font-medium text-ink">{paint(cut, row.relative.length)}</span>
			<span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint">{paint(0, Math.max(0, cut - 1))}</span>
			{row.why ? (
				<span className={clsx("shrink-0 text-[10.5px]", row.why === "agent" ? "text-accent" : "text-warning")}>
					{row.why === "agent" ? t("fileFinder.whyAgent") : t("fileFinder.whyChanged")}
				</span>
			) : null}
		</button>
	);
}
