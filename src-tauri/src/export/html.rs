//! Le rendu **HTML** — la représentation riche du presse-papiers.
//!
//! « Copier (presse-papier) » place deux représentations du même document : `text/html` pour
//! Mail, Word ou Pages, et `text/plain` en Markdown pour tout le reste. Ce module rend la
//! première. Il n'apparaît pas dans le sélecteur d'export, et n'a pas à y apparaître.
//!
//! # Pièges
//!
//! - ⚠️ Aucune feuille de style, aucune couleur, aucune police : un fragment collé doit prendre
//!   le style de son hôte. Une police imposée sortirait du corps de texte d'un rapport, et une
//!   couleur survivrait à un passage en thème sombre. On n'écrit que de la structure.
//! - ⚠️ L'esperluette s'échappe en premier : l'échapper après `<` transformerait le `&lt;` qu'on
//!   vient d'écrire en `&amp;lt;` — même piège, même ordre, que l'échappement du WebVTT.

use crate::export::Block;

/// Le document HTML complet : un titre, puis un paragraphe **ou une rubrique** par bloc.
///
/// # Pièges
///
/// - ⚠️ Un document entier, jamais un fragment : c'est ce qu'attend le type `public.html` du
///   presse-papiers, et la balise `charset` est ce qui évite qu'un accent collé dans une
///   application ancienne ressorte en mojibake.
/// - ⚠️ `<h2>` pour une rubrique, jamais un `<p>` en gras : ce qui est collé dans Mail ou Word
///   doit y arriver comme une structure, seule forme à laquelle l'hôte applique ses styles.
pub fn html(title: &str, blocks: &[Block]) -> String {
  let mut out = String::from("<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>");
  out.push_str(&escape(title));
  out.push_str("</title>\n</head>\n<body>\n");

  if !title.is_empty() {
    out.push_str(&format!("<h1>{}</h1>\n", escape(title)));
  }
  for block in blocks {
    let tag = if block.heading { "h2" } else { "p" };
    out.push_str(&format!("<{tag}>"));
    out.push_str(&paragraph(&block.text));
    out.push_str(&format!("</{tag}>\n"));
  }
  out.push_str("</body>\n</html>\n");
  out
}

/// Le texte d'un paragraphe, sauts de ligne compris.
///
/// # Pièges
///
/// - ⚠️ Un saut de ligne devient `<br>`, il ne disparaît pas : le HTML replie les blancs, donc
///   laisser le saut tel quel collerait deux lignes bout à bout et le collage rendrait un texte
///   différent de celui qu'affiche la fenêtre.
fn paragraph(text: &str) -> String {
  text.lines().map(escape).collect::<Vec<_>>().join("<br>\n")
}

/// Les trois caractères que le HTML réserve dans un nœud de texte.
///
/// Les guillemets n'ont pas à être échappés : aucun texte de l'utilisateur n'entre dans un
/// attribut.
///
/// # Pièges
///
/// - ⚠️ L'esperluette d'abord — voir l'en-tête du module.
fn escape(text: &str) -> String {
  text
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
  use super::{escape, html};
  use crate::export::Block;

  #[test]
  fn a_document_is_whole_and_announces_its_encoding() {
    let out = html("Session", &[]);
    assert!(out.starts_with("<!DOCTYPE html>"));
    assert!(out.contains("<meta charset=\"utf-8\">"));
    assert!(out.contains("<title>Session</title>"));
    assert!(out.trim_end().ends_with("</html>"));
  }

  /// ⚠️ **Une rubrique sort en `<h2>`** — une structure, pas un `<p>` en gras : c'est ce qui
  /// permet à Mail ou Word d'y appliquer leur propre feuille de styles.
  #[test]
  fn a_heading_block_becomes_a_real_heading() {
    let out = html(
      "T",
      &[Block::heading("Résumé"), Block::body("Deux points.")],
    );
    assert!(out.contains("<h2>Résumé</h2>"));
    assert!(out.contains("<p>Deux points.</p>"));
    assert!(
      !out.contains("<strong>"),
      "une rubrique est une structure, pas un effet typographique"
    );
  }

  #[test]
  fn a_block_is_a_plain_paragraph_and_nothing_is_bold() {
    let out = html("T", &[Block::body("Premier paragraphe")]);
    assert!(out.contains("<h1>T</h1>"));
    assert!(out.contains("<p>Premier paragraphe</p>"));
    assert!(
      !out.contains("<strong>"),
      "le gras servait à nommer un locuteur : il n'a plus d'emploi"
    );
  }

  #[test]
  fn an_empty_title_writes_no_heading() {
    let out = html("", &[Block::body("Texte")]);
    assert!(!out.contains("<h1>"));
  }

  /// ⚠️ Le piège qui rendrait un collage illisible : le HTML replie les blancs.
  #[test]
  fn a_line_break_survives_as_a_br() {
    let out = html("", &[Block::body("Une ligne\nUne autre")]);
    assert!(out.contains("Une ligne<br>\nUne autre"));
  }

  /// ⚠️ L'esperluette d'abord, sinon `&lt;` ressortirait `&amp;lt;`.
  #[test]
  fn the_markup_characters_are_escaped_in_the_text_and_in_the_title() {
    assert_eq!(escape("1 < 2 & 3 > 2"), "1 &lt; 2 &amp; 3 &gt; 2");
    let out = html("A & B", &[Block::body("1 < 2")]);
    assert!(out.contains("<title>A &amp; B</title>"));
    assert!(out.contains("<h1>A &amp; B</h1>"));
    assert!(out.contains("<p>1 &lt; 2</p>"));
  }

  /// Accents et emoji traversent sans encodage d'entité : le document annonce
  /// l'UTF-8, il n'a pas à les fuir.
  #[test]
  fn hostile_text_survives_intact() {
    let hostile = "Il a dit : \"oui, çà va\" 🙂 漢字";
    let out = html("Ünïcode 🎧", &[Block::body(hostile)]);
    assert!(out.contains(hostile));
  }
}
