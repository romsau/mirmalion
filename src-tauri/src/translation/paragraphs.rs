//! Traduire un transcript : une suite de paragraphes, un appel de traduction par paragraphe.
//!
//! Le coût du framework est au caractère, pas à l'appel : ~4,5 ms par caractère, strictement
//! linéaire jusqu'à 63 127 caractères avalés en un seul appel, sans plafond apparu. C'est ce
//! chiffre qui interdit d'annoncer une durée et permet d'annoncer une proportion faite — d'où
//! la progression pondérée par les caractères, et tronquée, de [`super::texts`].
//!
//! # Pièges
//!
//! - ⚠️ Ne pas grouper les paragraphes : le framework resegmente et repose ses propres retours
//!   à la ligne — 25 paragraphes collés sont revenus sur 49 lignes, et ce nombre est
//!   imprévisible. Redécouper sur `\n` recollerait la réplique de l'un au tour d'en face,
//!   parfaitement traduite donc invisible à la relecture. Le gain abandonné est de 19 %.
//! - ⚠️ La traduction est lente, et sa lenteur suit la longueur du média, pas le nombre de
//!   paragraphes : six minutes d'audio coûtent une demi-minute, une heure en coûte plusieurs.

use serde::{Deserialize, Serialize};

use crate::{
  error::AppError,
  transcript::RenderedParagraph,
  translation::{
    TranslationEngine,
    texts::{TextTranslation, translate_texts},
  },
};

/// Ce que rend la traduction d'un transcript.
///
/// Type somme comme [`super::TranslationOutcome`], et pour la même raison : les deux façons de
/// ne pas traduire ne se traitent pas pareil — l'une se propose au téléchargement, l'autre
/// s'affiche *Indisponible*.
///
/// # Pièges
///
/// - ⚠️ Cette traduction est une vue, pas un remplacement : le transcript d'origine reste
///   intact dans le magasin des documents, sans quoi revenir à « Langue d'origine »
///   demanderait de retranscrire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TranscriptTranslation {
  /// Les paragraphes traduits, dans l'ordre et en même nombre que ceux d'origine.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Des [`RenderedParagraph`], donc sans mots : traduire détruit l'horodatage au mot, et
  ///   le type le dit dans la signature plutôt que de le laisser découvrir à l'exécution. Les
  ///   bornes du paragraphe, elles, restent justes : ce sont celles de l'audio.
  Translated { paragraphs: Vec<RenderedParagraph> },
  /// La paire est téléchargeable mais absente. Signal à **proposer**, jamais à engager.
  ///
  /// # Pièges
  ///
  /// - ⚠️ On abandonne au premier paragraphe qui le dit : l'état d'une paire ne change pas en
  ///   cours de route, et vingt-cinq appels pour réapprendre la même chose seraient
  ///   vingt-cinq de trop.
  PairMissing { source: String, target: String },
  /// Apple ne traduit pas cette paire. *Indisponible* définitif.
  PairUnsupported { source: String, target: String },
  /// L'utilisateur a demandé l'arrêt.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Cette issue ne porte aucun paragraphe : rendre ce qui était traduit donnerait un
  ///   document moitié français moitié allemand. On jette, l'écran garde ce qu'il affichait.
  /// - ⚠️ Ce n'est pas une erreur : ni snackbar d'échec, ni message de dépannage — même règle
  ///   que les deux issues au-dessus.
  Cancelled,
}

/// Traduit les paragraphes de `source` vers `target`, un appel par paragraphe.
///
/// `progress` reçoit le pourcentage entier fait, pondéré par les caractères, et rend « faut-il
/// continuer ? ». La fonction n'émet rien elle-même et ne connaît pas Tauri.
///
/// # Errors
///
/// Rend une [`AppError`] sur une panne du moteur seulement.
///
/// # Pièges
///
/// - ⚠️ Bloquant, et longuement : à n'appeler que depuis `spawn_blocking`.
/// - ⚠️ L'arrêt se constate entre deux paragraphes : le pont n'interrompt pas un appel.
pub fn translate_paragraphs(
  engine: &dyn TranslationEngine,
  source: &str,
  target: &str,
  paragraphs: &[RenderedParagraph],
  progress: &mut dyn FnMut(u8) -> bool,
) -> Result<TranscriptTranslation, AppError> {
  // ⚠️ La boucle vit dans `super::texts` : pondération, cran d'annulation, cas de la chaîne
  // vide. Ce qui reste ici est ce qui fait d'une suite de textes un transcript — les bornes de
  // temps, que la traduction ne touche pas.
  let texts: Vec<String> = paragraphs
    .iter()
    .map(|paragraph| paragraph.text.clone())
    .collect();
  Ok(
    match translate_texts(engine, source, target, &texts, progress)? {
      // ⚠️ `zip` sur les paragraphes d'origine : la boucle rend autant de textes qu'elle en a
      // reçu, dans l'ordre, et c'est ce qui garde chaque texte sur ses bornes de temps.
      TextTranslation::Translated(translated) => TranscriptTranslation::Translated {
        paragraphs: paragraphs
          .iter()
          .zip(translated)
          .map(|(paragraph, text)| RenderedParagraph {
            text,
            ..paragraph.clone()
          })
          .collect(),
      },
      TextTranslation::PairMissing { source, target } => {
        TranscriptTranslation::PairMissing { source, target }
      }
      TextTranslation::PairUnsupported { source, target } => {
        TranscriptTranslation::PairUnsupported { source, target }
      }
      TextTranslation::Cancelled => TranscriptTranslation::Cancelled,
    },
  )
}

#[cfg(test)]
mod tests {
  use super::{TranscriptTranslation, translate_paragraphs};
  use crate::error::AppError;
  use crate::transcript::RenderedParagraph;
  use crate::translation::{
    PairAvailability, PairStatus, TranslationAvailability, TranslationEngine, TranslationOutcome,
  };
  use std::sync::Mutex;

  /// La doublure qui rend le trait utile : elle produit à volonté les trois issues et la
  /// panne, ce que le vrai moteur ne sait pas faire sans désinstaller une paire de langues.
  #[derive(Default)]
  struct FakeEngine {
    /// Les textes reçus, dans l'ordre — c'est ce qui prouve **un appel par paragraphe**.
    seen: Mutex<Vec<String>>,
    /// L'issue à rendre au n-ième appel ; au-delà, une traduction en majuscules.
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

  fn paragraph(start_ms: u64, end_ms: u64, text: &str) -> RenderedParagraph {
    RenderedParagraph {
      start_ms,
      end_ms,
      text: text.into(),
    }
  }

  fn two_paragraphs() -> Vec<RenderedParagraph> {
    vec![
      paragraph(0, 900, "Bonjour tout va"),
      paragraph(1_000, 1_800, "Très bien."),
    ]
  }

  /// Traduit sans regarder la progression — pour les tests qui éprouvent autre chose.
  fn translate(
    engine: &dyn TranslationEngine,
    source: &str,
    target: &str,
    paragraphs: &[RenderedParagraph],
  ) -> Result<TranscriptTranslation, AppError> {
    translate_paragraphs(engine, source, target, paragraphs, &mut |_| true)
  }

  /// Traduit et rend, à côté de l'issue, **tout ce qui a été rapporté, dans l'ordre**.
  fn reported(
    engine: &dyn TranslationEngine,
    source: &str,
    target: &str,
    paragraphs: &[RenderedParagraph],
  ) -> (TranscriptTranslation, Vec<u8>) {
    let mut seen = Vec::new();
    let outcome = translate_paragraphs(engine, source, target, paragraphs, &mut |percent| {
      seen.push(percent);
      true
    })
    .expect("succès");
    (outcome, seen)
  }

  /// Traduit en annonçant l'arrêt **à partir de** `stop_at` pour cent, et rend l'issue avec ce
  /// qui a été rapporté avant.
  fn cancelled_at(
    engine: &dyn TranslationEngine,
    paragraphs: &[RenderedParagraph],
    stop_at: u8,
  ) -> (TranscriptTranslation, Vec<u8>) {
    let mut seen = Vec::new();
    let outcome = translate_paragraphs(engine, "fr", "en", paragraphs, &mut |percent| {
      seen.push(percent);
      percent < stop_at
    })
    .expect("une annulation n’est pas une panne");
    (outcome, seen)
  }

  /// Un paragraphe long de `chars` caractères — la seule chose qui compte pour la progression.
  fn long_paragraph(chars: usize) -> RenderedParagraph {
    paragraph(0, 1, &"a".repeat(chars))
  }

  /// ⚠️ Coller les paragraphes et redécouper sur `\n` a rendu 49 lignes pour 25 paragraphes :
  /// ce test fige le contraire — un appel par paragraphe, son texte et lui seul.
  #[test]
  fn each_turn_crosses_the_bridge_on_its_own() {
    let engine = FakeEngine::default();
    let outcome = translate(&engine, "fr", "en", &two_paragraphs()).expect("succès");

    assert_eq!(
      *engine.seen.lock().expect("verrou"),
      vec!["Bonjour tout va", "Très bien."],
      "chaque paragraphe doit partir seul, jamais collé au suivant"
    );
    assert_eq!(
      outcome,
      TranscriptTranslation::Translated {
        paragraphs: vec![
          paragraph(0, 900, "BONJOUR TOUT VA"),
          paragraph(1_000, 1_800, "TRÈS BIEN."),
        ],
      }
    );
  }

  /// Les bornes de temps survivent : ce sont celles de l'audio, que la traduction ne touche
  /// pas. Seul le texte change.
  #[test]
  fn only_the_text_changes() {
    let engine = FakeEngine::default();
    let TranscriptTranslation::Translated { paragraphs } =
      translate(&engine, "fr", "en", &two_paragraphs()).expect("succès")
    else {
      panic!("la traduction devait aboutir");
    };
    let original = two_paragraphs();
    for (before, after) in original.iter().zip(paragraphs.iter()) {
      assert_eq!(before.start_ms, after.start_ms);
      assert_eq!(before.end_ms, after.end_ms);
      assert_ne!(before.text, after.text);
    }
  }

  /// « Langue d'origine » : le cas nominal de la fenêtre-document. Aucun appel, aucune
  /// seconde d'attente, le transcript rendu tel quel.
  #[test]
  fn the_source_language_costs_nothing_at_all() {
    let engine = FakeEngine::default();
    let outcome = translate(&engine, "fr", "fr", &two_paragraphs()).expect("succès");
    assert_eq!(
      outcome,
      TranscriptTranslation::Translated {
        paragraphs: two_paragraphs()
      }
    );
    assert!(
      engine.seen.lock().expect("verrou").is_empty(),
      "à quatre secondes et demie par mille caractères, un appel inutile se paye"
    );
  }

  #[test]
  fn an_empty_transcript_translates_to_an_empty_transcript() {
    let engine = FakeEngine::default();
    assert_eq!(
      translate(&engine, "fr", "en", &[]).expect("succès"),
      TranscriptTranslation::Translated { paragraphs: vec![] }
    );
    assert!(engine.seen.lock().expect("verrou").is_empty());
  }

  /// L'invariant du modèle interdit un paragraphe sans mot ; le violer ne doit pas coûter la
  /// traduction entière, car le pont refuse une chaîne vide comme argument.
  #[test]
  fn a_blank_turn_is_kept_without_crossing_the_bridge() {
    let engine = FakeEngine::default();
    let paragraphs = vec![paragraph(0, 10, "   "), paragraph(10, 20, "Merci.")];
    let outcome = translate(&engine, "fr", "en", &paragraphs).expect("succès");

    assert_eq!(
      *engine.seen.lock().expect("verrou"),
      vec!["Merci."],
      "seul le paragraphe qui a du texte traverse"
    );
    assert_eq!(
      outcome,
      TranscriptTranslation::Translated {
        paragraphs: vec![paragraph(0, 10, "   "), paragraph(10, 20, "MERCI.")],
      }
    );
  }

  /// ⚠️ La pondération est le cœur de la progression : deux paragraphes très inégaux ne passent
  /// pas par 50 % au milieu. Un pourcentage assis sur leur nombre serait juste à la fin et faux
  /// tout du long, et la barre sauterait par bonds irréguliers.
  #[test]
  fn progress_is_weighted_by_characters_not_by_paragraphs() {
    let engine = FakeEngine::default();
    let paragraphs = vec![long_paragraph(5), long_paragraph(95)];
    let (_, seen) = reported(&engine, "fr", "en", &paragraphs);
    assert_eq!(
      seen,
      vec![5, 100],
      "cinq caractères sur cent font 5 %, pas 50 %"
    );
  }

  /// L'inverse, pour que le test précédent ne puisse pas passer par hasard : c'est bien la
  /// **longueur** qui décide, pas le rang du paragraphe.
  #[test]
  fn a_long_first_turn_fills_most_of_the_bar_at_once() {
    let engine = FakeEngine::default();
    let paragraphs = vec![long_paragraph(95), long_paragraph(5)];
    let (_, seen) = reported(&engine, "fr", "en", &paragraphs);
    assert_eq!(seen, vec![95, 100]);
  }

  /// ⚠️ **Un appel par changement de pourcentage ENTIER, jamais un par paragraphe.** Deux cents paragraphes
  /// d'un caractère ne peuvent pas produire deux cents évènements : le pont serait inondé pour
  /// redessiner la même barre.
  #[test]
  fn nothing_is_reported_until_the_whole_percent_changes() {
    let engine = FakeEngine::default();
    let paragraphs: Vec<RenderedParagraph> = (0..200).map(|_| long_paragraph(1)).collect();
    let (_, seen) = reported(&engine, "fr", "en", &paragraphs);

    assert_eq!(seen.len(), 100, "cent crans pour deux cents paragraphes");
    assert_eq!(
      seen.first(),
      Some(&1),
      "le « 0 % » du départ ne s’annonce pas"
    );
    assert_eq!(seen.last(), Some(&100));
    assert!(
      seen.windows(2).all(|pair| pair[1] > pair[0]),
      "une progression ne recule pas et ne se répète pas"
    );
  }

  /// ⚠️ **100 % veut dire « fini ».** On tronque au lieu d'arrondir : sur 999 caractères faits
  /// sur 1 000, un arrondi afficherait 100 % avec un paragraphe encore à traduire, et l'écran passerait
  /// pour bloqué.
  #[test]
  fn the_bar_never_reaches_a_hundred_before_the_last_turn() {
    let engine = FakeEngine::default();
    let paragraphs = vec![long_paragraph(999), long_paragraph(1)];
    let (_, seen) = reported(&engine, "fr", "en", &paragraphs);
    assert_eq!(seen, vec![99, 100]);
  }

  /// ⚠️ **Un paragraphe de blancs ne pèse rien** : il ne traverse pas le pont, il ne doit donc pas
  /// faire avancer la barre — ni compter dans le total.
  #[test]
  fn a_blank_turn_weighs_nothing_in_the_bar() {
    let engine = FakeEngine::default();
    let paragraphs = vec![
      paragraph(0, 10, "   "),
      long_paragraph(50),
      paragraph(20, 30, "\n\t"),
      long_paragraph(50),
    ];
    let (_, seen) = reported(&engine, "fr", "en", &paragraphs);
    assert_eq!(seen, vec![50, 100]);
  }

  /// ⚠️ **Un transcript sans un seul caractère ne divise pas par zéro**, et ne reste pas figé à
  /// zéro non plus : il n'y avait rien à traduire, donc tout est fait.
  #[test]
  fn a_transcript_without_a_single_character_reports_a_hundred_rather_than_dividing_by_zero() {
    let engine = FakeEngine::default();
    let paragraphs = vec![paragraph(0, 10, "  "), paragraph(10, 20, "\n")];
    let (outcome, seen) = reported(&engine, "fr", "en", &paragraphs);

    assert_eq!(seen, vec![100]);
    assert_eq!(outcome, TranscriptTranslation::Translated { paragraphs });
  }

  /// Aucun paragraphe du tout : rien à rapporter, personne n'a rien attendu.
  #[test]
  fn an_empty_transcript_reports_nothing_at_all() {
    let engine = FakeEngine::default();
    assert_eq!(reported(&engine, "fr", "en", &[]).1, Vec::<u8>::new());
  }

  /// ⚠️ **« Langue d'origine » ne rapporte aucune progression** : il n'y a pas eu de travail à
  /// faire avancer, et annoncer 100 % laisserait croire qu'on a traduit.
  #[test]
  fn the_source_language_reports_no_progress() {
    let engine = FakeEngine::default();
    assert_eq!(
      reported(&engine, "fr", "fr", &two_paragraphs()).1,
      Vec::<u8>::new()
    );
  }

  /// ⚠️ **Une sortie anticipée ne rapporte pas un dernier pourcentage** : rien de plus n'a été
  /// traduit. C'est l'écran qui retire son voile en voyant l'issue.
  #[test]
  fn an_early_exit_reports_only_what_was_really_done() {
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
          outcome,
        ],
        ..Default::default()
      };
      let paragraphs = vec![long_paragraph(50), long_paragraph(30), long_paragraph(20)];
      let (_, seen) = reported(&engine, "fr", "it", &paragraphs);
      assert_eq!(
        seen,
        vec![50],
        "le premier paragraphe est fait, le deuxième a échoué : la barre s’arrête là"
      );
    }
  }

  /// ⚠️ Annuler arrête la boucle entre deux paragraphes, et le rappel de progression est le
  /// seul endroit qui le décide : mesure et sortie ne peuvent pas diverger.
  #[test]
  fn a_cancellation_between_two_paragraphs_stops_the_loop() {
    let engine = FakeEngine::default();
    let paragraphs = vec![long_paragraph(40), long_paragraph(30), long_paragraph(30)];

    let (outcome, seen) = cancelled_at(&engine, &paragraphs, 70);

    assert_eq!(outcome, TranscriptTranslation::Cancelled);
    assert_eq!(seen, vec![40, 70], "on s’arrête au cran qui a dit non");
    assert_eq!(
      engine.seen.lock().expect("verrou").len(),
      2,
      "le troisième paragraphe ne doit plus traverser le pont"
    );
  }

  /// ⚠️ Ce qui a été traduit avant l'annulation n'est pas rendu : un demi-transcript donnerait
  /// un document moitié français moitié allemand. L'issue ne porte aucun paragraphe, et c'est
  /// l'écran qui garde ce qu'il affichait.
  #[test]
  fn what_was_translated_before_the_cancellation_is_thrown_away() {
    let engine = FakeEngine::default();
    let paragraphs = vec![long_paragraph(50), long_paragraph(50)];

    let (outcome, _) = cancelled_at(&engine, &paragraphs, 50);

    assert_eq!(
      *engine.seen.lock().expect("verrou"),
      vec!["a".repeat(50)],
      "un paragraphe a bien été traduit avant l’arrêt"
    );
    assert_eq!(
      outcome,
      TranscriptTranslation::Cancelled,
      "et il ne ressort nulle part : aucune forme « à moitié traduit » n’existe"
    );
  }

  /// ⚠️ **Un média à une seule voix ne rend qu'un paragraphe** : l'arrêt ne s'y constate qu'à la fin.
  /// On l'honore quand même — imposer un travail que l'utilisateur vient de refuser serait pire
  /// que le jeter.
  #[test]
  fn a_cancellation_seen_only_on_the_last_turn_is_still_honoured() {
    let engine = FakeEngine::default();
    let paragraphs = vec![long_paragraph(120)];

    let (outcome, seen) = cancelled_at(&engine, &paragraphs, 100);

    assert_eq!(seen, vec![100], "le seul paragraphe va jusqu’au bout, lui");
    assert_eq!(outcome, TranscriptTranslation::Cancelled);
  }

  /// Personne n'a rien demandé : le rappel dit « continue » et la traduction aboutit. C'est le
  /// contre-test des trois précédents.
  #[test]
  fn nothing_is_cancelled_when_the_reporter_says_to_carry_on() {
    let engine = FakeEngine::default();
    let (outcome, _) = cancelled_at(&engine, &two_paragraphs(), u8::MAX);
    assert!(matches!(outcome, TranscriptTranslation::Translated { .. }));
  }

  /// ⚠️ **Une paire absente est une issue NOMINALE**, et on abandonne dès qu'on l'apprend :
  /// son état ne changera pas au paragraphe suivant.
  #[test]
  fn a_missing_pair_stops_after_the_first_turn() {
    let engine = FakeEngine {
      scripted: vec![TranslationOutcome::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      }],
      ..Default::default()
    };
    let outcome = translate(&engine, "fr", "it", &two_paragraphs()).expect("pas une panne");

    assert_eq!(
      outcome,
      TranscriptTranslation::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      }
    );
    assert_eq!(
      engine.seen.lock().expect("verrou").len(),
      1,
      "vingt-cinq appels pour réapprendre la même chose seraient vingt-cinq de trop"
    );
  }

  #[test]
  fn an_unsupported_pair_stops_too() {
    let engine = FakeEngine {
      scripted: vec![TranslationOutcome::PairUnsupported {
        source: "fr".into(),
        target: "pt".into(),
      }],
      ..Default::default()
    };
    assert_eq!(
      translate(&engine, "fr", "pt", &two_paragraphs()).expect("pas une panne"),
      TranscriptTranslation::PairUnsupported {
        source: "fr".into(),
        target: "pt".into(),
      }
    );
  }

  /// Une paire peut se révéler absente **en cours de route** si le premier paragraphe était vide :
  /// le chemin n'est alors pas le même, et il doit se comporter pareil.
  #[test]
  fn a_missing_pair_found_on_a_later_turn_stops_there() {
    let engine = FakeEngine {
      scripted: vec![
        TranslationOutcome::Translated {
          text: "Hello".into(),
        },
        TranslationOutcome::PairMissing {
          source: "fr".into(),
          target: "it".into(),
        },
      ],
      ..Default::default()
    };
    let outcome = translate(&engine, "fr", "it", &two_paragraphs()).expect("pas une panne");
    assert!(matches!(outcome, TranscriptTranslation::PairMissing { .. }));
    assert_eq!(engine.seen.lock().expect("verrou").len(), 2);
  }

  /// Une vraie panne, elle, remonte en `Err` — et **intacte** : le frontend branche sur `kind`.
  #[test]
  fn a_failing_engine_surfaces_its_error_untouched() {
    let engine = FakeEngine {
      fails: true,
      ..Default::default()
    };
    let error = translate(&engine, "fr", "en", &two_paragraphs()).expect_err("une panne");
    assert_eq!(error.kind(), "native");
    assert_eq!(error.to_string(), "moteur en panne");
  }

  /// Le frontend type ces structures : le nom du genre et des champs est un contrat.
  #[test]
  fn the_wire_contract_is_camel_case() {
    let json = serde_json::to_value(TranscriptTranslation::Translated {
      paragraphs: vec![paragraph(5, 9, "Hello")],
    })
    .expect("sérialisation");
    assert_eq!(json["kind"], "translated");
    assert_eq!(json["paragraphs"][0]["startMs"], 5);
    assert_eq!(json["paragraphs"][0]["endMs"], 9);
    assert!(
      json["paragraphs"][0]["speaker"].is_null(),
      "plus aucun locuteur sur le fil"
    );

    let json = serde_json::to_value(TranscriptTranslation::PairMissing {
      source: "fr".into(),
      target: "it".into(),
    })
    .expect("sérialisation");
    assert_eq!(json["kind"], "pairMissing");

    let json = serde_json::to_value(TranscriptTranslation::PairUnsupported {
      source: "fr".into(),
      target: "it".into(),
    })
    .expect("sérialisation");
    assert_eq!(json["kind"], "pairUnsupported");

    let json = serde_json::to_value(TranscriptTranslation::Cancelled).expect("sérialisation");
    assert_eq!(json["kind"], "cancelled");
    assert!(
      json.get("paragraphs").is_none(),
      "une annulation ne porte aucun paragraphe, pas même une liste vide"
    );
  }

  /// Le schéma se relit sans perte, et un genre inconnu est **refusé** plutôt que deviné.
  #[test]
  fn an_unknown_kind_is_refused_rather_than_guessed() {
    let back: TranscriptTranslation =
      serde_json::from_str(r#"{"kind":"translated","paragraphs":[]}"#).expect("relecture");
    assert_eq!(
      back,
      TranscriptTranslation::Translated { paragraphs: vec![] }
    );

    let error = serde_json::from_str::<TranscriptTranslation>(r#"{"kind":"peutEtre"}"#)
      .expect_err("un genre inconnu doit échouer");
    assert!(error.to_string().contains("peutEtre"), "reçu : {error}");
  }

  /// Les quatre issues survivent à l'aller-retour : le pont et l'écran écrivent le même schéma
  /// chacun de son côté, et une dérive doit se voir plutôt que se deviner.
  #[test]
  fn every_outcome_survives_a_round_trip() {
    for original in [
      TranscriptTranslation::Translated {
        paragraphs: vec![paragraph(0, 10, "Hello")],
      },
      TranscriptTranslation::PairMissing {
        source: "fr".into(),
        target: "it".into(),
      },
      TranscriptTranslation::PairUnsupported {
        source: "fr".into(),
        target: "pt".into(),
      },
      TranscriptTranslation::Cancelled,
    ] {
      let json = serde_json::to_string(&original).expect("sérialisation");
      let back: TranscriptTranslation = serde_json::from_str(&json).expect("désérialisation");
      assert_eq!(back, original);
    }
  }

  /// La doublure sert aussi le contrat du trait : `availability` reste joignable sur elle.
  #[test]
  fn the_double_still_answers_for_availability() {
    let availability = FakeEngine::default().availability().expect("capacités");
    assert_eq!(availability.status("fr", "en"), Some(PairStatus::Installed));
  }
}
