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
import {
	AnalysisAge,
	briefFor,
	DiffBar,
	ImpactReport,
	RISQUE_TONE,
	VERDICT_TONE,
} from "@/components/ImpactReport";
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

const FORGES = {
	github: { icon: Github, label: "GitHub" },
	gitlab: { icon: Gitlab, label: "GitLab" },
	local: { icon: GitBranch, label: "branche locale" },
};

type FiltreId = "tous" | "aLire" | "risque" | "perimes";

const FILTRES: Array<{ id: FiltreId; label: string; hint: string }> = [
	{ id: "tous", label: "Tout", hint: "Tout ce qui bouge" },
	{ id: "aLire", label: "Pas encore lus", hint: "Aucune analyse à ce jour" },
	{ id: "risque", label: "Risque élevé", hint: "Ce que l'analyse a jugé sérieux" },
	{
		id: "perimes",
		label: "Périmés",
		hint: "La branche a bougé depuis la lecture",
	},
];

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
					title={analysis ? `Risque ${analysis.risk}` : "Pas encore lu"}
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
				{change.draft ? <Badge tone="neutral">brouillon</Badge> : null}
				{change.forge === "local" ? <Badge tone="info">sans PR</Badge> : null}
				{change.projectName ? (
					<span
						className="ml-auto max-w-[38%] shrink-0 truncate font-mono text-[10px] text-ink-faint"
						title={`Projet ${change.projectName}`}
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
						{change.changedFiles} fichier{change.changedFiles > 1 ? "s" : ""}
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
						CI {change.ci === "failing" ? "en échec" : change.ci === "success" ? "au vert" : "en cours"}
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
					Ce que ce changement implique n'a pas encore été lu.
				</p>
			)}

			{/* `flex-wrap` : badge, compteurs et deux boutons ne tiennent pas sur
			    une ligne dans une carte de grille — le dernier sortait du cadre par
			    la droite. Ils passent à la ligne plutôt que de déborder. */}
			<div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
				{analysis ? (
					<>
						<Badge tone={VERDICT_TONE[analysis.verdict] ?? "neutral"}>
							{analysis.verdict || "lu"}
						</Badge>
						{analysis.riskCount > 0 ? (
							<span className="text-[10px] whitespace-nowrap text-ink-faint">
								{analysis.riskCount} risque{analysis.riskCount > 1 ? "s" : ""}
							</span>
						) : null}
						{analysis.checkCount > 0 ? (
							<span className="text-[10px] whitespace-nowrap text-ink-faint">
								· {analysis.checkCount} à vérifier
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
							title={`Ouvrir sur ${forge.label}`}
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
							? "Lecture…"
							: depasse
								? "Relire"
								: analysis
									? "Relire"
									: "Comprendre"}
					</Button>
				</div>
			</div>

			{depasse ? (
				<p className="flex items-center gap-1 text-[10px] text-warning">
					<AlertTriangle size={10} /> La branche a bougé depuis cette lecture.
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

	const changes = scan.data?.changes ?? [];

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
				notify("Configuration corrigée.");
			} catch (error) {
				notify(String(error));
			} finally {
				setFixing(null);
			}
		},
		[notify, reloadConfig, scan],
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
						? "Lecture terminée — elle signale un blocage."
						: "Lecture terminée.",
				);
			} catch (error) {
				notify(String(error));
			} finally {
				setRunning((current) => current.filter((entry) => entry !== key));
			}
		},
		[notify, scan],
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
						? "Confrontation terminée — les trois angles s'accordent."
						: `Confrontation terminée — ${panel.disputes.length} désaccord(s) à trancher.`,
				);
			} catch (error) {
				notify(String(error));
			} finally {
				setConfronting((current) => current.filter((entry) => entry !== key));
			}
		},
		[notify],
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
						? "Vérification terminée — rien d'enfreint."
						: `Vérification terminée — ${broken.length} propriété(s) enfreinte(s).`,
				);
			} catch (error) {
				notify(String(error));
			} finally {
				setAuditing((current) => current.filter((entry) => entry !== key));
			}
		},
		[notify],
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
				notify("Ce dépôt n'est pas sur ce poste : impossible d'y ouvrir un agent.");
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
		[go, notify, openAgent, runJob],
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
				notify("Lecture oubliée.");
			} catch (error) {
				notify(String(error));
			}
		},
		[notify, scan],
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
				title="Impact"
				subtitle={
					scan.data
						? `${changes.length} en vol · ${lus} lu${lus > 1 ? "s" : ""}${
								perimes ? ` · ${perimes} périmé${perimes > 1 ? "s" : ""}` : ""
							}`
						: "Ce qui bouge, et ce que ça implique"
				}
				actions={
					<>
						{projectList.length > 1 ? (
							<>
								<Button active={portee === ""} onClick={() => setPortee("")}>
									Tous les projets
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
							title="Reprendre le recensement"
						/>
					</>
				}
			/>

			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="hairline-b flex shrink-0 flex-wrap items-center gap-1.5 px-4 py-2">
						{FILTRES.map((entry) => (
							<Button
								key={entry.id}
								size="sm"
								active={filtre === entry.id}
								title={entry.hint}
								onClick={() => setFiltre(entry.id)}
							>
								{entry.label}
							</Button>
						))}
						<div className="ml-auto w-48">
							<SearchField value={query} onChange={setQuery} placeholder="Filtrer…" />
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
										? "Rien ne bouge sur les dépôts déclarés."
										: "Aucun changement ne correspond à ce filtre."
								}
								hint={
									changes.length === 0
										? "Le moniteur suit les pull requests, les merge requests et les branches locales en avance sur leur base."
										: undefined
								}
							/>
						) : (
							<Section title="Changements en vol" count={visibles.length}>
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
										? "Lecture en cours…"
										: "Ce changement n'a pas encore été lu."
								}
								hint={
									running.includes(courant.key)
										? "Un agent parcourt le diff et le code autour — quelques minutes. Tu peux aller ailleurs dans le cockpit, la lecture continue et t'attendra ici. Fermer le cockpit, en revanche, l'interrompt."
										: "L'analyse dit ce que ça change pour le produit, pourquoi ce travail arrive maintenant, et ce qui peut casser."
								}
								action={
									running.includes(courant.key)
										? undefined
										: {
												label: "Comprendre",
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
