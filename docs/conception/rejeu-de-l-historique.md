# Rejouer l'historique pour juger une configuration

*Note de conception, lot D. À valider avant d'écrire du code.*

## Le problème

On change sans cesse ce que reçoivent les agents : un modèle, une consigne de
rôle, un `CLAUDE.md`, une leçon du carnet, un skill. Et l'on ne sait jamais si
c'était mieux. On juge sur la tâche suivante, qui ne ressemble pas à la
précédente, et sur une impression.

Le dépôt contient pourtant un banc d'essai gratuit : **chaque pull request
fusionnée est un problème résolu, avec sa solution validée par un humain.**
`properties.rs` s'en sert déjà pour calibrer les propriétés sur les anciens
correctifs. Le rejeu fait la même chose pour les agents.

## Le principe

Pour un ensemble de PR fusionnées choisies :

1. Partir du commit **avant** la PR (le parent de la fusion), dans un worktree
   jetable.
2. Donner à un agent ce qu'avait l'humain : le ticket, ou à défaut la
   description de la PR — **jamais son diff**.
3. Le laisser travailler avec la configuration à juger (modèle, consigne,
   leçons, skills…), dans une enveloppe de coût et de temps.
4. Juger le résultat, du plus objectif au plus fragile :
   - **Les tests de la PR humaine** : on applique au résultat de l'agent les
     fichiers de test que la PR a ajoutés ou modifiés, puis on joue les portes
     du dépôt. C'est le juge le plus fort — des tests écrits pour ce problème,
     que l'agent n'a jamais vus (la méthode de SWE-bench, sur *ton* dépôt).
   - **Les portes et les propriétés** du dépôt sur le résultat.
   - **La proximité avec la solution humaine** : fichiers touchés en commun,
     taille du diff. Indicatif seulement — deux bonnes solutions peuvent ne
     rien partager.
   - **Le coût** : jetons, durée, tours (`executions.rs`).
5. Comparer deux configurations sur le même ensemble : « B résout 7/10 contre
   5/10 pour A, pour 30 % de jetons en plus ».

## Ce qui existe déjà

- Les worktrees jetables, les agents libres (`libre.rs`) et leur lancement.
- Les portes (`gates.rs`) et les propriétés (`properties.rs`), qui jugent un
  worktree.
- Le relevé des exécutions (`executions.rs`) : coût, modèles, tours, durée.
- La lecture des tickets (`tickets.rs`) et des PR (`integrations.rs`).
- `properties::looks_like_fix` : de quoi proposer d'office les PR qui
  corrigent un bug.

## La proposition

Un écran « Bancs d'essai » et un module `replay.rs` :

- **Un banc** = une liste de PR fusionnées (proposées : les correctifs récents
  dont la PR ajoute des tests) + les portes à jouer.
- **Une campagne** = un banc × une ou plusieurs configurations. Chaque essai
  tourne dans son worktree, en parallèle borné (le plafond d'exécutants), et
  son résultat s'écrit en ajout, comme les exécutions.
- **Le rapport** = un tableau par configuration : résolus (tests humains
  passés), portes, coût médian, et les essais un par un, avec le diff de
  l'agent à côté de celui de l'humain.

Le rejeu n'écrit jamais dans le dépôt : worktrees détachés, aucune branche
poussée, nettoyés à la fin.

## Le coût, d'abord

C'est le vrai sujet. Un essai, c'est une tâche d'agent complète : dix PR × deux
configurations, c'est vingt tâches, prises sur l'abonnement de la personne. Il
faut donc :

- afficher **avant de lancer** une estimation (médiane des tâches comparables,
  comme `mission::estimate`) et la faire accepter ;
- un **plafond par campagne** (jetons ou durée), qui arrête proprement ;
- des **bancs petits** par défaut (5 PR), avec un modèle rapide possible pour
  dégrossir.

## Découpage

1. `replay.rs` : choisir les PR, préparer le worktree au parent, extraire les
   tests de la PR humaine, juger un résultat donné (sans agent : testable sur
   de vrais dépôts).
2. Lancer un essai avec un agent libre, et l'enregistrer.
3. Les campagnes et leur rapport à l'écran, l'estimation et le plafond.
4. Brancher le carnet et l'explorateur de skills : « cette leçon, ce skill,
   ont-ils changé quelque chose ? »

## Risques

- **Les tests humains ne s'appliquent pas** au code de l'agent (il a nommé
  autrement une fonction) : l'essai est alors « non jugeable », et dit pourquoi
  — jamais compté comme un échec, ni comme une réussite.
- **La fuite de la solution** : la description d'une PR raconte souvent sa
  solution. Préférer le ticket ; sinon, le titre seul en option.
- **L'environnement** : un ancien commit peut ne plus s'installer (dépendances
  disparues). Le dire et écarter l'essai.
- **Le hasard** : un essai unique ne prouve rien ; le rapport montre les
  écarts, et propose de rejouer deux fois les cas qui divergent.

## Questions pour toi

1. Commencer par les seules PR **qui ajoutent des tests** (jugement objectif,
   mais moins de matière), ou accepter aussi les autres avec portes et
   propriétés seules ?
2. Quel plafond par défaut d'une campagne te paraît raisonnable : en jetons,
   en nombre d'essais, ou en durée ?
3. L'écran « Bancs d'essai » dans l'atelier, ou rattaché à l'écran Agents ?
