import Foundation

/// La langue préférée de l'utilisateur, telle que macOS la connaît.
///
/// Rend la sous-étiquette primaire (`fr`, `ja`, `zh`…), pas l'identifiant complet : les
/// variantes régionales ne sont pas distinguées, `fr-CA` et `fr-FR` sont du français.
///
/// - Parameters:
///   - out: reçoit la chaîne allouée, que l'appelant rend par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusNotFound` si le système n'annonce aucune langue — le repli
///   revient alors à l'appelant.
@_cdecl("mirmalion_preferred_language")
public func mirmalionPreferredLanguage(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withOptionalBridgeResult(out) {
    guard let preferred = Locale.preferredLanguages.first else {
      return nil
    }
    let primary = Locale(identifier: preferred).language.languageCode?.identifier
    return primary ?? String(preferred.prefix(while: { $0 != "-" }))
  }
}
