//! Traduire un compte rendu, c'est-à-dire une suite de rubriques.
//!
//! Ce module ne compte pas, ne pondère pas, n'annule pas : tout cela vit dans [`super::texts`],
//! mesuré une fois pour le transcript et partagé depuis. Ici on met à plat, on traduit, on
//! remet en forme.
//!
//! # Pièges
//!
//! - ⚠️ Les intitulés se traduisent aussi : « Résumé », « Décisions » ne sortent d'aucune table
//!   de l'interface — le modèle les écrit dans la langue du transcript et
//!   [`crate::live::report::parse`] les relève tels quels. Les laisser rendrait un compte rendu
//!   anglais à rubriques françaises.
//! - ⚠️ Corollaire : une rubrique ne se reconnaît pas à son intitulé, ni avant ni après. C'est
//!   la raison qui interdit aussi le « CSV des tâches », voir [`crate::export::report`].

use serde::{Deserialize, Serialize};

use crate::{
  error::AppError,
  live::report::ReportSection,
  translation::{
    TranslationEngine,
    texts::{TextTranslation, translate_texts},
  },
};

/// Ce que rend la traduction d'un compte rendu.
///
/// Jumeau de [`super::paragraphs::TranscriptTranslation`] : les deux traversent le pont et
/// l'écran les traite de la même façon.
///
/// # Pièges
///
/// - ⚠️ Les deux formes doivent le rester : une issue nominale n'est jamais une panne, et une
///   annulation ne rend rien du tout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReportTranslation {
  /// Les rubriques traduites, **dans l'ordre et en même nombre** que celles d'origine.
  Translated { sections: Vec<ReportSection> },
  /// La paire est téléchargeable mais absente. Signal à **proposer**, jamais à engager.
  PairMissing { source: String, target: String },
  /// Apple ne traduit pas cette paire. *Indisponible* définitif.
  PairUnsupported { source: String, target: String },
  /// L'utilisateur a demandé l'arrêt.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Cette issue ne porte aucune rubrique. Un compte rendu à moitié traduit aurait ses
  ///   trois premières rubriques en anglais et les deux dernières en français, sans que rien
  ///   ne dise où passe la frontière.
  Cancelled,
}

/// Met le compte rendu à plat : l'intitulé, puis les lignes, rubrique après rubrique.
///
/// # Pièges
///
/// - ⚠️ L'ordre est le contrat : lui seul permet à [`rebuild`] de remettre chaque texte à sa
///   place, la boucle rendant autant de textes qu'elle en reçoit, dans l'ordre.
fn flatten(sections: &[ReportSection]) -> Vec<String> {
  let mut texts = Vec::new();
  for section in sections {
    texts.push(section.heading.clone());
    texts.extend(section.lines.iter().cloned());
  }
  texts
}

/// Remet les textes traduits dans la forme des rubriques d'origine.
///
/// # Pièges
///
/// - ⚠️ `bullets` ne se traduit pas : c'est la forme de la rubrique, et une traduction ne
///   change pas des puces en paragraphes.
fn rebuild(sections: &[ReportSection], translated: Vec<String>) -> Vec<ReportSection> {
  let mut texts = translated.into_iter();
  sections
    .iter()
    .map(|section| ReportSection {
      // ⚠️ Un texte manquant garde son original plutôt que de décaler tout le reste : faire
      // dépendre l'alignement des rubriques d'un `unwrap` échangerait un intitulé non traduit
      // contre une panne.
      heading: texts.next().unwrap_or_else(|| section.heading.clone()),
      lines: section
        .lines
        .iter()
        .map(|line| texts.next().unwrap_or_else(|| line.clone()))
        .collect(),
      bullets: section.bullets,
    })
    .collect()
}

/// Traduit les rubriques de `source` vers `target`.
///
/// `progress` reçoit la part faite en pourcents et rend `false` pour interrompre ; son contrat
/// complet est celui de [`super::texts::translate_texts`].
///
/// # Errors
///
/// Rend une [`AppError`] si le moteur tombe en panne ; une paire absente et une annulation
/// sont des issues nominales de [`ReportTranslation`], pas des erreurs.
///
/// # Pièges
///
/// - ⚠️ Bloquant : à n'appeler que depuis `spawn_blocking`.
pub fn translate_report(
  engine: &dyn TranslationEngine,
  source: &str,
  target: &str,
  sections: &[ReportSection],
  progress: &mut dyn FnMut(u8) -> bool,
) -> Result<ReportTranslation, AppError> {
  let texts = flatten(sections);
  Ok(
    match translate_texts(engine, source, target, &texts, progress)? {
      TextTranslation::Translated(translated) => ReportTranslation::Translated {
        sections: rebuild(sections, translated),
      },
      TextTranslation::PairMissing { source, target } => {
        ReportTranslation::PairMissing { source, target }
      }
      TextTranslation::PairUnsupported { source, target } => {
        ReportTranslation::PairUnsupported { source, target }
      }
      TextTranslation::Cancelled => ReportTranslation::Cancelled,
    },
  )
}

#[cfg(test)]
mod tests {
  use super::{ReportTranslation, flatten, rebuild, translate_report};
  use crate::error::AppError;
  use crate::live::report::ReportSection;
  use crate::translation::{
    PairAvailability, PairStatus, TranslationAvailability, TranslationEngine, TranslationOutcome,
  };
  use std::sync::Mutex;

  #[derive(Default)]
  struct FakeEngine {
    seen: Mutex<Vec<String>>,
    scripted: Vec<TranslationOutcome>,
  }

  impl TranslationEngine for FakeEngine {
    fn availability(&self) -> Result<TranslationAvailability, AppError> {
      Ok(TranslationAvailability {
        languages: vec!["fr".into(), "en".into()],
        pairs: vec![PairAvailability {
          source: "fr".into(),
          target: "en".into(),
          status: PairStatus::Installed,
        }],
      })
    }

    fn translate(
      &self,
      _source: &str,
      _target: &str,
      text: &str,
    ) -> Result<TranslationOutcome, AppError> {
      let mut seen = self.seen.lock().expect("verrou");
      seen.push(text.to_owned());
      Ok(
        self
          .scripted
          .get(seen.len() - 1)
          .cloned()
          .unwrap_or(TranslationOutcome::Translated {
            text: text.to_uppercase(),
          }),
      )
    }
  }

  fn a_report() -> Vec<ReportSection> {
    vec![
      ReportSection {
        heading: "Résumé".into(),
        lines: vec!["La session a porté sur le paiement.".into()],
        bullets: false,
      },
      ReportSection {
        heading: "Décisions".into(),
        lines: vec!["La démo est maintenue.".into(), "On garde les neuf.".into()],
        bullets: true,
      },
    ]
  }

  fn translate(
    engine: &dyn TranslationEngine,
    target: &str,
    sections: &[ReportSection],
  ) -> ReportTranslation {
    translate_report(engine, "fr", target, sections, &mut |_| true).expect("succès")
  }

  /// ⚠️ L'intitulé traverse le pont comme le reste : « Résumé » et « Décisions » sont écrits
  /// par le modèle, pas pris dans une table — les laisser en français rendrait un compte
  /// rendu anglais à rubriques françaises.
  #[test]
  fn the_headings_are_translated_too_because_the_model_wrote_them() {
    let engine = FakeEngine::default();
    let ReportTranslation::Translated { sections } = translate(&engine, "en", &a_report()) else {
      panic!("la traduction devait aboutir");
    };

    assert_eq!(sections[0].heading, "RÉSUMÉ");
    assert_eq!(sections[1].heading, "DÉCISIONS");
    assert_eq!(
      *engine.seen.lock().expect("verrou"),
      vec![
        "Résumé",
        "La session a porté sur le paiement.",
        "Décisions",
        "La démo est maintenue.",
        "On garde les neuf.",
      ],
      "l’intitulé part d’abord, puis ses lignes, rubrique après rubrique"
    );
  }

  /// ⚠️ **La forme survit** : des puces restent des puces, et le nombre de lignes ne bouge pas.
  #[test]
  fn the_shape_of_each_section_survives_the_translation() {
    let engine = FakeEngine::default();
    let ReportTranslation::Translated { sections } = translate(&engine, "en", &a_report()) else {
      panic!("la traduction devait aboutir");
    };

    assert_eq!(sections.len(), 2);
    assert!(!sections[0].bullets);
    assert!(sections[1].bullets);
    assert_eq!(sections[1].lines.len(), 2);
    assert_eq!(sections[1].lines[1], "ON GARDE LES NEUF.");
  }

  /// « Langue d'origine » : le compte rendu ressort **intact**, sans un appel.
  #[test]
  fn the_source_language_gives_the_report_back_untouched() {
    let engine = FakeEngine::default();
    assert_eq!(
      translate(&engine, "fr", &a_report()),
      ReportTranslation::Translated {
        sections: a_report()
      }
    );
    assert!(engine.seen.lock().expect("verrou").is_empty());
  }

  /// Un document sans compte rendu n'a rien à traduire — et ce n'est pas une panne : la
  /// fenêtre-session s'ouvre **sur le transcript**, sans rubrique.
  #[test]
  fn a_document_without_a_report_translates_to_nothing_at_all() {
    let engine = FakeEngine::default();
    assert_eq!(
      translate(&engine, "en", &[]),
      ReportTranslation::Translated { sections: vec![] }
    );
    assert!(engine.seen.lock().expect("verrou").is_empty());
  }

  /// ⚠️ **Les trois issues nominales traversent**, exactement comme pour un transcript.
  #[test]
  fn the_nominal_outcomes_come_back_as_outcomes_not_as_errors() {
    let engine = FakeEngine {
      scripted: vec![TranslationOutcome::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      }],
      ..Default::default()
    };
    assert_eq!(
      translate(&engine, "it", &a_report()),
      ReportTranslation::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      }
    );

    let engine = FakeEngine {
      scripted: vec![TranslationOutcome::PairUnsupported {
        source: "fr".into(),
        target: "pt".into(),
      }],
      ..Default::default()
    };
    assert_eq!(
      translate(&engine, "pt", &a_report()),
      ReportTranslation::PairUnsupported {
        source: "fr".into(),
        target: "pt".into(),
      }
    );
  }

  /// ⚠️ Une annulation ne rend aucune rubrique : un compte rendu à moitié traduit ne dirait
  /// pas où passe la frontière entre les deux langues.
  #[test]
  fn a_cancellation_gives_back_no_section_at_all() {
    let engine = FakeEngine::default();
    let outcome = translate_report(&engine, "fr", "en", &a_report(), &mut |_| false)
      .expect("une annulation n’est pas une panne");
    assert_eq!(outcome, ReportTranslation::Cancelled);
  }

  /// ⚠️ **La barre avance sur le compte rendu aussi**, pondérée par les caractères — c'est la même
  /// boucle que le transcript, et ce test l'atteste depuis ce côté-ci.
  #[test]
  fn the_bar_moves_and_ends_at_a_hundred() {
    let engine = FakeEngine::default();
    let mut seen = Vec::new();
    translate_report(&engine, "fr", "en", &a_report(), &mut |percent| {
      seen.push(percent);
      true
    })
    .expect("succès");

    assert_eq!(seen.last(), Some(&100));
    assert!(seen.windows(2).all(|pair| pair[1] > pair[0]));
  }

  /// ⚠️ **Un contrat rompu coûte un intitulé non traduit, pas une panne.** La boucle rend toujours
  /// autant de textes qu'elle en reçoit ; faire dépendre l'alignement d'un `unwrap` échangerait un
  /// défaut visible contre un plantage.
  #[test]
  fn a_short_answer_keeps_the_original_rather_than_shifting_everything() {
    let sections = rebuild(&a_report(), vec!["Summary".into()]);
    assert_eq!(sections[0].heading, "Summary");
    assert_eq!(
      sections[0].lines[0], "La session a porté sur le paiement.",
      "ce qui manque garde son original"
    );
    assert_eq!(sections[1].heading, "Décisions");
    assert_eq!(flatten(&a_report()).len(), 5);
  }

  /// Le frontend type cette structure : le nom du genre et des champs est un contrat.
  #[test]
  fn the_wire_contract_is_camel_case() {
    let json = serde_json::to_value(ReportTranslation::Translated {
      sections: a_report(),
    })
    .expect("sérialisation");
    assert_eq!(json["kind"], "translated");
    assert_eq!(json["sections"][0]["heading"], "Résumé");
    assert_eq!(json["sections"][1]["bullets"], true);

    let json = serde_json::to_value(ReportTranslation::Cancelled).expect("sérialisation");
    assert_eq!(json["kind"], "cancelled");
    assert!(
      json.get("sections").is_none(),
      "une annulation ne porte aucune rubrique, pas même une liste vide"
    );

    for original in [
      ReportTranslation::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      },
      ReportTranslation::PairUnsupported {
        source: "fr".into(),
        target: "pt".into(),
      },
    ] {
      let json = serde_json::to_string(&original).expect("sérialisation");
      let back: ReportTranslation = serde_json::from_str(&json).expect("désérialisation");
      assert_eq!(back, original);
    }
  }
}
