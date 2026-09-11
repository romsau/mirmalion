//! La machine à états de la dictée — **pure, sans I/O, sans Tauri**.
//!
//! Le parcours est une suite d'étapes dont trois sont optionnelles et peuvent échouer sans faire
//! échouer la dictée : nettoyage, reformulation, traduction. Dans une machine, l'échec d'une
//! étape est le **même geste** que sa réussite — on repart du texte qu'on avait, on passe à la
//! suivante. Ce module n'appelle ni le moteur, ni le modèle, ni le presse-papiers : il dit quoi
//! faire, et `commands::dictation` le fait.
//!
//! # Pièges
//!
//! - ⚠️ L'invariant qui gouverne tout : *on n'insère jamais rien de moins que du texte*. À tout
//!   instant, [`Run`] porte le meilleur texte obtenu jusque-là ; une étape qui échoue ne le perd
//!   pas, elle ne l'améliore simplement pas.

/// Le chronomètre de la dictée, **pur lui aussi** : un instrument de mesure dont on ne peut pas
/// prouver la justesse ne prouve rien de ce qu'il mesure.
pub mod timing;

use crate::{commands::overlay::OverlayState, llm::RephrasingStyle};

/// La durée en deçà de laquelle une dictée **ne produit rien**.
///
/// 250 ms : huit fois au-dessus du parasite mesuré, bien en dessous du plus bref « oui »
/// prononcé à dessein. Couvre du même coup le doigt qui glisse.
///
/// # Pièges
///
/// - ⚠️ Obligatoire, pas optionnelle : taper ⌃⌥⌘ dans une autre application produit deux paires
///   démarrage/arrêt parasites de ~30 ms, les doigts traversant ⌃⌥ avant que ⌘ n'arrive puis au
///   relâchement. Le raccourci ne peut pas les distinguer sans manger les tapotements courts du
///   mode bascule : c'est ici que ça se règle, en jetant la dictée.
pub const MIN_DICTATION_MS: u64 = 250;

/// Les étapes du parcours, dans l'ordre acté.
///
/// # Pièges
///
/// - ⚠️ `Dictionary` s'applique sur le texte **brut**, avant le nettoyage : le nettoyage
///   reformule, et corriger « git lab » après lui reviendrait à chercher une graphie que le
///   modèle a déjà pu réécrire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
  /// Micro ouvert, moteur en session. **C'est l'étape de départ, il n'y a pas d'« inactif »** :
  /// un [`Run`] n'existe que le temps d'une dictée, et une machine au repos serait un état
  /// qu'aucun chemin ne visite.
  Listening,
  /// Le dictionnaire personnel, sur le texte **brut**.
  Dictionary,
  /// Le nettoyage par le modèle local.
  Cleaning,
  /// La reformulation, dans le style demandé.
  Rephrasing,
  /// La traduction vers la langue cible.
  Translating,
  /// Le collage au curseur.
  Inserting,
  /// Terminé — quelle qu'ait été la qualité du chemin.
  Finished,
}

/// Ce que l'appelant doit faire ensuite. Rendu par [`Run::advance`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
  /// Appliquer le dictionnaire personnel au texte brut.
  ///
  /// La seule étape qui ne peut pas échouer du point de vue de la machine : elle *corrige* au
  /// lieu d'améliorer, et un dictionnaire vide ou illisible rend exactement son entrée.
  ApplyDictionary(String),
  /// Nettoyer le texte par le modèle local.
  Clean {
    /// Le texte à nettoyer.
    text: String,
    /// La langue **parlée**, telle qu'elle était au démarrage de la dictée.
    ///
    /// # Pièges
    ///
    /// - ⚠️ Même piège qu'en reformulation, et mesuré sur des dictées réelles : sans elle, un
    ///   brut portant une amorce étrangère ressort corrigé dans la langue des consignes, qui
    ///   sont en anglais. Elle vient du plan, jamais des réglages relus en cours de route.
    language: String,
  },
  /// Reformuler le texte dans le style demandé.
  Rephrase {
    /// La langue **parlée**, telle qu'elle était au démarrage de la dictée.
    ///
    /// # Pièges
    ///
    /// - ⚠️ Le modèle ne doit pas avoir à la deviner : deux styles sur six rendaient un texte
    ///   anglais sur une dictée française, entraînés par la directive de style qui est rédigée
    ///   en anglais. Elle vient du plan, jamais des réglages relus en cours de route.
    language: String,
    /// Le texte à reformuler.
    text: String,
    /// Le style demandé.
    style: RephrasingStyle,
  },
  /// Traduire le texte vers la langue cible.
  Translate {
    /// Le texte à traduire.
    text: String,
    /// La langue **parlée**, telle qu'elle était au démarrage de la dictée.
    source: String,
    /// La langue vers laquelle traduire.
    target: String,
  },
  /// Coller le texte final au curseur.
  Insert(String),
  /// Plus rien à faire. Le texte final est dans [`Run::text`].
  Done,
}

/// Ce qu'une dictée demande, figé à son démarrage.
///
/// # Pièges
///
/// - ⚠️ Figé, et pas relu en cours de route : l'utilisateur peut changer de langue de traduction
///   pendant que le modèle travaille, et appliquer le nouveau choix à une dictée déjà commencée
///   donnerait un résultat que personne n'a demandé.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Plan {
  /// La langue parlée. Figée elle aussi : traduire la fin d'une dictée depuis une autre
  /// langue que son début n'a aucun sens.
  pub language: String,
  /// Le style de reformulation demandé, s'il y en a un.
  pub rephrasing: Option<RephrasingStyle>,
  /// La langue vers laquelle traduire, s'il y en a une.
  pub translation_target: Option<String>,
}

/// Ce qu'une dictée laisse à l'historique.
///
/// # Pièges
///
/// - ⚠️ Quatre variantes, et les trois dernières sont facultatives : leur absence *est*
///   l'information. Une étape qui a renoncé n'a rien produit, et écrire à sa place le texte de
///   l'étape précédente ferait croire à un nettoyage qui n'a pas eu lieu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variants {
  /// La langue parlée.
  pub language: String,
  /// Le texte tel que le moteur l'a rendu.
  pub raw: String,
  /// Le texte nettoyé, si le nettoyage a abouti.
  pub cleaned: Option<String>,
  /// Le texte reformulé, si la reformulation a abouti.
  pub rephrased: Option<String>,
  /// Le texte traduit, si la traduction a abouti.
  pub translated: Option<String>,
  /// La langue cible, notée seulement si la traduction a abouti.
  pub translated_language: Option<String>,
}

/// Une dictée en cours, du premier appui à l'insertion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
  /// L'étape courante du parcours.
  stage: Stage,
  /// Ce que la dictée demandait, figé à son démarrage.
  plan: Plan,
  /// Le meilleur texte obtenu jusqu'ici. **Jamais vidé par un échec.**
  text: String,
  /// Ce que chaque étape a produit, pour l'historique. Voir [`Variants`].
  raw: String,
  /// Le texte nettoyé, si le nettoyage a abouti.
  cleaned: Option<String>,
  /// Le texte reformulé, si la reformulation a abouti.
  rephrased: Option<String>,
  /// Le texte traduit, si la traduction a abouti.
  translated: Option<String>,
}

impl Run {
  /// Ouvre une dictée. L'appelant enchaîne sur l'ouverture du micro.
  pub fn start(plan: Plan) -> Self {
    Self {
      stage: Stage::Listening,
      plan,
      text: String::new(),
      raw: String::new(),
      cleaned: None,
      rephrased: None,
      translated: None,
    }
  }

  /// Change la langue vers laquelle cette dictée sera traduite, **tant qu'elle écoute**.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Refusé une fois l'écoute finie : l'étape de traduction est alors décidée, et changer
  ///   la cible insérerait au curseur une langue que le parcours n'a jamais produite.
  /// - ⚠️ **Ce n'est pas la garde du geste** : rien ici ne limite le retard, et l'appelant seul
  ///   sait quand le doigt s'est posé. Voir `commands::dictation`.
  pub fn retarget(&mut self, target: Option<String>) -> bool {
    if self.stage != Stage::Listening {
      return false;
    }
    self.plan.translation_target = target;
    true
  }

  /// L'étape courante — **observation de test**.
  ///
  /// La production ne lit pas l'étape : elle lui obéit, en exécutant le [`Step`] rendu, et n'en
  /// montre que ce qu'[`Self::overlay`] en dit.
  #[cfg(test)]
  pub fn stage(&self) -> Stage {
    self.stage
  }

  /// Ce que cette dictée demandait, **à l'usage de la mesure seule** : le rapport de latence
  /// nomme la configuration — langue, style, langue cible — pour trier les dictées ensuite.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le pipeline ne relit jamais le plan : les étapes le reçoivent par le [`Step`] qu'elles
  ///   exécutent. Ouvrir cette porte pour autre chose que la mesure rouvrirait la question que
  ///   [`Plan`] a fermée.
  pub fn plan(&self) -> &Plan {
    &self.plan
  }

  /// Le texte à insérer, ou à archiver. **Toujours le meilleur obtenu.**
  ///
  /// L'insertion reçoit son texte par le [`Step`] ; c'est l'historique qui vient le relire ici,
  /// avec ses quatre variantes.
  #[cfg_attr(not(test), expect(dead_code))]
  pub fn text(&self) -> &str {
    &self.text
  }

  /// La dictée attend-elle encore son texte ?
  ///
  /// Sert au chien de garde de `commands::dictation` : le contrat du moteur promet un final ou
  /// un abandon, une fois et une seule ; s'il se taisait, la pilule resterait sur *Écoute*
  /// jusqu'à la dictée suivante.
  pub fn awaiting_transcript(&self) -> bool {
    self.stage == Stage::Listening
  }

  /// Le texte brut est arrivé : le parcours de transformation commence.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un texte vide termine la dictée sans rien insérer — micro coupé, silence, ou dictée
  ///   trop brève déjà écartée en amont. Le presse-papiers de l'utilisateur ne doit pas être
  ///   touché pour rien.
  pub fn transcribed(&mut self, raw: String) -> Step {
    if raw.trim().is_empty() {
      self.stage = Stage::Finished;
      return Step::Done;
    }
    self.raw = raw.clone();
    self.text = raw;
    self.stage = Stage::Dictionary;
    Step::ApplyDictionary(self.text.clone())
  }

  /// L'étape courante a réussi : on retient son texte et on passe à la suivante.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Le texte est retenu **deux** fois, et ce n'est pas un doublon : une fois comme
  ///   « meilleur texte à ce jour », qui finira au curseur ; une fois dans la variante de
  ///   l'étape qui vient de réussir, que l'historique conserve telle quelle. Les confondre, c'est
  ///   perdre le brut dès le premier nettoyage.
  pub fn advance(&mut self, produced: String) -> Step {
    match self.stage {
      Stage::Cleaning => self.cleaned = Some(produced.clone()),
      Stage::Rephrasing => self.rephrased = Some(produced.clone()),
      Stage::Translating => self.translated = Some(produced.clone()),
      // `Dictionary` produit du texte brut corrigé, pas une variante : la règle en
      // compte quatre, et le dictionnaire n'en est pas une. `Listening`, `Inserting` et
      // `Finished` n'appellent jamais ceci.
      _ => {}
    }
    self.text = produced;
    self.next()
  }

  /// Ce que la dictée laisse à l'historique. **Le texte brut ne peut pas être vide** : une
  /// transcription vide termine le parcours avant d'y arriver.
  pub fn variants(&self) -> Variants {
    Variants {
      language: self.plan.language.clone(),
      raw: self.raw.clone(),
      cleaned: self.cleaned.clone(),
      rephrased: self.rephrased.clone(),
      translated: self.translated.clone(),
      // ⚠️ La langue cible n'est notée que si la traduction a **abouti** : la retenir sur une
      // traduction qui a renoncé afficherait « traduit en anglais » sur du français.
      translated_language: self
        .translated
        .as_ref()
        .and(self.plan.translation_target.clone()),
    }
  }

  /// L'étape courante a renoncé : **on garde le texte qu'on avait** et on passe à la suivante.
  ///
  /// C'est le même geste que la réussite, et c'est tout l'intérêt de la machine : aucun drapeau
  /// à lever, un renoncement ne se voit nulle part. L'utilisateur reçoit son texte, simplement
  /// sans l'amélioration qu'il espérait.
  pub fn degrade(&mut self) -> Step {
    self.next()
  }

  /// L'utilisateur a abandonné. **Rien n'est inséré, rien n'est archivé.**
  pub fn cancel(&mut self) {
    self.stage = Stage::Finished;
    self.text.clear();
    // ⚠️ Les variantes partent avec le texte : laisser le brut derrière soi mettrait dans
    // l'historique une dictée que l'utilisateur vient explicitement d'abandonner.
    self.raw.clear();
    self.cleaned = None;
    self.rephrased = None;
    self.translated = None;
  }

  /// L'étape suivante, d'après l'étape courante et ce que la dictée demande.
  fn next(&mut self) -> Step {
    loop {
      self.stage = match self.stage {
        Stage::Dictionary => Stage::Cleaning,
        Stage::Cleaning => Stage::Rephrasing,
        Stage::Rephrasing => Stage::Translating,
        Stage::Translating => Stage::Inserting,
        // `Listening` n'entre jamais ici — le brut passe par `transcribed`. `Inserting` et
        // les suivants n'ont plus de suite.
        Stage::Listening | Stage::Inserting | Stage::Finished => Stage::Finished,
      };

      match self.stage {
        Stage::Cleaning => {
          return Step::Clean {
            text: self.text.clone(),
            language: self.plan.language.clone(),
          };
        }
        // Une étape optionnelle non demandée n'est pas « sautée » : elle n'existe pas pour
        // cette dictée. On boucle jusqu'à la suivante qui existe.
        Stage::Rephrasing => match self.plan.rephrasing {
          Some(style) => {
            return Step::Rephrase {
              text: self.text.clone(),
              style,
              language: self.plan.language.clone(),
            };
          }
          None => continue,
        },
        Stage::Translating => match self.plan.translation_target.clone() {
          Some(target) => {
            return Step::Translate {
              text: self.text.clone(),
              source: self.plan.language.clone(),
              target,
            };
          }
          None => continue,
        },
        Stage::Inserting => return Step::Insert(self.text.clone()),
        _ => return Step::Done,
      }
    }
  }

  /// Ce que la pilule doit afficher pour l'étape courante.
  ///
  /// # Pièges
  ///
  /// - ⚠️ `Preparing` couvre trois étapes — dictionnaire, nettoyage et reformulation : deux
  ///   passes du même modèle sont indiscernables pour qui attend, et un état « Reformulation »
  ///   distinct clignoterait sans rien apprendre à personne.
  /// - ⚠️ `Inserting` n'a pas d'état à lui : le collage dure ~150 ms, et lui donner une pilule la
  ///   ferait apparaître et disparaître dans le même souffle.
  pub fn overlay(&self) -> OverlayState {
    match self.stage {
      Stage::Listening => OverlayState::Listening,
      Stage::Dictionary | Stage::Cleaning | Stage::Rephrasing => OverlayState::Preparing,
      Stage::Translating => OverlayState::Translating,
      Stage::Inserting => OverlayState::Preparing,
      Stage::Finished => self.ending(),
    }
  }

  /// Le **dernier** état de la dictée : *Terminé !* ou *Erreur*.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un parcours qui va jusqu'au bout se termine, point : ni le contenu, ni le collage, ni
  ///   une étape optionnelle qui renonce n'y changent rien. Un texte vide ne vaut pas erreur —
  ///   une dictée lancée puis arrêtée sans rien dire annoncerait une panne là où l'utilisateur a
  ///   changé d'avis. Les vrais cas d'erreur posent `Error` eux-mêmes, par `abandon`.
  /// - ⚠️ À publier en fermant la dictée, jamais [`Self::overlay`] : le parcours s'arrête à
  ///   l'insertion, dont `overlay()` rend *Préparation*, un état d'attente jamais effacé.
  pub fn ending(&self) -> OverlayState {
    OverlayState::Done
  }
}

/// Une dictée assez longue pour compter ?
///
/// Voir [`MIN_DICTATION_MS`] : en dessous, on ne produit **rien** — ni historique, ni collage,
/// ni overlay.
pub fn long_enough(elapsed_ms: u64) -> bool {
  elapsed_ms >= MIN_DICTATION_MS
}

#[cfg(test)]
mod tests {
  use super::{MIN_DICTATION_MS, Plan, Run, Stage, Step, long_enough};
  use crate::{commands::overlay::OverlayState, llm::RephrasingStyle};

  fn plan(rephrasing: Option<RephrasingStyle>, target: Option<&str>) -> Plan {
    Plan {
      language: "fr".to_owned(),
      rephrasing,
      translation_target: target.map(str::to_owned),
    }
  }

  /// Le parcours complet, dans l'ordre acté :
  /// brut → dictionnaire → nettoyé → reformulé → traduit → insertion.
  #[test]
  fn the_full_pipeline_runs_in_the_order_of_the_cadrage() {
    let mut run = Run::start(plan(Some(RephrasingStyle::Concise), Some("en")));

    assert_eq!(
      run.transcribed("brut".into()),
      Step::ApplyDictionary("brut".into())
    );
    assert_eq!(
      run.advance("dico".into()),
      Step::Clean {
        text: "dico".into(),
        language: "fr".into(),
      }
    );
    assert_eq!(
      run.advance("nettoyé".into()),
      Step::Rephrase {
        text: "nettoyé".into(),
        style: RephrasingStyle::Concise,
        language: "fr".into(),
      }
    );
    assert_eq!(
      run.advance("reformulé".into()),
      Step::Translate {
        text: "reformulé".into(),
        source: "fr".into(),
        target: "en".into(),
      }
    );
    assert_eq!(
      run.advance("traduit".into()),
      Step::Insert("traduit".into())
    );
    assert_eq!(run.advance("traduit".into()), Step::Done);
    assert_eq!(run.stage(), Stage::Finished);
  }

  /// Sans reformulation ni traduction, le parcours saute directement du nettoyage à
  /// l'insertion. Une étape non demandée **n'existe pas** pour cette dictée.
  #[test]
  fn the_optional_steps_do_not_exist_when_they_are_not_asked_for() {
    let mut run = Run::start(Plan::default());

    run.transcribed("brut".into());
    assert_eq!(
      run.advance("dico".into()),
      Step::Clean {
        text: "dico".into(),
        language: String::new(),
      }
    );
    assert_eq!(
      run.advance("nettoyé".into()),
      Step::Insert("nettoyé".into()),
      "ni reformulation ni traduction : on insère le nettoyé"
    );
  }

  /// **LE CŒUR DE LA MACHINE.** Chaque étape optionnelle peut renoncer sans que la dictée
  /// échoue — et le texte conservé est toujours le meilleur obtenu jusque-là.
  #[test]
  fn every_optional_step_can_give_up_without_losing_the_text() {
    // Le nettoyage renonce → on reformule le texte brut.
    let mut run = Run::start(plan(Some(RephrasingStyle::Standard), None));
    run.transcribed("brut".into());
    run.advance("brut".into());
    assert_eq!(
      run.degrade(),
      Step::Rephrase {
        text: "brut".into(),
        style: RephrasingStyle::Standard,
        language: "fr".into(),
      }
    );

    // La reformulation renonce → on insère le nettoyé.
    let mut run = Run::start(plan(Some(RephrasingStyle::Standard), None));
    run.transcribed("brut".into());
    run.advance("brut".into());
    run.advance("nettoyé".into());
    assert_eq!(run.degrade(), Step::Insert("nettoyé".into()));

    // La traduction renonce → on insère le reformulé.
    let mut run = Run::start(plan(Some(RephrasingStyle::Standard), Some("it")));
    run.transcribed("brut".into());
    run.advance("brut".into());
    run.advance("nettoyé".into());
    run.advance("reformulé".into());
    assert_eq!(run.degrade(), Step::Insert("reformulé".into()));
  }

  /// Les **huit** combinaisons d'échec des trois étapes optionnelles. Aucune ne doit perdre
  /// le texte, et l'ordre doit tenir quelle que soit celle qui renonce.
  #[test]
  fn all_eight_failure_combinations_still_insert_text() {
    for mask in 0..8u8 {
      let (clean_ok, rephrase_ok, translate_ok) = (mask & 1 == 0, mask & 2 == 0, mask & 4 == 0);
      let mut run = Run::start(plan(Some(RephrasingStyle::Detailed), Some("es")));

      run.transcribed("brut".into());
      run.advance("dico".into());
      if clean_ok {
        run.advance("nettoyé".into());
      } else {
        run.degrade();
      }
      if rephrase_ok {
        run.advance("reformulé".into());
      } else {
        run.degrade();
      }
      let step = if translate_ok {
        run.advance("traduit".into())
      } else {
        run.degrade()
      };

      match step {
        Step::Insert(text) => assert!(
          !text.is_empty(),
          "combinaison {mask} : on insère toujours du texte"
        ),
        other => panic!("combinaison {mask} : attendu une insertion, reçu {other:?}"),
      }
    }
  }

  /// ⚠️ **Une transcription vide ne touche à RIEN.** Micro coupé, silence, annulation tardive :
  /// écraser le presse-papiers de l'utilisateur pour du vide serait une perte sèche, et lui,
  /// contrairement au texte dicté, n'est pas récupérable.
  #[test]
  fn an_empty_transcription_inserts_nothing() {
    for empty in ["", "   ", "\n\t "] {
      let mut run = Run::start(Plan::default());
      assert_eq!(run.transcribed(empty.into()), Step::Done);
      assert_eq!(run.stage(), Stage::Finished);
      assert_eq!(run.text(), "");
    }
  }

  #[test]
  fn cancelling_leaves_nothing_behind() {
    let mut run = Run::start(plan(Some(RephrasingStyle::Friendly), Some("de")));
    run.transcribed("un texte déjà dicté".into());
    run.cancel();

    assert_eq!(run.stage(), Stage::Finished);
    assert_eq!(run.text(), "", "ni insertion, ni historique");
  }

  // Ce que la dictée laisse à l'historique.

  /// Le parcours complet remplit les **quatre** variantes, chacune avec son propre texte.
  #[test]
  fn a_complete_run_keeps_all_four_texts() {
    let mut run = Run::start(plan(Some(RephrasingStyle::Concise), Some("en")));
    run.transcribed("brut".into());
    run.advance("brut".into());
    run.advance("nettoyé".into());
    run.advance("reformulé".into());
    run.advance("traduit".into());

    let variants = run.variants();
    assert_eq!(variants.language, "fr");
    assert_eq!(variants.raw, "brut", "le brut survit à trois réécritures");
    assert_eq!(variants.cleaned.as_deref(), Some("nettoyé"));
    assert_eq!(variants.rephrased.as_deref(), Some("reformulé"));
    assert_eq!(variants.translated.as_deref(), Some("traduit"));
    assert_eq!(variants.translated_language.as_deref(), Some("en"));
  }

  /// ⚠️ **Une étape qui renonce ne laisse RIEN**, et surtout pas le texte de la précédente :
  /// l'historique doit pouvoir dire « le nettoyage n'a pas eu lieu ».
  #[test]
  fn a_step_that_gives_up_leaves_its_variant_empty() {
    let mut run = Run::start(plan(Some(RephrasingStyle::Standard), Some("it")));
    run.transcribed("brut".into());
    run.advance("brut".into());
    run.degrade(); // le nettoyage renonce
    run.advance("reformulé".into());
    run.degrade(); // la traduction renonce

    let variants = run.variants();
    assert_eq!(variants.raw, "brut");
    assert_eq!(variants.cleaned, None);
    assert_eq!(variants.rephrased.as_deref(), Some("reformulé"));
    assert_eq!(variants.translated, None);
  }

  /// ⚠️ **La langue cible ne se note QUE si la traduction a abouti.** La retenir sur une
  /// traduction qui a renoncé afficherait « traduit en italien » sur du français.
  #[test]
  fn the_target_language_is_only_kept_when_translation_succeeded() {
    let mut run = Run::start(plan(None, Some("it")));
    run.transcribed("brut".into());
    run.advance("brut".into());
    run.advance("nettoyé".into());
    run.degrade();

    assert_eq!(run.variants().translated_language, None);
  }

  /// Ce qui n'est pas demandé n'existe pas : sans reformulation ni traduction, deux variantes
  /// restent vides, et ce n'est pas une dégradation.
  #[test]
  fn variants_that_were_never_asked_for_stay_empty() {
    let mut run = Run::start(Plan::default());
    run.transcribed("brut".into());
    run.advance("brut".into());
    run.advance("nettoyé".into());

    let variants = run.variants();
    assert_eq!(variants.cleaned.as_deref(), Some("nettoyé"));
    assert_eq!(variants.rephrased, None);
    assert_eq!(variants.translated, None);
  }

  /// ⚠️ **Une dictée annulée ne laisse RIEN à archiver** — pas même son texte brut. C'est le
  /// seul chemin où l'utilisateur a explicitement dit qu'il n'en voulait pas.
  #[test]
  fn cancelling_wipes_the_variants_too() {
    let mut run = Run::start(Plan::default());
    run.transcribed("un texte déjà dicté".into());
    run.advance("nettoyé".into());
    run.cancel();

    let variants = run.variants();
    assert_eq!(variants.raw, "");
    assert_eq!(variants.cleaned, None);
  }

  // La correspondance avec l'overlay.

  /// ⚠️ **Trois étapes pour un seul état.** La règle l'exige : pas d'état « Reformulation »
  /// distinct, parce que deux passes du même modèle sont indiscernables pour qui attend.
  #[test]
  fn preparation_covers_dictionary_cleaning_and_rephrasing() {
    let mut run = Run::start(plan(Some(RephrasingStyle::Standard), Some("en")));
    assert_eq!(run.overlay(), OverlayState::Listening);

    run.transcribed("brut".into());
    assert_eq!(run.overlay(), OverlayState::Preparing, "dictionnaire");
    run.advance("dico".into());
    assert_eq!(run.overlay(), OverlayState::Preparing, "nettoyage");
    run.advance("nettoyé".into());
    assert_eq!(run.overlay(), OverlayState::Preparing, "reformulation");
  }

  #[test]
  fn translation_has_its_own_state_only_when_it_is_asked_for() {
    let mut with = Run::start(plan(None, Some("it")));
    with.transcribed("brut".into());
    with.advance("dico".into());
    with.advance("nettoyé".into());
    assert_eq!(with.overlay(), OverlayState::Translating);

    let mut without = Run::start(Plan::default());
    without.transcribed("brut".into());
    without.advance("dico".into());
    without.advance("nettoyé".into());
    assert_eq!(
      without.overlay(),
      OverlayState::Preparing,
      "sans traduction demandée, l'état Traduction ne doit jamais apparaître"
    );
  }

  /// ⚠️ **Deux fins, et une seule question : a-t-on produit un texte ?**
  ///
  /// Ni un renoncement d'étape, ni le sort du collage, ni **l'absence de texte** ne changent
  /// la fin.
  #[test]
  fn a_finished_run_always_ends_on_done() {
    let mut clean = Run::start(Plan::default());
    clean.transcribed("brut".into());
    clean.advance("dico".into());
    clean.advance("nettoyé".into());
    assert_eq!(clean.ending(), OverlayState::Done);

    let mut given_up = Run::start(Plan::default());
    given_up.transcribed("brut".into());
    given_up.advance("dico".into());
    given_up.degrade();
    assert_eq!(
      given_up.ending(),
      OverlayState::Done,
      "une étape qui renonce ne se voit pas : le texte est là"
    );

    // ⚠️ Rien dit n'est pas une panne : lancer une dictée puis l'arrêter sans parler annoncerait
    // une erreur là où l'utilisateur a changé d'avis. Les vrais échecs — moteur qui refuse, micro
    // refusé, silence de 45 s — passent par `abandon`, jamais par ici.
    let mut silent = Run::start(Plan::default());
    silent.transcribed("   ".into());
    assert_eq!(
      silent.ending(),
      OverlayState::Done,
      "un arrêt volontaire sans parole se termine, il n'échoue pas"
    );
  }

  /// ⚠️ **CE QUE LA DICTÉE PUBLIE EN DERNIER NE PEUT PAS ÊTRE UN ÉTAT D'ATTENTE.** La pilule
  /// n'efface qu'elle-même, et seulement sur `Terminé !`, `Indisponible` ou `Erreur` — voir
  /// `TERMINAL_STATES` dans `overlay-shell.component.ts`. Publier `Préparation` comme dernier
  /// mot la laisse à l'écran **pour toujours**.
  ///
  /// Le parcours s'arrête à l'insertion, où `overlay()` rend `Préparation` — à raison, le
  /// collage dure ~150 ms. D'où [`Run::ending`], qui ne sait rendre qu'une fin.
  #[test]
  fn a_run_that_stops_at_insertion_still_ends_on_a_terminal_state() {
    let mut run = Run::start(Plan::default());
    run.transcribed("brut".into());
    run.advance("dico".into());
    assert_eq!(
      run.advance("nettoyé".into()),
      Step::Insert("nettoyé".into())
    );
    assert_eq!(
      run.overlay(),
      OverlayState::Preparing,
      "pendant le collage, la pilule ne change pas — c'est voulu"
    );
    assert_eq!(
      run.ending(),
      OverlayState::Done,
      "mais la fin, elle, doit être une fin"
    );
  }

  // La garde de durée minimale.

  /// ⚠️ **Mesuré** : ⌃⌥⌘ tapé dans une autre application produit deux paires
  /// démarrage/arrêt de ~30 ms. Elles doivent mourir ici.
  #[test]
  fn the_parasitic_thirty_milliseconds_are_rejected() {
    assert!(!long_enough(0));
    assert!(!long_enough(30), "le parasite mesuré le 2026-07-29");
    assert!(!long_enough(MIN_DICTATION_MS - 1));
  }

  /// Le chemin normal du second raccourci : les doigts posent ⌃⌥, la dictée s'ouvre sans cible,
  /// puis ⌘ arrive et la dictée doit repartir vers l'anglais.
  #[test]
  fn a_listening_run_accepts_a_new_target() {
    let mut run = Run::start(plan(None, None));

    assert!(run.retarget(Some("en".to_owned())));
    assert_eq!(run.plan().translation_target.as_deref(), Some("en"));
  }

  /// Et dans l'autre sens : ⌘ relâché avant de parler ramène la dictée à la langue parlée.
  #[test]
  fn a_listening_run_accepts_losing_its_target() {
    let mut run = Run::start(plan(None, Some("en")));

    assert!(run.retarget(None));
    assert_eq!(run.plan().translation_target, None);
  }

  /// ⚠️ **Passé l'écoute, la cible est gelée.** L'étape de traduction est décidée à partir du
  /// plan : la changer une fois le texte transcrit insérerait au curseur une langue que le
  /// parcours n'a jamais produite.
  #[test]
  fn a_run_that_has_left_listening_refuses_to_change_target() {
    let mut run = Run::start(plan(None, None));
    run.transcribed("bonjour".to_owned());

    assert!(!run.retarget(Some("en".to_owned())));
    assert_eq!(
      run.plan().translation_target,
      None,
      "le refus ne doit rien avoir changé au passage"
    );
  }

  #[test]
  fn a_real_dictation_passes_the_guard() {
    assert!(long_enough(MIN_DICTATION_MS));
    assert!(long_enough(500), "un « oui » prononcé à dessein");
    assert!(long_enough(12_000));
  }

  /// Le seuil doit rester **franchement** entre le parasite et la parole. Le resserrer sur
  /// l'un ou l'autre rouvrirait le défaut qu'il existe pour fermer.
  ///
  /// Vérifié **à la compilation** : la valeur est une constante, et un test à l'exécution ne
  /// dirait rien de plus une seconde plus tard.
  const _: () = {
    assert!(
      MIN_DICTATION_MS > 30 * 4,
      "loin au-dessus du parasite mesuré"
    );
    assert!(MIN_DICTATION_MS < 400, "loin en dessous d'un mot prononcé");
  };
}
