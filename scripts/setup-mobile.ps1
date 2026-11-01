# Met en place l'accès mobile sous Windows : serveur ntfy local, publication
# Tailscale. Transposition fidèle de setup-mobile.sh, qui détaille les raisons.
#
#   pnpm setup:mobile
#
# Deux services, deux portes distinctes sur le tailnet :
#
#   https://<machine>.<tailnet>.ts.net       → la page du cockpit (port 7420)
#   https://<machine>.<tailnet>.ts.net:8443  → le serveur ntfy (port 2586)
#
# Aucun des deux n'écoute ailleurs que sur la boucle locale : c'est Tailscale
# qui les expose, à ses seuls appareils. Le script refuse de continuer si
# Funnel est actif. ntfy tourne en conteneur (Docker Desktop).
#
# Encodé en UTF-8 avec BOM : Windows PowerShell 5.1 lit sinon le fichier en ANSI.

# Pas de `Stop` global : sous Windows PowerShell 5.1, la moindre ligne qu'un
# programme natif écrit sur sa sortie d'erreur redirigée (`docker rm` d'un
# conteneur absent) deviendrait une erreur fatale. Chaque appel natif est
# vérifié par son code de sortie, chaque écriture par `Ecrire`.
$ErrorActionPreference = 'Continue'

$NtfyPort = 2586
$NtfyHttpsPort = 8443
$CockpitPort = 7420
$ConfigDir = Join-Path $HOME '.config\cockpit'
$NtfyDir = Join-Path $ConfigDir 'ntfy'
$Container = 'cockpit-ntfy'

function Etape($texte) { Write-Host ''; Write-Host "▸ $texte" }
function Echec($texte) { Write-Host "✗ $texte" -ForegroundColor Red; exit 1 }

# Octets aléatoires du générateur cryptographique du système.
function Octets([int]$n) {
	$octets = New-Object byte[] $n
	$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
	$rng.GetBytes($octets)
	$rng.Dispose()
	return $octets
}
function Hexa([int]$n) { -join ((Octets $n) | ForEach-Object { $_.ToString('x2') }) }
function JetonUrl([int]$n) {
	[Convert]::ToBase64String((Octets $n)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
# Tirage sans biais dans un alphabet : on rejette les octets qui dépasseraient
# le dernier multiple entier de sa taille.
function Tirage([string]$alphabet, [int]$longueur) {
	$plafond = 256 - (256 % $alphabet.Length)
	$sortie = ''
	while ($sortie.Length -lt $longueur) {
		foreach ($octet in (Octets 32)) {
			if ($octet -lt $plafond -and $sortie.Length -lt $longueur) {
				$sortie += $alphabet[$octet % $alphabet.Length]
			}
		}
	}
	return $sortie
}

# Écrit un fichier en UTF-8 sans BOM (ntfy, comme le cockpit, attend du texte brut).
function Ecrire([string]$chemin, [string]$contenu) {
	try {
		[System.IO.File]::WriteAllText($chemin, $contenu.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
	} catch {
		Echec "Écriture de $chemin impossible : $($_.Exception.Message)"
	}
}

# Lecture seule pour l'utilisateur courant : l'équivalent du `chmod 600`.
function Restreindre([string]$chemin) {
	icacls $chemin /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

function NtfyDans {
	& docker exec $Container ntfy @args
}

# ── Vérifications ─────────────────────────────────────────────────────────
Etape 'Vérifications'

$Tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path $Tailscale)) {
	$commande = Get-Command tailscale -ErrorAction SilentlyContinue
	$Tailscale = if ($commande) { $commande.Source } else { $null }
}
if (-not $Tailscale) { Echec "Tailscale n'est pas installé. Lance : winget install Tailscale.Tailscale" }

& docker info *> $null
if ($LASTEXITCODE -ne 0) { Echec "Docker n'est pas démarré : ntfy tourne en conteneur." }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Echec 'Node est requis (celui de pnpm convient).' }

$HostName = $null
try {
	$etat = (& $Tailscale status --json 2>$null) -join "`n" | ConvertFrom-Json
	$HostName = $etat.Self.DNSName.TrimEnd('.')
} catch {}
if (-not $HostName) { Echec "Tailscale n'est pas connecté. Ouvre l'app, connecte-toi, puis relance." }

# Une seule commande peut publier cette machine sur Internet : on s'assure
# qu'elle n'a pas été lancée.
$funnel = (& $Tailscale funnel status 2>$null) -join "`n"
if ($funnel -match 'https://') {
	Echec 'Tailscale Funnel est actif : coupe-le avec « tailscale funnel off » avant de continuer.'
}

Write-Host "  machine : $HostName"

# ── Serveur ntfy ──────────────────────────────────────────────────────────
Etape 'Configuration de ntfy'

New-Item -ItemType Directory -Force -Path (Join-Path $NtfyDir 'data') -ErrorAction Stop | Out-Null
# Huit caractères hexadécimaux : indevinable, et tapable à la main.
$Topic = "cockpit-$(Hexa 4)"
$NtfyPassword = JetonUrl 24
# Minuscules et chiffres sans caractères ambigus, pour un clavier de téléphone.
$PhonePassword = Tirage 'abcdefghjkmnpqrstuvwxyz23456789' 12

Ecrire (Join-Path $NtfyDir 'server.yml') @"
# Généré par scripts/setup-mobile.ps1 — ne pas éditer à la main.
base-url: "https://${HostName}:$NtfyHttpsPort"
listen-http: ":80"

# Réveil du téléphone : seuls l'identifiant du message et l'empreinte SHA-256 de
# l'URL du sujet transitent par le relais. Le contenu, lui, est servi d'ici.
upstream-base-url: "https://ntfy.sh"

# Rien d'anonyme : publier comme lire demande un compte.
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"

# Les messages ne survivent pas à la journée.
cache-file: "/var/lib/ntfy/cache.db"
cache-duration: "12h"
attachment-cache-dir: ""
enable-signup: false
enable-login: true

# Le cockpit publie depuis la machine hôte : pas de limiteur de débit pour lui.
visitor-request-limit-exempt-hosts: "127.0.0.1,172.17.0.0/16"
"@

Etape 'Démarrage du conteneur'
& docker rm -f $Container *> $null
& docker run -d --name $Container --restart unless-stopped `
	-p "127.0.0.1:${NtfyPort}:80" `
	-v "$(Join-Path $NtfyDir 'server.yml'):/etc/ntfy/server.yml" `
	-v "$(Join-Path $NtfyDir 'data'):/var/lib/ntfy" `
	binwiederhier/ntfy serve | Out-Null
if ($LASTEXITCODE -ne 0) { Echec 'docker run a échoué.' }

function NtfyRepond {
	try {
		Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$NtfyPort/v1/health" | Out-Null
		return $true
	} catch { return $false }
}
for ($i = 0; $i -lt 30 -and -not (NtfyRepond); $i++) { Start-Sleep -Seconds 1 }
if (-not (NtfyRepond)) { Echec "ntfy ne répond pas sur 127.0.0.1:$NtfyPort (docker logs $Container)" }
Write-Host "  ntfy écoute sur 127.0.0.1:$NtfyPort"

Etape 'Comptes et droits'
# `ntfy user add` lit le mot de passe deux fois sur l'entrée standard. On le lui
# fournit depuis le conteneur lui-même : un tube PowerShell vers un programme
# natif ajoute des fins de ligne Windows, qui finiraient dans le mot de passe.
# `$MDP` reste sans guillemets : Windows PowerShell 5.1 transmet mal les
# guillemets doubles aux programmes natifs, et nos mots de passe n'ont ni
# espace ni caractère spécial pour le shell (base64 URL, alphabet réduit).
function AjouterCompte([string]$nom, [string]$role, [string]$motDePasse) {
	NtfyDans user del $nom *> $null
	& docker exec -e "MDP=$motDePasse" $Container sh -c "printf '%s\n%s\n' `$MDP `$MDP | ntfy user add --role=$role $nom" | Out-Null
	if ($LASTEXITCODE -ne 0) { Echec "Création du compte « $nom » impossible (docker logs $Container)." }
}
AjouterCompte 'cockpit' 'admin' $NtfyPassword
$sortieJeton = (NtfyDans token add cockpit 2>$null) -join "`n"
$Token = [regex]::Match($sortieJeton, 'tk_[A-Za-z0-9]+').Value
if (-not $Token) { Echec "ntfy n'a pas rendu de jeton (docker logs $Container)." }

# Le téléphone lit avec un compte à part, en lecture seule sur le seul sujet.
AjouterCompte 'iphone' 'user' $PhonePassword
NtfyDans access iphone $Topic read-only | Out-Null
Write-Host '  comptes « cockpit » (publication) et « iphone » (lecture) prêts'

# ── Publication sur le tailnet ────────────────────────────────────────────
Etape 'Publication sur le tailnet'

& $Tailscale serve --bg $CockpitPort | Out-Null
& $Tailscale serve --bg "--https=$NtfyHttpsPort" $NtfyPort | Out-Null
Write-Host "  https://$HostName/        → cockpit"
Write-Host "  https://${HostName}:$NtfyHttpsPort/ → ntfy"

# ── Ce qu'il reste à faire à la main ──────────────────────────────────────
New-Item -ItemType Directory -Force -Path $ConfigDir -ErrorAction Stop | Out-Null
$Reperes = Join-Path $ConfigDir 'mobile-setup.txt'
Ecrire $Reperes @"
Accès mobile — repères de configuration
Généré le $(Get-Date -Format 'dd/MM/yyyy HH:mm')

Page du cockpit   https://$HostName/
Serveur ntfy      https://${HostName}:$NtfyHttpsPort/
Sujet             $Topic

Compte de lecture (à saisir dans l'app ntfy du téléphone)
Utilisateur       iphone
Mot de passe      $PhonePassword

Compte d'administration du serveur ntfy
Utilisateur       cockpit
Mot de passe      $NtfyPassword
Jeton (cockpit)   $Token
"@
Restreindre $Reperes

Etape 'Configuration du cockpit'
# Node plutôt que ConvertTo-Json : Windows PowerShell 5.1 réécrit le JSON à sa
# façon (échappements, tableaux d'un élément), et le cockpit relit ce fichier.
# Aucun guillemet double dans le programme : PowerShell 5.1 les transmettrait mal.
$RemoteJson = Join-Path $ConfigDir 'remote.json'
& node -e @'
const fs = require('fs');
const [chemin, port, topic, token] = process.argv.slice(1);
const etat = fs.existsSync(chemin) ? JSON.parse(fs.readFileSync(chemin, 'utf8')) : {};
etat.enabled ??= false;
etat.devices ??= [];
etat.ntfyServer = `http://127.0.0.1:${port}`;
etat.ntfyTopic = topic;
etat.ntfyToken = token;
fs.writeFileSync(chemin, JSON.stringify(etat, null, 2));
'@ $RemoteJson $NtfyPort $Topic $Token
if ($LASTEXITCODE -ne 0) { Echec "Écriture de $RemoteJson impossible." }
Restreindre $RemoteJson
Write-Host '  relais enregistré dans remote.json'

Write-Host @"

✓ Tout est en place côté PC.

  Le relais est déjà renseigné dans le cockpit. Il reste à activer l'accès
  mobile dans Réglages → Accès mobile, s'il ne l'est pas encore.

  Sur l'iPhone (Tailscale connecté au même tailnet) :
    1. App ntfy → Settings → Manage users → Add user
         https://${HostName}:$NtfyHttpsPort
       utilisateur « iphone », mot de passe « $PhonePassword »
    2. + → Subscribe to topic → « $Topic »
       en activant « Use another server » avec la même adresse.
    3. Safari → https://$HostName/ → Partager → « Sur l'écran d'accueil ».
       L'installation est ce qui autorise Face ID et les notifications.
    4. Ouvrir l'app installée, saisir le code d'appairage des Réglages,
       puis activer Face ID.

  Ces repères sont aussi dans $Reperes (lisible par toi seul).
"@
