import Foundation
import Testing

@testable import MirmalionNative

// La lecture d'un argument facultatif du pont.
//
// ⚠️ Ce que ces épreuves gardent est **un contrat à deux côtés**. Rust envoie l'absence par un
// pointeur nul (`optional`, `native/mod.rs`) et refuse une valeur fournie mais vide. Deux
// conventions ont coexisté — pointeur nul d'un côté, chaîne vide de l'autre — et un export avait
// alors une chance sur deux de choisir celle que l'autre côté n'attendait pas. L'erreur était
// silencieuse : pas un plantage, un prompt personnalisé qui cesse d'être lu.

@Suite("L'argument facultatif du pont")
struct OptionalArgumentTests {

  /// Appelle `body` avec le pointeur d'une chaîne C, comme Rust le passerait.
  private func withPointer<T>(_ value: String, _ body: (UnsafePointer<CChar>) throws -> T) rethrows
    -> T
  {
    try value.withCString { try body($0) }
  }

  @Test("un pointeur nul vaut « absent »")
  func aNullPointerIsAbsent() {
    #expect(optionalArgument(nil) == nil)
  }

  @Test("une valeur traverse telle quelle")
  func aValueCrossesUnchanged() {
    #expect(withPointer("en") { optionalArgument($0) } == "en")
  }

  /// ⚠️ La chaîne vide vaut « absent » ici alors que Rust ne l'envoie plus : c'est la ceinture
  /// qui a rendu la migration sans risque, et la retirer ne casserait rien **aujourd'hui** —
  /// seulement le jour où un appelant reprendrait l'ancienne convention.
  @Test("une chaîne vide vaut « absent » elle aussi")
  func anEmptyStringIsAbsentToo() {
    #expect(withPointer("") { optionalArgument($0) } == nil)
  }

  /// ⚠️ Le contraire du contrat de `requireArgument`, et c'est voulu : « pas de micro », « pas de
  /// transcription en direct » et « pas de prompt personnalisé » sont des options du produit.
  @Test("l'argument obligatoire refuse ce que le facultatif accepte")
  func theRequiredArgumentRefusesWhatTheOptionalOneAccepts() {
    #expect(throws: BridgeError.self) {
      try requireArgument(nil, "la source audio")
    }
    #expect(throws: BridgeError.self) {
      try withPointer("") { try requireArgument($0, "la source audio") }
    }
  }
}
