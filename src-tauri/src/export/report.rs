//! Les formats d'export d'un **compte rendu** — purs, sans I/O, sans horloge.
//!
//! Un transcript est une suite de paragraphes horodatés ; un compte rendu est une suite de
//! rubriques, chacune en paragraphe ou en puces, sans le moindre timecode. Les deux ne partagent
//! ni leur forme, ni leurs formats offerts, ni leur JSON — d'où un module à côté plutôt que des
//! `if` dans le premier. Le CSV rend `section,line` : une ligne par élément, sa rubrique en
//! première colonne, ce qu'un tableur trie, filtre et pivote.
//!
//! # Pièges
//!
//! - ⚠️ Ni SRT ni VTT : un compte rendu n'a aucun timing, et un `.srt` dont tous les repères
//!   vaudraient `00:00:00` serait un fichier que le lecteur accepte et qui ne montre rien.
//! - ⚠️ Il n'y a **pas de tâche** dans le modèle, donc pas de CSV des tâches : rien ne distingue
//!   une tâche d'un point clé, et reconnaître la rubrique à son intitulé comparerait du texte
//!   produit par un modèle à un mot traduit dans six langues.

use serde::Serialize;

use crate::{
  error::AppError,
  export::{Block, document, field},
  live::report::ReportSection,
};

/// L'export **Markdown** : le titre du document, puis une rubrique par section.
///
/// # Pièges
///
/// - ⚠️ `##` pour une rubrique : `#` est pris par le titre du document, et deux `#` de même
///   niveau dans un fichier feraient deux documents.
pub fn markdown(title: &str, sections: &[ReportSection]) -> String {
  let mut blocks: Vec<String> = Vec::new();
  if !title.is_empty() {
    blocks.push(format!("# {title}"));
  }
  for section in sections {
    blocks.push(format!("## {}", section.heading));
    blocks.push(lines(section, "- "));
  }
  document(blocks)
}

/// L'export **texte brut** : la même structure, **sans balisage**.
///
/// # Pièges
///
/// - ⚠️ Les puces gardent leur tiret, le paragraphe n'en a pas : c'est la seule différence de
///   forme qui survive au texte brut, et une liste collée dans un message doit rester une liste.
pub fn plain_text(title: &str, sections: &[ReportSection]) -> String {
  let mut blocks: Vec<String> = Vec::new();
  if !title.is_empty() {
    blocks.push(title.to_owned());
  }
  for section in sections {
    blocks.push(section.heading.clone());
    blocks.push(lines(section, "- "));
  }
  document(blocks)
}

/// L'export **CSV**, conforme à la **RFC 4180** : `section,line`, en-tête compris.
///
/// # Pièges
///
/// - ⚠️ L'en-tête est en anglais et ne se localise pas, comme celui du transcript : c'est un
///   format de machine, et traduire ses colonnes rendrait un fichier français illisible par un
///   script écrit sur un anglais.
/// - ⚠️ Une ligne par élément, jamais une par rubrique : c'est ce qui rend le fichier triable et
///   filtrable. Une rubrique en paragraphes rend autant de lignes qu'elle en a.
pub fn csv(sections: &[ReportSection]) -> String {
  // ⚠️ CRLF, pas LF : la RFC 4180 l'exige, et c'est ce qu'attendent Excel et Numbers.
  let mut out = String::from("section,line\r\n");
  for section in sections {
    for line in &section.lines {
      out.push_str(&field(&section.heading));
      out.push(',');
      out.push_str(&field(line));
      out.push_str("\r\n");
    }
  }
  out
}

/// Le compte rendu **au complet** en JSON.
///
/// # Errors
///
/// Rend [`AppError::Io`] si `serde_json` refuse de sérialiser le document.
///
/// # Pièges
///
/// - ⚠️ Pas de `words`, pas de `durationMs`, aucun timing — contrairement au JSON d'un
///   transcript. Un compte rendu n'en a pas, et en écrire à zéro laisserait croire à une perte.
pub fn json(title: &str, sections: &[ReportSection]) -> Result<String, AppError> {
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  struct Document<'a> {
    title: &'a str,
    sections: &'a [ReportSection],
  }

  serde_json::to_string_pretty(&Document { title, sections })
    .map_err(|error| AppError::Io(format!("export JSON impossible : {error}")))
}

/// La vue en blocs, pour le DOCX, le HTML et le PDF.
///
/// # Pièges
///
/// - ⚠️ C'est ici que les rubriques deviennent des titres, et la seule raison pour laquelle
///   [`Block`] porte un drapeau : un PDF où « Résumé » se lit comme du corps de texte n'est plus
///   un document.
/// - ⚠️ Une puce garde son tiret dans ces formats aussi : ni le DOCX ni le PDF ne reçoivent de
///   vraie liste à puces, et le tiret dit la même chose sans pouvoir se désaligner.
pub fn blocks(sections: &[ReportSection]) -> Vec<Block> {
  let mut out: Vec<Block> = Vec::new();
  for section in sections {
    out.push(Block::heading(section.heading.clone()));
    for line in &section.lines {
      out.push(Block::body(if section.bullets {
        format!("- {line}")
      } else {
        line.clone()
      }));
    }
  }
  out
}

/// Les lignes d'une rubrique, en un bloc — préfixées quand ce sont des puces.
fn lines(section: &ReportSection, marker: &str) -> String {
  section
    .lines
    .iter()
    .map(|line| {
      if section.bullets {
        format!("{marker}{line}")
      } else {
        line.clone()
      }
    })
    .collect::<Vec<_>>()
    .join("\n")
}

#[cfg(test)]
mod tests {
  use super::{blocks, csv, json, markdown, plain_text};
  use crate::live::report::ReportSection;

  fn sections() -> Vec<ReportSection> {
    vec![
      ReportSection {
        heading: "Résumé".into(),
        lines: vec!["Point hebdomadaire produit.".into()],
        bullets: false,
      },
      ReportSection {
        heading: "Tâches".into(),
        lines: vec![
          "Corriger les deux bugs.".into(),
          "Boucler les tests.".into(),
        ],
        bullets: true,
      },
    ]
  }

  #[test]
  fn the_markdown_gives_the_document_a_title_and_each_section_a_heading() {
    assert_eq!(
      markdown("Point produit", &sections()),
      "# Point produit\n\n## Résumé\n\nPoint hebdomadaire produit.\n\n## Tâches\n\n\
       - Corriger les deux bugs.\n- Boucler les tests.\n"
    );
  }

  /// ⚠️ **Les puces gardent leur tiret, le paragraphe n'en a pas** : une liste collée dans un
  /// message doit rester une liste.
  #[test]
  fn the_plain_text_keeps_the_only_shape_that_carries_meaning() {
    assert_eq!(
      plain_text("Point produit", &sections()),
      "Point produit\n\nRésumé\n\nPoint hebdomadaire produit.\n\nTâches\n\n\
       - Corriger les deux bugs.\n- Boucler les tests.\n"
    );
  }

  /// ⚠️ **Sans titre, pas de ligne vide en tête** : c'est le cas de la copie au presse-papier.
  #[test]
  fn an_empty_title_disappears_rather_than_leaving_a_blank_line() {
    assert!(plain_text("", &sections()).starts_with("Résumé\n"));
    assert!(markdown("", &sections()).starts_with("## Résumé"));
  }

  /// ⚠️ **Une ligne par élément, sa rubrique en première colonne.** C'est ce qui rend le fichier
  /// triable et filtrable dans un tableur, sans avoir à deviner ce qu'est une tâche.
  #[test]
  fn the_csv_gives_a_row_to_each_line_and_names_its_section() {
    assert_eq!(
      csv(&sections()),
      "section,line\r\n\
       Résumé,Point hebdomadaire produit.\r\n\
       Tâches,Corriger les deux bugs.\r\n\
       Tâches,Boucler les tests.\r\n"
    );
  }

  /// ⚠️ **Le champ qui porte une virgule ou un guillemet est cité**, sinon le tableur décale
  /// toutes les colonnes suivantes.
  #[test]
  fn the_csv_quotes_what_would_break_a_spreadsheet() {
    let dangerous = vec![ReportSection {
      heading: "Décisions".into(),
      lines: vec!["On garde 6 langues, dont le \"portugais\".".into()],
      bullets: true,
    }];
    assert!(csv(&dangerous).contains("\"On garde 6 langues, dont le \"\"portugais\"\".\""));
  }

  /// ⚠️ **Aucun timing dans le JSON d'un compte rendu** : il n'en a pas, et en écrire à zéro
  /// laisserait croire à une perte.
  #[test]
  fn the_json_carries_the_sections_and_no_timing_at_all() {
    let raw = json("Point produit", &sections()).expect("sérialisation");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("du JSON valide");

    assert_eq!(value["title"], "Point produit");
    assert_eq!(value["sections"][1]["heading"], "Tâches");
    assert_eq!(value["sections"][1]["bullets"], true);
    assert_eq!(value["sections"][1]["lines"][0], "Corriger les deux bugs.");
    assert!(value["sections"][0]["startMs"].is_null());
    assert!(!raw.contains("durationMs"));
  }

  /// ⚠️ **Les rubriques deviennent des titres**, et c'est toute la raison du drapeau : un PDF
  /// où « Résumé » se lit comme du corps de texte n'est plus un document.
  #[test]
  fn the_blocks_mark_the_headings_and_only_them() {
    let out = blocks(&sections());

    assert_eq!(out[0].text, "Résumé");
    assert!(out[0].heading);
    assert_eq!(out[1].text, "Point hebdomadaire produit.");
    assert!(!out[1].heading, "un paragraphe n'est pas un titre");
    assert_eq!(out[3].text, "- Corriger les deux bugs.");
    assert!(!out[3].heading);
    assert_eq!(out.len(), 5);
  }

  #[test]
  fn a_report_without_a_section_renders_nothing_but_its_title() {
    assert_eq!(markdown("Vide", &[]), "# Vide\n");
    assert_eq!(csv(&[]), "section,line\r\n");
    assert!(blocks(&[]).is_empty());
  }
}
