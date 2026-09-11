//! L'inspection d'un média, éprouvée sur un **vrai fichier**.
//!
//! ⚠️ **`#[ignore]` par défaut** : ces mesures ouvrent les médias de
//! `~/dev/mirmalion/media-test/`, hors dépôt. Le parcours complet, à rejouer après tout
//! changement du pipeline : `cargo test --test media_inspection -- --ignored --nocapture
//! --test-threads=1 corpus`
//!
//! ⚠️ **`--test-threads=1` n'est pas décoratif** : deux mesures natives simultanées se disputent
//! l'ANE, ce qui fausse tous les temps, et la mémoire résidente est une grandeur **du processus**
//! — deux médias en vol dedans, et le chiffre ne désigne plus personne.
//!
//! ⚠️ **La langue déclarée par la piste audio ment** : quatre médias annoncent `soun(eng)`, dont
//! deux entretiens français. Inerte tant que la détection lit le **texte** ; « optimiser » en
//! lisant la langue du conteneur transcrirait une interview française en anglais.
//!
//! Le corpus se parcourt depuis le dossier ; ce qu'il ne couvre pas est dans `reste-a-faire.md`.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Le dossier des médias de mesure, hors dépôt.
fn media_dir() -> PathBuf {
  PathBuf::from(std::env::var("HOME").expect("HOME"))
    .join("dev")
    .join("mirmalion")
    .join("media-test")
}

/// Tous les médias du dossier, triés — l'ordre importe peu, mais il doit être **stable**
/// d'une exécution à l'autre pour qu'on puisse comparer deux rapports ligne à ligne.
fn all_media() -> Vec<PathBuf> {
  let mut found: Vec<PathBuf> = std::fs::read_dir(media_dir())
    .into_iter()
    .flatten()
    .filter_map(|entry| entry.ok())
    .map(|entry| entry.path())
    .filter(|path| {
      path.is_file()
        && !path
          .file_name()
          .is_some_and(|n| n.to_string_lossy().starts_with('.'))
    })
    .collect();
  found.sort();
  found
}

/// Une étiquette courte et lisible pour la colonne de gauche du tableau.
/// ⚠️ **Le rembourrage se compte en COLONNES DE TERMINAL, pas en `char`.** Un titre peut porter
/// un glyphe large — emoji, ponctuation pleine chasse — qui occupe deux colonnes là où `{:<28}`
/// n'en compte qu'une, et décale toute sa ligne. Un tableau désaligné ne se lit pas.
fn label(path: &std::path::Path) -> String {
  let name = path
    .file_stem()
    .map(|stem| stem.to_string_lossy().to_string())
    .unwrap_or_default();
  let width = |glyph: char| if glyph as u32 >= 0x1100 { 2 } else { 1 };
  let mut short = String::new();
  let mut columns = 0_usize;
  for glyph in name.chars() {
    if columns + width(glyph) > 28 {
      break;
    }
    columns += width(glyph);
    short.push(glyph);
  }
  format!("{short}{}", " ".repeat(28 - columns))
}

/// La mémoire résidente du processus de test, en mébioctets.
///
/// ⚠️ **On mesure le processus, pas la brique.** Le pont Swift alloue dans le même espace
/// d'adressage que Rust : l'occupation de la diarisation est **additionnée** à ce que le binaire
/// de test tient déjà. Le chiffre qui vaut quelque chose est l'**écart** repos → pic.
///
/// ⚠️ **La source est `ps`, et c'est un choix** : `getrusage` rendrait un pic depuis le démarrage
/// du processus, contaminé par le média précédent et jamais redescendu. On échantillonne, d'où un
/// angle mort — une pointe plus brève que la période passerait inaperçue.
fn resident_mib() -> f64 {
  let pid = std::process::id();
  let output = std::process::Command::new("ps")
    .args(["-o", "rss=", "-p", &pid.to_string()])
    .output();
  match output {
    Ok(output) => String::from_utf8_lossy(&output.stdout)
      .trim()
      .parse::<f64>()
      .map(|kib| kib / 1024.0)
      .unwrap_or(0.0),
    Err(_) => 0.0,
  }
}

/// Un échantillonneur de mémoire résidente, à démarrer avant une phase et à arrêter après.
struct RssProbe {
  stop: Arc<AtomicBool>,
  peak_kib: Arc<AtomicU64>,
  worker: Option<std::thread::JoinHandle<()>>,
  baseline: f64,
}

impl RssProbe {
  /// Démarre l'échantillonnage. La période est courte devant les phases mesurées, qui se
  /// comptent en secondes.
  fn start() -> Self {
    let stop = Arc::new(AtomicBool::new(false));
    let peak_kib = Arc::new(AtomicU64::new(0));
    let baseline = resident_mib();
    let worker = {
      let stop = Arc::clone(&stop);
      let peak_kib = Arc::clone(&peak_kib);
      std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
          #[expect(
            clippy::cast_possible_truncation,
            reason = "une occupation mémoire en kio tient très largement dans un u64"
          )]
          let current = resident_mib().mul_add(1024.0, 0.5).max(0.0) as u64;
          peak_kib.fetch_max(current, Ordering::Relaxed);
          std::thread::sleep(std::time::Duration::from_millis(50));
        }
      })
    };
    Self {
      stop,
      peak_kib,
      worker: Some(worker),
      baseline,
    }
  }

  /// Arrête l'échantillonnage et rend `(repos, pic, écart)` en mébioctets.
  fn finish(mut self) -> (f64, f64, f64) {
    self.stop.store(true, Ordering::Relaxed);
    if let Some(worker) = self.worker.take() {
      let _ = worker.join();
    }
    let peak = self.peak_kib.load(Ordering::Relaxed) as f64 / 1024.0;
    (self.baseline, peak, peak - self.baseline)
  }
}

/// Le premier média du dossier, quel que soit son nom.
fn some_media() -> Option<PathBuf> {
  let mut found: Vec<PathBuf> = std::fs::read_dir(media_dir())
    .ok()?
    .filter_map(|entry| entry.ok())
    .map(|entry| entry.path())
    .filter(|path| {
      path.is_file()
        && !path
          .file_name()
          .is_some_and(|n| n.to_string_lossy().starts_with('.'))
    })
    .collect();
  found.sort();
  found.into_iter().next()
}

#[test]
#[ignore = "ouvre un média réel, hors dépôt"]
fn a_real_media_is_opened_and_measured() {
  let Some(path) = some_media() else {
    panic!("aucun média dans {}", media_dir().display());
  };
  println!("média   : {}", path.display());

  let json = app_lib::measure::media_inspect(&path.to_string_lossy()).expect("inspection");
  println!("verdict : {json}");

  // ⚠️ **Un média accepté n'a PAS de champ `problem` du tout.** `JSONEncoder` omet les
  // optionnels nuls : le pont écrit `{"durationMs":…}` et non `{"problem":null,…}`. Côté
  // Rust, `Option<String>` accepte un champ absent — c'est le comportement par défaut de
  // serde — donc rien à corriger là-bas ; mais une mesure qui chercherait `"problem":null`
  // échouerait sur un média parfaitement valide. Elle l'a fait une fois.
  assert!(
    !json.contains("\"problem\""),
    "le média de référence doit être accepté — reçu {json}"
  );
  assert!(
    json.contains("\"hasAudio\":true"),
    "il doit porter une piste audio — reçu {json}"
  );
}

#[test]
#[ignore = "ouvre un média réel, hors dépôt"]
fn a_file_that_is_not_a_media_is_refused_rather_than_crashing() {
  // ⚠️ Le cas qui compte : un fichier **texte** renommé en `.mp3`. C'est ce qu'attrape la
  // validation par le contenu, et ce qu'une validation par l'extension laisserait passer
  // jusqu'au milieu de la transcription.
  let fake = std::env::temp_dir().join("mirmalion-pas-un-media.mp3");
  std::fs::write(&fake, b"ceci n'est pas un media").expect("écriture");

  let json = app_lib::measure::media_inspect(&fake.to_string_lossy()).expect("inspection");
  println!("verdict : {json}");
  let _ = std::fs::remove_file(&fake);

  assert!(
    json.contains("\"problem\":\"unreadable\""),
    "un texte renommé en .mp3 doit être refusé — reçu {json}"
  );
}

#[test]
#[ignore = "ouvre un média réel, hors dépôt"]
fn an_empty_file_is_refused_as_empty_and_not_as_unreadable() {
  // Deux refus distincts, parce que l'utilisateur n'a pas la même chose à faire dans les
  // deux cas.
  let empty = std::env::temp_dir().join("mirmalion-vide.wav");
  std::fs::write(&empty, b"").expect("écriture");

  let json = app_lib::measure::media_inspect(&empty.to_string_lossy()).expect("inspection");
  println!("verdict : {json}");
  let _ = std::fs::remove_file(&empty);

  assert!(
    json.contains("\"problem\":\"empty\""),
    "un fichier vide a son propre motif — reçu {json}"
  );
}

#[test]
#[ignore = "transcrit un média réel, hors dépôt — plusieurs minutes"]
fn a_real_media_is_transcribed_into_timed_words() {
  // ⚠️ **LA MESURE QUI DÉCIDE DE TOUTE LA PHASE.** Si les mots ne sortent pas horodatés, ni la
  // diarisation ni les sous-titres n'existent — et l'alignement au mot n'aurait rien à aligner.
  let Some(path) = some_media() else {
    panic!("aucun média dans {}", media_dir().display());
  };
  println!("média : {}", path.display());

  let started = std::time::Instant::now();
  let mut steps = 0_u32;
  let mut last = 0.0_f64;
  let json = app_lib::measure::file_transcribe(&path.to_string_lossy(), "fr", &mut |ratio| {
    steps += 1;
    assert!(
      ratio >= last - f64::EPSILON,
      "la progression ne doit jamais reculer : {last} puis {ratio}"
    );
    assert!(
      (0.0..=1.0).contains(&ratio),
      "progression hors bornes : {ratio}"
    );
    last = ratio;
    true
  })
  .expect("transcription");
  let elapsed = started.elapsed();

  let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
  let words = parsed["words"].as_array().expect("mots").clone();

  println!("durée média : {} ms", parsed["durationMs"]);
  println!("temps passé : {:.1} s", elapsed.as_secs_f64());
  println!("mots        : {}", words.len());
  println!("progression : {steps} avancées, dernière {last:.3}");
  for word in words.iter().take(12) {
    println!(
      "  [{} → {}] {}",
      word["startMs"], word["endMs"], word["text"]
    );
  }

  assert!(!words.is_empty(), "aucun mot transcrit");
  assert!(last > 0.9, "la progression n'a pas atteint la fin : {last}");

  // ⚠️ Le vrai critère : les mots doivent être **répartis dans le temps**, pas tous à zéro.
  // Un moteur qui rendrait du texte sans horodatage passerait tous les autres contrôles.
  let last_word = words.last().expect("dernier mot");
  let end = last_word["endMs"].as_u64().expect("fin");
  let duration = parsed["durationMs"].as_u64().expect("durée");
  assert!(
    end > duration / 2,
    "le dernier mot tombe à {end} ms sur un média de {duration} ms — les horodatages sont faux"
  );
}

#[test]
#[ignore = "diarise un média réel, hors dépôt"]
fn a_real_media_is_split_into_speaker_turns() {
  // ⚠️ **L'HYPOTHÈSE « FluidAudio À TRAVERS LE PONT ».** Le moteur est validé isolément, le
  // pont aussi. Leur combinaison ne l'était pas — c'est ce que cette mesure tranche.
  //
  // Vérité terrain du média de référence : **5 voix** (une animatrice, quatre experts).
  let Some(path) = some_media() else {
    panic!("aucun média dans {}", media_dir().display());
  };

  // ⚠️ **Aucune valeur de seuil fixe ne convient** : on balaie, et on rapporte. Un test qui
  // exigerait un nombre exact à un seuil donné mentirait sur ce qu'on sait.
  for threshold in [0.6, 0.7, 0.8] {
    let started = std::time::Instant::now();
    let json = app_lib::measure::diarize(&path.to_string_lossy(), threshold).expect("diarisation");
    let elapsed = started.elapsed();

    let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
    let segments = parsed["segments"].as_array().expect("segments");
    println!(
      "seuil {threshold:.2} → {} voix, {} tours, {:.1} s",
      parsed["speakers"],
      segments.len(),
      elapsed.as_secs_f64()
    );
    assert!(
      !segments.is_empty(),
      "aucun tour de parole au seuil {threshold}"
    );
  }
}

#[test]
#[ignore = "calibre sur un média réel, hors dépôt"]
fn the_dichotomy_converges_on_a_real_media() {
  // ⚠️ **LA MESURE QUI JUSTIFIE LE CALIBRAGE.** Les tests unitaires de `diarization` exercent
  // la dichotomie sur un diariseur imaginaire ; ici elle affronte le vrai, dont la monotonie
  // n'est qu'une hypothèse de travail. Vérité terrain : **5 voix**.
  let Some(path) = some_media() else {
    panic!("aucun média dans {}", media_dir().display());
  };
  let path = path.to_string_lossy().to_string();

  let mut tried: Vec<(f64, usize)> = Vec::new();
  let started = std::time::Instant::now();
  let result = app_lib::measure::calibrate(5, |threshold| {
    let json = app_lib::measure::diarize(&path, threshold).expect("diarisation");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
    let speakers = parsed["speakers"]
      .as_u64()
      .and_then(|v| usize::try_from(v).ok())
      .expect("voix");
    tried.push((threshold, speakers));
    speakers
  });
  let elapsed = started.elapsed();

  for (threshold, speakers) in &tried {
    println!("  essai seuil {threshold:.4} → {speakers} voix");
  }
  println!(
    "retenu : seuil {:.4}, {} voix, {} essais, {:.1} s",
    result.threshold,
    result.speakers,
    result.attempts,
    elapsed.as_secs_f64()
  );

  assert!(result.attempts <= 4, "{} essais", result.attempts);
  assert!(result.speakers > 0, "aucune voix trouvée");
}

/// La vérité terrain du corpus, par **fragment de nom de fichier**.
///
/// ⚠️ **Elle s'écrit à la main**, la langue d'un média ne se déduisant d'aucune métadonnée
/// fiable : la seule source est quelqu'un qui a écouté. Un média absent de cette table est
/// rapporté **sans être jugé**.
///
/// ⚠️ **Les fragments sont sans accent quand ils le peuvent** : deux fichiers du corpus portent
/// le même titre à l'accent près, l'un en **NFC**, l'autre en **NFD** (`avconvert` normalise
/// ainsi). Un fragment accentué trouve l'un et manque l'autre **en silence**, alors que macOS
/// les affiche à l'identique. Le piège vaut pour tout appariement par nom de fichier.
const EXPECTED_LANGUAGES: &[(&str, &str)] = &[
  ("Ruffin", "fr"),
  ("sidentiel.mp4", "fr"),
  ("conteneur #mov", "fr"),
  ("lenchon", "fr"),
  ("fiez-vous", "fr"),
  ("ces menac", "fr"),
  ("Bass Line", "en"),
  ("Trova il tuo metodo", "it"),
];

#[test]
#[ignore = "détecte la langue de chaque média réel, hors dépôt"]
fn the_spoken_language_of_every_media_is_identified() {
  // ⚠️ **Aucune API Apple ne fait ça** : la méthode est à nous, donc elle doit être mesurée et
  // pas seulement relue.
  //
  // ⚠️ **Cette mesure a remplacé une mesure monolingue.** Elle ne portait que
  // sur le premier média du dossier — français — et attestait donc que la détection sait
  // reconnaître **la langue de la machine**, ce qui est le cas le moins discriminant qui soit :
  // un moteur qui répondrait toujours « fr » l'aurait passée. Le jour où la détection a été
  // branchée au produit, le seul cas qui comptait — un média **étranger** — n'avait jamais été
  // joué.
  let media = all_media();
  assert!(
    !media.is_empty(),
    "aucun média dans {}",
    media_dir().display()
  );

  let mut violations: Vec<String> = Vec::new();
  for path in &media {
    let name = path.to_string_lossy().to_string();
    let started = std::time::Instant::now();
    let json = app_lib::measure::detect_language(&name).expect("détection");
    let elapsed = started.elapsed().as_secs_f64();
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
    let found = parsed["language"].as_str().unwrap_or("—");

    let expected = EXPECTED_LANGUAGES
      .iter()
      .find(|(fragment, _)| name.contains(fragment))
      .map(|(_, language)| *language);

    println!(
      "{:<22} attendu {:<3} → {json} en {elapsed:.1} s",
      label(path),
      expected.unwrap_or("?")
    );

    if let Some(expected) = expected {
      if found != expected {
        violations.push(format!(
          "{} : attendu {expected}, obtenu {found}",
          label(path)
        ));
      }
    }
  }

  assert!(violations.is_empty(), "{}", violations.join("\n"));
}

#[test]
#[ignore = "balaie les seuils sur un média réel — sert à CHOISIR la stratégie d'estimation"]
fn how_the_voice_count_behaves_across_thresholds() {
  // ⚠️ **Cette mesure n'affirme rien, elle RAPPORTE.** Elle existe pour décider de la stratégie
  // d'estimation automatique du nombre de locuteurs — le point le plus délicat de la phase —
  // sur des chiffres plutôt que sur une intuition. Vérité terrain : 5 voix.
  let Some(path) = some_media() else {
    panic!("aucun média dans {}", media_dir().display());
  };
  let path = path.to_string_lossy().to_string();

  println!("seuil   voix");
  let mut counts: Vec<(f64, usize)> = Vec::new();
  for step in 0..=16 {
    let threshold = 0.50 + f64::from(step) * 0.025;
    let json = app_lib::measure::diarize(&path, threshold).expect("diarisation");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
    let speakers = parsed["speakers"]
      .as_u64()
      .and_then(|v| usize::try_from(v).ok())
      .expect("voix");
    println!("{threshold:.3}   {speakers}");
    counts.push((threshold, speakers));
  }

  // Le plus long palier : combien de seuils consécutifs rendent le même nombre.
  let mut plateaus: Vec<(usize, usize)> = Vec::new();
  for (_, speakers) in &counts {
    match plateaus.last_mut() {
      Some((n, width)) if *n == *speakers => *width += 1,
      _ => plateaus.push((*speakers, 1)),
    }
  }
  println!("\npaliers (voix × largeur) : {plateaus:?}");
}

#[test]
#[ignore = "pipeline complet sur un média réel, hors dépôt"]
fn the_whole_pipeline_produces_an_attributed_transcript() {
  // ⚠️ **Ce que cette mesure chiffre, et ce qu'elle ne chiffre pas.**
  //
  // Un vrai taux d'erreur d'attribution demanderait d'étiqueter 1 386 mots à la main : une
  // corvée, donc une mesure qu'on ne rejouerait jamais après un changement — le seul moment où
  // elle vaudrait quelque chose. On mesure donc autre chose, automatiquement : **combien de
  // mots chevauchent une frontière de locuteur**, c'est-à-dire combien de mots commencent chez
  // l'un et finissent chez l'autre.
  //
  // Ce sont exactement les mots sur lesquels une attribution « au segment » joue à pile ou
  // face. Le nombre ne dit pas combien d'erreurs on évite ; il dit **sur combien de mots le
  // choix de la granularité est décisif**. C'est ce qu'on peut honnêtement affirmer.
  let Some(path) = some_media() else {
    panic!("aucun média dans {}", media_dir().display());
  };
  let path = path.to_string_lossy().to_string();

  let words_json =
    app_lib::measure::file_transcribe(&path, "fr", &mut |_| true).expect("transcription");
  let parsed: serde_json::Value = serde_json::from_str(&words_json).expect("json");
  let words: Vec<app_lib::measure::Word> =
    serde_json::from_value(parsed["words"].clone()).expect("mots");

  let diarization_json = app_lib::measure::diarize(&path, 0.65).expect("diarisation");
  let diarization: serde_json::Value = serde_json::from_str(&diarization_json).expect("json");
  let segments: Vec<app_lib::measure::DiarizationSegment> =
    serde_json::from_value(diarization["segments"].clone()).expect("segments");

  // ⚠️ **On mesure l'attribution, plus un transcript étiqueté.** Les locuteurs
  // sont sortis du produit ; ce qui reste et qui compte est ce dont le **filtre d'écho** dépend :
  // de quelle voix vient chaque mot. Le transcript, lui, ne se découpe plus que par le silence.
  let attribution = app_lib::measure::attribute(&words, &segments);
  let transcript = app_lib::measure::Transcript::of(&words, "fr");

  // Combien de mots chevauchent une frontière ? Un mot chevauche si le segment qui contient son
  // début n'est pas celui qui contient sa fin.
  let owner_at = |instant: u64| -> Option<u32> {
    segments
      .iter()
      .find(|segment| segment.contains(instant))
      .map(|segment| segment.speaker)
  };
  let straddling = words
    .iter()
    .filter(|word| {
      let start = owner_at(word.start_ms);
      let end = owner_at(word.end_ms.saturating_sub(1));
      start.is_some() && end.is_some() && start != end
    })
    .count();

  let voices: std::collections::BTreeSet<u32> = attribution.iter().copied().collect();

  println!("mots            : {}", words.len());
  println!("segments de voix: {}", segments.len());
  println!("voix attribuées : {}", voices.len());
  println!("paragraphes     : {}", transcript.paragraphs.len());
  println!(
    "mots à cheval   : {straddling} ({:.2} %) — ceux où l'attribution AU SEGMENT joue à pile ou face",
    100.0 * straddling as f64 / words.len().max(1) as f64
  );

  println!("\npremiers paragraphes :");
  for paragraph in transcript.paragraphs.iter().take(6) {
    let text = paragraph.text();
    let shown: String = text.chars().take(70).collect();
    println!("  [{} ms] {shown}…", paragraph.start_ms());
  }

  assert!(!transcript.paragraphs.is_empty());
  assert!(voices.len() >= 2, "un plateau a plusieurs voix");
}

/// Ce qu'une ligne du tableau porte.
struct Row {
  label: String,
  duration_ms: u64,
  has_audio: bool,
  has_video: bool,
  language: String,
  detect_s: f64,
  transcribe_s: f64,
  words: usize,
  speakers: usize,
  segments: usize,
  diarize_s: f64,
  turns: usize,
  rss_baseline: f64,
  rss_peak: f64,
}

#[test]
#[ignore = "parcourt TOUT le corpus hors dépôt — plusieurs minutes"]
fn the_whole_corpus_runs_end_to_end_and_reports() {
  // ⚠️ **CETTE MESURE RAPPORTE, ELLE N'AFFIRME PAS.** Aucun nombre de locuteurs, aucune
  // durée, aucun temps n'est attendu : un moteur de diarisation et un modèle de transcription
  // ne sont pas reproductibles, et un test qui exigerait un chiffre exact serait un test qui
  // ment. Les **seules** assertions sont des invariants durs — le média s'ouvre, les bornes
  // croissent, aucun tour ne déborde le média.
  //
  // ⚠️ **Les violations sont COLLECTÉES puis vérifiées à la fin**, jamais assertées au vol :
  // un `assert!` sur le premier média perdrait le rapport des quatre autres, c'est-à-dire
  // exactement l'information pour laquelle on a lancé la mesure.
  let media = all_media();
  assert!(
    !media.is_empty(),
    "aucun média dans {}",
    media_dir().display()
  );

  let mut rows: Vec<Row> = Vec::new();
  let mut violations: Vec<String> = Vec::new();

  for path in &media {
    let name = path.to_string_lossy().to_string();
    println!(
      "\n═══ {}",
      path.file_name().unwrap_or_default().to_string_lossy()
    );

    // ── 1. Inspection
    let inspect = app_lib::measure::media_inspect(&name).expect("inspection");
    let inspected: serde_json::Value = serde_json::from_str(&inspect).expect("json");
    println!("  inspection : {inspect}");
    if inspected.get("problem").is_some() {
      violations.push(format!("{} : le média est refusé — {inspect}", label(path)));
      continue;
    }
    let duration_ms = inspected["durationMs"].as_u64().unwrap_or(0);
    let has_audio = inspected["hasAudio"].as_bool().unwrap_or(false);
    let has_video = inspected["hasVideo"].as_bool().unwrap_or(false);

    // ── 2. Détection de langue
    // ⚠️ **La détection transcrit un échantillon de 30 s par langue installée**, et les neuf
    // sont installées sur la machine de mesure : elle arbitre donc entre **six** candidates,
    // le cas le plus difficile possible. Son coût se compte en six transcriptions
    // d'échantillon, pas en une — d'où le chronomètre à part, et la colonne qui rapporte ce
    // qu'elle pèse **par rapport à la transcription complète**. Sur un média court, elle peut
    // coûter plus cher que le travail qu'elle prépare ; c'est un résultat, pas un accident.
    //
    // ⚠️ Le corpus porte **trois langues** — français, anglais, italien. C'est la
    // discrimination entre langues romanes (italien contre français, espagnol, portugais) qui
    // est éprouvée ici, et c'est le cas difficile : ce sont elles que la détection confond.
    let started = std::time::Instant::now();
    let verdict = app_lib::measure::detect_language(&name).expect("détection");
    let detect_s = started.elapsed().as_secs_f64();
    let detected: serde_json::Value = serde_json::from_str(&verdict).expect("json");
    let language = detected["language"].as_str().unwrap_or("—").to_string();
    println!("  langue     : {verdict} en {detect_s:.1} s");

    // ── 3. Transcription
    // ⚠️ **On transcrit dans la langue détectée, jamais dans une langue codée en dur.**
    // C'est ce que fait le produit — la détection remplit le champ que l'écran propose — et
    // sur un corpus multilingue, forcer `fr` transcrirait l'italien avec le modèle français
    // et rendrait une mesure sans aucun rapport avec ce que l'utilisateur obtient. La mesure
    // est enchaînée à la détection ; si la détection se trompe, la transcription hérite de son
    // erreur, et c'est exactement le comportement qu'on veut voir.
    let spoken = if language == "—" { "fr" } else { &language };
    let started = std::time::Instant::now();
    let mut last = 0.0_f64;
    let words_json = app_lib::measure::file_transcribe(&name, spoken, &mut |ratio| {
      if ratio < last - f64::EPSILON {
        violations.push(format!(
          "{} : la progression recule, {last:.3} puis {ratio:.3}",
          label(path)
        ));
      }
      last = ratio;
      true
    })
    .expect("transcription");
    let transcribe_s = started.elapsed().as_secs_f64();
    let parsed: serde_json::Value = serde_json::from_str(&words_json).expect("json");
    let words: Vec<app_lib::measure::Word> =
      serde_json::from_value(parsed["words"].clone()).expect("mots");
    let realtime = transcribe_s / (duration_ms.max(1) as f64 / 1000.0);
    println!(
      "  transcript : {} mots en {transcribe_s:.1} s — ×{:.0} temps réel",
      words.len(),
      1.0 / realtime.max(f64::EPSILON)
    );

    // ⚠️ **DEUX SOURCES POUR LA MÊME DURÉE, ET ELLES PEUVENT DIVERGER.** L'inspection arrondit
    // `asset.duration`, la transcription la tronque. L'écart se compte en millisecondes, mais
    // c'est lui qui décide si un dernier mot « déborde » le média — donc il se rapporte, il ne
    // se devine pas.
    let transcribed_duration_ms = parsed["durationMs"].as_u64().unwrap_or(0);
    if transcribed_duration_ms != duration_ms {
      println!(
        "  durées     : inspection {duration_ms} ms vs transcription {transcribed_duration_ms} ms \
         (écart {} ms)",
        transcribed_duration_ms as i64 - duration_ms as i64
      );
    }
    if let Some(word) = words.last() {
      println!(
        "  dernier mot: fin {} ms ({:+} ms par rapport à l'inspection)",
        word.end_ms,
        word.end_ms as i64 - duration_ms as i64
      );
    }

    // Invariants sur les mots : bornes croissantes, dans le média.
    for (index, word) in words.iter().enumerate() {
      if word.end_ms < word.start_ms {
        violations.push(format!(
          "{} : mot {index} à bornes inversées ({} → {})",
          label(path),
          word.start_ms,
          word.end_ms
        ));
        break;
      }
    }
    if let Some(bad) = words
      .windows(2)
      .position(|pair| pair[1].start_ms < pair[0].start_ms)
    {
      violations.push(format!(
        "{} : les mots ne sont pas ordonnés, rupture au rang {bad}",
        label(path)
      ));
    }

    // ── 4. Diarisation, MODE AUTOMATIQUE
    // ⚠️ Le seuil vient de `AUTO_THRESHOLD`, pas d'une copie : c'est le mode automatique du
    // produit qu'on mesure, un seul passage, sans calibrage — voir `diarization::engine`.
    let probe = RssProbe::start();
    let started = std::time::Instant::now();
    let diarization_json =
      app_lib::measure::diarize(&name, app_lib::measure::AUTO_THRESHOLD).expect("diarisation");
    let diarize_s = started.elapsed().as_secs_f64();
    let (rss_baseline, rss_peak, rss_delta) = probe.finish();
    let diarization: serde_json::Value = serde_json::from_str(&diarization_json).expect("json");
    let segments: Vec<app_lib::measure::DiarizationSegment> =
      serde_json::from_value(diarization["segments"].clone()).expect("segments");
    let speakers = diarization["speakers"]
      .as_u64()
      .and_then(|v| usize::try_from(v).ok())
      .unwrap_or(0);
    println!(
      "  diarisation: {speakers} voix, {} tours bruts en {diarize_s:.1} s (seuil {:.2})",
      segments.len(),
      app_lib::measure::AUTO_THRESHOLD
    );
    println!(
      "  mémoire    : repos {rss_baseline:.0} Mio → pic {rss_peak:.0} Mio (écart {rss_delta:+.0} Mio)"
    );

    // ── 4 bis. CE QUE LA DIARISATION FAIT DES VOIX QUI SE CHEVAUCHENT
    // ⚠️ **LE POINT JAMAIS ÉVALUÉ DE LA DoD.** Trois comportements sont possibles quand deux
    // personnes se coupent la parole, et ils ne se corrigent pas de la même façon : le
    // diariseur peut **émettre des segments qui se recouvrent** (deux voix au même instant),
    // **alterner très vite** (un ping-pong de segments courts), ou **fondre les deux voix**
    // en une seule. On mesure les trois, sur la sortie brute — l'alignement, lui, ne peut
    // qu'alterner, puisqu'un mot n'a qu'un propriétaire.
    let overlapping = segments
      .windows(2)
      .filter(|pair| pair[1].start_ms < pair[0].end_ms)
      .count();
    let overlap_ms: u64 = segments
      .windows(2)
      .map(|pair| pair[0].end_ms.saturating_sub(pair[1].start_ms))
      .sum();
    let median_segment_ms = {
      let mut lengths: Vec<u64> = segments
        .iter()
        .map(|segment| segment.end_ms.saturating_sub(segment.start_ms))
        .collect();
      lengths.sort_unstable();
      lengths.get(lengths.len() / 2).copied().unwrap_or(0)
    };
    let switches = segments
      .windows(2)
      .filter(|pair| pair[0].speaker != pair[1].speaker)
      .count();
    println!(
      "  brut       : segment médian {median_segment_ms} ms, {switches} changements de voix, \
       {overlapping} paires en recouvrement ({} ms cumulés)",
      overlap_ms
    );

    // Combien de mots chevauchent une frontière de locuteur — les mots sur lesquels
    // l'attribution AU SEGMENT jouerait à pile ou face. Voir le test de référence.
    let owner_at = |instant: u64| -> Option<u32> {
      segments
        .iter()
        .find(|segment| segment.contains(instant))
        .map(|segment| segment.speaker)
    };
    let straddling = words
      .iter()
      .filter(|word| {
        let start = owner_at(word.start_ms);
        let end = owner_at(word.end_ms.saturating_sub(1));
        start.is_some() && end.is_some() && start != end
      })
      .count();
    println!(
      "  mots à cheval : {straddling} ({:.2} %)",
      100.0 * straddling as f64 / words.len().max(1) as f64
    );

    // ── 5. Composition
    // ⚠️ **Le transcript ne se découpe plus par les voix mais par le silence.**
    // Ce qu'on regarde ici a donc changé de sens : le plus long paragraphe ne dit plus qu'une
    // voix a été mal séparée, il dit **combien de temps personne ne s'est arrêté de parler**.
    let transcript = app_lib::measure::Transcript::of(&words, &language);
    let voices: std::collections::BTreeSet<u32> = app_lib::measure::attribute(&words, &segments)
      .into_iter()
      .collect();
    let longest_paragraph_ms = transcript
      .paragraphs
      .iter()
      .map(|p| p.end_ms().saturating_sub(p.start_ms()))
      .max()
      .unwrap_or(0);
    println!(
      "  transcript : {} voix attribuées, {} paragraphes, plus long {:.1} min ({:.0} % du média)",
      voices.len(),
      transcript.paragraphs.len(),
      longest_paragraph_ms as f64 / 60_000.0,
      100.0 * longest_paragraph_ms as f64 / duration_ms.max(1) as f64,
    );

    // Invariant : les paragraphes sont ordonnés et tiennent dans le média.
    // ⚠️ **La borne est celle de l'INSPECTION, pas celle du transcript** : c'est la durée que
    // l'utilisateur voit, et la seule contre laquelle un débordement soit un vrai défaut.
    let mut previous_end = 0_u64;
    for (index, paragraph) in transcript.paragraphs.iter().enumerate() {
      if paragraph.start_ms() < previous_end {
        violations.push(format!(
          "{} : le paragraphe {index} commence à {} ms avant la fin du précédent ({previous_end} ms)",
          label(path),
          paragraph.start_ms()
        ));
      }
      if paragraph.end_ms() > duration_ms {
        violations.push(format!(
          "{} : le paragraphe {index} finit à {} ms, hors du média ({duration_ms} ms)",
          label(path),
          paragraph.end_ms()
        ));
      }
      previous_end = paragraph.end_ms();
    }

    // Trois premiers paragraphes, pour l'œil.
    for paragraph in transcript.paragraphs.iter().take(3) {
      let text: String = paragraph.text().chars().take(64).collect();
      println!("    [{} ms] {text}…", paragraph.start_ms());
    }

    rows.push(Row {
      label: label(path),
      duration_ms,
      has_audio,
      has_video,
      language,
      detect_s,
      transcribe_s,
      words: words.len(),
      speakers,
      segments: segments.len(),
      diarize_s,
      turns: transcript.paragraphs.len(),
      rss_baseline,
      rss_peak,
    });
  }

  println!("\n╔═══ RAPPORT ═══");
  println!(
    "{:<28} {:>8} {:>3} {:>3} {:>5} {:>8} {:>9} {:>7} {:>6} {:>7} {:>8} {:>6} {:>10}",
    "média",
    "durée",
    "A",
    "V",
    "lang",
    "détect",
    "transcr.",
    "mots",
    "voix",
    "segm.",
    "diaris.",
    "tours",
    "RSS pic"
  );
  for row in &rows {
    println!(
      "{} {:>7.1}m {:>3} {:>3} {:>5} {:>7.1}s {:>8.1}s {:>7} {:>6} {:>7} {:>7.1}s {:>6} {:>6.0}→{:.0}",
      row.label,
      row.duration_ms as f64 / 60_000.0,
      if row.has_audio { "oui" } else { "NON" },
      if row.has_video { "oui" } else { "non" },
      row.language,
      row.detect_s,
      row.transcribe_s,
      row.words,
      row.speakers,
      row.segments,
      row.diarize_s,
      row.turns,
      row.rss_baseline,
      row.rss_peak,
    );
  }
  println!("╚═══");

  // ⚠️ **Mots par minute : le seul indicateur automatique de la granularité du moteur.**
  // Tout le produit repose sur l'horodatage **au mot** : l'alignement attribue chaque mot par
  // son milieu, et sa résolution vaut donc ce que vaut la finesse du découpage. Un moteur qui
  // rendrait des « mots » gros comme des membres de phrase ne ferait échouer aucun invariant :
  // le pipeline ne s'en plaindrait pas, et l'attribution deviendrait pourtant grossière au point
  // d'être fausse. Comparer les langues sur cette ligne rend le défaut visible sans étiqueter un
  // transcript à la main.
  println!("\nmots par minute — la RÉSOLUTION de l'alignement, par langue :");
  for row in &rows {
    let minutes = row.duration_ms as f64 / 60_000.0;
    println!(
      "  {} [{}] {:>6.0} mots/min",
      row.label,
      row.language,
      row.words as f64 / minutes.max(f64::EPSILON)
    );
  }

  println!("\nrapport au temps réel (transcription) :");
  for row in &rows {
    let media_s = row.duration_ms as f64 / 1000.0;
    println!(
      "  {} ×{:.0} plus vite que le temps réel",
      row.label,
      media_s / row.transcribe_s.max(f64::EPSILON)
    );
  }

  // ⚠️ **CE QUE COÛTE LA DÉTECTION, RAPPORTÉ À CE QU'ELLE PRÉPARE.** Elle transcrit un
  // échantillon de 30 s **par langue installée** — six ici. Sur un média court, elle peut
  // donc coûter plus que la transcription complète : la question « le jeu en vaut-il la
  // chandelle » se tranche sur ce rapport, pas sur une intuition.
  println!("\ncoût de la détection (6 langues installées) :");
  let mut detect_total = 0.0_f64;
  let mut transcribe_total = 0.0_f64;
  for row in &rows {
    detect_total += row.detect_s;
    transcribe_total += row.transcribe_s;
    println!(
      "  {} {:>5.1}s pour {:>5.1}s de transcription — {:>4.0} % du travail",
      row.label,
      row.detect_s,
      row.transcribe_s,
      100.0 * row.detect_s / row.transcribe_s.max(f64::EPSILON)
    );
  }
  println!(
    "  TOTAL sur le corpus : {detect_total:.1}s de détection pour {transcribe_total:.1}s de \
     transcription — {:.0} %",
    100.0 * detect_total / transcribe_total.max(f64::EPSILON)
  );

  // ⚠️ **CE QU'UN ÉCHEC ICI VEUT DIRE, ET CE QU'IL NE VEUT PAS DIRE.** Le rapport est déjà
  // imprimé au-dessus : l'échec n'en fait perdre aucune ligne. Il ne signale **jamais** un
  // chiffre inattendu — aucun chiffre n'est attendu — mais une propriété que le produit doit
  // tenir quoi qu'il arrive. Le débordement de fin de média est
  // **intermittent** (deux exécutions propres, une à +9 ms sur le dernier tour), parce que
  // l'horodatage du dernier mot varie d'une transcription à l'autre. Un échec isolé sur ce
  // point n'est donc pas un régression : c'est le même défaut qui se rappelle.
  assert!(
    violations.is_empty(),
    "invariants violés :\n  - {}",
    violations.join("\n  - ")
  );
}

/// Ce que tient chaque voix : sa part du temps de parole, son **temps absolu**, et son nombre de
/// tours. Trié du plus bavard au plus discret.
///
/// ⚠️ **C'est la répartition qui renseigne, pas le nombre de voix** : un compte ne se juge pas
/// sans vérité terrain, alors qu'une voix portant 1 % du temps de parole n'est visiblement pas
/// une personne de plus dans la pièce — c'est un rire ou un chevauchement.
///
/// ⚠️ **Le temps absolu permet de borner sans se caler sur ce qu'on voit** : un pourcentage
/// plancher tiré de ces mesures n'alerterait plus de rien, là où une seconde de parole est une
/// borne physique. Le nombre de tours sépare un éclat isolé d'interventions brèves répétées.
fn shares(segments: &[serde_json::Value]) -> Vec<(f64, u64, usize)> {
  let mut per_speaker: std::collections::BTreeMap<u64, (u64, usize)> =
    std::collections::BTreeMap::new();
  for segment in segments {
    let speaker = segment["speaker"].as_u64().unwrap_or(0);
    let start = segment["startMs"].as_u64().unwrap_or(0);
    let end = segment["endMs"].as_u64().unwrap_or(0);
    let entry = per_speaker.entry(speaker).or_default();
    entry.0 += end.saturating_sub(start);
    entry.1 += 1;
  }
  let total: u64 = per_speaker.values().map(|(held, _)| *held).sum();
  if total == 0 {
    return Vec::new();
  }
  let mut parts: Vec<(f64, u64, usize)> = per_speaker
    .values()
    .map(|(held, turns)| (*held as f64 * 100.0 / total as f64, *held, *turns))
    .collect();
  parts.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));
  parts
}

#[test]
#[ignore = "balaie les seuils sur TOUT le corpus hors dépôt — plusieurs minutes"]
fn the_corpus_threshold_sweep_reports_how_many_voices_each_media_yields() {
  // ⚠️ **LE SEUIL AUTOMATIQUE REPOSAIT SUR UN SEUL MÉDIA.** `AUTO_THRESHOLD` a été choisi
  // sur le raisonnement du coût de l'erreur — sur-segmenter se voit, sous-segmenter se cache —
  // et le chiffre lui-même n'était validé que par une coïncidence sur le plateau de six
  // minutes. Ce balayage court dit ce qu'il donne ailleurs. Il **rapporte** : il ne choisit
  // pas, et il n'assère aucun nombre de voix.
  //
  // ⚠️ **0,90 est dans la liste parce qu'une question l'exige**, pas pour compléter la série :
  // aucun média du corpus ne rend **une seule voix**, pas même une conférence TEDx où une seule
  // personne parle. Il faut savoir si le diariseur sait conclure « un » quelque part, ou s'il
  // ne le fait jamais — la voie « texte brut » du produit en dépend.
  let media = all_media();
  assert!(
    !media.is_empty(),
    "aucun média dans {}",
    media_dir().display()
  );

  let thresholds = [0.60, app_lib::measure::AUTO_THRESHOLD, 0.70, 0.80, 0.90];
  for path in &media {
    let name = path.to_string_lossy().to_string();
    println!("\n{}", label(path));
    for threshold in thresholds {
      let json = app_lib::measure::diarize(&name, threshold).expect("diarisation");
      let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
      let speakers = parsed["speakers"].as_u64().unwrap_or(0);
      let empty = Vec::new();
      let segments = parsed["segments"].as_array().unwrap_or(&empty);
      let parts = shares(segments);
      let held: Vec<String> = parts
        .iter()
        .map(|(share, ms, turns)| format!("{share:.1}%/{:.1}s/{turns}t", *ms as f64 / 1000.0))
        .collect();
      println!(
        "  {:.2}{} {:>2} voix, {:>3} tours   {}",
        threshold,
        if (threshold - app_lib::measure::AUTO_THRESHOLD).abs() < f64::EPSILON {
          "*"
        } else {
          " "
        },
        speakers,
        segments.len(),
        held.join("  ")
      );
    }
  }
  println!("\n* seuil de la détection automatique du produit");
}

/// La même répartition, mais sur ce que rend **le chemin du produit**, pas le pont nu.
fn shares_of(segments: &[app_lib::measure::DiarizationSegment]) -> Vec<(f64, u64, usize)> {
  let values: Vec<serde_json::Value> = segments
    .iter()
    .map(|segment| {
      serde_json::json!({
        "speaker": segment.speaker,
        "startMs": segment.start_ms,
        "endMs": segment.end_ms,
      })
    })
    .collect();
  shares(&values)
}

#[test]
#[ignore = "rejoue le CHEMIN DU PRODUIT sur tout le corpus — plusieurs minutes"]
fn the_product_path_reports_the_voices_the_user_will_actually_see() {
  // ⚠️ **CETTE MESURE EXISTE PARCE QUE LES AUTRES CONTOURNAIENT LA CORRECTION.** Le balayage
  // et le parcours de corpus appellent `diarize`, le pont nu ; ils rapportent donc les voix
  // **brutes**, parasites compris. C'était sans conséquence tant que le produit ne faisait
  // qu'acheminer ce résultat. Depuis que `analyse` écarte les voix qui ne tiennent pas
  // [`app_lib::measure::SLIVER_MS`] de parole, les deux ne disent plus la même chose, et c'est
  // celle-ci qui dit ce que l'utilisateur verra.
  //
  // ⚠️ Elle **rapporte**, elle n'assère aucun nombre de voix : la vérité terrain n'est connue
  // que d'un seul média sur huit.
  let media = all_media();
  assert!(
    !media.is_empty(),
    "aucun média dans {}",
    media_dir().display()
  );

  for path in &media {
    let name = path.to_string_lossy().to_string();
    let segments = app_lib::measure::analyse(
      &name,
      app_lib::measure::SpeakerMode::Automatic,
      &app_lib::measure::NativeDiarizer,
      &mut |_| {},
    )
    .expect("analyse");
    let parts = shares_of(&segments);
    let held: Vec<String> = parts
      .iter()
      .map(|(share, ms, turns)| format!("{share:.1}%/{:.1}s/{turns}t", *ms as f64 / 1000.0))
      .collect();
    println!(
      "{} auto → {} voix   {}",
      label(path),
      parts.len(),
      held.join("  ")
    );
    if parts.len() <= 1 {
      println!("    ↳ VOIX UNIQUE : le rendu « texte brut justifié » est atteint");
    }
  }
}

#[test]
#[ignore = "le média de référence est le SEUL dont on connaisse la vérité terrain"]
fn asking_for_the_five_real_voices_of_the_reference_media_now_reaches_them() {
  // ⚠️ **LE DÉFAUT QUE TOUTE LA CAMPAGNE A SERVI À TROUVER.** Le plateau `#cdanslair` porte
  // **cinq personnes** : une animatrice et quatre experts. La fiche de phase enregistrait que
  // le calibrage « converge sur 0,65 et rend exactement cinq voix » — sauf que la cinquième
  // tenait 1,8 s. Demander cinq locuteurs en rendait donc **quatre**, et rien ne le montrait.
  //
  // Cette mesure rejoue la demande et dit ce que le calibrage atteint maintenant. Elle
  // **rapporte** : elle n'exige pas cinq, parce qu'un modèle génératif n'est pas un contrat et
  // qu'un test qui figerait ce nombre mentirait le jour où FluidAudio change de version.
  let Some(path) = all_media().into_iter().find(|path| {
    path
      .file_name()
      .is_some_and(|name| name.to_string_lossy().contains("cdanslair"))
  }) else {
    println!("média de référence absent du corpus — mesure sans objet");
    return;
  };

  let name = path.to_string_lossy().to_string();
  for target in [2, 3, 4, 5] {
    let segments = app_lib::measure::analyse(
      &name,
      app_lib::measure::SpeakerMode::Exactly(target),
      &app_lib::measure::NativeDiarizer,
      &mut |_| {},
    )
    .expect("analyse");
    let parts = shares_of(&segments);
    let held: Vec<String> = parts
      .iter()
      .map(|(share, ms, turns)| format!("{share:.1}%/{:.1}s/{turns}t", *ms as f64 / 1000.0))
      .collect();
    println!(
      "  demandé {target} → obtenu {} voix   {}",
      parts.len(),
      held.join("  ")
    );
  }
  println!("\n(vérité terrain de ce média : 5 personnes — une animatrice, quatre experts)");
}

#[test]
#[ignore = "transcrit le média LONG du corpus et l'interrompt en vol"]
fn cancelling_a_long_transcription_stops_it_where_it_stands() {
  // ⚠️ **Le drapeau d'annulation était lu, mais rien n'avait prouvé qu'il arrête quoi que ce
  // soit** : sur un média court, un arrêt immédiat et un arrêt jamais demandé se ressemblent
  // trait pour trait. C'est ce que cette mesure lève.
  //
  // ⚠️ **Le rappel de progression EST l'interrupteur** : rendre `false` demande l'arrêt. Le
  // point de sortie est au même endroit que le point de mesure, à dessein.
  let Some(path) = all_media()
    .into_iter()
    .max_by_key(|path| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
  else {
    panic!("aucun média dans {}", media_dir().display());
  };
  let name = path.to_string_lossy().to_string();
  println!(
    "média : {}",
    path.file_name().unwrap_or_default().to_string_lossy()
  );

  // D'abord la référence : combien coûte la transcription entière ?
  let started = std::time::Instant::now();
  let json = app_lib::measure::file_transcribe(&name, "fr", &mut |_| true).expect("transcription");
  let whole = started.elapsed();
  let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
  let all_words = parsed["words"].as_array().map_or(0, Vec::len);
  println!(
    "entière   : {all_words} mots en {:.1} s",
    whole.as_secs_f64()
  );

  // Puis la même, coupée au premier dixième.
  let started = std::time::Instant::now();
  let mut stopped_at = 0.0_f64;
  let outcome = app_lib::measure::file_transcribe(&name, "fr", &mut |ratio| {
    stopped_at = ratio;
    ratio < 0.10
  });
  let interrupted = started.elapsed();

  match &outcome {
    Ok(json) => {
      let parsed: serde_json::Value = serde_json::from_str(json).expect("json");
      let words = parsed["words"].as_array().map_or(0, Vec::len);
      println!(
        "interrompue : {words} mots en {:.1} s, arrêt demandé à {:.0} % d'avancement",
        interrupted.as_secs_f64(),
        stopped_at * 100.0
      );
    }
    Err(error) => println!(
      "interrompue : erreur après {:.1} s — {error}",
      interrupted.as_secs_f64()
    ),
  }

  // ⚠️ **On n'assère pas un temps, on assère un RAPPORT.** Une borne en secondes serait un
  // chiffre inventé, et elle se briserait sur une machine plus lente sans rien signaler de
  // vrai. Ce qui doit rester vrai, c'est qu'une transcription interrompue au dixième coûte
  // franchement moins que la même menée à son terme.
  assert!(
    interrupted < whole,
    "l'annulation n'a rien abrégé : {:.1} s contre {:.1} s",
    interrupted.as_secs_f64(),
    whole.as_secs_f64()
  );
  println!(
    "\nrapport : l'annulation a coûté {:.0} % de la transcription entière",
    interrupted.as_secs_f64() / whole.as_secs_f64() * 100.0
  );
}

#[test]
#[ignore = "diarise le média LONG du corpus et suit sa mémoire — le vrai risque de la phase"]
fn the_longest_media_is_measured_for_memory() {
  // ⚠️ **LE RISQUE JAMAIS MESURÉ DE LA PHASE.** Tout l'audio entre en RAM :
  // `performCompleteDiarization` veut la totalité des échantillons, ~230 Mo par heure en
  // 16 kHz mono `Float`. Cette mesure existe pour qu'on sache **de combien** il s'agit sur le
  // média le plus long du corpus, et pour qu'on le sache **de nouveau** après un changement.
  //
  // ⚠️ Elle n'assère aucun plafond : un seuil chiffré ici serait un chiffre inventé. Elle
  // rapporte l'écart entre le repos et le pic, et c'est à la lecture qu'on tranche.
  let Some(path) = all_media()
    .into_iter()
    .max_by_key(|path| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
  else {
    panic!("aucun média dans {}", media_dir().display());
  };
  let name = path.to_string_lossy().to_string();
  println!(
    "média : {}",
    path.file_name().unwrap_or_default().to_string_lossy()
  );

  let inspect = app_lib::measure::media_inspect(&name).expect("inspection");
  let inspected: serde_json::Value = serde_json::from_str(&inspect).expect("json");
  let duration_ms = inspected["durationMs"].as_u64().unwrap_or(0);
  println!("durée : {:.1} min", duration_ms as f64 / 60_000.0);
  println!(
    "attendu si tout l'audio entre en 16 kHz mono Float32 : {:.0} Mio",
    duration_ms as f64 / 1000.0 * 16_000.0 * 4.0 / 1_048_576.0
  );

  // ⚠️ **Fuite ou rétention de l'allocateur ? La question se tranche par la répétition, pas par
  // une lecture du code.** Après un seul passage, « la mémoire n'est pas rendue au
  // système » et « la mémoire est perdue » se ressemblent trait pour trait. Trois passages
  // les séparent : si les pages sont réemployées, le pic se stabilise ; si elles ne le sont
  // pas, il monte d'autant à chaque tour, et le produit ne survit pas à trois fichiers.
  let mut peaks: Vec<f64> = Vec::new();
  for pass in 1..=3 {
    let probe = RssProbe::start();
    let started = std::time::Instant::now();
    let json =
      app_lib::measure::diarize(&name, app_lib::measure::AUTO_THRESHOLD).expect("diarisation");
    let elapsed = started.elapsed();
    let (baseline, peak, delta) = probe.finish();
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("json");
    println!(
      "\npassage {pass} : {} voix, {} tours en {:.1} s",
      parsed["speakers"],
      parsed["segments"].as_array().map_or(0, Vec::len),
      elapsed.as_secs_f64()
    );
    println!("  mémoire : repos {baseline:.0} Mio → pic {peak:.0} Mio, écart {delta:+.0} Mio");
    println!(
      "  après   : {:.0} Mio (non rendu au système)",
      resident_mib()
    );
    peaks.push(peak);
  }

  let first = peaks.first().copied().unwrap_or(0.0);
  let last = peaks.last().copied().unwrap_or(0.0);
  println!(
    "\npics successifs : {}",
    peaks
      .iter()
      .map(|peak| format!("{peak:.0}"))
      .collect::<Vec<_>>()
      .join(" → ")
  );
  println!(
    "verdict : {}",
    if last > first * 2.0 {
      "le pic monte d'un passage à l'autre — la mémoire n'est PAS réemployée"
    } else {
      "le pic se stabilise — les pages sont gardées puis réemployées"
    }
  );
}
