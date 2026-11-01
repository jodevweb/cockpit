import { Rocket } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "@/components/Confirm";
import { Button } from "@/components/ui";
import { withActivity } from "@/lib/activity";
import { api } from "@/lib/ipc";
import { useCockpit } from "@/app/store";

/**
 * Lancer une mission sur le ticket qu'on a sous les yeux.
 *
 * Le chemin ordinaire — copier l'adresse, ouvrir Missions, coller, lancer le
 * maître — demandait quatre gestes pour une intention unique, et laissait
 * l'occasion de se tromper de ticket en route. Ce bouton part de ce qui est
 * affiché.
 *
 * La confirmation reste, malgré l'intention d'aller vite : ce clic démarre un
 * agent qui va lire, découper et proposer un plan. Dans une liste de vingt
 * tickets, le rattraper coûterait plus cher que de l'avoir confirmé.
 *
 * Le doublon est écarté côté cockpit, pas ici : une mission déjà ouverte sur ce
 * ticket est rendue telle quelle, et on s'y rend au lieu d'en ouvrir une
 * seconde qui viserait la même branche d'intégration.
 */
export function StartMission({
	/** Identifiant ou adresse du ticket — les deux se lisent. */
	reference,
	title,
	size = "sm",
}: {
	reference: string;
	title?: string;
	size?: "sm" | "md";
}) {
	const { t } = useTranslation("components1");
	const { notify, go, hasConnector, config } = useCockpit();
	const guided = !config?.missions?.autonomous;
	const { confirm } = useConfirm();
	const [busy, setBusy] = useState(false);

	// Une mission a besoin du CLI et de Node — ses outils d'orchestration passent
	// par un pont MCP. Sans eux, le bouton mènerait à un refus : on ne le propose
	// donc pas, et il revient de lui-même une fois le poste équipé.
	if (!hasConnector("agents") || !hasConnector("orchestration")) return null;

	const start = async () => {
		const ok = await confirm({
			title: t("startMission.confirm.title", { reference }),
			message: `${title ? t("startMission.confirm.ticketPrefix", { title }) : ""}${
				guided ? t("startMission.confirm.guided") : t("startMission.confirm.autonomous")
			}`,
			confirmLabel: t("startMission.confirm.action"),
		});
		if (!ok) return;

		setBusy(true);
		try {
			const result = await withActivity(t("startMission.activity.title", { reference }), () => api.missions.startFromTicket(reference), {
				firstStep: t("startMission.activity.firstStep"),
				result: (value) => value.message,
			});
			// On suit le maître : ouvrir la mission sans y aller laisserait croire
			// que rien ne s'est passé. Et on l'ouvre sur son parcours, où le
			// ticket se lit pendant que le maître le lit.
			go("missions", { missionId: result.mission.id });
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Button
			size={size}
			icon={Rocket}
			loading={busy}
			title={t("startMission.button.title")}
			onClick={() => void start()}
		>
			{t("startMission.button.label")}
		</Button>
	);
}
