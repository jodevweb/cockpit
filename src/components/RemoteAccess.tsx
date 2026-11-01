import clsx from "clsx";
import { AlertTriangle, Send, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, ErrorNote, Field, Spinner, TextInput } from "@/components/ui";
import { useConfirm } from "@/components/Confirm";
import { fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";

/**
 * Répondre à un agent depuis son téléphone.
 *
 * Cet écran n'est pas un réglage comme les autres : il ouvre une porte sur la
 * machine qui exécute les agents. Il montre donc l'état de chaque barrière —
 * Tailscale, Funnel, appareils appairés — plutôt qu'un simple interrupteur, et
 * il dit ce que le mobile *ne peut pas* faire, qui est le plus rassurant.
 */
export function RemoteAccess() {
	const { notify } = useCockpit();
	const { confirm } = useConfirm();
	const status = useAsync(() => api.remote.status(), [], { pollMs: 30_000 });
	const [pairing, setPairing] = useState<{ code: string; qr: string; url: string } | null>(
		null,
	);
	/** Champs du relais en cours d'édition ; vide = ce que le Mac a déjà. */
	const [ntfy, setNtfy] = useState<{ server?: string; topic?: string; token?: string }>({});
	const data = status.data;

	const toggle = async (enabled: boolean) => {
		if (!enabled) {
			const ok = await confirm({
				title: "Couper l'accès mobile ?",
				message:
					"Tous les appareils appairés sont révoqués, clés d'accès comprises. " +
					"Il faudra les appairer à nouveau.",
				confirmLabel: "Couper",
				danger: true,
			});
			if (!ok) return;
		}
		try {
			await api.remote.enable(enabled);
			setPairing(null);
			status.reload();
			notify(enabled ? "Accès mobile activé." : "Accès mobile coupé.");
		} catch (error) {
			notify(String(error));
		}
	};

	const pair = async () => {
		try {
			setPairing(await api.remote.pair());
		} catch (error) {
			notify(String(error));
		}
	};

	const revoke = async (id: string, name: string) => {
		const ok = await confirm({
			title: `Révoquer ${name} ?`,
			message: "Cet appareil ne pourra plus rien lire ni décider.",
			confirmLabel: "Révoquer",
			danger: true,
		});
		if (!ok) return;
		try {
			await api.remote.revoke(id);
			status.reload();
		} catch (error) {
			notify(String(error));
		}
	};

	if (status.error) return <ErrorNote error={status.error} onRetry={status.reload} />;
	if (!data) {
		return (
			<div className="flex justify-center py-6">
				<Spinner />
			</div>
		);
	}

	const ready = Boolean(data.host) && !data.funnel;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-start gap-3 rounded-xl border border-line-soft bg-surface/40 p-3">
				<Smartphone size={14} className="mt-0.5 shrink-0 text-ink-faint" />
				<div className="min-w-0 flex-1">
					<p className="text-[12.5px] text-ink">
						Répondre aux demandes d'un agent depuis l'iPhone, à travers Tailscale.
					</p>
					<p className="mt-0.5 text-[10px] leading-relaxed text-ink-faint">
						Le serveur n'écoute que sur la boucle locale ; c'est{" "}
						<span className="font-mono">tailscale serve</span> qui l'expose au tailnet, avec
						son certificat. Autoriser un outil demande Face ID. Le mobile ne peut ni changer
						le mode de permission d'un agent, ni lancer un script, ni toucher à la
						configuration.
					</p>
				</div>
				<Button
					variant={data.enabled ? "outline" : "solid"}
					onClick={() => void toggle(!data.enabled)}
				>
					{data.enabled ? "Couper" : "Activer"}
				</Button>
			</div>

			{/* L'état des barrières, avant tout le reste : activer sans Tailscale ne
			    ferait rien, et un Funnel actif est un refus net. */}
			<div className="grid grid-cols-2 gap-2">
				<Check
					ok={Boolean(data.host)}
					label="Tailscale"
					detail={data.host || "hors ligne — le tailnet fournit l'adresse et le certificat"}
				/>
				<Check
					ok={!data.funnel}
					label="Funnel"
					detail={
						data.funnel
							? "actif : le cockpit refuse de démarrer, coupe-le avec `tailscale funnel off`"
							: "coupé — rien n'est publié sur Internet"
					}
				/>
			</div>

			{data.enabled && ready ? (
				<>
					<div className="rounded-xl border border-line-soft bg-surface/40 p-3">
						<div className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							À faire une fois sur ce Mac
						</div>
						<code className="text-selectable block rounded-lg bg-void px-2.5 py-2 font-mono text-[11px] text-ink-muted">
							pnpm setup:mobile
						</code>
						<p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
							Le script configure le serveur ntfy local, le publie sur le tailnet à côté de
							cette page, et rend le sujet et le jeton à coller ci-dessous. Le relais Apple
							ne voit que l'empreinte du sujet ; le contenu vient d'ici.
						</p>
					</div>

					{/* Trois champs plutôt qu'un réglage caché : c'est ce que le script
					    vient d'afficher, on le recopie et c'est branché. */}
					<div className="grid grid-cols-3 gap-2">
						<Field label="Serveur ntfy" hint="local, jamais exposé">
							<TextInput
								value={ntfy.server ?? data.ntfyServer}
								onChange={(value) => setNtfy({ ...ntfy, server: value })}
								placeholder="http://127.0.0.1:2586"
							/>
						</Field>
						<Field label="Sujet" hint="secret : qui le connaît fait sonner">
							<TextInput
								value={ntfy.topic ?? data.ntfyTopic}
								onChange={(value) => setNtfy({ ...ntfy, topic: value })}
								mono
							/>
						</Field>
						{/* Champ texte et non mot de passe : masqué, le trousseau du
						    navigateur y proposait un identifiant enregistré, qui
						    remplaçait le vrai jeton sans que rien ne le signale. */}
						<Field
							label="Jeton de publication"
							hint={data.ntfyAuthenticated ? "enregistré — vide = inchangé" : "requis"}
						>
							<TextInput
								value={ntfy.token ?? ""}
								onChange={(value) => setNtfy({ ...ntfy, token: value })}
								placeholder={data.ntfyAuthenticated ? "enregistré" : "tk_…"}
								mono
							/>
						</Field>
					</div>
					<div className="flex items-center gap-2">
						{data.lastWake ? (
							<span
								className={clsx(
									"min-w-0 flex-1 truncate text-[11px]",
									data.lastWake.ok ? "text-success" : "text-critical",
								)}
								title={data.lastWake.at}
							>
								{data.lastWake.ok ? "Dernier réveil : " : "Dernier réveil en échec : "}
								{data.lastWake.detail}
							</span>
						) : (
							<span className="min-w-0 flex-1 text-[11px] text-ink-faint">
								Aucun réveil tenté depuis le démarrage.
							</span>
						)}
						<Button
							icon={Send}
							onClick={() => {
								void api.remote
									.test()
									.then((detail) => {
										notify(`Relais : ${detail}`);
										status.reload();
									})
									.catch((error) => {
										notify(String(error));
										status.reload();
									});
							}}
						>
							Tester le relais
						</Button>
						<Button
							onClick={() => {
								void api.remote
									.ntfy(
										ntfy.server ?? data.ntfyServer,
										ntfy.topic ?? data.ntfyTopic,
										ntfy.token ?? "",
									)
									.then(() => {
										setNtfy({});
										status.reload();
										notify("Relais enregistré.");
									})
									.catch((error) => notify(String(error)));
							}}
						>
							Enregistrer le relais
						</Button>
					</div>

					<div className="rounded-xl border border-line-soft bg-surface/40 p-3">
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 text-[11px] text-ink">
								Appareils appairés · {data.devices.length}
							</span>
							<Button icon={ShieldCheck} onClick={() => void pair()}>
								Appairer un iPhone
							</Button>
						</div>

						{pairing ? (
							<div className="mt-2.5 flex items-start gap-3 rounded-lg border border-accent/25 bg-accent/[0.06] p-2.5">
								<div
									className="h-28 w-28 shrink-0 [&>svg]:h-full [&>svg]:w-full"
									dangerouslySetInnerHTML={{ __html: pairing.qr }}
								/>
								<div className="min-w-0 flex-1">
									<p className="text-[11px] text-ink-muted">
										Scanne le QR pour ouvrir la page, ajoute-la à l'écran d'accueil, puis
										saisis ce code — valable deux minutes, une seule fois :
									</p>
									<p className="text-selectable mt-1.5 font-mono text-[18px] tracking-[0.2em] text-ink">
										{pairing.code}
									</p>
									<p className="mt-1 font-mono text-[10px] text-ink-faint">{pairing.url}</p>
								</div>
							</div>
						) : null}

						<div className="mt-2 flex flex-col gap-1">
							{data.devices.length === 0 ? (
								<p className="text-[11px] text-ink-faint">Aucun appareil.</p>
							) : null}
							{data.devices.map((device) => (
								<div
									key={device.id}
									className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-surface"
								>
									<Smartphone size={12} className="shrink-0 text-ink-faint" />
									<span className="min-w-0 flex-1 truncate text-[11px] text-ink">
										{device.name}
									</span>
									<span className="shrink-0 font-mono text-[10px] text-ink-faint">
										vu {fromIso(device.lastSeen)}
									</span>
									<Button
										size="sm"
										icon={Trash2}
										title="Révoquer"
										onClick={() => void revoke(device.id, device.name)}
									/>
								</div>
							))}
						</div>
					</div>
				</>
			) : null}
		</div>
	);
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
	return (
		<div
			className={clsx(
				"flex items-start gap-2 rounded-xl border p-2.5",
				ok ? "border-line-soft bg-surface/40" : "border-warning/25 bg-warning/[0.06]",
			)}
		>
			{ok ? (
				<ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
			) : (
				<AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
			)}
			<div className="min-w-0">
				<div className="flex items-center gap-1.5">
					<span className="text-[11px] font-medium text-ink">{label}</span>
					<Badge tone={ok ? "success" : "warning"}>{ok ? "ok" : "à régler"}</Badge>
				</div>
				<p className="mt-0.5 text-[10px] leading-snug text-ink-faint">{detail}</p>
			</div>
		</div>
	);
}
