import AppKit
import WebKit
import Foundation

// Les boutons de fenêtre (« traffic lights »).
//
// En `titleBarStyle: Overlay`, macOS peint fermer et réduire par-dessus le webview, mais dans
// sa bande standard de 28 pt quand notre header en fait 50 — et rien côté CSS ne les recentre,
// ils ne sont pas dans le DOM. On agrandit donc la vue conteneur du titre à la hauteur du
// header, puis on replace chaque bouton dedans.
//
// ⚠️ AppKit ne recentre pas les boutons quand la bande grandit : il leur garde leur distance au
// bas de la bande, si bien que l'agrandir seul les fait descendre d'autant.
// ⚠️ Une correction unique ne tient pas : AppKit refait la mise en page de sa bande à chaque
// redimensionnement et à chaque retour au premier plan, d'où un observateur qui vit avec la
// fenêtre. Un changement d'apparence la refait aussi sans poster aucune notification — d'où le
// rattrapage explicite de `set_window_theme`, qui rappelle l'export après avoir basculé.

/// Maintient les boutons d'une fenêtre centrés sur la bande du header.
///
/// Elle s'abonne aux évènements après lesquels AppKit a refait sa mise en page. La liste est
/// délibérément large : un abonnement de trop coûte un recalcul de trois cadres, un
/// abonnement manquant laisse les pastilles de travers jusqu'au suivant.
@MainActor
private final class TrafficLightCentring {
  private let window: NSWindow
  private let headerHeight: CGFloat
  private let leading: CGFloat

  /// S'abonne aux relayouts d'une fenêtre et applique aussitôt le placement.
  ///
  /// - Parameters:
  ///   - window: la fenêtre suivie.
  ///   - headerHeight: la hauteur du header, en points.
  ///   - leading: la marge gauche voulue pour le premier bouton, en points.
  init(window: NSWindow, headerHeight: CGFloat, leading: CGFloat) {
    self.window = window
    self.headerHeight = headerHeight
    self.leading = leading

    let centre = NotificationCenter.default
    for name: Notification.Name in [
      NSWindow.didResizeNotification,
      NSWindow.didEndLiveResizeNotification,
      NSWindow.didBecomeKeyNotification,
      NSWindow.didDeminiaturizeNotification,
      NSWindow.didChangeScreenNotification,
    ] {
      centre.addObserver(self, selector: #selector(apply), name: name, object: window)
    }

    applyNowAndSoon()
  }

  /// Applique la correction tout de suite, puis une seconde fois au tour de boucle suivant.
  ///
  /// - Warning: ⚠️ Les deux passages sont nécessaires : AppKit finit sa mise en page après
  ///   l'évènement qui l'a provoquée, et un passage unique corrige des cadres qu'il va
  ///   réécrire dans la foulée. Préférer cette méthode à un `apply()` nu sur un rappel.
  func applyNowAndSoon() {
    apply()
    DispatchQueue.main.async { [weak self] in self?.apply() }
  }

  // `deinit` est `nonisolated` : retirer un observateur ne touche pas AppKit, c'est sûr
  // depuis n'importe quel fil. En pratique l'objet vit aussi longtemps que sa fenêtre.
  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  /// Recalcule la bande de titre et y recentre les deux boutons restants.
  @objc func apply() {
    guard let close = window.standardWindowButton(.closeButton),
      let container = close.superview?.superview
    else {
      return
    }

    // AppKit a l'origine en bas à gauche : agrandir la bande veut dire descendre son origine
    // d'autant, ce qui la garde collée au sommet de la fenêtre.
    var frame = container.frame
    let previousTop = frame.origin.y + frame.size.height
    frame.size.height = headerHeight
    frame.origin.y = previousTop - headerHeight
    container.frame = frame

    // ⚠️ Le bouton d'agrandissement est masqué, pas absent : une fenêtre non redimensionnable
    // le désactive — pastille grise inerte — sans le retirer. Le masquer est le seul moyen
    // d'obtenir les deux pastilles que dessine la maquette.
    window.standardWindowButton(.zoomButton)?.isHidden = true

    // ⚠️ Le décalage horizontal se calcule sur le bouton fermer, puis s'applique aux deux :
    // poser une abscisse absolue sur chacun écraserait l'écart qu'AppKit met entre eux, qui
    // n'est pas à nous de choisir. On translate, on ne repositionne pas.
    let shift = leading - close.frame.origin.x

    // L'`origin.y` d'un bouton se mesure depuis le bas de la bande : le centre voulu est donc
    // à `headerHeight / 2` de ce bas, c'est-à-dire au milieu du header.
    for kind: NSWindow.ButtonType in [.closeButton, .miniaturizeButton] {
      guard let button = window.standardWindowButton(kind) else { continue }
      var buttonFrame = button.frame
      buttonFrame.origin.y = headerHeight / 2 - buttonFrame.size.height / 2
      buttonFrame.origin.x += shift
      button.frame = buttonFrame
    }
  }
}

/// Les placements en cours, un par fenêtre.
///
/// L'isolation sur l'acteur principal est la garantie qu'on veut : Swift 6 refuserait sinon
/// l'accès à AppKit depuis cette table, et Rust n'appelle l'export que par `run_on_main_thread`.
///
/// - Warning: ⚠️ La table est la seule référence à l'objet, qui porte l'abonnement aux
///   notifications : relâché, il serait libéré et la correction cesserait au premier
///   redimensionnement. La clé évite aussi un second abonnement si Rust rappelle l'export.
@MainActor private var centrings: [ObjectIdentifier: TrafficLightCentring] = [:]

/// Installe le maintien des boutons au centre d'une bande de `headerHeight` points ; un second
/// appel ne fait que réappliquer.
///
/// - Parameters:
///   - window: le pointeur `NSWindow` obtenu de `WebviewWindow::ns_window()`.
///   - headerHeight: la hauteur du header, en points.
///   - leading: la marge gauche du premier bouton (`--header-pad-x`) ; sinon ~7 pt du bord.
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` sur argument invalide ou boutons introuvables.
@_cdecl("mirmalion_center_window_buttons")
public func mirmalionCenterWindowButtons(
  _ window: UnsafeMutableRawPointer?,
  _ headerHeight: Double,
  _ leading: Double,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let window else {
      throw BridgeError.invalidArgument("mirmalion_center_window_buttons : pointeur nul")
    }
    guard headerHeight > 0 else {
      throw BridgeError.invalidArgument(
        "mirmalion_center_window_buttons : hauteur de header non positive")
    }
    guard leading >= 0 else {
      throw BridgeError.invalidArgument(
        "mirmalion_center_window_buttons : marge gauche négative")
    }

    // ⚠️ Le pointeur vient d'AppKit et la fenêtre est vivante : on l'emprunte sans en prendre
    // la propriété. `takeRetainedValue` la libérerait à notre place et ferait tomber l'app.
    let nsWindow = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()

    // Rust n'appelle cet export que depuis le fil principal (`run_on_main_thread`) : on
    // l'affirme au compilateur plutôt que de repasser par un `async` que la frontière C ne
    // saurait pas attendre.
    //
    // ⚠️ Le contrôle des boutons est DANS le bloc, et n'était pas là avant :
    // `standardWindowButton` est isolé au fil principal, et l'appeler au-dessus touchait AppKit
    // depuis un contexte non isolé. Le compilateur le disait ; personne ne l'entendait.
    try onMainActor("recentrage des boutons de fenêtre") {
      guard nsWindow.standardWindowButton(.closeButton) != nil else {
        throw BridgeError.window("boutons de fenêtre introuvables")
      }
      lockMagnification(nsWindow)
      let key = ObjectIdentifier(nsWindow)
      if let existing = centrings[key] {
        // ⚠️ `applyNowAndSoon`, pas `apply` : c'est par ici qu'arrive le rattrapage d'après
        // changement de thème, et AppKit n'a pas encore refait sa bande quand on nous rappelle
        // — un passage unique corrigerait des cadres condamnés.
        existing.applyNowAndSoon()
      } else {
        centrings[key] = TrafficLightCentring(
          window: nsWindow,
          headerHeight: CGFloat(headerHeight),
          leading: CGFloat(leading))
      }
    }

    return ""
  }
}

/// Pose l'icône que le Dock affiche pour l'application.
///
/// - Parameters:
///   - path: le chemin absolu d'une image lisible par AppKit (`.icns`, `.png`).
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si le chemin est nul ou l'image illisible.
/// - Warning: ⚠️ N'existe que pour le développement : une application packagée tire son icône
///   de son bundle, quand `tauri dev` exécute un binaire nu et retombe sur l'icône générique
///   d'un exécutable. Rust n'appelle cet export qu'en compilation de débogage.
@_cdecl("mirmalion_set_dock_icon")
public func mirmalionSetDockIcon(
  _ path: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let path else {
      throw BridgeError.invalidArgument("mirmalion_set_dock_icon : chemin nul")
    }
    let file = String(cString: path)
    guard let image = NSImage(contentsOfFile: file) else {
      throw BridgeError.invalidArgument("mirmalion_set_dock_icon : image illisible")
    }

    // Rust n'appelle cet export que depuis le fil principal (`run_on_main_thread`).
    try onMainActor("pose de l'icône du Dock") {
      NSApplication.shared.applicationIconImage = image
    }

    return ""
  }
}

/// Redimensionne une fenêtre en l'animant, au lieu du saut instantané.
///
/// - Parameters:
///   - window: le pointeur `NSWindow` que Rust obtient de `WebviewWindow::ns_window()`.
///   - width: la largeur voulue, en points.
///   - height: la hauteur voulue, en points.
///   - duration: la durée de l'animation, en secondes.
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` sur pointeur nul ou valeur invalide.
@_cdecl("mirmalion_resize_window_animated")
public func mirmalionResizeWindowAnimated(
  _ window: UnsafeMutableRawPointer?,
  _ width: Double,
  _ height: Double,
  _ duration: Double,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let window else {
      throw BridgeError.invalidArgument("mirmalion_resize_window_animated : pointeur nul")
    }
    guard width > 0, height > 0 else {
      throw BridgeError.invalidArgument(
        "mirmalion_resize_window_animated : dimensions non positives")
    }
    guard duration >= 0 else {
      throw BridgeError.invalidArgument("mirmalion_resize_window_animated : durée négative")
    }

    let nsWindow = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()

    // Rust n'appelle cet export que depuis le fil principal (`run_on_main_thread`).
    try onMainActor("redimensionnement animé") {
      // ⚠️ `origin` n'est pas touché : le bord gauche reste fixe, et l'origine d'AppKit étant
      // en bas à gauche, une hauteur qui changerait ferait descendre le haut de la fenêtre.
      var frame = nsWindow.frame
      frame.size.width = CGFloat(width)
      frame.size.height = CGFloat(height)

      // ⚠️ `NSAnimationContext` et non `setFrame(display:animate:)`, dont AppKit calcule la
      // durée sur l'amplitude du changement : 450 px de moins donnent une animation bien trop
      // lente pour un repli déclenché d'un clic.
      NSAnimationContext.runAnimationGroup { context in
        // ⚠️ Le seul mouvement de l'application que `prefers-reduced-motion` n'atteint pas : le
        // CSS neutralise ce qui bouge dans le webview, mais celui-ci est le mouvement de la
        // fenêtre, joué par AppKit hors de toute feuille de style.
        // ⚠️ Le réglage se relit à chaque appel, jamais en cache : il se change dans Réglages
        // Système sans quitter l'application.
        // Les fondus de la pilule ne sont pas concernés : un fondu croisé est ce qu'Apple
        // recommande à la place d'un mouvement quand la réduction est demandée.
        let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        context.duration = reduced ? 0 : duration
        // Départ franc, arrivée douce : c'est ce qui fait qu'un mouvement court paraît
        // répondre au clic plutôt que traîner.
        context.timingFunction = CAMediaTimingFunction(name: .easeOut)
        nsWindow.animator().setFrame(frame, display: true)
      }
    }

    return ""
  }
}

// La fenêtre de l'overlay d'enregistrement : une pastille posée sur le bureau, qui doit se voir
// par-dessus tout et n'exister pour aucun clic. Quatre réglages, aucun facultatif :
//
//   1. `level = .statusBar` — au-dessus des fenêtres ordinaires, là où `always_on_top` de Tauri
//      ne monte pas.
//   2. `collectionBehavior` — `.fullScreenAuxiliary` la garde visible quand une application
//      passe en plein écran, `.canJoinAllSpaces` la suit d'un bureau à l'autre, `.stationary`
//      l'empêche de glisser, `.ignoresCycle` la retire de ⌘⇥.
//   3. `ignoresMouseEvents = true` — les clics traversent. Sans quoi elle mangerait un clic
//      destiné à l'application dessous et volerait le focus, ce qui casse le collage.
//   4. fenêtre non opaque, fond effacé, coins arrondis sur le calque de la vue de contenu —
//      la forme de la pilule sans API privée, quand le `transparent` de Tauri repose sur
//      `macos-private-api`, motif de rejet au Mac App Store.

/// Montre la pilule sans activer l'application.
///
/// `orderFrontRegardless()` la place devant sans activer son application.
///
/// - Parameters:
///   - window: le pointeur `NSWindow` obtenu de `WebviewWindow::ns_window()`.
///   - out: reçoit `"presented"`, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` sur pointeur nul.
/// - Warning: ⚠️ Ne pas revenir au `show()` de Tauri, qui descend à `makeKeyAndOrderFront:` et
///   active l'application : le champ visé perdrait le focus au début même de la dictée.
@_cdecl("mirmalion_present_overlay_window")
public func mirmalionPresentOverlayWindow(
  _ window: UnsafeMutableRawPointer?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let window else {
      throw BridgeError.invalidArgument("mirmalion_present_overlay_window : pointeur nul")
    }
    let nsWindow = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()
    // Rust n'appelle cet export que depuis le fil principal (`run_on_main_thread`).
    return try onMainActor("présentation de la pilule") {
      // ⚠️ `orderFrontRegardless()` ne suffit pas à empêcher l'activation : celle-ci vient de la
      // création de la fenêtre par Tauri, pas de sa présentation — une fenêtre de Tauri prend le
      // focus aux autres applications malgré `focused(false)` (tauri-apps/tauri#7519, #14102).
      // C'est pourquoi le collage vise l'application relevée au début de la dictée, et non le
      // premier plan du moment.
      nsWindow.orderFrontRegardless()
      return "presented"
    }
  }
}

/// Configure la fenêtre de l'overlay et la place en haut de l'écran, centrée.
///
/// - Parameters:
///   - window: le pointeur `NSWindow` obtenu de `WebviewWindow::ns_window()`.
///   - topMargin: la distance entre le bas de la barre des menus et le haut de la pilule.
///   - cornerRadius: le rayon des coins, à garder égal au `border-radius` de la pilule.
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` sur pointeur nul.
@_cdecl("mirmalion_configure_overlay_window")
public func mirmalionConfigureOverlayWindow(
  _ window: UnsafeMutableRawPointer?,
  _ topMargin: Double,
  _ cornerRadius: Double,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let window else {
      throw BridgeError.invalidArgument("mirmalion_configure_overlay_window : pointeur nul")
    }
    let nsWindow = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()

    // Rust n'appelle cet export que depuis le fil principal (`run_on_main_thread`).
    try onMainActor("configuration de la pilule") {
      // ⚠️ La pilule devient un panneau non activant : `.nonactivatingPanel` est le seul
      // attribut qui garantisse qu'une fenêtre n'active pas son application, et il n'existe que
      // sur `NSPanel` — d'où le changement de classe à chaud, sûr en disposition mémoire,
      // `NSPanel` n'ajoutant aucun champ d'instance. Sans lui, `focused(false)` de Tauri ne sert
      // à rien (tauri-apps/tauri#7519, #14102) et le champ visé perd le focus dès la dictée.
      // ⚠️ `isReleasedWhenClosed = false` n'est pas décoratif : `NSPanel` se libère à la
      // fermeture, là où `NSWindow` ne le fait pas — sans cette ligne, fermer la fenêtre
      // libérerait un objet que Tao croit encore vivant.
      object_setClass(nsWindow, NSPanel.self)
      nsWindow.styleMask.insert(.nonactivatingPanel)
      nsWindow.isReleasedWhenClosed = false
      if let panel = nsWindow as? NSPanel {
        // Elle n'a aucun champ de saisie : elle n'a jamais besoin du clavier.
        panel.becomesKeyOnlyIfNeeded = true
        // Elle doit survivre au passage à une autre application — c'est même tout son objet.
        panel.hidesOnDeactivate = false
      }

      nsWindow.level = .statusBar
      nsWindow.collectionBehavior = [
        .canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle,
      ]
      nsWindow.ignoresMouseEvents = true
      nsWindow.isMovableByWindowBackground = false

      // La forme de la pilule, en API publique : le fond de la fenêtre s'efface, le calque de
      // la vue de contenu arrondit ses coins, et tout ce qui déborde est rogné — webview
      // comprise.
      nsWindow.isOpaque = false
      nsWindow.backgroundColor = .clear
      if let content = nsWindow.contentView {
        content.wantsLayer = true
        content.layer?.cornerRadius = CGFloat(cornerRadius)
        content.layer?.masksToBounds = true
      }
      // Une pastille d'information n'a rien à faire dans la fenêtre de sélection ⌘⇥ ni dans
      // les captures d'écran d'une autre application.
      nsWindow.isExcludedFromWindowsMenu = true

      // L'ombre de la maquette, déjà le défaut : écrite pour que qui envisagerait un
      // `.shadow(false)` côté Tauri trouve ici la raison de ne pas le faire. Ce qui la rend
      // visible est ailleurs — voir `refreshShadow`, appelé au redimensionnement et pas ici.
      nsWindow.hasShadow = true

      // ⚠️ La fenêtre naît imperceptible : le webview peint son fond blanc dès qu'elle paraît
      // et ne charge la pilule qu'ensuite, d'où une pastille blanche qui clignotait avant le
      // bleu à chaque dictée. `revealOverlay` ne la montre qu'une fois la pilule peinte.
      // ⚠️ Un centième, et surtout pas zéro : à `alphaValue = 0`, macOS tient la fenêtre pour
      // non visible et WebKit suspend son rendu — le webview ne mesure plus rien, ne demande
      // jamais la révélation, et la pilule n'apparaît plus du tout.
      nsWindow.alphaValue = 0.01

      // ⚠️ Le placement se fait ici, pas côté Rust : il dépend de `visibleFrame`, seul à exclure
      // la barre des menus et l'encoche des portables récents.
      placeOverlay(nsWindow, topMargin: CGFloat(topMargin))
    }

    return ""
  }
}

/// La durée des fondus d'entrée et de sortie de la pilule.
///
/// - Warning: ⚠️ Rust attend au moins aussi longtemps avant de fermer la fenêtre — voir
///   `OVERLAY_FADE_MS` dans `commands/window.rs`. Raccourcir l'attente sans raccourcir celle-ci
///   couperait le fondu de sortie en plein milieu.
private let overlayFadeDuration: TimeInterval = 0.18

/// Fait apparaître la pilule en fondu. Sans effet si elle est déjà pleinement opaque.
///
/// - Parameters:
///   - window: la fenêtre de l'overlay.
@MainActor
private func revealOverlay(_ window: NSWindow) {
  guard window.alphaValue < 1 else { return }
  NSAnimationContext.runAnimationGroup { context in
    context.duration = overlayFadeDuration
    window.animator().alphaValue = 1
  }
}

/// Efface la pilule en fondu, puis lui laisse son centième d'opacité.
///
/// La fenêtre n'est pas fermée : la recréer à chaque dictée activait l'application. Elle vit du
/// démarrage à la fin, invisible entre deux dictées.
///
/// - Parameters:
///   - window: le pointeur `NSWindow` obtenu de `WebviewWindow::ns_window()`.
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` sur pointeur nul.
@_cdecl("mirmalion_fade_out_overlay_window")
public func mirmalionFadeOutOverlayWindow(
  _ window: UnsafeMutableRawPointer?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let window else {
      throw BridgeError.invalidArgument("mirmalion_fade_out_overlay_window : pointeur nul")
    }
    let nsWindow = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()

    try onMainActor("fondu de sortie de la pilule") {
      NSAnimationContext.runAnimationGroup { context in
        context.duration = overlayFadeDuration
        // ⚠️ On descend à 0,01 et non à 0 : un centième d'opacité ne se voit pas sur une
        // pastille de deux centimètres, et c'est lui qui garde le rendu du webview vivant pour
        // la dictée suivante. Descendre à 0 l'endormirait pour de bon.
        nsWindow.animator().alphaValue = 0.01
      }
    }

    return ""
  }
}

/// Replace la fenêtre en haut de l'écran, centrée.
///
/// - Parameters:
///   - window: la fenêtre de l'overlay.
///   - topMargin: la distance entre le bas de la barre des menus et le haut de la pilule.
/// - Warning: ⚠️ À rappeler après chaque redimensionnement : AppKit garde l'origine, le coin
///   bas gauche, si bien qu'une pilule qui s'allonge grandit vers la droite et vers le haut au
///   lieu de rester centrée sous la barre des menus.
@MainActor
private func placeOverlay(_ window: NSWindow, topMargin: CGFloat) {
  guard let screen = window.screen ?? NSScreen.main else { return }
  let visible = screen.visibleFrame
  let size = window.frame.size
  window.setFrameOrigin(
    NSPoint(
      x: visible.midX - size.width / 2,
      y: visible.maxY - size.height - topMargin
    ))
}

/// Donne à l'ombre de quoi se dessiner, puis la recalcule.
///
/// Le fond posé sur le calque de la vue de contenu est dessiné par AppKit, épouse le
/// `cornerRadius` et donne l'ombre arrondie ; la pilule le couvre, sa couleur importe peu.
///
/// - Warning: ⚠️ Sans ces deux lignes, il n'y a pas d'ombre du tout : AppKit déduit la forme de
///   l'ombre du backing store, où une `WKWebView` ne dessine rien, son contenu étant composité
///   hors processus.
/// - Warning: ⚠️ Appelé au redimensionnement, jamais à la création : poser le fond avant que le
///   webview n'ait peint afficherait une pilule noire le temps du chargement.
@MainActor
private func refreshShadow(_ window: NSWindow) {
  window.contentView?.layer?.backgroundColor = NSColor.black.cgColor
  window.invalidateShadow()
}

/// Interdit au webview de se laisser zoomer, et remet le zoom à un s'il a déjà bougé.
///
/// L'échec est silencieux : c'est du confort visuel, pas une fonction.
///
/// - Parameters:
///   - window: la fenêtre dont on cherche le webview.
/// - Warning: ⚠️ Sans cela, un pincement à deux doigts — facile à déclencher en faisant défiler
///   une liste — agrandit toute l'interface : le header passait de 51 à 93 points. `⌘+` est un
///   autre chemin vers la même propriété.
@MainActor
private func lockMagnification(_ window: NSWindow) {
  guard let webView = findWebView(in: window) else { return }
  webView.allowsMagnification = false
  webView.magnification = 1
}

/// La `WKWebView` d'une fenêtre, retrouvée dans la hiérarchie des vues — Tauri ne l'expose pas,
/// et elle y est le seul objet de son type.
///
/// - Parameters:
///   - window: la fenêtre à parcourir.
/// - Returns: le webview, ou `nil` si la fenêtre n'a pas encore de vue de contenu.
@MainActor
private func findWebView(in window: NSWindow) -> WKWebView? {
  func walk(_ view: NSView) -> WKWebView? {
    if let webView = view as? WKWebView { return webView }
    for subview in view.subviews {
      if let found = walk(subview) { return found }
    }
    return nil
  }
  guard let content = window.contentView else { return nil }
  return walk(content)
}

/// Réaligne le webview sur sa fenêtre après un changement de taille.
///
/// - Parameters:
///   - window: le pointeur `NSWindow` obtenu de `WebviewWindow::ns_window()`.
///   - out: reçoit une chaîne vide, rendue par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` sur pointeur nul.
/// - Warning: ⚠️ Le webview ne suit pas toujours l'agrandissement de sa fenêtre : sa page garde
///   la mise en page de l'ancienne largeur puis s'étire dessus — header deux fois trop haut,
///   boutons débordant de leur fond. On repose son cadre et son redimensionnement automatique.
@_cdecl("mirmalion_refresh_webview")
public func mirmalionRefreshWebview(
  _ window: UnsafeMutableRawPointer?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let window else {
      throw BridgeError.invalidArgument("mirmalion_refresh_webview : pointeur nul")
    }
    let nsWindow = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()

    try onMainActor("rafraîchissement du webview") {
      // ⚠️ Au tour de boucle suivant, jamais dans la foulée du redimensionnement : AppKit n'a
      // pas encore mis à jour la vue de contenu, et l'on recopierait l'ancienne taille.
      DispatchQueue.main.async {
        guard let webView = findWebView(in: nsWindow), let content = nsWindow.contentView else {
          return
        }
        webView.autoresizingMask = [.width, .height]
        webView.frame = content.bounds
        webView.needsLayout = true
        webView.layoutSubtreeIfNeeded()
        webView.setNeedsDisplay(webView.bounds)
      }
    }

    return ""
  }
}

/// La largeur de l'encoche de l'écran, s'il en a une.
///
/// Les deux zones auxiliaires sont ce qui reste de la barre des menus **de part et d'autre**
/// de l'encoche ; ce qu'elles laissent au milieu est l'encoche elle-même. Elles valent `nil`
/// sur un écran qui n'en a pas — iMac, Mac mini, moniteur externe —, et l'appelant retombe
/// alors sur la largeur qu'il demandait.
@MainActor
private func notchWidth(of screen: NSScreen) -> CGFloat? {
  guard let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea else {
    return nil
  }
  let width = screen.frame.width - left.width - right.width
  return width > 0 ? width : nil
}

/// Retaille la fenêtre de l'overlay et la recentre.
///
/// La pilule s'aligne sur l'encoche de l'écran quand il y en a une, ce qui lui donne l'air d'en
/// descendre ; sur un écran sans encoche, il ne reste que la largeur demandée.
///
/// - Warning: ⚠️ La largeur demandée est un plancher, pas une consigne : le webview envoie la
///   largeur du pire état, mesurée sur les six libellés dans la langue de l'interface, et c'est
///   elle qui garantit qu'aucune traduction ne sera rognée le jour où elle dépasse l'encoche.
@_cdecl("mirmalion_resize_overlay_window")
public func mirmalionResizeOverlayWindow(
  _ window: UnsafeMutableRawPointer?,
  _ width: Double,
  _ height: Double,
  _ topMargin: Double,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let window else {
      throw BridgeError.invalidArgument("mirmalion_resize_overlay_window : pointeur nul")
    }
    let nsWindow = Unmanaged<NSWindow>.fromOpaque(window).takeUnretainedValue()

    try onMainActor("retaille de la pilule") {
      var frame = nsWindow.frame
      let screen = nsWindow.screen ?? NSScreen.main
      let wanted = CGFloat(width)
      let fixed = screen.flatMap(notchWidth(of:)).map { max($0, wanted) } ?? wanted
      frame.size = NSSize(width: fixed, height: CGFloat(height))
      nsWindow.setFrame(frame, display: true)
      placeOverlay(nsWindow, topMargin: CGFloat(topMargin))
      // ⚠️ **Après chaque retaille, sans exception** : l'ombre garde sinon la forme de la
      // pilule précédente, et déborde d'un état à l'autre.
      refreshShadow(nsWindow)
      // La pilule est mesurée, donc peinte : c'est le moment — et le seul — où la montrer
      // ne montre pas le fond blanc du webview.
      revealOverlay(nsWindow)
    }

    return ""
  }
}
