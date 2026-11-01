import clsx from "clsx";
import { Check, FolderPlus, GitBranch, Github, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Dot } from "@/components/ui";
import { t as translate } from "@/i18n";
import { api } from "@/lib/ipc";
import type { Ground } from "@/lib/types";

/**
 * Ce qu'il faut préparer avant qu'un dossier devienne un projet.
 *
 * Un projet demande trois choses — un dossier, un dépôt git, parfois une forge
 * — et il en manque presque toujours une au début. Refuser en bloc avec « ce
 * n'est pas un dépôt git » laisse deviner laquelle, et surtout quoi faire :
 * l'utilisateur va ouvrir un terminal, taper trois commandes, revenir. Autant
 * les proposer là où il est.
 *
 * **Rien n'est fait sans être coché.** Le cockpit ne devine pas qu'il faut
 * créer un dépôt sur une forge parce qu'un dossier était vide, et il ne pousse
 * rien : poser le serveur suffit, le premier `push` reste un geste.
 */
export function ProjectGround({
	path,
	suggestedName,
	onReady,
}: {
	path: string;
	/** Nom du projet, proposé comme nom de dépôt. */
	suggestedName: string;
	/** Appelé après chaque préparation, avec l'état du terrain. */
	onReady: (ground: Ground) => void;
}) {
	const { t } = useTranslation("components3");
	const [ground, setGround] = useState<Ground | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [wanted, setWanted] = useState({ remote: false, public: false });
	const [account, setAccount] = useState("");
	const [repo, setRepo] = useState("");

	// On regarde à chaque frappe stabilisée : c'est l'inspection qui rend le
	// chemin compris — tilde développé, nom résolu — et c'est elle qui dit à
	// l'utilisateur où le cockpit ira vraiment chercher.
	useEffect(() => {
		if (!path.trim()) {
			setGround(null);
			return;
		}
		let vivant = true;
		const timer = setTimeout(() => {
			void api.config
				.inspectProject(path)
				.then((found) => {
					if (!vivant) return;
					setGround(found);
					setAccount((current) => current || found.accounts[0] || "");
					setRepo((current) => current || found.slug);
					onReady(found);
				})
				.catch(() => setGround(null));
		}, 300);
		return () => {
			vivant = false;
			clearTimeout(timer);
		};
	}, [path, onReady]);

	if (!ground) return null;

	const missing = !ground.exists || !ground.isRepo;
	const nothingToDo = ground.exists && ground.isRepo && Boolean(ground.remote);

	const prepare = async () => {
		setBusy(true);
		setError("");
		try {
			const after = await api.config.prepareProject({
				path,
				createDir: !ground.exists,
				gitInit: !ground.isRepo,
				createRemote: wanted.remote,
				account,
				repo: repo.trim() || suggestedName.trim(),
				public: wanted.public,
			});
			setGround(after);
			onReady(after);
			setWanted({ remote: false, public: false });
		} catch (problem) {
			setError(String(problem));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2 rounded-xl border border-line-soft bg-surface/60 p-2.5">
			{/* Le chemin compris, toujours affiché : c'est là que se voit qu'un
			    « ~ » a bien été développé, ou qu'un nom seul est allé se ranger
			    sous le dossier des projets. */}
			<p className="font-mono text-[10.5px] break-all text-ink-faint">{ground.path}</p>

			<div className="flex flex-col gap-1">
				<State
					ok={ground.exists}
					label={t("projectGround.dirExists")}
					missing={t("projectGround.dirMissing")}
				/>
				<State
					ok={ground.isRepo}
					label={t("projectGround.isRepo")}
					missing={t("projectGround.notRepo")}
				/>
				<State
					ok={Boolean(ground.remote)}
					label={ground.slug || ground.remote}
					missing={t("projectGround.noRemote")}
					// Un dépôt sans serveur est un cas parfaitement normal : on le
					// signale sans le traiter comme un manque.
					neutral
				/>
			</div>

			{/* Le dépôt distant ne se propose qu'une fois le local en place :
			    offrir de créer un serveur pour un dossier qui n'existe pas ferait
			    cocher deux cases pour un seul geste. */}
			{!ground.remote ? (
				<label className="flex cursor-pointer items-start gap-2 pt-0.5">
					<input
						type="checkbox"
						className="mt-0.5 accent-accent"
						checked={wanted.remote}
						onChange={(event) =>
							setWanted((current) => ({ ...current, remote: event.target.checked }))
						}
					/>
					<span className="min-w-0">
						<span className="text-[11.5px] text-ink-muted">
							{t("projectGround.createRemote")}
						</span>
						<span className="block text-[10px] leading-snug text-ink-faint">
							{t("projectGround.createRemoteHint")}
						</span>
					</span>
				</label>
			) : null}

			{wanted.remote ? (
				<div className="flex flex-col gap-2 border-l-2 border-line-soft pl-2.5">
					<div className="grid grid-cols-2 gap-2">
						<label className="flex flex-col gap-1">
							<span className="text-[10px] text-ink-faint">{t("projectGround.account")}</span>
							<select
								value={account}
								onChange={(event) => setAccount(event.target.value)}
								className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2 text-[11px] text-ink"
							>
								{ground.accounts.length === 0 ? (
									<option value="">{t("projectGround.noGhSession")}</option>
								) : null}
								{ground.accounts.map((entry) => (
									<option key={entry} value={entry}>
										{entry}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-[10px] text-ink-faint">{t("projectGround.repo")}</span>
							<input
								value={repo}
								onChange={(event) => setRepo(event.target.value)}
								placeholder={suggestedName || t("projectGround.repoPlaceholder")}
								spellCheck={false}
								className="focus-ring h-7 w-full rounded-lg border border-line-soft bg-raised px-2 font-mono text-[11px] text-ink placeholder:text-ink-faint"
							/>
						</label>
					</div>
					{/* Privé par défaut, et le dire : un dépôt public créé par
					    inadvertance ne se dé-publie pas. */}
					<label className="flex cursor-pointer items-center gap-2">
						<input
							type="checkbox"
							className="accent-critical"
							checked={wanted.public}
							onChange={(event) =>
								setWanted((current) => ({ ...current, public: event.target.checked }))
							}
						/>
						<span className="text-[11px] text-ink-muted">{t("projectGround.makePublic")}</span>
						{wanted.public ? <Badge tone="warning">{t("projectGround.publicBadge")}</Badge> : null}
					</label>
				</div>
			) : null}

			{error ? (
				<p className="text-[10.5px] leading-snug break-words text-critical">{error}</p>
			) : null}

			{nothingToDo && !wanted.remote ? (
				<p className="flex items-center gap-1.5 text-[10.5px] text-ink-faint">
					<Check size={11} className="text-success" />
					{t("projectGround.ready")}
				</p>
			) : (
				<Button
					variant="outline"
					icon={busy ? Loader2 : missing ? FolderPlus : Github}
					disabled={busy || (!missing && !wanted.remote)}
					className="justify-center"
					onClick={() => void prepare()}
				>
					{busy ? t("projectGround.preparing") : summarize(ground, wanted.remote)}
				</Button>
			)}
		</div>
	);
}

/** Ce que le bouton va réellement faire, en clair et dans l'ordre. */
function summarize(ground: Ground, remote: boolean): string {
	const gestes: string[] = [];
	if (!ground.exists) gestes.push(translate("components3:projectGround.step.createDir"));
	if (!ground.isRepo) gestes.push(translate("components3:projectGround.step.gitInit"));
	if (remote) gestes.push(translate("components3:projectGround.step.createRemote"));
	if (gestes.length === 0) return translate("components3:projectGround.nothingToPrepare");
	return gestes.join(", ").replace(/^./, (first) => first.toUpperCase());
}

function State({
	ok,
	label,
	missing,
	neutral,
}: {
	ok: boolean;
	label: string;
	missing: string;
	/** Absent n'est pas fautif : un dépôt sans serveur est un cas normal. */
	neutral?: boolean;
}) {
	return (
		<span className="flex items-center gap-1.5">
			<Dot tone={ok ? "success" : neutral ? "neutral" : "warning"} />
			<span
				className={clsx(
					"text-[11px]",
					ok ? "text-ink-muted" : neutral ? "text-ink-faint" : "text-warning",
				)}
			>
				{ok ? label : missing}
			</span>
			{ok && !neutral ? <GitBranch size={10} className="text-ink-faint/50" /> : null}
		</span>
	);
}
