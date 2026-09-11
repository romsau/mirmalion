#!/usr/bin/env bash
#
# Publie une version de Mirmalion : construction, notarisation, agrafage, GitHub Release, mise
# en ligne de la page et du manifeste de mise à jour.
#
#   npm run release              # tout, depuis une compilation neuve
#   npm run release -- --skip-build   # repart des artefacts déjà construits
#   npm run release -- --no-deploy    # réécrit la page et assemble ./dist-web sans rien publier
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# ⚠️⚠️ CE SCRIPT EXISTE POUR QU'UNE NOUVELLE VERSION COÛTE UNE COMMANDE.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
#
# Le geste est censé se répéter à chaque correctif de la campagne de tests. Une procédure en huit
# étapes manuelles ne serait pas refaite, ou serait refaite de travers — et une version mal
# notarisée ne se voit pas sur la machine qui l'a produite : elle ne se voit que chez le testeur,
# sous la forme d'un « Mirmalion est endommagée » qu'aucun message ne rattrape.
#
# ── Ce que la notarisation est, et ce qu'elle n'est pas ────────────────────────────────────────
#
# ⚠️ **Elle n'a AUCUN rapport avec l'App Store.** C'est le tampon qu'Apple pose sur un binaire
# distribué hors de sa boutique, après l'avoir scanné. Sans lui, une signature Developer ID
# valide ne suffit pas : macOS 15+ a retiré le contournement par clic droit ▸ Ouvrir, et
# l'application est refusée sans recours chez qui la reçoit.
#
# ── Ce qui est agrafé, et pourquoi pas le reste ────────────────────────────────────────────────
#
# ⚠️⚠️ **DEUX SOUMISSIONS À APPLE, ET C'EST IRRÉDUCTIBLE.** L'agrafe se pose sur un fichier après
# coup, et le ticket est délivré pour l'empreinte de CE fichier :
#
#   1. le `.app` part le premier, et se fait agrafer ;
#   2. le `.dmg` ne peut être notarisé qu'ENSUITE, puisque son contenu vient de changer.
#
# ⚠️⚠️ **AGRAFER LE `.dmg` NE SUFFIT PAS, ET LE CROIRE EST LE PIÈGE.** Le testeur ouvre le `.dmg`
# — validé hors ligne, très bien — puis **glisse le `.app` dans /Applications**. C'est ce `.app`
# copié que Gatekeeper évalue au premier lancement, et il porte sa propre quarantaine. Sans
# ticket dedans, un poste **hors réseau** le refuse. Mesuré : jusqu'à la 0.9.4, seul le `.app`
# resté sous `bundle/macos/` était agrafé — pas celui que le `.dmg` transporte, fabriqué avant.
#
# ⚠️ **L'ARCHIVE DE MISE À JOUR N'EST PAS AGRAFÉE, ET C'EST DÉLIBÉRÉ.** Elle est téléchargée par
# notre propre code, qui ne pose aucune quarantaine : Gatekeeper ne réévalue pas un bundle non mis
# en quarantaine, et l'archive est de toute façon protégée par NOTRE signature `minisign`, que le
# plugin vérifie avant d'écrire quoi que ce soit. La reconstruire après agrafage supposerait de
# refaire le `tar` à la main — et un `tar` maison sur un bundle macOS abîme les liens symboliques
# et les attributs étendus, donc la signature de code. Le remède serait pire que le mal.
#
# ⚠️ Son binaire reste **notarisé** malgré tout : c'est le même `.app`, au même `cdhash`. Ce qui
# lui manque est l'agrafe, pas le tampon.
#
# ── La clé de signature des mises à jour ───────────────────────────────────────────────────────
#
# ⚠️⚠️ **SA PERTE EST DÉFINITIVE ET SILENCIEUSE.** Chaque application installée ne fait confiance
# qu'à la clé publique inscrite dans son propre binaire (`plugins.updater.pubkey`). Une clé perdue
# oblige à publier une version signée par une autre clé, que **personne** n'acceptera : tous les
# postes déjà installés cesseraient de se mettre à jour, sans message et sans recours — il
# faudrait leur renvoyer un `.dmg` à la main. Elle vit dans `~/.mirmalion/updater.key`, hors du
# dépôt, et son mot de passe dans le trousseau. **À sauvegarder ailleurs que sur cette machine.**

set -euo pipefail

readonly KEYCHAIN_PROFILE='mirmalion'
readonly KEY_PATH="${HOME}/.mirmalion/updater.key"
readonly KEY_PASSWORD_SERVICE='mirmalion-updater-key'
readonly SITE='https://mirmalion.web.app'
readonly BUNDLE='src-tauri/target/release/bundle'
readonly STAGING='dist-web'

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

skip_build=false
deploy=true
for flag in "$@"; do
  case "$flag" in
    --skip-build) skip_build=true ;;
    # ⚠️ Tout s'arrête juste avant la mise en ligne, le site assemblé restant sur le disque. La
    # publication est la seule étape de ce script qui soit visible de l'extérieur — donc la seule
    # qu'on veuille parfois relire avant de la faire.
    --no-deploy) deploy=false ;;
    *) fail "option inconnue : ${flag}" ;;
  esac
done

cd "$(dirname "$0")/.."

# ── 0. Vérifier les outils AVANT de compiler pendant dix minutes ───────────────────────────────
#
# ⚠️ Un identifiant manquant se découvrirait sinon à l'étape de notarisation, après la
# compilation la plus longue de la chaîne. On échoue tôt.
step 'Vérification des identifiants'
[[ -f "$KEY_PATH" ]] || fail "clé de signature absente : ${KEY_PATH}"
security find-generic-password -s "$KEY_PASSWORD_SERVICE" -w > /dev/null 2>&1 \
  || fail "mot de passe de la clé absent du trousseau (service « ${KEY_PASSWORD_SERVICE} »)"
xcrun notarytool history --keychain-profile "$KEYCHAIN_PROFILE" > /dev/null 2>&1 \
  || fail "profil de notarisation « ${KEYCHAIN_PROFILE} » inutilisable — voir « notarytool store-credentials »"

# ⚠️ Une release GitHub ne se recrée pas sous le même tag, et le script commet la page avant de
# la créer : la branche et l'arbre se vérifient AVANT les dix minutes de compilation.
gh auth status > /dev/null 2>&1 || fail 'gh n’est pas connecté — « gh auth login »'
[[ "$(git branch --show-current)" == main ]] || fail 'une version se publie depuis main'
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail 'l’arbre de travail n’est pas propre — commettre ou remiser avant de publier'

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
readonly version
if gh release view "v${version}" > /dev/null 2>&1; then
  fail "la release v${version} existe déjà — monter le numéro de version d'abord"
fi
# ⚠️ Lue là où elle est déjà déclarée, jamais recopiée : `build.rs` fait de même pour la .dylib,
# et deux endroits à corriger le jour où le certificat change en font toujours un d'oublié.
identity=$(node -p "require('./src-tauri/tauri.conf.json').bundle.macOS.signingIdentity")
readonly identity
printf '  version %s, clé et notarisation prêtes\n' "$version"

readonly app="${BUNDLE}/macos/Mirmalion.app"
readonly archive="${BUNDLE}/macos/Mirmalion.app.tar.gz"
readonly dmg="${BUNDLE}/dmg/Mirmalion_${version}_aarch64.dmg"

# ── 1. Régénérer la documentation du code ──────────────────────────────────────────────────────
#
# ⚠️ Avant la compilation, pour la même raison que l'étape 0 : une documentation qui ne se
# construit pas se découvrirait sinon après dix minutes de build.
step 'Documentation du code'
npm run docs > /dev/null || fail 'la documentation du code ne se construit pas'
printf '  angular et rust régénérées dans docs/api\n'

# ── 2. Construire ──────────────────────────────────────────────────────────────────────────────
if [[ "$skip_build" == true ]]; then
  step 'Construction ignorée (--skip-build)'
else
  step 'Construction de la version signée'
  # ⚠️⚠️ **`TAURI_SIGNING_PRIVATE_KEY` PORTE LE CONTENU DE LA CLÉ, PAS SON CHEMIN**, et il ne faut
  # pas le confondre avec `TAURI_SIGNING_PRIVATE_KEY_PATH`, qui est un drapeau de la commande
  # `tauri signer sign` et que le bundler IGNORE. Le symptôme est traître : la compilation va
  # jusqu'au bout, produit l'archive, et n'échoue qu'à la toute dernière ligne sur « a public key
  # has been found, but no private key » — sans `.sig`, donc sans mise à jour possible.
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s "$KEY_PASSWORD_SERVICE" -w)" \
    npm run tauri:build
fi

for artefact in "$app" "$archive" "${archive}.sig" "$dmg"; do
  [[ -e "$artefact" ]] || fail "artefact attendu absent : ${artefact}"
done

# ── 3. Notariser et agrafer le .app ────────────────────────────────────────────────────────────
#
# ⚠️ Le `.app` d'abord, et le `.dmg` seulement après : agrafer modifie le fichier, et un `.dmg`
# notarisé dont on change le contenu perd la validité de son propre ticket.
#
# ⚠️ `--wait` est ce qui rend l'étape utilisable dans un script : sans lui, `notarytool` rend la
# main sur un identifiant de soumission et il faudrait interroger Apple en boucle. Comptez une à
# trois minutes, deux fois.
#
# ⚠️ `ditto -c -k --keepParent` et jamais `zip` : seul `ditto` préserve les liens symboliques et
# les attributs étendus d'un bundle macOS, donc sa signature de code.
step 'Notarisation du .app par Apple (1/2)'
readonly app_zip="${BUNDLE}/macos/Mirmalion.app.zip"
rm -f "$app_zip"
ditto -c -k --keepParent "$app" "$app_zip"
xcrun notarytool submit "$app_zip" --keychain-profile "$KEYCHAIN_PROFILE" --wait \
  || fail 'notarisation du .app refusée — « xcrun notarytool log <id> --keychain-profile mirmalion » dira pourquoi'
rm -f "$app_zip"
xcrun stapler staple "$app" || fail 'le ticket ne s’agrafe pas au .app'

# ── 4. Poser le .app agrafé dans le .dmg ───────────────────────────────────────────────────────
#
# ⚠️⚠️ **ON MODIFIE L'IMAGE, ON NE LA RECONSTRUIT PAS.** `tauri build` a déjà fabriqué le `.dmg`
# avec sa disposition, son fond et la position de ses icônes. Le refaire à la main demanderait de
# reproduire l'invocation de `bundle_dmg.sh`, que Tauri compose lui-même — un aller-retour par
# une image inscriptible ne touche qu'au bundle et laisse tout le reste intact.
#
# ⚠️ L'agrandissement n'est pas décoratif : une image convertie est ajustée à son contenu, et le
# ticket n'y tiendrait pas.
step 'Agrafage du .app à l’intérieur du .dmg'
readonly writable="${BUNDLE}/dmg/writable.dmg"
readonly staged="${BUNDLE}/dmg/staged.dmg"
rm -f "$writable" "$staged"
hdiutil convert "$dmg" -format UDRW -o "$writable" -quiet
hdiutil resize -size "$(( $(stat -f%z "$dmg") / 1048576 + 40 ))m" "$writable" > /dev/null
mount_point=$(hdiutil attach "$writable" -nobrowse -owners on | grep -o '/Volumes/.*' | tail -1)
[[ -n "$mount_point" ]] || fail 'l’image inscriptible ne se monte pas'
xcrun stapler staple "${mount_point}/Mirmalion.app" || {
  hdiutil detach "$mount_point" -quiet || true
  fail 'le ticket ne s’agrafe pas au .app du .dmg'
}
# ⚠️ La signature se revérifie **ici**, image montée : un ticket mal posé ne se verrait sinon
# qu'au premier lancement, chez le testeur.
codesign --verify --deep --strict "${mount_point}/Mirmalion.app" || {
  hdiutil detach "$mount_point" -quiet || true
  fail 'la signature du .app est abîmée après agrafage'
}
hdiutil detach "$mount_point" -quiet
hdiutil convert "$writable" -format UDZO -o "$staged" -quiet
rm -f "$writable" "$dmg"
mv "$staged" "$dmg"

# ⚠️⚠️ **LA CONVERSION PRODUIT UN FICHIER NEUF, DONC NON SIGNÉ**, et Tauri signait le `.dmg` qu'il
# avait fabriqué. Sans cette ligne, la notarisation passe quand même — Apple regarde le code
# imbriqué, qui est signé — et c'est Gatekeeper qui refuse ensuite, sur « no usable signature ».
# Vu tomber : l'étape 6 a attrapé exactement ce cas.
#
# ⚠️ Signer **avant** de notariser, jamais après : signer changerait le fichier, donc son
# empreinte, donc invaliderait le ticket qu'on vient d'y agrafer.
codesign --force --sign "$identity" --timestamp "$dmg" \
  || fail 'le .dmg ne se signe pas — sans signature, Gatekeeper le refuse malgré la notarisation'

# ── 5. Notariser et agrafer le .dmg ────────────────────────────────────────────────────────────
step 'Notarisation du .dmg par Apple (2/2)'
xcrun notarytool submit "$dmg" --keychain-profile "$KEYCHAIN_PROFILE" --wait \
  || fail 'notarisation du .dmg refusée — « xcrun notarytool log <id> --keychain-profile mirmalion » dira pourquoi'
xcrun stapler staple "$dmg" || fail 'le ticket ne s’agrafe pas au .dmg'

# ── 6. Prouver le verdict, plutôt que l'espérer ────────────────────────────────────────────────
#
# ⚠️⚠️ **C'EST LA SEULE ÉTAPE QUI REGARDE LE RÉSULTAT AVEC LES YEUX DE GATEKEEPER.** Tout le reste
# du script décrit ce qu'on a voulu faire ; celle-ci dit ce que la machine du testeur décidera.
step 'Verdict de Gatekeeper'
xcrun stapler validate "$dmg" || fail 'ticket non agrafé au .dmg'
spctl --assess --type open --context context:primary-signature -vv "$dmg" 2>&1 | sed 's/^/  /'
spctl --assess --type open --context context:primary-signature "$dmg" \
  || fail 'le .dmg serait refusé chez le testeur'

# ⚠️⚠️ **LE CONTRÔLE QUI MANQUAIT.** Ce que le testeur lance n'est pas le `.dmg` mais le `.app`
# qu'il en a tiré. On le tire pour de bon, et on lui pose la quarantaine qu'AirDrop ou un
# navigateur lui poseraient — c'est la seule façon de voir ce que verra sa machine.
verdict_mount=$(hdiutil attach "$dmg" -nobrowse -readonly | grep -o '/Volumes/.*' | tail -1)
[[ -n "$verdict_mount" ]] || fail 'le .dmg final ne se monte pas'
xcrun stapler validate "${verdict_mount}/Mirmalion.app" || {
  hdiutil detach "$verdict_mount" -quiet || true
  fail 'le .app du .dmg n’est pas agrafé : un poste hors réseau le refuserait'
}
spctl --assess --type execute -vv "${verdict_mount}/Mirmalion.app" 2>&1 | sed 's/^/  /'
spctl --assess --type execute "${verdict_mount}/Mirmalion.app" || {
  hdiutil detach "$verdict_mount" -quiet || true
  fail 'le .app serait refusé au lancement chez le testeur'
}
hdiutil detach "$verdict_mount" -quiet

# ── 7. Écrire la version dans la page ──────────────────────────────────────────────────────────
step 'La page annonce la version'
node scripts/landing-version.mjs "$version" || fail 'la page ne se laisse pas réécrire'

# ── 8. Composer le manifeste ───────────────────────────────────────────────────────────────────
#
# ⚠️ La signature du manifeste est celle de l'ARCHIVE, produite par notre clé au moment du
# bundling — pas celle d'Apple. C'est elle que le plugin vérifie avant d'écrire sur le disque.
step 'Composition du manifeste'
# ⚠️⚠️ **LE `.dmg` NE MONTE PAS SUR LE SITE, ET CE N'EST PAS UN CHOIX** *(mesuré le 2026-08-11)* :
# le plan **gratuit** de Firebase refuse les fichiers exécutables, et le déploiement échoue en
# entier sur « Executable files are forbidden on the Spark billing plan ». ⚠️ **La liste
# documentée par Firebase est INCOMPLÈTE** — elle ne cite que `.exe`, `.dll`, `.bat`, `.apk` et
# `.ipa`, alors que le refus tombe aussi sur un `.dmg` : le contenu est inspecté, pas l'extension.
# ⚠️ **L'archive de mise à jour, elle, PASSE** (27 Mo de `.tar.gz` contenant pourtant les mêmes
# binaires) — c'est ce qui rend la configuration actuelle possible : les fichiers de mise à jour
# en ligne, le programme d'installation remis à la main. Le lever demanderait de passer au plan
# **Blaze**, dont les quotas gratuits couvriraient largement cet usage.
#
# ⚠️ La mise en ligne reflète `dist-web/` à l'identique : tout ce qui est en ligne et absent de ce
# dossier est retiré, dont les archives des versions précédentes que `latest.json` ne nomme plus.
rm -rf "$STAGING"
mkdir -p "${STAGING}/updates"
cp -R landing/. "$STAGING/"
cp "$archive" "${STAGING}/updates/Mirmalion_${version}.app.tar.gz"

node - "$version" "${archive}.sig" "$SITE" "${STAGING}/updates/latest.json" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [version, signaturePath, site, out] = process.argv.slice(2);
writeFileSync(
  out,
  JSON.stringify(
    {
      version,
      // ⚠️ Vide à dessein : ces notes s'afficheraient TELLES QUELLES dans une interface
      // localisée au build en neuf langues. La barre annonce un numéro de version, rien d'autre.
      notes: '',
      pub_date: new Date().toISOString(),
      platforms: {
        'darwin-aarch64': {
          signature: readFileSync(signaturePath, 'utf8').trim(),
          url: `${site}/updates/Mirmalion_${version}.app.tar.gz`,
        },
      },
    },
    null,
    2,
  ) + '\n',
);
NODE

printf '  manifeste en %s, archive de %s\n' "$version" "$(du -h "$archive" | cut -f1)"

# ── 9. Commettre la page, créer la release, mettre en ligne ────────────────────────────────────
#
# Dans cet ordre : le tag de la release se pose sur le commit qui porte la version dans la page,
# et Firebase n'annonce le bouton qu'une fois le `.dmg` réellement téléchargeable.
if [[ "$deploy" == false ]]; then
  step "Prêt, non publié (--no-deploy) — le site assemblé est dans ./${STAGING}"
  printf '  Les pages de ./landing annoncent la %s sur le disque.\n' "$version"
  printf '  Pour annuler cette réécriture : git checkout -- landing\n'
  exit 0
fi

step 'La page est commise et poussée'
git add landing
# ⚠️ Rien à commettre après un `--no-deploy` déjà commis à la main : `git commit` sortirait en
# erreur sous `set -e` et tuerait la publication après la compilation et les deux notarisations.
if git diff --cached --quiet -- landing; then
  printf '  la page annonçait déjà la %s, rien à commettre\n' "$version"
else
  git commit -q -m "release: la page annonce la ${version}" || fail 'le commit de la page a échoué'
fi
git push -q origin main || fail 'le push de main a échoué — la release n’a pas été créée, relancer avec --skip-build après avoir résolu'

step 'GitHub Release'
# ⚠️ `gh` nomme chaque pièce jointe d'après son fichier : l'archive et sa signature sont copiées
# sous leur nom versionné avant l'envoi, sans quoi deux versions porteraient le même nom.
readonly RELEASE_DIR="${BUNDLE}/release"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
cp "$dmg" "$RELEASE_DIR/"
cp "$archive" "${RELEASE_DIR}/Mirmalion_${version}.app.tar.gz"
cp "${archive}.sig" "${RELEASE_DIR}/Mirmalion_${version}.app.tar.gz.sig"
cp "${STAGING}/updates/latest.json" "${RELEASE_DIR}/latest.json"
gh release create "v${version}" --title "Mirmalion ${version}" --notes '' "$RELEASE_DIR"/* \
  || fail 'la release GitHub ne se crée pas'
curl -sfIL -o /dev/null "https://github.com/romsau/mirmalion/releases/download/v${version}/Mirmalion_${version}_aarch64.dmg" \
  || printf '  ⚠️ le .dmg ne répond pas sans authentification — normal tant que le dépôt est privé ; sinon, vérifier la pièce jointe sur la release\n'

step 'Mise en ligne sur Firebase'
npx -y firebase-tools deploy --only hosting \
  || fail "la mise en ligne Firebase a échoué après la création de la release v${version} — la supprimer avec « gh release delete v${version} --yes --cleanup-tag », puis relancer avec --skip-build"

step "Publié — ${SITE}"
printf '  Les postes déjà installés verront la %s à leur prochaine ouverture.\n' "$version"
printf '  Release : https://github.com/romsau/mirmalion/releases/tag/v%s\n' "$version"
printf '  Le programme d’installation, si on doit le remettre à la main :\n'
printf '    %s\n' "$dmg"
