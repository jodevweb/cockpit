import { CornerDownLeft, Pencil, SquareTerminal } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QuickMenu, type QuickAction } from "@/components/QuickMenu";
import { api } from "@/lib/ipc";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { useTerminalActions, type TerminalTab } from "@/app/terminals";

/**
 * Emplacement d'un terminal dans le panneau.
 *
 * Le composant ne rend rien lui-même : l'émulateur est un objet du DOM tenu par
 * le registre, qui vit hors écran quand son onglet n'est pas affiché. Le
 * recréer à chaque affichage perdrait tout ce qui a défilé — et le processus
 * derrière, lui, ne s'arrête pas pour autant.
 *
 * L'aller-retour vers le grenier suit l'onglet visible, pas le montage : le
 * composant, lui, reste en place tant que son groupe est ouvert. Hors écran,
 * l'émulateur cesse de peindre — ce qui n'aurait plus lieu s'il restait dans un
 * panneau simplement masqué.
 */
export function TerminalView({ tab, active }: { tab: TerminalTab; active: boolean }) {
	const { attach, detach, run } = useTerminalActions();
	const box = useRef<HTMLDivElement>(null);

	// Avant peinture : sans ça, l'onglet s'affiche vide le temps d'une image.
	useLayoutEffect(() => {
		const node = box.current;
		if (!node || !active) return;
		attach(tab.id, node);
		return () => detach(tab.id);
	}, [active, attach, detach, tab.id]);

	return (
		<>
			<div className="hairline-b flex items-center gap-2 px-3 py-2">
				<ScriptMenu
					cwd={tab.cwd}
					disabled={!tab.running}
					onRun={(line, execute) => run(tab.id, line, execute)}
				/>
				<span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-ink-faint">
					{tab.cwd}
				</span>
			</div>
			<div ref={box} className="min-h-0 flex-1 overflow-hidden bg-void px-2 py-1.5" />
		</>
	);
}

/**
 * Scripts du dépôt et commandes maison, tapés dans le shell ouvert.
 *
 * Mêmes entrées que la vue Scripts, mais lancées là où on travaille : dans le
 * worktree du groupe, avec sa sortie interactive. La vue Scripts garde son
 * intérêt pour les commandes à options, qu'on ne veut pas assembler de tête —
 * ici, celles à trou sont écrites sans être validées, pour qu'on les complète.
 */
function ScriptMenu({
	cwd,
	disabled,
	onRun,
}: {
	cwd: string;
	disabled: boolean;
	onRun: (line: string, execute: boolean) => void;
}) {
	const { t } = useTranslation("components2");
	const { config } = useCockpit();
	const [wanted, setWanted] = useState(false);
	const scripts = useAsync(() => api.scripts.list(cwd), [cwd], { enabled: wanted });

	const actions = useMemo<QuickAction[]>(() => {
		const typed = (line: string): QuickAction["extra"] => ({
			icon: Pencil,
			title: t("terminalView.typeOnly"),
			run: () => onRun(line, false),
		});
		const launched = (line: string): QuickAction["extra"] => ({
			icon: CornerDownLeft,
			title: t("terminalView.runAsIs"),
			run: () => onRun(line, true),
		});

		const packaged = (scripts.data ?? []).map<QuickAction>((script) => {
			// Le lanceur vient du dépôt : `pnpm` était écrit en dur ici, et ne
			// marchait que chez qui l'avait installé.
			const line = `${script.runner} ${script.name}`;
			return {
				id: `script-${script.name}`,
				group: script.group || "package.json",
				label: script.name,
				hint: script.command,
				run: () => onRun(line, true),
				extra: typed(line),
			};
		});

		const catalog = (config?.commands ?? []).map<QuickAction>((command) => {
			// Deux raisons de ne pas valider tout de suite : il manque un argument,
			// ou la commande vise le dépôt principal et pas ce worktree — dans les
			// deux cas c'est à l'œil humain de trancher avant l'exécution.
			const incomplete = Boolean(command.positional?.required);
			const elsewhere = !command.scoped;
			const execute = !incomplete && !elsewhere;
			return {
				id: command.id,
				group: command.group,
				label: command.label,
				hint: command.base,
				note: incomplete
					? command.positional?.label.toLowerCase()
					: elsewhere
						? t("terminalView.mainRepo")
						: undefined,
				run: () => onRun(command.base, execute),
				extra: execute ? typed(command.base) : launched(command.base),
			};
		});

		return [...packaged, ...catalog];
	}, [config?.commands, onRun, scripts.data, t]);

	if (disabled) return null;

	return (
		<QuickMenu
			label={t("terminalView.scripts")}
			icon={SquareTerminal}
			title={t("terminalView.scriptsHint")}
			actions={actions}
			loading={scripts.loading}
			onOpen={() => (wanted ? scripts.reload() : setWanted(true))}
			emptyMessage={scripts.error ?? t("terminalView.noScripts")}
			width={380}
			footer={<>{t("terminalView.footer")}</>}
		/>
	);
}
