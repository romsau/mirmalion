import Foundation
import Security

// La clé de chiffrement de la base : générée une seule fois, au premier lancement, et jamais
// remplacée — elle est la seule chose qui rend la base lisible.
//
// D'où la règle qui structure ce fichier : la lecture ne crée jamais rien.
// `mirmalion_keychain_read` distingue trois issues, dont deux se ressemblent dangereusement :
//
//   errSecSuccess      → la clé est là         → statusOK
//   errSecItemNotFound → il n'y en a jamais eu → statusNotFound  (créer est légitime)
//   tout le reste      → on n'a pas pu la lire → statusError     (créer détruirait tout)
//
// ⚠️ Le troisième cas — trousseau verrouillé, accès refusé, item corrompu — ressemble au
// deuxième pour qui ne regarde qu'un booléen : c'est le défaut qui efface l'historique.
// ⚠️ Rien ici ne journalise : la clé ne doit apparaître dans aucun log, même en debug.

/// 256 bits, ce qu'attend SQLCipher.
private let keyByteCount = 32

/// La requête qui identifie l'item, commune à la lecture, à l'écriture et à la suppression.
///
/// Trousseau hérité, à dessein : l'accès y est contrôlé par une ACL liée au binaire qui a créé
/// l'item, et en production la signature est stable — aucune invite, mise à jour comprise.
///
/// - Parameters:
///   - service: le service du trousseau.
///   - account: le compte du trousseau.
/// - Warning: ⚠️ Un binaire de développement est signé ad hoc et sa signature change à chaque
///   compilation : le trousseau réclame alors une autorisation modale à chaque redémarrage.
private func keychainQuery(service: String, account: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    // ⚠️ Jamais de synchronisation iCloud : « rien ne sort de la machine » vaut d'abord
    // pour la clé qui déverrouille tout le reste.
    kSecAttrSynchronizable as String: false,
  ]
}

/// Le message lisible d'un `OSStatus` du trousseau, suivi de son code.
///
/// - Parameters:
///   - status: le statut rendu par une fonction `SecItem…`.
/// - Returns: le message système, ou « erreur inconnue » si le trousseau n'en donne aucun.
private func describe(_ status: OSStatus) -> String {
  let message = SecCopyErrorMessageString(status, nil) as String? ?? "erreur inconnue"
  return "\(message) (OSStatus \(status))"
}

extension Data {
  /// Minuscules, sans séparateur : la forme attendue par `PRAGMA key = "x'…'"`.
  fileprivate var hexEncoded: String {
    map { String(format: "%02x", $0) }.joined()
  }
}

/// Lit la clé de la base, sans jamais en créer.
///
/// - Parameters:
///   - service: le service du trousseau, ni nul ni vide.
///   - account: le compte du trousseau, ni nul ni vide.
///   - out: reçoit la clé en hexadécimal, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, `statusNotFound` si la clé n'a jamais été créée, `statusError` sinon.
/// - Warning: ⚠️ `statusNotFound` ne sort que sur `errSecItemNotFound` : toute autre
///   défaillance est une erreur, jamais une invitation à créer une clé par-dessus.
@_cdecl("mirmalion_keychain_read")
public func mirmalionKeychainRead(
  _ service: UnsafePointer<CChar>?,
  _ account: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withOptionalBridgeResult(out) {
    var query = keychainQuery(
      service: try requireArgument(service, "service"),
      account: try requireArgument(account, "account")
    )
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    switch status {
    case errSecSuccess:
      guard let data = item as? Data else {
        throw BridgeError.keychain("l'item du trousseau ne contient pas de données")
      }
      guard data.count == keyByteCount else {
        // Une clé de la mauvaise taille est une clé corrompue. On refuse, on n'écrase pas :
        // c'est peut-être la seule chose qui sépare l'utilisateur de ses données.
        throw BridgeError.keychain(
          "la clé stockée fait \(data.count) octets au lieu de \(keyByteCount)")
      }
      return data.hexEncoded

    case errSecItemNotFound:
      return nil

    default:
      throw BridgeError.keychain("lecture du trousseau impossible : \(describe(status))")
    }
  }
}

/// Génère une clé de 256 bits et la dépose dans le trousseau.
///
/// - Parameters:
///   - service: le service du trousseau, ni nul ni vide.
///   - account: le compte du trousseau, ni nul ni vide.
///   - out: reçoit la clé en hexadécimal, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si une clé existe déjà ou si le dépôt échoue.
/// - Warning: ⚠️ Aucun chemin de ce fichier ne remplace une clé en place.
@_cdecl("mirmalion_keychain_create_key")
public func mirmalionKeychainCreateKey(
  _ service: UnsafePointer<CChar>?,
  _ account: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    var bytes = [UInt8](repeating: 0, count: keyByteCount)
    guard SecRandomCopyBytes(kSecRandomDefault, keyByteCount, &bytes) == errSecSuccess else {
      throw BridgeError.keychain("génération aléatoire impossible")
    }
    defer { bytes.resetBytes(in: 0..<bytes.count) }

    var query = keychainQuery(
      service: try requireArgument(service, "service"),
      account: try requireArgument(account, "account")
    )
    query[kSecValueData as String] = Data(bytes)
    // La clé ne sert qu'après le premier déverrouillage de la session, et ne quitte jamais
    // cette machine — pas de sauvegarde, pas de migration vers un autre Mac.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      if status == errSecDuplicateItem {
        throw BridgeError.keychain(
          "une clé existe déjà pour ce service : elle ne sera pas remplacée")
      }
      throw BridgeError.keychain("dépôt dans le trousseau impossible : \(describe(status))")
    }
    return Data(bytes).hexEncoded
  }
}

/// Supprime la clé. Réservé aux tests : rien ne l'expose en IPC.
///
/// - Parameters:
///   - service: le service du trousseau, ni nul ni vide.
///   - account: le compte du trousseau, ni nul ni vide.
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, y compris si la clé était déjà absente ; `statusError` sinon.
/// - Warning: ⚠️ Destructif et irréversible : la base devient illisible pour toujours.
@_cdecl("mirmalion_keychain_delete")
public func mirmalionKeychainDelete(
  _ service: UnsafePointer<CChar>?,
  _ account: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let query = keychainQuery(
      service: try requireArgument(service, "service"),
      account: try requireArgument(account, "account")
    )
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw BridgeError.keychain("suppression impossible : \(describe(status))")
    }
    return ""
  }
}
