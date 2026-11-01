#!/usr/bin/env bash
#
# Met en place l'accès mobile : serveur ntfy local, publication Tailscale.
#
# Deux services, deux portes distinctes sur le tailnet :
#
#   https://<machine>.<tailnet>.ts.net       → la page du cockpit (port 7420)
#   https://<machine>.<tailnet>.ts.net:8443  → le serveur ntfy (port 2586)
#
# Aucun des deux n'écoute ailleurs que sur la boucle locale : c'est Tailscale
# qui les expose, à ses seuls appareils, avec son certificat. Rien ne part sur
# Internet — le script refuse d'ailleurs de continuer si Funnel est actif.
#
# Le serveur ntfy tourne en conteneur : la formule Homebrew du même nom
# n'embarque que le client, sans la commande `serve`.
#
# Le relais Apple est le seul tiers de la chaîne, et il ne voit passer que
# l'identifiant d'un message et l'empreinte du sujet : le téléphone vient
# chercher le contenu ici, à travers le tailnet.

set -euo pipefail

TAILSCALE="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
[ -x "$TAILSCALE" ] || TAILSCALE="$(command -v tailscale || true)"
NTFY_PORT=2586
NTFY_HTTPS_PORT=8443
COCKPIT_PORT=7420
CONFIG_DIR="$HOME/.config/cockpit"
NTFY_DIR="$CONFIG_DIR/ntfy"
CONTAINER="cockpit-ntfy"

step() { printf '\n▸ %s\n' "$1"; }
fail() { printf '✗ %s\n' "$1" >&2; exit 1; }
ntfy_in() { docker exec "$CONTAINER" ntfy "$@" </dev/null; }

# ── Vérifications ─────────────────────────────────────────────────────────
step "Vérifications"

[ -n "$TAILSCALE" ] && [ -x "$TAILSCALE" ] || fail \
	"Tailscale n'est pas installé. Lance : brew install --cask tailscale-app"
docker info >/dev/null 2>&1 || fail "Docker n'est pas démarré : ntfy tourne en conteneur."

HOST="$("$TAILSCALE" status --json 2>/dev/null | python3 -c \
	'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
[ -n "$HOST" ] || fail "Tailscale n'est pas connecté. Ouvre l'app, connecte-toi, puis relance."

# Une seule commande peut publier cette machine sur Internet : on s'assure
# qu'elle n'a pas été lancée. Le cockpit fait la même vérification au démarrage,
# mais autant le dire ici, avant d'avoir tout configuré.
if "$TAILSCALE" funnel status 2>/dev/null | grep -qi "https://"; then
	fail "Tailscale Funnel est actif : coupe-le avec « tailscale funnel off » avant de continuer."
fi

echo "  machine : $HOST"

# ── Serveur ntfy ──────────────────────────────────────────────────────────
step "Configuration de ntfy"

mkdir -p "$NTFY_DIR/data"
# Le sujet se tape à la main dans l'app du téléphone : vingt-quatre caractères
# hexadécimaux garantissaient la faute de frappe. Huit suffisent à le rendre
# indevinable, d'autant que le serveur n'est joignable que depuis le tailnet.
TOPIC="$(python3 -c 'import secrets; print("cockpit-" + secrets.token_hex(4))')"
NTFY_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
# Mot de passe du compte de lecture : minuscules et chiffres sans caractères
# ambigus, pour se taper d'une main sur un téléphone.
PHONE_PASSWORD="$(python3 -c "
import secrets
alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
print(''.join(secrets.choice(alphabet) for _ in range(12)))")"

# `base-url` doit être l'adresse publique du serveur : c'est elle qui est
# hachée pour le relais, et l'app iOS s'abonne à cette empreinte-là.
cat > "$NTFY_DIR/server.yml" <<EOF
# Généré par scripts/setup-mobile.sh — ne pas éditer à la main.
base-url: "https://$HOST:$NTFY_HTTPS_PORT"
listen-http: ":80"

# Réveil du téléphone : seuls l'identifiant du message et l'empreinte SHA-256 de
# l'URL du sujet transitent par le relais. Le contenu, lui, est servi d'ici.
upstream-base-url: "https://ntfy.sh"

# Rien d'anonyme : publier comme lire demande un compte.
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"

# Les messages ne survivent pas à la journée : ce sont des demandes qui
# expirent, pas un historique.
cache-file: "/var/lib/ntfy/cache.db"
cache-duration: "12h"
attachment-cache-dir: ""
enable-signup: false
enable-login: true

# Le cockpit publie depuis la machine hôte : le limiteur de débit, pensé pour
# des visiteurs venus d'Internet, n'a rien à y faire. Sans cette exemption, une
# rafale d'échecs — un jeton devenu invalide — pénalise ensuite les requêtes
# légitimes pendant des heures.
visitor-request-limit-exempt-hosts: "127.0.0.1,172.17.0.0/16"
EOF

step "Démarrage du conteneur"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --restart unless-stopped \
	-p "127.0.0.1:$NTFY_PORT:80" \
	-v "$NTFY_DIR/server.yml:/etc/ntfy/server.yml" \
	-v "$NTFY_DIR/data:/var/lib/ntfy" \
	binwiederhier/ntfy serve >/dev/null

for _ in $(seq 30); do
	curl -fsS -o /dev/null "http://127.0.0.1:$NTFY_PORT/v1/health" && break
	sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$NTFY_PORT/v1/health" \
	|| fail "ntfy ne répond pas sur 127.0.0.1:$NTFY_PORT (docker logs $CONTAINER)"
echo "  ntfy écoute sur 127.0.0.1:$NTFY_PORT"

step "Comptes et droits"
# `ntfy user add` demande le mot de passe deux fois sur l'entrée standard : la
# variable d'environnement n'est pas lue, et sans stdin le script resterait
# suspendu à un prompt invisible. On repart d'un compte neuf pour maîtriser le
# mot de passe — le jeton précédent tombe avec lui, ce qui est voulu.
ntfy_in user del cockpit >/dev/null 2>&1 || true
printf '%s\n%s\n' "$NTFY_PASSWORD" "$NTFY_PASSWORD" \
	| docker exec -i "$CONTAINER" ntfy user add --role=admin cockpit >/dev/null
# Sans `--expires`, ntfy crée un jeton qui ne périme pas : c'est ce qu'on veut
# pour un service qui tourne en fond, et l'option refuse la valeur « never ».
TOKEN="$(ntfy_in token add cockpit 2>/dev/null | grep -oE 'tk_[A-Za-z0-9]+' | head -1)"
[ -n "$TOKEN" ] || fail "ntfy n'a pas rendu de jeton (docker logs $CONTAINER)."

# Un second compte, en lecture seule sur le seul sujet du cockpit : c'est celui
# que l'app du téléphone utilise. Elle réclame des identifiants dès qu'un
# serveur lui en a refusé une fois, et lui donner le compte de publication
# reviendrait à laisser un téléphone perdu faire sonner les autres.
ntfy_in user del iphone >/dev/null 2>&1 || true
printf '%s\n%s\n' "$PHONE_PASSWORD" "$PHONE_PASSWORD" \
	| docker exec -i "$CONTAINER" ntfy user add --role=user iphone >/dev/null
ntfy_in access iphone "$TOPIC" read-only >/dev/null
echo "  comptes « cockpit » (publication) et « iphone » (lecture) prêts"

# ── Publication sur le tailnet ────────────────────────────────────────────
step "Publication sur le tailnet"

"$TAILSCALE" serve --bg "$COCKPIT_PORT" >/dev/null
"$TAILSCALE" serve --bg --https="$NTFY_HTTPS_PORT" "$NTFY_PORT" >/dev/null
echo "  https://$HOST/        → cockpit"
echo "  https://$HOST:$NTFY_HTTPS_PORT/ → ntfy"

# ── Ce qu'il reste à faire à la main ──────────────────────────────────────
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/mobile-setup.txt" <<EOF
Accès mobile — repères de configuration
Généré le $(date "+%d/%m/%Y %H:%M")

Page du cockpit   https://$HOST/
Serveur ntfy      https://$HOST:$NTFY_HTTPS_PORT/
Sujet             $TOPIC

Compte de lecture (à saisir dans l'app ntfy du téléphone)
Utilisateur       iphone
Mot de passe      $PHONE_PASSWORD

Compte d'administration du serveur ntfy
Utilisateur       cockpit
Mot de passe      $NTFY_PASSWORD
Jeton (cockpit)   $TOKEN
EOF
chmod 600 "$CONFIG_DIR/mobile-setup.txt"

step "Configuration du cockpit"
python3 - "$NTFY_PORT" "$TOPIC" "$TOKEN" <<'PYEOF'
import json, pathlib, sys, os

port, topic, token = sys.argv[1], sys.argv[2], sys.argv[3]
path = pathlib.Path.home() / ".config" / "cockpit" / "remote.json"
path.parent.mkdir(parents=True, exist_ok=True)
state = json.loads(path.read_text()) if path.exists() else {}
state.setdefault("enabled", False)
state.setdefault("devices", [])
state["ntfyServer"] = f"http://127.0.0.1:{port}"
state["ntfyTopic"] = topic
state["ntfyToken"] = token
path.write_text(json.dumps(state, indent=2))
os.chmod(path, 0o600)
print("  relais enregistré dans remote.json")
PYEOF

cat <<EOF

✓ Tout est en place côté Mac.

  Le relais est déjà renseigné dans le cockpit. Il reste à activer l'accès
  mobile dans Réglages → Accès mobile, s'il ne l'est pas encore.

  Sur l'iPhone (Tailscale connecté au même tailnet) :
    1. App ntfy → Settings → Manage users → Add user
         https://$HOST:$NTFY_HTTPS_PORT
       utilisateur « iphone », mot de passe « $PHONE_PASSWORD »
    2. + → Subscribe to topic → « $TOPIC »
       en activant « Use another server » avec la même adresse.
    3. Safari → https://$HOST/ → Partager → « Sur l'écran d'accueil ».
       L'installation est ce qui autorise Face ID et les notifications.
    4. Ouvrir l'app installée, saisir le code d'appairage des Réglages,
       puis activer Face ID.

  Ces repères sont aussi dans $CONFIG_DIR/mobile-setup.txt (lisible par toi seul).
EOF
