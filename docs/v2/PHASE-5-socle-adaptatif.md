# Phase 5 — Socle adaptatif macOS 15–25 & gestionnaire de modèles

**Branche : `phase/5-socle-adaptatif`**

> ⚠️⚠️ **LA ROADMAP QUE CETTE FICHE CITAIT N'EXISTE PLUS** *(supprimée le 2026-08-14 avec le
> cadrage)*. Les règles globales et la definition of done vivent dans `.claude/CLAUDE.md` et dans
> `npm run verify`. Le vocabulaire de phases et de tâches (`P5-00`…) qui subsiste ci-dessous est
> **historique** : il dit ce qui restait à faire, pas comment on travaille aujourd'hui.
>
> 📋 **Fiche non détaillée.** Les tâches sont identifiées, avec objectif et références. **Le premier travail sera de la détailler**, au moment d'y entrer — quand on saura si l'abstraction moteur a tenu.

## But de la phase

Faire tourner l'application sur **macOS 15 à 25**, où Apple Intelligence n'existe pas : brancher **Whisper** et un **LLM MLX** derrière les abstractions posées en phase 2, et livrer le **gestionnaire de modèles** qui permet à l'utilisateur d'en changer.

## Ce qui rend cette phase possible

Les phases 2 à 4 ont construit **derrière deux abstractions** : le trait moteur STT (P2-05) et le trait LLM (P2-10). Si elles ont été bien conçues, cette phase branche de nouveaux backends sans toucher aux fonctionnalités. Si elles ne l'ont pas été, c'est ici qu'on le découvre — d'où l'intérêt de ne pas repousser plus loin.

## Ce qui est déjà mesuré

- **Whisper** : trois tailles — `base` ~145 Mo, `small` ~460 Mo, `large-v3-turbo` ~1,6 Go — via `whisper.cpp`, **sans Python**. Couvre les 9 langues. Atout : le _code-switching_. ⚠️ **Limite : c'est un moteur batch**, donc pas de partiels — d'où latence en fin de dictée. **Prouvé en production** dans l'app Electron actuelle.
- **LLM MLX** : **parité atteinte et dépassée**. Gemma 12B avale 8 034 mots **en une passe** (10 313 tokens), **sans map-reduce**, rappel 5/5 — mais **3× plus lent** (57 s contre 19 s) et **12 Go à télécharger**.
- **Cohere Transcribe** : ~1,8 Go en INT8, 9/9 langues, passe par **FluidAudio** — la même pile que la diarisation, déjà intégrée en phase 3.
- **Écartés, définitivement** : **Parakeet, Canary, Granite, Distil-Whisper** — anglo/euro-centrés, **ni chinois, ni japonais, ni coréen**. Le retrait du néerlandais et du turc ne les rattrape pas. _Enseignement : les champions du WER anglais ne couvrent pas notre périmètre._
- ⚠️ **DETTE HÉRITÉE DE LA PHASE 2 — la traduction ne marche PAS sous macOS 26** (mesuré le 2026-07-30, P2-12). La phase 2 traduit par `TranslationSession(installedSource:target:)`, qui est **`@available(macOS 26.0)`**. Sous ce plancher, la seule voie est le modificateur SwiftUI `.translationTask`, donc **un hôte SwiftUI dans une fenêtre Tauri** — une brique que le projet n'a pas. ⚠️ **Et `Capabilities.swift` annonce `translation: ready` sur tout le socle** : c'est vrai du framework et de `LanguageAvailability`, **faux de la traduction elle-même**. Le drapeau ment aujourd'hui sur 15–25 ; le corriger fait partie de cette phase, au même titre que d'y brancher la traduction.

## Le risque principal

**Aucune machine macOS 15–25 n'est disponible** (_NON TESTABLE ici_). Le risque est réduit — Whisper est prouvé en production, le LLM MLX est mesuré, et tous deux sont indépendants de la version d'OS — mais la **détection de version** et d'éventuels écarts de comportement des frameworks Apple restent à valider **sur une machine ancienne avant diffusion**. C'est un prérequis de la phase 7, pas une option.

## Tâches

| ID        | Tâche                                  | Objectif                                                                                                                                                                                                                                                                              | Références                                                                                       |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **P5-00** | **Détailler cette phase**              | Reprendre chaque tâche ci-dessous au format des phases 0-4 : pièges, fichiers pressentis, DoD spécifique. Vérifier au passage que les abstractions de P2-05 et P2-10 tiennent réellement. ⚠️ **Y créer la tâche « traduction sous macOS 26 »** — voir la dette héritée ci-dessus, elle n'a pas encore d'identifiant. | —                                                                                                |
| **P5-01** | Whisper derrière l'abstraction STT     | Brancher `whisper.cpp` (3 tailles) comme second moteur. Faire fonctionner un moteur **batch** là où l'appelant attend des partiels — c'est le vrai test de l'abstraction.                                                                                                             | · app Electron actuelle                                                                   |
| **P5-02** | LLM MLX derrière l'abstraction LLM     | Brancher un LLM MLX comme second moteur de génération. Contexte étendu : le map-reduce devient inutile mais doit rester correct s'il se déclenche.                                                                                                                                    |                                                                              |
| **P5-03** | Cohere Transcribe (upgrade opt-in)     | Troisième moteur STT, via FluidAudio — la pile est déjà là depuis la phase 3.                                                                                                                                                                                                         |                                                                                   |
| **P5-04** | Package de base à l'onboarding         | Sur macOS 15–25, proposer le téléchargement du package (Whisper + LLM MLX). Le point de reprise a été laissé ouvert en P2-03.                                                                                                                                                         | §4.8                                                                                     |
| **P5-05** | Gestionnaire de modèles — bibliothèque | La liste des modèles présents **sur le disque**, avec taille, suppression, et **état vide**. « Bibliothèque = ce qui est installé », pas un catalogue.                                                                                                                                | option 4 · maquette `#mm-lib`, `#mm-fold`, `#mm-add-btn`                                  |
| **P5-06** | Parcours guidé d'ajout de modèle       | Les **7 étapes** maquettées : saisie · lecture (en ligne) · lecture (locale) · reconnu (en ligne) · reconnu (local) · téléchargement · prêt. Identifiant Hugging Face **ou** dossier local, à poids égal.                                                                             | maquette : `.am-pane`, `data-am="…"`, `#am-id`, `#am-browse`, `#am-go`, `#am-cancel`, `#am-done` |
| **P5-07** | Téléchargement et annulation           | `ProgressBar` en modale, progression réelle (octets reçus / taille totale), **Annuler présent immédiatement** — plusieurs gigaoctets ne sont jamais une opération courte. Annuler revient à l'étape « reconnu », déjà vérifiée.                                             |                                                                                     |
| **P5-08** | Comportement du ✕ de la modale d'ajout | **Point explicitement reporté** lors de l'intégration de la maquette (« on finira le travail du ✕ après »). Trancher : fermeture pendant un téléchargement, pendant une vérification, après succès.                                                                                   | maquette `#am-close`                                                                             |
| **P5-09** | Options — famille Moteurs & modèles    | La cinquième famille. ⚠️ **La seule famille non maquettée** : **la dessiner d'abord dans `ui.html`**, puis l'implémenter. Trancher le choix par tâche vs global (STT / résumé / traduction).                                                                                   | option 4                                                                                  |
| **P5-10** | Cohérence des sélecteurs de moteur     | **Point ouvert relevé sur la maquette** : les sélecteurs proposent encore `Pyannote 3.1` et `NLLB-200`, absents de la bibliothèque. Maintenant que « bibliothèque = ce qui est sur le disque », trancher : masquer tant que non installé, ou afficher avec le coût de téléchargement. | option 4                                                                                  |
| **P5-11** | Défauts adaptatifs par OS              | **Point ouvert relevé sur la maquette** : trois sélecteurs de moteur ont « Apple » par défaut, ce qui n'existe pas sur macOS 15–25. Les défauts doivent suivre les **capacités** détectées (P0-04), pas une valeur figée.                                                             | §4.8 option 4                                                                            |
| **P5-12** | Validation sur une machine macOS 15–25 | Faire tourner l'app complète sur une machine ancienne. **Prérequis de la phase 7.** À défaut de machine, dire explicitement que le risque est assumé — et l'écrire dans le cadrage.                                                                                                   | (_NON TESTABLE ici_), §4.8                                                                 |
| **P5-13** | Clôture de phase                       | Vérification d'ensemble, cadrage à jour, merge dans `main`.                                                                                                                                                                                                                           | —                                                                                                |

## Points à trancher dans cette phase

Le cadrage les laisse ouverts ( option 4) :

- **Choix de moteur par tâche ou global ?** (par exemple STT Whisper + résumé Apple)
- **Shortlist MLX / Whisper exacte** et poids retenus.
- **Comment surfacer les arbitrages** qualité / vitesse / taille pour guider le choix, sans transformer les Options en fiche technique.
- ⚠️ **Impact sur les langues** : un moteur **Whisper élargit la couverture STT au-delà des 9 langues Apple**. Le choix de moteur est _aussi_ la réponse au plafond de langues — mais l'**interface** reste localisée dans les 9. Ne pas confondre les deux périmètres.

---

## Ce que le cadrage en disait — **rapatrié ici le 2026-08-02**

⚠️ **Ces blocs ont été RETIRÉS de `CADRAGE_FINALE.md`**, pas recopiés : le cadrage ne décrit plus que
la v1, qui ne livre que macOS 26. Ils sont la référence complète, et **la seule** — les numéros de
section (§4.8…) renvoient à leur emplacement d'origine, où il n'y a plus rien à lire.

### §4.8 — les deux dimensions du socle

**Dimension 1 — socle adaptatif (détection macOS à l'onboarding) :**
- **macOS 26+** → **Apple Intelligence natif** : `SpeechTranscriber` (STT flux + code-switching) +
  **Foundation Models** (CR structuré `@Generable`) + **Translation** — **0 téléchargement**, premium.
- **macOS 15–25** → **package de base téléchargé** (une fois) : **Whisper** (STT) + **LLM MLX**
  (reformulation + CR structuré) + **Translation framework** Apple (natif dès 14.4, donc présent) —
  fonctionnalités **identiques**, au prix d'un téléchargement et d'une qualité qui dépend du modèle.
- **Diarisation = FluidAudio** (Swift/CoreML/ANE) dans **tous** les cas — **seule brique tierce**,
 incontournable (Apple ne fournit aucune diarisation), compatible dès macOS 14. Voir et §7.0.2.

**Dimension 2 — upgrades power-user (opt-in, tous OS option 4) :**
- Modèles **plus conséquents** pour pousser plus loin : **LLM MLX à contexte étendu** (Qwen/Llama plus gros)
 → CR **plus riches / plus longs** que le petit modèle Apple (~4 096 tokens) ; **Whisper large** →
  couverture STT **au-delà des 9 langues** ; **Cohere** → qualité. Gérés par le **gestionnaire de modèles**
  des Options. Défaut = Apple (sur 26) / MLX de base (sur 15–25) ; les upgrades sont **opt-in**.

**Pourquoi 15 et pas 14.4 :** plancher plus « propre » (OS actuel-1, mieux testé) ; 14.4 aurait donné une
génération de plus mais au prix d'une matrice de tests élargie. *(La brique contraignante, Translation, est
native dès 14.4 — 15 est donc un choix de qualité, pas une contrainte technique.)*

### — les moteurs STT et le choix offert

### 7.0.1 Moteurs STT — le choix offert à l'utilisateur

Le STT est **abstrait derrière un choix de moteur** ( option 4). Apple par défaut ; les autres
sont **téléchargés à la demande**.

| Moteur | Rôle | Les 9 | Licence | Runtime Mac | Poids | Flux |
|---|---|:---:|---|---|---|---|
| **Apple SpeechTranscriber** | **défaut** | ✅ 9/9 | — | natif OS | 0 (assets OS) | ✅ streaming |
| **Whisper** (3 tailles) | universel | ✅ 9/9 | MIT | `whisper.cpp` | 145 Mo – 1,6 Go | ❌ batch |
| **Cohere Transcribe** | qualité max | ✅ 9/9 | Apache-2.0 | CoreML/ANE (FluidAudio) | ~1,8 Go (INT8) | ❌ batch |

- **Cohere** ne manquait que le **turc**, désormais hors périmètre : il couvre donc **9/9**. Il passe par
  **FluidAudio**, la même bibliothèque que la diarisation — une seule pile Swift/CoreML pour les deux.
- **Whisper** : trois tailles (`base` ~145 Mo, `small` ~460 Mo, `large-v3-turbo` ~1,6 Go), sans Python.
  Atout : le *code-switching*. Limite : **batch**, donc latence en fin de dictée.
- **Écartés — et pourquoi ça ne changera pas** : **Parakeet**, **Canary**, **Granite**,
  **Distil-Whisper** sont **anglo/euro-centrés** et n'ont **ni chinois, ni japonais, ni coréen**. Ces
  trois langues restent dans les 9, donc le retrait du néerlandais et du turc ne les rattrape pas.
  Enseignement transverse : **les champions du WER anglais ne couvrent pas notre périmètre.**
- **Candidats futurs** (Apache-2.0, non retenus en v1) : **Qwen3-ASR** (9/9, SOTA multilingue — doublon
  avec Whisper aujourd'hui) et **Voxtral** (Mistral : streaming 80 ms–2,4 s **et** diarisation intégrée ;
  intégration Apple Silicon moins mûre — pourrait à terme concurrencer FluidAudio).

### — le renversement MLX

> ⭐ **RENVERSEMENT ACTÉ — MLX n'est pas un repli dégradé.** Le cadrage présentait le package MLX comme la
> version amoindrie pour les vieux macOS. La mesure dit l'inverse : **Gemma 12B (MLX) traite les mêmes
> 8 034 mots EN UNE SEULE PASSE** (10 313 tokens absorbés), **sans map-reduce**, avec le **même rappel
> 5/5** et un compte rendu structuré. Son seul défaut est la **vitesse : 57 s contre 19 s** (3×), plus le
> **poids du modèle** (12 Go à télécharger).
>
> Conséquences :
> 1. Le chemin **macOS 15–25 tient sa promesse de parité** — il la dépasse même sur le contexte.
> 2. L'upgrade « LLM MLX à contexte étendu » se justifie **aussi sur macOS 26**, et pour une raison
>    précise : **la fenêtre de contexte**, pas seulement la qualité. C'est l'option à proposer à qui
>    enregistre des sessions de plusieurs heures.
> 3. L'arbitrage à exposer à l'utilisateur est donc **vitesse (Apple) contre contexte (MLX)** — pas
>    « bon » contre « dégradé ».

### option 4 — le gestionnaire de modèles

4. **Choix des moteurs / modèles** *(gros sujet — à explorer à fond en phase Options)* — gère **le socle
 adaptatif** (§4.8 : Apple sur macOS 26 / package **Whisper + LLM MLX** sur macOS 15–25) **et** les
 **upgrades power-user** (modèles plus conséquents), validés en, pour un
   utilisateur qui veut **pousser plus loin / trouver ce qui lui convient**. Questions à trancher :
   - **3 points de swap distincts** : **STT** (Apple SpeechTranscriber / Whisper / Parakeet-MLX…),
     **résumé** (Apple Foundation Models / LLM MLX : Qwen, Llama, Mistral…), **traduction** (Apple / LLM).
   - **Par tâche ou global ?** (ex. STT Whisper + résumé Apple).
   - **Défaut adaptatif** : **Apple** sur macOS 26 (**zéro téléchargement**) / **MLX+Whisper de base** sur
     15–25 (téléchargé à l'onboarding) ; **upgrades opt-in** au-dessus.
   - **Gestionnaire de modèles** (grosse pièce UX) : télécharger, **taille / espace disque**, supprimer —
     les modèles MLX/Whisper sont de **gros téléchargements**.
   - **Impact langues** : un moteur **Whisper** **élargit la couverture STT au-delà des 9 langues Apple**
 — le choix de moteur est *aussi* la réponse au plafond de langues.
   - **Surfacer les arbitrages** qualité / vitesse / taille pour guider le choix ; exposer la **shortlist
 MLX validée**.

### — les mesures qui fondent cette phase

| Sujet | Mesure |
| --- | --- |
| **LLM MLX (repli 15–25)** | **Parité atteinte et dépassée** : Gemma 12B avale 8 034 mots **en une passe** (10 313 tokens), **sans map-reduce**, rappel **5/5** — mais **3× plus lent** (57 s vs 19 s) et 12 Go à télécharger. |
| **API Apple sur 15–25** *(risque, moyen)* | Whisper prouvé en production, LLM MLX mesuré. La **détection est faite** (P0-04) ; restent d'éventuels écarts de comportement des frameworks, à valider sur une machine ancienne. |

**Risque, tel qu'il était écrit au :** *Comportement réel sur macOS 15–25.* Aucune machine
ancienne disponible. Le risque est cependant **fortement réduit** : Whisper est prouvé en production et
le LLM MLX atteint la parité, tous deux indépendants de la version d'OS. Reste la **détection de
version** et d'éventuels écarts des frameworks Apple — à valider sur une machine ancienne **avant
diffusion**.

### / — décisions et points restés ouverts

- **Deux dimensions de modèles** : (1) **socle adaptatif** selon l'OS ; (2) **upgrades power-user opt-in**
  (LLM MLX plus gros, Whisper large, Cohere) sur tous les OS. Apple/MLX de base par défaut ; gestionnaire
  de modèles dans les Options.
- **Modèles optionnels exacts** : shortlist MLX/Whisper + poids retenus — **restait à trancher**.
- **La famille « Moteurs & modèles » n'est PAS maquettée** — la seule des sept dans ce cas. Elle
  se dessine dans `ui.html` **avant** d'être implémentée (P5-09).
