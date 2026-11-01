import clsx from "clsx";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Un schéma écrit par un agent, dessiné.
 *
 * L'agent décrit son schéma en texte (Mermaid) ; c'est ici qu'il devient une
 * image, aux couleurs de l'app. Ce qu'il montre reste sa parole — au même
 * titre que sa conclusion, pas plus : la légende le dit, pour qu'on ne le
 * confonde pas avec le constat, qui vient du dépôt.
 *
 * Mermaid pèse lourd et ne sert qu'aux conversations qui en contiennent : il
 * n'est chargé qu'au premier schéma rencontré.
 */

function token(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Les couleurs du thème courant, dites dans le vocabulaire de Mermaid. */
function palette() {
	return {
		darkMode: document.documentElement.dataset.theme === "dark",
		fontFamily: token("--font-sans"),
		fontSize: "13px",
		background: "transparent",
		primaryColor: token("--raised"),
		primaryTextColor: token("--ink"),
		primaryBorderColor: token("--line"),
		secondaryColor: token("--accent-dim"),
		secondaryTextColor: token("--ink"),
		secondaryBorderColor: token("--accent"),
		tertiaryColor: token("--surface"),
		tertiaryTextColor: token("--ink-muted"),
		tertiaryBorderColor: token("--line"),
		lineColor: token("--ink-faint"),
		textColor: token("--ink"),
		mainBkg: token("--raised"),
		nodeBorder: token("--line"),
		clusterBkg: token("--surface"),
		clusterBorder: token("--line"),
		edgeLabelBackground: token("--surface"),
		titleColor: token("--ink"),
		actorBkg: token("--raised"),
		actorBorder: token("--line"),
		actorTextColor: token("--ink"),
		signalColor: token("--ink-muted"),
		signalTextColor: token("--ink"),
		labelBoxBkgColor: token("--surface"),
		labelBoxBorderColor: token("--line"),
		labelTextColor: token("--ink"),
		noteBkgColor: token("--accent-dim"),
		noteBorderColor: token("--accent"),
		noteTextColor: token("--ink"),
	};
}

/** Le thème posé sur le document : en changer redessine les schémas. */
function useTheme(): string {
	const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "light");
	useEffect(() => {
		const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? "light"));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	return theme;
}

/** Y a-t-il un schéma dans ce texte ? Le premier, tel que l'agent l'a écrit. */
export function firstDiagram(markdown: string): string | null {
	const match = markdown.match(/```mermaid[^\n]*\n([\s\S]*?)```/);
	return match && match[1].trim() ? match[1].trim() : null;
}

export function Diagram({
	source,
	compact = false,
	className,
}: {
	source: string;
	/** Sur une carte : le schéma tient dans sa case, sans légende. */
	compact?: boolean;
	className?: string;
}) {
	const { t } = useTranslation("components3");
	const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const theme = useTheme();
	const [svg, setSvg] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let alive = true;
		setFailed(false);
		void (async () => {
			try {
				const { default: mermaid } = await import("mermaid");
				// `strict` : aucun HTML dans les libellés, aucun lien cliquable. Ce
				// texte vient d'un agent, qui a pu le recopier de n'importe où.
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: "base",
					themeVariables: palette(),
					flowchart: { htmlLabels: false, curve: "basis" },
				});
				const drawn = await mermaid.render(id, source);
				if (alive) setSvg(drawn.svg);
			} catch {
				// Un schéma mal écrit ne casse pas la lecture : on rend son texte.
				document.getElementById(`d${id}`)?.remove();
				if (alive) setFailed(true);
			}
		})();
		return () => {
			alive = false;
		};
	}, [id, source, theme]);

	if (failed) {
		if (compact) return null;
		return (
			<div className="overflow-hidden rounded-lg border border-line-soft">
				<div className="border-b border-line-soft bg-surface/60 px-3 py-1 font-mono text-[10px] text-warning">
					{t("diagram.unreadable")}
				</div>
				<pre className="overflow-x-auto bg-void p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
					<code>{source}</code>
				</pre>
			</div>
		);
	}

	const picture = (
		<div
			className={clsx(
				"diagram flex items-center justify-center [&_svg]:h-auto [&_svg]:max-w-full",
				compact ? "h-28 overflow-hidden [&_svg]:max-h-28" : "overflow-x-auto p-3",
				!svg && "animate-pulse",
				className,
			)}
			// Le SVG sort de Mermaid en mode strict, déjà assaini par lui.
			dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
		/>
	);
	if (compact) return picture;

	return (
		<figure className="overflow-hidden rounded-lg border border-line-soft bg-surface">
			{picture}
			<figcaption className="border-t border-line-soft px-3 py-1 font-mono text-[10px] text-ink-faint">
				{t("diagram.caption")}
			</figcaption>
		</figure>
	);
}
