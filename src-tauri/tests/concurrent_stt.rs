//! **Deux transcriptions à la fois : est-ce que le moteur d'Apple le supporte ?**
//!
//! Une session produit deux flux qui ne se rejoignent jamais — le système et le micro (voir
//! l'en-tête de `SystemAudioTap.swift`). Les transcrire séparément, donc en même temps, est la
//! seule façon d'obtenir un transcript où « Moi » est certain, et rien dans la documentation
//! d'Apple ne dit si deux `SpeechAnalyzer` peuvent coexister dans un processus. S'ils ne le
//! peuvent pas, un seul flux passe en direct et l'autre attend la finalisation.
//!
//! ⚠️ « Ça n'a pas planté » ne prouve rien : deux moteurs qui se marchent dessus rendent du
//! texte appauvri sans lever la moindre erreur, mode d'échec habituel de ce moteur. Chaque
//! média est donc transcrit seul, puis en concurrence, et les deux sorties sont comparées.
//!
//! ⚠️ Les médias vivent hors du dépôt (`~/dev/mirmalion/media-test/`), d'où le `#[ignore]` :
//! `cargo test --test concurrent_stt -- --ignored --nocapture`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

/// Les deux plus courts médias du corpus — la mesure en demande quatre transcriptions.
fn two_shortest_media() -> Vec<PathBuf> {
  let mut found: Vec<(u64, PathBuf)> = std::fs::read_dir(
    PathBuf::from(std::env::var("HOME").expect("HOME"))
      .join("dev")
      .join("mirmalion")
      .join("media-test"),
  )
  .into_iter()
  .flatten()
  .filter_map(|entry| entry.ok())
  .map(|entry| entry.path())
  .filter(|path| {
    path.is_file()
      && !path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with('.'))
  })
  .map(|path| {
    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    (size, path)
  })
  .collect();
  found.sort();
  found.into_iter().take(2).map(|(_, path)| path).collect()
}

/// Transcrit un média et rend son texte, mot à mot recollé.
fn transcribe(path: &std::path::Path) -> String {
  let json = app_lib::measure::file_transcribe(&path.to_string_lossy(), "fr", &mut |_| true)
    .expect("la transcription doit aboutir");
  let words: Vec<app_lib::measure::Word> = serde_json::from_str::<serde_json::Value>(&json)
    .ok()
    .and_then(|value| serde_json::from_value(value["words"].clone()).ok())
    .unwrap_or_default();
  words
    .into_iter()
    .map(|word| word.text)
    .collect::<Vec<_>>()
    .join(" ")
}

/// Une étiquette courte pour le rapport — jamais le chemin complet.
fn label(path: &std::path::Path) -> String {
  path
    .file_stem()
    .map(|stem| stem.to_string_lossy().chars().take(24).collect())
    .unwrap_or_default()
}

#[test]
#[ignore = "transcrit deux médias réels deux fois chacun — plusieurs minutes, se lance à la main"]
fn two_transcriptions_at_once_do_not_degrade_each_other() {
  let media = two_shortest_media();
  assert_eq!(
    media.len(),
    2,
    "il faut deux médias dans ~/dev/mirmalion/media-test/ pour mesurer la concurrence"
  );

  println!("\n── Deux SpeechAnalyzer à la fois ──");
  println!("  média A : {}", label(&media[0]));
  println!("  média B : {}\n", label(&media[1]));

  println!("  seul…");
  let solo_start = Instant::now();
  let solo_a = transcribe(&media[0]);
  let solo_b = transcribe(&media[1]);
  let solo = solo_start.elapsed().as_secs_f64();
  println!("    A : {:>6} caractères", solo_a.chars().count());
  println!("    B : {:>6} caractères", solo_b.chars().count());
  println!("    total {solo:.1} s\n");

  assert!(
    !solo_a.is_empty() && !solo_b.is_empty(),
    "la mesure ne vaut rien si le moteur ne transcrit déjà rien tout seul"
  );

  println!("  ensemble…");
  let together_start = Instant::now();
  let first = Arc::new(media[0].clone());
  let handle = std::thread::spawn({
    let first = Arc::clone(&first);
    move || transcribe(&first)
  });
  let both_b = transcribe(&media[1]);
  let both_a = handle.join().expect("le second fil ne doit pas paniquer");
  let together = together_start.elapsed().as_secs_f64();

  println!("    A : {:>6} caractères", both_a.chars().count());
  println!("    B : {:>6} caractères", both_b.chars().count());
  println!("    total {together:.1} s");

  // ⚠️ **Le gain de temps n'est PAS ce qu'on mesure**, il n'est qu'un indice : deux moteurs
  // qui se sérialiseraient en interne mettraient le même temps qu'en solo tout en rendant le
  // bon texte. Ce serait un résultat acceptable pour la session — ce qu'on refuse, c'est le
  // texte perdu.
  println!(
    "    parallélisme : {:.0} % du temps séquentiel\n",
    together / solo * 100.0
  );

  println!("── Verdict ──");
  for (name, solo, both) in [("A", &solo_a, &both_a), ("B", &solo_b, &both_b)] {
    let identical = solo == both;
    let ratio = both.chars().count() as f64 / solo.chars().count().max(1) as f64;
    println!(
      "  {name} : {} · {:.1} % du texte solo",
      if identical {
        "identique au solo"
      } else {
        "DIFFÉRENT du solo"
      },
      ratio * 100.0
    );
    assert!(
      !both.is_empty(),
      "le média {name} n'a rien rendu en concurrence : les deux moteurs ne coexistent pas"
    );
    // ⚠️ **On n'exige pas l'identité stricte.** Le moteur est génératif : deux passes sur le
    // même audio peuvent différer d'un mot, et un test qui exigerait l'égalité mentirait sur
    // ce qu'il éprouve. Ce qui doit tenir est qu'aucun des deux ne **perd** de contenu — la
    // dégradation qu'on redoute se compterait en dizaines de pour cent, pas en un mot.
    assert!(
      ratio > 0.9,
      "le média {name} a rendu {:.0} % de son texte solo en concurrence : les deux moteurs se \
       gênent",
      ratio * 100.0
    );
  }
}
