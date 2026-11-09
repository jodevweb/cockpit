//! Le navigateur d'un workspace : celui que l'agent pilote, et qu'on regarde.
//!
//! Embarquer un navigateur dans la fenêtre (webview, iframe) en aurait fait un
//! pour nous seuls : aucun outil d'agent ne sait piloter le webview du système,
//! et l'agent aurait continué de tester ailleurs, hors de vue. On fait
//! l'inverse — un vrai navigateur sans fenêtre par dossier de travail, que
//! l'agent pilote par son protocole de débogage avec les outils qu'il connaît,
//! et dont le cockpit diffuse l'image. Ce qu'on voit est ce qu'il fait, pas une
//! reconstitution ; et l'on peut y cliquer soi-même, dans la même page.
//!
//! Rien n'est lancé d'avance. Le navigateur démarre au premier geste de
//! l'agent (c'est son pont qui le lance, voir `SHIM`) ou quand on ouvre
//! l'onglet ; un workspace qui n'en a pas l'usage n'en paie pas la mémoire.

use crate::config::config_dir;
use crate::error::{CockpitError, Result};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;

/// Le nom du serveur MCP : les gestes de l'agent s'appellent
/// `mcp__navigateur__…`, ce que l'interface reconnaît pour dire qu'il pilote.
pub const SERVER: &str = "navigateur";

/// Le serveur de Playwright, à la version éprouvée avec ce module. « latest »
/// irait chercher sur le réseau, à chaque agent, un code qu'on n'a pas lu.
const DEFAULT_SERVER: &str = "npx -y @playwright/mcp@0.0.83";

/// La taille de la page. Fixe : c'est celle des captures que l'agent prend,
/// et un « avant » ne se compare à un « après » qu'à cadre égal.
const WIDTH: u32 = 1280;
const HEIGHT: u32 = 800;

/// Combien de temps une demande d'image attend la suivante avant de rendre la
/// main : une page immobile n'en produit aucune, et l'interface doit pouvoir
/// constater que le navigateur est toujours là.
const FRAME_WAIT: Duration = Duration::from_secs(2);

/// Navigateurs qui parlent le protocole de débogage de Chrome, par préférence.
#[cfg(not(windows))]
fn known() -> Vec<PathBuf> {
	[
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		// Linux : là où les paquets des distributions et ceux des éditeurs
		// les posent.
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/microsoft-edge",
		"/usr/bin/brave-browser",
		"/snap/bin/chromium",
	]
	.iter()
	.map(PathBuf::from)
	.collect()
}

/// Sous Windows : Chrome là où son installeur le pose (pour tous, ou pour le
/// seul compte), puis Edge — présent sur tout Windows 10/11, et du même moteur
/// —, puis Chromium et Brave.
#[cfg(windows)]
fn known() -> Vec<PathBuf> {
	let roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"]
		.iter()
		.filter_map(std::env::var_os)
		.map(PathBuf::from)
		.collect();
	let mut found = Vec::new();
	for relative in [
		["Google", "Chrome", "Application", "chrome.exe"],
		["Microsoft", "Edge", "Application", "msedge.exe"],
		["Chromium", "Application", "chrome.exe", ""],
		["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
	] {
		for root in &roots {
			let mut path = root.clone();
			for part in relative.iter().filter(|part| !part.is_empty()) {
				path.push(part);
			}
			found.push(path);
		}
	}
	found
}

/// Le pont entre l'agent et le navigateur.
///
/// Le serveur MCP ne se connecte au navigateur qu'au premier geste. Ce script
/// se glisse devant lui pour ce seul instant : il laisse passer la poignée de
/// main et la liste des outils sans rien lancer, et démarre le navigateur
/// juste avant de transmettre le premier appel d'outil.
const SHIM: &str = r#"#!/usr/bin/env node
// Pont navigateur du cockpit — généré, ne pas éditer à la main.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, dirname } from "node:path";

const PORT = process.env.COCKPIT_BROWSER_PORT;
const LAUNCH = JSON.parse(process.env.COCKPIT_BROWSER_LAUNCH ?? "[]");
const SERVER = JSON.parse(process.env.COCKPIT_BROWSER_SERVER ?? "[]");
const PID_FILE = process.env.COCKPIT_BROWSER_PID;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

// `npx` est un script Node : lancé depuis le Finder, le cockpit n'a pas le
// dossier de Node dans son PATH, et `env node` échouerait.
// Le séparateur du système : `:` ici, `;` sous Windows.
const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` };

const alive = async () => {
  try {
    return (await fetch(`${ENDPOINT}/json/version`)).ok;
  } catch {
    return false;
  }
};

let ready = null;
/** Le navigateur répond — quitte à le lancer. Une seule fois par agent. */
const ensure = () =>
  (ready ??= (async () => {
    if (await alive()) return;
    if (LAUNCH.length === 0) return;
    const child = spawn(LAUNCH[0], LAUNCH.slice(1), { detached: true, stdio: "ignore", env, windowsHide: true });
    child.unref();
    if (PID_FILE && child.pid) writeFileSync(PID_FILE, String(child.pid));
    for (let waited = 0; waited < 15000; waited += 150) {
      if (await alive()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  })());

const server = spawn(SERVER[0], [...SERVER.slice(1), "--cdp-endpoint", ENDPOINT], {
  stdio: ["pipe", "inherit", "inherit"],
  env,
  windowsHide: true,
});
server.on("exit", (code) => process.exit(code ?? 0));

// Les messages passent dans l'ordre : un appel d'outil attend le navigateur,
// et tout ce qui le suit attend derrière lui.
let queue = Promise.resolve();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    queue = queue.then(async () => {
      if (line.includes('"tools/call"')) await ensure();
      server.stdin.write(`${line}\n`);
    });
  }
});
process.stdin.on("end", () => server.kill());
"#;

fn state_dir() -> PathBuf {
	config_dir().join("browsers")
}

fn port_path(cwd: &str) -> PathBuf {
	state_dir().join(format!("{}.port", crate::mcp::key_of(cwd)))
}

fn pid_path(cwd: &str) -> PathBuf {
	state_dir().join(format!("{}.pid", crate::mcp::key_of(cwd)))
}

/// Un profil par dossier de travail, à part de celui de l'utilisateur : ni ses
/// sessions, ni ses mots de passe, ni son historique n'y sont.
fn profile_path(cwd: &str) -> PathBuf {
	state_dir().join(format!("{}.profile", crate::mcp::key_of(cwd)))
}

/// Le port de débogage de ce dossier. Choisi une fois, puis gardé : l'agent
/// reçoit l'adresse à son lancement, bien avant que le navigateur n'existe.
fn port_for(cwd: &str) -> Option<u16> {
	std::fs::create_dir_all(state_dir()).ok()?;
	let path = port_path(cwd);
	if let Some(port) = std::fs::read_to_string(&path)
		.ok()
		.and_then(|raw| raw.trim().parse::<u16>().ok())
	{
		return Some(port);
	}
	let port = std::net::TcpListener::bind("127.0.0.1:0")
		.ok()?
		.local_addr()
		.ok()?
		.port();
	std::fs::write(&path, port.to_string()).ok()?;
	Some(port)
}

/// Le navigateur à lancer : celui des réglages, sinon le premier installé.
fn binary() -> Option<String> {
	let declared = crate::config::Config::active().workflow.browser_command;
	if !declared.trim().is_empty() {
		return Some(declared.trim().to_string());
	}
	known()
		.into_iter()
		.find(|path| path.exists())
		.map(|path| path.to_string_lossy().to_string())
}

/// La ligne qui lance le navigateur. Écrite ici seulement : le pont de l'agent
/// la reçoit telle quelle, pour que les deux lancent exactement le même.
fn launch_line(cwd: &str, port: u16) -> Option<Vec<String>> {
	Some(vec![
		binary()?,
		"--headless=new".into(),
		format!("--remote-debugging-port={port}"),
		format!("--user-data-dir={}", profile_path(cwd).to_string_lossy()),
		format!("--window-size={WIDTH},{HEIGHT}"),
		"--no-first-run".into(),
		"--no-default-browser-check".into(),
		"--disable-background-networking".into(),
		"--hide-scrollbars".into(),
		"about:blank".into(),
	])
}

async fn alive(port: u16) -> bool {
	reqwest::Client::new()
		.get(format!("http://127.0.0.1:{port}/json/version"))
		.timeout(Duration::from_millis(600))
		.send()
		.await
		.map(|response| response.status().is_success())
		.unwrap_or(false)
}

/// Ce que l'agent reçoit à son lancement : le fichier MCP qui déclare son
/// navigateur. Rien si l'équipe l'a coupé, s'il tourne dans un conteneur —
/// où « 127.0.0.1 » ne désigne plus le poste — ou s'il manque de quoi le
/// lancer.
pub fn mcp_config(cwd: &str, sandboxed: bool) -> Option<PathBuf> {
	let workflow = crate::config::Config::active().workflow;
	if !workflow.agent_browser || sandboxed {
		return None;
	}
	let node = crate::agent::node_binary()?;
	let port = port_for(cwd)?;
	let launch = launch_line(cwd, port)?;

	let line = if workflow.browser_server.trim().is_empty() {
		// Ses captures et ses relevés de page vont avec les autres livrables de
		// recette, là où le cockpit les montre déjà — sans quoi le serveur les
		// dépose dans un `.playwright-mcp` à la racine du dépôt.
		format!("{DEFAULT_SERVER} --output-dir {cwd}/.claude/work/navigateur")
	} else {
		workflow.browser_server.trim().to_string()
	};
	let mut server: Vec<String> = line.split_whitespace().map(str::to_string).collect();
	// `npx` vit à côté de `node` ; son chemin entier évite de dépendre du PATH.
	if server.first().map(String::as_str) == Some("npx") {
		if let Some(dir) = std::path::Path::new(&node).parent() {
			#[cfg(not(windows))]
			{
				server[0] = dir.join("npx").to_string_lossy().to_string();
			}
			// Sous Windows, `npx` est un `npx.cmd`, que Node refuse de lancer
			// sans passer par `cmd` (et ses règles d'échappement). On joue
			// directement son script avec `node`, comme le fait `npx.cmd`.
			#[cfg(windows)]
			{
				let script = dir.join("node_modules").join("npm").join("bin").join("npx-cli.js");
				if script.is_file() {
					server.splice(0..1, [node.clone(), script.to_string_lossy().to_string()]);
				} else {
					server[0] = dir.join("npx.cmd").to_string_lossy().to_string();
				}
			}
		}
	}

	let shim = state_dir().join("bridge.mjs");
	std::fs::write(&shim, SHIM).ok()?;

	let payload = serde_json::json!({
		"mcpServers": {
			SERVER: {
				"command": node,
				"args": [shim.to_string_lossy()],
				"env": {
					"COCKPIT_BROWSER_PORT": port.to_string(),
					"COCKPIT_BROWSER_LAUNCH": serde_json::to_string(&launch).ok()?,
					"COCKPIT_BROWSER_SERVER": serde_json::to_string(&server).ok()?,
					"COCKPIT_BROWSER_PID": pid_path(cwd).to_string_lossy(),
				},
			}
		}
	});
	let config = config_dir().join(format!("mcp-navigateur-{}.json", crate::mcp::key_of(cwd)));
	std::fs::write(&config, serde_json::to_string_pretty(&payload).ok()?).ok()?;
	Some(config)
}

/// Le navigateur de ce dossier répond-il ? Sans rien lancer.
pub async fn running(cwd: &str) -> bool {
	match std::fs::read_to_string(port_path(cwd))
		.ok()
		.and_then(|raw| raw.trim().parse::<u16>().ok())
	{
		Some(port) => alive(port).await,
		None => false,
	}
}

/// Une image de la page du navigateur, à l'instant — pour qui regarde de loin.
///
/// Le téléphone ne se branche pas sur le flux : il demande une image de temps
/// en temps. Rien n'est lancé pour lui ; sans navigateur, pas d'image.
pub async fn snapshot(cwd: &str) -> Option<(Vec<u8>, String)> {
	use base64::Engine;
	let port = std::fs::read_to_string(port_path(cwd)).ok()?.trim().parse::<u16>().ok()?;
	let targets: Vec<serde_json::Value> = reqwest::Client::new()
		.get(format!("http://127.0.0.1:{port}/json/list"))
		.timeout(Duration::from_millis(800))
		.send()
		.await
		.ok()?
		.json()
		.await
		.ok()?;
	// La première page de la liste est celle qui a servi en dernier.
	let page = targets.iter().find(|target| target["type"] == "page")?;
	let url = page["url"].as_str().unwrap_or_default().to_string();
	let (mut socket, _) = tokio_tungstenite::connect_async(page["webSocketDebuggerUrl"].as_str()?)
		.await
		.ok()?;
	let ask = serde_json::json!({
		"id": 1, "method": "Page.captureScreenshot",
		"params": { "format": "jpeg", "quality": 60 },
	});
	socket.send(Message::text(ask.to_string())).await.ok()?;
	let answer = tokio::time::timeout(Duration::from_secs(4), async {
		while let Some(Ok(message)) = socket.next().await {
			let Message::Text(raw) = message else { continue };
			let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.as_str()) else { continue };
			if value["id"] == 1 {
				return value["result"]["data"].as_str().map(str::to_string);
			}
		}
		None
	})
	.await
	.ok()??;
	let _ = socket.close(None).await;
	let bytes = base64::engine::general_purpose::STANDARD.decode(answer).ok()?;
	Some((bytes, url))
}

/// Ce qu'il y a sous un point de la page : de quoi désigner un élément à un
/// agent sans qu'il ait à deviner de quoi l'on parle.
///
/// Une capture entourée dit « là » ; elle ne dit pas « ce bouton-là, de ce
/// composant ». On lit donc l'élément lui-même : sa balise, son texte, un
/// sélecteur court, et — quand la page est une application React en
/// développement — le composant qui l'a rendu, voire son fichier.
const INSPECT: &str = r##"(() => {
  const el = document.elementFromPoint(__X__, __Y__);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  let component = null, source = null;
  const key = Object.keys(el).find((name) => name.startsWith("__reactFiber$"));
  for (let fiber = key ? el[key] : null; fiber && !(component && source); fiber = fiber.return) {
    const type = fiber.type;
    const name = typeof type === "function" ? (type.displayName || type.name)
      : type && typeof type === "object" ? (type.displayName || (type.render && (type.render.displayName || type.render.name)) || (type.type && (type.type.displayName || type.type.name)))
      : null;
    if (!component && name && /^[A-Z]/.test(name)) component = name;
    if (!source && fiber._debugSource) source = fiber._debugSource.fileName + ":" + fiber._debugSource.lineNumber;
  }
  const path = [];
  for (let node = el; node && node.nodeType === 1 && path.length < 4; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) part += "#" + node.id;
    else if (node.classList.length) part += "." + [...node.classList].slice(0, 2).join(".");
    path.unshift(part);
  }
  return {
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.value || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 90),
    testid: el.getAttribute("data-testid"),
    role: el.getAttribute("role"),
    label: el.getAttribute("aria-label"),
    selector: path.join(" > "),
    component,
    source,
    url: location.href,
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
})()"##;

pub async fn inspect(cwd: &str, x: f64, y: f64) -> Result<serde_json::Value> {
	let port = std::fs::read_to_string(port_path(cwd))
		.ok()
		.and_then(|raw| raw.trim().parse::<u16>().ok())
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("browser.notRunning")))?;
	let targets: Vec<serde_json::Value> = reqwest::Client::new()
		.get(format!("http://127.0.0.1:{port}/json/list"))
		.timeout(Duration::from_millis(800))
		.send()
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("browser.unreachable", &[("error", &e)])))?
		.json()
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("browser.unreadable", &[("error", &e)])))?;
	// La première page de la liste est celle qui a servi en dernier : celle
	// qu'on regarde.
	let socket_url = targets
		.iter()
		.find(|target| target["type"] == "page")
		.and_then(|page| page["webSocketDebuggerUrl"].as_str())
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("browser.noPage")))?;
	let (mut socket, _) = tokio_tungstenite::connect_async(socket_url)
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("browser.pageConnection", &[("error", &e)])))?;
	let expression = INSPECT.replace("__X__", &format!("{x:.1}")).replace("__Y__", &format!("{y:.1}"));
	let ask = serde_json::json!({
		"id": 1, "method": "Runtime.evaluate",
		"params": { "expression": expression, "returnByValue": true },
	});
	socket
		.send(Message::text(ask.to_string()))
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("browser.pageQuery", &[("error", &e)])))?;
	let answer = tokio::time::timeout(Duration::from_secs(3), async {
		while let Some(Ok(message)) = socket.next().await {
			let Message::Text(raw) = message else { continue };
			let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.as_str()) else { continue };
			if value["id"] == 1 {
				return Some(value["result"]["result"]["value"].clone());
			}
		}
		None
	})
	.await
	.ok()
	.flatten()
	.ok_or_else(|| CockpitError::msg(crate::i18n::t("browser.pageNoAnswer")))?;
	let _ = socket.close(None).await;
	Ok(answer)
}

/// Lance le navigateur s'il ne tourne pas, et rend son port.
async fn ensure(cwd: &str) -> Result<u16> {
	let port = port_for(cwd)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("browser.noPort")))?;
	if alive(port).await {
		return Ok(port);
	}
	let line = launch_line(cwd, port).ok_or_else(|| {
		CockpitError::msg(crate::i18n::t("browser.notFound"))
	})?;
	let child = crate::platform::quiet_std(&mut std::process::Command::new(&line[0]))
		.args(&line[1..])
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.spawn()
		.map_err(|e| CockpitError::msg(crate::i18n::tf("browser.startFailed", &[("error", &e)])))?;
	let _ = std::fs::write(pid_path(cwd), child.id().to_string());

	for _ in 0..100 {
		if alive(port).await {
			return Ok(port);
		}
		tokio::time::sleep(Duration::from_millis(150)).await;
	}
	Err(CockpitError::msg(crate::i18n::t("browser.startedNoAnswer")))
}

/// Ce qu'on fait dans la page depuis l'interface.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
	Navigate {
		url: String,
	},
	Back,
	Forward,
	Reload,
	/// La page prend la taille de l'onglet qui la montre, en pixels CSS : on
	/// regarde alors la page elle-même, pas sa photo réduite.
	Resize {
		width: u32,
		height: u32,
	},
	/// `mousePressed`, `mouseReleased`, `mouseMoved`, tels que le protocole les nomme.
	#[serde(rename_all = "camelCase")]
	Mouse {
		event: String,
		x: f64,
		y: f64,
		button: String,
		click_count: u32,
		modifiers: u32,
	},
	#[serde(rename_all = "camelCase")]
	Wheel {
		x: f64,
		y: f64,
		delta_x: f64,
		delta_y: f64,
	},
	/// Du texte posé d'un coup : ce qu'on colle. Le presse-papiers du
	/// navigateur n'est pas celui du poste, c'est l'interface qui le lit.
	Text {
		text: String,
	},
	/// `keyDown` ou `keyUp`.
	#[serde(rename_all = "camelCase")]
	Key {
		event: String,
		key: String,
		code: String,
		text: String,
		key_code: u32,
		modifiers: u32,
	},
}

/// L'en-tête d'une image : ce que la page est, et sa taille en pixels CSS —
/// le repère dans lequel se rendent les clics.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Shot {
	seq: u64,
	width: f64,
	height: f64,
	url: String,
	title: String,
}

#[derive(Default)]
struct Latest {
	shot: Shot,
	jpeg: Vec<u8>,
	closed: bool,
}

/// La dernière image de la page, et de quoi attendre la suivante.
///
/// L'interface vient la chercher quand elle a fini de dessiner la précédente.
/// La pousser par événement, douze fois par seconde, noyait la fenêtre : rien
/// ne ralentissait le navigateur quand l'affichage ne suivait plus, et les
/// images s'empilaient jusqu'à figer l'app.
#[derive(Default)]
struct Feed {
	latest: Mutex<Latest>,
	changed: Notify,
}

struct Viewer {
	actions: mpsc::UnboundedSender<Action>,
	task: tokio::task::JoinHandle<()>,
	feed: Arc<Feed>,
}

/// Les navigateurs qu'on regarde en ce moment, par dossier de travail.
#[derive(Clone, Default)]
pub struct SharedBrowsers(Arc<Mutex<HashMap<String, Viewer>>>);

struct Page {
	target: String,
	url: String,
	title: String,
}

/// Se branche sur le navigateur du dossier et diffuse sa page active. Le lance
/// s'il ne tourne pas. Déjà branché : ne fait rien.
pub async fn watch(shared: SharedBrowsers, cwd: String) -> Result<()> {
	// Retenu au premier branchement : la preuve filmée en a besoin pour libérer
	// un flux quand un agent s'arrête en pleine recette (`release_after_recording`).
	let _ = SHARED.set(shared.clone());
	{
		let viewers = shared.0.lock().unwrap();
		if viewers.get(&cwd).is_some_and(|viewer| !viewer.task.is_finished()) {
			return Ok(());
		}
	}
	let port = ensure(&cwd).await?;
	let version: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{port}/json/version"))
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("browser.unreachable", &[("error", &e)])))?
		.json()
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("browser.unreadable", &[("error", &e)])))?;
	let endpoint = version
		.get("webSocketDebuggerUrl")
		.and_then(|value| value.as_str())
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("browser.noDebugAddress")))?
		.to_string();
	let (socket, _) = tokio_tungstenite::connect_async(&endpoint)
		.await
		.map_err(|e| CockpitError::msg(crate::i18n::tf("browser.connection", &[("error", &e)])))?;

	let (actions, inbox) = mpsc::unbounded_channel();
	let feed = Arc::new(Feed::default());
	let task = tokio::spawn(stream(socket, inbox, feed.clone(), cwd.clone()));
	let mut viewers = shared.0.lock().unwrap();
	// Deux branchements simultanés (l'onglet, et un geste de l'agent) passent
	// tous deux le test du début : le second ne remplace pas le premier, il se
	// retire — sinon le flux remplacé tournerait sans plus personne pour l'arrêter.
	if viewers.get(&cwd).is_some_and(|viewer| !viewer.task.is_finished()) {
		task.abort();
		return Ok(());
	}
	viewers.insert(cwd, Viewer { actions, task, feed });
	Ok(())
}

/// Les navigateurs regardés, retenus au premier branchement.
static SHARED: std::sync::OnceLock<SharedBrowsers> = std::sync::OnceLock::new();

/// Un enregistrement vient d'être abandonné (agent arrêté en pleine recette) :
/// le flux qu'il gardait ouvert s'arrête, sauf si l'onglet le regarde.
pub fn release_after_recording(cwd: &str) {
	if let Some(shared) = SHARED.get() {
		release(shared, cwd);
	}
}

type Socket = tokio_tungstenite::WebSocketStream<
	tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// La boucle d'un navigateur regardé : ses pages, leurs images, nos gestes.
async fn stream(socket: Socket, mut inbox: mpsc::UnboundedReceiver<Action>, feed: Arc<Feed>, cwd: String) {
	use base64::Engine;
	let close = |feed: &Feed| {
		feed.latest.lock().unwrap().closed = true;
		feed.changed.notify_waiters();
	};
	let (mut out, mut incoming) = socket.split();
	let mut next_id: u64 = 0;
	let mut command = |method: &str, params: serde_json::Value, session: Option<&str>| {
		next_id += 1;
		let mut message = serde_json::json!({ "id": next_id, "method": method, "params": params });
		if let Some(session) = session {
			message["sessionId"] = serde_json::Value::String(session.to_string());
		}
		Message::text(message.to_string())
	};

	// S'attacher à toutes les pages, présentes et à venir : l'agent ouvre les
	// siennes par sa propre connexion, et c'est justement elles qu'on veut voir.
	let attach = command(
		"Target.setAutoAttach",
		serde_json::json!({
			"autoAttach": true,
			"waitForDebuggerOnStart": false,
			"flatten": true,
			"filter": [{ "type": "page" }],
		}),
		None,
	);
	if out.send(attach).await.is_err() {
		close(&feed);
		return;
	}
	let discover = command("Target.setDiscoverTargets", serde_json::json!({ "discover": true }), None);
	let _ = out.send(discover).await;

	let mut pages: HashMap<String, Page> = HashMap::new();
	// La page qu'on montre : celle où il se passe quelque chose.
	let mut active: Option<String> = None;
	let mut active_at = Instant::now();
	// La taille que l'onglet a demandée, à redonner à chaque page qui s'ouvre.
	let mut viewport: Option<(u32, u32)> = None;
	// Une adresse demandée avant que la première page ne se soit annoncée. On
	// ouvrait alors un second onglet à côté de celui du lancement : deux pages
	// pour une, dont une vide qui pouvait reprendre la vue.
	let mut pending: Option<String> = None;
	let mut seen_page = false;
	let metrics = |width: u32, height: u32| {
		serde_json::json!({ "width": width, "height": height, "deviceScaleFactor": 1, "mobile": false })
	};

	loop {
		tokio::select! {
			action = inbox.recv() => {
				let Some(action) = action else { break };
				let session = active.clone();
				let session = session.as_deref();
				let message = match action {
					Action::Navigate { url } => match session {
						Some(_) => command("Page.navigate", serde_json::json!({ "url": url }), session),
						// Plus aucune page : on en rouvre une.
						None if seen_page => command("Target.createTarget", serde_json::json!({ "url": url }), None),
						// Pas encore de page : celle du lancement arrive, elle ira là.
						None => {
							pending = Some(url);
							continue;
						}
					},
					Action::Back => command("Runtime.evaluate", serde_json::json!({ "expression": "history.back()" }), session),
					Action::Forward => command("Runtime.evaluate", serde_json::json!({ "expression": "history.forward()" }), session),
					Action::Reload => command("Page.reload", serde_json::json!({}), session),
					Action::Resize { width, height } => {
						let size = (width.clamp(320, 2560), height.clamp(240, 1600));
						viewport = Some(size);
						if session.is_none() {
							continue;
						}
						command("Emulation.setDeviceMetricsOverride", metrics(size.0, size.1), session)
					}
					Action::Mouse { event, x, y, button, click_count, modifiers } => command(
						"Input.dispatchMouseEvent",
						serde_json::json!({
							"type": event, "x": x, "y": y, "button": button,
							"buttons": if button == "left" && event != "mouseReleased" { 1 } else { 0 },
							"clickCount": click_count, "modifiers": modifiers,
						}),
						session,
					),
					Action::Wheel { x, y, delta_x, delta_y } => command(
						"Input.dispatchMouseEvent",
						serde_json::json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": delta_x, "deltaY": delta_y }),
						session,
					),
					Action::Text { text } => command("Input.insertText", serde_json::json!({ "text": text }), session),
					Action::Key { event, key, code, text, key_code, modifiers } => {
						// Pas de `nativeVirtualKeyCode` : l'interface ne connaît que le
						// code de touche du web, qui n'est pas celui de macOS. Avec lui,
						// Chrome fabriquait une touche du système, et reprenait comme
						// raccourci chaque touche que la page ne consommait pas — Maj,
						// Échap. À la troisième il se figeait pour de bon, ou ouvrait une
						// page de ses réglages : un mot de passe à majuscules suffisait.
						//
						// Une touche sans texte s'annonce `rawKeyDown`, comme le font
						// les pilotes de navigateur : `keyDown` promet un caractère.
						let typed = !text.is_empty() && event == "keyDown";
						let kind = if event == "keyDown" && !typed { "rawKeyDown" } else { event.as_str() };
						let mut params = serde_json::json!({
							"type": kind, "key": key, "code": code,
							"windowsVirtualKeyCode": key_code,
							"modifiers": modifiers,
						});
						if typed {
							params["unmodifiedText"] = serde_json::Value::String(text.clone());
							params["text"] = serde_json::Value::String(text);
						}
						command("Input.dispatchKeyEvent", params, session)
					}
				};
				if out.send(message).await.is_err() {
					break;
				}
			}
			message = incoming.next() => {
				let Some(Ok(message)) = message else { break };
				let Message::Text(raw) = message else { continue };
				let Ok(event) = serde_json::from_str::<serde_json::Value>(raw.as_str()) else { continue };
				let params = &event["params"];
				match event["method"].as_str().unwrap_or_default() {
					"Target.attachedToTarget" => {
						let info = &params["targetInfo"];
						if info["type"] != "page" {
							continue;
						}
						let Some(session) = params["sessionId"].as_str().map(str::to_string) else { continue };
						pages.insert(session.clone(), Page {
							target: info["targetId"].as_str().unwrap_or_default().to_string(),
							url: info["url"].as_str().unwrap_or_default().to_string(),
							title: info["title"].as_str().unwrap_or_default().to_string(),
						});
						let enable = command("Page.enable", serde_json::json!({}), Some(&session));
						let cast = command(
							"Page.startScreencast",
							serde_json::json!({
								"format": "jpeg", "quality": 70,
								"maxWidth": 2560, "maxHeight": 1600, "everyNthFrame": 1,
							}),
							Some(&session),
						);
						if out.send(enable).await.is_err() {
							break;
						}
						if let Some((width, height)) = viewport {
							let size = command("Emulation.setDeviceMetricsOverride", metrics(width, height), Some(&session));
							if out.send(size).await.is_err() {
								break;
							}
						}
						if out.send(cast).await.is_err() {
							break;
						}
						seen_page = true;
						if let Some(url) = pending.take() {
							let go = command("Page.navigate", serde_json::json!({ "url": url }), Some(&session));
							if out.send(go).await.is_err() {
								break;
							}
						}
						// Une page qui s'ouvre prend la vue : c'est là que l'agent va.
						active = Some(session);
						active_at = Instant::now();
					}
					"Target.detachedFromTarget" => {
						if let Some(session) = params["sessionId"].as_str() {
							pages.remove(session);
							if active.as_deref() == Some(session) {
								active = pages.keys().next().cloned();
							}
						}
					}
					"Target.targetInfoChanged" => {
						let info = &params["targetInfo"];
						let target = info["targetId"].as_str().unwrap_or_default();
						if let Some(page) = pages.values_mut().find(|page| page.target == target) {
							page.url = info["url"].as_str().unwrap_or_default().to_string();
							page.title = info["title"].as_str().unwrap_or_default().to_string();
						}
					}
					"Page.screencastFrame" => {
						let Some(session) = event["sessionId"].as_str().map(str::to_string) else { continue };
						// Chaque image s'acquitte, montrée ou non : sans cela le
						// navigateur cesse d'en envoyer.
						let ack = command(
							"Page.screencastFrameAck",
							serde_json::json!({ "sessionId": params["sessionId"] }),
							Some(&session),
						);
						if out.send(ack).await.is_err() {
							break;
						}
						// On reste sur la page qu'on montre tant qu'elle bouge ; une
						// autre ne prend la vue que si celle-ci s'est tue une seconde.
						let shown = active.as_deref() == Some(session.as_str());
						if !shown && active.is_some() && active_at.elapsed() < Duration::from_secs(1) {
							continue;
						}
						active = Some(session.clone());
						active_at = Instant::now();
						let Some(page) = pages.get(&session) else { continue };
						let Some(jpeg) = params["data"]
							.as_str()
							.and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
						else {
							continue;
						};
						// La preuve filmée garde sa part des images quand un agent
						// pilote (voir `proof.rs`). Sans enregistrement ouvert, rien.
						crate::proof::frame(&cwd, &jpeg, &page.url);
						{
							let mut latest = feed.latest.lock().unwrap();
							latest.shot = Shot {
								seq: latest.shot.seq + 1,
								width: params["metadata"]["deviceWidth"].as_f64().unwrap_or(WIDTH as f64),
								height: params["metadata"]["deviceHeight"].as_f64().unwrap_or(HEIGHT as f64),
								url: page.url.clone(),
								title: page.title.clone(),
							};
							latest.jpeg = jpeg;
						}
						feed.changed.notify_waiters();
					}
					_ => {}
				}
			}
		}
	}
	close(&feed);
}

/// L'image suivante de la page : celle qui vient après `after`.
///
/// Rend un bloc binaire — la longueur de l'en-tête sur quatre octets, l'en-tête
/// en JSON, puis le JPEG — ou un bloc vide si rien n'a bougé pendant l'attente.
/// Une erreur veut dire que le navigateur n'est plus regardé, ou s'est fermé.
pub async fn frame(shared: &SharedBrowsers, cwd: &str, after: u64) -> Result<Vec<u8>> {
	let feed = shared
		.0
		.lock()
		.unwrap()
		.get(cwd)
		.map(|viewer| viewer.feed.clone())
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("browser.notOpen")))?;
	let deadline = Instant::now() + FRAME_WAIT;
	loop {
		// L'écoute se prend avant de regarder : une image arrivée entre les deux
		// ne doit pas être manquée.
		let waiting = feed.changed.notified();
		{
			let latest = feed.latest.lock().unwrap();
			if latest.closed {
				return Err(CockpitError::msg(crate::i18n::t("browser.closed")));
			}
			if latest.shot.seq > after && !latest.jpeg.is_empty() {
				let header = serde_json::to_vec(&latest.shot).unwrap_or_default();
				let mut block = Vec::with_capacity(4 + header.len() + latest.jpeg.len());
				block.extend_from_slice(&(header.len() as u32).to_le_bytes());
				block.extend_from_slice(&header);
				block.extend_from_slice(&latest.jpeg);
				return Ok(block);
			}
		}
		let left = deadline.saturating_duration_since(Instant::now());
		if left.is_zero() || tokio::time::timeout(left, waiting).await.is_err() {
			return Ok(Vec::new());
		}
	}
}

/// Un geste dans la page qu'on regarde.
pub fn act(shared: &SharedBrowsers, cwd: &str, action: Action) -> Result<()> {
	let viewers = shared.0.lock().unwrap();
	let viewer = viewers
		.get(cwd)
		.ok_or_else(|| CockpitError::msg(crate::i18n::t("browser.notOpen")))?;
	viewer
		.actions
		.send(action)
		.map_err(|_| CockpitError::msg(crate::i18n::t("browser.closed")))
}

/// Les dossiers dont l'onglet Navigateur est à l'écran.
///
/// Le flux d'images sert deux lecteurs : l'onglet, et la preuve filmée
/// (`proof.rs`). L'onglet qui se masquait coupait le flux pour les deux, et une
/// recette en cours perdait toutes ses images — c'est ainsi qu'une recette
/// pilotée pendant qu'on changeait d'écran rendait un film vide.
fn ui_watching() -> &'static Mutex<std::collections::HashSet<String>> {
	static UI: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
	UI.get_or_init(Default::default)
}

/// Le flux peut-il s'arrêter ? Seulement quand plus personne ne le lit.
fn may_stop(ui: bool, recording: bool) -> bool {
	!ui && !recording
}

/// L'onglet Navigateur se branche : comme `watch`, en retenant qu'il regarde.
pub async fn watch_for_ui(shared: SharedBrowsers, cwd: String) -> Result<()> {
	ui_watching().lock().unwrap().insert(cwd.clone());
	watch(shared, cwd).await
}

/// L'onglet cesse de regarder, sans rien arrêter : l'agent garde son
/// navigateur, et un enregistrement en cours garde son flux.
pub fn unwatch(shared: &SharedBrowsers, cwd: &str) {
	ui_watching().lock().unwrap().remove(cwd);
	release(shared, cwd);
}

/// Arrête le flux si plus personne ne le lit : appelé quand l'onglet se masque,
/// et quand un enregistrement se referme.
pub fn release(shared: &SharedBrowsers, cwd: &str) {
	let ui = ui_watching().lock().unwrap().contains(cwd);
	if !may_stop(ui, crate::proof::is_recording(cwd)) {
		return;
	}
	if let Some(viewer) = shared.0.lock().unwrap().remove(cwd) {
		viewer.task.abort();
	}
}

fn kill(path: &std::path::Path) {
	if let Some(pid) = std::fs::read_to_string(path)
		.ok()
		.and_then(|raw| raw.trim().parse::<u32>().ok())
	{
		// Un pid disparu rend une erreur qu'on ignore.
		crate::platform::terminate_pid(pid);
	}
	let _ = std::fs::remove_file(path);
}

/// Arrête le navigateur d'un dossier — le workspace se ferme, ou on le demande.
pub fn stop(shared: &SharedBrowsers, cwd: &str) {
	// Le navigateur s'arrête : le flux aussi, enregistrement ou pas.
	ui_watching().lock().unwrap().remove(cwd);
	if let Some(viewer) = shared.0.lock().unwrap().remove(cwd) {
		viewer.task.abort();
	}
	kill(&pid_path(cwd));
}

/// Arrête tous les navigateurs lancés pour des workspaces : l'app se ferme, et
/// rien de ce qu'elle a démarré ne doit lui survivre.
pub fn stop_all(shared: &SharedBrowsers) {
	for (_, viewer) in shared.0.lock().unwrap().drain() {
		viewer.task.abort();
	}
	let Ok(entries) = std::fs::read_dir(state_dir()) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.extension().is_some_and(|extension| extension == "pid") {
			kill(&path);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Le flux ne s'arrête que quand ni l'onglet ni une recette filmée ne le
	/// lisent : masquer l'onglet en pleine recette coupait le film.
	#[test]
	fn le_flux_reste_tant_qu_un_lecteur_le_lit() {
		assert!(may_stop(false, false));
		assert!(!may_stop(true, false), "l'onglet regarde");
		assert!(!may_stop(false, true), "une recette est filmée");
		assert!(!may_stop(true, true));
	}

	/// L'en-tête d'un bloc rendu par `frame`.
	fn header(block: &[u8]) -> serde_json::Value {
		let length = u32::from_le_bytes(block[..4].try_into().unwrap()) as usize;
		serde_json::from_slice(&block[4..4 + length]).unwrap()
	}

	/// De bout en bout contre un vrai navigateur : lancer, naviguer, lire des
	/// images, redimensionner, arrêter. Écarté par défaut — il lui faut Chrome.
	///
	///   cargo test navigateur_de_bout_en_bout -- --ignored --nocapture
	#[tokio::test(flavor = "multi_thread")]
	#[ignore]
	async fn navigateur_de_bout_en_bout() {
		let cwd = std::env::temp_dir().join(format!("cockpit-essai-{}", std::process::id()));
		std::fs::create_dir_all(&cwd).unwrap();
		let cwd = cwd.to_string_lossy().to_string();
		let shared = SharedBrowsers::default();

		watch(shared.clone(), cwd.clone()).await.expect("le navigateur démarre");
		assert!(running(&cwd).await);

		// Une page qui bouge : de quoi mesurer le débit.
		let page = "data:text/html,<body style='margin:0'><h1 id=t>0</h1><script>let n=0;setInterval(()=>t.textContent=++n,16)</script>";
		act(&shared, &cwd, Action::Navigate { url: page.into() }).unwrap();

		let mut seq = 0;
		let mut sizes = Vec::new();
		let started = Instant::now();
		while sizes.len() < 30 && started.elapsed() < Duration::from_secs(10) {
			let block = frame(&shared, &cwd, seq).await.expect("une image");
			if block.is_empty() {
				continue;
			}
			let shot = header(&block);
			seq = shot["seq"].as_u64().unwrap();
			sizes.push(block.len());
		}
		let took = started.elapsed();
		println!("{} images en {:?}, {} octets en moyenne", sizes.len(), took, sizes.iter().sum::<usize>() / sizes.len().max(1));
		assert!(sizes.len() >= 30, "trop peu d'images : {}", sizes.len());

		// La page prend la taille qu'on lui demande.
		act(&shared, &cwd, Action::Resize { width: 900, height: 600 }).unwrap();
		let mut width = 0.0;
		let resized = Instant::now();
		while width != 900.0 && resized.elapsed() < Duration::from_secs(5) {
			let block = frame(&shared, &cwd, seq).await.expect("une image");
			if block.is_empty() {
				continue;
			}
			let shot = header(&block);
			seq = shot["seq"].as_u64().unwrap();
			width = shot["width"].as_f64().unwrap();
		}
		assert_eq!(width, 900.0);

		stop(&shared, &cwd);
		tokio::time::sleep(Duration::from_millis(800)).await;
		assert!(!running(&cwd).await, "le navigateur s'arrête");
		assert!(frame(&shared, &cwd, seq).await.is_err(), "plus rien à regarder");

		let _ = std::fs::remove_dir_all(profile_path(&cwd));
		let _ = std::fs::remove_file(port_path(&cwd));
		let _ = std::fs::remove_dir_all(&cwd);
	}

	/// Une touche, comme l'interface l'envoie : enfoncée puis relâchée.
	fn tape(shared: &SharedBrowsers, cwd: &str, key: &str, code: u32) {
		let text = if key.chars().count() == 1 { key.to_string() } else { String::new() };
		for event in ["keyDown", "keyUp"] {
			act(shared, cwd, Action::Key {
				event: event.into(),
				key: key.into(),
				code: String::new(),
				text: text.clone(),
				key_code: code,
				modifiers: 0,
			})
			.unwrap();
		}
	}

	fn clic(shared: &SharedBrowsers, cwd: &str, x: f64, y: f64) {
		for event in ["mousePressed", "mouseReleased"] {
			act(shared, cwd, Action::Mouse { event: event.into(), x, y, button: "left".into(), click_count: 1, modifiers: 0 }).unwrap();
		}
	}

	/// Attend que l'adresse de la page — où elle recopie l'état de son
	/// formulaire — devienne celle qu'on attend, en lisant les images comme
	/// l'interface le fait.
	async fn etat(shared: &SharedBrowsers, cwd: &str, seq: &mut u64, attendu: &str) -> String {
		let started = Instant::now();
		let mut vu = String::new();
		while started.elapsed() < Duration::from_secs(6) {
			let block = frame(shared, cwd, *seq).await.expect("une image");
			if block.is_empty() {
				continue;
			}
			let shot = header(&block);
			*seq = shot["seq"].as_u64().unwrap();
			vu = shot["url"].as_str().unwrap_or_default().to_string();
			if vu == attendu {
				break;
			}
		}
		vu
	}

	/// Un formulaire de connexion, rempli comme on le remplit depuis l'onglet :
	/// un clic, des touches, puis le champ du mot de passe — au clic, puis à la
	/// tabulation — pendant que la souris bouge et que les images défilent.
	///
	///   cargo test saisie_dans_un_formulaire -- --ignored --nocapture
	#[tokio::test(flavor = "multi_thread")]
	#[ignore]
	async fn saisie_dans_un_formulaire() {
		let cwd = std::env::temp_dir().join(format!("cockpit-saisie-{}", std::process::id()));
		std::fs::create_dir_all(&cwd).unwrap();
		let cwd = cwd.to_string_lossy().to_string();
		let shared = SharedBrowsers::default();
		watch(shared.clone(), cwd.clone()).await.expect("le navigateur démarre");
		act(&shared, &cwd, Action::Resize { width: 1100, height: 700 }).unwrap();

		// La page recopie l'état de son formulaire dans son adresse, que chaque
		// image porte. Elle bat : une page immobile ne produit pas d'image.
		const PAGE: &str = "<body style='margin:0'><form>\
			<input id=e type=email style='position:absolute;left:100px;top:100px;width:300px;height:30px'>\
			<input id=p type=password autocomplete=current-password style='position:absolute;left:100px;top:200px;width:300px;height:30px'>\
			</form><i id=k></i><script>const say=()=>history.replaceState(null,'','/'+e.value+'~'+p.value+'~'+(document.activeElement.id||'-'));\
			addEventListener('input',say);addEventListener('focusin',say);say();\
			let n=0;setInterval(()=>k.textContent=++n,150)</script>";
		let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
		let port = listener.local_addr().unwrap().port();
		std::thread::spawn(move || {
			use std::io::{Read, Write};
			for mut stream in listener.incoming().flatten() {
				let _ = stream.read(&mut [0u8; 2048]);
				let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{PAGE}", PAGE.len());
			}
		});
		let at = |state: &str| format!("http://127.0.0.1:{port}/{state}");
		act(&shared, &cwd, Action::Navigate { url: at("") }).unwrap();
		let mut seq = 0;
		assert_eq!(etat(&shared, &cwd, &mut seq, &at("~~-")).await, at("~~-"));

		// Une adresse demandée dès l'ouverture va dans la page du lancement :
		// pas de second onglet à côté.
		let debug = std::fs::read_to_string(port_path(&cwd)).unwrap();
		let targets: Vec<serde_json::Value> = reqwest::get(format!("http://127.0.0.1:{}/json/list", debug.trim()))
			.await
			.unwrap()
			.json()
			.await
			.unwrap();
		assert_eq!(targets.iter().filter(|target| target["type"] == "page").count(), 1, "une seule page");

		clic(&shared, &cwd, 250.0, 115.0);
		for (key, code) in [("a", 65), ("@", 50), ("b", 66), (".", 190), ("c", 67)] {
			tape(&shared, &cwd, key, code);
		}
		assert_eq!(etat(&shared, &cwd, &mut seq, &at("a@b.c~~e")).await, at("a@b.c~~e"));

		// La souris traverse la page jusqu'au second champ, comme une main.
		for step in 0..40 {
			act(&shared, &cwd, Action::Mouse {
				event: "mouseMoved".into(), x: 250.0, y: 115.0 + step as f64 * 2.5,
				button: "none".into(), click_count: 0, modifiers: 0,
			})
			.unwrap();
		}
		clic(&shared, &cwd, 250.0, 215.0);
		for (key, code) in [("x", 88), ("y", 89), ("z", 90)] {
			tape(&shared, &cwd, key, code);
		}
		assert_eq!(etat(&shared, &cwd, &mut seq, &at("a@b.c~xyz~p")).await, at("a@b.c~xyz~p"), "le mot de passe se saisit au clic");

		// Et à la tabulation, depuis le premier champ : arriver ainsi dans un
		// champ en sélectionne le contenu, que la frappe remplace.
		clic(&shared, &cwd, 250.0, 115.0);
		tape(&shared, &cwd, "Tab", 9);
		tape(&shared, &cwd, "w", 87);
		assert_eq!(etat(&shared, &cwd, &mut seq, &at("a@b.c~w~p")).await, at("a@b.c~w~p"), "le mot de passe se saisit à la tabulation");

		// Un mot de passe a des majuscules et des chiffres : autant d'appuis sur
		// Maj, que la page ne consomme pas. Au troisième, Chrome se figeait pour
		// de bon — il les reprenait comme des raccourcis du système. Échap, de
		// même. Après une rafale des deux, la page doit encore répondre.
		let maj = |event: &str, modifiers: u32| Action::Key {
			event: event.into(),
			key: "Shift".into(),
			code: "ShiftLeft".into(),
			text: String::new(),
			key_code: 16,
			modifiers,
		};
		for (letter, code) in [("A", 65), ("B", 66), ("C", 67), ("D", 68), ("E", 69)] {
			act(&shared, &cwd, maj("keyDown", 8)).unwrap();
			for event in ["keyDown", "keyUp"] {
				act(&shared, &cwd, Action::Key {
					event: event.into(),
					key: letter.into(),
					code: format!("Key{letter}"),
					text: letter.into(),
					key_code: code,
					modifiers: 8,
				})
				.unwrap();
			}
			act(&shared, &cwd, maj("keyUp", 0)).unwrap();
		}
		for _ in 0..5 {
			tape(&shared, &cwd, "Escape", 27);
		}
		tape(&shared, &cwd, "z", 90);
		assert_eq!(
			etat(&shared, &cwd, &mut seq, &at("a@b.c~wABCDEz~p")).await,
			at("a@b.c~wABCDEz~p"),
			"le navigateur répond encore après des majuscules et des Échap"
		);

		stop(&shared, &cwd);
		// Le navigateur écrit encore dans son profil en s'arrêtant.
		tokio::time::sleep(Duration::from_millis(800)).await;
		let _ = std::fs::remove_dir_all(profile_path(&cwd));
		let _ = std::fs::remove_file(port_path(&cwd));
		let _ = std::fs::remove_dir_all(&cwd);
	}
}
