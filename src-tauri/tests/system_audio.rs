//! La capture de session, éprouvée sur du **vrai son**.
//!
//! ⚠️ **`#[ignore]` par défaut, et ce n'est pas de la timidité** : cette mesure ouvre un tap
//! Core Audio, enregistre ce que joue la machine de qui la lance, et fait surgir le prompt TCC
//! « Enregistrement audio ». Elle se lance à la main —
//! `cargo test --test system_audio -- --ignored --nocapture` — après avoir lancé quelque chose
//! qui parle, puis en parlant dans le micro pendant les dix secondes.
//!
//! **Éprouvé** : que le tap s'ouvre, que les deux flux coulent **séparément**, que les deux
//! fichiers sont écrits en 16 kHz mono, et que l'arrêt les ferme proprement.
//!
//! ⚠️ **Non éprouvé**, et un rapport vert ne doit pas le laisser croire : la capture depuis une
//! vraie application de visioconférence (Teams, Zoom et Meet peuvent réserver le périphérique
//! autrement), la tenue sur la durée, et le changement de périphérique de sortie, qui a son
//! propre test ci-dessous parce qu'il demande de brancher un casque à la main.

use std::{
  sync::{Mutex, OnceLock},
  thread,
  time::Duration,
};

/// Ce que les deux moteurs ont produit pendant la mesure.
///
/// ⚠️ **Un `static`, et il n'y a pas le choix** : l'observateur du pont est un pointeur de
/// fonction C **non capturant** — il ne peut rien retenir de son appelant. C'est le même
/// contrat que pour la dictée.
static HEARD: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();

fn heard() -> &'static Mutex<Vec<(String, String)>> {
  HEARD.get_or_init(|| Mutex::new(Vec::new()))
}

/// Le rappel que Swift appelle à chaque morceau de transcript.
///
/// ⚠️ **La chaîne ne survit pas à l'appel** : on la lit tout de suite et on ne garde pas le
/// pointeur.
extern "C" fn on_transcript(payload: *const std::ffi::c_char) {
  if payload.is_null() {
    return;
  }
  // SAFETY : le pont garantit une chaîne C valide, terminée par un nul, pour la durée de
  // l'appel.
  let raw = unsafe { std::ffi::CStr::from_ptr(payload) };
  let Ok(text) = raw.to_str() else { return };
  let Ok(event) = serde_json::from_str::<app_lib::measure::LiveTranscriptEvent>(text) else {
    return;
  };
  let (kind, stream, said) = match event {
    app_lib::measure::LiveTranscriptEvent::Partial { stream, text } => ("partial", stream, text),
    // ⚠️ **Les mots horodatés ne se rapportent PAS ici.** Cette mesure lit ce que l'écran lira ;
    // les mots, eux, s'arrêtent au backend et servent à la consolidation.
    app_lib::measure::LiveTranscriptEvent::Final { stream, text, .. } => ("final", stream, text),
    app_lib::measure::LiveTranscriptEvent::Finished { stream } => {
      ("finished", stream, String::new())
    }
    // ⚠️ **Cette mesure lit ce qui SORT du pont, et `dropped` n'en sort jamais** : il est
    // fabriqué plus haut, au moment où l'écho est écarté. Le bras existe pour que l'ajout d'une
    // nature demain fasse échouer la compilation plutôt que de disparaître du rapport.
    app_lib::measure::LiveTranscriptEvent::Dropped { stream } => ("dropped", stream, String::new()),
    app_lib::measure::LiveTranscriptEvent::Failed { stream, text } => ("failed", stream, text),
  };
  let side = match stream {
    app_lib::measure::LiveStream::System => "système",
    app_lib::measure::LiveStream::Microphone => "micro",
  };
  if let Ok(mut collected) = heard().lock() {
    collected.push((format!("{side}/{kind}"), said));
  }
}

/// Combien de temps on capte. Assez pour que les deux flux aient de quoi montrer, assez peu
/// pour qu'on relance la mesure sans y penser.
const CAPTURE_SECONDS: u64 = 10;

/// Le dossier de mesure — **pas celui du produit**.
///
/// ⚠️ La mesure n'écrit pas dans le cache de l'application : elle y écraserait l'audio d'une
/// session en cours. C'est le seul écart assumé avec le chemin du produit, et il ne porte que
/// sur l'emplacement.
fn measurement_directory() -> std::path::PathBuf {
  std::env::temp_dir().join("mirmalion-session-measure")
}

/// Ce qu'un fichier écrit pèse, ou `0` s'il n'existe pas.
fn size_of(path: &str) -> u64 {
  std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// La durée d'un WAV 16 kHz mono 16 bits, d'après sa taille — en-tête de 44 octets déduit.
fn seconds_of(bytes: u64) -> f64 {
  bytes.saturating_sub(44) as f64 / 32_000.0
}

/// L'énumération, seule. **Ne capte rien** — elle est donc jouable sans autorisation ni bruit.
///
/// Non ignorée à dessein : c'est le seul morceau de cette brique qui n'ouvre rien.
#[test]
fn the_sources_can_be_listed_without_recording_anything() {
  let sources = parse::<Vec<app_lib::measure::AudioSource>>(
    &app_lib::measure::list_audio_sources().expect("la HAL doit répondre"),
  );

  println!("\n── Sources captables ──");
  for source in &sources {
    println!(
      "  {:<10} {}{}",
      source.id,
      source.name,
      if source.is_system { "  (global)" } else { "" }
    );
  }
  println!("  → {} source(s)\n", sources.len());

  assert!(
    sources.iter().any(|source| source.is_system),
    "« Tout le système » doit toujours être proposé"
  );
}

/// La mesure de référence : dix secondes, deux flux, deux fichiers.
///
/// ⚠️ **Elle rapporte plus qu'elle n'affirme.** Les seules assertions portent sur ce qui est
/// vrai quoi qu'il arrive — le tap s'ouvre, l'arrêt est propre. Le **contenu**, lui, dépend de
/// ce que joue la machine : exiger un niveau minimal ferait échouer la mesure sur une machine
/// silencieuse, c'est-à-dire punir l'opérateur au lieu de l'informer.
#[test]
#[ignore = "ouvre un vrai tap Core Audio et enregistre dix secondes — se lance à la main"]
fn a_real_capture_writes_two_separate_streams() {
  let directory = measurement_directory();
  let folder = directory.to_string_lossy().to_string();

  println!("\n── Capture de session ──");
  println!("  dossier   : {folder}");
  println!("  source    : Tout le système");
  println!("  micro     : le micro système");
  println!("  durée     : {CAPTURE_SECONDS} s — parlez, et laissez quelque chose jouer\n");

  // ⚠️ **L'OBSERVATEUR SE BRANCHE AVANT LE DÉMARRAGE.** Côté natif, les moteurs démarrent
  // **avant** les sources : enregistré après, il manquerait les premiers segments — et ce sont
  // eux qui disent si la chaîne marche.
  app_lib::measure::live_set_transcript_observer(Some(on_transcript))
    .expect("l'observateur doit se brancher");

  let opening = std::time::Instant::now();
  let measured_locale =
    std::env::var("MIRMALION_MEASURE_LOCALE").unwrap_or_else(|_| "fr".to_owned());
  println!("  langue    : {measured_locale}\n");
  app_lib::measure::live_start("system", Some("default"), &folder, Some(&measured_locale))
    .expect("le tap doit s'ouvrir — l'enregistrement audio est-il autorisé ?");
  // ⚠️ **L'ouverture n'est pas instantanée**, et le chrono du flux ne doit pas la compter :
  // créer le tap, assembler l'agrégat et le démarrer prend un temps qu'aucun échantillon ne
  // traverse. La mesurer à part est utile pour l'écran de configuration — c'est le délai entre
  // le clic « Démarrer » et le premier son capté.
  let setup = opening.elapsed().as_secs_f64();
  let started = std::time::Instant::now();
  println!("  ouverture du tap : {setup:.2} s\n");

  for elapsed in 1..=CAPTURE_SECONDS {
    thread::sleep(Duration::from_secs(1));
    let status = read_status();
    println!(
      "  {elapsed:>2}s  système {:>7} in / {:>7} out · micro {:>7} in / {:>7} out · niveau {:.3}",
      status.system_input_frames,
      status.system_frames,
      status.microphone_input_frames,
      status.microphone_frames,
      status.level
    );
  }

  // ⚠️ **Les droits du dossier se mesurent**, ils ne se déduisent pas d'un appel qui rend la
  // main. `createDirectory(attributes:)` accepte les attributs **à la création seulement** :
  // sur un dossier qui existait déjà, ils sont ignorés en silence. Le chemin nominal le
  // supprime d'abord, donc l'attribut porte — mais c'est exactement le genre de garantie qui
  // se perd à la première réorganisation, sans que rien ne le dise. Le seul juge est le
  // système de fichiers.
  //
  // C'est ce qui tient la décision « le fichier temporaire n'est pas chiffré » : ce sont la
  // durée de vie, l'emplacement en cache et **ces droits** qui protègent à la place.
  {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&directory)
      .expect("le dossier d'enregistrement doit exister pendant la capture")
      .permissions()
      .mode()
      & 0o777;
    println!("  droits du dossier : {mode:o}");
    assert_eq!(
      mode, 0o700,
      "l'audio de session doit être fermé aux autres comptes de la machine"
    );
  }

  let before_stop = read_status();
  let wall_clock = started.elapsed().as_secs_f64();
  app_lib::measure::live_stop().expect("l'arrêt doit être propre");

  // ⚠️ **On laisse la finalisation arriver.** Elle est asynchrone : les derniers segments
  // partent après le retour de l'arrêt, et les compter tout de suite dirait « rien » alors que
  // le moteur avait encore du travail.
  thread::sleep(Duration::from_secs(5));
  report_transcript();
  let after_stop = read_status();

  println!("\n── Résultat ──");

  // ⚠️ **Le garde-fou qui aurait attrapé tout seul le défaut de fréquence.** Le tap
  // déclarait 48 000 Hz et livrait du 44 100 : la conversion affichait un ratio **parfait**,
  // aucun tampon perdu, aucune erreur — et le fichier sortait comprimé de 8,1 %, transposé
  // d'un demi-ton vers l'aigu. Rien de ce qui se lisait *dans* la chaîne ne pouvait le voir.
  //
  // Le seul juge extérieur est **le temps qui passe** : dix secondes de capture doivent rendre
  // dix secondes d'audio. C'est la seule assertion de cette mesure qui porte sur la justesse,
  // et c'est parce qu'elle ne dépend d'aucun chiffre venu de la chaîne mesurée.
  let recorded = before_stop.system_frames as f64 / 16_000.0;
  let drift = (recorded - wall_clock).abs() / wall_clock;
  println!(
    "  horloge  : {wall_clock:.2} s écoulées · {recorded:.2} s écrites · écart {:.2} %",
    drift * 100.0
  );
  if before_stop.system_input_frames > 0 {
    assert!(
      drift < 0.05,
      "l'audio écrit doit durer ce que la capture a duré — {recorded:.2} s pour \
       {wall_clock:.2} s réelles, soit {:.1} % d'écart. Une cadence d'entrée mal lue produit \
       exactement ce symptôme, sans aucune erreur ailleurs.",
      drift * 100.0
    );
  }
  // ⚠️ **Le rapport de conversion est LE chiffre à regarder.** Il doit valoir la cadence
  // d'écriture divisée par la cadence d'entrée — 16 000 / 48 000 = 0,333. En dessous, on perd
  // des échantillons, et l'audio écrit est **plus court que le temps réel** : les deux flux
  // dérivent l'un par rapport à l'autre, et le décalage grandit avec la durée de la session.
  report_conversion(
    "système",
    before_stop.system_input_frames,
    before_stop.system_frames,
    before_stop.system_input_sample_rate,
    before_stop.system_dropped_buffers,
  );
  report_conversion(
    "micro",
    before_stop.microphone_input_frames,
    before_stop.microphone_frames,
    before_stop.microphone_input_sample_rate,
    before_stop.microphone_dropped_buffers,
  );
  assert!(
    !after_stop.running,
    "l'arrêt doit rendre la capture inactive"
  );

  let system_path = before_stop
    .system_path
    .expect("le flux système doit avoir un fichier");
  let system_bytes = size_of(&system_path);
  println!(
    "  système : {:>10} octets · {:>6.2} s · {} trames",
    system_bytes,
    seconds_of(system_bytes),
    before_stop.system_frames
  );

  match before_stop.microphone_path {
    Some(path) => {
      let bytes = size_of(&path);
      println!(
        "  micro   : {:>10} octets · {:>6.2} s · {} trames",
        bytes,
        seconds_of(bytes),
        before_stop.microphone_frames
      );
      // ⚠️ **Ce que la mesure sert à voir** : deux fichiers, deux tailles, deux compteurs. Un
      // seul fichier, ou deux fichiers identiques, voudrait dire que les flux se sont
      // rejoints quelque part — ce que tout ce module existe pour empêcher.
      assert_ne!(
        path, system_path,
        "les deux flux ne partagent pas leur fichier"
      );
    }
    None => println!("  micro   : absent (aucun micro demandé, ou non autorisé)"),
  }

  // ⚠️ Un compteur à zéro **n'est pas un échec de la brique** : c'est une machine qui ne jouait
  // rien. On le dit en clair plutôt que de faire échouer une mesure qui a bien fonctionné.
  if before_stop.system_frames == 0 {
    println!(
      "\n  ⚠️  Aucune trame système : rien ne jouait pendant la mesure, ou la source ne \
       produisait pas de son. Ce n'est pas un défaut de la capture."
    );
  }
  if before_stop.microphone_frames == 0 {
    println!("  ⚠️  Aucune trame micro : autorisation refusée, ou micro muet au niveau matériel.");
  }
  println!();
}

/// Le changement de périphérique de sortie en cours d'enregistrement.
///
/// ⚠️ **Ce test demande un geste humain**, et rien ne peut le remplacer : brancher ou
/// débrancher un casque pendant les vingt secondes. C'est un cas **réel et fréquent** — et
/// c'est celui où le flux se tarit en silence si l'agrégat n'est pas reconstruit.
///
/// Ce qu'on regarde : le compteur système **continue de monter après** le changement. S'il se
/// fige, la reconstruction n'a pas eu lieu.
#[test]
#[ignore = "demande de brancher un casque pendant la mesure — se lance à la main"]
fn the_stream_survives_an_output_device_change() {
  let folder = measurement_directory().to_string_lossy().to_string();

  println!("\n── Changement de sortie en cours d'enregistrement ──");
  println!("  Laissez quelque chose jouer, puis BRANCHEZ OU DÉBRANCHEZ un casque\n");

  app_lib::measure::live_start("system", None, &folder, None).expect("le tap doit s'ouvrir");

  let mut previous = 0_u64;
  let mut stalled = 0_u32;
  for elapsed in 1..=20 {
    thread::sleep(Duration::from_secs(1));
    let status = read_status();
    let delta = status.system_frames.saturating_sub(previous);
    if delta == 0 {
      stalled += 1;
    }
    println!(
      "  {elapsed:>2}s  {:>8} trames  (+{delta}){}",
      status.system_frames,
      if delta == 0 { "  ← figé" } else { "" }
    );
    previous = status.system_frames;
  }

  app_lib::measure::live_stop().expect("l'arrêt doit être propre");
  println!(
    "\n  {stalled} seconde(s) sans nouvelle trame. Quelques-unes sont normales — le temps de \
     reconstruire l'agrégat. Une dizaine veut dire que le flux ne s'est jamais rétabli.\n"
  );
}

/// Dit si un flux a perdu des échantillons en chemin, et de combien.
/// Ce que les deux moteurs ont entendu, flux par flux.
///
/// ⚠️ **ELLE RAPPORTE, ELLE N'AFFIRME PAS.** Ce qui sort dépend de ce que joue la machine et
/// de ce que dit l'opérateur : exiger du texte ferait échouer la mesure sur une machine
/// silencieuse, c'est-à-dire punir celui qui la lance au lieu de l'informer. Le seul verdict
/// automatique porte sur ce qui est vrai quoi qu'il arrive — un `failed` est **toujours** un
/// défaut, puisqu'il dit qu'un moteur n'a pas démarré.
fn report_transcript() {
  let collected = heard().lock().expect("verrou").clone();

  println!("\n── Transcription en direct ──");
  if collected.is_empty() {
    println!("  (rien) — la machine était-elle silencieuse ?");
  }

  let mut finals = 0_usize;
  for (label, text) in &collected {
    if label.ends_with("/final") {
      finals += 1;
      // ⚠️ Tronqué : ce rapport passe sous les yeux de qui lance la mesure, et un transcript
      // entier noierait les compteurs.
      let short: String = text.chars().take(64).collect();
      println!("  {label:<16} {short}");
    }
  }

  let hypotheses = collected.len() - finals;
  println!("  → {finals} segment(s) acquis, {hypotheses} hypothèse(s)");

  // ⚠️ **La dernière hypothèse de chaque flux est rapportée, même sans aucun final.** C'est ce
  // qui distingue « le moteur n'a rien entendu » de « le moteur tourne et n'a pas fini » — deux
  // situations qu'un compteur à zéro confondrait.
  for side in ["système", "micro"] {
    if let Some((_, text)) = collected
      .iter()
      .rfind(|(label, _)| label == &format!("{side}/partial"))
    {
      let short: String = text.chars().take(64).collect();
      println!("  dernière hypothèse {side:<8} {short}");
    }
  }

  for (label, text) in &collected {
    assert!(
      !label.ends_with("/failed"),
      "un moteur n'a pas démarré ({label}) : {text}"
    );
  }
}

fn report_conversion(label: &str, input: u64, output: u64, rate: f64, dropped: u64) {
  if input == 0 {
    println!("  {label:<8} : rien reçu — la source était silencieuse");
    return;
  }
  let observed = output as f64 / input as f64;
  let expected = 16_000.0 / rate.max(1.0);
  let loss = 1.0 - observed / expected;
  println!(
    "  {label:<8} : entrée {rate:.0} Hz · {input} → {output} trames · ratio {observed:.4} \
     (attendu {expected:.4}) · perte {:.2} % · {dropped} tampon(s) perdu(s)",
    loss * 100.0
  );
}

fn read_status() -> app_lib::measure::LiveCaptureStatus {
  parse(&app_lib::measure::live_status().expect("l'état doit être lisible à tout moment"))
}

/// **Le contrat de charge utile entre Swift et Rust, éprouvé sans matériel.**
///
/// ⚠️ Le seul test de ce fichier qui ne soit pas `#[ignore]`, et il vaut pour tous les autres :
/// `LiveCaptureStatusPayload` est écrit en Swift, `LiveCaptureStatus` en Rust, et rien ne les
/// tient ensemble qu'une relecture. Un champ ajouté d'un seul côté ne casse pas la compilation —
/// il casse la désérialisation, à l'exécution, au moment précis où quelqu'un enregistre.
///
/// ⚠️ Aucune capture n'est démarrée : la lecture de l'état est gratuite, n'ouvre rien et ne
/// demande aucune autorisation. C'est ce qui permet à cette épreuve de tourner partout.
#[test]
fn the_status_payload_still_matches_between_swift_and_rust() {
  let status = read_status();

  assert!(
    !status.running,
    "aucune capture ne tourne : ce test n'en démarre pas"
  );
  // Les compteurs d'écriture existent des deux côtés. Sans eux côté Swift, `parse` aurait déjà
  // échoué sur un champ manquant — c'est l'assertion réelle, celle-ci ne fait que la nommer.
  assert_eq!(status.system_write_failures, 0);
  assert_eq!(status.microphone_write_failures, 0);
}

/// Relit une charge utile du pont. Une mesure qui n'arrive pas à lire la réponse n'a rien à
/// rapporter : on s'arrête plutôt que d'imprimer des zéros trompeurs.
fn parse<T: serde::de::DeserializeOwned>(raw: &str) -> T {
  serde_json::from_str(raw).expect("la réponse du pont doit être lisible")
}
