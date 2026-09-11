//! Compile la bibliothèque Swift `native/` avant le crate Rust, et pose les options
//! d'édition de liens sans lesquelles rien ne se lie ni ne se charge.
//!
//! Les deux réglages critiques (mesurés au spike, puis reperdus une fois — ne pas y toucher) :
//!
//! 1. Côté Swift, `-install_name @rpath/libMirmalionNative.dylib` (voir `native/Package.swift`).
//! 2. Ici, `-Wl,-rpath,…` **et** `/usr/lib/swift` dans les rpath — sans quoi la runtime
//!    Swift n'est pas trouvée à l'exécution.
//!
//! # Pièges
//!
//! - ⚠️ On panique ici, et c'est voulu : l'interdiction posée dans `src/lib.rs` vise le code qui
//!   tourne chez l'utilisateur, où une panique ferme l'application sans un mot. Ici il n'y a ni
//!   utilisateur ni appelant à qui rendre un `Result` — un script de build qui ne sait pas
//!   produire la `.dylib` doit **arrêter la compilation**, et la panique est le seul moyen de le
//!   faire. La retirer rendrait l'échec silencieux, pas absent.

use std::{
  env, fs,
  path::{Path, PathBuf},
  process::Command,
};

/// Le nom du produit `.dynamic` déclaré dans `native/Package.swift`.
const SWIFT_LIBRARY: &str = "MirmalionNative";
const DYLIB_FILE: &str = "libMirmalionNative.dylib";

fn main() {
  if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    build_swift_bridge();
  }
  tauri_build::build()
}

fn build_swift_bridge() {
  let manifest_dir = PathBuf::from(
    env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR est toujours défini par cargo"),
  );
  let package_dir = manifest_dir.join("native");
  // Sous `target/`, et pas dans `native/` : le watcher de `tauri dev` surveille tout
  // `src-tauri/` sauf `target/`. Une sortie de compilation posée ailleurs déclenche une
  // reconstruction, qui réécrit la sortie, qui déclenche une reconstruction — sans fin.
  let swift_dir = manifest_dir.join("target").join("swift");
  let scratch_dir = swift_dir.join("build");
  let dist_dir = swift_dir.join("dist");

  println!("cargo:rerun-if-changed=native/Package.swift");
  println!("cargo:rerun-if-changed=native/Sources");

  // Toujours en `release` : le pont n'a pas de code à déboguer pas à pas, et cela garde
  // un chemin de sortie unique quel que soit le profil Cargo.
  let scratch = scratch_dir.display().to_string();
  let swift_args = ["build", "-c", "release", "--scratch-path", &scratch];
  run_swift(&swift_args, &package_dir);
  let bin_dir = swift_bin_path(&package_dir, &scratch);

  // Copie vers un emplacement stable : `build.rs` connaît le chemin de scratch de SwiftPM,
  // `tauri.conf.json` — qui embarque la .dylib dans le bundle — ne peut pas le deviner.
  fs::create_dir_all(&dist_dir).expect("création de target/swift/dist");
  fs::copy(bin_dir.join(DYLIB_FILE), dist_dir.join(DYLIB_FILE))
    .unwrap_or_else(|error| panic!("copie de {DYLIB_FILE} depuis {bin_dir:?} : {error}"));
  sign_dylib(&dist_dir.join(DYLIB_FILE), &manifest_dir);

  // Une seconde copie, à l'endroit exact où `@executable_path/../Frameworks` la cherche depuis
  // `target/<profil>/deps/` — c'est là que vivent tous les exécutables de test.
  //
  // ⚠️ Sans elle, il faudrait poser le chemin absolu de `dist` en rpath sur toutes les cibles,
  // et il finirait dans le binaire livré. La copie déplace le problème là où il ne coûte rien :
  // le rpath qui la trouve est celui du bundle, déjà posé, et identique chez l'utilisateur.
  //
  // ⚠️ Le répertoire se déduit d'`OUT_DIR` et non de `<manifest>/target/<profil>` : cargo n'écrit
  // pas toujours là. `CARGO_TARGET_DIR`, une compilation croisée — qui insère le triplet — et
  // `cargo llvm-cov`, qui compile dans un répertoire à lui, aboutissent tous ailleurs, et le
  // symptôme est un `Library not loaded` au lancement du premier test.
  let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR est toujours défini par cargo"));
  let test_frameworks = out_dir
    .ancestors()
    .nth(3)
    .expect("OUT_DIR est <cible>/<profil>/build/<paquet>/out")
    .join("Frameworks");
  fs::create_dir_all(&test_frameworks).expect("création de target/<profil>/Frameworks");
  fs::copy(dist_dir.join(DYLIB_FILE), test_frameworks.join(DYLIB_FILE))
    .unwrap_or_else(|error| panic!("copie de {DYLIB_FILE} vers {test_frameworks:?} : {error}"));

  println!("cargo:rustc-link-search=native={}", dist_dir.display());
  println!("cargo:rustc-link-lib=dylib={SWIFT_LIBRARY}");

  // Pas de `-rpath @executable_path/../Frameworks` ici : `tauri_build::build()` le pose
  // déjà, dès lors que `bundle.macOS.frameworks` est renseigné dans `tauri.conf.json`.
  // L'ajouter une seconde fois donne `ld: duplicate -rpath … ignored`.
  //
  // La runtime Swift, elle, n'est à personne d'autre, et il la faut sur **toutes** les
  // cibles. Sans ce rpath, le chargement échoue.
  println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

  // `tauri dev` lance le binaire nu, depuis `target/debug/` : le rpath du bundle y désigne
  // `target/Frameworks`, où rien n'est posé. Seul ce binaire-là a besoin du chemin réel.
  //
  // ⚠️ **Jamais sur le binaire de production**, et ce n'est pas qu'une question de propreté :
  // ce chemin n'existe que sur la machine de compilation, mais dyld l'essaie **avant**
  // `@executable_path/../Frameworks`. Le `.app` construit ici chargerait donc la `.dylib` de
  // `target/`, et non celle qu'il transporte — la seule que l'utilisateur aura. Un bundle dont
  // la bibliothèque est absente ou périmée passerait pour bon, sur cette machine seulement.
  if env::var("PROFILE").as_deref() == Ok("debug") {
    println!(
      "cargo:rustc-link-arg-bins=-Wl,-rpath,{}",
      dist_dir.display()
    );
  }
}

/// Signe la `.dylib` avec la même identité que les binaires — **sans quoi ils se font tuer**.
///
/// ⚠️ **Symptôme : `signal: 9, SIGKILL` sans une ligne de sortie**, sur `cargo test` comme sur
/// `tauri dev`, et à chaque recompilation du Swift. SwiftPM produit une bibliothèque signée
/// *ad hoc* (`linker-signed`) ; le binaire qui la charge, lui, est signé Developer ID par
/// `scripts/sign-and-run.sh`. macOS refuse l'attelage et tue le processus au chargement, avant
/// qu'il n'ait pu écrire quoi que ce soit — d'où l'absence de message.
///
/// **L'échec n'est pas fatal** : sans certificat sur la machine, la compilation doit rester
/// possible. C'est le lancement qui échouera, avec le message de `sign-and-run.sh`.
fn sign_dylib(dylib: &Path, manifest_dir: &Path) {
  let Some(identity) = signing_identity(manifest_dir) else {
    return;
  };
  let _ = Command::new("codesign")
    .args(["--force", "--sign", &identity])
    .arg(dylib)
    .status();
}

/// L'identité de signature, lue là où elle est déjà déclarée — jamais recopiée.
fn signing_identity(manifest_dir: &Path) -> Option<String> {
  if let Ok(identity) = env::var("MIRMALION_SIGNING_IDENTITY") {
    return Some(identity);
  }
  let raw = fs::read_to_string(manifest_dir.join("tauri.conf.json")).ok()?;
  let config: serde_json::Value = serde_json::from_str(&raw).ok()?;
  config
    .get("bundle")?
    .get("macOS")?
    .get("signingIdentity")?
    .as_str()
    .map(str::to_owned)
}

fn run_swift(args: &[&str], package_dir: &PathBuf) {
  let status = Command::new("swift")
    .args(args)
    .current_dir(package_dir)
    .status()
    .expect("`swift` est introuvable — installer les outils en ligne de commande Xcode");
  assert!(status.success(), "`swift {}` a échoué", args.join(" "));
}

fn swift_bin_path(package_dir: &PathBuf, scratch: &str) -> PathBuf {
  let output = Command::new("swift")
    .args([
      "build",
      "-c",
      "release",
      "--scratch-path",
      scratch,
      "--show-bin-path",
    ])
    .current_dir(package_dir)
    .output()
    .expect("`swift build --show-bin-path`");
  assert!(
    output.status.success(),
    "`swift build --show-bin-path` a échoué"
  );
  PathBuf::from(
    String::from_utf8(output.stdout)
      .expect("chemin non UTF-8")
      .trim(),
  )
}
