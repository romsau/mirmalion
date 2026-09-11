import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Insérer le texte là où l'utilisateur travaille.
//
// Il n'existe pas d'API pour écrire dans le champ d'une autre application. La seule voie est
// celle de tous les outils de dictée : poser le texte au presse-papiers, simuler ⌘V, puis
// rendre le presse-papiers. `CGEvent` plutôt qu'`osascript` — l'Accessibilité suffit, là où
// passer par System Events exigerait en plus l'Automatisation.
//
// ⚠️ La source de l'évènement n'est pas optionnelle : avec `keyboardEventSource: nil`, le
// drapeau de modificateur ne prend pas et le ⌘V ne produit rien.
// ⚠️ Le V doit être encadré de vrais `flagsChanged` : poser `.maskCommand` sur une frappe ne
// fait pas s'enfoncer Command dans la session, le drapeau ne voyage que sur l'évènement. Sans
// eux, un terminal — qui tient son état des modificateurs de ces évènements — reçoit un `v`,
// et ⌘ reste asserté dans l'état global après la dictée, changeant le clic suivant en ⌘-clic.
// Les quatre évènements n'exigent aucune attente entre eux : ne pas y remettre de `sleep`.

/// Le code de la touche V sur un clavier ANSI.
///
/// - Warning: ⚠️ C'est une position, pas une lettre : les codes de touches macOS décrivent
///   l'emplacement physique, et sur un clavier AZERTY la position 9 reste celle que le système
///   interprète comme V. Traduire le caractère « v » selon la disposition serait le bogue.
private let keyV: CGKeyCode = 9

/// Le code de la touche Command, porté par les `flagsChanged` qui encadrent le V.
///
/// - Warning: ⚠️ Un `flagsChanged` sans code de touche ne suffit pas : c'est lui qui dit
///   quelle touche de modification change d'état.
private let keyCommand: CGKeyCode = 55

/// Le temps laissé à l'application cible pour consommer le ⌘V avant qu'on reprenne le
/// presse-papiers.
///
/// - Warning: ⚠️ Trop court, l'application colle l'ancien contenu. 150 ms est la valeur
///   mesurée, constatée en production.
private let restoreDelay: TimeInterval = 0.150

/// Les rôles d'accessibilité qui acceptent une saisie, quand l'élément ne déclare pas
/// lui-même sa valeur modifiable.
///
/// - Warning: ⚠️ Cette liste sert à dire oui, jamais à dire non : un rôle qui n'y figure pas
///   n'est pas « incapable de recevoir du texte », il nous est inconnu. Voir
///   `nonEditableRoles`.
private let editableRoles: Set<String> = [
  kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, "AXSearchField",
]

/// Les rôles dont on sait positivement qu'ils ne reçoivent pas de texte.
///
/// - Warning: ⚠️ Seule cette liste autorise un refus. Refuser tout rôle absent d'`editableRoles`
///   abandonnait le collage en silence dans des champs qui acceptaient le texte, sans que le
///   journal permette de relier la ligne à ce que voyait l'utilisateur.
/// - Warning: ⚠️ Ne pas l'allonger « au cas où » : chaque entrée doit désigner un contrôle où
///   aucune saisie n'a de sens. Dans le doute on tente le collage — au pire ⌘V ne produit rien,
///   et le presse-papiers est rendu de toute façon.
private let nonEditableRoles: Set<String> = [
  kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole, kAXMenuItemRole, kAXMenuBarItemRole,
  kAXSliderRole, kAXImageRole, kAXProgressIndicatorRole, kAXStaticTextRole,
]

/// Ce qu'il est advenu d'une demande d'insertion.
enum InjectionOutcome: String {
  /// Le texte a été collé.
  case inserted
  /// Aucun champ éditable n'a le focus. Ce n'est pas un échec : l'appelant se contente
  /// d'archiver le texte, et le presse-papiers n'a pas été touché du tout.
  case noEditableField
}

/// Ce que l'application au premier plan laisse savoir de son champ focalisé.
///
/// - Warning: ⚠️ `unknown` est le cas le plus fréquent : beaucoup d'applications n'exposent pas
///   leur arbre d'accessibilité — Google Chrome ne rend aucun élément focalisé, curseur dans
///   une zone de texte ou non, et tout ce qui est bâti sur Chromium fait pareil. Le confondre
///   avec `notEditable` ferait refuser la dictée là où elle sert le plus.
enum FocusVerdict: String {
  /// L'application le dit : ce champ accepte du texte.
  case editable
  /// L'application le dit : ce qui a le focus n'accepte pas de texte.
  case notEditable
  /// L'application ne dit rien. Ce n'est pas un refus.
  case unknown
}

/// L'application à qui le collage s'adresse : celle qu'on désigne, ou le premier plan.
///
/// - Parameters:
///   - target: le `pid` relevé au début de la dictée ; `0` ou négatif vise le premier plan.
/// - Returns: le `pid` visé, ou `nil` si aucune application n'est au premier plan.
/// - Warning: ⚠️ Un `pid` explicite n'est pas un luxe : le premier plan change pendant la
///   dictée, la pilule activant l'application malgré `focused(false)` (bogue Tauri macOS #7519,
///   #14102). Viser le premier plan au moment de coller revenait à coller chez nous.
private func resolveTarget(_ target: pid_t) -> pid_t? {
  if target > 0 {
    return target
  }
  return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

/// Interroge l'application visée sur son champ focalisé.
///
/// Deux critères pour `editable` : la valeur modifiable, puis un repli par rôle.
///
/// - Parameters:
///   - target: le `pid` visé ; `0` interroge le premier plan.
/// - Returns: `editable`, `notEditable`, ou `unknown` quand l'application ne dit rien.
/// - Warning: ⚠️ On n'active pas l'arbre d'accessibilité des applications qui le gardent
///   éteint : poser `AXManualAccessibility` sur Chrome ou une app Electron le laisserait
///   allumé après nous. On préfère ne pas savoir, et tenter le collage.
func focusVerdict(_ target: pid_t = 0) -> FocusVerdict {
  guard let element = focusedElement(target) else { return .unknown }

  var settable: DarwinBoolean = false
  if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
    settable.boolValue
  {
    return .editable
  }

  var role: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
    let name = role as? String
  else { return .unknown }

  // ⚠️ Trois issues, et l'ordre importe : un rôle connu comme éditable dit oui, un rôle connu
  // comme non éditable dit non, tout le reste dit « je ne sais pas » — et l'insertion tente
  // alors le collage. Voir `nonEditableRoles`.
  if editableRoles.contains(name) {
    return .editable
  }
  return nonEditableRoles.contains(name) ? .notEditable : .unknown
}

/// L'élément qui a le focus dans l'application visée.
///
/// - Returns: l'élément focalisé de `target` (`0` = premier plan), ou `nil` si l'application ne
///   répond pas — `cannotComplete` (-25204) est un dialogue, `noValue` (-25212) un champ absent.
/// - Warning: ⚠️ Par le `pid`, jamais par `AXUIElementCreateSystemWide()` que documentent pourtant
///   tous les exemples : il répond invariablement `cannotComplete`, donc rien ne colle jamais.
/// - Warning: ⚠️ **La seule conversion forcée du paquet**, seule dérogation au « jamais de `!` »
///   de `Bridge.swift`. `AXUIElement` est un type Core Foundation sans `as?`, et le `guard`
///   ci-dessous vérifie `CFGetTypeID(value) == AXUIElementGetTypeID()` juste avant.
// swift-format-ignore: NeverForceUnwrap
private func focusedElement(_ target: pid_t) -> AXUIElement? {
  guard let resolved = resolveTarget(target) else { return nil }
  let application = AXUIElementCreateApplication(resolved)

  var focused: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &focused)
      == .success,
    let value = focused,
    // Le contrôle de type est ce qui rend la conversion ci-dessous incapable d'échouer.
    CFGetTypeID(value) == AXUIElementGetTypeID()
  else { return nil }
  return (value as! AXUIElement)
}

/// Un évènement de changement de modificateur annonçant que Command s'enfonce ou se relève.
///
/// - Parameters:
///   - source: la source des évènements de la séquence.
///   - pressed: `true` pour l'enfoncement, `false` pour le relâchement.
/// - Returns: l'évènement, ou `nil` si macOS refuse de le créer.
/// - Warning: ⚠️ `CGEvent` n'a pas d'initialiseur de `flagsChanged` : on crée une frappe sur la
///   touche Command puis on corrige son type. Le relâchement porte des drapeaux vides — c'est
///   lui qui rend l'état de la session.
private func commandFlagsEvent(_ source: CGEventSource, pressed: Bool) -> CGEvent? {
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCommand, keyDown: pressed)
  else { return nil }
  event.type = .flagsChanged
  event.flags = pressed ? .maskCommand : []
  return event
}

/// Colle `text` à l'endroit où l'utilisateur travaille, puis lui rend son presse-papiers.
///
/// - Parameters:
///   - text: le texte à coller, non vide.
///   - target: le `pid` relevé au début de la dictée ; `0` vise le premier plan.
/// - Returns: `inserted`, ou `noEditableField` si le focus refuse positivement le texte.
/// - Throws: `BridgeError.permission` sans l'Accessibilité, `.injection` si macOS refuse.
/// - Warning: ⚠️ Le `defer` rend le presse-papiers quoi qu'il arrive, échec compris : le texte
///   dicté est déjà dans l'historique, ce que l'utilisateur avait copié serait perdu.
func insertAtCursor(_ text: String, target: pid_t = 0) throws -> InjectionOutcome {
  guard !text.isEmpty else {
    throw BridgeError.invalidArgument("aucun texte à insérer")
  }
  // ⚠️ Sans l'Accessibilité, `post` ne fait rien et ne dit rien : le collage semblerait avoir
  // eu lieu. Cette garde est le seul moyen de rendre l'échec visible.
  guard AXIsProcessTrusted() else {
    throw BridgeError.permission(
      "autorisation Accessibilité non accordée : le texte ne peut pas être inséré")
  }
  // ⚠️ On ne refuse que sur preuve positive : une application muette (Chrome et tout Chromium)
  // obtient sa tentative de collage, au pire ⌘V ne fait rien et le presse-papiers est rendu de
  // toute façon. Refuser dans le doute priverait la dictée du navigateur, où elle sert le plus.
  guard focusVerdict(target) != .notEditable else { return .noEditableField }

  // ⚠️ **Toute la séquence est sous emprunt** — voir `borrowingPasteboard`. Deux insertions
  // simultanées photographieraient sinon le texte l'une de l'autre, et le presse-papiers de
  // l'utilisateur finirait remplacé par une dictée, définitivement. La commande IPC
  // `insert_at_cursor` est exposée nue au webview : « le pipeline sérialise déjà » ne suffit pas.
  return try borrowingPasteboard(for: text, settling: restoreDelay) {
    // ⚠️ Les quatre évènements sont créés avant qu'aucun ne parte : c'est ce qui garantit qu'on
    // ne poste jamais un ⌘ enfoncé sans avoir de quoi le relever, la seule étape qui puisse
    // échouer étant faite quand la séquence commence.
    guard let source = CGEventSource(stateID: .hidSystemState),
      let commandDown = commandFlagsEvent(source, pressed: true),
      let commandUp = commandFlagsEvent(source, pressed: false),
      let down = CGEvent(keyboardEventSource: source, virtualKey: keyV, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: keyV, keyDown: false)
    else {
      throw BridgeError.injection("macOS a refusé de créer l'évènement de collage")
    }
    down.flags = .maskCommand
    up.flags = .maskCommand

    // ⚠️ Les quatre, dans cet ordre, et sans attente entre eux. Ne pas retirer les deux
    // `flagsChanged` ni intercaler de `sleep` : voir l'en-tête du module, qui porte la mesure.
    // ⚠️ Quand une cible est désignée, on la livre directement (`postToPid`) plutôt que de poster
    // dans la session. Les quatre voies de livraison aboutissent aussi bien l'une que l'autre,
    // mais seule celle-ci est indifférente à un changement de premier plan — le nôtre en
    // particulier, la pilule activant l'application quand l'utilisateur commence à parler.
    let deliver: (CGEvent) -> Void =
      target > 0 ? { $0.postToPid(target) } : { $0.post(tap: .cghidEventTap) }
    deliver(commandDown)
    deliver(down)
    deliver(up)
    deliver(commandUp)

    return .inserted
  }
}

/// Insère le texte au curseur, dans l'application visée.
///
/// - Parameters:
///   - text: le texte à coller, ni nul ni vide.
///   - target: le `pid` relevé au début de la dictée ; `0` vise le premier plan.
///   - out: reçoit `inserted` ou `noEditableField`, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` sans l'Accessibilité comme sur refus de macOS.
@_cdecl("mirmalion_insert_at_cursor")
public func mirmalionInsertAtCursor(
  _ text: UnsafePointer<CChar>?,
  _ target: Int32,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let value = try requireArgument(text, "le texte à insérer")
    return try insertAtCursor(value, target: pid_t(target)).rawValue
  }
}

/// L'application que le collage vise réellement : son `pid`, puis son identifiant de paquet.
///
/// - Parameters:
///   - out: reçoit `"<pid> <identifiant>"`, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK` ; `"0 (aucune)"` quand rien n'est au premier plan.
/// - Warning: ⚠️ Cet export interroge la même source que `focusedElement()` : sans lui, un
///   collage sans effet ne dit pas s'il a raté sa cible ou l'a atteinte en vain. Une sonde
///   extérieure ne le remplace pas — sans boucle d'exécution, `NSWorkspace` ne notifie rien.
@_cdecl("mirmalion_focus_target")
public func mirmalionFocusTarget(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let front = NSWorkspace.shared.frontmostApplication else { return "0 (aucune)" }
    // ⚠️ Le pid d'abord, séparé par une espace : l'appelant en tire la cible du collage et le
    // libellé de la trace en un seul aller-retour. Deux appels laisseraient le premier plan
    // changer entre eux, ce qui est précisément le défaut qu'on corrige.
    return "\(front.processIdentifier) \(front.bundleIdentifier ?? "(sans identifiant)")"
  }
}

/// Ce que l'application au premier plan dit de son champ focalisé. N'insère rien, ne touche
/// à rien.
///
/// - Parameters:
///   - out: reçoit `editable`, `notEditable` ou `unknown`, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`.
@_cdecl("mirmalion_focus_verdict")
public func mirmalionFocusVerdict(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    focusVerdict().rawValue
  }
}
