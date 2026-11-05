# Sécurité

> **English.** Please do not open a public issue for a security vulnerability.
> Use GitHub's private reporting: the repository's **Security** tab →
> **Report a vulnerability**. Describe the scenario, the affected version and,
> if possible, a minimal reproduction. A first answer comes within a few days.
> The scope below is in French; issues and reports are welcome in English.

## Signaler une faille

Merci de **ne pas** ouvrir d'issue publique pour une faille de sécurité.
Utilise le signalement privé de GitHub : onglet **Security** du dépôt →
**Report a vulnerability**. Décris le scénario, la version concernée et, si
possible, une reproduction minimale. Une première réponse arrive sous quelques
jours.

## Ce que Cockpit protège, et ce qu'il ne protège pas

Cockpit pilote des agents de code sur le poste de son utilisateur : il lance des
processus, lit et écrit des fichiers, exécute des commandes. Il tourne avec les
droits de cet utilisateur, et les agents qu'il lance aussi.

Sont dans le périmètre :

- **Le contenu non fiable qui arrive dans l'interface** — sortie d'agents,
  fichiers d'un dépôt, tickets, pages web, diagrammes. Il ne doit jamais
  pouvoir exécuter de code dans la webview ni appeler les commandes natives.
- **L'accès mobile** (`remote.rs`) — le serveur n'écoute que sur `127.0.0.1` et
  exige une passkey ; toute route atteignable sans elle est une faille.
- **Les serveurs locaux** (débogage Chrome, MCP) — ils ne doivent répondre
  qu'au poste lui-même.
- **Les secrets** — les jetons d'API restent côté Rust, dans
  `~/.config/cockpit/config.toml` (permissions 600 sous macOS ; sous Windows,
  le dossier personnel de l'utilisateur, `%USERPROFILE%\.config\cockpit`),
  et ne descendent jamais dans la webview.
- **La mise à jour** — seule une archive signée par la clé du projet est
  installée, sous macOS comme sous Windows (l'installeur NSIS porte la même
  signature de mise à jour). Les versions sont compilées et signées par
  GitHub Actions ; la clé privée n'existe que dans les secrets du dépôt et
  chez le mainteneur.

Hors périmètre : ce qu'un agent fait avec les droits qu'on lui a donnés.
Un agent lancé sans isolation peut faire tout ce que peut faire l'utilisateur ;
c'est le rôle de l'isolation (`sandbox.rs`) et des réglages d'autorisation de
le borner.

Sous Windows, l'installeur n'est pas signé Authenticode : rien ne garantit à
Windows l'origine d'un installeur téléchargé à la main, d'où l'avertissement
SmartScreen. Télécharge-le uniquement depuis
[jodevweb/cockpit-releases](https://github.com/jodevweb/cockpit-releases/releases).
Les mises à jour intégrées, elles, vérifient la signature du projet avant
d'installer quoi que ce soit.
