#!/usr/bin/env bash
#
# Crée l'identité qui signe Cockpit sur ce poste. À lancer une fois.
#
# macOS n'accorde pas une autorisation à une application : il l'accorde à une
# signature. Compilé sans identité, le cockpit reçoit celle que le linker
# improvise — un identifiant tiré du binaire lui-même (`cockpit-46f0…`), qui
# change à chaque compilation, et un `Info.plist` que la signature ne couvre
# pas. TCC, qui garde les décisions de l'utilisateur, ne sait alors rattacher la
# sienne à rien de durable : les accès aux photos, à la musique, aux dossiers
# protégés sont redemandés version après version. Les agents que le cockpit
# lance héritent de son identité, donc de son problème — c'est lui que macOS
# interroge quand l'un d'eux touche à un dossier surveillé.
#
# Un certificat auto-signé suffit à régler ça tant que le cockpit ne quitte pas
# les postes de l'équipe. Il ne vaut rien pour Gatekeeper — c'est le rôle d'un
# Developer ID, qui reste à prendre le jour où l'app s'installe ailleurs — mais
# il donne à la signature une identité stable, et c'est tout ce que TCC demande.
#
# Le trousseau demandera le mot de passe de session : c'est lui qui autorise
# `codesign` à se servir de la clé sans redemander à chaque compilation.

set -euo pipefail

NOM="${1:-${COCKPIT_SIGNING_IDENTITY:-Cockpit Signing}}"
TROUSSEAU="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$NOM"; then
	echo "✓ L'identité « $NOM » existe déjà — rien à faire."
	exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "▸ Certificat « $NOM »…"
# `codeSigning` dans les usages étendus : sans cette extension, le certificat
# existe mais `codesign` ne le voit pas comme une identité de signature.
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
	-keyout "$TMP/cle.pem" -out "$TMP/cert.pem" \
	-subj "/CN=$NOM" \
	-addext "basicConstraints=critical,CA:false" \
	-addext "keyUsage=critical,digitalSignature" \
	-addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null

# Chiffrement hérité, et un MAC en SHA-1 : OpenSSL 3 produit par défaut un
# PKCS#12 que le trousseau macOS refuse — « MAC verification failed », sans que
# rien n'indique que le format est en cause. Le mot de passe ne protège que ce
# fichier, qui vit le temps du script dans un dossier temporaire.
LAISSEZ_PASSER="$(openssl rand -hex 16)"
openssl pkcs12 -export -out "$TMP/identite.p12" \
	-inkey "$TMP/cle.pem" -in "$TMP/cert.pem" \
	-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
	-passout "pass:$LAISSEZ_PASSER" 2>/dev/null

echo "▸ Dépôt dans le trousseau…"
# `-T /usr/bin/codesign` inscrit l'outil dans la liste de ceux qui peuvent se
# servir de la clé.
security import "$TMP/identite.p12" -k "$TROUSSEAU" -P "$LAISSEZ_PASSER" -T /usr/bin/codesign >/dev/null

# Un certificat déposé n'est pas pour autant accepté : sans confiance déclarée
# pour la signature de code, `codesign` répond que l'identité est introuvable.
echo "▸ Confiance pour la signature de code (une authentification va s'ouvrir)…"
security add-trusted-cert -r trustRoot -p codeSign -k "$TROUSSEAU" "$TMP/cert.pem"

# Reste à savoir si `codesign` peut vraiment s'en servir. L'inscription faite à
# l'import suffit le plus souvent ; quand elle ne suffit pas, le trousseau ouvre
# une fenêtre à chaque compilation. Plutôt que de le supposer dans un sens ou
# dans l'autre, on signe un fichier jetable et on regarde.
ESSAI="$TMP/essai"
cp /bin/echo "$ESSAI"
if codesign --force --sign "$NOM" --identifier com.cockpit.essai "$ESSAI" >/dev/null 2>&1; then
	echo "✓ codesign se sert de la clé sans rien demander."
else
	echo "⚠ codesign n'a pas pu se servir de la clé. La signature marchera quand"
	echo "  même, mais le trousseau demandera confirmation : répondre"
	echo "  « Toujours autoriser » la première fois suffit à ne plus l'être."
fi

echo
echo "✓ Identité « $NOM » prête. Elle sera reprise par pnpm install:app et par"
echo "  scripts/release.sh. Les autorisations accordées à Cockpit après la"
echo "  prochaine installation tiendront d'une version à l'autre."
