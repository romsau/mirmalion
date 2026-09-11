//! La politique de journalisation, transformée en test.
//!
//! `println!` et consorts échappent au filtrage par niveau, écrivent en production, et ne
//! passent par aucune des règles de `src/logging.rs`. La consigne existe dans `CLAUDE.md` ;
//! ce fichier la rend **exécutable**, pour qu'elle ne repose pas sur la vigilance d'un
//! relecteur.
//!
//! Les motifs interdits sont **assemblés à l'exécution** : écrits en toutes lettres, ils
//! feraient échouer le test sur lui-même.

use std::{fs, path::Path};

/// Les fichiers Rust du crate, en dehors des artefacts de compilation.
fn rust_sources() -> Vec<(String, String)> {
  let mut files = Vec::new();
  collect(
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src").as_path(),
    &mut files,
  );
  assert!(!files.is_empty(), "aucune source Rust trouvée");
  files
}

fn collect(directory: &Path, files: &mut Vec<(String, String)>) {
  let entries = fs::read_dir(directory).expect("lecture du répertoire");
  for entry in entries.flatten() {
    let path = entry.path();
    if path.is_dir() {
      collect(&path, files);
    } else if path.extension().is_some_and(|extension| extension == "rs") {
      let content = fs::read_to_string(&path).expect("lecture du fichier");
      files.push((path.display().to_string(), content));
    }
  }
}

#[test]
fn no_rust_source_writes_straight_to_the_console() {
  let forbidden = [
    format!("print{}!", "ln"),
    format!("eprint{}!", "ln"),
    format!("db{}!", "g"),
  ];

  let offenders: Vec<String> = rust_sources()
    .into_iter()
    .filter(|(path, _)| !path.ends_with("logging_policy.rs"))
    .filter_map(|(path, content)| {
      forbidden
        .iter()
        .find(|needle| content.contains(needle.as_str()))
        .map(|needle| format!("{path} contient {needle}"))
    })
    .collect();

  assert!(
    offenders.is_empty(),
    "utiliser la façade `log`, jamais la console :\n{}",
    offenders.join("\n")
  );
}

#[test]
fn the_swift_bridge_does_not_print_either() {
  let bridge = Path::new(env!("CARGO_MANIFEST_DIR")).join("native/Sources/MirmalionNative");
  let mut offenders = Vec::new();

  for entry in fs::read_dir(&bridge)
    .expect("lecture du pont Swift")
    .flatten()
  {
    let path = entry.path();
    if path
      .extension()
      .is_some_and(|extension| extension == "swift")
    {
      let content = fs::read_to_string(&path).expect("lecture du fichier");
      // `print(` en début d'instruction : le pont renvoie ses messages par le paramètre de
      // sortie, il n'écrit jamais sur la sortie standard du processus hôte.
      if content.contains(&format!("{}(", "print")) {
        offenders.push(path.display().to_string());
      }
    }
  }

  assert!(
    offenders.is_empty(),
    "le pont Swift ne doit rien imprimer : {offenders:?}"
  );
}
