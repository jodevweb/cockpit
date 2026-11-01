#!/usr/bin/env bash
#
# Publie une version de Cockpit.
#
# Compile, signe, et dépose l'archive dans le dépôt public des binaires avec le
# `latest.json` que les applications installées viennent lire. Réservé au
# mainteneur : il faut la clé de signature du projet, que personne d'autre n'a.
#
#   ./scripts/release.sh 0.2.0 "Ce que change cette version"
#
# La clé de signature vit hors du dépôt (`~/.tauri/cockpit.key`) et son mot de
# passe dans le trousseau macOS : rien de secret n'est versionné, et une clé
# volée ne suffit pas à signer.

set -euo pipefail

VERSION="${1:-}"
NOTES="${2:-}"
DEPOT_BINAIRES="jodevweb/cockpit-releases"
COMPTE="jodevweb"
CLE="$HOME/.tauri/cockpit.key"

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE"

if [[ -z "$VERSION" ]]; then
	echo "Usage : $0 <version> [notes]" >&2
	echo "Exemple : $0 0.2.0 \"Reprise des missions, mise à jour intégrée\"" >&2
	exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "✗ Version attendue sous la forme X.Y.Z (reçu : $VERSION)" >&2
	exit 1
fi

if [[ ! -f "$CLE" ]]; then
	echo "✗ Clé de signature introuvable : $CLE" >&2
	echo "  Sans elle, l'archive produite serait refusée par les cockpits installés." >&2
	exit 1
fi

# Un dépôt sale produit une version qu'on ne saura pas reconstruire.
if [[ -n "$(git status --porcelain)" ]]; then
	echo "✗ Des changements ne sont pas commités. Une version doit correspondre à un commit." >&2
	git status --short >&2
	exit 1
fi

MDP="$(security find-generic-password -a cockpit-updater -s cockpit-updater-key -w 2>/dev/null || true)"
if [[ -z "$MDP" ]]; then
	echo "✗ Mot de passe de la clé absent du trousseau (compte « cockpit-updater »)." >&2
	exit 1
fi

echo "▸ Version $VERSION"

# La version vit à deux endroits : le manifeste Tauri, qui la donne à l'archive
# et à `latest.json`, et le package.json, pour que les deux ne divergent pas.
python3 - "$VERSION" <<'PY'
import json, pathlib, re, sys

version = sys.argv[1]

manifeste = pathlib.Path("src-tauri/tauri.conf.json")
data = json.loads(manifeste.read_text())
data["version"] = version
manifeste.write_text(json.dumps(data, indent="\t", ensure_ascii=False) + "\n")

paquet = pathlib.Path("package.json")
data = json.loads(paquet.read_text())
data["version"] = version
paquet.write_text(json.dumps(data, indent="\t", ensure_ascii=False) + "\n")

cargo = pathlib.Path("src-tauri/Cargo.toml")
texte = cargo.read_text()
cargo.write_text(re.sub(r'^version = "[^"]+"', f'version = "{version}"', texte, count=1, flags=re.M))
PY

# macOS rattache les autorisations qu'il accorde à une identité de code. Sans
# elle, chaque version publiée arrive avec la signature improvisée du linker —
# empreinte différente à chaque compilation — et le poste qui l'installe
# redemande tout : photos, musique, dossiers protégés, pour le cockpit comme
# pour les agents qu'il lance. L'identité est celle du poste qui publie ;
# `scripts/signing-identity.sh` la crée. Absente, on publie quand même : le
# dépôt doit rester compilable par qui ne l'a pas.
IDENTITE="${COCKPIT_SIGNING_IDENTITY:-Cockpit Signing}"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITE"; then
	export APPLE_SIGNING_IDENTITY="$IDENTITE"
	echo "▸ Signature de l'app : $IDENTITE"
else
	echo "⚠ Identité « $IDENTITE » absente : les cockpits mis à jour par cette"
	echo "  version redemanderont leurs autorisations système."
fi

echo "▸ Compilation…"
# rustc écrit dans le binaire le chemin de chaque fichier source, dépendances
# comprises : sans remap, un `strings` sur l'exécutable distribué révèle le nom
# d'utilisateur de la machine qui a compilé, quelques centaines de fois. Le
# remap le remplace par `~`, ce qui ne coûte rien et ne se voit nulle part.
#
# La même ligne est dans install-app.sh : deux valeurs différentes de RUSTFLAGS
# feraient tout recompiler à chaque bascule entre les deux commandes.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~"

# Les artefacts de mise à jour ne sont demandés qu'ici : les activer dans le
# manifeste obligerait à fournir la clé privée à chaque compilation, y compris
# pour un simple `pnpm install:app` — et rendrait le dépôt incompilable pour
# qui n'a pas la clé.
TAURI_SIGNING_PRIVATE_KEY="$(cat "$CLE")" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$MDP" \
	pnpm tauri build --bundles app \
	--config '{"bundle":{"createUpdaterArtifacts":true}}'

BUNDLE="src-tauri/target/release/bundle/macos"
ARCHIVE="$BUNDLE/Cockpit.app.tar.gz"
SIGNATURE="$ARCHIVE.sig"

if [[ ! -f "$ARCHIVE" || ! -f "$SIGNATURE" ]]; then
	echo "✗ Archive ou signature manquante — createUpdaterArtifacts est-il actif ?" >&2
	exit 1
fi

# L'archive est faite juste après la signature du bundle : ce que voit ce
# contrôle est bien ce que les postes installeront.
echo "▸ Signature embarquée : $(codesign -dv --verbose=2 "$BUNDLE/Cockpit.app" 2>&1 |
		sed -n 's/^Identifier=/identifiant /p; s/^Authority=/autorité /p' |
		tr '\n' '@' | sed 's/@$//; s/@/ · /g' )"

# Le nom porte la version : les releases GitHub refusent deux fichiers de même
# nom, et un utilisateur qui télécharge à la main doit savoir ce qu'il prend.
NOM="Cockpit_${VERSION}_$(uname -m).app.tar.gz"
TEMPO="$(mktemp -d)"
cp "$ARCHIVE" "$TEMPO/$NOM"

CIBLE="darwin-$(uname -m | sed 's/arm64/aarch64/')"
python3 - "$VERSION" "$TEMPO" "$NOM" "$CIBLE" "$SIGNATURE" "$DEPOT_BINAIRES" "$NOTES" <<'PY'
import json, pathlib, sys, datetime

version, tempo, nom, cible, signature, depot, notes = sys.argv[1:8]

pathlib.Path(tempo, "latest.json").write_text(
	json.dumps(
		{
			"version": version,
			"notes": notes or f"Version {version}",
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
trap 'rm -rf "$TEMPO"' EXIT

# Le dépôt des binaires appartient au compte perso, mais on ne bascule pas le
# compte actif pour autant : on emprunte son jeton le temps d'un appel.
#
# La première version basculait avec `gh auth switch`. Une publication
# interrompue laissait alors le compte perso actif, et tout ce qui se replie sur
# `gh auth token` — le cockpit lui-même — interrogeait GitHub sous une identité
# sans accès aux dépôts de travail. Le symptôme, un 404 sur les pull requests,
# ne désignait en rien sa cause. Un jeton passé par l'environnement ne touche
# rien de global, et rien ne reste à restaurer.
JETON="$(gh auth token --user "$COMPTE" 2>/dev/null || true)"
if [[ -z "$JETON" ]]; then
	echo "✗ Aucun jeton pour le compte $COMPTE. Lance : gh auth login" >&2
	exit 1
fi

GH_TOKEN="$JETON" gh release create "v$VERSION" \
	"$TEMPO/$NOM" \
	"$TEMPO/latest.json" \
	--repo "$DEPOT_BINAIRES" \
	--title "Cockpit $VERSION" \
	--notes "${NOTES:-Version $VERSION}"

git add -A
git commit -q -m "Version $VERSION"
git tag "v$VERSION"
# Le seul tag de cette version, pas `--tags` : un clone peut porter des tags
# qui n'ont rien à faire sur le dépôt public.
git push -q origin HEAD && git push -q origin "v$VERSION"

echo "✓ Cockpit $VERSION publié"
echo "  https://github.com/$DEPOT_BINAIRES/releases/tag/v$VERSION"
echo "  Les cockpits installés le proposeront à leur prochaine vérification."
