//! **La CSP livrée est-elle encore stricte, et la page a-t-elle encore de quoi l'être ?**
//!
//! ⚠️ Les deux moitiés ne cassent pas de la même façon. Rendre `'unsafe-inline'` à `style-src`
//! ne casse **rien** : l'application reste identique à l'œil, et la seule directive non stricte
//! de la politique revient sans que personne le voie. Retirer le jeton d'`index.html`, à
//! l'inverse, casse tout le style de l'application livrée — mais seulement dans le `.app`, là où
//! Tauri sert la page, jamais en `tauri dev`.
//!
//! Ce que ce fichier vérifie : les deux moitiés sont là, et elles se correspondent.
//!
//! Ce qu'il ne prouve pas : que le webview accepte la page — cela demande un vrai navigateur, et
//! c'est l'objet de l'épreuve menée à la main lors du passage au nonce.

use std::{fs, path::PathBuf};

/// Le jeton que Tauri remplace, à chaque chargement, par un nonce tiré au hasard.
///
/// ⚠️ **Il est écrit deux fois dans le projet** — ici et dans `src/index.html` —, la constante
/// vivant dans `tauri-utils` sans être exposée par le crate `tauri`. C'est ce test qui tient les
/// deux copies ensemble.
const STYLE_NONCE_TOKEN: &str = "__TAURI_STYLE_NONCE__";

fn crate_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn config() -> serde_json::Value {
  let path = crate_root().join("tauri.conf.json");
  let text = fs::read_to_string(&path).expect("tauri.conf.json doit être lisible");
  serde_json::from_str(&text).expect("tauri.conf.json doit être du JSON valide")
}

/// La directive demandée, telle qu'elle est écrite dans la politique nommée.
fn directive(policy: &str, name: &str) -> String {
  let config = config();
  let csp = config["app"]["security"][policy]
    .as_str()
    .unwrap_or_else(|| panic!("app.security.{policy} doit être une chaîne"))
    .to_string();

  csp
    .split(';')
    .map(str::trim)
    .find(|part| part.starts_with(name))
    .unwrap_or_else(|| panic!("{policy} doit porter une directive {name}"))
    .to_string()
}

#[test]
fn the_shipped_policy_allows_no_inline_style() {
  let style_src = directive("csp", "style-src");

  assert!(
    !style_src.contains("'unsafe-inline'"),
    "les styles de composants passent par le nonce, pas par une porte ouverte : {style_src}"
  );
}

#[test]
fn the_page_carries_what_the_policy_requires() {
  let index = fs::read_to_string(crate_root().join("../src/index.html"))
    .expect("src/index.html doit être lisible");

  assert!(
    index.contains(&format!("ngCspNonce=\"{STYLE_NONCE_TOKEN}\"")),
    "sans ce jeton sur la racine, Angular pose ses styles sans nonce et l'application livrée \
     s'affiche entièrement sans style"
  );
}

/// ⚠️ **Ces quatre directives ne retombent pas sur `default-src`.** C'est la seule chose qu'il faut
/// savoir d'elles : absentes, elles ne sont pas restrictives, elles sont **ouvertes**. Toutes les
/// autres — `script-src`, `connect-src`, `img-src`… — héritent de `default-src 'self'` et n'ont
/// pas besoin d'être écrites ; celles-ci, si.
#[test]
fn the_directives_that_never_fall_back_are_all_written() {
  for (name, value) in [
    // Aucun `<object>`, `<embed>` ni greffon dans l'application.
    ("object-src", "'none'"),
    // ⚠️ `'none'` casserait l'application : `src/index.html` porte un `<base href="/">`, qu'Angular
    // exige pour son routage, et chaque langue du bundle a le sien (`/en/`, `/de/`…). `'self'`
    // autorise le nôtre et refuse un `<base>` injecté vers un autre hôte, qui détournerait toutes
    // les URL relatives de la page.
    ("base-uri", "'self'"),
    // L'application ne contient aucune balise `<form>`.
    ("form-action", "'none'"),
    // Rien n'a à embarquer cette page dans un cadre.
    ("frame-ancestors", "'none'"),
  ] {
    for policy in ["csp", "devCsp"] {
      let written = directive(policy, name);
      assert_eq!(
        written,
        format!("{name} {value}"),
        "{policy} doit porter « {name} {value} »"
      );
    }
  }
}

/// ⚠️ En `tauri dev`, la page vient d'`ng serve` et non de Tauri : personne ne remplace le jeton,
/// aucune source `'nonce-…'` n'entre dans la politique, et `'unsafe-inline'` est ce qui tient le
/// style debout. Le retirer là aussi casserait le développement sans rien durcir de ce qui est
/// livré.
#[test]
fn the_development_policy_keeps_the_door_the_dev_server_needs() {
  let style_src = directive("devCsp", "style-src");

  assert!(
    style_src.contains("'unsafe-inline'"),
    "ng serve ne remplace aucun jeton : {style_src}"
  );
}
