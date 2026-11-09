import clsx from "clsx";
import {
	AlertTriangle,
	ExternalLink,
	GitBranch,
	Github,
	Gitlab,
	RefreshCw,
	ScanEye,
	Sparkles,
	Wrench,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AnalysisAge,
	briefFor,
	DiffBar,
	ImpactReport,
	RISQUE_TONE,
	VERDICT_TONE, verdictLabel, riskLabel } from "@/components/ImpactReport";
import {
	Badge,
	Button,
	Chips,
	Empty,
	ErrorNote,
	SearchField,
	Section,
	SkeletonRows,
	ViewHeader,
} from "@/components/ui";
import { api } from "@/lib/ipc";
import type {
	Change,
	ImpactAnalysis,
	Panel,
	PropertyAudit,
	ScanFix,
} from "@/lib/types";
import { useAsync, usePersistentState } from "@/lib/useAsync";
import { useAgentActions } from "@/app/agents";
import { useCockpit } from "@/app/store";
import { createWorktreeTracked } from "@/lib/worktreeFlow";

// `label` est une clé de l'espace `views` : traduite au rendu.
const FORGES = {
	github: { icon: Github, label: "impact.forge.github" },
	gitlab: { icon: Gitlab, label: "impact.forge.gitlab" },
	local: { icon: GitBranch, label: "impact.forge.local" },
};

type FiltreId = "tous" | "aLire" | "risque" | "perimes";

// Les libellés vivent dans le catalogue, sous `impact.filter.<id>`.
const FILTRES: FiltreId[] = ["tous", "aLire", "risque", "perimes"];

/** Une analyse ne vaut que pour la tête qu'elle a lue. */
function perime(change: Change): boolean {
	const analysis = change.analysis;
	return Boolean(
		analysis && analysis.headSha && change.headSha && analysis.headSha !== change.headSha,
	);
}

function ChangeCard({
	change,
	selected,
	running,
	onOpen,
	onAnalyze,
}: {
	change: Change;
	selected: boolean;
	running: boolean;
	onOpen: () => void;
	onAnalyze: () => void;
}) {
	const { notify } = useCockpit();
	const { t } = useTranslation("views");
	const forge = FORGES[change.forge] ?? FORGES.local;
	const Forge = forge.icon;
	const analysis = change.analysis;
	const depasse = perime(change);

	return (
		<article
			onClick={onOpen}
			className={clsx(
				"panel animate-in flex cursor-pointer flex-col gap-2 p-3 transition-colors duration-150",
				selected ? "border-accent/60 bg-raised" : "hover:border-line hover:bg-raised/60",
			)}
		>
			<div className="flex items-center gap-1.5">
				{/* La pastille de risque est la première chose que l'œil rencontre :
				    c'est elle qui dit s'il faut s'arrêter sur cette carte. */}
				<span
					className={clsx(
						"size-2 shrink-0 rounded-full",
						analysis
							? {
									critical: "bg-critical",
									warning: "bg-warning",
									success: "bg-success",
									info: "bg-info",
									neutral: "bg-ink-faint",
								}[RISQUE_TONE[analysis.risk] ?? "neutral"]
							: "border border-line bg-transparent",
					)}
					title={analysis ? t("impact.card.risk", { risk: riskLabel(analysis.risk) }) : t("impact.card.unread")}
				/>
				<Forge size={11} className="shrink-0 text-ink-faint" />
				{/* `min-w-0` : sans lui, `truncate` ne coupe rien dans une rangée
				    flex — l'élément garde sa largeur naturelle et pousse ses voisins
				    hors de la carte. */}
				<span className="min-w-0 truncate font-mono text-[10px] text-ink-faint">
					{change.repo}
				</span>
				<span className="shrink-0 font-mono text-[10px] text-ink-muted">
					{change.reference}
				</span>
				{change.draft ? <Badge tone="neutral">{t("impact.card.draft")}</Badge> : null}
				{change.forge === "local" ? <Badge tone="info">{t("impact.card.noPr")}</Badge> : null}
				{change.projectName ? (
					<span
						className="ml-auto max-w-[38%] shrink-0 truncate font-mono text-[10px] text-ink-faint"
						title={t("impact.card.project", { name: change.projectName })}
						style={change.projectColor ? { color: change.projectColor } : undefined}
					>
						{change.projectName}
					</span>
				) : null}
			</div>

			<div>
				<h3 className="line-clamp-2 text-[12.5px] leading-snug font-medium text-ink">
					{change.title}
				</h3>
				<p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
					{change.branch} → {change.base}
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				<DiffBar additions={change.additions} deletions={change.deletions} />
				{change.changedFiles !== null ? (
					<span className="font-mono text-[10px] text-ink-faint">
						{t("impact.card.files", { count: change.changedFiles })}
					</span>
				) : null}
				{change.ci !== "none" ? (
					<span
						className={clsx(
							"text-[10px]",
							change.ci === "failing" && "text-critical",
							change.ci === "success" && "text-success",
							change.ci === "pending" && "text-warning",
						)}
					>
						{change.ci === "failing"
							? t("impact.card.ciFailing")
							: change.ci === "success"
								? t("impact.card.ciSuccess")
								: t("impact.card.ciPending")}
					</span>
				) : null}
				{change.author ? (
					<span className="truncate text-[10px] text-ink-faint">{change.author}</span>
				) : null}
			</div>

			{change.labels.length ? (
				<Chips
					items={change.labels.map((tag) => ({
						label: tag.label,
						color: tag.color,
					}))}
					max={3}
				/>
			) : null}

			{/* Le résumé sur la carte : c'est ce qui permet de lire la grille sans
			    ouvrir quoi que ce soit — sinon l'analyse ne sert qu'à ceux qui
			    cliquent. */}
			{analysis?.headline ? (
				<p className="line-clamp-3 border-l-2 border-accent-dim pl-2 text-[11.5px] leading-relaxed text-ink-muted">
					{analysis.headline}
				</p>
			) : (
				// Sans cette ligne, la carte non lue n'était qu'un trou : on y voyait
				// l'absence d'analyse sans comprendre qu'elle se demande.
				<p className="border-l-2 border-line-soft pl-2 text-[11.5px] leading-relaxed text-ink-faint italic">
					{t("impact.card.notRead")}
				</p>
			)}

			{/* `flex-wrap` : badge, compteurs et deux boutons ne tiennent pas sur
			    une ligne dans une carte de grille — le dernier sortait du cadre par
			    la droite. Ils passent à la ligne plutôt que de déborder. */}
			<div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
				{analysis ? (
					<>
						<Badge tone={VERDICT_TONE[analysis.verdict] ?? "neutral"}>
							{analysis.verdict ? verdictLabel(analysis.verdict) : t("impact.card.read")}
						</Badge>
						{analysis.riskCount > 0 ? (
							<span className="text-[10px] whitespace-nowrap text-ink-faint">
								{t("impact.card.risks", { count: analysis.riskCount })}
							</span>
						) : null}
						{analysis.checkCount > 0 ? (
							<span className="text-[10px] whitespace-nowrap text-ink-faint">
								· {t("impact.card.checks", { count: analysis.checkCount })}
							</span>
						) : null}
						<AnalysisAge at={analysis.at} />
					</>
				) : null}
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{change.url ? (
						<Button
							size="sm"
							icon={ExternalLink}
							title={t("impact.card.openOn", { forge: t(forge.label) })}
							onClick={() => {
								void api.system
									.openUrl(change.url)
									.catch((error) => notify(String(error)));
							}}
						/>
					) : null}
					<Button
						size="sm"
						variant={analysis ? "ghost" : "solid"}
						icon={depasse ? RefreshCw : Sparkles}
						loading={running}
						onClick={onAnalyze}
					>
						{running
							? t("impact.card.reading")
							: depasse || analysis
								? t("impact.card.reread")
								: t("impact.understand")}
					</Button>
				</div>
			</div>

			{depasse ? (
				<p className="flex items-center gap-1 text-[10px] text-warning">
					<AlertTriangle size={10} /> {t("impact.card.stale")}
				</p>
			) : null}
		</article>
	);
}

/**
 * Le moniteur des changements en vol, et ce qu'ils impliquent.
 *
 * Cet écran répond à une question que ni la forge ni les flux ne traitent :
 * *qu'est-ce que ça change, et pourquoi en est-on arrivé là ?* Les listes de
 * pull requests disent qui attend quoi ; elles ne disent jamais ce qu'un
 * changement fera au produit. C'est un agent qui le lit, à la demande, et le
 * cockpit en garde la lecture jusqu'à ce que la branche bouge.
 *
 * Une grille et non une liste : chaque carte porte assez de contexte pour être
 * jugée seule — le volume du diff, l'état du CI, et surtout la phrase en clair
 * que l'analyse a produite. On parcourt, on s'arrête sur ce qui inquiète.
 */
export function ImpactView() {
	const { notify, activeProject, projectList, reloadConfig, runJob, go } = useCockpit();
	const { t } = useTranslation("views");
	const { open: openAgent } = useAgentActions();
	const [filtre, setFiltre] = usePersistentState<FiltreId>("impact.filtre", "tous");
	const [portee, setPortee] = usePersistentState<string>("impact.portee", "");
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [running, setRunning] = useState<string[]>([]);
	const [analyses, setAnalyses] = useState<Record<string, ImpactAnalysis>>({});
	const [panels, setPanels] = useState<Record<string, Panel | null>>({});
	const [confronting, setConfronting] = useState<string[]>([]);
	const [audits, setAudits] = useState<Record<string, PropertyAudit | null>>({});
	const [auditing, setAuditing] = useState<string[]>([]);

	const scan = useAsync(() => api.impact.scan(portee || undefined), [portee], {
		pollMs: 180_000,
	});

	// Une analyse survit au rechargement de la fenêtre, pas l'état local : on
	// redemande au démarrage lesquelles tournent encore, sinon on relancerait
	// par-dessus un agent déjà au travail.
	useEffect(() => {
		void api.impact
			.running()
			.then(setRunning)
			.catch(() => undefined);
		void api.panel
			.running()
			.then(setConfronting)
			.catch(() => undefined);
	}, []);

	const changes = useMemo(() => scan.data?.changes ?? [], [scan.data?.changes]);

	const [fixing, setFixing] = useState<string | null>(null);

	/**
	 * Appliquer la correction que la note propose.
	 *
	 * Le cockpit ne touche pas à la configuration de lui-même — une valeur
	 * changée sans qu'on l'ait demandé se découvre au mauvais moment. Mais
	 * quand il sait exactement quoi écrire, faire retaper à la main ce qu'il
	 * pourrait poser est un travail qu'on inflige sans raison.
	 */
	const applyFix = useCallback(
		async (fix: ScanFix) => {
			setFixing(fix.project);
			try {
				await api.config.updateProject(fix.patch, fix.project);
				reloadConfig();
				scan.reload();
				notify(t("impact.notify.fixed"));
			} catch (error) {
				notify(String(error));
			} finally {
				setFixing(null);
			}
		},
		[notify, reloadConfig, scan, t],
	);

	const analyze = useCallback(
		async (key: string) => {
			setRunning((current) => [...current, key]);
			try {
				const analysis = await api.impact.analyze(key);
				setAnalyses((current) => ({ ...current, [key]: analysis }));
				setSelected(key);
				scan.reload();
				notify(
					analysis.verdict === "bloquant"
						? t("impact.notify.readBlocking")
						: t("impact.notify.read"),
				);
			} catch (error) {
				notify(String(error));
			} finally {
				setRunning((current) => current.filter((entry) => entry !== key));
			}
		},
		[notify, scan, t],
	);

	/**
	 * Faire relire le même changement sous trois angles.
	 *
	 * Longue et chère — quatre agents — donc toujours à la demande. Le résultat
	 * est gardé sur le disque comme une analyse : on revient dessus après.
	 */
	const confront = useCallback(
		async (key: string) => {
			setConfronting((current) => [...current, key]);
			try {
				const panel = await api.panel.confront(key);
				setPanels((current) => ({ ...current, [key]: panel }));
				notify(
					panel.disputes.length === 0
						? t("impact.notify.confrontAgree")
						: t("impact.notify.confrontDisputes", { count: panel.disputes.length }),
				);
			} catch (error) {
				notify(String(error));
			} finally {
				setConfronting((current) => current.filter((entry) => entry !== key));
			}
		},
		[notify, t],
	);

	/**
	 * Juger ce changement sur les propriétés déclarées du projet.
	 *
	 * Un agent par propriété : à qui l'on donne huit règles d'un coup, on obtient
	 * huit avis tièdes. Une seule question donne un verdict net et une preuve.
	 */
	const auditKey = useCallback(
		async (key: string) => {
			setAuditing((current) => [...current, key]);
			try {
				const result = await api.properties.audit(key);
				setAudits((current) => ({ ...current, [key]: result }));
				const broken = result.checks.filter((check) => check.verdict === "enfreinte");
				notify(
					broken.length === 0
						? t("impact.notify.auditClean")
						: t("impact.notify.auditBroken", { count: broken.length }),
				);
			} catch (error) {
				notify(String(error));
			} finally {
				setAuditing((current) => current.filter((entry) => entry !== key));
			}
		},
		[notify, t],
	);

	/**
	 * Ouvrir un agent sur la branche lue, avec la lecture en main.
	 *
	 * Sans worktree, il n'y a nulle part où travailler : on lance la création et
	 * le guet ouvrira l'agent dès qu'elle sera prête. C'est le même chemin que
	 * depuis les Workspaces — une seule façon de sortir une branche.
	 */
	const workOn = useCallback(
		async (change: Change, analysis: ImpactAnalysis) => {
			const brief = briefFor(change, analysis);
			if (change.worktree) {
				openAgent(change.worktree, brief, undefined, undefined, true);
				go("workspace");
				return;
			}
			if (!change.repoPath) {
				notify(t("impact.notify.repoMissing"));
				return;
			}
			try {
				await createWorktreeTracked(
					change.branch,
					{
						mainRepo: change.repoPath,
						runJob,
						openAgent: (cwd, prompt) => openAgent(cwd, prompt, undefined, undefined, true),
					},
					{ onReady: (path) => openAgent(path, brief, undefined, undefined, true) },
				);
			} catch {
				// L'échec est déjà dit dans le centre d'activité.
			}
		},
		[go, notify, openAgent, runJob, t],
	);

	const forget = useCallback(
		async (key: string) => {
			try {
				await api.impact.forget(key);
				setAnalyses((current) => {
					const reste = { ...current };
					delete reste[key];
					return reste;
				});
				// La confrontation portait sur la même tête de branche : la garder
				// afficherait un désaccord sans la lecture qui l'a provoqué.
				setPanels((current) => {
					const reste = { ...current };
					delete reste[key];
					return reste;
				});
				scan.reload();
				notify(t("impact.notify.forgotten"));
			} catch (error) {
				notify(String(error));
			}
		},
		[notify, scan, t],
	);

	const visibles = useMemo(() => {
		const terme = query.trim().toLowerCase();
		return changes.filter((change) => {
			if (filtre === "aLire" && change.analysis) return false;
			if (filtre === "risque" && change.analysis?.risk !== "élevé") return false;
			if (filtre === "perimes" && !perime(change)) return false;
			if (!terme) return true;
			return [change.title, change.branch, change.repo, change.author, change.reference]
				.join(" ")
				.toLowerCase()
				.includes(terme);
		});
	}, [changes, filtre, query]);

	const courant = changes.find((change) => change.key === selected) ?? null;
	// L'analyse fraîchement rendue prime sur celle du recensement, qui date du
	// dernier passage : sans ça, le panneau resterait vide juste après une
	// lecture réussie.
	const analyseCourante = courant
		? (analyses[courant.key] ?? null)
		: null;
	const analyseChargee = useAsync(
		() =>
			courant && !analyses[courant.key] && courant.analysis
				? api.impact.read(courant.key)
				: Promise.resolve(null),
		[courant?.key, courant?.analysis?.at],
	);
	const rapport = analyseCourante ?? analyseChargee.data ?? null;

	// La confrontation vit sur le disque comme l'analyse : on la relit à
	// l'ouverture du changement plutôt que de la refaire.
	const panelCharge = useAsync(
		() =>
			courant && panels[courant.key] === undefined
				? api.panel.read(courant.key)
				: Promise.resolve(null),
		[courant?.key],
	);
	const confrontation = courant
		? (panels[courant.key] ?? panelCharge.data ?? null)
		: null;

	const auditCharge = useAsync(
		() =>
			courant && audits[courant.key] === undefined
				? api.properties.read(courant.key)
				: Promise.resolve(null),
		[courant?.key],
	);
	const verification = courant
		? (audits[courant.key] ?? auditCharge.data ?? null)
		: null;

	const lus = changes.filter((change) => change.analysis).length;
	const perimes = changes.filter(perime).length;

	return (
		<>
			<ViewHeader
				title={t("impact.title")}
				subtitle={
					scan.data
						? [
								t("impact.subtitle.inFlight", { count: changes.length }),
								t("impact.subtitle.read", { count: lus }),
								...(perimes ? [t("impact.subtitle.stale", { count: perimes })] : []),
							].join(" · ")
						: t("impact.subtitle.default")
				}
				actions={
					<>
						{projectList.length > 1 ? (
							<>
								<Button active={portee === ""} onClick={() => setPortee("")}>
									{t("impact.allProjects")}
								</Button>
								{activeProject ? (
									<Button
										active={portee === activeProject.id}
										onClick={() => setPortee(activeProject.id)}
									>
										{activeProject.name}
									</Button>
								) : null}
							</>
						) : null}
						<Button
							icon={RefreshCw}
							loading={scan.loading}
							onClick={() => scan.reload()}
							title={t("impact.rescan")}
						/>
					</>
				}
			/>

			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="hairline-b flex shrink-0 flex-wrap items-center gap-1.5 px-4 py-2">
						{FILTRES.map((id) => (
							<Button
								key={id}
								size="sm"
								active={filtre === id}
								title={t(`impact.filter.${id}.hint`)}
								onClick={() => setFiltre(id)}
							>
								{t(`impact.filter.${id}.label`)}
							</Button>
						))}
						<div className="ml-auto w-48">
							<SearchField value={query} onChange={setQuery} placeholder={t("impact.filterPlaceholder")} />
						</div>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto p-4">
						{/* Une source muette est dite, jamais tue : douze changements au
						    lieu de quinze sans explication se lisent comme quinze. */}
						{scan.data?.notes.length ? (
							<div className="mb-3 flex flex-col gap-1">
								{scan.data.notes.map((note) => (
									<div
										key={note.source + note.message}
										className="panel flex items-start gap-1.5 px-2.5 py-1.5 text-[11px] text-warning"
									>
										<AlertTriangle size={11} className="mt-0.5 shrink-0" />
										<span className="shrink-0 font-medium">{note.source}</span>
										<span className="min-w-0 flex-1 text-ink-muted">{note.message}</span>
										{/* Le geste là où le problème se lit : la note connaît le
										    projet et la valeur, il n'y a plus qu'à l'écrire. */}
										{note.fix ? (
											<Button
												size="sm"
												icon={Wrench}
												loading={fixing === note.fix.project}
												onClick={() => void applyFix(note.fix as ScanFix)}
											>
												{note.fix.label}
											</Button>
										) : null}
									</div>
								))}
							</div>
						) : null}

						{scan.error ? (
							<ErrorNote error={scan.error} onRetry={() => scan.reload()} />
						) : scan.loading && !scan.data ? (
							<SkeletonRows rows={6} />
						) : visibles.length === 0 ? (
							<Empty
								icon={ScanEye}
								message={
									changes.length === 0
										? t("impact.empty.nothing")
										: t("impact.empty.noMatch")
								}
								hint={
									changes.length === 0
										? t("impact.empty.nothingHint")
										: undefined
								}
							/>
						) : (
							<Section title={t("impact.changes")} count={visibles.length}>
								{/* `items-start` : chaque carte garde sa hauteur propre. Étirées
								    à la plus haute de leur ligne, celles qui ont peu à dire se
								    remplissaient de vide, et leur bouton flottait au milieu de
								    nulle part. */}
								<div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2 2xl:grid-cols-3">
									{visibles.map((change) => (
										<ChangeCard
											key={change.key}
											change={change}
											selected={selected === change.key}
											running={running.includes(change.key)}
											onOpen={() => setSelected(change.key)}
											onAnalyze={() => void analyze(change.key)}
										/>
									))}
								</div>
							</Section>
						)}
					</div>
				</div>

				{courant ? (
					<aside className="hairline-r flex w-[30rem] shrink-0 flex-col border-l border-line-soft bg-base">
						<div className="flex items-center justify-end px-2 pt-2">
							<Button size="sm" icon={X} onClick={() => setSelected(null)} />
						</div>
						{rapport ? (
							<ImpactReport
								change={courant}
								analysis={rapport}
								running={running.includes(courant.key)}
								panel={confrontation}
								confronting={confronting.includes(courant.key)}
								onAnalyze={() => void analyze(courant.key)}
								onForget={() => void forget(courant.key)}
								onWorkOn={() => void workOn(courant, rapport)}
								onConfront={() => void confront(courant.key)}
								audit={verification}
								auditing={auditing.includes(courant.key)}
								onAudit={() => void auditKey(courant.key)}
							/>
						) : (
							<Empty
								icon={Sparkles}
								message={
									running.includes(courant.key)
										? t("impact.panel.reading")
										: t("impact.panel.unread")
								}
								hint={
									running.includes(courant.key)
										? t("impact.panel.readingHint")
										: t("impact.panel.unreadHint")
								}
								action={
									running.includes(courant.key)
										? undefined
										: {
												label: t("impact.understand"),
												onClick: () => void analyze(courant.key),
											}
								}
							/>
						)}
					</aside>
				) : null}
			</div>
		</>
	);
}
