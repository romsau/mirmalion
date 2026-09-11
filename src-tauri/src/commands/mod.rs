//! Les commandes IPC, un module par domaine.
//!
//! Chaque commande renvoie `Result<T, AppError>` et ne panique jamais. Les structures
//! d'entrée et de sortie portent `#[serde(rename_all = "camelCase")]` pour coller au
//! TypeScript d'en face.

pub mod app_info;
pub mod assets;
pub mod audio;
pub mod autostart;
pub mod db;
pub mod dictation;
pub mod dictations;
pub mod dictionary;
pub mod export;
pub mod filedoc;
pub mod injection;
pub mod language;
pub mod live;
pub mod llm;
pub mod media;
pub mod onboarding;
pub mod overlay;
pub mod permissions;
pub mod prompts;
pub mod shortcut;
pub mod stt;
pub mod system;
pub mod transcription;
pub mod translation;
pub mod window;

use std::sync::OnceLock;

/// Le handle applicatif, à l'usage des rappels `extern "C"` venus du pont.
///
/// Posé une seule fois au démarrage, jamais muté ensuite. Deux rappels s'en servent : les
/// évènements de transcription et les fronts du raccourci.
///
/// # Pièges
///
/// - ⚠️ Seul global du crate, et il doit le rester : un rappel `extern "C"` ne transporte ni
///   `State`, ni `self`, ni fermeture capturante. Tout autre état partagé passe par `.manage()`.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Mémorise le handle applicatif.
///
/// Appelé une fois, au `.setup()` ; les appels suivants sont ignorés sans erreur.
pub fn remember_app(app: &tauri::AppHandle) {
  let _ = APP.set(app.clone());
}

/// Le handle, ou `None` si un rappel arrive avant que le démarrage n'ait fini.
pub fn app() -> Option<&'static tauri::AppHandle> {
  APP.get()
}

/// Le nettoyage a-t-il changé la langue ? Lit les deux textes, puis tranche.
///
/// Partagé par les deux points d'entrée du nettoyage, qui écartent la même sortie.
///
/// # Pièges
///
/// - ⚠️ Le doute ne rejette rien : une lecture en échec — pont cassé, texte trop court — rend
///   `None`, et `llm::fidelity::changed_language` garde alors le nettoyage.
/// - ⚠️ Lire la langue d'un texte n'appelle aucun modèle et ne bloque pas : c'est
///   `NLLanguageRecognizer`. À ne pas confondre avec `native::detect_language`, qui écoute un
///   média et coûte des secondes.
pub fn cleanup_changed_language(language: &str, raw: &str, cleaned: &str) -> bool {
  let read = |text: &str| crate::native::detect_text_language(text).ok().flatten();
  crate::llm::fidelity::changed_language(language, read(raw).as_deref(), read(cleaned).as_deref())
}

/// Annonce un évènement aux fenêtres, et journalise s'il ne part pas.
///
/// # Pièges
///
/// - ⚠️ Un échec ne remonte pas : l'appelant a déjà fait le travail qui comptait, et rendre une
///   erreur pour une fenêtre fermée ferait échouer une dictée qui a abouti.
/// - ⚠️ Le message ne porte que le **nom** de l'évènement, qui est une constante — la charge
///   utile, elle, transporte du texte dicté sur la moitié de ces chemins.
/// - ⚠️ Pas pour un flux d'avancement : cent pourcentages perdus donneraient cent
///   avertissements pour une barre qui rattrape au suivant.
pub fn announce<T: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: T) {
  use tauri::Emitter;
  if let Err(error) = app.emit(event, payload) {
    log::warn!("évènement « {event} » non émis : {error}");
  }
}

/// Adresse un évènement à **une seule** fenêtre, et journalise s'il ne part pas.
///
/// # Pièges
///
/// - ⚠️ Une étiquette inconnue n'est **pas** une erreur pour Tauri : l'évènement part dans le
///   vide, en silence. Ne s'emploie que là où l'étiquette est celle d'une fenêtre qu'on vient
///   d'ouvrir soi-même.
/// - ⚠️ Le destinataire ne remplace pas l'identifiant porté par la charge utile : une fenêtre
///   pose ses écouteurs sans cible et reçoit donc aussi ce qui est diffusé.
pub fn announce_to<T: serde::Serialize + Clone>(
  app: &tauri::AppHandle,
  label: &str,
  event: &str,
  payload: T,
) {
  use tauri::Emitter;
  if let Err(error) = app.emit_to(label, event, payload) {
    log::warn!("évènement « {event} » non adressé : {error}");
  }
}

#[cfg(test)]
mod tests {
  use super::cleanup_changed_language;

  /// **Les trois dérives relevées dans un historique réel**, brut et sortie tels qu'ils ont été
  /// archivés. Elles étaient insérées au curseur : aucun garde-fou ne regardait la langue.
  #[test]
  fn the_three_measured_drifts_are_all_refused() {
    let drifts = [
      (
        "Dont les ETB Pokémon, il existe des versions Pokémon Center, tu peux m'expliquer",
        "Don't the ETB Pokémon, there are Pokémon Center versions, you can explain",
      ),
      ("Évolution cé", "Evolution of the"),
      (
        "Finalement, 15 résultats par défaut",
        "Finalement, 15 resultados por defecto",
      ),
    ];

    for (raw, cleaned) in drifts {
      assert!(
        cleanup_changed_language("fr", raw, cleaned),
        "dérive non écartée : {cleaned}"
      );
    }
  }

  /// ⚠️ Le faux positif que le garde-fou doit tolérer : « On continue. » est du français que le
  /// lecteur dit anglais. Le brut se lit pareil, donc le nettoyage n'a rien changé.
  #[test]
  fn a_frenchness_the_reader_misreads_costs_no_cleanup() {
    assert!(!cleanup_changed_language(
      "fr",
      "on continue",
      "On continue."
    ));
  }
}
