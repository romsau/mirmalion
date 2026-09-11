//! Le nom de fichier proposé dans « Enregistrer sous » : `{Titre}_{date}.{ext}`.
//!
//! Trois familles de caractères ne peuvent pas entrer dans un nom de fichier macOS, et deux
//! arrivent par la date : `/`, le séparateur de chemins, présent dans la moitié de nos formats
//! de date ; `:`, interdit historiquement et affiché comme `/` par le Finder ; les caractères de
//! contrôle, qu'un copier-coller amène dans un titre sans que l'utilisateur les voie.
//!
//! # Pièges
//!
//! - ⚠️ La date arrive **déjà formatée** de l'appelant : la localisation se fait au build, côté
//!   interface, par `Intl`. Rust n'a ni catalogue de langues ni calendrier, et en écrire un ici
//!   figerait un format américain dans le nom de fichier d'un utilisateur allemand.
//! - ⚠️ Un point en tête se retire : un titre commençant par un point donnerait un fichier
//!   invisible dans le Finder, et l'utilisateur croirait l'export perdu.

use crate::export::format::ExportFormat;

/// Le repli quand il ne reste rien à nommer.
///
/// # Pièges
///
/// - ⚠️ Un nom propre, et c'est le seul choix tenable : « export » ou « document » sont des mots
///   à traduire, et ce module n'a pas le droit de fabriquer du texte localisé. Le nom de
///   l'application est le même dans les six langues.
const FALLBACK: &str = "Mirmalion";

/// La longueur maximale du titre retenue dans le nom, **en caractères**.
///
/// # Pièges
///
/// - ⚠️ macOS refuse un nom de plus de 255 octets, et un titre vaut par défaut le nom du média,
///   qui peut être très long. On coupe le titre plutôt que de laisser l'enregistrement échouer
///   à la fin, quand l'utilisateur a déjà choisi son dossier. La coupe est en caractères, jamais
///   en octets : « é » en pèse deux, et couper entre les deux paniquerait sur une frontière de
///   caractère.
const MAX_TITLE_CHARS: usize = 80;

/// `{Titre}_{date}.{ext}`, assaini et prêt pour la boîte de dialogue.
///
/// `date` est la date **déjà formatée par l'appelant** — voir l'en-tête. Vide, elle disparaît
/// du nom avec son souligné : `Session.md` plutôt que `Session_.md`.
pub fn file_name(title: &str, date: &str, format: ExportFormat) -> String {
  let title = sanitise(title);
  let date = sanitise(date);

  let stem = match (title.is_empty(), date.is_empty()) {
    (true, true) => FALLBACK.to_owned(),
    (true, false) => date,
    (false, true) => title,
    (false, false) => format!("{title}_{date}"),
  };
  format!("{stem}.{}", format.extension())
}

/// Rend un fragment utilisable dans un nom de fichier.
///
/// Les caractères interdits deviennent des tirets — ils ne disparaissent pas : `31/12` doit
/// rester lisible en `31-12`, et non se refermer en `3112`.
fn sanitise(value: &str) -> String {
  let replaced: String = value
    .chars()
    .take(MAX_TITLE_CHARS)
    .map(|character| {
      if character == '/' || character == ':' || character.is_control() {
        '-'
      } else {
        character
      }
    })
    .collect();
  // Les blancs, les points et les tirets de bordure partent en dernier : un titre réduit à
  // « ... » ou à « / » ne doit plus rien laisser, et c'est ce qui déclenche le repli.
  // ⚠️ Les tirets intérieurs restent — `31/12` doit rester lisible en `31-12`.
  replaced
    .trim_matches(|character: char| {
      character.is_whitespace() || character == '.' || character == '-'
    })
    .to_owned()
}

#[cfg(test)]
mod tests {
  use super::{FALLBACK, MAX_TITLE_CHARS, file_name};
  use crate::export::format::ExportFormat;

  #[test]
  fn the_shape_is_title_underscore_date_dot_extension() {
    assert_eq!(
      file_name("Session produit", "3 août 2026", ExportFormat::Markdown),
      "Session produit_3 août 2026.md"
    );
  }

  #[test]
  fn every_format_lands_on_its_own_extension() {
    for (format, expected) in [
      (ExportFormat::Markdown, "T_D.md"),
      (ExportFormat::PlainText, "T_D.txt"),
      (ExportFormat::Csv, "T_D.csv"),
      (ExportFormat::Json, "T_D.json"),
      (ExportFormat::Srt, "T_D.srt"),
      (ExportFormat::Vtt, "T_D.vtt"),
      (ExportFormat::Pdf, "T_D.pdf"),
      (ExportFormat::Docx, "T_D.docx"),
    ] {
      assert_eq!(file_name("T", "D", format), expected);
    }
  }

  /// ⚠️ Un titre qui contient **`/` et `:`**. Sans assainissement, l'enregistrement échoue ou
  /// part dans un autre dossier.
  #[test]
  fn a_title_carrying_a_slash_and_a_colon_is_made_safe() {
    assert_eq!(
      file_name("Entretien 12/03 : bilan", "2026", ExportFormat::Pdf),
      "Entretien 12-03 - bilan_2026.pdf"
    );
  }

  /// La date localisée en porte autant que le titre — `31/12/2026`, `14:32`.
  #[test]
  fn a_localised_date_is_made_file_safe_too() {
    assert_eq!(
      file_name("Session", "31/12/2026 14:32", ExportFormat::Docx),
      "Session_31-12-2026 14-32.docx"
    );
  }

  /// Les dates des six langues d'interface, telles qu'`Intl` les rend, traversent sans perdre
  /// leur lisibilité.
  #[test]
  fn the_nine_interface_date_shapes_stay_readable() {
    for (date, expected) in [
      ("3 août 2026", "T_3 août 2026.md"),
      ("Aug 3, 2026", "T_Aug 3, 2026.md"),
      ("3 de ago de 2026", "T_3 de ago de 2026.md"),
      ("03.08.2026", "T_03.08.2026.md"),
      ("3 ago 2026", "T_3 ago 2026.md"),
      ("03/08/2026", "T_03-08-2026.md"),
      ("2026年8月3日", "T_2026年8月3日.md"),
      ("2026/08/03", "T_2026-08-03.md"),
      ("2026. 8. 3.", "T_2026. 8. 3.md"),
    ] {
      assert_eq!(file_name("T", date, ExportFormat::Markdown), expected);
    }
  }

  /// ⚠️ Un caractère de contrôle n'est pas visible dans le champ de titre, et il casserait
  /// l'écriture aussi sûrement qu'un `/`.
  #[test]
  fn control_characters_never_reach_the_file_system() {
    let name = file_name("Deux\nlignes\ttabulées", "2026", ExportFormat::Json);
    assert_eq!(name, "Deux-lignes-tabulées_2026.json");
    assert!(!name.chars().any(char::is_control));
  }

  /// ⚠️ Un point en tête donnerait un fichier **invisible** : l'utilisateur croirait son export
  /// perdu.
  #[test]
  fn a_leading_dot_would_hide_the_file_and_is_removed() {
    assert_eq!(
      file_name(".caché", "2026", ExportFormat::Csv),
      "caché_2026.csv"
    );
    assert_eq!(file_name("fin.", "2026", ExportFormat::Csv), "fin_2026.csv");
  }

  /// Une date absente ne laisse pas de souligné orphelin.
  #[test]
  fn a_missing_date_takes_its_separator_with_it() {
    assert_eq!(file_name("Session", "", ExportFormat::Vtt), "Session.vtt");
    assert_eq!(
      file_name("Session", "   ", ExportFormat::Vtt),
      "Session.vtt"
    );
  }

  /// Un titre vide — que l'invariant du document interdit, mais qu'un appelant peut envoyer —
  /// laisse la date porter le nom seule.
  #[test]
  fn an_empty_title_leaves_the_date_alone() {
    assert_eq!(
      file_name("", "3 août 2026", ExportFormat::Srt),
      "3 août 2026.srt"
    );
  }

  /// ⚠️ Le seul cas où ce module **nomme** quelque chose : un nom propre, jamais un mot à
  /// traduire.
  #[test]
  fn when_nothing_is_left_to_name_the_application_lends_its_name() {
    for (title, date) in [("", ""), ("/", ":"), ("...", "   "), ("\n", "\t")] {
      assert_eq!(
        file_name(title, date, ExportFormat::Pdf),
        format!("{FALLBACK}.pdf"),
        "pour ({title:?}, {date:?})"
      );
    }
  }

  /// ⚠️ macOS refuse un nom de plus de 255 octets, et la coupe se fait en **caractères** : une
  /// lettre accentuée en pèse deux, et couper entre les deux paniquerait.
  #[test]
  fn a_very_long_title_is_cut_on_a_character_boundary() {
    let long = "é".repeat(200);
    let name = file_name(&long, "2026", ExportFormat::Pdf);
    assert_eq!(name.chars().filter(|c| *c == 'é').count(), MAX_TITLE_CHARS);
    assert!(name.len() < 255, "reçu {} octets", name.len());
    assert!(name.ends_with("_2026.pdf"));
  }
}
