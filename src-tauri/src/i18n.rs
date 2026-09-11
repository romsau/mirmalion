//! Quelle langue l'interface parle, et quel bundle la fenêtre charge.
//!
//! L'interface est localisée au build : `ng build --localize` produit un bundle complet par
//! langue, et la locale décide quel `index.html` la fenêtre ouvre. Elle doit donc être connue
//! avant qu'une ligne de JavaScript ne tourne.
//!
//! ```text
//! dist/mirmalion/browser/index.html      ← français, la locale source, à la racine
//! dist/mirmalion/browser/en/index.html   … et les quatre autres langues
//! ```
//!
//! # Pièges
//!
//! - ⚠️ La locale source est à la racine, pas dans `fr/` : `ng serve` ne sert qu'une locale et la
//!   sert là. Développement et production ont ainsi le même chemin pour le français.

use crate::error::AppError;

/// Les 6 langues d'interface. La première est la locale source.
pub const SUPPORTED_LOCALES: [&str; 6] = ["fr", "en", "es", "de", "it", "pt"];

/// La locale des textes écrits dans le code, servie à la racine du bundle.
pub const SOURCE_LOCALE: &str = SUPPORTED_LOCALES[0];

/// Le repli quand ni le réglage ni le système ne donnent une langue connue.
///
/// L'anglais, jamais le français : le repli doit être la langue la plus largement comprise, pas
/// celle de l'auteur.
pub const FALLBACK_LOCALE: &str = "en";

/// Le fichier de réglages, dans `app_data_dir()`. Même nom que côté frontend.
pub const SETTINGS_FILE: &str = "settings.json";

/// Choisit la langue d'interface.
///
/// Dans l'ordre : le réglage de l'utilisateur s'il en a un, sinon ce que macOS annonce, sinon
/// l'anglais. Une valeur inconnue des 6 langues est ignorée à chaque étage — un fichier de
/// réglages édité à la main ne doit pas laisser l'application sans interface.
pub fn resolve(stored: Option<&str>, system: Option<&str>) -> &'static str {
  stored
    .and_then(known)
    .or_else(|| system.and_then(known))
    .unwrap_or(FALLBACK_LOCALE)
}

/// La locale connue correspondante, comparaison insensible à la casse et à la région.
///
/// # Pièges
///
/// - ⚠️ C'est le seul portier des 6 langues côté Rust : le fichier de réglages, macOS et le
///   frontend y passent tous. Le reste du backend ne manipule que des `&'static str` tirés de
///   [`SUPPORTED_LOCALES`], donc impossibles à inventer.
pub fn known(candidate: &str) -> Option<&'static str> {
  let primary = candidate
    .split(['-', '_'])
    .next()
    .unwrap_or_default()
    .to_ascii_lowercase();
  SUPPORTED_LOCALES
    .into_iter()
    .find(|locale| *locale == primary)
}

/// Le chemin, dans le bundle, de l'`index.html` de cette locale.
///
/// `localized` vaut faux en développement : `ng serve` ne sert qu'une locale, à la racine. Les
/// autres langues ne s'observent donc que sur un bundle construit.
pub fn window_path(locale: &str, localized: bool) -> String {
  if !localized || locale == SOURCE_LOCALE {
    "index.html".to_owned()
  } else {
    format!("{locale}/index.html")
  }
}

/// Vers quoi faire naviguer une fenêtre déjà ouverte pour la faire changer de langue.
///
/// Pendant exact de [`window_path`], qui décide la même chose à la création d'une fenêtre.
///
/// # Pièges
///
/// - ⚠️ Recharger ne changerait rien : chaque langue est un dossier distinct du bundle, et
///   recharger rejouerait le même. Il faut réécrire l'URL.
/// - ⚠️ La requête et le fragment sont retirés : le frontend a réécrit l'URL d'une fenêtre
///   secondaire pour y porter sa route (`/filedoc/0`), qui n'est aucun fichier du bundle.
///   Angular la redéduit de l'étiquette de la fenêtre au redémarrage.
pub fn navigation_url(current: &tauri::Url, locale: &str, localized: bool) -> tauri::Url {
  let mut target = current.clone();
  target.set_path(&window_path(locale, localized));
  target.set_query(None);
  target.set_fragment(None);
  target
}

/// La langue que macOS annonce, ramenée aux 6 connues.
///
/// Une défaillance du pont n'est pas une raison de ne pas démarrer : on retombe sur le
/// repli, et l'utilisateur changera de langue dans les Options.
pub fn system_locale() -> Option<&'static str> {
  crate::native::preferred_language()
    .unwrap_or_default()
    .as_deref()
    .and_then(known)
}

/// Le réglage `interfaceLanguage`, lu directement dans le fichier de réglages.
///
/// Lecture avant que le frontend n'existe : c'est le fichier qu'écrit `tauri-plugin-store`, mais
/// le plugin n'est prêt qu'une fois l'application montée, et la réponse est due plus tôt.
pub fn stored_locale(settings_file: &std::path::Path) -> Option<String> {
  let raw = std::fs::read_to_string(settings_file).ok()?;
  let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
  parsed.get("interfaceLanguage")?.as_str().map(str::to_owned)
}

/// Erreur de construction de la fenêtre, ramenée au type maison.
pub fn window_error(error: tauri::Error) -> AppError {
  AppError::Io(format!("création de la fenêtre : {error}"))
}

#[cfg(test)]
mod tests {
  use super::{
    FALLBACK_LOCALE, SOURCE_LOCALE, SUPPORTED_LOCALES, navigation_url, resolve, stored_locale,
    window_path,
  };

  fn url(raw: &str) -> tauri::Url {
    raw.parse().expect("URL de test")
  }

  #[test]
  fn changing_language_sends_a_window_to_the_folder_of_that_language() {
    let target = navigation_url(&url("tauri://localhost/index.html"), "es", true);
    assert_eq!(target.as_str(), "tauri://localhost/es/index.html");
  }

  #[test]
  fn coming_back_to_french_sends_it_to_the_root() {
    let target = navigation_url(&url("tauri://localhost/de/index.html"), "fr", true);
    assert_eq!(target.as_str(), "tauri://localhost/index.html");
  }

  /// ⚠️ L'URL d'une fenêtre secondaire a été réécrite par le frontend pour porter sa route ; la
  /// reconduire ferait chercher `de/filedoc/0` dans le bundle, où rien ne porte ce nom.
  #[test]
  fn a_route_written_by_the_frontend_is_dropped_rather_than_carried_over() {
    let target = navigation_url(&url("tauri://localhost/filedoc/0?x=1#y"), "de", true);
    assert_eq!(target.as_str(), "tauri://localhost/de/index.html");
  }

  /// L'origine du serveur de développement n'est pas la même que celle du bundle : c'est elle
  /// qu'il faut conserver, et c'est pour cela qu'on part de l'URL courante au lieu d'en écrire
  /// une.
  #[test]
  fn the_origin_of_the_window_is_kept_whatever_it_is() {
    let target = navigation_url(&url("http://localhost:4200/index.html"), "it", false);
    assert_eq!(target.as_str(), "http://localhost:4200/index.html");
  }

  #[test]
  fn the_source_locale_is_french_and_the_fallback_is_english() {
    assert_eq!(SOURCE_LOCALE, "fr");
    assert_eq!(FALLBACK_LOCALE, "en");
    assert_eq!(SUPPORTED_LOCALES.len(), 6);
  }

  #[test]
  fn the_users_choice_wins_over_the_system() {
    assert_eq!(resolve(Some("it"), Some("fr")), "it");
  }

  #[test]
  fn the_system_decides_when_nothing_is_stored() {
    assert_eq!(resolve(None, Some("de")), "de");
  }

  #[test]
  fn english_is_the_last_resort() {
    assert_eq!(resolve(None, None), "en");
  }

  #[test]
  fn an_unknown_value_is_ignored_at_every_level() {
    // Un réglage édité à la main ne doit pas laisser l'application sans interface.
    assert_eq!(resolve(Some("klingon"), Some("it")), "it");
    assert_eq!(resolve(Some("klingon"), Some("klingon")), "en");
    // Retirés du périmètre, donc inconnus au même titre qu'un code inventé.
    assert_eq!(resolve(Some("nl"), None), "en");
    assert_eq!(resolve(Some("ja"), None), "en");
    assert_eq!(resolve(Some("zh"), None), "en");
    assert_eq!(resolve(Some("ko"), None), "en");
  }

  #[test]
  fn regions_and_case_are_ignored() {
    assert_eq!(resolve(Some("fr-CA"), None), "fr");
    assert_eq!(resolve(Some("pt_BR"), None), "pt");
    assert_eq!(resolve(Some("ES-419"), None), "es");
    assert_eq!(resolve(Some(""), Some("it")), "it");
  }

  #[test]
  fn the_source_locale_is_served_at_the_root_and_the_others_in_their_folder() {
    assert_eq!(window_path("fr", true), "index.html");
    assert_eq!(window_path("es", true), "es/index.html");
  }

  #[test]
  fn development_always_loads_the_root_because_ng_serve_serves_one_locale() {
    assert_eq!(window_path("es", false), "index.html");
    assert_eq!(window_path("fr", false), "index.html");
  }

  #[test]
  fn a_missing_or_broken_settings_file_yields_no_locale() {
    let directory = std::env::temp_dir().join("mirmalion-i18n-test");
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).expect("répertoire");

    let absent = directory.join("absent.json");
    assert_eq!(stored_locale(&absent), None);

    let broken = directory.join("casse.json");
    std::fs::write(&broken, "{ pas du json").expect("écriture");
    assert_eq!(stored_locale(&broken), None);

    let without = directory.join("sans-langue.json");
    std::fs::write(&without, r#"{"theme":"dark"}"#).expect("écriture");
    assert_eq!(stored_locale(&without), None);

    let wrong_type = directory.join("mauvais-type.json");
    std::fs::write(&wrong_type, r#"{"interfaceLanguage":42}"#).expect("écriture");
    assert_eq!(stored_locale(&wrong_type), None);

    let valid = directory.join("valide.json");
    std::fs::write(&valid, r#"{"interfaceLanguage":"it"}"#).expect("écriture");
    assert_eq!(stored_locale(&valid).as_deref(), Some("it"));

    let _ = std::fs::remove_dir_all(&directory);
  }

  // Les langues déclarées au bundle décident de la langue des fenêtres présentées par Apple.
  //
  // ⚠️ Sans `CFBundleLocalizations`, toute interface présentée par macOS en notre nom sort en
  // anglais quelle que soit la langue du système — mesuré sur la feuille de téléchargement du
  // framework Translation. La mesure ne se refait que sur un `.app` construit : `tauri dev`
  // lance le binaire nu, sans plist de bundle.
  //
  // La liste vit à deux endroits qui ne se parlent pas : le plist, lu par le lanceur avant même
  // que le processus n'existe, et `SUPPORTED_LOCALES`, lu par le code. Ces tests sont le lien.

  /// Le plist tel qu'il est livré au bundler, inclus à la compilation : le lire au moment du
  /// test dépendrait du répertoire courant, qui change selon la façon de lancer cargo.
  const INFO_PLIST: &str = include_str!("../Info.plist");

  /// Les chaînes du tableau qui suit `key`.
  ///
  /// # Panics
  ///
  /// Panique si `key` a disparu d'`Info.plist` ou si son tableau est mal formé.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Un découpage de texte, pas un analyseur de plist : il doit échouer bruyamment plutôt
  ///   que rendre une liste vide, sans quoi un plist réorganisé ferait passer les tests en ne
  ///   comparant rien.
  fn array_after(key: &str) -> Vec<String> {
    let marker = format!("<key>{key}</key>");
    let start = INFO_PLIST
      .find(&marker)
      .unwrap_or_else(|| panic!("la clé {key} a disparu de Info.plist"));
    let rest = &INFO_PLIST[start + marker.len()..];
    let open = rest
      .find("<array>")
      .unwrap_or_else(|| panic!("la clé {key} ne porte plus de tableau"));
    let close = rest
      .find("</array>")
      .unwrap_or_else(|| panic!("le tableau de {key} n'est pas refermé"));
    assert!(open < close, "le tableau de {key} est mal formé");

    rest[open..close]
      .split("<string>")
      .skip(1)
      .filter_map(|chunk| chunk.split("</string>").next())
      .map(|value| value.trim().to_owned())
      .collect()
  }

  /// La chaîne qui suit `key`.
  ///
  /// # Panics
  ///
  /// Panique si `key` a disparu d'`Info.plist` ou ne porte plus de chaîne.
  fn string_after(key: &str) -> String {
    let marker = format!("<key>{key}</key>");
    let start = INFO_PLIST
      .find(&marker)
      .unwrap_or_else(|| panic!("la clé {key} a disparu de Info.plist"));
    let rest = &INFO_PLIST[start + marker.len()..];
    let open = rest
      .find("<string>")
      .unwrap_or_else(|| panic!("la clé {key} ne porte plus de chaîne"));
    rest[open + "<string>".len()..]
      .split("</string>")
      .next()
      .expect("une chaîne refermée")
      .trim()
      .to_owned()
  }

  #[test]
  fn the_bundle_declares_exactly_the_languages_the_app_speaks() {
    let declared: std::collections::BTreeSet<String> =
      array_after("CFBundleLocalizations").into_iter().collect();
    let supported: std::collections::BTreeSet<String> = SUPPORTED_LOCALES
      .iter()
      .map(|locale| (*locale).to_owned())
      .collect();

    assert_eq!(
      declared, supported,
      "les langues du bundle et celles de l'application ont divergé : macOS présenterait ses \
       fenêtres dans une langue que l'application ne parle pas, ou l'inverse"
    );
  }

  #[test]
  fn the_development_region_is_the_source_locale() {
    // C'est la langue servie à la racine du bundle, donc le repli de macOS quand le système
    // parle une langue hors de notre liste.
    assert_eq!(string_after("CFBundleDevelopmentRegion"), SOURCE_LOCALE);
  }

  #[test]
  fn the_plist_reader_refuses_to_pass_on_a_key_it_cannot_find() {
    // ⚠️ Un découpage qui rendrait une liste vide ferait passer les deux tests ci-dessus en ne
    // comparant rien. Vérifier qu'il panique est ce qui les rend dignes de foi.
    assert!(std::panic::catch_unwind(|| array_after("CFBundleClefInexistante")).is_err());
    assert!(std::panic::catch_unwind(|| string_after("CFBundleClefInexistante")).is_err());
  }
}
