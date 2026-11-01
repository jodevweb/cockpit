#!/usr/bin/env bash
#
# Prépare une version de Cockpit ; la CI la compile et la publie.
#
#   ./scripts/release.sh 0.85.0 "Ce que change cette version"
#   ./scripts/release.sh 0.85.0 --notes-file notes.md
#   ./scripts/release.sh 0.85.0 "…" --local     # dépannage, voir plus bas
#
# Porte la version dans les manifestes, fait le commit « Version X », pose le
# tag annoté `vX` dont le message porte les notes, et pousse les deux. Le tag
# déclenche `.github/workflows/release.yml`, qui compile pour macOS et Windows,
# signe, et publie archives et `latest.json` sur le dépôt des binaires. Les
# secrets de signature vivent dans le dépôt GitHub, plus sur ce poste : voir
# docs/RELEASING.md.
#
# `--local` reprend l'ancien chemin : compiler sur ce Mac, signer avec la clé
# de `~/.tauri/cockpit.key` (mot de passe dans le trousseau) et publier
# directement. Il ne produit que la version macOS de cette machine : les postes
# Windows ne se verront rien proposer pour cette version. À réserver au jour où
# la CI est en panne.

set -euo pipefail

DEPOT_BINAIRES="jodevweb/cockpit-releases"
DEPOT_SOURCES="jodevweb/cockpit"
COMPTE="jodevweb"
CLE="$HOME/.tauri/cockpit.key"

VERSION=""
NOTES=""
FICHIER_NOTES=""
LOCAL=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--local) LOCAL=1 ;;
		--notes-file)
			FICHIER_NOTES="${2:-}"
			shift
			;;
		-h|--help)
			sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			if [[ -z "$VERSION" ]]; then VERSION="$1"
			elif [[ -z "$NOTES" ]]; then NOTES="$1"
			else echo "✗ Argument en trop : $1" >&2; exit 1
			fi
			;;
	esac
	shift
done

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE"

if [[ -z "$VERSION" ]]; then
	echo "Usage : $0 <version> [notes | --notes-file <fichier>] [--local]" >&2
	echo "Exemple : $0 0.85.0 \"Reprise des missions, mise à jour intégrée\"" >&2
	exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "✗ Version attendue sous la forme X.Y.Z (reçu : $VERSION)" >&2
	exit 1
fi

if [[ -n "$FICHIER_NOTES" ]]; then
	[[ -f "$FICHIER_NOTES" ]] || { echo "✗ Fichier de notes introuvable : $FICHIER_NOTES" >&2; exit 1; }
	[[ -z "$NOTES" ]] || { echo "✗ Notes en argument ET en fichier : choisir l'un des deux." >&2; exit 1; }
	NOTES="$(cat "$FICHIER_NOTES")"
fi
NOTES="${NOTES:-Version $VERSION}"

# Un dépôt sale produit une version qu'on ne saura pas reconstruire.
if [[ -n "$(git status --porcelain)" ]]; then
	echo "✗ Des changements ne sont pas commités. Une version doit correspondre à un commit." >&2
	git status --short >&2
	exit 1
fi

if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
	echo "✗ Le tag v$VERSION existe déjà ici." >&2
	exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
	echo "✗ Le tag v$VERSION existe déjà sur origin." >&2
	exit 1
fi

echo "▸ Version $VERSION"

# La version vit à trois endroits : le manifeste Tauri, qui la donne à l'archive
# et à `latest.json`, le package.json et le Cargo.toml, pour qu'aucun ne
# diverge — la CI refuse de publier un tag qui ne leur correspond pas. Le
# Cargo.lock suit, sans quoi la première compilation le réécrirait après coup.
python3 - "$VERSION" <<'PY'
import json, pathlib, re, sys

version = sys.argv[1]

for chemin in ("src-tauri/tauri.conf.json", "package.json"):
	manifeste = pathlib.Path(chemin)
	data = json.loads(manifeste.read_text())
	data["version"] = version
	manifeste.write_text(json.dumps(data, indent="\t", ensure_ascii=False) + "\n")

cargo = pathlib.Path("src-tauri/Cargo.toml")
texte = cargo.read_text()
cargo.write_text(re.sub(r'^version = "[^"]+"', f'version = "{version}"', texte, count=1, flags=re.M))

verrou = pathlib.Path("src-tauri/Cargo.lock")
if verrou.exists():
	texte = verrou.read_text()
	verrou.write_text(re.sub(
		r'(\[\[package\]\]\nname = "cockpit"\nversion = ")[^"]+(")',
		rf'\g<1>{version}\g<2>', texte, count=1,
	))
PY

# ── Dépannage : compiler et publier depuis ce Mac ─────────────────────────
publier_localement() {
	if [[ "$(uname -s)" != "Darwin" ]]; then
		echo "✗ --local compile la version macOS : il faut un Mac." >&2
		exit 1
	fi
	if [[ ! -f "$CLE" ]]; then
		echo "✗ Clé de signature introuvable : $CLE" >&2
		echo "  Sans elle, l'archive produite serait refusée par les cockpits installés." >&2
		exit 1
	fi
	local mdp
	mdp="$(security find-generic-password -a cockpit-updater -s cockpit-updater-key -w 2>/dev/null || true)"
	if [[ -z "$mdp" ]]; then
		echo "✗ Mot de passe de la clé absent du trousseau (compte « cockpit-updater »)." >&2
		exit 1
	fi

	echo "⚠ Publication locale : macOS $(uname -m) seulement. Les postes Windows"
	echo "  ne se verront rien proposer pour cette version."

	# macOS rattache les autorisations qu'il accorde à une identité de code.
	# Voir scripts/signing-identity.sh. Absente, on publie quand même.
	local identite="${COCKPIT_SIGNING_IDENTITY:-Cockpit Signing}"
	if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$identite"; then
		export APPLE_SIGNING_IDENTITY="$identite"
		echo "▸ Signature de l'app : $identite"
	else
		echo "⚠ Identité « $identite » absente : les cockpits mis à jour par cette"
		echo "  version redemanderont leurs autorisations système."
	fi

	echo "▸ Compilation…"
	# rustc écrit dans le binaire le chemin de chaque fichier source : le remap
	# efface le nom d'utilisateur du poste. Même ligne dans install-app.sh, pour
	# partager le cache de compilation.
	export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~"

	# Les artefacts de mise à jour ne sont demandés qu'ici et en CI : les
	# activer dans le manifeste obligerait à fournir la clé privée à chaque
	# compilation, y compris pour un simple `pnpm install:app`.
	TAURI_SIGNING_PRIVATE_KEY="$(cat "$CLE")" \
	TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$mdp" \
		pnpm tauri build --bundles app \
		--config '{"bundle":{"createUpdaterArtifacts":true}}'

	local bundle="src-tauri/target/release/bundle/macos"
	local archive="$bundle/Cockpit.app.tar.gz"
	local signature="$archive.sig"
	if [[ ! -f "$archive" || ! -f "$signature" ]]; then
		echo "✗ Archive ou signature manquante — createUpdaterArtifacts est-il actif ?" >&2
		exit 1
	fi

	echo "▸ Signature embarquée : $(codesign -dv --verbose=2 "$bundle/Cockpit.app" 2>&1 |
			sed -n 's/^Identifier=/identifiant /p; s/^Authority=/autorité /p' |
			tr '\n' '@' | sed 's/@$//; s/@/ · /g' )"

	local nom="Cockpit_${VERSION}_$(uname -m).app.tar.gz"
	TEMPO="$(mktemp -d)"
	trap 'rm -rf "$TEMPO"' EXIT
	cp "$archive" "$TEMPO/$nom"

	local cible="darwin-$(uname -m | sed 's/arm64/aarch64/')"
	python3 - "$VERSION" "$TEMPO" "$nom" "$cible" "$signature" "$DEPOT_BINAIRES" "$NOTES" <<'PY'
import json, pathlib, sys, datetime

version, tempo, nom, cible, signature, depot, notes = sys.argv[1:8]

pathlib.Path(tempo, "latest.json").write_text(
	json.dumps(
		{
			"version": version,
			"notes": notes,
			"pub_date": datetime.datetime.now(datetime.timezone.utc)
			.isoformat(timespec="seconds")
			.replace("+00:00", "Z"),
			"platforms": {
				cible: {
					"signature": pathlib.Path(signature).read_text().strip(),
					"url": f"https://github.com/{depot}/releases/download/v{version}/{nom}",
				}
			},
		},
		indent="\t",
		ensure_ascii=False,
	)
	+ "\n"
)
PY

	echo "▸ Publication sur ${DEPOT_BINAIRES}…"
	# On emprunte le jeton du compte le temps d'un appel plutôt que de basculer
	# le compte actif avec `gh auth switch` : une publication interrompue
	# laissait sinon le cockpit interroger GitHub sous la mauvaise identité.
	local jeton
	jeton="$(gh auth token --user "$COMPTE" 2>/dev/null || true)"
	if [[ -z "$jeton" ]]; then
		echo "✗ Aucun jeton pour le compte $COMPTE. Lance : gh auth login" >&2
		exit 1
	fi

	GH_TOKEN="$jeton" gh release create "v$VERSION" \
		"$TEMPO/$nom" \
		"$TEMPO/latest.json" \
		--repo "$DEPOT_BINAIRES" \
		--title "Cockpit $VERSION" \
		--notes "$NOTES"
}

if [[ "$LOCAL" == 1 ]]; then
	publier_localement
	# « [skip ci] » : le tag poussé ensuite ne doit pas relancer une
	# publication en CI pour une version déjà publiée d'ici.
	MESSAGE="Version $VERSION [skip ci]"
else
	MESSAGE="Version $VERSION"
fi

git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -q -m "$MESSAGE"
# Tag annoté : son message porte les notes, que la CI reprend telles quelles
# pour la release et le `latest.json`.
git tag -a "v$VERSION" -F - <<<"$NOTES"
# Le seul tag de cette version, pas `--tags` : un clone peut porter des tags
# qui n'ont rien à faire sur le dépôt public.
git push -q origin HEAD && git push -q origin "v$VERSION"

if [[ "$LOCAL" == 1 ]]; then
	echo "✓ Cockpit $VERSION publié depuis ce poste (macOS seulement)"
	echo "  https://github.com/$DEPOT_BINAIRES/releases/tag/v$VERSION"
else
	echo "✓ v$VERSION poussé : la CI compile et publie."
	echo "  Suivi    https://github.com/$DEPOT_SOURCES/actions/workflows/release.yml"
	echo "  Release  https://github.com/$DEPOT_BINAIRES/releases/tag/v$VERSION (en brouillon jusqu'à la fin)"
fi
echo "  Les cockpits installés la proposeront à leur prochaine vérification."
