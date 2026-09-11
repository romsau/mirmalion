//! **Libérer une réservation de locale fait perdre le pack téléchargé** : la langue quitte
//! `reserved` et le moteur refuse aussitôt d'ouvrir une session. Apple plafonne à cinq les
//! locales réservées (`AssetInventory.maximumReservedLocales`), d'où la règle « pour en ajouter
//! une, en retirer une » (`LanguagesStore.requestInstall`).
//!
//! ⚠️ **`installedLocales` ne le dit pas toujours** : la liste est mise en cache pour la durée du
//! processus, de façon inconstante — une langue libérée peut y figurer encore alors que sa
//! session est déjà refusée. Seule l'ouverture d'une session fait foi, d'où
//! `which_languages_can_actually_open_a_session`.
//!
//! ⚠️ `#[ignore]` : la sonde rend une réservation que macOS ne rendra pas seul, et ne part que si
//! on lui nomme une langue installée par l'application — `MIRMALION_MEASURE_LOCALE=ja cargo test
//! --test locale_reservations -- --ignored --nocapture loses_the_downloaded_pack`. Filtrer sur ce
//! nom, jamais sur `releasing`, qui réveille aussi un test qui télécharge.

use app_lib::measure as native;

/// La langue à libérer, nommée par l'opérateur. Sans elle, la mesure ne fait rien.
const LANGUAGE_VAR: &str = "MIRMALION_MEASURE_LOCALE";

/// Les langues que le moteur déclare **réellement installées**, extraites des capacités.
///
/// On lit le JSON à la main plutôt que d'importer le type : ce fichier mesure le pont, il n'a
/// pas à dépendre de la forme que le reste du code donne à la réponse.
fn installed_locales() -> String {
  match native::stt_capabilities() {
    Ok(json) => json,
    Err(error) => format!("<capacités illisibles : {error}>"),
  }
}

fn reservations() -> String {
  match native::locale_reservations() {
    Ok(json) => json,
    Err(error) => format!("<réservations illisibles : {error}>"),
  }
}

/// L'état de la machine, **sans rien y toucher**. Premier temps du protocole : sans
/// réservation détenue, il n'y a rien à libérer et la mesure ne dirait rien.
///
/// ⚠️ `#[ignore]` lui aussi, mais pour une autre raison : il n'affirme rien, il rapporte. Un
/// test qui ne peut pas échouer n'a pas sa place dans une suite qu'on lit pour savoir si
/// quelque chose est cassé.
///
/// ```sh
/// cargo test --test locale_reservations -- --ignored --nocapture snapshot
/// ```
#[test]
#[ignore = "rapporte l'état de la machine ; n'affirme rien"]
fn snapshot_of_reservations_and_installed_locales() {
  println!("\n═══ ÉTAT DE LA MACHINE ═══");
  println!("  réservations : {}", reservations());
  println!("  capacités    : {}", installed_locales());
  println!(
    "\n  Une liste « reserved » VIDE veut dire que rien n'a été téléchargé par nous :\n       les langues présentes viennent du système, et aucune place n'est consommée.\n"
  );
}

/// Libère la réservation d'une langue — et lui fait donc **perdre son pack**.
///
/// ⚠️ Le nom a longtemps dit l'inverse (`…_keeps_the_downloaded_pack`), sur la foi d'une mesure
/// qui relisait `installedLocales` dans la seconde. Un nom de test se lit dans la sortie : il
/// annonçait un résultat démenti deux fois. Voir l'en-tête du fichier.
#[test]
#[ignore = "modifie l'état réel de la machine ; voir l'en-tête du fichier"]
fn releasing_a_reservation_loses_the_downloaded_pack() {
  let Ok(language) = std::env::var(LANGUAGE_VAR) else {
    panic!("nommez la langue à libérer : {LANGUAGE_VAR}=ja cargo test …");
  };

  println!("\n═══ MESURE — libération d'une réservation de locale ═══");
  println!("langue mesurée : {language}\n");

  println!("AVANT");
  println!("  réservations : {}", reservations());
  println!("  capacités    : {}", installed_locales());

  native::release_locale(&language).expect("la libération doit aboutir");

  println!("\nAPRÈS");
  let after_reservations = reservations();
  let after_capabilities = installed_locales();
  println!("  réservations : {after_reservations}");
  println!("  capacités    : {after_capabilities}");

  println!("\n═══ LECTURE DU RÉSULTAT ═══");
  println!("  La langue doit avoir quitté « reserved » : le créneau est rendu, et son pack avec.");
  println!("\n  ⚠️ NE RIEN CONCLURE DE « installedLocales » ICI — mesuré le 2026-08-02, il est");
  println!("     inconstant dans le processus qui vient de libérer : « ja » en a disparu");
  println!("     aussitôt, « zh » y figurait encore alors que sa session était déjà refusée.");
  println!("     Apple met son inventaire en cache pour la durée du processus.");
  println!("\n  ⚠️ L'épreuve, c'est d'OUVRIR UNE SESSION, et elle se lance à part :");
  println!("     cargo test --test locale_reservations -- --ignored --nocapture which_languages\n");

  // ⚠️ **Aucune assertion sur le verdict, à dessein.** Ce fichier MESURE. Seule la libération
  // elle-même doit aboutir — le reste se lit, se consigne, et devient une décision.
  assert!(
    !after_reservations.starts_with('<'),
    "les réservations doivent rester lisibles après la libération : {after_reservations}"
  );
  assert!(
    !after_capabilities.starts_with('<'),
    "les capacités doivent rester lisibles après la libération : {after_capabilities}"
  );
}

/// Le protocole COMPLET, de bout en bout : installer une langue absente, constater qu'elle
/// occupe une place, la rendre, et regarder ce qu'il advient du pack.
///
/// ⚠️ **OPÉRATION RÉSEAU** (règle globale n° 4), et la seule de cette suite. Elle ne part que
/// sur demande explicite, jamais dans `npm run verify` :
///
/// ```sh
/// MIRMALION_MEASURE_LOCALE=ja cargo test --test locale_reservations \
///   -- --ignored --nocapture installing
/// ```
///
/// ⚠️ **La langue reste installée à la fin.** La mesure n'annule rien : elle observe. C'est
/// aussi ce qui permet de revenir la regarder à froid, quelques jours plus tard, pour la seule
/// question qu'aucune exécution ne peut trancher — la purge différée.
#[test]
#[ignore = "télécharge des ressources depuis Apple ; opération réseau explicite"]
fn installing_then_releasing_a_language() {
  let Ok(language) = std::env::var(LANGUAGE_VAR) else {
    panic!("nommez la langue à installer : {LANGUAGE_VAR}=ja cargo test …");
  };

  println!("\n═══ MESURE COMPLÈTE — installer, réserver, rendre ═══");
  println!("langue : {language}\n");
  println!("1. AVANT");
  println!("   réservations : {}", reservations());
  println!("   installées   : {}", installed_locales());
  assert!(
    !is_installed(&language),
    "« {language} » est déjà installée : la mesure exige une langue ABSENTE, sans quoi rien \
     ne se télécharge et aucune réservation n'est prise"
  );

  println!("\n2. TÉLÉCHARGEMENT (peut durer plusieurs minutes)");
  native::install_language(&language).expect("le téléchargement doit démarrer");
  let installed = wait_until_installed(&language);
  assert!(
    installed,
    "la langue n'est pas arrivée dans le délai imparti"
  );

  println!("\n3. APRÈS INSTALLATION");
  let reserved_after_install = reservations();
  println!("   réservations : {reserved_after_install}");
  println!("   installées   : {}", installed_locales());
  let held_a_slot = reserved_after_install.contains(&language);
  println!(
    "   → la langue occupe-t-elle une place ? {}",
    if held_a_slot { "OUI" } else { "NON" }
  );

  println!("\n4. LIBÉRATION");
  native::release_locale(&language).expect("la libération doit aboutir");
  let reserved_after_release = reservations();
  println!("   réservations : {reserved_after_release}");
  let slot_returned = held_a_slot && !reserved_after_release.contains(&language);
  println!(
    "   → la place est-elle rendue ? {}",
    if slot_returned { "OUI" } else { "NON" }
  );

  println!("\n5. VERDICT");
  let survived = is_installed(&language);
  println!("   installées : {}", installed_locales());
  if survived {
    println!("\n   ✔ LE PACK SURVIT À LA LIBÉRATION.");
    println!("     Le plafond de cinq n'a plus à se voir dans l'interface : on installe les");
    println!("     six langues une par une, en rendant la place après chaque succès.");
  } else {
    println!("\n   ✘ LE PACK DISPARAÎT AVEC LA RÉSERVATION.");
    println!("     Libérer désinstalle. Le plafond de cinq téléchargements reste, et");
    println!("     l'interface doit le montrer.");
  }
  println!("\n   ⚠️ Une purge DIFFÉRÉE reste possible : relancer le relevé dans quelques");
  println!("      jours (sous-commande « snapshot ») avant de conclure définitivement.\n");
}

/// La langue figure-t-elle dans les locales **réellement installées** ?
///
/// Lecture volontairement littérale du JSON : ce fichier éprouve le pont, il n'a pas à
/// dépendre de la forme que le reste du code donne à la réponse.
fn is_installed(language: &str) -> bool {
  let capabilities = installed_locales();
  let Some(start) = capabilities.find("\"installedLocales\":[") else {
    return false;
  };
  let tail = &capabilities[start + "\"installedLocales\":[".len()..];
  let Some(end) = tail.find(']') else {
    return false;
  };
  tail[..end].contains(&format!("\"{language}\""))
}

/// Attend l'arrivée de la langue, en sondant les capacités — lecture gratuite et locale.
///
/// ⚠️ On sonde `installedLocales` et **jamais** `assetInstallationRequest` : cette dernière
/// consomme une réservation à chaque appel, et il n'y en a que cinq (piège n° 2 de
/// `SpeechAssets.swift`). Sonder avec elle épuiserait le quota avant la fin de la mesure.
fn wait_until_installed(language: &str) -> bool {
  const POLL: std::time::Duration = std::time::Duration::from_secs(5);
  const LIMIT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

  let started = std::time::Instant::now();
  let mut announced = false;
  while started.elapsed() < LIMIT {
    if is_installed(language) {
      println!("   installée après {} s", started.elapsed().as_secs());
      return true;
    }
    match native::language_install_in_flight() {
      Ok(Some(current)) => {
        if !announced {
          println!("   téléchargement en cours ({current})…");
          announced = true;
        }
      }
      // Plus rien ne tourne et la langue n'est pas là : le téléchargement a échoué ou a été
      // abandonné. Inutile d'attendre les vingt minutes.
      Ok(None) if announced => {
        println!(
          "   plus aucun téléchargement en cours après {} s",
          started.elapsed().as_secs()
        );
        return is_installed(language);
      }
      Ok(None) => {}
      Err(error) => println!("   état du téléchargement illisible : {error}"),
    }
    std::thread::sleep(POLL);
  }
  false
}

/// **Dans quelles langues peut-on RÉELLEMENT ouvrir une session ?**
///
/// ```sh
/// cargo test --test locale_reservations -- --ignored --nocapture which_languages
/// ```
///
/// ⚠️ **Ce n'est pas un doublon de `installedLocales`, et c'est tout l'intérêt.** Cette liste-là
/// est une **déclaration** ; ouvrir une session est l'**épreuve**. Les deux se sont déjà
/// contredites, l'écran des Options annonçant une langue installée que l'inventaire ne contenait
/// pas — il fallait un arbitre qui ne soit ni l'un ni l'autre.
///
/// ⚠️ **N'ouvre aucun micro** : `start` prépare le transcripteur, la capture audio est une autre
/// commande. Rien n'est enregistré, et chaque session est refermée aussitôt.
#[test]
#[ignore = "relevé de machine : ouvre une session par langue, rapporte, n'affirme rien"]
fn which_languages_can_actually_open_a_session() {
  println!("\n═══ CE QUE L'APPLICATION DÉCLARE ═══");
  println!("  {}", installed_locales());

  println!("\n═══ CE QUE LE MOTEUR ACCEPTE VRAIMENT ═══");
  // ⚠️ **Les variantes complètes ne se testent pas par ici** : `es-ES`, `es-419`… sont refusées
  // en amont par la garde des six langues, côté Rust, avant d'atteindre le moteur. Pour comparer
  // des identifiants, il faudra les faire remonter du Swift.
  for language in ["fr", "en", "es", "de", "it", "pt"] {
    match native::stt_start(language) {
      Ok(()) => {
        let _ = native::stt_cancel();
        println!("  {language} : session ouverte");
      }
      Err(error) => println!("  {language} : REFUSÉ — {error}"),
    }
  }
}

/// **Que dit exactement macOS quand on lui demande d'installer une langue ?**
///
/// ```sh
/// MIRMALION_MEASURE_LOCALE=es cargo test --test locale_reservations \
///   -- --ignored --nocapture what_macos_says
/// ```
///
/// ⚠️ **« Ça ne s'installe pas » n'est pas un diagnostic** : les deux branches d'échec de
/// `SpeechAssets.install` ne se corrigent pas de la même façon. « Aucune ressource à installer
/// n'a été proposée » veut dire que macOS refuse **avant** tout téléchargement — condition du
/// système à découvrir, pas bogue à corriger. « Le téléchargement s'est terminé sans installer
/// les ressources » met en cause le chemin lui-même.
///
/// ⚠️ **Opération RÉSEAU**, comme [`installing_then_releasing_a_language`] : jamais dans
/// `npm run verify`.
#[test]
#[ignore = "demande une installation à macOS et rapporte ses évènements ; opération réseau"]
fn what_macos_says_when_asked_to_install() {
  let Ok(language) = std::env::var(LANGUAGE_VAR) else {
    panic!("nommez la langue : {LANGUAGE_VAR}=es cargo test …");
  };

  // Le pont rappelle une fonction `extern "C"`, qui ne transporte aucun contexte : les
  // évènements atterrissent donc dans un global, comme côté production (`commands/mod.rs`).
  static EVENTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
  extern "C" fn collect(payload: *const std::os::raw::c_char) {
    let text = unsafe { std::ffi::CStr::from_ptr(payload) }
      .to_string_lossy()
      .into_owned();
    EVENTS.lock().expect("verrou").push(text);
  }

  println!("\n═══ CE QUE macOS RÉPOND — {language} ═══");
  println!("avant : {}", installed_locales());

  native::assets_set_observer(Some(collect)).expect("observateur posé");
  native::install_language(&language).expect("la demande doit partir");

  // On attend que le pont ait fini : `language_install_in_flight` retombe à `None`.
  for _ in 0..60 {
    std::thread::sleep(std::time::Duration::from_millis(500));
    if native::language_install_in_flight()
      .ok()
      .flatten()
      .is_none()
    {
      break;
    }
  }
  let _ = native::assets_set_observer(None);

  println!("\névènements reçus :");
  for event in EVENTS.lock().expect("verrou").iter() {
    println!("  {event}");
  }
  println!("\naprès : {}", installed_locales());
}
