import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { isImagePath } from "@/components/LocalImage";
import { t } from "@/i18n";
import { api, events } from "@/lib/ipc";
import { modelLabel as readableModel } from "@/lib/format";
import { hasTauri, isPreview } from "@/lib/preview";
import { startActivity } from "@/lib/activity";
import { rememberFollows } from "@/lib/threadMarks";
import { isLibreRun, libreOf, libreVisible, patchLibre, selectLibre } from "@/lib/libre";
import {
	readQuestions,
	type ContextUsage,
	type PermissionRequest,
	type SessionEvent,
} from "@/lib/types";
import { useAsync, usePersistentState } from "@/lib/useAsync";
import { useCockpit } from "./store";
import { useWorkspace } from "./workspace";

/**
 * Conversations d'agents, tenues hors des composants qui les affichent.
 *
 * Un agent est un processus : il survit à l'écran qui le montre. Tant que son
 * état vivait dans la fenêtre de discussion, la refermer perdait le fil sans
 * arrêter le travail — on continuait à modifier le dépôt sans témoin. L'état
 * remonte donc ici : le panneau peut se replier, on garde la main.
 *
 * Ce qui est affiché, en revanche, ne se décide pas ici : le panneau montre un
 * groupe de travail — un worktree, ses agents, ses terminaux — dont
 * `useWorkspace` tient l'état.
 */

/**
 * Un serveur MCP, tel que la session le voit à l'instant où on le lui demande.
 *
 * Les statuts viennent du CLI : `connected`, `pending`, `needs-auth`, `failed`.
 * Seul `connected` donne ses outils à l'agent — vérifié en croisant les statuts
 * d'une session avec les deux cent soixante et un outils qu'elle exposait :
 * aucun serveur non connecté n'en fournissait un seul.
 */
export interface McpServer {
	name: string;
	status: string;
}

/**
 * Ce dont un agent dispose vraiment : ses serveurs, ses skills, ses sous-agents.
 *
 * Rien de tout cela n'était lu. Le cockpit déclarait ce que le `.mcp.json`
 * promettait, l'agent travaillait avec ce qui avait bien voulu répondre, et
 * l'écart ne se voyait nulle part — un serveur tombé ou une autorisation
 * expirée passaient pour un agent qui n'a pas eu l'idée de s'en servir.
 */
export interface Equipment {
	servers: McpServer[];
	/** Vrai dès que la session a répondu à une demande d'état. */
	probed: boolean;
	skills: string[];
	subagents: string[];
	plugins: string[];
}

export interface Turn {
	kind: "user" | "assistant" | "tool" | "system" | "error";
	text: string;
	/**
	 * Ce qui est parti avec ce message sans y être écrit.
	 *
	 * Le dossier de contexte accompagne la consigne mais ne s'affiche pas à sa
	 * place : on garde la trace de ce qui a été joint, sous une forme qu'on peut
	 * relire. Sans elle, un agent qui répond à côté est inexplicable — on ne sait
	 * plus ce qu'il avait sous les yeux.
	 */
	context?: string;
	tool?: string;
	/** Bloc `tool_use` d'origine : c'est par lui que sa sortie se rattache. */
	toolId?: string;
	/** Entrée complète de l'outil — de quoi décrire l'appel, pas juste le nommer. */
	input?: Record<string, unknown>;
	/** Ce que l'outil a répondu, quand c'est revenu. */
	output?: string;
	/** Les images de sa réponse : une capture lue vaut mieux que son chemin. */
	outputImages?: string[];
	outputError?: boolean;
	/**
	 * Quand ce tour est arrivé — pour un appel, quand il a commencé.
	 *
	 * Rien dans le flux du CLI ne date quoi que ce soit : on le pose à
	 * l'arrivée, ou on le reprend du journal pour une conversation relue. C'est
	 * la seule façon de distinguer un agent qui vient de lancer une commande
	 * d'un agent muet depuis six minutes. Absent, on ne l'invente pas.
	 */
	at?: number;
	/** Quand la réponse de l'outil est revenue : le dernier signe de vie, souvent. */
	doneAt?: number;
	/**
	 * Pour un message de ta part : suite de la consigne en cours (`true`) ou
	 * nouvelle consigne (`false`), tel que choisi à l'envoi. Absent, la carte
	 * devine.
	 */
	follows?: boolean;
	/**
	 * Le fil du sous-agent qu'a lancé cet appel, quand c'en est un.
	 *
	 * Rangé sous son appel plutôt qu'ajouté à la conversation : trois
	 * sous-agents qui travaillent en même temps écriraient sinon leurs lignes en
	 * alternance dans le fil du maître, et on ne saurait plus qui parle.
	 */
	sub?: Turn[];
	/**
	 * Cet appel a lancé un travail en arrière-plan : l'outil a répondu « lancé »
	 * tout de suite, et le travail court encore après. `endedAt` reste `null`
	 * tant que le CLI n'a pas annoncé sa fin (`<task-notification>`).
	 *
	 * Sans cette trace, la réponse immédiate de l'outil passait pour la fin du
	 * sous-agent : la carte lui donnait « 0 s », et l'agent qui rendait la main
	 * en attendant ses relecteurs s'affichait « Terminé — rien ne tourne ».
	 */
	background?: { endedAt: number | null; status?: string };
	/**
	 * Ce tour marque un compactage : le CLI a remplacé tout ce qui précède par
	 * un résumé. Ce que l'agent avait lu avant, il n'en garde plus le détail.
	 */
	compact?: { trigger: string; preTokens: number | null };
	/**
	 * La preuve filmée d'un tour : ce que l'agent a fait dans le navigateur du
	 * workspace, monté en vidéo à la fin du tour (voir `proof.rs`).
	 */
	video?: { path: string; seconds: number; chapters: Array<{ at: number; url: string }> };
}

/** L'outil par lequel un agent de revue remet sa revue (voir `review.rs`). */
export const REVIEW_TOOL = "mcp__revue__remettre_revue";
/** Une revue vient d'être rangée : les écrans qui en montrent se relisent. */
export const REVIEW_EVENT = "cockpit:review";

/**
 * Au-delà, une sortie d'outil pèse plus qu'elle n'apprend.
 *
 * Un `cat` sur un fichier de données ou un test verbeux tiennent des mégaoctets
 * qu'on garderait en mémoire pour toute la conversation, et que personne ne
 * lira jusqu'au bout. On coupe, en le disant.
 */
const MAX_OUTPUT = 4000;

/** Ce qu'un message du flux apporte : des tours neufs, et des sorties à rattacher. */
interface Incoming {
	turns: Turn[];
	results: Array<{ id: string; text: string; images: string[]; error: boolean }>;
	/** Modèle et occupation du contexte, quand le message les porte. */
	context?: { model: string | null; tokens: number; window: number | null };
	/** Commandes annoncées par le CLI à son démarrage. */
	commands?: string[];
	/** Ce que la session vient d'annoncer de son équipement. */
	equipment?: Partial<Equipment>;
	/**
	 * L'appel `Task` d'où vient ce message, quand il vient d'un sous-agent.
	 *
	 * Le CLI l'étiquette (`parent_tool_use_id`) dès qu'on lui demande de parler
	 * de ses sous-agents. Sans cette étiquette, leurs messages seraient
	 * indiscernables de ceux du maître.
	 */
	parent?: string;
	/** La répartition du contexte, en réponse à `probeContext`. */
	usage?: ContextUsage;
	/** Les travaux d'arrière-plan dont le CLI vient d'annoncer la fin. */
	settled?: Array<{ toolId: string; status: string }>;
}

/**
 * Ce que le dernier tour occupe dans la fenêtre de contexte.
 *
 * Les trois entrées comptent : ce qui vient d'être envoyé, ce qui a été mis en
 * cache et ce qui en a été relu. C'est leur somme que le modèle a sous les yeux
 * — la sortie, elle, n'occupe rien tant qu'elle n'est pas renvoyée.
 */
function contextTokens(usage: Record<string, unknown> | undefined): number {
	if (!usage) return 0;
	const value = (key: string) =>
		typeof usage[key] === "number" ? (usage[key] as number) : 0;
	return (
		value("input_tokens") +
		value("cache_read_input_tokens") +
		value("cache_creation_input_tokens")
	);
}

/**
 * Taille de fenêtre du modèle — sue, jamais supposée.
 *
 * Elle était déduite du nom : sans le suffixe `[1m]`, on retenait 200 000. Or
 * les messages ordinaires annoncent `claude-opus-5` tout court alors que le
 * bilan de fin de tour, lui, dit `claude-opus-5[1m]` — la même conversation
 * porte les deux noms. Une session en fenêtre étendue voyait donc son
 * occupation multipliée par cinq : 36 000 jetons s'affichaient à 18 %, et le
 * premier tour d'un agent frais paraissait déjà bien entamé.
 *
 * Le repli « au-delà de 200 000 jetons, la fenêtre est plus large » ne
 * rattrapait rien : il ne se déclenche qu'une fois ce seuil franchi, c'est-à-dire
 * jamais dans la zone où l'affichage était faux.
 *
 * On ne devine donc plus. Le CLI donne la vraie valeur dans son bilan de fin de
 * tour (`modelUsage[modèle].contextWindow`) ; tant qu'il ne l'a pas dite, la
 * jauge montre les jetons sans prétendre à un pourcentage. Se tromper d'échelle
 * est pire que de ne pas la donner.
 */
const WIDE_WINDOW = 1_000_000;

/** Fenêtres apprises du CLI, par nom de modèle. */
const learnedWindows = new Map<string, number>();

/**
 * Ce qu'on sait de la fenêtre au moment d'un message.
 *
 * Le suffixe explicite reste une preuve. Sinon on ne retient que ce que le CLI
 * a déjà annoncé pour ce modèle — au besoin sous son autre nom, `[1m]` compris,
 * puisque c'est la même conversation.
 */
function windowFor(model: string | null, tokens = 0): number | null {
	if (model?.includes("[1m]")) return WIDE_WINDOW;
	if (model) {
		const learned = learnedWindows.get(model) ?? learnedWindows.get(`${model}[1m]`);
		if (learned) return learned;
	}
	// Dépasser une fenêtre standard prouve à soi seul qu'elle est plus large.
	if (tokens > 200_000) return WIDE_WINDOW;
	return null;
}

/**
 * Retire du fil ce que le CLI y glisse pour lui-même.
 *
 * Notifications de tâches de fond, rappels système, sorties de commandes
 * locales : autant de messages qui ne viennent de personne et s'affichaient en
 * XML brut au milieu de la conversation. Une balise ouvrante sans fermante —
 * message encore en cours d'écriture — emporte la fin du texte, plutôt que de
 * laisser du balisage à moitié fermé.
 */
const NOISE = [
	"task-notification",
	"system-reminder",
	"local-command-stdout",
	"local-command-stderr",
];

export function stripNoise(text: string): string {
	let out = text;
	for (const tag of NOISE) {
		out = out.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "g"), "");
		// Bloc encore ouvert : ce qui suit appartient au harnais, pas à la
		// conversation.
		const dangling = out.indexOf(`<${tag}`);
		if (dangling !== -1) out = out.slice(0, dangling);
	}
	return out.trim();
}

/**
 * Les fins de tâche qu'annonce un message du harnais.
 *
 * Lues avant `stripNoise`, qui les retire du fil : elles n'ont rien à y dire,
 * mais c'est le seul signal qu'un sous-agent lancé en arrière-plan a rendu la
 * main — l'appel qui l'a lancé, lui, a répondu depuis longtemps.
 */
function taskNotices(text: string): Array<{ toolId: string; status: string }> {
	const found: Array<{ toolId: string; status: string }> = [];
	for (const block of text.matchAll(/<task-notification>[\s\S]*?(?:<\/task-notification>|$)/g)) {
		const toolId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(block[0])?.[1];
		if (!toolId) continue;
		const status = /<status>\s*([^<]+?)\s*<\/status>/.exec(block[0])?.[1] ?? "completed";
		found.push({ toolId, status });
	}
	return found;
}

/**
 * Le retour d'un hook, quand ce message en est un.
 *
 * Le CLI le glisse dans le fil sous la forme d'un message « user » (« Stop hook
 * feedback: … ») : il s'affichait donc comme une consigne de ta part, et
 * ouvrait un épisode que tu n'avais jamais demandé. Rend ce que le hook a dit,
 * sans l'en-tête, et son nom ; `null` pour tout autre message.
 */
export function hookFeedback(text: string): { hook: string; text: string } | null {
	const found = /^\s*([A-Za-z]+) hook (?:feedback|blocking error)[^:\n]*:\s*/.exec(text);
	if (!found) return null;
	return { hook: found[1], text: text.slice(found[0].length).trim() };
}

/** Le tour qui remplace, dans le fil, le retour d'un hook. */
function hookTurn(feedback: { hook: string; text: string }): Turn {
	return {
		kind: "system",
		text: t("app:agents.turn.hookReminder", { hook: feedback.hook, text: feedback.text }),
	};
}

/** Les outils qui confient du travail à un sous-agent. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/**
 * Cette réponse d'outil dit-elle « lancé, je continue sans toi » ?
 *
 * Seuls les sous-agents comptent : une commande de fond (un serveur de dev)
 * peut ne jamais finir, et l'attendre laisserait l'agent « au travail » pour
 * toujours.
 */
function launchedInBackground(turn: Turn, output: string, error: boolean): boolean {
	if (error || turn.kind !== "tool" || !AGENT_TOOLS.has(turn.tool ?? "")) return false;
	return turn.input?.run_in_background === true || /^\s*Async agent launched/i.test(output);
}

/** Les sous-agents d'arrière-plan qui n'ont pas encore rendu la main. */
export function backgroundPending(turns: Turn[]): Turn[] {
	return turns.filter((turn) => turn.background && turn.background.endedAt === null);
}

/**
 * Ce qu'un `tool_result` rapporte : du texte, et parfois des images.
 *
 * Un outil qui lit une capture d'écran ne répond pas en mots : son résultat
 * porte un bloc `image` en base64, que l'on jetait avec le reste de ce qui
 * n'était pas du texte. Le fil n'en gardait qu'une ligne « Lu /tmp/x.png » et
 * l'image, pourtant là, n'était visible nulle part.
 *
 * Elles sont bornées en nombre et en poids : une conversation les garde en
 * mémoire jusqu'à sa fermeture, et trois captures pleine résolution pèsent plus
 * que tout le texte d'une longue session.
 */
const MAX_IMAGES = 4;
/** 4 Mo de base64, soit environ 3 Mo de fichier — large pour une capture. */
const MAX_IMAGE_BYTES = 4 * 1_048_576;

function resultParts(content: unknown): { text: string; images: string[] } {
	if (typeof content === "string") return { text: content, images: [] };
	if (!Array.isArray(content)) return { text: "", images: [] };

	const lines: string[] = [];
	const images: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (typeof block.text === "string" && block.text) {
			lines.push(block.text);
			continue;
		}
		if (block.type !== "image" || images.length >= MAX_IMAGES) continue;
		const source = block.source as Record<string, unknown> | undefined;
		// Deux formes possibles : les octets en base64, ou une URL que le
		// webview sait charger seul.
		if (typeof source?.data === "string" && source.data.length <= MAX_IMAGE_BYTES) {
			const type =
				typeof source.media_type === "string" ? source.media_type : "image/png";
			images.push(`data:${type};base64,${source.data}`);
		} else if (typeof source?.url === "string") {
			images.push(source.url);
		}
	}
	return { text: lines.join("\n"), images };
}

export interface AgentRun {
	/** Clé locale, connue dès l'ouverture — le backend, lui, répond plus tard. */
	id: string;
	sessionId: string | null;
	/** Session Claude Code, nécessaire pour reprendre le fil après un redémarrage. */
	claudeSessionId: string | null;
	cwd: string;
	label: string;
	mode: string;
	/** Modèle demandé au lancement ; vide = celui du poste. */
	model: string;
	/** Modèle réellement employé, tel que le CLI le rapporte. */
	activeModel: string | null;
	/**
	 * Commandes « / » que ce CLI accepte, telles qu'il les annonce au démarrage.
	 *
	 * C'est la seule liste qui fasse foi : elle contient les commandes du dépôt,
	 * les personnelles, celles des plugins et celles que les skills exposent —
	 * là où un balayage de dossiers n'en voit qu'une partie.
	 */
	commands: string[];
	/** Serveurs, skills et sous-agents dont cette session dispose. */
	equipment: Equipment;
	/** Jetons occupés dans la fenêtre de contexte, au dernier tour. */
	contextTokens: number;
	/** Taille de la fenêtre du modèle, quand le CLI l'annonce. */
	contextWindow: number | null;
	/** De quoi ce contexte est rempli, compté par le CLI — absent tant qu'aucune
	    mesure n'est revenue. */
	usage?: ContextUsage;
	/**
	 * Le moteur ne sait pas mesurer son contexte (Codex, Gemini) : on cesse de
	 * le lui demander, et la carte le dit plutôt que d'inventer.
	 */
	noUsage?: boolean;
	turns: Turn[];
	running: boolean;
	thinking: boolean;
	activity: string | null;
	/** Messages arrivés pendant que le panneau montrait autre chose. */
	unread: number;
	/**
	 * `review` : un agent qui relit une PR, en lecture seule. Retenu pour qu'une
	 * relance (mode, modèle) ne lui rende pas l'écriture.
	 */
	profile?: string;
	/** Lancé comme agent libre : il vit dans son écran, pas dans Workspaces. */
	free?: boolean;
	/** Compte imposé au lancement — gardé pour que les relances le reprennent. */
	account?: string;
	/** Profondeur demandée au lancement, pour la même raison. */
	depth?: string;
}

/** Ce qu'un agent libre fixe lui-même au lancement, au lieu des réglages du moment. */
export interface LibreLaunch {
	mode: string;
	model: string;
	account: string;
	depth: string;
}

/**
 * Niveaux d'autorisation du CLI, du plus prudent au plus permissif.
 *
 * Le choix se fait au lancement : `--permission-mode` est un drapeau de ligne
 * de commande, un agent ne change pas d'avis en cours de route. On sait quand
 * même en changer — en le relançant sur la même session Claude.
 */
export const PERMISSION_MODES: Array<{
	id: string;
	label: string;
	hint: string;
}> = ["plan", "default", "acceptEdits", "bypassPermissions"].map((id) => ({
	id,
	// Lus à l'affichage, pas au chargement du module : la langue n'y est pas
	// encore connue.
	get label() {
		return t(`app:agents.modes.${id}.label`);
	},
	get hint() {
		return t(`app:agents.modes.${id}.hint`);
	},
}));

export function modeLabel(id: string): string {
	return PERMISSION_MODES.find((entry) => entry.id === id)?.label ?? id;
}

/** Un modèle proposé au lancement, et ce qu'il coûte. */
export interface ModelSpec {
	/** Alias passé à `--model`. Vide = on ne passe rien. */
	id: string;
	label: string;
	hint: string;
	/**
	 * Le compteur d'abonnement sur lequel il tire, tel que le CLI l'intitule.
	 *
	 * `""` quand ça dépend du modèle réellement retenu. Sert à retrouver, dans
	 * le dernier relevé de `/usage`, la ligne qui parle de ce modèle-là : c'est
	 * la seule réponse honnête à « est-ce compris dans le forfait ».
	 */
	quota: string;
	/**
	 * Tarif public de l'API, en dollars par million de jetons.
	 *
	 * Ne concerne que les moteurs branchés sur une clé d'API : sur un
	 * abonnement, rien n'est débité et c'est le quota qui décide. `null` quand
	 * on ne sait pas — on ne devine pas un prix.
	 */
	price: { in: number; out: number } | null;
}

/**
 * Modèles proposés au lancement.
 *
 * Des alias, pas des identifiants : le CLI les résout lui-même vers la version
 * courante, et une liste d'identifiants figés vieillirait au premier nouveau
 * modèle. L'entrée vide laisse le réglage du poste décider — c'est ce qu'on
 * veut la plupart du temps.
 *
 * **Choisir un modèle est une décision de coût**, et elle se prenait à
 * l'aveugle : la liste ne disait ni ce que chacun consomme, ni sur quel
 * compteur. Deux choses répondent, et elles ne se remplacent pas — le compteur
 * d'abonnement pour qui paie un forfait, le tarif de l'API pour qui branche une
 * clé. Les deux figurent, chacun annoncé pour ce qu'il est.
 */
export const MODELS: ModelSpec[] = [
	{
		id: "",
		get label() {
			return t("app:agents.models.default.label");
		},
		get hint() {
			return t("app:agents.models.default.hint");
		},
		quota: "",
		price: null,
	},
	{
		id: "fable",
		label: "Fable",
		get hint() {
			return t("app:agents.models.fable.hint");
		},
		// Fable a son propre plafond hebdomadaire, annoncé à part par le CLI :
		// l'épuiser ne coupe pas les autres modèles, et inversement.
		quota: "Fable",
		price: { in: 10, out: 50 },
	},
	{
		id: "opus",
		label: "Opus",
		get hint() {
			return t("app:agents.models.opus.hint");
		},
		quota: "",
		price: { in: 5, out: 25 },
	},
	{
		id: "sonnet",
		label: "Sonnet",
		get hint() {
			return t("app:agents.models.sonnet.hint");
		},
		quota: "",
		price: { in: 3, out: 15 },
	},
	{
		id: "haiku",
		label: "Haiku",
		get hint() {
			return t("app:agents.models.haiku.hint");
		},
		quota: "",
		price: { in: 1, out: 5 },
	},
];

export function modelLabel(id: string): string {
	return MODELS.find((entry) => entry.id === id)?.label ?? readableModel(id);
}

export function modelSpec(id: string): ModelSpec | null {
	return MODELS.find((entry) => entry.id === id) ?? null;
}

/**
 * Les modèles proposés pour un moteur, dans l'ordre où il les déclare.
 *
 * La liste figée ne suivait pas les sorties : un modèle paru la veille
 * n'existait pas pour le cockpit tant qu'une version ne l'avait pas ajouté, et
 * l'alias `opus` peut rester sur l'ancien pendant ce temps. Ce que le moteur
 * déclare dans les réglages fait foi — un identifiant complet comme
 * `claude-opus-5-5` s'y ajoute d'une ligne. Les alias connus gardent leur
 * fiche ; un identifiant inconnu n'a ni tarif ni compteur, parce qu'on ne les
 * devine pas.
 */
export function modelChoices(declared: string[]): ModelSpec[] {
	const ids = declared.map((id) => id.trim()).filter(Boolean);
	const source = ids.length > 0 ? ids : MODELS.map((entry) => entry.id).filter(Boolean);
	const choices = [...new Set(source)].map(
		(id): ModelSpec =>
			modelSpec(id) ?? {
				id,
				label: readableModel(id),
				hint: id,
				quota: modelFamily(id) === "fable" ? "Fable" : "",
				price: null,
			},
	);
	return [MODELS[0], ...choices];
}

/** L'identifiant tel que demandé, sans le suffixe de fenêtre longue. */
export function modelCore(id: string | null): string {
	return (id ?? "").replace("[1m]", "").trim();
}

/**
 * Le compteur d'abonnement qui parle de ce modèle, dans un relevé donné.
 *
 * Le CLI intitule ses lignes pour un humain — « Cette semaine », « Cette
 * semaine (Fable) » — et c'est cet intitulé qui distingue un modèle à compteur
 * dédié d'un modèle qui puise au commun. On rapproche sur le nom, faute de
 * mieux, et on ne rend rien plutôt que de rapprocher à tort : afficher le
 * mauvais pourcentage serait pire que n'en afficher aucun.
 */
export function modelQuota(
	spec: ModelSpec,
	quotas: Array<{ kind?: string; label: string; percent: number; resetsAt: string }>,
): { label: string; percent: number; resetsAt: string } | null {
	if (!spec.id) return null;
	// `kind` plutôt que l'intitulé, qui est traduit.
	const weekly = quotas.filter((entry) => entry.kind === "week");
	if (weekly.length === 0) return null;
	if (spec.quota) {
		return weekly.find((entry) => entry.label.includes(`(${spec.quota})`)) ?? null;
	}
	// Les autres tirent sur le compteur commun : celui qui ne nomme personne.
	return weekly.find((entry) => !entry.label.includes("(")) ?? null;
}

/**
 * Nom court d'un modèle rapporté par le CLI.
 *
 * « claude-opus-5[1m] » devient « opus-5 · 1M » : ce qu'on veut lire d'un coup
 * d'œil, c'est la famille et si la grande fenêtre est active.
 */
/**
 * La famille d'un modèle, quel que soit le nom sous lequel il arrive.
 *
 * On demande un alias — `opus`, `sonnet`, `haiku` — et le CLI rapporte un
 * identifiant complet, daté : `claude-haiku-4-5-20251001`. Les deux désignent
 * la même chose, et sans ce rapprochement le sélecteur cochait ce qu'on avait
 * demandé pendant que le bouton affichait ce qui tournait vraiment.
 */
export function modelFamily(id: string | null): string {
	if (!id) return "";
	const known = MODELS.map((entry) => entry.id).filter(Boolean);
	const lower = id.toLowerCase();
	return known.find((family) => lower.includes(family)) ?? "";
}

export function shortModel(id: string | null): string | null {
	if (!id) return null;
	const wide = id.includes("[1m]");
	const core = id.replace("claude-", "").replace("[1m]", "");
	return wide ? `${core} · 1M` : core;
}

/**
 * Ce qu'on peut demander au registre, sans rien savoir de son contenu.
 *
 * Séparé de l'état parce qu'un agent qui parle produit plusieurs événements par
 * seconde : tant qu'un seul contexte portait les deux, chaque phrase reçue
 * l'invalidait pour tout le monde et rendait à nouveau des écrans qui ne
 * voulaient que `open` — le cockpit entier, à chaque message. Ces fonctions ont
 * une identité stable : leur contexte, lui, ne bouge pas.
 */
/**
 * Ce qui accompagne un message sans y figurer.
 *
 * `display` est ce que le fil montre — la consigne telle qu'elle a été tapée ;
 * `context` nomme le dossier joint, pour que le tour reste explicable après coup.
 */
export interface SendExtras {
	display?: string;
	context?: string;
	/** Suite de la consigne en cours, ou nouvelle consigne : choisi à l'envoi. */
	follows?: boolean;
}

interface AgentActions {
	setDefaultMode: (mode: string) => void;
	setAutoApprove: (value: boolean) => void;
	/** Change le modèle, en relançant l'agent sur le même fil. */
	changeModel: (runId: string, model: string) => void;

	/**
	 * Ouvre une conversation. `historyFile` est le JSONL d'une session reprise :
	 * son contenu s'affiche avant les nouveaux messages. `fresh` force une
	 * seconde conversation sur un dossier qui en a déjà une — deux agents sur le
	 * même worktree, c'est un choix, pas une méprise.
	 */
	open: (
		cwd: string,
		prompt?: string,
		resume?: string,
		historyFile?: string,
		fresh?: boolean,
		/** `review` : lecture seule — voir `review.rs`. `libre` : un agent libre,
		    qui reste hors de l'écran Workspaces. */
		options?: { profile?: string; label?: string; libre?: LibreLaunch },
	) => string | undefined;
	send: (runId: string, text: string, joined?: SendExtras) => void;
	stop: (runId: string) => void;
	/** Arrête l'agent et retire la conversation. */
	close: (runId: string) => void;
	/** Met la conversation au premier plan, en dépliant son groupe. */
	show: (runId: string) => void;
	/** Change le mode d'autorisation, en relançant l'agent sur le même fil. */
	changeMode: (runId: string, mode: string) => void;
	decide: (id: string, allow: boolean, reason?: string) => void;
	/** Renvoie à l'agent ce qu'on a choisi dans son `AskUserQuestion`. */
	answer: (id: string, answers: Array<{ header: string; choice: string }>) => void;
}

/** L'état, qui lui change à chaque message reçu. */
interface AgentState {
	runs: AgentRun[];
	/** Mode appliqué aux prochains lancements, retenu d'une fois sur l'autre. */
	defaultMode: string;
	autoApprove: boolean;
	pendingFor: (runId: string) => PermissionRequest[];
	pendingForSession: (sessionId: string | null | undefined) => PermissionRequest[];
}

/**
 * Ce qui attend une décision, et le réglage du filet.
 *
 * Quatrième contexte, pour la même raison que les autres : une conversation
 * n'a pas besoin de savoir qu'un autre agent vient de parler. Tant qu'elle
 * lisait `pendingFor` dans l'état complet, chaque phrase reçue — plusieurs par
 * seconde, tous agents confondus — la faisait rendre à nouveau, avec ses six
 * cents tours recréés au passage. Ces valeurs-là ne bougent qu'à l'arrivée
 * d'une demande d'autorisation ou d'un changement de réglage.
 */
interface AgentGuard {
	autoApprove: boolean;
	pendingFor: (runId: string) => PermissionRequest[];
	/**
	 * Ce qui attend, désigné par la session de l'agent plutôt que par sa
	 * conversation.
	 *
	 * L'écran Missions ne connaît de ses exécutants que leur session : il ne
	 * tient pas de conversation ouverte, et exiger qu'il en trouve une reviendrait
	 * à renvoyer l'utilisateur dans Workspaces — précisément ce qu'on lui évite.
	 */
	pendingForSession: (sessionId: string | null | undefined) => PermissionRequest[];
}

interface AgentRunsStore extends AgentActions, AgentState {}

const ActionsContext = createContext<AgentActions | null>(null);
const StateContext = createContext<AgentState | null>(null);
const GuardContext = createContext<AgentGuard | null>(null);

/**
 * Sessions Claude ouvertes en ce moment, par identifiant de session.
 *
 * Troisième contexte, et non un champ de l'état : la vue Agents a besoin de
 * savoir si la session qu'elle affiche est déjà vivante ailleurs — pour ne pas
 * en montrer une copie figée à côté — et c'est tout ce qu'elle a besoin de
 * savoir. Le lui donner depuis l'état complet la ferait rendre à nouveau à
 * chaque phrase reçue, avec sa timeline de cinq cents événements. Cette table,
 * elle, ne bouge qu'à l'ouverture et à la fermeture d'une conversation.
 */
const OpenSessionsContext = createContext<ReadonlyMap<string, string>>(new Map());

/** Au-delà, la conversation n'apporte plus rien et le rendu devient coûteux. */
const MAX_TURNS = 600;

/** Les chaînes d'un tableau du CLI, quand il en envoie un. */
function strings(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? (value as unknown[]).filter((entry): entry is string => typeof entry === "string")
		: undefined;
}

function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

/** Ce que l'UI sait tirer d'un message du CLI. */
function readEvent(payload: Record<string, unknown>): Incoming {
	const type = payload.type as string | undefined;
	const nothing: Incoming = { turns: [], results: [] };

	if (type === "cockpit") {
		const subtype = payload.subtype as string;
		if (subtype === "ended") {
			return { turns: [{ kind: "system", text: t("app:agents.turn.ended") }], results: [] };
		}
		if (subtype === "preuve" && typeof payload.path === "string") {
			const seconds = typeof payload.seconds === "number" ? payload.seconds : 0;
			const chapters = (Array.isArray(payload.chapters) ? payload.chapters : [])
				.map((chapter) => chapter as Record<string, unknown>)
				.filter((chapter) => typeof chapter.at === "number" && typeof chapter.url === "string")
				.map((chapter) => ({ at: chapter.at as number, url: chapter.url as string }));
			return {
				turns: [
					{
						kind: "system",
						text: t("app:agents.turn.proofFilmed", { seconds: Math.round(seconds) }),
						video: { path: payload.path, seconds, chapters },
						at: Date.now(),
					},
				],
				results: [],
			};
		}
		return { turns: [{ kind: "error", text: String(payload.text ?? "") }], results: [] };
	}

	if (type === "system" && payload.subtype === "compact_boundary") {
		const meta = (payload.compact_metadata ?? {}) as Record<string, unknown>;
		const preTokens = typeof meta.pre_tokens === "number" ? meta.pre_tokens : null;
		const trigger = typeof meta.trigger === "string" ? meta.trigger : "auto";
		return {
			turns: [
				{
					kind: "system",
					text:
						trigger === "manual"
							? t("app:agents.turn.compactedManual")
							: t("app:agents.turn.compactedAuto"),
					compact: { trigger, preTokens },
				},
			],
			results: [],
		};
	}

	// La fin d'une tâche de fond, quand le CLI l'annonce par un message à part.
	if (type === "system" && payload.subtype === "task_notification") {
		const toolId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
		if (!toolId) return nothing;
		const status = typeof payload.status === "string" ? payload.status : "completed";
		return { turns: [], results: [], settled: [{ toolId, status }] };
	}

	if (type === "system") {
		// Le message d'initialisation ne s'affiche pas, mais il dit sur quel
		// modèle le CLI a démarré — avant même la première réponse. Sans lui, la
		// conversation ne savait pas ce qu'elle utilisait tant que l'agent
		// n'avait pas parlé, ce qui est précisément le moment où on se pose la
		// question.
		const model = typeof payload.model === "string" ? payload.model : null;
		const commands = strings(payload.slash_commands);
		// Ce que la session charge vraiment : ses skills, ses sous-agents, ses
		// plugins. Listés une fois au démarrage et stables ensuite — un skill ne
		// se déconnecte pas. Les serveurs, eux, ne sont pas pris ici : à cet
		// instant la plupart sont encore en train de se connecter, et les
		// afficher reviendrait à annoncer des pannes qui n'existent pas.
		const plugins = Array.isArray(payload.plugins)
			? (payload.plugins as Array<Record<string, unknown>>)
					.map((entry) => (typeof entry?.name === "string" ? entry.name : ""))
					.filter(Boolean)
			: undefined;
		const equipment =
			payload.subtype === "init"
				? {
						skills: strings(payload.skills) ?? [],
						subagents: strings(payload.agents) ?? [],
						plugins: plugins ?? [],
					}
				: undefined;
		if (!model && !commands && !equipment) return nothing;
		return {
			turns: [],
			results: [],
			context: model ? { model, tokens: 0, window: windowFor(model) } : undefined,
			commands,
			equipment,
		};
	}

	// La réponse à la question posée par `probe_mcp`. Elle n'a pas de chemin à
	// elle : le CLI la renvoie dans le flux, au milieu de la conversation, et
	// c'est ici qu'on la reconnaît. C'est la seule source qui dise l'état réel
	// des serveurs — celui annoncé au démarrage n'est qu'un instantané pris
	// avant que les connexions aboutissent.
	if (type === "control_response") {
		const enveloppe = payload.response as Record<string, unknown> | undefined;
		const corps = enveloppe?.response as Record<string, unknown> | undefined;
		// La mesure du contexte, allégée côté natif (`chantier::slim`). Elle porte
		// aussi une liste `mcpServers` — résumée par serveur, sans statut — : la
		// reconnaître d'abord, sinon elle passerait pour un état des serveurs.
		if (corps?.cockpit === "context") {
			return {
				turns: [],
				results: [],
				usage: { ...(corps as unknown as ContextUsage), at: Date.now() },
			};
		}
		const bruts = corps?.mcpServers;
		if (!Array.isArray(bruts)) return nothing;
		const servers = (bruts as Array<Record<string, unknown>>)
			.filter((entry) => typeof entry?.name === "string")
			.map((entry) => ({
				name: String(entry.name),
				status: typeof entry.status === "string" ? entry.status : "unknown",
			}));
		return { turns: [], results: [], equipment: { servers, probed: true } };
	}

	if (type === "result") {
		const error = payload.is_error === true;
		const text = String(payload.result ?? "");
		// Le bilan de fin de tour porte la taille de fenêtre du modèle, que les
		// messages ordinaires ne disent pas.
		const models = payload.modelUsage as
			Record<string, { contextWindow?: number }> | undefined;
		// Un tour peut faire intervenir plusieurs modèles — un sous-agent rapide
		// à côté du principal. Prendre la première entrée revenait à échelonner
		// la conversation sur la fenêtre du plus petit ; c'est la plus large qui
		// dit ce que le fil peut contenir.
		const annonces = Object.entries(models ?? {}).filter(
			([, infos]) => typeof infos?.contextWindow === "number",
		);
		for (const [nom, infos] of annonces) {
			learnedWindows.set(nom, infos.contextWindow as number);
		}
		const plusLarge = annonces.reduce<[string, number] | null>(
			(garde, [nom, infos]) => {
				const taille = infos.contextWindow as number;
				return garde && garde[1] >= taille ? garde : [nom, taille];
			},
			null,
		);
		const context = plusLarge
			? { model: plusLarge[0], tokens: 0, window: plusLarge[1] }
			: undefined;
		const turns: Turn[] = error && text ? [{ kind: "error", text }] : [];
		return { turns, results: [], context };
	}

	const message = payload.message as { content?: unknown } | undefined;
	// Ce que le harnais écrit lui-même (notification, retour de hook) arrive
	// parfois en simple chaîne : même lecture qu'un bloc de texte.
	const content =
		type === "user" && typeof message?.content === "string"
			? [{ type: "text", text: message.content }]
			: message?.content;
	if (!Array.isArray(content)) return nothing;

	const parent =
		typeof payload.parent_tool_use_id === "string" ? payload.parent_tool_use_id : undefined;

	const turns: Turn[] = [];
	const results: Incoming["results"] = [];
	const settled: NonNullable<Incoming["settled"]> = [];

	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
			if (type === "user") {
				settled.push(...taskNotices(block.text));
				// Un message réduit au seul bruit du harnais n'a rien à dire : il
				// disparaît plutôt que de laisser une bulle vide dans le fil.
				const text = stripNoise(block.text);
				const feedback = hookFeedback(text);
				if (feedback) turns.push(hookTurn(feedback));
				else if (text) turns.push({ kind: "user", text });
			} else {
				turns.push({ kind: "assistant", text: block.text });
			}
		}
		if (block.type === "tool_use") {
			const input = (block.input ?? {}) as Record<string, unknown>;
			// L'entrée entière est conservée : c'est elle qui permet de dire ce
			// que l'appel fait — quel fichier, quelle commande, quel motif —
			// plutôt que de n'afficher que le nom de l'outil.
			const hint =
				(input.command as string) ??
				(input.file_path as string) ??
				(input.pattern as string) ??
				(input.description as string) ??
				"";
			turns.push({
				kind: "tool",
				tool: String(block.name ?? "outil"),
				toolId: typeof block.id === "string" ? block.id : undefined,
				at: Date.now(),
				input,
				text: typeof hint === "string" ? hint.split("\n")[0].slice(0, 160) : "",
			});
		}
		// La réponse de l'outil, qui arrive dans un message « user » : c'est ce
		// qu'on ne montrait pas, et sans quoi un appel n'est qu'une intention.
		if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
			const { text, images } = resultParts(block.content);
			results.push({
				id: block.tool_use_id,
				text: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…` : text,
				images,
				error: block.is_error === true,
			});
		}
	}
	// Un message d'assistant porte le modèle employé et l'état du contexte.
	const usage = (message as { usage?: Record<string, unknown> } | undefined)?.usage;
	const model = (message as { model?: string } | undefined)?.model ?? null;
	const context =
		usage || model
			? (() => {
					const tokens = contextTokens(usage);
					return { model, tokens, window: windowFor(model, tokens) };
				})()
			: undefined;

	// Le coût d'un sous-agent est déjà compté dans celui du tour qui l'a lancé :
	// remonter son usage ferait avancer la jauge de contexte deux fois.
	return parent ? { turns, results, parent } : { turns, results, context, settled };
}

/**
 * Rattache les sorties à leurs appels.
 *
 * Recherche depuis la fin : la réponse suit son appel de près, et remonter tout
 * le fil à chaque outil coûterait cher sur une longue conversation.
 */
function attachResults(turns: Turn[], results: Incoming["results"]): Turn[] {
	if (results.length === 0) return turns;
	const next = [...turns];
	for (const result of results) {
		for (let index = next.length - 1; index >= 0; index -= 1) {
			if (next[index].toolId === result.id) {
				// On ne garde en mémoire que ce qu'on ne saurait pas relire : un
				// outil qui a lu une image du disque en renvoie aussi les octets,
				// et les conserver doublerait le poids de la conversation pour
				// afficher un fichier qui est toujours là, à son chemin.
				const onDisk = next[index].input?.file_path;
				const keep =
					result.images.length > 0 &&
					!(typeof onDisk === "string" && isImagePath(onDisk));
				next[index] = {
					...next[index],
					output: result.text,
					outputImages: keep ? result.images : undefined,
					outputError: result.error,
					doneAt: Date.now(),
					background: launchedInBackground(next[index], result.text, result.error)
						? (next[index].background ?? { endedAt: null })
						: next[index].background,
				};
				break;
			}
		}
	}
	return next;
}

/**
 * Convertit une session déjà écrite sur disque en conversation affichable.
 *
 * Reprendre un agent sans rien montrer de ce qui précède obligerait à relire la
 * timeline dans un autre écran pour savoir où on en était.
 */
function historyTurns(events: SessionEvent[]): Turn[] {
	const turns: Turn[] = [];
	for (const event of events) {
		// Les sous-agents ont leur propre écran : les mêler ici brouillerait le fil.
		if (event.isSidechain) continue;
		const parsed = event.timestamp ? Date.parse(event.timestamp) : Number.NaN;
		const at = Number.isNaN(parsed) ? undefined : parsed;
		if (event.kind === "user" && event.text.trim()) {
			const feedback = hookFeedback(event.text);
			turns.push(feedback ? { ...hookTurn(feedback), at } : { kind: "user", text: event.text, at });
		} else if (event.kind === "assistant" && event.text.trim()) {
			turns.push({ kind: "assistant", text: event.text, at });
		} else if (event.kind === "tool") {
			// Le détail est l'entrée de l'outil, en JSON : on la relit en entier.
			// N'en garder que la première ligne donnait « { » pour titre à chaque
			// appel d'une conversation reprise, et perdait le fichier touché, la
			// commande lancée, la mission confiée au sous-agent.
			let input: Record<string, unknown> | undefined;
			try {
				const parsed: unknown = JSON.parse(event.detail ?? "");
				if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
			} catch {
				input = undefined;
			}
			turns.push({
				kind: "tool",
				tool: event.tool ?? "outil",
				text: event.text.trim() || (event.detail ?? "").split("\n")[0].slice(0, 160),
				input,
				at,
			});
		} else if (event.kind === "tool-result" || event.kind === "tool-error") {
			// Le journal ne relie pas une réponse à son appel : il les écrit dans
			// l'ordre. On rattache donc au dernier outil encore sans réponse, ce
			// qui est exact tant qu'un appel se termine avant que le suivant
			// commence — c'est le cas d'un fil séquentiel.
			const last = [...turns]
				.reverse()
				.find((turn) => turn.kind === "tool" && !turn.output);
			if (last) {
				const body = event.detail ?? event.text;
				last.output = body.length > MAX_OUTPUT ? `${body.slice(0, MAX_OUTPUT)}\n…` : body;
				last.outputError = event.kind === "tool-error";
			}
		}
	}
	// Un outil relu du journal n'attend plus rien : sans réponse trouvée, sa
	// sortie est vide, pas « à venir ». Faute de quoi il tournerait sans fin.
	for (const turn of turns) {
		if (turn.kind === "tool" && turn.output === undefined) turn.output = "";
	}

	// Seule la fin de la conversation aide à reprendre le fil.
	return turns.slice(-120);
}

/**
 * Cette demande est-elle une question posée à l'utilisateur ?
 *
 * `AskUserQuestion` emprunte le canal des autorisations faute d'en avoir un
 * autre — un agent lancé sans terminal n'a aucune interface pour interroger qui
 * que ce soit — mais rien de ce qui vaut pour une permission ne vaut pour elle.
 */
export function isQuestion(request: PermissionRequest): boolean {
	return request.tool === "AskUserQuestion" && readQuestions(request.input).length > 0;
}

/**
 * Le fil d'un sous-agent, complété de ce qui vient d'arriver.
 *
 * Ses réponses d'outils se rattachent à ses propres appels : un `Grep` lancé
 * par un sous-agent et un `Grep` lancé par le maître portent des identifiants
 * différents, mais les chercher dans le mauvais fil ne rattacherait rien.
 *
 * Borné plus court que la conversation : un sous-agent qui part en boucle ne
 * doit pas peser sur la mémoire du fil qui l'héberge.
 */
const MAX_SUB_TURNS = 200;

function appendSub(
	existing: Turn[],
	incoming: Turn[],
	results: Incoming["results"],
): Turn[] {
	const turns = attachResults([...existing, ...incoming], results);
	return turns.length > MAX_SUB_TURNS ? turns.slice(-MAX_SUB_TURNS) : turns;
}

function appendTurns(run: AgentRun, incoming: Turn[]): Turn[] {
	const now = Date.now();
	const turns = [...run.turns, ...incoming.map((turn) => (turn.at ? turn : { ...turn, at: now }))];
	return turns.length > MAX_TURNS ? turns.slice(-MAX_TURNS) : turns;
}

/**
 * Deux agents ouverts, pour que l'écran Workspaces existe hors de Tauri.
 *
 * Les agents ne se listent pas au démarrage : ils naissent d'un lancement et
 * vivent dans ce registre. Hors du pont natif, personne ne les lance — l'écran
 * s'ouvrait donc sur « Aucun workspace ouvert », et il était impossible d'y
 * regarder quoi que ce soit. Un agent qui parle, un autre à l'arrêt : de quoi
 * juger les deux états.
 */
function previewRuns(): AgentRun[] {
	if (!isPreview()) return [];
	const common = {
		mode: "acceptEdits",
		model: "",
		activeModel: "claude-opus-5",
		commands: ["/pull-request-creation", "/review"],
		equipment: {
			probed: true,
			servers: [
				{ name: "linear", status: "connected" },
				{ name: "claude.ai Sentry", status: "connected" },
				{ name: "stripe", status: "needs-auth" },
				{ name: "figma-dev-mode", status: "failed" },
			],
			skills: ["performing-self-qa", "writing-tests", "product-write-task"],
			subagents: ["Explore", "Plan", "code-simplifier"],
			plugins: ["figma"],
		},
		contextWindow: 200_000,
		unread: 0,
	};
	// Une mesure telle que le CLI la rend, pour que la jauge du chantier se
	// voie en aperçu : rien ne répond à `probeContext` hors du pont natif.
	const usage = (messages: number, tools: Array<[string, number, number]>): ContextUsage => ({
		totalTokens: 21_400 + messages,
		maxTokens: 200_000,
		percentage: Math.round(((21_400 + messages) / 200_000) * 100),
		model: "claude-opus-5",
		autoCompactThreshold: 167_000,
		isAutoCompactEnabled: true,
		categories: [
			{ name: "System prompt", tokens: 2_300, kind: "used" },
			{ name: "System tools", tokens: 3_100, kind: "used" },
			{ name: "MCP tools", tokens: 5_600, kind: "used" },
			{ name: "MCP server instructions", tokens: 2_600, kind: "used" },
			{ name: "MCP tools (deferred)", tokens: 38_000, kind: "deferred" },
			{ name: "Memory files", tokens: 4_200, kind: "used" },
			{ name: "Skills", tokens: 3_600, kind: "used" },
			{ name: "Messages", tokens: messages, kind: "used" },
			{ name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
			{ name: "Free space", tokens: 200_000 - 21_400 - messages - 33_000, kind: "free" },
		],
		memoryFiles: [
			{ path: "/Users/demo/code/fix-cart-rounding-nw-3044/CLAUDE.md", type: "Project", tokens: 3_100 },
			{ path: "/Users/demo/.claude/CLAUDE.md", type: "User", tokens: 1_100 },
		],
		mcpServers: [
			{ name: "linear", tokens: 3_900, loaded: 6, deferred: 22 },
			{ name: "claude.ai Sentry", tokens: 1_700, loaded: 3, deferred: 14 },
		],
		skills: { total: 12, tokens: 3_600 },
		messages: {
			toolCallTokens: Math.round(messages * 0.08),
			toolResultTokens: Math.round(messages * 0.62),
			assistantMessageTokens: Math.round(messages * 0.22),
			userMessageTokens: Math.round(messages * 0.08),
			toolCallsByType: tools.map(([name, callTokens, resultTokens]) => ({ name, callTokens, resultTokens })),
		},
		at: Date.now(),
	});
	const min = (minutes: number) => Date.now() - minutes * 60_000;
	// Une capture d'écran esquissée, comme le navigateur en renvoie : une liste
	// de cartes, dont le titre déborde ou non.
	const sketch = (overflow: boolean) =>
		`data:image/svg+xml;utf8,${encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 300"><rect width="390" height="300" fill="#f4f6f8"/>${[0, 1, 2]
				.map(
					(row) =>
						`<rect x="16" y="${20 + row * 88}" width="${overflow ? 470 : 358}" height="74" rx="10" fill="${overflow ? "#fbe9e7" : "#fff"}" stroke="${overflow ? "#cf3f35" : "#d9dee4"}"/><rect x="30" y="${34 + row * 88}" width="${overflow ? 420 : 240}" height="10" rx="5" fill="#141a20"/>${overflow ? "" : `<rect x="30" y="${50 + row * 88}" width="150" height="10" rx="5" fill="#141a20"/>`}<rect x="30" y="${70 + row * 88}" width="60" height="12" rx="6" fill="#dcf1ed"/>`,
				)
				.join("")}</svg>`,
		)}`;
	return [
		{
			...common,
			id: "run-1",
			sessionId: "agent-1",
			claudeSessionId: "sess-9",
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
			label: "Lead · Fix cart total rounding",
			contextTokens: 84_000,
			usage: usage(62_600, [
				["Read", 900, 31_000],
				["Grep", 300, 4_200],
				["Edit", 2_100, 600],
				["Task", 400, 3_800],
			]),
			running: true,
			thinking: false,
			activity: "waiting for your reply",
			turns: [
				{
					kind: "user",
					text: "The cart shows €10.00 but the payment provider charges €9.99. Find where the gap comes from.\n\nAttached files, read them before replying:\n- /Users/demo/Captures/cart-total.png\n- /Users/demo/Notes/rounding-rules.md",
					context: "The branch · Ticket NW-3044 · Review #318",
					at: min(34),
				},
				{
					kind: "assistant",
					text: "Converted prices have to be rounded line by line. I'm checking how the cart computes its total.",
					at: min(33),
				},
				// Deux lectures que l'agent « Rounding rules per currency » rendra périmées
				// en écrivant ces fichiers après lui : c'est ce que la carte du
				// chantier doit montrer.
				{
					kind: "tool",
					text: "apps/web/src/cart/rounding.ts",
					tool: "Read",
					toolId: "t-r1",
					input: { file_path: "apps/web/src/cart/rounding.ts" },
					output: "Read 88 lines.",
					at: min(32),
					doneAt: min(32),
				},
				{
					kind: "tool",
					text: "apps/web/src/cart.ts",
					tool: "Read",
					toolId: "t-r2",
					input: { file_path: "apps/web/src/cart.ts" },
					output: "Read 310 lines.",
					at: min(31),
					doneAt: min(31),
				},
				{
					kind: "tool",
					text: "apps/web/src/cart/totals.ts",
					tool: "Read",
					toolId: "t-r3",
					input: { file_path: "apps/web/src/cart/totals.ts" },
					output: "Read 42 lines.",
					at: min(30),
					doneAt: min(30),
				},
				// Une écriture, pour que le récapitulatif des fichiers touchés se
				// voie en aperçu : c'est lui qui répond à « et maintenant, où est
				// le résultat ».
				{
					kind: "tool",
					text: "apps/web/src/cart.ts",
					tool: "Edit",
					toolId: "t0",
					input: { file_path: "apps/web/src/cart.ts" },
					output: "The file has been updated.",
					at: min(28),
					doneAt: min(28),
				},
				{
					kind: "tool",
					text: "",
					tool: "Grep",
					toolId: "t1",
					input: { pattern: "lineTotal|toFixed", path: "apps/web/src" },
					output:
						"apps/web/src/cart.ts:142  const total = lines.reduce((sum, line) => sum + line.price * line.qty, 0);",
				},
				// Une délégation en cours, pour que le fil d'un sous-agent se voie
				// en aperçu : c'est le seul endroit où l'on peut juger un fil
				// imbriqué, un vrai sous-agent ne vivant que dans la fenêtre native.
				{
					kind: "tool",
					text: "cover the per-line rounding rule",
					tool: "Task",
					toolId: "t2",
					at: Date.now() - 195_000,
					// Parti en arrière-plan : l'appel a répondu, le sous-agent court
					// encore — c'est l'état que la carte ne doit pas dire « terminé ».
					output: "Async agent launched successfully.",
					doneAt: Date.now() - 194_000,
					background: { endedAt: null },
					input: {
						description: "cover the per-line rounding rule",
						subagent_type: "general-purpose",
					},
					sub: [
						{
							kind: "user",
							text: "Write the cart total tests: single currency, EUR to USD, a discount line, a zero-price line.",
						},
						{
							kind: "tool",
							text: "",
							tool: "Read",
							toolId: "s1",
							input: { file_path: "apps/web/src/cart.test.ts" },
							output: "Read 31 lines.",
						},
						{
							kind: "assistant",
							text: "The file has no multi-currency case. I'm adding all four.",
						},
						{
							kind: "tool",
							text: "",
							tool: "Edit",
							toolId: "s2",
							input: {
								file_path: "apps/web/src/cart.test.ts",
								old_string: "x",
								new_string: "y\nz\nw",
							},
						},
					],
				},
				{
					kind: "assistant",
					text: "It is `toFixed(2)` on the raw sum: no per-line rounding. I'm fixing it, but should converted prices round half-to-even, as the ticket asks?",
				},
			],
		},
		{
			...common,
			id: "run-2",
			sessionId: "agent-3",
			claudeSessionId: "sess-1",
			cwd: "/Users/demo/code/storefront-topic-2",
			label: "Cart totals",
			contextTokens: 21_000,
			running: false,
			thinking: false,
			activity: null,
			// Trois consignes, datées : de quoi voir la session entière sur la
			// carte, les épisodes passés repliés, et des durées qui ont un sens.
			turns: [
				{ kind: "user", text: "Explain how loyalty points are granted after a payment.", at: Date.now() - 48 * 60_000 },
				{ kind: "tool", tool: "Grep", text: "grant_points", input: { pattern: "grant_points" }, output: "3 files", at: Date.now() - 47 * 60_000, doneAt: Date.now() - 47 * 60_000 },
				{ kind: "tool", tool: "Read", text: "loyalty/points.ts", input: { file_path: "src/loyalty/points.ts" }, output: "…", at: Date.now() - 46 * 60_000, doneAt: Date.now() - 46 * 60_000 },
				{ kind: "assistant", text: "Points are granted in the `invoice.paid` webhook, once per invoice. Should I look at refunds too?", at: Date.now() - 44 * 60_000 },
				{ kind: "user", text: "No, just that for now.", at: Date.now() - 43 * 60_000 },
				{ kind: "assistant", text: "Okay, I'll stop there.", at: Date.now() - 43 * 60_000 },
				{ kind: "user", text: "Add a test that replays the same webhook twice.", at: Date.now() - 40 * 60_000 },
				{ kind: "tool", tool: "Write", text: "points.test.ts", input: { file_path: "src/loyalty/points.test.ts", content: "a\nb\nc\nd\ne\nf" }, output: "ok", at: Date.now() - 38 * 60_000, doneAt: Date.now() - 38 * 60_000 },
				{ kind: "tool", tool: "Bash", text: "npm test", input: { command: "npm test -- points" }, output: "1 failed", outputError: true, at: Date.now() - 37 * 60_000, doneAt: Date.now() - 36 * 60_000 },
				{ kind: "assistant", text: "The test fails: the replayed webhook grants the points twice. That's a real bug.", at: Date.now() - 35 * 60_000 },
				{ kind: "user", text: "Restore loyalty points after a failed checkout.", at: Date.now() - 20 * 60_000 },
				{ kind: "tool", tool: "Edit", text: "points.ts", input: { file_path: "src/loyalty/points.ts", old_string: "a", new_string: "a\nb\nc" }, output: "ok", at: Date.now() - 16 * 60_000, doneAt: Date.now() - 16 * 60_000 },
				{ kind: "tool", tool: "Bash", text: "npm test", input: { command: "npm test -- points" }, output: "ok", at: Date.now() - 12 * 60_000, doneAt: Date.now() - 11 * 60_000 },
				{
					kind: "assistant",
					text: "The restore must not replay points already granted. I added the guard and the tests pass.",
					at: Date.now() - 9 * 60_000,
				},
			],
		},
		// Un second agent sur le même worktree, qui écrit après le maître dans
		// deux fichiers que celui-ci a lus : de quoi voir une collision et une
		// lecture périmée sur la carte du chantier.
		{
			...common,
			id: "run-4",
			sessionId: "agent-5",
			claudeSessionId: "sess-5",
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
			label: "Rounding rules per currency",
			contextTokens: 41_000,
			usage: usage(19_600, [
				["Read", 500, 9_800],
				["Edit", 1_700, 400],
				["Bash", 300, 2_900],
			]),
			running: true,
			thinking: true,
			activity: "Edit",
			turns: [
				{ kind: "user", text: "Move the rounding rules into a per-currency module, with their tests.", at: min(26) },
				{ kind: "tool", tool: "Read", text: "rounding.ts", toolId: "u1", input: { file_path: "apps/web/src/cart/rounding.ts" }, output: "Read 88 lines.", at: min(25), doneAt: min(25) },
				{ kind: "tool", tool: "Read", text: "currencies", toolId: "u2", input: { file_path: "apps/web/src/currencies/index.ts" }, output: "Read 40 lines.", at: min(24), doneAt: min(24) },
				{
					kind: "system",
					text: t("app:agents.turn.compactedAuto"),
					compact: { trigger: "auto", preTokens: 161_000 },
					at: min(20),
				},
				{ kind: "tool", tool: "Edit", text: "rounding.ts", toolId: "u3", input: { file_path: "apps/web/src/cart/rounding.ts", old_string: "a", new_string: "a\nb" }, output: "ok", at: min(12), doneAt: min(12) },
				{ kind: "tool", tool: "Write", text: "currencies/eur.ts", toolId: "u4", input: { file_path: "apps/web/src/currencies/eur.ts", content: "a\nb\nc" }, output: "ok", at: min(10), doneAt: min(10) },
				{ kind: "tool", tool: "Bash", text: "pnpm test currencies", toolId: "u5", input: { command: "pnpm test currencies" }, output: "12 passed", at: min(8), doneAt: min(7) },
				{ kind: "assistant", text: "The currency module is in place. Wiring the cart into it now.", at: min(7) },
				{ kind: "tool", tool: "Edit", text: "cart.ts", toolId: "u6", input: { file_path: "apps/web/src/cart.ts", old_string: "a", new_string: "b" }, output: "ok", at: min(6), doneAt: min(6) },
			],
		},
		// Un agent qui a fini un travail visible : captures avant et après, une
		// image annotée, une mesure, des tests rouges puis verts, une PR. De quoi
		// juger la planche et le film d'un tour, qui ne vivent que de ces gestes.
		{
			...common,
			id: "run-5",
			sessionId: "agent-6",
			claudeSessionId: "sess-6",
			cwd: "/Users/demo/code/storefront-staging",
			label: "Cart summary overflows on mobile",
			contextTokens: 58_000,
			running: true,
			thinking: false,
			activity: null,
			turns: [
				{ kind: "user", text: "The cart summary overflows on mobile, and the cart page takes two seconds to load. Fix both.", at: min(19) },
				{ kind: "tool", tool: "Read", text: "CartSummary.tsx", toolId: "p1", input: { file_path: "apps/web/src/cart/CartSummary.tsx" }, output: "Read 120 lines.", at: min(18.5), doneAt: min(18.4) },
				{ kind: "tool", tool: "Read", text: "CartLines.tsx", toolId: "p2", input: { file_path: "apps/web/src/cart/CartLines.tsx" }, output: "Read 64 lines.", at: min(18.3), doneAt: min(18.2) },
				{ kind: "tool", tool: "Read", text: "orders.service.ts", toolId: "p3", input: { file_path: "apps/api/src/orders/orders.service.ts" }, output: "Read 210 lines.", at: min(18), doneAt: min(17.9) },
				{ kind: "tool", tool: "mcp__navigateur__browser_take_screenshot", text: "capture", toolId: "p4", input: {}, output: "Screenshot taken.", outputImages: [sketch(true)], at: min(17.5), doneAt: min(17.4) },
				{ kind: "tool", tool: "Write", text: "before-cart.png", toolId: "p5", input: { file_path: "/Users/demo/code/storefront-staging/.claude/work/rendu/before-cart.png", content: "" }, output: "ok", at: min(17.3), doneAt: min(17.3) },
				{ kind: "assistant", text: "Line titles in the summary never wrap, and the cart query loads every line with all of its product images. Starting with the summary.", at: min(17) },
				{ kind: "tool", tool: "Edit", text: "CartSummary.tsx", toolId: "p6", input: { file_path: "/Users/demo/code/storefront-staging/apps/web/src/cart/CartSummary.tsx", old_string: "<h3 className=\"truncate\">{line.title}</h3>", new_string: "<h3 className=\"line-clamp-2 break-words\">{line.title}</h3>\n<Badges line={line} wrap />" }, output: "ok", at: min(15), doneAt: min(15) },
				{ kind: "tool", tool: "Bash", text: "pnpm test cart", toolId: "p7", input: { command: "pnpm --filter web test cart" }, output: " ✓ CartLines > renders the lines\n ✗ CartSummary > truncates long titles\n ✗ CartSummary > keeps badges on one line\n Tests: 2 failed, 14 passed", outputError: true, at: min(13), doneAt: min(12.5) },
				{ kind: "tool", tool: "Edit", text: "CartSummary.spec.tsx", toolId: "p8", input: { file_path: "/Users/demo/code/storefront-staging/apps/web/src/cart/CartSummary.spec.tsx", old_string: "expect(title).toHaveClass(\"truncate\")", new_string: "expect(title).toHaveClass(\"line-clamp-2\")" }, output: "ok", at: min(12), doneAt: min(12) },
				{ kind: "tool", tool: "Edit", text: "orders.service.ts", toolId: "p9", input: { file_path: "/Users/demo/code/storefront-staging/apps/api/src/orders/orders.service.ts", old_string: "include: { images: true }", new_string: "select: { id: true, title: true, price: true }" }, output: "ok", at: min(10), doneAt: min(10) },
				{ kind: "tool", tool: "Bash", text: "pnpm test cart", toolId: "p10", input: { command: "pnpm --filter web test cart" }, output: " ✓ CartLines > renders the lines\n ✓ CartSummary > wraps the title onto two lines\n Tests: 16 passed", at: min(8), doneAt: min(7.6) },
				{ kind: "tool", tool: "mcp__navigateur__browser_navigate", text: "localhost:3000", toolId: "p11", input: { url: "http://localhost:3000" }, output: "### Ran Playwright code\n```js\nawait page.goto('http://localhost:3000/');\n```\n### Page\n- Page URL: http://localhost:3000/", at: min(7), doneAt: min(6.9) },
				{ kind: "tool", tool: "mcp__navigateur__browser_resize", text: "390×844", toolId: "p11r", input: { width: 390, height: 844 }, output: "### Ran Playwright code\n```js\nawait page.setViewportSize({ width: 390, height: 844 });\n```", at: min(6.9), doneAt: min(6.9) },
				{ kind: "tool", tool: "mcp__navigateur__browser_click", text: "Cart", toolId: "p11c", input: { element: "Cart" }, output: "### Ran Playwright code\n```js\nawait page.getByRole('link', { name: 'Cart' }).click();\n```\n### Page\n- Page URL: http://localhost:3000/cart", at: min(6.85), doneAt: min(6.8) },
				{ kind: "tool", tool: "mcp__navigateur__browser_take_screenshot", text: "capture", toolId: "p11b", input: {}, output: "Screenshot taken.", outputImages: [sketch(false)], at: min(6.7), doneAt: min(6.6) },
				{ kind: "tool", tool: "Write", text: "after-cart.png", toolId: "p12", input: { file_path: "/Users/demo/code/storefront-staging/.claude/work/rendu/after-cart.png", content: "" }, output: "ok", at: min(6.5), doneAt: min(6.5) },
				{ kind: "tool", tool: "mcp__cockpit__illustrer", text: "capture", toolId: "p13", input: { genre: "capture", titre: "The cart summary at 390 px wide", source: "capture", image: "/Users/demo/code/storefront-staging/.claude/work/rendu/after-cart.png", reperes: [{ x: 0.3, y: 0.18, texte: "The title wraps onto two lines instead of being cut off." }, { x: 0.82, y: 0.78, texte: "The total stays visible without scrolling." }] }, output: "Illustration noted (capture).", at: min(6), doneAt: min(6) },
				{ kind: "tool", tool: "mcp__cockpit__illustrer", text: "mesure", toolId: "p14", input: { genre: "mesure", titre: "The cart query", source: "mesure", unite: "ms", commande: "pnpm --filter api bench orders:cart", mesures: [{ label: "GET /api/cart · p95", avant: 1840, apres: 310 }, { label: "Response size", avant: 912, apres: 64, unite: "KB" }] }, output: "Illustration noted (mesure).", at: min(5.5), doneAt: min(5.5) },
				{ kind: "tool", tool: "mcp__cockpit__illustrer", text: "frise", toolId: "p15", input: { genre: "frise", titre: "Why the cart was slow", source: "depot", etapes: [{ label: "Cart", detail: "lists 40 lines", etat: "neutre" }, { label: "API", detail: "include: images", etat: "casse" }, { label: "Database", detail: "1,200 images read", etat: "neutre" }, { label: "Response", detail: "912 KB", etat: "neutre" }] }, output: "Illustration noted (frise).", at: min(5.2), doneAt: min(5.2) },
				{ kind: "tool", tool: "Bash", text: "git commit", toolId: "p16", input: { command: "git commit -am \"fix(cart): readable summary on mobile, cart page 6× faster\"" }, output: "[fix/cart-mobile 4e1c2ab] fix(cart): readable summary on mobile, cart page 6× faster\n 4 files changed, 41 insertions(+), 12 deletions(-)", at: min(4), doneAt: min(4) },
				{ kind: "tool", tool: "Bash", text: "gh pr create", toolId: "p17", input: { command: "gh pr create --fill" }, output: "https://github.com/northwind/storefront/pull/2074", at: min(3.5), doneAt: min(3.2) },
				{
					kind: "assistant",
					text:
						"The cart summary fits on a phone screen, and the cart page responds in 310 ms instead of 1.8 s.\n\n" +
						"![before](.claude/work/rendu/before-cart.png) ![after](.claude/work/rendu/after-cart.png)\n\n" +
						"**UI**: line titles in the summary wrap onto two lines (`line-clamp-2`) instead of being cut off, and badges move below the title under 480 px. The test that required `truncate` was updated: it described the bug.\n\n" +
						"**API**: the cart loaded every line with all of its product images (`include: { images: true }`), 1,200 rows for 40 lines. It now reads only the id, the title and the price. Measured with the repo benchmark, 200 requests.\n\n" +
						"**What I did not do**: the product page still loads images, on purpose. Paginating the cart is left for another ticket.\n\n" +
						"PR: https://github.com/northwind/storefront/pull/2074",
					at: min(3),
				},
			],
		},
		// Un agent qui n'a encore rien reçu : le seul état où le dossier de
		// contexte se décide, et donc le seul où la barre existe. Sans lui, aucun
		// aperçu ne permettait de la regarder.
		{
			...common,
			id: "run-3",
			sessionId: "agent-4",
			claudeSessionId: null,
			cwd: "/Users/demo/code/fix-cart-rounding-nw-3044",
			label: "New agent",
			contextTokens: 0,
			running: true,
			thinking: false,
			activity: null,
			turns: [],
		},
	];
}

export function AgentRunsProvider({ children }: { children: ReactNode }) {
	const { notify, go } = useCockpit();
	const workspace = useWorkspace();
	// Identités stables : ces fonctions sont appelées depuis un abonnement, qu'on
	// ne veut pas reposer à chaque rendu.
	const { visible, show: showTab, dropped } = workspace;
	const [runs, setRuns] = useState<AgentRun[]>(previewRuns);
	const [defaultMode, setDefaultMode] = usePersistentState(
		"agent.permissionMode",
		"acceptEdits",
	);
	// Bypass : répond « oui » à tout, sans rien demander. Utile quand on laisse
	// un agent travailler seul en mode Prudent ; sans objet en mode Bypass, où
	// le CLI ne demande déjà plus rien.
	const [autoApprove, setAutoApprove] = usePersistentState("agent.autoApprove", false);
	// Vide = le modèle réglé sur le poste. On retient le choix, comme le mode.
	const [defaultModel, setDefaultModel] = usePersistentState("agent.model", "");

	// Les événements arrivent d'un flux, pas d'un rendu : ces références donnent
	// au listener l'état courant sans le réabonner à chaque frappe.
	const runsRef = useRef<AgentRun[]>(runs);
	runsRef.current = runs;
	const defaultModeRef = useRef(defaultMode);
	defaultModeRef.current = defaultMode;
	// L'aperçu porte déjà des agents `run-1` à `run-4` : en partant de zéro, le
	// premier agent ouvert y prenait l'identifiant d'un autre, et deux onglets
	// se croyaient actifs à la fois.
	const counter = useRef(isPreview() ? 100 : 0);
	// Un message peut précéder la réponse du démarrage : on le garde de côté
	// plutôt que de le jeter, et on le rejoue dès que la session est connue.
	const orphans = useRef(new Map<string, Array<Record<string, unknown>>>());
	// Les remises de revue déjà rangées, par appel : un événement rejoué ne doit
	// pas ajouter un tour de plus.
	const recorded = useRef(new Set<string>());

	const patch = useCallback((runId: string, update: (run: AgentRun) => AgentRun) => {
		setRuns((current) => current.map((run) => (run.id === runId ? update(run) : run)));
	}, []);

	const applyEvent = useCallback(
		(run: AgentRun, payload: Record<string, unknown>): AgentRun => {
			const { turns: incoming, results, context, commands, equipment, parent, usage, settled } =
				readEvent(payload);
			let next = run;

			// Ce qui vient d'un sous-agent va sous l'appel qui l'a lancé, et
			// nulle part ailleurs : son fil se lit à part, se replie, et ne
			// s'entremêle pas à celui du maître quand trois d'entre eux
			// travaillent en même temps. Rien d'autre de ce message ne compte —
			// ni son coût, déjà porté par le tour du maître, ni son activité.
			if (parent) {
				return {
					...next,
					turns: next.turns.map((turn) =>
						turn.toolId === parent
							? { ...turn, sub: appendSub(turn.sub ?? [], incoming, results) }
							: turn,
					),
				};
			}

			const claudeId = payload.session_id;
			if (typeof claudeId === "string" && !next.claudeSessionId) {
				next = { ...next, claudeSessionId: claudeId };
			}
			if (commands && commands.length > 0) {
				next = { ...next, commands };
			}
			// Les deux annonces se complètent sans se recouvrir : le démarrage
			// apporte skills et sous-agents, la réponse d'état apporte les
			// serveurs. Fusionner plutôt que remplacer, sinon la seconde efface
			// ce que la première avait appris.
			if (equipment) {
				next = { ...next, equipment: { ...next.equipment, ...equipment } };
			}
			if (usage) {
				// Une mesure est une réponse à une question, pas une parole de
				// l'agent : elle ne compte ni comme non lue ni comme activité.
				return { ...next, usage };
			}
			if (context) {
				// Une fenêtre ne rétrécit pas en cours de conversation : après un
				// résumé, le tour suivant repasserait sous les 200 000 jetons et
				// ferait retomber l'échelle à la valeur supposée, alors qu'on a la
				// preuve qu'elle est plus large.
				const observed = Math.max(context.window ?? 0, next.contextWindow ?? 0);
				next = {
					...next,
					// Le bilan de fin de tour ne recompte pas les jetons : il ne
					// vient que confirmer le modèle et sa fenêtre.
					contextTokens: context.tokens > 0 ? context.tokens : next.contextTokens,
					contextWindow: observed > 0 ? observed : next.contextWindow,
					activeModel: context.model ?? next.activeModel,
				};
			}
			if (results.length > 0) {
				next = { ...next, turns: attachResults(next.turns, results) };
			}
			if (incoming.length > 0) {
				next = { ...next, turns: appendTurns(next, incoming) };
			}

			// Un appel d'outil signifie que ça avance : on nomme ce qu'il fait
			// plutôt que d'afficher une attente muette.
			const tool = incoming.find((turn) => turn.kind === "tool");
			if (tool) next = { ...next, activity: tool.tool ?? null };

			// La main ne revient qu'au bilan de fin de tour. Le code s'arrêtait
			// aussi sur un simple message d'assistant — or un agent annonce
			// presque toujours ce qu'il va faire (« je regarde d'où vient
			// l'écart ») avant d'enchaîner des outils pendant des minutes. Le
			// cockpit le croyait alors disponible : l'indicateur de travail
			// s'éteignait, et le bouton « Arrêter » redevenait « Envoyer » au bout
			// de trois secondes, sans plus aucun moyen d'interrompre ce qui
			// tournait encore.
			//
			// Une demande d'autorisation ou une question laissent aussi le tour
			// ouvert sans `result` : là non plus la main n'est pas revenue, et
			// c'est justement là qu'on veut pouvoir couper.
			//
			// Et le bilan lui-même ne rend pas toujours la main : un agent qui a
			// lancé des sous-agents en arrière-plan termine son tour en disant
			// « j'attends leurs rapports », puis reprend seul quand ils arrivent.
			// Le cockpit annonçait « Terminé — rien ne tourne » pendant que trois
			// relecteurs lisaient le code. Tant qu'il en reste un, le tour est tenu
			// pour ouvert.
			if (settled && settled.length > 0) {
				const ended = new Map(settled.map((entry) => [entry.toolId, entry.status]));
				next = {
					...next,
					turns: next.turns.map((turn) =>
						turn.background && turn.toolId && ended.has(turn.toolId)
							? { ...turn, background: { endedAt: Date.now(), status: ended.get(turn.toolId) } }
							: turn,
					),
				};
			}
			// Il reparle ou relance un outil sans qu'on lui ait rien envoyé : une
			// notification l'a réveillé, il travaille de nouveau.
			if (
				next.running &&
				!next.thinking &&
				incoming.some((turn) => turn.kind === "assistant" || turn.kind === "tool")
			) {
				next = { ...next, thinking: true };
			}
			if (payload.type === "result") {
				next =
					next.thinking && backgroundPending(next.turns).length > 0
						? { ...next, activity: null }
						: { ...next, thinking: false, activity: null };
			}
			if ((payload as { subtype?: string }).subtype === "ended") {
				// Le processus est parti : ses sous-agents avec lui, rendus ou non.
				next = {
					...next,
					running: false,
					thinking: false,
					turns: next.turns.map((turn) =>
						turn.background?.endedAt === null
							? { ...turn, background: { endedAt: Date.now(), status: "stopped" } }
							: turn,
					),
				};
			}

			// Le panneau montre autre chose : on compte ce qui mérite un coup d'œil.
			if (!visible("agent", run.id) && !libreVisible(run.id)) {
				const notable = incoming.filter(
					(turn) => turn.kind === "assistant" || turn.kind === "error",
				).length;
				if (notable > 0) next = { ...next, unread: next.unread + notable };
			}

			return next;
		},
		[visible],
	);

	/**
	 * Demande au CLI de quoi est rempli le contexte d'un agent.
	 *
	 * Gratuit — ni appel au modèle, ni message dans la conversation — mais pas
	 * pour autant à poser sans raison : au démarrage, à chaque fin de tour, et
	 * de loin en loin pendant qu'il travaille.
	 */
	const probeContext = useCallback(
		(runId: string) => {
			if (!hasTauri()) return;
			const run = runsRef.current.find((entry) => entry.id === runId);
			if (!run?.sessionId || !run.running || run.noUsage) return;
			void api.agents.probeContext(run.sessionId).catch((error) => {
				// Seul le refus d'un moteur sans canal de contrôle est définitif ;
				// un agent qui vient de s'arrêter n'a simplement plus rien à dire.
				// Le message a changé de langue : l'ancien texte français et l'anglais.
				if (/canal de contrôle|control channel/i.test(String(error))) {
					patch(runId, (current) => ({ ...current, noUsage: true }));
				}
			});
		},
		[patch],
	);

	const working = runs
		.filter((run) => run.running && run.thinking && run.sessionId && !run.noUsage)
		.map((run) => run.id)
		.join(" ");
	useEffect(() => {
		if (!working) return;
		const timer = setInterval(() => {
			for (const id of working.split(" ")) probeContext(id);
		}, 10_000);
		return () => clearInterval(timer);
	}, [working, probeContext]);

	useEffect(() => {
		const subscription = events.onAgentEvent((event) => {
			const payload = event.payload as Record<string, unknown>;
			const target = runsRef.current.find((run) => run.sessionId === event.sessionId);

			if (!target) {
				// Session inconnue : soit son démarrage n'a pas encore répondu,
				// soit c'est le dernier soupir d'un agent qu'on a remplacé.
				if ((payload as { subtype?: string }).subtype === "ended") {
					orphans.current.delete(event.sessionId);
					return;
				}
				const queue = orphans.current.get(event.sessionId) ?? [];
				if (queue.length < 200) queue.push(payload);
				orphans.current.set(event.sessionId, queue);
				return;
			}

			// Un agent qui rend la main sans qu'on le regarde doit le dire : le
			// cockpit n'est pas forcément au premier plan.
			const wasBusy = target.thinking || target.running;
			setRuns((current) =>
				current.map((run) => (run.id === target.id ? applyEvent(run, payload) : run)),
			);
			// Une revue remise par son outil : on la range tout de suite, l'écran
			// de la branche la montre point par point. Le contenu est l'entrée de
			// l'appel, pas un texte à relire.
			for (const turn of readEvent(payload).turns) {
				if (turn.kind !== "tool" || turn.tool !== REVIEW_TOOL || !turn.toolId) continue;
				if (recorded.current.has(turn.toolId)) continue;
				recorded.current.add(turn.toolId);
				void api.reviews
					.record(target.cwd, turn.input ?? {})
					.then((review) => {
						const count = review.rounds[review.rounds.length - 1]?.findings.length ?? 0;
						window.dispatchEvent(new CustomEvent(REVIEW_EVENT, { detail: review }));
						notify(t("app:agents.review.delivered", { number: review.number, count }), {
							label: t("app:agents.see"),
							onClick: () => {
								go("workspace");
								showTab(target.cwd, { kind: "board", id: target.cwd });
							},
						});
					})
					.catch((error) => notify(t("app:agents.review.recordFailed", { error: String(error) })));
			}
			// Fin de tour ou session tout juste prête : le contexte vient de
			// changer, ou on ne l'a encore jamais mesuré.
			if (payload.type === "result" || (payload.type === "system" && payload.subtype === "init")) {
				setTimeout(() => probeContext(target.id), 300);
			}
			if (!visible("agent", target.id) && !libreVisible(target.id) && wasBusy) {
				const ended = (payload as { subtype?: string }).subtype === "ended";
				const replied = readEvent(payload).turns.some((turn) => turn.kind === "assistant");
				if (ended || replied) {
					void api.system
						.notify(target.label, ended ? t("app:agents.notify.ended") : t("app:agents.notify.replied"))
						.catch(() => undefined);
				}
			}
		});
		return () => {
			void subscription.then((off) => off());
		};
	}, [applyEvent, visible, probeContext, notify, go, showTab]);

	/** Rattache une session backend à sa conversation et rejoue son retard. */
	const attach = useCallback(
		(runId: string, sessionId: string) => {
			const queued = orphans.current.get(sessionId) ?? [];
			orphans.current.delete(sessionId);
			patch(runId, (run) =>
				queued.reduce((state, payload) => applyEvent(state, payload), {
					...run,
					sessionId,
				} as AgentRun),
			);
		},
		[applyEvent, patch],
	);

	const launch = useCallback(
		(
			runId: string,
			cwd: string,
			prompt: string,
			mode: string,
			model: string,
			resume?: string,
			profile?: string,
			extra?: { account?: string; depth?: string },
		) => {
			void api.agents
				.start(cwd, prompt, mode, model, resume, undefined, profile, extra?.account, extra?.depth)
				.then((sessionId) => attach(runId, sessionId))
				.catch((error) => {
					patch(runId, (run) => ({
						...run,
						running: false,
						thinking: false,
						turns: appendTurns(run, [{ kind: "error", text: String(error) }]),
					}));
				});
		},
		[attach, patch],
	);

	/**
	 * Le contexte du dossier, joint à une consigne partie sans passer par le
	 * champ de saisie.
	 *
	 * Ne rejette jamais : un contexte est un bonus, et rater un bonus n'a pas à
	 * retenir un agent. Rend la consigne inchangée quand il n'y a rien à joindre.
	 */
	const withBrief = useCallback(
		async (cwd: string, prompt: string): Promise<{ text: string; joined: string | null }> => {
			try {
				const brief = await api.brief.compose(cwd);
				const retained = brief.sections.filter((section) => section.on);
				if (retained.length === 0) return { text: prompt, joined: null };
				return {
					text: await api.brief.assemble(retained, prompt, cwd),
					joined: retained.map((section) => section.label).join(" · "),
				};
			} catch {
				return { text: prompt, joined: null };
			}
		},
		[],
	);

	const open = useCallback(
		(
			cwd: string,
			prompt = "",
			resume?: string,
			historyFile?: string,
			fresh = false,
			options?: { profile?: string; label?: string; libre?: LibreLaunch },
		): string | undefined => {
			const profile = options?.profile;
			const libre = options?.libre;
			// Les conversations ne s'affichent que dans l'écran Workspaces : en
			// ouvrir une depuis un autre écran sans y aller lancerait un agent
			// qu'on ne verrait nulle part. Un agent libre a son propre écran, que
			// son lanceur ouvre lui-même.
			if (!libre) go("workspace");

			// Reprendre une session déjà reprise la rouvre : sans ça, deux clics
			// sur « Reprendre » lançaient deux agents sur le même fil Claude, qui
			// s'écrivaient dessus sans que rien ne le signale.
			if (resume) {
				const live = runsRef.current.find((run) => run.claudeSessionId === resume);
				if (live) {
					if (!isLibreRun(live)) showTab(live.cwd, { kind: "agent", id: live.id });
					patch(live.id, (run) => ({ ...run, unread: 0 }));
					return live.id;
				}
			}

			// Une conversation déjà ouverte sur ce dossier se rouvre plutôt que
			// de se dédoubler — sauf reprise explicite d'une autre session, ou
			// demande explicite d'un second agent. Un agent libre n'est jamais
			// celui qu'on rouvre ainsi : il n'appartient pas au workspace.
			const existing = libre
				? undefined
				: runsRef.current.find((run) => run.cwd === cwd && run.running && !isLibreRun(run));
			if (existing && !resume && !prompt && !fresh) {
				showTab(cwd, { kind: "agent", id: existing.id });
				patch(existing.id, (run) => ({ ...run, unread: 0 }));
				return existing.id;
			}

			const id = `run-${++counter.current}`;
			const mode = libre ? libre.mode : defaultMode;
			const model = libre ? libre.model : defaultModel;
			const extra = libre ? { account: libre.account, depth: libre.depth } : undefined;
			setRuns((current) => [
				...current,
				{
					id,
					sessionId: null,
					claudeSessionId: resume ?? null,
					cwd,
					label: options?.label ?? basename(cwd),
					mode: profile === "review" ? "default" : mode,
					model,
					profile,
					free: libre ? true : undefined,
					account: extra?.account,
					depth: extra?.depth,
					activeModel: null,
					commands: [],
					equipment: { servers: [], probed: false, skills: [], subagents: [], plugins: [] },
					contextTokens: 0,
					contextWindow: null,
					turns: prompt ? [{ kind: "user", text: prompt }] : [],
					running: true,
					thinking: Boolean(prompt),
					activity: null,
					unread: 0,
				},
			]);
			if (!libre) showTab(cwd, { kind: "agent", id });

			// Un agent lancé avec sa consigne — « Traiter » depuis Impact, un
			// prompt tout prêt — partait sans rien de ce que le cockpit sait de la
			// branche, alors que c'est souvent là que ça compte le plus : il
			// n'ouvre pas de champ de saisie où l'on aurait pu cocher.
			//
			// Le contexte est donc joint d'office, mais jamais en douce : le tour
			// le nomme, comme pour un premier message écrit à la main. Une reprise
			// n'y a pas droit — l'agent a déjà tout ça dans sa conversation.
			//
			// Un agent libre part avec ce qu'on lui a écrit, et rien d'autre : c'est
			// la promesse du terminal.
			if (prompt && !resume && !libre) {
				void withBrief(cwd, prompt).then(({ text, joined }) => {
					if (joined) {
						patch(id, (run) => ({
							...run,
							turns: run.turns.map((turn, index) =>
								index === 0 && turn.kind === "user" ? { ...turn, context: joined } : turn,
							),
						}));
					}
					launch(id, cwd, text, mode, model, resume, profile, extra);
				});
			} else {
				launch(id, cwd, prompt, mode, model, resume, profile, extra);
			}

			// Reprise : le CLI ne redit pas ce qu'il a déjà dit, on relit donc la
			// session sur disque pour rouvrir sur la conversation, pas sur du vide.
			if (historyFile) {
				void api.sessions
					.timeline(historyFile, 300)
					.then((events) => {
						const history = historyTurns(events);
						if (history.length === 0) return;
						patch(id, (run) => ({
							...run,
							turns: [
								...history,
								{ kind: "system" as const, text: t("app:agents.turn.resumed") },
								...run.turns,
							],
						}));
					})
					.catch(() => undefined);
			}
			return id;
		},
		[defaultMode, defaultModel, go, launch, patch, showTab, withBrief],
	);

	// ── Adoption des agents lancés hors de l'interface ────────────────────
	//
	// Une mission démarre son maître et ses exécutants côté cockpit : ces agents
	// existaient donc sans onglet, et « Suivre » menait à un panneau vide. On
	// les découvre ici, avec leur conversation, pour qu'ils soient des onglets
	// comme les autres — même worktree, même fil, mêmes gestes.
	//
	// C'est aussi par là que reviennent, au démarrage, les agents détachés qui
	// ont continué pendant que le cockpit était fermé (`relay.rs`) : le backend
	// les a déjà réinscrits sous leur identifiant d'origine, il ne reste qu'à
	// leur rendre un onglet — et à le dire une fois, sans quoi on les prendrait
	// pour des conversations qu'on vient de rouvrir.
	useEffect(() => {
		let stopped = false;
		if (hasTauri()) {
			void api.agents
				.survivors()
				.then((survivors) => {
					if (stopped || survivors.length === 0) return;
					const count = survivors.length;
					const activity = startActivity(
						t("app:agents.survivors.title", { count }),
						t("app:agents.survivors.detail", { count }),
					);
					activity.done(t("app:agents.survivors.done", { count }), {
						label: t("app:agents.see"),
						run: () => go("workspace"),
					},
					);
				})
				.catch(() => undefined);
		}
		const adopt = async () => {
			const statuses = await api.agents.list().catch(() => []);
			for (const status of statuses) {
				if (stopped) return;
				if (runsRef.current.some((run) => run.sessionId === status.sessionId)) continue;

				const events = await api.agents.timeline(status.sessionId).catch(() => []);
				if (stopped) return;
				// Un agent libre revenu de son relais : il reprend sa place dans son
				// écran, avec ce qu'on avait choisi pour le lancer.
				const libre = libreOf({
					id: status.sessionId,
					sessionId: status.sessionId,
					claudeSessionId: status.claudeSessionId,
				});
				if (libre) patchLibre(libre.id, { runId: status.sessionId });
				setRuns((current) => {
					if (current.some((run) => run.sessionId === status.sessionId)) return current;
					return [
						...current,
						{
							id: status.sessionId,
							sessionId: status.sessionId,
							claudeSessionId: status.claudeSessionId,
							cwd: status.cwd,
							label: libre?.label ?? status.cwd.split("/").pop() ?? status.cwd,
							// Un agent détaché a été lancé à la main, dans le mode choisi
							// sur ce poste ; ceux d'une mission tournent sans rien demander.
							mode: libre
								? libre.mode
								: status.detached
									? defaultModeRef.current
									: "bypassPermissions",
							model: libre?.model ?? "",
							free: libre ? true : undefined,
							account: libre?.account,
							depth: libre?.depth,
							activeModel: null,
							commands: [],
							equipment: { servers: [], probed: false, skills: [], subagents: [], plugins: [] },
							contextTokens: 0,
							contextWindow: null,
							turns: historyTurns(events),
							running: status.running,
							thinking: status.working,
							activity: null,
							unread: 0,
						},
					];
				});
			}
		};

		void adopt();
		const timer = setInterval(() => void adopt(), 5000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
		// Une seule boucle d'adoption pour toute la session : `go` ne change que l'écran.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const send = useCallback(
		(runId: string, text: string, joined?: SendExtras) => {
			const run = runsRef.current.find((entry) => entry.id === runId);
			if (!run?.sessionId || !text.trim()) return;
			patch(runId, (current) => ({
				...current,
				thinking: true,
				// Le fil montre ce qu'on a écrit, pas le dossier qui l'accompagne :
				// un contexte de plusieurs milliers de caractères recopié dans la
				// conversation la rendrait illisible dès le premier message. Ce qui
				// est parti avec est nommé sous le tour, et reste dépliable.
				turns: appendTurns(current, [
					{
						kind: "user",
						text: joined?.display ?? text,
						context: joined?.context,
						follows: joined?.follows ?? (current.thinking || undefined),
					},
				]),
			}));
			if (run.claudeSessionId && joined?.follows !== undefined) {
				rememberFollows(run.claudeSessionId, joined.display ?? text, joined.follows);
			}
			void api.agents.send(run.sessionId, text).catch((error) => notify(String(error)));
		},
		[notify, patch],
	);

	const stop = useCallback(
		(runId: string) => {
			const run = runsRef.current.find((entry) => entry.id === runId);
			if (!run) return;
			if (run.sessionId) {
				void api.agents.stop(run.sessionId).catch(() => undefined);
				// Une demande laissée en plan n'attend plus personne.
				void api.agents.discardPermissions(run.sessionId).catch(() => undefined);
			}
			patch(runId, (current) => ({
				...current,
				running: false,
				thinking: false,
				activity: null,
			}));
		},
		[patch],
	);

	const close = useCallback(
		(runId: string) => {
			stop(runId);
			setRuns((current) => current.filter((run) => run.id !== runId));
			dropped("agent", runId);
		},
		[dropped, stop],
	);

	// Un onglet qu'on regarde est un onglet lu — quel que soit le chemin par
	// lequel on y est arrivé.
	//
	// La remise à zéro ne vivait que dans `show`, c'est-à-dire dans le clic sur
	// un onglet. Or on arrive sur un agent par bien d'autres chemins : en
	// revenant sur l'écran Workspaces, en rouvrant un groupe depuis le dock, ou
	// simplement en restant dessus pendant qu'il parle et qu'on regardait
	// ailleurs. Dans tous ces cas le compte restait, et rien ne le faisait
	// jamais tomber : on relisait la conversation en entier sans que la pastille
	// bouge d'un chiffre.
	const { onScreen, tab: openTab } = workspace;
	useEffect(() => {
		if (!onScreen || openTab?.kind !== "agent") return;
		patch(openTab.id, (run) => (run.unread > 0 ? { ...run, unread: 0 } : run));
	}, [onScreen, openTab, patch]);

	const show = useCallback(
		(runId: string) => {
			const run = runsRef.current.find((entry) => entry.id === runId);
			if (!run) return;
			const libre = libreOf(run);
			if (run.free || libre) {
				if (libre) selectLibre(libre.id);
				go("libres");
			} else {
				go("workspace");
				showTab(run.cwd, { kind: "agent", id: runId });
			}
			patch(runId, (current) => ({ ...current, unread: 0 }));
		},
		[go, patch, showTab],
	);

	const changeMode = useCallback(
		(runId: string, mode: string) => {
			const run = runsRef.current.find((entry) => entry.id === runId);
			// Le choix vaut aussi pour la suite : on ne le repose pas à chaque
			// lancement. Sauf celui d'un agent libre, qui ne regarde que lui.
			if (!run?.free) setDefaultMode(mode);
			if (!run || run.mode === mode) return;

			if (!run.running) {
				patch(runId, (current) => ({ ...current, mode }));
				return;
			}

			// Le mode est figé au lancement du CLI : pour en changer, on relance
			// sur la même session Claude, ce qui conserve tout le contexte.
			if (run.sessionId) {
				void api.agents.stop(run.sessionId).catch(() => undefined);
				void api.agents.discardPermissions(run.sessionId).catch(() => undefined);
			}
			const resume = run.claudeSessionId ?? undefined;
			patch(runId, (current) => ({
				...current,
				mode,
				sessionId: null,
				activity: null,
				thinking: false,
				running: true,
				turns: appendTurns(current, [
					{
						kind: "system",
						text: resume
							? t("app:agents.turn.relaunchedModeKept", { mode: modeLabel(mode) })
							: t("app:agents.turn.relaunchedModeFresh", { mode: modeLabel(mode) }),
					},
				]),
			}));
			launch(runId, run.cwd, "", mode, run.model, resume, run.profile, {
				account: run.account,
				depth: run.depth,
			});
		},
		[launch, patch, setDefaultMode],
	);

	/**
	 * Change le modèle d'une conversation en cours.
	 *
	 * Même mécanique que le mode d'autorisation : `--model` est un drapeau de
	 * lancement, on relance donc le CLI sur la même session Claude. Le fil est
	 * conservé — c'est ce qui permet de commencer en Sonnet et de passer en Opus
	 * quand la tâche se corse, sans rien réexpliquer.
	 */
	const changeModel = useCallback(
		(runId: string, model: string) => {
			const run = runsRef.current.find((entry) => entry.id === runId);
			if (!run?.free) setDefaultModel(model);
			if (!run || run.model === model) return;

			if (!run.running) {
				patch(runId, (current) => ({ ...current, model }));
				return;
			}

			if (run.sessionId) {
				void api.agents.stop(run.sessionId).catch(() => undefined);
				void api.agents.discardPermissions(run.sessionId).catch(() => undefined);
			}
			const resume = run.claudeSessionId ?? undefined;
			patch(runId, (current) => ({
				...current,
				model,
				activeModel: null,
				sessionId: null,
				activity: null,
				thinking: false,
				running: true,
				turns: appendTurns(current, [
					{
						kind: "system",
						text: resume
							? t("app:agents.turn.relaunchedModelKept", { model: modelLabel(model) })
							: t("app:agents.turn.relaunchedModelFresh", { model: modelLabel(model) }),
					},
				]),
			}));
			launch(runId, run.cwd, "", run.mode, model, resume, run.profile, {
				account: run.account,
				depth: run.depth,
			});
		},
		[launch, patch, setDefaultModel],
	);

	// Le pont MCP dépose les demandes sur disque ; on ne les relève que s'il y a
	// un agent capable d'en produire.
	const watching = runs.some((run) => run.running);
	const permissions = useAsync(() => api.agents.permissions(), [watching], {
		pollMs: 1500,
		enabled: watching,
	});
	const pending = useMemo(() => permissions.data ?? [], [permissions.data]);
	const reloadPermissions = permissions.reload;

	const decide = useCallback(
		(id: string, allow: boolean, reason?: string) => {
			void api.agents
				.answerPermission(id, allow, reason)
				.then(() => reloadPermissions())
				.catch((error) => notify(String(error)));
		},
		[notify, reloadPermissions],
	);

	/**
	 * Répond à une question de l'agent.
	 *
	 * Le canal ne sait dire qu'oui ou non, avec un motif : autoriser exécuterait
	 * un outil qui n'a personne à qui parler et se conclut par « the user did not
	 * answer ». On refuse donc l'appel en glissant la réponse dans le motif, seul
	 * texte qui remonte jusqu'à l'agent.
	 */
	const answer = useCallback(
		(id: string, answers: Array<{ header: string; choice: string }>) => {
			const lines = answers
				.map((entry) => `- ${entry.header}: ${entry.choice}`)
				.join("\n");
			decide(
				id,
				false,
				`The user's answers, given from the cockpit:\n${lines}\n` +
					"Continue with these answers, without calling AskUserQuestion again.",
			);
		},
		[decide],
	);

	useEffect(() => {
		if (!autoApprove || pending.length === 0) return;
		for (const request of pending) {
			// Une question n'est pas une permission : l'approuver ne répond à rien
			// et fait perdre à l'agent ce qu'il demandait. Elle attend l'utilisateur
			// même quand tout le reste passe sans demander.
			if (isQuestion(request)) continue;
			void api.agents.answerPermission(request.id, true).catch(() => undefined);
		}
		reloadPermissions();
	}, [autoApprove, pending, reloadPermissions]);

	// Une demande sans réponse bloque l'agent : elle doit sortir de l'ombre même
	// quand le panneau est replié.
	const announced = useRef(new Set<string>());
	useEffect(() => {
		for (const request of pending) {
			if (announced.current.has(request.id)) continue;
			announced.current.add(request.id);
			const run = runsRef.current.find((entry) => entry.sessionId === request.sessionId);
			if (run && visible("agent", run.id)) continue;
			void api.system
				.notify(
					run?.label ?? "Agent",
					isQuestion(request)
						? t("app:agents.notify.question")
						: t("app:agents.notify.permission", { tool: request.tool }),
				)
				.catch(() => undefined);
		}
		const live = new Set(pending.map((request) => request.id));
		for (const id of announced.current) {
			if (!live.has(id)) announced.current.delete(id);
		}
	}, [pending, visible]);

	// Conversation au premier plan : seul point où l'état du panneau change ce
	// que ce registre décide, faute de mieux (voir ci-dessous).
	const frontmost = workspace.tab?.kind === "agent" ? workspace.tab.id : null;

	const pendingFor = useCallback(
		(runId: string) => {
			const run = runs.find((entry) => entry.id === runId);
			if (!run) return [];
			return pending.filter((request) =>
				// Une demande non étiquetée vient d'un agent lancé hors cockpit :
				// on la présente dans la conversation au premier plan, faute de
				// mieux, plutôt que de la laisser expirer sans être vue.
				request.sessionId ? request.sessionId === run.sessionId : runId === frontmost,
			);
		},
		[frontmost, pending, runs],
	);

	const pendingForSession = useCallback(
		(sessionId: string | null | undefined) =>
			sessionId ? pending.filter((request) => request.sessionId === sessionId) : [],
		[pending],
	);

	const actions = useMemo<AgentActions>(
		() => ({
			setDefaultMode,
			setAutoApprove,
			open,
			send,
			stop,
			close,
			show,
			changeMode,
			changeModel,
			decide,
			answer,
		}),
		[
			setDefaultMode,
			setAutoApprove,
			open,
			send,
			stop,
			close,
			show,
			changeMode,
			changeModel,
			decide,
			answer,
		],
	);

	const state = useMemo<AgentState>(
		() => ({ runs, defaultMode, autoApprove, pendingFor, pendingForSession }),
		[runs, defaultMode, autoApprove, pendingFor, pendingForSession],
	);

	const guard = useMemo<AgentGuard>(
		() => ({ autoApprove, pendingFor, pendingForSession }),
		[autoApprove, pendingFor, pendingForSession],
	);

	// Recalculée à chaque rendu — elle ne coûte que la longueur de la liste — et
	// c'est elle qui empêche la table ci-dessous de changer d'identité à chaque
	// message reçu.
	const openSignature = runs.map((run) => `${run.id}\0${run.claudeSessionId ?? ""}`).join("\x01");
	const openSessions = useMemo(() => {
		const map = new Map<string, string>();
		for (const run of runs) {
			if (run.claudeSessionId) map.set(run.claudeSessionId, run.id);
		}
		return map;
		// `runs` change à chaque phrase ; la signature, seulement quand une
		// conversation s'ouvre, se ferme ou apprend sa session.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openSignature]);

	return (
		<ActionsContext.Provider value={actions}>
			<StateContext.Provider value={state}>
				<GuardContext.Provider value={guard}>
					<OpenSessionsContext.Provider value={openSessions}>
						{children}
					</OpenSessionsContext.Provider>
				</GuardContext.Provider>
			</StateContext.Provider>
		</ActionsContext.Provider>
	);
}

/**
 * La conversation ouverte sur cette session Claude, s'il y en a une.
 *
 * Répond `null` pour une session qu'on ne fait que relire depuis son journal :
 * c'est la différence entre une archive et un agent avec qui on peut parler.
 */
export function useOpenRunFor(claudeSessionId: string | null | undefined): string | null {
	const open = useContext(OpenSessionsContext);
	return claudeSessionId ? (open.get(claudeSessionId) ?? null) : null;
}

/**
 * Les commandes seules — pour les écrans qui lancent un agent sans en afficher
 * aucun. Ils ne rendent alors plus rien quand une conversation avance.
 */
export function useAgentActions(): AgentActions {
	const store = useContext(ActionsContext);
	if (!store) throw new Error("useAgentActions must be used inside AgentRunsProvider");
	return store;
}

/**
 * Les autorisations en attente et le réglage du filet, sans l'état des
 * conversations. C'est ce dont une fenêtre de discussion a besoin en plus de
 * son propre `run`, qu'elle reçoit déjà en argument.
 */
export function useAgentGuard(): AgentGuard {
	const store = useContext(GuardContext);
	if (!store) throw new Error("useAgentGuard must be used inside AgentRunsProvider");
	return store;
}

export function useAgentRuns(): AgentRunsStore {
	const state = useContext(StateContext);
	const actions = useContext(ActionsContext);
	if (!state || !actions) {
		throw new Error("useAgentRuns must be used inside AgentRunsProvider");
	}
	return useMemo(() => ({ ...actions, ...state }), [actions, state]);
}
