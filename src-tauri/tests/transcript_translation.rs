//! Mesure : **traduire un transcript entier** par le Translation framework d'Apple.
//! `cargo test --test transcript_translation -- --ignored --nocapture`
//!
//! ⚠️ **`#[ignore]` par défaut** : ces mesures ouvrent le média de référence, hors dépôt
//! (`~/dev/mirmalion/media-test/`), et appellent le vrai framework.
//!
//! ⚠️ **Le travail se fait dans un processus fils, et c'est obligatoire.** Le framework livre
//! ses continuations par la boucle d'exécution principale (en-tête de `Translation.swift`), que
//! libtest ne rend jamais — pas même sous `--test-threads=1`. Pomper `CFRunLoopRunInMode`
//! depuis le fil de test ne sauve rien et ne le dit pas : l'appel rend `4` (*timed out*) comme
//! s'il travaillait, alors qu'il pompe la boucle d'un fil dont personne n'attend rien. Le fils,
//! lui, démarre une vraie boucle principale depuis un `__mod_init_func`, avant `main`.
//!
//! ⚠️ Ce constructeur lit son ordre de mission dans une **variable d'environnement**, jamais
//! dans `argv` : `std::env::args` n'est pas encore peuplé à cet instant.

use std::ffi::{CStr, CString, c_char, c_void};
use std::path::PathBuf;
use std::time::{Duration, Instant};

// Le pont, déclaré ici
//
// ⚠️ **Ces deux déclarations doublent celles de `src/native/mod.rs`, à contrecœur.** La place
// juste serait `app_lib::measure`, qui existe pour ça ; y ajouter `translate` demande de
// toucher `lib.rs`, ce que ce chantier n'a pas le droit de faire. **À reprendre** : exporter
// `crate::native::translate` dans `measure` et supprimer ce bloc.

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
  fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source_handled: u8) -> i32;
  static kCFRunLoopDefaultMode: *const c_void;
}

unsafe extern "C" {
  fn pthread_main_np() -> i32;
}

#[link(name = "MirmalionNative", kind = "dylib")]
unsafe extern "C" {
  fn mirmalion_free_string(pointer: *mut c_char);
  fn mirmalion_translate(
    source: *const c_char,
    target: *const c_char,
    text: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
}

/// Appelle le pont. ⚠️ **Jamais depuis le fil principal** : il bloque sur un sémaphore, et la
/// réponse arrive par la boucle principale — s'y bloquer est un interblocage définitif.
fn bridge_translate(source: &str, target: &str, text: &str) -> Result<String, String> {
  let source = CString::new(source).map_err(|_| "source non transmissible".to_owned())?;
  let target = CString::new(target).map_err(|_| "cible non transmissible".to_owned())?;
  let text = CString::new(text).map_err(|_| "texte non transmissible".to_owned())?;
  let mut out: *mut c_char = std::ptr::null_mut();
  let status =
    unsafe { mirmalion_translate(source.as_ptr(), target.as_ptr(), text.as_ptr(), &mut out) };
  if out.is_null() {
    return Err(format!("statut {status}, aucune sortie"));
  }
  let value = unsafe { CStr::from_ptr(out) }
    .to_string_lossy()
    .into_owned();
  unsafe { mirmalion_free_string(out) };
  if status == 0 {
    Ok(value)
  } else {
    Err(format!("statut {status} : {value}"))
  }
}

/// Le texte traduit d'une issue du pont, ou l'issue elle-même si elle n'a pas traduit.
fn translated_text(raw: &str) -> Result<String, String> {
  let value: serde_json::Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
  match value["kind"].as_str() {
    Some("translated") => Ok(value["text"].as_str().unwrap_or_default().to_owned()),
    _ => Err(raw.to_owned()),
  }
}

// LE PROCESSUS FILS — la seule configuration où le framework répond

/// La variable qui dit au fils quel transcript mesurer. Absente = binaire de test ordinaire.
const CHILD_ENV: &str = "MIRMALION_TRANSLATION_MEASURE";

/// ⚠️ **Ce pointeur de fonction est appelé par dyld sur le FIL PRINCIPAL, avant `main`.**
/// C'est tout l'intérêt : après `main`, libtest ne rend plus jamais ce fil.
#[used]
#[unsafe(link_section = "__DATA,__mod_init_func")]
static MEASURE_CTOR: extern "C" fn() = child_entry;

extern "C" fn child_entry() {
  let Ok(transcript) = std::env::var(CHILD_ENV) else {
    // Binaire de test ordinaire : on ne fait rien du tout et libtest suit son cours.
    return;
  };
  let code = i32::from(!run_child(&PathBuf::from(transcript)));
  std::process::exit(code);
}

/// Le corps de la mesure, sur le fil principal du fils.
fn run_child(transcript: &std::path::Path) -> bool {
  println!("fil principal : {}", unsafe { pthread_main_np() } == 1);
  let Ok(raw) = std::fs::read_to_string(transcript) else {
    println!("transcript illisible : {}", transcript.display());
    return false;
  };
  let Ok(turns) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
    println!("transcript non relisible");
    return false;
  };
  let texts: Vec<String> = turns
    .iter()
    .map(|turn| turn["text"].as_str().unwrap_or_default().to_owned())
    .collect();

  let ok = pumping_the_main_run_loop(Duration::from_secs(900), move || measure(&texts));
  ok.unwrap_or_else(|| {
    println!("DÉLAI DÉPASSÉ — le framework n'a pas répondu");
    false
  })
}

/// Fait tourner `work` sur un fil de fond **pendant que le fil courant fait vivre la boucle
/// principale**. `None` au bout de `timeout`.
///
/// ⚠️ **N'a de sens que sur le fil principal.** Sur un autre, il pompe une boucle que personne
/// n'alimente et rend `4` indéfiniment — l'essai qui a fait perdre le plus de temps.
fn pumping_the_main_run_loop<T: Send + 'static>(
  timeout: Duration,
  work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
  let handle = std::thread::spawn(work);
  let started = Instant::now();
  while !handle.is_finished() {
    if started.elapsed() > timeout {
      return None;
    }
    unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, 0) };
  }
  handle.join().ok()
}

/// La séparation des tours dans un appel groupé.
///
/// ⚠️ **Un saut de ligne simple**, et c'est ce que la mesure éprouve : si le framework le
/// préserve, un appel peut porter plusieurs tours ; s'il le perd, il faut un appel par tour.
const JOIN: &str = "\n";

/// Ce que le fils rapporte. **Il n'affirme rien, il mesure.**
fn measure(texts: &[String]) -> bool {
  let source = "fr";
  let total_chars: usize = texts.iter().map(|text| text.chars().count()).sum();
  let total_words: usize = texts
    .iter()
    .map(|text| text.split_whitespace().count())
    .sum();
  println!(
    "transcript : {} tours, {total_words} mots, {total_chars} caractères",
    texts.len()
  );

  let mut healthy = true;

  // ── 1. Un tour à la fois : la référence, et le pire cas en nombre de sessions.
  println!("\n── un appel par tour ───────────────────────────────────────────");
  let started = Instant::now();
  let mut translated = 0_usize;
  for text in texts {
    match bridge_translate(source, "en", text).and_then(|raw| translated_text(&raw)) {
      Ok(_) => translated += 1,
      Err(error) => {
        println!("  échec : {error}");
        healthy = false;
        break;
      }
    }
  }
  let one_by_one = started.elapsed();
  println!(
    "  {translated}/{} tours en {:.2} s ({:.0} ms par tour)",
    texts.len(),
    one_by_one.as_secs_f64(),
    one_by_one.as_secs_f64() * 1000.0 / texts.len().max(1) as f64
  );

  // ── 2. Le transcript ENTIER en un seul appel : ce que la fiche demande de vérifier.
  println!("\n── le transcript entier en un appel ────────────────────────────");
  let whole = texts.join(JOIN);
  let started = Instant::now();
  match bridge_translate(source, "en", &whole).and_then(|raw| translated_text(&raw)) {
    Ok(output) => {
      let lines = output.split(JOIN).count();
      println!(
        "  {} caractères → {} caractères en {:.2} s",
        whole.chars().count(),
        output.chars().count(),
        started.elapsed().as_secs_f64()
      );
      println!(
        "  lignes : {} envoyées → {lines} rendues{}",
        texts.len(),
        if lines == texts.len() {
          "  ✔ la structure survit"
        } else {
          "  ✘ LA STRUCTURE EST PERDUE"
        }
      );
    }
    Err(error) => {
      println!("  échec : {error}");
      healthy = false;
    }
  }

  // ── 3. Par paquets de tours : combien de tours par appel, et à quel prix ?
  for size in [2_usize, 5, 10, 25, 50] {
    if size > texts.len() {
      break;
    }
    println!("\n── paquets de {size} tours ───────────────────────────────────────");
    let started = Instant::now();
    let mut calls = 0_usize;
    let mut intact = 0_usize;
    for group in texts.chunks(size) {
      let joined = group.join(JOIN);
      calls += 1;
      match bridge_translate(source, "en", &joined).and_then(|raw| translated_text(&raw)) {
        Ok(output) => {
          if output.split(JOIN).count() == group.len() {
            intact += 1;
          }
        }
        Err(error) => {
          println!("  échec : {error}");
          healthy = false;
          break;
        }
      }
    }
    let elapsed = started.elapsed();
    println!(
      "  {calls} appels, {:.2} s ({:.0} ms par appel) — structure intacte sur {intact}/{calls}",
      elapsed.as_secs_f64(),
      elapsed.as_secs_f64() * 1000.0 / calls.max(1) as f64
    );
  }

  // ── 4. Jusqu'où va un seul appel ? On empile le transcript sur lui-même.
  println!("\n── longueur croissante, un seul appel ──────────────────────────");
  let unit = texts.join(" ");
  for repeats in [1_usize, 2, 4, 8] {
    let text = std::iter::repeat_n(unit.as_str(), repeats)
      .collect::<Vec<_>>()
      .join(" ");
    let chars = text.chars().count();
    let started = Instant::now();
    match bridge_translate(source, "en", &text).and_then(|raw| translated_text(&raw)) {
      Ok(output) => println!(
        "  {chars} caractères → {} en {:.2} s",
        output.chars().count(),
        started.elapsed().as_secs_f64()
      ),
      Err(error) => println!("  {chars} caractères → ÉCHEC : {error}"),
    }
  }

  // ── 5. Trois paires, comme le demande la DoD.
  println!("\n── trois paires sur le transcript entier ───────────────────────");
  for target in ["en", "es", "it"] {
    let started = Instant::now();
    match bridge_translate(source, target, &whole).and_then(|raw| translated_text(&raw)) {
      Ok(output) => println!(
        "  fr→{target} : {} lignes rendues sur {} en {:.2} s",
        output.split(JOIN).count(),
        texts.len(),
        started.elapsed().as_secs_f64()
      ),
      Err(error) => {
        println!("  fr→{target} : {error}");
        healthy = false;
      }
    }
  }

  healthy
}

// LE PROCESSUS PÈRE — il fabrique le transcript, puis délègue

fn media_dir() -> PathBuf {
  PathBuf::from(std::env::var("HOME").expect("HOME"))
    .join("dev")
    .join("mirmalion")
    .join("media-test")
}

fn some_media() -> Option<PathBuf> {
  let mut found: Vec<PathBuf> = std::fs::read_dir(media_dir())
    .ok()?
    .filter_map(|entry| entry.ok())
    .map(|entry| entry.path())
    .filter(|path| {
      path.is_file()
        && !path
          .file_name()
          .is_some_and(|name| name.to_string_lossy().starts_with('.'))
    })
    .collect();
  found.sort();
  found.into_iter().next()
}

/// Le transcript du média de référence, **réellement transcrit et diarisé**.
///
/// ⚠️ **Mis en cache sur le disque.** Transcrire et diariser coûtent une dizaine de secondes ;
/// la mesure de traduction se rejoue, elle, souvent. Supprimer le fichier suffit à repartir
/// du média.
fn reference_turns() -> PathBuf {
  let cache = std::env::temp_dir().join("mirmalion-transcript-de-mesure.json");
  if cache.is_file() {
    println!("transcript : repris de {}", cache.display());
    return cache;
  }
  let path = some_media().unwrap_or_else(|| panic!("aucun média dans {}", media_dir().display()));
  println!("média : {}", path.display());
  let path = path.to_string_lossy().to_string();

  let words_json =
    app_lib::measure::file_transcribe(&path, "fr", &mut |_| true).expect("transcription");
  let parsed: serde_json::Value = serde_json::from_str(&words_json).expect("json");
  let words: Vec<app_lib::measure::Word> =
    serde_json::from_value(parsed["words"].clone()).expect("mots");

  // ⚠️ La diarisation ne sert pas à composer le transcript : il se découpe par le silence. Ce
  // que la traduction reçoit est donc exactement ce que la fenêtre affiche.
  let transcript = app_lib::measure::Transcript::of(&words, "fr");
  let rendered = serde_json::to_string(&transcript.rendered()).expect("sérialisation");
  std::fs::write(&cache, rendered).expect("écriture du cache");
  cache
}

#[test]
#[ignore = "transcrit, diarise et traduit un média réel — plusieurs minutes"]
fn how_the_framework_behaves_on_a_whole_transcript() {
  let transcript = reference_turns();
  let binary = std::env::current_exe().expect("binaire de test");

  // ⚠️ **On relance NOTRE PROPRE binaire**, dont le constructeur détournera le fil principal.
  // Aucun exécutable à construire à côté, donc rien à maintenir en double.
  let output = std::process::Command::new(&binary)
    .env(CHILD_ENV, &transcript)
    .output()
    .expect("le fils doit démarrer");

  println!("{}", String::from_utf8_lossy(&output.stdout));
  let errors = String::from_utf8_lossy(&output.stderr);
  if !errors.trim().is_empty() {
    println!("[erreurs du fils] {errors}");
  }

  // ⚠️ **L'instrument se prouve avant qu'on croie son chiffre.** Sans boucle principale
  // vivante, le fils aurait rendu « fil principal : false » ou serait mort au délai — et
  // toutes les lignes ci-dessus auraient été des zéros crédibles.
  assert!(
    String::from_utf8_lossy(&output.stdout).contains("fil principal : true"),
    "le constructeur n'a pas attrapé le fil principal"
  );
  assert!(output.status.success(), "la mesure a rapporté un échec");
}
