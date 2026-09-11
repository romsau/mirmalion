//! Ce que la passe `--release` est la seule à vérifier, et pourquoi on la garde.
//!
//! `verify:rust` lance `cargo test` **puis** `cargo test --release`. Lancer deux fois la même
//! suite a tout l'air d'un doublon à supprimer, et ce n'en est pas un : quatre tests portent
//! `#[cfg(not(debug_assertions))]` et n'existent tout simplement pas dans la passe de debug.
//!
//! Trois d'entre eux prouvent qu'une échappatoire de développement est **inerte dans le binaire
//! livré** — une variable d'environnement qui force l'overlay, une autre qui autorise des
//! surcharges de capacités, une troisième qui déclenche un téléchargement de traduction. Le
//! quatrième vérifie que `debug!` et `info!` sont retirés à la compilation.
//!
//! # Pièges
//!
//! - ⚠️ Retirer la passe `--release` de `verify:rust` ne fait échouer aucun test : elle en
//!   emporte quatre en silence, et l'inertie des échappatoires cesse d'être vérifiée.

use std::{fs, path::Path};

/// Les tests que seule la passe `--release` exécute, relevés dans les sources.
///
/// Le relevé est fait plutôt qu'écrit : une liste en dur survivrait à la disparition du dernier
/// d'entre eux, et annoncerait alors une protection qui n'existe plus.
fn release_only_tests() -> Vec<String> {
  let mut found = Vec::new();
  collect(
    &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
    &mut found,
  );
  found
}

fn collect(directory: &Path, found: &mut Vec<String>) {
  for entry in fs::read_dir(directory)
    .expect("lecture du répertoire des sources")
    .flatten()
  {
    let path = entry.path();
    if path.is_dir() {
      collect(&path, found);
      continue;
    }
    if !path.extension().is_some_and(|extension| extension == "rs") {
      continue;
    }
    let source = fs::read_to_string(&path).expect("lecture du fichier");
    let lines: Vec<&str> = source.lines().collect();
    for (index, line) in lines.iter().enumerate() {
      if !line.trim().starts_with("#[cfg(not(debug_assertions))]") {
        continue;
      }
      // ⚠️ La fenêtre est courte à dessein : `#[cfg]` suivi d'un `#[test]` puis d'une signature.
      // L'élargir attraperait des `#[cfg]` posés sur autre chose qu'un test.
      let window = &lines[index..lines.len().min(index + 4)];
      if !window.iter().any(|line| line.trim() == "#[test]") {
        continue;
      }
      if let Some(name) = window
        .iter()
        .find_map(|line| line.trim().strip_prefix("fn "))
        .and_then(|rest| rest.split('(').next())
      {
        found.push(name.to_owned());
      }
    }
  }
}

#[test]
fn some_tests_only_exist_in_a_release_build() {
  let found = release_only_tests();
  assert!(
    !found.is_empty(),
    "plus aucun test `#[cfg(not(debug_assertions))]` : la passe `--release` de `verify:rust` \
     ne vérifie plus rien de propre, et peut être retirée en connaissance de cause"
  );
}

/// ⚠️ Le garde-fou de la passe supprimée. Retirer `cargo test --release` de `verify:rust` est
/// indolore — aucun test ne tombe, et l'inertie des échappatoires de développement cesse
/// simplement d'être vérifiée. Ce test est le seul endroit d'où la suppression se voit.
#[test]
fn the_verification_chain_still_runs_the_release_pass() {
  let manifest = fs::read_to_string(
    Path::new(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .expect("le crate vit sous la racine du dépôt")
      .join("package.json"),
  )
  .expect("package.json doit être lisible");

  let scripts: serde_json::Value = serde_json::from_str(&manifest).expect("du JSON valide");
  let rust = scripts["scripts"]["verify:rust"]
    .as_str()
    .expect("« verify:rust » doit exister");

  assert!(
    rust.contains("cargo test") && rust.contains("--release"),
    "« verify:rust » ne lance plus la passe release, qui porte {} tests à elle seule : {rust}",
    release_only_tests().len()
  );
}
