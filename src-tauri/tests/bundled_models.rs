//! **Les modèles de diarisation sont-ils réellement embarqués ?**
//!
//! ⚠️ Le défaut gardé ici est invisible sur la machine qui le produit. FluidAudio range ce
//! qu'il a téléchargé dans `~/Library/Application Support/FluidAudio/`, et `Diarization.swift`
//! s'y replie quand le bundle ne porte rien — c'est ce repli qui fait marcher `tauri dev`. Sur
//! le poste du développeur, une diarisation réussit donc pareil, modèles embarqués ou non ; le
//! seul poste où la différence se voit est celui de l'utilisateur, et il est trop tard.
//!
//! Ce que ce fichier vérifie : les deux modèles sont dans le dépôt, **et** déclarés dans
//! `bundle.resources` à l'endroit exact où le Swift les cherche.
//!
//! Ce qu'il ne prouve pas : qu'un `.app` construit les contient — seul un build le dirait, et
//! il prendrait des minutes à chaque `npm run verify`.

use std::{fs, path::Path, path::PathBuf};

/// Les deux modèles, **nommés comme `Diarization.swift` les nomme**. Un renommage d'un côté sans
/// l'autre est précisément ce qu'on veut faire échouer ici.
const MODELS: [&str; 2] = ["pyannote_segmentation", "wespeaker_v2"];

/// Le dossier de destination dans le `.app`, relatif à `Contents/Resources/`.
///
/// ⚠️ **Il est écrit deux fois dans le projet** — ici et dans `modelLocations()`, côté Swift —
/// parce qu'un `const` Rust ne traverse pas la frontière du langage. C'est ce test qui tient les
/// deux copies ensemble.
const RESOURCE_DIRECTORY: &str = "DiarizerModels";

fn crate_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn config() -> serde_json::Value {
  let path = crate_root().join("tauri.conf.json");
  let text = fs::read_to_string(&path).expect("tauri.conf.json doit être lisible");
  serde_json::from_str(&text).expect("tauri.conf.json doit être du JSON valide")
}

/// Le dossier source déclaré pour `DiarizerModels/`, tel que la configuration l'annonce.
fn declared_source() -> String {
  let config = config();
  let resources = config["bundle"]["resources"]
    .as_object()
    .expect("bundle.resources doit être une table source → destination");

  resources
    .iter()
    .find(|(_, destination)| {
      destination
        .as_str()
        .is_some_and(|destination| destination.trim_end_matches('/') == RESOURCE_DIRECTORY)
    })
    .map(|(source, _)| source.clone())
    .unwrap_or_else(|| {
      panic!(
        "aucune ressource n'est copiée vers « {RESOURCE_DIRECTORY}/ » : \
         les modèles de diarisation ne seraient pas dans le .app, et l'application \
         se replierait sur un cache qui n'existe que sur les machines de développement"
      )
    })
}

/// ⚠️ **Un `.mlmodelc` est un DOSSIER, pas un fichier.** Un `exists()` sur son chemin serait vrai
/// pour un dossier vide — c'est-à-dire pour un modèle qu'un `git clone` incomplet aurait laissé en
/// coquille. On exige donc les deux fichiers sans lesquels CoreML refuse de charger.
fn assert_is_a_compiled_model(directory: &Path) {
  assert!(
    directory.is_dir(),
    "{} doit être un dossier .mlmodelc",
    directory.display()
  );
  for part in ["coremldata.bin", "weights/weight.bin"] {
    let file = directory.join(part);
    assert!(
      file.is_file(),
      "{} manque : le modèle est une coquille, CoreML refuserait de le charger",
      file.display()
    );
    assert!(
      fs::metadata(&file).expect("métadonnées").len() > 0,
      "{} est vide",
      file.display()
    );
  }
}

#[test]
fn the_two_diarization_models_are_in_the_repository_and_bundled() {
  let source = crate_root().join(declared_source().trim_end_matches('/'));
  assert!(
    source.is_dir(),
    "{} est déclaré dans bundle.resources mais absent du dépôt",
    source.display()
  );

  for model in MODELS {
    assert_is_a_compiled_model(&source.join(format!("{model}.mlmodelc")));
  }
}

/// ⚠️ **Les poids voyagent sous CC-BY-4.0, qui exige une attribution.** Redistribuer les fichiers
/// sans le crédit ne remplit pas la licence — et un crédit qui cesse d'être embarqué ne se verrait
/// que dans le `.app` distribué, où personne ne le cherche.
#[test]
fn the_weights_never_travel_without_their_credit() {
  let config = config();
  let credits = config["bundle"]["resources"]["../CREDITS.md"]
    .as_str()
    .expect("CREDITS.md doit être déclaré dans bundle.resources");
  assert_eq!(credits.trim_end_matches('/'), "CREDITS.md");

  let path = crate_root().join("../CREDITS.md");
  let text = fs::read_to_string(&path).expect("CREDITS.md doit être lisible");
  for required in ["pyannote", "CC-BY-4.0", "FluidInference"] {
    assert!(
      text.contains(required),
      "CREDITS.md ne nomme pas « {required} » : l'attribution que CC-BY-4.0 exige est incomplète"
    );
  }
}

/// ⚠️ **Le bundler copie le dossier tel quel, y compris ce que le Finder y dépose.** Un
/// `.DS_Store` ouvert une fois dans le Finder est parti dans les `Resources` de l'application
/// distribuée — invisible, inutile, et signé avec le reste. `.gitignore` ne protège pas de cela :
/// le fichier n'a pas besoin d'être versionné pour être embarqué, il lui suffit d'être là.
#[test]
fn nothing_but_the_models_travels_in_the_bundle() {
  let source = crate_root().join(declared_source().trim_end_matches('/'));
  let expected: Vec<String> = MODELS
    .iter()
    .map(|model| format!("{model}.mlmodelc"))
    .collect();

  let mut found: Vec<String> = fs::read_dir(&source)
    .expect("le dossier des modèles doit être lisible")
    .map(|entry| entry.expect("entrée illisible").file_name())
    .map(|name| name.to_string_lossy().into_owned())
    .collect();
  found.sort();

  let strays: Vec<&String> = found
    .iter()
    .filter(|name| !expected.contains(name))
    .collect();
  assert!(
    strays.is_empty(),
    "{} porte des fichiers qui partiraient dans le .app : {strays:?}",
    source.display()
  );
}

/// ⚠️ **Le nom cherché par Swift est la vraie spécification.** Embarquer les bons octets sous un
/// autre nom donnerait un `.app` complet et une diarisation qui échoue : le repli sur le cache ne
/// rattraperait rien chez l'utilisateur, qui n'en a pas.
#[test]
fn the_bundled_names_are_the_ones_the_swift_bridge_looks_for() {
  let swift =
    fs::read_to_string(crate_root().join("native/Sources/MirmalionNative/Diarization.swift"))
      .expect("Diarization.swift doit être lisible");

  for model in MODELS {
    assert!(
      swift.contains(model),
      "« {model} » n'apparaît plus dans Diarization.swift : \
       le pont et le bundle ont divergé"
    );
  }
  assert!(
    swift.contains(RESOURCE_DIRECTORY),
    "« {RESOURCE_DIRECTORY} » n'apparaît plus dans Diarization.swift : \
     le dossier embarqué n'est plus celui que le pont ouvre"
  );
}
