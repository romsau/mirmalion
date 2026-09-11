//! La boucle de traduction : une suite de textes, traduits un par un, avec avancée et arrêt.
//!
//! Deux appelants la partagent, le transcript ([`super::paragraphs`]) et le compte rendu
//! ([`super::report`]) : une seule pondération, un seul cran d'annulation, un seul traitement
//! de la chaîne vide.
//!
//! # Pièges
//!
//! - ⚠️ Les mesures qui la gouvernent sont dans l'en-tête de [`super::paragraphs`], et ne sont
//!   pas redites ici : un appel par texte, coût au caractère, progression pondérée par les
//!   caractères et tronquée, rappel de progression qui est aussi l'interrupteur d'annulation.
//!   Les relire avant de toucher à quoi que ce soit ci-dessous.

use crate::{
  error::AppError,
  translation::{TranslationEngine, TranslationOutcome},
};

/// Ce que rend la traduction d'une suite de textes.
///
/// Pendant brut de [`super::paragraphs::TranscriptTranslation`], sans structure : c'est à
/// l'appelant de rendre aux textes leur forme, paragraphes horodatés ou rubriques.
///
/// # Pièges
///
/// - ⚠️ Il ne traverse pas le pont : chaque appelant expose *sa* forme au frontend, qui ne
///   saurait pas où remettre une simple liste de chaînes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextTranslation {
  /// Les textes traduits, **dans l'ordre et en même nombre** que ceux d'origine.
  Translated(Vec<String>),
  /// La paire est téléchargeable mais absente. Signal à **proposer**, jamais à engager.
  PairMissing { source: String, target: String },
  /// Apple ne traduit pas cette paire. *Indisponible* définitif.
  PairUnsupported { source: String, target: String },
  /// L'utilisateur a demandé l'arrêt.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Cette issue ne porte aucun texte : une traduction à moitié faite ne se montre pas.
  Cancelled,
}

/// Ce que pèse un texte dans la progression : son nombre de caractères, jamais « un texte ».
///
/// # Pièges
///
/// - ⚠️ Trimé, comme au moment de décider s'il traverse le pont : un texte de blancs ne coûte
///   rien au moteur, il ne doit peser ni dans le total ni dans le fait.
/// - ⚠️ Des caractères, pas des octets : `len()` compterait deux fois une lettre accentuée, et le
///   même document avancerait différemment selon sa langue.
fn weight(text: &str) -> usize {
  text.trim().chars().count()
}

/// La part faite, de `0` à `100`, tronquée : 100 % veut dire « fini ».
///
/// # Pièges
///
/// - ⚠️ Rien à traduire rend 100 sans diviser par zéro : c'est du travail achevé, pas du
///   travail figé à zéro.
fn percent_done(done: usize, total: usize) -> u8 {
  if total == 0 {
    return 100;
  }
  #[expect(
    clippy::cast_possible_truncation,
    reason = "`done` est borné par `total`, donc le quotient ne dépasse jamais 100"
  )]
  let percent = (done.min(total) * 100 / total) as u8;
  percent
}

/// Traduit `texts` de `source` vers `target`, un appel par texte.
///
/// Ce que rend `progress` est « faut-il continuer ? » : sur `false`, la boucle rend
/// [`TextTranslation::Cancelled`], sans un seul texte traduit.
///
/// # Errors
///
/// Rend une [`AppError`] sur une panne du moteur seulement.
///
/// # Pièges
///
/// - ⚠️ Bloquant, et longuement : à n'appeler que depuis `spawn_blocking`.
/// - ⚠️ `source == target` ne touche pas au moteur et ne rapporte aucune progression.
pub fn translate_texts(
  engine: &dyn TranslationEngine,
  source: &str,
  target: &str,
  texts: &[String],
  progress: &mut dyn FnMut(u8) -> bool,
) -> Result<TextTranslation, AppError> {
  if source == target {
    return Ok(TextTranslation::Translated(texts.to_vec()));
  }

  let total: usize = texts.iter().map(|text| weight(text)).sum();
  let mut done = 0usize;
  // ⚠️ Un appel par centième franchi, jamais un par texte : deux cents textes d'un caractère
  // inonderaient le pont pour redessiner la même barre. `0` et non `None`, sinon le premier
  // texte annoncerait « 0 % » alors que la barre part déjà de là.
  let mut last = 0u8;
  let mut translated: Vec<String> = Vec::with_capacity(texts.len());
  for text in texts {
    // ⚠️ Un texte vide ne traverse pas le pont, qui refuse une chaîne vide comme argument.
    // Le violer doit coûter une ligne vide dans la sortie, pas la traduction tout entière.
    if text.trim().is_empty() {
      translated.push(text.clone());
    } else {
      match engine.translate(source, target, text)? {
        TranslationOutcome::Translated { text } => translated.push(text),
        // On s'arrête au premier texte qui le dit : l'état d'une paire ne change pas en route.
        TranslationOutcome::PairMissing { source, target } => {
          return Ok(TextTranslation::PairMissing { source, target });
        }
        TranslationOutcome::PairUnsupported { source, target } => {
          return Ok(TextTranslation::PairUnsupported { source, target });
        }
      }
    }
    done += weight(text);
    let percent = percent_done(done, total);
    if percent != last {
      last = percent;
      // ⚠️ On jette ce qui a été traduit, `translated` compris : un document à moitié traduit
      // ne se montre pas.
      if !progress(percent) {
        return Ok(TextTranslation::Cancelled);
      }
    }
  }
  Ok(TextTranslation::Translated(translated))
}

#[cfg(test)]
mod tests {
  use super::{TextTranslation, percent_done, translate_texts};
  use crate::error::AppError;
  use crate::translation::{
    PairAvailability, PairStatus, TranslationAvailability, TranslationEngine, TranslationOutcome,
  };
  use std::sync::Mutex;

  /// La doublure qui rend le trait utile : elle produit à volonté les trois issues et la panne,
  /// ce que le vrai moteur ne sait pas faire sans désinstaller une paire de langues.
  #[derive(Default)]
  struct FakeEngine {
    seen: Mutex<Vec<String>>,
    scripted: Vec<TranslationOutcome>,
    fails: bool,
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
      if self.fails {
        return Err(AppError::Native("moteur en panne".into()));
      }
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

  fn texts(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
  }

  /// Traduit en collectant **tout ce qui a été rapporté, dans l'ordre**.
  fn reported(
    engine: &dyn TranslationEngine,
    source: &str,
    target: &str,
    values: &[String],
  ) -> (TextTranslation, Vec<u8>) {
    let mut seen = Vec::new();
    let outcome = translate_texts(engine, source, target, values, &mut |percent| {
      seen.push(percent);
      true
    })
    .expect("succès");
    (outcome, seen)
  }

  /// Un texte de `chars` caractères — la seule chose qui compte pour la progression.
  fn long(chars: usize) -> String {
    "a".repeat(chars)
  }

  #[test]
  fn each_text_crosses_the_bridge_on_its_own() {
    let engine = FakeEngine::default();
    let outcome = translate_texts(
      &engine,
      "fr",
      "en",
      &texts(&["Bonjour", "Merci."]),
      &mut |_| true,
    )
    .expect("succès");

    assert_eq!(
      *engine.seen.lock().expect("verrou"),
      vec!["Bonjour", "Merci."]
    );
    assert_eq!(
      outcome,
      TextTranslation::Translated(texts(&["BONJOUR", "MERCI."]))
    );
  }

  /// « Langue d'origine » : aucun appel, aucune seconde d'attente, **et aucune progression** —
  /// annoncer 100 % laisserait croire qu'on a traduit.
  #[test]
  fn the_source_language_costs_nothing_and_reports_nothing() {
    let engine = FakeEngine::default();
    let (outcome, seen) = reported(&engine, "fr", "fr", &texts(&["Bonjour"]));

    assert_eq!(outcome, TextTranslation::Translated(texts(&["Bonjour"])));
    assert_eq!(seen, Vec::<u8>::new());
    assert!(engine.seen.lock().expect("verrou").is_empty());
  }

  /// ⚠️ **Un texte de blancs ne traverse pas le pont**, qui refuse une chaîne vide — et il ne pèse
  /// rien dans la barre.
  #[test]
  fn a_blank_text_is_kept_without_crossing_the_bridge_and_weighs_nothing() {
    let engine = FakeEngine::default();
    let values = vec!["  ".to_owned(), long(50), "\n\t".to_owned(), long(50)];
    let (outcome, seen) = reported(&engine, "fr", "en", &values);

    assert_eq!(engine.seen.lock().expect("verrou").len(), 2);
    assert_eq!(seen, vec![50, 100]);
    let TextTranslation::Translated(out) = outcome else {
      panic!("la traduction devait aboutir");
    };
    assert_eq!(out[0], "  ", "un blanc ressort tel quel");
    assert_eq!(out.len(), 4);
  }

  /// ⚠️ La pondération est le cœur de la progression : cinq caractères sur cent font 5 %,
  /// pas 50 %.
  #[test]
  fn progress_is_weighted_by_characters_not_by_texts() {
    let engine = FakeEngine::default();
    assert_eq!(
      reported(&engine, "fr", "en", &[long(5), long(95)]).1,
      vec![5, 100]
    );

    let engine = FakeEngine::default();
    assert_eq!(
      reported(&engine, "fr", "en", &[long(95), long(5)]).1,
      vec![95, 100]
    );
  }

  /// ⚠️ **Un appel par changement de pourcentage ENTIER, jamais un par texte** : deux cents textes
  /// d'un caractère inonderaient le pont pour redessiner la même barre.
  #[test]
  fn nothing_is_reported_until_the_whole_percent_changes() {
    let engine = FakeEngine::default();
    let values: Vec<String> = (0..200).map(|_| long(1)).collect();
    let (_, seen) = reported(&engine, "fr", "en", &values);

    assert_eq!(seen.len(), 100);
    assert_eq!(
      seen.first(),
      Some(&1),
      "le « 0 % » du départ ne s’annonce pas"
    );
    assert_eq!(seen.last(), Some(&100));
    assert!(seen.windows(2).all(|pair| pair[1] > pair[0]));
  }

  /// ⚠️ **100 % veut dire « fini »** : on tronque, sinon l'écran passerait pour bloqué au dernier
  /// texte.
  #[test]
  fn the_bar_never_reaches_a_hundred_before_the_last_text() {
    let engine = FakeEngine::default();
    assert_eq!(
      reported(&engine, "fr", "en", &[long(999), long(1)]).1,
      vec![99, 100]
    );
  }

  /// ⚠️ **Rien à traduire, c'est du travail achevé** — pas une division par zéro, pas une barre
  /// figée.
  #[test]
  fn nothing_to_translate_reports_a_hundred_rather_than_dividing_by_zero() {
    let engine = FakeEngine::default();
    assert_eq!(
      reported(&engine, "fr", "en", &texts(&["  ", "\n"])).1,
      vec![100]
    );
    assert_eq!(reported(&engine, "fr", "en", &[]).1, Vec::<u8>::new());
    assert_eq!(percent_done(0, 0), 100);
  }

  /// ⚠️ Annuler arrête la boucle entre deux textes, et ce qui était traduit est jeté.
  #[test]
  fn a_cancellation_stops_the_loop_and_throws_away_what_was_done() {
    let engine = FakeEngine::default();
    let mut seen = Vec::new();
    let outcome = translate_texts(
      &engine,
      "fr",
      "en",
      &[long(40), long(30), long(30)],
      &mut |percent| {
        seen.push(percent);
        percent < 70
      },
    )
    .expect("une annulation n’est pas une panne");

    assert_eq!(outcome, TextTranslation::Cancelled);
    assert_eq!(seen, vec![40, 70]);
    assert_eq!(
      engine.seen.lock().expect("verrou").len(),
      2,
      "le troisième texte ne doit plus traverser le pont"
    );
  }

  /// ⚠️ **Une paire absente est une issue NOMINALE**, et on abandonne dès qu'on l'apprend : son
  /// état ne changera pas au texte suivant. ⚠️ **Et une sortie anticipée ne rapporte pas un
  /// dernier pourcentage** : rien de plus n'a été traduit.
  #[test]
  fn a_missing_or_unsupported_pair_stops_at_the_text_that_says_so() {
    for outcome in [
      TranslationOutcome::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      },
      TranslationOutcome::PairUnsupported {
        source: "fr".into(),
        target: "it".into(),
      },
    ] {
      let engine = FakeEngine {
        scripted: vec![
          TranslationOutcome::Translated {
            text: "Hello".into(),
          },
          outcome.clone(),
        ],
        ..Default::default()
      };
      let (issue, seen) = reported(&engine, "fr", "it", &[long(50), long(30), long(20)]);

      assert_eq!(seen, vec![50], "la barre s’arrête au texte qui a échoué");
      assert!(matches!(
        (issue, outcome),
        (
          TextTranslation::PairMissing { .. },
          TranslationOutcome::PairMissing { .. }
        ) | (
          TextTranslation::PairUnsupported { .. },
          TranslationOutcome::PairUnsupported { .. }
        )
      ));
      assert_eq!(engine.seen.lock().expect("verrou").len(), 2);
    }
  }

  /// Une vraie panne remonte en `Err`, **intacte** : le frontend branche sur `kind`.
  #[test]
  fn a_failing_engine_surfaces_its_error_untouched() {
    let engine = FakeEngine {
      fails: true,
      ..Default::default()
    };
    let error = translate_texts(&engine, "fr", "en", &texts(&["Bonjour"]), &mut |_| true)
      .expect_err("une panne");
    assert_eq!(error.kind(), "native");
    assert_eq!(error.to_string(), "moteur en panne");
  }
}
