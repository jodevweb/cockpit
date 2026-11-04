#!/usr/bin/env node
// Le cask Homebrew et les manifestes winget d'une version publiée.
//
//   node scripts/packages.mjs            # la dernière version publiée
//   node scripts/packages.mjs v0.85.1    # une version précise
//
// Lit la release sur jodevweb/cockpit-releases, télécharge chaque binaire pour
// en calculer l'empreinte SHA-256 — une empreinte recopiée à la main est une
// empreinte fausse un jour sur dix —, puis écrit dans packaging/out/<version>/ :
//
//   homebrew/cockpit.rb             à poser dans Casks/ du tap
//   winget/<fichiers>.yaml          à valider (`winget validate`) puis soumettre
//
// Rien n'est publié ici : c'est le mainteneur qui pousse le cask dans le tap et
// soumet les manifestes (voir docs/RELEASING.md). Le script ne lit que des
// adresses publiques : aucun jeton n'est nécessaire.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEPOT = "jodevweb/cockpit-releases";
const SOURCES = "https://github.com/jodevweb/cockpit";
const WINGET_ID = "Jodevweb.Cockpit";
const DESCRIPTION = "A cockpit for coding agents (Claude Code, Codex, Gemini): run, watch and review them across git worktrees.";

async function json(url) {
	const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "cockpit-packages" } });
	if (!response.ok) throw new Error(`${url} : ${response.status} ${response.statusText}`);
	return response.json();
}

/** L'empreinte d'un fichier distant, lue au fil du téléchargement. */
async function sha256(url) {
	const response = await fetch(url, { headers: { "user-agent": "cockpit-packages" }, redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`${url} : ${response.status} ${response.statusText}`);
	const hash = createHash("sha256");
	for await (const chunk of response.body) hash.update(chunk);
	return hash.digest("hex");
}

/** Le cask : les deux architectures quand la version les a, Apple Silicon seule sinon. */
function cask({ version, arm, intel }) {
	const both = Boolean(arm && intel);
	const only = arm ? "aarch64" : "x64";
	const lines = [
		`cask "cockpit" do`,
		both ? `  arch arm: "aarch64", intel: "x64"` : null,
		``,
		`  version "${version}"`,
		both ? `  sha256 arm:   "${arm}",\n         intel: "${intel}"` : `  sha256 "${arm ?? intel}"`,
		``,
		`  url "https://github.com/${DEPOT}/releases/download/v#{version}/Cockpit_#{version}_${both ? "#{arch}" : only}.app.tar.gz",`,
		`      verified: "github.com/${DEPOT}/"`,
		`  name "Cockpit"`,
		// `brew audit` refuse une description qui commence par un article ou qui
		// répète le nom du cask.
		`  desc "Run, watch and review coding agents across git worktrees"`,
		`  homepage "${SOURCES}"`,
		``,
		`  livecheck do`,
		`    url :url`,
		`    strategy :github_latest`,
		`  end`,
		``,
		// L'updater intégré propose les versions suivantes : brew ne doit pas
		// croire l'app figée à celle qu'il a posée.
		`  auto_updates true`,
		`  depends_on macos: ">= :ventura"`,
		both ? null : `  depends_on arch: :${arm ? "arm64" : "x86_64"}`,
		``,
		`  app "Cockpit.app"`,
		``,
		// L'app n'est pas notarisée : sans cela, Gatekeeper refuse de l'ouvrir,
		// et le contournement par clic droit n'existe plus depuis macOS 15. C'est
		// le geste que le README fait faire à la main (voir « Installer sans
		// compiler ») ; installer par ce tap revient à le demander.
		`  postflight do`,
		`    system_command "/usr/bin/xattr",`,
		`                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Cockpit.app"]`,
		`  end`,
		``,
		`  zap trash: "~/.config/cockpit"`,
		`end`,
		``,
	];
	return lines.filter((line) => line !== null).join("\n");
}

/** Les trois manifestes winget (schéma 1.6) : version, installeur, description. */
function winget({ version, installerUrl, installerSha }) {
	const header = (type) =>
		`# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.6.0.schema.json\n`;
	const common = `PackageIdentifier: ${WINGET_ID}\nPackageVersion: ${version}\n`;
	return {
		[`${WINGET_ID}.yaml`]:
			header("version") + common + `DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.6.0\n`,
		[`${WINGET_ID}.installer.yaml`]:
			header("installer") +
			common +
			[
				`InstallerType: nullsoft`,
				// L'installeur NSIS de Tauri s'installe pour l'utilisateur courant,
				// sans droits administrateur (%LOCALAPPDATA%\\Cockpit).
				`Scope: user`,
				`UpgradeBehavior: install`,
				// Le cockpit joue toutes ses commandes dans le bash de Git for Windows.
				`Dependencies:`,
				`  PackageDependencies:`,
				`  - PackageIdentifier: Git.Git`,
				`Installers:`,
				`- Architecture: x64`,
				`  InstallerUrl: ${installerUrl}`,
				`  InstallerSha256: ${installerSha.toUpperCase()}`,
				`ManifestType: installer`,
				`ManifestVersion: 1.6.0`,
				``,
			].join("\n"),
		[`${WINGET_ID}.locale.en-US.yaml`]:
			header("defaultLocale") +
			common +
			[
				`PackageLocale: en-US`,
				`Publisher: jodevweb`,
				`PublisherUrl: https://github.com/jodevweb`,
				`PackageName: Cockpit`,
				`PackageUrl: ${SOURCES}`,
				`License: MIT`,
				`LicenseUrl: ${SOURCES}/blob/main/LICENSE`,
				// Entre guillemets : la description contient « : », qu'un YAML nu lit
				// comme une clé.
				`ShortDescription: ${JSON.stringify(DESCRIPTION)}`,
				`Tags:`,
				`- ai`,
				`- agents`,
				`- claude-code`,
				`- git`,
				`- worktree`,
				`ReleaseNotesUrl: https://github.com/${DEPOT}/releases/tag/v${version}`,
				`ManifestType: defaultLocale`,
				`ManifestVersion: 1.6.0`,
				``,
			].join("\n"),
	};
}

async function main() {
	const tag = process.argv[2];
	const release = await json(
		`https://api.github.com/repos/${DEPOT}/releases/${tag ? `tags/${tag}` : "latest"}`,
	);
	const version = release.tag_name.replace(/^v/, "");
	const asset = (name) => release.assets.find((entry) => entry.name === name)?.browser_download_url;

	const armUrl = asset(`Cockpit_${version}_aarch64.app.tar.gz`);
	const intelUrl = asset(`Cockpit_${version}_x64.app.tar.gz`);
	const setupUrl = asset(`Cockpit_${version}_x64-setup.exe`);
	console.log(`version ${version}`);

	const out = join("packaging", "out", version);
	if (armUrl || intelUrl) {
		const arm = armUrl ? await sha256(armUrl) : null;
		const intel = intelUrl ? await sha256(intelUrl) : null;
		console.log(`  macOS  aarch64 ${arm ?? "absent"}\n         x64     ${intel ?? "absent"}`);
		mkdirSync(join(out, "homebrew"), { recursive: true });
		writeFileSync(join(out, "homebrew", "cockpit.rb"), cask({ version, arm, intel }));
	} else {
		console.log("  macOS  aucune archive : pas de cask");
	}
	if (setupUrl) {
		const installerSha = await sha256(setupUrl);
		console.log(`  Windows x64    ${installerSha}`);
		mkdirSync(join(out, "winget"), { recursive: true });
		for (const [name, text] of Object.entries(winget({ version, installerUrl: setupUrl, installerSha }))) {
			writeFileSync(join(out, "winget", name), text);
		}
	} else {
		console.log("  Windows aucun installeur : pas de manifeste");
	}
	console.log(`→ ${out}`);
}

main().catch((error) => {
	console.error(`échec : ${error.message}`);
	process.exit(1);
});
