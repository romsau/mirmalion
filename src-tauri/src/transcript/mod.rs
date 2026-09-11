//! Le modèle de domaine d'un transcript : **des mots horodatés, groupés en paragraphes**.
//!
//! Type commun à la consolidation d'une session, aux exports, à la traduction et au rendu des
//! fenêtres-documents. Aucune I/O, aucun moteur, aucun `unsafe` — rien que des données.
//!
//! # Pièges
//!
//! - ⚠️ Le temps est en millisecondes entières, jamais en secondes flottantes : les sous-titres
//!   s'écrivent en `HH:MM:SS,mmm`, et deux arrondis flottants successifs décalent une réplique
//!   d'une image. Le pont convertit les `CMTime` d'Apple une seule fois, à l'entrée.
//! - ⚠️ Un transcript est du texte, sans aucune étiquette — ni « Locuteur 2 », ni « Moi ». La
//!   diarisation ne sert plus qu'à écarter l'écho, et ses types vivent dans `crate::diarization`.
//! - ⚠️ Le texte d'un paragraphe est **dérivé** de ses mots, jamais stocké à côté : deux sources
//!   pour la même phrase divergent à la première reprise. [`Paragraph::text`] recompose.

use serde::{Deserialize, Serialize};

/// Le silence au-delà duquel le transcript passe à un nouveau paragraphe : la seule frontière
/// honnête, un découpage aux segments du moteur étant acoustique et non sémantique.
///
/// # Pièges
///
/// - ⚠️ Deux secondes et demie n'est pas une valeur mesurée : c'est la durée d'une pause qu'on
///   *entend*. Trop court, le texte se hache ; trop long, une discussion animée n'a plus aucun
///   paragraphe.
/// - ⚠️ Une seule valeur pour les deux moments du Direct — le texte qui défile pendant la session
///   et le transcript consolidé lisent celle-ci. Deux feraient bouger les paragraphes à l'arrêt.
pub const PARAGRAPH_SILENCE_MS: u64 = 2_500;

/// Un mot, avec la fenêtre de temps où il a été prononcé.
///
/// # Pièges
///
/// - ⚠️ C'est la granularité qui fait tout le produit : les morceaux rendus par le moteur de
///   transcription débordent les tours de parole du diariseur, ce qui oblige le filtre d'écho à
///   travailler au mot — voir [`fn@crate::diarization::attribute`]. Un moteur qui ne sait pas
///   horodater ses mots ne peut pas servir : c'est une capacité, pas un détail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
  /// Le mot lui-même, **sans espace de bordure**, ponctuation attachée comprise.
  pub text: String,
  /// Début, en millisecondes depuis le début du média.
  pub start_ms: u64,
  /// Fin, en millisecondes. Toujours `>= start_ms` ; un mot de durée nulle est licite —
  /// certains moteurs en produisent sur les élisions.
  pub end_ms: u64,
}

impl Word {
  /// Le milieu du mot — **le point par lequel on décide de quelle voix il vient**.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Ni le début, ni la fin : un mot à cheval sur un changement de voix commence chez l'une
  ///   et finit chez l'autre, arbitrer sur son début le donne à celle qui se tait et sur sa fin à
  ///   celle qui n'a pas encore parlé. Le milieu est le seul point qui tombe du côté où le mot a
  ///   réellement été prononcé le plus longtemps.
  pub fn midpoint_ms(&self) -> u64 {
    self.start_ms + (self.end_ms.saturating_sub(self.start_ms)) / 2
  }
}

/// Un paragraphe : **une suite de mots que rien n'a interrompu**.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
  /// Les mots, dans l'ordre. **Jamais vide** — un paragraphe sans mot n'a rien à dire et ne
  /// doit pas être créé ; [`Transcript::rendered`] et les exports supposent l'invariant.
  pub words: Vec<Word>,
}

impl Paragraph {
  /// Le texte du paragraphe, recomposé à partir de ses mots.
  ///
  /// Les mots sont joints par une espace simple : le moteur rend la ponctuation attachée au mot
  /// qui la précède. Aucune règle typographique par langue ici — c'est une affaire de rendu.
  pub fn text(&self) -> String {
    self
      .words
      .iter()
      .map(|word| word.text.as_str())
      .collect::<Vec<_>>()
      .join(" ")
  }

  /// L'instant du premier mot. `0` sur un paragraphe vide, qui ne devrait pas exister.
  pub fn start_ms(&self) -> u64 {
    self.words.first().map_or(0, |word| word.start_ms)
  }

  /// L'instant de fin du dernier mot. `0` sur un paragraphe vide, qui ne devrait pas exister.
  pub fn end_ms(&self) -> u64 {
    self.words.last().map_or(0, |word| word.end_ms)
  }
}

/// Un paragraphe réduit à ce qu'on affiche ou exporte : **plus de mots, seulement du texte**.
///
/// C'est aussi la forme que produit la traduction, et la raison d'être du type : traduire détruit
/// l'horodatage au mot, tandis que les temps du **paragraphe** restent valides.
///
/// # Pièges
///
/// - ⚠️ Le type distinct rend cette perte visible dans les signatures au lieu de la laisser se
///   découvrir à l'exécution : ce qui accepte un [`RenderedParagraph`] fonctionne sur du traduit,
///   ce qui exige des [`Word`] n'accepte que l'original.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedParagraph {
  /// Début du paragraphe, en millisecondes depuis le début du média.
  pub start_ms: u64,
  /// Fin du paragraphe, en millisecondes.
  pub end_ms: u64,
  /// Le texte affiché — celui du transcript, ou celui de sa traduction.
  pub text: String,
}

/// Le transcript complet d'un média ou d'une session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
  /// La langue du média, en étiquette primaire (`fr`, `en`…).
  pub language: String,
  /// Les paragraphes, dans l'ordre chronologique.
  pub paragraphs: Vec<Paragraph>,
}

impl Transcript {
  /// Compose un transcript à partir de mots **triés par temps croissant**.
  ///
  /// C'est l'ordre dans lequel tout moteur rend ses résultats, et le retrier ici masquerait un
  /// moteur défaillant. La session trie explicitement avant d'appeler, puisqu'elle entrelace deux
  /// flux — voir `crate::live::weave`.
  ///
  /// # Pièges
  ///
  /// - ⚠️ La coupure se juge contre le mot qui finit le plus tard, jamais contre le précédent :
  ///   des mots entrelacés — deux personnes qui se coupent la parole — feraient croire à un
  ///   silence dès qu'un mot bref s'insère au milieu d'un long. On garde le maximum des fins vues.
  pub fn of(words: &[Word], language: &str) -> Self {
    let mut paragraphs: Vec<Paragraph> = Vec::new();
    let mut spoken_until: Option<u64> = None;

    for word in words {
      let opens = spoken_until
        .is_some_and(|previous| word.start_ms.saturating_sub(previous) >= PARAGRAPH_SILENCE_MS);
      match paragraphs.last_mut() {
        Some(current) if !opens => current.words.push(word.clone()),
        _ => paragraphs.push(Paragraph {
          words: vec![word.clone()],
        }),
      }
      spoken_until = Some(spoken_until.unwrap_or(0).max(word.end_ms));
    }

    Self {
      language: language.to_owned(),
      paragraphs,
    }
  }

  /// La vue plate : un texte par paragraphe, avec ses bornes de temps.
  pub fn rendered(&self) -> Vec<RenderedParagraph> {
    self
      .paragraphs
      .iter()
      .map(|paragraph| RenderedParagraph {
        start_ms: paragraph.start_ms(),
        end_ms: paragraph.end_ms(),
        text: paragraph.text(),
      })
      .collect()
  }

  /// Le texte entier, paragraphes séparés par une ligne vide.
  ///
  /// C'est ce que consomment le rendu à l'écran, le compte rendu et l'estimation de longueur.
  pub fn plain_text(&self) -> String {
    self
      .paragraphs
      .iter()
      .map(Paragraph::text)
      .collect::<Vec<_>>()
      .join("\n\n")
  }
}

#[cfg(test)]
mod tests {
  use super::{PARAGRAPH_SILENCE_MS, Paragraph, RenderedParagraph, Transcript, Word};

  /// Un paragraphe d'un seul mot, et un paragraphe vide : aucune espace en tête.
  #[test]
  fn a_paragraph_never_starts_with_a_space() {
    assert_eq!(mots(&["Bonjour"]).text(), "Bonjour");
    assert_eq!(mots(&[]).text(), "");
  }

  /// La ponctuation arrive attachée au mot qui la précède : rien ne doit l'en détacher.
  #[test]
  fn punctuation_stays_attached_to_the_word_it_follows() {
    assert_eq!(
      mots(&["Bonjour", "à", "tous,", "bienvenue."]).text(),
      "Bonjour à tous, bienvenue."
    );
  }

  /// Fabrique un paragraphe à partir de mots, horodatés à la suite.
  fn mots(textes: &[&str]) -> Paragraph {
    Paragraph {
      words: textes
        .iter()
        .enumerate()
        .map(|(index, texte)| word(texte, index as u64 * 100, index as u64 * 100 + 90))
        .collect(),
    }
  }

  fn word(text: &str, start_ms: u64, end_ms: u64) -> Word {
    Word {
      text: text.into(),
      start_ms,
      end_ms,
    }
  }

  #[test]
  fn a_word_is_attributed_by_its_middle_not_its_edges() {
    // Le cas qui motive le choix : un mot de 0 à 1 000 ms, à cheval sur un changement de voix
    // situé à 400 ms. Son début est chez l'une, sa fin chez l'autre ; son milieu tombe là où le
    // mot a été prononcé le plus longtemps.
    assert_eq!(word("chevauchant", 0, 1_000).midpoint_ms(), 500);
  }

  #[test]
  fn a_zero_length_word_has_a_midpoint_and_does_not_underflow() {
    // Certains moteurs rendent des mots de durée nulle sur les élisions. La soustraction
    // saturante existe pour ça : sans elle, un `end_ms` antérieur au début paniquerait.
    assert_eq!(word("l'", 800, 800).midpoint_ms(), 800);
    assert_eq!(word("incohérent", 900, 400).midpoint_ms(), 900);
  }

  #[test]
  fn a_paragraph_derives_its_text_and_its_bounds_from_its_words() {
    let paragraph = mots(&["Bonjour", "tout", "va"]);
    assert_eq!(paragraph.text(), "Bonjour tout va");
    assert_eq!(paragraph.start_ms(), 0);
    assert_eq!(paragraph.end_ms(), 290);
  }

  #[test]
  fn an_empty_paragraph_reports_zero_bounds_rather_than_panicking() {
    // L'invariant dit qu'un paragraphe vide ne doit pas être créé. Le modèle refuse quand même
    // de paniquer si quelqu'un le viole : une transcription perdue vaut mieux qu'un processus
    // mort.
    let empty = Paragraph { words: vec![] };
    assert_eq!(empty.text(), "");
    assert_eq!(empty.start_ms(), 0);
    assert_eq!(empty.end_ms(), 0);
  }

  #[test]
  fn continuous_speech_stays_in_one_paragraph() {
    let transcript = Transcript::of(
      &[
        word("Bonjour", 0, 400),
        word("tout", 500, 800),
        word("le", 900, 1_000),
        word("monde", 1_100, 1_500),
      ],
      "fr",
    );
    assert_eq!(transcript.paragraphs.len(), 1);
    assert_eq!(transcript.paragraphs[0].text(), "Bonjour tout le monde");
    assert_eq!(transcript.language, "fr");
  }

  /// ⚠️ **Le silence est la seule frontière.** Sans locuteur, c'est ce qui remplace le
  /// changement de voix — et c'est la seule chose qui, dans un enregistrement, corresponde à ce
  /// qu'un lecteur appelle un paragraphe.
  #[test]
  fn a_long_silence_opens_a_new_paragraph() {
    let transcript = Transcript::of(
      &[
        word("Première", 0, 400),
        word("idée.", 400, 900),
        word(
          "Deuxième",
          900 + PARAGRAPH_SILENCE_MS,
          900 + PARAGRAPH_SILENCE_MS + 400,
        ),
      ],
      "fr",
    );
    assert_eq!(transcript.paragraphs.len(), 2);
    assert_eq!(transcript.paragraphs[0].text(), "Première idée.");
    assert_eq!(transcript.paragraphs[1].text(), "Deuxième");
  }

  /// ⚠️ **Une respiration ne coupe pas.** Juste sous la borne, le texte reste d'un seul tenant :
  /// c'est ce qui distingue une pause d'une inspiration.
  #[test]
  fn a_short_pause_does_not_cut_anything() {
    let transcript = Transcript::of(
      &[
        word("Une", 0, 400),
        word(
          "suite",
          400 + PARAGRAPH_SILENCE_MS - 1,
          400 + PARAGRAPH_SILENCE_MS,
        ),
      ],
      "fr",
    );
    assert_eq!(transcript.paragraphs.len(), 1);
  }

  /// ⚠️ **Le silence se compte contre le mot qui finit le plus tard, pas contre le précédent.**
  ///
  /// En session, les deux flux s'entrelacent : quelqu'un place un mot bref au milieu d'une
  /// longue phrase de son interlocuteur. Comparer au mot précédent verrait alors un silence là
  /// où **personne ne s'est tu**, et couperait le paragraphe en plein milieu d'une réplique.
  #[test]
  fn an_interjection_inside_a_long_word_does_not_fake_a_silence() {
    let transcript = Transcript::of(
      &[
        word("Alors", 0, 10_000),
        word("oui", 100, 300),
        word("voilà", 10_100, 10_400),
      ],
      "fr",
    );
    assert_eq!(
      transcript.paragraphs.len(),
      1,
      "le long mot couvre l'intervalle : il n'y a eu aucun silence"
    );
  }

  #[test]
  fn no_words_yields_an_empty_transcript() {
    let transcript = Transcript::of(&[], "en");
    assert!(transcript.paragraphs.is_empty());
    assert_eq!(transcript.plain_text(), "");
    assert!(transcript.rendered().is_empty());
  }

  #[test]
  fn rendering_flattens_paragraphs_to_text_and_bounds() {
    let transcript = Transcript::of(
      &[
        word("Bonjour", 0, 900),
        word("Ensuite", 4_000, 4_500),
        word("bien.", 4_600, 5_000),
      ],
      "fr",
    );
    assert_eq!(
      transcript.rendered(),
      vec![
        RenderedParagraph {
          start_ms: 0,
          end_ms: 900,
          text: "Bonjour".into(),
        },
        RenderedParagraph {
          start_ms: 4_000,
          end_ms: 5_000,
          text: "Ensuite bien.".into(),
        },
      ]
    );
  }

  /// ⚠️ **Le test qui garde la porte, au plus bas étage.** Aucune sortie du modèle ne doit
  /// porter d'étiquette — c'est ici que la règle a le plus de chances d'être contournée par
  /// mégarde, puisque tout le reste dérive de ces deux fonctions.
  #[test]
  fn nothing_the_model_renders_carries_a_label() {
    let transcript = Transcript::of(
      &[word("Bonjour", 0, 900), word("Merci.", 4_000, 4_500)],
      "fr",
    );
    let text = transcript.plain_text();
    assert_eq!(text, "Bonjour\n\nMerci.");
    for interdit in ["Locuteur", "Speaker", "Moi", " — "] {
      assert!(
        !text.contains(interdit),
        "« {interdit} » ne doit plus exister"
      );
    }
  }

  #[test]
  fn the_wire_contract_is_camel_case() {
    // Le frontend type ces structures : les noms de champs sont un contrat.
    let transcript = Transcript::of(&[word("Bonjour", 0, 500)], "fr");
    let json = serde_json::to_value(&transcript).expect("sérialisation");
    assert_eq!(json["paragraphs"][0]["words"][0]["startMs"], 0);
    assert_eq!(json["paragraphs"][0]["words"][0]["endMs"], 500);
    assert!(
      json.get("speakers").is_none(),
      "plus aucun locuteur sur le fil"
    );
  }

  #[test]
  fn a_transcript_survives_a_round_trip_through_json() {
    let original = Transcript::of(
      &[word("Bonjour", 0, 500), word("Merci", 4_000, 4_400)],
      "fr",
    );
    let json = serde_json::to_string(&original).expect("sérialisation");
    let back: Transcript = serde_json::from_str(&json).expect("désérialisation");
    assert_eq!(back, original);
  }
}
