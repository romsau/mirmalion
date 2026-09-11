import ApplicationServices
import CoreGraphics
import Foundation

// Le raccourci global ⌃⌥ : un tap clavier, et rien d'autre.
//
// Trois faits de macOS commandent la forme du code : `CGEvent.tapCreate` rend un port valide
// même sans l'autorisation Accessibilité, un tap doit tourner sur une boucle d'exécution à lui
// et ne jamais tarder, et macOS désactive un tap qui a tardé comme après une veille.
//
// ⚠️ Ce tap ne voit aucune frappe : `eventMask` ne porte que `flagsChanged`, et les touches de
// caractère ne parviennent jamais au processus. Une application qui promet que rien ne sort de
// la machine ne peut pas embarquer ce qui ressemblerait à un enregistreur de frappe — ne jamais
// élargir le masque sans que le besoin le commande.
// ⚠️ Le tap est `listenOnly` : il ne modifie ni n'avale rien, ce qui ne veut pas dire « sans
// effet » — il peut décaler la livraison de toute la session selon sa place dans la chaîne.

/// Le destinataire des fronts de la combinaison, appelé depuis le fil du tap.
///
/// Reçoit `0` quand plus aucune combinaison n'est formée, sinon le code de celle qui l'est —
/// voir [`ShortcutCombo`] ; jamais deux fois la même valeur de suite.
///
/// - Warning: ⚠️ Il doit être bref : il s'exécute dans la boucle du tap, et ce qui traîne ici
///   retarde la livraison des évènements à toutes les applications de la session.
public typealias ShortcutObserver = @convention(c) (Int32) -> Void

/// Ce que les modificateurs enfoncés demandent.
///
/// - Warning: ⚠️ Les valeurs brutes sont **du contrat** avec `shortcut/mod.rs` : elles
///   traversent le pont en `Int32`, et une dérive d'un côté ferait dicter dans la mauvaise
///   langue sans que rien ne casse visiblement.
enum ShortcutCombo: Int32 {
  /// ⌃⌥ : le texte s'écrit dans la langue parlée, aux réglages près.
  case spoken = 1
  /// ⌃⌥⌘ : le texte s'écrit dans la langue de traduction.
  case translated = 2
}

/// Le code qui traverse le pont, `0` valant « aucune combinaison ».
func comboCode(_ combo: ShortcutCombo?) -> Int32 {
  combo?.rawValue ?? 0
}

/// Les modificateurs qui comptent pour décider si la combinaison est formée.
///
/// Verrou majuscules, `fn` et pavé numérique en sont volontairement absents : ils accompagnent
/// une frappe sans être un choix de l'utilisateur, et les inclure ferait s'effondrer la dictée
/// au moindre appui parasite.
private let significantFlags: CGEventFlags = [
  .maskControl, .maskAlternate, .maskCommand, .maskShift,
]

/// Les modificateurs de chaque combinaison, et eux seuls.
///
/// - Warning: ⚠️ L'égalité est stricte : accepter « au moins ⌃⌥ » ferait de ⌃⌥⌘⇧ une dictée,
///   et de ⌃⌥⌘ deux combinaisons à la fois. Elle ne peut rien contre ⌃⌥ ou ⌃⌥⌘ suivi d'une
///   lettre — le tap ne voit pas les lettres, prix assumé de ne pas lire le clavier. ⌃⌥⌘ étant
///   le préfixe de beaucoup de raccourcis d'application, c'est la garde de durée, côté Rust,
///   qui absorbe les appuis brefs.
private let comboFlags: [(ShortcutCombo, CGEventFlags)] = [
  (.spoken, [.maskControl, .maskAlternate]),
  (.translated, [.maskControl, .maskAlternate, .maskCommand]),
]

/// La combinaison que forment les modificateurs enfoncés, s'ils en forment une.
///
/// - Parameters:
///   - flags: l'état des modificateurs à juger.
/// - Returns: la combinaison dont les modificateurs sont **exactement** ceux retenus, ou `nil`.
/// - Warning: ⚠️ Interne et non `private` **pour être éprouvable** : c'est ici que vit la règle
///   d'égalité stricte, et elle décide si la dictée démarre et dans quelle langue elle s'écrit.
///   Rien d'autre ne l'appelle hors de ce fichier.
func matchedCombo(in flags: CGEventFlags) -> ShortcutCombo? {
  let significant = flags.intersection(significantFlags)
  return comboFlags.first { $0.1 == significant }?.0
}

/// L'état réel des modificateurs, lu à la source plutôt que déduit.
///
/// - Returns: l'état courant de la session.
/// - Warning: ⚠️ Indispensable au réarmement : les évènements d'un tap désactivé sont perdus,
///   non mis en attente. Sans cette relecture, une coupure survenue pendant que ⌃⌥ était
///   maintenu laisserait l'application persuadée que la touche est toujours enfoncée.
private func currentFlags() -> CGEventFlags {
  CGEventSource.flagsState(.combinedSessionState)
}

/// Le tap du processus. Un seul : il n'y a qu'un raccourci, et qu'un utilisateur.
final class ShortcutTap: @unchecked Sendable {
  private let lock = NSLock()
  private var observer: ShortcutObserver?
  private var tap: CFMachPort?
  private var source: CFRunLoopSource?
  private var loop: CFRunLoop?
  /// La dernière combinaison notifiée. C'est elle qui rend les fronts idempotents.
  private var combo: ShortcutCombo?
  private var listening = false
  /// Un `start()` est en cours et n'a pas encore posé son tap.
  ///
  /// - Warning: ⚠️ Sans lui, l'idempotence de `start()` est un vœu : deux appels concurrents —
  ///   ce que produit un octroi d'autorisation constaté par deux chemins — verraient tous deux
  ///   `listening` faux, et chaque front serait ensuite notifié deux fois.
  private var starting = false
  /// Levé quand le fil du tap a fini son ménage — voir `stop()`.
  private var finished: DispatchSemaphore?

  /// Installe le destinataire des fronts, ou le retire avec `nil`.
  ///
  /// - Parameters:
  ///   - observer: le rappel appelé depuis le fil du tap.
  func setObserver(_ observer: ShortcutObserver?) {
    lock.lock()
    defer { lock.unlock() }
    self.observer = observer
  }

  /// Installe le tap sur son propre fil. Idempotent : rappeler ne crée pas de second tap.
  ///
  /// - Throws: `BridgeError.permission` si l'Accessibilité n'est pas accordée, ou si macOS
  ///   refuse le tap. Dans les deux cas l'application reste utilisable — c'est le raccourci
  ///   qui manque, pas la dictée.
  func start() throws {
    lock.lock()
    let already = listening || starting
    if !already { starting = true }
    lock.unlock()
    if already { return }

    // ⚠️ La seule garde qui vaille : le tap se crée sans l'autorisation Accessibilité, et ne
    // délivre alors aucun évènement, en silence.
    guard AXIsProcessTrusted() else {
      lock.lock()
      starting = false
      lock.unlock()
      throw BridgeError.permission(
        "autorisation Accessibilité non accordée : le raccourci global ne peut pas écouter")
    }

    let failure = ErrorBox()
    let ready = DispatchSemaphore(value: 0)
    let finished = DispatchSemaphore(value: 0)

    let thread = Thread { [self] in
      do {
        try install(finished: finished)
      } catch {
        lock.lock()
        starting = false
        lock.unlock()
        failure.set(error)
        ready.signal()
        finished.signal()
        return
      }
      ready.signal()
      // Rend la main quand `stop()` arrête la boucle, et pas avant.
      CFRunLoopRun()
      uninstall()
      finished.signal()
    }
    thread.name = "com.mirmalion.shortcut"
    thread.start()
    ready.wait()

    if let error = failure.get() {
      throw error
    }
  }

  /// Retire le tap et attend que son fil ait fini. Idempotent.
  ///
  /// - Warning: ⚠️ L'attente n'est pas un luxe : sans elle, un `stop()` suivi d'un `start()` —
  ///   ce que fait un changement d'autorisation — installerait un second tap pendant que le
  ///   premier se démonte, et chaque front serait notifié deux fois.
  func stop() {
    lock.lock()
    let loop = self.loop
    let finished = self.finished
    lock.unlock()

    guard let loop else { return }
    CFRunLoopStop(loop)
    // Le délai n'est là que pour ne jamais bloquer l'arrêt de l'application sur un fil qui
    // ne répondrait plus : la boucle sort en quelques microsecondes.
    _ = finished?.wait(timeout: .now() + 2)
  }

  /// L'état du tap en JSON : `listening`, `trusted`, et le code de la combinaison courante.
  ///
  /// - Returns: l'objet JSON, `trusted` étant relu à chaque appel — l'utilisateur peut décocher
  ///   la case des Réglages Système pendant que l'application tourne.
  /// - Warning: ⚠️ `combo` porte un **code**, pas un booléen : `0` quand aucune combinaison
  ///   n'est formée, sinon celui de [`ShortcutCombo`].
  func status() -> String {
    lock.lock()
    let listening = self.listening
    let combo = self.combo
    lock.unlock()

    let trusted = AXIsProcessTrusted()
    return """
      {"listening":\(listening),"trusted":\(trusted),"combo":\(comboCode(combo))}
      """
  }

  /// Prend en compte un nouvel état des modificateurs, et ne notifie que s'il change.
  ///
  /// - Parameters:
  ///   - flags: l'état lu sur l'évènement, ou relu à la source après un réarmement.
  fileprivate func handle(_ flags: CGEventFlags) {
    let active = matchedCombo(in: flags)

    lock.lock()
    let changed = active != self.combo
    self.combo = active
    let observer = self.observer
    lock.unlock()

    guard changed, let observer else { return }
    observer(comboCode(active))
  }

  /// Réarme un tap que le système a désactivé, puis resynchronise l'état de la combinaison.
  ///
  /// - Warning: ⚠️ La resynchronisation est la moitié utile : réarmer sans relire l'état réel
  ///   des modificateurs laisserait l'application sur sa dernière certitude — et si ⌃⌥ était
  ///   maintenu au moment de la coupure, cette certitude est « on dicte ».
  fileprivate func reenable() {
    lock.lock()
    let tap = self.tap
    lock.unlock()

    guard let tap else { return }
    CGEvent.tapEnable(tap: tap, enable: true)
    handle(currentFlags())
  }

  /// Crée le tap et l'accroche à la boucle du fil courant.
  ///
  /// - Parameters:
  ///   - finished: le sémaphore que le fil du tap lèvera après son ménage.
  /// - Throws: `BridgeError.permission` si macOS refuse le tap ou la source de boucle.
  /// - Warning: ⚠️ Toujours appelé sur le fil du tap : c'est sa boucle d'exécution qui reçoit
  ///   la source.
  private func install(finished: DispatchSemaphore) throws {
    let eventMask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)

    guard
      let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        // ⚠️ En queue de chaîne, et surtout pas en tête. `.headInsertEventTap` fait transiter
        // par notre processus chaque changement de modificateur de la session avant qu'il
        // n'atteigne sa destination : même en `listenOnly`, cela décale la livraison des
        // modificateurs par rapport aux frappes, et une application qui lit l'état des
        // modificateurs au `keyDown` voit un ⌘V dont le ⌘ n'est pas encore arrivé — le collage
        // casse alors dans son hôte, pour elle comme pour d'autres applications, du seul fait
        // que Mirmalion tourne. Nous observons sans rien décider, personne n'attend notre
        // verdict : ne pas remettre `.headInsertEventTap`.
        place: .tailAppendEventTap,
        options: .listenOnly,
        eventsOfInterest: eventMask,
        callback: { _, type, event, _ in
          shortcutTapCallback(type, event)
        },
        userInfo: nil
      )
    else {
      throw BridgeError.permission("macOS a refusé le tap clavier du raccourci global")
    }

    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
      CFMachPortInvalidate(tap)
      throw BridgeError.permission("le tap clavier n'a pas pu rejoindre une boucle d'exécution")
    }

    let loop = CFRunLoopGetCurrent()
    CFRunLoopAddSource(loop, source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)

    lock.lock()
    self.tap = tap
    self.source = source
    self.loop = loop
    self.finished = finished
    self.listening = true
    self.starting = false
    // ⚠️ L'état de départ est lu, jamais supposé : ⌃⌥ peut déjà être enfoncé à l'instant où
    // l'utilisateur vient d'accorder l'autorisation.
    self.combo = matchedCombo(in: currentFlags())
    lock.unlock()
  }

  /// Démonte le tap et remet l'état à zéro.
  ///
  /// - Warning: ⚠️ Toujours appelé sur le fil du tap, au retour de sa boucle : c'est de là que
  ///   la source doit être retirée.
  private func uninstall() {
    lock.lock()
    let tap = self.tap
    let source = self.source
    self.tap = nil
    self.source = nil
    self.loop = nil
    self.listening = false
    self.combo = nil
    lock.unlock()

    if let source {
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
    }
    if let tap {
      CGEvent.tapEnable(tap: tap, enable: false)
      CFMachPortInvalidate(tap)
    }
  }
}

/// Une erreur transmise d'un fil à l'autre, sous verrou.
///
/// - Warning: ⚠️ `Thread` n'a pas de valeur de retour : sans ce passe-plat, un tap refusé se
///   solderait par un démarrage qui se croit réussi.
private final class ErrorBox: @unchecked Sendable {
  private let lock = NSLock()
  private var error: Error?

  func set(_ error: Error) {
    lock.lock()
    defer { lock.unlock() }
    self.error = error
  }

  func get() -> Error? {
    lock.lock()
    defer { lock.unlock() }
    return error
  }
}

/// Le rappel de CoreGraphics, non capturant — c'est ce qui permet de le passer comme pointeur
/// de fonction C.
///
/// - Parameters:
///   - type: le type d'évènement livré par le tap.
///   - event: l'évènement, rendu intact.
/// - Returns: l'évènement inchangé ; la valeur est ignorée, le tap étant `listenOnly`.
/// - Warning: ⚠️ Les deux `tapDisabled` arrivent ici quel que soit le masque : les ignorer,
///   c'est perdre le raccourci à la première mise en veille.
private func shortcutTapCallback(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
  switch type {
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    sharedShortcutTap.reenable()
  case .flagsChanged:
    sharedShortcutTap.handle(event.flags)
  default:
    break
  }
  // Le tap est `listenOnly` : la valeur est ignorée, l'évènement poursuit sa route intact.
  return Unmanaged.passUnretained(event)
}

/// L'unique tap du processus, partagé par les exports du pont.
let sharedShortcutTap = ShortcutTap()

/// Enregistre — ou retire, avec `nil` — le destinataire des fronts de la combinaison.
///
/// - Parameters:
///   - observer: le rappel appelé depuis le fil du tap, bref par obligation.
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`.
@_cdecl("mirmalion_shortcut_set_observer")
public func mirmalionShortcutSetObserver(
  _ observer: ShortcutObserver?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedShortcutTap.setObserver(observer)
    return ""
  }
}

/// Met le tap à l'écoute. Idempotent : rappeler ne crée pas de second tap.
///
/// - Parameters:
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` sans l'Accessibilité comme sur refus de macOS —
///   l'application reste utilisable, c'est le raccourci qui manque.
@_cdecl("mirmalion_shortcut_start")
public func mirmalionShortcutStart(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    try sharedShortcutTap.start()
    return ""
  }
}

/// Retire le tap. Idempotent : arrêter ce qui n'écoute pas n'est pas une erreur.
///
/// - Parameters:
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`.
@_cdecl("mirmalion_shortcut_stop")
public func mirmalionShortcutStop(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedShortcutTap.stop()
    return ""
  }
}

/// L'état du tap, en JSON. N'installe rien et ne demande aucune autorisation.
///
/// - Parameters:
///   - out: reçoit `{"listening":…,"trusted":…,"combo":<code>}`, rendu par
///     `mirmalion_free_string` — `combo` valant `0`, `1` (⌃⌥) ou `2` (⌃⌥⌘).
/// - Returns: `statusOK`.
@_cdecl("mirmalion_shortcut_status")
public func mirmalionShortcutStatus(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedShortcutTap.status()
  }
}
