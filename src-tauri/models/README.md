# Les modèles embarqués

Ce dossier contient les seuls poids que Mirmalion transporte lui-même. Tout le reste — moteur de
transcription, LLM, traduction — vient d'Apple et vit dans le système.

## `DiarizerModels/` — la diarisation

| Fichier                          | Rôle                                    | Taille |
| -------------------------------- | --------------------------------------- | ------ |
| `pyannote_segmentation.mlmodelc` | Découpe la parole en tours              | 5,5 Mo |
| `wespeaker_v2.mlmodelc`          | Produit l'empreinte vocale d'un segment | 7,6 Mo |

**Provenance** : [`FluidInference/speaker-diarization-coreml`](https://huggingface.co/FluidInference/speaker-diarization-coreml)
sur Hugging Face — la conversion CoreML de `pyannote/speaker-diarization-community-1`, publiée par
les auteurs de [FluidAudio](https://github.com/FluidInference/FluidAudio) (v0.15.5, épinglée dans
`native/Package.resolved`).

### ⚠️⚠️ Pourquoi ils sont dans le dépôt, et pas téléchargés

`DiarizerModels.load()` — l'appel évident — **va les chercher sur Hugging Face au premier usage, en
silence**. C'est le comportement par défaut de la bibliothèque, et il viole frontalement la promesse
du produit. `Diarization.swift` passe donc exclusivement par
`load(localSegmentationModel:localEmbeddingModel:)`, qui ne télécharge rien, et ces fichiers-ci sont
ce qu'il ouvre.

Les commiter plutôt que les récupérer au build est un choix : le build reste reproductible, hors
ligne, et ne dépend pas d'un dépôt tiers qui peut disparaître ou changer de contenu sous le même nom.

### ⚠️⚠️ Le défaut que ce dossier répare est invisible sur une machine de développement

FluidAudio range ce qu'il a déjà téléchargé dans `~/Library/Application Support/FluidAudio/`, et le
pont s'y replie quand le bundle ne porte rien — c'est ce qui fait marcher `tauri dev`, qui lance un
binaire nu. **Conséquence : une diarisation réussit exactement pareil, embarquée ou non, sur le poste
qui la produit.** Le seul poste où la différence se voit est celui de l'utilisateur.

C'est pourquoi `tests/bundled_models.rs` existe, et pourquoi la seule mesure qui vaille quelque chose
est celle-ci :

```sh
mv ~/Library/Application\ Support/FluidAudio ~/Library/Application\ Support/FluidAudio.off
npm run tauri:build:dev
open "src-tauri/target/release/bundle/macos/Mirmalion Dev.app"
# transcrire un média à plusieurs voix, puis remettre le cache en place
```

Tant que le cache est en place, **un succès ne prouve rien**.

## ⚠️ Point ouvert : la licence des poids

FluidAudio est sous Apache 2.0, et **la licence du code ne couvre pas les poids**. Les deux dépôts
Hugging Face ont été lus :

| Dépôt                                            | Licence déclarée | Accès                                |
| ------------------------------------------------ | ---------------- | ------------------------------------ |
| `FluidInference/speaker-diarization-coreml`       | CC-BY-4.0        | libre                                |
| `pyannote/speaker-diarization-community-1` (parent) | CC-BY-4.0      | formulaire de contact, pas de clause |

L'« acceptation de conditions » du dépôt parent est un **formulaire de coordonnées** — un accord pour
recevoir des courriels sur les modèles pyannote —, et non une restriction d'usage. CC-BY-4.0 autorise
la redistribution et l'usage commercial.

⚠️ **Ce qu'elle exige en retour : l'attribution.** Créditer pyannote pour les poids et FluidInference
pour la conversion CoreML, nommer la licence et signaler qu'il y a eu adaptation. Tant que ce crédit
n'est écrit nulle part — ni dans l'application, ni dans un fichier qui l'accompagne —, la
redistribution ne remplit pas sa part.
