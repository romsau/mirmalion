//! L'écho reconnu au texte, et non à la voix.
//!
//! Sur haut-parleurs, le micro réentend les interlocuteurs. `diarization::echo` répond à cela par
//! l'identité de voix, ce qui exige une diarisation — en direct elle n'existe pas. La question
//! posée ici ne demande aucun signal : ce que le micro vient d'écrire, le flux système ne
//! vient-il pas de l'écrire aussi ? Module pur : deux textes entrent, un verdict sort.
//!
//! # Pièges
//!
//! - ⚠️ Deux flux simultanés qui portent la même phrase, c'est un écho mécaniquement : le même
//!   énoncé transcrit deux fois, pas une ressemblance acoustique qu'on interprète.
//! - ⚠️ Les deux moteurs ne découpent pas aux mêmes endroits : on mesure combien du micro se
//!   retrouve dans le système, pas combien les deux se ressemblent — une distance d'édition
//!   normalisée par la longueur s'effondrerait sur ce décalage. Et des trigrammes de caractères,
//!   pas de mots : les deux moteurs ne posent pas les frontières de mot aux mêmes endroits.

use crate::transcript::Word;

/// La part du micro qu'il faut retrouver côté système pour parler d'écho.
///
/// # Pièges
///
/// - ⚠️ Ce seuil n'est pas posé sur un fossé mesuré, contrairement à
///   [`crate::diarization::echo::ECHO_DISTANCE`] : il est posé haut, par prudence, sur un seul
///   exemple. La mesure viendra du journal, où chaque comparaison rapporte son taux.
/// - ⚠️ Le sens de l'erreur commande la hauteur : trop bas garde un doublon, visible et sans
///   gravité ; trop haut efface une réplique de l'utilisateur, et personne ne s'aperçoit de ce
///   qui manque.
pub const SAME_UTTERANCE: f64 = 0.85;

/// En deçà de cette longueur, on ne conclut pas.
///
/// # Pièges
///
/// - ⚠️ « Oui », « d'accord », « voilà » se ressemblent tous et n'ont rien à voir : sur trois
///   mots, un recouvrement élevé est le vocabulaire courant d'une session, pas une preuve.
///   Écarter là-dessus supprimerait les acquiescements de l'utilisateur.
pub const ENOUGH_CHARS: usize = 24;

/// Combien de temps un énoncé du système reste comparable.
///
/// # Pièges
///
/// - ⚠️ L'écho est simultané : le décalage entre les deux flux se compte en dixièmes de seconde.
///   Une fenêtre large ferait passer pour de l'écho une phrase que l'utilisateur répète après
///   coup, ce qu'il a le droit de faire.
pub const RECENT_MS: u64 = 12_000;

/// Réduit un texte à ce qui se compare : minuscules, et rien que des lettres et des chiffres.
///
/// # Pièges
///
/// - ⚠️ La ponctuation part, les accents restent : les deux moteurs ponctuent différemment le
///   même énoncé, c'est du bruit ; les accents, eux, distinguent des mots.
fn normalised(text: &str) -> Vec<char> {
  let mut folded: Vec<char> = Vec::with_capacity(text.len());
  let mut spaced = false;
  for character in text.chars() {
    if character.is_alphanumeric() {
      folded.extend(character.to_lowercase());
      spaced = false;
    } else if !spaced && !folded.is_empty() {
      folded.push(' ');
      spaced = true;
    }
  }
  while folded.last() == Some(&' ') {
    folded.pop();
  }
  folded
}

/// Les trigrammes de caractères d'un texte déjà normalisé.
fn trigrams(folded: &[char]) -> Vec<[char; 3]> {
  folded
    .windows(3)
    .map(|window| [window[0], window[1], window[2]])
    .collect()
}

/// Quelle part de `candidate` se retrouve dans `reference` : 0 pour rien, 1 pour tout.
///
/// # Pièges
///
/// - ⚠️ Asymétrique, et c'est voulu : on demande si le micro est contenu dans le système, pas si
///   les deux se ressemblent. Un segment système deux fois plus long n'est pas une objection,
///   c'est le cas courant.
pub fn coverage(candidate: &str, reference: &str) -> f64 {
  let candidate = trigrams(&normalised(candidate));
  if candidate.is_empty() {
    return 0.0;
  }
  let reference: std::collections::HashSet<[char; 3]> =
    trigrams(&normalised(reference)).into_iter().collect();
  let found = candidate
    .iter()
    .filter(|trigram| reference.contains(*trigram))
    .count();
  found as f64 / candidate.len() as f64
}

/// Un énoncé du flux système, tel qu'on le garde pour comparaison.
#[derive(Debug, Clone)]
pub struct Heard {
  /// Le texte de l'énoncé, tel que le moteur l'a rendu.
  pub text: String,
  /// L'instant de l'énoncé, en millisecondes, sur la même horloge que celui qu'on lui compare.
  pub at_ms: u64,
}

/// Ce que le micro vient d'écrire est-il l'écho d'un énoncé récent du système ?
///
/// Rend la couverture retenue quand c'en est un, `None` sinon — le nombre sert au journal, qui
/// permettra de poser le seuil sur une mesure plutôt que sur un exemple.
///
/// # Pièges
///
/// - ⚠️ On n'écarte que sur preuve positive : un texte trop court, une liste vide, une fenêtre
///   dépassée ne sont pas de l'écho. Garder un doublon se voit et s'oublie ; effacer la seule
///   réplique de l'utilisateur ne se voit pas du tout.
pub fn echoes(said: &str, at_ms: u64, heard: &[Heard]) -> Option<f64> {
  weigh(said, at_ms, heard).filter(|found| *found >= SAME_UTTERANCE)
}

/// La couverture, sans appliquer le seuil. C'est ce que le journal rapporte.
///
/// La comparaison porte sur la fenêtre entière, pas sur chaque énoncé séparément : quand le micro
/// écrit « A B » d'un bloc là où le système a produit « A » puis « B », comparer énoncé par
/// énoncé donne deux fois la moitié de la couverture et jamais le seuil. [`without_echo`] joint
/// de même les mots de sa fenêtre — les deux chemins posent la même question.
///
/// # Pièges
///
/// - ⚠️ Une référence plus longue offre plus de trigrammes, donc plus de chances d'y trouver les
///   siens par hasard. C'est [`RECENT_MS`] qui tient ce risque : ne pas l'élargir sans mesure.
pub fn weigh(said: &str, at_ms: u64, heard: &[Heard]) -> Option<f64> {
  if normalised(said).len() < ENOUGH_CHARS {
    return None;
  }
  let recent: Vec<&str> = heard
    .iter()
    .filter(|earlier| at_ms.abs_diff(earlier.at_ms) <= RECENT_MS)
    .map(|earlier| earlier.text.as_str())
    .collect();
  (!recent.is_empty()).then(|| coverage(said, &recent.join(" ")))
}

/// En deçà, une couverture n'apprend rien et ne mérite pas une ligne de journal.
///
/// # Pièges
///
/// - ⚠️ Ce qui se journalise est la zone grise, et c'est elle qui posera le seuil :
///   [`SAME_UTTERANCE`] repose sur un seul exemple, et rapporter les seuls écartés ne montre
///   qu'une des deux populations. Tout journaliser noierait le terminal — les hypothèses
///   défilent plusieurs fois par seconde.
pub const WORTH_REPORTING: f64 = 0.5;

/// Ce que le micro dit est-il l'écho de ce que le système est en train de dire ?
///
/// Sans fenêtre de temps, parce que les deux sont « maintenant » : [`echoes`] compare à des
/// énoncés acquis, donc datés, là où les deux textes sont ici des hypothèses en cours. Deux
/// moteurs qui révisent leur hypothèse en même temps parlent du même instant, et le doublon
/// disparaît de l'écran sans attendre qu'ils aient finalisé.
///
/// # Pièges
///
/// - ⚠️ Le seuil s'applique chez l'appelant, comme pour [`weigh`] : c'est ce qui permet de
///   journaliser aussi ce qui a failli être écarté.
pub fn coverage_now(said: &str, reference: &str) -> Option<f64> {
  (normalised(said).len() >= ENOUGH_CHARS).then(|| coverage(said, reference))
}

/// Le silence à partir duquel deux mots appartiennent à deux énoncés différents.
///
/// Six cents millisecondes, c'est la respiration entre deux phrases, pas la pause entre deux mots.
///
/// # Pièges
///
/// - ⚠️ On compare des énoncés, pas des mots : mot à mot, « le » se retrouve partout et rien ne
///   se décide ; à l'échelle d'une phrase, la coïncidence disparaît.
pub const UTTERANCE_GAP_MS: u64 = 600;

/// De combien on élargit la fenêtre du système autour d'un énoncé du micro.
///
/// # Pièges
///
/// - ⚠️ Les deux moteurs ne tombent pas d'accord sur les bornes : deux `SpeechAnalyzer`
///   indépendants découpent le même énoncé à des instants différents. Sans marge, la couverture
///   s'effondrerait pour une raison étrangère au contenu.
/// - ⚠️ Elle reste étroite : au-delà, on comparerait à ce qui a été dit avant et après, donc on
///   trouverait des ressemblances qui ne sont pas des échos.
pub const ALIGNMENT_SLACK_MS: u64 = 2_000;

/// Découpe une suite de mots en énoncés, aux silences, et rend des plages d'indices.
fn utterances(words: &[Word]) -> Vec<std::ops::Range<usize>> {
  let mut cuts: Vec<std::ops::Range<usize>> = Vec::new();
  let mut start = 0;
  for index in 1..words.len() {
    if words[index]
      .start_ms
      .saturating_sub(words[index - 1].end_ms)
      > UTTERANCE_GAP_MS
    {
      cuts.push(start..index);
      start = index;
    }
  }
  if start < words.len() {
    cuts.push(start..words.len());
  }
  cuts
}

/// Les mots du micro débarrassés de ce que le système disait au même moment.
///
/// Rend les mots gardés et combien d'énoncés ont été écartés — ce second nombre est pour le
/// journal : sans lui, « le micro n'a rien capté » et « tout a été pris pour de l'écho » se
/// ressemblent trait pour trait. Les deux transcriptions sont entières et horodatées.
///
/// # Pièges
///
/// - ⚠️ On n'écarte que sur preuve positive : un énoncé trop court, ou un système muet à cet
///   instant, ne prouvent rien. Garder un doublon se voit ; effacer la seule intervention de
///   l'utilisateur ne se voit pas.
pub fn without_echo(mine: &[Word], theirs: &[Word]) -> (Vec<Word>, usize) {
  let mut kept: Vec<Word> = Vec::with_capacity(mine.len());
  let mut dropped = 0;

  for range in utterances(mine) {
    let said = mine[range.clone()]
      .iter()
      .map(|word| word.text.as_str())
      .collect::<Vec<_>>()
      .join(" ");

    // La fenêtre du système autour de cet énoncé, marge comprise.
    let from = mine[range.start]
      .start_ms
      .saturating_sub(ALIGNMENT_SLACK_MS);
    let until = mine[range.end - 1].end_ms + ALIGNMENT_SLACK_MS;
    let against = theirs
      .iter()
      .filter(|word| word.end_ms >= from && word.start_ms <= until)
      .map(|word| word.text.as_str())
      .collect::<Vec<_>>()
      .join(" ");

    let long_enough = normalised(&said).len() >= ENOUGH_CHARS;
    if long_enough && coverage(&said, &against) >= SAME_UTTERANCE {
      dropped += 1;
      continue;
    }
    kept.extend_from_slice(&mine[range]);
  }

  (kept, dropped)
}

#[cfg(test)]
mod tests {
  use super::{
    ENOUGH_CHARS, Heard, SAME_UTTERANCE, UTTERANCE_GAP_MS, Word, coverage, echoes, normalised,
    without_echo,
  };

  /// Des mots horodatés, écrits court : un mot toutes les 400 ms à partir de `from`.
  fn spoken(from: u64, text: &str) -> Vec<Word> {
    text
      .split_whitespace()
      .enumerate()
      .map(|(index, word)| Word {
        text: word.to_owned(),
        start_ms: from + index as u64 * 400,
        end_ms: from + index as u64 * 400 + 300,
      })
      .collect()
  }

  fn joined(words: &[Word]) -> String {
    words
      .iter()
      .map(|word| word.text.as_str())
      .collect::<Vec<_>>()
      .join(" ")
  }

  /// ⚠️ Le cas qui protège le compte rendu : un transcript où chaque phrase figure deux fois
  /// donne un compte rendu qui radote.
  #[test]
  fn what_the_system_said_at_the_same_moment_is_dropped_from_the_microphone() {
    let theirs = spoken(1_000, SYSTEM);
    let mine = spoken(1_150, MICROPHONE);

    let (kept, dropped) = without_echo(&mine, &theirs);
    assert_eq!(dropped, 1);
    assert!(kept.is_empty(), "{}", joined(&kept));
  }

  /// ⚠️ **Le cas qui compte le plus** : ce que l'utilisateur seul a dit reste, intégralement.
  #[test]
  fn what_the_user_alone_said_survives_untouched() {
    let theirs = spoken(1_000, SYSTEM);
    let mine = spoken(
      1_150,
      "Je pense qu'on devrait reporter la démonstration à la semaine prochaine",
    );

    let (kept, dropped) = without_echo(&mine, &theirs);
    assert_eq!(dropped, 0);
    assert_eq!(kept.len(), mine.len());
  }

  /// ⚠️ Un écho et une vraie réplique dans le même flux : seul l'écho part. C'est tout l'intérêt
  /// de découper aux silences plutôt que de juger le flux entier d'un bloc.
  #[test]
  fn only_the_echoed_utterance_leaves_when_the_user_also_spoke() {
    let theirs = spoken(1_000, SYSTEM);
    let mut mine = spoken(1_150, MICROPHONE);
    let last = mine.last().expect("un mot").end_ms;
    mine.extend(spoken(
      last + UTTERANCE_GAP_MS * 3,
      "Je note tout ça et je vous renvoie un résumé demain matin",
    ));

    let (kept, dropped) = without_echo(&mine, &theirs);
    assert_eq!(dropped, 1);
    assert!(joined(&kept).starts_with("Je note"), "{}", joined(&kept));
  }

  /// ⚠️ Les deux moteurs ne tombent pas d'accord sur les bornes : un décalage d'une seconde entre
  /// les deux transcriptions du même énoncé ne doit rien changer au verdict — sans marge, la
  /// couverture s'effondrerait pour une raison étrangère au contenu.
  #[test]
  fn a_second_of_drift_between_the_engines_changes_nothing() {
    let theirs = spoken(1_000, SYSTEM);
    let (_, dropped) = without_echo(&spoken(2_000, MICROPHONE), &theirs);
    assert_eq!(dropped, 1);
  }

  /// ⚠️ **Un système muet ne fait disparaître personne** : sans rien à cet instant, rien à
  /// prouver.
  #[test]
  fn nothing_is_dropped_when_the_system_was_silent_at_that_moment() {
    let (kept, dropped) = without_echo(&spoken(1_000, MICROPHONE), &[]);
    assert_eq!(dropped, 0);
    assert_eq!(kept.len(), spoken(1_000, MICROPHONE).len());
  }

  /// ⚠️ **Un énoncé trop court ne tranche rien**, ici comme en direct : « Oui, d'accord » est le
  /// vocabulaire courant d'une session, pas une preuve.
  #[test]
  fn a_short_utterance_is_never_enough_to_decide() {
    let theirs = spoken(1_000, "Oui d'accord");
    let (kept, dropped) = without_echo(&spoken(1_050, "Oui d'accord"), &theirs);
    assert_eq!(dropped, 0);
    assert_eq!(kept.len(), 2);
  }

  /// ⚠️ **Ce que le système a dit bien plus tard n'est pas de l'écho** — la fenêtre est étroite
  /// exprès, sinon on trouverait des ressemblances partout dans une session d'une heure.
  #[test]
  fn the_same_words_much_later_are_not_an_echo() {
    let theirs = spoken(600_000, SYSTEM);
    let (_, dropped) = without_echo(&spoken(1_000, MICROPHONE), &theirs);
    assert_eq!(dropped, 0);
  }

  /// Sans un mot au micro, il n'y a rien à faire et rien à écarter.
  #[test]
  fn a_silent_microphone_yields_nothing_and_drops_nothing() {
    assert_eq!(without_echo(&[], &spoken(0, SYSTEM)).1, 0);
    assert!(without_echo(&[], &spoken(0, SYSTEM)).0.is_empty());
  }

  /// Les deux phrases de la capture du porteur, au caractère près.
  const SYSTEM: &str =
    "Même si j'ai des joueurs de qualité sur le bain, la blessure de Saliba, plus";
  const MICROPHONE: &str =
    "même si j'ai des joueurs de qualité sur le banc, la blessure de Saliba, plus";

  fn heard(text: &str, at_ms: u64) -> Heard {
    Heard {
      text: text.to_owned(),
      at_ms,
    }
  }

  /// ⚠️ Le cas réel, celui qui justifie tout le module : deux moteurs, un seul énoncé, deux
  /// transcriptions qui diffèrent d'un mot et d'une majuscule.
  #[test]
  fn the_same_sentence_heard_twice_is_an_echo() {
    let found = echoes(MICROPHONE, 4_000, &[heard(SYSTEM, 3_900)]);
    assert!(
      found.is_some_and(|coverage| coverage >= SAME_UTTERANCE),
      "la capture du 2026-08-06 doit être reconnue : {found:?}"
    );
  }

  /// ⚠️ **Le cas qui compte le plus** : l'utilisateur parle, et personne d'autre n'a dit cela.
  #[test]
  fn what_the_user_alone_said_is_never_an_echo() {
    assert_eq!(
      echoes(
        "Je pense qu'on devrait reporter la démonstration à la semaine prochaine",
        4_000,
        &[heard(SYSTEM, 3_900)]
      ),
      None
    );
  }

  /// ⚠️ Les deux moteurs ne découpent pas aux mêmes endroits : un segment micro qui ne couvre que
  /// la moitié du segment système reste un écho, la mesure étant asymétrique.
  #[test]
  fn a_shorter_microphone_segment_is_still_an_echo() {
    let half = "Même si j'ai des joueurs de qualité sur le banc";
    assert!(echoes(half, 4_000, &[heard(SYSTEM, 3_950)]).is_some());
  }

  /// ⚠️ « Oui », « d'accord », « voilà » ne prouvent rien : sur trois mots, un recouvrement élevé
  /// est le vocabulaire courant d'une session, et écarter là-dessus supprimerait les
  /// acquiescements de l'utilisateur — ce qu'il dit le plus souvent en écoutant.
  #[test]
  fn a_short_agreement_is_never_enough_to_decide() {
    assert_eq!(
      echoes("Oui, d'accord.", 4_000, &[heard(SYSTEM, 3_900)]),
      None
    );
    assert_eq!(
      echoes("Oui, d'accord.", 4_000, &[heard("Oui, d'accord !", 3_900)]),
      None,
      "même identique, c'est trop court pour trancher"
    );
  }

  /// ⚠️ **L'écho est SIMULTANÉ.** Répéter après coup ce qu'un autre a dit est une chose qu'on a
  /// le droit de faire, et elle doit rester au transcript.
  #[test]
  fn repeating_something_much_later_is_not_an_echo() {
    assert_eq!(echoes(MICROPHONE, 90_000, &[heard(SYSTEM, 3_900)]), None);
  }

  /// Sans rien à comparer, on n'écarte rien — le système n'a pas encore parlé.
  #[test]
  fn nothing_is_dropped_when_the_system_has_said_nothing() {
    assert_eq!(echoes(MICROPHONE, 4_000, &[]), None);
  }

  /// ⚠️ Le défaut qui laissait des doublons dans le texte acquis : quand le micro écrit d'un bloc
  /// ce que le système a produit en deux énoncés, comparer à chacun séparément donne deux fois la
  /// moitié de la couverture et n'atteint jamais le seuil. On compare donc à la fenêtre entière.
  #[test]
  fn an_echo_split_across_two_system_utterances_is_still_recognised() {
    let (first, second) = SYSTEM.split_at(SYSTEM.len() / 2);
    let found = echoes(
      MICROPHONE,
      4_000,
      &[heard(first, 3_800), heard(second, 3_950)],
    );
    assert!(
      found.is_some(),
      "un écho réparti sur deux énoncés reste un écho : {found:?}"
    );
  }

  /// ⚠️ Ce que l'utilisateur seul a dit résiste à la fenêtre entière : élargir la référence offre
  /// plus de trigrammes, donc plus de chances d'en retrouver par hasard, et ce coût ne doit pas
  /// mordre sur une vraie réplique.
  #[test]
  fn what_the_user_said_survives_a_wider_reference() {
    let (first, second) = SYSTEM.split_at(SYSTEM.len() / 2);
    assert_eq!(
      echoes(
        "Je pense qu'on devrait reporter la démonstration à la semaine prochaine",
        4_000,
        &[heard(first, 3_800), heard(second, 3_950)],
      ),
      None
    );
  }

  /// ⚠️ **Le meilleur des énoncés récents l'emporte**, et c'est lui qu'on rapporte : le journal
  /// doit porter la valeur qui a décidé, pas la première rencontrée.
  #[test]
  fn the_closest_recent_utterance_is_the_one_reported() {
    let found = echoes(
      MICROPHONE,
      4_000,
      &[
        heard("On parlait de tout autre chose ici, franchement", 3_800),
        heard(SYSTEM, 3_900),
      ],
    );
    assert!(found.is_some_and(|coverage| coverage > 0.9), "{found:?}");
  }

  /// La couverture est **asymétrique** : elle mesure ce qu'on retrouve du premier dans le second.
  #[test]
  fn coverage_measures_the_candidate_inside_the_reference() {
    assert_eq!(coverage("", "quoi que ce soit"), 0.0);
    assert!(coverage("des joueurs de qualité", SYSTEM) > 0.99);
    assert!(coverage(SYSTEM, "des joueurs de qualité") < 0.5);
  }

  /// La normalisation retire la ponctuation et la casse, **garde les accents**, et ne laisse ni
  /// espace en trop ni espace final.
  #[test]
  fn normalising_keeps_what_distinguishes_words_and_drops_what_does_not() {
    assert_eq!(
      normalised("  Été…  ça va ?? ").iter().collect::<String>(),
      "été ça va"
    );
  }

  /// La borne de longueur est **inclusive**, et on la fige pour que personne n'ait à deviner.
  #[test]
  fn the_length_floor_is_inclusive() {
    let exactly = "a".repeat(ENOUGH_CHARS);
    assert!(echoes(&exactly, 0, &[heard(&exactly, 0)]).is_some());
    let one_short = "a".repeat(ENOUGH_CHARS - 1);
    assert_eq!(echoes(&one_short, 0, &[heard(&one_short, 0)]), None);
  }
}
