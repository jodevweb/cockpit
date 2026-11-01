import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import { api } from "@/lib/ipc";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

/**
 * Ce qu'un agent reçoit en plus de la consigne, au lancement.
 *
 * Le réglage n'est pas un interrupteur de confort : joindre du contexte coûte
 * de la fenêtre, et toutes les équipes ne veulent pas que leurs tickets partent
 * dans chaque conversation. Ce qui est décoché ici l'est à l'ouverture, pas
 * pour toujours — la barre du champ de saisie rattrape une section d'un clic.
 *
 * Réglage du poste et non du projet : c'est une façon de travailler, la même
 * quel que soit le dépôt ouvert. Une source absente d'un projet ne s'affiche de
 * toute façon pas, sans que personne ait à la désactiver.
 */
export function BriefSettings() {
	const { t } = useTranslation("components3");
	const { config, reloadConfig, notify } = useCockpit();
	const sources = useAsync(() => api.brief.sources(), []);
	const [enabled, setEnabled] = useState(true);
	const [off, setOff] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!config?.brief) return;
		setEnabled(config.brief.enabled);
		setOff(config.brief.off ?? []);
	}, [config?.brief]);

	const save = async () => {
		setSaving(true);
		try {
			await api.config.update({ brief: { enabled, off } });
			reloadConfig();
			notify(t("briefSettings.saved"));
		} catch (error) {
			notify(String(error));
		} finally {
			setSaving(false);
		}
	};

	const toggle = (id: string) =>
		setOff((current) =>
			current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
		);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("briefSettings.intro")}
			</p>

			<div className="panel flex flex-col gap-3 p-3.5">
				<label className="flex cursor-pointer items-start gap-2 text-[11px] text-ink-muted">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(event) => setEnabled(event.target.checked)}
						className="mt-0.5 accent-[var(--color-accent)]"
					/>
					<span>
						{t("briefSettings.enable")}
						<span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">
							{t("briefSettings.enableHint")}
						</span>
					</span>
				</label>

				{enabled ? (
					<div className="flex flex-col gap-2 border-t border-line-soft pt-3">
						<p className="text-[10px] tracking-wide text-ink-faint uppercase">
							{t("briefSettings.sourcesTitle")}
						</p>
						{sources.data?.map((source) => (
							<label
								key={source.id}
								className="flex cursor-pointer items-start gap-2 text-[11px] text-ink-muted"
							>
								<input
									type="checkbox"
									checked={!off.includes(source.id)}
									onChange={() => toggle(source.id)}
									className="mt-0.5 accent-[var(--color-accent)]"
								/>
								<span>
									{source.label}
									<span className="mt-0.5 block text-[10px] leading-snug text-ink-faint">
										{source.hint}
									</span>
								</span>
							</label>
						))}
					</div>
				) : null}

				<div className="flex justify-end">
					<Button variant="solid" loading={saving} onClick={() => void save()}>
						{t("briefSettings.save")}
					</Button>
				</div>
			</div>
		</div>
	);
}
