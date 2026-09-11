//! L'export d'un document : **le presse-papiers, et les formats fichier**.
//!
//! « Enregistrer sous » est ouvert **ici** ([`choose_export_path`]), et l'écriture suit
//! ([`export_document`]). Le dernier dossier est retenu dans son propre magasin, `settings.json`
//! appartenant au frontend.
//!
//! # Pièges
//!
//! - ⚠️ **Aucun chemin d'écriture ne traverse l'IPC.** Le webview demande un export, il ne dit
//!   pas où : le chemin naît du sélecteur natif et ne quitte jamais ce processus. Le lui laisser
//!   choisir donnerait au webview une écriture arbitraire — `~/.zshrc`, un agent de lancement.
//! - ⚠️ Seul chemin par lequel la donnée sort du poste : rien ne part d'ici de soi-même.
//! - ⚠️ Les textes localisés arrivent **déjà formatés** ; voir [`crate::export::naming`].
//! - ⚠️ Le fichier doit ressembler à l'écran : la traduction vit côté frontend, d'où le champ
//!   `paragraphs`. Sans lui, une fenêtre affichant de l'allemand exporterait du français.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

use crate::{
  blocking::off_thread,
  error::AppError,
  export::{
    format::ExportFormat,
    naming::file_name,
    render::{self},
  },
  filedoc::Documents,
  live::report::ReportSection,
  native,
  transcript::RenderedParagraph,
};

/// Les emplacements d'écriture choisis par l'utilisateur, un par document.
///
/// # Pièges
///
/// - ⚠️ **C'est la pièce qui remplace le chemin dans la requête.** Le webview nomme un document,
///   jamais un fichier : il ne peut demander d'écrire qu'à l'endroit que l'utilisateur a désigné
///   pour ce document-là, dans une boîte native ouverte par ce processus.
/// - ⚠️ L'emplacement se **consomme** : un export écrit, il faut redemander. Sans cela, une
///   fenêtre compromise réécrirait le même fichier autant de fois qu'elle veut.
#[derive(Default)]
pub struct ExportTargets(std::sync::Mutex<std::collections::HashMap<String, PathBuf>>);

impl ExportTargets {
  /// Range l'emplacement choisi pour ce document, en remplaçant le précédent.
  fn remember(&self, id: &str, path: PathBuf) {
    if let Ok(mut chosen) = self.0.lock() {
      chosen.insert(id.to_owned(), path);
    }
  }

  /// Reprend l'emplacement choisi, et l'oublie.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::InvalidArgument`] si aucun n'a été choisi — le seul chemin par lequel un
  /// appelant peut arriver ici est d'avoir sauté la boîte de dialogue.
  fn take(&self, id: &str) -> Result<PathBuf, AppError> {
    self
      .0
      .lock()
      .ok()
      .and_then(|mut chosen| chosen.remove(id))
      .ok_or_else(|| {
        AppError::InvalidArgument("aucun emplacement d'export n'a été choisi".to_owned())
      })
  }
}

/// Le magasin du dernier dossier d'export. **Distinct de `settings.json`** — voir l'en-tête.
const STORE_FILE: &str = "export.json";
/// La clé du dernier dossier utilisé.
const LAST_DIRECTORY: &str = "lastDirectory";

/// Ce qu'il faut pour écrire un export.
///
/// # Pièges
///
/// - ⚠️ Un objet plutôt que des paramètres positionnels : `id` et `path` sont deux chaînes
///   voisines, et deux chaînes voisines se permutent en silence côté TypeScript.
/// - ⚠️ `deny_unknown_fields` : un frontend resté en arrière enverrait des champs retirés, que
///   serde avalerait sans un mot. On refuse bruyamment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
  /// L'identifiant du document à exporter.
  pub id: String,
  /// Le format demandé.
  pub format: ExportFormat,
  /// Les paragraphes **tels qu'ils sont affichés**, ou `None` pour relire le transcript.
  #[serde(default)]
  pub paragraphs: Option<Vec<RenderedParagraph>>,
}

/// Ce qu'il faut pour copier un document dans le presse-papiers.
///
/// ⚠️ `deny_unknown_fields`, pour la même raison que sur [`ExportRequest`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyRequest {
  /// L'identifiant du document à copier.
  pub id: String,
  /// Les paragraphes **tels qu'ils sont affichés**, ou `None` pour relire le transcript.
  #[serde(default)]
  pub paragraphs: Option<Vec<RenderedParagraph>>,
}

/// Ouvre « Enregistrer sous » pour ce document et retient l'emplacement. `false` = renoncement.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un document inconnu, [`AppError::Io`] sans dossier.
///
/// # Pièges
///
/// - ⚠️ **Le chemin ne revient pas à l'appelant** : il est rangé ici, et [`export_document`] le
///   reprend. C'est ce qui distingue « écris le document rangé là » de « écris à ce chemin ».
/// - ⚠️ Séparée de l'écriture à dessein : la fenêtre ne se voile qu'à partir de celle-ci, jamais
///   pendant la boîte — l'utilisateur peut y rester une minute, ou renoncer.
#[tauri::command]
pub async fn choose_export_path(
  app: tauri::AppHandle,
  targets: State<'_, ExportTargets>,
  id: String,
  date: String,
  format: ExportFormat,
  documents: State<'_, Documents>,
) -> Result<bool, AppError> {
  let document = documents.get(&id)?;
  let name = file_name(&document.title, &date, format);
  let asked = app.clone();
  let Some(path) = off_thread(move || ask_where(&asked, &name)).await? else {
    return Ok(false);
  };
  targets.remember(&id, path);
  Ok(true)
}

/// Rend le document et l'écrit à l'emplacement choisi. Voir [`choose_export_path`].
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un document inconnu ou sans emplacement choisi,
/// [`AppError::Io`] si le rendu ou l'écriture échoue.
///
/// # Pièges
///
/// - ⚠️ Le dossier n'est retenu qu'après une écriture réussie : mémoriser celui d'un export en
///   échec proposerait ensuite un emplacement dont on sait qu'il ne marche pas.
/// - ⚠️ Garder le travail hors du fil de l'IPC : le rendu traverse tout le document.
#[tauri::command]
pub async fn export_document(
  app: tauri::AppHandle,
  targets: State<'_, ExportTargets>,
  request: ExportRequest,
  documents: State<'_, Documents>,
) -> Result<(), AppError> {
  let document = documents.get(&request.id)?;
  let path = targets.take(&request.id)?;
  let format = request.format;
  let paragraphs = request.paragraphs;
  let target = path.clone();

  off_thread(move || {
    let rendering = render::Rendering::of(&document.transcript, paragraphs);
    if format.is_native() {
      let payload = render::pdf_payload(&document.title, &rendering)?;
      let path = target.to_str().ok_or_else(|| {
        AppError::InvalidArgument("le chemin d'export n'est pas de l'UTF-8".into())
      })?;
      native::export_pdf(&payload, path)
    } else {
      let bytes = render::bytes(format, &document.title, &rendering)?;
      render::write(&target, &bytes)
    }
  })
  .await?;

  remember_directory(&app, &path);
  // ⚠️ On journalise aussi le succès : sans cela, « la commande n'a pas été appelée » et « elle
  // a rendu Ok, et aucun fichier n'est apparu » seraient indiscernables. Le format suffit à
  // situer — ni le chemin, ni le titre, qui sont du contenu utilisateur.
  log::debug!("export écrit ({})", format.extension());
  Ok(())
}

/// Place le document dans le presse-papiers, **en deux représentations** : HTML et Markdown.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un document inconnu, [`AppError::Native`] si le pont
/// refuse d'écrire dans le presse-papiers.
///
/// # Pièges
///
/// - ⚠️ Le presse-papiers n'est pas restauré : ici, c'est l'utilisateur qui demande à copier.
/// - ⚠️ On copie ce qui est affiché, traduction comprise : coller une autre langue que celle
///   qu'on vient de lire serait le même défaut que sur l'export.
#[tauri::command]
pub async fn copy_document(
  request: CopyRequest,
  documents: State<'_, Documents>,
) -> Result<(), AppError> {
  let document = documents.get(&request.id)?;
  let paragraphs = request.paragraphs;

  off_thread(move || {
    let rendering = render::Rendering::of(&document.transcript, paragraphs);
    let (html, markdown) = render::clipboard(&document.title, &rendering);
    native::copy_rich_text(&html, &markdown)
  })
  .await?;

  log::debug!("document copié dans le presse-papiers");
  Ok(())
}

/// Ce qu'une fenêtre-session exporte : **ce qu'elle affiche**.
///
/// # Pièges
///
/// - ⚠️ Pas de troisième choix « les deux » : la barre d'actions est partagée par les deux vues,
///   et chaque contrôle veut dire ce qu'il dit **pour la vue où l'on est**. Un choix de plus
///   redemanderait ce que l'écran affiche déjà.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveContent {
  /// Le transcript de la session.
  Transcript,
  /// Le compte rendu produit par le modèle.
  Report,
}

/// Ce qu'il faut pour écrire l'export d'une session.
///
/// # Pièges
///
/// - ⚠️ `title` voyage, il ne se relit pas : une session sans titre s'appelle « Session du
///   5 août à 16:12 », phrase localisée que seule l'interface sait composer, quand le document
///   porte `None`. Le relire ici nommerait tous les exports non renommés « Mirmalion ».
/// - ⚠️ `paragraphs` et `sections` portent ce que l'écran montre, traduction comprise ; `None`
///   veut dire « rien à substituer », et on relit alors le document. Sans eux, l'écran
///   montrerait de l'anglais pendant que le fichier sortirait en français.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveExportRequest {
  /// L'identifiant du document de session.
  pub id: String,
  /// La vue à exporter ; elle désigne lequel de `paragraphs` et `sections` sert.
  pub content: LiveContent,
  /// Le format demandé.
  pub format: ExportFormat,
  /// Le titre **résolu par l'interface**.
  pub title: String,
  /// Le transcript **tel qu'il est affiché**, ou `None` pour relire celui du document.
  #[serde(default)]
  pub paragraphs: Option<Vec<RenderedParagraph>>,
  /// Le compte rendu **tel qu'il est affiché**, ou `None` pour relire celui du document.
  #[serde(default)]
  pub sections: Option<Vec<ReportSection>>,
}

/// Ce qu'il faut pour copier une session dans le presse-papiers.
///
/// # Pièges
///
/// - ⚠️ Les mêmes champs affichés que [`LiveExportRequest`], et pour la même raison en pire : le
///   presse-papiers ne montre rien avant qu'on l'ait collé ailleurs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveCopyRequest {
  /// L'identifiant du document de session.
  pub id: String,
  /// La vue à copier ; elle désigne lequel de `paragraphs` et `sections` sert.
  pub content: LiveContent,
  /// Le titre **résolu par l'interface**.
  pub title: String,
  /// Le transcript **tel qu'il est affiché**, ou `None` pour relire celui du document.
  #[serde(default)]
  pub paragraphs: Option<Vec<RenderedParagraph>>,
  /// Le compte rendu **tel qu'il est affiché**, ou `None` pour relire celui du document.
  #[serde(default)]
  pub sections: Option<Vec<ReportSection>>,
}

/// Ouvre « Enregistrer sous » pour cette session et retient l'emplacement. `false` = renoncement.
///
/// # Errors
///
/// Rend [`AppError::Io`] si le dossier à proposer est introuvable.
///
/// # Pièges
///
/// - ⚠️ `title` et `date` arrivent résolus : ce sont des textes localisés, et Rust n'en fabrique
///   aucun — il les assainit et les assemble.
/// - ⚠️ Séparée de l'écriture pour les mêmes raisons que [`choose_export_path`].
#[tauri::command]
pub async fn choose_live_export_path(
  app: tauri::AppHandle,
  targets: State<'_, ExportTargets>,
  id: String,
  title: String,
  date: String,
  format: ExportFormat,
) -> Result<bool, AppError> {
  let name = file_name(&title, &date, format);
  let asked = app.clone();
  let Some(path) = off_thread(move || ask_where(&asked, &name)).await? else {
    return Ok(false);
  };
  targets.remember(&id, path);
  Ok(true)
}

/// Rend la session — **son transcript ou son compte rendu** — et l'écrit à l'emplacement choisi.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un document inconnu ou sans emplacement choisi,
/// [`AppError::Io`] si le rendu ou l'écriture échoue.
///
/// # Pièges
///
/// - ⚠️ Le dossier n'est retenu qu'après une écriture réussie, comme pour les fichiers.
#[tauri::command]
pub async fn export_live_document(
  app: tauri::AppHandle,
  targets: State<'_, ExportTargets>,
  request: LiveExportRequest,
  documents: State<'_, crate::live::documents::LiveDocuments>,
) -> Result<(), AppError> {
  let document = documents.get(&request.id)?;
  let path = targets.take(&request.id)?;
  let format = request.format;
  let content = request.content;
  let title = request.title;
  // ⚠️ Ce que l'écran montre l'emporte sur ce que le document porte, mais le document reste lu
  // dans tous les cas : sa langue reste la sienne, une traduction ne remplace que du texte.
  let paragraphs = request.paragraphs;
  let sections = request.sections.unwrap_or(document.report);
  let target = path.clone();

  off_thread(move || {
    let native_path = || {
      target
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::InvalidArgument("le chemin d'export n'est pas de l'UTF-8".into()))
    };
    match (content, format.is_native()) {
      (LiveContent::Transcript, true) => {
        let rendering = render::Rendering::of(&document.transcript, paragraphs);
        native::export_pdf(&render::pdf_payload(&title, &rendering)?, &native_path()?)
      }
      (LiveContent::Transcript, false) => {
        let rendering = render::Rendering::of(&document.transcript, paragraphs);
        render::write(&target, &render::bytes(format, &title, &rendering)?)
      }
      (LiveContent::Report, true) => native::export_pdf(
        &render::report_pdf_payload(&title, &sections)?,
        &native_path()?,
      ),
      (LiveContent::Report, false) => {
        render::write(&target, &render::report_bytes(format, &title, &sections)?)
      }
    }
  })
  .await?;

  remember_directory(&app, &path);
  // ⚠️ On journalise aussi le succès — ni le chemin, ni le titre, qui sont du contenu
  // utilisateur. Le format et le contenu suffisent à situer.
  log::debug!(
    "export de session écrit ({}, {content:?})",
    format.extension()
  );
  Ok(())
}

/// Place la session dans le presse-papiers, **en deux représentations** : HTML et Markdown.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] sur un document inconnu, [`AppError::Native`] si le pont
/// refuse d'écrire dans le presse-papiers.
#[tauri::command]
pub async fn copy_live_document(
  request: LiveCopyRequest,
  documents: State<'_, crate::live::documents::LiveDocuments>,
) -> Result<(), AppError> {
  let document = documents.get(&request.id)?;
  let title = request.title;
  let content = request.content;
  let paragraphs = request.paragraphs;
  let sections = request.sections.unwrap_or(document.report);

  off_thread(move || {
    let (html, markdown) = match content {
      LiveContent::Transcript => render::clipboard(
        &title,
        &render::Rendering::of(&document.transcript, paragraphs),
      ),
      LiveContent::Report => render::report_clipboard(&title, &sections),
    };
    native::copy_rich_text(&html, &markdown)
  })
  .await?;

  log::debug!("session copiée dans le presse-papiers ({content:?})");
  Ok(())
}

/// Le chemin d'écriture, validé et débarrassé de ses blancs de bordure.
///
/// # Errors
///
/// Rend [`AppError::Io`] si le dossier proposé est introuvable.
///
/// # Pièges
///
/// - ⚠️ **Le chemin naît ici et ne traverse jamais l'IPC.** C'est tout l'objet de cette
///   fonction : le webview demande un export, il ne désigne pas de fichier.
/// - ⚠️ Bloquant sans délai — il attend l'utilisateur, qui peut rester une minute devant la
///   boîte ou renoncer. `off_thread`, jamais le fil de l'IPC.
fn ask_where(app: &tauri::AppHandle, name: &str) -> Result<Option<PathBuf>, AppError> {
  let directory = default_directory(app)?;
  let chosen = app
    .dialog()
    .file()
    .set_directory(&directory)
    .set_file_name(name)
    .blocking_save_file();
  Ok(chosen.and_then(|path| path.into_path().ok()))
}

/// Le dossier à proposer : **le dernier utilisé**, ou les Téléchargements au premier export.
///
/// # Errors
///
/// Rend [`AppError::Io`] si le dossier Téléchargements est introuvable.
fn default_directory(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
  let downloads = app
    .path()
    .download_dir()
    .map_err(|error| AppError::Io(format!("dossier Téléchargements introuvable : {error}")))?;
  Ok(choose_directory(remembered_directory(app), downloads))
}

/// Le dernier dossier **s'il existe encore**, sinon celui proposé par défaut.
///
/// # Pièges
///
/// - ⚠️ Un dossier mémorisé peut avoir disparu — clé USB débranchée, dossier renommé —, et le
///   proposer quand même ouvrirait la boîte de dialogue sur un emplacement mort.
fn choose_directory(remembered: Option<PathBuf>, downloads: PathBuf) -> PathBuf {
  remembered
    .filter(|directory| directory.is_dir())
    .unwrap_or(downloads)
}

/// Relit le dernier dossier dans le magasin, ou `None`.
///
/// # Pièges
///
/// - ⚠️ N'échoue jamais : un magasin illisible vaut « aucun dossier retenu », ce qui ramène aux
///   Téléchargements. Un export ne doit pas être refusé parce qu'un fichier de confort est abîmé.
fn remembered_directory(app: &tauri::AppHandle) -> Option<PathBuf> {
  let store = app.store(STORE_FILE).ok()?;
  let value = store.get(LAST_DIRECTORY)?;
  let path = value.as_str()?;
  (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Retient le dossier de l'export qui vient de réussir.
///
/// # Pièges
///
/// - ⚠️ Un échec d'écriture du magasin est avalé : le fichier est écrit, l'export a réussi, et
///   remonter une erreur ferait croire le contraire pour un simple confort de la fois suivante.
fn remember_directory(app: &tauri::AppHandle, path: &Path) {
  let Some(directory) = path.parent() else {
    return;
  };
  let Ok(store) = app.store(STORE_FILE) else {
    log::warn!("le dernier dossier d'export n'a pas pu être retenu");
    return;
  };
  store.set(LAST_DIRECTORY, directory.to_string_lossy().into_owned());
  if store.save().is_err() {
    log::warn!("le dernier dossier d'export n'a pas pu être enregistré");
  }
}

#[cfg(test)]
mod tests {
  use super::{
    CopyRequest, ExportRequest, ExportTargets, LiveContent, LiveCopyRequest, LiveExportRequest,
    choose_directory,
  };
  use crate::export::format::ExportFormat;
  use std::path::PathBuf;

  /// La forme exacte que le frontend envoie — un champ mal orthographié y devient une erreur de
  /// désérialisation, pas un export silencieusement vide.
  #[test]
  fn an_export_request_is_read_from_camel_case() {
    let request: ExportRequest = serde_json::from_value(serde_json::json!({
      "id": "filedoc-0",
      "format": "plainText",
    }))
    .expect("désérialisation");

    assert_eq!(request.id, "filedoc-0");
    assert_eq!(request.format, ExportFormat::PlainText);
    assert_eq!(
      request.paragraphs, None,
      "sans le champ, on relit le transcript"
    );

    let copy: CopyRequest = serde_json::from_value(serde_json::json!({
      "id": "filedoc-1",
    }))
    .expect("désérialisation");
    assert_eq!(copy.id, "filedoc-1");
    assert_eq!(copy.paragraphs, None);
  }

  /// ⚠️ **Ce que la fenêtre affiche voyage sur les deux requêtes**, en camelCase.
  #[test]
  fn displayed_paragraphs_travel_in_camel_case_on_both_requests() {
    let paragraph = serde_json::json!({
      "startMs": 1_000,
      "endMs": 1_800,
      "text": "Sehr gut.",
    });

    let request: ExportRequest = serde_json::from_value(serde_json::json!({
      "id": "filedoc-0",
      "format": "markdown",
      "paragraphs": [paragraph],
    }))
    .expect("désérialisation");
    let paragraphs = request.paragraphs.expect("des paragraphes affichés");
    assert_eq!(paragraphs.len(), 1);
    assert_eq!(paragraphs[0].text, "Sehr gut.");
    assert_eq!(paragraphs[0].start_ms, 1_000);
    assert_eq!(paragraphs[0].end_ms, 1_800);

    let copy: CopyRequest = serde_json::from_value(serde_json::json!({
      "id": "filedoc-0",
      "paragraphs": [],
    }))
    .expect("désérialisation");
    assert_eq!(
      copy.paragraphs,
      Some(vec![]),
      "une traduction vide n'est pas une absence de traduction"
    );
  }

  /// ⚠️ Les deux champs de locuteurs sont refusés, pas ignorés en silence : un frontend resté en
  /// arrière enverrait encore `labels` et `speakersHidden`, que serde avalerait sans un mot.
  /// C'est `deny_unknown_fields` qui l'empêche, et ce test qui l'exige.
  #[test]
  fn the_former_speaker_fields_are_refused_rather_than_silently_dropped() {
    let refused = serde_json::from_value::<ExportRequest>(serde_json::json!({
      "id": "filedoc-0",
      "format": "markdown",
      "labels": { "0": "Alice" },
    }));
    assert!(refused.is_err(), "« labels » n'existe plus");

    let refused = serde_json::from_value::<CopyRequest>(serde_json::json!({
      "id": "filedoc-0",
      "speakersHidden": true,
    }));
    assert!(refused.is_err(), "« speakersHidden » n'existe plus");
  }

  /// Un paragraphe mal formé est **refusé**, jamais deviné : le webview n'est pas de confiance.
  #[test]
  fn a_malformed_displayed_paragraph_is_refused_rather_than_guessed() {
    let refused = serde_json::from_value::<CopyRequest>(serde_json::json!({
      "id": "filedoc-0",
      "paragraphs": [{ "text": "sans bornes" }],
    }));
    assert!(refused.is_err());
  }

  /// ⚠️ Le contenu est un choix explicite, et le titre arrive résolu : une session sans nom
  /// s'appelle « Session du 5 août à 16:12 », phrase localisée que seule l'interface sait
  /// composer, quand le document porte `None`.
  #[test]
  fn a_live_export_request_names_its_content_and_carries_a_resolved_title() {
    let request: LiveExportRequest = serde_json::from_value(serde_json::json!({
      "id": "directdoc-0",
      "content": "report",
      "format": "docx",
      "title": "Session du 5 août à 16:12",
    }))
    .expect("désérialisation");

    assert_eq!(request.content, LiveContent::Report);
    assert_eq!(request.format, ExportFormat::Docx);
    assert_eq!(request.title, "Session du 5 août à 16:12");

    let copy: LiveCopyRequest = serde_json::from_value(serde_json::json!({
      "id": "directdoc-0",
      "content": "transcript",
      "title": "Point client",
    }))
    .expect("désérialisation");
    assert_eq!(copy.content, LiveContent::Transcript);
  }

  /// ⚠️ **Un contenu inconnu est refusé, jamais deviné** : exporter le transcript quand on a
  /// demandé le compte rendu serait un fichier faux qui a l'air juste.
  #[test]
  fn an_unknown_content_is_refused_rather_than_guessed() {
    let refused = serde_json::from_value::<LiveCopyRequest>(serde_json::json!({
      "id": "directdoc-0",
      "content": "both",
      "title": "T",
    }));
    assert!(
      refused.is_err(),
      "« les deux » n'existe pas — voir LiveContent"
    );
  }

  /// ⚠️ Ce que l'écran montre voyage sur les deux requêtes de session : sans `paragraphs` ni
  /// `sections`, une session traduite s'exporterait dans sa langue d'origine.
  #[test]
  fn a_translated_session_exports_what_the_screen_shows() {
    let request: LiveExportRequest = serde_json::from_value(serde_json::json!({
      "id": "directdoc-0",
      "content": "transcript",
      "format": "markdown",
      "title": "T",
      "paragraphs": [{ "startMs": 0, "endMs": 900, "text": "Good morning" }],
    }))
    .expect("désérialisation");
    let paragraphs = request.paragraphs.expect("un transcript affiché");
    assert_eq!(paragraphs[0].text, "Good morning");
    assert_eq!(
      request.sections, None,
      "sans le champ, on relit le document"
    );

    let copy: LiveCopyRequest = serde_json::from_value(serde_json::json!({
      "id": "directdoc-0",
      "content": "report",
      "title": "T",
      "sections": [{ "heading": "Summary", "lines": ["Two points."], "bullets": false }],
    }))
    .expect("désérialisation");
    let sections = copy.sections.expect("un compte rendu affiché");
    assert_eq!(sections[0].heading, "Summary");
    assert_eq!(copy.paragraphs, None);
  }

  /// ⚠️ **Un contenu affiché mal formé est refusé, jamais deviné** : le webview n'est pas de
  /// confiance, et une rubrique sans ses lignes donnerait un fichier amputé qui a l'air juste.
  #[test]
  fn a_malformed_displayed_section_is_refused_rather_than_guessed() {
    let refused = serde_json::from_value::<LiveCopyRequest>(serde_json::json!({
      "id": "directdoc-0",
      "content": "report",
      "title": "T",
      "sections": [{ "heading": "Résumé" }],
    }));
    assert!(refused.is_err());
  }

  /// **Premier export → Téléchargements**, et c'est aussi ce qui se passe quand le dossier
  /// retenu a disparu.
  #[test]
  fn the_first_export_lands_in_the_downloads_folder() {
    let downloads = PathBuf::from("/Users/x/Downloads");
    assert_eq!(choose_directory(None, downloads.clone()), downloads);
    assert_eq!(
      choose_directory(Some(PathBuf::from("/volume/débranché")), downloads.clone()),
      downloads,
      "un dossier disparu ne se propose pas"
    );
  }

  #[test]
  fn a_remembered_folder_that_still_exists_is_proposed_again() {
    let existing = std::env::temp_dir();
    assert_eq!(
      choose_directory(Some(existing.clone()), PathBuf::from("/Users/x/Downloads")),
      existing
    );
  }

  /// ⚠️ **L'emplacement se consomme.** Sans cela, une fenêtre compromise rejouerait l'écriture
  /// autant de fois qu'elle veut sur le fichier que l'utilisateur a désigné une seule.
  #[test]
  fn a_chosen_place_serves_once_and_then_has_to_be_chosen_again() {
    let targets = ExportTargets::default();
    targets.remember("filedoc-0", PathBuf::from("/tmp/Session.md"));

    assert_eq!(
      targets.take("filedoc-0").expect("un emplacement choisi"),
      PathBuf::from("/tmp/Session.md")
    );
    assert_eq!(
      targets
        .take("filedoc-0")
        .expect_err("le second appel ne doit rien trouver")
        .kind(),
      "invalidArgument"
    );
  }

  /// ⚠️ Écrire sans être passé par la boîte est refusé, et c'est le seul chemin par lequel un
  /// appelant peut y arriver : le webview ne peut pas fabriquer un emplacement.
  #[test]
  fn writing_without_having_asked_is_refused() {
    let targets = ExportTargets::default();
    let error = targets.take("directdoc-7").expect_err("refus attendu");
    assert_eq!(error.kind(), "invalidArgument");
  }

  /// ⚠️ Un document ne peut pas écrire à l'emplacement choisi pour un autre.
  #[test]
  fn each_document_keeps_its_own_place() {
    let targets = ExportTargets::default();
    targets.remember("filedoc-0", PathBuf::from("/tmp/a.md"));
    targets.remember("filedoc-1", PathBuf::from("/tmp/b.md"));

    assert_eq!(
      targets.take("filedoc-1").expect("le sien"),
      PathBuf::from("/tmp/b.md")
    );
    assert_eq!(
      targets.take("filedoc-0").expect("le sien"),
      PathBuf::from("/tmp/a.md")
    );
  }

  /// ⚠️ **Le cœur de la règle : le webview ne désigne aucun fichier.** Le champ n'existe plus,
  /// et `deny_unknown_fields` fait qu'un frontend resté en arrière — ou un webview compromis —
  /// se voit refuser sa requête au lieu de la voir avaler sans le chemin.
  #[test]
  fn a_request_that_names_a_path_is_refused_rather_than_ignored() {
    let refused = serde_json::from_value::<ExportRequest>(serde_json::json!({
      "id": "filedoc-0",
      "format": "markdown",
      "path": "/Users/x/Library/LaunchAgents/x.plist",
    }));
    assert!(refused.is_err(), "un chemin d'écriture ne se dicte plus");

    let refused = serde_json::from_value::<LiveExportRequest>(serde_json::json!({
      "id": "directdoc-0",
      "content": "transcript",
      "format": "markdown",
      "title": "T",
      "path": "/Users/x/.zshrc",
    }));
    assert!(refused.is_err(), "pas davantage pour une session");
  }
}
