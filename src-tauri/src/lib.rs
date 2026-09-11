// ⚠️ La règle du projet — jamais de panique dans le code qui tourne chez l'utilisateur — imposée
// par le compilateur plutôt que par la relecture. Le crate est **déjà à zéro** : ce n'est pas une
// dette à rembourser, c'est un cliquet posé sur une discipline acquise, et la seule dérogation
// est annotée sur `run()`.
//
// ⚠️ Ici et non dans `Cargo.toml` : `[lints]` vaudrait aussi pour `build.rs` et pour les treize
// crates de `tests/`, qui ne tournent chez personne. C'est la **bibliothèque** qui est livrée.
//
// ⚠️ Les modules `#[cfg(test)]` en sont dispensés par `clippy.toml` — un test est le seul endroit
// où l'on veut qu'un échec inattendu s'arrête net.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
// ⚠️ Un bloc `unsafe` sans `// SAFETY:` au-dessus est refusé — sauf dans `native`, qui documente
// ses soixante appels de pont **en une fois**, sur le bloc `extern "C"` : les y répéter un par un
// rendrait le commentaire décoratif, et un commentaire décoratif finit par mentir.
#![deny(clippy::undocumented_unsafe_blocks)]

//! Point d'assemblage de l'application Tauri : plugins, état partagé, commandes IPC.
//!
//! Aucune logique métier ici — elle vit dans `commands/`, `lifecycle.rs`, `tray.rs`,
//! `state.rs` et `error.rs`.

mod blocking;
mod commands;
mod db;
mod diarization;
mod dictation;
mod dictionary;
mod error;
/// La sérialisation d'un transcript vers les six formats texte.
///
/// Public au même titre que `measure`, et pour la même raison : module pur, sans I/O ni moteur,
/// qu'une mesure doit pouvoir rejouer depuis un crate de test. Rien du produit n'y accède
/// directement — les fonctionnalités passent par `commands`.
pub mod export;
mod filedoc;
mod i18n;
mod jobs;
mod lifecycle;
mod live;
mod llm;
mod logging;
mod media;
mod menu;
mod native;
mod security;
mod settings;
mod shortcut;
mod state;
mod stt;
mod transcript;
mod translation;
mod tray;

/// Les points d'entrée dont une mesure a besoin, et rien d'autre.
///
/// Ce n'est pas une API : il existe pour qu'un test d'intégration — un crate à part — atteigne la
/// frontière native sans qu'on rende `native` public. Rien du produit ne passe par ici, les
/// fonctionnalités passent par `commands`. Consommateurs : `tests/locale_reservations.rs` et
/// `tests/rephrasing_bench.rs`.
///
/// # Pièges
///
/// - ⚠️ La frontière native concentre l'`unsafe` du backend : l'ouvrir en grand pour la
///   commodité d'un fichier de mesure serait payer cher une facilité.
#[doc(hidden)]
pub mod measure {
  /// Le troisième garde-fou du nettoyage, celui de la langue. Exporté avec les deux autres :
  /// un banc qui n'en rejouerait que deux ne dirait pas ce que l'utilisateur reçoit.
  pub use crate::commands::cleanup_changed_language;
  /// Ce qu'un flux de session produit, tel que le pont le rend. Exporté pour que la mesure lise
  /// ce que l'écran lira — comparer deux formes distinctes ne prouverait rien.
  pub use crate::commands::live::LiveTranscriptEvent;
  /// La capture de session, frontière native.
  ///
  /// # Pièges
  ///
  /// - ⚠️ La mesure court-circuite `start_live_capture`, qui n'ajoute au pont que le filtrage du
  ///   micro selon son autorisation et le dossier de cache. La mesure substitue son propre
  ///   dossier exprès, pour ne pas écraser l'audio d'une session en cours. Si une règle vient un
  ///   jour s'ajouter dans la commande, cette note cesse d'être vraie.
  pub use crate::commands::live::{AudioSource, LiveCaptureStatus};
  /// Le seuil de la détection automatique, et non une copie de sa valeur : recopier `0.65` dans
  /// un fichier de mesure la ferait mentir le jour où la constante bouge.
  pub use crate::diarization::AUTO_THRESHOLD;
  /// L'attribution d'un mot à sa voix, pure. Elle ne sert plus qu'au filtre d'écho, mais une
  /// mesure doit pouvoir la rejouer sur un vrai média et chiffrer son taux d'erreur, ce que des
  /// cas fabriqués ne permettent pas.
  pub use crate::diarization::attribute;
  /// La dichotomie qui cherche le seuil donnant le nombre de voix visé.
  pub use crate::diarization::calibrate;
  /// La décision d'écho, pure. Exportée pour que l'instrument rapporte ce que le produit
  /// trancherait, et pas seulement des distances brutes : un instrument qui affiche des nombres
  /// laisse le lecteur faire le seuil de tête, et c'est là qu'on se ment.
  pub use crate::diarization::echo::{ECHO_DISTANCE, echoes_of_the_room};
  /// Le chemin que le produit emprunte vraiment pour diariser : calibrage, filtrage des voix
  /// parasites et passage final compris.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Sans cela, une mesure de diarisation ne mesure pas le produit : appeler `diarize`, le
  ///   pont nu, rapporte des comptes que plus personne ne voit — « 5 voix » annoncées sur le
  ///   média de référence là où le produit en retient 4.
  pub use crate::diarization::engine::{NativeDiarizer, SpeakerMode, analyse};
  /// Le filtre des voix parasites, ses segments et sa borne, tels que le produit les emploie.
  pub use crate::diarization::{DiarizationSegment, SLIVER_MS, without_slivers};
  /// L'état d'une session en cours, tel que le produit le tient.
  pub use crate::live::LiveSession;
  pub use crate::live::LiveStream;
  /// Le filtre d'écho au niveau du texte, et le seuil de recouvrement qu'il applique.
  pub use crate::live::echo_text::{Heard, SAME_UTTERANCE, coverage, echoes};
  /// Le découpage du compte rendu, pur. Exporté pour qu'une mesure le rejoue sur un vrai
  /// transcript : la référence — 8 034 mots en 4 tranches, 18,9 s, rappel 5/5 — ne se vérifie que
  /// sur un média réel, et un découpage qui dériverait ne se verrait qu'en lisant un compte rendu
  /// amputé.
  pub use crate::live::report::{ReportKind, SLICE_TOKENS, compose, estimated_tokens, slices};
  /// L'ouverture d'un transcript, telle qu'un titre automatique la découperait.
  ///
  /// Le produit ne demande plus de titre au modèle : le document s'ouvre sur « Session du {date}
  /// à {heure} », et l'utilisateur renomme. La brique reste entière et atteignable, comme
  /// `detect_language` — ce qui a changé est le défaut affiché, pas la faisabilité.
  pub use crate::live::title::opening;
  /// Le garde-fou de fidélité du nettoyage, pur : il n'appelle rien, il compare deux textes.
  /// Exporté pour que le banc rapporte l'avant et l'après sur le vrai modèle.
  pub use crate::llm::fidelity::restore_substitutions;
  /// Le garde-fou de vraisemblance du nettoyage, pur. Même raison que son voisin : le banc des
  /// dictées courtes juge ce qui est livré, et c'est lui qui en décide.
  pub use crate::llm::is_plausible_cleanup;
  /// Le garde-fou de la reformulation, pur. Exporté pour que le banc reproduise la décision du
  /// pipeline plutôt que celle du modèle : ce qui se mesure est ce que l'utilisateur reçoit.
  pub use crate::llm::is_plausible_rephrasing;
  /// La frontière native elle-même, où l'`unsafe` du backend est concentré.
  pub use crate::native::{
    assets_set_observer, detect_language, diarize, file_transcribe, install_language,
    language_install_in_flight, list_audio_sources, live_set_transcript_observer, live_start,
    live_status, live_stop, llm_capabilities, llm_clean, llm_rephrase, llm_report, llm_title,
    locale_reservations, media_inspect, release_locale, stt_cancel, stt_capabilities, stt_start,
    voice_match,
  };
  /// Le transcript et ses parties, la forme que toute mesure compare.
  pub use crate::transcript::{Paragraph, Transcript, Word};
}

pub use error::AppError;
pub use state::AppState;

use tauri::Manager;

/// Assemble et lance l'application : plugins, fenêtres, état partagé, commandes IPC.
///
/// # Panics
///
/// Panique si Tauri ne parvient pas à démarrer — il n'y a alors pas d'application à laquelle
/// rendre une erreur.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ⚠️ **La seule dérogation du crate**, et elle est ici parce qu'il n'y a nulle part ailleurs où
// aller : `run()` ne rend rien, et son appelant est `main`. Un échec de démarrage de Tauri est un
// processus sans fenêtre, sans tray et sans IPC — il n'y a plus d'application pour afficher quoi
// que ce soit. Toute autre panique du backend est un défaut ; celle-ci est le seul aveu possible.
#[allow(
  clippy::expect_used,
  reason = "aucune application à qui rendre l'erreur — voir « # Panics »"
)]
pub fn run() {
  tauri::Builder::default()
    // Une seule instance : le second lancement ramène la première au premier plan.
    //
    // ⚠️ En premier, avant tout autre plugin : une seconde instance doit se retirer avant
    // d'avoir touché à quoi que ce soit de partagé — le trousseau, la base chiffrée, le tap
    // Core Audio.
    //
    // ⚠️ Ne rien faire serait pire que de ne pas installer le plugin : l'application est absente
    // du Dock et vit dans le tray, un second lancement qui mourrait en silence ne montrerait
    // rien. On fait donc ce que fait un clic sur l'icône du tray — `reveal`.
    //
    // ⚠️ Ni `args` ni `cwd` ne sont journalisés : un répertoire de travail nomme des dossiers de
    // l'utilisateur, et le journal dit ce qui a échoué, jamais sur quoi.
    //
    // ⚠️ Le verrou porte sur l'identifiant du bundle : `com.mirmalion.desktop.dev` n'est pas
    // `com.mirmalion.desktop`, les deux variantes continuent de tourner côte à côte.
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Err(error) = lifecycle::reveal(app, lifecycle::Front::Session) {
        log::warn!(
          "fenêtre non rappelée au second lancement ({}) : {error}",
          error.kind()
        );
      }
    }))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .plugin(logging::build())
    // La mise à jour, seul appel réseau récurrent de l'application.
    //
    // ⚠️ Ces deux plugins doivent rester après `single_instance` : `tauri add` les avait insérés
    // en tête, et il ne lit pas les commentaires.
    //
    // ⚠️ Aucune donnée ne sort, et c'est la condition de leur présence ici : le contrôle est un
    // `GET` sur un fichier statique, sans identifiant, sans version installée, sans compteur.
    //
    // ⚠️ `process` n'est là que pour redémarrer après une installation. Il ouvre aussi `exit`,
    // que `capabilities/updates.json` refuse : on ne quitte cette application que par le menu du
    // tray, et un frontend qui pourrait la tuer passerait outre une session en cours.
    //
    // ⚠️ Télécharger et installer sont deux permissions distinctes dans
    // `capabilities/updates.json`, parce que la barre affiche un état entre les deux.
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    // L'ouverture à la session.
    //
    // ⚠️ `LaunchAgent`, et pas `AppleScript` : la voie AppleScript passe par System Events, donc
    // par la permission Automatisation, pour un réglage qui n'en a aucun besoin — un plist dans
    // `~/Library/LaunchAgents` suffit.
    //
    // ⚠️ Aucun argument de lancement : ils seraient inscrits dans le plist, donc figés jusqu'à
    // la prochaine bascule de l'interrupteur.
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      None,
    ))
    .setup(|app| {
      // ⚠️ **En tête du démarrage, avant l'état, et ce n'est pas cosmétique.** Le bundle porte
      // `LSUIElement` : l'application naît donc SANS icône, et c'est cette ligne qui la lui rend
      // quand le réglage le demande — ce qui est le cas par défaut. Posée après l'état, elle
      // attendait l'ouverture du trousseau puis celle de la base, dont SQLCipher dérive la clé
      // lentement par construction : l'icône arrivait avec ce retard-là. Elle n'a besoin que
      // d'un chemin, pas d'une base.
      // ⚠️ Le chemin est relu ici plutôt que pris à l'état, qui n'existe pas encore. `AppState`
      // le recalcule de la même source — `app.path().app_data_dir()` —, il n'y a pas deux
      // vérités.
      let data_dir = app.path().app_data_dir()?;
      let settings_file = data_dir.join(i18n::SETTINGS_FILE);
      lifecycle::set_dock_visibility(app.handle(), lifecycle::stored_show_in_dock(&settings_file))?;

      // Le journal est déjà en place : si l'état échoue à se monter, on saura pourquoi.
      let state = AppState::from_app(app.handle()).inspect_err(|error| {
        log::error!("démarrage impossible ({}) : {error}", error.kind());
      })?;
      log::info!("base prête, schéma v{}", state.database().schema_version()?);

      // L'interface est localisée au build : la locale décide quel bundle la fenêtre
      // ouvre, elle doit donc être choisie avant que le moindre JavaScript ne tourne.
      let locale = state.interface_locale();
      log::info!("langue d'interface : {locale}");

      // ⚠️ Posé même hors du Dock : la barre de menus n'apparaît qu'en politique `Regular`, mais
      // l'utilisateur bascule à chaud, et construire le menu à ce moment-là obligerait à le faire
      // dans les deux sens.
      menu::install(app.handle(), locale)?;

      // La fenêtre principale est créée cachée dans tous les cas, et jamais détruite : voir
      // l'en-tête de `lifecycle`. Ce qui change au premier lancement, c'est qu'une seconde
      // fenêtre — l'onboarding — s'ouvre par-dessus.
      let pending = lifecycle::onboarding_pending(&settings_file);
      // ⚠️ L'apparence native des fenêtres se pose dès leur construction, sans quoi macOS peint
      // son cadre en clair sur une application sombre. Voir `lifecycle::stored_theme`.
      let theme = lifecycle::stored_theme(&settings_file);
      // ⚠️ La fenêtre principale naît toujours cachée, et aucun réglage n'en décide : Mirmalion
      // démarre en silence, l'utilisateur ouvre la fenêtre par le tray quand il la veut. C'est le
      // comportement d'un outil de barre des menus, vrai que le lancement soit manuel ou porté
      // par l'ouverture de session.
      log::info!(
        "démarrage {}",
        if pending {
          "avec onboarding"
        } else {
          "silencieux"
        }
      );
      lifecycle::create_main_window(app.handle(), locale, false, theme)?;
      if pending {
        lifecycle::create_onboarding_window(app.handle(), locale, theme)?;
      }

      // ⚠️ Après la fenêtre, et jamais optionnel : l'application n'est pas dans le Dock, et sans
      // le tray elle n'a plus aucun point d'entrée ni aucun moyen d'être quittée.
      tray::build(app.handle(), locale)?;

      // ⚠️ Le moteur de transcription et la remontée de ses évènements, avant toute session : un
      // observateur enregistré en retard perd les partiels déjà émis.
      commands::stt::setup(app.handle(), std::sync::Arc::new(stt::apple::AppleEngine))?;
      commands::llm::setup(app.handle(), std::sync::Arc::new(llm::apple::AppleLlm));

      // ⚠️ La remontée des évènements d'installation de langue, avant toute installation : un
      // observateur enregistré en retard perd la progression déjà émise.
      commands::assets::setup(app.handle())?;

      // ⚠️ Le pendant de la migration `007` côté système : une réservation prise pour une langue
      // sortie du périmètre occuperait une des cinq places d'Apple sans plus aucun écran pour la
      // rendre.
      commands::assets::release_retired_languages_on_launch();

      // Le traducteur. Sans état ni observateur : il n'a rien à préparer, seulement à être
      // joignable — d'où un simple `manage`, et aucun risque d'arriver « trop tard ».
      commands::translation::setup(
        app.handle(),
        std::sync::Arc::new(translation::apple::AppleTranslator),
      );

      // L'inspecteur de médias. Sans état ni observateur, comme le traducteur.
      commands::media::setup(
        app.handle(),
        commands::media::native_inspector(),
        commands::media::native_detector(),
      );
      commands::filedoc::setup(app.handle());
      commands::transcription::setup(app.handle(), commands::transcription::native_engine());

      // ⚠️ Le filet du crash, et il n'a pas d'autre endroit : l'audio d'une session est supprimé
      // à la finalisation, qu'une application tuée en pleine capture n'atteint jamais. Ce
      // balayage est le seul moment où l'on sait qu'aucune session n'est en cours.
      commands::live::capture::sweep_on_launch(app.handle());

      // ⚠️ Avant toute session, comme l'observateur de la dictée : enregistré en retard, il
      // perdrait les premiers segments — ceux du « bon, on commence ».
      commands::live::setup(app.handle())?;

      // ⚠️ Le pipeline avant le raccourci : c'est lui qui reçoit les démarrages et les arrêts, et
      // monté après il manquerait un appui survenu entre les deux.
      commands::dictation::setup(app.handle());

      // Le raccourci global, avec le mode déjà choisi par l'utilisateur : il répond que la
      // fenêtre soit ouverte ou non, donc son mode ne peut pas attendre le frontend.
      commands::shortcut::setup(
        app.handle(),
        lifecycle::stored_dictation_mode(&settings_file),
      )?;

      // L'état de l'overlay, avant toute commande : la fenêtre flottante le lit à son
      // démarrage plutôt que d'attendre un évènement qu'elle aurait pu manquer.
      app.manage(commands::overlay::OverlayHandle::default());
      // ⚠️ Un `Arc` dans l'état géré, et non un `static` : le rappel du pont est un pointeur de
      // fonction C non capturant, il ne peut rien retenir. Il retrouve la session par
      // l'`AppHandle`, comme n'importe quelle commande.
      app.manage(std::sync::Arc::new(live::LiveSession::default()));
      app.manage(live::documents::LiveDocuments::default());
      app.manage(commands::export::ExportTargets::default());

      app.manage(state);

      // ⚠️ Après `manage`, obligatoirement : la purge de l'historique a besoin de la base, qui
      // vit dans l'état. Greffée plus haut, sur le balayage d'audio, elle ne trouvait rien et ne
      // faisait rien, en silence.
      //
      // ⚠️ Au lancement et à chaque ouverture du panneau, sans tâche planifiée : un rendez-vous
      // mensuel serait manqué dès que l'application ne tourne pas ce jour-là.
      commands::live::history::purge_history_on_launch(app.handle());

      // ⚠️ Après `manage`, et pas avant : la fenêtre de l'overlay lit la langue d'interface dans
      // l'état de l'application. L'état forcé est réservé au développement.
      if let Some(payload) = commands::overlay::forced_state() {
        commands::overlay::present(app.handle(), payload)?;
      } else {
        // ⚠️ La pilule naît ici, et une seule fois : créer une fenêtre active l'application sur
        // macOS malgré `focused(false)` (bogue amont tauri-apps/tauri#7519, #14102). La créer à
        // chaque dictée volerait le focus au champ où l'utilisateur vient de poser son curseur.
        // Ici l'activation tombe au lancement, où la fenêtre principale en fait déjà autant.
        commands::overlay::ensure(app.handle())?;
      }

      // La fenêtre se montre d'elle-même quand l'application vient de changer de version — après
      // une mise à jour, elle redémarre seule, et la retrouver dans le seul tray demanderait de
      // savoir qu'elle y est.
      //
      // ⚠️ **En toute fin de démarrage, et il n'y a pas d'autre place** : `reveal` cherche la
      // session en cours dans l'état géré, qui n'existe qu'après les `manage` ci-dessus.
      //
      // ⚠️ L'échec ne condamne pas le démarrage : le numéro de version est retenu quoi qu'il
      // arrive, et une application qui tourne sans sa fenêtre reste joignable par le tray.
      if lifecycle::takes_the_screen_after_an_update(
        &data_dir,
        &app.package_info().version.to_string(),
        pending,
      ) {
        log::info!("version changée depuis le dernier lancement : la fenêtre se montre");
        if let Err(error) = lifecycle::reveal(app.handle(), lifecycle::Front::Main) {
          log::warn!(
            "fenêtre non montrée après changement de version ({}) : {error}",
            error.kind()
          );
        }
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::app_info::get_app_info,
      commands::assets::cancel_language_install,
      commands::assets::get_language_install_in_flight,
      commands::assets::get_locale_reservations,
      commands::assets::release_language,
      commands::assets::install_language,
      commands::audio::get_capture_status,
      commands::audio::list_input_devices,
      commands::audio::start_capture,
      commands::audio::stop_capture,
      commands::autostart::get_launch_at_login,
      commands::autostart::set_launch_at_login,
      commands::db::get_database_status,
      commands::dictation::cancel_dictation,
      commands::injection::get_focus_verdict,
      commands::injection::insert_at_cursor,
      commands::llm::clean_dictation,
      commands::llm::get_llm_capabilities,
      commands::llm::rephrase_dictation,
      commands::export::copy_document,
      commands::export::choose_live_export_path,
      commands::export::export_live_document,
      commands::export::copy_live_document,
      commands::export::choose_export_path,
      commands::export::export_document,
      commands::filedoc::close_file_document,
      commands::filedoc::get_file_document,
      commands::filedoc::rename_file_document,
      commands::media::detect_media_language,
      commands::media::inspect_media,
      commands::media::supported_media_extensions,
      commands::transcription::cancel_media_transcription,
      commands::transcription::transcribe_media,
      commands::onboarding::finish_onboarding,
      commands::overlay::get_overlay_state,
      commands::overlay::hide_overlay,
      commands::overlay::resize_overlay,
      commands::overlay::show_overlay,
      commands::permissions::get_permissions_status,
      commands::permissions::request_accessibility,
      commands::permissions::request_audio_capture,
      commands::permissions::request_microphone,
      commands::dictations::list_dictations,
      commands::dictations::delete_dictation,
      commands::dictations::clear_dictations,
      commands::dictations::apply_dictation_retention,
      commands::dictionary::add_dictionary_term,
      commands::dictionary::add_dictionary_variant,
      commands::dictionary::delete_dictionary_term,
      commands::dictionary::delete_dictionary_variant,
      commands::dictionary::list_dictionary_terms,
      commands::prompts::adopt_legacy_live_prompt,
      commands::prompts::create_report_prompt,
      commands::prompts::delete_report_prompt,
      commands::prompts::get_rephrasing_prompt,
      commands::prompts::list_report_prompts,
      commands::prompts::set_rephrasing_prompt,
      commands::prompts::update_report_prompt,
      commands::shortcut::get_shortcut_status,
      commands::shortcut::set_shortcut_mode,
      commands::shortcut::start_shortcut,
      commands::shortcut::stop_shortcut,
      commands::stt::cancel_transcription,
      commands::stt::get_stt_capabilities,
      commands::stt::start_transcription,
      commands::stt::stop_transcription,
      commands::language::get_interface_locale,
      commands::language::set_interface_language,
      commands::system::get_system_capabilities,
      commands::live::capture::get_live_capture_status,
      commands::live::capture::list_audio_sources,
      commands::live::capture::start_live_capture,
      commands::live::capture::stop_live_capture,
      commands::live::capture::get_live_session,
      commands::live::document::get_live_document,
      commands::live::document::rename_live_document,
      commands::live::document::close_live_document,
      commands::live::report::generate_live_report,
      commands::live::report::cancel_live_report,
      commands::live::history::list_live_sessions,
      commands::live::history::open_live_session,
      commands::live::history::delete_live_session,
      commands::live::history::clear_live_sessions,
      commands::live::history::copy_live_session,
      commands::translation::cancel_document_translation,
      commands::translation::get_translation_availability,
      commands::translation::prepare_translation,
      commands::translation::translate_document,
      commands::translation::translate_live_report,
      commands::translation::translate_live_transcript,
      commands::translation::translate_text,
      commands::window::focus_window,
      commands::window::toggle_window_zoom,
      commands::window::set_window_compact,
      commands::window::set_dock_visible,
      commands::window::set_window_theme
    ])
    .build(tauri::generate_context!())
    .expect("error while running tauri application")
    // ⚠️ `build` puis `run`, et non `run` seul : c'est la seule forme qui donne accès aux
    // évènements de l'application, dont le clic sur l'icône du Dock. Sans lui, l'icône que
    // l'utilisateur a demandée dans les options n'ouvre rien — l'application n'a plus de fenêtre
    // visible dès qu'on la ferme, et macOS ne rouvre rien tout seul.
    .run(|app, event| {
      if let tauri::RunEvent::Reopen { .. } = event {
        lifecycle::on_dock_click(app);
      }
    });
}
