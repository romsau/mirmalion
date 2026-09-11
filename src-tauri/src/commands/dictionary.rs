//! Le dictionnaire personnel, côté base : le pipeline le **lit**, l'écran d'options l'**édite**.
//!
//! Le remplacement lui-même est pur et vit dans [`crate::dictionary`], le branchement dans
//! [`crate::commands::dictation`]. Cinq commandes nommées — lister, ajouter ou retirer un
//! terme, ajouter ou retirer une variante —, aucune ne prend de SQL, et chaque argument passe
//! par [`clean`] avant de toucher la base.
//!
//! # Pièges
//!
//! - ⚠️ Le doublon se refuse dans l'interface, pas ici : les contraintes `UNIQUE` du schéma
//!   font remonter une erreur non localisée, et l'application parle six langues. L'écran
//!   détient la liste entière et peut le dire avant d'appeler.
//! - ⚠️ [`read`] et [`read_all`] ne sont pas un doublon : voir leurs documentations respectives.

use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;

use crate::{
  blocking::off_thread, db::Database, dictionary::Entry, error::AppError, state::AppState,
};

/// La longueur maximale d'un terme ou d'une variante, en caractères.
///
/// 120 caractères laissent largement la place au plus long nom propre composé.
///
/// # Pièges
///
/// - ⚠️ Borne de coût, pas politesse d'ergonomie : chaque variante est comparée à chaque
///   position du texte dicté, et une saisie de dix mille caractères collée par accident ferait
///   payer ce prix à toutes les dictées suivantes.
const MAX_LENGTH: usize = 120;

/// Un terme et ses variantes, tels que l'écran d'options les reçoit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryTerm {
  /// L'identifiant de la ligne, par lequel le terme se retire.
  pub id: i64,
  /// La graphie de référence, celle qui remplace les variantes.
  pub term: String,
  /// Les graphies à corriger ; vide sur un terme qu'on vient de créer.
  pub variants: Vec<DictionaryVariant>,
}

/// Une graphie à corriger.
///
/// # Pièges
///
/// - ⚠️ Elle se retire par son identifiant et non par son texte : deux termes peuvent partager
///   une même graphie, et l'effacer par son texte en supprimerait deux.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryVariant {
  /// L'identifiant de la ligne, par lequel la variante se retire.
  pub id: i64,
  /// Le texte de la graphie fautive.
  pub value: String,
}

/// Charge le dictionnaire, à l'usage du pipeline seulement.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la lecture, [`AppError::Io`] si la tâche n'est pas
/// revenue.
///
/// # Pièges
///
/// - ⚠️ Relu à chaque dictée, sans cache : un cache devrait être invalidé par l'écran d'édition,
///   donc relier deux fenêtres pour économiser une lecture de quelques dizaines de lignes.
pub async fn load(database: Arc<Database>) -> Result<Vec<Entry>, AppError> {
  off_thread(move || {
    let connection = database.lock()?;
    read(&connection)
  })
  .await
}

/// Lit les termes et leurs variantes, pour le pipeline. Éprouvable sans runtime, d'où la
/// séparation d'avec [`load`].
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la requête ou si une ligne est illisible.
///
/// # Pièges
///
/// - ⚠️ Jointure interne, à l'inverse de [`read_all`] : un terme sans variante ne remplace rien.
/// - ⚠️ Le tri par `term_id` groupe les variantes d'un même terme, ce dont dépend le regroupement.
fn read(connection: &rusqlite::Connection) -> Result<Vec<Entry>, AppError> {
  let mut statement = connection
    .prepare(
      "SELECT t.id, t.term, v.variant
         FROM dictionary_terms t
         JOIN dictionary_variants v ON v.term_id = t.id
        ORDER BY t.id, v.id",
    )
    // ⚠️ Aucun contenu utilisateur dans le message, pas même via l'erreur SQL.
    .map_err(|_| AppError::Database("lecture du dictionnaire".to_owned()))?;

  let rows = statement
    .query_map([], |row| {
      Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, String>(2)?,
      ))
    })
    .map_err(|_| AppError::Database("lecture du dictionnaire".to_owned()))?;

  let mut entries: Vec<Entry> = Vec::new();
  let mut current = None;
  for row in rows {
    let (id, term, variant) =
      row.map_err(|_| AppError::Database("lecture du dictionnaire".to_owned()))?;
    if current != Some(id) {
      current = Some(id);
      entries.push(Entry {
        term,
        variants: Vec::new(),
      });
    }
    // Le `push` ci-dessus garantit qu'il y a une entrée courante.
    if let Some(entry) = entries.last_mut() {
      entry.variants.push(variant);
    }
  }
  Ok(entries)
}

/// Lit **tout** le dictionnaire, identifiants compris, pour l'écran d'options.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la requête ou si une ligne est illisible.
///
/// # Pièges
///
/// - ⚠️ Jointure externe, à l'inverse de [`read`] : un terme sans variante est ici un état
///   normal — celui d'une ligne qu'on vient de créer —, et l'écarter le ferait disparaître de
///   l'écran juste après sa création.
fn read_all(connection: &rusqlite::Connection) -> Result<Vec<DictionaryTerm>, AppError> {
  let mut statement = connection
    .prepare(
      "SELECT t.id, t.term, v.id, v.variant
         FROM dictionary_terms t
         LEFT JOIN dictionary_variants v ON v.term_id = t.id
        ORDER BY t.term COLLATE NOCASE, v.id",
    )
    .map_err(|_| AppError::Database("lecture du dictionnaire".to_owned()))?;

  let rows = statement
    .query_map([], |row| {
      Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, Option<i64>>(2)?,
        row.get::<_, Option<String>>(3)?,
      ))
    })
    .map_err(|_| AppError::Database("lecture du dictionnaire".to_owned()))?;

  let mut terms: Vec<DictionaryTerm> = Vec::new();
  for row in rows {
    let (id, term, variant_id, value) =
      row.map_err(|_| AppError::Database("lecture du dictionnaire".to_owned()))?;
    if terms.last().is_none_or(|last| last.id != id) {
      terms.push(DictionaryTerm {
        id,
        term,
        variants: Vec::new(),
      });
    }
    // La jointure externe rend `NULL` pour un terme sans variante : les deux colonnes sont
    // absentes ensemble, jamais l'une sans l'autre.
    if let (Some(variant_id), Some(value), Some(last)) = (variant_id, value, terms.last_mut()) {
      last.variants.push(DictionaryVariant {
        id: variant_id,
        value,
      });
    }
  }
  Ok(terms)
}

/// Le texte reçu du WebView, rogné et refusé s'il ne tient pas debout.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur une saisie vide ou au-delà de [`MAX_LENGTH`]
/// caractères.
///
/// # Pièges
///
/// - ⚠️ Le message d'erreur ne cite jamais la saisie : c'est du contenu utilisateur.
fn clean(raw: &str) -> Result<String, AppError> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return Err(AppError::InvalidArgument("saisie vide".to_owned()));
  }
  if trimmed.chars().count() > MAX_LENGTH {
    return Err(AppError::InvalidArgument("saisie trop longue".to_owned()));
  }
  Ok(trimmed.to_owned())
}

/// Le motif partagé par les cinq commandes : cloner la base, travailler hors du fil d'IPC.
///
/// # Errors
///
/// Rend l'erreur de `body`, celle du verrou, ou [`AppError::Io`] si la tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ Le verrou de la connexion est synchrone et ne doit jamais être tenu à travers un
///   `.await` : c'est `spawn_blocking` qui rend la règle tenable.
async fn with_connection<T, F>(app: &tauri::AppHandle, body: F) -> Result<T, AppError>
where
  T: Send + 'static,
  F: FnOnce(&rusqlite::Connection) -> Result<T, AppError> + Send + 'static,
{
  let database = app.state::<AppState>().database();
  off_thread(move || {
    let connection = database.lock()?;
    body(&connection)
  })
  .await
}

/// Le dictionnaire entier, trié par terme, à l'usage de l'écran d'options.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la lecture.
#[tauri::command]
pub async fn list_dictionary_terms(app: tauri::AppHandle) -> Result<Vec<DictionaryTerm>, AppError> {
  with_connection(&app, read_all).await
}

/// Ajoute un terme, et rend la ligne telle que l'écran doit l'afficher — sans variante.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `term` est vide ou trop long, [`AppError::Database`]
/// si la base refuse l'insertion — un terme déjà présent, notamment.
#[tauri::command]
pub async fn add_dictionary_term(
  app: tauri::AppHandle,
  term: String,
) -> Result<DictionaryTerm, AppError> {
  let term = clean(&term)?;
  with_connection(&app, move |connection| {
    connection
      .execute(
        "INSERT INTO dictionary_terms (term, created_at)
         VALUES (?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
        rusqlite::params![term],
      )
      .map_err(|_| AppError::Database("ajout d'un terme".to_owned()))?;
    Ok(DictionaryTerm {
      id: connection.last_insert_rowid(),
      term,
      variants: Vec::new(),
    })
  })
  .await
}

/// Retire un terme **et toutes ses variantes**.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la suppression.
///
/// # Pièges
///
/// - ⚠️ La cascade repose sur `ON DELETE CASCADE` et donc sur `PRAGMA foreign_keys`, qui doit
///   être reposé à chaque ouverture de connexion : sans lui, les variantes resteraient orphelines.
#[tauri::command]
pub async fn delete_dictionary_term(app: tauri::AppHandle, id: i64) -> Result<(), AppError> {
  with_connection(&app, move |connection| {
    connection
      .execute("DELETE FROM dictionary_terms WHERE id = ?1", [id])
      .map(|_| ())
      .map_err(|_| AppError::Database("suppression d'un terme".to_owned()))
  })
  .await
}

/// Ajoute une graphie à corriger sous un terme existant.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si `variant` est vide ou trop long, [`AppError::Database`]
/// si `term_id` n'existe pas ou si la graphie est déjà présente sous ce terme.
#[tauri::command]
pub async fn add_dictionary_variant(
  app: tauri::AppHandle,
  term_id: i64,
  variant: String,
) -> Result<DictionaryVariant, AppError> {
  let value = clean(&variant)?;
  with_connection(&app, move |connection| {
    connection
      .execute(
        "INSERT INTO dictionary_variants (term_id, variant) VALUES (?1, ?2)",
        rusqlite::params![term_id, value],
      )
      .map_err(|_| AppError::Database("ajout d'une variante".to_owned()))?;
    Ok(DictionaryVariant {
      id: connection.last_insert_rowid(),
      value,
    })
  })
  .await
}

/// Retire une graphie, **par identifiant**.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la suppression.
///
/// # Pièges
///
/// - ⚠️ Par identifiant et non par texte : deux termes peuvent porter la même graphie, et
///   l'effacer par son texte en supprimerait deux.
#[tauri::command]
pub async fn delete_dictionary_variant(app: tauri::AppHandle, id: i64) -> Result<(), AppError> {
  with_connection(&app, move |connection| {
    connection
      .execute("DELETE FROM dictionary_variants WHERE id = ?1", [id])
      .map(|_| ())
      .map_err(|_| AppError::Database("suppression d'une variante".to_owned()))
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::{clean, read, read_all};
  use crate::db::Database;
  use crate::security::key::EncryptionKey;

  /// Le SQL exercé sur une vraie base chiffrée — même motif que `dictations.rs` : le `State`
  /// de Tauri n'est pas constructible hors d'une application.
  fn with_database(name: &str, body: impl FnOnce(&Database)) {
    let directory = std::env::temp_dir().join(format!(
      "mirmalion-dictionary-{name}-{}-{:?}",
      std::process::id(),
      std::thread::current().id()
    ));
    std::fs::create_dir_all(&directory).expect("dossier temporaire");
    let path = directory.join("test.db");
    let key = EncryptionKey::from_hex("d".repeat(64)).expect("clé valide");
    {
      let database = Database::open(&path, &key).expect("base ouverte");
      body(&database);
    }
    let _ = std::fs::remove_dir_all(&directory);
  }

  fn insert(database: &Database, term: &str, variants: &[&str]) {
    let connection = database.lock().expect("verrou");
    connection
      .execute(
        "INSERT INTO dictionary_terms (term, created_at) VALUES (?1, '2026-07-31T00:00:00Z')",
        rusqlite::params![term],
      )
      .expect("terme inséré");
    let id = connection.last_insert_rowid();
    for variant in variants {
      connection
        .execute(
          "INSERT INTO dictionary_variants (term_id, variant) VALUES (?1, ?2)",
          rusqlite::params![id, variant],
        )
        .expect("variante insérée");
    }
  }

  #[test]
  fn an_empty_dictionary_reads_as_no_entry() {
    with_database("empty", |database| {
      let connection = database.lock().expect("verrou");
      assert!(read(&connection).expect("lecture").is_empty());
    });
  }

  #[test]
  fn each_term_carries_its_variants_in_insertion_order() {
    with_database("grouped", |database| {
      insert(database, "GitLab", &["git lab", "guitte lab"]);
      insert(database, "Mirmalion", &["mir maleon"]);

      let connection = database.lock().expect("verrou");
      let entries = read(&connection).expect("lecture");

      assert_eq!(entries.len(), 2);
      assert_eq!(entries[0].term, "GitLab");
      assert_eq!(entries[0].variants, ["git lab", "guitte lab"]);
      assert_eq!(entries[1].term, "Mirmalion");
      assert_eq!(entries[1].variants, ["mir maleon"]);
    });
  }

  /// ⚠️ Un terme sans variante ne remplace rien : la jointure interne l'écarte, et la logique
  /// pure n'a pas à connaître ce cas.
  #[test]
  fn a_term_without_any_variant_is_left_out() {
    with_database("orphan", |database| {
      insert(database, "Mirmalion", &[]);
      insert(database, "GitLab", &["git lab"]);

      let connection = database.lock().expect("verrou");
      let entries = read(&connection).expect("lecture");

      assert_eq!(entries.len(), 1);
      assert_eq!(entries[0].term, "GitLab");
    });
  }

  /// ⚠️ L'inverse exact de `a_term_without_any_variant_is_left_out` : le lecteur de l'écran
  /// doit **garder** un terme sans variante, sans quoi une ligne disparaîtrait aussitôt créée.
  #[test]
  fn the_screen_reader_keeps_a_term_that_has_no_variant_yet() {
    with_database("all-orphan", |database| {
      insert(database, "Mirmalion", &[]);

      let connection = database.lock().expect("verrou");
      let terms = read_all(&connection).expect("lecture");

      assert_eq!(terms.len(), 1);
      assert_eq!(terms[0].term, "Mirmalion");
      assert!(terms[0].variants.is_empty());
      assert!(terms[0].id > 0);
    });
  }

  /// L'écran affiche une liste alphabétique, et le tri ignore la casse : « anthropic » ne
  /// doit pas tomber après « Zoom » parce qu'il commence par une minuscule.
  #[test]
  fn the_screen_reader_sorts_by_term_ignoring_case() {
    with_database("all-sorted", |database| {
      insert(database, "Zoom", &["zoum"]);
      insert(database, "anthropic", &["an tro pic"]);

      let connection = database.lock().expect("verrou");
      let terms = read_all(&connection).expect("lecture");

      assert_eq!(
        terms.iter().map(|t| t.term.as_str()).collect::<Vec<_>>(),
        ["anthropic", "Zoom"]
      );
    });
  }

  #[test]
  fn the_screen_reader_carries_variant_identifiers() {
    with_database("all-ids", |database| {
      insert(database, "GitLab", &["git lab", "guitte lab"]);

      let connection = database.lock().expect("verrou");
      let terms = read_all(&connection).expect("lecture");

      let variants = &terms[0].variants;
      assert_eq!(variants.len(), 2);
      assert_eq!(variants[0].value, "git lab");
      assert_ne!(variants[0].id, variants[1].id);
    });
  }

  #[test]
  fn the_screen_reader_reports_a_broken_table_without_naming_content() {
    with_database("all-broken", |database| {
      let connection = database.lock().expect("verrou");
      connection
        .execute_batch("DROP TABLE dictionary_variants")
        .expect("table retirée");

      let error = read_all(&connection).expect_err("lecture impossible");
      assert_eq!(error.to_string(), "lecture du dictionnaire");
    });
  }

  #[test]
  fn a_blank_entry_is_refused_and_the_message_never_quotes_it() {
    let error = clean("   ").expect_err("saisie vide refusée");
    assert_eq!(error.kind(), "invalidArgument");
    assert_eq!(error.to_string(), "saisie vide");
  }

  /// ⚠️ La borne existe pour le **coût** : chaque variante est comparée à chaque position du
  /// texte dicté. Le message ne cite pas davantage la saisie que le précédent.
  #[test]
  fn an_overlong_entry_is_refused_and_the_message_never_quotes_it() {
    let error = clean(&"é".repeat(121)).expect_err("saisie trop longue refusée");
    assert_eq!(error.kind(), "invalidArgument");
    assert_eq!(error.to_string(), "saisie trop longue");
  }

  /// La borne compte des **caractères**, pas des octets : sinon soixante lettres accentuées
  /// suffiraient à la franchir.
  #[test]
  fn the_length_limit_counts_characters_and_not_bytes() {
    assert_eq!(
      clean(&"é".repeat(120))
        .expect("saisie acceptée")
        .chars()
        .count(),
      120
    );
  }

  #[test]
  fn the_surrounding_blanks_of_an_entry_are_dropped() {
    assert_eq!(clean("  GitLab \n").expect("saisie acceptée"), "GitLab");
  }

  /// La lecture échoue **sans rien dire du contenu** : le message ne nomme que l'opération.
  #[test]
  fn a_missing_table_fails_without_naming_any_user_content() {
    with_database("broken", |database| {
      let connection = database.lock().expect("verrou");
      connection
        .execute_batch("DROP TABLE dictionary_variants")
        .expect("table retirée");

      let error = read(&connection).expect_err("lecture impossible");
      assert_eq!(error.kind(), "database");
      assert_eq!(error.to_string(), "lecture du dictionnaire");
    });
  }
}
