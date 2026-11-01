import { LogIn, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Dot, Field, Spinner, TextInput } from "@/components/ui";
import { t as translate } from "@/i18n";
import { api } from "@/lib/ipc";
import type { Account, AccountStatus } from "@/lib/types";
import { useCockpit } from "@/app/store";
import { useTerminalActions } from "@/app/terminals";

/**
 * Les comptes sous lesquels les agents travaillent.
 *
 * Le cockpit ne détient aucun jeton et ne se connecte à la place de personne :
 * il désigne un dossier de configuration, et le CLI y fait sa propre connexion.
 * D'où la forme de cet écran — on n'y saisit pas d'identifiants, on déclare un
 * compte puis on ouvre un terminal pour qu'il se présente lui-même.
 *
 * Ce qui s'affiche ensuite — un courriel, un abonnement — est la réponse du CLI
 * à « qui es-tu », relue à chaque ouverture. Le cockpit n'en garde rien : un
 * compte déconnecté ailleurs doit se voir ici sans avoir à le lui dire.
 */

/**
 * Ce qu'on lit sous le nom d'un compte : qui il est, ou ce qui l'en empêche.
 *
 * L'organisation n'apparaît que si elle dit autre chose que l'adresse — sur un
 * compte personnel, le CLI rend « l'organisation de untel@exemple.com », qu'on
 * vient déjà de lire deux mots plus tôt.
 */
function identity(status: AccountStatus): string {
	if (status.error) return status.error;
	if (!status.loggedIn) return translate("components2:accounts.notLoggedIn");

	const parts = [status.email || translate("components2:accounts.loggedIn")];
	if (status.plan) parts.push(status.plan);
	if (status.organization && !status.organization.includes(status.email)) {
		parts.push(status.organization);
	}
	return parts.join(" · ");
}

/** Identifiant tiré du nom : c'est lui qui relie un projet à son compte. */
function slugify(label: string): string {
	return label
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
}

export function AccountsSettings() {
	const { t } = useTranslation("components2");
	const { config, reloadConfig, notify } = useCockpit();
	const { open: openTerminal } = useTerminalActions();
	const [statuses, setStatuses] = useState<AccountStatus[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [draft, setDraft] = useState({ label: "", dir: "" });

	const activeProject = config?.projects.find(
		(project) => project.id === config.activeProject,
	);

	const load = useCallback(
		async (force = false) => {
			setLoading(true);
			try {
				setStatuses(await api.accounts.status(force));
			} catch (error) {
				notify(String(error));
			} finally {
				setLoading(false);
			}
		},
		[notify],
	);

	useEffect(() => {
		void load();
	}, [load]);

	/** Les comptes déclarés, celui du poste retiré : il n'est pas dans le fichier. */
	const declared = (): Account[] =>
		statuses
			.filter((status) => status.dir.trim() !== "")
			.map(({ id, label, dir }) => ({ id, label, dir }));

	const save = async (entries: Account[]) => {
		setBusy(true);
		try {
			await api.accounts.save(entries);
			reloadConfig();
			await load(true);
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	const add = async () => {
		const label = draft.label.trim();
		const id = slugify(label);
		if (!id) {
			notify(t("accounts.nameRequired"));
			return;
		}
		if (statuses.some((status) => status.id === id)) {
			notify(t("accounts.nameTaken", { label }));
			return;
		}
		await save([...declared(), { id, label, dir: draft.dir.trim() || `~/.claude-${id}` }]);
		setDraft({ label: "", dir: "" });
	};

	/** Rattache le projet ouvert à ce compte. */
	const attach = async (status: AccountStatus) => {
		setBusy(true);
		try {
			// Revenir au compte du poste, c'est vider le champ : un projet qui ne
			// désigne rien hérite, ce qui est exactement ce qu'on veut dire. On le
			// reconnaît à son absence de dossier propre, plutôt qu'en recopiant ici
			// l'identifiant que le back lui donne.
			await api.config.updateProject({ account: status.dir.trim() ? status.id : "" });
			reloadConfig();
			await load(true);
		} catch (error) {
			notify(String(error));
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Ouvre un terminal sur la connexion de ce compte.
	 *
	 * Le CLI demande un navigateur et un code : rien que le cockpit puisse faire
	 * à sa place, et rien qu'il ait à voir passer. On lui prête un shell, avec le
	 * bon dossier de configuration déjà posé.
	 */
	const login = (status: AccountStatus) => {
		openTerminal(status.resolvedDir, {
			command: "claude auth login",
			label: t("accounts.loginTerminal", { label: status.label }),
			account: status.id,
		});
		void api.accounts.refresh();
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="text-[11px] leading-relaxed text-ink-faint">
				{t("accounts.intro")}
			</p>

			{loading && statuses.length === 0 ? (
				<div className="flex items-center gap-2 p-3 text-[11px] text-ink-faint">
					<Spinner /> {t("accounts.loading")}
				</div>
			) : null}

			{statuses.map((status) => {
				const attached = activeProject?.account === status.id;
				return (
					<div
						key={status.id}
						className="flex flex-col gap-2 rounded-xl border border-line-soft bg-surface/40 p-2.5"
					>
						<div className="flex items-center gap-2">
							<Dot tone={status.loggedIn ? "success" : "neutral"} />
							<div className="min-w-0 flex-1">
								<span className="block truncate text-[12.5px] font-medium text-ink">
									{status.label}
								</span>
								<span className="block truncate text-[10px] text-ink-faint">
									{identity(status)}
								</span>
							</div>
							{status.loggedIn && status.plan ? <Badge>{status.plan}</Badge> : null}
							{attached ? <Badge tone="accent">{t("accounts.openProject")}</Badge> : null}
						</div>

						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
								{status.resolvedDir}
							</span>
							{/* Qui travaille sous ce compte : c'est la question qu'on se pose
							    en ouvrant cet écran, pas celle des dossiers qui existent. */}
							{status.projects.map((name) => (
								<Badge key={name}>{name}</Badge>
							))}
						</div>

						<div className="flex items-center gap-2">
							<Button size="sm" icon={LogIn} onClick={() => login(status)}>
								{status.loggedIn ? t("accounts.reconnect") : t("accounts.connect")}
							</Button>
							{activeProject && !attached ? (
								<Button size="sm" disabled={busy} onClick={() => void attach(status)}>
									{t("accounts.attach", { name: activeProject.name })}
								</Button>
							) : null}
							<div className="flex-1" />
							{/* Le compte du poste ne se retire pas : c'est l'installation de
							    Claude Code elle-même, et un projet qui n'en désigne aucun y
							    revient. */}
							{status.dir.trim() ? (
								<Button
									size="sm"
									icon={Trash2}
									variant="danger"
									disabled={busy}
									onClick={() =>
										void save(declared().filter((entry) => entry.id !== status.id))
									}
								>
									{t("accounts.remove")}
								</Button>
							) : null}
						</div>
					</div>
				);
			})}

			{/* Le formulaire n'est pas un compte de plus : le fond et le titre le
			    séparent de la liste, sinon ses deux champs se lisent comme la suite
			    de la dernière ligne. */}
			<div className="flex items-end gap-2 rounded-xl bg-void/40 p-2.5">
				<span className="mb-1.5 shrink-0 text-[10px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
					{t("accounts.new")}
				</span>
				<Field label={t("accounts.nameLabel")} hint={t("accounts.nameHint")}>
					<TextInput
						value={draft.label}
						onChange={(label) => setDraft((current) => ({ ...current, label }))}
						placeholder={t("accounts.namePlaceholder")}
					/>
				</Field>
				<Field label={t("accounts.dirLabel")} hint={t("accounts.dirHint")}>
					<TextInput
						value={draft.dir}
						onChange={(dir) => setDraft((current) => ({ ...current, dir }))}
						placeholder={draft.label ? `~/.claude-${slugify(draft.label)}` : t("accounts.dirPlaceholder")}
						mono
					/>
				</Field>
				<Button
					variant="solid"
					icon={Plus}
					disabled={busy || !draft.label.trim()}
					onClick={() => void add()}
				>
					{t("accounts.add")}
				</Button>
			</div>

			<div className="flex items-center gap-2">
				<span className="text-[10px] text-ink-faint">
					{t("accounts.footer")}
				</span>
				<div className="flex-1" />
				<Button size="sm" icon={RefreshCw} disabled={loading} onClick={() => void load(true)}>
					{loading ? t("accounts.reading") : t("accounts.reload")}
				</Button>
			</div>
		</div>
	);
}
