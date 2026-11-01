# Publier une version

Réservé au mainteneur. Une version est compilée, signée et publiée par GitHub
Actions (`.github/workflows/release.yml`), pour macOS (Apple Silicon, et Intel
si la compilation croisée passe) et Windows x64. Le poste du mainteneur ne fait
que poser le tag.

## Une fois : les secrets du dépôt

Dans **Settings → Secrets and variables → Actions** du dépôt `jodevweb/cockpit` :

| Secret | Contenu | Obligatoire |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Le contenu de `~/.tauri/cockpit.key` (`cat ~/.tauri/cockpit.key \| pbcopy`) | oui |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Son mot de passe : `security find-generic-password -a cockpit-updater -s cockpit-updater-key -w` | oui |
| `RELEASES_TOKEN` | Jeton GitHub qui peut écrire sur `jodevweb/cockpit-releases` (voir plus bas) | oui |
| `APPLE_CERTIFICATE` | L'identité « Cockpit Signing » exportée en `.p12`, encodée en base64 | non |
| `APPLE_CERTIFICATE_PASSWORD` | Le mot de passe choisi à l'export du `.p12` | avec le précédent |
| `APPLE_SIGNING_IDENTITY` | `Cockpit Signing` (valeur par défaut si absent) | non |

La clé de mise à jour est celle dont la clé publique est inscrite dans
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) : une autre clé
produirait des archives que les cockpits installés refusent.

**`RELEASES_TOKEN`.** Le jeton par défaut des Actions ne peut écrire que dans
le dépôt qui l'exécute ; les binaires vivent dans un autre. Créer un jeton
*fine-grained* (Settings du compte → Developer settings → Personal access
tokens → Fine-grained) limité au seul dépôt `jodevweb/cockpit-releases`, avec
la permission **Contents : Read and write**, et une échéance qu'on note
quelque part : à son expiration, la publication échoue à l'étape « Release en
brouillon ».

**L'identité de signature macOS** (facultative). macOS rattache les
autorisations qu'il accorde (photos, dossiers protégés…) à l'identité qui signe
l'app ; sans elle, chaque version installée les redemande. C'est l'identité
auto-signée créée par `scripts/signing-identity.sh`. Pour l'exporter :

1. Trousseau d'accès → trousseau **session** → **Mes certificats** → clic droit
   sur « Cockpit Signing » → **Exporter…** → format `.p12`, avec un mot de passe.
   (En ligne de commande, `security export -k login.keychain-db -t identities
   -f pkcs12 -P "<mot de passe>" -o cockpit-signing.p12` exporte **toutes** les
   identités du trousseau, pas seulement celle-ci : à éviter si le trousseau en
   contient d'autres.)
2. `base64 -i cockpit-signing.p12 | pbcopy` → coller dans `APPLE_CERTIFICATE`.
3. Effacer le `.p12` (`rm -P cockpit-signing.p12`).

Sans ce secret, la publication passe quand même, avec un avertissement dans le
journal de la CI : l'app macOS n'est alors pas signée. Windows n'est pas signé
(pas de certificat Authenticode) : SmartScreen avertit à la première
installation, voir le README.

## À chaque version

```bash
pnpm release 0.85.0 "Ce que change cette version"
# ou, notes plus longues :
pnpm release 0.85.0 --notes-file notes.md
```

Le script vérifie que l'arbre est propre et que le tag n'existe pas, porte la
version dans `tauri.conf.json`, `package.json`, `Cargo.toml` (et `Cargo.lock`),
fait le commit « Version 0.85.0 », pose le tag annoté `v0.85.0` dont le
message est les notes, et pousse le commit puis le tag.

Le tag déclenche la CI :

1. **préparer** — vérifie que le tag et les trois manifestes s'accordent, lit
   les notes dans le message du tag, ouvre une release **en brouillon** sur
   `jodevweb/cockpit-releases` ;
2. **compiler** — une machine par plateforme dépose son archive signée dans le
   brouillon (`Cockpit_<version>_aarch64.app.tar.gz`,
   `Cockpit_<version>_x64-setup.exe`, et leurs `.sig`) ;
3. **publier** — assemble un `latest.json` qui couvre toutes les plateformes
   compilées et sort la release du brouillon.

Tant que la release est un brouillon, les cockpits installés continuent de lire
le `latest.json` de la version précédente : une publication qui échoue en route
n'est jamais proposée. Pour reprendre après un échec : relancer le workflow
(**Re-run failed jobs**), ou **Run workflow** avec le tag ; le brouillon
existant est repris. Une release déjà publiée n'est jamais réécrite.

La plateforme Intel (`darwin-x86_64`) est facultative : si sa compilation
échoue, la version sort sans elle, et les Mac Intel ne se voient rien proposer.

## Dépannage : publier depuis le Mac

```bash
pnpm release 0.85.0 "…" --local
```

L'ancien chemin : compile sur ce Mac, signe avec `~/.tauri/cockpit.key` et
l'identité du trousseau, publie l'archive et un `latest.json` — **macOS de cette
machine seulement** : les postes Windows ne se verront rien proposer pour cette
version. Le commit porte `[skip ci]` pour que le tag ne relance pas une
publication en CI. À réserver au jour où la CI est indisponible.
