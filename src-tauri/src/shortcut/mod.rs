//! Ce que ⌃⌥ et ⌃⌥⌘ veulent dire — la machine à états du raccourci global.
//!
//! Le tap clavier est en Swift (`native/Sources/MirmalionNative/Shortcut.swift`) et ne sait dire
//! qu'une chose : laquelle des deux combinaisons est formée, ou aucune. Tout le reste est une
//! décision produit — deux modes de déclenchement, une coupure pendant les sessions, un état
//! d'enregistrement à ne jamais perdre — et vit ici pour être exercé sans clavier.
//!
//! # Pièges
//!
//! - ⚠️ Aucun état de macOS ici : ce module ne connaît ni tap, ni autorisation, ni fenêtre. Une
//!   machine à états qui ne se teste qu'en appuyant sur des touches n'est jamais éprouvée sur
//!   ses cas tordus — mode changé en pleine dictée, tap coupé le doigt sur la touche —, et ce
//!   sont ceux qui laissent un micro ouvert.
//! - ⚠️ Glisser d'une combinaison à l'autre sans relâcher n'est **pas** un arrêt suivi d'un
//!   démarrage : les doigts atteignent ⌃⌥⌘ en passant par ⌃⌥. Voir `Retarget`.

use serde::{Deserialize, Serialize};

/// Laquelle des deux combinaisons est enfoncée.
///
/// # Pièges
///
/// - ⚠️ Les codes sont **du contrat** avec `ShortcutCombo` de
///   `native/Sources/MirmalionNative/Shortcut.swift` : ils traversent le pont en `i32`, et une
///   dérive d'un côté ferait dicter dans la mauvaise langue sans que rien ne casse visiblement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Combo {
  /// ⌃⌥ : le texte s'écrit dans la langue parlée, aux réglages près.
  Spoken,
  /// ⌃⌥⌘ : le texte s'écrit dans la langue de traduction.
  Translated,
}

impl Combo {
  /// La combinaison que désigne un code du pont, `None` pour `0` comme pour l'inconnu.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un code inconnu vaut « aucune » plutôt qu'une panique : il arrive du fil du tap
  ///   clavier, où une panique avorterait le processus.
  pub fn from_code(code: i32) -> Option<Self> {
    match code {
      1 => Some(Self::Spoken),
      2 => Some(Self::Translated),
      _ => None,
    }
  }
}

/// Comment ⌃⌥ déclenche la dictée. **Un seul actif à la fois** — il n'y a pas de détection
/// automatique appui court / appui long.
///
/// Miroir de `DictationMode` dans `src/app/core/models/settings.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutMode {
  /// Maintenir pour parler : la dictée dure ce que dure l'appui.
  Hold,
  /// Un appui démarre, l'appui suivant arrête. Mains libres entre les deux.
  Toggle,
}

/// Ce que le raccourci demande au reste de l'application.
///
/// # Pièges
///
/// - ⚠️ Ce ne sont pas des fronts de touche : en mode bascule, `Stop` naît d'un **appui**, pas
///   d'un relâchement. Nommer « relâché » ce qui est un appui mentirait à tous les appelants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutAction {
  /// Ouvrir la dictée, dans la langue que désigne la combinaison.
  Start(Combo),
  /// La dictée en cours change de cible — l'utilisateur a ajouté ou retiré ⌘ sans relâcher.
  ///
  /// # Pièges
  ///
  /// - ⚠️ **Ce n'est pas un arrêt suivi d'un démarrage.** Pour atteindre ⌃⌥⌘ les doigts passent
  ///   presque toujours par ⌃⌥ : traiter le passage comme deux gestes couperait la dictée en
  ///   deux à chaque fois, et ⌃⌥⌘ ne se déclencherait jamais.
  /// - ⚠️ Ce n'est pas non plus une permission de changer d'avis en parlant : la machine
  ///   l'émet à chaque changement, et c'est le pipeline qui décide s'il est encore temps.
  Retarget(Combo),
  /// Fermer la dictée en cours.
  Stop,
  /// ⌃⌥ a été **pressé alors que le raccourci est coupé** — donc pendant une session.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Ce n'est pas un non-évènement : rendre `None` avalerait le geste sans un mot, et
  ///   l'utilisateur verrait un raccourci mort sans savoir pourquoi. Rien ne démarre pour
  ///   autant — cette action ne fait qu'avertir.
  /// - ⚠️ Émise à l'appui seulement, jamais au relâchement, et dans les deux modes : sinon un
  ///   seul geste donnerait deux avertissements.
  Suppressed,
}

/// La traduction des fronts de ⌃⌥ en démarrages et en arrêts de dictée.
#[derive(Debug, Clone, Copy)]
pub struct ShortcutMachine {
  /// Le mode de déclenchement en vigueur.
  mode: ShortcutMode,
  /// Le raccourci répond-il ? Coupé pendant une session — voir [`Self::set_enabled`].
  enabled: bool,
  /// La combinaison qui a ouvert la dictée en cours, `None` s'il n'y en a pas.
  recording: Option<Combo>,
  /// Dernière combinaison connue, pour ne réagir qu'aux changements.
  active: Option<Combo>,
}

impl ShortcutMachine {
  /// Une machine neuve : raccourci actif, rien en cours, combinaison relâchée.
  pub fn new(mode: ShortcutMode) -> Self {
    Self {
      mode,
      enabled: true,
      recording: None,
      active: None,
    }
  }

  /// Le mode de déclenchement en vigueur.
  pub fn mode(&self) -> ShortcutMode {
    self.mode
  }

  /// Le raccourci répond-il ?
  pub fn enabled(&self) -> bool {
    self.enabled
  }

  /// Une dictée est-elle en cours du point de vue du raccourci ?
  pub fn recording(&self) -> bool {
    self.recording.is_some()
  }

  /// Prend en compte un front de la combinaison, et rend l'action qu'il déclenche.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Idempotent sur les répétitions : deux fois la même combinaison d'affilée ne doivent
  ///   pas démarrer puis arrêter. Le tap ne notifie déjà que les changements, mais s'en remettre
  ///   à lui ferait dépendre la correction du mode bascule d'une garantie posée de l'autre côté
  ///   du pont.
  /// - ⚠️ Une dictée qui tourne et une combinaison qui change donnent un
  ///   [`ShortcutAction::Retarget`], jamais un arrêt : voir l'en-tête du module.
  pub fn update(&mut self, active: Option<Combo>) -> Option<ShortcutAction> {
    // ⚠️ L'ancienne combinaison est relevée avant d'être écrasée : c'est elle qui distingue
    // « les doigts glissent d'une combinaison à l'autre » d'« un nouvel appui », et les deux
    // ne veulent pas dire la même chose en mode bascule.
    let previous = self.active;
    let changed = active != previous;
    self.active = active;

    if !changed {
      return None;
    }

    // ⚠️ Le raccourci coupé n'est pas sourd, il répond autre chose : on garde le geste pour le
    // dire. Seul l'appui compte — avertir aussi au relâchement donnerait deux messages pour un
    // seul geste.
    if !self.enabled {
      return active.map(|_| ShortcutAction::Suppressed);
    }

    // ⚠️ Avant les deux modes, et dans les deux : les doigts qui glissent d'une combinaison à
    // l'autre sans passer par le relâchement changent la cible, ils n'arrêtent rien. C'est le
    // chemin normal vers ⌃⌥⌘, qu'on atteint presque toujours en passant par ⌃⌥.
    if let (Some(_), Some(combo)) = (previous, active) {
      // Aucune dictée en cours : les doigts glissent entre deux dictées, rien ne rouvre.
      self.recording?;
      self.recording = Some(combo);
      return Some(ShortcutAction::Retarget(combo));
    }

    match self.mode {
      // Maintenir : l'appui démarre, le relâchement arrête. Rien d'autre à décider.
      ShortcutMode::Hold => match active {
        Some(combo) => {
          self.recording = Some(combo);
          Some(ShortcutAction::Start(combo))
        }
        None => {
          self.recording = None;
          Some(ShortcutAction::Stop)
        }
      },
      // Bascule : **le relâchement ne dit rien.** Seul l'appui compte, et il inverse.
      ShortcutMode::Toggle => {
        let combo = active?;
        match self.recording {
          Some(_) => {
            self.recording = None;
            Some(ShortcutAction::Stop)
          }
          None => {
            self.recording = Some(combo);
            Some(ShortcutAction::Start(combo))
          }
        }
      }
    }
  }

  /// Change de mode **à chaud**, sans redémarrage.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Une dictée en cours s'arrête : passer de « maintenir » à « bascule » la touche enfoncée
  ///   laisserait un enregistrement dont plus aucun geste ne peut sortir, le relâchement ne
  ///   voulant plus rien dire dans le nouveau mode.
  pub fn set_mode(&mut self, mode: ShortcutMode) -> Option<ShortcutAction> {
    if mode == self.mode {
      return None;
    }
    self.mode = mode;
    self.reset()
  }

  /// Coupe ou rétablit le raccourci.
  ///
  /// **Le point de coupure de la session** : la dictée est désactivée tant qu'un enregistrement
  /// de session tourne. Appelée par `commands::live`, au démarrage et à l'arrêt.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Rétablir ne redémarre rien : si ⌃⌥ était maintenu pendant la coupure, la dictée ne
  ///   reprend pas — l'utilisateur n'a rien demandé pendant ce temps.
  /// - ⚠️ Couper ne rend pas la machine sourde : elle répond [`ShortcutAction::Suppressed`] au
  ///   prochain appui, pour qu'on puisse le dire à l'utilisateur.
  pub fn set_enabled(&mut self, enabled: bool) -> Option<ShortcutAction> {
    if enabled == self.enabled {
      return None;
    }
    self.enabled = enabled;
    self.reset()
  }

  /// Oublie tout ce que la machine croyait savoir, et arrête ce qui tournait.
  ///
  /// Appelé quand le tap s'arrête : les fronts qui suivent sont perdus, donc la dernière
  /// certitude — « la touche est enfoncée » — n'en est plus une.
  pub fn reset(&mut self) -> Option<ShortcutAction> {
    self.active = None;
    self.recording.take().map(|_| ShortcutAction::Stop)
  }
}

#[cfg(test)]
mod tests {
  use super::{Combo, ShortcutAction, ShortcutMachine, ShortcutMode};

  /// Le parcours nominal du mode « maintenir pour parler », avec chacune des deux combinaisons.
  #[test]
  fn holding_starts_and_releasing_stops() {
    for combo in [Combo::Spoken, Combo::Translated] {
      let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
      assert_eq!(
        machine.update(Some(combo)),
        Some(ShortcutAction::Start(combo))
      );
      assert!(machine.recording());
      assert_eq!(machine.update(None), Some(ShortcutAction::Stop));
      assert!(!machine.recording());
    }
  }

  /// Le parcours nominal du mode bascule : **deux appuis**, et le relâchement ne dit rien.
  #[test]
  fn toggling_needs_two_presses_and_ignores_releases() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Toggle);
    assert_eq!(
      machine.update(Some(Combo::Spoken)),
      Some(ShortcutAction::Start(Combo::Spoken))
    );
    assert_eq!(machine.update(None), None, "le relâchement n'arrête pas");
    assert!(machine.recording(), "les mains sont libres entre les deux");
    assert_eq!(
      machine.update(Some(Combo::Spoken)),
      Some(ShortcutAction::Stop)
    );
    assert_eq!(machine.update(None), None);
    assert!(!machine.recording());
  }

  /// ⚠️ **Le chemin normal vers ⌃⌥⌘, et il ne coupe rien.** Les doigts posent ⌃ puis ⌥ puis ⌘ :
  /// la machine voit ⌃⌥ avant ⌃⌥⌘. Traiter ce passage comme un arrêt suivi d'un démarrage
  /// couperait la dictée en deux, et la seconde combinaison serait inatteignable.
  #[test]
  fn sliding_from_one_combo_to_the_other_retargets_rather_than_stops() {
    for mode in [ShortcutMode::Hold, ShortcutMode::Toggle] {
      let mut machine = ShortcutMachine::new(mode);
      machine.update(Some(Combo::Spoken));

      assert_eq!(
        machine.update(Some(Combo::Translated)),
        Some(ShortcutAction::Retarget(Combo::Translated)),
        "mode {mode:?}"
      );
      assert!(machine.recording(), "mode {mode:?} : rien ne s'est arrêté");
    }
  }

  /// L'autre sens : ⌘ relâché en gardant ⌃⌥ ramène la dictée à la langue parlée, sans la
  /// couper. Une seule règle pour les deux sens du glissement.
  #[test]
  fn releasing_command_alone_retargets_back_to_the_spoken_language() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.update(Some(Combo::Translated));

    assert_eq!(
      machine.update(Some(Combo::Spoken)),
      Some(ShortcutAction::Retarget(Combo::Spoken))
    );
    assert!(machine.recording());
    assert_eq!(machine.update(None), Some(ShortcutAction::Stop));
  }

  /// ⚠️ **Ce que le changement de cible ne doit pas manger.** En bascule, le second appui
  /// arrête ; le confondre avec un glissement rendrait la dictée impossible à fermer, et le
  /// micro resterait ouvert. Ils se distinguent par l'état précédent : relâché ou non.
  #[test]
  fn in_toggle_mode_a_second_press_still_stops() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Toggle);
    machine.update(Some(Combo::Spoken));
    machine.update(None);

    assert_eq!(
      machine.update(Some(Combo::Translated)),
      Some(ShortcutAction::Stop),
      "le second appui ferme, quelle que soit sa combinaison"
    );
    assert!(!machine.recording());
  }

  /// Un glissement sans dictée en cours ne démarre rien : en bascule, entre deux dictées, les
  /// doigts peuvent passer par ⌃⌥ sans que cela ouvre quoi que ce soit.
  #[test]
  fn sliding_without_a_dictation_starts_nothing() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Toggle);
    machine.update(Some(Combo::Spoken));
    machine.update(None);
    machine.update(Some(Combo::Spoken));
    machine.update(None);

    let mut machine = ShortcutMachine::new(ShortcutMode::Toggle);
    machine.update(Some(Combo::Spoken));
    machine.update(None);
    machine.update(Some(Combo::Spoken));
    assert!(!machine.recording(), "la dictée est ferm\u{e9}e");
    assert_eq!(
      machine.update(Some(Combo::Translated)),
      None,
      "les doigts glissent, rien ne rouvre"
    );
  }

  /// Ce qui arriverait si le pont notifiait deux fois le même état : en bascule, un
  /// démarrage suivi d'un arrêt immédiat — donc une dictée vide.
  #[test]
  fn repeating_the_same_state_changes_nothing() {
    for mode in [ShortcutMode::Hold, ShortcutMode::Toggle] {
      let mut machine = ShortcutMachine::new(mode);
      assert_eq!(
        machine.update(Some(Combo::Spoken)),
        Some(ShortcutAction::Start(Combo::Spoken))
      );
      assert_eq!(machine.update(Some(Combo::Spoken)), None, "mode {mode:?}");
      assert!(machine.recording(), "mode {mode:?}");
    }
  }

  /// Un relâchement sans appui préalable — ce que produit un réarmement de tap après une
  /// veille, quand le front d'appui a été perdu.
  #[test]
  fn a_release_without_a_press_starts_nothing() {
    for mode in [ShortcutMode::Hold, ShortcutMode::Toggle] {
      let mut machine = ShortcutMachine::new(mode);
      assert_eq!(machine.update(None), None, "mode {mode:?}");
      assert!(!machine.recording(), "mode {mode:?}");
    }
  }

  /// Changer de mode en pleine dictée l'arrête, plutôt que de laisser un micro ouvert dont
  /// plus aucun geste ne sort.
  #[test]
  fn switching_mode_while_recording_stops_the_dictation() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.update(Some(Combo::Spoken));
    assert_eq!(
      machine.set_mode(ShortcutMode::Toggle),
      Some(ShortcutAction::Stop)
    );
    assert_eq!(machine.mode(), ShortcutMode::Toggle);
    assert!(!machine.recording());
  }

  #[test]
  fn switching_mode_while_idle_changes_the_mode_and_nothing_else() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    assert_eq!(machine.set_mode(ShortcutMode::Toggle), None);
    assert_eq!(machine.mode(), ShortcutMode::Toggle);
  }

  /// Réappliquer le mode courant est le cas le plus fréquent — les réglages renvoient l'état
  /// entier à chaque écriture. Il ne doit rien casser.
  #[test]
  fn re_applying_the_current_mode_is_a_no_op() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.update(Some(Combo::Spoken));
    assert_eq!(machine.set_mode(ShortcutMode::Hold), None);
    assert!(machine.recording(), "la dictée en cours n'est pas touchée");
  }

  /// Le point de coupure de la session : couper arrête la dictée en cours, et **plus rien ne
  /// démarre** ensuite.
  ///
  /// ⚠️ **Le raccourci n'est PAS sourd pour autant** — il répond `Suppressed`, ce qui est
  /// l'objet du test suivant. Ce test-ci ne s'intéresse qu'à ce qui compte ici : aucune dictée
  /// ne peut naître pendant une session.
  #[test]
  fn disabling_stops_the_dictation_and_starts_nothing_more() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.update(Some(Combo::Spoken));
    assert_eq!(machine.set_enabled(false), Some(ShortcutAction::Stop));

    machine.update(Some(Combo::Spoken));
    machine.update(None);
    assert!(
      !machine.recording(),
      "aucune dictée ne démarre pendant la coupure"
    );
  }

  /// ⚠️ **Un geste avalé sans un mot est un bogue perçu.** La machine rendait
  /// `None` sur un appui pendant la coupure : l'utilisateur voyait un raccourci mort sans
  /// savoir pourquoi. Elle le **dit** désormais, et c'est ce qui alimente la pilule.
  #[test]
  fn a_press_during_the_cut_is_reported_rather_than_swallowed() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.set_enabled(false);

    assert_eq!(
      machine.update(Some(Combo::Spoken)),
      Some(ShortcutAction::Suppressed)
    );
    assert!(!machine.recording(), "avertir ne démarre rien");
  }

  /// L'avertissement vaut pour les deux combinaisons : pendant une session, ⌃⌥⌘ ne doit pas
  /// être plus muet que ⌃⌥.
  #[test]
  fn the_second_combo_is_reported_during_the_cut_too() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.set_enabled(false);

    assert_eq!(
      machine.update(Some(Combo::Translated)),
      Some(ShortcutAction::Suppressed)
    );
  }

  /// ⚠️ **À l'appui seulement.** Avertir aussi au relâchement donnerait deux messages pour un
  /// seul geste — la pilule clignoterait deux fois.
  #[test]
  fn releasing_during_the_cut_says_nothing() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.set_enabled(false);
    machine.update(Some(Combo::Spoken));

    assert_eq!(machine.update(None), None);
  }

  /// L'avertissement vaut dans les deux modes : la coupure ne connaît pas le mode.
  #[test]
  fn the_warning_does_not_depend_on_the_mode() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Toggle);
    machine.set_enabled(false);

    assert_eq!(
      machine.update(Some(Combo::Spoken)),
      Some(ShortcutAction::Suppressed)
    );
  }

  /// Rétablir ne relance rien, même si la touche est restée enfoncée pendant la coupure.
  #[test]
  fn re_enabling_never_resumes_on_its_own() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.set_enabled(false);
    machine.update(Some(Combo::Spoken));
    assert_eq!(machine.set_enabled(true), None);
    assert!(!machine.recording());
    assert!(machine.enabled());
  }

  #[test]
  fn re_applying_the_current_enablement_is_a_no_op() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.update(Some(Combo::Spoken));
    assert_eq!(machine.set_enabled(true), None);
    assert!(machine.recording());
  }

  /// Ce que fait l'arrêt du tap : la machine ne peut plus rien apprendre, donc elle ne garde
  /// aucune certitude — et elle ferme ce qu'elle avait ouvert.
  #[test]
  fn resetting_closes_an_open_dictation_once() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.update(Some(Combo::Spoken));
    assert_eq!(machine.reset(), Some(ShortcutAction::Stop));
    assert_eq!(machine.reset(), None, "rien à refermer la seconde fois");
  }

  /// Après un `reset`, un appui redémarre — la machine n'est pas restée persuadée que la
  /// touche était encore enfoncée.
  #[test]
  fn a_press_after_a_reset_starts_again() {
    let mut machine = ShortcutMachine::new(ShortcutMode::Hold);
    machine.update(Some(Combo::Spoken));
    machine.reset();
    assert_eq!(
      machine.update(Some(Combo::Translated)),
      Some(ShortcutAction::Start(Combo::Translated))
    );
  }

  /// ⚠️ **Les codes sont du contrat avec Swift.** Les intervertir ferait dicter en anglais qui
  /// demande sa langue, et l'inverse — sans que rien ne casse ni ne se voie dans un journal.
  #[test]
  fn the_bridge_codes_match_the_swift_side() {
    assert_eq!(Combo::from_code(1), Some(Combo::Spoken));
    assert_eq!(Combo::from_code(2), Some(Combo::Translated));
    assert_eq!(Combo::from_code(0), None);
  }

  /// Un code que Swift n'enverra jamais ne doit pas paniquer : le rappel court sur le fil du
  /// tap clavier, où une panique avorterait le processus.
  #[test]
  fn an_unknown_code_is_no_combination_rather_than_a_panic() {
    for code in [-1, 3, i32::MAX, i32::MIN] {
      assert_eq!(Combo::from_code(code), None, "code {code}");
    }
  }

  /// Le mode voyage vers le frontend et en revient : les deux écritures doivent coïncider
  /// avec `DictationMode` de `settings.ts`, sans quoi le réglage ne s'appliquerait jamais.
  #[test]
  fn modes_travel_in_the_frontend_spelling() {
    let mode = |value: ShortcutMode| serde_json::to_string(&value).expect("sérialisation");

    assert_eq!(mode(ShortcutMode::Hold), "\"hold\"");
    assert_eq!(mode(ShortcutMode::Toggle), "\"toggle\"");
    assert_eq!(
      serde_json::from_str::<ShortcutMode>("\"toggle\"").expect("désérialisation"),
      ShortcutMode::Toggle
    );
  }

  #[test]
  fn an_unknown_mode_is_refused_rather_than_guessed() {
    assert!(serde_json::from_str::<ShortcutMode>("\"tapAndHold\"").is_err());
  }
}
