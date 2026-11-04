#!/usr/bin/env bash
#
# Compile Cockpit et l'installe pour l'utilisateur courant, sous Linux.
#
# L'AppImage plutôt que le .deb : elle s'installe sans droits administrateur,
# dans ~/.local, comme l'installeur Windows le fait dans %LOCALAPPDATA% — et
# c'est elle que l'updater intégré sait remplacer. Une entrée de menu la rend
# lançable depuis le bureau, sans terminal ouvert.

set -euo pipefail

cd "$(dirname "$0")/.."

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps"
TARGET="$BIN_DIR/Cockpit.AppImage"

echo "▸ Compilation…"
# Voir release.sh : le remap efface le chemin du poste des métadonnées du binaire.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~"
pnpm tauri build --bundles appimage

BUILT=$(ls -t src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null | head -1 || true)
[ -n "$BUILT" ] && [ -f "$BUILT" ] || { echo "✗ AppImage introuvable dans src-tauri/target/release/bundle/appimage" >&2; exit 1; }

# L'app tourne peut-être encore : on la ferme avant de remplacer son fichier.
if pgrep -f "$TARGET" >/dev/null 2>&1; then
	echo "▸ Fermeture de la version en cours…"
	pkill -f "$TARGET" || true
	sleep 1
fi

mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR"
install -m 755 "$BUILT" "$TARGET"
install -m 644 src-tauri/icons/128x128.png "$ICON_DIR/cockpit.png"

cat > "$APPS_DIR/cockpit.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Cockpit
Comment=A cockpit for coding agents
Exec=$TARGET
Icon=cockpit
Terminal=false
Categories=Development;
StartupWMClass=cockpit
DESKTOP

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

echo "✓ Installé : $TARGET"
echo "  Lançable depuis le menu des applications (« Cockpit »)."
