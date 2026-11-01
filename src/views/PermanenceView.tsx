import clsx from "clsx";
import {
	ChevronRight,
	Eye,
	OctagonX,
	Pause,
	Play,
	Radar,
	RefreshCw,
	Settings2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { EngagementCard } from "@/components/EngagementCard";
import { EngagementPanel } from "@/components/EngagementPanel";
import { Badge, Button, Dot, Empty, Section, Spinner, ViewHeader } from "@/components/ui";
import { fromTimestamp } from "@/lib/format";
import { api } from "@/lib/ipc";
import type { PermanenceClosed, PermanenceState, UsageLimit } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

/**
 * L'opérateur autonome : ce qu'il tient en ce moment, ce qu'il a rendu, ce
 * qu'il a écarté.
 *
 * **Le succès est silencieux, l'échec parle.** Un engagement réussi se range
 * sans réclamer d'attention ; sinon on reconstruit une boîte de réception d'IA,
 * et lire douze rapports ne vaut pas mieux que faire le travail.
 *
 * À ce stade la boucle regarde mais n'engage rien : tout ce qu'elle voit part
 * dans « Écartés », avec sa raison. C'est l'écran qui dit si une règle ne se
 * déclenche jamais parce qu'elle est mal écrite ou parce que le signal n'arrive
 * pas — sans lui, on ne peut pas régler la Permanence.
 */
export function PermanenceView() {
	const { config, go, notify } = useCockpit();
	const { confirm } = useConfirm();
	const permanence = config?.permanence;
	const rules = permanence?.rules ?? [];
	// Reflète `config.rs::PermanenceConfig::live_rules` : activée ne suffit pas,
	// une règle sans oracle énonçable ne peut pas partir — ce n'est donc pas
	// « cochée dans les réglages », c'est « prête à partir ». Les libellés
	// ci-dessous le disent explicitement pour ne pas laisser croire à un compte
	// des règles activées.
	const live = rules.filter((rule) => rule.enabled && rule.oracle?.kind && rule.oracle?.key);

	// La boucle tourne côté Rust à sa propre cadence ; l'écran se contente de la
	// relire. Trente secondes suffisent : le battement de cœur se lit en
	// minutes, pas en secondes.
	const state = useAsync(() => api.permanence.state(), [], { pollMs: 30_000 });
	const [busy, setBusy] = useState(false);
	// Les commandes rendent l'état qu'elles viennent de poser : on l'affiche
	// tout de suite plutôt que de le redemander. Sans ça, suspendre laisse
	// l'écran sur l'ancien état le temps d'un aller-retour — et on reclique.
	const [fresh, setFresh] = useState<PermanenceState | null>(null);
	const [opened, setOpened] = useState<string | null>(null);
	useEffect(() => setFresh(null), [state.data]);
	const data = fresh ?? state.data;
	const suspended = data?.suspended ?? false;
	// Le coupe-circuit prime sur tout le reste de l'en-tête : c'est le seul état
	// où elle s'est arrêtée sans qu'on le lui demande.
	const tripped = Boolean(data?.tripped);
	// Ce que le tri a retenu n'est plus « écarté » : le mélanger aux deux
	// remettrait dans la même liste ce qui attend et ce qui a été refusé.
	const retained = (data?.signals ?? []).filter((signal) => signal.retained);
	// Un seul engagement à la fois : le reste attend, et l'attente se voit.
	// Une file cachée est une file qu'on découvre le jour où elle se vide d'un
	// coup.
	const running = permanence?.maxRunning || 1;
	const engagements = data?.engagements ?? [];
	const inFlight = engagements.filter(
		(entry) => entry.stage === "planning" || entry.stage === "running",
	);
	// Les échecs d'abord, les succès ensuite : le succès est silencieux.
	const finished = engagements
		.filter((entry) => entry.stage === "done" || entry.stage === "abandoned")
		.slice(0, 12)
		.sort((a, b) => rank(a.verdict) - rank(b.verdict));
	// Un signal retenu qui n'a pas encore son engagement attend son tour.
	const waiting = retained.filter(
		(signal) => !engagements.some((entry) => entry.key === signal.key),
	);
	const queued = waiting.slice(Math.max(0, running - inFlight.length));
	const detail = engagements.find((entry) => entry.id === opened) ?? null;

	/**
	 * Tout arrêter.
	 *
	 * La confirmation ne s'affiche que s'il y a quelque chose à couper : en
	 * urgence, une boîte de dialogue devant un bouton qui n'aurait rien coupé
	 * est une friction gratuite. Dès qu'un agent tourne, en revanche, on
	 * détruit du travail en cours et ça se demande.
	 */
	const halt = async () => {
		const held = data?.holds ?? [];
		if (held.length > 0) {
			const ok = await confirm({
				title: "Tout arrêter ?",
				message: `${held.length} chose(s) en cours seront coupées : ${held
					.map((entry) => entry.label || entry.id)
					.join(", ")}. Les missions sont mises en pause, leur travail reste là. Elle ne repartira pas tant que tu ne l'auras pas réarmée.`,
				confirmLabel: "Tout arrêter",
				danger: true,
			});
			if (!ok) return;
		}
		setBusy(true);
		try {
			const result = await api.permanence.halt("Arrêt demandé depuis l'écran.");
			setFresh(result.state);
			// Ce qui a été coupé se dit, et ce qui a résisté aussi : croire que
			// c'est arrêté alors qu'il restait quelque chose est le pire résultat
			// possible pour ce bouton.
			notify(
				result.failed.length > 0
					? `Arrêté : ${result.stopped.length}. N'a pas pu être coupé : ${result.failed.join(", ")}`
					: result.stopped.length > 0
						? `Tout est arrêté (${result.stopped.join(", ")}).`
						: "Rien ne tournait. Elle ne repartira pas tant que tu ne l'auras pas réarmée.",
			);
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	/** La lâcher : elle agira pour de vrai dès le prochain engagement. */
	const releaseRehearsal = async () => {
		const ok = await confirm({
			title: "La lâcher ?",
			message:
				"Dès le prochain engagement, elle posera pour de vrai les gestes cochés dans les réglages. Elle ne touchera jamais une branche partagée, et « Tout arrêter » reste à portée.",
			confirmLabel: "La lâcher",
		});
		if (!ok) return;
		try {
			setFresh(await api.permanence.goLive());
		} catch (error) {
			notify(String(error));
		}
	};

	const toggle = async () => {
		setBusy(true);
		try {
			setFresh(await api.permanence.suspend(!suspended));
		} catch (error) {
			// Un geste qui échoue en silence laisse croire qu'il a pris : on ne
			// saurait plus si elle est au repos ou si le clic s'est perdu.
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	/** Rejoue le jugement d'un signal écarté, pas l'événement qui l'a produit. */
	const retry = async (key: string, at: number) => {
		try {
			setFresh(await api.permanence.retrySignal(key, at));
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<>
			<ViewHeader
				title="Permanence"
				subtitle={<Heartbeat state={data} live={live.length} />}
				actions={
					<>
						{/* Arrêtée d'elle-même, « Suspendre » ne veut plus rien dire :
						    elle l'est déjà, et davantage. Le seul geste qui la remet en
						    marche est le réarmement, et il vit dans le bandeau rouge —
						    là où on lit d'abord pourquoi elle s'est arrêtée. */}
						{tripped ? null : (
						<Button
							icon={suspended ? Play : Pause}
							variant={suspended ? "solid" : "outline"}
							loading={busy}
							onClick={() => void toggle()}
						>
							{suspended ? "Reprendre" : "Suspendre"}
						</Button>
						)}
						<Button
							size="sm"
							icon={Eye}
							title="Regarder maintenant, sans attendre la cadence"
							onClick={() =>
								void api.permanence
									.look()
									.then(setFresh)
									.catch((error) => notify(String(error)))
							}
						/>
						<Button
							size="sm"
							icon={Settings2}
							title="Réglages de la Permanence"
							onClick={() => go("settings", { settingsTab: "permanence" })}
						/>
						{/* En bout de rangée et en rouge : c'est le geste qu'on cherche
						    des yeux quand ça dérape, pas celui qu'on clique par
						    distraction. Une fois tout coupé il disparaît — sauf s'il reste
						    quelque chose qui a résisté, auquel cas on veut pouvoir
						    réessayer. */}
						{tripped && (data?.holds.length ?? 0) === 0 ? null : (
						<Button
							icon={OctagonX}
							variant="danger"
							loading={busy}
							title="Ferme les portes et coupe tout ce qu'elle tient"
							onClick={() => void halt()}
						>
							{tripped ? "Couper ce qui reste" : "Tout arrêter"}
						</Button>
						)}
					</>
				}
			/>

			<div className="flex min-h-0 flex-1">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
				{/* Le coupe-circuit en premier, et en rouge : c'est le seul état où
				    elle s'est arrêtée toute seule, et il ne se répare pas en
				    attendant. */}
				{data?.tripped ? (
					<div className="flex items-center gap-2 rounded-[var(--radius-panel)] border border-critical/30 bg-critical/[0.06] px-3 py-2.5">
						<Dot tone="critical" />
						<div className="min-w-0 flex-1">
							<p className="text-[11.5px] text-ink">
								Coupe-circuit : elle s'est arrêtée d'elle-même.
							</p>
							<p className="text-[10px] text-ink-faint">{data.tripped}</p>
							{data.holds.length > 0 ? (
								<p className="text-[10px] text-critical">
									{data.holds.length} chose(s) n'ont pas pu être coupées :{" "}
									{data.holds.map((entry) => entry.label || entry.id).join(", ")}
								</p>
							) : null}
						</div>
						{/* Réarmer est un geste : une reprise automatique referait ce que
						    le coupe-circuit sert à empêcher. */}
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								void api.permanence
									.rearm()
									.then(setFresh)
									.catch((error) => notify(String(error)))
							}
						>
							Réarmer
						</Button>
					</div>
				) : null}

				{/* Le rodage : elle décide et n'agit pas. Tant qu'il court, tout ce
				    qui suit est une démonstration — autant que ça se lise avant. */}
				{data && data.rehearsalLeft > 0 ? (
					<div className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-accent/30 bg-accent/[0.05] px-3 py-2.5">
						<div className="flex items-center gap-2">
							<Dot tone="info" />
							<p className="min-w-0 flex-1 text-[11.5px] text-ink">
								Rodage — elle décide, elle n'agit pas.{" "}
								<span className="font-mono text-ink-muted">
									encore {data.rehearsalLeft} engagement(s) à blanc
								</span>
							</p>
							<Button
								size="sm"
								variant="outline"
								title="Elle agira pour de vrai dès le prochain engagement"
								onClick={() => void releaseRehearsal()}
							>
								La lâcher
							</Button>
						</div>
						{/* Ce que « à blanc » et « lâcher » veulent dire, en clair. Sans
						    ça, le bouton demande de deviner ce qu'il déclenche — et c'est
						    le seul de l'écran qui change vraiment ce qu'elle a le droit
						    de faire. */}
						<ul className="flex flex-col gap-0.5 pl-4 text-[10.5px] leading-relaxed text-ink-faint">
							<li>
								<span className="text-ink-muted">Pendant le rodage :</span> elle lit les
								signaux, écrit son objectif et la liste des gestes qu'elle poserait —
								puis s'arrête là. Rien n'est touché dans tes dépôts. Ouvre un
								engagement terminé pour lire ce qu'elle aurait fait.
							</li>
							<li>
								<span className="text-ink-muted">La lâcher :</span> dès le prochain
								engagement, elle posera pour de vrai les gestes que tu as cochés — et
								seulement ceux-là. Tu peux aussi laisser le compteur s'épuiser.
							</li>
							<li>
								<span className="text-ink-muted">Le compteur repart</span> à chaque fois
								que tu changes ses pouvoirs : élargir ce qu'elle a le droit de faire,
								c'est un autre dispositif, et il se regarde avant d'être lâché.
							</li>
						</ul>
					</div>
				) : null}

				{/* Lâchée : le dire une fois, sobrement. On ne veut pas d'un bandeau
				    permanent, mais on ne veut pas non plus le découvrir par une PR. */}
				{data && data.rehearsalLeft === 0 && data.armedOn !== null && live.length > 0 ? (
					<p className="flex items-center gap-2 px-1 text-[10.5px] text-ink-faint">
						<Dot tone="success" />
						Elle agit pour de vrai. Les gestes cochés dans les réglages sont les seuls
						qu'elle posera, et jamais sur une branche partagée.
					</p>
				) : null}

				{/* Suspendre n'interrompt pas ce qui tourne : le dire ici évite qu'on
				    aille arrêter un engagement en croyant qu'il est resté en plan. */}
				{suspended ? (
					<p className="flex items-center gap-2 rounded-[var(--radius-panel)] border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[11.5px] text-ink-muted">
						<Dot tone="warning" />
						Au repos. Les engagements en cours vont au bout ; aucun nouveau ne démarrera.
						<span className="ml-auto font-mono text-[10px] text-ink-faint">
							reprend d'un clic ou avec ⌘⇧P
						</span>
					</p>
				) : null}

				<Reserve />

				<Section title="En cours" count={inFlight.length}>
					{live.length === 0 ? (
						<Empty
							icon={Radar}
							message="Aucune règle active."
							hint="La Permanence ne fera rien tant que tu ne lui auras pas dit quoi surveiller — et elle ne fera que ce que tu auras coché."
							action={{
								label: "Ouvrir les réglages",
								onClick: () => go("settings", { settingsTab: "permanence" }),
							}}
						/>
					) : inFlight.length === 0 ? (
						<p className="rounded-xl border border-dashed border-line-soft px-3 py-6 text-center text-[11px] text-ink-faint">
							{live.length} règle(s) prête(s) à partir, rien en cours. C'est la réponse
							attendue la plupart du temps.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							{inFlight.map((engagement) => (
								<EngagementCard
									key={engagement.id}
									engagement={engagement}
									onOpen={() => setOpened(engagement.id)}
								/>
							))}
						</div>
					)}
				</Section>

				{/* Terminés : les échecs d'abord, teintés ; les succès ensuite, sans
				    accent. Un succès n'a droit à aucune couleur. */}
				{finished.length > 0 ? (
					<Section title="Terminés" count={finished.length}>
						<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2.5">
							{finished.map((engagement) => (
								<EngagementCard
									key={engagement.id}
									engagement={engagement}
									onOpen={() => setOpened(engagement.id)}
								/>
							))}
						</div>
					</Section>
				) : null}

				{/* La file, dite plutôt que subie. Un seul engagement à la fois est le
				    garde-fou le plus fort du dispositif — encore faut-il voir ce qu'il
				    retient, sinon on croit qu'elle n'a rien vu. */}
				{queued.length > 0 ? (
					<Section title="En file" count={queued.length}>
						<div className="panel flex flex-col divide-y divide-line-soft">
							{queued.map((signal) => (
								<div key={signal.key} className="flex items-center gap-2 px-3 py-2">
									<Dot tone="neutral" />
									<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
										{signal.label}
									</span>
									<Badge tone="accent">{signal.rule || "règle inconnue"}</Badge>
									<span className="shrink-0 font-mono text-[10px] text-ink-faint">
										{signal.dropped || `retenu ${fromTimestamp(signal.at)}`}
									</span>
								</div>
							))}
						</div>
						<p className="px-1 pt-1 text-[10px] text-ink-faint">
							{running === 1
								? "Un seul engagement à la fois : ceux-ci attendent leur tour."
								: `${running} engagements au plus à la fois : ceux-ci attendent leur tour.`}
						</p>
					</Section>
				) : null}

				<Dropped state={data} loading={state.loading} onRetry={retry} />
			</div>

			{/* Panneau et non modale : on doit pouvoir regarder la liste pendant
			    qu'on lit le détail d'un engagement qui dérape. */}
			{detail ? (
				<EngagementPanel
					engagement={detail}
					onClose={() => setOpened(null)}
					onChange={setFresh}
				/>
			) : null}
			</div>
		</>
	);
}

/**
 * L'ordre dans lequel les engagements terminés se lisent.
 *
 * Ce qui a manqué ou n'a pas pu être jugé d'abord : ce sont les seuls qui
 * demandent quelque chose. Le reste se range.
 */
function rank(verdict: string): number {
	switch (verdict) {
		case "missed":
			return 0;
		case "undecided":
			return 1;
		case "offTopic":
			return 2;
		case "rehearsed":
			return 3;
		default:
			return 4;
	}
}

/* ── Le battement de cœur ───────────────────────────────────────────────── */

const CLOSED_LABEL: Record<PermanenceClosed, string> = {
	disabled: "désactivée",
	suspended: "au repos",
	offHours: "hors des heures de service",
	capped: "plafond du jour atteint",
	quota: "quota partagé sous le plancher",
	tripped: "arrêtée d'elle-même",
};

/**
 * La dernière fois qu'elle a effectivement regardé.
 *
 * Sans ce repère, « rien à signaler » et « je ne vois plus rien » sont
 * indiscernables — c'est le mode de panne dangereux d'un dispositif qui
 * travaille sans qu'on le regarde. Une porte fermée compte comme un regard,
 * mais elle le dit : dormir n'est pas tomber en panne.
 */
function Heartbeat({ state, live }: { state: PermanenceState | null; live: number }) {
	const look = state?.lastLook ?? null;
	// `tripped` ne passe pas par un regard : elle s'est arrêtée entre deux.
	// Attendre le prochain pour l'annoncer laisserait l'en-tête dire « dernier
	// regard il y a deux minutes » sur un dispositif à l'arrêt.
	if (state?.tripped) {
		return (
			<span className="flex items-center gap-1.5">
				<Dot tone="critical" />
				<span className="text-critical">arrêtée — coupe-circuit</span>
				<span className="text-ink-faint">·</span>
				<span>{state.tripped}</span>
			</span>
		);
	}
	const closed = look?.closed ?? null;
	// Un regard vieux de plus de trois quarts d'heure, alors que la cadence se
	// compte en minutes : quelque chose ne tourne plus.
	const stale = look ? Date.now() / 1000 - look.at > 45 * 60 : false;

	return (
		<span className="flex flex-wrap items-center gap-1.5">
			<Dot tone={closed ? "warning" : live > 0 ? "success" : "neutral"} />
			<span>
				{live > 0 ? `${live} règle(s) prête(s) à partir` : "aucune règle prête à partir"}
			</span>
			<span className="text-ink-faint">·</span>
			{!look ? (
				<span className="text-warning">jamais regardé</span>
			) : closed ? (
				<span className="text-warning">{CLOSED_LABEL[closed]}</span>
			) : (
				<span className={clsx("font-mono", stale && "text-warning")}>
					dernier regard {fromTimestamp(look.at)}
				</span>
			)}
			{/* Un regard partiel qui se tait ment plus qu'un regard vide : douze
			    changements au lieu de quinze, et on croit l'écran complet. */}
			{look?.blind?.length ? (
				<span title={look.blind.join("\n")}>
					<Badge tone="warning">{look.blind.length} source(s) muette(s)</Badge>
				</span>
			) : null}
			{state?.cold ? <Badge>curseur en cours de pose</Badge> : null}
		</span>
	);
}

/* ── Ce qu'elle a écarté ────────────────────────────────────────────────── */

/**
 * Les signaux vus et laissés de côté.
 *
 * Replié par défaut, une seule ligne : c'est la preuve que le tri fonctionne, et
 * l'endroit où l'on comprend pourquoi une règle ne se déclenche jamais.
 */
function Dropped({
	state,
	loading,
	onRetry,
}: {
	state: PermanenceState | null;
	loading: boolean;
	onRetry: (key: string, at: number) => void;
}) {
	const [open, setOpen] = useState(false);
	const signals = (state?.signals ?? []).filter((signal) => !signal.retained);
	const pending = signals.filter((signal) => signal.pending).length;

	return (
		<Section title="Écartés" count={signals.length}>
			<div className="panel overflow-hidden">
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					disabled={signals.length === 0}
					className="focus-ring flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-raised disabled:hover:bg-transparent"
				>
					<ChevronRight
						size={12}
						className={clsx(
							"shrink-0 text-ink-faint transition-transform",
							open && "rotate-90",
						)}
					/>
					<span className="text-[11px] text-ink-muted">
						{signals.length === 0
							? state?.cold
								? "Premier regard : le curseur se pose. Ce qui bougera ensuite sera signalé."
								: "Rien de nouveau depuis le dernier regard."
							: pending > 0
								? `${signals.length} signal(aux) vu(s), dont ${pending} en attente de tri.`
								: `${signals.length} signal(aux) vu(s), aucune règle ne s'applique.`}
					</span>
					{loading ? <Spinner /> : null}
					{state?.lastLook && !state.lastLook.closed ? (
						<span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
							{state.lastLook.seen} changement(s) comparé(s)
						</span>
					) : null}
				</button>

				{open && signals.length > 0 ? (
					<div className="border-t border-line-soft py-1">
						{signals.slice(0, 40).map((signal, index) => (
							<div
								key={`${signal.key}-${signal.at}-${index}`}
								className="flex items-center gap-2 px-3 py-1.5"
							>
								<Badge mono>{signal.source}</Badge>
								<span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
									{signal.label}
								</span>
								{/* Le déclencheur reconnu se distingue du bruit : c'est la
								    différence entre « je n'ai pas su le nommer » et « je l'ai
								    nommé mais rien ne l'attendait ». */}
								{signal.trigger ? <Badge tone="accent">{signal.trigger}</Badge> : null}
								<span className="shrink-0 font-mono text-[10px] text-ink-faint">
									{signal.pending ? "en attente de tri" : signal.dropped}
								</span>
								<span className="shrink-0 font-mono text-[10px] text-ink-faint">
									{fromTimestamp(signal.at)}
								</span>
								{/* Rejuger, pas revivre l'événement : utile quand l'écart venait
								    d'une donnée manquante — corrigée depuis — plutôt que d'un
								    vrai « rien à faire ». */}
								{!signal.pending && signal.dropped ? (
									<Button
										size="sm"
										icon={RefreshCw}
										title="Relancer le tri sur ce signal"
										onClick={() => onRetry(signal.key, signal.at)}
									/>
								) : null}
							</div>
						))}
						{signals.length > 40 ? (
							<p className="px-3 py-1.5 font-mono text-[10px] text-ink-faint">
								+ {signals.length - 40} autres
							</p>
						) : null}
					</div>
				) : null}
			</div>
		</Section>
	);
}

/* ── Ce qu'il reste, et à qui ───────────────────────────────────────────── */

/**
 * Trois chiffres qu'il ne faut surtout pas mélanger, parce qu'ils peuvent
 * sauter séparément :
 *
 * 1. **Son plafond du jour** — celui qu'elle s'impose, et le seul que le
 *    cockpit compte lui-même.
 * 2. **Le quota de l'abonnement** — celui que tu partages avec elle. Le CLI le
 *    connaît, avec sa mise en garde : il ne voit que cette machine.
 * 3. **Le plancher de courtoisie** — sous lequel elle s'arrête pour te laisser
 *    la place. Elle travaille en fond, toi au premier plan.
 *
 * Le second peut être épuisé quand le premier est intact : un plafond de
 * jetons qu'on s'accorde ne dit rien de ce qui reste réellement.
 */
function Reserve() {
	const { config } = useCockpit();
	const permanence = config?.permanence;
	// **Pas de poll.** Lire les plafonds coûte un lancement complet du CLI — une
	// session `claude -p /usage` qui apparaît dans les journaux, à chaque fois.
	// Un quota d'abonnement bouge en heures : le relire toutes les cinq minutes
	// parce qu'un écran est resté ouvert est une dépense pure, et un bruit dans
	// l'historique de conversations de celui qui travaille à côté.
	const limits = useAsync(() => api.sessions.limits(), []);
	const data = limits.data;

	const floor = permanence?.quotaFloorPercent || 15;
	const ceiling = permanence?.dailyTokens || 200_000;
	const engagements = permanence?.dailyEngagements || 20;

	// La contrainte qui mordra la première : le pire des quotas annoncés.
	const tightest = (data?.limits ?? []).reduce<UsageLimit | null>(
		(worst, limit) => (!worst || limit.percent > worst.percent ? limit : worst),
		null,
	);
	const remaining = tightest ? 100 - tightest.percent : null;
	const grounded = remaining !== null && remaining <= floor;

	return (
		<section
			className={clsx(
				"flex flex-col gap-3 rounded-[var(--radius-panel)] border p-3.5",
				grounded ? "border-warning/30 bg-warning/[0.05]" : "border-line-soft bg-surface",
			)}
		>
			<header className="flex items-center gap-2">
				<h2 className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
					Réserve
				</h2>
				{grounded ? <Badge tone="warning">au repos</Badge> : null}
				<div className="ml-auto flex items-center gap-2">
					{limits.loading ? <Spinner /> : null}
					<Button
						size="sm"
						icon={RefreshCw}
						title="Redemander les plafonds au CLI"
						onClick={() =>
							void api.sessions
								.limits(true)
								.then(() => limits.reload())
								.catch(() => limits.reload())
						}
					/>
				</div>
			</header>

			<div className="grid grid-cols-3 gap-3">
				{/* Ce qu'elle s'accorde. Le compteur du jour arrivera avec l'état des
				    engagements : un chiffre inventé serait pire que pas de chiffre. */}
				<Gauge
					label="Son plafond du jour"
					value={`${Math.round(ceiling / 1000)}k`}
					hint={`jetons max · ${engagements} engagements max`}
				/>
				<Gauge
					label="Ce que tu partages"
					value={remaining === null ? "—" : `${remaining} %`}
					hint={
						tightest
							? `${tightest.label.toLowerCase()}${tightest.resetsAt ? ` · repart ${tightest.resetsAt}` : ""}`
							: (data?.error ?? "plafonds non annoncés")
					}
					tone={
						remaining === null
							? "neutral"
							: remaining <= floor
								? "critical"
								: remaining <= 30
									? "warning"
									: "neutral"
					}
				/>
				<Gauge label="Elle te laisse la place sous" value={`${floor} %`} hint="de quota restant" />
			</div>

			{/* La barre porte le quota partagé, pas le plafond maison : c'est celui
			    qui décide, et celui qu'on ne contrôle pas. */}
			{remaining !== null ? (
				<div className="flex flex-col gap-1">
					<div className="relative h-1.5 overflow-hidden rounded-full bg-raised">
						<div
							className={clsx(
								"h-full rounded-full transition-[width] duration-500",
								grounded || remaining <= 30 ? "bg-warning" : "bg-accent",
							)}
							style={{ width: `${Math.min(100 - remaining, 100)}%` }}
						/>
						{/* Le plancher se voit sur la barre : sans repère, un pourcentage
						    ne dit pas s'il est proche de la limite qu'on a posée. */}
						<span
							className="absolute top-0 h-full w-px bg-ink-faint"
							style={{ left: `${Math.min(100 - floor, 100)}%` }}
							title={`Elle s'arrête sous ${floor} % restants`}
						/>
					</div>
					<p className="text-[10px] leading-snug text-ink-faint">
						{grounded
							? "Sous le plancher : elle ne démarrera aucun engagement tant que le quota n'aura pas repris."
							: `Elle s'arrêtera d'elle-même sous ${floor} % restants.`}
					</p>
				</div>
			) : null}

			{/* Recopiée telle quelle : l'omettre ferait passer ces chiffres pour une
			    vérité de compte alors qu'ils ne voient que cette machine. */}
			{data?.note ? <p className="text-[10px] leading-snug text-ink-faint">{data.note}</p> : null}
		</section>
	);
}

function Gauge({
	label,
	value,
	hint,
	tone = "neutral",
}: {
	label: string;
	value: string;
	hint: string;
	tone?: "neutral" | "warning" | "critical";
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="truncate text-[10px] font-medium tracking-[0.07em] text-ink-faint uppercase">
				{label}
			</span>
			<span
				className={clsx(
					"font-mono text-lg leading-none font-semibold tracking-tight tabular-nums",
					tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-ink",
				)}
			>
				{value}
			</span>
			<span className="truncate text-[10px] text-ink-faint" title={hint}>
				{hint}
			</span>
		</div>
	);
}
