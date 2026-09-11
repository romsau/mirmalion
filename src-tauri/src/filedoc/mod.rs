//! Les documents de transcription ouverts — en mémoire, et nulle part ailleurs.
//!
//! Le document vit ici et non dans la fenêtre pour deux raisons : la fenêtre est rechargeable —
//! en développement à chaque sauvegarde, en production sur un plantage du webview — et un
//! document qui vivrait dans son JavaScript disparaîtrait ; l'export et la traduction sont des
//! commandes natives, à qui faire traverser le pont dix mille mots par appel serait absurde.
//!
//! # Pièges
//!
//! - ⚠️ La transcription d'un fichier n'est pas conservée : rien ici ne touche à SQLite, et rien
//!   ne doit y toucher. Persister créerait une base de transcriptions jamais demandée, tirée de
//!   médias qui portent des voix de tiers.
//! - ⚠️ Toutes les voies de fermeture — pastille, ⌘W, menu — passent par `close_file_document`,
//!   qui libère la mémoire. Aucune modale ne confirme : le média source est resté sur le disque,
//!   et la transcription se refait en quelques secondes.

use std::{
  collections::HashMap,
  sync::Mutex,
  sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};

use crate::{error::AppError, media, transcript::Transcript};

/// Un document ouvert.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDocument {
  /// L'identifiant du document, valable le temps du processus.
  pub id: String,
  /// Le titre affiché. Vaut le nom du fichier tant que l'utilisateur ne l'a pas renommé.
  pub title: String,
  /// Le nom du fichier d'origine, extension comprise — le repli du titre vidé.
  pub file_name: String,
  /// Le chemin du média, toujours sur le disque de l'utilisateur : c'est lui qui rend la
  /// ré-analyse possible, et c'est pour cela qu'on ne copie jamais le fichier.
  pub path: String,
  /// La langue détectée.
  pub language: String,
  /// La durée du média, en millisecondes.
  pub duration_ms: u64,
  /// Le transcript courant — celui qu'affiche la fenêtre.
  pub transcript: Transcript,
}

/// Le magasin des documents ouverts.
///
/// # Pièges
///
/// - ⚠️ Verrou synchrone, jamais tenu à travers un `.await` — même règle que la base. Les
///   commandes qui travaillent longtemps relâchent le verrou, travaillent, puis le reprennent
///   pour ranger le résultat.
#[derive(Default)]
pub struct Documents {
  entries: Mutex<HashMap<String, FileDocument>>,
  next: AtomicU64,
}

impl Documents {
  /// Ouvre un document et le rend.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin est empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un compteur, pas un identifiant aléatoire : il ne distingue que des fenêtres vivantes
  ///   d'un seul processus, et n'est jamais persisté, donc jamais réutilisé après un redémarrage.
  pub fn open(
    &self,
    path: String,
    file_name: String,
    language: String,
    duration_ms: u64,
    transcript: Transcript,
  ) -> Result<FileDocument, AppError> {
    let id = format!("filedoc-{}", self.next.fetch_add(1, Ordering::SeqCst));
    let document = FileDocument {
      id: id.clone(),
      // ⚠️ Le titre naît du nom du fichier privé de son extension : celle-ci ressortait au
      // milieu du nom de l'export (`… .mp4_3 août 2026.docx`), où l'utilisateur ne reconnaissait
      // plus son fichier. `file_name` reste entier — c'est ce que la ré-analyse relit.
      title: media::title_of(&file_name).to_owned(),
      file_name,
      path,
      language,
      duration_ms,
      transcript,
    };
    self
      .entries
      .lock()
      .map_err(poisoned)?
      .insert(id, document.clone());
    Ok(document)
  }

  /// Relit un document.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::InvalidArgument`] si l'identifiant est inconnu, [`AppError::Io`] si le
  /// verrou du magasin est empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un identifiant inconnu est une erreur, pas un `None` silencieux : la fenêtre demande
  ///   toujours le document qu'elle affiche, et le taire la laisserait vide sans explication.
  pub fn get(&self, id: &str) -> Result<FileDocument, AppError> {
    self
      .entries
      .lock()
      .map_err(poisoned)?
      .get(id)
      .cloned()
      .ok_or_else(|| AppError::InvalidArgument(format!("document inconnu : {id}")))
  }

  /// Renomme le document et rend sa nouvelle forme.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::InvalidArgument`] si l'identifiant est inconnu.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un titre vide ou fait d'espaces retombe sur le titre de départ — nom du fichier privé
  ///   de son extension —, jamais sur rien ni sur le nom brut : une fenêtre sans titre serait
  ///   introuvable dans le Dock, et un `.mp4` surgirait là où il n'a jamais été montré.
  pub fn rename(&self, id: &str, title: &str) -> Result<FileDocument, AppError> {
    let mut entries = self.entries.lock().map_err(poisoned)?;
    let document = entries
      .get_mut(id)
      .ok_or_else(|| AppError::InvalidArgument(format!("document inconnu : {id}")))?;
    let trimmed = title.trim();
    document.title = if trimmed.is_empty() {
      media::title_of(&document.file_name).to_owned()
    } else {
      trimmed.to_string()
    };
    Ok(document.clone())
  }

  /// Ferme un document et libère sa mémoire.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin est empoisonné.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Idempotent : la fenêtre se ferme par la pastille rouge, par ⌘W et par le menu, et
  ///   refuser le second appel ferait surgir une erreur sur un geste qui n'a rien cassé.
  pub fn close(&self, id: &str) -> Result<(), AppError> {
    self.entries.lock().map_err(poisoned)?.remove(id);
    Ok(())
  }

  /// Combien de documents sont ouverts. Réservé aux tests.
  ///
  /// Le produit n'a aucune raison de compter ses documents — chaque fenêtre connaît le sien. Ce
  /// compteur existe pour prouver qu'une fermeture libère réellement la mémoire.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin est empoisonné.
  #[cfg(test)]
  pub fn len(&self) -> Result<usize, AppError> {
    Ok(self.entries.lock().map_err(poisoned)?.len())
  }

  /// Le magasin est-il vide ? Réservé aux tests.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Io`] si le verrou du magasin est empoisonné.
  #[cfg(test)]
  pub fn is_empty(&self) -> Result<bool, AppError> {
    Ok(self.len()? == 0)
  }
}

/// L'erreur rendue quand le verrou du magasin est empoisonné.
///
/// Un autre fil a paniqué en le tenant. On le rapporte au lieu de paniquer à notre tour : perdre
/// un document vaut mieux que perdre le processus, qui emporterait tous les autres.
fn poisoned<T>(_: std::sync::PoisonError<T>) -> AppError {
  AppError::Io("le magasin des documents est inutilisable".into())
}

#[cfg(test)]
mod tests {
  use super::Documents;
  use crate::transcript::{Transcript, Word};

  /// Un mot horodaté, écrit court parce que ces tests en alignent plusieurs.
  fn word(text: &str, start_ms: u64, end_ms: u64) -> Word {
    Word {
      text: text.into(),
      start_ms,
      end_ms,
    }
  }

  /// Un transcript d'un seul mot, suffisant pour tout ce que ce module éprouve.
  fn transcript() -> Transcript {
    Transcript::of(&[word("Bonjour", 0, 400)], "fr")
  }

  /// Ouvre un document de test et rend son identifiant.
  fn open(store: &Documents, file_name: &str) -> String {
    store
      .open(
        format!("/tmp/{file_name}"),
        file_name.into(),
        "fr".into(),
        400,
        transcript(),
      )
      .expect("ouverture")
      .id
  }

  /// ⚠️ Le titre perd l'extension, le nom de fichier la garde : l'un se lit, l'autre se retrouve
  /// sur le disque.
  #[test]
  fn a_document_takes_the_file_name_without_its_extension_as_its_title() {
    let store = Documents::default();
    let document = store
      .open(
        "/tmp/plateau.mp4".into(),
        "plateau.mp4".into(),
        "fr".into(),
        400,
        transcript(),
      )
      .expect("ouverture");
    assert_eq!(document.title, "plateau");
    assert_eq!(
      document.file_name, "plateau.mp4",
      "l'origine reste entière : c'est elle que la ré-analyse relit"
    );
  }

  #[test]
  fn two_documents_are_independent() {
    // ⚠️ Plusieurs fenêtres-documents s'ouvrent en parallèle : renommer l'une ne doit rien
    // faire à l'autre.
    let store = Documents::default();
    let first = open(&store, "a.mp3");
    let second = open(&store, "b.mp3");
    assert_ne!(first, second);

    store.rename(&first, "Entretien").expect("renommage");
    assert_eq!(store.get(&first).expect("lecture").title, "Entretien");
    assert_eq!(store.get(&second).expect("lecture").title, "b");
  }

  #[test]
  fn an_unknown_document_is_an_error_rather_than_a_silent_nothing() {
    // Ne rien trouver veut dire que le magasin et les fenêtres ont divergé : le taire donnerait
    // une fenêtre vide sans explication.
    let store = Documents::default();
    let error = store.get("filedoc-404").expect_err("erreur");
    assert_eq!(error.kind(), "invalidArgument");
    assert!(error.to_string().contains("filedoc-404"));

    assert!(store.rename("filedoc-404", "x").is_err());
  }

  /// ⚠️ Se raviser ramène au titre de départ, et non au nom de fichier brut : un `.mp4`
  /// surgissant à ce moment-là n'aurait jamais été montré auparavant.
  #[test]
  fn an_emptied_title_falls_back_to_the_opening_title() {
    let store = Documents::default();
    let id = open(&store, "plateau.mp4");
    store.rename(&id, "Mon titre").expect("renommage");
    let document = store.rename(&id, "   ").expect("renommage");
    assert_eq!(
      document.title, "plateau",
      "une fenêtre sans titre serait introuvable dans le Dock"
    );
  }

  /// ⚠️ Les mots horodatés sont dans le transcript, et nulle part ailleurs : deux sources pour la
  /// même chose divergeraient à la première correction.
  #[test]
  fn the_timed_words_live_in_the_transcript() {
    let store = Documents::default();
    let id = open(&store, "a.mp3");
    let document = store.get(&id).expect("lecture");
    assert_eq!(document.transcript.paragraphs[0].words[0].text, "Bonjour");
  }

  #[test]
  fn closing_frees_the_memory_and_closing_twice_is_not_an_error() {
    // La fenêtre se ferme par la pastille rouge, par ⌘W et par le menu : refuser le second
    // appel ferait surgir une snackbar d'erreur sur un geste qui n'a rien cassé.
    let store = Documents::default();
    let id = open(&store, "a.mp3");
    assert_eq!(store.len().expect("compte"), 1);

    store.close(&id).expect("fermeture");
    assert!(store.is_empty().expect("compte"));
    store.close(&id).expect("seconde fermeture");
    assert!(store.get(&id).is_err(), "le document est réellement perdu");
  }

  #[test]
  fn identifiers_never_repeat_within_a_run() {
    let store = Documents::default();
    let first = open(&store, "a.mp3");
    store.close(&first).expect("fermeture");
    let second = open(&store, "b.mp3");
    assert_ne!(first, second, "un identifiant fermé ne se réutilise pas");
  }

  #[test]
  fn the_wire_contract_is_camel_case() {
    let store = Documents::default();
    let id = open(&store, "a.mp3");
    let json = serde_json::to_value(store.get(&id).expect("lecture")).expect("sérialisation");
    assert_eq!(json["fileName"], "a.mp3");
    assert_eq!(json["durationMs"], 400);
    assert!(json.get("words").is_none(), "les mots ne sortent jamais");
  }
}
