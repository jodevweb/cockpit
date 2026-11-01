import clsx from "clsx";
import { AlertTriangle, Bot, ExternalLink, GitMerge, Layers } from "lucide-react";
import { useConfirm } from "@/components/Confirm";
import { Markdown } from "@/components/Markdown";
import { Badge, Button, Chips } from "@/components/ui";
import { fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { FeedItem } from "@/lib/types";
import { useAgentActions } from "@/app/agents";
import { useCockpit } from "@/app/store";

const BASE_BRANCHES = new Set(["dev", "main", "master", "stage"]);

/**
 * Fiche d'une pull request : ce qu'elle change, qui l'attend, et ce qui la
 * bloque — au lieu du JSON de l'API.
 *
 * Les données viennent du flux déjà chargé (`payload` est la réponse GitHub) :
 * aucun appel supplémentaire pour afficher la fiche.
 */
export function PullRequestDetail({ item }: { item: FeedItem }) {
	const { notify, worktrees, go } = useCockpit();
	const { confirm } = useConfirm();
	const { open: openAgent } = useAgentActions();
	const raw = (item.payload ?? {}) as Record<string, any>;

	const meta = (label: string) =>
		item.meta.find((field) => field.label === label)?.value ?? "";
	const head = String(raw.head?.ref ?? meta("branche"));
	const base = String(raw.base?.ref ?? "");
	const body = String(raw.body ?? "");
	const stacked = base !== "" && !BASE_BRANCHES.has(base);
	const worktree = worktrees.find((tree) => tree.branch === head);

	// L'état de la PR se lit dans son statut, tel que le flux l'a normalisé.
	const status = `${item.status} ${meta("ci")} ${meta("review")}`.toLowerCase();
	const ciFailing = status.includes("échec") || status.includes("failing");
	const changesRequested =
		status.includes("changements") || status.includes("changes_requested");

	/**
	 * Lance un agent avec le prompt de la bibliothèque qui traite ce blocage.
	 *
	 * Le prompt vit dans la bibliothèque et non dans le code : c'est du texte
	 * qu'on affine à l'usage, pas une constante à recompiler.
	 */
	const launch = async (promptId: string) => {
		if (!worktree) {
			notify("Aucun worktree local pour cette branche.");
			return;
		}
		try {
			const library = await api.prompts.list();
			const prompt = library.find((entry) => entry.id === promptId);
			if (!prompt) {
				notify(`Prompt « ${promptId} » introuvable dans la bibliothèque.`);
				return;
			}
			openAgent(worktree.path, prompt.text);
		} catch (error) {
			notify(String(error));
		}
	};

	const stat = (label: string, value: string | number, tone?: string) => (
		<div className="panel px-2.5 py-1.5">
			<div className="text-[10px] tracking-[0.06em] text-ink-faint uppercase">{label}</div>
			<div className={clsx("font-mono text-[12.5px] tabular-nums", tone ?? "text-ink")}>
				{value}
			</div>
		</div>
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="hairline-b flex items-start gap-2 px-4 py-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="shrink-0 font-mono text-[11px] text-ink-faint">
							#{item.id}
						</span>
						<Badge tone={raw.draft ? "neutral" : "warning"}>
							{raw.draft ? "brouillon" : "ouverte"}
						</Badge>
						{/* Les labels disent de quelle nature est la PR (hotfix, chore,
						    release…) : ils se lisent avec le titre, pas plus bas. */}
						<Chips items={item.tags ?? []} max={4} />
						{stacked ? (
							<span className="flex items-center gap-1 text-[10px] text-critical">
								<Layers size={10} /> empilée
							</span>
						) : null}
						<span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
							{fromIso(item.timestamp)}
						</span>
					</div>
					<h2 className="text-selectable mt-0.5 text-[14px] leading-snug font-semibold text-ink">
						{item.title}
					</h2>
					<p className="mt-0.5 font-mono text-[10px] text-ink-faint">
						{head} → {base}
					</p>
				</div>
				<Button
					size="sm"
					icon={ExternalLink}
					onClick={() => {
						void api.system.openUrl(item.url).catch((error) => notify(String(error)));
					}}
				/>
			</div>

			<div className="grid shrink-0 grid-cols-4 gap-2 border-b border-line-soft p-3">
				{stat("Auteur", meta("auteur") || "—")}
				{stat("Fichiers", raw.changed_files ?? "—")}
				{stat(
					"Ajouts",
					raw.additions !== undefined ? `+${raw.additions}` : "—",
					"text-success",
				)}
				{stat(
					"Suppressions",
					raw.deletions !== undefined ? `−${raw.deletions}` : "—",
					"text-critical",
				)}
			</div>

			<div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
				{meta("à reviewer par") ? (
					<span className="text-[10px] text-ink-muted">
						À reviewer par <span className="text-ink">{meta("à reviewer par")}</span>
					</span>
				) : (
					<span className="text-[10px] text-ink-faint">Aucun reviewer demandé</span>
				)}
				{meta("assigné") ? (
					<span className="text-[10px] text-ink-muted">
						· Assigné à <span className="text-ink">{meta("assigné")}</span>
					</span>
				) : null}
				<div className="ml-auto flex gap-1.5">
					{/* Les gestes de déblocage, là où l'on constate le blocage : la
					    CI rouge et les retours de review sont les deux raisons pour
					    lesquelles une PR dort, et un agent sait traiter les deux. */}
					{worktree && ciFailing ? (
						<Button
							size="sm"
							icon={AlertTriangle}
							onClick={() => void launch("ci-red")}
							title="Lancer l'agent qui corrige la CI"
						>
							Corriger la CI
						</Button>
					) : null}
					{worktree && changesRequested ? (
						<Button
							size="sm"
							icon={Bot}
							onClick={() => void launch("coderabbit")}
							title="Traiter les retours de review avec un agent"
						>
							Retours
						</Button>
					) : null}
					{worktree ? (
						<Button
							size="sm"
							icon={Bot}
							onClick={() => openAgent(worktree.path)}
							title="Ouvrir un agent sur cette branche"
						>
							Agent
						</Button>
					) : null}
					{worktree ? (
						<Button
							size="sm"
							onClick={() => go("worktrees", { worktreePath: worktree.path })}
							title="Ouvrir le worktree de cette branche"
						>
							Worktree
						</Button>
					) : null}
					{!raw.draft && !stacked ? (
						<Button
							size="sm"
							icon={GitMerge}
							onClick={() => {
								void confirm({
									title: `Merger #${item.id} dans ${base} ?`,
									message: `« ${item.title} » — action irréversible et visible de toute l'équipe.`,
									confirmLabel: "Merger",
									danger: true,
								}).then((ok) => {
									if (!ok) return;
									return api.git
										.mergePullRequest(Number(item.id))
										.then(() => notify(`#${item.id} mergée.`))
										.catch((error) => notify(String(error)));
								});
							}}
						>
							Merger
						</Button>
					) : null}
				</div>
			</div>

			<div className="min-h-0 flex-1 px-5 py-4">
				{body.trim() ? (
					<div className="mx-auto max-w-3xl">
						<Markdown source={body} />
					</div>
				) : (
					<p className="text-[11px] text-ink-faint">Pas de description.</p>
				)}
			</div>
		</div>
	);
}
