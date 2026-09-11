#!/bin/sh
#
# Signe un binaire de développement avant de l'exécuter, puis lui passe la main.
#
# Branché comme `runner` de cargo (voir `.cargo/config.toml`, **à la racine du dépôt**), il
# s'applique donc à `cargo run` — donc à `tauri dev` — et à `cargo test`.
#
# POURQUOI. Sans lui, ces binaires sont signés *ad hoc* : leur signature change à chaque
# compilation. Deux conséquences, toutes deux mesurées :
#   · le trousseau macOS ne reconnaît plus l'app et affiche une demande d'autorisation
#     modale à chaque redémarrage ;
#   · l'autorisation Accessibilité serait périmée à chaque build, rendant le raccourci global
#     et le collage au curseur intestables autrement qu'en bundle complet.
#
# Le `-i` n'est pas facultatif : il donne au binaire le **même identifiant** que le bundle de
# développement. C'est ce qui fait que les deux satisfont la même exigence désignée, donc
# partagent les mêmes autorisations, au lieu d'en demander chacun les siennes.
#
# ⚠️ Les entitlements sont **lus dans `tauri.conf.json`**, jamais recopiés ici : le binaire de
# développement et le bundle doivent porter les mêmes, et un chemin en dur se périme au
# premier renommage — en cassant `npm start`, pas le build.
#
# Pas de `--options runtime` ici, à la différence du bundle : le runtime durci est une exigence
# de la notarisation, et l'imposer au développement n'ajouterait que ses propres modes d'échec.
#
# ⚠️⚠️ NE JAMAIS SIGNER À LA MAIN UN BINAIRE QUE CE SCRIPT SIGNE — et le symptôme ne le dit pas.
# Un `codesign --force` lancé à la main sur `target/debug/deps/app_lib-*` (sans
# `--entitlements`, pour diagnostiquer un échec de signature transitoire) rend le binaire
# **tué au lancement par SIGKILL**, sans un mot, alors que `codesign -v` le déclare « valid on
# disk » et « satisfies its Designated Requirement ». Resigner par-dessus ne répare pas.
# Le remède est de **forcer une réédition de liens** (`touch src/lib.rs`, ou supprimer le binaire
# ET son `.d`) : cargo relie, le runner signe, tout repart.
#
# ⚠️ Un échec de signature **transitoire** existe par ailleurs — le trousseau refuse parfois sous
# plusieurs compilations concurrentes ; relancer suffit. C'est pour distinguer ce cas-là de tous
# les autres que la sortie de `codesign` est reproduite telle quelle : sans elle, un fichier
# d'entitlements introuvable ressemble à un problème d'identité.

set -eu

BINARY="$1"
shift

SRC_TAURI="$(cd "$(dirname "$0")/.." && pwd)"

read_json() {
  python3 -c "import json,sys; print(json.load(open(sys.argv[1]))$2)" "$1"
}

IDENTITY="${MIRMALION_SIGNING_IDENTITY:-$(read_json "$SRC_TAURI/tauri.conf.json" "['bundle']['macOS']['signingIdentity']")}"
IDENTIFIER="$(read_json "$SRC_TAURI/tauri.conf.dev.json" "['identifier']")"
ENTITLEMENTS="$SRC_TAURI/$(read_json "$SRC_TAURI/tauri.conf.json" "['bundle']['macOS']['entitlements']")"

if ! failure="$(codesign --force --sign "$IDENTITY" -i "$IDENTIFIER" \
  --entitlements "$ENTITLEMENTS" "$BINARY" 2>&1)"; then
  echo "sign-and-run : impossible de signer $BINARY avec « $IDENTITY »." >&2
  echo "$failure" >&2
  exit 1
fi

exec "$BINARY" "$@"
