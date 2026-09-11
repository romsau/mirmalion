//! L'icône de la barre de menus et son menu.
//!
//! Clic gauche : la fenêtre revient et passe devant, l'intention de neuf clics sur dix. Clic
//! droit : le menu, qui ne contient que l'identité de l'application et « Quitter ». Pendant un
//! direct, l'icône bat — voir [`set_pulsing`].
//!
//! # Pièges
//!
//! - ⚠️ C'est le seul moyen de quitter l'application : un tray qui ne se construit pas la rend
//!   inquittable. C'est aussi son point d'entrée pour qui a décoché l'icône du Dock.
//! - ⚠️ **Les deux clics ne se réunissent pas**, et ce n'est pas une limite de Tauri : avec
//!   `show_menu_on_left_click(true)`, le relâchement ne nous parvient plus — le menu a capté la
//!   souris —, et rappeler la fenêtre à l'appui referme le menu aussitôt, le passage au premier
//!   plan cassant sa capture. Mesuré dans les deux sens.

use tauri::{
  AppHandle, Manager,
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::{error::AppError, lifecycle};

/// L'identifiant de l'entrée « Quitter ». Comparé tel quel dans le gestionnaire.
const QUIT: &str = "quit";

/// L'identifiant de l'icône, celui que [`set_recording`] va rechercher.
const TRAY: &str = "main";

/// Ce que l'infobulle du tray dit pendant un enregistrement, dans les 6 langues.
///
/// # Pièges
///
/// - ⚠️ En dictée, c'est tout ce qui dit qu'un micro est ouvert : l'icône n'y bat pas, et rien
///   ne se peint à côté d'elle — voir [`set_recording`]. Elle sert d'abord qui n'a que la voix.
/// - ⚠️ Comme [`quit_label`], elle échappe à `$localize` : le tray est natif, hors de tout
///   webview. Une septième langue se pose dans les deux tables à la fois.
fn recording_tooltip(locale: &str) -> &'static str {
  match locale {
    "en" => "Mirmalion is recording",
    "es" => "Mirmalion está grabando",
    "de" => "Mirmalion nimmt auf",
    "it" => "Mirmalion sta registrando",
    "pt" => "O Mirmalion está a gravar",
    _ => "Mirmalion enregistre",
  }
}

/// La langue en vigueur, pour les textes natifs du tray.
///
/// # Pièges
///
/// - ⚠️ Elle change en cours de vie : changer de langue ne relance pas l'application. La valeur
///   est donc mutable, posée par [`relabel`].
/// - ⚠️ Mémorisée plutôt que relue dans le fichier de réglages : [`set_recording`] est appelé à
///   chaque début et fin de dictée, et lire le disque à chaque bascule serait absurde.
struct TrayLocale(std::sync::Mutex<String>);

impl TrayLocale {
  /// La langue mémorisée, un verrou empoisonné valant sa dernière valeur.
  fn read(&self) -> String {
    self
      .0
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .clone()
  }
}

/// Allume ou éteint l'état d'enregistrement de l'icône, par l'infobulle seule.
///
/// Il vaut pour la dictée autant que pour le direct : même micro, même question.
///
/// # Pièges
///
/// - ⚠️ Rien ne se peint à côté de l'icône : la marque qui s'y posait faisait doublon avec la
///   pilule et clignotait à chaque dictée. En dictée, pilule coupée, l'infobulle est donc le seul
///   repère — risque assumé. Le direct, lui, fait battre l'icône : voir [`set_pulsing`].
/// - ⚠️ Idempotent et sans échec : appelé sur des chemins d'arrêt qui peuvent eux-mêmes avoir
///   échoué, il journalise une icône introuvable au lieu de la remonter.
pub fn set_recording(app: &AppHandle, recording: bool) {
  let Some(tray) = app.tray_by_id(TRAY) else {
    log::warn!("icône du tray introuvable : état d'enregistrement non posé");
    return;
  };
  let locale = app.try_state::<TrayLocale>().map(|held| held.read());
  let tooltip = recording
    .then(|| recording_tooltip(locale.as_deref().unwrap_or_default()))
    .map(str::to_owned);

  if let Err(error) = tray.set_tooltip(tooltip.as_deref()) {
    log::warn!("infobulle du tray non posée : {error}");
  }
}

/// Les opacités du battement, du logo plein au plus estompé.
///
/// # Pièges
///
/// - ⚠️ Le dernier palier ne descend pas plus bas : sous ce seuil l'icône passe pour absente, et
///   une icône disparue se lit comme un plantage, pas comme un enregistrement.
const PULSE_OPACITIES: [u8; 6] = [255, 214, 173, 132, 91, 51];

/// Le temps que dure un palier — six paliers en aller-retour font un cycle de 1,6 s.
///
/// # Pièges
///
/// - ⚠️ C'est aussi le retard maximal de l'extinction : l'arrêt ne repeint rien lui-même, il
///   périme la boucle, qui repose l'icône pleine à son réveil.
const PULSE_STEP: std::time::Duration = std::time::Duration::from_millis(160);

/// La génération du battement en cours. Chaque appel de [`set_pulsing`] l'incrémente, et une
/// boucle qui n'y retrouve plus la sienne s'arrête.
///
/// # Pièges
///
/// - ⚠️ C'est ce qui rend [`set_pulsing`] idempotent : deux démarrages ne laissent qu'une boucle,
///   la première se voyant périmée par le second.
static PULSE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Le palier à peindre au `tick`-ième pas, en aller-retour.
///
/// # Pièges
///
/// - ⚠️ Les extrémités ne se tiennent pas deux pas de suite : un aller-retour qui marque une pause
///   en haut et en bas saccade à l'œil au lieu de souffler.
fn pulse_frame(tick: usize) -> usize {
  let steps = PULSE_OPACITIES.len();
  let period = (steps - 1) * 2;
  let position = tick % period;
  if position < steps {
    position
  } else {
    period - position
  }
}

/// La même image, son seul canal alpha multiplié par `opacity`.
///
/// # Pièges
///
/// - ⚠️ Les trois autres canaux ne bougent pas : l'icône est une « template », et c'est macOS qui
///   la peint. Toucher à ses couleurs ne changerait rien à l'écran et grossirait le calcul.
fn faded(rgba: &[u8], opacity: u8) -> Vec<u8> {
  rgba
    .iter()
    .enumerate()
    .map(|(index, &channel)| {
      if index % 4 == 3 {
        // Le produit divisé par 255 ne peut pas dépasser 255 ; la saturation ne sert jamais.
        u8::try_from(u16::from(channel) * u16::from(opacity) / 255).unwrap_or(u8::MAX)
      } else {
        channel
      }
    })
    .collect()
}

/// Les paliers du battement, calculés une fois pour toute la vie du processus.
///
/// # Pièges
///
/// - ⚠️ Une seule source, `icons/tray.png` — celle que [`build`] pose. Un second fichier livré à
///   côté dériverait du premier au premier retouche du logo, sans que rien ne le dise.
fn pulse_frames() -> &'static [tauri::image::Image<'static>] {
  static FRAMES: std::sync::OnceLock<Vec<tauri::image::Image<'static>>> =
    std::sync::OnceLock::new();
  FRAMES.get_or_init(|| {
    let base = tauri::include_image!("icons/tray.png");
    PULSE_OPACITIES
      .iter()
      .map(|&opacity| {
        tauri::image::Image::new_owned(faded(base.rgba(), opacity), base.width(), base.height())
      })
      .collect()
  })
}

/// Pose un palier sur l'icône. Rend `false` si le système l'a refusé.
///
/// # Pièges
///
/// - ⚠️ `set_icon_with_as_template` et non `set_icon` : sur macOS, reposer le drapeau « template »
///   en deux temps fait scintiller l'icône, qui est alors rendue deux fois.
/// - ⚠️ L'échec arrête le battement au lieu d'insister : repeindre dix fois par seconde une icône
///   que le système refuse remplirait le journal jusqu'à en chasser par rotation ce qui expliquait
///   la panne.
fn paint(tray: &tauri::tray::TrayIcon, frame: &tauri::image::Image<'_>) -> bool {
  let icon = tauri::image::Image::new(frame.rgba(), frame.width(), frame.height());
  match tray.set_icon_with_as_template(Some(icon), true) {
    Ok(()) => true,
    Err(error) => {
      log::warn!("icône du tray non repeinte : {error}");
      false
    }
  }
}

/// Fait battre l'icône pendant un direct, ou la repose pleine.
///
/// # Pièges
///
/// - ⚠️ **Jamais pour la dictée** : l'icône a déjà porté une marque d'enregistrement, retirée
///   parce qu'elle clignotait à chaque dictée. C'est la durée d'une session qui justifie le
///   repère, pas le micro ouvert.
/// - ⚠️ Idempotent et sans échec, comme [`set_recording`] : appelé sur des chemins d'arrêt qui
///   peuvent eux-mêmes avoir échoué, il journalise une icône introuvable au lieu de la remonter.
/// - ⚠️ Un fil dédié, et non une tâche du runtime : la boucle dort les neuf dixièmes du temps.
pub fn set_pulsing(app: &AppHandle, pulsing: bool) {
  // ⚠️ Incrémenté avant tout le reste, y compris à l'arrêt : c'est ce qui périme la boucle en
  // cours, et elle seule repeint l'icône — la repeindre ici aussi la laisserait estompée une
  // session sur deux, la boucle repassant après nous.
  let generation = PULSE
    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    .wrapping_add(1);
  if !pulsing {
    return;
  }

  let Some(tray) = app.tray_by_id(TRAY) else {
    log::warn!("icône du tray introuvable : le direct ne se voit pas dans la barre de menus");
    return;
  };
  std::thread::spawn(move || {
    let frames = pulse_frames();
    let mut tick = 0usize;
    while PULSE.load(std::sync::atomic::Ordering::SeqCst) == generation
      && paint(&tray, &frames[pulse_frame(tick)])
    {
      tick = tick.wrapping_add(1);
      std::thread::sleep(PULSE_STEP);
    }
    paint(&tray, &frames[0]);
  });
}

/// « Quitter », dans les 6 langues d'interface.
///
/// # Pièges
///
/// - ⚠️ Ce texte échappe à `$localize` : c'est un `NSMenu` natif, construit par Rust, hors de
///   tout webview, et il n'a donc pas d'unité de traduction dans `src/locale/`.
fn quit_label(locale: &str) -> &'static str {
  match locale {
    "en" => "Quit",
    "es" => "Salir",
    "de" => "Beenden",
    "it" => "Esci",
    "pt" => "Sair",
    _ => "Quitter",
  }
}

/// Monte l'icône de la barre de menus et son menu.
///
/// Le menu tient en deux lignes : l'identité de l'application, non cliquable, puis « Quitter ».
/// La maquette peint le nom à la couleur d'accent et la version en gras ; un menu natif ne sait
/// pas faire, et l'entrée désactivée en est l'équivalent système.
///
/// # Errors
///
/// Rend [`AppError`] si Tauri refuse de construire le menu ou de poser l'icône.
pub fn build(app: &AppHandle, locale: &str) -> Result<(), AppError> {
  app.manage(TrayLocale(std::sync::Mutex::new(locale.to_owned())));

  TrayIconBuilder::with_id(TRAY)
    // ⚠️ Image « template » : macOS la repeint lui-même selon le thème et l'activité de la
    // barre. Sans ce drapeau, l'icône reste noire et devient invisible en thème sombre.
    //
    // ⚠️ `icons/tray.png` n'est pas `docs/ui/logo/logo-tray.png` recopié : macOS ajuste l'icône à
    // 18 pt de haut, canevas transparent compris, donc c'est le rapport du canevas qui décide de
    // la taille apparente. Le fichier porte 15 px de marge verticale pour rendre 31 × 15 pt ; un
    // canevas carré rendait 18 × 8,5 pt, deux fois trop petit.
    .icon(tauri::include_image!("icons/tray.png"))
    .icon_as_template(true)
    .menu(&menu(app, locale)?)
    // Le clic gauche nous revient au lieu de dérouler le menu — voir l'en-tête du module.
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| {
      if event.id() == QUIT {
        // Sortie franche. Aucun `prevent_exit` n'est posé (voir `lifecycle`), donc rien
        // n'a besoin de lever un drapeau pour s'autoriser à partir.
        app.exit(0);
      }
    })
    .on_tray_icon_event(|tray, event| {
      // Au relâchement, pas à l'appui : c'est ce que fait le système, et cela laisse la
      // possibilité d'annuler en glissant hors de l'icône.
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        // ⚠️ `reveal`, et non « montre la fenêtre principale » : tant que l'onboarding est
        // ouvert, c'est lui qu'il faut ramener devant. Ouvrir l'application par-dessus
        // laisserait contourner un parcours qui n'a encore accordé aucune autorisation.
        if let Err(error) = lifecycle::reveal(tray.app_handle(), lifecycle::Front::Session) {
          log::warn!("fenêtre non rappelée ({}) : {error}", error.kind());
        }
      }
    })
    .build(app)?;

  Ok(())
}

/// Le menu du tray, dans une langue donnée.
///
/// Séparé de [`build`] parce qu'il se reconstruit : c'est la seule partie du tray qui porte du
/// texte, l'icône n'en ayant aucun.
///
/// # Errors
///
/// Rend [`AppError`] si Tauri refuse de construire une entrée ou le menu.
fn menu(app: &AppHandle, locale: &str) -> Result<Menu<tauri::Wry>, AppError> {
  let package = app.package_info();
  let identity = format!("{} {}", package.name, package.version);
  Ok(Menu::with_items(
    app,
    &[
      &MenuItem::with_id(app, "identity", identity, false, None::<&str>)?,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, QUIT, quit_label(locale), true, None::<&str>)?,
    ],
  )?)
}

/// Réécrit les textes natifs du tray dans une autre langue.
///
/// # Pièges
///
/// - ⚠️ On remplace le menu, on ne reconstruit pas l'icône : `TrayIconBuilder::build` en poserait
///   une seconde dans la barre, et le gestionnaire de clic serait enregistré deux fois.
/// - ⚠️ L'infobulle n'est pas reposée : elle n'existe que pendant un enregistrement, et
///   [`set_recording`] la réécrira dans la nouvelle langue au prochain.
/// - ⚠️ Sans échec, comme [`set_recording`] : une icône introuvable se journalise, l'interface
///   ayant de toute façon déjà changé de langue.
pub fn relabel(app: &AppHandle, locale: &str) {
  if let Some(held) = app.try_state::<TrayLocale>() {
    *held
      .0
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner()) = locale.to_owned();
  }

  let Some(tray) = app.tray_by_id(TRAY) else {
    log::warn!("icône du tray introuvable : menu non retraduit");
    return;
  };
  match menu(app, locale) {
    Ok(menu) => {
      if let Err(error) = tray.set_menu(Some(menu)) {
        log::warn!("menu du tray non retraduit : {error}");
      }
    }
    Err(error) => log::warn!("menu du tray non construit : {error}"),
  }
}

#[cfg(test)]
mod tests {
  use super::{PULSE_OPACITIES, faded, pulse_frame, quit_label, recording_tooltip};

  /// Le battement va du plein à l'estompé puis revient, sans jamais tenir deux fois de suite le
  /// même bout : un aller-retour qui marque une pause aux extrémités saccade à l'œil.
  #[test]
  fn the_pulse_goes_down_and_comes_back_without_holding_its_ends() {
    let cycle: Vec<usize> = (0..12).map(pulse_frame).collect();
    assert_eq!(cycle, vec![0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 1]);
  }

  /// ⚠️ Le battement peut tourner trois heures : à 160 ms le pas, le compteur dépasse le million
  /// avant la fin d'une longue session, et un calcul qui déborderait figerait l'icône.
  #[test]
  fn the_pulse_still_turns_after_a_very_long_session() {
    let period = (PULSE_OPACITIES.len() - 1) * 2;
    for tick in 0..period {
      assert_eq!(pulse_frame(tick), pulse_frame(tick + 1_000_000 * period));
    }
  }

  /// ⚠️ Le logo ne s'efface jamais tout à fait : une icône disparue se lit comme un plantage,
  /// pas comme un enregistrement. La borne ne prétend pas dire le bon palier — celui-là se règle
  /// à l'œil, sur une vraie barre de menus ; elle interdit seulement de le régler à rien.
  #[test]
  fn the_faintest_step_still_shows_the_logo() {
    let faintest = PULSE_OPACITIES[PULSE_OPACITIES.len() - 1];
    assert!(faintest > 32, "l'icône passerait pour absente");
    assert!(faintest < 255, "l'icône ne battrait pas");
  }

  /// Les paliers descendent, sans plateau : deux paliers égaux tiendraient la même image deux
  /// fois plus longtemps et casseraient la régularité du souffle.
  #[test]
  fn the_steps_of_the_pulse_only_go_down() {
    for pair in PULSE_OPACITIES.windows(2) {
      assert!(pair[0] > pair[1], "deux paliers ne se suivent pas");
    }
  }

  /// Seule l'alpha bouge : toucher aux couleurs repeindrait un logo que macOS repeint déjà
  /// lui-même, l'image étant une « template ».
  #[test]
  fn fading_only_touches_the_transparency() {
    let pixel = [10, 20, 30, 200, 40, 50, 60, 255];
    let half = faded(&pixel, 128);
    assert_eq!(half.len(), pixel.len());
    assert_eq!(&half[0..3], &pixel[0..3]);
    assert_eq!(&half[4..7], &pixel[4..7]);
    assert_eq!(half[3], 100);
    assert_eq!(half[7], 128);
  }

  /// Le premier palier est l'icône telle qu'elle est livrée : le battement doit pouvoir la
  /// reposer intacte quand la session s'arrête.
  #[test]
  fn the_first_step_leaves_the_icon_untouched() {
    let pixel = [1, 2, 3, 77, 4, 5, 6, 255];
    assert_eq!(faded(&pixel, PULSE_OPACITIES[0]), pixel.to_vec());
  }

  /// Les 6 langues d'interface. Elles ne sont pas relues depuis `i18n::SUPPORTED_LOCALES` à
  /// dessein : ce test doit échouer le jour où une langue est ajoutée sans traduction.
  #[test]
  fn every_interface_language_has_its_own_word_for_quitting() {
    let labels = ["fr", "en", "es", "de", "it", "pt"].map(quit_label);
    let mut distinct = labels.to_vec();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(
      distinct.len(),
      labels.len(),
      "deux langues partagent le même libellé — l'une n'est pas traduite"
    );
  }

  /// Le français est la locale source : c'est lui que doit rendre le repli, pas l'anglais.
  #[test]
  fn an_unknown_locale_falls_back_to_the_source_language() {
    assert_eq!(quit_label("klingon"), "Quitter");
    assert_eq!(quit_label("fr"), "Quitter");
    assert_eq!(recording_tooltip("klingon"), "Mirmalion enregistre");
  }

  /// ⚠️ Sans l'infobulle, l'état d'enregistrement serait invisible pour qui n'a que la voix,
  /// c'est-à-dire pour qui ne verra pas non plus la pilule. Les deux tables du tray vont
  /// ensemble : ce test doit échouer le jour où une langue est ajoutée sans traduction.
  #[test]
  fn every_interface_language_says_that_it_is_recording() {
    let tooltips = ["fr", "en", "es", "de", "it", "pt"].map(recording_tooltip);
    let mut distinct = tooltips.to_vec();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(
      distinct.len(),
      tooltips.len(),
      "deux langues partagent la même infobulle — l'une n'est pas traduite"
    );
    for tooltip in tooltips {
      assert!(!tooltip.is_empty());
    }
  }

  /// ⚠️ Rien ne se peint **à côté** de l'icône : le point plein qu'elle portait faisait doublon
  /// avec la pilule et clignotait à chaque dictée. L'icône elle-même bat pendant un direct, ce qui
  /// est autre chose. Ce test garde la porte — remettre une marque demanderait de le retirer
  /// d'abord, donc d'y penser.
  #[test]
  fn nothing_is_ever_painted_next_to_the_icon() {
    let source = include_str!("tray.rs");
    assert!(
      !source.contains(&format!("set_{}", "title")),
      "l'icône du tray ne porte plus de marque visible — voir `set_recording`"
    );
  }
}
