import clsx from "clsx";
import {
	CheckCheck,
	ChevronDown,
	ChevronRight,
	Plus,
	ShieldAlert,
	Sparkles,
	Target,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Empty, Spinner } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { Calibration, Property, PropertySuggestion } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

/**
 * Ce que ce dépôt veut voir rester vrai.
 *
 * Deux gestes seulement, mais le second est celui qui compte : déclarer une
 * propriété, et **prouver qu'elle sait échouer**. Une propriété jamais calibrée
 * n'est qu'une phrase ; une propriété qui n'attrape rien sur de vraies
 * corrections est pire, parce qu'elle rassure.
 *
 * Rien n'est fourni par défaut : une propriété écrite ici décrirait le métier de
 * celui qui l'a écrite. Le bouton « Proposer » part de l'historique du dépôt —
 * ce qu'il a déjà cassé est ce qu'il cassera encore.
 */
export function PropertiesSettings() {
	const { config, reloadConfig, notify, activeProject } = useCockpit();
	const [draft, setDraft] = useState<Property[]>([]);
	const [saving, setSaving] = useState(false);
	const [suggesting, setSuggesting] = useState(false);
	const [suggestions, setSuggestions] = useState<PropertySuggestion[] | null>(null);
	const [running, setRunning] = useState<string | null>(null);

	const project = activeProject?.mainRepo ?? "";

	useEffect(() => {
		setDraft(config?.properties ?? []);
	}, [config?.properties]);

	const calibrations = useAsync(
		() => (project ? api.properties.calibrations(project) : Promise.resolve([])),
		[project],
	);
	const [fresh, setFresh] = useState<Record<string, Calibration>>({});
	const calibrationOf = (id: string) =>
		fresh[id] ?? calibrations.data?.find((entry) => entry.propertyId === id) ?? null;

	const save = async (next: Property[]) => {
		setSaving(true);
		try {
			await api.config.updateProject({ properties: next });
			reloadConfig();
			notify("Propriétés enregistrées.");
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	const add = (property: Property) => {
		const next = [...draft, property];
		setDraft(next);
		void save(next);
	};

	const remove = (id: string) => {
		const next = draft.filter((entry) => entry.id !== id);
		setDraft(next);
		void save(next);
	};

	const propose = async () => {
		setSuggesting(true);
		try {
			setSuggestions(await api.properties.suggest(project));
		} catch (error) {
			notify(String(error));
		} finally {
			setSuggesting(false);
		}
	};

	const calibrate = async (id: string) => {
		setRunning(id);
		try {
			const result = await api.properties.calibrate(project, id);
			setFresh((current) => ({ ...current, [id]: result }));
			notify(
				result.caught === 0
					? "Cette propriété n'a rien attrapé sur tes propres correctifs."
					: `Elle aurait signalé ${result.caught} correctif(s) sur ${result.tried}.`,
			);
		} catch (error) {
			notify(String(error));
		} finally {
			setRunning(null);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				Des choses qui doivent rester vraies dans ce dépôt, écrites en français. Le
				cockpit les fait juger sur un changement, une par une, avec la preuve. Ce qui se
				vérifie mécaniquement n'a rien à faire ici — ces règles-là sont celles qu'aucun
				outil ne dit, et qui se transmettaient de bouche à oreille.
			</p>

			<div className="panel flex flex-col gap-2.5 p-3.5">
				{draft.length === 0 ? (
					<Empty
						icon={Target}
						message="Aucune propriété déclarée."
						hint="Le cockpit peut t'en proposer d'après ce que ce dépôt a déjà eu à corriger — c'est ce qu'il cassera encore."
					/>
				) : (
					draft.map((property) => (
						<PropertyRow
							key={property.id}
							property={property}
							calibration={calibrationOf(property.id)}
							running={running === property.id}
							onChange={(next) =>
								setDraft((current) =>
									current.map((entry) => (entry.id === next.id ? next : entry)),
								)
							}
							// Enregistré à la sortie du champ, pas à chaque frappe : une
							// écriture de configuration par caractère tapé.
							onCommit={() => void save(draft)}
							onCalibrate={() => void calibrate(property.id)}
							onRemove={() => remove(property.id)}
						/>
					))
				)}

				<div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2.5">
					<Button
						size="sm"
						icon={Sparkles}
						loading={suggesting}
						disabled={!project}
						onClick={() => void propose()}
						title="Lire les correctifs du dépôt et en tirer des propriétés"
					>
						Proposer d'après l'historique
					</Button>
					<Button
						size="sm"
						icon={Plus}
						onClick={() =>
							add({ id: `p-${Date.now().toString(36)}`, text: "", scope: [] })
						}
					>
						Écrire une propriété
					</Button>
					{saving ? <Spinner /> : null}
				</div>
			</div>

			{suggestions ? (
				<div className="panel flex flex-col gap-2 p-3.5">
					<div className="flex items-center gap-2">
						<h4 className="text-[11px] font-semibold tracking-[0.06em] text-accent-soft uppercase">
							Propositions · {suggestions.length}
						</h4>
						<Button
							size="sm"
							className="ml-auto"
							onClick={() => setSuggestions(null)}
						>
							Fermer
						</Button>
					</div>
					{suggestions.map((suggestion, index) => (
						<article
							key={index}
							className="rounded-[var(--radius-panel)] border border-line-soft bg-surface p-2.5"
						>
							<p className="text-[12px] leading-relaxed text-ink">{suggestion.text}</p>
							{suggestion.why ? (
								<p className="mt-1 text-[10.5px] leading-snug text-ink-faint">
									Vient de : {suggestion.why}
								</p>
							) : null}
							<div className="mt-1.5 flex items-center gap-2">
								<span className="font-mono text-[10px] text-ink-faint">
									{suggestion.scope.length > 0
										? suggestion.scope.join(" · ")
										: "tout le dépôt"}
								</span>
								<Button
									size="sm"
									className="ml-auto"
									onClick={() => {
										add({
											id: `p-${Date.now().toString(36)}-${index}`,
											text: suggestion.text,
											scope: suggestion.scope,
										});
										setSuggestions((current) =>
											(current ?? []).filter((_, at) => at !== index),
										);
									}}
								>
									Retenir
								</Button>
							</div>
						</article>
					))}
				</div>
			) : null}
		</div>
	);
}

function PropertyRow({
	property,
	calibration,
	running,
	onChange,
	onCommit,
	onCalibrate,
	onRemove,
}: {
	property: Property;
	calibration: Calibration | null;
	running: boolean;
	onChange: (property: Property) => void;
	onCommit: () => void;
	onCalibrate: () => void;
	onRemove: () => void;
}) {
	const [open, setOpen] = useState(false);
	const decorative = calibration !== null && calibration.tried > 0 && calibration.caught === 0;

	return (
		<article
			className={clsx(
				"rounded-[var(--radius-panel)] border bg-surface p-2.5",
				decorative ? "border-warning/40" : "border-line-soft",
			)}
		>
			<div className="flex items-start gap-2">
				<Target size={12} className="mt-1.5 shrink-0 text-ink-faint" />
				<textarea
					value={property.text}
					onChange={(event) => onChange({ ...property, text: event.target.value })}
					onBlur={onCommit}
					rows={2}
					placeholder="Ex. : toute route qui écrit en base valide son corps avant de l'appeler."
					className="focus-ring text-selectable min-w-0 flex-1 resize-none rounded-lg border border-line-soft bg-void px-2 py-1.5 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint"
				/>
				<Button size="sm" icon={Trash2} variant="danger" onClick={onRemove} title="Retirer" />
			</div>

			<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[20px]">
				<input
					value={property.scope.join(", ")}
					onChange={(event) =>
						onChange({
							...property,
							scope: event.target.value
								.split(",")
								.map((part) => part.trim())
								.filter(Boolean),
						})
					}
					onBlur={onCommit}
					placeholder="portée — vide = tout le dépôt"
					className="focus-ring h-6 w-52 rounded-lg border border-line-soft bg-void px-2 font-mono text-[10px] text-ink placeholder:text-ink-faint"
				/>

				{/* Le verdict qui compte : ce que cette propriété a attrapé sur de
				    vraies corrections du dépôt. */}
				{calibration === null ? (
					<span className="text-[10px] text-ink-faint">jamais éprouvée</span>
				) : decorative ? (
					<span className="flex items-center gap-1 text-[10px] text-warning">
						<ShieldAlert size={10} />
						décorative — n'a rien attrapé sur {calibration.tried} correctifs
					</span>
				) : (
					<span className="flex items-center gap-1 text-[10px] text-success">
						<CheckCheck size={10} />
						aurait signalé {calibration.caught} correctif
						{calibration.caught > 1 ? "s" : ""} sur {calibration.tried}
					</span>
				)}

				<Button
					size="sm"
					className="ml-auto"
					loading={running}
					onClick={onCalibrate}
					title="Rejouer cette propriété sur les corrections passées du dépôt"
				>
					{calibration ? "Éprouver à nouveau" : "Éprouver"}
				</Button>
			</div>

			{calibration && calibration.samples.length > 0 ? (
				<>
					<button
						type="button"
						onClick={() => setOpen((value) => !value)}
						className="focus-ring mt-1.5 ml-[20px] flex items-center gap-1 rounded text-[10.5px] text-ink-faint transition-colors hover:text-ink"
					>
						{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
						{open ? "Replier" : "Voir les correctifs rejoués"}
					</button>
					{open ? (
						<ul className="mt-1.5 ml-[20px] flex flex-col gap-1">
							{calibration.samples.map((sample) => (
								<li key={sample.sha} className="flex items-start gap-1.5 text-[10.5px]">
									<span
										className={clsx(
											"mt-[5px] size-1.5 shrink-0 rounded-full",
											sample.caught ? "bg-success" : "bg-line",
										)}
									/>
									<span className="min-w-0 flex-1 text-ink-muted">
										<span className="font-mono text-ink-faint">{sample.sha}</span>{" "}
										{sample.subject}
										{sample.note ? (
											<span className="block text-ink-faint">{sample.note}</span>
										) : null}
									</span>
								</li>
							))}
						</ul>
					) : null}
				</>
			) : null}
		</article>
	);
}
