//! Une **dichotomie pure** : ni FluidAudio, ni audio, ni pont. On lui donne le nombre de voix
//! visé et une façon de compter les voix à un seuil de similarité donné — plus il est bas, plus
//! il sépare —, elle rend le seuil retenu. Mesures consignées dans `docs/v2/locuteurs.md`.
//!
//! # Pièges
//!
//! - ⚠️ Le module n'a plus qu'un emploi dans le produit : écarter l'écho. [`without_slivers`] et
//!   [`fn@attribute`] protègent le filtre d'écho ([`echo`]), sans lequel chaque phrase de
//!   l'utilisateur s'écrirait deux fois dans une visio haut-parleurs actifs. Ne pas le retirer.
//! - ⚠️ Aucune valeur de seuil fixe ne convient, et c'est mesuré : sur le média de référence,
//!   0,60 → 6 voix, 0,70 → 3, 0,80 → 2. Elle serait ailleurs sur un autre média.
//! - ⚠️ `numClusters` ne sert à rien : la bibliothèque le documente comme « nombre attendu de
//!   locuteurs », il est sans effet. Seul le seuil agit. Ne pas y revenir.

pub mod attribute;
pub mod echo;
pub mod engine;

pub use attribute::attribute;

use serde::{Deserialize, Serialize};

/// Un intervalle attribué à une voix par le diariseur, **avant** toute rencontre avec le texte.
///
/// C'est la sortie brute du diariseur : il entend des voix, il ne lit rien. Le rapprochement
/// avec les mots est le travail d'[`fn@attribute`].
///
/// # Pièges
///
/// - ⚠️ Ce type ne vit pas dans `transcript` : un transcript est du texte, et n'a aucune raison de
///   connaître l'existence des voix. Il ne sert plus qu'au filtre d'écho.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationSegment {
  /// Le numéro de voix rendu par le diariseur. **Arbitraire et local au média** : rien ne
  /// garantit que la voix 1 d'une analyse soit celle de la suivante.
  pub speaker: u32,
  /// Début du segment, en millisecondes depuis le début du média.
  pub start_ms: u64,
  /// Fin du segment, en millisecondes. Borne **exclue**.
  pub end_ms: u64,
}

impl DiarizationSegment {
  /// L'instant `at` tombe-t-il dans ce segment ?
  ///
  /// Borne de début **incluse**, borne de fin **exclue** : deux segments consécutifs se
  /// touchent sans se recouvrir, et un instant n'appartient jamais à deux voix.
  pub fn contains(&self, at_ms: u64) -> bool {
    at_ms >= self.start_ms && at_ms < self.end_ms
  }

  /// La distance de `at` à ce segment — `0` s'il est dedans.
  ///
  /// Sert au **repli** de l'attribution : un mot qui ne tombe dans aucun segment vient quand
  /// même de quelqu'un, et le plus proche est le moins mauvais choix.
  pub fn distance_ms(&self, at_ms: u64) -> u64 {
    if at_ms < self.start_ms {
      self.start_ms - at_ms
    } else if at_ms >= self.end_ms {
      at_ms - self.end_ms + 1
    } else {
      0
    }
  }
}

/// La borne basse de la recherche.
///
/// # Pièges
///
/// - ⚠️ Ce ne sont pas des valeurs choisies au hasard : la bibliothèque documente sa plage utile
///   entre 0,5 et 0,9, et la mesure confirme que tout se joue dedans — à 0,80 le média de
///   référence tombait déjà à deux voix, à 0,60 il en trouvait six.
pub const LOWEST_THRESHOLD: f64 = 0.5;
/// La borne haute de la recherche. Voir [`LOWEST_THRESHOLD`].
pub const HIGHEST_THRESHOLD: f64 = 0.9;

/// Le seuil de la détection automatique, quand personne n'a dit combien de voix attendre.
///
/// Fixe et du côté bas de la plage utile, faute d'estimateur fiable : sur-segmenter laisse un
/// transcript lisible, sous-segmenter attribue du texte à la mauvaise voix sans le montrer.
///
/// # Pièges
///
/// - ⚠️ Retenir le nombre de voix le plus stable est faux, et c'est mesuré : sur le média de
///   référence à cinq voix réelles, le palier le plus large en désigne 6. Ne pas y revenir.
/// - ⚠️ Ce qui manque à cette valeur n'est pas un média de plus mais un média étiqueté : sept des
///   huit du corpus n'ont pas de vérité terrain. Un neuvième ne validerait rien.
pub const AUTO_THRESHOLD: f64 = 0.65;

/// Le nombre d'essais que la dichotomie s'accorde.
///
/// # Pièges
///
/// - ⚠️ Quatre essais au maximum, et c'est un budget, pas une limite technique : chaque essai
///   re-regroupe les empreintes du média entier — 1,4 s sur six minutes, davantage sur une heure.
///   Quatre suffisent à ramener une plage de 0,4 à 0,025, plus fin que ce que le diariseur
///   distingue.
pub const MAX_ATTEMPTS: usize = 4;

/// En deçà de ce temps de parole cumulé sur tout le média, une voix n'est pas une personne.
///
/// Le diariseur fabrique une voix parasite sur presque tous les médias : un tour de 1 à 3 s.
///
/// # Pièges
///
/// - ⚠️ Le fossé est mesuré : le plus long parasite tient 3,3 s, la plus courte voix réelle
///   14,2 s. Cinq secondes est posé au milieu, pas à la valeur qui échoue.
/// - ⚠️ Ne pas remonter la borne pour attraper les secondes voix de 9 à 15 s des conférences : la
///   voix réelle de 14,2 s partirait avec elles.
/// - ⚠️ Le comportement sur des voix qui se recouvrent n'a jamais été évalué.
pub const SLIVER_MS: u64 = 5_000;

/// Le fossé mesuré, figé à la compilation.
///
/// # Pièges
///
/// - ⚠️ Ce n'est pas un test mais une porte : déplacer [`SLIVER_MS`] hors du fossé empêche le
///   projet de compiler, au lieu de faire échouer une suite qu'on pourrait ignorer.
const _: () = {
  assert!(
    SLIVER_MS > 3_300,
    "sous 3,3 s, la borne laisserait passer les parasites déjà mesurés"
  );
  assert!(
    SLIVER_MS < 14_200,
    "au-dessus de 14,2 s, la borne effacerait des locuteurs réels déjà mesurés"
  );
};

/// Écarte les voix qui ne tiennent pas [`SLIVER_MS`] de parole sur l'ensemble du média.
///
/// # Pièges
///
/// - ⚠️ On ne rend jamais une liste vide à partir d'une liste pleine : sur un mémo vocal de trois
///   secondes, toutes les voix sont sous la borne. Quand plus rien ne survit, on rend l'entrée
///   telle quelle — il n'y a alors aucun parasite, seulement un média bref.
pub fn without_slivers(segments: Vec<DiarizationSegment>) -> Vec<DiarizationSegment> {
  let mut held: std::collections::BTreeMap<u32, u64> = std::collections::BTreeMap::new();
  for segment in &segments {
    *held.entry(segment.speaker).or_default() += segment.end_ms.saturating_sub(segment.start_ms);
  }

  let kept: Vec<DiarizationSegment> = segments
    .iter()
    .filter(|segment| {
      held
        .get(&segment.speaker)
        .is_some_and(|&ms| ms >= SLIVER_MS)
    })
    .cloned()
    .collect();

  if kept.is_empty() {
    return segments;
  }
  kept
}

/// Ce qu'un calibrage a trouvé.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Calibration {
  /// Le seuil retenu.
  pub threshold: f64,
  /// Le nombre de voix qu'il produit.
  pub speakers: usize,
  /// Combien d'essais il a fallu. Sert aux mesures, pas au produit.
  pub attempts: usize,
}

/// Cherche le seuil qui donne `target` voix.
///
/// `count` compte les voix à un seuil donné : c'est le seul lien avec le monde réel, passé en
/// paramètre pour que la recherche reste éprouvable sans moteur.
///
/// # Pièges
///
/// - ⚠️ La monotonie est l'hypothèse de travail, et elle est mesurée — 0,60 → 6 voix, 0,70 → 3,
///   0,80 → 2. C'est elle qui autorise une dichotomie plutôt qu'un balayage.
/// - ⚠️ On rend toujours un seuil, jamais une erreur : le meilleur trouvé, même s'il n'atteint pas
///   la cible. Un transcript imparfait reste lisible ; pas de transcript du tout, non.
pub fn calibrate(target: usize, mut count: impl FnMut(f64) -> usize) -> Calibration {
  let mut low = LOWEST_THRESHOLD;
  let mut high = HIGHEST_THRESHOLD;
  let mut best: Option<Calibration> = None;

  for attempt in 1..=MAX_ATTEMPTS {
    let threshold = (low + high) / 2.0;
    let speakers = count(threshold);
    let candidate = Calibration {
      threshold,
      speakers,
      attempts: attempt,
    };

    // ⚠️ **Le meilleur se juge sur l'écart à la cible, et les égalités vont au PREMIER
    // trouvé.** Sans cette règle, un essai plus tardif d'écart identique remplacerait le
    // précédent, et le seuil retenu dépendrait de l'ordre d'exploration plutôt que du résultat.
    let better = match best {
      None => true,
      Some(current) => distance(speakers, target) < distance(current.speakers, target),
    };
    if better {
      best = Some(candidate);
    }

    if speakers == target {
      return candidate;
    }

    // Trop de voix → il faut fusionner davantage → monter le seuil. Et l'inverse.
    if speakers > target {
      low = threshold;
    } else {
      high = threshold;
    }
  }

  best.unwrap_or(Calibration {
    threshold: AUTO_THRESHOLD,
    speakers: 0,
    attempts: 0,
  })
}

/// L'écart entre un nombre de voix trouvé et celui visé.
fn distance(speakers: usize, target: usize) -> usize {
  speakers.abs_diff(target)
}

#[cfg(test)]
mod tests {
  use super::{
    AUTO_THRESHOLD, Calibration, HIGHEST_THRESHOLD, LOWEST_THRESHOLD, MAX_ATTEMPTS, calibrate,
  };
  use std::cell::RefCell;

  /// Un diariseur imaginaire mais monotone, comme le vrai : plus le seuil monte, moins il rend
  /// de voix. Les paliers reproduisent l'allure mesurée sur le média de référence.
  fn like_the_real_one(threshold: f64) -> usize {
    match threshold {
      t if t < 0.55 => 8,
      t if t < 0.62 => 6,
      t if t < 0.68 => 5,
      t if t < 0.75 => 3,
      _ => 2,
    }
  }

  #[test]
  fn it_finds_the_threshold_that_gives_the_asked_number_of_voices() {
    let result = calibrate(5, like_the_real_one);
    assert_eq!(result.speakers, 5);
    assert!(
      (0.62..0.68).contains(&result.threshold),
      "seuil retenu : {}",
      result.threshold
    );
  }

  #[test]
  fn it_converges_within_the_budget() {
    // ⚠️ Chaque essai re-regroupe le média entier. Le budget n'est pas décoratif.
    for target in 2..=8 {
      let result = calibrate(target, like_the_real_one);
      assert!(
        result.attempts <= MAX_ATTEMPTS,
        "{target} voix a demandé {} essais",
        result.attempts
      );
    }
  }

  #[test]
  fn it_counts_its_attempts_honestly() {
    let calls = RefCell::new(0);
    let result = calibrate(5, |threshold| {
      *calls.borrow_mut() += 1;
      like_the_real_one(threshold)
    });
    assert_eq!(result.attempts, *calls.borrow());
  }

  #[test]
  fn an_unreachable_target_yields_the_closest_it_found_rather_than_nothing() {
    // ⚠️ Le cas qui compte : un média où la cible est inatteignable. Rendre une erreur
    // laisserait l'utilisateur sans transcript, alors qu'un transcript imparfait reste
    // lisible et ses locuteurs renommables.
    let result = calibrate(42, like_the_real_one);
    assert!(result.speakers > 0, "un seuil est rendu quoi qu'il arrive");
    assert_eq!(
      result.speakers, 8,
      "le plus proche de 42 est le plus grand nombre atteignable"
    );
  }

  #[test]
  fn ties_go_to_the_first_one_found() {
    // Sinon le seuil retenu dépendrait de l'ordre d'exploration et non du résultat.
    let seen = RefCell::new(Vec::new());
    let result = calibrate(4, |threshold| {
      seen.borrow_mut().push(threshold);
      // Toujours à égale distance de 4, des deux côtés en alternance.
      if seen.borrow().len() % 2 == 1 { 3 } else { 5 }
    });
    assert_eq!(result.attempts, 1, "le premier essai n'est jamais remplacé");
  }

  #[test]
  fn the_search_stays_inside_the_useful_range() {
    let seen = RefCell::new(Vec::new());
    calibrate(5, |threshold| {
      seen.borrow_mut().push(threshold);
      like_the_real_one(threshold)
    });
    for threshold in seen.borrow().iter() {
      assert!(
        (LOWEST_THRESHOLD..=HIGHEST_THRESHOLD).contains(threshold),
        "seuil essayé hors plage : {threshold}"
      );
    }
  }

  #[test]
  fn a_diariser_that_never_answers_still_yields_a_usable_threshold() {
    // Défensif : un compteur qui rendrait toujours zéro ne doit pas produire un seuil absurde.
    let result = calibrate(3, |_| 0);
    assert!((LOWEST_THRESHOLD..=HIGHEST_THRESHOLD).contains(&result.threshold));
  }

  #[test]
  #[allow(clippy::assertions_on_constants)]
  fn the_automatic_threshold_leans_towards_over_segmentation() {
    assert!((LOWEST_THRESHOLD..=HIGHEST_THRESHOLD).contains(&AUTO_THRESHOLD));
    // ⚠️ Ce test fige un parti pris, pas une valeur : le seuil automatique doit rester dans la
    // moitié basse de la plage. L'assertion porte sur des constantes, et clippy le signale —
    // c'est le but : ce qu'on protège est une intention, pas un calcul.
    assert!(
      AUTO_THRESHOLD < (LOWEST_THRESHOLD + HIGHEST_THRESHOLD) / 2.0,
      "le seuil automatique doit pencher du côté qui sur-segmente"
    );
    let unused = Calibration {
      threshold: AUTO_THRESHOLD,
      speakers: 0,
      attempts: 0,
    };
    assert_eq!(unused.attempts, 0);
  }

  /// Un segment, écrit court parce que ces tests en alignent beaucoup.
  fn segment(speaker: u32, start_ms: u64, end_ms: u64) -> super::DiarizationSegment {
    super::DiarizationSegment {
      speaker,
      start_ms,
      end_ms,
    }
  }

  #[test]
  fn a_voice_holding_barely_a_few_seconds_is_not_a_person() {
    // Le cas mesuré sur les sept médias : deux vrais locuteurs, et un artefact d'un seul tour
    // de 1,8 s — un rire, un applaudissement, un chevauchement.
    let kept = super::without_slivers(vec![
      segment(0, 0, 60_000),
      segment(1, 60_000, 120_000),
      segment(2, 120_000, 121_800),
    ]);

    assert_eq!(
      kept.iter().map(|s| s.speaker).collect::<Vec<_>>(),
      vec![0, 1],
      "la voix de 1,8 s doit partir, les deux autres rester"
    );
  }

  #[test]
  fn a_voice_is_judged_on_its_whole_media_not_on_one_turn() {
    // ⚠️ **Le cumul, pas le plus long tour.** Quelqu'un qui ponctue de « oui, bien sûr » n'a
    // aucun tour long, et c'est pourtant une personne réelle : la somme de ses interventions
    // le dit, le maximum de ses tours le nierait.
    let kept = super::without_slivers(vec![
      segment(0, 0, 60_000),
      segment(1, 60_000, 61_500),
      segment(1, 70_000, 71_500),
      segment(1, 80_000, 81_500),
      segment(1, 90_000, 91_500),
    ]);

    assert_eq!(
      kept.len(),
      5,
      "quatre interventions de 1,5 s font 6 s de parole : c'est quelqu'un"
    );
  }

  #[test]
  fn a_very_short_media_keeps_its_only_voice() {
    // ⚠️ **Le garde-fou qui empêche la règle de tout avaler.** Sur un mémo vocal de trois
    // secondes, *toutes* les voix sont sous la borne ; les écarter rendrait un transcript sans
    // locuteur, ce qui est pire que le défaut qu'on corrige.
    let kept = super::without_slivers(vec![segment(0, 0, 3_000)]);

    assert_eq!(
      kept.len(),
      1,
      "il n'y a pas de parasite, il y a un média bref"
    );
  }

  #[test]
  fn nothing_is_dropped_when_every_voice_carries_its_weight() {
    let segments = vec![
      segment(0, 0, 60_000),
      segment(1, 60_000, 120_000),
      segment(0, 120_000, 180_000),
    ];

    assert_eq!(super::without_slivers(segments.clone()), segments);
  }

  #[test]
  fn an_empty_diarization_stays_empty() {
    assert!(super::without_slivers(Vec::new()).is_empty());
  }

  // ⚠️ Le fossé mesuré n'est pas éprouvé ici mais **à la compilation**, juste sous la définition
  // de `SLIVER_MS` : une assertion sur deux constantes n'a pas besoin d'attendre l'exécution, et
  // une porte qu'on ne peut pas franchir vaut mieux qu'un test qu'on peut ignorer.
}
