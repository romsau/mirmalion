import Foundation
import Testing

@testable import MirmalionNative

// Ce qu'un message d'erreur a le droit d'emporter en traversant la frontière.
//
// ⚠️ Le pont est le seul chemin par lequel une phrase du système atteint l'écran de
// l'utilisateur. Deux règles du projet s'y jouent d'un coup : l'interface est localisée en six
// langues, et aucun message ne porte de contenu utilisateur — pas même un nom de fichier.

@Suite("Le message qui traverse le pont")
struct BridgeMessageTests {

  /// Nos propres erreurs traversent telles quelles : elles sont écrites en français, par nous,
  /// pour être lues.
  @Test("une erreur du pont garde sa phrase")
  func ourOwnErrorsPassThrough() {
    #expect(bridgeMessage(BridgeError.audio("le tap a refusé")) == "le tap a refusé")
    #expect(bridgeMessage(BridgeError.invalidArgument("chemin vide")) == "chemin vide")
    #expect(
      bridgeMessage(BridgeError.languageModel("le modèle n'a rien renvoyé"))
        == "le modèle n'a rien renvoyé")
  }

  /// ⚠️ **Le test qui compte.** `NSError` d'une opération de fichier porte le nom du fichier dans
  /// sa `localizedDescription`, et ce message allait jusqu'à l'écran. Un média importé s'appelle
  /// « entretien annuel Untel.m4a » — le nom seul dit déjà de quoi il s'agit et avec qui.
  @Test("le nom d'un fichier ne franchit jamais la frontière")
  func aFileNameNeverCrosses() {
    let secret = "entretien annuel Camille Durand.m4a"
    let failure = NSError(
      domain: NSCocoaErrorDomain,
      code: NSFileReadNoSuchFileError,
      userInfo: [
        NSFilePathErrorKey: "/Users/quelquun/Documents/\(secret)",
        NSLocalizedDescriptionKey: "The file “\(secret)” couldn’t be opened.",
      ])

    let message = bridgeMessage(failure)

    #expect(!message.contains(secret), "reçu : \(message)")
    #expect(!message.contains("Documents"))
    #expect(!message.contains("quelquun"))
  }

  /// ⚠️ Une phrase système est en anglais quelle que soit la langue de l'interface. La reprendre
  /// affichait « The operation couldn’t be completed » au milieu d'une application française —
  /// mesuré, et corrigé une première fois sur le seul refus du modèle de langue.
  @Test("une phrase anglaise du système ne franchit jamais la frontière")
  func anEnglishSystemSentenceNeverCrosses() {
    let failure = NSError(
      domain: NSOSStatusErrorDomain,
      code: -50,
      userInfo: [NSLocalizedDescriptionKey: "The operation couldn’t be completed."])

    let message = bridgeMessage(failure)

    #expect(!message.contains("The operation"))
    #expect(!message.contains("couldn’t"))
  }

  /// Ce qui reste doit suffire à retrouver la cause dans un rapport de crash : le domaine et le
  /// code. Sans eux, le message ne servirait plus à personne.
  @Test("l'identité de l'erreur système survit")
  func theSystemErrorIdentitySurvives() {
    let message = bridgeMessage(NSError(domain: "com.exemple.pilote", code: 1_234))

    #expect(message.contains("com.exemple.pilote"))
    #expect(message.contains("1234"))
  }
}
