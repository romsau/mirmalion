//! La clé de chiffrement de la base SQLCipher.
//!
//! Elle est générée une seule fois, au tout premier lancement, et elle est la seule chose qui
//! rende la base lisible.
//!
//! # Pièges
//!
//! - ⚠️ L'écraser perd définitivement l'historique. D'où [`load_or_create`] : on ne crée une
//!   clé que lorsque le trousseau affirme qu'il n'y en a jamais eu. Une lecture qui échoue
//!   pour une autre raison — trousseau verrouillé, item corrompu — remonte l'erreur sans rien
//!   écrire.
//! - ⚠️ Aucun log ici, à aucun niveau : une clé dans un fichier de log est une clé publiée.
//!   [`EncryptionKey`] a un `Debug` masqué et n'implémente ni `Display` ni `Serialize`.
//! - ⚠️ Aucune exposition en IPC : le frontend n'a pas à connaître la clé.

use std::fmt;

use zeroize::Zeroizing;

use crate::{error::AppError, native};

/// Le compte de l'entrée dans le trousseau ; le service, lui, vient de l'appelant.
///
/// # Pièges
///
/// - ⚠️ Le service vaut l'identifiant de bundle, distinct entre la variante de développement
///   et l'app finale : c'est ce qui empêche les deux de partager clé et base.
pub const KEY_ACCOUNT: &str = "database-encryption-key";

/// Longueur de la clé en hexadécimal : 32 octets, soit 256 bits, ce qu'attend SQLCipher.
const HEX_LEN: usize = 64;

/// La clé, sous la seule forme dont le reste du code a besoin.
///
/// Elle est conservée en hexadécimal parce que c'est exactement ce que consomme
/// `PRAGMA key = "x'…'"` : aucun décodage, donc aucune copie d'octets bruts à gérer.
pub struct EncryptionKey(Zeroizing<String>);

impl EncryptionKey {
  /// Valide une clé hexadécimale et l'enveloppe, ramenée en minuscules.
  ///
  /// # Errors
  ///
  /// Rend [`AppError::Keychain`] si la chaîne ne fait pas exactement [`HEX_LEN`] caractères
  /// hexadécimaux.
  ///
  /// # Pièges
  ///
  /// - ⚠️ Une clé mal formée doit être une erreur bruyante, jamais une base silencieusement
  ///   illisible ni une clé neuve écrite par-dessus.
  pub(crate) fn from_hex(hex: String) -> Result<Self, AppError> {
    if hex.len() != HEX_LEN || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
      // ⚠️ Le message ne contient pas la valeur reçue : ce serait publier la clé.
      return Err(AppError::Keychain(format!(
        "la clé lue n'est pas hexadécimale sur {HEX_LEN} caractères"
      )));
    }
    Ok(Self(Zeroizing::new(hex.to_ascii_lowercase())))
  }

  /// La clé au format attendu par SQLCipher.
  pub fn as_sqlcipher_hex(&self) -> &str {
    &self.0
  }
}

/// Masqué à dessein : c'est ce qui empêche un `{:?}` distrait de publier la clé.
impl fmt::Debug for EncryptionKey {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str("EncryptionKey(<masquée>)")
  }
}

/// Renvoie la clé de la base, en la créant si et seulement s'il n'y en a jamais eu.
///
/// # Errors
///
/// Rend [`AppError::Keychain`] si le trousseau est inaccessible, si l'item est corrompu ou si
/// la création échoue ; [`AppError::InvalidArgument`] si `service` est vide ou porte un octet
/// nul.
pub fn load_or_create(service: &str) -> Result<EncryptionKey, AppError> {
  resolve(
    || native::keychain_read(service, KEY_ACCOUNT),
    || native::keychain_create_key(service, KEY_ACCOUNT),
  )
}

/// Lit la clé, et ne passe à `create` que si `read` a rendu `None`.
///
/// Isolé du trousseau pour que la règle soit éprouvable sans lui.
///
/// # Errors
///
/// Propage l'erreur de `read`, celle de `create`, ou celle de [`EncryptionKey::from_hex`].
///
/// # Pièges
///
/// - ⚠️ Le `?` sur `read` est ce qui garantit qu'une défaillance du trousseau interrompt tout
///   au lieu de créer une clé neuve par-dessus une base existante.
fn resolve(
  read: impl FnOnce() -> Result<Option<String>, AppError>,
  create: impl FnOnce() -> Result<String, AppError>,
) -> Result<EncryptionKey, AppError> {
  match read()? {
    Some(hex) => EncryptionKey::from_hex(hex),
    None => EncryptionKey::from_hex(create()?),
  }
}

#[cfg(test)]
mod tests {
  use super::{EncryptionKey, HEX_LEN, KEY_ACCOUNT, load_or_create, resolve};
  use crate::{error::AppError, native};
  use std::cell::Cell;

  /// Chaque test a son propre service : les tests tournent en parallèle et écrivent dans le
  /// vrai trousseau de la session. Le préfixe les rend reconnaissables si un nettoyage
  /// échoue.
  struct TestKeychain(String);

  impl TestKeychain {
    fn new(name: &str) -> Self {
      let service = format!("com.mirmalion.desktop.test.{name}");
      // Un résidu d'une exécution précédente fausserait le scénario « premier lancement ».
      native::keychain_delete(&service, KEY_ACCOUNT).expect("nettoyage initial");
      Self(service)
    }

    fn service(&self) -> &str {
      &self.0
    }
  }

  impl Drop for TestKeychain {
    fn drop(&mut self) {
      let _ = native::keychain_delete(&self.0, KEY_ACCOUNT);
    }
  }

  #[test]
  fn the_first_launch_creates_a_256_bit_key() {
    let keychain = TestKeychain::new("first-launch");

    assert_eq!(
      native::keychain_read(keychain.service(), KEY_ACCOUNT).expect("lecture"),
      None,
      "le scénario suppose un trousseau vierge"
    );

    let key = load_or_create(keychain.service()).expect("création");
    let hex = key.as_sqlcipher_hex();

    assert_eq!(hex.len(), HEX_LEN);
    assert!(hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(hex.bytes().all(|byte| !byte.is_ascii_uppercase()));
    assert_ne!(
      hex,
      "0".repeat(HEX_LEN),
      "une clé nulle n'est pas aléatoire"
    );
  }

  #[test]
  fn the_next_launches_read_the_same_key_and_never_regenerate_it() {
    let keychain = TestKeychain::new("stable-across-launches");

    let first = load_or_create(keychain.service()).expect("premier démarrage");
    let second = load_or_create(keychain.service()).expect("deuxième démarrage");
    let third = load_or_create(keychain.service()).expect("troisième démarrage");

    assert_eq!(first.as_sqlcipher_hex(), second.as_sqlcipher_hex());
    assert_eq!(second.as_sqlcipher_hex(), third.as_sqlcipher_hex());
  }

  #[test]
  fn two_services_never_share_a_key() {
    let dev = TestKeychain::new("identity-dev");
    let release = TestKeychain::new("identity-release");

    let dev_key = load_or_create(dev.service()).expect("clé dev");
    let release_key = load_or_create(release.service()).expect("clé finale");

    assert_ne!(dev_key.as_sqlcipher_hex(), release_key.as_sqlcipher_hex());
  }

  #[test]
  fn creating_a_second_key_over_an_existing_one_is_refused() {
    let keychain = TestKeychain::new("no-overwrite");
    load_or_create(keychain.service()).expect("première clé");

    // Le seul chemin qui écrit doit refuser d'écraser, même appelé directement.
    let error = native::keychain_create_key(keychain.service(), KEY_ACCOUNT)
      .expect_err("une clé existe déjà");

    assert_eq!(error.kind(), "keychain");
    assert!(error.to_string().contains("ne sera pas remplacée"));
  }

  #[test]
  fn an_unreadable_key_is_an_error_and_never_a_reason_to_create_one() {
    // Une clé mal formée simule un item corrompu : `from_hex` doit refuser, pas réparer.
    for malformed in ["", "abc", &"z".repeat(HEX_LEN), &"a".repeat(HEX_LEN - 1)] {
      let error = EncryptionKey::from_hex(malformed.to_owned()).expect_err("doit être refusée");
      assert!(matches!(error, AppError::Keychain(_)));
    }
  }

  #[test]
  fn a_valid_key_is_accepted_and_lowercased() {
    let key = EncryptionKey::from_hex("A".repeat(HEX_LEN)).expect("hexadécimal valide");
    assert_eq!(key.as_sqlcipher_hex(), "a".repeat(HEX_LEN));
  }

  #[test]
  fn an_empty_argument_is_refused_before_reaching_the_keychain() {
    let error = native::keychain_read("", KEY_ACCOUNT).expect_err("service vide");
    assert!(matches!(error, AppError::InvalidArgument(_)));

    let error = native::keychain_read("service\0piégé", KEY_ACCOUNT).expect_err("octet nul");
    assert!(matches!(error, AppError::InvalidArgument(_)));
  }

  /// **Le test le plus important du module.**
  ///
  /// Une lecture qui échoue pour une autre raison que l'absence ne doit pas seulement
  /// renvoyer une erreur : elle ne doit **rien écrire**. Ce que l'on vérifie ici n'est pas la
  /// valeur de retour, c'est que le chemin de création n'a jamais été emprunté.
  #[test]
  fn a_failed_read_never_reaches_the_creation_path() {
    let created = Cell::new(false);

    let error = resolve(
      || Err(AppError::Keychain("trousseau verrouillé".into())),
      || {
        created.set(true);
        Ok("a".repeat(HEX_LEN))
      },
    )
    .expect_err("une lecture en échec doit échouer");

    assert_eq!(error.kind(), "keychain");
    assert!(
      !created.get(),
      "une lecture en échec ne doit JAMAIS déclencher la création d'une clé"
    );
  }

  #[test]
  fn an_absent_key_does_reach_the_creation_path() {
    let created = Cell::new(false);

    let key = resolve(
      || Ok(None),
      || {
        created.set(true);
        Ok("b".repeat(HEX_LEN))
      },
    )
    .expect("une clé absente doit être créée");

    assert!(created.get());
    assert_eq!(key.as_sqlcipher_hex(), "b".repeat(HEX_LEN));
  }

  #[test]
  fn a_failed_creation_propagates_untouched() {
    let error = resolve(
      || Ok(None),
      || Err(AppError::Keychain("dépôt refusé".into())),
    )
    .expect_err("la création a échoué");
    assert_eq!(error.kind(), "keychain");
  }

  /// Un item corrompu — clé de la mauvaise taille — doit être **refusé**, jamais réparé ni
  /// remplacé. Le refus vient de `from_hex` côté Rust ; le contrôle de taille de
  /// `Keychain.swift` est la même barrière un cran plus tôt.
  ///
  /// _Ce scénario n'est pas rejoué de bout en bout contre le vrai trousseau : planter un
  /// item corrompu demande la CLI `security`, qui réclame le mot de passe de session à
  /// chaque exécution. Un test qui exige une saisie humaine n'est pas un test._
  #[test]
  fn a_corrupted_key_is_refused_and_nothing_is_written() {
    let created = Cell::new(false);

    let error = resolve(
      || Ok(Some("pas-une-cle".to_owned())),
      || {
        created.set(true);
        Ok("c".repeat(HEX_LEN))
      },
    )
    .expect_err("une clé corrompue doit échouer");

    assert_eq!(error.kind(), "keychain");
    assert!(
      !created.get(),
      "une clé corrompue ne doit JAMAIS être remplacée par une clé neuve"
    );
  }

  #[test]
  fn the_key_never_leaks_through_debug() {
    let key = EncryptionKey::from_hex("a".repeat(HEX_LEN)).expect("hexadécimal valide");
    let rendered = format!("{key:?}");

    assert_eq!(rendered, "EncryptionKey(<masquée>)");
    assert!(
      !rendered.contains('a'.to_string().repeat(8).as_str()),
      "aucun fragment de la clé ne doit apparaître"
    );
  }

  #[test]
  fn the_error_message_of_a_malformed_key_never_contains_the_key() {
    let secret = "f".repeat(HEX_LEN + 1);
    let error = EncryptionKey::from_hex(secret.clone()).expect_err("trop longue");
    assert!(!error.to_string().contains(&secret));
  }
}
