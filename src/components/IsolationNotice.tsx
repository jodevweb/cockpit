import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/ipc";
import type { Mission } from "@/lib/types";
import { useAsync } from "@/lib/useAsync";

/**
 * Ce que les exécutants pourront faire sans rien demander, dit au moment
 * d'approuver le plan.
 *
 * Les rôles par défaut partent en `bypassPermissions` : c'est ce qui permet à
 * une mission d'avancer pendant qu'on regarde ailleurs. Hors conteneur, leur
 * outil Bash a pourtant les droits de ta session — le disque, le réseau, les
 * identifiants. Le périmètre d'écriture ne couvre que `Write` et `Edit`.
 * L'approbation du plan est le dernier moment où le savoir change quelque
 * chose ; après, les agents sont partis.
 *
 * Rien ne s'affiche quand l'isolation est active, ou quand aucun rôle du plan
 * ne part sans filet : une mise en garde qui sonne toujours n'est plus lue.
 */
export function IsolationNotice({ mission }: { mission: Mission }) {
	const { t } = useTranslation("components2");
	const { t: tViews } = useTranslation("views");
	const waiting = mission.state === "awaitingApproval";
	const exposure = useAsync(
		() => api.missions.exposure(mission.id),
		[mission.id, mission.tasks.map((task) => task.role).join(",")],
		{ enabled: waiting },
	);
	const roles = exposure.data?.unguardedRoles ?? [];
	if (!waiting || exposure.data?.sandboxed || roles.length === 0) return null;

	return (
		<div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-ink-muted">
			<ShieldAlert size={13} className="mt-0.5 shrink-0 text-warning" />
			<span>
				<span className="font-medium text-warning">
					{t("isolationNotice.title", { roles: roles.join(", ") })}
				</span>{" "}
				{t("isolationNotice.body", {
					// Les libellés de l'écran Réglages, pour qu'on retrouve l'endroit
					// tel qu'il s'affiche, dans sa langue.
					where: `${tViews("settings.tabs.agents.label")} → ${tViews("settings.sections.sandbox")}`,
				})}
			</span>
		</div>
	);
}
