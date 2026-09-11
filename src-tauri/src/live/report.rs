//! Le compte rendu : ses types, et le découpage du transcript qui le rend possible.
//!
//! Module pur — ni modèle, ni pont : on lui donne des tours de parole, il rend des tranches. C'est
//! ce qui rend le découpage éprouvable sans modèle, et c'est nécessaire, parce qu'un mauvais
//! découpage se lit comme une session dont on aurait oublié un quart.
//!
//! # Pièges
//!
//! - ⚠️ La fenêtre du modèle fait 4 096 tokens, une session d'une heure en fait 12 000, et il
//!   refuse au-delà. Découper est obligatoire dès ~20 minutes de contenu.
//! - ⚠️ Couper au compte de tokens dégrade le rappel : couper aux frontières de sens — tour de
//!   parole, puis phrase, puis mot en dernier recours.

use serde::{Deserialize, Serialize};

/// Les neuf types de compte rendu. Le type change les rubriques, pas le ton.
///
/// # Pièges
///
/// - ⚠️ Les identifiants existants ne bougent jamais : ils voyagent en clair dans le fichier de
///   réglages, et un renommage ferait retomber les utilisateurs sur le défaut sans le dire.
/// - ⚠️ [`ReportKind::Custom`] n'a pas de rubriques à nous : elles viennent du prompt de
///   l'utilisateur, seul gabarit à laisser la structure ouverte, donc le seul à exiger les deux
///   garde-fous de prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportKind {
  /// Sync interne : Résumé · Décisions · Tâches · Points clés / risques.
  Team,
  /// Manager ↔ collaborateur : Résumé · Points abordés · Feedback · Objectifs · Suivi.
  OneToOne,
  /// Session externe : Résumé · Besoins · Engagements · Objections · Prochaines étapes.
  Client,
  /// Un intervenant : Résumé · Notions clés · Exemples · À retenir · Références · Questions.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Pas de « décisions » ni de « tâches » : un cours n'en produit pas, et les demander
  ///   ferait inventer au modèle des engagements que personne n'a pris.
  Lecture,
  /// Génération d'idées : Résumé · Toutes les idées · Retenues · Écartées · Prochaines actions.
  Brainstorm,
  /// Le générique : Résumé · Points principaux. Aucune rubrique de métier.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Les autres types supposent tous un cadre — une réunion, un cours — et rendent des
  ///   rubriques vides dès qu'on en sort ; celui-ci marche sur n'importe quoi.
  /// - ⚠️ Une troisième rubrique, « À retenir », a été retirée : elle posait la même question que
  ///   « Points principaux », et le modèle recopiait ses puces mot pour mot sous les deux
  ///   intitulés. La liste vit côté Swift (`LanguageModel.swift`).
  Summary,
  /// Vidéo ou podcast : Résumé · Sujets traités · Points marquants · À retenir · Références.
  Media,
  /// Entretien : Résumé · Parcours et contexte · Points forts · Réserves · Suite à donner.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Distinct de [`ReportKind::OneToOne`] : celui-là est un point manager ↔ collaborateur
  ///   interne, avec objectifs et suivi ; celui-ci est un entretien avec quelqu'un qu'on
  ///   rencontre — recrutement, interview, étude utilisateur.
  Interview,
  /// Rubriques définies par le prompt de l'utilisateur.
  Custom,
}

impl ReportKind {
  /// L'identifiant qui traverse le pont.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Stable : il voyage aussi dans le fichier de réglages, en clair.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Team => "team",
      Self::OneToOne => "oneToOne",
      Self::Client => "client",
      Self::Lecture => "lecture",
      Self::Brainstorm => "brainstorm",
      Self::Summary => "summary",
      Self::Media => "media",
      Self::Interview => "interview",
      Self::Custom => "custom",
    }
  }
}

/// Ce qu'une tranche peut porter, en tokens estimés.
///
/// L'arithmétique, pas un chiffre rond : il faut loger `consignes + tranche + notes` dans 4 096 —
/// ~300 tokens de consignes et jusqu'à ~1 200 de notes laissent ~2 400 pour la tranche.
///
/// # Pièges
///
/// - ⚠️ Ce plafond n'est pas une garde, c'est un plan : la garde est côté Swift, qui refuse ce qui
///   ne tient pas. Les deux estimateurs sont volontairement indépendants — celui-ci répartit,
///   celui-là refuse.
pub const SLICE_TOKENS: usize = 2_400;

/// Estime le nombre de tokens d'un texte : une lettre vaut environ un quart de token.
///
/// # Pièges
///
/// - ⚠️ Le sens de l'erreur est choisi : estimer par excès, jamais par défaut. Une sous-estimation
///   fait bâtir une tranche que le modèle refusera, et c'est le `+ 1` final qui tient ce biais sur
///   les textes courts.
/// - ⚠️ Des caractères, pas des octets : `len()` compterait deux fois chaque lettre accentuée, et
///   surestimerait de moitié une session française.
pub fn estimated_tokens(text: &str) -> usize {
  text.chars().count() / 4 + 1
}

/// Ce que la rédaction peut recevoir de notes, en tokens estimés.
///
/// # Pièges
///
/// - ⚠️ **Rien ne le bornait, et c'était le défaut** : les notes croissent avec la durée — ~1 000
///   tokens par tranche —, la passe de rédaction est unique et son plafond fixe. Au-delà de deux
///   tranches et demie, soit ~25 minutes, le pont refusait la rédaction : aucune session longue
///   ne rendait de compte rendu.
/// - ⚠️ Sous le plafond du pont, jamais égal : les deux estimateurs restent indépendants, celui-ci
///   répartit, celui-là refuse.
pub const NOTES_BUDGET: usize = 2_400;

/// Ce qu'un prompt libre peut peser, en tokens estimés.
///
/// # Pièges
///
/// - ⚠️ Le miroir de `MAX_PROMPT_LENGTH` (`commands/prompts.rs`, 2 000 caractères) dans l'unité
///   qui compte ici. Les deux se regardent : un test le vérifie.
pub const MAX_PROMPT_TOKENS: usize = 501;

/// Ce que les notes peuvent peser une fois la place du prompt libre réservée.
///
/// # Pièges
///
/// - ⚠️ **Le prompt entre dans la MÊME consigne que les notes**, et il n'était compté nulle
///   part : au plafond il ajoute ~500 tokens à une passe déjà calée au plus juste, et le modèle
///   rendait `exceededContextWindowSize` — un compte rendu en échec, sans rien pour l'annoncer.
/// - ⚠️ Le plafonnement n'est pas décoratif : la condensation boucle tant que la matière dépasse
///   le budget, et un budget nul ne se réduirait jamais assez. Un prompt plus gros que ce que
///   `MAX_PROMPT_LENGTH` autorise ne peut donc rien prendre de plus.
pub fn notes_budget(custom: Option<&str>) -> usize {
  // ⚠️ Le vide ne coûte rien, et il faut l'écrire : `estimated_tokens` estime par EXCÈS et rend
  // 1 sur une chaîne vide. Sans ce filtre, un compte rendu sans prompt payait un token.
  let asked = custom
    .filter(|prompt| !prompt.is_empty())
    .map_or(0, estimated_tokens);
  NOTES_BUDGET - asked.min(MAX_PROMPT_TOKENS)
}

/// Regroupe des notes en lots tenant chacun sous `budget`.
///
/// Une note plus grosse que le budget à elle seule forme son propre lot : la condenser reste
/// utile, et refuser de la traiter la perdrait.
fn batched(notes: &[String], budget: usize) -> Vec<String> {
  let mut lots: Vec<String> = Vec::new();
  let mut current = String::new();
  for note in notes {
    if !current.is_empty() && estimated_tokens(&current) + estimated_tokens(note) > budget {
      lots.push(std::mem::take(&mut current));
    }
    if !current.is_empty() {
      current.push_str("\n\n");
    }
    current.push_str(note);
  }
  if !current.is_empty() {
    lots.push(current);
  }
  lots
}

/// Assemble les notes qui tiennent sous `budget`, en abandonnant celles qui débordent.
///
/// # Pièges
///
/// - ⚠️ **Elle perd du contenu, et c'est le dernier recours** : elle n'est appelée que si un tour
///   de condensation n'a rien réduit. Un compte rendu amputé de sa fin vaut mieux qu'un refus,
///   mais l'abandon se journalise — il ne doit pas devenir ordinaire sans que rien ne le dise.
fn fitting(notes: &[String], budget: usize) -> String {
  let mut kept = String::new();
  for note in notes {
    if !kept.is_empty() && estimated_tokens(&kept) + estimated_tokens(note) > budget {
      break;
    }
    if !kept.is_empty() {
      kept.push_str("\n\n");
    }
    kept.push_str(note);
  }
  kept
}

/// Le compte rendu est-il écrit dans une autre langue que la session ?
///
/// `detected` est ce que le détecteur a reconnu, `None` quand il n'a pas tranché.
///
/// # Pièges
///
/// - ⚠️ **Le doute ne refait rien** : `None` rend `false`. Refaire la passe la plus longue sur une
///   incertitude coûterait cher sans garantir mieux.
/// - ⚠️ On compare des langues, pas des étiquettes : la session peut dire `fr-FR` quand le
///   détecteur dit `fr`. Les comparer bruts referait toutes les passes de ces sessions-là.
fn written_in_another_language(detected: Option<&str>, expected: &str) -> bool {
  fn base(code: &str) -> String {
    code
      .split(['-', '_'])
      .next()
      .unwrap_or(code)
      .to_ascii_lowercase()
  }
  detected.is_some_and(|detected| base(detected) != base(expected))
}

/// Découpe les tours de parole en tranches, aux frontières de sens.
///
/// `turns` porte le texte de chaque tour, dans l'ordre. Chaque tranche tient sous [`SLICE_TOKENS`],
/// sauf s'il existe un mot plus long à lui seul : on rend alors ce mot plutôt que rien.
///
/// # Pièges
///
/// - ⚠️ Une session courte rend une tranche, et c'est le cas nominal : une passe unique donne un
///   meilleur compte rendu que deux passes suivies d'une synthèse.
pub fn slices(turns: &[String]) -> Vec<String> {
  let mut slices: Vec<String> = Vec::new();
  let mut current = String::new();

  for turn in turns {
    for piece in split_to_fit(turn) {
      let would_be = estimated_tokens(&current) + estimated_tokens(&piece);
      if !current.is_empty() && would_be > SLICE_TOKENS {
        slices.push(std::mem::take(&mut current));
      }
      if !current.is_empty() {
        current.push_str("\n\n");
      }
      current.push_str(&piece);
    }
  }

  if !current.is_empty() {
    slices.push(current);
  }
  slices
}

/// Découpe un tour trop long, d'abord aux phrases, puis aux mots.
///
/// # Pièges
///
/// - ⚠️ Un tour tient presque toujours en un morceau : ce découpage ne sert qu'au monologue — une
///   conférence, un exposé — où un seul « tour » peut faire des milliers de mots.
fn split_to_fit(turn: &str) -> Vec<String> {
  if estimated_tokens(turn) <= SLICE_TOKENS {
    return vec![turn.to_owned()];
  }

  let mut pieces: Vec<String> = Vec::new();
  let mut current = String::new();
  for sentence in sentences(turn) {
    if estimated_tokens(&current) + estimated_tokens(&sentence) > SLICE_TOKENS
      && !current.is_empty()
    {
      pieces.push(std::mem::take(&mut current));
    }
    // ⚠️ Une phrase à elle seule trop longue est coupée aux mots — dernier recours, et il faut
    // qu'il existe : un transcript sans ponctuation (le moteur en produit sur les langues mal
    // servies) n'a qu'une phrase, et la boucle ne finirait jamais sans lui.
    if estimated_tokens(&sentence) > SLICE_TOKENS {
      pieces.extend(split_words(&sentence));
      continue;
    }
    if !current.is_empty() {
      current.push(' ');
    }
    current.push_str(sentence.trim());
  }
  if !current.is_empty() {
    pieces.push(current);
  }
  pieces
}

/// Les phrases d'un texte, ponctuation comprise.
///
/// # Pièges
///
/// # Pièges
///
/// - ⚠️ Les points de suspension comptent (`…`) : le moteur en pose en fin de tour hésitant, et
///   sans eux ces tours n'offriraient aucune frontière au découpage.
fn sentences(text: &str) -> Vec<String> {
  let mut found = Vec::new();
  let mut current = String::new();
  for character in text.chars() {
    current.push(character);
    if matches!(character, '.' | '!' | '?' | '…') {
      found.push(std::mem::take(&mut current));
    }
  }
  if !current.trim().is_empty() {
    found.push(current);
  }
  found
}

/// Coupe aux mots, puis aux caractères. Dernier recours — voir [`split_to_fit`].
///
/// # Pièges
///
/// - ⚠️ Un « mot » peut à lui seul dépasser la tranche — une URL, un tour que le moteur rend
///   d'un bloc — et `split_whitespace` rendrait alors un morceau que le modèle refuserait.
/// - ⚠️ Couper au caractère abîme une phrase, et c'est assumé : l'alternative est de ne rendre
///   aucun compte rendu sur ce transcript-là.
fn split_words(sentence: &str) -> Vec<String> {
  let mut pieces = Vec::new();
  let mut current = String::new();
  for word in sentence.split_whitespace() {
    if estimated_tokens(word) > SLICE_TOKENS {
      if !current.is_empty() {
        pieces.push(std::mem::take(&mut current));
      }
      pieces.extend(split_characters(word));
      continue;
    }
    if !current.is_empty() && estimated_tokens(&current) + estimated_tokens(word) > SLICE_TOKENS {
      pieces.push(std::mem::take(&mut current));
    }
    if !current.is_empty() {
      current.push(' ');
    }
    current.push_str(word);
  }
  if !current.is_empty() {
    pieces.push(current);
  }
  pieces
}

/// Coupe au caractère. Il n'y a rien en dessous — voir [`split_words`].
fn split_characters(text: &str) -> Vec<String> {
  let mut pieces = Vec::new();
  let mut current = String::new();
  for character in text.chars() {
    if estimated_tokens(&current) >= SLICE_TOKENS {
      pieces.push(std::mem::take(&mut current));
    }
    current.push(character);
  }
  if !current.is_empty() {
    pieces.push(current);
  }
  pieces
}

/// L'étage demandé au modèle. Miroir de `ReportStage` côté Swift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
  /// Le *map* : une tranche → des notes fidèles.
  Notes,
  /// Le repli : des notes trop volumineuses → des notes plus courtes.
  ///
  /// # Pièges
  ///
  /// - ⚠️ C'est bien « résumer un résumé », ce que l'en-tête du module interdit ailleurs : la
  ///   consigne des notes parle d'un transcript, celle-ci de notes. Les confondre ferait
  ///   présenter des notes comme du verbatim, et le modèle les recopierait.
  Condense,
  /// Le *reduce* : des notes → le compte rendu.
  Report,
}

impl Stage {
  /// L'identifiant de l'étage tel que le pont l'attend.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Notes => "notes",
      Self::Condense => "condense",
      Self::Report => "report",
    }
  }
}

/// Compose le compte rendu d'une session : des notes par tranche, puis une rédaction.
///
/// `ask` est le seul lien avec le modèle ; `step`, appelé avant chaque passe avec l'étape, le
/// nombre de passes faites et le total, répond aussi « faut-il continuer ? ».
///
/// # Errors
///
/// Rend l'erreur du modèle si aucune tranche ne rend de notes, ou si la rédaction échoue.
///
/// # Pièges
///
/// - ⚠️ `Ok(None)` dit que l'utilisateur a renoncé : c'est une issue, pas une panne, et l'appelant
///   ne range rien — un `Vec` vide effacerait le compte rendu d'avant sur une régénération.
pub fn compose(
  turns: &[String],
  language: &str,
  custom: Option<&str>,
  mut ask: impl FnMut(Stage, &str) -> Result<String, crate::error::AppError>,
  mut step: impl FnMut(Stage, usize, usize) -> bool,
  detect: impl Fn(&str) -> Option<String>,
) -> Result<Option<Vec<ReportSection>>, crate::error::AppError> {
  // ⚠️ Le prompt libre entre dans la consigne de RÉDACTION, à côté des notes : c'est leur budget
  // qui lui cède la place, pas celui des tranches — l'étage de notes ne le voit jamais.
  let budget = notes_budget(custom);
  let cut = slices(turns);
  let Some(first) = cut.first() else {
    return Ok(Some(Vec::new()));
  };
  // La rédaction est une passe comme les autres : `N` notes plus une. Le compte est exact dès
  // ici, il n'est pas estimé — le compte rendu s'exécute sur un document déjà consolidé.
  // ⚠️ Mouvant, et il le faut : les tours de condensation ne se comptent qu'une fois les notes
  // écrites, leur volume n'étant pas connu d'avance. La barre avance donc moins vite qu'annoncé
  // sur une session longue, plutôt que de dépasser son propre total.
  let mut total = cut.len() + 1;
  let mut done = cut.len();

  // ⚠️ Toujours condenser, même sur une seule tranche. Passer le verbatim directement à la
  // rédaction en le présentant comme des « notes » faisait recopier le transcript sous « Résumé »
  // — c'est la réponse la plus fidèle à ce qu'on demande à un modèle quand on ne lui a jamais
  // fait condenser. C'est à l'étape de notes que le résumé se fait ; la seconde met en forme.
  let _ = first;
  let mut notes: Vec<String> = Vec::new();
  let mut refused: Option<crate::error::AppError> = None;
  for (index, slice) in cut.iter().enumerate() {
    // ⚠️ Le même rappel mesure la progression et répond « faut-il continuer ? » : un second
    // endroit qui relirait un drapeau serait un endroit de plus à oublier. On sort entre deux
    // passes, jamais au milieu d'une — le pont ne sait pas interrompre une génération en cours,
    // et une passe dure quelques secondes : c'est le délai d'observation.
    if !step(Stage::Notes, index, total) {
      return Ok(None);
    }
    let mut written = ask(Stage::Notes, slice);
    if let Err(refusal) = &written {
      // ⚠️ Journalisé même quand la reprise aboutit : un refus qui se soigne tout seul ne se voit
      // nulle part ailleurs, et c'est lui qui dirait qu'une cause devient fréquente.
      log::warn!(
        "tranche {}/{} refusée, on retente : {refusal}",
        index + 1,
        cut.len()
      );
      // ⚠️ Le modèle refuse parfois une passe qu'il accepte à la seconde demande, et un refus
      // passager coûterait sinon tout le compte rendu. Une seule reprise : refuser deux fois est
      // une raison, pas un hasard, et insister ferait attendre une passe de plus.
      //
      // ⚠️ Le rappel décide encore : renoncer pendant la reprise l'arrête, la reprise étant une
      // passe comme les autres.
      if !step(Stage::Notes, index, total) {
        return Ok(None);
      }
      written = ask(Stage::Notes, slice);
    }
    match written {
      Ok(written) => notes.push(written),
      // ⚠️ Le message du refus, et non son seul genre : « native » ne nomme aucune cause, et
      // c'est ce qui a rendu un premier incident indiagnosticable. Les messages qui arrivent ici
      // viennent tous du pont, qui ne porte aucun contenu de session — voir `logging.rs`.
      Err(error) => {
        log::warn!(
          "tranche {}/{} non résumée, reprise comprise : {error}",
          index + 1,
          cut.len()
        );
        refused = Some(error);
      }
    }
  }
  if notes.is_empty() {
    // ⚠️ Une tranche qui échoue n'arrête pas tout ; mais si aucune ne rend de notes, l'erreur
    // remonte — composer sur du vide inventerait le compte rendu en entier. Et c'est la cause
    // qui remonte, pas un message de remplacement : « le modèle est indisponible » dit à
    // l'utilisateur quoi faire, « aucune tranche n'a pu être résumée » ne dit rien de plus.
    return Err(refused.unwrap_or_else(|| {
      crate::error::AppError::Native("aucune tranche de la session n'a pu être résumée".into())
    }));
  }
  // ⚠️ Les notes tiennent rarement d'un coup : elles croissent avec la durée, la rédaction non.
  // On les replie par tours — des notes de notes — jusqu'à ce qu'elles tiennent.
  //
  // ⚠️ **La terminaison tient à une seule ligne** : un tour doit STRICTEMENT réduire. Un modèle
  // qui rendrait une réponse aussi grosse que sa question ferait boucler à l'infini ; on s'arrête
  // alors sur ce qui tient, en le disant.
  let mut material = notes.join("\n\n");
  let mut folded = notes;
  while estimated_tokens(&material) > budget {
    let lots = batched(&folded, budget);
    total += lots.len();
    let mut shorter = Vec::with_capacity(lots.len());
    for lot in &lots {
      if !step(Stage::Condense, done, total) {
        return Ok(None);
      }
      done += 1;
      shorter.push(ask(Stage::Condense, lot)?);
    }
    let shrunk = shorter.join("\n\n");
    if estimated_tokens(&shrunk) >= estimated_tokens(&material) {
      log::warn!("un tour de condensation n'a rien réduit : la rédaction se fera sur ce qui tient");
      material = fitting(&shorter, budget);
      break;
    }
    material = shrunk;
    folded = shorter;
  }

  // ⚠️ La dernière sortie possible, et la rédaction est annulable elle aussi : renoncer juste
  // avant évite la passe la plus longue, celle qui lit toutes les notes d'un coup.
  if !step(Stage::Report, done, total) {
    return Ok(None);
  }

  // ⚠️ La même seconde chance qu'aux notes, et c'est ici qu'elle vaut le plus : cette passe vient
  // après toutes les autres, et la perdre ferait tout recommencer.
  let mut composed = ask(Stage::Report, &material);
  if let Err(refusal) = &composed {
    log::warn!("rédaction refusée, on retente : {refusal}");
    if !step(Stage::Report, done, total) {
      return Ok(None);
    }
    composed = ask(Stage::Report, &material);
  }

  let mut markdown = composed?;

  // ⚠️ **Le seul garde-fou déterministe sur ce que le modèle écrit.** Un compte rendu rendu dans
  // une autre langue que la session a été observé — à moitié en chinois sur une session
  // française —, et aucune consigne de prompt ne l'empêche de façon fiable.
  //
  // ⚠️ Une reprise, et la seconde sortie est gardée telle quelle : insister ferait payer trois
  // fois la passe la plus longue, et rien ne dit que la troisième vaudrait mieux. Une reprise en
  // échec laisse la première — un compte rendu dans la mauvaise langue vaut mieux qu'aucun.
  if written_in_another_language(detect(&markdown).as_deref(), language) {
    log::warn!("compte rendu écrit dans une autre langue que la session : on refait la passe");
    if !step(Stage::Report, done, total) {
      return Ok(None);
    }
    if let Ok(again) = ask(Stage::Report, &material) {
      markdown = again;
    }
  }

  let mut sections = parse(&markdown);
  // ⚠️ `language` ne sert pas à générer, mais à rattraper : quand le modèle recopie un intitulé de
  // rubrique en anglais malgré la consigne, il faut savoir dans quelle langue le réécrire. Après
  // `parse`, pas dedans — `parse` ne lit que du Markdown et ne connaît pas la session.
  for section in &mut sections {
    if let Some(label) = crate::live::headings::localised(&section.heading, language) {
      section.heading = label.to_owned();
    }
  }
  Ok(Some(sections))
}

/// Une rubrique du compte rendu, telle que l'écran la rend.
///
/// # Pièges
///
/// - ⚠️ Soit un paragraphe, soit des puces, jamais les deux : la maquette dessine `.cr-p` ou
///   `.cr-list` sous chaque `.cr-h`, et les mélanger produirait une mise en page que rien ne
///   prévoit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSection {
  pub heading: String,
  /// Les lignes de la rubrique. Une seule et `bullets: false` → un paragraphe.
  pub lines: Vec<String>,
  pub bullets: bool,
}

/// Lit le Markdown du modèle et en fait des rubriques.
///
/// # Pièges
///
/// - ⚠️ Un Markdown tronqué rend ce qu'il a, et c'est toute la raison de ce format : une sortie
///   contrainte qui dépasse son budget coupe son JSON au milieu, et tout est perdu.
/// - ⚠️ Ce qui précède la première rubrique est jeté, et une rubrique vide ne survit pas : le
///   modèle ajoute parfois une phrase d'introduction, ou laisse un titre sans contenu.
pub fn parse(markdown: &str) -> Vec<ReportSection> {
  let mut sections: Vec<ReportSection> = Vec::new();
  let mut heading: Option<String> = None;
  let mut lines: Vec<String> = Vec::new();
  let mut bullets = false;

  let mut flush = |heading: &mut Option<String>, lines: &mut Vec<String>, bullets: &mut bool| {
    if let Some(title) = heading.take() {
      if !lines.is_empty() {
        sections.push(ReportSection {
          heading: title,
          lines: std::mem::take(lines),
          bullets: *bullets,
        });
      }
    }
    lines.clear();
    *bullets = false;
  };

  for raw in markdown.lines() {
    let line = raw.trim();
    if let Some(title) = line.strip_prefix("##") {
      flush(&mut heading, &mut lines, &mut bullets);
      heading = Some(without_emphasis(title.trim_start_matches('#').trim()));
      continue;
    }
    // ⚠️ Une ligne sans un seul caractère de texte n'est pas du contenu : le prompt demande
    // d'omettre une rubrique dont les notes ne disent rien, et le modèle préfère la garder et la
    // remplir d'une puce vide. Corrigé ici plutôt que par le prompt — un garde-fou déterministe
    // ne se dédit pas d'une génération à l'autre — et `flush` ne pousse que ce qui a du contenu.
    if line.is_empty() || heading.is_none() || !line.chars().any(char::is_alphanumeric) {
      continue;
    }
    // ⚠️ Trois marqueurs de puce, pas un : le modèle alterne entre `-`, `*` et `•` d'une
    // génération à l'autre, et n'en reconnaître qu'un rendrait la même session tantôt en liste,
    // tantôt en paragraphe.
    if let Some(item) = line
      .strip_prefix("- ")
      .or_else(|| line.strip_prefix("* "))
      .or_else(|| line.strip_prefix("• "))
    {
      bullets = true;
      lines.push(without_emphasis(item.trim()));
    } else {
      lines.push(without_emphasis(line));
    }
  }
  flush(&mut heading, &mut lines, &mut bullets);
  without_repeats(sections)
}

/// Retire une rubrique dont le contenu répète mot pour mot celui d'une rubrique précédente.
///
/// Le modèle recopie parfois une rubrique sous un autre intitulé : « Points principaux » et « Ce
/// qu'il faut retenir » ont porté les six mêmes puces, à la virgule près.
///
/// # Pièges
///
/// - ⚠️ On n'écarte que sur une répétition totale, jamais partielle : deux rubriques peuvent
///   légitimement partager une phrase, et en retirer une pour une ligne commune perdrait du vrai.
/// - ⚠️ C'est la première occurrence qui reste : elle porte l'intitulé que le modèle a jugé le
///   plus naturel, et c'est l'ordre du prompt.
fn without_repeats(sections: Vec<ReportSection>) -> Vec<ReportSection> {
  let mut kept: Vec<ReportSection> = Vec::with_capacity(sections.len());
  for section in sections {
    let repeats = kept.iter().any(|earlier| same_content(earlier, &section));
    if !repeats {
      kept.push(section);
    }
  }
  kept
}

/// Deux rubriques disent-elles exactement la même chose ? L'intitulé ne compte pas : c'est
/// justement lui qui diffère quand le modèle se répète.
///
/// # Pièges
///
/// - ⚠️ Il en faut au moins deux lignes : « Décisions : aucune » et « Tâches : aucune » sont deux
///   réponses vraies, et les fondre effacerait une information — la répétition observée portait
///   sur six puces.
/// - ⚠️ Le repli de casse est ASCII, donc « É » et « é » ne se rapprochent pas : au pire on garde
///   une rubrique en trop, jamais on n'en efface une qui disait autre chose.
fn same_content(left: &ReportSection, right: &ReportSection) -> bool {
  left.lines.len() >= 2
    && left.lines.len() == right.lines.len()
    && left
      .lines
      .iter()
      .zip(right.lines.iter())
      .all(|(a, b)| a.trim().eq_ignore_ascii_case(b.trim()))
}

/// Retire les marqueurs de gras et d'italique, en gardant ce qu'ils entouraient.
///
/// Le modèle décore ses titres — on demande `## Résumé`, il rend `## **Résumé**` — et l'écran
/// n'est pas un lecteur Markdown : [`ReportSection`] porte des rubriques, pas du texte à rendre.
///
/// # Pièges
///
/// - ⚠️ On n'enlève que des paires qui encadrent vraiment du texte, règle de CommonMark : sans
///   elle, « 2 * 3 * 4 » deviendrait « 2  3  4 ». Une étoile esseulée est du texte, et elle reste.
/// - ⚠️ `_` n'est pas traité, délibérément : un souligné est littéral dans les noms de fichiers
///   qu'une session cite, et le modèle écrit son gras en étoiles.
fn without_emphasis(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut rest = text;

  while let Some(start) = rest.find('*') {
    let run = rest[start..]
      .chars()
      .take_while(|mark| *mark == '*')
      .count();
    let after = start + run;
    let marker = &rest[start..after];
    // Un ouvrant colle à ce qu'il ouvre ; un fermant colle à ce qu'il ferme. Entre les deux, il
    // faut du contenu — `**` collé à `**` n'entoure rien.
    let opens = !rest[after..].starts_with(char::is_whitespace);
    let closes = opens
      .then(|| {
        rest[after..]
          .match_indices(marker)
          .find(|(offset, _)| {
            *offset > 0 && !rest[after..after + offset].ends_with(char::is_whitespace)
          })
          .map(|(offset, _)| offset)
      })
      .flatten();

    match closes {
      Some(offset) => {
        out.push_str(&rest[..start]);
        out.push_str(&rest[after..after + offset]);
        rest = &rest[after + offset + run..];
      }
      // Rien à apparier : les étoiles sont du texte, on les garde et on avance derrière elles —
      // sans quoi la boucle les retrouverait indéfiniment.
      None => {
        out.push_str(&rest[..after]);
        rest = &rest[after..];
      }
    }
  }

  out.push_str(rest);
  out
}

#[cfg(test)]
mod tests {
  use super::{
    MAX_PROMPT_TOKENS, NOTES_BUDGET, ReportKind, SLICE_TOKENS, estimated_tokens, notes_budget,
    parse, slices, written_in_another_language,
  };

  /// Un tour d'environ `tokens` tokens, en mots latins.
  fn turn(tokens: usize) -> String {
    // Quatre caractères ≈ un token ; « mot » plus l'espace en fait cinq.
    (0..tokens / 2)
      .map(|index| format!("mot{index}"))
      .collect::<Vec<_>>()
      .join(" ")
  }

  /// ⚠️ Le prompt libre mange la même fenêtre que les notes : il entre dans la consigne de
  /// rédaction, à côté d'elles, et rien ne le comptait. Au plafond il ajoute ~500 tokens à une
  /// passe calée au plus juste, et le modèle rendait `exceededContextWindowSize`.
  #[test]
  fn a_free_prompt_takes_its_room_from_the_notes() {
    let long = "a".repeat(2_000);

    assert_eq!(notes_budget(None), NOTES_BUDGET);
    assert_eq!(notes_budget(Some("")), NOTES_BUDGET);
    assert_eq!(
      notes_budget(Some(&long)),
      NOTES_BUDGET - estimated_tokens(&long)
    );
  }

  /// ⚠️ **Un prompt démesuré ne peut rien prendre de plus** : la condensation boucle tant que la
  /// matière dépasse le budget, et un budget tombé à zéro ne se réduirait jamais assez. Ce que
  /// la base accepte est le plafond, quoi qu'un appelant présente.
  #[test]
  fn no_prompt_can_take_more_than_the_database_accepts() {
    let ceiling = "a".repeat(2_000);
    let enormous = "a".repeat(100_000);

    assert_eq!(MAX_PROMPT_TOKENS, estimated_tokens(&ceiling));
    assert_eq!(notes_budget(Some(&enormous)), notes_budget(Some(&ceiling)));
    assert!(notes_budget(Some(&enormous)) >= NOTES_BUDGET / 2);
  }

  #[test]
  fn a_short_session_stays_in_one_pass() {
    let cut = slices(&[turn(100), turn(100)]);
    assert_eq!(
      cut.len(),
      1,
      "le map-reduce ne s'enclenche que s'il le faut"
    );
  }

  /// ⚠️ **Aucune tranche ne dépasse le plafond** : c'en serait une que le modèle refuserait.
  #[test]
  fn no_slice_ever_exceeds_the_budget() {
    let turns: Vec<String> = (0..20).map(|_| turn(1_000)).collect();
    let cut = slices(&turns);

    assert!(
      cut.len() > 1,
      "vingt mille tokens ne tiennent pas en une passe"
    );
    for slice in &cut {
      assert!(
        estimated_tokens(slice) <= SLICE_TOKENS,
        "tranche de {} tokens, plafond {SLICE_TOKENS}",
        estimated_tokens(slice)
      );
    }
  }

  /// ⚠️ On coupe entre deux tours, pas au milieu d'un. Un tour qui tient sous le plafond doit
  /// rester entier : le couper donnerait au modèle une demi-idée, dont il ferait une demi-note.
  #[test]
  fn a_turn_that_fits_is_never_split() {
    let first = turn(1_600);
    let second = turn(1_600);
    let cut = slices(&[first.clone(), second.clone()]);

    assert_eq!(cut.len(), 2);
    assert_eq!(cut[0], first);
    assert_eq!(cut[1], second);
  }

  /// ⚠️ **Rien ne se perd.** Un mot qui disparaîtrait au découpage disparaîtrait du compte
  /// rendu, et personne ne s'en apercevrait.
  #[test]
  fn every_word_survives_the_slicing() {
    let turns: Vec<String> = (0..12).map(|_| turn(900)).collect();
    let expected: usize = turns.iter().map(|t| t.split_whitespace().count()).sum();
    let actual: usize = slices(&turns)
      .iter()
      .map(|slice| slice.split_whitespace().count())
      .sum();

    assert_eq!(actual, expected);
  }

  /// ⚠️ Un monologue se coupe aux phrases : une conférence est un seul « tour » de plusieurs
  /// milliers de mots, et sans ce découpage elle formerait une tranche que le modèle refuse.
  #[test]
  fn a_monologue_is_cut_at_sentence_boundaries() {
    let sentence = format!("{}.", turn(300));
    let monologue = std::iter::repeat_n(sentence.clone(), 20)
      .collect::<Vec<_>>()
      .join(" ");
    let cut = slices(&[monologue]);

    assert!(cut.len() > 1);
    for slice in &cut {
      assert!(estimated_tokens(slice) <= SLICE_TOKENS);
      assert!(
        slice.trim_end().ends_with('.'),
        "une tranche doit finir sur une phrase entière : {:?}",
        &slice[slice.len().saturating_sub(40)..]
      );
    }
  }

  /// ⚠️ Le dernier recours doit exister : le moteur ne ponctue pas certaines langues, le
  /// transcript n'a alors qu'une phrase, et sans coupe aux mots la boucle ne finirait jamais.
  #[test]
  fn an_unpunctuated_transcript_still_gets_cut() {
    let cut = slices(&[turn(9_000)]);

    assert!(cut.len() > 1, "sans ponctuation, il faut couper aux mots");
    for slice in &cut {
      assert!(estimated_tokens(slice) <= SLICE_TOKENS);
    }
  }

  /// ⚠️ Un tour rendu d'un seul bloc — ni ponctuation, ni espace — tombait sur la coupe aux mots,
  /// qui rendait le texte entier : une tranche que le modèle aurait refusée. D'où la coupe au
  /// caractère, dernier recours sous la coupe aux mots.
  #[test]
  fn a_turn_without_a_single_space_still_gets_cut() {
    let unbroken = "a".repeat(40_000);
    let cut = slices(&[unbroken]);

    assert!(cut.len() > 1, "sans espace, il faut couper au caractère");
    for slice in &cut {
      assert!(estimated_tokens(slice) <= SLICE_TOKENS);
    }
  }

  #[test]
  fn an_empty_session_produces_no_slice() {
    assert!(slices(&[]).is_empty());
    assert!(slices(&[String::new()]).is_empty());
  }

  /// ⚠️ Même courte, une session passe par la condensation. Le verbatim présenté comme des
  /// « notes » faisait recopier le transcript sous « Résumé » : à qui l'on demande d'organiser du
  /// texte sous des rubriques sans le lui avoir fait condenser, un modèle recopie.
  ///
  /// ⚠️ L'étape de notes n'est pas une pièce du map-reduce, c'est là que le résumé se fait. La
  /// seconde passe met en forme.
  #[test]
  fn even_a_short_session_is_condensed_before_it_is_written() {
    let mut asked: Vec<super::Stage> = Vec::new();
    let sections = super::compose(
      &[turn(100)],
      "fr",
      None,
      |stage, _| {
        asked.push(stage);
        Ok("## Résumé\nDeux points.".into())
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("composition")
    .expect("pas une annulation");

    assert_eq!(
      asked,
      vec![super::Stage::Notes, super::Stage::Report],
      "la condensation vient toujours avant la rédaction"
    );
    assert_eq!(sections.len(), 1);
  }

  /// ⚠️ **Le défaut mesuré, et il rendait toute session longue sans compte rendu.** L'étage de
  /// notes produit ~1 000 tokens par tranche, la rédaction n'en accepte qu'un nombre fixe : au
  /// delà de deux tranches et demie — ~25 minutes — le pont refusait la passe finale. Rien ne
  /// bornait les notes.
  #[test]
  fn notes_too_big_for_one_pass_are_condensed_before_the_report() {
    let turns: Vec<String> = (0..12).map(|_| turn(1_000)).collect();
    let mut stages: Vec<super::Stage> = Vec::new();
    let mut written: Option<usize> = None;

    super::compose(
      &turns,
      "fr",
      None,
      |stage, text| {
        stages.push(stage);
        match stage {
          // Ce que le modèle rend vraiment : ~1 000 tokens de notes par tranche.
          super::Stage::Notes => Ok(turn(1_000)),
          // Un tour de condensation qui réduit de moitié, comme le ferait le modèle.
          super::Stage::Condense => Ok(turn(estimated_tokens(text) / 2)),
          super::Stage::Report => {
            written = Some(estimated_tokens(text));
            Ok("## Résumé\nUn point.".into())
          }
        }
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("composition")
    .expect("pas une annulation");

    assert!(
      stages.contains(&super::Stage::Condense),
      "douze tranches de notes ne tiennent pas dans une passe : elles doivent être condensées"
    );
    let given = written.expect("la rédaction a bien eu lieu");
    assert!(
      given <= NOTES_BUDGET,
      "la rédaction a reçu {given} tokens pour un budget de {NOTES_BUDGET}"
    );
  }

  /// ⚠️ **La terminaison est le piège de la réduction en tours.** Un modèle qui rend une réponse
  /// aussi grosse que sa question ferait boucler la condensation à l'infini. Le tour doit
  /// strictement réduire, ou l'on s'arrête — et l'on rédige avec ce qui tient.
  #[test]
  fn a_round_that_shrinks_nothing_stops_instead_of_looping_for_ever() {
    let turns: Vec<String> = (0..12).map(|_| turn(1_000)).collect();
    let mut written: Option<usize> = None;

    super::compose(
      &turns,
      "fr",
      None,
      |stage, text| match stage {
        super::Stage::Notes => Ok(turn(1_000)),
        // Le modèle qui ne condense rien : il rend ce qu'on lui donne.
        super::Stage::Condense => Ok(text.to_owned()),
        super::Stage::Report => {
          written = Some(estimated_tokens(text));
          Ok("## Résumé\nUn point.".into())
        }
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("composition")
    .expect("pas une annulation");

    let given = written.expect("la rédaction a bien eu lieu malgré la condensation stérile");
    assert!(
      given <= NOTES_BUDGET,
      "faute d'avoir réduit, on rédige sur ce qui tient : {given} tokens pour {NOTES_BUDGET}"
    );
  }

  /// ⚠️ **Le doute ne refait rien.** Un compte rendu très court, une rubrique de noms propres :
  /// la détection rend parfois `None`, et refaire la passe sur ce doute coûterait la génération
  /// la plus longue pour rien — sans garantie que la seconde soit meilleure.
  #[test]
  fn an_undecidable_language_is_left_alone() {
    assert!(!written_in_another_language(None, "fr"));
  }

  #[test]
  fn the_language_of_the_session_passes_without_a_second_pass() {
    assert!(!written_in_another_language(Some("fr"), "fr"));
  }

  /// ⚠️ Le défaut rapporté : un compte rendu à moitié en chinois sur une session française.
  #[test]
  fn another_language_asks_for_a_second_pass() {
    assert!(written_in_another_language(Some("zh"), "fr"));
  }

  /// ⚠️ La langue de session peut porter une région — `fr-FR` —, le détecteur ne rend qu'un code.
  /// Les comparer bruts ferait refaire toutes les passes de ces sessions-là.
  #[test]
  fn a_regional_variant_is_the_same_language() {
    assert!(!written_in_another_language(Some("fr"), "fr-FR"));
    assert!(!written_in_another_language(Some("pt"), "pt-BR"));
  }

  /// ⚠️ La reprise a lieu une fois, et la seconde sortie est gardée telle quelle : insister
  /// ferait payer la passe la plus longue trois fois, et rien ne dit que la troisième serait
  /// meilleure que la deuxième.
  #[test]
  fn a_report_written_in_another_language_is_composed_once_more() {
    let mut reports = 0;
    let sections = super::compose(
      &[turn(100)],
      "fr",
      None,
      |stage, _| {
        if stage == super::Stage::Report {
          reports += 1;
          return Ok(format!("## 摘要\n第{reports}次。"));
        }
        Ok("- une note".into())
      },
      |_, _, _| true,
      |_| Some("zh".to_owned()),
    )
    .expect("composition")
    .expect("pas une annulation");

    assert_eq!(reports, 2, "une reprise, et une seule");
    assert!(
      sections[0].lines[0].contains('2'),
      "c'est la seconde rédaction qui est gardée"
    );
  }

  /// ⚠️ Le branchement du garde-fou, pas sa table : `live::headings` a ses propres épreuves, et
  /// celle-ci tient la seule chose qu'elles ne peuvent pas voir — que `compose` l'appelle, et
  /// avec la langue de la session.
  #[test]
  fn a_heading_the_model_left_in_english_comes_back_in_the_language_of_the_session() {
    let sections = super::compose(
      &[turn(100)],
      "fr",
      None,
      // Le rendu tel qu'il a été observé : un corps français, deux titres anglais.
      |_, _| {
        Ok(
          "## Résumé\nUn épisode sur la mémoire cache.\n\n## Topics covered\n- La latence\n- Le \
           coût\n\n## Questions inventées par le modèle\n- Rien ne la reconnaît."
            .into(),
        )
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("composition")
    .expect("pas une annulation");

    let headings: Vec<&str> = sections.iter().map(|s| s.heading.as_str()).collect();
    assert_eq!(
      headings,
      vec![
        "Résumé",
        "Sujets abordés",
        "Questions inventées par le modèle"
      ],
      "l'anglais recopié est réécrit, le titre inventé est laissé tel quel"
    );
  }

  /// Une session longue passe par le map, une fois par tranche, puis par le reduce.
  #[test]
  fn a_long_session_maps_every_slice_then_reduces_once() {
    let turns: Vec<String> = (0..10).map(|_| turn(1_000)).collect();
    let expected: usize = super::slices(&turns).len();
    let mut notes = 0;
    let mut reduces = 0;

    super::compose(
      &turns,
      "fr",
      None,
      |stage, _| {
        match stage {
          super::Stage::Notes | super::Stage::Condense => notes += 1,
          super::Stage::Report => reduces += 1,
        }
        Ok("## Résumé\nDeux points.".into())
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("composition");

    assert_eq!(notes, expected, "chaque tranche doit être résumée");
    assert_eq!(reduces, 1, "une seule composition finale");
  }

  /// ⚠️ **Une tranche perdue n'emporte pas le compte rendu.** Sur une heure de session, tout
  /// perdre parce qu'une passe sur douze a échoué serait disproportionné.
  #[test]
  fn one_failed_slice_does_not_lose_the_whole_report() {
    let turns: Vec<String> = (0..10).map(|_| turn(1_000)).collect();
    let mut seen = 0;

    let sections = super::compose(
      &turns,
      "fr",
      None,
      |stage, _| {
        if stage == super::Stage::Notes {
          seen += 1;
          if seen == 2 {
            return Err(crate::error::AppError::Native("modèle occupé".into()));
          }
        }
        Ok("## Résumé\nDeux points.".into())
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("le compte rendu survit à une tranche perdue")
    .expect("pas une annulation");

    assert_eq!(sections.len(), 1);
  }

  /// ⚠️ Mais si aucune tranche ne rend de notes, on n'invente pas : composer sur du vide
  /// produirait un compte rendu entièrement fabriqué, et rien à l'écran ne le dirait.
  #[test]
  fn a_report_is_never_composed_out_of_nothing() {
    let turns: Vec<String> = (0..10).map(|_| turn(1_000)).collect();
    let error = super::compose(
      &turns,
      "fr",
      None,
      |stage, _| match stage {
        super::Stage::Notes | super::Stage::Condense => {
          Err(crate::error::AppError::Native("modèle absent".into()))
        }
        super::Stage::Report => Ok("## Résumé\nInventé.".into()),
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect_err("rien à résumer doit remonter");

    // ⚠️ C'est la cause qui remonte, pas un message de remplacement — voir `compose`.
    assert!(error.to_string().contains("modèle absent"), "{error}");
  }

  #[test]
  fn an_empty_session_asks_the_model_nothing() {
    let mut asked = 0;
    let sections = super::compose(
      &[],
      "fr",
      None,
      |_, _| {
        asked += 1;
        Ok(String::new())
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("composition")
    .expect("pas une annulation");

    assert_eq!(asked, 0, "rien à résumer ne demande rien");
    assert!(sections.is_empty());
  }

  /// ⚠️ `N` est exact dès la première passe, il n'est pas estimé. Le compte rendu s'exécute sur
  /// un document déjà consolidé : le découpage connaît son compte avant de demander quoi que ce
  /// soit au modèle, et la barre ne peut donc pas décroître — rien ne la re-base.
  #[test]
  fn the_total_is_known_before_the_first_pass_and_never_moves() {
    let turns: Vec<String> = (0..10).map(|_| turn(1_000)).collect();
    let expected: usize = super::slices(&turns).len() + 1;
    let mut seen: Vec<(super::Stage, usize, usize)> = Vec::new();

    super::compose(
      &turns,
      "fr",
      None,
      |_, _| Ok("## Résumé\nDeux points.".into()),
      |stage, done, total| {
        seen.push((stage, done, total));
        true
      },
      |_| None,
    )
    .expect("composition");

    assert!(
      seen.iter().all(|(_, _, total)| *total == expected),
      "le total ne bouge pas : {seen:?}"
    );
    assert_eq!(
      seen.iter().map(|(_, done, _)| *done).collect::<Vec<_>>(),
      (0..expected).collect::<Vec<_>>(),
      "une étape faite de plus à chaque passe, sans trou ni retour"
    );
    assert_eq!(
      seen.last().map(|(stage, _, _)| *stage),
      Some(super::Stage::Report),
      "la rédaction est la dernière passe, et elle compte comme les autres"
    );
  }

  /// ⚠️ L'étape annoncée est celle qui commence : au premier évènement la barre est à zéro, et
  /// compter l'étape en cours comme faite afficherait 100 % pendant toute la rédaction.
  #[test]
  fn the_first_pass_is_announced_with_nothing_done_yet() {
    let mut seen: Vec<(super::Stage, usize, usize)> = Vec::new();
    super::compose(
      &[turn(100)],
      "fr",
      None,
      |_, _| Ok("## Résumé\nDeux points.".into()),
      |stage, done, total| {
        seen.push((stage, done, total));
        true
      },
      |_| None,
    )
    .expect("composition");

    assert_eq!(seen[0], (super::Stage::Notes, 0, 2));
  }

  /// ⚠️ Renoncer ne range rien — c'est tout ce qui fait « l'état d'avant ». Rendre un `Vec` vide
  /// aurait effacé le compte rendu précédent sur une régénération : une destruction déguisée en
  /// abandon. `None` dit « ne range rien », et l'appelant relit le document tel qu'il était.
  #[test]
  fn a_cancelled_generation_comes_back_as_an_outcome_and_asks_the_model_nothing_more() {
    let turns: Vec<String> = (0..10).map(|_| turn(1_000)).collect();
    let mut asked = 0;

    let outcome = super::compose(
      &turns,
      "fr",
      None,
      |_, _| {
        asked += 1;
        Ok("## Résumé\nDeux points.".into())
      },
      // Le drapeau est déjà levé au premier cran : rien ne doit partir.
      |_, _, _| false,
      |_| None,
    )
    .expect("une annulation n'est pas une panne");

    assert_eq!(outcome, None);
    assert_eq!(asked, 0, "on sort AVANT la passe, pas après");
  }

  /// ⚠️ On sort entre deux passes, jamais au milieu d'une : le pont ne sait pas interrompre une
  /// génération en cours. Le délai d'observation est donc une passe — quelques secondes.
  #[test]
  fn cancelling_mid_way_stops_at_the_next_pass_and_writes_nothing() {
    let turns: Vec<String> = (0..10).map(|_| turn(1_000)).collect();
    let mut asked = 0;
    let mut crossed = 0;

    let outcome = super::compose(
      &turns,
      "fr",
      None,
      |_, _| {
        asked += 1;
        Ok("## Résumé\nDeux points.".into())
      },
      |_, _, _| {
        crossed += 1;
        crossed < 3
      },
      |_| None,
    )
    .expect("une annulation n'est pas une panne");

    assert_eq!(outcome, None);
    assert_eq!(asked, 2, "les deux passes déjà lancées vont à leur terme");
  }

  /// ⚠️ **Le modèle refuse parfois une passe qu'il accepte à la seconde demande.** Observé sur
  /// une session d'une seule tranche : le compte rendu échouait, et le relancer à la main
  /// aboutissait. Sans cette reprise, un refus passager coûte tout le compte rendu.
  #[test]
  fn a_pass_the_model_refuses_once_is_asked_a_second_time() {
    let mut asked = 0;

    let outcome = super::compose(
      &[turn(1_000)],
      "fr",
      None,
      |_, _| {
        asked += 1;
        if asked == 1 {
          return Err(crate::error::AppError::Native("le modèle a refusé".into()));
        }
        Ok("## Résumé\nDeux points.".into())
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("un refus passager ne doit pas coûter le compte rendu");

    assert!(outcome.is_some_and(|sections| !sections.is_empty()));
    assert_eq!(asked, 3, "la tranche deux fois, puis la rédaction");
  }

  /// ⚠️ Une seule reprise, jamais deux : le modèle qui refuse deux fois refuse pour une raison,
  /// et insister ferait attendre l'utilisateur une passe de plus avant le même échec.
  #[test]
  fn a_pass_refused_twice_gives_up_without_a_third_try() {
    let mut asked = 0;

    let outcome = super::compose(
      &[turn(1_000)],
      "fr",
      None,
      |_, _| {
        asked += 1;
        Err(crate::error::AppError::Native("le modèle a refusé".into()))
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    );

    assert!(outcome.is_err());
    assert_eq!(asked, 2, "deux tentatives, et la rédaction n'a pas lieu");
  }

  /// ⚠️ La rédaction a droit à la même seconde chance, et elle en a le plus besoin : elle vient
  /// après toutes les passes de notes, et la perdre fait tout recommencer.
  #[test]
  fn the_writing_pass_gets_a_second_chance_too() {
    let mut asked = 0;

    let outcome = super::compose(
      &[turn(1_000)],
      "fr",
      None,
      |stage, _| {
        asked += 1;
        if stage == super::Stage::Report && asked == 2 {
          return Err(crate::error::AppError::Native("le modèle a refusé".into()));
        }
        Ok("## Résumé\nDeux points.".into())
      },
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect("un refus passager de la rédaction ne doit pas coûter les notes");

    assert!(outcome.is_some_and(|sections| !sections.is_empty()));
    assert_eq!(asked, 3, "la tranche, puis la rédaction deux fois");
  }

  /// ⚠️ Renoncer pendant la reprise arrête tout : la reprise est une passe comme une autre, et
  /// la relancer sur un « Annuler » déjà cliqué ferait attendre quelques secondes de plus.
  #[test]
  fn cancelling_before_the_second_try_gives_up_instead_of_retrying() {
    let mut asked = 0;
    let mut crossed = 0;

    let outcome = super::compose(
      &[turn(1_000)],
      "fr",
      None,
      |_, _| {
        asked += 1;
        Err(crate::error::AppError::Native("le modèle a refusé".into()))
      },
      |_, _, _| {
        crossed += 1;
        crossed < 2
      },
      |_| None,
    )
    .expect("une annulation n'est pas une panne");

    assert_eq!(outcome, None);
    assert_eq!(asked, 1, "la reprise ne part pas");
  }

  /// ⚠️ Et la rédaction est annulable elle aussi — c'est même la passe qu'il vaut le plus la
  /// peine d'éviter, elle lit toutes les notes d'un coup. Sortir seulement pendant le map aurait
  /// rendu « Annuler » inerte sur les sessions courtes, qui n'ont qu'une tranche.
  #[test]
  fn the_writing_pass_can_be_given_up_too() {
    let mut asked: Vec<super::Stage> = Vec::new();

    let outcome = super::compose(
      &[turn(100)],
      "fr",
      None,
      |stage, _| {
        asked.push(stage);
        Ok("## Résumé\nDeux points.".into())
      },
      |stage, _, _| stage != super::Stage::Report,
      |_| None,
    )
    .expect("une annulation n'est pas une panne");

    assert_eq!(outcome, None);
    assert_eq!(
      asked,
      vec![super::Stage::Notes],
      "la rédaction n'a pas eu lieu"
    );
  }

  /// ⚠️ **La cause remonte telle quelle** : « le modèle est indisponible » dit à l'utilisateur
  /// quoi faire, un message de remplacement ne dirait que ce qu'il voit déjà.
  #[test]
  fn a_failing_composition_surfaces_its_error() {
    let error = super::compose(
      &[turn(100)],
      "fr",
      None,
      |_, _| Err(crate::error::AppError::Native("modèle indisponible".into())),
      |_, _, _| true,
      // Aucune détection : ces épreuves ne parlent pas de langue.
      |_| None,
    )
    .expect_err("l'échec de la composition remonte");
    assert!(error.to_string().contains("modèle indisponible"));
  }

  /// ⚠️ Une rubrique remplie d'un tiret nu n'est pas une rubrique. Le prompt demande pourtant
  /// d'omettre une rubrique dont les notes ne disent rien ; le modèle préfère la garder et la
  /// remplir d'une puce vide.
  ///
  /// ⚠️ Écarté par le parseur, pas par le prompt : un garde-fou déterministe ne se dédit pas
  /// d'une génération à l'autre.
  #[test]
  fn a_heading_filled_with_nothing_but_a_dash_disappears() {
    let sections = super::parse("## Résumé\nDeux points.\n## Décisions\n-\n## Tâches\n- \n•");

    assert_eq!(
      sections
        .iter()
        .map(|s| s.heading.as_str())
        .collect::<Vec<_>>(),
      vec!["Résumé"],
      "seule une rubrique qui dit quelque chose survit"
    );
  }

  #[test]
  fn every_stage_has_its_own_bridge_name() {
    assert_eq!(super::Stage::Notes.as_str(), "notes");
    assert_eq!(super::Stage::Report.as_str(), "report");
  }

  #[test]
  fn a_report_becomes_its_sections() {
    let sections = super::parse(
      "## Résumé\nPoint hebdomadaire produit.\n\n## Décisions\n- La démo est maintenue.\n- On garde les 6 langues.\n",
    );

    assert_eq!(sections.len(), 2);
    assert_eq!(sections[0].heading, "Résumé");
    assert_eq!(sections[0].lines, vec!["Point hebdomadaire produit."]);
    assert!(!sections[0].bullets, "un paragraphe n'est pas une liste");
    assert!(sections[1].bullets);
    assert_eq!(sections[1].lines.len(), 2);
  }

  /// ⚠️ Un Markdown tronqué rend ce qu'il a — c'est toute la raison de ce format contre une
  /// sortie contrainte, dont un dépassement perd tout.
  #[test]
  fn a_generation_cut_short_still_yields_what_it_wrote() {
    let sections = super::parse("## Résumé\nLa session a porté sur\n\n## Décisions\n- La dém");
    assert_eq!(sections.len(), 2);
    assert_eq!(sections[1].lines, vec!["La dém"]);
  }

  /// ⚠️ **Le bavardage d'avant la première rubrique est jeté.** « Voici le compte rendu : »
  /// affiché hors rubrique ressemblerait à une réponse de chat, pas à un document.
  #[test]
  fn anything_before_the_first_heading_is_dropped() {
    let sections = super::parse("Voici le compte rendu :\n\n## Résumé\nDeux points.");
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].heading, "Résumé");
  }

  /// ⚠️ **Une rubrique vide ne survit pas** : elle promettrait une section et rendrait du blanc.
  #[test]
  fn an_empty_heading_never_reaches_the_screen() {
    let sections = super::parse("## Décisions\n\n## Tâches\n- Corriger les deux bugs.");
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].heading, "Tâches");
  }

  /// ⚠️ **Trois marqueurs de puce.** Le modèle alterne d'une génération à l'autre ; n'en
  /// reconnaître qu'un rendrait la même session tantôt en liste, tantôt en paragraphe.
  #[test]
  fn every_bullet_marker_the_model_uses_is_recognised() {
    for marker in ["-", "*", "•"] {
      let sections = super::parse(&format!("## Tâches\n{marker} Corriger les bugs."));
      assert!(sections[0].bullets, "puce « {marker} » non reconnue");
      assert_eq!(sections[0].lines, vec!["Corriger les bugs."]);
    }
  }

  /// ⚠️ Le modèle décore ses titres, et l'écran n'est pas un lecteur Markdown : les rubriques
  /// s'affichaient « **Résumé** », deux étoiles comprises. Le gras d'une ligne de contenu tombe
  /// pour la même raison.
  #[test]
  fn the_bold_the_model_adds_never_reaches_the_screen() {
    let sections = super::parse("## **Résumé**\n- **Décision** : on garde les 6 langues.");

    assert_eq!(sections[0].heading, "Résumé");
    assert_eq!(
      sections[0].lines,
      vec!["Décision : on garde les 6 langues."]
    );
  }

  /// ⚠️ L'italique aussi, et une paire au milieu d'une phrase, pas seulement autour d'elle.
  #[test]
  fn a_single_star_pair_is_emphasis_too() {
    let sections = super::parse("## Résumé\nUn point *important* et le reste.");
    assert_eq!(sections[0].lines, vec!["Un point important et le reste."]);
  }

  /// ⚠️ Une étoile esseulée est du texte, et elle reste : retirer toutes les étoiles écrirait
  /// « 2  3  4 » là où la session disait « 2 * 3 * 4 ». Un marqueur n'ouvre que s'il colle à ce
  /// qu'il ouvre.
  #[test]
  fn stars_that_open_nothing_are_left_alone() {
    let sections = super::parse("## Résumé\nLe calcul 2 * 3 * 4 a été refait.");
    assert_eq!(sections[0].lines, vec!["Le calcul 2 * 3 * 4 a été refait."]);
  }

  /// ⚠️ Un fermant colle à ce qu'il ferme : sans cette moitié-là, « 2 *3 * 4 » perdrait ses deux
  /// étoiles au lieu d'aucune.
  #[test]
  fn a_closing_marker_hanging_after_a_space_closes_nothing() {
    let sections = super::parse("## Résumé\nLe calcul 2 *3 * 4 a été refait.");
    assert_eq!(sections[0].lines, vec!["Le calcul 2 *3 * 4 a été refait."]);
  }

  /// Un titre plus profond reste une rubrique : le modèle écrit parfois `###`.
  #[test]
  fn a_deeper_heading_is_still_a_section() {
    let sections = super::parse("### Points clés\n- Un risque.");
    assert_eq!(sections[0].heading, "Points clés");
  }

  #[test]
  fn nothing_generated_yields_no_section() {
    assert!(super::parse("").is_empty());
    assert!(super::parse("Aucune rubrique ici.").is_empty());
  }

  /// Les identifiants voyagent dans les réglages : ils doivent rester stables et distincts.
  #[test]
  fn every_kind_has_its_own_stable_identifier() {
    let kinds = [
      ReportKind::Team,
      ReportKind::OneToOne,
      ReportKind::Client,
      ReportKind::Lecture,
      ReportKind::Brainstorm,
      ReportKind::Summary,
      ReportKind::Media,
      ReportKind::Interview,
      ReportKind::Custom,
    ];
    let names: std::collections::BTreeSet<&str> = kinds.iter().map(|k| k.as_str()).collect();
    assert_eq!(
      names.len(),
      kinds.len(),
      "deux types ne partagent pas un nom"
    );
    assert_eq!(
      serde_json::to_value(ReportKind::OneToOne).expect("sérialisation"),
      serde_json::Value::String("oneToOne".into()),
      "le nom sérialisé doit être celui que le frontend et les réglages emploient"
    );
  }

  /// ⚠️ Le défaut observé : sur un compte rendu « Résumé », « Points principaux » et « Ce qu'il
  /// faut retenir » portaient les six mêmes puces. La cause première est corrigée côté prompt ;
  /// ceci garde les huit autres types.
  #[test]
  fn a_section_that_merely_repeats_an_earlier_one_is_dropped() {
    let sections = parse(
      "## Points principaux\n- Le butin est amusant.\n- Blizzard privilégie « Rest First ».\n\
       ## Ce qu'il faut retenir\n- Le butin est amusant.\n- Blizzard privilégie « Rest First ».\n",
    );

    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].heading, "Points principaux");
  }

  /// ⚠️ On n'écarte que sur une répétition totale : une phrase partagée — une décision qui est
  /// aussi un point clé — ne doit pas coûter une rubrique entière.
  #[test]
  fn a_section_sharing_only_one_line_survives() {
    let sections = parse(
      "## Décisions\n- On garde le seuil.\n- On reporte la refonte.\n\
       ## Points clés\n- On garde le seuil.\n- Le budget est tenu.\n",
    );

    assert_eq!(sections.len(), 2);
  }

  /// ⚠️ Deux rubriques d'une seule ligne ne se fondent pas, même identiques : « Décisions :
  /// aucune » et « Tâches : aucune » disent que les deux questions ont été posées, et que les deux
  /// réponses sont vides. Les fondre effacerait une information vraie.
  #[test]
  fn two_one_line_sections_saying_the_same_thing_both_stay() {
    let sections = parse("## Décisions\n- Aucune.\n## Tâches\n- Aucune.\n");

    assert_eq!(sections.len(), 2);
    assert_eq!(sections[1].heading, "Tâches");
  }
}
