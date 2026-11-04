# Notes de conception

Avant d'écrire une fonctionnalité qui engage le produit, une note : le problème,
ce que le cockpit sait déjà faire, la proposition, le découpage en pull
requests, les risques, et les questions qui relèvent d'une décision. Elle se
relit et se valide en pull request, comme le code.

## Lot D — ce que les autres outils ne savent pas faire

Les trois tiennent ensemble : le dossier montre les preuves, le rejeu mesure
une configuration, l'explorateur en change une — et se mesure par le rejeu.

| Note | En une phrase |
|---|---|
| [Le dossier de livraison](dossier-de-livraison.md) | Les preuves que le cockpit a déjà (portes, propriétés, recette, coût) posées sur la pull request, là où l'on décide. |
| [Rejouer l'historique](rejeu-de-l-historique.md) | Les PR fusionnées du dépôt comme banc d'essai : une configuration d'agent jugée sur des problèmes réels, par les tests que l'humain avait écrits. |
| [L'explorateur de méthodes](explorateur-de-skills.md) | Skills et plugins Claude Code : lire ce qu'ils exécutent avant d'installer, installer pour le projet, et mesurer ce que ça change. |
