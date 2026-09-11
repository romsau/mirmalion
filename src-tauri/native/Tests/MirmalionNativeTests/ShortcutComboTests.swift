import CoreGraphics
import Testing

@testable import MirmalionNative

// La règle qui décide ce que les modificateurs enfoncés demandent.
//
// ⚠️ Elle n'était éprouvée par rien. Son défaut ne se voit pas en la lisant : accepter
// « au moins ⌃⌥ » compile, marche sur ⌃⌥, et fait démarrer une dictée à chaque ⌃⌥⌘⇧ ou
// ⌃⌥⌘ suivi d'une lettre. L'utilisateur verrait la pilule apparaître au hasard de ses
// raccourcis, sans jamais pouvoir relier les deux.

@Suite("Les combinaisons de la dictée")
struct ShortcutComboTests {

  /// ⚠️ **Le cœur de la règle : l'égalité, pas l'inclusion.** Chacun des cas `nil` ci-dessous
  /// passerait si la comparaison était `flags.contains(...)`.
  @Test(
    "chaque combinaison se reconnaît exactement, et rien d'autre ne passe",
    arguments: [
      (CGEventFlags([.maskControl, .maskAlternate]), ShortcutCombo.spoken),
      (CGEventFlags([.maskControl, .maskAlternate, .maskCommand]), ShortcutCombo.translated),
      (CGEventFlags([]), nil),
      (CGEventFlags([.maskControl]), nil),
      (CGEventFlags([.maskAlternate]), nil),
      (CGEventFlags([.maskCommand]), nil),
      (CGEventFlags([.maskControl, .maskCommand]), nil),
      (CGEventFlags([.maskAlternate, .maskCommand]), nil),
      (CGEventFlags([.maskControl, .maskAlternate, .maskShift]), nil),
      (CGEventFlags([.maskControl, .maskAlternate, .maskCommand, .maskShift]), nil),
    ]
  )
  func eachComboIsRecognisedExactly(flags: CGEventFlags, expected: ShortcutCombo?) {
    #expect(matchedCombo(in: flags) == expected)
  }

  /// ⚠️ Verrou majuscules, `fn` et pavé numérique accompagnent une frappe **sans être un choix
  /// de l'utilisateur**. Les compter ferait s'effondrer la dictée au moindre appui parasite :
  /// un utilisateur qui dicte avec le verrou majuscules actif ne pourrait plus démarrer.
  @Test(
    "les modificateurs qu'on ne choisit pas ne défont aucune combinaison",
    arguments: [
      CGEventFlags.maskAlphaShift,
      CGEventFlags.maskSecondaryFn,
      CGEventFlags.maskNumericPad,
      CGEventFlags.maskHelp,
      CGEventFlags.maskNonCoalesced,
    ]
  )
  func insignificantModifiersAreIgnored(noise: CGEventFlags) {
    var spoken: CGEventFlags = [.maskControl, .maskAlternate]
    spoken.insert(noise)
    var translated: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand]
    translated.insert(noise)

    #expect(
      matchedCombo(in: spoken) == .spoken,
      "⌃⌥ reste ⌃⌥ quand un modificateur subi s'y ajoute")
    #expect(matchedCombo(in: translated) == .translated, "⌃⌥⌘ de même")
  }

  /// Le code voyage vers Rust en `Int32` : les trois valeurs sont **du contrat**, et une
  /// dérive d'un côté ferait dicter dans la mauvaise langue sans rien casser de visible.
  @Test("les codes du pont ne bougent pas")
  func theBridgeCodesArePinned() {
    #expect(ShortcutCombo.spoken.rawValue == 1)
    #expect(ShortcutCombo.translated.rawValue == 2)
    #expect(comboCode(nil) == 0)
    #expect(comboCode(.spoken) == 1)
    #expect(comboCode(.translated) == 2)
  }
}
