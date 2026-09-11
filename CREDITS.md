# Crédits et licences des composants tiers

Mirmalion transporte deux modèles qu'il n'a pas produits. Tout le reste — transcription, modèle de
langue, traduction — vient d'Apple et vit dans le système, sans redistribution.

## Modèles de diarisation

Les fichiers de `DiarizerModels/` servent à une seule chose : reconnaître, à la fin d'une session,
la voix de l'utilisateur réentendue par le micro à travers les haut-parleurs, pour ne pas l'écrire
deux fois dans le transcript.

**`pyannote_segmentation.mlmodelc` · `wespeaker_v2.mlmodelc`**

Poids issus de [`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1),
par l'équipe pyannote — Hervé Bredin et contributeurs.
Sous licence [Creative Commons Attribution 4.0 International (CC-BY-4.0)](https://creativecommons.org/licenses/by/4.0/).

**Adaptation** : convertis au format CoreML par [FluidInference](https://huggingface.co/FluidInference/speaker-diarization-coreml),
et redistribués ici tels que ce dépôt les publie, sans modification de notre part.

## Bibliothèque de diarisation

[FluidAudio](https://github.com/FluidInference/FluidAudio), par FluidInference, sous licence
Apache 2.0. Le code de la bibliothèque est compilé dans l'application ; sa licence ne couvre pas
les poids ci-dessus, qui ont la leur.
