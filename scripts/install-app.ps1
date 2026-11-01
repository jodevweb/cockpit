# Compile Cockpit et l'installe sur ce poste Windows.
#
#   pnpm install:app
#
# Équivalent Windows de install-app.sh : produit l'installeur NSIS, ferme
# l'instance en cours, puis joue l'installeur en mode silencieux. L'installation
# est par utilisateur (`%LOCALAPPDATA%\Cockpit`) : aucun droit administrateur.
#
# Le fichier est encodé en UTF-8 avec BOM : sans lui, Windows PowerShell 5.1 le
# lit en ANSI et les accents des messages arrivent en désordre.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Etape($texte) { Write-Host "▸ $texte" }
function Echec($texte) { Write-Host "✗ $texte" -ForegroundColor Red; exit 1 }

# Le cockpit joue toutes ses commandes dans le bash de Git for Windows : sans
# lui, l'app s'installe mais ne lance rien.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
	Echec "Git for Windows est requis (https://git-scm.com/download/win)."
}

Etape 'Compilation…'
# Voir release.sh : rustc écrit le chemin de chaque source dans le binaire ; le
# remap remplace le dossier personnel par `~`.
$env:RUSTFLAGS = "$($env:RUSTFLAGS) --remap-path-prefix=$($env:USERPROFILE)=~".Trim()
pnpm tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { Echec "La compilation a échoué (code $LASTEXITCODE)." }

$dossier = 'src-tauri\target\release\bundle\nsis'
$installeur = Get-ChildItem -Path $dossier -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
	Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installeur) { Echec "Aucun installeur dans $dossier." }

# L'app tourne peut-être encore : l'installeur ne peut pas remplacer un
# exécutable ouvert.
$enCours = Get-Process -Name 'Cockpit', 'cockpit' -ErrorAction SilentlyContinue
if ($enCours) {
	Etape "Fermeture de l'instance en cours…"
	$enCours | Stop-Process -Force
	Start-Sleep -Seconds 1
}

Etape "Installation ($($installeur.Name))…"
$processus = Start-Process -FilePath $installeur.FullName -ArgumentList '/S' -Wait -PassThru
if ($processus.ExitCode -ne 0) { Echec "L'installeur a échoué (code $($processus.ExitCode))." }

Write-Host '✓ Cockpit installé — menu Démarrer puis « Cockpit »'
