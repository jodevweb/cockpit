# Le dossier de livraison

*Note de conception, lot D. À valider avant d'écrire du code.*

## Le problème

Cockpit sait déjà prouver beaucoup de choses sur ce qu'un agent a livré : les
portes du dépôt ont passé, les propriétés tiennent, la recette a filmé ce
qu'elle a fait, la visite dit fichier par fichier ce qui a changé, et le relevé
des exécutions sait ce que la tâche a coûté. Mais **tout cela reste dans le
cockpit**. Le relecteur de la pull request, lui, ne voit qu'un diff et la
description qu'un agent a rédigée — c'est-à-dire ce que l'agent *dit* avoir
fait.

Le dossier de livraison sort ces preuves du poste et les pose là où l'on
décide : sur la pull request.

## Ce qui existe déjà

| Pièce | Module | Ce qu'elle rend |
|---|---|---|
| Portes du dépôt | `gates.rs` | commandes jouées, passées ou non, sortie de celle qui échoue |
| Propriétés | `properties.rs` | `Audit` : un verdict par propriété avec sa preuve ; `Calibration` : la propriété sait-elle échouer |
| Recette | `mission.rs` (`Verdict`) | `ok`, `réserves`, `bloquant`, `indécis` |
| Preuve filmée | `proof.rs` | `preuve.mp4` dans `~/.config/cockpit/preuves/…` |
| Visite | `tour.rs` | `TourChanges` (depuis git) et `Story` (le pourquoi, fichier par fichier) |
| Coût | `executions.rs` | modèles, tours, jetons, durée, reprises |
| Brief | `brief.rs` | les sections de contexte que l'agent a reçues |

Rien de neuf à mesurer : il s'agit d'**assembler et de publier**.

## La proposition

Un module `delivery.rs` compose, pour une mission ou un agent de workspace
qui ouvre une pull request, un dossier en markdown :

```
## Dossier de livraison — Cockpit

✅ Portes du dépôt : `pnpm test`, `pnpm lint` (passées sur 4f2a9c1)
✅ Propriétés : 6/6 tiennent — 5 calibrées (elles ont déjà attrapé un bug), 1 décorative ⚠
✅ Recette : ok — vidéo de 42 s (voir plus bas)
📄 Ce qui a changé : 7 fichiers, dont 2 que l'agent n'a pas nommés (générés)
💸 Coût : 2 tâches, 1 reprise, 38 min de travail, ≈ 1,9 M jetons
🧭 Contexte reçu : ticket NW-3044, 2 leçons du carnet, revue de la PR #2051
```

Il part par deux voies, toutes deux faisables avec le jeton GitHub que le
cockpit a déjà :

1. **Une section de la description de la PR** (ou un commentaire, au choix),
   régénérée quand la mission bouge.
2. **Un statut de commit** `cockpit/dossier` sur la tête de la branche :
   `success` si portes et propriétés tiennent, `failure` sinon, avec un lien
   vers le dossier. Il apparaît dans la liste des vérifications de la PR, et
   peut devenir une vérification exigée par les règles de la branche.

> Pourquoi un statut et non un *check run* : l'API des check runs n'est ouverte
> qu'aux GitHub Apps. Un jeton personnel ne peut pas en créer ; un statut de
> commit, si. Une GitHub App viendrait plus tard, si le besoin s'en fait
> sentir.

GitLab a l'équivalent (description de MR + *commit status*) : même module, autre
forge, via `monitor.rs` qui les connaît déjà.

## Les images et la vidéo

C'est le point délicat. GitHub n'a pas d'API pour joindre un fichier à une PR.
Les voies possibles :

- **Rien de binaire en v1** : le dossier dit qu'une vidéo existe, sa durée, et
  ce qu'elle montre ; la vidéo reste sur le poste. Sûr, mais le relecteur ne la
  voit pas.
- **Une branche orpheline `cockpit/preuves`** dans le dépôt : les captures et
  la vidéo y sont poussées, et le dossier y renvoie. Visible par tous ceux qui
  voient le dépôt — **donc public sur un dépôt public**. Une capture d'écran
  peut montrer un jeton, une donnée client, un écran d'administration.
- **Un stockage choisi par l'équipe** (bucket S3, etc.) : propre, mais une
  configuration de plus.

Proposition : v1 sans binaire ; la branche de preuves en option explicite, par
projet, avec un avertissement clair, et jamais activée d'office.

## Découpage

1. `delivery.rs` : composer le dossier (pur, testé sur des fixtures), et
   l'afficher dans l'écran de la mission. Rien ne part encore.
2. Publication : section de description + statut de commit, derrière un réglage
   par projet (`workflow.deliveryDossier`), désactivé par défaut.
3. Option « branche de preuves », avec son avertissement.

## Risques

- **Un dossier qui rassure à tort.** Une propriété décorative ou une recette
  indécise doivent apparaître comme telles, jamais comme un ✅ — c'est la règle
  de `properties.rs` et de `Verdict::Undecided`, à tenir ici aussi.
- **Le bruit.** Une description réécrite à chaque tour d'agent agace ; on ne la
  régénère qu'aux étapes qui changent le dossier (porte, verdict, intégration).
- **Les droits.** Poser un statut demande `repo:status` (ou `statuses: write`
  pour un jeton fin) : le dire dans les Réglages plutôt que d'échouer.

## Questions pour toi

1. Le dossier dans **la description** de la PR (un seul endroit, toujours à
   jour) ou dans **un commentaire** (historique visible, mais du bruit) ?
2. Veux-tu le statut `cockpit/dossier` **exigible** par les règles de `main`
   dès qu'il existe ?
3. Pour les vidéos : v1 sans binaire te va-t-il, la branche de preuves venant
   ensuite en option ?
