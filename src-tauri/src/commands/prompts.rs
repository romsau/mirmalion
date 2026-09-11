//! Les prompts écrits par l'utilisateur, dans la base **chiffrée**.
//!
//! Deux familles : la reformulation de dictée (`user_prompts`, une ligne par usage) et les
//! comptes rendus nommés (`report_prompts`, une ligne par prompt).
//!
//! # Pièges
//!
//! - ⚠️ Pas de `tauri-plugin-store` : texte libre pouvant nommer un client, son fichier étant
//!   un JSON en clair.
//! - ⚠️ **Le WebView ne choisit jamais la ligne de `user_prompts`** : `read_prompt` et
//!   `write_prompt` prennent `usage: &'static str` — une `String` de serde n'y entre pas,
//!   garantie du compilateur. Les commandes qui les appellent lisent des lignes de `user_prompts`
//!   avec une clé en dur ; seul l'`id` de `report_prompts` vient du WebView.

use tauri::State;

use crate::{blocking::off_thread, error::AppError, state::AppState};

/// La clé du prompt de reformulation de dictée. **En dur, jamais reçue du frontend.**
const DICTATION_REPHRASING: &str = "dictation_rephrasing";

/// La clé de l'ancien prompt de compte rendu unique, dans `user_prompts`.
///
/// # Pièges
///
/// - ⚠️ **Plus rien ne l'écrit** : elle ne sert qu'à [`adopt_legacy`], qui reprend la ligne
///   laissée par une version précédente et la supprime. La retirer perdrait ce prompt-là.
const LIVE_REPORT: &str = "live_report";

/// Ce qu'un prompt peut faire de plus long, en caractères.
///
/// Le modèle ne lira de toute façon pas au-delà de sa fenêtre. La valeur est large : une
/// description de style tient en deux phrases, 2 000 caractères en laissent trente.
const MAX_PROMPT_LENGTH: usize = 2_000;

/// Le prompt tient-il dans la borne ?
///
/// # Pièges
///
/// - ⚠️ Validé côté Rust, le WebView n'étant pas fiable : sans borne, un frontend compromis
///   écrirait un mégaoctet par appel dans la base de l'utilisateur.
/// - ⚠️ En caractères et non en octets : `len()` compte deux octets par lettre accentuée, et
///   une description française serait refusée bien avant la longueur tolérée pour une anglaise.
fn within_length(prompt: &str) -> bool {
  prompt.chars().count() <= MAX_PROMPT_LENGTH
}

/// Dit aux fenêtres que le prompt de compte rendu a changé, pour qu'elles aillent le relire.
///
/// # Pièges
///
/// - ⚠️ **La charge utile est vide, et c'est le fond du contrat** : le prompt est du contenu
///   utilisateur — il nomme un client, un employeur. Il reste dans la base chiffrée, et chaque
///   fenêtre l'y relit ; il ne traverse pas le bus d'évènements pour être recopié partout.
pub const LIVE_PROMPT_EVENT: &str = "live-prompt-changed";

/// Un prompt de compte rendu nommé, tel que l'interface le liste.
///
/// # Pièges
///
/// - ⚠️ `id` voyage dans le fichier de réglages, qui est en clair — c'est un numéro, il ne dit
///   rien du contenu. Le `title`, lui, n'y entre jamais : il nomme un client aussi sûrement que
///   le prompt.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPrompt {
  pub id: i64,
  pub title: String,
  pub prompt: String,
}

/// Combien de prompts de compte rendu au plus.
///
/// Large pour un usage réel, et le menu déroulant reste lisible au-delà des deux rubriques
/// livrées.
const MAX_REPORT_PROMPTS: usize = 20;

/// Ce qu'un titre peut faire de plus long, en caractères.
///
/// Il s'affiche dans un menu déroulant étroit, où un titre plus long se tronquerait de toute
/// façon.
const MAX_TITLE_LENGTH: usize = 40;

/// Le titre tient-il dans la borne ?
///
/// # Pièges
///
/// - ⚠️ En caractères et non en octets, comme [`within_length`] : `len()` compte deux octets par
///   lettre accentuée, et un titre français serait refusé avant un titre anglais de même longueur.
fn within_title_length(title: &str) -> bool {
  title.chars().count() <= MAX_TITLE_LENGTH
}

/// Rend le couple (titre, prompt) débarrassé de ses espaces de bord, ou refuse.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si l'un des deux est vide une fois taillé, ou si l'un
/// dépasse sa borne.
///
/// # Pièges
///
/// - ⚠️ Les deux sont exigés : un prompt sans titre ne se retrouve pas dans un menu, un titre
///   sans prompt ne produit rien. L'interface les exige déjà — le WebView n'est pas fiable.
/// - ⚠️ Aucun message ne cite ce que l'utilisateur a écrit.
fn validated(title: &str, prompt: &str) -> Result<(String, String), AppError> {
  let title = title.trim().to_string();
  let prompt = prompt.trim().to_string();
  if title.is_empty() || prompt.is_empty() {
    return Err(AppError::InvalidArgument(
      "un prompt personnalisé veut un titre et un texte".to_string(),
    ));
  }
  if !within_title_length(&title) {
    return Err(AppError::InvalidArgument(format!(
      "le titre dépasse {MAX_TITLE_LENGTH} caractères"
    )));
  }
  if !within_length(&prompt) {
    return Err(AppError::InvalidArgument(format!(
      "le prompt dépasse {MAX_PROMPT_LENGTH} caractères"
    )));
  }
  Ok((title, prompt))
}

/// Tous les prompts de compte rendu, dans l'ordre du menu.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la requête.
///
/// # Pièges
///
/// - ⚠️ `COLLATE NOCASE` sur le tri : sans lui, SQLite range les majuscules avant toutes les
///   minuscules, et « veille » passerait avant « Client ».
fn all_prompts(connection: &rusqlite::Connection) -> Result<Vec<ReportPrompt>, AppError> {
  let mut statement = connection
    .prepare("SELECT id, title, prompt FROM report_prompts ORDER BY title COLLATE NOCASE")
    .map_err(|_| AppError::Database("lecture des prompts de compte rendu".to_string()))?;
  let rows = statement
    .query_map([], |row| {
      Ok(ReportPrompt {
        id: row.get(0)?,
        title: row.get(1)?,
        prompt: row.get(2)?,
      })
    })
    .map_err(|_| AppError::Database("lecture des prompts de compte rendu".to_string()))?;
  rows
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| AppError::Database("lecture des prompts de compte rendu".to_string()))
}

/// Combien de prompts sont enregistrés.
fn count_prompts(connection: &rusqlite::Connection) -> Result<usize, AppError> {
  connection
    .query_row("SELECT count(*) FROM report_prompts", [], |row| {
      row.get::<_, i64>(0)
    })
    .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
    .map_err(|_| AppError::Database("comptage des prompts de compte rendu".to_string()))
}

/// Ce qu'on dit d'un titre qu'un autre prompt porte déjà. **Ne cite jamais le titre.**
const TITLE_TAKEN: &str = "un autre prompt personnalisé porte déjà ce titre";

/// L'écriture a-t-elle buté sur l'index d'unicité des titres, plutôt que sur la base elle-même ?
///
/// # Pièges
///
/// - ⚠️ Sur `report_prompts`, la seule contrainte qu'une écriture validée puisse violer est
///   `report_prompts_title` : `id` est attribué par SQLite, et [`validated`] a déjà écarté les
///   colonnes `NOT NULL` vides. Ajouter une contrainte à la table oblige à revoir ce raccourci.
fn is_title_conflict(error: &rusqlite::Error) -> bool {
  matches!(
    error,
    rusqlite::Error::SqliteFailure(inner, _)
      if inner.code == rusqlite::ErrorCode::ConstraintViolation
  )
}

/// L'échec d'une écriture de prompt, typé : un titre pris se distingue d'une base en panne.
///
/// # Pièges
///
/// - ⚠️ L'erreur SQL est écartée sans être formatée : elle citerait le titre ou le prompt.
fn write_failure(error: &rusqlite::Error, what: &str) -> AppError {
  if is_title_conflict(error) {
    AppError::Conflict(TITLE_TAKEN.to_string())
  } else {
    AppError::Database(what.to_string())
  }
}

/// Crée un prompt et le rend tel qu'il est en base.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si la validation échoue ou si le plafond est atteint,
/// [`AppError::Conflict`] si un prompt porte déjà ce titre — l'index d'unicité étant sans casse
/// —, et [`AppError::Database`] si la base refuse l'écriture pour toute autre raison.
fn insert_prompt(
  connection: &rusqlite::Connection,
  title: &str,
  prompt: &str,
) -> Result<ReportPrompt, AppError> {
  let (title, prompt) = validated(title, prompt)?;
  if count_prompts(connection)? >= MAX_REPORT_PROMPTS {
    return Err(AppError::InvalidArgument(format!(
      "au-delà de {MAX_REPORT_PROMPTS} prompts personnalisés"
    )));
  }
  connection
    .execute(
      "INSERT INTO report_prompts (title, prompt, created_at, updated_at)
       VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                         strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
      rusqlite::params![title, prompt],
    )
    .map_err(|error| write_failure(&error, "écriture d'un prompt de compte rendu"))?;
  Ok(ReportPrompt {
    id: connection.last_insert_rowid(),
    title,
    prompt,
  })
}

/// Modifie un prompt et le rend tel qu'il est en base.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si la validation échoue ou si aucun prompt ne porte ce
/// numéro, [`AppError::Conflict`] si un AUTRE prompt porte déjà ce titre, et
/// [`AppError::Database`] si la base refuse l'écriture pour toute autre raison.
fn modify_prompt(
  connection: &rusqlite::Connection,
  id: i64,
  title: &str,
  prompt: &str,
) -> Result<ReportPrompt, AppError> {
  let (title, prompt) = validated(title, prompt)?;
  let touched = connection
    .execute(
      "UPDATE report_prompts
          SET title = ?2,
              prompt = ?3,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?1",
      rusqlite::params![id, title, prompt],
    )
    .map_err(|error| write_failure(&error, "modification d'un prompt de compte rendu"))?;
  if touched == 0 {
    return Err(AppError::InvalidArgument(
      "ce prompt personnalisé n'existe plus".to_string(),
    ));
  }
  Ok(ReportPrompt { id, title, prompt })
}

/// Supprime un prompt. Supprimer ce qui n'existe plus réussit.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la suppression.
///
/// # Pièges
///
/// - ⚠️ **Aucune erreur sur une ligne absente** : deux fenêtres montrent la même liste, et la
///   seconde peut cliquer sur une ligne que la première vient d'effacer. Le résultat voulu —
///   « ce prompt n'est plus là » — est déjà atteint.
fn remove_prompt(connection: &rusqlite::Connection, id: i64) -> Result<(), AppError> {
  connection
    .execute("DELETE FROM report_prompts WHERE id = ?1", [id])
    .map(|_| ())
    .map_err(|_| AppError::Database("suppression d'un prompt de compte rendu".to_string()))
}

/// La liste des prompts de compte rendu.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la requête, ou [`AppError::Io`] si la tâche n'est
/// pas revenue.
#[tauri::command]
pub async fn list_report_prompts(
  state: State<'_, AppState>,
) -> Result<Vec<ReportPrompt>, AppError> {
  let database = state.database();
  off_thread(move || {
    let connection = database.lock()?;
    all_prompts(&connection)
  })
  .await
}

/// Crée un prompt de compte rendu et prévient les fenêtres.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] si le titre ou le texte est vide, trop long, ou si le
/// plafond est atteint ; [`AppError::Database`] si la base refuse l'écriture.
#[tauri::command]
pub async fn create_report_prompt(
  app: tauri::AppHandle,
  state: State<'_, AppState>,
  title: String,
  prompt: String,
) -> Result<ReportPrompt, AppError> {
  let database = state.database();
  let created = off_thread(move || {
    let connection = database.lock()?;
    insert_prompt(&connection, &title, &prompt)
  })
  .await?;
  super::announce(&app, LIVE_PROMPT_EVENT, ());
  Ok(created)
}

/// Modifie un prompt de compte rendu et prévient les fenêtres.
///
/// # Errors
///
/// Voir [`modify_prompt`].
#[tauri::command]
pub async fn update_report_prompt(
  app: tauri::AppHandle,
  state: State<'_, AppState>,
  id: i64,
  title: String,
  prompt: String,
) -> Result<ReportPrompt, AppError> {
  let database = state.database();
  let changed = off_thread(move || {
    let connection = database.lock()?;
    modify_prompt(&connection, id, &title, &prompt)
  })
  .await?;
  super::announce(&app, LIVE_PROMPT_EVENT, ());
  Ok(changed)
}

/// Supprime un prompt de compte rendu et prévient les fenêtres.
///
/// # Errors
///
/// Voir [`remove_prompt`].
#[tauri::command]
pub async fn delete_report_prompt(
  app: tauri::AppHandle,
  state: State<'_, AppState>,
  id: i64,
) -> Result<(), AppError> {
  let database = state.database();
  off_thread(move || {
    let connection = database.lock()?;
    remove_prompt(&connection, id)
  })
  .await?;
  super::announce(&app, LIVE_PROMPT_EVENT, ());
  Ok(())
}

/// Lit un prompt, ou `None` s'il n'y en a jamais eu. Privée : l'usage vient du code.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la requête, ou [`AppError::Io`] si la tâche n'est
/// pas revenue.
///
/// # Pièges
///
/// - ⚠️ `Some("")` n'existe pas : écrire un texte vide efface la ligne, et l'appelant qui reçoit
///   `None` affiche un champ vide. Ne pas introduire de troisième forme du même rien.
async fn read_prompt(
  database: std::sync::Arc<crate::db::Database>,
  usage: &'static str,
) -> Result<Option<String>, AppError> {
  off_thread(move || {
    let connection = database.lock()?;
    connection
      .query_row(
        "SELECT prompt FROM user_prompts WHERE usage = ?1",
        [usage],
        |row| row.get::<_, String>(0),
      )
      .map(Some)
      .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        // ⚠️ On nomme l'usage, jamais le prompt : l'un est une clé de notre code, l'autre du
        // contenu utilisateur.
        other => Err(AppError::Database(format!(
          "lecture du prompt « {usage} » : {other}"
        ))),
      })
  })
  .await
}

/// Écrit un prompt. Privée : l'usage vient du code.
///
/// Un texte vide ou blanc **efface** la ligne : c'est le geste de l'utilisateur qui vide le champ.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] au-delà de [`MAX_PROMPT_LENGTH`] caractères,
/// [`AppError::Database`] si la base refuse l'écriture, ou [`AppError::Io`] si la tâche n'est pas
/// revenue.
///
/// # Pièges
///
/// - ⚠️ Le prompt n'entre dans aucun message, pas même une erreur SQL.
async fn write_prompt(
  database: std::sync::Arc<crate::db::Database>,
  usage: &'static str,
  prompt: String,
) -> Result<(), AppError> {
  if !within_length(&prompt) {
    return Err(AppError::InvalidArgument(format!(
      "le prompt dépasse {MAX_PROMPT_LENGTH} caractères"
    )));
  }

  let trimmed = prompt.trim().to_string();

  off_thread(move || {
    let connection = database.lock()?;
    let result = if trimmed.is_empty() {
      connection.execute("DELETE FROM user_prompts WHERE usage = ?1", [usage])
    } else {
      connection.execute(
        "INSERT INTO user_prompts (usage, prompt, updated_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT (usage) DO UPDATE SET
           prompt = excluded.prompt,
           updated_at = excluded.updated_at",
        rusqlite::params![usage, trimmed],
      )
    };
    // ⚠️ L'erreur SQL est écartée sans être formatée : elle citerait le prompt.
    result
      .map(|_| ())
      .map_err(|_| AppError::Database(format!("écriture du prompt « {usage} »")))
  })
  .await
}

/// Le prompt de reformulation personnalisé, ou `None` s'il n'y en a jamais eu.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la requête, ou [`AppError::Io`] si la tâche n'est
/// pas revenue.
#[tauri::command]
pub async fn get_rephrasing_prompt(state: State<'_, AppState>) -> Result<Option<String>, AppError> {
  read_rephrasing_prompt(state.database()).await
}

/// La même lecture, à l'usage du pipeline de dictée, qui n'a pas de `State`.
///
/// Le pipeline lit ce prompt à chaque dictée reformulée en mode personnalisé.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la requête, ou [`AppError::Io`] si la tâche n'est
/// pas revenue.
pub async fn read_rephrasing_prompt(
  database: std::sync::Arc<crate::db::Database>,
) -> Result<Option<String>, AppError> {
  read_prompt(database, DICTATION_REPHRASING).await
}

/// Enregistre le prompt de reformulation personnalisé ; un texte vide efface la ligne.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] au-delà de [`MAX_PROMPT_LENGTH`] caractères,
/// [`AppError::Database`] si la base refuse l'écriture.
#[tauri::command]
pub async fn set_rephrasing_prompt(
  state: State<'_, AppState>,
  prompt: String,
) -> Result<(), AppError> {
  write_prompt(state.database(), DICTATION_REPHRASING, prompt).await
}

/// Un prompt de compte rendu porte-t-il déjà ce titre, sans casse ?
fn title_already_taken(connection: &rusqlite::Connection, title: &str) -> Result<bool, AppError> {
  connection
    .query_row(
      "SELECT 1 FROM report_prompts WHERE title = ?1 COLLATE NOCASE",
      [title],
      |_| Ok(()),
    )
    .map(|()| true)
    .or_else(|error| match error {
      rusqlite::Error::QueryReturnedNoRows => Ok(false),
      _ => Err(AppError::Database(
        "vérification du titre d'un prompt hérité".to_string(),
      )),
    })
}

/// Reprend l'ancien prompt de compte rendu unique et en fait le premier prompt nommé.
///
/// Rend `true` s'il y avait quelque chose à reprendre, `false` sinon.
///
/// # Errors
///
/// Rend [`AppError::Database`] si l'insertion ou la suppression échoue — les deux sont atomiques.
///
/// # Pièges
///
/// - ⚠️ **Titre déjà pris → `Ok(false)`, la ligne d'origine reste** : l'effacer perdrait un
///   texte qui n'est pas celui du prompt existant.
/// - ⚠️ **Le titre vient de l'interface, traduit.**
fn adopt_legacy(connection: &rusqlite::Connection, title: &str) -> Result<bool, AppError> {
  let legacy: Option<String> = connection
    .query_row(
      "SELECT prompt FROM user_prompts WHERE usage = ?1",
      [LIVE_REPORT],
      |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|error| match error {
      rusqlite::Error::QueryReturnedNoRows => Ok(None),
      _ => Err(AppError::Database(format!(
        "lecture du prompt « {LIVE_REPORT} »"
      ))),
    })?;

  let Some(prompt) = legacy else {
    return Ok(false);
  };

  let title = title.trim();
  if title_already_taken(connection, title)? {
    return Ok(false);
  }

  let transaction = connection
    .unchecked_transaction()
    .map_err(|_| AppError::Database("reprise du prompt de compte rendu".to_string()))?;
  insert_prompt(&transaction, title, &prompt)?;
  transaction
    .execute("DELETE FROM user_prompts WHERE usage = ?1", [LIVE_REPORT])
    .map_err(|_| AppError::Database("reprise du prompt de compte rendu".to_string()))?;
  transaction
    .commit()
    .map_err(|_| AppError::Database("reprise du prompt de compte rendu".to_string()))?;
  Ok(true)
}

/// Reprend l'ancien prompt unique, une seule fois. Rend `true` s'il y avait quelque chose.
///
/// # Errors
///
/// Voir [`adopt_legacy`].
///
/// # Pièges
///
/// - ⚠️ **N'émet PAS [`LIVE_PROMPT_EVENT`]** : elle est appelée pendant que les fenêtres montent
///   leur liste, et l'évènement leur ferait relire une base qu'elles s'apprêtent déjà à lire.
/// - ⚠️ **L'échec est journalisé par son seul discriminant** : c'est la seule trace qu'aura le
///   porteur si un utilisateur perd son ancien prompt. Ni titre ni texte dans le journal.
#[tauri::command]
pub async fn adopt_legacy_live_prompt(
  state: State<'_, AppState>,
  title: String,
) -> Result<bool, AppError> {
  let database = state.database();
  let outcome = off_thread(move || {
    let connection = database.lock()?;
    adopt_legacy(&connection, &title)
  })
  .await;
  if let Err(error) = &outcome {
    log::warn!(
      "reprise de l'ancien prompt de compte rendu en échec ({})",
      error.kind()
    );
  }
  outcome
}

#[cfg(test)]
mod tests {
  use super::{
    DICTATION_REPHRASING, LIVE_REPORT, MAX_PROMPT_LENGTH, MAX_REPORT_PROMPTS, MAX_TITLE_LENGTH,
    adopt_legacy, all_prompts, insert_prompt, modify_prompt, remove_prompt, validated,
    within_length, within_title_length,
  };
  use crate::db::{Database, schema};
  use crate::security::key::EncryptionKey;

  /// Retire son dossier même si le corps qu'elle encadre panique.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Sans elle, un test qui panique laisserait sa base — et un déclencheur de test posé
  ///   dessus — au chemin nommé par pid + `ThreadId`, qu'un test suivant sur le même thread
  ///   réutiliserait empoisonné.
  struct TempDirGuard(std::path::PathBuf);

  impl Drop for TempDirGuard {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  /// Le SQL des deux commandes, exercé sur une vraie base chiffrée — sans Tauri, dont le
  /// `State` n'est pas constructible hors d'une application.
  fn with_database(body: impl FnOnce(&Database)) {
    let directory = std::env::temp_dir().join(format!(
      "mirmalion-prompts-{}-{:?}",
      std::process::id(),
      std::thread::current().id()
    ));
    std::fs::create_dir_all(&directory).expect("dossier temporaire");
    let _guard = TempDirGuard(directory.clone());
    let path = directory.join("test.db");
    let key = EncryptionKey::from_hex("b".repeat(64)).expect("clé valide");
    let database = Database::open(&path, &key).expect("base ouverte");
    body(&database);
  }

  fn read_as(database: &Database, usage: &str) -> Option<String> {
    let connection = database.lock().expect("verrou");
    connection
      .query_row(
        "SELECT prompt FROM user_prompts WHERE usage = ?1",
        [usage],
        |row| row.get::<_, String>(0),
      )
      .ok()
  }

  fn write_as(database: &Database, usage: &str, prompt: &str) {
    let connection = database.lock().expect("verrou");
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
      connection
        .execute("DELETE FROM user_prompts WHERE usage = ?1", [usage])
        .expect("suppression");
    } else {
      connection
        .execute(
          "INSERT INTO user_prompts (usage, prompt, updated_at)
           VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
           ON CONFLICT (usage) DO UPDATE SET
             prompt = excluded.prompt,
             updated_at = excluded.updated_at",
          rusqlite::params![usage, trimmed],
        )
        .expect("écriture");
    }
  }

  fn read(database: &Database) -> Option<String> {
    read_as(database, DICTATION_REPHRASING)
  }

  fn write(database: &Database, prompt: &str) {
    write_as(database, DICTATION_REPHRASING, prompt);
  }

  /// ⚠️ Les deux usages ne se marchent pas dessus, et c'est tout ce qui sépare une table
  /// partagée d'un bogue : le SQL est factorisé et l'usage est un paramètre, donc rien
  /// n'empêcherait le prompt de compte rendu d'écraser celui de la reformulation.
  #[test]
  fn the_two_usages_never_overwrite_each_other() {
    with_database(|database| {
      write_as(database, DICTATION_REPHRASING, "ton professionnel");
      write_as(database, LIVE_REPORT, "décisions et tâches");

      assert_eq!(
        read_as(database, DICTATION_REPHRASING).as_deref(),
        Some("ton professionnel")
      );
      assert_eq!(
        read_as(database, LIVE_REPORT).as_deref(),
        Some("décisions et tâches")
      );

      // Effacer l'un laisse l'autre intact — le geste « je vide le champ » est fréquent.
      write_as(database, LIVE_REPORT, "");
      assert!(read_as(database, LIVE_REPORT).is_none());
      assert_eq!(
        read_as(database, DICTATION_REPHRASING).as_deref(),
        Some("ton professionnel"),
        "vider un prompt ne doit pas toucher à l'autre"
      );
    });
  }

  #[test]
  fn the_migration_creates_the_table() {
    with_database(|database| {
      assert_eq!(
        database.schema_version().expect("version"),
        schema::latest_version()
      );
      assert!(read(database).is_none(), "aucun prompt au départ");
    });
  }

  #[test]
  fn a_prompt_survives_being_written_and_read_back() {
    with_database(|database| {
      write(database, "Ton professionnel, sans jargon.");
      assert_eq!(
        read(database).as_deref(),
        Some("Ton professionnel, sans jargon.")
      );
    });
  }

  /// Écrire deux fois **remplace**, sans créer de seconde ligne : la clé primaire et
  /// `ON CONFLICT` en répondent, mais c'est le genre de chose qu'un test doit tenir.
  #[test]
  fn writing_twice_replaces_rather_than_duplicates() {
    with_database(|database| {
      write(database, "premier");
      write(database, "second");
      assert_eq!(read(database).as_deref(), Some("second"));

      let connection = database.lock().expect("verrou");
      let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM user_prompts", [], |row| row.get(0))
        .expect("comptage");
      assert_eq!(count, 1);
    });
  }

  /// Vider le champ efface la ligne — et non enregistrer une chaîne vide, qui obligerait
  /// chaque lecteur à distinguer deux formes du même rien.
  #[test]
  fn an_empty_prompt_erases_the_row() {
    with_database(|database| {
      write(database, "quelque chose");
      write(database, "   ");
      assert!(read(database).is_none());
    });
  }

  #[test]
  fn a_normal_description_fits_easily() {
    assert!(within_length(
      "Reformule sur un ton professionnel, sans jargon, en gardant les tournures directes."
    ));
  }

  #[test]
  fn a_prompt_beyond_the_cap_is_refused() {
    assert!(within_length(&"a".repeat(MAX_PROMPT_LENGTH)));
    assert!(!within_length(&"a".repeat(MAX_PROMPT_LENGTH + 1)));
  }

  /// ⚠️ **La borne compte des CARACTÈRES.** Mesurée en octets, une description accentuée serait
  /// refusée à la moitié de la longueur tolérée pour une anglaise — deux octets par lettre.
  #[test]
  fn the_cap_counts_characters_and_not_bytes() {
    let accented = "é".repeat(MAX_PROMPT_LENGTH);
    assert!(
      accented.len() > MAX_PROMPT_LENGTH,
      "bien plus long en octets"
    );
    assert!(within_length(&accented));
    assert!(!within_length(&"é".repeat(MAX_PROMPT_LENGTH + 1)));
  }

  #[test]
  fn a_title_beyond_the_cap_is_refused() {
    assert!(within_title_length(&"a".repeat(MAX_TITLE_LENGTH)));
    assert!(!within_title_length(&"a".repeat(MAX_TITLE_LENGTH + 1)));
  }

  /// ⚠️ **La borne du titre compte des CARACTÈRES**, comme celle du prompt : mesurée en octets,
  /// un titre accentué serait refusé à la moitié de la longueur tolérée pour un titre anglais.
  #[test]
  fn the_title_cap_counts_characters_and_not_bytes() {
    let accented = "é".repeat(MAX_TITLE_LENGTH);
    assert!(
      accented.len() > MAX_TITLE_LENGTH,
      "bien plus long en octets"
    );
    assert!(within_title_length(&accented));
  }

  /// ⚠️ **Un prompt sans titre ne se retrouve pas dans un menu, un titre sans prompt ne produit
  /// rien.** Les deux sont refusés côté Rust, et pas seulement éteints dans l'interface : le
  /// WebView n'est pas fiable.
  #[test]
  fn a_prompt_needs_both_a_title_and_a_text() {
    assert!(validated("", "Décisions et tâches.").is_err());
    assert!(validated("   ", "Décisions et tâches.").is_err());
    assert!(validated("Client", "").is_err());
    assert!(validated("Client", "   ").is_err());
  }

  /// Les espaces de bord partent des deux côtés : « Client » et « Client  » sont le même titre.
  #[test]
  fn validation_trims_both_sides() {
    let (title, prompt) = validated("  Client  ", "  Décisions.  ").expect("valide");
    assert_eq!(title, "Client");
    assert_eq!(prompt, "Décisions.");
  }

  #[test]
  fn a_created_prompt_comes_back_in_the_list() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      let created = insert_prompt(&connection, "Client", "Décisions et tâches.").expect("créé");

      assert_eq!(created.title, "Client");
      assert_eq!(created.prompt, "Décisions et tâches.");
      assert!(created.id > 0);

      let all = all_prompts(&connection).expect("liste");
      assert_eq!(all.len(), 1);
      assert_eq!(all[0].id, created.id);
    });
  }

  /// ⚠️ **Trié par titre, sans casse** : c'est l'ordre du menu déroulant, et il ne doit pas
  /// dépendre de l'ordre de création — une liste qui s'allonge ne se retrouve pas de tête.
  #[test]
  fn the_list_comes_back_sorted_by_title() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      insert_prompt(&connection, "veille", "…").expect("créé");
      insert_prompt(&connection, "Client", "…").expect("créé");
      insert_prompt(&connection, "atelier", "…").expect("créé");

      let titles: Vec<String> = all_prompts(&connection)
        .expect("liste")
        .into_iter()
        .map(|entry| entry.title)
        .collect();
      assert_eq!(titles, ["atelier", "Client", "veille"]);
    });
  }

  /// ⚠️ **Le plafond est tenu côté Rust**, pas seulement par un bouton éteint : un frontend
  /// compromis remplirait la base de l'utilisateur.
  #[test]
  fn the_cap_on_the_number_of_prompts_is_enforced() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      for index in 0..MAX_REPORT_PROMPTS {
        insert_prompt(&connection, &format!("prompt {index}"), "…").expect("créé");
      }
      assert!(
        insert_prompt(&connection, "un de trop", "…").is_err(),
        "le 21ᵉ prompt doit être refusé"
      );
    });
  }

  /// ⚠️ **Aucun titre ni aucun prompt dans un message d'erreur** : « Bilan Dupont & Fils » nomme
  /// un client autant que le prompt lui-même. Ce test garde la porte.
  #[test]
  fn a_refusal_never_quotes_what_the_user_wrote() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      insert_prompt(&connection, "Bilan Dupont", "Le secret de Dupont.").expect("créé");
      let refused = insert_prompt(&connection, "Bilan Dupont", "Le secret de Dupont.")
        .expect_err("titre déjà pris");

      let message = format!("{refused:?}");
      assert!(
        !message.contains("Dupont"),
        "le message ne cite rien de l'utilisateur"
      );
    });
  }

  /// ⚠️ **Un titre pris rend [`AppError::Conflict`], jamais [`AppError::Database`]** : c'est ce
  /// discriminant qui laisse l'interface dire « ce titre est déjà pris » dans la langue de
  /// l'utilisateur, là où un disque plein reste un incident à signaler tel quel.
  #[test]
  fn a_taken_title_is_a_conflict_and_not_a_database_failure() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      insert_prompt(&connection, "Client", "Décisions.").expect("créé");
      let other = insert_prompt(&connection, "Veille", "Signaux.").expect("créé");

      assert_eq!(
        insert_prompt(&connection, "client", "Autre chose.")
          .expect_err("titre déjà pris")
          .kind(),
        "conflict",
        "l'unicité est sans casse"
      );
      assert_eq!(
        modify_prompt(&connection, other.id, "CLIENT", "Autre chose.")
          .expect_err("titre déjà pris")
          .kind(),
        "conflict"
      );
    });
  }

  /// ⚠️ Un échec qui n'est PAS un titre pris reste une erreur de base : sans quoi l'interface
  /// dirait « ce titre est déjà pris » d'un disque plein.
  #[test]
  fn any_other_write_failure_stays_a_database_error() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      let created = insert_prompt(&connection, "Client", "Décisions.").expect("créé");
      connection
        .execute("DROP TABLE report_prompts", [])
        .expect("table retirée");

      assert_eq!(
        insert_prompt(&connection, "Veille", "Signaux.")
          .expect_err("table absente")
          .kind(),
        "database"
      );
      assert_eq!(
        modify_prompt(&connection, created.id, "Veille", "Signaux.")
          .expect_err("table absente")
          .kind(),
        "database"
      );
    });
  }

  #[test]
  fn a_modified_prompt_keeps_its_number() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      let created = insert_prompt(&connection, "Client", "Décisions.").expect("créé");

      let changed = modify_prompt(
        &connection,
        created.id,
        "Point client",
        "Décisions et risques.",
      )
      .expect("modifié");

      // ⚠️ Le numéro ne bouge pas : c'est lui que le réglage du compte rendu par défaut retient.
      assert_eq!(changed.id, created.id);
      assert_eq!(changed.title, "Point client");
      assert_eq!(all_prompts(&connection).expect("liste").len(), 1);
    });
  }

  /// ⚠️ Se renommer avec son PROPRE titre n'est pas un doublon : sans cette exception, corriger
  /// une faute dans le texte sans toucher au titre serait refusé.
  #[test]
  fn a_prompt_can_keep_its_own_title_while_its_text_changes() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      let created = insert_prompt(&connection, "Client", "Décisions.").expect("créé");

      let changed = modify_prompt(&connection, created.id, "Client", "Décisions et risques.")
        .expect("le même titre est permis sur la même ligne");
      assert_eq!(changed.prompt, "Décisions et risques.");
    });
  }

  #[test]
  fn modifying_a_prompt_that_is_gone_is_refused() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      assert!(modify_prompt(&connection, 404, "Client", "Décisions.").is_err());
    });
  }

  #[test]
  fn a_removed_prompt_leaves_the_others_alone() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      let first = insert_prompt(&connection, "Client", "…").expect("créé");
      let second = insert_prompt(&connection, "Veille", "…").expect("créé");

      remove_prompt(&connection, first.id).expect("supprimé");

      let all = all_prompts(&connection).expect("liste");
      assert_eq!(all.len(), 1);
      assert_eq!(all[0].id, second.id);
    });
  }

  /// ⚠️ **Supprimer ce qui n'existe plus ne fâche personne** : deux fenêtres montrent la même
  /// liste, et la seconde peut cliquer sur une ligne que la première vient d'effacer.
  #[test]
  fn removing_a_prompt_twice_is_not_an_error() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      let created = insert_prompt(&connection, "Client", "…").expect("créé");
      remove_prompt(&connection, created.id).expect("supprimé");
      remove_prompt(&connection, created.id).expect("un second passage ne fâche pas");
    });
  }

  /// ⚠️ **Le numéro d'un prompt supprimé n'est JAMAIS réattribué** — c'est tout l'intérêt
  /// d'`AUTOINCREMENT`. Sans lui, le réglage qui retient le prompt par défaut désignerait
  /// silencieusement le prompt suivant.
  #[test]
  fn a_freed_number_never_comes_back() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      let first = insert_prompt(&connection, "Client", "…").expect("créé");
      remove_prompt(&connection, first.id).expect("supprimé");
      let second = insert_prompt(&connection, "Veille", "…").expect("créé");

      assert_ne!(second.id, first.id, "un numéro libéré ne se réattribue pas");
    });
  }

  /// ⚠️ **Le titre vient de l'interface, traduit.** Une migration SQL ne parle pas six langues,
  /// et un titre français chez un utilisateur allemand serait un défaut visible.
  #[test]
  fn the_old_single_prompt_becomes_the_first_named_one() {
    with_database(|database| {
      write_as(database, LIVE_REPORT, "Décisions, tâches, risques.");
      let connection = database.lock().expect("verrou");

      assert!(adopt_legacy(&connection, "Mon prompt personnalisé").expect("reprise"));

      let all = all_prompts(&connection).expect("liste");
      assert_eq!(all.len(), 1);
      assert_eq!(all[0].title, "Mon prompt personnalisé");
      assert_eq!(all[0].prompt, "Décisions, tâches, risques.");

      drop(connection);
      // L'ancienne ligne est partie : rien ne doit pouvoir la reprendre deux fois.
      assert!(read_as(database, LIVE_REPORT).is_none());
    });
  }

  /// ⚠️ **Idempotente, et c'est ce qui la rend sûre** : les deux fenêtres l'appellent au
  /// démarrage. Un second passage ne doit rien créer.
  #[test]
  fn a_second_adoption_does_nothing() {
    with_database(|database| {
      write_as(database, LIVE_REPORT, "Décisions, tâches, risques.");
      let connection = database.lock().expect("verrou");

      assert!(adopt_legacy(&connection, "Mon prompt personnalisé").expect("première"));
      assert!(!adopt_legacy(&connection, "Mon prompt personnalisé").expect("seconde"));
      assert_eq!(all_prompts(&connection).expect("liste").len(), 1);
    });
  }

  /// Rien à reprendre chez un utilisateur qui n'avait jamais écrit de prompt.
  #[test]
  fn nothing_to_adopt_is_not_an_error() {
    with_database(|database| {
      let connection = database.lock().expect("verrou");
      assert!(!adopt_legacy(&connection, "Mon prompt personnalisé").expect("rien à faire"));
      assert!(all_prompts(&connection).expect("liste").is_empty());
    });
  }

  /// ⚠️ **La reformulation de dictée n'est PAS touchée** : elle garde son prompt unique, et
  /// c'est la seule ligne de `user_prompts` qui doit survivre à cette reprise.
  #[test]
  fn the_dictation_prompt_survives_the_adoption() {
    with_database(|database| {
      write_as(database, DICTATION_REPHRASING, "ton professionnel");
      write_as(database, LIVE_REPORT, "Décisions.");
      let connection = database.lock().expect("verrou");

      adopt_legacy(&connection, "Mon prompt personnalisé").expect("reprise");

      drop(connection);
      assert_eq!(
        read_as(database, DICTATION_REPHRASING).as_deref(),
        Some("ton professionnel")
      );
    });
  }

  /// ⚠️ **Insertion et suppression sont une seule transaction** : si l'une échoue après que
  /// l'autre a réussi, tout revient en arrière — jamais de doublon, jamais de perte.
  #[test]
  fn a_failed_deletion_rolls_back_the_insertion_too() {
    with_database(|database| {
      write_as(database, LIVE_REPORT, "Décisions.");
      let connection = database.lock().expect("verrou");
      connection
        .execute_batch(
          "CREATE TRIGGER block_delete BEFORE DELETE ON user_prompts
           BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        )
        .expect("déclencheur de test");

      assert!(adopt_legacy(&connection, "Mon prompt personnalisé").is_err());
      assert!(all_prompts(&connection).expect("liste").is_empty());

      connection
        .execute_batch("DROP TRIGGER block_delete;")
        .expect("retrait du déclencheur de test");
      drop(connection);
      assert_eq!(
        read_as(database, LIVE_REPORT).as_deref(),
        Some("Décisions.")
      );
    });
  }

  /// ⚠️ **Un titre déjà pris par l'utilisateur n'est pas une erreur, et sa ligne d'origine
  /// survit** : ce texte hérité n'est pas celui du prompt existant, l'effacer le perdrait.
  #[test]
  fn a_title_already_taken_by_the_user_leaves_the_legacy_row_intact() {
    with_database(|database| {
      write_as(database, LIVE_REPORT, "Décisions héritées.");
      let connection = database.lock().expect("verrou");
      insert_prompt(
        &connection,
        "Mon prompt personnalisé",
        "Déjà écrit par moi.",
      )
      .expect("créé par l'utilisateur");

      assert!(!adopt_legacy(&connection, "Mon prompt personnalisé").expect("rien à reprendre"));

      let all = all_prompts(&connection).expect("liste");
      assert_eq!(all.len(), 1);
      assert_eq!(all[0].prompt, "Déjà écrit par moi.");

      drop(connection);
      assert_eq!(
        read_as(database, LIVE_REPORT).as_deref(),
        Some("Décisions héritées."),
        "l'ancien texte n'est pas celui du prompt existant"
      );
    });
  }

  /// ⚠️ **Les deux bornes coïncident par construction, pas par contrat** : rien ne relie
  /// [`MAX_PROMPT_LENGTH`] à la longueur qu'un prompt hérité peut atteindre.
  #[test]
  fn a_legacy_prompt_at_the_max_length_is_still_adoptable() {
    with_database(|database| {
      let long_prompt = "d".repeat(MAX_PROMPT_LENGTH);
      write_as(database, LIVE_REPORT, &long_prompt);
      let connection = database.lock().expect("verrou");

      assert!(adopt_legacy(&connection, "Mon prompt personnalisé").expect("reprise"));

      let all = all_prompts(&connection).expect("liste");
      assert_eq!(all[0].prompt, long_prompt);
    });
  }
}
