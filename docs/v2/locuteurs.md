# Locuteurs, diarisation et répertoire de voix — retirés du produit le 2026-08-06

> *Porteur, 2026-08-06* : « on va supprimer l'idée des locuteurs et de la diarisation. On laisse
> tomber, on verra plus tard si ça nous intéresse. On traite juste du texte. »

**Ce fichier n'est pas une fiche de tâche. C'est un dépôt de mesures.** Il existe parce que ce qui a
été retiré avait été **mesuré**, et qu'une mesure jetée doit être refaite — ce qui coûte
infiniment plus cher que de la relire. Si les locuteurs reviennent un jour, tout ce qui suit est
encore vrai et n'est pas à reproduire.

## Ce qui a été retiré, exactement

| | |
| --- | --- |
| **Affichage** | Toute étiquette de locuteur dans un transcript — Direct **et** Fichiers. Y compris « Moi ». Un transcript est du texte en paragraphes. |
| **Participants** | La rangée de pastilles renommables, son popover, la modale à compteur et ses quatre rendus (3 · pastilles, 4 · compteur, 12 · 2 colonnes, 24 · 3 colonnes). |
| **Répertoire de voix** | Les empreintes conservées, leur suggestion d'une session à l'autre, leur oubli unitaire et global. |
| **Consentement biométrique** | La note de confidentialité et son interrupteur. |
| **Réglages** | Options ▸ Historique & confidentialité : « Reconnaissance des voix » et « Répertoire de voix ». |
| **Fichiers** | Le sélecteur de mode (détection automatique / nombre défini / masquer), le champ de nombre, « Ré-analyser » et le rendu par locuteurs. |

**Le dessin de tout cela est dans l'historique git**, au commit qui précède `ffc6d0c`. Le reprendre
coûte un `git show`, pas une reconception.

## ⚠️⚠️ CE QUI RESTE DANS LE PRODUIT, ET QU'IL NE FAUT PAS RETIRER

**FluidAudio reste une dépendance obligatoire.** Il ne sert plus qu'à **écarter l'écho** : dans une
visio haut-parleurs actifs, la voix de l'utilisateur captée par son micro **réapparaît** dans le
flux système, et chaque phrase qu'il dit s'écrirait **deux fois** dans le transcript. Ce filtre
n'affiche rien et ne conserve rien — les empreintes qu'il calcule meurent avec la session.

Le détail de la solution (identité de voix, borne à 0,26, attribution flux par flux) est dans
`CLAUDE.md`, où il gouverne encore du code livré. **Il n'est pas dupliqué ici.**

## Les mesures qui ne gouvernent plus rien — à ne pas refaire

### Le seuil de diarisation n'a pas de bonne valeur fixe

`numClusters` est **sans effet** ; seul le seuil agit. **0,80** convient sur un audio propre,
**0,60** sur un audio bruité. D'où la conception retenue à l'époque : demander le **nombre de
participants** au démarrage, puis calibrer par **dichotomie**. Elle convergeait en **3 essais**
(mesuré le 2026-08-03 : seuil 0,60 → 6 voix, 0,70 → 3, 0,80 → 2, pour 5 voix réelles ; convergence
sur 0,65).

### ⚠️⚠️ Le diariseur fabrique des voix parasites, et le calibrage les comptait

*Mesuré le 2026-08-04, sur huit médias, cinq seuils chacun.*

Presque tout média rend **une voix de plus** que de personnes présentes : **un seul tour, de 1 à
3 s** — un rire, un applaudissement, un jingle. Comme la dichotomie vise un **compte**, demander
cinq locuteurs sur le plateau de référence en rendait **quatre plus une ombre**, et rien à l'écran
ne le montrait.

Écartées par `without_slivers` (`diarization/mod.rs`), **avant tout comptage** — plus loin, on
n'aurait réparé que l'affichage.

- **La borne — 5 s de parole cumulée — est posée au MILIEU d'un fossé mesuré** : plus long parasite
  **3,3 s**, plus courte voix réelle **14,2 s**, rien entre les deux. Elle est éprouvée **à la
  compilation** : la sortir du fossé empêche de compiler.
- **Ce qu'elle ne répare pas** : sur trois conférences à orateur unique, une seule bascule en
  « voix unique ». Les deux autres gardent une seconde voix de **9,2 s** et **15,1 s**.
  ⚠️ **Ne pas remonter la borne pour les attraper** — elle mordrait dans du réel.
- ⚠️ **Une mesure de diarisation qui appelle `diarize` ne mesure plus le produit** : le pont nu
  ignore ce filtre. Passer par `measure::analyse`.

### L'attribution se fait au MOT, pas au segment

Les morceaux rendus par le STT **débordent** les tours de parole. Attribuer segment par segment
donne un mot au mauvais locuteur dès que deux voix se recouvrent — c'est-à-dire dès que quelqu'un
coupe la parole. ⚠️ **Cette règle gouverne encore le filtre d'écho** et vit dans `CLAUDE.md`.

## Ce qu'il faudra reposer, le jour où le sujet se rouvre

- **La revue juridique** sur les données biométriques, qui était planifiée pour la phase 7. Elle
  n'a plus d'objet tant qu'aucune empreinte n'est conservée. Elle redevient **obligatoire** dès la
  première empreinte écrite sur le disque.
- **Le corpus manquant** : les mesures d'écartement d'écho comparaient des voix d'étrangers issues
  d'**enregistrements de studio**. Deux voix **réellement proches** — deux frères, deux collègues
  au timbre voisin — n'ont **jamais** été mesurées. C'est la première chose à faire.
- **Le consentement en contexte**, jamais à l'onboarding : consentir à une donnée biométrique avant
  d'avoir vu un transcript n'a pas de sens. Cette règle avait été tranchée, elle tient toujours.
- ⚠️⚠️ **LE TRAVAIL SWIFT N'A JAMAIS ÉTÉ FAIT, ET C'EST LE VRAI COÛT DE LA RÉOUVERTURE.**
  `Diarization.swift` ne rend que des **segments** : faire traverser une **empreinte** au pont
  demande un export supplémentaire, qui n'existe pas. *(Relevé par l'audit d'entrée de la phase 4,
  le 2026-08-04, et toujours vrai à sa clôture.)* Ne pas lire « le répertoire de voix était
  presque là » — il n'y avait que le dessin.
  ⚠️ **Le rapprochement `mirmalion_voice_match`, lui, existe** et calcule bien des empreintes : il
  n'en fait **sortir que des distances**, jamais les empreintes elles-mêmes. C'est délibéré, et
  c'est ce qui rend vraie la phrase « aucune donnée biométrique ne quitte la mémoire ».
