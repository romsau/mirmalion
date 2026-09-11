import Foundation
import Testing

@testable import MirmalionNative

// La porte du fil principal.
//
// ⚠️ AppKit n'accepte d'être touché que depuis le fil principal, et l'invariant « Rust appelle
// par `run_on_main_thread` » est tenu par des commentaires des deux côtés du pont, que ni l'un
// ni l'autre compilateur ne vérifie. `MainActor.assumeIsolated` seul ne lance pas : il TRAPPE.
// Ce que ces épreuves gardent, c'est qu'un appel fautif produise une erreur lisible plutôt qu'un
// processus mort sans message.

@Suite("La porte du fil principal")
struct MainActorGateTests {

  /// Ce qu'un fil de fond rapporte de sa tentative.
  private final class Attempt: @unchecked Sendable {
    var thrown: Error?
    var value: Int?
  }

  /// ⚠️ **Le test qui compte.** Sans le contrôle explicite, cette tentative ne rendrait pas une
  /// erreur : elle tuerait le processus de test, et la suite entière avec.
  @Test("un appel hors du fil principal est refusé, pas fatal")
  func offTheMainThreadItThrows() {
    let attempt = Attempt()
    let done = DispatchSemaphore(value: 0)

    DispatchQueue.global(qos: .userInitiated).async {
      do {
        attempt.value = try onMainActor("essai") { 42 }
      } catch {
        attempt.thrown = error
      }
      done.signal()
    }
    done.wait()

    #expect(attempt.value == nil, "rien ne doit s'exécuter hors du fil principal")
    // ⚠️ `is` sur l'optionnel plutôt qu'un déballage : `nil is BridgeError` vaut faux, si bien
    // que la même assertion dit « quelque chose a été lancé » et « c'était la bonne erreur ».
    #expect(attempt.thrown is BridgeError, "une erreur du pont, pas un processus mort")
  }

  /// Le message nomme le geste : sans lui, une trace dirait qu'un appel a échoué sans dire lequel,
  /// et les neuf appelants se ressemblent tous.
  @Test("le refus nomme le geste qui a été tenté")
  func theRefusalNamesTheGesture() {
    let attempt = Attempt()
    let done = DispatchSemaphore(value: 0)

    DispatchQueue.global(qos: .userInitiated).async {
      do {
        _ = try onMainActor("retaille de la pilule") { 1 }
      } catch {
        attempt.thrown = error
      }
      done.signal()
    }
    done.wait()

    let message = bridgeMessage(attempt.thrown ?? BridgeError.window("aucune erreur"))
    #expect(message.contains("retaille de la pilule"))
    #expect(message.contains("fil principal"))
  }

  /// Le cas nominal : depuis le fil principal, le travail passe et rend sa valeur.
  @Test("depuis le fil principal, le travail passe")
  @MainActor
  func onTheMainThreadItRuns() throws {
    #expect(try onMainActor("essai") { 42 } == 42)
  }

  /// Ce que `body` lance traverse la porte sans être transformé : une erreur de fenêtre reste une
  /// erreur de fenêtre, et l'appelant la reconnaît.
  @Test("une erreur du travail traverse la porte telle quelle")
  @MainActor
  func theBodysOwnErrorPassesThrough() {
    #expect(throws: BridgeError.self) {
      try onMainActor("essai") { throw BridgeError.window("boutons introuvables") }
    }
  }
}
