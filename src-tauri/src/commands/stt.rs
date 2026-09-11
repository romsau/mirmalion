//! Piloter une session de transcription, et faire remonter ce qu'elle produit.
//!
//! Le pont rappelle [`on_transcription_event`], qui émet aussitôt un évènement Tauri.
//!
//! # Pièges
//!
//! - ⚠️ Ne pas remplacer les évènements par un sondage : à 100 ms il ajouterait une latence
//!   moyenne d'un demi-intervalle et ferait tourner un aller-retour IPC pendant toute la dictée.

use std::sync::Arc;

use tauri::{Manager, State};

use crate::{
  blocking::off_thread,
  commands::{self, audio},
  error::AppError,
  native,
  stt::{EngineCapabilities, SttEngine, TranscriptionEvent},
};

/// Le nom de l'évènement Tauri par lequel partiels, finals et échecs remontent au frontend.
///
/// # Pièges
///
/// - ⚠️ Un seul canal pour les trois natures, parce qu'elles sont ordonnées : sur trois canaux
///   distincts, un abonné pourrait recevoir le final avant le dernier partiel.
/// - ⚠️ Cette chaîne est du contrat : le frontend s'y abonne par sa valeur, la renommer coupe
///   les partiels en silence.
pub const TRANSCRIPTION_EVENT: &str = "transcription";

/// Le moteur monté au démarrage, partagé par toutes les commandes de ce module.
///
/// Voir [`crate::stt`] pour le rôle du trait.
pub struct SttHandle(pub Arc<dyn SttEngine>);

/// Le rappel appelé **par Swift**, depuis un fil quelconque, à chaque évènement du moteur.
///
/// Une charge utile illisible est journalisée et jetée : personne n'est là pour recevoir une
/// erreur. Le traitement passe par [`native::guarded`], une panique avortant le processus.
///
/// # Safety
///
/// `payload` doit être nul ou pointer sur une chaîne C valide, terminée par un nul, pour la
/// durée de l'appel. ⚠️ Elle n'appartient pas à Rust et ne lui survit pas : elle est copiée
/// avant tout autre geste, et le pointeur n'est jamais conservé.
extern "C" fn on_transcription_event(payload: *const std::ffi::c_char) {
  if payload.is_null() {
    return;
  }
  // SAFETY: le pont garantit une chaîne C valide, terminée par un nul, pour la durée de
  // l'appel. On ne conserve pas le pointeur.
  let raw = unsafe { std::ffi::CStr::from_ptr(payload) };
  let Ok(text) = raw.to_str() else {
    log::warn!("évènement de transcription non UTF-8, ignoré");
    return;
  };
  let Ok(event) = serde_json::from_str::<TranscriptionEvent>(text) else {
    // ⚠️ Jamais le texte dicté dans le message : un journal dit ce qui a échoué, pas sur quoi.
    log::warn!("évènement de transcription illisible, ignoré");
    return;
  };
  let Some(app) = commands::app() else {
    log::warn!("évènement de transcription reçu avant le démarrage, ignoré");
    return;
  };
  native::guarded("évènement de transcription", || dispatch(app, event));
}

/// Le traitement d'un évènement, une fois la charge utile relue.
///
/// Séparé du rappel pour que la lecture du pointeur brut reste hors du garde à paniques, qui
/// n'a rien à y protéger.
fn dispatch(app: &tauri::AppHandle, event: TranscriptionEvent) {
  commands::announce(app, TRANSCRIPTION_EVENT, &event);

  // ⚠️ Le pipeline est appelé ici, sans passer par le frontend : la dictée doit aboutir fenêtre
  // fermée. Seul le texte définitif l'intéresse — les partiels ne servent qu'à l'affichage.
  match event {
    TranscriptionEvent::Final { text } => commands::dictation::on_transcript(app, text),
    TranscriptionEvent::Failed { text } => commands::dictation::on_transcript(app, text),
    TranscriptionEvent::Partial { .. } => {}
  }
}

/// Monte le moteur et branche la remontée des évènements. Appelé une fois, dans `.setup()`.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse d'enregistrer l'observateur.
///
/// # Pièges
///
/// - ⚠️ À appeler avant toute session : un observateur enregistré en retard perd les partiels
///   déjà émis, et rien ne les rejoue.
pub fn setup(app: &tauri::AppHandle, engine: Arc<dyn SttEngine>) -> Result<(), AppError> {
  commands::remember_app(app);
  app.manage(SttHandle(engine));
  native::stt_set_observer(Some(on_transcription_event))
}

/// Ce que le moteur sait faire, sans démarrer de session ni ouvrir de micro.
///
/// L'interface s'en sert pour savoir si elle peut promettre du texte au fil de l'eau : un
/// moteur batch reste muet jusqu'à la fin, et cela doit se voir comme un choix de moteur,
/// pas comme une panne.
///
/// # Errors
///
/// Rend l'erreur du moteur, ou [`AppError::Io`] si la tâche n'est pas revenue.
#[tauri::command]
pub async fn get_stt_capabilities(
  engine: State<'_, SttHandle>,
) -> Result<EngineCapabilities, AppError> {
  let engine = engine.0.clone();
  off_thread(move || engine.capabilities()).await
}

/// Démarre une dictée : le moteur, puis le micro.
///
/// # Errors
///
/// Rend l'erreur du moteur, celle de [`audio::start_capture`], ou [`AppError::Io`] si la tâche
/// n'est pas revenue. Une capture en échec annule la session déjà ouverte.
///
/// # Pièges
///
/// - ⚠️ Le moteur d'abord : une capture branchée avant que le flux d'entrée existe envoie ses
///   premiers tampons dans le vide — et ce sont les premiers mots.
#[tauri::command]
pub async fn start_transcription(
  engine: State<'_, SttHandle>,
  language: String,
  device_id: Option<String>,
) -> Result<(), AppError> {
  let started = engine.0.clone();
  let language = language.clone();
  off_thread(move || started.start(&language)).await?;

  if let Err(error) = audio::start_capture(device_id).await {
    let engine = engine.0.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || engine.cancel()).await;
    return Err(error);
  }
  Ok(())
}

/// Termine la dictée ; le **final** arrive par évènement, pas par le retour de cette commande.
///
/// La capture s'arrête après la finalisation : le moteur a déjà débranché son puits, donc plus
/// aucun tampon n'entre, mais laisser le micro ouvert une milliseconde de trop allumerait
/// l'indicateur orange de macOS pour rien.
///
/// # Errors
///
/// Rend l'erreur de finalisation du moteur, celle de [`audio::stop_capture`], ou [`AppError::Io`]
/// si la tâche n'est pas revenue.
#[tauri::command]
pub async fn stop_transcription(engine: State<'_, SttHandle>) -> Result<(), AppError> {
  let engine = engine.0.clone();
  off_thread(move || engine.finish()).await?;
  audio::stop_capture().await
}

/// Abandonne la dictée : rien n'en sortira, ni final, ni partiel, ni entrée d'historique.
///
/// # Errors
///
/// Rend l'erreur d'annulation du moteur, à défaut celle de l'arrêt de la capture, ou
/// [`AppError::Io`] si la tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ Le micro s'arrête même si l'annulation du moteur échoue : l'utilisateur a demandé
///   l'arrêt, et l'indicateur orange de macOS resterait allumé.
#[tauri::command]
pub async fn cancel_transcription(engine: State<'_, SttHandle>) -> Result<(), AppError> {
  let engine = engine.0.clone();
  // ⚠️ Le `Ok` enveloppant tient les deux échecs séparés : l'annulation du moteur est mise de
  // côté le temps d'arrêter le micro, alors qu'une tâche perdue remonte tout de suite.
  let cancelled = off_thread(move || Ok(engine.cancel())).await?;
  let stopped = audio::stop_capture().await;
  cancelled.and(stopped)
}

#[cfg(test)]
mod tests {
  use super::TRANSCRIPTION_EVENT;

  /// Le nom de l'évènement est **du contrat**, pas un détail : le frontend s'y abonne par
  /// cette chaîne, et la renommer coupe les partiels en silence.
  #[test]
  fn the_event_name_is_part_of_the_contract() {
    assert_eq!(TRANSCRIPTION_EVENT, "transcription");
  }
}
