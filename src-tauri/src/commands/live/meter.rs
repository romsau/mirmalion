//! Le VU-mètre : ce que la fenêtre affiche pendant qu'une session tourne.
//!
//! # Pièges
//!
//! - ⚠️ Le niveau seul ne prouve rien : sur un flux gelé, le natif garde sa dernière valeur
//!   lissée. C'est le compteur de trames qui dit si le son coule encore.

use serde::Serialize;
use tauri::AppHandle;

use super::{LIVE_LEVEL_EVENT, capture::LiveCaptureStatus};
use crate::native;

/// Ce que porte [`LIVE_LEVEL_EVENT`] : le niveau combiné, de 0 à 1.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveLevel {
  level: f64,
}

/// Le pas du relevé de niveau : dix par seconde, et pas davantage.
///
/// # Pièges
///
/// - ⚠️ En dessous, le mètre avance par saccades visibles ; au-dessus, on paie une traversée de
///   plus pour un mouvement que l'œil ne distingue pas. Le lissage vit côté natif.
const LEVEL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Ce que le mètre doit afficher pour ce relevé, et le compte d'échantillons à retenir.
///
/// # Pièges
///
/// - ⚠️ Un flux qui ne progresse plus vaut zéro, quel que soit son dernier niveau : le natif lisse
///   sa valeur à chaque tampon reçu, et sans tampon elle reste figée. Ce sont les compteurs
///   d'échantillons qui distinguent « c'est silencieux » de « c'est arrêté ».
/// - ⚠️ Le premier relevé coule par convention : il n'a rien à quoi se comparer, et le couvrir
///   d'un zéro laisserait les barres à plat pendant un dixième de seconde à chaque session.
fn metered(status: &LiveCaptureStatus, last_frames: Option<u64>) -> (f64, u64) {
  let frames = status.system_frames + status.microphone_frames;
  let flowing = last_frames.is_none_or(|last| frames > last);
  (if flowing { status.level } else { 0.0 }, frames)
}

/// Combien de tampons le disque a refusés, **s'il faut le dire** — `None` sinon.
///
/// Décision pure : elle n'écrit rien, elle tranche. C'est ce qui la rend éprouvable, et c'est
/// elle qui porte la règle, pas son appelant.
///
/// # Pièges
///
/// - ⚠️ `already_said` n'est pas une commodité : le relevé tourne **dix fois par seconde**. Sans
///   lui, un disque plein produirait 36 000 lignes par heure dans un journal plafonné à 512 Ko,
///   et effacerait par rotation tout ce qui expliquait la panne. Le remède détruirait la preuve.
/// - ⚠️ Les deux flux comptent : une session peut perdre son fichier micro et garder l'autre.
fn write_failures_to_report(status: &LiveCaptureStatus, already_said: bool) -> Option<u64> {
  if already_said {
    return None;
  }
  let refused = status.system_write_failures + status.microphone_write_failures;
  (refused > 0).then_some(refused)
}

/// Dit une seule fois que le disque refuse des tampons, et lève le drapeau qui l'en empêchera.
///
/// # Pièges
///
/// - ⚠️ Un compte, jamais un chemin ni le message d'erreur du système : le journal dit ce qui a
///   échoué, jamais sur quoi.
fn warn_on_write_failures(status: &LiveCaptureStatus, warned: &mut bool) {
  let Some(refused) = write_failures_to_report(status, *warned) else {
    return;
  };
  *warned = true;
  log::warn!(
    "le disque a refusé {refused} tampon(s) audio : l'enregistrement de cette session sera \
     incomplet, les compteurs de trames ne le disent pas"
  );
}

/// Bat la mesure du VU-mètre, du démarrage du tap jusqu'à son arrêt.
///
/// # Pièges
///
/// - ⚠️ Un fil dédié, et non une tâche du runtime : [`native::live_status`] bloque, et le tenir
///   dix fois par seconde sur l'exécuteur asynchrone y prendrait la place des commandes.
/// - ⚠️ Le zéro final compte autant que la boucle : un tap qui se ferme tout seul — un
///   périphérique débranché — laisserait sinon le mètre figé sur sa dernière valeur.
pub(super) fn watch_level(app: &AppHandle, window: String) {
  let app = app.clone();
  std::thread::spawn(move || {
    let mut last_frames: Option<u64> = None;
    // ⚠️ Porté par la boucle et non par la fonction : chaque session repart d'un journal vierge.
    let mut warned = false;
    loop {
      std::thread::sleep(LEVEL_INTERVAL);
      // Un relevé illisible arrête la mesure plutôt que d'insister : le pont ne se remet pas tout
      // seul, et une boucle obstinée tiendrait un fil jusqu'à la fin du processus.
      let Ok(raw) = native::live_status() else {
        break;
      };
      let Ok(status) = native::parse::<LiveCaptureStatus>(&raw, "l'état de la capture de session")
      else {
        break;
      };
      if !status.running {
        break;
      }
      let (level, frames) = metered(&status, last_frames);
      last_frames = Some(frames);
      warn_on_write_failures(&status, &mut warned);
      crate::commands::announce_to(&app, &window, LIVE_LEVEL_EVENT, &LiveLevel { level });
    }
    crate::commands::announce_to(&app, &window, LIVE_LEVEL_EVENT, &LiveLevel { level: 0.0 });
  });
}

#[cfg(test)]
mod tests {
  use super::{LiveCaptureStatus, warn_on_write_failures, write_failures_to_report};

  /// Un relevé, avec les seuls champs que le mètre regarde.
  fn reading(system_frames: u64, microphone_frames: u64, level: f64) -> LiveCaptureStatus {
    LiveCaptureStatus {
      running: true,
      source_id: None,
      source_name: None,
      system_frames,
      microphone_frames,
      system_input_frames: 0,
      microphone_input_frames: 0,
      system_input_sample_rate: 48_000.0,
      microphone_input_sample_rate: 48_000.0,
      system_dropped_buffers: 0,
      microphone_dropped_buffers: 0,
      system_write_failures: 0,
      microphone_write_failures: 0,
      level,
      system_path: None,
      microphone_path: None,
    }
  }

  /// Un relevé où le disque a refusé des tampons.
  fn refusing(system: u64, microphone: u64) -> LiveCaptureStatus {
    let mut status = reading(16_000, 16_000, 0.5);
    status.system_write_failures = system;
    status.microphone_write_failures = microphone;
    status
  }

  /// ⚠️ **Le relevé tourne dix fois par seconde.** Avertir à chaque passage remplirait le journal
  /// plafonné — 36 000 lignes par heure — et effacerait par rotation tout ce qui expliquait la
  /// panne : le remède détruirait la preuve.
  ///
  /// ⚠️ L'assertion porte sur la **décision**, pas sur le drapeau. Un test qui vérifierait que
  /// `warned` vaut vrai à la fin passerait aussi bien sans le garde — vérifié.
  #[test]
  fn the_disk_refusing_buffers_is_said_once_and_not_ten_times_a_second() {
    assert_eq!(
      write_failures_to_report(&refusing(3, 0), false),
      Some(3),
      "le premier refus se dit"
    );
    // Les relevés suivants voient un compte qui grimpe, et n'ont plus rien à dire.
    for refused in [7, 19, 42] {
      assert_eq!(
        write_failures_to_report(&refusing(refused, refused), true),
        None,
        "on ne redit pas un refus déjà dit"
      );
    }
  }

  /// Les deux flux comptent, pas seulement le système : une session peut perdre son fichier
  /// micro et garder l'autre.
  #[test]
  fn a_refusal_on_either_stream_is_enough_to_be_said() {
    assert_eq!(write_failures_to_report(&refusing(1, 0), false), Some(1));
    assert_eq!(write_failures_to_report(&refusing(0, 1), false), Some(1));
    assert_eq!(write_failures_to_report(&refusing(2, 3), false), Some(5));
  }

  /// Le cas nominal — le disque suit — n'a rien à dire du tout.
  #[test]
  fn a_disk_that_keeps_up_says_nothing() {
    assert_eq!(write_failures_to_report(&refusing(0, 0), false), None);
  }

  /// Le drapeau de l'appelant se lève au premier refus, et le fait taire ensuite.
  #[test]
  fn the_flag_closes_the_door_behind_the_first_warning() {
    let mut warned = false;

    warn_on_write_failures(&refusing(0, 0), &mut warned);
    assert!(!warned, "rien à dire, rien à retenir");

    warn_on_write_failures(&refusing(4, 0), &mut warned);
    assert!(warned);
    assert_eq!(
      write_failures_to_report(&refusing(9, 9), warned),
      None,
      "le drapeau levé ferme la porte"
    );
  }

  /// ⚠️ **UN FLUX QUI NE PROGRESSE PLUS AFFICHE ZÉRO, QUEL QUE SOIT SON DERNIER NIVEAU.** Le natif
  /// fige sa dernière valeur quand plus aucun tampon n'arrive : le mètre continuerait d'afficher
  /// du son sur un enregistrement mort. Comparer les compteurs est le seul moyen de distinguer
  /// « c'est silencieux » de « c'est arrêté ».
  #[test]
  fn a_frozen_stream_reads_as_silence_and_not_as_its_last_level() {
    let frozen = reading(1_600, 0, 0.9);

    let (level, frames) = super::metered(&frozen, Some(1_600));

    assert_eq!(level, 0.0);
    assert_eq!(frames, 1_600);
  }

  #[test]
  fn a_stream_that_still_writes_keeps_the_level_the_native_smoothed() {
    let (level, frames) = super::metered(&reading(1_600, 800, 0.25), Some(1_600));

    assert_eq!(level, 0.25);
    assert_eq!(
      frames, 2_400,
      "les deux flux comptent, pas seulement le système"
    );
  }

  /// ⚠️ Le premier relevé n'a rien à quoi se comparer : le couvrir d'un zéro laisserait les barres
  /// à plat pendant un dixième de seconde au début de chaque session.
  #[test]
  fn the_first_reading_of_a_session_flows_by_convention() {
    let (level, _) = super::metered(&reading(0, 0, 0.4), None);

    assert_eq!(level, 0.4);
  }
}
