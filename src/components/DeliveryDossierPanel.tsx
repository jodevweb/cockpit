import { convertFileSrc } from "@tauri-apps/api/core";
import clsx from "clsx";
import { ChevronDown, ChevronRight, FileCheck2, Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCockpit } from "@/app/store";
import { Markdown } from "@/components/Markdown";
import { Badge, Button } from "@/components/ui";
import { api } from "@/lib/ipc";
import type { Mission } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * Le dossier de livraison d'une mission : ce que le cockpit a mesuré, tel que
 * la pull request le reçoit.
 *
 * Les vidéos de recette se lisent ici, sur le poste, et nulle part ailleurs :
 * elles ne partent jamais sur la PR (une capture peut montrer un jeton ou une
 * donnée client). Le bouton publie — ou republie — la section de description
 * et le statut de commit ; la publication part aussi d'elle-même quand la
 * mission ouvre sa PR, si le projet le veut.
 */
export function DeliveryDossierPanel({ mission }: { mission: Mission }) {
	const { t } = useTranslation("components3");
	const { notify } = useCockpit();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const dossier = useAsync(() => api.missions.dossier(mission.id), [mission.id, mission.updatedAt], {
		enabled: open,
	});
	const onGithub = mission.prUrl.startsWith("https://github.com/");
	const tone =
		dossier.data?.overall === "success"
			? "success"
			: dossier.data?.overall === "failure"
				? "critical"
				: "warning";

	const publish = async () => {
		setBusy(true);
		try {
			await api.missions.publishDossier(mission.id);
			notify(t("deliveryDossier.published"));
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="rounded-lg border border-line-soft">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="focus-ring flex w-full items-center gap-2 px-2.5 py-2 text-left text-[11px] text-ink-muted hover:text-ink"
			>
				{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				<FileCheck2 size={12} className="text-accent-soft" />
				<span className="flex-1 font-medium">{t("deliveryDossier.title")}</span>
				{dossier.data ? <Badge tone={tone}>{t(`deliveryDossier.overall.${dossier.data.overall}`)}</Badge> : null}
			</button>
			{open ? (
				<div className="flex flex-col gap-3 border-t border-line-soft px-3 py-3">
					{dossier.error ? (
						<p className="text-[11px] text-critical">{String(dossier.error)}</p>
					) : null}
					{dossier.data ? (
						<>
							<div className="text-selectable text-[12px]">
								<Markdown source={dossier.data.markdown} />
							</div>
							{dossier.data.films.length > 0 ? (
								<div className="flex flex-col gap-2">
									<span className="text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										{t("deliveryDossier.films")}
									</span>
									<p className="text-[11px] text-ink-faint">{t("deliveryDossier.filmsLocal")}</p>
									<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
										{dossier.data.films.map((film) => (
											<figure key={film.path} className="flex flex-col gap-1">
												<video
													src={convertFileSrc(film.path)}
													controls
													preload="metadata"
													className="w-full rounded-md border border-line-soft bg-black"
												/>
												<figcaption className="truncate text-[10px] text-ink-faint" title={film.path}>
													{film.task}
												</figcaption>
											</figure>
										))}
									</div>
								</div>
							) : null}
							<div className={clsx("flex items-center gap-2", !onGithub && "opacity-70")}>
								<Button size="sm" icon={Send} loading={busy} disabled={!onGithub} onClick={() => void publish()}>
									{t("deliveryDossier.publish")}
								</Button>
								<span className="text-[10px] leading-relaxed text-ink-faint">
									{onGithub ? t("deliveryDossier.publishHint") : t("deliveryDossier.noPull")}
								</span>
							</div>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}
