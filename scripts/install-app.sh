#!/usr/bin/env bash
#
# Compile Cockpit et l'installe dans /Applications.
#
# On demande explicitement `--bundles app` : la cible `dmg` lance un AppleScript
# qui pilote le Finder pour poser les icônes, ce qui reste bloqué indéfiniment
# quand l'automatisation n'est pas autorisée. Le .app suffit pour un usage local.
#
# La signature décide de ce que macOS retient des autorisations accordées : il
# les rattache à une identité de code, pas à un chemin ni à un nom. Une
# signature ad-hoc n'en fournit aucune qui tienne — son empreinte change à
# chaque compilation — et le cockpit redemandait donc l'accès aux photos, à la
# musique ou aux dossiers protégés à chaque version, pour lui comme pour les
# agents qu'il lance. On signe avec l'identité du poste quand elle existe ;
# `scripts/signing-identity.sh` la crée une fois pour toutes.

set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Cockpit.app"
BUILT="src-tauri/target/release/bundle/macos/$APP_NAME"
TARGET="/Applications/$APP_NAME"

IDENTITE="${COCKPIT_SIGNING_IDENTITY:-Cockpit Signing}"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITE"; then
	export APPLE_SIGNING_IDENTITY="$IDENTITE"
	echo "▸ Signature : $IDENTITE"
else
	echo "⚠ Identité « $IDENTITE » absente : signature ad-hoc."
	echo "  macOS redemandera ses autorisations à chaque version installée."
	echo "  ./scripts/signing-identity.sh la crée une fois pour toutes."
fi

echo "▸ Compilation…"
# Voir release.sh : le remap efface le chemin du poste des métadonnées du
# binaire. Il est répété ici pour que les deux commandes partagent le même
# cache de compilation, et non pour ce que cette build-là expose.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~"
pnpm tauri build --bundles app

[ -d "$BUILT" ] || { echo "✗ $BUILT introuvable" >&2; exit 1; }

# Sans identité, Tauri ne signe rien et le bundle garde celle du linker : un
# identifiant tiré du binaire et un `Info.plist` hors de la signature. Le repli
# ad-hoc ne rend pas l'empreinte stable, mais il rétablit au moins l'identifiant
# du bundle — ce que macOS lit pour savoir de quelle application il parle.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
	echo "▸ Signature ad-hoc…"
	codesign --force --deep --sign - --identifier com.cockpit.app "$BUILT"
fi

# Ce que macOS voit vraiment, plutôt que ce qu'on croit avoir signé.
echo "▸ Signature posée : $(codesign -dv --verbose=2 "$BUILT" 2>&1 |
		sed -n 's/^Identifier=/identifiant /p; s/^Authority=/autorité /p' |
		tr '\n' '@' | sed 's/@$//; s/@/ · /g' )"

# L'app tourne peut-être encore : on la ferme avant d'écraser son bundle, sinon
# le remplacement laisse un processus rattaché à des fichiers qui n'existent plus.
if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
	echo "▸ Fermeture de l'instance en cours…"
	osascript -e 'quit app "Cockpit"' 2>/dev/null || pkill -f "$TARGET/Contents/MacOS/" || true
	sleep 1
fi

echo "▸ Installation dans /Applications…"
rm -rf "$TARGET"
cp -R "$BUILT" /Applications/
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

echo "✓ $TARGET installé — ⌘Espace puis « Cockpit »"
