import clsx from "clsx";
import {
	Boxes,
	Eye,
	EyeOff,
	GitBranch,
	History,
	MessageSquareText,
	RefreshCw,
	Ticket,
	TriangleAlert,
	type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { locale, t as translate } from "@/i18n";
import { Markdown } from "@/components/Markdown";
import { Spinner } from "@/components/ui";
import type { Brief, BriefSection } from "@/lib/types";

/**
 * Ce que l'agent saura, montré avant qu'il ne le sache.
 *
 * La barre ne sert pas à décorer le champ de saisie : elle répond à une
 * question précise — « pourquoi l'agent a-t-il fait ça ? » — qui devient
 * insoluble dès qu'un contexte part sans être vu. Chaque puce est donc à la
 * fois un fait joint et un interrupteur, et le texte exact reste dépliable.
 *
 * Elle ne s'affiche qu'avant le premier message : après, l'agent a le contexte
 * dans sa conversation, et le rappeler à chaque tour reviendrait à le payer
 * deux fois.
 */

/** Une icône par nature de fait : la puce se reconnaît avant d'être lue. */
const ICONS: Record<string, LucideIcon> = {
	product: Boxes,
	place: GitBranch,
	ticket: Ticket,
	review: MessageSquareText,
	attempts: History,
};

/** Volume joint, dans l'unité qui parle : des caractères, pas des jetons. */
function volume(chars: number): string {
	if (chars < 1000) return translate("components2:briefBar.chars", { value: chars });
	return translate("components2:briefBar.kchars", {
		value: (chars / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
	});
}

export function BriefBar({
	brief,
	loading,
	onToggle,
	onRefresh,
}: {
	brief: Brief | null;
	loading: boolean;
	onToggle: (id: string) => void;
	onRefresh: () => void;
}) {
	const { t } = useTranslation("components2");
	const [open, setOpen] = useState(false);

	if (loading && !brief) {
		return (
			<div className="flex items-center gap-2 border-t border-line-soft px-2.5 py-1.5">
				<Spinner size={11} />
				<span className="text-[10.5px] text-ink-faint">
					{t("briefBar.loading")}
				</span>
			</div>
		);
	}

	if (!brief) return null;
	const { sections, missing } = brief;
	if (sections.length === 0 && missing.length === 0) return null;

	const retained = sections.filter((section) => section.on);
	const chars = retained.reduce((total, section) => total + section.chars, 0);

	return (
		<div className="border-t border-line-soft bg-base/50">
			<div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5">
				<span className="mr-0.5 text-[10.5px] font-medium tracking-wide text-ink-faint">
					{t("briefBar.agentWillKnow")}
				</span>

				{sections.map((section) => (
					<Chip key={section.id} section={section} onToggle={() => onToggle(section.id)} />
				))}

				{sections.length === 0 ? (
					<span className="text-[10.5px] text-ink-faint">
						{t("briefBar.nothing")}
					</span>
				) : null}

				<span className="ml-auto flex items-center gap-1">
					{retained.length > 0 ? (
						<span className="font-mono text-[10px] text-ink-faint">{volume(chars)}</span>
					) : null}
					<button
						type="button"
						title={open ? t("briefBar.collapse") : t("briefBar.expand")}
						disabled={retained.length === 0}
						onClick={() => setOpen((value) => !value)}
						className="focus-ring rounded p-1 text-ink-faint transition-colors hover:text-ink disabled:opacity-30"
					>
						{open ? <EyeOff size={12} /> : <Eye size={12} />}
					</button>
					<button
						type="button"
						title={t("briefBar.refresh")}
						onClick={onRefresh}
						className="focus-ring rounded p-1 text-ink-faint transition-colors hover:text-ink"
					>
						<RefreshCw size={12} className={clsx(loading && "animate-spin-slow")} />
					</button>
				</span>
			</div>

			{/* Ce qui a été cherché sans réponse. Le taire ferait passer un dossier
			    troué pour un dossier complet — exactement l'erreur qu'on veut éviter. */}
			{missing.length > 0 ? (
				<p className="flex items-start gap-1.5 px-2.5 pb-1.5 text-[10.5px] text-warning">
					<TriangleAlert size={11} className="mt-px shrink-0" />
					<span>{t("briefBar.missing", { sources: missing.join(" · ") })}</span>
				</p>
			) : null}

			{open && retained.length > 0 ? (
				<div className="animate-in max-h-64 overflow-y-auto border-t border-line-soft/60 bg-void/40 px-3 py-2.5">
					<Markdown source={retained.map((section) => section.text).join("\n\n")} />
				</div>
			) : null}
		</div>
	);
}

function Chip({ section, onToggle }: { section: BriefSection; onToggle: () => void }) {
	const { t } = useTranslation("components2");
	const Icon = ICONS[section.id] ?? Boxes;
	return (
		<button
			type="button"
			onClick={onToggle}
			title={
				section.on
					? t("briefBar.clickToDetach", { detail: section.detail })
					: t("briefBar.clickToAttach", { detail: section.detail })
			}
			className={clsx(
				"focus-ring inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors duration-150",
				section.on
					? "border-accent/40 bg-accent-dim text-accent-soft"
					: "border-dashed border-line text-ink-faint opacity-70 hover:opacity-100",
			)}
		>
			<Icon size={11} className="shrink-0" />
			<span className="truncate text-[10.5px] font-medium">{section.label}</span>
			<span className="shrink-0 font-mono text-[9.5px] opacity-60">
				{volume(section.chars)}
			</span>
		</button>
	);
}
