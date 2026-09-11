//! Ce qui relie un **document** à un **format** : les octets à écrire, la charge utile du pont,
//! ou les deux représentations du presse-papiers.
//!
//! Les formats texte prennent des *paragraphes rendus* ; le DOCX, le HTML et le PDF prennent des
//! *blocs*. Personne d'autre n'a à savoir lequel prend quoi : ici, un transcript et un format
//! entrent, des octets sortent. `Rendering` est le seul type que les trois entrées prennent, et
//! il porte la réponse à « quel texte ? » — celui du transcript, ou celui de la traduction que la
//! fenêtre montre.
//!
//! # Pièges
//!
//! - ⚠️ Le module reste pur et sans horloge, sauf [`write`] : c'est la seule ligne de tout
//!   l'export à toucher le disque, et elle ne sait rien du contenu qu'elle pose.

use std::path::Path;

use serde::Serialize;

use crate::{
  error::AppError,
  export::{self, Block, docx::docx, format::ExportFormat, html::html},
  live::report::ReportSection,
  transcript::{RenderedParagraph, Transcript},
};

/// Le document à rendre : **son transcript, et les paragraphes à écrire**.
///
/// # Pièges
///
/// - ⚠️ Les deux, et pas seulement les paragraphes : une traduction ne remplace que le texte, la
///   langue du média reste celle du transcript et c'est elle que le JSON écrit sous
///   `sourceLanguage`.
/// - ⚠️ `translated` ne dit pas « les paragraphes sont différents » mais « ces paragraphes ne
///   viennent pas des mots » : ce seul fait décide de la forme du JSON.
pub struct Rendering<'a> {
  transcript: &'a Transcript,
  paragraphs: Vec<RenderedParagraph>,
  translated: bool,
}

impl<'a> Rendering<'a> {
  /// Le document tel qu'il a été transcrit — **le cas de tous les exports jusqu'ici**.
  pub fn original(transcript: &'a Transcript) -> Self {
    Self {
      paragraphs: transcript.rendered(),
      transcript,
      translated: false,
    }
  }

  /// Le document tel que la fenêtre l'affiche : `displayed` porte les paragraphes **traduits**
  /// quand une traduction est active, `None` quand on lit la langue d'origine.
  ///
  /// # Pièges
  ///
  /// - ⚠️ `Some` fait foi, y compris vide : une traduction sans le moindre paragraphe vient d'un
  ///   transcript sans le moindre paragraphe, et la « corriger » en retombant sur l'original
  ///   ferait sortir du texte que l'écran ne montre pas.
  pub fn of(transcript: &'a Transcript, displayed: Option<Vec<RenderedParagraph>>) -> Self {
    match displayed {
      Some(paragraphs) => Self {
        transcript,
        paragraphs,
        translated: true,
      },
      None => Self::original(transcript),
    }
  }
}

/// Ce que Swift reçoit pour rendre un PDF. Miroir d'`ExportPayload` dans
/// `native/Sources/MirmalionNative/DocumentExport.swift`.
///
/// # Pièges
///
/// - ⚠️ Un bloc porte un texte **et** un drapeau `heading` : sans ce bit, un PDF de compte rendu
///   lit « Résumé » et « Décisions » comme du corps de texte.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfPayload<'a> {
  title: &'a str,
  blocks: Vec<Block>,
}

/// Le document rendu dans `format`, **en mémoire**.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] pour le PDF ; le JSON et le DOCX propagent la leur.
///
/// # Pièges
///
/// - ⚠️ Le PDF est refusé ici, et ce n'est pas un oubli : il n'existe jamais comme tampon
///   d'octets, Swift l'écrit page par page dans un contexte attaché au fichier. La commande
///   aiguille sur [`ExportFormat::is_native`] avant d'arriver ici ; l'erreur est le filet.
pub fn bytes(
  format: ExportFormat,
  title: &str,
  document: &Rendering<'_>,
) -> Result<Vec<u8>, AppError> {
  let paragraphs = &document.paragraphs;

  let text = match format {
    ExportFormat::Markdown => export::markdown(title, paragraphs),
    ExportFormat::PlainText => export::plain_text(title, paragraphs),
    ExportFormat::Csv => export::csv(paragraphs),
    // ⚠️ Le seul format qui distingue les deux sources : les mots ne survivent pas à la
    // traduction, et le fichier doit le dire.
    ExportFormat::Json => {
      if document.translated {
        export::translated_json(document.transcript, paragraphs, title)?
      } else {
        export::json(document.transcript, title)?
      }
    }
    ExportFormat::Srt => export::srt(paragraphs),
    ExportFormat::Vtt => export::vtt(paragraphs),
    ExportFormat::Docx => {
      return docx(title, &export::blocks(paragraphs));
    }
    ExportFormat::Pdf => {
      return Err(AppError::InvalidArgument(
        "le PDF ne se rend pas en mémoire : il s'écrit par le pont natif".into(),
      ));
    }
  };
  Ok(text.into_bytes())
}

/// La charge utile JSON du PDF, à passer à `crate::native::export_pdf`.
///
/// # Errors
///
/// Rend [`AppError::Io`] si `serde_json` refuse de sérialiser la charge utile.
pub fn pdf_payload(title: &str, document: &Rendering<'_>) -> Result<String, AppError> {
  let payload = PdfPayload {
    title,
    blocks: export::blocks(&document.paragraphs),
  };
  serde_json::to_string(&payload)
    .map_err(|error| AppError::Io(format!("export PDF impossible : {error}")))
}

// ⚠️ Le compte rendu a trois entrées jumelles, et non des branches dans les premières : il n'a
// ni horodatage, ni traduction affichée, ni sous-titres, et lui faire traverser `Rendering`
// demanderait un champ inutilisé et six `if` — c'est là que se glissent les exports qui écrivent
// le mauvais contenu.

/// Le compte rendu rendu dans `format`, **en mémoire**.
///
/// # Errors
///
/// Rend [`AppError::InvalidArgument`] pour le PDF et les deux sous-titres ; le JSON et le DOCX
/// propagent la leur.
///
/// # Pièges
///
/// - ⚠️ Le PDF n'existe jamais comme tampon, et les sous-titres n'ont aucun sens pour un compte
///   rendu — l'écran les retire du menu. Ces erreurs sont un filet, pas un message à lire.
pub fn report_bytes(
  format: ExportFormat,
  title: &str,
  sections: &[ReportSection],
) -> Result<Vec<u8>, AppError> {
  let text = match format {
    ExportFormat::Markdown => export::report::markdown(title, sections),
    ExportFormat::PlainText => export::report::plain_text(title, sections),
    ExportFormat::Csv => export::report::csv(sections),
    ExportFormat::Json => export::report::json(title, sections)?,
    ExportFormat::Docx => {
      return docx(title, &export::report::blocks(sections));
    }
    ExportFormat::Srt | ExportFormat::Vtt => {
      return Err(AppError::InvalidArgument(
        "un compte rendu n'a aucun timing à porter : ni SRT ni VTT".into(),
      ));
    }
    ExportFormat::Pdf => {
      return Err(AppError::InvalidArgument(
        "le PDF ne se rend pas en mémoire : il s'écrit par le pont natif".into(),
      ));
    }
  };
  Ok(text.into_bytes())
}

/// La charge utile JSON du PDF d'un compte rendu.
///
/// # Errors
///
/// Rend [`AppError::Io`] si `serde_json` refuse de sérialiser la charge utile.
pub fn report_pdf_payload(title: &str, sections: &[ReportSection]) -> Result<String, AppError> {
  let payload = PdfPayload {
    title,
    blocks: export::report::blocks(sections),
  };
  serde_json::to_string(&payload)
    .map_err(|error| AppError::Io(format!("export PDF impossible : {error}")))
}

/// Les **deux** représentations du presse-papiers d'un compte rendu : `(html, markdown)`.
pub fn report_clipboard(title: &str, sections: &[ReportSection]) -> (String, String) {
  (
    html(title, &export::report::blocks(sections)),
    export::report::markdown(title, sections),
  )
}

/// Les **deux** représentations du presse-papiers : `(html, markdown)`.
///
/// # Pièges
///
/// - ⚠️ Deux, jamais une : le HTML pour Mail, Word et Pages, le Markdown pour l'éditeur, le
///   terminal et le champ de saisie. Ne rendre que la première ferait coller du balisage brut
///   dans la moitié des applications, la seconde perdrait le titre en gras dans l'autre moitié.
pub fn clipboard(title: &str, document: &Rendering<'_>) -> (String, String) {
  let paragraphs = &document.paragraphs;
  (
    html(title, &export::blocks(paragraphs)),
    export::markdown(title, paragraphs),
  )
}

/// Pose les octets sur le disque, à l'emplacement choisi par l'utilisateur.
///
/// # Errors
///
/// Rend [`AppError::Io`] si l'écriture échoue.
///
/// # Pièges
///
/// - ⚠️ Le message d'erreur ne nomme jamais le fichier : il remonte jusqu'à une snackbar et
///   jusqu'au journal en développement, et un chemin est du contenu utilisateur.
pub fn write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
  std::fs::write(path, bytes)
    .map_err(|error| AppError::Io(format!("l'export n'a pas pu être écrit : {error}")))
}

#[cfg(test)]
mod tests {
  use super::{Rendering, bytes, clipboard, pdf_payload, write};
  use crate::{
    export::format::ExportFormat,
    transcript::{RenderedParagraph, Transcript, Word},
  };

  fn word(text: &str, start_ms: u64, end_ms: u64) -> Word {
    Word {
      text: text.into(),
      start_ms,
      end_ms,
    }
  }

  /// Deux paragraphes, séparés par un silence — la seule frontière du modèle.
  fn transcript() -> Transcript {
    Transcript::of(
      &[
        word("Bonjour", 0, 500),
        word("Très", 5_000, 5_200),
        word("bien.", 5_200, 5_800),
      ],
      "fr",
    )
  }

  /// Ce que la fenêtre affiche quand une traduction est active : les mêmes bornes, un autre
  /// texte.
  fn translated() -> Vec<RenderedParagraph> {
    vec![
      RenderedParagraph {
        start_ms: 0,
        end_ms: 500,
        text: "Guten Tag".into(),
      },
      RenderedParagraph {
        start_ms: 5_000,
        end_ms: 5_800,
        text: "Sehr gut.".into(),
      },
    ]
  }

  fn text_of(format: ExportFormat) -> String {
    let source = transcript();
    let raw = bytes(format, "Session", &Rendering::original(&source)).expect("rendu");
    String::from_utf8(raw).expect("de l'UTF-8")
  }

  /// Le même rendu, mais sur la **traduction affichée**.
  fn translated_text_of(format: ExportFormat) -> String {
    let source = transcript();
    let raw = bytes(
      format,
      "Session",
      &Rendering::of(&source, Some(translated())),
    )
    .expect("rendu");
    String::from_utf8(raw).expect("de l'UTF-8")
  }

  #[test]
  fn each_textual_format_comes_back_as_its_own_bytes() {
    assert!(text_of(ExportFormat::Markdown).starts_with("# Session"));
    assert!(text_of(ExportFormat::PlainText).starts_with("Session\n"));
    assert!(text_of(ExportFormat::Csv).starts_with("start,text\r\n"));
    assert!(text_of(ExportFormat::Json).contains("\"durationMs\": 5800"));
    assert!(text_of(ExportFormat::Srt).starts_with("1\n00:00:00,000"));
    assert!(text_of(ExportFormat::Vtt).starts_with("WEBVTT\n"));
  }

  #[test]
  fn the_docx_comes_back_as_a_zip() {
    let raw = bytes(
      ExportFormat::Docx,
      "Session",
      &Rendering::original(&transcript()),
    )
    .expect("rendu");
    assert_eq!(&raw[..4], b"PK\x03\x04");
  }

  /// ⚠️ Le filet : le PDF n'existe pas comme tampon d'octets.
  #[test]
  fn the_pdf_refuses_to_be_rendered_in_memory() {
    let error =
      bytes(ExportFormat::Pdf, "R", &Rendering::original(&transcript())).expect_err("refus");
    assert_eq!(error.kind(), "invalidArgument");
    assert!(error.to_string().contains("pont natif"));
  }

  /// ⚠️ **Aucun des huit formats ne nomme plus personne.** Ce module a porté une table de
  /// libellés résolus, une bascule « masquer les locuteurs » et une exception pour le CSV et le
  /// JSON ; ce test empêche l'une d'elles de revenir par un chemin détourné.
  #[test]
  fn no_format_names_anybody() {
    for format in [
      ExportFormat::Markdown,
      ExportFormat::PlainText,
      ExportFormat::Csv,
      ExportFormat::Json,
      ExportFormat::Srt,
      ExportFormat::Vtt,
    ] {
      let text = text_of(format);
      for interdit in ["Locuteur", "speaker", "<v ", " — "] {
        assert!(
          !text.contains(interdit),
          "« {interdit} » ressort de {format:?}"
        );
      }
    }

    let (html, markdown) = clipboard("T", &Rendering::original(&transcript()));
    assert!(!html.contains("<strong>"), "aucun nom en gras dans le HTML");
    assert!(!html.contains("<h2>"), "un transcript n'a pas de rubrique");
    assert!(!markdown.contains(" — "));
  }

  #[test]
  fn the_pdf_payload_carries_the_title_and_the_blocks() {
    let raw = pdf_payload("Session", &Rendering::original(&transcript())).expect("charge utile");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("du JSON valide");

    assert_eq!(value["title"], "Session");
    assert_eq!(value["blocks"][0]["text"], "Bonjour");
    assert_eq!(value["blocks"][1]["text"], "Très bien.");
    assert_eq!(
      value["blocks"][0]["heading"], false,
      "un paragraphe de transcript n'est jamais un titre"
    );
    assert!(
      value["separator"].is_null(),
      "le séparateur est parti avec les locuteurs"
    );
  }

  /// ⚠️ **Deux représentations, jamais une.**
  #[test]
  fn the_clipboard_carries_html_and_markdown_of_the_same_document() {
    let (html, markdown) = clipboard("Session", &Rendering::original(&transcript()));

    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(html.contains("Bonjour"));
    assert_eq!(markdown, "# Session\n\nBonjour\n\nTrès bien.\n");
  }

  // ------------------------------------------------- ce qui est affiché sort

  /// ⚠️ **Le défaut que tout ceci répare** : l'écran montrait de l'allemand, le fichier
  /// sortait en français. Les sept formats non-JSON écrivent le texte affiché, tel quel.
  #[test]
  fn every_format_writes_the_displayed_text_when_a_translation_is_active() {
    for format in [
      ExportFormat::Markdown,
      ExportFormat::PlainText,
      ExportFormat::Csv,
      ExportFormat::Srt,
      ExportFormat::Vtt,
    ] {
      let out = translated_text_of(format);
      assert!(
        out.contains("Guten Tag"),
        "{format:?} garde le texte affiché"
      );
      assert!(
        !out.contains("Bonjour"),
        "{format:?} ne rejoue pas l'original"
      );
    }

    let (html, markdown) = clipboard("Session", &Rendering::of(&transcript(), Some(translated())));
    assert!(html.contains("Guten Tag") && !html.contains("Bonjour"));
    assert!(markdown.contains("Sehr gut.") && !markdown.contains("Très bien."));

    let payload = pdf_payload("Session", &Rendering::of(&transcript(), Some(translated())))
      .expect("charge utile");
    let value: serde_json::Value = serde_json::from_str(&payload).expect("du JSON valide");
    assert_eq!(value["blocks"][0]["text"], "Guten Tag");
  }

  /// ⚠️ **Le seul format qui change de forme** — les mots ne survivent pas à la traduction, et
  /// le fichier doit le dire au lieu de paraître tronqué.
  #[test]
  fn the_json_of_a_translation_announces_itself_and_carries_no_word() {
    let out = translated_text_of(ExportFormat::Json);
    let value: serde_json::Value = serde_json::from_str(&out).expect("du JSON valide");

    assert_eq!(value["translated"], true);
    assert_eq!(value["sourceLanguage"], "fr");
    assert!(
      value["note"]
        .as_str()
        .expect("une note")
        .contains("word-level")
    );
    assert_eq!(value["paragraphs"][0]["text"], "Guten Tag");
    assert!(value["paragraphs"][0]["words"].is_null());

    // L'export d'origine, lui, n'a pas bougé d'un octet.
    let original: serde_json::Value =
      serde_json::from_str(&text_of(ExportFormat::Json)).expect("du JSON valide");
    assert!(original["translated"].is_null());
    assert_eq!(original["language"], "fr");
    assert!(!original["paragraphs"][0]["words"].is_null());
  }

  /// ⚠️ **Sans paragraphes fournis, rien ne change** : c'est le chemin de tous les exports d'un
  /// document non traduit, et il doit rester identique au précédent.
  #[test]
  fn no_displayed_paragraphs_means_the_transcript_is_read_exactly_as_before() {
    let source = transcript();
    let from_none = bytes(
      ExportFormat::Markdown,
      "Session",
      &Rendering::of(&source, None),
    )
    .expect("rendu");
    assert_eq!(
      String::from_utf8(from_none).expect("de l'UTF-8"),
      text_of(ExportFormat::Markdown)
    );
  }

  /// ⚠️ **`Some(vec![])` fait foi** : une traduction vide vient d'un transcript vide, et
  /// retomber sur l'original ferait sortir du texte que l'écran ne montre pas.
  #[test]
  fn an_empty_translation_is_honoured_rather_than_replaced_by_the_original() {
    let source = transcript();
    let raw = bytes(
      ExportFormat::Markdown,
      "Session",
      &Rendering::of(&source, Some(vec![])),
    )
    .expect("rendu");
    assert_eq!(String::from_utf8(raw).expect("de l'UTF-8"), "# Session\n");
  }

  /// ⚠️ **La langue du MÉDIA reste celle du transcript**, même quand les paragraphes viennent
  /// d'ailleurs : c'est elle que le JSON traduit écrit sous `sourceLanguage`, et la déduire du
  /// texte affiché n'aurait aucun sens.
  #[test]
  fn the_source_language_stays_that_of_the_transcript() {
    let value: serde_json::Value =
      serde_json::from_str(&translated_text_of(ExportFormat::Json)).expect("du JSON valide");
    assert_eq!(value["sourceLanguage"], "fr");
  }

  // ------------------------------------------------------ le compte rendu

  fn sections() -> Vec<crate::live::report::ReportSection> {
    vec![
      crate::live::report::ReportSection {
        heading: "Résumé".into(),
        lines: vec!["Point hebdomadaire.".into()],
        bullets: false,
      },
      crate::live::report::ReportSection {
        heading: "Tâches".into(),
        lines: vec!["Corriger les bugs.".into()],
        bullets: true,
      },
    ]
  }

  fn report_text_of(format: ExportFormat) -> String {
    let raw = super::report_bytes(format, "Point produit", &sections()).expect("rendu");
    String::from_utf8(raw).expect("de l'UTF-8")
  }

  #[test]
  fn each_report_format_comes_back_as_its_own_bytes() {
    assert!(report_text_of(ExportFormat::Markdown).starts_with("# Point produit"));
    assert!(report_text_of(ExportFormat::PlainText).starts_with("Point produit\n"));
    assert!(report_text_of(ExportFormat::Csv).starts_with("section,line\r\n"));
    assert!(report_text_of(ExportFormat::Json).contains("\"sections\""));

    let raw = super::report_bytes(ExportFormat::Docx, "P", &sections()).expect("rendu");
    assert_eq!(&raw[..4], b"PK\x03\x04");
  }

  /// ⚠️ **Un compte rendu n'a aucun timing, donc ni SRT ni VTT.**
  ///
  /// L'écran retire déjà les deux entrées du menu ; ceci est le filet, et il refuse **avant**
  /// d'écrire un fichier que le lecteur accepterait et qui ne montrerait rien.
  #[test]
  fn a_report_refuses_the_two_subtitle_formats() {
    for format in [ExportFormat::Srt, ExportFormat::Vtt] {
      let error = super::report_bytes(format, "P", &sections()).expect_err("refus");
      assert_eq!(error.kind(), "invalidArgument");
      assert!(error.to_string().contains("timing"));
    }
  }

  #[test]
  fn a_report_pdf_refuses_to_be_rendered_in_memory() {
    let error = super::report_bytes(ExportFormat::Pdf, "P", &sections()).expect_err("refus");
    assert!(error.to_string().contains("pont natif"));
  }

  /// ⚠️ **C'est le drapeau `heading` qui traverse le pont**, et lui seul qui fera d'une
  /// rubrique autre chose qu'un paragraphe dans le PDF.
  #[test]
  fn the_report_pdf_payload_marks_its_headings() {
    let raw = super::report_pdf_payload("Point produit", &sections()).expect("charge utile");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("du JSON valide");

    assert_eq!(value["title"], "Point produit");
    assert_eq!(value["blocks"][0]["text"], "Résumé");
    assert_eq!(value["blocks"][0]["heading"], true);
    assert_eq!(value["blocks"][1]["heading"], false);
    assert_eq!(value["blocks"][3]["text"], "- Corriger les bugs.");
  }

  #[test]
  fn the_report_clipboard_carries_html_headings_and_markdown() {
    let (html, markdown) = super::report_clipboard("Point produit", &sections());

    assert!(html.contains("<h1>Point produit</h1>"));
    assert!(html.contains("<h2>Résumé</h2>"));
    assert!(markdown.starts_with("# Point produit\n\n## Résumé"));
  }

  #[test]
  fn writing_puts_the_bytes_where_they_were_asked_for() {
    let directory = std::env::temp_dir().join(format!("mirmalion-render-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("dossier");
    let path = directory.join("export.md");
    write(&path, b"contenu").expect("écriture");
    assert_eq!(
      std::fs::read_to_string(&path).expect("relecture"),
      "contenu"
    );
    std::fs::remove_dir_all(&directory).expect("ménage");
  }

  /// ⚠️ **Le message d'erreur ne nomme jamais le fichier** — il remonte jusqu'à une snackbar, et
  /// un chemin est du contenu utilisateur.
  #[test]
  fn a_failed_write_names_what_failed_and_never_the_file() {
    let error = write(std::path::Path::new("/introuvable/export.md"), b"x").expect_err("échec");
    assert_eq!(error.kind(), "io");
    assert!(
      error
        .to_string()
        .starts_with("l'export n'a pas pu être écrit")
    );
    assert!(!error.to_string().contains("/introuvable"));
  }
}
