import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { Button } from "@/components/ui";

/**
 * Confirmations et saisies courtes, rendues par l'app elle-même.
 *
 * `window.confirm` et `window.prompt` ne font rien dans une webview Tauri : le
 * dialogue n'apparaît jamais et l'appel rend « annulé ». Tous les boutons qui
 * s'y fiaient restaient donc sans effet — supprimer un worktree, retirer un
 * prompt, merger une PR. On les remplace par une modale maison plutôt que
 * d'embarquer un plugin natif pour deux boutons.
 */

interface Request {
	title: string;
	message?: string;
	confirmLabel: string;
	danger: boolean;
	/** Renseigné pour une saisie ; absent pour une simple confirmation. */
	input?: { placeholder: string; initial: string };
	resolve: (value: string | boolean | null) => void;
}

interface ConfirmStore {
	/** Rend `true` si l'action est confirmée. */
	confirm: (options: {
		title: string;
		message?: string;
		confirmLabel?: string;
		danger?: boolean;
	}) => Promise<boolean>;
	/** Rend le texte saisi, ou `null` si l'utilisateur renonce. */
	promptText: (options: {
		title: string;
		message?: string;
		placeholder?: string;
		initial?: string;
		confirmLabel?: string;
	}) => Promise<string | null>;
}

const Context = createContext<ConfirmStore | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
	const [request, setRequest] = useState<Request | null>(null);
	const [draft, setDraft] = useState("");
	const field = useRef<HTMLInputElement>(null);

	const confirm = useCallback<ConfirmStore["confirm"]>(
		(options) =>
			new Promise<boolean>((resolve) => {
				setDraft("");
				setRequest({
					title: options.title,
					message: options.message,
					confirmLabel: options.confirmLabel ?? "Confirmer",
					danger: options.danger ?? false,
					resolve: (value) => resolve(value === true),
				});
			}),
		[],
	);

	const promptText = useCallback<ConfirmStore["promptText"]>(
		(options) =>
			new Promise<string | null>((resolve) => {
				setDraft(options.initial ?? "");
				setRequest({
					title: options.title,
					message: options.message,
					confirmLabel: options.confirmLabel ?? "Valider",
					danger: false,
					input: {
						placeholder: options.placeholder ?? "",
						initial: options.initial ?? "",
					},
					resolve: (value) => resolve(typeof value === "string" ? value : null),
				});
			}),
		[],
	);

	// Le champ n'existe qu'une fois la modale montée.
	useEffect(() => {
		if (request?.input) field.current?.focus();
	}, [request]);

	const close = (value: string | boolean | null) => {
		request?.resolve(value);
		setRequest(null);
		setDraft("");
	};

	const accept = () => {
		if (!request) return;
		if (request.input) {
			const text = draft.trim();
			// Valider à vide reviendrait à créer une branche sans nom.
			if (!text) return;
			close(text);
			return;
		}
		close(true);
	};

	// Écoute globale : une confirmation sans champ de saisie n'a rien qui
	// prenne le focus, un `onKeyDown` sur la modale ne verrait donc jamais Échap.
	useEffect(() => {
		if (!request) return;
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close(request.input ? null : false);
			}
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				accept();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [request, draft]);

	return (
		<Context.Provider value={{ confirm, promptText }}>
			{children}

			{request ? (
				// Échelle d'empilement du cockpit :
				//   z-40  panneaux d'information (consommation, bibliothèque de prompts)
				//   z-50  modales et menus — voir `Modal` dans `ui.tsx`
				//   z-60  la confirmation, toujours au sommet
				//
				// Une confirmation interrompt tout, y compris une modale : c'est
				// depuis une modale qu'on demande d'arrêter un serveur. À égalité de
				// niveau, l'ordre du DOM tranchait, et le voile de la modale ouverte
				// en dernier passait par-dessus la question — cliquer « Arrêter »
				// tombait sur ce voile et refermait la modale au lieu de répondre.
				<div className="animate-in fixed inset-0 z-60 flex items-center justify-center bg-overlay/70 p-8">
					<div className="panel w-full max-w-md p-4 shadow-2xl shadow-black/50">
						<p className="text-[13px] font-semibold text-ink">{request.title}</p>
						{request.message ? (
							<p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
								{request.message}
							</p>
						) : null}

						{request.input ? (
							<input
								ref={field}
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								placeholder={request.input.placeholder}
								className="focus-ring text-selectable mt-3 w-full rounded-lg border border-line-soft bg-void px-2.5 py-2 text-[12.5px] text-ink"
							/>
						) : null}

						<div className="mt-4 flex justify-end gap-2">
							<Button onClick={() => close(request.input ? null : false)}>Annuler</Button>
							<Button
								variant={request.danger ? "danger" : "solid"}
								onClick={accept}
								disabled={Boolean(request.input) && !draft.trim()}
							>
								{request.confirmLabel}
							</Button>
						</div>
					</div>
				</div>
			) : null}
		</Context.Provider>
	);
}

export function useConfirm(): ConfirmStore {
	const store = useContext(Context);
	if (!store) throw new Error("useConfirm doit être utilisé dans ConfirmProvider");
	return store;
}
