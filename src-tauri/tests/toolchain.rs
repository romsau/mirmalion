//! Ce que `rust-toolchain.toml` doit déclarer pour que `npm run verify` aille jusqu'au bout.
//!
//! Trois commandes de la chaîne de vérification ne sont pas dans le compilateur : `cargo fmt`,
//! `cargo clippy` et `cargo llvm-cov` passent par un composant rustup. Déclarés dans
//! `rust-toolchain.toml`, ils s'installent d'eux-mêmes à la première commande cargo ; absents,
//! ils manquent silencieusement jusqu'à ce qu'une machine neuve les réclame.
//!
//! # Pièges
//!
//! - ⚠️ Retirer un composant ne casse rien sur une machine qui l'a déjà : le manque ne se voit
//!   qu'ailleurs, et longtemps après. Ce test est le seul endroit d'où il se voit tout de suite.

use std::{fs, path::Path};

/// La commande de vérification, et le composant rustup sans lequel elle n'existe pas.
const NEEDED: [(&str, &str); 3] = [
  ("cargo fmt", "rustfmt"),
  ("cargo clippy", "clippy"),
  ("cargo llvm-cov", "llvm-tools-preview"),
];

fn repository_root() -> &'static Path {
  Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("le crate vit sous la racine du dépôt")
}

/// Les lignes de déclaration, commentaires écartés.
///
/// ⚠️ Chercher dans le fichier entier ne prouve rien : l'en-tête nomme les composants qu'il
/// déclare, si bien qu'un composant retiré de la liste s'y trouve encore.
fn declarations() -> String {
  let raw = fs::read_to_string(repository_root().join("rust-toolchain.toml"))
    .expect("rust-toolchain.toml doit exister");
  raw
    .lines()
    .filter(|line| !line.trim_start().starts_with('#'))
    .collect::<Vec<_>>()
    .join("\n")
}

#[test]
fn every_component_the_verification_chain_uses_is_declared() {
  let toolchain = declarations();
  let scripts =
    fs::read_to_string(repository_root().join("package.json")).expect("package.json doit exister");
  let scripts: serde_json::Value = serde_json::from_str(&scripts).expect("du JSON valide");
  let scripts = scripts["scripts"].to_string();

  for (command, component) in NEEDED {
    if !scripts.contains(command) {
      continue;
    }
    assert!(
      toolchain.contains(component),
      "« {command} » est dans la chaîne de vérification, mais « {component} » n'est pas déclaré \
       dans rust-toolchain.toml : la commande manquera sur une machine neuve"
    );
  }
}

/// ⚠️ Le canal se déclare, faute de quoi rustup prend le défaut de la machine et deux postes
/// peuvent compiler ce crate avec deux compilateurs différents.
#[test]
fn the_channel_is_pinned_rather_than_left_to_the_machine() {
  assert!(
    declarations().contains("channel"),
    "rust-toolchain.toml ne déclare aucun canal"
  );
}
