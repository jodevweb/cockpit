import { useEffect, useState } from "react";
import { Button, Field, TextInput } from "@/components/ui";
import { api } from "@/lib/ipc";
import { useCockpit } from "@/app/store";
import { useTranslation } from "react-i18next";

const PROFONDEURS = [
	{ id: "", key: "none" },
	{ id: "fast", key: "fast" },
	{ id: "normal", key: "normal" },
	{ id: "deep", key: "deep" },
] as const;

/**
 * Ce qui décide de la qualité d'une lecture de changement.
 *
 * Le brief est le réglage qui compte. Un agent qui ne sait pas ce que fait le
 * produit ne peut parler que du code : il rend une revue technique, exactement
 * ce que l'écran Impact cherche à ne pas être. Deux lignes suffisent à ce qu'il
 * parle de conséquences — et c'est aussi ce qui rend cet écran vrai chez une
 * autre équipe, puisque rien n'est supposé du métier.
 */
export function ImpactSettings() {
	const { t } = useTranslation("components1");
	const { config, reloadConfig, notify, activeProject } = useCockpit();
	const [draft, setDraft] = useState({
		brief: "",
		engine: "",
		model: "",
		depth: "",
		localBranches: true,
	});
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!config?.impact) return;
		setDraft({
			brief: config.impact.brief ?? "",
			engine: config.impact.engine ?? "",
			model: config.impact.model ?? "",
			depth: config.impact.depth ?? "",
			localBranches: config.impact.includeLocalBranches ?? true,
		});
	}, [config?.impact]);

	// Le moteur choisi décide des modèles proposés : un alias qu'il ne connaît
	// pas serait refusé au lancement, avec une erreur qui ne dit rien d'ici.
	const engines = config?.engines ?? [];
	const engine = engines.find((entry) => entry.id === draft.engine) ?? engines[0];
	const models = engine?.models ?? [];

	const save = async () => {
		setSaving(true);
		try {
			// Sur le projet actif : deux produits n'ont ni les mêmes utilisateurs
			// ni les mêmes enjeux, et un brief emprunté ferait parler l'analyse
			// d'un produit qui n'est pas celui qu'elle lit.
			await api.config.updateProject({
				impact: {
					brief: draft.brief.trim(),
					engine: draft.engine,
					model: draft.model,
					depth: draft.depth,
					includeLocalBranches: draft.localBranches,
				},
			});
			reloadConfig();
			notify(t("impactSettings.saved"));
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("impactSettings.intro")}
			</p>

			<div className="panel flex flex-col gap-3 p-3.5">
				<Field
					label={
						activeProject?.name
							? t("impactSettings.brief.label", { name: activeProject.name })
							: t("impactSettings.brief.labelFallback")
					}
					hint={t("impactSettings.brief.hint")}
				>
					<textarea
						value={draft.brief}
						onChange={(event) => setDraft({ ...draft, brief: event.target.value })}
						rows={4}
						placeholder={t("impactSettings.brief.placeholder")}
						className="focus-ring text-selectable w-full resize-none rounded-lg border border-line-soft bg-raised px-2.5 py-2 text-[11px] leading-relaxed text-ink placeholder:text-ink-faint"
					/>
				</Field>

				<div className="grid grid-cols-3 gap-2.5">
					<Field label={t("impactSettings.engine.label")} hint={t("impactSettings.engine.hint")}>
						<select
							value={draft.engine}
							onChange={(event) => setDraft({ ...draft, engine: event.target.value, model: "" })}
							className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2 text-[11px] text-ink"
						>
							<option value="">{t("impactSettings.default")}</option>
							{engines.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{entry.label || entry.id}
								</option>
							))}
						</select>
					</Field>
					<Field label={t("impactSettings.model.label")} hint={t("impactSettings.model.hint")}>
						{models.length ? (
							<select
								value={draft.model}
								onChange={(event) => setDraft({ ...draft, model: event.target.value })}
								className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2 text-[11px] text-ink"
							>
								<option value="">{t("impactSettings.default")}</option>
								{models.map((model) => (
									<option key={model} value={model}>
										{model}
									</option>
								))}
							</select>
						) : (
							<TextInput
								value={draft.model}
								onChange={(model) => setDraft({ ...draft, model })}
								mono
							/>
						)}
					</Field>
					{/* Comprendre les implications demande plus qu'une lecture rapide :
					    c'est le seul endroit du cockpit où la profondeur se justifie, et
					    où l'attente est acceptée puisqu'on l'a demandée. */}
					<Field label={t("impactSettings.depth.label")} hint={t("impactSettings.depth.hint")}>
						<select
							value={draft.depth}
							onChange={(event) => setDraft({ ...draft, depth: event.target.value })}
							className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2 text-[11px] text-ink"
						>
							{PROFONDEURS.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{t(`impactSettings.depth.${entry.key}`)}
								</option>
							))}
						</select>
					</Field>
				</div>

				<label className="flex cursor-pointer items-start gap-2 text-[11px] text-ink-muted">
					<input
						type="checkbox"
						checked={draft.localBranches}
						onChange={(event) =>
							setDraft({ ...draft, localBranches: event.target.checked })
						}
						className="mt-0.5 accent-[var(--color-accent)]"
					/>
					<span>
						{t("impactSettings.localBranches.label")}
						<span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">
							{t("impactSettings.localBranches.hint")}
						</span>
					</span>
				</label>

				<div className="flex justify-end">
					<Button variant="solid" loading={saving} onClick={() => void save()}>
						{t("impactSettings.save")}
					</Button>
				</div>
			</div>
		</div>
	);
}
