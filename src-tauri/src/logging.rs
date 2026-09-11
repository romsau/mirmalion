//! La journalisation : bavarde en développement, presque muette en production.
//!
//! Deux profils. En développement, niveau `debug` vers stdout **et** un fichier local largement
//! plafonné ; en production, niveau `warn` vers le seul fichier local, plafonné, rotation à un
//! fichier. En production, `debug` et `info` ne sont pas seulement filtrés : `log` les élimine,
//! et l'argument des macros n'est jamais évalué. Les journaux restent locaux — zéro télémétrie,
//! le rapport de crash est manuel et opt-in.
//!
//! # Pièges
//!
//! - ⚠️ Aucun contenu utilisateur dans un message : ni texte dicté, ni transcript, ni compte
//!   rendu, ni nom de fichier importé, ni empreinte vocale, ni clé. Un message dit **ce qui** a
//!   échoué, jamais **sur quoi**. La règle vaut pour les [`crate::AppError`], qui traversent
//!   jusqu'au frontend et dont les messages sont écrits ici.

use tauri_plugin_log::{Builder, Target, TargetKind};

/// Taille au-delà de laquelle le journal de production repart de zéro.
const MAX_LOG_SIZE: u128 = 512 * 1024;

/// Le plafond de production, vérifié à la **compilation**.
///
/// # Pièges
///
/// - ⚠️ Le journal ne doit jamais pouvoir grossir sans fin sur la machine de l'utilisateur :
///   cette assertion est ce qui empêche de relever [`MAX_LOG_SIZE`] par inadvertance.
const _: () = assert!(MAX_LOG_SIZE <= 1024 * 1024);

/// Taille du journal de **développement**, plus généreuse.
///
/// # Pièges
///
/// - ⚠️ Ce n'est pas un relâchement du plafond de production, qui reste vérifié à la compilation
///   juste au-dessus. Ce fichier-ci ne quitte jamais une machine de développement et doit tenir
///   plusieurs jours d'usage : la mesure de latence s'y accumule au fil de l'eau, et une
///   rotation trop rapide effacerait les dictées de la veille.
const MAX_DEV_LOG_SIZE: u128 = 8 * 1024 * 1024;

/// Nom du fichier de journal, dans le répertoire de logs de l'application.
const LOG_FILE: &str = "mirmalion";

/// Le niveau retenu pour ce profil de compilation : `debug` en développement, `warn` sinon.
fn level() -> log::LevelFilter {
  if cfg!(debug_assertions) {
    log::LevelFilter::Debug
  } else {
    log::LevelFilter::Warn
  }
}

/// Construit le journal correspondant au profil de compilation.
pub fn build() -> tauri::plugin::TauriPlugin<tauri::Wry> {
  let builder = Builder::new().clear_targets().level(level());

  if cfg!(debug_assertions) {
    // Stdout et disque : le pipeline émet une ligne de latence par dictée, et une mesure qui ne
    // survit pas à la fermeture du terminal obligerait à refaire la série sur commande. Sur le
    // disque, elle s'accumule au fil de l'usage et `npm run latency` la relit. Le fichier est
    // plafonné, tourne comme en production, et n'existe que dans un binaire de développement.
    builder
      .target(Target::new(TargetKind::Stdout))
      .target(Target::new(TargetKind::LogDir {
        file_name: Some(LOG_FILE.to_owned()),
      }))
      .max_file_size(MAX_DEV_LOG_SIZE)
      .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
      .build()
  } else {
    // Ce qui reste sert au rapport de crash manuel. Plafonné pour ne jamais grossir
    // sans fin sur la machine de l'utilisateur.
    builder
      .target(Target::new(TargetKind::LogDir {
        file_name: Some(LOG_FILE.to_owned()),
      }))
      .max_file_size(MAX_LOG_SIZE)
      .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
      .build()
  }
}

#[cfg(test)]
mod tests {
  use super::level;
  use log::LevelFilter;

  /// Ces deux tests sont la preuve **exécutée** que le profil impose le bon niveau. Chacun
  /// ne tourne que dans son profil et affirme une valeur **en dur** — pas `cfg!`, sinon
  /// l'assertion ne prouverait rien.
  #[cfg(debug_assertions)]
  #[test]
  fn development_logs_down_to_debug() {
    assert_eq!(level(), LevelFilter::Debug);
  }

  #[cfg(not(debug_assertions))]
  #[test]
  fn production_drops_everything_below_a_warning() {
    assert_eq!(level(), LevelFilter::Warn);
    assert!(
      level() < LevelFilter::Info,
      "ni `info!` ni `debug!` ne doivent survivre à un build de production"
    );
  }
}
