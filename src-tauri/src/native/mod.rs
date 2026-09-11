// ⚠️ La dérogation du crate à `undocumented_unsafe_blocks`, et la seule. Les appels de pont
// ci-dessous partagent tous le même contrat, écrit une fois sur le bloc `extern "C"` ; le
// recopier soixante fois n'ajouterait aucune garantie et en retirerait la lisibilité. Un
// `unsafe` qui sort de ce contrat porte, lui, son propre `// SAFETY:`.
#![allow(clippy::undocumented_unsafe_blocks)]

//! Le pont vers la bibliothèque Swift `MirmalionNative`.
//!
//! Toutes les briques Apple (SpeechTranscriber, Translation, FoundationModels, Core Audio
//! Taps) et FluidAudio passent par ici. Contrat, identique côté Swift
//! (`native/Sources/MirmalionNative/Bridge.swift`) : chaque export rend un statut `i32` — `0`
//! succès, `2` le résultat n'existe pas (voir [`call_optional`]), tout le reste échec ; le
//! résultat, ou le message d'erreur, arrive par un paramètre de sortie `*mut *mut c_char`.
//!
//! # Pièges
//!
//! - ⚠️ Ce module est la seule frontière `unsafe` du backend : au-dessus, tout est
//!   `Result<_, AppError>`, et aucun `unsafe` ne doit remonter plus haut.
//! - ⚠️ Swift alloue les chaînes, Swift les libère : Rust lit puis rappelle
//!   `mirmalion_free_string`. Jamais de `libc::free` ici.

use std::ffi::{CStr, c_char, c_void};

use crate::error::AppError;

/// Statut de succès du pont. Voir `statusOK` dans `Bridge.swift`.
const STATUS_OK: i32 = 0;
/// Ce qui était demandé n'existe pas — **ce n'est pas une erreur**. Voir `statusNotFound`.
const STATUS_NOT_FOUND: i32 = 2;

// SAFETY: appeler l'un de ces exports demande, sauf mention contraire sur sa déclaration, que
// chaque argument chaîne soit une `CString` vivante pendant tout l'appel — c'est ce que garantit
// `argument` —, que `out` soit un `*mut *mut c_char` initialisé à nul, et que la chaîne rendue
// soit libérée par `mirmalion_free_string`, ce dont `take_string` se charge. Les emprunteurs
// de pointeurs opaques ajoutent leurs propres conditions, écrites sur la fonction Rust qui les
// expose.
unsafe extern "C" {
  fn mirmalion_free_string(pointer: *mut c_char);
  fn mirmalion_capabilities(out: *mut *mut c_char) -> i32;
  fn mirmalion_preferred_language(out: *mut *mut c_char) -> i32;
  fn mirmalion_permissions_status(out: *mut *mut c_char) -> i32;
  fn mirmalion_request_microphone(out: *mut *mut c_char) -> i32;
  fn mirmalion_request_audio_capture(out: *mut *mut c_char) -> i32;
  fn mirmalion_request_accessibility(out: *mut *mut c_char) -> i32;
  fn mirmalion_list_input_devices(out: *mut *mut c_char) -> i32;
  fn mirmalion_start_capture(device_id: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_stop_capture(out: *mut *mut c_char) -> i32;
  fn mirmalion_capture_status(out: *mut *mut c_char) -> i32;
  fn mirmalion_list_audio_sources(out: *mut *mut c_char) -> i32;
  fn mirmalion_live_start(
    source_id: *const c_char,
    microphone_device_id: *const c_char,
    directory: *const c_char,
    locale: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_live_stop(out: *mut *mut c_char) -> i32;
  fn mirmalion_live_set_transcript_observer(
    observer: Option<TranscriptionObserver>,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_live_status(out: *mut *mut c_char) -> i32;
  fn mirmalion_stt_capabilities(out: *mut *mut c_char) -> i32;
  fn mirmalion_stt_set_observer(
    observer: Option<TranscriptionObserver>,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_assets_set_observer(
    observer: Option<AssetInstallObserver>,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_install_language(language: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_cancel_language_install(out: *mut *mut c_char) -> i32;
  fn mirmalion_language_install_in_flight(out: *mut *mut c_char) -> i32;
  fn mirmalion_locale_reservations(out: *mut *mut c_char) -> i32;
  fn mirmalion_release_locale(language: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_stt_start(locale: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_stt_finish(out: *mut *mut c_char) -> i32;
  fn mirmalion_stt_cancel(out: *mut *mut c_char) -> i32;
  fn mirmalion_shortcut_set_observer(
    observer: Option<ShortcutObserver>,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_shortcut_start(out: *mut *mut c_char) -> i32;
  fn mirmalion_shortcut_stop(out: *mut *mut c_char) -> i32;
  fn mirmalion_shortcut_status(out: *mut *mut c_char) -> i32;
  fn mirmalion_insert_at_cursor(text: *const c_char, target: i32, out: *mut *mut c_char) -> i32;
  fn mirmalion_focus_verdict(out: *mut *mut c_char) -> i32;
  fn mirmalion_focus_target(out: *mut *mut c_char) -> i32;
  /// ⚠️ Seul export dont un argument n'est pas une chaîne : il reçoit un `NSWindow`.
  fn mirmalion_center_window_buttons(
    window: *mut c_void,
    header_height: f64,
    leading: f64,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_set_dock_icon(path: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_resize_window_animated(
    window: *mut c_void,
    width: f64,
    height: f64,
    duration: f64,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_configure_overlay_window(
    window: *mut c_void,
    top_margin: f64,
    corner_radius: f64,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_present_overlay_window(window: *mut c_void, out: *mut *mut c_char) -> i32;
  fn mirmalion_resize_overlay_window(
    window: *mut c_void,
    width: f64,
    height: f64,
    top_margin: f64,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_fade_out_overlay_window(window: *mut c_void, out: *mut *mut c_char) -> i32;
  fn mirmalion_refresh_webview(window: *mut c_void, out: *mut *mut c_char) -> i32;
  fn mirmalion_keychain_read(
    service: *const c_char,
    account: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_keychain_create_key(
    service: *const c_char,
    account: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  /// Destructif : la base devient illisible. Réservé aux tests.
  #[cfg(test)]
  fn mirmalion_keychain_delete(
    service: *const c_char,
    account: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  /// Export de référence, jamais exposé en IPC : il sert de banc d'essai à la frontière.
  #[cfg(test)]
  fn mirmalion_echo(input: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_media_inspect(path: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_diarize(path: *const c_char, threshold: f64, out: *mut *mut c_char) -> i32;

  fn mirmalion_voice_match(
    first: *const c_char,
    second: *const c_char,
    threshold: f64,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_detect_language(path: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_detect_text_language(text: *const c_char, out: *mut *mut c_char) -> i32;
  fn mirmalion_file_transcribe(
    path: *const c_char,
    locale: *const c_char,
    context: *mut std::ffi::c_void,
    on_progress: extern "C" fn(*mut std::ffi::c_void, f64) -> bool,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_llm_capabilities(out: *mut *mut c_char) -> i32;
  fn mirmalion_llm_clean(
    text: *const c_char,
    language: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_llm_rephrase(
    text: *const c_char,
    style: *const c_char,
    custom_prompt: *const c_char,
    language: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_llm_title(
    text: *const c_char,
    language: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_llm_report(
    text: *const c_char,
    stage: *const c_char,
    kind: *const c_char,
    custom_prompt: *const c_char,
    language: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_translation_availability(out: *mut *mut c_char) -> i32;
  fn mirmalion_prepare_translation(
    window: *mut c_void,
    target: *const c_char,
    source: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_translate(
    source: *const c_char,
    target: *const c_char,
    text: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_export_pdf(
    payload: *const c_char,
    path: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
  fn mirmalion_copy_rich_text(
    html: *const c_char,
    plain: *const c_char,
    out: *mut *mut c_char,
  ) -> i32;
}

/// Lit une chaîne renvoyée par le pont, puis la rend à Swift.
///
/// Un pointeur nul donne une chaîne vide plutôt qu'une erreur : c'est à l'appelant de
/// décider si l'absence de message est un problème, en fonction du statut.
///
/// # Pièges
///
/// - ⚠️ Privée, et elle doit le rester : elle **libère** le pointeur qu'on lui donne. Ses deux
///   appelants — [`call`] et [`call_optional`] — sont les seuls à savoir qu'il vient du pont et
///   n'a jamais été rendu. L'exposer ferait de cette garantie une convention, donc un oubli.
fn take_string(pointer: *mut c_char) -> String {
  if pointer.is_null() {
    return String::new();
  }
  // SAFETY: le pont ne place dans `out` que des chaînes C valides issues de `strdup`.
  let value = unsafe { CStr::from_ptr(pointer) }
    .to_string_lossy()
    .into_owned();
  // SAFETY: même pointeur, rendu une seule fois — l'appelant ne le revoit jamais.
  unsafe { mirmalion_free_string(pointer) };
  value
}

/// Exécute un export du pont et traduit son statut en `Result`.
///
/// # Errors
///
/// Rend [`AppError::Native`] dès que le statut n'est pas [`STATUS_OK`], en portant le message
/// de Swift ou, à défaut, le statut brut.
fn call(invoke: impl FnOnce(*mut *mut c_char) -> i32) -> Result<String, AppError> {
  let mut out: *mut c_char = std::ptr::null_mut();
  let status = invoke(&mut out);
  let payload = take_string(out);

  if status == STATUS_OK {
    Ok(payload)
  } else if payload.is_empty() {
    Err(AppError::Native(format!(
      "le pont natif a renvoyé le statut {status} sans message"
    )))
  } else {
    Err(AppError::Native(payload))
  }
}

/// Comme [`call`], mais pour un export dont le résultat peut légitimement ne pas exister.
///
/// # Errors
///
/// Rend [`AppError::Native`] sur tout statut autre que [`STATUS_OK`] et [`STATUS_NOT_FOUND`].
///
/// # Pièges
///
/// - ⚠️ `Ok(None)` et `Err` ne sont pas interchangeables : le premier dit « il n'y en a jamais
///   eu », le second « on n'a pas pu savoir ». Sur la clé de chiffrement, confondre les deux
///   fait générer une clé neuve par-dessus une base existante, et la rend illisible pour
///   toujours.
fn call_optional(invoke: impl FnOnce(*mut *mut c_char) -> i32) -> Result<Option<String>, AppError> {
  let mut out: *mut c_char = std::ptr::null_mut();
  let status = invoke(&mut out);
  let payload = take_string(out);

  match status {
    STATUS_OK => Ok(Some(payload)),
    STATUS_NOT_FOUND => Ok(None),
    _ if payload.is_empty() => Err(AppError::Native(format!(
      "le pont natif a renvoyé le statut {status} sans message"
    ))),
    _ => Err(AppError::Native(payload)),
  }
}

// La condition dont dépend `guarded`, refusée par le compilateur plutôt que par la relecture :
// avec `panic = "abort"` le `catch_unwind` ci-dessous ne rattrape plus rien, les cinq rappels
// redeviennent mortels, et **rien ne le signalerait** — ni un test, ni un avertissement. Le
// profil de production n'a aujourd'hui aucune ligne `panic` ; le jour où quelqu'un en ajoutera
// une pour gagner quelques kilo-octets, il tombera ici.
#[cfg(panic = "abort")]
compile_error!(
  "`panic = \"abort\"` désarme `native::guarded` : une panique dans un rappel du pont \
   avorterait le processus en pleine session. Retirer le garde en connaissance de cause, \
   ou garder le déroulement de pile."
);

/// Exécute le corps d'un rappel venu du pont, et **survit à sa panique**.
///
/// Rend `None` si `body` a paniqué : à l'appelant de dire ce que vaut cette absence.
///
/// # Pièges
///
/// - ⚠️ Une panique qui traverse un `extern "C"` **avorte le processus** — une session de deux
///   heures disparaît sans un mot. Ici, elle ne coûte que l'évènement en cours.
/// - ⚠️ Le message de panique n'est pas journalisé : il porte volontiers la valeur qui a fait
///   échouer l'indexation, donc du contenu utilisateur.
pub fn guarded<T>(what: &'static str, body: impl FnOnce() -> T) -> Option<T> {
  // ⚠️ `AssertUnwindSafe` est posé ici plutôt que chez les cinq appelants, parce que c'est ici
  // que la raison se vérifie : l'état qu'ils partagent se reprend après empoisonnement — voir
  // `LiveSession::locked` et `ShortcutState`. Un verrou lâché en pleine écriture est relu au
  // rappel suivant, il ne le fait pas paniquer à son tour.
  std::panic::catch_unwind(std::panic::AssertUnwindSafe(body))
    .inspect_err(|_| log::error!("rappel natif « {what} » interrompu par une panique"))
    .ok()
}

/// Relit une charge utile du pont, en nommant ce qui n'a pas pu être lu.
///
/// # Errors
///
/// Rend [`AppError::Native`] si `raw` n'est pas un JSON conforme à `T`.
///
/// # Pièges
///
/// - ⚠️ **La position, jamais le message de `serde`.** Son `Display` cite la valeur inattendue —
///   `invalid type: string "…", expected u32` —, et cette valeur est la charge utile du pont :
///   du texte dicté, un transcript, un nom de fichier. Ligne et colonne suffisent à diagnostiquer.
pub fn parse<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T, AppError> {
  serde_json::from_str(raw).map_err(|error| {
    AppError::Native(format!(
      "la réponse du pont pour {what} est illisible (ligne {}, colonne {})",
      error.line(),
      error.column()
    ))
  })
}

#[cfg(test)]
mod guarded_tests {
  use super::{guarded, progress_trampoline};

  #[test]
  fn what_the_body_returns_comes_back_untouched() {
    assert_eq!(guarded("un calcul", || 6 * 7), Some(42));
  }

  #[test]
  fn a_panic_becomes_an_absence_instead_of_a_death() {
    // ⚠️ La trace de panique qui s'affiche pendant ce test est attendue : elle vient du
    // gestionnaire par défaut de Rust, que `catch_unwind` n'empêche pas d'écrire.
    let lost: Option<u8> = guarded("un calcul", || panic!("le corps s'arrête net"));
    assert_eq!(lost, None);
  }

  /// ⚠️ **L'épreuve du garde.** Sans lui, la panique traverse la frontière C et avorte le
  /// processus : ce n'est pas ce test qui échoue, c'est la suite entière qui meurt sur un signal.
  #[test]
  fn a_panicking_progress_callback_stops_the_work_and_not_the_process() {
    let mut body = |_ratio: f64| -> bool { panic!("l'avancement s'arrête net") };
    let mut erased: &mut dyn FnMut(f64) -> bool = &mut body;
    let context = std::ptr::from_mut(&mut erased).cast::<std::ffi::c_void>();

    // `erased` vit jusqu'à la fin de la fonction, et le trampoline n'en garde rien : c'est le
    // même contrat que `file_transcribe`, qui attend le retour du pont.
    let keep_going = progress_trampoline(context, 0.5);

    assert!(
      !keep_going,
      "une fermeture qui panique doit interrompre la transcription, pas la poursuivre"
    );
  }
}

#[cfg(test)]
mod optional_tests {
  use super::{optional, optional_ptr};

  #[test]
  fn an_absent_value_travels_as_a_null_pointer() {
    let absent = optional(None, "le prompt").expect("une absence n'est pas une erreur");
    assert!(absent.is_none());
    assert!(optional_ptr(absent.as_ref()).is_null());
  }

  #[test]
  fn a_value_travels_as_a_pointer_that_is_not_null() {
    let present = optional(Some("bref"), "le prompt").expect("une valeur passe");
    assert!(!optional_ptr(present.as_ref()).is_null());
  }

  /// ⚠️ Le cœur de la convention : « fourni mais vide » n'est pas « absent ». Les replier l'un
  /// sur l'autre est exactement ce que faisait la chaîne vide, et le pont ne pouvait alors plus
  /// distinguer un prompt personnalisé effacé d'un prompt jamais écrit.
  #[test]
  fn a_value_that_is_present_but_empty_is_refused_rather_than_read_as_absent() {
    let error = optional(Some(""), "le prompt").expect_err("le vide fourni est refusé");
    assert_eq!(error.kind(), "invalidArgument");
    assert!(
      error.to_string().contains("le prompt"),
      "le message doit nommer l'argument, reçu : {error}"
    );
  }

  #[test]
  fn an_interior_null_byte_is_refused_like_it_is_for_a_required_argument() {
    let error = optional(Some("a\0b"), "le prompt").expect_err("un octet nul est refusé");
    assert_eq!(error.kind(), "invalidArgument");
  }

  /// ⚠️ La porte qu'on a vue s'ouvrir toute seule. L'autre convention — une chaîne vide plutôt
  /// qu'un pointeur nul — se réécrit en une ligne, ne casse **rien**, et fait perdre au pont la
  /// distinction entre « effacé » et « jamais fourni ». Un export sur deux la choisissait.
  #[test]
  fn no_export_goes_back_to_the_empty_string_convention() {
    // ⚠️ Le motif s'assemble plutôt qu'il ne s'écrit : ce fichier est sa propre matière, et un
    // relevé qui se citerait lui-même tomberait sur son propre message.
    let needle = concat!("CString", "::default()");
    let offenders = include_str!("mod.rs")
      .lines()
      .filter(|line| line.contains(needle))
      .count();
    assert_eq!(
      offenders, 0,
      "une chaîne facultative se passe par `optional` et `optional_ptr` : {needle} rend un \
       pointeur non nul, que Swift lit comme une valeur fournie"
    );
  }
}

#[cfg(test)]
mod parse_tests {
  use super::parse;

  #[test]
  fn a_malformed_bridge_answer_becomes_a_native_error() {
    let error = parse::<Vec<String>>("{", "les sources audio").expect_err("un JSON tronqué échoue");
    assert_eq!(error.kind(), "native");
    assert!(
      error.to_string().contains("les sources audio"),
      "le message doit dire ce qui n'a pas pu être lu, reçu : {error}"
    );
  }

  /// ⚠️ L'épreuve de la règle « aucun contenu utilisateur dans un message » sur ce chemin-là.
  /// Le `Display` de `serde_json` cite la valeur inattendue : interpolé, il ferait traverser au
  /// message le texte que le pont transportait.
  #[test]
  fn the_payload_never_crosses_into_the_message() {
    let dictated = "compte rendu de l'entretien de Camille";
    let raw = format!("{{\"count\": \"{dictated}\"}}");

    let error = parse::<std::collections::HashMap<String, u32>>(&raw, "un compteur")
      .expect_err("une chaîne là où un nombre est attendu doit échouer");

    let message = error.to_string();
    assert!(
      !message.contains("Camille") && !message.contains(dictated),
      "la charge utile a traversé : {message}"
    );
    assert!(
      message.contains("ligne") && message.contains("colonne"),
      "il reste à dire où, faute de dire quoi : {message}"
    );
  }
}

/// Reclasse une erreur du pont en [`AppError::Keychain`] : c'est ce qui permet au frontend,
/// et aux appelants, de reconnaître une défaillance du trousseau sans lire un message.
fn as_keychain_error(error: AppError) -> AppError {
  match error {
    AppError::Native(message) => AppError::Keychain(message),
    other => other,
  }
}

/// Même chose pour les autorisations macOS : le frontend branche sur `kind`, pas sur le texte.
fn as_permission_error(error: AppError) -> AppError {
  match error {
    AppError::Native(message) => AppError::Permission(message),
    other => other,
  }
}

/// Convertit une chaîne Rust en chaîne C, en refusant l'octet nul et la chaîne vide.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `value` est vide ou porte un octet nul intérieur —
/// une chaîne C tronquée silencieusement ne doit jamais atteindre le pont.
fn argument(value: &str, name: &str) -> Result<std::ffi::CString, AppError> {
  if value.is_empty() {
    return Err(AppError::InvalidArgument(format!("{name} est vide")));
  }
  std::ffi::CString::new(value).map_err(|_| {
    AppError::InvalidArgument(format!(
      "{name} contient un octet nul, il ne peut pas traverser le pont"
    ))
  })
}

/// Une chaîne **facultative**, telle que le pont la reçoit : l'absence est un pointeur nul.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si la valeur fournie est vide ou porte un octet nul :
/// « fourni mais vide » n'est pas « absent ».
///
/// # Pièges
///
/// - ⚠️ La `CString` rendue doit rester vivante pendant tout l'appel : la lier à un `let`, jamais
///   l'appeler dans la liste d'arguments — le temporaire mourrait avant que Swift n'ait lu.
/// - ⚠️ Le pointeur se prend par [`optional_ptr`], jamais d'un repli sur la chaîne vide.
fn optional(value: Option<&str>, name: &str) -> Result<Option<std::ffi::CString>, AppError> {
  value.map(|value| argument(value, name)).transpose()
}

/// Le pointeur d'une chaîne facultative : nul quand elle est absente.
fn optional_ptr(value: Option<&std::ffi::CString>) -> *const std::os::raw::c_char {
  value.map_or(std::ptr::null(), |value| value.as_ptr())
}

/// Lit la clé de chiffrement dans le trousseau.
///
/// `Ok(None)` dit qu'il n'y en a jamais eu : seul cas où en créer une est légitime.
///
/// # Errors
///
/// Rend [`AppError::Keychain`] si la lecture n'a pas pu aboutir : trousseau verrouillé, item
/// corrompu, accès refusé.
///
/// # Pièges
///
/// - ⚠️ Ne jamais créer de clé sur ce chemin d'erreur : elle écraserait une base existante,
///   qui deviendrait illisible pour toujours.
pub fn keychain_read(service: &str, account: &str) -> Result<Option<String>, AppError> {
  let service = argument(service, "service")?;
  let account = argument(account, "account")?;
  call_optional(|out| unsafe { mirmalion_keychain_read(service.as_ptr(), account.as_ptr(), out) })
    .map_err(as_keychain_error)
}

/// Génère une clé de 256 bits et la dépose, en hexadécimal minuscule.
///
/// # Errors
///
/// Rend [`AppError::Keychain`] si le dépôt échoue, notamment quand une clé existe déjà : le
/// pont ne remplace jamais une clé en place.
pub fn keychain_create_key(service: &str, account: &str) -> Result<String, AppError> {
  let service = argument(service, "service")?;
  let account = argument(account, "account")?;
  call(|out| unsafe { mirmalion_keychain_create_key(service.as_ptr(), account.as_ptr(), out) })
    .map_err(as_keychain_error)
}

/// Supprime la clé. Réservé aux tests.
///
/// # Errors
///
/// Rend [`AppError::Keychain`] si le trousseau refuse la suppression.
///
/// # Pièges
///
/// - ⚠️ Irréversible : sans sa clé, la base chiffrée devient illisible.
#[cfg(test)]
pub fn keychain_delete(service: &str, account: &str) -> Result<(), AppError> {
  let service = argument(service, "service")?;
  let account = argument(account, "account")?;
  call(|out| unsafe { mirmalion_keychain_delete(service.as_ptr(), account.as_ptr(), out) })
    .map_err(as_keychain_error)
    .map(|_| ())
}

/// Ce dont cette machine dispose, en JSON brut.
///
/// Le schéma est produit par `native/Sources/MirmalionNative/Capabilities.swift` et
/// désérialisé dans `crate::commands::system` — c'est là que vit le type, pas ici.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn capabilities() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_capabilities(out) })
}

/// L'état des quatre autorisations macOS, en JSON brut.
///
/// Le schéma vit dans `crate::commands::permissions`, en miroir de
/// `native/Sources/MirmalionNative/Permissions.swift`.
///
/// # Errors
///
/// Rend [`AppError::Permission`] si l'état n'a pas pu être lu.
///
/// # Pièges
///
/// - ⚠️ Cet appel ne doit jamais faire surgir de pop-up TCC : la garantie est côté Swift, où
///   chaque lecture emploie l'API de préflight de sa permission.
pub fn permissions_status() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_permissions_status(out) }).map_err(as_permission_error)
}

/// Demande l'accès au micro et rend l'état obtenu, en JSON — même forme qu'une permission de
/// [`permissions_status`].
///
/// # Errors
///
/// Rend [`AppError::Permission`] si la demande n'a pas pu être posée.
///
/// # Pièges
///
/// - ⚠️ L'un des deux appels du pont autorisés à faire surgir un prompt, et il bloque jusqu'à
///   la réponse de l'utilisateur, sans délai maximal. À n'appeler que depuis
///   `spawn_blocking`, jamais depuis le fil principal.
pub fn request_microphone() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_request_microphone(out) }).map_err(as_permission_error)
}

/// Demande l'enregistrement audio et rend l'état obtenu, en JSON — même forme qu'une
/// permission de [`permissions_status`]. Bloque au premier appel, jusqu'à la réponse.
///
/// # Errors
///
/// Rend [`AppError::Permission`] si la demande n'a pas pu être posée.
///
/// # Pièges
///
/// - ⚠️ Le seul appel qui demande en créant la chose : cette catégorie TCC n'a pas d'API de
///   préflight. Le tap créé est détruit aussitôt et ne produit aucun échantillon.
/// - ⚠️ `spawn_blocking` obligatoire : l'attente n'a pas de délai maximal.
pub fn request_audio_capture() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_request_audio_capture(out) }).map_err(as_permission_error)
}

/// Inscrit l'application dans la liste Accessibilité, ouvre le volet, et rend l'état courant
/// en JSON.
///
/// # Errors
///
/// Rend [`AppError::Permission`] si l'inscription ou la lecture échoue.
///
/// # Pièges
///
/// - ⚠️ L'inscription est le point important : sans l'option de prompt d'`AXIsProcessTrusted`,
///   l'application n'apparaît nulle part dans le volet et l'utilisateur n'a rien à cocher.
///   Voir `requestAccessibility` côté Swift.
pub fn request_accessibility() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_request_accessibility(out) }).map_err(as_permission_error)
}

/// Les entrées audio de la machine, en JSON.
///
/// Ne demande aucune autorisation : la HAL énumère sans rien ouvrir, ce qui permet de remplir
/// le sélecteur de micro avant même que l'autorisation soit accordée.
///
/// # Errors
///
/// Rend [`AppError::Native`] si l'énumération échoue.
pub fn list_input_devices() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_list_input_devices(out) })
}

/// Démarre la capture micro ; `None` prend le défaut système.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le micro n'est pas autorisé ou si la capture ne démarre pas.
///
/// # Pièges
///
/// - ⚠️ La garde d'autorisation est côté Swift : le pont ne peut ouvrir un micro non accordé.
/// - ⚠️ Aucun échantillon ne remonte par ici : le flux PCM va d'`AVAudioEngine` au moteur, en Swift.
/// - ⚠️ Bloquant : `AVAudioEngine` dialogue avec `coreaudiod`, dizaines de ms. `off_thread`.
pub fn start_capture(device_id: Option<&str>) -> Result<(), AppError> {
  let requested = optional(device_id, "l'identifiant d'entrée")?;
  call(|out| unsafe { mirmalion_start_capture(optional_ptr(requested.as_ref()), out) }).map(|_| ())
}

/// Arrête la capture micro. Sans effet si rien ne tourne.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn stop_capture() -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_stop_capture(out) }).map(|_| ())
}

/// L'état de la capture, en JSON — dont le nombre d'échantillons captés, seule preuve que le
/// flux coule vraiment.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn capture_status() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_capture_status(out) })
}

/// Les sources captables pour une session, en JSON : les applications qui émettent réellement
/// du son, plus « Tout le système ».
///
/// Ne demande aucune autorisation et n'ouvre rien — la HAL énumère sans capter, ce qui permet
/// de remplir le sélecteur avant que l'enregistrement audio soit accordé.
///
/// # Errors
///
/// Rend [`AppError::Native`] si l'énumération échoue.
pub fn list_audio_sources() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_list_audio_sources(out) })
}

/// Démarre la capture d'une session : un tap sur la source, le micro, deux fichiers.
///
/// `source_id` vaut `"system"` ou le `pid` d'une application ; `microphone_device_id` distingue
/// `None`, pas de micro, de `Some("default")` (`MicrophoneChoice`) ; `directory` vient de Rust.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument invalide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Aucun échantillon ne remonte par ici : les tampons vont du tap aux fichiers, en Swift.
/// - ⚠️ Bloquant : le tap dialogue avec `coreaudiod` et assemble un agrégat. `off_thread`.
pub fn live_start(
  source_id: &str,
  microphone_device_id: Option<&str>,
  directory: &str,
  locale: Option<&str>,
) -> Result<(), AppError> {
  // ⚠️ La capture n'a pas à connaître de seuil de voix : les voix ne sont comparées qu'à la
  // consolidation, et c'est `mirmalion_voice_match` qui reçoit alors la mesure. En remettre un
  // ici donnerait deux jeux de nombres à tenir alignés, dont un seul porte la mesure.
  let source = argument(source_id, "la source audio")?;
  let microphone = optional(microphone_device_id, "l'identifiant de micro")?;
  let folder = argument(directory, "le dossier d'enregistrement")?;
  // ⚠️ `None` veut dire « enregistre sans transcrire », et ce n'est pas une erreur : les
  // fichiers sont écrits, et tout se refait depuis eux.
  let language = optional(locale, "la langue de transcription")?;
  call(|out| unsafe {
    mirmalion_live_start(
      source.as_ptr(),
      optional_ptr(microphone.as_ref()),
      folder.as_ptr(),
      optional_ptr(language.as_ref()),
      out,
    )
  })
  .map(|_| ())
}

/// Branche — ou débranche, avec `None` — la remontée des évènements de transcript de session.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse l'inscription.
///
/// # Pièges
///
/// - ⚠️ Canal distinct de celui de la dictée, et pas par symétrie : la charge utile n'est pas
///   la même (elle nomme son flux) et le consommateur non plus.
pub fn live_set_transcript_observer(
  observer: Option<TranscriptionObserver>,
) -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_live_set_transcript_observer(observer, out) }).map(|_| ())
}

/// Arrête la capture de session et ferme les fichiers. Sans effet si rien ne tourne.
///
/// # Errors
///
/// Rend [`AppError::Native`] si la fermeture échoue.
pub fn live_stop() -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_live_stop(out) }).map(|_| ())
}

/// L'état de la capture de session, en JSON — les deux compteurs, le niveau combiné et les
/// chemins des fichiers en cours d'écriture.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn live_status() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_live_status(out) })
}

/// Le destinataire des évènements de transcription, appelé depuis Swift.
///
/// # Safety
///
/// `payload` n'est valide que pendant l'appel : le copier, jamais en garder le pointeur.
///
/// # Pièges
///
/// - ⚠️ Le seul endroit du pont où la propriété des chaînes s'inverse : la chaîne vit sur la
///   pile de l'appelant Swift, personne ne la libère ici.
/// - ⚠️ Appelé depuis un fil quelconque, jamais le principal : le rappel doit être réentrant
///   et bon marché — côté application, il se contente d'émettre un évènement Tauri.
pub type TranscriptionObserver = extern "C" fn(payload: *const c_char);

/// Ce que le moteur de transcription sait faire, en JSON. Ne démarre aucune session.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn stt_capabilities() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_stt_capabilities(out) })
}

/// Enregistre le destinataire des évènements — ou le retire avec `None`.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse l'inscription.
///
/// # Pièges
///
/// - ⚠️ À appeler une seule fois, au démarrage : le pont ne garde qu'un observateur, et le
///   remplacer en cours de session fait disparaître les évènements en vol.
pub fn stt_set_observer(observer: Option<TranscriptionObserver>) -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_stt_set_observer(observer, out) }).map(|_| ())
}

/// Le rappel des évènements d'installation.
///
/// # Safety
///
/// Même contrat que [`TranscriptionObserver`] : `payload` ne vaut que pendant l'appel.
pub type AssetInstallObserver = extern "C" fn(payload: *const c_char);

/// Enregistre le destinataire des évènements d'installation. Une seule fois, au démarrage.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse l'inscription.
pub fn assets_set_observer(observer: Option<AssetInstallObserver>) -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_assets_set_observer(observer, out) }).map(|_| ())
}

/// Lance le téléchargement des ressources d'une langue. Rend la main immédiatement.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `language` est vide, [`AppError::Native`] si le
/// téléchargement ne peut pas être lancé.
///
/// # Pièges
///
/// - ⚠️ Opération réseau : elle ne s'appelle que sur un geste explicite de l'utilisateur, et
///   aucun chargement d'écran ne doit passer par ici.
pub fn install_language(language: &str) -> Result<(), AppError> {
  let language = argument(language, "la langue à installer")?;
  call(|out| unsafe { mirmalion_install_language(language.as_ptr(), out) }).map(|_| ())
}

/// Abandonne l'installation en cours. Sans effet si rien ne tourne.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn cancel_language_install() -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_cancel_language_install(out) }).map(|_| ())
}

/// La langue dont l'installation est en cours, ou `Ok(None)` si aucune ne tourne.
///
/// # Errors
///
/// Rend [`AppError::Native`] si l'état n'a pas pu être lu.
pub fn language_install_in_flight() -> Result<Option<String>, AppError> {
  call_optional(|out| unsafe { mirmalion_language_install_in_flight(out) })
}

/// Les réservations de locale détenues par l'application, et le plafond de la machine.
///
/// Lecture gratuite et locale, contrairement à `assetInstallationRequest`, qui réserve
/// silencieusement — voir l'en-tête de `SpeechAssets.swift`.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
///
/// # Pièges
///
/// - ⚠️ Le plafond ne borne pas les langues utilisables, mais celles que l'application a
///   elle-même téléchargées : une langue déjà présente n'a jamais été réservée.
pub fn locale_reservations() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_locale_reservations(out) })
}

/// Rend la réservation d'une langue. Sans effet si elle n'en détenait pas.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `language` est vide, [`AppError::Native`] si le pont
/// échoue.
///
/// # Pièges
///
/// - ⚠️ Ne prétend pas désinstaller : ce que macOS fait ensuite du pack téléchargé n'est pas
///   garanti par la documentation d'Apple (`src-tauri/tests/locale_reservations.rs`).
pub fn release_locale(language: &str) -> Result<(), AppError> {
  let language = argument(language, "la langue à libérer")?;
  call(|out| unsafe { mirmalion_release_locale(language.as_ptr(), out) }).map(|_| ())
}

/// Démarre une session de transcription.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `language` est vide, [`AppError::Native`] si la
/// session ne s'ouvre pas.
///
/// # Pièges
///
/// - ⚠️ N'ouvre pas le micro : c'est `start_capture`, et l'ordre compte — le moteur d'abord,
///   la capture ensuite. L'inverse fait arriver dans le vide les premiers tampons, qui
///   portent les premiers mots de la dictée.
pub fn stt_start(language: &str) -> Result<(), AppError> {
  let locale = argument(language, "la langue de dictée")?;
  call(|out| unsafe { mirmalion_stt_start(locale.as_ptr(), out) }).map(|_| ())
}

/// Termine la session : le moteur finalise et émet son texte définitif.
///
/// # Errors
///
/// Rend [`AppError::Native`] si la clôture échoue.
pub fn stt_finish() -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_stt_finish(out) }).map(|_| ())
}

/// Abandonne la session. Aucun évènement n'en sortira, ni final ni partiel.
///
/// # Errors
///
/// Rend [`AppError::Native`] si l'annulation échoue.
pub fn stt_cancel() -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_stt_cancel(out) }).map(|_| ())
}

/// Le destinataire des fronts du raccourci global, appelé depuis Swift.
///
/// Reçoit `0` quand plus aucune combinaison n'est formée, sinon le code de celle qui l'est —
/// voir [`crate::shortcut::Combo::from_code`]. Le pont ne notifie que les changements : jamais
/// deux fois le même code de suite.
///
/// # Pièges
///
/// - ⚠️ Appelé depuis le fil du tap, qui distribue aussi les évènements clavier de toute la
///   session : ce qui traîne ici ralentit le clavier de l'utilisateur. Le rappel se contente
///   de faire tourner la machine à états et d'émettre un évènement Tauri.
pub type ShortcutObserver = extern "C" fn(combo: i32);

/// Enregistre le destinataire des fronts du raccourci — ou le retire avec `None`.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse l'inscription.
pub fn shortcut_set_observer(observer: Option<ShortcutObserver>) -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_shortcut_set_observer(observer, out) }).map(|_| ())
}

/// Met le tap clavier à l'écoute. Idempotent : rappeler n'installe pas un second tap.
///
/// # Errors
///
/// Rend [`AppError::Permission`] tant que l'Accessibilité n'est pas accordée. L'échec ne
/// bloque pas l'application : il prive du raccourci, pas de la dictée.
///
/// # Pièges
///
/// - ⚠️ Cet appel est le seul moyen de savoir si l'Accessibilité est accordée :
///   `CGEventTapCreate` rend un port valide sans elle, puis ne délivre jamais rien.
pub fn shortcut_start() -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_shortcut_start(out) })
    .map(|_| ())
    .map_err(as_permission_error)
}

/// Retire le tap. Sans effet si rien n'écoute.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn shortcut_stop() -> Result<(), AppError> {
  call(|out| unsafe { mirmalion_shortcut_stop(out) }).map(|_| ())
}

/// L'état du tap, en JSON. N'installe rien et ne demande aucune autorisation.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn shortcut_status() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_shortcut_status(out) })
}

/// Colle le texte au curseur dans l'application visée, puis rend son presse-papiers.
///
/// Rend `"inserted"`, ou `"noEditableField"` — pas une erreur, et rien n'a alors été touché.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `text` est vide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Bloquant ~150 ms, le temps laissé à la cible pour consommer le ⌘V : `spawn_blocking`.
/// - ⚠️ `target` est le `pid` relevé au **début** de la dictée. `0` retombe sur le premier
///   plan du moment, ce que notre propre pilule suffit à fausser.
pub fn insert_at_cursor(text: &str, target: i32) -> Result<String, AppError> {
  let value = argument(text, "le texte à insérer")?;
  call(|out| unsafe { mirmalion_insert_at_cursor(value.as_ptr(), target, out) })
}

/// Ce que l'application au premier plan dit de son champ focalisé : `"editable"`,
/// `"notEditable"` ou `"unknown"`. N'insère rien et ne touche à rien.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
///
/// # Pièges
///
/// - ⚠️ `unknown` est le cas le plus fréquent, pas une exception : tout ce qui est bâti sur
///   Chromium n'expose pas son arbre d'accessibilité. Le traiter comme un refus priverait la
///   dictée du navigateur.
pub fn focus_verdict() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_focus_verdict(out) })
}

/// Le `pid` et l'identifiant de paquet de l'application au premier plan, séparés par une
/// espace. Se lit par [`focus_owner`], qui en fait un couple.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
///
/// # Pièges
///
/// - ⚠️ L'identifiant de paquet ne sert qu'à une trace `debug!`, retirée en production. Seul
///   le `pid` porte une décision, celle de la cible du collage.
pub fn focus_target() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_focus_target(out) })
}

/// L'application au premier plan : son `pid`, et son identifiant pour la trace.
///
/// Le `pid` vaut `0` quand le système n'annonce aucune application ; l'insertion retombe
/// alors sur le premier plan du moment, ce qui vaut mieux que de ne rien tenter.
///
/// # Pièges
///
/// - ⚠️ À relever au **début** de la dictée et à porter jusqu'au collage : notre propre
///   pilule prend le premier plan une seconde après le début (bogue Tauri #7519 sur macOS),
///   et viser le premier plan au moment de coller revient à coller chez nous.
pub fn focus_owner() -> (i32, String) {
  let raw = focus_target().unwrap_or_else(|_| "0 (indisponible)".to_owned());
  let (pid, label) = raw.split_once(' ').unwrap_or(("0", raw.as_str()));
  (pid.parse().unwrap_or(0), label.to_owned())
}

/// La langue préférée de l'utilisateur d'après macOS, en sous-étiquette primaire (`fr`, `ja`).
///
/// `Ok(None)` si le système n'en annonce aucune : c'est à l'appelant de choisir le repli.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn preferred_language() -> Result<Option<String>, AppError> {
  call_optional(|out| unsafe { mirmalion_preferred_language(out) })
}

/// La `NSWindow` d'une fenêtre Tauri, tenue **depuis le fil principal**.
///
/// Le jeton porte les deux moitiés de ce qu'AppKit exige : pointeur issu de `ns_window()` et
/// vivant, appel sur le fil principal. C'est ce qui rend **sûrs** les gestes ci-dessous.
///
/// # Pièges
///
/// - ⚠️ Il ne se construit qu'à un endroit, `commands::window::on_native_window` : c'est ce qui
///   en fait le seul à auditer. En ouvrir un second rouvrirait la question partout.
/// - ⚠️ Portant un pointeur brut, il n'est ni `Send` ni `Sync` — il ne peut pas quitter le fil
///   principal. Ce n'est pas une politesse du compilateur, c'est la moitié de l'invariant.
pub struct MainWindow(*mut c_void);

impl MainWindow {
  /// Enveloppe le `NSWindow` que Tauri vient de rendre.
  ///
  /// # Safety
  ///
  /// `window` doit venir de `WebviewWindow::ns_window()` et rester vivant pendant tout l'usage du
  /// jeton, et l'appel doit avoir lieu sur le fil principal.
  pub const unsafe fn new(window: *mut c_void) -> Self {
    Self(window)
  }

  /// Le pointeur nu, pour les appels FFI de ce module et d'aucun autre.
  const fn as_ptr(&self) -> *mut c_void {
    self.0
  }
}

/// Centre les boutons de fenêtre dans une bande de `header_height` points, à `leading` du bord.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse la fenêtre.
///
/// # Pièges
///
/// - ⚠️ À rappeler après chaque redimensionnement : AppKit remet la bande à sa hauteur
///   standard dès que la fenêtre change de taille.
pub fn center_window_buttons(
  window: &MainWindow,
  header_height: f64,
  leading: f64,
) -> Result<(), AppError> {
  // SAFETY: le jeton porte la validité du pointeur et le fil principal ; Swift ne fait que
  // l'emprunter, et refuse un pointeur nul plutôt que de le déréférencer.
  call(|out| unsafe {
    mirmalion_center_window_buttons(window.as_ptr(), header_height, leading, out)
  })
  .map(|_| ())
}

/// Pose l'icône du Dock. Développement seulement — voir l'export Swift.
///
/// # Errors
///
/// Rend [`AppError::Native`] si `path` porte un octet nul ou si l'icône ne se pose pas.
///
/// # Pièges
///
/// - ⚠️ À appeler depuis le fil principal (`run_on_main_thread`) : AppKit n'accepte pas
///   d'être touché ailleurs.
pub fn set_dock_icon(path: &str) -> Result<(), AppError> {
  let path = std::ffi::CString::new(path)
    .map_err(|_| AppError::Native("chemin d'icône invalide".to_owned()))?;
  // SAFETY: la chaîne vit le temps de l'appel ; Swift la copie avant de rendre la main.
  call(|out| unsafe { mirmalion_set_dock_icon(path.as_ptr(), out) }).map(|_| ())
}

/// Redimensionne une fenêtre en l'animant sur `duration` secondes.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse la fenêtre.
pub fn resize_window_animated(
  window: &MainWindow,
  width: f64,
  height: f64,
  duration: f64,
) -> Result<(), AppError> {
  // SAFETY: voir [`MainWindow`] ; Swift ne fait qu'emprunter le pointeur.
  call(|out| unsafe {
    mirmalion_resize_window_animated(window.as_ptr(), width, height, duration, out)
  })
  .map(|_| ())
}

/// Configure la fenêtre de l'overlay : niveau système, survie au plein écran, traversée des
/// clics, et placement en haut de l'écran centré.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse la fenêtre.
pub fn configure_overlay_window(
  window: &MainWindow,
  top_margin: f64,
  corner_radius: f64,
) -> Result<(), AppError> {
  // SAFETY: voir [`MainWindow`] ; Swift ne fait qu'emprunter le pointeur.
  call(|out| unsafe {
    mirmalion_configure_overlay_window(window.as_ptr(), top_margin, corner_radius, out)
  })
  .map(|_| ())
}

/// Montre la pilule sans activer l'application, là où `show()` de Tauri l'activerait.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse la fenêtre.
///
/// # Pièges
///
/// - ⚠️ Jamais par `WebviewWindow::show()` : celui-ci descend à `makeKeyAndOrderFront:`, vole le
///   focus du champ visé, et le collage part chez nous.
pub fn present_overlay_window(window: &MainWindow) -> Result<(), AppError> {
  // SAFETY: voir [`MainWindow`] ; Swift ne fait qu'emprunter le pointeur.
  call(|out| unsafe { mirmalion_present_overlay_window(window.as_ptr(), out) }).map(|_| ())
}

/// Retaille la fenêtre de l'overlay à la pilule qu'elle contient, et la recentre en haut de
/// l'écran.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse la fenêtre.
pub fn resize_overlay_window(
  window: &MainWindow,
  width: f64,
  height: f64,
  top_margin: f64,
) -> Result<(), AppError> {
  // SAFETY: voir [`MainWindow`] ; Swift ne fait qu'emprunter le pointeur.
  call(|out| unsafe {
    mirmalion_resize_overlay_window(window.as_ptr(), width, height, top_margin, out)
  })
  .map(|_| ())
}

/// Force le webview d'une fenêtre à se repeindre. Voir `mirmalion_refresh_webview`.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse la fenêtre.
pub fn refresh_webview(window: &MainWindow) -> Result<(), AppError> {
  // SAFETY: voir [`MainWindow`] ; Swift ne fait qu'emprunter le pointeur.
  call(|out| unsafe { mirmalion_refresh_webview(window.as_ptr(), out) }).map(|_| ())
}

/// Efface la pilule en fondu : elle s'efface, elle ne se ferme pas.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse la fenêtre.
///
/// # Pièges
///
/// - ⚠️ L'appelant doit attendre la durée du fondu avant de fermer la fenêtre.
pub fn fade_out_overlay_window(window: &MainWindow) -> Result<(), AppError> {
  // SAFETY: voir [`MainWindow`] ; Swift ne fait qu'emprunter le pointeur.
  call(|out| unsafe { mirmalion_fade_out_overlay_window(window.as_ptr(), out) }).map(|_| ())
}

/// Renvoie la chaîne transmise. Réservé aux tests, rien ne l'expose en IPC.
///
/// C'est le seul chemin d'erreur natif déclenchable à volonté, donc le seul moyen de vérifier
/// qu'une erreur Swift remonte en [`AppError::Native`] sans faire tomber le processus.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `input` porte un octet nul, [`AppError::Native`] si
/// `input` est vide — c'est Swift qui refuse, et c'est le chemin qu'on veut éprouver.
#[cfg(test)]
pub fn echo(input: &str) -> Result<String, AppError> {
  let input = std::ffi::CString::new(input).map_err(|_| {
    AppError::InvalidArgument(
      "l'entrée contient un octet nul, elle ne peut pas traverser le pont".into(),
    )
  })?;
  call(|out| unsafe { mirmalion_echo(input.as_ptr(), out) })
}

/// Ouvre un média local et rend le JSON de son inspection.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `path` est vide, [`AppError::Native`] si la brique
/// native échoue.
///
/// # Pièges
///
/// - ⚠️ Bloquant : `AVURLAsset` lit l'en-tête du conteneur sur le disque. `spawn_blocking`.
/// - ⚠️ Un média refusé n'est pas une erreur ici : le refus voyage en clair dans le JSON. Une
///   `Err` d'ici dit toujours que la brique native est cassée, jamais que le fichier déplaît.
pub fn media_inspect(path: &str) -> Result<String, AppError> {
  let value = argument(path, "le chemin du média")?;
  call(|out| unsafe { mirmalion_media_inspect(value.as_ptr(), out) })
}

/// Identifie la langue parlée d'un média local et rend le JSON du verdict.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `path` est vide, [`AppError::Native`] si la brique
/// native échoue.
///
/// # Pièges
///
/// - ⚠️ Bloquant : il transcrit un échantillon par langue installée. `spawn_blocking`.
/// - ⚠️ Un média dont la langue n'est pas décidable n'est pas une erreur : le verdict porte
///   son motif. Une `Err` d'ici veut dire que la brique native est cassée.
pub fn detect_language(path: &str) -> Result<String, AppError> {
  let value = argument(path, "le chemin du média")?;
  call(|out| unsafe { mirmalion_detect_language(value.as_ptr(), out) })
}

/// La langue dominante d'un texte, `None` quand elle n'est pas décidable.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `text` est vide, [`AppError::Native`] si la brique
/// native est cassée.
///
/// # Pièges
///
/// - ⚠️ Rien à voir avec [`detect_language`], qui écoute un média : celle-ci lit du texte.
/// - ⚠️ Un texte court n'a pas de langue décidable, et ce n'est **pas** une erreur.
pub fn detect_text_language(text: &str) -> Result<Option<String>, AppError> {
  let value = argument(text, "le texte à examiner")?;
  call_optional(|out| unsafe { mirmalion_detect_text_language(value.as_ptr(), out) })
}

/// Diarise un média local et rend le JSON de ses tours de parole.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `path` est vide, [`AppError::Native`] si la brique
/// native échoue.
///
/// # Pièges
///
/// - ⚠️ Bloquant, et le média entre entièrement en mémoire : `spawn_blocking` obligatoire.
/// - ⚠️ `threshold` est le seul réglage qui agisse sur le regroupement, et aucune valeur fixe
///   ne convient : 0,80 sur un audio propre à deux voix, 0,60 sur un plateau bruité à quatre.
pub fn diarize(path: &str, threshold: f64) -> Result<String, AppError> {
  let value = argument(path, "le chemin du média")?;
  call(|out| unsafe { mirmalion_diarize(value.as_ptr(), threshold, out) })
}

/// Rapproche les voix de deux enregistrements et rend leurs distances deux à deux, en JSON.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un chemin vide, [`AppError::Native`] si la brique
/// native échoue.
///
/// # Pièges
///
/// - ⚠️ Bloquant, et les deux médias entrent en mémoire : `spawn_blocking` obligatoire.
/// - ⚠️ Aucune empreinte ne traverse ce pont : ce qui revient est une matrice de distances.
///   On peut y lire que deux voix se ressemblent, on n'en reconstruit aucune.
pub fn voice_match(first: &str, second: &str, threshold: f64) -> Result<String, AppError> {
  let first = argument(first, "le chemin du premier média")?;
  let second = argument(second, "le chemin du second média")?;
  call(|out| unsafe { mirmalion_voice_match(first.as_ptr(), second.as_ptr(), threshold, out) })
}

/// Le marqueur d'annulation convenu avec le pont. Voir `FileTranscription.swift`.
const CANCELLATION_MARKER: &str = "mirmalion:cancelled";

/// Le trampoline qui rend un `FnMut` Rust appelable depuis C.
///
/// # Safety
///
/// `context` doit être nul, ou pointer vers un `&mut dyn FnMut(f64) -> bool` vivant pendant
/// tout l'appel — c'est ce que garantit [`file_transcribe`], qui attend le retour du pont.
///
/// # Pièges
///
/// - ⚠️ Double indirection obligatoire : un objet-trait est un pointeur gras, qui n'entre pas
///   dans le mot unique d'un `*mut c_void`. En passer l'adresse tronque la table des méthodes.
/// - ⚠️ Une fermeture qui panique **arrête** la transcription : elle se rend annulée.
extern "C" fn progress_trampoline(context: *mut std::ffi::c_void, ratio: f64) -> bool {
  if context.is_null() {
    return true;
  }
  // SAFETY: le pointeur vient de `file_transcribe` juste en dessous, qui garde la fermeture
  // vivante pendant toute la durée de l'appel — il attend son retour avant de rendre la main.
  let callback = unsafe { &mut *(context as *mut &mut dyn FnMut(f64) -> bool) };
  guarded("avancement de transcription", || callback(ratio)).unwrap_or(false)
}

/// Transcrit un média local et rend le JSON de ses mots horodatés ; `progress` reçoit
/// l'avancement entre `0.0` et `1.0` et rend `false` pour interrompre.
///
/// # Errors
///
/// Rend [`AppError::Cancelled`] sur interruption, [`AppError::InvalidArgument`] sur un
/// argument vide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Bloquant, et longuement : le moteur déroule tout le média. `spawn_blocking`.
/// - ⚠️ `progress` est le seul point d'annulation, et il est au même endroit que la mesure.
pub fn file_transcribe(
  path: &str,
  locale: &str,
  progress: &mut dyn FnMut(f64) -> bool,
) -> Result<String, AppError> {
  let path = argument(path, "le chemin du média")?;
  let locale = argument(locale, "la langue de transcription")?;

  let mut boxed: &mut dyn FnMut(f64) -> bool = progress;
  let context = &mut boxed as *mut &mut dyn FnMut(f64) -> bool as *mut std::ffi::c_void;

  call(|out| unsafe {
    mirmalion_file_transcribe(
      path.as_ptr(),
      locale.as_ptr(),
      context,
      progress_trampoline,
      out,
    )
  })
  .map_err(|error| {
    // ⚠️ Une annulation n'est pas un échec et ne doit pas s'afficher comme tel : le pont la
    // signale par une chaîne convenue plutôt que par un quatrième statut, qui aurait obligé à
    // revisiter tous les appelants du contrat.
    if error.to_string().contains(CANCELLATION_MARKER) {
      AppError::Cancelled("transcription interrompue".into())
    } else {
      error
    }
  })
}

/// Ce que le moteur de génération de texte sait faire, en JSON brut.
///
/// Le schéma est produit par `native/Sources/MirmalionNative/LanguageModel.swift` et
/// désérialisé dans `crate::llm::apple` — c'est là que vit le type, pas ici. N'appelle pas le
/// modèle : aucune génération, aucune attente.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
pub fn llm_capabilities() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_llm_capabilities(out) })
}

/// Nettoie un texte dicté et rend le texte corrigé.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument vide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Bloquant, de l'ordre de la seconde : le modèle génère. `spawn_blocking`.
/// - ⚠️ Le prompt n'est pas un paramètre et ne doit jamais le devenir : il vit en Swift, où le
///   texte entre comme donnée délimitée. L'ouvrir ici rouvrirait la porte à l'injection.
/// - ⚠️ `language` est la langue **parlée** : la cible ferait traduire l'étape qui corrige.
pub fn llm_clean(text: &str, language: &str) -> Result<String, AppError> {
  let value = argument(text, "le texte à nettoyer")?;
  let language = argument(language, "la langue de la dictée")?;
  call(|out| unsafe { mirmalion_llm_clean(value.as_ptr(), language.as_ptr(), out) })
}

/// Réécrit un texte déjà nettoyé dans le style demandé. Bloquant : `spawn_blocking`.
///
/// `style` est l'un des six `RephrasingStyle` ; `custom_prompt` n'est lu que pour `custom`.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument vide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Ici seulement, du texte utilisateur devient une instruction : relire les précautions
///   de `rephrasingRequest` côté Swift avant d'étendre ce passage ailleurs.
/// - ⚠️ `language` est obligatoire : sans elle, deux styles sur six traduisent le texte.
pub fn llm_rephrase(
  text: &str,
  style: &str,
  custom_prompt: Option<&str>,
  language: &str,
) -> Result<String, AppError> {
  let text = argument(text, "le texte à reformuler")?;
  let style = argument(style, "le style de reformulation")?;
  let language = argument(language, "la langue de la dictée")?;
  let custom = optional(custom_prompt, "le prompt de reformulation personnalisé")?;

  call(|out| unsafe {
    mirmalion_llm_rephrase(
      text.as_ptr(),
      style.as_ptr(),
      optional_ptr(custom.as_ref()),
      language.as_ptr(),
      out,
    )
  })
}

/// Propose un intitulé court pour une session, à partir de son début.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument vide, [`AppError::Native`] si le modèle
/// échoue.
///
/// # Pièges
///
/// - ⚠️ Bloquant : à n'appeler que depuis `spawn_blocking`.
/// - ⚠️ L'échec est un cas nominal, pas une panne : une session trop courte n'a pas de sujet
///   à nommer, et l'appelant retombe sur « Session du {date} ».
pub fn llm_title(text: &str, language: &str) -> Result<String, AppError> {
  let value = argument(text, "le début de la session")?;
  let spoken = argument(language, "la langue de la session")?;
  call(|out| unsafe { mirmalion_llm_title(value.as_ptr(), spoken.as_ptr(), out) })
}

/// Un étage du compte rendu : des notes sur une tranche, ou le Markdown final.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument vide, [`AppError::Native`] si le modèle
/// échoue.
///
/// # Pièges
///
/// - ⚠️ Bloquant, plusieurs secondes par étage : à n'appeler que depuis `spawn_blocking`.
pub fn llm_report(
  text: &str,
  stage: &str,
  kind: &str,
  custom_prompt: Option<&str>,
  language: &str,
) -> Result<String, AppError> {
  let value = argument(text, "le texte à résumer")?;
  let step = argument(stage, "l'étage du compte rendu")?;
  let reported = argument(kind, "le type de compte rendu")?;
  let custom = optional(custom_prompt, "le prompt de compte rendu")?;
  let spoken = argument(language, "la langue de la session")?;
  call(|out| unsafe {
    mirmalion_llm_report(
      value.as_ptr(),
      step.as_ptr(),
      reported.as_ptr(),
      optional_ptr(custom.as_ref()),
      spoken.as_ptr(),
      out,
    )
  })
}

/// L'état de chaque paire de langues du périmètre, en JSON brut.
///
/// Le schéma vit dans `crate::translation`, en miroir de `Translation.swift`. Ne traduit rien
/// et ne télécharge rien : sonder les paires ne consomme aucun quota.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue.
///
/// # Pièges
///
/// - ⚠️ Bloquant, et à n'appeler que depuis un fil de fond : voir `translate`, où le risque
///   est l'interblocage et non la latence.
pub fn translation_availability() -> Result<String, AppError> {
  call(|out| unsafe { mirmalion_translation_availability(out) })
}

/// Traduit un texte, entièrement sur la machine, et rend l'issue en JSON brut.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument vide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Une paire absente n'est pas une erreur : elle revient en `Ok`, portée par
///   `TranslationOutcome::PairMissing`, et aucun téléchargement n'est engagé ici.
/// - ⚠️ `spawn_blocking` obligatoire : le framework livre ses continuations par la boucle
///   principale, que ce pont bloquerait sur son sémaphore — le processus se fige pour de bon.
pub fn translate(source: &str, target: &str, text: &str) -> Result<String, AppError> {
  let source = argument(source, "la langue source")?;
  let target = argument(target, "la langue cible")?;
  let text = argument(text, "le texte à traduire")?;
  call(|out| unsafe { mirmalion_translate(source.as_ptr(), target.as_ptr(), text.as_ptr(), out) })
}

/// Présente la feuille de téléchargement d'Apple pour `target`, attachée à `window`.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument vide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Le seul appel du projet qui engage un téléchargement de traduction : jamais sans clic.
/// - ⚠️ Il ne promet rien du téléchargement : seulement que la feuille a été greffée.
pub fn prepare_translation(
  window: &MainWindow,
  target: &str,
  source: &str,
) -> Result<String, AppError> {
  let target = argument(target, "la langue cible")?;
  let source = argument(source, "la langue source")?;
  // SAFETY: voir [`MainWindow`] ; les deux `CString` vivent jusqu'à la fin de l'appel.
  call(|out| unsafe {
    mirmalion_prepare_translation(window.as_ptr(), target.as_ptr(), source.as_ptr(), out)
  })
}

/// Écrit un document en PDF paginé à `path`.
///
/// `payload` est le JSON de [`crate::export::render::pdf_payload`] ; le pont ne compose rien.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument vide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Bloquant : la mise en page traverse tout le document. `spawn_blocking`.
/// - ⚠️ C'est Swift qui écrit le fichier : un PDF se rend page par page dans un `CGContext`
///   attaché à une URL, il n'existe jamais comme tampon d'octets — les autres formats, si.
pub fn export_pdf(payload: &str, path: &str) -> Result<(), AppError> {
  let payload = argument(payload, "le document à exporter")?;
  let path = argument(path, "le chemin du PDF")?;
  call(|out| unsafe { mirmalion_export_pdf(payload.as_ptr(), path.as_ptr(), out) }).map(|_| ())
}

/// Dépose un document dans le presse-papiers, en deux représentations : `text/html` et
/// `text/plain` (du Markdown).
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un argument vide, [`AppError::Native`] sinon.
///
/// # Pièges
///
/// - ⚠️ Le presse-papiers n'est pas restauré, contrairement au collage de la dictée : ici
///   c'est l'utilisateur qui demande à copier.
pub fn copy_rich_text(html: &str, plain: &str) -> Result<(), AppError> {
  let html = argument(html, "le document en HTML")?;
  let plain = argument(plain, "le document en Markdown")?;
  call(|out| unsafe { mirmalion_copy_rich_text(html.as_ptr(), plain.as_ptr(), out) }).map(|_| ())
}

#[cfg(test)]
mod tests {
  use super::{capabilities, copy_rich_text, echo, export_pdf, shortcut_status, shortcut_stop};
  use crate::error::AppError;

  #[test]
  fn capabilities_come_back_from_swift_as_json() {
    let raw = capabilities().expect("le pont doit répondre");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("du JSON valide");
    assert!(value["osVersion"].is_string());
    assert!(value["speechTranscriber"]["status"].is_string());
  }

  #[test]
  fn echo_returns_the_input_unchanged() {
    assert_eq!(echo("bonjour").expect("succès"), "bonjour");
    // Le pont doit rendre l'UTF-8 intact, accents et hors du plan latin compris.
    assert_eq!(echo("session 会議").expect("succès"), "session 会議");
  }

  #[test]
  fn an_error_thrown_in_swift_becomes_a_native_error() {
    let error = echo("").expect_err("une entrée vide doit échouer");
    assert_eq!(error.kind(), "native");
    assert!(
      error.to_string().contains("vide"),
      "le message de Swift doit remonter tel quel, reçu : {error}"
    );
  }

  #[test]
  fn an_interior_nul_is_rejected_before_crossing_the_bridge() {
    let error = echo("avant\0après").expect_err("un octet nul doit être refusé");
    assert!(matches!(error, AppError::InvalidArgument(_)));
    assert_eq!(error.kind(), "invalidArgument");
  }

  #[test]
  fn the_process_survives_a_failed_call() {
    // La garantie qui compte : une erreur Swift ne tue pas le processus. Si la FFI laissait
    // filer l'erreur, ce test ne rendrait jamais la main.
    for _ in 0..100 {
      let _ = echo("");
    }
    assert_eq!(echo("toujours vivant").expect("succès"), "toujours vivant");
  }

  /// L'état du raccourci se lit **sans rien installer** : ni tap, ni prompt, ni autorisation.
  /// C'est ce qui permet à l'interface de dire pourquoi ⌃⌥ ne répond pas.
  ///
  /// ⚠️ Ce test n'appelle délibérément pas `shortcut_start` : un tap est un effet de bord sur
  /// toute la session clavier de la machine, et sa création ne prouve rien — la seule preuve
  /// est un évènement reçu, qui demande une vraie frappe.
  #[test]
  fn the_shortcut_status_reads_without_installing_anything() {
    let raw = shortcut_status().expect("le pont doit répondre");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("du JSON valide");
    assert!(value["listening"].is_boolean());
    assert!(value["trusted"].is_boolean());
    assert_eq!(
      value["listening"], false,
      "aucun tap ne doit exister tant qu'on ne l'a pas demandé"
    );
  }

  /// Arrêter ce qui n'écoute pas n'est pas une erreur : l'arrêt est appelé sur des chemins
  /// où l'on ne sait pas toujours si un tap existait.
  #[test]
  fn stopping_an_idle_shortcut_is_a_no_op() {
    for _ in 0..3 {
      shortcut_stop().expect("l'arrêt doit être idempotent");
    }
  }

  /// ⚠️ La preuve que le rendu PDF ne demande pas le fil principal : un test tourne sur un fil
  /// de fond pendant que le fil principal attend la fin de la suite. Si `DocumentExport`
  /// dispatchait vers lui — ce que fait l'importateur HTML de `NSAttributedString` —, ce test
  /// ne rendrait jamais la main. Qu'il se termine est l'assertion la plus importante du lot.
  ///
  /// Il vérifie aussi la seule chose qui rende un PDF ouvrable : sa signature `%PDF`.
  #[test]
  fn a_pdf_is_written_without_ever_touching_the_main_thread() {
    let path = std::env::temp_dir().join(format!("mirmalion-export-{}.pdf", std::process::id()));
    let payload = serde_json::json!({
      "title": "Session 会議",
      "blocks": [
        // ⚠️ Une rubrique en tête : c'est le drapeau `heading` qui décide de sa police, et un
        // décodeur Swift qui l'ignorerait rendrait un PDF de compte rendu tout plat.
        { "text": "Résumé", "heading": true },
        { "text": "Bonjour tout le monde", "heading": false },
        // ⚠️ Sans `heading` : le décodeur doit retomber sur « paragraphe », jamais échouer.
        { "text": "Un paragraphe de plus" },
        // Un bloc long, pour que la pagination ait quelque chose à couper.
        { "text": "Très bien, merci. ".repeat(400) },
      ],
    })
    .to_string();

    export_pdf(&payload, &path.to_string_lossy()).expect("le PDF doit s'écrire");
    let bytes = std::fs::read(&path).expect("relecture");
    assert_eq!(&bytes[..4], b"%PDF", "un PDF s'ouvre à sa signature");
    assert!(
      bytes.len() > 1_000,
      "un PDF de {} octets ne contient pas le document",
      bytes.len()
    );
    let _ = std::fs::remove_file(&path);
  }

  /// Un document vide reste un fichier ouvrable : **une page blanche, jamais zéro page**.
  #[test]
  fn an_empty_document_still_produces_an_openable_pdf() {
    let path = std::env::temp_dir().join(format!("mirmalion-vide-{}.pdf", std::process::id()));
    let payload = serde_json::json!({ "title": "", "separator": " — ", "blocks": [] }).to_string();

    export_pdf(&payload, &path.to_string_lossy()).expect("le PDF doit s'écrire");
    assert_eq!(&std::fs::read(&path).expect("relecture")[..4], b"%PDF");
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn an_unreadable_payload_or_an_impossible_path_comes_back_as_an_error() {
    let path = std::env::temp_dir().join("mirmalion.pdf");
    let error = export_pdf("{pas du JSON", &path.to_string_lossy()).expect_err("refus");
    assert_eq!(error.kind(), "native");
    assert!(error.to_string().contains("illisible"));

    let payload = serde_json::json!({ "title": "T", "separator": " — ", "blocks": [] }).to_string();
    let error =
      export_pdf(&payload, "/dossier-qui-n-existe-pas-3a9f/export.pdf").expect_err("refus");
    assert_eq!(error.kind(), "native");
  }

  /// ⚠️ Ignoré à dessein : il écrase le presse-papiers de l'utilisateur, seule donnée
  /// irrécupérable de la machine (voir l'en-tête de `Pasteboard.swift`). Le lancer à chaque
  /// `cargo test` ferait perdre ce qu'on venait de copier, plusieurs fois par jour.
  ///
  /// `cargo test --lib -- --ignored copy_places` le joue quand on veut mesurer.
  #[test]
  #[ignore]
  fn copy_places_two_representations_in_the_pasteboard() {
    copy_rich_text(
      "<!DOCTYPE html><html><body><p><strong>Alice</strong> — Bonjour</p></body></html>",
      "**Alice** — Bonjour",
    )
    .expect("la copie doit aboutir");
  }
}
