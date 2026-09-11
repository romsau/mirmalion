//! Le cycle de vie de l'application, qui n'est pas celui d'une app à fenêtre.
//!
//! Mirmalion vit en arrière-plan : aucune présence dans le Dock, une fenêtre qu'on ferme sans
//! quitter, un démarrage silencieux une fois l'onboarding fait. Le seul moyen de la quitter est
//! le menu du tray. Fermer cache la fenêtre principale et ne la détruit pas ; démarrer en
//! silence la crée invisible.
//!
//! # Pièges
//!
//! - ⚠️ Un webview doit survivre à la fermeture : `RecordingSound`, côté Angular, joue les deux
//!   bips de dictée, et la dictée aboutit fenêtre fermée. Détruire la fenêtre principale sans
//!   déplacer les sons rend l'application muette.
//! - ⚠️ Créer une fenêtre active l'application (bogue amont `tauri-apps/tauri#7519`) : tout
//!   appelant qui recréerait la principale volerait le premier plan.

use std::path::Path;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::{
  commands::window as geometry, error::AppError, i18n, settings::Stored, shortcut::ShortcutMode,
};

/// L'étiquette de la fenêtre principale. Une seule vérité, partagée par le tray.
pub const MAIN_WINDOW: &str = "main";

/// L'étiquette de la fenêtre d'onboarding.
///
/// # Pièges
///
/// - ⚠️ Elle est aussi la route Angular (`/onboarding`) : le frontend pose son URL de départ
///   d'après l'étiquette de sa fenêtre, sans table de correspondance — voir `applyWindowRoute`
///   dans `src/app/app.routes.ts`. La renommer ici seul ouvre une fenêtre vide.
pub const ONBOARDING_WINDOW: &str = "onboarding";

/// Le préfixe des étiquettes de fenêtre-document — `filedoc-0`, `filedoc-1`…
///
/// # Pièges
///
/// - ⚠️ Il est écrit ailleurs aussi : `Documents::open` fabrique l'identifiant, et
///   `capabilities/default.json` porte le joker `filedoc-*` sans lequel ces fenêtres n'auraient
///   aucune permission. Le changer ici seul les priverait d'« Enregistrer sous », en silence.
pub const FILEDOC_PREFIX: &str = "filedoc-";

/// La variable d'environnement qui force l'état d'onboarding, en développement.
///
/// `pending` fait réapparaître la fenêtre de bienvenue, `done` simule une machine déjà
/// configurée. Inerte en production, comme `MIRMALION_FORCE_STACK` pour les capacités.
///
/// # Pièges
///
/// - ⚠️ `done` sans tray rend l'application injoignable : aucune fenêtre, aucune icône, rien pour
///   la rappeler. Se rattrape en relançant sans la variable.
const FORCE_ONBOARDING: &str = "MIRMALION_FORCE_ONBOARDING";

/// Place l'application dans le Dock, ou l'en retire.
///
/// # Errors
///
/// Rend [`AppError::Io`] si macOS refuse la politique d'activation demandée.
///
/// # Pièges
///
/// - ⚠️ `skipTaskbar` n'y suffirait pas : sur macOS ce drapeau ne fait rien, seule la politique
///   d'activation décide. Le bundle porte en plus `LSUIElement`, absent en développement.
/// - ⚠️ `Regular` ne donne pas que l'icône du Dock, il donne aussi la barre de menus applicative
///   — d'où le menu minimal posé par `crate::menu`.
pub fn set_dock_visibility(app: &AppHandle, visible: bool) -> Result<(), AppError> {
  let policy = if visible {
    tauri::ActivationPolicy::Regular
  } else {
    tauri::ActivationPolicy::Accessory
  };
  app
    .set_activation_policy(policy)
    .map_err(|error| AppError::Io(format!("politique d'activation : {error}")))?;

  if visible {
    restore_dock_icon(app);
  }
  Ok(())
}

/// Rend au Dock l'icône de l'application, en développement seulement.
///
/// L'échec est absorbé : une icône générique en développement ne justifie pas d'empêcher un
/// démarrage.
///
/// # Pièges
///
/// - ⚠️ Une application packagée n'en a pas besoin, son bundle porte son icône. `tauri dev`
///   exécute un binaire nu, pour lequel macOS affiche le carré « exec » d'un exécutable sans
///   identité. Le chemin des sources, figé à la compilation, n'est acceptable que parce que ce
///   code n'existe pas en release.
fn restore_dock_icon(app: &AppHandle) {
  if !cfg!(debug_assertions) {
    return;
  }
  let icon = concat!(env!("CARGO_MANIFEST_DIR"), "/icons/icon.icns");
  let handle = app.clone();
  let _ = handle.run_on_main_thread(move || {
    if let Err(error) = crate::native::set_dock_icon(icon) {
      log::warn!("icône du Dock non posée : {error}");
    }
  });
}

/// Le fichier qui retient le numéro de version lancé la dernière fois.
///
/// # Pièges
///
/// - ⚠️ Ni la base, ni `settings.json` : la base demanderait une migration pour un numéro que
///   personne ne requête, et le fichier de réglages appartient au frontend — Rust ne fait que
///   le lire.
const LAUNCHED_VERSION_FILE: &str = "last-version";

/// Le numéro de version lancé la dernière fois, `None` si rien n'a été retenu.
///
/// # Pièges
///
/// - ⚠️ Tout ce qui n'est pas un numéro lisible vaut « rien retenu » : fichier absent, illisible,
///   vide. Le doute n'ouvre aucune fenêtre — se tromper dans ce sens ne coûte qu'une fenêtre en
///   moins, se tromper dans l'autre en ouvre une que personne n'a demandée.
fn stored_launched_version(data_dir: &Path) -> Option<String> {
  let contents = std::fs::read_to_string(data_dir.join(LAUNCHED_VERSION_FILE)).ok()?;
  let trimmed = contents.trim();
  (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Retient le numéro de version qui démarre.
///
/// L'échec est absorbé : ne pas pouvoir écrire ce fichier rouvrira une fenêtre au démarrage
/// suivant, ce qui ne justifie pas d'empêcher celui-ci.
fn remember_launched_version(data_dir: &Path, version: &str) {
  if let Err(error) = std::fs::write(data_dir.join(LAUNCHED_VERSION_FILE), version) {
    log::warn!("version lancée non retenue : {error}");
  }
}

/// L'application vient-elle de changer de version ?
///
/// # Pièges
///
/// - ⚠️ On compare, on n'ordonne pas : un retour à une version antérieure compte autant qu'une
///   mise à jour.
/// - ⚠️ **« Rien retenu » COMPTE comme un changement** : c'est l'installation qui vient de
///   recevoir la version où ce fichier apparaît, et la taire aurait fait manquer la première
///   mise à jour. La machine neuve, elle, est écartée par l'onboarding — voir ci-dessous.
fn version_just_changed(previous: Option<&str>, current: &str) -> bool {
  previous != Some(current)
}

/// Le démarrage doit-il montrer la fenêtre de lui-même ?
///
/// Rend `true` une seule fois par version, le numéro qui démarre étant retenu au passage.
///
/// # Pièges
///
/// - ⚠️ **L'écriture a lieu quoi qu'il arrive** : un échec de la fenêtre ne doit pas condamner le
///   démarrage suivant à la rouvrir.
/// - ⚠️ **L'onboarding en cours l'emporte, et c'est lui qui écarte la machine neuve** : elle et
///   l'installation qui vient de gagner ce fichier n'ont ni l'une ni l'autre de version retenue.
pub fn takes_the_screen_after_an_update(
  data_dir: &Path,
  current_version: &str,
  onboarding_pending: bool,
) -> bool {
  let previous = stored_launched_version(data_dir);
  remember_launched_version(data_dir, current_version);
  !onboarding_pending && version_just_changed(previous.as_deref(), current_version)
}

/// L'application doit-elle apparaître dans le Dock ?
///
/// Lu directement dans le fichier de réglages, avant tout frontend — même raison que le thème :
/// la politique d'activation se pose au démarrage, et l'attendre ferait clignoter l'icône.
pub fn stored_show_in_dock(settings_file: &Path) -> bool {
  Stored::read(settings_file).show_in_dock
}

/// L'onboarding a-t-il été fait ?
///
/// Lu directement dans le fichier de réglages, avant que le frontend n'existe — même raison que
/// pour la langue d'interface (voir [`crate::i18n::stored_locale`]).
///
/// # Pièges
///
/// - ⚠️ Tout ce qui n'est pas un `true` franc vaut « pas fait » : fichier absent, JSON cassé, clé
///   manquante, mauvais type. Le doute ouvre la fenêtre — se tromper dans ce sens montre un
///   onboarding en trop, se tromper dans l'autre laisse l'utilisateur devant rien.
pub fn onboarding_completed(settings_file: &Path) -> bool {
  Stored::read(settings_file).onboarding_completed
}

/// Le thème choisi, lu directement dans le fichier de réglages.
///
/// `None` quand rien n'est écrit — au premier lancement, notamment : macOS suit alors l'apparence
/// du système.
///
/// # Pièges
///
/// - ⚠️ Il sert à l'apparence native de la fenêtre, pas à sa peinture, qui vient du CSS. Sans
///   cette lecture, macOS dessine son cadre en clair le temps qu'Angular démarre : un liseré
///   blanc d'un pixel en haut d'une fenêtre sombre. Le poser dès la construction ne le montre
///   jamais.
pub fn stored_theme(settings_file: &Path) -> Option<tauri::Theme> {
  match Stored::read(settings_file).theme.as_deref() {
    Some("dark") => Some(tauri::Theme::Dark),
    Some("light") => Some(tauri::Theme::Light),
    _ => None,
  }
}

/// Le mode de déclenchement du raccourci enregistré par l'utilisateur.
///
/// Le défaut est `hold`, comme `DEFAULT_SETTINGS` de `src/app/core/models/settings.ts` : les
/// deux écritures doivent rester d'accord, et le test le vérifie de ce côté-ci.
///
/// # Pièges
///
/// - ⚠️ Lu au démarrage, avant tout frontend : le raccourci global répond que la fenêtre soit
///   ouverte ou non, et attendre qu'un webview pousse le réglage laisserait toute application
///   démarrée en arrière-plan sur le mode par défaut.
pub fn stored_dictation_mode(settings_file: &Path) -> ShortcutMode {
  Stored::read(settings_file).dictation_mode
}

/// L'état d'onboarding forcé par l'environnement, en développement seulement.
///
/// `None` en production quoi qu'il arrive : la variable y est ignorée, pas seulement absente.
fn forced_onboarding() -> Option<bool> {
  if !cfg!(debug_assertions) {
    return None;
  }
  match std::env::var(FORCE_ONBOARDING).as_deref() {
    Ok("done") => Some(true),
    Ok("pending") => Some(false),
    _ => None,
  }
}

/// Reste-t-il un onboarding à jouer ?
///
/// C'est la seule question que le démarrage pose. Si oui, on ouvre la fenêtre de bienvenue ;
/// sinon, l'application démarre en arrière-plan et c'est le tray ou le raccourci global qui la
/// rappellent.
///
/// # Pièges
///
/// - ⚠️ La fenêtre principale démarre cachée dans les deux cas : la montrer en plus de celle
///   d'onboarding afficherait deux fenêtres au premier lancement, dont une que l'utilisateur n'a
///   rien à faire de voir avant d'avoir accordé ses autorisations.
pub fn onboarding_pending(settings_file: &Path) -> bool {
  !forced_onboarding().unwrap_or_else(|| onboarding_completed(settings_file))
}

/// Crée la fenêtre principale.
///
/// `visible` ne dit pas « ne pas la créer » : elle est construite dans les deux cas, et sa
/// visibilité seule change. Voir l'en-tête du module.
///
/// # Errors
///
/// Rend [`AppError`] si Tauri refuse de construire la fenêtre.
pub fn create_main_window(
  app: &AppHandle,
  locale: &str,
  visible: bool,
  theme: Option<tauri::Theme>,
) -> Result<WebviewWindow, AppError> {
  let window = tauri::WebviewWindowBuilder::new(
    app,
    MAIN_WINDOW,
    tauri::WebviewUrl::App(i18n::window_path(locale, !cfg!(debug_assertions)).into()),
  )
  .title("Mirmalion")
  // ⚠️ **Étroite à la naissance, et c'est une correction visuelle.** La coquille demande la
  // largeur étroite dès son démarrage — l'accueil est Dictée, dont le panneau naît replié — et
  // le redimensionnement est animé : née large, la fenêtre se REPLIAIT sous les yeux à chaque
  // ouverture. Le défaut est ancien et ne se voyait pas, la fenêtre restant cachée jusqu'au clic
  // sur le tray ; montrer la fenêtre au démarrage l'a mis en lumière.
  // ⚠️ La vérité de cette largeur vit côté Angular — voir la note de `startup_width` dans les
  // épreuves de ce module.
  .inner_size(geometry::NARROW_WIDTH, geometry::HEIGHT)
  // Taille fixe : l'application pose sa largeur elle-même selon l'écran affiché
  // (`set_window_compact`), l'utilisateur ne l'étire pas.
  .resizable(false)
  // Les boutons de fenêtre sont dessinés par macOS par-dessus le webview : c'est ce qui permet
  // au header de l'application d'occuper toute la largeur, comme dans la maquette, sans qu'on
  // ait à redessiner des pastilles qui ne fermeraient rien.
  .title_bar_style(tauri::TitleBarStyle::Overlay)
  // Le titre reste dans la fenêtre — donc lu par VoiceOver — mais n'est pas peint : notre
  // header porte déjà la marque.
  .hidden_title(true)
  .visible(visible)
  // L'apparence native, pas la peinture : voir `stored_theme`.
  .theme(theme)
  .build()
  .map_err(i18n::window_error)?;

  // ⚠️ macOS place ses boutons dans sa bande standard de 28 pt ; notre header en fait 50. Sans
  // ce recentrage, les pastilles flottent une dizaine de pixels trop haut.
  geometry::center_buttons(&window);
  close_hides_instead_of_quitting(&window);

  Ok(window)
}

/// Crée la fenêtre du premier lancement : portrait, dédiée, distincte de la principale.
///
/// Distincte parce qu'elle est portrait quand la principale est paysage et à taille fixe.
///
/// # Errors
///
/// Rend [`AppError`] si Tauri refuse de construire la fenêtre.
///
/// # Pièges
///
/// - ⚠️ Fermer celle-ci ne la cache pas, elle se détruit pour de bon. Un onboarding qu'on ferme
///   est un onboarding qu'on refuse : le drapeau n'est pas posé, il se rejouera au lancement
///   suivant.
pub fn create_onboarding_window(
  app: &AppHandle,
  locale: &str,
  theme: Option<tauri::Theme>,
) -> Result<WebviewWindow, AppError> {
  let window = tauri::WebviewWindowBuilder::new(
    app,
    ONBOARDING_WINDOW,
    tauri::WebviewUrl::App(i18n::window_path(locale, !cfg!(debug_assertions)).into()),
  )
  .title("Mirmalion")
  .inner_size(geometry::ONBOARDING_WIDTH, geometry::ONBOARDING_HEIGHT)
  .resizable(false)
  .title_bar_style(tauri::TitleBarStyle::Overlay)
  .hidden_title(true)
  // L'apparence native, pas la peinture : voir `stored_theme`.
  .theme(theme)
  // Au premier lancement, l'application n'a encore rien montré : s'ouvrir au centre est le seul
  // emplacement qui ne surprenne personne.
  .center()
  .build()
  .map_err(i18n::window_error)?;

  // Même barre de titre que la fenêtre principale, donc même recentrage des pastilles.
  geometry::center_buttons(&window);

  Ok(window)
}

/// Ouvre une fenêtre-document, une par transcription.
///
/// Redimensionnable, contrairement à la principale : un transcript se lit à largeurs variables.
///
/// # Errors
///
/// Rend [`AppError`] si Tauri refuse de construire la fenêtre.
///
/// # Pièges
///
/// - ⚠️ L'étiquette est l'identifiant du document, ce qui permet d'en ouvrir plusieurs : le
///   frontend la relit pour savoir quoi afficher — voir `applyWindowRoute`.
/// - ⚠️ Fermer cette fenêtre ne la cache pas : le document est perdu, il n'y a rien derrière.
pub fn create_filedoc_window(app: &AppHandle, id: &str) -> Result<WebviewWindow, AppError> {
  let state = app.state::<crate::AppState>();
  let locale = state.interface_locale();
  let theme = stored_theme(&state.data_dir().join(i18n::SETTINGS_FILE));

  let window = tauri::WebviewWindowBuilder::new(
    app,
    id,
    tauri::WebviewUrl::App(i18n::window_path(locale, !cfg!(debug_assertions)).into()),
  )
  .title("Mirmalion")
  .inner_size(geometry::DOCUMENT_WIDTH, geometry::DOCUMENT_HEIGHT)
  .min_inner_size(geometry::DOCUMENT_MIN_WIDTH, geometry::DOCUMENT_MIN_HEIGHT)
  .resizable(true)
  .title_bar_style(tauri::TitleBarStyle::Overlay)
  .hidden_title(true)
  .theme(theme)
  .center()
  .build()
  .map_err(i18n::window_error)?;

  // ⚠️ En cascade, sans quoi le `.center()` ci-dessus poserait les documents exactement l'un sur
  // l'autre : ouvrir le second ne se verrait pas, et l'utilisateur croirait que rien ne s'est
  // passé.
  //
  // ⚠️ On décale après la construction, pas à la place du centrage : la première fenêtre reste
  // centrée, c'est d'elle que la cascade descend. Un positionnement absolu calculé avant le
  // build demanderait la taille de l'écran, qu'on ne connaît pas encore.
  cascade(&window, existing_documents(app, FILEDOC_PREFIX));

  geometry::center_buttons(&window);
  Ok(window)
}

/// La fenêtre-document d'une session terminée.
///
/// # Errors
///
/// Rend [`AppError`] si Tauri refuse de construire la fenêtre.
///
/// # Pièges
///
/// - ⚠️ Sœur de [`create_filedoc_window`], et distincte : celle-ci porte le compte rendu, que les
///   fichiers n'ont pas. Les fondre à drapeau mettrait cette différence dans un paramètre.
/// - ⚠️ Chaque famille cascade sur la sienne : mêler les deux comptes ferait démarrer la première
///   fenêtre-session décalée de trois crans parce que trois fichiers sont ouverts.
pub fn create_live_window(app: &AppHandle, id: &str) -> Result<WebviewWindow, AppError> {
  let state = app.state::<crate::AppState>();
  let locale = state.interface_locale();
  let theme = stored_theme(&state.data_dir().join(i18n::SETTINGS_FILE));

  let window = tauri::WebviewWindowBuilder::new(
    app,
    id,
    tauri::WebviewUrl::App(i18n::window_path(locale, !cfg!(debug_assertions)).into()),
  )
  .title("Mirmalion")
  .inner_size(geometry::DOCUMENT_WIDTH, geometry::DOCUMENT_HEIGHT)
  .min_inner_size(geometry::DOCUMENT_MIN_WIDTH, geometry::DOCUMENT_MIN_HEIGHT)
  .resizable(true)
  .title_bar_style(tauri::TitleBarStyle::Overlay)
  .hidden_title(true)
  .theme(theme)
  .center()
  .build()
  .map_err(i18n::window_error)?;

  cascade(
    &window,
    existing_documents(app, crate::live::documents::DIRECTDOC_PREFIX),
  );
  geometry::center_buttons(&window);
  Ok(window)
}

/// Le nombre de fenêtres-documents déjà ouvertes, celle qu'on vient de créer exclue.
///
/// # Pièges
///
/// - ⚠️ On compte les fenêtres, pas les documents du magasin : un document dont la fenêtre a été
///   fermée ne doit plus décaler quoi que ce soit, sinon la cascade dérive hors de l'écran.
fn existing_documents(app: &AppHandle, prefix: &str) -> usize {
  app
    .webview_windows()
    .keys()
    .filter(|label| label.starts_with(prefix))
    .count()
    .saturating_sub(1)
}

/// Décale la fenêtre de `rank` crans depuis sa position centrée.
///
/// # Pièges
///
/// - ⚠️ Un échec de lecture ou d'écriture de position est avalé : la cascade est un confort, et
///   refuser d'ouvrir un document faute de l'avoir décalé de 26 pixels perdrait un transcript.
fn cascade(window: &WebviewWindow, rank: usize) {
  if rank == 0 {
    return;
  }
  let Ok(scale) = window.scale_factor() else {
    return;
  };
  let Ok(position) = window.outer_position() else {
    return;
  };
  let step = cascade_offset(rank) * scale;
  #[expect(
    clippy::cast_possible_truncation,
    reason = "un décalage de cascade vaut quelques dizaines de points, borné par `cascade_offset`"
  )]
  let _ = window.set_position(tauri::PhysicalPosition::new(
    position.x + step as i32,
    position.y + step as i32,
  ));
}

/// Le décalage, en points, de la `rank`-ième fenêtre.
///
/// # Pièges
///
/// - ⚠️ Il boucle, et c'est ce qui empêche la cascade de sortir de l'écran : sans plafond, la
///   trentième fenêtre naîtrait hors du moniteur, et une fenêtre invisible est indiscernable
///   d'une fenêtre qui ne s'est pas ouverte. Au-delà du plafond on repart du centre.
fn cascade_offset(rank: usize) -> f64 {
  const STEP: f64 = 26.0;
  const WRAP: usize = 8;
  (rank % WRAP) as f64 * STEP
}

/// Fermer la fenêtre la cache, et ne quitte pas l'application.
///
/// C'est ce qui fait que le raccourci global continue de répondre après un clic sur la pastille
/// rouge. On ne quitte que par le menu du tray.
///
/// # Pièges
///
/// - ⚠️ Aucun `prevent_exit` n'est posé : la fenêtre ne se fermant jamais vraiment, l'application
///   n'atteint jamais « plus aucune fenêtre ». En poser un obligerait le « Quitter » du tray à
///   lever un drapeau pour s'autoriser à partir.
fn close_hides_instead_of_quitting(window: &WebviewWindow) {
  let hidden = window.clone();
  window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      if let Err(error) = hidden.hide() {
        log::warn!("fenêtre non masquée : {error}");
      }
    }
  });
}

/// Sort du premier lancement : la fenêtre principale apparaît, celle d'onboarding disparaît.
///
/// # Errors
///
/// Rend [`AppError::Io`] si la fenêtre principale a disparu, ou l'erreur de Tauri sinon.
///
/// # Pièges
///
/// - ⚠️ On montre la principale avant de fermer l'onboarding : sur un échec de la fermeture,
///   l'utilisateur a au moins une application devant lui.
/// - ⚠️ Fermer l'onboarding est obligatoire : [`reveal`] le ramène tant qu'il existe.
/// - ⚠️ `onboardingCompleted` est posé par le frontend, pas ici : deux auteurs pour une valeur.
pub fn finish_onboarding(app: &AppHandle) -> Result<(), AppError> {
  let main = app
    .get_webview_window(MAIN_WINDOW)
    .ok_or_else(|| AppError::Io("la fenêtre principale a disparu".into()))?;
  main.show()?;
  main.set_focus()?;

  if let Some(onboarding) = app.get_webview_window(ONBOARDING_WINDOW) {
    onboarding.close()?;
  }
  Ok(())
}

/// Qui doit finir devant quand l'application revient au premier plan.
///
/// # Pièges
///
/// - ⚠️ Deux appelants, deux attentes opposées : le clic sur le tray veut retrouver la session en
///   cours, le menu « Réglages » pousse une navigation dans la fenêtre principale et paraîtrait
///   inopérant si elle restait dessous.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Front {
  /// La fenêtre de la session en cours si elle est ouverte, la principale sinon.
  Session,
  /// La fenêtre principale, toujours.
  Main,
}

/// La fenêtre qui doit passer au-dessus de la principale, s'il y en a une.
///
/// # Pièges
///
/// - ⚠️ L'onboarding ne se laisse pas doubler : c'est un parcours qui n'a encore accordé aucune
///   autorisation, et rien ne passe devant lui, même si l'état d'une session traînait.
/// - ⚠️ [`Front::Main`] rend toujours `None` : l'appelant qui la demande va écrire dans la
///   fenêtre principale, et l'enterrer serait un défaut.
fn front_window(front: Front, onboarding_open: bool, session: Option<String>) -> Option<String> {
  match front {
    Front::Main => None,
    Front::Session if onboarding_open => None,
    Front::Session => session,
  }
}

/// Ramène l'application au premier plan : toutes ses fenêtres, la principale au-dessus, et la
/// session en cours par-dessus elle tant qu'elle enregistre ou consolide.
///
/// # Errors
///
/// Rend [`AppError::Io`] si aucune fenêtre n'est à ramener, ou l'erreur de Tauri sinon.
///
/// # Pièges
///
/// - ⚠️ L'ordre est tout : les documents, puis la principale, puis la session en cours.
/// - ⚠️ Les documents remontent avec, sinon ils restent sous les autres applications.
/// - ⚠️ Une fenêtre-document cachée le reste : `show()` rouvrirait ce que l'utilisateur a réduit.
pub fn reveal(app: &AppHandle, front: Front) -> Result<(), AppError> {
  let onboarding = app.get_webview_window(ONBOARDING_WINDOW);
  let ahead = front_window(
    front,
    onboarding.is_some(),
    app
      .state::<std::sync::Arc<crate::live::LiveSession>>()
      .state()
      .document_id,
  );

  // Les fenêtres secondaires d'abord. Une qui refuse de remonter n'empêche pas les autres :
  // échouer ici rendrait le clic sur le tray inopérant, alors qu'il a un travail principal.
  for (label, window) in app.webview_windows() {
    // ⚠️ La pilule d'enregistrement est exclue : c'est un `NSPanel` non activant, qui ne doit
    // jamais prendre le focus sous peine de le voler à l'application dans laquelle l'utilisateur
    // dicte. Elle flotte déjà au-dessus de tout et n'a rien à remonter.
    if label == MAIN_WINDOW
      || label == ONBOARDING_WINDOW
      || label == crate::commands::overlay::OVERLAY_WINDOW
    {
      continue;
    }
    // ⚠️ La session en cours passe après la principale : la remonter ici l'enterrerait aussitôt.
    if ahead.as_deref() == Some(label.as_str()) {
      continue;
    }
    if window.is_visible().unwrap_or(false) {
      let _ = window.set_focus();
    }
  }

  // Puis celle qu'on est venu chercher, qui finit donc au-dessus.
  let window = onboarding
    .or_else(|| app.get_webview_window(MAIN_WINDOW))
    .ok_or_else(|| AppError::Io("aucune fenêtre à ramener au premier plan".into()))?;
  window.show()?;
  window.set_focus()?;

  // ⚠️ Et la session tout en haut, mais seulement si elle est visible, comme les autres
  // documents : `show()` sur une fenêtre réduite la rouvrirait sans qu'on l'ait demandé.
  if let Some(session) = ahead.and_then(|label| app.get_webview_window(&label)) {
    if session.is_visible().unwrap_or(false) {
      let _ = session.set_focus();
    }
  }
  Ok(())
}

/// Un clic sur l'icône du Dock doit-il rappeler une fenêtre ? Oui si l'inventaire — des
/// `(étiquette, visible)` — n'en compte aucune à l'écran.
///
/// # Pièges
///
/// - ⚠️ La pilule de dictée n'entre pas dans le compte : jamais fermée, seulement effacée à 1 %
///   d'opacité (voir `commands::overlay`), elle est « visible » en permanence — y compris pour le
///   `has_visible_windows` d'AppKit, qu'on n'utilise pas pour cette raison.
/// - ⚠️ Une fenêtre déjà à l'écran ne demande rien : macOS active l'application et remonte ses
///   fenêtres seul. Rappeler la principale par-dessus enterrerait le document qu'on lisait.
fn dock_click_needs_reveal<'a>(mut windows: impl Iterator<Item = (&'a str, bool)>) -> bool {
  !windows.any(|(label, visible)| visible && label != crate::commands::overlay::OVERLAY_WINDOW)
}

/// Répond au clic sur l'icône du Dock.
///
/// Troisième point d'entrée de l'application, avec le tray et le raccourci global : sans lui,
/// l'icône du Dock — que l'utilisateur a demandée dans les options — ne rouvre rien.
///
/// L'échec est absorbé, comme au clic sur le tray : il n'y a personne à qui le rendre.
pub fn on_dock_click(app: &AppHandle) {
  let windows: Vec<(String, bool)> = app
    .webview_windows()
    .into_iter()
    .map(|(label, window)| (label, window.is_visible().unwrap_or(false)))
    .collect();
  if !dock_click_needs_reveal(
    windows
      .iter()
      .map(|(label, visible)| (label.as_str(), *visible)),
  ) {
    return;
  }
  // ⚠️ `reveal`, et non « montre la fenêtre principale » : même raison qu'au clic sur le tray,
  // l'onboarding ne se laisse pas doubler.
  if let Err(error) = reveal(app, Front::Session) {
    log::warn!(
      "fenêtre non rappelée depuis le Dock ({}) : {error}",
      error.kind()
    );
  }
}

#[cfg(test)]
mod tests {
  use super::{
    FILEDOC_PREFIX, Front, cascade_offset, dock_click_needs_reveal, front_window,
    remember_launched_version, stored_launched_version, takes_the_screen_after_an_update,
    version_just_changed,
  };

  /// Ce qui passe devant la fenêtre principale, et ce qui n'a pas le droit.
  ///
  /// `reveal` lui-même demande un `AppHandle` et n'est pas éprouvable ici ; la décision, si. Et
  /// c'est elle qui porte les deux gardes : le menu applicatif, qui va écrire dans la fenêtre
  /// principale, et l'onboarding, que rien ne double.
  #[test]
  fn the_running_session_comes_back_above_the_main_window() {
    assert_eq!(
      front_window(Front::Session, false, Some("directdoc-4".into())),
      Some("directdoc-4".into())
    );
  }

  #[test]
  fn nothing_comes_back_ahead_when_no_session_is_running() {
    assert_eq!(front_window(Front::Session, false, None), None);
  }

  /// ⚠️ Le menu applicatif pousse une navigation dans la principale juste après : l'enterrer
  /// ferait paraître « Réglages » sans effet.
  #[test]
  fn the_application_menu_keeps_the_main_window_in_front() {
    assert_eq!(
      front_window(Front::Main, false, Some("directdoc-4".into())),
      None
    );
  }

  /// ⚠️ L'onboarding ne se laisse pas doubler : c'est un parcours qui n'a encore accordé aucune
  /// autorisation, et rien ne passe devant lui — pas même une session qui traînerait.
  #[test]
  fn the_onboarding_is_never_overtaken() {
    assert_eq!(
      front_window(Front::Session, true, Some("directdoc-4".into())),
      None
    );
  }

  /// ⚠️ Une installation qui n'a jamais rien retenu vient de recevoir la version où ce fichier
  /// apparaît : elle a un passé, pas une mémoire. La prendre pour une machine neuve ferait taire
  /// la toute première mise à jour — la seule que personne ne pourrait rattraper.
  #[test]
  fn an_install_without_any_memory_has_just_been_updated() {
    assert!(version_just_changed(None, "0.9.6"));
  }

  #[test]
  fn relaunching_the_same_version_shows_nothing() {
    assert!(!version_just_changed(Some("0.9.6"), "0.9.6"));
  }

  /// ⚠️ Le cas de la demande : l'application redémarre seule après une mise à jour, et
  /// l'utilisateur doit la retrouver à l'écran plutôt que d'aller la chercher dans le tray.
  #[test]
  fn a_new_version_brings_the_window_back() {
    assert!(version_just_changed(Some("0.9.5"), "0.9.6"));
  }

  /// ⚠️ Un retour en arrière est un changement de version comme un autre — on compare, on
  /// n'ordonne pas. Ranger les numéros demanderait de savoir les lire, pour une distinction qui
  /// ne changerait rien à ce qu'on en fait.
  #[test]
  fn stepping_back_to_an_older_version_counts_too() {
    assert!(version_just_changed(Some("0.9.6"), "0.9.5"));
  }

  /// Un dossier de test à soi, effacé derrière.
  fn dossier(nom: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("mirmalion-{nom}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dossier");
    dir
  }

  /// ⚠️ La machine neuve est écartée par l'onboarding, pas par l'absence de mémoire — et le
  /// numéro est tout de même retenu, sans quoi le lancement d'après se croirait mis à jour.
  #[test]
  fn a_blank_machine_leaves_its_onboarding_alone() {
    let dir = dossier("neuve");

    assert!(!takes_the_screen_after_an_update(&dir, "0.9.6", true));
    assert_eq!(stored_launched_version(&dir), Some("0.9.6".to_owned()));

    let _ = std::fs::remove_dir_all(&dir);
  }

  /// ⚠️ Une fois par version, et le troisième cas est celui qui compte : la fenêtre revient à la
  /// mise à jour suivante, elle ne s'est pas tue pour toujours.
  #[test]
  fn an_update_takes_the_screen_once_and_only_once() {
    let dir = dossier("mise-a-jour");

    assert!(
      takes_the_screen_after_an_update(&dir, "0.9.6", false),
      "l'installation qui vient de gagner ce fichier doit se montrer"
    );
    assert!(
      !takes_the_screen_after_an_update(&dir, "0.9.6", false),
      "relancée sans changer de version, elle se tait"
    );
    assert!(
      takes_the_screen_after_an_update(&dir, "0.9.7", false),
      "la mise à jour suivante la ramène"
    );

    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Ce que le démarrage écrit, le démarrage suivant le relit. ⚠️ Un dossier sans fichier rend
  /// `None` — c'est le cas de la machine neuve, et il ne doit pas être une erreur.
  #[test]
  fn the_launched_version_survives_from_one_start_to_the_next() {
    let dir = std::env::temp_dir().join(format!("mirmalion-version-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dossier");
    let _ = std::fs::remove_file(dir.join(super::LAUNCHED_VERSION_FILE));

    assert_eq!(stored_launched_version(&dir), None);
    remember_launched_version(&dir, "0.9.6");
    assert_eq!(stored_launched_version(&dir), Some("0.9.6".to_owned()));

    let _ = std::fs::remove_dir_all(&dir);
  }

  /// ⚠️ Le fichier est écrit par nous, mais rien n'empêche qu'il soit vide — disque plein,
  /// écriture interrompue. Une chaîne vide n'est pas un numéro de version : la traiter comme tel
  /// ferait passer le démarrage suivant pour un changement.
  #[test]
  fn an_empty_file_is_read_as_nothing_retained() {
    let dir = std::env::temp_dir().join(format!("mirmalion-version-vide-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dossier");
    std::fs::write(dir.join(super::LAUNCHED_VERSION_FILE), "  \n").expect("écriture");

    assert_eq!(stored_launched_version(&dir), None);

    let _ = std::fs::remove_dir_all(&dir);
  }

  /// La fenêtre principale naît à la largeur que la coquille va demander.
  ///
  /// ⚠️ **C'est une vérité à cheval sur les deux langages**, et rien ne la tenait : la fenêtre
  /// naît large côté Rust, la coquille demande étroit côté Angular dès son démarrage, et l'écart
  /// se voyait — la fenêtre se repliait sous les yeux, l'animation comprise. Le panneau replié par
  /// défaut est ce qui rend la largeur étroite juste ; s'il venait à s'ouvrir par défaut, c'est
  /// `create_main_window` qu'il faudrait corriger, et c'est ce test qui le dira.
  #[test]
  fn the_main_window_is_born_at_the_width_the_shell_will_ask_for() {
    let store = include_str!("../../src/app/core/store/panel/panel.store.ts");

    assert!(
      store.contains("collapsed: true"),
      "le panneau d'historique ne naît plus replié : la fenêtre principale doit alors naître \
       large, sans quoi elle s'ouvrira étroite puis s'élargira sous les yeux"
    );
  }

  /// ⚠️ C'est le défaut rapporté par le premier test : application dans le Dock, fenêtre fermée,
  /// clic sur l'icône, rien. Sans rappel, le Dock est une icône morte.
  #[test]
  fn the_dock_click_recalls_the_window_when_nothing_is_on_screen() {
    assert!(dock_click_needs_reveal(
      [("main", false), ("filedoc-0", false)].into_iter()
    ));
  }

  /// ⚠️ La pilule de dictée n'est jamais fermée, seulement effacée à 1 % d'opacité : elle compte
  /// pour AppKit comme une fenêtre visible, et la croire rendrait le clic inopérant à jamais.
  #[test]
  fn the_dictation_pill_does_not_count_as_a_window_on_screen() {
    assert!(dock_click_needs_reveal(
      [("main", false), ("overlay", true)].into_iter()
    ));
  }

  /// Une fenêtre déjà à l'écran n'a besoin de personne : macOS active l'application et la remonte
  /// seul. Ressortir la principale par-dessus enterrerait le document qu'on lisait.
  #[test]
  fn the_dock_click_leaves_a_window_already_on_screen_alone() {
    assert!(!dock_click_needs_reveal(
      [("main", false), ("filedoc-0", true)].into_iter()
    ));
  }

  /// ⚠️ Sans cascade, deux fenêtres-documents se posent exactement l'une sur l'autre et ouvrir la
  /// seconde ne se voit pas. Le premier décalage doit donc être nul — la fenêtre de tête reste
  /// centrée — et le second non nul.
  #[test]
  fn the_first_document_stays_centred_and_the_next_ones_step_aside() {
    assert_eq!(cascade_offset(0), 0.0, "la première reste au centre");
    assert!(
      cascade_offset(1) > 0.0,
      "la seconde ne doit pas la recouvrir"
    );
    assert!(
      cascade_offset(2) > cascade_offset(1),
      "chaque fenêtre s'écarte de la précédente"
    );
  }

  /// ⚠️ La cascade boucle, sinon la trentième fenêtre naîtrait hors du moniteur — et une fenêtre
  /// invisible est indiscernable d'une fenêtre qui ne s'est pas ouverte.
  #[test]
  fn the_cascade_wraps_rather_than_walking_off_the_screen() {
    let biggest = (0..64).map(cascade_offset).fold(0.0_f64, f64::max);
    assert!(
      biggest < 250.0,
      "le décalage maximal ({biggest}) doit rester à portée d'écran"
    );
    assert_eq!(
      cascade_offset(0),
      cascade_offset(8),
      "au-delà du plafond, on repart du centre"
    );
  }

  /// Le préfixe est écrit dans trois documents — ici, `Documents::open` et les capacités. Ce test
  /// tient au moins celui des capacités, dont l'oubli serait muet côté utilisateur.
  #[test]
  fn the_filedoc_prefix_matches_the_capability_wildcard() {
    let capabilities = std::fs::read_to_string(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json"),
    )
    .expect("les capacités doivent être lisibles");
    assert!(
      capabilities.contains(&format!("{FILEDOC_PREFIX}*")),
      "sans le joker « {FILEDOC_PREFIX}* », une fenêtre-document n'aurait aucune permission"
    );
  }

  use super::{
    MAIN_WINDOW, ONBOARDING_WINDOW, ShortcutMode, onboarding_completed, onboarding_pending,
    stored_dictation_mode,
  };
  use std::path::PathBuf;

  /// Un répertoire de travail effacé à la sortie du test.
  struct TempDir(PathBuf);

  impl TempDir {
    /// Ouvre un répertoire vide sous celui des fichiers temporaires.
    fn new(name: &str) -> Self {
      let path = std::env::temp_dir().join(format!("mirmalion-lifecycle-{name}"));
      let _ = std::fs::remove_dir_all(&path);
      std::fs::create_dir_all(&path).expect("répertoire");
      Self(path)
    }

    /// Écrit un fichier de réglages de test et rend son chemin.
    fn write(&self, name: &str, contents: &str) -> PathBuf {
      let path = self.0.join(name);
      std::fs::write(&path, contents).expect("écriture");
      path
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn a_franc_true_is_the_only_thing_that_counts_as_done() {
    let dir = TempDir::new("done");
    assert!(onboarding_completed(
      &dir.write("fait.json", r#"{"onboardingCompleted":true}"#)
    ));
  }

  /// Le doute ouvre la fenêtre : un onboarding en trop se ferme, une application invisible
  /// ne se rattrape pas.
  #[test]
  fn everything_else_counts_as_not_done() {
    let dir = TempDir::new("pending");
    assert!(!onboarding_completed(&dir.0.join("jamais-ecrit.json")));
    assert!(!onboarding_completed(
      &dir.write("casse.json", "{ pas du json")
    ));
    assert!(!onboarding_completed(
      &dir.write("sans.json", r#"{"theme":"dark"}"#)
    ));
    assert!(!onboarding_completed(
      &dir.write("type.json", r#"{"onboardingCompleted":"oui"}"#)
    ));
    assert!(!onboarding_completed(
      &dir.write("faux.json", r#"{"onboardingCompleted":false}"#)
    ));
  }

  /// Le fichier de capacités, relu depuis le disque.
  fn capabilities() -> serde_json::Value {
    let raw = std::fs::read_to_string(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json"),
    )
    .expect("le fichier de capacités doit être lisible");
    serde_json::from_str(&raw).expect("du JSON valide")
  }

  /// Les commandes qu'une permission autorise, jeux par défaut et ensembles résolus.
  ///
  /// Mirroir de ce que fait Tauri à la génération, lu dans `gen/schemas/acl-manifests.json` —
  /// que `build.rs` réécrit avant chaque compilation.
  fn allowed_commands(manifests: &serde_json::Value, identifier: &str) -> Vec<String> {
    let (plugin, name) = match identifier.split(':').collect::<Vec<_>>()[..] {
      ["core", family, permission] => (format!("core:{family}"), permission.to_owned()),
      [plugin, permission] => (plugin.to_owned(), permission.to_owned()),
      _ => return Vec::new(),
    };
    let manifest = &manifests[&plugin];
    let mut found = Vec::new();

    // ⚠️ Les noms sont qualifiés par leur greffon, et ce n'est pas de la coquetterie : `save`
    // désigne à la fois la boîte « Enregistrer sous » et l'écriture du magasin de réglages. Nus,
    // les deux se confondent, et retirer l'un ne se verrait pas tant que l'autre reste.
    let mut take = |entry: &serde_json::Value| {
      if let Some(list) = entry["commands"]["allow"].as_array() {
        found.extend(
          list
            .iter()
            .filter_map(|value| value.as_str())
            .map(|command| format!("{plugin}|{command}")),
        );
      }
    };

    // Un `:default` renvoie à `default_permission`, qui référence d'autres permissions.
    let referenced = if name == "default" {
      take(&manifest["default_permission"]);
      manifest["default_permission"]["permissions"].as_array()
    } else {
      take(&manifest["permissions"][&name]);
      manifest["permission_sets"][&name]["permissions"].as_array()
    };
    for child in referenced.into_iter().flatten() {
      let Some(child) = child.as_str() else {
        continue;
      };
      let full = if child.contains(':') {
        child.to_owned()
      } else {
        format!("{plugin}:{child}")
      };
      found.extend(allowed_commands(manifests, &full));
    }
    found
  }

  /// ⚠️ **La garde que nul relecteur ne peut tenir : une montée de version qui élargit un jeu.**
  /// `store:default` est le seul ensemble large qui reste, et son contenu appartient au greffon.
  /// Le jour où il gagne une commande, ce test le dit ; sans lui, l'ACL s'élargit en silence.
  #[test]
  fn the_granted_permissions_resolve_to_the_commands_we_measured() {
    let raw = std::fs::read_to_string(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gen/schemas/acl-manifests.json"),
    )
    .expect("l'ACL résolue est écrite par build.rs");
    let manifests: serde_json::Value = serde_json::from_str(&raw).expect("du JSON valide");

    let mut granted: Vec<String> = capabilities()["permissions"]
      .as_array()
      .expect("« permissions » doit être une liste")
      .iter()
      .filter_map(|value| value.as_str())
      .flat_map(|identifier| allowed_commands(&manifests, identifier))
      .collect();
    granted.sort_unstable();
    granted.dedup();

    let expected = [
      // Le magasin de réglages, par `store:default`.
      "store|clear",
      "store|delete",
      "store|entries",
      "store|get",
      "store|get_store",
      "store|has",
      "store|keys",
      "store|length",
      "store|load",
      "store|reload",
      "store|reset",
      "store|save",
      "store|set",
      "store|values",
      // Les abonnements, le sélecteur de « Parcourir », les régions de titre.
      "core:event|listen",
      "core:event|unlisten",
      "core:window|start_dragging",
      "dialog|open",
    ];
    let mut expected = expected.map(str::to_owned).to_vec();
    expected.sort_unstable();

    assert_eq!(
      granted, expected,
      "l'ACL n'autorise plus le même jeu de commandes qu'au relevé"
    );

    // ⚠️ Nommées une à une parce que ce sont celles qui coûteraient cher : un webview compromis
    // qui peut émettre vers une autre fenêtre, ouvrir les outils de développement ou créer une
    // fenêtre n'est plus contenu par le reste.
    for dangerous in [
      "core:event|emit",
      "core:event|emit_to",
      "core:webview|internal_toggle_devtools",
      "core:window|create",
      "core:window|close",
      // ⚠️ La boîte « Enregistrer sous » : Rust l'ouvre lui-même, et la rendre au webview lui
      // rendrait le droit de désigner un fichier à écrire — voir `commands::export`.
      "dialog|save",
    ] {
      assert!(
        !granted.iter().any(|command| command == dangerous),
        "« {dangerous} » est redevenu accessible au frontend"
      );
    }
  }

  /// ⚠️ **Le relevé du moindre privilège, tenu par une épreuve.** Un jeu par défaut réintroduit
  /// ici — `core:default` en particulier — n'échoue nulle part : il accorde simplement plus. Ce
  /// test est le seul endroit d'où l'élargissement se voit.
  ///
  /// Chaque entrée correspond à un appel mesuré dans `src/app/` ; les commandes du backend, elles,
  /// ne passent par aucune permission.
  #[test]
  fn the_capabilities_grant_only_what_the_frontend_calls() {
    let granted = capabilities()["permissions"]
      .as_array()
      .expect("« permissions » doit être une liste")
      .iter()
      .map(|value| value.as_str().unwrap_or_default().to_owned())
      .collect::<Vec<_>>();

    let measured = [
      // `Invoke.listen`, et les deux abonnements que Tauri construit dessus :
      // `onCloseRequested` et `onDragDropEvent`.
      "core:event:allow-listen",
      "core:event:allow-unlisten",
      // Les régions de titre déplaçables.
      "core:window:allow-start-dragging",
      // Les réglages non sensibles.
      "store:default",
      // Le sélecteur de « Parcourir ». Pas de `allow-save` : la boîte « Enregistrer sous » est
      // ouverte par Rust, dans son propre processus — voir `commands::export`.
      "dialog:allow-open",
    ];

    assert_eq!(
      granted, measured,
      "les capacités ne correspondent plus au relevé : mesurer avant d'élargir"
    );
  }

  /// ⚠️ Le garde-fou de la fenêtre oubliée : Tauri 2 refuse par défaut, et une étiquette absente
  /// de `capabilities/default.json` n'a aucune permission. Le symptôme est muet — la fenêtre
  /// s'affiche, se peint, réagit aux clics, mais ne se déplace plus et n'écoute aucun évènement.
  /// Ce test est ce qui rend l'oubli bruyant.
  #[test]
  fn every_window_label_is_declared_in_the_capabilities() {
    let declared = capabilities();
    let windows = declared["windows"]
      .as_array()
      .expect("« windows » doit être une liste");

    for label in [
      MAIN_WINDOW,
      ONBOARDING_WINDOW,
      crate::commands::overlay::OVERLAY_WINDOW,
    ] {
      assert!(
        windows.iter().any(|declared| declared == label),
        "la fenêtre « {label} » n'a aucune permission : ajoute-la à capabilities/default.json"
      );
    }
  }

  /// Le mode du raccourci est lu au démarrage, avant tout frontend : il doit survivre à un
  /// fichier absent, tronqué, ou écrit par une version qui connaîtrait un troisième mode.
  #[test]
  fn the_dictation_mode_falls_back_to_hold_on_anything_unreadable() {
    let dir = TempDir::new("mode");

    assert_eq!(
      stored_dictation_mode(&dir.write("choisi.json", r#"{"dictationMode":"toggle"}"#)),
      ShortcutMode::Toggle
    );
    assert_eq!(
      stored_dictation_mode(&dir.write("explicite.json", r#"{"dictationMode":"hold"}"#)),
      ShortcutMode::Hold
    );

    for (name, contents) in [
      ("casse.json", "{ pas du json"),
      ("sans.json", r#"{"theme":"dark"}"#),
      ("type.json", r#"{"dictationMode":3}"#),
      ("inconnu.json", r#"{"dictationMode":"tapAndHold"}"#),
    ] {
      assert_eq!(
        stored_dictation_mode(&dir.write(name, contents)),
        ShortcutMode::Hold,
        "{name}"
      );
    }
    assert_eq!(
      stored_dictation_mode(&dir.0.join("jamais-ecrit.json")),
      ShortcutMode::Hold
    );
  }

  #[test]
  fn a_blank_machine_still_has_its_onboarding_to_play() {
    let dir = TempDir::new("pending-question");
    assert!(onboarding_pending(&dir.0.join("vierge.json")));
    assert!(!onboarding_pending(
      &dir.write("fait.json", r#"{"onboardingCompleted":true}"#)
    ));
  }
}
