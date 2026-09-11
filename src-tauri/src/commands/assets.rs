//! Installer les ressources de transcription d'une langue.
//!
//! Swift possède l'installation (`native/Sources/MirmalionNative/SpeechAssets.swift`), ce module
//! relaie.
//!
//! # Pièges
//!
//! - ⚠️ Seule opération réseau de la dictée : elle se propose, ne se déclenche jamais seule.
//!   Aucune commande d'ici ne doit être appelée au chargement d'un écran.
//! - ⚠️ Ce module ne dit pas quelles langues sont installées : c'est `get_stt_capabilities` qui
//!   le fait, par `EngineCapabilities.installed_locales`, et gratuitement.
//! - ⚠️ Sonder la disponibilité d'une langue consomme une réservation, et il n'y en a que cinq.

use serde::{Deserialize, Serialize};

use crate::{blocking::off_thread, commands, error::AppError, native};

/// Le nom de l'évènement Tauri qui porte le déroulé d'une installation.
///
/// # Pièges
///
/// - ⚠️ Un seul canal pour les quatre natures — progression, succès, annulation, échec —, parce
///   qu'elles sont ordonnées : sur quatre canaux, un abonné pourrait recevoir la fin avant le
///   dernier pourcentage, et afficher une barre qui recule après « terminé ».
pub const ASSET_EVENT: &str = "language-install";

/// Les réservations de locales détenues par l'application, et le plafond de la machine.
///
/// # Pièges
///
/// - ⚠️ Le pont ne se traverse qu'en types nommés aux deux bouts : rendre la chaîne JSON brute
///   reporte la désérialisation côté TypeScript, où l'annotation d'`invoke<T>()` est une
///   affirmation du développeur et non une vérification — les champs y valent `undefined` sans
///   que rien ne le signale.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleReservations {
  /// Les identifiants de locale que l'application réserve.
  ///
  /// ⚠️ Ce sont des identifiants **complets** — `es-US`, `de-AT` —, jamais des codes à deux
  /// lettres : une langue s'y reconnaît par son préfixe, et comparer par égalité fait refuser
  /// une langue pourtant installée.
  pub reserved: Vec<String>,
  /// Le nombre de réservations que la machine accepte.
  pub maximum: usize,
}

/// Ce qu'une installation raconte au fil de l'eau. Miroir d'`AssetInstallEvent` côté Swift.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AssetInstallEvent {
  /// Avancement, entre 0 et 1.
  Progress {
    /// La langue en cours d'installation.
    language: String,
    /// L'avancement, entre `0.0` et `1.0`.
    progress: f64,
  },
  /// Les ressources sont en place : la langue devient transcriptible.
  Installed {
    /// La langue désormais installée.
    language: String,
  },
  /// L'utilisateur a renoncé. **Rien n'est installé**, et ce n'est pas une erreur.
  Cancelled {
    /// La langue dont l'installation a été abandonnée.
    language: String,
  },
  /// Le quota de réservations est plein.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un cas à part et non un `Failed` : ce n'est pas une panne mais un arbitrage — retirer
  ///   une langue pour en ajouter une. Un `Failed` remonterait le message d'Apple, en anglais,
  ///   à quelqu'un qui lit dans six langues.
  Full {
    /// La langue qu'on ne peut pas installer faute de créneau.
    language: String,
  },
  /// L'installation a échoué. Le message est destiné à l'utilisateur.
  Failed {
    /// La langue dont l'installation a échoué.
    language: String,
    /// Le motif, tel qu'il peut être montré.
    message: String,
  },
}

/// Le rappel appelé **par Swift**, depuis un fil quelconque, à chaque étape d'installation.
///
/// # Safety
///
/// `payload` doit être nul ou pointer sur une chaîne C valide, terminée par un nul, pour la
/// durée de l'appel. ⚠️ Elle n'appartient pas à Rust et ne lui survit pas : elle est copiée
/// avant tout autre geste.
///
/// # Pièges
///
/// - ⚠️ Aucune panique ne doit s'en échapper : elle avorterait le processus, d'où
///   [`native::guarded`]. Une charge utile illisible est journalisée et jetée.
extern "C" fn on_asset_install_event(payload: *const std::ffi::c_char) {
  if payload.is_null() {
    return;
  }
  // SAFETY: le pont garantit une chaîne C valide, terminée par un nul, pour la durée de
  // l'appel. On ne conserve pas le pointeur.
  let raw = unsafe { std::ffi::CStr::from_ptr(payload) };
  let Ok(text) = raw.to_str() else {
    log::warn!("évènement d'installation non UTF-8, ignoré");
    return;
  };
  let event = match serde_json::from_str::<AssetInstallEvent>(text) {
    Ok(event) => event,
    Err(error) => {
      // ⚠️ L'erreur de `serde` nomme le `kind` refusé, et il faut la garder : « évènement
      // illisible » seul ne dirait pas lequel, et une variante absente de ce relais serait jetée
      // sans que rien ne permette de le voir. Un `kind` est une valeur de notre propre contrat,
      // pas du contenu utilisateur.
      log::warn!("évènement d'installation illisible, ignoré : {error}");
      return;
    }
  };
  log::debug!("installation de langue : évènement {event:?}");
  let Some(app) = commands::app() else {
    log::warn!("évènement d'installation reçu avant le démarrage, ignoré");
    return;
  };
  native::guarded("évènement d'installation", || {
    commands::announce(app, ASSET_EVENT, event);
  });
}

/// Branche la remontée des évènements. Appelé une fois, dans `.setup()`.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont refuse d'enregistrer l'observateur.
///
/// # Pièges
///
/// - ⚠️ À appeler avant toute installation : un observateur enregistré en retard perd la
///   progression déjà émise, et rien ne la rejoue.
pub fn setup(app: &tauri::AppHandle) -> Result<(), AppError> {
  commands::remember_app(app);
  native::assets_set_observer(Some(on_asset_install_event))
}

/// Lance le téléchargement des ressources d'une langue et rend la main immédiatement ; la suite
/// arrive par [`ASSET_EVENT`].
///
/// # Errors
///
/// Rend [`AppError::Native`] si le natif refuse la demande, [`AppError::Io`] sur tâche perdue.
///
/// # Pièges
///
/// - ⚠️ Ne s'appelle que sur un geste explicite de l'utilisateur.
/// - ⚠️ L'entrée se journalise, pas seulement les échecs : sans elle, un bouton sans effet ne
///   permet pas de distinguer « le frontend n'a jamais appelé » de « il a appelé sans retour ».
#[tauri::command]
pub async fn install_language(language: String) -> Result<(), AppError> {
  log::debug!("installation de langue : demandée pour {language}");
  // ⚠️ Le `Ok` enveloppant garde les deux échecs distincts : le refus du natif descend dans le
  // `match` ci-dessous, une tâche qui ne revient pas remonte sans passer par lui — elle n'est pas
  // un refus, et la journaliser comme tel induirait en erreur.
  let outcome = off_thread(move || Ok(native::install_language(&language))).await?;
  match &outcome {
    Ok(()) => log::debug!("installation de langue : le natif a pris la demande"),
    Err(error) => log::warn!("installation de langue refusée par le natif : {error}"),
  }
  outcome
}

/// Abandonne l'installation en cours, sans effet si rien ne tourne.
///
/// Appelable sur un chemin d'erreur sans avoir à savoir où l'on en était.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le natif refuse l'annulation, ou [`AppError::Io`] si la tâche n'est
/// pas revenue.
#[tauri::command]
pub async fn cancel_language_install() -> Result<(), AppError> {
  off_thread(native::cancel_language_install).await
}

/// Les langues dont **nous** détenons la réservation, et le plafond de la machine.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue ou si sa réponse est illisible.
///
/// # Pièges
///
/// - ⚠️ La réservation est ce qui fait tenir le pack : la libérer le fait reclamer par macOS. Ce
///   quota est un plafond de langues **installées**, pas un compteur de téléchargements en cours.
/// - ⚠️ Les langues système n'y figurent pas et n'en consomment rien : la couverture atteignable
///   est *système + plafond*, jamais le plafond seul.
#[tauri::command]
pub async fn get_locale_reservations() -> Result<LocaleReservations, AppError> {
  let raw = off_thread(native::locale_reservations).await?;
  native::parse(&raw, "les réservations")
}

/// Rend la réservation d'une langue, **et donc son pack**.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le natif refuse, [`AppError::Io`] sur tâche perdue.
///
/// # Pièges
///
/// - ⚠️ Après cet appel, macOS reclame les ressources et la langue doit être retéléchargée pour
///   redevenir dictable : le seul appelant légitime libère un créneau pour en installer une
///   autre, et il doit l'avoir fait dire à l'utilisateur.
/// - ⚠️ Sans effet sur une langue système, qui ne détient aucune réservation.
#[tauri::command]
pub async fn release_language(language: String) -> Result<(), AppError> {
  off_thread(move || native::release_locale(&language)).await
}

/// Les langues sorties du périmètre, dont l'application peut encore détenir une réservation.
const RETIRED_LANGUAGES: [&str; 3] = ["zh", "ja", "ko"];

/// Rend les réservations de locale détenues pour une langue sortie du périmètre.
///
/// Apple plafonne à cinq les locales réservées, et plus aucun écran ne libère celles-là.
///
/// # Pièges
///
/// - ⚠️ Sans effet sur une langue jamais installée, et un échec n'empêche pas de démarrer : la
///   place perdue est un désagrément, pas une panne.
/// - ⚠️ En tâche de fond : appelée dans `setup`, elle retarderait l'ouverture de la fenêtre.
pub fn release_retired_languages_on_launch() {
  tauri::async_runtime::spawn_blocking(|| {
    for language in RETIRED_LANGUAGES {
      if let Err(error) = native::release_locale(language) {
        log::warn!("réservation de locale non libérée : {error}");
      }
    }
  });
}

/// La langue dont l'installation est en cours, ou `None`.
///
/// # Errors
///
/// Rend [`AppError::Native`] si le pont échoue, ou [`AppError::Io`] si la tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ Nécessaire au démarrage d'une fenêtre : la principale peut être fermée puis rouverte
///   pendant un téléchargement, et sans cette lecture elle réafficherait « non installée » avec
///   un bouton qui relancerait tout.
#[tauri::command]
pub async fn get_language_install_in_flight() -> Result<Option<String>, AppError> {
  off_thread(native::language_install_in_flight).await
}

#[cfg(test)]
mod tests {
  use super::{AssetInstallEvent, LocaleReservations};

  /// ⚠️ Ce que Swift écrit doit se lire en une structure, pas en une chaîne : sur du JSON brut,
  /// le TypeScript croit recevoir un objet et lit `undefined` sur chaque champ, sans qu'aucun
  /// test n'ait de prise. Ce test met le format du pont et le type de la commande dans le même
  /// fichier, où ils ne peuvent plus diverger en silence.
  #[test]
  fn reads_the_reservations_swift_writes() {
    let raw = r#"{"reserved":["pt-PT","es-ES","de-AT","es-US","it-IT"],"maximum":5}"#;
    let parsed: LocaleReservations = serde_json::from_str(raw).expect("le format du pont");
    assert_eq!(parsed.maximum, 5);
    assert_eq!(parsed.reserved.len(), 5);
    // ⚠️ Des identifiants complets, jamais des codes à deux lettres.
    assert!(parsed.reserved.contains(&"es-US".to_string()));
  }

  /// Aucune réservation détenue : les langues présentes viennent du système. Le cas nominal
  /// d'une machine neuve, et il ne doit pas se confondre avec une réponse illisible.
  #[test]
  fn reads_an_empty_reservation_list() {
    let parsed: LocaleReservations =
      serde_json::from_str(r#"{"reserved":[],"maximum":5}"#).expect("aucune réservation");
    assert!(parsed.reserved.is_empty());
    assert_eq!(parsed.maximum, 5);
  }

  /// Le contrat traverse dans les deux sens : ce que la commande rend doit se relire côté
  /// TypeScript sous les noms qu'il attend.
  #[test]
  fn serializes_reservations_in_camel_case() {
    let json = serde_json::to_value(LocaleReservations {
      reserved: vec!["es-US".into()],
      maximum: 5,
    })
    .expect("sérialisation");
    assert_eq!(json["reserved"][0], "es-US");
    assert_eq!(json["maximum"], 5);
  }

  /// ⚠️ **Aucun test ne lance d'installation, et ce n'est pas un oubli.** Ce serait
  /// télécharger plusieurs gigaoctets depuis Apple à chaque `cargo test` — un appel réseau
  /// dans une suite qui doit tourner hors ligne, et exactement ce que la règle globale n° 4
  /// interdit. Ce qui se teste ici est le contrat qui traverse le pont.
  #[test]
  fn reads_what_swift_writes() {
    let event: AssetInstallEvent =
      serde_json::from_str(r#"{"kind":"progress","language":"it","progress":0.47}"#)
        .expect("le pont émet exactement cette forme");
    assert_eq!(
      event,
      AssetInstallEvent::Progress {
        language: "it".into(),
        progress: 0.47,
      }
    );

    let event: AssetInstallEvent =
      serde_json::from_str(r#"{"kind":"installed","language":"it"}"#).expect("succès");
    assert_eq!(
      event,
      AssetInstallEvent::Installed {
        language: "it".into()
      }
    );

    let event: AssetInstallEvent =
      serde_json::from_str(r#"{"kind":"cancelled","language":"it"}"#).expect("annulation");
    assert_eq!(
      event,
      AssetInstallEvent::Cancelled {
        language: "it".into()
      }
    );

    let event: AssetInstallEvent =
      serde_json::from_str(r#"{"kind":"failed","language":"it","message":"réseau"}"#)
        .expect("échec");
    assert_eq!(
      event,
      AssetInstallEvent::Failed {
        language: "it".into(),
        message: "réseau".into(),
      }
    );
  }

  /// ⚠️ Ce test ne vérifie pas que les cas connus se lisent, mais que **tous ceux que Swift sait
  /// émettre** se lisent : une variante ajoutée à Swift et à Angular sans passer par ce relais y
  /// est jetée en silence, et le test voisin reste vert.
  ///
  /// ⚠️ La liste se tient à la main : rien ne relie un `enum` Swift à un `enum` Rust à la
  /// compilation. Ajouter un cas à `enum AssetInstallEvent` dans
  /// `native/Sources/MirmalionNative/SpeechAssets.swift`, c'est ajouter une ligne ici.
  #[test]
  fn reads_every_kind_swift_can_emit() {
    for payload in [
      r#"{"kind":"progress","language":"it","progress":0.5}"#,
      r#"{"kind":"installed","language":"it"}"#,
      r#"{"kind":"cancelled","language":"it"}"#,
      r#"{"kind":"full","language":"it"}"#,
      r#"{"kind":"failed","language":"it","message":"réseau"}"#,
    ] {
      assert!(
        serde_json::from_str::<AssetInstallEvent>(payload).is_ok(),
        "le relais doit savoir lire ce que Swift émet, sinon l'évènement est jeté \
         sans jamais atteindre l'écran : {payload}"
      );
    }
  }

  /// ⚠️ **Le quota plein n'est PAS un échec** — même raison que l'annulation, et la même
  /// conséquence s'il se confondait : un arbitrage à proposer prendrait l'allure d'une panne.
  #[test]
  fn tells_a_full_quota_from_a_failure() {
    let full = AssetInstallEvent::Full {
      language: "it".into(),
    };
    let failed = AssetInstallEvent::Failed {
      language: "it".into(),
      message: "Too many allocated locales, 5 maximum".into(),
    };
    assert_ne!(full, failed);
    let json = serde_json::to_value(&full).expect("sérialisation");
    assert_eq!(json["kind"], "full");
    assert_eq!(json["language"], "it");
  }

  /// ⚠️ **L'annulation n'est PAS un échec**, et la distinction doit survivre au pont : un
  /// abandon volontaire affiché comme une panne ferait douter l'utilisateur de son geste.
  #[test]
  fn tells_a_refusal_from_a_failure() {
    let cancelled = AssetInstallEvent::Cancelled {
      language: "it".into(),
    };
    let failed = AssetInstallEvent::Failed {
      language: "it".into(),
      message: "réseau".into(),
    };
    assert_ne!(cancelled, failed);
  }

  #[test]
  fn serializes_in_camel_case() {
    let json = serde_json::to_value(AssetInstallEvent::Progress {
      language: "it".into(),
      progress: 0.5,
    })
    .expect("sérialisation");
    assert_eq!(json["kind"], "progress");
    assert_eq!(json["language"], "it");
    assert_eq!(json["progress"], 0.5);
  }

  /// Une charge utile inconnue est refusée plutôt qu'interprétée : le rappel la journalise et
  /// la jette, ce qui vaut mieux qu'un état inventé.
  #[test]
  fn refuses_a_payload_it_does_not_know() {
    assert!(serde_json::from_str::<AssetInstallEvent>(r#"{"kind":"pending"}"#).is_err());
    assert!(serde_json::from_str::<AssetInstallEvent>("{").is_err());
  }
}
