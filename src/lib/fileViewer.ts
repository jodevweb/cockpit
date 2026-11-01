import { createContext, useContext } from "react";

/**
 * Le canal par lequel un lien de fichier demande sa lecture.
 *
 * Tenu à part du composant qui l'implémente, et c'est la seule raison d'être de
 * ce fichier : la visionneuse rend du markdown, le markdown fabrique des liens,
 * et un lien a besoin de la visionneuse. Le contexte ici, l'écran là-bas, et la
 * boucle d'imports disparaît — sans quoi l'un des trois modules serait évalué
 * avant que le contexte existe, selon l'ordre où le bundler les range.
 */
export interface FileViewerStore {
	open: (path: string, line?: number) => void;
}

export const FileViewerContext = createContext<FileViewerStore | null>(null);

/**
 * La visionneuse, quand elle est disponible.
 *
 * Rend `null` hors de son fournisseur plutôt que de lever : un lien de fichier
 * peut se retrouver dans un écran monté à part, et il doit alors se rabattre
 * sur l'éditeur externe au lieu de faire tomber la vue.
 */
export function useFileViewer(): FileViewerStore | null {
	return useContext(FileViewerContext);
}
