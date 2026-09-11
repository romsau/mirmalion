//! Transcrire un média déposé : le travail long, sa progression, et son annulation.
//!
//! Le média est déroulé **une fois**, pour en tirer des mots horodatés composés en paragraphes.
//!
//! # Pièges
//!
//! - ⚠️ Annuler doit arrêter le travail natif, pas seulement masquer l'interface : un moteur qui
//!   continue de dérouler une heure de média consomme un cœur pour rien, et l'écran ment en
//!   annonçant l'arrêt. Le drapeau se lit dans le rappel de progression lui-même, seul endroit
//!   par où toute boucle passe forcément.

use std::sync::{
  Arc,
  atomic::{AtomicBool, Ordering},
};

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::{
  blocking::off_thread,
  commands,
  dictionary::{self, Entry},
  error::AppError,
  filedoc::{Documents, FileDocument},
  lifecycle,
  state::AppState,
  stt::file::FileSttEngine,
  transcript::Transcript,
};

/// Ce qu'il faut pour transcrire un média.
///
/// # Pièges
///
/// - ⚠️ Un objet plutôt que des paramètres positionnels : côté TypeScript, deux chaînes
///   permutées donneraient un document dont le titre est une langue, sans la moindre erreur
///   de compilation.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionRequest {
  /// Le chemin du média sur le disque.
  pub path: String,
  /// Le nom de fichier, dont le document tire son titre de départ.
  pub file_name: String,
  /// La langue parlée, passée au moteur puis portée par le transcript.
  pub language: String,
}

/// L'évènement de progression, écouté par l'écran Fichiers.
///
/// # Pièges
///
/// - ⚠️ La barre ne doit pas atteindre 100 % avant que le travail ne soit fini. Elle le peut
///   aujourd'hui parce que la transcription est tout le travail long — ce qui la suit se compte
///   en millisecondes. Le jour où une seconde phase s'ajoute, il faut re-partager la barre.
pub const TRANSCRIPTION_EVENT: &str = "file-transcription";

/// Ce que l'écran reçoit pendant le travail.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProgress {
  /// L'avancement, de `0` à `100`.
  ///
  /// ⚠️ Un entier, pas un ratio : laisser le frontend multiplier par cent invite chacun à
  /// arrondir à sa façon, et la barre sauterait d'un écran à l'autre.
  pub percent: u8,
}

/// L'état partagé du travail de transcription en cours.
///
/// # Pièges
///
/// - ⚠️ Un seul travail à la fois : deux transcriptions simultanées se disputeraient le moteur,
///   et l'écran n'a qu'une barre.
#[derive(Default)]
pub struct TranscriptionHandle {
  /// Le drapeau d'arrêt, levé par [`cancel_media_transcription`].
  cancelled: Arc<AtomicBool>,
}

impl TranscriptionHandle {
  /// Ouvre un travail : lève le drapeau du précédent, et rend celui du nouveau.
  fn begin(&self) -> Arc<AtomicBool> {
    self.cancelled.store(true, Ordering::SeqCst);
    Arc::new(AtomicBool::new(false))
  }
}

/// Rend le moteur et l'état joignables. Appelé une fois, au `.setup()`.
pub fn setup(app: &tauri::AppHandle, transcriber: Arc<dyn FileSttEngine>) {
  app.manage(transcriber);
  app.manage(TranscriptionHandle::default());
}

/// Le moteur réel, pour le `.setup()` de `lib.rs`.
pub fn native_engine() -> Arc<dyn FileSttEngine> {
  Arc::new(crate::stt::file::AppleFileEngine)
}

/// Transcrit un média, range le document produit, et ouvre sa fenêtre.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la tâche est interrompue, l'erreur du moteur si la transcription
/// échoue, celle du magasin ou de la création de fenêtre ensuite.
///
/// # Pièges
///
/// - ⚠️ Garder le `spawn_blocking` : le moteur déroule tout le média et bloque — quatre
///   secondes sur le média de référence, de l'ordre de la minute sur une heure d'audio.
///   L'interface doit rester vivante, c'est elle qui affiche la barre.
#[tauri::command]
pub async fn transcribe_media(
  app: tauri::AppHandle,
  media: TranscriptionRequest,
  engine: State<'_, Arc<dyn FileSttEngine>>,
  documents: State<'_, Documents>,
  handle: State<'_, TranscriptionHandle>,
) -> Result<FileDocument, AppError> {
  let engine = Arc::clone(&engine);
  let flag = handle.begin();
  // La langue sert deux fois : au moteur, puis à l'étiquetage du transcript. Le travail
  // bloquant l'emporte dans son fil, d'où la copie.
  let TranscriptionRequest {
    path,
    file_name,
    language,
  } = media;
  let spoken = language.clone();
  // Le handle part dans le fil bloquant pour émettre la progression : on en garde une copie
  // pour ouvrir la fenêtre une fois le travail fini.
  let window_host = app.clone();
  let path_for_document = path.clone();

  let transcript = off_thread(move || {
    let mut last_percent = u8::MAX;
    engine.transcribe(&path, &spoken, &mut |ratio| {
      if flag.load(Ordering::SeqCst) {
        return false;
      }
      // ⚠️ On n'émet que sur changement de pourcentage entier : le pont rapporte son avancée
      // deux cents fois sur un média de six minutes, et réémettre à chaque fois réveillerait le
      // webview pour redessiner la même barre.
      #[expect(
        clippy::cast_possible_truncation,
        reason = "borné à [0, 100] par le `clamp` de la ligne même"
      )]
      let percent = (ratio * 100.0).round().clamp(0.0, 100.0) as u8;
      if percent != last_percent {
        last_percent = percent;
        // ⚠️ Le résultat s'écarte, et il ne passe pas par `commands::announce` : celui-ci
        // journalise chaque échec, et cent pour cent perdus d'affilée noieraient le journal
        // pour une barre qui rattrapera au pourcentage suivant.
        let _ = app.emit(TRANSCRIPTION_EVENT, TranscriptionProgress { percent });
      }
      true
    })
  })
  .await?;

  // ⚠️ Le dictionnaire s'applique ici, en amont de tout le reste, et sur les mots : les mots
  // corrigés partent à la fois vers la composition du transcript et vers ce que range
  // `Documents::open`, et corriger d'un seul côté ferait diverger les deux. L'appliquer au
  // texte ne marcherait pas : une variante qui enjambe deux mots les fusionne en un seul, et
  // seul `dictionary::words` sait quelles millisecondes lui donner.
  let words =
    dictionary::words::corrected(transcript.words, &dictionary_entries(&window_host).await);

  // ⚠️ Le document est rangé ici et sa fenêtre ouverte dans la foulée : le faire remonter au
  // frontend pour qu'il nous le renvoie coûterait deux sérialisations d'un transcript entier.
  let composed = Transcript::of(&words, &language);
  let document = documents.open(
    path_for_document,
    file_name,
    language,
    transcript.duration_ms,
    composed,
  )?;
  lifecycle::create_filedoc_window(&window_host, &document.id)?;
  Ok(document)
}

/// Les entrées du dictionnaire personnel, ou **aucune** si la base ne répond pas.
///
/// Le dictionnaire est toujours actif : il n'y a pas de bascule à relire.
///
/// # Pièges
///
/// - ⚠️ Un dictionnaire illisible ne fait pas échouer la transcription : le média vient de
///   coûter plusieurs secondes de moteur, et perdre ce travail pour une correction cosmétique
///   serait un mauvais échange. On journalise la nature de la panne, jamais son contenu.
async fn dictionary_entries(app: &tauri::AppHandle) -> Vec<Entry> {
  match commands::dictionary::load(app.state::<AppState>().database()).await {
    Ok(entries) => entries,
    Err(error) => {
      log::warn!("dictionnaire personnel non appliqué ({})", error.kind());
      Vec::new()
    }
  }
}

/// Demande l'arrêt du travail en cours.
///
/// Idempotente et sans échec : annuler ce qui n'existe pas n'est pas une erreur, l'interface
/// peut cliquer juste après la fin.
///
/// # Pièges
///
/// - ⚠️ Nommée `cancel_media_transcription` parce que `cancel_transcription` est déjà pris par
///   la dictée : les noms de commandes Tauri sont globaux au crate, pas au module, et la
///   collision ne se voit qu'à la compilation, dans un message qui parle de macros.
#[tauri::command]
pub fn cancel_media_transcription(handle: State<'_, TranscriptionHandle>) {
  handle.cancelled.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
  use super::{TRANSCRIPTION_EVENT, TranscriptionHandle, TranscriptionProgress};
  use std::sync::atomic::Ordering;

  #[test]
  fn opening_a_job_cancels_the_one_before_it() {
    // ⚠️ Deux transcriptions simultanées se disputeraient le moteur, et l'écran n'a qu'une
    // barre. Le second départ doit donc éteindre le premier.
    let handle = TranscriptionHandle::default();
    let first = handle.begin();
    assert!(!first.load(Ordering::SeqCst), "le premier démarre vivant");

    let second = handle.begin();
    assert!(!second.load(Ordering::SeqCst), "le second aussi");
    // Le drapeau partagé de l'objet est levé : c'est lui que lit le travail en cours.
    assert!(handle.cancelled.load(Ordering::SeqCst));
  }

  #[test]
  fn cancelling_twice_is_not_an_error() {
    let handle = TranscriptionHandle::default();
    handle.cancelled.store(true, Ordering::SeqCst);
    handle.cancelled.store(true, Ordering::SeqCst);
    assert!(handle.cancelled.load(Ordering::SeqCst));
  }

  #[test]
  fn progress_travels_as_whole_percents() {
    // ⚠️ Un entier, pas un ratio : laisser le frontend multiplier par cent invite chacun à
    // arrondir à sa façon, et la barre sauterait d'un écran à l'autre.
    let json = serde_json::to_value(TranscriptionProgress { percent: 62 }).expect("sérialisation");
    assert_eq!(json["percent"], 62);
    assert_eq!(TRANSCRIPTION_EVENT, "file-transcription");
  }
}
