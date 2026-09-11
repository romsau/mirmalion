//! L'export **Word (`.docx`)**, écrit par `docx-rs`.
//!
//! Un `.docx` est un zip d'XML dont le compte doit tomber juste sous peine de fichier refusé à
//! l'ouverture ; la caisse s'en charge. La mise en page est arrêtée ici : titre en gras de 20 pt,
//! corps en 11 pt — les mêmes valeurs que le PDF —, rubrique de compte rendu en gras de 13 pt
//! avec un peu plus d'air au-dessus, ce qui la fait lire comme un début de section.
//!
//! # Pièges
//!
//! - ⚠️ Aucun style nommé, que de la mise en forme directe : `Heading1` et consorts n'existent
//!   pas dans le catalogue produit par la caisse, et les employer donnerait un document dont le
//!   rendu dépendrait de la feuille de styles de la machine d'ouverture — quand il ne resterait
//!   pas simplement sans effet.

use std::io::Cursor;

use docx_rs::{Docx, LineSpacing, Paragraph, Run};

use crate::{error::AppError, export::Block};

/// La taille du titre, en **demi-points** — l'unité d'OOXML. 40 = 20 pt.
const TITLE_HALF_POINTS: usize = 40;
/// La taille du corps de texte, en demi-points. 22 = 11 pt.
const BODY_HALF_POINTS: usize = 22;
/// La taille d'une rubrique de compte rendu, en demi-points. 26 = 13 pt.
const HEADING_HALF_POINTS: usize = 26;
/// L'air sous un paragraphe, en **twips** (1/20 de point). 160 = 8 pt.
const PARAGRAPH_SPACING: u32 = 160;
/// L'air sous le titre, en twips. 320 = 16 pt.
const TITLE_SPACING: u32 = 320;
/// L'air **au-dessus** d'une rubrique, en twips. 240 = 12 pt.
const HEADING_SPACING_BEFORE: u32 = 240;

/// Rend le document en `.docx`, **en mémoire**.
///
/// L'écriture sur le disque appartient à la commande : ce module reste pur, comme les formats
/// texte, et se compare donc à un attendu sans toucher au disque.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la caisse ne parvient pas à empaqueter le zip.
pub fn docx(title: &str, blocks: &[Block]) -> Result<Vec<u8>, AppError> {
  let mut document = Docx::new();

  if !title.is_empty() {
    document = document.add_paragraph(
      Paragraph::new()
        .add_run(Run::new().add_text(title).bold().size(TITLE_HALF_POINTS))
        .line_spacing(LineSpacing::new().after(TITLE_SPACING)),
    );
  }

  for block in blocks {
    // ⚠️ Un seul run par paragraphe : une rubrique est en gras tout entière, donc le run unique
    // porte le gras sans risque de déborder sur du corps de texte.
    let paragraph = if block.heading {
      Paragraph::new().line_spacing(
        LineSpacing::new()
          .before(HEADING_SPACING_BEFORE)
          .after(PARAGRAPH_SPACING),
      )
    } else {
      Paragraph::new().line_spacing(LineSpacing::new().after(PARAGRAPH_SPACING))
    };
    document = document.add_paragraph(paragraph.add_run(text_run(block)));
  }

  let mut buffer = Cursor::new(Vec::new());
  document
    .build()
    .pack(&mut buffer)
    .map_err(|error| AppError::Io(format!("export Word impossible : {error}")))?;
  Ok(buffer.into_inner())
}

/// Le run de texte d'un bloc, **sauts de ligne compris**.
///
/// # Pièges
///
/// - ⚠️ Un saut de ligne devient un `<w:br/>`, il ne disparaît pas : OOXML ignore les blancs d'un
///   `<w:t>`, donc laisser le `\n` tel quel collerait deux lignes bout à bout et le document
///   rendu ne dirait plus la même chose que la fenêtre.
fn text_run(block: &Block) -> Run {
  let mut run = if block.heading {
    Run::new().size(HEADING_HALF_POINTS).bold()
  } else {
    Run::new().size(BODY_HALF_POINTS)
  };
  for (index, line) in block.text.lines().enumerate() {
    if index > 0 {
      run = run.add_break(docx_rs::BreakType::TextWrapping);
    }
    run = run.add_text(line);
  }
  run
}

#[cfg(test)]
mod tests {
  use super::docx;
  use crate::export::Block;

  /// Le document **relu depuis le zip**, en JSON.
  ///
  /// ⚠️ **On relit avec le lecteur de la caisse plutôt que d'inspecter le XML à la main**, et
  /// c'est la seule assertion qui vaille quelque chose : elle prouve que le fichier
  /// **s'ouvre**. Un XML qui contient les bons mots dans un zip mal formé passerait un test de
  /// sous-chaînes et échouerait dans Word.
  fn reread(bytes: &[u8]) -> serde_json::Value {
    let document = docx_rs::read_docx(bytes).expect("le .docx doit se relire");
    serde_json::to_value(document).expect("sérialisation")
  }

  /// Les paragraphes du corps, réduits à leur texte.
  fn paragraphs(document: &serde_json::Value) -> Vec<String> {
    document["document"]["children"]
      .as_array()
      .expect("le corps du document")
      .iter()
      .map(|paragraph| {
        paragraph["data"]["children"]
          .as_array()
          .map(|runs| {
            runs
              .iter()
              .map(|run| {
                run["data"]["children"]
                  .as_array()
                  .map(|children| {
                    children
                      .iter()
                      .map(|child| child["data"]["text"].as_str().unwrap_or_default())
                      .collect::<String>()
                  })
                  .unwrap_or_default()
              })
              .collect::<String>()
          })
          .unwrap_or_default()
      })
      .collect()
  }

  /// ⚠️ **Un `.docx` est un zip**, et c'est vérifiable à l'octet près : `PK\x03\x04`. Un
  /// fichier qui ne commence pas par là ne s'ouvrira nulle part.
  #[test]
  fn the_file_is_a_zip_that_reopens_as_a_document() {
    let bytes = docx("Session", &[Block::body("Bonjour")]).expect("rendu");
    assert_eq!(&bytes[..4], b"PK\x03\x04");
    assert!(reread(&bytes)["document"]["children"].is_array());
  }

  #[test]
  fn the_title_and_every_paragraph_reach_the_document() {
    let bytes = docx(
      "Session",
      &[
        Block::body("Bonjour tout le monde"),
        Block::body("Très bien, merci."),
      ],
    )
    .expect("rendu");

    assert_eq!(
      paragraphs(&reread(&bytes)),
      ["Session", "Bonjour tout le monde", "Très bien, merci."]
    );
  }

  /// ⚠️ **Seul le titre est en gras** : un paragraphe de corps n'a qu'un run, et il est nu.
  #[test]
  fn only_the_title_is_bold_and_a_paragraph_is_a_single_run() {
    let document = reread(&docx("Session", &[Block::body("Bonjour")]).expect("rendu"));
    let titre = document["document"]["children"][0]["data"]["children"]
      .as_array()
      .expect("les runs du titre")
      .clone();
    assert_eq!(titre[0]["data"]["runProperty"]["bold"], true);
    assert_eq!(titre[0]["data"]["runProperty"]["sz"], 40);

    let corps = document["document"]["children"][1]["data"]["children"]
      .as_array()
      .expect("les runs du paragraphe")
      .clone();
    assert_eq!(corps.len(), 1, "un paragraphe est un seul run");
    assert!(corps[0]["data"]["runProperty"]["bold"].is_null());
    assert_eq!(corps[0]["data"]["runProperty"]["sz"], 22);
  }

  /// ⚠️ **Une rubrique de compte rendu est un gras de 13 pt, et c'est tout.** Ni style nommé, ni
  /// niveau de titre Word : de la mise en forme directe, qui rend le même document sur toutes
  /// les machines. Sans elle, un compte rendu exporté lit « Résumé » comme du corps de texte.
  #[test]
  fn a_heading_block_is_bolder_and_larger_than_the_body() {
    let document = reread(
      &docx(
        "Session",
        &[Block::heading("Résumé"), Block::body("Deux points.")],
      )
      .expect("rendu"),
    );

    let rubrique = document["document"]["children"][1]["data"]["children"][0].clone();
    assert_eq!(rubrique["data"]["runProperty"]["bold"], true);
    assert_eq!(rubrique["data"]["runProperty"]["sz"], 26);

    let corps = document["document"]["children"][2]["data"]["children"][0].clone();
    assert!(corps["data"]["runProperty"]["bold"].is_null());
    assert_eq!(corps["data"]["runProperty"]["sz"], 22);
  }

  #[test]
  fn a_document_without_a_title_starts_at_the_first_paragraph() {
    let document = reread(&docx("", &[Block::body("Premier paragraphe")]).expect("rendu"));
    assert_eq!(paragraphs(&document), ["Premier paragraphe"]);
  }

  /// ⚠️ OOXML ignore les blancs d'un `<w:t>` : sans `<w:br/>`, les deux lignes se colleraient.
  #[test]
  fn a_line_break_becomes_a_word_break() {
    let bytes = docx("", &[Block::body("Une ligne\nUne autre")]).expect("rendu");
    let document = reread(&bytes);
    assert_eq!(paragraphs(&document), ["Une ligneUne autre"]);
    assert!(
      serde_json::to_string(&document)
        .expect("sérialisation")
        .contains("\"break\""),
      "le saut de ligne doit voyager comme un saut, pas comme un blanc"
    );
  }

  /// Un export vide reste un document valide : c'est un fichier qu'on ouvre, pas une erreur.
  #[test]
  fn an_empty_document_is_still_a_valid_file() {
    let bytes = docx("", &[]).expect("rendu");
    assert_eq!(&bytes[..4], b"PK\x03\x04");
    assert!(paragraphs(&reread(&bytes)).is_empty());
  }

  #[test]
  fn hostile_text_survives_the_xml_escaping() {
    let bytes = docx("Ünïcode 🎧", &[Block::body("1 < 2 & 3 > 2 漢字")]).expect("rendu");
    assert_eq!(
      paragraphs(&reread(&bytes)),
      ["Ünïcode 🎧", "1 < 2 & 3 > 2 漢字"],
      "les caractères de balisage traversent l'échappement XML sans se déformer"
    );
  }
}
