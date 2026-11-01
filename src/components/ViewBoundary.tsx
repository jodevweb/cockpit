import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { t } from "@/i18n";

/**
 * Un écran qui tombe ne doit pas emporter le cockpit.
 *
 * Une exception pendant le rendu vide l'arbre React en entier : l'application
 * devient une page blanche, sans menu, sans message, sans rien à cliquer — et
 * sans le moindre indice sur ce qui a échoué. C'est arrivé pour une étiquette
 * dont le champ avait été renommé côté serveur : un `undefined.trim()` dans un
 * composant partagé, et plus d'app du tout.
 *
 * La frontière rend l'accident local. Le rail de navigation survit, on peut
 * aller ailleurs, et l'écran fautif dit ce qu'il a rencontré au lieu de
 * disparaître en silence.
 *
 * Elle ne rattrape que le rendu — pas ce qui échoue dans un gestionnaire
 * d'événement ou une promesse ; ceux-là remontent déjà par `notify`.
 */
export class ViewBoundary extends Component<
	{ view: string; children: ReactNode },
	{ error: Error | null }
> {
	state: { error: Error | null } = { error: null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// La console du webview reste le seul endroit où lire une pile complète.
		console.error(`[cockpit] l'écran « ${this.props.view} » a échoué`, error, info);
	}

	componentDidUpdate(previous: { view: string }) {
		// Changer d'écran remet le compteur à zéro : on ne garde pas l'erreur
		// d'un écran qu'on a quitté.
		if (previous.view !== this.props.view && this.state.error) {
			this.setState({ error: null });
		}
	}

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;

		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
				<AlertTriangle size={22} className="text-critical" />
				<div className="max-w-lg">
					<p className="text-[13px] font-medium text-ink">
						{t("components2:viewBoundary.failed", { view: this.props.view })}
					</p>
					<p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
						{t("components2:viewBoundary.rest")}
					</p>
					<p className="text-selectable mt-2 rounded-lg border border-line-soft bg-surface px-2.5 py-2 text-left font-mono text-[10px] break-words text-critical">
						{error.message || String(error)}
					</p>
				</div>
				<Button
					variant="solid"
					icon={RefreshCw}
					onClick={() => this.setState({ error: null })}
				>
					{t("components2:viewBoundary.retry")}
				</Button>
			</div>
		);
	}
}
