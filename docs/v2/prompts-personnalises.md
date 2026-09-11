# v2 — Gérer plusieurs prompts personnalisés, et les gérer au même endroit

*(idée notée le 2026-08-06, en écrivant la refonte du mode Direct. ⚠️ La fiche de la phase 4 a été
supprimée à sa clôture, le 2026-08-07 — ce fichier-ci est désormais la seule trace de l'idée.)*

## Le constat

L'application propose « Personnalisé » à **deux** endroits, et il y en aura d'autres :

| usage                  | où                                   | ce qu'il pilote                              |
| ---------------------- | ------------------------------------ | -------------------------------------------- |
| `dictation_rephrasing` | Dictée — le 7ᵉ style de reformulation | la consigne de forme d'une dictée reformulée |
| `live_report`          | Direct — le 9ᵉ type de compte rendu   | les rubriques d'un compte rendu               |

**Chacun ne garde qu'UN SEUL prompt.** `user_prompts` a `usage` pour **clé primaire** : une ligne par
usage, écrasée à chaque enregistrement. Écrire une nouvelle consigne **efface la précédente**, sans
prévenir et sans retour possible.

C'est tenable tant qu'on a une consigne. Ça cesse de l'être dès qu'on en a trois — « le format que
j'utilise pour mes comptes rendus client », « celui pour mes notes de veille », « celui pour les
cours » — et c'est exactement ce que l'élargissement des types de compte rendu (Décision 6 de la
refonte) va provoquer : plus on ouvre l'application à des contenus variés, plus l'utilisateur a de
raisons d'avoir **plusieurs** formats à lui.

## Ce qu'il faudrait

- **Des modèles nommés**, enregistrés, réutilisables, listés — pas un champ de texte anonyme.
- **Un endroit unique pour les gérer** (créer, renommer, dupliquer, supprimer), probablement une
  famille ou un sous-écran des Options, sur le motif du **dictionnaire personnel** — qui est déjà
  global et sert la dictée *et* les fichiers.
- **Chaque point d'usage y pioche**, au lieu d'avoir son propre champ isolé.

## Pourquoi pas maintenant

Ce n'est pas un correctif, c'est une fonctionnalité : elle demande un schéma, un écran de gestion,
une sélection dans chaque point d'usage, et sa part de traductions. La glisser dans la phase 4
diluerait la refonte du Direct sans que personne ne l'ait demandée.

## Ce qui la rendra bon marché — et les pièges à ne pas redécouvrir

- ⚠️ **Le schéma change forcément.** `usage TEXT PRIMARY KEY` interdit plusieurs lignes par usage. Il
  faudra une **nouvelle migration** (clé propre + `usage` indexé + `name`), **jamais une modification
  de `002`**.
- ⚠️⚠️ **LE GABARIT ANTI-INJECTION N'EST PAS NÉGOCIABLE, ET IL VAUT POUR CHAQUE MODÈLE.** Le prompt de
  l'utilisateur **s'insère** dans un cadre fixe qui fixe la tâche et ne la redéfinit pas
  (`rephrasingFrame` pour la dictée, le gabarit de rapport pour le compte rendu). Multiplier les
  modèles multiplie les entrées, pas les exceptions. ⚠️ Et **aucun garde-fou déterministe ne protège
  d'une injection** — mesuré, trois critères réfutés ; voir `CLAUDE.md`. Ce qui rend la situation
  supportable est le rayon d'impact, pas la rareté.
- ⚠️ **Un prompt est du contenu utilisateur.** Il vit dans la **base chiffrée**, jamais dans
  `tauri-plugin-store` (JSON en clair), et **jamais dans un message de log**.
- ⚠️ **Pas de SQL générique par IPC.** Chaque usage garde sa paire de commandes avec son nom **en dur
  côté Rust** — c'est déjà la règle inscrite dans `002_user_prompts.sql`, et plusieurs modèles ne la
  lèvent pas : elle devient « une commande par usage, qui prend un identifiant de modèle validé ».
- **Deux limites mesurées que tout modèle héritera**, et qu'il ne faut pas essayer de corriger par le
  prompt :
  - **le modèle ne sait pas COMPTER** — « trois puces » en rend trois, puis quatre, puis une vide ;
  - **une consigne « en une seule phrase » fait PERDRE LES ACCENTS**, systématiquement. Le
    déclencheur est la forme de la consigne, pas la ponctuation ; le garde-fou déterministe évident
    est dangereux et ne doit pas être écrit.

  Si un écran de gestion existe un jour, c'est **là** que ces deux limites doivent être dites à
  l'utilisateur — au moment où il écrit sa consigne, pas dans une documentation qu'il ne lira pas.
