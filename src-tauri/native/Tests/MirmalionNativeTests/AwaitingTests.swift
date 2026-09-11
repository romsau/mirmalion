import Foundation
import Testing

@testable import MirmalionNative

// Le joint entre le pont, qui est synchrone, et les frameworks Apple, qui sont asynchrones.
//
// ⚠️ Ce que ces épreuves gardent n'est pas la valeur rendue mais **le fil**. Rust appelle le pont
// depuis `spawn_blocking` : chaque attente d'ici retient un fil de ce pool, et un moteur qui ne
// rendrait jamais sa continuation le retiendrait pour la durée du processus. Quelques appels de
// ce genre et l'application ne répond plus à aucune commande, sans qu'une erreur apparaisse.

@Suite("L'attente bornée du pont")
struct AwaitingTests {

  private struct Refused: Error {}

  @Test("ce que le corps rend traverse l'attente")
  func returnsWhatTheBodyProduced() throws {
    let value = try awaiting("un calcul", within: 5) { 21 * 2 }
    #expect(value == 42)
  }

  @Test("ce que le corps lance traverse l'attente, sans être reclassé")
  func rethrowsWhatTheBodyThrew() {
    #expect(throws: Refused.self) {
      try awaiting("un refus", within: 5) { () async throws -> Int in throw Refused() }
    }
  }

  /// ⚠️ **La contre-épreuve de tout ce point.** Sans la borne, ce test ne tombe pas : il ne
  /// finit jamais, et c'est exactement ce qu'un moteur muet fait au fil qui l'attend.
  @Test("un corps qui ne rend jamais la main rend la main quand même", .timeLimit(.minutes(1)))
  func aBodyThatNeverReturnsGivesTheThreadBack() {
    let started = Date()
    #expect(throws: BridgeError.self) {
      try awaiting("un moteur muet", within: 0.2) {
        try? await Task.sleep(for: .seconds(30))
      }
    }
    #expect(
      Date().timeIntervalSince(started) < 5,
      "l'attente a duré au-delà de sa borne : la borne n'agit pas")
  }

  /// ⚠️ Le message nomme le geste et la borne, jamais ce qui était traité : un dépassement de
  /// traduction ou de compte rendu ne doit pas citer une ligne du transcript.
  @Test("le message de dépassement nomme le geste et la borne, et rien d'autre")
  func theTimeoutMessageNamesTheGestureAndNothingElse() {
    do {
      _ = try awaiting("la traduction", within: 0.1) {
        try? await Task.sleep(for: .seconds(30))
      }
      Issue.record("l'attente aurait dû être bornée")
    } catch {
      let message = bridgeMessage(error)
      #expect(message.contains("la traduction"))
      #expect(message.contains("0 s") || message.contains("s"))
    }
  }

  /// ⚠️ `nil` est un choix documenté, pas un oubli : la diarisation et la transcription de
  /// fichier durent en proportion du média, et une borne fixe couperait le média long.
  @Test("sans borne, une attente longue aboutit au lieu d'être coupée", .timeLimit(.minutes(1)))
  func withoutADeadlineTheWorkStillFinishes() throws {
    let value = try awaiting("un travail proportionnel", within: nil) { () async -> Int in
      try? await Task.sleep(for: .milliseconds(400))
      return 7
    }
    #expect(value == 7)
  }
}
