//! Les huit formats du sélecteur « Exporter », et l'extension de chacun.
//!
//! # Pièges
//!
//! - ⚠️ C'est le backend qui dicte les extensions, pas le frontend — même raison que pour les
//!   extensions de médias (module `media`) : deux listes finissent toujours par diverger, et ce
//!   jour-là « Enregistrer sous » propose un nom que le module d'écriture ne sait pas produire.
//! - ⚠️ `Pdf` n'est pas un format comme les autres, et c'est visible dans le type : les sept
//!   autres reviennent en mémoire sous forme d'octets, le PDF s'écrit page par page dans un
//!   contexte natif attaché à un fichier et n'existe jamais comme tampon. D'où
//!   `ExportFormat::is_native`, que la commande interroge pour choisir sa voie.

use serde::{Deserialize, Serialize};

/// Un format d'export. Les libellés du fil sont ceux de la maquette (`#fd-export`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
  /// Markdown, avec son titre en tête. Extension `md`.
  Markdown,
  /// Texte brut, titre en tête et sans balisage. Extension `txt`.
  PlainText,
  /// CSV, une ligne par élément du document. Extension `csv`.
  Csv,
  /// JSON, la structure du document telle que le rendu la porte. Extension `json`.
  Json,
  /// Sous-titres SubRip, horodatés. Extension `srt`.
  Srt,
  /// Sous-titres WebVTT, horodatés. Extension `vtt`.
  Vtt,
  /// PDF, le seul format écrit côté natif. Extension `pdf`.
  Pdf,
  /// Document Word. Extension `docx`.
  Docx,
}

impl ExportFormat {
  /// L'extension, **sans le point**.
  pub fn extension(self) -> &'static str {
    match self {
      Self::Markdown => "md",
      Self::PlainText => "txt",
      Self::Csv => "csv",
      Self::Json => "json",
      Self::Srt => "srt",
      Self::Vtt => "vtt",
      Self::Pdf => "pdf",
      Self::Docx => "docx",
    }
  }

  /// Ce format se rend-il **côté natif**, dans un fichier qu'il écrit lui-même ?
  pub fn is_native(self) -> bool {
    matches!(self, Self::Pdf)
  }

  /// Ce format porte-t-il des **timecodes** ?
  ///
  /// # Pièges
  ///
  /// - ⚠️ Les sous-titres ne se proposent pas pour un compte rendu : un résumé n'a aucun timing
  ///   à porter, et un SRT dont tous les repères vaudraient `00:00:00` serait un fichier que le
  ///   lecteur accepte et qui ne montre rien.
  pub fn is_subtitle(self) -> bool {
    matches!(self, Self::Srt | Self::Vtt)
  }
}

#[cfg(test)]
mod tests {
  use super::ExportFormat;

  /// Les huit formats de la maquette, dans l'ordre du sélecteur.
  fn all() -> [ExportFormat; 8] {
    [
      ExportFormat::Csv,
      ExportFormat::Json,
      ExportFormat::Markdown,
      ExportFormat::Pdf,
      ExportFormat::Srt,
      ExportFormat::Vtt,
      ExportFormat::PlainText,
      ExportFormat::Docx,
    ]
  }

  #[test]
  fn every_format_has_its_own_extension() {
    let mut extensions: Vec<&str> = all().iter().map(|format| format.extension()).collect();
    extensions.sort_unstable();
    assert_eq!(
      extensions,
      ["csv", "docx", "json", "md", "pdf", "srt", "txt", "vtt"]
    );
  }

  /// Le contrat de fil, tel que le frontend l'écrit. Le renommer casserait tous les appelants.
  #[test]
  fn the_wire_contract_is_camel_case() {
    for (format, written) in [
      (ExportFormat::Markdown, "\"markdown\""),
      (ExportFormat::PlainText, "\"plainText\""),
      (ExportFormat::Csv, "\"csv\""),
      (ExportFormat::Json, "\"json\""),
      (ExportFormat::Srt, "\"srt\""),
      (ExportFormat::Vtt, "\"vtt\""),
      (ExportFormat::Pdf, "\"pdf\""),
      (ExportFormat::Docx, "\"docx\""),
    ] {
      assert_eq!(
        serde_json::to_string(&format).expect("sérialisation"),
        written
      );
      assert_eq!(
        serde_json::from_str::<ExportFormat>(written).expect("désérialisation"),
        format
      );
    }
  }

  #[test]
  fn an_unknown_format_is_refused_rather_than_guessed() {
    assert!(serde_json::from_str::<ExportFormat>("\"pages\"").is_err());
  }

  /// **Seul le PDF** s'écrit côté natif : c'est ce qui aiguille la commande d'export.
  #[test]
  fn the_pdf_is_the_only_natively_written_format() {
    for format in all() {
      assert_eq!(format.is_native(), format == ExportFormat::Pdf);
    }
  }

  #[test]
  fn only_the_two_subtitle_formats_carry_timecodes() {
    for format in all() {
      let expected = matches!(format, ExportFormat::Srt | ExportFormat::Vtt);
      assert_eq!(format.is_subtitle(), expected);
    }
  }
}
