import { AlertTriangle, Bot, ExternalLink, FolderGit2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui";
import { StartMission } from "@/components/StartMission";
import { api } from "@/lib/ipc";
import { useAgentActions } from "@/app/agents";
import { useCockpit } from "@/app/store";

/**
 * Ce qu'on peut faire d'un ticket, ou d'une pull request, où qu'ils s'affichent.
 *
 * Le cockpit s'est construit écran par écran, et les actions avec lui : lancer une
 * mission depuis un ticket existait dans la fiche mais pas dans le daily, ouvrir
 * un agent sur une branche dans le détail d'une PR mais pas dans la liste du
 * matin. Rien ne le justifiait — c'est le même objet, le même geste — sinon
 * l'ordre dans lequel les écrans ont été écrits.
 *
 * D'où ces deux composants : le jeu d'actions d'un type vit à un seul endroit et
 * s'affiche partout où ce type apparaît. Ajouter une action demain la donne à
 * tous les écrans du même coup, ce qui est la seule façon de ne pas voir la
 * divergence revenir.
 *
 * Ils n'affichent que ce qui peut aboutir : un worktree qui n'existe pas ne
 * s'ouvre pas, un agent sans CLI installé ne se lance pas. Une action qui mène à
 * une erreur s'apprend une fois et fait douter du reste.
 */

/** Le worktree d'une branche, quand elle est sortie sur le poste. */
function useWorktreeFor(branch?: string | null) {
	const { worktrees } = useCockpit();
	if (!branch) return undefined;
	return worktrees.find((tree) => tree.branch === branch);
}

/**
 * Le worktree qui porte le travail d'un ticket.
 *
 * On le reconnaît à son identifiant dans le nom de la branche — `ABC-3044` dans
 * `fix-…-nw-3044`. C'est la convention que suivent les suivis qui suggèrent un
 * nom de branche, et celle que le cockpit applique quand il en crée une.
 */
function useWorktreeForTicket(identifier: string) {
	const { worktrees } = useCockpit();
	const needle = identifier.trim().toLowerCase().replace(/^#/, "");
	if (!needle) return undefined;
	return worktrees.find((tree) => (tree.branch ?? "").toLowerCase().includes(needle));
}

export function TicketActions({
	identifier,
	title,
	url,
	size = "sm",
}: {
	identifier: string;
	title?: string;
	url?: string;
	size?: "sm" | "md";
}) {
	const { notify, go } = useCockpit();
	const tree = useWorktreeForTicket(identifier);

	return (
		<>
			{url ? (
				<Button
					size={size}
					icon={ExternalLink}
					title="Ouvrir le ticket dans le navigateur"
					onClick={() => {
						void api.system.openUrl(url).catch((error) => notify(String(error)));
					}}
				/>
			) : null}
			{/* Le travail déjà commencé passe avant : s'il existe un worktree, on y
			    va plutôt que d'ouvrir une seconde fois le même chantier. */}
			{tree ? (
				<Button
					size={size}
					icon={FolderGit2}
					title={`Ouvrir le worktree ${tree.branch ?? tree.folderName}`}
					onClick={() => go("worktrees", { worktreePath: tree.path })}
				>
					Worktree
				</Button>
			) : null}
			<StartMission reference={identifier} title={title} size={size} />
		</>
	);
}

export function PrActions({
	number,
	url,
	headRef,
	ciFailing,
	changesRequested,
	size = "sm",
}: {
	number: number;
	url?: string;
	/** Branche de la PR : c'est par elle qu'on retrouve le worktree local. */
	headRef?: string | null;
	ciFailing?: boolean;
	changesRequested?: boolean;
	size?: "sm" | "md";
}) {
	const { notify, go, hasConnector, config, reloadConfig } = useCockpit();
	const { open: openAgent } = useAgentActions();
	const tree = useWorktreeFor(headRef);
	const canAgent = hasConnector("agents");

	// Le consentement au commentaire porte sur l'objet : il se donne ici, sur la
	// PR qu'on a sous les yeux, et pas dans un écran de réglages où l'on cocherait
	// une fois pour toutes. Le geste n'apparaît que si le pouvoir est activé et
	// que cette condition-là est retenue — sinon il ne voudrait rien dire.
	const permanence = config?.permanence;
	const asksAllowance =
		permanence?.enabled === true &&
		permanence.comment?.enabled === true &&
		(permanence.comment.scopes ?? []).includes("i_allowed");
	const allowed = (permanence?.allowedPrs ?? []).includes(number);

	const toggleAllowance = async () => {
		try {
			await api.permanence.allowPr(number, !allowed);
			reloadConfig();
			notify(
				allowed
					? `La Permanence ne commentera plus sur #${number}.`
					: `La Permanence peut rendre compte sur #${number}. Un commentaire par jour, signé.`,
			);
		} catch (error) {
			notify(String(error));
		}
	};

	/**
	 * Lance un agent sur la branche avec un prompt de la bibliothèque.
	 *
	 * Le prompt vient de la bibliothèque plutôt que d'être écrit ici : c'est celui
	 * que l'équipe a réglé, et le recopier le ferait diverger de la version qu'on
	 * relit dans les réglages.
	 */
	const launch = async (...ids: string[]) => {
		if (!tree) return;
		try {
			const library = await api.prompts.list();
			// Le premier identifiant que la bibliothèque connaît. « Retours »
			// cherchait un prompt que la liste par défaut n'a jamais eu : sans
			// réglage maison, l'agent partait sans consigne.
			const prompt = ids.map((id) => library.find((entry) => entry.id === id)).find(Boolean);
			if (!prompt) notify("Aucun prompt pour ce geste dans la bibliothèque : l'agent part sans consigne.");
			openAgent(tree.path, prompt?.text ?? "");
		} catch (error) {
			notify(String(error));
		}
	};

	return (
		<>
			{url ? (
				<Button
					size={size}
					icon={ExternalLink}
					title={`Ouvrir la pull request #${number}`}
					onClick={() => {
						void api.system.openUrl(url).catch((error) => notify(String(error)));
					}}
				/>
			) : null}
			{/* Les deux raisons pour lesquelles une PR dort, et le geste qui les
			    traite — là où on constate le blocage, pas dans un autre écran. */}
			{tree && canAgent && ciFailing ? (
				<Button
					size={size}
					icon={AlertTriangle}
					title="Lancer l'agent qui corrige la CI"
					onClick={() => void launch("ci-red")}
				>
					Corriger la CI
				</Button>
			) : null}
			{tree && canAgent && changesRequested ? (
				<Button
					size={size}
					icon={Bot}
					title="Traiter les retours de review avec un agent"
					onClick={() => void launch("coderabbit", "review-comments")}
				>
					Retours
				</Button>
			) : null}
			{tree && canAgent ? (
				<Button
					size={size}
					icon={Bot}
					title="Ouvrir un agent sur cette branche"
					onClick={() => openAgent(tree.path)}
				>
					Agent
				</Button>
			) : null}
			{tree ? (
				<Button
					size={size}
					icon={FolderGit2}
					title="Ouvrir le worktree de cette branche"
					onClick={() => go("worktrees", { worktreePath: tree.path })}
				>
					Worktree
				</Button>
			) : null}
			{asksAllowance ? (
				<Button
					size={size}
					icon={MessageSquare}
					active={allowed}
					title={
						allowed
							? "La Permanence peut rendre compte ici. Cliquer pour le lui retirer."
							: "Autoriser la Permanence à rendre compte ici, une fois par jour, signé."
					}
					onClick={() => void toggleAllowance()}
				>
					{allowed ? "Autorisée" : "Autoriser"}
				</Button>
			) : null}
		</>
	);
}
