import clsx from "clsx";
import { AlertTriangle, ChevronDown, KeyRound, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRun } from "@/app/agents";
import { useCockpit } from "@/app/store";
import { locale } from "@/i18n";
import { api } from "@/lib/ipc";
import {
	type Engine,
	hasGoodSystemVoice,
	type Heard,
	heardNow,
	humanize,
	narrate,
	narratedNow,
	CLOUD_MODELS,
	progress,
	RATES,
	say,
	setNarrated,
	silence,
	silentFor,
	updateVoice,
	useFallback,
	useNarrated,
	useVoiceSettings,
	voiceSettings,
} from "@/lib/narrator";
import { hasTauri } from "@/lib/preview";
import type { CloudVoice, Voice } from "@/lib/types";
import { platformContext } from "@/lib/platform";

/** Au-delà d'une minute sans rien dire pendant qu'il travaille, on donne des nouvelles. */
const QUIET_MS = 60_000;

/**
 * Fait parler la conversation de cet agent quand on l'écoute : branché sur
 * chaque onglet d'agent, muet sauf pour celui qu'on a choisi.
 */
export function useNarration(run: AgentRun, pending: Array<{ tool: string }>): void {
	const { t } = useTranslation("components2");
	const active = useNarrated() === run.id;
	const heard = useRef<Heard | null>(null);
	const latest = useRef(run);
	latest.current = run;

	// À l'activation : dire où il en est, puis ne raconter que la suite.
	useEffect(() => {
		if (!active) {
			heard.current = null;
			return;
		}
		heard.current = heardNow(run.turns, run.thinking, pending.length);
		const where = run.thinking
			? progress(run.turns)
			: pending.length > 0
				? t("narration.waitingForYou")
				: t("narration.stopped");
		const name = humanize(run.label, 80) || t("narration.thisAgent");
		say([{ text: t("narration.intro", { name, where }), keep: true }]);
		// L'état initial ne se lit qu'à l'activation : la suite vient de l'effet
		// suivant.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// Ce qui arrive ensuite, au fil de l'eau.
	useEffect(() => {
		if (!active || !heard.current) return;
		const lines = narrate(heard.current, run.turns, run.thinking, pending);
		heard.current = heardNow(run.turns, run.thinking, pending.length);
		say(lines);
		// `pending` est refait à chaque rendu : sa longueur suffit à dire du neuf.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, run.turns, run.thinking, pending.length]);

	// Un agent qui travaille sans rien dire pendant des minutes : une phrase de
	// temps en temps, pour qu'on sache qu'il avance.
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => {
			const current = latest.current;
			if (current.thinking && silentFor() > QUIET_MS) {
				say([{ text: progress(current.turns), keep: false }]);
			}
		}, 15_000);
		return () => window.clearInterval(timer);
	}, [active]);

	// Un onglet qu'on ferme ne laisse pas une voix orpheline — mais seulement
	// s'il était celui qu'on écoutait : passer l'écoute à un autre agent ne
	// doit pas la couper.
	useEffect(
		() => () => {
			if (narratedNow() === run.id) setNarrated(null);
		},
		[run.id],
	);
}

/** Écouter cet agent, ou se taire ; et choisir la voix. */
export function NarrationToggle({ runId }: { runId: string }) {
	const { t } = useTranslation("components2");
	const narrated = useNarrated();
	const on = narrated === runId;
	const settings = useVoiceSettings();
	const fallback = useFallback();
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		window.addEventListener("mousedown", close);
		return () => window.removeEventListener("mousedown", close);
	}, [open]);

	return (
		<div ref={box} className="relative flex shrink-0 items-center">
			<button
				type="button"
				onClick={() => setNarrated(on ? null : runId)}
				title={on ? t("narration.mute") : t("narration.listenLive")}
				className={clsx(
					"focus-ring flex h-7 items-center gap-1.5 rounded-l-lg px-2 text-[11.5px] font-medium transition-colors",
					on ? "bg-accent text-accent-ink" : "text-ink-muted hover:bg-hover hover:text-ink",
				)}
			>
				{on ? (
					<>
						<Volume2 size={13} />
						<span className="flex items-end gap-[2px]" aria-hidden>
							{[0, 1, 2].map((bar) => (
								<span
									key={bar}
									className="w-[2px] animate-pulse rounded-full bg-current"
									style={{ height: 5 + ((bar * 3) % 6), animationDelay: `${bar * 150}ms` }}
								/>
							))}
						</span>
						{t("narration.listening")}
					</>
				) : (
					<>
						<VolumeX size={13} />
						{t("narration.listen")}
					</>
				)}
			</button>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				title={fallback ? t("narration.elevenLabsFailed", { context: platformContext, reason: fallback }) : t("narration.voiceAndRate")}
				className={clsx(
					"focus-ring grid h-7 w-5 place-items-center rounded-r-lg",
					on ? "bg-accent text-accent-ink" : "text-ink-faint hover:bg-hover hover:text-ink",
				)}
			>
				{fallback && settings.engine === "elevenlabs" ? (
					<AlertTriangle size={10} className={on ? "" : "text-warning"} />
				) : (
					<ChevronDown size={11} />
				)}
			</button>
			{open ? <VoiceSettings inMenu /> : null}
		</div>
	);
}

function Segment<T extends string | number>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: Array<[string, T]>;
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex gap-1">
			{options.map(([label, option]) => (
				<button
					key={String(option)}
					type="button"
					onClick={() => onChange(option)}
					className={clsx(
						"flex-1 rounded-md px-2 py-1 text-[11.5px]",
						value === option ? "bg-accent-dim font-medium text-accent" : "text-ink-muted hover:bg-hover",
					)}
				>
					{label}
				</button>
			))}
		</div>
	);
}

/**
 * Les réglages de la voix : le moteur, la clé ElevenLabs, la voix, le débit.
 *
 * Deux endroits les montrent — le menu d'« Écouter », sous la main, et la
 * rubrique « Voix & assistant » des Réglages — et c'est le même composant :
 * deux copies auraient divergé au premier ajout.
 */
export function VoiceSettings({ inMenu = false }: { inMenu?: boolean }) {
	const { t } = useTranslation("components2");
	const settings = useVoiceSettings();
	const fallback = useFallback();
	const [voices, setVoices] = useState<Voice[]>([]);
	const [cloud, setCloud] = useState<CloudVoice[] | null>(null);
	const [hasKey, setHasKey] = useState<boolean | null>(null);
	const [key, setKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const native = hasTauri();
	const { go } = useCockpit();

	useEffect(() => {
		if (!native) return;
		void api.speech.voices().then((all) => setVoices(all.filter((voice) => voice.locale.startsWith(locale().split("-")[0]))));
		void api.speech.hasKey().then(setHasKey);
	}, [native]);

	// Les voix du compte, dès qu'il y a une clé : c'est là qu'on choisit.
	useEffect(() => {
		if (!native || !hasKey || settings.engine !== "elevenlabs") return;
		setError(null);
		void api.speech
			.cloudVoices()
			.then((list) => {
				setCloud(list);
				if (!voiceSettings().cloudVoice && list[0]) updateVoice({ cloudVoice: list[0].id });
			})
			.catch((failure) => setError(String(failure)));
	}, [native, hasKey, settings.engine]);

	const saveKey = async (value: string) => {
		setError(null);
		try {
			await api.speech.setKey(value);
			setHasKey(value.trim().length > 0);
			setKey("");
		} catch (failure) {
			setError(String(failure));
		}
	};

	const label = "font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase";

	return (
		<div
			className={clsx(
				"flex flex-col gap-3",
				inMenu ? "absolute top-8 left-0 z-30 w-72 rounded-xl bg-surface p-3 shadow-pop" : "max-w-md",
			)}
		>
			<div className="flex flex-col gap-1.5">
				<span className={label}>{t("voiceSettings.engine")}</span>
				<Segment<Engine>
					value={settings.engine}
					options={[
						[t("voiceSettings.macVoice", { context: platformContext }), "system"],
						["ElevenLabs", "elevenlabs"],
					]}
					onChange={(engine) => updateVoice({ engine })}
				/>
				<span className="text-[10px] leading-snug text-ink-faint">
					{settings.engine === "elevenlabs"
						? t("voiceSettings.elevenLabsHint")
						: t("voiceSettings.systemHint")}
				</span>
			</div>

			{/* La clé sert aussi à l'assistant, qui t'entend par ElevenLabs : dans
			    les Réglages, elle se règle même avec la voix du Mac. */}
			{settings.engine === "elevenlabs" || !inMenu ? (
					<div className="flex flex-col gap-1.5">
					<span className="flex items-center justify-between">
						<span className={label}>{t("voiceSettings.elevenLabsKey")}</span>
						{/* Là où elle se crée : dans les réglages du compte, pas dans
						    l'abonnement, où on la cherche d'abord. */}
						<button
							type="button"
							onClick={() => void api.system.openUrl("https://elevenlabs.io/app/settings/api-keys").catch(() => undefined)}
							className="text-[10.5px] text-accent hover:underline"
						>
							{t("voiceSettings.createKey")}
						</button>
					</span>
					{hasKey ? (
						<div className="flex items-center gap-2 text-[11.5px] text-ink">
							<KeyRound size={12} className="text-success" />
							<span className="flex-1">{t("voiceSettings.keyStored", { context: platformContext })}</span>
							<button type="button" onClick={() => void saveKey("")} className="text-[11px] text-ink-faint hover:text-critical">
								{t("voiceSettings.removeKey")}
							</button>
						</div>
					) : (
						<div className="flex gap-1.5">
							<input
								type="password"
								value={key}
								onChange={(event) => setKey(event.target.value)}
								placeholder="sk_…"
								className="min-w-0 flex-1 rounded-md border border-line-soft bg-base px-2 py-1 font-mono text-[11.5px] text-ink outline-none"
							/>
							<button
								type="button"
								disabled={!key.trim()}
								onClick={() => void saveKey(key)}
								className="rounded-md bg-accent px-2 text-[11.5px] font-medium text-accent-ink disabled:opacity-40"
							>
								{t("voiceSettings.storeKey")}
							</button>
						</div>
					)}
					{error ? <span className="text-[10.5px] text-critical">{error}</span> : null}
				</div>
			) : null}

			{settings.engine === "elevenlabs" ? (
				<>
					{hasKey ? (
						<label className="flex flex-col gap-1.5">
							<span className={label}>{t("voiceSettings.voice")}</span>
							{cloud === null && !error ? (
								<span className="text-[11px] text-ink-faint">{t("voiceSettings.loadingVoices")}</span>
							) : (
								<select
									value={settings.cloudVoice ?? ""}
									onChange={(event) => updateVoice({ cloudVoice: event.target.value })}
									className="rounded-md border border-line-soft bg-base px-2 py-1 text-[12px] text-ink"
								>
									{(cloud ?? []).map((voice) => (
										<option key={voice.id} value={voice.id}>
											{voice.name}
											{voice.description ? ` · ${voice.description}` : ""}
										</option>
									))}
								</select>
							)}
							<span className="text-[10px] leading-snug text-ink-faint">
								{t("voiceSettings.libraryHint")}
							</span>
						</label>
					) : null}
					<div className="flex flex-col gap-1.5">
						<span className={label}>{t("voiceSettings.model")}</span>
						<Segment<string>
							value={settings.cloudModel}
							options={CLOUD_MODELS}
							onChange={(cloudModel) => updateVoice({ cloudModel })}
						/>
					</div>
				</>
			) : (
				<label className="flex flex-col gap-1.5">
					<span className={label}>{t("voiceSettings.voice")}</span>
					{native ? (
						<select
							value={settings.systemVoice ?? ""}
							onChange={(event) => updateVoice({ systemVoice: event.target.value })}
							className="rounded-md border border-line-soft bg-base px-2 py-1 text-[12px] text-ink"
						>
							{voices.map((voice) => (
								<option key={voice.name} value={voice.name}>
									{voice.name} · {voice.locale}
								</option>
							))}
						</select>
					) : (
						<span className="text-[11px] text-ink-faint">{t("voiceSettings.browserVoice")}</span>
					)}
					{native && voices.length > 0 && !hasGoodSystemVoice(voices) ? (
						<span className="text-[10px] leading-snug text-warning">
							{t("voiceSettings.noPremiumVoice", { context: platformContext })}
						</span>
					) : null}
				</label>
			)}

			<div className="flex flex-col gap-1.5">
				<span className={label}>{t("voiceSettings.rate")}</span>
				<Segment<number> value={settings.rate} options={RATES} onChange={(rate) => updateVoice({ rate })} />
			</div>

			{fallback && settings.engine === "elevenlabs" ? (
				<p className="flex gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[10.5px] leading-snug text-warning">
					<AlertTriangle size={11} className="mt-px shrink-0" />
					<span>{t("voiceSettings.fallback", { context: platformContext, reason: fallback })}</span>
				</p>
			) : null}

			<button
				type="button"
				onClick={() => {
					silence();
					say([
						{
							text: t("voiceSettings.sample"),
							keep: true,
						},
					]);
				}}
				className="flex items-center justify-center gap-1.5 rounded-md border border-line-soft py-1.5 text-[11.5px] text-ink hover:bg-hover"
			>
				<Play size={11} />
				{t("voiceSettings.tryVoice")}
			</button>
			{inMenu ? (
				<button
					type="button"
					onClick={() => go("settings", { settingsTab: "voice" })}
					className="text-center text-[11px] text-ink-faint hover:text-ink"
				>
					{t("voiceSettings.allSettings")}
				</button>
			) : null}
		</div>
	);
}
