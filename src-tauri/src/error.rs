//! Le type d'erreur unique du backend : toute commande IPC rend `Result<T, AppError>`.
//!
//! La sérialisation est discriminée — `{ "kind": "...", "message": "..." }` — et c'est le
//! contrat que le frontend type dans `src/app/core/models/app-error.ts`.
//!
//! # Pièges
//!
//! - ⚠️ Les discriminants voyagent en IPC. On ajoute des variantes, on n'en renomme jamais :
//!   un renommage casse tous les appelants du frontend sans que rien ne le signale.

use serde::ser::{Serialize, SerializeStruct, Serializer};

/// Toute erreur remontée au frontend.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
  /// Lecture, écriture ou résolution de chemin en échec — et, plus largement, la plomberie :
  /// une erreur de Tauri, une tâche bloquante qui n'est pas revenue (voir `blocking`).
  #[error("{0}")]
  Io(String),
  /// La base chiffrée est inaccessible, corrompue, ou refuse la requête.
  #[error("{0}")]
  Database(String),
  /// Le trousseau macOS a refusé l'accès à la clé de chiffrement.
  #[error("{0}")]
  Keychain(String),
  /// Une brique native (Swift) a échoué.
  #[error("{0}")]
  Native(String),
  /// Une autorisation macOS (TCC) manque ou a été révoquée.
  #[error("{0}")]
  Permission(String),
  /// Le frontend a envoyé un argument que la commande refuse.
  #[error("{0}")]
  InvalidArgument(String),
  /// L'écriture bute sur une unicité déjà tenue par une autre ligne.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Distincte de [`AppError::Database`] pour que l'interface puisse dire « ce titre est
  ///   déjà pris » dans la langue de l'utilisateur, là où un disque plein reste un incident.
  /// - ⚠️ Le message ne cite jamais la valeur en cause : elle est du contenu utilisateur.
  #[error("{0}")]
  Conflict(String),
  /// L'opération a été interrompue à la demande de l'utilisateur.
  #[error("{0}")]
  Cancelled(String),
}

impl AppError {
  /// Le discriminant sérialisé, en camelCase comme le reste du contrat IPC.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le frontend s'en sert pour **reconnaître** une erreur du pont — `isAppError` vérifie
  ///   que la valeur est de cette liste — et n'y branche aujourd'hui aucun traitement. Un
  ///   discriminant renommé ne casserait donc rien à la compilation, et tout à l'exécution :
  ///   toute erreur cesserait d'être reconnue comme telle.
  pub fn kind(&self) -> &'static str {
    match self {
      Self::Io(_) => "io",
      Self::Database(_) => "database",
      Self::Keychain(_) => "keychain",
      Self::Native(_) => "native",
      Self::Permission(_) => "permission",
      Self::InvalidArgument(_) => "invalidArgument",
      Self::Conflict(_) => "conflict",
      Self::Cancelled(_) => "cancelled",
    }
  }
}

/// Sérialise en `{ kind, message }`, et rien d'autre : c'est la forme que le frontend attend.
impl Serialize for AppError {
  /// # Errors
  ///
  /// Rend l'erreur du `Serializer` si la structure ne peut pas être écrite.
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    let mut state = serializer.serialize_struct("AppError", 2)?;
    state.serialize_field("kind", self.kind())?;
    state.serialize_field("message", &self.to_string())?;
    state.end()
  }
}

/// Toute erreur d'entrée-sortie devient [`AppError::Io`], message compris.
impl From<std::io::Error> for AppError {
  fn from(error: std::io::Error) -> Self {
    Self::Io(error.to_string())
  }
}

/// Une erreur Tauri — résolution de chemin, fenêtre absente — devient [`AppError::Io`].
impl From<tauri::Error> for AppError {
  fn from(error: tauri::Error) -> Self {
    Self::Io(error.to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::AppError;

  /// Une instance de chaque variante, avec le discriminant attendu.
  fn one_of_each() -> Vec<(AppError, &'static str)> {
    vec![
      (AppError::Io("io".into()), "io"),
      (AppError::Database("db".into()), "database"),
      (AppError::Keychain("kc".into()), "keychain"),
      (AppError::Native("nat".into()), "native"),
      (AppError::Permission("perm".into()), "permission"),
      (AppError::InvalidArgument("arg".into()), "invalidArgument"),
      (AppError::Conflict("taken".into()), "conflict"),
      (AppError::Cancelled("cancel".into()), "cancelled"),
    ]
  }

  #[test]
  fn kind_is_stable_for_every_variant() {
    for (error, expected) in one_of_each() {
      assert_eq!(error.kind(), expected);
    }
  }

  #[test]
  fn display_yields_the_message_alone() {
    for (error, _) in one_of_each() {
      assert!(!error.to_string().is_empty());
    }
    assert_eq!(AppError::Native("boum".into()).to_string(), "boum");
  }

  #[test]
  fn every_variant_serializes_to_kind_and_message() {
    for (error, expected_kind) in one_of_each() {
      let message = error.to_string();
      let json = serde_json::to_value(&error).expect("sérialisation");
      assert_eq!(json["kind"], expected_kind);
      assert_eq!(json["message"], message);
      assert_eq!(
        json.as_object().expect("objet JSON").len(),
        2,
        "le contrat est exactement {{ kind, message }}"
      );
    }
  }

  #[test]
  fn io_errors_convert_to_the_io_variant() {
    let source = std::io::Error::new(std::io::ErrorKind::NotFound, "fichier absent");
    let error = AppError::from(source);
    assert_eq!(error.kind(), "io");
    assert_eq!(error.to_string(), "fichier absent");
  }

  #[test]
  fn tauri_errors_convert_to_the_io_variant() {
    let source = tauri::Error::UnknownPath;
    let expected = source.to_string();
    let error = AppError::from(source);
    assert_eq!(error.kind(), "io");
    assert_eq!(error.to_string(), expected);
  }
}
