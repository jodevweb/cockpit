import clsx from "clsx";
import { AlertTriangle, Send, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, ErrorNote, Field, Spinner, TextInput } from "@/components/ui";
import { useConfirm } from "@/components/Confirm";
import { fromIso } from "@/lib/format";
import { api } from "@/lib/ipc";
import { useAsync } from "@/lib/useAsync";
import { useCockpit } from "@/app/store";
import { Trans, useTranslation } from "react-i18next";

/**
 * Répondre à un agent depuis son téléphone.
 *
 * Cet écran n'est pas un réglage comme les autres : il ouvre une porte sur la
 * machine qui exécute les agents. Il montre donc l'état de chaque barrière —
 * Tailscale, Funnel, appareils appairés — plutôt qu'un simple interrupteur, et
 * il dit ce que le mobile *ne peut pas* faire, qui est le plus rassurant.
 */
export function RemoteAccess() {
	const { t } = useTranslation("components1");
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
				title: t("remoteAccess.disableConfirm.title"),
				message: t("remoteAccess.disableConfirm.message"),
				confirmLabel: t("remoteAccess.disable"),
				danger: true,
			});
			if (!ok) return;
		}
		try {
			await api.remote.enable(enabled);
			setPairing(null);
			status.reload();
			notify(enabled ? t("remoteAccess.enabled") : t("remoteAccess.disabled"));
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
			title: t("remoteAccess.revokeConfirm.title", { name }),
			message: t("remoteAccess.revokeConfirm.message"),
			confirmLabel: t("remoteAccess.revoke"),
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
						{t("remoteAccess.intro.title")}
					</p>
					<p className="mt-0.5 text-[10px] leading-relaxed text-ink-faint">
						<Trans
							t={t}
							i18nKey="remoteAccess.intro.detail"
							components={{ code: <span className="font-mono" /> }}
						/>
					</p>
				</div>
				<Button
					variant={data.enabled ? "outline" : "solid"}
					onClick={() => void toggle(!data.enabled)}
				>
					{data.enabled ? t("remoteAccess.disable") : t("remoteAccess.enable")}
				</Button>
			</div>

			{/* L'état des barrières, avant tout le reste : activer sans Tailscale ne
			    ferait rien, et un Funnel actif est un refus net. */}
			<div className="grid grid-cols-2 gap-2">
				<Check
					ok={Boolean(data.host)}
					label="Tailscale"
					detail={data.host || t("remoteAccess.tailscale.offline")}
				/>
				<Check
					ok={!data.funnel}
					label="Funnel"
					detail={
						data.funnel
							? t("remoteAccess.funnel.on", { command: "tailscale funnel off" })
							: t("remoteAccess.funnel.off")
					}
				/>
			</div>

			{data.enabled && ready ? (
				<>
					<div className="rounded-xl border border-line-soft bg-surface/40 p-3">
						<div className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
							{t("remoteAccess.setup.title")}
						</div>
						<code className="text-selectable block rounded-lg bg-void px-2.5 py-2 font-mono text-[11px] text-ink-muted">
							pnpm setup:mobile
						</code>
						<p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
							{t("remoteAccess.setup.detail")}
						</p>
					</div>

					{/* Trois champs plutôt qu'un réglage caché : c'est ce que le script
					    vient d'afficher, on le recopie et c'est branché. */}
					<div className="grid grid-cols-3 gap-2">
						<Field label={t("remoteAccess.ntfy.server")} hint={t("remoteAccess.ntfy.serverHint")}>
							<TextInput
								value={ntfy.server ?? data.ntfyServer}
								onChange={(value) => setNtfy({ ...ntfy, server: value })}
								placeholder="http://127.0.0.1:2586"
							/>
						</Field>
						<Field label={t("remoteAccess.ntfy.topic")} hint={t("remoteAccess.ntfy.topicHint")}>
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
							label={t("remoteAccess.ntfy.token")}
							hint={
								data.ntfyAuthenticated
									? t("remoteAccess.ntfy.tokenSaved")
									: t("remoteAccess.ntfy.tokenRequired")
							}
						>
							<TextInput
								value={ntfy.token ?? ""}
								onChange={(value) => setNtfy({ ...ntfy, token: value })}
								placeholder={data.ntfyAuthenticated ? t("remoteAccess.ntfy.saved") : "tk_…"}
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
								{data.lastWake.ok
									? t("remoteAccess.wake.last", { detail: data.lastWake.detail })
									: t("remoteAccess.wake.failed", { detail: data.lastWake.detail })}
							</span>
						) : (
							<span className="min-w-0 flex-1 text-[11px] text-ink-faint">
								{t("remoteAccess.wake.none")}
							</span>
						)}
						<Button
							icon={Send}
							onClick={() => {
								void api.remote
									.test()
									.then((detail) => {
										notify(t("remoteAccess.relay.result", { detail }));
										status.reload();
									})
									.catch((error) => {
										notify(String(error));
										status.reload();
									});
							}}
						>
							{t("remoteAccess.relay.test")}
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
										notify(t("remoteAccess.relay.saved"));
									})
									.catch((error) => notify(String(error)));
							}}
						>
							{t("remoteAccess.relay.save")}
						</Button>
					</div>

					<div className="rounded-xl border border-line-soft bg-surface/40 p-3">
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 text-[11px] text-ink">
								{t("remoteAccess.devices.title", { count: data.devices.length })}
							</span>
							<Button icon={ShieldCheck} onClick={() => void pair()}>
								{t("remoteAccess.devices.pair")}
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
										{t("remoteAccess.devices.pairing")}
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
								<p className="text-[11px] text-ink-faint">{t("remoteAccess.devices.empty")}</p>
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
										{t("remoteAccess.devices.seen", { when: fromIso(device.lastSeen) })}
									</span>
									<Button
										size="sm"
										icon={Trash2}
										title={t("remoteAccess.revoke")}
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
	const { t } = useTranslation("components1");
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
					<Badge tone={ok ? "success" : "warning"}>{ok ? t("remoteAccess.check.ok") : t("remoteAccess.check.todo")}</Badge>
				</div>
				<p className="mt-0.5 text-[10px] leading-snug text-ink-faint">{detail}</p>
			</div>
		</div>
	);
}
