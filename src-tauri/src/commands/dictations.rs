//! L'historique de dictée : enregistrer, relire, purger.
//!
//! Une dictée traverse jusqu'à quatre états — brut, nettoyé, reformulé, traduit — et chacun est
//! conservé tel quel. La rétention est bornée par **nombre** et non par âge : 50 / 100 / 200 /
//! 500, défaut 200, FIFO.
//!
//! # Pièges
//!
//! - ⚠️ Une colonne vide dit ce qu'aucune autre ne dit — l'étape a renoncé. Y recopier le texte
//!   de l'étape précédente ferait croire à un nettoyage qui n'a jamais eu lieu.
//! - ⚠️ Le plafond ne refuse jamais une dictée : le texte est déjà au curseur quand la purge
//!   s'exécute, et une purge en échec ne remonte nulle part.
//! - ⚠️ L'enregistrement n'est pas une commande IPC : l'exposer donnerait au WebView un moyen
//!   d'écrire dans l'historique.

use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};

use crate::{
  blocking::off_thread, db::Database, dictation::Variants, error::AppError, i18n, settings::Stored,
  state::AppState,
};

/// Une entrée de l'historique, telle que le panneau la reçoit.
///
/// # Pièges
///
/// - ⚠️ Aucune date n'est exposée, alors que la base en stocke une : la colonne existe pour
///   trier et purger, et le panneau n'affiche pas d'horodatage. Une donnée envoyée au WebView
///   finit toujours par s'afficher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictation {
  /// L'identifiant de la ligne, par lequel la dictée se supprime.
  pub id: i64,
  /// La langue dictée.
  pub language: String,
  /// Le texte sorti du moteur, avant toute retouche.
  pub raw_text: String,
  /// Le texte nettoyé ; absent si l'étape n'a pas eu lieu ou a renoncé.
  pub cleaned_text: Option<String>,
  /// Le texte reformulé ; absent si l'étape n'a pas eu lieu ou a renoncé.
  pub rephrased_text: Option<String>,
  /// Le texte traduit ; absent si l'étape n'a pas eu lieu ou a renoncé.
  pub translated_text: Option<String>,
  /// La langue de la traduction, quand il y en a une.
  pub translated_language: Option<String>,
}

/// Enregistre une dictée, puis applique le plafond. À l'usage du pipeline seulement.
///
/// # Errors
///
/// Rend [`AppError::Database`] si l'écriture ou la purge échoue, [`AppError::Io`] si la tâche n'est
/// pas revenue.
///
/// # Pièges
///
/// - ⚠️ Ne doit pas devenir une commande IPC : le seul appelant légitime est le pipeline natif,
///   qui vient d'insérer le texte au curseur.
pub async fn save(
  database: Arc<Database>,
  variants: Variants,
  retention: i64,
) -> Result<(), AppError> {
  off_thread(move || {
    let connection = database.lock()?;
    store(&connection, &variants)?;
    purge(&connection, retention)
  })
  .await
}

/// Écrit les quatre variantes. Séparé de [`save`] pour être éprouvable sans runtime Tauri.
///
/// # Errors
///
/// Rend [`AppError::Database`] si l'insertion échoue.
///
/// # Pièges
///
/// - ⚠️ La date est posée par SQLite et non par Rust : `strftime` rend la même forme ISO 8601
///   UTC que le reste du schéma, sans risquer deux formats dans la même colonne.
fn store(connection: &rusqlite::Connection, variants: &Variants) -> Result<(), AppError> {
  connection
    .execute(
      "INSERT INTO dictations
         (created_at, language, raw_text, cleaned_text, rephrased_text,
          translated_text, translated_language)
       VALUES (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?1, ?2, ?3, ?4, ?5, ?6)",
      rusqlite::params![
        variants.language,
        variants.raw,
        variants.cleaned,
        variants.rephrased,
        variants.translated,
        variants.translated_language,
      ],
    )
    .map(|_| ())
    // ⚠️ Aucun texte dicté dans le message, pas même via l'erreur SQL.
    .map_err(|_| AppError::Database("enregistrement de la dictée".to_owned()))
}

/// L'historique, du plus récent au plus ancien, rendu en entier.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la lecture, [`AppError::Io`] si la tâche n'est pas
/// revenue.
///
/// # Pièges
///
/// - ⚠️ Ne pas déplacer la recherche dans le SQL : SQLite ne sait pas comparer « résumé » et
///   « resume » sans extension ICU. Le frontend filtre cette liste, plafonnée à 500 entrées.
#[tauri::command]
pub async fn list_dictations(state: State<'_, AppState>) -> Result<Vec<Dictation>, AppError> {
  let database = state.database();
  off_thread(move || {
    let connection = database.lock()?;
    let mut statement = connection
      .prepare(
        "SELECT id, language, raw_text, cleaned_text, rephrased_text,
                translated_text, translated_language
           FROM dictations
          ORDER BY created_at DESC, id DESC",
      )
      .map_err(|error| AppError::Database(format!("lecture de l'historique : {error}")))?;
    let rows = statement
      .query_map([], |row| {
        Ok(Dictation {
          id: row.get(0)?,
          language: row.get(1)?,
          raw_text: row.get(2)?,
          cleaned_text: row.get(3)?,
          rephrased_text: row.get(4)?,
          translated_text: row.get(5)?,
          translated_language: row.get(6)?,
        })
      })
      .map_err(|error| AppError::Database(format!("lecture de l'historique : {error}")))?;
    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| AppError::Database(format!("lecture de l'historique : {error}")))
  })
  .await
}

/// Supprime une dictée, sans effet si elle n'existe pas.
///
/// L'utilisateur a pu la supprimer depuis une autre fenêtre : lui montrer une erreur pour un
/// résultat déjà obtenu n'aiderait personne.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la suppression, [`AppError::Io`] si la tâche n'est
/// pas revenue.
#[tauri::command]
pub async fn delete_dictation(state: State<'_, AppState>, id: i64) -> Result<(), AppError> {
  let database = state.database();
  off_thread(move || {
    let connection = database.lock()?;
    connection
      .execute("DELETE FROM dictations WHERE id = ?1", [id])
      .map(|_| ())
      .map_err(|error| AppError::Database(format!("suppression d'une dictée : {error}")))
  })
  .await
}

/// Vide l'historique. Appelé derrière la modale de confirmation.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse l'effacement, [`AppError::Io`] si la tâche n'est
/// pas revenue.
#[tauri::command]
pub async fn clear_dictations(state: State<'_, AppState>) -> Result<(), AppError> {
  let database = state.database();
  off_thread(move || {
    let connection = database.lock()?;
    connection
      .execute("DELETE FROM dictations", [])
      .map(|_| ())
      .map_err(|error| AppError::Database(format!("effacement de l'historique : {error}")))
  })
  .await
}

/// Applique le plafond courant aux entrées **déjà enregistrées**.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la purge échoue, [`AppError::Io`] si la tâche n'est pas revenue.
///
/// # Pièges
///
/// - ⚠️ À appeler dès que l'utilisateur réduit le plafond : sans cela, passer de 500 à 50
///   laisserait 450 entrées visibles jusqu'à ce que la FIFO les ait lentement chassées.
#[tauri::command]
pub async fn apply_dictation_retention(state: State<'_, AppState>) -> Result<(), AppError> {
  let database = state.database();
  let retention = read_retention(&state);
  off_thread(move || {
    let connection = database.lock()?;
    purge(&connection, retention)
  })
  .await
}

/// Le plafond configuré, ou son défaut.
///
/// Relu à chaque appel : il change dans les Options, pendant que l'application tourne.
pub fn read_retention(state: &AppState) -> i64 {
  Stored::read(&state.data_dir().join(i18n::SETTINGS_FILE)).dictation_retention
}

/// Ne garde que les `retention` dictées les plus récentes.
///
/// # Errors
///
/// Rend [`AppError::Database`] si la base refuse la suppression.
///
/// # Pièges
///
/// - ⚠️ Le tri départage par identifiant : deux dictées de la même seconde partagent leur
///   `created_at`, et un `LIMIT` sur un tri ambigu laisse SQLite choisir — purge non
///   déterministe, test intermittent.
fn purge(connection: &rusqlite::Connection, retention: i64) -> Result<(), AppError> {
  connection
    .execute(
      "DELETE FROM dictations
        WHERE id NOT IN (
          SELECT id FROM dictations ORDER BY created_at DESC, id DESC LIMIT ?1
        )",
      [retention],
    )
    .map(|_| ())
    .map_err(|error| AppError::Database(format!("purge de l'historique : {error}")))
}

/// Enregistre une dictée **sans jamais faire échouer le pipeline**.
///
/// # Pièges
///
/// - ⚠️ Seule porte d'entrée du pipeline, et elle avale tout : le texte est déjà au curseur
///   quand on arrive ici, et une base verrouillée ou un disque plein ne doit pas transformer
///   une dictée réussie en erreur.
pub async fn record(app: &tauri::AppHandle, variants: Variants) {
  let Some(state) = app.try_state::<AppState>() else {
    return;
  };
  let retention = read_retention(&state);
  match save(state.database(), variants, retention).await {
    // ⚠️ Ni texte, ni langue, ni identifiant : la base est chiffrée, et cette trace est le seul
    // moyen de constater que l'archivage a lieu sans exposer ce qu'il archive.
    Ok(()) => {
      log::debug!("dictée archivée");
      announce(app);
    }
    Err(error) => log::warn!(
      "dictée non enregistrée dans l'historique : {}",
      error.kind()
    ),
  }
}

/// Le nom de l'évènement qui dit à une fenêtre ouverte que l'historique a changé.
///
/// # Pièges
///
/// - ⚠️ Sans charge utile : il annonce qu'il y a du nouveau, pas ce qu'il y a. Le contenu d'une
///   dictée ne traverse l'IPC que par [`list_dictations`], où la fenêtre le demande.
pub const RECORDED_EVENT: &str = "dictation://recorded";

/// Signale l'archivage à qui écoute — et à personne s'il n'y a pas de fenêtre.
///
/// # Pièges
///
/// - ⚠️ À n'émettre qu'après un enregistrement réussi : une dictée non enregistrée n'a rien
///   changé à l'historique, et l'annoncer ferait apparaître un panneau vide comme s'il s'était
///   rempli.
fn announce(app: &tauri::AppHandle) {
  crate::commands::announce(app, RECORDED_EVENT, ());
}

#[cfg(test)]
mod tests {
  use super::{Dictation, purge, store};
  use crate::db::Database;
  use crate::dictation::Variants;
  use crate::security::key::EncryptionKey;

  /// Le SQL exercé sur une vraie base chiffrée — même motif que `prompts.rs` : le `State` de
  /// Tauri n'est pas constructible hors d'une application.
  fn with_database(name: &str, body: impl FnOnce(&Database)) {
    let directory = std::env::temp_dir().join(format!(
      "mirmalion-dictations-{name}-{}-{:?}",
      std::process::id(),
      std::thread::current().id()
    ));
    std::fs::create_dir_all(&directory).expect("dossier temporaire");
    let path = directory.join("test.db");
    let key = EncryptionKey::from_hex("c".repeat(64)).expect("clé valide");
    {
      let database = Database::open(&path, &key).expect("base ouverte");
      body(&database);
    }
    let _ = std::fs::remove_dir_all(&directory);
  }

  fn insert(database: &Database, created_at: &str, raw: &str) {
    let connection = database.lock().expect("verrou");
    connection
      .execute(
        "INSERT INTO dictations (created_at, language, raw_text) VALUES (?1, 'fr', ?2)",
        rusqlite::params![created_at, raw],
      )
      .expect("insertion");
  }

  fn count(database: &Database) -> i64 {
    let connection = database.lock().expect("verrou");
    connection
      .query_row("SELECT COUNT(*) FROM dictations", [], |row| row.get(0))
      .expect("comptage")
  }

  fn texts(database: &Database, order: &str) -> Vec<String> {
    let connection = database.lock().expect("verrou");
    let mut statement = connection
      .prepare(&format!("SELECT raw_text FROM dictations ORDER BY {order}"))
      .expect("requête");
    statement
      .query_map([], |row| row.get(0))
      .expect("lecture")
      .collect::<Result<Vec<String>, _>>()
      .expect("lecture")
  }

  /// ⚠️ **LE CŒUR DE LA TÂCHE : les quatre variantes reviennent telles qu'elles sont parties.**
  /// Les confondre — écrire le nettoyé dans la colonne du brut, par exemple — ne casserait
  /// aucun autre test : l'historique afficherait simplement un texte plausible mais faux.
  #[test]
  fn the_four_text_variants_survive_a_round_trip() {
    with_database("variantes", |database| {
      let variants = Variants {
        language: "fr".into(),
        raw: "alors euh le rapport est prêt".into(),
        cleaned: Some("Alors, le rapport est prêt.".into()),
        rephrased: Some("Le rapport est prêt.".into()),
        translated: Some("The report is ready.".into()),
        translated_language: Some("en".into()),
      };
      {
        let connection = database.lock().expect("verrou");
        store(&connection, &variants).expect("écriture");
      }

      let connection = database.lock().expect("verrou");
      let read: Variants = connection
        .query_row(
          "SELECT language, raw_text, cleaned_text, rephrased_text, translated_text,
                  translated_language
             FROM dictations",
          [],
          |row| {
            Ok(Variants {
              language: row.get(0)?,
              raw: row.get(1)?,
              cleaned: row.get(2)?,
              rephrased: row.get(3)?,
              translated: row.get(4)?,
              translated_language: row.get(5)?,
            })
          },
        )
        .expect("relecture");
      assert_eq!(read, variants);
    });
  }

  /// ⚠️ **Une étape qui a renoncé laisse sa colonne VIDE**, et c'est l'information. Y recopier
  /// le texte de l'étape précédente ferait croire à un nettoyage qui n'a pas eu lieu.
  #[test]
  fn a_step_that_gave_up_leaves_its_column_empty() {
    with_database("renonce", |database| {
      let connection = database.lock().expect("verrou");
      store(
        &connection,
        &Variants {
          language: "fr".into(),
          raw: "le texte brut".into(),
          cleaned: None,
          rephrased: None,
          translated: None,
          translated_language: None,
        },
      )
      .expect("écriture");

      let cleaned: Option<String> = connection
        .query_row("SELECT cleaned_text FROM dictations", [], |row| row.get(0))
        .expect("relecture");
      assert_eq!(cleaned, None, "pas de repli sur le brut");
    });
  }

  /// L'écriture applique le plafond dans la foulée : sans cela, l'historique croîtrait jusqu'à
  /// la prochaine visite des Options.
  #[test]
  fn writing_a_dictation_also_enforces_the_cap() {
    with_database("plafond-a-l-ecriture", |database| {
      for index in 0..10 {
        insert(database, &format!("2026-07-30T00:00:{index:02}Z"), "ancien");
      }
      {
        let connection = database.lock().expect("verrou");
        store(
          &connection,
          &Variants {
            language: "fr".into(),
            raw: "nouveau".into(),
            cleaned: None,
            rephrased: None,
            translated: None,
            translated_language: None,
          },
        )
        .expect("écriture");
        purge(&connection, 3).expect("purge");
      }
      assert_eq!(count(database), 3);
    });
  }

  /// Les quatre paliers de rétention, éprouvés par insertion massive.
  #[test]
  fn the_four_retention_tiers_all_cap_the_history() {
    for retention in [50, 100, 200, 500] {
      with_database(&format!("tier{retention}"), |database| {
        for index in 0..600 {
          insert(
            database,
            &format!(
              "2026-07-30T{:02}:{:02}:{:02}Z",
              index / 3600,
              index / 60 % 60,
              index % 60
            ),
            "x",
          );
        }
        {
          let connection = database.lock().expect("verrou");
          purge(&connection, retention).expect("purge");
        }
        assert_eq!(count(database), retention, "palier {retention}");
      });
    }
  }

  /// ⚠️ **FIFO : c'est la plus ANCIENNE qui part.** Une purge qui garderait les mauvaises
  /// entrées passerait un simple test de comptage sans que rien ne le signale.
  #[test]
  fn the_oldest_dictations_are_the_ones_that_go() {
    with_database("fifo", |database| {
      for index in 0..10 {
        insert(
          database,
          &format!("2026-07-30T00:00:{index:02}Z"),
          &index.to_string(),
        );
      }
      {
        let connection = database.lock().expect("verrou");
        purge(&connection, 3).expect("purge");
      }
      assert_eq!(
        texts(database, "created_at DESC"),
        vec!["9", "8", "7"],
        "les trois plus récentes, et elles seules"
      );
    });
  }

  /// ⚠️ **Deux dictées de la même seconde portent la même date** — elle est à la seconde près.
  /// Sans départage par identifiant, SQLite choisirait librement laquelle survit : la purge
  /// serait non déterministe et ce test échouerait par intermittence.
  #[test]
  fn dictations_sharing_a_timestamp_are_still_ordered() {
    with_database("meme-seconde", |database| {
      for index in 0..10 {
        insert(database, "2026-07-30T00:00:00Z", &index.to_string());
      }
      {
        let connection = database.lock().expect("verrou");
        purge(&connection, 2).expect("purge");
      }
      assert_eq!(texts(database, "id DESC"), vec!["9", "8"]);
    });
  }

  /// Réduire le plafond s'applique **immédiatement** à ce qui est déjà enregistré.
  #[test]
  fn lowering_the_cap_applies_to_what_is_already_stored() {
    with_database("abaisser", |database| {
      for index in 0..400 {
        insert(
          database,
          &format!("2026-07-30T00:{:02}:{:02}Z", index / 60, index % 60),
          "x",
        );
      }
      let connection = database.lock().expect("verrou");
      purge(&connection, 500).expect("purge");
      drop(connection);
      assert_eq!(
        count(database),
        400,
        "un plafond plus haut ne supprime rien"
      );

      let connection = database.lock().expect("verrou");
      purge(&connection, 50).expect("purge");
      drop(connection);
      assert_eq!(count(database), 50);
    });
  }

  /// Une purge sur une base vide n'est pas une erreur : c'est l'état du premier lancement.
  #[test]
  fn purging_an_empty_history_is_not_a_failure() {
    with_database("vide", |database| {
      let connection = database.lock().expect("verrou");
      purge(&connection, 200).expect("purge");
    });
  }

  /// Le contrat sérialisé est celui du frontend : camelCase, et **aucune date**.
  #[test]
  fn the_serialised_shape_carries_no_timestamp() {
    let json = serde_json::to_string(&Dictation {
      id: 1,
      language: "fr".into(),
      raw_text: "brut".into(),
      cleaned_text: Some("nettoyé".into()),
      rephrased_text: None,
      translated_text: None,
      translated_language: None,
    })
    .expect("sérialisation");

    assert!(json.contains("\"rawText\""), "camelCase attendu");
    assert!(json.contains("\"cleanedText\":\"nettoyé\""));
    assert!(json.contains("\"rephrasedText\":null"));
    assert!(
      !json.contains("createdAt"),
      "pas d'horodatage vers le panneau"
    );
  }
}
