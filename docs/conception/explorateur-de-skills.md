# L'explorateur de méthodes : skills et plugins

*Note de conception, lot D. À valider avant d'écrire du code.*

## Le problème

Des équipes publient leurs méthodes de travail pour agents — skills, commandes,
sous-agents, hooks — sous forme de plugins Claude Code et de *marketplaces*.
Les intégrer à un projet demande aujourd'hui de savoir qu'elles existent, de
taper les bonnes commandes, et surtout de **leur faire confiance sans les
avoir lues** : un plugin peut embarquer des scripts, des hooks qui tournent à
chaque outil, des serveurs MCP.

## Ce que fait déjà Claude Code

Vérifié sur le CLI 2.1.318 du poste :

- `claude plugin marketplace add <source> --scope project` déclare une
  marketplace (dépôt GitHub, URL, chemin) **pour le projet** : c'est écrit dans
  le `.claude/settings.json` du dépôt, donc partagé avec l'équipe qui le commite.
- `claude plugin install <plugin>@<marketplace> --scope project` installe un
  plugin pour le projet ; `--json` rend un résultat lisible par une machine.
- `claude plugin details <nom>` donne **l'inventaire** d'un plugin (skills,
  commandes, agents, hooks, MCP) **et son coût projeté en jetons**.
- `claude plugin eval` joue la suite d'évaluation d'un plugin **contre une
  référence sans plugin**.
- `install` montre et fait accepter, par empreinte SHA-256, toute commande que
  la marketplace déclare (`--accept-command <sha256>`).

**Le cockpit n'a donc pas à être un gestionnaire de paquets.** Il doit être
l'endroit où l'on choisit, où l'on voit ce qu'on installe, et où l'on mesure ce
que ça change.

## La proposition

Un écran « Méthodes », par projet :

1. **Explorer.** Des sources : les marketplaces déjà déclarées par le dépôt,
   celles que l'équipe ajoute, et une petite liste de départ éditable — sans
   rien présenter comme « officiel » ou « recommandé » de notre part.
2. **Lire avant d'installer.** Pour chaque plugin : ce qu'il contient
   (`plugin details`), son coût en contexte, et **ce qu'il exécute** — hooks,
   scripts, serveurs MCP — mis en avant, avec le contenu lisible. Même règle
   que `mcp.rs` pour les `.mcp.json` : l'approbation porte sur une empreinte du
   contenu ; une mise à jour qui change ce qui s'exécute redemande l'accord.
3. **Installer en un geste**, pour le projet (`--scope project`), puis
   proposer le commit de `.claude/settings.json` : ce qui est installé
   profite aussi aux agents lancés hors du cockpit.
4. **Mesurer.** C'est ce qu'aucune marketplace ne sait faire, et que le cockpit
   peut :
   - avant/après sur le projet : reprises humaines relevées par le carnet
     (`notebook.rs`), coût et reprises des tâches (`executions.rs`) ;
   - `claude plugin eval` quand le plugin a ses évaluations ;
   - le rejeu de l'historique (voir `rejeu-de-l-historique.md`) : la même série
     de PR avec et sans le plugin.

Les skills nus (un dossier `SKILL.md` hors de tout plugin) s'installent par
copie dans `.claude/skills/`, avec la même lecture préalable et la même
empreinte.

## Découpage

1. Lire : lister les plugins installés et ceux des marketplaces déclarées, avec
   `plugin details` et la mise en avant de ce qui s'exécute. Rien ne s'installe.
2. Installer et désinstaller pour le projet, via le CLI, avec l'approbation par
   empreinte et le commit proposé.
3. Mesurer : l'avant/après tiré du carnet et des exécutions, puis le lien avec
   `plugin eval` et le rejeu.

## Risques

- **La chaîne d'approvisionnement.** Un plugin populaire peut être compromis
  par une mise à jour. Épingler à un commit, montrer le diff de ce qui
  s'exécute à chaque mise à jour, ne jamais mettre à jour en silence.
- **Le contexte qui gonfle.** Dix skills, c'est des milliers de jetons à chaque
  tour : le coût projeté s'affiche avant d'installer, et la somme par projet en
  permanence.
- **Les formats bougent.** Le cockpit passe par le CLI plutôt que d'écrire les
  fichiers lui-même ; le test de contrat nocturne (`cli-contract.mjs`) couvrira
  `plugin details`, `install --scope` et `--json`.

## Questions pour toi

1. Une liste de départ de marketplaces : en veux-tu une, ou seulement celles
   que le dépôt et l'équipe déclarent ? (Je ne mettrais aucune source sans ton
   accord explicite, et ne connais pas assez les dépôts tiers pour en
   recommander.)
2. Installer pour **le projet** (commité, partagé) par défaut, ou pour **le
   poste** (`--scope local`, personnel) ?
3. Commencer par la lecture et l'installation (1-2), ou par la mesure (3), qui
   est le vrai différenciateur ?
