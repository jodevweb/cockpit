# Sécurité

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
  `~/.config/cockpit/config.toml` (permissions 600), et ne descendent jamais
  dans la webview.
- **La mise à jour** — seule une archive signée par la clé du projet est
  installée.

Hors périmètre : ce qu'un agent fait avec les droits qu'on lui a donnés.
Un agent lancé sans isolation peut faire tout ce que peut faire l'utilisateur ;
c'est le rôle de l'isolation (`sandbox.rs`) et des réglages d'autorisation de
le borner.
